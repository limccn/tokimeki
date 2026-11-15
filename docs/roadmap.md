# 路线图

> 本文件区分 v1 交付、v1.1 增强与 v2 兼容性工作。
> **v1.1 与 v2 不属于当前 v1 验收（AC1–AC10）**，未完成不会阻塞 v1 归档。

## v1（当前任务）

TypeScript/Node + npm workspaces：

- Worker + 每会话一个 SessionDO 的 WebSocket 中继（Hibernation、TTL alarm、心跳）。
- WebRTC DataChannel 直连优先，失败优先走自建 coturn TURN，Cloudflare TURN 兜底，
  再回退 Worker 中继，客户端无感。
- `tokimeki claude` / `tokimeki pi` 在 PTY 中托管 TUI；`tokimeki attach` 远程接入。
- 多客户端共享控制、快照重连、ack/背压、主令牌 + 会话令牌认证。
- 全部运行配置通过环境变量提供。
- 协议包预留 `TUNNEL 0x06` / `TUNNEL_TO 0x07`、`listener` 角色、
  `tunnel`/`listener`/`peerRelay` capabilities 与语言中立 golden fixtures 骨架；
  预留项在 v1 只返回 `not_implemented`，不实现行为。
- Agent 协调只建 SQLite schema 与 `agent.*` 协议扩展点，不实现 runner。

当前状态：**v1 实现完成（Phase 6）**。relay、PTY/TUI、共享控制、快照重连与
P2P/TURN/relay 回退已落地，本机 live e2e 三组场景通过。生产 Worker 部署、跨 NAT、
真实 coturn/Cloudflare TURN 与同 LAN host candidate 验证仍待环境/授权，详见
`docs/deployment.md` §7。

已知 v1 限制（不阻塞 AC，但进入 v1.1 待办）：P2P 切换不实现 DataChannel 分片，
快照统一走 relay `SNAPSHOT_TO`；P2P 失败后直接回退 relay，不做 ICE provider
轮换重试；客户端没有 ICE 到期自动刷新定时器。

## v1.1（独立任务，不阻塞 v1）

- **F0 P2P 传输增强**：DataChannel 分片/重组与 P2P 直发快照（含 golden vectors 或
  传输层兼容说明）；ICE 到期自动 `ice-refresh`；P2P 失败后按 provider 顺序重试一次。
- **F1 应用层可靠隧道（TUN profile）**：只封装 tokimeki 终端字节流，不做 OS TUN/VPN。
  在 WebRTC unreliable/unordered DataChannel 上做 selective-repeat ARQ（KCP 风格）+
  可选 XOR/RS FEC + AES-256-GCM；WS relay 上只保留加密封装，不叠加 ARQ/FEC
  （TCP 队头阻塞无法消除）。默认由 session token 派生密钥时 relay 可推导，
  只作传输加固；relay-blind E2E 需独立 `TOKIMEKI_TUNNEL_SECRET` 带外共享。
- **F2 听众模式（listener）**：只读、无 ack/背压，第一版 snapshot-only
  （周期全量快照），独立上限；任意丢增量帧会破坏 ANSI 状态，不作为默认。
- **F3 同内网/相邻网络优化**：v1 已利用 ICE host candidate；v1.1 再评估
  `RouteSelector`、同 LAN 分组提示、mDNS（仅提示，不作发现权威）与 peer fan-out
  （默认 off，需 leader 选举、保序、信任与故障切换设计）。
- 交付顺序：Transport/capabilities/golden 骨架 → listener snapshot-only →
  AEAD（先定密钥威胁模型）→ unreliable DataChannel ARQ → FEC → LAN 选路 →
  peer fan-out（仅设计/实验开关）。

## v2（独立任务）

- Go/Rust 纯二进制实现，复用 v1 wire protocol、加密封装、帧类型与 Worker 中继。
- 不假设 KCP/FEC 跨语言 wire 兼容：要么用 golden vectors + 互操作测试验证同一方言，
  要么只共享 TUNNEL/AEAD 信封、ARQ 各自实现。
- Go 候选：`pion/webrtc/v4`、`xtaci/kcp-go/v5`、`klauspost/reedsolomon`；
  Rust 候选：`webrtc`、`kcp`/`tokio-kcp`、`reed-solomon-simd`、`aes-gcm`/`hkdf`/`sha2`
  （版本与维护性在 v2 立项时复核）。
- v2 验收：Node ↔ Go/Rust 双向 attach、与 v1 relay 互通、golden frames 字节级一致。

## 不实现（v1 明确排除）

- Web 浏览器终端 UI、文件传输、端口转发、完整 VPN。
- 内建 daemon / 服务托管（宿主进程由用户用 pm2/systemd/任务计划等保持运行）。
- OS 级 TUN 网卡、任意 IP 流量转发、DNS/路由接管。
- 完整云端 Agent runtime、R2 大结果存储、容器/沙箱 runner。
