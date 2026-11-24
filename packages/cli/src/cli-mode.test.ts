import { describe, expect, it } from "vitest";

import { parseGlobalFlags, resolveCliMode } from "./cli-mode.js";
import { ConfigError } from "./config.js";

describe("resolveCliMode", () => {
  it("defaults to interactive on a TTY and daemon otherwise", () => {
    expect(resolveCliMode({ isTTY: true })).toBe("interactive");
    expect(resolveCliMode({ isTTY: false })).toBe("daemon");
  });

  it("lets flags override the environment and TTY", () => {
    expect(resolveCliMode({ isTTY: true, daemonFlag: true })).toBe("daemon");
    expect(resolveCliMode({ isTTY: true, envMode: "daemon" })).toBe("daemon");
    expect(resolveCliMode({ isTTY: false, envMode: "daemon" })).toBe("daemon");
  });

  it("rejects an explicit interactive mode without a TTY", () => {
    expect(() => resolveCliMode({ isTTY: false, interactiveFlag: true })).toThrow(ConfigError);
  });

  it("rejects invalid TOKIMEKI_MODE values and conflicting flags", () => {
    expect(() => resolveCliMode({ isTTY: true, envMode: "chat" })).toThrow(/TOKIMEKI_MODE/);
    expect(() => resolveCliMode({ isTTY: true, interactiveFlag: true, daemonFlag: true })).toThrow(
      /cannot be used together/,
    );
  });
});

describe("parseGlobalFlags", () => {
  it("consumes only top-level flags", () => {
    expect(parseGlobalFlags(["--daemon", "--config", "cfg.json", "attach"])).toEqual({
      daemon: true,
      configPath: "cfg.json",
      rest: ["attach"],
    });
    expect(parseGlobalFlags(["--interactive", "claude", "--daemon"])).toEqual({
      interactive: true,
      rest: ["claude", "--daemon"],
    });
    expect(parseGlobalFlags(["claude", "--daemon"])).toEqual({
      rest: ["claude", "--daemon"],
    });
  });

  it("supports --config=path and stops at --", () => {
    expect(parseGlobalFlags(["--config=cfg.json", "run", "--", "x"])).toEqual({
      configPath: "cfg.json",
      rest: ["run", "--", "x"],
    });
    expect(parseGlobalFlags(["--", "--daemon"])).toEqual({ rest: ["--", "--daemon"] });
  });

  it("rejects a missing --config value", () => {
    expect(() => parseGlobalFlags(["--config"])).toThrow(/requires a file path/);
    expect(() => parseGlobalFlags(["--config="])).toThrow(/requires a file path/);
  });
});
