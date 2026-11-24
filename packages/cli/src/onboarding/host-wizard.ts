/**
 * Doctor-first host onboarding wizard (v1.4-B).
 *
 * Three paths:
 *   A. the user already has a relay host token (TOKIMEKI_TOKEN recommended,
 *      TOKIMEKI_MASTER_TOKEN accepted as a deprecated compatibility alias);
 *   B. self-hosted relay without a token: show the one-click deploy/docs and
 *      stop (the wizard never runs wrangler or touches Cloudflare credentials);
 *   C. the hosted relay without a token: request an anonymous Host JWT from the
 *      documented TokiAPI public endpoint.
 */

import { randomBytes } from "node:crypto";
import { isValidSessionId } from "@limccn/tokimeki-protocol";
import {
  ConfigError,
  HOST_NAMESPACE_PATTERN,
  isNamespaceScopedSession,
  MAX_HOST_TOKEN_LENGTH,
  normalizeRelayBaseUrl,
  relayWhoamiUrl,
} from "../config.js";
import { checkSecretFilePermissions } from "../config-file.js";
import { readJsonObjectCapped } from "../http-body.js";
import { looksLikeJwt, writeUserConfig } from "../persist.js";
import type { PromptIO } from "./prompt.js";
import { UserAbortError } from "./prompt.js";
import {
  DEFAULT_HOSTED_RELAY_URL,
  DEFAULT_TOKIAPI_ORIGIN,
  getPublicConfig,
  normalizeProviderOrigin,
  requestAnonymousHost,
  type TokiApiDeps,
  TokiApiError,
  validateProviderRelayUrl,
} from "./tokiapi.js";

export const DEPLOY_BUTTON_URL =
  "https://deploy.workers.cloudflare.com/?url=https://github.com/limccn/tokimeki";

export interface HostWizardDeps {
  readonly prompt: PromptIO;
  readonly env: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly fetchImpl?: typeof fetch;
  readonly providerOrigin?: string;
  readonly defaultRelayUrl?: string;
  readonly saveConfig?: boolean;
  readonly now?: () => number;
}

