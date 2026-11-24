# 多 namespace 基线与 P2 E2E 密钥设计

> 状态：设计稿（2026-11-22），已交付；**P2 暂缓（postponed，2026-11-23）**。
> 本文档不描述已实现的 E2E 行为；P2 实现前以本文档与
> `11-18-v1-1-censorship-resistance-p0-p2` 的 P2 设计为准。
> 基线：v1.2（0.1.3/0.1.4，生产）。namespace 认证/路由在 `develop`
> （0.1.3）与 `jwt`/`release/0.1.4`（0.1.4，生产）均存在；Session JWT、
> passcode、web viewer config v2 只在 0.1.4 `jwt` 线。
> 任务：`.trellis/tasks/11-18-multi-namespace-design`（本文档，已完成）；
> P2 任务 `11-18-v1-1-censorship-resistance-p0-p2` 保持 planning 并暂缓，
> 未获用户重新启动前不得开始 wire/实现。

## 1. 摘要

**当前决策（2026-11-23）：P2 暂缓（postponed）。** 本文档作为设计输入保留；
P2 任务保持 planning，未获用户重新启动前不实现。暂缓原因：TokiAPI 当前没有
`S_s` 分发通道，hosted 的 host/viewer 也不共享同一 secret；relay-blind 需要
先完成跨仓 E2E 分发契约。

v1.2 已经把 namespace 做成**认证/路由/隔离前缀**：host 凭证派生 namespace，
session ID 使用 `<namespace>.<slug>`，relay 在 `session_meta` 记录
`namespace_id`。本文档不再重新设计这些已落地行为，只补齐 P2（relay 承载端到端
AEAD）需要的密钥与门禁：

1. per-session secret `S_s` 的来源、分发与 relay 可见性；
2. `namespaceId/sessionId/epoch/keyId` 的 KDF context/AAD；
3. 轮换、吊销、前向保密与 per-viewer 限制；
4. `KeyProvider`/`KeyContext` 接口与 P2 启动门禁。

**当前没有 E2E-over-relay**：relay 路径仍能看到终端字节；`TUNNEL`/
`TUNNEL_TO` 由 relay 返回 `not_implemented`。P2 未启动。

## 2. v1.2 已实现基线（不可回退的输入）

### 2.1 路由与准入

- `/ws/<session>`，session 为 `<namespace>.<slug>` 或 legacy/root 的无点号 ID。
- 每个连接必须带非空 `x-tokimeki-session`；缺失 401
  （`packages/relay/src/index.ts:378-382`）。
- host 凭证唯一载体 `x-tokimeki-token`，按值形态分派：master fallback →
  JWT 形态 → 静态 namespace token（`index.ts:106-252`）。
- namespace 只从已验证 host 凭证派生；转发前删除
  `x-tokimeki-token`/`x-tokimeki-master`/`x-tokimeki-listener`/
  `x-tokimeki-namespace`，再注入 `x-tokimeki-role` 与 host 的
  `x-tokimeki-namespace`（root/fallback 为 `*`）（`index.ts:408-435`）。
- `x-tokimeki-listener: 1` → listener；host 凭证优先，host 不会被降级。
- `Authorization: Bearer` 仅 JWT 模式作为 web/代理第二载体；CLI 不发送。
- 常量时间比较；host 凭证等于 session token 时拒绝。

### 2.2 session 命名空间

- CLI namespace 匹配 `^[a-z0-9][a-z0-9_-]{0,31}$`（1–32 字符）
  （`packages/cli/src/config.ts:47`）。
- namespace host 的 `TOKIMEKI_SESSION` 必须是 `<namespace>.<slug>`；省略时
  自动生成并加前缀（`config.ts:343-372`）。
- relay 的 `isNamespaceSessionId` 做同样的前缀/非空 slug 检查
  （`packages/relay/src/namespace-tokens.ts:140-143`）。
- DO key 是完整 session ID；`session_meta.namespace_id` 为增量列
  （`packages/relay/src/storage.ts:52-60`，迁移 `:138-157`）。
- `NULL` legacy 行仅 root/master 可用；namespace session 在 DO 内再次校验前缀
  （`packages/relay/src/session-do.ts:670-680`）。
