/**
 * TUN profile cryptography: HKDF direction keys and AES-256-GCM records.
 *
 * Two key modes are supported:
 * - `session-token` (default): the relay has seen the session token, so this
 *   mode is transport hardening only and MUST NOT be described as relay-blind.
 * - `shared-secret`: `TOKIMEKI_TUNNEL_SECRET` is shared out of band; the relay
 *   never receives it.
 *
 * Neither keys, nonces, plaintext, nor ciphertext are ever logged here.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

import {
  decodeTunnelRecord,
  encodeTunnelAad,
  encodeTunnelRecord,
  MIN_TUNNEL_SECRET_BYTES,
  TUNNEL_DIRECTIONS,
  TUNNEL_HKDF_LABELS,
  TUNNEL_KEY_BYTES,
  TUNNEL_MAX_FRAME_BYTES,
  TUNNEL_NONCE_BYTES,
  TUNNEL_TAG_BYTES,
  type TunnelDirectionName,
  type TunnelKeyMode,
  type TunnelRecordHeader,
  type TunnelRecordType,
} from "@limccn/tokimeki-protocol";

export type TunnelCryptoFailure =
  | "invalid_secret"
  | "invalid_session_token"
  | "invalid_plaintext"
  | "invalid_key";

/** Configuration/crypto error with a reason that is safe to log. */
export class TunnelCryptoError extends Error {
  override readonly name = "TunnelCryptoError";

  constructor(
    readonly reason: TunnelCryptoFailure,
    message: string,
  ) {
    super(message);
  }
}

export interface TunnelKeyPair {
  readonly hostToViewer: Uint8Array;
  readonly viewerToHost: Uint8Array;
}

export interface DeriveTunnelKeysOptions {
  readonly keyMode: TunnelKeyMode;
  readonly sessionId: string;
  readonly sessionToken: string;
  /** Required when `keyMode` is `shared-secret`. */
  readonly secret?: string | null;
}

function hkdfExtract(salt: string, ikm: string): Buffer {
  return createHmac("sha256", Buffer.from(salt, "utf8")).update(Buffer.from(ikm, "utf8")).digest();
}

function hkdfExpand(prk: Uint8Array, info: string, length: number): Buffer {
  let output = Buffer.alloc(0);
  let previous = Buffer.alloc(0);
  for (let counter = 1; output.byteLength < length && counter <= 255; counter += 1) {
    previous = createHmac("sha256", prk)
      .update(previous)
      .update(Buffer.from(info, "utf8"))
      .update(Buffer.of(counter))
      .digest();
    output = Buffer.concat([output, previous]);
  }
  return output.subarray(0, length);
}

/**
 * Derive direction-separated tunnel keys.
 *
 * Wire contract (see `docs/protocol.md`):
 *
 * ```text
 * prk = HKDF-Extract(salt = UTF-8(sessionId), ikm)
 * h2v = HKDF-Expand(prk, "tokimeki-tunnel-v1/host-to-viewer", 32)
 * v2h = HKDF-Expand(prk, "tokimeki-tunnel-v1/viewer-to-host", 32)
 * ```
 */
export function deriveTunnelKeys(options: DeriveTunnelKeysOptions): TunnelKeyPair {
  let keyMaterial: string;
  if (options.keyMode === "shared-secret") {
    if (
      typeof options.secret !== "string" ||
      Buffer.byteLength(options.secret, "utf8") < MIN_TUNNEL_SECRET_BYTES
    ) {
      throw new TunnelCryptoError(
        "invalid_secret",
        `TOKIMEKI_TUNNEL_SECRET must be at least ${MIN_TUNNEL_SECRET_BYTES} bytes`,
      );
    }
    keyMaterial = options.secret;
  } else {
    if (options.sessionToken.length === 0) {
      throw new TunnelCryptoError("invalid_session_token", "session token is required");
    }
    keyMaterial = options.sessionToken;
  }

  const prk = hkdfExtract(options.sessionId, keyMaterial);
  return {
    hostToViewer: hkdfExpand(prk, TUNNEL_HKDF_LABELS.hostToViewer, TUNNEL_KEY_BYTES),
    viewerToHost: hkdfExpand(prk, TUNNEL_HKDF_LABELS.viewerToHost, TUNNEL_KEY_BYTES),
  };
}

export interface TunnelCipherOptions {
  readonly keys: TunnelKeyPair;
  /** Direction this endpoint sends in. It opens records in the other direction. */
  readonly sendDirection: TunnelDirectionName;
  readonly sessionId: string;
  /** Test seam: deterministic 96-bit nonce generator. */
  readonly nonceSource?: (size: number) => Uint8Array;
}

