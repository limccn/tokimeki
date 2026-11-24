#!/usr/bin/env node
/** Copy the static site shell next to the compiled ES modules. */
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });
for (const name of ["index.html", "styles.css", "_headers"]) {
  copyFileSync(join(root, name), join(dist, name));
}
// TypeScript emits declarations/source maps for the workspace build; they are
// not needed in the Workers Static Assets upload.
writeFileSync(join(dist, ".assetsignore"), "*.map\n*.d.ts\n*.d.ts.map\n");
process.stdout.write(`onboarding-site built at ${dist}\n`);
