import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigError } from "./config.js";
import {
  checkSecretFilePermissions,
  readConfigEnvelopeFile,
  resolveConfigEnv,
} from "./config-file.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tokimeki-import-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function writeEnvelope(dir: string, name: string, body: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(body), { mode: 0o600 });
  return path;
}

const posixOnly = process.platform === "win32" ? it.skip : it;

describe("readConfigEnvelopeFile", () => {
  it("parses v1 and v2 envelopes and ignores unknown fields", () => {
    const dir = tempDir();
    const path = writeEnvelope(dir, "v2.json", {
      v: 2,
      relayUrl: "wss://relay.example",
      token: "host-token",
      namespace: "abcde",
      session: "abcde.laptop",
      sessionToken: "session-token",
      passcode: "123456",
      windowSize: "120x40",
      futureField: { ignored: true },
    });
    const result = readConfigEnvelopeFile(path);
    expect(result.env).toMatchObject({
      TOKIMEKI_RELAY_URL: "wss://relay.example",
      TOKIMEKI_TOKEN: "host-token",
      TOKIMEKI_NAMESPACE: "abcde",
      TOKIMEKI_SESSION: "abcde.laptop",
      TOKIMEKI_SESSION_TOKEN: "session-token",
      TOKIMEKI_PASSCODE: "123456",
      TOKIMEKI_WINDOW_SIZE: "120x40",
    });
    expect(JSON.stringify(result)).not.toContain("futureField");
  });

  it("rejects missing, invalid, oversized, and unsupported files", () => {
    const dir = tempDir();
    expect(() => readConfigEnvelopeFile(join(dir, "missing.json"))).toThrow(/not found/);
    const invalid = join(dir, "invalid.json");
    writeFileSync(invalid, "{", { mode: 0o600 });
    expect(() => readConfigEnvelopeFile(invalid)).toThrow(/valid JSON/);
    const unsupported = writeEnvelope(dir, "v9.json", { v: 9 });
    expect(() => readConfigEnvelopeFile(unsupported)).toThrow(/version/);
    const oversized = join(dir, "big.json");
    writeFileSync(oversized, JSON.stringify({ token: "x".repeat(70_000) }), { mode: 0o600 });
    expect(() => readConfigEnvelopeFile(oversized)).toThrow(/larger/);
  });

  posixOnly("requires 0600 for credential-bearing envelope files", () => {
    const dir = tempDir();
    const path = join(dir, "insecure.json");
    writeFileSync(path, JSON.stringify({ token: "host-token" }), { mode: 0o644 });
    expect(() => readConfigEnvelopeFile(path)).toThrow(/0600/);
  });

  it("does not echo secret values in errors", () => {
    const dir = tempDir();
    const path = writeEnvelope(dir, "bad.json", { v: 9, token: "super-secret-value" });
    try {
      readConfigEnvelopeFile(path);
    } catch (error) {
      expect(error instanceof Error ? error.message : "").not.toContain("super-secret-value");
    }
  });

  it("keeps the permission helper semantics", () => {
    expect(checkSecretFilePermissions(0o600, "linux")).toBe("ok");
    expect(checkSecretFilePermissions(0o644, "linux")).toBe("insecure");
    expect(checkSecretFilePermissions(0o644, "win32")).toBe("not-enforced");
  });
});

describe("resolveConfigEnv layered precedence", () => {
  it("orders env > --config file > TOKIMEKI_CONFIG > config.json", () => {
    const homeDir = tempDir();
    const path = writeEnvelope(tempDir(), "layer.json", {
      relayUrl: "wss://file-relay.example",
      token: "file-token",
      namespace: "file-ns",
      session: "file-ns.x",
    });
    const result = resolveConfigEnv(
      {
        TOKIMEKI_RELAY_URL: "wss://env-relay.example",
        TOKIMEKI_TOKEN: "env-token",
        TOKIMEKI_NAMESPACE: "env-ns",
        TOKIMEKI_SESSION: "env-ns.x",
        TOKIMEKI_CONFIG: JSON.stringify({
          relayUrl: "wss://string-relay.example",
          token: "string-token",
        }),
      },
      { homeDir, configFile: { path, source: "flag" } },
    );
    expect(result.env.TOKIMEKI_RELAY_URL).toBe("wss://env-relay.example");
    expect(result.env.TOKIMEKI_TOKEN).toBe("env-token");
    expect(result.env.TOKIMEKI_CONFIG).toBeUndefined();
    expect(result.env.TOKIMEKI_CONFIG_FILE).toBeUndefined();
    expect(result.warnings.some((warning) => warning.includes("TOKIMEKI_CONFIG"))).toBe(true);
  });

  it("uses the --config layer when the environment is silent", () => {
    const homeDir = tempDir();
    const path = writeEnvelope(tempDir(), "layer.json", {
      relayUrl: "wss://file-relay.example",
      token: "file-token",
      namespace: "file-ns",
      session: "file-ns.x",
    });
    const result = resolveConfigEnv(
      {
        TOKIMEKI_CONFIG: JSON.stringify({
          relayUrl: "wss://string-relay.example",
          token: "string-token",
          namespace: "string-ns",
          session: "string-ns.x",
        }),
      },
      { homeDir, configFile: { path, source: "env" } },
    );
    expect(result.env.TOKIMEKI_RELAY_URL).toBe("wss://file-relay.example");
    expect(result.env.TOKIMEKI_TOKEN).toBe("file-token");
    expect(result.env.TOKIMEKI_SESSION).toBe("file-ns.x");
  });

  it("rejects a partial --config file that changes the relay without a credential", () => {
    const homeDir = tempDir();
    const path = writeEnvelope(tempDir(), "partial.json", {
      relayUrl: "wss://other-relay.example",
    });
    expect(() =>
      resolveConfigEnv(
        { TOKIMEKI_TOKEN: "env-token", TOKIMEKI_NAMESPACE: "env-ns" },
        { homeDir, configFile: { path, source: "flag" } },
      ),
    ).toThrow(/without a host credential/);

    // An explicit env relay wins, so the file relay is never effective.
    const safe = resolveConfigEnv(
      {
        TOKIMEKI_RELAY_URL: "wss://env-relay.example",
        TOKIMEKI_TOKEN: "env-token",
        TOKIMEKI_NAMESPACE: "env-ns",
      },
      { homeDir, configFile: { path, source: "flag" } },
    );
    expect(safe.env.TOKIMEKI_RELAY_URL).toBe("wss://env-relay.example");
  });

  it("warns when both --config and TOKIMEKI_CONFIG_FILE are set", () => {
    const homeDir = tempDir();
    const path = writeEnvelope(tempDir(), "flag.json", {
      relayUrl: "wss://flag-relay.example",
      token: "flag-token",
    });
    const result = resolveConfigEnv(
      { TOKIMEKI_CONFIG_FILE: "/ignored/path.json" },
      { homeDir, configFile: { path, source: "flag" } },
    );
    expect(result.env.TOKIMEKI_RELAY_URL).toBe("wss://flag-relay.example");
    expect(result.warnings.some((warning) => warning.includes("--config takes precedence"))).toBe(
      true,
    );
  });

  it("reports a missing --config file as a config error", () => {
    expect(() =>
      resolveConfigEnv(
        { TOKIMEKI_RELAY_URL: "wss://relay.example" },
        { configFile: { path: join(tempDir(), "nope.json"), source: "flag" } },
      ),
    ).toThrow(ConfigError);
  });
});