export interface TunnelSealInput {
  readonly type: TunnelRecordType;
  readonly flags?: number;
  readonly seq: number;
  readonly ackSeq?: number;
  readonly ackBits?: number;
  readonly plaintext: Uint8Array;
}

export interface OpenedTunnelRecord {
  readonly header: TunnelRecordHeader;
  readonly plaintext: Uint8Array;
}

function oppositeDirection(direction: TunnelDirectionName): TunnelDirectionName {
  return direction === "hostToViewer" ? "viewerToHost" : "hostToViewer";
}

/**
 * AEAD record cipher for one direction.
 *
 * `open` never throws for malformed or unauthenticated records; it returns
 * `null` so the transport can drop and count the record without leaking why.
 */
export class TunnelCipher {
  readonly #sendKey: Uint8Array;
  readonly #receiveKey: Uint8Array;
  readonly #sendDirection: TunnelDirectionName;
  readonly #receiveDirection: TunnelDirectionName;
  readonly #sessionId: string;
  readonly #nonceSource: (size: number) => Uint8Array;

  constructor(options: TunnelCipherOptions) {
    if (
      options.keys.hostToViewer.byteLength !== TUNNEL_KEY_BYTES ||
      options.keys.viewerToHost.byteLength !== TUNNEL_KEY_BYTES
    ) {
      throw new TunnelCryptoError("invalid_key", "tunnel keys must be 32 bytes each");
    }
    this.#sendDirection = options.sendDirection;
    this.#receiveDirection = oppositeDirection(options.sendDirection);
    this.#sendKey =
      options.sendDirection === "hostToViewer"
        ? options.keys.hostToViewer
        : options.keys.viewerToHost;
    this.#receiveKey =
      options.sendDirection === "hostToViewer"
        ? options.keys.viewerToHost
        : options.keys.hostToViewer;
    this.#sessionId = options.sessionId;
    this.#nonceSource = options.nonceSource ?? ((size) => new Uint8Array(randomBytes(size)));
  }

  /** Encrypt one record. Throws only for local programming errors. */
  seal(input: TunnelSealInput): Uint8Array {
    if (!(input.plaintext instanceof Uint8Array)) {
      throw new TunnelCryptoError("invalid_plaintext", "tunnel plaintext must be a Uint8Array");
    }
    if (input.plaintext.byteLength > TUNNEL_MAX_FRAME_BYTES) {
      throw new TunnelCryptoError(
        "invalid_plaintext",
        `tunnel plaintext exceeds ${TUNNEL_MAX_FRAME_BYTES} bytes`,
      );
    }
    const nonce = this.#nonceSource(TUNNEL_NONCE_BYTES);
    if (!(nonce instanceof Uint8Array) || nonce.byteLength !== TUNNEL_NONCE_BYTES) {
      throw new TunnelCryptoError("invalid_plaintext", "nonce source returned an invalid nonce");
    }
    const header: TunnelRecordHeader = {
      version: 1,
      type: input.type,
      flags: input.flags ?? 0,
      seq: input.seq,
      ackSeq: input.ackSeq ?? 0,
      ackBits: input.ackBits ?? 0,
      nonce,
    };
    const aad = encodeTunnelAad(header, TUNNEL_DIRECTIONS[this.#sendDirection], this.#sessionId);
    const cipher = createCipheriv("aes-256-gcm", this.#sendKey, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([
      cipher.update(input.plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return encodeTunnelRecord(header, ciphertext);
  }

  /** Authenticate and decrypt one record, or return null. */
  open(record: Uint8Array): OpenedTunnelRecord | null {
    let header: TunnelRecordHeader;
    let ciphertext: Uint8Array;
    try {
      const decoded = decodeTunnelRecord(record);
      header = decoded.header;
      ciphertext = decoded.ciphertext;
    } catch {
      return null;
    }
    try {
      const aad = encodeTunnelAad(
        header,
        TUNNEL_DIRECTIONS[this.#receiveDirection],
        this.#sessionId,
      );
      const tagOffset = ciphertext.byteLength - TUNNEL_TAG_BYTES;
      const decipher = createDecipheriv("aes-256-gcm", this.#receiveKey, header.nonce);
      decipher.setAAD(aad);
      decipher.setAuthTag(ciphertext.subarray(tagOffset));
      const plaintext = Buffer.concat([
        decipher.update(ciphertext.subarray(0, tagOffset)),
        decipher.final(),
      ]);
      return { header, plaintext: new Uint8Array(plaintext) };
    } catch {
      return null;
    }
  }
}
