//! Minimal KMS scanout for the kiosk on mainline Linux: two dumb buffers, page flips at vblank.
//!
//! Raw DRM ioctls only (the kiosk is a static musl binary; no libdrm). The flow is the classic legacy-KMS
//! one: find a connected connector and its CRTC, create two XRGB8888 dumb buffers the size of the mode,
//! SETCRTC once with the first finished frame, then PAGE_FLIP with an event for every later frame and read
//! the flip-complete event from the fd before reusing the buffer that was on screen.
//!
//! On drop the original CRTC configuration (the fbdev emulation's framebuffer) is put back, so the kernel
//! console shows again once the VT returns to text mode.

use std::fs::{File, OpenOptions};
use std::io::Read;
use std::os::fd::AsRawFd;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};

const fn iowr(nr: u64, size: u64) -> libc::c_ulong {
    ((3u64 << 30) | (size << 16) | ((b'd' as u64) << 8) | nr) as libc::c_ulong
}

const DRM_IOCTL_MODE_GETRESOURCES: libc::c_ulong = iowr(0xA0, 64);
const DRM_IOCTL_MODE_GETCRTC: libc::c_ulong = iowr(0xA1, 104);
const DRM_IOCTL_MODE_SETCRTC: libc::c_ulong = iowr(0xA2, 104);
const DRM_IOCTL_MODE_GETENCODER: libc::c_ulong = iowr(0xA6, 20);
const DRM_IOCTL_MODE_GETCONNECTOR: libc::c_ulong = iowr(0xA7, 80);
const DRM_IOCTL_MODE_RMFB: libc::c_ulong = iowr(0xAF, 4);
const DRM_IOCTL_MODE_PAGE_FLIP: libc::c_ulong = iowr(0xB0, 24);
const DRM_IOCTL_MODE_CREATE_DUMB: libc::c_ulong = iowr(0xB2, 32);
const DRM_IOCTL_MODE_MAP_DUMB: libc::c_ulong = iowr(0xB3, 16);
const DRM_IOCTL_MODE_DESTROY_DUMB: libc::c_ulong = iowr(0xB4, 4);
const DRM_IOCTL_MODE_ADDFB2: libc::c_ulong = iowr(0xB8, 104);

const DRM_MODE_CONNECTED: u32 = 1;
const DRM_MODE_PAGE_FLIP_EVENT: u32 = 0x01;
const DRM_EVENT_FLIP_COMPLETE: u32 = 0x02;
/// 'XR24' little-endian: B, G, R, X bytes — the same layout the fbdev path writes.
const DRM_FORMAT_XRGB8888: u32 = 0x3432_5258;

