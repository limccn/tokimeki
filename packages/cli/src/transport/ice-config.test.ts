import type {
  IceProvider,
  IceServerConfig,
  KnownControlMessage,
  WelcomeMessage,
} from "@limccn/tokimeki-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Logger } from "../logger.js";
import {
  hasTurnServer,
  ICE_REFRESH_QUIET_MS,
  ICE_REFRESH_TIMEOUT_MS,
  ICE_RETRY_INITIAL_MS,
  IceConfigManager,
  nextRetryProviders,
  P2P_RETRY_REFRESH_BUDGET_MS,
} from "./ice-config.js";

const logger = new Logger({ level: "silent", write: () => {} });

function serversFor(provider: IceProvider): IceServerConfig[] {
  return provider === "stun"
    ? [{ urls: "stun:stun.example.com:3478" }]
    : [
        {
          urls: "turn:turn.example.com:3478?transport=udp",
          username: "user",
          credential: "credential",
        },
      ];
}

function welcome(provider: IceProvider, expiresAt: number | null): WelcomeMessage {
  return {
    v: 1,
    type: "welcome",
    session: "demo-session",
    protocolVersion: 1,
    hostOnline: true,
    clients: [],
    iceServers: serversFor(provider),
    iceProvider: provider,
    iceExpiresAt: expiresAt,
    transportPolicy: "all",
    sessionTtlSeconds: 3600,
  };
}

function ice(
  provider: IceProvider,
  expiresAt: number | null,
): Extract<KnownControlMessage, { type: "ice" }> {
  return {
    v: 1,
    type: "ice",
    iceServers: serversFor(provider),
    iceProvider: provider,
    iceExpiresAt: expiresAt,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ice provider helpers", () => {
  it("detects TURN URLs and orders retry candidates", () => {
    expect(hasTurnServer(serversFor("coturn"))).toBe(true);
    expect(hasTurnServer(serversFor("stun"))).toBe(false);
    expect(nextRetryProviders("coturn")).toEqual(["static", "cloudflare"]);
    expect(nextRetryProviders("static")).toEqual(["cloudflare"]);
    expect(nextRetryProviders("cloudflare")).toEqual([]);
    expect(nextRetryProviders("stun")).toEqual([]);
  });
});

