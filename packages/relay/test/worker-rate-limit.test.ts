import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sha256Hex } from "../src/crypto-utils.js";
import type { RelayEnv } from "../src/env.js";
import { MASTER_TOKEN, SESSION_TOKEN, sleep } from "./helpers";

/**
 * v1.7 R1: Worker per-IP edge limit for `/ws/<session>` upgrades.
 *
 * The Cloudflare rate-limit binding is stubbed per test so the policy (which
 * lives in `[[ratelimits]]`) is not exercised; these tests assert placement
 * (after auth/role checks, before the SessionDO), fail-open behavior, logging,
 * and that a client cannot forge the trusted IP header.
 */

const workerPromise = import("../src/index");

function rateLimitStub(outcome: { success: boolean }, keys: string[] = []): RateLimit {
  return {
    async limit(options: RateLimitOptions): Promise<RateLimitOutcome> {
      keys.push(options.key);
      return outcome;
    },
  } as RateLimit;
}

function upgradeRequest(sessionId: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://relay.test/ws/${sessionId}`, {
    headers: {
      Upgrade: "websocket",
      "x-tokimeki-session": SESSION_TOKEN,
      ...headers,
    },
  });
}

function envWith(overrides: Record<string, unknown>): RelayEnv {
  return { ...env, ...overrides } as unknown as RelayEnv;
}

/**
 * A SessionDO substitute that completes a WebSocket upgrade without touching
 * Durable Object storage.
 *
 * Used by fail-open tests that only assert the Worker forwarded the upgrade;
 * this avoids the Windows isolated-storage teardown race (EBUSY) from opening
 * throwaway DO sessions that never speak `hello`.
 */
function forwardedSessions(): DurableObjectNamespace {
  return {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (): Promise<Response> => {
        const pair = new WebSocketPair();
        pair[1].accept();
        return new Response(null, { status: 101, webSocket: pair[0] });
      },
    }),
  } as unknown as DurableObjectNamespace;
}

/** Like `forwardedSessions`, but records the headers the Worker forwarded. */
function capturingSessions(captured: Headers[]): DurableObjectNamespace {
  return {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request): Promise<Response> => {
        captured.push(new Headers(request.headers));
        const pair = new WebSocketPair();
        pair[1].accept();
        return new Response(null, { status: 101, webSocket: pair[0] });
      },
    }),
  } as unknown as DurableObjectNamespace;
}

async function dispose(response: Response): Promise<void> {
  response.webSocket?.accept();
  response.webSocket?.close(1000, "test");
  await sleep(20);
}

