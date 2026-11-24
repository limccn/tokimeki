/**
 * Doctor-first attach onboarding wizard (v1.4-C).
 *
 * Accepts a pasted v1/v2 viewer config JSON, a TokiAPI invite URL/code
 * (exchanged through the documented public endpoint), a history entry, or
 * manual relay/session/token input. The connection test itself reuses the real
 * AttachSession: this wizard only collects configuration.
 */

import { isValidSessionId } from "@limccn/tokimeki-protocol";
import {
  ConfigError,
  HOST_NAMESPACE_PATTERN,
  isNamespaceScopedSession,
  MAX_HOST_TOKEN_LENGTH,
  normalizeRelayBaseUrl,
} from "../config.js";
import { PASSCODE_PATTERN } from "../passcode.js";
import {
  addHistoryEntry,
  type HistoryEntry,
  looksLikeJwt,
  readHistory,
  writeUserConfig,
} from "../persist.js";
import { isInviteCode, parseAttachUrl } from "./attach-url.js";
import type { PromptIO } from "./prompt.js";
import {
  type AttachGrant,
  DEFAULT_HOSTED_RELAY_URL,
  DEFAULT_TOKIAPI_ORIGIN,
  exchangeAttachCode,
  getPublicConfig,
  normalizeProviderOrigin,
  type TokiApiDeps,
  TokiApiError,
  validateProviderRelayUrl,
} from "./tokiapi.js";

export interface AttachWizardDeps {
  readonly prompt: PromptIO;
  readonly env: NodeJS.ProcessEnv;
  readonly listener?: boolean;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly fetchImpl?: typeof fetch;
  readonly providerOrigin?: string;
  readonly defaultRelayUrl?: string;
  readonly history?: boolean;
  readonly saveConfig?: boolean;
}

