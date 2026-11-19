# Tokimeki Wire Protocol v1

> 状态：v1 实现完成（Phase 6）；v1.1 F0 已在 v1 基线上实现（`FRAGMENT 0x08`、
> P2P 直发快照、ICE 到期自动刷新、provider 重试一次），v1.1 F2 已实现只读
> `listener`（snapshot-only）角色；v1.1 F1 已实现 P2P-only TUN profile
> （AES-256-GCM + selective-repeat ARQ），v1.1 F1.1 已实现 XOR FEC
> （单丢包 parity 恢复）；单测、relay 测试与本地 live e2e（session-token 与
> shared-secret）通过。
> 生产部署、跨 NAT/TURN 与真实 TUI 的验收记录见 `docs/deployment.md` §7；wire
> `v` 仍为 1，F0/F1/F2 新增项是 capability-gated 可选扩展。
> 规范性实现：`packages/protocol`；语言无关向量：`packages/protocol/test/vectors/`。
> 本文描述的是线上格式，不是 Node/TypeScript 实现细节。v2 Go/Rust 实现必须能仅凭本文与 golden vectors 互通。

## 1. 范围与版本

- 当前协议版本：`PROTOCOL_VERSION = 1`，JSON 控制消息使用顶层 `"v": 1`。
- v1 提供：JSON 控制消息、二进制终端帧、WebSocket 中继与 WebRTC DataChannel 共用的字节格式、会话握手、ICE 配置下发、输出序号与快照恢复、错误/关闭码。
- v1.1 F0 可选扩展：`FRAGMENT`（0x08）、`transports.fragmentation` capability、P2P 直发 `SNAPSHOT`。这些只在双方声明/协商后使用；未协商时保持 v1 行为。
- v1.1 F2 可选扩展：`listener` 角色（只读、snapshot-only）与 `listener.modes: ["snapshot-only"]`
  capability。旧于 v1.1 的 relay 收到 `listener` hello 仍返回 `not_implemented`；v1.1
  客户端必须明确报错退出，不得静默降级为 viewer。
- v1.1 F1 可选扩展：`tunnel` capability 与 `TUNNEL 0x06` 内层 AEAD/ARQ 记录。F1
  首版只在 P2P unreliable/unordered DataChannel 上运行；relay 数据路径保持 v1 帧
  与流控，收到 `TUNNEL`/`TUNNEL_TO` 仍返回 `not_implemented`。未协商时保持 v1 行为。
- v1 只定义、不实现：`TUNNEL_TO` 应用层隧道定向投递、`tunnel`/`peerRelay`
  capabilities 的 relay 行为、Agent 运行时。收到 `TUNNEL_TO` 时返回 `not_implemented`。
- 破坏性变更必须提升 `v`。向后兼容的新增字段可以保留 `v: 1`；旧实现必须忽略未知字段。
- 线上格式只使用：字节、UTF-8、大端 `u64`、JSON。不得出现 Node `Buffer`、TypeScript 特有类型或平台相关序列化。

## 2. 传输与消息边界

| 通道 | 内容 |
|---|---|
| WebSocket 文本帧 | JSON 控制消息，`{ "v": 1, "type": "...", ... }` |
| WebSocket 二进制帧 | 终端数据，首字节为帧类型 |
| WebRTC DataChannel | 与 WebSocket 二进制帧完全相同的字节格式 |
| WebRTC 信令 | 始终走 WebSocket `signal` 控制消息，不解析 SDP/ICE |

规则：

- 所有 JSON 文本必须是 UTF-8 合法 JSON 对象；数组、标量、空串、非法 JSON 一律拒绝。
- 二进制帧总长度（含首字节）上限 `MAX_FRAME_BYTES = 1_048_576`（1 MiB），超限返回 `frame_too_large`。
- 原始控制消息 UTF-8 上限 `MAX_CONTROL_MESSAGE_BYTES = 131_072`（128 KiB）；`signal.payload` 序列化后上限 `MAX_SIGNAL_PAYLOAD_BYTES = 65_536`（64 KiB）。超限返回 `invalid_message`；深层/递归 JSON 必须被转换为 `invalid_message`，不得把 `RangeError` 抛给调用方。
- WebRTC DataChannel 单条消息上限 `MAX_DATACHANNEL_MESSAGE_BYTES = 16384`。host 仍把 `OUTPUT` 的 payload 切分到 `16384 - 16` 字节以内。
- v1.1 F0 在双方声明 `transports.fragmentation` 后，允许用 `FRAGMENT`（0x08）把 1..`MAX_FRAME_BYTES` 的完整帧拆成多条 DataChannel 消息；单条 fragment 消息（含 13 字节 header）≤16384。未协商时不得发送 fragment 或 P2P `SNAPSHOT`。
- P2P 切换与 P2P 活动期间的 resync 快照优先通过 DataChannel `SNAPSHOT` 发送；peer 不支持分片、发送失败或 capability 未知时回退 relay `SNAPSHOT_TO`。relay 路径仍拒绝裸 `SNAPSHOT`。
- 二进制帧编码是确定性的；不压缩、不填充、不做字节序转换以外的处理。
- 中继在 Worker/DO 中收到的二进制消息总是 `ArrayBuffer`；实现必须按 `Uint8Array` 视图处理并尊重 `byteOffset`。

## 3. 二进制帧

| 帧类型 | 值 | 方向 | 布局 |
|---|---:|---|---|
| `INPUT` | `0x01` | viewer/attach → host | `[0x01][payload...]` |
| `OUTPUT` | `0x02` | host → viewer | `[0x02][seq:u64BE][payload...]` |
| `SNAPSHOT` | `0x03` | host → viewer（P2P 直发） | `[0x03][seq:u64BE][ANSI snapshot...]` |
| `RESYNC_REQ` | `0x04` | viewer → host | `[0x04]` |
| `SNAPSHOT_TO` | `0x05` | host → relay → 指定 viewer 或 listener | `[0x05][targetLen:u8][targetId UTF-8][seq:u64BE][ANSI snapshot...]` |
| `TUNNEL` | `0x06` | v1.1 F1 P2P host↔viewer（relay 不转发） | `[0x06][TUN record...]` |
| `TUNNEL_TO` | `0x07` | 预留 v1.1 | `[0x07][targetLen:u8][targetId UTF-8][opaque tunnel record...]` |
| `FRAGMENT` | `0x08` | P2P 双向（F0 仅 host → viewer） | `[0x08][messageId:u32BE][fragIndex:u16BE][fragCount:u16BE][totalBytes:u32BE][chunk...]` |

### 3.1 字段规则

