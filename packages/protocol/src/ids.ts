import { z } from "zod";

import { MAX_CLIENT_ID_LENGTH, MAX_SESSION_ID_LENGTH } from "./constants.js";

/**
 * Session ID format: starts with an ASCII alphanumeric, then up to 63 of
 * `[A-Za-z0-9._-]`. The same shape is used for client IDs so that a client ID
 * always fits through `SNAPSHOT_TO`'s `targetLen: u8` field.
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidSessionId(value: string): boolean {
  return value.length <= MAX_SESSION_ID_LENGTH && SESSION_ID_PATTERN.test(value);
}

export function isValidClientId(value: string): boolean {
  return value.length <= MAX_CLIENT_ID_LENGTH && CLIENT_ID_PATTERN.test(value);
}

/** Zod schema for a session ID; reject with an actionable message. */
export const zSessionId = z
  .string()
  .regex(SESSION_ID_PATTERN, "session id must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");

/** Zod schema for a client ID; reject with an actionable message. */
export const zClientId = z
  .string()
  .regex(CLIENT_ID_PATTERN, "client id must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
