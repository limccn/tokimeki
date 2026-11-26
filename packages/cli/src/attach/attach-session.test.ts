import { EventEmitter } from "node:events";

import {
  encodeFrame,
  type KnownControlMessage,
  PROTOCOL_VERSION,
  type WelcomeMessage,
} from "@limccn/tokimeki-protocol";
import { describe, expect, it } from "vitest";

import type { AttachConfig } from "../config.js";
import { Logger } from "../logger.js";
import type { RelayClient, RelayClientOptions } from "../transport/relay-client.js";
import type { RelayConnectionState, RelayFatalError } from "../transport/relay-types.js";
import type { Transport } from "../transport/types.js";

import { runAttachSession } from "./attach-session.js";

class FakeInput extends EventEmitter {
  isTTY = true;
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
}

class FakeOutput extends EventEmitter {
  isTTY = true;
  columns = 80;
  rows = 24;
  text = "";

  write(chunk: string | Uint8Array): boolean {
    this.text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }
}

type WelcomeHandler = (welcome: WelcomeMessage) => void;
type MessageHandler = (message: KnownControlMessage) => void;
type StateHandler = (state: RelayConnectionState) => void;
type FatalHandler = (error: RelayFatalError) => void;

/** Minimal RelayClient surface used by AttachSession. */
class FakeRelayClient {
  readonly options: RelayClientOptions;
  readonly controls: unknown[] = [];
  started = false;
  stopped = false;
  readonly #welcome = new Set<WelcomeHandler>();
  readonly #message = new Set<MessageHandler>();
  readonly #state = new Set<StateHandler>();
  readonly #fatal = new Set<FatalHandler>();

  constructor(options: RelayClientOptions) {
    this.options = options;
  }

  get isReady(): boolean {
    return this.started;
  }

  get bufferedAmount(): number {
    return 0;
  }

  get state(): RelayConnectionState {
    return this.started ? "ready" : "connecting";
  }

  onWelcome(handler: WelcomeHandler): () => void {
    this.#welcome.add(handler);
    return () => this.#welcome.delete(handler);
  }

  onMessage(handler: MessageHandler): () => void {
    this.#message.add(handler);
    return () => this.#message.delete(handler);
  }

  onState(handler: StateHandler): () => void {
    this.#state.add(handler);
    return () => this.#state.delete(handler);
  }

