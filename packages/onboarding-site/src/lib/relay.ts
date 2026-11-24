/** Relay URL and secure-context helpers for the same-origin onboarding page. */

export interface LocationLike {
  readonly protocol: string;
  readonly host: string;
  readonly hostname: string;
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * The page is relay-bound: the relay is always its own origin.
 * HTTPS pages get wss; plain HTTP is accepted only on loopback.
 */
export function relayUrlForLocation(location: LocationLike): string {
  if (location.protocol === "https:") return `wss://${location.host}`;
  if (location.protocol === "http:" && isLoopbackHostname(location.hostname)) {
    return `ws://${location.host}`;
  }
  throw new Error("This page must be served over HTTPS");
}

/** Credential entry is allowed only in a secure context or on loopback. */
export function isSecureEntry(location: LocationLike, isSecureContext: boolean): boolean {
  return isSecureContext || isLoopbackHostname(location.hostname);
}
