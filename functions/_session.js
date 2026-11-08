// 密码兜底会话：服务端签发 / 校验，浏览器只拿到一个 HttpOnly cookie。
//
// 为什么要有这一层：站点真正的门是 Cloudflare Access（边缘层）。但万一 Access
// 被绕过、配置失效、或只保护了部分域名，就需要一个「最后防线」。
// 这个防线的全部价值在于「密码永远不进浏览器」——
// 服务端只发一张短时效、可撤销、推不出密码的会话 cookie；
// 浏览器拿不到密码哈希，也就没有任何可离线爆破的凭据。

export const SESSION_COOKIE = 'kt_sess';
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;   // 7 天

function b64url(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(s) {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
    const bin = atob(b64 + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

async function hmacKey(secret) {
    return crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify']
    );
}

/** token = <过期秒>.<base64url(HMAC-SHA256(过期秒))> */
export async function signSession(secret, ttlSeconds = SESSION_TTL_SECONDS) {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const key = await hmacKey(secret);
    const sig = new Uint8Array(await crypto.subtle.sign(
        'HMAC', key, new TextEncoder().encode(String(exp))
    ));
    return `${exp}.${b64url(sig)}`;
}

/** 校验签名 + 过期。验签用 subtle.verify（内部是常量时间比较），不用字符串 ===。 */
export async function verifySession(secret, token) {
    if (!secret || !token || typeof token !== 'string') return false;
    const dot = token.indexOf('.');
    if (dot <= 0) return false;
    const exp = Number(token.slice(0, dot));
    const sig = token.slice(dot + 1);
    if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) return false;
    try {
        const key = await hmacKey(secret);
        return await crypto.subtle.verify(
            'HMAC', key, b64urlToBytes(sig), new TextEncoder().encode(String(exp))
        );
    } catch {
        return false;
    }
}

export function readCookie(request, name) {
    const raw = request.headers.get('cookie') || '';
    for (const part of raw.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        if (part.slice(0, i).trim() === name) {
            try {
                return decodeURIComponent(part.slice(i + 1).trim());
            } catch {
                return part.slice(i + 1).trim();
            }
        }
    }
    return null;
}

/** 下发会话 cookie：HttpOnly（JS 读不到）+ Secure + SameSite=Strict + 不进 URL */
export function sessionCookieHeader(token, maxAge = SESSION_TTL_SECONDS) {
    return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}
