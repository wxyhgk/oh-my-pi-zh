//! moreutils `ts` builtin: prefix each line of standard input with a
//! timestamp.
//!
//! Modes:
//! - default: current local time, strftime format `%b %d %H:%M:%S`
//! - `-i`: time elapsed since the previous line (default format `%H:%M:%S`)
//! - `-s`: time elapsed since program start (default format `%H:%M:%S`)
//! - `-m`: use the monotonic clock for `-i`/`-s` elapsed computation
//! - `-r`: rewrite an existing leading timestamp (RFC3339/ISO8601 or syslog `%b
//!   %d %H:%M:%S`) into a human-relative form
//!
//! Elapsed durations are formatted as if they were seconds since the Unix
//! epoch rendered in UTC (matching moreutils), so 90 elapsed seconds with
//! `%H:%M:%S` renders `00:01:30`. The moreutils subsecond extensions `%.S`,
//! `%.s`, and `%.T` append microseconds to the seconds field in both absolute
//! and elapsed modes.
//!
//! `-r` renders relative times on a simple largest-nonzero-unit ladder —
//! `45s ago`, `12m ago`, `3h ago`, `9d ago` (or `in 2h` for future times) —
//! rather than Perl `Time::Duration`'s two-unit concise style.

use std::{
	ffi::OsString,
	io::{BufRead, BufReader, Write},
	time::Instant,
};

use clap::{Arg, ArgAction, ArgMatches, Command};
use jiff::{Timestamp, fmt::strtime, tz::TimeZone};
use pi_uutils_ctx::format_usage;

const OPT_RELATIVE: &str = "relative";
const OPT_INCREMENTAL: &str = "incremental";
const OPT_SINCE_START: &str = "since-start";
const OPT_MONOTONIC: &str = "monotonic";
const ARG_FORMAT: &str = "format";

const DEFAULT_ABSOLUTE_FORMAT: &str = "%b %d %H:%M:%S";
const DEFAULT_ELAPSED_FORMAT: &str = "%H:%M:%S";

/// Byte length of a syslog-style `%b %d %H:%M:%S` timestamp prefix.
const SYSLOG_LEN: usize = 15;

/// Runs `ts` against invocation-scoped stdin/stdout/stderr.
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

	match timestamp_lines(&matches) {
		Ok(code) => code,
		Err(message) => {
			let _ = writeln!(pi_uutils_ctx::stderr(), "ts: {message}");
			1
		},
	}
}

fn command() -> Command {
	Command::new("ts")
		.version(concat!("ts (pi-shell) ", env!("CARGO_PKG_VERSION")))
		.about("Timestamp each line of standard input.")
		.override_usage(format_usage("ts [-r] [-i | -s] [-m] [FORMAT]"))
		.disable_help_flag(true)
		.disable_version_flag(true)
		.arg(
			Arg::new(OPT_RELATIVE)
				.short('r')
				.help("convert existing leading timestamps to relative times")
				.conflicts_with_all([OPT_INCREMENTAL, OPT_SINCE_START])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_INCREMENTAL)
				.short('i')
				.help("timestamp with the time elapsed since the last line")
				.conflicts_with(OPT_SINCE_START)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_SINCE_START)
				.short('s')
				.help("timestamp with the time elapsed since program start")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_MONOTONIC)
				.short('m')
				.help("use the monotonic clock for elapsed timestamps")
				.action(ArgAction::SetTrue),
		)
		.arg(Arg::new("help").long("help").action(ArgAction::Help))
		.arg(
			Arg::new("version")
				.long("version")
				.action(ArgAction::Version),
		)
		.arg(
			Arg::new(ARG_FORMAT)
				.value_name("FORMAT")
				.help("strftime format string"),
		)
}

/// Timestamping mode selected by the flags.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
	Absolute,
	SinceLast,
	SinceStart,
	Relative,
}

