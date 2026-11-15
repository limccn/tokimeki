# Release guide (0.1.x)

This repository publishes two npm packages and deploys one private Worker:

| Package | Visibility | Publish? |
|---|---|---|
| `@limccn/tokimeki` | public CLI | yes |
| `@limccn/tokimeki-protocol` | public library | yes, before the CLI |
| `@tokimeki/relay` | private Worker | no; deploy via Wrangler |

## Versioning

- Current release: `0.1.0` (`v0.1.0` tag suggestion).
- All three workspace packages (`@limccn/tokimeki`,
  `@limccn/tokimeki-protocol`, `@tokimeki/relay`) and the root
  `package.json` must use the same version.
- The CLI dependency on `@limccn/tokimeki-protocol` is an exact version
  (`0.1.0`), so publish protocol first.

## Pre-flight

```bash
git status --porcelain           # must be clean
npm ci
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

## Publish to npm

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

Published packages:

- https://www.npmjs.com/package/@limccn/tokimeki
- https://www.npmjs.com/package/@limccn/tokimeki-protocol

## Publish to GitHub Packages (mirror)

GitHub Packages uses the same scoped names and requires an authenticated
GitHub token with `write:packages` (classic PAT) or, in Actions,
`GITHUB_TOKEN` with `packages: write`. Public npm remains the primary install
path; GitHub Packages requires GitHub auth even for public packages.

```bash
# One-time local npm config (or use an .npmrc in CI)
npm config set @limccn:registry https://npm.pkg.github.com
npm config set //npm.pkg.github.com/:_authToken "$GITHUB_TOKEN"

npm publish --workspace @limccn/tokimeki-protocol \
  --registry=https://npm.pkg.github.com --access public
npm publish --workspace @limccn/tokimeki \
  --registry=https://npm.pkg.github.com --access public
```

Alternatively, run the same commands in a GitHub Actions release workflow with
`permissions: packages: write` and `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`.

## Tag and GitHub Release

```bash
git tag v0.1.0
git push origin v0.1.0

gh release create v0.1.0 \
  --title "tokimeki 0.1.0" \
  --notes-file CHANGELOG.md
```

Or create the release in the GitHub UI and use `--generate-notes`/the
CHANGELOG as the body. The README npm badge and release link resolve after the
packages and release exist.

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

- npm: unpublish is restricted; prefer publishing a fixed `0.1.x` version.
- Worker: `npx wrangler deployments list` + `npx wrangler rollback <version-id>`,
  or redeploy the previous git revision. Durable Object storage is not rolled
  back by a Worker rollback.
