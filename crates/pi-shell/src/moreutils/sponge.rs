//! Context-safe, in-process moreutils `sponge` implementation for the
//! embedded shell: soak up all of stdin, then write it to a file (or stdout).
//!
//! The defining contract is that the output file is not opened or truncated
//! until stdin has been consumed to EOF, so `foo file | sponge file` works.

use std::{
	ffi::{OsStr, OsString},
	fs::{self, File, OpenOptions},
	io::{self, Read, Write},
	path::{Path, PathBuf},
	sync::atomic::{AtomicU64, Ordering},
	time::{SystemTime, UNIX_EPOCH},
};

use clap::{Arg, ArgAction, Command};
use pi_uutils_ctx::format_usage;

const OPT_APPEND: &str = "append";
const ARG_FILE: &str = "file";
const CHUNK_SIZE: usize = 64 * 1024;

/// Runs `sponge` against invocation-scoped stdin/stdout/stderr and
/// shell-relative paths.
pub fn run(argv: Vec<OsString>) -> i32 {
	let matches = match command().try_get_matches_from(argv) {
		Ok(matches) => matches,
		Err(err) => {
			let code = err.exit_code();
			let rendered = err.to_string();
			if err.use_stderr() {
				let _ = write!(pi_uutils_ctx::stderr(), "{rendered}");
			} else {
				let _ = write!(pi_uutils_ctx::stdout(), "{rendered}");
			}
			return code;
		},
	};

	let buffer = match soak_stdin() {
		Ok(buffer) => buffer,
		Err(SoakError::Cancelled) => return 130,
		Err(SoakError::Io(err)) => {
			let _ = writeln!(pi_uutils_ctx::stderr(), "sponge: stdin: {err}");
			return 1;
		},
	};

	let Some(file) = matches.get_one::<OsString>(ARG_FILE) else {
		let mut out = pi_uutils_ctx::stdout();
		if let Err(err) = out.write_all(&buffer).and_then(|()| out.flush()) {
			let _ = writeln!(pi_uutils_ctx::stderr(), "sponge: stdout: {err}");
			return 1;
		}
		return 0;
	};

	let target = pi_uutils_ctx::resolve(file);
	let result = if matches.get_flag(OPT_APPEND) {
		append_to(&target, &buffer)
	} else {
		replace_atomically(&target, &buffer)
	};
	match result {
		Ok(()) => 0,
		Err(err) => {
			let _ = writeln!(pi_uutils_ctx::stderr(), "sponge: {}: {err}", file.to_string_lossy());
			1
		},
	}
}

fn command() -> Command {
	Command::new("sponge")
		.version(concat!("sponge (pi-shell) ", env!("CARGO_PKG_VERSION")))
		.about("Soak up all standard input, then write it to a file.")
		.override_usage(format_usage("sponge [-a] [FILE]"))
		.disable_help_flag(true)
		.disable_version_flag(true)
		.arg(
			Arg::new(OPT_APPEND)
				.short('a')
				.long(OPT_APPEND)
				.help("append the soaked input to the file instead of replacing it")
				.action(ArgAction::SetTrue),
		)
		.arg(Arg::new("help").long("help").action(ArgAction::Help))
		.arg(
			Arg::new("version")
				.long("version")
				.action(ArgAction::Version),
		)
		.arg(
			Arg::new(ARG_FILE)
				.value_name("FILE")
				.value_parser(clap::value_parser!(OsString)),
		)
}

enum SoakError {
	Cancelled,
	Io(io::Error),
}

/// Reads context stdin to EOF into memory, polling for cancellation between
/// chunks so an aborted pipeline never touches the output file.
fn soak_stdin() -> Result<Vec<u8>, SoakError> {
	let mut stdin = pi_uutils_ctx::stdin();
	let mut buffer = Vec::new();
	let mut chunk = vec![0u8; CHUNK_SIZE].into_boxed_slice();
	loop {
		if pi_uutils_ctx::is_cancelled() {
			return Err(SoakError::Cancelled);
		}
		match stdin.read(&mut chunk) {
			Ok(0) => return Ok(buffer),
			Ok(n) => buffer.extend_from_slice(&chunk[..n]),
			Err(err) if err.kind() == io::ErrorKind::Interrupted => {},
			Err(err) => return Err(SoakError::Io(err)),
		}
	}
}

fn append_to(target: &Path, buffer: &[u8]) -> io::Result<()> {
	let mut file = OpenOptions::new().append(true).create(true).open(target)?;
	file.write_all(buffer)?;
	file.flush()
}

/// Writes `buffer` to a fresh temporary file beside `target`, copies the
/// existing target's permissions onto it, then renames it over the target so
/// readers never observe a truncated file.
fn replace_atomically(target: &Path, buffer: &[u8]) -> io::Result<()> {
	let (temp_path, mut temp) = create_sibling_temp(target)?;
	let result = write_and_swap(target, &temp_path, &mut temp, buffer);
	if result.is_err() {
		let _ = fs::remove_file(&temp_path);
	}
	result
}

fn write_and_swap(
	target: &Path,
	temp_path: &Path,
	temp: &mut File,
	buffer: &[u8],
) -> io::Result<()> {
	temp.write_all(buffer)?;
	temp.flush()?;
	if let Ok(metadata) = fs::metadata(target) {
		fs::set_permissions(temp_path, metadata.permissions())?;
	}
	fs::rename(temp_path, target)
}

