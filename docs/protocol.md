# Tokimeki Wire Protocol v1

> 状态：v1 实现完成（Phase 6）。relay、PTY/TUI、快照重连与 P2P/TURN 路径已通过本机 live e2e；
> 生产 Cloudflare 部署、跨 NAT 与真实 coturn/Cloudflare TURN 互通尚待环境与授权验证。
> 规范性实现：`packages/protocol`；语言无关向量：`packages/protocol/test/vectors/`。
> 本文描述的是线上格式，不是 Node/TypeScript 实现细节。v2 Go/Rust 实现必须能仅凭本文与 golden vectors 互通。

## 1. 范围与版本

- 当前协议版本：`PROTOCOL_VERSION = 1`，JSON 控制消息使用顶层 `"v": 1`。
- v1 提供：JSON 控制消息、二进制终端帧、WebSocket 中继与 WebRTC DataChannel 共用的字节格式、会话握手、ICE 配置下发、输出序号与快照恢复、错误/关闭码。
- v1 只定义、不实现：`TUNNEL`/`TUNNEL_TO` 应用层隧道、`listener` 角色、`tunnel`/`listener`/`peerRelay` capabilities、Agent 运行时。收到这些预留项时返回 `not_implemented`。
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
- WebRTC DataChannel 单条消息上限 `MAX_DATACHANNEL_MESSAGE_BYTES = 16384`。v1 的每个二进制帧必须能装入单条 DataChannel 消息；host 把 `OUTPUT` 的 payload 切分到 `16384 - 16` 字节以内。v1 不实现 DataChannel 分片/重组，P2P 切换所需的快照始终通过 relay `SNAPSHOT_TO` 发送，`SNAPSHOT` 帧与分片信封保留给后续版本。
- 二进制帧编码是确定性的；不压缩、不填充、不做字节序转换以外的处理。
- 中继在 Worker/DO 中收到的二进制消息总是 `ArrayBuffer`；实现必须按 `Uint8Array` 视图处理并尊重 `byteOffset`。

## 3. 二进制帧

| 帧类型 | 值 | 方向 | 布局 |
|---|---:|---|---|
| `INPUT` | `0x01` | viewer/attach → host | `[0x01][payload...]` |
| `OUTPUT` | `0x02` | host → viewer | `[0x02][seq:u64BE][payload...]` |
| `SNAPSHOT` | `0x03` | host → viewer（P2P 直发） | `[0x03][seq:u64BE][ANSI snapshot...]` |
| `RESYNC_REQ` | `0x04` | viewer → host | `[0x04]` |
| `SNAPSHOT_TO` | `0x05` | host → relay → 指定 viewer | `[0x05][targetLen:u8][targetId UTF-8][seq:u64BE][ANSI snapshot...]` |
| `TUNNEL` | `0x06` | 预留 v1.1 | `[0x06][opaque tunnel record...]` |
| `TUNNEL_TO` | `0x07` | 预留 v1.1 | `[0x07][targetLen:u8][targetId UTF-8][opaque tunnel record...]` |

### 3.1 字段规则

- `seq`：每会话终端输出序号，`u64BE`，v1 从 `0` 开始单调递增。JSON 中对应字段使用十进制字符串（见 §4.3）。
- `payload`：原始字节，允许为空。`INPUT`/`OUTPUT`/`SNAPSHOT` 的 payload 是终端原始字节流，不是按行文本。
- `targetLen`：`targetId` 的 UTF-8 字节数，`u8`，v1 要求 `1..64`。`0` 或 `65+` 返回 `invalid_target_id`。
- `targetId`：UTF-8 字符串，必须是合法 Unicode/UTF-8。v1 的目标是客户端 ID，形状见 §5 的 ID 正则，因此总是 ASCII 且 ≤64 字节。
- `RESYNC_REQ` 必须恰好 1 字节；带任何 payload 都是 `invalid_frame`。
- `SNAPSHOT` 保留给未来的 P2P 直发快照（含分片）；v1 传输切换统一使用 relay `SNAPSHOT_TO`，不发送 `SNAPSHOT`。relay 路径仍拒绝裸 `SNAPSHOT`。
- `TUNNEL`/`TUNNEL_TO` 在 v1 必须能被识别和路由，但不得执行任何隧道行为；收到时返回 `error{code:"not_implemented"}`，不得静默丢弃或转发。
- `0x08..0xFF` 在 v1 未定义。实现返回 `unknown_frame_type`；relay 可映射为 `error{code:"invalid_frame"}` 并按策略关闭连接。

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
| `hello` | client → DO | `role`, `session`, `clientId` | `protocolVersion`（默认 1）、`capabilities`（默认 `{}`）、`cols`, `rows` |
| `welcome` | DO → client | `session`, `hostOnline`, `iceProvider`, `sessionTtlSeconds` | `protocolVersion`（默认 1）、`clients`（默认 `[]`）、`iceServers`（默认 `[]`）、`iceExpiresAt`、`transportPolicy`（默认 `all`）、`capabilities` |
| `ice-refresh` | client → DO | 无 | `provider` |
| `ice` | DO → client | `iceServers`, `iceProvider` | `iceExpiresAt` |
| `peer-joined` | DO → host | `clientId` | `capabilities`（默认 `{}`） |
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
| `host-exited` | host → DO → viewers | 无 | `exitCode`, `signal` |

