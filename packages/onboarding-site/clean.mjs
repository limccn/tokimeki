#!/usr/bin/env node
/** Remove dist/ before tsc so removed/renamed modules cannot ship stale JS. */
import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)));
rmSync(join(root, "dist"), { recursive: true, force: true });
rmSync(join(root, "tsconfig.tsbuildinfo"), { force: true });