/// Creates a uniquely named `.<basename>.sponge.<random>` file next to
/// `target` with `create_new`, retrying on collision.
fn create_sibling_temp(target: &Path) -> io::Result<(PathBuf, File)> {
	static COUNTER: AtomicU64 = AtomicU64::new(0);
	let dir = target
		.parent()
		.filter(|p| !p.as_os_str().is_empty())
		.unwrap_or_else(|| Path::new("."));
	let base = target
		.file_name()
		.unwrap_or_else(|| OsStr::new("sponge"))
		.to_string_lossy();
	for _ in 0..32 {
		let nanos = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.map_or(0, |d| d.subsec_nanos() as u64);
		let tag = nanos
			.wrapping_mul(0x9e37_79b9_7f4a_7c15)
			.wrapping_add(COUNTER.fetch_add(1, Ordering::Relaxed))
			.wrapping_add(std::process::id() as u64);
		let path = dir.join(format!(".{base}.sponge.{tag:016x}"));
		match OpenOptions::new().write(true).create_new(true).open(&path) {
			Ok(file) => return Ok((path, file)),
			Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {},
			Err(err) => return Err(err),
		}
	}
	Err(io::Error::new(io::ErrorKind::AlreadyExists, "could not create temporary file"))
}

#[cfg(test)]
mod tests {
	use std::{
		collections::HashMap,
		ffi::OsString,
		fs,
		io::{Cursor, Write},
		path::PathBuf,
		sync::{Arc, atomic::AtomicBool},
	};

	use parking_lot::Mutex;
	use pi_uutils_ctx::ScopeIo;

	use super::run;

	#[derive(Clone)]
	struct SharedWriter(Arc<Mutex<Vec<u8>>>);

	impl Write for SharedWriter {
		fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
			self.0.lock().write(buf)
		}

		fn flush(&mut self) -> std::io::Result<()> {
			self.0.lock().flush()
		}
	}

	fn run_in(cwd: PathBuf, stdin: &[u8], args: &[&str]) -> (i32, String, String) {
		let stdout = Arc::new(Mutex::new(Vec::new()));
		let stderr = Arc::new(Mutex::new(Vec::new()));
		let io = ScopeIo {
			stdin: Box::new(Cursor::new(stdin.to_vec())),
			stdin_fd: None,
			stdin_is_search_input: false,
			stdout: Box::new(SharedWriter(Arc::clone(&stdout))),
			stderr: Box::new(SharedWriter(Arc::clone(&stderr))),
			cwd,
			env: HashMap::new(),
			cancel: Arc::new(AtomicBool::new(false)),
		};
		let argv = std::iter::once("sponge")
			.chain(args.iter().copied())
			.map(OsString::from)
			.collect();
		let code = pi_uutils_ctx::scope(io, || run(argv));
		let stdout = String::from_utf8(stdout.lock().clone()).unwrap();
		let stderr = String::from_utf8(stderr.lock().clone()).unwrap();
		(code, stdout, stderr)
	}

	fn tempdir() -> (tempfile::TempDir, PathBuf) {
		let dir = tempfile::tempdir().unwrap();
		let path = fs::canonicalize(dir.path()).unwrap();
		(dir, path)
	}

	#[test]
	fn stdin_written_to_file_exactly() {
		let (_dir, root) = tempdir();
		let (code, stdout, stderr) = run_in(root.clone(), b"hello\nsponge\n", &["out"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "", ""));
		assert_eq!(fs::read(root.join("out")).unwrap(), b"hello\nsponge\n");
	}

	#[test]
	fn append_flag_appends_to_existing_content() {
		let (_dir, root) = tempdir();
		fs::write(root.join("log"), b"first\n").unwrap();
		let (code, stdout, stderr) = run_in(root.clone(), b"second\n", &["-a", "log"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "", ""));
		assert_eq!(fs::read(root.join("log")).unwrap(), b"first\nsecond\n");
	}

	#[test]
	fn no_file_writes_stdin_to_stdout() {
		let (_dir, root) = tempdir();
		let (code, stdout, stderr) = run_in(root, b"passthrough", &[]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "passthrough", ""));
	}

	#[test]
	fn replaces_existing_target_and_leaves_no_temp_files() {
		let (_dir, root) = tempdir();
		fs::write(root.join("data"), b"old contents that are longer").unwrap();
		let (code, stdout, stderr) = run_in(root.clone(), b"new", &["data"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "", ""));
		assert_eq!(fs::read(root.join("data")).unwrap(), b"new");
		let leftovers: Vec<_> = fs::read_dir(&root)
			.unwrap()
			.map(|e| e.unwrap().file_name())
			.filter(|n| n != "data")
			.collect();
		assert_eq!(leftovers, Vec::<std::ffi::OsString>::new());
	}

	#[cfg(unix)]
	#[test]
	fn permissions_preserved_on_replace() {
		use std::os::unix::fs::PermissionsExt;

		let (_dir, root) = tempdir();
		let target = root.join("secret");
		fs::write(&target, b"old").unwrap();
		fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();

		let (code, _, stderr) = run_in(root, b"new", &["secret"]);
		assert_eq!((code, stderr.as_str()), (0, ""));
		assert_eq!(fs::metadata(&target).unwrap().permissions().mode() & 0o7777, 0o600);
	}

	#[test]
	fn missing_target_directory_reports_error() {
		let (_dir, root) = tempdir();
		let (code, stdout, stderr) = run_in(root, b"bytes", &["nodir/out"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert!(stderr.starts_with("sponge: nodir/out: "), "stderr: {stderr}");
	}
}
