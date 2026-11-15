# Security policy

## Supported versions

The `0.1.x` release line is supported with security fixes. Older/unreleased
versions may not receive fixes.

## Reporting a vulnerability

Please report security issues **privately** via
[GitHub Security Advisories](https://github.com/limccn/tokimeki/security/advisories/new).
Do not open a public issue or include exploit details in a public discussion.

Include:

- affected version (`tokimeki --version`) and platform;
- relay deployment mode (Cloudflare Worker version, self-hosted);
- a minimal reproduction and expected/actual behavior;
- relevant logs with tokens, session tokens, TURN credentials, and terminal
  content removed.

You should receive an acknowledgement within a few days. We will coordinate a
fix and disclosure window with you.

## Security model

- `TOKIMEKI_MASTER_TOKEN` authenticates hosts to the relay. It must never be
  shared with viewers or committed.
- Session tokens are per session and should be shared only with intended
  viewers.
- Tokens are sent in headers/stdin, not URLs; logs redact known secrets.
- When the Worker relay carries terminal data, the relay operator can see those
  bytes. P2P/TURN change the transport path; they are not a claim of
  end-to-end encryption.
- TURN credentials are short-lived and issued by the relay. Do not expose
  `TOKIMEKI_COTURN_SECRET` or `TOKIMEKI_TURN_API_TOKEN` to clients.

## Secret leakage

If a master token, session token, or TURN secret is exposed, rotate it
immediately:

```bash
npx wrangler secret put TOKIMEKI_MASTER_TOKEN
npx wrangler secret put TOKIMEKI_COTURN_SECRET
npx wrangler secret put TOKIMEKI_TURN_API_TOKEN
```

and restart hosts/relay sessions with the new values.
