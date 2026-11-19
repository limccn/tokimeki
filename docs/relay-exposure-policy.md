# Relay 暴露面与 namespace 准入策略

> 状态：设计稿（2026-11-19）。本文定义 relay 对外暴露与准入策略，不描述
> 已实现行为；代码落地前以现有 `docs/protocol.md` / `docs/deployment.md` 为准。
> 相关设计：`.trellis/tasks/11-18-relay-exposure-policy`（决策与调研）、
> v1.2 JWT/JWKS（namespace 模型）、`docs/multi-namespace-design.md`（规划）。
>
> 已部分实现（2026-11-19，`11-19-relay-exposure-hardening`、
> `11-19-relay-namespace-tokens` 与 `11-19-relay-quotas-ttl` 分支；未提交、
> 未部署）：listener TURN 门禁、最小化 `/healthz` + 认证 `/auth/whoami`
> （v1 仅 root master）、TURN 凭据默认 TTL 900s、边缘 per-IP 限速文档化、
> 静态 namespace token（`TOKIMEKI_NAMESPACE_TOKENS` + CLI
> `TOKIMEKI_NAMESPACE_TOKEN`/`TOKIMEKI_NAMESPACE`，点号
> `<namespace>.<slug>` 路由）、per-session 绝对/空闲 TTL 与字节/消息速率
> 硬上限（见 §8.5）。JWT/JWKS、JWT `features`/`limits` 读取、付费/白名单
> 以及 per-namespace 日流量/签发次数聚合仍未实现。
>
> 术语：**namespace** 是隔离、配额与会话前缀的作用域单位。hosted 中它对应
> TokiAPI 用户/账户，OSS 中对应静态 namespace token；v1.2 JWT claim 已统一为
> `namespace`，早期 `tenant` 仅作为过渡别名。

## 1. 摘要

tokimeki relay 只有两个公网入口：`/healthz` 与 `/ws/<session>`。真正需要
严格准入的不是 WebSocket 路径本身，而是三类资源：

1. **TURN 中继字节**：按流量线性增长，且 relay 无法计量（数据不经过 relay）。
2. **relay 数据面**：成本较低，但协议允许任意字节，可被当作通用双向管道。
3. **会话创建与长连接**：host 在线时 session 没有绝对寿命，公开部署下可被
   长期占用或用来放大 Durable Object 成本。

策略结论：

- **host 准入**：hosted 必须 TokiAPI Host JWT；OSS 使用静态 namespace token
  （小团队主方案）或 root master；不提供匿名 host。viewer/listener 只需
  invite，不强制注册。
- **TURN 默认关闭**：hosted 由 TokiAPI 管理的付费/白名单 feature flag 决定；
  OSS 由部署者显式配置。tokimeki 不实现付费/白名单管理，只预留读取 JWT
  payload 的配置开关。
- **relay 数据面**按 namespace 给基础配额，按 namespace/session 限速，
  边缘按 IP 限速。
- **STUN / P2P 直连 / TUN（P2P-only）免费**，不占 relay 数据面。
- **`/healthz` 公开但最小化**；内部配置与 TURN/JWT 详情移到认证的
  `/auth/whoami`（具体 ops 字段后续定）。
- **OSS 默认不匿名开放 TURN**，保留 master/namespace token 门槛；hosted 的
  JWT/namespace 策略通过配置启用。

> 安全边界：relay 能看到终端字节；P2P/TURN 只改变传输路径，不改变信任模型。
> 本文不把 relay 描述为端到端加密。

## 2. 准入层级

| 层级 | 谁 | 认证 | 可用能力 |
|---|---|---|---|
| L0 Public | 任何人 | 无 | `/healthz`、STUN |
| L1 Invite | session 参与者 | Session JWT / legacy opaque token | viewer/listener、relay 数据面、P2P/TUN、控制面信令 |
| L2 Namespace host | hosted：TokiAPI 用户；OSS：namespace token 持有者 | Host JWT / 静态 namespace token / root master | 创建/托管 session；基础配额 |
| L3 Feature flags | 付费/白名单（TokiAPI 管理） | Host JWT payload 开关（预留） | TURN、更高配额 |
| L4 Ops | relay 运维 | master / 内部端点 | 全局配置、诊断、紧急关闭 |

- L0 不包含任何会话创建或数据面。
- L1 的 invite 由 host 分发；viewer 不需要 TokiAPI 账户。
- L2 是 host 最低门槛：hosted 必须 Host JWT；OSS 用静态 namespace token
  或 root master。
- L3 不自动授予；TURN 默认关闭，需 JWT feature flag（hosted）或部署配置
  （OSS）+ 会话显式开启。tokimeki 不管理付费/白名单。
- L4 的 master token 只用于运维/break-glass，不向用户分发。

## 3. 暴露面清单

