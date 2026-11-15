/** Connection lifecycle exposed by `RelayClient`. */
export type RelayConnectionState = "connecting" | "ready" | "reconnecting" | "failed" | "closed";

/** Non-retryable relay failure (authentication, session policy, host exit). */
export interface RelayFatalError {
  readonly code: string;
  readonly message: string;
}
