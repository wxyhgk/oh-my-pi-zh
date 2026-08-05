/**
 * TTS/STT Submit Trigger options and evaluation logic.
 */

export const STT_SUBMIT_TRIGGER_VALUES = ["never", "release", "release-complete", "say-submit"] as const;

export type SttSubmitTrigger = (typeof STT_SUBMIT_TRIGGER_VALUES)[number];

export const STT_SUBMIT_TRIGGER_OPTIONS = [
	{
		value: "never",
		label: "从不",
		description: "绝不自动提交;插入听写文本并停留在编辑器中。",
	},
	{
		value: "release",
		label: "松手提交",
		description: "松手时提交,若话语包含 2 个及以上单词,以避免误发送。",
	},
	{
		value: "release-complete",
		label: "松手且句子完整时提交",
		description: "松手时提交,若话语以句末标点(. ? ! 等)结尾。",
	},
	{
		value: "say-submit",
		label: "说出 Submit 时提交",
		description: "若话语以包含“submit”的单词结尾则提交(提交前会去掉该词)。",
	},
] satisfies ReadonlyArray<{ value: SttSubmitTrigger; label: string; description: string }>;

/**
 * Evaluate the submit trigger against a transcribed utterance.
 * Returns whether to submit, and the number of characters to trim from the end of the utterance.
 */
export function evaluateSubmitTrigger(
	utterance: string,
	trigger: SttSubmitTrigger,
): { submit: boolean; trimTrailing: number } {
	const trimmed = utterance.trim();
	if (!trimmed) {
		return { submit: false, trimTrailing: 0 };
	}

	if (trigger === "never") {
		return { submit: false, trimTrailing: 0 };
	}

	if (trigger === "release") {
		// Split by whitespace and count words
		const words = trimmed.split(/\s+/).filter(Boolean);
		const submit = words.length >= 2;
		return { submit, trimTrailing: 0 };
	}

	if (trigger === "release-complete") {
		// Matches typical sentence terminators: . ? ! ... or full-width equivalents, optionally followed by space
		const hasTerminalPunctuation = /[.?!…。？！]\s*$/.test(trimmed);
		return { submit: hasTerminalPunctuation, trimTrailing: 0 };
	}

	if (trigger === "say-submit") {
		// Matches space followed by any word containing "submit" (case-insensitive), optionally followed by punctuation/spaces
		// Also handles the case where "submit" is the only word in the utterance (no leading space)
		const match = utterance.match(/(?:^|\s+)(\S*submit\S*)[.?!…。？！]*\s*$/i);
		if (match && match.index !== undefined) {
			const trimTrailing = utterance.length - match.index;
			return { submit: true, trimTrailing };
		}
		return { submit: false, trimTrailing: 0 };
	}

	return { submit: false, trimTrailing: 0 };
}
