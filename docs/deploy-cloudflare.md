# Deploy the tokimeki relay to Cloudflare

The relay is a Cloudflare Worker plus one Durable Object per session. It
handles authentication, WebSocket signaling, terminal data fallback, snapshots,
and STUN/TURN credential issuance.

## Option A — Deploy Button (recommended for a first deploy)

Use the button in the README, or open:

```text
https://deploy.workers.cloudflare.com/?url=https://github.com/limccn/tokimeki
```

Cloudflare clones this repository, reads the root
[`wrangler.jsonc`](../wrangler.jsonc), and provisions the `SESSIONS` Durable
Object binding and `v1` migration. The Worker is deployed as
`tokimeki-relay` on `*.workers.dev`.

During setup Cloudflare prompts for the Worker secrets declared in
[`.dev.vars.example`](../.dev.vars.example). At minimum set
`TOKIMEKI_MASTER_TOKEN` to a strong random value:

```bash
openssl rand -base64 32
```

> The button overwrites an existing Worker with the same name in the selected
> account. Rename the Worker in the deploy dialog if you already have one.

## Option B — Manual Wrangler deploy

Requirements: Node.js >= 22.12, npm >= 11, and a Cloudflare account.

```bash
git clone https://github.com/limccn/tokimeki.git
cd tokimeki
npm install
npx wrangler login

# Required: host authentication. Use a strong random value.
# (Single-owner fallback credential; disabled once namespace tokens are active.)
npx wrangler secret put TOKIMEKI_MASTER_TOKEN

# Optional: static multi-namespace host tokens (OSS multi-user).
# Paste the JSON object when prompted; never commit it.
npx wrangler secret put TOKIMEKI_NAMESPACE_TOKENS

# Optional: TokiAPI Host JWT verification (both values are public; vars also work)
npx wrangler secret put TOKIMEKI_JWT_JWKS_URL   # e.g. https://tokiapi.app/api/tokimeki/jwks.json
npx wrangler secret put TOKIMEKI_JWT_ISSUER     # e.g. https://tokiapi.app

# Optional TURN secrets (choose what you use)
npx wrangler secret put TOKIMEKI_COTURN_SECRET       # coturn REST
npx wrangler secret put TOKIMEKI_TURN_API_TOKEN      # Cloudflare TURN
npx wrangler secret put TOKIMEKI_TURN_CREDENTIAL     # static TURN

# Deploy the open-source root configuration
npm run deploy
```

`npm run deploy` builds the workspace and runs `wrangler deploy` against the
root `wrangler.jsonc` (workers.dev, no custom domain).

> The root config and the maintainer production config use the same Worker
> name (`tokimeki-relay`). Do not run `npm run deploy` from the account that
> hosts the production relay; use `npm run deploy:prod` there.

For the production configuration with the custom domain and the production
coturn URL list (maintainers only):

```bash
npm run deploy:prod
# equivalent to: npm run build && wrangler deploy --config packages/relay/wrangler.jsonc
```

## Environment variables and secrets

Worker vars can be set in `wrangler.jsonc` or the dashboard. Secrets should be
set with `wrangler secret put` (or the Deploy Button prompt).

### Authentication

Host credentials travel in the `X-Tokimeki-Token` header (**breaking change**:
the old `X-Tokimeki-Master` header is no longer accepted; upgrade the CLI and
relay together). The relay decides the credential kind by value shape, in this
order:

1. the single-owner fallback token (`TOKIMEKI_MASTER_TOKEN`) — only while no
   valid namespace tokens are configured; it can take over any session
   (root `*`);
2. a three-segment Host JWT (only while JWT mode is enabled) — verified
   offline against the JWKS;
3. a static namespace token — scoped to `<namespace>.<slug>` sessions.

