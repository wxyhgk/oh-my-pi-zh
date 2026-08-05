//! Cross-platform microphone capture and streaming speaker playback.
//!
//! miniaudio owns platform device discovery, format conversion, channel mixing,
//! and resampling. The engine exposes one stable mono `f32` contract: the
//! N-API classes in pi-natives adapt it to TypeScript, and [`crate::live`]
//! shares [`PlaybackStream`] for remote-audio rendering.

use std::sync::{
	Arc,
	atomic::{AtomicBool, AtomicU32, Ordering},
};

use flume::TryRecvError;
use maudio::{
	audio::{performance::PerformanceProfile, sample_rate::SampleRate},
	backend::Backend,
	device::{
		Device,
		device_builder::{DeviceBuilder, DeviceBuilderOps},
	},
};
use tokio::sync::Notify;

use crate::VoiceResult;

const AUDIO_CHANNELS: u32 = 1;
// PulseAudio TCP playback stutters with a 20 ms target buffer; 50 ms absorbs
// transport jitter while preserving interactive latency.
#[cfg(target_os = "linux")]
const PLAYBACK_PERIOD_MS: u32 = 50;
#[cfg(not(target_os = "linux"))]
const PLAYBACK_PERIOD_MS: u32 = 20;
// miniaudio's PulseAudio backend reserves three periods. Android's OpenSL ES
// source emits 125 ms fragments, so Linux capture needs at least 150 ms queued.
#[cfg(target_os = "linux")]
const CAPTURE_PERIOD_MS: u32 = 50;
#[cfg(not(target_os = "linux"))]
const CAPTURE_PERIOD_MS: u32 = 20;
// PulseAudio can retain its default three periods after the producer closes.
// Wait for all of them before stopping the device so the tail reaches the sink.
#[cfg(target_os = "linux")]
const PLAYBACK_DRAIN_CALLBACKS: usize = 3;
#[cfg(not(target_os = "linux"))]
const PLAYBACK_DRAIN_CALLBACKS: usize = 2;

#[cfg(target_os = "macos")]
const AUDIO_BACKENDS: &[Backend] = &[Backend::CoreAudio];
#[cfg(target_os = "windows")]
const AUDIO_BACKENDS: &[Backend] = &[Backend::Wasapi];
#[cfg(target_os = "linux")]
const AUDIO_BACKENDS: &[Backend] = &[Backend::PulseAudio, Backend::Alsa, Backend::Jack];
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
const AUDIO_BACKENDS: &[Backend] = &[Backend::Sndio, Backend::Audio4, Backend::Oss];

/// Shared render-time state for one playback device: gain, drain, stop.
///
/// Held as an `Arc` by both the stream and its N-API wrapper so
/// [`PlaybackState::wait_for_drain`] can outlive the stream lock.
pub struct PlaybackState {
	gain_bits: AtomicU32,
	drained:   AtomicBool,
	stopped:   AtomicBool,
	notify:    Notify,
}

impl PlaybackState {
	fn new() -> Self {
		Self {
			gain_bits: AtomicU32::new(1.0f32.to_bits()),
			drained:   AtomicBool::new(false),
			stopped:   AtomicBool::new(false),
			notify:    Notify::new(),
		}
	}

	fn gain(&self) -> f32 {
		f32::from_bits(self.gain_bits.load(Ordering::Acquire))
	}

	fn set_gain(&self, gain: f32) {
		self.gain_bits.store(gain.to_bits(), Ordering::Release);
	}

	fn mark_drained(&self) {
		if !self.drained.swap(true, Ordering::AcqRel) {
			self.notify.notify_waiters();
		}
	}

	fn mark_stopped(&self) {
		self.stopped.store(true, Ordering::Release);
		self.notify.notify_waiters();
	}

	/// Resolve once every queued sample reached the speaker (or the stream
	/// stopped). Used by the N-API `AudioPlayback.end()` graceful-close path.
	pub async fn wait_for_drain(&self) {
		loop {
			let notified = self.notify.notified();
			if self.drained.load(Ordering::Acquire) || self.stopped.load(Ordering::Acquire) {
				return;
			}
			notified.await;
		}
	}
}

/// Producer endpoint for one native playback device. Cloned into the WebRTC
/// remote-audio decoder so it can feed the same speaker stream.
#[derive(Clone)]
pub struct PlaybackWriter {
	tx:    flume::Sender<Vec<f32>>,
	state: Arc<PlaybackState>,
}

