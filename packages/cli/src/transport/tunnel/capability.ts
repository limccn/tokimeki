/**
 * TUN profile capability negotiation.
 *
 * F1.1 advertises both `fec: ["none", "xor"]`. The host offers XOR only when
 * its own sender policy is `xor` and the peer advertises it; older peers get
 * `fec: "none"` and the session continues on the F1 dialect. A peer that
 * requires a different key mode or record dialect is treated as incompatible
 * and the session stays on the v1 relay path.
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

/** FEC dialects implemented by this build. */
export const TUNNEL_FEC_SUPPORTED = ["none", "xor"] as const;

/** Parity policy used by one tunnel endpoint. */
export type TunnelFecMode = (typeof TUNNEL_FEC_SUPPORTED)[number];

/** Tunnel offer parameters carried in the host's P2P `offer` signal payload. */
export interface TunnelOfferParams {
  readonly version: number;
  readonly keyMode: TunnelKeyMode;
  readonly fec: TunnelFecMode;
  readonly initialSeq: number;
}

function isKeyMode(value: unknown): value is TunnelKeyMode {
  return typeof value === "string" && (TUNNEL_KEY_MODES as readonly string[]).includes(value);
}

function isFecMode(value: unknown): value is TunnelFecMode {
  return value === "none" || value === "xor";
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
 * this build can speak. Either FEC dialect is acceptable because this build
 * always understands incoming parity; unsupported values are treated as
 * unsupported.
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
  if (!Array.isArray(tunnel.fec)) return null;
  if (!tunnel.fec.some((fec) => isFecMode(fec))) return null;
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

/** True when the peer declared XOR parity support. */
export function peerSupportsXorFec(peer: TunnelCapability | null): boolean {
  return peer !== null && Array.isArray(peer.fec) && peer.fec.includes("xor");
}

/**
 * Pick the parity policy for one link.
 *
 * The sender only emits parity when its local policy is `xor` and the peer
 * advertised XOR; otherwise the link keeps the plain F1 dialect.
 */
export function selectTunnelFec(
  localFec: TunnelFecMode,
  peer: TunnelCapability | null,
): TunnelFecMode {
  return localFec === "xor" && peerSupportsXorFec(peer) ? "xor" : "none";
}

/** Build the offer metadata the host embeds in its P2P `offer` signal. */
export function buildTunnelOffer(
  keyMode: TunnelKeyMode,
  fec: TunnelFecMode = "none",
): TunnelOfferParams {
  return {
    version: TUNNEL_RECORD_VERSION,
    keyMode,
    fec,
    initialSeq: 0,
  };
}

/** Parse and validate offer metadata; unknown fields are ignored. */
export function parseTunnelOffer(value: unknown): TunnelOfferParams | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== TUNNEL_RECORD_VERSION) return null;
  if (!isKeyMode(record.keyMode)) return null;
  if (!isFecMode(record.fec)) return null;
  if (record.initialSeq !== 0) return null;
  return {
    version: TUNNEL_RECORD_VERSION,
    keyMode: record.keyMode,
    fec: record.fec,
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
