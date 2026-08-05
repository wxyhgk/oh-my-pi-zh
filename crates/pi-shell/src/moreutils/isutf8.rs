//! moreutils `isutf8` builtin: check whether files (or stdin) are valid UTF-8.
//!
//! Diagnostic coordinates follow moreutils semantics: `line` is 1-based
//! (counting `\n`), `char` is the 1-based character position within that line,
//! and `byte` is the 0-based file offset of the first byte of the invalid
//! sequence. Input is streamed in 64 KiB chunks; a multi-byte sequence split
//! across a chunk boundary carries its incomplete tail (at most 3 bytes) into
//! the next chunk, and an incomplete tail at EOF counts as invalid.
//!
//! Stdin (no file arguments, or the argument `-`) is reported as
//! `(standard input)`. With `--invert` the exit status and `--list` output
//! treat valid files as failures; the default diagnostic is still printed for
//! invalid files. Exit codes: 0 = every file passes the (possibly inverted)
//! predicate, 1 = at least one file fails it, 2 = an I/O error opening or
//! reading a file (reported on stderr; remaining files are still checked).

use std::{
	ffi::{OsStr, OsString},
	fs::File,
	io::{self, Read, Write},
};

use clap::{Arg, ArgAction, Command};
use pi_uutils_ctx::format_usage;

const OPT_QUIET: &str = "quiet";
const OPT_LIST: &str = "list";
const OPT_INVERT: &str = "invert";
const ARG_FILES: &str = "files";
const CHUNK_SIZE: usize = 64 * 1024;

enum Verdict {
	Valid,
	Invalid { line: u64, character: u64, byte: u64 },
	Cancelled,
}

/// Runs `isutf8` against invocation-scoped stdin/stdout/stderr and
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

	let quiet = matches.get_flag(OPT_QUIET);
	let list = matches.get_flag(OPT_LIST);
	let invert = matches.get_flag(OPT_INVERT);
	let files: Vec<OsString> = matches
		.get_many::<OsString>(ARG_FILES)
		.map_or_else(|| vec![OsString::from("-")], |values| values.cloned().collect());

	let mut any_failed = false;
	let mut io_error = false;
	for file in &files {
		let display = display_name(file);
		let valid = match validate_file(file) {
			Err(err) => {
				let _ = writeln!(pi_uutils_ctx::stderr(), "isutf8: {display}: {err}");
				io_error = true;
				continue;
			},
			Ok(Verdict::Cancelled) => return 130,
			Ok(Verdict::Valid) => true,
			Ok(Verdict::Invalid { line, character, byte }) => {
				if !quiet && !list {
					let _ = writeln!(
						pi_uutils_ctx::stdout(),
						"{display}: line {line}, char {character}, byte {byte}: invalid UTF-8 code"
					);
				}
				false
			},
		};
		// A file fails when its validity matches the inversion flag.
		if valid == invert {
			any_failed = true;
			if list && !quiet {
				let _ = writeln!(pi_uutils_ctx::stdout(), "{display}");
			}
		}
	}

	if io_error { 2 } else { i32::from(any_failed) }
}

fn command() -> Command {
	Command::new("isutf8")
		.version(concat!("isutf8 (pi-shell) ", env!("CARGO_PKG_VERSION")))
		.about("Check whether files are valid UTF-8.")
		.override_usage(format_usage("isutf8 [-q|--quiet] [-l|--list] [-i|--invert] [FILE]..."))
		.disable_help_flag(true)
		.disable_version_flag(true)
		.infer_long_args(true)
		.arg(
			Arg::new(OPT_QUIET)
				.short('q')
				.long(OPT_QUIET)
				.help("suppress all output; report via exit status only")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_LIST)
				.short('l')
				.long(OPT_LIST)
				.help("print only the names of files failing the check")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_INVERT)
				.short('i')
				.long(OPT_INVERT)
				.help("invert the check: valid files fail")
				.action(ArgAction::SetTrue),
		)
		.arg(Arg::new("help").long("help").action(ArgAction::Help))
		.arg(
			Arg::new(ARG_FILES)
				.value_name("FILE")
				.num_args(0..)
				.value_parser(clap::value_parser!(OsString)),
		)
}

