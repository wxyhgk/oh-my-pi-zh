import {
	type ObjectOpts,
	Type as OmpType,
	type TypeBuilder as OmpTypeBuilder,
	type TUnsafe,
} from "@oh-my-pi/omptype/typebox";
import { upgradeJsonSchemaTo202012, validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema";

export * from "@oh-my-pi/omptype/typebox";

const VALIDATION_FAILURE = Symbol("pi.typebox.validationFailure");

interface ValidationFailure {
	message: string;
	readonly [VALIDATION_FAILURE]: true;
}

interface SafeParseSuccess<T> {
	success: true;
	data: T;
}

interface SafeParseFailure {
	success: false;
	error: ValidationFailure;
}

type LegacyUnsafeSchema<T> = Record<string, unknown> &
	TUnsafe<T> & {
		__validator(data: unknown): T | ValidationFailure;
		safeParse(input: unknown): SafeParseSuccess<T> | SafeParseFailure;
	};

function defineHidden(target: object, key: PropertyKey, value: unknown): void {
	Object.defineProperty(target, key, {
		value,
		writable: true,
		configurable: true,
	});
}

function unsafe<T = unknown>(jsonSchema: Record<string, unknown> = {}): LegacyUnsafeSchema<T> {
	const schema = { ...jsonSchema } as LegacyUnsafeSchema<T>;
	const upgradedSchema = upgradeJsonSchemaTo202012(jsonSchema);
	const validate = (data: unknown): T | ValidationFailure => {
		const result = validateJsonSchemaValue(upgradedSchema, data);
		if (result.success) return data as T;
		let message = "";
		for (const issue of result.issues) {
			if (message) message += "; ";
			message += issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
		}
		const failure = { message: message || "无效值" } as ValidationFailure;
		defineHidden(failure, VALIDATION_FAILURE, true);
		return failure;
	};
	defineHidden(schema, "__validator", validate);
	defineHidden(schema, "safeParse", (input: unknown): SafeParseSuccess<T> | SafeParseFailure => {
		const result = validate(input);
		return typeof result === "object" && result !== null && VALIDATION_FAILURE in result
			? { success: false, error: result }
			: { success: true, data: result as T };
	});
	return schema;
}

const object = ((properties: Record<string, unknown>, opts?: ObjectOpts) => {
	let hasRawProperty = false;
	for (const key in properties) {
		if (typeof properties[key] !== "function") {
			hasRawProperty = true;
			break;
		}
	}
	if (!hasRawProperty) return OmpType.Object(properties as Parameters<typeof OmpType.Object>[0], opts);

	const propertySchemas: Record<string, unknown> = {};
	const required: string[] = [];
	for (const key in properties) {
		const property = properties[key];
		propertySchemas[key] =
			typeof property === "function" && "toJsonSchema" in property
				? (property as { toJsonSchema(): Record<string, unknown> }).toJsonSchema()
				: property;
		required.push(key);
	}
	const document: Record<string, unknown> = { type: "object", properties: propertySchemas, required };
	if (opts?.additionalProperties !== undefined) {
		document.additionalProperties =
			typeof opts.additionalProperties === "function"
				? opts.additionalProperties.toJsonSchema()
				: opts.additionalProperties;
	}
	return unsafe(document);
}) as typeof OmpType.Object;

export const Type: OmpTypeBuilder = { ...OmpType, Object: object, Unsafe: unsafe } as unknown as OmpTypeBuilder;
export type TypeBuilder = OmpTypeBuilder;

const legacyTypeBox: { Type: OmpTypeBuilder } = { Type };
export default legacyTypeBox;