| 路径/能力 | 数据经 relay | relay 可计量 | 成本 | 主要风险 | 策略 |
|---|---|---|---|---|---|
| `GET /healthz` | 否 | — | 极低 | 信息暴露 | L0，字段最小化 |
| `/ws/<session>` host | 是（控制/数据） | 是 | 低–中 | 通用字节管道、长会话占用 | L2（hosted Host JWT / OSS namespace token）/ L4（root master） |
| `/ws/<session>` viewer | 是 | 是 | 低–中 | 数据面滥用、连接放大 | L1 invite + 配额 |
| `/ws/<session>` listener | 是（仅快照） | 是 | 低 | 快照 fan-out | L1 invite + 独立上限 |
| `hello`/`welcome` ICE 签发 | 否（仅签发） | 仅签发次数 | 低 | 凭据外泄 | 仅 host/viewer；L3 TURN |
| `ice-refresh` | 否（仅签发） | 仅签发次数 | 低 | 反复签发/选贵 provider | 同 hello；服务端 provider 策略 |
| relay 数据面 `INPUT`/`OUTPUT`/`SNAPSHOT_TO` | 是 | 是 | 低–中 | 任意字节隧道 | 配额 + 限速 + ToS |
| coturn / Cloudflare TURN 数据面 | 否 | **否** | **高** | 通用 UDP/TCP 中继 | L3 feature flag + provider 兜底 |
| STUN | 否 | — | 极低 | 低 | L0 公开 |
| P2P 直连 / TUN（P2P-only） | 否 | — | ≈0 | 低 | L1 免费 |

关键边界：**relay 只能控制 TURN 凭据的签发，不能控制 TURN 的实际用量。**
因此 TURN 配额不是“流量扣减”，而是“签发配额 + 短 TTL + provider 侧封顶”。

## 4. 准入矩阵

| 能力 | hosted（relay.tokiapi.app） | OSS 默认 |
|---|---|---|
| `/healthz` | 公开，最小化字段 | 公开 |
| host 创建/托管 session | 必须 TokiAPI Host JWT | 必须静态 namespace token 或 root master |
| viewer/listener 接入 | invite，无需账户 | invite，无需账户 |
| relay 数据面 | namespace 基础配额 + 限速 | 运维策略；不匿名开放 host |
| listener | invite + 会话/namespace 上限 | invite + 上限 |
| TURN 签发 | TokiAPI feature flag；默认关闭；per-session 显式开启 | 部署配置显式开启；禁止匿名 |
| coturn / CF TURN | feature flag + provider 策略 | 运维负责 |
| STUN | 公开 | 公开 |
| P2P / TUN | 免费，仅需 invite | 免费，仅需 invite |
| 未来 observer/agent | 账户/namespace scope | 运维策略 |

> OSS 的 static namespace token 已实现（见 §16.4/§16.9，
> `11-19-relay-namespace-tokens`）；未配置 `TOKIMEKI_NAMESPACE_TOKENS` 时
> 保持 master-only。两者都不允许匿名 host。

## 5. TURN 策略

### 5.1 授权条件

TURN（coturn REST / static / Cloudflare）凭据的签发必须同时满足：

1. session 的 namespace 被授权 TURN：hosted 由 TokiAPI 管理的 JWT
   feature flag 决定（tokimeki 只预留读取，本版本不实现）；OSS 由部署配置
   决定；
2. session 创建时显式 `turn_enabled=true`；
3. 请求者是 host 或 viewer（**listener 一律不签发**）；
4. 未超过 per-session / per-namespace 签发配额；
5. provider 策略允许。

未满足时 `welcome.iceServers` 只返回 STUN，并通过 capability 或错误码
给出可诊断结果（如 `turn: "disabled"` / `turn: "quota_exceeded"`），
不泄露内部配置、secret 或 provider 凭据。

### 5.2 默认关闭与 per-session 开关

- namespace 被授权不等于自动使用 TURN。
- Host 在创建 session 时显式请求 TURN（hosted：TokiAPI session 创建参数或
  JWT feature flag；OSS：部署配置 + host 开关）；未请求时只返回 STUN。
- invite 中可携带 `turnEnabled` 提示；viewer 侧无需也不应自行决定。
- 这样可以把不可计量的 TURN 成本限制在明确开启的会话内。
- **OSS 的 per-namespace TURN allowlist / per-session 开关设计延后**；
  第一版保持运维 TURN 配置 + listener 门禁，不在 namespace token 任务中
  实现。hosted 的 TURN feature flag 仍由 TokiAPI 管理（预留）。

### 5.3 凭据 TTL 与签发限速

- 建议 TURN 凭据 TTL **15 分钟**（范围 10–60 分钟），随会话续签；
  不再使用当前 24 小时默认值。
- per-session 签发上限建议 6 次/小时；per-namespace 建议 60 次/小时。
- 每次 `ice-refresh` 都重新执行授权、角色门禁与限速；失败返回错误，
  不静默回退到另一个更贵的 provider。
- 并发 TURN session 数按 namespace 限制（建议 10）。

### 5.4 provider 策略

- 服务端决定 provider 顺序；客户端 `ice-refresh.provider` 只作为提示。
- 建议默认 coturn（成本可预测），Cloudflare TURN 作为兜底或按 feature
  flag 提供的能力；两者都配置时不允许 viewer 选择更贵的路径。
