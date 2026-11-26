import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { type CliDeps, type DoctorRunHooks, main } from "./cli.js";
import type { AttachConfig, DoctorConfig, HostConfig } from "./config.js";
import type { HostCommandKind } from "./host/host-session.js";
import type { Logger } from "./logger.js";
import { addHistoryEntry } from "./persist.js";

interface Stream {
  readonly stream: NodeJS.WriteStream;
  readonly text: () => string;
}

function writeStream(isTTY = false): Stream {
  let buffer = "";
  const stream = {
    isTTY,
    columns: 80,
    rows: 24,
    write(chunk: string | Uint8Array): boolean {
      buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
    once(): void {},
    on(): void {},
    removeListener(): void {},
  } as unknown as NodeJS.WriteStream;
  return { stream, text: () => buffer };
}

function readStream(isTTY: boolean): NodeJS.ReadStream {
  return {
    isTTY,
    resume(): void {},
    pause(): void {},
    on(): void {},
    once(): void {},
    removeListener(): void {},
    setRawMode(): void {},
  } as unknown as NodeJS.ReadStream;
}

function harness(
  env: NodeJS.ProcessEnv,
  options: { isTTY?: boolean; extra?: Partial<CliDeps> } = {},
) {
  const out = writeStream(options.isTTY === true);
  const err = writeStream(options.isTTY === true);
  const deps: CliDeps = {
    env,
    stdin: readStream(options.isTTY === true),
    stdout: out.stream,
    stderr: err.stream,
    isTTY: options.isTTY === true,
    platform: process.platform,
    cwd: "/work/project",
    hostname: "testhost",
    ...options.extra,
  };
  return { deps, stdout: out.text, stderr: err.text };
}

function makeRunHost() {
  return vi.fn(
    async (
      _config: HostConfig,
      _command: string,
      _args: readonly string[],
      _kind: HostCommandKind,
      _logger: Logger,
    ): Promise<number> => 0,
  );
}

function eventsFrom(stderr: string): Array<Record<string, unknown>> {
  return stderr
    .split("\n")
    .filter((line) => line.startsWith("tokimeki-event: "))
    .map((line) => JSON.parse(line.slice("tokimeki-event: ".length)) as Record<string, unknown>);
}

const hostEnv = {
  TOKIMEKI_RELAY_URL: "wss://relay.example",
  TOKIMEKI_TOKEN: "host-token-value",
  TOKIMEKI_NAMESPACE: "abcde",
  TOKIMEKI_SESSION: "abcde.laptop",
  TOKIMEKI_SESSION_TOKEN: "session-token-value",
};

describe("v1.4 CLI onboarding wiring", () => {
  it("emits a structured daemon error for incomplete attach config", async () => {
    const { deps, stderr, stdout } = harness({});
    const code = await main(["node", "tokimeki", "attach"], deps);
    expect(code).toBe(2);
    expect(stdout()).toBe("");
    const events = eventsFrom(stderr());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ v: 1, type: "error", code: "config_invalid", exitCode: 2 });
    expect(events[0]?.message).not.toContain("token-value");
  });

  it("rejects explicit interactive mode without a TTY", async () => {
    const { deps, stderr } = harness({}, { isTTY: false });
    const code = await main(["node", "tokimeki", "--interactive", "attach"], deps);
    expect(code).toBe(2);
    expect(stderr()).toContain("interactive mode requires a TTY");
  });

  it("hosts directly from a --config envelope file", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "tokimeki-cli-config-"));
    const path = join(homeDir, "tokimeki-config.json");
    writeFileSync(
      path,
      JSON.stringify({
        v: 2,
        relayUrl: "wss://relay.example",
        token: "file-host-token",
        namespace: "abcde",
        session: "abcde.laptop",
        sessionToken: "file-session-token",
        passcode: "123456",
        windowSize: "100x30",
      }),
      { mode: 0o600 },
    );
    const runHost = makeRunHost();
    const { deps } = harness({}, { extra: { homeDir, runHost } });
    const code = await main(["node", "tokimeki", "--config", path, "claude"], deps);
    expect(code).toBe(0);
    const config = runHost.mock.calls[0]?.[0] as HostConfig;
    expect(config.hostToken).toBe("file-host-token");
    expect(config.session).toBe("abcde.laptop");
    expect(config.passcode).toBe("123456");
    expect(config.windowSize).toEqual({ cols: 100, rows: 30 });
  });

  it("rejects --config for attach", async () => {
    const { deps, stderr } = harness({});
    const code = await main(["node", "tokimeki", "--config", "cfg.json", "attach"], deps);
    expect(code).toBe(2);
    expect(stderr()).toContain("only supported for host commands");
  });

  it("attaches from a positional share URL through the documented exchange", async () => {
    const runAttach = vi.fn(
      async (
        config: AttachConfig,
        _logger: Logger,
        hooks?: { onWelcome: () => void },
      ): Promise<number> => {
        hooks?.onWelcome();
        void config;
        return 0;
      },
    );
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith("/api/config")) {
        return new Response(
          JSON.stringify({ tokimekiEnabled: true, tokimekiRelayUrl: "ws://127.0.0.1:8787" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          success: true,
          token: "session-jwt-value",
          session: "ab12.calm-otter",
          mode: "viewer",
          allowWeb: true,
          passcodeRequired: false,
          expiresAt: "2026-11-27T06:53:00.000Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const { deps } = harness(
      {},
      { extra: { fetchImpl, runAttach, homeDir: mkdtempSync(join(tmpdir(), "tokimeki-cli-")) } },
    );
    const code = await main(
      ["node", "tokimeki", "attach", "http://127.0.0.1:9999/#t-code123"],
      deps,
    );
    expect(code).toBe(0);
    const config = runAttach.mock.calls[0]?.[0] as AttachConfig;
    expect(config.session).toBe("ab12.calm-otter");
    expect(config.sessionToken).toBe("session-jwt-value");
    expect(config.relayUrl).toBe("ws://127.0.0.1:8787");
  });

  it("rejects a viewer invite with --listen", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith("/api/config")) {
        return new Response(
          JSON.stringify({ tokimekiEnabled: true, tokimekiRelayUrl: "ws://127.0.0.1:8787" }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          token: "session-jwt-value",
          session: "ab12.calm-otter",
          mode: "viewer",
          allowWeb: true,
          passcodeRequired: false,
          expiresAt: "2026-11-27T06:53:00.000Z",
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const { deps } = harness(
      {},
      { extra: { fetchImpl, homeDir: mkdtempSync(join(tmpdir(), "tokimeki-cli-")) } },
    );
    const code = await main(
      ["node", "tokimeki", "attach", "--listen", "http://127.0.0.1:9999/#t-code123"],
      deps,
    );
    expect(code).toBe(2);
  });

  it("runs the host wizard in interactive mode and then loads the collected env", async () => {
    const runHost = makeRunHost();
    const runHostWizard = vi.fn(async () => ({
      env: hostEnv,
      warnings: [],
    }));
    const { deps } = harness(
      {},
      {
        isTTY: true,
        extra: { runHost, runHostWizard, homeDir: "/tmp/tokimeki-home" },
      },
    );
    const code = await main(["node", "tokimeki", "claude"], deps);
    expect(code).toBe(0);
    expect(runHostWizard).toHaveBeenCalledTimes(1);
    expect(runHost.mock.calls[0]?.[0]).toMatchObject({
      hostToken: "host-token-value",
      session: "abcde.laptop",
    });
  });

  it("runs the attach wizard, waits for welcome, and finalizes history", async () => {
    const finalize = vi.fn(async () => []);
    const runAttachWizard = vi.fn(async () => ({
      env: {
        TOKIMEKI_RELAY_URL: "wss://relay.example",
        TOKIMEKI_SESSION: "abcde.laptop",
        TOKIMEKI_SESSION_TOKEN: "session-token-value",
      },
      listener: false,
      hostedJwt: false,
      relayUrl: "wss://relay.example",
      session: "abcde.laptop",
      sessionToken: "session-token-value",
      warnings: [],
      finalize,
    }));
    const runAttach = vi.fn(
      async (
        _config: AttachConfig,
        _logger: Logger,
        hooks?: { onWelcome: () => void },
      ): Promise<number> => {
        hooks?.onWelcome();
        return 0;
      },
    );
    const { deps } = harness(
      {},
      {
        isTTY: true,
        extra: { runAttach, runAttachWizard, homeDir: "/tmp/tokimeki-home" },
      },
    );
    const code = await main(["node", "tokimeki", "attach"], deps);
    expect(code).toBe(0);
    expect(runAttachWizard).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("lists the ACP catalog and supports --detect", async () => {
    const { deps, stdout } = harness({});
    expect(await main(["node", "tokimeki", "acp", "list"], deps)).toBe(0);
    const listing = stdout();
    for (const command of ["claude", "codex", "amp"]) {
      expect(listing).toContain(command);
    }
    const detected = harness({ PATH: "" });
    expect(await main(["node", "tokimeki", "acp", "list", "--detect"], detected.deps)).toBe(0);
    expect(detected.stdout()).toContain("not found in PATH");
  });

  it("lists and clears saved connection history without exposing tokens", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "tokimeki-cli-history-"));
    addHistoryEntry(
      {
        relayUrl: "wss://relay.example",
        session: "abcde.laptop",
        sessionToken: "opaque-session-token",
        lastUsedAt: 1,
      },
      { homeDir, platform: process.platform },
    );
    const listing = harness({}, { extra: { homeDir, platform: process.platform } });
    expect(await main(["node", "tokimeki", "history"], listing.deps)).toBe(0);
    expect(listing.stdout()).toContain("abcde.laptop");
    expect(listing.stdout()).toContain("token-saved");
    expect(listing.stdout()).not.toContain("opaque-session-token");

    const clearing = harness({}, { extra: { homeDir, platform: process.platform } });
    expect(await main(["node", "tokimeki", "history", "clear"], clearing.deps)).toBe(0);
    const empty = harness({}, { extra: { homeDir, platform: process.platform } });
    expect(await main(["node", "tokimeki", "history"], empty.deps)).toBe(0);
    expect(empty.stdout()).toContain("no saved connections");
  });

  it("emits the doctor report event in daemon mode", async () => {
    const runDoctor = vi.fn(
      async (
        _config: DoctorConfig,
        _stdout: NodeJS.WriteStream,
        hooks?: DoctorRunHooks,
      ): Promise<number> => {
        hooks?.onReport?.({ ok: true, checks: [{ name: "relay", status: "ok" }] });
        return 0;
      },
    );
    const { deps, stderr } = harness({}, { extra: { runDoctor } });
    expect(await main(["node", "tokimeki", "doctor"], deps)).toBe(0);
    const events = eventsFrom(stderr());
    expect(events.some((event) => event.type === "report" && event.ok === true)).toBe(true);
  });
});
