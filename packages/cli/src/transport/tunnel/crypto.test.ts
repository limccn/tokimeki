import { describe, expect, it } from "vitest";

import { deriveTunnelKeys, TunnelCipher, TunnelCryptoError } from "./crypto.js";

const SESSION_ID = "demo-session";
const SESSION_TOKEN = "session-token-1234";
const SHARED_SECRET = "0123456789abcdef";

function counterNonce(start: number): (size: number) => Uint8Array {
  let counter = start;
  return (size) => {
    const nonce = new Uint8Array(size);
    nonce[0] = counter & 0xff;
    nonce[1] = (counter >>> 8) & 0xff;
    counter += 1;
    return nonce;
  };
}

function pair(options: { keyMode?: "session-token" | "shared-secret"; secret?: string } = {}): {
  host: TunnelCipher;
  viewer: TunnelCipher;
  keys: ReturnType<typeof deriveTunnelKeys>;
} {
  const keyMode = options.keyMode ?? "session-token";
  const keys = deriveTunnelKeys({
    keyMode,
    sessionId: SESSION_ID,
    sessionToken: SESSION_TOKEN,
    secret: options.secret ?? (keyMode === "shared-secret" ? SHARED_SECRET : null),
  });
  return {
    keys,
    host: new TunnelCipher({
      keys,
      sendDirection: "hostToViewer",
      sessionId: SESSION_ID,
      nonceSource: counterNonce(1),
    }),
    viewer: new TunnelCipher({
      keys,
      sendDirection: "viewerToHost",
      sessionId: SESSION_ID,
      nonceSource: counterNonce(100),
    }),
  };
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

describe("deriveTunnelKeys", () => {
  it("matches the fixed session-token vectors and separates directions", () => {
    const keys = deriveTunnelKeys({
      keyMode: "session-token",
      sessionId: SESSION_ID,
      sessionToken: SESSION_TOKEN,
    });
    expect(hex(keys.hostToViewer)).toBe(
      "c5c6f6bc12e53336528de6675bd641dbcf212e7f7102ebe479787c56ff4a6214",
    );
    expect(hex(keys.viewerToHost)).toBe(
      "6b5f8635075e40cacc97bab39cd404ce9b399486dd38edc2d8526f6160817aa7",
    );
    expect(hex(keys.hostToViewer)).not.toBe(hex(keys.viewerToHost));
  });

  it("matches the fixed shared-secret vectors", () => {
    const keys = deriveTunnelKeys({
      keyMode: "shared-secret",
      sessionId: SESSION_ID,
      sessionToken: SESSION_TOKEN,
      secret: SHARED_SECRET,
    });
    expect(hex(keys.hostToViewer)).toBe(
      "5e012a63defedda13f239190539d8b8f6bff4a3a1b73a13823695e37e788b47d",
    );
    expect(hex(keys.viewerToHost)).toBe(
      "ed27aa9a874a5d074f24eb2a2a70a81811e139b4174600d6cde90cd446fb9c2e",
    );
  });

  it("rejects short shared secrets without echoing their value", () => {
    try {
      deriveTunnelKeys({
        keyMode: "shared-secret",
        sessionId: SESSION_ID,
        sessionToken: SESSION_TOKEN,
        secret: "short-secret",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(TunnelCryptoError);
      expect((error as TunnelCryptoError).reason).toBe("invalid_secret");
      expect((error as Error).message).not.toContain("short-secret");
      return;
    }
    throw new Error("expected TunnelCryptoError");
  });
});

describe("TunnelCipher", () => {
  it("roundtrips host -> viewer and viewer -> host records", () => {
    const { host, viewer } = pair();
    const h2v = host.seal({
      type: "data",
      seq: 42,
      ackSeq: 7,
      ackBits: 3,
      plaintext: new TextEncoder().encode("hello-tunnel"),
    });
    const openedByViewer = viewer.open(h2v);
    expect(openedByViewer?.header.seq).toBe(42);
    expect(openedByViewer?.header.ackSeq).toBe(7);
    expect(openedByViewer?.header.ackBits).toBe(3);
    expect(new TextDecoder().decode(openedByViewer?.plaintext)).toBe("hello-tunnel");

    const v2h = viewer.seal({
      type: "data",
      seq: 0,
      plaintext: new TextEncoder().encode("input"),
    });
    const openedByHost = host.open(v2h);
    expect(new TextDecoder().decode(openedByHost?.plaintext)).toBe("input");
  });

  it("rejects its own record reflected in the wrong direction", () => {
    const { host } = pair();
    const record = host.seal({ type: "data", seq: 0, plaintext: new Uint8Array([1, 2, 3]) });
    expect(host.open(record)).toBeNull();
  });

  it("rejects tampered header fields, ciphertext, and nonce", () => {
    const { host, viewer } = pair();
    const record = host.seal({ type: "data", seq: 5, plaintext: new Uint8Array([0x41]) });
    const mutations = [
      (copy: Uint8Array) => {
        copy[0] = 2; // version
      },
      (copy: Uint8Array) => {
        copy[1] = 2; // type ack
      },
      (copy: Uint8Array) => {
        copy[2] = 1; // flags
      },
      (copy: Uint8Array) => {
        copy[7] = 0x99; // seq
      },
      (copy: Uint8Array) => {
        copy[11] = 0x99; // ackSeq
      },
      (copy: Uint8Array) => {
        copy[15] = 0x99; // ackBits
      },
      (copy: Uint8Array) => {
        copy[16] = 0x99; // nonce
      },
      (copy: Uint8Array) => {
        copy[28] = (copy[28] ?? 0) ^ 0xff; // ciphertext
      },
    ];
    for (const mutate of mutations) {
      const copy = record.slice();
      mutate(copy);
      expect(viewer.open(copy)).toBeNull();
    }
    expect(viewer.open(record)).not.toBeNull();
  });

  it("binds the session id and direction into the AAD", () => {
    const { host, viewer, keys } = pair();
    const record = host.seal({ type: "data", seq: 1, plaintext: new Uint8Array([0x41]) });
    const otherSession = new TunnelCipher({
      keys,
      sendDirection: "viewerToHost",
      sessionId: "other-session",
    });
    expect(otherSession.open(record)).toBeNull();
    expect(viewer.open(record)).not.toBeNull();
  });

  it("uses a fresh nonce per record", () => {
    const { host } = pair();
    const first = host.seal({ type: "data", seq: 0, plaintext: new Uint8Array([1]) });
    const second = host.seal({ type: "data", seq: 1, plaintext: new Uint8Array([1]) });
    expect(hex(first.slice(16, 28))).not.toBe(hex(second.slice(16, 28)));
  });

  it("rejects oversized plaintext locally", () => {
    const { host } = pair();
    expect(() =>
      host.seal({
        type: "data",
        seq: 0,
        plaintext: new Uint8Array(16_340),
      }),
    ).toThrow(TunnelCryptoError);
  });

  it("returns null for malformed records without throwing", () => {
    const { viewer } = pair();
    expect(viewer.open(new Uint8Array(10))).toBeNull();
    expect(viewer.open(Uint8Array.of(1, 1, 0, 0))).toBeNull();
  });
});
