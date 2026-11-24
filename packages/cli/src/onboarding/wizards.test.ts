import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { runAttachWizard } from "./attach-wizard.js";
import { runHostWizard } from "./host-wizard.js";
import type { PromptIO } from "./prompt.js";

class FakePrompt implements PromptIO {
  readonly printed: string[] = [];
  readonly textQueue: string[];
  readonly secretQueue: string[];
  readonly confirmQueue: boolean[];
  readonly selectQueue: string[];
  readonly defaultValues: string[] = [];

  constructor(options: {
    text?: string[];
    secret?: string[];
    confirm?: boolean[];
    select?: string[];
  }) {
    this.textQueue = options.text ?? [];
    this.secretQueue = options.secret ?? [];
    this.confirmQueue = options.confirm ?? [];
    this.selectQueue = options.select ?? [];
    void this.defaultValues;
  }

  async text(options: { message: string; defaultValue?: string }): Promise<string> {
    const value = this.textQueue.shift();
    if (value === undefined || value === "") return options.defaultValue ?? "";
    return value;
  }

  async secret(_options: { message: string }): Promise<string> {
    return this.secretQueue.shift() ?? "";
  }

  async confirm(options: { message: string; defaultYes?: boolean }): Promise<boolean> {
    const value = this.confirmQueue.shift();
    return value ?? options.defaultYes ?? false;
  }

  async select(options: {
    message: string;
    choices: readonly { readonly label: string; readonly value: string }[];
    defaultIndex?: number;
  }): Promise<string> {
    const value = this.selectQueue.shift();
    return value ?? options.choices[options.defaultIndex ?? 0]?.value ?? "";
  }

  print(message: string): void {
    this.printed.push(message);
  }

  close(): void {}
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("host wizard", () => {
  it("collects an existing TOKIMEKI_TOKEN path and validates whoami", async () => {
    const prompt = new FakePrompt({
      text: ["", "abcde"],
      secret: ["host-token-1234"],
      confirm: [true, false, false],
      select: ["token"],
    });
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { authMode: "namespace", namespace: "abcde" }),
    ) as unknown as typeof fetch;
    const result = await runHostWizard({
      prompt,
      env: {},
      fetchImpl,
      platform: process.platform,
    });
    expect(result.stopped).toBeUndefined();
    expect(result.env).toMatchObject({
      TOKIMEKI_RELAY_URL: "wss://relay.tokiapi.app",
      TOKIMEKI_TOKEN: "host-token-1234",
      TOKIMEKI_NAMESPACE: "abcde",
    });
    expect(result.env.TOKIMEKI_SESSION_TOKEN).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(result.env.TOKIMEKI_SESSION).toBeUndefined();
    expect(prompt.printed.join("\n")).toContain("[ok] relay whoami authenticated");
    expect(prompt.printed.join("\n")).not.toContain("host-token-1234");
  });

