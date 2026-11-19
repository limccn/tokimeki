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

import { pbkdf2Sync, randomBytes } from "node:crypto";

export const PASSCODE_DEFAULT_ITERATIONS = 100_000;
export const PASSCODE_SALT_BYTES = 16;
export const PASSCODE_HASH_BYTES = 32;

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
  /** Test-only deterministic salt. */
  readonly salt?: Uint8Array;
  /** Test-only iteration override (relay accepts 10k..200k). */
  readonly iterations?: number;
}

/** Derive the verifier sent in `hello.passcode`. */
export function createPasscodeVerifier(
  passcode: string,
  options: PasscodeVerifierOptions = {},
): PasscodeVerifier {
  const salt = options.salt ?? randomBytes(PASSCODE_SALT_BYTES);
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
