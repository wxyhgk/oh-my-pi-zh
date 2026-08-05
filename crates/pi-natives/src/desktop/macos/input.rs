use std::{
	thread,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use core_graphics::{
	event::{CGEvent, CGEventFlags, CGEventType, CGMouseButton, ScrollEventUnit},
	event_source::{CGEventSource, CGEventSourceStateID},
	geometry::CGPoint,
};
use enigo::{Axis, Button, Coordinate, Direction, Enigo, Keyboard, Mouse, Settings};

use super::{
	super::{
		backend::{DeliveryMode, Modifiers, MouseButton, PointerEvent},
		error::{CoreResult, DesktopError},
		keys::KeyName,
		types::{DesktopWindow, Target},
	},
	ax,
	capture::MacCapture,
	skylight,
};

pub(super) struct MacInput {
	global: Enigo,
}

impl MacInput {
	pub(super) fn new() -> CoreResult<Self> {
		let settings = Settings { open_prompt_to_get_permissions: false, ..Settings::default() };
		let global = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| Enigo::new(&settings)))
			.map_err(|_| {
				DesktopError::input_failed("Quartz native input initialization failed unexpectedly")
			})?
			.map_err(|error| {
				DesktopError::input_failed(format!(
					"Quartz native input initialization failed: {error}"
				))
			})?;
		Ok(Self { global })
	}

	pub(super) fn pointer(
		&mut self,
		target: &Target,
		event: PointerEvent,
		mode: DeliveryMode,
		capture: &MacCapture,
	) -> CoreResult<()> {
		match target {
			Target::Desktop => global_pointer(&mut self.global, event),
			Target::Window(id) => {
				let window = capture.window(id)?;
				let (pid, wid) = window_identity(&window)?;
				match mode {
					DeliveryMode::Background => {
						background_guard(&window, pointer_kind(&event), pointer_button(&event))?;
						if !window.focused {
							skylight::activate_without_raise(pid, wid)?;
						}
						background_pointer(pid, wid, &window, event)
					},
					DeliveryMode::Foreground => {
						skylight::with_foreground(pid, wid, || global_pointer(&mut self.global, event))
					},
				}
			},
		}
	}

	pub(super) fn type_text(
		&mut self,
		target: &Target,
		text: &str,
		mode: DeliveryMode,
		capture: &MacCapture,
	) -> CoreResult<()> {
		match target {
			Target::Desktop => self.global.text(text).map_err(input_error),
			Target::Window(id) => {
				let window = capture.window(id)?;
				let (pid, wid) = window_identity(&window)?;
				match mode {
					DeliveryMode::Background => {
						background_guard(&window, "keyboard", None)?;
						prepare_background_keys(&window, pid, wid, capture)?;
						background_type(pid, text)
					},
					DeliveryMode::Foreground => skylight::with_foreground(pid, wid, || {
						let _ = ax::prepare_foreground_input(&window);
						self.global.text(text).map_err(input_error)
					}),
				}
			},
		}
	}

	pub(super) fn key_chord(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		mode: DeliveryMode,
		capture: &MacCapture,
	) -> CoreResult<()> {
		match target {
			Target::Desktop => global_chord(&mut self.global, keys),
			Target::Window(id) => {
				let window = capture.window(id)?;
				let (pid, wid) = window_identity(&window)?;
				match mode {
					DeliveryMode::Background => {
						background_guard(&window, "keyboard", None)?;
						prepare_background_keys(&window, pid, wid, capture)?;
						background_chord(pid, keys)
					},
					DeliveryMode::Foreground => skylight::with_foreground(pid, wid, || {
						let _ = ax::prepare_foreground_input(&window);
						global_chord(&mut self.global, keys)
					}),
				}
			},
		}
	}
}

fn window_identity(window: &DesktopWindow) -> CoreResult<(libc::pid_t, u32)> {
	let pid = window.pid.ok_or_else(|| {
		DesktopError::input_failed(format!("window {} has no owning process id", window.id))
	})?;
	let pid = i32::try_from(pid).map_err(|_| {
		DesktopError::input_failed(format!("window {} has an invalid process id", window.id))
	})?;
	let wid = window.id.parse::<u32>().map_err(|_| {
		DesktopError::invalid_target(format!("invalid macOS window id '{}'", window.id))
	})?;
	Ok((pid, wid))
}

