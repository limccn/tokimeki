import {
  type Capabilities,
  MAX_DATACHANNEL_MESSAGE_BYTES,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
} from "@limccn/tokimeki-protocol";

export interface CapabilityOptions {
  /** Advertise the P2P transports this process can actually negotiate. */
  readonly p2p: boolean;
  readonly snapshotMaxBytes?: number;
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

/** Capabilities advertised in `hello`. */
export function buildCapabilities(options: CapabilityOptions): Capabilities {
  return {
    protocolVersion: PROTOCOL_VERSION,
    transports: {
      modes: options.p2p ? ["relay", "p2p-direct", "p2p-turn"] : ["relay"],
      ...(options.p2p
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
  };
}
