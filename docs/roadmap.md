# 路线图

> 本文件区分 v1 交付、v1.1 增强与 v2.0 兼容性工作。
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

当前状态：**v1 实现完成（Phase 6）；v1.1 五个子任务已完成本地实现并归档，
生产/跨机器验证待执行（2026-11-18）**。
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

状态（2026-11-18）：父任务 `.trellis/tasks/11-15-tokimeki-v1-1` 已创建并于
2026-11-16 归档为 completed。F0 已实现、
本地验证并归档（提交 `b8c9ec4`：typecheck/lint/276 tests/75 relay tests/build、
P2P 快照 e2e、live-e2e 1–4、host 重连）；F0 新能力的真实跨公网 NAT/TURN 复测与
生产部署尚未执行。F2 listener snapshot-only 已实现、提交（`147974f`）并归档；
本地 live e2e（`E2E_LISTENER=1` + P2P viewer，2026-11-16）已通过。F1 TUN profile
已实现、提交（`1cbebc8`）并通过 tunnel live e2e（session-token 与 shared-secret
两种 keyMode；P2P-only AEAD + selective-repeat ARQ）；F1.1 XOR FEC 已实现、
提交（`24a5dfb`；`TOKIMEKI_TUNNEL_FEC=xor`，capability `fec:["none","xor"]`，
单丢包 parity 恢复，多丢包/丢 parity 仍走 ARQ）。F3 已实现、提交（`53f6861`）：LAN 提示 +
mDNS/peer fan-out 设计评估（fan-out 不实现、默认关闭）。至此 F0/F1/F1.1/F2/F3
五个 v1.1 子任务均完成本地实现与验收；剩余为环境依赖验证与生产部署。

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
  XOR FEC（`TOKIMEKI_TUNNEL_FEC=xor`）由 F1.1（`24a5dfb`）补齐：capability 声明
  `fec:["none","xor"]`，每 8 条 data 记录发一条 AEAD parity，接收端恢复恰好
  1 条丢失记录；丢 parity/多丢包继续依赖 ARQ。本地 live e2e（`E2E_TUNNEL=1`，
  session-token 与 shared-secret 各一次）、listener+P2P、F0 P2P 快照、
  flow-control+secret 与 host 重连已通过。
  尚未验证：强制丢包/乱序注入、secret 不匹配的 live 回退、真实跨公网高丢包；
  FEC 单丢包恢复目前只有单元/TunnelTransport 集成证据，没有真实丢包 e2e；
  host/attach 的 tunnel 切换目前只有 live e2e 覆盖，没有纯单元测试（单测覆盖
  crypto/ARQ/FEC/capability/TunnelTransport 本体）。
- **F2 听众模式（已实现并提交 `147974f`，本地 live e2e 通过）**：任务
  `.trellis/tasks/11-16-v1-1-f2-listener`。只读、无 ack/背压，第一版
  snapshot-only（周期全量快照），独立上限 `TOKIMEKI_MAX_LISTENERS`；本地
  host + viewer + listener live e2e（含 P2P viewer）已通过，生产/真实跨公网环境待复测。
- **F3 同内网/相邻网络优化（LAN 提示已实现并提交 `53f6861`，fan-out 仅设计）**：v1 已利用
  ICE host candidate；v1.1 增加 selected pair 的 `lan=yes|no` 诊断提示（仅提示，
  不改变选路）。mDNS 不采用（不作发现权威）；peer fan-out 仅完成 leader 选举/
  保序/信任/故障切换设计，默认 off、不在本版实现。
- 交付顺序：Transport/capabilities/golden 骨架 → listener snapshot-only →
  AEAD（先定密钥威胁模型）→ unreliable DataChannel ARQ → FEC（F1.1 已完成 XOR
  单丢包）→ LAN 选路 → peer fan-out（仅设计/实验开关）。

## Relay 身份/namespace 路线（2026-11-19 确认）

1. **master token 单人回退**（现状）：一个全局 root；仅在未配置有效
   namespace token 时可用，不是通用 break-glass。
2. **静态 multi-namespace 多用户**（OSS 主方案）：`TOKIMEKI_NAMESPACE_TOKENS`
   按 namespace 分发 host token，不要求 JWT/TokiAPI。
3. **JWT 对接 TokiAPI 用户**（hosted）：Host JWT/JWKS 已落地，relay 离线验签
   Host JWT；Session JWT/feature flags 未来。当前对齐切片为 E
   `11-19-v1-2-cli-tokiapi-host-jwt`。

wire 统一使用 `<namespace>.<slug>`（点号），不引入 `/ws/<namespace>/<session>`
斜杠路径。

## v1.2（A–E 已交付，待发布）

状态（2026-11-20）：父任务 `.trellis/tasks/11-18-v1-2-multi-namespace-web` 与
五个子任务均已完成，代码在本地 `develop`（**未 push、未发布**）。

- **E `11-19-v1-2-cli-tokiapi-host-jwt`**：Host JWT 最小验签 + CLI
  `TOKIMEKI_TOKEN`/只读 config.json；已合入 `develop`。生产此前以 no-JWT
  模式部署并完成 live e2e；JWT 生产部署仍待用户决定。
- **A `11-18-v1-2-namespace-auth`**：Session JWT viewer/listener 验签
  （`token_use=session`、attach/listen、session=路径、namespace 前缀、
  DO hash bypass + 复核；legacy NULL 拒绝）。
- **B `11-18-v1-2-cli-ux`**：按 TokiAPI `invites` 契约实现（**无**
  `POST /api/tokimeki/sessions`）；CLI 接受 Session JWT（不解析）、
  viewer config v2、`TOKIMEKI_PASSCODE` header、显式预置 env 离线路径。
