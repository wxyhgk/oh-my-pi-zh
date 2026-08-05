#[cfg(feature = "wayland-pipewire")]
mod capture;
mod libei;
mod portal;

use image::RgbaImage;

use crate::desktop::{
	backend::{AxBackend, Backend, DeliveryMode, PointerEvent},
	error::{CoreResult, DesktopError},
	frame::FrameGeometry,
	keys::KeyName,
	linux::ax::AtSpiAx,
	types::{
		CaptureCaps, DesktopCapabilities, DesktopDisplay, DesktopWindow, DisplaySelector, Target,
	},
};

pub struct WaylandBackend {
	#[cfg_attr(
		not(feature = "wayland-pipewire"),
		expect(dead_code, reason = "only read by the pipewire capture path")
	)]
	display:     DisplaySelector,
	ax:          Option<AtSpiAx>,
	ax_error:    Option<DesktopError>,
	input:       Option<libei::Libei>,
	input_error: Option<DesktopError>,
	displays:    Vec<DesktopDisplay>,
}

impl WaylandBackend {
	pub fn new(display: DisplaySelector) -> Self {
		let (ax, ax_error) = match AtSpiAx::new() {
			Ok(ax) => (Some(ax), None),
			Err(err) => (None, Some(err)),
		};
		let (input, input_error) = match libei::Libei::new() {
			Ok(input) => (Some(input), None),
			Err(err) => (None, Some(err)),
		};
		Self { display, ax, ax_error, input, input_error, displays: Vec::new() }
	}

	fn background_error(target: &Target, kind: &str) -> CoreResult<()> {
		if let Target::Window(id) = target {
			return Err(DesktopError::background_unavailable(format!(
				"window {id} wayland-compositor-focus-only: Wayland cannot target a non-focused \
				 window for {kind}; use ax actions or delivery:\"foreground\""
			)));
		}
		Ok(())
	}

	fn prepare_input(&mut self, target: &Target, mode: DeliveryMode, kind: &str) -> CoreResult<()> {
		if mode == DeliveryMode::Background {
			Self::background_error(target, kind)?;
		}
		if mode == DeliveryMode::Foreground
			&& let Target::Window(id) = target
		{
			self.raise_window(id)?;
		}
		if self.input.is_none() {
			return Err(self.input_error.clone().unwrap_or_else(|| {
				DesktopError::permission_denied(
					"RemoteDesktop portal or LIBEI_SOCKET is required for Wayland input",
				)
			}));
		}
		Ok(())
	}

	#[cfg(feature = "wayland-pipewire")]
	fn synthetic_display(image: &RgbaImage) -> DesktopDisplay {
		DesktopDisplay {
			id:           "wayland-portal-0".to_string(),
			name:         "Wayland portal monitor".to_string(),
			x:            0,
			y:            0,
			width:        image.width(),
			height:       image.height(),
			scale:        1.0,
			pixel_x:      0,
			pixel_y:      0,
			pixel_width:  image.width(),
			pixel_height: image.height(),
			is_primary:   true,
		}
	}

	#[cfg(feature = "wayland-pipewire")]
	fn selected_display_allowed(&self) -> CoreResult<()> {
		match &self.display {
			DisplaySelector::All => Ok(()),
			DisplaySelector::Id(id) if id == "wayland-portal-0" => Ok(()),
			DisplaySelector::Id(id) => Err(DesktopError::invalid_target(format!(
				"Wayland portal display '{id}' is unavailable; use 'all' or 'wayland-portal-0'"
			))),
		}
	}
}

impl Backend for WaylandBackend {
	fn capabilities(&mut self) -> DesktopCapabilities {
		DesktopCapabilities {
			backend: "wayland".to_string(),
			display_server: Some("wayland".to_string()),
			capture: true,
			input: self.input.is_some(),
			ax: self.ax.is_some(),
			background_window_input: false,
			delivery_modes: vec!["foreground".to_string(), "background".to_string()],
			capture_permission: "prompt-or-granted".to_string(),
			input_permission: if self.input.is_some() {
				"granted".to_string()
			} else {
				"unavailable".to_string()
			},
			ax_permission: if self.ax.is_some() {
				"granted".to_string()
			} else {
				"unavailable".to_string()
			},
			display_count: self.displays.len() as u32,
		}
	}

