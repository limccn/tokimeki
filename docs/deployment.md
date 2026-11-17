# 部署指南

> 状态：v1 已部署到生产 Cloudflare。生产 URL 为 `https://relay.tokiapi.app`
> （Worker `tokimeki-relay`，当前 100% 流量版本
> `1104916c-f188-4cc5-8df6-e34ca557ffae`，2026-11-16 发布，含 v1.1 F2
> 只读 listener 角色；上一版本 `ee53cf15-2acb-45a7-b08f-dd67d70e06d6`
> 可作为回滚参考，含 host relay 重连修复）。
> `TOKIMEKI_MASTER_TOKEN`、`TOKIMEKI_COTURN_SECRET` 与 `TOKIMEKI_TURN_API_TOKEN`
> 已通过 `wrangler secret put` 上传；`TOKIMEKI_TURN_KEY_ID` 为 vars（Cloudflare TURN
> 验证用，当前 provider=coturn 时不生效）。当前 `TOKIMEKI_TURN_PROVIDER=coturn`，
> `TOKIMEKI_COTURN_URLS` 为 `cn.stun.tokiapi.app` / `stun.tokiapi.app` 共六条；
> `/healthz` 报告 `turnProvider:"coturn"`、`turnConfigured:true`；生产 TURN-only
> e2e 通过（`P2P transports: p2p-turn, relay->relay`）。Cloudflare Realtime TURN 已
> 于 2026-11-13 完成独立验证，Key ID 与 API Token secret 保留但未启用。
> 2026-11-13 完成 coturn secret 轮换；两台 coturn 均通过 relay-pair 门禁，
> `stun.tokiapi.app` 的 `external-ip` 已修复（见 §4.1）。
> Worker `/healthz`、`/ws/<session>`、SessionDO（SQLite + Hibernation）、TURN 凭据签发、
> PTY/TUI 托管、共享控制、快照重连与 P2P 路径均已落地；本机 live e2e 1–5 组通过
> （第 5 组为独立的 host 1006 重连脚本），生产 TURN-only e2e（coturn UDP）与
> Cloudflare TURN TURN-only e2e 通过。生产 P2P
> live e2e 曾在 `d28ef19e` 完整通过；2026-11-13 在 `ee53cf15` 复跑两次均因跨境 relay
> 心跳中断停在不同断言，P2P 直连路径本身已建立（见 §7.3）。2026-11-13 完成本机
> NAT ↔ 日本/美国 VPS 的跨机器 relay、直连 P2P、
> coturn TURN 与 TURN 不可达回退验收；host 瞬时断线重连的 `duplicate_client_id`
> 缺陷已在源码修复，通过本机真实 TCP 断线复测，并已随 `293d1eba` 部署到生产；
> 生产环境另以同 clientId 双 host 冒烟验证了鉴权后替换路径（旧 socket 4003，新 socket
> welcome）。跨境链路仍有间歇性停顿；生产 hibernation/TTL alarm 仍需环境验证，见 §7。
> 2026-11-16 维护者人工确认严格 NAT↔NAT 与真实 Claude/pi TUI 交互已通过 **e2e 层面**
> 验收（§7.6）；该确认不等同于长期运行、生产边缘休眠或全路径验收。
> 当前 CLI 的 libjuice 不支持 TURN over TCP/TLS，CLI 只能走 UDP；`turns:` 5349 供
> 浏览器等客户端使用。

## 1. 前置条件

- Node.js >= 22.12（开发与验证环境为 Node 24），npm >= 11。
- 已安装依赖：`npm install`。
- 已登录 Cloudflare 的 wrangler（`wrangler@4.106.0`）。
- 可选（推荐）：一台可自建 coturn 的公网 VPS（大陆或香港/新加坡/日本）；或
  Cloudflare Realtime TURN Key（可选兜底；验证完成但当前未启用，见 §4.2）。
- 已确认 Wrangler 内置 workerd 支持 `compatibility_date: "2026-04-07"`
  （本机 4.106.0 上限为 2026-07-07，不要照抄官方示例的最新日期）。

## 2. 登录 wrangler

```bash
npx wrangler login
npx wrangler whoami
```

## 3. 配置 Worker secrets

生产环境的敏感值必须用 `wrangler secret put`，不要写进 `wrangler.jsonc` 的 `vars`：

```bash
npx wrangler secret put TOKIMEKI_MASTER_TOKEN --config packages/relay/wrangler.jsonc
# 推荐：coturn REST 共享密钥（与 coturn static-auth-secret 相同）
npx wrangler secret put TOKIMEKI_COTURN_SECRET --config packages/relay/wrangler.jsonc
# 可选兜底：Cloudflare Realtime TURN；API token 用 secret，Key ID 可放 vars
npx wrangler secret put TOKIMEKI_TURN_API_TOKEN --config packages/relay/wrangler.jsonc
```

`TOKIMEKI_COTURN_URLS`、`TOKIMEKI_TURN_PROVIDER`、`TOKIMEKI_TURN_KEY_ID` 不是必须加密，
可放 `wrangler.jsonc` 的 `vars`；所有 `*_SECRET` / `*_TOKEN` 用 secret。

`wrangler.jsonc` 已声明 SessionDO binding 与 SQLite migration。Worker 的认证实现是
fail-closed：master token 未配置时，所有 host 认证都会被拒绝（不会变成“允许所有 host”）。
因此生产部署前必须设置该 secret。当前安装的 Wrangler 4.106.0 会忽略 `secrets.required`
字段（仅警告），所以这一约束靠运行时 fail-closed 与部署检查保证。

认证补充（2026-11-13 安全修复）：

- `TOKIMEKI_MASTER_TOKEN` 与 `TOKIMEKI_SESSION_TOKEN` 必须不同。host 配置和 Worker
  都会拒绝相等值；`tokimeki doctor` 会对相等值给出警告（不打印值）。
- 所有 WebSocket 连接必须携带非空 `X-Tokimeki-Session`；缺失或空值返回 HTTP 401。
- 每个会话的 OPEN socket 上限为 `TOKIMEKI_MAX_CLIENTS_PER_SESSION * 2`（含 pending），
  超限返回 HTTP 429；relay schema 只在该会话首次 host `hello` 时创建。

## 4. TURN / STUN（coturn 优先）

选路优先级：

```text
同 LAN host candidate 直连
  > 公网 P2P 直连
  > coturn TURN（REST 临时凭据，其次静态凭据）
  > Cloudflare Realtime TURN
  > STUN-only 直连尝试
  > Worker WebSocket relay（最终兜底）
```

