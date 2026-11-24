import { describe, expect, it, vi } from "vitest";

import { hmacSha1Base64 } from "../src/crypto-utils";
import { coturnUrlList } from "../src/env";
import {
  createCoturnRestCredential,
  describeTurn,
  issueIceConfig,
  parseTurnMode,
  resolveIceProvider,
} from "../src/turn";

const COTURN = {
  TOKIMEKI_COTURN_URLS: "turn:coturn.test.invalid:3478?transport=udp",
  TOKIMEKI_COTURN_SECRET: "coturn-rest-secret",
  TOKIMEKI_COTURN_TTL_SECONDS: "3600",
};

const STUN_URL = "turn:stun.tokiapi.app:3478?transport=udp";
const CN_URL = "turn:cn.stokiapi.app:3478?transport=udp";

const MULTI_COTURN = {
  TOKIMEKI_COTURN_URLS: [STUN_URL, CN_URL],
  TOKIMEKI_COTURN_SECRET: "coturn-rest-secret",
  TOKIMEKI_COTURN_TTL_SECONDS: "3600",
};

const STATIC = {
  TOKIMEKI_TURN_URLS: "turn:static.test.invalid:3478?transport=tcp",
  TOKIMEKI_TURN_USERNAME: "static-user",
  TOKIMEKI_TURN_CREDENTIAL: "static-credential",
};

const CLOUDFLARE = {
  TOKIMEKI_TURN_KEY_ID: "cf-key-id",
  TOKIMEKI_TURN_API_TOKEN: "cf-api-token",
};

const ALL_PROVIDERS = { ...COTURN, ...STATIC, ...CLOUDFLARE };

describe("coturn URL list normalization", () => {
  it("treats an array, a legacy comma string and a JSON array string alike", () => {
    expect(coturnUrlList({ TOKIMEKI_COTURN_URLS: [STUN_URL, CN_URL] })).toEqual([STUN_URL, CN_URL]);
    expect(coturnUrlList({ TOKIMEKI_COTURN_URLS: `${STUN_URL},${CN_URL}` })).toEqual([
      STUN_URL,
      CN_URL,
    ]);
    expect(coturnUrlList({ TOKIMEKI_COTURN_URLS: JSON.stringify([STUN_URL, CN_URL]) })).toEqual([
      STUN_URL,
      CN_URL,
    ]);
  });

  it("returns an empty list when coturn is not configured", () => {
    expect(coturnUrlList({})).toEqual([]);
    expect(coturnUrlList({ TOKIMEKI_COTURN_URLS: "" })).toEqual([]);
    expect(coturnUrlList({ TOKIMEKI_COTURN_URLS: "   " })).toEqual([]);
    expect(coturnUrlList({ TOKIMEKI_COTURN_URLS: [] })).toEqual([]);
    expect(coturnUrlList({ TOKIMEKI_COTURN_URLS: "[]" })).toEqual([]);
    // Wrangler vars are untyped JSON; a non-array value must not throw.
    expect(coturnUrlList({ TOKIMEKI_COTURN_URLS: null as unknown as readonly string[] })).toEqual(
      [],
    );
  });

  it("trims entries, drops invalid schemes, and keeps the first duplicate", () => {
    expect(
      coturnUrlList({
        TOKIMEKI_COTURN_URLS: [
          ` ${STUN_URL} `,
          "",
          "   ",
          "stun:stun.tokiapi.app:3478",
          "https://relay.tokiapi.app/ws",
          STUN_URL,
          CN_URL,
          ` ${CN_URL}`,
        ],
      }),
    ).toEqual([STUN_URL, CN_URL]);
  });

  it("matches turn: schemes case-insensitively and drops non-string entries", () => {
    const withNonString = ["TURN:coturn.test.invalid:3478", 42, "TURNS:coturn.test.invalid:5349"];
    expect(
      coturnUrlList({
        TOKIMEKI_COTURN_URLS: withNonString as unknown as readonly string[],
      }),
    ).toEqual(["TURN:coturn.test.invalid:3478", "TURNS:coturn.test.invalid:5349"]);
  });
});

