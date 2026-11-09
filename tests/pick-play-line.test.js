// 播放线路自动选择的自检：node tests/pick-play-line.test.js
//
// 背景：CMS 的 vod_play_url 常给两条线 ——「云解析页」（HTML 播放页）+「m3u8 直链」。
// 前者喂给 hls.js 必然失败 → 表现为「点了播放没反应」。
// 这里验证 pickPlayLine() 会自动挑中 m3u8 直链那条，且挑不出时不会更差。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

// js/api.js 是浏览器脚本：用 vm 跑一遍，取出要测的纯函数。
const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    window: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] },
    setTimeout, clearTimeout, Date, URL, URLSearchParams,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'js/api.js'), 'utf8'), sandbox, { filename: 'js/api.js' });
const { pickPlayLine } = sandbox;

const HTML_LINE = '第01集$https://hn.bfvvs.com/play/av2YnD8a#第02集$https://hn.bfvvs.com/play/bo2v3XXa';
const M3U8_LINE = '第01集$https://hn.bfvvs.com/play/av2YnD8a/index.m3u8#第02集$https://hn.bfvvs.com/play/bo2v3XXa/index.m3u8';

// 1) 双线路：自动挑 m3u8 那条（原来恒取第 0 条 = HTML 页）
{
    const got = pickPlayLine(HTML_LINE + '$$$' + M3U8_LINE);
    // vm 沙箱里的数组是另一个 realm 的原型 → 比 JSON 而不是比对象
    assert.equal(JSON.stringify(got), JSON.stringify([
        'https://hn.bfvvs.com/play/av2YnD8a/index.m3u8',
        'https://hn.bfvvs.com/play/bo2v3XXa/index.m3u8',
    ]));
}

// 2) 反过来写（m3u8 在前）也要挑 m3u8
{
    const got = pickPlayLine(M3U8_LINE + '$$$' + HTML_LINE);
    assert.equal(got[0], 'https://hn.bfvvs.com/play/av2YnD8a/index.m3u8');
}

// 3) 单线路且就是 m3u8 → 原样返回
{
    const got = pickPlayLine(M3U8_LINE);
    assert.equal(got.length, 2);
    assert.ok(got.every(u => u.includes('.m3u8')));
}

// 4) 全是 HTML → 沿用第 0 条（不比原来差）
{
    const got = pickPlayLine(HTML_LINE);
    assert.equal(got.length, 2);
    assert.equal(got[0], 'https://hn.bfvvs.com/play/av2YnD8a');
}

// 5) 三条线，中间那条是 m3u8 → 挑中间的
{
    const got = pickPlayLine(HTML_LINE + '$$$' + M3U8_LINE + '$$$' + HTML_LINE);
    assert.ok(got[0].includes('.m3u8'));
}

// 6) 线路名不含 m3u8 但地址是 m3u8 → 照样挑中（判据看地址，不看线路名）
{
    const got = pickPlayLine('第01集$https://x.com/play/a/index.m3u8');
    assert.equal(got[0], 'https://x.com/play/a/index.m3u8');
}

// 7) 非 http 地址被过滤
{
    const got = pickPlayLine('第01集$javascript:alert(1)#第02集$https://x.com/a/index.m3u8');
    assert.equal(JSON.stringify(got), JSON.stringify(['https://x.com/a/index.m3u8']));
}

// 8) 垃圾输入不崩
for (const bad of ['', null, undefined, '$$$', '没有$号', '第01集']) {
    const got = pickPlayLine(bad);
    assert.ok(Array.isArray(got), `输入 ${JSON.stringify(bad)} 应返回数组`);
}

console.log('pick-play-line.test.js: 全部断言通过 ✓');
