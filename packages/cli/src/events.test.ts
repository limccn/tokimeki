import { describe, expect, it } from "vitest";

import {
  CLI_EVENT_PREFIX,
  createCliEventWriter,
  eventConnectionState,
  eventTransport,
  mapRelayErrorCode,
} from "./events.js";

function capture() {
  const lines: string[] = [];
  const writer = createCliEventWriter({
    enabled: true,
    write: (line) => lines.push(line),
    redact: (text) => text.split("secret-token").join("[redacted]"),
    now: () => new Date("2026-11-23T00:00:00.000Z"),
  });
  return { lines, writer };
}

describe("daemon event writer", () => {
  it("emits one prefixed JSON line per event", () => {
    const { lines, writer } = capture();
    writer.ready({
      command: "host",
      role: "host",
      relay: "wss://relay.example",
      session: "ns.session",
    });
    writer.status({ connection: { state: "connected", transport: "relay" } });
    writer.error({ code: "unauthorized", message: "bad token", exitCode: 2 });
    writer.report({ ok: false, checks: [{ name: "relay", status: "fail" }] });

    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(line.startsWith(CLI_EVENT_PREFIX)).toBe(true);
      const parsed = JSON.parse(line.slice(CLI_EVENT_PREFIX.length)) as Record<string, unknown>;
      expect(parsed.v).toBe(1);
      expect(parsed.at).toBe("2026-11-23T00:00:00.000Z");
    }
    expect(JSON.parse(lines[0]?.slice(CLI_EVENT_PREFIX.length) ?? "{}").type).toBe("ready");
  });

  it("never emits while disabled", () => {
    const lines: string[] = [];
    const writer = createCliEventWriter({ enabled: false, write: (line) => lines.push(line) });
    writer.error({ code: "unknown", message: "x" });
    expect(lines).toEqual([]);
  });

  it("redacts secrets and escapes newline injection into one line", () => {
    const { lines, writer } = capture();
    writer.error({ code: "unknown", message: "secret-token\nforge: {}\rnext" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("secret-token");
    expect(lines[0]).toContain("[redacted]");
    const raw = lines[0]?.slice(CLI_EVENT_PREFIX.length) ?? "";
    expect(raw).toContain("\\n");
    expect(raw).not.toContain("\n");
    const parsed = JSON.parse(raw) as { message: string };
    expect(parsed.message).toBe("[redacted]\nforge: {}\rnext");
    expect(lines[0]?.split("\n")).toHaveLength(1);
  });
});

describe("event vocabulary mapping", () => {
  it("maps transport and connection labels", () => {
    expect(eventTransport("p2p-direct")).toBe("p2p");
    expect(eventTransport("p2p-turn")).toBe("turn");
    expect(eventTransport("tunnel")).toBe("tunnel");
    expect(eventTransport("unknown")).toBeUndefined();
    expect(eventConnectionState("ready")).toBe("connected");
    expect(eventConnectionState("closed")).toBe("disconnected");
    expect(eventConnectionState("connecting")).toBe("connecting");
  });

  it("maps relay error codes to stable daemon codes", () => {
    expect(mapRelayErrorCode("unauthorized")).toBe("unauthorized");
    expect(mapRelayErrorCode("invalid_session")).toBe("session_not_found");
    expect(mapRelayErrorCode("passcode_invalid")).toBe("passcode_required");
    expect(mapRelayErrorCode("session_full")).toBe("rate_limited");
    expect(mapRelayErrorCode("jwks_unavailable")).toBe("unavailable");
    expect(mapRelayErrorCode("weird")).toBe("unknown");
  });
});
