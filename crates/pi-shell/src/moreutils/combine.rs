//! moreutils `combine` builtin: boolean operations on the lines of two files.
//!
//! `combine FILE1 OP FILE2` where OP (case-insensitive) is `and`, `not`, `or`,
//! or `xor`. `-` names scoped stdin; only one side may be `-`. Lines are raw
//! byte strings; membership comparison strips a trailing `\n`, so a final line
//! without a newline still matches, and is emitted as-is (no newline added).
//! Usage errors (wrong arg count, unknown OP, both sides stdin) exit 1, unlike
//! moreutils' `die()` exit 255.

use std::{
	collections::HashSet,
	ffi::{OsStr, OsString},
	fs::File,
	io::{BufRead, BufReader, Write},
};

use clap::{Arg, ArgAction, Command, value_parser};
use pi_uutils_ctx::format_usage;

const ARG_FILE1: &str = "file1";
const ARG_OP: &str = "op";
const ARG_FILE2: &str = "file2";

#[derive(Clone, Copy, PartialEq)]
enum Op {
	And,
	Not,
	Or,
	Xor,
}

enum Error {
	Cancelled,
	Msg(String),
}

impl From<String> for Error {
	fn from(msg: String) -> Self {
		Self::Msg(msg)
	}
}

/// Runs `combine` against invocation-scoped stdin/stdout/stderr and
/// shell-relative paths.
pub fn run(argv: Vec<OsString>) -> i32 {
	let matches = match command().try_get_matches_from(argv) {
		Ok(matches) => matches,
		Err(err) => {
			let rendered = err.to_string();
			if err.use_stderr() {
				let _ = write!(pi_uutils_ctx::stderr(), "{rendered}");
				return 1;
			}
			let _ = write!(pi_uutils_ctx::stdout(), "{rendered}");
			return err.exit_code();
		},
	};

	let file1 = matches
		.get_one::<OsString>(ARG_FILE1)
		.expect("required")
		.clone();
	let op = matches.get_one::<String>(ARG_OP).expect("required");
	let file2 = matches
		.get_one::<OsString>(ARG_FILE2)
		.expect("required")
		.clone();

	match execute(&file1, op, &file2) {
		Ok(()) => 0,
		Err(Error::Cancelled) => 130,
		Err(Error::Msg(message)) => {
			let _ = writeln!(pi_uutils_ctx::stderr(), "combine: {message}");
			1
		},
	}
}

fn command() -> Command {
	Command::new("combine")
		.version(concat!("combine (pi-shell) ", env!("CARGO_PKG_VERSION")))
		.about("Combine the lines of two files using boolean operations.")
		.override_usage(format_usage("combine FILE1 and|not|or|xor FILE2"))
		.disable_help_flag(true)
		.disable_version_flag(true)
		.arg(Arg::new("help").long("help").action(ArgAction::Help))
		.arg(
			Arg::new(ARG_FILE1)
				.value_name("FILE1")
				.required(true)
				.value_parser(value_parser!(OsString)),
		)
		.arg(Arg::new(ARG_OP).value_name("OP").required(true))
		.arg(
			Arg::new(ARG_FILE2)
				.value_name("FILE2")
				.required(true)
				.value_parser(value_parser!(OsString)),
		)
}