| Name | Kind | Required | Meaning |
|---|---|---|---|
| `TOKIMEKI_MASTER_TOKEN` | secret | no | Single-owner fallback credential (one person exclusively owning a relay). Unset/blank rejects all fallback hosts (fail-closed). **Disabled once `TOKIMEKI_NAMESPACE_TOKENS` has at least one valid entry** — including root `*` takeover; migrate hosts to `TOKIMEKI_TOKEN`. The relay logs a `fallback_token_disabled` warning while both are set. |
| `TOKIMEKI_NAMESPACE_TOKENS` | secret | no | Static namespace host tokens as a JSON object `{ "<namespace>": "<token>" }`. Each token must be unique, >=32 bytes, and differ from the master token; namespaces match `^[a-z0-9][a-z0-9_-]{0,31}$` (max 64 entries, raw JSON <=16 KiB). A namespace host may only use `<namespace>.<slug>` sessions. Invalid/duplicate entries fail closed (namespace auth disabled; the fallback token stays usable). |

> **Preflight before deploying the header rename / fallback gating**: if you
> already set `TOKIMEKI_NAMESPACE_TOKENS` but no longer know its values (the
> secret is write-only), deploying this relay disables the fallback token with
> no usable namespace token — host authentication is locked out. Rotate and
> distribute the namespace tokens first, or clear the secret to stay in
> fallback mode.

| Name | Kind | Required | Meaning |
|---|---|---|---|
| `TOKIMEKI_JWT_JWKS_URL` | var/secret | no | Enables Host JWT verification: absolute `https://` JWKS URL on the **TokiAPI dashboard origin** (the `BETTER_AUTH_URL` origin), e.g. `https://tokiapi.app/api/tokimeki/jwks.json`. No userinfo, no fragment. Unset/blank = JWT mode disabled: no JWT parsing, no Authorization handling, no JWKS traffic. |
| `TOKIMEKI_JWT_ISSUER` | var/secret | with URL | Required when the JWKS URL is set; compared exactly against the `iss` claim (max 512 chars). A malformed URL or missing issuer fails closed for JWT credentials (401) while fallback/namespace tokens keep working. |
| `TOKIMEKI_JWT_AUDIENCE` | var | no | Expected `aud` claim; default `tokimeki-relay`. |
| `TOKIMEKI_JWT_JWKS_TTL_SECONDS` | var | no | JWKS cache lifetime; default `3600`, clamped to 60–86400. Per-isolate memory cache with in-flight dedupe; an unknown `kid` triggers one refresh per 30 s. |
| `TOKIMEKI_JWT_CLOCK_SKEW_SECONDS` | var | no | Allowed clock skew for `iat`/`nbf`/`exp`; default `60`, clamped to 0–300. |
| `TOKIMEKI_JWT_ALLOW_HTTP` | var | no | **Test-only.** `1` allows an `http://` JWKS URL on `localhost`/`127.0.0.1`/`[::1]` for the local cross-repo e2e. Never set it in production. |

JWT mode also verifies **Session JWTs** in `X-Tokimeki-Session`
(`token_use=session`, `attach`/`listen` scope, `session` claim equal to the
path) and accepts the optional `X-Tokimeki-Passcode` header. Session JWTs are
never host credentials. See `docs/protocol.md` §5.1.1–5.1.2.

Only `alg=ES256` tokens with `token_use=host`, a `scope` containing `host`, a
valid `namespace` claim, and a matching `<namespace>.<slug>` session are
admitted. Invalid JWTs return `401`; an unreachable JWKS with no usable cache
returns `503 jwks_unavailable`. Verification is offline at the edge — the relay
never calls TokiAPI per connection. There is no revocation list: a Host JWT is
valid until `exp` (TokiAPI default 30 days), so rotate the signing key in
TokiAPI to invalidate outstanding tokens.

`GET /healthz` is public and intentionally minimal. `GET /auth/whoami` is the
authenticated operations probe: it reads `X-Tokimeki-Token` (plus, only while
JWT mode is enabled, `Authorization: Bearer`) and returns the detected
`authMode` — `jwt` (with namespace, sub, tokenUse, scopes, expiresAt),
`namespace` (with namespace), or `master` — plus the TURN provider/configured
state. It never returns tokens, TURN credentials, secrets, ICE URLs, or JWKS
content. A JWT-disabled deployment neither parses nor strips `Authorization`.
The Worker derives the namespace from the verified credential and strips any
client-supplied namespace header.

