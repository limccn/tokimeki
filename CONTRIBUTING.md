# Contributing to tokimeki

Thanks for helping improve tokimeki. This project is a Node.js/TypeScript
monorepo with a Cloudflare Worker relay, a CLI, and a shared wire protocol.

## Before you start

- Read [README.md](README.md) for the product and [CLAUDE.md](CLAUDE.md) for the
  architecture and protocol details.
- Check existing issues/PRs before opening a new one.
- For security issues, follow [SECURITY.md](SECURITY.md) instead of opening a
  public issue.

## Development setup

Requirements: Node.js >= 22.12 and npm >= 11.

```bash
git clone https://github.com/limccn/tokimeki.git
cd tokimeki
npm install
npm run build
```

## Checks

Run these before pushing:

```bash
npm run lint
npm run typecheck
npm run typecheck:relay
npm test
npm run test:relay
npm run build
```

For relay changes, also run a local live e2e:

```bash
npm run dev:relay          # terminal A
# terminal B: scripts/e2e/live-e2e.mjs with local env values
```

For cross-NAT/performance changes, see `scripts/perf/README.md`. Performance
results are not a substitute for functional e2e tests.

## Code style

- TypeScript ESM + NodeNext; strict compiler options.
- Biome (`npm run lint` / `npm run format`); line width 100, 2 spaces.
- Keep the protocol package dependency-free; import wire types from
  `@limccn/tokimeki-protocol`, never duplicate them in relay/cli.
- Do not log tokens, TURN secrets/credentials, terminal payloads, or signal
  payloads. Tests must use fake values, never production tokens.

## Commits and pull requests

- Keep commits focused; explain the behavior change and the test evidence.
- PR description: what changed, why, test commands/results, docs updated.
- Add a CHANGELOG entry for user-visible changes.
- Do not include secrets, `.env`, `.dev.vars`, or generated performance results.
- Production deploy/provider changes require maintainer approval.

## Documentation

Update the relevant doc when behavior changes:

- `README.md` / `README.zh-CN.md` — user-facing overview.
- `docs/cli.md` — CLI commands/env.
- `docs/deploy-cloudflare.md` — relay/TURN deployment.
- `docs/protocol.md` — wire protocol.
- `CLAUDE.md` — architecture/implementation details.

## License

By contributing, you agree that your contributions are licensed under the
Apache License 2.0.
