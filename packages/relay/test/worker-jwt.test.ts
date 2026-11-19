import { env, fetchMock, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { __resetJwtCacheForTests } from "../src/jwt-auth.js";
import { connectWorker, helloFor, MASTER_TOKEN, SESSION_TOKEN, TEAM_A_TOKEN } from "./helpers";

/**
 * Host JWT integration tests (namespace tokens + JWT bindings active).
 *
 * The JWKS endpoint (`https://tokiapi.test/api/tokimeki/jwks.json`) is mocked
 * once in `beforeAll` with a swappable responder; no outbound network access
 * happens.
 */

const JWKS_URL = "https://tokiapi.test/api/tokimeki/jwks.json";

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

interface TestKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: Record<string, string>;
}

let key: TestKey;
/**
 * Swapped per test. The persistent JWKS interceptor (registered in
 * `beforeAll`) delegates here; `null` means the route is unconfigured.
 */
let jwksResponder: (() => { statusCode: number; data: string }) | null = null;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as unknown as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  key = {
    kid: "test-kid-1",
    privateKey: pair.privateKey,
    publicJwk: {
      kty: "EC",
      crv: "P-256",
      x: jwk.x ?? "",
      y: jwk.y ?? "",
      kid: "test-kid-1",
      alg: "ES256",
      use: "sig",
    },
  };
  fetchMock.activate();
  fetchMock
    .get("https://tokiapi.test")
    .intercept({ path: "/api/tokimeki/jwks.json", method: "GET" })
    .reply(() => {
      const current = jwksResponder;
      if (current === null) {
        throw new Error("jwks route not configured for this test");
      }
      const result = current();
      return {
        statusCode: result.statusCode,
        data: result.data,
        responseOptions: { headers: { "content-type": "application/json" } },
      };
    })
    .times(1_000_000);
});

function signHostJwt(
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "ES256", kid: key.kid, typ: "JWT" },
): Promise<string> {
  const signingInput = `${encodeSegment(header)}.${encodeSegment(payload)}`;
  return crypto.subtle
    .sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, new TextEncoder().encode(signingInput))
    .then((signature) => `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`);
}

/** Live-clock claims so the Worker's real-time verification accepts them. */
function livePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://tokiapi.test",
    aud: "tokimeki-relay",
    sub: "user-123",
    namespace: "abcde",
    token_use: "host",
    scope: "host",
    iat: now - 10,
    exp: now + 3600,
    ...overrides,
  };
}

function mockJwks(document: unknown = { keys: [key.publicJwk] }): void {
  jwksResponder = () => ({ statusCode: 200, data: JSON.stringify(document) });
}

beforeEach(() => {
  __resetJwtCacheForTests();
  jwksResponder = null;
});

const VALID_HOST_HEADERS = (token: string): Record<string, string> => ({
  Upgrade: "websocket",
  "x-tokimeki-token": token,
  "x-tokimeki-session": SESSION_TOKEN,
});

