# 路线图

> 本文件区分 v1 交付、v1.1 增强、v1.2–v1.7 用户途径/agent 分发与 v2.0
> 兼容性工作。
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

## v1.2（已完成，2026-11-19/22）

状态：父任务 `.trellis/tasks/11-18-v1-2-multi-namespace-web` 与 5 个子任务
（E/A/B/C/D）已完成 5/5。v1.2 不阻塞 v2.0。

### 0.1.3 no-JWT mainline

- tag `v0.1.3`；CLI/protocol 版本 0.1.3。
- E Host JWT/CLI 凭证对齐已合入；生产 Worker `b4af8f47`（2026-11-20，
  `relay.tokiapi.app`），namespace token 已轮换。
- 0.1.3 生产窗口未配置 `TOKIMEKI_JWT_*`（no-JWT）；no-JWT live e2e（基础、
  secret 清洗、listener）通过。生产随后升级到 0.1.4（见下）。
- TokiAPI Host JWT ↔ relay 真实 live e2e 已在 0.1.4 生产部署后完成（见下）。

### 0.1.4 jwt line

- 分支 `jwt` / `release/0.1.4`；tag `v0.1.4` 在 `e86f747`，版本 0.1.4。
- 已发布：A Session JWT、B invite v2/session 创建、C Web viewer、
  D passcode、cross-repo e2e；npmjs/GitHub Packages 双发布，生产 relay
  `93bad9e4…` 与 TokiAPI prod `60569f11…` 已部署（2026-11-21/22，生产
  0.1.4 + Host/Session JWT）。
- **0.1.4 代码已于 2026-11-23 合入 `develop`**（merge `release/0.1.4`）；
  `jwt` 分支与 `release/0.1.4` 同提交。
- 剩余：TokiAPI 本地 `7902297` 未推送、完整 TokiAPI 套件待干净 CI；
  5 位 namespace 唯一性确认；安全审查 follow-up（web scope 校验、TURN
  剥离、passcode secret 清单等）。生产 e2e 已知 WAN 超时：流控
  pause/resume 与 TUN XOR 重连。

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

### E 凭证模型（0.1.3）

- Host 凭证唯一 `TOKIMEKI_TOKEN`（Host JWT 或静态 namespace token）；
  `TOKIMEKI_NAMESPACE` 必填；`X-Tokimeki-Token` 唯一 host 头
  （旧 `X-Tokimeki-Master` 拒绝）；`TOKIMEKI_NAMESPACE_TOKEN` 退役。
- `TOKIMEKI_MASTER_TOKEN` 仅单人回退，启用有效
  `TOKIMEKI_NAMESPACE_TOKENS` 后失效（root `*` 接管同时失效）。
- Host JWT：ES256；JWKS 在 TokiAPI 管理台域 `/api/tokimeki/jwks.json`；
  claims `iss/aud/sub/namespace/token_use/scope/iat/nbf/exp/jti`；
  默认 TTL 30 天；relay 离线验签。
- `TOKIMEKI_JWT_JWKS_URL` 未配置 = JWT 关闭；配置非法 fail-closed；
  JWKS 不可达无缓存 = 503。
- `Authorization: Bearer` 仅 JWT 模式 web/代理 Host JWT 第二载体；
  CLI 不发送。

## v1.4（已交付，0.1.5，2026-11-23）

状态：父任务 `.trellis/tasks/11-20-v1-4-user-onboarding` 与 10 个子任务
（A–J）均已实现并随 **0.1.5**（tag `v0.1.5`）交付（2026-11-23）。规划已完成收敛
（2026-11-22）：Open Questions 已由代码库证据回答，各子任务
implement/check jsonl 清单已配置；B 拆分为 B1/B2。
2026-11-23 规划评审：B2 的 TokiAPI 契约已在本地 `cf-ai-gateway` 核实
（`GET /api/config`、`POST /api/tokimeki/anon-host`、
`POST /api/tokimeki/attach/cli`），B2 收窄为生产验证/跨仓冻结（生产
端点后由用户 2026-11-23 确认功能测试覆盖）；A 的
daemon 事件通道/schema、G 的日志视图键与阈值、E 的写入白名单已冻结。
2026-11-23 追加 H（下载 config 文件 host + share URL attach）、I（ACP 9 种
应用 + TUI 自动识别研究）、J（no-JWT 静态接入站）。
**基线为 `develop`；`jwt`/0.1.4 已于 2026-11-23 并入 `develop`（合并门禁
已解除）。用户已于 2026-11-23 确认 TokiAPI 功能测试覆盖生产
`/api/config`、`anon-host`、`attach/cli`；v1.4 无外部阻塞。生产部署/发布
仍需用户批准。**
2026-11-23 安全审计（quick/scoped 设计级）：0 confirmed、7 needs_validation；
可修项归入 H/A/J/E/D/G/I，限速/边缘加固归入 v1.7 R8，凭证/会话生命周期新建
v1.8；摘要见
`.trellis/tasks/11-20-v1-4-user-onboarding/audit/2026-11-23-security-audit.md`。

