import * as crypto from "node:crypto";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, ImageContent, Message, TextContent } from "@oh-my-pi/pi-ai";
import type { SessionContext } from "../session/session-context";
import { compileSecretRegex } from "./regex";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface SecretEntry {
	type: "plain" | "regex";
	content: string;
	mode?: "obfuscate" | "replace";
	replacement?: string;
	flags?: string;
	friendlyName?: string;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined };
export type JsonRecord = { [key: string]: JsonValue | undefined };

// ═══════════════════════════════════════════════════════════════════════════
// Deterministic replacement generation
// ═══════════════════════════════════════════════════════════════════════════

const REPLACEMENT_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const NONMATCHING_REPLACEMENT_CHARS = `${REPLACEMENT_CHARS}!#$%&()*+,-./:;<=>?@[]^_{|}~`;
// Whitespace bytes used to build last-resort redactions for a default replace
// regex that matches every non-whitespace candidate (e.g. `\S{n}`). Only
// `space`/`tab` are used — never a line terminator — so a `.`-style
// match-everything regex (which matches space and tab but not `\n`) still
// exhausts to the sentinel instead of redacting to a newline run.
const WHITESPACE_REPLACEMENT_CHARS = " \t";

/** Generate a deterministic same-length replacement string from a secret value. */
function generateDeterministicReplacement(secret: string): string {
	if (secret.length === 0) return "";
	// Prefix generated chunks with a fixed `ZZ` so re-redacting an already-emitted
	// 1–2 char chunk is a fixed point (the deterministic replacement of a <=2-char
	// value is itself `Z`/`ZZ`), keeping short default-replacement remainders next
	// to a reversible placeholder stable across an obfuscator restart.
	const hash = BigInt(Bun.hash(secret));
	const chars = secret.length === 1 ? ["Z"] : ["Z", "Z"];
	let h = hash;
	for (let i = chars.length; i < secret.length; i++) {
		h = h ^ (BigInt(i + 1) * 0x9e3779b97f4a7c15n);
		const idx = Number((h < 0n ? -h : h) % BigInt(REPLACEMENT_CHARS.length));
		chars.push(REPLACEMENT_CHARS[idx]);
	}
	return chars.join("");
}

/**
 * Force a length-preserving deterministic replacement to differ from the secret
 * it stands in for. `generateDeterministicReplacement` seeds its first 1–2 chars
 * with the `Z`/`ZZ` sentinel, so a whole configured value that is exactly `Z` or
 * `ZZ` (or an astronomically unlikely longer hash collision) would otherwise be
 * emitted unchanged and ship the raw secret to the provider. Flip the first char
 * to a fixed different glyph: same length, still deterministic, guaranteed != the
 * secret. Only safe for a whole CONFIGURED value (a plain secret matches its own
 * literal, so the perturbed output is no longer matched and stays a fixed point);
 * per-chunk remainders must keep the sentinel to remain idempotent across restart.
 */
function ensureDistinctReplacement(replacement: string, secret: string): string {
	if (replacement.length === 0 || replacement !== secret) return replacement;
	const alt = replacement[0] === REPLACEMENT_CHARS[0] ? REPLACEMENT_CHARS[1] : REPLACEMENT_CHARS[0];
	return alt + replacement.slice(1);
}

// How far left of the matched span the re-match scan begins looking for a match
// that overlaps the candidate. This bounds ONLY the match-start search position,
// never the lookbehind/lookahead context: the probe below substitutes the
// candidate into the FULL text, so a regex's lookbehind/lookahead assertions
// always evaluate against complete context regardless of width. The single
// re-match this misses is one that begins more than this many bytes before the
// span and extends into it (a single match longer than the window) — that only
// churns the chosen redaction marker between candidates, never back to the raw
// matched value, so it cannot leak a secret.
const REGEX_REMATCH_BACKSCAN = 512;

interface RegexMatchContext {
	/** Full text the match was found in (positions are offsets into it). */
	text: string;
	/** Start/end of the matched span being replaced. */
	start: number;
	end: number;
}

/**
 * Whether `candidate`, substituted for the matched span in its surrounding text,
 * is re-matched by `regex` at its own position. A replace-mode regex that depends
 * on context (lookbehind/lookahead/`\b`) can match a candidate that does NOT match
 * in isolation: e.g. `(?<=api=)[AZ]` never matches a bare `A`, but `api=A` does, so
 * a candidate `A` chosen by an isolation test is re-redacted on the next obfuscate()
 * pass and can oscillate back to the raw matched value. The probe substitutes the
 * candidate into the FULL text — not a truncated window — so a wide lookbehind or
 * lookahead (e.g. `(?<=A{600})`) still evaluates against the context that makes it
 * match. Truncating that context dropped the assertion's reach and falsely
 * accepted an oscillating, leaky candidate. The scan starts a bounded distance
 * left of the span and stops once a match begins at/after the span's end (matches
 * arrive in order), keeping per-candidate cost independent of total text length.
 */
function regexRematchesInContext(candidate: string, regex: RegExp, ctx: RegexMatchContext): boolean {
	const probe = ctx.text.slice(0, ctx.start) + candidate + ctx.text.slice(ctx.end);
	const spanStart = ctx.start;
	const spanEnd = spanStart + candidate.length;
	regex.lastIndex = Math.max(0, spanStart - REGEX_REMATCH_BACKSCAN);
	for (let m = regex.exec(probe); m !== null; m = regex.exec(probe)) {
		const matchStart = m.index;
		const matchEnd = m.index + m[0].length;
		// Matches arrive in increasing position; once one starts at or past the
		// span's end it cannot cover the candidate, and neither can any later one.
		if (matchStart >= spanEnd) break;
		// A match overlapping the candidate's own bytes means those bytes get
		// re-redacted on a later pass — not a fixed point.
		if (matchEnd > spanStart) return true;
		// Zero-width matches do not advance lastIndex; step past to avoid a loop.
		if (m[0].length === 0) regex.lastIndex++;
	}
	return false;
}

/**
 * Search same-length replacements for one the regex does NOT match, so a default
 * regex secret whose deterministic replacement collides with its own value (the
 * `Z`/`ZZ` sentinel, or an astronomical hash collision) is still redacted to a
 * STABLE nonmatching value instead of shipping the raw secret. A nonmatching
 * candidate is a fixed point under re-obfuscation — the regex never re-matches it,
 * so it cannot re-leak on a later pass. The search stays bounded to O(length *
 * alphabet) regardless of value length: first exhaust every single-position
 * substitution against a deterministic baseline (`AAAA…`, then `!AAA…`, `A!AA…`,
 * …) so any regex that only needs one out-of-class byte — regardless of position —
 * is found in a handful of probes rather than enumerating every combination (which
 * for a 3-byte match-everything config, e.g. `[\s\S]{3}`, would otherwise run
 * 90**3 = 729000 candidates through the regex on every single match, stalling
 * provider requests). Candidates are enumerated deterministically over a stable
 * ASCII alphabet: alphanumerics first (usually enough), then punctuation fallback
 * bytes when the regex covers every alphanumeric candidate. When the regex still
 * matches around a lone perturbed byte (for example `[A-Za-z0-9].*` matching the
 * unperturbed tail), full-width same-byte candidates (`!!!!!`, `_____`, …) are
 * tried next. When the regex covers every non-whitespace candidate (e.g. `\S{n}`),
 * whitespace markers (a full space/tab run, then a single whitespace byte among
 * non-whitespace filler) are tried as a last resort. A genuine match-everything
 * regex (`.`/`[\s\S]`, which also matches space and tab) still exhausts this bounded
 * sweep and returns undefined, letting the caller keep its own fixed-point fallback
 * — bounded search can in principle miss an escape that depends jointly on
 * multiple positions in a way no single-position swap reaches, but no realistic
 * secret-redaction regex (character classes, literal matches, anchored/bounded
 * repeats) has that shape.
 */
function findNonMatchingReplacement(value: string, regex: RegExp, context: RegexMatchContext): string | undefined {
	const len = value.length;
	if (len === 0) return undefined;
	// Exhaust every single-position substitution against the deterministic baseline
	// first (covers the common case cheaply), then fall back to full-width same-byte
	// candidates for a regex that only rejects a lone perturbed byte in context.
	const baseline = NONMATCHING_REPLACEMENT_CHARS[0].repeat(len);
	for (let position = 0; position < len; position++) {
		for (const ch of NONMATCHING_REPLACEMENT_CHARS) {
			const candidate = `${baseline.slice(0, position)}${ch}${baseline.slice(position + 1)}`;
			if (candidate === value) continue;
			if (!regexRematchesInContext(candidate, regex, context)) return candidate;
		}
	}
	// If the regex can still match around a lone punctuation byte (for example
	// `[A-Za-z0-9].*` matching the `AAAA` tail of `!AAAA`), try full-width
	// same-byte fallbacks like `!!!!!`, `_____`, etc. before giving up.
	for (const ch of NONMATCHING_REPLACEMENT_CHARS) {
		const candidate = ch.repeat(len);
		if (candidate === value) continue;
		if (!regexRematchesInContext(candidate, regex, context)) return candidate;
	}
	return findWhitespaceFallbackReplacement(value, regex, context);
}

/**
 * Last-resort fallback for a default replace regex that matches every
 * non-whitespace candidate. Builds same-length whitespace markers the regex
 * cannot match: first a full space/tab run (handles `\S`-class patterns), then a
 * single whitespace byte among non-whitespace filler (` AAAA`, `A AAA`, …). The
 * mixed marker defeats regexes that ALSO match all-space/all-tab runs, e.g.
 * `(?:\S{n}| {n}|\t{n})`, because the lone whitespace byte breaks every
 * fixed-length run. A genuine match-everything regex (`.`/`[\s\S]`) matches the
 * filler and the whitespace alike, so this still returns undefined there, keeping
 * the caller's sentinel as the sole fixed point.
 */
function findWhitespaceFallbackReplacement(
	value: string,
	regex: RegExp,
	context: RegexMatchContext,
): string | undefined {
	const len = value.length;
	const filler = NONMATCHING_REPLACEMENT_CHARS[0];
	for (const ws of WHITESPACE_REPLACEMENT_CHARS) {
		const full = ws.repeat(len);
		if (full !== value) {
			if (!regexRematchesInContext(full, regex, context)) return full;
		}
		for (let pos = 0; pos < len; pos++) {
			const candidate = `${filler.repeat(pos)}${ws}${filler.repeat(len - pos - 1)}`;
			if (candidate === value) continue;
			if (!regexRematchesInContext(candidate, regex, context)) return candidate;
		}
	}
	return undefined;
}

/**
 * Whether a default (no custom `replacement`) replace-mode regex can never
 * safely redact a 1-2 char match: `findNonMatchingReplacement`'s bounded
 * search — the same search `#generateRegexReplacement` runs at match time —
 * finds no candidate the regex fails to re-match. This holds independent of
 * any actual per-install key: the search already exhausts every character in
 * `REPLACEMENT_CHARS` (the alphabet `buildKeyedReplacementRun` draws its
 * fallback marker from) plus punctuation and whitespace, so if none of those
 * escape the regex, no key-derived marker drawn from the same alphabet can
 * either — the marker is guaranteed to re-match too, making every such match
 * unresolvable: the fallback could only ever emit the raw matched text
 * unchanged. Probed with a value (`"\0".repeat(length)`) the bounded search
 * never treats as a real candidate, so the result depends only on the
 * regex's own matching behavior, not on this specific probe.
 */
export function regexHasUnresolvableShortMatchFallback(regex: RegExp): boolean {
	return ([1, 2] as const).some(length => {
		const probe = "\u0000".repeat(length);
		const savedLastIndex = regex.lastIndex;
		try {
			return findNonMatchingReplacement(probe, regex, { text: probe, start: 0, end: length }) === undefined;
		} finally {
			regex.lastIndex = savedLastIndex;
		}
	});
}

// ═══════════════════════════════════════════════════════════════════════════
// Placeholder format
// ═══════════════════════════════════════════════════════════════════════════

const HASH_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
// Base length is sized for ~62 bits of entropy (64 bits of a keyed digest
// rendered as 12 base36 chars) so unrelated secrets do not collide on a shared
// base. A collision would let a persisted placeholder deobfuscate to the wrong
// secret when the configured secret set or its ordering changes across sessions.
const HASH_LEN = 12;
const MAX_FRIENDLY_NAME_LEN = 32;
// Plain/regex obfuscate matches shorter than this are toned down (never placed
// behind a reversible placeholder) to avoid redacting small words/fragments.
export const MIN_OBFUSCATE_SECRET_LEN = 8;

// Per-process fallback key used when a caller does not supply a persisted
// per-install key. It is random (never shipped in source), so model-visible
// placeholders cannot be reversed by dictionary-hashing candidate secrets; it
// only forgoes cross-session token stability, which the persisted key provides.
let ephemeralPlaceholderKey: string | undefined;
function defaultPlaceholderKey(): string {
	ephemeralPlaceholderKey ??= crypto.randomBytes(32).toString("base64url");
	return ephemeralPlaceholderKey;
}

type PlaceholderCaseHint = "U" | "L" | "C" | "M";

/** Normalize a friendly name into the model-visible placeholder prefix. */
export function sanitizeSecretFriendlyName(name: string): string | undefined {
	const sanitized = name
		.replace(/[^A-Za-z0-9]/g, "")
		.toUpperCase()
		.slice(0, MAX_FRIENDLY_NAME_LEN);
	return sanitized.length > 0 ? sanitized : undefined;
}

/**
 * Normalize a secret value into the same alnum-only, uppercased shape a
 * friendly-name label or placeholder prefix is sanitized into, so comparing a
 * raw (possibly lowercase/punctuated) secret value against already-sanitized,
 * model-visible text does not miss a case- or separator-only variant. Unlike
 * `sanitizeSecretFriendlyName` this never truncates and never signals "empty"
 * via `undefined` — callers already guard on `.length > 0` before comparing.
 */
