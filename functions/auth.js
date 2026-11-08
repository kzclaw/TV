// 密码兜底登录端点：POST /auth
//
// 只有在「拿不到可验签的 Cloudflare Access 身份」时才会走到这条路径。
// 密码原样提交给服务端比对，服务端只回一张 HttpOnly 会话 cookie ——
// 密码和它的哈希都不进浏览器存储。

import { sha256 } from '../js/sha256.js';
import { signSession, sessionCookieHeader } from './_session.js';

/** 常量时间比较：避免按字符早退泄漏信息 */
function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

export async function onRequest(context) {
    const { request, env } = context;

    if (request.method !== 'POST') {
        return new Response(JSON.stringify({ success: false, error: 'method_not_allowed' }), {
            status: 405,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // 登录 CSRF：跨站来源直接拒（正常是同源 fetch，没有 Origin 头的命令行客户端放行）
    const origin = request.headers.get('origin');
    if (origin) {
        try {
            if (new URL(origin).origin !== new URL(request.url).origin) {
                return new Response(JSON.stringify({ success: false, error: 'bad_origin' }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
        } catch {
            return new Response(JSON.stringify({ success: false, error: 'bad_origin' }), {
                status: 403,
                headers: { 'Content-Type': 'application/json' },
            });
        }
    }

    const secret = env.PASSWORD || '';
    if (!secret) {
        return new Response(JSON.stringify({ success: false, error: 'no_password_configured' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    let body;
    try {
        body = await request.json();
    } catch {
        body = {};
    }
    const password = body && typeof body.password === 'string' ? body.password : '';
    if (!password) {
        return new Response(JSON.stringify({ success: false, error: 'bad_password' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    const given = await sha256(password);
    const expected = await sha256(secret);
    if (!timingSafeEqual(given, expected)) {
        return new Response(JSON.stringify({ success: false, error: 'bad_password' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    const token = await signSession(secret);
    return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': sessionCookieHeader(token),
        },
    });
}
