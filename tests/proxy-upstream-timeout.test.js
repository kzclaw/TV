// 出网超时与缓存分级的自检：node tests/proxy-upstream-timeout.test.js
// 覆盖三个缺陷（都是「连接相关」的）：
//   断言 1：源站挂住时，代理必须在有界时间内失败（不能一路挂到平台上限）
//   断言 2：出网的 fetch 必须带上 signal（没有它，超时形同虚设）
//   断言 3：客户端断开时，出网请求要跟着中止（不能继续占着连接）
//   断言 4：JSON 响应即便用 text/html 送达，也要按短缓存走（搜索结果不能缓存一天）
//   断言 5：媒体响应仍走长缓存
//   断言 6：出网信号 = 硬超时 ∪ 客户端断开（任一触发都中止）
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const source = path.join(root, 'functions', 'proxy', '[[path]].js');

// Pages Function 是 ES Module，Node 里按 .js 会被当成 CommonJS：复制成 .mjs 再 import
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kztv-upstream-'));
const tmpModule = path.join(tmpDir, 'proxy.mjs');
fs.copyFileSync(source, tmpModule);

const crypto = require('node:crypto');

// ==== 假网络 ====
// 源站按开关决定「正常答 / 挂住」；挂住时必须像真 fetch 一样响应 abort，
// 否则测不出超时是否真的生效。
let upstreamMode = 'hang';   // 'hang' | 'json' | 'media'
let upstreamCalls = [];
let lastUpstreamInit = null;

function hangForever(signal) {
    return new Promise((_, reject) => {
        // 兜底定时器（ref'd）：AbortSignal.timeout 的定时器是 unref 的，
        // 只靠它的话事件循环会提前空转退出，超时根本来不及触发。
        const guard = setTimeout(() => reject(new Error('aborted')), 20000);
        const bail = () => { clearTimeout(guard); reject(new Error('aborted')); };
        if (!signal) return;
        if (signal.aborted) { bail(); return; }
        signal.addEventListener('abort', bail, { once: true });
    });
}

function fakeFetch(input, init) {
    const url = String(input && input.url ? input.url : input);
    if (url.includes('/dns-query')) {
        // 正常回答 DoH：否则 SSRF 校验会先失败，测不到出网这一段
        const type = new URL(url).searchParams.get('type');
        const answer = type === '1' ? [{ name: 'h', type: 1, TTL: 60, data: '93.184.216.34' }] : [];
        return Promise.resolve(new Response(JSON.stringify({ Status: 0, Answer: answer }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
        }));
    }
    upstreamCalls.push(url);
    lastUpstreamInit = init || {};
    if (upstreamMode === 'hang') return hangForever(init && init.signal);
    if (upstreamMode === 'json') {
        // 采集站的常态：用 text/html 送 JSON
        return Promise.resolve(new Response(JSON.stringify({ code: 200, list: [{ vod_id: 1 }] }), {
            status: 200, headers: { 'Content-Type': 'text/html;charset=utf-8' }
        }));
    }
    // 媒体：二进制分片
    return Promise.resolve(new Response(new Uint8Array([0x47, 0x40, 0x11, 0x10]), {
        status: 200, headers: { 'Content-Type': 'video/mp2t' }
    }));
}

const realFetch = globalThis.fetch;
globalThis.fetch = fakeFetch;

