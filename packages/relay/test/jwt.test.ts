import { describe, expect, it, beforeEach } from "vitest";

import {
  __resetJwtCacheForTests,
  DEFAULT_JWT_AUDIENCE,
  type HostJwtClaims,
  type JwtAuthConfig,
  JWKS_REFRESH_MIN_INTERVAL_MS,
  looksLikeJwt,
  readJwtAuthConfig,
  selectHostCredential,
  verifyHostJwt,
} from "../src/jwt-auth.js";
import type { RelayEnv } from "../src/env.js";

// ---------------------------------------------------------------------------
// Helpers: ES256 key material and a JWT signer (P1363 r||s, like TokiAPI).
// ---------------------------------------------------------------------------

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeSegment(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

export interface TestKeyMaterial {
  readonly kid: string;
  readonly privateJwk: JsonWebKey;
  readonly publicJwk: Record<string, string>;
}

async function generateTestKey(kid: string): Promise<TestKeyMaterial> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as unknown as CryptoKeyPair;
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const publicJwk = {
    kty: "EC",
    crv: "P-256",
    x: privateJwk.x ?? "",
    y: privateJwk.y ?? "",
    kid,
    alg: "ES256",
    use: "sig",
  };
  return { kid, privateJwk, publicJwk };
}

async function signHostJwt(
  key: TestKeyMaterial,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "ES256", kid: key.kid, typ: "JWT" },
): Promise<string> {
  const signingInput = `${encodeSegment(header)}.${encodeSegment(payload)}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    await crypto.subtle.importKey("jwk", key.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
    ]),
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function baseConfig(overrides: Partial<JwtAuthConfig> = {}): JwtAuthConfig {
  return {
    jwksUrl: "https://tokiapi.test/api/tokimeki/jwks.json",
    issuer: "https://tokiapi.test",
    audience: "tokimeki-relay",
    jwksTtlSeconds: 3600,
    clockSkewSeconds: 60,
    ...overrides,
  };
}

const BASE_NOW_MS = 1_700_000_000_000;
const BASE_NOW_SECONDS = Math.floor(BASE_NOW_MS / 1000);

function validClaims(): Record<string, unknown> {
  return {
    iss: "https://tokiapi.test",
    aud: "tokimeki-relay",
    sub: "user-123",
    namespace: "abcde",
    token_use: "host",
    scope: "host",
    iat: BASE_NOW_SECONDS - 10,
    nbf: BASE_NOW_SECONDS - 10,
    exp: BASE_NOW_SECONDS + 3600,
    jti: "jti-1",
  };
}

// ---------------------------------------------------------------------------
// readJwtAuthConfig
// ---------------------------------------------------------------------------

describe("readJwtAuthConfig", () => {
  it("is disabled without a JWKS URL, blank or otherwise", () => {
    expect(readJwtAuthConfig({} as RelayEnv).status).toBe("disabled");
    expect(readJwtAuthConfig({ TOKIMEKI_JWT_JWKS_URL: "   " } as RelayEnv).status).toBe("disabled");
    expect(
      readJwtAuthConfig({ TOKIMEKI_JWT_JWKS_URL: " ", TOKIMEKI_JWT_ISSUER: "x" } as RelayEnv).status,
    ).toBe("disabled");
  });

  it("rejects non-https URLs, userinfo, and fragments", () => {
    for (const url of [
      "http://tokiapi.test/api/tokimeki/jwks.json",
      "https://user:pass@tokiapi.test/jwks.json",
      "https://tokiapi.test/jwks.json#frag",
      "not a url",
    ]) {
      const status = readJwtAuthConfig({
        TOKIMEKI_JWT_JWKS_URL: url,
        TOKIMEKI_JWT_ISSUER: "iss",
      } as RelayEnv);
      expect(status).toEqual({ status: "invalid", reason: "invalid_url" });
    }
  });

  it("allows https URLs with query strings and a path", () => {
    const status = readJwtAuthConfig({
      TOKIMEKI_JWT_JWKS_URL: "https://tokiapi.test/api/tokimeki/jwks.json?static=1",
      TOKIMEKI_JWT_ISSUER: "https://tokiapi.test",
    } as RelayEnv);
    expect(status.status).toBe("enabled");
  });

  it("requires a non-blank issuer when the URL is set", () => {
    for (const issuer of [undefined, "", "   "]) {
      const status = readJwtAuthConfig({
        TOKIMEKI_JWT_JWKS_URL: "https://tokiapi.test/jwks.json",
        TOKIMEKI_JWT_ISSUER: issuer,
      } as RelayEnv);
      expect(status).toEqual({ status: "invalid", reason: "missing_issuer" });
    }
    const tooLong = readJwtAuthConfig({
      TOKIMEKI_JWT_JWKS_URL: "https://tokiapi.test/jwks.json",
      TOKIMEKI_JWT_ISSUER: "i".repeat(513),
    } as RelayEnv);
    expect(tooLong).toEqual({ status: "invalid", reason: "missing_issuer" });
  });

  it("defaults the audience and clamps TTL/skew values", () => {
    const status = readJwtAuthConfig({
      TOKIMEKI_JWT_JWKS_URL: "https://tokiapi.test/jwks.json",
      TOKIMEKI_JWT_ISSUER: "iss",
    } as RelayEnv);
    if (status.status !== "enabled") throw new Error("expected enabled");
    expect(status.config.audience).toBe(DEFAULT_JWT_AUDIENCE);
    expect(status.config.jwksTtlSeconds).toBe(3600);
    expect(status.config.clockSkewSeconds).toBe(60);

    const clamped = readJwtAuthConfig({
      TOKIMEKI_JWT_JWKS_URL: "https://tokiapi.test/jwks.json",
      TOKIMEKI_JWT_ISSUER: "iss",
      TOKIMEKI_JWT_AUDIENCE: "",
      TOKIMEKI_JWT_JWKS_TTL_SECONDS: "10",
      TOKIMEKI_JWT_CLOCK_SKEW_SECONDS: "5000",
    } as RelayEnv);
    if (clamped.status !== "enabled") throw new Error("expected enabled");
    expect(clamped.config.audience).toBe(DEFAULT_JWT_AUDIENCE);
    expect(clamped.config.jwksTtlSeconds).toBe(60);
    expect(clamped.config.clockSkewSeconds).toBe(300);

    const skewZero = readJwtAuthConfig({
      TOKIMEKI_JWT_JWKS_URL: "https://tokiapi.test/jwks.json",
      TOKIMEKI_JWT_ISSUER: "iss",
      TOKIMEKI_JWT_CLOCK_SKEW_SECONDS: "0",
    } as RelayEnv);
    if (skewZero.status !== "enabled") throw new Error("expected enabled");
    expect(skewZero.config.clockSkewSeconds).toBe(0);

    const garbage = readJwtAuthConfig({
      TOKIMEKI_JWT_JWKS_URL: "https://tokiapi.test/jwks.json",
      TOKIMEKI_JWT_ISSUER: "iss",
      TOKIMEKI_JWT_JWKS_TTL_SECONDS: "not-a-number",
    } as RelayEnv);
    if (garbage.status !== "enabled") throw new Error("expected enabled");
    expect(garbage.config.jwksTtlSeconds).toBe(3600);
  });
});

// ---------------------------------------------------------------------------
// looksLikeJwt
// ---------------------------------------------------------------------------

describe("looksLikeJwt", () => {
  it("accepts a well-formed three-segment ES256 header", () => {
    const token = `${encodeSegment({ alg: "ES256", kid: "kd1" })}.${encodeSegment({
      sub: "u",
    })}.AAAA`;
    expect(looksLikeJwt(token)).toBe(true);
  });

  it("rejects malformed shapes", () => {
    expect(looksLikeJwt("")).toBe(false);
    expect(looksLikeJwt("a.b")).toBe(false);
    expect(looksLikeJwt("a.b.c.d")).toBe(false);
    expect(looksLikeJwt(`.${encodeSegment({ sub: "u" })}.AAAA`)).toBe(false);
    expect(looksLikeJwt(`${encodeSegment({ alg: "ES256", kid: "kd1" })}..AAAA`)).toBe(false);
    // Not base64url (+ and / are forbidden).
    expect(looksLikeJwt(`${encodeSegment({ alg: "ES256", kid: "kd1" })}+x.AAAA.AAAA`)).toBe(false);
    // Header not JSON.
    expect(looksLikeJwt("aW50ZXJuYWw.AAAA.AAAA")).toBe(false);
    // Header JSON but wrong alg / missing kid / oversized kid.
    expect(looksLikeJwt(`${encodeSegment({ alg: "none", kid: "kd1" })}.AAAA.AAAA`)).toBe(false);
    expect(looksLikeJwt(`${encodeSegment({ alg: "HS256", kid: "kd1" })}.AAAA.AAAA`)).toBe(false);
    expect(looksLikeJwt(`${encodeSegment({ alg: "ES256" })}.AAAA.AAAA`)).toBe(false);
    expect(looksLikeJwt(`${encodeSegment({ alg: "ES256", kid: "" })}.AAAA.AAAA`)).toBe(false);
    expect(
      looksLikeJwt(`${encodeSegment({ alg: "ES256", kid: "k".repeat(129) })}.AAAA.AAAA`),
    ).toBe(false);
    // Oversized token.
    const filler = "A".repeat(8192);
    expect(looksLikeJwt(`${filler}.AAAA.AAAA`)).toBe(false);
  });

  it("rejects ordinary namespace-token values", () => {
    expect(looksLikeJwt("test-namespace-token-team-a-0123456789")).toBe(false);
    expect(looksLikeJwt("test-master-token-abc")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyHostJwt
// ---------------------------------------------------------------------------

describe("verifyHostJwt", () => {
  let key: TestKeyMaterial;
  const jwks: Record<string, string> = {};

  beforeEach(async () => {
    __resetJwtCacheForTests();
    key = await generateTestKey("kd1");
    for (const [k, v] of Object.entries(key.publicJwk)) {
      jwks[k] = v;
    }
  });

  const fetchOnce = () => {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      impl: ((input: RequestInfo | URL) => {
        calls += 1;
        void input;
        return Promise.resolve(
          new Response(JSON.stringify({ keys: [jwks] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }) as typeof fetch,
    };
  };

  it("verifies a valid Host JWT and returns the claim set", async () => {
    const mock = fetchOnce();
    const token = await signHostJwt(key, validClaims());
    const result = await verifyHostJwt(token, baseConfig(), {
      nowMs: BASE_NOW_MS,
      fetchImpl: mock.impl,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const claims: HostJwtClaims = result.claims;
      expect(claims.iss).toBe("https://tokiapi.test");
      expect(claims.aud).toBe("tokimeki-relay");
      expect(claims.sub).toBe("user-123");
      expect(claims.namespace).toBe("abcde");
      expect(claims.tokenUse).toBe("host");
      expect(claims.scopes).toEqual(["host"]);
      expect(claims.jti).toBe("jti-1");
    }
    expect(mock.calls).toBe(1);
  });

  it("hits the JWKS cache within the TTL and refetches after expiry", async () => {
    const mock = fetchOnce();
    const token = await signHostJwt(key, validClaims());
    const config = baseConfig({ jwksTtlSeconds: 120 });
    const first = await verifyHostJwt(token, config, { nowMs: BASE_NOW_MS, fetchImpl: mock.impl });
    expect(first.ok).toBe(true);
    const second = await verifyHostJwt(token, config, {
      nowMs: BASE_NOW_MS + 60_000,
      fetchImpl: mock.impl,
    });
    expect(second.ok).toBe(true);
    expect(mock.calls).toBe(1);
    const third = await verifyHostJwt(token, config, {
      nowMs: BASE_NOW_MS + 121_000,
      fetchImpl: mock.impl,
    });
    expect(third.ok).toBe(true);
    expect(mock.calls).toBe(2);
  });

  it("rejects a wrong signature without leaking details", async () => {
    const otherKey = await generateTestKey("kd1");
    const token = await signHostJwt(otherKey, validClaims());
    const mock = fetchOnce();
    const result = await verifyHostJwt(token, baseConfig(), {
      nowMs: BASE_NOW_MS,
      fetchImpl: mock.impl,
    });
    expect(result).toEqual({ ok: false, reason: "signature_invalid" });
  });

  it("rejects unsupported algorithms before any network access", async () => {
    const token = await signHostJwt(key, validClaims(), { alg: "none", kid: "kd1" });
    const mock = fetchOnce();
    const result = await verifyHostJwt(token, baseConfig(), {
      nowMs: BASE_NOW_MS,
      fetchImpl: mock.impl,
    });
    expect(result).toEqual({ ok: false, reason: "unsupported_alg" });
    expect(mock.calls).toBe(0);

    const hs256 = await signHostJwt(key, validClaims(), { alg: "HS256", kid: "kd1" });
    const result2 = await verifyHostJwt(hs256, baseConfig(), {
      nowMs: BASE_NOW_MS,
      fetchImpl: mock.impl,
    });
    expect(result2).toEqual({ ok: false, reason: "unsupported_alg" });
    expect(mock.calls).toBe(0);
  });

  it("rejects an unknown kid and refreshes the JWKS once per gate interval", async () => {
    const mock = fetchOnce();
    const token = await signHostJwt(key, validClaims());
    // Prime the cache with a successful fetch for a different kid document.
    const primingKey = await generateTestKey("other");
    const primeFetch: typeof fetch = (input) => {
      void input;
      return Promise.resolve(
        new Response(JSON.stringify({ keys: [primingKey.publicJwk] }), { status: 200 }),
      );
    };
    const primed = await verifyHostJwt(token, baseConfig(), {
      nowMs: BASE_NOW_MS,
      fetchImpl: primeFetch,
    });
    expect(primed).toEqual({ ok: false, reason: "unknown_kid" });

    // Within the gate interval the unknown kid is not refetched.
    const gated = await verifyHostJwt(token, baseConfig(), {
      nowMs: BASE_NOW_MS + 1_000,
      fetchImpl: mock.impl,
    });
    expect(gated).toEqual({ ok: false, reason: "unknown_kid" });
    expect(mock.calls).toBe(0);

    // After the gate opens the refresh succeeds and the token verifies.
    const refreshed = await verifyHostJwt(token, baseConfig(), {
      nowMs: BASE_NOW_MS + JWKS_REFRESH_MIN_INTERVAL_MS + 1,
      fetchImpl: mock.impl,
    });
    expect(refreshed.ok).toBe(true);
    expect(mock.calls).toBe(1);
  });

  it("returns jwks_unavailable when the JWKS is unreachable and no cache exists", async () => {
    const failing: typeof fetch = (input) => {
      void input;
      return Promise.reject(new Error("down"));
    };
    const token = await signHostJwt(key, validClaims());
    const result = await verifyHostJwt(token, baseConfig(), {
      nowMs: BASE_NOW_MS,
      fetchImpl: failing,
    });
    expect(result).toEqual({ ok: false, reason: "jwks_unavailable" });
  });

  it("uses an unexpired cache when the JWKS goes down", async () => {
    const token = await signHostJwt(key, validClaims());
    const config = baseConfig({ jwksTtlSeconds: 3600 });
    const failing: typeof fetch = (input) => {
      void input;
      return Promise.reject(new Error("down"));
    };
    const working: typeof fetch = (input) => {
      void input;
      return Promise.resolve(new Response(JSON.stringify({ keys: [jwks] }), { status: 200 }));
    };
    const ok = await verifyHostJwt(token, config, { nowMs: BASE_NOW_MS, fetchImpl: working });
    expect(ok.ok).toBe(true);
    const cached = await verifyHostJwt(token, config, {
      nowMs: BASE_NOW_MS + 1_000,
      fetchImpl: failing,
    });
    expect(cached.ok).toBe(true);
  });

  it("fails closed on malformed JWKS documents", async () => {
    const token = await signHostJwt(key, validClaims());
    const documents: unknown[] = [
      { keys: [] },
      { keys: [{ ...jwks, kid: "a" }, { ...jwks, kid: "a" }] },
      { keys: [{ ...jwks, alg: "HS256" }] },
      { keys: [{ ...jwks, use: "enc" }] },
      { keys: [{ ...jwks, kty: "RSA" }] },
      { keys: [{ ...jwks, crv: "P-384" }] },
      { keys: [{ ...jwks, kid: "" }] },
      { keys: [{ ...jwks, x: "" }] },
      { keys: "nope" },
      { keys: Array.from({ length: 33 }, (_, index) => ({ ...jwks, kid: `k${index}` })) },
      "not-an-object",
    ];
    for (const document of documents) {
      __resetJwtCacheForTests();
      const impl: typeof fetch = (input) => {
        void input;
        return Promise.resolve(new Response(JSON.stringify(document), { status: 200 }));
      };
      const result = await verifyHostJwt(token, baseConfig(), {
        nowMs: BASE_NOW_MS,
        fetchImpl: impl,
      });
      expect(result).toEqual({ ok: false, reason: "jwks_unavailable" });
    }
  });

  it("rejects an oversized JWKS response", async () => {
    const token = await signHostJwt(key, validClaims());
    const impl: typeof fetch = (input) => {
      void input;
      return Promise.resolve(new Response("x".repeat(65 * 1024), { status: 200 }));
    };
    const result = await verifyHostJwt(token, baseConfig(), {
      nowMs: BASE_NOW_MS,
      fetchImpl: impl,
    });
    expect(result).toEqual({ ok: false, reason: "jwks_unavailable" });
  });

  it("enforces the claims matrix", async () => {
    const cases: Array<{ patch: Record<string, unknown>; expected: string; remove?: string[] }> = [
      { patch: { iss: "https://other.test" }, expected: "claims_invalid" },
      { patch: { aud: "other-relay" }, expected: "claims_invalid" },
      { patch: { aud: ["tokimeki-relay", "other"] }, expected: "ok" },
      { patch: { aud: ["other"] }, expected: "claims_invalid" },
      { patch: { aud: 42 }, expected: "claims_invalid" },
      { patch: { sub: "" }, expected: "claims_invalid" },
      { patch: { sub: "x".repeat(129) }, expected: "claims_invalid" },
      { patch: { namespace: "ABCD" }, expected: "claims_invalid" },
      { patch: { namespace: "abcd!" }, expected: "claims_invalid" },
      { patch: { namespace: ".abcd" }, expected: "claims_invalid" },
      { patch: { namespace: "abcd" }, expected: "ok" },
      { patch: { token_use: "session" }, expected: "claims_invalid" },
      { patch: { scope: "session" }, expected: "claims_invalid" },
      { patch: { scope: "host web" }, expected: "ok" },
      { patch: { scope: 1 }, expected: "claims_invalid" },
      { patch: { iat: BASE_NOW_SECONDS + 10_000 }, expected: "claims_invalid" },
      { patch: { iat: "old" }, expected: "claims_invalid" },
      { remove: ["iat"], patch: {}, expected: "claims_invalid" },
      { patch: { nbf: BASE_NOW_SECONDS + 10_000 }, expected: "claims_invalid" },
      { patch: { nbf: "soon" }, expected: "claims_invalid" },
      {
        patch: { iat: BASE_NOW_SECONDS - 100, exp: BASE_NOW_SECONDS - 61 },
        expected: "expired",
      },
      {
        patch: { iat: BASE_NOW_SECONDS - 100, exp: BASE_NOW_SECONDS - 60 },
        expected: "expired",
      },
      {
        patch: { iat: BASE_NOW_SECONDS - 100, exp: BASE_NOW_SECONDS - 59 },
        expected: "ok",
      },
      {
        patch: { iat: BASE_NOW_SECONDS - 100, exp: BASE_NOW_SECONDS - 120 },
        expected: "claims_invalid",
      },
      { patch: { exp: BASE_NOW_SECONDS + 59 }, expected: "ok" },
      { patch: { exp: validClaims().iat as number }, expected: "claims_invalid" },
      { patch: { exp: "soon" }, expected: "claims_invalid" },
      { remove: ["exp"], patch: {}, expected: "claims_invalid" },
      { patch: { jti: "x".repeat(129) }, expected: "claims_invalid" },
      { remove: ["jti"], patch: {}, expected: "ok" },
      { remove: ["nbf"], patch: {}, expected: "ok" },
    ];
    const mock = fetchOnce();
    for (const { patch, expected, remove } of cases) {
      __resetJwtCacheForTests();
      const claims: Record<string, unknown> = { ...validClaims() };
      for (const field of remove ?? []) {
        delete claims[field];
      }
      Object.assign(claims, patch);
      const token = await signHostJwt(key, claims);
      const result = await verifyHostJwt(token, baseConfig(), {
        nowMs: BASE_NOW_MS,
        fetchImpl: mock.impl,
      });
      if (expected === "ok") {
        expect(result.ok).toBe(true);
      } else {
        expect(result).toEqual({ ok: false, reason: expected });
      }
    }
  });

  it("rejects malformed token structures", async () => {
    const mock = fetchOnce();
    const malformed = [
      "",
      "one",
      "a.b",
      "a.b.c.d",
      "!!!.AAA.AAA",
      `${encodeSegment({ alg: "ES256", kid: "kd1" })}.not-base64!|.AAA`,
      `aW50.AAAA.AAAA`,
      `${encodeSegment({ alg: "ES256", kid: "kd1" })}.${encodeSegment({ sub: 1 })}.AAA`,
      `${encodeSegment({ alg: "ES256", kid: "kd1" })}.${encodeSegment({ sub: "u" })}.AAA!`,
    ];
    for (const token of malformed) {
      __resetJwtCacheForTests();
      const result = await verifyHostJwt(token, baseConfig(), {
        nowMs: BASE_NOW_MS,
        fetchImpl: mock.impl,
      });
      expect(result.ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// selectHostCredential
// ---------------------------------------------------------------------------

describe("selectHostCredential", () => {
  it("ignores Authorization entirely in disabled mode", () => {
    expect(selectHostCredential("disabled", null, null)).toEqual({ action: "none" });
    expect(selectHostCredential("disabled", null, "Bearer some-jwt")).toEqual({ action: "none" });
    expect(selectHostCredential("disabled", null, "Basic dXNlcjpwYXNz")).toEqual({
      action: "none",
    });
    expect(selectHostCredential("disabled", "tok", "Bearer some-jwt")).toEqual({
      action: "credential",
      value: "tok",
      carrier: "token",
    });
    expect(selectHostCredential("disabled", "", null)).toEqual({
      action: "unauthorized",
      reason: "empty_token_header",
    });
    // A malformed Bearer is not even parsed in disabled mode.
    expect(selectHostCredential("disabled", null, "Bearer ")).toEqual({ action: "none" });
  });

  it("handles the token-header-only cases in enabled mode", () => {
    expect(selectHostCredential("enabled", null, null)).toEqual({ action: "none" });
    expect(selectHostCredential("enabled", "tok", null)).toEqual({
      action: "credential",
      value: "tok",
      carrier: "token",
    });
    expect(selectHostCredential("enabled", "", null)).toEqual({
      action: "unauthorized",
      reason: "empty_token_header",
    });
  });

  it("arbitrates between the token header and a Bearer credential", () => {
    expect(selectHostCredential("enabled", "tok", "Bearer tok")).toEqual({
      action: "credential",
      value: "tok",
      carrier: "token",
    });
    expect(selectHostCredential("enabled", "tokA", "Bearer tokB")).toEqual({
      action: "unauthorized",
      reason: "ambiguous_credentials",
    });
    expect(selectHostCredential("enabled", null, "Bearer jwt")).toEqual({
      action: "credential",
      value: "jwt",
      carrier: "authorization",
    });
    expect(selectHostCredential("enabled", "", "Bearer jwt")).toEqual({
      action: "credential",
      value: "jwt",
      carrier: "authorization",
    });
    expect(selectHostCredential("enabled", null, "bearer jwt")).toEqual({
      action: "credential",
      value: "jwt",
      carrier: "authorization",
    });
  });

  it("ignores non-Bearer schemes and fails closed on malformed Bearer values", () => {
    expect(selectHostCredential("enabled", null, "Basic dXNlcjpwYXNz")).toEqual({ action: "none" });
    expect(selectHostCredential("enabled", null, "Bearer")).toEqual({
      action: "unauthorized",
      reason: "malformed_bearer",
    });
    expect(selectHostCredential("enabled", null, "Bearer   ")).toEqual({
      action: "unauthorized",
      reason: "malformed_bearer",
    });
    expect(selectHostCredential("enabled", null, "Bearer a b")).toEqual({
      action: "unauthorized",
      reason: "malformed_bearer",
    });
    expect(selectHostCredential("enabled", null, "Bearer a,b")).toEqual({
      action: "unauthorized",
      reason: "malformed_bearer",
    });
    expect(selectHostCredential("enabled", "tok", "Basic dXNlcjpwYXNz")).toEqual({
      action: "credential",
      value: "tok",
      carrier: "token",
    });
    expect(selectHostCredential("enabled", "tok", "Bearer")).toEqual({
      action: "credential",
      value: "tok",
      carrier: "token",
    });
    expect(selectHostCredential("enabled", "", "Bearer")).toEqual({
      action: "unauthorized",
      reason: "malformed_bearer",
    });
  });
});
