use std::mem::{align_of, size_of};

use maudio::maudio_sys::ffi::{ma_context, ma_device, ma_mutex};

unsafe extern "C" {
	fn omp_maudio_sizeof_mutex() -> usize;
	fn omp_maudio_alignof_mutex() -> usize;
	fn omp_maudio_sizeof_context() -> usize;
	fn omp_maudio_alignof_context() -> usize;
	fn omp_maudio_sizeof_device() -> usize;
	fn omp_maudio_alignof_device() -> usize;
}

fn c_layout(
	size: unsafe extern "C" fn() -> usize,
	align: unsafe extern "C" fn() -> usize,
) -> (usize, usize) {
	// SAFETY: The patched maudio-sys C object defines both argument-free probes.
	unsafe { (size(), align()) }
}

#[test]
fn rust_bindings_match_compiled_miniaudio_layouts() {
	assert_eq!(
		(size_of::<ma_mutex>(), align_of::<ma_mutex>()),
		c_layout(omp_maudio_sizeof_mutex, omp_maudio_alignof_mutex),
		"ma_mutex Rust/C layout mismatch",
	);
	assert_eq!(
		(size_of::<ma_context>(), align_of::<ma_context>()),
		c_layout(omp_maudio_sizeof_context, omp_maudio_alignof_context),
		"ma_context Rust/C layout mismatch",
	);
	assert_eq!(
		(size_of::<ma_device>(), align_of::<ma_device>()),
		c_layout(omp_maudio_sizeof_device, omp_maudio_alignof_device),
		"ma_device Rust/C layout mismatch",
	);
}