“coturn 优先”是 Worker 侧的配置/选路优先级，不是自动部署 coturn。未配置 coturn 时
仍按 `TOKIMEKI_TURN_PROVIDER` 回退静态 TURN、Cloudflare TURN 或 Worker relay。
客户端的 `ice-refresh` provider 覆盖受 `TOKIMEKI_TURN_PROVIDER` 约束：`none` 只允许
`stun`，`coturn` 只允许 coturn/static/stun，`cloudflare` 只允许 Cloudflare/stun；
越权覆盖回退到 mode 默认。

### 4.1 推荐：自建 coturn

适用场景：中国大陆或受限网络、希望控制 TURN 链路与成本。可部署在大陆 VPS（需自行
评估 ICP/备案、运营商端口与合规要求）或香港/新加坡/日本 VPS（仍跨境，但可按实测
RTT/丢包选择）。

最小 `turnserver.conf` 示例：

```ini
listening-port=3478
# 443 空闲时可直接监听 443；否则用 5349，并通过端口转发/负载均衡暴露 443
tls-listening-port=443

# 只有公网 IP 经 EIP/1:1 NAT 映射、网卡上只有私网地址时才写 /<private>。
# 公网 IP 直接绑定网卡时写 external-ip=<public> 或整行省略；不要跨供应商复制。
external-ip=203.0.113.10/10.0.0.10

realm=turn.example.com
use-auth-secret
static-auth-secret=<long-random-secret>
fingerprint
stale-nonce=600

no-multicast-peers
# 防止 TURN 被用来访问内网/本机；按需补充 IPv6 范围
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=169.254.0.0-169.254.255.255

# relay UDP 端口范围；防火墙需放行
min-port=49152
max-port=65535

# TLS 证书（Let's Encrypt 示例）；turns: 需要公共 CA
cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem

# tokimeki 不需要 RFC 6062 TCP relay
no-tcp-relay
```

补充要求：

- 防火墙放行 `3478/udp`、`3478/tcp`、`443/tcp`（或实际 TLS 端口）与 relay UDP 端口范围。
- `static-auth-secret` 必须与 Worker secret `TOKIMEKI_COTURN_SECRET` 一致；使用长随机值，
  不要写进仓库或日志。
- 不要启用匿名 TURN；默认关闭 CLI，若启用需设置强密码并只绑定 `127.0.0.1`。
- 建议设置 `user-quota` / `total-quota`，并按流量监控出口带宽。
- 大陆公网部署的 ICP/备案与运营商要求由部署者确认；本文不构成法律意见。

Worker 侧：

```bash
npx wrangler secret put TOKIMEKI_COTURN_SECRET --config packages/relay/wrangler.jsonc
```

`wrangler.jsonc` 的 vars 示例（推荐数组写法）：

```jsonc
{
  "vars": {
    "TOKIMEKI_TURN_PROVIDER": "auto",
    "TOKIMEKI_COTURN_URLS": [
      "turns:turn.example.com:443?transport=tcp",
      "turn:turn.example.com:3478?transport=udp"
    ]
  }
}
```

旧的逗号分隔字符串仍然兼容：`.dev.vars`、测试 bindings 与旧部署配置无需改动，
`"turns:a:443?transport=tcp,turn:a:3478?transport=udp"` 与上面的数组等价。

当前生产使用（数组写法，包含 `cn.stun.tokiapi.app` 与 `stun.tokiapi.app` 共六条，
2026-11-13 随版本 `ee53cf15` 部署）：

```jsonc
"vars": {
  "TOKIMEKI_TURN_PROVIDER": "coturn",
  "TOKIMEKI_COTURN_URLS": [
    "turn:cn.stun.tokiapi.app:3478?transport=udp",
    "turn:cn.stun.tokiapi.app:3478?transport=tcp",
    "turns:cn.stun.tokiapi.app:5349?transport=tcp",
    "turn:stun.tokiapi.app:3478?transport=udp",
    "turn:stun.tokiapi.app:3478?transport=tcp",
    "turns:stun.tokiapi.app:5349?transport=tcp"
  ]
}
```

`stun.tokiapi.app`（Linode）曾因 `external-ip` 误用阿里云 EIP 的 1:1 NAT 私网映射
导致同机 relay-pair 失败；改为 `external-ip=172.233.139.100`、端口放宽到
`49150-49350` 并重启后，2026-11-13 复核 relay-pair 3/3、8 并发 allocation 8/8，
已满足门禁并加入生产列表。根因与证据见
`.trellis/tasks/11-13-production-rollout-key-rotation/research/dual-provider-turn-relay-pitfall.md`。

UDP URL 是 CLI 的必需项（libjuice 不支持 TURN TCP/TLS）；TCP 与 TLS URL 下发给
浏览器等客户端使用。

#### 多服务器：两台 coturn 均已启用

`cn.stun.tokiapi.app` 与 `stun.tokiapi.app` 均已通过 relay-pair 门禁并列入生产
`TOKIMEKI_COTURN_URLS`（版本 `ee53cf15`）。`stun.tokiapi.app` 的 Linode 主机公网 IP
直连 `eth0`，此前沿用阿里云 EIP 的
`external-ip=172.233.139.100/192.168.147.64` 导致同机 relay-pair 失败；修复为
`external-ip=172.233.139.100`、端口放宽并重启后，relay-pair 3/3、8 并发
allocation 8/8：

```jsonc
"TOKIMEKI_COTURN_URLS": [
  // cn.stun.tokiapi.app
  "turn:cn.stun.tokiapi.app:3478?transport=udp",
  "turn:cn.stun.tokiapi.app:3478?transport=tcp",
  "turns:cn.stun.tokiapi.app:5349?transport=tcp",
  // stun.tokiapi.app
  "turn:stun.tokiapi.app:3478?transport=udp",
  "turn:stun.tokiapi.app:3478?transport=tcp",
  "turns:stun.tokiapi.app:5349?transport=tcp"
]
```

启用前提与端口矩阵：

| 端口 | 用途 | 要求 |
|---|---|---|
| `3478/udp` | TURN UDP，CLI（libjuice）唯一支持的 TURN 传输 | 必需 |
| `3478/tcp` | TURN TCP，浏览器等客户端 | 建议 |
| `5349/tcp` | TURN over TLS，受限网络浏览器 | 建议 |
| `49150-49350/udp` | coturn relay 端口范围（当前生产 200 个端口） | 必需 |

- 当前两台节点均为 `min-port=49150`、`max-port=49350`；各 8 并发 allocation
  已验证 8/8，无 508。扩容时同步调整 coturn 与防火墙/安全组。