export interface HostWizardResult {
  /** Env keys to overlay on the resolved config env. */
  readonly env: Record<string, string>;
  /** Capability secret returned by the anonymous path; memory only. */
  readonly inviteUrl?: string;
  /** Anonymous Host JWT expiry (provider units, diagnostic only). */
  readonly expiresAt?: number;
  /** True when the user was guided to self-deploy and host startup stopped. */
  readonly stopped?: boolean;
  readonly savedConfig?: boolean;
  readonly warnings: readonly string[];
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** Wizard relay URLs must be wss/https; plain ws is allowed only on loopback. */
export function normalizeWizardRelayUrl(raw: string): string {
  const normalized = normalizeRelayBaseUrl(raw);
  if (normalized.startsWith("ws://")) {
    const parsed = new URL(normalized);
    if (!isLoopbackHostname(parsed.hostname)) {
      throw new ConfigError("the relay URL must use wss:// (ws:// is loopback-only)");
    }
  }
  return normalized;
}

function isDefaultHostedRelay(relayUrl: string): boolean {
  try {
    const parsed = new URL(relayUrl);
    return parsed.hostname.toLowerCase() === "relay.tokiapi.app";
  } catch {
    return false;
  }
}

export function formatExpiry(expiresAt: number | null): string {
  if (expiresAt === null) return "unknown (provider returned no expiresAt)";
  const milliseconds = expiresAt < 1_000_000_000_000 ? expiresAt * 1000 : expiresAt;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toISOString();
}

function validateTokenValue(name: string, token: string): void {
  if (token.length === 0 || token.length > MAX_HOST_TOKEN_LENGTH) {
    throw new ConfigError(`${name} must be 1..${MAX_HOST_TOKEN_LENGTH} characters`);
  }
  if (/\s/.test(token)) {
    throw new ConfigError(`${name} must not contain whitespace`);
  }
}

interface WhoamiResult {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * Validate the effective host credential with `/auth/whoami`.
 *
 * The response body is remote input: only authMode/namespace are echoed, and
 * the namespace must match the configured one for namespace/JWT auth.
 */
export async function validateHostCredentials(options: {
  relayUrl: string;
  credential: string;
  namespace: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<WhoamiResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(relayWhoamiUrl(options.relayUrl), {
      headers: { "X-Tokimeki-Token": options.credential },
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch {
    return {
      ok: false,
      message:
        "relay whoami is unreachable; check the relay URL/network (credentials were not retried automatically)",
    };
  }
  if (response.status === 401 || response.status === 404) {
    return {
      ok: false,
      message: `relay whoami returned HTTP ${response.status}; the token is invalid for this relay or auth mode`,
    };
  }
  if (!response.ok) {
    return { ok: false, message: `relay whoami returned HTTP ${response.status}` };
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = await readJsonObjectCapped(response);
  } catch {
    body = null;
  }
  const authMode = body?.authMode;
  const remoteNamespace = typeof body?.namespace === "string" ? body.namespace : null;
  const modeText =
    authMode === "jwt" || authMode === "namespace" || authMode === "master"
      ? `auth=${authMode}`
      : "auth=unknown";
  if (
    remoteNamespace !== null &&
    options.namespace !== null &&
    remoteNamespace !== options.namespace
  ) {
    return {
      ok: false,
      message: `relay whoami namespace does not match TOKIMEKI_NAMESPACE (${modeText})`,
    };
  }
  return { ok: true, message: `relay whoami authenticated (${modeText})` };
}

function printSelfHostedGuidance(prompt: PromptIO): void {
  prompt.print("");
  prompt.print("This relay is not the hosted default and no host token is configured.");
  prompt.print("Deploy your own relay with the one-click Cloudflare Deploy Button:");
  prompt.print(`  ${DEPLOY_BUTTON_URL}`);
  prompt.print("Or follow docs/deploy-cloudflare.md.");
  prompt.print("");
  prompt.print("Then configure a host credential on the relay and locally:");
  prompt.print('  relay:  TOKIMEKI_NAMESPACE_TOKENS={"<namespace>":"<token>"}');
  prompt.print("  local:  TOKIMEKI_TOKEN=<token> and TOKIMEKI_NAMESPACE=<namespace>");
  prompt.print(
    "  (TOKIMEKI_MASTER_TOKEN remains a deprecated compatibility alias; recommend TOKIMEKI_TOKEN.)",
  );
  prompt.print("");
  prompt.print(
    "The wizard only guides you; it never runs wrangler or touches Cloudflare credentials.",
  );
}

async function askRelayUrl(deps: HostWizardDeps, initial: string): Promise<string> {
  const candidate = initial;
  for (;;) {
    const raw = await deps.prompt.text({
      message: "Relay URL",
      defaultValue: candidate,
    });
    try {
      return normalizeWizardRelayUrl(raw);
    } catch (error) {
      deps.prompt.print(error instanceof Error ? error.message : "relay URL is invalid");
    }
  }
}

async function askNamespace(
  deps: HostWizardDeps,
  initial: string | null,
  session: string | null,
): Promise<string> {
  for (;;) {
    const raw = await deps.prompt.text({
      message: "Namespace",
      ...(initial === null ? {} : { defaultValue: initial }),
    });
    if (!HOST_NAMESPACE_PATTERN.test(raw)) {
      deps.prompt.print("Namespace must match ^[a-z0-9][a-z0-9_-]{0,31}$");
      continue;
    }
    if (session !== null && !isNamespaceScopedSession(session, raw)) {
      deps.prompt.print(`TOKIMEKI_SESSION must start with "${raw}."`);
      continue;
    }
    return raw;
  }
}

async function askSession(
  deps: HostWizardDeps,
  initial: string | null,
  namespace: string | null,
): Promise<string | undefined> {
  if (initial === null) {
    const custom = await deps.prompt.confirm({
      message: "Choose a session name now? (otherwise it is derived from the hostname)",
      defaultYes: false,
    });
    if (!custom) return undefined;
  }
  for (;;) {
    const raw = await deps.prompt.text({
      message: "Session name",
      ...(initial === null ? {} : { defaultValue: initial }),
    });
    if (!isValidSessionId(raw)) {
      deps.prompt.print("Session must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
      continue;
    }
    if (namespace !== null && !isNamespaceScopedSession(raw, namespace)) {
      deps.prompt.print(`Session must start with "${namespace}."`);
      continue;
    }
    return raw;
  }
}

async function maybeValidate(
  deps: HostWizardDeps,
  relayUrl: string,
  credential: string,
  namespace: string | null,
): Promise<void> {
  const result = await validateHostCredentials({
    relayUrl,
    credential,
    namespace,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  });
  deps.prompt.print(result.ok ? `[ok] ${result.message}` : `[warn] ${result.message}`);
  if (!result.ok) {
    const retry = await deps.prompt.confirm({
      message: "Retry the relay check?",
      defaultYes: true,
    });
    if (retry) {
      await maybeValidate(deps, relayUrl, credential, namespace);
    }
  }
}

async function saveConfigIfRequested(
  deps: HostWizardDeps,
  values: {
    relayUrl: string;
    namespace?: string;
    token?: string;
    session?: string;
    sessionToken?: string;
  },
): Promise<{ saved: boolean; warnings: string[] }> {
  const warnings: string[] = [];
  if (deps.saveConfig === false) return { saved: false, warnings };
  const wants = await deps.prompt.confirm({
    message: "Save these settings to ~/.tokimeki/config.json (0600)?",
    defaultYes: false,
  });
  if (!wants) return { saved: false, warnings };
  try {
    const result = writeUserConfig(values, {
      platform: deps.platform ?? process.platform,
    });
    warnings.push(...result.warnings);
    deps.prompt.print(`[ok] saved ${result.path}`);
    return { saved: true, warnings };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unable to save config";
    deps.prompt.print(`[warn] ${message}; the host will continue without saving`);
    return { saved: false, warnings };
  }
}

export async function runHostWizard(deps: HostWizardDeps): Promise<HostWizardResult> {
  const env = deps.env;
  const warnings: string[] = [];
  const prompt = deps.prompt;
  const providerOrigin = normalizeProviderOrigin(
    deps.providerOrigin ?? env.TOKIMEKI_TOKIAPI_URL ?? DEFAULT_TOKIAPI_ORIGIN,
  );
  const defaultRelay = deps.defaultRelayUrl ?? DEFAULT_HOSTED_RELAY_URL;
  const relayUrl = await askRelayUrl(
    deps,
    env.TOKIMEKI_RELAY_URL !== undefined && env.TOKIMEKI_RELAY_URL.length > 0
      ? env.TOKIMEKI_RELAY_URL
      : defaultRelay,
  );

  let credentialKey: "TOKIMEKI_TOKEN" | "TOKIMEKI_MASTER_TOKEN" | null = null;
  let credential: string | null = null;
  if (env.TOKIMEKI_TOKEN !== undefined && env.TOKIMEKI_TOKEN.length > 0) {
    credentialKey = "TOKIMEKI_TOKEN";
    credential = env.TOKIMEKI_TOKEN;
  } else if (env.TOKIMEKI_MASTER_TOKEN !== undefined && env.TOKIMEKI_MASTER_TOKEN.length > 0) {
    credentialKey = "TOKIMEKI_MASTER_TOKEN";
    credential = env.TOKIMEKI_MASTER_TOKEN;
  }

  if (credential === null) {
    const hasToken = await prompt.confirm({
      message: "Do you already have a host token for this relay?",
      defaultYes: true,
    });
    if (!hasToken) {
      if (!isDefaultHostedRelay(relayUrl)) {
        printSelfHostedGuidance(prompt);
        return { env: {}, stopped: true, warnings };
      }
      return await runAnonymousHost(deps, relayUrl, providerOrigin, warnings);
    }
    const kind = await prompt.select({
      message: "Credential type",
      choices: [
        { label: "TOKIMEKI_TOKEN (recommended)", value: "token" },
        { label: "TOKIMEKI_MASTER_TOKEN (deprecated compatibility alias)", value: "master" },
      ],
    });
    for (;;) {
      const entered = await prompt.secret({
        message: kind === "token" ? "Host token (hidden): " : "Master token (hidden): ",
      });
      try {
        validateTokenValue(kind === "token" ? "TOKIMEKI_TOKEN" : "TOKIMEKI_MASTER_TOKEN", entered);
        credential = entered;
        credentialKey = kind === "token" ? "TOKIMEKI_TOKEN" : "TOKIMEKI_MASTER_TOKEN";
        break;
      } catch (error) {
        prompt.print(error instanceof Error ? error.message : "invalid token");
      }
    }
  }

  const namespace =
    credentialKey === "TOKIMEKI_TOKEN"
      ? await askNamespace(deps, env.TOKIMEKI_NAMESPACE ?? null, env.TOKIMEKI_SESSION ?? null)
      : (env.TOKIMEKI_NAMESPACE ?? null);

  // The master token is a single-owner/root credential: the loader ignores
  // TOKIMEKI_NAMESPACE with it, and the doctor gate rejects a lingering
  // namespace. Keep the entered namespace for session naming only, and clear
  // it from the effective environment/config.
  const namespaceForEnv = credentialKey === "TOKIMEKI_TOKEN" ? namespace : null;
  if (credentialKey === "TOKIMEKI_MASTER_TOKEN") {
    warnings.push(
      "TOKIMEKI_MASTER_TOKEN is a deprecated compatibility alias; the token is not written to config.json",
    );
    if (namespace !== null) {
      warnings.push("TOKIMEKI_NAMESPACE is ignored with TOKIMEKI_MASTER_TOKEN");
    }
  }

  await maybeValidate(deps, relayUrl, credential, namespaceForEnv);

  const session = await askSession(deps, env.TOKIMEKI_SESSION ?? null, namespace);
  const envSessionToken =
    env.TOKIMEKI_SESSION_TOKEN !== undefined && env.TOKIMEKI_SESSION_TOKEN.length > 0
      ? env.TOKIMEKI_SESSION_TOKEN
      : randomBytes(32).toString("base64url");
  if (envSessionToken === credential) {
    throw new ConfigError("the host credential and session token must be different");
  }

  if (credential === null || credentialKey === null) {
    throw new ConfigError("host credentials were not collected");
  }
  const overlay: Record<string, string> = {
    TOKIMEKI_RELAY_URL: relayUrl,
    [credentialKey]: credential,
    TOKIMEKI_SESSION_TOKEN: envSessionToken,
    ...(namespaceForEnv === null
      ? { TOKIMEKI_NAMESPACE: "" }
      : { TOKIMEKI_NAMESPACE: namespaceForEnv }),
    ...(session === undefined ? {} : { TOKIMEKI_SESSION: session }),
  };

  const saved = await saveConfigIfRequested(deps, {
    relayUrl,
    ...(credentialKey === "TOKIMEKI_TOKEN"
      ? {
          ...(namespace === null ? {} : { namespace }),
          token: credential,
        }
      : { namespace: "", token: "" }),
    ...(session === undefined ? {} : { session }),
    sessionToken: envSessionToken,
  });
  warnings.push(...saved.warnings);

  return {
    env: overlay,
    savedConfig: saved.saved,
    warnings,
  };
}

async function runAnonymousHost(
  deps: HostWizardDeps,
  relayUrl: string,
  providerOrigin: string,
  warnings: string[],
): Promise<HostWizardResult> {
  const prompt = deps.prompt;
  const tokiApiDeps: TokiApiDeps =
    deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl };
  prompt.print("");
  prompt.print(`No host token found; requesting an anonymous namespace from ${providerOrigin} ...`);

  let publicConfig: Awaited<ReturnType<typeof getPublicConfig>>;
  try {
    publicConfig = await getPublicConfig(providerOrigin, tokiApiDeps);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unable to read TokiAPI config";
    prompt.print(`[warn] ${message}`);
    prompt.print("Anonymous hosting is unavailable right now; self-host a relay or retry later.");
    return { env: {}, stopped: true, warnings };
  }
  if (!publicConfig.tokimekiEnabled) {
    prompt.print("[warn] TokiAPI anonymous hosting is disabled (tokimekiEnabled=false).");
    prompt.print("Self-host a relay or retry later.");
    return { env: {}, stopped: true, warnings };
  }
  let effectiveRelay = relayUrl;
  if (publicConfig.tokimekiRelayUrl !== null) {
    try {
      effectiveRelay = validateProviderRelayUrl(publicConfig.tokimekiRelayUrl, providerOrigin);
    } catch (error) {
      prompt.print(
        `[warn] ${error instanceof Error ? error.message : "provider relay URL is invalid"}`,
      );
      prompt.print("Refusing to send credentials to an unbound relay.");
      return { env: {}, stopped: true, warnings };
    }
  }

  for (;;) {
    try {
      const grant = await requestAnonymousHost(providerOrigin, tokiApiDeps);
      prompt.print(`[ok] anonymous namespace: ${grant.namespace}`);
      prompt.print(`[ok] session: ${grant.session}`);
      prompt.print(`[ok] host JWT expires at: ${formatExpiry(grant.expiresAt)}`);
      if (grant.inviteUrl !== null) {
        prompt.print("");
        prompt.print("Invite URL (capability secret, shown once; not saved):");
        prompt.print(grant.inviteUrl);
        prompt.print("Share it only with the person who should attach.");
      } else {
        prompt.print("No invite URL was returned; share the viewer config from the host menu.");
      }
      const envSessionToken =
        deps.env.TOKIMEKI_SESSION_TOKEN !== undefined && deps.env.TOKIMEKI_SESSION_TOKEN.length > 0
          ? deps.env.TOKIMEKI_SESSION_TOKEN
          : randomBytes(32).toString("base64url");
      const saved = await saveConfigIfRequested(deps, {
        relayUrl: effectiveRelay,
        namespace: grant.namespace,
        token: grant.token,
        session: grant.session,
        sessionToken: envSessionToken,
      });
      warnings.push(...saved.warnings);
      warnings.push(
        "anonymous host JWTs expire; when they do, request a new namespace/session (the name may change)",
      );
      return {
        env: {
          TOKIMEKI_RELAY_URL: effectiveRelay,
          TOKIMEKI_TOKEN: grant.token,
          TOKIMEKI_NAMESPACE: grant.namespace,
          TOKIMEKI_SESSION: grant.session,
          TOKIMEKI_SESSION_TOKEN: envSessionToken,
        },
        ...(grant.inviteUrl === null ? {} : { inviteUrl: grant.inviteUrl }),
        ...(grant.expiresAt === null ? {} : { expiresAt: grant.expiresAt }),
        savedConfig: saved.saved,
        warnings,
      };
    } catch (error) {
      if (!(error instanceof TokiApiError)) throw error;
      const retryAfter =
        error.retryAfterSeconds === null ? "" : ` (retry after ${error.retryAfterSeconds}s)`;
      prompt.print(`[warn] ${error.message}${retryAfter}`);
      if (error.kind === "rate_limited") {
        const retry = await prompt.confirm({
          message: "Retry the anonymous request now?",
          defaultYes: false,
        });
        if (retry) continue;
        return { env: {}, stopped: true, warnings };
      }
      if (error.kind === "network" || error.kind === "server") {
        const retry = await prompt.confirm({
          message: "Retry once?",
          defaultYes: true,
        });
        if (retry) continue;
      }
      prompt.print("Anonymous hosting failed; self-host a relay or retry later.");
      return { env: {}, stopped: true, warnings };
    }
  }
}

export function isUserAbort(error: unknown): boolean {
  return error instanceof UserAbortError;
}

export function describeJwtShape(value: string): string {
  return looksLikeJwt(value) ? "Session JWT" : "opaque token";
}

export function configFileModeWarning(
  path: string,
  mode: number,
  platform: NodeJS.Platform,
): string | null {
  const verdict = checkSecretFilePermissions(mode, platform);
  if (verdict === "insecure") return `${path} must be 0600 when it contains credentials`;
  if (verdict === "not-enforced") return `${path} permissions are not enforced on Windows`;
  return null;
}
