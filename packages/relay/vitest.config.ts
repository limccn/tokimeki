import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  test: {
    include: ["test/**/*.test.ts"],
    poolOptions: {
      workers: {
        singleWorker: true,
        isolatedStorage: true,
        wrangler: {
          configPath: "./wrangler.jsonc",
        },
        miniflare: {
          bindings: {
            // Test-only values. Production values come from Worker vars/secrets.
            TOKIMEKI_MASTER_TOKEN: "test-master-token-abc",
            TOKIMEKI_SESSION_TTL_SECONDS: "30",
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
