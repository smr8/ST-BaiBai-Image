/**
 * NAI Bridge — SillyTavern 服务端插件
 *
 * 作用:把 /api/plugins/nai-bridge/<上游完整 URL> 原样转发到上游,再把响应带回来。
 * 浏览器请求的是 ST 自己的地址(同源),于是没有 CORS 这回事 —— 第三方 NAI 站
 * (如 api.rinko.ai)只在普通响应上给 Access-Control-Allow-Origin,OPTIONS 预检却不给,
 * 浏览器直连必被拦;经这条同源通道就能通。
 *
 * 用法(柏宝绘的 NAI 接入点地址):
 *   http://localhost:8000/api/plugins/nai-bridge/https://api.rinko.ai/v1/nai/generate-image
 * 测连接、vibe 编码、订阅/模型探测都会自动沿用同一前缀(见扩展的 naiEndpoint)。
 *
 * 安全:转发目标受同目录 allowed-hosts.json 限制。ST 的 listen: true 会把端口暴露到
 * 局域网,不限制就等于开了一个开放代理。
 *
 * 注:plugins/package.json 声明了 "type": "commonjs",所以这里用 CJS 写法。
 */
const fs = require('node:fs');
const path = require('node:path');

const info = {
  id: 'nai-bridge',
  name: 'NAI Bridge',
  description: '同源转发到指定的 NAI 站,绕开第三方站的 CORS 限制',
};

const MOUNT = '/api/plugins/nai-bridge/';
const ALLOW_FILE = path.join(__dirname, 'allowed-hosts.json');

/** null = 没读到白名单,按「放行全部」处理(仅供调试,正式使用务必配好)。 */
let allowedHosts = null;

function loadAllowedHosts() {
  try {
    const raw = JSON.parse(fs.readFileSync(ALLOW_FILE, 'utf8'));
    const hosts = Array.isArray(raw && raw.hosts) ? raw.hosts.filter(h => typeof h === 'string' && h.trim()) : [];
    allowedHosts = new Set(hosts.map(h => h.trim().toLowerCase()));
    console.log(`[nai-bridge] 白名单:${[...allowedHosts].join(', ') || '(空,全部拒绝)'}`);
  } catch (error) {
    console.warn('[nai-bridge] 读不到 allowed-hosts.json,本次放行全部目标:', error.message);
    allowedHosts = null;
  }
}

/** 从原始 URL 里取挂载点之后的那段(就是上游整段地址,可能含 query)。 */
function targetOf(req) {
  const raw = req.originalUrl || req.url || '';
  const index = raw.indexOf(MOUNT);
  return index >= 0 ? raw.slice(index + MOUNT.length) : '';
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

async function init(router) {
  loadAllowedHosts();

  // use 而不是 all('/*'):Express 4/5 通吃
  router.use(async (req, res) => {
    const target = targetOf(req);
    if (!/^https?:\/\//i.test(target)) {
      res.status(400).json({ error: { message: '用法:/api/plugins/nai-bridge/https://目标站/路径' } });
      return;
    }

    let url;
    try {
      url = new URL(target);
    } catch {
      res.status(400).json({ error: { message: `目标地址不合法:${target}` } });
      return;
    }

    if (allowedHosts && !allowedHosts.has(url.host.toLowerCase())) {
      res.status(403).json({
        error: { message: `host 不在白名单:${url.host}(改 plugins/nai-bridge/allowed-hosts.json 后重启 ST)` },
      });
      return;
    }

    // 只带业务头:Host 要按目标站重写;cookie/referer 不该泄漏给第三方;
    // accept-encoding 交给 fetch 协商,否则拿到的可能是压缩体却仍带着 content-encoding
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers['content-length'];
    delete headers['accept-encoding'];
    delete headers.cookie;
    delete headers.referer;

    const body = await readBody(req);
    const controller = new AbortController();
    req.on('close', () => controller.abort());

    try {
      const upstream = await fetch(url, {
        method: req.method,
        headers,
        body,
        signal: controller.signal,
        redirect: 'follow',
      });
      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
        'content-length': buffer.length,
        'cache-control': 'no-store',
      });
      res.end(buffer);
    } catch (error) {
      if (controller.signal.aborted) return; // 客户端断开,别往已关闭的响应里写
      console.error('[nai-bridge] 转发失败:', error);
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: `转发失败:${(error && error.message) || error}` } }));
    }
  });
}

async function exit() {}

module.exports = { info, init, exit };
