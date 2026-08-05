//! Runtime-agnostic brush shell execution.

use std::{
	collections::{HashMap, HashSet},
	fmt::Write as _,
	fs,
	io::{self, BufRead, Write},
	path::{Path, PathBuf},
	str,
	sync::Arc,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Error, Result};
use brush_builtins::{BuiltinSet, default_builtins};
use brush_core::{
	ExecutionContext, ExecutionControlFlow, ExecutionExitCode, ExecutionParameters, ExecutionResult,
	ProcessGroupPolicy, ProfileLoadBehavior, RcLoadBehavior, Shell as BrushShell, ShellValue,
	ShellVariable, SourceInfo, SpawnObserver, builtins,
	env::EnvironmentScope,
	openfiles::{self, OpenFile, OpenFiles},
	sys,
	traps::{self, TrapSignal},
};
use bytes::Bytes;
use clap::Parser;
use flume::Sender;
use jiff::{Timestamp, fmt::strtime, tz::TimeZone};
#[cfg(not(unix))]
use tokio::io::AsyncReadExt as _;
use tokio::{sync::Mutex as TokioMutex, time};
use tokio_util::sync::CancellationToken;

#[cfg(windows)]
use crate::windows::configure_windows_path;
use crate::{
	cancel::{AbortReason, AbortToken, CancelToken},
	minimizer, process,
};

struct ShellSessionCore {
	shell: BrushShell,
}

#[derive(Clone, Default)]
struct ShellAbortState(Arc<TokioMutex<Option<AbortToken>>>);

impl ShellAbortState {
	async fn set(&self, abort_token: AbortToken) {
		*self.0.lock().await = Some(abort_token);
	}

	async fn clear(&self) {
		*self.0.lock().await = None;
	}

	async fn abort(&self) {
		let abort_token = self.0.lock().await.clone();
		if let Some(abort_token) = abort_token {
			abort_token.abort(AbortReason::Signal);
		}
	}
}

fn shell_working_dir_matches(shell: &BrushShell, cwd: &str) -> bool {
	let requested = std::path::Path::new(cwd);
	if !requested.is_absolute() {
		return false;
	}
	let current = shell.working_dir();
	current == requested
}

fn set_shell_working_dir_if_changed(shell: &mut BrushShell, cwd: &str) -> Result<()> {
	if shell_working_dir_matches(shell, cwd) {
		return Ok(());
	}
	shell
		.set_working_dir(cwd)
		.map_err(|err| Error::msg(format!("Failed to set cwd: {err}")))
}

#[derive(Clone)]
struct ShellConfig {
	session_env:   Option<HashMap<String, String>>,
	snapshot_path: Option<String>,
	minimizer:     Option<minimizer::MinimizerConfig>,
}

#[derive(Debug, Clone, Default)]
pub struct ShellOptions {
	pub session_env:   Option<HashMap<String, String>>,
	pub snapshot_path: Option<String>,
	pub minimizer:     Option<minimizer::MinimizerOptions>,
}

struct ShellRunConfig {
	command:   String,
	cwd:       Option<String>,
	env:       Option<HashMap<String, String>>,
	minimizer: Option<minimizer::MinimizerConfig>,
}

#[derive(Debug, Clone, Default)]
pub struct ShellRunOptions {
	pub command:    String,
	pub cwd:        Option<String>,
	pub env:        Option<HashMap<String, String>>,
	pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MinimizerResult {
	pub filter:        String,
	pub text:          String,
	pub original_text: String,
	pub input_bytes:   u32,
	pub output_bytes:  u32,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ShellRunResult {
	pub exit_code:   Option<i32>,
	pub cancelled:   bool,
	pub timed_out:   bool,
	pub minimized:   Option<MinimizerResult>,
	pub working_dir: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ShellExecuteOptions {
	pub command:       String,
	pub cwd:           Option<String>,
	pub env:           Option<HashMap<String, String>>,
	pub session_env:   Option<HashMap<String, String>>,
	pub timeout_ms:    Option<u32>,
	pub snapshot_path: Option<String>,
	pub minimizer:     Option<minimizer::MinimizerOptions>,
}

pub type ShellExecuteResult = ShellRunResult;

pub struct Shell {
	session:     Arc<TokioMutex<Option<ShellSessionCore>>>,
	abort_state: ShellAbortState,
	config:      ShellConfig,
}

impl Shell {
	#[must_use]
	pub fn new(options: Option<ShellOptions>) -> Self {
		let config = match options {
			None => ShellConfig { session_env: None, snapshot_path: None, minimizer: None },
			Some(opt) => {
				let minimizer = opt
					.minimizer
					.as_ref()
					.map(minimizer::MinimizerConfig::from_options);
				ShellConfig {
					session_env: opt.session_env,
					snapshot_path: opt.snapshot_path,
					minimizer,
				}
			},
		};
		Self {
			session: Arc::new(TokioMutex::new(None)),
			abort_state: ShellAbortState::default(),
			config,
		}
	}

	pub async fn run(
		&self,
		options: ShellRunOptions,
		on_chunk: Option<Sender<String>>,
		mut cancel_token: CancelToken,
	) -> Result<ShellRunResult> {
		let run_config = ShellRunConfig {
			command:   options.command,
			cwd:       options.cwd,
			env:       options.env,
			minimizer: self.config.minimizer.clone(),
		};
		run_shell_session(
			self.session.clone(),
			self.abort_state.clone(),
			self.config.clone(),
			run_config,
			on_chunk,
			&mut cancel_token,
		)
		.await
	}

	pub async fn abort(&self) {
		self.abort_state.abort().await;
	}

	/// Number of live background jobs (running `&`/`nohup` children) tracked by
	/// the persistent session. Completed jobs are reaped first via a silent
	/// `JobManager::poll()` (no job-control notifications), so the count
	/// reflects only processes still alive. Returns 0 when no session core is
	/// materialized. The host uses this to decide whether to retain a per-call
	/// shell whose background children are still running instead of dropping it
	/// (which would SIGKILL them on kill-on-drop).
	pub async fn live_background_job_count(&self) -> u32 {
		let mut guard = self.session.lock().await;
		let Some(core) = guard.as_mut() else {
			return 0;
		};
		let jobs = core.shell.jobs_mut();
		// Fail closed: a poll error leaves the job table in an unknown state, so
		// report 0 (drop the shell) rather than pin a retained session forever on
		// stale `representative_pid()` entries.
		if jobs.poll().is_err() {
			return 0;
		}
		u32::try_from(
			jobs
				.jobs
				.iter()
				.filter(|job| job.representative_pid().is_some())
				.count(),
		)
		.unwrap_or(u32::MAX)
	}
}

pub async fn execute_shell(
	options: ShellExecuteOptions,
	on_chunk: Option<Sender<String>>,
	cancel_token: CancelToken,
) -> Result<ShellExecuteResult> {
	let minimizer = options
		.minimizer
		.as_ref()
		.map(minimizer::MinimizerConfig::from_options);
	let config = ShellConfig {
		session_env:   options.session_env,
		snapshot_path: options.snapshot_path,
		minimizer:     minimizer.clone(),
	};
	let run_config =
		ShellRunConfig { command: options.command, cwd: options.cwd, env: options.env, minimizer };
	run_shell_oneshot(config, run_config, on_chunk, cancel_token).await
}

/// Optional per-stream raw byte sinks for [`execute_shell_streams`].
///
/// When a sink is `Some`, that stream's pipe is drained directly into the
/// channel with no UTF-8 decoding and no merging. When `None`, the
/// corresponding pipe is still drained (to avoid blocking the child) but
/// its bytes are dropped.
#[derive(Default)]
pub struct StreamSinks {
	pub stdout: Option<Sender<Bytes>>,
	pub stderr: Option<Sender<Bytes>>,
}

/// One-shot execution that delivers stdout/stderr as raw byte chunks.
///
/// Bytes are delivered on separate channels with no UTF-8 decoding and no
/// merging. The minimizer is intentionally disabled — its
/// `MinimizerResult.text` contract presumes a single merged transcript.
pub async fn execute_shell_streams(
	options: ShellExecuteOptions,
	streams: StreamSinks,
	cancel_token: CancelToken,
) -> Result<ShellExecuteResult> {
	let config = ShellConfig {
		session_env:   options.session_env,
		snapshot_path: options.snapshot_path,
		minimizer:     None,
	};
	let run_config = ShellRunConfig {
		command:   options.command,
		cwd:       options.cwd,
		env:       options.env,
		minimizer: None,
	};
	run_shell_oneshot_streams(config, run_config, streams, cancel_token).await
}

async fn run_shell_session(
	session: Arc<TokioMutex<Option<ShellSessionCore>>>,
	abort_state: ShellAbortState,
	config: ShellConfig,
	run_config: ShellRunConfig,
	on_chunk: Option<Sender<String>>,
	ct: &mut CancelToken,
) -> Result<ShellRunResult> {
	let tokio_cancel = CancellationToken::new();
	let spawn_registry = Arc::new(process::SpawnRegistry::new());
	let process_cancel_bridge = tokio::spawn({
		let tokio_cancel = tokio_cancel.clone();
		let spawn_registry = spawn_registry.clone();
		async move {
			tokio_cancel.cancelled().await;
			terminate_run(&spawn_registry).await;
		}
	});

	let mut run_task = tokio::spawn({
		let session = session.clone();
		let abort_state = abort_state.clone();
		let tokio_cancel = tokio_cancel.clone();
		let at = ct.emplace_abort_token();
		let spawn_registry = spawn_registry.clone();
		async move {
			let mut session_guard = session.lock().await;

			let session = match &mut *session_guard {
				Some(session) => session,
				None => session_guard.insert(
					create_session_for_run(
						&config,
						Some(spawn_registry.clone()),
						Some(tokio_cancel.clone()),
					)
					.await?,
				),
			};
			abort_state.set(at).await;
			run_shell_command(session, &run_config, on_chunk, tokio_cancel, spawn_registry).await
		}
	});

	let res = tokio::select! {
		res = &mut run_task => res,
		reason = ct.wait() => {
			tokio_cancel.cancel();
			let graceful = time::timeout(Duration::from_secs(2), &mut run_task).await;
			if graceful.is_err() {
				run_task.abort();
				let _ = run_task.await;
			}
			abort_state.clear().await;
			// Use try_lock to avoid deadlocking if another task holds the session.
			// If we can't acquire the lock, the session will be cleaned up when the
			// holding task finishes.
			if let Ok(mut guard) = session.try_lock() {
				*guard = None;
			}
			let _ = process_cancel_bridge.await;
			return Ok(ShellRunResult {
				exit_code:   None,
				cancelled:   matches!(reason, AbortReason::Signal),
				timed_out:   matches!(reason, AbortReason::Timeout),
				minimized:   None,
				working_dir: None,
			});
		}
	};
	let res =
		res.unwrap_or_else(|err| Err(Error::msg(format!("Shell execution task failed: {err}"))));
	process_cancel_bridge.abort();
	let _ = process_cancel_bridge.await;
	abort_state.clear().await;

	let keepalive = res.as_ref().is_ok_and(|(exec, ..)| session_keepalive(exec));
	if !keepalive {
		*session.lock().await = None;
	}
	let (exec, minimized, working_dir) = res?;
	Ok(ShellRunResult {
		exit_code: Some(exit_code(&exec)),
		cancelled: false,
		timed_out: false,
		working_dir,
		minimized,
	})
}

async fn run_shell_oneshot(
	config: ShellConfig,
	run_config: ShellRunConfig,
	on_chunk: Option<Sender<String>>,
	ct: CancelToken,
) -> Result<ShellExecuteResult> {
	let tokio_cancel = CancellationToken::new();
	let spawn_registry = Arc::new(process::SpawnRegistry::new());
	let process_cancel_bridge = tokio::spawn({
		let tokio_cancel = tokio_cancel.clone();
		let spawn_registry = spawn_registry.clone();
		async move {
			tokio_cancel.cancelled().await;
			terminate_run(&spawn_registry).await;
		}
	});

	let mut task = tokio::spawn({
		let tokio_cancel = tokio_cancel.clone();
		let spawn_registry = spawn_registry.clone();
		async move {
			let mut session = create_session_for_run(
				&config,
				Some(spawn_registry.clone()),
				Some(tokio_cancel.clone()),
			)
			.await?;
			run_shell_command(&mut session, &run_config, on_chunk, tokio_cancel, spawn_registry).await
		}
	});

	let run_result = tokio::select! {
		result = &mut task => result,
		reason = ct.wait() => {
			tokio_cancel.cancel();
			let graceful = time::timeout(Duration::from_secs(2), &mut task).await;
			if graceful.is_err() {
				task.abort();
				let _ = task.await;
			}
			let _ = process_cancel_bridge.await;
			return Ok(ShellExecuteResult {
				exit_code:   None,
				cancelled:   matches!(reason, AbortReason::Signal),
				timed_out:   matches!(reason, AbortReason::Timeout),
				minimized:   None,
				working_dir: None,
			});
		},
	};

	process_cancel_bridge.abort();
	let _ = process_cancel_bridge.await;
	let res = run_result
		.unwrap_or_else(|err| Err(Error::msg(format!("Shell execution task failed: {err}"))));
	let (exec, minimized, working_dir) = res?;
	Ok(ShellExecuteResult {
		exit_code: Some(exit_code(&exec)),
		cancelled: false,
		timed_out: false,
		working_dir,
		minimized,
	})
}

async fn run_shell_oneshot_streams(
	config: ShellConfig,
	run_config: ShellRunConfig,
	streams: StreamSinks,
	ct: CancelToken,
) -> Result<ShellExecuteResult> {
	let tokio_cancel = CancellationToken::new();
	let spawn_registry = Arc::new(process::SpawnRegistry::new());
	let process_cancel_bridge = tokio::spawn({
		let tokio_cancel = tokio_cancel.clone();
		let spawn_registry = spawn_registry.clone();
		async move {
			tokio_cancel.cancelled().await;
			terminate_run(&spawn_registry).await;
		}
	});

	let mut task = tokio::spawn({
		let tokio_cancel = tokio_cancel.clone();
		let spawn_registry = spawn_registry.clone();
		async move {
			let mut session = create_session_for_run(
				&config,
				Some(spawn_registry.clone()),
				Some(tokio_cancel.clone()),
			)
			.await?;
			run_shell_command_streams(&mut session, &run_config, streams, tokio_cancel, spawn_registry)
				.await
		}
	});

	let run_result = tokio::select! {
		result = &mut task => result,
		reason = ct.wait() => {
			tokio_cancel.cancel();
			let graceful = time::timeout(Duration::from_secs(2), &mut task).await;
			if graceful.is_err() {
				task.abort();
				let _ = task.await;
			}
			let _ = process_cancel_bridge.await;
			return Ok(ShellExecuteResult {
				exit_code: None,
				cancelled: matches!(reason, AbortReason::Signal),
				timed_out: matches!(reason, AbortReason::Timeout),
				minimized: None,
				working_dir: None,
			});
		},
	};

	process_cancel_bridge.abort();
	let _ = process_cancel_bridge.await;
	let res = run_result
		.unwrap_or_else(|err| Err(Error::msg(format!("Shell execution task failed: {err}"))));
	let (exec, working_dir) = res?;
	Ok(ShellExecuteResult {
		exit_code: Some(exit_code(&exec)),
		cancelled: false,
		timed_out: false,
		working_dir,
		minimized: None,
	})
}

fn null_file() -> Result<OpenFile> {
	openfiles::null().map_err(|err| Error::msg(format!("Failed to create null file: {err}")))
}

const fn exit_code(result: &ExecutionResult) -> i32 {
	match result.exit_code {
		ExecutionExitCode::Success => 0,
		ExecutionExitCode::GeneralError => 1,
		ExecutionExitCode::InvalidUsage => 2,
		ExecutionExitCode::Unimplemented => 99,
		ExecutionExitCode::CannotExecute => 126,
		ExecutionExitCode::NotFound => 127,
		ExecutionExitCode::Interrupted => 130,
		ExecutionExitCode::BrokenPipe => 141,
		ExecutionExitCode::Custom(code) => code as i32,
	}
}

#[cfg(windows)]
const fn normalize_env_key(key: &str) -> &str {
	if key.eq_ignore_ascii_case("PATH") {
		"PATH"
	} else {
		key
	}
}

#[cfg(not(windows))]
const fn normalize_env_key(key: &str) -> &str {
	key
}

#[cfg(windows)]
fn merge_path_values(existing: &str, incoming: &str) -> String {
	let mut merged = Vec::new();
	let mut seen = HashSet::new();
	push_unique_paths(&mut merged, &mut seen, existing);
	push_unique_paths(&mut merged, &mut seen, incoming);

	std::env::join_paths(merged.iter())
		.map_or_else(|_| merged.join(";"), |paths| paths.to_string_lossy().into_owned())
}

#[cfg(windows)]
fn push_unique_paths(merged: &mut Vec<String>, seen: &mut HashSet<String>, value: &str) {
	for segment in std::env::split_paths(value) {
		let segment_str = segment.to_string_lossy().into_owned();
		let normalized = normalize_path_segment(&segment_str);
		if normalized.is_empty() {
			continue;
		}
		if seen.insert(normalized) {
			merged.push(segment_str);
		}
	}
}

#[cfg(windows)]
fn normalize_path_segment(segment: &str) -> String {
	let trimmed = segment.trim().trim_matches('"');
	if trimmed.is_empty() {
		return String::new();
	}

	let mut normalized = std::path::PathBuf::new();
	for component in std::path::Path::new(trimmed).components() {
		normalized.push(component.as_os_str());
	}

	normalized.to_string_lossy().to_ascii_lowercase()
}

#[cfg(not(windows))]
fn merge_path_values(_existing: &str, incoming: &str) -> String {
	incoming.to_string()
}

#[cfg(test)]
async fn create_session(config: &ShellConfig) -> Result<ShellSessionCore> {
	create_session_for_run(config, None, None).await
}

async fn create_session_for_run(
	config: &ShellConfig,
	spawn_registry: Option<Arc<process::SpawnRegistry>>,
	cancel_token: Option<CancellationToken>,
) -> Result<ShellSessionCore> {
	let mut shell = BrushShell::builder()
		.do_not_inherit_env(true)
		.profile(ProfileLoadBehavior::Skip)
		.rc(RcLoadBehavior::Skip)
		.builtins(default_builtins(BuiltinSet::BashMode))
		.build()
		.await
		.map_err(|err| Error::msg(format!("Failed to initialize shell: {err}")))?;

	if let Some(exec_builtin) = shell.builtin_mut("exec") {
		exec_builtin.disabled = true;
	}
	if let Some(suspend_builtin) = shell.builtin_mut("suspend") {
		suspend_builtin.disabled = true;
	}
	shell.register_builtin("sleep", builtins::builtin::<SleepCommand, _>());
	shell.register_builtin("timeout", builtins::builtin::<TimeoutCommand, _>());
	shell.register_builtin("ps", builtins::builtin::<PsCommand, _>());
	shell.register_builtin("top", builtins::builtin::<TopCommand, _>());
	shell.register_builtin("pgrep", builtins::builtin::<ProcMatchCommand, _>());
	shell.register_builtin("pkill", builtins::builtin::<ProcMatchCommand, _>());
	shell.register_builtin("pidwait", builtins::builtin::<ProcMatchCommand, _>());
	shell.register_builtin("kill", builtins::builtin::<KillCommand, _>());
	// In-process uutils-backed builtins (vendored + patched): consistent,
	// cross-platform implementations that run without spawning a process and
	// resolve paths against the shell working directory. The whole set can be
	// disabled (falling back to system binaries) via PI_DISABLE_UUTILS_BUILTINS;
	// the destructive pair additionally honors PI_DISABLE_UUTILS_DESTRUCTIVE.
	if !uutils_env_disabled(config, "PI_DISABLE_UUTILS_BUILTINS") {
		shell.register_builtin("mkdir", crate::coreutils::mkdir_builtin());
		shell.register_builtin("head", crate::coreutils::head_builtin());
		shell.register_builtin("tail", crate::coreutils::tail_builtin());
		shell.register_builtin("wc", crate::coreutils::wc_builtin());
		shell.register_builtin("sort", crate::coreutils::sort_builtin());
		shell.register_builtin("ls", crate::coreutils::ls_builtin());
		shell.register_builtin("find", crate::coreutils::find_builtin());
		shell.register_builtin("grep", crate::coreutils::grep_builtin());
		shell.register_builtin("rg", crate::coreutils::rg_builtin());
		shell.register_builtin("fd", crate::fd::fd_builtin());
		shell.register_builtin("cat", crate::coreutils::cat_builtin());
		shell.register_builtin("uniq", crate::coreutils::uniq_builtin());
		shell.register_builtin("base64", crate::coreutils::base64_builtin());
		shell.register_builtin("cmp", crate::coreutils::cmp_builtin());
		shell.register_builtin("md5sum", crate::coreutils::md5sum_builtin());
		shell.register_builtin("sha1sum", crate::coreutils::sha1sum_builtin());
		shell.register_builtin("sha224sum", crate::coreutils::sha224sum_builtin());
		shell.register_builtin("sha256sum", crate::coreutils::sha256sum_builtin());
		shell.register_builtin("sha384sum", crate::coreutils::sha384sum_builtin());
		shell.register_builtin("sha512sum", crate::coreutils::sha512sum_builtin());
		shell.register_builtin("b2sum", crate::coreutils::b2sum_builtin());
		shell.register_builtin("basename", crate::coreutils::basename_builtin());
		shell.register_builtin("dirname", crate::coreutils::dirname_builtin());
		shell.register_builtin("readlink", crate::coreutils::readlink_builtin());
		shell.register_builtin("realpath", crate::coreutils::realpath_builtin());
		shell.register_builtin("touch", crate::coreutils::touch_builtin());
		shell.register_builtin("stat", crate::coreutils::stat_builtin());
		shell.register_builtin("date", crate::coreutils::date_builtin());
		shell.register_builtin("mktemp", crate::coreutils::mktemp_builtin());
		shell.register_builtin("seq", crate::coreutils::seq_builtin());
		shell.register_builtin("yes", crate::coreutils::yes_builtin());
		shell.register_builtin("printenv", crate::coreutils::printenv_builtin());
		shell.register_builtin("truncate", crate::coreutils::truncate_builtin());
		shell.register_builtin("tac", crate::coreutils::tac_builtin());
		shell.register_builtin("nproc", crate::coreutils::nproc_builtin());
		shell.register_builtin("uname", crate::coreutils::uname_builtin());
		shell.register_builtin("whoami", crate::coreutils::whoami_builtin());
		shell.register_builtin("hostname", crate::coreutils::hostname_builtin());
		shell.register_builtin("which", crate::which::which_builtin());
		shell.register_builtin("diff", crate::coreutils::diff_builtin());
		shell.register_builtin("cut", crate::coreutils::cut_builtin());
		shell.register_builtin("tee", crate::coreutils::tee_builtin());
		shell.register_builtin("tr", crate::coreutils::tr_builtin());
		shell.register_builtin("paste", crate::coreutils::paste_builtin());
		shell.register_builtin("comm", crate::coreutils::comm_builtin());
		shell.register_builtin("sed", crate::coreutils::sed_builtin());
		shell.register_builtin("xargs", crate::coreutils::xargs_builtin());
		shell.register_builtin("jq", crate::coreutils::jq_builtin());
		// moreutils-inspired in-process builtins (see crate::moreutils).
		shell.register_builtin("ts", crate::coreutils::ts_builtin());
		shell.register_builtin("sponge", crate::coreutils::sponge_builtin());
		shell.register_builtin("ifne", crate::coreutils::ifne_builtin());
		shell.register_builtin("isutf8", crate::coreutils::isutf8_builtin());
		shell.register_builtin("combine", crate::coreutils::combine_builtin());
		#[cfg(unix)]
		shell.register_builtin("errno", crate::coreutils::errno_builtin());
		if !uutils_env_disabled(config, "PI_DISABLE_UUTILS_DESTRUCTIVE") {
			if !uutils_env_disabled(config, "PI_DISABLE_RM_BUILTIN") {
				shell.register_builtin("rm", crate::coreutils::rm_builtin());
			}
			if !uutils_env_disabled(config, "PI_DISABLE_MV_BUILTIN") {
				shell.register_builtin("mv", crate::coreutils::mv_builtin());
			}
			// ln can clobber existing files via -f; gate it with the destructive set.
			shell.register_builtin("ln", crate::coreutils::ln_builtin());
		}
	}

	let mut merged_path: Option<String> = None;
	for (key, value) in std::env::vars() {
		let normalized_key = normalize_env_key(&key);
		if should_skip_env_var(normalized_key) {
			continue;
		}
		if normalized_key == "PATH" {
			merged_path = Some(match merged_path {
				Some(existing) => merge_path_values(&existing, &value),
				None => value,
			});
			continue;
		}
		let mut var = ShellVariable::new(ShellValue::String(value));
		var.export();
		shell
			.env_mut()
			.set_global(normalized_key, var)
			.map_err(|err| Error::msg(format!("Failed to set env: {err}")))?;
	}

	#[cfg(windows)]
	if merged_path.is_none()
		&& let Some(value) = std::env::var_os("Path").or_else(|| std::env::var_os("PATH"))
	{
		merged_path = Some(value.to_string_lossy().into_owned());
	}

	if let Some(path_value) = &merged_path {
		let mut var = ShellVariable::new(ShellValue::String(path_value.clone()));
		var.export();
		shell
			.env_mut()
			.set_global("PATH", var)
			.map_err(|err| Error::msg(format!("Failed to set env: {err}")))?;
	}

	if let Some(env) = config.session_env.as_ref() {
		for (key, value) in env {
			let normalized_key = normalize_env_key(key);
			if should_skip_env_var(normalized_key) {
				continue;
			}
			let mut var = ShellVariable::new(ShellValue::String(value.clone()));
			var.export();
			shell
				.env_mut()
				.set_global(normalized_key, var)
				.map_err(|err| Error::msg(format!("Failed to set env: {err}")))?;
		}
	}
	apply_env_fallback(&mut shell)?;
	// The nohup builtin detaches its operand into a new session (see
	// NohupCommand) so a backgrounded server survives this embedded shell's
	// kill-on-drop teardown. It therefore shadows any system `nohup` (which does
	// NOT escape the process-group kill) — unless explicitly opted out via
	// PI_DISABLE_NOHUP_BUILTIN (session env or process env), in which case bare
	// `nohup` resolves to the real coreutils binary.
	let nohup_builtin_disabled = {
		let raw = config
			.session_env
			.as_ref()
			.and_then(|env| env.get("PI_DISABLE_NOHUP_BUILTIN").cloned())
			.or_else(|| std::env::var("PI_DISABLE_NOHUP_BUILTIN").ok());
		matches!(raw.as_deref(), Some(v) if !v.is_empty() && v != "0" && !v.eq_ignore_ascii_case("false"))
	};
	let should_register_nohup = !nohup_builtin_disabled;
	if should_register_nohup {
		shell.register_builtin(
			"nohup",
			builtins::builtin::<NohupCommand, _>().transparent_background_wrapper(),
		);
	}

	#[cfg(windows)]
	configure_windows_path(&mut shell)?;

	if let Some(snapshot_path) = config.snapshot_path.as_ref() {
		source_snapshot(&mut shell, snapshot_path, spawn_registry, cancel_token).await?;
	}

	Ok(ShellSessionCore { shell })
}

async fn source_snapshot(
	shell: &mut BrushShell,
	snapshot_path: &str,
	spawn_registry: Option<Arc<process::SpawnRegistry>>,
	cancel_token: Option<CancellationToken>,
) -> Result<()> {
	let mut params = shell.default_exec_params();
	let source_info = SourceInfo::from("pi-natives:snapshot");
	params.set_fd(OpenFiles::STDIN_FD, null_file()?);
	params.set_fd(OpenFiles::STDOUT_FD, null_file()?);
	params.set_fd(OpenFiles::STDERR_FD, null_file()?);
	if let Some(cancel_token) = cancel_token {
		params.set_cancel_token(cancel_token);
	}
	if let Some(spawn_registry) = spawn_registry {
		params.set_spawn_observer(spawn_registry);
	}

	let escaped = snapshot_path.replace('\'', "'\\''");
	let command = format!("source '{escaped}'");
	shell
		.run_string(command, &source_info, &params)
		.await
		.map_err(|err| Error::msg(format!("Failed to source snapshot: {err}")))?;
	Ok(())
}

#[derive(Clone, Copy)]
enum CommandCaptureMode {
	Streaming,
	Buffered { max_capture_bytes: usize },
}

struct CommandRunOutput {
	result:   ExecutionResult,
	buffered: Option<BufferedOutput>,
}

struct ChainCapture {
	original_text: String,
	text:          String,
	input_bytes:   usize,
	changed:       bool,
}

impl ChainCapture {
	const fn new() -> Self {
		Self {
			original_text: String::new(),
			text:          String::new(),
			input_bytes:   0,
			changed:       false,
		}
	}

	fn push(&mut self, original: &str, original_input_bytes: usize, minimized: &str, changed: bool) {
		self.original_text.push_str(original);
		self.text.push_str(minimized);
		self.input_bytes = self.input_bytes.saturating_add(original_input_bytes);
		self.changed |= changed;
	}
}

async fn run_shell_command(
	session: &mut ShellSessionCore,
	options: &ShellRunConfig,
	on_chunk: Option<Sender<String>>,
	cancel_token: CancellationToken,
	spawn_registry: Arc<process::SpawnRegistry>,
) -> Result<(ExecutionResult, Option<MinimizerResult>, Option<String>)> {
	if let Some(cwd) = options.cwd.as_deref() {
		set_shell_working_dir_if_changed(&mut session.shell, cwd)?;
	}

	let env_scope_pushed = apply_command_env(&mut session.shell, options.env.as_ref())?;

	let minimizer_mode = if let Some(config) = options.minimizer.as_ref() {
		minimizer::engine::mode_for(&options.command, config)
	} else {
		minimizer::engine::MinimizerMode::None
	};

	let result = match minimizer_mode {
		minimizer::engine::MinimizerMode::SegmentedChain => {
			run_shell_command_segmented_chain(session, options, on_chunk, cancel_token, spawn_registry)
				.await
		},
		minimizer::engine::MinimizerMode::WholeCommand | minimizer::engine::MinimizerMode::None => {
			run_shell_command_single(
				session,
				options,
				on_chunk,
				cancel_token,
				spawn_registry,
				minimizer_mode,
			)
			.await
		},
	};

	if env_scope_pushed {
		session
			.shell
			.env_mut()
			.pop_scope(EnvironmentScope::Command)
			.map_err(|err| Error::msg(format!("Failed to pop env scope: {err}")))?;
	}

	result.map(|(exec, minimized)| {
		let working_dir = Some(session.shell.working_dir().to_string_lossy().into_owned());
		(exec, minimized, working_dir)
	})
}

async fn run_shell_command_single(
	session: &mut ShellSessionCore,
	options: &ShellRunConfig,
	on_chunk: Option<Sender<String>>,
	cancel_token: CancellationToken,
	spawn_registry: Arc<process::SpawnRegistry>,
	minimizer_mode: minimizer::engine::MinimizerMode,
) -> Result<(ExecutionResult, Option<MinimizerResult>)> {
	debug_assert!(!matches!(minimizer_mode, minimizer::engine::MinimizerMode::SegmentedChain));

	let params = session.shell.default_exec_params();
	let capture_mode = match minimizer_mode {
		minimizer::engine::MinimizerMode::WholeCommand => {
			let Some(config) = options.minimizer.as_ref() else {
				return Err(Error::msg("Missing minimizer config for whole-command mode"));
			};
			CommandCaptureMode::Buffered { max_capture_bytes: config.max_capture_bytes as usize }
		},
		minimizer::engine::MinimizerMode::None => CommandCaptureMode::Streaming,
		minimizer::engine::MinimizerMode::SegmentedChain => CommandCaptureMode::Streaming,
	};

	let command_run = run_shell_command_once(
		session,
		options.command.clone(),
		params,
		on_chunk,
		cancel_token,
		spawn_registry,
		capture_mode,
	)
	.await?;

	let mut minimized_out = None;
	if let Some(buffered) = command_run.buffered
		&& let Some(config) = options.minimizer.as_ref()
	{
		// When the capture cap is exceeded the output was streamed raw and never
		// buffered, so nothing was minimized — leave `minimized` absent, matching
		// every other passthrough path and `apply_shell_minimizer`. Previously a
		// `too-large` result with empty `text`/`original_text` was emitted, which a
		// consumer keying off `minimized` presence could mistake for a real rewrite
		// that produced empty output.
		if !buffered.exceeded {
			let minimized = match minimizer_mode {
				minimizer::engine::MinimizerMode::WholeCommand => minimizer::apply(
					&options.command,
					&buffered.text,
					exit_code(&command_run.result),
					config,
				),
				minimizer::engine::MinimizerMode::None => {
					minimizer::MinimizerOutput::passthrough(&buffered.text)
				},
				minimizer::engine::MinimizerMode::SegmentedChain => {
					minimizer::MinimizerOutput::passthrough(&buffered.text)
				},
			};
			// Surface telemetry only when the filter actually rewrote the output
			// and kept the original buffer — same contract as `apply_shell_minimizer`
			// in `pi-natives`. A supported filter that runs but leaves the output
			// unchanged (e.g. a short `git diff --name-only`) reports `changed:
			// false` with no `original_text` and must NOT set `minimized`, or API
			// consumers keying off `result.minimized` are misled. The separate
			// `too-large` reason path above is unaffected.
			if minimized.changed
				&& let Some(original_text) = minimized.original_text
			{
				let output_bytes = u32::try_from(minimized.text.len()).unwrap_or(u32::MAX);
				minimized_out = Some(MinimizerResult {
					filter: minimized.filter.to_string(),
					text: minimized.text,
					original_text,
					input_bytes: u32::try_from(minimized.input_bytes).unwrap_or(u32::MAX),
					output_bytes,
				});
			}
		}
	}

	Ok((command_run.result, minimized_out))
}

async fn run_shell_command_segmented_chain(
	session: &mut ShellSessionCore,
	options: &ShellRunConfig,
	on_chunk: Option<Sender<String>>,
	cancel_token: CancellationToken,
	spawn_registry: Arc<process::SpawnRegistry>,
) -> Result<(ExecutionResult, Option<MinimizerResult>)> {
	let Some(config) = options.minimizer.as_ref() else {
		return run_shell_command_single(
			session,
			options,
			on_chunk,
			cancel_token,
			spawn_registry,
			minimizer::engine::MinimizerMode::None,
		)
		.await;
	};

	// When minimizer is disabled, don't segment — stream the original single path.
	if !config.enabled {
		return run_shell_command_single(
			session,
			options,
			on_chunk,
			cancel_token,
			spawn_registry,
			minimizer::engine::MinimizerMode::None,
		)
		.await;
	}

	let minimizer::plan::CommandPlan::Chain { segments } =
		minimizer::plan::analyze(&options.command)
	else {
		return run_shell_command_single(
			session,
			options,
			on_chunk,
			cancel_token,
			spawn_registry,
			minimizer::engine::MinimizerMode::None,
		)
		.await;
	};

	let params = session.shell.default_exec_params();
	let mut aggregate = Some(ChainCapture::new());
	let mut previous_succeeded = true;
	let mut last_result = None;
	let max_capture_bytes = config.max_capture_bytes as usize;
	for segment in segments {
		if segment.run_if_previous_succeeded && !previous_succeeded {
			continue;
		}

		let mut segment_params = params.clone();
		segment_params.suppress_errexit = segment.suppress_errexit;
		let capture_mode = if aggregate.is_some() {
			CommandCaptureMode::Buffered { max_capture_bytes }
		} else {
			CommandCaptureMode::Streaming
		};

		let command_run = run_shell_command_once(
			session,
			segment.command.clone(),
			segment_params,
			on_chunk.clone(),
			cancel_token.clone(),
			spawn_registry.clone(),
			capture_mode,
		)
		.await?;

		let exit = exit_code(&command_run.result);
		previous_succeeded = exit == 0;

		if let Some(buffered) = command_run.buffered {
			if buffered.exceeded {
				// Cap exceeded mid-chain: output streamed raw, drop the buffered
				// aggregate so the remaining segments stream too. No minimization
				// happened, so we emit no `minimized` telemetry (see below).
				aggregate = None;
			} else if let Some(capture) = aggregate.as_mut() {
				let next_input_bytes = capture.input_bytes.saturating_add(buffered.input_bytes);
				if next_input_bytes > max_capture_bytes {
					aggregate = None;
				} else {
					let minimized = minimizer::apply(&segment.command, &buffered.text, exit, config);
					capture.push(
						&buffered.text,
						buffered.input_bytes,
						&minimized.text,
						minimized.changed,
					);
				}
			}
		} else if aggregate.is_some() {
			aggregate = None;
		}

		let keep_running = session_keepalive(&command_run.result) && !cancel_token.is_cancelled();
		last_result = Some(command_run.result);
		if !keep_running {
			break;
		}
	}

	let Some(result) = last_result else {
		return Err(Error::msg("Segmented chain executed no segments"));
	};

	let minimized_out = aggregate
		// Only surface telemetry when the segmented chain actually rewrote the
		// output; a `chain-noop` capture (`changed == false`) must yield `None`,
		// matching the public `ShellRunResult.minimized` contract.
		.filter(|capture| capture.changed)
		.map(|capture| {
			let minimized = minimizer::chain_output(
				capture.text,
				capture.original_text,
				capture.input_bytes,
				capture.changed,
			);
			MinimizerResult {
				filter:        minimized.filter.to_string(),
				text:          minimized.text,
				original_text: minimized.original_text.unwrap_or_default(),
				input_bytes:   u32::try_from(minimized.input_bytes).unwrap_or(u32::MAX),
				output_bytes:  u32::try_from(minimized.output_bytes).unwrap_or(u32::MAX),
			}
		});
	// A chain that overflowed the aggregate cap streamed its output raw and was
	// not minimized — `minimized_out` stays `None`, matching the whole-command
	// path and `apply_shell_minimizer`. (Previously a `too-large` result with
	// empty `text` was emitted, a footgun for consumers keying off presence.)

	Ok((result, minimized_out))
}

async fn run_shell_command_once(
	session: &mut ShellSessionCore,
	mut command: String,
	mut params: ExecutionParameters,
	on_chunk: Option<Sender<String>>,
	cancel_token: CancellationToken,
	spawn_registry: Arc<process::SpawnRegistry>,
	capture_mode: CommandCaptureMode,
) -> Result<CommandRunOutput> {
	let (reader_file, writer_file) = pipe_to_files("output")?;

	let stdout_file = OpenFile::from(
		writer_file
			.try_clone()
			.map_err(|err| Error::msg(format!("Failed to clone pipe: {err}")))?,
	);
	let stderr_file = OpenFile::from(writer_file);

	params.set_fd(OpenFiles::STDIN_FD, null_file()?);
	params.set_fd(OpenFiles::STDOUT_FD, stdout_file);
	params.set_fd(OpenFiles::STDERR_FD, stderr_file);
	params.process_group_policy = ProcessGroupPolicy::NewProcessGroup;
	params.set_cancel_token(cancel_token.clone());
	params.set_spawn_observer(spawn_registry.clone());
	let reader_cancel = CancellationToken::new();
	let (activity_tx, activity_rx) = flume::bounded::<()>(1);
	let reader_callback = on_chunk;
	let mut reader_handle = tokio::spawn({
		let reader_cancel = reader_cancel.clone();
		async move {
			match capture_mode {
				CommandCaptureMode::Buffered { max_capture_bytes } => {
					let output = read_output_buffered(
						reader_file,
						reader_callback,
						reader_cancel,
						activity_tx,
						max_capture_bytes,
					)
					.await;
					Result::<OutputRead>::Ok(OutputRead::Buffered(output))
				},
				CommandCaptureMode::Streaming => {
					Box::pin(read_output(reader_file, reader_callback, reader_cancel, activity_tx))
						.await;
					Result::<OutputRead>::Ok(OutputRead::Streaming)
				},
			}
		}
	});
	// Let pipeline consumers flush output after cancellation kills their
	// producers. The outer run cancellation remains bounded, and this delayed
	// fallback still releases readers whose writers never close.
	const CANCEL_READER_GRACE: Duration = Duration::from_millis(500);
	let cancel_bridge = tokio::spawn({
		let cancel_token = cancel_token.clone();
		let reader_cancel = reader_cancel.clone();
		async move {
			cancel_token.cancelled().await;
			time::sleep(CANCEL_READER_GRACE).await;
			reader_cancel.cancel();
		}
	});
	ensure_trailing_newline_for_heredoc(&mut command);
	let source_info = SourceInfo::from("pi-natives:command");
	let result = session
		.shell
		.run_string(command, &source_info, &params)
		.await;

	if cancel_token.is_cancelled() {
		terminate_background_jobs(&mut session.shell);
	}

	drop(params);

	// The foreground command can complete while background jobs keep the
	// stdout/stderr pipe open. Don't hang forever waiting for EOF; drain output
	// for a short period, then cancel.
	const POST_EXIT_IDLE: Duration = Duration::from_millis(250);
	const POST_EXIT_MAX: Duration = Duration::from_secs(2);
	const READER_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(250);

	let mut reader_finished = false;
	let mut reader_output = None;
	let mut idle_timer = Box::pin(time::sleep(POST_EXIT_IDLE));
	let mut max_timer = Box::pin(time::sleep(POST_EXIT_MAX));

	loop {
		tokio::select! {
			res = &mut reader_handle => {
				if let Ok(Ok(output)) = res {
					reader_output = Some(output);
				}
				reader_finished = true;
				break;
			}
			msg = activity_rx.recv_async() => {
				if msg.is_err() {
					break;
				}
				idle_timer.as_mut().reset(time::Instant::now() + POST_EXIT_IDLE);
			}
			() = &mut idle_timer => break,
			() = &mut max_timer => break,
		}
	}

	if !reader_finished {
		reader_cancel.cancel();
		match time::timeout(READER_SHUTDOWN_TIMEOUT, &mut reader_handle).await {
			Ok(Ok(Ok(output))) => reader_output = Some(output),
			Ok(_) => {},
			Err(_) => {
				reader_handle.abort();
				let _ = reader_handle.await;
			},
		}
	}
	cancel_bridge.abort();
	let _ = cancel_bridge.await;

	let result = result.map_err(|err| Error::msg(format!("Shell execution failed: {err}")))?;
	let buffered = match reader_output {
		Some(OutputRead::Buffered(output)) => Some(output),
		Some(OutputRead::Streaming) | None => None,
	};
	Ok(CommandRunOutput { result, buffered })
}

async fn run_shell_command_streams(
	session: &mut ShellSessionCore,
	options: &ShellRunConfig,
	streams: StreamSinks,
	cancel_token: CancellationToken,
	spawn_registry: Arc<process::SpawnRegistry>,
) -> Result<(ExecutionResult, Option<String>)> {
	if let Some(cwd) = options.cwd.as_deref() {
		set_shell_working_dir_if_changed(&mut session.shell, cwd)?;
	}

	let env_scope_pushed = apply_command_env(&mut session.shell, options.env.as_ref())?;

	let (stdout_reader, stdout_writer) = pipe_to_files("stdout")?;
	let (stderr_reader, stderr_writer) = pipe_to_files("stderr")?;

	let stdout_file = OpenFile::from(stdout_writer);
	let stderr_file = OpenFile::from(stderr_writer);

	let mut params = session.shell.default_exec_params();
	params.set_fd(OpenFiles::STDIN_FD, null_file()?);
	params.set_fd(OpenFiles::STDOUT_FD, stdout_file);
	params.set_fd(OpenFiles::STDERR_FD, stderr_file);
	params.process_group_policy = ProcessGroupPolicy::NewProcessGroup;
	params.set_cancel_token(cancel_token.clone());
	params.set_spawn_observer(spawn_registry.clone());
	let reader_cancel = CancellationToken::new();
	let (activity_tx, activity_rx) = flume::bounded::<()>(1);

	let StreamSinks { stdout: stdout_sink, stderr: stderr_sink } = streams;
	let mut stdout_handle = tokio::spawn(Box::pin(read_output_bytes(
		stdout_reader,
		stdout_sink,
		reader_cancel.clone(),
		activity_tx.clone(),
	)));
	let mut stderr_handle = tokio::spawn(Box::pin(read_output_bytes(
		stderr_reader,
		stderr_sink,
		reader_cancel.clone(),
		activity_tx,
	)));

	let cancel_bridge = tokio::spawn({
		let cancel_token = cancel_token.clone();
		let reader_cancel = reader_cancel.clone();
		async move {
			cancel_token.cancelled().await;
			reader_cancel.cancel();
		}
	});
	let mut command = options.command.clone();
	ensure_trailing_newline_for_heredoc(&mut command);
	let source_info = SourceInfo::from("pi-shell:streams");
	let result = session
		.shell
		.run_string(command, &source_info, &params)
		.await;

	if cancel_token.is_cancelled() {
		terminate_background_jobs(&mut session.shell);
	}

	if env_scope_pushed {
		session
			.shell
			.env_mut()
			.pop_scope(EnvironmentScope::Command)
			.map_err(|err| Error::msg(format!("Failed to pop env scope: {err}")))?;
	}

	drop(params);

	const POST_EXIT_IDLE: Duration = Duration::from_millis(250);
	const POST_EXIT_MAX: Duration = Duration::from_secs(2);
	const READER_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(250);

	let mut stdout_finished = false;
	let mut stderr_finished = false;
	let mut idle_timer = Box::pin(time::sleep(POST_EXIT_IDLE));
	let mut max_timer = Box::pin(time::sleep(POST_EXIT_MAX));

	loop {
		if stdout_finished && stderr_finished {
			break;
		}
		tokio::select! {
			res = &mut stdout_handle, if !stdout_finished => {
				let _ = res;
				stdout_finished = true;
			}
			res = &mut stderr_handle, if !stderr_finished => {
				let _ = res;
				stderr_finished = true;
			}
			msg = activity_rx.recv_async() => {
				if msg.is_err() {
					break;
				}
				idle_timer.as_mut().reset(time::Instant::now() + POST_EXIT_IDLE);
			}
			() = &mut idle_timer => break,
			() = &mut max_timer => break,
		}
	}

	if !stdout_finished || !stderr_finished {
		reader_cancel.cancel();
	}
	if !stdout_finished
		&& time::timeout(READER_SHUTDOWN_TIMEOUT, &mut stdout_handle)
			.await
			.is_err()
	{
		stdout_handle.abort();
		let _ = stdout_handle.await;
	}
	if !stderr_finished
		&& time::timeout(READER_SHUTDOWN_TIMEOUT, &mut stderr_handle)
			.await
			.is_err()
	{
		stderr_handle.abort();
		let _ = stderr_handle.await;
	}
	cancel_bridge.abort();
	let _ = cancel_bridge.await;

	let result = result.map_err(|err| Error::msg(format!("Shell execution failed: {err}")))?;
	let working_dir = Some(session.shell.working_dir().to_string_lossy().into_owned());
	Ok((result, working_dir))
}

async fn read_output_bytes(
	reader: fs::File,
	sink: Option<Sender<Bytes>>,
	cancel_token: CancellationToken,
	activity: Sender<()>,
) {
	const BUF: usize = 65536;

	#[cfg(unix)]
	let Ok(reader) = register_nonblocking_pipe(reader) else {
		return;
	};
	#[cfg(not(unix))]
	let mut reader = tokio::fs::File::from_std(reader);

	loop {
		let mut buf = vec![0u8; BUF];
		#[cfg(unix)]
		let n = {
			let Ok(mut readiness) = (tokio::select! {
				ready = reader.readable() => ready,
				() = cancel_token.cancelled() => break,
			}) else {
				break;
			};
			match readiness.try_io(|inner| read_nonblocking(inner.get_ref(), &mut buf)) {
				Ok(Ok(0)) => break,
				Ok(Ok(n)) => n,
				Ok(Err(e)) if e.kind() == io::ErrorKind::Interrupted => continue,
				Ok(Err(_)) => break,
				Err(_would_block) => continue,
			}
		};
		#[cfg(not(unix))]
		let n = {
			let read_future = reader.read(&mut buf);
			tokio::pin!(read_future);
			match tokio::select! {
				res = &mut read_future => res,
				() = cancel_token.cancelled() => break,
			} {
				Ok(0) => break,
				Ok(n) => n,
				Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
				Err(_) => break,
			}
		};
		let _ = activity.try_send(());
		buf.truncate(n);
		if let Some(sink) = sink.as_ref()
			&& sink.send(Bytes::from(buf)).is_err()
		{
			// Receiver dropped — stop forwarding and let the pipe close.
			break;
		}
	}
}

impl SpawnObserver for process::SpawnRegistry {
	fn on_spawn(&self, pid: i32, pgid: Option<i32>) {
		// Pin a stable process reference *now*, before the pid can be recycled.
		// On Windows an open handle keeps the pid slot reserved for the lifetime
		// of the handle; on Linux the pidfd carries identity; on macOS the
		// recorded start-time triple detects impersonation. Deferring the open
		// to `build_targets` (as the old code did) let a recycled pid resolve
		// to an unrelated process — issue #4605.
		let process = process::Process::from_pid(pid);
		self.record(pgid, process);
	}
}

// Escalating TERM -> KILL waves over the processes this run spawned, scoped via
// the per-run `SpawnRegistry`. The kill set is rebuilt each wave so a child
// spawned in a grace window — or a grandchild whose recorded parent already
// exited but whose process group is still live — is still reaped, and the loop
// stops as soon as the run's whole tree is gone. Scoping to the registry (vs a
// process-global descendant diff) is what keeps a cancel from reaping a
// concurrent run's children in a shared host process.
async fn terminate_run(registry: &process::SpawnRegistry) {
	const WAVES: u32 = 3;
	let mut saw_targets = false;
	for wave in 0..WAVES {
		let targets = registry.build_targets();
		if targets.is_empty() {
			if saw_targets || wave + 1 == WAVES {
				return;
			}
		} else {
			saw_targets = true;
			let signal = if wave == 0 {
				process::TERM_SIGNAL
			} else {
				process::KILL_SIGNAL
			};
			targets.signal(signal);
		}
		if wave + 1 < WAVES {
			let pause = if wave == 0 {
				Duration::from_millis(75)
			} else {
				Duration::from_millis(150)
			};
			time::sleep(pause).await;
		}
	}
}
fn terminate_background_jobs(shell: &mut BrushShell) {
	let mut targets = process::TerminationTargets::new();
	for job in &mut shell.jobs_mut().jobs {
		job.abort_internal_tasks();
		if let Some(pgid) = job.process_group_id() {
			targets.add_pgid(pgid);
		}
		if let Some(pid) = job.representative_pid() {
			targets.add_pid(pid);
		}
	}
	if targets.is_empty() {
		// Shell-internal jobs were aborted above. Pure descendant cleanup is
		// handled by `process_cancel_bridge` while the cancel was in flight;
		// without job-tracked pgids or pids there is nothing else to signal here.
		return;
	}

	targets.signal(process::TERM_SIGNAL);
	tokio::spawn(async move {
		time::sleep(Duration::from_millis(150)).await;
		targets.signal(process::KILL_SIGNAL);
	});
}

/// Apply per-command environment variables onto a freshly pushed
/// `Command` scope. Returns `true` when a scope was pushed (so the caller
/// can pop it after the command runs), `false` when there were no vars and
/// the existing scopes remain untouched.
fn apply_command_env(
	shell: &mut BrushShell,
	env: Option<&HashMap<String, String>>,
) -> Result<bool> {
	let Some(env) = env else {
		return Ok(false);
	};
	shell.env_mut().push_scope(EnvironmentScope::Command);
	for (key, value) in env {
		let normalized_key = normalize_env_key(key);
		if should_skip_env_var(normalized_key) {
			continue;
		}
		let mut var = ShellVariable::new(ShellValue::String(value.clone()));
		var.export();
		if let Err(err) = shell
			.env_mut()
			.add(normalized_key, var, EnvironmentScope::Command)
		{
			let _ = shell.env_mut().pop_scope(EnvironmentScope::Command);
			return Err(Error::msg(format!("Failed to set env: {err}")));
		}
	}
	Ok(true)
}

/// Define `env` as a shell variable expanding to the literal `$env` so that
/// brush-core's POSIX parameter expansion preserves PowerShell-style
/// `$env:NAME` references when commands are dispatched through brush to a
/// PowerShell (or any) subprocess. The variable is not exported, so it only
/// influences brush's own expansion; the child process environment is
/// unaffected.
///
/// User-driven assignments (`env=prod; echo "$env:8080"`) push their own
/// binding in the command scope and shadow this global default, preserving
/// the bash POSIX contract for callers that genuinely use a variable named
/// `env`.
fn apply_env_fallback(shell: &mut BrushShell) -> Result<()> {
	if shell.env().get("env").is_some() {
		return Ok(());
	}
	let var = ShellVariable::new(ShellValue::String("$env".to_string()));
	shell
		.env_mut()
		.set_global("env", var)
		.map_err(|err| Error::msg(format!("Failed to set env fallback: {err}")))
}

fn is_macos_malloc_stack_logging_var(key: &str) -> bool {
	matches!(key, "MallocStackLogging" | "MallocStackLoggingNoCompact")
}

fn should_skip_env_var(key: &str) -> bool {
	if key.starts_with("BASH_FUNC_") && key.ends_with("%%") {
		return true;
	}
	if is_macos_malloc_stack_logging_var(key) {
		return true;
	}

	matches!(
		key,
		"BASH_ENV"
			| "ENV"
			| "HISTFILE"
			| "HISTTIMEFORMAT"
			| "HISTCMD"
			| "PS0"
			| "PS1"
			| "PS2"
			| "PS4"
			| "BRUSH_PS_ALT"
			| "READLINE_LINE"
			| "READLINE_POINT"
			| "BRUSH_VERSION"
			| "BASH"
			| "BASHOPTS"
			| "BASH_ALIASES"
			| "BASH_ARGV0"
			| "BASH_CMDS"
			| "BASH_SOURCE"
			| "BASH_SUBSHELL"
			| "BASH_VERSINFO"
			| "BASH_VERSION"
			| "SHELLOPTS"
			| "SHLVL"
			| "SHELL"
			| "COMP_WORDBREAKS"
			| "DIRSTACK"
			| "EPOCHREALTIME"
			| "EPOCHSECONDS"
			| "FUNCNAME"
			| "GROUPS"
			| "IFS"
			| "LINENO"
			| "MACHTYPE"
			| "OSTYPE"
			| "OPTERR"
			| "OPTIND"
			| "PIPESTATUS"
			| "PPID"
			| "PWD"
			| "OLDPWD"
			| "RANDOM"
			| "SRANDOM"
			| "SECONDS"
			| "UID"
			| "EUID"
			| "HOSTNAME"
			| "HOSTTYPE"
	)
}

fn ensure_trailing_newline_for_heredoc(command: &mut String) {
	if command.ends_with('\n') || !command.as_bytes().windows(2).any(|window| window == b"<<") {
		return;
	}
	command.push('\n');
}

const fn session_keepalive(result: &ExecutionResult) -> bool {
	match result.next_control_flow {
		ExecutionControlFlow::Normal => true,
		ExecutionControlFlow::BreakLoop { .. } => false,
		ExecutionControlFlow::ContinueLoop { .. } => false,
		ExecutionControlFlow::ReturnFromFunctionOrScript => false,
		ExecutionControlFlow::ExitShell => false,
	}
}

enum OutputRead {
	Streaming,
	Buffered(BufferedOutput),
}

struct BufferedOutput {
	text:        String,
	input_bytes: usize,
	exceeded:    bool,
}

async fn read_output(
	reader: fs::File,
	on_chunk: Option<Sender<String>>,
	cancel_token: CancellationToken,
	activity: Sender<()>,
) {
	const REPLACEMENT: &str = "\u{FFFD}";
	const BUF: usize = 65536;
	let mut buf = vec![0u8; BUF + 4]; // +4 for max UTF-8 char
	let mut it = 0;

	#[cfg(unix)]
	let Ok(reader) = register_nonblocking_pipe(reader) else {
		return;
	};
	#[cfg(not(unix))]
	let reader = tokio::fs::File::from_std(reader);
	#[cfg(not(unix))]
	tokio::pin!(reader);

	loop {
		#[cfg(unix)]
		let n = {
			let Ok(mut readiness) = (tokio::select! {
				ready = reader.readable() => ready,
				() = cancel_token.cancelled() => break,
			}) else {
				break;
			};
			match readiness.try_io(|inner| read_nonblocking(inner.get_ref(), &mut buf[it..BUF])) {
				Ok(Ok(0)) => break,
				Ok(Ok(n)) => n,
				Ok(Err(e)) if e.kind() == io::ErrorKind::Interrupted => continue,
				Ok(Err(_)) => break,
				Err(_would_block) => continue,
			}
		};
		#[cfg(not(unix))]
		let n = {
			let read_future = reader.read(&mut buf[it..BUF]);
			tokio::pin!(read_future);
			match tokio::select! {
				res = &mut read_future => res,
				() = cancel_token.cancelled() => break,
			} {
				Ok(0) => break, // EOF
				Ok(n) => n,
				Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
				Err(_) => break,
			}
		};
		if n > 0 {
			let _ = activity.try_send(());
		}
		it += n;

		// Consume as much of `pending` as is decodable *right now*.
		while it > 0 {
			let pending = &buf[..it];
			match str::from_utf8(pending) {
				Ok(text) => {
					emit_chunk(text, on_chunk.as_ref()).await;
					it = 0;
					break;
				},
				Err(err) => {
					let p = err.valid_up_to();
					if p > 0 {
						// SAFETY: [..p] is guaranteed valid UTF-8 by valid_up_to().
						let text = unsafe { str::from_utf8_unchecked(&pending[..p]) };
						emit_chunk(text, on_chunk.as_ref()).await;
						// copy p..it to the beginning of the buffer
						buf.copy_within(p..it, 0);
						it -= p;
					}

					match err.error_len() {
						Some(p) => {
							// Invalid byte sequence: emit replacement and drop those bytes.
							emit_chunk(REPLACEMENT, on_chunk.as_ref()).await;
							// copy p..it to the beginning of the buffer
							buf.copy_within(p..it, 0);
							it -= p;
							// continue loop in case more bytes remain after the
							// invalid sequence
						},
						None => {
							// Incomplete UTF-8 sequence at end: keep bytes for next read.
							break;
						},
					}
				},
			}
		}
	}

	// Flush whatever is left at EOF (including an incomplete final sequence).
	for chunk in buf[..it].utf8_chunks() {
		let valid = chunk.valid();
		if !valid.is_empty() {
			emit_chunk(valid, on_chunk.as_ref()).await;
		}
		if !chunk.invalid().is_empty() {
			emit_chunk(REPLACEMENT, on_chunk.as_ref()).await;
		}
	}
}

async fn read_output_buffered(
	reader: fs::File,
	on_chunk: Option<Sender<String>>,
	cancel_token: CancellationToken,
	activity: Sender<()>,
	max_capture_bytes: usize,
) -> BufferedOutput {
	const REPLACEMENT: &str = "\u{FFFD}";
	const BUF: usize = 65536;
	let mut buf = vec![0u8; BUF];
	let mut input_bytes = 0usize;
	let mut captured = Vec::new();
	let mut exceeded = false;
	// Pending bytes from a prior read that ended mid-UTF-8 sequence. We hold
	// them back so we emit only valid UTF-8 to the streaming callback while
	// still capturing every byte into `captured` for post-processing.
	let mut pending = Vec::<u8>::new();

	#[cfg(unix)]
	let Ok(reader) = register_nonblocking_pipe(reader) else {
		return BufferedOutput { text: String::new(), input_bytes: 0, exceeded: true };
	};
	#[cfg(not(unix))]
	let reader = tokio::fs::File::from_std(reader);
	#[cfg(not(unix))]
	tokio::pin!(reader);

	loop {
		#[cfg(unix)]
		let n = {
			let Ok(mut readiness) = (tokio::select! {
				ready = reader.readable() => ready,
				() = cancel_token.cancelled() => break,
			}) else {
				break;
			};
			match readiness.try_io(|inner| read_nonblocking(inner.get_ref(), &mut buf)) {
				Ok(Ok(0)) => break,
				Ok(Ok(n)) => n,
				Ok(Err(e)) if e.kind() == io::ErrorKind::Interrupted => continue,
				Ok(Err(_)) => break,
				Err(_would_block) => continue,
			}
		};
		#[cfg(not(unix))]
		let n = {
			let read_future = reader.read(&mut buf);
			tokio::pin!(read_future);
			match tokio::select! {
				res = &mut read_future => res,
				() = cancel_token.cancelled() => break,
			} {
				Ok(0) => break,
				Ok(n) => n,
				Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
				Err(_) => break,
			}
		};
		if n > 0 {
			let _ = activity.try_send(());
			input_bytes = input_bytes.saturating_add(n);
		}
		// Once `exceeded`, the post-process minimizer is bypassed (see the
		// `!output.exceeded` gate at the call site), so further appends just
		// grow `captured` without serving any purpose. Stop accumulating to
		// bound peak memory on commands that produce very large output.
		if !exceeded {
			if captured.len().saturating_add(n) > max_capture_bytes {
				exceeded = true;
			} else {
				captured.extend_from_slice(&buf[..n]);
			}
		}

		// Stream whatever is validly decodable *right now* to the callback,
		// carrying incomplete trailing UTF-8 bytes over to the next iteration.
		if let Some(cb) = on_chunk.as_ref() {
			pending.extend_from_slice(&buf[..n]);
			while !pending.is_empty() {
				match str::from_utf8(&pending) {
					Ok(text) => {
						emit_chunk(text, Some(cb)).await;
						pending.clear();
						break;
					},
					Err(err) => {
						let p = err.valid_up_to();
						if p > 0 {
							// SAFETY: [..p] is valid UTF-8 per valid_up_to().
							let text = unsafe { str::from_utf8_unchecked(&pending[..p]) };
							emit_chunk(text, Some(cb)).await;
							pending.drain(..p);
						}
						match err.error_len() {
							Some(skip) => {
								emit_chunk(REPLACEMENT, Some(cb)).await;
								pending.drain(..skip);
							},
							None => break,
						}
					},
				}
			}
		}
	}

	// Flush any trailing bytes the streaming decoder held back at EOF.
	if let Some(cb) = on_chunk.as_ref() {
		for chunk in pending.utf8_chunks() {
			let valid = chunk.valid();
			if !valid.is_empty() {
				emit_chunk(valid, Some(cb)).await;
			}
			if !chunk.invalid().is_empty() {
				emit_chunk(REPLACEMENT, Some(cb)).await;
			}
		}
	}

	BufferedOutput { text: String::from_utf8_lossy(&captured).into_owned(), input_bytes, exceeded }
}

#[cfg(unix)]
fn register_nonblocking_pipe(reader: fs::File) -> io::Result<tokio::io::unix::AsyncFd<fs::File>> {
	set_nonblocking(&reader)?;
	tokio::io::unix::AsyncFd::new(reader)
}

#[cfg(unix)]
fn set_nonblocking<T: std::os::fd::AsRawFd>(file: &T) -> io::Result<()> {
	let fd = file.as_raw_fd();
	// SAFETY: `fd` is owned by `file` and remains valid for the duration of
	// these `fcntl` calls.
	let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
	if flags < 0 {
		return Err(io::Error::last_os_error());
	}
	if flags & libc::O_NONBLOCK != 0 {
		return Ok(());
	}

	// SAFETY: `fd` remains valid here and we are only toggling `O_NONBLOCK`.
	let result = unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) };
	if result < 0 {
		Err(io::Error::last_os_error())
	} else {
		Ok(())
	}
}

#[cfg(unix)]
fn read_nonblocking<T: std::os::fd::AsRawFd>(file: &T, buf: &mut [u8]) -> io::Result<usize> {
	// SAFETY: `buf` is writable for `buf.len()` bytes, and the raw fd obtained
	// from `file` stays valid for the duration of the syscall.
	let read = unsafe { libc::read(file.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
	if read < 0 {
		Err(io::Error::last_os_error())
	} else {
		Ok(read as usize)
	}
}

/// Forward one decoded chunk to the streaming callback, honouring channel
/// backpressure: on a bounded channel (the pi-natives JS bridge) the send
/// parks until the consumer frees a slot — which parks the pipe reader and,
/// transitively, the child on its stdout/stderr pipe — so a fast producer
/// can never buffer unbounded output in memory (#4078). A disconnected
/// receiver (consumer gone) fails immediately, so the pipe keeps draining
/// and the child never wedges on a full pipe.
async fn emit_chunk(text: &str, callback: Option<&Sender<String>>) {
	if let Some(callback) = callback {
		let _ = callback.send_async(text.to_string()).await;
	}
}

fn pipe_to_files(label: &str) -> Result<(fs::File, fs::File)> {
	let (r, w) =
		os_pipe::pipe().map_err(|err| Error::msg(format!("Failed to create {label} pipe: {err}")))?;

	#[cfg(unix)]
	let (r, w): (fs::File, fs::File) = {
		use std::os::unix::io::{FromRawFd, IntoRawFd};
		let r = r.into_raw_fd();
		let w = w.into_raw_fd();
		// SAFETY: We just obtained these fds from os_pipe and own them exclusively.
		unsafe { (FromRawFd::from_raw_fd(r), FromRawFd::from_raw_fd(w)) }
	};

	#[cfg(windows)]
	let (r, w): (fs::File, fs::File) = {
		use std::os::windows::io::{FromRawHandle, IntoRawHandle};
		let r = r.into_raw_handle();
		let w = w.into_raw_handle();
		// SAFETY: We just obtained these handles from os_pipe and own them exclusively.
		unsafe { (FromRawHandle::from_raw_handle(r), FromRawHandle::from_raw_handle(w)) }
	};

	Ok((r, w))
}

#[cfg(target_os = "linux")]
mod proc_snapshot {
	use std::{
		fs,
		os::fd::{AsRawFd, FromRawFd, OwnedFd},
		time::Duration,
	};

	use crate::process::ProcessStatus;

	#[derive(Clone)]
	pub struct ProcInfo {
		pid:  i32,
		stat: Stat,
		args: Vec<String>,
		uid:  Option<(u32, u32)>,
		gid:  Option<(u32, u32)>,
	}

	#[derive(Clone)]
	struct Stat {
		comm:       String,
		state:      char,
		ppid:       i32,
		pgrp:       i32,
		session:    i32,
		tty:        i64,
		tpgid:      i32,
		flags:      u64,
		minflt:     u64,
		majflt:     u64,
		utime:      u64,
		stime:      u64,
		priority:   i32,
		nice:       i32,
		threads:    u32,
		start_time: u64,
		virtual_:   u64,
		rss_pages:  i64,
	}

	#[allow(
		clippy::unnecessary_wraps,
		reason = "Option returns match the cross-platform ProcInfo contract"
	)]
	impl ProcInfo {
		pub fn all() -> Vec<Self> {
			let Ok(entries) = fs::read_dir("/proc") else {
				return Vec::new();
			};
			let mut result = Vec::new();
			for entry in entries.flatten() {
				let Some(pid) = entry
					.file_name()
					.to_str()
					.and_then(|name| name.parse::<i32>().ok())
				else {
					continue;
				};
				if let Some(process) = Self::from_pid(pid) {
					result.push(process);
				}
			}
			result
		}

		fn from_pid(pid: i32) -> Option<Self> {
			if pid <= 0 {
				return None;
			}
			let stat = read_stat(pid)?;
			let args = fs::read(format!("/proc/{pid}/cmdline"))
				.ok()
				.map(|bytes| {
					bytes
						.split(|byte| *byte == 0)
						.filter(|part| !part.is_empty())
						.map(|part| String::from_utf8_lossy(part).into_owned())
						.collect()
				})
				.unwrap_or_default();
			let uid = status_ids(pid, "Uid:").map(|ids| (ids.0, ids.1));
			let gid = status_ids(pid, "Gid:");
			(read_stat(pid)?.start_time == stat.start_time).then_some(Self {
				pid,
				stat,
				args,
				uid,
				gid,
			})
		}

		pub const fn pid(&self) -> i32 {
			self.pid
		}

		pub const fn ppid(&self) -> Option<i32> {
			Some(self.stat.ppid)
		}

		pub fn args(&self) -> Vec<String> {
			self.args.clone()
		}

		pub const fn group_id(&self) -> Option<i32> {
			Some(self.stat.pgrp)
		}

		pub const fn session_id(&self) -> Option<i32> {
			Some(self.stat.session)
		}

		pub fn real_user_id(&self) -> Option<u32> {
			self.uid.map(|ids| ids.0)
		}

		pub fn effective_user_id(&self) -> Option<u32> {
			self.uid.map(|ids| ids.1)
		}

		pub fn real_group_id(&self) -> Option<u32> {
			self.gid.map(|ids| ids.0)
		}

		pub fn effective_group_id(&self) -> Option<u32> {
			self.gid.map(|ids| ids.1)
		}

		pub fn terminal_id(&self) -> Option<u64> {
			(self.stat.tty != 0).then_some(self.stat.tty as u32 as u64)
		}

		pub fn terminal_group_id(&self) -> Option<i32> {
			(self.stat.tpgid > 0).then_some(self.stat.tpgid)
		}

		pub const fn priority(&self) -> Option<i32> {
			Some(self.stat.priority)
		}

		pub const fn flags(&self) -> Option<u64> {
			Some(self.stat.flags)
		}

		pub const fn minor_faults(&self) -> Option<u64> {
			Some(self.stat.minflt)
		}

		pub const fn major_faults(&self) -> Option<u64> {
			Some(self.stat.majflt)
		}

		pub fn wchan(&self) -> Option<String> {
			let value = fs::read_to_string(format!("/proc/{}/wchan", self.pid)).ok()?;
			let value = value.trim();
			(!value.is_empty() && value != "0" && value != "-").then(|| value.to_string())
		}

		pub const fn state(&self) -> char {
			self.stat.state
		}

		pub const fn start_time(&self) -> u64 {
			self.stat.start_time
		}

		pub fn age(&self) -> Option<Duration> {
			let uptime = fs::read_to_string("/proc/uptime")
				.ok()?
				.split_whitespace()
				.next()?
				.parse::<f64>()
				.ok()?;
			let ticks = clock_ticks()? as f64;
			Some(Duration::from_secs_f64((uptime - self.stat.start_time as f64 / ticks).max(0.0)))
		}

		pub fn match_name(&self) -> String {
			self.stat.comm.clone()
		}

		pub fn command_name(&self) -> String {
			self.stat.comm.clone()
		}

		pub fn status(&self) -> ProcessStatus {
			match read_stat(self.pid) {
				Some(stat) if stat.start_time == self.stat.start_time && stat.state != 'Z' => {
					ProcessStatus::Running
				},
				_ => ProcessStatus::Exited,
			}
		}

		pub fn signal(&self, signal: i32, queue: Option<i32>) -> bool {
			if signal == 0 {
				return read_stat(self.pid).is_some_and(|stat| stat.start_time == self.stat.start_time);
			}
			let Some(pidfd) = open_pidfd(self.pid) else {
				return false;
			};
			if read_stat(self.pid).is_none_or(|stat| stat.start_time != self.stat.start_time) {
				return false;
			}
			if let Some(value) = queue {
				let mut value_arg = libc::sigval { sival_ptr: std::ptr::null_mut() };
				// SAFETY: sigval is a C union; writing its integer member initializes
				// the bytes consumed by sigqueue while the remaining bytes stay zero.
				unsafe {
					(&raw mut value_arg).cast::<i32>().write(value);
					return libc::sigqueue(self.pid, signal, value_arg) == 0;
				}
			}
			// SAFETY: pidfd is valid and pidfd_send_signal reads no optional pointers.
			unsafe {
				libc::syscall(
					libc::SYS_pidfd_send_signal,
					pidfd.as_raw_fd(),
					signal,
					std::ptr::null::<libc::siginfo_t>(),
					0,
				) == 0
			}
		}

		pub fn cpu_time(&self) -> Option<Duration> {
			let ticks = clock_ticks()?;
			Some(Duration::from_secs_f64((self.stat.utime + self.stat.stime) as f64 / ticks as f64))
		}

		pub fn resident_bytes(&self) -> Option<u64> {
			let pages = u64::try_from(self.stat.rss_pages).ok()?;
			Some(pages.saturating_mul(page_size()?))
		}

		pub const fn virtual_bytes(&self) -> Option<u64> {
			Some(self.stat.virtual_)
		}

		pub const fn thread_count(&self) -> Option<u32> {
			Some(self.stat.threads)
		}

		pub const fn nice(&self) -> Option<i32> {
			Some(self.stat.nice)
		}
	}

	fn open_pidfd(pid: i32) -> Option<OwnedFd> {
		// SAFETY: pidfd_open takes scalar arguments and returns a new owned fd.
		let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) } as i32;
		(fd >= 0).then(|| {
			// SAFETY: successful pidfd_open returned a uniquely owned descriptor.
			unsafe { OwnedFd::from_raw_fd(fd) }
		})
	}

	fn read_stat(pid: i32) -> Option<Stat> {
		let content = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
		let open = content.find('(')?;
		let close = content.rfind(')')?;
		let comm = content[open + 1..close].to_string();
		let fields: Vec<&str> = content[close + 1..].split_whitespace().collect();
		Some(Stat {
			comm,
			state: fields.first()?.chars().next()?,
			ppid: fields.get(1)?.parse().ok()?,
			pgrp: fields.get(2)?.parse().ok()?,
			session: fields.get(3)?.parse().ok()?,
			tty: fields.get(4)?.parse().ok()?,
			tpgid: fields.get(5)?.parse().ok()?,
			flags: fields.get(6)?.parse().ok()?,
			minflt: fields.get(7)?.parse().ok()?,
			majflt: fields.get(9)?.parse().ok()?,
			utime: fields.get(11)?.parse().ok()?,
			stime: fields.get(12)?.parse().ok()?,
			priority: fields.get(15)?.parse().ok()?,
			nice: fields.get(16)?.parse().ok()?,
			threads: fields.get(17)?.parse().ok()?,
			start_time: fields.get(19)?.parse().ok()?,
			virtual_: fields.get(20)?.parse().ok()?,
			rss_pages: fields.get(21)?.parse().ok()?,
		})
	}

	fn status_ids(pid: i32, prefix: &str) -> Option<(u32, u32)> {
		let content = fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
		let mut ids = content
			.lines()
			.find(|line| line.starts_with(prefix))?
			.split_whitespace()
			.skip(1)
			.filter_map(|value| value.parse().ok());
		Some((ids.next()?, ids.next()?))
	}

	fn clock_ticks() -> Option<u64> {
		// SAFETY: sysconf reads a process-global constant.
		u64::try_from(unsafe { libc::sysconf(libc::_SC_CLK_TCK) })
			.ok()
			.filter(|v| *v > 0)
	}
	fn page_size() -> Option<u64> {
		// SAFETY: sysconf reads a process-global constant.
		u64::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) })
			.ok()
			.filter(|v| *v > 0)
	}
}

#[cfg(target_os = "macos")]
mod proc_snapshot {
	use std::{
		ffi::CStr,
		mem::size_of,
		path::Path,
		ptr,
		time::{Duration, SystemTime, UNIX_EPOCH},
	};

	use crate::process::ProcessStatus;

	const KERN_PROCARGS2: libc::c_int = 49;

	#[link(name = "proc", kind = "dylib")]
	unsafe extern "C" {
		fn proc_listallpids(buffer: *mut i32, buffersize: i32) -> i32;
	}

	#[derive(Clone)]
	pub struct ProcInfo {
		pid:  i32,
		info: libc::proc_bsdinfo,
		task: Option<libc::proc_taskinfo>,
		args: Vec<String>,
	}

	#[allow(
		clippy::unnecessary_wraps,
		reason = "Option returns match the cross-platform ProcInfo contract"
	)]
	impl ProcInfo {
		pub fn all() -> Vec<Self> {
			// SAFETY: null/zero is libproc's documented sizing query.
			let reported = unsafe { proc_listallpids(ptr::null_mut(), 0) };
			if reported <= 0 {
				return Vec::new();
			}
			let count = (reported as usize).saturating_mul(2).max(2048);
			let mut pids = vec![0i32; count];
			// SAFETY: pids is writable for the supplied byte size.
			let actual =
				unsafe { proc_listallpids(pids.as_mut_ptr(), (pids.len() * size_of::<i32>()) as i32) };
			if actual <= 0 {
				return Vec::new();
			}
			pids.truncate((actual as usize).min(pids.len()));
			pids.into_iter().filter_map(Self::from_pid).collect()
		}

		fn from_pid(pid: i32) -> Option<Self> {
			let info = read_bsdinfo(pid)?;
			Some(Self { pid, info, task: read_taskinfo(pid), args: process_args(pid) })
		}

		fn live_info(&self) -> Option<libc::proc_bsdinfo> {
			let info = read_bsdinfo(self.pid())?;
			(info.pbi_start_tvsec == self.info.pbi_start_tvsec
				&& info.pbi_start_tvusec == self.info.pbi_start_tvusec)
				.then_some(info)
		}

		pub const fn pid(&self) -> i32 {
			self.pid
		}

		pub fn ppid(&self) -> Option<i32> {
			i32::try_from(self.info.pbi_ppid).ok()
		}

		pub fn args(&self) -> Vec<String> {
			self.args.clone()
		}

		pub fn group_id(&self) -> Option<i32> {
			i32::try_from(self.info.pbi_pgid).ok()
		}

		pub fn session_id(&self) -> Option<i32> {
			// SAFETY: getsid takes only a scalar process id.
			let sid = unsafe { libc::getsid(self.pid()) };
			(sid >= 0).then_some(sid)
		}

		pub const fn real_user_id(&self) -> Option<u32> {
			Some(self.info.pbi_ruid)
		}

		pub const fn effective_user_id(&self) -> Option<u32> {
			Some(self.info.pbi_uid)
		}

		pub const fn real_group_id(&self) -> Option<u32> {
			Some(self.info.pbi_rgid)
		}

		pub fn terminal_id(&self) -> Option<u64> {
			(!matches!(self.info.e_tdev, 0 | u32::MAX)).then_some(self.info.e_tdev as u64)
		}

		pub fn terminal_group_id(&self) -> Option<i32> {
			i32::try_from(self.info.e_tpgid)
				.ok()
				.filter(|tpgid| *tpgid > 0)
		}

		pub const fn effective_group_id(&self) -> Option<u32> {
			Some(self.info.pbi_gid)
		}

		pub fn priority(&self) -> Option<i32> {
			Some(self.task.as_ref()?.pti_priority)
		}

		pub const fn flags(&self) -> Option<u64> {
			Some(self.info.pbi_flags as u64)
		}

		pub fn minor_faults(&self) -> Option<u64> {
			u64::try_from(self.task.as_ref()?.pti_faults).ok()
		}

		pub fn major_faults(&self) -> Option<u64> {
			u64::try_from(self.task.as_ref()?.pti_pageins).ok()
		}

		#[allow(clippy::unused_self, reason = "matches the cross-platform ProcInfo contract")]
		pub const fn wchan(&self) -> Option<String> {
			None
		}

		pub const fn state(&self) -> char {
			match self.info.pbi_status {
				1 => 'I',
				2 => 'R',
				3 => 'S',
				4 => 'T',
				5 => 'Z',
				_ => '?',
			}
		}

		pub const fn start_time(&self) -> u64 {
			self
				.info
				.pbi_start_tvsec
				.saturating_mul(1_000_000)
				.saturating_add(self.info.pbi_start_tvusec)
		}

		pub fn age(&self) -> Option<Duration> {
			let start = UNIX_EPOCH
				+ Duration::from_secs(self.info.pbi_start_tvsec)
				+ Duration::from_micros(self.info.pbi_start_tvusec);
			SystemTime::now().duration_since(start).ok()
		}

		pub fn match_name(&self) -> String {
			self
				.args
				.first()
				.and_then(|arg| Path::new(arg).file_name())
				.map(|name| name.to_string_lossy().into_owned())
				.filter(|name| !name.is_empty())
				.unwrap_or_else(|| self.command_name())
		}

		pub fn command_name(&self) -> String {
			// SAFETY: pbi_comm is a kernel-filled fixed buffer with NUL termination.
			unsafe { CStr::from_ptr(self.info.pbi_comm.as_ptr()) }
				.to_string_lossy()
				.into_owned()
		}

		pub fn status(&self) -> ProcessStatus {
			match self.live_info() {
				Some(info) if info.pbi_status != 5 => ProcessStatus::Running,
				_ => ProcessStatus::Exited,
			}
		}

		pub fn signal(&self, signal: i32, _queue: Option<i32>) -> bool {
			if self.live_info().is_none() {
				return false;
			}
			// SAFETY: identity was rechecked immediately before the scalar kill call.
			unsafe { libc::kill(self.pid(), signal) == 0 }
		}

		pub fn cpu_time(&self) -> Option<Duration> {
			let task = self.task.as_ref()?;
			Some(Duration::from_nanos(task.pti_total_user.saturating_add(task.pti_total_system)))
		}

		pub fn resident_bytes(&self) -> Option<u64> {
			Some(self.task.as_ref()?.pti_resident_size)
		}

		pub fn virtual_bytes(&self) -> Option<u64> {
			Some(self.task.as_ref()?.pti_virtual_size)
		}

		pub fn thread_count(&self) -> Option<u32> {
			u32::try_from(self.task.as_ref()?.pti_threadnum).ok()
		}

		pub const fn nice(&self) -> Option<i32> {
			Some(self.info.pbi_nice)
		}
	}

	fn read_bsdinfo(pid: i32) -> Option<libc::proc_bsdinfo> {
		if pid <= 0 {
			return None;
		}
		// SAFETY: proc_bsdinfo is a C integer record valid when zeroed.
		let mut info = unsafe { std::mem::zeroed::<libc::proc_bsdinfo>() };
		// SAFETY: info is writable for the exact supplied size.
		let actual = unsafe {
			libc::proc_pidinfo(
				pid,
				libc::PROC_PIDTBSDINFO,
				0,
				(&raw mut info).cast(),
				size_of::<libc::proc_bsdinfo>() as i32,
			)
		};
		(actual >= size_of::<libc::proc_bsdinfo>() as i32).then_some(info)
	}

	fn read_taskinfo(pid: i32) -> Option<libc::proc_taskinfo> {
		// SAFETY: proc_taskinfo is a C integer record valid when zeroed.
		let mut info = unsafe { std::mem::zeroed::<libc::proc_taskinfo>() };
		// SAFETY: info is writable for the exact supplied size.
		let actual = unsafe {
			libc::proc_pidinfo(
				pid,
				libc::PROC_PIDTASKINFO,
				0,
				(&raw mut info).cast(),
				size_of::<libc::proc_taskinfo>() as i32,
			)
		};
		(actual >= size_of::<libc::proc_taskinfo>() as i32).then_some(info)
	}

	fn process_args(pid: i32) -> Vec<String> {
		let mut mib = [libc::CTL_KERN, KERN_PROCARGS2, pid];
		let mut size = 0usize;
		// SAFETY: null old-value is the sysctl sizing form.
		if unsafe {
			libc::sysctl(mib.as_mut_ptr(), 3, ptr::null_mut(), &raw mut size, ptr::null_mut(), 0)
		} != 0 || size <= size_of::<libc::c_int>()
		{
			return Vec::new();
		}
		let mut buffer = vec![0u8; size];
		// SAFETY: buffer is writable for size bytes.
		if unsafe {
			libc::sysctl(
				mib.as_mut_ptr(),
				3,
				buffer.as_mut_ptr().cast(),
				&raw mut size,
				ptr::null_mut(),
				0,
			)
		} != 0
		{
			return Vec::new();
		}
		buffer.truncate(size);
		let argc_size = size_of::<libc::c_int>();
		let Some(argc_bytes) = buffer.get(..argc_size) else {
			return Vec::new();
		};
		let Ok(argc_bytes) = <[u8; 4]>::try_from(argc_bytes) else {
			return Vec::new();
		};
		let argc = i32::from_ne_bytes(argc_bytes);
		let mut offset = argc_size;
		while offset < buffer.len() && buffer[offset] != 0 {
			offset += 1;
		}
		while offset < buffer.len() && buffer[offset] == 0 {
			offset += 1;
		}
		let mut args = Vec::new();
		while offset < buffer.len() && args.len() < argc.max(0) as usize {
			let end = buffer[offset..]
				.iter()
				.position(|byte| *byte == 0)
				.map_or(buffer.len(), |position| offset + position);
			if end == offset {
				break;
			}
			args.push(String::from_utf8_lossy(&buffer[offset..end]).into_owned());
			offset = end + 1;
		}
		args
	}
}

#[cfg(target_os = "windows")]
mod proc_snapshot {
	use std::{collections::HashMap, ffi::c_void, mem::size_of, sync::Arc, time::Duration};

	use crate::process::ProcessStatus;

	type Handle = *mut c_void;
	const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
	const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
	const PROCESS_TERMINATE: u32 = 0x0001;
	const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
	const SYNCHRONIZE: u32 = 0x0010_0000;
	const WAIT_TIMEOUT: u32 = 0x0000_0102;

	#[repr(C)]
	#[derive(Clone, Copy)]
	struct ProcessEntry32W {
		size:          u32,
		usage:         u32,
		pid:           u32,
		default_heap:  usize,
		module_id:     u32,
		threads:       u32,
		ppid:          u32,
		base_priority: i32,
		flags:         u32,
		exe:           [u16; 260],
	}

	#[repr(C)]
	#[derive(Clone, Copy, Default)]
	struct FileTime {
		low:  u32,
		high: u32,
	}

	#[repr(C)]
	struct UnicodeString {
		length:         u16,
		maximum_length: u16,
		buffer:         *const u16,
	}

	#[repr(C)]
	struct ProcessMemoryCounters {
		cb: u32,
		page_fault_count: u32,
		peak_working_set_size: usize,
		working_set_size: usize,
		quota_peak_paged_pool_usage: usize,
		quota_paged_pool_usage: usize,
		quota_peak_non_paged_pool_usage: usize,
		quota_non_paged_pool_usage: usize,
		pagefile_usage: usize,
		peak_pagefile_usage: usize,
	}

	#[link(name = "kernel32")]
	unsafe extern "system" {
		fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> Handle;
		fn Process32FirstW(snapshot: Handle, entry: *mut ProcessEntry32W) -> i32;
		fn Process32NextW(snapshot: Handle, entry: *mut ProcessEntry32W) -> i32;
		fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
		fn CloseHandle(handle: Handle) -> i32;
		fn TerminateProcess(handle: Handle, exit_code: u32) -> i32;
		fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
		fn GetProcessTimes(
			handle: Handle,
			creation: *mut FileTime,
			exit: *mut FileTime,
			kernel: *mut FileTime,
			user: *mut FileTime,
		) -> i32;
		fn GetSystemTimeAsFileTime(time: *mut FileTime);
		fn K32GetProcessMemoryInfo(
			handle: Handle,
			counters: *mut ProcessMemoryCounters,
			size: u32,
		) -> i32;
	}

	#[link(name = "ntdll")]
	unsafe extern "system" {
		fn NtQueryInformationProcess(
			handle: Handle,
			class: u32,
			information: *mut c_void,
			information_length: u32,
			return_length: *mut u32,
		) -> i32;
	}

	struct OwnedHandle(Handle);
	// SAFETY: kernel process handles are safe to wait/query from any thread.
	unsafe impl Send for OwnedHandle {}
	unsafe impl Sync for OwnedHandle {}
	impl Drop for OwnedHandle {
		fn drop(&mut self) {
			// SAFETY: this wrapper uniquely owns the valid handle.
			unsafe {
				CloseHandle(self.0);
			}
		}
	}

	#[derive(Clone)]
	pub struct ProcInfo {
		pid:           i32,
		handle:        Arc<OwnedHandle>,
		ppid:          i32,
		threads:       u32,
		base_priority: i32,
		name:          String,
		command_line:  String,
		creation:      u64,
	}

	#[allow(
		clippy::unnecessary_wraps,
		reason = "Option returns match the cross-platform ProcInfo contract"
	)]
	impl ProcInfo {
		pub fn all() -> Vec<Self> {
			let mut handles = HashMap::new();
			for entry in snapshot_entries() {
				if let Some(identity) = open_process_identity(entry.pid) {
					handles.insert(entry.pid, identity);
				}
			}

			snapshot_entries()
				.into_iter()
				.filter_map(|entry| {
					let (handle, creation) = handles.remove(&entry.pid)?;
					Self::from_entry(&entry, handle, creation)
				})
				.collect()
		}

		fn from_entry(
			entry: &ProcessEntry32W,
			handle: Arc<OwnedHandle>,
			creation: u64,
		) -> Option<Self> {
			let pid = i32::try_from(entry.pid).ok().filter(|pid| *pid > 0)?;
			// A PID reused after the handle was opened appears in the refreshed
			// snapshot, but the pinned predecessor is already signalled as exited.
			if unsafe { WaitForSingleObject(handle.0, 0) } != WAIT_TIMEOUT {
				return None;
			}
			let end = entry
				.exe
				.iter()
				.position(|unit| *unit == 0)
				.unwrap_or(entry.exe.len());
			let name = String::from_utf16_lossy(&entry.exe[..end]);
			let command_line = process_command_line(handle.0).unwrap_or_else(|| name.clone());
			Some(Self {
				pid,
				handle,
				ppid: i32::try_from(entry.ppid).unwrap_or(0),
				threads: entry.threads,
				base_priority: entry.base_priority,
				name,
				command_line,
				creation,
			})
		}

		pub fn pid(&self) -> i32 {
			self.pid
		}

		pub fn ppid(&self) -> Option<i32> {
			Some(self.ppid)
		}

		pub fn args(&self) -> Vec<String> {
			vec![self.command_line.clone()]
		}

		pub fn group_id(&self) -> Option<i32> {
			None
		}

		pub fn session_id(&self) -> Option<i32> {
			None
		}

		pub fn real_user_id(&self) -> Option<u32> {
			None
		}

		pub fn effective_user_id(&self) -> Option<u32> {
			None
		}

		pub fn real_group_id(&self) -> Option<u32> {
			None
		}

		pub fn terminal_id(&self) -> Option<u64> {
			None
		}

		pub fn terminal_group_id(&self) -> Option<i32> {
			None
		}

		pub fn effective_group_id(&self) -> Option<u32> {
			None
		}

		pub fn priority(&self) -> Option<i32> {
			None
		}

		pub fn flags(&self) -> Option<u64> {
			None
		}

		pub fn minor_faults(&self) -> Option<u64> {
			None
		}

		pub fn major_faults(&self) -> Option<u64> {
			None
		}

		pub fn wchan(&self) -> Option<String> {
			None
		}

		pub fn state(&self) -> char {
			if self.status() == ProcessStatus::Running {
				'R'
			} else {
				'?'
			}
		}

		pub fn start_time(&self) -> u64 {
			self.creation
		}

		pub fn age(&self) -> Option<Duration> {
			let mut now = FileTime::default();
			// SAFETY: now is writable for one FILETIME.
			unsafe { GetSystemTimeAsFileTime(&raw mut now) };
			Some(Duration::from_nanos(
				filetime_ticks(now)
					.saturating_sub(self.creation)
					.saturating_mul(100),
			))
		}

		pub fn match_name(&self) -> String {
			self.name.clone()
		}

		pub fn command_name(&self) -> String {
			self.name.clone()
		}

		pub fn status(&self) -> ProcessStatus {
			// SAFETY: the retained process handle remains valid until drop.
			if unsafe { WaitForSingleObject(self.handle.0, 0) } == WAIT_TIMEOUT {
				ProcessStatus::Running
			} else {
				ProcessStatus::Exited
			}
		}

		pub fn signal(&self, signal: i32, _queue: Option<i32>) -> bool {
			if signal == 0 {
				return self.status() == ProcessStatus::Running;
			}
			// SAFETY: OpenProcess returns a fresh owned termination/query handle or null.
			let handle = unsafe {
				OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, 0, self.pid as u32)
			};
			if handle.is_null() {
				return false;
			}
			let handle = OwnedHandle(handle);
			if process_times(handle.0).map(|times| times.0) != Some(self.creation) {
				return false;
			}
			// SAFETY: identity was verified on a handle with PROCESS_TERMINATE access.
			unsafe { TerminateProcess(handle.0, 1) != 0 }
		}

		pub fn cpu_time(&self) -> Option<Duration> {
			let (_, kernel, user) = process_times(self.handle.0)?;
			Some(Duration::from_nanos(kernel.saturating_add(user).saturating_mul(100)))
		}

		pub fn resident_bytes(&self) -> Option<u64> {
			Some(process_memory(self.handle.0)?.working_set_size as u64)
		}

		pub fn virtual_bytes(&self) -> Option<u64> {
			None
		}

		pub fn thread_count(&self) -> Option<u32> {
			Some(self.threads)
		}

		pub fn nice(&self) -> Option<i32> {
			Some(self.base_priority)
		}
	}

	fn snapshot_entries() -> Vec<ProcessEntry32W> {
		// SAFETY: documented scalar Toolhelp snapshot call.
		let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
		if snapshot == INVALID_HANDLE_VALUE {
			return Vec::new();
		}
		let snapshot = OwnedHandle(snapshot);
		// SAFETY: the all-zero entry is initialized with its ABI size below.
		let mut entry = unsafe { std::mem::zeroed::<ProcessEntry32W>() };
		entry.size = size_of::<ProcessEntry32W>() as u32;
		let mut result = Vec::new();
		// SAFETY: snapshot and entry are valid.
		let mut ok = unsafe { Process32FirstW(snapshot.0, &raw mut entry) };
		while ok != 0 {
			result.push(entry);
			// SAFETY: snapshot and entry remain valid.
			ok = unsafe { Process32NextW(snapshot.0, &raw mut entry) };
		}
		result
	}

	fn open_process_identity(pid: u32) -> Option<(Arc<OwnedHandle>, u64)> {
		i32::try_from(pid).ok().filter(|pid| *pid > 0)?;
		// SAFETY: OpenProcess returns a new owned query/synchronize handle or null.
		let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid) };
		if handle.is_null() {
			return None;
		}
		let handle = Arc::new(OwnedHandle(handle));
		let creation = process_times(handle.0)?.0;
		Some((handle, creation))
	}

	fn process_command_line(handle: Handle) -> Option<String> {
		const PROCESS_COMMAND_LINE_INFORMATION: u32 = 60;
		let mut bytes = 0u32;
		// SAFETY: a null sizing query writes only the required byte count.
		unsafe {
			NtQueryInformationProcess(
				handle,
				PROCESS_COMMAND_LINE_INFORMATION,
				std::ptr::null_mut(),
				0,
				&raw mut bytes,
			);
		}
		if bytes < size_of::<UnicodeString>() as u32 {
			return None;
		}
		let words = (bytes as usize).div_ceil(size_of::<usize>());
		let mut storage = vec![0usize; words];
		// SAFETY: storage is aligned and writable for at least `bytes` bytes.
		let status = unsafe {
			NtQueryInformationProcess(
				handle,
				PROCESS_COMMAND_LINE_INFORMATION,
				storage.as_mut_ptr().cast(),
				bytes,
				&raw mut bytes,
			)
		};
		if status < 0 {
			return None;
		}
		// SAFETY: a successful query initializes a UnicodeString at the buffer head.
		let command = unsafe { &*storage.as_ptr().cast::<UnicodeString>() };
		let length = usize::from(command.length);
		if length == 0 || length % size_of::<u16>() != 0 {
			return None;
		}
		let base = storage.as_ptr() as usize;
		let end = base.checked_add(storage.len().checked_mul(size_of::<usize>())?)?;
		let command_start = command.buffer as usize;
		let command_end = command_start.checked_add(length)?;
		if command_start < base || command_end > end {
			return None;
		}
		// SAFETY: the validated range is aligned for UTF-16 within the query buffer.
		let units = unsafe { std::slice::from_raw_parts(command.buffer, length / size_of::<u16>()) };
		Some(String::from_utf16_lossy(units)).filter(|command| !command.is_empty())
	}

	fn filetime_ticks(time: FileTime) -> u64 {
		(u64::from(time.high) << 32) | u64::from(time.low)
	}

	fn process_times(handle: Handle) -> Option<(u64, u64, u64)> {
		let mut creation = FileTime::default();
		let mut exit = FileTime::default();
		let mut kernel = FileTime::default();
		let mut user = FileTime::default();
		// SAFETY: all FILETIME output pointers are valid and writable.
		let ok = unsafe {
			GetProcessTimes(handle, &raw mut creation, &raw mut exit, &raw mut kernel, &raw mut user)
		};
		(ok != 0).then(|| (filetime_ticks(creation), filetime_ticks(kernel), filetime_ticks(user)))
	}

	fn process_memory(handle: Handle) -> Option<ProcessMemoryCounters> {
		// SAFETY: the C record is valid when zeroed and cb is set before the call.
		let mut counters = unsafe { std::mem::zeroed::<ProcessMemoryCounters>() };
		counters.cb = size_of::<ProcessMemoryCounters>() as u32;
		// SAFETY: counters is writable for the supplied exact size.
		let ok = unsafe {
			K32GetProcessMemoryInfo(
				handle,
				&raw mut counters,
				size_of::<ProcessMemoryCounters>() as u32,
			)
		};
		(ok != 0).then_some(counters)
	}
}

#[derive(Parser)]
#[command(disable_help_flag = true, disable_version_flag = true)]
struct ProcMatchCommand {
	#[arg(num_args = 0.., trailing_var_arg = true, allow_hyphen_values = true)]
	argv: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ProcMatchMode {
	Grep,
	Kill,
	Wait,
}

#[derive(Default)]
struct ProcMatchOptions {
	patterns:          Vec<String>,
	full:              bool,
	exact:             bool,
	ignore_case:       bool,
	invert:            bool,
	newest:            bool,
	oldest:            bool,
	parents:           Vec<i32>,
	groups:            Vec<i32>,
	sessions:          Vec<i32>,
	effective_users:   Vec<u32>,
	real_users:        Vec<u32>,
	real_groups:       Vec<u32>,
	terminals:         Vec<Option<u64>>,
	pids:              Vec<i32>,
	pid_files:         Vec<String>,
	explicit_pid:      bool,
	require_lock:      bool,
	older:             Option<Duration>,
	states:            HashSet<char>,
	ignore_ancestors:  bool,
	include_ancestors: bool,
	count:             bool,
	list_name:         bool,
	list_full:         bool,
	quiet:             bool,
	delimiter:         String,
	signal:            i32,
	queue:             Option<i32>,
	echo:              bool,
	echo_command:      bool,
	interactive:       bool,
}

impl builtins::Command for ProcMatchCommand {
	type Error = brush_core::Error;

	fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> impl Future<Output = std::result::Result<ExecutionResult, brush_core::Error>> + Send {
		let argv = self.argv.clone();
		let command_name = context.command_name.clone();
		let cwd = context.shell.working_dir().to_path_buf();
		async move {
			let mode = match command_name.as_str() {
				"pkill" => ProcMatchMode::Kill,
				"pidwait" => ProcMatchMode::Wait,
				_ => ProcMatchMode::Grep,
			};
			#[cfg(unix)]
			let stdin_watcher = context.try_fd(OpenFiles::STDIN_FD).and_then(|stdin| {
				let fd = stdin.try_borrow_as_fd().ok()?.try_clone_to_owned().ok()?;
				tokio::io::unix::AsyncFd::new(fd).ok()
			});
			let mut stdin = io::BufReader::new(context.stdin());
			let mut options = match parse_proc_match_args(mode, &argv, &cwd, &mut stdin) {
				Ok(ParseProcResult::Options(options)) => *options,
				Ok(ParseProcResult::Help) => {
					write_proc_match_help(context.stdout(), &command_name, mode)?;
					return Ok(ExecutionResult::success());
				},
				Ok(ParseProcResult::Version) => {
					writeln!(context.stdout(), "{command_name} {}", env!("CARGO_PKG_VERSION"))?;
					return Ok(ExecutionResult::success());
				},
				Err((code, message)) => {
					writeln!(context.stderr(), "{command_name}: {message}")?;
					return Ok(ExecutionResult::new(code));
				},
			};

			if context.is_cancelled() {
				return Ok(ExecutionExitCode::Interrupted.into());
			}

			let processes = match select_processes(&mut options) {
				Ok(processes) => processes,
				Err(message) => {
					writeln!(context.stderr(), "{command_name}: {message}")?;
					return Ok(ExecutionResult::new(2));
				},
			};
			if processes.is_empty() {
				if options.count && !options.quiet {
					writeln!(context.stdout(), "0")?;
				}
				return Ok(ExecutionResult::new(1));
			}

			match mode {
				ProcMatchMode::Grep => {
					if options.quiet {
						return Ok(ExecutionResult::success());
					}
					if options.count {
						writeln!(context.stdout(), "{}", processes.len())?;
					} else {
						let mut output = Vec::with_capacity(processes.len());
						for process in &processes {
							let line = if options.list_full
								|| (cfg!(target_os = "macos") && options.list_name && options.full)
							{
								format!("{} {}", process.pid(), process.args().join(" "))
							} else if options.list_name {
								format!("{} {}", process.pid(), process.command_name())
							} else {
								process.pid().to_string()
							};
							output.push(line);
						}
						writeln!(context.stdout(), "{}", output.join(&options.delimiter))?;
					}
				},
				ProcMatchMode::Kill => {
					if options.count && !options.quiet {
						writeln!(context.stdout(), "{}", processes.len())?;
					}
					let mut succeeded = false;
					for process in &processes {
						if context.is_cancelled() {
							return Ok(ExecutionExitCode::Interrupted.into());
						}
						if options.interactive {
							{
								let mut stderr = context.stderr();
								write!(stderr, "kill process {}? ", process.pid())?;
								stderr.flush()?;
							}
							#[cfg(unix)]
							let response = read_proc_confirmation(
								&mut stdin,
								context.cancel_token(),
								stdin_watcher.as_ref(),
							)
							.await?;
							#[cfg(not(unix))]
							let response = read_proc_confirmation(&mut stdin, context.cancel_token()).await?;
							let Some(response) = response else {
								return Ok(ExecutionExitCode::Interrupted.into());
							};
							if !matches!(response.trim(), "y" | "Y" | "yes" | "YES") {
								continue;
							}
						}
						if context.is_cancelled() {
							return Ok(ExecutionExitCode::Interrupted.into());
						}
						if !process.signal(options.signal, options.queue) {
							if !options.quiet {
								writeln!(
									context.stderr(),
									"{command_name}: signalling pid {} failed",
									process.pid()
								)?;
							}
							continue;
						}
						succeeded = true;
						if options.echo_command && !options.quiet {
							writeln!(context.stdout(), "kill -{} {}", options.signal, process.pid())?;
						} else if options.echo && !options.quiet {
							writeln!(
								context.stdout(),
								"{} killed (pid {})",
								process.command_name(),
								process.pid()
							)?;
						}
					}
					if !succeeded {
						return Ok(ExecutionResult::new(1));
					}
				},
				ProcMatchMode::Wait => {
					if options.count && !options.quiet {
						writeln!(context.stdout(), "{}", processes.len())?;
					}
					if options.echo && !options.quiet {
						for process in &processes {
							writeln!(
								context.stdout(),
								"waiting for {} (pid {})",
								process.command_name(),
								process.pid()
							)?;
						}
					}
					loop {
						if processes
							.iter()
							.all(|process| process.status() == process::ProcessStatus::Exited)
						{
							break;
						}
						if context.is_cancelled() {
							return Ok(ExecutionExitCode::Interrupted.into());
						}
						if let Some(cancel_token) = context.cancel_token() {
							tokio::select! {
								() = time::sleep(Duration::from_millis(50)) => {},
								() = cancel_token.cancelled() => {
									return Ok(ExecutionExitCode::Interrupted.into());
								},
							}
						} else {
							time::sleep(Duration::from_millis(50)).await;
						}
					}
				},
			}
			Ok(ExecutionResult::success())
		}
	}
}

#[cfg(unix)]
async fn read_proc_confirmation<R: io::Read>(
	stdin: &mut io::BufReader<R>,
	cancel_token: Option<CancellationToken>,
	watcher: Option<&tokio::io::unix::AsyncFd<std::os::fd::OwnedFd>>,
) -> io::Result<Option<String>> {
	if cancel_token
		.as_ref()
		.is_some_and(CancellationToken::is_cancelled)
	{
		return Ok(None);
	}
	if let Some(watcher) = watcher {
		if let Some(cancel_token) = cancel_token {
			let ready = tokio::select! {
				ready = watcher.readable() => ready,
				() = cancel_token.cancelled() => return Ok(None),
			};
			drop(ready?);
		} else {
			drop(watcher.readable().await?);
		}
	}
	let mut response = String::new();
	stdin.read_line(&mut response)?;
	Ok(Some(response))
}

#[cfg(not(unix))]
async fn read_proc_confirmation<R: io::Read>(
	stdin: &mut io::BufReader<R>,
	cancel_token: Option<CancellationToken>,
) -> io::Result<Option<String>> {
	if cancel_token
		.as_ref()
		.is_some_and(CancellationToken::is_cancelled)
	{
		return Ok(None);
	}
	let mut response = String::new();
	stdin.read_line(&mut response)?;
	Ok(Some(response))
}

enum ParseProcResult {
	Options(Box<ProcMatchOptions>),
	Help,
	Version,
}

fn parse_proc_match_args(
	mode: ProcMatchMode,
	argv: &[String],
	cwd: &Path,
	stdin: &mut impl BufRead,
) -> std::result::Result<ParseProcResult, (u8, String)> {
	let mut options =
		ProcMatchOptions { delimiter: "\n".to_string(), signal: 15, ..Default::default() };
	let mut index = 0;
	let mut options_done = false;
	while index < argv.len() {
		let arg = &argv[index];
		if !options_done && arg == "--" {
			options_done = true;
			index += 1;
			continue;
		}
		if !options_done && matches!(arg.as_str(), "--help" | "-h") {
			return Ok(ParseProcResult::Help);
		}
		if !options_done && arg == "--version" {
			return Ok(ParseProcResult::Version);
		}
		if mode == ProcMatchMode::Kill
			&& !options_done
			&& index == 0
			&& arg.starts_with('-')
			&& !arg.starts_with("--")
			&& signal_number(&arg[1..]).is_some()
		{
			options.signal = signal_number(&arg[1..]).unwrap_or(15);
			index += 1;
			continue;
		}
		if !options_done && arg.starts_with("--") {
			let (name, inline_value) = arg
				.split_once('=')
				.map_or((arg.as_str(), None), |(name, value)| (name, Some(value)));
			let takes_value =
				matches!(
					name,
					"--parent"
						| "--pgroup" | "--session"
						| "--euid" | "--uid"
						| "--group" | "--terminal"
						| "--pidfile"
						| "--pid" | "--older"
						| "--runstates"
						| "--delimiter"
						| "--signal" | "--queue"
				);
			let value = if takes_value {
				if let Some(value) = inline_value {
					Some(value)
				} else {
					index += 1;
					argv.get(index).map(String::as_str)
				}
			} else {
				None
			};
			if takes_value && value.is_none() {
				return Err((2, format!("option '{name}' requires an argument")));
			}
			match name {
				"--full" => options.full = true,
				"--exact" => options.exact = true,
				"--ignore-case" => options.ignore_case = true,
				"--inverse" => options.invert = true,
				"--newest" => options.newest = true,
				"--oldest" => options.oldest = true,
				"--parent" => parse_i32_list(value.unwrap_or_default(), &mut options.parents)?,
				"--pgroup" => parse_i32_list(value.unwrap_or_default(), &mut options.groups)?,
				"--session" => parse_i32_list(value.unwrap_or_default(), &mut options.sessions)?,
				"--euid" => parse_user_list(value.unwrap_or_default(), &mut options.effective_users)?,
				"--uid" => parse_user_list(value.unwrap_or_default(), &mut options.real_users)?,
				"--group" => parse_group_list(value.unwrap_or_default(), &mut options.real_groups)?,
				"--terminal" => parse_terminal_list(value.unwrap_or_default(), &mut options.terminals)?,
				"--pidfile" => options
					.pid_files
					.push(value.unwrap_or_default().to_string()),
				"--pid" => {
					options.explicit_pid = true;
					parse_i32_list(value.unwrap_or_default(), &mut options.pids)?;
				},
				"--older" => {
					options.older = Some(Duration::from_secs(
						value
							.unwrap_or_default()
							.parse()
							.map_err(|_| (2, "invalid age".to_string()))?,
					));
				},
				"--runstates" => parse_states(value.unwrap_or_default(), &mut options.states)?,
				"--ignore-ancestors" => options.ignore_ancestors = true,
				"--count" => options.count = true,
				"--list-name" => options.list_name = true,
				"--list-full" => options.list_full = true,
				"--quiet" => options.quiet = true,
				"--delimiter" => options.delimiter = value.unwrap_or_default().to_string(),
				"--signal" if mode == ProcMatchMode::Kill => {
					options.signal = signal_number(value.unwrap_or_default())
						.ok_or_else(|| (2, "invalid signal".to_string()))?;
				},
				"--queue" if mode == ProcMatchMode::Kill && cfg!(target_os = "linux") => {
					options.queue = Some(
						value
							.unwrap_or_default()
							.parse()
							.map_err(|_| (2, "invalid queue value".to_string()))?,
					);
				},
				"--echo" if mode != ProcMatchMode::Grep => options.echo = true,
				"--logpidfile" => options.require_lock = true,
				"--lightweight" | "--ns" | "--nslist" | "--cgroup" | "--env" => {
					return Err((2, format!("unsupported option '{name}'")));
				},
				_ => return Err((2, format!("unrecognized option '{name}'"))),
			}
			index += 1;
			continue;
		}
		if !options_done && arg.starts_with('-') && arg != "-" {
			let chars: Vec<char> = arg[1..].chars().collect();
			let mut short_index = 0;
			while short_index < chars.len() {
				let option = chars[short_index];
				let takes_value =
					matches!(
						option,
						'P' | 'g' | 's' | 'u' | 'U' | 'G' | 't' | 'F' | 'p' | 'O' | 'r' | 'd'
					) || (option == 'q' && mode == ProcMatchMode::Kill && cfg!(target_os = "linux"));
				let owned_value;
				let value = if takes_value {
					if short_index + 1 < chars.len() {
						owned_value = chars[short_index + 1..].iter().collect::<String>();
						short_index = chars.len();
						owned_value.as_str()
					} else {
						index += 1;
						argv
							.get(index)
							.map(String::as_str)
							.ok_or_else(|| (2, format!("option '-{option}' requires an argument")))?
					}
				} else {
					""
				};
				match option {
					'f' => options.full = true,
					'x' => options.exact = true,
					'i' => options.ignore_case = true,
					'v' if mode == ProcMatchMode::Kill && !cfg!(target_os = "macos") => {
						return Err((2, "unrecognized option '-v'".to_string()));
					},
					'v' => options.invert = true,
					'n' => options.newest = true,
					'o' => options.oldest = true,
					'P' => parse_i32_list(value, &mut options.parents)?,
					'g' => parse_i32_list(value, &mut options.groups)?,
					's' => parse_i32_list(value, &mut options.sessions)?,
					'u' => parse_user_list(value, &mut options.effective_users)?,
					'U' => parse_user_list(value, &mut options.real_users)?,
					'G' => parse_group_list(value, &mut options.real_groups)?,
					't' => parse_terminal_list(value, &mut options.terminals)?,
					'F' => options.pid_files.push(value.to_string()),
					'L' => options.require_lock = true,
					'p' => {
						options.explicit_pid = true;
						parse_i32_list(value, &mut options.pids)?;
					},
					'O' => {
						options.older = Some(Duration::from_secs(
							value.parse().map_err(|_| (2, "invalid age".to_string()))?,
						));
					},
					'r' => parse_states(value, &mut options.states)?,
					'a' => {
						if cfg!(target_os = "macos") {
							options.include_ancestors = true;
						} else {
							options.list_full = true;
						}
					},
					'A' => options.ignore_ancestors = true,
					'c' => options.count = true,
					'l' if mode == ProcMatchMode::Kill && cfg!(target_os = "macos") => {
						options.echo_command = true;
					},
					'l' => options.list_name = true,
					'q' if mode == ProcMatchMode::Kill && cfg!(target_os = "linux") => {
						options.queue = Some(
							value
								.parse()
								.map_err(|_| (2, "invalid queue value".to_string()))?,
						);
					},
					'q' if mode == ProcMatchMode::Grep && cfg!(target_os = "macos") => {
						options.quiet = true;
					},
					'q' => return Err((2, "unrecognized option '-q'".to_string())),
					'd' => options.delimiter = value.to_string(),
					'e' if mode != ProcMatchMode::Grep => options.echo = true,
					'I' if mode == ProcMatchMode::Kill && cfg!(target_os = "macos") => {
						options.interactive = true;
					},
					'I' if mode == ProcMatchMode::Kill => {
						return Err((2, "unrecognized option '-I'".to_string()));
					},
					'w' | 'H' => {
						return Err((2, format!("unsupported option '-{option}'")));
					},
					_ => return Err((2, format!("unrecognized option '-{option}'"))),
				}
				short_index += 1;
			}
			index += 1;
			continue;
		}
		options.patterns.push(arg.clone());
		index += 1;
	}

	#[cfg(target_os = "windows")]
	if !options.groups.is_empty()
		|| !options.sessions.is_empty()
		|| !options.effective_users.is_empty()
		|| !options.real_users.is_empty()
		|| !options.real_groups.is_empty()
		|| !options.terminals.is_empty()
	{
		return Err((2, "selected process metadata is unavailable on Windows".to_string()));
	}

	if options.explicit_pid && !options.pid_files.is_empty() {
		return Err((2, "-F and -p cannot be combined".to_string()));
	}
	if options.require_lock && options.pid_files.is_empty() {
		return Err((2, "-L requires -F".to_string()));
	}
	for file in &options.pid_files {
		let contents = if file == "-" {
			if options.require_lock {
				return Err((2, "-L cannot be used with '-F -'".to_string()));
			}
			let mut contents = String::new();
			stdin
				.read_to_string(&mut contents)
				.map_err(|err| (3, format!("cannot read pidfile from standard input: {err}")))?;
			contents
		} else {
			let path = resolve_shell_path(cwd, file);
			let mut pidfile = fs::File::open(&path)
				.map_err(|err| (3, format!("cannot read pidfile '{}': {err}", path.display())))?;
			if options.require_lock
				&& !pidfile_is_locked(&pidfile)
					.map_err(|err| (3, format!("cannot inspect pidfile '{}': {err}", path.display())))?
			{
				return Err((3, format!("pidfile '{}' is not locked", path.display())));
			}
			let mut contents = String::new();
			io::Read::read_to_string(&mut pidfile, &mut contents)
				.map_err(|err| (3, format!("cannot read pidfile '{}': {err}", path.display())))?;
			contents
		};
		let pid = contents
			.split_whitespace()
			.next()
			.and_then(|value| value.parse::<i32>().ok())
			.filter(|pid| *pid > 0)
			.ok_or_else(|| (3, format!("invalid pidfile '{file}'")))?;
		options.pids.push(pid);
	}
	if !cfg!(target_os = "macos") && options.patterns.len() > 1 {
		return Err((2, "only one pattern can be provided".to_string()));
	}
	if options.patterns.is_empty() && !has_proc_selectors(&options) {
		return Err((2, "no matching criteria specified".to_string()));
	}
	if options.invert && (options.newest || options.oldest) {
		return Err((2, "-v cannot be combined with -n or -o".to_string()));
	}
	if options.newest && options.oldest {
		return Err((2, "-n and -o are mutually exclusive".to_string()));
	}
	if mode != ProcMatchMode::Grep
		&& (options.list_name || options.list_full || options.delimiter != "\n")
	{
		return Err((2, "unsupported output-format option for this command".to_string()));
	}
	Ok(ParseProcResult::Options(Box::new(options)))
}

fn has_proc_selectors(options: &ProcMatchOptions) -> bool {
	!options.parents.is_empty()
		|| !options.groups.is_empty()
		|| !options.sessions.is_empty()
		|| !options.effective_users.is_empty()
		|| !options.real_users.is_empty()
		|| !options.real_groups.is_empty()
		|| !options.terminals.is_empty()
		|| !options.pids.is_empty()
		|| options.older.is_some()
		|| !options.states.is_empty()
}

fn select_processes(
	options: &mut ProcMatchOptions,
) -> std::result::Result<Vec<proc_snapshot::ProcInfo>, String> {
	let all = proc_snapshot::ProcInfo::all();
	let host_pid = std::process::id() as i32;
	let host_group = all
		.iter()
		.find(|process| process.pid() == host_pid)
		.and_then(proc_snapshot::ProcInfo::group_id);
	let host_session = all
		.iter()
		.find(|process| process.pid() == host_pid)
		.and_then(proc_snapshot::ProcInfo::session_id);
	if let Some(host_group) = host_group {
		for group in &mut options.groups {
			if *group == 0 {
				*group = host_group;
			}
		}
	}
	if let Some(host_session) = host_session {
		for session in &mut options.sessions {
			if *session == 0 {
				*session = host_session;
			}
		}
	}
	let by_pid: HashMap<i32, Option<i32>> = all
		.iter()
		.map(|process| (process.pid(), process.ppid()))
		.collect();
	let exclude_ancestors = options.ignore_ancestors
		|| (cfg!(target_os = "macos") && !options.include_ancestors && !options.invert);
	let mut forbidden = HashSet::from([host_pid]);
	if exclude_ancestors {
		let mut current = by_pid.get(&host_pid).copied().flatten();
		while let Some(pid) = current {
			if !forbidden.insert(pid) {
				break;
			}
			current = by_pid.get(&pid).copied().flatten();
		}
	}
	let regex = if options.patterns.is_empty() {
		None
	} else {
		let source = options
			.patterns
			.iter()
			.map(|pattern| {
				if options.exact {
					format!("^(?:{pattern})$")
				} else {
					format!("(?:{pattern})")
				}
			})
			.collect::<Vec<_>>()
			.join("|");
		Some(
			regex::RegexBuilder::new(&source)
				.case_insensitive(options.ignore_case)
				.build()
				.map_err(|err| format!("invalid regular expression: {err}"))?,
		)
	};
	let mut selected = Vec::new();
	for process in all {
		if forbidden.contains(&process.pid()) {
			continue;
		}
		let pattern_matches = regex.as_ref().is_none_or(|regex| {
			let subject = if options.full {
				process.args().join(" ")
			} else {
				process.match_name()
			};
			regex.is_match(&subject)
		});
		let selectors_match = (options.parents.is_empty()
			|| process
				.ppid()
				.is_some_and(|value| options.parents.contains(&value)))
			&& (options.groups.is_empty()
				|| process
					.group_id()
					.is_some_and(|value| options.groups.contains(&value)))
			&& (options.sessions.is_empty()
				|| process
					.session_id()
					.is_some_and(|value| options.sessions.contains(&value)))
			&& (options.effective_users.is_empty()
				|| process
					.effective_user_id()
					.is_some_and(|value| options.effective_users.contains(&value)))
			&& (options.real_users.is_empty()
				|| process
					.real_user_id()
					.is_some_and(|value| options.real_users.contains(&value)))
			&& (options.real_groups.is_empty()
				|| process
					.real_group_id()
					.is_some_and(|value| options.real_groups.contains(&value)))
			&& (options.terminals.is_empty() || options.terminals.contains(&process.terminal_id()))
			&& (options.pids.is_empty() || options.pids.contains(&process.pid()))
			&& options
				.older
				.is_none_or(|age| process.age().is_some_and(|process_age| process_age >= age))
			&& (options.states.is_empty() || options.states.contains(&process.state()));
		let matches = pattern_matches && selectors_match;
		if matches != options.invert {
			selected.push(process);
		}
	}
	selected.sort_by_key(|process| (process.start_time(), process.pid()));
	if options.newest {
		selected = selected.into_iter().next_back().into_iter().collect();
	} else if options.oldest {
		selected.truncate(1);
	}
	Ok(selected)
}

fn parse_i32_list(value: &str, target: &mut Vec<i32>) -> std::result::Result<(), (u8, String)> {
	for item in value.split(',') {
		let parsed = item
			.parse::<i32>()
			.map_err(|_| (2, format!("invalid numeric selector '{item}'")))?;
		target.push(parsed);
	}
	Ok(())
}

fn parse_user_list(value: &str, target: &mut Vec<u32>) -> std::result::Result<(), (u8, String)> {
	for item in value.split(',') {
		target.push(resolve_user(item).ok_or_else(|| (2, format!("unknown user '{item}'")))?);
	}
	Ok(())
}

fn parse_group_list(value: &str, target: &mut Vec<u32>) -> std::result::Result<(), (u8, String)> {
	for item in value.split(',') {
		target.push(resolve_group(item).ok_or_else(|| (2, format!("unknown group '{item}'")))?);
	}
	Ok(())
}

#[cfg(unix)]
fn resolve_user(value: &str) -> Option<u32> {
	use std::ffi::CString;
	if let Ok(id) = value.parse() {
		return Some(id);
	}
	let name = CString::new(value).ok()?;
	let mut record = std::mem::MaybeUninit::<libc::passwd>::zeroed();
	let mut result = std::ptr::null_mut();
	let mut buffer = vec![0u8; 16 * 1024];
	// SAFETY: all pointers refer to live, writable storage for this call.
	let status = unsafe {
		libc::getpwnam_r(
			name.as_ptr(),
			record.as_mut_ptr(),
			buffer.as_mut_ptr().cast(),
			buffer.len(),
			&raw mut result,
		)
	};
	if status != 0 || result.is_null() {
		return None;
	}
	// SAFETY: a successful getpwnam_r call initialized `record`.
	Some(unsafe { record.assume_init() }.pw_uid)
}

#[cfg(not(unix))]
fn resolve_user(value: &str) -> Option<u32> {
	value.parse().ok()
}

#[cfg(unix)]
fn resolve_group(value: &str) -> Option<u32> {
	use std::ffi::CString;
	if let Ok(id) = value.parse() {
		return Some(id);
	}
	let name = CString::new(value).ok()?;
	let mut record = std::mem::MaybeUninit::<libc::group>::zeroed();
	let mut result = std::ptr::null_mut();
	let mut buffer = vec![0u8; 16 * 1024];
	// SAFETY: all pointers refer to live, writable storage for this call.
	let status = unsafe {
		libc::getgrnam_r(
			name.as_ptr(),
			record.as_mut_ptr(),
			buffer.as_mut_ptr().cast(),
			buffer.len(),
			&raw mut result,
		)
	};
	if status != 0 || result.is_null() {
		return None;
	}
	// SAFETY: a successful getgrnam_r call initialized `record`.
	Some(unsafe { record.assume_init() }.gr_gid)
}

#[cfg(not(unix))]
fn resolve_group(value: &str) -> Option<u32> {
	value.parse().ok()
}

fn parse_terminal_list(
	value: &str,
	target: &mut Vec<Option<u64>>,
) -> std::result::Result<(), (u8, String)> {
	for item in value.split(',') {
		if matches!(item, "?" | "-") {
			target.push(None);
		} else if let Some(id) = resolve_terminal(item) {
			target.push(Some(id));
		} else if let Ok(id) = item.parse() {
			target.push(Some(id));
		} else {
			return Err((2, format!("unknown terminal '{item}'")));
		}
	}
	Ok(())
}

#[cfg(unix)]
fn resolve_terminal(value: &str) -> Option<u64> {
	use std::os::unix::fs::MetadataExt;
	let primary = if value.starts_with('/') {
		PathBuf::from(value)
	} else {
		Path::new("/dev").join(value)
	};
	fs::metadata(&primary)
		.or_else(|_| fs::metadata(Path::new("/dev").join(format!("tty{value}"))))
		.ok()
		.map(|metadata| metadata.rdev())
}

#[cfg(not(unix))]
fn resolve_terminal(_value: &str) -> Option<u64> {
	None
}

fn parse_states(value: &str, target: &mut HashSet<char>) -> std::result::Result<(), (u8, String)> {
	for state in value.split(',').flat_map(str::chars) {
		if !state.is_ascii_alphabetic() {
			return Err((2, format!("invalid process state '{state}'")));
		}
		target.insert(state.to_ascii_uppercase());
	}
	Ok(())
}

#[derive(Parser)]
struct KillCommand {
	#[arg(short = 's', value_name = "SIG_NAME")]
	signal_name:      Option<String>,
	#[arg(short = 'n', value_name = "SIG_NUM")]
	signal_number:    Option<usize>,
	#[arg(short = 'l', short_alias = 'L')]
	list_signals:     bool,
	#[arg(allow_hyphen_values = true)]
	args:             Vec<String>,
	#[arg(last = true, allow_hyphen_values = true)]
	post_marker_args: Vec<String>,
}

#[derive(Clone, Copy)]
enum KillSignal {
	Probe,
	Signal(TrapSignal),
}

impl KillSignal {
	fn parse(value: &str) -> std::result::Result<Self, brush_core::Error> {
		if let Ok(number) = value.parse::<i32>() {
			if number == 0 {
				Ok(Self::Probe)
			} else {
				TrapSignal::try_from(number).map(Self::Signal)
			}
		} else {
			TrapSignal::try_from(value).map(Self::Signal)
		}
	}

	const fn sends_signal(self) -> bool {
		matches!(self, Self::Signal(_))
	}
}

impl builtins::Command for KillCommand {
	type Error = brush_core::Error;

	#[allow(unknown_lints, reason = "unused_async_trait_impl is unknown to the pinned CI nightly")]
	#[allow(
		clippy::unused_async_trait_impl,
		reason = "the builtin Command trait declares execute as async"
	)]
	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> std::result::Result<ExecutionResult, Self::Error> {
		let default_signal = if let Some(signal_name) = &self.signal_name {
			if let Ok(signal) = KillSignal::parse(signal_name) {
				signal
			} else {
				writeln!(
					context.stderr(),
					"{}: invalid signal name: {}",
					context.command_name,
					signal_name
				)?;
				return Ok(ExecutionExitCode::InvalidUsage.into());
			}
		} else {
			KillSignal::parse("TERM")?
		};
		let mut signal = match self.signal_number {
			Some(signal_number) => {
				let Ok(signal_number) = i32::try_from(signal_number) else {
					writeln!(
						context.stderr(),
						"{}: invalid signal number: {}",
						context.command_name,
						signal_number
					)?;
					return Ok(ExecutionExitCode::InvalidUsage.into());
				};
				if let Ok(signal) = KillSignal::parse(&signal_number.to_string()) {
					signal
				} else {
					writeln!(
						context.stderr(),
						"{}: invalid signal number: {}",
						context.command_name,
						signal_number
					)?;
					return Ok(ExecutionExitCode::InvalidUsage.into());
				}
			},
			None => default_signal,
		};

		let mut operands: Vec<&String> = Vec::new();
		let mut options_done = self.signal_name.is_some() || self.signal_number.is_some();
		let mut consumed_marker = false;
		for arg in &self.args {
			if !consumed_marker && arg == "--" {
				consumed_marker = true;
				options_done = true;
				continue;
			}
			if !options_done && let Some(spec) = arg.strip_prefix('-').filter(|spec| !spec.is_empty())
			{
				signal = if let Ok(signal) = KillSignal::parse(spec) {
					signal
				} else {
					writeln!(context.stderr(), "{}: invalid signal name", context.command_name)?;
					return Ok(ExecutionExitCode::InvalidUsage.into());
				};
				options_done = true;
				continue;
			}
			options_done = true;
			operands.push(arg);
		}
		operands.extend(&self.post_marker_args);

		if self.list_signals {
			return print_kill_signals(&context, operands);
		}
		if operands.is_empty() {
			writeln!(context.stderr(), "{}: invalid usage", context.command_name)?;
			return Ok(ExecutionExitCode::InvalidUsage.into());
		}

		let mut had_failure = false;
		for operand in operands {
			if context.is_cancelled() {
				return Ok(ExecutionExitCode::Interrupted.into());
			}
			if operand.starts_with('%') {
				let Some(job) = context.shell.jobs_mut().resolve_job_spec(operand) else {
					writeln!(context.stderr(), "{}: {}: no such job", context.command_name, operand)?;
					had_failure = true;
					continue;
				};
				#[cfg(unix)]
				{
					let mut targets: Vec<i32> = job
						.process_ids()
						.filter_map(|pid| {
							// SAFETY: getpgid reads process-group metadata for a managed child.
							let pgid = unsafe { libc::getpgid(pid) };
							(pgid > 0).then_some(-pgid)
						})
						.collect();
					if targets.is_empty()
						&& let Some(pgid) = job.process_group_id()
					{
						targets.push(-pgid);
					}
					targets.sort_unstable();
					targets.dedup();
					if signal.sends_signal() && targets.iter().copied().any(kill_target_includes_host) {
						writeln!(
							context.stderr(),
							"{}: {}: refusing to signal the shell process",
							context.command_name,
							operand
						)?;
						had_failure = true;
						continue;
					}
					let succeeded = match signal {
						KillSignal::Probe => targets.iter().copied().any(probe_kill_target),
						KillSignal::Signal(signal) => {
							let mut succeeded = false;
							for target in targets {
								if sys::signal::kill_process(target, signal).is_ok() {
									succeeded = true;
								}
							}
							succeeded
						},
					};
					if !succeeded {
						writeln!(
							context.stderr(),
							"{}: {}: failed to send signal",
							context.command_name,
							operand
						)?;
						had_failure = true;
					}
				}
				#[cfg(windows)]
				{
					let job_group = job.process_group_id();
					if signal.sends_signal()
						&& (job_group.is_some_and(kill_job_group_includes_host)
							|| job.process_ids().any(kill_pid_is_host))
					{
						writeln!(
							context.stderr(),
							"{}: {}: refusing to signal the shell process",
							context.command_name,
							operand
						)?;
						had_failure = true;
						continue;
					}
					let expected_handles = job.external_process_count();
					let handles = job.duplicate_kill_handles();
					let mut succeeded = expected_handles != 0 && handles.len() == expected_handles;
					for handle in &handles {
						let handled = match signal {
							KillSignal::Probe => brush_core::processes::process_handle_is_running(handle),
							KillSignal::Signal(_) => {
								brush_core::processes::terminate_process_handle(handle)
							},
						};
						if !handled {
							succeeded = false;
						}
					}
					if !succeeded {
						writeln!(
							context.stderr(),
							"{}: {}: failed to send signal",
							context.command_name,
							operand
						)?;
						had_failure = true;
					}
				}
				#[cfg(all(not(unix), not(windows)))]
				{
					let job_group = job.process_group_id();
					let representative = job.representative_pid();
					if signal.sends_signal()
						&& (job_group.is_some_and(kill_job_group_includes_host)
							|| representative.is_some_and(kill_pid_is_host))
					{
						writeln!(
							context.stderr(),
							"{}: {}: refusing to signal the shell process",
							context.command_name,
							operand
						)?;
						had_failure = true;
						continue;
					}
					match signal {
						KillSignal::Probe => {
							if !representative.is_some_and(probe_kill_target) {
								writeln!(
									context.stderr(),
									"{}: {}: failed to send signal",
									context.command_name,
									operand
								)?;
								had_failure = true;
							}
						},
						KillSignal::Signal(signal) => {
							if let Err(err) = job.kill(signal) {
								writeln!(
									context.stderr(),
									"{}: {}: {}",
									context.command_name,
									operand,
									err
								)?;
								had_failure = true;
							}
						},
					}
				}
				continue;
			}

			let pid = match brush_core::int_utils::parse(operand, 10) {
				Ok(pid) => pid,
				Err(err) => {
					writeln!(context.stderr(), "{}: {}: {}", context.command_name, operand, err)?;
					had_failure = true;
					continue;
				},
			};
			if signal.sends_signal() && kill_target_includes_host(pid) {
				writeln!(
					context.stderr(),
					"{}: {}: refusing to signal the shell process",
					context.command_name,
					operand
				)?;
				had_failure = true;
				continue;
			}
			match signal {
				KillSignal::Probe => {
					if !probe_kill_target(pid) {
						writeln!(
							context.stderr(),
							"{}: {}: failed to send signal",
							context.command_name,
							operand
						)?;
						had_failure = true;
					}
				},
				KillSignal::Signal(signal) => {
					if let Err(err) = sys::signal::kill_process(pid, signal) {
						writeln!(context.stderr(), "{}: {}: {}", context.command_name, operand, err)?;
						had_failure = true;
					}
				},
			}
		}

		if had_failure {
			Ok(ExecutionResult::general_error())
		} else {
			Ok(ExecutionResult::success())
		}
	}
}

fn kill_pid_is_host(pid: i32) -> bool {
	i32::try_from(std::process::id()).ok() == Some(pid)
}

#[cfg(not(unix))]
fn kill_job_group_includes_host(pgid: i32) -> bool {
	kill_pid_is_host(pgid)
}

fn kill_target_includes_host(target: i32) -> bool {
	if target == -1 || target == 0 || kill_pid_is_host(target) {
		return true;
	}
	#[cfg(unix)]
	{
		// SAFETY: getpgrp has no arguments or memory access.
		target.checked_neg() == Some(unsafe { libc::getpgrp() })
	}
	#[cfg(not(unix))]
	{
		false
	}
}

#[cfg(unix)]
fn probe_kill_target(target: i32) -> bool {
	// SAFETY: signal 0 only checks target existence and permission.
	unsafe { libc::kill(target, 0) == 0 }
}

#[cfg(not(unix))]
fn probe_kill_target(target: i32) -> bool {
	target > 0
		&& proc_snapshot::ProcInfo::all().into_iter().any(|process| {
			process.pid() == target && process.status() == process::ProcessStatus::Running
		})
}

fn print_kill_signals<'a>(
	context: &ExecutionContext<'_, impl brush_core::ShellExtensions>,
	signals: impl IntoIterator<Item = &'a String>,
) -> std::result::Result<ExecutionResult, brush_core::Error> {
	let mut result = ExecutionResult::success();
	let mut signals = signals.into_iter().peekable();
	if signals.peek().is_none() {
		return traps::format_signals(
			context.stdout(),
			TrapSignal::iterator().filter(|signal| !matches!(signal, TrapSignal::Exit)),
		)
		.map(|()| ExecutionResult::success());
	}
	for value in signals {
		enum PrintedSignal {
			Name(&'static str),
			Number(i32),
		}
		let signal = if let Ok(number) = value.parse::<i32>() {
			TrapSignal::try_from(number).map(|signal| {
				PrintedSignal::Name(
					signal
						.as_str()
						.strip_prefix("SIG")
						.unwrap_or(signal.as_str()),
				)
			})
		} else {
			TrapSignal::try_from(value.as_str()).map(|signal| {
				i32::try_from(signal)
					.map_or(PrintedSignal::Name(signal.as_str()), PrintedSignal::Number)
			})
		};
		match signal {
			Ok(PrintedSignal::Name(name)) => writeln!(context.stdout(), "{name}")?,
			Ok(PrintedSignal::Number(number)) => writeln!(context.stdout(), "{number}")?,
			Err(err) => {
				writeln!(context.stderr(), "{err}")?;
				result = ExecutionResult::general_error();
			},
		}
	}
	Ok(result)
}

fn signal_number(value: &str) -> Option<i32> {
	let value = value
		.strip_prefix("SIG")
		.or_else(|| value.strip_prefix("sig"))
		.unwrap_or(value);
	if let Ok(number) = value.parse::<i32>() {
		#[cfg(target_os = "linux")]
		return (0..=libc::SIGRTMAX()).contains(&number).then_some(number);
		#[cfg(target_os = "macos")]
		return (0..=31).contains(&number).then_some(number);
		#[cfg(not(unix))]
		return (0..=64).contains(&number).then_some(number);
	}
	match KillSignal::parse(value).ok()? {
		KillSignal::Probe => Some(0),
		KillSignal::Signal(signal) => i32::try_from(signal).ok(),
	}
}

fn resolve_shell_path(cwd: &Path, value: &str) -> PathBuf {
	let path = Path::new(value);
	if path.is_absolute() {
		path.to_path_buf()
	} else {
		cwd.join(path)
	}
}

#[cfg(unix)]
fn pidfile_is_locked(file: &fs::File) -> io::Result<bool> {
	use std::os::fd::AsRawFd;
	let mut lock = libc::flock {
		l_type:   libc::F_WRLCK as libc::c_short,
		l_whence: libc::SEEK_SET as libc::c_short,
		l_start:  0,
		l_len:    0,
		l_pid:    0,
	};
	// SAFETY: `file` owns a valid fd and `lock` is writable for F_GETLK.
	if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETLK, &raw mut lock) } == -1 {
		return Err(io::Error::last_os_error());
	}
	Ok(lock.l_type != libc::F_UNLCK as libc::c_short)
}

#[cfg(not(unix))]
fn pidfile_is_locked(_file: &fs::File) -> io::Result<bool> {
	Err(io::Error::new(
		io::ErrorKind::Unsupported,
		"pidfile lock validation is unavailable on this platform",
	))
}

fn write_proc_match_help(
	mut output: impl Write,
	name: &str,
	mode: ProcMatchMode,
) -> io::Result<()> {
	let action = match mode {
		ProcMatchMode::Grep => "print matching process IDs",
		ProcMatchMode::Kill => "signal matching processes",
		ProcMatchMode::Wait => "wait for matching processes",
	};
	writeln!(output, "Usage: {name} [options] [pattern ...]")?;
	writeln!(output, "{action}")?;
	writeln!(
		output,
		"  -f full command  -x exact  -i ignore case  -v invert  -n newest  -o oldest"
	)?;
	#[cfg(not(target_os = "windows"))]
	writeln!(
		output,
		"  -P ppid  -g pgrp  -s sid  -u euid  -U uid  -G gid  -t tty  -p pid  -F pidfile"
	)?;
	#[cfg(target_os = "windows")]
	writeln!(output, "  -P ppid  -p pid  -F pidfile  -O seconds  -r states")?;
	if mode == ProcMatchMode::Kill {
		writeln!(output, "  -SIGNAL, --signal SIGNAL  choose signal (default TERM)")?;
	}
	#[cfg(target_os = "linux")]
	if mode == ProcMatchMode::Kill {
		writeln!(output, "  -q value, --queue value  send an integer with sigqueue")?;
	}
	#[cfg(target_os = "macos")]
	if mode == ProcMatchMode::Grep {
		writeln!(output, "  -q  suppress output")?;
	}
	Ok(())
}

#[derive(Parser)]
#[command(disable_help_flag = true)]
struct SleepCommand {
	#[arg(required = true)]
	durations: Vec<String>,
}

impl builtins::Command for SleepCommand {
	type Error = brush_core::Error;

	fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> impl Future<Output = std::result::Result<ExecutionResult, brush_core::Error>> + Send {
		let durations = self.durations.clone();
		async move {
			if context.is_cancelled() {
				return Ok(ExecutionExitCode::Interrupted.into());
			}
			let mut total = Duration::from_millis(0);
			for duration in &durations {
				let Some(parsed) = parse_duration(duration) else {
					let _ = writeln!(context.stderr(), "sleep: invalid time interval '{duration}'");
					return Ok(ExecutionResult::new(1));
				};
				total += parsed;
			}
			let sleep = time::sleep(total);
			tokio::pin!(sleep);
			if let Some(cancel_token) = context.cancel_token() {
				tokio::select! {
					() = &mut sleep => Ok(ExecutionResult::success()),
					() = cancel_token.cancelled() => Ok(ExecutionExitCode::Interrupted.into()),
				}
			} else {
				sleep.await;
				Ok(ExecutionResult::success())
			}
		}
	}
}

#[derive(Parser)]
#[command(disable_help_flag = true)]
struct TimeoutCommand {
	#[arg(required = true)]
	duration: String,
	#[arg(required = true, num_args = 1.., trailing_var_arg = true)]
	command:  Vec<String>,
}

impl builtins::Command for TimeoutCommand {
	type Error = brush_core::Error;

	fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> impl Future<Output = std::result::Result<ExecutionResult, brush_core::Error>> + Send {
		let duration = self.duration.clone();
		let command = self.command.clone();
		async move {
			if context.is_cancelled() {
				return Ok(ExecutionExitCode::Interrupted.into());
			}
			let Some(timeout) = parse_duration(&duration) else {
				let _ = writeln!(context.stderr(), "timeout: invalid time interval '{duration}'");
				return Ok(ExecutionResult::new(125));
			};
			if command.is_empty() {
				let _ = writeln!(context.stderr(), "timeout: missing command");
				return Ok(ExecutionResult::new(125));
			}

			let child_cancel = CancellationToken::new();
			let mut params = context.params.clone();
			params.process_group_policy = ProcessGroupPolicy::NewProcessGroup;
			params.set_cancel_token(child_cancel.clone());

			let mut command_line = String::new();
			for (idx, arg) in command.iter().enumerate() {
				if idx > 0 {
					command_line.push(' ');
				}
				command_line.push_str(&quote_arg(arg));
			}

			let cancel_token = context.cancel_token();
			let source_info = SourceInfo::from("pi-natives:timeout");
			let run_future = context
				.shell
				.run_string(command_line, &source_info, &params);
			tokio::pin!(run_future);

			if let Some(cancel_token) = cancel_token {
				tokio::select! {
					result = &mut run_future => result,
					() = time::sleep(timeout) => {
						child_cancel.cancel();
						// Wait briefly for the child to exit after cancellation.
						let _ = time::timeout(Duration::from_secs(2), &mut run_future).await;
						Ok(ExecutionResult::new(124))
					},
					() = cancel_token.cancelled() => {
						child_cancel.cancel();
						Ok(ExecutionExitCode::Interrupted.into())
					},
				}
			} else {
				tokio::select! {
					result = &mut run_future => result,
					() = time::sleep(timeout) => {
						child_cancel.cancel();
						// Wait briefly for the child to exit after cancellation.
						let _ = time::timeout(Duration::from_secs(2), &mut run_future).await;
						Ok(ExecutionResult::new(124))
					},
				}
			}
		}
	}
}

#[derive(Parser)]
#[command(disable_help_flag = true, disable_version_flag = true)]
struct PsCommand {
	#[arg(num_args = 0.., trailing_var_arg = true, allow_hyphen_values = true)]
	argv: Vec<String>,
}

#[derive(Default)]
struct PsOptions {
	all:                 bool,
	other_users:         bool,
	include_no_terminal: bool,
	full_format:         bool,
	long_format:         bool,
	user_format:         bool,
	job_format:          bool,
	memory_format:       bool,
	bsd_syntax:          bool,
	command_only:        bool,
	running_only:        bool,
	no_headers:          bool,
	custom_format:       bool,
	pids:                Vec<i32>,
	parents:             Vec<i32>,
	groups:              Vec<i32>,
	sessions:            Vec<i32>,
	effective_users:     Vec<u32>,
	real_users:          Vec<u32>,
	real_groups:         Vec<u32>,
	terminals:           Vec<Option<u64>>,
	columns:             Vec<PsColumn>,
	sort:                Vec<PsSort>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PsField {
	User,
	Uid,
	Pid,
	Ppid,
	Pgid,
	Sid,
	Tty,
	State,
	Start,
	LongStart,
	Elapsed,
	ElapsedSeconds,
	CpuTime,
	CpuPercent,
	CpuInteger,
	MemPercent,
	VirtualSize,
	ResidentSize,
	Nice,
	Threads,
	Command,
	Args,
	Tpgid,
	StateChar,
	Priority,
	Flags,
	Ruser,
	Ruid,
	Rgroup,
	Rgid,
	Egroup,
	Egid,
	Wchan,
	MinorFaults,
	MajorFaults,
	CpuSeconds,
	Size,
}

impl PsField {
	const fn header(self) -> &'static str {
		match self {
			Self::User => "USER",
			Self::Uid => "UID",
			Self::Pid => "PID",
			Self::Ppid => "PPID",
			Self::Pgid => "PGID",
			Self::Sid => "SID",
			Self::Tty => "TTY",
			Self::State => "STAT",
			Self::Start => "START",
			Self::LongStart => "STARTED",
			Self::Elapsed => "ELAPSED",
			Self::ElapsedSeconds => "ELAPSED",
			Self::CpuTime => "TIME",
			Self::CpuPercent => "%CPU",
			Self::CpuInteger => "C",
			Self::MemPercent => "%MEM",
			Self::VirtualSize => "VSZ",
			Self::ResidentSize => "RSS",
			Self::Nice => "NI",
			Self::Threads => "NLWP",
			Self::Command => "COMMAND",
			Self::Args => "COMMAND",
			Self::Tpgid => "TPGID",
			Self::StateChar => "S",
			Self::Priority => "PRI",
			Self::Flags => "F",
			Self::Ruser => "RUSER",
			Self::Ruid => "RUID",
			Self::Rgroup => "RGROUP",
			Self::Rgid => "RGID",
			Self::Egroup => "GROUP",
			Self::Egid => "GID",
			Self::Wchan => "WCHAN",
			Self::MinorFaults => "MINFL",
			Self::MajorFaults => "MAJFL",
			Self::CpuSeconds => "TIME",
			Self::Size => "SZ",
		}
	}

	const fn right_aligned(self) -> bool {
		matches!(
			self,
			Self::Uid
				| Self::Pid
				| Self::Ppid
				| Self::Pgid
				| Self::Sid
				| Self::ElapsedSeconds
				| Self::CpuPercent
				| Self::CpuInteger
				| Self::MemPercent
				| Self::VirtualSize
				| Self::ResidentSize
				| Self::Nice
				| Self::Threads
				| Self::Tpgid
				| Self::Priority
				| Self::Flags
				| Self::Ruid
				| Self::Rgid
				| Self::Egid
				| Self::MinorFaults
				| Self::MajorFaults
				| Self::CpuSeconds
				| Self::Size
		)
	}
}

#[derive(Clone)]
struct PsColumn {
	field:     PsField,
	header:    String,
	min_width: usize,
}

impl PsColumn {
	fn new(field: PsField) -> Self {
		Self { field, header: field.header().to_string(), min_width: 0 }
	}

	fn with_header(field: PsField, header: &str) -> Self {
		Self { field, header: header.to_string(), min_width: 0 }
	}
}

#[derive(Clone, Copy)]
enum PsSortField {
	Pid,
	Ppid,
	Cpu,
	Mem,
	Time,
	Start,
	Command,
}

struct PsSort {
	field:      PsSortField,
	descending: bool,
}

enum ParsePsResult {
	Options(Box<PsOptions>),
	Help,
	Version,
}

struct PsProcessRow {
	pid:           i32,
	ppid:          Option<i32>,
	pgid:          Option<i32>,
	sid:           Option<i32>,
	tpgid:         Option<i32>,
	user:          Option<u32>,
	ruid:          Option<u32>,
	rgid:          Option<u32>,
	egid:          Option<u32>,
	terminal:      Option<u64>,
	state:         char,
	start_time:    u64,
	started_at:    Option<SystemTime>,
	age:           Option<Duration>,
	cpu_time:      Option<Duration>,
	virtual_size:  Option<u64>,
	resident_size: Option<u64>,
	threads:       Option<u32>,
	nice:          Option<i32>,
	priority:      Option<i32>,
	flags:         Option<u64>,
	minor_faults:  Option<u64>,
	major_faults:  Option<u64>,
	wchan:         Option<String>,
	command:       String,
	args:          String,
}

impl PsProcessRow {
	fn from_process(process: proc_snapshot::ProcInfo, now: SystemTime, command_only: bool) -> Self {
		let command = sanitize_process_command(process.command_name());
		let argv = process.args();
		let args = if command_only || argv.is_empty() {
			command.clone()
		} else {
			sanitize_process_command(argv.join(" "))
		};
		let age = process.age();
		Self {
			pid: process.pid(),
			ppid: process.ppid(),
			pgid: process.group_id(),
			sid: process.session_id(),
			tpgid: process.terminal_group_id(),
			user: process
				.effective_user_id()
				.or_else(|| process.real_user_id()),
			ruid: process.real_user_id(),
			rgid: process.real_group_id(),
			egid: process.effective_group_id(),
			terminal: process.terminal_id(),
			state: process.state(),
			start_time: process.start_time(),
			started_at: age.and_then(|age| now.checked_sub(age)),
			age,
			cpu_time: process.cpu_time(),
			virtual_size: process.virtual_bytes(),
			resident_size: process.resident_bytes(),
			threads: process.thread_count(),
			nice: process.nice(),
			priority: process.priority(),
			flags: process.flags(),
			minor_faults: process.minor_faults(),
			major_faults: process.major_faults(),
			wchan: process.wchan(),
			command,
			args,
		}
	}

	fn cpu_percent(&self) -> Option<f64> {
		let age = self.age?.as_secs_f64();
		let cpu_time = self.cpu_time?.as_secs_f64();
		(age > 0.0).then_some(100.0 * cpu_time / age)
	}

	fn memory_percent(&self, total_memory: Option<u64>) -> Option<f64> {
		let total = total_memory.filter(|total| *total > 0)?;
		Some(100.0 * self.resident_size? as f64 / total as f64)
	}
}

impl builtins::Command for PsCommand {
	type Error = brush_core::Error;

	fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> impl Future<Output = std::result::Result<ExecutionResult, brush_core::Error>> + Send {
		let argv = self.argv.clone();
		async move {
			let options = match parse_ps_args(&argv) {
				Ok(ParsePsResult::Options(options)) => *options,
				Ok(ParsePsResult::Help) => {
					write_ps_help(context.stdout())?;
					return Ok(ExecutionResult::success());
				},
				Ok(ParsePsResult::Version) => {
					writeln!(context.stdout(), "ps {}", env!("CARGO_PKG_VERSION"))?;
					return Ok(ExecutionResult::success());
				},
				Err((code, message)) => {
					writeln!(context.stderr(), "ps: {message}")?;
					return Ok(ExecutionResult::new(code));
				},
			};
			if context.is_cancelled() {
				return Ok(ExecutionExitCode::Interrupted.into());
			}

			let mut processes = proc_snapshot::ProcInfo::all();
			let current_pid = i32::try_from(std::process::id()).ok();
			let current =
				current_pid.and_then(|pid| processes.iter().find(|process| process.pid() == pid));
			let current_user = current.and_then(|process| {
				process
					.effective_user_id()
					.or_else(|| process.real_user_id())
			});
			let current_terminal = current.and_then(proc_snapshot::ProcInfo::terminal_id);
			let current_session = current.and_then(proc_snapshot::ProcInfo::session_id);
			processes.retain(|process| {
				ps_process_selected(
					process,
					&options,
					current_pid,
					current_user,
					current_terminal,
					current_session,
				)
			});

			let now = SystemTime::now();
			let mut rows: Vec<_> = processes
				.into_iter()
				.map(|process| PsProcessRow::from_process(process, now, options.command_only))
				.collect();
			sort_ps_rows(&mut rows, &options.sort);
			let columns = ps_columns(&options);
			let output = render_ps_table(&rows, &columns, options.no_headers);
			if let Err(err) = write!(context.stdout(), "{output}") {
				if err.kind() == io::ErrorKind::BrokenPipe {
					return Ok(ExecutionResult::success());
				}
				return Err(err.into());
			}
			Ok(if rows.is_empty() {
				ExecutionResult::new(1)
			} else {
				ExecutionResult::success()
			})
		}
	}
}

fn parse_ps_args(argv: &[String]) -> std::result::Result<ParsePsResult, (u8, String)> {
	let mut options = PsOptions::default();
	let mut index = 0;
	let mut options_done = false;
	while index < argv.len() {
		let arg = &argv[index];
		if !options_done && arg == "--" {
			options_done = true;
			index += 1;
			continue;
		}
		if options_done {
			parse_i32_list(arg, &mut options.pids)?;
			index += 1;
			continue;
		}
		match arg.as_str() {
			"--help" => return Ok(ParsePsResult::Help),
			"--version" => return Ok(ParsePsResult::Version),
			"--all" | "--everyone" => options.all = true,
			"--no-headers" => options.no_headers = true,
			"--headers" => options.no_headers = false,
			_ if arg == "--pid" || arg.starts_with("--pid=") => {
				let value = take_ps_value(argv, &mut index, arg.strip_prefix("--pid="), "--pid")?;
				parse_i32_list(&value, &mut options.pids)?;
			},
			_ if arg == "--ppid" || arg.starts_with("--ppid=") => {
				let value = take_ps_value(argv, &mut index, arg.strip_prefix("--ppid="), "--ppid")?;
				parse_i32_list(&value, &mut options.parents)?;
			},
			_ if arg == "--group" || arg.starts_with("--group=") => {
				let value = take_ps_value(argv, &mut index, arg.strip_prefix("--group="), "--group")?;
				parse_i32_list(&value, &mut options.groups)?;
			},
			_ if arg == "--sid" || arg.starts_with("--sid=") => {
				let value = take_ps_value(argv, &mut index, arg.strip_prefix("--sid="), "--sid")?;
				parse_i32_list(&value, &mut options.sessions)?;
			},
			_ if arg == "--user" || arg.starts_with("--user=") => {
				let value = take_ps_value(argv, &mut index, arg.strip_prefix("--user="), "--user")?;
				parse_user_list(&value, &mut options.effective_users)?;
			},
			_ if arg == "--User" || arg.starts_with("--User=") => {
				let value = take_ps_value(argv, &mut index, arg.strip_prefix("--User="), "--User")?;
				parse_user_list(&value, &mut options.real_users)?;
			},
			_ if arg == "--tty" || arg.starts_with("--tty=") => {
				let value = take_ps_value(argv, &mut index, arg.strip_prefix("--tty="), "--tty")?;
				parse_terminal_list(&value, &mut options.terminals)?;
			},
			_ if arg == "--format" || arg.starts_with("--format=") => {
				let value = take_ps_value(argv, &mut index, arg.strip_prefix("--format="), "--format")?;
				parse_ps_format(&value, &mut options.columns)?;
				options.custom_format = true;
			},
			_ if arg == "--sort" || arg.starts_with("--sort=") => {
				let value = take_ps_value(argv, &mut index, arg.strip_prefix("--sort="), "--sort")?;
				parse_ps_sort(&value, &mut options.sort)?;
			},
			_ if let Some(group) = arg.strip_prefix('-') => {
				if group.is_empty() {
					return Err((1, "invalid option '-'".to_string()));
				}
				let bsd = group.contains('x');
				parse_ps_flag_group(group, bsd, argv, &mut index, &mut options)?;
			},
			_ if arg
				.chars()
				.all(|character| character.is_ascii_digit() || character == ',') =>
			{
				parse_i32_list(arg, &mut options.pids)?;
			},
			_ if arg.chars().all(|character| character.is_ascii_alphabetic()) => {
				parse_ps_flag_group(arg, true, argv, &mut index, &mut options)?;
			},
			_ => return Err((1, format!("unsupported operand '{arg}'"))),
		}
		index += 1;
	}
	Ok(ParsePsResult::Options(Box::new(options)))
}

fn take_ps_value(
	argv: &[String],
	index: &mut usize,
	inline: Option<&str>,
	option: &str,
) -> std::result::Result<String, (u8, String)> {
	if let Some(value) = inline {
		if value.is_empty() {
			return Err((1, format!("option '{option}' requires an argument")));
		}
		return Ok(value.to_string());
	}
	*index += 1;
	argv
		.get(*index)
		.filter(|value| !value.is_empty())
		.cloned()
		.ok_or_else(|| (1, format!("option '{option}' requires an argument")))
}

fn parse_ps_flag_group(
	group: &str,
	bsd: bool,
	argv: &[String],
	index: &mut usize,
	options: &mut PsOptions,
) -> std::result::Result<(), (u8, String)> {
	if bsd {
		options.bsd_syntax = true;
	}
	let mut offset = 0;
	while offset < group.len() {
		let option = group.as_bytes()[offset] as char;
		offset += 1;
		let remainder = &group[offset..];
		match option {
			'A' => options.all = true,
			'e' if !bsd => options.all = true,
			'e' => {},
			'a' => options.other_users = true,
			'x' => {
				options.include_no_terminal = true;
				options.bsd_syntax = true;
			},
			'f' => options.full_format = true,
			'l' => options.long_format = true,
			'j' => options.job_format = true,
			'v' => options.memory_format = true,
			'u' if bsd => options.user_format = true,
			'w' => {},
			'c' => options.command_only = true,
			'r' => options.running_only = true,
			'h' => options.no_headers = true,
			'o' => {
				let value =
					take_ps_value(argv, index, (!remainder.is_empty()).then_some(remainder), "-o")?;
				parse_ps_format(&value, &mut options.columns)?;
				options.custom_format = true;
				return Ok(());
			},
			'p' | 'q' => {
				let value = take_ps_value(
					argv,
					index,
					(!remainder.is_empty()).then_some(remainder),
					if option == 'p' { "-p" } else { "-q" },
				)?;
				parse_i32_list(&value, &mut options.pids)?;
				return Ok(());
			},
			'P' => {
				let value =
					take_ps_value(argv, index, (!remainder.is_empty()).then_some(remainder), "-P")?;
				parse_i32_list(&value, &mut options.parents)?;
				return Ok(());
			},
			'g' => {
				let value =
					take_ps_value(argv, index, (!remainder.is_empty()).then_some(remainder), "-g")?;
				parse_i32_list(&value, &mut options.groups)?;
				return Ok(());
			},
			's' => {
				let value =
					take_ps_value(argv, index, (!remainder.is_empty()).then_some(remainder), "-s")?;
				parse_i32_list(&value, &mut options.sessions)?;
				return Ok(());
			},
			't' => {
				let value =
					take_ps_value(argv, index, (!remainder.is_empty()).then_some(remainder), "-t")?;
				parse_terminal_list(&value, &mut options.terminals)?;
				return Ok(());
			},
			'u' => {
				let value =
					take_ps_value(argv, index, (!remainder.is_empty()).then_some(remainder), "-u")?;
				parse_user_list(&value, &mut options.effective_users)?;
				return Ok(());
			},
			'U' => {
				let value =
					take_ps_value(argv, index, (!remainder.is_empty()).then_some(remainder), "-U")?;
				parse_user_list(&value, &mut options.real_users)?;
				return Ok(());
			},
			'G' => {
				let value =
					take_ps_value(argv, index, (!remainder.is_empty()).then_some(remainder), "-G")?;
				parse_group_list(&value, &mut options.real_groups)?;
				return Ok(());
			},
			_ => return Err((1, format!("unsupported option '-{option}'"))),
		}
	}
	Ok(())
}

fn parse_ps_format(
	value: &str,
	columns: &mut Vec<PsColumn>,
) -> std::result::Result<(), (u8, String)> {
	let start_len = columns.len();
	for spec in value.split(',').flat_map(str::split_ascii_whitespace) {
		let (field_spec, header) = spec
			.split_once('=')
			.map_or((spec, None), |(field, header)| (field, Some(header)));
		let (name, min_width) = field_spec
			.rsplit_once(':')
			.and_then(|(name, width)| width.parse::<usize>().ok().map(|width| (name, width)))
			.unwrap_or((field_spec, 0));
		let field = match name.to_ascii_lowercase().as_str() {
			"user" | "uname" | "euser" => PsField::User,
			"uid" | "euid" => PsField::Uid,
			"pid" | "lwp" | "tid" | "spid" | "tgid" => PsField::Pid,
			"ppid" => PsField::Ppid,
			"pgid" | "pgrp" => PsField::Pgid,
			"sid" | "sess" => PsField::Sid,
			"tpgid" => PsField::Tpgid,
			"tty" | "tt" | "tname" => PsField::Tty,
			"stat" | "state" => PsField::State,
			"s" => PsField::StateChar,
			"start" | "stime" | "bsdstart" => PsField::Start,
			"lstart" | "start_time" => PsField::LongStart,
			"etime" | "elapsed" => PsField::Elapsed,
			"etimes" => PsField::ElapsedSeconds,
			"time" | "cputime" | "bsdtime" => PsField::CpuTime,
			"times" | "cputimes" => PsField::CpuSeconds,
			"pcpu" | "%cpu" => PsField::CpuPercent,
			"c" => PsField::CpuInteger,
			"pmem" | "%mem" => PsField::MemPercent,
			"vsz" | "vsize" => PsField::VirtualSize,
			"rss" | "rssize" | "rsz" => PsField::ResidentSize,
			"sz" => PsField::Size,
			"ni" | "nice" => PsField::Nice,
			"pri" | "opri" | "priority" => PsField::Priority,
			"f" | "flag" | "flags" => PsField::Flags,
			"ruser" | "logname" => PsField::Ruser,
			"ruid" => PsField::Ruid,
			"rgroup" => PsField::Rgroup,
			"rgid" => PsField::Rgid,
			"group" | "egroup" => PsField::Egroup,
			"gid" | "egid" => PsField::Egid,
			"wchan" | "mwchan" => PsField::Wchan,
			"min_flt" | "minflt" => PsField::MinorFaults,
			"maj_flt" | "majflt" => PsField::MajorFaults,
			"nlwp" | "thcount" => PsField::Threads,
			"comm" | "ucomm" | "fname" => PsField::Command,
			"args" | "command" | "cmd" => PsField::Args,
			_ => return Err((1, format!("unknown output format specifier '{name}'"))),
		};
		let mut column = PsColumn::new(field);
		if let Some(header) = header {
			column.header = header.to_string();
		}
		column.min_width = min_width;
		columns.push(column);
	}
	if columns.len() == start_len {
		return Err((1, "output format must name at least one column".to_string()));
	}
	Ok(())
}

fn parse_ps_sort(value: &str, sort: &mut Vec<PsSort>) -> std::result::Result<(), (u8, String)> {
	for spec in value.split(',').flat_map(str::split_ascii_whitespace) {
		let (descending, name) = if let Some(name) = spec.strip_prefix('-') {
			(true, name)
		} else {
			(false, spec.strip_prefix('+').unwrap_or(spec))
		};
		let field = match name.to_ascii_lowercase().as_str() {
			"pid" => PsSortField::Pid,
			"ppid" => PsSortField::Ppid,
			"pcpu" | "%cpu" | "cpu" => PsSortField::Cpu,
			"pmem" | "%mem" | "mem" | "rss" => PsSortField::Mem,
			"time" | "cputime" => PsSortField::Time,
			"start" | "lstart" => PsSortField::Start,
			"comm" | "command" | "cmd" => PsSortField::Command,
			_ => return Err((1, format!("unknown sort specifier '{name}'"))),
		};
		sort.push(PsSort { field, descending });
	}
	if sort.is_empty() {
		return Err((1, "sort must name at least one column".to_string()));
	}
	Ok(())
}

fn ps_process_selected(
	process: &proc_snapshot::ProcInfo,
	options: &PsOptions,
	current_pid: Option<i32>,
	current_user: Option<u32>,
	current_terminal: Option<u64>,
	current_session: Option<i32>,
) -> bool {
	if options.running_only && process.state() != 'R' {
		return false;
	}
	let has_selectors = !options.pids.is_empty()
		|| !options.parents.is_empty()
		|| !options.groups.is_empty()
		|| !options.sessions.is_empty()
		|| !options.effective_users.is_empty()
		|| !options.real_users.is_empty()
		|| !options.real_groups.is_empty()
		|| !options.terminals.is_empty();
	if options.all {
		return true;
	}
	if has_selectors {
		return options.pids.contains(&process.pid())
			|| process
				.ppid()
				.is_some_and(|value| options.parents.contains(&value))
			|| process
				.group_id()
				.is_some_and(|value| options.groups.contains(&value))
			|| process
				.session_id()
				.is_some_and(|value| options.sessions.contains(&value))
			|| process
				.effective_user_id()
				.is_some_and(|value| options.effective_users.contains(&value))
			|| process
				.real_user_id()
				.is_some_and(|value| options.real_users.contains(&value))
			|| process
				.real_group_id()
				.is_some_and(|value| options.real_groups.contains(&value))
			|| options.terminals.contains(&process.terminal_id());
	}
	if options.other_users {
		return options.include_no_terminal || process.terminal_id().is_some();
	}
	if current_user.is_some_and(|user| {
		process.effective_user_id() != Some(user) && process.real_user_id() != Some(user)
	}) {
		return false;
	}
	if options.include_no_terminal {
		return true;
	}
	if cfg!(target_os = "macos") {
		return process.terminal_id().is_some();
	}
	if let Some(terminal) = current_terminal {
		return process.terminal_id() == Some(terminal);
	}
	if let Some(session) = current_session {
		return process.session_id() == Some(session);
	}
	current_pid.is_none_or(|pid| process.pid() == pid)
}

fn ps_columns(options: &PsOptions) -> Vec<PsColumn> {
	if options.custom_format {
		return options.columns.clone();
	}
	let columns = if options.user_format {
		vec![
			(PsField::User, "USER"),
			(PsField::Pid, "PID"),
			(PsField::CpuPercent, "%CPU"),
			(PsField::MemPercent, "%MEM"),
			(PsField::VirtualSize, "VSZ"),
			(PsField::ResidentSize, "RSS"),
			(PsField::Tty, "TTY"),
			(PsField::State, "STAT"),
			(PsField::Start, "START"),
			(PsField::CpuTime, "TIME"),
			(PsField::Args, "COMMAND"),
		]
	} else if options.long_format {
		vec![
			(PsField::StateChar, "S"),
			(PsField::Uid, "UID"),
			(PsField::Pid, "PID"),
			(PsField::Ppid, "PPID"),
			(PsField::Pgid, "PGID"),
			(PsField::Sid, "SID"),
			(PsField::Nice, "NI"),
			(PsField::VirtualSize, "VSZ"),
			(PsField::ResidentSize, "RSS"),
			(PsField::Tty, "TTY"),
			(PsField::CpuTime, "TIME"),
			(PsField::Args, "CMD"),
		]
	} else if options.job_format {
		vec![
			(PsField::User, "USER"),
			(PsField::Pid, "PID"),
			(PsField::Ppid, "PPID"),
			(PsField::Pgid, "PGID"),
			(PsField::Sid, "SID"),
			(PsField::Tpgid, "TPGID"),
			(PsField::State, "STAT"),
			(PsField::Tty, "TTY"),
			(PsField::CpuTime, "TIME"),
			(PsField::Args, "COMMAND"),
		]
	} else if options.memory_format {
		vec![
			(PsField::Pid, "PID"),
			(PsField::MemPercent, "%MEM"),
			(PsField::VirtualSize, "VSZ"),
			(PsField::ResidentSize, "RSS"),
			(PsField::Tty, "TTY"),
			(PsField::State, "STAT"),
			(PsField::Start, "START"),
			(PsField::CpuTime, "TIME"),
			(PsField::Args, "COMMAND"),
		]
	} else if options.full_format {
		vec![
			(PsField::Uid, "UID"),
			(PsField::Pid, "PID"),
			(PsField::Ppid, "PPID"),
			(PsField::CpuInteger, "C"),
			(PsField::Start, "STIME"),
			(PsField::Tty, "TTY"),
			(PsField::CpuTime, "TIME"),
			(PsField::Args, "CMD"),
		]
	} else if options.bsd_syntax {
		vec![
			(PsField::Pid, "PID"),
			(PsField::Tty, "TTY"),
			(PsField::State, "STAT"),
			(PsField::CpuTime, "TIME"),
			(PsField::Args, "COMMAND"),
		]
	} else {
		vec![
			(PsField::Pid, "PID"),
			(PsField::Tty, "TTY"),
			(PsField::CpuTime, "TIME"),
			(PsField::Args, "CMD"),
		]
	};
	columns
		.into_iter()
		.map(|(field, header)| PsColumn::with_header(field, header))
		.collect()
}

fn sort_ps_rows(rows: &mut [PsProcessRow], sort: &[PsSort]) {
	rows.sort_by(|left, right| {
		for key in sort {
			let ordering = match key.field {
				PsSortField::Pid => left.pid.cmp(&right.pid),
				PsSortField::Ppid => left.ppid.cmp(&right.ppid),
				PsSortField::Cpu => match (left.cpu_percent(), right.cpu_percent()) {
					(Some(left), Some(right)) => left.total_cmp(&right),
					(left, right) => left.is_some().cmp(&right.is_some()),
				},
				PsSortField::Mem => left.resident_size.cmp(&right.resident_size),
				PsSortField::Time => left.cpu_time.cmp(&right.cpu_time),
				PsSortField::Start => left.start_time.cmp(&right.start_time),
				PsSortField::Command => left.command.cmp(&right.command),
			};
			let ordering = if key.descending {
				ordering.reverse()
			} else {
				ordering
			};
			if ordering != std::cmp::Ordering::Equal {
				return ordering;
			}
		}
		left.pid.cmp(&right.pid)
	});
}

fn render_ps_table(rows: &[PsProcessRow], columns: &[PsColumn], no_headers: bool) -> String {
	let has_field = |wanted| columns.iter().any(|column| column.field == wanted);
	let total_memory = has_field(PsField::MemPercent)
		.then(ps_total_memory_bytes)
		.flatten();
	let timezone = (has_field(PsField::Start) || has_field(PsField::LongStart))
		.then(|| TimeZone::try_system().unwrap_or(TimeZone::UTC));
	let terminal_names = if has_field(PsField::Tty) {
		ps_terminal_names(rows)
	} else {
		HashMap::new()
	};
	let mut user_names = HashMap::new();
	if has_field(PsField::User) || has_field(PsField::Ruser) {
		let uids = rows.iter().flat_map(|row| [row.user, row.ruid]).flatten();
		for uid in uids {
			user_names
				.entry(uid)
				.or_insert_with(|| ps_user_name(uid).unwrap_or_else(|| uid.to_string()));
		}
	}
	let mut group_names = HashMap::new();
	if has_field(PsField::Rgroup) || has_field(PsField::Egroup) {
		let gids = rows.iter().flat_map(|row| [row.rgid, row.egid]).flatten();
		for gid in gids {
			group_names
				.entry(gid)
				.or_insert_with(|| ps_group_name(gid).unwrap_or_else(|| gid.to_string()));
		}
	}
	let values: Vec<Vec<String>> = rows
		.iter()
		.map(|row| {
			columns
				.iter()
				.map(|column| {
					render_ps_value(
						row,
						column.field,
						total_memory,
						timezone.as_ref(),
						&terminal_names,
						&user_names,
						&group_names,
					)
				})
				.collect()
		})
		.collect();
	let widths: Vec<usize> = columns
		.iter()
		.enumerate()
		.map(|(index, column)| {
			values
				.iter()
				.map(|row| row[index].chars().count())
				.fold(column.header.chars().count().max(column.min_width), usize::max)
		})
		.collect();
	let mut output = String::new();
	if !no_headers && columns.iter().any(|column| !column.header.is_empty()) {
		write_ps_line(
			&mut output,
			columns.iter().map(|column| column.header.as_str()),
			columns,
			&widths,
		);
	}
	for row in &values {
		write_ps_line(&mut output, row.iter().map(String::as_str), columns, &widths);
	}
	output
}

fn write_ps_line<'a>(
	output: &mut String,
	values: impl Iterator<Item = &'a str>,
	columns: &[PsColumn],
	widths: &[usize],
) {
	for (index, value) in values.enumerate() {
		if index > 0 {
			output.push(' ');
		}
		let width = widths[index];
		if columns[index].field.right_aligned() {
			let _ = write!(output, "{value:>width$}");
		} else if index + 1 == columns.len() {
			output.push_str(value);
		} else {
			let _ = write!(output, "{value:<width$}");
		}
	}
	output.push('\n');
}

fn render_ps_value(
	row: &PsProcessRow,
	field: PsField,
	total_memory: Option<u64>,
	timezone: Option<&TimeZone>,
	terminal_names: &HashMap<u64, String>,
	user_names: &HashMap<u32, String>,
	group_names: &HashMap<u32, String>,
) -> String {
	match field {
		PsField::User => row
			.user
			.and_then(|uid| user_names.get(&uid).cloned())
			.unwrap_or_else(|| "?".to_string()),
		PsField::Uid => row
			.user
			.map_or_else(|| "?".to_string(), |value| value.to_string()),
		PsField::Pid => row.pid.to_string(),
		PsField::Ppid => row
			.ppid
			.map_or_else(|| "?".to_string(), |value| value.to_string()),
		PsField::Pgid => row
			.pgid
			.map_or_else(|| "?".to_string(), |value| value.to_string()),
		PsField::Sid => row
			.sid
			.map_or_else(|| "?".to_string(), |value| value.to_string()),
		PsField::Tpgid => row
			.tpgid
			.map_or_else(|| "-1".to_string(), |value| value.to_string()),
		PsField::Tty => row
			.terminal
			.and_then(|terminal| terminal_names.get(&terminal).cloned())
			.unwrap_or_else(|| "?".to_string()),
		PsField::State => format_ps_state(row),
		PsField::StateChar => row.state.to_string(),
		PsField::Start => timezone.map_or_else(
			|| "?".to_string(),
			|timezone| format_ps_start(row.started_at, row.age, timezone, false),
		),
		PsField::LongStart => timezone.map_or_else(
			|| "?".to_string(),
			|timezone| format_ps_start(row.started_at, row.age, timezone, true),
		),
		PsField::Elapsed => row.age.map_or_else(|| "?".to_string(), format_ps_elapsed),
		PsField::ElapsedSeconds => row
			.age
			.map_or_else(|| "?".to_string(), |age| age.as_secs().to_string()),
		PsField::CpuTime => row
			.cpu_time
			.map_or_else(|| "?".to_string(), format_ps_elapsed),
		PsField::CpuPercent => row
			.cpu_percent()
			.map_or_else(|| "?".to_string(), |percent| format!("{percent:.1}")),
		PsField::CpuInteger => row
			.cpu_percent()
			.map_or_else(|| "?".to_string(), |percent| format!("{percent:.0}")),
		PsField::MemPercent => row
			.memory_percent(total_memory)
			.map_or_else(|| "?".to_string(), |percent| format!("{percent:.1}")),
		PsField::VirtualSize => row
			.virtual_size
			.map_or_else(|| "?".to_string(), |bytes| (bytes / 1024).to_string()),
		PsField::ResidentSize => row
			.resident_size
			.map_or_else(|| "?".to_string(), |bytes| (bytes / 1024).to_string()),
		PsField::Nice => row
			.nice
			.map_or_else(|| "?".to_string(), |value| value.to_string()),
		PsField::Threads => row
			.threads
			.map_or_else(|| "?".to_string(), |value| value.to_string()),
		PsField::Priority => row
			.priority
			.map_or_else(|| "?".to_string(), |value| value.to_string()),
		PsField::Flags => row
			.flags
			.map_or_else(|| "?".to_string(), |value| format!("{value:x}")),
		PsField::Ruser => row
			.ruid
			.and_then(|uid| user_names.get(&uid).cloned())
			.unwrap_or_else(|| "?".to_string()),
		PsField::Ruid => row
			.ruid
			.map_or_else(|| "?".to_string(), |value| value.to_string()),
		PsField::Rgroup => row
			.rgid
			.and_then(|gid| group_names.get(&gid).cloned())
			.unwrap_or_else(|| "?".to_string()),
		PsField::Rgid => row
			.rgid
			.map_or_else(|| "?".to_string(), |value| value.to_string()),
		PsField::Egroup => row
			.egid
			.and_then(|gid| group_names.get(&gid).cloned())
			.unwrap_or_else(|| "?".to_string()),
		PsField::Egid => row
			.egid
			.map_or_else(|| "?".to_string(), |value| value.to_string()),
		PsField::Wchan => row.wchan.clone().unwrap_or_else(|| "-".to_string()),
		PsField::MinorFaults => row
			.minor_faults
			.map_or_else(|| "?".to_string(), |value| value.to_string()),
		PsField::MajorFaults => row
			.major_faults
			.map_or_else(|| "?".to_string(), |value| value.to_string()),
		PsField::CpuSeconds => row
			.cpu_time
			.map_or_else(|| "?".to_string(), |time| time.as_secs().to_string()),
		PsField::Size => row
			.virtual_size
			.zip(ps_page_size())
			.map_or_else(|| "?".to_string(), |(bytes, page)| bytes.div_ceil(page).to_string()),
		PsField::Command => row.command.clone(),
		PsField::Args => row.args.clone(),
	}
}

fn format_ps_state(row: &PsProcessRow) -> String {
	let mut state = row.state.to_string();
	match row.nice {
		Some(value) if value < 0 => state.push('<'),
		Some(value) if value > 0 => state.push('N'),
		_ => {},
	}
	if row.sid == Some(row.pid) {
		state.push('s');
	}
	if row.threads.is_some_and(|threads| threads > 1) {
		state.push('l');
	}
	if row.terminal.is_some() && row.tpgid.is_some() && row.tpgid == row.pgid {
		state.push('+');
	}
	state
}

fn format_ps_start(
	started_at: Option<SystemTime>,
	age: Option<Duration>,
	timezone: &TimeZone,
	long: bool,
) -> String {
	const DAY_SECONDS: u64 = 24 * 60 * 60;
	const SIX_MONTH_SECONDS: u64 = 180 * DAY_SECONDS;
	let Some(started_at) = started_at else {
		return "?".to_string();
	};
	let Ok(since_epoch) = started_at.duration_since(UNIX_EPOCH) else {
		return "?".to_string();
	};
	let Ok(nanoseconds) = i128::try_from(since_epoch.as_nanos()) else {
		return "?".to_string();
	};
	let Ok(timestamp) = Timestamp::from_nanosecond(nanoseconds) else {
		return "?".to_string();
	};
	let format = if long {
		"%a %b %e %H:%M:%S %Y"
	} else if age.is_some_and(|age| age.as_secs() < DAY_SECONDS) {
		"%H:%M"
	} else if age.is_some_and(|age| age.as_secs() < SIX_MONTH_SECONDS) {
		"%b%d"
	} else {
		"%Y"
	};
	strtime::format(format, &timestamp.to_zoned(timezone.clone()))
		.unwrap_or_else(|_| "?".to_string())
}

fn format_ps_elapsed(duration: Duration) -> String {
	let total_seconds = duration.as_secs();
	let days = total_seconds / 86_400;
	let hours = total_seconds % 86_400 / 3_600;
	let minutes = total_seconds % 3_600 / 60;
	let seconds = total_seconds % 60;
	if days > 0 {
		format!("{days}-{hours:02}:{minutes:02}:{seconds:02}")
	} else if hours > 0 {
		format!("{hours:02}:{minutes:02}:{seconds:02}")
	} else {
		format!("{minutes:02}:{seconds:02}")
	}
}

#[cfg(target_os = "linux")]
fn ps_total_memory_bytes() -> Option<u64> {
	let value = fs::read_to_string("/proc/meminfo")
		.ok()?
		.lines()
		.find_map(|line| line.strip_prefix("MemTotal:"))?
		.split_ascii_whitespace()
		.next()?
		.parse::<u64>()
		.ok()?;
	value.checked_mul(1024)
}

#[cfg(target_os = "macos")]
fn ps_total_memory_bytes() -> Option<u64> {
	let mut value = 0_u64;
	let mut size = std::mem::size_of::<u64>();
	// SAFETY: the output pointer names a writable u64 and `size` reports its
	// exact capacity; hw.memsize has no input buffer.
	let status = unsafe {
		libc::sysctlbyname(
			c"hw.memsize".as_ptr(),
			(&raw mut value).cast(),
			&raw mut size,
			std::ptr::null_mut(),
			0,
		)
	};
	(status == 0 && size == std::mem::size_of::<u64>()).then_some(value)
}

#[cfg(target_os = "windows")]
fn ps_total_memory_bytes() -> Option<u64> {
	None
}

#[cfg(unix)]
fn ps_user_name(uid: u32) -> Option<String> {
	use std::ffi::CStr;
	let mut record = std::mem::MaybeUninit::<libc::passwd>::zeroed();
	let mut result = std::ptr::null_mut();
	let mut buffer = vec![0_u8; 16 * 1024];
	// SAFETY: all pointers refer to live storage for this call; a non-null
	// result guarantees `record` and its pw_name pointer were initialized.
	let status = unsafe {
		libc::getpwuid_r(
			uid,
			record.as_mut_ptr(),
			buffer.as_mut_ptr().cast(),
			buffer.len(),
			&raw mut result,
		)
	};
	if status != 0 || result.is_null() {
		return None;
	}
	// SAFETY: getpwuid_r succeeded and the backing buffer remains alive.
	let name = unsafe { CStr::from_ptr(record.assume_init().pw_name) };
	Some(name.to_string_lossy().into_owned())
}

#[cfg(not(unix))]
fn ps_user_name(_uid: u32) -> Option<String> {
	None
}

#[cfg(unix)]
fn ps_group_name(gid: u32) -> Option<String> {
	use std::ffi::CStr;
	let mut record = std::mem::MaybeUninit::<libc::group>::zeroed();
	let mut result = std::ptr::null_mut();
	let mut buffer = vec![0_u8; 16 * 1024];
	// SAFETY: all pointers refer to live storage for this call; a non-null
	// result guarantees `record` and its gr_name pointer were initialized.
	let status = unsafe {
		libc::getgrgid_r(
			gid,
			record.as_mut_ptr(),
			buffer.as_mut_ptr().cast(),
			buffer.len(),
			&raw mut result,
		)
	};
	if status != 0 || result.is_null() {
		return None;
	}
	// SAFETY: getgrgid_r succeeded and the backing buffer remains alive.
	let name = unsafe { CStr::from_ptr(record.assume_init().gr_name) };
	Some(name.to_string_lossy().into_owned())
}

#[cfg(not(unix))]
fn ps_group_name(_gid: u32) -> Option<String> {
	None
}

/// System memory page size in bytes, used for the SZ (pages) column.
#[cfg(unix)]
fn ps_page_size() -> Option<u64> {
	// SAFETY: sysconf reads a process-global constant.
	u64::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) })
		.ok()
		.filter(|value| *value > 0)
}

#[cfg(not(unix))]
fn ps_page_size() -> Option<u64> {
	None
}

#[cfg(unix)]
fn ps_terminal_names(rows: &[PsProcessRow]) -> HashMap<u64, String> {
	use std::os::unix::fs::MetadataExt;
	let wanted: HashSet<u64> = rows.iter().filter_map(|row| row.terminal).collect();
	let mut names = HashMap::new();
	for directory in [Path::new("/dev"), Path::new("/dev/pts")] {
		let Ok(entries) = fs::read_dir(directory) else {
			continue;
		};
		for entry in entries.flatten() {
			let path = entry.path();
			let Ok(metadata) = fs::metadata(&path) else {
				continue;
			};
			let id = metadata.rdev();
			if !wanted.contains(&id) || names.contains_key(&id) {
				continue;
			}
			let name = path
				.strip_prefix("/dev")
				.ok()
				.map(|path| path.to_string_lossy().trim_start_matches('/').to_string());
			if let Some(name) = name.filter(|name| !name.is_empty()) {
				names.insert(id, name);
			}
		}
	}
	names
}

#[cfg(not(unix))]
fn ps_terminal_names(_rows: &[PsProcessRow]) -> HashMap<u64, String> {
	HashMap::new()
}

fn write_ps_help(mut output: impl Write) -> io::Result<()> {
	writeln!(
		output,
		"Usage: ps [options]\n\nSelection:\n-A, -e, --all       select every process\n-p, --pid \
		 LIST      select process IDs\n-P, --ppid LIST     select parent process IDs\n-u, --user \
		 LIST     select effective users\n-U, --User LIST     select real users\n-t, --tty LIST      \
		 select terminals\n\nOutput:\n-f                  full format\n-l                  long \
		 format\n-o, --format LIST   custom columns\n--sort LIST     sort by columns; prefix \
		 descending keys with '-'\n--no-headers    omit column headings\n\nBSD forms such as 'ps \
		 ax', 'ps aux', and 'ps axo pid,command' are supported."
	)
}

#[derive(Clone, Copy, Debug, clap::ValueEnum)]
enum TopSortKey {
	Pid,
	Command,
	#[value(alias = "%cpu")]
	Cpu,
	#[value(alias = "%mem", alias = "memory")]
	Mem,
	#[value(alias = "time+")]
	Time,
}

#[derive(Parser)]
#[command(name = "top", version, about = "Display processes", disable_help_flag = false)]
struct TopCommand {
	/// Write plain-text snapshots suitable for pipes and files.
	#[arg(short = 'b', long)]
	batch: bool,

	/// Number of snapshots to produce.
	#[cfg(target_os = "macos")]
	#[arg(short = 'l', long = "samples", value_parser = clap::value_parser!(u64).range(1..))]
	iterations: Option<u64>,

	/// Number of snapshots to produce.
	#[cfg(not(target_os = "macos"))]
	#[arg(short = 'n', long = "iterations", value_parser = clap::value_parser!(u64).range(1..))]
	iterations: Option<u64>,

	/// Seconds between snapshots.
	#[cfg(target_os = "macos")]
	#[arg(short = 's', long = "delay", default_value_t = 1.0)]
	delay: f64,

	/// Seconds between snapshots.
	#[cfg(not(target_os = "macos"))]
	#[arg(short = 'd', long = "delay", default_value_t = 3.0)]
	delay: f64,

	/// Maximum number of process rows per snapshot.
	#[cfg(target_os = "macos")]
	#[arg(short = 'n', long = "rows")]
	rows: Option<usize>,

	/// Maximum number of process rows per snapshot.
	#[cfg(not(target_os = "macos"))]
	#[arg(short = 'r', long = "rows")]
	rows: Option<usize>,

	/// Only show these process IDs (may be repeated or comma-separated).
	#[arg(short = 'p', long = "pid", value_delimiter = ',')]
	pids: Vec<i32>,

	/// Only show processes with this numeric real or effective user ID.
	#[arg(short = 'u', long = "user")]
	user: Option<u32>,

	#[arg(short = 'o', long = "sort", value_enum, ignore_case = true)]
	#[cfg_attr(target_os = "macos", arg(default_value_t = TopSortKey::Pid))]
	#[cfg_attr(not(target_os = "macos"), arg(default_value_t = TopSortKey::Cpu))]
	sort: TopSortKey,

	/// Show the complete command line instead of the executable name.
	#[arg(short = 'c', long = "full-command")]
	full_command: bool,
}

#[derive(Clone)]
struct TopProcessRow {
	pid:           i32,
	user:          Option<u32>,
	state:         char,
	cpu_percent:   f64,
	cpu_time:      Option<Duration>,
	virtual_size:  Option<u64>,
	resident_size: Option<u64>,
	threads:       Option<u32>,
	nice:          Option<i32>,
	command:       String,
}

impl builtins::Command for TopCommand {
	type Error = brush_core::Error;

	fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> impl Future<Output = std::result::Result<ExecutionResult, brush_core::Error>> + Send {
		let iterations = self.iterations;
		let delay = self.delay;
		let row_limit = self.rows;
		let pids = self.pids.clone();
		let user = self.user;
		let sort = self.sort;
		let full_command = self.full_command;
		let _ = self.batch;
		async move {
			if !delay.is_finite() || delay < 0.0 || delay > Duration::MAX.as_secs_f64() {
				writeln!(context.stderr(), "top: invalid delay '{delay}'")?;
				return Ok(ExecutionResult::new(1));
			}
			if row_limit == Some(0) {
				writeln!(context.stderr(), "top: row count must be greater than zero")?;
				return Ok(ExecutionResult::new(1));
			}
			#[cfg(target_os = "windows")]
			if user.is_some() {
				writeln!(context.stderr(), "top: user filtering is unavailable on Windows")?;
				return Ok(ExecutionResult::new(2));
			}

			let delay = Duration::from_secs_f64(delay);
			let pid_filter: std::collections::HashSet<i32> = pids.into_iter().collect();
			let mut previous = HashMap::<i32, (u64, Duration)>::new();
			let mut previous_sample = std::time::Instant::now();
			let mut sample = 0_u64;

			loop {
				if context.is_cancelled() {
					return Ok(ExecutionExitCode::Interrupted.into());
				}

				let now = std::time::Instant::now();
				let elapsed = now.duration_since(previous_sample);
				let mut next_previous = HashMap::new();
				let mut rows = Vec::new();

				for process in proc_snapshot::ProcInfo::all() {
					if !pid_filter.is_empty() && !pid_filter.contains(&process.pid()) {
						continue;
					}
					let real_user = process.real_user_id();
					let effective_user = process.effective_user_id();
					if let Some(wanted) = user
						&& real_user != Some(wanted)
						&& effective_user != Some(wanted)
					{
						continue;
					}

					let start_time = process.start_time();
					let cpu_time = process.cpu_time();
					let cpu_percent = cpu_time
						.and_then(|current| {
							previous
								.get(&process.pid())
								.filter(|(previous_start, _)| *previous_start == start_time)
								.map(|(_, old)| current.saturating_sub(*old))
						})
						.map_or(0.0, |delta| {
							if elapsed.is_zero() {
								0.0
							} else {
								100.0 * delta.as_secs_f64() / elapsed.as_secs_f64()
							}
						});
					if let Some(cpu_time) = cpu_time {
						next_previous.insert(process.pid(), (start_time, cpu_time));
					}

					let command = sanitize_process_command(if full_command {
						let args = process.args();
						if args.is_empty() {
							process.command_name()
						} else {
							args.join(" ")
						}
					} else {
						process.command_name()
					});
					rows.push(TopProcessRow {
						pid: process.pid(),
						user: effective_user.or(real_user),
						state: process.state(),
						cpu_percent,
						cpu_time,
						virtual_size: process.virtual_bytes(),
						resident_size: process.resident_bytes(),
						threads: process.thread_count(),
						nice: process.nice(),
						command,
					});
				}

				sort_top_rows(&mut rows, sort);
				let output = render_top_snapshot(&rows, row_limit, sample + 1);
				if let Err(err) = write!(context.stdout(), "{output}") {
					if err.kind() == io::ErrorKind::BrokenPipe {
						return Ok(ExecutionResult::success());
					}
					return Err(err.into());
				}

				sample += 1;
				if iterations.is_some_and(|count| sample >= count) {
					return Ok(ExecutionResult::success());
				}
				previous = next_previous;
				previous_sample = now;

				let sleep = time::sleep(delay);
				tokio::pin!(sleep);
				if let Some(cancel_token) = context.cancel_token() {
					tokio::select! {
						() = &mut sleep => {},
						() = cancel_token.cancelled() => {
							return Ok(ExecutionExitCode::Interrupted.into());
						},
					}
				} else {
					sleep.await;
				}
			}
		}
	}
}

fn sort_top_rows(rows: &mut [TopProcessRow], key: TopSortKey) {
	rows.sort_by(|left, right| {
		let primary = match key {
			TopSortKey::Pid => right.pid.cmp(&left.pid),
			TopSortKey::Command => left.command.cmp(&right.command),
			TopSortKey::Cpu => right.cpu_percent.total_cmp(&left.cpu_percent),
			TopSortKey::Mem => right.resident_size.cmp(&left.resident_size),
			TopSortKey::Time => right.cpu_time.cmp(&left.cpu_time),
		};
		primary.then_with(|| right.pid.cmp(&left.pid))
	});
}

fn render_top_snapshot(rows: &[TopProcessRow], row_limit: Option<usize>, sample: u64) -> String {
	let mut running = 0_usize;
	let mut sleeping = 0_usize;
	let mut stopped = 0_usize;
	let mut zombie = 0_usize;
	let mut resident = 0_u64;
	let mut virtual_size = 0_u64;
	let mut cpu = 0.0;
	for row in rows {
		match row.state {
			'R' => running += 1,
			'S' | 'I' | 'D' => sleeping += 1,
			'T' => stopped += 1,
			'Z' => zombie += 1,
			_ => {},
		}
		resident = resident.saturating_add(row.resident_size.unwrap_or(0));
		virtual_size = virtual_size.saturating_add(row.virtual_size.unwrap_or(0));
		cpu += row.cpu_percent;
	}

	let mut output = String::new();
	let _ = writeln!(output, "top - snapshot {sample}");
	#[cfg(target_os = "macos")]
	let _ = writeln!(
		output,
		"Processes: {:>5} total, {:>5} running, {:>5} sleeping, {:>5} stopped, {:>5} zombie",
		rows.len(),
		running,
		sleeping,
		stopped,
		zombie
	);
	#[cfg(not(target_os = "macos"))]
	let _ = writeln!(
		output,
		"Tasks: {:>5} total, {:>5} running, {:>5} sleeping, {:>5} stopped, {:>5} zombie",
		rows.len(),
		running,
		sleeping,
		stopped,
		zombie
	);
	let _ = writeln!(output, "%Cpu(s): {cpu:>6.1} process");
	let _ = writeln!(
		output,
		"Process memory: {} resident, {} virtual",
		format_top_bytes(resident),
		format_top_bytes(virtual_size)
	);
	let _ = writeln!(
		output,
		"{:>7} {:>8} {:>2} {:>3} {:>4} {:>9} {:>9} {:>10} {:>4} {:>4} COMMAND",
		"PID", "USER", "S", "NI", "TH", "VIRT", "RES", "TIME+", "%CPU", "%MEM"
	);

	for row in rows.iter().take(row_limit.unwrap_or(usize::MAX)) {
		let user = row
			.user
			.map_or_else(|| "?".to_string(), |value| value.to_string());
		let nice = row
			.nice
			.map_or_else(|| "?".to_string(), |value| value.to_string());
		let threads = row
			.threads
			.map_or_else(|| "?".to_string(), |value| value.to_string());
		let virtual_size = row
			.virtual_size
			.map_or_else(|| "?".to_string(), format_top_bytes);
		let resident_size = row
			.resident_size
			.map_or_else(|| "?".to_string(), format_top_bytes);
		let cpu_time = row
			.cpu_time
			.map_or_else(|| "?".to_string(), format_top_time);
		let _ = writeln!(
			output,
			"{:>7} {:>8} {:>2} {:>3} {:>4} {:>9} {:>9} {:>10} {:>4.1} {:>4} {}",
			row.pid,
			user,
			row.state,
			nice,
			threads,
			virtual_size,
			resident_size,
			cpu_time,
			row.cpu_percent,
			"?",
			if row.command.is_empty() {
				"?"
			} else {
				&row.command
			}
		);
	}
	output.push('\n');
	output
}

fn sanitize_process_command(command: String) -> String {
	command
		.chars()
		.map(|character| {
			if character.is_control() {
				' '
			} else {
				character
			}
		})
		.collect()
}

fn format_top_bytes(bytes: u64) -> String {
	const KIB: f64 = 1024.0;
	const MIB: f64 = KIB * 1024.0;
	const GIB: f64 = MIB * 1024.0;
	let bytes = bytes as f64;
	if bytes >= GIB {
		format!("{:.1}g", bytes / GIB)
	} else if bytes >= MIB {
		format!("{:.1}m", bytes / MIB)
	} else if bytes >= KIB {
		format!("{:.1}k", bytes / KIB)
	} else {
		format!("{bytes:.0}")
	}
}

fn format_top_time(duration: Duration) -> String {
	let total_seconds = duration.as_secs();
	let minutes = total_seconds / 60;
	let seconds = total_seconds % 60;
	let hundredths = duration.subsec_millis() / 10;
	format!("{minutes}:{seconds:02}.{hundredths:02}")
}

#[derive(Parser)]
#[command(disable_help_flag = true)]
struct NohupCommand {
	#[arg(num_args = 0.., trailing_var_arg = true, allow_hyphen_values = true)]
	command: Vec<String>,
}

impl builtins::Command for NohupCommand {
	type Error = brush_core::Error;

	fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> impl Future<Output = std::result::Result<ExecutionResult, brush_core::Error>> + Send {
		let command = self.command.clone();
		async move {
			if context.is_cancelled() {
				return Ok(ExecutionExitCode::Interrupted.into());
			}
			// coreutils `nohup` with no operand fails with exit code 125.
			if command.is_empty() {
				let _ = writeln!(context.stderr(), "nohup: missing operand");
				return Ok(ExecutionResult::new(125));
			}

			// `nohup <cmd>` (foreground) runs the operand directly and surfaces its
			// exit status — the contract pinned by
			// `nohup_builtin_propagates_command_exit_code`. Persistence across the
			// host's teardown is a *background* concern that never reaches this
			// builtin: the agent writes `nohup <server> &`, and brush's
			// `transparent_background_wrapper` unwraps that to spawn the operand
			// directly with `detach_reparent`, double-forking it out of the shell's
			// descendant tree (see `execute_external_command` / `detach_session_reparent`).
			// Like coreutils, we run the operand here; we only differ by not masking
			// SIGHUP (see `nohup_builtin_does_not_mask_sighup`).
			let mut command_line = String::new();
			for (idx, arg) in command.iter().enumerate() {
				if idx > 0 {
					command_line.push(' ');
				}
				command_line.push_str(&quote_arg(arg));
			}

			let mut params = context.params.clone();
			params.process_group_policy = ProcessGroupPolicy::NewProcessGroup;
			let source_info = SourceInfo::from("pi-natives:nohup");
			context
				.shell
				.run_string(command_line, &source_info, &params)
				.await
		}
	}
}
fn parse_duration(input: &str) -> Option<Duration> {
	let trimmed = input.trim();
	if trimmed.is_empty() {
		return None;
	}
	let (number, multiplier) = match trimmed.chars().last()? {
		's' => (&trimmed[..trimmed.len() - 1], 1.0),
		'm' => (&trimmed[..trimmed.len() - 1], 60.0),
		'h' => (&trimmed[..trimmed.len() - 1], 3600.0),
		'd' => (&trimmed[..trimmed.len() - 1], 86400.0),
		ch if ch.is_ascii_alphabetic() => return None,
		_ => (trimmed, 1.0),
	};
	let value = number.parse::<f64>().ok()?;
	if value.is_sign_negative() {
		return None;
	}
	let millis = value * multiplier * 1000.0;
	if !millis.is_finite() || millis < 0.0 {
		return None;
	}
	Some(Duration::from_millis(millis.round() as u64))
}

fn quote_arg(arg: &str) -> String {
	if arg.is_empty() {
		return "''".to_string();
	}
	let safe = arg
		.chars()
		.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '/' | ':' | '+'));
	if safe {
		return arg.to_string();
	}
	let escaped = arg.replace('\'', "'\"'\"'");
	format!("'{escaped}'")
}

/// Reads a boolean "disable" flag for the uutils builtins from the session
/// environment (preferred) then the process environment, mirroring the nohup
/// builtin gate. Truthy = present and not "", "0", or "false".
fn uutils_env_disabled(config: &ShellConfig, key: &str) -> bool {
	let raw = config
		.session_env
		.as_ref()
		.and_then(|env| env.get(key).cloned())
		.or_else(|| std::env::var(key).ok());
	matches!(raw.as_deref(), Some(value) if !value.is_empty() && value != "0" && !value.eq_ignore_ascii_case("false"))
}

#[cfg(test)]
mod tests {
	#[cfg(unix)]
	use std::os::unix::process::ExitStatusExt as _;

	#[cfg(unix)]
	use tokio::process::Command;

	use super::*;

	#[cfg(unix)]
	async fn kill_test_context() -> (ShellSessionCore, ExecutionParameters) {
		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let session = create_session(&config).await.expect("create_session");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null stdin"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null stdout"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null stderr"));
		(session, params)
	}

	async fn execute_captured(command: String) -> (ShellExecuteResult, String) {
		let (tx, rx) = flume::unbounded();
		let result = execute_shell(
			ShellExecuteOptions { command, ..Default::default() },
			Some(tx),
			CancelToken::default(),
		)
		.await
		.expect("shell execution");
		let output = rx.try_iter().collect();
		(result, output)
	}

	#[cfg(unix)]
	async fn wait_for_process_name(pid: i32, expected: &str) {
		time::timeout(Duration::from_secs(2), async {
			loop {
				if proc_snapshot::ProcInfo::all().into_iter().any(|process| {
					process.pid() == pid
						&& process.match_name() == expected
						&& process.status() == process::ProcessStatus::Running
				}) {
					return;
				}
				time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await
		.expect("child did not enter expected executable");
	}

	#[cfg(unix)]
	fn process_test_command(prefix: &str) -> (tempfile::TempDir, std::path::PathBuf, String) {
		let dir = tempfile::tempdir().expect("process test directory");
		let name = format!("{prefix}{}", std::process::id());
		let command = dir.path().join(&name);
		std::os::unix::fs::symlink("/bin/sleep", &command).expect("sleep symlink");
		(dir, command, name)
	}

	#[cfg(unix)]
	struct PidfileProcessCleanup(Vec<std::path::PathBuf>);

	#[cfg(unix)]
	impl Drop for PidfileProcessCleanup {
		fn drop(&mut self) {
			for pidfile in &self.0 {
				if let Some(process) = fs::read_to_string(pidfile)
					.ok()
					.and_then(|pid| pid.trim().parse::<i32>().ok())
					.and_then(process::Process::from_pid)
				{
					let _ = process.kill_tree(Some(libc::SIGKILL));
				}
			}
		}
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn pgrep_matches_name_and_pkills_signal_probe() {
		let (_dir, command, name) = process_test_command("opg");
		let mut child = Command::new(command)
			.arg("30")
			.spawn()
			.expect("matching process");
		let pid = i32::try_from(child.id().expect("child pid")).expect("pid fits i32");
		wait_for_process_name(pid, &name).await;

		let (pgrep_result, output) = execute_captured(format!("pgrep -x -p {pid} {name}")).await;
		let (pkill_result, pkill_output) =
			execute_captured(format!("pkill -0 -x -p {pid} {name}")).await;

		let still_running = child.try_wait().expect("probe child status").is_none();
		let _ = child.start_kill();
		let _ = child.wait().await;
		assert_eq!(pgrep_result.exit_code, Some(0));
		assert_eq!(output, format!("{pid}\n"));
		assert_eq!(pkill_result.exit_code, Some(0));
		assert!(pkill_output.is_empty());
		assert!(still_running, "signal 0 must not terminate a matching process");
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn pkill_accepts_platform_signal_names() {
		#[cfg(target_os = "macos")]
		let signal = "INFO";
		#[cfg(not(target_os = "macos"))]
		let signal = "WINCH";
		let dir = tempfile::tempdir().expect("signal test directory");
		let ready = dir.path().join("ready");
		let script = format!("trap '' {signal}; : > \"$1\"; while :; do sleep 0.05; done");
		let mut command = Command::new("sh");
		command
			.args(["-c", &script, "sh", ready.to_str().expect("utf8 ready path")])
			.kill_on_drop(true);
		let mut child = command.spawn().expect("signal test process");
		let pid = i32::try_from(child.id().expect("child pid")).expect("pid fits i32");
		time::timeout(Duration::from_secs(2), async {
			while !ready.exists() {
				time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await
		.expect("signal trap was not installed");

		let (result, _) = execute_captured(format!("pkill -{signal} -p {pid}")).await;
		let still_running = child.try_wait().expect("signal child status").is_none();
		let _ = child.start_kill();
		let _ = child.wait().await;
		assert_eq!(result.exit_code, Some(0));
		assert!(still_running, "{signal} should be ignored by the test process");
	}

	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn pkill_queue_option_consumes_its_value() {
		let (_dir, command, name) = process_test_command("opq");
		let mut command = Command::new(command);
		command.arg("30").kill_on_drop(true);
		let mut child = command.spawn().expect("queue test process");
		let pid = i32::try_from(child.id().expect("child pid")).expect("pid fits i32");
		wait_for_process_name(pid, &name).await;

		let (result, output) = execute_captured(format!("pkill -0 -q 37 -x -p {pid} {name}")).await;
		let still_running = child.try_wait().expect("queue child status").is_none();
		let _ = child.start_kill();
		let _ = child.wait().await;
		assert_eq!(result.exit_code, Some(0));
		assert!(output.is_empty());
		assert!(still_running, "queued signal 0 must only probe the process");
	}

	#[cfg(target_os = "macos")]
	#[tokio::test(flavor = "multi_thread")]
	async fn pkill_interactive_prompt_honors_cancellation() {
		let (_dir, command, name) = process_test_command("opi");
		let mut command = Command::new(command);
		command.arg("30").kill_on_drop(true);
		let mut child = command.spawn().expect("interactive target");
		let pid = i32::try_from(child.id().expect("child pid")).expect("pid fits i32");
		wait_for_process_name(pid, &name).await;

		let mut cancel = CancelToken::default();
		let abort = cancel.emplace_abort_token();
		let execution = tokio::spawn(execute_shell(
			ShellExecuteOptions {
				command: format!("sleep 30 | pkill -I -x -p {pid} {name}"),
				..Default::default()
			},
			None,
			cancel,
		));
		time::sleep(Duration::from_millis(100)).await;
		abort.abort(crate::cancel::AbortReason::User);
		let result = time::timeout(Duration::from_secs(2), execution)
			.await
			.expect("interactive pkill remained blocked after cancellation")
			.expect("interactive execution task")
			.expect("interactive shell execution");
		let still_running = child
			.try_wait()
			.expect("interactive target status")
			.is_none();
		let _ = child.start_kill();
		let _ = child.wait().await;
		assert_ne!(result.exit_code, Some(0));
		assert!(still_running, "cancelled pkill must not signal its pending target");
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn pgrep_reads_pidfile_from_standard_input() {
		let (_dir, command, name) = process_test_command("opf");
		let mut child = Command::new(command)
			.arg("30")
			.spawn()
			.expect("pidfile process");
		let pid = i32::try_from(child.id().expect("child pid")).expect("pid fits i32");
		wait_for_process_name(pid, &name).await;

		let (result, output) =
			execute_captured(format!("printf '%s\\n' {pid} | pgrep -F - -x {name}")).await;
		let _ = child.start_kill();
		let _ = child.wait().await;
		assert_eq!(result.exit_code, Some(0));
		assert_eq!(output, format!("{pid}\n"));
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn pgrep_requires_an_externally_locked_pidfile() {
		let python = Command::new("python3").arg("--version").output().await;
		if !python.is_ok_and(|output| output.status.success()) {
			eprintln!("skipping pgrep_requires_an_externally_locked_pidfile: python3 unavailable");
			return;
		}

		let (_dir, command, name) = process_test_command("opl");
		let mut child = Command::new(command)
			.arg("30")
			.spawn()
			.expect("locked pidfile process");
		let pid = i32::try_from(child.id().expect("child pid")).expect("pid fits i32");
		wait_for_process_name(pid, &name).await;

		let files = tempfile::tempdir().expect("pidfile directory");
		let pidfile = files.path().join("service.pid");
		let ready = files.path().join("locked");
		let pid_arg = pid.to_string();
		let mut locker = Command::new("python3")
			.args([
				"-c",
				"import fcntl,pathlib,sys,time; f=open(sys.argv[1],'w'); f.write(sys.argv[2]+'\\n'); \
				 f.flush(); fcntl.lockf(f,fcntl.LOCK_EX); pathlib.Path(sys.argv[3]).touch(); \
				 time.sleep(30)",
				pidfile.to_str().expect("utf8 pidfile"),
				&pid_arg,
				ready.to_str().expect("utf8 ready path"),
			])
			.spawn()
			.expect("pidfile locker");
		let ready_result = time::timeout(Duration::from_secs(2), async {
			while !ready.exists() {
				time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await;
		if ready_result.is_err() {
			let _ = locker.start_kill();
			let _ = child.start_kill();
			let _ = locker.wait().await;
			let _ = child.wait().await;
			panic!("pidfile locker did not become ready");
		}

		let command =
			format!("pgrep -L -F {} -x {name}", quote_arg(pidfile.to_str().expect("utf8 pidfile")));
		let (locked_result, locked_output) = execute_captured(command.clone()).await;
		let _ = locker.start_kill();
		let _ = locker.wait().await;
		let (unlocked_result, unlocked_output) = execute_captured(command).await;
		let _ = child.start_kill();
		let _ = child.wait().await;

		assert_eq!(locked_result.exit_code, Some(0));
		assert_eq!(locked_output, format!("{pid}\n"));
		assert_eq!(unlocked_result.exit_code, Some(3));
		assert!(unlocked_output.contains("is not locked"), "{unlocked_output:?}");
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn pkill_signals_every_matching_process() {
		let (_dir, command, name) = process_test_command("opk");
		let mut first = Command::new(&command)
			.arg("30")
			.spawn()
			.expect("first matching process");
		let mut second = Command::new(command)
			.arg("30")
			.spawn()
			.expect("second matching process");
		let first_pid = i32::try_from(first.id().expect("first pid")).expect("pid fits i32");
		let second_pid = i32::try_from(second.id().expect("second pid")).expect("pid fits i32");
		wait_for_process_name(first_pid, &name).await;
		wait_for_process_name(second_pid, &name).await;

		let (result, output) = execute_captured(format!("pkill -TERM -x {name}")).await;
		let statuses =
			time::timeout(Duration::from_secs(2), async { tokio::join!(first.wait(), second.wait()) })
				.await;
		if statuses.is_err() {
			let _ = first.start_kill();
			let _ = second.start_kill();
			let _ = first.wait().await;
			let _ = second.wait().await;
		}
		assert_eq!(result.exit_code, Some(0));
		assert!(output.is_empty());
		assert!(statuses.is_ok(), "pkill did not signal every matching process");
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn pidwait_returns_after_the_matching_process_exits() {
		let (_dir, command, name) = process_test_command("opw");
		let mut child = Command::new(command)
			.arg("0.25")
			.spawn()
			.expect("waited process");
		let pid = i32::try_from(child.id().expect("child pid")).expect("pid fits i32");
		wait_for_process_name(pid, &name).await;

		let (result, output) = execute_captured(format!("pidwait -x -p {pid} {name}")).await;
		let status = child.try_wait().expect("waited child status");
		if status.is_none() {
			let _ = child.start_kill();
			let _ = child.wait().await;
		}
		assert_eq!(result.exit_code, Some(0));
		assert!(output.is_empty());
		assert!(status.is_some(), "pidwait returned while its matching process was still running");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn ps_builtin_supports_common_bsd_and_posix_forms() {
		let pid = std::process::id();
		let (custom_result, custom) =
			execute_captured(format!("ps -p {pid} -o pid=,ppid=,stat=,comm=")).await;
		let (posix_result, posix) = execute_captured(format!("ps -ef -p {pid}")).await;
		let (bsd_result, bsd) = execute_captured(format!("ps aux -p {pid}")).await;

		assert_eq!(custom_result.exit_code, Some(0));
		assert_eq!(custom.lines().count(), 1);
		let mut fields = custom.split_whitespace();
		assert_eq!(fields.next(), Some(pid.to_string().as_str()));
		assert!(
			fields
				.next()
				.and_then(|value| value.parse::<i32>().ok())
				.is_some()
		);
		assert!(fields.next().is_some_and(|value| !value.is_empty()));
		assert!(fields.next().is_some_and(|value| !value.is_empty()));

		assert_eq!(posix_result.exit_code, Some(0));
		assert!(
			posix
				.lines()
				.next()
				.is_some_and(|line| line.contains("PPID"))
		);
		assert!(posix.lines().skip(1).any(|line| {
			line
				.split_whitespace()
				.any(|value| value == pid.to_string())
		}));

		assert_eq!(bsd_result.exit_code, Some(0));
		assert!(bsd.lines().next().is_some_and(|line| line.contains("%CPU")));
		assert!(bsd.lines().skip(1).any(|line| {
			line
				.split_whitespace()
				.any(|value| value == pid.to_string())
		}));
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn ps_builtin_formats_parseable_long_start_without_a_header() {
		let pid = std::process::id();
		let (result, output) = execute_captured(format!("ps -p {pid} -o lstart=")).await;
		assert_eq!(result.exit_code, Some(0));
		assert!(strtime::parse("%a %b %e %H:%M:%S %Y", output.trim()).is_ok(), "{output:?}");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn ps_builtin_supports_extended_format_specifiers() {
		let pid = std::process::id();
		let (result, output) = execute_captured(format!(
			"ps -p {pid} -o \
			 pid=,tpgid=,ruid=,rgid=,egid=,pri=,f=,min_flt=,maj_flt=,times=,sz=,s=,ruser=,rgroup=,\
			 tgid="
		))
		.await;
		assert_eq!(result.exit_code, Some(0), "{output:?}");
		let fields: Vec<&str> = output.split_whitespace().collect();
		assert_eq!(fields.len(), 15, "{output:?}");
		assert_eq!(fields[0], pid.to_string());
		assert_eq!(fields[14], pid.to_string(), "tgid aliases pid");
		#[cfg(unix)]
		{
			// tpgid is an integer; -1 without a controlling terminal.
			assert!(fields[1].parse::<i32>().is_ok(), "tpgid: {:?}", fields[1]);
			for (index, name) in [(2, "ruid"), (3, "rgid"), (4, "egid")] {
				assert!(fields[index].parse::<u32>().is_ok(), "{name}: {:?}", fields[index]);
			}
			assert!(fields[5].parse::<i64>().is_ok(), "pri: {:?}", fields[5]);
			assert!(u64::from_str_radix(fields[6], 16).is_ok(), "flags: {:?}", fields[6]);
			assert!(fields[7].parse::<u64>().is_ok(), "min_flt: {:?}", fields[7]);
			assert!(fields[8].parse::<u64>().is_ok(), "maj_flt: {:?}", fields[8]);
			assert!(fields[9].parse::<u64>().is_ok(), "times: {:?}", fields[9]);
			assert!(fields[10].parse::<u64>().is_ok(), "sz: {:?}", fields[10]);
			assert_eq!(fields[11].chars().count(), 1, "state: {:?}", fields[11]);
			assert_ne!(fields[12], "?", "ruser should resolve to a name");
			assert_ne!(fields[13], "?", "rgroup should resolve to a name");
		}
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn ps_builtin_accepts_tpgid_alongside_job_control_columns() {
		// Exact form from the field report that failed with
		// "unknown output format specifier 'tpgid'".
		let pid = std::process::id();
		let (result, output) =
			execute_captured(format!("ps -o pid,ppid,pgid,tpgid,sess,stat,tty,command -p {pid}"))
				.await;
		assert_eq!(result.exit_code, Some(0), "{output:?}");
		let header = output.lines().next().unwrap_or_default();
		for label in ["PID", "PPID", "PGID", "TPGID", "SID", "STAT", "TTY", "COMMAND"] {
			assert!(header.contains(label), "missing {label} in {header:?}");
		}
		assert!(output.lines().skip(1).any(|line| {
			line
				.split_whitespace()
				.next()
				.is_some_and(|value| value == pid.to_string())
		}));
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn top_builtin_emits_one_finite_snapshot() {
		#[cfg(target_os = "macos")]
		let command = "top -l 1 -n 3";
		#[cfg(not(target_os = "macos"))]
		let command = "top -b -n 1 -r 3";
		let (result, output) = execute_captured(command.to_string()).await;
		assert_eq!(result.exit_code, Some(0));
		assert!(output.contains("top - snapshot 1"));
		assert!(output.contains("PID"));
		assert!(output.contains("COMMAND"));
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn top_builtin_stops_when_its_output_pipe_closes() {
		#[cfg(target_os = "macos")]
		let command = "top -s 0 | head -n 1";
		#[cfg(not(target_os = "macos"))]
		let command = "top -d 0 | head -n 1";
		let execution = time::timeout(Duration::from_secs(2), execute_captured(command.to_string()))
			.await
			.expect("top kept sampling after its output pipe closed");
		assert_eq!(execution.0.exit_code, Some(0));
		assert!(execution.1.contains("top - snapshot 1"), "{:?}", execution.1);
	}

	/// Regression: builtin tail upstream of an early-exiting consumer printed
	/// "tail: Broken pipe" and failed (`tail -c N big.jsonl | jq …` with jq
	/// aborting on a parse error). Real tail dies silently from SIGPIPE; the
	/// builtin must exit 141 with no diagnostic. `pipefail` exposes tail's own
	/// status, so rc=141 proves the broken pipe actually fired (head closed
	/// the pipe early) and was mapped to the silent SIGPIPE exit, not 1.
	#[tokio::test(flavor = "multi_thread")]
	async fn tail_builtin_is_silent_when_downstream_closes_pipe() {
		let dir = tempfile::tempdir().expect("tempdir");
		let file = dir.path().join("big.txt");
		// ~589 KiB: forces the seekable bounded_tail path, and the 400 KB tail
		// overflows the OS pipe buffer so tail is still writing when head exits.
		let command = format!(
			"seq 1 100000 > '{file}'; set -o pipefail; tail -c 400000 '{file}' | head -c 10 > \
			 /dev/null; echo rc=$?",
			file = file.display()
		);
		let (result, output) = execute_captured(command).await;
		assert_eq!(result.exit_code, Some(0));
		assert!(output.contains("rc=141"), "{output:?}");
		assert!(!output.contains("Broken pipe"), "{output:?}");
	}

	/// The kill builtin accepts a numeric signal and applies it to every process
	/// operand.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn kill_builtin_accepts_numeric_signal_for_multiple_processes() {
		let mut first = Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("first sleep");
		let mut second = Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("second sleep");
		let first_pid = first.id().expect("first pid");
		let second_pid = second.id().expect("second pid");
		let (mut session, params) = kill_test_context().await;
		let source_info = SourceInfo::from("pi-natives:test");

		let result = session
			.shell
			.run_string(format!("kill -9 {first_pid} {second_pid}"), &source_info, &params)
			.await
			.expect("kill command");
		let code = exit_code(&result);
		if code != 0 {
			let _ = first.kill().await;
			let _ = second.kill().await;
			let _ = first.wait().await;
			let _ = second.wait().await;
			assert_eq!(code, 0, "numeric multi-process kill should succeed");
		}

		let statuses =
			time::timeout(Duration::from_secs(5), async { tokio::join!(first.wait(), second.wait()) })
				.await;
		if statuses.is_err() {
			let _ = first.kill().await;
			let _ = second.kill().await;
			let _ = first.wait().await;
			let _ = second.wait().await;
			panic!("kill must signal every process operand");
		}
		let (first_status, second_status) = statuses.expect("checked timeout");
		assert_eq!(first_status.expect("first wait").signal(), Some(libc::SIGKILL));
		assert_eq!(second_status.expect("second wait").signal(), Some(libc::SIGKILL));
	}

	/// The kill builtin defaults to SIGTERM so processes can shut down
	/// gracefully.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn kill_builtin_defaults_to_sigterm() {
		let dir = tempfile::tempdir().expect("temp dir");
		let ready = dir.path().join("ready");
		let mut child = Command::new("sh")
			.args([
				"-c",
				"trap 'exit 42' TERM; : > \"$1\"; while :; do :; done",
				"sh",
				ready.to_str().expect("utf8 path"),
			])
			.spawn()
			.expect("trapping child");
		let pid = child.id().expect("child pid");
		let ready_result = time::timeout(Duration::from_secs(5), async {
			while !ready.exists() {
				time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await;
		if ready_result.is_err() {
			let _ = child.kill().await;
			let _ = child.wait().await;
			panic!("child did not install its SIGTERM trap");
		}

		let (mut session, params) = kill_test_context().await;
		let source_info = SourceInfo::from("pi-natives:test");
		let result = session
			.shell
			.run_string(format!("kill {pid}"), &source_info, &params)
			.await
			.expect("kill command");
		let code = exit_code(&result);

		let status = time::timeout(Duration::from_secs(5), child.wait()).await;
		if status.is_err() {
			let _ = child.kill().await;
			let _ = child.wait().await;
			panic!("default kill signal did not terminate the child");
		}
		assert_eq!(code, 0, "default kill should succeed");
		assert_eq!(status.expect("checked timeout").expect("child wait").code(), Some(42));
	}

	/// A negative PID after `--` targets a process group per `kill(2)` instead
	/// of being parsed as a numeric signal, and a plain PID in the same command
	/// is still signaled.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn kill_builtin_preserves_negative_pid_process_group_operands() {
		let dir = tempfile::tempdir().expect("temp dir");
		let group_ready = dir.path().join("group-ready");
		let plain_ready = dir.path().join("plain-ready");
		let spawn_trapping = |ready: &std::path::Path, own_group: bool| {
			let mut cmd = Command::new("sh");
			cmd.args([
				"-c",
				"trap 'exit 42' TERM; : > \"$1\"; while :; do sleep 0.05; done",
				"sh",
				ready.to_str().expect("utf8 path"),
			]);
			if own_group {
				// pgid becomes this child's own pid, so `-pid` addresses the group.
				cmd.process_group(0);
			}
			cmd.spawn().expect("trapping child")
		};

		let mut group_child = spawn_trapping(&group_ready, true);
		let mut plain_child = spawn_trapping(&plain_ready, false);
		let group_pid = group_child.id().expect("group pid");
		let plain_pid = plain_child.id().expect("plain pid");

		let ready_result = time::timeout(Duration::from_secs(5), async {
			while !group_ready.exists() || !plain_ready.exists() {
				time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await;
		if ready_result.is_err() {
			let _ = group_child.start_kill();
			let _ = plain_child.start_kill();
			let _ = group_child.wait().await;
			let _ = plain_child.wait().await;
			panic!("children did not install their SIGTERM traps");
		}

		let (mut session, params) = kill_test_context().await;
		let source_info = SourceInfo::from("pi-natives:test");
		let result = session
			.shell
			.run_string(format!("kill -TERM -- -{group_pid} {plain_pid}"), &source_info, &params)
			.await
			.expect("kill command");
		let code = exit_code(&result);

		let statuses = time::timeout(Duration::from_secs(5), async {
			tokio::join!(group_child.wait(), plain_child.wait())
		})
		.await;
		if statuses.is_err() {
			let _ = group_child.start_kill();
			let _ = plain_child.start_kill();
			let _ = group_child.wait().await;
			let _ = plain_child.wait().await;
			panic!("negative-PID kill must signal the process group and the plain PID");
		}
		let (group_status, plain_status) = statuses.expect("checked timeout");
		assert_eq!(code, 0, "negative-PID kill should succeed");
		assert_eq!(group_status.expect("group wait").code(), Some(42));
		assert_eq!(plain_status.expect("plain wait").code(), Some(42));
	}

	/// When clap consumes the `--` marker before `execute` (the default-signal
	/// and `-s SIG` forms), a following negative PID is still an operand, not a
	/// signal: `kill -- -<pgid>` defaults to SIGTERM for the group, and
	/// `kill -s TERM -- -<pgid>` sends the named signal to the group.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn kill_builtin_signals_group_when_marker_precedes_negative_pid() {
		let dir = tempfile::tempdir().expect("temp dir");
		let default_ready = dir.path().join("default-ready");
		let named_ready = dir.path().join("named-ready");
		let spawn_group_leader = |ready: &std::path::Path| {
			Command::new("sh")
				.args([
					"-c",
					"trap 'exit 42' TERM; : > \"$1\"; while :; do sleep 0.05; done",
					"sh",
					ready.to_str().expect("utf8 path"),
				])
				.process_group(0)
				.spawn()
				.expect("group leader")
		};

		let mut default_child = spawn_group_leader(&default_ready);
		let mut named_child = spawn_group_leader(&named_ready);
		let default_pid = default_child.id().expect("default pid");
		let named_pid = named_child.id().expect("named pid");

		let ready_result = time::timeout(Duration::from_secs(5), async {
			while !default_ready.exists() || !named_ready.exists() {
				time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await;
		if ready_result.is_err() {
			let _ = default_child.start_kill();
			let _ = named_child.start_kill();
			let _ = default_child.wait().await;
			let _ = named_child.wait().await;
			panic!("group leaders did not install their SIGTERM traps");
		}

		let (mut session, params) = kill_test_context().await;
		let source_info = SourceInfo::from("pi-natives:test");
		// Default signal (SIGTERM) with the marker consumed by clap.
		let default_result = session
			.shell
			.run_string(format!("kill -- -{default_pid}"), &source_info, &params)
			.await
			.expect("default kill command");
		// Named signal via -s, marker consumed by clap.
		let named_result = session
			.shell
			.run_string(format!("kill -s TERM -- -{named_pid}"), &source_info, &params)
			.await
			.expect("named kill command");

		let statuses = time::timeout(Duration::from_secs(5), async {
			tokio::join!(default_child.wait(), named_child.wait())
		})
		.await;
		if statuses.is_err() {
			let _ = default_child.start_kill();
			let _ = named_child.start_kill();
			let _ = default_child.wait().await;
			let _ = named_child.wait().await;
			panic!("marker-preceded negative PID must signal the process group");
		}
		let (default_status, named_status) = statuses.expect("checked timeout");
		assert_eq!(exit_code(&default_result), 0, "`kill -- -<pgid>` should succeed");
		assert_eq!(exit_code(&named_result), 0, "`kill -s TERM -- -<pgid>` should succeed");
		assert_eq!(default_status.expect("default wait").code(), Some(42));
		assert_eq!(named_status.expect("named wait").code(), Some(42));
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn kill_builtin_signals_every_process_in_a_jobspec_pipeline() {
		const MARKER: &str = "PI_SHELL_TEST_KILL_JOBSPEC_PIPELINE";
		if std::env::var_os(MARKER).is_none() {
			run_isolated_kill_test(
				"shell::tests::kill_builtin_signals_every_process_in_a_jobspec_pipeline",
				MARKER,
				true,
			)
			.await;
			return;
		}

		let dir = tempfile::tempdir().expect("jobspec directory");
		let first_pidfile = dir.path().join("first.pid");
		let second_pidfile = dir.path().join("second.pid");
		let _cleanup = PidfileProcessCleanup(vec![first_pidfile.clone(), second_pidfile.clone()]);
		let first_ready = dir.path().join("first.ready");
		let second_ready = dir.path().join("second.ready");
		let first_script = "trap 'exit 42' TERM; echo $$ > \"$1\"; : > \"$2\"; kill -STOP $$; while \
		                    :; do sleep 0.05; done";
		let second_script = "trap 'exit 43' TERM; echo $$ > \"$1\"; : > \"$2\"; kill -STOP $$; \
		                     while :; do sleep 0.05; done";
		let command = format!(
			"sh -c {} sh {} {} | sh -c {} sh {} {}",
			quote_arg(first_script),
			quote_arg(first_pidfile.to_str().expect("utf8 first pidfile")),
			quote_arg(first_ready.to_str().expect("utf8 first ready path")),
			quote_arg(second_script),
			quote_arg(second_pidfile.to_str().expect("utf8 second pidfile")),
			quote_arg(second_ready.to_str().expect("utf8 second ready path")),
		);
		let (mut session, params) = kill_test_context().await;
		let source_info = SourceInfo::from("pi-natives:test");

		time::timeout(
			Duration::from_secs(5),
			session.shell.run_string(command, &source_info, &params),
		)
		.await
		.expect("pipeline did not stop")
		.expect("stopped pipeline");
		time::timeout(Duration::from_secs(5), async {
			while !first_ready.exists() || !second_ready.exists() {
				time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await
		.expect("pipeline processes did not become ready");
		assert_eq!(
			session
				.shell
				.jobs()
				.current_job()
				.expect("stopped pipeline job")
				.process_ids()
				.count(),
			2,
			"jobspec must retain every external pipeline process",
		);
		let pids = [&first_pidfile, &second_pidfile].map(|pidfile| {
			fs::read_to_string(pidfile)
				.expect("pipeline pidfile")
				.trim()
				.parse::<i32>()
				.expect("pipeline pid")
		});

		let killed = session
			.shell
			.run_string("kill -CONT %1; kill %1", &source_info, &params)
			.await
			.expect("kill jobspec");
		assert_eq!(exit_code(&killed), 0, "`kill %1` should signal every pipeline process");
		let _ = session
			.shell
			.run_string("wait %1", &source_info, &params)
			.await
			.expect("reap jobspec");
		for pid in pids {
			assert!(process::Process::from_pid(pid).is_none(), "pipeline process {pid} survived");
		}
	}

	/// A failed target makes `kill` return non-zero without preventing later
	/// process operands from receiving the selected signal.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn kill_builtin_continues_after_target_failure() {
		let mut first = Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("first sleep");
		let mut second = Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("second sleep");
		let mut stale = Command::new("true").spawn().expect("stale process");
		let first_pid = first.id().expect("first pid");
		let second_pid = second.id().expect("second pid");
		let stale_pid = stale.id().expect("stale pid");
		stale.wait().await.expect("stale wait");

		let (mut session, params) = kill_test_context().await;
		let source_info = SourceInfo::from("pi-natives:test");
		let result = session
			.shell
			.run_string(
				format!("kill -KILL {first_pid} {stale_pid} {second_pid}"),
				&source_info,
				&params,
			)
			.await
			.expect("kill command");
		let code = exit_code(&result);

		let statuses =
			time::timeout(Duration::from_secs(5), async { tokio::join!(first.wait(), second.wait()) })
				.await;
		if statuses.is_err() {
			let _ = first.start_kill();
			let _ = second.start_kill();
			let _ = first.wait().await;
			let _ = second.wait().await;
			panic!("kill must continue signaling after an intermediate target fails");
		}
		let (first_status, second_status) = statuses.expect("checked timeout");
		assert_ne!(code, 0, "a failed target should make kill return non-zero");
		assert_eq!(first_status.expect("first wait").signal(), Some(libc::SIGKILL));
		assert_eq!(second_status.expect("second wait").signal(), Some(libc::SIGKILL));
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn kill_builtin_translates_signal_names_and_numbers() {
		let (result, output) = execute_captured("kill -l KILL; kill -l 9".to_string()).await;
		assert_eq!(result.exit_code, Some(0));
		assert_eq!(output, "9\nKILL\n");
	}

	async fn run_isolated_kill_test(test_name: &str, marker: &str, own_process_group: bool) {
		let mut command =
			tokio::process::Command::new(std::env::current_exe().expect("current test executable"));
		command.args(["--exact", test_name]).env(marker, "1");
		#[cfg(unix)]
		if own_process_group {
			command.process_group(0);
		}
		#[cfg(not(unix))]
		let _ = own_process_group;
		let status = command.status().await.expect("isolated test process");
		assert!(status.success(), "isolated kill test failed: {status}");
	}

	/// `kill -0` can probe the shell, but a nonzero signal aimed at its PID is
	/// refused without terminating command execution.
	#[tokio::test(flavor = "multi_thread")]
	async fn kill_builtin_refuses_own_pid() {
		const MARKER: &str = "PI_SHELL_TEST_KILL_OWN_PID";
		if std::env::var_os(MARKER).is_none() {
			run_isolated_kill_test("shell::tests::kill_builtin_refuses_own_pid", MARKER, false).await;
			return;
		}

		let pid = std::process::id();
		let (probe, _) = execute_captured(format!("kill -0 {pid}")).await;
		assert_eq!(probe.exit_code, Some(0), "signal 0 should probe the shell process");
		let (result, output) = execute_captured(format!(
			"kill -KILL {pid}; status=$?; printf 'status=%s survived\\n' \"$status\"; test \
			 \"$status\" -ne 0"
		))
		.await;
		assert_eq!(result.exit_code, Some(0), "the shell must survive a direct kill attempt");
		assert!(output.contains("refusing to signal the shell process"), "{output:?}");
		assert!(output.contains("survived"), "{output:?}");
	}

	/// A process-group operand that contains the shell is rejected before the
	/// `kill(2)` group operation can signal any member.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn kill_builtin_refuses_own_process_group() {
		const MARKER: &str = "PI_SHELL_TEST_KILL_OWN_GROUP";
		if std::env::var_os(MARKER).is_none() {
			run_isolated_kill_test(
				"shell::tests::kill_builtin_refuses_own_process_group",
				MARKER,
				true,
			)
			.await;
			return;
		}

		let (result, output) = execute_captured(
			"kill -KILL -- 0; status=$?; printf 'status=%s survived\\n' \"$status\"; test \
			 \"$status\" -ne 0"
				.to_string(),
		)
		.await;
		assert_eq!(result.exit_code, Some(0), "the shell must survive a group kill attempt");
		assert!(output.contains("refusing to signal the shell process"), "{output:?}");
		assert!(output.contains("survived"), "{output:?}");
	}

	/// `pkill` removes the shell PID from the candidate set before sending the
	/// selected signal, even when that PID is requested explicitly.
	#[tokio::test(flavor = "multi_thread")]
	async fn pkill_builtin_excludes_own_pid() {
		const MARKER: &str = "PI_SHELL_TEST_PKILL_OWN_PID";
		if std::env::var_os(MARKER).is_none() {
			run_isolated_kill_test("shell::tests::pkill_builtin_excludes_own_pid", MARKER, false)
				.await;
			return;
		}

		let pid = std::process::id();
		let (result, output) = execute_captured(format!(
			"pkill -KILL -p {pid}; status=$?; printf 'status=%s survived\\n' \"$status\"; test \
			 \"$status\" -eq 1"
		))
		.await;
		assert_eq!(result.exit_code, Some(0), "the shell must survive an explicit pkill");
		assert!(output.contains("survived"), "{output:?}");
	}

	/// `cmp` remains available with no executable search path, proving the shell
	/// dispatches the in-process builtin rather than a platform binary.
	#[tokio::test(flavor = "multi_thread")]
	async fn cmp_is_registered_as_an_in_process_builtin() {
		let dir = tempfile::tempdir().expect("temp dir");
		let root = std::fs::canonicalize(dir.path()).expect("canonical temp dir");
		std::fs::write(root.join("a"), b"same").expect("write a");
		std::fs::write(root.join("b"), b"same").expect("write b");
		std::fs::write(root.join("c"), b"different").expect("write c");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session
			.shell
			.set_working_dir(root.to_str().expect("utf8 temp path"))
			.expect("set cwd");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null stdin"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null stdout"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null stderr"));
		let source_info = SourceInfo::from("pi-natives:test");

		let equal = session
			.shell
			.run_string("PATH=/definitely-missing cmp -s a b", &source_info, &params)
			.await
			.expect("equal cmp");
		assert_eq!(exit_code(&equal), 0);

		let different = session
			.shell
			.run_string("PATH=/definitely-missing cmp -s a c", &source_info, &params)
			.await
			.expect("different cmp");
		assert_eq!(exit_code(&different), 1);
	}

	/// The moreutils-style builtins (`ts`, `sponge`, `isutf8`, `combine`,
	/// `ifne`, `errno`) dispatch in-process: the script runs with no usable
	/// executable search path, and the `ts | sponge` pipeline must land its
	/// output in the shell's working directory.
	#[tokio::test(flavor = "multi_thread")]
	async fn moreutils_builtins_are_registered_in_process() {
		let dir = tempfile::tempdir().expect("temp dir");
		let root = std::fs::canonicalize(dir.path()).expect("canonical temp dir");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session
			.shell
			.set_working_dir(root.to_str().expect("utf8 temp path"))
			.expect("set cwd");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null stdin"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null stdout"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null stderr"));
		let source_info = SourceInfo::from("pi-natives:test");

		let script = "PATH=/definitely-missing\necho x | ts -s '%H:%M:%S' | sponge out || exit \
		              10\nisutf8 out || exit 11\necho x | combine - and out || exit 12\nifne \
		              /definitely-missing/tool || exit 13";
		let result = session
			.shell
			.run_string(script, &source_info, &params)
			.await
			.expect("moreutils script");
		assert_eq!(exit_code(&result), 0);

		// `ts -s` stamps the first line with zero elapsed time: `HH:MM:SS x`.
		let out = std::fs::read_to_string(root.join("out")).expect("sponge output");
		assert!(out.len() == 11 && out.ends_with(" x\n"), "unexpected ts+sponge output: {out:?}");

		#[cfg(unix)]
		{
			let errno = session
				.shell
				.run_string("errno ENOENT", &source_info, &params)
				.await
				.expect("errno lookup");
			assert_eq!(exit_code(&errno), 0);
		}
	}

	/// The uutils-backed `mkdir` builtin must (1) create directories under the
	/// shell's working directory rather than the host process cwd, (2) route
	/// `-v` output through the command's (here redirected) stdout, and (3)
	/// display the original operand, not the resolved absolute path.
	#[tokio::test(flavor = "multi_thread")]
	async fn uutils_mkdir_resolves_cwd_and_displays_operand() {
		let tmp = std::env::temp_dir().join(format!("pi-mkdir-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(&tmp).expect("temp dir");
		let tmp_str = tmp.to_str().expect("utf8 temp path");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(tmp_str).expect("set cwd");

		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));

		let source_info = SourceInfo::from("pi-natives:test");
		let exec = session
			.shell
			.run_string("mkdir -v -p a/b/c rel > out.txt", &source_info, &params)
			.await
			.expect("run_string");
		assert!(matches!(exec.exit_code, ExecutionExitCode::Success), "exit {}", exit_code(&exec));

		// (1) created under the shell working dir, and (2) not leaked into the
		// host process cwd.
		assert!(tmp.join("a/b/c").is_dir(), "nested dirs not created under shell cwd");
		assert!(tmp.join("rel").is_dir(), "rel not created under shell cwd");
		assert!(!std::path::Path::new("a/b/c").exists(), "mkdir leaked into process cwd");

		// (2)+(3): -v output reached the redirected file, names the operand, and
		// does not leak the absolute resolved path.
		let out = std::fs::read_to_string(tmp.join("out.txt")).expect("out.txt");
		assert!(out.contains("'rel'"), "verbose output missing operand `rel`: {out:?}");
		assert!(!out.contains(tmp_str), "verbose output leaked absolute path: {out:?}");

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// Regression test for issue #5819: `mkdir -p ~/proj/{a,b}` must create both
	/// `a` and `b` under `$HOME/proj`. Brace expansion runs before tilde
	/// expansion and previously left every element after the first with a
	/// literal `~`, so `b` was created as `./~/proj/b` in the shell cwd instead.
	#[tokio::test(flavor = "multi_thread")]
	async fn uutils_mkdir_expands_tilde_for_every_brace_element() {
		let base = std::env::temp_dir().join(format!("pi-mkdir-brace-{}", std::process::id()));
		let home = base.join("home");
		let cwd = base.join("cwd");
		let _ = std::fs::remove_dir_all(&base);
		std::fs::create_dir_all(&home).expect("home dir");
		std::fs::create_dir_all(&cwd).expect("cwd dir");
		let cwd_str = cwd.to_str().expect("utf8 cwd path");

		let mut env = HashMap::new();
		env.insert("HOME".to_string(), home.to_string_lossy().to_string());
		let config =
			ShellConfig { session_env: Some(env), snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(cwd_str).expect("set cwd");

		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));

		let source_info = SourceInfo::from("pi-natives:test");
		let exec = session
			.shell
			.run_string("mkdir -p ~/proj/{a,b}", &source_info, &params)
			.await
			.expect("run_string");
		assert!(matches!(exec.exit_code, ExecutionExitCode::Success), "exit {}", exit_code(&exec));

		// Both elements' tildes expanded: dirs land under $HOME/proj.
		assert!(home.join("proj/a").is_dir(), "~/proj/a not created under HOME");
		assert!(home.join("proj/b").is_dir(), "~/proj/b not created under HOME");
		// The buggy path created a literal `~` tree in the shell cwd.
		assert!(!cwd.join("~").exists(), "literal ~ tree leaked into cwd");
		assert!(!cwd.join("a").exists(), "unexpanded element leaked into cwd");

		let _ = std::fs::remove_dir_all(&base);
	}

	/// `mkdir --help` and an invalid flag must be handled in-process: rendered
	/// to the command streams and returned as an exit code. The upstream
	/// `uumain` parser calls `std::process::exit`, which would terminate the
	/// whole host (and this test binary); reaching the asserts proves the
	/// vendored `run` entry point bypasses that path.
	#[tokio::test(flavor = "multi_thread")]
	async fn uutils_mkdir_help_and_bad_flag_do_not_exit_process() {
		let tmp = std::env::temp_dir().join(format!("pi-mkdir-help-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(&tmp).expect("temp dir");
		let tmp_str = tmp.to_str().expect("utf8 temp path");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(tmp_str).expect("set cwd");

		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));
		let source_info = SourceInfo::from("pi-natives:test");

		let help = session
			.shell
			.run_string("mkdir --help > help.txt", &source_info, &params)
			.await
			.expect("run_string help");
		assert_eq!(exit_code(&help), 0, "mkdir --help should succeed");
		let help_text = std::fs::read_to_string(tmp.join("help.txt")).expect("help.txt");
		assert!(help_text.contains("mkdir"), "help text missing util name: {help_text:?}");

		let bad = session
			.shell
			.run_string("mkdir --no-such-flag 2> err.txt", &source_info, &params)
			.await
			.expect("run_string bad flag");
		assert_ne!(exit_code(&bad), 0, "invalid flag should be a usage error");
		let err_text = std::fs::read_to_string(tmp.join("err.txt")).expect("err.txt");
		assert!(!err_text.is_empty(), "usage error should be reported to stderr");

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// The uutils-backed `head` builtin must read piped stdin through the
	/// context, read file operands resolved against the shell working directory,
	/// honor the obsolete `-NUM` syntax, and write to the command's (here
	/// redirected) stdout.
	#[tokio::test(flavor = "multi_thread")]
	async fn uutils_head_streams_stdin_and_reads_files() {
		let tmp = std::env::temp_dir().join(format!("pi-head-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(&tmp).expect("temp dir");
		std::fs::write(tmp.join("data.txt"), "l1\nl2\nl3\nl4\nl5\n").expect("write data");
		let tmp_str = tmp.to_str().expect("utf8 temp path");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(tmp_str).expect("set cwd");

		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));
		let source_info = SourceInfo::from("pi-natives:test");

		// File operand, resolved against the shell working directory.
		let f = session
			.shell
			.run_string("head -2 data.txt > out_file.txt", &source_info, &params)
			.await
			.expect("run_string file");
		assert_eq!(exit_code(&f), 0, "head file read should succeed");
		assert_eq!(std::fs::read_to_string(tmp.join("out_file.txt")).unwrap(), "l1\nl2\n");

		// Piped stdin (head is the final stage; reads the pipe through the ctx).
		let p = session
			.shell
			.run_string("printf 'a\\nb\\nc\\nd\\n' | head -2 > out_pipe.txt", &source_info, &params)
			.await
			.expect("run_string pipe");
		assert_eq!(exit_code(&p), 0, "head stdin read should succeed");
		assert_eq!(std::fs::read_to_string(tmp.join("out_pipe.txt")).unwrap(), "a\nb\n");

		// Obsolete `-NUM` syntax, normalized by arg_iterate.
		let o = session
			.shell
			.run_string("printf '1\\n2\\n3\\n' | head -1 > out_obs.txt", &source_info, &params)
			.await
			.expect("run_string obsolete");
		assert_eq!(exit_code(&o), 0, "head -1 should succeed");
		assert_eq!(std::fs::read_to_string(tmp.join("out_obs.txt")).unwrap(), "1\n");

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// `head --help` / invalid flag must be handled in-process (rendered to the
	/// command streams, returned as an exit code) — head has its own `run`
	/// entry point bypassing uutils' process-exiting parser, and literalized
	/// help strings.
	#[tokio::test(flavor = "multi_thread")]
	async fn uutils_head_help_and_bad_flag_do_not_exit_process() {
		let tmp = std::env::temp_dir().join(format!("pi-head-help-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(&tmp).expect("temp dir");
		let tmp_str = tmp.to_str().expect("utf8 temp path");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(tmp_str).expect("set cwd");

		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));
		let source_info = SourceInfo::from("pi-natives:test");

		let help = session
			.shell
			.run_string("head --help > help.txt", &source_info, &params)
			.await
			.expect("run_string head help");
		assert_eq!(exit_code(&help), 0, "head --help should succeed");
		let help_text = std::fs::read_to_string(tmp.join("help.txt")).expect("help.txt");
		assert!(help_text.contains("first"), "help text not localized: {help_text:?}");

		let bad = session
			.shell
			.run_string("head --no-such-flag 2> err.txt", &source_info, &params)
			.await
			.expect("run_string head bad flag");
		assert_ne!(exit_code(&bad), 0, "invalid flag should be a usage error");
		assert!(
			!std::fs::read_to_string(tmp.join("err.txt"))
				.expect("err.txt")
				.is_empty()
		);

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// Smoke-test the read-only uutils filter/listing builtins end-to-end
	/// through the shell: piped stdin (sort/wc/tail), file reads + cwd
	/// resolution (grep/ls/find), and redirected stdout capture.
	#[tokio::test(flavor = "multi_thread")]
	async fn uutils_filters_listing_find_grep() {
		let tmp = std::env::temp_dir().join(format!("pi-utils-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(tmp.join("sub")).expect("temp dirs");
		std::fs::write(tmp.join("data.txt"), "foo\nbar\nbaz\n").expect("data");
		std::fs::write(tmp.join("sub/nested.txt"), "deep\n").expect("nested");
		let tmp_str = tmp.to_str().expect("utf8");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(tmp_str).expect("cwd");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));
		let si = SourceInfo::from("pi-natives:test");
		let read = |name: &str| std::fs::read_to_string(tmp.join(name)).unwrap_or_default();

		// sort: reads piped stdin, parallel sort, writes sorted output.
		session
			.shell
			.run_string("printf 'c\\na\\nb\\n' | sort > sort.txt", &si, &params)
			.await
			.expect("sort");
		assert_eq!(read("sort.txt"), "a\nb\nc\n");
		// wc -l: line count from stdin.
		session
			.shell
			.run_string("printf 'x\\ny\\nz\\n' | wc -l > wc.txt", &si, &params)
			.await
			.expect("wc");
		assert_eq!(read("wc.txt").trim(), "3");
		// tail: last N lines from stdin.
		session
			.shell
			.run_string("printf '1\\n2\\n3\\n4\\n' | tail -2 > tail.txt", &si, &params)
			.await
			.expect("tail");
		assert_eq!(read("tail.txt"), "3\n4\n");
		// grep: matching lines from a cwd-resolved file (single file => no prefix).
		session
			.shell
			.run_string("grep ba data.txt > grep.txt", &si, &params)
			.await
			.expect("grep");
		assert_eq!(read("grep.txt"), "bar\nbaz\n");
		// ls: non-tty listing of the cwd.
		session
			.shell
			.run_string("ls > ls.txt", &si, &params)
			.await
			.expect("ls");
		let ls = read("ls.txt");
		assert!(ls.contains("data.txt") && ls.contains("sub"), "ls output: {ls:?}");
		// find: recursive name match. Paths must keep the `.` operand prefix
		// (GNU/BSD contract) instead of leaking the working-dir-resolved absolute
		// root the walk is physically rooted at.
		session
			.shell
			.run_string("find . -name '*.txt' > find.txt", &si, &params)
			.await
			.expect("find");
		let found = read("find.txt");
		assert!(!found.trim().is_empty(), "find produced no output");
		for line in found.lines() {
			assert!(
				line.starts_with("./"),
				"find path is not operand-relative: {line:?} (full: {found:?})"
			);
		}
		assert!(
			found.contains("./data.txt") && found.contains("./sub/nested.txt"),
			"find output: {found:?}"
		);
		// cat: concatenate a cwd-resolved file with -n line numbering.
		session
			.shell
			.run_string("cat -n data.txt > cat.txt", &si, &params)
			.await
			.expect("cat");
		assert_eq!(read("cat.txt"), "     1\tfoo\n     2\tbar\n     3\tbaz\n");
		// uniq: collapse adjacent duplicate lines from piped stdin.
		session
			.shell
			.run_string("printf 'a\\na\\nb\\nb\\nb\\nc\\n' | uniq > uniq.txt", &si, &params)
			.await
			.expect("uniq");
		assert_eq!(read("uniq.txt"), "a\nb\nc\n");

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// `rg` is not an alias for `grep`: it recurses by default, respects
	/// ripgrep's ignore/hidden/binary filters, and keeps `-h` as help.
	#[tokio::test(flavor = "multi_thread")]
	async fn rg_builtin_uses_ripgrep_defaults() {
		let tmp = std::env::temp_dir().join(format!("pi-rg-defaults-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(tmp.join("sub")).expect("sub dir");
		std::fs::create_dir_all(tmp.join(".git")).expect("git dir");
		std::fs::write(tmp.join("data.txt"), "alpha\nneedle\n").expect("data");
		std::fs::write(tmp.join("sub/nested.txt"), "needle\n").expect("nested");
		std::fs::write(tmp.join(".hidden.txt"), "needle\n").expect("hidden");
		std::fs::write(tmp.join("ignored.log"), "needle\n").expect("ignored");
		std::fs::write(tmp.join(".gitignore"), "ignored.log\n").expect("gitignore");
		std::fs::write(tmp.join("binary.bin"), b"needle\0hidden\n").expect("binary");
		let tmp_str = tmp.to_str().expect("utf8");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(tmp_str).expect("cwd");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));
		let si = SourceInfo::from("pi-natives:test");
		let read = |name: &str| std::fs::read_to_string(tmp.join(name)).unwrap_or_default();

		let exec = session
			.shell
			.run_string("rg needle > rg.txt", &si, &params)
			.await
			.expect("rg");
		assert_eq!(exit_code(&exec), 0, "rg recursive search should match");
		let out = read("rg.txt");
		assert!(out.contains("data.txt:needle"), "rg missed visible file: {out:?}");
		assert!(out.contains("sub/nested.txt:needle"), "rg missed nested file: {out:?}");
		assert!(!out.contains(".hidden.txt"), "rg searched hidden file by default: {out:?}");
		assert!(!out.contains("ignored.log"), "rg ignored .gitignore by default: {out:?}");
		assert!(!out.contains("binary.bin"), "rg printed binary file by default: {out:?}");

		let single = session
			.shell
			.run_string("rg -nH needle data.txt > single.txt", &si, &params)
			.await
			.expect("rg single");
		assert_eq!(exit_code(&single), 0, "rg explicit file should match");
		assert_eq!(read("single.txt"), "data.txt:2:needle\n");

		let explicit_binary = session
			.shell
			.run_string("rg needle binary.bin > explicit-binary.txt", &si, &params)
			.await
			.expect("rg explicit binary");
		assert_eq!(exit_code(&explicit_binary), 0, "explicit binary file should be searched");
		assert_eq!(read("explicit-binary.txt"), "needle\n");

		let help = session
			.shell
			.run_string("rg -h > help.txt", &si, &params)
			.await
			.expect("rg help");
		assert_eq!(exit_code(&help), 0, "rg -h should be help, not no-filename");
		assert!(
			read("help.txt").contains("ripgrep recursively searches"),
			"help text should describe ripgrep"
		);

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// `fd` recurses from the shell working directory, respects hidden and
	/// ignore filters (including `.fdignore`), preserves explicit search-path
	/// prefixes, and renders help to stdout with a success status.
	#[tokio::test(flavor = "multi_thread")]
	async fn fd_builtin_uses_fd_defaults() {
		let tmp = std::env::temp_dir().join(format!("pi-fd-defaults-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(tmp.join("sub")).expect("sub dir");
		std::fs::create_dir_all(tmp.join(".git/info")).expect("git info dir");
		std::fs::write(tmp.join("needle.txt"), "visible\n").expect("visible");
		std::fs::write(tmp.join("sub/needle.rs"), "nested\n").expect("nested");
		std::fs::write(tmp.join(".hidden-needle.txt"), "hidden\n").expect("hidden");
		std::fs::write(tmp.join("ignored-needle.log"), "ignored\n").expect("ignored");
		std::fs::write(tmp.join("excluded-needle.vcs"), "excluded\n").expect("excluded");
		std::fs::write(tmp.join("fdignored-needle.tmp"), "fdignored\n").expect("fdignored");
		std::fs::write(tmp.join(".gitignore"), "ignored-needle.log\n").expect("gitignore");
		std::fs::write(tmp.join(".git/info/exclude"), "excluded-needle.vcs\n").expect("exclude");
		std::fs::write(tmp.join(".fdignore"), "fdignored-needle.tmp\n").expect("fdignore");
		let tmp_str = tmp.to_str().expect("utf8");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(tmp_str).expect("cwd");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));
		let si = SourceInfo::from("pi-natives:test");
		let read = |name: &str| std::fs::read_to_string(tmp.join(name)).unwrap_or_default();

		let exec = session
			.shell
			.run_string("fd needle > fd.txt", &si, &params)
			.await
			.expect("fd");
		assert_eq!(exit_code(&exec), 0, "fd should match visible files");
		let out = read("fd.txt");
		assert!(out.contains("needle.txt"), "fd missed visible file: {out:?}");
		assert!(out.contains("sub/needle.rs"), "fd missed nested file: {out:?}");
		assert!(!out.contains(".hidden-needle.txt"), "fd searched hidden file: {out:?}");
		assert!(!out.contains("ignored-needle.log"), "fd ignored .gitignore: {out:?}");
		assert!(!out.contains("fdignored-needle.tmp"), "fd ignored .fdignore: {out:?}");
		assert!(!out.contains("excluded-needle.vcs"), "fd ignored .git/info/exclude: {out:?}");

		session
			.shell
			.run_string("fd -u needle > unrestricted.txt", &si, &params)
			.await
			.expect("fd -u");
		let unrestricted = read("unrestricted.txt");
		assert!(unrestricted.contains(".hidden-needle.txt"), "-u should include hidden files");
		assert!(unrestricted.contains("ignored-needle.log"), "-u should include gitignored files");
		assert!(unrestricted.contains("fdignored-needle.tmp"), "-u should include fdignored files");

		session
			.shell
			.run_string("fd --no-ignore-vcs needle > no-ignore-vcs.txt", &si, &params)
			.await
			.expect("fd --no-ignore-vcs");
		let no_ignore_vcs = read("no-ignore-vcs.txt");
		assert!(
			no_ignore_vcs.contains("ignored-needle.log"),
			"--no-ignore-vcs should include .gitignore matches"
		);
		assert!(
			no_ignore_vcs.contains("excluded-needle.vcs"),
			"--no-ignore-vcs should include .git/info/exclude matches"
		);
		assert!(
			!no_ignore_vcs.contains("fdignored-needle.tmp"),
			"--no-ignore-vcs must still respect .fdignore"
		);

		session
			.shell
			.run_string("fd --glob '*.rs' sub > glob.txt", &si, &params)
			.await
			.expect("fd glob");
		assert_eq!(read("glob.txt"), "sub/needle.rs\n");

		let no_match = session
			.shell
			.run_string("fd definitely-absent > no-match.txt", &si, &params)
			.await
			.expect("fd no match");
		assert_eq!(exit_code(&no_match), 0, "ordinary fd no-match should still succeed");
		assert_eq!(read("no-match.txt"), "");

		let quiet_miss = session
			.shell
			.run_string("fd -q definitely-absent > quiet-miss.txt", &si, &params)
			.await
			.expect("fd quiet miss");
		assert_eq!(exit_code(&quiet_miss), 1, "quiet fd no-match should fail");
		assert_eq!(read("quiet-miss.txt"), "");

		let quiet_hit = session
			.shell
			.run_string("fd -q needle > quiet-hit.txt", &si, &params)
			.await
			.expect("fd quiet hit");
		assert_eq!(exit_code(&quiet_hit), 0, "quiet fd match should succeed");
		assert_eq!(read("quiet-hit.txt"), "");

		let help = session
			.shell
			.run_string("fd --help > help.txt 2> help.err", &si, &params)
			.await
			.expect("fd help");
		assert_eq!(exit_code(&help), 0, "fd help should succeed");
		assert!(read("help.txt").contains("A program to find entries in your filesystem"));
		assert_eq!(read("help.err"), "");

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// Plain `rg PATTERN` uses the shell working directory when the host wired
	/// stdin to null, but a real pipeline remains stdin input. Pattern stdin
	/// (`-f -`) must not consume the implicit search path decision.
	#[tokio::test(flavor = "multi_thread")]
	async fn rg_builtin_defaults_to_cwd_unless_stdin_is_pipeline() {
		let tmp = std::env::temp_dir().join(format!("pi-rg-stdin-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(&tmp).expect("temp dir");
		std::fs::write(tmp.join("data.txt"), "from-cwd\nfrom-pattern\n").expect("data");
		let tmp_str = tmp.to_str().expect("utf8");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(tmp_str).expect("cwd");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));
		let si = SourceInfo::from("pi-natives:test");
		let read = |name: &str| std::fs::read_to_string(tmp.join(name)).unwrap_or_default();

		session
			.shell
			.run_string("rg from-cwd > cwd.txt", &si, &params)
			.await
			.expect("rg cwd");
		assert_eq!(read("cwd.txt"), "data.txt:from-cwd\n");

		session
			.shell
			.run_string("printf 'from-pipe\\n' | rg from-pipe > pipe.txt", &si, &params)
			.await
			.expect("rg pipe");
		assert_eq!(read("pipe.txt"), "from-pipe\n");

		session
			.shell
			.run_string("printf 'from-pattern\\n' | rg -f - > pattern.txt", &si, &params)
			.await
			.expect("rg pattern stdin");
		assert_eq!(read("pattern.txt"), "data.txt:from-pattern\n");

		session
			.shell
			.run_string("printf 'not-a-path\\n' | rg --files > files.txt", &si, &params)
			.await
			.expect("rg files");
		let files = read("files.txt");
		assert!(files.contains("data.txt"), "--files should list cwd files: {files:?}");
		assert!(!files.contains("not-a-path"), "--files must not read piped stdin: {files:?}");

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// `grep -q` must suppress all stdout and drive the exit status (0 on match,
	/// 1 otherwise) so shell conditionals work; `-x` must anchor whole lines.
	/// Mirrors busybox applet probing: `grep -qx "$applet" <(strings bin)`.
	#[tokio::test(flavor = "multi_thread")]
	async fn grep_quiet_and_line_regexp() {
		let tmp = std::env::temp_dir().join(format!("pi-grepq-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(&tmp).expect("temp dir");
		std::fs::write(tmp.join("data.txt"), "foo\nbar\nbaz\n").expect("data");
		let tmp_str = tmp.to_str().expect("utf8");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(tmp_str).expect("cwd");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));
		let si = SourceInfo::from("pi-natives:test");
		let read = |name: &str| std::fs::read_to_string(tmp.join(name)).unwrap_or_default();

		// -q: no stdout even on a match.
		session
			.shell
			.run_string("grep -q ba data.txt > qout.txt", &si, &params)
			.await
			.expect("grep -q");
		assert_eq!(read("qout.txt"), "", "-q must not print matches");
		// -q exit code drives `&&` (match) and `||` (no match).
		session
			.shell
			.run_string("grep -q ba data.txt && echo HIT > hit.txt", &si, &params)
			.await
			.expect("grep -q hit");
		assert_eq!(read("hit.txt"), "HIT\n", "-q match must exit 0");
		session
			.shell
			.run_string("grep -q zzz data.txt || echo MISS > miss.txt", &si, &params)
			.await
			.expect("grep -q miss");
		assert_eq!(read("miss.txt"), "MISS\n", "-q no-match must exit 1");
		// -qx: whole-line match succeeds on an exact line ...
		session
			.shell
			.run_string("grep -qx bar data.txt && echo XHIT > xhit.txt", &si, &params)
			.await
			.expect("grep -qx hit");
		assert_eq!(read("xhit.txt"), "XHIT\n", "-x must match a whole line");
		// ... and fails on a substring that is not a whole line.
		session
			.shell
			.run_string("grep -qx ba data.txt || echo XMISS > xmiss.txt", &si, &params)
			.await
			.expect("grep -qx miss");
		assert_eq!(read("xmiss.txt"), "XMISS\n", "-x must reject a partial-line match");

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// The destructive uutils builtins (`rm`, `mv`) must operate on paths
	/// resolved against the shell working directory, not the host process cwd.
	#[tokio::test(flavor = "multi_thread")]
	async fn uutils_rm_and_mv_operate_on_shell_cwd() {
		let tmp = std::env::temp_dir().join(format!("pi-rmmv-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(tmp.join("tree/inner")).expect("tree");
		std::fs::write(tmp.join("a.txt"), "hello").expect("a");
		std::fs::write(tmp.join("tree/inner/leaf.txt"), "x").expect("leaf");
		let tmp_str = tmp.to_str().expect("utf8");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(tmp_str).expect("cwd");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));
		let si = SourceInfo::from("pi-natives:test");

		// mv: rename within the shell cwd.
		let mv = session
			.shell
			.run_string("mv a.txt b.txt", &si, &params)
			.await
			.expect("mv");
		assert_eq!(exit_code(&mv), 0, "mv should succeed");
		assert!(!tmp.join("a.txt").exists(), "source should be gone");
		assert_eq!(std::fs::read_to_string(tmp.join("b.txt")).unwrap(), "hello");

		// rm -rf: recursive removal resolved against the shell cwd.
		let rm = session
			.shell
			.run_string("rm -rf tree", &si, &params)
			.await
			.expect("rm");
		assert_eq!(exit_code(&rm), 0, "rm -rf should succeed");
		assert!(!tmp.join("tree").exists(), "tree should be removed");
		// and the host process cwd must be untouched.
		assert!(tmp.join("b.txt").exists());

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// Removing a nonexistent file must print exactly one diagnostic (like GNU
	/// rm) and exit non-zero — not a second, message-less `rm:` line. Regression
	/// guard: the in-process entry point used to re-print the status-only
	/// `Err(1)` returned after `remove()` had already reported each failure.
	#[tokio::test(flavor = "multi_thread")]
	async fn uutils_rm_missing_file_prints_single_diagnostic() {
		let tmp = std::env::temp_dir().join(format!("pi-rm-missing-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(&tmp).expect("temp dir");
		let tmp_str = tmp.to_str().expect("utf8");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(tmp_str).expect("cwd");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));
		let si = SourceInfo::from("pi-natives:test");

		let rm = session
			.shell
			.run_string("rm nonexistent.txt 2> err.txt", &si, &params)
			.await
			.expect("rm");
		assert_ne!(exit_code(&rm), 0, "rm of a missing file must report failure");
		let err = std::fs::read_to_string(tmp.join("err.txt")).expect("err.txt");
		let lines: Vec<&str> = err.lines().collect();
		assert_eq!(lines.len(), 1, "rm should emit exactly one diagnostic line, got: {err:?}");
		assert!(lines[0].contains("nonexistent.txt"), "diagnostic should name the file: {err:?}");

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// The find display/match surface must use the operand-relative path while
	/// filesystem actions still target the real (resolved) path: `-path` and
	/// `-printf %p` see `./...`, while `-delete` removes the correct file.
	#[tokio::test(flavor = "multi_thread")]
	async fn uutils_find_display_and_actions_split_paths() {
		let tmp = std::env::temp_dir().join(format!("pi-find-split-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(tmp.join("sub")).expect("dirs");
		std::fs::write(tmp.join("keep.log"), "k").expect("keep");
		std::fs::write(tmp.join("sub/drop.tmp"), "d").expect("drop");
		let tmp_str = tmp.to_str().expect("utf8");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(tmp_str).expect("cwd");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));
		let si = SourceInfo::from("pi-natives:test");
		let read = |name: &str| std::fs::read_to_string(tmp.join(name)).unwrap_or_default();

		// -path matches against the operand-relative path.
		session
			.shell
			.run_string("find . -path './sub/*' > p.txt", &si, &params)
			.await
			.expect("path");
		assert_eq!(read("p.txt"), "./sub/drop.tmp\n", "-path should match the operand-relative path");

		// -printf %p emits the operand-relative path.
		session
			.shell
			.run_string("find . -name keep.log -printf '%p\\n' > pf.txt", &si, &params)
			.await
			.expect("printf");
		assert_eq!(read("pf.txt"), "./keep.log\n", "-printf %p should be operand-relative");

		// -delete operates on the real (resolved) path, removing the right file.
		let del = session
			.shell
			.run_string("find . -name '*.tmp' -delete", &si, &params)
			.await
			.expect("delete");
		assert_eq!(exit_code(&del), 0, "find -delete should succeed");
		assert!(!tmp.join("sub/drop.tmp").exists(), "-delete should remove the matched file");
		assert!(tmp.join("keep.log").exists(), "-delete must not touch unmatched files");

		// -exec substitutes the operand-relative path and runs in the shell cwd,
		// so the relative `{}` resolves and the child's redirect lands in the cwd.
		session
			.shell
			.run_string(
				"find . -name keep.log -exec sh -c 'printf %s \"$1\" > ex.txt' sh {} ';'",
				&si,
				&params,
			)
			.await
			.expect("exec");
		assert_eq!(
			read("ex.txt"),
			"./keep.log",
			"-exec {{}} should be operand-relative and run in the shell cwd"
		);

		// -exec children must write through the scope streams — an inherited
		// process stdout would bypass the shell redirect and spam the host
		// TUI's terminal — and must see the shell's exported environment.
		session
			.shell
			.run_string(
				"export PI_EXEC_ENV=zed; find . -name keep.log -exec sh -c 'echo \"$PI_EXEC_ENV $1\"' \
				 sh {} ';' > cap.txt",
				&si,
				&params,
			)
			.await
			.expect("exec capture");
		assert_eq!(
			read("cap.txt"),
			"zed ./keep.log\n",
			"-exec child stdout must flow through the shell redirect with the shell's exported env"
		);

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// The vendored `sed` builtin must stream pipeline stdin through scripts and
	/// perform `-i` in-place edits (with backup suffix) against the shell
	/// working directory rather than the host process cwd.
	#[tokio::test(flavor = "multi_thread")]
	async fn uutils_sed_substitutes_streams_and_edits_in_place() {
		let tmp = std::env::temp_dir().join(format!("pi-sed-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(&tmp).expect("temp dir");
		std::fs::write(tmp.join("conf.txt"), "x=1\n").expect("conf");
		let tmp_str = tmp.to_str().expect("utf8");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(tmp_str).expect("cwd");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));
		let si = SourceInfo::from("pi-natives:test");
		let read = |name: &str| std::fs::read_to_string(tmp.join(name)).unwrap_or_default();

		// Piped stdin through a quiet substitute-and-print script.
		session
			.shell
			.run_string("printf 'hello\\nworld\\n' | sed -n 's/hello/HI/p' > sed.txt", &si, &params)
			.await
			.expect("sed pipeline");
		assert_eq!(read("sed.txt"), "HI\n");
		// In-place edit of a cwd-relative operand, keeping the requested backup.
		session
			.shell
			.run_string("sed -i.bak 's/1/2/' conf.txt", &si, &params)
			.await
			.expect("sed -i");
		assert_eq!(read("conf.txt"), "x=2\n", "in-place edit must land in the shell cwd");
		assert_eq!(read("conf.txt.bak"), "x=1\n", "backup must keep the original");

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// The `xargs` builtin spawns real child processes, but their stdout must
	/// flow back into the shell pipeline (ctx streams, not the host fds), items
	/// must batch per `-n`, and a failing invocation must surface GNU's 123.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn uutils_xargs_children_feed_pipeline_and_report_failure() {
		let tmp = std::env::temp_dir().join(format!("pi-xargs-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(&tmp).expect("temp dir");
		let tmp_str = tmp.to_str().expect("utf8");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(tmp_str).expect("cwd");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));
		let si = SourceInfo::from("pi-natives:test");
		let read = |name: &str| std::fs::read_to_string(tmp.join(name)).unwrap_or_default();

		// Default echo action: child stdout is captured into the redirect.
		session
			.shell
			.run_string("printf 'a b c\\n' | xargs > xargs.txt", &si, &params)
			.await
			.expect("xargs default");
		assert_eq!(read("xargs.txt"), "a b c\n");
		// -n batching, with child output feeding a downstream builtin stage.
		session
			.shell
			.run_string(
				"printf '1\\n2\\n3\\n4\\n' | xargs -n2 echo | wc -l > batches.txt",
				&si,
				&params,
			)
			.await
			.expect("xargs -n2");
		assert_eq!(read("batches.txt").trim(), "2");
		// A child exiting 1-125 makes xargs exit 123 (GNU contract).
		session
			.shell
			.run_string("printf 'x\\n' | xargs false; printf %s $? > code.txt", &si, &params)
			.await
			.expect("xargs false");
		assert_eq!(read("code.txt"), "123");

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// The `jq` builtin must evaluate filters over piped JSON, resolve file
	/// operands against the shell working directory, and propagate `-e`'s
	/// null/false exit status through the shell.
	#[tokio::test(flavor = "multi_thread")]
	async fn uutils_jq_filters_json_and_propagates_exit_status() {
		let tmp = std::env::temp_dir().join(format!("pi-jq-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&tmp);
		std::fs::create_dir_all(&tmp).expect("temp dir");
		std::fs::write(tmp.join("in.json"), "{\"name\":\"pi\"}\n").expect("in.json");
		let tmp_str = tmp.to_str().expect("utf8");

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");
		session.shell.set_working_dir(tmp_str).expect("cwd");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));
		let si = SourceInfo::from("pi-natives:test");
		let read = |name: &str| std::fs::read_to_string(tmp.join(name)).unwrap_or_default();

		// Compact filter over piped stdin.
		session
			.shell
			.run_string("printf '{\"a\":{\"b\":2}}' | jq -c .a > jq.txt", &si, &params)
			.await
			.expect("jq pipeline");
		assert_eq!(read("jq.txt"), "{\"b\":2}\n");
		// Raw output from a cwd-relative file operand.
		session
			.shell
			.run_string("jq -r .name in.json > name.txt", &si, &params)
			.await
			.expect("jq file");
		assert_eq!(read("name.txt"), "pi\n");
		// -e maps a null result to exit status 1.
		session
			.shell
			.run_string("printf 'null' | jq -e . > /dev/null; printf %s $? > code.txt", &si, &params)
			.await
			.expect("jq -e");
		assert_eq!(read("code.txt"), "1");

		let _ = std::fs::remove_dir_all(&tmp);
	}

	/// A stdin-reading builtin blocked on an open pipe must honor abort/timeout:
	/// the context's cancel flag makes the read return EOF so the utility
	/// unwinds promptly and the command reports interrupted (130) — it must not
	/// hang or leak a detached thread that keeps the fds alive.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn uutils_head_stdin_read_is_cancellable() {
		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");

		// Hold the pipe's write end open with no data so `head` blocks reading.
		let (reader, _writer) = pipe_to_files("cancel").expect("pipe");
		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, OpenFile::from(reader));
		params.set_fd(OpenFiles::STDOUT_FD, null_file().expect("null"));
		params.set_fd(OpenFiles::STDERR_FD, null_file().expect("null"));
		let token = CancellationToken::new();
		params.set_cancel_token(token.clone());
		let si = SourceInfo::from("pi-natives:test");

		let canceller = tokio::spawn(async move {
			time::sleep(Duration::from_millis(150)).await;
			token.cancel();
		});
		let result = time::timeout(
			Duration::from_secs(5),
			session.shell.run_string("head -n 1000000", &si, &params),
		)
		.await;
		let _ = canceller.await;

		let exec = result
			.expect("head must return promptly after cancel, not hang on the open pipe")
			.expect("run_string");
		// Core contract: prompt return (the 5s timeout did NOT fire) proves the
		// read unblocked and the blocking task unwound cleanly — no hang, no
		// detached thread. The interrupted command reports a non-zero status;
		// `run_uutil` yields 130 but brush's run_string maps the cancelled
		// program to its own non-zero code, so we assert the stable contract.
		assert_ne!(
			exit_code(&exec),
			0,
			"cancelled stdin read should report a non-zero (interrupted) status"
		);
	}

	/// The disable env vars must actually gate registration: the global switch
	/// drops the whole set, and the per-utility destructive switches drop only
	/// the risky shadows.
	#[tokio::test(flavor = "multi_thread")]
	async fn uutils_builtins_respect_disable_env() {
		let session_with = |pairs: &[(&str, &str)]| {
			let map: std::collections::HashMap<String, String> = pairs
				.iter()
				.map(|(k, v)| ((*k).to_string(), (*v).to_string()))
				.collect();
			ShellConfig { session_env: Some(map), snapshot_path: None, minimizer: None }
		};

		let mut default = create_session(&ShellConfig {
			session_env:   None,
			snapshot_path: None,
			minimizer:     None,
		})
		.await
		.expect("create_session");
		assert!(default.shell.builtin_mut("head").is_some(), "head registered by default");
		assert!(default.shell.builtin_mut("rg").is_some(), "rg registered by default");
		assert!(default.shell.builtin_mut("rm").is_some(), "rm registered by default");
		assert!(default.shell.builtin_mut("mv").is_some(), "mv registered by default");

		let mut all_off = create_session(&session_with(&[("PI_DISABLE_UUTILS_BUILTINS", "1")]))
			.await
			.expect("create_session");
		assert!(all_off.shell.builtin_mut("head").is_none(), "kill-switch drops head");
		assert!(all_off.shell.builtin_mut("rg").is_none(), "kill-switch drops rg");
		assert!(all_off.shell.builtin_mut("rm").is_none(), "kill-switch drops rm");

		let mut rm_off = create_session(&session_with(&[("PI_DISABLE_RM_BUILTIN", "1")]))
			.await
			.expect("create_session");
		assert!(rm_off.shell.builtin_mut("rm").is_none(), "rm disabled individually");
		assert!(rm_off.shell.builtin_mut("mv").is_some(), "mv stays enabled");
		assert!(rm_off.shell.builtin_mut("head").is_some(), "head stays enabled");
	}

	/// Truth-table coverage for `brush_core::commands::child_session_action`.
	///
	/// Lives in `pi-natives` because the brush-core crate is excluded from the
	/// workspace (vendored upstream) and cannot be tested standalone — its tokio
	/// dependency only resolves the `net` feature via feature-unification with
	/// other workspace members.
	mod child_session_action {
		use brush_core::commands::{ChildSessionAction, child_session_action};

		/// Interactive brush, leading its own pgroup, terminal stdin: foreground.
		#[test]
		fn interactive_with_terminal_stdin_takes_foreground() {
			assert_eq!(child_session_action(true, true, false), ChildSessionAction::TakeForeground,);
			// Terminal foregrounding wins even when this is the first stage of a
			// pipeline; no detach is attempted.
			assert_eq!(child_session_action(true, true, true), ChildSessionAction::TakeForeground,);
		}

		/// Brush leading a new pgroup with non-terminal stdin always detaches —
		/// including the first stage of a pipeline. `setsid()` keeps the child
		/// off the host's controlling tty; the spawn path skips
		/// `process_group(...)` for detached children, so later stages no longer
		/// try to `setpgid`-join a leader that has moved sessions (the historical
		/// EPERM hazard).
		#[test]
		fn non_terminal_stdin_detaches_regardless_of_pipeline() {
			assert_eq!(child_session_action(true, false, false), ChildSessionAction::DetachSession,);
			assert_eq!(child_session_action(true, false, true), ChildSessionAction::DetachSession,);
		}

		/// Non-interactive brush, terminal stdin, no pipeline: nothing to do.
		#[test]
		fn non_interactive_with_terminal_stdin_does_nothing() {
			assert_eq!(child_session_action(false, true, false), ChildSessionAction::None,);
		}

		/// Non-interactive brush, terminal stdin, joining a pipeline pgroup:
		/// nothing to do (parent already wired pgroup membership).
		#[test]
		fn non_interactive_terminal_stdin_in_pipeline_does_nothing() {
			assert_eq!(child_session_action(false, true, true), ChildSessionAction::None,);
		}

		/// **Embedded host bug fix.** Non-interactive brush, non-terminal stdin,
		/// no pipeline pgroup: detach so the child cannot SIGTTIN/SIGTTOU the
		/// host. This is the case that regressed before this fix and is the
		/// motivating bug for PR #895.
		#[test]
		fn embedded_host_with_non_terminal_stdin_detaches() {
			assert_eq!(child_session_action(false, false, false), ChildSessionAction::DetachSession,);
		}

		/// **Pipeline tty-safety.** Non-interactive brush, non-terminal stdin
		/// (pipe), and a multi-command pipeline: detach. An interactive child in
		/// a pipeline (`zsh -i ... | awk`) would otherwise open `/dev/tty`,
		/// `tcsetpgrp` itself to the foreground, and leave the host stopped on
		/// its next tty read (`suspended (tty input)`). Each stage gets its own
		/// session instead; the embedded host cancels via the descendant tree,
		/// not a shared pgroup, and pipes are session-independent.
		#[test]
		fn pipeline_stage_with_non_terminal_stdin_detaches() {
			assert_eq!(child_session_action(false, false, true), ChildSessionAction::DetachSession,);
		}
	}

	#[cfg(unix)]
	fn shell_test_lock() -> &'static TokioMutex<()> {
		static LOCK: std::sync::OnceLock<TokioMutex<()>> = std::sync::OnceLock::new();
		LOCK.get_or_init(|| TokioMutex::new(()))
	}

	#[cfg(unix)]
	async fn run_command_capture(
		command: &str,
		cwd: Option<&std::path::Path>,
		minimizer: Option<minimizer::MinimizerOptions>,
		cancel_token: CancelToken,
	) -> (ShellExecuteResult, String) {
		let _guard = shell_test_lock().lock().await;
		let (tx, rx) = flume::unbounded::<String>();
		let options = ShellExecuteOptions {
			command: command.to_string(),
			cwd: cwd.map(|path| path.to_string_lossy().into_owned()),
			minimizer,
			..Default::default()
		};
		let result = execute_shell(options, Some(tx), cancel_token)
			.await
			.expect("execute_shell");
		let mut output = String::new();
		while let Ok(chunk) = rx.recv_async().await {
			output.push_str(&chunk);
		}
		(result, output)
	}

	#[cfg(unix)]
	fn unique_temp_dir(prefix: &str) -> std::path::PathBuf {
		let mut path = std::env::temp_dir();
		let nonce = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.expect("system time")
			.as_nanos();
		path.push(format!("pi-shell-{prefix}-{}-{nonce}", std::process::id()));
		std::fs::create_dir_all(&path).expect("create temp dir");
		path
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn uutils_diff_reads_process_substitution_fds() {
		let (result, output) = time::timeout(
			Duration::from_secs(5),
			run_command_capture("diff <(echo a) <(echo b)", None, None, CancelToken::default()),
		)
		.await
		.expect("process substitution should not hang");

		assert_eq!(result.exit_code, Some(1));
		assert!(output.contains("-a\n+b\n"), "diff output missing changed lines: {output:?}");
	}

	#[cfg(unix)]
	fn printf_minimizer(
		settings_path: &std::path::Path,
		max_capture_bytes: Option<u32>,
	) -> minimizer::MinimizerOptions {
		std::fs::write(
			settings_path,
			r#"
schema_version = 1

[filters.printf]
match_command = "^printf$"
replace = [{ pattern = "hello", replacement = "HI" }]
"#,
		)
		.expect("write settings");
		minimizer::MinimizerOptions {
			enabled: Some(true),
			settings_path: Some(settings_path.to_string_lossy().into_owned()),
			max_capture_bytes,
			..Default::default()
		}
	}

	/// `live_background_job_count` reports 0 when the session has no live
	/// external background jobs and 1 while one is running. The host relies on
	/// this to retain a per-call shell whose `&`/`nohup` child is still alive
	/// instead of dropping it (which would SIGKILL the child via kill-on-drop).
	/// Path-qualified `/bin/sleep` is used so it spawns a real external process
	/// (the bare `sleep` builtin runs in-process and is intentionally not
	/// counted).
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn live_background_job_count_tracks_external_background_jobs() {
		let _guard = shell_test_lock().lock().await;
		let shell = Shell::new(None);

		// No session core materialized yet.
		assert_eq!(shell.live_background_job_count().await, 0);

		// A foreground-only command leaves nothing in the background.
		shell
			.run(
				ShellRunOptions { command: "true".into(), ..Default::default() },
				None,
				CancelToken::default(),
			)
			.await
			.expect("run true");
		assert_eq!(shell.live_background_job_count().await, 0);

		// An external background process is tracked while it runs.
		shell
			.run(
				ShellRunOptions { command: "/bin/sleep 30 &".into(), ..Default::default() },
				None,
				CancelToken::default(),
			)
			.await
			.expect("run sleep");
		assert_eq!(shell.live_background_job_count().await, 1);

		// Dropping the shell at scope end reaps the child via kill-on-drop.
		shell.abort().await;
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn segmented_false_and_printf_skips_second_and_returns_nonzero() {
		let root = unique_temp_dir("false-and");
		let minimizer = printf_minimizer(&root.join("minimizer.toml"), None);
		let (result, output) = run_command_capture(
			"false && printf skipped",
			None,
			Some(minimizer),
			CancelToken::default(),
		)
		.await;
		let _ = std::fs::remove_dir_all(&root);
		assert_eq!(result.exit_code, Some(1));
		assert!(!result.cancelled);
		assert!(!result.timed_out);
		assert_eq!(output, "");
		// `false && printf` short-circuits: nothing is rewritten, so a no-op chain
		// must surface no minimizer telemetry (None).
		assert!(result.minimized.is_none(), "chain noop must not surface telemetry");
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn segmented_false_semicolon_printf_continues_and_returns_last_code() {
		let root = unique_temp_dir("false-semi");
		let minimizer = printf_minimizer(&root.join("minimizer.toml"), None);
		let (result, output) = run_command_capture(
			"false ; printf 'hello\n'",
			None,
			Some(minimizer),
			CancelToken::default(),
		)
		.await;
		let _ = std::fs::remove_dir_all(&root);
		let minimized = result.minimized.expect("minimized result");
		assert_eq!(result.exit_code, Some(0));
		assert_eq!(output, "hello\n");
		assert_eq!(minimized.filter, "chain");
		assert_eq!(minimized.original_text, "hello\n");
		assert_eq!(minimized.text, "HI\n");
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn segmented_cd_tmp_and_pwd_persists_state_across_segments() {
		let root = unique_temp_dir("cwd");
		let tmp_dir = root.join("tmp");
		std::fs::create_dir_all(&tmp_dir).expect("create nested tmp dir");
		let settings_path = root.join("minimizer.toml");
		std::fs::write(
			&settings_path,
			r#"
schema_version = 1

[filters.pwd]
match_command = "^pwd$"
replace = [{ pattern = "^.+$", replacement = "PWD" }]
"#,
		)
		.expect("write settings");
		let minimizer = minimizer::MinimizerOptions {
			enabled: Some(true),
			settings_path: Some(settings_path.to_string_lossy().into_owned()),
			..Default::default()
		};

		let expected = format!("{}\n", tmp_dir.display());
		let (result, output) =
			run_command_capture("cd tmp && pwd", Some(&root), Some(minimizer), CancelToken::default())
				.await;
		let _ = std::fs::remove_dir_all(&root);
		let minimized = result.minimized.expect("minimized result");
		assert_eq!(result.exit_code, Some(0));
		assert_eq!(output, expected);
		assert_eq!(minimized.filter, "chain");
		assert_eq!(minimized.text, "PWD\n");
		assert_eq!(minimized.original_text, expected);
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn whole_command_exceeding_capture_cap_streams_raw_without_minimized() {
		let root = unique_temp_dir("whole-cap");
		let minimizer = printf_minimizer(&root.join("minimizer.toml"), Some(1024));
		let (result, output) =
			run_command_capture("printf '%1200s' x", None, Some(minimizer), CancelToken::default())
				.await;
		let _ = std::fs::remove_dir_all(&root);
		assert_eq!(result.exit_code, Some(0));
		assert_eq!(output.len(), 1200);
		assert!(output.ends_with('x'));
		// Output exceeded the capture cap: streamed raw and never buffered, so
		// nothing was minimized. `minimized` must be absent (not a `too-large`
		// result with empty `text`, which would mislead presence-keyed consumers).
		assert!(result.minimized.is_none());
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn segmented_printf_chain_preserves_raw_original_text() {
		let root = unique_temp_dir("minimizer");
		let minimizer = printf_minimizer(&root.join("minimizer.toml"), None);
		let (result, output) = run_command_capture(
			"printf 'hello\n' ; printf 'world\n'",
			None,
			Some(minimizer),
			CancelToken::default(),
		)
		.await;
		let _ = std::fs::remove_dir_all(&root);
		let minimized = result.minimized.expect("minimized result");
		assert_eq!(result.exit_code, Some(0));
		assert_eq!(output, "hello\nworld\n");
		assert_eq!(minimized.filter, "chain");
		assert_eq!(minimized.original_text, "hello\nworld\n");
		assert_eq!(minimized.text, "HI\nworld\n");
		assert_eq!(minimized.input_bytes, 12);
		assert_eq!(minimized.output_bytes, 9);
	}

	/// Regression: a quoted here-doc followed by another command must execute
	/// instead of failing with "unterminated here document". The minimizer's
	/// segmented runner used to rebuild each segment via the brush AST Display
	/// impl, which re-emitted the `<<'PY'` close tag as the quoted `'PY'` — an
	/// invalid delimiter that left the body unterminated. Here-doc-bearing
	/// commands now bail out of segmentation and run whole via the single path.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn quoted_heredoc_in_chain_runs_via_single_path() {
		let root = unique_temp_dir("heredoc-chain");
		let minimizer = printf_minimizer(&root.join("minimizer.toml"), None);
		let (result, output) = run_command_capture(
			"/bin/cat <<'PY'\nhello $USER\nPY\nprintf 'after\\n'",
			None,
			Some(minimizer),
			CancelToken::default(),
		)
		.await;
		let _ = std::fs::remove_dir_all(&root);
		assert_eq!(result.exit_code, Some(0));
		// Quoted delimiter keeps the body literal ($USER unexpanded) and the
		// trailing command still runs in order.
		assert_eq!(output, "hello $USER\nafter\n");
		assert!(!output.contains("unterminated"));
	}

	/// Regression: a `&&` / `;` chain whose later pipeline stage is a compound
	/// command (`while … done`) must execute instead of failing with
	/// "pi-natives:command: syntax error at end of input". The segmented chain
	/// runner rebuilt each segment via the brush AST `Display` impl, but only
	/// validated the *first* pipeline stage — so a compound later stage was
	/// reconstructed without its terminator and re-run as invalid shell. Such a
	/// command now bails out of segmentation and runs whole via the single path.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn compound_stage_in_chain_runs_via_single_path() {
		let root = unique_temp_dir("compound-chain");
		let minimizer = printf_minimizer(&root.join("minimizer.toml"), None);
		let (result, output) = run_command_capture(
			"printf 'start\\n' && seq 5 | while read n; do echo \"n=$n\"; done | head -2",
			None,
			Some(minimizer),
			CancelToken::default(),
		)
		.await;
		let _ = std::fs::remove_dir_all(&root);
		assert_eq!(result.exit_code, Some(0));
		assert_eq!(output, "start\nn=1\nn=2\n");
		assert!(!output.contains("syntax error"));
		// Ran whole (unsegmented), so nothing was minimized.
		assert!(result.minimized.is_none());
	}

	/// A segment that carries a file redirect is still segmented, and the brush
	/// `Display` reconstruction the runner executes must round-trip through
	/// brush's own parser **without losing the redirect**. `echo hidden
	/// >/dev/null` suppresses its own stdout: if the reconstruction dropped the
	/// redirect, `hidden` would leak into the captured output. Proves the
	/// reconstruction path is semantically sound for the redirect-bearing
	/// shapes the per-stage whitelist accepts (not just syntactically
	/// parseable).
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn segmented_chain_with_redirect_executes_correctly() {
		let root = unique_temp_dir("redirect-chain");
		let minimizer = printf_minimizer(&root.join("minimizer.toml"), None);
		let (result, output) = run_command_capture(
			"echo hidden >/dev/null && printf 'hello\\n'",
			None,
			Some(minimizer),
			CancelToken::default(),
		)
		.await;
		let _ = std::fs::remove_dir_all(&root);
		assert_eq!(result.exit_code, Some(0));
		// The redirect survived reconstruction: segment 1's stdout went to
		// /dev/null, so only segment 2's output is captured.
		assert!(!output.contains("hidden"), "redirect must suppress segment-1 stdout");
		assert_eq!(output, "hello\n");
		let minimized = result
			.minimized
			.expect("redirect chain should be minimized");
		assert_eq!(minimized.original_text, "hello\n");
		assert_eq!(minimized.text, "HI\n");
		assert!(!output.contains("syntax error"));
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn segmented_chain_exceeding_aggregate_capture_cap_stays_raw() {
		let root = unique_temp_dir("aggregate-cap");
		let minimizer = printf_minimizer(&root.join("minimizer.toml"), Some(1024));
		let (result, output) = run_command_capture(
			"printf '%600s' x ; printf '%600s' y",
			None,
			Some(minimizer),
			CancelToken::default(),
		)
		.await;
		let _ = std::fs::remove_dir_all(&root);
		assert_eq!(result.exit_code, Some(0));
		assert_eq!(output.len(), 1200);
		assert!(output.ends_with('y'));
		// Aggregate cap exceeded: the chain streamed its output raw and was not
		// minimized, so `minimized` is absent (not an empty-text `too-large`).
		assert!(result.minimized.is_none());
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn segmented_timeout_in_first_segment_prevents_later_segments() {
		let root = unique_temp_dir("timeout");
		let minimizer = printf_minimizer(&root.join("minimizer.toml"), None);
		let (result, output) = run_command_capture(
			"sleep 1 && printf later",
			None,
			Some(minimizer),
			CancelToken::new(Some(10)),
		)
		.await;
		let _ = std::fs::remove_dir_all(&root);
		assert!(result.exit_code.is_none());
		assert!(!result.cancelled);
		assert!(result.timed_out);
		assert!(result.minimized.is_none());
		assert!(!output.contains("later"));
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn segmented_cancel_in_first_segment_prevents_later_segments() {
		let root = unique_temp_dir("cancel");
		let minimizer = printf_minimizer(&root.join("minimizer.toml"), None);
		let mut cancel_token = CancelToken::default();
		let abort_token = cancel_token.emplace_abort_token();
		let cancel_task = tokio::spawn(async move {
			time::sleep(Duration::from_millis(10)).await;
			abort_token.abort(AbortReason::Signal);
		});
		let (result, output) =
			run_command_capture("sleep 1 && printf later", None, Some(minimizer), cancel_token).await;
		let _ = cancel_task.await;
		let _ = std::fs::remove_dir_all(&root);
		assert!(result.exit_code.is_none());
		assert!(result.cancelled);
		assert!(!result.timed_out);
		assert!(result.minimized.is_none());
		assert!(!output.contains("later"));
	}
	/// End-to-end verification that brush, when embedded as a non-interactive
	/// library (`interactive: false`, exactly what `create_session` produces),
	/// spawns external commands in a **separate session** from the host.
	///
	/// The truth-table tests in `child_session_action` cover the decision in
	/// isolation. This test covers the wiring: it boots a real `BrushShell`,
	/// runs a child that prints its PID then sleeps, and asks the kernel for
	/// that PID's session via `getsid(2)` while the child is still alive.
	/// Pre-fix (`new_pg=false` skipped `detach_session`), the child inherited
	/// the host's session, so `getsid(child_pid) == getsid(0)`. Post-fix,
	/// `setsid` ran and the child is its own session leader
	/// (`getsid(child_pid) == child_pid`).
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn embedded_external_command_runs_in_its_own_session() {
		use std::io::Read as _;

		// SAFETY: `getsid(0)` only queries the current process session; the return
		// value is checked. Inside a PID namespace (the containerized CI runner)
		// the host's session leader can live outside the namespace, so `getsid(0)`
		// legitimately reports 0 — only -1 is a real failure. The child-session
		// invariants below (own session, distinct from host) stay meaningful.
		let host_sid = unsafe { libc::getsid(0) };
		assert!(host_sid >= 0, "getsid(0) failed: {}", std::io::Error::last_os_error());

		// Build the same kind of session pi-natives uses in production.
		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");

		// Output pipe shared between the brush child and a concurrent reader. The
		// reader runs on a blocking thread because `os_pipe` reads are blocking.
		let (mut reader, writer) = pipe_to_files("e2e").expect("pipe");
		let stdout_file = OpenFile::from(writer.try_clone().expect("clone"));
		let stderr_file = OpenFile::from(writer);

		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null stdin"));
		params.set_fd(OpenFiles::STDOUT_FD, stdout_file);
		params.set_fd(OpenFiles::STDERR_FD, stderr_file);

		// (pid_tx, pid_rx) — reader task signals the test as soon as it has the PID.
		let (pid_tx, pid_rx) = tokio::sync::oneshot::channel::<i32>();
		let reader_handle = tokio::task::spawn_blocking(move || {
			let mut buf = Vec::new();
			// Read just enough to capture the PID line. The child sleeps after
			// printing so the pipe will not back-pressure.
			let mut chunk = [0u8; 64];
			let mut pid_tx = Some(pid_tx);
			while let Ok(n) = reader.read(&mut chunk)
				&& n > 0
			{
				buf.extend_from_slice(&chunk[..n]);
				if pid_tx.is_some()
					&& let Some(line_end) = buf.iter().position(|&byte| byte == b'\n')
					&& let Ok(line) = std::str::from_utf8(&buf[..line_end])
					&& let Ok(pid) = line.trim().parse::<i32>()
				{
					let _ = pid_tx
						.take()
						.expect("pid sender should be present")
						.send(pid);
				}
			}
			buf
		});

		// Run brush in the background so we can call `getsid(child_pid)` while
		// the child is still alive.
		let shell_handle = tokio::spawn(async move {
			let source_info = SourceInfo::from("pi-natives:test");
			// `printf '%d\n' "$$"` then `sleep 0.5`. Long enough for our `getsid`.
			let exec = session
				.shell
				.run_string("/bin/sh -c 'printf \"%d\\n\" \"$$\"; sleep 0.5'", &source_info, &params)
				.await
				.expect("run_string");
			drop(params);
			(session, exec)
		});

		let child_pid = time::timeout(Duration::from_secs(5), pid_rx)
			.await
			.expect("timed out waiting for child PID")
			.expect("reader closed pid channel without sending");
		assert!(child_pid > 0, "got non-positive child pid: {child_pid}");

		// Snapshot the child's session ID immediately, while the child is still
		// in `sleep`. POSIX guarantees `getsid` against a live PID returns the
		// session of that process.
		// SAFETY: `child_pid` is a positive PID from the child; errors are reported via
		// the checked return value.
		let child_sid = unsafe { libc::getsid(child_pid) };
		assert!(
			child_sid > 0,
			"getsid({child_pid}) failed: {} (child may have already exited)",
			std::io::Error::last_os_error(),
		);

		// Drain the brush task and the pipe reader.
		let (_session, exec) = time::timeout(Duration::from_secs(5), shell_handle)
			.await
			.expect("shell timed out")
			.expect("shell task panicked");
		assert!(
			matches!(exec.exit_code, ExecutionExitCode::Success),
			"unexpected exit: {}",
			exit_code(&exec),
		);
		let _ = time::timeout(Duration::from_secs(2), reader_handle).await;

		assert_ne!(
			child_sid, host_sid,
			"child PID {child_pid} inherited host session {host_sid}; setsid() did not run — the \
			 embedded-host bug is back",
		);
		assert_eq!(
			child_sid, child_pid,
			"child PID {child_pid} should be its own session leader after setsid",
		);
	}

	/// Cancelling one `Shell::run` must only signal processes spawned by that
	/// run. Run B starts first so its old host-descendant baseline would not
	/// include run A's later-spawned child; pre-fix, cancelling B classified A's
	/// child as "new" and SIGTERM'd it, so run A returned 143 instead of 0.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn cancelling_one_run_spares_a_concurrent_runs_child() {
		let _guard = shell_test_lock().lock().await;

		let shell_b = Shell::new(None);
		let (tx_b, rx_b) = flume::unbounded::<String>();
		let mut ct_b = CancelToken::default();
		let abort_b = ct_b.emplace_abort_token();
		let handle_b = tokio::spawn(async move {
			shell_b
				.run(
					ShellRunOptions {
						command: "/bin/sh -c 'printf \"ready\\n\"; sleep 30'".into(),
						..Default::default()
					},
					Some(tx_b),
					ct_b,
				)
				.await
		});

		let mut b_output = String::new();
		let b_ready = time::timeout(Duration::from_secs(5), async {
			loop {
				let chunk = rx_b
					.recv_async()
					.await
					.expect("run B ended before printing readiness");
				b_output.push_str(&chunk);
				if let Some(line_end) = b_output.find('\n') {
					return b_output[..line_end].to_string();
				}
			}
		})
		.await
		.expect("timed out waiting for run B readiness");
		assert_eq!(b_ready.trim(), "ready", "run B should reach its long sleep before run A starts");

		let shell_a = Shell::new(None);
		let (tx_a, rx_a) = flume::unbounded::<String>();
		let handle_a = tokio::spawn(async move {
			shell_a
				.run(
					ShellRunOptions {
						command: "/bin/sh -c 'printf \"%d\\n\" \"$$\"; sleep 2'".into(),
						..Default::default()
					},
					Some(tx_a),
					CancelToken::default(),
				)
				.await
		});

		let mut a_output = String::new();
		let a_child_pid = time::timeout(Duration::from_secs(5), async {
			loop {
				let chunk = rx_a
					.recv_async()
					.await
					.expect("run A ended before printing its child pid");
				a_output.push_str(&chunk);
				if let Some(line_end) = a_output.find('\n') {
					return a_output[..line_end]
						.trim()
						.parse::<i32>()
						.expect("run A pid line should be an integer");
				}
			}
		})
		.await
		.expect("timed out waiting for run A child pid");
		assert!(a_child_pid > 0, "got non-positive run A child pid: {a_child_pid}");

		abort_b.abort(AbortReason::Signal);

		let result_a = time::timeout(Duration::from_secs(10), handle_a)
			.await
			.expect("run A timed out")
			.expect("run A task panicked")
			.expect("run A failed");
		let result_b = time::timeout(Duration::from_secs(10), handle_b)
			.await
			.expect("run B timed out")
			.expect("run B task panicked")
			.expect("run B failed");

		assert_eq!(result_a.exit_code, Some(0), "cancelling run B must not SIGTERM run A's child");
		assert!(!result_a.cancelled, "run A was never cancelled");
		assert!(result_b.cancelled, "run B should report cancellation");
	}

	/// Cancelling while `Shell::run` is still sourcing a snapshot must terminate
	/// the foreground process spawned by that snapshot. The snapshot runs before
	/// the user command, so this specifically guards the shared cancel token and
	/// spawn registry wiring passed into `source_snapshot`.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn cancelling_while_sourcing_snapshot_kills_snapshot_foreground_child() {
		let _guard = shell_test_lock().lock().await;
		let root = unique_temp_dir("snapshot-cancel");
		let snapshot_path = root.join("snapshot.sh");
		let pid_path = root.join("snapshot-child.pid");
		let escaped_pid_path = pid_path.to_string_lossy().replace('\'', "'\\''");
		std::fs::write(
			&snapshot_path,
			format!(
				"/bin/sh -c 'printf \"%d\\n\" \"$$\" > \"$1\"; sleep 30' sh '{escaped_pid_path}'\n"
			),
		)
		.expect("write snapshot file");

		let shell = Shell::new(Some(ShellOptions {
			snapshot_path: Some(snapshot_path.to_string_lossy().into_owned()),
			..Default::default()
		}));
		let mut cancel_token = CancelToken::default();
		let abort_token = cancel_token.emplace_abort_token();
		let run_handle = tokio::spawn(async move {
			shell
				.run(
					ShellRunOptions { command: "printf done".into(), ..Default::default() },
					None,
					cancel_token,
				)
				.await
		});

		let child_pid = time::timeout(Duration::from_secs(5), async {
			loop {
				if let Ok(pid_text) = std::fs::read_to_string(&pid_path)
					&& let Ok(pid) = pid_text.trim().parse::<i32>()
					&& pid > 0
				{
					return pid;
				}
				time::sleep(Duration::from_millis(20)).await;
			}
		})
		.await
		.expect("timed out waiting for snapshot foreground child to write its positive PID");

		abort_token.abort(AbortReason::Signal);

		let result = time::timeout(Duration::from_secs(10), run_handle)
			.await
			.expect("timed out waiting for cancellation while sourcing snapshot")
			.expect("snapshot sourcing run task panicked")
			.expect("shell run failed while cancelling snapshot sourcing");
		assert!(result.cancelled, "cancelling while sourcing a snapshot should report cancellation");
		assert_eq!(
			result.exit_code, None,
			"cancelled snapshot sourcing run should not report an exit code"
		);
		assert!(
			!result.timed_out,
			"signal cancellation during snapshot sourcing must not report timeout"
		);

		let child_dead = time::timeout(Duration::from_secs(5), async {
			loop {
				// SAFETY: `child_pid` came from the foreground `/bin/sh` spawned by the
				// snapshot; `kill(pid, 0)` only probes whether that process still exists.
				let kill_result = unsafe { libc::kill(child_pid, 0) };
				if kill_result == -1 {
					let err = std::io::Error::last_os_error();
					if err.raw_os_error() == Some(libc::ESRCH) {
						return;
					}
					panic!(
						"kill({child_pid}, 0) failed with unexpected error while checking snapshot \
						 child cleanup: {err}"
					);
				}
				time::sleep(Duration::from_millis(20)).await;
			}
		})
		.await;
		let _ = std::fs::remove_dir_all(&root);
		assert!(
			child_dead.is_ok(),
			"snapshot foreground child PID {child_pid} was still alive after cancelling while \
			 sourcing snapshot; cancel bridge did not terminate the snapshot-spawned process"
		);
	}

	/// Regression for the `suspended (tty input)` bug: an **interactive child
	/// inside a pipeline** (`zsh -i ... | awk`) used to stay in the host
	/// session, open `/dev/tty`, `tcsetpgrp` itself to the foreground, and
	/// leave the embedded host (OMP) stopped on its next tty read. The earlier
	/// embedded-host fix carved pipelines out of `detach_session` because a
	/// later stage that `setpgid`-joined a detached leader failed with EPERM.
	///
	/// This test boots a real embedded `BrushShell` and runs a two-stage
	/// pipeline whose first stage prints its PID then sleeps (forwarded to us
	/// by `cat`). It asserts two contracts at once:
	///   1. the first stage runs in its **own session** (`getsid == own pid`),
	///      so it can never reach the host's controlling tty — guards the
	///      decision; and
	///   2. the pipeline still exits **successfully**, proving the second stage
	///      spawned without the cross-session `setpgid` EPERM — guards the
	///      wiring that skips `process_group(...)` for detached children.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn embedded_pipeline_stage_runs_in_its_own_session() {
		use std::io::Read as _;

		// SAFETY: `getsid(0)` only queries the current process session; checked
		// below. In a PID namespace (containerized CI) the host's session leader
		// can live outside the namespace, so `getsid(0)` reports 0, not an error;
		// only -1 is a real failure.
		let host_sid = unsafe { libc::getsid(0) };
		assert!(host_sid >= 0, "getsid(0) failed: {}", std::io::Error::last_os_error());

		let config = ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = create_session(&config).await.expect("create_session");

		let (mut reader, writer) = pipe_to_files("e2e-pipe").expect("pipe");
		let stdout_file = OpenFile::from(writer.try_clone().expect("clone"));
		let stderr_file = OpenFile::from(writer);

		let mut params = session.shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, null_file().expect("null stdin"));
		params.set_fd(OpenFiles::STDOUT_FD, stdout_file);
		params.set_fd(OpenFiles::STDERR_FD, stderr_file);

		let (pid_tx, pid_rx) = tokio::sync::oneshot::channel::<i32>();
		let reader_handle = tokio::task::spawn_blocking(move || {
			let mut buf = Vec::new();
			let mut chunk = [0u8; 64];
			let mut pid_tx = Some(pid_tx);
			while let Ok(n) = reader.read(&mut chunk)
				&& n > 0
			{
				buf.extend_from_slice(&chunk[..n]);
				if pid_tx.is_some()
					&& let Some(line_end) = buf.iter().position(|&byte| byte == b'\n')
					&& let Ok(line) = std::str::from_utf8(&buf[..line_end])
					&& let Ok(pid) = line.trim().parse::<i32>()
				{
					let _ = pid_tx
						.take()
						.expect("pid sender should be present")
						.send(pid);
				}
			}
			buf
		});

		let shell_handle = tokio::spawn(async move {
			let source_info = SourceInfo::from("pi-natives:test");
			// First stage prints its own PID and sleeps; `cat` forwards the PID
			// line to our reader and exits on EOF. The first stage leads the
			// pipeline's process group, the second (`cat`) is the join-or-detach
			// stage that would EPERM without the wiring fix.
			let exec = session
				.shell
				.run_string(
					"/bin/sh -c 'printf \"%d\\n\" \"$$\"; sleep 1' | /bin/cat",
					&source_info,
					&params,
				)
				.await
				.expect("run_string");
			drop(params);
			(session, exec)
		});

		let child_pid = time::timeout(Duration::from_secs(5), pid_rx)
			.await
			.expect("timed out waiting for first-stage PID")
			.expect("reader closed pid channel without sending");
		assert!(child_pid > 0, "got non-positive child pid: {child_pid}");

		// SAFETY: `child_pid` is a live positive PID (still in `sleep`); the return
		// value is checked.
		let child_sid = unsafe { libc::getsid(child_pid) };
		assert!(
			child_sid > 0,
			"getsid({child_pid}) failed: {} (child may have already exited)",
			std::io::Error::last_os_error(),
		);

		let (_session, exec) = time::timeout(Duration::from_secs(5), shell_handle)
			.await
			.expect("shell timed out")
			.expect("shell task panicked");
		// Guards the wiring: the second stage spawned without a cross-session
		// `setpgid` EPERM, so the whole pipeline succeeded.
		assert!(
			matches!(exec.exit_code, ExecutionExitCode::Success),
			"pipeline did not succeed (second stage may have hit setpgid EPERM): {}",
			exit_code(&exec),
		);
		let _ = time::timeout(Duration::from_secs(2), reader_handle).await;

		// Guards the decision: a pipeline stage must not share the host session,
		// or it could seize the controlling tty and SIGTTIN the host.
		assert_ne!(
			child_sid, host_sid,
			"pipeline stage PID {child_pid} inherited host session {host_sid}; it could seize the \
			 controlling tty — the pipeline tty-suspend bug is back",
		);
		assert_eq!(
			child_sid, child_pid,
			"pipeline stage PID {child_pid} should be its own session leader after setsid",
		);
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn wait_accepts_last_background_process_id() {
		let options = ShellExecuteOptions {
			command: "/bin/sh -c 'exit 7' & mover=$!; wait \"$mover\"".to_string(),
			..Default::default()
		};

		let result = execute_shell(options, None, CancelToken::default())
			.await
			.expect("execute should succeed");

		assert_eq!(result.exit_code, Some(7));
		assert!(!result.cancelled);
		assert!(!result.timed_out);
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn wait_n_p_records_completed_process_id() {
		let options = ShellExecuteOptions {
			command: "/bin/sh -c 'sleep 0.2; exit 42' & slow=$!; /bin/sh -c 'exit 13' & fast=$!; \
			          wait -n -p hit \"$slow\" \"$fast\"; status=$?; wait \"$slow\"; [ \"$status\" \
			          -eq 13 ] && [ \"$hit\" = \"$fast\" ]"
				.to_string(),
			..Default::default()
		};

		let result = execute_shell(options, None, CancelToken::default())
			.await
			.expect("execute should succeed");

		assert_eq!(result.exit_code, Some(0));
		assert!(!result.cancelled);
		assert!(!result.timed_out);
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn wait_f_accepts_process_id() {
		let options = ShellExecuteOptions {
			command: "/bin/sh -c 'exit 5' & child=$!; wait -f \"$child\"".to_string(),
			..Default::default()
		};

		let result = execute_shell(options, None, CancelToken::default())
			.await
			.expect("execute should succeed");

		assert_eq!(result.exit_code, Some(5));
		assert!(!result.cancelled);
		assert!(!result.timed_out);
	}
	#[tokio::test]
	async fn abort_state_signals_cancel_token() {
		let abort_state = ShellAbortState::default();
		let mut cancel_token = CancelToken::default();
		let abort_token = cancel_token.emplace_abort_token();

		abort_state.set(abort_token).await;
		abort_state.abort().await;

		let reason = time::timeout(Duration::from_millis(100), cancel_token.wait())
			.await
			.expect("cancel token should be signalled");
		assert!(matches!(reason, AbortReason::Signal));
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn read_output_stops_when_cancelled_before_pipe_eof() {
		let (reader, _writer) = pipe_to_files("test").expect("test pipe should be created");
		let cancel = CancellationToken::new();
		let (activity_tx, _activity_rx) = flume::bounded(1);
		let handle = tokio::spawn(read_output(reader, None, cancel.clone(), activity_tx));

		time::sleep(Duration::from_millis(10)).await;
		cancel.cancel();

		time::timeout(Duration::from_millis(100), handle)
			.await
			.expect("reader task should stop after cancellation")
			.expect("reader task should not panic");
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn execute_shell_streams_separates_stdout_and_stderr() {
		let (stdout_tx, stdout_rx) = flume::unbounded::<Bytes>();
		let (stderr_tx, stderr_rx) = flume::unbounded::<Bytes>();
		let options = ShellExecuteOptions {
			command: "echo out; echo err 1>&2".to_string(),
			..Default::default()
		};
		let streams = StreamSinks { stdout: Some(stdout_tx), stderr: Some(stderr_tx) };
		let result = execute_shell_streams(options, streams, CancelToken::default())
			.await
			.expect("execute should succeed");
		assert_eq!(result.exit_code, Some(0));
		assert!(!result.cancelled);

		let mut stdout = Vec::new();
		while let Ok(chunk) = stdout_rx.recv_async().await {
			stdout.extend_from_slice(&chunk);
		}
		let mut stderr = Vec::new();
		while let Ok(chunk) = stderr_rx.recv_async().await {
			stderr.extend_from_slice(&chunk);
		}
		assert_eq!(stdout, b"out\n");
		assert_eq!(stderr, b"err\n");
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn execute_shell_streams_works_when_sinks_are_none() {
		// Both sinks `None` — pipes must still drain so the child can exit.
		let options = ShellExecuteOptions {
			command: "yes done | head -n 100 1>&2; echo final".to_string(),
			..Default::default()
		};
		let result = execute_shell_streams(options, StreamSinks::default(), CancelToken::default())
			.await
			.expect("execute should succeed");
		assert_eq!(result.exit_code, Some(0));
	}

	/// Brush expands `$env:NAME` against the `env` shell variable by default,
	/// collapsing PowerShell references like `Write-Host $env:OMPCODE` to
	/// `:OMPCODE`. The session-level fallback below defines `env=$env` so the
	/// expansion is the literal `$env:OMPCODE`, preserving the PowerShell
	/// token when the command is forwarded to a child shell.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn powershell_env_reference_survives_brush_expansion() {
		let (tx, rx) = flume::unbounded::<Bytes>();
		let options = ShellExecuteOptions {
			command: "printf '%s' \"$env:SystemRoot\"".to_string(),
			..Default::default()
		};
		let streams = StreamSinks { stdout: Some(tx), stderr: None };
		let result = execute_shell_streams(options, streams, CancelToken::default())
			.await
			.expect("execute should succeed");
		assert_eq!(result.exit_code, Some(0));

		let mut stdout = Vec::new();
		while let Ok(chunk) = rx.recv_async().await {
			stdout.extend_from_slice(&chunk);
		}
		assert_eq!(stdout, b"$env:SystemRoot");
	}

	/// A user assignment to `env` in the command itself must shadow the
	/// session-level fallback so callers that genuinely use a POSIX variable
	/// named `env` see their value, not the literal `$env`.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn user_env_assignment_shadows_powershell_fallback() {
		let (tx, rx) = flume::unbounded::<Bytes>();
		let options = ShellExecuteOptions {
			command: "env=prod; printf '%s' \"$env:8080\"".to_string(),
			..Default::default()
		};
		let streams = StreamSinks { stdout: Some(tx), stderr: None };
		let result = execute_shell_streams(options, streams, CancelToken::default())
			.await
			.expect("execute should succeed");
		assert_eq!(result.exit_code, Some(0));

		let mut stdout = Vec::new();
		while let Ok(chunk) = rx.recv_async().await {
			stdout.extend_from_slice(&chunk);
		}
		assert_eq!(stdout, b"prod:8080");
	}

	/// Quoted heredoc delimiters at EOF must behave like bash. `brush-parser`
	/// currently rejects that shape unless the input stream ends with a newline,
	/// which surfaced as `unterminated here document sequence; tag(s) [...]` for
	/// normal paste-run Python snippets.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn quoted_heredoc_without_trailing_newline_runs() {
		let (result, output) = run_command_capture(
			"/bin/cat <<'PY'\nhello $USER\nPY",
			None,
			None,
			CancelToken::default(),
		)
		.await;

		assert_eq!(result.exit_code, Some(0));
		assert_eq!(output, "hello $USER\n");
	}

	/// Regression for a Windows/macOS deadlock in
	/// `brush_core::interp::setup_open_file_with_contents`. The body is
	/// 256 KiB — well past the default pipe buffer on every platform
	/// (Windows ~4 KiB, macOS 16-64 KiB, Linux 64 KiB), so any inline
	/// `write_all` on the calling thread blocks forever. The `:` builtin
	/// never reads its stdin, so the only way `echo done` runs is if the
	/// heredoc writer is decoupled from the main thread (or, on Linux,
	/// the pipe buffer was grown via `F_SETPIPE_SZ`). The
	/// `tokio::time::timeout` is the safety net that turns a regression
	/// into a 10 s failure instead of hanging CI for the full
	/// hard-timeout window.
	#[tokio::test(flavor = "multi_thread")]
	async fn large_heredoc_does_not_deadlock() {
		let body = "X".repeat(256 * 1024);
		let command = format!(": <<'EOF'\n{body}\nEOF\necho done");
		let options = ShellExecuteOptions { command, ..Default::default() };

		let result = time::timeout(
			Duration::from_secs(10),
			execute_shell(options, None, CancelToken::default()),
		)
		.await
		.expect("execute_shell hung past 10 s — heredoc writer deadlocked")
		.expect("execute_shell errored");

		assert_eq!(result.exit_code, Some(0), "command did not run to completion");
	}

	/// The `nohup` builtin runs its operand command and surfaces that command's
	/// own exit status — not nohup's (`125`/`126`/`127`) error codes.
	#[tokio::test(flavor = "multi_thread")]
	async fn nohup_builtin_propagates_command_exit_code() {
		let command = if cfg!(windows) {
			"nohup cmd /C exit 7"
		} else {
			"nohup /bin/sh -c 'exit 7'"
		};
		let options = ShellExecuteOptions { command: command.to_string(), ..Default::default() };
		let result = execute_shell(options, None, CancelToken::default())
			.await
			.expect("execute should succeed");
		assert_eq!(result.exit_code, Some(7));
		assert!(!result.cancelled);
		assert!(!result.timed_out);
	}

	/// `nohup` is a no-op builtin in this embedded shell, but `nohup cmd &`
	/// must still behave like a process-launching background command for `$!`.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn nohup_background_captures_operand_pid() {
		let (tx, rx) = flume::unbounded::<String>();
		let options = ShellExecuteOptions {
			command: "nohup /bin/sh -c 'exit 0' >/dev/null 2>&1 & pid=$!; printf 'pid=%s\n' \
			          \"$pid\"; test -n \"$pid\""
				.to_string(),
			..Default::default()
		};
		let result = execute_shell(options, Some(tx), CancelToken::default())
			.await
			.expect("execute should succeed");
		assert_eq!(result.exit_code, Some(0));
		assert!(!result.cancelled);
		assert!(!result.timed_out);

		let mut out = String::new();
		while let Ok(chunk) = rx.recv_async().await {
			out.push_str(&chunk);
		}
		let pid = out
			.trim()
			.strip_prefix("pid=")
			.expect("nohup background PID output should include pid= prefix");
		assert!(pid.parse::<i32>().is_ok_and(|pid| pid > 0), "invalid PID output: {out:?}");
	}

	/// `nohup` with no operand mirrors coreutils: a `missing operand` diagnostic
	/// and exit code 125 (a nohup-level error, distinct from any command code).
	#[tokio::test(flavor = "multi_thread")]
	async fn nohup_builtin_without_command_reports_missing_operand() {
		let (tx, rx) = flume::unbounded::<String>();
		let options = ShellExecuteOptions { command: "nohup".to_string(), ..Default::default() };
		let result = execute_shell(options, Some(tx), CancelToken::default())
			.await
			.expect("execute should succeed");
		assert_eq!(result.exit_code, Some(125));
		let mut out = String::new();
		while let Ok(chunk) = rx.recv_async().await {
			out.push_str(&chunk);
		}
		assert!(
			out.contains("missing operand"),
			"expected a missing-operand diagnostic, got: {out:?}"
		);
	}

	/// The contract that makes this a *builtin* and not the external tool: the
	/// child must **not** inherit `SIGHUP = SIG_IGN`. Real `nohup` masks SIGHUP
	/// (and it survives `exec`), so a process launched through `/usr/bin/nohup`
	/// reports `IGN` here; the builtin runs the command as an ordinary
	/// descendant, so it reports `DFL` and dies with the host on hangup. The
	/// probe needs `getsid`-style signal introspection, so it is gated on
	/// `python3` (skipped, not failed, when absent — matching the embedded
	/// session-detach e2e suite).
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn nohup_builtin_does_not_mask_sighup() {
		let python_ok = std::process::Command::new("python3")
			.arg("-c")
			.arg("pass")
			.stdout(std::process::Stdio::null())
			.stderr(std::process::Stdio::null())
			.status()
			.is_ok_and(|status| status.success());
		if !python_ok {
			eprintln!("skipping nohup_builtin_does_not_mask_sighup: python3 unavailable");
			return;
		}

		let probe = "import signal,sys; sys.stdout.write('IGN' if \
		             signal.getsignal(signal.SIGHUP)==signal.SIG_IGN else 'DFL')";
		let (tx, rx) = flume::unbounded::<String>();
		let options = ShellExecuteOptions {
			command: format!("nohup python3 -c \"{probe}\""),
			..Default::default()
		};
		let result = execute_shell(options, Some(tx), CancelToken::default())
			.await
			.expect("execute should succeed");
		assert_eq!(result.exit_code, Some(0));
		let mut out = String::new();
		while let Ok(chunk) = rx.recv_async().await {
			out.push_str(&chunk);
		}
		assert!(
			out.contains("DFL") && !out.contains("IGN"),
			"builtin nohup masked SIGHUP like the external tool (output: {out:?})",
		);
	}

	/// Regression for #4078: the JS bridge hands the pipe readers a *bounded*
	/// chunk channel. With a consumer slower than the producer the readers
	/// must park on `send_async` (backpressuring the child through its pipe)
	/// rather than buffer unboundedly — and, unlike a drop-on-full design,
	/// every produced byte must still reach the consumer.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn streaming_output_backpressures_on_bounded_channel_without_loss() {
		const TOTAL_BYTES: usize = 1_048_576;
		let (tx, rx) = flume::bounded::<String>(4);
		let options = ShellExecuteOptions {
			command: format!("yes x | head -c {TOTAL_BYTES}"),
			..Default::default()
		};
		let run = tokio::spawn(execute_shell(options, Some(tx), CancelToken::default()));

		let mut received = 0usize;
		while let Ok(chunk) = rx.recv_async().await {
			received += chunk.len();
			// Slow consumer: forces the bounded queue to fill and the readers
			// to park between chunks.
			time::sleep(Duration::from_micros(50)).await;
		}

		let result = time::timeout(Duration::from_secs(30), run)
			.await
			.expect("command should finish despite backpressure")
			.expect("run task should not panic")
			.expect("execute should succeed");
		assert_eq!(result.exit_code, Some(0));
		assert!(!result.cancelled);
		assert!(!result.timed_out);
		assert_eq!(received, TOTAL_BYTES, "streamed bytes were dropped under backpressure");
	}
}
