import { configDefaults } from "vitest/config";

import { relayWorkersConfig } from "./vitest.shared.js";

// `test/quotas-ttl.test.ts` runs in its own process/config; see
// `vitest.quotas.config.ts` for why.
export default relayWorkersConfig({
  include: ["test/**/*.test.ts"],
  exclude: [...configDefaults.exclude, "test/quotas-ttl.test.ts"],
  // Absolute TTL alarms are exercised by the quota suite; see vitest.shared.ts.
  sessionMaxTtlSeconds: "0",
});
