import {
  type Capabilities,
  TUNNEL_MAX_FRAME_BYTES,
  TUNNEL_RECORD_VERSION,
} from "@limccn/tokimeki-protocol";
import { describe, expect, it } from "vitest";

import {
  buildTunnelCapability,
  buildTunnelOffer,
  matchingTunnelCapability,
  parseTunnelOffer,
  peerSupportsXorFec,
  selectTunnelFec,
  tunnelCapabilitiesCompatible,
  tunnelOfferCompatible,
} from "./capability.js";

describe("tunnel capability", () => {
  it("advertises the F1 dialect with both FEC modes", () => {
    const capability = buildTunnelCapability("session-token");
    expect(capability).toEqual({
      version: 1,
      arq: "selective-repeat",
      fec: ["none", "xor"],
      crypto: "aes-256-gcm",
      keyMode: "session-token",
      maxFrameSize: TUNNEL_MAX_FRAME_BYTES,
    });
    expect(buildTunnelCapability("shared-secret").keyMode).toBe("shared-secret");
  });

  it("accepts only a matching dialect but either FEC mode", () => {
    const capability = buildTunnelCapability("session-token");
    const base: Capabilities = { tunnel: capability };
    expect(matchingTunnelCapability(base)).toEqual(capability);
    expect(matchingTunnelCapability(undefined)).toBeNull();
    expect(matchingTunnelCapability({})).toBeNull();
    expect(matchingTunnelCapability({ tunnel: { ...capability, version: 2 } })).toBeNull();
    expect(matchingTunnelCapability({ tunnel: { ...capability, arq: "kcp" } })).toBeNull();
    expect(matchingTunnelCapability({ tunnel: { ...capability, crypto: "future" } })).toBeNull();
    expect(matchingTunnelCapability({ tunnel: { ...capability, keyMode: "future" } })).toBeNull();
    expect(matchingTunnelCapability({ tunnel: { ...capability, fec: ["none"] } })).toEqual({
      ...capability,
      fec: ["none"],
    });
    expect(matchingTunnelCapability({ tunnel: { ...capability, fec: ["xor"] } })).toEqual({
      ...capability,
      fec: ["xor"],
    });
    expect(matchingTunnelCapability({ tunnel: { ...capability, fec: [] } })).toBeNull();
    expect(matchingTunnelCapability({ tunnel: { ...capability, fec: ["future"] } })).toBeNull();
    expect(
      matchingTunnelCapability({
        tunnel: { ...capability, maxFrameSize: TUNNEL_MAX_FRAME_BYTES - 1 },
      }),
    ).toBeNull();
  });

  it("requires the same key mode on both ends", () => {
    const sessionToken = buildTunnelCapability("session-token");
    const sharedSecret = buildTunnelCapability("shared-secret");
    expect(tunnelCapabilitiesCompatible(sessionToken, "session-token")).toBe(true);
    expect(tunnelCapabilitiesCompatible(sessionToken, "shared-secret")).toBe(false);
    expect(tunnelCapabilitiesCompatible(sharedSecret, "shared-secret")).toBe(true);
    expect(tunnelCapabilitiesCompatible(null, "session-token")).toBe(false);
  });

  it("selects XOR only when both sides request and advertise it", () => {
    const withXor = buildTunnelCapability("session-token");
    const noneOnly = { ...withXor, fec: ["none"] };
    expect(peerSupportsXorFec(withXor)).toBe(true);
    expect(peerSupportsXorFec(noneOnly)).toBe(false);
    expect(peerSupportsXorFec(null)).toBe(false);
    expect(selectTunnelFec("xor", withXor)).toBe("xor");
    expect(selectTunnelFec("xor", noneOnly)).toBe("none");
    expect(selectTunnelFec("xor", null)).toBe("none");
    expect(selectTunnelFec("none", withXor)).toBe("none");
  });
});

describe("tunnel offer metadata", () => {
  it("builds and parses canonical offer parameters", () => {
    const offer = buildTunnelOffer("session-token");
    expect(offer).toEqual({
      version: TUNNEL_RECORD_VERSION,
      keyMode: "session-token",
      fec: "none",
      initialSeq: 0,
    });
    expect(parseTunnelOffer(offer)).toEqual(offer);
    const xorOffer = buildTunnelOffer("session-token", "xor");
    expect(parseTunnelOffer(xorOffer)).toEqual(xorOffer);
  });

  it("rejects mismatched or unknown offers but accepts both FEC modes", () => {
    expect(parseTunnelOffer(null)).toBeNull();
    expect(parseTunnelOffer("offer")).toBeNull();
    expect(parseTunnelOffer({ ...buildTunnelOffer("session-token"), version: 2 })).toBeNull();
    expect(
      parseTunnelOffer({ ...buildTunnelOffer("session-token"), keyMode: "future" }),
    ).toBeNull();
    expect(parseTunnelOffer({ ...buildTunnelOffer("session-token"), fec: "future" })).toBeNull();
    expect(parseTunnelOffer({ ...buildTunnelOffer("session-token"), initialSeq: 5 })).toBeNull();
    expect(parseTunnelOffer({ ...buildTunnelOffer("session-token"), extra: true })).toEqual(
      buildTunnelOffer("session-token"),
    );
  });

  it("requires the offer key mode to match the local mode", () => {
    const offer = buildTunnelOffer("session-token");
    expect(tunnelOfferCompatible(offer, "session-token")).toBe(true);
    expect(tunnelOfferCompatible(offer, "shared-secret")).toBe(false);
    expect(tunnelOfferCompatible(null, "session-token")).toBe(false);
  });
});
