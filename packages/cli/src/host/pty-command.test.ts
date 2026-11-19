import { describe, expect, it } from "vitest";

import {
  buildChildEnvironment,
  buildLocalCommand,
  buildPtyCommand,
  hasExplicitPiTuiMode,
  isLocalHelpPassthrough,
} from "./pty-command.js";

const baseOptions = {
  env: {
    PATH: "/usr/bin",
    SSH_CONNECTION: "1 2 3 4",
    SSH_TTY: "/dev/pts/0",
    SSH_CLIENT: "1 2 3",
  } satisfies NodeJS.ProcessEnv,
  platform: "linux" as NodeJS.Platform,
  term: "xterm-256color",
  colorterm: "truecolor",
  piTuiMode: "fullscreen" as const,
  isClaude: false,
  isPi: false,
};

describe("isLocalHelpPassthrough", () => {
  it("detects help and version requests", () => {
    expect(isLocalHelpPassthrough(["--help"])).toBe(true);
    expect(isLocalHelpPassthrough(["-h"])).toBe(true);
    expect(isLocalHelpPassthrough(["--version"])).toBe(true);
    expect(isLocalHelpPassthrough(["--resume", "abc"])).toBe(false);
    expect(isLocalHelpPassthrough([])).toBe(false);
  });
});

describe("hasExplicitPiTuiMode", () => {
  it("detects both flag forms", () => {
    expect(hasExplicitPiTuiMode(["--tui-mode", "regular"])).toBe(true);
    expect(hasExplicitPiTuiMode(["--tui-mode=regular"])).toBe(true);
    expect(hasExplicitPiTuiMode(["--model", "x"])).toBe(false);
  });
});

