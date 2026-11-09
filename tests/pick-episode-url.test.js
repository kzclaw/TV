// 播放历史取址的自检：node tests/pick-episode-url.test.js
//
// 老历史里存的是「云解析页」地址（HTML 播放页），喂给 hls.js 必然失败；
// 播放时要改用 /api/detail 同步回来的集数地址（已自动挑过 m3u8 直链）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    window: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] },
    setTimeout, clearTimeout, Date, URL, URLSearchParams,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8'), sandbox, { filename: 'js/ui.js' });
const { pickEpisodeUrl } = sandbox;

const OLD = 'https://hn.bfvvs.com/play/av2YnD8a';                       // 老历史里的 HTML 页
const NEW = ['https://hn.bfvvs.com/play/av2YnD8a/index.m3u8',           // 同步回来的集数
             'https://hn.bfvvs.com/play/bo2v3XXa/index.m3u8'];

// 1) 有集数列表 → 用它（修好老历史）
assert.equal(pickEpisodeUrl(NEW, 0, OLD), NEW[0]);
assert.equal(pickEpisodeUrl(NEW, 1, OLD), NEW[1]);

// 2) 索引越界 → 回落旧地址（不比原来差）
assert.equal(pickEpisodeUrl(NEW, 5, OLD), OLD);

// 3) 列表为空 / 不是数组 → 回落旧地址
assert.equal(pickEpisodeUrl([], 0, OLD), OLD);
assert.equal(pickEpisodeUrl(null, 0, OLD), OLD);
assert.equal(pickEpisodeUrl(undefined, 0, OLD), OLD);

// 4) 该集是空串 → 回落旧地址
assert.equal(pickEpisodeUrl(['', ''], 0, OLD), OLD);

// 5) 索引为 undefined → 回落旧地址
assert.equal(pickEpisodeUrl(NEW, undefined, OLD), OLD);

console.log('pick-episode-url.test.js: 全部断言通过 ✓');
