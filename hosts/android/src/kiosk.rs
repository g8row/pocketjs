//! pocketjs-kiosk — the PocketJS runtime with NO Android framework.
//!
//! Two setups, same binary logic (first device found wins):
//!
//! Stock Android kernel — run as root after stopping zygote/surfaceflinger
//! (see kiosk/kiosk.sh). It keeps Lenovo's kernel + drivers:
//!   display  /dev/graphics/fb0 (mtkfb, 600×1024 portrait, BGRA, 3 buffers;
//!            the landscape UI is rotated 90° in the blit; FBIOPAN_DISPLAY flips)
//!   touch    the `mtk-tpd` evdev node (multitouch protocol A or B)
//!   keys     the `mtk-kpd` evdev node (volume keys → shoulder buttons)
//!   link     same TCP link to deskd (adbd is native, so adb reverse still works)
//!
//! Mainline Linux (Alpine, static musl build) — run as root on the console:
//!   display  /dev/fb0 (`mediatekdrmfb`, DRM fbdev emulation, 600×1024 XRGB8888,
//!            one buffer, scanned out directly: no pan needed). The VT is put
//!            in KD_GRAPHICS so fbcon stops drawing over us.
//!   touch    `Goodix Capacitive TouchScreen` (MT protocol B, portrait coords)
//!   keys     `mt6779-keypad` (volume) + `mtk-pmic-keys` (power)
//!   link     127.0.0.1:7777, tunnelled with `ssh -R 7777:127.0.0.1:7777`
//!
//! Overrides (env): POCKETJS_FB=/dev/fbN, POCKETJS_TOUCH=<evdev name or path>,
//! POCKETJS_KEYS=<names/paths, comma separated>, POCKETJS_KIOSK_PAN=0|1,
//! POCKETJS_TOUCH_XFORM=[s][x][y] (swap / invert panel axes),
//! POCKETJS_POWER=exit|ignore, POCKETJS_KIOSK_VT=0 (leave the VT alone),
//! POCKETJS_LINK=host:port. Bundle dir: argv[1].
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
use pocketjs_core::damage::{DamagePlan, DamagePolicy, DamageRect, DamageTarget, DamageTracker};
use pocketjs_core::spec::{btn, ANALOG_CENTER};
use pocketjs_core::{raster, Ui};

