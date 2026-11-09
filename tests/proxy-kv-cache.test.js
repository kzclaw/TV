// 代理 KV 缓存策略自检：node tests/proxy-kv-cache.test.js
// 全程不碰网络：只测「该不该缓存 / 该不该写 KV」的判定。
//   断言 1：媒体文件判定（扩展名 + content-type）
//   断言 2：缓存判定 —— Range 请求、媒体文件都不进 KV
//   断言 3：写 KV 判定 —— JSON 不写（60 秒 TTL 写了就扔，白吃写/删额度）
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

    console.log('proxy-kv-cache.test.js: 全部断言通过 ✓');
})().catch(err => {
    console.error(err);
    process.exit(1);
});
