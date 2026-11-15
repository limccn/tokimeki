import { MAX_FRAME_BYTES } from "@limccn/tokimeki-protocol";

import type { RelayClient } from "./relay-client.js";
import type { Transport, TransportState } from "./types.js";

/**
 * `Transport` view over the relay WebSocket.
 *
 * Phase 4 will implement additional transports (WebRTC DataChannel direct and
 * TURN) behind the same interface; the host/attach sessions only depend on
 * this seam for terminal frames.
 */
export class RelayTransport implements Transport {
  readonly kind = "relay" as const;
  readonly reliable = true;
  readonly ordered = true;
  readonly maxPayload = MAX_FRAME_BYTES;

  readonly #client: RelayClient;

  constructor(client: RelayClient) {
    this.#client = client;
  }

  send(bytes: Uint8Array): void {
    this.#client.sendFrame(bytes);
  }

  close(code?: number, reason?: string): void {
    this.#client.stop(code, reason);
  }

  onFrame(handler: (bytes: Uint8Array) => void): () => void {
    return this.#client.onFrame(handler);
  }

  onState(handler: (state: TransportState, reason?: string) => void): () => void {
    return this.#client.onState((state) => {
      switch (state) {
        case "ready":
          handler("ready");
          break;
        case "failed":
          handler("failed");
          break;
        default:
          handler("selecting");
      }
    });
  }
}