fn execute(file1: &OsStr, op: &str, file2: &OsStr) -> Result<(), Error> {
	let op = match op.to_ascii_lowercase().as_str() {
		"and" => Op::And,
		"not" => Op::Not,
		"or" => Op::Or,
		"xor" => Op::Xor,
		other => {
			return Err(Error::Msg(format!(
				"unknown operation '{other}' (expected and, not, or, xor)"
			)));
		},
	};
	let dash = OsStr::new("-");
	if file1 == dash && file2 == dash {
		return Err(Error::Msg("only one file can be stdin".into()));
	}

	// Open both up front so a missing FILE2 fails before stdin is consumed.
	let mut input1 = open_input(file1)?;
	let mut input2 = open_input(file2)?;
	let mut out = pi_uutils_ctx::stdout();

	match op {
		Op::And | Op::Not => {
			// Membership side must be fully loaded before streaming FILE1.
			let lines2 = read_lines(&mut input2, file2)?;
			let set2: HashSet<&[u8]> = lines2.iter().map(|line| key(line)).collect();
			let keep_member = op == Op::And;
			each_line(&mut input1, file1, |line| {
				if set2.contains(key(line)) == keep_member {
					write_line(&mut out, line)?;
				}
				Ok(())
			})?;
		},
		Op::Or => {
			each_line(&mut input1, file1, |line| write_line(&mut out, line))?;
			each_line(&mut input2, file2, |line| write_line(&mut out, line))?;
		},
		Op::Xor => {
			let lines1 = read_lines(&mut input1, file1)?;
			let lines2 = read_lines(&mut input2, file2)?;
			let set1: HashSet<&[u8]> = lines1.iter().map(|line| key(line)).collect();
			let set2: HashSet<&[u8]> = lines2.iter().map(|line| key(line)).collect();
			for line in &lines1 {
				if !set2.contains(key(line)) {
					write_line(&mut out, line)?;
				}
			}
			for line in &lines2 {
				if !set1.contains(key(line)) {
					write_line(&mut out, line)?;
				}
			}
		},
	}
	out.flush().map_err(|err| Error::Msg(err.to_string()))?;
	Ok(())
}

fn open_input(name: &OsStr) -> Result<Box<dyn BufRead>, Error> {
	if name == OsStr::new("-") {
		return Ok(Box::new(BufReader::new(pi_uutils_ctx::stdin())));
	}
	let path = pi_uutils_ctx::resolve(name);
	let file = File::open(path).map_err(|err| Error::Msg(input_error(name, &err.to_string())))?;
	Ok(Box::new(BufReader::new(file)))
}

/// Streams `reader` line by line (trailing `\n` retained when present),
/// polling for cancellation between lines.
fn each_line(
	reader: &mut dyn BufRead,
	name: &OsStr,
	mut f: impl FnMut(&[u8]) -> Result<(), Error>,
) -> Result<(), Error> {
	let mut line = Vec::new();
	loop {
		if pi_uutils_ctx::is_cancelled() {
			return Err(Error::Cancelled);
		}
		line.clear();
		let n = reader
			.read_until(b'\n', &mut line)
			.map_err(|err| Error::Msg(input_error(name, &err.to_string())))?;
		if n == 0 {
			return Ok(());
		}
		f(&line)?;
	}
}

fn read_lines(reader: &mut dyn BufRead, name: &OsStr) -> Result<Vec<Vec<u8>>, Error> {
	let mut lines = Vec::new();
	each_line(reader, name, |line| {
		lines.push(line.to_vec());
		Ok(())
	})?;
	Ok(lines)
}

/// Membership key: the line with any trailing newline stripped, so `foo`
/// (no newline) matches `foo\n`.
fn key(line: &[u8]) -> &[u8] {
	line.strip_suffix(b"\n").unwrap_or(line)
}

fn write_line(out: &mut impl Write, line: &[u8]) -> Result<(), Error> {
	out.write_all(line)
		.map_err(|err| Error::Msg(err.to_string()))
}

