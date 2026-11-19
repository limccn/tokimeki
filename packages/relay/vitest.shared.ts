import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

/** Absolute package root shared by the relay test configs. */
export const relayRoot = dirname(fileURLToPath(import.meta.url));

export interface RelayWorkersConfigOptions {
  readonly include: string[];
  readonly exclude?: string[];
  /** Defaults to `true`; quota/TTL tests run in their own process without it. */
  readonly isolatedStorage?: boolean;
  /**
   * Absolute session TTL for the suite. The main suite sets `"0"`: leaving an
   * absolute alarm armed on every test session makes the Windows
   * isolated-storage teardown intermittently fail (EBUSY / unexpected
   * `-wal`/`-journal`). The dedicated quota suite runs with the production
   * default (86400), so the alarm paths are still covered.
   */
  readonly sessionMaxTtlSeconds?: string;
}

/**
 * Relay test config with the shared miniflare bindings.
 *
 * The quota/TTL suite is split into `vitest.quotas.config.ts`: on Windows,
 * `isolatedStorage` storage-stack copies intermittently fail with EBUSY /
 * unexpected `-wal`/`-journal` files when many DO-heavy files have run in one
 * process. That suite uses unique session ids per test and does not need
 * per-test storage isolation.
 */
export function relayWorkersConfig(options: RelayWorkersConfigOptions) {
  return defineWorkersConfig({
    root: relayRoot,
    test: {
      include: options.include,
      ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
      poolOptions: {
        workers: {
          singleWorker: true,
          isolatedStorage: options.isolatedStorage ?? true,
          wrangler: {
            configPath: "./wrangler.jsonc",
          },
          miniflare: {
            bindings: {
              // Test-only values. Production values come from Worker vars/secrets.
              TOKIMEKI_MASTER_TOKEN: "test-master-token-abc",
              // Two static namespace hosts (>=32-byte tokens, unique, != master).
              TOKIMEKI_NAMESPACE_TOKENS: JSON.stringify({
                "team-a": "test-namespace-token-team-a-0123456789",
                "team-b": "test-namespace-token-team-b-0123456789",
              }),
              TOKIMEKI_SESSION_TTL_SECONDS: "30",
              ...(options.sessionMaxTtlSeconds === undefined
                ? {}
                : { TOKIMEKI_SESSION_MAX_TTL_SECONDS: options.sessionMaxTtlSeconds }),
              TOKIMEKI_MAX_CLIENTS_PER_SESSION: "3",
              TOKIMEKI_MAX_LISTENERS: "2",
              TOKIMEKI_TURN_PROVIDER: "auto",
              TOKIMEKI_STUN_URLS: "stun:stun.test.invalid:3478",
              TOKIMEKI_COTURN_URLS: ["turn:coturn.test.invalid:3478?transport=udp"],
              TOKIMEKI_COTURN_SECRET: "test-coturn-secret",
              TOKIMEKI_COTURN_TTL_SECONDS: "3600",
              TOKIMEKI_TURN_KEY_ID: "test-turn-key-id",
              TOKIMEKI_TURN_API_TOKEN: "test-turn-api-token",
              TOKIMEKI_TURN_TTL_SECONDS: "3600",
              TOKIMEKI_LOG_LEVEL: "silent",
            },
          },
        },
      },
    },
  });
}
