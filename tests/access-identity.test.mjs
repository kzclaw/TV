// Cloudflare Access 身份识别的自检：node tests/access-identity.test.mjs
//
// 做法：本地生成 RSA 密钥对，自签一个 JWT，把 globalThis.fetch 换成假的
// JWKS / get-identity 端点，然后真跑一遍验签与名字解析。
// 覆盖：合法令牌、伪造签名、aud/iss 不符、过期、alg=none、
//       显示名的三级优先级（common_name → get-identity → email）、
//       以及 middleware 注入 window.__ENV__ 的实际效果。
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = new URL('../', import.meta.url);

// functions/ 下的模块用 ESM 语法，但仓库没有 package.json（.js 默认按 CommonJS 解析），
// 所以整份 functions/ + js/sha256.js 复制到临时目录，并放一个 type:module 的 package.json，
// 让 Node 按 ES Module 解析 —— 与 CI 语法检查的做法一致。
const tmp = mkdtempSync(join(tmpdir(), 'kztv-access-'));
mkdirSync(join(tmp, 'functions'), { recursive: true });
mkdirSync(join(tmp, 'js'), { recursive: true });
copyFileSync(new URL('functions/_access.js', REPO), join(tmp, 'functions', '_access.js'));
copyFileSync(new URL('functions/_middleware.js', REPO), join(tmp, 'functions', '_middleware.js'));
copyFileSync(new URL('functions/_session.js', REPO), join(tmp, 'functions', '_session.js'));
copyFileSync(new URL('js/sha256.js', REPO), join(tmp, 'js', 'sha256.js'));
writeFileSync(join(tmp, 'package.json'), '{"type":"module"}');

const access = await import(join(tmp, 'functions', '_access.js'));
const middleware = await import(join(tmp, 'functions', '_middleware.js'));

// --- 本地密钥与 JWT ---
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-kid', alg: 'RS256', use: 'sig' };
const b64u = (v) => Buffer.from(v).toString('base64url');

function makeJwt(payload, { kid = 'test-kid', alg = 'RS256' } = {}) {
    const h = b64u(JSON.stringify({ alg, typ: 'JWT', kid }));
    const p = b64u(JSON.stringify(payload));
    const sig = alg === 'none' ? '' : createSign('RSA-SHA256').update(`${h}.${p}`).sign(privateKey);
    return `${h}.${p}.${b64u(sig)}`;
}

const now = Math.floor(Date.now() / 1000);
const basePayload = (over = {}) => ({
    aud: [access.ACCESS_AUD],
    iss: access.ACCESS_TEAM,
    email: 'kzclaw@kwokzit.info',
    sub: '7335d417-61da-459d-899c-0a01c76a2f94',
    exp: now + 3600,
    iat: now,
    nbf: now - 10,
    ...over
});

const mockRequest = (token) => ({
    headers: { get: (k) => (k === 'cf-access-jwt-assertion' ? token : null) }
});

// --- 假的 CF 端点 ---
let identityResponse = { status: 200, body: { idp: { name: '戴舒柯', login: 'kzfidx' } } };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/cdn-cgi/access/certs')) {
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    }
    if (u.endsWith('/cdn-cgi/access/get-identity')) {
        return new Response(JSON.stringify(identityResponse.body), { status: identityResponse.status });
    }
    return new Response('not found', { status: 404 });
};

// --- 1) JWKS 拉不到 → 拒绝（这条必须放在最前面，此时还没进缓存）---
{
    globalThis.fetch = async () => { throw new Error('network down'); };
    const payload = await access.verifyAccessToken(makeJwt(basePayload()));
    assert.equal(payload, null, 'JWKS 拉取失败时必须拒绝');

    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.endsWith('/cdn-cgi/access/certs')) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
        if (u.endsWith('/cdn-cgi/access/get-identity')) return new Response(JSON.stringify(identityResponse.body), { status: 200 });
        return new Response('not found', { status: 404 });
    };
}

// --- 2) 合法令牌 → 通过 ---
{
    const payload = await access.verifyAccessToken(makeJwt(basePayload()));
    assert.ok(payload, '合法令牌应验签通过');
    assert.equal(payload.email, 'kzclaw@kwokzit.info');
}