### Sessions

| Name | Kind | Default | Meaning |
|---|---|---|---|
| `TOKIMEKI_SESSION_TTL_SECONDS` | var | `86400` | Host-offline grace before the session is deleted |
| `TOKIMEKI_MAX_CLIENTS_PER_SESSION` | var | `8` | Active clients per session (host + viewers + listeners) |
| `TOKIMEKI_MAX_LISTENERS` | var | `8` | Additional cap for read-only snapshot-only listeners |
| `TOKIMEKI_LOG_LEVEL` | var | `info` | `debug`, `info`, `warn`, `error`, `silent` |

### ICE / STUN / TURN

| Name | Kind | Default | Meaning |
|---|---|---|---|
| `TOKIMEKI_TURN_PROVIDER` | var | `auto` | `auto`, `coturn`, `cloudflare`, `none` |
| `TOKIMEKI_STUN_URLS` | var | `stun:stun.cloudflare.com:3478` | Comma-separated STUN URLs |
| `TOKIMEKI_ICE_TRANSPORT_POLICY` | var | `all` | Advertised policy: `all` or `relay` |
| `TOKIMEKI_COTURN_URLS` | var | — | JSON array (or comma-separated) of coturn `turn:`/`turns:` URLs |
| `TOKIMEKI_COTURN_SECRET` | secret | — | coturn REST shared secret |
| `TOKIMEKI_COTURN_TTL_SECONDS` | var | `900` | coturn credential TTL (seconds) |
| `TOKIMEKI_TURN_URLS` | var | — | Static TURN URLs (fallback below coturn REST) |
| `TOKIMEKI_TURN_USERNAME` | var | — | Static TURN username |
| `TOKIMEKI_TURN_CREDENTIAL` | secret | — | Static TURN credential |
| `TOKIMEKI_TURN_KEY_ID` | var | — | Cloudflare Realtime TURN key ID |
| `TOKIMEKI_TURN_API_TOKEN` | secret | — | Cloudflare Realtime TURN API token |
| `TOKIMEKI_TURN_TTL_SECONDS` | var | `900` | Cloudflare credential TTL (Cloudflare caps at 172800) |

TURN credentials default to a 15-minute lifetime; `600`–`3600` seconds is the
recommended range. The relay cannot meter TURN bytes (media does not traverse
it), so short-lived credentials limit the blast radius of a leaked session
token. Deployments that need longer-lived credentials must set the matching
TTL var explicitly; Cloudflare still clamps to 172800 seconds.

Listeners are read-only snapshot-only clients and never receive TURN
credentials: their `welcome` is STUN-only (`iceProvider: "stun"`), and an
`ice-refresh` from a listener returns `invalid_role`.

Provider selection with `auto`:

1. coturn REST (URLs + secret) — HMAC short-lived credentials;
2. static TURN (`TOKIMEKI_TURN_URLS` + username/credential);
3. Cloudflare Realtime TURN (Key ID + API token);
4. STUN-only; the Worker relay remains the data fallback.

The CLI uses the `libjuice` WebRTC stack and supports **TURN over UDP** only.
Keep at least one `turn:...?transport=udp` URL in the list. TCP/TLS TURN URLs
are useful for browser clients but are not used by the CLI.

### coturn example

```jsonc
// packages/relay/wrangler.jsonc (vars)
"TOKIMEKI_TURN_PROVIDER": "coturn",
"TOKIMEKI_COTURN_URLS": [
  "turn:turn.example.com:3478?transport=udp",
  "turns:turn.example.com:5349?transport=tcp"
]
```

```bash
npx wrangler secret put TOKIMEKI_COTURN_SECRET
```

Every listed coturn node must share `TOKIMEKI_COTURN_SECRET` as its
`static-auth-secret`. Restrict relaying to public peers on the coturn side
(`denied-peer-ip`, `no-multicast-peers`).

### Cloudflare Realtime TURN example

