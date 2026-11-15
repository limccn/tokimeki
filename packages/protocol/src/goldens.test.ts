import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ALL_ROLES,
  CLOSE_CODES,
  ERROR_CODES,
  ICE_PROVIDERS,
  ICE_TRANSPORT_POLICIES,
  MAX_CLIENT_ID_LENGTH,
  MAX_DATACHANNEL_MESSAGE_BYTES,
  MAX_FRAME_BYTES,
  MAX_SESSION_ID_LENGTH,
  MAX_TARGET_ID_BYTES,
  MAX_TERMINAL_DIMENSION,
  MIN_TARGET_ID_BYTES,
  PROTOCOL_VERSION,
  RESERVED_ROLES,
  RESIZE_POLICIES,
  ROLES,
  SIGNAL_KINDS,
  TRANSPORT_MODES,
  TRANSPORT_STATES,
} from "./constants.js";
import {
  type BinaryFrame,
  decodeFrame,
  detectFrameType,
  encodeFrame,
  FRAME_TYPES,
  type FrameErrorCode,
  isReservedFrame,
  ProtocolFrameError,
} from "./frames.js";
import { CLIENT_ID_PATTERN, SESSION_ID_PATTERN } from "./ids.js";
import {
  encodeControlMessage,
  KNOWN_CONTROL_MESSAGE_TYPES,
  parseControlMessage,
} from "./messages.js";
import { U64_DECIMAL_PATTERN } from "./u64.js";

interface ConstantsVector {
  protocolVersion: number;
  frameTypes: Record<string, number>;
  roles: string[];
  reservedRoles: string[];
  transportModes: string[];
  transportStates: string[];
  iceProviders: string[];
  iceTransportPolicies: string[];
  resizePolicies: string[];
  signalKinds: string[];
  errorCodes: string[];
  closeCodes: Record<string, number>;
  limits: Record<string, number>;
  patterns: Record<string, string>;
}

interface FrameExpectation {
  type: string;
  seq?: number;
  targetId?: string;
  payloadHex?: string;
}

interface FrameVector {
  name: string;
  hex: string;
  expect: FrameExpectation;
}

interface InvalidFrameVector {
  name: string;
  hex: string;
  error: FrameErrorCode;
}

interface FrameVectors {
  valid: FrameVector[];
  invalid: InvalidFrameVector[];
}

interface ControlVector {
  name: string;
  message: Record<string, unknown>;
}

interface ControlVectors {
  messages: ControlVector[];
}

interface HandshakeEntry {
  from: string;
  to: string;
  message: Record<string, unknown>;
}

interface HandshakeVector {
  name: string;
  transcript: HandshakeEntry[];
}

