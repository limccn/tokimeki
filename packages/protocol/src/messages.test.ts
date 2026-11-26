import { describe, expect, it } from "vitest";

import {
  ALL_ROLES,
  ERROR_CODES,
  isActiveRole,
  isReservedRole,
  MAX_CONTROL_MESSAGE_BYTES,
  MAX_SIGNAL_PAYLOAD_BYTES,
  MAX_TERMINAL_DIMENSION,
  PROTOCOL_VERSION,
  RESERVED_ROLES,
  ROLES,
} from "./constants.js";
import { CLIENT_ID_PATTERN, isValidClientId, isValidSessionId, SESSION_ID_PATTERN } from "./ids.js";
import {
  AckMessageSchema,
  AGENT_MESSAGE_TYPE_PATTERN,
  AgentMessageSchema,
  ControlMessageSchema,
  createNotImplementedErrorMessage,
  encodeControlMessage,
  type HelloMessage,
  HelloMessageSchema,
  isAgentMessage,
  KNOWN_CONTROL_MESSAGE_TYPES,
  ProtocolMessageError,
  type ProtocolMessageErrorCode,
  parseControlMessage,
  safeParseControlMessage,
  WelcomeMessageSchema,
} from "./messages.js";
import { toU64String, u64StringToNumber, zU64String } from "./u64.js";

const minimalHello = {
  v: 1,
  type: "hello",
  role: "viewer",
  session: "demo-session",
  clientId: "viewer-1",
} as const;

function expectMessageError(input: unknown, code: ProtocolMessageErrorCode): void {
  try {
    parseControlMessage(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolMessageError);
    expect((error as ProtocolMessageError).code).toBe(code);
    return;
  }
  throw new Error(`expected ProtocolMessageError(${code})`);
}

