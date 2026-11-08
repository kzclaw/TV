// 鉴权链路的单测：会话 cookie + 代理三段式判定。
//
// 覆盖的是「判定权在服务端」这条核心：
//   · 没有凭据 → 必须被拒（不能让页面裸奔）
//   · 密码会话 cookie 有效 → 放行（Access 失效时的最后防线）
//   · Access 头在但验签不过 → 不能当成「有身份」，但可以降级到密码会话
//
// RS256 验签本身要 Cloudflare 的公钥，这里测不了；
// 它的正确性由「拿到 Cf-Access-Jwt-Assertion 就必须验签通过才放行」保证。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = new URL('../', import.meta.url);

// functions/ 下的模块是 ESM 语法，但仓库没有 package.json（.js 默认按 CommonJS 解析），
// 所以整份文件复制到临时目录 + type:module 的 package.json —— 与仓库既有做法一致。
const tmp = mkdtempSync(join(tmpdir(), 'kztv-auth-'));
mkdirSync(join(tmp, 'functions', 'proxy'), { recursive: true });
mkdirSync(join(tmp, 'js'), { recursive: true });
copyFileSync(new URL('functions/_session.js', REPO), join(tmp, 'functions', '_session.js'));
copyFileSync(new URL('functions/_access.js', REPO), join(tmp, 'functions', '_access.js'));
copyFileSync(new URL('functions/auth.js', REPO), join(tmp, 'functions', 'auth.js'));
copyFileSync(new URL('functions/proxy/[[path]].js', REPO), join(tmp, 'functions', 'proxy', '[[path]].js'));
copyFileSync(new URL('js/sha256.js', REPO), join(tmp, 'js', 'sha256.js'));
writeFileSync(join(tmp, 'package.json'), '{"type":"module"}');

const {
    signSession,
    verifySession,
    readCookie,
    sessionCookieHeader,
    SESSION_COOKIE,
} = await import(join(tmp, 'functions', '_session.js'));
const { validateAuth } = await import(join(tmp, 'functions', 'proxy', '[[path]].js'));
const { onRequest: authEndpoint } = await import(join(tmp, 'functions', 'auth.js'));

const SECRET = 'unit-test-secret';

function req(headers = {}) {
    return new Request('https://example.com/proxy/abc', { headers });
}

test('会话 cookie：签发后能验过', async () => {
    const token = await signSession(SECRET);
    assert.equal(await verifySession(SECRET, token), true);
});

test('会话 cookie：换一把密钥就验不过', async () => {
    const token = await signSession(SECRET);
    assert.equal(await verifySession('another-secret', token), false);
});

test('会话 cookie：过期即失效', async () => {
    const token = await signSession(SECRET, -1);
    assert.equal(await verifySession(SECRET, token), false);
});

test('会话 cookie：改一个字节就验不过', async () => {
    const token = await signSession(SECRET);
    const forged = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
    assert.equal(await verifySession(SECRET, forged), false);
});

test('会话 cookie：空值/垃圾值不炸', async () => {
    for (const bad of ['', 'x', 'abc', '123.notasig', null, undefined]) {
        assert.equal(await verifySession(SECRET, bad), false);
    }
});

test('读 cookie：从 Cookie 头里取值', () => {
    const r = req({ cookie: `other=1; ${SESSION_COOKIE}=tok123; more=2` });
    assert.equal(readCookie(r, SESSION_COOKIE), 'tok123');
    assert.equal(readCookie(r, 'nope'), null);
    assert.equal(readCookie(req(), SESSION_COOKIE), null);
});

test('下发 cookie 的头：HttpOnly + Secure + SameSite + 有期限', () => {
    const header = sessionCookieHeader('tok', 3600);
    assert.match(header, /^kt_sess=tok;/);
    assert.match(header, /HttpOnly/);
    assert.match(header, /Secure/);
    assert.match(header, /SameSite=Strict/);
    assert.match(header, /Path=\//);
    assert.match(header, /Max-Age=3600/);
    assert.doesNotMatch(header, /auth=/i);
});

// --- 代理的三段式判定 ---

test('代理：没有任何凭据 → 拒绝', async () => {
    const r = await validateAuth(req(), { PASSWORD: SECRET });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_credentials');
});

test('代理：Access 头在但验签不过 → 拒绝（不把「头存在」当成身份）', async () => {
    const r = await validateAuth(req({ 'cf-access-jwt-assertion': 'not.a.jwt' }), { PASSWORD: SECRET });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_access_token');
});

test('代理：有效的密码会话 cookie → 放行（Access 失效时的兜底）', async () => {
    const token = await signSession(SECRET);
    const r = await validateAuth(req({ cookie: `${SESSION_COOKIE}=${token}` }), { PASSWORD: SECRET });
    assert.equal(r.ok, true);
    assert.equal(r.via, 'password');
});

test('代理：Access 头验签不过，但密码会话有效 → 降级放行', async () => {
    const token = await signSession(SECRET);
    const r = await validateAuth(
        req({ 'cf-access-jwt-assertion': 'not.a.jwt', cookie: `${SESSION_COOKIE}=${token}` }),
        { PASSWORD: SECRET }
    );
    assert.equal(r.ok, true);
    assert.equal(r.via, 'password');
});

test('代理：别的密钥签的 cookie → 拒绝', async () => {
    const token = await signSession('other-secret');
    const r = await validateAuth(req({ cookie: `${SESSION_COOKIE}=${token}` }), { PASSWORD: SECRET });
    assert.equal(r.ok, false);
});

test('代理：服务端没配 PASSWORD → 密码兜底不可用', async () => {
    const token = await signSession(SECRET);
    const r = await validateAuth(req({ cookie: `${SESSION_COOKIE}=${token}` }), {});
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_credentials');
});

// --- /auth 登录端点 ---

function authReq(body, headers = {}) {
    return new Request('https://example.com/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
}

test('/auth：密码正确 → 200 + 下发会话 cookie', async () => {
    const res = await authEndpoint({
        request: authReq({ password: 'Kwokzit.tv' }),
        env: { PASSWORD: 'Kwokzit.tv' },
    });
    assert.equal(res.status, 200);
    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie, '必须下发 cookie');
    assert.match(setCookie, /HttpOnly/);
    const token = setCookie.split(';')[0].split('=')[1];
    assert.equal(await verifySession('Kwokzit.tv', token), true, '下发的 cookie 应该能验过');
});

test('/auth：密码错误 → 401 bad_password，且不下发 cookie', async () => {
    const res = await authEndpoint({
        request: authReq({ password: 'wrong' }),
        env: { PASSWORD: 'Kwokzit.tv' },
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'bad_password');
    assert.equal(res.headers.get('set-cookie'), null);
});

test('/auth：跨站来源 → 403（登录 CSRF）', async () => {
    const res = await authEndpoint({
        request: authReq({ password: 'Kwokzit.tv' }, { origin: 'https://evil.example' }),
        env: { PASSWORD: 'Kwokzit.tv' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('set-cookie'), null);
});

test('/auth：同源来源 → 正常放行', async () => {
    const res = await authEndpoint({
        request: authReq({ password: 'Kwokzit.tv' }, { origin: 'https://example.com' }),
        env: { PASSWORD: 'Kwokzit.tv' },
    });
    assert.equal(res.status, 200);
});

test('/auth：服务端没配密码 → 500（而不是放行任何密码）', async () => {
    const res = await authEndpoint({
        request: authReq({ password: 'anything' }),
        env: {},
    });
    assert.equal(res.status, 500);
    assert.equal(res.headers.get('set-cookie'), null);
});
