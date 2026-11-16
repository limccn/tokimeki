# cross-NAT 性能报告（v1）

- 日期：2026-11-14
- 任务：`11-14-cross-nat-perf`
- 代码：远端 CLI 为 v1 基线；本机 harness 基于 `2cae3ff`，Phase 3–7 修正已
  提交（`dbe1100`、`7b5fcb2`、`f4ec146`、`fa0b6d4`），review 加固 `d965d4c`
- 本机：Windows Server 2022，Node 24.14.1，中国大陆家宽/NAT 后
- 日本 VPS：Linode，Node 24.22.3，`/opt/tokimeki`
- 美国 VPS：Linode，Node 24.22.3，经日本 VPS `ssh -J` 访问
- Relay：生产 `wss://relay.tokiapi.app`；`/healthz`：
  `ok:true, protocolVersion:1, turnProvider=coturn, turnConfigured:true`
- 环境标签：`wan-nat-to-vps`
- 原始结果：`scripts/perf/results/perf-cross-nat-*.json`（gitignored）；
  固化摘要：`docs/perf/cross-nat-baseline-v1.json`
- 详细证据：`.trellis/tasks/11-14-cross-nat-perf/research/`
  - `cross-nat-relay-phase1.md`（合成 relay-only 日本）
  - `cross-nat-p2p-turn-phase3-4.md`（真实 CLI P2P/TURN）

## 1. 范围与限制

本轮测量的是**本机 NAT ↔ 公网 VPS**，不是严格 NAT↔NAT/CGNAT 双端；
公网 VPS 有独立公网地址，NAT 穿透条件与真实双 NAT 不同。严格 NAT↔NAT
仍缺真实客户端资源，相关项标记 blocked，未用本报告结果替代。

> 2026-11-16 更新：严格 NAT↔NAT 已由维护者人工 e2e 确认
> （`docs/deployment.md` §7.6）；本报告仍只覆盖 `wan-nat-to-vps` 性能测量，
> 不把该确认混入性能结论。

真实 CLI 吞吐包含：viewer 远端终端渲染、远端 PTY、P2P/TURN 数据面、
跨境链路。它不是纯 DataChannel/TURN 网络吞吐；合成 relay-only 场景
（无 TUI 渲染）是独立的网络测量。

## 2. 方法

- Host：本机 `tokimeki run -- node scripts/perf/emit-tui.mjs`。
- Viewer：远端 `tokimeki attach`，在远端内层 PTY（90x28）中运行。
  Windows 侧通过 `ssh -T` 连接；早期直接 `ssh -tt` 会让远端 PTY 变成
  1x1，P2P answer 不出现，已改为远端 PTY 包装器。
- Token：master token 只在本机；session token 经 SSH stdin 写入远端
  `0600` 临时 env 文件，命令不把 token 放进 argv；命令用
  `trap 'rm -f <envFile>' EXIT` 兜底删除，包装器在 SSH stdin 关闭时
  杀死远端 PTY。
- 批量输出：包装器只把 `PERF_*` marker 与日志转发到本地，丢弃
  `PERF_DATA_BEGIN..PERF_DATA_END` 之间的批量 TUI 输出。批量数据仍被
  从 PTY 读出，远端渲染路径完整执行，但跨境 SSH 观察链路不再主导吞吐。
- P2P 判定：host 日志 `p2p data channel open ... (mode, candidate detail)`
  与 `p2p ready`；失败为 `p2p unavailable ... using relay`。
- RTT：远端发送 `rtt <nonce>`，host TUI 输出 `PERF_RTT:<nonce>`；计时从
  本地写入 SSH stdin 到本地读到 marker，包含 SSH 输入、数据面和远端渲染。
  每样本上限 30 s。
- 吞吐：远端发送 `start <bytes>`，host TUI 输出 8 MiB 的 `PERF_DATA`
  行并以 `PERF_DATA_END` 结束；计时从本地写入到读到结束 marker。
- 失败项单独记录，不合并；每个配置优先保留完整通过记录。跨境链路多次
  出现 relay 握手、SSH banner、ICE、RTT 超时，已如实记录。