- **C `11-18-v1-2-web-ui`**：`docs/web-viewer.md` + 跨仓 e2e；Web viewer、
  Session JWT 签发与 WS 代理在 TokiAPI 仓库实现。
- **D `11-18-v1-2-passcode`**：PBKDF2 verifier、`X-Tokimeki-Passcode`、
  5 次失败/30s 锁定、welcome capability、CLI/Web passcode 门禁。
- TokiAPI 三个 Tokimeki 任务（master-token / share-link-attach /
  getting-started）已完成；本地跨仓 e2e（普通 + passcode）通过。
- v1.2 不阻塞 v2.0；v2.0 弱网 A/B 验证仍押后。

### E 已确认的凭证/路由

- Host 凭证唯一 `TOKIMEKI_TOKEN`（Host JWT 或静态 namespace token；CLI 不解析）；
  `TOKIMEKI_NAMESPACE` 必填；`X-Tokimeki-Token` 是唯一 host 头
  （旧 `X-Tokimeki-Master` 拒绝）；`TOKIMEKI_NAMESPACE_TOKEN` 退役；
  `TOKIMEKI_MASTER_TOKEN` 仅作单人回退，启用有效 `TOKIMEKI_NAMESPACE_TOKENS`
  后失效（root `*` 接管同时失效）。
- Host JWT：ES256；JWKS 在 **TokiAPI 管理台域** `/api/tokimeki/jwks.json`；
  claims `iss/aud/sub/namespace/token_use=host/scope/iat/nbf/exp/jti`；
  默认 TTL 30 天；relay 离线验签，不逐连接回调 TokiAPI。
- `TOKIMEKI_JWT_JWKS_URL` 未配置 = JWT 关闭（不解析三段式、不拉 JWKS）；
  配置非法 = JWT 凭证 fail-closed；JWKS 不可达且无缓存 = 503。
- `Authorization: Bearer` 仅作为 JWT 模式 web/代理的 Host JWT 第二载体；
  CLI 不发送；JWT 关闭时不解析/不剥离。
- **破坏性变更**：header 更名；namespace token 启用后 fallback 失效。
  CLI/relay 必须成对升级；生产部署前必须轮换/分发 namespace token，或清空
  secret 保持 fallback 模式，否则 host 认证锁死。

### A–D 交付要点

- A：`X-Tokimeki-Session` 三段式在 JWT 模式按 `token_use=session` 验签；
  `attach`/`listen` scope、`session`=路径、namespace 前缀；DO hash bypass
  但复核 session/namespace/scope；Session JWT 不作 host；legacy NULL 拒绝。
- B：CLI 不解析 Session JWT；viewer config v2；`TOKIMEKI_PASSCODE` 发送
  `X-Tokimeki-Passcode`；离线路径 = 显式预置 `TOKIMEKI_SESSION` +
  `TOKIMEKI_SESSION_TOKEN`。
- C：TokiAPI 负责 Session JWT 签发、invite、WS 代理与 xterm.js viewer；
  tokimeki 提供 `docs/web-viewer.md` 与 e2e harness。
- D：可选 session passcode（PBKDF2 + `X-Tokimeki-Passcode`），与 6–8 位
  TokiAPI 会话 token 是两套机制。

### 边界

- 不引入 SQLite namespace 目录/introspection/per-viewer JWT/refresh token/
  撤销列表；不独立发布 web-client 包；不做组织/团队模型、浏览器 P2P；
  wire version 保持 v1。

## v2（独立任务）

### v2.0 前置决策：弱网注入可靠传输 A/B 验证（已押后）

状态（2026-11-18）：规划任务 `11-18-v2-0-weaknet-ab-validation` 已创建，当前为
planning。用户已决定**押后（postponed）**，暂不启动，恢复时间待定。恢复后该
验证仍是 v2.0 transport 选择的前置条件；在结论出来前，不把 TUN 应用层
ARQ/FEC 当作 v2.0 的既定实现。

- **目的**：在可控丢包/乱序/重复/抖动/限速环境下，比较：
  - A：v1 reliable/ordered DataChannel（SCTP 可靠 + 有序）；
  - B：reliable/unordered DataChannel（SCTP 可靠、无 SCTP 排序；仅 harness
    参考路径，除非结论建议提升为产品路径）；
  - C：unreliable/unordered + TUN selective-repeat ARQ（当前 F1）；
  - D：unreliable/unordered + TUN SR-ARQ + XOR FEC（当前 F1.1）；
  - R：relay 回退基线（只测失败/回退正确性与恢复时间）。
- **注入**：主环境为 Linux VM / network namespace + `tc netem`，在真实 UDP 路径
  注入 loss/reorder/duplicate/jitter/rate；Windows/macOS 工具只做 sanity。
  跨公网 WAN 作为外部有效性补充，不作为主矩阵。
- **指标**：字节级正确性、p50/p95/p99 完成时间或 RTT、goodput、HOL/停顿、
  重传/FEC 恢复、tunnel 失败与 relay 回退时间、CPU/RSS、ACK 字节占比。
- **预注册决策门槛（待 PRD 确认）**：所有变体必须 100% 字节正确；TUN 只有在
  目标丢包档位下显著改善 p99/恢复时间，且 CPU/ACK 开销可接受时才保留；否则
  v2.0 优先 reliable DataChannel 方案，移除或降级应用层 ARQ/FEC。
- **产物**：`scripts/perf/weaknet/`（可复现 harness）、
  `docs/perf/weaknet-ab.md`（报告与决策）、任务 PRD/design/implement。
- **不阻塞**：v2.0 的 wire 信封/relay 兼容工作可以并行；只阻塞 transport
  可靠性方案的最终选型。

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
