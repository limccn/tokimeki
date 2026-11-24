/**
 * Session passcode verifier (v1.2-D).
 *
 * The host never sends the plaintext passcode. It sends PBKDF2-SHA256
 * parameters plus the derived hash in `hello.passcode`; the relay stores the
 * verifier and checks viewer/listener submissions from
 * `X-Tokimeki-Passcode`.
 *
 * Parameters are fixed for v1: 100k iterations, 16-byte salt, 32-byte hash.
 * The relay accepts 10k..200k iterations so a future host can tune cost
 * without a protocol bump.
 */

import { createHash, pbkdf2Sync, randomBytes } from "node:crypto";

export const PASSCODE_DEFAULT_ITERATIONS = 100_000;
export const PASSCODE_SALT_BYTES = 16;
export const PASSCODE_HASH_BYTES = 32;
/**
 * Visible ASCII only and no characters that HTTP header parsing or the
 * supported shells would reinterpret (`$`, `%`, `!`, `^`, `&`, quotes,
 * whitespace). Keep this in sync with the TokiAPI hub's client-side check.
 */
export const PASSCODE_PATTERN = /^[A-Za-z0-9._~@#*+=:-]+$/;

export interface PasscodeVerifier {
  readonly v: 1;
  readonly kdf: "pbkdf2-sha256";
  /** base64url-encoded salt. */
  readonly salt: string;
  readonly iterations: number;
  /** base64url-encoded PBKDF2-SHA256 output. */
  readonly hash: string;
}

export interface PasscodeVerifierOptions {
  /** Explicit salt (tests). */
  readonly salt?: Uint8Array;
  /**
   * Session id used to derive a stable per-session salt. Required for hosts:
   * a random salt per process would make a host restart fail
   * `passcode_mismatch` until the session TTL purges.
   */
  readonly sessionId?: string;
  /** Test-only iteration override (relay accepts 10k..200k). */
  readonly iterations?: number;
}

/** Stable per-session PBKDF2 salt (host restart must reproduce the verifier). */
export function derivePasscodeSalt(sessionId: string): Uint8Array {
  return createHash("sha256")
    .update(`tokimeki-passcode-salt:v1:${sessionId}`)
    .digest()
    .subarray(0, PASSCODE_SALT_BYTES);
}

/** Derive the verifier sent in `hello.passcode`. */
export function createPasscodeVerifier(
  passcode: string,
  options: PasscodeVerifierOptions = {},
): PasscodeVerifier {
  if (!PASSCODE_PATTERN.test(passcode)) {
    throw new Error("TOKIMEKI_PASSCODE must use visible ASCII letters/digits and ._~@#*+=:- only");
  }
  const salt =
    options.salt ??
    (options.sessionId === undefined
      ? randomBytes(PASSCODE_SALT_BYTES)
      : derivePasscodeSalt(options.sessionId));
  const iterations = options.iterations ?? PASSCODE_DEFAULT_ITERATIONS;
  const hash = pbkdf2Sync(passcode, salt, iterations, PASSCODE_HASH_BYTES, "sha256");
  return {
    v: 1,
    kdf: "pbkdf2-sha256",
    salt: salt.toString("base64url"),
    iterations,
    hash: hash.toString("base64url"),
  };
}