## 3. 结果

### 3.1 合成 relay-only（日本，Phase 1）

本地合成 host + 日本合成 viewer，64 KiB 帧，1 MiB 冒烟：

| 指标 | 结果 |
|---|---|
| 送达 | 1 MiB，0 errors |
| 吞吐 | **403,399 B/s** |
| 8 MiB 矩阵 | **环境阻塞**：多次 0/部分送达、host open/peer-joined/远端结果超时；未写成通过 |

同一时间窗的 1 MiB 复测（3 次）：1 次 PASS（401,611 B/s），2 次远端 viewer
SSH `exited before ready (255)`；与既有链路抖动一致。

### 3.1.1 合成 relay-only（美国，Phase 2）

本地合成 host + 美国合成 viewer（经日本跳板），64 KiB 帧：

| 时间（UTC） | 配置 | 结果 |
|---|---|---|
| 06:02:21 | 1 MiB | **PASS**：389,507 B/s，0 errors |
| 06:03:03 / 06:03:33 / 06:04:27 | 8 MiB | **环境阻塞**：远端 viewer SSH 255、relay host welcome 超时；未进入 8 MiB 数据面 |

US 的 relay 路径本身可用（1 MiB 通过）；8 MiB 三次都停在建连阶段，没有有效
8 MiB 数据，未写成通过。

### 3.2 真实 CLI P2P 直连（日本）

| 时间（UTC） | 负载 / RTT | transport | 吞吐 | RTT p50 / p95 / p99 | 结果 |
|---|---|---|---:|---|---|
| 03:08:57 | 1 MiB / 5 | `p2p-direct, prflx->host` | 10,687 B/s | 1,627 / 2,866 / 2,948 ms | PASS（当时 SSH 观察未抑制，吞吐被 SSH 拖慢） |
| 03:14:35 | 1 MiB / 5 | `p2p-direct, srflx->host` | 106,932 B/s | 728 / 5,851 / 6,802 ms | PASS |
| 03:22:50 | 8 MiB / 20 | — | — | — | **FAIL**：240 s 内未到 `PERF_DATA_END` |
| 03:06:49 / 03:13:23 | 1 MiB | — | — | — | FAIL：ICE negotiation timed out |
| 03:12:01 | 1 MiB | — | — | — | FAIL：RTT 0 超时（当时每 RTT 10 s） |

结论：直连可建立（`srflx->host` / `prflx->host`），但**不稳定**。1 MiB
两次通过、多次 ICE 超时；8 MiB 持续 burst 未完成。不能把直连作为唯一
跨 NAT 路径。

### 3.3 coturn TURN（日本）

| 时间（UTC） | 负载 / RTT | transport | 吞吐 | RTT p50 / p95 / p99 | 结果 |
|---|---|---|---:|---|---|
| 03:17:41 | 1 MiB / 5 | `p2p-turn, relay->relay` | 797,181 B/s | 1,387 / 1,639 / 1,652 ms | PASS |
| 03:19:57 | 8 MiB / 20 | `p2p-turn, relay->relay` | **107,636 B/s** | 1,271 / 3,198 / 8,118 ms | PASS |
| 03:41:13 | 1 MiB / 5 | `p2p-turn, relay->relay` | 346,542 B/s | 761 / 871 / 890 ms | PASS |
| 03:18:23 | 8 MiB / 20 | — | — | — | FAIL：RTT 4 超时（当时每 RTT 10 s） |
| 03:16:30 | 1 MiB | — | — | — | FAIL：host relay ready 超时 |

结论：日本方向 coturn TURN 可稳定完成 1 MiB 与 8 MiB。8 MiB 持续吞吐约
**105 KiB/s**，RTT p50 约 1.27 s、p95 约 3.2 s，p99 出现 8.1 s 长尾。
1 MiB 的 797 KiB/s / 346 KiB/s 与 8 MiB 的 107 KiB/s 差距较大，短 burst
受缓冲/排队影响；持续值更接近真实 CLI 端到端能力。