describe("identifiers", () => {
  it("accepts and rejects the documented ID grammar", () => {
    for (const id of ["a", "A", "0", "host-1", "a.b_c-d", "a".repeat(64)]) {
      expect(isValidSessionId(id)).toBe(true);
      expect(isValidClientId(id)).toBe(true);
    }
    for (const id of ["", "-a", ".a", "_a", "a b", "a/b", "a".repeat(65), "é", "a\n"]) {
      expect(isValidSessionId(id)).toBe(false);
      expect(isValidClientId(id)).toBe(false);
    }
    expect(SESSION_ID_PATTERN.source).toBe(CLIENT_ID_PATTERN.source);
    expect(SESSION_ID_PATTERN.source).toBe("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
  });
});

describe("u64 handling", () => {
  it("roundtrips safe integers through canonical decimal strings", () => {
    expect(toU64String(0)).toBe("0");
    expect(toU64String(42)).toBe("42");
    expect(toU64String(Number.MAX_SAFE_INTEGER)).toBe("9007199254740991");
    expect(u64StringToNumber("42")).toBe(42);
    expect(u64StringToNumber("0")).toBe(0);
    expect(u64StringToNumber("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects non-canonical, negative, fractional, and unsafe values", () => {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => toU64String(value)).toThrow(RangeError);
    }
    for (const value of ["", "01", "00", "-1", "1.5", "1e3", " 1", "9007199254740992"]) {
      expect(() => u64StringToNumber(value)).toThrow(RangeError);
    }
  });

  it("normalizes JSON u64 fields to decimal strings", () => {
    expect(zU64String.parse("42")).toBe("42");
    expect(zU64String.parse(42)).toBe("42");
    expect(zU64String.parse(0)).toBe("0");
    for (const value of ["042", "-1", "1.5", "9007199254740992", -1, 1.5, 2 ** 53]) {
      expect(zU64String.safeParse(value).success).toBe(false);
    }
  });
});

describe("hello and welcome", () => {
  it("applies hello defaults and preserves unknown fields and capabilities", () => {
    const parsed = parseControlMessage({
      ...minimalHello,
      futureTopLevel: { nested: [1, null, "x"] },
      capabilities: {
        "x-future": { anything: [1, 2] },
        transports: { modes: ["p2p-direct", "relay"] },
        snapshot: { formats: ["xterm-serialize"], maxBytes: 262_144 },
        tunnel: {
          version: 2,
          arq: "future-arq",
          fec: ["xor", "future-fec"],
          crypto: "future-aead",
          keyMode: "shared-secret",
          maxFrameSize: 9000,
        },
        listener: { modes: ["snapshot-only"] },
        peerRelay: { version: 1, roles: ["viewer"] },
      },
    });

    expect(parsed.type).toBe("hello");
    if (parsed.type !== "hello") {
      throw new Error("expected hello");
    }
    expect(parsed.protocolVersion).toBe(1);
    expect(parsed.capabilities).toMatchObject({
      transports: { modes: ["p2p-direct", "relay"] },
      tunnel: { arq: "future-arq", keyMode: "shared-secret" },
    });

    const encoded = JSON.parse(encodeControlMessage(parsed)) as Record<string, unknown>;
    expect(encoded.futureTopLevel).toEqual({ nested: [1, null, "x"] });
    expect(encoded.capabilities).toMatchObject({
      "x-future": { anything: [1, 2] },
      listener: { modes: ["snapshot-only"] },
    });
  });

  it("accepts listener as an active role", () => {
    const parsed = parseControlMessage({ ...minimalHello, role: "listener" });
    expect(parsed.type).toBe("hello");
    const { role } = HelloMessageSchema.parse({ ...minimalHello, role: "listener" });
    expect(role).toBe("listener");
    expect(isActiveRole(role)).toBe(true);
    expect(isReservedRole(role)).toBe(false);
    expect(ROLES).toEqual(["host", "viewer", "observer", "agent", "listener"]);
    expect(RESERVED_ROLES).toEqual([]);
    expect(ALL_ROLES).toContain("listener");
  });

  it("roundtrips the optional peer-joined role", () => {
    const joined = parseControlMessage({
      v: 1,
      type: "peer-joined",
      clientId: "listener-1",
      role: "listener",
      capabilities: { listener: { modes: ["snapshot-only"] } },
    });
    expect(joined.type).toBe("peer-joined");
    if (joined.type !== "peer-joined") throw new Error("expected peer-joined");
    expect(joined.role).toBe("listener");

    const legacy = parseControlMessage({
      v: 1,
      type: "peer-joined",
      clientId: "viewer-1",
    });
    if (legacy.type !== "peer-joined") throw new Error("expected peer-joined");
    expect(legacy.role).toBeUndefined();
  });

  it("roundtrips the minimum fields through the schema and encoder", () => {
    const parsed = HelloMessageSchema.parse(minimalHello);
    expect(parsed.protocolVersion).toBe(1);
    expect(parsed.capabilities).toEqual({});

    const encoded = encodeControlMessage(minimalHello);
    expect(JSON.parse(encoded)).toEqual({
      v: 1,
      type: "hello",
      role: "viewer",
      session: "demo-session",
      clientId: "viewer-1",
      protocolVersion: 1,
      capabilities: {},
    });
  });

  it("rejects invalid roles, IDs, and terminal dimensions", () => {
    expect(() => HelloMessageSchema.parse({ ...minimalHello, role: "admin" })).toThrow();
    expect(() => HelloMessageSchema.parse({ ...minimalHello, session: "-bad" })).toThrow();
    expect(() => HelloMessageSchema.parse({ ...minimalHello, clientId: "a".repeat(65) })).toThrow();
    expect(() => HelloMessageSchema.parse({ ...minimalHello, cols: 0, rows: 40 })).toThrow();
    expect(() =>
      HelloMessageSchema.parse({
        ...minimalHello,
        cols: MAX_TERMINAL_DIMENSION + 1,
        rows: 40,
      }),
    ).toThrow();
    expect(() => HelloMessageSchema.parse({ ...minimalHello, cols: 1.5 })).toThrow();
  });

  it("roundtrips client identity and display capabilities", () => {
    const parsed = parseControlMessage({
      ...minimalHello,
      client: {
        name: "tokimeki-cli",
        version: "0.1.2",
        kind: "cli",
        platform: "win32",
        runtime: "node/22.12.0",
        futureField: "kept",
      },
      capabilities: {
        display: {
          modes: ["viewport", "future-mode"],
          fixed: { cols: 120, rows: 40 },
          logPanel: true,
          terminalQueries: "host",
          resize: 1,
          futureField: 1,
        },
      },
    });
    expect(parsed.type).toBe("hello");
    if (parsed.type !== "hello") throw new Error("expected hello");
    expect(parsed.client).toMatchObject({
      name: "tokimeki-cli",
      version: "0.1.2",
      kind: "cli",
    });
    const hello = parsed as HelloMessage;
    expect(hello.capabilities.display).toMatchObject({
      modes: ["viewport", "future-mode"],
      fixed: { cols: 120, rows: 40 },
      logPanel: true,
      terminalQueries: "host",
      resize: 1,
    });

    const encoded = JSON.parse(encodeControlMessage(parsed)) as Record<string, unknown>;
    expect(encoded.client).toMatchObject({ name: "tokimeki-cli", futureField: "kept" });
    expect(encoded.capabilities).toMatchObject({
      display: { fixed: { cols: 120, rows: 40 }, futureField: 1 },
    });
  });

  it("validates client identity and fixed display size", () => {
    expect(() =>
      HelloMessageSchema.parse({
        ...minimalHello,
        client: { name: "tokimeki-cli" },
      }),
    ).toThrow();
    expect(() =>
      HelloMessageSchema.parse({
        ...minimalHello,
        client: { name: "", version: "0.1.2" },
      }),
    ).toThrow();
    expect(() =>
      HelloMessageSchema.parse({
        ...minimalHello,
        capabilities: { display: { fixed: { cols: 0, rows: 40 } } },
      }),
    ).toThrow();
    expect(() =>
      HelloMessageSchema.parse({
        ...minimalHello,
        capabilities: { display: { fixed: { cols: 5000, rows: 5000 } } },
      }),
    ).toThrow();
  });

  it("carries client identity and capabilities in welcome clients", () => {
    const parsed = WelcomeMessageSchema.parse({
      v: 1,
      type: "welcome",
      session: "demo-session",
      hostOnline: true,
      iceProvider: "stun",
      sessionTtlSeconds: 60,
      clients: [
        {
          clientId: "host-1",
          role: "host",
          client: { name: "tokimeki-cli", version: "0.1.2", kind: "cli" },
          capabilities: {
            display: {
              modes: ["fixed-grid", "viewport"],
              fixed: { cols: 120, rows: 40 },
              logPanel: true,
              terminalQueries: "host",
            },
          },
        },
      ],
    });
    expect(parsed.clients[0]?.client?.name).toBe("tokimeki-cli");
    expect(parsed.clients[0]?.capabilities?.display?.fixed).toEqual({ cols: 120, rows: 40 });
  });

  it("applies welcome defaults and validates providers", () => {
    const parsed = WelcomeMessageSchema.parse({
      v: 1,
      type: "welcome",
      session: "demo-session",
      hostOnline: true,
      iceProvider: "stun",
      sessionTtlSeconds: 60,
    });
    expect(parsed.protocolVersion).toBe(1);
    expect(parsed.clients).toEqual([]);
    expect(parsed.iceServers).toEqual([]);
    expect(parsed.transportPolicy).toBe("all");

    expect(() =>
      WelcomeMessageSchema.parse({
        v: 1,
        type: "welcome",
        session: "demo-session",
        hostOnline: true,
        iceProvider: "unknown-provider",
        sessionTtlSeconds: 60,
      }),
    ).toThrow();
  });
});

describe("all v1 control message schemas", () => {
  const validMessages: Record<string, unknown> = {
    hello: minimalHello,
    welcome: {
      v: 1,
      type: "welcome",
      session: "demo-session",
      hostOnline: false,
      clients: [{ clientId: "viewer-1", role: "viewer" }],
      iceServers: [{ urls: ["stun:stun.example.com:3478"] }],
      iceProvider: "stun",
      iceExpiresAt: null,
      transportPolicy: "relay",
      sessionTtlSeconds: 3600,
    },
    "ice-refresh": { v: 1, type: "ice-refresh", provider: "cloudflare" },
    ice: {
      v: 1,
      type: "ice",
      iceServers: [{ urls: "turn:turn.example.com:3478", username: "u", credential: "c" }],
      iceProvider: "coturn",
      iceExpiresAt: 1_760_000_000_000,
    },
    "peer-joined": { v: 1, type: "peer-joined", clientId: "viewer-1" },
    "peer-left": { v: 1, type: "peer-left", clientId: "viewer-1" },
    signal: {
      v: 1,
      type: "signal",
      to: "viewer-1",
      from: "host-1",
      kind: "answer",
      payload: { type: "answer", sdp: "v=0\r\n" },
    },
    transport: {
      v: 1,
      type: "transport",
      clientId: "viewer-1",
      mode: "p2p-turn",
      state: "failed",
      reason: "ice timeout",
    },
    resize: { v: 1, type: "resize", clientId: "viewer-1", cols: 80, rows: 24 },
    "display-size": { v: 1, type: "display-size", cols: 132, rows: 43 },
    resync: { v: 1, type: "resync", fromSeq: "0" },
    ack: { v: 1, type: "ack", seq: "41" },
    pause: { v: 1, type: "pause", clientId: "viewer-1" },
    resume: { v: 1, type: "resume", clientId: "viewer-1" },
    host: { v: 1, type: "host", online: false },
    presence: { v: 1, type: "presence", clients: [] },
    ping: { v: 1, type: "ping" },
    pong: { v: 1, type: "pong", ts: 1_760_000_000_000 },
    error: {
      v: 1,
      type: "error",
      code: "host_exited",
      message: "host process exited",
      retryable: false,
      exitCode: 1,
      signal: "SIGTERM",
    },
    "host-exited": { v: 1, type: "host-exited", exitCode: null, signal: null },
  };

  it("covers every known message type", () => {
    expect(Object.keys(validMessages).sort()).toEqual([...KNOWN_CONTROL_MESSAGE_TYPES].sort());
  });

  for (const [type, message] of Object.entries(validMessages)) {
    it(`parses ${type} from a JSON text frame and re-encodes it`, () => {
      const parsed = parseControlMessage(JSON.stringify(message));
      expect(parsed.type).toBe(type);
      expect(ControlMessageSchema.parse(message).type).toBe(type);

      const encoded = encodeControlMessage(parsed);
      expect(parseControlMessage(encoded).type).toBe(type);
    });
  }

  it("normalizes numeric seq fields to decimal strings on encode", () => {
    const ack = parseControlMessage({ v: 1, type: "ack", seq: 42 });
    expect(ack).toMatchObject({ type: "ack", seq: "42" });

    const resync = parseControlMessage({ v: 1, type: "resync", fromSeq: 7 });
    expect(resync).toMatchObject({ type: "resync", fromSeq: "7" });

    expect(JSON.parse(encodeControlMessage({ v: 1, type: "ack", seq: 42 }))).toEqual({
      v: 1,
      type: "ack",
      seq: "42",
    });
  });

  it("validates seq fields through the shared u64 schema", () => {
    expect(AckMessageSchema.parse({ v: 1, type: "ack", seq: 42 }).seq).toBe("42");
    for (const seq of ["042", "9007199254740992", -1, 1.5]) {
      expect(AckMessageSchema.safeParse({ v: 1, type: "ack", seq }).success).toBe(false);
    }
  });

  it("validates enum fields and numeric bounds", () => {
    expect(() =>
      parseControlMessage({
        v: 1,
        type: "signal",
        to: "viewer-1",
        from: "host-1",
        kind: "candidate",
        payload: {},
      }),
    ).toThrow();
    expect(() =>
      parseControlMessage({
        v: 1,
        type: "transport",
        clientId: "viewer-1",
        mode: "p2p-turn",
        state: "connected",
      }),
    ).toThrow();
    expect(() =>
      parseControlMessage({
        v: 1,
        type: "resize",
        clientId: "viewer-1",
        cols: 0,
        rows: 24,
      }),
    ).toThrow();
    expect(() =>
      parseControlMessage({
        v: 1,
        type: "resize",
        clientId: "viewer-1",
        cols: 80,
        rows: MAX_TERMINAL_DIMENSION + 1,
      }),
    ).toThrow();
    expect(() => parseControlMessage({ v: 1, type: "display-size", cols: 0, rows: 43 })).toThrow();
    expect(() =>
      parseControlMessage({
        v: 1,
        type: "display-size",
        cols: 80,
        rows: MAX_TERMINAL_DIMENSION + 1,
      }),
    ).toThrow();
    expect(() =>
      parseControlMessage({ v: 1, type: "display-size", cols: 10_000, rows: 10_000 }),
    ).toThrow();
    expect(() =>
      parseControlMessage({
        v: 1,
        type: "error",
        code: "definitely_not_an_error_code",
        message: "nope",
      }),
    ).toThrow();
    expect(ERROR_CODES).toContain("not_implemented");
  });

  it("requires signal payloads to be JSON values", () => {
    expect(() =>
      parseControlMessage({
        v: 1,
        type: "signal",
        to: "viewer-1",
        from: "host-1",
        kind: "ice",
        payload: { nested: 1n },
      }),
    ).toThrow();
  });
});

describe("control message envelope and errors", () => {
  it("requires v and a known or agent.* type", () => {
    expectMessageError(
      { type: "hello", role: "viewer", session: "demo-session", clientId: "viewer-1" },
      "invalid_message",
    );
    expectMessageError({ ...minimalHello, type: "unknown-message" }, "invalid_message");
    expectMessageError({ v: 1 }, "invalid_message");
    expectMessageError({ v: 1, type: "hello" }, "invalid_message");
  });

  it("reports unsupported versions distinctly", () => {
    expectMessageError({ ...minimalHello, v: 2 }, "unsupported_version");
    expectMessageError({ ...minimalHello, v: "1" }, "unsupported_version");
    expectMessageError({ ...minimalHello, protocolVersion: 2 }, "unsupported_version");
    expectMessageError(
      { type: "agent.task.claim", protocolVersion: 2, payload: {} },
      "unsupported_version",
    );
  });

  it("reports malformed JSON and non-object payloads as invalid_message", () => {
    for (const input of ["{", "null", "[]", "123", '"hello"']) {
      expectMessageError(input, "invalid_message");
    }
    expectMessageError("", "invalid_message");
  });

  it("exposes a non-throwing parse result", () => {
    const ok = safeParseControlMessage(JSON.stringify(minimalHello));
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.type).toBe("hello");
    }

    const failed = safeParseControlMessage({ v: 2, type: "hello" });
    expect(failed.success).toBe(false);
    if (!failed.success) {
      expect(failed.error.code).toBe("unsupported_version");
    }
  });

  it("rejects messages that cannot be encoded", () => {
    expect(() => encodeControlMessage({ v: 1, type: "nope" })).toThrow(ProtocolMessageError);
  });
});