function sanitizeForCollisionCheck(value: string): string {
	return value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

// A label leaks a secret either by containing the whole normalized secret or,
// once it reaches the public display cap, by being the secret's visible prefix.
// Shorter names like "TOKEN" can still be intentional generic labels.
function sanitizedLabelCollidesWithSecret(sanitizedLabel: string, sanitizedSecret: string): boolean {
	if (sanitizedSecret.length === 0) return false;
	if (sanitizedLabel.includes(sanitizedSecret)) return true;
	return sanitizedLabel.length >= MAX_FRIENDLY_NAME_LEN && sanitizedSecret.startsWith(sanitizedLabel);
}

/**
 * Whether an entry needs the persisted placeholder key: either because it can
 * produce a reversible (keyed) obfuscate-mode placeholder, or because a default
 * (no custom `replacement`) replace-mode regex can reach
 * `#generateRegexReplacement`'s key-derived idempotent fallback marker (see
 * `#generateReplacement`) when every same-length candidate re-matches a
 * pathological match-everything config (e.g. `[\s\S]{8}`). That fallback depends
 * on the persisted per-install key — not just length — to stay a fixed point
 * across a process restart; without a persisted key, a fresh install falls back
 * to a process-random key (`defaultPlaceholderKey()`), so the fallback marker
 * would churn across restarts even though the algorithm itself is stable. A
 * regex WITH a custom `replacement` never reaches that fallback (it always emits
 * the literal configured string), and a plain replace secret's replacement is
 * pure content-hash (`#generateSecretReplacement`), so neither needs the key.
 * Short plain obfuscate entries are toned down (never placeheld), so they must
 * NOT force key creation: otherwise a `secret-placeholder.key` file is written
 * and persisted for a config that ends up with no active secrets, leaving the
 * key readable via a tool and reusable for later placeholders.
 */
export function secretEntryNeedsPlaceholderKey(entry: SecretEntry): boolean {
	if ((entry.mode ?? "obfuscate") === "obfuscate") {
		if (entry.type === "regex") return true;
		return entry.content.length >= MIN_OBFUSCATE_SECRET_LEN;
	}
	return entry.type === "regex" && entry.replacement === undefined;
}

/**
 * Whether a plain replace-mode replacement string can contribute a fragment that
 * helps the replace phase reconstruct an obfuscate `content`. During obfuscate()'s
 * replace phase the output is a tiling of passthrough bytes (adversary-controlled
 * provider text) and whole replacement outputs; any contiguous occurrence of
 * `content` in that output is covered by interior replacement tiles (each a
 * substring of `content`) bordered by passthrough at the ends, where the border
 * tile may be a suffix of a replacement (forming `content`'s prefix) or a prefix
 * of a replacement (forming `content`'s suffix). An EMPTY replacement deletes its
 * trigger entirely, joining the passthrough on both sides; with adversary-chosen
 * surrounding bytes that can form any non-empty `content` across the deleted gap.
 * So a replacement can help iff it is empty, is a substring of `content`,
 * contains `content`, or shares such a border overlap.
 */
function replacementCanFormContent(replacement: string, content: string): boolean {
	if (replacement.length === 0) return content.length > 0;
	if (content.includes(replacement) || replacement.includes(content)) return true;
	const maxOverlap = Math.min(replacement.length, content.length);
	for (let k = 1; k <= maxOverlap; k++) {
		// A suffix of the replacement forms the prefix of the content (left border),
		// or a prefix of the replacement forms the suffix of the content (right border).
		if (content.startsWith(replacement.slice(replacement.length - k)) || content.endsWith(replacement.slice(0, k))) {
			return true;
		}
	}
	return false;
}

/**
 * Whether a SET of entries needs the persisted placeholder key. `obfuscate()`
 * applies plain replace-mode mappings before the plain-obfuscate pass, so a plain
 * obfuscate entry only emits a reversible (keyed) placeholder when its content can
 * still appear AFTER the replace phase. When no obfuscate entry can ever produce a
 * placeholder, the persisted key must NOT be required/created — otherwise an
 * effectively replace-only secret set still writes `secret-placeholder.key` and
 * fails startup when the agent config dir is unwritable.
 *
 * The decision models the replace phase as the obfuscator actually runs it:
 * replace mappings are content-keyed (later duplicate wins) and applied in
 * descending content-length order; for a fresh probe (no prior placeholders) that
 * phase is plain sequential substring replacement. A plain obfuscate entry needs
 * the key when its content survives that simulated phase (direct typing) OR when
 * any effective replacement can form the content via tiling — a substring,
 * wholesale superstring, or prefix/suffix border that joins with surrounding
 * passthrough bytes (see `replacementCanFormContent`). This covers direct
 * shadowing (`SECRET -> safe`), reintroduction, duplicate ordering, transitive
 * chains, and context-joined fragments uniformly. Default (omitted) replacements
 * are deterministic, length-preserving, and distinct, so a same-content shadow
 * with no other interacting replacement stays key-free.
 * Replacement outputs are themselves rewritten by every later (shorter-content)
 * replacement before the plain-obfuscate pass sees them, so a fragment that a
 * subsequent replacement erases (`AA -> SEC` then `S -> X` turns every `SEC` into
 * `XEC`) no longer forces the key. Surrounding bytes stay modeled as arbitrary
 * passthrough, so testing the surviving fragment only drops false positives and
 * never under-approximates a real key need.
 */
export function secretEntriesNeedPlaceholderKey(entries: SecretEntry[]): boolean {
	const replaceMap = new Map<string, string>();
	for (const entry of entries) {
		if (entry.type !== "plain" || (entry.mode ?? "obfuscate") !== "replace") continue;
		replaceMap.set(
			entry.content,
			entry.replacement ?? ensureDistinctReplacement(generateDeterministicReplacement(entry.content), entry.content),
		);
	}
	const replacePhase = [...replaceMap].sort((a, b) => b[0].length - a[0].length);
	// Apply the replace phase from `start` onward. The phase runs in descending
	// content-length order, so a replacement output emitted at index i is rewritten
	// only by the later (shorter-content) replacements at i+1…; `start` 0 models a
	// value typed directly into the input.
	const applyReplacePhaseFrom = (text: string, start: number): string => {
		let result = text;
		for (let i = start; i < replacePhase.length; i++) {
			result = result.split(replacePhase[i][0]).join(replacePhase[i][1]);
		}
		return result;
	};
	return entries.some(entry => {
		if (!secretEntryNeedsPlaceholderKey(entry)) return false;
		// Regex obfuscate entries match dynamically; conservatively require the key.
		if (entry.type !== "plain") return true;
		const content = entry.content;
		if (applyReplacePhaseFrom(content, 0).includes(content)) return true;
		// Test each replacement output in the form it SURVIVES the rest of the phase,
		// so a fragment a later replacement erases no longer forces the key. The
		// content it tiles into must also survive those later replacements: if a
		// shorter-content replacement rewrites the surrounding passthrough bytes
		// (e.g. `AA -> SEC` forms `SEC`+`RET12`, then `R -> X` turns the freshly
		// formed `SECRET12` into `SECXET12`), the content can never reach the
		// obfuscate pass, so the key is not needed. Requiring content stability only
		// drops such false positives — a formation that genuinely survives is still
		// caught at the replacement index that produces it.
		return replacePhase.some(
			([, replacement], i) =>
				applyReplacePhaseFrom(content, i + 1) === content &&
				replacementCanFormContent(applyReplacePhaseFrom(replacement, i + 1), content),
		);
	});
}

// Derive the model-visible base from a KEYED digest of the secret. xxHash is
// fast and unkeyed, so a fixed-seed content hash of a low-entropy secret could
// be dictionaried from the transcript; HMAC-SHA256 under a private per-install
// key cannot, since the attacker lacks the key.
function buildHashBase(key: string, value: string): string {
	const digest = new Bun.CryptoHasher("sha256", key).update(value).digest();
	let v = 0n;
	for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(digest[i]);
	const radix = BigInt(HASH_CHARS.length);
	let tag = "";
	for (let i = 0; i < HASH_LEN; i++) {
		tag += HASH_CHARS[Number(v % radix)];
		v /= radix;
	}
	return tag;
}

// Build a deterministic, key-derived run of REPLACEMENT_CHARS of the given
// length. Used to redact a per-chunk replace remainder to a marker that depends
// only on the per-install key and the remainder length, so a fresh obfuscator
// reproduces the identical marker (idempotent redaction across restarts) while
// the run stays unpredictable without the key (raw sentinel-shaped bytes cannot
// equal the marker, so they are still redacted rather than passed through).
function buildKeyedReplacementRun(key: string, length: number): string {
	if (length <= 0) return "";
	const radix = REPLACEMENT_CHARS.length;
	let out = "";
	for (let block = 0; out.length < length; block++) {
		const digest = new Bun.CryptoHasher("sha256", key).update(`replace-chunk\0${length}\0${block}`).digest();
		for (let i = 0; i < digest.length && out.length < length; i++) {
			out += REPLACEMENT_CHARS[digest[i] % radix];
		}
	}
	return out;
}

function inferCaseHint(secret: string): PlaceholderCaseHint | undefined {
	let hasCased = false;
	let hasUpper = false;
	let hasLower = false;
	let capitalized = true;
	let seenFirstCased = false;

	for (let i = 0; i < secret.length; i++) {
		const code = secret.charCodeAt(i);
		const isUpper = code >= 65 && code <= 90;
		const isLower = code >= 97 && code <= 122;
		if (!isUpper && !isLower) continue;

		hasCased = true;
		if (isUpper) {
			hasUpper = true;
			if (seenFirstCased) capitalized = false;
		} else {
			hasLower = true;
			if (!seenFirstCased) capitalized = false;
		}
		seenFirstCased = true;
	}

	if (!hasCased) return undefined;
	if (hasUpper && !hasLower) return "U";
	if (hasLower && !hasUpper) return "L";
	if (capitalized) return "C";
	return "M";
}

function buildPlaceholder(hint: PlaceholderCaseHint | undefined, base: string, friendlyName?: string): string {
	const prefix = friendlyName ? `${friendlyName}_` : "";
	return hint ? `$$${prefix}${base}:${hint}$$` : `$$${prefix}${base}$$`;
}

/** Regex matching `$$HASH$$`, `$$HASH:U$$`, and `$$FRIENDLY_HASH(:hint)$$` placeholders. */
const PLACEHOLDER_RE = /\$\$(?:[A-Z0-9]+_)?[A-Z0-9]{4,}(?::[ULCM])?\$\$/g;

function resumePlaceholderScanAfterRejectedCandidate(match: RegExpExecArray): void {
	// RegExp#exec does not find overlapping matches. Restart at the rejected
	// candidate's closing delimiter, which can open an immediately adjacent placeholder.
	PLACEHOLDER_RE.lastIndex = match.index + match[0].length - 2;
}

function placeholderWithoutFriendlyName(placeholder: string): string | undefined {
	const match = /^\$\$[A-Z0-9]+_([A-Z0-9]{4,}(?::[ULCM])?)\$\$$/.exec(placeholder);
	return match ? `$$${match[1]}$$` : undefined;
}

function lookupFriendlyPlaceholderAlias(
	deobfuscateMap: ReadonlyMap<string, { secret: string; recursive: boolean }>,
	placeholder: string,
): { secret: string; recursive: boolean } | undefined {
	const direct = deobfuscateMap.get(placeholder);
	if (direct !== undefined) return direct;
	const unprefixed = placeholderWithoutFriendlyName(placeholder);
	return unprefixed !== undefined ? deobfuscateMap.get(unprefixed) : undefined;
}

const PENDING_PLACEHOLDER_SUFFIX_RE = /(?:\$\$(?:[A-Z0-9]+_)?[A-Z0-9]*(?::[ULCM]?)?|\$)$/;

// Withhold a trailing run that could be the start of a placeholder from streamed
// deltas, so a partial token is never emitted before deobfuscation can replace
// it. A lone trailing delimiter character is always buffered because it can open
// a placeholder; the final non-streamed flush re-emits it when no token follows.
export function stripPendingSecretPlaceholderSuffix(text: string): string {
	const pendingPlaceholderStart = text.match(PENDING_PLACEHOLDER_SUFFIX_RE);
	if (pendingPlaceholderStart?.index === undefined) return text;
	return text.slice(0, pendingPlaceholderStart.index);
}

interface RegexScanSegment {
	scanStart: number;
	scanEnd: number;
	textStart: number;
	textEnd: number;
	generatedPlaceholder: boolean;
	recursive: boolean;
}

interface ReplaceRegexScan {
	text: string;
	segments: RegexScanSegment[];
}

// ═══════════════════════════════════════════════════════════════════════════
// SecretObfuscator
// ═══════════════════════════════════════════════════════════════════════════

export class SecretObfuscator {
	/** Plain secrets: secret → index (known at construction) */
	#plainMappings = new Map<string, number>();

	/** Regex entries (patterns compiled at construction) */
	#regexEntries: Array<{ regex: RegExp; mode: "obfuscate" | "replace"; replacement?: string; friendlyName?: string }> =
		[];

	/** All obfuscate-mode mappings: index → { secret, placeholder } */
	#obfuscateMappings = new Map<number, { secret: string; placeholder: string }>();

	/** Replace-mode plain mappings: secret → replacement */
	#replaceMappings = new Map<string, string>();

	/** Reverse lookup for LIVE deobfuscation (provider output, tool-call args):
	 *  keyed placeholder → secret plus recursion policy. Only placeholders this
	 *  obfuscator generated under the per-install key (and their friendly-name-
	 *  independent aliases) live here, so a prompt-injected model cannot synthesize
	 *  one without the key. */
	#deobfuscateMap = new Map<string, { secret: string; recursive: boolean }>();

	/** Exact placeholder tokens generated by this obfuscator revision (no aliases). */
	#generatedPlaceholders = new Set<string>();

	/** Deterministic replace chunks emitted by this obfuscator, used to keep re-obfuscation idempotent. */
	#generatedReplaceChunks = new Set<string>();

	/** Every configured plain-secret literal value (both obfuscate and replace
	 *  mode), collected before any placeholder is minted. A generated placeholder
	 *  must never equal one of these — otherwise a later-processed secret whose
	 *  raw value happens to equal an earlier secret's placeholder would be
	 *  indistinguishable from that placeholder on the NEXT obfuscate() pass (its
	 *  own plain-secret redaction already ran, sorted by length, before the
	 *  placeholder existed) and would survive verbatim in provider-visible text. */
	#configuredSecretValues = new Set<string>();

	/** Regex values seen in the current obfuscate input, used to keep friendly labels from exposing normalized matches that are discovered later in the same pass. */
	#currentRegexSecretValues = new Set<string>();

	/** Placeholder base-key (exact value for :M, case-folded otherwise) → base hash. */
	#placeholderBaseByKey = new Map<string, string>();

	/** Placeholder base hash → owner key, used to avoid ambiguous placeholders. */
	#placeholderBaseOwners = new Map<string, string>();

	/** Next available index for regex match discoveries */
	#nextIndex: number;

	/** Whether any secrets were configured */
	#hasAny: boolean;

	/**
	 * Private per-install (or per-process) key for the keyed placeholder digest.
	 * Resolved lazily when the constructor received a key PROVIDER: the first
	 * placeholder mint or keyed fallback marker triggers resolution, so callers
	 * can defer persisting `secret-placeholder.key` until a dynamic regex entry
	 * actually matches session content.
	 */
	#key: string | undefined;
	#keyProvider: (() => string) | undefined;

	constructor(entries: SecretEntry[], key: string | (() => string) = defaultPlaceholderKey()) {
		if (typeof key === "function") {
			this.#keyProvider = key;
		} else {
			this.#setPlaceholderKey(key);
		}
		// Collect every configured plain-secret literal AND compile every regex
		// entry BEFORE minting any placeholder below, so a placeholder's friendly
		// name (checked against both in `#createPlaceholder`) can never embed a
		// LATER entry's raw value or regex coverage, regardless of entries[]
		// order — same reasoning as the base-collision guard below, extended to
		// the friendly-name collision guard.
		for (const entry of entries) {
			if (entry.type === "plain") {
				this.#configuredSecretValues.add(entry.content);
				continue;
			}
			try {
				const regex = compileSecretRegex(entry.content, entry.flags);
				const mode = entry.mode ?? "obfuscate";
				// A default (no custom `replacement`) replace-mode regex that can
				// never redact a 1-2 char match distinctly from itself (see
				// `regexHasUnresolvableShortMatchFallback`) is dropped rather than
				// risk a real secret round-tripping unredacted; `secrets/index.ts`
				// warns loudly for the `secrets.yml`-loaded path — this is the
				// silent backstop for direct construction.
				if (
					mode === "replace" &&
					entry.replacement === undefined &&
					regexHasUnresolvableShortMatchFallback(regex)
				) {
					continue;
				}
				this.#regexEntries.push({
					regex,
					mode,
					replacement: entry.replacement,
					friendlyName: entry.friendlyName,
				});
			} catch {
				// Invalid regex — skip silently (validation happens at load time)
			}
		}
		let index = 0;
		let hasRealSec = this.#regexEntries.length > 0;
		for (const entry of entries) {
			if (entry.type !== "plain") continue;
			const mode = entry.mode ?? "obfuscate";
			if (mode === "obfuscate") {
				if (entry.content.length < MIN_OBFUSCATE_SECRET_LEN) {
					// Tone down short plain secret obfuscation to avoid false matches on small words like "esp".
					continue;
				}
				const placeholder = this.#createPlaceholder(entry.content, entry.friendlyName);
				this.#plainMappings.set(entry.content, index);
				this.#obfuscateMappings.set(index, { secret: entry.content, placeholder });
				this.#generatedPlaceholders.add(placeholder);
				index++;
				hasRealSec = true;
			} else {
				// replace mode
				const replacement = entry.replacement ?? this.#generateSecretReplacement(entry.content);
				this.#replaceMappings.set(entry.content, replacement);
				hasRealSec = true;
			}
		}

		this.#nextIndex = index;
		this.#hasAny = hasRealSec;
	}

	/**
	 * The keyed-hash key makes obfuscate-mode placeholder bases un-dictionaryable,
	 * but it can be persisted in a user-readable file (`secret-placeholder.key`).
	 * A prompt-injected tool read (read/bash) could otherwise surface it to the
	 * provider verbatim and undo that protection, so redact the key itself from
	 * obfuscated (provider-visible) output as a one-way secret.
	 */
	#setPlaceholderKey(key: string): void {
		this.#key = key;
		this.#replaceMappings.set(key, this.#generateSecretReplacement(key));
		this.#configuredSecretValues.add(key);
	}

	/** Resolve the placeholder key once, minting its self-redaction on first use. */
	#getKey(): string {
		let key = this.#key;
		if (key === undefined) {
			key = this.#keyProvider?.() ?? defaultPlaceholderKey();
			this.#keyProvider = undefined;
			this.#setPlaceholderKey(key);
		}
		return key;
	}

	/** Whether this pass will mint a keyed placeholder from a regex match. */
	#willMintRegexPlaceholder(secretValues: ReadonlySet<string>): boolean {
		for (const entry of this.#regexEntries) {
			if (entry.mode !== "obfuscate") continue;
			for (const value of secretValues) {
				entry.regex.lastIndex = 0;
				const matches = entry.regex.test(value);
				entry.regex.lastIndex = 0;
				if (matches) return true;
			}
		}
		return false;
	}

	hasSecrets(): boolean {
		return this.#hasAny;
	}

	/** Obfuscate all secrets in text. Bidirectional placeholders for obfuscate mode, one-way for replace. */
	obfuscate(text: string, sharedRegexSecretValues?: ReadonlySet<string>): string {
		if (!this.#hasAny) return text;
		this.#currentRegexSecretValues = this.collectRegexSecretValuesForObfuscation(text);
		for (const secretValue of sharedRegexSecretValues ?? []) {
			this.#currentRegexSecretValues.add(secretValue);
		}
		// Resolve a lazy key before the replace phase whenever this pass will mint
		// a regex placeholder. The key registers itself as a replace-mode secret;
		// resolving it later, while processing the regex match, would expose key
		// bytes already present in this same provider-visible input.
		if (this.#keyProvider !== undefined && this.#willMintRegexPlaceholder(this.#currentRegexSecretValues)) {
			this.#getKey();
		}
		let result = text;
		// `origin` runs parallel to `result` (one tag char per result char): "I" for
		// bytes carried from the INPUT (placeholders from a PRIOR obfuscate() call)
		// and "F" for bytes this call freshly inserted. The SDK obfuscates messages
		// in both convertToLlm and transformProviderContext, and prior-turn messages
		// re-enter every turn, so obfuscate() must be a fixed point: a regex must not
		// re-redact around a placeholder that arrived in the input (which would
		// corrupt a prior replacement marker, e.g. REDACTED -> REDACTEDDACTED).
		// Tracking by RANGE (not token value) keeps a fresh placeholder that happens
		// to equal a prior one (same secret seen raw again) eligible for cross-match.
		let origin = "I".repeat(text.length);
		// 1. Process replace-mode plain secrets
		for (const [secret, replacement] of [...this.#replaceMappings].sort((a, b) => b[0].length - a[0].length)) {
			({ text: result, origin } = this.#replaceOutsidePlaceholdersTracked(result, origin, secret, replacement, "I"));
		}
		for (const secretValue of this.#collectRegexSecretValues(result)) {
			this.#currentRegexSecretValues.add(secretValue);
		}
		for (const secretValue of this.#collectRegexSecretValuesAfterRegexReplacements(result, origin)) {
			this.#currentRegexSecretValues.add(secretValue);
		}
		for (const secretValue of sharedRegexSecretValues ?? []) {
			this.#currentRegexSecretValues.add(secretValue);
		}
		({ text: result, origin } = this.#stripUnsafeFriendlyPrefixes(result, origin));

		// 2. Process obfuscate-mode plain secrets
		for (const [secret, index] of [...this.#plainMappings].sort((a, b) => b[0].length - a[0].length)) {
			const mapping = this.#obfuscateMappings.get(index)!;
			({ text: result, origin } = this.#replaceOutsidePlaceholdersTracked(
				result,
				origin,
				secret,
				this.#placeholderForCurrentInput(mapping.placeholder),
				"F",
			));
		}

		// 3. Process regex entries — discover new matches
		for (const entry of this.#regexEntries) {
			entry.regex.lastIndex = 0;
			const matches = this.#collectRegexMatches(result, entry.regex, entry.mode, origin, entry.replacement);

			for (const match of matches) {
				if (entry.mode === "replace") {
					if (match.preserveGeneratedPlaceholders) {
						if (
							match.preserveInputPlaceholders &&
							entry.replacement === undefined &&
							match.inputPlaceholderOutsideChunkCount === 1 &&
							match.inputPlaceholderOutsideStart >= 0 &&
							origin
								.slice(
									match.inputPlaceholderOutsideStart,
									match.inputPlaceholderOutsideStart + match.inputPlaceholderOutside.length,
								)
								.includes("F") &&
							this.#generatedReplaceChunks.has(match.inputPlaceholderOutside)
						) {
							continue;
						}
						// Same greedy-spillover fixed point as the obfuscate branch below: when
						// the match only reached across a prior-call placeholder because the
						// placeholder's own value satisfies the regex, and the surrounding raw
						// bytes do not independently match, re-redacting those bytes drifts the
						// deterministic scramble across passes (e.g. `…#…#ZZJ5sotJ` →
						// `…#…#ZZpvsotJ`), invalidating prompt-cache prefixes despite no new
						// input. Leave the placeholder and its spillover verbatim — a fixed
						// point. Structurally-required bytes (placeholder value alone cannot
						// match) and independently-matching outside chunks still fall through to
						// the redaction below. Only prior-call (`origin "I"`) placeholders set
						// these flags, so first-pass redaction of genuinely new bytes is intact.
						if (
							match.inputPlaceholderInnerIndependentlyMatches &&
							!match.inputPlaceholderOutsideIndependentlyMatches
						) {
							continue;
						}
						let replaceEnd = match.end;
						let span = result.slice(match.start, replaceEnd);
						if (entry.replacement !== undefined) {
							const trailingChunk = trailingOutsidePreservedPlaceholderChunk(span, placeholder =>
								this.#isGeneratedPlaceholder(placeholder),
							);
							if (trailingChunk.length > 0 && entry.replacement.startsWith(trailingChunk)) {
								const trailingSuffix = entry.replacement.slice(trailingChunk.length);
								if (trailingSuffix.length > 0 && result.slice(replaceEnd).startsWith(trailingSuffix)) {
									replaceEnd += trailingSuffix.length;
									span = result.slice(match.start, replaceEnd);
								}
							}
						}
						// A custom replacement is a single redaction marker for the whole
						// match, so emit it once around the preserved placeholder rather
						// than per surrounding chunk (which duplicates it, e.g.
						// `api_key=***#…#api_key=***`). Without one, each surrounding chunk
						// gets its own length-matched fixed-point marker, checked in the
						// expanded scan context so marker bytes cannot re-match beside the
						// preserved placeholder on the next pass. The origin of any placeholder
						// PRESERVED inside `span` must survive verbatim — blanket-tagging the
						// whole redacted span "I" would relabel a same-call-fresh ("F")
						// placeholder as prior-call, wrongly triggering the spillover-skip
						// above for a LATER regex entry over content this call just redacted.
						const spanOrigin = origin.slice(match.start, replaceEnd);
						const redacted =
							entry.replacement !== undefined
								? redactWithFixedReplacementOutsidePlaceholders(
										span,
										spanOrigin,
										entry.replacement,
										placeholder => this.#isGeneratedPlaceholder(placeholder),
									)
								: this.#redactRegexMatchOutsidePlaceholders(span, spanOrigin, entry.regex, match.scanContext);
						result = replaceRange(result, match.start, replaceEnd, redacted.text);
						origin = replaceRange(origin, match.start, replaceEnd, redacted.origin);
					} else {
						const replacement = entry.replacement ?? match.defaultReplacement;
						if (replacement === undefined) {
							throw new Error("正则替换匹配缺少生成的替换内容");
						}
						result = replaceRange(result, match.start, match.end, replacement);
						origin = replaceRange(origin, match.start, match.end, "I".repeat(replacement.length));
					}
				} else {
					if (match.scanMatchLength < MIN_OBFUSCATE_SECRET_LEN) {
						// Tone down short regex matches to avoid obfuscating small
						// words/fragments. Measure the regex's own match length in the
						// canonical (placeholder-expanded) scan view, not the rewritten
						// source span, so the threshold reflects how much content the regex
						// actually matched.
						continue;
					}
					if (match.preserveInputPlaceholders) {
						// The match straddled a prior-call placeholder. When the placeholder's
						// own value already satisfies the regex on its own AND the surrounding
						// raw bytes do not independently match, those bytes are greedy spillover
						// (e.g. the trailing `A` in `SECRETUV→#…#A`): obfuscating them mints
						// fresh placeholders on re-obfuscation and drifts the provider-visible
						// history and prompt-cache prefix. Leave the placeholder atomic and the
						// spillover verbatim — a fixed point. Outside bytes are still obfuscated
						// when the placeholder value alone cannot match (they are structurally
						// part of the secret, e.g. an `api_key=` prefix the regex requires) or
						// when they independently match the regex on their own.
						if (
							match.inputPlaceholderInnerIndependentlyMatches &&
							!match.inputPlaceholderOutsideIndependentlyMatches
						) {
							continue;
						}
						const span = result.slice(match.start, match.end);
						const spanOrigin = origin.slice(match.start, match.end);
						const obfuscated = this.#obfuscateOutsidePlaceholdersTracked(span, spanOrigin, entry.friendlyName);
						result = replaceRange(result, match.start, match.end, obfuscated.text);
						origin = replaceRange(origin, match.start, match.end, obfuscated.origin);
						continue;
					}
					// obfuscate mode — get or create stable index
					let index = this.#findObfuscateIndex(match.canonicalValue);
					if (index === undefined) {
						index = this.#nextIndex++;
						const placeholder = this.#createPlaceholder(
							match.canonicalValue,
							entry.friendlyName,
							match.recursive,
						);
						this.#obfuscateMappings.set(index, { secret: match.canonicalValue, placeholder });
						this.#generatedPlaceholders.add(placeholder);
					}
					const mapping = this.#obfuscateMappings.get(index)!;
					const placeholder = this.#placeholderForCurrentInput(mapping.placeholder);
					result = replaceRange(result, match.start, match.end, placeholder);
					origin = replaceRange(origin, match.start, match.end, "F".repeat(placeholder.length));
				}
			}
			if (entry.mode === "replace") {
				for (const secretValue of this.#collectRegexSecretValues(result)) {
					this.#currentRegexSecretValues.add(secretValue);
				}
			}
		}
		({ text: result, origin } = this.#stabilizeReplaceRegexPlaceholderSpillover(result, origin));

		this.#currentRegexSecretValues = new Set();
		return result;
	}

	/** Deobfuscate keyed placeholders for provider output, tool-call arguments, replay, and display. */
	deobfuscate(text: string): string {
		return this.#deobfuscate(text);
	}

	// Reverse-direction counterpart to `#isGeneratedPlaceholder`'s guard: the
	// bare-alias fallback below intentionally accepts ANY prefix so a
	// placeholder minted under a renamed friendly name still deobfuscates
	// (see `#prefixIsSecretShaped`'s docstring for why), but unconditionally
	// stripping and ignoring an attacker-authored prefix would let a forged
	// token like `$$GITHUBPATABC123_<suffix-copied-from-any-real-placeholder>$$`
	// restore to that OTHER secret's raw value with no check at all — worse
	// than the obfuscate-direction leak, since deobfuscation is what feeds
	// tool-call arguments and provider-output restoration. Refuse the
	// fallback (leave the token as opaque, unresolved text) when the prefix
	// is itself secret-shaped; an exact full-token match is unaffected, since
	// that was minted by this instance and carries no forgery risk.
	#lookupLiveAlias(placeholder: string): { secret: string; recursive: boolean } | undefined {
		const direct = this.#deobfuscateMap.get(placeholder);
		if (direct !== undefined) return direct;
		const body = placeholder.slice(2, -2);
		const match = /^([A-Z0-9]+)_([A-Z0-9]{4,}(?::[ULCM])?)$/.exec(body);
		if (match === null || this.#prefixIsSecretShaped(match[1]!)) return undefined;
		return this.#deobfuscateMap.get(`$$${match[2]}$$`);
	}

	#deobfuscate(text: string): string {
		if (!this.#hasAny || !text.includes("$$")) return text;
		let result = text;
		for (;;) {
			let shouldContinue = false;
			const next = result.replace(PLACEHOLDER_RE, match => {
				const mapped = this.#lookupLiveAlias(match);
				if (mapped !== undefined) {
					shouldContinue ||= mapped.recursive;
					return mapped.secret;
				}
				return match;
			});
			if (next === result || !shouldContinue || !next.includes("$$")) return next;
			result = next;
		}
	}

	/** Deep-walk an object, deobfuscating string values for LIVE paths (keyed placeholders only). */
	deobfuscateObject<T>(obj: T): T {
		if (!this.#hasAny) return obj;
		return deepWalkStrings(obj, s => this.deobfuscate(s));
	}

	/** Deep-walk an object, obfuscating all string values. */
	obfuscateObject<T>(obj: T): T {
		if (!this.#hasAny) return obj;
		return deepWalkStrings(obj, s => this.obfuscate(s));
	}

	#generateReplacement(chunk: string): string {
		// Redact a per-chunk remainder to a marker that is a fixed point under
		// re-redaction on ANY obfuscator sharing the key, so persisted obfuscated text
		// — and the provider prompt-cache prefixes it anchors — never drifts across a
		// restart. The marker keeps the `Z`/`ZZ` sentinel prefix (already a fixed point
		// for <=2-char remainders) and, for longer remainders, a key-derived run that
		// depends ONLY on the key and length. A fresh obfuscator reproduces the
		// identical marker (so re-redacting it stays idempotent across restarts, where
		// the content-derived chunk plus the session-local `#generatedReplaceChunks`
		// were not), yet the run is unpredictable without the per-install key, so raw
		// remainder bytes that merely look sentinel-shaped (e.g. `ZZZZ`) cannot equal
		// the marker and are still redacted instead of passed through.
		const replacement =
			chunk.length <= 2
				? "Z".repeat(chunk.length)
				: `ZZ${buildKeyedReplacementRun(this.#getKey(), chunk.length - 2)}`;
		this.#generatedReplaceChunks.add(replacement);
		return replacement;
	}

	/**
	 * Replacement for a whole CONFIGURED secret value (a plain replace-mode entry
	 * or the redacted key). Unlike a per-chunk remainder redaction, the output
	 * must differ from the input so a value equal to the `Z`/`ZZ` sentinel is not
	 * emitted verbatim. A plain secret only matches its own literal, so the
	 * perturbed output stays a fixed point under re-obfuscation.
	 */
	#generateSecretReplacement(secret: string): string {
		const replacement = ensureDistinctReplacement(generateDeterministicReplacement(secret), secret);
		this.#generatedReplaceChunks.add(replacement);
		return replacement;
	}

	/**
	 * Replacement for a default (no custom replacement) regex match. The output must
	 * be a fixed point under re-obfuscation: a regex can re-match its own replacement,
	 * and a later obfuscate() pass would then re-redact it — at best churning the
	 * provider-visible text, at worst oscillating back to the raw matched value. The
	 * deterministic replacement already differs from most values, but it is
	 * all-alphanumeric and a regex may still match it, either directly (a `Z`/`ZZ`
	 * sentinel collision, or a class like `[A-Za-z0-9]+`) or only in context
	 * (lookbehind/lookahead/`\b`, e.g. `(?<=api=)[AZ]`). When it would re-match,
	 * search same-length candidates IN CONTEXT for one the regex does not re-match:
	 * that value is a stable fixed point and cannot re-leak. A single perturbation is
	 * not enough — it may also match (e.g. `B`, not `A`, for `Z|A`) — so the search
	 * tries further candidates before giving up. When no candidate avoids the regex (a
	 * pathological match-everything config such as `.`/`[\s\S]`), the content-hash
	 * deterministic value is NOT usable as a fallback: it will itself be re-matched on
	 * the next pass, and because it is derived from the bytes being replaced, rehashing
	 * those bytes (the marker itself, not the original secret) produces a DIFFERENT
	 * value — churning the redaction, and the provider prompt-cache prefix it anchors,
	 * across every re-obfuscation. Fall back instead to a marker that depends only
	 * on `this.#key` and the value's length, not its content, so re-matching and
	 * re-redacting it reproduces the IDENTICAL marker every time, which the
	 * pathological case requires since no value can escape the regex at all. This
	 * cannot reuse `#generateReplacement`'s own <=2-char branch directly: that
	 * branch is the fixed `Z`/`ZZ` sentinel, which is itself a value this fallback
	 * could be asked to replace (an input of exactly `Z` or `ZZ`), and returning it
	 * unchanged would ship the raw secret to the provider — the exact failure plain
	 * replace-mode secrets avoid via `ensureDistinctReplacement`. Neither
	 * `ensureDistinctReplacement`'s single-char flip NOR a length-changing marker is
	 * usable here: a pathological regex re-matches ANY same-length value, including
	 * a flipped one, so a value-dependent flip oscillates between the two forever;
	 * and a regex with no quantifier (matching one input character per match, e.g.
	 * `.`) re-scans a LONGER marker as several independent same-regex matches on the
	 * next pass, re-expanding each one — unbounded growth, not a fixed point. Use a
	 * SAME-LENGTH keyed run instead of the sentinel for <=2 chars: content-independent
	 * (so it is trivially its own fixed point once emitted) and no longer a public,
	 * install-independent constant, closing the specific guessable collision
	 * (`Z`/`ZZ`) the sentinel had. A same-length, content-independent marker cannot
	 * mathematically rule out equaling some pathological input by construction (the
	 * marker is itself a same-length string a match-everything regex also matches),
	 * but that residual case now requires guessing this install's private key rather
	 * than a universal constant — the same class of accepted risk
	 * `generateDeterministicReplacement`'s hash collision already carries for longer
	 * values.
	 * A regex that is UNCONDITIONALLY pathological for a length <= 2 — matching
	 * literally every candidate in isolation, independent of context, like `.`
	 * or `[\s\S]` — is now rejected at construction/config-load time instead
	 * (see `regexHasUnresolvableShortMatchFallback`), since for that narrow
	 * case the residual risk above is fully avoidable rather than merely
	 * unlikely. This branch, and the residual risk above, still applies to a
	 * length > 2 pathological config and to a length <= 2 pattern that is only
	 * pathological in a SPECIFIC match's surrounding context (the
	 * construction-time check tests the regex in isolation, not every context
	 * it could appear in).
	 */
	#generateRegexReplacement(value: string, regex: RegExp, context: RegexMatchContext): string {
		let replacement = generateDeterministicReplacement(value);
		// Verify in context, not just against the sentinel collision: the
		// deterministic replacement is all-alphanumeric and a context-sensitive regex
		// (lookbehind/lookahead/`\b`) can re-match it even when it differs from the
		// value, so a later pass would re-redact and could oscillate back to the raw
		// secret. Search for a candidate the regex does not re-match in place.
		if (replacement === value || regexRematchesInContext(replacement, regex, context)) {
			const stable = findNonMatchingReplacement(value, regex, context);
			// See docstring above: same-length keyed run for <=2 chars (never the
			// `Z`/`ZZ` sentinel, which a <=2 char value could itself be), otherwise
			// the ordinary keyed-run fallback #generateReplacement already uses.
			replacement =
				stable ??
				(value.length <= 2
					? buildKeyedReplacementRun(this.#getKey(), value.length)
					: this.#generateReplacement(value));
			regex.lastIndex = 0;
		}
		this.#generatedReplaceChunks.add(replacement);
		return replacement;
	}

	#generateRegexChunkReplacement(chunk: string, regex: RegExp, context: RegexMatchContext): string {
		let replacement = this.#generateReplacement(chunk);
		if (regexRematchesInContext(replacement, regex, context)) {
			const stable = findNonMatchingReplacement(chunk, regex, context);
			if (stable !== undefined) {
				replacement = stable;
				this.#generatedReplaceChunks.add(replacement);
			}
			regex.lastIndex = 0;
		}
		return replacement;
	}

	#redactRegexMatchOutsidePlaceholders(
		text: string,
		origin: string,
		regex: RegExp,
		context: RegexMatchContext,
	): { text: string; origin: string } {
		let scanCursor = context.start;
		return transformOutsidePlaceholdersTracked(
			text,
			origin,
			placeholder => this.#isGeneratedPlaceholder(placeholder),
			chunk => {
				const start = scanCursor;
				scanCursor += chunk.length;
				if (chunk.length === 0) return "";
				return this.#generateRegexChunkReplacement(chunk, regex, {
					text: context.text,
					start,
					end: scanCursor,
				});
			},
			placeholder => {
				scanCursor +=
					lookupFriendlyPlaceholderAlias(this.#deobfuscateMap, placeholder)?.secret.length ?? placeholder.length;
				return placeholder;
			},
		);
	}

	#stabilizeReplaceRegexPlaceholderSpillover(text: string, origin: string): { text: string; origin: string } {
		let result = text;
		let currentOrigin = origin;
		for (const entry of this.#regexEntries) {
			if (entry.mode !== "replace" || entry.replacement !== undefined) continue;
			entry.regex.lastIndex = 0;
			const matches = this.#collectRegexMatches(result, entry.regex, entry.mode, currentOrigin, entry.replacement);
			entry.regex.lastIndex = 0;
			for (const match of matches) {
				if (!match.preserveGeneratedPlaceholders) continue;
				if (
					match.preserveInputPlaceholders &&
					entry.replacement === undefined &&
					match.inputPlaceholderOutsideChunkCount === 1 &&
					match.inputPlaceholderOutsideStart >= 0 &&
					currentOrigin
						.slice(
							match.inputPlaceholderOutsideStart,
							match.inputPlaceholderOutsideStart + match.inputPlaceholderOutside.length,
						)
						.includes("F") &&
					this.#generatedReplaceChunks.has(match.inputPlaceholderOutside)
				) {
					continue;
				}
				if (match.inputPlaceholderInnerIndependentlyMatches && !match.inputPlaceholderOutsideIndependentlyMatches) {
					continue;
				}
				const span = result.slice(match.start, match.end);
				const spanOrigin = currentOrigin.slice(match.start, match.end);
				const redacted =
					entry.replacement !== undefined
						? redactWithFixedReplacementOutsidePlaceholders(span, spanOrigin, entry.replacement, placeholder =>
								this.#isGeneratedPlaceholder(placeholder),
							)
						: this.#redactRegexMatchOutsidePlaceholders(span, spanOrigin, entry.regex, match.scanContext);
				if (redacted.text === span) continue;
				result = replaceRange(result, match.start, match.end, redacted.text);
				currentOrigin = replaceRange(currentOrigin, match.start, match.end, redacted.origin);
			}
		}
		return { text: result, origin: currentOrigin };
	}

	/** Find the obfuscate index for a known secret value. */
	#findObfuscateIndex(secret: string): number | undefined {
		// Check plain mappings first
		const plainIndex = this.#plainMappings.get(secret);
		if (plainIndex !== undefined) return plainIndex;

		// Check regex-discovered mappings
		for (const [index, mapping] of this.#obfuscateMappings) {
			if (mapping.secret === secret) return index;
		}
		return undefined;
	}

	#createPlaceholder(secret: string, friendlyName?: string, recursive: boolean = false): string {
		const hint = inferCaseHint(secret);
		// Key the base on the EXACT secret value, never a case-folded form. The
		// case hint is only a model-visible label. If two distinct secrets that
		// differ solely by ASCII case shared one case-folded base, a provider that
		// saw one placeholder could swap the hint to synthesize the sibling
		// secret's keyed token, and live deobfuscation (provider output / tool-call
		// args) would restore a value that was never provider-visible. Exact-value
		// keying gives every secret an independent base, so a sibling token cannot
		// be derived without the per-install key.
		const baseKey = secret;
		// A friendly name that embeds a configured secret's literal (or matches a
		// configured regex pattern) would bake that secret straight into a
		// LEGITIMATE, exact-registered placeholder — later scans recognize the
		// whole token as already-generated on an EXACT match, before the
		// alias-fallback prefix check above ever runs, so the embedded secret
		// would never be scanned. Drop the label for this mint rather than risk
		// it; the secret still gets a bare (unprefixed) placeholder. The collision
		// check runs against the FULL normalized label — `sanitizeForCollisionCheck`,
		// not yet capped at `MAX_FRIENDLY_NAME_LEN` — so a secret longer than the
		// 32-char display cap (or one whose sanitized form exceeds it) still gets
		// caught: a truncated `requestedFriendlyName` can never contain a longer
		// secret's full sanitized form, so checking the truncated label would let
		// the secret's first 32 (post-cap) characters leak as an accepted prefix.
		const requestedFriendlyName = friendlyName ? sanitizeSecretFriendlyName(friendlyName) : undefined;
		const sanitizedFriendlyName =
			requestedFriendlyName !== undefined &&
			friendlyName !== undefined &&
			!this.#friendlyNameCollidesWithSecret(sanitizeForCollisionCheck(friendlyName), friendlyName, secret)
				? requestedFriendlyName
				: undefined;
		const preferredBase = this.#resolvePreferredPlaceholderBase(baseKey);
		const preferredPlaceholder = buildPlaceholder(hint, preferredBase, sanitizedFriendlyName);
		if (!this.#placeholderConflicts(preferredPlaceholder, secret)) {
			this.#registerDeobfuscationAlias(preferredPlaceholder, secret, recursive);
			return preferredPlaceholder;
		}

		for (let attempt = 1; ; attempt++) {
			const fallbackBase = this.#reserveFallbackPlaceholderBase(baseKey, attempt);
			const placeholder = buildPlaceholder(hint, fallbackBase, sanitizedFriendlyName);
			if (!this.#placeholderConflicts(placeholder, secret)) {
				this.#registerDeobfuscationAlias(placeholder, secret, recursive);
				return placeholder;
			}
		}
	}

	#resolvePreferredPlaceholderBase(baseKey: string): string {
		const existing = this.#placeholderBaseByKey.get(baseKey);
		if (existing !== undefined) return existing;

		for (let attempt = 0; ; attempt++) {
			const base =
				attempt === 0
					? buildHashBase(this.#getKey(), baseKey)
					: buildHashBase(this.#getKey(), `${baseKey}\0${attempt}`);
			const owner = this.#placeholderBaseOwners.get(base);
			if (owner !== undefined && owner !== baseKey) continue;
			this.#placeholderBaseOwners.set(base, baseKey);
			this.#placeholderBaseByKey.set(baseKey, base);
			return base;
		}
	}

	#reserveFallbackPlaceholderBase(baseKey: string, startAttempt: number): string {
		for (let attempt = startAttempt; ; attempt++) {
			const owner = `${baseKey}\0collision\0${attempt}`;
			const base = buildHashBase(this.#getKey(), `${baseKey}\0collision\0${attempt}`);
			if (this.#placeholderBaseOwners.has(base)) continue;
			this.#placeholderBaseOwners.set(base, owner);
			return base;
		}
	}

	#placeholderCollides(placeholder: string, secret: string): boolean {
		const existing = this.#deobfuscateMap.get(placeholder);
		return existing !== undefined && existing.secret !== secret;
	}

	// A friendly placeholder is only safe if BOTH its full token and its
	// friendly-name-independent alias are free (or already ours), AND the token
	// itself is not another configured secret's literal value. Without the
	// latter check, a placeholder minted for secret A that happens to equal
	// secret B's raw content passes silently: B's own plain-secret redaction
	// pass (sorted by length, run once per obfuscate() call) already completed
	// before A's placeholder existed in the text, so B is never redacted out of
	// it — A's placeholder becomes a verbatim, provider-visible copy of B.
	#placeholderConflicts(placeholder: string, secret: string): boolean {
		if (this.#placeholderCollides(placeholder, secret)) return true;
		if (this.#configuredSecretValues.has(placeholder) && placeholder !== secret) return true;
		const unprefixed = placeholderWithoutFriendlyName(placeholder);
		if (unprefixed === undefined) return false;
		if (this.#placeholderCollides(unprefixed, secret)) return true;
		return this.#configuredSecretValues.has(unprefixed) && unprefixed !== secret;
	}

	// A sanitized friendly name must not double as a live secret: it becomes a
	// verbatim, model-visible prefix on every placeholder minted for THIS
	// secret, baked in via an exact `#deobfuscateMap` entry rather than the
	// alias fallback — so it needs its own check independent of the scan-skip
	// alias guard in `#isGeneratedPlaceholder`. Reuses `#prefixIsSecretShaped`
	// for the sanitized-vs-sanitized comparisons (configured plain secrets,
	// every regex-discovered secret this instance has ever minted a
	// placeholder for) and the sanitized-label-vs-regex-pattern check, then
	// adds two label-specific checks `#prefixIsSecretShaped` cannot make: the
	// CURRENT secret being minted right now — which, on its first-ever mint,
	// is not yet in `#prefixIsSecretShaped`'s previously-discovered set, since
	// that set is only populated AFTER this call returns — normalized the
	// same way (catches, e.g., `friendlyName: "TOKABC123"` for a regex secret
	// whose literal match is `tok_abc123`, which the sanitized-name-vs-pattern
	// check misses when the pattern is case-sensitive/punctuated); and the RAW
	// (pre-sanitization) label against every configured regex pattern (catches
	// `friendlyName: "tok_abc123"` literally, which the SANITIZED label
	// `"TOKABC123"` could never match against that same case-sensitive
	// pattern). Any of these means the text is meant to be redacted, not
	// stamped unredacted onto every use of this secret.
	#collectRegexSecretValues(text: string): Set<string> {
		const values = new Set<string>();
		for (const entry of this.#regexEntries) {
			entry.regex.lastIndex = 0;
			for (;;) {
				const match = entry.regex.exec(text);
				if (match === null) break;
				if (match[0].length === 0) {
					entry.regex.lastIndex++;
					continue;
				}
				values.add(match[0]);
			}
			entry.regex.lastIndex = 0;
		}
		return values;
	}

	collectRegexSecretValuesForObfuscation(text: string): Set<string> {
		const values = this.#collectRegexSecretValues(text);
		let result = text;
		let origin = "I".repeat(text.length);
		for (const [secret, replacement] of [...this.#replaceMappings].sort((a, b) => b[0].length - a[0].length)) {
			({ text: result, origin } = this.#replaceOutsidePlaceholdersTracked(result, origin, secret, replacement, "I"));
		}
		for (const secretValue of this.#collectRegexSecretValues(result)) {
			values.add(secretValue);
		}
		for (const secretValue of this.#collectRegexSecretValuesAfterRegexReplacements(result, origin)) {
			values.add(secretValue);
		}
		return values;
	}

	#collectRegexSecretValuesAfterRegexReplacements(text: string, origin: string): Set<string> {
		const values = new Set<string>();
		let simulated = text;
		let simulatedOrigin = origin;
		for (const entry of this.#regexEntries) {
			if (entry.mode !== "replace") continue;
			entry.regex.lastIndex = 0;
			const matches = this.#collectRegexMatches(
				simulated,
				entry.regex,
				entry.mode,
				simulatedOrigin,
				entry.replacement,
			);
			entry.regex.lastIndex = 0;
			if (matches.length === 0) continue;
			for (const match of [...matches].sort((a, b) => b.start - a.start)) {
				const replacement = entry.replacement ?? match.defaultReplacement;
				if (replacement === undefined) continue;
				for (const secretValue of this.#collectRegexSecretValues(replacement)) {
					values.add(secretValue);
				}
				simulated = replaceRange(simulated, match.start, match.end, replacement);
				simulatedOrigin = replaceRange(simulatedOrigin, match.start, match.end, "I".repeat(replacement.length));
			}
			for (const secretValue of this.#collectRegexSecretValues(simulated)) {
				values.add(secretValue);
			}
		}
		return values;
	}

	#friendlyNameCollidesWithSecret(sanitizedName: string, rawName: string, secret: string): boolean {
		if (this.#prefixIsSecretShaped(sanitizedName)) return true;
		const sanitizedSecretValue = sanitizeForCollisionCheck(secret);
		if (sanitizedLabelCollidesWithSecret(sanitizedName, sanitizedSecretValue)) return true;
		for (const entry of this.#regexEntries) {
			entry.regex.lastIndex = 0;
			const matches = entry.regex.test(rawName);
			entry.regex.lastIndex = 0;
			if (matches) return true;
		}
		return false;
	}

	#placeholderForCurrentInput(placeholder: string): string {
		const unprefixed = placeholderWithoutFriendlyName(placeholder);
		if (unprefixed === undefined) return placeholder;
		const match = /^([A-Z0-9]+)_/.exec(placeholder.slice(2, -2));
		if (match === null || !this.#prefixIsSecretShaped(match[1]!)) return placeholder;
		return unprefixed;
	}

	#stripUnsafeFriendlyPrefixes(text: string, origin: string): { text: string; origin: string } {
		PLACEHOLDER_RE.lastIndex = 0;
		let result = "";
		let resultOrigin = "";
		let cursor = 0;
		for (;;) {
			const match = PLACEHOLDER_RE.exec(text);
			if (match === null) break;
			const placeholder = match[0];
			const unprefixed = placeholderWithoutFriendlyName(placeholder);
			const replacement = unprefixed !== undefined ? this.#placeholderForCurrentInput(placeholder) : placeholder;
			if (replacement === placeholder) {
				resumePlaceholderScanAfterRejectedCandidate(match);
				continue;
			}
			result += text.slice(cursor, match.index);
			resultOrigin += origin.slice(cursor, match.index);
			result += replacement;
			resultOrigin += origin[match.index]?.repeat(replacement.length) ?? "";
			cursor = match.index + placeholder.length;
		}
		result += text.slice(cursor);
		resultOrigin += origin.slice(cursor);
		return { text: result, origin: resultOrigin };
	}

	stripUnsafeFriendlyPlaceholderPrefixes(text: string, sharedRegexSecretValues: ReadonlySet<string>): string {
		const previousRegexSecretValues = this.#currentRegexSecretValues;
		this.#currentRegexSecretValues = new Set(sharedRegexSecretValues);
		try {
			return this.#stripUnsafeFriendlyPrefixes(text, "I".repeat(text.length)).text;
		} finally {
			this.#currentRegexSecretValues = previousRegexSecretValues;
		}
	}

	#registerDeobfuscationAlias(placeholder: string, secret: string, recursive: boolean): void {
		const existing = this.#deobfuscateMap.get(placeholder);
		if (existing === undefined || existing.secret === secret) {
			this.#deobfuscateMap.set(placeholder, { secret, recursive });
		}
		const unprefixed = placeholderWithoutFriendlyName(placeholder);
		if (unprefixed !== undefined) {
			const existingUnprefixed = this.#deobfuscateMap.get(unprefixed);
			if (existingUnprefixed === undefined || existingUnprefixed.secret === secret) {
				this.#deobfuscateMap.set(unprefixed, { secret, recursive });
			}
		}
	}

	// Whether an alnum-only, uppercase friendly-name-shaped prefix dropped from
	// a candidate placeholder token is itself something that should have been
	// redacted, rather than an arbitrary label: a sanitized form of a
	// configured plain secret's value, a sanitized form of any regex-
	// discovered secret's value this instance has ever minted a placeholder
	// for, or text a configured regex pattern matches directly. Shared by the
	// obfuscate-direction guard below and the deobfuscate-direction bare-alias
	// guard in `#deobfuscate` — both fall back to a friendly-name-independent
	// alias keyed only by the hash suffix, so both need the same defense
	// against a forged/attacker-chosen prefix.
	#prefixIsSecretShaped(prefix: string): boolean {
		for (const secretValue of this.#configuredSecretValues) {
			const sanitizedSecret = sanitizeForCollisionCheck(secretValue);
			if (sanitizedLabelCollidesWithSecret(prefix, sanitizedSecret)) return true;
		}
		for (const secretValue of this.#currentRegexSecretValues) {
			const sanitizedSecret = sanitizeForCollisionCheck(secretValue);
			if (sanitizedLabelCollidesWithSecret(prefix, sanitizedSecret)) return true;
		}
		for (const { secret } of this.#obfuscateMappings.values()) {
			const sanitizedSecret = sanitizeForCollisionCheck(secret);
			if (sanitizedLabelCollidesWithSecret(prefix, sanitizedSecret)) return true;
		}
		for (const entry of this.#regexEntries) {
			entry.regex.lastIndex = 0;
			const matches = entry.regex.test(prefix);
			entry.regex.lastIndex = 0;
			if (matches) return true;
		}
		return false;
	}

	// A placeholder is an exact match, or the friendly-name-independent bare
	// alias: needed so a placeholder minted under a NOW-renamed friendly name
	// (same secret, same key, different `secrets.yml` label) still round-trips
	// when older provider-visible text is re-scanned by a renamed-config
	// instance — the hash suffix is a keyed digest of the secret VALUE alone,
	// so a same-key instance recomputes it identically regardless of the
	// label. The dropped prefix is otherwise unconstrained text, though: an
	// attacker who has observed ANY live placeholder's hash suffix elsewhere
	// in the transcript could wrap it around a DIFFERENT real secret's
	// plaintext (or a normalized rendering of one) to make the whole token
	// look pre-redacted and smuggle that secret through untouched.
	// `#prefixIsSecretShaped` above guards against that, shared with the
	// deobfuscate-direction check in `#deobfuscate`.
	#isGeneratedPlaceholder(placeholder: string): boolean {
		if (this.#deobfuscateMap.has(placeholder)) return true;
		const match = /^([A-Z0-9]+)_([A-Z0-9]{4,}(?::[ULCM])?)$/.exec(placeholder.slice(2, -2));
		if (match === null) return false;
		if (this.#prefixIsSecretShaped(match[1]!)) return false;
		return this.#deobfuscateMap.has(`$$${match[2]}$$`);
	}

	// Replace `search` with `replacement` outside known generated placeholders while
	// maintaining a parallel `origin` tag string (one char per result char): kept
	// bytes keep their tag, inserted `replacement` bytes get `tag`, and preserved
	// placeholder spans keep their original tags. Lets later passes tell prior-call
	// placeholders ("I") from ones freshly inserted this call ("F") by RANGE.
	#replaceOutsidePlaceholdersTracked(
		text: string,
		origin: string,
		search: string,
		replacement: string,
		tag: string,
	): { text: string; origin: string } {
		if (search.length === 0) return { text, origin };
		PLACEHOLDER_RE.lastIndex = 0;
		let outText = "";
		let outOrigin = "";
		let pending = 0;
		const emitChunk = (from: number, to: number): void => {
			let last = from;
			let idx = text.indexOf(search, from);
			while (idx !== -1 && idx + search.length <= to) {
				outText += text.slice(last, idx) + replacement;
				outOrigin += origin.slice(last, idx) + tag.repeat(replacement.length);
				last = idx + search.length;
				idx = text.indexOf(search, last);
			}
			outText += text.slice(last, to);
			outOrigin += origin.slice(last, to);
		};
		for (;;) {
			const match = PLACEHOLDER_RE.exec(text);
			if (match === null) break;
			if (!(this.#isGeneratedPlaceholder(match[0]) && match[0] !== search)) {
				resumePlaceholderScanAfterRejectedCandidate(match);
				continue;
			}
			emitChunk(pending, match.index);
			outText += match[0];
			outOrigin += origin.slice(match.index, match.index + match[0].length);
			pending = match.index + match[0].length;
		}
		emitChunk(pending, text.length);
		return { text: outText, origin: outOrigin };
	}

	#placeholderForRegexChunk(secret: string, friendlyName: string | undefined): string {
		let index = this.#findObfuscateIndex(secret);
		if (index === undefined) {
			index = this.#nextIndex++;
			const placeholder = this.#createPlaceholder(secret, friendlyName);
			this.#obfuscateMappings.set(index, { secret, placeholder });
			this.#generatedPlaceholders.add(placeholder);
		}
		return this.#placeholderForCurrentInput(this.#obfuscateMappings.get(index)!.placeholder);
	}

	#obfuscateOutsidePlaceholdersTracked(
		text: string,
		origin: string,
		friendlyName: string | undefined,
	): { text: string; origin: string } {
		PLACEHOLDER_RE.lastIndex = 0;
		let outText = "";
		let outOrigin = "";
		let pending = 0;
		const emitChunk = (from: number, to: number): void => {
			if (from >= to) return;
			const placeholder = this.#placeholderForRegexChunk(text.slice(from, to), friendlyName);
			outText += placeholder;
			outOrigin += "F".repeat(placeholder.length);
		};
		for (;;) {
			const match = PLACEHOLDER_RE.exec(text);
			if (match === null) break;
			if (!this.#isGeneratedPlaceholder(match[0])) {
				resumePlaceholderScanAfterRejectedCandidate(match);
				continue;
			}
			emitChunk(pending, match.index);
			outText += match[0];
			outOrigin += origin.slice(match.index, match.index + match[0].length);
			pending = match.index + match[0].length;
		}
		emitChunk(pending, text.length);
		return { text: outText, origin: outOrigin };
	}

	#knownPlaceholderRanges(text: string): Array<{ start: number; end: number }> {
		PLACEHOLDER_RE.lastIndex = 0;
		const ranges: Array<{ start: number; end: number }> = [];
		for (;;) {
			const match = PLACEHOLDER_RE.exec(text);
			if (match === null) break;
			if (this.#isGeneratedPlaceholder(match[0])) {
				ranges.push({ start: match.index, end: match.index + match[0].length });
			} else {
				resumePlaceholderScanAfterRejectedCandidate(match);
			}
		}
		return ranges;
	}

	#collectRegexMatches(
		text: string,
		regex: RegExp,
		mode: "obfuscate" | "replace",
		origin: string,
		replacement: string | undefined,
	): Array<{
		start: number;
		end: number;
		value: string;
		canonicalValue: string;
		scanMatchLength: number;
		recursive: boolean;
		preserveGeneratedPlaceholders: boolean;
		preserveInputPlaceholders: boolean;
		inputPlaceholderOutside: string;
		inputPlaceholderOutsideIndependentlyMatches: boolean;
		inputPlaceholderOutsideStart: number;
		inputPlaceholderOutsideChunkCount: number;
		inputPlaceholderInnerIndependentlyMatches: boolean;
		defaultReplacement: string | undefined;
		scanContext: RegexMatchContext;
	}> {
		const knownPlaceholderRanges = this.#knownPlaceholderRanges(text);
		const regexScan = buildReplaceRegexScan(text, knownPlaceholderRanges, this.#deobfuscateMap);
		const scanText = regexScan.text;
		regex.lastIndex = 0;
		const matches: Array<{
			start: number;
			end: number;
			value: string;
			canonicalValue: string;
			scanMatchLength: number;
			recursive: boolean;
			preserveGeneratedPlaceholders: boolean;
			preserveInputPlaceholders: boolean;
			inputPlaceholderOutside: string;
			inputPlaceholderOutsideIndependentlyMatches: boolean;
			inputPlaceholderOutsideStart: number;
			inputPlaceholderOutsideChunkCount: number;
			inputPlaceholderInnerIndependentlyMatches: boolean;
			defaultReplacement: string | undefined;
			scanContext: RegexMatchContext;
		}> = [];
		for (;;) {
			const match = regex.exec(scanText);
			if (match === null) break;
			if (match[0].length === 0) {
				regex.lastIndex++;
				continue;
			}
			let start = match.index;
			let end = match.index + match[0].length;
			let scanMatchLength = match[0].length;
			let scanMatchValue = match[0];
			let canonicalValue = "";
			let recursive = false;
			let preserveGeneratedPlaceholders = false;
			let preserveInputPlaceholders = false;
			let inputPlaceholderOutside = "";
			let inputPlaceholderOutsideIndependentlyMatches = false;
			let inputPlaceholderOutsideStart = -1;
			let inputPlaceholderOutsideChunkCount = 0;
			let inputPlaceholderInnerIndependentlyMatches = false;

			let mapped = mapReplaceRegexMatch(regexScan.segments, start, end);
			if (mapped.partialPlaceholderCut) {
				// The match straddles a generated placeholder (its boundary falls inside
				// the secret's expanded value). Rewriting across the token drops bytes
				// (obfuscate) or drifts the redaction across re-obfuscation passes
				// (replace), so the cut secret must stay as its existing placeholder.
				// But wholly-outside bytes on either side of the placeholder are still
				// provider-visible content covered by the regex. Probe the prefix against
				// the full expanded scan text so right-hand context supplied by the
				// placeholder still satisfies lookahead/alternatives, then clamp the
				// accepted match to the prefix boundary. If no prefix is available, redact
				// the outside suffix that was covered by the full-context match. Every
				// resume point computed below is chained through
				// `extendPastAdjacentPlaceholders`: a resume position that lands exactly on
				// the START of ANOTHER placeholder must skip that one too before a fresh
				// `regex.exec` attempt runs there, so a run of adjacent placeholders resolves
				// identically whether its LEADING member is raw text this call is about to
				// placeholder or is already a placeholder from a prior call/pass (see that
				// helper's doc for the cross-call drift this prevents).
				const cutResumeIndex = mapped.cutResumeIndex;
				const prefixScanEnd = mapped.firstPlaceholderScanStart;
				let handledOutside = false;
				if (prefixScanEnd > match.index) {
					regex.lastIndex = match.index;
					const prefixMatch = regex.exec(scanText);
					if (prefixMatch !== null && prefixMatch[0].length > 0 && prefixMatch.index < prefixScanEnd) {
						const prefixStart = prefixMatch.index;
						const prefixEnd = Math.min(prefixMatch.index + prefixMatch[0].length, prefixScanEnd);
						const prefixMapped = mapReplaceRegexMatch(regexScan.segments, prefixStart, prefixEnd);
						if (!prefixMapped.partialPlaceholderCut && prefixEnd > prefixStart) {
							start = prefixStart;
							end = prefixEnd;
							scanMatchValue = scanText.slice(prefixStart, prefixEnd);
							// Keep the full match length in the expanded scan view (not the
							// clamped prefix length) — the short-match guard below measures the
							// regex's own match length, so a full-size match with a short
							// outside-prefix remainder must not be undercounted as too short,
							// matching the suffix-clamp branch below.
							scanMatchLength = match[0].length;
							mapped = prefixMapped;
							regex.lastIndex = extendPastAdjacentPlaceholders(regexScan.segments, prefixEnd);
							handledOutside = true;
						}
					}
				}
				if (!handledOutside && cutResumeIndex < end) {
					const suffixStart = cutResumeIndex;
					const suffixEnd = end;
					const suffixMapped = mapReplaceRegexMatch(regexScan.segments, suffixStart, suffixEnd);
					if (!suffixMapped.partialPlaceholderCut) {
						start = suffixStart;
						end = suffixEnd;
						scanMatchValue = scanText.slice(suffixStart, suffixEnd);
						scanMatchLength = match[0].length;
						mapped = suffixMapped;
						regex.lastIndex = extendPastAdjacentPlaceholders(regexScan.segments, suffixEnd);
						handledOutside = true;
					}
				}
				if (!handledOutside) {
					regex.lastIndex = extendPastAdjacentPlaceholders(regexScan.segments, cutResumeIndex);
					continue;
				}
			}
			// Scan-space coordinates of the match (placeholders expanded). The default
			// redaction's fixed-point check must run against this expanded view — the
			// view re-obfuscation actually scans — not the literal `#…#` text, or a
			// redaction adjacent to a placeholder (e.g. an outside prefix before a cut
			// secret) could drift when the placeholder expands and connects to it.
			const scanMatchStart = start;
			const scanMatchEnd = end;
			let defaultReplacement: string | undefined;
			start = mapped.start;
			end = mapped.end;
			preserveGeneratedPlaceholders = mapped.preserveGeneratedPlaceholders;
			// A match overlapping a placeholder that arrived in the INPUT (origin tag
			// "I" — generated by a PRIOR obfuscate() call) must preserve that
			// placeholder atomically so repeated obfuscation stays a fixed point. If
			// raw bytes surround it, they still need redaction; branch-specific
			// replacement below keeps prior placeholders while covering the
			// non-placeholder chunks.
			const overlapsInputPlaceholder = knownPlaceholderRanges.some(
				range => start < range.end && end > range.start && origin[range.start] === "I",
			);
			preserveInputPlaceholders = overlapsInputPlaceholder;
			if (overlapsInputPlaceholder) {
				const firstOutside = firstOutsidePlaceholderRange(start, end, knownPlaceholderRanges);
				if (
					mode === "replace" &&
					replacement !== undefined &&
					firstOutside !== undefined &&
					text.slice(firstOutside.start, firstOutside.start + replacement.length) === replacement
				) {
					const expandedEnd = firstOutside.start + replacement.length;
					if (expandedEnd > end) {
						regex.lastIndex = Math.max(regex.lastIndex, match.index + match[0].length + expandedEnd - end);
						end = expandedEnd;
					}
				}
				inputPlaceholderOutside = textOutsidePlaceholderRanges(text, start, end, knownPlaceholderRanges);
				inputPlaceholderOutsideStart =
					firstOutsidePlaceholderRange(start, end, knownPlaceholderRanges)?.start ?? -1;
				inputPlaceholderOutsideChunkCount = countOutsidePlaceholderRanges(start, end, knownPlaceholderRanges);
				if (inputPlaceholderOutside.length === 0) continue;
				const resumeIndex = regex.lastIndex;
				// Test each outside chunk in isolation rather than the concatenation of
				// all of them: concatenating chunks that sit on either side of the
				// placeholder erases the `#…#` token boundary between them (e.g. a
				// prefix "ABCDEFGH" that independently matches `\b[A-Z]{8}\b` next to a
				// placeholder, followed by a raw "I" suffix, concatenates to "ABCDEFGHI"
				// — which does NOT match, since the boundary the placeholder provided is
				// gone). That false negative would leave a genuinely independent,
				// secret-shaped chunk unredacted. Each chunk is tested in BOTH its real
				// literal-token context (where the token's own non-word boundary can
				// complete a boundary-sensitive pattern) and the EXPANDED scan context —
				// the same view re-obfuscation's own regex scan runs against — so a
				// lookbehind/lookahead that only resolves once the neighboring
				// placeholder is expanded (e.g. `(?<=ABCDEFGH)SECRET` beside a
				// placeholder for `ABCDEFGH`) also counts as an independent match.
				inputPlaceholderOutsideIndependentlyMatches = outsidePlaceholderRangesAnyIndependentlyMatch(
					text,
					scanText,
					regexScan.segments,
					start,
					end,
					knownPlaceholderRanges,
					regex,
				);
				// Whether the placeholder's own (deobfuscated) value satisfies the regex
				// with the surrounding raw bytes dropped. When it does, those raw bytes
				// are greedy spillover the match never needed (e.g. the trailing `A` in
				// `SECRETUV→#…#A`); obfuscating them on re-obfuscation drifts the
				// provider-visible history and prompt-cache prefix. When it does NOT
				// (e.g. `api_key=` literal that the placeholder value alone cannot match),
				// the outside bytes are structurally required and must be obfuscated.
				const innerText = placeholderInnerText(text, start, end, knownPlaceholderRanges, this.#deobfuscateMap);
				regex.lastIndex = 0;
				inputPlaceholderInnerIndependentlyMatches = innerText.length > 0 && regex.test(innerText);
				regex.lastIndex = resumeIndex;
			}
			if (mode === "replace") {
				canonicalValue = scanMatchValue;
				recursive = mapped.recursive;
			} else {
				const overlappingRanges = knownPlaceholderRanges.filter(range => start < range.end && end > range.start);
				const containedByPlaceholder = overlappingRanges.some(range => start >= range.start && end <= range.end);
				if (containedByPlaceholder) {
					continue;
				}
				const canonical = deobfuscateGeneratedPlaceholderRanges(
					text,
					start,
					end,
					knownPlaceholderRanges,
					this.#deobfuscateMap,
				);
				canonicalValue = canonical.text;
				recursive = canonical.recursive;
			}

			const scanContext = {
				text: scanText,
				start: scanMatchStart,
				end: scanMatchEnd,
			};
			if (mode === "replace" && replacement === undefined && !preserveGeneratedPlaceholders) {
				const savedLastIndex = regex.lastIndex;
				defaultReplacement = this.#generateRegexReplacement(scanMatchValue, regex, scanContext);
				regex.lastIndex = savedLastIndex;
			}
			matches.push({
				start,
				end,
				value: text.slice(start, end),
				defaultReplacement,
				canonicalValue,
				scanMatchLength,
				recursive,
				preserveGeneratedPlaceholders,
				preserveInputPlaceholders,
				inputPlaceholderOutside,
				inputPlaceholderOutsideIndependentlyMatches,
				inputPlaceholderOutsideStart,
				inputPlaceholderOutsideChunkCount,
				inputPlaceholderInnerIndependentlyMatches,
				scanContext,
			});
		}
		return matches.reverse();
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Display restore (inbound, persisted/provider → local display)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Restore secret placeholders for local display. Only message kinds the model
 * itself authored from obfuscated context carry placeholders — assistant
 * content and the LLM-written branch/compaction summaries. User, developer, and
 * tool-result messages are persisted with their literal text, so operator-authored
 * placeholder-shaped text must survive untouched; those roles are never walked.
 */
export function deobfuscateSessionContext(
	sessionContext: SessionContext,
	obfuscator: SecretObfuscator | undefined,
): SessionContext {
	if (!obfuscator?.hasSecrets()) return sessionContext;
	const messages = deobfuscateAgentMessages(obfuscator, sessionContext.messages);
	return messages === sessionContext.messages ? sessionContext : { ...sessionContext, messages };
}

export function deobfuscateAgentMessages(obfuscator: SecretObfuscator, messages: AgentMessage[]): AgentMessage[] {
	const deob = (text: string): string => obfuscator.deobfuscate(text);
	let changed = false;
	const result = messages.map((message): AgentMessage => {
		switch (message.role) {
			case "assistant": {
				const content = deobfuscateAssistantContent(obfuscator, message.content);
				if (content === message.content) return message;
				changed = true;
				return { ...message, content };
			}
			case "branchSummary": {
				const summary = deob(message.summary);
				if (summary === message.summary) return message;
				changed = true;
				return { ...message, summary };
			}
			case "compactionSummary": {
				const summary = deob(message.summary);
				const shortSummary = message.shortSummary === undefined ? undefined : deob(message.shortSummary);
				const blocks = message.blocks === undefined ? undefined : deobfuscateTextBlocks(obfuscator, message.blocks);
				if (summary === message.summary && shortSummary === message.shortSummary && blocks === message.blocks) {
					return message;
				}
				changed = true;
				return { ...message, summary, shortSummary, blocks };
			}
			default:
				return message;
		}
	});
	return changed ? result : messages;
}

/**
 * Restore placeholders in assistant content: visible text and tool-call
 * arguments/intent/rawBlock. Thinking and signatures are opaque
 * provider-replay/hidden-reasoning data and pass through byte-identical.
 */
export function deobfuscateAssistantContent(
	obfuscator: SecretObfuscator,
	content: AssistantMessage["content"],
): AssistantMessage["content"] {
	if (!obfuscator.hasSecrets()) return content;
	const deob = (text: string): string => obfuscator.deobfuscate(text);
	let changed = false;
	const result = content.map((block): AssistantMessage["content"][number] => {
		if (block.type === "text") {
			const text = deob(block.text);
			if (text === block.text) return block;
			changed = true;
			return { ...block, text };
		}

		if (block.type === "toolCall") {
			const args = deobfuscateToolArguments(obfuscator, block.arguments);
			const intent = block.intent === undefined ? undefined : deob(block.intent);
			const rawBlock = block.rawBlock === undefined ? undefined : deob(block.rawBlock);
			if (args === block.arguments && intent === block.intent && rawBlock === block.rawBlock) return block;
			changed = true;
			return { ...block, arguments: args, intent, rawBlock };
		}
		return block;
	});
	return changed ? result : content;
}

/**
 * Restore placeholders inside a tool call's arguments. Arguments are arbitrary
 * model-authored JSON, so tool-call arguments are the ONLY place a recursive
 * JSON walk runs.
 */
export function deobfuscateToolArguments(
	obfuscator: SecretObfuscator,
	args: Record<string, unknown>,
): Record<string, unknown> {
	if (!obfuscator.hasSecrets()) return args;
	return mapJsonStrings(args as JsonValue, s => obfuscator.deobfuscate(s)) as Record<string, unknown>;
}

/** Redact secrets inside a tool call's arguments (same JSON-walk exception as {@link deobfuscateToolArguments}). */
export function obfuscateToolArguments(
	obfuscator: SecretObfuscator,
	args: Record<string, unknown>,
	sharedRegexSecretValues?: ReadonlySet<string>,
): Record<string, unknown> {
	if (!obfuscator.hasSecrets()) return args;
	const regexSecretValues = sharedRegexSecretValues ?? collectJsonRegexSecretValues(obfuscator, args as JsonValue);
	return mapJsonStrings(args as JsonValue, s => obfuscator.obfuscate(s, regexSecretValues)) as Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Outbound obfuscation (local → provider)
// ═══════════════════════════════════════════════════════════════════════════

type UserFacingMessage = Extract<Message, { role: "user" | "developer" | "toolResult" }>;

/** Obfuscate `text` blocks of a content array; image and other blocks pass through. */
function obfuscateTextBlocks(
	obfuscator: SecretObfuscator,
	content: (TextContent | ImageContent)[],
	sharedRegexSecretValues?: ReadonlySet<string>,
): (TextContent | ImageContent)[] {
	let changed = false;
	const result = content.map((block): TextContent | ImageContent => {
		if (block.type !== "text") return block;
		const text = obfuscator.obfuscate(block.text, sharedRegexSecretValues);
		if (text === block.text) return block;
		changed = true;
		return { ...block, text };
	});
	return changed ? result : content;
}

/** Restore placeholders in `text` blocks of a content array; image and other blocks pass through. */
function deobfuscateTextBlocks(
	obfuscator: SecretObfuscator,
	content: (TextContent | ImageContent)[],
): (TextContent | ImageContent)[] {
	let changed = false;
	const result = content.map((block): TextContent | ImageContent => {
		if (block.type !== "text") return block;
		const text = obfuscator.deobfuscate(block.text);
		if (text === block.text) return block;
		changed = true;
		return { ...block, text };
	});
	return changed ? result : content;
}

/**
 * Re-obfuscate assistant content before it returns to a provider after session
 * restoration, removing friendly prefixes made unsafe by this batch. A changed
 * thinking block loses its byte-bound replay signature.
 */
function obfuscateAssistantContentForReplay(
	obfuscator: SecretObfuscator,
	content: AssistantMessage["content"],
	sharedRegexSecretValues: ReadonlySet<string>,
): AssistantMessage["content"] {
	const obfuscate = (text: string): string =>
		obfuscator.stripUnsafeFriendlyPlaceholderPrefixes(
			obfuscator.obfuscate(text, sharedRegexSecretValues),
			sharedRegexSecretValues,
		);
	let changed = false;
	const result = content.map((block): AssistantMessage["content"][number] => {
		if (block.type === "text") {
			const text = obfuscate(block.text);
			if (text === block.text) return block;
			changed = true;
			return { ...block, text };
		}
		if (block.type === "thinking") {
			const thinking = obfuscate(block.thinking);
			if (thinking === block.thinking) return block;
			changed = true;
			return { ...block, thinking, thinkingSignature: undefined };
		}
		if (block.type === "toolCall") {
			const args = mapJsonStrings(block.arguments as JsonValue, obfuscate) as Record<string, unknown>;
			const intent = block.intent === undefined ? undefined : obfuscate(block.intent);
			const rawBlock = block.rawBlock === undefined ? undefined : obfuscate(block.rawBlock);
			if (args === block.arguments && intent === block.intent && rawBlock === block.rawBlock) return block;
			changed = true;
			return { ...block, arguments: args, intent, rawBlock };
		}
		return block;
	});
	return changed ? result : content;
}

function collectMessageRegexSecretValues(obfuscator: SecretObfuscator, messages: Message[]): Set<string> {
	const values = new Set<string>();
	const addText = (text: string | undefined): void => {
		if (text === undefined) return;
		for (const value of obfuscator.collectRegexSecretValuesForObfuscation(text)) {
			values.add(value);
		}
	};
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "text") addText(block.text);
				else if (block.type === "thinking") addText(block.thinking);
				else if (block.type === "toolCall") {
					for (const value of collectJsonRegexSecretValues(obfuscator, block.arguments as JsonValue)) {
						values.add(value);
					}
					addText(block.intent);
					addText(block.rawBlock);
				}
			}
			continue;
		}
		if (
			message.role !== "user" &&
			message.role !== "toolResult" &&
			!(message.role === "developer" && message.attribution === "user")
		) {
			continue;
		}
		const target = message as UserFacingMessage;
		if (typeof target.content === "string") {
			addText(target.content);
			continue;
		}
		for (const block of target.content) {
			if (block.type === "text") addText(block.text);
		}
	}
	return values;
}