fn timestamp_lines(matches: &ArgMatches) -> Result<i32, String> {
	let mode = if matches.get_flag(OPT_RELATIVE) {
		Mode::Relative
	} else if matches.get_flag(OPT_INCREMENTAL) {
		Mode::SinceLast
	} else if matches.get_flag(OPT_SINCE_START) {
		Mode::SinceStart
	} else {
		Mode::Absolute
	};
	let monotonic = matches.get_flag(OPT_MONOTONIC);
	let default_format = if mode == Mode::Absolute {
		DEFAULT_ABSOLUTE_FORMAT
	} else {
		DEFAULT_ELAPSED_FORMAT
	};
	let format = expand_subseconds(
		matches
			.get_one::<String>(ARG_FORMAT)
			.map_or(default_format, String::as_str),
	);
	let tz = local_timezone();

	let mut reader = BufReader::new(pi_uutils_ctx::stdin());
	let mut out = pi_uutils_ctx::stdout();
	let start_wall = Timestamp::now();
	let start_mono = Instant::now();
	let mut last_wall = start_wall;
	let mut last_mono = start_mono;
	let mut buf = Vec::new();

	loop {
		if pi_uutils_ctx::is_cancelled() {
			return Ok(130);
		}
		buf.clear();
		let n = reader
			.read_until(b'\n', &mut buf)
			.map_err(|err| err.to_string())?;
		if n == 0 {
			break;
		}
		let had_newline = buf.last() == Some(&b'\n');
		let content = if had_newline { &buf[..n - 1] } else { &buf[..] };

		match mode {
			Mode::Relative => {
				let now = Timestamp::now();
				let year = now.to_zoned(tz.clone()).year();
				if let Some((consumed, then)) = parse_leading_timestamp(content, year, &tz) {
					let rel = render_relative(then, now);
					out.write_all(rel.as_bytes())
						.map_err(|err| err.to_string())?;
					out.write_all(&content[consumed..])
						.map_err(|err| err.to_string())?;
				} else {
					out.write_all(content).map_err(|err| err.to_string())?;
				}
			},
			Mode::Absolute => {
				let zoned = Timestamp::now().to_zoned(tz.clone());
				let stamp = strtime::format(&format, &zoned).map_err(|err| err.to_string())?;
				out.write_all(stamp.as_bytes())
					.map_err(|err| err.to_string())?;
				out.write_all(b" ").map_err(|err| err.to_string())?;
				out.write_all(content).map_err(|err| err.to_string())?;
			},
			Mode::SinceLast | Mode::SinceStart => {
				let nanos = if monotonic {
					let now = Instant::now();
					let anchor = if mode == Mode::SinceLast {
						last_mono
					} else {
						start_mono
					};
					last_mono = now;
					i128::try_from(now.duration_since(anchor).as_nanos()).unwrap_or(i128::MAX)
				} else {
					let now = Timestamp::now();
					let anchor = if mode == Mode::SinceLast {
						last_wall
					} else {
						start_wall
					};
					last_wall = now;
					now.duration_since(anchor).as_nanos().max(0)
				};
				let stamp = format_elapsed(nanos, &format)?;
				out.write_all(stamp.as_bytes())
					.map_err(|err| err.to_string())?;
				out.write_all(b" ").map_err(|err| err.to_string())?;
				out.write_all(content).map_err(|err| err.to_string())?;
			},
		}
		if had_newline {
			out.write_all(b"\n").map_err(|err| err.to_string())?;
		}
		// ts is commonly used on live pipes; make each line visible promptly.
		out.flush().map_err(|err| err.to_string())?;
	}
	Ok(0)
}

/// Formats an elapsed duration (in nanoseconds) as seconds-since-epoch
/// rendered in UTC, matching moreutils' `strftime`-with-GMT behavior.
fn format_elapsed(nanos: i128, format: &str) -> Result<String, String> {
	let stamp = Timestamp::from_nanosecond(nanos).map_err(|err| err.to_string())?;
	strtime::format(format, &stamp.to_zoned(TimeZone::UTC)).map_err(|err| err.to_string())
}

/// Resolves the scope's timezone: `TZ` from the shell environment when valid,
/// otherwise the system timezone, otherwise UTC.
fn local_timezone() -> TimeZone {
	if let Some(tz) = pi_uutils_ctx::var("TZ")
		&& let Ok(tz) = TimeZone::get(&tz)
	{
		return tz;
	}
	TimeZone::try_system().unwrap_or(TimeZone::UTC)
}