describe("reserved agent namespace", () => {
  it("represents unknown agent messages with or without v", () => {
    const withV = parseControlMessage({
      v: 1,
      type: "agent.task.claim",
      requestId: "req-1",
      protocolVersion: 1,
      ts: 1_760_000_000_000,
      sessionId: "demo-session",
      payload: { runnerId: "runner-1" },
      futureField: true,
    });
    expect(isAgentMessage(withV)).toBe(true);
    expect(withV.type).toBe("agent.task.claim");

    const withoutV = parseControlMessage({
      type: "agent.runner.register",
      requestId: "req-2",
      protocolVersion: 1,
      payload: { runnerId: "runner-1" },
    });
    expect(isAgentMessage(withoutV)).toBe(true);
    expect(AgentMessageSchema.parse(withoutV).type).toBe("agent.runner.register");

    expect(isAgentMessage(parseControlMessage(minimalHello))).toBe(false);
  });

  it("validates agent message type and envelope fields", () => {
    expect(AGENT_MESSAGE_TYPE_PATTERN.test("agent.task.claim")).toBe(true);
    expect(AGENT_MESSAGE_TYPE_PATTERN.test("agent.ack")).toBe(true);
    for (const type of ["agent", "agent.", "agent.bad type", "tunnel.open"]) {
      expectMessageError({ v: 1, type, payload: {} }, "invalid_message");
    }
    expect(() =>
      AgentMessageSchema.parse({
        v: 1,
        type: "agent.task.claim",
        requestId: "r".repeat(129),
      }),
    ).toThrow();
  });

  it("builds a canonical not_implemented reply for the relay", () => {
    const reply = createNotImplementedErrorMessage({
      requestId: "req-1",
      detail: "agent.task.claim",
    });
    expect(reply).toEqual({
      v: 1,
      type: "error",
      code: "not_implemented",
      message: "feature is not implemented in protocol v1: agent.task.claim",
      retryable: false,
      requestId: "req-1",
    });

    const parsed = parseControlMessage(encodeControlMessage(reply));
    expect(parsed).toEqual(reply);
  });

  it("builds a default not_implemented reply without a request ID", () => {
    const reply = createNotImplementedErrorMessage();
    expect(reply.requestId).toBeUndefined();
    expect(reply.code).toBe("not_implemented");
    expect(reply.retryable).toBe(false);
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe("control message size limits", () => {
  it("rejects a raw control message larger than 128 KiB", () => {
    // Valid JSON (an unknown loose field on `ping`) so the only reason to
    // reject it is the byte cap, not a schema violation.
    const oversized = JSON.stringify({
      v: 1,
      type: "ping",
      padding: "x".repeat(MAX_CONTROL_MESSAGE_BYTES),
    });
    expect(oversized.length).toBeGreaterThan(MAX_CONTROL_MESSAGE_BYTES);
    expectMessageError(oversized, "invalid_message");
  });

  it("rejects a deeply nested signal payload without throwing RangeError", () => {
    const depth = 5_000;
    const raw = `{"v":1,"type":"signal","to":"viewer-1","from":"host-1","kind":"ice","payload":${"[".repeat(depth)}0${"]".repeat(depth)}}`;
    expectMessageError(raw, "invalid_message");
    const result = safeParseControlMessage(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ProtocolMessageError);
    }
  });

  it("rejects a serialized signal payload larger than 64 KiB", () => {
    expectMessageError(
      {
        v: 1,
        type: "signal",
        to: "viewer-1",
        from: "host-1",
        kind: "ice",
        payload: { candidate: "x".repeat(MAX_SIGNAL_PAYLOAD_BYTES) },
      },
      "invalid_message",
    );
  });

  it("still accepts a normal-sized signal payload", () => {
    const parsed = parseControlMessage({
      v: 1,
      type: "signal",
      to: "viewer-1",
      from: "host-1",
      kind: "ice",
      payload: { candidate: "candidate:1 1 udp 1 127.0.0.1 5000 typ host", mid: "0" },
    });
    expect(parsed.type).toBe("signal");
  });

  it("rejects terminal sizes above the cell budget", () => {
    expectMessageError(
      { v: 1, type: "resize", clientId: "viewer-1", cols: 10_000, rows: 10_000 },
      "invalid_message",
    );
    expectMessageError({ ...minimalHello, cols: 10_000, rows: 10_000 }, "invalid_message");
    expectMessageError(
      { v: 1, type: "resize", clientId: "viewer-1", cols: 2_001, rows: 2_000 },
      "invalid_message",
    );
    expect(() =>
      parseControlMessage({
        v: 1,
        type: "resize",
        clientId: "viewer-1",
        cols: 2_000,
        rows: 2_000,
      }),
    ).not.toThrow();
  });
});