- `welcome` 没有 namespace 字段；session ID 携带前缀。

### 2.3 viewer/listener 与 TUN

- viewer/listener 共享 per-session token（两条线均如此）。
- 0.1.4 `jwt` 线额外支持 Session JWT：Worker 验签
  `token_use=session`、`attach`/`listen` scope（Web 代理追加 `web`，
  relay 忽略），注入 `x-tokimeki-session-claim`/scope，DO 复核后跳过
  hash；Web TTL 300s，CLI 最长 24h 或 invite 到期。可选 passcode
  （`X-Tokimeki-Passcode`）。`develop`（0.1.3）没有这两项。
- listener 需 `X-Tokimeki-Listener: 1`。
- 没有 per-viewer 身份/密钥/吊销。
- TUN v1 仅 P2P：`HKDF-Extract(salt=UTF-8(sessionId),
  ikm=sessionToken|sharedSecret)`，label
  `tokimeki-tunnel-v1/host-to-viewer`、`.../viewer-to-host`
  （`packages/cli/src/transport/tunnel/crypto.ts:87-115`；
  `packages/protocol/src/constants.ts:247-253`）。
- `session-token` 模式 relay 可推导 TUN key；只有 `shared-secret` 可能声明
  relay-blind（且仅 P2P TUN）。
- relay 对 `TUNNEL`/`TUNNEL_TO` 返回 `not_implemented`
  （`packages/relay/src/session-do.ts:1432-1435`）。

### 2.4 隔离/配额

- per-session TTL/字节/消息速率已实现。
- TURN 凭据、namespace 配额、字节统计仍为全局或 per-session；没有
  per-namespace 聚合。
- namespace 目前是标识/隔离前缀，**不是密钥根**；没有 namespace root `K_t`。

### 2.5 TokiAPI 跨仓契约现状（本地 `develop`，2026-11-22 对齐）

来源：`D:/Workspace/cf-ai-gateway` 本地 `develop`（TokiAPI 集成线）。

- Host JWT：`signHostJwt` ES256；claims
  `iss/aud/sub/namespace/token_use=host/scope=host/iat/nbf/exp/jti`；
  登录 host 默认 30 天，匿名 host 默认 24h
  （`TOKIMEKI_ANON_HOST_TTL_SECONDS`）。
- Session JWT：`signSessionJwt` 额外含 `session=<namespace>.<slug>`、
  `token_use=session`；`scope` 是空格分隔字符串（`attach`/`listen`，
  Web 代理追加 `web`，relay 忽略）。Web TTL 300s；CLI 最长 24h 且不超过
  invite 到期。
- Invite：16 字符 code（30 字符集，约 78 bits），DB 只存 SHA-256；
  `POST /api/tokimeki/invites/:id/token` 与 `POST /api/tokimeki/attach/cli`
  返回 `{token, session, mode, allowWeb, passcodeRequired, expiresAt}`；
  Web 走一次性 60s attach ticket + HttpOnly cookie。invite 行字段为
  code_hash/namespace/session/mode/allow_web/passcode_required/expires_at，
  **没有 E2E secret/keyId/epoch 字段**。
- 匿名 host：服务端生成 4 位 namespace + 双词 slug，返回 Host JWT +
  invite URL；登录用户 `namespace_short` 为 5 位。relay/CLI 接受 1–32 位。
- Session access code 是 6–8 位数字（`TOKIMEKI_SESSION_TOKEN`）；passcode
  是 6 位数字（`TOKIMEKI_PASSCODE`），两者不同。
- Web WS 代理：校验 ticket/Origin，注入 Session JWT 与 listener header，
  删除客户端 `x-tokimeki-*`，从 `welcome`/`ice` 帧剥离 TURN 凭据；浏览器
  不接触 Session JWT。
- **E2E 缺口**：TokiAPI 目前没有 E2E/`S_s` 的设计、invite 字段或 API。
  hosted 流程中 host 持有 6–8 位 session token，viewer 持有 Session JWT，
  两者不共享同一 secret；invite code 是 host/viewer 可共享的候选，但当前
  host 命令不携带它。A/B 需要 TokiAPI 新增契约；C 只在 host/viewer 共享
  opaque session token 的 OSS/manual 流程可用，且 relay 可见，不能声明
  relay-blind。

