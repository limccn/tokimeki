import { describe, expect, it } from "vitest";

import {
  deriveNamespaceFromSessionId,
  isNamespaceSessionId,
  MAX_NAMESPACE_TOKENS,
  MIN_NAMESPACE_TOKEN_BYTES,
  matchNamespaceToken,
  parseNamespaceTokens,
} from "../src/namespace-tokens.js";

const MASTER = "test-master-token-abc";
const TOKEN_A = "test-namespace-token-team-a-0123456789";
const TOKEN_B = "test-namespace-token-team-b-0123456789";

function raw(entries: Record<string, unknown>): string {
  return JSON.stringify(entries);
}

describe("parseNamespaceTokens", () => {
  it("disables namespace auth when the secret is absent or blank", () => {
    expect(parseNamespaceTokens(undefined, MASTER)).toEqual({ entries: [] });
    expect(parseNamespaceTokens("", MASTER)).toEqual({ entries: [] });
    expect(parseNamespaceTokens("   ", MASTER)).toEqual({ entries: [] });
  });

  it("parses valid namespace tokens", () => {
    const config = parseNamespaceTokens(raw({ "team-a": TOKEN_A, "team-b": TOKEN_B }), MASTER);
    expect(config.error).toBeUndefined();
    expect(config.entries).toEqual([
      { namespace: "team-a", token: TOKEN_A },
      { namespace: "team-b", token: TOKEN_B },
    ]);
  });

  it("fails closed on invalid JSON and non-object values", () => {
    expect(parseNamespaceTokens("not-json", MASTER).error).toBe("invalid_json");
    expect(parseNamespaceTokens("[]", MASTER).error).toBe("invalid_json");
    expect(parseNamespaceTokens("null", MASTER).error).toBe("invalid_json");
    expect(parseNamespaceTokens('"token"', MASTER).error).toBe("invalid_json");
    expect(parseNamespaceTokens("not-json", MASTER).entries).toEqual([]);
  });

  it("rejects invalid namespace keys", () => {
    for (const namespace of ["Team-A", "team a", "-team", "", "a".repeat(33), "téam"]) {
      const config = parseNamespaceTokens(raw({ [namespace]: TOKEN_A }), MASTER);
      expect(config.error).toBe("invalid_namespace");
      expect(config.entries).toEqual([]);
    }
  });

  it("rejects non-string, empty, and short tokens", () => {
    expect(parseNamespaceTokens(raw({ "team-a": 12345 }), MASTER).error).toBe("invalid_token");
    expect(parseNamespaceTokens(raw({ "team-a": "" }), MASTER).error).toBe("invalid_token");
    expect(
      parseNamespaceTokens(raw({ "team-a": "x".repeat(MIN_NAMESPACE_TOKEN_BYTES - 1) }), MASTER)
        .error,
    ).toBe("token_too_short");
  });

  it("rejects duplicate tokens and a token equal to the root master", () => {
    expect(parseNamespaceTokens(raw({ "team-a": TOKEN_A, "team-b": TOKEN_A }), MASTER).error).toBe(
      "duplicate_token",
    );
    // The master token must itself be long enough to be a namespace token, so
    // the equality rule (not the length rule) is what rejects it.
    const longMaster = "m".repeat(MIN_NAMESPACE_TOKEN_BYTES);
    expect(parseNamespaceTokens(raw({ "team-a": longMaster }), longMaster).error).toBe(
      "equals_master",
    );
    expect(parseNamespaceTokens(raw({ "team-a": longMaster }), undefined).error).toBeUndefined();
  });

  it("rejects too many entries and oversized raw JSON", () => {
    const tooMany: Record<string, string> = {};
    for (let index = 0; index <= MAX_NAMESPACE_TOKENS; index += 1) {
      tooMany[`team-${index}`] = `${TOKEN_A}-${index}`;
    }
    expect(parseNamespaceTokens(raw(tooMany), MASTER).error).toBe("too_many_entries");
    expect(
      parseNamespaceTokens(JSON.stringify({ "team-a": "x".repeat(20 * 1024) }), MASTER).error,
    ).toBe("too_large");
  });
});

describe("matchNamespaceToken", () => {
  it("resolves the namespace for a matching token", async () => {
    const { entries } = parseNamespaceTokens(raw({ "team-a": TOKEN_A, "team-b": TOKEN_B }), MASTER);
    expect(await matchNamespaceToken(TOKEN_A, entries)).toBe("team-a");
    expect(await matchNamespaceToken(TOKEN_B, entries)).toBe("team-b");
  });

  it("returns null for unknown, empty, and disabled configurations", async () => {
    const { entries } = parseNamespaceTokens(raw({ "team-a": TOKEN_A }), MASTER);
    expect(await matchNamespaceToken("wrong-token", entries)).toBeNull();
    expect(await matchNamespaceToken("", entries)).toBeNull();
    expect(await matchNamespaceToken(TOKEN_A, [])).toBeNull();
  });
});

describe("namespace session ids", () => {
  it("requires an exact <namespace>.<slug> prefix", () => {
    expect(isNamespaceSessionId("team-a.desk", "team-a")).toBe(true);
    expect(isNamespaceSessionId("team-a.desk.nested", "team-a")).toBe(true);
    expect(isNamespaceSessionId("team-a.", "team-a")).toBe(false);
    expect(isNamespaceSessionId("team-a", "team-a")).toBe(false);
    expect(isNamespaceSessionId("team-ab.desk", "team-a")).toBe(false);
    expect(isNamespaceSessionId("other-team-a.desk", "team-a")).toBe(false);
  });

  it("derives the namespace before the first dot", () => {
    expect(deriveNamespaceFromSessionId("team-a.desk")).toBe("team-a");
    expect(deriveNamespaceFromSessionId("team-a.desk.nested")).toBe("team-a");
    expect(deriveNamespaceFromSessionId("plain-session")).toBeNull();
    expect(deriveNamespaceFromSessionId(".desk")).toBeNull();
    expect(deriveNamespaceFromSessionId("team-a.")).toBeNull();
    expect(deriveNamespaceFromSessionId("Team.A")).toBeNull();
  });
});
