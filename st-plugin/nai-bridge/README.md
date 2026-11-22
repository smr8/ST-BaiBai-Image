# NAI Bridge（SillyTavern 服务端插件）

给不走 CORS 的第三方 NAI 站开一条同源通道，避免另起反代进程/端口。

## 安装

把整个 `nai-bridge` 目录放进 SillyTavern 的 `plugins/` 下：

```
SillyTavern/plugins/nai-bridge/index.js
SillyTavern/plugins/nai-bridge/allowed-hosts.json
```

确认 `config.yaml` 里 `enableServerPlugins: true`，重启 SillyTavern。启动日志里应出现
`[nai-bridge] 白名单: api.rinko.ai, image.novelai.net`。

## 接入点地址

```
http://localhost:8000/api/plugins/nai-bridge/https://api.rinko.ai/v1/nai/generate-image
```

（`localhost:8000` 换成你实际的 ST 地址；从手机访问时用局域网 IP 或域名。）

规则很简单：`/api/plugins/nai-bridge/` 后面接**上游完整地址**，插件原样转发。
扩展推出 `encode-vibe`、`user/subscription`、`/v1/models` 时会自动沿用同一前缀。

## 白名单

`allowed-hosts.json` 只允许列出的 host，防止 ST 暴露到局域网后变成开放代理。
换站时把新站域名加进去，重启 ST 生效。

## 鉴权头（重要）

桥接地址和 ST 同源，而 ST 开着 `basicAuthMode: true` 时，浏览器靠 `Authorization: Basic …`
带登录凭据。扩展因此把 NAI 的 Key 放在 `X-NAI-Key` 头里，由插件在转发前换成
`Authorization: Bearer …`；同时插件会**丢掉**浏览器带来的 Basic 头，避免把 ST 的登录凭据
泄漏给第三方站。

早先版本的扩展直接发 `Authorization: Bearer`，会把 Basic 头挤掉，ST 判它不是 Basic 就回 401，
表现为「每生成一张图弹一次密码框」。若遇到这个症状，先确认扩展与插件都是新版。