- `seq`：每会话终端输出序号，`u64BE`，v1 从 `0` 开始单调递增。JSON 中对应字段使用十进制字符串（见 §4.3）。
- `payload`：原始字节，允许为空。`INPUT`/`OUTPUT`/`SNAPSHOT` 的 payload 是终端原始字节流，不是按行文本。
- `targetLen`：`targetId` 的 UTF-8 字节数，`u8`，v1 要求 `1..64`。`0` 或 `65+` 返回 `invalid_target_id`。
- `targetId`：UTF-8 字符串，必须是合法 Unicode/UTF-8。v1 的目标是客户端 ID，形状见 §5 的 ID 正则，因此总是 ASCII 且 ≤64 字节。
- `RESYNC_REQ` 必须恰好 1 字节；带任何 payload 都是 `invalid_frame`。
- `SNAPSHOT` 仅用于 P2P DataChannel 直发；v1.1 F0 在 `transports.fragmentation` 协商成功后用它承载切换/resync 快照。relay 路径仍拒绝裸 `SNAPSHOT`。
- `SNAPSHOT_TO` 的 target 可以是 relay viewer，也可以是只读 listener。viewer 的快照进入 ACK/背压路径；listener 的快照不产生 ACK、不改变 `unackedBytes`/`droppedBytes`，只会被下一次周期快照覆盖。
- `FRAGMENT` header 固定 13 字节：`messageId` 为非 0 u32；`fragIndex` 从 0 开始；`fragCount` 为 1..65 且必须等于 `ceil(totalBytes / 16371)`；`totalBytes` 是原始完整帧长度（包含原帧 type byte），范围 1..1 MiB；除最后一片外每片 payload 恰好 16371 字节，最后一片为余数。重组后的帧不得仍是 `FRAGMENT`（禁止嵌套）。
- `FRAGMENT` 只允许在已协商分片的 P2P DataChannel 上发送；relay 收到时返回 `invalid_frame`，不得转发。
- `TUNNEL`/`TUNNEL_TO` 在 v1 必须能被识别和路由，但不得执行任何隧道行为；收到时返回 `error{code:"not_implemented"}`，不得静默丢弃或转发。v1.1 F1 的 `TUNNEL` 只在已协商 tunnel capability 的 P2P DataChannel 上承载内层记录（见 §7.4）；relay 路径仍返回 `not_implemented`。
- `0x09..0xFF` 在 v1 未定义。实现返回 `unknown_frame_type`；relay 可映射为 `error{code:"invalid_frame"}` 并按策略关闭连接。

### 3.2 边界行为

| 情况 | 结果 |
|---|---|
| 空 buffer | `frame_truncated` |
| `OUTPUT`/`SNAPSHOT` 不足 9 字节 | `frame_truncated` |
| `SNAPSHOT_TO` 缺 target 长度、target 或 seq | `frame_truncated` |
| `targetLen = 0` 或 `> 64` | `invalid_target_id` |
| target 不是合法 UTF-8 | `invalid_target_id` |
| target 声明长度超出实际 buffer | `frame_truncated` |
| 帧总长 > 1 MiB | `frame_too_large` |
| 未知类型字节 | `unknown_frame_type` |
| 编码时 `seq` 为负、非整数、超过 `Number.MAX_SAFE_INTEGER` | `invalid_seq` |
| 解码时 `seq` 超过 `Number.MAX_SAFE_INTEGER` | `invalid_seq` |
| `RESYNC_REQ` 带 payload | `invalid_frame` |

v1 的 seq 互通范围是 `0..9007199254740991`（`2^53-1`）。线上字段仍是完整 `u64BE` 以便未来扩展，但 v1 TS 实现拒绝无法精确表示的序号，而不是静默丢失精度。跨语言实现若生成超过该范围的值，v1 客户端会以 `invalid_seq` 拒绝。

## 4. JSON 控制消息

### 4.1 Envelope

```json
{ "v": 1, "type": "hello", "role": "viewer", "...": "..." }
```

- 已知 v1 消息的 `v` 必须是数字 `1`。预留 `agent.*` envelope 允许省略 `v`（兼容设计 §10.3 的 envelope），但若存在必须为 `1`。
- `type` 必须是 §4.2 的已知类型，或以 `agent.` 开头的预留类型。
- 所有 schema 都是 loose object：未知字段必须被忽略，不得导致连接失败；TypeScript 编解码器会保留未知字段。
- 未知 capability（名称、键、值）必须忽略；不得因 capability 不识别而拒绝连接。
- 已知字段的类型错误、缺少必填字段、非法枚举值返回 `invalid_message`。
- `v` 或 `hello`/`agent.*` 的 `protocolVersion` 不匹配返回 `unsupported_version`，relay 应回复 `error{code:"unsupported_version"}` 后关闭。

### 4.2 消息表

方向中的“client”指任意已认证连接；“DO”指 Session Durable Object/relay。

| 消息 | 方向 | 必填字段 | 可选/默认字段 |
|---|---|---|---|
| `hello` | client → DO | `role`, `session`, `clientId` | `protocolVersion`（默认 1）、`client`、`capabilities`（默认 `{}`）、`cols`, `rows` |
| `welcome` | DO → client | `session`, `hostOnline`, `iceProvider`, `sessionTtlSeconds` | `protocolVersion`（默认 1）、`clients`（默认 `[]`）、`iceServers`（默认 `[]`）、`iceExpiresAt`、`transportPolicy`（默认 `all`）、`capabilities` |
| `ice-refresh` | host/viewer → DO | 无 | `provider` |
| `ice` | DO → client | `iceServers`, `iceProvider` | `iceExpiresAt` |
| `peer-joined` | DO → host | `clientId` | `role`（v1.1；缺省视为 viewer）、`capabilities`（默认 `{}`） |
| `peer-left` | DO → host | `clientId` | — |
| `signal` | host ↔ viewer（经 DO） | `to`, `from`, `kind`, `payload` | — |
| `transport` | client → host/DO | `clientId`, `mode`, `state` | `reason`, `via`（预留） |
| `resize` | viewer → host（经 DO） | `clientId`, `cols`, `rows` | — |
| `resync` | viewer → host（经 DO） | 无 | `fromSeq`（十进制 u64 字符串）、`clientId`（relay 填充） |
| `ack` | viewer → DO/host | `seq`（十进制 u64 字符串） | — |
| `pause` | DO → host | `clientId` | — |
| `resume` | DO → host | `clientId` | — |
| `host` | DO → viewer | `online` | — |
| `presence` | DO → all | 无 | `clients`（默认 `[]`） |
| `ping` | 双向 | 无 | `ts`（epoch ms） |
| `pong` | 双向 | 无 | `ts`（epoch ms） |
| `error` | DO → client | `code`, `message` | `requestId`, `retryable`, `details`, `exitCode`, `signal` |
| `host-exited` | host → DO → clients（含 listener） | 无 | `exitCode`, `signal` |

字段细节：

- `hello.role`：`host`、`viewer`、`observer`、`agent`、`listener`。v1.1 relay 激活
  `listener`（只读、snapshot-only）；更早的 v1 relay 对 `listener` 返回
  `not_implemented`，不授予任何终端路由。`listener` 的 `cols`/`rows` 不参与 PTY 尺寸协商。
- `peer-joined.role`：v1.1 relay 填 `host`/`viewer`/`observer`/`agent`/`listener`；
  pre-v1.1 relay 不带该字段，host 必须按 viewer 处理（向后兼容）。
