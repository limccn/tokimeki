import type { RelayEnv } from "../src/env.js";

declare module "cloudflare:test" {
  interface ProvidedEnv extends RelayEnv {}
}