/// Prepares background keyboard delivery for `window`, or refuses it.
///
/// macOS posts key events to a *process*, which hands them to whichever window
/// it treats as key; unlike pointer events they carry no window id, and neither
/// the `SkyLight` focus records nor any accessibility attribute reliably
/// predicts or redirects that choice. Delivery is therefore refused whenever
/// the process owns more than one window, rather than typing into another of
/// the user's windows. `DesktopWindow::focused` cannot disambiguate: xcap
/// reports every window owned by the active application as focused on macOS.
///
/// The refusal decision itself reads no mutable state, so it cannot be fooled
/// by the activation below.
fn prepare_background_keys(
	window: &DesktopWindow,
	pid: libc::pid_t,
	wid: u32,
	capture: &MacCapture,
) -> CoreResult<()> {
	let siblings = capture
		.windows()?
		.into_iter()
		.filter(|candidate| candidate.pid == window.pid)
		.count();
	if siblings > 1 {
		return Err(DesktopError::background_unavailable(format!(
			"window {wid} is one of {siblings} windows in its application; macOS delivers background \
			 keystrokes to whichever window the application treats as key, so retry with \
			 delivery:\"foreground\" or use ax actions",
		)));
	}
	// Sole window of its process, so the target is unambiguous: make it key
	// without raising it or changing the frontmost application. A background app
	// otherwise has no key window and drops the keystrokes entirely.
	skylight::activate_without_raise(pid, wid)
}

const fn pointer_kind(event: &PointerEvent) -> &'static str {
	match event {
		PointerEvent::Click { .. } => "click",
		PointerEvent::Move { .. } => "pointer move",
		PointerEvent::Drag { .. } => "drag",
		PointerEvent::Scroll { .. } => "scroll",
	}
}

const fn pointer_button(event: &PointerEvent) -> Option<MouseButton> {
	match event {
		PointerEvent::Click { button, .. } | PointerEvent::Drag { button, .. } => Some(*button),
		PointerEvent::Move { .. } | PointerEvent::Scroll { .. } => None,
	}
}

fn background_guard(
	window: &DesktopWindow,
	kind: &str,
	button: Option<MouseButton>,
) -> CoreResult<()> {
	let app = window.app.to_ascii_lowercase();
	let chromium = ["chrome", "chromium", "electron", "brave", "edge", "arc"]
		.iter()
		.any(|name| app.contains(name));
	if chromium && button == Some(MouseButton::Right) {
		return Err(DesktopError::background_unavailable(format!(
			"window {} ({}) coerces synthetic background right-click events to left-clicks; retry \
			 with delivery:\"foreground\" or use ax actions",
			window.id, window.app,
		)));
	}
	let canvas_or_game = ["blender", "unity", "godot", "unreal", "ghost"]
		.iter()
		.any(|name| app.contains(name));
	if canvas_or_game {
		return Err(DesktopError::background_unavailable(format!(
			"window {} ({}) drops background {kind} events in its canvas/game input stack; retry \
			 with delivery:\"foreground\" or use ax actions",
			window.id, window.app,
		)));
	}
	Ok(())
}

fn source() -> CoreResult<CGEventSource> {
	CGEventSource::new(CGEventSourceStateID::HIDSystemState)
		.map_err(|()| DesktopError::input_failed("failed to create a Quartz input event source"))
}

fn modifier_flags(modifiers: Modifiers) -> CGEventFlags {
	let mut flags = CGEventFlags::CGEventFlagNull;
	if modifiers.ctrl {
		flags |= CGEventFlags::CGEventFlagControl;
	}
	if modifiers.alt {
		flags |= CGEventFlags::CGEventFlagAlternate;
	}
	if modifiers.shift {
		flags |= CGEventFlags::CGEventFlagShift;
	}
	if modifiers.meta {
		flags |= CGEventFlags::CGEventFlagCommand;
	}
	flags
}

const fn button_types(
	button: MouseButton,
) -> (CGMouseButton, CGEventType, CGEventType, CGEventType, i64) {
	match button {
		MouseButton::Left => (
			CGMouseButton::Left,
			CGEventType::LeftMouseDown,
			CGEventType::LeftMouseUp,
			CGEventType::LeftMouseDragged,
			0,
		),
		MouseButton::Right => (
			CGMouseButton::Right,
			CGEventType::RightMouseDown,
			CGEventType::RightMouseUp,
			CGEventType::RightMouseDragged,
			1,
		),
		MouseButton::Middle => (
			CGMouseButton::Center,
			CGEventType::OtherMouseDown,
			CGEventType::OtherMouseUp,
			CGEventType::OtherMouseDragged,
			2,
		),
	}
}