字段细节：

- `hello.role`：`host`、`viewer`、`observer`、`agent`，以及 v1.1 预留的 `listener`。v1 relay 对 `listener` 返回 `not_implemented`，不授予任何终端路由。
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
| `transports` | `modes: string[]` | v1 使用；预期值 `p2p-direct`、`p2p-turn`、`relay` |
| `snapshot` | `formats: string[]`, `maxBytes` | v1 使用；预期格式含 `xterm-serialize`、`raw-ring` |
| `tunnel` | `version`, `arq`, `fec[]`, `crypto`, `maxFrameSize` | v1.1 预留，v1 只透传/忽略 |
| `listener` | `modes: string[]` | v1.1 预留，预期含 `snapshot-only`、`safe-boundary` |
| `peerRelay` | `version`, `roles: string[]` | v1.1 预留 |

所有 capability 的已知字段都是可选的，未知字段/未知值不得导致连接失败。v1 relay 不协商未知 capability，也不得据此改变行为。

### 4.5 结构类型

`ClientInfo`（用于 `welcome.clients[]` / `presence.clients[]`）：

```json
{
  "clientId": "viewer-1",
  "role": "viewer",
  "connectedAt": 1760000000000,
  "lastSeenAt": 1760000000000,
  "transport": { "mode": "p2p-direct", "state": "ready", "via": "host" },
  "capabilities": {}
}
```

`clientId`、`role`、`connectedAt`、`lastSeenAt`、`transport`、`capabilities` 均可选，时间均为 epoch 毫秒。`transport` 的 `mode`/`state` 同 `transport` 消息。

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
| host | `wss://<relay>/ws/<session>`，`X-Tokimeki-Master: <master token>`，`X-Tokimeki-Session: <session token>` |
| viewer/observer/agent | `wss://<relay>/ws/<session>`，`X-Tokimeki-Session: <session token>` |

角色不放在 URL 中：Worker 依据 `X-Tokimeki-Master` 常量时间校验结果设置内部角色（host 或非 host），并由 `hello.role` 与认证角色交叉校验。URL 只承载公开的会话名。v1 Worker 实际只分配 `host` / `viewer` 两个入口角色；`observer` / `agent` 的 DO 路由、SQLite 表与协议 schema 已实现并通过直连测试，但生产 Worker 尚未提供选择这两个角色的入口，属于为后续协调层保留的能力；`listener` 仍返回 `not_implemented`。

规则：

