import { describe, expect, it } from "vitest";

import {
  createPasscodeVerifier,
  PASSCODE_DEFAULT_ITERATIONS,
  PASSCODE_SALT_BYTES,
} from "./passcode.js";

describe("createPasscodeVerifier", () => {
  it("matches the RFC 7914 PBKDF2-SHA256 vector", () => {
    const verifier = createPasscodeVerifier("password", {
      salt: Buffer.from("salt"),
      iterations: 1,
    });
    // PBKDF2-HMAC-SHA256("password", "salt", 1, 32)
    const expected = Buffer.from(
      "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b",
      "hex",
    ).toString("base64url");
    expect(verifier).toMatchObject({
      v: 1,
      kdf: "pbkdf2-sha256",
      salt: Buffer.from("salt").toString("base64url"),
      iterations: 1,
      hash: expected,
    });
  });

  it("uses a 16-byte random salt and 100k iterations by default", () => {
    const first = createPasscodeVerifier("correct horse battery staple");
    const second = createPasscodeVerifier("correct horse battery staple");
    expect(Buffer.from(first.salt, "base64url")).toHaveLength(PASSCODE_SALT_BYTES);
    expect(first.iterations).toBe(PASSCODE_DEFAULT_ITERATIONS);
    expect(Buffer.from(first.hash, "base64url")).toHaveLength(32);
    expect(first.salt).not.toBe(second.salt);
    expect(first.hash).not.toBe(second.hash);
  });
});
