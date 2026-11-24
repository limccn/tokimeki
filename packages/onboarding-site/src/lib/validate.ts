/**
 * Client-side validation for the no-JWT onboarding page.
 *
 * Values are only ever rendered with textContent/value or JSON.stringify; the
 * shell generators additionally require a conservative character set so a
 * user-supplied value cannot break out of a quoted assignment.
 */

export const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const WINDOW_PATTERN = /^[1-9]\d{0,3}x[1-9]\d{0,3}$/;
export const SAFE_VALUE_PATTERN = /^[A-Za-z0-9._~:/+=@,-]+$/;
export const SAFE_COMMAND_PATTERN = /^[A-Za-z0-9._-]+$/;
export const MIN_TOKEN_LENGTH = 32;

export class SiteError extends Error {
  override readonly name = "SiteError";
}

export function validateNamespace(value: string): void {
  if (!NAMESPACE_PATTERN.test(value)) {
    throw new SiteError("Namespace must match ^[a-z0-9][a-z0-9_-]{0,31}$");
  }
}

export function validateSession(value: string, namespace: string): void {
  if (!SESSION_PATTERN.test(value)) {
    throw new SiteError("Session must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
  }
  if (!value.startsWith(`${namespace}.`) || value.length === namespace.length + 1) {
    throw new SiteError(`Session must start with "${namespace}."`);
  }
}

export function validateToken(value: string, label: string): void {
  if (value.length < MIN_TOKEN_LENGTH) {
    throw new SiteError(`${label} must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  if (/\s/.test(value)) {
    throw new SiteError(`${label} must not contain whitespace`);
  }
  if (!SAFE_VALUE_PATTERN.test(value)) {
    throw new SiteError(`${label} contains characters that are unsafe in shell commands`);
  }
}

export function validateRelayUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SiteError("The relay URL is invalid");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new SiteError("The relay URL must not contain credentials");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new SiteError("The relay URL must not contain a query or fragment");
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new SiteError("The relay URL must not contain a path");
  }
  const loopback =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if (parsed.protocol !== "wss:" && !(parsed.protocol === "ws:" && loopback)) {
    throw new SiteError("The relay URL must use wss:// (ws:// is loopback-only)");
  }
  if (!SAFE_VALUE_PATTERN.test(value)) {
    throw new SiteError("The relay URL contains characters that are unsafe in shell commands");
  }
}

export function validateWindow(value: string): void {
  if (value.length === 0) return;
  if (!WINDOW_PATTERN.test(value)) {
    throw new SiteError("Window size must be <cols>x<rows> with positive integers");
  }
}

export function validateCustomCommand(value: string): void {
  if (!SAFE_COMMAND_PATTERN.test(value)) {
    throw new SiteError("Custom command must match ^[A-Za-z0-9._-]+$ (no shell characters)");
  }
}

export function maskToken(value: string): string {
  if (value.length <= 8) return "*".repeat(Math.max(4, value.length));
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
