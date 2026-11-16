//! The Android activity loop (see crate docs).


use std::ffi::CString;
use std::io::Read;
use std::time::{Duration, Instant};

use android_activity::{AndroidApp, InputStatus, MainEvent, PollEvent};
use anyhow::{Context, Result};
use pocket_mod::Guest;
use pocket_ui_surface::UiSurface;

use crate::geometry::Geometry;
use crate::link;
use crate::present::Presenter;
use crate::input;

/// Host platform-contract identity. Must match `android.hostAbi` in
/// contracts/spec/platforms.ts or plan-built bundles refuse this host.
const HOST_ID: &str = "android";
const HOST_ABI: u32 = 6;

/// Default logical viewport + raster density of the `android` target profile.
/// A bundle may ship a `viewport` file to pick another registered viewport
/// (512×300 fills a 1024×600 panel exactly at density 2).
const DEFAULT_VIEWPORT: (u32, u32) = (480, 272);
const DENSITY: u32 = 2;

/// The core animates on a fixed 1/60 s step; tick at the same cadence.
const TICK: Duration = Duration::from_nanos(16_666_667);

/// Developer override directory (adb push here; no reinstall needed).
const DEV_DIR: &str = "/data/local/tmp/pocketjs";

#[no_mangle]
fn android_main(app: AndroidApp) {
    android_logger::init_once(
        android_logger::Config::default()
            .with_max_level(log::LevelFilter::Info)
            .with_tag("pocketjs"),
    );
    if let Err(e) = run(app) {
        log::error!("pocketjs host failed: {e:?}");
    }
}

struct Runtime {
    guest: Guest,
    surface: UiSurface,
    viewport: (u32, u32),
}

struct BundleFiles {
    js: Vec<u8>,
    pak: Vec<u8>,
    viewport: (u32, u32),
    origin: String,
}

fn boot(files: &BundleFiles, link: &link::Link) -> Result<Runtime> {
    let js = std::str::from_utf8(&files.js).context("app.js is not UTF-8")?;
    let (w, h) = files.viewport;
    let surface = UiSurface::new_with_density((w as f32, h as f32), DENSITY);
    surface.set_identity(HOST_ID, HOST_ABI);
    surface.feed_pak(&files.pak);

    let guest = Guest::new()?;
    surface.mount(&guest)?;
    link.mount(&guest)?;
    guest.eval("app", js)?;
    anyhow::ensure!(guest.has_frame(), "bundle installed no frame() — is this a PocketJS app?");
    log::info!("booted bundle from {} ({}x{} logical)", files.origin, w, h);
    Ok(Runtime { guest, surface, viewport: files.viewport })
}

fn parse_viewport(bytes: Option<Vec<u8>>) -> (u32, u32) {
    bytes
        .and_then(|b| {
            let s = String::from_utf8(b).ok()?;
            let mut it = s.split_whitespace().map(|n| n.parse::<u32>().ok());
            Some((it.next()??, it.next()??))
        })
        .filter(|&(w, h)| (1..=512).contains(&w) && (1..=512).contains(&h))
        .unwrap_or(DEFAULT_VIEWPORT)
}

fn bundle_dir(app: &AndroidApp) -> Option<std::path::PathBuf> {
    app.internal_data_path().map(|p| p.join("bundle"))
}

fn load_bundle(app: &AndroidApp) -> Result<BundleFiles> {
    let mut dirs: Vec<std::path::PathBuf> = bundle_dir(app).into_iter().collect();
    dirs.push(DEV_DIR.into());
    for dir in dirs {
        if let (Ok(js), Ok(pak)) = (std::fs::read(dir.join("app.js")), std::fs::read(dir.join("app.pak"))) {
            let viewport = parse_viewport(std::fs::read(dir.join("viewport")).ok());
            return Ok(BundleFiles { js, pak, viewport, origin: dir.display().to_string() });
        }
    }
    Ok(BundleFiles {
        js: load_asset(app, "app.js")?,
        pak: load_asset(app, "app.pak")?,
        viewport: parse_viewport(load_asset(app, "viewport").ok()),
        origin: "apk assets".into(),
    })
}

fn make_presenter(win: ndk::native_window::NativeWindow, viewport: (u32, u32), input: &mut input::Input) -> Presenter {
    let geo = Geometry::for_window(
        win.width() as usize,
        win.height() as usize,
        viewport.0 as usize,
        viewport.1 as usize,
        DENSITY,
    );
    log::info!("window {}x{} → {:?}", win.width(), win.height(), geo);
    input.set_geometry(geo);
    Presenter::new(win, geo)
}

/// Persist a bundle pushed over the link so it survives restarts.
fn save_bundle(app: &AndroidApp, b: &link::Bundle) -> Result<BundleFiles> {
    let dir = bundle_dir(app).context("no internal data path")?;
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("app.js"), &b.js)?;
    std::fs::write(dir.join("app.pak"), &b.pak)?;
    let vp = b.viewport.unwrap_or(DEFAULT_VIEWPORT);
    std::fs::write(dir.join("viewport"), format!("{} {}", vp.0, vp.1))?;
    Ok(BundleFiles { js: b.js.clone(), pak: b.pak.clone(), viewport: vp, origin: "link".into() })
}

fn hello(files: &BundleFiles) -> String {
    // Cheap content fingerprint so deskd can skip re-pushing an identical bundle.
    let mut h: u32 = 0x811c9dc5;
    for b in files.js.iter().chain(files.pak.iter()) {
        h = (h ^ *b as u32).wrapping_mul(0x0100_0193);
    }
    format!(r#"{{"t":"hello","host":"{HOST_ID}","abi":{HOST_ABI},"bundle":"{h:08x}","viewport":[{},{}]}}"#,
        files.viewport.0, files.viewport.1)
}

