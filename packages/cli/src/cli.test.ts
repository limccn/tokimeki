import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { type CliDeps, main } from "./cli.js";
import type { AttachConfig, DoctorConfig, HostConfig } from "./config.js";
import type { HostCommandKind } from "./host/host-session.js";
import type { Logger } from "./logger.js";

interface MemoryWriteStream {
  readonly stream: NodeJS.WriteStream;
  readonly text: () => string;
}

function createWriteStream(): MemoryWriteStream {
  let buffer = "";
  const stream = {
    isTTY: false,
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

function createReadStream(): NodeJS.ReadStream {
  return {
    isTTY: false,
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
  extra: Partial<CliDeps> = {},
): { deps: CliDeps; stdout: () => string; stderr: () => string } {
  const out = createWriteStream();
  const err = createWriteStream();
  const deps: CliDeps = {
    env,
    stdin: createReadStream(),
    stdout: out.stream,
    stderr: err.stream,
    platform: "linux",
    cwd: "/work/project",
    hostname: "testhost",
    ...extra,
  };
  return { deps, stdout: out.text, stderr: err.text };
}

const hostEnv: NodeJS.ProcessEnv = {
  TOKIMEKI_RELAY_URL: "https://relay.example",
  TOKIMEKI_MASTER_TOKEN: "master-token-1234",
  TOKIMEKI_SESSION: "sess-1",
  TOKIMEKI_SESSION_TOKEN: "session-token-9876",
};

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

describe("tokimeki CLI wiring", () => {
  it("prints the version without any relay configuration", async () => {
    const { deps, stdout } = harness({});
    const code = await main(["node", "tokimeki", "--version"], deps);
    expect(code).toBe(0);
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(stdout()).toContain(packageJson.version);
  });

  it("prints help without any relay configuration", async () => {
    const { deps, stdout } = harness({});
    const code = await main(["node", "tokimeki", "--help"], deps);
    expect(code).toBe(0);
    expect(stdout()).toContain("Usage: tokimeki");
    expect(stdout()).toContain("attach");
    expect(stdout()).toContain("doctor");
  });

  it("runs claude --help locally without relay configuration", async () => {
    for (const flag of ["--help", "-h", "--version"]) {
      const runLocal = vi.fn(async (): Promise<number> => 0);
      const runHost = makeRunHost();
      const { deps, stderr } = harness({}, { runLocal, runHost });
      const code = await main(["node", "tokimeki", "claude", flag], deps);
      expect(code).toBe(0);
      expect(runLocal).toHaveBeenCalledTimes(1);
      expect(runLocal).toHaveBeenCalledWith("claude", [flag], {}, "linux");
      expect(runHost).not.toHaveBeenCalled();
      expect(stderr()).toBe("");
    }
  });

  it("runs pi --help locally without relay configuration", async () => {
    for (const flag of ["--help", "-h", "--version"]) {
      const runLocal = vi.fn(async (): Promise<number> => 0);
      const runHost = makeRunHost();
      const { deps, stderr } = harness({}, { runLocal, runHost });
      const code = await main(["node", "tokimeki", "pi", flag], deps);
      expect(code).toBe(0);
      expect(runLocal).toHaveBeenCalledTimes(1);
      expect(runLocal).toHaveBeenCalledWith("pi", [flag], {}, "linux");
      expect(runHost).not.toHaveBeenCalled();
      expect(stderr()).toBe("");
    }
  });

  it("still requires relay configuration to host pi or run", async () => {
    const runHost = makeRunHost();
    const hostPi = harness({}, { runHost });
    expect(await main(["node", "tokimeki", "pi", "--model", "x"], hostPi.deps)).toBe(2);
    expect(hostPi.stderr()).toContain("TOKIMEKI_MASTER_TOKEN is required");

    const hostRun = harness({}, { runHost });
    expect(await main(["node", "tokimeki", "run", "--", "node", "script.mjs"], hostRun.deps)).toBe(
      2,
    );
    expect(hostRun.stderr()).toContain("TOKIMEKI_MASTER_TOKEN is required");
    expect(runHost).not.toHaveBeenCalled();
  });

  it("hosts claude through the relay when configured", async () => {
    const runHost = makeRunHost();
    const runLocal = vi.fn(async (): Promise<number> => 1);
    const { deps, stderr } = harness(hostEnv, { runHost, runLocal });

    const code = await main(["node", "tokimeki", "claude", "--resume", "abc"], deps);
    expect(code).toBe(0);
    expect(runLocal).not.toHaveBeenCalled();
    expect(runHost).toHaveBeenCalledTimes(1);

    const [config, command, args, kind, logger] = runHost.mock.calls[0] ?? [];
    expect(config).toMatchObject({
      role: "host",
      session: "sess-1",
      websocketUrl: "wss://relay.example/ws/sess-1",
      sessionTokenGenerated: false,
    });
    expect(command).toBe("claude");
    expect(args).toEqual(["--resume", "abc"]);
    expect(kind).toBe("claude");
    expect(logger).toBeDefined();
    expect(stderr()).not.toContain("master-token-1234");
    expect(stderr()).not.toContain("session-token-9876");
  });

  it("passes pi arguments through and honours the regular TUI mode", async () => {
    const runHost = makeRunHost();
    const { deps } = harness({ ...hostEnv, TOKIMEKI_PI_TUI_MODE: "regular" }, { runHost });

    const code = await main(["node", "tokimeki", "pi", "--model", "x"], deps);
    expect(code).toBe(0);

    const [config, command, args, kind] = runHost.mock.calls[0] ?? [];
    expect(config).toMatchObject({ piTuiMode: "regular" });
    expect(command).toBe("pi");
    expect(args).toEqual(["--model", "x"]);
    expect(kind).toBe("pi");
  });

  it("hosts run -- <cmd...> without shell splitting", async () => {
    const runHost = makeRunHost();
    const { deps } = harness(hostEnv, { runHost });

    const code = await main(
      ["node", "tokimeki", "run", "--", "node", "scripts/fake.mjs", "--flag", "a b"],
      deps,
    );
    expect(code).toBe(0);

    const [_config, command, args, kind] = runHost.mock.calls[0] ?? [];
    expect(command).toBe("node");
    expect(args).toEqual(["scripts/fake.mjs", "--flag", "a b"]);
    expect(kind).toBe("run");
  });

  it("wires attach with viewer configuration", async () => {
    const runAttach = vi.fn(async (_config: AttachConfig, _logger: Logger): Promise<number> => 0);
    const { deps } = harness(
      {
        TOKIMEKI_RELAY_URL: "https://relay.example/base/",
        TOKIMEKI_SESSION: "sess-1",
        TOKIMEKI_SESSION_TOKEN: "session-token-9876",
      },
      { runAttach },
    );

    const code = await main(["node", "tokimeki", "attach"], deps);
    expect(code).toBe(0);
    expect(runAttach).toHaveBeenCalledTimes(1);
    const [config] = runAttach.mock.calls[0] ?? [];
    expect(config).toMatchObject({
      role: "viewer",
      session: "sess-1",
      websocketUrl: "wss://relay.example/base/ws/sess-1",
    });
  });

  it("wires doctor with normalized configuration", async () => {
    const runDoctor = vi.fn(
      async (_config: DoctorConfig, _stdout: NodeJS.WriteStream): Promise<number> => 0,
    );
    const { deps } = harness(
      {
        TOKIMEKI_RELAY_URL: "http://localhost:8787/",
        TOKIMEKI_SESSION: "sess-1",
        TOKIMEKI_SESSION_TOKEN: "session-token-9876",
      },
      { runDoctor },
    );

    const code = await main(["node", "tokimeki", "doctor"], deps);
    expect(code).toBe(0);
    expect(runDoctor).toHaveBeenCalledTimes(1);
    const [config] = runDoctor.mock.calls[0] ?? [];
    expect(config).toMatchObject({
      relayUrl: "ws://localhost:8787",
      session: "sess-1",
      hasSessionToken: true,
      hasMasterToken: false,
    });
  });

  it("exits 2 with a redacted error when host configuration is incomplete", async () => {
    const runHost = makeRunHost();
    const { deps, stderr } = harness({ TOKIMEKI_RELAY_URL: "https://relay.example" }, { runHost });

    const code = await main(["node", "tokimeki", "claude"], deps);
    expect(code).toBe(2);
    expect(runHost).not.toHaveBeenCalled();
    expect(stderr()).toContain("TOKIMEKI_MASTER_TOKEN is required");
  });

  it("exits 2 when attach configuration is incomplete", async () => {
    const runAttach = vi.fn(async (): Promise<number> => 0);
    const { deps, stderr } = harness(
      { TOKIMEKI_RELAY_URL: "https://relay.example", TOKIMEKI_SESSION: "sess-1" },
      { runAttach },
    );

    const code = await main(["node", "tokimeki", "attach"], deps);
    expect(code).toBe(2);
    expect(runAttach).not.toHaveBeenCalled();
    expect(stderr()).toContain("TOKIMEKI_SESSION_TOKEN is required");
  });

  it("propagates the host exit code", async () => {
    const runHost = vi.fn(async (): Promise<number> => 7);
    const { deps } = harness(hostEnv, { runHost });
    const code = await main(["node", "tokimeki", "run", "--", "sleep", "1"], deps);
    expect(code).toBe(7);
  });
});
