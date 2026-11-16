/**
 * TUN profile capability negotiation.
 *
 * F1 only advertises `fec: ["none"]`; XOR FEC is deliberately deferred. A peer
 * that requires XOR, a different key mode, or a different record dialect is
 * treated as incompatible and the session stays on the v1 relay path.
 */

import {
  type Capabilities,
  TUNNEL_ARQ_MODE,
  TUNNEL_CRYPTO_MODE,
  TUNNEL_KEY_MODES,
  TUNNEL_MAX_FRAME_BYTES,
  TUNNEL_RECORD_VERSION,
  type TunnelCapability,
  type TunnelKeyMode,
} from "@limccn/tokimeki-protocol";

/** FEC dialects implemented by this build. XOR is deferred to F1.1. */
export const TUNNEL_FEC_SUPPORTED = ["none"] as const;

/** Tunnel offer parameters carried in the host's P2P `offer` signal payload. */
export interface TunnelOfferParams {
  readonly version: number;
  readonly keyMode: TunnelKeyMode;
  readonly fec: "none";
  readonly initialSeq: number;
}

function isKeyMode(value: unknown): value is TunnelKeyMode {
  return typeof value === "string" && (TUNNEL_KEY_MODES as readonly string[]).includes(value);
}

/** Build the `tunnel` capability advertised in `hello`. */
export function buildTunnelCapability(keyMode: TunnelKeyMode): TunnelCapability {
  return {
    version: TUNNEL_RECORD_VERSION,
    arq: TUNNEL_ARQ_MODE,
    fec: [...TUNNEL_FEC_SUPPORTED],
    crypto: TUNNEL_CRYPTO_MODE,
    keyMode,
    maxFrameSize: TUNNEL_MAX_FRAME_BYTES,
  };
}

/**
 * Return the peer's tunnel capability only when it matches the exact dialect
 * this build can speak. Unknown or looser values are treated as unsupported.
 */
export function matchingTunnelCapability(
  capabilities: Capabilities | undefined,
): TunnelCapability | null {
  const tunnel = capabilities?.tunnel;
  if (tunnel === undefined) return null;
  if (tunnel.version !== TUNNEL_RECORD_VERSION) return null;
  if (tunnel.arq !== TUNNEL_ARQ_MODE) return null;
  if (tunnel.crypto !== TUNNEL_CRYPTO_MODE) return null;
  if (!isKeyMode(tunnel.keyMode)) return null;
  if (tunnel.maxFrameSize === undefined || tunnel.maxFrameSize < TUNNEL_MAX_FRAME_BYTES) {
    return null;
  }
  if (!Array.isArray(tunnel.fec) || !tunnel.fec.includes("none")) return null;
  return tunnel;
}

/**
 * True when both peers derived keys from the same kind of material.
 *
 * A host using `shared-secret` must never accept a `session-token` viewer (and
 * vice versa): the keys cannot match.
 */
export function tunnelCapabilitiesCompatible(
  peer: TunnelCapability | null,
  localKeyMode: TunnelKeyMode,
): peer is TunnelCapability {
  return peer !== null && peer.keyMode === localKeyMode;
}

/** Build the offer metadata the host embeds in its P2P `offer` signal. */
export function buildTunnelOffer(keyMode: TunnelKeyMode): TunnelOfferParams {
  return {
    version: TUNNEL_RECORD_VERSION,
    keyMode,
    fec: "none",
    initialSeq: 0,
  };
}

/** Parse and validate offer metadata; unknown fields are ignored. */
export function parseTunnelOffer(value: unknown): TunnelOfferParams | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== TUNNEL_RECORD_VERSION) return null;
  if (!isKeyMode(record.keyMode)) return null;
  if (record.fec !== "none") return null;
  if (record.initialSeq !== 0) return null;
  return {
    version: TUNNEL_RECORD_VERSION,
    keyMode: record.keyMode,
    fec: "none",
    initialSeq: 0,
  };
}

/** True when a viewer can accept the host's offer with its local key mode. */
export function tunnelOfferCompatible(
  offer: TunnelOfferParams | null,
  localKeyMode: TunnelKeyMode,
): offer is TunnelOfferParams {
  return offer !== null && offer.keyMode === localKeyMode;
}