## 3. 范围与非目标

本设计只覆盖 P2 所需的密钥/门禁：

- `S_s` 来源与分发、relay-blind 判定；
- KDF context/AAD、TUN/E2E label 分离；
- 轮换/吊销/FS、per-viewer 限制；
- `KeyProvider`/`KeyContext` 与 P2 门禁。

不做：多 namespace 代码/迁移/控制面/计费、per-viewer RBAC 实现、P2 E2E
实现、TUN wire 升级、relay 路由改动、per-namespace TURN/配额实现、生产部署。

## 4. E2E 密钥层级与 `S_s` 来源

### 4.1 层级

```text
（可选，未来）NamespaceRootKey K_t        // 控制面/KMS；本设计不实现
  └─ SessionSecret S_s                    // per session；P2 的 E2E 根
       └─ E2E record keys                 // HKDF(namespaceId/sessionId/epoch/keyId/purpose)
            ├─ host→viewers
            ├─ viewer→host
            └─ key confirmation
```

- `S_s` 是 P2 的直接输入；`K_t` 只在 hosted 控制面可能存在，relay 不持有。
- 当前 OSS 没有 `K_t`；P2 不得依赖它。
- TUN v1 继续使用自己的派生；E2E 使用独立 `purpose`/`keyId`，不得共用 TUN
  record key。

### 4.2 `S_s` 来源矩阵

> 本节 A/B/C 指 `S_s` 来源，避免与 P2 wire 的 Option A/B 混淆；下文涉及
> wire 时会写“P2 wire Option”。

| 方案 | 做法 | relay 可见 | relay-blind | TokiAPI 现状 | 主要风险 |
|---|---|---|---|---|---|
| A. host 随机生成 | host 生成 `S_s`，经 invite/带外给 viewer | 否（invite 不经 relay） | 可声明 relay-blind | **需新增** invite E2E 字段/API 或 host 带外分发；当前不可用 | invite 通道/控制面可见；转发泄漏 |
| B. 控制面派生 | TokiAPI 用 `K_t` 派生，只发 host/viewer | 否 | 对 relay 可声明；对控制面不 blind | **需新增**控制面派生/分发 API；当前不可用 | TokiAPI 可见；需要新 API |
| C. session token 派生 | `S_s = KDF(sessionToken, context)` | 是（relay 验证 session token/JWT） | **否** | 仅 OSS/manual（host/viewer 共享 opaque session token）；hosted Session JWT 流程无共享 secret | relay 可推导；无 FS；泄漏即解密 |

**推荐（待用户确认，受 TokiAPI 现状约束）**：

- 当前 TokiAPI hosted 链路没有 `S_s` 分发通道，且 host/viewer 不共享同一
  secret（host: 6–8 位 session token；viewer: Session JWT）。因此 C 也不能
  直接在 hosted 流程使用；只有 OSS/manual 共享 opaque session token 的
  流程可用 C，且明确“不是 relay-blind”，只作为 relay 传输加固/防重放。
- 若要 P2 覆盖 hosted 或声明 relay-blind，必须先立 TokiAPI 任务定义共享
  secret 分发：A（host 随机/invite code，invite/CLI 响应携带）或 B
  （控制面派生）。该任务需定义 invite 新字段、attach/cli 响应、日志/清理、
  Web 代理是否可见。
- 不得把 A/B 写成“已可用”，也不得在 C 模式下声明 relay-blind。

约束：

- `S_s` 必须 per-session；不得回退到全局静态 secret。
- `S_s` 不进入 URL；进入 invite JSON 时必须走受保护通道并标注可见方。
- “relay-blind”只描述 relay；不得对控制面作同样声明。

## 5. KDF context 与 AAD

### 5.1 `KeyContext`

```ts
interface KeyContext {
  namespaceId: string;
  sessionId: string; // 完整 wire session id（含 `<namespace>.` 前缀）
  epoch: number;     // u32
  keyId: number;     // u32
}
```

`namespaceId` 的稳定规则（推荐，待验收）：

```text
namespaceId = deriveNamespaceFromSessionId(sessionId) ?? ""
```

