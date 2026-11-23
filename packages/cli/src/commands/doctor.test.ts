import { describe, expect, it, vi } from "vitest";

import type { DoctorConfig } from "../config.js";
import { runDoctor } from "./doctor.js";

function doctorConfig(overrides: Partial<DoctorConfig> = {}): DoctorConfig {
  return {
    relayUrl: "wss://relay.example",
    session: null,
    configFilePath: null,
    hasToken: false,
    token: null,
    masterToken: "test-master-token-abc",
    namespace: null,
    authMode: "master",
    hasSessionToken: false,
    hasPasscode: false,
    warnings: [],
    secrets: ["test-master-token-abc"],
    ...overrides,
  };
}

function fakeStdout(): { stream: NodeJS.WriteStream; output: () => string } {
  const chunks: string[] = [];
  // Cast at the test stream boundary; doctor only calls write().
  const stream = {
    write: (chunk: string) => {
      chunks.push(String(chunk));
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { stream, output: () => chunks.join("") };
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const asFetch = (impl: FetchLike): typeof fetch =>
  // Test fake: the doctor deps only require the fetch call shape.
  impl as unknown as typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("runDoctor", () => {
  it("probes minimal healthz and authenticated whoami without printing the token", async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return jsonResponse({
        ok: true,
        authMode: "master",
        turn: { provider: "coturn", configured: true },
      });
    });
    const { stream, output } = fakeStdout();

    const code = await runDoctor(doctorConfig(), {
      stdout: stream,
      fetchImpl: asFetch(fetchImpl),
      probePty: async () => null,
    });

    expect(code).toBe(0);
    expect(requests.map((request) => request.url)).toEqual([
      "https://relay.example/healthz",
      "https://relay.example/auth/whoami",
    ]);
    // The probe always travels on X-Tokimeki-Token, never Authorization.
    expect(requests[1]?.headers).toEqual({ "X-Tokimeki-Token": "test-master-token-abc" });
    const text = output();
    expect(text).toContain("relay healthz reachable");
    expect(text).toContain("relay whoami authenticated (auth=master, TURN provider: coturn)");
    expect(text).not.toContain("test-master-token-abc");
    expect(text).not.toContain("X-Tokimeki-Token: ");
  });

  it("probes with TOKIMEKI_TOKEN when it is the effective credential", async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      if (String(input).endsWith("/healthz")) {
        return new Response("{}", { status: 200 });
      }
      return jsonResponse({ ok: false, error: "unauthorized" }, 401);
    });
    const { stream, output } = fakeStdout();

    const code = await runDoctor(
      doctorConfig({
        hasToken: true,
        token: "opaque-host-token",
        masterToken: "test-master-token-abc",
        namespace: "team-a",
        authMode: "token",
        secrets: ["opaque-host-token", "test-master-token-abc"],
      }),
      { stdout: stream, fetchImpl: asFetch(fetchImpl), probePty: async () => null },
    );

    expect(code).toBe(0);
    expect(requests[1]?.headers).toEqual({ "X-Tokimeki-Token": "opaque-host-token" });
    expect(output()).toContain("X-Tokimeki-Token header versions do not match");
    expect(output()).not.toContain("opaque-host-token");
  });

  it("echoes jwt whoami claims and warns on a namespace mismatch", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/healthz")) {
        return new Response("{}", { status: 200 });
      }
      return jsonResponse({
        ok: true,
        authMode: "jwt",
        namespace: "abcde",
        sub: "user-123",
        tokenUse: "host",
        scopes: ["host"],
        expiresAt: 1790000000,
        turn: { provider: "coturn", configured: true },
        jti: "secret-jti",
      });
    });
    const { stream, output } = fakeStdout();

    const code = await runDoctor(
      doctorConfig({
        hasToken: true,
        token: "opaque-host-token",
        namespace: "team-a",
        authMode: "token",
        secrets: ["opaque-host-token"],
      }),
      { stdout: stream, fetchImpl: asFetch(fetchImpl), probePty: async () => null },
    );

    expect(code).toBe(0);
    const text = output();
    expect(text).toContain("(auth=jwt, namespace=abcde, token_use=host, scope=host");
    expect(text).toContain("expires=");
    expect(text).toContain("does not match TOKIMEKI_NAMESPACE");
    expect(text).not.toContain("secret-jti");
    expect(text).not.toContain("opaque-host-token");
    expect(text).not.toContain("user-123");
  });

  it("echoes a namespace whoami from a static token", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/healthz")) {
        return new Response("{}", { status: 200 });
      }
      return jsonResponse({
        ok: true,
        authMode: "namespace",
        namespace: "team-a",
        turn: { provider: "coturn", configured: true },
      });
    });
    const { stream, output } = fakeStdout();

    const code = await runDoctor(
      doctorConfig({
        hasToken: true,
        token: "opaque-host-token",
        namespace: "team-a",
        authMode: "token",
        secrets: ["opaque-host-token"],
      }),
      { stdout: stream, fetchImpl: asFetch(fetchImpl), probePty: async () => null },
    );

    expect(code).toBe(0);
    const text = output();
    expect(text).toContain("(auth=namespace, namespace=team-a, TURN provider: coturn)");
    expect(text).not.toContain("opaque-host-token");
  });

  it("does not echo an unrecognized TURN provider from the relay", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/healthz")) {
        return new Response("{}", { status: 200 });
      }
      return jsonResponse({
        ok: true,
        authMode: "master",
        turn: { provider: "\u001b[2Jevil", configured: true },
      });
    });
    const { stream, output } = fakeStdout();

    const code = await runDoctor(doctorConfig(), {
      stdout: stream,
      fetchImpl: asFetch(fetchImpl),
      probePty: async () => null,
    });

    expect(code).toBe(0);
    const text = output();
    expect(text).not.toContain("evil");
    expect(text).toContain("relay whoami authenticated (auth=master)");
  });

  it("warns instead of failing when an older relay has no /auth/whoami", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/healthz")) {
        return new Response("{}", { status: 200 });
      }
      return jsonResponse({ ok: false, error: "not_found" }, 404);
    });
    const { stream, output } = fakeStdout();

    const code = await runDoctor(doctorConfig(), {
      stdout: stream,
      fetchImpl: asFetch(fetchImpl),
      probePty: async () => null,
    });

    expect(code).toBe(0);
    const text = output();
    expect(text).toContain("[warn] relay whoami returned HTTP 404");
    expect(text).toContain("namespace tokens enabled");
    expect(text).toContain("TOKIMEKI_NAMESPACE + TOKIMEKI_TOKEN");
  });

  it("skips the whoami probe when no host credential is configured", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const { stream, output } = fakeStdout();

    const code = await runDoctor(
      doctorConfig({
        session: "sess-1",
        masterToken: null,
        hasSessionToken: true,
        authMode: null,
        secrets: [],
      }),
      {
        stdout: stream,
        fetchImpl: asFetch(fetchImpl),
        probePty: async () => null,
      },
    );

    expect(code).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(output()).not.toContain("whoami");
  });

  it("reports a loaded config file", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/healthz")) {
        return new Response("{}", { status: 200 });
      }
      return jsonResponse({ ok: true, authMode: "master" });
    });
    const { stream, output } = fakeStdout();

    const code = await runDoctor(
      doctorConfig({ configFilePath: "/home/user/.tokimeki/config.json" }),
      { stdout: stream, fetchImpl: asFetch(fetchImpl), probePty: async () => null },
    );

    expect(code).toBe(0);
    expect(output()).toContain("config file loaded (/home/user/.tokimeki/config.json)");
  });
});
