import {
  type Capabilities,
  MAX_DATACHANNEL_MESSAGE_BYTES,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  type TunnelKeyMode,
} from "@limccn/tokimeki-protocol";

import { buildTunnelCapability } from "./tunnel/capability.js";

export interface DisplayCapabilityOptions {
  readonly modes: readonly string[];
  readonly fixed?: { readonly cols: number; readonly rows: number };
  readonly logPanel?: boolean;
  readonly terminalQueries?: "host";
}

export interface CapabilityOptions {
  /** Advertise the P2P transports this process can actually negotiate. */
  readonly p2p: boolean;
  readonly snapshotMaxBytes?: number;
  /** Advertise read-only listener support (relay-only, snapshot-only). */
  readonly listener?: boolean;
  /** Advertise the TUN profile only when `TOKIMEKI_TUNNEL=auto`. */
  readonly tunnelKeyMode?: TunnelKeyMode;
  /** Fixed-grid/viewport/log-panel rendering capabilities. */
  readonly display?: DisplayCapabilityOptions;
  /** v1.2: advertise PBKDF2 session-passcode support. */
  readonly sessionSecurity?: boolean;
}

/**
 * True when a peer advertised the exact v1.1 fragmentation dialect this build
 * can encode/decode. Unknown or mismatched values are treated as unsupported.
 */
export function supportsFragmentation(capabilities: Capabilities | undefined): boolean {
  const fragmentation = capabilities?.transports?.fragmentation;
  return (
    fragmentation?.version === 1 &&
    fragmentation.maxFrameBytes !== undefined &&
    fragmentation.maxFrameBytes >= MAX_FRAME_BYTES &&
    fragmentation.maxMessageBytes === MAX_DATACHANNEL_MESSAGE_BYTES
  );
}

/** True when a peer can render the fixed logical grid in a local viewport. */
export function supportsViewport(capabilities: Capabilities | undefined): boolean {
  return capabilities?.display?.modes?.includes("viewport") === true;
}

/** True when a host mirror advertised that it answers terminal queries. */
export function hostAnswersTerminalQueries(capabilities: Capabilities | undefined): boolean {
  return capabilities?.display?.terminalQueries === "host";
}

/** Capabilities advertised in `hello`. */
export function buildCapabilities(options: CapabilityOptions): Capabilities {
  // Listeners are relay-only by design: they never negotiate P2P, so they
  // advertise the relay transport and the snapshot-only listener mode.
  const p2p = options.p2p && options.listener !== true;
  const tunnelKeyMode = p2p ? options.tunnelKeyMode : undefined;
  return {
    protocolVersion: PROTOCOL_VERSION,
    transports: {
      modes: p2p ? ["relay", "p2p-direct", "p2p-turn"] : ["relay"],
      ...(p2p
        ? {
            fragmentation: {
              version: 1,
              maxFrameBytes: MAX_FRAME_BYTES,
              maxMessageBytes: MAX_DATACHANNEL_MESSAGE_BYTES,
            },
          }
        : {}),
    },
    snapshot: {
      formats: ["xterm-serialize", "raw-ring"],
      ...(options.snapshotMaxBytes === undefined ? {} : { maxBytes: options.snapshotMaxBytes }),
    },
    ...(options.display === undefined
      ? {}
      : {
          display: {
            ...options.display,
            modes: [...options.display.modes],
          },
        }),
    ...(tunnelKeyMode === undefined ? {} : { tunnel: buildTunnelCapability(tunnelKeyMode) }),
    ...(options.listener === true ? { listener: { modes: ["snapshot-only"] } } : {}),
    ...(options.sessionSecurity === true ? { sessionSecurity: { passcode: 1 } } : {}),
  };
}
