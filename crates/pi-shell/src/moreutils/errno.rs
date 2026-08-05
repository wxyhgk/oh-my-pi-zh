//! moreutils `errno` builtin: look up errno names, numbers, and descriptions.
//!
//! Lookup semantics: a name argument prints its `NAME NUMBER Description`
//! line; an unknown name reports `errno: unknown errno NAME` on stderr and
//! exits 1. A numeric argument reverse-maps to the first-listed (canonical)
//! name; an unknown number prints nothing and exits 1. With multiple
//! arguments each is processed and the exit code is 1 if any lookup failed.
//! `--list` prints every table entry (aliases included) sorted by number
//! then name; `--search` prints entries whose description contains all the
//! given words case-insensitively.

use std::{ffi::OsString, io::Write};

use clap::{Arg, ArgAction, Command};
use pi_uutils_ctx::format_usage;

const OPT_LIST: &str = "list";
const OPT_SEARCH: &str = "search";
const ARG_QUERY: &str = "query";

/// Errno NAME -> number table. Duplicate numbers are allowed (aliases such
/// as `EWOULDBLOCK`); the first-listed name for a number is canonical for
/// reverse lookup.
const ERRNOS: &[(&str, i32)] = &[
	("EPERM", libc::EPERM),
	("ENOENT", libc::ENOENT),
	("ESRCH", libc::ESRCH),
	("EINTR", libc::EINTR),
	("EIO", libc::EIO),
	("ENXIO", libc::ENXIO),
	("E2BIG", libc::E2BIG),
	("ENOEXEC", libc::ENOEXEC),
	("EBADF", libc::EBADF),
	("ECHILD", libc::ECHILD),
	("EAGAIN", libc::EAGAIN),
	("ENOMEM", libc::ENOMEM),
	("EACCES", libc::EACCES),
	("EFAULT", libc::EFAULT),
	("ENOTBLK", libc::ENOTBLK),
	("EBUSY", libc::EBUSY),
	("EEXIST", libc::EEXIST),
	("EXDEV", libc::EXDEV),
	("ENODEV", libc::ENODEV),
	("ENOTDIR", libc::ENOTDIR),
	("EISDIR", libc::EISDIR),
	("EINVAL", libc::EINVAL),
	("ENFILE", libc::ENFILE),
	("EMFILE", libc::EMFILE),
	("ENOTTY", libc::ENOTTY),
	("ETXTBSY", libc::ETXTBSY),
	("EFBIG", libc::EFBIG),
	("ENOSPC", libc::ENOSPC),
	("ESPIPE", libc::ESPIPE),
	("EROFS", libc::EROFS),
	("EMLINK", libc::EMLINK),
	("EPIPE", libc::EPIPE),
	("EDOM", libc::EDOM),
	("ERANGE", libc::ERANGE),
	("EDEADLK", libc::EDEADLK),
	("ENAMETOOLONG", libc::ENAMETOOLONG),
	("ENOLCK", libc::ENOLCK),
	("ENOSYS", libc::ENOSYS),
	("ENOTEMPTY", libc::ENOTEMPTY),
	("ELOOP", libc::ELOOP),
	("ENOMSG", libc::ENOMSG),
	("EIDRM", libc::EIDRM),
	("EPROTO", libc::EPROTO),
	("EBADMSG", libc::EBADMSG),
	("EOVERFLOW", libc::EOVERFLOW),
	("EILSEQ", libc::EILSEQ),
	("ENOTSOCK", libc::ENOTSOCK),
	("EDESTADDRREQ", libc::EDESTADDRREQ),
	("EMSGSIZE", libc::EMSGSIZE),
	("EPROTOTYPE", libc::EPROTOTYPE),
	("ENOPROTOOPT", libc::ENOPROTOOPT),
	("EPROTONOSUPPORT", libc::EPROTONOSUPPORT),
	("ESOCKTNOSUPPORT", libc::ESOCKTNOSUPPORT),
	("ENOTSUP", libc::ENOTSUP),
	("EOPNOTSUPP", libc::EOPNOTSUPP),
	("EPFNOSUPPORT", libc::EPFNOSUPPORT),
	("EAFNOSUPPORT", libc::EAFNOSUPPORT),
	("EADDRINUSE", libc::EADDRINUSE),
	("EADDRNOTAVAIL", libc::EADDRNOTAVAIL),
	("ENETDOWN", libc::ENETDOWN),
	("ENETUNREACH", libc::ENETUNREACH),
	("ENETRESET", libc::ENETRESET),
	("ECONNABORTED", libc::ECONNABORTED),
	("ECONNRESET", libc::ECONNRESET),
	("ENOBUFS", libc::ENOBUFS),
	("EISCONN", libc::EISCONN),
	("ENOTCONN", libc::ENOTCONN),
	("ESHUTDOWN", libc::ESHUTDOWN),
	("ETOOMANYREFS", libc::ETOOMANYREFS),
	("ETIMEDOUT", libc::ETIMEDOUT),
	("ECONNREFUSED", libc::ECONNREFUSED),
	("EHOSTDOWN", libc::EHOSTDOWN),
	("EHOSTUNREACH", libc::EHOSTUNREACH),
	("EALREADY", libc::EALREADY),
	("EINPROGRESS", libc::EINPROGRESS),
	("ESTALE", libc::ESTALE),
	("EDQUOT", libc::EDQUOT),
	("ECANCELED", libc::ECANCELED),
	("EOWNERDEAD", libc::EOWNERDEAD),
	("ENOTRECOVERABLE", libc::ENOTRECOVERABLE),
	("EWOULDBLOCK", libc::EWOULDBLOCK),
];

