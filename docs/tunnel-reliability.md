# TUN 可靠传输取舍：应用层 SR-ARQ vs WebRTC/SCTP

> 状态：设计决策记录（2026-11-18）。适用于 v1.1 F1/F1.1 已实现的 TUN
> profile，并作为 v2.0 弱网注入 A/B 验证的输入。线协议见
> `docs/protocol.md` §7.4；路线图见 `docs/roadmap.md`。

## 1. 结论

- TUN 跑在 `unordered: true, maxRetransmits: 0` 的 DataChannel 上
  （`packages/cli/src/host/host-session.ts:855`）。SCTP 的重传和排序被主动关闭，
  应用层 selective-repeat ARQ 是这条通道上**唯一**的重传层。
- 因此这不是“重复实现 WebRTC 自带的 ARQ”，而是用应用层可靠传输**替换**
  SCTP reliable 模式，不是叠加。
- 真正的重复设计是“reliable DataChannel + 应用层 ARQ”同时开启：会造成双重传、
  双 ACK 和延迟放大。当前代码路径互斥，见 §3。
- 这套替换是否值得，取决于弱网实测。v2.0 规划中的 A/B 验证（§7）是决策前置，
  在结论出来前不应把 TUN 方言当作 v2.0 的既定实现。

## 2. 先澄清：WebRTC 的“自带 ARQ”是什么

DataChannel 的可靠性来自 **SCTP over DTLS**，不是音视频 RTP 的 NACK/RTX。
WebRTC DataChannel 支持三种典型模式：

| 模式 | 配置 | SCTP 重传 | SCTP 排序 |
|---|---|---|---|
| reliable ordered | 默认（不传 options） | 是 | 是 |
| reliable unordered | `unordered: true`，不设重传上限 | 是 | 否 |
| partial / unreliable | `maxRetransmits` 或 `maxPacketLifeTime` | 有限或关闭 | 可选 |

SCTP reliable 模式本身就是一个 selective-repeat 家族协议：cumulative TSN +
SACK gap blocks + RTO/快速重传 + 拥塞控制 + 流控 + 分片。所以 TUN 的 ARQ 并不是
发明了另一种算法，而是把“累计 ACK + 选择性确认 + 有界重传”放到了应用记录层。

RTP/RTCP 的 NACK、RTX、ULPFEC/FlexFEC 只作用于音视频媒体路径，不适用于
DataChannel；本项目也没有使用它们。

## 3. 当前的两条互斥路径

```text
TUN 路径（TOKIMEKI_TUNNEL=auto，capability 匹配）：
OUTPUT frame → AEAD record(seq) → selective-repeat ARQ → TUNNEL 0x06
             → SCTP(unreliable：保留拥塞控制/流控/SACK，不重传)
             → DTLS → ICE/UDP

v1 P2P 路径（TUNNEL=off，或 viewer 不匹配）：
OUTPUT frame → DataChannel(reliable/ordered)
             → SCTP(SACK + 重传 + 排序 + 拥塞控制) → DTLS → ICE/UDP

relay 路径（P2P 未 ready / 回退）：
OUTPUT frame → WebSocket → SessionDO（unackedBytes ACK 流控）
```

互斥性由代码保证：

- host 只有 viewer 的 tunnel capability 匹配时才创建 unreliable DataChannel
  （`packages/cli/src/host/host-session.ts:855`）。
- viewer 拒绝在 unreliable DataChannel 上运行 v1 帧
  （`packages/cli/src/attach/attach-session.ts:599`）。
- 每个 P2P viewer 的终端帧只走 `tunnel.send` 或 `peer.send` 其中一条
  （`packages/cli/src/host/host-session.ts:1190`）。
- relay 只发给尚未 P2P-ready 的 viewer；切换/回退快照仍走 relay
  （`packages/cli/src/host/host-session.ts:1372`）。

`TOKIMEKI_TUNNEL=off`（默认）时 data channel 保持 reliable/ordered，应用层
ARQ 完全不参与，因此也不存在重复。

## 4. 对比

| 维度 | SCTP reliable DataChannel | TUN 应用层 SR-ARQ |
|---|---|---|
| 层次 | 传输层（SCTP） | 应用记录层（`arq.ts`） |
| 激活方式 | 默认开启 | `TOKIMEKI_TUNNEL=auto` + capability/keyMode 匹配 |
| 重传单位 | SCTP TSN/chunk，应用帧边界不可见 | 一条 AEAD record = 一条完整终端帧（≤16 KB） |
| ACK | SACK gap blocks，RTO 由 SCTP 估计 | cumulative `ackSeq` + 32-bit `ackBits`（`arq.ts:9-11`） |
| 排序 | ordered/unordered 可选 | 应用层按 seq 重排后交付 |
| 失败语义 | 由 SCTP 实现决定，重试/关联失败时机不可细调 | 固定预算：窗口 64、最多 8 次、10 s 总龄，超限确定性失败并回退 relay |
| 拥塞控制 | 有 | 无；固定窗口 + 有界队列 + PTY pause |
| FEC | 无 | 同一 seq 空间可叠加 XOR parity（F1.1） |
| 可观测性 | 基本不可见 | 重传、FEC 恢复、AEAD 失败等 stats |
| wire 稳定性 | 随 SCTP 实现/版本变化 | 由 `docs/protocol.md` §7.4 和 golden vectors 冻结，供 v2 Go/Rust 互操作 |

## 5. 为什么 TUN 选择 unreliable + 应用层 ARQ

