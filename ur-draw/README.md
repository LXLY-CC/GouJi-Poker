# URnetwork 抽节点（在 Codespace 里跑）

这台沙箱机器连不到 URnetwork 的代理服务器，所以抽节点的脚本要放在能上外网的机器上跑。GitHub Codespaces 就是一台免费的云端电脑，在浏览器里就能用，不用在本地装东西。

## 怎么跑

1. 在 GitHub 上打开这个仓库，点绿色的 **Code** 按钮 → **Codespaces** → **Create codespace on main**，等它建好（第一次要一两分钟）。
2. 在下面的终端里跑：

   ```
   python3 ur-draw/draw_socks.py
   ```

3. 脚本会先问你要 API key：去 ur.io → 账号设置 → API keys，复制那个 `urn_` 开头的 key，粘贴到终端里回车（只保存在这台 Codespace 里，不会提交到仓库）。
4. 脚本自动按速度抽美国 provider、钉死单个 provider、验出口（双 false、住宅 ISP、两次 IP 一致），再实测 generate_204 / x.com / 测速。抽中了会把 V2rayN 明文链接存成 `ur-node.txt`（就在 Codespace 里），直接复制走就行。
5. 用完把 Codespace 停掉就行；节点只在那个 provider 在线时有效，下线就重抽。

## 注意

- 免费档，不付费、不绑卡；节点只做一次性注册/浏览，别走重要账号和付款。
- key 和后面拿到的 token 都是凭据，别发到公开地方。