/**
 * Redact secrets from outbound messages. User messages, tool results, and
 * user-authored developer messages (e.g. `@file` mentions) are obfuscated.
 * Assistant replay content is re-obfuscated too, because session restoration
 * expands keyed placeholders locally before the next provider request. Inline
 * image bytes are never walked.
 */
export function obfuscateMessages(obfuscator: SecretObfuscator, messages: Message[]): Message[] {
	if (!obfuscator.hasSecrets()) return messages;
	const sharedRegexSecretValues = collectMessageRegexSecretValues(obfuscator, messages);
	let changed = false;
	const result = messages.map((message): Message => {
		if (
			message.role !== "user" &&
			message.role !== "toolResult" &&
			!(message.role === "developer" && message.attribution === "user")
		) {
			if (message.role !== "assistant") return message;
			const content = obfuscateAssistantContentForReplay(obfuscator, message.content, sharedRegexSecretValues);
			if (content === message.content) return message;
			changed = true;
			return { ...message, content };
		}
		const target = message as UserFacingMessage;
		if (typeof target.content === "string") {
			const content = obfuscator.obfuscate(target.content, sharedRegexSecretValues);
			if (content === target.content) return message;
			changed = true;
			return { ...target, content } as Message;
		}
		const content = obfuscateTextBlocks(obfuscator, target.content, sharedRegexSecretValues);
		if (content === target.content) return message;
		changed = true;
		return { ...target, content } as Message;
	});
	return changed ? result : messages;
}

