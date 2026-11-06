// 代理 SSRF 校验自检：node tests/proxy-ssrf.test.js
// 全程不碰网络：判定逻辑抽成了纯函数，网络行为用假 fetch 打桩。
//   断言 1：私有/保留地址判定（IPv4 私网段 + IPv6 等价段）
//   断言 2：公网地址不能被误伤
//   断言 3：协议白名单（只允许 http/https）
//   断言 4：端口白名单（只允许 80/443）
//   断言 5：禁止 userinfo（http://user:pass@host/）
//   断言 6：字面量私网 IP 一律拒绝，且拒绝时必须给出原因
//   断言 7：DoH 解析到私网即拒 / 解析失败保守拒绝 / 解析结果走缓存
//   断言 8：重定向逐跳校验（跳私网被拒、超 3 跳被拒、正常跳转到公网放行）
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const source = path.join(root, 'functions', 'proxy', '[[path]].js');

// Pages Function 是 ES Module，Node 里按 .js 会被当成 CommonJS：复制成 .mjs 再 import
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kztv-ssrf-'));
const tmpModule = path.join(tmpDir, 'proxy.mjs');
fs.copyFileSync(source, tmpModule);

// ==== 假网络：DoH 与假站点都不出网 ====
// 假 DNS 区域：public.example → 公网 IP；private.example → 回环；broken.example → 解析失败
const FAKE_DNS = {
    'public.example': { a: ['93.184.216.34'], aaaa: [] },
    'private.example': { a: ['127.0.0.1'], aaaa: [] },
    'broken.example': { fail: true },
    // 假站点也要能解析（否则第一跳就被 DNS 判定拦掉，测不到重定向那一跳）
    'redirect.example': { a: ['93.184.216.34'], aaaa: [] },
    'loop1.example': { a: ['93.184.216.34'], aaaa: [] },
    'loop2.example': { a: ['93.184.216.34'], aaaa: [] },
    'loop3.example': { a: ['93.184.216.34'], aaaa: [] },
    'loop4.example': { a: ['93.184.216.34'], aaaa: [] }
};
// 假站点：redirect → 跳回环；loop1..4 → 连续跳转；public → 正常 200
const FAKE_SITES = {
    'https://redirect.example/': { status: 302, location: 'http://127.0.0.1/' },
    'https://loop1.example/': { status: 302, location: 'https://loop2.example/' },
    'https://loop2.example/': { status: 302, location: 'https://loop3.example/' },
    'https://loop3.example/': { status: 302, location: 'https://loop4.example/' },
    'https://loop4.example/': { status: 302, location: 'https://public.example/' },
    'https://public.example/': { status: 200, body: 'ok' }
};
let dohCalls = 0;

function fakeFetch(input) {
    const url = String(input && input.url ? input.url : input);
    if (url.includes('/dns-query')) {
        dohCalls++;
        const name = decodeURIComponent(new URL(url).searchParams.get('name') || '');
        const type = new URL(url).searchParams.get('type');
        const zone = FAKE_DNS[name];
        if (!zone || zone.fail) {
            return Promise.resolve(new Response('{"Status":3}', {
                status: 200, headers: { 'Content-Type': 'application/json' }
            }));
        }
        const records = (type === '1' ? zone.a : zone.aaaa) || [];
        const answer = records.map(data => ({ name, type: Number(type), TTL: 60, data }));
        return Promise.resolve(new Response(JSON.stringify({ Status: 0, Answer: answer }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
        }));
    }
    const site = FAKE_SITES[url];
    if (!site) return Promise.reject(new Error(`测试未打桩的地址: ${url}`));
    const headers = new Headers();
    if (site.location) headers.set('location', site.location);
    return Promise.resolve(new Response(site.body || '', { status: site.status, headers }));
}

const realFetch = globalThis.fetch;
globalThis.fetch = fakeFetch;

