//! Incremental raster + damage-scoped presentation to an ANativeWindow.
//!
//! `rgba` is the retained render target (always the complete current frame).
//! Each tick the core's DamageTracker repaints only DrawList damage into it;
//! we then lock the window with the damage bounds as `inOutDirtyBounds`.
//! Android may GROW that rect (the back buffer it hands out can be older than
//! the last posted one), so we always fill whatever rect it returns — cheap,
//! because `rgba` is complete. An idle frame locks nothing and posts nothing.

use anyhow::Result;
use ndk::hardware_buffer_format::HardwareBufferFormat;
use ndk::native_window::NativeWindow;
use pocketjs_core::damage::{DamagePlan, DamagePolicy, DamageTracker};
use pocketjs_core::{raster, Ui};

use crate::geometry::Geometry;

pub struct Presenter {
    win: NativeWindow,
    geo: Geometry,
    rgba: Vec<u8>,
    tracker: DamageTracker,
    /// Force the next present to cover the whole window (new/redrawn surface).
    full: bool,
}

/// Window-space rect, half-open.
#[derive(Clone, Copy, Debug)]
struct Rect {
    x0: usize,
    y0: usize,
    x1: usize,
    y1: usize,
}

impl Presenter {
    pub fn new(win: NativeWindow, geo: Geometry) -> Self {
        if let Err(e) = win.set_buffers_geometry(
            geo.win_w as i32,
            geo.win_h as i32,
            Some(HardwareBufferFormat::R8G8B8A8_UNORM),
        ) {
            log::warn!("set_buffers_geometry failed: {e:?}");
        }
        Self {
            win,
            geo,
            rgba: vec![0; geo.render_w * geo.render_h * 4],
            tracker: DamageTracker::new(),
            full: true,
        }
    }

    pub fn invalidate(&mut self) {
        self.full = true;
    }

    pub fn render(&mut self, ui: &Ui, words: &[u32]) -> Result<()> {
        let plan = self.rasterize(ui, words);
        let dirty = if self.full {
            Some(Rect { x0: 0, y0: 0, x1: self.geo.win_w, y1: self.geo.win_h })
        } else if plan.is_empty() {
            None
        } else {
            let b = plan.bounds();
            let d = self.geo.density as usize;
            let (sx0, sy0) = self.render_to_window(b.x0.max(0) as usize * d, b.y0.max(0) as usize * d);
            let (sx1, sy1) = self.render_to_window_end(b.x1.max(0) as usize * d, b.y1.max(0) as usize * d);
            Some(Rect { x0: sx0, y0: sy0, x1: sx1, y1: sy1 })
        };
        let Some(dirty) = dirty else { return Ok(()) };
        self.present(dirty)?;
        self.full = false;
        Ok(())
    }

    fn rasterize(&mut self, ui: &Ui, words: &[u32]) -> DamagePlan {
        match raster::render_scaled_incremental(
            ui,
            words,
            &mut self.rgba,
            self.geo.density,
            &mut self.tracker,
            DamagePolicy::default(),
        ) {
            Ok(plan) => plan,
            Err(_) => {
                raster::render_scaled(ui, words, &mut self.rgba, self.geo.density);
                self.tracker.invalidate();
                self.full = true; // present() covers the whole window
                let (lw, lh) = (self.geo.logical_w as i32, self.geo.logical_h as i32);
                DamagePlan::full(pocketjs_core::damage::DamageRect::new(0, 0, lw, lh))
            }
        }
    }

    fn render_to_window(&self, rx: usize, ry: usize) -> (usize, usize) {
        let g = &self.geo;
        (rx.min(g.render_w) * g.disp_w / g.render_w + g.ox, ry.min(g.render_h) * g.disp_h / g.render_h + g.oy)
    }

    fn render_to_window_end(&self, rx: usize, ry: usize) -> (usize, usize) {
        let g = &self.geo;
        (
            (rx.min(g.render_w) * g.disp_w).div_ceil(g.render_w) + g.ox,
            (ry.min(g.render_h) * g.disp_h).div_ceil(g.render_h) + g.oy,
        )
    }

    fn present(&mut self, want: Rect) -> Result<()> {
        let mut bounds = ndk_sys::ARect {
            left: want.x0 as i32,
            top: want.y0 as i32,
            right: want.x1 as i32,
            bottom: want.y1 as i32,
        };
        let mut guard = self.win.lock(Some(&mut bounds))?;
        let (bw, bh, stride) = (guard.width(), guard.height(), guard.stride());
        // Android may have grown the rect; honour exactly what it returned.
        let r = Rect {
            x0: bounds.left.clamp(0, bw as i32) as usize,
            y0: bounds.top.clamp(0, bh as i32) as usize,
            x1: bounds.right.clamp(0, bw as i32) as usize,
            y1: bounds.bottom.clamp(0, bh as i32) as usize,
        };
        let bits = guard.bits() as *mut u8;
        let g = self.geo;
        for y in r.y0..r.y1 {
            // SAFETY: the lock guard gives exclusive access to a bh×stride
            // RGBA8888 buffer; y < bh and the row slice is ≤ stride*4 bytes.
            let row = unsafe { std::slice::from_raw_parts_mut(bits.add(y * stride * 4), bw * 4) };
            if y < g.oy || y >= g.oy + g.disp_h {
                fill_black(&mut row[r.x0 * 4..r.x1 * 4]);
                continue;
            }
            // Letterbox left / right of the render.
            let lx0 = r.x0.max(g.ox).min(r.x1);
            let lx1 = r.x1.min(g.ox + g.disp_w).max(lx0);
            fill_black(&mut row[r.x0 * 4..lx0 * 4]);
            fill_black(&mut row[lx1 * 4..r.x1 * 4]);
            if lx1 == lx0 {
                continue;
            }
            let dst = &mut row[lx0 * 4..lx1 * 4];
            if g.is_unscaled() {
                let s = ((y - g.oy) * g.render_w + (lx0 - g.ox)) * 4;
                dst.copy_from_slice(&self.rgba[s..s + dst.len()]);
            } else {
                let sy = (y - g.oy) * g.render_h / g.disp_h;
                for (i, px) in dst.chunks_exact_mut(4).enumerate() {
                    let sx = (lx0 + i - g.ox) * g.render_w / g.disp_w;
                    let s = (sy * g.render_w + sx) * 4;
                    px.copy_from_slice(&self.rgba[s..s + 4]);
                }
            }
        }
        drop(guard); // unlockAndPost
        Ok(())
    }
}

fn fill_black(span: &mut [u8]) {
    for px in span.chunks_exact_mut(4) {
        px.copy_from_slice(&[0, 0, 0, 255]);
    }
}