export interface AttachWizardResult {
  readonly env: Record<string, string>;
  readonly listener: boolean;
  /** The session token came from a hosted invite exchange (short-lived JWT). */
  readonly hostedJwt: boolean;
  readonly relayUrl: string;
  readonly session: string;
  readonly sessionToken: string;
  readonly namespace?: string;
  readonly warnings: readonly string[];
  /** Offer after the first welcome: persist relay/session (+ opaque token). */
  readonly finalize: (() => Promise<readonly string[]>) | null;
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function normalizeAttachRelayUrl(raw: string): string {
  const normalized = normalizeRelayBaseUrl(raw);
  if (normalized.startsWith("ws://")) {
    const parsed = new URL(normalized);
    if (!isLoopbackHostname(parsed.hostname)) {
      throw new ConfigError("the relay URL must use wss:// (ws:// is loopback-only)");
    }
  }
  return normalized;
}

function parseViewerConfigJson(raw: string): {
  relayUrl: string | null;
  session: string | null;
  sessionToken: string | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError("the viewer config must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError("the viewer config must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const version = record.version ?? record.v;
  if (version !== undefined && version !== 1 && version !== 2) {
    throw new ConfigError("the viewer config version must be 1 or 2");
  }
  const stringField = (name: string): string | null => {
    const value = record[name];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || value.length === 0 || value.length > 8192) {
      throw new ConfigError(`viewer config field ${name} is invalid`);
    }
    return value;
  };
  return {
    relayUrl: stringField("relayUrl"),
    session: stringField("session"),
    sessionToken: stringField("sessionToken"),
  };
}

async function askSessionName(prompt: PromptIO, initial: string | null): Promise<string> {
  const candidate = initial;
  for (;;) {
    const raw = await prompt.text({
      message: "Session name",
      ...(candidate === null ? {} : { defaultValue: candidate }),
    });
    if (!isValidSessionId(raw)) {
      prompt.print("Session must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
      continue;
    }
    return raw;
  }
}

async function askRelay(
  prompt: PromptIO,
  initial: string | null,
  fallback: string,
): Promise<string> {
  let candidate = initial ?? fallback;
  for (;;) {
    const raw = await prompt.text({ message: "Relay URL", defaultValue: candidate });
    try {
      candidate = normalizeAttachRelayUrl(raw);
      return candidate;
    } catch (error) {
      prompt.print(error instanceof Error ? error.message : "relay URL is invalid");
    }
  }
}

async function askSessionToken(prompt: PromptIO, initial: string | null): Promise<string> {
  const candidate = initial;
  for (;;) {
    const raw =
      candidate === null
        ? await prompt.secret({ message: "Session token (hidden): " })
        : await prompt.secret({ message: "Session token (hidden, press Enter to keep current): " });
    const value = raw.length === 0 ? (candidate ?? "") : raw;
    if (value.length === 0 || value.length > MAX_HOST_TOKEN_LENGTH || /\s/.test(value)) {
      prompt.print(
        `Session token must be 1..${MAX_HOST_TOKEN_LENGTH} characters without whitespace`,
      );
      continue;
    }
    return value;
  }
}

async function askPasscode(prompt: PromptIO, env: NodeJS.ProcessEnv): Promise<string | null> {
  const existing = env.TOKIMEKI_PASSCODE;
  if (existing !== undefined && existing.length > 0) {
    return existing;
  }
  for (;;) {
    const raw = await prompt.secret({ message: "Session passcode (hidden, blank if none): " });
    if (raw.length === 0) return null;
    if (raw.length < 6 || raw.length > 128 || !PASSCODE_PATTERN.test(raw)) {
      prompt.print("Passcode must be 6..128 visible ASCII letters/digits and ._~@#*+=:-");
      continue;
    }
    return raw;
  }
}

function historyChoices(entries: readonly HistoryEntry[]): {
  choices: { label: string; value: string }[];
  byValue: Map<string, HistoryEntry>;
} {
  const byValue = new Map<string, HistoryEntry>();
  const choices: { label: string; value: string }[] = [];
  entries.forEach((entry, index) => {
    const value = String(index);
    byValue.set(value, entry);
    const updated = new Date(entry.lastUsedAt).toISOString().slice(0, 16).replace("T", " ");
    const token = entry.sessionToken === undefined ? "no token" : "token saved";
    choices.push({
      label: `${entry.session} @ ${entry.relayUrl} (${updated}, ${token})`,
      value,
    });
  });
  choices.push({ label: "Do not restore a previous connection", value: "none" });
  return { choices, byValue };
}

async function collectFromHistory(deps: AttachWizardDeps): Promise<{
  relayUrl: string;
  session: string;
  sessionToken: string | null;
  namespace?: string;
} | null> {
  if (deps.history === false) return null;
  let entries: readonly HistoryEntry[];
  try {
    entries = readHistory({ homeDir: deps.homeDir, platform: deps.platform }).entries;
  } catch (error) {
    deps.prompt.print(
      `[warn] ${error instanceof Error ? error.message : "history is unavailable"}`,
    );
    return null;
  }
  if (entries.length === 0) return null;
  const { choices, byValue } = historyChoices(entries);
  const selected = await deps.prompt.select({
    message: "Previous connections",
    choices,
    defaultIndex: choices.length - 1,
  });
  const entry = byValue.get(selected);
  if (entry === undefined) return null;
  return {
    relayUrl: entry.relayUrl,
    session: entry.session,
    sessionToken: entry.sessionToken ?? null,
    ...(entry.namespace === undefined ? {} : { namespace: entry.namespace }),
  };
}

async function collectFromInvite(
  deps: AttachWizardDeps,
  raw: string,
): Promise<{
  env: Record<string, string>;
  listener: boolean;
  hostedJwt: boolean;
  relayUrl: string;
  session: string;
  sessionToken: string;
  warnings: string[];
}> {
  const prompt = deps.prompt;
  const providerOrigin = normalizeProviderOrigin(
    deps.providerOrigin ?? deps.env.TOKIMEKI_TOKIAPI_URL ?? DEFAULT_TOKIAPI_ORIGIN,
  );
  let origin = providerOrigin;
  let code: string;
  if (/^https?:\/\//i.test(raw)) {
    const parsed = parseAttachUrl(raw);
    origin = parsed.origin;
    code = parsed.code;
  } else if (isInviteCode(raw)) {
    code = raw;
  } else {
    throw new ConfigError("the invite URL or code is invalid");
  }
  const tokiApiDeps: TokiApiDeps =
    deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl };
  for (;;) {
    try {
      const publicConfig = await getPublicConfig(origin, tokiApiDeps);
      if (!publicConfig.tokimekiEnabled) {
        throw new TokiApiError(
          "unavailable",
          "TokiAPI hosting is disabled (tokimekiEnabled=false)",
        );
      }
      const grant: AttachGrant = await exchangeAttachCode(origin, code, tokiApiDeps);
      let relayUrl: string;
      if (publicConfig.tokimekiRelayUrl !== null) {
        relayUrl = validateProviderRelayUrl(publicConfig.tokimekiRelayUrl, origin);
      } else if (new URL(origin).hostname.toLowerCase() === "tokiapi.app") {
        relayUrl = DEFAULT_HOSTED_RELAY_URL;
      } else {
        throw new TokiApiError(
          "schema",
          "the provider did not return tokimekiRelayUrl; refusing to guess a relay",
        );
      }
      if (grant.mode === "listener") {
        if (deps.listener !== true) {
          prompt.print("[ok] this invite is read-only; attaching as a listener (--listen)");
        }
      } else if (deps.listener === true) {
        throw new ConfigError("this invite is a viewer invite; remove --listen");
      }
      const passcode = grant.passcodeRequired ? await askPasscode(prompt, deps.env) : null;
      if (grant.passcodeRequired && passcode === null) {
        throw new ConfigError("this session requires a passcode");
      }
      const warnings: string[] = [
        "the hosted Session JWT is short-lived and will not be written to config/history",
        `the invite expires at ${grant.expiresAt === null ? "an unknown time" : new Date(grant.expiresAt * (grant.expiresAt < 1_000_000_000_000 ? 1000 : 1)).toISOString()}`,
      ];
      if (grant.allowWeb === false) {
        warnings.push("this invite does not allow the web viewer");
      }
      return {
        env: {
          TOKIMEKI_RELAY_URL: relayUrl,
          TOKIMEKI_SESSION: grant.session,
          TOKIMEKI_SESSION_TOKEN: grant.token,
          ...(passcode === null ? {} : { TOKIMEKI_PASSCODE: passcode }),
        },
        listener: grant.mode === "listener" || deps.listener === true,
        hostedJwt: true,
        relayUrl,
        session: grant.session,
        sessionToken: grant.token,
        warnings,
      };
    } catch (error) {
      if (!(error instanceof TokiApiError)) throw error;
      const suffix =
        error.retryAfterSeconds === null ? "" : ` (retry after ${error.retryAfterSeconds}s)`;
      prompt.print(`[warn] ${error.message}${suffix}`);
      if (error.kind === "invalid_invite") {
        throw error;
      }
      const retry = await prompt.confirm({
        message: "Retry the invite exchange?",
        defaultYes: error.kind === "network" || error.kind === "server",
      });
      if (!retry) throw error;
    }
  }
}

export async function runAttachWizard(deps: AttachWizardDeps): Promise<AttachWizardResult> {
  const prompt = deps.prompt;
  const env = deps.env;
  const warnings: string[] = [];
  const defaultRelay = deps.defaultRelayUrl ?? DEFAULT_HOSTED_RELAY_URL;

  const historyEntry = await collectFromHistory(deps);
  let initialRelay = env.TOKIMEKI_RELAY_URL ?? historyEntry?.relayUrl ?? null;
  let initialSession = env.TOKIMEKI_SESSION ?? historyEntry?.session ?? null;
  let initialToken = env.TOKIMEKI_SESSION_TOKEN ?? historyEntry?.sessionToken ?? null;
  let namespace = env.TOKIMEKI_NAMESPACE ?? historyEntry?.namespace ?? null;
  let passcode = env.TOKIMEKI_PASSCODE ?? null;
  let hostedJwt = false;
  let listener = deps.listener === true;

  const complete = initialRelay !== null && initialSession !== null && initialToken !== null;
  if (!complete) {
    if (initialRelay !== null && initialSession !== null && initialToken === null) {
      // History/env supplied everything except the token: ask only for it.
      prompt.print(`[ok] using ${initialSession} from history/environment`);
      initialToken = await askSessionToken(prompt, null);
    } else if (initialToken !== null && initialSession !== null && initialRelay === null) {
      initialRelay = await askRelay(prompt, null, defaultRelay);
    } else {
      const source = await prompt.select({
        message: "How do you want to attach?",
        choices: [
          { label: "Invite URL or code (TokiAPI)", value: "invite" },
          { label: "Viewer config JSON (version 1/2)", value: "json" },
          { label: "Manual relay/session/token", value: "manual" },
        ],
      });

      if (source === "invite") {
        for (;;) {
          const raw = await prompt.secret({
            message: "Paste the invite URL or code (hidden): ",
          });
          if (raw.length === 0) {
            prompt.print("An invite URL or code is required.");
            continue;
          }
          try {
            const collected = await collectFromInvite(deps, raw);
            initialRelay = collected.relayUrl;
            initialSession = collected.session;
            initialToken = collected.sessionToken;
            namespace = namespace ?? collected.env.TOKIMEKI_NAMESPACE ?? null;
            hostedJwt = collected.hostedJwt;
            listener = collected.listener;
            warnings.push(...collected.warnings);
            if (collected.env.TOKIMEKI_PASSCODE !== undefined) {
              passcode = collected.env.TOKIMEKI_PASSCODE;
            }
            break;
          } catch (error) {
            if (error instanceof TokiApiError && error.kind === "invalid_invite") {
              prompt.print("The invite is invalid or expired; paste a new one or go back.");
              const again = await prompt.confirm({
                message: "Paste another invite?",
                defaultYes: true,
              });
              if (again) continue;
            }
            throw error;
          }
        }
      } else if (source === "json") {
        for (;;) {
          const raw = await prompt.secret({
            message: "Paste the viewer config JSON (hidden): ",
          });
          try {
            const parsed = parseViewerConfigJson(raw);
            if (parsed.relayUrl !== null) initialRelay = parsed.relayUrl;
            if (parsed.session !== null) initialSession = parsed.session;
            if (parsed.sessionToken !== null) initialToken = parsed.sessionToken;
            break;
          } catch (error) {
            prompt.print(error instanceof Error ? error.message : "invalid viewer config");
          }
        }
      }
    }
  } else {
    prompt.print(`[ok] using ${initialSession} from history/environment`);
  }

  if (initialRelay === null) {
    initialRelay = await askRelay(prompt, null, defaultRelay);
  } else {
    try {
      initialRelay = normalizeAttachRelayUrl(initialRelay);
    } catch {
      initialRelay = await askRelay(prompt, null, defaultRelay);
    }
  }
  if (initialSession === null) {
    initialSession = await askSessionName(prompt, null);
  } else if (!isValidSessionId(initialSession)) {
    initialSession = await askSessionName(prompt, null);
  }
  if (initialToken === null) {
    initialToken = await askSessionToken(prompt, null);
  } else if (initialToken.length > MAX_HOST_TOKEN_LENGTH || /\s/.test(initialToken)) {
    initialToken = await askSessionToken(prompt, null);
  }
  if (looksLikeJwt(initialToken)) {
    hostedJwt = true;
    warnings.push("the session token looks like a hosted Session JWT; it is kept in memory only");
  }
  if (namespace !== null && !HOST_NAMESPACE_PATTERN.test(namespace)) {
    namespace = null;
  }
  if (namespace === null) {
    const dot = initialSession.indexOf(".");
    if (dot > 0 && dot <= 32) {
      const candidate = initialSession.slice(0, dot);
      if (HOST_NAMESPACE_PATTERN.test(candidate)) namespace = candidate;
    }
  }
  if (namespace !== null && !isNamespaceScopedSession(initialSession, namespace)) {
    namespace = null;
  }

  const overlay: Record<string, string> = {
    TOKIMEKI_RELAY_URL: initialRelay,
    TOKIMEKI_SESSION: initialSession,
    TOKIMEKI_SESSION_TOKEN: initialToken,
    ...(passcode === null ? {} : { TOKIMEKI_PASSCODE: passcode }),
  };

  const finalize = async (): Promise<readonly string[]> => {
    const output: string[] = [];
    if (deps.saveConfig === false) return output;
    const save = await prompt.confirm({
      message: "Save this connection for next time (~/.tokimeki/config.json/history.json)?",
      defaultYes: false,
    });
    if (!save) return output;
    try {
      if (!hostedJwt) {
        const result = writeUserConfig(
          {
            relayUrl: initialRelay ?? undefined,
            session: initialSession ?? undefined,
            sessionToken: initialToken ?? undefined,
          },
          { platform: deps.platform ?? process.platform },
        );
        output.push(...result.warnings);
      }
      const historyResult = addHistoryEntry(
        {
          relayUrl: initialRelay ?? "",
          session: initialSession ?? "",
          ...(namespace === null ? {} : { namespace }),
          ...(hostedJwt ? {} : { sessionToken: initialToken ?? undefined }),
        },
        { platform: deps.platform ?? process.platform },
      );
      output.push(...historyResult.warnings);
      prompt.print("[ok] connection saved");
    } catch (error) {
      output.push(error instanceof Error ? error.message : "unable to save the connection");
    }
    return output;
  };

  return {
    env: overlay,
    listener,
    hostedJwt,
    relayUrl: initialRelay,
    session: initialSession,
    sessionToken: initialToken,
    ...(namespace === null ? {} : { namespace }),
    warnings,
    finalize,
  };
}
