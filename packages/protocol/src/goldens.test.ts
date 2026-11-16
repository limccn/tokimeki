import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ALL_ROLES,
  CLOSE_CODES,
  ERROR_CODES,
  FRAGMENT_HEADER_BYTES,
  ICE_PROVIDERS,
  ICE_TRANSPORT_POLICIES,
  MAX_CLIENT_ID_LENGTH,
  MAX_DATACHANNEL_MESSAGE_BYTES,
  MAX_FRAGMENT_COUNT,
  MAX_FRAME_BYTES,
  MAX_SESSION_ID_LENGTH,
  MAX_TARGET_ID_BYTES,
  MAX_TERMINAL_DIMENSION,
  MIN_TARGET_ID_BYTES,
  MIN_TUNNEL_SECRET_BYTES,
  PROTOCOL_VERSION,
  RESERVED_ROLES,
  RESIZE_POLICIES,
  ROLES,
  SIGNAL_KINDS,
  TRANSPORT_MODES,
  TRANSPORT_STATES,
  TUNNEL_ARQ_MODE,
  TUNNEL_CRYPTO_MODE,
  TUNNEL_DIRECTIONS,
  TUNNEL_INPUT_PAYLOAD_MAX_BYTES,
  TUNNEL_KEY_BYTES,
  TUNNEL_KEY_MODES,
  TUNNEL_MAX_FRAME_BYTES,
  TUNNEL_MAX_RECORD_BYTES,
  TUNNEL_NONCE_BYTES,
  TUNNEL_OUTPUT_PAYLOAD_MAX_BYTES,
  TUNNEL_RECORD_HEADER_BYTES,
  TUNNEL_RECORD_TYPES,
  TUNNEL_RECORD_VERSION,
  TUNNEL_TAG_BYTES,
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
import {
  decodeTunnelRecord,
  encodeTunnelAad,
  encodeTunnelRecord,
  type TunnelRecordHeader,
} from "./tunnel.js";
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
  tunnelRecordVersion: number;
  tunnelRecordTypes: Record<string, number>;
  tunnelDirections: Record<string, number>;
  tunnelKeyModes: string[];
  tunnelArqMode: string;
  tunnelCryptoMode: string;
}

interface FrameExpectation {
  type: string;
  seq?: number;
  targetId?: string;
  messageId?: number;
  fragmentIndex?: number;
  fragmentCount?: number;
  totalBytes?: number;
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
    case "fragment":
      if (
        expectation.messageId === undefined ||
        expectation.fragmentIndex === undefined ||
        expectation.fragmentCount === undefined ||
        expectation.totalBytes === undefined
      ) {
        throw new Error("fragment fixture is missing expect fragment metadata");
      }
      return {
        type: "fragment",
        messageId: expectation.messageId,
        fragmentIndex: expectation.fragmentIndex,
        fragmentCount: expectation.fragmentCount,
        totalBytes: expectation.totalBytes,
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
      fragmentHeaderBytes: FRAGMENT_HEADER_BYTES,
      maxFragmentCount: MAX_FRAGMENT_COUNT,
      maxTerminalDimension: MAX_TERMINAL_DIMENSION,
      maxSessionIdLength: MAX_SESSION_ID_LENGTH,
      maxClientIdLength: MAX_CLIENT_ID_LENGTH,
      minTargetIdBytes: MIN_TARGET_ID_BYTES,
      maxTargetIdBytes: MAX_TARGET_ID_BYTES,
      tunnelRecordHeaderBytes: TUNNEL_RECORD_HEADER_BYTES,
      tunnelNonceBytes: TUNNEL_NONCE_BYTES,
      tunnelTagBytes: TUNNEL_TAG_BYTES,
      tunnelKeyBytes: TUNNEL_KEY_BYTES,
      minTunnelSecretBytes: MIN_TUNNEL_SECRET_BYTES,
      tunnelMaxFrameBytes: TUNNEL_MAX_FRAME_BYTES,
      tunnelOutputPayloadMaxBytes: TUNNEL_OUTPUT_PAYLOAD_MAX_BYTES,
      tunnelInputPayloadMaxBytes: TUNNEL_INPUT_PAYLOAD_MAX_BYTES,
      tunnelMaxRecordBytes: TUNNEL_MAX_RECORD_BYTES,
    });
    expect(constants.patterns).toEqual({
      sessionId: SESSION_ID_PATTERN.source,
      clientId: CLIENT_ID_PATTERN.source,
      u64Decimal: U64_DECIMAL_PATTERN.source,
    });
    expect(constants.tunnelRecordVersion).toBe(TUNNEL_RECORD_VERSION);
    expect(constants.tunnelRecordTypes).toEqual(TUNNEL_RECORD_TYPES);
    expect(constants.tunnelDirections).toEqual(TUNNEL_DIRECTIONS);
    expect(constants.tunnelKeyModes).toEqual([...TUNNEL_KEY_MODES]);
    expect(constants.tunnelArqMode).toBe(TUNNEL_ARQ_MODE);
    expect(constants.tunnelCryptoMode).toBe(TUNNEL_CRYPTO_MODE);
  });
});

