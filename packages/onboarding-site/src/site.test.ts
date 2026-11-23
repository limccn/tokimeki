import { describe, expect, it } from "vitest";

import { ACP_CATALOG } from "./lib/acp.js";
import {
  acpInvocation,
  generateAttachCommand,
  generateHostCommand,
  SHELLS,
  shellEnvLine,
} from "./lib/commands.js";
import { buildHostConfigEnvelope, buildViewerConfigJson, parseWindowSize } from "./lib/config.js";
import { isSecureEntry, relayUrlForLocation } from "./lib/relay.js";
import { randomSlug, randomToken } from "./lib/token.js";
import {
  SiteError,
  validateCustomCommand,
  validateNamespace,
  validateRelayUrl,
  validateSession,
  validateToken,
} from "./lib/validate.js";

const hostInput = {
  relayUrl: "wss://relay.example",
  token: "host-token-0123456789abcdef0123456789abcdef",
  namespace: "abcde",
  session: "abcde.laptop",
  sessionToken: "session-token-0123456789abcdef0123456789",
  acpId: "codex",
  shell: "bash" as const,
  windowSize: "120x40",
};

describe("onboarding-site validation", () => {
  it("accepts valid namespaces and namespaced sessions", () => {
    expect(() => validateNamespace("abcde")).not.toThrow();
    expect(() => validateSession("abcde.laptop", "abcde")).not.toThrow();
    expect(() => validateSession("other.laptop", "abcde")).toThrow(SiteError);
    expect(() => validateSession("abcde.", "abcde")).toThrow(SiteError);
  });

  it("requires long, whitespace-free, shell-safe tokens", () => {
    expect(() => validateToken("a".repeat(32), "Token")).not.toThrow();
    expect(() => validateToken("short", "Token")).toThrow(/at least 32/);
    expect(() => validateToken(`${"a".repeat(31)} `, "Token")).toThrow(/whitespace/);
    expect(() => validateToken(`${"a".repeat(31)}'`, "Token")).toThrow(/unsafe/);
  });

  it("accepts wss and loopback ws only", () => {
    expect(() => validateRelayUrl("wss://relay.example")).not.toThrow();
    expect(() => validateRelayUrl("ws://127.0.0.1:8787")).not.toThrow();
    expect(() => validateRelayUrl("ws://relay.example")).toThrow(/wss/);
    expect(() => validateRelayUrl("https://relay.example")).toThrow(/wss/);
    expect(() => validateRelayUrl("wss://relay.example/path")).toThrow(/path/);
  });

  it("rejects custom commands with shell characters", () => {
    expect(() => validateCustomCommand("my-tui")).not.toThrow();
    expect(() => validateCustomCommand("my-tui; rm -rf /")).toThrow(/no shell characters/);
    expect(() => validateCustomCommand("../../bin/sh")).toThrow(/no shell characters/);
  });

  it("derives the relay from the page origin", () => {
    expect(
      relayUrlForLocation({ protocol: "https:", host: "relay.example", hostname: "relay.example" }),
    ).toBe("wss://relay.example");
    expect(
      relayUrlForLocation({ protocol: "http:", host: "127.0.0.1:8787", hostname: "127.0.0.1" }),
    ).toBe("ws://127.0.0.1:8787");
    expect(() =>
      relayUrlForLocation({ protocol: "http:", host: "relay.example", hostname: "relay.example" }),
    ).toThrow(/HTTPS/);
    expect(
      isSecureEntry({ protocol: "http:", host: "localhost:8787", hostname: "localhost" }, false),
    ).toBe(true);
    expect(
      isSecureEntry({ protocol: "http:", host: "relay.example", hostname: "relay.example" }, false),
    ).toBe(false);
  });
});

describe("onboarding-site command generation", () => {
  it("contains the nine ACP applications", () => {
    expect(ACP_CATALOG).toHaveLength(9);
    expect(ACP_CATALOG.map((entry) => entry.command)).toContain("amp");
  });

  it("generates host commands for every shell", () => {
    for (const shell of SHELLS) {
      const command = generateHostCommand({ ...hostInput, shell });
      expect(command).toContain("TOKIMEKI_RELAY_URL");
      expect(command).toContain("TOKIMEKI_TOKEN");
      expect(command).toContain("TOKIMEKI_WINDOW_SIZE");
      expect(command).toContain("tokimeki run -- codex");
    }
    expect(shellEnvLine("bash", "K", "v")).toBe("export K='v'");
    expect(shellEnvLine("fish", "K", "v")).toBe("set -gx K 'v'");
    expect(shellEnvLine("pwsh", "K", "v")).toBe("$env:K = 'v'");
    expect(shellEnvLine("cmd", "K", "v")).toBe('set "K=v"');
  });

  it("uses first-class claude/pi commands and run -- for other ACPs", () => {
    expect(acpInvocation("claude")).toBe("tokimeki claude");
    expect(acpInvocation("pi")).toBe("tokimeki pi");
    expect(acpInvocation("amp")).toBe("tokimeki run -- amp");
    expect(acpInvocation("custom", "my-tui")).toBe("tokimeki run -- my-tui");
    expect(() => acpInvocation("unknown")).toThrow(SiteError);
  });

  it("generates attach commands with listener variants", () => {
    const viewer = generateAttachCommand({
      relayUrl: "wss://relay.example",
      session: "abcde.laptop",
      sessionToken: "session-token-0123456789abcdef01234567",
      shell: "bash",
      listener: false,
    });
    expect(viewer).toContain("tokimeki attach");
    expect(viewer).not.toContain("--listen");
    const listener = generateAttachCommand({
      relayUrl: "wss://relay.example",
      session: "abcde.laptop",
      sessionToken: "session-token-0123456789abcdef01234567",
      shell: "bash",
      listener: true,
    });
    expect(listener).toContain("tokimeki attach --listen");
  });

  it("builds a v1 host config and viewer JSON without JWT/passcode fields", () => {
    const envelope = buildHostConfigEnvelope(hostInput);
    const parsed = JSON.parse(envelope) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      v: 1,
      relayUrl: "wss://relay.example",
      token: hostInput.token,
      namespace: "abcde",
      session: "abcde.laptop",
      sessionToken: hostInput.sessionToken,
      windowSize: "120x40",
    });
    expect(envelope).not.toMatch(/passcode|inviteUrl|expiresAt|jwt/i);

    const viewer = buildViewerConfigJson({
      relayUrl: "wss://relay.example",
      session: "abcde.laptop",
      sessionToken: hostInput.sessionToken,
      windowSize: "120x40",
    });
    expect(JSON.parse(viewer)).toEqual({
      version: 1,
      relayUrl: "wss://relay.example",
      session: "abcde.laptop",
      sessionToken: hostInput.sessionToken,
      window: { cols: 120, rows: 40 },
    });
    expect(parseWindowSize("bogus")).toBeUndefined();
  });
});

describe("onboarding-site token generation", () => {
  it("generates high-entropy base64url tokens and slugs", () => {
    const token = randomToken();
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toMatch(/^\d+$/);
    expect(randomToken()).not.toBe(token);

    const slug = randomSlug();
    expect(slug).toMatch(/^[a-z0-9]{1,8}$/);
  });
});