describe("worker Host JWT authentication", () => {
  it("admits a valid Host JWT via X-Tokimeki-Token", async () => {
    mockJwks();
    const token = await signHostJwt(livePayload());
    const socket = await connectWorker("abcde.sess", {
      hostToken: token,
      token: SESSION_TOKEN,
    });
    socket.send(helloFor("abcde.sess", "host", "host-1"));
    const welcome = await socket.waitForType("welcome");
    expect(welcome.session).toBe("abcde.sess");
    socket.close();
  });

  it("admits a valid Host JWT via Authorization: Bearer when the token header is absent", async () => {
    mockJwks();
    const token = await signHostJwt(livePayload());
    const socket = await connectWorker("abcde.bearer", {
      authorization: `Bearer ${token}`,
      token: SESSION_TOKEN,
    });
    socket.send(helloFor("abcde.bearer", "host", "host-1"));
    const welcome = await socket.waitForType("welcome");
    expect(welcome.session).toBe("abcde.bearer");
    socket.close();
  });

  it("accepts equal token-header and Bearer values as one credential", async () => {
    mockJwks();
    const token = await signHostJwt(livePayload());
    const socket = await connectWorker("abcde.equal", {
      hostToken: token,
      authorization: `Bearer ${token}`,
      token: SESSION_TOKEN,
    });
    socket.send(helloFor("abcde.equal", "host", "host-1"));
    await socket.waitForType("welcome");
    socket.close();
  });

  it("rejects different token-header and Bearer values", async () => {
    mockJwks();
    const token = await signHostJwt(livePayload());
    const other = await signHostJwt(livePayload({ sub: "user-2" }));
    const response = await SELF.fetch("https://relay.test/ws/abcde.conflict", {
      headers: {
        Upgrade: "websocket",
        "x-tokimeki-token": token,
        "x-tokimeki-session": SESSION_TOKEN,
        authorization: `Bearer ${other}`,
      },
    });
    expect(response.status).toBe(401);
  });

  it("rejects a malformed Bearer with no usable token header", async () => {
    mockJwks();
    const response = await SELF.fetch("https://relay.test/ws/abcde.malformed-bearer", {
      headers: {
        Upgrade: "websocket",
        "x-tokimeki-session": SESSION_TOKEN,
        authorization: "Bearer ",
      },
    });
    expect(response.status).toBe(401);
  });

  it("rejects a Bearer that is not JWT-shaped (never compared as a namespace token)", async () => {
    mockJwks();
    // TEAM_A_TOKEN is a configured namespace token; presenting it via Bearer
    // must not authenticate (Authorization only carries Host JWTs).
    const response = await SELF.fetch("https://relay.test/ws/team-a.bearer-ns", {
      headers: {
        Upgrade: "websocket",
        "x-tokimeki-session": SESSION_TOKEN,
        authorization: `Bearer ${TEAM_A_TOKEN}`,
      },
    });
    expect(response.status).toBe(401);
  });

  it("rejects the fallback token while namespace tokens are active", async () => {
    mockJwks();
    const response = await SELF.fetch("https://relay.test/ws/abcde.fallback", {
      headers: {
        Upgrade: "websocket",
        "x-tokimeki-token": MASTER_TOKEN,
        "x-tokimeki-session": SESSION_TOKEN,
      },
    });
    expect(response.status).toBe(401);
  });

  it("rejects a JWT whose namespace does not match the session prefix", async () => {
    mockJwks();
    const token = await signHostJwt(livePayload({ namespace: "abcd" }));
    const response = await SELF.fetch("https://relay.test/ws/abcde.wrong-prefix", {
      headers: VALID_HOST_HEADERS(token),
    });
    expect(response.status).toBe(401);
  });

  it("rejects a JWT that equals the session token", async () => {
    mockJwks();
    const token = await signHostJwt(livePayload());
    const response = await SELF.fetch("https://relay.test/ws/abcde.equal-session", {
      headers: {
        Upgrade: "websocket",
        "x-tokimeki-token": token,
        "x-tokimeki-session": token,
      },
    });
    expect(response.status).toBe(401);
  });

  it("rejects expired, mis-signed, and unknown-kid tokens", async () => {
    mockJwks();
    const now = Math.floor(Date.now() / 1000);
    const expired = await signHostJwt(livePayload({ exp: now - 120, iat: now - 200 }));
    const expiredResponse = await SELF.fetch("https://relay.test/ws/abcde.expired", {
      headers: VALID_HOST_HEADERS(expired),
    });
    expect(expiredResponse.status).toBe(401);

    const otherPair = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as unknown as CryptoKeyPair;
    const signingInput = `${encodeSegment({ alg: "ES256", kid: key.kid })}.${encodeSegment(
      livePayload(),
    )}`;
    const badSignature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      otherPair.privateKey,
      new TextEncoder().encode(signingInput),
    );
    const forged = `${signingInput}.${base64UrlEncode(new Uint8Array(badSignature))}`;
    const forgedResponse = await SELF.fetch("https://relay.test/ws/abcde.forged", {
      headers: VALID_HOST_HEADERS(forged),
    });
    expect(forgedResponse.status).toBe(401);

    const unknownKid = await signHostJwt(livePayload(), {
      alg: "ES256",
      kid: "other-kid",
    });
    const unknownKidResponse = await SELF.fetch("https://relay.test/ws/abcde.unknown-kid", {
      headers: VALID_HOST_HEADERS(unknownKid),
    });
    expect(unknownKidResponse.status).toBe(401);
  });

  it("reports JWT claims from /auth/whoami via both carriers", async () => {
    mockJwks();
    const token = await signHostJwt(livePayload());

    const headerResponse = await SELF.fetch("https://relay.test/auth/whoami", {
      headers: { "x-tokimeki-token": token },
    });
    expect(headerResponse.status).toBe(200);
    const body = await headerResponse.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      ok: true,
      service: "tokimeki-relay",
      protocolVersion: 1,
      authMode: "jwt",
      namespace: "abcde",
      sub: "user-123",
      tokenUse: "host",
    });
    expect(Array.isArray(body.scopes)).toBe(true);
    expect(typeof body.expiresAt).toBe("number");
    const text = JSON.stringify(body);
    expect(text).not.toContain(token);
    expect(text).not.toContain("jti-1");
    expect(text).not.toContain(JWKS_URL);

    const bearerResponse = await SELF.fetch("https://relay.test/auth/whoami", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(bearerResponse.status).toBe(200);
    const bearerBody = await bearerResponse.json<Record<string, unknown>>();
    expect(bearerBody).toMatchObject({ authMode: "jwt", namespace: "abcde" });
  });

  it("returns 503 jwks_unavailable when the JWKS is unreachable and uncached", async () => {
    jwksResponder = () => ({ statusCode: 502, data: "jwks down" });
    const token = await signHostJwt(livePayload());
    const response = await SELF.fetch("https://relay.test/ws/abcde.down", {
      headers: VALID_HOST_HEADERS(token),
    });
    expect(response.status).toBe(503);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toEqual({ ok: false, error: "jwks_unavailable" });

    const whoami = await SELF.fetch("https://relay.test/auth/whoami", {
      headers: { "x-tokimeki-token": token },
    });
    expect(whoami.status).toBe(503);
  });

  it("returns 401 for JWT credentials when the JWT configuration is invalid", async () => {
    const worker = (await import("../src/index")).default;
    const token = await signHostJwt(livePayload());
    const invalidEnv = { ...env, TOKIMEKI_JWT_JWKS_URL: "http://not-https.test/jwks.json" };
    const response = await worker.fetch(
      new Request("https://relay.test/ws/abcde.badcfg", {
        headers: VALID_HOST_HEADERS(token),
      }),
      invalidEnv,
    );
    expect(response.status).toBe(401);

    // The namespace token still works when the JWT config is invalid.
    const namespaceOk = await worker.fetch(
      new Request("https://relay.test/ws/team-a.ok", {
        headers: {
          Upgrade: "websocket",
          "x-tokimeki-token": TEAM_A_TOKEN,
          "x-tokimeki-session": SESSION_TOKEN,
        },
      }),
      invalidEnv,
    );
    expect(namespaceOk.status).toBe(101);
    namespaceOk.webSocket?.accept();
    namespaceOk.webSocket?.close(1000, "test");
  });

  it("does not reject a host connection that carries Authorization in JWT mode", async () => {
    mockJwks();
    const token = await signHostJwt(livePayload());
    const response = await SELF.fetch("https://relay.test/ws/abcde.authz-stripped", {
      headers: {
        Upgrade: "websocket",
        "x-tokimeki-token": token,
        "x-tokimeki-session": SESSION_TOKEN,
        authorization: `Bearer ${token}`,
      },
    });
    expect(response.status).toBe(101);
    response.webSocket?.accept();
    response.webSocket?.close(1000, "test");
  });
});