`relay->relay` 表明双方都使用 TURN relay candidate；CLI 的 libjuice TURN
仅使用 UDP 3478（TLS/5349 由 coturn 侧验证，不在 CLI 数据面）。

### 3.4 美国 VPS（经日本跳板）

| 时间（UTC） | 配置 | 结果 |
|---|---|---|
| 03:29:50 | TURN 1 MiB / 5 RTT | PASS `p2p-turn, relay->relay`；378,984 B/s；RTT p50 1,386 / p95 1,670 / p99 1,684 ms |
| 03:32:56 | TURN 8 MiB / 20 RTT | FAIL：ICE negotiation timed out，host 回退 `using relay` |
| 03:32:26 | 合成 relay-only 1 MiB | FAIL：`relay host: timeout waiting for welcome` |
| 03:34:00 | fallback 1 MiB | FAIL：host relay ready 超时 |
| 03:34:59 | fallback 1 MiB | FAIL：SSH `banner exchange` 超时（经日本跳板） |

美国方向 TURN 也不稳定：1 MiB 成功，8 MiB ICE 超时并回退；合成
relay-only viewer 未建立。美国与日本结果分开统计，不合并。

### 3.5 回退（fallback）

- 03:32:56 美国 TURN 8 MiB：host 日志出现 `ICE negotiation timed out` →
  `p2p unavailable ... using relay`，确认回退事件。
- 该 run 以 `p2p-turn` 模式启动，按预期失败结束；未在回退后继续测 1 MiB
  burst，因此**没有本轮的回退后吞吐**。
- 12 s ICE 超时的计时证据沿用已归档子任务 `11-13-cross-nat-turn-validation`
  的验收记录；本轮未重新计时。
- `p2p-fallback` harness 模式已加入（接受 `using relay` 后继续 RTT/burst），
  但美国两次重试都因 host relay / SSH 超时未完成。

## 3.6 Cloudflare Realtime TURN（临时切换，日本）

- 切换前：100% 版本 `ee53cf15-2acb-45a7-b08f-dd67d70e06d6`，`/healthz`
  为 `turnProvider=coturn`。
- 2026-11-14T03:48Z 按用户授权临时部署：
  `wrangler deploy --config packages/relay/wrangler.jsonc --var
  TOKIMEKI_TURN_PROVIDER:cloudflare`，版本
  `7f852448-b092-441b-9efc-dc06b3746e9b`；绑定仍包含
  `TOKIMEKI_TURN_KEY_ID` / `TOKIMEKI_COTURN_URLS`，secrets 未修改。
  该部署使用当前 HEAD（v1 基线 + 安全修复），与测试前生产版本 `ee53cf15`
  的代码差异是安全修复；测试后已回滚到 `ee53cf15`。
- 部署后 `/healthz`：
  `turnProvider:"cloudflare", turnConfigured:true`。
- 测试：本机 host + 日本 attach，`TOKIMEKI_ICE_TRANSPORT_POLICY=relay`。

| 时间（UTC） | 负载 / RTT | transport | 吞吐 | RTT p50 / p95 / p99 | 结果 |
|---|---|---|---:|---|---|
| 03:48:44 | 1 MiB / 5 | `p2p-turn, relay->relay` | 317,511 B/s | 694 / 1,666 / 1,686 ms | PASS |
| 03:54:22 | 8 MiB / 20 | `p2p-turn, relay->relay` | 367,218 B/s | 1,656 / 4,285 / 17,658 ms | PASS |

- 8 MiB host 日志记录 `iceProvider=cloudflare`；1 MiB 运行早于 harness 增加该
  字段，provider 由 `/healthz` 与 8 MiB 运行确认。
- 03:50:23 / 03:52:07 两次 8 MiB 尝试在远端 attach 首次快照前失败
  （SSH `banner exchange` 超时 / 空输出），未进入 relay/P2P；加 SSH keepalive
  后 03:54:22 通过，失败按测试通道问题记录。