/**
 * Redact outbound provider context. Only conversation messages are rewritten;
 * the static system prompt and tool schemas pass through unchanged.
 */
export function obfuscateProviderContext(obfuscator: SecretObfuscator | undefined, context: Context): Context {
	if (!obfuscator?.hasSecrets()) return context;
	const messages = obfuscateMessages(obfuscator, context.messages);
	return messages === context.messages ? context : { ...context, messages };
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

// Like the untracked walk, but threads a parallel `origin` tag string through:
// preserved placeholder spans keep their existing origin tag (so a
// same-call-fresh "F" placeholder is never relabeled prior-call "I", and vice
// versa), while `transform`'s output — always freshly generated or redacted
// content in both callers below — is tagged "I" (it must not be re-matched as
// though it arrived in the input, mirroring plain-secret replacement tagging).
function transformOutsidePlaceholdersTracked(
	text: string,
	origin: string,
	shouldSkipPlaceholder: (placeholder: string) => boolean,
	transform: (chunk: string) => string,
	preservePlaceholder?: (placeholder: string) => string,
): { text: string; origin: string } {
	PLACEHOLDER_RE.lastIndex = 0;
	let result = "";
	let resultOrigin = "";
	let pendingIndex = 0;
	for (;;) {
		const match = PLACEHOLDER_RE.exec(text);
		if (match === null) break;
		if (!shouldSkipPlaceholder(match[0])) {
			resumePlaceholderScanAfterRejectedCandidate(match);
			continue;
		}
		const transformed = transform(text.slice(pendingIndex, match.index));
		result += transformed;
		resultOrigin += "I".repeat(transformed.length);
		const preserved = preservePlaceholder ? preservePlaceholder(match[0]) : match[0];
		result += preserved;
		resultOrigin += origin.slice(match.index, match.index + match[0].length);
		pendingIndex = match.index + match[0].length;
	}
	const trailing = transform(text.slice(pendingIndex));
	result += trailing;
	resultOrigin += "I".repeat(trailing.length);
	return { text: result, origin: resultOrigin };
}

function trailingOutsidePreservedPlaceholderChunk(
	text: string,
	shouldPreservePlaceholder: (placeholder: string) => boolean,
): string {
	PLACEHOLDER_RE.lastIndex = 0;
	let pendingIndex = 0;
	let sawPlaceholder = false;
	for (;;) {
		const match = PLACEHOLDER_RE.exec(text);
		if (match === null) break;
		if (!shouldPreservePlaceholder(match[0])) {
			resumePlaceholderScanAfterRejectedCandidate(match);
			continue;
		}
		sawPlaceholder = true;
		pendingIndex = match.index + match[0].length;
	}
	return sawPlaceholder ? text.slice(pendingIndex) : "";
}

function buildReplaceRegexScan(
	text: string,
	ranges: ReadonlyArray<{ start: number; end: number }>,
	deobfuscateMap: ReadonlyMap<string, { secret: string; recursive: boolean }>,
): ReplaceRegexScan {
	let scanText = "";
	let cursor = 0;
	const segments: RegexScanSegment[] = [];
	const appendSegment = (
		value: string,
		textStart: number,
		textEnd: number,
		generatedPlaceholder: boolean,
		recursive: boolean,
	) => {
		if (value.length === 0) return;
		const scanStart = scanText.length;
		scanText += value;
		segments.push({
			scanStart,
			scanEnd: scanStart + value.length,
			textStart,
			textEnd,
			generatedPlaceholder,
			recursive,
		});
	};

	for (const range of ranges) {
		appendSegment(text.slice(cursor, range.start), cursor, range.start, false, false);
		const placeholder = text.slice(range.start, range.end);
		const mapping = lookupFriendlyPlaceholderAlias(deobfuscateMap, placeholder);
		appendSegment(mapping?.secret ?? placeholder, range.start, range.end, true, mapping?.recursive ?? false);
		cursor = range.end;
	}
	appendSegment(text.slice(cursor), cursor, text.length, false, false);

	return { text: scanText, segments };
}

function mapReplaceRegexMatch(
	segments: ReadonlyArray<RegexScanSegment>,
	scanStart: number,
	scanEnd: number,
): {
	start: number;
	end: number;
	recursive: boolean;
	preserveGeneratedPlaceholders: boolean;
	partialPlaceholderCut: boolean;
	cutResumeIndex: number;
	firstPlaceholderScanStart: number;
} {
	const startSegment = findScanSegment(segments, scanStart);
	const endSegment = findScanSegment(segments, scanEnd - 1);
	const start = startSegment.generatedPlaceholder
		? startSegment.textStart
		: startSegment.textStart + (scanStart - startSegment.scanStart);
	const end = endSegment.generatedPlaceholder
		? endSegment.textEnd
		: endSegment.textStart + (scanEnd - endSegment.scanStart);
	// A match boundary that falls strictly inside a generated placeholder's
	// expanded value cuts the underlying secret: the snap above pulls the span out
	// to the whole `#…#` token, so the obfuscate path can leave it alone instead of
	// consuming a partial placeholder expansion.
	const partialPlaceholderCut =
		(startSegment.generatedPlaceholder && scanStart > startSegment.scanStart) ||
		(endSegment.generatedPlaceholder && scanEnd < endSegment.scanEnd);
	let recursive = false;
	let preserveGeneratedPlaceholders = false;
	// When the match straddles a placeholder, resume scanning just past the last
	// overlapping placeholder so trailing wholly-outside content (e.g. an 8-char
	// run after the secret) still gets matched instead of being consumed by the
	// straddling span. `firstPlaceholderScanStart` marks where the leading
	// wholly-outside prefix ends, so a prefix that independently matches can be
	// redacted on its own rather than skipped along with the cut span.
	let cutResumeIndex = scanStart;
	let firstPlaceholderScanStart = -1;
	for (const segment of segments) {
		if (segment.scanStart >= scanEnd || segment.scanEnd <= scanStart) continue;
		recursive ||= segment.recursive;
		preserveGeneratedPlaceholders ||= segment.generatedPlaceholder;
		if (segment.generatedPlaceholder) {
			if (firstPlaceholderScanStart === -1) firstPlaceholderScanStart = segment.scanStart;
			if (segment.scanEnd > cutResumeIndex) cutResumeIndex = segment.scanEnd;
		}
	}
	return {
		start,
		end,
		recursive,
		preserveGeneratedPlaceholders,
		partialPlaceholderCut,
		cutResumeIndex,
		firstPlaceholderScanStart,
	};
}

function findScanSegment(segments: ReadonlyArray<RegexScanSegment>, scanIndex: number): RegexScanSegment {
	for (const segment of segments) {
		if (scanIndex >= segment.scanStart && scanIndex < segment.scanEnd) return segment;
	}
	throw new Error("正则匹配无法映射到源文本");
}

/**
 * Extend a scan-space resume position past a consecutive run of generated
 * placeholder segments starting exactly at it, with no raw gap in between. A
 * cut-resolution resume point that happens to land precisely on the START of
 * ANOTHER placeholder must not stop there and hand it to a fresh `regex.exec`
 * attempt — the same content, scanned as an opaque adjacent placeholder run,
 * must resolve identically whether the run's LEADING member is still raw text
 * (this call is about to placeholder it) or is ALREADY a placeholder from a
 * prior call or an earlier pass of this same call. Without this, a bounded
 * regex whose reach spans two adjacent secrets plus trailing spillover bytes
 * (e.g. `[A-Z]{9}` over `ABCDEFGH` + `SECRETUV` + `A`) resolves the leading
 * secret as its own independent redaction on the FIRST obfuscate() call (a
 * genuinely raw prefix gets its own match, then the discard for the rest
 * resumes right after it), but on a LATER call — once that prefix is itself a
 * placeholder — the very first match attempt starts already inside the
 * placeholder run, cannot be prefix-narrowed at all, and its discard resume
 * point lands mid-run instead of past it, exposing a shorter tail (`SECRETUV`
 * + `A`) to a clean, un-cut match the first call never attempted. Chaining the
 * resume point through every immediately-adjacent placeholder makes both
 * calls land on the exact same next scan position.
 */
function extendPastAdjacentPlaceholders(segments: ReadonlyArray<RegexScanSegment>, index: number): number {
	let cursor = index;
	for (;;) {
		const segment = segments.find(candidate => candidate.scanStart === cursor && candidate.generatedPlaceholder);
		if (!segment) return cursor;
		cursor = segment.scanEnd;
	}
}

// Apply a fixed custom replacement across a matched span while preserving any
// inner generated placeholders. Usually the replacement is the user's single
// redaction marker for the whole match, so emit it for the first non-empty
// surrounding chunk and drop later chunks. But bounded regexes can cut through
// an already-emitted marker on the trailing side (`X#…#RED` from
// `XSECRETUVREDACTED`), where dropping the later prefix would leave raw bytes
// (`ACTED`) to be consumed on the next pass. Promote later chunks that are a
// prefix of the replacement to the FULL marker so the first pass is already a
// fixed point. The reversible placeholder stays intact in its relative
// position.
function redactWithFixedReplacementOutsidePlaceholders(
	text: string,
	origin: string,
	replacement: string,
	shouldPreservePlaceholder: (placeholder: string) => boolean,
): { text: string; origin: string } {
	let emitted = false;
	return transformOutsidePlaceholdersTracked(
		text,
		origin,
		shouldPreservePlaceholder,
		chunk => {
			if (chunk.length === 0) return "";
			if (!emitted) {
				emitted = true;
				return replacement;
			}
			return replacement.startsWith(chunk) ? replacement : "";
		},
		placeholder => placeholder,
	);
}

function deobfuscateGeneratedPlaceholderRanges(
	text: string,
	start: number,
	end: number,
	ranges: ReadonlyArray<{ start: number; end: number }>,
	deobfuscateMap: ReadonlyMap<string, { secret: string; recursive: boolean }>,
): { text: string; recursive: boolean } {
	let result = "";
	let cursor = start;
	let recursive = false;
	for (const range of ranges) {
		if (range.end <= start || range.start >= end) continue;
		const overlapStart = Math.max(range.start, start);
		const overlapEnd = Math.min(range.end, end);
		result += text.slice(cursor, overlapStart);
		const placeholder = text.slice(overlapStart, overlapEnd);
		const mapping = lookupFriendlyPlaceholderAlias(deobfuscateMap, placeholder);
		result += mapping?.secret ?? placeholder;
		recursive ||= mapping?.recursive ?? false;
		cursor = overlapEnd;
	}
	result += text.slice(cursor, end);
	return { text: result, recursive };
}

// Concatenate ONLY the deobfuscated placeholder ranges within [start, end),
// dropping the bytes that lie outside them. Used to test whether a regex match
// that straddles a prior-call placeholder would still match on the placeholder's
// own (expanded) secret value alone — i.e. the surrounding raw bytes are greedy
// spillover the match does not need, rather than content the match depends on.
function placeholderInnerText(
	text: string,
	start: number,
	end: number,
	ranges: ReadonlyArray<{ start: number; end: number }>,
	deobfuscateMap: ReadonlyMap<string, { secret: string; recursive: boolean }>,
): string {
	let result = "";
	for (const range of ranges) {
		if (range.end <= start || range.start >= end) continue;
		const overlapStart = Math.max(range.start, start);
		const overlapEnd = Math.min(range.end, end);
		const placeholder = text.slice(overlapStart, overlapEnd);
		const mapping = lookupFriendlyPlaceholderAlias(deobfuscateMap, placeholder);
		result += mapping?.secret ?? placeholder;
	}
	return result;
}

// Concatenate the bytes of [start, end) that lie OUTSIDE the given (ascending,
// non-overlapping) placeholder ranges. Used to test whether a regex match that
// straddles a prior-call placeholder would still match on its surrounding bytes
// alone — i.e. those bytes are genuinely new content to redact rather than a
// match that only exists because the deobfuscated placeholder bridges them.
function textOutsidePlaceholderRanges(
	text: string,
	start: number,
	end: number,
	ranges: ReadonlyArray<{ start: number; end: number }>,
): string {
	let result = "";
	let cursor = start;
	for (const range of ranges) {
		if (range.end <= start || range.start >= end) continue;
		const overlapStart = Math.max(range.start, start);
		const overlapEnd = Math.min(range.end, end);
		result += text.slice(cursor, overlapStart);
		cursor = overlapEnd;
	}
	result += text.slice(cursor, end);
	return result;
}

// Like `textOutsidePlaceholderRanges`, but tests each outside chunk against
// `regex` in its REAL context instead of on an isolated slice — tried in BOTH
// the literal `#…#` placeholder-token text AND the EXPANDED scan context
// (placeholder resolved to its secret value), since either can be the reason a
// chunk independently requires redaction:
//  - Literal-token context matters when the placeholder TOKEN's own non-word
//    boundary is what completes a boundary-sensitive pattern, e.g. a prefix
//    "ABCDEFGH" next to a placeholder token matches `\b[A-Z]{8}\b` because the
//    token's leading `#` is a non-word byte — but that boundary disappears
//    once the placeholder expands into more `[A-Z]` bytes with no separator.
//  - Expanded scan context matters when a lookbehind/lookahead only resolves
//    once the neighboring placeholder is expanded, e.g. a prior plain
//    placeholder for `ABCDEFGH` next to raw `SECRET`, matched by
//    `(?<=ABCDEFGH)SECRET`: the literal placeholder token before `SECRET`
//    never satisfies the lookbehind, so literal-context alone wrongly reports
//    no independent match.
// A match only counts when it lies ENTIRELY within one outside chunk (in
// whichever context it was tested); a match that reaches into the
// placeholder itself is not evidence the outside chunk independently
// requires redaction.
function outsidePlaceholderRangesAnyIndependentlyMatch(
	text: string,
	scanText: string,
	segments: ReadonlyArray<RegexScanSegment>,
	start: number,
	end: number,
	ranges: ReadonlyArray<{ start: number; end: number }>,
	regex: RegExp,
): boolean {
	// A text-space outside chunk lies entirely within one non-placeholder scan
	// segment (placeholder ranges are exactly the gaps between such segments),
	// so its scan-space span is a fixed offset from its text-space span.
	const toScanSpace = (chunkStart: number, chunkEnd: number): [number, number] | undefined => {
		for (const segment of segments) {
			if (segment.generatedPlaceholder || segment.textStart > chunkStart || segment.textEnd < chunkEnd) continue;
			const offset = segment.scanStart - segment.textStart;
			return [chunkStart + offset, chunkEnd + offset];
		}
		return undefined;
	};
	const chunkIndependentlyMatches = (chunkStart: number, chunkEnd: number): boolean => {
		if (chunkMatchesInSourceContext(text, chunkStart, chunkEnd, regex)) return true;
		const scanSpan = toScanSpace(chunkStart, chunkEnd);
		return scanSpan !== undefined && chunkMatchesInSourceContext(scanText, scanSpan[0], scanSpan[1], regex);
	};
	let cursor = start;
	for (const range of ranges) {
		if (range.end <= start || range.start >= end) continue;
		const overlapStart = Math.max(range.start, start);
		const overlapEnd = Math.min(range.end, end);
		if (cursor < overlapStart && chunkIndependentlyMatches(cursor, overlapStart)) return true;
		cursor = overlapEnd;
	}
	return cursor < end && chunkIndependentlyMatches(cursor, end);
}

// Whether `regex` (global) has a match fully contained in [chunkStart, chunkEnd)
// when run against the full `text` — so lookbehind/lookahead see the actual
// surrounding bytes rather than an isolated slice's edges.
function chunkMatchesInSourceContext(text: string, chunkStart: number, chunkEnd: number, regex: RegExp): boolean {
	regex.lastIndex = chunkStart;
	for (;;) {
		const found = regex.exec(text);
		if (found === null || found.index >= chunkEnd) return false;
		const matchEnd = found.index + found[0].length;
		if (matchEnd <= chunkEnd) return true;
		regex.lastIndex = found[0].length === 0 ? found.index + 1 : matchEnd;
	}
}

function firstOutsidePlaceholderRange(
	start: number,
	end: number,
	ranges: ReadonlyArray<{ start: number; end: number }>,
): { start: number; end: number } | undefined {
	let cursor = start;
	for (const range of ranges) {
		if (range.end <= start || range.start >= end) continue;
		const overlapStart = Math.max(range.start, start);
		const overlapEnd = Math.min(range.end, end);
		if (cursor < overlapStart) return { start: cursor, end: overlapStart };
		cursor = overlapEnd;
	}
	return cursor < end ? { start: cursor, end } : undefined;
}

function countOutsidePlaceholderRanges(
	start: number,
	end: number,
	ranges: ReadonlyArray<{ start: number; end: number }>,
): number {
	let count = 0;
	let cursor = start;
	for (const range of ranges) {
		if (range.end <= start || range.start >= end) continue;
		const overlapStart = Math.max(range.start, start);
		const overlapEnd = Math.min(range.end, end);
		if (cursor < overlapStart) count++;
		cursor = overlapEnd;
	}
	if (cursor < end) count++;
	return count;
}

function replaceRange(text: string, start: number, end: number, replacement: string): string {
	return text.slice(0, start) + replacement + text.slice(end);
}

/** Deep-walk an object, transforming all string values. */
function deepWalkStrings<T>(obj: T, transform: (s: string) => string): T {
	if (typeof obj === "string") {
		return transform(obj) as unknown as T;
	}
	if (Array.isArray(obj)) {
		let changed = false;
		const result = obj.map(item => {
			const transformed = deepWalkStrings(item, transform);
			if (transformed !== item) changed = true;
			return transformed;
		});
		return (changed ? result : obj) as unknown as T;
	}
	if (obj !== null && typeof obj === "object" && isPlainRecord(obj)) {
		let changed = false;
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(obj)) {
			const value = (obj as Record<string, unknown>)[key];
			const transformed = deepWalkStrings(value, transform);
			if (transformed !== value) changed = true;
			result[key] = transformed;
		}
		return (changed ? result : obj) as T;
	}
	return obj;
}

