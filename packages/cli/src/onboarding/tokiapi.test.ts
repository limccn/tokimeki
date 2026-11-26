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
  it("parses the production body and ignores unrelated public fields", async () => {
    const fetchImpl = mockFetch(
      jsonResponse(200, {
        apiBaseUrl: "https://tokiapi.app",
        platformBaseUrl: "https://tokiapi.app",
        smsAuthEnabled: false,
        tokimekiEnabled: true,
        tokimekiRelayUrl: "wss://relay.tokiapi.app",
      }),
    );
    await expect(getPublicConfig("https://tokiapi.app", { fetchImpl })).resolves.toEqual({
      tokimekiEnabled: true,
      tokimekiRelayUrl: "wss://relay.tokiapi.app",
    });
  });

  it("treats an empty relay URL as absent", async () => {
    const fetchImpl = mockFetch(jsonResponse(200, { tokimekiEnabled: true, tokimekiRelayUrl: "" }));
    await expect(getPublicConfig("https://tokiapi.app", { fetchImpl })).resolves.toEqual({
      tokimekiEnabled: true,
      tokimekiRelayUrl: null,
    });
  });

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

  it("parses the anon-host body TokiAPI returns", async () => {
    const expiresAt = "2026-11-27T06:53:00.000Z";
    const fetchImpl = mockFetch(
      jsonResponse(200, {
        success: true,
        token: "eyJhbGciOiJFUzI1NiJ9.eyJ0b2tlbl91c2UiOiJob3N0In0.sig",
        namespace: "k3m7",
        session: "k3m7.calm-otter",
        inviteUrl: "https://tokiapi.app/#t-5rph2dgcuz7pa6qh",
        expiresAt,
      }),
    );
    await expect(requestAnonymousHost("https://tokiapi.app", { fetchImpl })).resolves.toEqual({
      token: "eyJhbGciOiJFUzI1NiJ9.eyJ0b2tlbl91c2UiOiJob3N0In0.sig",
      namespace: "k3m7",
      session: "k3m7.calm-otter",
      inviteUrl: "https://tokiapi.app/#t-5rph2dgcuz7pa6qh",
      expiresAt: Math.floor(Date.parse(expiresAt) / 1000),
    });
  });

  it("accepts the ISO-8601 expiresAt that TokiAPI returns", async () => {
    const expiresAt = "2026-11-27T06:53:00.000Z";
    const fetchImpl = mockFetch(jsonResponse(200, { ...grant, expiresAt }));
    await expect(requestAnonymousHost("https://tokiapi.app", { fetchImpl })).resolves.toMatchObject(
      { expiresAt: Math.floor(Date.parse(expiresAt) / 1000) },
    );
  });

  it("accepts offset timestamps and Z timestamps without milliseconds", async () => {
    for (const expiresAt of ["2026-11-27T14:53:00.000+08:00", "2026-11-27T06:53:00Z"]) {
      const fetchImpl = mockFetch(jsonResponse(200, { ...grant, expiresAt }));
      await expect(
        requestAnonymousHost("https://tokiapi.app", { fetchImpl }),
      ).resolves.toMatchObject({
        expiresAt: Math.floor(Date.parse("2026-11-27T06:53:00.000Z") / 1000),
      });
    }
  });

  it("treats a missing expiresAt as unknown", async () => {
    const { expiresAt: _expiresAt, ...withoutExpiry } = grant;
    const fetchImpl = mockFetch(jsonResponse(200, withoutExpiry));
    await expect(requestAnonymousHost("https://tokiapi.app", { fetchImpl })).resolves.toMatchObject(
      { expiresAt: null },
    );
  });

  it("rejects an invalid expiresAt", async () => {
    for (const expiresAt of ["2026-11-27", "not-a-date", -1]) {
      const fetchImpl = mockFetch(jsonResponse(200, { ...grant, expiresAt }));
      await expect(
        requestAnonymousHost("https://tokiapi.app", { fetchImpl }),
      ).rejects.toMatchObject({
        kind: "schema",
        message: "TokiAPI response field expiresAt is invalid",
      });
    }
  });

  it("rejects non-https invite URLs", async () => {
    const fetchImpl = mockFetch(jsonResponse(200, { ...grant, inviteUrl: "http://x" }));
    await expect(requestAnonymousHost("https://tokiapi.app", { fetchImpl })).rejects.toMatchObject({
      kind: "schema",
    });
  });

  it("rejects invite URLs containing terminal controls", async () => {
    const fetchImpl = mockFetch(
      jsonResponse(200, { ...grant, inviteUrl: "https://tokiapi.app/#t-code\n\u001b" }),
    );
    await expect(requestAnonymousHost("https://tokiapi.app", { fetchImpl })).rejects.toMatchObject({
      kind: "schema",
    });
  });
});