- coturn 侧必须设置 `user-quota` / `total-quota` 并监控出口带宽；
  Cloudflare 侧设置账户预算/用量告警。
- 明确记录：relay 侧指标只有“签发次数/拒绝原因”，没有 TURN 字节数。

### 5.5 泄露与滥用

- session token / Session JWT 是共享 bearer capability；泄露后可反复申请
  凭据。缓解：短 TTL、签发限速、会话级配额、host 可关闭会话、
  provider 侧封顶与异常告警。
- 本版本不引入撤销列表；依赖短 TTL、会话重建与 provider 侧兜底。

## 6. Relay 数据面策略

### 6.1 host 与 viewer

- hosted：host 必须 Host JWT；Worker 验签、校验 namespace/session 前缀与
  scope，不逐连接回调 TokiAPI。
- OSS：host 必须静态 namespace token 或 root master；Worker 常量时间匹配
  token、校验 `<namespace>.<slug>` 前缀；不提供匿名 host。
- viewer/listener：只需 Session JWT 或 legacy opaque token；不要求账户。
- listener 必须 `listen` scope；viewer 必须 `attach` scope。
- master token 仅 break-glass；hosted 不向用户分发。

### 6.2 通用字节管道风险

- 协议允许 `INPUT`/`OUTPUT` 携带任意字节（单帧 1 MiB），host + viewer
  可串通把 relay 当双向隧道。
- 不能只靠“终端语义”防滥用；需要 namespace 准入 + 配额 + 限速 + ToS +
  异常检测。
- 免费/低配额层应限制每秒字节数、每日流量和并发 session；超限拒绝新连接
  或关闭超额连接。

### 6.3 边缘与 DO 限速

- Cloudflare 边缘：per-IP WebSocket upgrade 速率（建议 30 次/分钟）、
  并发 pending 连接（建议 10）、失败率限速。
- Worker：新 session 创建速率按 namespace 限制；对明显不存在的 session
  快速拒绝，避免任意 session ID 放大 DO 成本。
- DO：per-session/namespace 的速率与流量计数；慢消费者沿用现有流控；
  listener 快照沿用“高缓冲丢弃”策略。

### 6.4 会话寿命

- 当前只有 host 离线后的 TTL；host 在线时 session 可长期存活。
- 新增：
  - **绝对 TTL**（从 `created_at` 起算，基础 8h / 有 feature flag 24h）；
  - **空闲 TTL**（无活动，基础 30 分钟）；
  - **host 离线 TTL**（基础 15 分钟，有 feature flag 可沿用 24h）。
- 到期前通知 host/viewer，到期关闭并清理 DO 存储；旧行按 legacy 处理。

## 7. 零成本路径与 healthz

- **STUN**：公开；用于候选发现，不承载终端数据。
- **P2P 直连**：免费；relay 只转发 signaling，不承载数据。
- **TUN（P2P-only）**：免费；relay 继续对 `TUNNEL` 帧返回
  `not_implemented`，不因策略改变协议行为。
- **`/healthz`**：公网只返回 `{ok, service, protocolVersion}`。
  `turnProvider`/`turnConfigured` 与 JWT/JWKS 详情移到认证的
  `/auth/whoami` 或日志；v1.2 若重写，也不得把 `jwt` 详情放回公网
  healthz。

## 8. 配额（初始建议，provisional）

> 以下数字是产品默认值，不是协议常量；上线观测后调整，可通过 env/TokiAPI
> 配置覆盖。终端流量通常远低于上限，配额主要用于防滥用与成本封顶。

### 8.1 Namespace 基础配额（L2）

| 项 | 建议值 |
|---|---|
| 并发 session / namespace | 3 |
| max clients / session（含 host） | 4 |
| max listeners / session | 1 |
| 绝对 session TTL | 8h |
| host 离线 TTL | 15min |
| 空闲 TTL | 30min |
| relay 速率 / session | 1 MiB/s 持续，8 MiB burst |
| relay 日流量 / namespace | 2 GiB/day |
| TURN | 关闭 |

### 8.2 Feature flag 配额（L3，预留）

> 第一版只实现硬上限与开关；JWT payload 的 `features`/`limits` 契约预留，
> relay 侧的 feature flag 读取实现延后，待 TokiAPI 契约冻结。

| 项 | 建议值 |
|---|---|
| 并发 session / namespace | 20 |
| max clients / session | 16 |
| max listeners / session | 8 |
| 绝对 session TTL | 24h（可配置到 7d） |
| relay 速率 / session | 4 MiB/s 持续，32 MiB burst |
| relay 日流量 / namespace | 20 GiB/day |
| TURN 凭据 TTL | 15min |
| TURN 签发 / session | 6/hour |
| TURN 签发 / namespace | 60/hour |
| 并发 TURN session / namespace | 10 |

### 8.3 超限行为

- 新 session/连接：拒绝并返回明确的 quota/rate-limit 错误。
- 已建立连接：按策略限速或关闭；不静默丢终端帧（除非现有流控规则）。
- 配额信息可在 welcome/capability 中暴露“是否受限”，不暴露内部阈值细节。