	fn displays(&mut self) -> CoreResult<Vec<DesktopDisplay>> {
		Ok(self.displays.clone())
	}

	fn windows(&mut self) -> CoreResult<Vec<DesktopWindow>> {
		self
			.ax
			.as_mut()
			.ok_or_else(|| {
				self
					.ax_error
					.clone()
					.unwrap_or_else(DesktopError::ax_unsupported)
			})?
			.windows()
	}

	fn capture(
		&mut self,
		target: &Target,
		_caps: &CaptureCaps,
	) -> CoreResult<(RgbaImage, FrameGeometry)> {
		#[cfg(not(feature = "wayland-pipewire"))]
		{
			let _ = target;
			Err(DesktopError::capture_failed("Wayland capture requires the wayland-pipewire feature"))
		}
		#[cfg(feature = "wayland-pipewire")]
		{
			self.selected_display_allowed()?;
			let image = capture::capture()?;
			let display = Self::synthetic_display(&image);
			self.displays = vec![display.clone()];
			match target {
				Target::Desktop => {
					let geometry = FrameGeometry::for_displays(&self.displays);
					Ok((image, geometry))
				},
				Target::Window(id) => {
					let window = self
						.windows()?
						.into_iter()
						.find(|window| &window.id == id)
						.ok_or_else(|| {
							DesktopError::window_not_found(format!("Wayland window {id} not found"))
						})?;
					if window.x < 0 || window.y < 0 {
						return Err(DesktopError::capture_failed(
							"Wayland portal monitor stream cannot crop a window outside the selected \
							 monitor",
						));
					}
					let x = window.x as u32;
					let y = window.y as u32;
					let width = window.width.min(image.width().saturating_sub(x));
					let height = window.height.min(image.height().saturating_sub(y));
					if width == 0 || height == 0 {
						return Err(DesktopError::capture_failed(format!(
							"Wayland window {id} is outside the selected portal monitor"
						)));
					}
					let cropped = image::imageops::crop_imm(&image, x, y, width, height).to_image();
					let geometry = FrameGeometry::for_window(&window, cropped.width(), cropped.height());
					Ok((cropped, geometry))
				},
			}
		}
	}

	fn pointer(
		&mut self,
		target: &Target,
		ev: PointerEvent,
		_frame: &FrameGeometry,
		mode: DeliveryMode,
	) -> CoreResult<()> {
		self.prepare_input(target, mode, "pointer input")?;
		self
			.input
			.as_mut()
			.ok_or_else(|| DesktopError::internal("Wayland input backend disappeared"))?
			.pointer(ev)
	}

	fn type_text(&mut self, target: &Target, text: &str, mode: DeliveryMode) -> CoreResult<()> {
		self.prepare_input(target, mode, "keyboard input")?;
		self
			.input
			.as_mut()
			.ok_or_else(|| DesktopError::internal("Wayland input backend disappeared"))?
			.type_text(text)
	}

	fn key_chord(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		mode: DeliveryMode,
	) -> CoreResult<()> {
		self.prepare_input(target, mode, "keyboard input")?;
		self
			.input
			.as_mut()
			.ok_or_else(|| DesktopError::internal("Wayland input backend disappeared"))?
			.key_chord(keys)
	}

	fn raise_window(&mut self, id: &str) -> CoreResult<()> {
		self
			.ax
			.as_mut()
			.ok_or_else(|| {
				self
					.ax_error
					.clone()
					.unwrap_or_else(DesktopError::ax_unsupported)
			})?
			.raise_window(id)
	}

	fn ax(&mut self) -> Option<&mut dyn AxBackend> {
		self.ax.as_mut().map(|ax| ax as &mut dyn AxBackend)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn window_background_delivery_is_structurally_rejected() {
		let target = Target::Window("w1".to_string());
		let err = WaylandBackend::background_error(&target, "pointer input")
			.expect_err("window background input must fail");
		assert_eq!(err.code.as_str(), "BackgroundUnavailable");
		assert!(err.message.contains("wayland-compositor-focus-only"));
	}
}