- namespace host 的 session 必为 `<namespace>.<slug>`，因此等于其凭证
  namespace；
- root host 若使用点号 session，则取该前缀；无点号 legacy session 用空串；
- TokiAPI 登录用户 `namespace_short` 为 5 位、匿名 host 为 4 位；relay/CLI
  接受 1–32 位，规则兼容；
- `*` 仅是 relay 内部 fallback 哨兵，不进入 E2E 公共契约。

该规则使 host/viewer 仅凭 session ID 就能得到一致的 context，不依赖
relay 的 `x-tokimeki-namespace` 内部头。

### 5.2 编码与 labels

建议长度前缀编码，避免拼接歧义：

```text
ctx = u16(len(namespaceId)) || namespaceId
   || u16(len(sessionId))   || sessionId
   || u32(epoch) || u32(keyId)

info = "tokimeki-e2e-v1/" || purpose
```

- `purpose`：`host-to-viewers`、`viewer-to-host`、`confirm`；
- `keyId`/`epoch` 不是 secret，可出现在 capability/AAD；
- TUN 保留 `tokimeki-tunnel-v1/*`，不得与 E2E label 混用；
- AAD 的完整字段（方向、frameType、outerSeq、targetId 等）由 P2 任务定义；
  本文档保证 `namespaceId/sessionId/epoch/keyId` 在其中。

## 6. 分发、invite 与 relay-blind

- `S_s` 分发路径必须在文档中写明“谁可见”：host、viewer、relay、TokiAPI、
  invite 链接/二维码/日志、Web WS 代理。
- invite v2 现有字段（relayUrl/session/sessionToken/window 等）不变；如增加
  E2E 字段，必须可选且版本化；分享 URL 不得包含 `S_s`。
- TokiAPI 现状：invite 只有 16 字符 code；attach/cli 响应只有 Session JWT/
  session/mode/allowWeb/passcodeRequired/expiresAt，没有 `S_s` 字段或 API。
  A/B 需要 TokiAPI 新增列/端点/响应字段；C 仅在 OSS/manual 共享 opaque
  session token 时可用，hosted Session JWT 流程没有共享 secret。
- 如果浏览器要参与 E2E，TokiAPI WS 代理会看到注入的 `S_s`（或需要在代理侧
  派生/注入），因此“对 relay blind”不等于“对 TokiAPI/代理 blind”；P2 v1
  可先只支持 CLI，Web 后补。
- `TOKIMEKI_CONFIG`/env 承载 `S_s` 时遵守 0600、不写 argv/日志；hosted PTY
  环境继续 scrub。
- relay 分发 `S_s` → 不能声明 relay-blind；host 生成/带外或控制面直接下发 →
  可以对 relay 声明 relay-blind，但不得对控制面作同样声明。
- P2 capability 携带 `keyId/epoch/keyMode`（及 suite），不携带 `S_s`。
- 旧 client 忽略未知 capability 并按 P2 policy 回退；`require` 缺
  capability/密钥时 fail closed。

## 7. 轮换、吊销、epoch/keyId 与 FS

- `epoch`：host 每次 PTY 运行/会话重建递增；viewer 看到新 epoch 时重置
  replay window/reducer，等待新快照；旧 epoch 帧丢弃。
- `keyId`：每次 `S_s` 轮换递增；旧 key 保留一个短 in-flight 窗口（帧数/时长
  由 P2 定），超出即丢弃。
- 吊销：session 终止/TTL、namespace token 轮换、host 退出；E2E key 无法远程
  擦除已连接 peer 的内存，文档不得承诺。
- 静态 `S_s` 无前向保密；是否引入 ephemeral X25519 + `S_s` 认证由 P2 决定。
  若不做，P2 文档必须写“无 FS”，不得过度声明。
- relay token 吊销与 E2E key 吊销独立；session token 轮换不自动重加密已有
  连接，需要 P2 的 rekey/重连语义。

## 8. per-viewer 限制

- 共享 `S_s` 只能证明“某 session participant”，不能区分 viewer；恶意 viewer
  可伪造其他 viewer 的输入语义（现有模型已共享 PTY 控制）。
