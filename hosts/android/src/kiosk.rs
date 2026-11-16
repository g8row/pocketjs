//! pocketjs-kiosk — the PocketJS runtime with NO Android framework.
//!
//! Run as root after stopping zygote/surfaceflinger (see kiosk/kiosk.sh). It
//! keeps Lenovo's kernel + drivers and talks to them directly:
//!   display  /dev/graphics/fb0 (mtkfb, 600×1024 portrait, BGRA, 3 buffers;
//!            the landscape UI is rotated 90° in the blit; FBIOPAN_DISPLAY flips)
//!   touch    the `mtk-tpd` evdev node (multitouch protocol A or B)
//!   keys     the `mtk-kpd` evdev node (volume keys → shoulder buttons)
//!   link     same TCP link to deskd (adbd is native, so adb reverse still works)
//!
//! Same incremental raster as the activity host: an idle frame touches no
//! pixels and issues no pan.

use std::fs::{File, OpenOptions};
use std::io::Read;
use std::os::fd::AsRawFd;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use pocket_mod::Guest;
use pocket_ui_surface::UiSurface;
use pocketjs::link::Link;
use pocketjs_core::damage::{DamagePlan, DamagePolicy, DamageRect, DamageTracker};
use pocketjs_core::spec::{btn, ANALOG_CENTER};
use pocketjs_core::{raster, Ui};

const HOST_ID: &str = "android";
const HOST_ABI: u32 = 6;
const DENSITY: u32 = 2;
const TICK: Duration = Duration::from_nanos(16_666_667);