- 两台节点的 `static-auth-secret` 必须相同，列表内所有条目共用同一份 REST 临时凭据。
- 不要跨供应商复制 coturn 配置：先用 `ip -4 -br addr` / `ip route get <public-ip>`
  判断公网 IP 是否直连网卡。直连时用 `external-ip=<public>`，只有 1:1 NAT/EIP
  才写 `external-ip=<public>/<private>`；填错时控制面与外部 peer relay 都可能正常，
  只有同机 relay-pair 不通。
- 至少保留一条 `turn:...?transport=udp`，否则 CLI 无法使用 TURN。
- 列表条目在 Worker 侧会 trim、去重，并丢弃空项与非 `turn:`/`turns:` 项；空列表或全部
  条目非法等价于未配置 coturn，provider 选择回退到既有路径。
- 多条目会增加 TURN 候选与 ICE 探测流量，由 ICE 对服务器并行探测，不做地域选择。

Worker 会用 `TOKIMEKI_COTURN_SECRET` 生成 TURN REST 临时凭据：
`username=<expiry>:<clientId>`，`credential=base64(HMAC-SHA1(secret, username))`，
TTL 由 `TOKIMEKI_COTURN_TTL_SECONDS` 控制（默认 86400）。客户端只收到临时凭据。

### 4.2 Cloudflare Realtime TURN（验证完成，当前未启用）

2026-11-13 已在独立 session 完成 Cloudflare Realtime TURN 生产验证；当前生产
`TOKIMEKI_TURN_PROVIDER=coturn`。Cloudflare 配置保留为未启用的验证/回退路径：
`TOKIMEKI_TURN_KEY_ID`（vars）/ `TOKIMEKI_TURN_API_TOKEN`（secret），Worker 调用
`POST https://rtc.live.cloudflare.com/v1/turn/keys/{id}/credentials/generate-ice-servers`
签发短期 `iceServers`，TTL 默认 86400 秒、上限 172800 秒。验证时 provider=cloudflare、
100% 版本 `ee0e0f3c`，生产 TURN-only e2e `E2E PASS`；详见
`.trellis/tasks/11-13-production-rollout-key-rotation/research/cloudflare-turn-verification.md`。
把 `TOKIMEKI_TURN_PROVIDER` 改为 `cloudflare` 后重新部署即可重新启用。

官方限制（2026-11-12 文档）：

- **China Network 不参与 Realtime/TURN**；FAQ 明确 “TURN traffic from China will connect
  to Cloudflare locations outside of China”。大陆不是硬性不可用，但走境外节点，
  跨境时延/丢包不可保证。
- 支持 TURN over UDP/TCP/TLS；受限网络可尝试 `turns:...:443?transport=tcp`。
- 自定义域名只支持 UDP/TCP，不支持 TLS；不能靠自定义域名修复 `turn.cloudflare.com`
  的 TLS/域名阻断。
- 不支持 RFC 6062 TCP relay 与 IPv6 relay；终端 DataChannel 场景通常不受影响。

当前生产主动使用 coturn；Cloudflare TURN 配置与 secret 保留，可在 coturn 故障或
需要境外路径时切换。大陆流量按官方说明走境外节点，跨境时延/丢包不可保证，是否长期
作为主路径需结合实测决定。

### 4.3 静态 TURN（coturn 静态模式）

配置 `TOKIMEKI_TURN_URLS`、`TOKIMEKI_TURN_USERNAME`、`TOKIMEKI_TURN_CREDENTIAL`，
可指向 coturn 固定账号或其他自建 TURN。静态凭据长期有效，安全性低于 coturn REST；
它属于 coturn 层，在 provider 顺序上优先于 Cloudflare TURN，但仍低于 coturn REST。

### 4.4 Provider 选择

| 值 | 行为 |
|---|---|
| `auto`（默认） | coturn REST → 静态 TURN（coturn 静态模式）→ Cloudflare → STUN-only |
| `coturn` | coturn REST → 静态 TURN；两者都不可用时回退 relay，不静默切 Cloudflare |
| `cloudflare` | 只走 Cloudflare TURN |
| `none` | 关闭 TURN，只保留 STUN 直连尝试与 Worker relay |

STUN 默认 `stun:stun.cloudflare.com:3478`，可用 `TOKIMEKI_STUN_URLS` 覆盖。

已实现：coturn REST HMAC-SHA1 临时凭据、静态 TURN、Cloudflare Realtime TURN 凭据缓存
（SQLite，跨 DO 休眠，过期前 5 分钟刷新）、`ice-refresh` provider 切换、STUN-only 回退；
客户端会把 ICE URL 转成 node-datachannel 的 STUN/TURN 配置，并支持
`TOKIMEKI_ICE_TRANSPORT_POLICY=all|relay`。

已验证：provider 选择顺序、coturn REST HMAC、ICE URL/凭据转换、`relay` 策略解析均有单元测试；
本机 live e2e 覆盖 P2P 数据面、relay-only 与“强制 TURN 但无 TURN 可用 → 12 秒超时回退 relay”。

已验证（2026-11-13）：自建 coturn 的 UDP/TCP/TLS allocation、REST 凭据与数据中继；
本地与生产 Worker TURN-only e2e 均通过（CLI 走 UDP，`p2p-turn`）。Cloudflare Realtime
TURN 已配置 Key ID + API Token secret，并在生产 TURN-only e2e 中确认
`P2P transports: p2p-turn, relay->relay`；CLI 的 libjuice 不支持 TURN TCP/TLS。

## 5. 部署

开源一键部署使用仓库根 `wrangler.jsonc`（见 `docs/deploy-cloudflare.md`）；
生产维护者使用 relay 配置和自定义域名：

```bash
npm run deploy:prod
# 等价于：npm run build && npx wrangler deploy --config packages/relay/wrangler.jsonc
```

`wrangler.jsonc` 已声明生产自定义域名：

```jsonc
"routes": [
  { "pattern": "relay.tokiapi.app", "custom_domain": true }
]
```

配置了 routes 时 Wrangler 不再为本次部署启用 `workers.dev`；本次部署输出只列出
`relay.tokiapi.app (custom domain)`。客户端统一使用：

```bash
export TOKIMEKI_RELAY_URL=wss://relay.tokiapi.app
```

部署后检查：

```bash
curl -sS https://relay.tokiapi.app/healthz
# {"ok":true,"service":"tokimeki-relay","protocolVersion":1,
#  "turnProvider":"coturn","turnConfigured":true}
```

**当前部署状态（2026-11-16）**：

