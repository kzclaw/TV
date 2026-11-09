// 代理 KV 缓存策略自检：node tests/proxy-kv-cache.test.js
// 前三组不碰网络；第四组用假 fetch + 假 KV 跑真 onRequest，验证「KV 写失败」的处理。
//   断言 1：媒体文件判定（扩展名 + content-type）
//   断言 2：缓存判定 —— Range 请求、媒体文件都不进 KV
//   断言 3：写 KV 判定 —— JSON 不写（60 秒 TTL 写了就扔，白吃写/删额度）
//   断言 4：KV 写失败（写额度被封时是 429）不能变成未处理拒绝，响应也不受影响
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const source = path.join(root, 'functions', 'proxy', '[[path]].js');

// Pages Function 是 ES Module，Node 里按 .js 会被当成 CommonJS：
// 整份 functions/ 复制到临时目录并配 type:module，代理的相对 import 才解析得到
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kztv-kv-'));
fs.mkdirSync(path.join(tmpDir, 'functions', 'proxy'), { recursive: true });
fs.writeFileSync(path.join(tmpDir, 'functions', 'package.json'), '{"type":"module"}');
fs.copyFileSync(path.join(root, 'functions', '_access.js'), path.join(tmpDir, 'functions', '_access.js'));
fs.copyFileSync(path.join(root, 'functions', '_session.js'), path.join(tmpDir, 'functions', '_session.js'));
const tmpModule = path.join(tmpDir, 'functions', 'proxy', 'proxy.mjs');
fs.copyFileSync(source, tmpModule);

const enc = (s) => new TextEncoder().encode(s);

// KV 绑定名从代理源码里取，测试里不硬编码 —— CI 的品牌门禁对 tests/ 是严格的
const KV_BINDING = (fs.readFileSync(source, 'utf8').match(/env\.([A-Z0-9_]+_KV)/) || [])[1];
assert.ok(KV_BINDING, '应能从代理源码里取到 KV 绑定名');