const HOST_ID: &str = "android";
/// Bundle directory when argv[1] is not given.
#[cfg(target_os = "android")]
const DEFAULT_DIR: &str = "/data/local/tmp/pocketjs";
#[cfg(not(target_os = "android"))]
const DEFAULT_DIR: &str = "/opt/pocketjs";
const FB_PATHS: &[&str] = &["/dev/graphics/fb0", "/dev/fb0"];
const TOUCH_NAMES: &[&str] = &["mtk-tpd", "Goodix Capacitive TouchScreen"];
const KEY_NAMES: &[&str] = &["mtk-kpd", "mt6779-keypad", "mtk-pmic-keys"];
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
    /// Issue FBIOPAN_DISPLAY after each write (needed by mtkfb).
    pan: bool,
    panned: bool,
    /// Rotated dirty region (BGRA u32), reused between frames.
    scratch: Vec<u32>,
    /// Time spent in the last present's rotate and copy-out (POCKETJS_STATS=2).
    last_rot: Duration,
    last_copy: Duration,
    /// Worker threads for large presents (POCKETJS_PRESENT_THREADS, default 2: memory-bound, 4 is no faster).
    threads: usize,
    /// Rotate straight into the framebuffer instead of scratch + row copies (POCKETJS_PRESENT_DIRECT).
    direct: bool,
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
        let paths: Vec<String> = match std::env::var("POCKETJS_FB") {
            Ok(p) => vec![p],
            Err(_) => FB_PATHS.iter().map(|p| p.to_string()).collect(),
        };
        let (path, file) = paths
            .iter()
            .find_map(|p| OpenOptions::new().read(true).write(true).open(p).ok().map(|f| (p.clone(), f)))
            .with_context(|| format!("no framebuffer (tried {})", paths.join(", ")))?;
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
        // mtkfb (stock kernel) only re-reads memory on a pan; a DRM fbdev
        // emulation buffer is scanned out directly, and its pan is an atomic
        // commit that can block until vblank — skip it unless there is more
        // than one buffer to flip between (or POCKETJS_KIOSK_PAN says so).
        let id_len = fix.id.iter().position(|&b| b == 0).unwrap_or(fix.id.len());
        let id = String::from_utf8_lossy(&fix.id[..id_len]).into_owned();
        let flip = std::env::var("POCKETJS_KIOSK_FLIP").is_ok() && nbuf > 1;
        let pan = match std::env::var("POCKETJS_KIOSK_PAN").as_deref() {
            Ok("0") => false,
            Ok(_) => true,
            Err(_) => flip || id.starts_with("mtkfb"),
        };
        // Rotate straight into the buffer on DRM fbdev emulation (ordinary cached memory: 4.3 ms per full
        // frame vs 5.7 via scratch + row copies); mtkfb's mapping is uncached, so keep scratch + memcpy there.
        let direct = match std::env::var("POCKETJS_PRESENT_DIRECT").as_deref() {
            Ok(v) => v == "1",
            Err(_) => id.starts_with("mediatekdrmfb"),
        };
        log::info!("{path}: id {id:?}, pan {pan}, flip {flip}, direct {direct}");
        Ok(Fb { _file: file, fd, mem: mem as *mut u8, len, var, stride, nbuf, front, history: Vec::new(), age: vec![None; nbuf], pan_worst: Duration::ZERO, flip, pan, panned: false, scratch: Vec::new(), last_rot: Duration::ZERO, last_copy: Duration::ZERO, threads: std::env::var("POCKETJS_PRESENT_THREADS").ok().and_then(|v| v.parse().ok()).unwrap_or(2).max(1), direct })
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
        // Rotate in TILE×TILE blocks into a cached scratch image (a plain
        // column walk misses the cache on almost every read: 102 ms for a full
        // frame on the A53s at 988 MHz vs 15.8 ms tiled, 7.6 ms with NEON), then copy each panel row out with
        // one contiguous memcpy (mtkfb's mapping is uncached; scattered writes
        // to it are slow, and the DRM fbdev shadow doesn't mind either way).
        debug_assert_eq!((bo, go, ro), (0, 1, 2));
        let ly0 = r.y0.min(render_h).min(pw);
        let ly1 = r.y1.min(render_h).min(pw);
        let lx0 = r.x0.min(render_w).min(ph);
        let lx1 = r.x1.min(render_w).min(ph);
        if ly1 > ly0 && lx1 > lx0 {
            let px0 = pw - ly1; // leftmost panel column touched
            let span = ly1 - ly0;
            let rows = lx1 - lx0;
            let t_rot = Instant::now();
            self.scratch.resize(rows * span, 0);
            let src = SendPtr(rgba.as_ptr() as *mut u8);
            let fbmem = SendPtr(self.mem);
            let stride = self.stride;
            // One band = panel rows lxa..lxb: rotate into its own scratch rows, then copy them out. Bands are
            // disjoint in scratch and in fb, so they run on separate cores (4× A53; a full frame is memory-
            // bound, ~7.6 + 1.9 ms on one core). Small damage stays on this thread.
            let direct = self.direct;
            let band = |lxa: usize, lxb: usize, out: &mut [u32]| {
                if direct {
                    // Straight into the framebuffer rows (it is cached/WC memory on mediatekdrmfb).
                    // SAFETY: rows lxa..lxb < ph and columns px0..px0+span <= pw are inside buffer `back`;
                    // the source rectangle is inside `rgba`.
                    unsafe {
                        let o = fbmem.get().add(base + lxa * stride + px0 * 4) as *mut u32;
                        rotate_band(src.get(), render_w, ly0, ly1, lxa, lxb, o, stride / 4);
                    }
                    return;
                }
                // SAFETY: lx0 <= lxa < lxb <= lx1 <= render_w and ly0 < ly1 <= render_h (inside `rgba`); `out`
                // holds exactly (lxb - lxa) × span pixels.
                unsafe { rotate_band(src.get(), render_w, ly0, ly1, lxa, lxb, out.as_mut_ptr(), span) };
                for (i, lx) in (lxa..lxb).enumerate() {
                    let d = base + lx * stride + px0 * 4;
                    // SAFETY: lx < ph rows and px0 + span <= pw columns, inside buffer `back`.
                    unsafe { std::ptr::copy_nonoverlapping(out[i * span..].as_ptr() as *const u8, fbmem.get().add(d), span * 4) };
                }
            };
            let threads = if rows * span >= 64 * 1024 { self.threads } else { 1 };
            if threads <= 1 {
                band(lx0, lx1, &mut self.scratch[..]);
            } else {
                // Split on 4-row boundaries so the NEON blocks stay whole.
                let per = (rows.div_ceil(threads) + 3) / 4 * 4;
                std::thread::scope(|sc| {
                    let mut rest = &mut self.scratch[..];
                    let mut lxa = lx0;
                    let band = &band;
                    while lxa < lx1 {
                        let lxb = (lxa + per).min(lx1);
                        let (mine, tail) = rest.split_at_mut((lxb - lxa) * span);
                        rest = tail;
                        if lxb == lx1 {
                            band(lxa, lxb, mine);
                        } else {
                            sc.spawn(move || band(lxa, lxb, mine));
                        }
                        lxa = lxb;
                    }
                });
            }
            let t_copy = Instant::now();
            self.last_rot += t_copy - t_rot;
            self.last_copy += t_copy.elapsed();
        }
        let mut var = self.var;
        var.yoffset = (back * ph) as u32;
        var.xoffset = 0;
        if self.pan {
            let tp = Instant::now();
            unsafe {
                libc::ioctl(self.fd, FBIOPAN_DISPLAY as _, &mut var);
            }
            self.pan_worst = self.pan_worst.max(tp.elapsed());
        }
        self.panned = true;
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