- Worker `tokimeki-relay` 已部署，URL `https://relay.tokiapi.app`。当前 100% 流量版本
  `1104916c-f188-4cc5-8df6-e34ca557ffae`（2026-11-16 发布，含 v1.1 F2 只读
  listener 角色）。上一版本 `ee53cf15-2acb-45a7-b08f-dd67d70e06d6`
  （2026-11-13，含 host relay 重连修复）可作为回滚参考；更早的
  `ee0e0f3c-9f99-4647-9604-91e2abddc20e`（Cloudflare 验证配置）与
  `da0dde29-66e0-425e-85c0-49d053316186` 也保留。secret 不回滚。
- 2026-11-16 的发布为纯代码部署（`npm run deploy:prod`），**未轮换**
  `TOKIMEKI_MASTER_TOKEN`；生产 token 继续保存在仓库外受控位置，不写入仓库、日志或
  命令历史。
- 2026-11-16 使用 npmjs `@limccn/tokimeki@0.1.1` 对该版本复跑生产 e2e：
  relay-only、P2P、listener、TUN+XOR FEC、shared-secret 通过；流控 `pause` 在
  30 秒内未观察到（见 §7.3 与已知跨境限制）。
- `TOKIMEKI_MASTER_TOKEN`、`TOKIMEKI_COTURN_SECRET`、`TOKIMEKI_TURN_API_TOKEN` 为生产
  secret，均已上传；生产 token 保存在仓库外的受控位置，不写入仓库、日志或命令历史。
  2026-11-13 通过 `wrangler secret put`（stdin）轮换了 `TOKIMEKI_COTURN_SECRET`，两台
  coturn 均已只接受新 secret，旧 secret 的 REST 凭据返回 401。
- 当前 `TOKIMEKI_TURN_PROVIDER=coturn`；`TOKIMEKI_COTURN_URLS` 为 cn/stun 两台共六条；
  `TOKIMEKI_TURN_KEY_ID` 保留但未启用。`/healthz` 报告 `turnProvider:"coturn"`、
  `turnConfigured:true`。
- 本机到 `*.workers.dev` 的 DNS 被污染且 TLS SNI 被重置，直接 `workers.dev` 不可达；
  自定义域名 `relay.tokiapi.app` 可正常完成 TLS/WebSocket 握手。跨境链路仍有约 40%
  的间歇性 TLS/HTTP 停顿和 30 秒级短时中断，生产 live e2e 可能因此重试或需要重跑。
- 生产 P2P live e2e 与六条 coturn URL 的 TURN-only e2e 均已完整通过（`E2E PASS`）；
  Cloudflare TURN 验证路径也通过；生产流控场景的验证结果见 §7.3。

本地开发：

```bash
npm run dev:relay
```

本地 `wrangler dev` 的 DO 始终本地模拟且不会真正休眠/逐出；休眠、TTL alarm 与
生产 WebSocket 行为必须部署到 staging/生产后验证。

本地 live e2e 使用 `wrangler dev`（`ws://127.0.0.1:8787`）与 `.dev.vars` 中的开发令牌完成；
开发令牌不是生产密钥。

## 6. 客户端环境变量示例

所有配置走环境变量，模板见仓库根 `.env.example`。

Host（托管终端）：

```bash
export TOKIMEKI_RELAY_URL=wss://relay.tokiapi.app
export TOKIMEKI_MASTER_TOKEN='<master token>'
export TOKIMEKI_SESSION=proj-a
export TOKIMEKI_TERM=xterm-256color
export TOKIMEKI_COLORTERM=truecolor
export TOKIMEKI_RESIZE_POLICY=latest
export TOKIMEKI_P2P=auto
export TOKIMEKI_ICE_TRANSPORT_POLICY=all

npx @limccn/tokimeki claude
```

Attach（远程接入，使用同一会话令牌）：

```bash
export TOKIMEKI_RELAY_URL=wss://relay.tokiapi.app
export TOKIMEKI_SESSION=proj-a
export TOKIMEKI_SESSION_TOKEN='<session token printed by the host>'
export TOKIMEKI_P2P=auto
export TOKIMEKI_ICE_TRANSPORT_POLICY=all

npx @limccn/tokimeki attach
```

TURN provider 由 Worker 选择，客户端从 `welcome` / `ice` 获取 `iceServers`；客户端
不需要配置 coturn 地址或共享密钥。测试 TURN 路径时可设
`TOKIMEKI_ICE_TRANSPORT_POLICY=relay` 强制走 TURN（仍需 Worker 已配置可用 provider）。

令牌只放在 `X-Tokimeki-Master` / `X-Tokimeki-Session` header，不要放进 URL query。
日志与错误信息不得回显令牌。Host 启动 PTY 时会从子进程环境中剔除
`TOKIMEKI_MASTER_TOKEN`、`TOKIMEKI_SESSION_TOKEN`、`TOKIMEKI_TUNNEL_SECRET`、
`TOKIMEKI_COTURN_SECRET`、`TOKIMEKI_TURN_API_TOKEN`、`TOKIMEKI_TURN_CREDENTIAL`，
避免共享终端的 viewer 通过 `env`/`printenv` 读取接入凭据。Windows 上按大小写不敏感
匹配并删除所有变体（例如 `Tokimeki_Master_Token`）；POSIX 只删除规范大写名，保留
用户自己的小写变量。`TOKIMEKI_MASTER_TOKEN` 与 `TOKIMEKI_SESSION_TOKEN` 必须不同。

`tokimeki doctor` 会检查 PTY、配置与 `/healthz` 连通性；缺失必需环境变量时 CLI 会在启动
PTY 前给出可操作错误。TLS 代理场景请确认 `TOKIMEKI_RELAY_URL` 使用 `wss://`/`https://`；
本机回环测试可用 `ws://`/`http://`。

## 7. 验收证据与未验证项

### 7.1 本机自动化检查（2026-11-12）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run lint` | 退出码 0（仅 warning/info） |
| `npm test` | 219 tests / 13 files 通过 |
| `npm run test:relay` | 51 tests / 4 files 通过 |
| `npm run build` | 通过 |
| `npx wrangler deploy --dry-run --config packages/relay/wrangler.jsonc` | 通过 |
| `npx wrangler deploy --config packages/relay/wrangler.jsonc` | 成功，版本 `d28ef19e-b213-4474-8d3f-d32f67a4ff55` |
| 启用 coturn 后 `npx wrangler deploy --config packages/relay/wrangler.jsonc` | 成功，版本 `da0dde29-66e0-425e-85c0-49d053316186` |
| 2026-11-13 host 重连修复 + TURN secret 轮换 + cn URL 列表 | 成功，版本 `293d1eba-6359-4166-b7f5-50a45f57bf5b` |
| 2026-11-13 Cloudflare TURN API Token secret + provider=cloudflare | 成功，100% 版本 `ee0e0f3c-9f99-4647-9604-91e2abddc20e`（Secret Change） |
| 2026-11-13 六条 coturn URL 配置 `--dry-run`（provider=cloudflare，不生效） | 通过 |
| 2026-11-13 切回 provider=coturn 后六条 URL `--dry-run` | 通过 |
| 2026-11-13 切回 coturn + 六条 URL 生产发布 | 成功，版本 `ee53cf15-2acb-45a7-b08f-dd67d70e06d6` |
| 2026-11-16 v1.1 F2 listener relay 代码发布 | 成功，100% 版本 `1104916c-f188-4cc5-8df6-e34ca557ffae` |

