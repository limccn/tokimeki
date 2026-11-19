import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigError, loadHostConfig } from "./config.js";
import {
  CONFIG_FILE_MAX_BYTES,
  checkSecretFilePermissions,
  readConfigFile,
  resolveConfigEnv,
} from "./config-file.js";

const tempDirs: string[] = [];

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "tokimeki-config-file-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeConfig(home: string, content: unknown): string {
  const dir = join(home, ".tokimeki");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content), "utf8");
  return path;
}

describe("readConfigFile", () => {
  it("returns an empty result when the file is missing", () => {
    const result = readConfigFile({ homeDir: makeHome() });
    expect(result.info.exists).toBe(false);
    expect(result.env).toEqual({});
  });

  it("loads scalar TOKIMEKI_* keys and ignores unknown keys", () => {
    const home = makeHome();
    writeConfig(home, {
      TOKIMEKI_RELAY_URL: "https://relay.example",
      TOKIMEKI_SESSION: "file-session",
      TOKIMEKI_HEARTBEAT_SECONDS: 42,
      TOKIMEKI_CLAUDE_BG: true,
      unknownKey: "ignored",
      NOT_TOKIMEKI: "ignored",
    });
    const result = readConfigFile({ homeDir: home });
    expect(result.info.exists).toBe(true);
    expect(result.env).toMatchObject({
      TOKIMEKI_RELAY_URL: "https://relay.example",
      TOKIMEKI_SESSION: "file-session",
      TOKIMEKI_HEARTBEAT_SECONDS: "42",
      TOKIMEKI_CLAUDE_BG: "1",
    });
    expect(result.env.unknownKey).toBeUndefined();
    expect(result.env.NOT_TOKIMEKI).toBeUndefined();
  });

  it("rejects invalid JSON, non-objects, and non-scalar values without echoing values", () => {
    const home = makeHome();
    writeConfig(home, "{not json");
    expect(() => readConfigFile({ homeDir: home })).toThrow(/valid JSON/);

    const home2 = makeHome();
    writeConfig(home2, "[1,2,3]");
    expect(() => readConfigFile({ homeDir: home2 })).toThrow(/JSON object/);

    const home3 = makeHome();
    writeConfig(home3, { TOKIMEKI_SESSION: { nested: "leaky-value" } });
    expect(() => readConfigFile({ homeDir: home3 })).toThrow(/TOKIMEKI_SESSION/);
    try {
      readConfigFile({ homeDir: home3 });
    } catch (error) {
      expect((error as Error).message).not.toContain("leaky-value");
    }
  });

  it("rejects directories, FIFO-like entries, and oversized files", () => {
    const home = makeHome();
    mkdirSync(join(home, ".tokimeki", "config.json"), { recursive: true });
    expect(() => readConfigFile({ homeDir: home })).toThrow(/not a regular file/);

    const home2 = makeHome();
    writeConfig(home2, { TOKIMEKI_SESSION: "x".repeat(CONFIG_FILE_MAX_BYTES + 1) });
    expect(() => readConfigFile({ homeDir: home2 })).toThrow(/larger than/);
  });

  it("never creates, writes, or chmods anything", () => {
    const home = makeHome();
    readConfigFile({ homeDir: home });
    expect(existsSync(join(home, ".tokimeki"))).toBe(false);
  });

  it("requires 0600 on POSIX for secret-bearing files", () => {
    const home = makeHome();
    const path = writeConfig(home, { TOKIMEKI_TOKEN: "file-token" });
    chmodSync(path, 0o644);
    if (process.platform === "win32") {
      // Windows cannot represent POSIX modes; the check warns instead.
      const result = readConfigFile({ homeDir: home });
      expect(result.info.warnings.join(" ")).toContain("not enforced on Windows");
    } else {
      expect(() => readConfigFile({ homeDir: home })).toThrow(/must be 0600/);
      chmodSync(path, 0o600);
      expect(readConfigFile({ homeDir: home }).info.exists).toBe(true);
    }
  });

  it("classifies permission modes portably", () => {
    expect(checkSecretFilePermissions(0o600, "linux")).toBe("ok");
    expect(checkSecretFilePermissions(0o644, "linux")).toBe("insecure");
    expect(checkSecretFilePermissions(0o666, "linux")).toBe("insecure");
    expect(checkSecretFilePermissions(0o644, "win32")).toBe("not-enforced");
  });
});

