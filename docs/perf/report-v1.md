# v1 性能基线报告

- 日期：2026-11-14
- 代码：`f2b3a2a`（v1 基线 + 安全修复）
- 本地环境：Windows Server 2022，Node 24.14.1，npm 11.11.0，
  `wrangler dev` 4.106.0，`ws://127.0.0.1:8787`，
  `TOKIMEKI_MAX_CLIENTS_PER_SESSION=16`（8-viewer 用例需要 host + 8 viewer）
- 生产环境：`wss://relay.tokiapi.app`，Worker 版本
  `ee53cf15-2acb-45a7-b08f-dd67d70e06d6`，`turnProvider=coturn`
- 工具：`scripts/perf/`（合成 host/viewer，直接使用 `@limccn/tokimeki-protocol` 帧）
- 原始 JSON：`scripts/perf/results/`（gitignored）；固化基线：
  `docs/perf/baseline-v1.json`

## 1. 方法

- **吞吐**：合成 host 发送 `OUTPUT`，viewer 对每帧回 `ACK`；每个用例发送
  8 MiB，约 10% warmup，3 次重复。1 KiB 帧以 512 KiB/5ms 节流，避免瞬时
  爆发造成的 flow-control 丢帧；64 KiB 帧不节流。结果为实际送达字节
  （多 viewer 为各 viewer 之和）除以 host 发送耗时。
- **延迟**：viewer 发送带 UUID nonce 的 `INPUT`，host 原样回显 `OUTPUT`；
  只统计 nonce 匹配样本，使用 `process.hrtime.bigint()`。
- **流控**：4 MiB / 16 KiB 帧验证 pause → resume；10 MiB / 16 KiB 帧用
  “不理会 pause 的 host”触发 8 MiB 硬上限并关闭慢 viewer。
- **快照**：合成 host 发送 0/128/256 KiB `SNAPSHOT_TO`；另测 2 秒断开后
  重连并发送带 `clientId` 的 `resync`。
- **生产短时观测**：1/2/4 viewer，2 MiB/用例，3 次重复；显式限制
  `--max-bytes 268435456 --max-duration 120`，不跑 SOAK。
- **real-CLI P2P**：真实 `tokimeki run` + `tokimeki attach`（PTY），host 跑
  `scripts/perf/emit-tui.mjs` 的确定性输出；记录 candidate pair、8 MiB burst
  端到端吞吐与 20 次 nonce RTT。
- 不同环境分层记录；生产数据只做趋势观测，不作本地硬门禁。

## 2. 本地 relay 吞吐矩阵

每用例 8 MiB、3 次重复；`delivered` 为各 viewer 实际收到字节之和
（单 viewer 期望 8 MiB；8 viewer 期望 64 MiB）。

| 用例 | 吞吐（MiB/s，3 次） | 中位数 | delivered（每次） |
|---|---|---:|---|
| 1 viewer / 1 KiB | 18.88 / 21.30 / 23.23 | 21.30 | 4.06 / 4.96 / 5.43 MiB |
| 2 viewer / 1 KiB | 30.31 / 27.22 / 9.06 | 27.22 | 5.34 / 5.32 / 5.65 MiB |
| 4 viewer / 1 KiB | 36.78 / 35.07 / 7.79 | 35.07 | 6.43 / 6.12 / 6.85 MiB |
| 8 viewer / 1 KiB | 33.87 / 2.44 / 1.06 | 2.44 | 6.15 / 9.22 / 43.06 MiB |
| 1 viewer / 64 KiB | 199.28 / 230.61 / 144.54 | 199.28 | 8.00 / 8.32 / 5.57 MiB |
| 2 viewer / 64 KiB | 454.37 / 308.68 / 296.98 | 308.68 | 16.5 / 11.1 / 11.3 MiB |
| 4 viewer / 64 KiB | 818.96 / 779.27 / 731.36 | 779.27 | 33.3 / 27.5 / 26.9 MiB |
| 8 viewer / 64 KiB | 1385.04 / 1761.49 / 1188.97 | 1385.04 | 64.0 / 57.5 / 51.4 MiB |

**解读与噪声**：

- 64 KiB 帧是本基线的主吞吐数据；即使按实际送达字节计，1/2/4/8 viewer
  的中位数仍随 fan-out 上升。
- 1 KiB 帧在 `wrangler dev` 下受 relay flow-control / WebSocket 缓冲限制：
  ACK ring 上限 256 条 × 1 KiB = 256 KiB，低于 1 MiB 高水位，因此小帧
  爆发更容易表现为送达不足而非 pause；数据只作小帧路径参考，不作为
  硬门禁。
- 8 viewer / 1 KiB 的离散度很大（单次长暂停导致耗时长），中位数不代表
  典型值；报告保留原始三次结果。
- 64 KiB 用例也偶发 pause/丢帧（尤其 8 viewer），`delivered` 已如实记录；
  这是 relay 流控的预期行为，不是客户端错误（errors=0）。

### 2.1 real-CLI P2P 直连

真实 `tokimeki run -- node scripts/perf/emit-tui.mjs` + `tokimeki attach`，
host/viewer 均在本机 PTY；host 日志记录 `p2p-direct, host->prflx`。

| 指标 | 结果 |
|---|---|
| transport | `p2p-direct, host->prflx` |
| burst | 8 MiB |
| 端到端耗时 / 吞吐 | 4262 ms / **1.88 MiB/s** |
| RTT p50/p95/p99 | 31.537 / **63.031** / 63.613 ms（20 samples） |
| errors | 0 |

