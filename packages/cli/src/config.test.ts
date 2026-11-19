import { describe, expect, it } from "vitest";

import {
  buildRelayWebSocketUrl,
  ConfigError,
  collectV11Warnings,
  DEFAULT_HEARTBEAT_SECONDS,
  DEFAULT_LISTENER_SNAPSHOT_MS,
  DEFAULT_LOG_PANEL_ROWS,
  DEFAULT_SCROLLBACK_LINES,
  DEFAULT_SNAPSHOT_MAX_BYTES,
  DEFAULT_WINDOW_SIZE,
  loadAttachConfig,
  loadDoctorConfig,
  loadHostConfig,
  MAX_LISTENER_SNAPSHOT_MS,
  MAX_SCROLLBACK_LINES,
  MIN_LISTENER_SNAPSHOT_MS,
  MIN_SCROLLBACK_LINES,
  normalizeRelayBaseUrl,
  relayHealthUrl,
  relayWhoamiUrl,
  sanitizeSessionId,
} from "./config.js";

function baseHostEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    TOKIMEKI_RELAY_URL: "https://relay.example",
    TOKIMEKI_MASTER_TOKEN: "master-token-1234",
    TOKIMEKI_SESSION: "sess-1",
    ...overrides,
  };
}

describe("normalizeRelayBaseUrl", () => {
  it("converts https to wss and strips trailing slashes", () => {
    expect(normalizeRelayBaseUrl("https://relay.example/")).toBe("wss://relay.example");
    expect(normalizeRelayBaseUrl("https://relay.example/base///")).toBe("wss://relay.example/base");
  });

  it("converts http to ws", () => {
    expect(normalizeRelayBaseUrl("http://localhost:8787")).toBe("ws://localhost:8787");
    expect(normalizeRelayBaseUrl("ws://localhost:8787/")).toBe("ws://localhost:8787");
    expect(normalizeRelayBaseUrl("wss://relay.example")).toBe("wss://relay.example");
  });

  it("rejects credentials, query strings, and fragments without echoing them", () => {
    expect(() => normalizeRelayBaseUrl("https://user:pass@relay.example")).toThrow(ConfigError);
    const queryError = (() => {
      try {
        normalizeRelayBaseUrl("https://relay.example/ws?token=supersecret");
        return null;
      } catch (error) {
        return error as Error;
      }
    })();
    expect(queryError).toBeInstanceOf(ConfigError);
    expect(queryError?.message).not.toContain("supersecret");
    expect(() => normalizeRelayBaseUrl("https://relay.example/#frag")).toThrow(ConfigError);
  });

  it("rejects non-http protocols and unparsable values", () => {
    expect(() => normalizeRelayBaseUrl("ftp://relay.example")).toThrow(ConfigError);
    expect(() => normalizeRelayBaseUrl("not a url")).toThrow(ConfigError);
  });
});

describe("relay URL helpers", () => {
  it("builds the websocket URL with the session only", () => {
    expect(buildRelayWebSocketUrl("wss://relay.example", "sess-1")).toBe(
      "wss://relay.example/ws/sess-1",
    );
    expect(buildRelayWebSocketUrl("wss://relay.example/base", "sess-1")).toBe(
      "wss://relay.example/base/ws/sess-1",
    );
  });

  it("rejects invalid session IDs", () => {
    expect(() => buildRelayWebSocketUrl("wss://relay.example", "bad session")).toThrow(ConfigError);
  });

  it("derives the health endpoint", () => {
    expect(relayHealthUrl("wss://relay.example/base")).toBe("https://relay.example/base/healthz");
    expect(relayHealthUrl("ws://localhost:8787")).toBe("http://localhost:8787/healthz");
  });

  it("derives the authenticated whoami endpoint", () => {
    expect(relayWhoamiUrl("wss://relay.example/base")).toBe(
      "https://relay.example/base/auth/whoami",
    );
    expect(relayWhoamiUrl("ws://localhost:8787")).toBe("http://localhost:8787/auth/whoami");
  });

  it("sanitizes arbitrary hostnames and paths into session IDs", () => {
    expect(sanitizeSessionId("Some Host-C:\\Users\\X\\Project 1")).toBe(
      "Some-Host-C-Users-X-Project-1",
    );
    expect(sanitizeSessionId("***")).toBe("session");
    expect(sanitizeSessionId("a".repeat(100))).toHaveLength(64);
  });
});

