use std::io::Write;

use brush_core::{ExecutionExitCode, ExecutionResult, builtins, sys, traps::TrapSignal};
use clap::Parser;

/// Signal a job or process.
#[derive(Parser)]
pub(crate) struct KillCommand {
	/// Name of the signal to send.
	#[arg(short = 's', value_name = "SIG_NAME")]
	signal_name: Option<String>,

	/// Number of the signal to send.
	#[arg(short = 'n', value_name = "SIG_NUM")]
	signal_number: Option<usize>,

	//
	// TODO(kill): implement -sigspec syntax
	/// List known signal names.
	#[arg(short = 'l', short_alias = 'L')]
	list_signals: bool,

	// Interpretation of these depends on whether -l is present.
	#[arg(allow_hyphen_values = true)]
	args: Vec<String>,

	/// Process/job operands given after the `--` end-of-options marker. clap
	/// consumes `--` before `execute`, so these are captured separately and are
	/// always operands — never signal specifications (preserves negative PIDs).
	#[arg(last = true, allow_hyphen_values = true)]
	post_marker_args: Vec<String>,
}

impl builtins::Command for KillCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		// Match shell and POSIX defaults by allowing graceful termination.
		let mut trap_signal = TrapSignal::Signal(nix::sys::signal::Signal::SIGTERM);

		// Try parsing the signal name (if specified).
		if let Some(signal_name) = &self.signal_name {
			if let Ok(parsed_trap_signal) = TrapSignal::try_from(signal_name.as_str()) {
				trap_signal = parsed_trap_signal;
			} else {
				writeln!(
					context.stderr(),
					"{}: invalid signal name: {}",
					context.command_name,
					signal_name
				)?;
				return Ok(ExecutionExitCode::InvalidUsage.into());
			}
		}

		// Try parsing the signal number (if specified).
		if let Some(signal_number) = &self.signal_number {
			#[expect(clippy::cast_possible_truncation)]
			#[expect(clippy::cast_possible_wrap)]
			if let Ok(parsed_trap_signal) = TrapSignal::try_from(*signal_number as i32) {
				trap_signal = parsed_trap_signal;
			} else {
				writeln!(
					context.stderr(),
					"{}: invalid signal number: {}",
					context.command_name,
					signal_number
				)?;
				return Ok(ExecutionExitCode::InvalidUsage.into());
			}
		}

		// Interpret the pre-`--` args: an optional leading `-sigspec` in the
		// option position, then pid/jobspec operands. A hyphen leads a sigspec
		// only in the option position — once a signal is chosen (via `-s`/`-n`, a
		// leading `-sigspec`, or the `--` marker) or an operand is seen, later
		// hyphen-led args are operands, so negative PIDs (process groups per
		// `kill(2)`) survive: `kill -TERM -- -10 123` signals process group 10 and
		// PID 123, and `kill -s TERM -- -10` signals process group 10.
		let mut operands: Vec<&String> = Vec::new();
		let mut options_done = self.signal_name.is_some() || self.signal_number.is_some();
		let mut consumed_marker = false;
		for arg in &self.args {
			// Whether clap leaves the `--` marker here depends on whether a
			// positional value was already collected; consume the first one and
			// close the option position either way.
			if !consumed_marker && arg == "--" {
				consumed_marker = true;
				options_done = true;
				continue;
			}
			if !options_done {
				if let Some(possible_sigspec) = arg.strip_prefix('-') {
					if !possible_sigspec.is_empty() {
						// Option position: interpret as a signal specification. The
						// sigspec may be a signal name (e.g. -TERM) or number (e.g. -9).
						if let Ok(parsed_trap_signal) = possible_sigspec.parse::<TrapSignal>() {
							trap_signal = parsed_trap_signal;
							options_done = true;
							continue;
						}
						writeln!(context.stderr(), "{}: invalid signal name", context.command_name)?;
						return Ok(ExecutionExitCode::InvalidUsage.into());
					}
				}
				// The first operand ends the option position.
				options_done = true;
			}
			operands.push(arg);
		}
		// Operands after the `--` marker are always process/job specs.
		operands.extend(self.post_marker_args.iter());

		if self.list_signals {
			return print_signals(&context, self.listed_signals());
		}
		if operands.is_empty() {
			writeln!(context.stderr(), "{}: invalid usage", context.command_name)?;
			return Ok(ExecutionExitCode::InvalidUsage.into());
		}

		let mut had_failure = false;
		for pid_or_job_spec in operands {
			let signal_result = if pid_or_job_spec.starts_with('%') {
				// It's a job spec.
				if let Some(job) = context.shell.jobs_mut().resolve_job_spec(pid_or_job_spec) {
					job.kill(trap_signal)
				} else {
					writeln!(
						context.stderr(),
						"{}: {}: no such job",
						context.command_name,
						pid_or_job_spec
					)?;
					had_failure = true;
					continue;
				}
			} else {
				brush_core::int_utils::parse(pid_or_job_spec.as_str(), 10)
					.and_then(|pid| sys::signal::kill_process(pid, trap_signal))
			};

			if let Err(err) = signal_result {
				writeln!(
					context.stderr(),
					"{}: {}: {}",
					context.command_name,
					pid_or_job_spec,
					err
				)?;
				had_failure = true;
			}
		}

		if had_failure {
			Ok(ExecutionResult::general_error())
		} else {
			Ok(ExecutionResult::success())
		}
	}
}