- `hello.client`：可选、User-Agent 式客户端描述：`{ name, version, kind?, platform?, runtime? }`；`name`/`version` 1..64 字符，其余为可选短字符串。不得包含 token、TURN 凭据或终端内容。未知字段必须保留/忽略。
- `hello.cols` / `hello.rows` / `resize.cols` / `resize.rows`：整数，范围 `1..10000`，且 `cols * rows <= 4_000_000`。
- `capabilities`：见 §4.4。
- `welcome.iceProvider`：`coturn`、`static`、`cloudflare`、`stun`。
- `welcome.transportPolicy`：`all` 或 `relay`，对应 `TOKIMEKI_ICE_TRANSPORT_POLICY`。
- `signal.kind`：`offer`、`answer`、`ice`。`payload` 是任意 JSON（SDP/ICE 候选），relay 不解析、不修改。
- `transport.mode`：`p2p-direct`、`p2p-turn`、`relay`。
- `transport.state`：`selecting`、`ready`、`failed`。
- `transport.via`：v1.1 预留（`host`、`peer:<id>`、`relay`）；v1 可忽略。
- `error.code`：见 §8。
- `error.message`：1..2048 字符，不得包含 token、TURN credential 或终端内容。
- `error.details`：任意 JSON，仅用于诊断。
- `host-exited.exitCode` / `signal`：可为 `null`。`error{code:"host-exited"}` 也可携带同名字段；客户端必须同时处理这两种表示。
- `host-exited` 只接受 host 角色发送，relay 将其广播给所有非 host 客户端；viewer/observer 伪造该消息返回 `invalid_role`。relay 会把最近一次 `host-exited` 持久化到 SessionDO；host 退出后才连接/重连的 viewer 在收到 `welcome` 后会立即收到该事件的重放。新 host 上线时清除旧的退出标记。attach 在 P2P 活动时收到退出通知后可短暂延迟（v1 为 300 ms）以排空 DataChannel 上最后一段输出。

### 4.3 JSON 中的 u64

- JSON 的 `ack.seq`、`resync.fromSeq` 使用**规范十进制字符串**：`0`，或非零数字后跟数字；不得有 `+`、前导零、小数点、指数、空白。
- 例：`"seq": "0"`、`"seq": "42"`、`"fromSeq": "9007199254740991"`。
- JS/TS API 为方便调用方也接受安全非负整数，并在编码时规范化为字符串。超过 `Number.MAX_SAFE_INTEGER` 的字符串或数字一律拒绝（`invalid_message`）。
- 二进制帧中的同一概念使用 `u64BE`，不走字符串。

### 4.4 Capabilities

`hello.capabilities` / `welcome.capabilities` 是 loose object。v1 已使用与预留：

| Key | 字段 | 状态 |
|---|---|---|
| `protocolVersion` | number | 可选 |
| `display` | `modes: string[]`, `fixed?: {cols,rows}`, `logPanel?`, `terminalQueries?` | v0.1.2 固定窗口/视口能力。host 声明 `modes:["fixed-grid"]`（本地渲染时加 `"viewport"`）与 `fixed`；viewer 声明 `modes:["viewport"]`。`fixed` 受单轴 10000 / 4M cell 限制；`terminalQueries:"host"` 表示 host mirror 负责回答终端查询 |
| `transports` | `modes: string[]`, `fragmentation?` | v1 使用 `modes`；v1.1 F0 使用 `fragmentation: {version, maxFrameBytes, maxMessageBytes}` |
| `snapshot` | `formats: string[]`, `maxBytes` | v1 使用；预期格式含 `xterm-serialize`、`raw-ring` |
| `tunnel` | `version`, `arq`, `fec[]`, `crypto`, `keyMode`, `maxFrameSize` | v1.1 F1 使用 `version:1`、`arq:"selective-repeat"`、`crypto:"aes-256-gcm"`、`keyMode:"session-token"\|"shared-secret"`、`maxFrameSize:16339`；v1.1 F1.1 的 `fec:["none","xor"]`（XOR 单丢包 parity） |
| `listener` | `modes: string[]` | v1.1 F2 使用 `snapshot-only`；`safe-boundary` 仍预留 |
| `peerRelay` | `version`, `roles: string[]` | v1.1 预留 |

所有 capability 的已知字段都是可选的，未知字段/未知值不得导致连接失败。v1 relay 不协商未知 capability，也不得据此改变行为。

`display` 是 v0.1.2 的可选扩展，不提升 `v`：host 在 `hello.capabilities.display.fixed`
中声明会话级固定逻辑窗口；viewer 通过 relay 在 `welcome.clients[]` / `presence.clients[]`
回显的 `capabilities.display.fixed` 发现它。旧 relay 不回显 capabilities 时，viewer
必须退回 legacy 直通渲染。旧 viewer 收到 `display` 字段必须忽略。

`display.terminalQueries:"host"` 表示由 host mirror 回答终端查询。新 viewer 看到该
字段时不得把本地 mirror 生成的查询回复发给 host；旧 host 没有该字段时，viewer 可
把 mirror 回复作为 `INPUT` 发送，等价于真实终端行为。

F0 仅在 `transports.fragmentation` 满足 `version === 1`、`maxFrameBytes >= 1 MiB`、
`maxMessageBytes === 16384` 时视为支持；不匹配按“不支持分片”处理，回退 relay
快照。

F2 的 listener 只声明 `transports.modes: ["relay"]` 与
`listener.modes: ["snapshot-only"]`，不声明分片。v1.1 relay 在
`welcome.capabilities.listener.modes` 中声明 `snapshot-only`，供客户端判断 relay
是否支持 listener；capability 不匹配只影响提示，不改变 relay 路由。

### 4.5 结构类型

`ClientInfo`（用于 `welcome.clients[]` / `presence.clients[]`）：

```json
{
  "clientId": "viewer-1",
  "role": "viewer",
  "connectedAt": 1760000000000,
  "lastSeenAt": 1760000000000,
  "transport": { "mode": "p2p-direct", "state": "ready", "via": "host" },
  "client": { "name": "tokimeki-cli", "version": "0.1.2", "kind": "cli" },
  "capabilities": { "display": { "modes": ["viewport"] } }
}
```

`clientId`、`role`、`connectedAt`、`lastSeenAt`、`transport`、`client`、`capabilities`
均可选，时间均为 epoch 毫秒。relay 只回显有界的 `client` 描述与
`capabilities.display` 子集（不存储未知 capability 大字段），不解释其内容。
`transport` 的 `mode`/`state` 同 `transport` 消息。

`IceServerConfig`：

```json
{
  "urls": ["turns:turn.example.com:443?transport=tcp"],
  "username": "1760000600:viewer-1",
  "credential": "base64-hmac"
}
```

`urls` 为字符串或非空字符串数组；`username`/`credential` 可选。TURN secret 只用于 relay 生成临时凭据，绝不下发。

`SessionMeta`（协议可见部分）：