1. `session` 必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`。
2. Worker 校验 host 的 master token（常量时间比较）、session 格式，覆盖内部 `x-tokimeki-role` 头，并移除客户端自带 master header 后再转发到 DO。
3. DO 首次创建会话时保存 `sha256(sessionToken)`；已有会话校验 hash。viewer/observer/agent 不做 master 校验。
4. 认证失败返回 HTTP 401 或 `error{code:"unauthorized"}` 后关闭。
5. WebSocket 打开后，客户端第一条消息必须是 `hello`。`hello.session` 必须等于 URL session，`hello.role` 必须等于认证角色；`protocolVersion` 若提供必须为 1，缺省按 1 处理。
6. `hello.clientId` 必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`，且在同一会话内唯一；重复活跃 clientId 返回 `duplicate_client_id`。例外：host token 校验通过后，host 可替换同 clientId 的陈旧 host socket；若同 clientId 被非 host 占用且当前没有其他在线 host，host 接管并关闭占用者（host-wins）。viewer 默认用 `crypto.randomUUID()` 生成。
7. 成功认证后 DO 返回 `welcome`，其中包含在线客户端、ICE servers、provider、TTL 与协商 capabilities。
8. token、TURN secret、credential 不得进入 `hello`、URL、日志或错误消息。
9. 每个连接必须携带非空 `X-Tokimeki-Session`；缺失/空值在 Worker 层直接返回 HTTP 401，不会到达 DO。
10. `X-Tokimeki-Master` 不得与 `X-Tokimeki-Session` 相同；相等时 Worker 返回 HTTP 401。
11. DO 对非空 token 仍做防御性校验（空 token → 401），并把每个会话的 OPEN socket 数限制为 `maxClients * 2`（含 pending；超限 HTTP 429）。schema 只在该会话首次 host `hello` 时创建。

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
- `listener` 角色：v1 返回 `error{code:"not_implemented"}`，不得授予路由；可关闭连接。
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
4. 生成 ANSI 快照，v1 统一以 `SNAPSHOT_TO`（relay，指定 targetId）发送并绑定 `seq = N`，即使该 viewer 即将切换到 DataChannel；`SNAPSHOT` 预留给后续 P2P 直发/分片实现。
5. 恢复 `> N` 的增量。超过 `MAX_FRAME_BYTES` 或客户端配置的快照上限时，host 必须降级（截断 scrollback/回退 ring）而不是发送损坏的 ANSI。
6. 终端尺寸单轴 `1..10000`，且 `cols * rows <= MAX_TERMINAL_CELLS = 4_000_000`；relay 对每个 viewer 的 resize 做 250ms 节流并保留 trailing 最新尺寸，host 在应用前再做一次乘积 guard。

### 6.3 背压

- `pause`/`resume` 由 relay 发往 host，携带落后 viewer 的 `clientId`。host 用 `relay:<clientId>` 作为 PTY 暂停标记；共享 PTY 在任一暂停标记存在时停止产生输出。
- relay 对暂停中的 viewer 丢弃后续 `OUTPUT` 帧并计入 `droppedBytes`；`droppedBytes + unackedBytes` 达到 8 MiB 上限时以 `slow_consumer` 关闭该 viewer（关闭码 `4000`）。
- `SNAPSHOT_TO` 是 viewer 从丢帧 gap 恢复的唯一边界，**必须穿透暂停状态送达**。否则当 host 在暂停期间结束输出时，viewer 的 `resync` 快照会被丢弃，且之后没有新 `OUTPUT` 再次触发 `resync`，viewer 将永久卡在 gap。快照仍计入未确认字节数与硬上限；其 `ack` 通过正常低水位路径解除暂停。
- `ack` 是应用层流控；WebSocket 层还可以使用文本 `ping`/`pong` 自动响应。
- `error{code:"slow_consumer"}` 表示客户端长期不确认，relay 可关闭该连接；关闭码 `4000`。

## 7. 传输选择与 ICE

### 7.1 模式与优先级

| mode | 含义 |
|---|---|
| `p2p-direct` | WebRTC 直连（优先 host candidate，同 LAN 时减少 WAN hop） |
| `p2p-turn` | 通过 coturn 或 Cloudflare TURN 中继 |
| `relay` | WebSocket relay 兜底 |

默认选择顺序：`p2p-direct` → `p2p-turn`（coturn 优先，Cloudflare TURN 兜底）→ `relay`。

客户端 `TOKIMEKI_P2P=off` 时不发起 P2P，直接使用 `relay`。`TOKIMEKI_ICE_TRANSPORT_POLICY=relay` 强制只使用 TURN candidate（测试用）；没有可用 TURN 时 P2P 会在超时后回退 relay。

### 7.2 ICE 配置