> 2026-11-13 host 重连修复后：`npm test` 13 files / 219 tests、`npm run test:relay`
> 5 files / 60 tests（含 4 条 host 重连回归）、`npm run typecheck` 均通过；新增 host
> 重连 e2e 见 §7.2 第 5 组。生产发布前重新执行 `npm run build` 与
> `npm run test:relay`（60/60）通过。

### 7.2 本机 live e2e（`wrangler dev` + fake TUI）

脚本：`scripts/e2e/live-e2e.mjs`；CLI 构建产物 `packages/cli/dist/index.js`。
以下场景均通过（`E2E PASS`）：

```bash
# 1) P2P required：验证 P2P 数据面承载 host 输出与 viewer 输入
REQUIRE_P2P=1 E2E_P2P_MODE=auto E2E_ICE_POLICY=all \
  TOKIMEKI_RELAY_URL=ws://127.0.0.1:8787 TOKIMEKI_MASTER_TOKEN=<dev> \
  node scripts/e2e/live-e2e.mjs

# 2) relay-only：确认禁用 P2P 时没有任何 P2P 活动
E2E_P2P_MODE=off TOKIMEKI_RELAY_URL=ws://127.0.0.1:8787 \
  TOKIMEKI_MASTER_TOKEN=<dev> node scripts/e2e/live-e2e.mjs

# 3) 强制 TURN、无 TURN 可用：验证超时回退 relay
E2E_ICE_POLICY=relay REQUIRE_P2P_FALLBACK=1 \
  TOKIMEKI_RELAY_URL=ws://127.0.0.1:8787 TOKIMEKI_MASTER_TOKEN=<dev> \
  node scripts/e2e/live-e2e.mjs

# 4) relay 背压 + PTY 凭据隔离：暂停一个 viewer 的 stdout，触发 1 MiB
#    未确认水位与 host pause，再恢复并验证 ACK 解除背压、4 MiB burst 完成
E2E_P2P_MODE=off E2E_FLOW_CONTROL=1 E2E_SECRET_CHECK=1 \
  TOKIMEKI_RELAY_URL=ws://127.0.0.1:8787 TOKIMEKI_MASTER_TOKEN=<dev> \
  node scripts/e2e/live-e2e.mjs

# 5) host 瞬时 1006 重连：host 经本地 TCP blackhole 代理连接 relay；
#    丢弃客户端侧连接但保留上游 TCP，精确复现 DO 仍认为旧 host socket OPEN
TOKIMEKI_RELAY_URL=ws://127.0.0.1:8787 TOKIMEKI_MASTER_TOKEN=<dev> \
  node scripts/e2e/host-relay-reconnect.mjs
```

覆盖断言：错误 session token 被拒绝；host PTY 启动；两个 attach 获得初始快照；
双向输入与广播；resize 传播；P2P 输出/输入数据面；断线重连快照恢复历史输出；
Ctrl-C 传播到 PTY；host 退出。第 4 组额外断言：viewer stdout 停止排空后 host 收到
relay `pause`，恢复排空后收到 `resume`，4 MiB PTY burst 的结束标记到达两个 viewer；
host PTY 子进程环境看不到 master/session/tunnel/coturn/TURN API/TURN credential 六个
secret 名称，而非 secret 的 `TOKIMEKI_RELAY_URL` 仍保留。流控日志只包含 viewer
clientId，不包含 token 或凭据。日志与脚本输出不回显 token/TURN credential。
第 5 组断言：host 观察到 close 1006、第二次 `relay ready:`、日志无
`duplicate_client_id`；viewer 在 host 重连后继续输入并收到回显；Ctrl-C 后 host 与
viewer 均 exit 0。该脚本只销毁客户端侧 TCP、保留代理到 relay 的上游连接，因此旧
WebSocket 在 DO 视角仍是 OPEN，覆盖的正是生产故障的陈旧 attachment 条件。

2026-11-13 最终代码复跑（工作树含 host 重连修复、Cloudflare/coturn 配置）：

- `npm run test:relay`：5 files / 60 tests 通过。
- 第 1–4 组 live e2e：全部 `E2E PASS`（第 1 组 P2P transport 建立；第 2 组 relay-only；
  第 3 组 12s 超时回退；第 4 组 pause → resume → 4 MiB burst 完成，secret 隔离断言通过）。
- 第 5 组 host 重连：`RECONNECT_PASS`、`E2E PASS`。
- `scripts/e2e/relay-smoke.mjs`（本机）：`RELAY SMOKE PASS`。
- `scripts/e2e/p2p-probe.mjs`：`pair local=host remote=host`，退出 0。
- `scripts/e2e/host-under-pty.mjs` + `scripts/e2e/remote-attach.mjs`（host 与 viewer
  均在 PTY 中，本机 relay 8788）：`REMOTE_PASS`，host `PTY exited (code=0)`。attach
  辅助脚本在打印 PASS 后未自行退出，测试驱动以 kill 清理；断言已在退出前完成。

流控场景曾暴露一个恢复缺陷：暂停中的 viewer 的 `SNAPSHOT_TO` 也走普通输出的丢帧分支。
当 host 在暂停期间结束整段输出时，viewer 的 `resync` 快照被丢弃，之后没有新 `OUTPUT`
再次触发 `resync`，viewer 永久卡在 gap，burst 结束标记永远不到达。修复后
`SNAPSHOT_TO` 穿透暂停门（仍计入未确认字节和 8 MiB 硬上限），其 ACK 通过正常低水位
路径解除暂停；新增 relay 单测 `delivers a recovery snapshot while the viewer is paused`
回归该路径。修复后本机流控 e2e 通过。

host 退出链路由 relay 接受 host 发来的 `host-exited`，持久化到 `session_lifecycle` 并
广播给 viewer（viewer 伪造会被 `invalid_role` 拒绝）。host 退出后才连接/重连的 viewer
在 `welcome` 后立即收到持久化重放；新 host 上线清除旧标记。单测
`replays host-exited to a viewer that joins after the host exit` 覆盖该重放；live e2e
允许半开连接在心跳超时后重连并在 60 秒内收到退出事件。attach 在 P2P 活动时延迟 300 ms
退出，给 DataChannel 上最后一段 PTY 输出留出排空时间。

