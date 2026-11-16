# Release guide (0.1.x)

This repository publishes two npm packages and deploys one private Worker:

| Package | Visibility | Publish? |
|---|---|---|
| `@limccn/tokimeki` | public CLI | yes |
| `@limccn/tokimeki-protocol` | public library | yes, before the CLI |
| `@tokimeki/relay` | private Worker | no; deploy via Wrangler |

Releases are published from GitHub Actions when a `v<version>` tag is pushed.
The same workflow publishes to npmjs and to GitHub Packages and creates the
GitHub Release.

## Versioning

- Current release: `0.1.1` (`v0.1.1` tag).
- All four `package.json` files (`package.json`, `packages/protocol`,
  `packages/cli`, `packages/relay`) must use the same version.
- The CLI and relay dependencies on `@limccn/tokimeki-protocol` are exact
  versions (`0.1.1`), so protocol is published first.
- Use the version helper instead of editing versions by hand:

  ```bash
  npm run release:bump -- 0.1.2   # root + workspaces + exact deps + lockfile
  npm run release:check -- 0.1.2  # same checks the release workflow runs
  ```

## Release flow (automated)

1. Pick the next patch version for a rolling release (for example `0.1.2`).
2. Run `npm run release:bump -- 0.1.2`.
3. Move the `[Unreleased]` entries in `CHANGELOG.md` into a dated
   `## [0.1.2] - YYYY-MM-DD` section and update the compare/release links.
4. Update current-release references in `README.md`, `README.zh-CN.md`,
   `CLAUDE.md`, and any other docs that name the current version.
5. Run the [pre-flight](#pre-flight-local) checks.
6. Commit the release prep (for example `chore(release): v0.1.2`).
7. After explicit maintainer approval, create and push an annotated tag:

   ```bash
   git tag -a v0.1.2 -m "tokimeki 0.1.2"
   git push origin main
   git push origin v0.1.2
   ```

8. `.github/workflows/release.yml` runs automatically:
   - verifies the tag matches every package version and the lockfile;
   - runs lint, typecheck, relay typecheck, unit tests, relay tests, build,
     both Wrangler dry-runs, and `npm pack --dry-run`;
   - publishes `@limccn/tokimeki-protocol` then `@limccn/tokimeki` to npmjs
     with provenance;
   - publishes the same packages in the same order to GitHub Packages;
   - creates the GitHub Release with generated notes.
9. Verify the result:

   ```bash
   npm view @limccn/tokimeki-protocol version
   npm view @limccn/tokimeki version
   gh release view v0.1.2
   ```

   Also check the Actions run and the GitHub Packages pages.

## One-time GitHub setup

- Add an `NPM_TOKEN` repository secret
  (Settings → Secrets and variables → Actions):
  - npm **granular access token** with read/write access to the `@limccn`
    scope and **2FA bypass** enabled for CI;
  - the token is only used by the release workflow, never committed or
    printed.
- GitHub Packages uses the automatic `GITHUB_TOKEN`; the publish job grants
  `packages: write`. No extra secret is needed for the GitHub Packages mirror.
- Optional: npm Trusted Publishing can replace `NPM_TOKEN` later by
  configuring each package's trusted publisher for this repository and
  `release.yml`; the tag-triggered flow stays the same. The workflow currently
  implements the `NPM_TOKEN` path.

## Pre-flight (local)

```bash
npm run release:check -- 0.1.2
npm ci
npm install --package-lock-only --ignore-scripts
git diff --exit-code -- package-lock.json
npm run build
npm run typecheck
npm run typecheck:relay
npm run lint
npm test
npm run test:relay
npx wrangler deploy --dry-run
npx wrangler deploy --dry-run --config packages/relay/wrangler.jsonc
```

Verify package contents (no `.env`, tests, `.trellis`, or real secrets):

```bash
npm pack --dry-run --workspace @limccn/tokimeki-protocol
npm pack --dry-run --workspace @limccn/tokimeki
```

## Manual fallback

Use this only when GitHub Actions is unavailable and a maintainer explicitly
approves bypassing the workflow.

```bash
npm login                       # account with @limccn scope access
npm publish --workspace @limccn/tokimeki-protocol --access public
npm publish --workspace @limccn/tokimeki --access public
```

If the account requires 2FA for writes, pass a fresh one-time code:

```bash
npm publish --workspace @limccn/tokimeki-protocol --access public --otp=<code>
npm publish --workspace @limccn/tokimeki --access public --otp=<code>
```

GitHub Packages mirror:

```bash
npm config set @limccn:registry https://npm.pkg.github.com
npm config set //npm.pkg.github.com/:_authToken "$GITHUB_TOKEN"

npm publish --workspace @limccn/tokimeki-protocol \
  --registry=https://npm.pkg.github.com --access public
npm publish --workspace @limccn/tokimeki \
  --registry=https://npm.pkg.github.com --access public
```

GitHub Packages uses the same scoped names and requires an authenticated
GitHub token with `write:packages` (classic PAT) or `packages: write` for
`GITHUB_TOKEN`. Public npm remains the primary install path; GitHub Packages
requires GitHub auth even for public packages.

## Tag and GitHub Release (manual fallback)

```bash
git tag -a v0.1.2 -m "tokimeki 0.1.2"
git push origin v0.1.2

gh release create v0.1.2 \
  --title "tokimeki 0.1.2" \
  --generate-notes
```

Or create the release in the GitHub UI. The README npm badge and release link
resolve after the packages and release exist.

Do not run `npm publish`, create tags, or deploy production without explicit
maintainer approval.

## Relay release

The relay is versioned with the repo but deployed separately:

```bash
# Open-source / workers.dev default
npm run deploy

# Maintainer production config (custom domain)
npm run deploy:prod
```

Set Worker secrets before deploying:

```bash
npx wrangler secret put TOKIMEKI_MASTER_TOKEN
# optional: TOKIMEKI_COTURN_SECRET, TOKIMEKI_TURN_API_TOKEN, TOKIMEKI_TURN_CREDENTIAL
```

Verify with `curl https://<relay>/healthz` and a local `scripts/e2e/live-e2e.mjs`
run. See [deploy-cloudflare.md](deploy-cloudflare.md) and
[deployment.md](deployment.md).

## Rollback

- npm: published versions are immutable; prefer publishing a fixed `0.1.x`
  version instead of unpublishing.
- If all four publishes succeeded but only the GitHub Release step failed,
  create the release manually with `gh release create` (see above).
- If only one registry/repository received a package, publish a new patch
  version rather than reusing the version; record the gap in the changelog.
- Worker: `npx wrangler deployments list` + `npx wrangler rollback <version-id>`,
  or redeploy the previous git revision. Durable Object storage is not rolled
  back by a Worker rollback.