- 对照：日本 coturn 8 MiB 为 107,636 B/s、p95 3,198 ms、p99 8,118 ms；
  Cloudflare 本轮 8 MiB 为 367,218 B/s、p95 4,285 ms、p99 17,658 ms
  （单样本最大 21,001 ms）。Cloudflare 本轮吞吐更高，但长尾更大，样本很小，
  不作为稳定门禁。
- 回滚：03:56Z `wrangler rollback ee53cf15-... --yes`；`/healthz` 恢复
  `turnProvider=coturn, turnConfigured=true`，当前 100% 版本回到
  `ee53cf15-2acb-45a7-b08f-dd67d70e06d6`。回滚后生产 relay smoke：
  `RELAY SMOKE PASS`，`ice=coturn`（handshake/auth、viewer welcome、
  resize/peer-joined、OUTPUT broadcast、targeted snapshot、ping/pong 全通过）。

### 3.7 WAN 流控尝试（Phase 7）

新增 `--mode relay-flow` 与远端 viewer 的 `--stall-after/--stall-ms`：
viewer 收到指定字节后停止 ACK（仍继续读取），等待后恢复；host 侧记录
`pause`/`resume` 控制消息。拓扑为本机合成 host ↔ 日本合成 viewer，生产
relay `ee53cf15`。

| 时间（UTC） | 总量 / stall | 送达 | host 发送耗时 | 吞吐 | 远端 stall 窗口 | host pause/resume | 结果 |
|---|---|---|---:|---:|---|---|---|
| 05:07:54 | 4 MiB / 1 MiB / 2 s | 4 MiB | 6,855 ms | 206,491 B/s | 2,001 ms | 0 / 0 | **FAIL（未观察到 pause）** |
| 05:09:17 | 8 MiB / 1 MiB / 2 s | 8 MiB | 13,778 ms | 381,696 B/s | 2,000 ms | 0 / 0 | **FAIL（未观察到 pause）** |
| 05:11:35 | 4 MiB / 1 MiB / 10 s | 0 | — | — | — | — | FAIL：relay host open 超时 |

解释：远端 `stall()`/`resume()` 生效，数据最终完整送达，`errors=[]`；但 host
发送窗口在 viewer 达到 1 MiB stall 阈值之前结束（relay/WAN 缓冲使 viewer
接收滞后），因此没有产生 host 侧背压。两次运行**不能**写成 WAN pause/resume
通过。本地 `flow` 基线仍是当前代码 pause/resume 的证据；WAN 版本需要在更
稳定链路或当前代码的 staging/public relay 上重测。WAN 快照/2 s 重连见 §3.8。

### 3.8 WAN 256 KiB 快照 / 2 s 重连（Phase 7）

新增 `--scenario cross-nat-snapshot`：本地合成 host 发送 256 KiB targeted
snapshot；日本合成 viewer 收到后断开、等待 2 s、用新 client id 重连并发送
`resync`；host 的 `RelayHost(resyncPayloadBytes=256 KiB)` 自动回 targeted
snapshot。远端 viewer 报告 initial/resync 送达时延。

| 时间（UTC） | initial | resync | reconnect gap | initial latency | resync latency | 结果 |
|---|---|---|---|---|---|---|
| 05:24:18 | 262144/262144 | 262144/262144 | 2,308 ms | 1,414.9 ms | 1,463.4 ms | **PASS** |
| 05:28:06 | 262144/262144 | 262144/262144 | 2,346 ms | 3,872.6 ms | 4,581.0 ms | **PASS** |

- 两次均完整收到 256 KiB 初始快照和重连后的 targeted snapshot，`errors=[]`。
- `reconnect gap` 是远端 viewer 断开到新连接建立的 wall time，包含 2 s sleep
  与握手；`resync latency` 是发送 `resync` 到收到快照的远端时钟计时。
- 修正 host target client id 后共 5 次尝试，2 次通过；3 次失败都在 SSH 或
  relay host open 阶段，会话未建立，不是 snapshot/resync 数据面失败；会话
  建立后 2/2 通过。
