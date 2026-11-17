//! Optional GPU presenter (cargo feature `gpu`): the DrawList is rendered by
//! `pocket-ui-wgpu` through wgpu's **OpenGL ES** backend into the window's EGL
//! surface — the Mali-T720 here has GLES 3.1 and no Vulkan.
//!
//! Enabled at runtime by the presence of `/data/local/tmp/pocketjs/gpu` so
//! the same APK can be A/B-measured against the software presenter.
//!
//! `pocket3d::Gpu::new_for_surface` asks for desktop `Limits::default()`,
//! which a GLES device can't satisfy, so the device is built here with the
//! WebGL2-class downlevel limits instead (the struct's fields are public).

use anyhow::{Context, Result};
use ndk::native_window::NativeWindow;
use pocket3d::gpu::Gpu;
use pocket_ui_wgpu::UiRenderer;
use pocketjs_core::Ui;

use crate::geometry::Geometry;

pub const SWITCH: &str = "/data/local/tmp/pocketjs/gpu";

pub fn enabled() -> bool {
    std::path::Path::new(SWITCH).exists()
}

pub struct GpuPresenter {
    // Field order = drop order: surface before the window it renders to.
    surface: wgpu::Surface<'static>,
    gpu: Gpu,
    renderer: UiRenderer,
    config: wgpu::SurfaceConfiguration,
    geo: Geometry,
    _win: NativeWindow,
}

impl GpuPresenter {
    pub fn new(win: NativeWindow, geo: Geometry) -> Result<GpuPresenter> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: wgpu::Backends::GL,
            ..Default::default()
        });
        let handle = raw_window_handle::AndroidNdkWindowHandle::new(
            std::ptr::NonNull::new(win.ptr().as_ptr() as *mut _).context("null ANativeWindow")?,
        );
        // SAFETY: the window outlives the surface (both owned by this struct,
        // surface dropped first).
        let surface = unsafe {
            instance.create_surface_unsafe(wgpu::SurfaceTargetUnsafe::RawHandle {
                raw_display_handle: raw_window_handle::RawDisplayHandle::Android(
                    raw_window_handle::AndroidDisplayHandle::new(),
                ),
                raw_window_handle: raw_window_handle::RawWindowHandle::AndroidNdk(handle),
            })
        }
        .context("create EGL surface")?;
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
        }))
        .context("no GLES adapter")?;
        let info = adapter.get_info();
        log::info!("gpu: adapter {:?} / {:?} / driver {:?}", info.name, info.backend, info.driver_info);
        let limits = wgpu::Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits());
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("pocketjs-android"),
            required_features: wgpu::Features::empty(),
            required_limits: limits,
            memory_hints: wgpu::MemoryHints::default(),
            trace: wgpu::Trace::Off,
        }))
        .context("request GLES device")?;
        let caps = surface.get_capabilities(&adapter);
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|f| !f.is_srgb())
            .unwrap_or(caps.formats[0]);
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: geo.win_w as u32,
            height: geo.win_h as u32,
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
        };
        surface.configure(&device, &config);
        log::info!("gpu: surface {}x{} {:?}", config.width, config.height, format);
        let gpu = Gpu { instance, adapter, device, queue };
        let renderer = UiRenderer::new(&gpu, format);
        Ok(GpuPresenter { surface, gpu, renderer, config, geo, _win: win })
    }

    /// Render the whole frame (GPU path: no damage tracking — the GPU redraws
    /// everything, the CPU only builds vertices). Skips when nothing changed.
    pub fn render(&mut self, ui: &Ui, words: &[u32], changed: bool) -> Result<()> {
        if !changed {
            return Ok(());
        }
        let frame = match self.surface.get_current_texture() {
            Ok(f) => f,
            Err(_) => {
                self.surface.configure(&self.gpu.device, &self.config);
                self.surface.get_current_texture().context("acquire surface texture")?
            }
        };
        let view = frame.texture.create_view(&Default::default());
        let mut enc = self.gpu.device.create_command_encoder(&Default::default());
        self.renderer.render_words_scaled(
            &self.gpu,
            ui,
            words,
            &mut enc,
            &view,
            (self.geo.render_w as u32, self.geo.render_h as u32),
            self.geo.density as f32,
            wgpu::LoadOp::Clear(wgpu::Color::BLACK),
        )?;
        self.gpu.queue.submit([enc.finish()]);
        frame.present();
        Ok(())
    }
}