### 8.4 聚合边界

- 每个 session 是一个独立 DO；per-session 配额可在 DO 内精确强制。
- per-namespace 的并发 session、日流量、TURN 签发次数跨多个 DO，单 DO 无法
  独立精确计数。实现时需要 namespace 级计数器 DO、Analytics Engine/日志
  管道，或由 TokiAPI 侧限流；namespace 级限制允许短时最终一致，per-session
  限制才是硬边界。
- 不要求 relay 逐连接回调 TokiAPI；namespace 聚合数据可以异步上报。

### 8.5 第一版实现（2026-11-19，per-session 硬上限 + 开关）

第一版只做“硬上限 + 开关”，不做细粒度 throttle / PTY 暂停：

| env | 默认 | 语义 |
|---|---|---|
| `TOKIMEKI_SESSION_MAX_TTL_SECONDS` | 86400（24h） | 从 `created_at` 起算的绝对寿命；`0` 关闭；上限 30 天。host 在线也不能续期。旧行在下一次 host `hello` 设置 `now + maxTtl`。 |
| `TOKIMEKI_SESSION_IDLE_TTL_SECONDS` | 0（关闭） | 基于 `last_activity_at` 的空闲寿命；有控制/数据帧或心跳即刷新；alarm 触发时重读最新活动时间。 |
| `TOKIMEKI_SESSION_MAX_BYTES` | 0（关闭） | session 生命周期内 relay 转发的终端字节：host `OUTPUT`/`SNAPSHOT_TO`、viewer `INPUT`，每帧计一次，不按 viewer 放大。 |
| `TOKIMEKI_SESSION_MAX_MESSAGES_PER_SECOND` | 0（关闭） | 活跃连接入站 WebSocket 消息的 1 秒滑动窗口；pending/未认证 socket 不参与。 |

- TTL 到期：复用 `error{code:"host_exited"}` + 关闭码 4004，关闭所有连接后
  `deleteAll()`；alarm 优先级为绝对 TTL → 空闲 TTL → host 离线 TTL。
- 配额超限：复用 `error{code:"session_full"}` + 关闭码 4002，关闭整个 session
  并删除数据；不暂停共享 PTY、不静默丢帧。**不新增 wire error code**。
- 字节计数每累计 1 MiB 落盘；DO 休眠/驱逐可能丢失最后一次落盘后的增量
  （≤1 MiB），因此是近似硬上限。消息窗口同样随驱逐重置。P2P/TUN 数据不经过
  relay，不计入字节上限。
- 旧行兼容：`absolute_deadline` / `relay_bytes` 为 additive 列，缺列时读取回退
  为 `NULL`/`0`；关闭 env 即回到 v1.1 行为，无数据迁移。
- 本版不读取 JWT `features`/`limits`，也不做 per-namespace 日流量/签发次数
  精确聚合；这些仍是后续 counter DO/Analytics 任务。

## 9. JWT 配置开关（预留，TokiAPI 管理）

付费/白名单/计费/套餐由 TokiAPI 管理，tokimeki 不实现。tokimeki 只预留从
JWT payload 读取少量配置开关的路径；本版本不实现读取，字段名与语义待
v1.2-A 与 TokiAPI 对齐。

Host JWT（hosted，预留）：

```json
{
  "namespace": "team-a",
  "features": ["turn"],
  "limits": { "maxSessions": 3, "maxClients": 4, "maxListeners": 1 }
}
```

- `features` 是能力集合；`turn` 是否出现由 TokiAPI 决定。
- `limits` 可选；relay 有服务端默认值，claim 只能收紧不能放大。
- 未知 feature/claim 忽略；缺失按基础配额。
- v1.2-A 文档已统一使用 `namespace` claim；早期 `tenant` claim 如需兼容，
  只作为过渡别名，新签发一律使用 `namespace`。
- Session JWT 保持 v1.2 的 session/scope；namespace 通过 claim 或 session
  前缀绑定。
- DO 在 host hello 时持久化 `turn_enabled`；viewer 的 TURN 签发只看持久化
  结果，不要求 viewer 持有 Host JWT。
- 账户/namespace 降级或撤销不回溯已签发 JWT；靠短 TTL、会话重建、
  provider 侧配额与异常签发告警兜底。
- 静态 namespace token 模式没有 JWT；TURN/配额由部署配置决定。

## 10. 强制点与数据流

```text
Client
  │  Host JWT / Session JWT（hosted）
  │  或 static namespace token / root master（OSS）
  ▼
Cloudflare edge
  └─ per-IP upgrade/连接限速
  ▼
Worker
  ├─ JWKS 验签 / namespace token 匹配 / claims / scope
  ├─ <namespace>.<slug> 前缀校验
  ├─ 新 session：namespace 并发配额
  ├─ 注入内部头（role/namespace/features）
  └─ /healthz 最小化
  ▼
SessionDO
  ├─ session_meta：namespace_id、feature_flags/turn_enabled、created_at、deadline
  ├─ hello：角色门禁、绝对/空闲 TTL、TURN feature flag
  ├─ ice-refresh：角色门禁、签发限速、provider 策略
  ├─ relay 数据面：per-session/namespace 速率与字节配额
  └─ alarm：绝对 TTL / 空闲 TTL / 离线 TTL
  ▼
Provider（coturn / Cloudflare TURN）
  └─ user-quota / 预算 / 带宽告警
```