describe("resolveConfigEnv", () => {
  it("merges config.json under explicit environment variables", () => {
    const home = makeHome();
    writeConfig(home, {
      TOKIMEKI_RELAY_URL: "https://file.example",
      TOKIMEKI_SESSION: "file-session",
    });
    const resolved = resolveConfigEnv(
      {
        TOKIMEKI_RELAY_URL: "https://env.example",
        TOKIMEKI_MASTER_TOKEN: "master-token",
      },
      { homeDir: home, enabled: true },
    );
    expect(resolved.env.TOKIMEKI_RELAY_URL).toBe("https://env.example");
    expect(resolved.env.TOKIMEKI_SESSION).toBe("file-session");
    expect(resolved.file.exists).toBe(true);
  });

  it("selects host credentials as a group by source layer", () => {
    const home = makeHome();
    writeConfig(home, {
      TOKIMEKI_TOKEN: "stale-file-token",
      TOKIMEKI_NAMESPACE: "file-namespace",
    });
    const resolved = resolveConfigEnv(
      {
        TOKIMEKI_RELAY_URL: "https://relay.example",
        TOKIMEKI_TOKEN: "explicit-env-token",
      },
      { homeDir: home, enabled: true },
    );
    expect(resolved.env.TOKIMEKI_TOKEN).toBe("explicit-env-token");
    expect(
      resolved.warnings.some((warning) =>
        warning.includes("TOKIMEKI_TOKEN from the config file is ignored"),
      ),
    ).toBe(true);
    // Non-credential keys keep normal per-key precedence.
    expect(resolved.env.TOKIMEKI_NAMESPACE).toBe("file-namespace");
  });

  it("prefers TOKIMEKI_TOKEN over TOKIMEKI_MASTER_TOKEN in the winning layer", () => {
    const home = makeHome();
    writeConfig(home, {
      TOKIMEKI_TOKEN: "file-token",
      TOKIMEKI_MASTER_TOKEN: "file-master",
    });
    const resolved = resolveConfigEnv({}, { homeDir: home, enabled: true });
    expect(resolved.env.TOKIMEKI_TOKEN).toBe("file-token");
    expect(resolved.warnings.some((warning) => warning.includes("takes precedence"))).toBe(true);
  });

  it("expands TOKIMEKI_CONFIG exactly once and removes it from the result", () => {
    const home = makeHome();
    writeConfig(home, { TOKIMEKI_SESSION: "file-session" });
    const resolved = resolveConfigEnv(
      {
        TOKIMEKI_CONFIG: JSON.stringify({ relayUrl: "https://envelope.example" }),
        TOKIMEKI_RELAY_URL: "https://env.example",
      },
      { homeDir: home, enabled: true },
    );
    expect(resolved.env.TOKIMEKI_CONFIG).toBeUndefined();
    expect(resolved.env.TOKIMEKI_RELAY_URL).toBe("https://env.example");
    expect(resolved.env.TOKIMEKI_SESSION).toBe("file-session");
  });

  it("rejects a non-empty retired key from any layer", () => {
    const home = makeHome();
    writeConfig(home, { TOKIMEKI_NAMESPACE_TOKEN: "old-file-token" });
    expect(() => resolveConfigEnv({}, { homeDir: home, enabled: true })).toThrow(/retired/);

    const home2 = makeHome();
    writeConfig(home2, {});
    expect(() =>
      resolveConfigEnv(
        { TOKIMEKI_NAMESPACE_TOKEN: "old-env-token" },
        { homeDir: home2, enabled: true },
      ),
    ).toThrow(/retired/);
    // An empty value is treated as unset.
    expect(
      resolveConfigEnv({ TOKIMEKI_NAMESPACE_TOKEN: "" }, { homeDir: home2, enabled: true })
        .warnings,
    ).toEqual([]);
  });

  it("skips the file entirely when disabled", () => {
    const home = makeHome();
    writeConfig(home, { TOKIMEKI_TOKEN: "file-token" });
    const resolved = resolveConfigEnv({}, { homeDir: home, enabled: false });
    expect(resolved.env.TOKIMEKI_TOKEN).toBeUndefined();
    expect(resolved.file.exists).toBe(false);
  });
});

describe("config file integration", () => {
  it("hosts with a token from the config file", () => {
    const home = makeHome();
    writeConfig(home, {
      TOKIMEKI_RELAY_URL: "https://relay.example",
      TOKIMEKI_TOKEN: "file-host-token",
      TOKIMEKI_NAMESPACE: "team-a",
      TOKIMEKI_SESSION: "team-a.desk",
    });
    const config = loadHostConfig({
      env: resolveConfigEnv({}, { homeDir: home, enabled: true }).env,
    });
    expect(config.authMode).toBe("token");
    expect(config.hostToken).toBe("file-host-token");
  });

  it("does not let a stale file credential shadow an explicit environment credential", () => {
    const home = makeHome();
    writeConfig(home, { TOKIMEKI_TOKEN: "stale-file-token", TOKIMEKI_NAMESPACE: "file-ns" });
    const config = loadHostConfig({
      env: resolveConfigEnv(
        {
          TOKIMEKI_RELAY_URL: "https://relay.example",
          TOKIMEKI_TOKEN: "explicit-env-token",
          TOKIMEKI_NAMESPACE: "env-ns",
          TOKIMEKI_SESSION: "env-ns.desk",
        },
        { homeDir: home, enabled: true },
      ).env,
    });
    expect(config.hostToken).toBe("explicit-env-token");
    expect(config.namespace).toBe("env-ns");
  });

  it("surfaces file errors as ConfigError with the path only", () => {
    const home = makeHome();
    writeConfig(home, "{broken");
    expect(() =>
      loadHostConfig({ env: resolveConfigEnv({}, { homeDir: home, enabled: true }).env }),
    ).toThrow(ConfigError);
  });
});
