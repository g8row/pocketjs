//! Where the 480×272 @2x render (960×544) lands in the Android window.
//!
//! When the render fits (TB-7304X: 1024×600 landscape) it is placed 1:1 and
//! centered — every damaged row is a straight memcpy. Smaller windows fall
//! back to nearest-neighbor scale-to-fit.

#[derive(Clone, Copy, Debug)]
pub struct Geometry {
    pub logical_w: usize,
    pub logical_h: usize,
    pub density: u32,
    /// Render buffer size (logical × density).
    pub render_w: usize,
    pub render_h: usize,
    /// Window (= ANativeWindow buffer) size.
    pub win_w: usize,
    pub win_h: usize,
    /// Displayed size of the render inside the window.
    pub disp_w: usize,
    pub disp_h: usize,
    /// Top-left of the displayed render inside the window.
    pub ox: usize,
    pub oy: usize,
}

impl Geometry {
    pub fn for_window(win_w: usize, win_h: usize, logical_w: usize, logical_h: usize, density: u32) -> Self {
        let render_w = logical_w * density as usize;
        let render_h = logical_h * density as usize;
        let (disp_w, disp_h) = if render_w <= win_w && render_h <= win_h {
            (render_w, render_h)
        } else if win_w * render_h < win_h * render_w {
            (win_w, (render_h * win_w / render_w).max(1))
        } else {
            ((render_w * win_h / render_h).max(1), win_h)
        };
        Self {
            logical_w,
            logical_h,
            density,
            render_w,
            render_h,
            win_w,
            win_h,
            disp_w,
            disp_h,
            ox: win_w.saturating_sub(disp_w) / 2,
            oy: win_h.saturating_sub(disp_h) / 2,
        }
    }

    pub fn is_unscaled(&self) -> bool {
        self.disp_w == self.render_w && self.disp_h == self.render_h
    }

    /// Window px → logical viewport px, clamped into the viewport.
    pub fn window_to_logical(&self, x: f32, y: f32) -> (u32, u32) {
        let lx = ((x - self.ox as f32).max(0.0) * self.logical_w as f32 / self.disp_w as f32) as u32;
        let ly = ((y - self.oy as f32).max(0.0) * self.logical_h as f32 / self.disp_h as f32) as u32;
        (
            lx.min(self.logical_w as u32 - 1),
            ly.min(self.logical_h as u32 - 1),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tb7304x_landscape_is_unscaled_and_centered() {
        let g = Geometry::for_window(1024, 600, 480, 272, 2);
        assert!(g.is_unscaled());
        assert_eq!((g.ox, g.oy), (32, 28));
        assert_eq!(g.window_to_logical(32.0, 28.0), (0, 0));
        assert_eq!(g.window_to_logical(32.0 + 958.0, 28.0 + 542.0), (479, 271));
        assert_eq!(g.window_to_logical(1023.0, 599.0), (479, 271)); // letterbox clamps
    }

    #[test]
    fn portrait_scales_down() {
        let g = Geometry::for_window(600, 1024, 480, 272, 2);
        assert!(!g.is_unscaled());
        assert_eq!(g.disp_w, 600);
        assert_eq!(g.disp_h, 340);
    }
}