```json
{ "id": "demo-session", "createdAt": 1760000000000, "ttlSeconds": 3600 }
```

可选 `lastActivityAt`、`maxClients`、`hostOnline`。`hostTokenHash` 等凭据只存在 Session DO 内部，不属于线上协议。

## 5. 握手与认证

认证发生在 WebSocket upgrade 请求头中，不在 JSON 消息中传递 token。

### 5.1 连接头

| 角色 | URL/头 |
|---|---|
| host | `wss://<relay>/ws/<session>`，`X-Tokimeki-Master: <root master 或 namespace token>`，`X-Tokimeki-Session: <session token>` |
| viewer | `wss://<relay>/ws/<session>`，`X-Tokimeki-Session: <session token>` |
| listener（v1.1） | `wss://<relay>/ws/<session>`，`X-Tokimeki-Session: <session token>`，`X-Tokimeki-Listener: 1` |
| observer/agent | `wss://<relay>/ws/<session>`，`X-Tokimeki-Session: <session token>`（DO 支持，Worker 入口保留） |

角色不放在 URL 中：Worker 依据认证头设置内部角色，并由 `hello.role` 与认证角色交叉校验。URL 只承载公开的会话名。v1.1 Worker 分配 `host` / `viewer` /
`listener` 三个入口角色；`X-Tokimeki-Master` 优先，存在时忽略
`X-Tokimeki-Listener`。`observer` / `agent` 的 DO 路由、SQLite 表与协议 schema 已实现并通过直连测试，但生产 Worker 尚未提供选择这两个角色的入口，属于为后续协调层保留的能力。更早的 v1 relay 对 `listener` 返回 `not_implemented`。

`X-Tokimeki-Master` 可以是 root master（`TOKIMEKI_MASTER_TOKEN`）或
namespace host token（`TOKIMEKI_NAMESPACE_TOKENS`）。namespace token 只认证
其 namespace，session 必须为 `<namespace>.<slug>`；Worker 删除客户端自带的
`x-tokimeki-namespace`，只注入从 token 推导的内部头。未配置 namespace
token 时仅 root master 生效。

规则：

1. `session` 必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`。
2. Worker 校验 host 的 root master 或 namespace token（常量时间比较）、session 格式与 namespace 前缀，覆盖内部 `x-tokimeki-role` 头，并移除客户端自带 master、listener 与 namespace 头后再转发到 DO。
3. DO 首次创建会话时保存 `sha256(sessionToken)`；已有会话校验 hash。viewer/observer/agent/listener 不做 master 校验。
4. 认证失败返回 HTTP 401 或 `error{code:"unauthorized"}` 后关闭。
5. WebSocket 打开后，客户端第一条消息必须是 `hello`。`hello.session` 必须等于 URL session，`hello.role` 必须等于认证角色；`protocolVersion` 若提供必须为 1，缺省按 1 处理。
6. `hello.clientId` 必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`，且在同一会话内唯一；重复活跃 clientId 返回 `duplicate_client_id`。例外：host token 校验通过后，host 可替换同 clientId 的陈旧 host socket；若同 clientId 被非 host 占用且当前没有其他在线 host，host 接管并关闭占用者（host-wins）。viewer 默认用 `crypto.randomUUID()` 生成。
7. 成功认证后 DO 返回 `welcome`，其中包含在线客户端、ICE servers、provider、TTL 与协商 capabilities。
8. token、TURN secret、credential 不得进入 `hello`、URL、日志或错误消息。
9. 每个连接必须携带非空 `X-Tokimeki-Session`；缺失/空值在 Worker 层直接返回 HTTP 401，不会到达 DO。
10. `X-Tokimeki-Master` 不得与 `X-Tokimeki-Session` 相同；相等时 Worker 返回 HTTP 401。
11. DO 对非空 token 仍做防御性校验（空 token → 401），并把每个会话的 OPEN socket 数限制为 `maxClients * 2`（含 pending；超限 HTTP 429）。schema 只在该会话首次 host `hello` 时创建。
12. listener 仍计入 `maxClients`，并额外受 `TOKIMEKI_MAX_LISTENERS`（默认 8）限制；超限返回 `session_full` 并关闭。listener 必须先有 host 会话，不能创建 schema。

### 5.2 标准时序

```text
viewer                     relay / DO                         host
  |-- WS upgrade + headers -->|                                |
  |--------- hello ---------->|                                |
  |<--------- welcome --------|                                |
  |                           |--- peer-joined (viewer-1) ---->|
  |                           |<---- signal / transport -------|
  |<---- presence / signal ---|                                |
  |------ ice-refresh ------->|                                |
  |<--------- ice ------------|                                |
```

完整字节级示例见 `packages/protocol/test/vectors/handshake.json`（hello → welcome → ice-refresh → ice）。

### 5.3 拒绝与关闭

- 认证失败、会话满、非法 ID：发送 `error` 后关闭，尽量使用对应关闭码（§8）。
- `unsupported_version`：说明对端版本不受支持；客户端不得自动降级到 v1 以外的语义。
- `listener` 角色：v1.1 relay 接受只读 listener；更早的 v1 relay 返回
  `error{code:"not_implemented"}`（关闭码 4005），不得静默降级为 viewer。
- listener 的只读边界：发送 `INPUT`/`RESYNC_REQ`/`resize`/`resync`/`ack`/`signal`/
  `transport`/`ice-refresh` 返回 `invalid_role`，relay 不转发给 host；listener 不接收
  `OUTPUT`，不参与 ACK、`unackedBytes`、`droppedBytes`、pause 或 slow-consumer 判定。
  listener 的 `welcome` 只含 STUN（`iceProvider:"stun"`），relay 不向其签发 TURN 凭据。
- 未知 `agent.*` 消息：返回 `not_implemented`，通常**不关闭**连接，允许同一连接继续发送 v1 消息。

## 6. 输出序号、确认、重连与快照

### 6.1 seq

- `seq` 是会话级输出序号，由 host 维护；`OUTPUT` 与 `SNAPSHOT`/`SNAPSHOT_TO` 共用该序号空间。
- v1 初始值为 0，单调递增。host 进程未退出时重连继续递增；host 进程重启则 seq 归零，并必须让所有 viewer 重新快照。
- viewer 发现跳号时发送 `resync`（控制消息）或 `RESYNC_REQ`（二进制），请求 host 生成新快照。
- relay 对每个 viewer 的 `resync`/`RESYNC_REQ` 做 500ms 节流；二进制 `RESYNC_REQ` 在 relay→host 方向转换为带 `clientId` 的 JSON `resync`，host 只快照该 viewer（缺失 `clientId` 时才回退到全部 viewer）。
- viewer 只接受 `> snapshotSeq` 的 `OUTPUT`；快照到达后先清屏再写入快照。
- `ack.seq` 表示 viewer 已处理的最后输出序号。relay 可据此计算未确认字节数并做慢客户端背压。

### 6.2 快照时序