fn background_pointer(
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	event: PointerEvent,
) -> CoreResult<()> {
	match event {
		PointerEvent::Click { x, y, button, count, modifiers } => {
			background_click(pid, wid, window, x, y, button, count, modifiers)
		},
		PointerEvent::Move { x, y } => {
			let group = click_group_id();
			post_mouse(
				pid,
				wid,
				window,
				source()?,
				CGEventType::MouseMoved,
				CGMouseButton::Left,
				x,
				y,
				2,
				0,
				0,
				group,
				CGEventFlags::CGEventFlagNull,
			)
		},
		PointerEvent::Drag { path, button, modifiers } => {
			background_drag(pid, wid, window, &path, button, modifiers)
		},
		PointerEvent::Scroll { x, y, dx, dy } => background_scroll(pid, wid, window, x, y, dx, dy),
	}
}

fn background_click(
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	x: f64,
	y: f64,
	button: MouseButton,
	count: u32,
	modifiers: Modifiers,
) -> CoreResult<()> {
	let source = source()?;
	let group = click_group_id();
	let (cg_button, down, up, _, number) = button_types(button);
	let flags = modifier_flags(modifiers);
	pointer_prologue(pid, wid, window, &source, x, y, group, flags)?;
	for click_state in 1..=count.max(1) {
		post_mouse(
			pid,
			wid,
			window,
			source.clone(),
			down,
			cg_button,
			x,
			y,
			3,
			i64::from(click_state),
			number,
			group,
			flags,
		)?;
		thread::sleep(Duration::from_millis(1));
		post_mouse(
			pid,
			wid,
			window,
			source.clone(),
			up,
			cg_button,
			x,
			y,
			3,
			i64::from(click_state),
			number,
			group,
			flags,
		)?;
		if click_state < count.max(1) {
			thread::sleep(Duration::from_millis(80));
		}
	}
	Ok(())
}

fn pointer_prologue(
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	source: &CGEventSource,
	x: f64,
	y: f64,
	group: i64,
	flags: CGEventFlags,
) -> CoreResult<()> {
	post_mouse(
		pid,
		wid,
		window,
		source.clone(),
		CGEventType::MouseMoved,
		CGMouseButton::Left,
		x,
		y,
		2,
		0,
		0,
		group,
		flags,
	)?;
	thread::sleep(Duration::from_millis(15));
	post_mouse(
		pid,
		wid,
		window,
		source.clone(),
		CGEventType::LeftMouseDown,
		CGMouseButton::Left,
		-1.0,
		-1.0,
		1,
		1,
		0,
		group,
		flags,
	)?;
	thread::sleep(Duration::from_millis(1));
	post_mouse(
		pid,
		wid,
		window,
		source.clone(),
		CGEventType::LeftMouseUp,
		CGMouseButton::Left,
		-1.0,
		-1.0,
		2,
		1,
		0,
		group,
		flags,
	)?;
	thread::sleep(Duration::from_millis(100));
	Ok(())
}

fn background_drag(
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	path: &[(f64, f64)],
	button: MouseButton,
	modifiers: Modifiers,
) -> CoreResult<()> {
	let Some(&(start_x, start_y)) = path.first() else {
		return Err(DesktopError::input_failed("drag path must contain at least two points"));
	};
	if path.len() < 2 {
		return Err(DesktopError::input_failed("drag path must contain at least two points"));
	}
	let source = source()?;
	let group = click_group_id();
	let (cg_button, down, up, dragged, number) = button_types(button);
	let flags = modifier_flags(modifiers);
	pointer_prologue(pid, wid, window, &source, start_x, start_y, group, flags)?;
	post_mouse(
		pid,
		wid,
		window,
		source.clone(),
		down,
		cg_button,
		start_x,
		start_y,
		3,
		1,
		number,
		group,
		flags,
	)?;
	for &(x, y) in &path[1..] {
		thread::sleep(Duration::from_millis(16));
		post_mouse(
			pid,
			wid,
			window,
			source.clone(),
			dragged,
			cg_button,
			x,
			y,
			3,
			1,
			number,
			group,
			flags,
		)?;
	}
	thread::sleep(Duration::from_millis(50));
	let &(end_x, end_y) = path
		.last()
		.ok_or_else(|| DesktopError::input_failed("drag path is empty"))?;
	post_mouse(pid, wid, window, source, up, cg_button, end_x, end_y, 3, 1, number, group, flags)?;
	Ok(())
}