**交付记录（0.1.5）**：A–J 已实现。本地验证：601 个单测（5 skipped）、relay
五套（155+15+23+8+12）、`build:site`、两份 Wrangler dry-run、basic 与
`E2E_WINDOW=1` live e2e、自包含
`scripts/e2e/v1.4-onboarding-e2e.mjs`（v2 config-file host、daemon 事件、
passcode、share-URL attach、assets 路由、无落盘）。生产 relay 已部署
（version `cb651e83`，`relay.tokiapi.app` 返回站点/CSP、`/healthz` 200、
`/auth/whoami` 401、`/ws` 426）。固定窗口的 F12 实时 resize 因 v1 无
wire 消息更新 viewer fixed-grid 而延后到 v1.8；非 fixed 策略可用。TokiAPI
匿名路径本轮未重跑生产 live（沿用用户 2026-11-23 功能测试确认，本地用 mock）。

目标：补齐用户途径——CLI 交互/守护模式、doctor-first host/attach 向导、
默认 `relay.tokiapi.app` 的匿名 namespace/token 申请、F12 连接菜单、
config.json 持久化与历史连接；外加托管 config/URL 快捷入口、ACP 9 种
应用与 TUI 识别研究、no-JWT 静态接入站、CLI UX（F12 调整窗口、弹出式
DEBUG 日志、宽终端侧栏）。进程接管仅规划。

- **A CLI 模式/harness**：interactive/daemon、非 TTY、doctor-first、
  结构化 ready/error，适配 harness。
- **B Host 向导（拆分 B1/B2）**：relay 默认 `wss://relay.tokiapi.app`；
  有 token 时推荐 `TOKIMEKI_TOKEN`（`TOKIMEKI_MASTER_TOKEN` 为 deprecated
  兼容别名）；自部署 relay 无 token 时给出 one-click Cloudflare Deploy
  Button/docs + token 配置指引（仅指导，不执行部署）；
  `relay.tokiapi.app` 无 token 时申请匿名 namespace/token。B1 向导
  主体 + mock provisioning client 先行（不被跨仓契约阻塞）；B2 接
  TokiAPI 现有 `anon-host`（本地 `cf-ai-gateway` 已核实契约）；生产
  `api/config`/`anon-host`/`attach/cli` 已由用户 2026-11-23 确认功能测试
  覆盖，实现时记录契约差异即可。
- **C Attach 向导**：relay/session/sessionToken 分步；hello 连接测试
  （复用同一连接，不加 relay 端点）；支持粘贴 v1 viewer JSON 或 TokiAPI
  invite URL/code（`attach/cli` 兑换 Session JWT，不落盘）。
- **D F12 菜单**：host 状态/会话/Token（匿名 host 的 inviteUrl 仅内存
  显示/复制）；viewer/listener 状态、分享复制、重连/断开；不改变 PTY 尺寸。
- **E config/history**：向导显式写入 `~/.tokimeki/config.json`（含 token，
  0600、原子写、no-follow）；独立 `~/.tokimeki/history.json`（20 条 LRU）
  可恢复/清理。**变更 v1.2/E 的 "CLI 只读 config.json" 安全规则。**
- **F 进程接管**：仅 PRD/design，未来实现；禁止 ptrace/跨用户/提权。
- **G CLI UX**：F12 host 菜单调整窗口大小（走现有 resize 管道）；
  DEBUG 日志去底部常驻——窄终端整屏日志视图（tab 式切换）、宽终端
  （≥阈值）右下角常驻日志区，尺寸变化自动切换。