/// A raw pointer that may cross into scoped worker threads (each thread touches a disjoint range).
#[derive(Clone, Copy)]
struct SendPtr(*mut u8);
// SAFETY: only used for disjoint per-band ranges inside `Fb::present`'s thread scope.
unsafe impl Send for SendPtr {}
unsafe impl Sync for SendPtr {}

impl SendPtr {
    /// Through a method, so closures capture the `Send` wrapper and not the raw field.
    fn get(self) -> *mut u8 {
        self.0
    }
}

/// Rotate landscape RGBA columns `lxa..lxb` × rows `ly0..ly1` 90° clockwise into BGRA panel rows:
/// panel row `lx` (at `out + (lx - lxa) * out_stride`, u32 units) gets pixel `(lx, ly)` at index `ly1 - 1 - ly`.
/// Tiled for the cache, NEON 4×4 blocks where whole, one pixel at a time on the ragged edges.
///
/// # Safety
/// The source rectangle must be inside `src` (row length `render_w` pixels) and `out` must hold
/// `(lxb - lxa - 1) * out_stride + (ly1 - ly0)` pixels.
#[allow(clippy::too_many_arguments)]
unsafe fn rotate_band(src: *const u8, render_w: usize, ly0: usize, ly1: usize, lxa: usize, lxb: usize, out: *mut u32, out_stride: usize) {
    const TILE: usize = 32;
    let px = |lx: usize, ly: usize| unsafe {
        let p = u32::from_le(std::ptr::read_unaligned(src.add((ly * render_w + lx) * 4) as *const u32));
        *out.add((lx - lxa) * out_stride + (ly1 - 1 - ly)) = 0xff00_0000 | (p & 0x0000_ff00) | ((p & 0xff) << 16) | ((p >> 16) & 0xff);
    };
    for by in (ly0..ly1).step_by(TILE) {
        let by1 = (by + TILE).min(ly1);
        for bx in (lxa..lxb).step_by(TILE) {
            let bx1 = (bx + TILE).min(lxb);
            #[cfg(target_arch = "aarch64")]
            let (vy1, vx1) = {
                let vy1 = by + (by1 - by) / 4 * 4;
                let vx1 = bx + (bx1 - bx) / 4 * 4;
                for ly in (by..vy1).step_by(4) {
                    for lx in (bx..vx1).step_by(4) {
                        // SAFETY: the 4×4 block is inside the source rectangle; its four output runs are
                        // inside `out` (rows lx..lx+4, columns ly1-4-ly..ly1-ly).
                        unsafe { rotate4x4(src, render_w, lx, ly, out.add((lx - lxa) * out_stride + (ly1 - 4 - ly)), out_stride) };
                    }
                }
                (vy1, vx1)
            };
            #[cfg(not(target_arch = "aarch64"))]
            let (vy1, vx1) = (by, bx);
            for ly in by..vy1 {
                for lx in vx1..bx1 {
                    px(lx, ly);
                }
            }
            for ly in vy1..by1 {
                for lx in bx..bx1 {
                    px(lx, ly);
                }
            }
        }
    }
}