#[allow(
	clippy::too_many_arguments,
	reason = "the parameters are the native CGEvent fields stamped together"
)]
fn post_mouse(
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	source: CGEventSource,
	event_type: CGEventType,
	button: CGMouseButton,
	x: f64,
	y: f64,
	phase: i64,
	click_state: i64,
	button_number: i64,
	click_group: i64,
	flags: CGEventFlags,
) -> CoreResult<()> {
	let event = CGEvent::new_mouse_event(source, event_type, CGPoint::new(x, y), button)
		.map_err(|()| DesktopError::input_failed("failed to create a Quartz pointer event"))?;
	// Flags are exactly the caller-requested modifier set; no background bypass
	// modifier is injected.
	event.set_flags(flags);
	let local = if x == -1.0 && y == -1.0 {
		CGPoint::new(-1.0, -1.0)
	} else {
		CGPoint::new(x - f64::from(window.x), y - f64::from(window.y))
	};
	skylight::stamp_event(&event, pid, wid, local, phase, click_state, button_number, click_group)?;
	skylight::post_dual(pid, &event)
}

fn background_scroll(
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	x: f64,
	y: f64,
	dx: f64,
	dy: f64,
) -> CoreResult<()> {
	let group = click_group_id();
	let source = source()?;
	post_mouse(
		pid,
		wid,
		window,
		source.clone(),
		CGEventType::MouseMoved,
		CGMouseButton::Left,
		x,
		y,
		2,
		0,
		0,
		group,
		CGEventFlags::CGEventFlagNull,
	)?;
	thread::sleep(Duration::from_millis(15));
	let wheel_x = finite_i32(dx, "horizontal scroll delta")?;
	let wheel_y = finite_i32(dy, "vertical scroll delta")?;
	let event = CGEvent::new_scroll_event(source, ScrollEventUnit::PIXEL, 2, wheel_y, wheel_x, 0)
		.map_err(|()| DesktopError::input_failed("failed to create a Quartz scroll event"))?;
	event.set_location(CGPoint::new(x, y));
	skylight::stamp_event(
		&event,
		pid,
		wid,
		CGPoint::new(x - f64::from(window.x), y - f64::from(window.y)),
		3,
		0,
		0,
		group,
	)?;
	skylight::post_dual(pid, &event)
}

fn click_group_id() -> i64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.subsec_nanos()
		.into()
}

fn background_type(pid: libc::pid_t, text: &str) -> CoreResult<()> {
	let source = source()?;
	for character in text.chars() {
		let value = character.to_string();
		for down in [true, false] {
			let event = CGEvent::new_keyboard_event(source.clone(), 0, down)
				.map_err(|()| DesktopError::input_failed("failed to create a Quartz keyboard event"))?;
			event.set_string(&value);
			event.set_flags(CGEventFlags::CGEventFlagNull);
			skylight::post_keyboard(pid, &event)?;
			thread::sleep(Duration::from_millis(8));
		}
	}
	Ok(())
}

fn background_chord(pid: libc::pid_t, keys: &[KeyName]) -> CoreResult<()> {
	if keys.is_empty() {
		return Err(DesktopError::invalid_key("key chord must not be empty"));
	}
	let source = source()?;
	let mut active = Modifiers::default();
	for &key in keys {
		update_modifier(&mut active, key, true);
		post_key(pid, &source, key, true, modifier_flags(active))?;
		thread::sleep(Duration::from_millis(8));
	}
	let mut first_error = None;
	for &key in keys.iter().rev() {
		update_modifier(&mut active, key, false);
		if let Err(error) = post_key(pid, &source, key, false, modifier_flags(active))
			&& first_error.is_none()
		{
			first_error = Some(error);
		}
		thread::sleep(Duration::from_millis(8));
	}
	first_error.map_or(Ok(()), Err)
}