- TokiAPI Session JWT 的 `sub` 是 invite 创建者或 `anon`，不是 per-viewer
  身份；同一 invite 的 CLI viewer 共享同一 `sub`，不能作为 viewer 标识。
- P2 v1 若不实现 per-viewer credential/key，必须在 P2 文档记录：
  - 无法按 viewer 审计/吊销；
  - viewer→host 的真实性只到 session 级；
  - 后续扩展需要 per-viewer `S_v`/公钥封装，可能改变 wire。
- 本文档只给扩展路径，不实现。

## 9. `KeyProvider`/`KeyContext` 接口草案

```ts
interface E2EKeyMaterial {
  hostToViewers: Uint8Array;
  viewerToHost: Uint8Array;
  confirm: Uint8Array;
}

interface KeyProvider {
  /** P2 AAD 四字段的唯一来源；不得直接读 env。 */
  deriveE2EKeys(ctx: KeyContext): E2EKeyMaterial | Promise<E2EKeyMaterial>;
}

interface SessionSecretSource {
  /** 返回 null 表示该会话未启用 E2E；不得回退到全局静态 secret。 */
  getSessionSecret(
    sessionId: string,
    namespaceId: string,
  ): Uint8Array | null | Promise<Uint8Array | null>;
}
```

- `deriveE2EKeys` 必须只用 `KeyContext` + `S_s`，不得读
  `TOKIMEKI_TUNNEL_SECRET`；
- `S_s` 来源（A/B/C）由 `SessionSecretSource` 注入，便于 OSS/hosted 切换；
- TUN v1 不接入该 Provider；未来 TUN v2 若需要 namespace/epoch，另立任务；
- 接口草案需在 P2 PRD/design 中引用，并作为 P2 实现的验收项。
- key confirmation transcript 必须包含
  `namespaceId/keyId/epoch/capabilities`。

## 10. 与 TUN v1、relay 流控、invite 的兼容

- **TUN v1**：wire/密钥不变；E2E 独立 label/keyId；不得要求 TUN 协议升级。
- **relay 流控**：P2 Option A（加密 payload、外层帧/ACK/背压不变）不需要
  relay 改动；Option B（`TUNNEL_TO`）会改变 relay 路由/流控语义，由 P2
  任务决定。本设计两种都能承载。
- **invite/config**：v2 字段保持不变；E2E 字段可选、版本化。
- **welcome**：不新增 namespace 字段；E2E capability 由 `hello`/`welcome`
  capabilities 协商，具体字段由 P2 定义。
- **单 namespace/root**：现有 `/ws/<session>`、`session_meta`、`welcome`
  行为不变。

## 11. 隔离/配额缺口（记录，不阻塞 P2）

- per-namespace TURN 凭据/配额、session/字节/存储配额未实现；当前只有
  per-session 限制。
- namespace 仅作为路由/准入前缀，不提供资源隔离保证。
- 若 P2 方案依赖 per-namespace 配额，P2 必须显式列出并另开任务，不能默认为
  已有能力。

## 12. 威胁模型增量

| 威胁 | 本设计对应 | 残余风险 |
|---|---|---|
| relay 读终端内容 | P2 E2E；A/B 来源可使 relay 无法解密 | C 来源/relay 分发 `S_s` 不成立 |
| relay 推导密钥 | `S_s` 不经 relay；KDF context 含 namespace/session/epoch/keyId | 方案 C 或 invite 经 relay 时失效 |
| 跨 namespace 解密 | AAD 含 namespaceId；`S_s` per-session | relay 配置错误/同 secret 复用 |
| 重放/乱序 | epoch/keyId + P2 replay window/AAD | 旧 key in-flight 窗口 |
| viewer 伪造 | per-viewer key 才能解决 | P2 v1 若不实现则残留 |
| `S_s` 泄漏 | 轮换/短 TTL；可选 FS | 静态 secret 无 FS |
| token/secret 日志泄漏 | 不进 URL/argv/日志；redaction | 终端/进程被攻破 |

## 13. 迁移 / rollout / rollback

1. 保持 v1.2 namespace 行为不变；E2E 默认 off。
2. 新增 `TOKIMEKI_E2E=off|auto|require`（仅设计）：off 不协商；auto 双方
   capability 匹配才启用；require 缺 capability/密钥 fail closed。