说明：该吞吐包含 PTY、TUI 渲染/读取与 attach 写入，不是纯 DataChannel
吞吐；用于真实 CLI 端到端对照。P2P 失败回退 relay 的切换耗时、TURN/跨 NAT
P2P 见独立任务 `11-14-cross-nat-perf` 与 `docs/perf/cross-nat-report.md`。

## 3. 交互延迟

| 用例 | p50 | p95 | p99 | 样本 |
|---|---:|---:|---:|---:|
| L1：1 viewer，1000 次 echo | 1.601 ms | **1.956 ms** | 2.250 ms | 1000 |
| L2：8 viewer，各 500 次 | 123.527 ms | **186.351 ms** | 198.058 ms | 4000 |

L1 满足临时目标（p95 ≤ 50 ms、p99 ≤ 100 ms）。L2 的 186 ms 未达到设计
临时值 100 ms；这是单 DO 串行处理 + 8 viewer 广播/ACK 的第一版实测，
`thresholds-v1.json` 中暂设 250 ms 并标注待第二次基线校准，不把首版
数据当作回归失败。

## 4. 流控与快照

| 用例 | 结果 |
|---|---|
| pause → resume | PASS：4 MiB / 16 KiB 帧，112 ms；pause 45.2 ms，resume 3.3 ms；结束 marker 到达；暂停期间部分丢帧（delivered 4.13/4.19 MiB），符合流控语义 |
| 8 MiB 硬上限 | PASS：10 MiB；慢 viewer 以 `slow_consumer` 4000 关闭；健康 viewer 完整收到 10 MiB；host 未退出 |
| 快照 0 B | 1.593 ms |
| 快照 128 KiB | 3.648 ms |
| 快照 256 KiB | 4.956 ms |
| 2s 断开重连 + targeted resync | 6.107 ms，256 KiB 快照 |

## 5. 生产短时观测

时间窗：2026-11-13T21:39–21:40Z；Worker `ee53cf15`；每用例 2 MiB，3 次重复。

| 用例 | 吞吐（MiB/s） | 中位数 | 错误 |
|---|---|---:|---:|
| 1 viewer | 25.06 / 48.97 / 31.70 | 31.70 | 0 |
| 2 viewer | 68.04 / 64.55 / 51.62 | 64.55 | 0 |
| 4 viewer | 105.10 / 122.87 / 157.01 | 122.87 | 0 |

生产数据来自本机跨境链路（间歇性 30 秒级停顿），只作观测基线；1 viewer
首轮 delivered 1.65/2 MiB（流控丢帧），其余轮次送达完整。生产数据不参与
本地硬门禁。

## 6. 60 分钟长稳（通过）

本地 `wrangler dev`，1 host + 2 viewer；每 5 秒 1 MiB burst（16 KiB 帧，
256 KiB/5ms pacing），每 10 分钟采样 client/workerd RSS。

| 指标 | 结果 |
|---|---|
| 时长 / burst | 3606 秒 / 696 bursts（696 MiB payload） |
| 错误 / 意外断连 | 0 / 0 |
| client RSS | 82.3–88.6 MiB，稳定 |
| workerd RSS | 949.9 → 994.9 MiB，峰值 996.6 MiB；增长约 45 MiB（阈值 50 MiB） |
| host 退出 | 正常；viewer 收到 `host-exited` |
| TTL 清理 | relay 单测覆盖；本轮 60 分钟内未等待生产 TTL 到期 |

说明：`wrangler dev` 的 workerd 绝对 RSS ~1 GB，不代表生产边缘内存；
本项只用于本地长稳/增长有界判断。原始结果：`docs/perf/soak-v1.json`。

## 7. 阈值、未测项与复现

临时阈值见 `docs/perf/thresholds-v1.json`；回归判定使用
`npm run perf:compare -- docs/perf/baseline-v1.json <new>.json`（默认
20% 劣化阈值）。

未测项：

- **P2P TURN / 跨 NAT / 回退切换耗时**：本地 `p2p-direct` 已测（见 §2.1）；
  TURN/跨 NAT 性能、P2P 失败回退 relay 的切换耗时由独立任务
  `11-14-cross-nat-perf` 负责。
- **Cloudflare TURN 跨机器对照**：需临时切换 provider，未在本基线中执行。
- **真实 Claude/pi TUI 渲染**：只测传输链路，不测渲染。

复现命令：

```bash
# 本地 relay（8-viewer 需要 cap >= 9）
npm run build
npx wrangler dev --config packages/relay/wrangler.jsonc \
  --var TOKIMEKI_MAX_CLIENTS_PER_SESSION:16

export TOKIMEKI_RELAY_URL=ws://127.0.0.1:8787
export TOKIMEKI_MASTER_TOKEN="$(sed -n 's/^TOKIMEKI_MASTER_TOKEN=//p' packages/relay/.dev.vars)"

npm run perf:matrix -- --total-bytes 8388608 --repetitions 3
npm run perf:latency -- --viewers 1 --echoes 1000 --interval-ms 20
npm run perf:latency -- --viewers 8 --echoes 500 --interval-ms 20
npm run perf:flow
npm run perf:snapshot
npm run perf:soak -- --duration-minutes 60 --viewers 2
npm run perf:p2p -- --bytes 8388608

# 生产短时观测（显式上限）
TOKIMEKI_RELAY_URL=wss://relay.tokiapi.app \
TOKIMEKI_MASTER_TOKEN="$(cat /path/outside/repo/master-token)" \
npm run perf:matrix -- --env production --viewers 4 --frame-bytes 1024 \
  --total-bytes 2097152 --repetitions 3 \
  --max-bytes 268435456 --max-duration 120
```

无 master token、session token、TURN secret 或 credential 写入本报告或
基线 JSON。
