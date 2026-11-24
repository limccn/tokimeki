/**
 * Lightweight, network-free pre-flight gate for host/attach startup.
 *
 * It reuses the configuration validators but never contacts the relay and never
 * prints a value. Interactive mode turns a failed gate into the onboarding
 * wizard; daemon mode turns it into a structured `error` event and an exit
 * code (2 for configuration problems).
 */

import { isValidSessionId, MAX_SESSION_ID_LENGTH } from "@limccn/tokimeki-protocol";
import type { CliMode } from "./cli-mode.js";
import {
  ConfigError,
  HOST_NAMESPACE_PATTERN,
  isNamespaceScopedSession,
  MAX_HOST_TOKEN_LENGTH,
  normalizeRelayBaseUrl,
} from "./config.js";
import type { CliEventErrorCode } from "./events.js";
import { isLogLevel, type LogLevel } from "./logger.js";

export interface DoctorGateIssue {
  readonly code: CliEventErrorCode;
  readonly message: string;
  readonly exitCode: 0 | 1 | 2;
}

export interface DoctorGateInput {
  readonly command: "host" | "attach";
  readonly env: NodeJS.ProcessEnv;
  readonly mode: CliMode;
}

export interface DoctorGateResult {
  readonly ok: boolean;
  readonly issues: readonly DoctorGateIssue[];
}

function issue(code: CliEventErrorCode, message: string, exitCode: 0 | 1 | 2 = 2): DoctorGateIssue {
  return { code, message, exitCode };
}

