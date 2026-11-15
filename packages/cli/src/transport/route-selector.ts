import type { P2PMode } from "../config.js";
import type { Logger } from "../logger.js";
import type { Transport } from "./types.js";

export interface RouteSelectorOptions {
  readonly p2p: P2PMode;
  readonly logger: Logger;
  /** The relay WebSocket is always the control plane and fallback data path. */
  readonly createRelayTransport: () => Transport;
}

/**
 * Selects the base transport used for frames received over the relay.
 *
 * P2P is negotiated separately per viewer by the host and per host by a
 * viewer; this selector only decides whether that negotiation is attempted at
 * all (`TOKIMEKI_P2P`). The relay transport remains available for snapshots,
 * control messages, and fallback.
 */
export class RouteSelector {
  readonly #options: RouteSelectorOptions;

  constructor(options: RouteSelectorOptions) {
    this.#options = options;
  }

  async select(): Promise<Transport> {
    if (this.#options.p2p === "auto") {
      this.#options.logger.debug("route selector: relay fallback ready; P2P negotiation enabled");
    } else {
      this.#options.logger.debug("route selector: P2P disabled; using relay");
    }
    return this.#options.createRelayTransport();
  }
}
