/**
 * High-entropy token generation (browser WebCrypto).
 *
 * The default is 32 random bytes encoded as base64url, matching the CLI's
 * session-token generator; the older 6-8 digit style is deliberately not
 * offered.
 */

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(bytes = 32): string {
  if (bytes < 16 || bytes > 64) {
    throw new Error("token entropy must be between 16 and 64 bytes");
  }
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return bytesToBase64Url(buffer);
}

export function randomSlug(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const cleaned = bytesToBase64Url(bytes).replace(/[-_]/g, "").slice(0, 8).toLowerCase();
  if (cleaned.length > 0) return cleaned;
  // Astronomically unlikely fallback: all base64url characters were removed.
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 8);
}