/// Runs `errno` against invocation-scoped stdout/stderr.
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

	let args: Vec<String> = matches
		.get_many::<String>(ARG_QUERY)
		.map(|values| values.cloned().collect())
		.unwrap_or_default();

	if matches.get_flag(OPT_LIST) {
		return list_all();
	}
	if matches.get_flag(OPT_SEARCH) {
		return search(&args);
	}
	if args.is_empty() {
		let _ = writeln!(pi_uutils_ctx::stderr(), "errno: no errno name or number given");
		return 1;
	}

	let mut failed = false;
	for arg in &args {
		if !lookup(arg) {
			failed = true;
		}
	}
	i32::from(failed)
}

fn command() -> Command {
	Command::new("errno")
		.version(concat!("errno (pi-shell) ", env!("CARGO_PKG_VERSION")))
		.about("Look up errno names and descriptions.")
		.override_usage(format_usage("errno [-ls] [--] [name-or-number...]"))
		.disable_help_flag(true)
		.disable_version_flag(true)
		.infer_long_args(true)
		.arg(
			Arg::new(OPT_LIST)
				.short('l')
				.long("list")
				.help("List all errno values")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_SEARCH)
				.short('s')
				.long("search")
				.help("Search errno descriptions for the given words")
				.action(ArgAction::SetTrue),
		)
		.arg(Arg::new("help").long("help").action(ArgAction::Help))
		.arg(
			Arg::new(ARG_QUERY)
				.value_name("NAME-OR-NUMBER")
				.num_args(0..)
				.action(ArgAction::Append),
		)
}

/// Formats the OS description for an errno number, without std's
/// ` (os error N)` suffix.
fn description(number: i32) -> String {
	let text = std::io::Error::from_raw_os_error(number).to_string();
	match text.rfind(" (os error ") {
		Some(index) => text[..index].to_string(),
		None => text,
	}
}

fn print_entry(name: &str, number: i32) {
	let _ = writeln!(pi_uutils_ctx::stdout(), "{name} {number} {}", description(number));
}

/// Looks up one name or number argument; returns false on failure.
fn lookup(arg: &str) -> bool {
	if let Ok(number) = arg.parse::<i32>() {
		// Reverse lookup: first-listed name for the number is canonical.
		match ERRNOS.iter().find(|(_, value)| *value == number) {
			Some((name, value)) => {
				print_entry(name, *value);
				true
			},
			None => false,
		}
	} else if let Some((name, value)) = ERRNOS
		.iter()
		.find(|(name, _)| name.eq_ignore_ascii_case(arg))
	{
		print_entry(name, *value);
		true
	} else {
		let _ = writeln!(pi_uutils_ctx::stderr(), "errno: unknown errno {arg}");
		false
	}
}

/// Prints every table entry (aliases included) sorted by number, then name.
fn list_all() -> i32 {
	let mut entries: Vec<(&str, i32)> = ERRNOS.to_vec();
	entries.sort_unstable_by(|a, b| a.1.cmp(&b.1).then(a.0.cmp(b.0)));
	for (name, number) in entries {
		print_entry(name, number);
	}
	0
}