## 11. 可观测性、告警与降级

### 11.1 指标

- namespace/session/role/provider/result 维度的活跃连接、session 创建、TURN
  签发与被拒原因、relay 字节/消息速率、慢消费者、DO 错误率、配额触发。
- 不得记录 token、TURN 凭据、secret、终端内容。

### 11.2 告警

- 单 namespace TURN 签发突增、单 namespace relay 流量突增；
- DO 错误率、慢消费者比例；
- provider 预算/带宽阈值；
- JWKS 拉取失败/缓存未命中。

### 11.3 降级

| 失败 | 行为 |
|---|---|
| TURN feature flag 缺失/超额 | 只返回 STUN；会话继续走 P2P/relay |
| TURN provider 签发失败 | STUN-only + `turn_fallback` 日志；不阻断 |
| TokiAPI 不可用 | v1.2 master/opaque 或 OSS namespace token 回退；新 JWT session 创建失败；不匿名 |
| JWKS 不可用 | v1.2 fail-closed；不降级到未验签 |
| 配额超限 | 拒绝新 session/连接或关闭超额连接 |
| 边缘限速 | 429/拒绝 upgrade；不影响已建立连接 |

## 12. 分阶段落地与回滚

1. **观测**：只加日志/指标，不改变行为，确认流量与成本基线。
2. **低风险加固**：`/healthz` 最小化；TURN 签发的 listener 角色门禁；
   边缘 per-IP 限速。
3. **namespace 配额 dry-run**：计算超限但不拒绝，校验阈值。
4. **namespace 配额 enforce**：hosted host 必须 Host JWT；OSS 用 namespace
   token/master；free/namespace 配额生效。
5. **TURN feature flag**：hosted 由 TokiAPI 下发、OSS 由部署配置 +
   per-session 开关 + 短 TTL + 限速。
6. **绝对/空闲 TTL 与 namespace 聚合配额**：最后上线，避免误杀长会话。

### 12.1 Relay 身份/namespace 路线（2026-11-19 确认）

1. **master token 单用户（现状）**：一个全局 root，适合单管理员/break-glass。
2. **静态 multi-namespace 多用户**：`TOKIMEKI_NAMESPACE_TOKENS`，OSS 小团队
   主方案；不要求 JWT/TokiAPI。
3. **JWT 对接 TokiAPI 用户**：hosted；v1.2 设计后续重写，relay 只验签并读取
   namespace/feature flags；当前 v1.2 文档仅作历史参考。

- wire 路由使用点号 `<namespace>.<slug>`（2026-11-19 确认），不使用
  `/ws/<namespace>/<session>` 斜杠形式。
- 每步独立 env 开关；回滚 = 关闭开关，回到 v1.1 行为。
- 不依赖数据迁移；`session_meta` 新列可空，旧行按 legacy/free 处理。
- wire version 保持 v1；v1.1 client 无需改动。

## 13. 对实现任务的要求

- **Worker**：Host JWT 验签或 static namespace token 常量时间匹配 /
  root master；`<namespace>.<slug>` 前缀校验；namespace/features 注入；
  新 session 配额；`/healthz` 最小化；边缘限速接入。JWT feature flag 读取
  只预留，不实现。
- **SessionDO**：session 元数据扩展；hello/ice-refresh 角色门禁与 TURN
  feature flag 校验；签发限速；绝对/空闲 TTL；per-session/namespace 计数。
- **TokiAPI（不在本仓库）**：付费/白名单/计费管理；签发 Host/Session JWT；
  决定 JWT payload 中的 `features`/`limits` 开关；JWKS 与短 TTL。tokimeki
  只预留读取，不实现这些管理逻辑。
- **Provider**：coturn `user-quota`/`total-quota` 与带宽监控；Cloudflare
  TURN 账户预算/告警。
- **测试**：准入/拒绝路径、配额边界、TTL、泄露扫描；不得在测试/日志中
  写入真实 token、TURN 凭据或终端内容。

## 14. 非目标

- 不实现付费/白名单/计费/套餐系统；这些由 TokiAPI 管理；tokimeki 只预留
  读取 JWT payload 开关。
- 不实现 JWT payload 配置开关的读取；只预留字段语义与读取路径。
- 不实现代码、协议变更、DO 迁移或生产部署；由后续任务拆分。
- 不承诺 relay 能计量 TURN 字节；不把 relay 描述为端到端加密。
- 不涉及具体定价、法律/ToS 文本或区域合规结论。

## 15. 待确认

1. JWT payload 中预留的配置开关字段名与语义（由 TokiAPI 定义；tokimeki
   只预留读取路径）。
2. 匿名 viewer 是否需要 Turnstile/更严格边缘限速。
3. free/namespace 配额数字的最终产品值（本文为 provisional）。
4. 绝对 session TTL 与空闲 TTL 的最终值。

