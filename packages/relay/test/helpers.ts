import { env, SELF } from "cloudflare:test";

export const MASTER_TOKEN = "test-master-token-abc";
export const SESSION_TOKEN = "test-session-token-xyz";
/** Must match the `TOKIMEKI_NAMESPACE_TOKENS` binding in `vitest.config.ts`. */
export const TEAM_A_TOKEN = "test-namespace-token-team-a-0123456789";
export const TEAM_B_TOKEN = "test-namespace-token-team-b-0123456789";

export type JsonRecord = Record<string, unknown>;

export interface TestSocket {
  readonly ws: WebSocket;
  readonly controls: JsonRecord[];
  readonly binary: Uint8Array[];
  readonly closeInfo: { code: number; reason: string } | null;
  send(message: unknown): void;
  sendBinary(bytes: Uint8Array): void;
  waitFor(predicate: (message: JsonRecord) => boolean, timeoutMs?: number): Promise<JsonRecord>;
  waitForType(type: string, timeoutMs?: number): Promise<JsonRecord>;
  waitForBinary(timeoutMs?: number): Promise<Uint8Array>;
  waitForClose(timeoutMs?: number): Promise<{ code: number; reason: string }>;
  close(): void;
}

interface Waiter {
  readonly predicate: (message: JsonRecord) => boolean;
  readonly resolve: (message: JsonRecord) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function wrapSocket(ws: WebSocket): TestSocket {
  const controls: JsonRecord[] = [];
  const binary: Uint8Array[] = [];
  let closeInfo: { code: number; reason: string } | null = null;
  const waiters: Waiter[] = [];
  let binaryWaiter: {
    resolve: (bytes: Uint8Array) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  const closeWaiters: {
    resolve: (info: { code: number; reason: string }) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];

  const failPending = (reason: string): void => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
    if (binaryWaiter !== null) {
      clearTimeout(binaryWaiter.timer);
      binaryWaiter.reject(new Error(reason));
      binaryWaiter = null;
    }
  };

  ws.addEventListener("message", (event: MessageEvent) => {
    const data: unknown = event.data;
    if (typeof data === "string") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return;
      }
      const control = parsed as JsonRecord;
      controls.push(control);
      for (let index = 0; index < waiters.length; index += 1) {
        const waiter = waiters[index];
        if (waiter === undefined) {
          continue;
        }
        if (waiter.predicate(control)) {
          waiters.splice(index, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(control);
          index -= 1;
        }
      }
      return;
    }
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : null;
    if (bytes === null) {
      return;
    }
    binary.push(bytes);
    if (binaryWaiter !== null) {
      const waiter = binaryWaiter;
      binaryWaiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve(bytes);
    }
  });

  ws.addEventListener("close", (event: CloseEvent) => {
    closeInfo = { code: event.code, reason: event.reason };
    failPending(`socket closed (${event.code})`);
    for (const waiter of closeWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(closeInfo);
    }
  });

  ws.accept();

  const socket: TestSocket = {
    ws,
    controls,
    binary,
    get closeInfo() {
      return closeInfo;
    },
    send(message: unknown) {
      ws.send(JSON.stringify(message));
    },
    sendBinary(bytes: Uint8Array) {
      ws.send(bytes);
    },
    waitFor(predicate, timeoutMs = 4_000) {
      const existing = controls.find(predicate);
      if (existing !== undefined) {
        return Promise.resolve(existing);
      }
      if (closeInfo !== null) {
        return Promise.reject(new Error(`socket already closed (${closeInfo.code})`));
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((entry) => entry.resolve === resolve);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          reject(new Error("timed out waiting for control message"));
        }, timeoutMs);
        waiters.push({ predicate, resolve, reject, timer });
      });
    },
    waitForType(type, timeoutMs) {
      return socket.waitFor((message) => message.type === type, timeoutMs);
    },
    waitForBinary(timeoutMs = 4_000) {
      const existing = binary[0];
      if (existing !== undefined) {
        return Promise.resolve(existing);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (binaryWaiter !== null) {
            binaryWaiter = null;
          }
          reject(new Error("timed out waiting for binary frame"));
        }, timeoutMs);
        binaryWaiter = { resolve, reject, timer };
      });
    },
    waitForClose(timeoutMs = 4_000) {
      if (closeInfo !== null) {
        return Promise.resolve(closeInfo);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = closeWaiters.findIndex((entry) => entry.resolve === resolve);
          if (index >= 0) {
            closeWaiters.splice(index, 1);
          }
          reject(new Error("timed out waiting for close"));
        }, timeoutMs);
        closeWaiters.push({ resolve, timer });
      });
    },
    close() {
      try {
        ws.close(1000, "test");
      } catch {
        // Already closed.
      }
    },
  };
  return socket;
}