#[repr(C)]
#[derive(Default)]
struct CardRes {
    fb_id_ptr: u64,
    crtc_id_ptr: u64,
    connector_id_ptr: u64,
    encoder_id_ptr: u64,
    count_fbs: u32,
    count_crtcs: u32,
    count_connectors: u32,
    count_encoders: u32,
    min_width: u32,
    max_width: u32,
    min_height: u32,
    max_height: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct ModeInfo {
    clock: u32,
    hdisplay: u16,
    hsync_start: u16,
    hsync_end: u16,
    htotal: u16,
    hskew: u16,
    vdisplay: u16,
    vsync_start: u16,
    vsync_end: u16,
    vtotal: u16,
    vscan: u16,
    vrefresh: u32,
    flags: u32,
    type_: u32,
    name: [u8; 32],
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Crtc {
    set_connectors_ptr: u64,
    count_connectors: u32,
    crtc_id: u32,
    fb_id: u32,
    x: u32,
    y: u32,
    gamma_size: u32,
    mode_valid: u32,
    mode: ModeInfo,
}

#[repr(C)]
#[derive(Default)]
struct GetEncoder {
    encoder_id: u32,
    encoder_type: u32,
    crtc_id: u32,
    possible_crtcs: u32,
    possible_clones: u32,
}

#[repr(C)]
#[derive(Default)]
struct GetConnector {
    encoders_ptr: u64,
    modes_ptr: u64,
    props_ptr: u64,
    prop_values_ptr: u64,
    count_modes: u32,
    count_props: u32,
    count_encoders: u32,
    encoder_id: u32,
    connector_id: u32,
    connector_type: u32,
    connector_type_id: u32,
    connection: u32,
    mm_width: u32,
    mm_height: u32,
    subpixel: u32,
    pad: u32,
}

#[repr(C)]
#[derive(Default)]
struct PageFlip {
    crtc_id: u32,
    fb_id: u32,
    flags: u32,
    reserved: u32,
    user_data: u64,
}

#[repr(C)]
#[derive(Default)]
struct CreateDumb {
    height: u32,
    width: u32,
    bpp: u32,
    flags: u32,
    handle: u32,
    pitch: u32,
    size: u64,
}

#[repr(C)]
#[derive(Default)]
struct MapDumb {
    handle: u32,
    pad: u32,
    offset: u64,
}

#[repr(C)]
#[derive(Default)]
struct FbCmd2 {
    fb_id: u32,
    width: u32,
    height: u32,
    pixel_format: u32,
    flags: u32,
    handles: [u32; 4],
    pitches: [u32; 4],
    offsets: [u32; 4],
    modifier: [u64; 4],
}

fn ioctl<T>(fd: i32, req: libc::c_ulong, arg: &mut T) -> std::io::Result<()> {
    loop {
        // SAFETY: `arg` is the #[repr(C)] struct the request expects (sizes checked in the request numbers).
        let r = unsafe { libc::ioctl(fd, req as _, arg as *mut T) };
        if r == 0 {
            return Ok(());
        }
        let e = std::io::Error::last_os_error();
        if !matches!(e.raw_os_error(), Some(libc::EINTR) | Some(libc::EAGAIN)) {
            return Err(e);
        }
    }
}

struct Buffer {
    handle: u32,
    fb_id: u32,
    mem: *mut u8,
    size: usize,
}

pub struct Drm {
    file: File,
    crtc_id: u32,
    connector_id: u32,
    mode: ModeInfo,
    saved: Crtc,
    bufs: Vec<Buffer>,
    pub width: usize,
    pub height: usize,
    pub pitch: usize,
    /// The buffer on screen (or flipping to the screen), and whether a flip event is still outstanding.
    front: Option<usize>,
    pending: bool,
    /// Slowest wait for a flip event inside `wait_flip` since the last stats line.
    pub wait_worst: Duration,
    /// Time spent in the last `back()` waiting for a flip, and the vblank timestamp (ms) / sequence of the
    /// last flip-complete event plus the gap to the one before (on-screen frame interval), for the trace.
    pub last_wait: Duration,
    pub last_flip: Option<(f64, u32)>,
    pub flip_gap: Option<f64>,
}

impl Drm {
    /// `path` (or the first KMS-capable /dev/dri/card*) with two dumb buffers sized to the connected mode.
    pub fn open(path: Option<&str>) -> Result<Drm> {
        let candidates: Vec<String> = match path {
            Some(p) => vec![p.to_string()],
            None => (0..4).map(|i| format!("/dev/dri/card{i}")).collect(),
        };
        let mut last_err = None;
        for p in &candidates {
            match Self::open_one(p) {
                Ok(d) => return Ok(d),
                Err(e) => last_err = Some(e.context(p.clone())),
            }
        }
        Err(last_err.unwrap_or_else(|| anyhow::anyhow!("no DRM card")))
    }

    fn open_one(path: &str) -> Result<Drm> {
        let file = OpenOptions::new().read(true).write(true).open(path).context("open")?;
        let fd = file.as_raw_fd();
        let mut res = CardRes::default();
        ioctl(fd, DRM_IOCTL_MODE_GETRESOURCES, &mut res).context("GETRESOURCES (not a KMS device?)")?;
        anyhow::ensure!(res.count_connectors > 0 && res.count_crtcs > 0, "no connectors/CRTCs (render-only device)");
        let mut conns = vec![0u32; res.count_connectors as usize];
        let mut crtcs = vec![0u32; res.count_crtcs as usize];
        let mut encs = vec![0u32; res.count_encoders as usize];
        let mut res2 = CardRes {
            connector_id_ptr: conns.as_mut_ptr() as u64,
            crtc_id_ptr: crtcs.as_mut_ptr() as u64,
            encoder_id_ptr: encs.as_mut_ptr() as u64,
            count_connectors: res.count_connectors,
            count_crtcs: res.count_crtcs,
            count_encoders: res.count_encoders,
            ..Default::default()
        };
        ioctl(fd, DRM_IOCTL_MODE_GETRESOURCES, &mut res2).context("GETRESOURCES")?;

        for &cid in &conns {
            let mut c = GetConnector { connector_id: cid, ..Default::default() };
            ioctl(fd, DRM_IOCTL_MODE_GETCONNECTOR, &mut c).context("GETCONNECTOR")?;
            if c.connection != DRM_MODE_CONNECTED || c.count_modes == 0 {
                continue;
            }
            let mut modes: Vec<ModeInfo> = vec![unsafe { std::mem::zeroed() }; c.count_modes as usize];
            let mut cencs = vec![0u32; c.count_encoders as usize];
            let mut c2 = GetConnector {
                connector_id: cid,
                modes_ptr: modes.as_mut_ptr() as u64,
                count_modes: c.count_modes,
                encoders_ptr: cencs.as_mut_ptr() as u64,
                count_encoders: c.count_encoders,
                ..Default::default()
            };
            ioctl(fd, DRM_IOCTL_MODE_GETCONNECTOR, &mut c2).context("GETCONNECTOR modes")?;
            let mode = modes[0];
            // The CRTC: the one the connector's current encoder drives, else the first one its encoders allow.
            let mut crtc_id = 0;
            for &eid in std::iter::once(&c2.encoder_id).chain(cencs.iter()) {
                if eid == 0 {
                    continue;
                }
                let mut e = GetEncoder { encoder_id: eid, ..Default::default() };
                if ioctl(fd, DRM_IOCTL_MODE_GETENCODER, &mut e).is_err() {
                    continue;
                }
                if e.crtc_id != 0 {
                    crtc_id = e.crtc_id;
                    break;
                }
                if let Some((i, _)) = crtcs.iter().enumerate().find(|(i, _)| e.possible_crtcs & (1 << i) != 0) {
                    crtc_id = crtcs[i];
                    break;
                }
            }
            anyhow::ensure!(crtc_id != 0, "connector {cid}: no usable CRTC");
            let mut saved: Crtc = unsafe { std::mem::zeroed() };
            saved.crtc_id = crtc_id;
            ioctl(fd, DRM_IOCTL_MODE_GETCRTC, &mut saved).context("GETCRTC")?;

            let (w, h) = (mode.hdisplay as usize, mode.vdisplay as usize);
            let mut drm = Drm {
                file,
                crtc_id,
                connector_id: cid,
                mode,
                saved,
                bufs: Vec::new(),
                width: w,
                height: h,
                pitch: 0,
                front: None,
                pending: false,
                wait_worst: Duration::ZERO,
                last_wait: Duration::ZERO,
                last_flip: None,
                flip_gap: None,
            };
            for _ in 0..2 {
                let b = drm.create_buffer(w as u32, h as u32)?;
                drm.bufs.push(b);
            }
            let name_len = mode.name.iter().position(|&b| b == 0).unwrap_or(32);
            log::info!(
                "drm {path}: connector {cid} crtc {crtc_id} mode {} {}x{} @ {} Hz (clock {} kHz, htotal {} vtotal {}), pitch {}, 2 dumb buffers",
                String::from_utf8_lossy(&mode.name[..name_len]),
                w,
                h,
                mode.vrefresh,
                mode.clock,
                mode.htotal,
                mode.vtotal,
                drm.pitch
            );
            return Ok(drm);
        }
        bail!("no connected connector")
    }

    fn create_buffer(&mut self, w: u32, h: u32) -> Result<Buffer> {
        let fd = self.file.as_raw_fd();
        let mut c = CreateDumb { width: w, height: h, bpp: 32, ..Default::default() };
        ioctl(fd, DRM_IOCTL_MODE_CREATE_DUMB, &mut c).context("CREATE_DUMB")?;
        self.pitch = c.pitch as usize;
        let mut f = FbCmd2 { width: w, height: h, pixel_format: DRM_FORMAT_XRGB8888, ..Default::default() };
        f.handles[0] = c.handle;
        f.pitches[0] = c.pitch;
        ioctl(fd, DRM_IOCTL_MODE_ADDFB2, &mut f).context("ADDFB2")?;
        let mut m = MapDumb { handle: c.handle, ..Default::default() };
        ioctl(fd, DRM_IOCTL_MODE_MAP_DUMB, &mut m).context("MAP_DUMB")?;
        let size = c.size as usize;
        // SAFETY: mapping the dumb buffer at the fake offset the kernel just gave us.
        let mem = unsafe { libc::mmap(std::ptr::null_mut(), size, libc::PROT_READ | libc::PROT_WRITE, libc::MAP_SHARED, fd, m.offset as libc::off_t) };
        anyhow::ensure!(mem != libc::MAP_FAILED, "mmap dumb buffer: {}", std::io::Error::last_os_error());
        // Start black, like a cleared screen.
        // SAFETY: `mem` maps `size` writable bytes.
        unsafe { std::ptr::write_bytes(mem as *mut u8, 0, size) };
        Ok(Buffer { handle: c.handle, fb_id: f.fb_id, mem: mem as *mut u8, size })
    }

    pub fn buffers(&self) -> usize {
        self.bufs.len()
    }

    /// Start of buffer `i`'s pixels (pitch bytes per row).
    pub fn mem(&self, i: usize) -> *mut u8 {
        self.bufs[i].mem
    }

    /// The buffer it is safe to draw into next: not on screen and not waiting to get there.
    /// Blocks for an outstanding flip event first (at most one vblank, ~15 ms at 66 Hz).
    pub fn back(&mut self) -> usize {
        let t = Instant::now();
        self.wait_flip();
        self.last_wait = t.elapsed();
        match self.front {
            Some(f) => (f + 1) % self.bufs.len(),
            None => 0,
        }
    }

    /// Put buffer `i` on screen: SETCRTC the first time, then a page flip that lands at the next vblank.
    pub fn show(&mut self, i: usize) -> Result<()> {
        let fd = self.file.as_raw_fd();
        if self.front.is_none() {
            let mut conn = self.connector_id;
            let mut c = Crtc {
                set_connectors_ptr: &mut conn as *mut u32 as u64,
                count_connectors: 1,
                crtc_id: self.crtc_id,
                fb_id: self.bufs[i].fb_id,
                x: 0,
                y: 0,
                gamma_size: 0,
                mode_valid: 1,
                mode: self.mode,
            };
            ioctl(fd, DRM_IOCTL_MODE_SETCRTC, &mut c).context("SETCRTC (DRM master held by someone else?)")?;
            self.front = Some(i);
            return Ok(());
        }
        let mut f = PageFlip { crtc_id: self.crtc_id, fb_id: self.bufs[i].fb_id, flags: DRM_MODE_PAGE_FLIP_EVENT, ..Default::default() };
        ioctl(fd, DRM_IOCTL_MODE_PAGE_FLIP, &mut f).context("PAGE_FLIP")?;
        self.pending = true;
        self.front = Some(i);
        Ok(())
    }

    /// Consume the outstanding flip-complete event, if any (blocking up to 100 ms).
    pub fn wait_flip(&mut self) {
        if !self.pending {
            return;
        }
        let t = Instant::now();
        let fd = self.file.as_raw_fd();
        let mut pfd = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
        // SAFETY: one valid pollfd.
        let n = unsafe { libc::poll(&mut pfd, 1, 100) };
        if n > 0 {
            self.drain();
        } else {
            log::warn!("drm: no flip event after 100 ms");
            self.pending = false;
        }
        self.wait_worst = self.wait_worst.max(t.elapsed());
    }

    /// Read whatever events are queued; a flip-complete clears `pending`.
    fn drain(&mut self) {
        let mut buf = [0u8; 256];
        if let Ok(n) = self.file.read(&mut buf) {
            let mut off = 0;
            while off + 8 <= n {
                let ty = u32::from_ne_bytes(buf[off..off + 4].try_into().unwrap());
                let len = u32::from_ne_bytes(buf[off + 4..off + 8].try_into().unwrap()) as usize;
                if ty == DRM_EVENT_FLIP_COMPLETE && off + 28 <= n {
                    self.pending = false;
                    let w = |o: usize| u32::from_ne_bytes(buf[off + o..off + o + 4].try_into().unwrap());
                    let ts = w(16) as f64 * 1000.0 + w(20) as f64 / 1000.0;
                    let seq = w(24);
                    self.flip_gap = self.last_flip.map(|(t, _)| ts - t);
                    self.last_flip = Some((ts, seq));
                }
                if len == 0 {
                    break;
                }
                off += len;
            }
        }
    }

    /// The front buffer as tight 600×1024 BGRX rows (what `fb2png.py` reads), for screenshots.
    pub fn dump_front(&self, path: &str) -> Result<()> {
        let i = self.front.context("nothing on screen yet")?;
        let mut out = Vec::with_capacity(self.width * self.height * 4);
        for y in 0..self.height {
            // SAFETY: row y of buffer i is inside its mapping (pitch × height <= size).
            let row = unsafe { std::slice::from_raw_parts(self.bufs[i].mem.add(y * self.pitch), self.width * 4) };
            out.extend_from_slice(row);
        }
        std::fs::write(path, out)?;
        Ok(())
    }
}

impl Drop for Drm {
    fn drop(&mut self) {
        let fd = self.file.as_raw_fd();
        self.wait_flip();
        // Give the CRTC back to what was there (the fbdev emulation's framebuffer), so the console returns.
        if self.saved.fb_id != 0 {
            let mut conn = self.connector_id;
            let mut c = self.saved;
            c.set_connectors_ptr = &mut conn as *mut u32 as u64;
            c.count_connectors = 1;
            if let Err(e) = ioctl(fd, DRM_IOCTL_MODE_SETCRTC, &mut c) {
                log::warn!("drm: restoring the original CRTC failed: {e}");
            }
        }
        for b in &self.bufs {
            // SAFETY: unmapping what create_buffer mapped; the fb/handle ids are ours.
            unsafe { libc::munmap(b.mem as *mut _, b.size) };
            let mut id = b.fb_id;
            let _ = ioctl(fd, DRM_IOCTL_MODE_RMFB, &mut id);
            let mut h = b.handle;
            let _ = ioctl(fd, DRM_IOCTL_MODE_DESTROY_DUMB, &mut h);
        }
    }
}
