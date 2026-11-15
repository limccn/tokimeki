/**
 * Translation layer between the protocol's ICE server descriptions and the
 * node-datachannel (libdatachannel) `RtcConfig` shape.
 *
 * The relay hands out standards-style URLs (`stun:host:port`,
 * `turn:host:port?transport=udp`, `turns:host:port?transport=tcp`). libdatachannel
 * accepts plain URL strings for STUN but needs structured entries with
 * credentials and an explicit relay type for TURN, so TURN URLs are expanded
 * here. Nothing in this module logs credentials.
 */

import type { IceServerConfig, TransportMode } from "@limccn/tokimeki-protocol";

import type { IceTransportPolicy } from "../config.js";

export type NodeRelayType = "TurnUdp" | "TurnTcp" | "TurnTls";

export interface NodeIceServer {
  readonly hostname: string;
  readonly port: number;
  readonly username?: string;
  readonly password?: string;
  readonly relayType?: NodeRelayType;
}

/** Structural subset of node-datachannel's `RtcConfig`. */
export interface NodeRtcConfig {
  readonly iceServers: ReadonlyArray<string | NodeIceServer>;
  readonly iceTransportPolicy?: IceTransportPolicy;
  readonly maxMessageSize?: number;
}

/** Mirrors the relay's default so a client never attempts ICE with no servers. */
export const DEFAULT_STUN_URL = "stun:stun.cloudflare.com:3478";

interface ParsedIceUrl {
  readonly scheme: "stun" | "stuns" | "turn" | "turns";
  readonly hostname: string;
  readonly port: number;
  readonly tcp: boolean;
}

const ICE_URL_PATTERN = /^(stun|stuns|turn|turns):([^?]+)(?:\?(.*))?$/i;

function defaultPort(scheme: ParsedIceUrl["scheme"]): number {
  return scheme === "turns" ? 5349 : 3478;
}

/**
 * Parse one ICE URL. Returns `null` for malformed entries instead of throwing:
 * a bad TURN URL should degrade to the remaining servers, not abort P2P.
 */
export function parseIceUrl(raw: string): ParsedIceUrl | null {
  const match = ICE_URL_PATTERN.exec(raw.trim());
  if (match === null) return null;
  const scheme = (match[1] ?? "").toLowerCase() as ParsedIceUrl["scheme"];
  const authority = match[2] ?? "";
  const query = match[3] ?? "";

  let hostname = authority;
  let port = defaultPort(scheme);
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority);
  if (bracket !== null) {
    hostname = bracket[1] ?? "";
    if (bracket[2] !== undefined) port = Number.parseInt(bracket[2], 10);
  } else {
    const lastColon = authority.lastIndexOf(":");
    if (lastColon > 0) {
      const portText = authority.slice(lastColon + 1);
      if (!/^\d+$/.test(portText)) return null;
      hostname = authority.slice(0, lastColon);
      port = Number.parseInt(portText, 10);
    }
  }
  if (hostname.length === 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) {
    return null;
  }

  const transport = /(?:^|&)transport=(udp|tcp)(?:&|$)/i.exec(query)?.[1]?.toLowerCase();
  return {
    scheme,
    hostname,
    port,
    tcp: transport === "tcp",
  };
}

/**
 * Convert protocol ICE servers into node-datachannel entries.
 *
 * STUN entries stay as URL strings; TURN entries become structured objects so
 * username/credential can be passed. TURN entries without credentials are
 * dropped (libdatachannel cannot authenticate them).
 */
export function toNodeIceServers(
  servers: readonly IceServerConfig[],
): Array<string | NodeIceServer> {
  const result: Array<string | NodeIceServer> = [];
  for (const server of servers) {
    const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
    for (const url of urls) {
      const parsed = parseIceUrl(url);
      if (parsed === null) continue;
      if (parsed.scheme === "stun" || parsed.scheme === "stuns") {
        result.push(url.trim());
        continue;
      }
      if (
        server.username === undefined ||
        server.username.length === 0 ||
        server.credential === undefined ||
        server.credential.length === 0
      ) {
        continue;
      }
      let relayType: NodeRelayType;
      if (parsed.scheme === "turns") {
        relayType = "TurnTls";
      } else {
        relayType = parsed.tcp ? "TurnTcp" : "TurnUdp";
      }
      result.push({
        hostname: parsed.hostname,
        port: parsed.port,
        username: server.username,
        password: server.credential,
        relayType,
      });
    }
  }
  if (result.length === 0) {
    result.push(DEFAULT_STUN_URL);
  }
  return result;
}

/**
 * Reconcile the local `TOKIMEKI_ICE_TRANSPORT_POLICY` with the relay's
 * advertised policy. Either side asking for relay-only is honored, so a
 * client can force TURN without depending on the relay environment.
 */
export function resolveIceTransportPolicy(
  local: IceTransportPolicy,
  advertised: IceTransportPolicy,
): IceTransportPolicy {
  return local === "relay" || advertised === "relay" ? "relay" : "all";
}

/** Build the node-datachannel config for one PeerConnection. */
export function buildNodeRtcConfig(
  servers: readonly IceServerConfig[],
  policy: IceTransportPolicy,
): NodeRtcConfig {
  return {
    iceServers: toNodeIceServers(servers),
    iceTransportPolicy: policy,
  };
}

export interface CandidatePairLike {
  readonly local: { readonly type: string };
  readonly remote: { readonly type: string };
}

/**
 * Classify the selected ICE candidate pair.
 *
 * A relay on either side means the media path itself traverses TURN, so the
 * transport is reported as `p2p-turn`; otherwise it is `p2p-direct`.
 */
export function classifyCandidatePair(
  pair: CandidatePairLike | null | undefined,
): { readonly mode: TransportMode; readonly detail: string } | null {
  if (pair === null || pair === undefined) return null;
  const type = (candidate: { readonly type: string }): string =>
    candidate.type.length === 0 ? "unknown" : candidate.type;
  const local = type(pair.local);
  const remote = type(pair.remote);
  const mode = local === "relay" || remote === "relay" ? "p2p-turn" : "p2p-direct";
  return { mode, detail: `${local}->${remote}` };
}