- host open 超时曾留下 pending WebSocket 使 CLI 不退出；已在
  `relay-host.mjs` 的超时路径 `terminate()` 并清空 socket。

## 4. 结论

1. **P2P 直连可达但不稳定**：日本方向 1 MiB 成功（`srflx->host` /
   `prflx->host`），但 ICE 超时反复出现，8 MiB burst 超时。生产上不能
   只依赖直连；TURN/relay 回退是必需的。
2. **coturn TURN 在日本方向稳定**：1 MiB 与 8 MiB 均通过
   `p2p-turn, relay->relay`；8 MiB 持续约 105 KiB/s，RTT p50 ~1.3 s、
   p95 ~3.2 s。
3. **真实 CLI 吞吐受 viewer 终端渲染限制**：本轮远端 `attach` 在 1 vCPU
   VPS 上渲染 TUI，8 MiB 持续吞吐与 1 MiB 直连抑制 SSH 后的 ~107 KiB/s
   接近，远低于本机 real-CLI 基线的 1.88 MiB/s。该数字不能当作纯网络
   吞吐；需要 headless/synthetic P2P viewer 才能测网络上限。
4. **美国路径显著更不稳定**：合成 relay-only 1 MiB 通过（389,507 B/s），
   8 MiB 三次均在 SSH/relay 建连阶段失败；TURN 1 MiB 通过，8 MiB 回退；
   经日本跳板的 SSH 也多次超时。美国结果只作为可用性观察，不用于门禁。
5. **relay-only 8 MiB 跨机仍环境阻塞**：日本/美国 1 MiB 合成冒烟均通过
   （403,399 / 389,507 B/s）；8 MiB 多次 0/部分送达、建连超时与 relay
   welcome 超时，未写成通过。
6. **Cloudflare Realtime TURN 可用**：临时把生产 provider 切到
   `cloudflare` 后，日本方向 1 MiB 与 8 MiB 均通过
   `p2p-turn, relay->relay`；8 MiB 367,218 B/s，p95 4,285 ms、p99
   17,658 ms。吞吐高于本轮 coturn，但长尾更大、样本很小，不作为稳定
   门禁。测试后已回滚到 `ee53cf15`，`/healthz` 恢复 coturn。
7. **WAN 流控尚未验证通过**：`relay-flow` 能驱动远端 viewer stall/resume，
   4/8 MiB 完整送达，但 host 未观察到 `pause`/`resume`；不能把送达当作
   flow-control 通过。
8. **WAN 256 KiB 快照 / 2 s 重连已通过**：两次运行 initial/resync 均
   262144 B，reconnect gap 2.3 s，resync 送达时延 1.46/4.58 s；失败尝试
   都在会话建立前的 SSH/relay open 阶段。
9. **未测项**：严格 NAT↔NAT/CGNAT、WAN pause/resume 通过证据、美国
   relay-only 8 MiB（建连阻塞）。

## 5. 失败率与环境噪声

- 日本直连 1 MiB：5 次尝试（03:06、03:08、03:12、03:13、03:14）中 2 次
  完整通过；其余为 ICE/RTT 超时。
- 日本 TURN 1 MiB：3 次尝试中 2 次通过（另一次 host relay ready 超时）。
- 日本 TURN 8 MiB：2 次尝试中 1 次通过（另一次 RTT 4 超时；把每 RTT
  上限从 10 s 调到 30 s 后复测通过）。
- 日本直连 8 MiB：1 次尝试，burst 超时。
- 美国 TURN 1 MiB：1 次通过；美国 TURN 8 MiB：1 次回退；美国 fallback
  1 MiB：2 次均因 SSH/relay 超时未完成。
- Cloudflare TURN 1 MiB：1 次通过；8 MiB：3 次尝试中 1 次通过，另外 2 次
  在远端 attach 首次快照前因 SSH `banner exchange`/空输出失败（未进入
  relay/P2P）。
- WAN flow：4/8 MiB 两次完整送达，远端 stall 2 s，host pause/resume 均为
  0；另一次 10 s stall 调优尝试在 relay host open 超时，未产生数据。
