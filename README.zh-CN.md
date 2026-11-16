<div align="center">
  <img src="https://raw.githubusercontent.com/limccn/tokimeki/main/assets/icon.png" width="112" height="112" alt="tokimeki icon" />
  <h1>tokimeki</h1>
  <p><strong>跨机器共享实时终端会话，不需要屏幕共享。</strong></p>
  <p>一端用 PTY 托管 Claude Code、pi 或任意 TUI 程序，另一端通过 WebRTC P2P、TURN 或 Cloudflare relay 回退接入。</p>

  [![npm](https://img.shields.io/npm/v/@limccn/tokimeki.svg?label=npm)](https://www.npmjs.com/package/@limccn/tokimeki)
  [![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
  [![node](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen.svg)](https://nodejs.org/)
  [![CI](https://img.shields.io/github/actions/workflow/status/limccn/tokimeki/ci.yml?branch=main&label=CI)](https://github.com/limccn/tokimeki/actions/workflows/ci.yml)

  [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/limccn/tokimeki)

  [部署 relay 到 Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/limccn/tokimeki) · [CLI 文档](docs/cli.md) · [English](README.md)
</div>

---

## tokimeki 是什么？

tokimeki 让一台机器**托管**终端程序，另一台机器**接入**同一个实时会话。
它面向长时间运行的 TUI 工具：host 保持 PTY 存活，viewer 看到屏幕，多人共享键盘控制。

- **不是屏幕共享/远程桌面**，只传输终端字节。
- **P2P 优先，relay 兜底**：WebRTC DataChannel（直连）→ coturn TURN →
  Cloudflare TURN → Cloudflare Worker WebSocket 中继。
- **可自托管**：relay 部署到你自己的 Cloudflare 账号。
- **断线恢复**：快照 + 序号，viewer 掉线重连后恢复屏幕。
- **多 viewer**：多人接入，输入共享，resize 协调。

## 工作方式

```mermaid
flowchart LR
  H["Host<br/>tokimeki claude<br/>(PTY + headless screen)"]
  V["Viewer<br/>tokimeki attach"]
  R["Cloudflare Worker<br/>+ SessionDO relay"]

  H <-->|"WebRTC DataChannel<br/>(直连或 TURN)"| V
  H <-->|"WebSocket：信令、<br/>快照、relay 回退"| R
  V <-->|"WebSocket 回退"| R
```

更深入的协议/架构说明见 [`CLAUDE.md`](CLAUDE.md) 与
[`docs/protocol.md`](docs/protocol.md)。

## 安装

需要 Node.js >= 22.12。

```bash
npm install -g @limccn/tokimeki
tokimeki --version
```

或临时运行，不全局安装：

```bash
npx @limccn/tokimeki --help
```

## 快速开始

### 1. 部署 relay

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/limccn/tokimeki)

使用上方按钮，或从仓库部署：

```bash
git clone https://github.com/limccn/tokimeki.git
cd tokimeki
npm install
npm run deploy
```

在 Cloudflare dashboard 或 `wrangler secret put TOKIMEKI_MASTER_TOKEN`
设置必填 secret。生成强随机值：

```bash
openssl rand -base64 32
```

relay URL 形如 `https://<worker-name>.<your-subdomain>.workers.dev`（CLI 用
`wss://...`）。自定义域、coturn、Cloudflare TURN 见
[Cloudflare 部署](docs/deploy-cloudflare.md)。

### 2. Host 一个会话

```bash
export TOKIMEKI_RELAY_URL=wss://<your-relay>
export TOKIMEKI_MASTER_TOKEN=<relay-master-token>

tokimeki claude
# 或 tokimeki pi
# 或 tokimeki run -- <your-tui-command>
```

host 会打印 **session name** 和 **session token**。把这两个值给 viewer；
**不要分享 relay master token**。

### 3. 从另一台机器接入

```bash
export TOKIMEKI_RELAY_URL=wss://<your-relay>
export TOKIMEKI_SESSION=<session-name>
export TOKIMEKI_SESSION_TOKEN=<session-token>

tokimeki attach
```

`tokimeki doctor` 用于检查本地 PTY 与 relay 配置。

## 命令总览

| 命令 | 作用 |
|---|---|
| `tokimeki claude [args...]` | 用 PTY 托管 Claude Code |
| `tokimeki pi [args...]` | 用 PTY 托管 pi |
| `tokimeki run -- <cmd...>` | 托管任意 TUI/终端程序 |
| `tokimeki attach` | 接入一个已托管会话 |
| `tokimeki doctor` | 检查 PTY、配置与 relay 连通性 |

完整命令/env 参考：[docs/cli.md](docs/cli.md)。

## TURN 部署

relay 可以下发 STUN/TURN 凭据。默认先用 STUN-only/Worker relay；需要更好
连通性时再加 TURN。

| `TOKIMEKI_TURN_PROVIDER` | 使用方式 |
|---|---|
| `auto`（默认） | 配了 coturn REST 就用，否则静态 TURN，再否则 Cloudflare TURN，最后 STUN-only |
| `coturn` | 自建 coturn；设置 `TOKIMEKI_COTURN_URLS` 与 secret |
| `cloudflare` | Cloudflare Realtime TURN；设置 Key ID + API token |
| `none` | 仅 STUN；Worker relay 兜底 |

TURN 变量、secret、按钮/手动部署步骤：
[docs/deploy-cloudflare.md](docs/deploy-cloudflare.md)。CLI 只使用 TURN UDP
（libjuice），URL 列表里至少保留一条 `turn:...?transport=udp`。

## 配置

所有运行时配置都通过环境变量：

- [`.env.example`](.env.example) — 完整参考（含 v1.1 预留变量）。
- [docs/cli.md](docs/cli.md) — host/attach 命令与变量。
- [docs/deploy-cloudflare.md](docs/deploy-cloudflare.md) — relay vars/secrets。

常用：`TOKIMEKI_RELAY_URL`、`TOKIMEKI_MASTER_TOKEN`（仅 host）、
`TOKIMEKI_SESSION`、`TOKIMEKI_SESSION_TOKEN`、`TOKIMEKI_P2P`（`auto|off`）、
`TOKIMEKI_ICE_TRANSPORT_POLICY`（`all|relay`）。

## 安全与隐私

- token 走 header，不放进 URL；relay master token 只给 host。
- relay 承载终端数据时可以看到终端字节；P2P/TURN 改变传输路径，但不等于
  端到端加密。
- 使用专用 relay/session；master token 泄漏时及时轮换。
- 漏洞请按 [SECURITY.md](SECURITY.md) 私下报告，不要开公开 issue。

## 文档

- [CLI 使用](docs/cli.md)
- [Cloudflare relay 部署 + TURN](docs/deploy-cloudflare.md)
- [线协议](docs/protocol.md)
- [生产部署说明](docs/deployment.md)
- [AI 助手技术指南](CLAUDE.md)
- [性能基线](docs/perf/)
- [发布指南](docs/release.md)

## 状态

`0.1.1` — 当前版本。从
[npm](https://www.npmjs.com/package/@limccn/tokimeki) 安装（同时镜像到 GitHub
Packages，见 [docs/release.md](docs/release.md)），或查看
[v0.1.1 release notes](https://github.com/limccn/tokimeki/releases/tag/v0.1.1)。
P2P 直连是尽力而为；TURN 或 Worker relay 是可靠回退。已知限制与 v1.1
功能演进见 [CHANGELOG.md](CHANGELOG.md) 与 [`CLAUDE.md`](CLAUDE.md)。

## 贡献

欢迎 issue/PR。请先读 [CONTRIBUTING.md](CONTRIBUTING.md) 与
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

## 许可证

Apache License 2.0，见 [LICENSE](LICENSE)。
