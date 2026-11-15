import type { TransportMode } from "@limccn/tokimeki-protocol";

/**
 * Data-transport seam shared by the relay (Phase 3) and the future
 * P2P/TURN transports (Phase 4).
 *
 * Control-plane messages (hello/welcome/resize/...) always travel over the
 * relay WebSocket in v1; this interface only carries terminal frames.
 */
export type TransportKind = TransportMode;

export type TransportState = "selecting" | "ready" | "failed";

export interface Transport {
  readonly kind: TransportKind;
  readonly reliable: boolean;
  readonly ordered: boolean;
  readonly maxPayload: number;
  send(bytes: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onFrame(handler: (bytes: Uint8Array) => void): () => void;
  onState(handler: (state: TransportState, reason?: string) => void): () => void;
}
