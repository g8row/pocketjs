//! android-host — the PocketJS UI runtime as a native Android activity.
//!
//! Pipeline per tick (same order as uihost / hosts/pocketbook):
//!   guest turn → core tick → DrawList → incremental software raster into a
//!   retained RGBA8 buffer → copy ONLY the damaged rows into the locked
//!   ANativeWindow buffer → unlockAndPost.
//!
//! Why software raster on Android: on a 1 GB MT6737M tablet the cheapest path
//! to a stable 60 fps is to never wake the GPU driver for UI work. The core's
//! damage tracker makes an idle frame cost zero raster work and zero buffer
//! posts, and SurfaceFlinger composes our single RGBA layer with HWC overlays.
//!
//! The app bundle (`app.js` + `app.pak`) ships as APK assets; override with
//! `/data/local/tmp/pocketjs/app.{js,pak}` for fast iteration (adb push, no
//! reinstall).

mod geometry;
mod input;
mod present;

use std::ffi::CString;
use std::io::Read;
use std::time::{Duration, Instant};

use android_activity::{AndroidApp, InputStatus, MainEvent, PollEvent};
use anyhow::{Context, Result};
use pocket_mod::Guest;
use pocket_ui_surface::UiSurface;

use geometry::Geometry;
use present::Presenter;

/// Host platform-contract identity. Must match `android.hostAbi` in
/// contracts/spec/platforms.ts or plan-built bundles refuse this host.
const HOST_ID: &str = "android";
const HOST_ABI: u32 = 6;

/// Logical viewport + raster density of the `android` target profile.
const LOGICAL_W: u32 = 480;
const LOGICAL_H: u32 = 272;
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
}

fn boot(app: &AndroidApp) -> Result<Runtime> {
    let pak = load_asset(app, "app.pak")?;
    let js = String::from_utf8(load_asset(app, "app.js")?).context("app.js is not UTF-8")?;

    let surface = UiSurface::new_with_density((LOGICAL_W as f32, LOGICAL_H as f32), DENSITY);
    surface.set_identity(HOST_ID, HOST_ABI);
    surface.feed_pak(&pak);

    let guest = Guest::new()?;
    surface.mount(&guest)?;
    guest.eval("app", &js)?;
    anyhow::ensure!(guest.has_frame(), "bundle installed no frame() — is this a PocketJS app?");
    Ok(Runtime { guest, surface })
}

fn run(app: AndroidApp) -> Result<()> {
    let rt = boot(&app)?;
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
                    let geo = Geometry::for_window(
                        win.width() as usize,
                        win.height() as usize,
                        LOGICAL_W as usize,
                        LOGICAL_H as usize,
                        DENSITY,
                    );
                    log::info!("window {}x{} → {:?}", win.width(), win.height(), geo);
                    input.set_geometry(geo);
                    presenter = Some(Presenter::new(win, geo));
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

        let t0 = Instant::now();
        let (buttons, analog, touches) = input.snapshot();
        rt.guest.frame_with_touches(buttons, analog, &touches)?;
        rt.surface.tick();

        if let Some(p) = presenter.as_mut() {
            rt.surface.with_ui(|ui| {
                let words = ui.draw().words.clone();
                p.render(ui, &words)
            })?;
        }
        stats.record(t0.elapsed());
    }
    Ok(())
}

/// Read a bundle file: developer override dir first, then the APK assets.
fn load_asset(app: &AndroidApp, name: &str) -> Result<Vec<u8>> {
    let dev = format!("{DEV_DIR}/{name}");
    if let Ok(bytes) = std::fs::read(&dev) {
        log::info!("loaded {dev} (dev override)");
        return Ok(bytes);
    }
    let cname = CString::new(name)?;
    let mut asset = app
        .asset_manager()
        .open(&cname)
        .with_context(|| format!("asset {name} missing from APK"))?;
    let mut buf = Vec::new();
    asset.read_to_end(&mut buf)?;
    Ok(buf)
}

/// Logs worst / mean tick cost every ~5 s so jank is visible in logcat.
#[derive(Default)]
struct Stats {
    n: u32,
    total: Duration,
    worst: Duration,
}

impl Stats {
    fn record(&mut self, d: Duration) {
        self.n += 1;
        self.total += d;
        self.worst = self.worst.max(d);
        if self.n == 300 {
            log::info!(
                "tick cost: mean {:.2} ms, worst {:.2} ms",
                self.total.as_secs_f64() * 1000.0 / self.n as f64,
                self.worst.as_secs_f64() * 1000.0
            );
            *self = Stats::default();
        }
    }
}