3. P2 wire Option A 不需要 relay 迁移；wire Option B 需要 P2 单独设计
   relay/DO 变更。
4. 回滚：关闭 E2E capability/开关回到 relay 明文；已建立的 E2E 连接按 P2
   的重连/降级语义处理；不改 `session_meta`/`welcome`/路由。
5. 不引入破坏性 env/header 变更；invite v2 保持向后兼容。

## 14. 开放决策（需用户确认）

> 2026-11-23 用户决定 **P2 暂缓**；以下决策保留，重新启动 P2 时再确认。

1. **P2 是否先只覆盖 OSS/manual 的 C**：当前 TokiAPI hosted 流程没有
   `S_s` 分发，host/viewer 也不共享同一 secret；C 只在 OSS/manual 共享
   opaque token 时可用，且不能声明 relay-blind。
2. **是否为 hosted/relay-blind 先立 TokiAPI E2E 分发任务**：A（host 随机/
   invite code，invite/CLI 响应携带）或 B（控制面派生）；需要新增 invite
   字段/API、日志/清理规则，并明确 Web 代理可见性。
3. **legacy/root `namespaceId`**：是否采用
   `deriveNamespaceFromSessionId(sessionId) ?? ""`（本设计推荐）。
4. **per-viewer key**：P2 v1 是否实现 per-viewer credential/key；建议先不做
   并记录限制。
5. **FS**：P2 v1 是否引入 ephemeral X25519；建议先不做并记录“无 FS”。
6. **`S_s` 分发通道**：进入 invite/CLI 响应、控制面 API 还是带外；明确
   relay/TokiAPI/浏览器代理可见性。
7. **P2 Option A/B**：由 P2 任务选择；本设计两者都支持。
8. **per-namespace TURN/配额**：另立任务，不与 P2 耦合。

## 15. P2 启动门禁

**P2 当前暂缓（2026-11-23）**；以下条件在用户重新启动 P2 时仍需满足：

- 本文档经用户验收；
- 开放决策 1–6 已定稿（尤其：是否接受 C 的非 relay-blind，或 TokiAPI E2E
  分发任务已立项/契约冻结）；
- 若选择 relay-blind：TokiAPI 侧的 `S_s` 分发契约已冻结并有实现/测试计划；
- P2 PRD/design 引用本文档，AAD/KeyProvider 四字段一致；
- P2 任务仍为 `planning`，且用户显式同意解除 blocked-by；
- 不改变 relay 信任模型声明：未实现 E2E 前，relay 仍可看到终端字节。

## 16. 参考

- `packages/relay/src/index.ts`（host 认证分派、header 清洗、namespace 注入）
- `packages/relay/src/session-do.ts`（role、session_meta、TUNNEL
  `not_implemented`；Session JWT/passcode 复核仅在 `jwt` 线）
- `packages/relay/src/storage.ts`（`namespace_id` 列与迁移）
- `packages/relay/src/namespace-tokens.ts`（namespace 前缀检查）
- `packages/relay/src/jwt-auth.ts`（Host JWT 验签；Session JWT 验签仅在
  `jwt` 线）
- `packages/cli/src/config.ts`（`TOKIMEKI_NAMESPACE`/session 前缀）
- `packages/cli/src/transport/tunnel/crypto.ts`（TUN v1 KDF）
- `packages/protocol/src/constants.ts`（TUN label）
- `docs/protocol.md`、`docs/deployment.md`、`docs/relay-exposure-policy.md`、
  `docs/tunnel-reliability.md`、`CLAUDE.md`、`SECURITY.md`
- TokiAPI（`D:/Workspace/cf-ai-gateway`，本地 `develop`）：
  `src/routes/tokimeki/lib/jwt.ts`（Host/Session JWT）、
  `src/routes/tokimeki/lib/invites.ts`（invite/ticket）、
  `src/routes/tokimeki/public/attach-cli.ts`、
  `src/routes/tokimeki/public/ws.ts`（Web 代理）、
  `src/routes/tokimeki/procedures/anon-host.ts`、
  `app/modules/tokimeki/lib/host-command.ts`、`src/db/schema.ts`
  （`tokimeki_invites`）