describe("TURN provider selection", () => {
  it("defaults to auto", () => {
    expect(parseTurnMode({})).toBe("auto");
    expect(parseTurnMode({ TOKIMEKI_TURN_PROVIDER: "unknown" })).toBe("auto");
  });

  it("prefers coturn REST in auto mode", () => {
    expect(describeTurn(ALL_PROVIDERS)).toEqual({
      provider: "coturn",
      configured: true,
    });
    expect(resolveIceProvider(ALL_PROVIDERS)).toBe("coturn");
  });

  it("falls back to static, then Cloudflare, then STUN in auto mode", () => {
    expect(resolveIceProvider({ ...STATIC, ...CLOUDFLARE })).toBe("static");
    expect(resolveIceProvider(CLOUDFLARE)).toBe("cloudflare");
    expect(describeTurn({})).toEqual({ provider: "stun", configured: false });
  });

  it("never silently falls from explicit coturn to Cloudflare", () => {
    expect(resolveIceProvider({ ...CLOUDFLARE, TOKIMEKI_TURN_PROVIDER: "coturn" })).toBe("stun");
    expect(describeTurn({ ...CLOUDFLARE, TOKIMEKI_TURN_PROVIDER: "coturn" })).toEqual({
      provider: "stun",
      configured: false,
    });
  });

  it("uses static coturn credentials for explicit coturn when REST is absent", () => {
    expect(resolveIceProvider({ ...STATIC, ...CLOUDFLARE, TOKIMEKI_TURN_PROVIDER: "coturn" })).toBe(
      "static",
    );
  });

  it("keeps explicit Cloudflare on Cloudflare plus STUN", () => {
    expect(resolveIceProvider({ ...ALL_PROVIDERS, TOKIMEKI_TURN_PROVIDER: "cloudflare" })).toBe(
      "cloudflare",
    );
    expect(describeTurn({ ...COTURN, TOKIMEKI_TURN_PROVIDER: "cloudflare" })).toEqual({
      provider: "stun",
      configured: false,
    });
  });

  it("keeps none on STUN only", () => {
    expect(resolveIceProvider({ ...ALL_PROVIDERS, TOKIMEKI_TURN_PROVIDER: "none" })).toBe("stun");
    expect(describeTurn({ ...ALL_PROVIDERS, TOKIMEKI_TURN_PROVIDER: "none" })).toEqual({
      provider: "stun",
      configured: false,
    });
  });

  it("honors ice-refresh provider overrides only when configured", () => {
    expect(resolveIceProvider(ALL_PROVIDERS, "cloudflare")).toBe("cloudflare");
    expect(resolveIceProvider(ALL_PROVIDERS, "static")).toBe("static");
    expect(resolveIceProvider(ALL_PROVIDERS, "coturn")).toBe("coturn");
    expect(resolveIceProvider(ALL_PROVIDERS, "stun")).toBe("stun");
    expect(resolveIceProvider(COTURN, "cloudflare")).toBe("coturn");
  });

  it("constrains ice-refresh overrides to the configured TURN mode", () => {
    expect(resolveIceProvider({ ...ALL_PROVIDERS, TOKIMEKI_TURN_PROVIDER: "none" }, "coturn")).toBe(
      "stun",
    );
    expect(
      resolveIceProvider({ ...ALL_PROVIDERS, TOKIMEKI_TURN_PROVIDER: "none" }, "cloudflare"),
    ).toBe("stun");
    expect(
      resolveIceProvider({ ...ALL_PROVIDERS, TOKIMEKI_TURN_PROVIDER: "coturn" }, "cloudflare"),
    ).toBe("coturn");
    expect(
      resolveIceProvider({ ...ALL_PROVIDERS, TOKIMEKI_TURN_PROVIDER: "coturn" }, "static"),
    ).toBe("static");
    expect(
      resolveIceProvider({ ...ALL_PROVIDERS, TOKIMEKI_TURN_PROVIDER: "cloudflare" }, "coturn"),
    ).toBe("cloudflare");
    expect(
      resolveIceProvider({ ...ALL_PROVIDERS, TOKIMEKI_TURN_PROVIDER: "cloudflare" }, "stun"),
    ).toBe("stun");
    expect(
      resolveIceProvider({ ...ALL_PROVIDERS, TOKIMEKI_TURN_PROVIDER: "auto" }, "cloudflare"),
    ).toBe("cloudflare");
  });

  it("does not issue TURN credentials when the mode forbids the override", async () => {
    const issued = await issueIceConfig({
      env: { ...ALL_PROVIDERS, TOKIMEKI_TURN_PROVIDER: "none" },
      clientId: "viewer-1",
      requestedProvider: "coturn",
    });
    expect(issued.iceProvider).toBe("stun");
    const urls = issued.iceServers.flatMap((server) =>
      Array.isArray(server.urls) ? server.urls : [server.urls],
    );
    expect(urls.every((url) => url.startsWith("stun:"))).toBe(true);
  });
});

