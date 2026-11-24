import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigError } from "./config.js";
import {
  addHistoryEntry,
  clearHistory,
  looksLikeJwt,
  readHistory,
  readUserConfigRaw,
  removeHistoryEntry,
  writeUserConfig,
} from "./persist.js";

const dirs: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "tokimeki-persist-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const posixOnly = process.platform === "win32" ? it.skip : it;

describe("config writer", () => {
  it("writes only whitelist keys and preserves unknown keys", () => {
    const homeDir = tempHome();
    const path = join(homeDir, ".tokimeki", "config.json");
    writeUserConfig(
      {
        relayUrl: "wss://relay.example",
        namespace: "abcde",
        token: "host-token-1234",
        session: "abcde.laptop",
        sessionToken: "session-token-1234",
      },
      { homeDir },
    );
    const parsed = readUserConfigRaw({ homeDir }) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      TOKIMEKI_RELAY_URL: "wss://relay.example",
      TOKIMEKI_NAMESPACE: "abcde",
      TOKIMEKI_TOKEN: "host-token-1234",
      TOKIMEKI_SESSION: "abcde.laptop",
      TOKIMEKI_SESSION_TOKEN: "session-token-1234",
    });

    const existing = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    existing.CUSTOM_KEY = "keep-me";
    writeFileSync(path, JSON.stringify(existing));
    writeUserConfig({ relayUrl: "wss://relay2.example" }, { homeDir });
    const merged = readUserConfigRaw({ homeDir }) as Record<string, unknown>;
    expect(merged.CUSTOM_KEY).toBe("keep-me");
    expect(merged.TOKIMEKI_RELAY_URL).toBe("wss://relay2.example");
    // A relay change must not carry the previous relay's credentials/session.
    expect(merged.TOKIMEKI_TOKEN).toBeUndefined();
    expect(merged.TOKIMEKI_NAMESPACE).toBeUndefined();
    expect(merged.TOKIMEKI_SESSION).toBeUndefined();
    expect(merged.TOKIMEKI_SESSION_TOKEN).toBeUndefined();
  });

  it("keeps credentials supplied in the same relay-changing save", () => {
    const homeDir = tempHome();
    writeUserConfig(
      {
        relayUrl: "wss://relay.example",
        namespace: "abcde",
        token: "host-token-1234",
        session: "abcde.laptop",
        sessionToken: "session-token-1234",
      },
      { homeDir },
    );
    writeUserConfig(
      {
        relayUrl: "wss://relay2.example",
        namespace: "fghij",
        token: "host-token-5678",
        session: "fghij.desktop",
        sessionToken: "session-token-5678",
      },
      { homeDir },
    );
    const merged = readUserConfigRaw({ homeDir }) as Record<string, unknown>;
    expect(merged).toMatchObject({
      TOKIMEKI_RELAY_URL: "wss://relay2.example",
      TOKIMEKI_NAMESPACE: "fghij",
      TOKIMEKI_TOKEN: "host-token-5678",
      TOKIMEKI_SESSION: "fghij.desktop",
      TOKIMEKI_SESSION_TOKEN: "session-token-5678",
    });
  });

  posixOnly("creates a 0600 file under a 0700 directory", () => {
    const homeDir = tempHome();
    writeUserConfig({ token: "host-token-1234" }, { homeDir });
    const file = join(homeDir, ".tokimeki", "config.json");
    expect(statSync(file).mode & 0o077).toBe(0);
    expect(statSync(join(homeDir, ".tokimeki")).isDirectory()).toBe(true);
  });

  it("rejects a JWT-shaped session token by default", () => {
    const homeDir = tempHome();
    const jwt = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.signature";
    expect(looksLikeJwt(jwt)).toBe(true);
    expect(() => writeUserConfig({ sessionToken: jwt }, { homeDir })).toThrow(ConfigError);
    expect(() =>
      writeUserConfig({ sessionToken: jwt }, { homeDir, allowJwtSessionToken: true }),
    ).not.toThrow();
  });

  posixOnly("refuses to write over an insecure existing config", () => {
    const homeDir = tempHome();
    const dir = join(homeDir, ".tokimeki");
    const path = join(dir, "config.json");
    // Create the directory/file with group/other read bits.
    writeUserConfig({ token: "existing-token" }, { homeDir });
    chmodSync(path, 0o644);
    expect(() => writeUserConfig({ relayUrl: "wss://relay.example" }, { homeDir })).toThrow(/0600/);
  });

  posixOnly("refuses to follow a symlinked config path", () => {
    const homeDir = tempHome();
    const real = join(homeDir, "real.json");
    writeFileSync(real, "{}");
    writeUserConfig({ token: "host-token-1234" }, { homeDir });
    const path = join(homeDir, ".tokimeki", "config.json");
    rmSync(path);
    symlinkSync(real, path);
    expect(() => writeUserConfig({ relayUrl: "wss://relay.example" }, { homeDir })).toThrow(
      /symbolic link/,
    );
  });
});

describe("connection history", () => {
  it("dedupes by relay+session and caps at 20 entries", () => {
    const homeDir = tempHome();
    for (let index = 0; index < 25; index += 1) {
      addHistoryEntry(
        {
          relayUrl: "wss://relay.example",
          session: `ns.session-${index}`,
          lastUsedAt: 1_000 + index,
        },
        { homeDir },
      );
    }
    const history = readHistory({ homeDir });
    expect(history.entries).toHaveLength(20);
    expect(history.entries[0]?.session).toBe("ns.session-24");
    expect(history.entries[19]?.session).toBe("ns.session-5");

    addHistoryEntry(
      {
        relayUrl: "wss://relay.example",
        session: "ns.session-24",
        lastUsedAt: 9_999,
      },
      { homeDir },
    );
    const updated = readHistory({ homeDir });
    expect(updated.entries).toHaveLength(20);
    expect(updated.entries[0]).toMatchObject({
      session: "ns.session-24",
      lastUsedAt: 9_999,
    });
  });

  it("removes and clears entries", () => {
    const homeDir = tempHome();
    addHistoryEntry({ relayUrl: "wss://r.example", session: "a.one" }, { homeDir });
    addHistoryEntry({ relayUrl: "wss://r.example", session: "a.two" }, { homeDir });
    removeHistoryEntry("a.one", { homeDir });
    expect(readHistory({ homeDir }).entries.map((entry) => entry.session)).toEqual(["a.two"]);
    clearHistory({ homeDir });
    expect(readHistory({ homeDir }).entries).toEqual([]);
  });

  it("never persists a hosted Session JWT", () => {
    const homeDir = tempHome();
    expect(() =>
      addHistoryEntry(
        {
          relayUrl: "wss://r.example",
          session: "a.one",
          sessionToken: "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.signature",
        },
        { homeDir },
      ),
    ).toThrow(ConfigError);
  });

  it("does not leak token values in history errors", () => {
    const homeDir = tempHome();
    try {
      addHistoryEntry(
        {
          relayUrl: "wss://r.example",
          session: "a.one",
          sessionToken: "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.signature",
        },
        { homeDir },
      );
    } catch (error) {
      expect(error instanceof Error ? error.message : "").not.toContain("eyJ");
    }
  });
});