/// Rewrites the moreutils subsecond extensions `%.S`, `%.s`, and `%.T` into
/// jiff strftime equivalents with a fixed 6-digit (microsecond) fraction.
fn expand_subseconds(format: &str) -> String {
	let mut out = String::with_capacity(format.len());
	let bytes = format.as_bytes();
	let mut i = 0;
	while i < bytes.len() {
		if bytes[i] == b'%' && i + 1 < bytes.len() {
			match &bytes[i + 1..] {
				[b'%', ..] => {
					out.push_str("%%");
					i += 2;
					continue;
				},
				[b'.', b'S', ..] => {
					out.push_str("%S.%6f");
					i += 3;
					continue;
				},
				[b'.', b's', ..] => {
					out.push_str("%s.%6f");
					i += 3;
					continue;
				},
				[b'.', b'T', ..] => {
					out.push_str("%H:%M:%S.%6f");
					i += 3;
					continue;
				},
				_ => {},
			}
		}
		// Copy the full UTF-8 sequence starting at `i`.
		let len = utf8_len(bytes[i]);
		out.push_str(std::str::from_utf8(&bytes[i..i + len]).unwrap_or("\u{fffd}"));
		i += len;
	}
	out
}

/// Length of the UTF-8 sequence introduced by `first` (1 for continuation or
/// invalid bytes, which only arise from already-valid `&str` input here).
const fn utf8_len(first: u8) -> usize {
	match first {
		0xc0..=0xdf => 2,
		0xe0..=0xef => 3,
		0xf0..=0xf7 => 4,
		_ => 1,
	}
}

/// Parses a timestamp at the start of `line`, returning the byte length of
/// the matched prefix and the parsed instant.
///
/// Supported formats: RFC3339/ISO8601 (optional fractional seconds; offset
/// optional, civil times resolve in `tz`) and syslog `%b %d %H:%M:%S`
/// (assumed `year`, resolved in `tz`).
fn parse_leading_timestamp(line: &[u8], year: i16, tz: &TimeZone) -> Option<(usize, Timestamp)> {
	let token_len = line
		.iter()
		.position(|b| b.is_ascii_whitespace())
		.unwrap_or(line.len());
	if let Ok(token) = std::str::from_utf8(&line[..token_len]) {
		if let Ok(ts) = token.parse::<Timestamp>() {
			return Some((token_len, ts));
		}
		if let Ok(dt) = token.parse::<jiff::civil::DateTime>()
			&& let Ok(zoned) = dt.to_zoned(tz.clone())
		{
			return Some((token_len, zoned.timestamp()));
		}
	}

	// Syslog style: exactly 15 bytes, followed by whitespace or end of line.
	if line.len() < SYSLOG_LEN
		|| (line.len() > SYSLOG_LEN && !line[SYSLOG_LEN].is_ascii_whitespace())
	{
		return None;
	}
	let mut prefix: [u8; SYSLOG_LEN] = line[..SYSLOG_LEN].try_into().ok()?;
	// Syslog space-pads single-digit days ("Jan  1"); zero-pad for parsing.
	if prefix[4] == b' ' {
		prefix[4] = b'0';
	}
	let text = std::str::from_utf8(&prefix).ok()?;
	let tm = strtime::parse("%Y %b %d %H:%M:%S", format!("{year} {text}")).ok()?;
	let zoned = tm.to_datetime().ok()?.to_zoned(tz.clone()).ok()?;
	Some((SYSLOG_LEN, zoned.timestamp()))
}

/// Renders `then` relative to `now` using the largest nonzero unit on an
/// `s`/`m`/`h`/`d` ladder: `45s ago`, `12m ago`, `3h ago`, `9d ago`, or
/// `in 2h` for future times.
fn render_relative(then: Timestamp, now: Timestamp) -> String {
	let secs = now.duration_since(then).as_secs();
	let magnitude = secs.unsigned_abs();
	let (count, unit) = if magnitude >= 86_400 {
		(magnitude / 86_400, 'd')
	} else if magnitude >= 3_600 {
		(magnitude / 3_600, 'h')
	} else if magnitude >= 60 {
		(magnitude / 60, 'm')
	} else {
		(magnitude, 's')
	};
	if secs >= 0 {
		format!("{count}{unit} ago")
	} else {
		format!("in {count}{unit}")
	}
}