describe("buildChildEnvironment", () => {
  it("sets TERM/COLORTERM, strips SSH variables, and defaults LANG", () => {
    const env = buildChildEnvironment(baseOptions);
    expect(env.TERM).toBe("xterm-256color");
    expect(env.COLORTERM).toBe("truecolor");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.SSH_CONNECTION).toBeUndefined();
    expect(env.SSH_TTY).toBeUndefined();
    expect(env.SSH_CLIENT).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("never passes host relay credentials to the shared PTY child", () => {
    const env = buildChildEnvironment({
      ...baseOptions,
      env: {
        PATH: "/usr/bin",
        TOKIMEKI_TOKEN: "host-token-secret",
        TOKIMEKI_MASTER_TOKEN: "master-secret",
        TOKIMEKI_NAMESPACE_TOKENS: '{"team-a":"namespace-secret"}',
        TOKIMEKI_SESSION_TOKEN: "session-secret",
        TOKIMEKI_TUNNEL_SECRET: "tunnel-secret",
        TOKIMEKI_COTURN_SECRET: "coturn-secret",
        TOKIMEKI_TURN_API_TOKEN: "turn-api-token",
        TOKIMEKI_TURN_CREDENTIAL: "turn-credential",
        TOKIMEKI_CONFIG: '{"sessionToken":"session-secret"}',
        TOKIMEKI_RELAY_URL: "wss://relay.example",
      },
    });
    expect(env.TOKIMEKI_TOKEN).toBeUndefined();
    expect(env.TOKIMEKI_MASTER_TOKEN).toBeUndefined();
    expect(env.TOKIMEKI_NAMESPACE_TOKENS).toBeUndefined();
    expect(env.TOKIMEKI_SESSION_TOKEN).toBeUndefined();
    expect(env.TOKIMEKI_TUNNEL_SECRET).toBeUndefined();
    expect(env.TOKIMEKI_COTURN_SECRET).toBeUndefined();
    expect(env.TOKIMEKI_TURN_API_TOKEN).toBeUndefined();
    expect(env.TOKIMEKI_TURN_CREDENTIAL).toBeUndefined();
    expect(env.TOKIMEKI_CONFIG).toBeUndefined();
    expect(env.TOKIMEKI_RELAY_URL).toBe("wss://relay.example");
  });

  it("removes mixed-case secret and SSH variables on Windows", () => {
    const env = buildChildEnvironment({
      ...baseOptions,
      platform: "win32",
      env: {
        Path: "C:\\Windows",
        Tokimeki_Token: "host-token-secret",
        Tokimeki_Master_Token: "master-secret",
        Tokimeki_Namespace_Tokens: '{"team-a":"namespace-secret"}',
        tokimeki_session_token: "session-secret",
        Tokimeki_Tunnel_Secret: "tunnel-secret",
        Tokimeki_Turn_Api_Token: "turn-api-token",
        Tokimeki_Config: '{"sessionToken":"session-secret"}',
        ssh_connection: "1 2 3 4",
      },
    });
    expect(env.Tokimeki_Token).toBeUndefined();
    expect(env.Tokimeki_Master_Token).toBeUndefined();
    expect(env.Tokimeki_Namespace_Tokens).toBeUndefined();
    expect(env.tokimeki_session_token).toBeUndefined();
    expect(env.Tokimeki_Tunnel_Secret).toBeUndefined();
    expect(env.Tokimeki_Turn_Api_Token).toBeUndefined();
    expect(env.Tokimeki_Config).toBeUndefined();
    expect(env.ssh_connection).toBeUndefined();
    expect(env.Path).toBe("C:\\Windows");
  });

  it("preserves non-canonical lowercase variables on POSIX", () => {
    const env = buildChildEnvironment({
      ...baseOptions,
      env: { tokimeki_master_token: "user-value" },
    });
    expect(env.tokimeki_master_token).toBe("user-value");
  });

  it("does not overwrite an existing LANG", () => {
    const env = buildChildEnvironment({ ...baseOptions, env: { LANG: "ja_JP.UTF-8" } });
    expect(env.LANG).toBe("ja_JP.UTF-8");
  });

  it("uses a C.UTF-8 default on Windows", () => {
    const env = buildChildEnvironment({ ...baseOptions, platform: "win32" });
    expect(env.LANG).toBe("C.UTF-8");
  });

  it("enables Claude alt-screen full repaint for claude only", () => {
    const claudeEnv = buildChildEnvironment({ ...baseOptions, isClaude: true });
    expect(claudeEnv.CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT).toBe("1");
    const otherEnv = buildChildEnvironment(baseOptions);
    expect(otherEnv.CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT).toBeUndefined();
  });
});

describe("buildPtyCommand", () => {
  it("passes claude arguments through untouched", () => {
    const spec = buildPtyCommand("claude", ["--resume", "abc"], {
      ...baseOptions,
      isClaude: true,
    });
    expect(spec.command).toBe("claude");
    expect(spec.args).toEqual(["--resume", "abc"]);
    expect(spec.env.CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT).toBe("1");
  });

  it("appends --tui-mode regular for pi when the user did not choose", () => {
    const spec = buildPtyCommand("pi", ["--model", "x"], {
      ...baseOptions,
      isPi: true,
      piTuiMode: "regular",
    });
    expect(spec.args).toEqual(["--model", "x", "--tui-mode", "regular"]);
  });

  it("never appends a duplicate pi TUI mode", () => {
    const explicit = buildPtyCommand("pi", ["--tui-mode", "fullscreen"], {
      ...baseOptions,
      isPi: true,
      piTuiMode: "regular",
    });
    expect(explicit.args).toEqual(["--tui-mode", "fullscreen"]);

    const equalsForm = buildPtyCommand("pi", ["--tui-mode=fullscreen"], {
      ...baseOptions,
      isPi: true,
      piTuiMode: "regular",
    });
    expect(equalsForm.args).toEqual(["--tui-mode=fullscreen"]);
  });

  it("does not append in fullscreen mode", () => {
    const spec = buildPtyCommand("pi", [], {
      ...baseOptions,
      isPi: true,
      piTuiMode: "fullscreen",
    });
    expect(spec.args).toEqual([]);
  });

  it("routes Windows shims through cmd.exe /c", () => {
    const spec = buildPtyCommand("claude", ["--foo bar"], {
      ...baseOptions,
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      isClaude: true,
    });
    expect(spec.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(spec.args).toEqual(["/c", "claude", "--foo bar"]);
  });

  it("spawns Windows executables directly", () => {
    const spec = buildPtyCommand("C:\\tools\\claude.exe", ["--foo"], {
      ...baseOptions,
      platform: "win32",
    });
    expect(spec.command).toBe("C:\\tools\\claude.exe");
    expect(spec.args).toEqual(["--foo"]);
  });
});

describe("buildLocalCommand", () => {
  it("uses cmd.exe /c for Windows shims", () => {
    const spec = buildLocalCommand("npm", ["--version"], {
      platform: "win32",
      env: { COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
    });
    expect(spec.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(spec.args).toEqual(["/c", "npm", "--version"]);
  });

  it("spawns POSIX commands directly", () => {
    const spec = buildLocalCommand("claude", ["--help"], {
      platform: "linux",
      env: {},
    });
    expect(spec.command).toBe("claude");
    expect(spec.args).toEqual(["--help"]);
  });
});