- `welcome.iceServers` 是 WebRTC `RTCIceServer` 形状；`iceProvider` 说明来源。
- `coturn` 优先使用 TURN REST 临时凭据（`username = <expiry>:<clientId>`，`credential = base64(HMAC-SHA1(secret, username))`）。`static` 使用预配置凭据。
- Cloudflare TURN 使用短期凭据；TTL 上限 48 小时。provider 为 `stun` 表示未配置 TURN，只尝试直连。
- `iceExpiresAt` 是 epoch 毫秒。relay 支持 `ice-refresh` 与 `ice`，但 v1 CLI 没有自动到期刷新定时器；host 长时间在线后，新建 P2P 可能因旧凭据失败而回退 relay。重新连接会获得新的 `welcome`/ICE 配置。
- `ice-refresh.provider` 受 `TOKIMEKI_TURN_PROVIDER` 约束：`none` 只允许 `stun`；`coturn` 只允许 `coturn`/`static`/`stun`；`cloudflare` 只允许 `cloudflare`/`stun`；`auto` 允许任意已配置 provider。越权覆盖回退到 mode 默认，不报错。
- v1 在 P2P 失败/关闭时直接发送 `transport{mode:"relay", state:"failed"}` 并回退 relay，不自动切换 ICE provider 重试；provider 轮换/失败重试在 v1.1 补齐。relay 路径不受 ICE 凭据过期影响。
- TURN 凭据、secret、credential 不得写入日志、URL 或 `hello`。

### 7.3 传输切换（v1 实际行为）

1. host 为每个 viewer 创建独立的 PeerConnection 与 DataChannel，经 DO 的 `signal` 交换 offer/answer/ICE；host 发起 offer，viewer 应答。
2. DataChannel 打开后，host 暂停该 viewer 的增量发送并生成最新 ANSI 快照；快照在 `seq = N` 处捕获，经 relay 以 `SNAPSHOT_TO` 定向发送给该 viewer，不经过 DataChannel。
3. 快照发出后，host 发送 `transport{clientId, mode, state:"ready"}`，并停止向该 viewer 发送 relay `OUTPUT`；后续输出改走 DataChannel，单帧不超过 16 KiB。
4. viewer 收到 `transport ready` 后将 `INPUT` 切到 DataChannel。快照应用前收到的 DataChannel `OUTPUT` 会先缓冲（上限 4 MiB）；快照应用后再按 seq 过滤重复/旧帧。缓冲溢出或快照缺失时 viewer 发送 `RESYNC_REQ`/`resync`，由 host 重新快照。
5. 失败、12 秒 ICE 超时或 DataChannel 关闭时，host 或 viewer 发送 `transport{mode:"relay", state:"failed", reason}`；host 关闭 PeerConnection、恢复 relay 输出并重新发送快照，viewer 恢复 relay 输入。relay 对已 `p2p ready` 的 viewer 抑制 `OUTPUT`，避免双路径重复。
6. 控制信令、presence、ICE 配置与快照始终走 DO WebSocket，确保 P2P 失败时可立即降级。

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

1. **应用层隧道**：`TUNNEL 0x06`、`TUNNEL_TO 0x07` 以及 `0x06..0x7F` 扩展区间。v1 relay 对 0x06/0x07 返回 `not_implemented`；其他未知字节按 `unknown_frame_type` 处理。v1.1 才会冻结 ARQ/FEC/AEAD 布局、`txSeq`/`streamSeq` 与密钥威胁模型。
2. **listener 角色**：`hello.role = "listener"`。v1 返回 `not_implemented`；v1.1 才实现只读、snapshot-only、不参与 resize/输入/ack 的语义。
3. **Capabilities**：`tunnel`、`listener`、`peerRelay` 预留；`transports`、`snapshot` 在 v1 可用。未知 capability 必须忽略，不能拒绝连接。
4. **transport.via**：`host`、`peer:<id>`、`relay` 预留，v1 可忽略。
5. v1.1 新增控制消息（如 `tunnel.*`、`listener.*`）时，v1 relay 应识别预留命名空间并返回 `not_implemented`，而不是静默丢弃。

## 11. Golden fixtures 与跨语言一致性

位置：`packages/protocol/test/vectors/`。

| 文件 | 内容 |
|---|---|
| `constants.json` | 版本、帧类型值、角色、传输模式、provider、resize policy、错误码、关闭码、限制、正则 |
| `frames.json` | 每种二进制帧至少一个合法 hex；含空 payload、u64 最大安全值、64 字节 target 等边界；`invalid` 数组给出错误码 |
| `control-messages.json` | 全部 19 种 v1 控制消息 + 未知 `agent.*` + `not_implemented` 回复 |
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
- v1 P2P 切换不实现 DataChannel 分片：单帧上限 16 KiB，快照走 relay。v1.1 若改为 P2P 直发快照，必须先把分片信封纳入 golden vectors 并说明兼容性。
- token、TURN secret、credential、终端内容不得进入日志、错误消息、URL 或 `hello`。
- 所有长度限制以字节计（UTF-8），除非明确写为字符。
