/**
 * Bounded HTTP body readers for small JSON probes.
 *
 * Relay/doctor/whoami responses are untrusted enough that a fast sender must
 * not be able to make the CLI buffer an unbounded body. The caller supplies a
 * byte cap and gets a plain error when it is exceeded.
 */

export const DEFAULT_MAX_JSON_BODY_BYTES = 64 * 1024;

export async function readBodyCapped(
  response: Response,
  maxBytes = DEFAULT_MAX_JSON_BODY_BYTES,
): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // best effort
      }
      throw new Error("response body is too large");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export async function readJsonObjectCapped(
  response: Response,
  maxBytes = DEFAULT_MAX_JSON_BODY_BYTES,
): Promise<Record<string, unknown> | null> {
  const text = await readBodyCapped(response, maxBytes);
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // invalid JSON is treated as no body
  }
  return null;
}
