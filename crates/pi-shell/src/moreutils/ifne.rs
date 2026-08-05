//! moreutils `ifne` builtin: run a command iff stdin is non-empty (`-n`
//! inverts). The command is argv exec'd directly — no shell interpretation.

use std::{
	ffi::OsString,
	io::{ErrorKind, Read, Write},
	process::{Command, Stdio},
};

const USAGE: &str = "usage: ifne [-n] command [args...]";
const CHUNK: usize = 64 * 1024;

/// Runs `ifne` against invocation-scoped stdin/stdout/stderr; spawns the
/// command with the scope's cwd and exported environment.
///
/// Argument parsing is manual rather than clap: everything after the optional
/// leading `-n` is the child argv verbatim, and clap's hyphen pass-through
/// rules would only complicate `ifne grep -q foo`.
pub fn run(argv: Vec<OsString>) -> i32 {
	let mut args = argv.into_iter().skip(1).peekable();
	let mut invert = false;
	match args
		.peek()
		.map(|a| a.to_string_lossy().into_owned())
		.as_deref()
	{
		Some("-n") => {
			invert = true;
			args.next();
		},
		Some("--help") => {
			let _ = writeln!(pi_uutils_ctx::stdout(), "{USAGE}");
			return 0;
		},
		_ => {},
	}
	let command: Vec<OsString> = args.collect();
	if command.is_empty() {
		let _ = writeln!(pi_uutils_ctx::stderr(), "{USAGE}");
		return 1;
	}

	// Probe stdin: one byte decides which mode acts.
	let mut stdin = pi_uutils_ctx::stdin();
	let mut first = [0u8; 1];
	let got = loop {
		match stdin.read(&mut first) {
			Ok(n) => break n,
			Err(err) if err.kind() == ErrorKind::Interrupted => {
				if pi_uutils_ctx::is_cancelled() {
					return 130;
				}
			},
			Err(err) => {
				let _ = writeln!(pi_uutils_ctx::stderr(), "ifne: stdin: {err}");
				return 1;
			},
		}
	};
	let empty = got == 0;

	if empty != invert {
		if empty {
			// Default mode, empty stdin: do nothing.
			return 0;
		}
		// -n mode, non-empty stdin: pass stdin through, don't run the command.
		return match copy_cancellable(&mut stdin, &mut pi_uutils_ctx::stdout(), Some(first[0])) {
			Ok(()) => 0,
			Err(CopyError::Cancelled) => 130,
			Err(CopyError::Io(err)) => {
				let _ = writeln!(pi_uutils_ctx::stderr(), "ifne: {err}");
				1
			},
		};
	}

	spawn_and_pump(&command, if empty { None } else { Some(first[0]) }, &mut stdin)
}

/// Spawns the child and pumps stdin into it while draining its stdout/stderr;
/// returns the child's exit code (128+signal when signaled, 127 on spawn
/// failure, 130 on cancel).
fn spawn_and_pump(command: &[OsString], first: Option<u8>, stdin: &mut impl Read) -> i32 {
	let mut child = match Command::new(&command[0])
		.args(&command[1..])
		.current_dir(pi_uutils_ctx::cwd())
		.env_clear()
		.envs(pi_uutils_ctx::env_snapshot())
		.stdin(Stdio::piped())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.spawn()
	{
		Ok(child) => child,
		Err(err) => {
			let _ = writeln!(pi_uutils_ctx::stderr(), "ifne: {}: {err}", command[0].to_string_lossy());
			return 127;
		},
	};

	let mut child_stdin = child.stdin.take().expect("piped stdin");
	let mut child_stdout = child.stdout.take().expect("piped stdout");
	let mut child_stderr = child.stderr.take().expect("piped stderr");

	// The ctx streams are thread-local, so the drain threads collect into
	// buffers that this (scoped) thread flushes to ctx stdout/stderr after
	// the child exits.
	let (out_buf, err_buf, pump) = std::thread::scope(|s| {
		let out = s.spawn(move || {
			let mut buf = Vec::new();
			let _ = child_stdout.read_to_end(&mut buf);
			buf
		});
		let err = s.spawn(move || {
			let mut buf = Vec::new();
			let _ = child_stderr.read_to_end(&mut buf);
			buf
		});
		// Ignore BrokenPipe: the child may exit before consuming its stdin
		// (e.g. `ifne head -1`).
		let pump = match copy_cancellable(stdin, &mut child_stdin, first) {
			Err(CopyError::Io(err)) if err.kind() != ErrorKind::BrokenPipe => Err(CopyError::Io(err)),
			Err(CopyError::Cancelled) => Err(CopyError::Cancelled),
			_ => Ok(()),
		};
		drop(child_stdin); // EOF so the child terminates.
		if matches!(pump, Err(CopyError::Cancelled)) {
			let _ = child.kill();
		}
		(out.join().unwrap_or_default(), err.join().unwrap_or_default(), pump)
	});

	let status = child.wait();
	let _ = pi_uutils_ctx::stdout().write_all(&out_buf);
	let _ = pi_uutils_ctx::stderr().write_all(&err_buf);

	match pump {
		Err(CopyError::Cancelled) => return 130,
		Err(CopyError::Io(err)) => {
			let _ = writeln!(pi_uutils_ctx::stderr(), "ifne: {err}");
			return 1;
		},
		Ok(()) => {},
	}

	match status {
		Ok(status) => exit_code(status),
		Err(err) => {
			let _ = writeln!(pi_uutils_ctx::stderr(), "ifne: {err}");
			1
		},
	}
}