  it("clears an inherited namespace when using the master token", async () => {
    const prompt = new FakePrompt({
      text: [""],
      secret: ["master-token-1234"],
      confirm: [true, false, false],
      select: ["master"],
    });
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { authMode: "master", namespace: "*" }),
    ) as unknown as typeof fetch;
    const result = await runHostWizard({
      prompt,
      env: { TOKIMEKI_NAMESPACE: "abcde" },
      fetchImpl,
      platform: process.platform,
    });
    expect(result.env.TOKIMEKI_MASTER_TOKEN).toBe("master-token-1234");
    expect(result.env.TOKIMEKI_NAMESPACE).toBe("");
    expect(result.env.TOKIMEKI_TOKEN).toBeUndefined();
    expect(result.warnings.join("\n")).toContain("ignored with TOKIMEKI_MASTER_TOKEN");
  });

  it("guides self-hosted users to the deploy button and stops", async () => {
    const prompt = new FakePrompt({
      text: ["wss://relay.self.example"],
      confirm: [false],
    });
    const result = await runHostWizard({ prompt, env: {}, platform: process.platform });
    expect(result.stopped).toBe(true);
    const printed = prompt.printed.join("\n");
    expect(printed).toContain("deploy.workers.cloudflare.com");
    expect(printed).toContain("TOKIMEKI_NAMESPACE_TOKENS");
    expect(printed).toContain("never runs wrangler");
  });

  it("requests an anonymous host grant from TokiAPI", async () => {
    const prompt = new FakePrompt({
      text: [""],
      confirm: [false, false],
    });
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/config")) {
        return jsonResponse(200, {
          tokimekiEnabled: true,
          tokimekiRelayUrl: "wss://relay.tokiapi.app",
        });
      }
      expect(init?.method).toBe("POST");
      return jsonResponse(200, {
        success: true,
        token: "anon-host-jwt",
        namespace: "ab12",
        session: "ab12.calm-otter",
        inviteUrl: "https://tokiapi.app/#t-code123",
        expiresAt: 1_800_000_000,
      });
    }) as unknown as typeof fetch;
    const result = await runHostWizard({
      prompt,
      env: {},
      fetchImpl,
      platform: process.platform,
    });
    expect(result.stopped).toBeUndefined();
    expect(result.env).toEqual({
      TOKIMEKI_RELAY_URL: "wss://relay.tokiapi.app",
      TOKIMEKI_TOKEN: "anon-host-jwt",
      TOKIMEKI_NAMESPACE: "ab12",
      TOKIMEKI_SESSION: "ab12.calm-otter",
      TOKIMEKI_SESSION_TOKEN: expect.stringMatching(/^[A-Za-z0-9_-]{40,}$/),
    });
    expect(result.inviteUrl).toBe("https://tokiapi.app/#t-code123");
    expect(prompt.printed.join("\n")).toContain("Invite URL (capability secret");
    expect(prompt.printed.join("\n")).not.toContain("anon-host-jwt");
  });

  it("does not call TokiAPI when the provider is disabled", async () => {
    const prompt = new FakePrompt({ text: [""], confirm: [false] });
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { tokimekiEnabled: false, tokimekiRelayUrl: "" }),
    ) as unknown as typeof fetch;
    const result = await runHostWizard({
      prompt,
      env: {},
      fetchImpl,
      platform: process.platform,
    });
    expect(result.stopped).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("attach wizard", () => {
  it("collects manual relay/session/token input", async () => {
    const prompt = new FakePrompt({
      text: ["", "abcde.laptop"],
      secret: ["session-token-1234"],
      confirm: [false],
      select: ["manual"],
    });
    const result = await runAttachWizard({
      prompt,
      env: {},
      platform: process.platform,
      homeDir: "/nonexistent-tokimeki-home",
    });
    expect(result.env).toMatchObject({
      TOKIMEKI_RELAY_URL: "wss://relay.tokiapi.app",
      TOKIMEKI_SESSION: "abcde.laptop",
      TOKIMEKI_SESSION_TOKEN: "session-token-1234",
    });
    expect(result.listener).toBe(false);
    expect(result.hostedJwt).toBe(false);
    expect(result.namespace).toBe("abcde");
  });

  it("exchanges a TokiAPI invite and keeps the Session JWT in memory", async () => {
    const prompt = new FakePrompt({
      secret: ["https://tokiapi.app/#t-code123"],
      select: ["invite"],
      confirm: [false],
    });
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith("/api/config")) {
        return jsonResponse(200, {
          tokimekiEnabled: true,
          tokimekiRelayUrl: "wss://relay.tokiapi.app",
        });
      }
      return jsonResponse(200, {
        success: true,
        token: "session-jwt",
        session: "ab12.calm-otter",
        mode: "listener",
        allowWeb: false,
        passcodeRequired: false,
        expiresAt: 1_800_000_000,
      });
    }) as unknown as typeof fetch;
    const result = await runAttachWizard({
      prompt,
      env: {},
      fetchImpl,
      platform: process.platform,
      homeDir: "/nonexistent-tokimeki-home",
    });
    expect(result.hostedJwt).toBe(true);
    expect(result.listener).toBe(true);
    expect(result.env).toMatchObject({
      TOKIMEKI_RELAY_URL: "wss://relay.tokiapi.app",
      TOKIMEKI_SESSION: "ab12.calm-otter",
      TOKIMEKI_SESSION_TOKEN: "session-jwt",
    });
    expect(result.warnings.join("\n")).toContain("short-lived");
  });

  it("prompts instead of accepting an empty history session token", async () => {
    const home = mkdtempSync(join(tmpdir(), "tokimeki-wizard-"));
    try {
      mkdirSync(join(home, ".tokimeki"), { recursive: true });
      const historyPath = join(home, ".tokimeki", "history.json");
      writeFileSync(
        historyPath,
        JSON.stringify([
          {
            relayUrl: "wss://relay.example",
            session: "abcde.laptop",
            sessionToken: "",
            lastUsedAt: 1,
          },
        ]),
        { mode: 0o600 },
      );
      if (process.platform !== "win32") chmodSync(historyPath, 0o600);
      const prompt = new FakePrompt({
        secret: ["session-token-1234"],
        confirm: [false],
        select: ["0"],
      });
      const result = await runAttachWizard({
        prompt,
        env: {},
        platform: process.platform,
        homeDir: home,
      });
      expect(result.env.TOKIMEKI_SESSION_TOKEN).toBe("session-token-1234");
      expect(prompt.printed.join("\n")).toContain("from history/environment");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("prefills a pasted viewer config JSON", async () => {
    const prompt = new FakePrompt({
      secret: [
        JSON.stringify({
          version: 1,
          relayUrl: "ws://127.0.0.1:8787",
          session: "abcde.laptop",
          sessionToken: "opaque-viewer-token",
        }),
      ],
      select: ["json"],
      confirm: [false],
    });
    const result = await runAttachWizard({
      prompt,
      env: {},
      platform: process.platform,
      homeDir: "/nonexistent-tokimeki-home",
    });
    expect(result.env).toMatchObject({
      TOKIMEKI_RELAY_URL: "ws://127.0.0.1:8787",
      TOKIMEKI_SESSION: "abcde.laptop",
      TOKIMEKI_SESSION_TOKEN: "opaque-viewer-token",
    });
    expect(result.hostedJwt).toBe(false);
  });

  it("rejects a viewer invite combined with --listen", async () => {
    const prompt = new FakePrompt({
      secret: ["https://tokiapi.app/#t-code123"],
      select: ["invite"],
    });
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith("/api/config")) {
        return jsonResponse(200, {
          tokimekiEnabled: true,
          tokimekiRelayUrl: "wss://relay.tokiapi.app",
        });
      }
      return jsonResponse(200, {
        token: "session-jwt",
        session: "ab12.calm-otter",
        mode: "viewer",
        passcodeRequired: false,
      });
    }) as unknown as typeof fetch;
    await expect(
      runAttachWizard({
        prompt,
        env: {},
        fetchImpl,
        listener: true,
        platform: process.platform,
        homeDir: "/nonexistent-tokimeki-home",
      }),
    ).rejects.toThrow(/remove --listen/);
  });
});