1. viewer 在 `hello` 中携带 `cols`/`rows`。
2. host 先按 resize 策略应用尺寸，再等待终端输出静默（或 50–150ms），避免在同步输出块中间快照。
3. 在输出序号 `seq = N` 处暂停该 viewer 的增量发送。
4. 生成 ANSI 快照并绑定 `seq = N`。若双方已协商 `transports.fragmentation` 且
   DataChannel 已打开，host 以 DC `SNAPSHOT` 发送（必要时用 `FRAGMENT` 分片），
   成功排队后再发送 `transport{state:"ready"}`；否则以 relay `SNAPSHOT_TO` 发送。
   DC 快照不产生 relay ACK；relay 快照仍按 §6.3 ACK。viewer 必须忽略 `seq <
   lastSeq` 的旧快照，避免 fallback/retry 时旧快照晚到导致屏幕回退。
5. 恢复 `> N` 的增量。超过 `MAX_FRAME_BYTES` 或客户端配置的快照上限时，host 必须降级（截断 scrollback/回退 ring）而不是发送损坏的 ANSI。
6. 终端尺寸单轴 `1..10000`，且 `cols * rows <= MAX_TERMINAL_CELLS = 4_000_000`；relay 对每个 viewer 的 resize 做 250ms 节流并保留 trailing 最新尺寸，host 在应用前再做一次乘积 guard。
7. listener 不走 viewer 的暂停/切换路径：host 在 listener 加入后立即发送一次全量
   `SNAPSHOT_TO`，之后按 `TOKIMEKI_LISTENER_SNAPSHOT_MS`（默认 1000ms，250..60000）
   周期发送；不暂停 PTY、不增加 viewer 序号/ACK 状态。listener 清屏后应用快照，
   忽略 `seq < lastSeq` 的旧快照；周期快照自然覆盖丢失的中间画面。

### 6.3 背压

- `pause`/`resume` 由 relay 发往 host，携带落后 viewer 的 `clientId`。host 用 `relay:<clientId>` 作为 PTY 暂停标记；共享 PTY 在任一暂停标记存在时停止产生输出。
- relay 对暂停中的 viewer 丢弃后续 `OUTPUT` 帧并计入 `droppedBytes`；`droppedBytes + unackedBytes` 达到 8 MiB 上限时以 `slow_consumer` 关闭该 viewer（关闭码 `4000`）。
- `SNAPSHOT_TO` 是 viewer 从 relay 丢帧 gap 恢复的唯一边界，**必须穿透暂停状态送达**。否则当 host 在暂停期间结束输出时，viewer 的 `resync` 快照会被丢弃，且之后没有新 `OUTPUT` 再次触发 `resync`，viewer 将永久卡在 gap。快照仍计入未确认字节数与硬上限；其 `ack` 通过正常低水位路径解除暂停。
- P2P 切换的 DC `SNAPSHOT` 不产生 relay ACK；relay 的 pause 由 host 的 `transport{state:"ready"}` 清除（SessionDO 已有行为）。若之后回退 relay，host 发送的 `SNAPSHOT_TO` 仍按上一条 ACK 并清除之前的未确认字节。
- `ack` 是应用层流控；WebSocket 层还可以使用文本 `ping`/`pong` 自动响应。
- listener 不参与背压：relay 不为其记录 `pendingAcks`/`unackedBytes`/`droppedBytes`，
  不发送 `pause`/`resume`，也不会以 `slow_consumer` 关闭 listener。listener socket
  缓冲过高时 relay 只丢弃该次 `SNAPSHOT_TO`，等待下一次周期快照。
- `error{code:"slow_consumer"}` 表示客户端长期不确认，relay 可关闭该连接；关闭码 `4000`。

## 7. 传输选择与 ICE

### 7.1 模式与优先级

| mode | 含义 |
|---|---|
| `p2p-direct` | WebRTC 直连（优先 host candidate，同 LAN 时减少 WAN hop） |
| `p2p-turn` | 通过 coturn 或 Cloudflare TURN 中继 |
| `relay` | WebSocket relay 兜底 |

默认选择顺序：`p2p-direct` → `p2p-turn`（coturn 优先，Cloudflare TURN 兜底）→ `relay`。

客户端 `TOKIMEKI_P2P=off` 时不发起 P2P，直接使用 `relay`。`TOKIMEKI_ICE_TRANSPORT_POLICY=relay` 强制只使用 TURN candidate（测试用）；没有可用 TURN 时 P2P 会在超时后回退 relay。listener 始终使用 relay，不参与 P2P 协商。

### 7.2 ICE 配置

- `welcome.iceServers` 是 WebRTC `RTCIceServer` 形状；`iceProvider` 说明来源。
- `coturn` 优先使用 TURN REST 临时凭据（`username = <expiry>:<clientId>`，`credential = base64(HMAC-SHA1(secret, username))`）。`static` 使用预配置凭据。
- Cloudflare TURN 使用短期凭据；TTL 上限 48 小时。provider 为 `stun` 表示未配置 TURN，只尝试直连。
- `iceExpiresAt` 是 epoch 毫秒。v1.1 F0 的 host/viewer 在到期前自动发送 `ice-refresh`，收到 `ice` 后更新配置并重排；刷新严格串行，超时有退避，relay 未 ready 时不发请求。重新连接会获得新的 `welcome`/ICE 配置并重置定时器。
- `ice-refresh.provider` 受 `TOKIMEKI_TURN_PROVIDER` 约束：`none` 只允许 `stun`；`coturn` 只允许 `coturn`/`static`/`stun`；`cloudflare` 只允许 `cloudflare`/`stun`；`auto` 允许任意已配置 provider。越权覆盖回退到 mode 默认，不报错。客户端以实际返回的 `iceProvider` 为准。
- `listener` 永远不获得 TURN 凭据：其 `welcome.iceServers` 只含 STUN、`iceProvider` 为 `stun`、`iceExpiresAt` 为 `null`；listener 的 `ice-refresh` 返回 `invalid_role`，不返回 `ice`。host/viewer 的签发与刷新行为不变。
- v1.1 F0 在 P2P link 尚未 ready 时失败，最多重试一次：先按 `coturn → static → cloudflare` 刷新到可用 TURN 配置（或刷新临期凭据），再重新协商；无可用配置或第二次失败则发送 `transport{mode:"relay", state:"failed"}` 并保持 relay。已 ready 后的关闭、DataChannel 发送失败不触发重试。relay 路径不受 ICE 凭据过期影响。
- TURN 凭据、secret、credential 不得写入日志、URL 或 `hello`。

### 7.3 传输切换（v1 实际行为）

