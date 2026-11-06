// 搜索链路（翻页上限 / 单源死线 / 失败源可见）的自检：node tests/search-pipeline.test.js
// 全部用打桩的 fetch，不发真实请求。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const requests = [];

// 打桩：/proxy/<编码后的源地址>
//   - 源地址里带 guangsuapi（ruyi 源）→ 永不返回（测单源死线）
//   - pg=N → 返回第 N 页的一条
const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    window: {},
    localStorage: {
        store: {},
        getItem(k) { return this.store[k] === undefined ? null : this.store[k]; },
        setItem(k, v) { this.store[k] = String(v); }
    },
    document: {
        addEventListener() {},
        getElementById: () => null,
        querySelectorAll: () => []
    },
    fetch: (url) => {
        const target = decodeURIComponent(String(url).replace(/^\/proxy\//, ''));
        requests.push(target);
        if (target.includes('guangsuapi')) {
            return new Promise(() => {});   // 永不 settle：靠死线放弃
        }
        const page = Number((target.match(/pg=(\d+)/) || [])[1] || 1);
        return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
                code: 1,
                page,
                pagecount: 20,                 // 源站声称有 20 页
                total: 400,
                list: [{
                    vod_id: `id-${page}`,
                    vod_name: page === 1 ? '庆余年' : `庆余年第${page}页`,
                    vod_year: '2026',
                    vod_time: '2026-11-01 10:00:00',
                    vod_remarks: ''
                }]
            })
        });
    },
    setTimeout,
    clearTimeout,
    AbortController,
    URL,
    encodeURIComponent,
    decodeURIComponent
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

for (const file of ['js/config.js', 'js/aggregate.js', 'js/api.js', 'js/search.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
}

// 死线在测试里缩短到 300ms（生产值是 API_CONFIG.search.sourceTimeout = 10s）
vm.runInContext('API_CONFIG.search.sourceTimeout = 300;', sandbox);

// 1) 翻页上限：源站说有 20 页，实际只取 5 页（API_CONFIG.search.maxPages）
(async () => {
    requests.length = 0;
    const outcome = await sandbox.searchByAPIAndKeyWord('bfzy', '庆余年');
    const pages = requests.map(u => Number((u.match(/pg=(\d+)/) || [])[1] || 1)).sort();
    assert.deepEqual(pages, [1, 2, 3, 4, 5], `每源最多 5 页，实际请求了 ${pages.join(',')}`);
    assert.equal(outcome.failed, false, '正常源不应算失败');
    assert.equal(outcome.list.length, 5, '应拿到 5 页的结果');
    assert.equal(outcome.sourceName, '暴风资源', '失败/成功信息要带源名');

    // 2) 单源死线：慢源到点整体放弃（不是只放弃那一页）
    requests.length = 0;
    const slow = await sandbox.searchByAPIAndKeyWord('ruyi', '庆余年');
    assert.equal(slow.failed, true, '超时源应标记为没响应');
    assert.equal(slow.list.length, 0, '超时的源要整体放弃，不返回半截结果');
    assert.ok(/超时/.test(slow.reason), `原因应写明超时: ${slow.reason}`);

    // 3) 超时源要进熔断（失败计数 +1），正常源不算失败
    const store = JSON.parse(sandbox.localStorage.getItem('kzTvSourceHealthV2') || '{}');
    assert.ok(store.ruyi && store.ruyi.failStreak >= 1, '超时源应计入熔断计数');

    // 4) listOnly 源不算失败（它本来就搜不了，不该出现在「没响应」提示里）
    const listOnly = await sandbox.searchByAPIAndKeyWord('tyyszy', '庆余年');
    assert.equal(listOnly.failed, false, 'listOnly 源不算没响应');
    assert.equal(listOnly.list.length, 0);

    // 5) 失败源可见：调用方能拿到 failures 列表（app.js 顶部提示「N 个源没响应」）
    const results = await Promise.all([
        sandbox.searchByAPIAndKeyWord('bfzy', '庆余年'),
        sandbox.searchByAPIAndKeyWord('ruyi', '庆余年')
    ]);
    const failures = results.filter(r => r.failed);
    assert.equal(failures.length, 1, '应能识别出 1 个没响应的源');
    assert.ok(failures[0].sourceName, '失败项要带源名，页面提示才说得清是谁');

    console.log('search-pipeline.test.js: 全部断言通过 ✓');
})().catch(err => {
    console.error(err);
    process.exit(1);
});