2026-11-17 v0.1.2 本地 e2e 扩展（`scripts/e2e/live-e2e.mjs`）：

- `E2E_WINDOW=1`：host 使用 `TOKIMEKI_WINDOW=on` +
  `TOKIMEKI_WINDOW_SIZE=100x30`，两个不同尺寸 viewer（80x24 / 120x40）。
  断言 host PTY 始终为 100x30、viewer resize 不触发 host resize、viewer 状态栏
  `view:80x15@...` / `view:fit`、debug 日志面板、光标跟随裁剪、鼠标坐标映射
  到逻辑网格、F12 overlay（打开、`c` 走 OSC 52、按键被消费、Esc 关闭）以及
  断线重连快照。`E2E_INVITE=0` 跳过 overlay。
- `E2E_CONFIG=1`（可与 `E2E_WINDOW=1` 组合）：host 仅从 `TOKIMEKI_CONFIG`
  JSON 读取 relay/session/token/window；显式 `TOKIMEKI_SESSION` 覆盖 JSON；
  断言 hosted PTY 看不到 `TOKIMEKI_CONFIG` 与 secret，viewer 连到显式 session。
- `E2E_TUNNEL_BURST=1`：TUN 数据面 4 MiB burst，两个 viewer 均收到
  `BURST_DONE=4194304`。
- `E2E_TUNNEL_MISMATCH=1` 配合 `E2E_TUNNEL_SECRET_HOST` /
  `E2E_TUNNEL_SECRET_VIEWER`：host/viewer 密钥不一致，要求 fallback 到 relay
  且输入仍回显。
- 回归：legacy relay-only、P2P required、listener、flow-control + secret
  check、tunnel session-token / XOR / shared-secret 全部 `E2E PASS`。
- 失败诊断现在会脱敏 session/master token 与 viewer-config base64；F12/config
  用例不会把 token 写入日志。

### 7.3 生产 live e2e（`wss://relay.tokiapi.app`）

在最终版本 `d28ef19e-b213-4474-8d3f-d32f67a4ff55` 上执行：

```bash
TOKIMEKI_RELAY_URL=wss://relay.tokiapi.app REQUIRE_P2P=1 E2E_TIMEOUT_MS=120000 \
  TOKIMEKI_MASTER_TOKEN=<production> node scripts/e2e/live-e2e.mjs
```

结果：`E2E PASS`，13 条断言全部通过，包括 host 注册、错误 session token 拒绝、
初始快照、双向输入/广播、resize、P2P 数据面承载 host 输出与 viewer 输入、重连快照、
Ctrl-C 生命周期和干净退出。生产 master token 未出现在日志或脚本输出中。

生产 TURN-only e2e（2026-11-13，版本 `da0dde29`）：

```bash
TOKIMEKI_RELAY_URL=wss://relay.tokiapi.app REQUIRE_P2P=1 E2E_ICE_POLICY=relay \
  E2E_TIMEOUT_MS=180000 TOKIMEKI_MASTER_TOKEN=<production> \
  node scripts/e2e/live-e2e.mjs
```

结果：`E2E PASS`；host 日志 `ice provider: coturn (servers=4)`，3 个 viewer 均为
`p2p data channel open ... (p2p-turn, relay->relay)`。当前 CLI 的 libjuice 只支持
TURN UDP，因此该 `p2p-turn` 来自 `turn:stun.tokiapi.app:3478?transport=udp`。
当时 `stun.tokiapi.app` 仍解析到 `47.100.80.185`；DNS 迁移后该名称指向
`172.233.139.100`，生产 URL 已改为 `cn.stun.tokiapi.app`（见 §4.1）。`turn:?transport=tcp`
与 `turns:` 5349 下发给浏览器等客户端。secret 轮换与 relay 端口扩容由
`11-13-production-rollout-key-rotation` 跟进。

2026-11-13 secret 轮换后的生产 TURN-only e2e（版本
`293d1eba-6359-4166-b7f5-50a45f57bf5b`，生产 URL 仅
`cn.stun.tokiapi.app`）：

```bash
TOKIMEKI_RELAY_URL=wss://relay.tokiapi.app REQUIRE_P2P=1 E2E_ICE_POLICY=relay \
  E2E_TIMEOUT_MS=120000 TOKIMEKI_MASTER_TOKEN=<production> \
  node scripts/e2e/live-e2e.mjs
```

结果：`E2E PASS`，13 条断言全部通过。`E2E_ICE_POLICY=relay` 禁用 host/srflx 候选，
`REQUIRE_P2P=1` 要求 P2P 数据面承载 host 输出与 viewer 输入，因此该路径必然是
`p2p-turn`（CLI 只支持 TURN UDP allocation）。本次首次在 `wrangler deploy` 后立即
运行时，遇到 Cloudflare 版本切换期的 relay 心跳重连与 P2P 切换冻结（首条输入未回显）；
部署稳定后重跑 `E2E PASS`，未再复现。两次运行均未出现 TURN 401/508。该版本的
生产 URL 仅 cn 三条；六条 URL 于 `ee53cf15` 部署后已重跑（见下）。

2026-11-13 Cloudflare Realtime TURN 生产 TURN-only e2e（验证版本 `ee0e0f3c`，
provider=cloudflare）：

```bash
TOKIMEKI_RELAY_URL=wss://relay.tokiapi.app REQUIRE_P2P=1 E2E_ICE_POLICY=relay \
  E2E_TIMEOUT_MS=120000 TOKIMEKI_MASTER_TOKEN=<production> \
  node scripts/e2e/live-e2e.mjs
```

结果：`E2E PASS`，13 条断言全部通过；新增的 transport 证据输出
`P2P transports: p2p-turn, relay->relay`，证明两个 viewer 均使用 TURN relay candidate。
`/healthz` 报告 `turnProvider:"cloudflare"`、`turnConfigured:true`。Cloudflare TURN
API Token 只存在于 Worker secret，未进入日志、脚本输出或仓库。验证完成后生产已切回
coturn。

2026-11-13 六条 coturn URL 生产 TURN-only e2e（当前版本 `ee53cf15`，
provider=coturn）：

```bash
TOKIMEKI_RELAY_URL=wss://relay.tokiapi.app REQUIRE_P2P=1 E2E_ICE_POLICY=relay \
  E2E_TIMEOUT_MS=180000 TOKIMEKI_MASTER_TOKEN=<production> \
  node scripts/e2e/live-e2e.mjs
```

结果：`E2E PASS`，13 条断言全部通过；`P2P transports: p2p-turn, relay->relay`。
`/healthz` 报告 `turnProvider:"coturn"`、`turnConfigured:true`。部署后等待约 20 秒
让版本切换稳定再运行；未出现 TURN 401/508；输出未包含 master token。