// --- 3) 篡改签名 → 拒绝 ---
{
    const jwt = makeJwt(basePayload());
    const tampered = jwt.slice(0, -4) + (jwt.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
    assert.equal(await access.verifyAccessToken(tampered), null, '签名被改过必须拒绝');
}

// --- 4) aud / iss 不符 → 拒绝 ---
{
    assert.equal(await access.verifyAccessToken(makeJwt(basePayload({ aud: ['someone-elses-aud'] }))), null, 'aud 不符必须拒绝');
    assert.equal(await access.verifyAccessToken(makeJwt(basePayload({ iss: 'https://evil.cloudflareaccess.com' }))), null, 'iss 不符必须拒绝');
}

// --- 5) 过期 / 未生效 → 拒绝 ---
{
    assert.equal(await access.verifyAccessToken(makeJwt(basePayload({ exp: now - 10 }))), null, '过期令牌必须拒绝');
    assert.equal(await access.verifyAccessToken(makeJwt(basePayload({ nbf: now + 600 }))), null, '未生效令牌必须拒绝');
}

// --- 6) alg=none / alg 混淆 → 拒绝 ---
{
    assert.equal(await access.verifyAccessToken(makeJwt(basePayload(), { alg: 'none' })), null, 'alg=none 必须拒绝');
    assert.equal(await access.verifyAccessToken(makeJwt(basePayload(), { alg: 'HS256' })), null, 'alg 混淆必须拒绝');
}

// --- 7) 格式不对 / 没有令牌 → 拒绝 ---
{
    assert.equal(await access.verifyAccessToken('abc'), null);
    assert.equal(await access.verifyAccessToken(''), null);
    assert.equal(await access.resolveIdentity(mockRequest(null)), null, '没有令牌就没有身份');
    assert.equal(await access.resolveIdentity(mockRequest('garbage')), null, '垃圾令牌没有身份');
}

// --- 8) 显示名优先级 ①：JWT 的 common_name ---
{
    const id = await access.resolveIdentity(mockRequest(
        makeJwt(basePayload({ common_name: '戴大虾🍤', email: 'kzclaw@kwokzit.info', sub: 'sub-cn' }))
    ));
    assert.equal(id.name, '戴大虾🍤', 'common_name 应优先');
    assert.equal(id.email, 'kzclaw@kwokzit.info');
}

// --- 9) 显示名优先级 ②：get-identity 的 IdP 显示名 ---
{
    const id = await access.resolveIdentity(mockRequest(makeJwt(basePayload({ sub: 'sub-idp' }))));
    assert.equal(id.name, '戴舒柯', '没有 common_name 时应取 get-identity 的显示名');
}

// --- 10) 显示名优先级 ③：退回 email 的本地部分 ---
{
    identityResponse = { status: 500, body: {} };   // get-identity 挂了
    const id = await access.resolveIdentity(mockRequest(makeJwt(basePayload({ sub: 'sub-email' }))));
    assert.equal(id.name, 'kzclaw', '两级都拿不到时退回 email 本地部分');

    // 合成邮箱（IdP 不给邮箱时 Access 生成的）不能显示成一串 uuid
    const anon = await access.resolveIdentity(mockRequest(makeJwt(basePayload({
        email: 'e367826f93b8d71185e03fe518aff3b4@kwokzit.cloudflareaccess.com', sub: 'sub-anon'
    }))));
    assert.equal(anon.name, '', '合成邮箱不显示名字');
    identityResponse = { status: 200, body: { idp: { name: '戴舒柯', login: 'kzfidx' } } };
}

// --- 11) service token 的 common_name 形如 <client-id>.access → 不能当人名 ---
{
    const id = await access.resolveIdentity(mockRequest(makeJwt(basePayload({
        common_name: 'e367826f93b8d71185e03fe518aff3b4.access', email: '', sub: 'sub-st'
    }))));
    assert.notEqual(id.name, 'e367826f93b8d71185e03fe518aff3b4.access', 'service token 的 common_name 不能当人名');
}

// --- 12) middleware：把身份注入进 HTML ---
{
    const html = '<html><body><script>window.__ENV__ = window.__ENV__ || {};\nwindow.__ENV__.ACCESS_NAME = "{{ACCESS_NAME}}";\nwindow.__ENV__.AUTH_MODE = "{{AUTH_MODE}}";</script></body></html>';
    const context = {
        request: mockRequest(makeJwt(basePayload({ common_name: '戴舒柯', sub: 'sub-mw' }))),
        env: { PASSWORD: 'Kwokzit.tv' },
        next: async () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    };
    const res = await middleware.onRequest(context);
    const out = await res.text();
    assert.match(out, /window\.__ENV__\.ACCESS_NAME = "戴舒柯"/, 'middleware 应注入 ACCESS_NAME');
    assert.match(out, /window\.__ENV__\.AUTH_MODE = "access"/, '有 Access 身份时 AUTH_MODE 应为 access');
    assert.doesNotMatch(out, /"Kwokzit\.tv"/, '明文密码不能出现在页面里');
}

// --- 13) middleware：没有身份时要求密码，且绝不下发密码/哈希 ---
{
    const html = '<html><body><script>window.__ENV__.ACCESS_NAME = "{{ACCESS_NAME}}";\nwindow.__ENV__.AUTH_MODE = "{{AUTH_MODE}}";</script></body></html>';
    const context = {
        request: mockRequest(null),
        env: { PASSWORD: 'Kwokzit.tv' },
        next: async () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    };
    const out = await (await middleware.onRequest(context)).text();
    assert.match(out, /ACCESS_NAME = ""/, '没有身份时 ACCESS_NAME 应为空串');
    assert.match(out, /AUTH_MODE = "password"/, '没有身份也没有会话时 AUTH_MODE 应为 password');
    assert.doesNotMatch(out, /Kwokzit\.tv/, '明文密码不能出现在页面里');
    assert.doesNotMatch(out, /PASSWORD/, '页面里不该再出现 PASSWORD 这个变量');
}

globalThis.fetch = realFetch;
console.log('Access 身份识别自检：全部通过');