1. **有界失败 / 快速回退**：终端场景希望在固定预算内切回 relay，而不是等 SCTP
   关联自己判定失败。TUN 的 8 次重传 / 10 s 总龄是可预测的；失败后 host 重新
   快照、viewer 恢复 relay 输入，PTY 不退出（`docs/protocol.md:413-415`）。
2. **FEC 集成**：XOR parity 必须与 data 共用 seq 空间，SCTP 无法插入应用层 FEC。
   丢 parity、多丢包或恢复缓存失效时仍回退 ARQ，正确性不依赖 FEC。
3. **可观测性**：可以记录重传次数、FEC 恢复次数、ACK/窗口状态，便于诊断弱网。
4. **跨语言 wire 方言**：v2 的 Go/Rust 客户端可以复用冻结的 TUN 记录/ARQ 语义；
   SCTP 行为随实现和版本变化，不适合作为跨语言互操作契约。
5. **记录层 AEAD/重放/方向绑定**：`shared-secret` 模式不依赖 WebRTC 承载；将来
   换传输路径时记录层语义仍成立。注意：DTLS 已经提供链路加密，TUN AEAD 是
   纵深防御和可移植性，不应描述成比 DTLS 更强的端到端保证。
6. **背压配合**：`onDrain` + 未确认字节低水位可以把 PTY pause/resume 接到
   ARQ 队列，而不是只看 SCTP 的 `bufferedAmount`。

**最接近的替代方案**是 reliable/unordered DataChannel：SCTP 负责重传但不阻塞
后续消息，应用层只需重排、不需要 ARQ。如果 v2.0 的目标只是“可靠传输”，这个
方案更简单、拥塞控制更成熟；当前 TUN 的复杂度是为“可控失败 + FEC + 可观测 +
跨语言兼容”付的代价。

## 6. 已知代价与风险

- **两个控制回路**：unreliable SCTP 仍保留拥塞控制和流控；应用层重传相当于向
  SCTP 拥塞窗口注入新的发送。应用层没有自己的拥塞控制，弱网行为不能只靠固定
  窗口推断。
- **ACK 放大**：当前每收到一条 data 记录就回一条 AEAD ACK，且没有延迟/合并 ACK
  （`packages/cli/src/transport/tunnel/tunnel-transport.ts:409-426`）。单向大输出
  时 ACK 帧数量与数据帧同阶，每个 ACK 还要过 AEAD；双向流量可靠 data 记录
  piggyback 可以缓解，但纯下行仍是成本。
- **两层加密**：DTLS + AES-256-GCM。不是正确性问题，但增加了 CPU 和密钥管理
  面；`session-token` 模式 relay 可推导密钥，只有 `shared-secret` 才能声明
  relay-blind。
- **F0 分片不是另一层 ARQ**：`FRAGMENT 0x08` 是无状态信封，不 ACK、不重传，
  失败直接回退快照（`packages/cli/src/transport/fragmentation.ts:8-10`）。
- **验证缺口**：强制丢包/乱序注入、跨机器 tunnel e2e、真实跨公网高丢包尚未
  执行（`docs/roadmap.md` 的 v1.1 状态）。目前“比 reliable DataChannel 更好”
  是设计论证，不是实测结论。

## 7. v2.0 弱网注入 A/B 验证（规划）

验证任务：`11-18-v2-0-weaknet-ab-validation`（Trellis planning）。目标是在
v2.0 transport 实现冻结前回答“保留 TUN ARQ/FEC，还是改用 SCTP reliable 模式”。

### 变体

| 标记 | 路径 | 说明 |
|---|---|---|
| A | reliable/ordered DataChannel | v1 默认；SCTP 重传 + 排序 |
| B | reliable/unordered DataChannel | SCTP 重传、无 SCTP 排序；仅 harness 参考路径 |
| C | unreliable/unordered + TUN SR-ARQ | 当前 F1，`TOKIMEKI_TUNNEL_FEC=off` |
| D | unreliable/unordered + TUN SR-ARQ + XOR FEC | 当前 F1.1，`TOKIMEKI_TUNNEL_FEC=xor` |
| R | relay 回退基线 | 只用于失败/回退正确性与恢复时间，不作为主传输对比 |

### 注入与指标

- 主环境：Linux VM / network namespace + `tc netem`，在真实 UDP 路径上注入
  loss / reorder / duplicate / jitter / rate；这是唯一能同时影响 SCTP 和
  unreliable 路径的方式。Windows/macOS 工具只做 sanity，app 层丢帧不能代表
  SCTP 的行为。
- 建议档位：clean；loss 0.1%/1%/3%/5%/10%；reorder 1%；duplicate 0.5%；
  delay 20/100 ms；rate 1/5/20 Mbps；以及 loss+reorder、loss+jitter 组合。
- 指标：字节级正确性、p50/p95/p99 完成时间或 RTT、goodput、HOL/停顿、
  重传/FEC 恢复、tunnel 失败与 relay 回退时间、CPU/RSS、ACK 字节占比。
- 决策门槛由任务 PRD 预注册；任何变体必须先满足 100% 字节正确性，再比较
  延迟/恢复/开销。报告必须列出未测项和失败样本，不允许只报最优运行。

## 8. 参考

- `docs/protocol.md` §7.4（TUN 记录、ARQ、FEC 的 wire 契约）
- `docs/roadmap.md`（v1.1 状态、v2.0 规划）
- `packages/cli/src/transport/tunnel/arq.ts`（SR-ARQ 实现）
- `packages/cli/src/transport/tunnel/tunnel-transport.ts`（记录/ACK/FEC 集成）
- `packages/cli/src/transport/p2p-peer.ts`（DataChannel 配置与信令）