/// Rotate one 4×4 block of the landscape RGBA image (columns `lx..lx+4`, rows `ly..ly+4`) 90° clockwise into
/// four BGRA runs: panel row `lx + k` gets `[ly+3, ly+2, ly+1, ly]` of column `lx + k`, written at
/// `dst + k * stride` (u32 units).
///
/// # Safety
/// The 4×4 source block must be inside `src` (row length `render_w` pixels) and the four 4-pixel runs inside `dst`.
#[cfg(target_arch = "aarch64")]
#[inline(always)]
unsafe fn rotate4x4(src: *const u8, render_w: usize, lx: usize, ly: usize, dst: *mut u32, stride: usize) {
    use std::arch::aarch64::*;
    const SWIZZLE: [u8; 16] = [2, 1, 0, 3, 6, 5, 4, 7, 10, 9, 8, 11, 14, 13, 12, 15];
    unsafe {
        let tbl = vld1q_u8(SWIZZLE.as_ptr());
        let alpha = vdupq_n_u32(0xff00_0000);
        let row = |k: usize| vreinterpretq_u32_u8(vld1q_u8(src.add(((ly + k) * render_w + lx) * 4)));
        let (r0, r1, r2, r3) = (row(0), row(1), row(2), row(3));
        let p = vtrnq_u32(r3, r2);
        let q = vtrnq_u32(r1, r0);
        let cols = [
            vcombine_u32(vget_low_u32(p.0), vget_low_u32(q.0)),
            vcombine_u32(vget_low_u32(p.1), vget_low_u32(q.1)),
            vcombine_u32(vget_high_u32(p.0), vget_high_u32(q.0)),
            vcombine_u32(vget_high_u32(p.1), vget_high_u32(q.1)),
        ];
        for (k, c) in cols.into_iter().enumerate() {
            let bgra = vorrq_u32(vreinterpretq_u32_u8(vqtbl1q_u8(vreinterpretq_u8_u32(c), tbl)), alpha);
            vst1q_u8(dst.add(k * stride) as *mut u8, vreinterpretq_u8_u32(bgra));
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

/// An evdev spec: a path (`/dev/input/…`) as is, else a device name.
fn resolve_event(spec: &str) -> Option<String> {
    if spec.starts_with('/') {
        std::path::Path::new(spec).exists().then(|| spec.to_string())
    } else {
        find_event(spec)
    }
}

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
    /// POCKETJS_TOUCH_XFORM: swap axes, then invert x / y (normalized panel space).
    swap: bool,
    inv_x: bool,
    inv_y: bool,
}

impl Touch {
    fn open() -> Result<Touch> {
        let specs: Vec<String> = match std::env::var("POCKETJS_TOUCH") {
            Ok(s) => vec![s],
            Err(_) => TOUCH_NAMES.iter().map(|s| s.to_string()).collect(),
        };
        let path = specs
            .iter()
            .find_map(|s| resolve_event(s))
            .with_context(|| format!("no touch device (tried {})", specs.join(", ")))?;
        let file = open_input(&path)?;
        let mut xr = abs_range(&file, ABS_MT_POSITION_X);
        let mut yr = abs_range(&file, ABS_MT_POSITION_Y);
        if xr.1 <= 1 {
            xr = abs_range(&file, ABS_X);
            yr = abs_range(&file, ABS_Y);
        }
        let xform = std::env::var("POCKETJS_TOUCH_XFORM").unwrap_or_default();
        log::info!("touch {path}: x {:?} y {:?} xform {xform:?}", xr, yr);
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
            swap: xform.contains('s'),
            inv_x: xform.contains('x'),
            inv_y: xform.contains('y'),
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

    /// Contacts as (id, panel x, panel y) normalized to 0..1, after the
    /// optional POCKETJS_TOUCH_XFORM correction.
    fn contacts(&self) -> Vec<(u32, f32, f32)> {
        let mut c = self.raw_contacts();
        if self.swap || self.inv_x || self.inv_y {
            for (_, x, y) in c.iter_mut() {
                if self.swap {
                    std::mem::swap(x, y);
                }
                if self.inv_x {
                    *x = 1.0 - *x;
                }
                if self.inv_y {
                    *y = 1.0 - *y;
                }
            }
        }
        c
    }

    fn raw_contacts(&self) -> Vec<(u32, f32, f32)> {
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
    files: Vec<File>,
    buttons: u32,
}

impl Keys {
    /// Every key device present: the stock kernel has one (`mtk-kpd`),
    /// mainline splits volume (`mt6779-keypad`) and power (`mtk-pmic-keys`).
    fn open() -> Keys {
        let specs: Vec<String> = match std::env::var("POCKETJS_KEYS") {
            Ok(s) => s.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
            Err(_) => KEY_NAMES.iter().map(|s| s.to_string()).collect(),
        };
        let mut paths: Vec<String> = specs.iter().filter_map(|s| resolve_event(s)).collect();
        paths.dedup();
        log::info!("keys: {paths:?}");
        let files = paths.iter().filter_map(|p| open_input(p).ok()).collect();
        Keys { files, buttons: 0 }
    }
    fn pump(&mut self) -> bool {
        let mut evs = Vec::new();
        for f in self.files.iter_mut() {
            read_events(f, &mut evs);
        }
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

/// `&Ui` for the raster worker threads. `Ui` is not `Sync` (a font-measurement miss counter is a `Cell`,
/// and taffy's layout tree holds raw pointers), but the raster only calls the read-only accessors
/// `viewport`, `font_atlas` and `texture`; nothing it reaches mutates, and the main thread is blocked in
/// the scope until every band is done.
#[derive(Clone, Copy)]
struct RasterUi<'a>(&'a Ui);
// SAFETY: see above — shared read-only use inside one `std::thread::scope` in `rasterize`.
unsafe impl Send for RasterUi<'_> {}
unsafe impl Sync for RasterUi<'_> {}

impl<'a> RasterUi<'a> {
    /// Through a method, so closures capture the wrapper and not the `&Ui` field.
    fn get(self) -> &'a Ui {
        self.0
    }
}

/// Incremental raster like `raster::render_scaled_incremental`, but a large damage region (a page slide
/// damages the whole screen every frame: 4-12 ms on one A53) is split into horizontal bands rendered on
/// `threads` cores. Each band is a disjoint slice of `rgba`, and the core pixel-clips every op to it.
fn rasterize(ui: &Ui, words: &[u32], rgba: &mut [u8], tracker: &mut DamageTracker, lw: i32, lh: i32, threads: usize) -> (DamagePlan, bool) {
    let target = DamageTarget::new(lw as u32 * DENSITY, lh as u32 * DENSITY, DENSITY, raster::DAMAGE_SIGNATURE_RGBA8);
    let plan = match tracker.prepare(ui, words, target).and_then(|p| p.with_policy(DamagePolicy::default())) {
        Ok(plan) => plan,
        Err(_) => {
            raster::render_scaled(ui, words, rgba, DENSITY);
            tracker.invalidate();
            return (DamagePlan::full(DamageRect::new(0, 0, lw, lh)), true);
        }
    };
    let row_bytes = lw as usize * DENSITY as usize * 4;
    let d = DENSITY as usize;
    for &region in plan.regions() {
        let region = region.intersect(DamageRect::new(0, 0, lw, lh));
        if region.is_empty() {
            continue;
        }
        let (y0, y1) = (region.y0 as usize, region.y1 as usize);
        let area = (region.x1 - region.x0) as usize * (y1 - y0);
        let n = if area >= 32 * 1024 { threads.min(y1 - y0) } else { 1 };
        if n <= 1 {
            let band = &mut rgba[y0 * d * row_bytes..y1 * d * row_bytes];
            raster::render_scaled_region_band(ui, words, band, (y0 * d) as u32, DENSITY, region);
            continue;
        }
        let per = (y1 - y0).div_ceil(n);
        let shared = RasterUi(ui);
        std::thread::scope(|sc| {
            let mut rest = &mut rgba[y0 * d * row_bytes..y1 * d * row_bytes];
            let mut ya = y0;
            while ya < y1 {
                let yb = (ya + per).min(y1);
                let (mine, tail) = rest.split_at_mut((yb - ya) * d * row_bytes);
                rest = tail;
                let r = DamageRect::new(region.x0, ya as i32, region.x1, yb as i32);
                if yb == y1 {
                    raster::render_scaled_region_band(ui, words, mine, (ya * d) as u32, DENSITY, r);
                } else {
                    sc.spawn(move || raster::render_scaled_region_band(shared.get(), words, mine, (ya * d) as u32, DENSITY, r));
                }
                ya = yb;
            }
        });
    }
    tracker.commit(ui, words, target);
    (plan, false)
}

#[cfg(target_os = "android")]
fn init_log() {
    android_logger::init_once(
        android_logger::Config::default().with_max_level(log::LevelFilter::Info).with_tag("pocketjs-kiosk"),
    );
}

/// No logcat off Android: log lines go to stderr (kiosk log file / console).
#[cfg(not(target_os = "android"))]
fn init_log() {
    struct Stderr;
    impl log::Log for Stderr {
        fn enabled(&self, m: &log::Metadata) -> bool {
            m.level() <= log::Level::Info
        }
        fn log(&self, r: &log::Record) {
            if self.enabled(r.metadata()) {
                eprintln!("pocketjs-kiosk {} {}", r.level(), r.args());
            }
        }
        fn flush(&self) {}
    }
    static LOGGER: Stderr = Stderr;
    let _ = log::set_logger(&LOGGER).map(|()| log::set_max_level(log::LevelFilter::Info));
}

// ---- console / signals ---------------------------------------------------------------

const KDSETMODE: libc::c_ulong = 0x4B3A;
const KD_TEXT: libc::c_int = 0;
const KD_GRAPHICS: libc::c_int = 1;

/// Puts the active VT in graphics mode (fbcon stops drawing text and the
/// cursor over fb0) and restores text mode when dropped. No-op without a VT
/// (stock Android) or with POCKETJS_KIOSK_VT=0.
struct Vt(Option<File>);

impl Vt {
    fn graphics() -> Vt {
        if std::env::var("POCKETJS_KIOSK_VT").as_deref() == Ok("0") {
            return Vt(None);
        }
        for p in ["/dev/tty0", "/dev/tty1"] {
            if let Ok(f) = OpenOptions::new().read(true).write(true).open(p) {
                if unsafe { libc::ioctl(f.as_raw_fd(), KDSETMODE as _, KD_GRAPHICS) } == 0 {
                    log::info!("{p}: KD_GRAPHICS");
                    return Vt(Some(f));
                }
            }
        }
        Vt(None)
    }
}

impl Drop for Vt {
    fn drop(&mut self) {
        if let Some(f) = &self.0 {
            unsafe {
                libc::ioctl(f.as_raw_fd(), KDSETMODE as _, KD_TEXT);
            }
        }
    }
}

static STOP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

extern "C" fn on_signal(_: libc::c_int) {
    STOP.store(true, std::sync::atomic::Ordering::Relaxed);
}

fn main() -> Result<()> {
    init_log();
    // SIGTERM/SIGINT end the loop normally so the VT is restored.
    unsafe {
        libc::signal(libc::SIGTERM, on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t);
        libc::signal(libc::SIGINT, on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t);
    }
    let dir = std::env::args().nth(1).unwrap_or_else(|| DEFAULT_DIR.into());
    let (mut js, mut pak, mut vp) = load(&dir)?;
    let link = Link::start(hello(&js, &pak, vp));
    let mut rt = boot(&js, &pak, vp, &link)?;
    let _vt = Vt::graphics();
    let mut fb = Fb::open()?;
    // The touchscreen can appear after we start (on mainline the Goodix driver probes late), so run without it
    // and look for it again every second instead of failing.
    let mut touch = Touch::open().map_err(|e| log::warn!("{e:#}; retrying every 1 s")).ok();
    let mut touch_retry = Instant::now() + Duration::from_secs(1);
    let mut keys = Keys::open();
    // Power key: exit (the default; on the stock kernel kiosk.sh then restarts
    // Android, on mainline the process just ends) or ignore it.
    let power_exits = std::env::var("POCKETJS_POWER").as_deref() != Ok("ignore");
    eprintln!("pocketjs-kiosk: running {dir} ({}x{} logical)", vp.0, vp.1);

    let (mut rw, mut rh) = ((vp.0 * DENSITY) as usize, (vp.1 * DENSITY) as usize);
    let mut rgba = vec![0u8; rw * rh * 4];
    let mut tracker = DamageTracker::new();
    let mut full = true;
    let mut next = Instant::now();
    let (mut n, mut total, mut worst) = (0u32, Duration::ZERO, Duration::ZERO);
    let mut worst_phases = String::new();
    // POCKETJS_STATS=1: one line per second (frames, average phases of the frames that drew) — for
    // measuring transitions, where the 300-frame summary hides how many frames actually made it.
    let sec_stats = std::env::var("POCKETJS_STATS").as_deref() == Ok("1");
    // Raster worker threads for large damage (POCKETJS_RASTER_THREADS, default 4).
    let raster_threads: usize = std::env::var("POCKETJS_RASTER_THREADS").ok().and_then(|v| v.parse().ok()).unwrap_or(4).max(1);
    // POCKETJS_STATS=2: one line per frame (tick interval, damage, phases, present split rotate/copy).
    let frame_trace = std::env::var("POCKETJS_STATS").as_deref() == Ok("2");
    let trace_t0 = Instant::now();
    let mut prev_t0 = Instant::now();
    let mut sec_t0 = Instant::now();
    let (mut sec_frames, mut sec_drawn) = (0u32, 0u32);
    let mut sec_ph = [0f64; 5];

    loop {
        if STOP.load(std::sync::atomic::Ordering::Relaxed) {
            eprintln!("pocketjs-kiosk: signal → exit");
            return Ok(());
        }
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

        if touch.is_none() && Instant::now() >= touch_retry {
            touch = Touch::open().ok();
            touch_retry = Instant::now() + Duration::from_secs(1);
        }
        if let Some(t) = touch.as_mut() {
            t.pump();
        }
        if keys.pump() && power_exits {
            // Power key: hand the device back (kiosk.sh restarts Android on the stock kernel).
            eprintln!("pocketjs-kiosk: power key → exit");
            return Ok(());
        }
        // Panel portrait (px, py) → landscape logical (lx = py, ly = 1 - px).
        let touches: Vec<u32> = touch
            .as_ref()
            .map(|t| t.contacts())
            .unwrap_or_default()
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
            rasterize(ui, &words, &mut rgba, &mut tracker, lw, lh, raster_threads)
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
        if frame_trace {
            let ms = |d: Duration| d.as_secs_f64() * 1000.0;
            // Device pixels: regions summed vs their bounding box (what present writes).
            let (area, bbox, rects) = if full || forced { ((rw * rh) as i64, (rw * rh) as i64, 1) } else if plan.is_empty() { (0, 0, 0) } else {
                let a = |r: &pocketjs_core::damage::DamageRect| ((r.x1 - r.x0) as i64) * ((r.y1 - r.y0) as i64) * (DENSITY * DENSITY) as i64;
                (plan.regions().iter().map(a).sum::<i64>(), a(&plan.bounds()), plan.regions().len())
            };
            eprintln!(
                "f {:.1} gap {:.1} area {} bbox {bbox} rects {} js {:.1} core {:.1} raster {:.1} rot {:.1} copy {:.1} total {:.1}",
                ms(t0 - trace_t0), ms(t0 - prev_t0), area, rects, ms(tb - ta), ms(tc - tb), ms(td - tc),
                ms(fb.last_rot), ms(fb.last_copy), ms(dt)
            );
            fb.last_rot = Duration::ZERO;
            fb.last_copy = Duration::ZERO;
        }
        prev_t0 = t0;
        if sec_stats {
            let ms = |d: Duration| d.as_secs_f64() * 1000.0;
            sec_frames += 1;
            if full || forced || !plan.is_empty() {
                sec_drawn += 1;
                for (acc, v) in sec_ph.iter_mut().zip([ms(ta - t0), ms(tb - ta), ms(tc - tb), ms(td - tc), ms(td.elapsed())]) {
                    *acc += v;
                }
            }
            if sec_t0.elapsed() >= Duration::from_secs(1) {
                let k = sec_drawn.max(1) as f64;
                eprintln!(
                    "sec: {sec_frames} frames, {sec_drawn} drawn; avg drawn pre {:.1} js {:.1} core {:.1} raster {:.1} present {:.1} ms",
                    sec_ph[0] / k, sec_ph[1] / k, sec_ph[2] / k, sec_ph[3] / k, sec_ph[4] / k
                );
                sec_t0 = Instant::now();
                (sec_frames, sec_drawn, sec_ph) = (0, 0, [0.0; 5]);
            }
        }
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