- **H 托管快捷入口**：`tokimeki --config <tokimeki-config.json>` 使用
  TokiAPI 下载的 v2 envelope 直接 host；`tokimeki attach <share-url>`
  （`#t-<code>`）经 `attach/cli` 兑换 Session JWT 后 attach。`jwt`/0.1.4
  已于 2026-11-23 并入 `develop`（a427bf2），v2/passcode/Session JWT
  可用。
- **I ACP/TUI**：CLI 覆盖 TokiAPI 预定义的 9 种 ACP
  （claude/pi/codex/gemini/cursor/aider/opencode/goose/amp）；先研究
  TUI 自动识别（只读 PATH、不执行未知二进制），再按结论实现。
- **J no-JWT 静态接入站**：与 relay 绑定、只适配 multi-namespace 静态
  token、纯静态、无 JWT/后端；复用 TokiAPI（MIT）可用代码/UI 设计，
  与 `relay.tokiapi.app` 一同部署。

依赖/阻塞：

- 依赖 0.1.3/0.1.4 的 CLI/relay 凭证模型。
- B2 的匿名 namespace/token 申请使用 TokiAPI 现有公开契约
  （`GET /api/config`、`POST /api/tokimeki/anon-host`、
  `POST /api/tokimeki/attach/cli`）；生产验证已由用户 2026-11-23 确认功能
  测试覆盖；仅需实现时记录契约/差异，不再被“未定义 API”阻塞。C 的 hosted invite 兑换依赖 0.1.4 的
  Session JWT/passcode。
- **基线（2026-11-23）**：`jwt`/0.1.4 已并入 `develop`，v1.4 基线 =
  `develop`；H/C 的 hosted live 验证前置已满足。实现启动仍待用户确认
  TokiAPI 功能测试完成；开始前不建实现分支、不启动任务。
- H 依赖 `jwt → develop` 合并（已于 2026-11-23 完成）与 B/C 契约；I 研究
  先行、无 JWT 依赖；
  J 无 JWT 依赖、与 relay assets 同部署（生产部署需批准），可与 A–E
  并行。
- A 是 B/C/D 的基础；E 先于 B/C 的“保存”步骤；D 依赖 B/C/E；G 的
  R2/R3 可与 A–E 并行、R1 依赖 D；F 未来。
- E 的 token 落盘、匿名申请、F12 token 展示需安全审查；relay 仍要求
  token，不匿名 host/viewer。

## v1.5（已交付，0.1.6，2026-11-23）

状态：父任务 `.trellis/tasks/11-20-v1-5-agent-onboarding` 与 3 个子任务
（A skill / B dsh 插件 / C 发布）已实现并随 **0.1.6**（tag `v0.1.6`）交付
（2026-11-23）。skill 位于 `skills/tokimeki/`，本地
`npx skills add . --list` 已验证可发现；GitHub 默认分支 `main` 仍为
0.1.2，需维护者合并 `release/0.1.6` 后默认分支安装才可用。dsh 插件源码
与 13 个测试已完成（`D:/Workspace/tokimeki-dsh`，commit `9464dad`），但
新建公开仓库 `limccn/tokimeki-dsh` 需要用户显式授权（或由用户在 GitHub
UI 创建）并配置 `NPM_TOKEN` 后才能发布 npm/GitHub Release。

启动前置（2026-11-23）：先对齐 v1.4 路线图（A/B/C/E/H/J）与 0.1.4
凭证模型（推荐 `TOKIMEKI_TOKEN`，`TOKIMEKI_MASTER_TOKEN` 为 deprecated
兼容别名）、one-click Cloudflare Deploy Button（skill 仅指导，不执行
部署）、TokiAPI `api/config`/`anon-host`/`attach/cli` 生产功能测试
（**已由用户 2026-11-23 确认覆盖**）；未记录对齐结论不启动 A/B/C。

v1.4 实现状态：A–J 仍为 planning，0.1.4 仅含 jwt/JWT/passcode/v2；
skill/plugin 对 `--config`/share URL/F12/config-history/no-JWT/ACP 标注
v1.4+。安全审计 follow-up（H2 relay URL scheme/origin、config
partial-file 混配、config 0600/删除、argv secret env、v1.7 限速、
v1.8 撤销/轮换）纳入 skill/plugin 警告。