impl KillCommand {
	/// Signal specifications to list in `-l` mode: the pre-`--` positionals
	/// (minus the marker itself, which clap may leave in `args`; see above)
	/// followed by the post-marker operands.
	fn listed_signals(&self) -> impl Iterator<Item = &String> {
		let mut consumed_marker = false;
		self.args
			.iter()
			.filter(move |arg| {
				if !consumed_marker && *arg == "--" {
					consumed_marker = true;
					false
				} else {
					true
				}
			})
			.chain(&self.post_marker_args)
	}
}

fn print_signals<'a>(
	context: &brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
	signals: impl IntoIterator<Item = &'a String>,
) -> Result<ExecutionResult, brush_core::Error> {
	let mut exit_code = ExecutionResult::success();
	let mut signals = signals.into_iter().peekable();
	if signals.peek().is_some() {
		for s in signals {
			// If the user gives us a code, we print the name; if they give a name, we print
			// its code.
			enum PrintSignal {
				Name(&'static str),
				Num(i32),
			}

			let signal = if let Ok(n) = s.parse::<i32>() {
				// bash compatibility. `SIGHUP` -> `HUP`
				TrapSignal::try_from(n)
					.map(|s| PrintSignal::Name(s.as_str().strip_prefix("SIG").unwrap_or(s.as_str())))
			} else {
				TrapSignal::try_from(s.as_str()).map(|sig| {
					i32::try_from(sig).map_or(PrintSignal::Name(sig.as_str()), PrintSignal::Num)
				})
			};

			match signal {
				Ok(PrintSignal::Num(n)) => {
					writeln!(context.stdout(), "{n}")?;
				},
				Ok(PrintSignal::Name(s)) => {
					writeln!(context.stdout(), "{s}")?;
				},
				Err(e) => {
					writeln!(context.stderr(), "{e}")?;
					exit_code = ExecutionResult::general_error();
				},
			}
		}
	} else {
		return brush_core::traps::format_signals(
			context.stdout(),
			TrapSignal::iterator().filter(|s| !matches!(s, TrapSignal::Exit)),
		)
		.map(|()| ExecutionResult::success());
	}

	Ok(exit_code)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn listed(args: &[&str]) -> Vec<String> {
		let cmd = KillCommand::try_parse_from(args).unwrap();
		cmd.listed_signals().cloned().collect()
	}

	#[test]
	fn lists_post_marker_operands() {
		assert_eq!(listed(&["kill", "-l", "--", "9"]), ["9"]);
	}

	#[test]
	fn lists_pre_and_post_marker_operands() {
		assert_eq!(listed(&["kill", "-l", "TERM", "--", "9"]), ["TERM", "9"]);
	}

	#[test]
	fn lists_pre_marker_operands_without_marker() {
		assert_eq!(listed(&["kill", "-l", "TERM", "HUP"]), ["TERM", "HUP"]);
	}
}
