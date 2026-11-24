import { describe, expect, it } from "vitest";

import { configurationSummary, runDoctorGate } from "./doctor-gate.js";

const completeHost = {
  TOKIMEKI_RELAY_URL: "wss://relay.example",
  TOKIMEKI_TOKEN: "host-token-value",
  TOKIMEKI_NAMESPACE: "abcde",
  TOKIMEKI_SESSION: "abcde.laptop",
  TOKIMEKI_SESSION_TOKEN: "session-token-value",
};

describe("doctor gate", () => {
  it("accepts a complete host configuration", () => {
    expect(runDoctorGate({ command: "host", env: completeHost, mode: "daemon" })).toEqual({
      ok: true,
      issues: [],
    });
  });

  it("accepts the deprecated master alias", () => {
    const result = runDoctorGate({
      command: "host",
      env: {
        TOKIMEKI_RELAY_URL: "wss://relay.example",
        TOKIMEKI_MASTER_TOKEN: "master-token-value",
        TOKIMEKI_SESSION: "sess",
      },
      mode: "daemon",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects malformed master tokens", () => {
    const result = runDoctorGate({
      command: "host",
      env: {
        TOKIMEKI_RELAY_URL: "wss://relay.example",
        TOKIMEKI_MASTER_TOKEN: "bad token value",
      },
      mode: "daemon",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes("TOKIMEKI_MASTER_TOKEN"))).toBe(
      true,
    );
  });

  it("reports missing/paired credentials without printing values", () => {
    const result = runDoctorGate({
      command: "host",
      env: { TOKIMEKI_RELAY_URL: "wss://relay.example", TOKIMEKI_NAMESPACE: "abcde" },
      mode: "daemon",
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("config_invalid");
    expect(result.issues.some((issue) => /TOKIMEKI_TOKEN/.test(issue.message))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("abcde");
  });

  it("rejects namespace-less tokens and mismatched sessions", () => {
    const missingNamespace = runDoctorGate({
      command: "host",
      env: { ...completeHost, TOKIMEKI_NAMESPACE: "" },
      mode: "daemon",
    });
    expect(missingNamespace.ok).toBe(false);
    expect(
      missingNamespace.issues.some((issue) => issue.message.includes("TOKIMEKI_NAMESPACE")),
    ).toBe(true);

    const wrongPrefix = runDoctorGate({
      command: "host",
      env: { ...completeHost, TOKIMEKI_SESSION: "other.laptop" },
      mode: "daemon",
    });
    expect(wrongPrefix.ok).toBe(false);
    expect(wrongPrefix.issues.some((issue) => issue.message.includes('"abcde."'))).toBe(true);
  });

  it("reports attach problems in a stable order", () => {
    const result = runDoctorGate({ command: "attach", env: {}, mode: "daemon" });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toContain("TOKIMEKI_SESSION");
  });

  it("rejects a retired namespace token", () => {
    const result = runDoctorGate({
      command: "host",
      env: { ...completeHost, TOKIMEKI_NAMESPACE_TOKEN: "old" },
      mode: "daemon",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes("retired"))).toBe(true);
  });

  it("summarizes configuration without values", () => {
    const summary = configurationSummary(completeHost);
    expect(summary.configured).toBe(true);
    expect(summary.relay).toBe("wss://relay.example");
    expect(summary.namespace).toBe("abcde");
    expect(summary.session).toBe("abcde.laptop");
  });
});
