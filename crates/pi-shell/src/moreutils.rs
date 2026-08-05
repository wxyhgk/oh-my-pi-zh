//! In-process implementations of selected moreutils tools.
//!
//! Each module follows the same contract as [`crate::cmp`]: a
//! `pub fn run(argv: Vec<OsString>) -> i32` entry point that performs all I/O
//! through [`pi_uutils_ctx`] (scoped stdin/stdout/stderr, shell-relative path
//! resolution, cancellation), registered as a shell builtin via the
//! `uutil_builtin!` macro in [`crate::coreutils`].

pub mod combine;
#[cfg(unix)]
pub mod errno;
pub mod ifne;
pub mod isutf8;
pub mod sponge;
pub mod ts;