#[cfg(test)]
mod tests {
	use std::{
		collections::HashMap,
		ffi::OsString,
		io::{Cursor, Write},
		sync::{Arc, atomic::AtomicBool},
	};

	use jiff::{Timestamp, tz::TimeZone};
	use parking_lot::Mutex;
	use pi_uutils_ctx::ScopeIo;

	use super::{parse_leading_timestamp, render_relative, run};

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

	fn run_in(stdin: &[u8], args: &[&str]) -> (i32, Vec<u8>, String) {
		let stdout = Arc::new(Mutex::new(Vec::new()));
		let stderr = Arc::new(Mutex::new(Vec::new()));
		let io = ScopeIo {
			stdin:                 Box::new(Cursor::new(stdin.to_vec())),
			stdin_fd:              None,
			stdin_is_search_input: false,
			stdout:                Box::new(SharedWriter(Arc::clone(&stdout))),
			stderr:                Box::new(SharedWriter(Arc::clone(&stderr))),
			cwd:                   std::env::temp_dir(),
			env:                   HashMap::from([("TZ".to_string(), "UTC".to_string())]),
			cancel:                Arc::new(AtomicBool::new(false)),
		};
		let argv = std::iter::once("ts")
			.chain(args.iter().copied())
			.map(OsString::from)
			.collect();
		let code = pi_uutils_ctx::scope(io, || run(argv));
		let stdout = stdout.lock().clone();
		let stderr = String::from_utf8(stderr.lock().clone()).unwrap();
		(code, stdout, stderr)
	}

	#[test]
	fn absolute_mode_prefixes_default_format() {
		let (code, stdout, stderr) = run_in(b"hello\n", &[]);
		assert_eq!((code, stderr.as_str()), (0, ""));
		let text = String::from_utf8(stdout).unwrap();
		let re = regex::Regex::new(r"^[A-Z][a-z]{2} \d{2} \d{2}:\d{2}:\d{2} hello\n$").unwrap();
		assert!(re.is_match(&text), "unexpected output: {text:?}");
	}

	#[test]
	fn elapsed_modes_start_at_zero() {
		let (code, stdout, _) = run_in(b"line\n", &["-i"]);
		assert_eq!((code, stdout.as_slice()), (0, b"00:00:00 line\n".as_slice()));

		let (code, stdout, _) = run_in(b"line\n", &["-s"]);
		assert_eq!((code, stdout.as_slice()), (0, b"00:00:00 line\n".as_slice()));

		let (code, stdout, _) = run_in(b"line\n", &["-s", "-m"]);
		assert_eq!((code, stdout.as_slice()), (0, b"00:00:00 line\n".as_slice()));
	}

	#[test]
	fn subsecond_extensions_render_microseconds() {
		let (code, stdout, stderr) = run_in(b"x\n", &["-s", "%.S"]);
		assert_eq!((code, stderr.as_str()), (0, ""));
		let text = String::from_utf8(stdout).unwrap();
		let re = regex::Regex::new(r"^\d{2}\.\d{6} x\n$").unwrap();
		assert!(re.is_match(&text), "unexpected output: {text:?}");

		let (code, stdout, _) = run_in(b"x\n", &["-s", "%.T"]);
		assert_eq!(code, 0);
		let text = String::from_utf8(stdout).unwrap();
		let re = regex::Regex::new(r"^\d{2}:\d{2}:\d{2}\.\d{6} x\n$").unwrap();
		assert!(re.is_match(&text), "unexpected output: {text:?}");
	}