describe("TURN credentials", () => {
  it("matches the RFC 2202 HMAC-SHA1 vector", async () => {
    const digest = await hmacSha1Base64("Jefe", "what do ya want for nothing?");
    expect(digest).toBe("7/zfauXrL6LSdBbV8YTfnCWafHk=");
  });

  it("creates coturn REST credentials with expiry-prefixed usernames", async () => {
    const credential = await createCoturnRestCredential(
      "coturn-rest-secret",
      "client-A",
      3_600,
      1_000,
    );
    expect(credential.username).toBe("3601:client-A");
    expect(credential.expiresAt).toBe(3_601_000);
    expect(credential.credential).toBe(await hmacSha1Base64("coturn-rest-secret", "3601:client-A"));
  });

  it("issues one coturn ICE server per URL with a shared credential and no secret leak", async () => {
    const issued = await issueIceConfig({
      env: { ...MULTI_COTURN, TOKIMEKI_STUN_URLS: "stun:stun.test.invalid:3478" },
      clientId: "client-A",
      now: 1_000,
    });
    expect(issued.iceProvider).toBe("coturn");
    expect(issued.iceExpiresAt).toBe(3_601_000);
    const credential = await hmacSha1Base64("coturn-rest-secret", "3601:client-A");
    expect(issued.iceServers).toEqual([
      { urls: "stun:stun.test.invalid:3478" },
      { urls: STUN_URL, username: "3601:client-A", credential },
      { urls: CN_URL, username: "3601:client-A", credential },
    ]);
    const serialized = JSON.stringify(issued);
    expect(serialized).not.toContain("coturn-rest-secret");
    expect(serialized).not.toContain("cf-api-token");
  });

  it("ignores unconfigured provider overrides when issuing ICE", async () => {
    const issued = await issueIceConfig({
      env: COTURN,
      clientId: "client-A",
      requestedProvider: "cloudflare",
      now: 1_000,
    });
    expect(issued.iceProvider).toBe("coturn");
  });

  it("issues STUN-only when no TURN provider is available", async () => {
    const issued = await issueIceConfig({
      env: { TOKIMEKI_STUN_URLS: "stun:stun.test.invalid:3478" },
      clientId: "client-A",
      now: 1_000,
    });
    expect(issued.iceProvider).toBe("stun");
    expect(issued.iceExpiresAt).toBeNull();
    expect(issued.fallbackReason).toBeUndefined();
    expect(issued.iceServers).toEqual([{ urls: "stun:stun.test.invalid:3478" }]);
  });

  it("treats empty, invalid or secret-less coturn lists as unconfigured", async () => {
    const stunEnv = { TOKIMEKI_STUN_URLS: "stun:stun.test.invalid:3478" };
    expect(
      resolveIceProvider({ ...stunEnv, TOKIMEKI_COTURN_URLS: [], TOKIMEKI_COTURN_SECRET: "s" }),
    ).toBe("stun");
    expect(
      resolveIceProvider({
        ...stunEnv,
        TOKIMEKI_COTURN_URLS: ["stun:not-turn:3478", "", "  "],
        TOKIMEKI_COTURN_SECRET: "s",
      }),
    ).toBe("stun");
    expect(resolveIceProvider({ ...MULTI_COTURN, TOKIMEKI_COTURN_SECRET: undefined })).toBe("stun");
    expect(resolveIceProvider({ ...STATIC, ...CLOUDFLARE, TOKIMEKI_COTURN_URLS: [STUN_URL] })).toBe(
      "static",
    );
    expect(resolveIceProvider({ ...CLOUDFLARE, TOKIMEKI_COTURN_URLS: [STUN_URL] })).toBe(
      "cloudflare",
    );

    const issued = await issueIceConfig({
      env: { ...stunEnv, TOKIMEKI_COTURN_URLS: [] },
      clientId: "client-A",
      now: 1_000,
    });
    expect(issued.iceProvider).toBe("stun");
    expect(issued.fallbackReason).toBeUndefined();
  });

  it("defaults TURN credentials to a 15 minute TTL", async () => {
    const issued = await issueIceConfig({
      env: {
        TOKIMEKI_COTURN_URLS: [STUN_URL],
        TOKIMEKI_COTURN_SECRET: "coturn-rest-secret",
        TOKIMEKI_STUN_URLS: "stun:stun.test.invalid:3478",
      },
      clientId: "client-A",
      now: 1_000,
    });
    expect(issued.iceProvider).toBe("coturn");
    expect(issued.iceExpiresAt).toBe(1_000 + 15 * 60 * 1000);
    const turnServer = issued.iceServers.find((server) => server.username !== undefined);
    expect(turnServer?.username).toBe("901:client-A");
    expect(turnServer?.credential).toBe(await hmacSha1Base64("coturn-rest-secret", "901:client-A"));
  });

  it("requests the default Cloudflare TTL and clamps explicit overrides", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ iceServers: [{ urls: "turn:cf.test.invalid:3478" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const defaulted = await issueIceConfig({
        env: { ...CLOUDFLARE, TOKIMEKI_TURN_PROVIDER: "cloudflare" },
        clientId: "client-A",
        now: 1_000,
      });
      expect(defaulted.iceProvider).toBe("cloudflare");
      expect(defaulted.iceExpiresAt).toBe(1_000 + 15 * 60 * 1000);
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ ttl: 900 });

      const clamped = await issueIceConfig({
        env: {
          ...CLOUDFLARE,
          TOKIMEKI_TURN_PROVIDER: "cloudflare",
          TOKIMEKI_TURN_TTL_SECONDS: "999999",
        },
        clientId: "client-B",
        now: 0,
      });
      expect(clamped.iceExpiresAt).toBe(172_800_000);
      expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ ttl: 172_800 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("marks a configured TURN provider failure as a STUN fallback", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const issued = await issueIceConfig({
        env: {
          ...CLOUDFLARE,
          TOKIMEKI_TURN_PROVIDER: "cloudflare",
          TOKIMEKI_STUN_URLS: "stun:stun.test.invalid:3478",
        },
        clientId: "client-A",
        now: 1_000,
      });
      expect(issued.iceProvider).toBe("stun");
      expect(issued.fallbackReason).toBe("turn_issue_failed");
      expect(issued.iceServers).toEqual([{ urls: "stun:stun.test.invalid:3478" }]);
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