function isPlainRecord(obj: object): obj is Record<string, unknown> {
	const prototype = Object.getPrototypeOf(obj);
	return prototype === Object.prototype || prototype === null;
}

function collectJsonRegexSecretValues(obfuscator: SecretObfuscator, value: JsonValue): Set<string> {
	const values = new Set<string>();
	const collect = (item: JsonValue): void => {
		if (typeof item === "string") {
			for (const secretValue of obfuscator.collectRegexSecretValuesForObfuscation(item)) {
				values.add(secretValue);
			}
			return;
		}
		if (Array.isArray(item)) {
			for (const child of item) collect(child);
			return;
		}
		if (item !== null && typeof item === "object") {
			for (const child of Object.values(item)) {
				if (child !== undefined) collect(child);
			}
		}
	};
	collect(value);
	return values;
}

/**
 * Map every string in arbitrary JSON. Used ONLY for tool-call arguments, whose
 * shape is model-authored and not known ahead of time. No other caller may walk
 * untyped data: every message/content path is handled by a typed transformer.
 */
function mapJsonStrings(value: JsonValue, fn: (s: string) => string): JsonValue {
	if (typeof value === "string") return fn(value);
	if (Array.isArray(value)) {
		let changed = false;
		const out = value.map(item => {
			const next = mapJsonStrings(item, fn);
			if (next !== item) changed = true;
			return next;
		});
		return changed ? out : value;
	}
	if (value !== null && typeof value === "object") {
		let changed = false;
		const out: JsonRecord = {};
		for (const key of Object.keys(value)) {
			const item = value[key];
			if (item === undefined) continue;
			const next = mapJsonStrings(item, fn);
			if (next !== item) changed = true;
			out[key] = next;
		}
		return changed ? out : value;
	}
	return value;
}
