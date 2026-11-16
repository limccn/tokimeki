import {
  type HelloMessage,
  MAX_DATACHANNEL_MESSAGE_BYTES,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  parseControlMessage,
} from "@limccn/tokimeki-protocol";
import { describe, expect, it } from "vitest";

import { buildCapabilities, supportsFragmentation } from "./capabilities.js";

describe("buildCapabilities", () => {
  it("advertises fragmentation when P2P is enabled", () => {
    const capabilities = buildCapabilities({ p2p: true });
    expect(capabilities.transports?.modes).toEqual(["relay", "p2p-direct", "p2p-turn"]);
    expect(capabilities.transports?.fragmentation).toEqual({
      version: 1,
      maxFrameBytes: MAX_FRAME_BYTES,
      maxMessageBytes: MAX_DATACHANNEL_MESSAGE_BYTES,
    });
  });

  it("omits fragmentation when P2P is disabled", () => {
    const capabilities = buildCapabilities({ p2p: false });
    expect(capabilities.transports?.modes).toEqual(["relay"]);
    expect(capabilities.transports?.fragmentation).toBeUndefined();
  });

  it("accepts only the exact fragmentation dialect", () => {
    const enabled = buildCapabilities({ p2p: true });
    const fragmentation = enabled.transports?.fragmentation;
    if (fragmentation === undefined) throw new Error("expected fragmentation capability");

    expect(supportsFragmentation(enabled)).toBe(true);
    expect(supportsFragmentation(undefined)).toBe(false);
    expect(supportsFragmentation(buildCapabilities({ p2p: false }))).toBe(false);
    expect(
      supportsFragmentation({
        ...enabled,
        transports: {
          ...enabled.transports,
          fragmentation: { ...fragmentation, version: 2 },
        },
      }),
    ).toBe(false);
    expect(
      supportsFragmentation({
        ...enabled,
        transports: {
          ...enabled.transports,
          fragmentation: { ...fragmentation, maxMessageBytes: 8_192 },
        },
      }),
    ).toBe(false);
    expect(
      supportsFragmentation({
        ...enabled,
        transports: {
          ...enabled.transports,
          fragmentation: { ...fragmentation, maxFrameBytes: MAX_FRAME_BYTES - 1 },
        },
      }),
    ).toBe(false);
  });

  it("roundtrips through the hello schema", () => {
    const capabilities = buildCapabilities({ p2p: true });
    const parsed = parseControlMessage({
      v: PROTOCOL_VERSION,
      type: "hello",
      role: "viewer",
      session: "demo-session",
      clientId: "viewer-1",
      protocolVersion: PROTOCOL_VERSION,
      capabilities,
    });
    expect(parsed.type).toBe("hello");
    const hello = parsed as HelloMessage;
    expect(hello.capabilities.transports?.fragmentation).toEqual({
      version: 1,
      maxFrameBytes: MAX_FRAME_BYTES,
      maxMessageBytes: MAX_DATACHANNEL_MESSAGE_BYTES,
    });
  });
});
