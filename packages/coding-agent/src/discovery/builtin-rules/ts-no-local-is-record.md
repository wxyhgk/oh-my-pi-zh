---
description: "Never use isRecord"
condition:
  - "\\bfunction\\s+isRecord(?:\\s*<[^>]*>)?\\s*\\("
  - "\\b(?:const|let|var)\\s+isRecord\\b\\s*(?::[\\s\\S]{0,300}?)?=\\s*(?:async\\s+)?(?:function\\b|(?:<[^>\\n]*>\\s*)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*(?::[\\s\\S]{0,300}?)?=>)"
scope: "tool:edit(*.{ts,tsx,mts,cts}), tool:write(*.{ts,tsx,mts,cts})"
interruptMode: never
---

## Why it's wrong

- A `Record<string, unknown>` guard proves only an object, not its fields.
- It's either unnecessarily complicated, or not strong enough.
- Repeated guards hide the actual data contract from readers and TypeScript.

## Use

`isRecord` narrows values to `Record<string, unknown>`; each field remains `unknown`.

For network, config, IPC, persisted, or reused data shapes, parse once at the boundary with the project's schema validator and consume its named output type:

```typescript
const Config = z.object({ retries: z.number().int().nonnegative() });
type Config = z.infer<typeof Config>;

const config = Config.parse(raw);
```

If the runtime shape is uncertain, check the properties you use with `typeof`, `Array.isArray`, `in`, or a discriminant. If an existing invariant guarantees the shape, assert the named type at that boundary instead of duplicating a guard:

```typescript
const config = value as Config;
```

## Avoid

```typescript
function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object";
```

## Exceptions

A standalone package without a shared type-guard module may define its single canonical guard. Export it from the package's type-guard module; never recreate it at individual call sites.