(async () => {
    const proxy = await import(pathToFileURL(tmpModule).href);
    const { isMediaFile, shouldCacheInKV, shouldWriteToKV } = proxy;

    // 断言 1：媒体文件判定
    assert.equal(isMediaFile('https://x/seg/1.ts'), true, '.ts 分片是媒体文件');
    assert.equal(isMediaFile('https://x/seg/1.ts?token=abc'), true, '带查询参数的分片也是媒体文件');
    assert.equal(isMediaFile('https://x/movie.mp4'), true, '.mp4 是媒体文件');
    assert.equal(isMediaFile('https://x/cover.jpg'), true, '.jpg 是媒体文件');
    assert.equal(isMediaFile('https://x/hls/index.m3u8'), false, 'm3u8 是播放列表，不是媒体文件');
    assert.equal(isMediaFile('https://x/vod/detail/1.html'), false, '详情页不是媒体文件');
    assert.equal(isMediaFile('https://x/api.php?ac=videolist'), false, 'CMS 接口不是媒体文件');
    assert.equal(isMediaFile('https://x/seg', 'video/mp2t'), true, 'content-type 是 video/ 也是媒体文件');

    // 断言 2：缓存判定
    assert.equal(shouldCacheInKV('https://x/vod/detail/1.html', null), true, '普通上游响应照常缓存');
    assert.equal(shouldCacheInKV('https://x/hls/index.m3u8', null), true, 'm3u8 仍然缓存');
    assert.equal(shouldCacheInKV('https://x/seg/1.ts', null), false, '媒体文件不进 KV');
    assert.equal(shouldCacheInKV('https://x/vod/detail/1.html', 'bytes=0-1023'), false, 'Range 请求不进 KV');

    // 断言 3：写 KV 判定
    assert.equal(shouldWriteToKV(enc('{"code":1,"list":[]}'), 'application/json'), false, 'JSON 不写 KV');
    assert.equal(shouldWriteToKV(enc('<html>ok</html>'), 'text/html'), true, 'HTML 照常写 KV');
    // 采集站普遍用 text/html 送 JSON（实测 21/24 个源如此）→ 只能靠 body 首个非空白字符判定
    assert.equal(shouldWriteToKV(enc('  {"code":1}'), 'text/html'), false, 'text/html 装的 JSON 也不写 KV');
    assert.equal(shouldWriteToKV(enc('[{"a":1}]'), 'text/plain'), false, '数组也是 JSON');
    assert.equal(shouldWriteToKV(enc('#EXTM3U'), 'application/vnd.apple.mpegurl'), true, 'm3u8 照常写 KV');

    // ==== 断言 4：KV 写失败的处理（要跑真 onRequest，所以要假 fetch 和会话 cookie）====
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
        const url = String(input && input.url ? input.url : input);
        if (url.includes('/dns-query')) {
            const name = decodeURIComponent(new URL(url).searchParams.get('name'));
            return new Response(JSON.stringify({ Status: 0, Answer: [{ name, type: 1, TTL: 60, data: '93.184.216.34' }] }),
                { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('public.example')) {
            const asJson = url.includes('api.php');
            return new Response(asJson ? '{"code":1,"list":[]}' : '<html>detail</html>',
                { status: 200, headers: { 'Content-Type': asJson ? 'application/json' : 'text/html' } });
        }
        throw new Error('未打桩: ' + url);
    };

    try {
        const session = await import(pathToFileURL(path.join(tmpDir, 'functions', '_session.js')).href);
        const PASSWORD = 'test-password';
        const authCookie = `kt_sess=${await session.signSession(PASSWORD)}`;

        // waitUntil 的假实现：模拟 runtime —— 交给它的 promise 若 reject 且前面没人接住，
        // 就记成「未处理拒绝」（真 runtime 会把它当这次调用的未捕获异常）。
        async function requestWithFailingKV(target, kv) {
            const unhandled = [];
            const res = await proxy.onRequest({
                request: new Request(`http://localhost/proxy/${encodeURIComponent(target)}`, { headers: { cookie: authCookie } }),
                env: { PASSWORD, [KV_BINDING]: kv },
                next: () => {},
                waitUntil: (p) => p.then(() => {}, (err) => unhandled.push(err))
            });
            await new Promise(r => setTimeout(r, 20)); // 让拒绝落地
            return { status: res.status, unhandled };
        }

        // 断言 4a：写被拒（429）→ 不产生未处理拒绝，响应照常 200
        {
            let putCalled = 0;
            const kv = {
                async get() { return null; },
                async put() { putCalled++; throw new Error('KV PUT failed: 429 Too Many Requests'); }
            };
            const r = await requestWithFailingKV('https://public.example/vod/detail/1.html', kv);
            assert.equal(putCalled, 1, 'HTML 响应应该真的去写 KV 了');
            assert.equal(r.status, 200, 'KV 写失败不该影响响应');
            assert.equal(r.unhandled.length, 0,
                `KV 写失败不该变成未处理拒绝: ${r.unhandled.map(String).join(' | ')}`);
        }

        // 断言 4b：JSON 响应根本不写 KV → 也就不会有机会产生未处理拒绝
        {
            let putCalled = 0;
            const kv = {
                async get() { return null; },
                async put() { putCalled++; throw new Error('KV PUT failed: 429 Too Many Requests'); }
            };
            const r = await requestWithFailingKV('https://public.example/api.php?ac=videolist', kv);
            assert.equal(r.status, 200, 'JSON 请求应正常返回');
            assert.equal(putCalled, 0, 'JSON 不写 KV，不该触发写失败');
            assert.equal(r.unhandled.length, 0, '不该有未处理拒绝');
        }
    } finally {
        globalThis.fetch = realFetch;
    }

    console.log('proxy-kv-cache.test.js: 全部断言通过 ✓');
})().catch(err => {
    console.error(err);
    process.exit(1);
});