describe("loadHostConfig", () => {
  it("applies documented defaults", () => {
    const config = loadHostConfig({
      env: baseHostEnv(),
      cwd: "/work/project",
      hostname: "testhost",
    });

    expect(config.role).toBe("host");
    expect(config.relayUrl).toBe("wss://relay.example");
    expect(config.websocketUrl).toBe("wss://relay.example/ws/sess-1");
    expect(config.session).toBe("sess-1");
    expect(config.heartbeatSeconds).toBe(DEFAULT_HEARTBEAT_SECONDS);
    expect(config.scrollbackLines).toBe(DEFAULT_SCROLLBACK_LINES);
    expect(config.snapshotMaxBytes).toBe(DEFAULT_SNAPSHOT_MAX_BYTES);
    expect(config.listenerSnapshotMs).toBe(DEFAULT_LISTENER_SNAPSHOT_MS);
    expect(config.term).toBe("xterm-256color");
    expect(config.colorterm).toBe("truecolor");
    expect(config.resizePolicy).toBe("latest");
    expect(config.p2p).toBe("auto");
    expect(config.iceTransportPolicy).toBe("all");
    expect(config.tunnel).toBe("off");
    expect(config.tunnelFec).toBe("off");
    expect(config.tunnelKeyMode).toBe("session-token");
    expect(config.tunnelSecret).toBeNull();
    expect(config.piTuiMode).toBe("fullscreen");
    expect(config.ptySize).toBeNull();
    expect(config.windowMode).toBe("tui");
    expect(config.windowSize).toEqual(DEFAULT_WINDOW_SIZE);
    expect([...config.windowTuiCommands]).toEqual(["claude", "pi"]);
    expect(config.logPanelRows).toBe(DEFAULT_LOG_PANEL_ROWS);
    expect(config.inviteKey).toBe("f12");
    expect(config.claudeBg).toBe(false);
  });

  it("generates a session token when none is provided and records it as a secret", () => {
    const config = loadHostConfig({ env: baseHostEnv() });
    expect(config.sessionTokenGenerated).toBe(true);
    expect(config.sessionToken.length).toBeGreaterThanOrEqual(32);
    expect(config.secrets).toContain(config.sessionToken);
    expect(config.secrets).toContain("master-token-1234");
  });

  it("marks a provided session token as not generated", () => {
    const config = loadHostConfig({
      env: baseHostEnv({ TOKIMEKI_SESSION_TOKEN: "provided-session-token" }),
    });
    expect(config.sessionTokenGenerated).toBe(false);
    expect(config.sessionToken).toBe("provided-session-token");
    expect(config.secrets).toContain("provided-session-token");
  });

  it("rejects identical master and session tokens", () => {
    expect(() =>
      loadHostConfig({
        env: baseHostEnv({ TOKIMEKI_SESSION_TOKEN: "master-token-1234" }),
      }),
    ).toThrow(/must be different/);
  });

  it("derives a sanitized default session from hostname and cwd", () => {
    const config = loadHostConfig({
      env: baseHostEnv({ TOKIMEKI_SESSION: undefined }),
      cwd: "/work/project",
      hostname: "my host",
    });
    expect(config.session).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
    expect(config.session.startsWith("my-host")).toBe(true);
  });

  it("requires a relay URL and a master token", () => {
    expect(() => loadHostConfig({ env: { TOKIMEKI_MASTER_TOKEN: "x" } })).toThrow(
      /TOKIMEKI_RELAY_URL is required/,
    );
    expect(() => loadHostConfig({ env: { TOKIMEKI_RELAY_URL: "https://relay.example" } })).toThrow(
      /TOKIMEKI_MASTER_TOKEN is required/,
    );
  });

  it("clamps scrollback to the v1 range", () => {
    expect(
      loadHostConfig({ env: baseHostEnv({ TOKIMEKI_SCROLLBACK_LINES: "100" }) }).scrollbackLines,
    ).toBe(MIN_SCROLLBACK_LINES);
    expect(
      loadHostConfig({ env: baseHostEnv({ TOKIMEKI_SCROLLBACK_LINES: "99999" }) }).scrollbackLines,
    ).toBe(MAX_SCROLLBACK_LINES);
    expect(
      loadHostConfig({ env: baseHostEnv({ TOKIMEKI_SCROLLBACK_LINES: "750" }) }).scrollbackLines,
    ).toBe(750);
    expect(() =>
      loadHostConfig({ env: baseHostEnv({ TOKIMEKI_SCROLLBACK_LINES: "abc" }) }),
    ).toThrow(ConfigError);
  });

  it("parses PTY size, resize policy, and pi TUI mode", () => {
    const config = loadHostConfig({
      env: baseHostEnv({
        TOKIMEKI_PTY_SIZE: "100x30",
        TOKIMEKI_RESIZE_POLICY: "min",
        TOKIMEKI_PI_TUI_MODE: "regular",
      }),
    });
    expect(config.ptySize).toEqual({ cols: 100, rows: 30 });
    expect(config.resizePolicy).toBe("min");
    expect(config.piTuiMode).toBe("regular");
    expect(() => loadHostConfig({ env: baseHostEnv({ TOKIMEKI_PTY_SIZE: "100 30" }) })).toThrow(
      ConfigError,
    );
    expect(() =>
      loadHostConfig({ env: baseHostEnv({ TOKIMEKI_RESIZE_POLICY: "everyone" }) }),
    ).toThrow(ConfigError);
  });

  it("parses TUI window mode, command list, size, and log panel rows", () => {
    const config = loadHostConfig({
      env: baseHostEnv({
        TOKIMEKI_WINDOW: "on",
        TOKIMEKI_WINDOW_TUI: " omp, OMP ,, pi.exe ",
        TOKIMEKI_WINDOW_SIZE: "200x50",
        TOKIMEKI_LOG_PANEL_ROWS: "4",
        TOKIMEKI_INVITE_KEY: "ctrl-]",
      }),
    });
    expect(config.windowMode).toBe("on");
    expect([...config.windowTuiCommands]).toEqual(["omp", "pi"]);
    expect(config.windowSize).toEqual({ cols: 200, rows: 50 });
    expect(config.logPanelRows).toBe(4);
    expect(config.inviteKey).toBe("ctrl-]");

    const empty = loadHostConfig({
      env: baseHostEnv({ TOKIMEKI_WINDOW: "off", TOKIMEKI_WINDOW_TUI: "" }),
    });
    expect(empty.windowMode).toBe("off");
    expect([...empty.windowTuiCommands]).toEqual([]);

    expect(() => loadHostConfig({ env: baseHostEnv({ TOKIMEKI_WINDOW: "auto" }) })).toThrow(
      ConfigError,
    );
    expect(() => loadHostConfig({ env: baseHostEnv({ TOKIMEKI_WINDOW_SIZE: "100 30" }) })).toThrow(
      ConfigError,
    );
    expect(() =>
      loadHostConfig({ env: baseHostEnv({ TOKIMEKI_WINDOW_SIZE: "5000x5000" }) }),
    ).toThrow(ConfigError);
    expect(() => loadHostConfig({ env: baseHostEnv({ TOKIMEKI_LOG_PANEL_ROWS: "-1" }) })).toThrow(
      ConfigError,
    );
    expect(() => loadHostConfig({ env: baseHostEnv({ TOKIMEKI_INVITE_KEY: "esc" }) })).toThrow(
      ConfigError,
    );
  });

  it("keeps PTY_SIZE and WINDOW_SIZE independent for host precedence", () => {
    const config = loadHostConfig({
      env: baseHostEnv({
        TOKIMEKI_PTY_SIZE: "100x30",
        TOKIMEKI_WINDOW_SIZE: "120x40",
      }),
    });
    expect(config.ptySize).toEqual({ cols: 100, rows: 30 });
    expect(config.windowSize).toEqual({ cols: 120, rows: 40 });
  });

  it("rejects an out-of-range snapshot budget", () => {
    expect(() =>
      loadHostConfig({ env: baseHostEnv({ TOKIMEKI_SNAPSHOT_MAX_BYTES: "10" }) }),
    ).toThrow(ConfigError);
  });

  it("parses and clamps the listener snapshot interval", () => {
    const read = (value: string) =>
      loadHostConfig({ env: baseHostEnv({ TOKIMEKI_LISTENER_SNAPSHOT_MS: value }) });

    expect(read("250").listenerSnapshotMs).toBe(MIN_LISTENER_SNAPSHOT_MS);
    expect(read("60000").listenerSnapshotMs).toBe(MAX_LISTENER_SNAPSHOT_MS);
    expect(read("500").listenerSnapshotMs).toBe(500);

    const below = read("10");
    expect(below.listenerSnapshotMs).toBe(MIN_LISTENER_SNAPSHOT_MS);
    expect(
      below.warnings.some((warning) => warning.includes("TOKIMEKI_LISTENER_SNAPSHOT_MS")),
    ).toBe(true);

    const above = read("99999");
    expect(above.listenerSnapshotMs).toBe(MAX_LISTENER_SNAPSHOT_MS);

    const invalid = read("fast");
    expect(invalid.listenerSnapshotMs).toBe(DEFAULT_LISTENER_SNAPSHOT_MS);
    expect(
      invalid.warnings.some((warning) => warning.includes("TOKIMEKI_LISTENER_SNAPSHOT_MS")),
    ).toBe(true);
  });
});