function readVector<T>(fileName: string): T {
  const url = new URL(`../test/vectors/${fileName}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as T;
}

function fromHex(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "hex"));
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function expectFrameError(fn: () => unknown, code: FrameErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolFrameError);
    expect((error as ProtocolFrameError).code).toBe(code);
    return;
  }
  throw new Error(`expected ProtocolFrameError(${code})`);
}

function expectToFrame(expectation: FrameExpectation): BinaryFrame {
  const payload = fromHex(expectation.payloadHex ?? "");
  switch (expectation.type) {
    case "input":
      return { type: "input", payload };
    case "output":
      if (expectation.seq === undefined) {
        throw new Error("output fixture is missing expect.seq");
      }
      return { type: "output", seq: expectation.seq, payload };
    case "snapshot":
      if (expectation.seq === undefined) {
        throw new Error("snapshot fixture is missing expect.seq");
      }
      return { type: "snapshot", seq: expectation.seq, payload };
    case "resync_req":
      return { type: "resync_req" };
    case "snapshot_to":
      if (expectation.seq === undefined || expectation.targetId === undefined) {
        throw new Error("snapshot_to fixture is missing expect.seq or expect.targetId");
      }
      return {
        type: "snapshot_to",
        targetId: expectation.targetId,
        seq: expectation.seq,
        payload,
      };
    case "tunnel":
      return { type: "tunnel", payload };
    case "tunnel_to":
      if (expectation.targetId === undefined) {
        throw new Error("tunnel_to fixture is missing expect.targetId");
      }
      return { type: "tunnel_to", targetId: expectation.targetId, payload };
    default:
      throw new Error(`unknown frame fixture type ${expectation.type}`);
  }
}

describe("constants golden vector", () => {
  const constants = readVector<ConstantsVector>("constants.json");

  it("matches every exported protocol constant", () => {
    expect(constants.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(constants.frameTypes).toEqual(FRAME_TYPES);
    expect(constants.roles).toEqual([...ROLES]);
    expect(constants.reservedRoles).toEqual([...RESERVED_ROLES]);
    expect([...constants.roles, ...constants.reservedRoles]).toEqual([...ALL_ROLES]);
    expect(constants.transportModes).toEqual([...TRANSPORT_MODES]);
    expect(constants.transportStates).toEqual([...TRANSPORT_STATES]);
    expect(constants.iceProviders).toEqual([...ICE_PROVIDERS]);
    expect(constants.iceTransportPolicies).toEqual([...ICE_TRANSPORT_POLICIES]);
    expect(constants.resizePolicies).toEqual([...RESIZE_POLICIES]);
    expect(constants.signalKinds).toEqual([...SIGNAL_KINDS]);
    expect(constants.errorCodes).toEqual([...ERROR_CODES]);
    expect(constants.closeCodes).toEqual(CLOSE_CODES);
    expect(constants.limits).toEqual({
      maxFrameBytes: MAX_FRAME_BYTES,
      maxDatachannelMessageBytes: MAX_DATACHANNEL_MESSAGE_BYTES,
      maxTerminalDimension: MAX_TERMINAL_DIMENSION,
      maxSessionIdLength: MAX_SESSION_ID_LENGTH,
      maxClientIdLength: MAX_CLIENT_ID_LENGTH,
      minTargetIdBytes: MIN_TARGET_ID_BYTES,
      maxTargetIdBytes: MAX_TARGET_ID_BYTES,
    });
    expect(constants.patterns).toEqual({
      sessionId: SESSION_ID_PATTERN.source,
      clientId: CLIENT_ID_PATTERN.source,
      u64Decimal: U64_DECIMAL_PATTERN.source,
    });
  });
});

describe("binary frame golden vectors", () => {
  const vectors = readVector<FrameVectors>("frames.json");

  it("covers every v1 and reserved frame type", () => {
    const seen = new Set(vectors.valid.map((vector) => vector.expect.type));
    expect([...seen].sort()).toEqual(
      ["input", "output", "resync_req", "snapshot", "snapshot_to", "tunnel", "tunnel_to"].sort(),
    );
  });

  for (const vector of vectors.valid) {
    it(`encodes and decodes ${vector.name} byte-exactly`, () => {
      const expectedFrame = expectToFrame(vector.expect);
      const encoded = encodeFrame(expectedFrame);
      expect(toHex(encoded)).toBe(vector.hex);

      const decoded = decodeFrame(fromHex(vector.hex));
      expect(decoded).toEqual(expectedFrame);

      const typeByte = fromHex(vector.hex)[0];
      expect(detectFrameType(fromHex(vector.hex))).toBe(typeByte);

      const reserved = decoded.type === "tunnel" || decoded.type === "tunnel_to";
      expect(isReservedFrame(decoded)).toBe(reserved);
    });
  }

  for (const vector of vectors.invalid) {
    it(`rejects ${vector.name} with ${vector.error}`, () => {
      expectFrameError(() => decodeFrame(fromHex(vector.hex)), vector.error);
    });
  }
});

describe("control message golden vectors", () => {
  const vectors = readVector<ControlVectors>("control-messages.json");

  it("covers every known message type and the agent namespace", () => {
    const types = new Set(vectors.messages.map((vector) => String(vector.message.type)));
    for (const known of KNOWN_CONTROL_MESSAGE_TYPES) {
      expect(types.has(known)).toBe(true);
    }
    expect(types.has("agent.task.claim")).toBe(true);
    expect(types.has("agent.runner.register")).toBe(true);
  });

  for (const vector of vectors.messages) {
    it(`parses and roundtrips ${vector.name}`, () => {
      const parsed = parseControlMessage(vector.message);
      expect(parsed.type).toBe(vector.message.type);

      const encoded = encodeControlMessage(parsed);
      const reparsed = parseControlMessage(encoded);
      expect(reparsed).toEqual(parsed);
    });
  }

  it("includes the hello/welcome/error fixtures required for cross-language clients", () => {
    const byName = new Map(vectors.messages.map((vector) => [vector.name, vector.message]));
    expect(byName.get("hello-viewer")?.type).toBe("hello");
    expect(byName.get("welcome-basic")?.type).toBe("welcome");
    expect(byName.get("error-unauthorized")?.type).toBe("error");
    expect(byName.get("agent-task-claim-unknown")?.type).toBe("agent.task.claim");
    expect(byName.get("agent-not-implemented-reply")?.code).toBe("not_implemented");
  });
});

describe("handshake transcript golden vector", () => {
  const vector = readVector<HandshakeVector>("handshake.json");

  it("follows hello -> welcome -> ice-refresh -> ice", () => {
    const parsed = vector.transcript.map((entry) => ({
      from: entry.from,
      to: entry.to,
      message: parseControlMessage(JSON.stringify(entry.message)),
    }));

    expect(parsed.map((entry) => entry.message.type)).toEqual([
      "hello",
      "welcome",
      "ice-refresh",
      "ice",
    ]);
    expect(parsed.map((entry) => `${entry.from}->${entry.to}`)).toEqual([
      "viewer->relay",
      "relay->viewer",
      "viewer->relay",
      "relay->viewer",
    ]);

    const hello = parsed[0]?.message;
    const welcome = parsed[1]?.message;
    if (hello?.type !== "hello" || welcome?.type !== "welcome") {
      throw new Error("handshake transcript must start with hello and welcome");
    }
    expect(hello.session).toBe("demo-session");
    expect(welcome.session).toBe(hello.session);
    expect(welcome.hostOnline).toBe(true);

    const refresh = parsed[2]?.message;
    const ice = parsed[3]?.message;
    if (refresh?.type !== "ice-refresh" || ice?.type !== "ice") {
      throw new Error("handshake transcript must refresh ICE last");
    }
    expect(refresh.provider).toBe("coturn");
    expect(ice.iceProvider).toBe("coturn");

    for (const entry of parsed) {
      expect(parseControlMessage(encodeControlMessage(entry.message))).toEqual(entry.message);
    }
  });
});