function logLines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((call) => String(call[0]));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("worker /ws per-IP rate limit", () => {
  it("returns 429 with Retry-After before the SessionDO when the bucket rejects", async () => {
    const worker = (await workerPromise).default;
    const keys: string[] = [];
    let doReached = false;
    const sessions = {
      get: () => {
        doReached = true;
        throw new Error("SessionDO must not be reached");
      },
    } as unknown as DurableObjectNamespace;

    const response = await worker.fetch(
      upgradeRequest("rate-limited", {
        "x-tokimeki-token": MASTER_TOKEN,
        "cf-connecting-ip": "203.0.113.10",
      }),
      envWith({
        SESSIONS: sessions,
        TOKIMEKI_WS_IP_LIMIT: rateLimitStub({ success: false }, keys),
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.text()).toBe("rate limited\n");
    expect(keys).toEqual(["203.0.113.10"]);
    expect(doReached).toBe(false);
  });

  it("uses the edge client IP, never a forged x-tokimeki-client-ip header", async () => {
    const worker = (await workerPromise).default;
    const keys: string[] = [];
    const response = await worker.fetch(
      upgradeRequest("forged-client-ip", {
        "cf-connecting-ip": "203.0.113.11",
        "x-tokimeki-client-ip": "6.6.6.6",
        "x-real-ip": "7.7.7.7",
      }),
      envWith({
        SESSIONS: forwardedSessions(),
        TOKIMEKI_WS_IP_LIMIT: rateLimitStub({ success: true }, keys),
      }),
    );
    expect(response.status).toBe(101);
    expect(keys).toEqual(["203.0.113.11"]);
    await dispose(response);
  });

  it("does not count invalid host credentials against the bucket", async () => {
    const worker = (await workerPromise).default;
    const keys: string[] = [];
    const response = await worker.fetch(
      upgradeRequest("bad-host-token", {
        "x-tokimeki-token": "wrong-host-token",
        "cf-connecting-ip": "203.0.113.12",
      }),
      envWith({ TOKIMEKI_WS_IP_LIMIT: rateLimitStub({ success: false }, keys) }),
    );
    expect(response.status).toBe(401);
    // The rate-limit bucket is only consumed after host/JWT/role checks.
    expect(keys).toEqual([]);
  });

  it("fails open with a warn log when the edge supplies no client IP", async () => {
    const worker = (await workerPromise).default;
    const keys: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await worker.fetch(
      upgradeRequest("no-client-ip"),
      envWith({
        SESSIONS: forwardedSessions(),
        TOKIMEKI_LOG_LEVEL: "warn",
        TOKIMEKI_WS_IP_LIMIT: rateLimitStub({ success: false }, keys),
      }),
    );
    expect(response.status).toBe(101);
    expect(keys).toEqual([]);
    expect(logLines(warn).some((line) => line.includes("ws_rate_limit_no_ip"))).toBe(true);
    await dispose(response);
  });

  it("fails open with an error log when the binding is not configured", async () => {
    const worker = (await workerPromise).default;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await worker.fetch(
      upgradeRequest("missing-binding", { "cf-connecting-ip": "203.0.113.13" }),
      envWith({
        SESSIONS: forwardedSessions(),
        TOKIMEKI_WS_IP_LIMIT: undefined,
      }),
    );
    expect(response.status).toBe(101);
    expect(logLines(error).some((line) => line.includes("ws_rate_limit_binding_missing"))).toBe(
      true,
    );
    await dispose(response);
  });

  it("fails open with an error log when the binding throws", async () => {
    const worker = (await workerPromise).default;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      limit: async () => {
        throw new Error("rate limiter unavailable");
      },
    } as unknown as RateLimit;
    const response = await worker.fetch(
      upgradeRequest("binding-error", { "cf-connecting-ip": "203.0.113.14" }),
      envWith({
        SESSIONS: forwardedSessions(),
        TOKIMEKI_WS_IP_LIMIT: broken,
      }),
    );
    expect(response.status).toBe(101);
    expect(logLines(error).some((line) => line.includes("ws_rate_limit_unavailable"))).toBe(true);
    await dispose(response);
  });

  it("injects the edge IP as an internal header and hashes it for DO counters", async () => {
    const worker = (await workerPromise).default;

    // The Worker strips a forged internal header and forwards the edge address.
    const captured: Headers[] = [];
    const trusted = await worker.fetch(
      upgradeRequest("ip-injection", {
        "cf-connecting-ip": "203.0.113.15",
        "x-tokimeki-client-ip": "6.6.6.6",
      }),
      envWith({
        SESSIONS: capturingSessions(captured),
        TOKIMEKI_WS_IP_LIMIT: rateLimitStub({ success: true }),
      }),
    );
    expect(trusted.status).toBe(101);
    expect(captured[0]?.get("x-tokimeki-client-ip")).toBe("203.0.113.15");
    await dispose(trusted);

    // Without an edge IP the forged header is stripped and nothing is injected.
    const forgedCaptured: Headers[] = [];
    const forged = await worker.fetch(
      upgradeRequest("ip-forged", { "x-tokimeki-client-ip": "6.6.6.6" }),
      envWith({
        SESSIONS: capturingSessions(forgedCaptured),
        TOKIMEKI_WS_IP_LIMIT: rateLimitStub({ success: true }),
      }),
    );
    expect(forged.status).toBe(101);
    expect(forgedCaptured[0]?.get("x-tokimeki-client-ip")).toBeNull();
    await dispose(forged);

    // The DO stores only sha256(clientIp), never the raw address.
    const sessionId = "ip-hash-do";
    const response = await worker.fetch(
      upgradeRequest(sessionId, { "cf-connecting-ip": "203.0.113.16" }),
      envWith({ TOKIMEKI_WS_IP_LIMIT: rateLimitStub({ success: true }) }),
    );
    expect(response.status).toBe(101);
    response.webSocket?.accept();
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
    const storedHash = await runInDurableObject(stub, (_instance, state) => {
      const socket = state.getWebSockets()[0];
      const attachment = socket?.deserializeAttachment() as
        | { kind?: string; clientIpHash?: unknown }
        | undefined;
      return attachment?.clientIpHash;
    });
    expect(storedHash).toBe(await sha256Hex("203.0.113.16"));
    expect(String(storedHash)).not.toContain("203.0.113.16");
    response.webSocket?.close(1000, "test");
    await sleep(50);
  });
});