目标：让 AI agent 更容易接入 tokimeki——通用 skill、DeepSeek Harness
插件，以及公开发布/分发。

- **A 通用 tokimeki skill**：主仓库 `skills/tokimeki/SKILL.md`；安装用
  `npx skills add limccn/tokimeki --skill tokimeki`（不存在短名）；
  `docs/agent-install.md` 提供“安装 skill + npm 包 + doctor”的提示词；
  覆盖三 host 路径/attach/安全/troubleshooting，不要求 agent 输出 token；
  严格纯提示词、无 hook/script、默认只读、项目级安装缺口已记录。
- **B tokimeki-dsh 插件**：独立 `tokimeki-dsh` 仓库，npm 包
  `@limccn/tokimeki-dsh`；native dsh bundle（`dsh.bundle.patch` +
  `cordis.patch.yml`），MCP 可选；工具 **只读/规划**
  doctor/status/host_plan/attach_plan/share_plan；无 host_start/部署/
  自动 host/attach；不执行任意 shell、不把 token 返回给模型。
- **C 公开发布**：npm public + GitHub Release + skills CLI（git 源）+
  dsh 社区目录（无官方 marketplace）；版本/CHANGELOG/provenance/
  供应链/安全审查；实际 publish 需用户单独批准。

依赖/阻塞：

- 依赖 tokimeki CLI 0.1.3/0.1.4 的公开命令与配置模型。
- skills CLI 只接受 `owner/repo`/Git URL/本地路径；不存在 registry 短名。
  skills.sh 网站收录是独立 best-effort，不承诺时间。
- dsh 插件依赖 `@deepseek-ai/cordis`/`@deepseek-ai/dsh-tools` 与独立仓库
  发布节奏；dsh 没有官方 marketplace。
- skill/plugin 会指导 agent 执行命令：需防 prompt injection、token 泄漏、
  任意 shell；发布前安全审查。
- 不阻塞 v2；与 v1.4 并行。

## v1.7（实现完成，待发布）

状态：任务 `.trellis/tasks/11-22-v1-7-relay-rate-limit-hardening`
（`prd.md` / `design.md` / `implement.md`）。2026-11-26 在分支
`feat/v1-7-relay-rate-limit` 完成 relay/CLI 部分（R1/R2/R3/R5/R6/R8 文档与
测试），TokiAPI `/api/tokimeki/ws`（R4）在同日独立分支
`D:/Workspace/cf-ai-gateway` 完成；尚未合并、发布或部署生产。安排在 v2
之前；当前用户量不大，但应在大规模匿名 onboarding 前上线。基线为
`develop`（0.1.4 已于 2026-11-23 并入；生产 0.1.4 已部署）。

目标：在 relay/TokiAPI 侧补齐匿名/会话凭证的 **按 IP 限速** 与 **失败重试
上限**，压低会话 token 枚举、passcode 分布式猜测和 429 无限重连风险。
不改变现有 wire 协议、不新增错误码、不改变 relay 信任模型。

已实现（用户确认阈值）：

- **relay `/ws` per-IP 限速**：Worker 边缘 `TOKIMEKI_WS_IP_LIMIT`
  `[[ratelimits]]` binding，覆盖会进入 DO 的 upgrade 尝试；30/60s/IP，
  超限 429 + `Retry-After: 60`；binding/IP 缺失或 binding 异常时 fail-open
  并记录独立日志；客户端伪造 `x-tokimeki-client-ip`/`x-real-ip` 不被信任。
  生产配置使用 namespace 3001；根 OSS 配置只保留注释示例。
- **失败 opaque session-token 锁限 + 统一 unauthorized**：session 不存在、
  token 不匹配、锁限期间返回同一 `unauthorized`（4001），移除存在性
  oracle；对已存在 session 按 IP+session 计数，10/60s → 锁 60s；成功清除；
  不做整 session 锁；不存在的 session 不创建 schema，由边缘限速兜底；
  Session JWT/host 的具体错误保留。
- **匿名 token 熵由 TokiAPI 决定**：relay 不假设 token 长度/字符集；测试
  覆盖 6/8/16/32 位与字母数字 opaque token。
