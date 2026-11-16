/**
 * Bounded P2P retry policy.
 *
 * F0 retries a P2P negotiation once per viewer after refreshing ICE servers.
 * A failure after the link was already `ready`, a viewer departure, or a
 * DataChannel send failure falls straight back to the relay.
 */

export const P2P_RETRY_DELAY_MS = 500;
export const MAX_CONCURRENT_P2P_RETRIES = 2;

export interface P2PRetryDecisionInput {
  /** A host-side link object exists for this viewer. */
  readonly hasLink: boolean;
  /** The link already announced `transport ready`. */
  readonly linkReady: boolean;
  /** `TOKIMEKI_P2P=auto`. */
  readonly p2pEnabled: boolean;
  readonly closing: boolean;
  /** A retry was already consumed for this viewer connection. */
  readonly alreadyUsed: boolean;
  /** Number of retries currently awaiting refresh/offer. */
  readonly inFlight: number;
}

/** True when the failure is eligible for the one-shot P2P retry. */
export function canRetryP2P(input: P2PRetryDecisionInput): boolean {
  return (
    input.hasLink &&
    !input.linkReady &&
    input.p2pEnabled &&
    !input.closing &&
    !input.alreadyUsed &&
    input.inFlight < MAX_CONCURRENT_P2P_RETRIES
  );
}