## 16. 附录：用户类型与协议场景

> 说明：U1/U2/U7 是当前协议即可跑通的场景；U3 是静态 namespace token 落地
> 后的 OSS 目标场景；U4–U6 是 hosted JWT + 本文策略生效后的目标场景。
> JWT 是可选项；OSS 小团队主方案是静态 namespace token。
> 所有 TURN 相关场景都以“namespace 被授权 TURN（hosted：TokiAPI feature
> flag；OSS：部署配置）且 session 显式开启 TURN”为前提。为简洁，`signal`
> 示例省略 `from`；线上 schema 要求该字段，relay 转发时会用真实发送者
> clientId 覆盖。

### 16.1 类型总览

| 类型 | 层级 | 认证/凭据 | 可以做什么 | 不能做什么 |
|---|---|---|---|---|
| U0 匿名公网访客 | L0 | 无 | `GET /healthz`、使用公开 STUN | 任何会话/数据面 |
| U1 受邀 viewer | L1 | Session JWT / opaque session token | relay 数据面、P2P 直连/TURN、INPUT、resize、resync、ACK、TUN | 创建 session、管理 host、listener-only 能力 |
| U2 受邀 listener | L1 | Session JWT + `X-Tokimeki-Listener: 1` | 接收周期快照、控制面事件 | INPUT/resize/resync/ACK/signal/transport/P2P/TURN |
| U3 OSS namespace host | L2 | 静态 namespace token（或 root master） | 创建/托管 session、relay/P2P 直连、基础配额；TURN 由部署配置 | 跨 namespace、超配额、未授权 TURN、匿名 |
| U4 Hosted JWT host | L2/L3 | Host JWT（TokiAPI）+ Session JWT | 创建/托管 session；按 JWT payload feature flag 获得 TURN/更高配额（预留） | 付费/白名单管理、跨 namespace、超配额 |
| U5 TURN 会话受邀 viewer | L1 | Session JWT（无需账户） | 同 U1；若 session 开启 TURN，可用 p2p-turn | 自行开启 TURN、超 session 配额 |
| U6 TokiAPI Web 用户 | L1 | TokiAPI 代理注入 Session JWT（`web` + `attach`/`listen`） | 浏览器 xterm.js 完整/只读 viewer（v1.2 relay-only） | 接触 JWT、P2P/TURN、自行改 scope |
| U7 OSS 运维/root | L4 | `X-Tokimeki-Master` + opaque session token | 自托管 host、全局配置、break-glass | 向用户分发 master、匿名开放 TURN |

### 16.2 U1 受邀 viewer（当前可用）

Invite（v1）：`{"version":1,"relayUrl":"wss://...","session":"...","sessionToken":"...","window":{"cols":120,"rows":40}}`。

```text
viewer                              relay / DO                         host
  |-- WS upgrade: X-Tokimeki-Session -->|                                |
  |-- hello {role:"viewer",             |                                |
  |          session, clientId,         |                                |
  |          cols, rows, capabilities}  |                                |
  |<------------- welcome {hostOnline,  |                                |
  |               clients, iceServers,  |                                |
  |               iceProvider, TTL,     |                                |
  |               capabilities} --------|                                |
  |                                     |--- peer-joined (viewer-1) ---->|
  |-- signal {to:host, kind:"offer"} -->|------------ signal ------------>|
  |<------------ signal {kind:"answer"} |<----------- signal -------------|
  |-- transport {clientId, mode:        |                                |
  |   "p2p-direct", state:"ready"} ---->|------------ transport -------->|
  |-- INPUT (DataChannel) ------------->|   (P2P 后不再经 relay)          |
  |<------------ OUTPUT (DataChannel) --|                                |
  |                                     |                                |
  |  失败/超时：transport {mode:"relay", state:"failed"}                   |
  |-- INPUT (binary 0x01) ------------->|------------ INPUT ------------>|
  |<------------ OUTPUT (binary 0x02, seq) -------------------------------|
  |-- ack {seq:"42"} ------------------>|                                |
  |-- resize {cols,rows} -------------->| (250ms 节流) -> resize ------->|
  |-- resync {fromSeq:"42"} ----------->| (500ms 节流) -> resync ------->|
  |<------------ SNAPSHOT_TO (0x05) ----|                                |
```

拒绝路径：无 token → HTTP 401；session 不存在 → `error{code:"invalid_session"}`；
session 满 → `session_full`；长期不 ACK → `slow_consumer`（关闭码 4000）。
策略生效后：受 session/namespace 速率与日流量配额约束；session 未开启 TURN 时
`welcome.iceServers` 只有 STUN，viewer 不能强行申请 TURN。

### 16.3 U2 受邀 listener（当前可用）

