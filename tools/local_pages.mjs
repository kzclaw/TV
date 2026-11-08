// 本地 Pages Functions 模拟器（只为离线验收鉴权链路，不属于线上代码）
//
// 干三件事：
//   1) 静态文件从 /workspace/TV 直接发
//   2) HTML 响应走 functions/_middleware.js 的真逻辑（注入 ACCESS_NAME / AUTH_MODE）
//   3) /proxy/* 与 /auth 走真函数
//
// 用法：node tools/local_pages.mjs [port] [--tls]
// --tls 需要自签证书（cookie 带 Secure，明文 HTTP 下浏览器会拒收）：
//   openssl req -x509 -newkey rsa:2048 -nodes -keyout tools/key.pem -out tools/cert.pem -days 2 -subj "/CN=localhost"
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const ROOT = resolve(args[1] || fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(args[0] || 8788);
const PASSWORD = 'Kwokzit.tv';

const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
};

const { onRequest: middleware } = await import(pathToFileURL(join(ROOT, 'functions/_middleware.js')).href);
const { onRequest: authEndpoint } = await import(pathToFileURL(join(ROOT, 'functions/auth.js')).href);
const { onRequest: proxyHandler, validateAuth } = await import(pathToFileURL(join(ROOT, 'functions/proxy/[[path]].js')).href);

const env = { PASSWORD, LIBRETV_PROXY_KV: null };

function baseUrl(req) {
    // 真实 Pages 前面是 TLS，request.url 是 https —— 这里要还原同样的 scheme，
    // 否则 origin 检查（登录 CSRF 防护）会误判
    const proto = String(req.headers['x-forwarded-proto'] || (req.socket && req.socket.encrypted ? 'https' : 'http'))
        .split(',')[0].trim();
    return `${proto}://${req.headers.host || 'localhost'}`;
}

function toRequest(req) {
    const url = new URL(req.url, baseUrl(req));
    return new Request(url, {
        method: req.method,
        headers: req.headers,
    });
}

function send(res, response) {
    const headers = {};
    for (const [k, v] of response.headers) {
        if (k.toLowerCase() === 'set-cookie') continue;
        headers[k] = v;
    }
    const sc = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
    if (sc.length) headers['set-cookie'] = sc;
    res.writeHead(response.status, headers);
    return response.arrayBuffer().then(b => res.end(Buffer.from(b)));
}

const TLS = process.argv.includes('--tls');
const server = (TLS ? https : http).createServer(
    TLS
        ? { key: readFileSync(join(ROOT, 'tools', 'key.pem')), cert: readFileSync(join(ROOT, 'tools', 'cert.pem')) }
        : {},
    async (req, res) => {
    try {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

        if (url.pathname === '/auth') {
            const body = await new Promise((resolve2, reject) => {
                let d = '';
                req.on('data', c => { d += c; });
                req.on('end', () => resolve2(d));
                req.on('error', reject);
            });
            const request = new Request(new URL(url.pathname, baseUrl(req)), {
                method: 'POST',
                headers: req.headers,
                body,
            });
            const out = await authEndpoint({ request, env });
            return send(res, out);
        }

        if (url.pathname.startsWith('/proxy/')) {
            const request = toRequest(req);
            const out = await proxyHandler({
                request,
                env,
                next: () => new Response('not found', { status: 404 }),
                waitUntil: () => {},
            });
            return send(res, out);
        }

        // 静态文件
        let p = join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname);
        if (!p.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
        try {
            const st = await stat(p);
            if (st.isDirectory()) p = join(p, 'index.html');
        } catch {
            res.writeHead(404); return res.end('not found');
        }
        const buf = await readFile(p);
        const type = mime[extname(p)] || 'application/octet-stream';
        const response = new Response(buf, { headers: { 'content-type': type } });
        // 让 HTML 走真中间件
        const out = await middleware({ request: toRequest(req), env, next: async () => response });
        return send(res, out);
    } catch (e) {
        res.writeHead(500);
        res.end(String(e && e.stack || e));
    }
});

server.listen(PORT, () => console.log(`local pages on ${TLS ? 'https' : 'http'}://127.0.0.1:${PORT}`));