fn input_error(name: &OsStr, err: &str) -> String {
	format!("{}: {}", name.to_string_lossy(), err)
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

	fn run_in(cwd: PathBuf, stdin: &[u8], args: &[&str]) -> (i32, Vec<u8>, String) {
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
		let argv = std::iter::once("combine")
			.chain(args.iter().copied())
			.map(OsString::from)
			.collect();
		let code = pi_uutils_ctx::scope(io, || run(argv));
		let stdout = stdout.lock().clone();
		let stderr = String::from_utf8(stderr.lock().clone()).unwrap();
		(code, stdout, stderr)
	}

	fn tempdir() -> (tempfile::TempDir, PathBuf) {
		let dir = tempfile::tempdir().unwrap();
		let path = fs::canonicalize(dir.path()).unwrap();
		(dir, path)
	}

	fn fixture() -> (tempfile::TempDir, PathBuf) {
		let (dir, root) = tempdir();
		fs::write(root.join("one"), b"a\nb\na\nc\n").unwrap();
		fs::write(root.join("two"), b"a\nc\nd\n").unwrap();
		(dir, root)
	}

	#[test]
	fn and_keeps_file1_order_and_duplicates() {
		let (_dir, root) = fixture();
		let (code, stdout, stderr) = run_in(root, b"", &["one", "and", "two"]);
		assert_eq!((code, stdout.as_slice(), stderr.as_str()), (0, b"a\na\nc\n".as_slice(), ""));
	}

	#[test]
	fn not_removes_file2_members() {
		let (_dir, root) = fixture();
		let (code, stdout, stderr) = run_in(root, b"", &["one", "not", "two"]);
		assert_eq!((code, stdout.as_slice(), stderr.as_str()), (0, b"b\n".as_slice(), ""));
	}

	#[test]
	fn or_concatenates_both_files() {
		let (_dir, root) = fixture();
		let (code, stdout, stderr) = run_in(root, b"", &["one", "or", "two"]);
		assert_eq!(
			(code, stdout.as_slice(), stderr.as_str()),
			(0, b"a\nb\na\nc\na\nc\nd\n".as_slice(), "")
		);
	}

	#[test]
	fn xor_emits_exclusive_lines_from_both_sides() {
		let (_dir, root) = fixture();
		let (code, stdout, stderr) = run_in(root, b"", &["one", "XOR", "two"]);
		assert_eq!((code, stdout.as_slice(), stderr.as_str()), (0, b"b\nd\n".as_slice(), ""));
	}

	#[test]
	fn dash_reads_file1_from_stdin() {
		let (_dir, root) = fixture();
		let (code, stdout, stderr) = run_in(root, b"a\nb\na\nc\n", &["-", "and", "two"]);
		assert_eq!((code, stdout.as_slice(), stderr.as_str()), (0, b"a\na\nc\n".as_slice(), ""));
	}

	#[test]
	fn both_sides_stdin_is_rejected() {
		let (_dir, root) = tempdir();
		let (code, stdout, stderr) = run_in(root, b"", &["-", "and", "-"]);
		assert_eq!(code, 1);
		assert!(stdout.is_empty());
		assert_eq!(stderr, "combine: only one file can be stdin\n");
	}

	#[test]
	fn non_utf8_lines_survive_byte_exact() {
		let (_dir, root) = tempdir();
		fs::write(root.join("one"), b"\xff\xfe\n\x80ok\n").unwrap();
		fs::write(root.join("two"), b"\xff\xfe\n").unwrap();
		let (code, stdout, stderr) = run_in(root, b"", &["one", "and", "two"]);
		assert_eq!((code, stdout.as_slice(), stderr.as_str()), (0, b"\xff\xfe\n".as_slice(), ""));
	}

	#[test]
	fn missing_file_reports_error_exit_1() {
		let (_dir, root) = tempdir();
		fs::write(root.join("one"), b"a\n").unwrap();
		let (code, stdout, stderr) = run_in(root, b"", &["one", "and", "nope"]);
		assert_eq!(code, 1);
		assert!(stdout.is_empty());
		assert!(stderr.starts_with("combine: nope: "), "stderr: {stderr}");
	}

	#[test]
	fn unknown_op_is_usage_error_exit_1() {
		let (_dir, root) = fixture();
		let (code, stdout, stderr) = run_in(root, b"", &["one", "nand", "two"]);
		assert_eq!(code, 1);
		assert!(stdout.is_empty());
		assert_eq!(stderr, "combine: unknown operation 'nand' (expected and, not, or, xor)\n");
	}

	#[test]
	fn wrong_arg_count_is_usage_error_exit_1() {
		let (_dir, root) = tempdir();
		let (code, stdout, stderr) = run_in(root, b"", &["only-one"]);
		assert_eq!(code, 1);
		assert!(stdout.is_empty());
		assert!(stderr.contains("Usage"), "stderr: {stderr}");
	}

	#[test]
	fn last_line_without_newline_matches_and_is_emitted_as_is() {
		// `b` without a trailing newline still counts as a line, matches
		// `b\n` in the other file, and is emitted without adding a newline.
		let (_dir, root) = tempdir();
		fs::write(root.join("one"), b"a\nb").unwrap();
		fs::write(root.join("two"), b"b\n").unwrap();
		let (code, stdout, stderr) = run_in(root, b"", &["one", "and", "two"]);
		assert_eq!((code, stdout.as_slice(), stderr.as_str()), (0, b"b".as_slice(), ""));
	}
}
