# No-JWT onboarding site

The relay can serve a pure-static onboarding page from Workers Static Assets.
It is bound to the relay origin and supports **multi-namespace static token**
relays only (`TOKIMEKI_NAMESPACE_TOKENS`). There is no JWT, anonymous-host,
invite, passcode, account, analytics, storage, or backend behavior.

Source: `packages/onboarding-site/`. Build output: `packages/onboarding-site/dist/`
(gitignored).

## Build and deploy

```bash
npm run build:site
npx wrangler deploy --dry-run                                # root config
npx wrangler deploy --dry-run --config packages/relay/wrangler.jsonc
npm run deploy        # builds site + Worker (open-source config)
npm run deploy:prod   # builds site + Worker (production config)
```

Both Wrangler configs declare:

```jsonc
"assets": {
  "directory": "packages/onboarding-site/dist", // prod: ../../packages/onboarding-site/dist
  "binding": "ASSETS",
  "not_found_handling": "none"
}
```

Existing files are served from assets; unmatched paths fall through to the
Worker, so `/ws/*`, `/healthz`, `/auth/whoami`, and `/auth/*` keep their relay
behavior. There is no SPA fallback and no `_redirects`; a stray `_headers` is
limited to the expected CSP/security headers. `.assetsignore` excludes
TypeScript maps/declarations from the upload.

Production deploy requires explicit maintainer approval. Static assets change
the same Worker deployment; verify with:

```bash
curl -fsS https://relay.tokiapi.app/ | head
curl -fsS https://relay.tokiapi.app/healthz
curl -fsS -H 'x-tokimeki-session: dummy' https://relay.tokiapi.app/auth/whoami
```

`/` should return the page, `/healthz` the JSON health response, and
`/auth/whoami` should still be handled by the Worker (401 without a token).

## What the page does

- Shows the relay URL read-only as `wss://<page host>` (loopback may use
  `ws://`).
- **Host** form: namespace, static host token, session (`<namespace>.<slug>`),
  high-entropy viewer session token, ACP (9 + custom), shell, optional window.
  Generates a multi-line host command and a downloadable v1
  `tokimeki-config.json`.
- **Attach** form: session, session token, viewer/listener, shell. Generates
  `tokimeki attach` (or `--listen`) and a v1 viewer config JSON.
- Explains that the relay operator issues tokens through
  `TOKIMEKI_NAMESPACE_TOKENS`; the page cannot create, recover, or validate
  them.
- No JWT/invite/passcode/account controls.

## Security model

- Everything is generated in the browser (`connect-src 'none'`); no fetch/XHR,
  no cookies/localStorage/sessionStorage, no third-party scripts or analytics.
- Tokens are only in form fields/`textContent`; they are never put in the URL
  and never logged. Closing the tab discards them.
- User input is written with `textContent`/`value`; shell generation rejects
  quotes, `%`, control characters, and other unsafe characters.
- The viewer session token defaults to 32 random bytes (base64url), matching
  the CLI; the old 6–8 digit style is not offered.
- The page must be served over HTTPS (except loopback). Use Cloudflare Always
  Use HTTPS + HSTS or a Redirect Rule. The response `_headers` sets CSP with
  `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, and `Cache-Control: no-store`.
- Downloaded configs contain secrets: `chmod 600 tokimeki-config.json`, use
  `tokimeki --config tokimeki-config.json claude`, and delete it. Browser
  download is not memory-only.

## Tests

```bash
npm test -- packages/onboarding-site   # pure validation/command/config tests
npm run build:site
npx wrangler deploy --dry-run
```

The local no-JWT e2e (`scripts/e2e/v1.4-onboarding-e2e.mjs`) starts a local
relay and exercises a generated config-file host + viewer attach. A production
deployment is a separate approval step and is not automated here.

## Source attribution

Command-generation semantics and UI concepts follow the MIT-licensed TokiAPI
repository; see `packages/onboarding-site/NOTICE.md`. No TokiAPI JWT, invite,
passcode, anonymous-host, or backend code is copied.