  onFatal(handler: FatalHandler): () => void {
    this.#fatal.add(handler);
    return () => this.#fatal.delete(handler);
  }

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
  }

  sendControl(message: unknown): void {
    this.controls.push(message);
  }

  sendFrame(): void {}

  pauseReading(): void {}

  resumeReading(): void {}

  emitWelcome(welcome: WelcomeMessage): void {
    for (const handler of this.#welcome) handler(welcome);
  }

  emitMessage(message: KnownControlMessage): void {
    for (const handler of this.#message) handler(message);
  }

  emitFatal(error: RelayFatalError): void {
    for (const handler of this.#fatal) handler(error);
  }
}

class FakeTransport implements Transport {
  readonly kind = "relay" as const;
  readonly reliable = true;
  readonly ordered = true;
  readonly maxPayload = 16_384;
  readonly sent: Uint8Array[] = [];
  #frame: ((bytes: Uint8Array) => void) | null = null;

  send(bytes: Uint8Array): void {
    this.sent.push(bytes);
  }

  close(): void {}

  onFrame(handler: (bytes: Uint8Array) => void): () => void {
    this.#frame = handler;
    return () => {
      if (this.#frame === handler) this.#frame = null;
    };
  }

  onState(): () => void {
    return () => {};
  }

  emitFrame(bytes: Uint8Array): void {
    this.#frame?.(bytes);
  }
}

function attachConfig(
  role: AttachConfig["role"],
  overrides: Partial<AttachConfig> = {},
): AttachConfig {
  return {
    relayUrl: "wss://relay.example",
    websocketUrl: "wss://relay.example/ws/sess-1",
    session: "sess-1",
    heartbeatSeconds: 0,
    p2p: "auto",
    iceTransportPolicy: "all",
    tunnel: "off",
    tunnelFec: "off",
    tunnelKeyMode: "session-token",
    tunnelSecret: null,
    passcode: null,
    logLevel: "silent",
    windowMode: "tui",
    warnings: [],
    secrets: [],
    role,
    sessionToken: "session-token-9876",
    inviteKey: "f12",
    logViewRows: 8,
    ...overrides,
  };
}

function welcomeMessage(): WelcomeMessage {
  return {
    v: PROTOCOL_VERSION,
    type: "welcome",
    session: "sess-1",
    protocolVersion: PROTOCOL_VERSION,
    hostOnline: true,
    clients: [],
    iceServers: [],
    iceProvider: "stun",
    transportPolicy: "all",
    sessionTtlSeconds: 3600,
  };
}

function fixedGridWelcome(cols = 120, rows = 40): WelcomeMessage {
  const welcome = welcomeMessage();
  welcome.clients = [
    {
      clientId: "host-1",
      role: "host",
      capabilities: {
        display: {
          modes: ["fixed-grid", "viewport"],
          fixed: { cols, rows },
          terminalQueries: "host",
        },
      },
    },
  ];
  return welcome;
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function makeSession(
  role: AttachConfig["role"],
  overrides: Partial<AttachConfig> = {},
  tty: { stdin?: boolean; stdout?: boolean } = {},
): {
  client: FakeRelayClient;
  transport: FakeTransport;
  stdin: FakeInput;
  stdout: FakeOutput;
  done: Promise<number>;
} {
  const client = new FakeRelayClient({} as RelayClientOptions);
  const transport = new FakeTransport();
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  if (tty.stdin === false) stdin.isTTY = false;
  if (tty.stdout === false) stdout.isTTY = false;
  const logger = new Logger({ level: "silent", write: () => {} });
  const done = runAttachSession(attachConfig(role, overrides), {
    logger,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    // The fakes only implement the RelayClient/Transport methods used by
    // AttachSession; the casts are confined to this test.
    createClient: (options) => {
      Object.assign(client, { options });
      return client as unknown as RelayClient;
    },
    selectTransport: async () => transport,
  });
  return { client, transport, stdin, stdout, done };
}

describe("attach fixed viewport", () => {
  it("discovers the host fixed geometry and renders through the mirror", async () => {
    const { client, transport, stdout, done } = makeSession("viewer");
    await waitFor(() => client.options.role !== undefined && client.started);

    const welcome = welcomeMessage();
    welcome.clients = [
      {
        clientId: "host-1",
        role: "host",
        capabilities: {
          display: {
            modes: ["fixed-grid", "viewport"],
            fixed: { cols: 120, rows: 40 },
            terminalQueries: "host",
          },
        },
      },
    ];
    client.emitWelcome(welcome);
    const targetId = client.options.clientId;
    transport.emitFrame(
      encodeFrame({
        type: "snapshot_to",
        targetId,
        seq: 4,
        payload: new TextEncoder().encode("viewport screen"),
      }),
    );

    await waitFor(() => stdout.text.includes("viewport screen"));
    expect(stdout.text).toContain("tokimeki");
    expect(stdout.text).toContain("viewer");
    expect(stdout.text).toContain("view:");

    client.emitMessage({ v: PROTOCOL_VERSION, type: "host-exited", exitCode: 0 });
    await expect(done).resolves.toBe(0);
  });

  it("switches to the viewport when the host appears after attach", async () => {
    const { client, transport, stdout, done } = makeSession("viewer");
    await waitFor(() => client.options.role !== undefined && client.started);

    client.emitWelcome(welcomeMessage());
    client.emitMessage({
      v: PROTOCOL_VERSION,
      type: "presence",
      clients: [
        {
          clientId: "host-1",
          role: "host",
          capabilities: {
            display: {
              modes: ["fixed-grid", "viewport"],
              fixed: { cols: 120, rows: 40 },
              terminalQueries: "host",
            },
          },
        },
      ],
    });

    const targetId = client.options.clientId;
    transport.emitFrame(
      encodeFrame({
        type: "snapshot_to",
        targetId,
        seq: 5,
        payload: new TextEncoder().encode("late host screen"),
      }),
    );
    await waitFor(() => stdout.text.includes("late host screen"));
    expect(stdout.text).toContain("view:");

    client.emitMessage({ v: PROTOCOL_VERSION, type: "host-exited", exitCode: 0 });
    await expect(done).resolves.toBe(0);
  });

  it("falls back to legacy rendering when the host has no fixed metadata", async () => {
    const { client, transport, stdout, done } = makeSession("viewer");
    await waitFor(() => client.options.role !== undefined && client.started);

    client.emitWelcome(welcomeMessage());
    const targetId = client.options.clientId;
    transport.emitFrame(
      encodeFrame({
        type: "snapshot_to",
        targetId,
        seq: 1,
        payload: new TextEncoder().encode("legacy screen"),
      }),
    );

    await waitFor(() => stdout.text.includes("legacy screen"));
    expect(stdout.text).not.toContain("tokimeki  viewer");

    client.emitMessage({ v: PROTOCOL_VERSION, type: "host-exited", exitCode: 0 });
    await expect(done).resolves.toBe(0);
  });
});

describe("attach fixed-grid live resize", () => {
  it("advertises display.resize and drops output until the new-grid snapshot", async () => {
    const { client, transport, stdout, done } = makeSession("viewer");
    await waitFor(() => client.options.role !== undefined && client.started);
    expect(client.options.capabilities.display?.resize).toBe(1);

    client.emitWelcome(fixedGridWelcome());
    const targetId = client.options.clientId;
    transport.emitFrame(
      encodeFrame({
        type: "snapshot_to",
        targetId,
        seq: 4,
        payload: new TextEncoder().encode("initial screen"),
      }),
    );
    await waitFor(() => stdout.text.includes("initial screen"));

    client.emitMessage({ v: PROTOCOL_VERSION, type: "display-size", cols: 132, rows: 43 });
    transport.emitFrame(
      encodeFrame({
        type: "output",
        seq: 5,
        payload: new TextEncoder().encode("old-grid-bytes"),
      }),
    );
    // The viewer keeps ACKing relay bytes (flow control) but must not paint
    // them into the rebuilt mirror.
    await waitFor(() =>
      client.controls.some((control) => {
        const message = control as { type?: string; seq?: string };
        return message.type === "ack" && message.seq === "5";
      }),
    );
    expect(stdout.text).not.toContain("old-grid-bytes");

    transport.emitFrame(
      encodeFrame({
        type: "snapshot_to",
        targetId,
        seq: 6,
        payload: new TextEncoder().encode("new-grid-screen"),
      }),
    );
    await waitFor(() => stdout.text.includes("new-grid-screen"));

    // Incremental output resumes after the snapshot boundary.
    transport.emitFrame(
      encodeFrame({
        type: "output",
        seq: 7,
        payload: new TextEncoder().encode("after-resize"),
      }),
    );
    await waitFor(() => stdout.text.includes("after-resize"));

    client.emitMessage({ v: PROTOCOL_VERSION, type: "host-exited", exitCode: 0 });
    await expect(done).resolves.toBe(0);
  });

  it("rebuilds a listener grid without sending input, resize, ACK, or resync", async () => {
    const { client, transport, stdout, done } = makeSession("listener");
    await waitFor(() => client.options.role !== undefined && client.started);
    expect(client.options.capabilities.display?.resize).toBe(1);

    client.emitWelcome(fixedGridWelcome());
    const targetId = client.options.clientId;
    transport.emitFrame(
      encodeFrame({
        type: "snapshot_to",
        targetId,
        seq: 4,
        payload: new TextEncoder().encode("listener initial"),
      }),
    );
    await waitFor(() => stdout.text.includes("listener initial"));

    client.emitMessage({ v: PROTOCOL_VERSION, type: "display-size", cols: 132, rows: 43 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(client.controls).toHaveLength(0);

    transport.emitFrame(
      encodeFrame({
        type: "snapshot_to",
        targetId,
        seq: 5,
        payload: new TextEncoder().encode("listener new grid"),
      }),
    );
    await waitFor(() => stdout.text.includes("listener new grid"));
    expect(client.controls).toHaveLength(0);

    client.emitMessage({ v: PROTOCOL_VERSION, type: "host-exited", exitCode: 0 });
    await expect(done).resolves.toBe(0);
  });
});

describe("attach sizing safety", () => {
  it("does not send hello dimensions or resize from a non-TTY attach", async () => {
    const { client, done } = makeSession("viewer", {}, { stdout: false });
    await waitFor(() => client.options.role !== undefined && client.started);
    expect(client.options.cols).toBeUndefined();
    expect(client.options.rows).toBeUndefined();

    client.emitWelcome(welcomeMessage());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      client.controls.filter(
        (control) =>
          typeof control === "object" &&
          control !== null &&
          (control as { type?: string }).type === "resize",
      ),
    ).toHaveLength(0);

    client.emitFatal({ code: "network", message: "test done" });
    await expect(done).resolves.toBe(1);
  });
});

describe("attach listener mode", () => {
  it("negotiates listener capabilities and never sends input, resize, ACK, or resync", async () => {
    const { client, transport, stdin, stdout, done } = makeSession("listener");
    await waitFor(() => client.options.role !== undefined && client.started);

    expect(client.options.role).toBe("listener");
    expect(client.options.headers["X-Tokimeki-Listener"]).toBe("1");
    expect(client.options.cols).toBeUndefined();
    expect(client.options.rows).toBeUndefined();
    expect(client.options.capabilities.listener?.modes).toEqual(["snapshot-only"]);
    expect(client.options.capabilities.transports?.modes).toEqual(["relay"]);

    client.emitWelcome(welcomeMessage());
    const targetId = client.options.clientId;
    transport.emitFrame(
      encodeFrame({
        type: "snapshot_to",
        targetId,
        seq: 4,
        payload: new TextEncoder().encode("listener screen"),
      }),
    );
    await waitFor(() => stdout.text.includes("listener screen"));

    // Unknown input is ignored locally.
    stdin.emit("data", Buffer.from("must-not-reach-pty\r"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(transport.sent).toHaveLength(0);

    // Ctrl-C exits the listener without writing to the PTY.
    stdin.emit("data", Buffer.from("\u0003"));
    await expect(done).resolves.toBe(0);
    expect(transport.sent).toHaveLength(0);
    expect(client.controls).toEqual([]);
  });

  it("fails actionably when the relay does not implement listener mode", async () => {
    const { client, done } = makeSession("listener");
    await waitFor(() => client.options.role !== undefined && client.started);

    client.emitFatal({
      code: "not_implemented",
      message: "relay does not support listener mode",
    });
    await expect(done).resolves.toBe(1);
  });

  it("exits when the host exits", async () => {
    const { client, done } = makeSession("listener");
    await waitFor(() => client.options.role !== undefined && client.started);
    client.emitWelcome(welcomeMessage());

    client.emitMessage({ v: PROTOCOL_VERSION, type: "host-exited", exitCode: 0 });
    await expect(done).resolves.toBe(0);
  });

  it("accepts a restarted host's snapshot after the output sequence resets", async () => {
    const { client, transport, stdin, stdout, done } = makeSession("listener");
    await waitFor(() => client.options.role !== undefined && client.started);
    client.emitWelcome(welcomeMessage());
    const targetId = client.options.clientId;

    transport.emitFrame(
      encodeFrame({
        type: "snapshot_to",
        targetId,
        seq: 42,
        payload: new TextEncoder().encode("old host screen"),
      }),
    );
    await waitFor(() => stdout.text.includes("old host screen"));

    // A restarted host process reuses the session but starts its output
    // sequence at 0; the listener must not reject its snapshot as stale.
    client.emitMessage({ v: PROTOCOL_VERSION, type: "host", online: true });
    transport.emitFrame(
      encodeFrame({
        type: "snapshot_to",
        targetId,
        seq: 0,
        payload: new TextEncoder().encode("new host screen"),
      }),
    );
    await waitFor(() => stdout.text.includes("new host screen"));

    stdin.emit("data", Buffer.from("\u0003"));
    await expect(done).resolves.toBe(0);
  });
});

describe("attach tunnel negotiation", () => {
  function tunnelOffer(
    keyMode: "session-token" | "shared-secret",
    fec: "none" | "xor" = "none",
  ): {
    sdp: string;
    type: "offer";
    tunnel: {
      version: number;
      keyMode: "session-token" | "shared-secret";
      fec: "none" | "xor";
      initialSeq: number;
    };
  } {
    return {
      sdp: "v=0",
      type: "offer",
      tunnel: { version: 1, keyMode, fec, initialSeq: 0 },
    };
  }

  it("advertises the tunnel capability for viewers but never for listeners", async () => {
    const viewer = makeSession("viewer", { tunnel: "auto" });
    await waitFor(() => viewer.client.options.role !== undefined && viewer.client.started);
    expect(viewer.client.options.capabilities.tunnel).toEqual({
      version: 1,
      arq: "selective-repeat",
      fec: ["none", "xor"],
      crypto: "aes-256-gcm",
      keyMode: "session-token",
      maxFrameSize: 16_339,
    });
    viewer.client.emitMessage({ v: PROTOCOL_VERSION, type: "host-exited", exitCode: 0 });
    await expect(viewer.done).resolves.toBe(0);

    const listener = makeSession("listener", { tunnel: "auto" });
    await waitFor(() => listener.client.options.role !== undefined && listener.client.started);
    expect(listener.client.options.capabilities.tunnel).toBeUndefined();
    listener.client.emitWelcome(welcomeMessage());
    listener.stdin.emit("data", Buffer.from("\u0003"));
    await expect(listener.done).resolves.toBe(0);
  });

  it("refuses a tunnel offer when the local tunnel is off", async () => {
    const { client, done } = makeSession("viewer", { tunnel: "off" });
    await waitFor(() => client.options.role !== undefined && client.started);
    client.emitMessage({
      v: PROTOCOL_VERSION,
      type: "signal",
      to: client.options.clientId,
      from: "host-1",
      kind: "offer",
      payload: tunnelOffer("session-token"),
    });
    await waitFor(() =>
      client.controls.some(
        (control) =>
          (control as { type?: string; mode?: string }).type === "transport" &&
          (control as { mode?: string }).mode === "relay",
      ),
    );
    client.emitMessage({ v: PROTOCOL_VERSION, type: "host-exited", exitCode: 0 });
    await expect(done).resolves.toBe(0);
  });

  it("refuses a tunnel offer whose key mode does not match", async () => {
    const { client, done } = makeSession("viewer", { tunnel: "auto" });
    await waitFor(() => client.options.role !== undefined && client.started);
    client.emitMessage({
      v: PROTOCOL_VERSION,
      type: "signal",
      to: client.options.clientId,
      from: "host-1",
      kind: "offer",
      payload: tunnelOffer("shared-secret"),
    });
    await waitFor(() =>
      client.controls.some(
        (control) =>
          (control as { type?: string; reason?: string }).type === "transport" &&
          (control as { reason?: string }).reason === "tunnel key mode mismatch",
      ),
    );
    client.emitMessage({ v: PROTOCOL_VERSION, type: "host-exited", exitCode: 0 });
    await expect(done).resolves.toBe(0);
  });

  it("accepts an XOR offer when the local FEC policy allows it", async () => {
    // P2P is disabled so the accepted offer stops before creating a native
    // peer; this test only covers offer parsing and the refusal gate.
    const { client, done } = makeSession("viewer", {
      tunnel: "auto",
      tunnelFec: "xor",
      p2p: "off",
    });
    await waitFor(() => client.options.role !== undefined && client.started);
    client.emitMessage({
      v: PROTOCOL_VERSION,
      type: "signal",
      to: client.options.clientId,
      from: "host-1",
      kind: "offer",
      payload: tunnelOffer("session-token", "xor"),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      client.controls.some(
        (control) =>
          (control as { type?: string; mode?: string }).type === "transport" &&
          (control as { mode?: string }).mode === "relay",
      ),
    ).toBe(false);
    client.emitMessage({ v: PROTOCOL_VERSION, type: "host-exited", exitCode: 0 });
    await expect(done).resolves.toBe(0);
  });

  it("refuses an offer with an unknown FEC mode", async () => {
    const { client, done } = makeSession("viewer", { tunnel: "auto" });
    await waitFor(() => client.options.role !== undefined && client.started);
    client.emitMessage({
      v: PROTOCOL_VERSION,
      type: "signal",
      to: client.options.clientId,
      from: "host-1",
      kind: "offer",
      payload: {
        sdp: "v=0",
        type: "offer",
        tunnel: { version: 1, keyMode: "session-token", fec: "rs", initialSeq: 0 },
      },
    });
    await waitFor(() =>
      client.controls.some(
        (control) =>
          (control as { type?: string; reason?: string }).type === "transport" &&
          (control as { reason?: string }).reason === "unsupported offer parameters",
      ),
    );
    client.emitMessage({ v: PROTOCOL_VERSION, type: "host-exited", exitCode: 0 });
    await expect(done).resolves.toBe(0);
  });
});