fn run(app: AndroidApp) -> Result<()> {
    let files = load_bundle(&app)?;
    let link = link::Link::start(hello(&files));
    let mut rt = boot(&files, &link)?;
    let mut input = input::Input::default();
    let mut presenter: Option<Presenter> = None;
    let mut next_tick = Instant::now();
    let mut quit = false;
    let mut stats = Stats::default();

    while !quit {
        // Sleep in the looper until the next tick deadline (or an event).
        let timeout = next_tick.saturating_duration_since(Instant::now());
        app.poll_events(Some(timeout), |event| match event {
            PollEvent::Main(MainEvent::InitWindow { .. }) => {
                if let Some(win) = app.native_window() {
                    presenter = Some(make_presenter(win, rt.viewport, &mut input));
                }
            }
            PollEvent::Main(MainEvent::TerminateWindow { .. }) => presenter = None,
            // Our buffer contents are lost with the surface; repaint fully.
            PollEvent::Main(MainEvent::WindowResized { .. })
            | PollEvent::Main(MainEvent::RedrawNeeded { .. })
            | PollEvent::Main(MainEvent::GainedFocus) => {
                if let Some(p) = presenter.as_mut() {
                    p.invalidate();
                }
            }
            PollEvent::Main(MainEvent::Destroy) => quit = true,
            _ => {}
        });

        // Drain input every iteration so touch latency is ≤ one tick.
        if let Ok(mut iter) = app.input_events_iter() {
            while iter.next(|ev| {
                if input.on_event(ev) {
                    InputStatus::Handled
                } else {
                    InputStatus::Unhandled
                }
            }) {}
        }

        let now = Instant::now();
        if now < next_tick {
            continue;
        }
        // Fixed-step: never run more than a couple of catch-up steps.
        next_tick = if now - next_tick > TICK * 3 { now + TICK } else { next_tick + TICK };

        // Hot reload: a bundle pushed by deskd replaces the runtime in place.
        if let Some(b) = link.take_bundle() {
            match save_bundle(&app, &b).and_then(|f| {
                let new_rt = boot(&f, &link)?;
                link.set_hello(hello(&f));
                Ok(new_rt)
            }) {
                Ok(new_rt) => {
                    rt = new_rt;
                    if let Some(win) = app.native_window() {
                        presenter = Some(make_presenter(win, rt.viewport, &mut input));
                    }
                    link.send(r#"{"t":"reloaded","ok":true}"#);
                }
                Err(e) => {
                    log::error!("bundle reload failed, keeping the old one: {e:?}");
                    link.send(&format!(
                        r#"{{"t":"reloaded","ok":false,"error":{}}}"#,
                        serde_json::to_string(&format!("{e:#}")).unwrap_or_default()
                    ));
                }
            }
        }

        let t0 = Instant::now();
        let (buttons, analog, touches) = input.snapshot();
        if let Err(e) = rt.guest.frame_with_touches(buttons, analog, &touches) {
            // A throwing app must not kill the host (deskd can push a fix).
            log::error!("frame() threw: {e:#}");
            link.send(&format!(
                r#"{{"t":"error","error":{}}}"#,
                serde_json::to_string(&format!("{e:#}")).unwrap_or_default()
            ));
        }
        let t1 = Instant::now();
        rt.surface.tick();
        let t2 = Instant::now();
        if let Some(p) = presenter.as_mut() {
            rt.surface.with_ui(|ui| {
                let words = ui.draw().words.clone();
                p.render(ui, &words)
            })?;
        }
        let t3 = Instant::now();
        stats.record([t1 - t0, t2 - t1, t3 - t2]);
    }
    Ok(())
}

/// Read a file from the APK assets.
fn load_asset(app: &AndroidApp, name: &str) -> Result<Vec<u8>> {
    let cname = CString::new(name)?;
    let mut asset = app
        .asset_manager()
        .open(&cname)
        .with_context(|| format!("asset {name} missing from APK"))?;
    let mut buf = Vec::new();
    asset.read_to_end(&mut buf)?;
    Ok(buf)
}

/// Logs mean / worst tick cost every ~5 s, split into phases (js = guest
/// frame, core = surface tick/layout/anim, draw = raster + present), so jank
/// is attributable from logcat. Frames over budget are counted.
#[derive(Default)]
struct Stats {
    n: u32,
    total: Duration,
    worst: Duration,
    worst_phase: [Duration; 3],
    over: u32,
}

impl Stats {
    fn record(&mut self, phases: [Duration; 3]) {
        let d: Duration = phases.iter().sum();
        self.n += 1;
        self.total += d;
        if d > TICK {
            self.over += 1;
        }
        if d > self.worst {
            self.worst = d;
            self.worst_phase = phases;
        }
        if self.n == 300 {
            let ms = |d: Duration| d.as_secs_f64() * 1000.0;
            log::info!(
                "tick cost: mean {:.2} ms, worst {:.2} ms (js {:.2} / core {:.2} / draw {:.2}), over-budget {}/300",
                ms(self.total) / self.n as f64,
                ms(self.worst),
                ms(self.worst_phase[0]),
                ms(self.worst_phase[1]),
                ms(self.worst_phase[2]),
                self.over
            );
            *self = Stats::default();
        }
    }
}