- **TokiAPI `/api/tokimeki/ws` per-IP 限速**：独立 `TOKIMEKI_WS_LIMIT`
  （30/60s），429 + `Retry-After`，fail-open；`connectUpstream()` 透传
  可信 `x-real-ip`（同 zone 时 relay 可继续按真实 web viewer IP 计数）；
  一次性 ticket/Origin/invite/passcode gate 顺序不变。
- **CLI relay 429 重试上限**：连续 429 最多 6 次，保留 1s..30s 指数退避；
  第 6 次连续 429 触发 `session_full` fatal（exit 1）；`welcome`/成功
  upgrade/非 429 响应重置计数，503 仍按现有策略重试。
- **passcode per-IP 失败限制**：per-IP 主锁 5/60s → 60s；per-session
  高阈值兜底 50/60s → 60s（不再 5/30s 全局锁）；IP 缺失时退回高阈值；
  正确 passcode 清除两类计数；与 passcode 验证共用串行队列。
- **Cloudflare 边缘/部署加固（R8，v1.4 审计 follow-up）**：部署文档记录
  credential-entry HTTPS-only/HSTS/secure-context、`/ws` 的 edge Rate
  Limiting/WAF 兜底、Static Assets 路由、no-JWT token 熵分工与 owner
  观察清单。本项只做文档/检查清单，不修改生产 zone。
- **测试/文档/观测**：新增 `session_auth_failures`（additive、行数上限 64、
  清理、purge 随 `deleteAll()`）；日志 `ws_ip_rate_limited` /
  `ws_rate_limit_binding_missing` / `ws_rate_limit_no_ip` /
  `session_token_locked` / `passcode_ip_locked` /
  `auth_failure_store_unavailable` 不含凭证或原始 IP；
  protocol/deployment/cli/roadmap 已更新。

已知取舍：Cloudflare 限速是 per-location、eventually consistent 的尽力而为
压制，不得表述为“已防住爆破”；NAT 共享出口可能误伤；分布式 IP 仍可尝试
token 猜测，主要依赖 TokiAPI 的 token 熵；per-session passcode 高阈值全局锁
仍可能被大量分布式来源触发；per-session open-socket 429 仍会暴露“session
存在且繁忙”；计时侧信道不做强保证。生产部署、binding 启用、TokiAPI 上线与
release 发布仍需单独批准。

### 慢路径退回与发送节奏（2026-11-26 并入 v1.7）

与上面的凭证 per-IP 限速不是同一件事。任务
`.trellis/tasks/11-26-v1-7-path-pacing`，父调研
`11-26-protocol-china-isp-resilience`。已实现，两个开关默认关闭，尚未发布。

只做调查目录的第 1、2 项，都在现有 Node host 和现有帧上，默认关闭：

- **慢 P2P 退回**：ready 之后若发送缓冲达到 64 KiB，且连续 3 秒排空速率低于
  `TOKIMEKI_P2P_DRAIN_BYTES_PER_SEC`，该 viewer 用现有 `transport failed`
  回到 relay 并重新快照。变量未设置或为 0 时不判断。空闲、没有积压的 P2P
  不退回。
- **发送节奏**：`TOKIMEKI_SEND_PACE_BYTES_PER_SEC` 限制快照和大于 1024 字节的
  OUTPUT；更小的 OUTPUT 优先。单张快照最慢 8 秒，以免超过 10 秒分片重组时限。
  变量未设置或为 0 时保持立即写入。

不做 ACK 合并、FEC 默认开启、TUN 拥塞控制、QUIC、随机封装、更换 UDP 端口、
为限速做 relay E2E、IPv6 优先。不测量境内网络，也不把社区帖里的速率写成默认值。
退回 relay 后，relay 仍能看到终端字节。

## v1.8（规划中，2026-11-23 立项）

状态：任务 `.trellis/tasks/11-23-v1-8-credential-lifecycle-hardening`
（`prd.md` / `design.md` / `implement.md`）已创建，当前为 planning，未启动
实现。安排在 v1.7 之后、v2 之前。来源：v1.4 设计安全审计的 deferred
lifecycle 项。

目标：补齐凭证与会话的 **生命周期** 安全边界：撤销、过期、轮换、陈旧
config/history 清理，以及 relay/TokiAPI TTL/撤销契约。

