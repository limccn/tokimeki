import { describe, expect, it } from "vitest";
import { ConfigError, loadAttachConfig, loadHostConfig } from "./config.js";
import { ConfigEnvelopeError, parseConfigEnvelope } from "./config-envelope.js";

function configJson(value: unknown): string {
  return JSON.stringify(value);
}

describe("parseConfigEnvelope", () => {
  it("maps known JSON fields to TOKIMEKI_* variables", () => {
    const env = parseConfigEnvelope(
      configJson({
        v: 1,
        relayUrl: "wss://relay.example",
        session: "demo",
        sessionToken: "token-1234",
        masterToken: "master-1234",
        namespaceToken: "namespace-token-1234",
        namespace: "team-a",
        window: { cols: 100, rows: 30 },
        windowTui: ["claude", "omp"],
        logPanelRows: 4,
        inviteKey: "f12",
        claudeBg: true,
        unknownFutureField: { ignored: true },
      }),
    );
    expect(env).toMatchObject({
      TOKIMEKI_RELAY_URL: "wss://relay.example",
      TOKIMEKI_SESSION: "demo",
      TOKIMEKI_SESSION_TOKEN: "token-1234",
      TOKIMEKI_MASTER_TOKEN: "master-1234",
      TOKIMEKI_NAMESPACE_TOKEN: "namespace-token-1234",
      TOKIMEKI_NAMESPACE: "team-a",
      TOKIMEKI_WINDOW_SIZE: "100x30",
      TOKIMEKI_WINDOW_TUI: "claude,omp",
      TOKIMEKI_LOG_PANEL_ROWS: "4",
      TOKIMEKI_INVITE_KEY: "f12",
      TOKIMEKI_CLAUDE_BG: "1",
    });
    expect(env.TOKIMEKI_UNKNOWN_FUTURE_FIELD).toBeUndefined();
  });

  it("accepts a size string and rejects bad shapes without echoing values", () => {
    expect(parseConfigEnvelope(configJson({ window: "120x40" })).TOKIMEKI_WINDOW_SIZE).toBe(
      "120x40",
    );
    for (const value of ["secret-value", { cols: 0, rows: 40 }, { cols: 1.5, rows: 40 }]) {
      try {
        parseConfigEnvelope(configJson({ window: value }));
        throw new Error("expected ConfigEnvelopeError");
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigEnvelopeError);
        expect((error as Error).message).not.toContain("secret-value");
      }
    }
  });

  it("rejects invalid JSON, non-objects, and unsupported versions", () => {
    expect(() => parseConfigEnvelope("{not json")).toThrow(ConfigEnvelopeError);
    expect(() => parseConfigEnvelope("[]")).toThrow(ConfigEnvelopeError);
    expect(() => parseConfigEnvelope(configJson({ v: 2 }))).toThrow(ConfigEnvelopeError);
  });
});

describe("TOKIMEKI_CONFIG integration", () => {
  it("loads a host from the JSON envelope", () => {
    const config = loadHostConfig({
      env: {
        TOKIMEKI_CONFIG: configJson({
          v: 1,
          relayUrl: "https://relay.example",
          session: "demo",
          sessionToken: "session-token-1234",
          masterToken: "master-token-1234",
          window: { cols: 100, rows: 30 },
        }),
      },
    });
    expect(config.relayUrl).toBe("wss://relay.example");
    expect(config.session).toBe("demo");
    expect(config.websocketUrl).toBe("wss://relay.example/ws/demo");
    expect(config.sessionToken).toBe("session-token-1234");
    expect(config.sessionTokenGenerated).toBe(false);
    expect(config.windowSize).toEqual({ cols: 100, rows: 30 });
    expect(config.secrets).toContain("session-token-1234");
    expect(config.secrets).toContain("master-token-1234");
  });

  it("lets explicit environment variables override the envelope", () => {
    const config = loadHostConfig({
      env: {
        TOKIMEKI_CONFIG: configJson({
          relayUrl: "https://relay.example",
          session: "config-session",
          sessionToken: "config-token-1234",
          masterToken: "master-token-1234",
        }),
        TOKIMEKI_SESSION: "env-session",
        TOKIMEKI_SESSION_TOKEN: "",
      },
    });
    expect(config.session).toBe("env-session");
    // Empty env placeholders do not erase the envelope value.
    expect(config.sessionToken).toBe("config-token-1234");
  });

  it("loads an attach config from the invite JSON", () => {
    const config = loadAttachConfig({
      TOKIMEKI_CONFIG: configJson({
        v: 1,
        relayUrl: "wss://relay.example",
        session: "demo",
        sessionToken: "session-token-1234",
        window: { cols: 120, rows: 40 },
      }),
    });
    expect(config.session).toBe("demo");
    expect(config.sessionToken).toBe("session-token-1234");
    expect(config.windowMode).toBe("tui");
  });

  it("loads a namespace host from the JSON envelope", () => {
    const config = loadHostConfig({
      env: {
        TOKIMEKI_CONFIG: configJson({
          v: 1,
          relayUrl: "https://relay.example",
          session: "team-a.demo",
          sessionToken: "session-token-1234",
          namespaceToken: "namespace-token-1234",
          namespace: "team-a",
        }),
      },
    });
    expect(config.authMode).toBe("namespace");
    expect(config.hostToken).toBe("namespace-token-1234");
    expect(config.namespace).toBe("team-a");
    expect(config.websocketUrl).toBe("wss://relay.example/ws/team-a.demo");
    expect(config.secrets).toContain("namespace-token-1234");
  });

  it("reports invalid envelopes as configuration errors", () => {
    expect(() => loadHostConfig({ env: { TOKIMEKI_CONFIG: '{"v":2}' } })).toThrow(ConfigError);
  });
});