fn post_key(
	pid: libc::pid_t,
	source: &CGEventSource,
	key: KeyName,
	down: bool,
	flags: CGEventFlags,
) -> CoreResult<()> {
	let code = key_code(key)?;
	let event = CGEvent::new_keyboard_event(source.clone(), code, down)
		.map_err(|()| DesktopError::input_failed("failed to create a Quartz keyboard event"))?;
	event.set_flags(flags);
	skylight::post_keyboard(pid, &event)
}

const fn update_modifier(modifiers: &mut Modifiers, key: KeyName, down: bool) {
	match key {
		KeyName::Ctrl => modifiers.ctrl = down,
		KeyName::Alt => modifiers.alt = down,
		KeyName::Shift => modifiers.shift = down,
		KeyName::Meta => modifiers.meta = down,
		_ => {},
	}
}

fn key_code(key: KeyName) -> CoreResult<u16> {
	let code = match key {
		KeyName::Ctrl => 59,
		KeyName::Alt => 58,
		KeyName::Shift => 56,
		KeyName::Meta => 55,
		KeyName::Enter => 36,
		KeyName::Escape => 53,
		KeyName::Tab => 48,
		KeyName::Space => 49,
		KeyName::Backspace => 51,
		KeyName::Delete => 117,
		KeyName::Insert => 114,
		KeyName::Home => 115,
		KeyName::End => 119,
		KeyName::PageUp => 116,
		KeyName::PageDown => 121,
		KeyName::Up => 126,
		KeyName::Down => 125,
		KeyName::Left => 123,
		KeyName::Right => 124,
		KeyName::CapsLock => 57,
		KeyName::NumLock => 71,
		KeyName::PrintScreen => 105,
		KeyName::F1 => 122,
		KeyName::F2 => 120,
		KeyName::F3 => 99,
		KeyName::F4 => 118,
		KeyName::F5 => 96,
		KeyName::F6 => 97,
		KeyName::F7 => 98,
		KeyName::F8 => 100,
		KeyName::F9 => 101,
		KeyName::F10 => 109,
		KeyName::F11 => 103,
		KeyName::F12 => 111,
		KeyName::F13 => 105,
		KeyName::F14 => 107,
		KeyName::F15 => 113,
		KeyName::F16 => 106,
		KeyName::F17 => 64,
		KeyName::F18 => 79,
		KeyName::F19 => 80,
		KeyName::F20 => 90,
		KeyName::F21 => 110,
		KeyName::F22 => 111,
		KeyName::F23 => 112,
		KeyName::F24 => 113,
		KeyName::Char(character) => char_key_code(character)?,
	};
	Ok(code)
}

fn char_key_code(character: char) -> CoreResult<u16> {
	let normalized = character.to_ascii_lowercase();
	let code = match normalized {
		'a' => 0,
		's' => 1,
		'd' => 2,
		'f' => 3,
		'h' => 4,
		'g' => 5,
		'z' => 6,
		'x' => 7,
		'c' => 8,
		'v' => 9,
		'b' => 11,
		'q' => 12,
		'w' => 13,
		'e' => 14,
		'r' => 15,
		'y' => 16,
		't' => 17,
		'1' => 18,
		'2' => 19,
		'3' => 20,
		'4' => 21,
		'6' => 22,
		'5' => 23,
		'=' => 24,
		'9' => 25,
		'7' => 26,
		'-' => 27,
		'8' => 28,
		'0' => 29,
		']' => 30,
		'o' => 31,
		'u' => 32,
		'[' => 33,
		'i' => 34,
		'p' => 35,
		'l' => 37,
		'j' => 38,
		'\'' => 39,
		'k' => 40,
		';' => 41,
		'\\' => 42,
		',' => 43,
		'/' => 44,
		'n' => 45,
		'm' => 46,
		'.' => 47,
		'`' => 50,
		_ => {
			return Err(DesktopError::invalid_key(format!(
				"key '{character}' has no macOS virtual keycode"
			)));
		},
	};
	Ok(code)
}

