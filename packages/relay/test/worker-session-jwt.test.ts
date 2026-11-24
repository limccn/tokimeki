import { fetchMock, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { __resetJwtCacheForTests } from "../src/jwt-auth.js";
import { connectDirect, connectWorker, helloFor, SESSION_TOKEN } from "./helpers";

/**
 * Session JWT integration tests (task A).
 *
 * JWT mode + static namespace tokens are active (see vitest.jwt.config.ts).
 * A host session is created with a Host JWT (`namespace=abcde`); viewers and
 * listeners then present a Session JWT in `X-Tokimeki-Session` instead of the
 * opaque session token. The JWKS route is mocked; no network access happens.
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

let key: {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: Record<string, string>;
};

function signJwt(payload: Record<string, unknown>): Promise<string> {
  const signingInput = `${encodeSegment({ alg: "ES256", kid: key.kid, typ: "JWT" })}.${encodeSegment(payload)}`;
  return crypto.subtle
    .sign(
      { name: "ECDSA", hash: "SHA-256" },
      key.privateKey,
      new TextEncoder().encode(signingInput),
    )
    .then((signature) => `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`);
}

function hostPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://tokiapi.test",
    aud: "tokimeki-relay",
    sub: "42",
    namespace: "abcde",
    token_use: "host",
    scope: "host",
    iat: now - 10,
    exp: now + 3600,
    ...overrides,
  };
}

function sessionPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return hostPayload({
    sub: "42",
    token_use: "session",
    scope: "attach",
    session: "abcde.sess",
    ...overrides,
  });
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  key = {
    kid: "session-test-kid",
    privateKey: pair.privateKey,
    publicJwk: {
      kty: "EC",
      crv: "P-256",
      x: jwk.x ?? "",
      y: jwk.y ?? "",
      kid: "session-test-kid",
      alg: "ES256",
      use: "sig",
    },
  };
  fetchMock.activate();
  fetchMock
    .get("https://tokiapi.test")
    .intercept({ path: "/api/tokimeki/jwks.json", method: "GET" })
    .reply(() => ({
      statusCode: 200,
      data: JSON.stringify({ keys: [key.publicJwk] }),
      responseOptions: { headers: { "content-type": "application/json" } },
    }))
    .times(1_000_000);
});

beforeEach(() => {
  __resetJwtCacheForTests();
});

async function openNamespacedHost(sessionId = "abcde.sess"): Promise<void> {
  const token = await signJwt(hostPayload());
  const socket = await connectWorker(sessionId, { hostToken: token, token: SESSION_TOKEN });
  socket.send(helloFor(sessionId, "host", "host-1"));
  await socket.waitForType("welcome");
  socket.close();
}

function upgradeRequest(sessionId: string, headers: Record<string, string>): Promise<Response> {
  return SELF.fetch(`https://relay.test/ws/${sessionId}`, {
    headers: { Upgrade: "websocket", ...headers },
  });
}

describe("worker Session JWT authentication", () => {
  it("admits a valid attach-scoped Session JWT as a viewer without the opaque token", async () => {
    await openNamespacedHost();
    const socket = await connectWorker("abcde.sess", {
      token: await signJwt(sessionPayload()),
    });
    socket.send(helloFor("abcde.sess", "viewer", "viewer-1"));
    const welcome = await socket.waitForType("welcome");
    expect(welcome.session).toBe("abcde.sess");
    socket.close();
  });

  it("admits a listen-scoped Session JWT only with X-Tokimeki-Listener: 1", async () => {
    await openNamespacedHost();
    const listenToken = await signJwt(sessionPayload({ scope: "listen web" }));
    const listener = await connectWorker("abcde.sess", {
      token: listenToken,
      listener: true,
    });
    listener.send(helloFor("abcde.sess", "listener", "listener-1"));
    await listener.waitForType("welcome");
    listener.close();

    const response = await upgradeRequest("abcde.sess", {
      "x-tokimeki-session": listenToken,
    });
    expect(response.status).toBe(401);
  });

  it("rejects attach-scoped tokens when the listener header is set", async () => {
    await openNamespacedHost();
    const response = await upgradeRequest("abcde.sess", {
      "x-tokimeki-session": await signJwt(sessionPayload({ scope: "attach" })),
      "x-tokimeki-listener": "1",
    });
    expect(response.status).toBe(401);
  });

  it("rejects a session claim that does not match the path", async () => {
    await openNamespacedHost();
    const response = await upgradeRequest("abcde.sess", {
      "x-tokimeki-session": await signJwt(sessionPayload({ session: "abcde.other" })),
    });
    expect(response.status).toBe(401);
  });

  it("rejects cross-namespace and host tokens presented as a session", async () => {
    await openNamespacedHost();
    const crossNamespace = await upgradeRequest("abcde.sess", {
      "x-tokimeki-session": await signJwt(
        sessionPayload({ namespace: "other", session: "other.sess" }),
      ),
    });
    expect(crossNamespace.status).toBe(401);

    const hostAsSession = await upgradeRequest("abcde.sess", {
      "x-tokimeki-session": await signJwt(hostPayload()),
    });
    expect(hostAsSession.status).toBe(401);
  });

  it("rejects expired Session JWTs", async () => {
    await openNamespacedHost();
    const now = Math.floor(Date.now() / 1000);
    const response = await upgradeRequest("abcde.sess", {
      "x-tokimeki-session": await signJwt(sessionPayload({ iat: now - 7200, exp: now - 3600 })),
    });
    expect(response.status).toBe(401);
  });

  it("rejects a Session JWT that is also presented as the host credential", async () => {
    await openNamespacedHost();
    const sessionJwt = await signJwt(sessionPayload());
    const response = await upgradeRequest("abcde.sess", {
      "x-tokimeki-token": await signJwt(hostPayload()),
      "x-tokimeki-session": sessionJwt,
    });
    expect(response.status).toBe(401);
  });

  it("keeps the opaque viewer path unchanged in JWT mode", async () => {
    await openNamespacedHost();
    const socket = await connectWorker("abcde.sess", { token: SESSION_TOKEN });
    socket.send(helloFor("abcde.sess", "viewer", "viewer-opaque"));
    await socket.waitForType("welcome");
    socket.close();
  });
});

describe("SessionDO defense in depth for internal claim headers", () => {
  it("accepts a matching direct claim/scope and rejects legacy namespace rows", async () => {
    // Direct host without a namespace header creates a legacy NULL namespace
    // session, which must keep accepting only the opaque token.
    const host = await connectDirect("legacy.sess", { role: "host", token: SESSION_TOKEN });
    host.send(helloFor("legacy.sess", "host", "host-legacy"));
    await host.waitForType("welcome");

    const legacyViewer = await connectDirect("legacy.sess", {
      role: "viewer",
      token: SESSION_TOKEN,
      headers: {
        "x-tokimeki-namespace": "legacy",
        "x-tokimeki-session-claim": "legacy.sess",
        "x-tokimeki-session-scope": "attach",
      },
    });
    legacyViewer.send(helloFor("legacy.sess", "viewer", "viewer-legacy"));
    const closed = await legacyViewer.waitForClose();
    expect(closed.code).not.toBe(1000);

    const mismatched = await connectDirect("legacy.sess", {
      role: "viewer",
      token: SESSION_TOKEN,
      headers: {
        "x-tokimeki-namespace": "other",
        "x-tokimeki-session-claim": "other.sess",
        "x-tokimeki-session-scope": "attach",
      },
    });
    mismatched.send(helloFor("legacy.sess", "viewer", "viewer-mismatch"));
    const mismatchClose = await mismatched.waitForClose();
    expect(mismatchClose.code).not.toBe(1000);
    host.close();
  });
});

// Keep the mock URL referenced so a future refactor cannot silently drop it.
void JWKS_URL;
