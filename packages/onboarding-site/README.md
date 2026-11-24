# tokimeki no-JWT onboarding site

Pure-static onboarding page served by the relay Worker from Workers Static
Assets. It is bound to the relay origin and only supports multi-namespace
static tokens (`TOKIMEKI_NAMESPACE_TOKENS`); it has no JWT, anonymous-host,
invite, passcode, analytics, storage, or backend behavior.

- `npm run build:site` compiles `src/` with `tsc` and copies the static shell
  into `dist/`.
- Deployments serve `dist/` via the `assets` binding in the root and
  `packages/relay` Wrangler configs. `/ws/*`, `/healthz`, and `/auth/*` remain
  Worker routes.
- All secrets stay in browser memory; the page makes no network requests
  (`connect-src 'none'`) and never writes cookies/storage.

## Source attribution

The command/reporting semantics and UI concept follow the MIT-licensed TokiAPI
`tokimeki` onboarding hub (`app/modules/tokimeki/lib/host-command.ts`,
`attach-command.ts`, `platform.ts`, and `app/routes/tokimeki-home.tsx`).
This package contains an independent, simplified implementation without JWT,
invite, passcode, or anonymous-host code. See `NOTICE.md`.