(async () => {
    const proxy = await import(pathToFileURL(tmpModule).href);
    const { onRequest, buildUpstreamSignal, isJsonPayload, DEFAULT_UPSTREAM_TIMEOUT_MS } = proxy;

    const PASSWORD = 'c15-self-test-password';
    const authHash = crypto.createHash('sha256').update(PASSWORD).digest('hex');

    async function proxyRequest(target, envExtra, requestInit) {
        const url = `http://localhost/proxy/${encodeURIComponent(target)}?auth=${authHash}`;
        const started = Date.now();
        const res = await onRequest({
            request: new Request(url, requestInit),
            env: Object.assign({ PASSWORD }, envExtra || {}),
            next: () => {},
            waitUntil: () => {}
        });
        const text = await res.text();
        return { status: res.status, text, ms: Date.now() - started, headers: res.headers };
    }

    // 断言 6：出网信号 = 硬超时 ∪ 客户端断开
    {
        const client = new AbortController();
        const merged = buildUpstreamSignal(client.signal, 5000);
        assert.equal(merged.aborted, false, '合并信号初始不应处于中止状态');
        client.abort();
        assert.equal(merged.aborted, true, '客户端断开后合并信号应中止');

        const only = buildUpstreamSignal(null, 120);
        assert.equal(only.aborted, false, '无客户端信号时只应有超时信号');
        await new Promise(r => setTimeout(r, 250));
        assert.equal(only.aborted, true, '超过超时预算后信号应中止');
    }

    // 断言 0（回归防护）：默认出网死线必须大于客户端最长的死线（搜索单源 10s）
    // —— 代理是兜底不是抢占者：死线比客户端短会把「本来能答完」的源掐成失败
    //    （实测：8s 死线把 3/4 个默认源掐成「没响应」，搜不到结果）。
    assert.ok(DEFAULT_UPSTREAM_TIMEOUT_MS > 10000,
        `默认出网死线应大于客户端搜索死线 10s，实际 ${DEFAULT_UPSTREAM_TIMEOUT_MS}ms`);

    // 断言 1 + 2：源站挂住 → 有界时间内失败，且出网请求确实带了 signal
    {
        upstreamMode = 'hang';
        upstreamCalls = [];
        const r = await proxyRequest('https://hang.example/a', { UPSTREAM_TIMEOUT_MS: '300' });
        assert.ok(r.ms < 3000, `源站挂住时应在超时预算内失败，实际耗时 ${r.ms}ms`);
        assert.equal(r.status, 500, '源站挂住应返回明确状态码，而不是静默挂着');
        assert.ok(upstreamCalls.length >= 1, '应实际发出过出网请求');
        assert.ok(lastUpstreamInit.signal, '出网请求必须带 signal，否则超时不会生效');
    }

    // 断言 3：客户端断开 → 出网请求跟着中止
    {
        upstreamMode = 'hang';
        upstreamCalls = [];
        const controller = new AbortController();
        const started = Date.now();
        const pending = proxyRequest('https://disconnect.example/b', { UPSTREAM_TIMEOUT_MS: '10000' }, {
            signal: controller.signal
        });
        setTimeout(() => controller.abort(), 60);
        const r = await pending;
        const elapsed = Date.now() - started;
        assert.ok(elapsed < 3000, `客户端断开后应很快收尾，实际耗时 ${elapsed}ms`);
        assert.ok(lastUpstreamInit.signal, '出网请求必须带 signal');
        assert.equal(lastUpstreamInit.signal.aborted, true, '客户端断开后出网信号应处于中止状态');
        assert.equal(r.status, 500, '客户端断开后应返回明确状态码');
    }

    // 断言 4：JSON 即使用 text/html 送达，也要按短缓存走
    {
        upstreamMode = 'json';
        const r = await proxyRequest('https://json.example/c?ac=videolist&pg=1', { CACHE_TTL: '86400' });
        assert.equal(r.status, 200, `JSON 请求应成功，实际 ${r.status} ${r.text.slice(0, 120)}`);
        const cc = r.headers.get('cache-control') || '';
        assert.ok(cc.includes('max-age=60'), `JSON 应按 60s 缓存，实际 ${cc}`);
    }

    // 断言 5：媒体响应仍走长缓存
    {
        upstreamMode = 'media';
        const r = await proxyRequest('https://media.example/d/1.ts', { CACHE_TTL: '86400' });
        assert.equal(r.status, 200, `媒体请求应成功，实际 ${r.status} ${r.text.slice(0, 120)}`);
        const cc = r.headers.get('cache-control') || '';
        assert.ok(cc.includes('max-age=86400'), `媒体应沿用长缓存，实际 ${cc}`);
    }

    // 断言 4b：JSON 判定纯函数（不看 content-type，看 body 首字符）
    {
        assert.equal(isJsonPayload(new TextEncoder().encode('  {"a":1}'), 'text/html'), true,
            'text/html 送 JSON 应被认出来');
        assert.equal(isJsonPayload(new TextEncoder().encode('\n [1,2]'), 'text/plain'), true,
            '数组体应被认出来');
        assert.equal(isJsonPayload(new TextEncoder().encode('#EXTM3U'), 'application/vnd.apple.mpegurl'), false,
            'm3u8 不应被认成 JSON');
        assert.equal(isJsonPayload(new Uint8Array([0x47, 0x40]), 'video/mp2t'), false,
            '二进制分片不应被认成 JSON');
        assert.equal(isJsonPayload(null, 'application/json'), true, 'content-type 是 json 时应直接认出来');
    }

    globalThis.fetch = realFetch;
    console.log('proxy-upstream-timeout.test.js: 全部断言通过 ✓');
})().catch(err => {
    globalThis.fetch = realFetch;
    console.error(err);
    process.exit(1);
});