fn global_pointer(input: &mut Enigo, event: PointerEvent) -> CoreResult<()> {
	match event {
		PointerEvent::Click { x, y, button, count, modifiers } => {
			move_global(input, x, y)?;
			with_global_modifiers(input, modifiers, |input| {
				for _ in 0..count.max(1) {
					input
						.button(enigo_button(button), Direction::Click)
						.map_err(input_error)?;
				}
				Ok(())
			})
		},
		PointerEvent::Move { x, y } => move_global(input, x, y),
		PointerEvent::Drag { path, button, modifiers } => {
			let Some(&(x, y)) = path.first() else {
				return Err(DesktopError::input_failed("drag path must contain at least two points"));
			};
			if path.len() < 2 {
				return Err(DesktopError::input_failed("drag path must contain at least two points"));
			}
			move_global(input, x, y)?;
			with_global_modifiers(input, modifiers, |input| {
				input
					.button(enigo_button(button), Direction::Press)
					.map_err(input_error)?;
				let drag = path[1..]
					.iter()
					.try_for_each(|&(x, y)| move_global(input, x, y));
				let release = input
					.button(enigo_button(button), Direction::Release)
					.map_err(input_error);
				drag.and(release)
			})
		},
		PointerEvent::Scroll { x, y, dx, dy } => {
			move_global(input, x, y)?;
			let horizontal = finite_i32(dx, "horizontal scroll delta")?;
			let vertical = finite_i32(dy, "vertical scroll delta")?;
			if horizontal != 0 {
				input
					.scroll(horizontal, Axis::Horizontal)
					.map_err(input_error)?;
			}
			if vertical != 0 {
				input
					.scroll(vertical, Axis::Vertical)
					.map_err(input_error)?;
			}
			Ok(())
		},
	}
}

fn global_chord(input: &mut Enigo, keys: &[KeyName]) -> CoreResult<()> {
	if keys.is_empty() {
		return Err(DesktopError::invalid_key("key chord must not be empty"));
	}
	if keys.len() == 1 {
		return input
			.key(keys[0].to_enigo(), Direction::Click)
			.map_err(input_error);
	}
	let mut pressed = Vec::with_capacity(keys.len());
	for &key in keys {
		if let Err(error) = input.key(key.to_enigo(), Direction::Press) {
			for &held in pressed.iter().rev() {
				let _ = input.key(held, Direction::Release);
			}
			return Err(input_error(error));
		}
		pressed.push(key.to_enigo());
	}
	let mut first_error = None;
	for key in pressed.into_iter().rev() {
		if let Err(error) = input.key(key, Direction::Release)
			&& first_error.is_none()
		{
			first_error = Some(input_error(error));
		}
	}
	first_error.map_or(Ok(()), Err)
}

fn with_global_modifiers(
	input: &mut Enigo,
	modifiers: Modifiers,
	action: impl FnOnce(&mut Enigo) -> CoreResult<()>,
) -> CoreResult<()> {
	let requested = [
		(modifiers.ctrl, KeyName::Ctrl),
		(modifiers.alt, KeyName::Alt),
		(modifiers.shift, KeyName::Shift),
		(modifiers.meta, KeyName::Meta),
	];
	let mut pressed = Vec::new();
	for (_, key) in requested.into_iter().filter(|(enabled, _)| *enabled) {
		let key = key.to_enigo();
		if let Err(error) = input.key(key, Direction::Press) {
			for &held in pressed.iter().rev() {
				let _ = input.key(held, Direction::Release);
			}
			return Err(input_error(error));
		}
		pressed.push(key);
	}
	let result = action(input);
	let mut release = Ok(());
	for key in pressed.into_iter().rev() {
		if let Err(error) = input.key(key, Direction::Release)
			&& release.is_ok()
		{
			release = Err(input_error(error));
		}
	}
	result.and(release)
}

fn move_global(input: &mut Enigo, x: f64, y: f64) -> CoreResult<()> {
	input
		.move_mouse(finite_i32(x, "x coordinate")?, finite_i32(y, "y coordinate")?, Coordinate::Abs)
		.map_err(input_error)
}

fn finite_i32(value: f64, name: &str) -> CoreResult<i32> {
	if !value.is_finite() || value < f64::from(i32::MIN) || value > f64::from(i32::MAX) {
		return Err(DesktopError::input_failed(format!(
			"{name} {value} is outside the macOS input range"
		)));
	}
	Ok(value.round() as i32)
}

const fn enigo_button(button: MouseButton) -> Button {
	match button {
		MouseButton::Left => Button::Left,
		MouseButton::Right => Button::Right,
		MouseButton::Middle => Button::Middle,
	}
}

fn input_error(error: impl std::fmt::Display) -> DesktopError {
	DesktopError::input_failed(format!("native input failed: {error}"))
}
