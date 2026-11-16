//! `link` — a line-delimited JSON socket to the desk daemon (deskd) on the Mac.
//!
//! Transport: TCP to 127.0.0.1:7777. Over USB that port is tunnelled to the
//! Mac with `adb reverse tcp:7777 tcp:7777` (deskd keeps it applied); no WiFi
//! needed. A background thread connects/reconnects every second and splits the
//! stream into messages; the render thread drains them once per tick.
//!
//! Wire format (one JSON object per line):
//!   Mac → tablet
//!     {"t":"state","k":"<key>","v":<any>}            → delivered to JS (poll)
//!     {"t":"blob","k":"<key>","w":W,"h":H,"b64":"…"} → RGBA8 pixels, decoded
//!                                                      here; JS gets bytes via blob(k)
//!     {"t":"bundle","js":"<b64>","pak":"<b64>"}       → handled by the host:
//!                                                      saved + hot-reloaded
//!     anything else                                   → delivered to JS (poll)
//!   tablet → Mac
//!     {"t":"hello", …} on every connect (sent by the host), then whatever JS
//!     sends via link.send(str).

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use pocket_mod::qjs::{Ctx, Function, Object, TypedArray};
use pocket_mod::Guest;

pub const ADDR: &str = "127.0.0.1:7777";

/// deskd address: `POCKETJS_LINK` (host:port) overrides the default
/// [`ADDR`] (e.g. to reach deskd directly over Wi-Fi instead of a tunnel).
fn addr() -> std::net::SocketAddr {
    std::env::var("POCKETJS_LINK")
        .ok()
        .and_then(|a| a.parse().ok())
        .unwrap_or_else(|| ADDR.parse().unwrap())
}

/// RGBA8 image pushed by the daemon.
pub struct Blob {
    pub w: u32,
    pub h: u32,
    pub rgba: Vec<u8>,
    /// Bumped on every replace so JS can tell a new image arrived.
    pub gen: u32,
}

pub struct Bundle {
    pub js: Vec<u8>,
    pub pak: Vec<u8>,
    /// Optional logical viewport `[w, h]` for this bundle.
    pub viewport: Option<(u32, u32)>,
}

#[derive(Default)]
struct Shared {
    inbox: VecDeque<String>,
    blobs: HashMap<String, Blob>,
    bundle: Option<Bundle>,
    out: Option<TcpStream>,
    connected: bool,
    /// Sent first on every (re)connect.
    hello: String,
}

#[derive(Clone)]
pub struct Link(Arc<Mutex<Shared>>);

impl Link {
    /// Start the connector thread. `hello` is sent on every connect.
    pub fn start(hello: String) -> Link {
        let link = Link(Arc::new(Mutex::new(Shared { hello, ..Default::default() })));
        let bg = link.clone();
        std::thread::Builder::new()
            .name("pocketjs-link".into())
            .spawn(move || bg.run())
            .expect("spawn link thread");
        link
    }

    pub fn set_hello(&self, hello: String) {
        self.0.lock().unwrap().hello = hello;
    }

