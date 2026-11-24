/**
 * TokiAPI share-url parsing for `tokimeki attach <url>` (v1.4-H2).
 *
 * The URL is treated as a capability secret: errors never echo the raw URL,
 * fragment, or code. Bare codes are handled by the attach wizard, not here.
 */

import { ConfigError } from "../config.js";

export const INVITE_CODE_PATTERN = /^[A-Za-z0-9._~-]{1,64}$/;

export interface ParsedAttachUrl {
  readonly origin: string;
  readonly code: string;
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function isInviteCode(value: string): boolean {
  return INVITE_CODE_PATTERN.test(value);
}

/**
 * Parse `<https-origin>/#t-<code>` (or `#t-<code>` on a bare origin).
 *
 * `http:` is accepted only for `localhost`/`127.0.0.1`/`::1` so local e2e and
 * development do not require TLS; every other scheme/host is rejected.
 */
export function parseAttachUrl(raw: string): ParsedAttachUrl {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) {
    throw new ConfigError("the share URL is empty or too long");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ConfigError("the share URL is not a valid URL");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new ConfigError("the share URL must not contain credentials");
  }
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname))
  ) {
    throw new ConfigError("the share URL must use https (http is loopback-only)");
  }
  const hash = parsed.hash;
  if (!hash.startsWith("#t-")) {
    throw new ConfigError("the share URL fragment must be #t-<code>");
  }
  const code = hash.slice(3);
  if (!isInviteCode(code)) {
    throw new ConfigError("the share URL invite code is invalid");
  }
  return { origin: `${parsed.protocol}//${parsed.host}`, code };
}
