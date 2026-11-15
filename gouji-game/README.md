# 够级在线对战（Gouji Game）

完整的够级在线对战：六人、两联邦、四副牌经典玩法，可在线联机，也可单机打机器人。

- 客户端：Discourse 小程序（Bun + Vite + TypeScript，单文件 IIFE `app.js` + `app.css`）
- 服务器：`server/`（Bun + WebSocket，TypeScript，权威状态机）
- 共享引擎：`src/engine/`（纯函数 + `Game` 状态机，客户端人机模式与服务器共用）

## 先跑起来

### 人机对战（无需服务器）

```bash
cd demos/gouji-game
bun install --frozen-lockfile
bun run dev        # http://127.0.0.1:5195/
```

打开后选「人机对战」→「开始人机对战」，你坐 1 号位，五位机器人补满牌桌，立即开局。

### 在线对战（需要服务器）

```bash
cd demos/gouji-game/server
bun install --frozen-lockfile
cp .env.example .env
PORT=8787 DEV_MODE=1 bun run start   # 本地开发模式
```

服务器跑起来后，客户端选「在线对战」，创建或加入房间（6 位代码），全部人类准备后空座由机器人补满，1–5 人都能开局。详细配置与线路协议见 [`server/README.md`](server/README.md)。

## 部署前必须替换的占位符

| 占位符 | 位置 | 改成什么 |
| --- | --- | --- |
| `wss://api.example.com/gouji` | `manifest.json` 的 `websockets.game.url`、客户端 `src/config.ts` 的 `GAME_WS_URL` | 部署好的服务器 WSS 地址（须配 TLS 证书） |
| `COMMUNITY_ISSUER`（空） | `server/.env` | 社区地址（含 /forum 子目录，如有） |
| `APP_ID`（`01900000-0000-7000-8000-000000000000`） | `server/.env`、`manifest.json`、`MINI_APP_ID` 构建参数 | 社区应用页上的真实应用 ID |
| `SERVER_ORIGIN`（`https://api.example.com`） | `server/.env` | 服务器的公开 HTTPS 地址（平台 JWT 的 audience） |

占位符未替换时，客户端大厅会显示「在线服务器尚未配置」，在线按钮不可用；服务器未配置社区地址时以开发模式运行，启动日志会明确警告「未验证平台 JWT，仅供本地调试」，绝不能公开暴露。

## 构建与上传

```bash
cd demos/gouji-game
MINI_APP_ID=<真实应用 ID> MINI_APP_VERSION=1.0.0 bun run build
```

只上传 `dist/package/app.zip`（不要上传整个仓库）。构建前可用 `bun run dev` 在 127.0.0.1:5195 本地预览。

## 玩法（经典四副牌）

六人两联邦（1、3、5 号 vs 2、4、6 号），逆时针出牌，每人 36 张。牌力 3 < 4 < … < 10 < J < Q < K < A < 2（钱）< 小王 < 大王；没有顺子；出牌为同点数 N 张，可挂 2 / 王。

- **够级牌**：5×10、4×J、3×Q、2×K、2×A、1×2、1×小王、1×大王，或挂牌凑够同等张数。只有对头能接，别人只能烧牌。
- **开点**：纯够级牌打出并存活一圈后，下一轮须出 4 开点；开局没有纯够级牌即自然点。
- **烧牌**：已开点的非对头可出更大的够级牌烧掉；烧牌后每次出牌都要挂王（最后一手除外）。
- **让牌 / 够死级**：对头可把够级应牌权让给全桌；头科、二科决出后，对头有一次免费够级机会。
- **憋 3**：3 必须最后出。**革命**：手里没有 2 / 王可以革命，坐下不打，排四科。
- **名次与计分**：头科、二科、三科、四科、二落、大落；联邦计分 +4 / +2 / 0 / 0 / −2 / −4，串三户（一个联邦包揽前三）翻倍为 12，联邦负分记 0。
- **进贡**：点贡、烧贡、闷贡、落贡（闷 > 烧 > 点 > 落），下一局开局自动换牌。
- **六副牌带鹰（房间选项）**：324 张，每人 54 张，6 张鹰。鹰牌没有统一标准，开局前三选一：鹰为王中王（大于大王）/ 鹰当大王 / 洗牌前去掉鹰；三种都不作为标准呈现。

## 简化说明（与地方桌规的差异）

- **买 3 未实现**：没有 3 的玩家正常出牌，不走买 3 流程。
- **烧牌断王**：烧牌者中途没有带王的合法出牌时，烧牌失败，按大落论处，本局不再出牌（机器人不会主动把自己烧进死胡同，引擎也会自动裁决）。
- **革命名次**：革命者按座位顺序排四科、二落、大落；第 4 位及以后的革命者不安排名次，正常打牌。
- **进贡**：进贡牌自动选择最大的王 / 2 / 鹰；进贡者手里没有王 / 2 / 鹰时免贡。
- **烧牌者的“不要”**：烧牌进行中，烧牌者“不要”即放弃烧牌，不另行处罚。
- **让牌后**：被让的够级牌按正常出牌处理（全桌可接）。

## 验证（均已实际运行）

```bash
cd demos/gouji-game
bun test test                 # 引擎测试：24 个，含完整六机器人对局
bun run typecheck             # 客户端类型检查
cd server && bun run typecheck  # 服务器类型检查
MINI_APP_ID=01900000-0000-7000-8000-000000000000 MINI_APP_VERSION=1.0.0 bun run build
# 服务器冒烟：本地启动 + 脚本化客户端完成一整局，非法出牌被拒绝
PORT=8787 DEV_MODE=1 bun run index.ts   # server/（另一个终端）
bun server/e2e-check.ts E2E01           # 1 个人类客户端 + 5 个服务器机器人
```

## 目录结构

```
demos/gouji-game/
├── manifest.json        # 小程序清单（占位 WSS 地址、权限）
├── src/
│   ├── main.ts          # 大厅 + 牌桌 UI
│   ├── host.ts          # 社区身份 / 主题 / 存储适配
│   ├── net.ts           # 在线客户端（reconnectSocket，自动重连）
│   ├── local.ts         # 人机模式驱动（同引擎 + 机器人）
│   ├── config.ts        # WSS 地址占位符（与 manifest 同步修改）
│   ├── engine/          # 共享引擎：types / play / game / ai / protocol
│   ├── template.html    # 页面结构
│   └── style.css        # 样式（浅色 / 深色、窄屏、触屏、减动效）
├── server/              # Bun WebSocket 权威服务器
│   ├── index.ts         # 房间、座位、机器人调度、状态广播
│   ├── auth.ts          # 平台 JWT 验证（JWKS）与开发模式
│   └── README.md        # 线路协议与部署清单
└── test/engine.test.ts  # 引擎测试
```

## 还需要你做的事

1. 部署服务器到有固定公网地址的机器（WSS + TLS 证书），替换上面三个占位符。
2. 在社区应用页创建应用，拿到真实应用 ID，替换 `MINI_APP_ID` 与 `APP_ID`。
3. 上传 `dist/package/app.zip` 到社区。
