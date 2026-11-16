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

function attachConfig(role: AttachConfig["role"]): AttachConfig {
  return {
    relayUrl: "wss://relay.example",
    websocketUrl: "wss://relay.example/ws/sess-1",
    session: "sess-1",
    heartbeatSeconds: 0,
    p2p: "auto",
    iceTransportPolicy: "all",
    logLevel: "silent",
    warnings: [],
    secrets: [],
    role,
    sessionToken: "session-token-9876",
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

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function makeSession(role: AttachConfig["role"]): {
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
  const logger = new Logger({ level: "silent", write: () => {} });
  const done = runAttachSession(attachConfig(role), {
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