Create a TURN key in the Cloudflare dashboard, then:

```jsonc
// vars
"TOKIMEKI_TURN_PROVIDER": "cloudflare",
"TOKIMEKI_TURN_KEY_ID": "<key-id>"
```

```bash
npx wrangler secret put TOKIMEKI_TURN_API_TOKEN
```

Cloudflare TURN's China Network does not participate; mainland clients may be
routed overseas. Prefer self-hosted coturn when latency matters.

## Custom domain

The open-source root config intentionally has no routes, so the button deploy
uses `*.workers.dev`. To use a custom domain (for example
`relay.example.com`), add a `routes` block to your deployment config or use the
Cloudflare dashboard → Worker → Settings → Domains & Routes. When a custom
domain is configured, the `workers.dev` route may be disabled; update clients'
`TOKIMEKI_RELAY_URL` to `wss://<your-domain>`.

The maintainer production config (`packages/relay/wrangler.jsonc`) already
contains `relay.tokiapi.app`; do not deploy that config to a personal account
unless you own the domain.

## Verify

```bash
curl -s https://<your-worker>.workers.dev/healthz
# {"ok":true,"service":"tokimeki-relay","protocolVersion":1}

# Send the token from your secret store; never commit a real value.
curl -s -H "X-Tokimeki-Token: $TOKIMEKI_MASTER_TOKEN" \
  https://<your-worker>.workers.dev/auth/whoami
# {"ok":true,"service":"tokimeki-relay","protocolVersion":1,"authMode":"master",
#  "turn":{"provider":"stun","configured":false}}
```

`/healthz` is public and minimal by design (no TURN/JWT/namespace details).
`/auth/whoami` requires a valid host credential on `X-Tokimeki-Token`, returns
`401` without one (or with an invalid one), `503 jwks_unavailable` when JWT
mode is configured but the JWKS is unreachable, `405` for non-GET requests, and
sets `no-store`. Its response never contains the token, TURN credentials,
secrets, or ICE URLs. After configuring TURN, `turn.provider` becomes `coturn`,
`static`, or `cloudflare` and `turn.configured` becomes `true`; if it stays
`stun`, a required var or secret is missing.

External monitors should check `/healthz` for HTTP 200 only, or use
`/auth/whoami` with a host credential for TURN diagnostics.

## Edge rate limiting (recommended)

The Worker implements no per-IP throttling. Put Cloudflare Rate Limiting / WAF
rules in front of the Worker for the WebSocket upgrade path:

- Limit `GET /ws/*` upgrades per client IP (for example 30 per minute).
- Cap concurrent pending connections per IP (for example 10). The relay also
  returns HTTP 429 once a session's OPEN sockets reach
  `TOKIMEKI_MAX_CLIENTS_PER_SESSION * 2`.
- Watch failure rates and block or challenge anomalous IPs; alert on spikes in
  session creation or TURN credential issuance.
- Rules apply to new upgrades only; established sessions are not interrupted.
- Do not echo thresholds from the Worker or put them in error bodies. Rate
  limit responses belong to the edge (typically HTTP 429 with a generic body).

The available Cloudflare products and limits depend on the account plan, so
this repository does not encode them in `wrangler.jsonc`. Configure them in the
dashboard or with the Cloudflare API after deployment. Self-hosted
alternatives should put an equivalent per-IP limiter in front of the relay.

## Updates and rollback

```bash
npx wrangler deployments list
npx wrangler rollback <version-id>
```

Or redeploy the previous git revision. Durable Object storage is not rolled
back by a Worker rollback; the schema is additive and lazy.

## Security notes

- Keep host credentials (`TOKIMEKI_TOKEN`, `TOKIMEKI_MASTER_TOKEN`) and TURN
  secrets out of git, logs, screenshots, and issue reports.
- `.dev.vars` is ignored by git; `.dev.vars.example` only contains placeholders.
- The relay carries terminal bytes when P2P/TURN are unavailable. Treat the
  relay operator as trusted infrastructure; this is not end-to-end encryption.