impl PlaybackWriter {
	/// Queue mono floating-point samples without blocking the caller.
	pub fn write(&self, samples: &[f32]) -> VoiceResult<()> {
		if samples.is_empty() {
			return Ok(());
		}
		if self.state.stopped.load(Ordering::Acquire) || self.state.drained.load(Ordering::Acquire) {
			return Err("Native audio playback is closed".to_owned());
		}
		self
			.tx
			.send(samples.to_vec())
			.map_err(|_| "Native audio playback is closed".to_owned())
	}
}

/// Running mono playback stream shared by N-API playback and native WebRTC.
pub struct PlaybackStream {
	device: Option<Device<f32>>,
	writer: Option<PlaybackWriter>,
	state:  Arc<PlaybackState>,
}

impl PlaybackStream {
	/// Open and start the default speaker at the requested logical sample rate.
	pub fn start(sample_rate: u32) -> VoiceResult<Self> {
		let sample_rate = audio_sample_rate(sample_rate)?;
		let state = Arc::new(PlaybackState::new());
		let (tx, rx) = flume::unbounded::<Vec<f32>>();
		let callback_state = Arc::clone(&state);
		let mut current = Vec::new();
		let mut cursor = 0;
		let mut empty_callbacks = 0;
		let mut builder = DeviceBuilder::playback().f32();
		builder
			.sample_rate(sample_rate)
			.playback_channels(AUDIO_CHANNELS)
			.period_size_millis(PLAYBACK_PERIOD_MS)
			.performance_profile(PerformanceProfile::LowLatency)
			.backends(AUDIO_BACKENDS);
		let mut device = builder
			.with_callback(move |_device, output| {
				fill_playback(
					&rx,
					&mut current,
					&mut cursor,
					output,
					&callback_state,
					&mut empty_callbacks,
				);
			})
			.map_err(|error| format!("Failed to open the default speaker: {error}"))?;
		device
			.device_start()
			.map_err(|error| format!("Failed to start speaker playback: {error}"))?;

		Ok(Self {
			device: Some(device),
			writer: Some(PlaybackWriter { tx, state: Arc::clone(&state) }),
			state,
		})
	}

	/// Clone the producer endpoint used by the remote-audio decoder.
	pub fn writer(&self) -> VoiceResult<PlaybackWriter> {
		self
			.writer
			.clone()
			.ok_or_else(|| "Native audio playback is closed".to_owned())
	}

	/// Shared render-time state, cloned out so callers can await drain after
	/// releasing the stream lock.
	pub fn state(&self) -> Arc<PlaybackState> {
		Arc::clone(&self.state)
	}

	/// Close the producer side so the render callback can detect drain.
	pub fn finish_input(&mut self) {
		self.writer.take();
	}

	/// Scale audio at render time so gain changes affect already queued
	/// samples. Rejects non-finite gains; negative gains clamp to silence.
	pub fn set_gain(&self, gain: f32) -> VoiceResult<()> {
		if !gain.is_finite() {
			return Err("Audio playback gain must be finite".to_owned());
		}
		self.state.set_gain(gain.max(0.0));
		Ok(())
	}

	/// Stop playback immediately and release the default speaker.
	pub fn stop(&mut self) -> VoiceResult<()> {
		self.writer.take();
		self.state.mark_stopped();
		let Some(mut device) = self.device.take() else {
			return Ok(());
		};
		device
			.device_stop()
			.map_err(|error| format!("Failed to stop speaker playback: {error}"))
	}
}

impl Drop for PlaybackStream {
	fn drop(&mut self) {
		let _ = self.stop();
	}
}

fn audio_sample_rate(sample_rate: u32) -> VoiceResult<SampleRate> {
	SampleRate::try_from(sample_rate)
		.map_err(|error| format!("Unsupported audio sample rate {sample_rate}: {error}"))
}

fn fill_playback(
	rx: &flume::Receiver<Vec<f32>>,
	current: &mut Vec<f32>,
	cursor: &mut usize,
	output: &mut [f32],
	state: &PlaybackState,
	empty_callbacks: &mut usize,
) {
	output.fill(0.0);
	if state.stopped.load(Ordering::Acquire) {
		return;
	}

	let gain = state.gain();
	let mut output_offset = 0;
	while output_offset < output.len() {
		if *cursor == current.len() {
			match rx.try_recv() {
				Ok(next) => {
					*current = next;
					*cursor = 0;
					*empty_callbacks = 0;
				},
				Err(TryRecvError::Empty) => {
					*empty_callbacks = 0;
					break;
				},
				Err(TryRecvError::Disconnected) => {
					*empty_callbacks += 1;
					if *empty_callbacks >= PLAYBACK_DRAIN_CALLBACKS {
						state.mark_drained();
					}
					break;
				},
			}
		}

		let count = (current.len() - *cursor).min(output.len() - output_offset);
		let source = &current[*cursor..*cursor + count];
		let destination = &mut output[output_offset..output_offset + count];
		if gain == 1.0 {
			destination.copy_from_slice(source);
		} else {
			for (destination, source) in destination.iter_mut().zip(source) {
				*destination = *source * gain;
			}
		}
		*cursor += count;
		output_offset += count;
	}
}

