# 路线图

> 本文件区分 v1 交付、v1.1 增强与 v2 兼容性工作。
> **v1.1 与 v2 不属于当前 v1 验收（AC1–AC10）**，未完成不会阻塞 v1 归档。

## v1（已交付基线）

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

当前状态：**v1 实现完成（Phase 6）；v1.1 已立项并进入规划（2026-11-16）**。
relay、PTY/TUI、共享控制、快照重连与 P2P/TURN/relay 回退已落地；本机 live e2e
1–5 组场景通过（第 5 组为 host 1006 重连，见 `docs/deployment.md` §7.2）。生产
Worker 已部署，2026-11-13 已完成本机 NAT ↔ 日本/美国 VPS 的跨机器 relay、直连
P2P、coturn TURN、Cloudflare TURN 与 TURN 不可达回退验收（§7.3/§7.4）。

2026-11-16 维护者人工确认**严格 NAT↔NAT**（含 P2P 尝试与 relay 回退）与
**真实 Claude/pi TUI 交互**已通过 e2e 层面验收（`docs/deployment.md` §7.6）；
该确认不等同于长期运行、直连成功率、生产边缘休眠或全路径验收。

仍待环境/授权验证：Cloudflare 边缘 hibernation/TTL alarm 长跑、同 LAN host
candidate、跨公网 3-viewer、跨机器 1006 复测、P2P 直连成功率/长期稳定性，以及
稳定链路上的生产流控；详见 `docs/deployment.md` §7.5。

v1 基线历史限制（F0 已在 `b8c9ec4` 解决）：v1 本身不做 DataChannel 分片，切换
快照统一走 relay `SNAPSHOT_TO`；P2P 失败直接回退 relay；客户端没有 ICE 到期自动
刷新定时器。v1.1 F0 已实现 capability-gated `FRAGMENT`、P2P 直发快照、ICE 自动
刷新与一次 provider 重试。

## v1.1（独立任务，不阻塞 v1）

状态（2026-11-16）：父任务 `.trellis/tasks/11-15-tokimeki-v1-1` 已创建。F0 已实现、
本地验证并归档（提交 `b8c9ec4`：typecheck/lint/276 tests/75 relay tests/build、
P2P 快照 e2e、live-e2e 1–4、host 重连）；F0 新能力的真实跨公网 NAT/TURN 复测与
生产部署尚未执行。F2 listener snapshot-only 已实现、提交（`147974f`）并归档；
本地 live e2e（`E2E_LISTENER=1` + P2P viewer，2026-11-16）已通过。F1 TUN profile
已实现、提交（`1cbebc8`）并通过 tunnel live e2e（session-token 与 shared-secret
两种 keyMode；P2P-only AEAD + selective-repeat ARQ；XOR FEC 暂缓到 F1.1）。
F3 已实现、提交（`53f6861`）：LAN 提示 + mDNS/peer fan-out 设计评估（fan-out
不实现、默认关闭）。至此 F0/F1/F2/F3 四个 v1.1 子任务均完成本地实现与验收；
剩余为环境依赖验证、XOR FEC 后续项与生产部署。

- **F0 P2P 传输增强（已完成并归档，`b8c9ec4`）**：新增 capability-gated
  `FRAGMENT` 帧（0x08）实现
  DataChannel 分片/重组；P2P 直发 `SNAPSHOT`（peer 不支持或发送失败时回退
  relay `SNAPSHOT_TO`）；ICE 到期自动 `ice-refresh`；P2P 协商失败后按 provider
  顺序重试一次，再回退 relay。设计已覆盖 viewer 先失败重试、旧快照 stale guard、
  ICE refresh 串行/quiet 等失败路径。协议新增项需同步 golden vectors 与
  `docs/protocol.md`；relay/DO 不改路由行为。
- **F1 应用层可靠隧道（TUN profile，已实现并提交 `1cbebc8`，本地 e2e 通过）**：
  任务 `.trellis/tasks/11-16-v1-1-f1-tunnel`。只封装 tokimeki 终端字节流，不做
  OS TUN/VPN。首版在 WebRTC unreliable/unordered DataChannel 上做
  selective-repeat ARQ（窗口 64、有界重传）+ AES-256-GCM，P2P-only；relay
  路径保持现有 v1 帧与流控，TUNNEL 仍不转发。默认 `TOKIMEKI_TUNNEL=off`；
  `auto` 需双方 capability/keyMode 匹配。默认由 session token 派生密钥时 relay
  可推导，只作传输加固；relay-blind 需独立 `TOKIMEKI_TUNNEL_SECRET` 带外共享。
  XOR FEC（`TOKIMEKI_TUNNEL_FEC=xor`）本版暂缓，capability 只声明
  `fec:["none"]`。本地 live e2e（`E2E_TUNNEL=1`，session-token 与 shared-secret
  各一次）、listener+P2P、F0 P2P 快照、flow-control+secret 与 host 重连已通过。
  尚未验证：强制丢包/乱序注入、secret 不匹配的 live 回退、真实跨公网高丢包；
  host/attach 的 tunnel 切换目前只有 live e2e 覆盖，没有纯单元测试（单测覆盖
  crypto/ARQ/capability/TunnelTransport 本体）。
- **F2 听众模式（已实现并提交 `147974f`，本地 live e2e 通过）**：任务
  `.trellis/tasks/11-16-v1-1-f2-listener`。只读、无 ack/背压，第一版
  snapshot-only（周期全量快照），独立上限 `TOKIMEKI_MAX_LISTENERS`；本地
  host + viewer + listener live e2e（含 P2P viewer）已通过，生产/真实跨公网环境待复测。
- **F3 同内网/相邻网络优化（LAN 提示已实现并提交 `53f6861`，fan-out 仅设计）**：v1 已利用
  ICE host candidate；v1.1 增加 selected pair 的 `lan=yes|no` 诊断提示（仅提示，
  不改变选路）。mDNS 不采用（不作发现权威）；peer fan-out 仅完成 leader 选举/
  保序/信任/故障切换设计，默认 off、不在本版实现。
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