生产 host 替换冒烟（同 clientId、同 session token 的两个 host）：

```bash
TOKIMEKI_RELAY_URL=wss://relay.tokiapi.app \
  TOKIMEKI_MASTER_TOKEN=<production> node scripts/e2e/host-replace-smoke.mjs
```

结果：`REPLACE_SMOKE_PASS`。第二个 host 收到 `welcome`（`hostOnline=true`，客户端列表
不含被替换的 host）；第一个 host 收到 `duplicate_client_id` 并以 4003 关闭。该冒烟
证明生产 DO 已运行鉴权后的 host 替换逻辑；它不模拟 1006 陈旧 socket，后者由
§7.2 第 5 组的真实 TCP blackhole 复现覆盖。

2026-11-13 在生产版本 `ee53cf15` 上的其他 e2e：

- 生产 P2P live e2e（`REQUIRE_P2P=1`）复跑两次：
  - 第一次通过 handshake/auth/初始快照/输入/广播/resize，`P2P transports:
    p2p-direct, host->prflx`，P2P 数据面通过；随后 attach3 重连等待
    `ECHO:reconnect-e2e` 超时。host 日志有 `relay heartbeat missed for 31s`、重连和
    `p2p unavailable ... data channel closed`。
  - 第二次更早停在 `SIZE=100x30`，host 日志同样出现 31s 心跳中断。
  - 两次失败点不同且都伴随 relay 心跳中断，属于跨境链路 30 秒级停顿；生产 P2P
    live e2e 暂不作为稳定通过证据，本机同场景确定性通过。
- 生产 `relay-smoke.mjs`：`RELAY SMOKE PASS`（bad token 拒绝、welcome、broadcast、
  SNAPSHOT_TO、ping/pong）。
- 生产 PTY 托管（本机 `host-under-pty.mjs` + `remote-attach.mjs`，经
  `wss://relay.tokiapi.app`）：`REMOTE_PASS`；host 日志 `p2p-direct, host->prflx`、
  `p2p input received over data channel`、`PTY exited (code=0)`。
- 生产 viewer 断开重连（`TOKIMEKI_P2P=off`，同一 PTY 主机）：
  - 首跑第一个 attach 的 WS 握手在 90 秒内未完成，被测试包装器终止，未进入
    detach 步骤；第二个 attach `REMOTE_PASS`，Ctrl-C 后 host exit 0。
  - 复跑第一个 attach 通过初始快照/输入/resize/TICK 后 `REMOTE_DETACH`，host
    保持运行（`viewer left`，PTY 未退出）；第二个 attach 同样通过上述断言并发送
    Ctrl-C，host 日志 `PTY exited (code=0)`。但该 viewer 的 relay 连接期间出现
    `Opening handshake has timed out` 和 1006 重连，60 秒内未收到 `host exited`，
    `REMOTE_FAIL: timed out waiting for "host exited"`。
  - 结论：断开后重连的数据面（快照/输入/resize/实时输出）与 Ctrl-C 传播通过；
    退出事件回放被跨境握手停顿阻断，未取得确定性通过证据。
- 生产 host 替换冒烟：前两次 `host-1: open timeout`（WS 握手受跨境停顿影响）；
  将 open 超时改为可配置（`REPLACE_OPEN_TIMEOUT_MS`）后重跑 `REPLACE_SMOKE_PASS`。

生产流控场景（`E2E_P2P_MODE=off E2E_FLOW_CONTROL=1 E2E_SECRET_CHECK=1`）此前两次
未通过，失败点都在环境相关的前置断言；2026-11-13 第三次复跑：

1. 首跑在错误 token 检查阶段遇到跨境握手超时：bad-attach 反复出现
   `Opening handshake has timed out`，60 秒内没有完成 `unauthorized` 断言。
2. 第二次完成了 host/两个 viewer、初始快照、输入、广播、resize，但 30 秒内没有观察到
   relay `pause`。跨境上行带宽/延迟改变了 host 发送、relay 水位与 viewer 排空的先后
   关系；该断言依赖 4 MiB burst 在 30 秒内把 relay 的 per-viewer 未确认字节推过 1 MiB。
3. 第三次通过了错误 token 拒绝、host/两个 viewer、初始快照、输入/广播、resize、
   secret 隔离，并观察到 `relay flow control pause`；两个 viewer 都被 pause。恢复
   attach1 排空后 30 秒内未等到 `relay flow control resume`，4 MiB burst 未完成。
   dump 显示两个 viewer 各只收到约 0.5–0.7 MiB，属于跨境带宽不足，未能在 30 秒内
   把 per-viewer 未确认字节降到低水位以下。

本地 loopback 流控场景（真实 TCP/WebSocket/PTY）在最终代码上确定性通过，覆盖
pause → resume → 4 MiB burst 结束标记到达两个 viewer。生产流控断言不作为 v1 通过
条件，待更稳定的跨境链路或双机环境补测。

已知网络限制：本机到 `*.workers.dev` 的 DNS 被污染且 TLS SNI 被重置，无法直接使用
workers.dev；自定义域名 `relay.tokiapi.app` 可达，但跨境链路存在约 40% 的间歇性
TLS/HTTP 停顿和 30 秒级中断，生产 e2e 可能需要重跑。

2026-11-16 生产 live e2e（npmjs `@limccn/tokimeki@0.1.1`，relay 版本
`1104916c`）：

验证目标是用已发布的 npm 包（不是本地 `packages/cli/dist`）跑生产链路，并确认
新部署的 listener 角色。安装到干净临时目录：

```bash
npm install --prefix <tmp> @limccn/tokimeki@0.1.1 \
  --@limccn:registry=https://registry.npmjs.org
export E2E_CLI_ENTRY=<tmp>/node_modules/@limccn/tokimeki/dist/index.js
```

结果：

- relay-only（`E2E_P2P_MODE=off`）：`E2E PASS`。
- P2P required（`REQUIRE_P2P=1 E2E_P2P_MODE=auto`）：`E2E PASS`，
  `P2P transports: p2p-direct, host->prflx, lan=yes`。
- listener（`E2E_LISTENER=1 E2E_P2P_MODE=off`）：`E2E PASS`；立即/周期快照、
  listener 输入被忽略、host exit 到达 listener。
- TUN + XOR FEC（`E2E_TUNNEL=1 E2E_TUNNEL_FEC=xor`）：`E2E PASS`；
  `keyMode=session-token`、`fec=xor`，TUN 数据面承载 host 输出与 viewer 输入。