/// Running default-microphone capture delivering low-latency mono `f32`
/// chunks to its callback. Wraps the miniaudio device so N-API callers never
/// see maudio types.
pub struct CaptureStream {
	device: Option<Device<f32>>,
}

impl CaptureStream {
	/// Open the default microphone at the requested sample rate. `on_audio`
	/// runs on the realtime audio thread — it must not block.
	pub fn start<C>(sample_rate: u32, mut on_audio: C) -> VoiceResult<Self>
	where
		C: FnMut(&[f32]) + Send + 'static,
	{
		let sample_rate = audio_sample_rate(sample_rate)?;
		let mut builder = DeviceBuilder::capture().f32();
		builder
			.sample_rate(sample_rate)
			.capture_channels(AUDIO_CHANNELS)
			.period_size_millis(CAPTURE_PERIOD_MS)
			.performance_profile(PerformanceProfile::LowLatency)
			.backends(AUDIO_BACKENDS);
		let mut device = builder
			.with_callback(move |_device, samples| {
				if !samples.is_empty() {
					on_audio(samples);
				}
			})
			.map_err(|error| format!("Failed to open the default microphone: {error}"))?;
		device
			.device_start()
			.map_err(|error| format!("Failed to start microphone capture: {error}"))?;
		Ok(Self { device: Some(device) })
	}

	/// Stop capture immediately and release the microphone.
	pub fn stop(&mut self) -> VoiceResult<()> {
		let Some(mut device) = self.device.take() else {
			return Ok(());
		};
		device
			.device_stop()
			.map_err(|error| format!("Failed to stop microphone capture: {error}"))
	}
}

impl Drop for CaptureStream {
	fn drop(&mut self) {
		let _ = self.stop();
	}
}

#[cfg(test)]
mod tests {
	use std::{
		env,
		mem::forget,
		sync::atomic::AtomicUsize,
		thread::sleep,
		time::{Duration, Instant},
	};

	use super::*;

	#[test]
	fn playback_preserves_chunk_order_and_applies_render_gain() {
		let state = PlaybackState::new();
		state.set_gain(0.5);
		let (tx, rx) = flume::unbounded();
		tx.send(vec![1.0, -1.0]).expect("receiver is live");
		tx.send(vec![0.5, -0.5]).expect("receiver is live");
		drop(tx);
		let mut current = Vec::new();
		let mut cursor = 0;
		let mut empty_callbacks = 0;
		let mut output = [9.0; 5];

		fill_playback(&rx, &mut current, &mut cursor, &mut output, &state, &mut empty_callbacks);

		assert_eq!(output, [0.5, -0.5, 0.25, -0.25, 0.0]);
		assert!(!state.drained.load(Ordering::Acquire));
		let mut silence = [1.0; 2];
		while empty_callbacks < PLAYBACK_DRAIN_CALLBACKS {
			silence.fill(1.0);
			fill_playback(&rx, &mut current, &mut cursor, &mut silence, &state, &mut empty_callbacks);
			assert_eq!(silence, [0.0, 0.0]);
			assert_eq!(
				state.drained.load(Ordering::Acquire),
				empty_callbacks >= PLAYBACK_DRAIN_CALLBACKS
			);
		}
	}

	#[test]
	fn opt_in_default_playback_initializes_and_stops() {
		if env::var_os("OMP_NATIVE_AUDIO_PLAYBACK_TEST").is_none() {
			return;
		}

		let mut stream = PlaybackStream::start(16_000).expect("default playback device starts");
		stream.stop().expect("default playback device stops");
	}

	#[test]
	fn opt_in_default_capture_receives_frames() {
		if env::var_os("OMP_NATIVE_AUDIO_CAPTURE_TEST").is_none() {
			return;
		}

		let callbacks = Arc::new(AtomicUsize::new(0));
		let callback_count = Arc::clone(&callbacks);
		let mut stream = CaptureStream::start(16_000, move |_samples| {
			callback_count.fetch_add(1, Ordering::Relaxed);
		})
		.expect("default capture device starts");

		let deadline = Instant::now() + Duration::from_secs(5);
		while callbacks.load(Ordering::Relaxed) == 0 && Instant::now() < deadline {
			sleep(Duration::from_millis(20));
		}
		if callbacks.load(Ordering::Relaxed) == 0 {
			forget(stream);
			panic!("capture device started but delivered no frames within five seconds");
		}
		stream.stop().expect("capture device stops");
	}
}