1. host 为每个 viewer 创建独立的 PeerConnection 与 DataChannel，经 DO 的 `signal` 交换 offer/answer/ICE；host 发起 offer，viewer 应答。
2. DataChannel 打开后，host 暂停该 viewer 的增量发送并生成最新 ANSI 快照；快照在 `seq = N` 处捕获。若双方已协商分片，host 经 DataChannel 发送 `SNAPSHOT`（必要时 `FRAGMENT` 分片），成功排队后再发 `transport ready`；否则经 relay 以 `SNAPSHOT_TO` 定向发送。
3. 快照发出后，host 发送 `transport{clientId, mode, state:"ready"}`，并停止向该 viewer 发送 relay `OUTPUT`；后续输出改走 DataChannel，单帧不超过 16 KiB。
4. viewer 收到 `transport ready` 后将 `INPUT` 切到 DataChannel。快照应用前收到的 DataChannel `OUTPUT` 会先缓冲（上限 4 MiB）；快照应用后再按 seq 过滤重复/旧帧。缓冲溢出或快照缺失时 viewer 发送 `RESYNC_REQ`/`resync`，由 host 重新快照。
5. 失败、12 秒 ICE 超时或 DataChannel 关闭时，host 或 viewer 发送 `transport{mode:"relay", state:"failed", reason}`；host 关闭 PeerConnection、恢复 relay 输出并重新发送快照，viewer 恢复 relay 输入。若 host 侧 link 尚未 ready，v1.1 F0 最多再用下一个可用 ICE provider 重试一次；无可用配置或再次失败则保持 relay。relay 对已 `p2p ready` 的 viewer 抑制 `OUTPUT`，避免双路径重复。
6. 控制信令、presence、ICE 配置与快照始终走 DO WebSocket，确保 P2P 失败时可立即降级。

### 7.4 TUN 隧道（v1.1 F1）

TUN profile 是可选、P2P-only 的终端字节流隧道：在 unreliable/unordered
DataChannel 上用 selective-repeat ARQ + AES-256-GCM 承载完整的 `INPUT`/`OUTPUT`
帧。控制消息、快照、resize、signal 与 relay ACK 流控仍走各自 v1 路径；relay
不转发 `TUNNEL`，收到时仍返回 `not_implemented`。

> 设计取舍（为何在 unreliable DataChannel 上自建 SR-ARQ，而不是使用 SCTP
> reliable 模式，以及两者何时会构成重复设计）见 `docs/tunnel-reliability.md`。
> 弱网注入 A/B 验证规划见 `docs/roadmap.md` 的 v2.0 小节。

**开关与协商**

- `TOKIMEKI_TUNNEL=off`（默认）时不声明 `tunnel` capability，DataChannel 保持
  reliable/ordered，行为与 v1/F0/F2 一致。
- `TOKIMEKI_TUNNEL=auto` 时双方在 hello/peer-joined 中声明：

  ```json
  "tunnel": {
    "version": 1,
    "arq": "selective-repeat",
    "fec": ["none", "xor"],
    "crypto": "aes-256-gcm",
    "keyMode": "session-token",
    "maxFrameSize": 16339
  }
  ```

- v1.1 F1.1 声明 `fec:["none","xor"]`；接收端始终能解析/利用 peer 发来的
  `fec` parity，即使本地发送策略为 `off`。`TOKIMEKI_TUNNEL_FEC=off`（默认）时
  发送端不产生 parity；`xor` 时对完整组发送 parity。
- host 只有在 viewer 的 capability 与本地 `version`/`arq`/`crypto`/`keyMode`/
  `maxFrameSize` 完全兼容时，才创建 `unordered:true, maxRetransmits:0` 的
  DataChannel，并在 `offer` signal payload 中加入：

  ```json
  "tunnel": { "version": 1, "keyMode": "session-token", "fec": "none", "initialSeq": 0 }
  ```

- `offer.tunnel.fec` 为 `"none"` 或 `"xor"`。host 仅在本端 `TOKIMEKI_TUNNEL_FEC=xor`
  且 peer capability 含 `xor` 时 offer `"xor"`；否则回落 `"none"`，不拒绝会话。
  viewer 接受两种值；只有本地策略也是 `xor` 时才发送 parity。
- viewer 校验 offer 参数；`TOKIMEKI_TUNNEL=off`、keyMode 不匹配或参数未知时
  必须拒绝该次 P2P，并发送 `transport{mode:"relay",state:"failed"}`，绝不能在
  unreliable channel 上运行 v1 帧。
- P2P 失败、ARQ 超预算、AEAD 连续失败或 keyMode 不一致时回退 relay：host 发送
  `transport relay failed` 并重新 `SNAPSHOT_TO`，viewer 恢复 relay 输入。
  tunnel 不自动重试；provider retry 仍只作用于 P2P 协商。

**密钥派生**

```text
ikm  = TOKIMEKI_TUNNEL_SECRET ?? sessionToken
prk  = HKDF-Extract(salt = UTF-8(sessionId), ikm)
h2v  = HKDF-Expand(prk, "tokimeki-tunnel-v1/host-to-viewer", 32)
v2h  = HKDF-Expand(prk, "tokimeki-tunnel-v1/viewer-to-host", 32)
```

- `keyMode="session-token"` 时 relay 在握手时见过 session token，可以推导密钥；
  该模式只作传输加固，**不得**宣称 relay-blind/E2E。
- 设置 `TOKIMEKI_TUNNEL_SECRET`（>=16 UTF-8 字节）时 `keyMode="shared-secret"`；
  relay 不持有该 secret，只有 secret 带外共享且未泄漏时才可宣称 relay-blind。
- 两端 keyMode 不一致时不得建立隧道，回退 v1。

**内层记录（`TUNNEL` 0x06 payload）**

| Offset | Size | Field |
|---|---:|---|
| 0 | 1 | version (`1`) |
| 1 | 1 | type (`1=data`, `2=ack`, `3=fec`, `4=ping`) |
| 2 | 1 | flags（bit0 = FEC parity；data/ack 为 0） |
| 3 | 1 | reserved (`0`) |
| 4 | 4 | seq u32BE |
| 8 | 4 | ackSeq u32BE（next expected；ACK/data 使用） |
| 12 | 4 | ackBits u32BE（selective ACK，`ackSeq+1..ackSeq+32`） |
| 16 | 12 | nonce（96-bit） |
| 28 | N | ciphertext + 16-byte GCM tag |

- `seq` 在 data 方向是 ARQ 数据序号；ACK 记录使用独立的 control 序号空间，避免
  与数据序号冲突。`ackSeq`/`ackBits` 始终引用对端 data 序号。
- 明文 payload 是一条完整终端帧（`INPUT` 或 `OUTPUT` 字节，包含帧类型字节）。
  `TUNNEL_MAX_FRAME_BYTES = 16384 - 1 - 28 - 16 = 16339`；tunnel 启用时 host
  把 OUTPUT payload 限制为 `16339 - 9 = 16330`，viewer 把 INPUT payload 限制为
  `16339 - 1 = 16338`，以保证整帧落在一条 DataChannel 消息内。启用 XOR FEC 时
  为进一步容纳 parity 元数据，OUTPUT payload 上限为 `16339 - 22 - 9 = 16308`，
  INPUT payload 上限为 `16339 - 22 - 1 = 16316`（其中 22 = FEC 元数据上限）。