// ---- linux fbdev / evdev FFI ------------------------------------------------------

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct FbBitfield {
    offset: u32,
    length: u32,
    msb_right: u32,
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct FbVar {
    xres: u32,
    yres: u32,
    xres_virtual: u32,
    yres_virtual: u32,
    xoffset: u32,
    yoffset: u32,
    bits_per_pixel: u32,
    grayscale: u32,
    red: FbBitfield,
    green: FbBitfield,
    blue: FbBitfield,
    transp: FbBitfield,
    nonstd: u32,
    activate: u32,
    height: u32,
    width: u32,
    accel_flags: u32,
    pixclock: u32,
    left_margin: u32,
    right_margin: u32,
    upper_margin: u32,
    lower_margin: u32,
    hsync_len: u32,
    vsync_len: u32,
    sync: u32,
    vmode: u32,
    rotate: u32,
    colorspace: u32,
    reserved: [u32; 4],
}

#[repr(C)]
struct FbFix {
    id: [u8; 16],
    smem_start: libc::c_ulong,
    smem_len: u32,
    type_: u32,
    type_aux: u32,
    visual: u32,
    xpanstep: u16,
    ypanstep: u16,
    ywrapstep: u16,
    line_length: u32,
    mmio_start: libc::c_ulong,
    mmio_len: u32,
    accel: u32,
    capabilities: u16,
    reserved: [u16; 2],
}

const FBIOGET_VSCREENINFO: libc::c_ulong = 0x4600;
const FBIOGET_FSCREENINFO: libc::c_ulong = 0x4602;
const FBIOPAN_DISPLAY: libc::c_ulong = 0x4606;

#[repr(C)]
#[derive(Default)]
struct AbsInfo {
    value: i32,
    minimum: i32,
    maximum: i32,
    fuzz: i32,
    flat: i32,
    resolution: i32,
}

const fn ioc(dir: u64, ty: u64, nr: u64, size: u64) -> libc::c_ulong {
    ((dir << 30) | (size << 16) | (ty << 8) | nr) as libc::c_ulong
}
const fn eviocgabs(abs: u64) -> libc::c_ulong {
    ioc(2, b'E' as u64, 0x40 + abs, 24)
}
const EVIOCGRAB: libc::c_ulong = ioc(1, b'E' as u64, 0x90, 4);

const EV_SYN: u16 = 0;
const EV_KEY: u16 = 1;
const EV_ABS: u16 = 3;
const SYN_REPORT: u16 = 0;
const SYN_MT_REPORT: u16 = 2;
const ABS_X: u16 = 0x00;
const ABS_Y: u16 = 0x01;
const ABS_MT_SLOT: u16 = 0x2f;
const ABS_MT_POSITION_X: u16 = 0x35;
const ABS_MT_POSITION_Y: u16 = 0x36;
const ABS_MT_TRACKING_ID: u16 = 0x39;
const BTN_TOUCH: u16 = 0x14a;
const KEY_VOLUMEDOWN: u16 = 114;
const KEY_VOLUMEUP: u16 = 115;
const KEY_POWER: u16 = 116;

// ---- framebuffer --------------------------------------------------------------------

struct Fb {
    _file: File,
    fd: i32,
    mem: *mut u8,
    len: usize,
    var: FbVar,
    stride: usize, // bytes per row
    nbuf: usize,
    front: usize,
    /// Damage (render-space rects) of recent frames, newest last — a back
    /// buffer last written k frames ago needs the union of the last k rects.
    history: Vec<Option<Rect>>,
    /// Frames since each buffer was last written (None = never/full).
    age: Vec<Option<usize>>,
    /// Slowest FBIOPAN_DISPLAY since the last stats line.
    pan_worst: Duration,
    flip: bool,
    panned: bool,
}

#[derive(Clone, Copy, Debug)]
struct Rect {
    x0: usize,
    y0: usize,
    x1: usize,
    y1: usize,
}

impl Rect {
    fn union(self, o: Rect) -> Rect {
        Rect { x0: self.x0.min(o.x0), y0: self.y0.min(o.y0), x1: self.x1.max(o.x1), y1: self.y1.max(o.y1) }
    }
}

impl Fb {
    fn open() -> Result<Fb> {
        let file = OpenOptions::new().read(true).write(true).open("/dev/graphics/fb0").context("open fb0")?;
        let fd = file.as_raw_fd();
        let mut var = FbVar::default();
        let mut fix: FbFix = unsafe { std::mem::zeroed() };
        unsafe {
            if libc::ioctl(fd, FBIOGET_VSCREENINFO as _, &mut var) != 0 {
                bail!("FBIOGET_VSCREENINFO failed");
            }
            if libc::ioctl(fd, FBIOGET_FSCREENINFO as _, &mut fix) != 0 {
                bail!("FBIOGET_FSCREENINFO failed");
            }
        }
        anyhow::ensure!(var.bits_per_pixel == 32, "expected 32 bpp, got {}", var.bits_per_pixel);
        let len = fix.smem_len as usize;
        let mem = unsafe {
            libc::mmap(std::ptr::null_mut(), len, libc::PROT_READ | libc::PROT_WRITE, libc::MAP_SHARED, fd, 0)
        };
        anyhow::ensure!(mem != libc::MAP_FAILED, "mmap fb0 failed");
        let stride = fix.line_length as usize;
        let nbuf = ((var.yres_virtual / var.yres.max(1)) as usize).clamp(1, 3);
        log::info!(
            "fb0: {}x{} virt {}x{} stride {} bufs {} rgb offsets r{} g{} b{}",
            var.xres, var.yres, var.xres_virtual, var.yres_virtual, stride, nbuf, var.red.offset, var.green.offset, var.blue.offset
        );
        let front = (var.yoffset / var.yres.max(1)) as usize % nbuf;
        Ok(Fb { _file: file, fd, mem: mem as *mut u8, len, var, stride, nbuf, front, history: Vec::new(), age: vec![None; nbuf], pan_worst: Duration::ZERO, flip: std::env::var("POCKETJS_KIOSK_FLIP").is_ok(), panned: false })
    }

    /// Write `dirty` (landscape render coords) from `rgba` (render_w × render_h,
    /// RGBA8) into the back buffer — rotated 90° clockwise into the portrait
    /// panel — then pan to it.
    fn present(&mut self, rgba: &[u8], render_w: usize, render_h: usize, dirty: Option<Rect>) {
        // Single-buffer mode (default): write only the damage into the visible
        // buffer (the fb mapping is uncached, ~20 MB/s, so bytes matter), then
        // FBIOPAN_DISPLAY to the SAME offset — mtkfb only re-reads memory into
        // the display engine on a pan (verified on device: without it the panel
        // keeps the first frame). POCKETJS_KIOSK_FLIP=1 = triple-buffered flips.
        let back = if self.flip { (self.front + 1) % self.nbuf } else { self.front };
        // What this back buffer is missing: everything newer than its contents.
        let age = if self.flip { self.age[back] } else if self.panned { Some(1) } else { None };
        let need = match (dirty, age) {
            (_, None) | (None, _) => Some(Rect { x0: 0, y0: 0, x1: render_w, y1: render_h }),
            (Some(d), Some(age)) => {
                let mut r = d;
                for h in self.history.iter().rev().take(age.saturating_sub(1)) {
                    match h {
                        Some(h) => r = r.union(*h),
                        None => {
                            r = Rect { x0: 0, y0: 0, x1: render_w, y1: render_h };
                            break;
                        }
                    }
                }
                Some(r)
            }
        };
        let r = need.unwrap();
        let (pw, ph) = (self.var.xres as usize, self.var.yres as usize);
        let base = back * ph * self.stride;
        // mtkfb advertises RGBA offsets, but the display engine scans BGRA
        // (verified against an Android-composited capture) — so write BGRA.
        let (bo, go, ro) = (0u32, 1u32, 2u32);
        // Landscape (lx, ly) → portrait panel (px = pw-1-ly, py = lx).
        // fb0 is write-combined memory: build each panel row in a scratch
        // buffer (strided reads from RAM are cheap) and copy it out with one
        // contiguous memcpy (scattered writes to WC memory are not).
        let ly0 = r.y0.min(render_h).min(pw);
        let ly1 = r.y1.min(render_h).min(pw);
        let lx1 = r.x1.min(render_w).min(ph);
        if ly1 > ly0 {
            let px0 = pw - ly1; // leftmost panel column touched
            let span = ly1 - ly0;
            let mut row = vec![0u8; span * 4];
            for lx in r.x0..lx1 {
                for (i, ly) in (ly0..ly1).rev().enumerate() {
                    let s = (ly * render_w + lx) * 4;
                    let d = i * 4;
                    row[d + bo as usize] = rgba[s + 2];
                    row[d + go as usize] = rgba[s + 1];
                    row[d + ro as usize] = rgba[s];
                    row[d + 3] = 255;
                }
                let d = base + lx * self.stride + px0 * 4;
                // SAFETY: lx < ph rows and px0 + span <= pw columns, inside buffer `back`.
                unsafe {
                    std::ptr::copy_nonoverlapping(row.as_ptr(), self.mem.add(d), row.len());
                }
            }
        }
        let mut var = self.var;
        var.yoffset = (back * ph) as u32;
        var.xoffset = 0;
        {
            let tp = Instant::now();
            unsafe {
                libc::ioctl(self.fd, FBIOPAN_DISPLAY as _, &mut var);
            }
            self.pan_worst = self.pan_worst.max(tp.elapsed());
            self.panned = true;
        }
        self.front = back;
        // Book-keeping: every buffer ages by one frame; `back` is fresh.
        for (i, a) in self.age.iter_mut().enumerate() {
            *a = if i == back { Some(1) } else { a.map(|n| n + 1) };
        }
        self.history.push(dirty);
        if self.history.len() > 8 {
            self.history.remove(0);
        }
    }
}

impl Drop for Fb {
    fn drop(&mut self) {
        unsafe {
            libc::munmap(self.mem as *mut _, self.len);
        }
    }
}

// ---- input --------------------------------------------------------------------------

fn find_event(name: &str) -> Option<String> {
    let devices = std::fs::read_to_string("/proc/bus/input/devices").ok()?;
    let mut cur_name = false;
    for line in devices.lines() {
        if let Some(n) = line.strip_prefix("N: Name=") {
            cur_name = n.trim_matches('"') == name;
        } else if cur_name && line.starts_with("H: Handlers=") {
            let ev = line.split_whitespace().find(|t| t.starts_with("event"))?;
            return Some(format!("/dev/input/{ev}"));
        }
    }
    None
}

fn open_input(path: &str) -> Result<File> {
    let f = File::open(path).with_context(|| format!("open {path}"))?;
    unsafe {
        let fl = libc::fcntl(f.as_raw_fd(), libc::F_GETFL);
        libc::fcntl(f.as_raw_fd(), libc::F_SETFL, fl | libc::O_NONBLOCK);
        // No EVIOCGRAB: with the framework stopped nobody else reads these
        // nodes, and staying ungrabbed lets `sendevent` inject test input.
        if std::env::var("POCKETJS_KIOSK_GRAB").is_ok() {
            libc::ioctl(f.as_raw_fd(), EVIOCGRAB as _, 1 as libc::c_int);
        }
    }
    Ok(f)
}

fn abs_range(f: &File, code: u16) -> (i32, i32) {
    let mut info = AbsInfo::default();
    unsafe {
        libc::ioctl(f.as_raw_fd(), eviocgabs(code as u64) as _, &mut info);
    }
    (info.minimum, info.maximum.max(info.minimum + 1))
}

fn read_events(f: &mut File, out: &mut Vec<(u16, u16, i32)>) {
    let mut buf = [0u8; 24 * 64];
    loop {
        match f.read(&mut buf) {
            Ok(n) if n >= 24 => {
                for ev in buf[..n].chunks_exact(24) {
                    let ty = u16::from_ne_bytes([ev[16], ev[17]]);
                    let code = u16::from_ne_bytes([ev[18], ev[19]]);
                    let value = i32::from_ne_bytes([ev[20], ev[21], ev[22], ev[23]]);
                    out.push((ty, code, value));
                }
            }
            _ => return,
        }
    }
}

/// Multitouch state machine for protocol A and B; contacts in panel coords.
struct Touch {
    file: File,
    xr: (i32, i32),
    yr: (i32, i32),
    slot: usize,
    slots: [(i32, i32, i32); 10], // (tracking id or -1, x, y)
    a_frame: Vec<(i32, i32)>,     // protocol A: contacts of the frame being built
    a_contacts: Vec<(i32, i32)>,
    single: Option<(i32, i32)>,   // ABS_X/Y fallback
    btn: bool,
    proto_a: bool,
}

impl Touch {
    fn open() -> Result<Touch> {
        let path = find_event("mtk-tpd").context("no mtk-tpd touch device")?;
        let file = open_input(&path)?;
        let mut xr = abs_range(&file, ABS_MT_POSITION_X);
        let mut yr = abs_range(&file, ABS_MT_POSITION_Y);
        if xr.1 <= 1 {
            xr = abs_range(&file, ABS_X);
            yr = abs_range(&file, ABS_Y);
        }
        log::info!("touch {path}: x {:?} y {:?}", xr, yr);
        Ok(Touch {
            file,
            xr,
            yr,
            slot: 0,
            slots: [(-1, 0, 0); 10],
            a_frame: Vec::new(),
            a_contacts: Vec::new(),
            single: None,
            btn: false,
            proto_a: false,
        })
    }

    fn pump(&mut self) {
        let mut evs = Vec::new();
        read_events(&mut self.file, &mut evs);
        let mut ax = None;
        let mut ay = None;
        for (ty, code, v) in evs {
            match (ty, code) {
                (EV_ABS, ABS_MT_SLOT) => self.slot = (v as usize).min(9),
                (EV_ABS, ABS_MT_TRACKING_ID) => self.slots[self.slot].0 = v,
                (EV_ABS, ABS_MT_POSITION_X) => {
                    self.slots[self.slot].1 = v;
                    ax = Some(v);
                }
                (EV_ABS, ABS_MT_POSITION_Y) => {
                    self.slots[self.slot].2 = v;
                    ay = Some(v);
                }
                (EV_ABS, ABS_X) => self.single = Some((v, self.single.map_or(0, |s| s.1))),
                (EV_ABS, ABS_Y) => self.single = Some((self.single.map_or(0, |s| s.0), v)),
                (EV_KEY, BTN_TOUCH) => self.btn = v != 0,
                (EV_SYN, SYN_MT_REPORT) => {
                    self.proto_a = true;
                    if let (Some(x), Some(y)) = (ax.take(), ay.take()) {
                        self.a_frame.push((x, y));
                    }
                }
                (EV_SYN, SYN_REPORT) => {
                    if self.proto_a {
                        self.a_contacts = std::mem::take(&mut self.a_frame);
                    }
                }
                _ => {}
            }
        }
    }

    /// Contacts as (id, panel x, panel y) normalized to 0..1.
    fn contacts(&self) -> Vec<(u32, f32, f32)> {
        let nx = |x: i32| (x - self.xr.0) as f32 / (self.xr.1 - self.xr.0) as f32;
        let ny = |y: i32| (y - self.yr.0) as f32 / (self.yr.1 - self.yr.0) as f32;
        if self.proto_a {
            return if self.btn || !self.a_contacts.is_empty() {
                self.a_contacts.iter().enumerate().map(|(i, &(x, y))| (i as u32, nx(x), ny(y))).collect()
            } else {
                Vec::new()
            };
        }
        let mt: Vec<_> = self
            .slots
            .iter()
            .filter(|s| s.0 >= 0)
            .map(|&(id, x, y)| (id as u32 & 0xff, nx(x), ny(y)))
            .collect();
        if !mt.is_empty() {
            return mt;
        }
        match (self.btn, self.single) {
            (true, Some((x, y))) => vec![(0, nx(x), ny(y))],
            _ => Vec::new(),
        }
    }
}

struct Keys {
    file: Option<File>,
    buttons: u32,
}

impl Keys {
    fn open() -> Keys {
        let file = find_event("mtk-kpd").and_then(|p| open_input(&p).ok());
        Keys { file, buttons: 0 }
    }
    fn pump(&mut self) -> bool {
        let Some(f) = self.file.as_mut() else { return false };
        let mut evs = Vec::new();
        read_events(f, &mut evs);
        let mut power = false;
        for (ty, code, v) in evs {
            if ty != EV_KEY {
                continue;
            }
            let bit = match code {
                KEY_VOLUMEUP => btn::RTRIGGER,
                KEY_VOLUMEDOWN => btn::LTRIGGER,
                KEY_POWER => {
                    power |= v == 1;
                    0
                }
                _ => 0,
            };
            if v != 0 {
                self.buttons |= bit;
            } else {
                self.buttons &= !bit;
            }
        }
        power
    }
}

// ---- runtime -------------------------------------------------------------------------

fn pack_touch(id: u32, x: u32, y: u32) -> u32 {
    ((id & 0xff) << 18) | ((y & 0x1ff) << 9) | (x & 0x1ff)
}

fn load(dir: &str) -> Result<(Vec<u8>, Vec<u8>, (u32, u32))> {
    let js = std::fs::read(format!("{dir}/app.js")).with_context(|| format!("{dir}/app.js"))?;
    let pak = std::fs::read(format!("{dir}/app.pak")).with_context(|| format!("{dir}/app.pak"))?;
    let vp = std::fs::read_to_string(format!("{dir}/viewport"))
        .ok()
        .and_then(|s| {
            let mut it = s.split_whitespace().map(|n| n.parse::<u32>().ok());
            Some((it.next()??, it.next()??))
        })
        .unwrap_or((512, 300));
    Ok((js, pak, vp))
}

struct Rt {
    guest: Guest,
    surface: UiSurface,
}

fn boot(js: &[u8], pak: &[u8], vp: (u32, u32), link: &Link) -> Result<Rt> {
    let surface = UiSurface::new_with_density((vp.0 as f32, vp.1 as f32), DENSITY);
    surface.set_identity(HOST_ID, HOST_ABI);
    surface.feed_pak(pak);
    let guest = Guest::new()?;
    surface.mount(&guest)?;
    link.mount(&guest)?;
    guest.eval("app", std::str::from_utf8(js)?)?;
    anyhow::ensure!(guest.has_frame(), "bundle has no frame()");
    Ok(Rt { guest, surface })
}

fn hello(js: &[u8], pak: &[u8], vp: (u32, u32)) -> String {
    let mut h: u32 = 0x811c9dc5;
    for b in js.iter().chain(pak.iter()) {
        h = (h ^ *b as u32).wrapping_mul(0x0100_0193);
    }
    format!(r#"{{"t":"hello","host":"{HOST_ID}-kiosk","abi":{HOST_ABI},"bundle":"{h:08x}","viewport":[{},{}]}}"#, vp.0, vp.1)
}

fn rasterize(ui: &Ui, words: &[u32], rgba: &mut [u8], tracker: &mut DamageTracker, lw: i32, lh: i32) -> (DamagePlan, bool) {
    match raster::render_scaled_incremental(ui, words, rgba, DENSITY, tracker, DamagePolicy::default()) {
        Ok(plan) => (plan, false),
        Err(_) => {
            raster::render_scaled(ui, words, rgba, DENSITY);
            tracker.invalidate();
            (DamagePlan::full(DamageRect::new(0, 0, lw, lh)), true)
        }
    }
}

fn main() -> Result<()> {
    android_logger::init_once(
        android_logger::Config::default().with_max_level(log::LevelFilter::Info).with_tag("pocketjs-kiosk"),
    );
    let dir = std::env::args().nth(1).unwrap_or_else(|| "/data/local/tmp/pocketjs".into());
    let (mut js, mut pak, mut vp) = load(&dir)?;
    let link = Link::start(hello(&js, &pak, vp));
    let mut rt = boot(&js, &pak, vp, &link)?;
    let mut fb = Fb::open()?;
    let mut touch = Touch::open()?;
    let mut keys = Keys::open();
    eprintln!("pocketjs-kiosk: running {dir} ({}x{} logical)", vp.0, vp.1);

    let (mut rw, mut rh) = ((vp.0 * DENSITY) as usize, (vp.1 * DENSITY) as usize);
    let mut rgba = vec![0u8; rw * rh * 4];
    let mut tracker = DamageTracker::new();
    let mut full = true;
    let mut next = Instant::now();
    let (mut n, mut total, mut worst) = (0u32, Duration::ZERO, Duration::ZERO);
    let mut worst_phases = String::new();

    loop {
        let now = Instant::now();
        if now < next {
            std::thread::sleep(next - now);
        }
        next = if Instant::now() - next > TICK * 3 { Instant::now() + TICK } else { next + TICK };
        let t0 = Instant::now();

        if let Some(b) = link.take_bundle() {
            let nvp = b.viewport.unwrap_or(vp);
            match boot(&b.js, &b.pak, nvp, &link) {
                Ok(new_rt) => {
                    let _ = std::fs::write(format!("{dir}/app.js"), &b.js);
                    let _ = std::fs::write(format!("{dir}/app.pak"), &b.pak);
                    let _ = std::fs::write(format!("{dir}/viewport"), format!("{} {}", nvp.0, nvp.1));
                    rt = new_rt;
                    (js, pak, vp) = (b.js, b.pak, nvp);
                    link.set_hello(hello(&js, &pak, vp));
                    (rw, rh) = ((vp.0 * DENSITY) as usize, (vp.1 * DENSITY) as usize);
                    rgba = vec![0u8; rw * rh * 4];
                    tracker = DamageTracker::new();
                    full = true;
                    link.send(r#"{"t":"reloaded","ok":true}"#);
                }
                Err(e) => {
                    link.send(&format!(r#"{{"t":"reloaded","ok":false,"error":{}}}"#, serde_json::to_string(&format!("{e:#}"))?));
                }
            }
        }

        touch.pump();
        if keys.pump() {
            // Power key: hand the device back to Android (kiosk.sh restarts the framework).
            eprintln!("pocketjs-kiosk: power key → exit");
            return Ok(());
        }
        // Panel portrait (px, py) → landscape logical (lx = py, ly = 1 - px).
        let touches: Vec<u32> = touch
            .contacts()
            .into_iter()
            .map(|(id, x, y)| {
                let lx = ((y * vp.0 as f32) as u32).min(vp.0 - 1);
                let ly = (((1.0 - x) * vp.1 as f32) as u32).min(vp.1 - 1);
                pack_touch(id, lx, ly)
            })
            .collect();

        let ta = Instant::now();
        if let Err(e) = rt.guest.frame_with_touches(keys.buttons, ANALOG_CENTER, &touches) {
            log::error!("frame() threw: {e:#}");
        }
        let tb = Instant::now();
        rt.surface.tick();
        let tc = Instant::now();
        let (lw, lh) = (vp.0 as i32, vp.1 as i32);
        let plan = rt.surface.with_ui(|ui| {
            let words = ui.draw().words.clone();
            rasterize(ui, &words, &mut rgba, &mut tracker, lw, lh)
        });
        let (plan, forced) = plan;
        let td = Instant::now();
        if full || forced {
            fb.present(&rgba, rw, rh, None);
            full = false;
        } else if !plan.is_empty() {
            let b = plan.bounds();
            let d = DENSITY as usize;
            let r = Rect {
                x0: b.x0.max(0) as usize * d,
                y0: b.y0.max(0) as usize * d,
                x1: (b.x1.max(0) as usize * d).min(rw),
                y1: (b.y1.max(0) as usize * d).min(rh),
            };
            fb.present(&rgba, rw, rh, Some(r));
        }

        let dt = t0.elapsed();
        n += 1;
        total += dt;
        if dt > worst {
            worst = dt;
            let ms = |d: Duration| d.as_secs_f64() * 1000.0;
            worst_phases = format!(
                "pre {:.1} / js {:.1} / core {:.1} / raster {:.1} / present {:.1}",
                ms(ta - t0), ms(tb - ta), ms(tc - tb), ms(td - tc), ms(td.elapsed())
            );
        }
        if n == 300 {
            log::info!(
                "kiosk tick: mean {:.2} ms, worst {:.2} ms [{}] (worst pan {:.2} ms)",
                total.as_secs_f64() * 1000.0 / n as f64,
                worst.as_secs_f64() * 1000.0,
                worst_phases,
                fb.pan_worst.as_secs_f64() * 1000.0
            );
            fb.pan_worst = Duration::ZERO;
            (n, total, worst) = (0, Duration::ZERO, Duration::ZERO);
        }
    }
}
