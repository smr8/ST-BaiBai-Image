#!/usr/bin/env node
/**
 * NAI 第三方站的本地 CORS 反代(零依赖,只用 Node 自带模块)。
 *
 * 为什么需要:扩展在浏览器里直连图像接口。多数中转站(如 new-api 系)只在普通响应上给
 * Access-Control-Allow-Origin,OPTIONS 预检却回一个不带该头的 204 —— 浏览器于是拒绝发出
 * 任何带 Authorization 的请求,表现为「Failed to fetch」。这不是 Key 错,也不是地址错。
 * 本机加一层反代,由它补上 CORS 头再转发,扩展就能照常直连。
 *
 * 用法:
 *   node scripts/nai-cors-proxy.mjs
 *     # 默认转发到 https://api.rinko.ai,监听 127.0.0.1:8787
 *   TARGET=https://其它站 PORT=9000 node scripts/nai-cors-proxy.mjs
 *     # 换目标站/端口
 *
 * 然后在柏宝绘的接入点里填:
 *   http://127.0.0.1:8787/v1/nai/generate-image
 * (SillyTavern 跑在 https 下也能连:浏览器把 localhost 视为安全源,不算混合内容。)
 */
import http from 'node:http';
import https from 'node:https';

const PORT = Number(process.env.PORT ?? 8787);
const TARGET = new URL(process.env.TARGET ?? 'https://api.rinko.ai');
const isHttps = TARGET.protocol === 'https:';

/** 预检与实际响应都要带,缺一个浏览器就拦。 */
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS,PUT,DELETE',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-max-age': '86400',
};

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const upstream = new URL(req.url ?? '/', TARGET);
  // 只透传业务头:Host 要按目标站重写,逐跳头(hop-by-hop)交给 Node 自己管。
  // content-length 必须原样带过去 —— 删了 Node 就改成 chunked 上传,Cloudflare 会给 502。
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  delete headers['transfer-encoding'];

  const proxied = (isHttps ? https : http).request(
    {
      hostname: upstream.hostname,
      port: upstream.port || (isHttps ? 443 : 80),
      path: upstream.pathname + upstream.search,
      method: req.method,
      headers,
    },
    up => {
      // 上游的 CORS 头一律别覆盖我们的(有的站会给成 null 或重复值)
      const out = { ...up.headers };
      delete out['access-control-allow-origin'];
      delete out['access-control-allow-methods'];
      delete out['access-control-allow-headers'];
      res.writeHead(up.statusCode ?? 502, { ...out, ...CORS_HEADERS });
      up.pipe(res);
    },
  );

  proxied.on('error', error => {
    res.writeHead(502, { ...CORS_HEADERS, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message: `反代转发失败:${error.message}` } }));
  });

  req.pipe(proxied);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[nai-cors-proxy] 监听 http://127.0.0.1:${PORT}  →  ${TARGET.origin}`);
  console.log(`[nai-cors-proxy] 接入点地址填: http://127.0.0.1:${PORT}/v1/nai/generate-image`);
});