- AAD（大端）：

  ```text
  [version u8][type u8][flags u8][direction u8]
  [seq u32BE][ackSeq u32BE][ackBits u32BE][sessionId UTF-8]
  ```

  `direction` 为 1（host→viewer）或 2（viewer→host）。方向与会话绑定阻止反射
  与跨会话替换。
- AES-256-GCM 使用随机 96-bit nonce 与 16-byte tag。AEAD 失败、未知版本/类型、
  错误方向或超大记录一律丢弃并计数；连续 16 条失败后隧道失败并回退 relay。
- 重放：data 序号低于 `nextExpected - 1024` 的记录直接丢弃；窗口内重复记录
  不重复交付，但重新 ACK，避免 ACK 丢失导致发送端卡死。

**ARQ**

- selective-repeat，发送窗口 64（硬上限 256），未确认字节上限 1 MiB。
- `ackSeq` 累积确认所有 `< ackSeq` 的 data 记录；`ackBits` bit `i` 确认
  `ackSeq + 1 + i`。
- 初始 RTO 200 ms，指数退避到 5 s；单记录最多重传 8 次或 10 s 总龄，超过即
  隧道失败。
- 接收端乱序缓冲上限 256 条 / 1 MiB / 10 s；超限或超时即失败。
- ACK 记录本身不进入 ARQ 队列，也不被 ACK；ACK 丢失由数据重传触发重复 ACK。
- 隧道失败只影响数据面：host 重新快照、viewer 恢复 relay，PTY/TUI 会话不退出。

**XOR FEC（v1.1 F1.1）**

- FEC 是 ARQ 的补充，不改变正确性依赖：丢 parity、多丢包、恢复缓存淘汰或元数据
  非法时都继续由 ARQ 恢复或回退 relay。
- 发送端把连续 data 记录按最多 8 条一组；只有完整组才生成一条 `fec` 记录，
  尾部不足一组依赖 ARQ。组内 plaintext 按组内最大长度零填充后逐字节 XOR 得到
  parity。重传不重复生成 parity；组缓冲与 parity 长度有界。
- `fec` 记录使用现有 `TUNNEL` AEAD 信封：`type=3`、`flags` bit0=1、
  `seq=startSeq`、`ackSeq=0`、`ackBits=0`。其 plaintext 布局：

  ```text
  [startSeq u32BE][count u8][reserved u8]
  [length u16BE * count]
  [parity bytes: max(lengths)]
  ```

  `count` 为 1..8；`lengths` 是每条 data plaintext 的原始长度；parity 长度为
  组内最大长度，且整条 `fec` plaintext 不超过一条 `TUNNEL` 记录的 16339 字节
  预算。`fec` 记录不进入 ARQ 队列、不被 ACK，也不重传。
- 接收端保存最近 data plaintext（上限 64 条 / 1 MiB / 30 s）。收到 parity 后：
  先经同一 key/AAD 解密验证；若组内恰好缺少 1 条且其余记录长度与元数据一致，
  则重建该 plaintext 并交给正常 ARQ 接收路径（仍去重、排序、ACK）。缺少多条、
  长度不一致或记录已被清理时不恢复。
- AEAD 失败、未知版本/类型、错误方向、缺失 parity flag、元数据非法或超限的
  `fec` 记录一律丢弃并计数，不改变 ARQ/会话状态；日志只记录组数、恢复次数与
  丢弃原因，不记录 plaintext、密钥、nonce 或 ciphertext。
- 旧 peer 的 capability 不含 `xor` 时 host offer 回落 `"none"`；v1.1 F1 peer
  仍可建立不使用 FEC 的隧道，不会因 FEC 能力差异拒绝会话。

## 8. 错误码与关闭码

### 8.1 `error.code`

| code | 含义 |
|---|---|
| `unauthorized` | 认证/会话 token 校验失败 |
| `invalid_message` | JSON 非法、schema 校验失败、未知控制消息类型 |
| `unsupported_version` | `v`/`protocolVersion` 不支持 |
| `invalid_session` | 会话 ID 格式或状态非法 |
| `invalid_client_id` | clientId 格式非法 |
| `duplicate_client_id` | 同一会话已有活跃 clientId |
| `invalid_role` | 角色不受支持（非预留角色） |
| `invalid_frame` | 帧布局非法（如 RESYNC_REQ 带 payload） |
| `unsupported_frame` | 帧类型/方向不被当前路径接受 |
| `frame_too_large` | 帧超过 1 MiB |
| `invalid_target` | `SNAPSHOT_TO`/`TUNNEL_TO` 目标非法或不存在 |
| `not_implemented` | v1 预留功能/Agent 消息未实现 |
| `session_full` | 会话客户端数达到上限 |
| `host_offline` | host 不在线，无法路由 |
| `host_exited` | host 进程已退出 |
| `slow_consumer` | 客户端长期不确认，触发背压上限 |
| `transport_failed` | P2P/TURN 传输失败 |
| `internal` | 未分类内部错误 |
| `invalid_request` | Agent 请求非法（预留） |
| `not_found` | Agent 资源不存在（预留） |
| `lease_expired` | Agent 租约过期（预留） |
| `lease_mismatch` | Agent 租约不匹配（预留） |
| `task_terminal` | Agent 任务已终态（预留） |
| `task_canceled` | Agent 任务已取消（预留） |
| `capacity_exceeded` | Agent/会话容量超限（预留） |

新增错误码需按 §1 的版本规则评审兼容性。v1 schema 只接受上表枚举内的 code；解析路径遇到未知 code 时应拒绝该消息并按 `internal` 处理，不得崩溃。

### 8.2 WebSocket 关闭码

| 名称 | 值 | 含义 |
|---|---:|---|
| `normal` | 1000 | 正常关闭 |
| `goingAway` | 1001 | 服务端/客户端离开 |
| `protocolError` | 1002 | 协议错误 |
| `messageTooBig` | 1009 | 消息超限 |
| `internalError` | 1011 | 内部错误 |
| `slowConsumer` | 4000 | 慢客户端 |
| `unauthorized` | 4001 | 认证失败 |
| `sessionFull` | 4002 | 会话满 |
| `invalidMessage` | 4003 | 非法控制消息 |
| `hostExited` | 4004 | host 退出 |
| `notImplemented` | 4005 | 预留功能未实现 |

能发送 `error` 时先发送再关闭；关闭原因不得包含 token、TURN credential 或终端内容。

## 9. Agent 协调预留

v1 只冻结 envelope 与错误回复，不实现任务、租约、事件运行时。

Envelope：

```json
{
  "v": 1,
  "type": "agent.task.claim",
  "requestId": "req-1",
  "protocolVersion": 1,
  "ts": 1760000000000,
  "sessionId": "demo-session",
  "payload": {}
}
```