describe("loadAttachConfig", () => {
  const attachEnv = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    TOKIMEKI_RELAY_URL: "https://relay.example/base",
    TOKIMEKI_SESSION: "sess-1",
    TOKIMEKI_SESSION_TOKEN: "session-token-9876",
    ...overrides,
  });

  it("does not require a master token", () => {
    const config = loadAttachConfig(attachEnv());
    expect(config.role).toBe("viewer");
    expect(config.websocketUrl).toBe("wss://relay.example/base/ws/sess-1");
    expect(config.sessionToken).toBe("session-token-9876");
    expect(config.secrets).toContain("session-token-9876");
  });

  it("requires a session and a session token", () => {
    expect(() => loadAttachConfig(attachEnv({ TOKIMEKI_SESSION: undefined }))).toThrow(
      /TOKIMEKI_SESSION is required/,
    );
    expect(() => loadAttachConfig(attachEnv({ TOKIMEKI_SESSION_TOKEN: undefined }))).toThrow(
      /TOKIMEKI_SESSION_TOKEN is required/,
    );
  });

  it("selects the listener role only when explicitly requested", () => {
    expect(loadAttachConfig(attachEnv()).role).toBe("viewer");
    expect(loadAttachConfig(attachEnv(), { listener: true }).role).toBe("listener");
  });
});