```text
listener                          relay / DO                           host
  |-- WS upgrade: X-Tokimeki-Session + X-Tokimeki-Listener: 1 -->|        |
  |-- hello {role:"listener", capabilities:{                     |        |
  |     transports:{modes:["relay"]},                            |        |
  |     listener:{modes:["snapshot-only"]}}} ------------------->|        |
  |<------------- welcome {hostOnline, clients, iceServers} -----|        |
  |                                       |--- peer-joined (listener) --->|
  |<------------- SNAPSHOT_TO (0x05, seq) -----------------------|        |
  |<------------- SNAPSHOT_TO（周期，默认 1000ms）----------------|        |
  |-- INPUT / resize / ack / signal / transport / resync ------->|        |
  |<------------- error {code:"invalid_role"} -------------------|        |
```

- listener 不接收 `OUTPUT`，不参与 ACK/背压/pause/slow-consumer。
- listener 不接收 TURN 凭据（已实现）：`welcome` 只含 STUN
  （`iceProvider:"stun"`、`iceExpiresAt:null`），`ice-refresh` 返回 `invalid_role`。
- Ctrl-C 只退出本地 listener，不影响 host 或其他 viewer。

### 16.4 U3 OSS namespace host（静态 token，无 JWT）

```text
CLI host (OSS)                    Worker/DO
  |-- env: TOKIMEKI_NAMESPACE_TOKEN=<team-a token>
  |         TOKIMEKI_NAMESPACE=team-a
  |         TOKIMEKI_SESSION=team-a.laptop-work
  |-- WS upgrade: X-Tokimeki-Master: <namespace token>
  |               X-Tokimeki-Session: <session token> -->
  |-- hello {role:"host", session:"team-a.laptop-work", ...} -->
  |<-- welcome {hostOnline:true, iceProvider:"stun"|"coturn"} --
  |-- OUTPUT (0x02) / SNAPSHOT_TO (0x05) ---------------------->
  |<-- INPUT (0x01) / resize / resync / pause / resume ---------|
  |-- host-exited {exitCode:0} --------------------------------->
```

- token 命中后在 Worker 得到 namespace=team-a；session 必须以 `team-a.`
  开头，否则 401；不能创建/占用 `team-b.*`。
- TURN 仅在 `TOKIMEKI_TURN_NAMESPACES` 包含 team-a 且 session 显式开启时
  签发；否则只有 STUN。
- 配额来自 `TOKIMEKI_NAMESPACE_LIMITS`；root master 仍可跨 namespace
  break-glass。
- CLI 若只给 token 不给 `TOKIMEKI_NAMESPACE`，无法构造正确 session 前缀，
  应直接报配置错误。

### 16.5 U4 Hosted JWT host（TokiAPI）

```text
CLI host                         TokiAPI                      Worker/DO
  |-- POST /api/tokimeki/sessions {slug, turn:false|true} -->|
  |<-- {session:"u123.slug", sessionToken, expiresAt} --------|
  |-- WS upgrade: Authorization: Bearer <Host JWT>
  |               X-Tokimeki-Session: <Session JWT> ---------->
  |-- hello {role:"host", session:"u123.slug", ...} ---------->|
  |<-- welcome {hostOnline:true, iceProvider:"stun"|"coturn"} ->
  |-- OUTPUT / SNAPSHOT_TO ------------------------------------>
  |<-- INPUT / resize / resync / pause / resume ---------------|
```

- Host JWT 由 TokiAPI 签发；付费/白名单/features 由 TokiAPI 管理，tokimeki
  只读取 payload 开关（预留，未实现）。
- TURN 仅在 payload 有 TURN feature flag 且 session 显式开启时签发；
  `limits` claim（如果存在）只能收紧 relay 默认值。
- `welcome.iceServers` 未开启 TURN 时只有 STUN；viewer 同样只看 session
  结果，不要求 Host JWT。

### 16.6 U5 TURN 会话受邀 viewer

```text
viewer（无 TokiAPI 账户）
  |-- invite {session, sessionToken, turnEnabled:true} -->
  |-- WS upgrade: X-Tokimeki-Session -------------------->
  |-- hello {role:"viewer"} ----------------------------->
  |<-- welcome {iceServers:[STUN,TURN], iceProvider:"coturn"} -->
  |-- signal/transport p2p-direct → p2p-turn → relay ---->
  |-- INPUT / ack / resize / resync --------------------->
```

- 不要求 viewer 注册；TURN 使用权来自 session + namespace 的 TURN 授权
  （hosted：TokiAPI feature flag；OSS：部署配置）。
- session 未开启 TURN 或 namespace 未授权时，welcome 只有 STUN；viewer
  不能自行开启。
- viewer 的 `ice-refresh` 受角色与签发限速约束；listener 仍被拒绝。

### 16.7 U6 TokiAPI Web 用户（v1.2）

```text
browser ──HTTPS──> TokiAPI dashboard ──WS proxy──> relay
  │                    │ 注入 Session JWT (web + attach/listen)
  │                    │ 浏览器不接触 JWT
  │<── xterm.js ───────│
  │   INPUT/resize/ack │
  │   OUTPUT/SNAPSHOT  │
```

- relay 仍按 `attach`/`listen` 决定 viewer/listener；`web` scope 由 TokiAPI
  代理强制检查。
