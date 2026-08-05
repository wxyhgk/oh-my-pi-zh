const BAR_WIDTH = 16;

/** Minimal output contract used by the interactive cleanse progress reporter. */
export interface CleanseProgressOutput {
	isTTY?: boolean;
	write(text: string): boolean;
}

/** Renders completed repair workers on one transient terminal line. */
export interface CleanseProgressReporter {
	readonly interactive: boolean;
	start(total: number): void;
	complete(): void;
	finish(): void;
}

/** Create the TTY-only worker completion reporter used by `omp cleanse`. */
export function createCleanseProgressReporter(output: CleanseProgressOutput = process.stdout): CleanseProgressReporter {
	const interactive = output.isTTY === true;
	let total = 0;
	let completed = 0;
	let rendered = false;

	const render = (): void => {
		if (!interactive || total === 0) return;
		const ratio = Math.min(completed / total, 1);
		const filled = Math.round(ratio * BAR_WIDTH);
		const bar = `${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}`;
		output.write(`\r修复中 [${bar}] ${completed}/${total}\x1b[K`);
		rendered = true;
	};

	return {
		interactive,
		start(nextTotal) {
			total = Math.max(nextTotal, 0);
			completed = 0;
			render();
		},
		complete() {
			completed = Math.min(completed + 1, total);
			render();
		},
		finish() {
			if (!rendered) return;
			output.write("\n");
			rendered = false;
		},
	};
}