(async () => {
    const proxy = await import(pathToFileURL(tmpModule).href);
    const { isPrivateIPv4, isPrivateIPv6, isPrivateIP, checkProxyUrlSyntax, onRequest } = proxy;

    // 断言 1：IPv4 私有/保留段
    const privateV4 = [
        '127.0.0.1', '127.1.2.3',            // 回环
        '10.0.0.1', '10.255.255.255',        // 私有 10/8
        '172.16.0.1', '172.31.255.255',      // 私有 172.16/12
        '192.168.1.1', '192.168.255.255',    // 私有 192.168/16
        '169.254.169.254', '169.254.0.1',    // 链路本地（含云元数据地址）
        '0.0.0.0',                            // 未指定
        '100.64.0.1',                         // CGNAT
        '192.0.0.1'                           // 协议分配块
    ];
    privateV4.forEach(ip => {
        assert.equal(isPrivateIPv4(ip), true, `${ip} 应判为私有地址`);
        assert.equal(isPrivateIP(ip), true, `${ip} 应判为私有地址`);
    });

    // 断言 2：公网 IPv4 不能误伤
    const publicV4 = [
        '8.8.8.8', '1.1.1.1', '93.184.216.34',
        '172.15.0.1', '172.32.0.1',           // 172.16/12 之外
        '192.169.0.1', '192.167.0.1',         // 192.168/16 之外
        '169.253.0.1', '169.255.0.1',         // 169.254/16 之外
        '11.0.0.1', '126.0.0.1', '1.2.3.4'
    ];
    publicV4.forEach(ip => {
        assert.equal(isPrivateIPv4(ip), false, `${ip} 不应被误判为私有地址`);
        assert.equal(isPrivateIP(ip), false, `${ip} 不应被误判为私有地址`);
    });

    // 断言 1b：IPv6 等价段
    const privateV6 = [
        '::1',                                // 回环
        '::',                                 // 未指定
        'fe80::1', 'fe80::1%eth0',            // 链路本地
        'fc00::1', 'fd00::1',                // 唯一本地
        '::ffff:127.0.0.1',                   // IPv4 映射
        '::ffff:10.0.0.1',
        '::ffff:192.168.1.1',
        '64:ff9b::127.0.0.1'                  // NAT64 映射的回环地址
    ];
    privateV6.forEach(ip => {
        assert.equal(isPrivateIPv6(ip), true, `${ip} 应判为私有地址`);
        assert.equal(isPrivateIP(ip), true, `${ip} 应判为私有地址`);
    });

    const publicV6 = [
        '2606:4700:10::ac42:93f3',
        '2001:4860:4860::8888',
        '::ffff:8.8.8.8'                      // 公网 IPv4 映射
    ];
    publicV6.forEach(ip => {
        assert.equal(isPrivateIPv6(ip), false, `${ip} 不应被误判为私有地址`);
        assert.equal(isPrivateIP(ip), false, `${ip} 不应被误判为私有地址`);
    });

    // 断言 3：协议白名单
    assert.equal(checkProxyUrlSyntax('http://example.com/').ok, true);
    assert.equal(checkProxyUrlSyntax('https://example.com/').ok, true);
    ['file:///etc/passwd', 'ftp://example.com/', 'gopher://example.com/', 'data:text/plain,hi']
        .forEach(url => {
            assert.equal(checkProxyUrlSyntax(url).ok, false, `${url} 协议应被拒`);
        });

    // 断言 4：端口白名单
    assert.equal(checkProxyUrlSyntax('http://example.com:80/').ok, true);
    assert.equal(checkProxyUrlSyntax('https://example.com:443/').ok, true);
    ['http://example.com:8080/', 'https://example.com:22/', 'http://example.com:8443/']
        .forEach(url => {
            assert.equal(checkProxyUrlSyntax(url).ok, false, `${url} 端口应被拒`);
        });

    // 断言 5：禁止 userinfo
    assert.equal(checkProxyUrlSyntax('http://user:pass@example.com/').ok, false);
    assert.equal(checkProxyUrlSyntax('http://user@example.com/').ok, false);

    // 断言 6：字面量私网 IP 直接拒（DNS 之前就拦掉）
    [
        'http://169.254.169.254/latest/meta-data/',
        'http://127.0.0.1/',
        'http://10.0.0.1/',
        'http://192.168.1.1/',
        'http://172.16.0.1/',
        'http://[::1]/',
        'http://[fe80::1]/'
    ].forEach(url => {
        const verdict = checkProxyUrlSyntax(url);
        assert.equal(verdict.ok, false, `${url} 应被拒`);
        assert.ok(verdict.reason && verdict.reason.length > 0, `${url} 必须给出拒绝原因`);
    });

    // 公网 IP 字面量与普通域名放行（域名还要过 DoH 解析，那是另一层）
    assert.equal(checkProxyUrlSyntax('http://8.8.8.8/').ok, true);
    assert.equal(checkProxyUrlSyntax('https://93.184.216.34/x').ok, true);
    assert.equal(checkProxyUrlSyntax('http://example.com/').ok, true);
    assert.equal(checkProxyUrlSyntax('http://localhost/').ok, false);

    // ==== 断言 7/8：走完整代理链路的判定 ====
    const PASSWORD = 'c15-self-test-password';
    const authHash = crypto.createHash('sha256').update(PASSWORD).digest('hex');
    const env = { PASSWORD };

    async function proxyRequest(target, { raw = false } = {}) {
        const url = raw
            ? `http://localhost/proxy/${target}${target.includes('?') ? '&' : '?'}auth=${authHash}`
            : `http://localhost/proxy/${encodeURIComponent(target)}?auth=${authHash}`;
        const res = await onRequest({
            request: new Request(url),
            env,
            next: () => {},
            waitUntil: () => {}
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* 非 JSON 响应 */ }
        return { status: res.status, text, json };
    }

    // 断言 7a：DoH 解析到私网 → 403，并写明原因
    {
        const r = await proxyRequest('http://private.example/');
        assert.equal(r.status, 403, '解析到回环地址应被拒');
        assert.equal(r.json.error, '目标地址被安全策略拒绝');
        assert.ok(/私有|保留/.test(r.json.reason), `原因应写明私网命中: ${r.json.reason}`);
        assert.equal(r.json.target, 'http://private.example/', '响应里要带上被拒的目标');
    }

    // 断言 7b：DoH 解析失败 → 保守拒绝（不放行未知地址）
    {
        const r = await proxyRequest('http://broken.example/');
        assert.equal(r.status, 403, '解析失败应保守拒绝');
        assert.ok(/解析/.test(r.json.reason), `原因应写明解析失败: ${r.json.reason}`);
    }

    // 断言 7c：解析结果走模块级缓存（同一个 host 不重复查 DoH）
    {
        const before = dohCalls;
        await proxyRequest('https://public.example/');
        const first = dohCalls - before;
        await proxyRequest('https://public.example/');
        const second = dohCalls - before - first;
        assert.ok(first > 0, '首次应发生 DoH 查询');
        assert.equal(second, 0, '60 秒 TTL 内不应重复查 DoH');
    }

    // 断言 8a：重定向到私网 → 逐跳校验拦下
    {
        const r = await proxyRequest('https://redirect.example/');
        assert.equal(r.status, 403, '重定向到私网应被拒');
        assert.equal(r.json.target, 'http://127.0.0.1/', '应指出真正被拒的那一跳');
    }

    // 断言 8b：重定向超过 3 跳 → 拒绝
    {
        const r = await proxyRequest('https://loop1.example/');
        assert.equal(r.status, 403, '重定向跳数过多应被拒');
        assert.ok(/重定向/.test(r.json.reason), `原因应写明重定向跳数: ${r.json.reason}`);
    }

    // 断言 8c：正常公网目标放行（不误伤）
    {
        const r = await proxyRequest('https://public.example/');
        assert.equal(r.status, 200, '公网目标不应被拦');
        assert.equal(r.text, 'ok');
    }

    // 断言 8d：非 http(s) 协议 → 400（协议白名单）
    {
        const r = await proxyRequest('file:///etc/passwd', { raw: true });
        assert.equal(r.status, 400, 'file: 应被 400 拒绝');
    }

    globalThis.fetch = realFetch;
    console.log('proxy-ssrf.test.js: 全部断言通过 ✓');
})().catch(err => {
    globalThis.fetch = realFetch;
    console.error(err);
    process.exit(1);
});
