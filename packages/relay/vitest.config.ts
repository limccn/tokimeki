import { configDefaults } from "vitest/config";

import { relayWorkersConfig } from "./vitest.shared.js";

/**
 * Legacy/fallback suite: no namespace tokens, no JWT bindings.
 *
 * The master token is the single-owner fallback credential here, exactly like
 * a self-host deployment that has not configured `TOKIMEKI_NAMESPACE_TOKENS`.
 * Namespace-mode cases live in `vitest.namespace.config.ts`, JWT cases in
 * `vitest.jwt.config.ts`, and quotas in `vitest.quotas.config.ts`.
 */
export default relayWorkersConfig({
  include: ["test/**/*.test.ts"],
  exclude: [
    ...configDefaults.exclude,
    "test/quotas-ttl.test.ts",
    "test/worker-namespace.test.ts",
    "test/session-namespace.test.ts",
    "test/worker-jwt.test.ts",
  ],
  // Absolute TTL alarms are exercised by the quota suite; see vitest.shared.ts.
  sessionMaxTtlSeconds: "0",
});
