import { type Capabilities, PROTOCOL_VERSION } from "@limccn/tokimeki-protocol";

export interface CapabilityOptions {
  /** Advertise the P2P transports this process can actually negotiate. */
  readonly p2p: boolean;
  readonly snapshotMaxBytes?: number;
}

/** Capabilities advertised in `hello`. */
export function buildCapabilities(options: CapabilityOptions): Capabilities {
  return {
    protocolVersion: PROTOCOL_VERSION,
    transports: {
      modes: options.p2p ? ["relay", "p2p-direct", "p2p-turn"] : ["relay"],
    },
    snapshot: {
      formats: ["xterm-serialize", "raw-ring"],
      ...(options.snapshotMaxBytes === undefined ? {} : { maxBytes: options.snapshotMaxBytes }),
    },
  };
}