describe("IceConfigManager", () => {
  it("refreshes shortly before expiry and applies the response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    let manager!: IceConfigManager;
    const sendIceRefresh = vi.fn(() => {
      queueMicrotask(() => {
        manager.updateFromIce(ice("coturn", Date.now() + 60_000));
      });
    });
    manager = new IceConfigManager({ logger, sendIceRefresh, random: () => 0 });
    manager.onRelayState("ready");
    manager.updateFromWelcome(welcome("coturn", Date.now() + 100_000));

    vi.advanceTimersByTime(89_999);
    expect(sendIceRefresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(sendIceRefresh).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(manager.current.expiresAt).toBe(Date.now() + 60_000);
  });

  it("does not schedule when iceExpiresAt is null", () => {
    vi.useFakeTimers();
    const sendIceRefresh = vi.fn();
    const manager = new IceConfigManager({ logger, sendIceRefresh });
    manager.onRelayState("ready");
    manager.updateFromWelcome(welcome("stun", null));
    vi.advanceTimersByTime(10_000_000);
    expect(sendIceRefresh).not.toHaveBeenCalled();
  });

  it("rejects refresh until the relay is ready", async () => {
    const manager = new IceConfigManager({ logger, sendIceRefresh: vi.fn() });
    await expect(manager.refresh()).rejects.toThrow("relay_not_ready");
  });

  it("uses the next provider after the failed one", async () => {
    let manager!: IceConfigManager;
    const requested: Array<IceProvider | undefined> = [];
    manager = new IceConfigManager({
      logger,
      sendIceRefresh: (provider) => {
        requested.push(provider);
        queueMicrotask(() => {
          manager.updateFromIce(ice(provider ?? "coturn", null));
        });
      },
    });
    manager.onRelayState("ready");
    manager.updateFromWelcome(welcome("coturn", null));

    const config = await manager.refreshForRetry();
    expect(requested).toEqual(["static"]);
    expect(config?.provider).toBe("static");
  });

  it("continues to the next candidate when the relay returns the failed provider", async () => {
    let manager!: IceConfigManager;
    const requested: Array<IceProvider | undefined> = [];
    const responses: IceProvider[] = ["coturn", "cloudflare"];
    manager = new IceConfigManager({
      logger,
      sendIceRefresh: (provider) => {
        requested.push(provider);
        const actual = responses.shift() ?? "coturn";
        queueMicrotask(() => {
          manager.updateFromIce(ice(actual, null));
        });
      },
    });
    manager.onRelayState("ready");
    manager.updateFromWelcome(welcome("coturn", null));

    const config = await manager.refreshForRetry();
    expect(requested).toEqual(["static", "cloudflare"]);
    expect(config?.provider).toBe("cloudflare");
  });

  it("recovers a transient STUN-only config with one default refresh", async () => {
    let manager!: IceConfigManager;
    const requested: Array<IceProvider | undefined> = [];
    manager = new IceConfigManager({
      logger,
      sendIceRefresh: (provider) => {
        requested.push(provider);
        queueMicrotask(() => {
          manager.updateFromIce(ice("coturn", null));
        });
      },
    });
    manager.onRelayState("ready");
    manager.updateFromWelcome(welcome("stun", null));

    const config = await manager.refreshForRetry();
    expect(requested).toEqual([undefined]);
    expect(config?.provider).toBe("coturn");
  });

  it("rejects a pending refresh when the relay disconnects", async () => {
    const manager = new IceConfigManager({ logger, sendIceRefresh: vi.fn() });
    manager.onRelayState("ready");
    manager.updateFromWelcome(welcome("coturn", null));

    const pending = manager.refresh();
    manager.onRelayState("reconnecting");
    await expect(pending).rejects.toThrow("relay_not_ready");
  });

  it("rejects a pending refresh on dispose", async () => {
    const manager = new IceConfigManager({ logger, sendIceRefresh: vi.fn() });
    manager.onRelayState("ready");
    manager.updateFromWelcome(welcome("coturn", null));

    const pending = manager.refresh();
    manager.dispose();
    await expect(pending).rejects.toThrow("ice_config_disposed");
  });

  it("serializes concurrent refreshes without dropping a request", async () => {
    let manager!: IceConfigManager;
    const requested: Array<IceProvider | undefined> = [];
    manager = new IceConfigManager({
      logger,
      sendIceRefresh: (provider) => {
        requested.push(provider);
        queueMicrotask(() => {
          manager.updateFromIce(ice(provider ?? "coturn", null));
        });
      },
    });
    manager.onRelayState("ready");
    manager.updateFromWelcome(welcome("coturn", null));

    const results = await Promise.all([
      manager.refresh(),
      manager.refresh("static"),
      manager.refresh("cloudflare"),
    ]);
    expect(requested).toEqual([undefined, "static", "cloudflare"]);
    expect(results.map((config) => config.provider)).toEqual(["coturn", "static", "cloudflare"]);
  });

  it("keeps a quiet period after a refresh timeout", async () => {
    vi.useFakeTimers();
    const requested: Array<IceProvider | undefined> = [];
    const manager = new IceConfigManager({
      logger,
      sendIceRefresh: (provider) => requested.push(provider),
    });
    manager.onRelayState("ready");
    manager.updateFromWelcome(welcome("coturn", null));

    const first = manager.refresh();
    const firstRejected = expect(first).rejects.toThrow("ice_refresh_timeout");
    await vi.advanceTimersByTimeAsync(ICE_REFRESH_TIMEOUT_MS);
    await firstRejected;
    expect(requested).toEqual([undefined]);

    const second = manager.refresh("static");
    await vi.advanceTimersByTimeAsync(ICE_REFRESH_QUIET_MS - 1);
    expect(requested).toEqual([undefined]);
    await vi.advanceTimersByTimeAsync(1);
    expect(requested).toEqual([undefined, "static"]);

    manager.dispose();
    await expect(second).rejects.toThrow("ice_config_disposed");
  });

  it("stops refreshForRetry when the provider budget is exhausted", async () => {
    vi.useFakeTimers();
    const requested: Array<IceProvider | undefined> = [];
    const manager = new IceConfigManager({
      logger,
      sendIceRefresh: (provider) => requested.push(provider),
    });
    manager.onRelayState("ready");
    manager.updateFromWelcome(welcome("coturn", null));

    const retry = manager.refreshForRetry();
    await vi.advanceTimersByTimeAsync(P2P_RETRY_REFRESH_BUDGET_MS);
    await expect(retry).resolves.toBeNull();
    expect(requested).toEqual(["static", "cloudflare"]);
  });

  it("never schedules a short-TTL refresh past expiry minus one second", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const sendIceRefresh = vi.fn();
    const manager = new IceConfigManager({ logger, sendIceRefresh, random: () => 0.9 });
    manager.onRelayState("ready");
    manager.updateFromWelcome(welcome("coturn", Date.now() + 4_000));

    vi.advanceTimersByTime(2_799);
    expect(sendIceRefresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(sendIceRefresh).toHaveBeenCalledTimes(1);
  });

  it("resets the refresh schedule from a new welcome after a reconnect", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const sendIceRefresh = vi.fn();
    const manager = new IceConfigManager({ logger, sendIceRefresh, random: () => 0 });
    manager.onRelayState("ready");
    manager.updateFromWelcome(welcome("coturn", Date.now() + 100_000));

    manager.onRelayState("reconnecting");
    manager.onRelayState("ready");
    manager.updateFromWelcome(welcome("coturn", Date.now() + 200_000));

    vi.advanceTimersByTime(179_999);
    expect(sendIceRefresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(sendIceRefresh).toHaveBeenCalledTimes(1);
  });

  it("backs off after a scheduled refresh timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const sendIceRefresh = vi.fn();
    const manager = new IceConfigManager({ logger, sendIceRefresh, random: () => 0 });
    manager.onRelayState("ready");
    manager.updateFromWelcome(welcome("coturn", Date.now() + 6_000));

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sendIceRefresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ICE_REFRESH_TIMEOUT_MS);
    expect(sendIceRefresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ICE_RETRY_INITIAL_MS - 1);
    expect(sendIceRefresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sendIceRefresh).toHaveBeenCalledTimes(2);
  });

  it("logs provider metadata without TURN credentials", () => {
    const lines: string[] = [];
    const capture = new Logger({ level: "debug", write: (line) => lines.push(line) });
    const manager = new IceConfigManager({ logger: capture, sendIceRefresh: vi.fn() });
    manager.onRelayState("ready");
    manager.updateFromWelcome(welcome("coturn", Date.now() + 100_000));

    const log = lines.join("\n");
    expect(log).toContain("provider=coturn");
    expect(log).not.toContain("credential");
    expect(log).not.toContain("username");
  });
});
