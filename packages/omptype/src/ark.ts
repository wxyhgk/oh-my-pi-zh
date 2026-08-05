/**
 * ArkType compatibility facade — `@wxyhgk/omptype/ark`.
 *
 * Lets code written against arktype keep its imports and names while running
 * on the omptype lazy-JIT runtime: swap `from "arktype"` for
 * `from "@wxyhgk/omptype/ark"` and nothing else changes. New code should
 * import `@wxyhgk/omptype` directly.
 *
 * Compatibility affordance: `ArkError` / `ArkErrors` alias `OmpError` /
 * `OmpErrors`. All schema builders, including recursive `scope()`, are
 * re-exported unchanged.
 */
import { OmpError, OmpErrors } from "./errors";

export * from "./index";

export const ArkError = OmpError;
export type ArkError = OmpError;
export const ArkErrors = OmpErrors;
export type ArkErrors = OmpErrors;
