# tokimeki troubleshooting

| Symptom / error | Meaning | Action |
|---|---|---|
| `TOKIMEKI_RELAY_URL is required` | No relay configured | Set the relay URL (do not put tokens in it) |
| `TOKIMEKI_TOKEN or TOKIMEKI_MASTER_TOKEN is required` | No host credential | Use `TOKIMEKI_TOKEN`; master is a deprecated alias |
| `TOKIMEKI_NAMESPACE and TOKIMEKI_TOKEN must be set together` | Namespace credential pair incomplete | Set both, namespace matching the relay's token map |
| `TOKIMEKI_SESSION must start with "<namespace>."` | Namespace host with a root-scoped session | Rename to `<namespace>.<slug>` |
| `unauthorized` / HTTP 401 | Bad/expired credential, wrong namespace, or relay auth mode mismatch | `tokimeki doctor`; confirm JWKS mode or namespace token |
| `host_offline` | Host is not connected (yet) | Wait; confirm the exact session name |
| `session_full` | Client/listener limit or relay quota | Close unused viewers/listeners; retry later |
| `passcode_required` / `passcode_invalid` | Host set `TOKIMEKI_PASSCODE` | Supply the passcode through the user's environment |
| `passcode_locked` | Too many failed passcode attempts | Wait 30s |
| `rate_limited` / HTTP 429 | Relay/TokiAPI rate limit | Back off; do not loop. Retry-After is shown |
| `jwks_unavailable` / HTTP 503 | Relay cannot fetch JWKS or anonymous service unconfigured | Retry later; self-host or use namespace tokens |
| `config file ... must be 0600` | Secret-bearing config is group/other-readable | `chmod 600 <path>` and retry |
| `--config sets TOKIMEKI_RELAY_URL without a host credential` | Partial config file could leak another layer's token | Put `token` in the same file and use that relay, or set both relay and credential in explicit env |
| `the share URL fragment must be #t-<code>` | Not a TokiAPI invite URL | Copy the full `https://.../#t-...` URL |
| `the Session JWT is short-lived...` | Hosted invite exchange succeeded | Attach now; re-exchange the invite after expiry |
| `node-pty` probe failed | PTY unavailable | Install a supported Node/native build; on Windows run in Windows Terminal |
| Fixed window does not resize | `TOKIMEKI_WINDOW`/`TOKIMEKI_WINDOW_SIZE` pins the grid | Use the host F12 menu's resize item or unset the fixed window |
| Terminal drawing corrupts while attaching | Logs/traces on stdout | Keep diagnostics on stderr; do not merge streams |
| `TUN` not active | P2P/tunnel negotiation failed or capability mismatch | Check `TOKIMEKI_TUNNEL=auto` on both sides and P2P reachability; relay fallback is expected |
| Invite/login page says unavailable | TokiAPI anonymous hosting disabled or rate-limited | Self-host a relay or retry later |

## Security reminders

- The relay sees terminal bytes; P2P/TURN change the path, not the trust model.
- TUN default keys derive from the session token (relay can derive them); only
  `TOKIMEKI_TUNNEL_SECRET` shared-secret mode is relay-blind.
- v1.7 per-IP rate-limit hardening and v1.8 credential revocation/rotation are
  not shipped; do not promise them.
