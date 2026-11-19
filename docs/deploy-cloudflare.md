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
npx wrangler secret put TOKIMEKI_MASTER_TOKEN

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

| Name | Kind | Required | Meaning |
|---|---|---|---|
| `TOKIMEKI_MASTER_TOKEN` | secret | yes | Host authentication. Unset/blank rejects all hosts (fail-closed). Never give it to viewers. |

`GET /healthz` is public and intentionally minimal. `GET /auth/whoami` is the
authenticated operations probe: it accepts only the root master token in
`X-Tokimeki-Master` and returns the auth mode plus TURN provider/configured
state. It never returns tokens, TURN credentials, secrets, or ICE URLs.

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

# Send the master token from your secret store; never commit a real value.
curl -s -H "X-Tokimeki-Master: $TOKIMEKI_MASTER_TOKEN" \
  https://<your-worker>.workers.dev/auth/whoami
# {"ok":true,"service":"tokimeki-relay","protocolVersion":1,"authMode":"master",
#  "turn":{"provider":"stun","configured":false}}
```

`/healthz` is public and minimal by design (no TURN/JWT/namespace details).
`/auth/whoami` requires the root master token, returns `401` without a valid
one, `405` for non-GET requests, and sets `no-store`. Its response never
contains the token, TURN credentials, secrets, or ICE URLs. After configuring
TURN, `turn.provider` becomes `coturn`, `static`, or `cloudflare` and
`turn.configured` becomes `true`; if it stays `stun`, a required var or secret
is missing.

External monitors should check `/healthz` for HTTP 200 only, or use
`/auth/whoami` with the master token for TURN diagnostics.

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

- Keep `TOKIMEKI_MASTER_TOKEN` and TURN secrets out of git, logs, screenshots,
  and issue reports.
- `.dev.vars` is ignored by git; `.dev.vars.example` only contains placeholders.
- The relay carries terminal bytes when P2P/TURN are unavailable. Treat the
  relay operator as trusted infrastructure; this is not end-to-end encryption.
