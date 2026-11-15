# 够级游戏服务器

Bun + WebSocket 的权威牌桌服务器。服务器拥有全部对局状态，只向每位玩家发送他自己的手牌；客户端的任何断言都不被信任，出牌先由服务器按规则校验。

## 运行

```bash
cd demos/gouji-game/server
bun install --frozen-lockfile
cp .env.example .env   # 填入真实配置（见下）
bun run start          # 或 bun run dev（监听文件变化）
```

默认端口 `8787`，健康检查：`GET /health`，信息：`GET /`。

## 配置（环境变量）

| 变量 | 说明 |
| --- | --- |
| `PORT` | 监听端口，默认 `8787` |
| `COMMUNITY_ISSUER` | 社区地址（含 /forum 子目录，如有）。留空则进入开发模式 |
| `APP_ID` | 社区应用页上的应用 ID（与 manifest 一致） |
| `SERVER_ORIGIN` | 本服务器的公开 HTTPS 地址，即平台 JWT 的 audience，如 `https://api.example.com` |
| `CHANNEL` | `production` 或 `sandbox`，默认 `production` |
| `DEV_MODE` | `1` 接受未验证的本地连接；未配置 `COMMUNITY_ISSUER` 时默认开启 |

**开发模式**：未配置社区地址时，服务器接受未验证的本地连接，并在启动日志和每条连接通知里明确标注。开发模式只用于本地调试，绝不能公开暴露，也不能冒充生产安全。

**生产模式**：配置 `COMMUNITY_ISSUER` 后，每次 WebSocket 升级都会用社区 JWKS（`{issuer}/mini-app-api/jwks`，单把 ES256 P-256 公钥，缓存 1 小时，kid 未知时刷新一次）验证平台 JWT：`verifyPlatformWebSocketRequest({ issuer, audience, appId, channel, publicKey, url })`，并检查 `Origin` 与 issuer 同源。验证失败返回 401。

## 房间与对局流程

- 房间代码 6 位大写字母数字；首位加入者创建房间，可指定牌副与鹰牌规则。
- 座位 1–6 号，1、3、5 号为联邦 A，2、4、6 号为联邦 B；逆时针出牌。
- 人类玩家全部准备后，空座由机器人补满，自动发牌开局；1–5 人都能开局。
- 机器人每 650ms 走一步；革命阶段有 15 秒时限，到时未表态的人类视为不革命。
- 断线后用同一平台身份重连即可回到原座位；空闲 10 分钟的无连接房间会被回收。
- 每秒最多 30 条消息，超限的消息会被丢弃。

## 线路协议（JSON 文本帧）

### 客户端 → 服务器

| 类型 | 字段 | 说明 |
| --- | --- | --- |
| `join` | `room`（房间代码）、`name?`、`options?`（`{ decks, eagleMode, bots }`） | 加入或创建房间；首位加入者的 options 生效 |
| `ready` | — | 准备；全部人类准备后补机器人并发牌 |
| `act` | `action` | 出牌操作，见下 |
| `next-round` | — | 局间结算后进入下一局（应用进贡换牌） |
| `end-match` | — | 结束整场比赛，回到大厅 |
| `leave` | — | 离开房间 |

`action`（`PlayerAction`）：

| kind | 字段 | 说明 |
| --- | --- | --- |
| `play` | `cardIds` | 出一手牌（服务器校验合法性） |
| `pass` | — | 不要 |
| `burn` | `cardIds` | 烧牌：更大的够级牌 |
| `let` | — | 让牌（对头把够级应牌权让给全桌） |
| `revolution` | `declare` | 革命表态 |
| `ready` | — | （大厅内）准备 |
| `next-round` | — | （局间）下一局 |

### 服务器 → 客户端

| 类型 | 字段 | 说明 |
| --- | --- | --- |
| `hello` | `room`、`seat`、`userId`、`mode`（`dev`/`secure`） | 加入成功 |
| `state` | `state`（`ClientState`） | 完整可渲染状态：公开牌桌 + 自己的手牌 + 合法操作 + `youSeat` |
| `error` | `message` | 操作被拒绝（如非法出牌），附中文原因 |
| `notice` | `message` | 提示信息（连接、重连、开发模式等） |

`ClientState` 包含：`roomCode`、`options`、`phase`（`lobby` / `revolution` / `playing` / `round-end`）、`round`、`seats`（座位、名字、机器人、剩余张数、开点状态、名次、是否革命、是否准备、是否在线）、`turnSeat`、`currentPlay`（上家出牌与是否够级）、`passed`、`goujiOpposite`、`burn`、`pendingFinish`、`demoted`、`scores`（联邦累计分）、`roundScores`（本局名次与联邦分）、`tributes`（进贡列表）、`log`、`hand`（仅自己）、`legal`（`canPlay/canPass/canBurn/canLet/canRevolution/hintCardIds`）、`youSeat`、`youUserId`。

## 部署清单

1. 把服务器部署到有固定公网地址的机器（WSS 必须配好 TLS 证书）。
2. 在社区应用页登记该地址；把 `manifest.json` 里 `websockets.game.url` 和客户端 `src/config.ts` 里的 `GAME_WS_URL` 改成部署地址。
3. 配置 `COMMUNITY_ISSUER`（社区地址）、`APP_ID`、`SERVER_ORIGIN`（与部署地址一致），关掉开发模式。
4. 用 `bun run start`（或进程管理器）常驻运行。