describe("TokiAPI attach exchange", () => {
  it("parses the attach/cli body TokiAPI returns", async () => {
    const expiresAt = "2026-11-27T06:53:00.000Z";
    const fetchImpl = mockFetch(
      jsonResponse(200, {
        success: true,
        token: "eyJhbGciOiJFUzI1NiJ9.eyJ0b2tlbl91c2UiOiJzZXNzaW9uIn0.sig",
        session: "k3m7.calm-otter",
        mode: "viewer",
        allowWeb: true,
        passcodeRequired: false,
        expiresAt,
      }),
    );
    await expect(
      exchangeAttachCode("https://tokiapi.app", "5rph2dgcuz7pa6qh", { fetchImpl }),
    ).resolves.toEqual({
      token: "eyJhbGciOiJFUzI1NiJ9.eyJ0b2tlbl91c2UiOiJzZXNzaW9uIn0.sig",
      session: "k3m7.calm-otter",
      mode: "viewer",
      allowWeb: true,
      passcodeRequired: false,
      expiresAt: Math.floor(Date.parse(expiresAt) / 1000),
    });
  });

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

  it("strips terminal controls from provider error messages", async () => {
    const fetchImpl = mockFetch(jsonResponse(410, { error: { message: "expired\n\u001b[2J" } }));
    try {
      await exchangeAttachCode("https://tokiapi.app", "code123", { fetchImpl });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TokiApiError);
      const message = (error as Error).message;
      expect(message).toContain("expired");
      expect(message).not.toContain("\u001b");
      expect(message).not.toContain("\n");
    }
  });

  it("accepts the ISO-8601 expiresAt that TokiAPI returns", async () => {
    const expiresAt = "2026-11-27T06:53:00.000Z";
    const fetchImpl = mockFetch(
      jsonResponse(200, {
        success: true,
        token: "session-jwt",
        session: "ab12.calm-otter",
        mode: "viewer",
        allowWeb: true,
        passcodeRequired: false,
        expiresAt,
      }),
    );
    await expect(
      exchangeAttachCode("https://tokiapi.app", "code123", { fetchImpl }),
    ).resolves.toMatchObject({
      expiresAt: Math.floor(Date.parse(expiresAt) / 1000),
    });
  });

  it("rejects a non-timestamp expiresAt", async () => {
    const fetchImpl = mockFetch(
      jsonResponse(200, {
        success: true,
        token: "session-jwt",
        session: "ab12.calm-otter",
        mode: "viewer",
        expiresAt: "1800000000",
      }),
    );
    await expect(
      exchangeAttachCode("https://tokiapi.app", "code123", { fetchImpl }),
    ).rejects.toMatchObject({
      kind: "schema",
      message: "TokiAPI response field expiresAt is invalid",
    });
  });

  it("rejects an invalid code locally", async () => {
    const fetchImpl = mockFetch(jsonResponse(200, {}));
    await expect(
      exchangeAttachCode("https://tokiapi.app", "bad code", { fetchImpl }),
    ).rejects.toMatchObject({ kind: "schema" });
  });
});
