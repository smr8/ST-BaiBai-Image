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
