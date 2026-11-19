# Web viewer contract (v1.2-C)

TokiAPI owns the browser viewer (`/#t-<code>`, xterm.js, WS proxy); tokimeki
owns the relay side and publishes the wire contract + test vectors here. No
`web-client` package exists.

## 1. Flow

```text
Browser  --POST /api/tokimeki/attach {code}-->  TokiAPI
         <-- Set-Cookie: tokimeki_attach=<ticket>; HttpOnly; 60s; Path=/api/tokimeki/ws
Browser  --GET /api/tokimeki/ws (cookie + Origin)--> TokiAPI proxy
         TokiAPI signs a Web Session JWT (300s, scope "attach web" | "listen web")
         --wss://relay/ws/<session>  X-Tokimeki-Session: <JWT>-->
Relay    verifies the Session JWT (token_use=session, session claim == path,
         namespace prefix, attach/listen scope) and skips the opaque hash check.
```

The browser never sees a Host JWT or a Session JWT. Every reconnect must first
`POST /api/tokimeki/attach` again: tickets are single-use and the cookie
expires after 60 s. A 410 means the link is invalid/expired/revoked; stop
reconnecting.

## 2. Proxy frame policy

- **Binary terminal frames**: pass through unchanged (INPUT/OUTPUT/SNAPSHOT_TO
  etc.). Do not parse or log payloads.
- **Text control frames**: parse JSON; for `welcome` remove `iceServers`,
  `iceProvider`, and `iceExpiresAt`; drop `ice` messages. The browser is
  relay-only and must never receive TURN credentials.
- Strip all client `x-tokimeki-*` headers, then set only the trusted
  `X-Tokimeki-Session` (and `X-Tokimeki-Listener: 1` for listeners). Never
  inject `X-Tokimeki-Token`/`Authorization` (host credentials).
- Origin must exactly equal the proxy request origin. Map upstream 401→401,
  503→503, other→502.

## 3. Passcode (v1.2-D)

If the invite has `passcodeRequired`, the browser sends
`{"v":1,"type":"passcode","value":"..."}` as its **first** WS text message.
The proxy consumes that frame (never forwards it), opens the upstream
connection with `X-Tokimeki-Passcode`, then forwards subsequent frames. A
missing/incorrect passcode yields `passcode_required`/`passcode_invalid`/
`passcode_locked` and a 4001 close.

## 4. Viewer state machine

1. `onopen` → send `passcode` (if required), then `hello`:
   `{v:1,type:"hello",role:"viewer"|"listener",session,clientId,protocolVersion:1,
   client:{name:"tokiapi-web",version:"1",kind:"web"},
   capabilities:{display:{modes:["viewport"]},transports:{modes:["relay"]}}}`.
   Listeners add `{listener:{modes:["snapshot-only"]}}` and omit `cols/rows`.
2. `welcome` → show host state.
3. Binary `OUTPUT` → write only `seq > lastSeq`; ACK every 100 ms / 64 KiB
   with `{v:1,type:"ack",seq:String(seq)}`.
4. Binary `SNAPSHOT_TO` → only when `targetId === clientId` and `seq >=
   lastSeq`; reset the terminal, write, then ACK.
5. `host-exited` / `error{code:"host_exited"}` → show exit state, stop
   reconnecting. `slow_consumer` → reconnect.
6. Input: `term.onData` → binary `INPUT` frame. Listeners never send input,
   resize, or ACK.
7. Resize: FitAddon + ResizeObserver, 250 ms debounce → `resize` control
   message.
8. Reconnect: exponential backoff 1/2/4…15 s, max 5; **re-attach before every
   new WebSocket**; attach 410 → invalid-link.

## 5. Cross-repo e2e

`scripts/e2e/v1.2-cross-repo.mjs` (tokimeki) drives the whole chain against
local servers:

```bash
# TokiAPI (repo root, after build + local migrations)
npx wrangler dev --port 5173 \
  --var TOKIMEKI_JWT_PRIVATE_JWK:<es256-private-jwk-json> \
  --var TOKIMEKI_RELAY_URL:ws://localhost:8788

# relay
cd packages/relay
npx wrangler dev --port 8788 \
  --var TOKIMEKI_JWT_JWKS_URL:http://localhost:5173/api/tokimeki/jwks.json \
  --var TOKIMEKI_JWT_ISSUER:http://localhost:5173 \
  --var TOKIMEKI_JWT_ALLOW_HTTP:1

# tokimeki repo
npm run build
TOKIAPI_BASE_URL=http://localhost:5173 \
TOKIMEKI_RELAY_URL=ws://localhost:8788 \
node scripts/e2e/v1.2-cross-repo.mjs
```

The harness asserts: anonymous host JWT admission, CLI viewer via a Session
JWT from `attach/cli`, web viewer through the proxy, no TURN fields in
`welcome`, and INPUT from the web viewer reaching the host and both viewers.