function optional(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function relayIssue(env: NodeJS.ProcessEnv): DoctorGateIssue | null {
  const raw = optional(env, "TOKIMEKI_RELAY_URL");
  if (raw === null) {
    return issue("config_invalid", "TOKIMEKI_RELAY_URL is required");
  }
  try {
    normalizeRelayBaseUrl(raw);
    return null;
  } catch (error) {
    return issue(
      "config_invalid",
      error instanceof ConfigError ? error.message : "TOKIMEKI_RELAY_URL is invalid",
    );
  }
}

function hostIssues(env: NodeJS.ProcessEnv): DoctorGateIssue[] {
  const issues: DoctorGateIssue[] = [];
  const token = optional(env, "TOKIMEKI_TOKEN");
  const master = optional(env, "TOKIMEKI_MASTER_TOKEN");
  const namespace = optional(env, "TOKIMEKI_NAMESPACE");
  const session = optional(env, "TOKIMEKI_SESSION");
  const sessionToken = optional(env, "TOKIMEKI_SESSION_TOKEN");

  if (token === null && master === null) {
    issues.push(
      issue(
        "config_invalid",
        "TOKIMEKI_TOKEN or TOKIMEKI_MASTER_TOKEN is required (TOKIMEKI_MASTER_TOKEN is a deprecated compatibility alias)",
      ),
    );
  }
  if (token !== null) {
    if (token.length > MAX_HOST_TOKEN_LENGTH) {
      issues.push(
        issue(
          "config_invalid",
          `TOKIMEKI_TOKEN must be at most ${MAX_HOST_TOKEN_LENGTH} characters`,
        ),
      );
    }
    if (/\s/.test(token)) {
      issues.push(issue("config_invalid", "TOKIMEKI_TOKEN must not contain whitespace"));
    }
    if (namespace === null) {
      issues.push(
        issue("config_invalid", "TOKIMEKI_NAMESPACE and TOKIMEKI_TOKEN must be set together"),
      );
    } else if (!HOST_NAMESPACE_PATTERN.test(namespace)) {
      issues.push(
        issue("config_invalid", "TOKIMEKI_NAMESPACE must match ^[a-z0-9][a-z0-9_-]{0,31}$"),
      );
    }
  }
  if (namespace !== null && token === null) {
    issues.push(
      issue("config_invalid", "TOKIMEKI_NAMESPACE is set without TOKIMEKI_TOKEN; it is ignored"),
    );
  }
  if (session !== null) {
    if (!isValidSessionId(session)) {
      issues.push(
        issue(
          "config_invalid",
          `TOKIMEKI_SESSION must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,${MAX_SESSION_ID_LENGTH - 1}}$`,
        ),
      );
    } else if (
      token !== null &&
      namespace !== null &&
      !isNamespaceScopedSession(session, namespace)
    ) {
      issues.push(
        issue(
          "config_invalid",
          `TOKIMEKI_SESSION must start with "${namespace}." when TOKIMEKI_TOKEN is set`,
        ),
      );
    }
  }
  if (sessionToken !== null) {
    if (sessionToken.length > MAX_HOST_TOKEN_LENGTH) {
      issues.push(
        issue(
          "config_invalid",
          `TOKIMEKI_SESSION_TOKEN must be at most ${MAX_HOST_TOKEN_LENGTH} characters`,
        ),
      );
    }
    if (/\s/.test(sessionToken)) {
      issues.push(issue("config_invalid", "TOKIMEKI_SESSION_TOKEN must not contain whitespace"));
    }
    if (sessionToken === token || sessionToken === master) {
      issues.push(
        issue("config_invalid", "the host credential and TOKIMEKI_SESSION_TOKEN must be different"),
      );
    }
  }
  if (env.TOKIMEKI_NAMESPACE_TOKEN !== undefined && env.TOKIMEKI_NAMESPACE_TOKEN.length > 0) {
    issues.push(
      issue("config_invalid", "TOKIMEKI_NAMESPACE_TOKEN is retired; rename it to TOKIMEKI_TOKEN"),
    );
  }
  const relay = relayIssue(env);
  if (relay !== null) issues.push(relay);
  return issues;
}

function attachIssues(env: NodeJS.ProcessEnv): DoctorGateIssue[] {
  const issues: DoctorGateIssue[] = [];
  const session = optional(env, "TOKIMEKI_SESSION");
  if (session === null) {
    issues.push(issue("config_invalid", "TOKIMEKI_SESSION is required"));
  } else if (!isValidSessionId(session)) {
    issues.push(
      issue(
        "config_invalid",
        `TOKIMEKI_SESSION must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,${MAX_SESSION_ID_LENGTH - 1}}$`,
      ),
    );
  }

  const sessionToken = optional(env, "TOKIMEKI_SESSION_TOKEN");
  if (sessionToken === null) {
    issues.push(issue("config_invalid", "TOKIMEKI_SESSION_TOKEN is required"));
  } else {
    if (sessionToken.length > MAX_HOST_TOKEN_LENGTH) {
      issues.push(
        issue(
          "config_invalid",
          `TOKIMEKI_SESSION_TOKEN must be at most ${MAX_HOST_TOKEN_LENGTH} characters`,
        ),
      );
    }
    if (/\s/.test(sessionToken)) {
      issues.push(issue("config_invalid", "TOKIMEKI_SESSION_TOKEN must not contain whitespace"));
    }
  }
  if (env.TOKIMEKI_NAMESPACE_TOKEN !== undefined && env.TOKIMEKI_NAMESPACE_TOKEN.length > 0) {
    issues.push(
      issue("config_invalid", "TOKIMEKI_NAMESPACE_TOKEN is retired; rename it to TOKIMEKI_TOKEN"),
    );
  }
  const relay = relayIssue(env);
  if (relay !== null) issues.push(relay);
  return issues;
}

export function runDoctorGate(input: DoctorGateInput): DoctorGateResult {
  const issues = input.command === "host" ? hostIssues(input.env) : attachIssues(input.env);
  return { ok: issues.length === 0, issues };
}

/** True when a configuration is complete enough for the daemon status event. */
export function configurationSummary(env: NodeJS.ProcessEnv): {
  readonly configured: boolean;
  readonly relay?: string;
  readonly namespace?: string;
  readonly session?: string;
} {
  const relay = optional(env, "TOKIMEKI_RELAY_URL");
  const namespace = optional(env, "TOKIMEKI_NAMESPACE");
  const session = optional(env, "TOKIMEKI_SESSION");
  const host =
    optional(env, "TOKIMEKI_TOKEN") !== null || optional(env, "TOKIMEKI_MASTER_TOKEN") !== null;
  const attach = session !== null && optional(env, "TOKIMEKI_SESSION_TOKEN") !== null;
  return {
    configured: relay !== null && (host || attach),
    ...(relay === null ? {} : { relay }),
    ...(namespace === null ? {} : { namespace }),
    ...(session === null ? {} : { session }),
  };
}

/** Narrow a raw log level for daemon event/summary typing (silent never hides events). */
export function eventLogLevel(raw: string | undefined): LogLevel {
  return raw !== undefined && isLogLevel(raw) ? raw : "info";
}