export interface ConnectOptions {
  readonly role?: string;
  readonly token?: string | null;
  readonly master?: string;
  /** Set `X-Tokimeki-Listener: 1` (Worker-assigned listener role). */
  readonly listener?: boolean;
  /** Forged internal namespace header; the Worker must delete it. */
  readonly namespaceHeader?: string;
}

export async function connectWorker(
  sessionId: string,
  options: ConnectOptions = {},
): Promise<TestSocket> {
  const headers: Record<string, string> = { Upgrade: "websocket" };
  if (options.token !== null) {
    headers["x-tokimeki-session"] = options.token ?? SESSION_TOKEN;
  }
  if (options.master !== undefined) {
    headers["x-tokimeki-master"] = options.master;
  }
  if (options.namespaceHeader !== undefined) {
    headers["x-tokimeki-namespace"] = options.namespaceHeader;
  }
  if (options.listener === true) {
    headers["x-tokimeki-listener"] = "1";
  }
  const response = await SELF.fetch(`https://relay.test/ws/${sessionId}`, { headers });
  if (response.status !== 101 || response.webSocket == null) {
    throw new Error(`expected websocket 101, got ${response.status}`);
  }
  return wrapSocket(response.webSocket);
}

export async function connectDirect(
  sessionId: string,
  options: { role: string; token?: string | null },
): Promise<TestSocket> {
  const headers: Record<string, string> = {
    Upgrade: "websocket",
    "x-tokimeki-role": options.role,
  };
  if (options.token !== null) {
    headers["x-tokimeki-session"] = options.token ?? SESSION_TOKEN;
  }
  const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
  const response = await stub.fetch(`https://session.test/ws/${sessionId}`, { headers });
  if (response.status !== 101 || response.webSocket == null) {
    throw new Error(`expected websocket 101, got ${response.status}`);
  }
  return wrapSocket(response.webSocket);
}

export function helloFor(
  sessionId: string,
  role: string,
  clientId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    v: 1,
    type: "hello",
    role,
    session: sessionId,
    clientId,
    protocolVersion: 1,
    capabilities: {},
    ...extra,
  };
}

export async function openHost(
  sessionId: string,
  options: ConnectOptions = {},
): Promise<TestSocket> {
  const socket = await connectWorker(sessionId, {
    master: MASTER_TOKEN,
    token: SESSION_TOKEN,
    ...options,
  });
  socket.send(helloFor(sessionId, "host", "host-1", { cols: 80, rows: 24 }));
  await socket.waitForType("welcome");
  return socket;
}

export async function openViewer(
  sessionId: string,
  clientId: string,
  options: ConnectOptions = {},
): Promise<TestSocket> {
  const socket = await connectWorker(sessionId, {
    token: SESSION_TOKEN,
    ...options,
  });
  socket.send(helloFor(sessionId, "viewer", clientId));
  await socket.waitForType("welcome");
  return socket;
}

export async function openListener(
  sessionId: string,
  clientId: string,
  options: ConnectOptions = {},
): Promise<TestSocket> {
  const socket = await connectWorker(sessionId, {
    token: SESSION_TOKEN,
    listener: true,
    ...options,
  });
  socket.send(helloFor(sessionId, "listener", clientId));
  await socket.waitForType("welcome");
  return socket;
}
