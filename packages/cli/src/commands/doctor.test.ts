import { describe, expect, it, vi } from "vitest";

import type { DoctorConfig } from "../config.js";
import { runDoctor } from "./doctor.js";

function doctorConfig(overrides: Partial<DoctorConfig> = {}): DoctorConfig {
  return {
    relayUrl: "wss://relay.example",
    session: null,
    hasMasterToken: true,
    masterToken: "test-master-token-abc",
    hasNamespaceToken: false,
    namespace: null,
    authMode: "master",
    hasSessionToken: false,
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

describe("runDoctor", () => {
  it("probes minimal healthz and authenticated whoami without printing the token", async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      requests.push(String(input));
      return new Response(
        JSON.stringify({ ok: true, turn: { provider: "coturn", configured: true } }),
        { status: 200 },
      );
    });
    const { stream, output } = fakeStdout();

    const code = await runDoctor(doctorConfig(), {
      stdout: stream,
      fetchImpl: asFetch(fetchImpl),
      probePty: async () => null,
    });

    expect(code).toBe(0);
    expect(requests).toEqual([
      "https://relay.example/healthz",
      "https://relay.example/auth/whoami",
    ]);
    const text = output();
    expect(text).toContain("relay healthz reachable");
    expect(text).toContain("relay whoami authenticated (TURN provider: coturn)");
    expect(text).not.toContain("test-master-token-abc");
  });

  it("does not echo an unrecognized TURN provider from the relay", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/healthz")) {
        return new Response("{}", { status: 200 });
      }
      return new Response(
        JSON.stringify({ ok: true, turn: { provider: "\u001b[2Jevil", configured: true } }),
        { status: 200 },
      );
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
    expect(text).toContain("relay whoami authenticated (HTTP 200)");
  });

  it("warns instead of failing when an older relay has no /auth/whoami", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/healthz")) {
        return new Response("{}", { status: 200 });
      }
      return new Response(JSON.stringify({ ok: false, error: "not_found" }), { status: 404 });
    });
    const { stream, output } = fakeStdout();

    const code = await runDoctor(doctorConfig(), {
      stdout: stream,
      fetchImpl: asFetch(fetchImpl),
      probePty: async () => null,
    });

    expect(code).toBe(0);
    expect(output()).toContain("[warn] relay whoami returned HTTP 404");
  });

  it("skips the whoami probe when no master token is configured", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const { stream, output } = fakeStdout();

    const code = await runDoctor(
      doctorConfig({
        session: "sess-1",
        hasMasterToken: false,
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

  it("reports namespace host authentication without printing the token", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const { stream, output } = fakeStdout();

    const code = await runDoctor(
      doctorConfig({
        hasMasterToken: false,
        masterToken: null,
        hasNamespaceToken: true,
        namespace: "team-a",
        authMode: "namespace",
        secrets: ["namespace-token-team-a"],
      }),
      {
        stdout: stream,
        fetchImpl: asFetch(fetchImpl),
        probePty: async () => null,
      },
    );

    expect(code).toBe(0);
    const text = output();
    expect(text).toContain("TOKIMEKI_NAMESPACE_TOKEN");
    expect(text).toContain("namespace=team-a");
    expect(text).not.toContain("namespace-token-team-a");
    // The v1 whoami probe is root-master-only, so it is skipped.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
