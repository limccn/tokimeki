const textEncoder = new TextEncoder();

/** SHA-256 as raw bytes. */
export async function sha256Bytes(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return new Uint8Array(digest);
}

/** SHA-256 as lowercase hexadecimal (used for stored token hashes). */
export async function sha256Hex(value: string): Promise<string> {
  const bytes = await sha256Bytes(value);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Constant-time comparison of two opaque strings.
 *
 * Both inputs are hashed first so the comparison is independent of the input
 * length as well as the content.
 */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([sha256Bytes(a), sha256Bytes(b)]);
  return crypto.subtle.timingSafeEqual(left, right);
}

/** Constant-time comparison for two non-empty SHA-256 hex digests. */
export async function constantTimeEqualHex(left: string, right: string): Promise<boolean> {
  if (left.length === 0 || right.length === 0) {
    return false;
  }
  return constantTimeEqual(left, right);
}

/** Base64 encode a small byte array (HMAC digests, never terminal payloads). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Base64url encode a small byte array (PBKDF2 verifier material). */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

/** Strict base64url decode; `null` on malformed input. */
export function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    return null;
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4)) % 4;
  try {
    const binary = atob(padded + "=".repeat(padLength));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

/**
 * TURN REST credential: `base64(HMAC-SHA1(secret, message))`.
 *
 * Used by coturn `use-auth-secret` / `static-auth-secret`. The secret never
 * leaves the Worker.
 */
export async function hmacSha1Base64(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(message));
  return bytesToBase64(new Uint8Array(signature));
}
