import { describe, expect, it, vi } from "vitest";

import {
  exchangeAttachCode,
  getPublicConfig,
  normalizeProviderOrigin,
  requestAnonymousHost,
  TokiApiError,
  validateProviderRelayUrl,
} from "./tokiapi.js";

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function mockFetch(response: Response | (() => Promise<Response>)) {
  return vi.fn(async () =>
    typeof response === "function" ? await response() : response,
  ) as unknown as typeof fetch;
}

describe("provider origin and relay binding", () => {
  it("accepts https and loopback http only", () => {
    expect(normalizeProviderOrigin("https://tokiapi.app")).toBe("https://tokiapi.app");
    expect(normalizeProviderOrigin("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(() => normalizeProviderOrigin("http://example.com")).toThrow(TokiApiError);
    expect(() => normalizeProviderOrigin("https://tokiapi.app/path")).toThrow(/path/);
    expect(() => normalizeProviderOrigin("https://user:pass@tokiapi.app")).toThrow(/credentials/);
  });

  it("binds relay hosts to the provider origin", () => {
    expect(validateProviderRelayUrl("wss://relay.tokiapi.app", "https://tokiapi.app")).toBe(
      "wss://relay.tokiapi.app",
    );
    expect(validateProviderRelayUrl("wss://relay.example.com", "https://example.com")).toBe(
      "wss://relay.example.com",
    );
    expect(validateProviderRelayUrl("wss://example.com", "https://example.com")).toBe(
      "wss://example.com",
    );
    expect(validateProviderRelayUrl("ws://127.0.0.1:9000", "http://127.0.0.1:8787")).toBe(
      "ws://127.0.0.1:9000",
    );
    expect(() => validateProviderRelayUrl("wss://evil.example", "https://tokiapi.app")).toThrow(
      /not bound/,
    );
    expect(() => validateProviderRelayUrl("ws://relay.tokiapi.app", "https://tokiapi.app")).toThrow(
      /wss/,
    );
    expect(() =>
      validateProviderRelayUrl("wss://relay.tokiapi.app/?x=1", "https://tokiapi.app"),
    ).toThrow(/query/);
  });
});

describe("TokiAPI public config", () => {
  it("parses the documented shape", async () => {
    const fetchImpl = mockFetch(
      jsonResponse(200, { tokimekiEnabled: true, tokimekiRelayUrl: "wss://relay.tokiapi.app" }),
    );
    await expect(getPublicConfig("https://tokiapi.app", { fetchImpl })).resolves.toEqual({
      tokimekiEnabled: true,
      tokimekiRelayUrl: "wss://relay.tokiapi.app",
    });
  });

  it("maps 503 to unavailable and rejects malformed bodies", async () => {
    await expect(
      getPublicConfig("https://tokiapi.app", {
        fetchImpl: mockFetch(jsonResponse(503, { error: { message: "not configured" } })),
      }),
    ).rejects.toMatchObject({ kind: "unavailable" });

    await expect(
      getPublicConfig("https://tokiapi.app", {
        fetchImpl: mockFetch(jsonResponse(200, {})),
      }),
    ).rejects.toMatchObject({ kind: "schema" });
  });

  it("does not follow redirects or send credentials", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.redirect).toBe("error");
      expect(init.credentials).toBe("omit");
      return jsonResponse(200, { tokimekiEnabled: true });
    });
    await getPublicConfig("https://tokiapi.app", {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("TokiAPI anonymous host request", () => {
  const grant = {
    success: true,
    token: "host-jwt-value",
    namespace: "ab12",
    session: "ab12.calm-otter",
    inviteUrl: "https://tokiapi.app/#t-code123",
    expiresAt: 1_800_000_000,
  };

  it("parses a successful grant", async () => {
    const fetchImpl = mockFetch(jsonResponse(200, grant));
    await expect(requestAnonymousHost("https://tokiapi.app", { fetchImpl })).resolves.toEqual({
      token: "host-jwt-value",
      namespace: "ab12",
      session: "ab12.calm-otter",
      inviteUrl: "https://tokiapi.app/#t-code123",
      expiresAt: 1_800_000_000,
    });
  });

  it("exposes Retry-After on 429", async () => {
    const fetchImpl = mockFetch(
      jsonResponse(429, { error: { message: "slow down" } }, { "retry-after": "60" }),
    );
    await expect(requestAnonymousHost("https://tokiapi.app", { fetchImpl })).rejects.toMatchObject({
      kind: "rate_limited",
      retryAfterSeconds: 60,
    });
  });

  it("rejects schema problems without echoing values", async () => {
    const fetchImpl = mockFetch(
      jsonResponse(200, { ...grant, namespace: "BAD NAMESPACE", session: "BAD" }),
    );
    try {
      await requestAnonymousHost("https://tokiapi.app", { fetchImpl });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TokiApiError);
      expect((error as Error).message).not.toContain("BAD NAMESPACE");
    }
  });

  it("rejects non-https invite URLs", async () => {
    const fetchImpl = mockFetch(jsonResponse(200, { ...grant, inviteUrl: "http://x" }));
    await expect(requestAnonymousHost("https://tokiapi.app", { fetchImpl })).rejects.toMatchObject({
      kind: "schema",
    });
  });
});

describe("TokiAPI attach exchange", () => {
  it("parses viewer/listener grants and passcode requirements", async () => {
    const fetchImpl = mockFetch(
      jsonResponse(200, {
        success: true,
        token: "session-jwt",
        session: "ab12.calm-otter",
        mode: "listener",
        allowWeb: false,
        passcodeRequired: true,
        expiresAt: 1_800_000_000,
      }),
    );
    await expect(
      exchangeAttachCode("https://tokiapi.app", "code123", { fetchImpl }),
    ).resolves.toEqual({
      token: "session-jwt",
      session: "ab12.calm-otter",
      mode: "listener",
      allowWeb: false,
      passcodeRequired: true,
      expiresAt: 1_800_000_000,
    });
  });

  it("maps 410 to invalid_invite and sends only {code}", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toEqual({ code: "code123" });
      return jsonResponse(410, { error: { message: "expired" } });
    });
    await expect(
      exchangeAttachCode("https://tokiapi.app", "code123", {
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ kind: "invalid_invite" });
  });

  it("rejects an invalid code locally", async () => {
    const fetchImpl = mockFetch(jsonResponse(200, {}));
    await expect(
      exchangeAttachCode("https://tokiapi.app", "bad code", { fetchImpl }),
    ).rejects.toMatchObject({ kind: "schema" });
  });
});