- WAN snapshot/reconnect：修正 host target client id 后 5 次尝试，2 次通过；
  3 次失败均在 SSH/relay host open 阶段，会话未建立；会话建立后 2/2 通过。
- US 合成 relay-only：1 MiB 通过（389,507 B/s）；8 MiB 3 次均在 SSH/relay
  建连阶段失败，标记环境阻塞。
- JP 合成 relay-only 1 MiB 复测：3 次中 1 次通过（401,611 B/s），2 次 SSH 255。
- 生产 relay `/healthz` 与 WSS 握手本身也偶发超时（与跨境链路一致）。
- provider 切换/回滚本身成功：`ee53cf15` → `7f852448`（cloudflare）→
  `ee53cf15`（coturn），回滚后 `/healthz` 正常。

## 6. 复现

需要 ssh-agent（key 有 passphrase；passphrase 不写入仓库/日志）：

```bash
export TOKIMEKI_RELAY_URL=wss://relay.tokiapi.app
export TOKIMEKI_MASTER_TOKEN="$(cat ~/.tokimeki/master-token)"

node scripts/perf/cli.mjs --scenario cross-nat --remote jp \
  --mode p2p-direct --bytes 1048576 --rtt-samples 5 --timeout-ms 120000

node scripts/perf/cli.mjs --scenario cross-nat --remote jp \
  --mode p2p-turn --bytes 8388608 --rtt-samples 20 --timeout-ms 180000

node scripts/perf/cli.mjs --scenario cross-nat --remote jp \
  --mode relay --viewers 1 --bytes 1048576 --timeout-ms 120000

node scripts/perf/cli.mjs --scenario cross-nat --remote jp \
  --mode relay-flow --bytes 4194304 \
  --stall-after 1048576 --stall-ms 2000 --timeout-ms 60000

node scripts/perf/cli.mjs --scenario cross-nat-snapshot --remote jp \
  --snapshot-bytes 262144 --reconnect-ms 2000 --timeout-ms 30000
```

Cloudflare TURN 测试窗口（需要单独授权；测试后必须回滚）：

```bash
npx wrangler deploy --config packages/relay/wrangler.jsonc \
  --var TOKIMEKI_TURN_PROVIDER:cloudflare \
  --message "perf: temporary cloudflare TURN provider"

node scripts/perf/cli.mjs --scenario cross-nat --remote jp \
  --mode p2p-turn --bytes 8388608 --rtt-samples 20 --timeout-ms 180000

npx wrangler rollback ee53cf15-2acb-45a7-b08f-dd67d70e06d6 \
  --config packages/relay/wrangler.jsonc --yes
```

默认 `runCrossNatCli` 会通过 `ensureRemoteHarness` 复制远端脚本；只有在
确认远端脚本版本后才设置 `TOKIMEKI_PERF_SKIP_REMOTE_COPY=1`。

## 7. 安全与残留

- 报告与固化 JSON 不含 master token、session token、TURN secret 或本机
  公网出口。
- 按用户单独授权临时切换过生产 TURN provider：部署
  `7f852448-b092-441b-9efc-dc06b3746e9b`（`--var
  TOKIMEKI_TURN_PROVIDER:cloudflare`），未读取/打印/修改 secret，未上传
  secret；测试后已回滚到 `ee53cf15-2acb-45a7-b08f-dd67d70e06d6`，
  `/healthz` 恢复 `turnProvider=coturn`。
- 测试窗口内的部署代码为当前 HEAD（v1 基线 + 安全修复）；回滚后生产代码
  回到测试前的 `ee53cf15`。Cloudflare 返回的短期 TURN credential 未写入
  仓库或报告。
- 远端临时 token 文件以 `umask 077` 创建；测试后已删除 JP/US 的
  `/tmp/tokimeki-xnat-env-*`。
- 早期失败留下的远端 attach 进程已清理；包装器现在在 SSH stdin 关闭时
  退出，远端 shell `trap` 删除 env 文件。
