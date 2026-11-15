import { z } from "zod";

declare const U64_STRING_BRAND: unique symbol;

/**
 * Canonical decimal string for a u64 value.
 *
 * The wire format uses decimal strings for JSON u64 fields because JSON
 * numbers are IEEE-754 doubles. Binary frames use raw `u64BE`. TypeScript
 * callers work with `number` and convert through `toU64String` /
 * `u64StringToNumber`; v1 rejects values above `Number.MAX_SAFE_INTEGER`
 * instead of silently losing precision.
 */
export type U64String = string & { readonly [U64_STRING_BRAND]: "U64String" };

/** Canonical decimal form: `0` or a non-zero digit followed by digits. */
export const U64_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;

/** Largest u64 that JavaScript can represent exactly. */
export const U64_MAX_SAFE = Number.MAX_SAFE_INTEGER;

export function isU64String(value: unknown): value is U64String {
  return typeof value === "string" && U64_DECIMAL_PATTERN.test(value);
}

export function toU64String(value: number): U64String {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`u64 value must be a non-negative safe integer, got ${String(value)}`);
  }
  return String(value) as U64String;
}

export function u64StringToNumber(value: U64String | string): number {
  if (!isU64String(value)) {
    throw new RangeError(`invalid u64 decimal string: ${String(value)}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`u64 value exceeds Number.MAX_SAFE_INTEGER: ${value}`);
  }
  return parsed;
}

/**
 * Zod schema for a JSON u64 field.
 *
 * Accepts a canonical decimal string or a safe non-negative integer for
 * ergonomics, and normalizes both to a canonical decimal string so that
 * `encodeControlMessage` always emits the language-neutral representation.
 */
export const zU64String = z
  .union([
    z.string().regex(U64_DECIMAL_PATTERN, "expected a non-negative decimal u64 string"),
    z.number().int("expected an integer").nonnegative("expected a non-negative u64"),
  ])
  .refine(
    (value) =>
      typeof value === "string"
        ? Number(value) <= U64_MAX_SAFE
        : Number.isSafeInteger(value) && value <= U64_MAX_SAFE,
    "u64 value must not exceed Number.MAX_SAFE_INTEGER",
  )
  .transform((value) => (typeof value === "number" ? toU64String(value) : (value as U64String)));
