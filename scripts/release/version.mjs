#!/usr/bin/env node
/**
 * Release version helper for the tokimeki monorepo.
 *
 * Usage:
 *   node scripts/release/version.mjs bump 0.1.2
 *   node scripts/release/version.mjs check 0.1.2
 *   node scripts/release/version.mjs check --tag v0.1.2
 *
 * `bump` updates the root and workspace versions, every exact internal
 * @limccn/tokimeki-protocol dependency, and package-lock.json. `check`
 * verifies tag/package/lockfile consistency for CI. Neither command commits,
 * tags, publishes, or deploys.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROTOCOL_PACKAGE = "@limccn/tokimeki-protocol";
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function printUsage() {
  console.log(`Usage:
  node scripts/release/version.mjs bump <version>
  node scripts/release/version.mjs check <version>
  node scripts/release/version.mjs check --tag v<version>

Commands:
  bump    Update all package versions, exact protocol dependencies, and the lockfile.
  check   Verify tag/package/lockfile consistency (used by CI).`);
}

function fail(message) {
  console.error(`release-version: ${message}`);
  process.exit(1);
}

function parseVersionArg(value) {
  const version = value.startsWith("v") ? value.slice(1) : value;
  if (!SEMVER_RE.test(version)) {
    fail(`invalid version "${value}" (expected [v]X.Y.Z)`);
  }
  return version;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function workspaceDirectories() {
  const packagesDir = join(ROOT, "packages");
  return readdirSync(packagesDir)
    .sort()
    .map((name) => `packages/${name}`)
    .filter((relative) =>
      statSync(join(ROOT, relative, "package.json"), { throwIfNoEntry: false })?.isFile(),
    );
}

function loadPackages() {
  const rootPath = join(ROOT, "package.json");
  const workspaces = workspaceDirectories().map((relative) => {
    const path = join(ROOT, relative, "package.json");
    return { relative, path, pkg: readJson(path) };
  });
  return { rootPath, root: readJson(rootPath), workspaces };
}

function protocolDependencyVersions(pkg) {
  const found = [];
  for (const field of DEPENDENCY_FIELDS) {
    const version = pkg[field]?.[PROTOCOL_PACKAGE];
    if (version !== undefined) {
      found.push({ field, version });
    }
  }
  return found;
}

function checkVersion(expected) {
  const errors = [];
  const { rootPath, root, workspaces } = loadPackages();

  if (root.version !== expected) {
    errors.push(`${rootPath}: version "${root.version}" != "${expected}"`);
  }

  for (const workspace of workspaces) {
    if (workspace.pkg.version !== expected) {
      errors.push(`${workspace.path}: version "${workspace.pkg.version}" != "${expected}"`);
    }
    for (const dependency of protocolDependencyVersions(workspace.pkg)) {
      if (dependency.version !== expected) {
        errors.push(
          `${workspace.path}: ${dependency.field}["${PROTOCOL_PACKAGE}"] ` +
            `"${dependency.version}" != "${expected}"`,
        );
      }
    }
  }

  const lockPath = join(ROOT, "package-lock.json");
  const lock = readJson(lockPath);
  if (lock.version !== expected) {
    errors.push(`${lockPath}: version "${lock.version}" != "${expected}"`);
  }
  if (lock.packages?.[""]?.version !== expected) {
    errors.push(
      `${lockPath}: packages[""].version "${lock.packages?.[""]?.version}" != "${expected}"`,
    );
  }

  for (const workspace of workspaces) {
    const entry = lock.packages?.[workspace.relative];
    if (!entry) {
      errors.push(`${lockPath}: missing entry for "${workspace.relative}"`);
      continue;
    }
    if (entry.version !== expected) {
      errors.push(`${lockPath}: ${workspace.relative}.version "${entry.version}" != "${expected}"`);
    }
    for (const dependency of protocolDependencyVersions(workspace.pkg)) {
      const locked = entry[dependency.field]?.[PROTOCOL_PACKAGE];
      if (locked !== expected) {
        errors.push(
          `${lockPath}: ${workspace.relative}.${dependency.field}["${PROTOCOL_PACKAGE}"] ` +
            `"${locked}" != "${expected}"`,
        );
      }
    }
  }

  if (errors.length > 0) {
    console.error("release-version: version consistency check failed:");
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  console.log(`release-version: OK - root, workspaces, and lockfile report ${expected}`);
}

function syncLockfile() {
  const args = ["install", "--package-lock-only", "--ignore-scripts"];
  let result;

  if (process.env.npm_execpath) {
    result = spawnSync(process.execPath, [process.env.npm_execpath, ...args], {
      cwd: ROOT,
      stdio: "inherit",
    });
  } else if (process.platform === "win32") {
    result = spawnSync(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", `npm ${args.join(" ")}`],
      {
        cwd: ROOT,
        stdio: "inherit",
      },
    );
  } else {
    result = spawnSync("npm", args, { cwd: ROOT, stdio: "inherit" });
  }

  if (result.error) {
    fail(`failed to run npm: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`npm install --package-lock-only exited with code ${result.status}`);
  }
}

function bumpVersion(expected) {
  const { rootPath, root, workspaces } = loadPackages();
  const targets = [{ path: rootPath, pkg: root }, ...workspaces];

  for (const target of targets) {
    target.pkg.version = expected;
    for (const field of DEPENDENCY_FIELDS) {
      if (target.pkg[field]?.[PROTOCOL_PACKAGE] !== undefined) {
        target.pkg[field][PROTOCOL_PACKAGE] = expected;
      }
    }
    writeJson(target.path, target.pkg);
    console.log(`release-version: updated ${target.path}`);
  }

  syncLockfile();

  checkVersion(expected);
  console.log(
    "release-version: next: update CHANGELOG and release docs, run the verification suite, " +
      "commit, then push an annotated v<version> tag after maintainer approval.",
  );
}

function main(argv) {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    process.exit(command ? 0 : 1);
  }

  if (command === "bump") {
    if (rest.length !== 1) {
      fail("bump requires exactly one version argument");
    }
    bumpVersion(parseVersionArg(rest[0]));
    return;
  }

  if (command === "check") {
    if (rest.length === 2 && rest[0] === "--tag") {
      checkVersion(parseVersionArg(rest[1]));
      return;
    }
    if (rest.length === 1 && rest[0] !== "--help" && rest[0] !== "-h") {
      checkVersion(parseVersionArg(rest[0]));
      return;
    }
    if (rest.length === 1) {
      printUsage();
      return;
    }
    fail("check requires <version> or --tag v<version>");
  }

  fail(`unknown command "${command}"`);
}

main(process.argv.slice(2));