describe("v1.1 environment variables", () => {
  it("emits a single warning with names but never values", () => {
    const warnings = collectV11Warnings({
      TOKIMEKI_ROUTE_POLICY: "lan",
      TOKIMEKI_LAN_DISCOVERY: "1",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("TOKIMEKI_ROUTE_POLICY");
    expect(warnings[0]).toContain("TOKIMEKI_LAN_DISCOVERY");
    expect(warnings[0]).toContain("not implemented");
  });

  it("adds the warning through host and attach configs", () => {
    const host = loadHostConfig({
      env: baseHostEnv({ TOKIMEKI_ROUTE_POLICY: "lan" }),
    });
    expect(host.warnings).toHaveLength(1);

    const attach = loadAttachConfig({
      TOKIMEKI_RELAY_URL: "https://relay.example",
      TOKIMEKI_SESSION: "sess-1",
      TOKIMEKI_SESSION_TOKEN: "token-1234",
      TOKIMEKI_VIEW_MODE: "auto",
    });
    expect(attach.warnings).toHaveLength(1);
  });
});

describe("tunnel configuration", () => {
  it("defaults to off and session-token mode", () => {
    const config = loadHostConfig({ env: baseHostEnv() });
    expect(config.tunnel).toBe("off");
    expect(config.tunnelKeyMode).toBe("session-token");
    expect(config.tunnelSecret).toBeNull();
    expect(config.tunnelFec).toBe("off");
  });

  it("enables auto and switches to shared-secret when a secret is configured", () => {
    const secret = "1234567890abcdef";
    const config = loadHostConfig({
      env: baseHostEnv({
        TOKIMEKI_TUNNEL: "auto",
        TOKIMEKI_TUNNEL_SECRET: secret,
      }),
    });
    expect(config.tunnel).toBe("auto");
    expect(config.tunnelKeyMode).toBe("shared-secret");
    expect(config.tunnelSecret).toBe(secret);
    expect(config.secrets).toContain(secret);
  });

  it("rejects a short tunnel secret only when the tunnel is enabled", () => {
    expect(() =>
      loadHostConfig({
        env: baseHostEnv({ TOKIMEKI_TUNNEL: "auto", TOKIMEKI_TUNNEL_SECRET: "short" }),
      }),
    ).toThrow(/at least 16 bytes/);
    expect(() =>
      loadHostConfig({
        env: baseHostEnv({ TOKIMEKI_TUNNEL_SECRET: "short" }),
      }),
    ).not.toThrow();
  });

  it("never echoes a bad secret value in the error message", () => {
    try {
      loadHostConfig({
        env: baseHostEnv({ TOKIMEKI_TUNNEL: "auto", TOKIMEKI_TUNNEL_SECRET: "leaky-secret" }),
      });
    } catch (error) {
      expect((error as Error).message).not.toContain("leaky-secret");
      return;
    }
    throw new Error("expected ConfigError");
  });

  it("accepts XOR FEC and keeps it for the sender policy", () => {
    const config = loadHostConfig({
      env: baseHostEnv({ TOKIMEKI_TUNNEL: "auto", TOKIMEKI_TUNNEL_FEC: "xor" }),
    });
    expect(config.tunnelFec).toBe("xor");
    expect(config.warnings.some((warning) => warning.includes("FEC"))).toBe(false);
  });

  it("normalizes off/none aliases without a warning", () => {
    for (const value of ["off", "none", "0"]) {
      const config = loadHostConfig({
        env: baseHostEnv({ TOKIMEKI_TUNNEL: "auto", TOKIMEKI_TUNNEL_FEC: value }),
      });
      expect(config.tunnelFec).toBe("off");
      expect(config.warnings.some((warning) => warning.includes("FEC"))).toBe(false);
    }
  });

  it("rejects unknown tunnel modes and FEC values", () => {
    expect(() => loadHostConfig({ env: baseHostEnv({ TOKIMEKI_TUNNEL: "on" }) })).toThrow(
      ConfigError,
    );
    expect(() => loadHostConfig({ env: baseHostEnv({ TOKIMEKI_TUNNEL_FEC: "rs" }) })).toThrow(
      ConfigError,
    );
  });

  it("warns when auto is requested without P2P or with a listener", () => {
    const noP2p = loadHostConfig({
      env: baseHostEnv({ TOKIMEKI_TUNNEL: "auto", TOKIMEKI_P2P: "off" }),
    });
    expect(noP2p.warnings.some((warning) => warning.includes("requires P2P"))).toBe(true);

    const listener = loadAttachConfig(
      {
        TOKIMEKI_RELAY_URL: "https://relay.example",
        TOKIMEKI_SESSION: "sess-1",
        TOKIMEKI_SESSION_TOKEN: "token-1234",
        TOKIMEKI_TUNNEL: "auto",
      },
      { listener: true },
    );
    expect(listener.warnings.some((warning) => warning.includes("read-only listeners"))).toBe(true);
    expect(listener.tunnel).toBe("auto");
  });
});

describe("loadDoctorConfig", () => {
  it("reports partial configuration instead of throwing", () => {
    const config = loadDoctorConfig({});
    expect(config.relayUrl).toBeNull();
    expect(config.session).toBeNull();
    expect(config.hasMasterToken).toBe(false);
    expect(config.masterToken).toBeNull();
    expect(config.hasSessionToken).toBe(false);
  });

  it("normalizes a configured relay URL", () => {
    const config = loadDoctorConfig({
      TOKIMEKI_RELAY_URL: "https://relay.example/",
      TOKIMEKI_SESSION: "sess-1",
      TOKIMEKI_SESSION_TOKEN: "session-token-9876",
    });
    expect(config.relayUrl).toBe("wss://relay.example");
    expect(config.session).toBe("sess-1");
    expect(config.hasSessionToken).toBe(true);
    expect(config.secrets).toContain("session-token-9876");
  });

  it("exposes the master token only for the whoami probe", () => {
    const config = loadDoctorConfig({
      TOKIMEKI_RELAY_URL: "https://relay.example",
      TOKIMEKI_MASTER_TOKEN: "master-token-1234",
    });
    expect(config.hasMasterToken).toBe(true);
    expect(config.masterToken).toBe("master-token-1234");
    expect(config.secrets).toContain("master-token-1234");
  });

  it("warns when the master and session tokens are identical", () => {
    const config = loadDoctorConfig({
      TOKIMEKI_RELAY_URL: "https://relay.example",
      TOKIMEKI_MASTER_TOKEN: "same-token-value",
      TOKIMEKI_SESSION_TOKEN: "same-token-value",
    });
    expect(config.warnings.some((warning) => warning.includes("identical"))).toBe(true);
    expect(config.warnings.join(" ")).not.toContain("same-token-value");
  });
});