- v1.2 仅 relay：代理应从 `welcome` 中剥离 `iceServers`，避免浏览器拿到
  TURN 凭据；浏览器不做 P2P/TURN。
- passcode（如启用）由代理通过 `X-Tokimeki-Passcode` 转发；passcode 不进
  JWT/URL/日志。

### 16.8 U7 OSS 运维/root（当前可用）

```text
root host:      X-Tokimeki-Master: <TOKIMEKI_MASTER_TOKEN>
namespace host: X-Tokimeki-Master: <namespace token>
viewer:         X-Tokimeki-Session: <opaque session token>
```

- master 是 L4 break-glass，只给运维持有；不向团队分发。
- namespace token 是 OSS 小团队的 host 凭据，按 namespace 隔离。
- TURN 由运维 env 显式配置；默认 `stun`/`none`，禁止匿名开放 TURN。
- 无 TokiAPI/账户体系；配额默认保持 v1.1 行为，可按需启用。

### 16.9 自部署无 JWT 时的 host 身份（重要）

**结论：无 JWT 时，host 身份有两个来源：root master（全局）或
namespace token（namespace 作用域）。**

- **root master**：`TOKIMEKI_MASTER_TOKEN` 命中 → 可创建任意合法 session，
  用于运维/break-glass。它是全局 token，不是 per-user 身份。
- **namespace token**：`TOKIMEKI_NAMESPACE_TOKENS` 中的 token 命中 →
  得到该 namespace 的 host 能力；session 必须是 `<namespace>.<slug>`，
  Worker 与 DO 都校验前缀。这是 OSS 小团队的主方案。
  - token 唯一、≥32 字节随机；重复/非法 key/解析失败 → fail-closed；
  - 匹配用 SHA-256 后常量时间比较，不早退；条目数受限（建议 ≤64）；
  - 未配置该 env 时保持现有 master-only 行为；root master 始终可
    break-glass。
- relay 未设置 master 且未配置 namespace token 时，host 认证是**关闭**的：
  所有 host 尝试都 401，不会变成“允许所有人 host”（fail-closed）。
- 只有 session token、没有 master/namespace token 的 viewer **不能** host：
  Worker 根据 host 头分配角色；`hello.role:"host"` 与认证角色不一致会被拒绝。
- 只有 master/namespace token、不知道某会话 session token 的人，可以创建
  **新** session，但不能接管已有 session：DO 首次 host 时保存
  `sha256(sessionToken)`，后续 host 必须匹配。
- 同时知道 host token 和 session token 的人可以 host/接管该 session。
- CLI 的 `claude` / `pi` / `run` 接受 `TOKIMEKI_NAMESPACE_TOKEN` +
  `TOKIMEKI_NAMESPACE`（隐式 `<namespace>.<slug>` session）或
  `TOKIMEKI_MASTER_TOKEN`；两者同时配置时 namespace token 优先并告警。
  `TOKIMEKI_SESSION_TOKEN` 未提供时由 CLI 随机生成。
- 轮换 master 会让所有 host 同时失效；轮换 namespace token 只影响该
  namespace 的新连接。两者都没有单用户撤销。
- v1.2 未配置 `TOKIMEKI_JWT_JWKS_URL` 时就是此模型；配置 JWKS 后可用
  任意兼容 issuer 的 Host JWT，不一定是 TokiAPI。

**多 namespace 自部署的建议：**

1. 每个团队/项目一个 namespace token；master 只留运维 break-glass。
2. 需要 per-user host 身份时，启用 JWT/JWKS（自建 issuer 也可），不要把
   共享 namespace token 当用户 token 分发。
3. 不同信任域用不同 namespace，必要时用不同 relay 部署；前缀校验是硬边界，
   但仍建议网络/部署隔离。
4. master 和 namespace token 只放在 0600 env/secret 中，不进 argv、URL、
   日志或提交。

### 16.10 能力矩阵（按类型）

| 能力 | U0 | U1 | U2 | U3 | U4 | U5 | U6 | U7 |
|---|---|---|---|---|---|---|---|---|
| `/healthz` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| relay 数据面 | ❌ | ✅ | 仅快照 | ✅ | ✅ | ✅ | ✅ | ✅ |
| P2P 直连 | ❌ | ✅ | ❌ | ✅ | ✅ | ✅ | ❌（v1.2） | ✅ |
| TURN | ❌ | 会话开启时 | ❌ | 部署授权时 | JWT flag + 会话开启 | 会话开启时 | ❌（v1.2） | 运维开启 |
| listener 模式 | ❌ | ❌ | ✅ | 可被 listener 接入 | 同左 | 同左 | ✅（`web listen`） | ✅ |
| TUN | ❌ | ✅ | ❌ | ✅ | ✅ | ✅ | ❌（v1.2） | ✅ |
| 创建 session | ❌ | ❌ | ❌ | ✅（namespace token） | ✅（Host JWT） | ❌ | 由 TokiAPI | ✅（master） |
| 申请 TURN 凭据 | ❌ | 会话开启时 | ❌ | 部署授权时 | JWT flag | 会话开启时 | ❌ | 运维配置 |
