/**
 * Fixed-grid live-resize gate (v1.8).
 *
 * Applying a new PTY size to a fixed window is only safe when the relay stores
 * the new grid (`display-size`) and every connected viewer/listener can rebuild
 * its mirror from that message. An old client that only learned the grid from
 * `welcome` would otherwise keep rendering the previous size. A late-joining
 * old client is safe because the relay's welcome already carries the new size;
 * the gate only protects clients that are connected during the change.
 */

export type DisplayResizeGate =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface DisplayResizeClient {
  readonly clientId: string;
  /** True only when the client advertised `capabilities.display.resize === 1`. */
  readonly supported: boolean;
}

export interface DisplayResizeGateInput {
  readonly fixedGeometryEnabled: boolean;
  /** True while the relay WebSocket is connected and past welcome. */
  readonly relayReady: boolean;
  /** True when the relay welcome advertised `capabilities.display.resize === 1`. */
  readonly relaySupported: boolean;
  /** Every connected viewer and listener (observers/agents are excluded). */
  readonly clients: Iterable<DisplayResizeClient>;
}

/** Decide whether a fixed-grid live resize may be applied right now. */
export function resolveDisplayResizeGate(input: DisplayResizeGateInput): DisplayResizeGate {
  if (!input.fixedGeometryEnabled) {
    return { ok: false, reason: "fixed geometry is disabled" };
  }
  if (!input.relayReady) {
    return { ok: false, reason: "relay connection is not ready" };
  }
  if (!input.relaySupported) {
    return { ok: false, reason: "relay does not support display-size; upgrade the relay" };
  }
  for (const client of input.clients) {
    if (!client.supported) {
      return {
        ok: false,
        reason: `client ${client.clientId} does not advertise display.resize; upgrade that client`,
      };
    }
  }
  return { ok: true };
}