enum CopyError {
	Cancelled,
	Io(std::io::Error),
}

/// Copies `first` (when present) then all of `src` into `dst` in chunks,
/// polling the scope's cancel flag between reads.
fn copy_cancellable(
	src: &mut impl Read,
	dst: &mut impl Write,
	first: Option<u8>,
) -> Result<(), CopyError> {
	if let Some(byte) = first {
		dst.write_all(&[byte]).map_err(CopyError::Io)?;
	}
	let mut buf = vec![0u8; CHUNK].into_boxed_slice();
	loop {
		if pi_uutils_ctx::is_cancelled() {
			return Err(CopyError::Cancelled);
		}
		match src.read(&mut buf) {
			Ok(0) => return Ok(()),
			Ok(n) => dst.write_all(&buf[..n]).map_err(CopyError::Io)?,
			Err(err) if err.kind() == ErrorKind::Interrupted => {},
			Err(err) => return Err(CopyError::Io(err)),
		}
	}
}

/// Maps a child exit status to `ifne`'s exit code: the child's code, or
/// 128+signal on unix when the child was signaled.
fn exit_code(status: std::process::ExitStatus) -> i32 {
	if let Some(code) = status.code() {
		return code;
	}
	#[cfg(unix)]
	{
		use std::os::unix::process::ExitStatusExt;
		if let Some(sig) = status.signal() {
			return 128 + sig;
		}
	}
	1
}

#[cfg(test)]
mod tests {
	use std::{
		collections::HashMap,
		ffi::OsString,
		io::{Cursor, Write},
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

	fn run_in(stdin: &[u8], args: &[&str]) -> (i32, String, String) {
		let stdout = Arc::new(Mutex::new(Vec::new()));
		let stderr = Arc::new(Mutex::new(Vec::new()));
		let io = ScopeIo {
			stdin:                 Box::new(Cursor::new(stdin.to_vec())),
			stdin_fd:              None,
			stdin_is_search_input: false,
			stdout:                Box::new(SharedWriter(Arc::clone(&stdout))),
			stderr:                Box::new(SharedWriter(Arc::clone(&stderr))),
			cwd:                   std::env::temp_dir(),
			env:                   HashMap::from([("PATH".to_string(), "/usr/bin:/bin".to_string())]),
			cancel:                Arc::new(AtomicBool::new(false)),
		};
		let argv = std::iter::once("ifne")
			.chain(args.iter().copied())
			.map(OsString::from)
			.collect();
		let code = pi_uutils_ctx::scope(io, || run(argv));
		let stdout = String::from_utf8(stdout.lock().clone()).unwrap();
		let stderr = String::from_utf8(stderr.lock().clone()).unwrap();
		(code, stdout, stderr)
	}

	#[cfg(unix)]
	#[test]
	fn nonempty_stdin_runs_command_with_stdin() {
		let (code, stdout, stderr) = run_in(b"hello world\n", &["cat"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "hello world\n", ""));
	}

	#[cfg(unix)]
	#[test]
	fn empty_stdin_skips_command() {
		let (code, stdout, stderr) = run_in(b"", &["sh", "-c", "echo ran"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "", ""));
	}

	#[cfg(unix)]
	#[test]
	fn invert_runs_command_on_empty_stdin() {
		let (code, stdout, stderr) = run_in(b"", &["-n", "sh", "-c", "echo ran"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "ran\n", ""));
	}

	#[cfg(unix)]
	#[test]
	fn invert_passes_nonempty_stdin_through() {
		let (code, stdout, stderr) = run_in(b"data\n", &["-n", "sh", "-c", "echo ran"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "data\n", ""));
	}

	#[cfg(unix)]
	#[test]
	fn child_exit_code_propagates() {
		let (code, stdout, stderr) = run_in(b"x", &["sh", "-c", "exit 3"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (3, "", ""));
	}

	#[test]
	fn unknown_command_exits_127() {
		let (code, stdout, stderr) = run_in(b"x", &["definitely-not-a-command-xyz"]);
		assert_eq!(code, 127);
		assert_eq!(stdout, "");
		assert!(stderr.starts_with("ifne: definitely-not-a-command-xyz: "), "stderr: {stderr}");
	}

	#[cfg(unix)]
	#[test]
	fn early_exiting_child_is_not_an_error() {
		let big = vec![b'a'; 1 << 20];
		let (code, stdout, stderr) = run_in(&big, &["head", "-c", "1"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "a", ""));
	}

	#[test]
	fn missing_command_is_usage_error() {
		let (code, stdout, stderr) = run_in(b"", &[]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert!(stderr.contains("usage: ifne"));
	}
}