- TUN shared-secret（`E2E_TUNNEL=1 E2E_TUNNEL_SECRET=<dummy>`）：`E2E PASS`；
  `keyMode=shared-secret`（relay 不能推导密钥）。
- 流控（`E2E_P2P_MODE=off E2E_FLOW_CONTROL=1 E2E_SECRET_CHECK=1`）：未通过。
  错误 token、初始快照、输入/广播、resize、secret 隔离均通过；暂停 attach1
  stdout 后 30 秒内未观察到 relay `pause`。与 2026-11-13 第二次生产尝试相同，
  属于跨境时序/带宽导致的已知限制（本地 loopback 确定性通过）。
- host 重连脚本只接受 `ws://`，生产 `wss://` 不适用；由 §7.2 第 5 组覆盖。

本次同时修复了 harness 的 PTY 重排误判：生产 80 列重排会把
`keyMode=session-token` / `p2p input received over data channel` 拆行并插入
cursor-position 码。`live-e2e.mjs` 现对隧道日志做 ANSI/空白归一化后再断言；
`E2E_CLI_ENTRY` 也支持 `scripts/e2e/host-relay-reconnect.mjs`。

### 7.4 跨机器生产验收（2026-11-13）

拓扑：本机 Windows（大陆 NAT）↔ 日本/美国临时测试 VPS（公网 IP，验收后销毁）；
Worker `wss://relay.tokiapi.app`，coturn `turn:stun.tokiapi.app:3478`（REST 临时
凭据）。详细时间线与脱敏日志见任务 `11-13-cross-nat-turn-validation` 的
`research/cross-nat-turn-acceptance.md`。

| 场景 | 结果 |
|---|---|
| 本机 host ↔ 日本 viewer，P2P auto | `p2p-direct (srflx->host)`；双向输入/输出、resize、Ctrl-C 通过 |
| 本机 host ↔ 日本 viewer，P2P off | 纯 relay；`REMOTE_PASS`，host `PTY exited (code=0)` |
| 本机 host ↔ 日本 viewer，forced TURN | `p2p-turn (relay->relay)`；coturn UDP allocation |
| 本机 host ↔ 美国 viewer，coturn 不可达 | join 后 12.002s ICE 超时，12.018s `using relay`；viewer 无感，host exit 0 |
| 日本 viewer 断开后重连 | host 保持运行，第二个 viewer `REMOTE_PASS`，Ctrl-C 后 host exit 0 |
| host relay 1006 后重连 | 原始验收**失败**：`duplicate_client_id` → `HOST_EXIT=1`；源码已修复并通过本机确定性复测（§7.2 第 5 组），2026-11-13 已部署到生产（`293d1eba`），生产 host 替换冒烟通过（§7.3）；跨机器 1006 复测因测试 VPS 已销毁未重做 |

限制：美国 VPS 到 coturn 的 3478/5349/443 均不可达（环境限制，正好验证回退）；
跨公网 3-viewer 未执行；严格 NAT↔NAT 已于 2026-11-16 由维护者人工 e2e 确认
（见 §7.6）；Cloudflare TURN 已于同日单独验证（§7.3）。生产流控断言仍受跨境
链路影响，见上文。

### 7.5 未验证项

> 已由维护者人工 e2e 确认的项见 §7.6；本节保留仍未验证或仅部分验证的项。

- **Cloudflare 边缘 hibernation/TTL alarm**：本地 `wrangler dev` 不模拟真实休眠；
  生产部署已运行，但尚未做长时间休眠/驱逐观测。
- **生产 P2P live e2e 稳定性**：2026-11-13 在 `ee53cf15` 复跑两次均因跨境 relay
  心跳中断（31s）在不同断言处失败；P2P 直连与生产 PTY 路径本身已验证。需在稳定
  链路或双机环境复跑。
- **coturn**：已实测（2026-11-13）UDP/TCP/TLS allocation、REST 凭据与数据中继；生产
  TURN-only e2e 通过（UDP，`p2p-turn`）。CLI 的 libjuice 不支持 TURN TCP/TLS，`turns:`
  仅供浏览器等客户端。
- **Cloudflare TURN**：2026-11-13 已配置 TURN Key ID + API Token secret 并完成生产
  验证（provider=cloudflare，TURN-only e2e `P2P transports: p2p-turn, relay->relay`）；
  验证后生产已切回 coturn，Cloudflare 配置保留但未启用。大陆流量按官方说明走境外
  节点，跨境时延/丢包仍是风险；CLI 仍只支持 UDP（`turns:` 仅供浏览器等客户端）。
- **跨 NAT/跨机器**：2026-11-13 已完成本机 NAT ↔ 日本/美国公网 VPS 的 relay、
  直连 P2P、coturn TURN 与 TURN 不可达回退验收（见 §7.4）。严格 NAT↔NAT 已于
  2026-11-16 由维护者人工 e2e 确认（见 §7.6）；跨公网 3-viewer 仍未执行。host
  瞬时断线重连已在源码修复、通过本机真实 TCP 断线复测（§7.2 第 5 组）并部署到
  生产（`293d1eba`），生产 host 替换冒烟通过（§7.3）；跨机器 1006 复测因测试
  VPS 已销毁仍未重做。生产流控场景仍受跨境链路影响未通过，需在稳定链路或双机
  环境补测。生产 viewer 断开重连场景中，重连数据面与 Ctrl-C 传播通过，但
  `host exited` 回放因跨境握手停顿未在断言窗口内到达（§7.3）。
- **P2P 直连成功率/长期稳定性**：2026-11-16 的人工 e2e 只确认严格 NAT↔NAT
  场景可达（含 P2P 尝试与 relay 回退），未建立直连成功率或长时间稳定性基线。
- **同 LAN host candidate 直连**：需要两台同 LAN 机器，未在本机验证。
- **Linux/ConPTY 差异**：本机仅 Windows ConPTY；Linux 手动验证未执行。

### 7.6 人工 e2e 确认（2026-11-16）

维护者人工确认以下场景已通过 **e2e 层面** 验收；本仓库未保存对应的环境、命令或
原始日志：

- **严格 NAT↔NAT**：两端均位于 NAT/CGNAT 后的连接场景（含 P2P 尝试与 relay
  回退）；未单独拆出 P2P 直连成功率和长期稳定性。
- **真实 Claude/pi TUI**：真实 TUI 通过 tokimeki 托管与 attach 交互。

范围说明：这是 e2e 层面的人工确认，不等同于长期运行、生产边缘 hibernation/TTL、
P2P 直连成功率、所有 TUI 交互路径、跨平台或性能验收。自动化 live e2e 仍使用
fake TUI；上述确认不改变 §7.5 中仍未验证的项。