fn validate_file(name: &OsStr) -> io::Result<Verdict> {
	if name == "-" {
		validate(&mut pi_uutils_ctx::stdin())
	} else {
		let mut file = File::open(pi_uutils_ctx::resolve(name))?;
		validate(&mut file)
	}
}

/// Streams `input` in [`CHUNK_SIZE`] chunks, carrying an incomplete multi-byte
/// tail (≤ 3 bytes) across chunk boundaries.
fn validate(input: &mut impl Read) -> io::Result<Verdict> {
	let mut buf = vec![0u8; CHUNK_SIZE + 3];
	let mut carry = 0usize; // bytes at buf[..carry] carried from the previous chunk
	let mut offset = 0u64; // file offset of buf[0]
	let mut line = 1u64;
	let mut chars_in_line = 0u64; // complete chars decoded on the current line

	loop {
		if pi_uutils_ctx::is_cancelled() {
			return Ok(Verdict::Cancelled);
		}
		let read = input.read(&mut buf[carry..carry + CHUNK_SIZE])?;
		let eof = read == 0;
		let data_len = carry + read;
		if data_len == 0 {
			return Ok(Verdict::Valid);
		}

		let mut pos = 0usize;
		while pos < data_len {
			match std::str::from_utf8(&buf[pos..data_len]) {
				Ok(_) => {
					advance(&buf[pos..data_len], &mut line, &mut chars_in_line);
					pos = data_len;
				},
				Err(err) => {
					advance(&buf[pos..pos + err.valid_up_to()], &mut line, &mut chars_in_line);
					pos += err.valid_up_to();
					if err.error_len().is_some() || eof {
						// Bad sequence, or an incomplete one truncated by EOF.
						return Ok(Verdict::Invalid {
							line,
							character: chars_in_line + 1,
							byte: offset + pos as u64,
						});
					}
					break; // incomplete tail: carry it into the next chunk
				},
			}
		}
		if eof {
			return Ok(Verdict::Valid);
		}
		// Slide the unconsumed tail (≤ 3 bytes) to the front of the buffer.
		buf.copy_within(pos..data_len, 0);
		carry = data_len - pos;
		offset += pos as u64;
	}
}

/// Updates line/char counters over `text`, a slice already known to be valid
/// UTF-8 (chars are counted as non-continuation bytes, so no re-decode).
fn advance(text: &[u8], line: &mut u64, chars_in_line: &mut u64) {
	match memchr::memrchr(b'\n', text) {
		Some(last) => {
			*line += memchr::memchr_iter(b'\n', text).count() as u64;
			*chars_in_line = count_chars(&text[last + 1..]);
		},
		None => *chars_in_line += count_chars(text),
	}
}

fn count_chars(bytes: &[u8]) -> u64 {
	bytes.iter().filter(|&&b| (b & 0xc0) != 0x80).count() as u64
}