describe("binary frame golden vectors", () => {
  const vectors = readVector<FrameVectors>("frames.json");

  it("covers every v1, v1.1 fragment, and reserved frame type", () => {
    const seen = new Set(vectors.valid.map((vector) => vector.expect.type));
    expect([...seen].sort()).toEqual(
      [
        "fragment",
        "input",
        "output",
        "resync_req",
        "snapshot",
        "snapshot_to",
        "tunnel",
        "tunnel_to",
      ].sort(),
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

interface TunnelHeaderVector {
  version: number;
  type: string;
  flags: number;
  seq: number;
  ackSeq: number;
  ackBits: number;
  nonceHex: string;
}

interface TunnelRecordVector {
  name: string;
  hex: string;
  header: TunnelHeaderVector;
  ciphertextHex: string;
}

interface TunnelAadVector {
  name: string;
  direction: 1 | 2;
  sessionId: string;
  header: TunnelHeaderVector;
  aadHex: string;
}

interface InvalidTunnelRecordVector {
  name: string;
  hex: string;
  error: FrameErrorCode;
}

interface TunnelRecordVectors {
  records: TunnelRecordVector[];
  aad: TunnelAadVector[];
  invalid: InvalidTunnelRecordVector[];
}

function headerFromVector(vector: TunnelHeaderVector): TunnelRecordHeader {
  return {
    version: vector.version,
    type: vector.type as TunnelRecordHeader["type"],
    flags: vector.flags,
    seq: vector.seq,
    ackSeq: vector.ackSeq,
    ackBits: vector.ackBits,
    nonce: fromHex(vector.nonceHex),
  };
}

describe("tunnel record golden vectors", () => {
  const vectors = readVector<TunnelRecordVectors>("tunnel-records.json");

  for (const vector of vectors.records) {
    it(`encodes and decodes ${vector.name} byte-exactly`, () => {
      const header = headerFromVector(vector.header);
      const ciphertext = fromHex(vector.ciphertextHex);
      expect(toHex(encodeTunnelRecord(header, ciphertext))).toBe(vector.hex);

      const decoded = decodeTunnelRecord(fromHex(vector.hex));
      expect(decoded.header).toEqual(header);
      expect(toHex(decoded.ciphertext)).toBe(vector.ciphertextHex);
    });
  }

  for (const vector of vectors.aad) {
    it(`builds the ${vector.name} AEAD AAD`, () => {
      const aad = encodeTunnelAad(
        headerFromVector(vector.header),
        vector.direction,
        vector.sessionId,
      );
      expect(toHex(aad)).toBe(vector.aadHex);
    });
  }

  for (const vector of vectors.invalid) {
    it(`rejects ${vector.name} with ${vector.error}`, () => {
      expectFrameError(() => decodeTunnelRecord(fromHex(vector.hex)), vector.error);
    });
  }

  it("rejects a record whose plaintext exceeds the DataChannel budget", () => {
    const header = headerFromVector(
      vectors.records[0]?.header ?? {
        version: 1,
        type: "data",
        flags: 0,
        seq: 0,
        ackSeq: 0,
        ackBits: 0,
        nonceHex: "000000000000000000000000",
      },
    );
    const oversized = new Uint8Array(TUNNEL_MAX_FRAME_BYTES + TUNNEL_TAG_BYTES + 1);
    expectFrameError(() => encodeTunnelRecord(header, oversized), "invalid_frame");
    const wire = new Uint8Array(TUNNEL_RECORD_HEADER_BYTES + oversized.byteLength);
    wire.set(encodeTunnelRecord(header, new Uint8Array(TUNNEL_TAG_BYTES)), 0);
    wire.set(oversized, TUNNEL_RECORD_HEADER_BYTES);
    expectFrameError(() => decodeTunnelRecord(wire), "invalid_frame");
  });
});
