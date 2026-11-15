import { describe, expect, it } from "vitest";

import * as protocol from "./index.js";

describe("protocol bootstrap", () => {
  it("exposes protocol version 1", () => {
    expect(protocol.PROTOCOL_VERSION).toBe(1);
  });

  it("re-exports the frame codec, message schemas, and shared constants", () => {
    expect(protocol.FRAME_TYPES.INPUT).toBe(0x01);
    expect(protocol.FRAME_TYPES.TUNNEL_TO).toBe(0x07);
    expect(protocol.MAX_DATACHANNEL_MESSAGE_BYTES).toBe(16_384);
    expect(protocol.MAX_FRAME_BYTES).toBe(1_048_576);
    expect(typeof protocol.parseControlMessage).toBe("function");
    expect(typeof protocol.encodeControlMessage).toBe("function");
    expect(typeof protocol.decodeFrame).toBe("function");
    expect(typeof protocol.encodeFrame).toBe("function");
    expect(typeof protocol.createNotImplementedErrorMessage).toBe("function");
    expect(
      protocol.HelloMessageSchema.safeParse({
        v: 1,
        type: "hello",
        role: "viewer",
        session: "demo-session",
        clientId: "viewer-1",
      }).success,
    ).toBe(true);
  });
});