    fn run(&self) {
        let addr = addr();
        loop {
            match TcpStream::connect_timeout(&addr, Duration::from_secs(1)) {
                Ok(stream) => {
                    let _ = stream.set_nodelay(true);
                    log::info!("link: connected to {addr}");
                    if let Ok(mut w) = stream.try_clone() {
                        let hello = {
                            let mut s = self.0.lock().unwrap();
                            s.out = stream.try_clone().ok();
                            s.connected = true;
                            s.hello.clone()
                        };
                        let _ = w.write_all(hello.as_bytes());
                        let _ = w.write_all(b"\n");
                    }
                    self.read_loop(stream);
                    let mut s = self.0.lock().unwrap();
                    s.out = None;
                    s.connected = false;
                    s.inbox.push_back(r#"{"t":"link","connected":false}"#.into());
                    drop(s);
                    log::info!("link: disconnected");
                    // adb reverse accepts then drops when deskd isn't listening:
                    // back off so that doesn't become a busy loop.
                    std::thread::sleep(Duration::from_secs(1));
                }
                Err(_) => std::thread::sleep(Duration::from_secs(1)),
            }
        }
    }

    fn read_loop(&self, stream: TcpStream) {
        let mut reader = BufReader::with_capacity(1 << 16, stream);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => return,
                Ok(_) => self.dispatch(line.trim_end()),
            }
        }
    }

    fn dispatch(&self, line: &str) {
        if line.is_empty() {
            return;
        }
        // Cheap prefix sniff first so state lines (the hot path) skip a parse.
        let kind = if line.contains(r#""t":"blob""#) {
            "blob"
        } else if line.contains(r#""t":"bundle""#) {
            "bundle"
        } else {
            "other"
        };
        match kind {
            "blob" => match parse_blob(line) {
                Some((k, w, h, rgba)) => {
                    let mut s = self.0.lock().unwrap();
                    let gen = s.blobs.get(&k).map_or(1, |b| b.gen + 1);
                    s.blobs.insert(k.clone(), Blob { w, h, rgba, gen });
                    s.inbox.push_back(format!(r#"{{"t":"blob","k":{},"gen":{gen}}}"#, json_str(&k)));
                }
                None => log::warn!("link: malformed blob"),
            },
            "bundle" => match parse_bundle(line) {
                Some(b) => {
                    log::info!("link: bundle received (js {} B, pak {} B)", b.js.len(), b.pak.len());
                    self.0.lock().unwrap().bundle = Some(b);
                }
                None => log::warn!("link: malformed bundle"),
            },
            _ => self.0.lock().unwrap().inbox.push_back(line.to_owned()),
        }
    }

    pub fn take_bundle(&self) -> Option<Bundle> {
        self.0.lock().unwrap().bundle.take()
    }

    pub fn send(&self, msg: &str) -> bool {
        let mut s = self.0.lock().unwrap();
        let ok = match s.out.as_mut() {
            Some(w) => w.write_all(msg.as_bytes()).and_then(|_| w.write_all(b"\n")).is_ok(),
            None => false,
        };
        if !ok {
            s.out = None;
        }
        ok
    }

    /// Mount the `link` global into the guest:
    ///   link.poll()       → string[] of pending JSON lines (drained)
    ///   link.send(str)    → bool (false when not connected)
    ///   link.connected()  → bool
    ///   link.blob(key)    → { w, h, gen, data: Uint8Array } | undefined
    pub fn mount(&self, guest: &Guest) -> anyhow::Result<()> {
        let me = self.clone();
        guest.mount("link", move |ctx: &Ctx, ns: &Object| {
            let l = me.clone();
            ns.set(
                "poll",
                Function::new(ctx.clone(), move || -> Vec<String> {
                    l.0.lock().unwrap().inbox.drain(..).collect()
                })?,
            )?;
            let l = me.clone();
            ns.set("send", Function::new(ctx.clone(), move |msg: String| l.send(&msg))?)?;
            let l = me.clone();
            ns.set(
                "connected",
                Function::new(ctx.clone(), move || l.0.lock().unwrap().connected)?,
            )?;
            CURRENT.with(|c| *c.borrow_mut() = Some(me.clone()));
            ns.set("blob", Function::new(ctx.clone(), js_blob)?)?;
            Ok(())
        })
    }
}

thread_local! {
    /// The link the guest on this (render) thread is mounted to; lets `blob`
    /// be a plain fn so its returned object can borrow the JS context.
    static CURRENT: std::cell::RefCell<Option<Link>> = const { std::cell::RefCell::new(None) };
}

fn js_blob<'js>(ctx: Ctx<'js>, key: String) -> pocket_mod::qjs::Result<Option<Object<'js>>> {
    let Some(link) = CURRENT.with(|c| c.borrow().clone()) else { return Ok(None) };
    let s = link.0.lock().unwrap();
    let Some(b) = s.blobs.get(&key) else { return Ok(None) };
    let o = Object::new(ctx.clone())?;
    o.set("w", b.w)?;
    o.set("h", b.h)?;
    o.set("gen", b.gen)?;
    o.set("data", TypedArray::<u8>::new(ctx, b.rgba.clone())?)?;
    Ok(Some(o))
}

fn json_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

fn b64(s: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::STANDARD.decode(s).ok()
}

fn parse_blob(line: &str) -> Option<(String, u32, u32, Vec<u8>)> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let k = v.get("k")?.as_str()?.to_owned();
    let w = v.get("w")?.as_u64()? as u32;
    let h = v.get("h")?.as_u64()? as u32;
    let rgba = b64(v.get("b64")?.as_str()?)?;
    (rgba.len() == (w * h * 4) as usize).then_some((k, w, h, rgba))
}

fn parse_bundle(line: &str) -> Option<Bundle> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let viewport = v.get("viewport").and_then(|a| {
        Some((a.get(0)?.as_u64()? as u32, a.get(1)?.as_u64()? as u32))
    });
    Some(Bundle { js: b64(v.get("js")?.as_str()?)?, pak: b64(v.get("pak")?.as_str()?)?, viewport })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_roundtrip() {
        let px = base64::engine::general_purpose::STANDARD.encode([1u8, 2, 3, 4]);
        let line = format!(r#"{{"t":"blob","k":"a","w":1,"h":1,"b64":"{px}"}}"#);
        let (k, w, h, rgba) = parse_blob(&line).unwrap();
        assert_eq!((k.as_str(), w, h, rgba), ("a", 1, 1, vec![1, 2, 3, 4]));
    }

    #[test]
    fn blob_size_mismatch_rejected() {
        let px = base64::engine::general_purpose::STANDARD.encode([1u8, 2, 3]);
        let line = format!(r#"{{"t":"blob","k":"a","w":1,"h":1,"b64":"{px}"}}"#);
        assert!(parse_blob(&line).is_none());
    }

    #[test]
    fn bundle_parse() {
        let e = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
        let line = format!(r#"{{"t":"bundle","js":"{}","pak":"{}"}}"#, e(b"js"), e(b"pak"));
        let b = parse_bundle(&line).unwrap();
        assert_eq!((b.js.as_slice(), b.pak.as_slice()), (&b"js"[..], &b"pak"[..]));
    }
}
