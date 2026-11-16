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
//! Bundle sources, first hit wins: (1) the last bundle pushed by deskd over the
//! link (app files dir), (2) `/data/local/tmp/pocketjs/` (adb push), (3) the APK
//! assets. Each source is `app.js` + `app.pak` + optional `viewport` ("W H",
//! logical px; default 480 272). A bundle pushed over the link hot-reloads the
//! runtime in place — no reinstall, no activity restart.

pub mod geometry;
pub mod link;

#[cfg(target_os = "android")]
mod host;
#[cfg(target_os = "android")]
mod input;
#[cfg(target_os = "android")]
mod present;
