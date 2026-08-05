/**
 * Pipeline: fixture definitions select equivalent hand-written Zod v4 schemas;
 * generated compile/cold definitions build the same fixed shape. Validation uses
 * safeParse, returning `success.data` (including defaults/stripping) or ZodError.
 */
import { z } from "zod/v4";
import type { Candidate } from "../candidate";
import type { Def } from "../ir";

const flatSmall = z.object({
	path: z.string(),
	offset: z.number().int().min(1).optional(),
	limit: z.number().int().optional(),
});
const enumUnion = z.object({
	op: z.enum(["start", "stop", "restart", "send", "wait", "logs"]),
	timeout: z.number().gt(0).max(3600).optional(),
	pty: z.boolean().optional(),
});
const nestedArrays = z.object({
	context: z.string(),
	tasks: z.array(
		z.object({
			name: z.string().min(1).max(32).optional(),
			agent: z.string().optional(),
			task: z.string(),
			schemaMode: z.enum(["permissive", "strict"]).optional(),
		}),
	),
});
const strictDefaults = z
	.object({
		action: z.enum(["list", "get", "put"]),
		key: z.string(),
		count: z.number().int().default(10),
		tags: z.array(z.string()).optional(),
	})
	.strict();
const deleteExtras = z
	.object({
		name: z.string(),
		level: z.enum(["low", "high"]).optional(),
	})
	.strip();
const recordMixed = z.object({
	env: z.record(z.string(), z.string()),
	args: z.array(z.union([z.string(), z.number()])).optional(),
	mode: z.enum(["a", "b", "c"]).optional(),
	verbose: z.union([z.boolean(), z.literal("auto")]).optional(),
});
const deepMessage = z.object({
	role: z.enum(["user", "assistant", "system"]),
	content: z.array(
		z.object({
			type: z.enum(["text", "image"]),
			text: z.string().optional(),
			data: z.string().optional(),
			cache: z.boolean().optional(),
		}),
	),
	stop: z.union([z.enum(["end", "tool", "length"]), z.null()]).optional(),
	usage: z.object({ input: z.number().min(0), output: z.number().min(0) }).optional(),
});

function buildGenerated(definition: Record<string, Def>): z.ZodType {
	let alpha = "";
	let beta = "";
	let gamma = "";
	for (const key in definition) {
		if (key.startsWith("alpha")) alpha = key;
		else if (key.startsWith("beta")) beta = key;
		else if (key.startsWith("gamma")) gamma = key;
	}
	if (!alpha || !beta || !gamma) throw new Error("unknown benchmark definition");
	const betaDefinition = definition[beta];
	const gammaDefinition = definition[gamma];
	if (typeof betaDefinition !== "string" || typeof gammaDefinition !== "string") {
		throw new Error("malformed generated definition");
	}
	const minimum = Number(betaDefinition.match(/>= (\d+)/)?.[1]);
	const literals = [...gammaDefinition.matchAll(/'([^']+)'/g)].map(match => match[1]);
	if (!Number.isFinite(minimum) || literals.length !== 2) throw new Error("malformed generated definition");
	return z.object({
		[alpha]: z.string(),
		[beta.slice(0, -1)]: z.number().int().min(minimum).optional(),
		[gamma]: z.enum([literals[0], literals[1]]),
		nested: z.object({ flag: z.boolean(), items: z.array(z.string()) }),
	});
}

function buildSchema(definition: Def): z.ZodType {
	if (typeof definition !== "object" || definition === null || Array.isArray(definition)) {
		throw new Error("benchmark candidates require object definitions");
	}
	const objectDefinition = definition as Record<string, Def>;
	if ("path" in objectDefinition) return flatSmall;
	if ("op" in objectDefinition) return enumUnion;
	if ("context" in objectDefinition) return nestedArrays;
	if ("action" in objectDefinition) return strictDefaults;
	if ("name" in objectDefinition) return deleteExtras;
	if ("env" in objectDefinition) return recordMixed;
	if ("role" in objectDefinition) return deepMessage;
	return buildGenerated(objectDefinition);
}

export const zodCandidate: Candidate = {
	name: "zod",
	type(definition) {
		const schema = buildSchema(definition);
		return (value: unknown) => {
			const result = schema.safeParse(value);
			return result.success ? result.data : result.error;
		};
	},
	allows(definition) {
		const schema = buildSchema(definition);
		return (value: unknown) => schema.safeParse(value).success;
	},
	isErrors: result => result instanceof z.ZodError,
	summary: result => (result instanceof z.ZodError ? z.prettifyError(result) : ""),
};