- **匿名 Host JWT/invite 生命周期**：TTL 对齐、到期提示/重新申请；评估
  TokiAPI 匿名 invite 撤销（或明确“仅 TTL”取舍）；不可枚举。
- **Session JWT 撤销/驱逐/绑定**：`jti` denylist 或 viewer epoch；host 驱逐
  viewer/listener；评估 client binding/更短 TTL；撤销存储有界、休眠恢复兼容。
- **Host/session token 轮换**：显式确认；旧 viewer token 失效；config/history
  不自动覆盖；namespace token 轮换运维流程。
- **config/history 生命周期**：可选 `expiresAt`/`credentialKind`/`savedAt`；
  过期/陈旧识别与清理命令；Session JWT/invite URL/passcode 仍不落盘。
- **跨仓/兼容**：TokiAPI 撤销/epoch 契约独立任务；旧 CLI/viewer/relay
  兼容；additive schema；生产部署/发布需批准。

已知取舍：撤销代际依赖 TokiAPI 签发 epoch；短期只能 jti denylist 或重新
兑换 invite；viewer 驱逐需限速/确认，避免 host/其他 viewer DoS。

### v1.4/v1.5 delivery follow-ups（任务 `11-23-v1-8-v1-4-v1-5-followups`）

- 固定窗口实时 resize：新增 additive `display-size`/capability 刷新路径，
  更新 relay DO、协议文档/goldens、viewer 重连行为；恢复 F12 fixed 菜单项并补
  多 viewer e2e。
- 公开发布 `tokimeki-dsh`（用户 2026-11-24 决定暂缓到 v1.8）：用户创建/授权
  `limccn/tokimeki-dsh` 公开仓库、配置 `NPM_TOKEN`，推送 `main`/`v0.1.0`，
  由 CI 发布 npm + GitHub Release；本地源码/测试保留在
  `D:/Workspace/tokimeki-dsh`（commit `9464dad`）。
- skill 分发：合并 `release/0.1.6` → `main` 后验证默认分支
  `npx skills add limccn/tokimeki --skill tokimeki`、卸载与 skills.sh
  indexing request（best-effort）。
- TokiAPI `api/config`/`anon-host`/`attach/cli` 生产 live 复测（200/429/503、
  TTL、relay wss 绑定）。
- 清理项：`TOKIMEKI_TOKIAPI_URL` 定位、ACP 检测跨平台 CI、skill 结构/secret
  扫描脚本。

## v2（独立任务）

### Transport hardening 与多 namespace 设计（P2 暂缓）

- `11-18-v1-1-censorship-resistance-p0-p2`：P0–P2 调研/设计，planning；P1
  实现已拆到 `11-18-v2-0-p1-tcp-tls-443-transport`，延后到 v2.0 Go/Rust
  客户端。P2（relay 承载 E2E AEAD，覆盖 `OUTPUT`/`INPUT`/`SNAPSHOT_TO`）
  **暂缓（postponed，2026-11-23）**，未获用户重新启动前不实现。
- `11-18-multi-namespace-design`（pre-P2 设计）：completed；设计稿
  `docs/multi-namespace-design.md` 已交付（2026-11-22/23）。P2 的
  AAD/KeyProvider 必须使用 `namespaceId/sessionId/epoch/keyId`。设计稿
  记录 **TokiAPI（本地 `develop`）当前没有 `S_s` 分发通道**，且 hosted 的
  host/viewer 不共享同一 secret：A/B 需新增跨仓契约；C 仅 OSS/manual
  可用（非 relay-blind）。
- 阻断/暂缓现状：v1.2 已实现 namespace 认证/路由（`<namespace>.<slug>`、
  token/JWT 派生 namespace、`session_meta.namespace_id`），原设计任务的
  namespace 范围已被覆盖；剩余 E2E 密钥层级/KeyProvider 设计已完成。
  P2 暂缓的主因是 hosted relay-blind 需要 TokiAPI 新增 `S_s` 分发契约；
  重新启动时先确认 §14 开放决策与 §15 门禁。
- `11-18-v2-0-p1-tcp-tls-443-transport`：planning，延后至 v2.0 Go/Rust
  客户端基线之后，不受多 namespace 设计阻塞。

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
