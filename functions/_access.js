// Cloudflare Access 身份识别：只有验过签的 JWT 才算可信身份。
//
// Access 认证通过后，CF 会往转发给源站的请求上注入两个头：
//   - CF-Access-Authenticated-User-Email：明文，客户端可以伪造 → 不可信
//   - Cf-Access-Jwt-Assertion：RS256 签名 JWT → 验签后才可信
//
// 为什么不能只读明文头：没经过 Access 的入口（例如直连 *.pages.dev）CF 不参与鉴权，
// 也就不会剥离客户端自带的 CF-Access-* 头 —— 伪造一个明文头就能骗过「只看头」的实现。
// 官方文档同样要求："it is important that you validate the JWT"。
//
// 本模块只导出具名函数、不导出 onRequest —— Pages 不会把它当成路由。

export const ACCESS_TEAM = 'https://kwokzit.cloudflareaccess.com';
// AUD 是公开的应用标识（dashboard 上可见），不是密钥；应用删了重建才会变。
export const ACCESS_AUD = 'b4e5f0431519c04e02ea27313e593a4b5772f01d99bcd78616dcc78066f680bf';

const JWKS_URL = `${ACCESS_TEAM}/cdn-cgi/access/certs`;
const IDENTITY_URL = `${ACCESS_TEAM}/cdn-cgi/access/get-identity`;

let jwksCache = null;              // { keys: Map<kid, CryptoKey>, at }
const JWKS_TTL = 3600 * 1000;
const nameCache = new Map();        // 身份键 -> { name, at }
const NAME_TTL = 3600 * 1000;
const NAME_CACHE_MAX = 200;
// 验签结果缓存：代理是热路径（一个视频几十个分片请求），
// 每次都做一次 RS256 验签会白烧 Pages 的 CPU 配额。
// 缓存命中时仍然检查 exp，所以过期不会因为缓存而多活。
const tokenCache = new Map();       // token -> { payload, at }
const TOKEN_CACHE_TTL = 60 * 1000;
const TOKEN_CACHE_MAX = 500;

function b64urlToBytes(s) {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
    const bin = atob(b64 + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

async function getJwks() {
    if (jwksCache && Date.now() - jwksCache.at < JWKS_TTL) return jwksCache.keys;
    // 必须带超时：这是外部端点，挂住会把每个代理请求一起拖死
    const res = await fetch(JWKS_URL, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
    const jwks = await res.json();
    const keys = new Map();
    for (const jwk of jwks.keys || []) {
        // JWK 的 n / e 本身就是 base64url，importKey 直接用，不要再转
        const key = await crypto.subtle.importKey(
            'jwk',
            { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: jwk.alg || 'RS256' },
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['verify']
        );
        keys.set(jwk.kid, key);
    }
    jwksCache = { keys, at: Date.now() };
    return keys;
}

/**
 * 验签 + 校验 iss / aud / exp / nbf / alg。
 * 通过返回 payload，任何一步不过就返回 null（绝不因为头存在就放行）。
 */
export async function verifyAccessToken(token) {
    if (!token) return null;
    const hit = tokenCache.get(token);
    if (hit && Date.now() - hit.at < TOKEN_CACHE_TTL && hit.payload.exp * 1000 >= Date.now()) {
        return hit.payload;
    }
    const payload = await verifyAccessTokenFresh(token);
    if (payload) {
        if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.clear();
        tokenCache.set(token, { payload, at: Date.now() });
    }
    return payload;
}

async function verifyAccessTokenFresh(token) {
    const parts = (token || '').split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;

    let header, payload;
    try {
        const dec = new TextDecoder();
        header = JSON.parse(dec.decode(b64urlToBytes(h)));
        payload = JSON.parse(dec.decode(b64urlToBytes(p)));
    } catch {
        return null;
    }
    if (!header || header.alg !== 'RS256') return null;   // 防 alg=none / alg 混淆
    if (payload.iss !== ACCESS_TEAM) return null;
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(ACCESS_AUD)) return null;           // 防跨应用复用
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    if (payload.nbf && payload.nbf * 1000 > Date.now()) return null;

    let keys;
    try {
        keys = await getJwks();
    } catch {
        return null;
    }
    const key = keys.get(header.kid);                      // CF 会轮换签名密钥，必须按 kid 选
    if (!key) return null;

    const ok = await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        key,
        b64urlToBytes(s),
        new TextEncoder().encode(`${h}.${p}`)
    );
    return ok ? payload : null;
}

/**
 * 显示名的来源优先级：
 *   ① JWT 的 common_name
 *   ② get-identity 返回的 IdP 显示名（IdP 登录时官方字段表没列 common_name）
 *   ③ email 的本地部分
 * 取不到就是空字符串 —— 宁可没有名字，也不要显示一串无意义的标识。
 */
async function resolveDisplayName(payload, token) {
    const cn = typeof payload.common_name === 'string' ? payload.common_name.trim() : '';
    // service token 的 common_name 形如 <client-id>.access —— 那是凭据编号，不是人名
    if (cn && !cn.endsWith('.access')) return cn;

    const fromIdp = await fetchIdpName(payload, token);
    if (fromIdp) return fromIdp;

    return emailLocalPart(payload.email);
}

function emailLocalPart(email) {
    if (typeof email !== 'string' || !email) return '';
    const at = email.lastIndexOf('@');
    const domain = at > 0 ? email.slice(at + 1).toLowerCase() : '';
    // IdP 不给邮箱时，Access 会生成 <uuid>@<team>.cloudflareaccess.com —— 那是无意义的标识
    if (domain === 'kwokzit.cloudflareaccess.com') return '';
    return at > 0 ? email.slice(0, at) : email;
}

async function fetchIdpName(payload, token) {
    const key = payload.sub || payload.email || '';
    if (!key) return null;
    const hit = nameCache.get(key);
    if (hit && Date.now() - hit.at < NAME_TTL) return hit.name;

    let name = null;
    try {
        // 必须带超时：get-identity 是外部端点，挂住会拖死整页首屏。
        // 取不到就降级到 email，不影响页面。
        // cookie 名两种都带上：官方文档写 CF_Authorization，浏览器里实际是
        // CF_Authorization_<aud> —— 两种都塞上，省得猜错就丢掉显示名。
        const res = await fetch(IDENTITY_URL, {
            headers: { cookie: `CF_Authorization=${token}; CF_Authorization_${ACCESS_AUD}=${token}` },
            signal: AbortSignal.timeout(1500)
        });
        if (res.ok) {
            const data = await res.json();
            const idp = data && typeof data.idp === 'object' ? data.idp : null;
            if (idp) {
                for (const k of ['name', 'login']) {
                    if (typeof idp[k] === 'string' && idp[k].trim()) { name = idp[k].trim(); break; }
                }
            }
            if (!name && data && typeof data.name === 'string' && data.name.trim()) {
                name = data.name.trim();
            }
        }
    } catch {
        // 取不到就降级到 email，不影响页面
    }

    if (nameCache.size >= NAME_CACHE_MAX) nameCache.clear();
    nameCache.set(key, { name, at: Date.now() });
    return name;
}

/**
 * 从请求里解析 Access 身份。
 * 返回 { name, email }；没有经过 Access 或验签不过一律返回 null。
 */
export async function resolveIdentity(request) {
    const token = request.headers.get('cf-access-jwt-assertion');
    if (!token) return null;
    const payload = await verifyAccessToken(token);
    if (!payload) return null;
    return {
        name: await resolveDisplayName(payload, token),
        email: typeof payload.email === 'string' ? payload.email : '',
    };
}
