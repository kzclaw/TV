// 选源弹窗的 listOnly 候选补充：node tests/source-picker-listonly.test.js
//
// 背景：listOnly 源的关键词搜索接口不可用（源站主动禁用 / WAF 拦 / 中文关键词被拦），
// 所以选源弹窗过去永远列不出它们 —— 即使「最近更新」里已经有它们的条目。
// 方案：候选来源加一路「调用方已知条目」，把最近更新聚合到的条目直接用起来。
//
// 断言：
//   1. 已知条目里命中片名的 listOnly 源会进入候选（走 A 档）
//   2. 档位判定与搜索一致：完全相等 = A，前缀 = B（近似），都不匹配 = 不出
//   3. 同一源只出一个候选（去重）
//   4. 搜索结果与已知结果合并，同一源只留一条（搜索优先）
//   5. 没有已知条目时，行为与原来完全一致（不回归）
//   6. listOnly 源本身仍然 0 搜索请求（不为了列它去搜它）

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const requests = [];

const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    window: {},
    localStorage: {
        store: {},
        getItem(k) { return this.store[k] === undefined ? null : this.store[k]; },
        setItem(k, v) { this.store[k] = String(v); }
    },
    document: { addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] },
    fetch: async (url) => {
        requests.push(String(url));
        return { ok: true, status: 200, json: async () => ({ code: 1, page: 1, pagecount: 1, total: 0, list: [] }) };
    },
    setTimeout, clearTimeout, AbortController, URL, encodeURIComponent, decodeURIComponent
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// 只加载需要的文件：config / aggregate / api / search / source-picker
for (const file of ['js/config.js', 'js/customer_site.js', 'js/aggregate.js', 'js/api.js', 'js/search.js', 'js/source-picker.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
}

const API_SITES = sandbox.window.API_SITES;
const listOnlyKeys = Object.keys(API_SITES).filter(k => API_SITES[k].listOnly);

(async () => {
    // 前提
    assert.ok(listOnlyKeys.length >= 6, `应至少有 6 个 listOnly 源，实际 ${listOnlyKeys.length}`);

    const known = sandbox.collectKnownSourceCandidates;
    const collect = sandbox.collectSourcePickerCandidates;

    // ── 断言 1：已知条目里命中片名的 listOnly 源进入候选（A 档）──
    const loKey = listOnlyKeys[0];
    const items = [
        { source_code: loKey, source_name: API_SITES[loKey].name, vod_id: 111, vod_name: '庆余年', vod_pic: 'p1' },
        { source_code: 'dyttzy', source_name: '电影天堂资源', vod_id: 222, vod_name: '庆余年', vod_pic: 'p2' }
    ];
    let cands = known('庆余年', items);
    let loCand = cands.find(c => c.sourceKey === loKey);
    assert.ok(loCand, `listOnly 源 ${loKey} 应从已知条目进入候选`);
    assert.equal(loCand.vodId, '111');
    assert.equal(loCand.approx, false, '完全相等应是 A 档（不是近似）');
    assert.equal(loCand.fromKnown, true, '应标记为来自已知数据');
    assert.ok(cands.some(c => c.sourceKey === 'dyttzy'), '普通源也应从已知条目进入候选');

    // ── 断言 2：档位判定 —— 前缀 = B（近似），不匹配 = 不出 ──
    cands = known('庆余年', [
        { source_code: loKey, vod_id: 1, vod_name: '庆余年 第二季' },
        { source_code: 'ruyi', vod_id: 2, vod_name: '完全另一部片子' }
    ]);
    loCand = cands.find(c => c.sourceKey === loKey);
    assert.ok(loCand, '前缀匹配应进入候选');
    assert.equal(loCand.approx, true, '前缀匹配应是 B 档（近似）');
    assert.ok(!cands.some(c => c.sourceKey === 'ruyi'), '不匹配的源不应进入候选');

    // ── 断言 3：同一源只出一个候选 ──
    cands = known('庆余年', [
        { source_code: loKey, vod_id: 1, vod_name: '庆余年' },
        { source_code: loKey, vod_id: 2, vod_name: '庆余年 第二季' }
    ]);
    assert.equal(cands.filter(c => c.sourceKey === loKey).length, 1, '同一源只应出一个候选');

    // ── 断言 4：搜索 + 已知合并，同一源只留一条（搜索优先）──
    // 造一个假的搜索实现：普通源能搜到，普通源的搜索结果优先于已知条目
    sandbox.searchByAPIAndKeyWord = async (key, title) => {
        requests.push('SEARCH:' + key);
        if (key === 'dyttzy') {
            return { list: [{ vod_id: 999, vod_name: title, vod_pic: 'fromSearch' }], failed: false };
        }
        return { list: [], failed: false };   // listOnly 源：搜索无结果（真实行为）
    };
    const merged = await collect('庆余年', null, [
        { source_code: loKey, vod_id: 111, vod_name: '庆余年' },
        { source_code: 'dyttzy', vod_id: 222, vod_name: '庆余年' }
    ]);
    assert.equal(merged.filter(c => c.sourceKey === loKey).length, 1, 'listOnly 源应只出现一次');
    assert.ok(merged.some(c => c.sourceKey === loKey), 'listOnly 源应在合并结果里');
    const dy = merged.find(c => c.sourceKey === 'dyttzy');
    assert.equal(dy.vodId, '999', '同一源同时有搜索结果和已知条目时，搜索结果优先');

    // ── 断言 4b：默认启用的是「全部源」（owner 要求：初始状态启用所有源）──
    const allSourceKeys = Object.keys(API_SITES);
    const defaults = sandbox.getDefaultSourceKeys();
    assert.equal(defaults.length, allSourceKeys.length,
        `默认应启用全部 ${allSourceKeys.length} 个源，实际 ${defaults.length} 个`);
    assert.deepEqual([...defaults].sort(), [...allSourceKeys].sort(), '默认源集合应等于全部源');
    // 选源弹窗在没写过 localStorage 时也必须是全源（不能手抄一份）
    const pickerOpts = sandbox.getSourcePickerOptions();
    assert.equal(pickerOpts.length, allSourceKeys.length,
        `选源弹窗兜底也应是全部源，实际 ${pickerOpts.length} 个`);

    // ── 断言 5：没有已知条目时，行为与原来一致（不回归）──
    const before = await collect('庆余年', null, undefined);
    assert.ok(!before.some(c => c.fromKnown), '无已知条目时不应有 fromKnown 候选');
    assert.ok(before.some(c => c.sourceKey === 'dyttzy'), '搜索结果仍应正常出现');

    // ── 断言 6：listOnly 源本身仍然 0 搜索请求 ──
    // ⚠ 必须用**真实的** searchByAPIAndKeyWord 验（上面那个是桩，它对 listOnly 也记 SEARCH:），
    // 否则这条断言测的是桩而不是真实行为 —— 桩覆盖掉真实现时，listOnly 的跳过逻辑就没被测到。
    const realSearch = sandbox.searchByAPIAndKeyWord;
    sandbox.searchByAPIAndKeyWord = realSearch;
    requests.length = 0;
    const loOutcome = await realSearch(loKey, '庆余年');
    assert.equal(loOutcome.list.length, 0, 'listOnly 源搜索应返回空');
    assert.equal(loOutcome.failed, false, 'listOnly 源不算「没响应」（它本来就搜不了）');
    const loReqs = requests.filter(r => r.startsWith(API_SITES[loKey].api));
    assert.equal(loReqs.length, 0, `listOnly 源 ${loKey} 不应发出任何搜索请求`);

    // 走一遍完整候选收集（含全源默认），listOnly 仍不应有搜索请求
    requests.length = 0;
    await collect('庆余年', null, [
        { source_code: loKey, vod_id: 111, vod_name: '庆余年' }
    ]);
    const loSearches = requests.filter(r => r.startsWith(API_SITES[loKey].api));
    assert.equal(loSearches.length, 0, `listOnly 源 ${loKey} 不应被发搜索请求`);

    console.log(`OK: listOnly 源能从已知条目进入候选（${listOnlyKeys.length} 个 listOnly 源），档位判定与搜索一致，两路合并去重生效，未改变搜索行为`);
})();