fn display_name(name: &OsStr) -> String {
	if name == "-" {
		"(standard input)".to_owned()
	} else {
		name.to_string_lossy().into_owned()
	}
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
		let argv = std::iter::once("isutf8")
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
	fn valid_ascii_and_multibyte_pass_silently() {
		let (_dir, root) = tempdir();
		fs::write(root.join("ok"), "hello é 🎉\nplain ascii\n").unwrap();

		assert_eq!(run_in(root, b"", &["ok"]), (0, String::new(), String::new()));
	}

	#[test]
	fn invalid_sequence_reports_line_char_and_byte() {
		let (_dir, root) = tempdir();
		fs::write(root.join("bad"), b"ab\xC3(\n").unwrap();
		fs::write(root.join("late"), b"a\nb\n\xFF").unwrap();

		let (code, stdout, stderr) = run_in(root.clone(), b"", &["bad"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "bad: line 1, char 3, byte 2: invalid UTF-8 code\n");
		assert_eq!(stderr, "");

		let (code, stdout, _) = run_in(root, b"", &["late"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "late: line 3, char 1, byte 4: invalid UTF-8 code\n");
	}

	#[test]
	fn multibyte_sequence_straddling_chunk_boundary_is_valid() {
		let (_dir, root) = tempdir();
		let mut bytes = vec![b'a'; 65535];
		bytes.extend_from_slice("é".as_bytes()); // 0xC3 at offset 65535, 0xA9 at 65536
		fs::write(root.join("straddle"), &bytes).unwrap();

		assert_eq!(run_in(root, b"", &["straddle"]), (0, String::new(), String::new()));
	}

	#[test]
	fn truncated_sequence_at_chunk_boundary_is_invalid() {
		let (_dir, root) = tempdir();
		let mut bytes = vec![b'a'; 65535];
		bytes.push(0xc3); // incomplete at the exact chunk boundary
		bytes.extend_from_slice(b"zzz");
		fs::write(root.join("cut"), &bytes).unwrap();

		let (code, stdout, stderr) = run_in(root, b"", &["cut"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "cut: line 1, char 65536, byte 65535: invalid UTF-8 code\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn truncated_multibyte_at_eof_is_invalid() {
		let (_dir, root) = tempdir();
		fs::write(root.join("eof"), b"abc\xE2\x82").unwrap();

		let (code, stdout, _) = run_in(root, b"", &["eof"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "eof: line 1, char 4, byte 3: invalid UTF-8 code\n");
	}

	#[test]
	fn quiet_suppresses_output_but_keeps_status() {
		let (_dir, root) = tempdir();
		fs::write(root.join("bad"), b"\xFF").unwrap();

		assert_eq!(run_in(root, b"", &["-q", "bad"]), (1, String::new(), String::new()));
	}

	#[test]
	fn list_prints_failing_names_and_invert_flips_them() {
		let (_dir, root) = tempdir();
		fs::write(root.join("good"), "fine\n").unwrap();
		fs::write(root.join("bad"), b"\xFF\n").unwrap();

		let (code, stdout, stderr) = run_in(root.clone(), b"", &["-l", "good", "bad"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (1, "bad\n", ""));

		let (code, stdout, stderr) = run_in(root, b"", &["-l", "-i", "good", "bad"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (1, "good\n", ""));
	}

	#[test]
	fn invert_flips_exit_status_without_list() {
		let (_dir, root) = tempdir();
		fs::write(root.join("good"), "fine\n").unwrap();
		fs::write(root.join("bad"), b"\xFF").unwrap();

		assert_eq!(run_in(root.clone(), b"", &["-q", "-i", "good"]).0, 1);
		assert_eq!(run_in(root, b"", &["-q", "-i", "bad"]).0, 0);
	}

	#[test]
	fn stdin_is_validated_when_no_files_given() {
		let (_dir, root) = tempdir();

		assert_eq!(
			run_in(root.clone(), "héllo\n".as_bytes(), &[]),
			(0, String::new(), String::new())
		);

		let (code, stdout, _) = run_in(root, b"h\xFFi", &[]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "(standard input): line 1, char 2, byte 1: invalid UTF-8 code\n");
	}

	#[test]
	fn missing_file_reports_io_error_and_continues() {
		let (_dir, root) = tempdir();
		fs::write(root.join("bad"), b"\xFF").unwrap();

		let (code, stdout, stderr) = run_in(root, b"", &["nope", "bad"]);
		assert_eq!(code, 2);
		assert_eq!(stdout, "bad: line 1, char 1, byte 0: invalid UTF-8 code\n");
		assert!(stderr.starts_with("isutf8: nope: "), "stderr: {stderr}");
	}
}