/// Prints entries whose description contains all words, case-insensitively.
fn search(words: &[String]) -> i32 {
	let lowered: Vec<String> = words.iter().map(|word| word.to_lowercase()).collect();
	let mut entries: Vec<(&str, i32)> = ERRNOS.to_vec();
	entries.sort_unstable_by(|a, b| a.1.cmp(&b.1).then(a.0.cmp(b.0)));
	for (name, number) in entries {
		let text = description(number).to_lowercase();
		if lowered.iter().all(|word| text.contains(word.as_str())) {
			print_entry(name, number);
		}
	}
	0
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

	fn run_errno(args: &[&str]) -> (i32, String, String) {
		let stdout = Arc::new(Mutex::new(Vec::new()));
		let stderr = Arc::new(Mutex::new(Vec::new()));
		let io = ScopeIo {
			stdin:                 Box::new(Cursor::new(Vec::new())),
			stdin_fd:              None,
			stdin_is_search_input: false,
			stdout:                Box::new(SharedWriter(Arc::clone(&stdout))),
			stderr:                Box::new(SharedWriter(Arc::clone(&stderr))),
			cwd:                   std::env::temp_dir(),
			env:                   HashMap::new(),
			cancel:                Arc::new(AtomicBool::new(false)),
		};
		let argv = std::iter::once("errno")
			.chain(args.iter().copied())
			.map(OsString::from)
			.collect();
		let code = pi_uutils_ctx::scope(io, || run(argv));
		let stdout = String::from_utf8(stdout.lock().clone()).unwrap();
		let stderr = String::from_utf8(stderr.lock().clone()).unwrap();
		(code, stdout, stderr)
	}

	#[test]
	fn looks_up_name() {
		let (code, stdout, stderr) = run_errno(&["ENOENT"]);
		assert_eq!(code, 0);
		assert!(stdout.starts_with("ENOENT 2 "), "stdout: {stdout:?}");
		assert!(stdout.trim_end().len() > "ENOENT 2 ".len(), "missing description: {stdout:?}");
		assert!(stderr.is_empty());
	}

	#[test]
	fn reverse_lookup_by_number() {
		let (code, stdout, _) = run_errno(&["2"]);
		assert_eq!(code, 0);
		assert!(stdout.starts_with("ENOENT 2 "), "stdout: {stdout:?}");
	}

	#[test]
	fn unknown_name_fails_with_stderr() {
		let (code, stdout, stderr) = run_errno(&["ENOSUCHTHING"]);
		assert_eq!(code, 1);
		assert!(stdout.is_empty());
		assert!(stderr.contains("unknown errno ENOSUCHTHING"), "stderr: {stderr:?}");
	}

	#[test]
	fn unknown_number_fails_silently() {
		let (code, stdout, stderr) = run_errno(&["99999"]);
		assert_eq!(code, 1);
		assert!(stdout.is_empty());
		assert!(stderr.is_empty());
	}

	#[test]
	fn list_is_sorted_by_number() {
		let (code, stdout, _) = run_errno(&["-l"]);
		assert_eq!(code, 0);
		let lines: Vec<&str> = stdout.lines().collect();
		let eperm = lines.iter().position(|line| line.starts_with("EPERM 1 "));
		let enoent = lines.iter().position(|line| line.starts_with("ENOENT 2 "));
		assert!(eperm.is_some(), "EPERM missing from list");
		assert!(enoent.is_some(), "ENOENT missing from list");
		assert!(eperm.unwrap() < enoent.unwrap(), "list not number-sorted");
		let numbers: Vec<i32> = lines
			.iter()
			.map(|line| line.split(' ').nth(1).unwrap().parse().unwrap())
			.collect();
		let mut sorted = numbers.clone();
		sorted.sort_unstable();
		assert_eq!(numbers, sorted, "list not sorted by number");
	}

	#[test]
	fn search_is_case_insensitive() {
		let (code, stdout, _) = run_errno(&["-s", "No", "SUCH"]);
		assert_eq!(code, 0);
		assert!(
			stdout.lines().any(|line| line.starts_with("ENOENT 2 ")),
			"search missed ENOENT: {stdout:?}"
		);
	}

	#[test]
	fn multiple_args_aggregate_exit_code() {
		let (code, stdout, stderr) = run_errno(&["ENOENT", "ENOSUCHTHING", "EPERM"]);
		assert_eq!(code, 1);
		assert!(stdout.lines().any(|line| line.starts_with("ENOENT 2 ")));
		assert!(stdout.lines().any(|line| line.starts_with("EPERM 1 ")));
		assert!(stderr.contains("unknown errno ENOSUCHTHING"));
	}

	#[test]
	fn no_args_is_an_error() {
		let (code, stdout, stderr) = run_errno(&[]);
		assert_eq!(code, 1);
		assert!(stdout.is_empty());
		assert!(!stderr.is_empty());
	}
}