	#[test]
	fn binary_lines_survive_byte_for_byte() {
		let (code, stdout, _) = run_in(b"ab\xff\xfecd\n", &["-s"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, b"00:00:00 ab\xff\xfecd\n");
	}

	#[test]
	fn final_line_without_newline_is_timestamped_without_newline() {
		let (code, stdout, _) = run_in(b"first\nlast", &["-s"]);
		assert_eq!(code, 0);
		assert!(stdout.starts_with(b"00:00:00 first\n"), "output: {stdout:?}");
		assert!(stdout.ends_with(b" last"), "output: {stdout:?}");
		assert_ne!(stdout.last(), Some(&b'\n'));
	}

	#[test]
	fn incremental_conflicts_with_since_start() {
		let (code, _, stderr) = run_in(b"", &["-i", "-s"]);
		assert_eq!(code, 2);
		assert!(stderr.contains("cannot be used with"), "stderr: {stderr:?}");
	}

	#[test]
	fn relative_conflicts_with_elapsed_modes() {
		let (code, ..) = run_in(b"", &["-r", "-i"]);
		assert_eq!(code, 2);
	}

	#[test]
	fn render_relative_uses_largest_nonzero_unit() {
		let now: Timestamp = "2024-06-01T12:00:00Z".parse().unwrap();
		let at = |secs: i64| Timestamp::from_second(now.as_second() - secs).unwrap();
		assert_eq!(render_relative(at(45), now), "45s ago");
		assert_eq!(render_relative(at(12 * 60), now), "12m ago");
		assert_eq!(render_relative(at(3 * 3600 + 59), now), "3h ago");
		assert_eq!(render_relative(at(9 * 86_400), now), "9d ago");
		assert_eq!(render_relative(at(0), now), "0s ago");
		assert_eq!(render_relative(at(-2 * 3600), now), "in 2h");
	}

	#[test]
	fn parse_leading_timestamp_accepts_supported_formats() {
		let tz = TimeZone::UTC;

		let (consumed, ts) =
			parse_leading_timestamp(b"2024-01-01T12:00:00Z boot", 2024, &tz).unwrap();
		assert_eq!(consumed, 20);
		assert_eq!(ts, "2024-01-01T12:00:00Z".parse::<Timestamp>().unwrap());

		let (consumed, ts) =
			parse_leading_timestamp(b"2024-01-01T12:00:00.500-05:00 x", 2024, &tz).unwrap();
		assert_eq!(consumed, 29);
		assert_eq!(ts, "2024-01-01T17:00:00.5Z".parse::<Timestamp>().unwrap());

		// Civil datetime without offset resolves in the provided timezone.
		let (consumed, ts) = parse_leading_timestamp(b"2024-01-01T12:00:00 x", 2024, &tz).unwrap();
		assert_eq!(consumed, 19);
		assert_eq!(ts, "2024-01-01T12:00:00Z".parse::<Timestamp>().unwrap());

		// Syslog style, zero-padded and space-padded days.
		let (consumed, ts) = parse_leading_timestamp(b"Jan 02 03:04:05 msg", 2024, &tz).unwrap();
		assert_eq!(consumed, 15);
		assert_eq!(ts, "2024-01-02T03:04:05Z".parse::<Timestamp>().unwrap());
		let (consumed, ts) = parse_leading_timestamp(b"Jan  2 03:04:05 msg", 2024, &tz).unwrap();
		assert_eq!(consumed, 15);
		assert_eq!(ts, "2024-01-02T03:04:05Z".parse::<Timestamp>().unwrap());

		assert!(parse_leading_timestamp(b"plain text line", 2024, &tz).is_none());
		assert!(parse_leading_timestamp(b"Jan 02 03:04:05x", 2024, &tz).is_none());
	}

	#[test]
	fn relative_mode_rewrites_matching_lines_and_passes_others() {
		let (code, stdout, stderr) =
			run_in(b"2000-01-01T00:00:00Z boot\nno timestamp here\n", &["-r"]);
		assert_eq!((code, stderr.as_str()), (0, ""));
		let text = String::from_utf8(stdout).unwrap();
		let mut lines = text.lines();
		let first = lines.next().unwrap();
		assert!(first.ends_with(" boot"), "line: {first:?}");
		assert!(first.contains("d ago"), "line: {first:?}");
		assert!(!first.starts_with("2000"), "line: {first:?}");
		assert_eq!(lines.next(), Some("no timestamp here"));
		assert_eq!(lines.next(), None);
	}
}