- `type` 必须匹配 `^agent\.[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`。
- 除 `type` 外所有字段可选；`v`/`protocolVersion` 若存在必须为 1。未知 envelope 字段保留/忽略。
- `requestId` 最长 128 字符，用于 reply 关联与未来幂等去重。
- `payload` 是任意 JSON；v1 relay 不解释内容。
- 预留消息名包括：`agent.runner.register`、`agent.task.claim`、`agent.task.assigned`、`agent.task.none`、`agent.lease.renew`、`agent.lease.renewed`、`agent.task.progress`、`agent.task.complete`、`agent.task.fail`、`agent.task.cancel`、`agent.tasks.subscribe`、`agent.event`、`agent.ack`、`agent.error`。
- v1 relay 收到任何 `agent.*` 消息（包括未来新增的）必须能解析并返回：

```json
{
  "v": 1,
  "type": "error",
  "code": "not_implemented",
  "message": "feature is not implemented in protocol v1: agent.task.claim",
  "requestId": "req-1",
  "retryable": false
}
```

- `role: agent`/`observer` 不参与 PTY 写入路由。
- 预留语义（v1 不保证）：任务至少一次交付、租约到期可重领、`requestId` 幂等、事件 `seq`/`sinceSeq` 续传、单一 alarm 的 reconcile。未来 runner 接入点（Cloudflare Containers/Sandbox、Agents SDK Lifecycle + PiHarness、pi-codemode）不在 v1 协议承诺内。

## 10. v1.1 预留

以下内容在 v1 只保留名称/号码，不实现行为：

1. **应用层隧道**：`TUNNEL 0x06`、`TUNNEL_TO 0x07` 以及 `0x09..0x7F` 扩展区间。`0x08` 已在 v1.1 F0 分配给 `FRAGMENT`（capability-gated P2P 分片，relay 拒绝）。v1.1 F1 的 `TUNNEL 0x06` 已用于 P2P-only 内层 AEAD/ARQ 记录（§7.4）；relay 仍返回 `not_implemented`，`TUNNEL_TO` 仍预留。v1 relay 对 0x06/0x07 返回 `not_implemented`；其他未知字节按 `unknown_frame_type` 处理。ARQ/FEC/AEAD 的跨语言 wire 方言由本文与 golden vectors 冻结；OS TUN/VPN、文件传输、任意 IP 不属于 TUN profile。
2. **listener 角色**：v1.1 F2 已激活 `hello.role = "listener"`（只读、snapshot-only、不参与 resize/输入/ack/背压/P2P）。更早的 v1 relay 返回 `not_implemented`。`safe-boundary`、listener 增量输出与 listener P2P 仍预留。
3. **Capabilities**：`peerRelay` 预留；`tunnel` 在 v1.1 F1 可用（P2P-only），
   v1.1 F1.1 增加 `fec:["none","xor"]`（XOR 单丢包 parity）；`transports`、
   `snapshot`、`listener`（`snapshot-only`）在 v1.1 可用；`transports.fragmentation`
   在 v1.1 F0 可用（仅 P2P 大帧分片/直发快照）。未知 capability 必须忽略，
   不能拒绝连接。
4. **transport.via**：`host`、`peer:<id>`、`relay` 预留，v1 可忽略。
5. v1.1 新增控制消息（如 `tunnel.*`、`listener.*`）时，v1 relay 应识别预留命名空间并返回 `not_implemented`，而不是静默丢弃。

## 11. Golden fixtures 与跨语言一致性

位置：`packages/protocol/test/vectors/`。

| 文件 | 内容 |
|---|---|
| `constants.json` | 版本、帧类型值、角色、传输模式、provider、resize policy、错误码、关闭码、限制、正则 |
| `frames.json` | 每种二进制帧至少一个合法 hex（含 v1.1 `FRAGMENT`）；含空 payload、u64 最大安全值、64 字节 target、非法 fragment header 等边界；`invalid` 数组给出错误码 |
| `tunnel-records.json` | v1.1 F1 内层记录固定 layout + AEAD AAD 向量（无真实密钥）；`invalid` 数组给出 `invalid_frame` 边界 |
| `control-messages.json` | 全部 19 种 v1 控制消息（含 v1.1 listener hello 与带 `role` 的 `peer-joined`）+ 未知 `agent.*` + `not_implemented` 回复 |
| `handshake.json` | hello → welcome → ice-refresh → ice 的完整 transcript |

测试入口：`packages/protocol/src/goldens.test.ts`：

```bash
npm test -- packages/protocol
```

跨语言实现必须满足：

- 对 `frames.json.valid` 的每个 `hex` 解码得到 `expect` 描述的对象，并能重新编码回完全相同的 hex。
- 对 `frames.json.invalid` 的每个输入返回对应错误类别（错误码名称一致；错误消息文本不要求一致）。
- 能解析 `control-messages.json` 中的全部 JSON；未知字段不导致失败；u64 字段规范化为十进制字符串。
- 能复现 `handshake.json` 的消息顺序与字段。
- JSON 对象键顺序、空白、日志格式不属于 wire contract；字段值、字节、大小写和编码属于。
- 新实现必须自行验证：大端 `u64`、UTF-8 长度按字节、target 长度 1..64、1 MiB 上限、16 KiB DataChannel 上限、未知 capability 容忍。

## 12. 兼容性与安全规则

- 只增加可选字段/新消息类型时保持 `v: 1`；删除字段、改变语义、改变帧布局必须提升主版本。
- 旧实现必须忽略未知 JSON 字段和未知 capability；不得因未知字段断开连接。
- v1 的 JSON schema 对已知字段严格校验；对未知字段宽松。
- 终端 payload 不得被 JSON 化、按行拆分或做文本转码；必须原样传递字节。
- 终端数据依赖传输层加密（WSS/WebRTC DTLS）；v1 不提供应用层 E2E 加密。v1.1 隧道密钥模型未定，默认不得宣称 relay-blind。
- v1.1 F0 使用 capability-gated `FRAGMENT 0x08` 与 P2P `SNAPSHOT`；未声明分片的 v1 peer 仍走 relay 快照，不会收到 fragment。新增帧类型/可选字段保持 `v: 1`；删除字段、改变既有帧布局或语义才提升主版本。
- v1.1 F2 将 `listener` 激活为只读 snapshot-only 角色，并新增可选 `peer-joined.role`。未带 `role` 的旧 `peer-joined` 按 viewer 处理；旧 relay 对 listener 返回 `not_implemented`，v1.1 客户端必须报错而非降级。v1.1 relay + pre-v1.1 host 时，host 会把 listener 当 viewer 处理并可能尝试被 relay 拒绝的 P2P 信令；完整 listener 服务需要 v1.1 host。新增可选字段/角色保持 `v: 1`。
- v1.1 F1 增加 capability-gated `tunnel` 与 P2P-only `TUNNEL 0x06` 内层记录。未声明/不匹配的 peer 不建立隧道，继续 v1 P2P/relay；relay 永不转发 TUNNEL。session-token keyMode 可被 relay 推导，只有 shared-secret 模式可声明 relay-blind。新增可选 capability/帧内层保持 `v: 1`。
- token、TURN secret、credential、终端内容不得进入日志、错误消息、URL 或 `hello`。
- 所有长度限制以字节计（UTF-8），除非明确写为字符。
