// 搜索链路跳过「仅列表」源的自检：node tests/search-listonly.test.js
// 断言 1：listOnly 源在搜索时一个请求都不发（省时间、不空转）。
// 断言 2：普通源照常发搜索请求（别把搜索面削没了）。
// 断言 3：最近更新链路照常包含 listOnly 源（它们只是搜不了，列表还能用）。
// 断言 4：最近更新覆盖**全部预设源**（不只是设置里勾选的那几个）：
//         它是聚合首页的主体内容，勾选只决定"搜索"的范围。
// 断言 5：最近更新是限并发并行的（不能串行 —— 25 个源串行要等好几分钟）。
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
    document: {
        addEventListener() {},
        getElementById: () => null,
        querySelectorAll: () => []
    },
    fetch: async (url) => {
        requests.push(String(url));
        return {
            ok: true,
            status: 200,
            json: async () => ({ code: 1, page: 1, pagecount: 1, total: 0, list: [] })
        };
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

const API_SITES = sandbox.window.API_SITES;
const allKeys = Object.keys(API_SITES);
const listOnlyKeys = allKeys.filter(k => API_SITES[k].listOnly);
const normalKeys = allKeys.filter(k => !API_SITES[k].listOnly);

// 请求记录里的 URL 形如 /proxy/<encodeURIComponent(原始接口地址)>
const requestedApis = () => requests.map(u => decodeURIComponent(String(u).replace(/^\/proxy\//, '')));
const requestedFor = (key) => requestedApis().filter(u => u.startsWith(API_SITES[key].api));

(async () => {
    // 前提：7 个源被标记为仅列表
    assert.equal(listOnlyKeys.length, 7, '应有 7 个 listOnly 源');

    // 断言 1 + 2：搜索链路只对非 listOnly 源发请求
    requests.length = 0;
    const probeKeys = [...listOnlyKeys, ...normalKeys.slice(0, 3)];
    for (const key of probeKeys) {
        await sandbox.searchByAPIAndKeyWord(key, '流浪地球');
    }
    for (const key of listOnlyKeys) {
        assert.equal(requestedFor(key).length, 0, `${key} 是 listOnly 源，搜索时不应发请求`);
    }
    for (const key of normalKeys.slice(0, 3)) {
        assert.ok(requestedFor(key).length > 0, `${key} 是普通源，搜索时应该发请求`);
    }
    assert.equal(requests.length, normalKeys.slice(0, 3).length, '搜索请求数应等于普通源数');

    // 断言 3 + 4：最近更新照常包含 listOnly 源，且覆盖全部预设源
    requests.length = 0;
    await sandbox.handleLatestUpdates();
    for (const key of listOnlyKeys) {
        assert.ok(requestedFor(key).length > 0, `${key} 是 listOnly 源，最近更新仍应请求它`);
    }
    const touched = new Set(requests.map(u => {
        const raw = decodeURIComponent(String(u).replace(/^\/proxy\//, ''));
        const key = allKeys.find(k => raw.startsWith(API_SITES[k].api));
        return key;
    }).filter(Boolean));
    assert.equal(touched.size, allKeys.length,
        `最近更新应覆盖全部 ${allKeys.length} 个预设源，实际只覆盖 ${touched.size} 个`);

    // 断言 5：限并发并行（串行 25 个源 = 分钟级）
    // 用一个可控的慢 fetch 验证：25 个源串行要 25×N 秒，并发 6 只要约 ceil(25/6)×N 秒。
    const realFetch = sandbox.fetch;
    const delay = 120;
    sandbox.fetch = async (url) => {
        await new Promise(r => setTimeout(r, delay));
        return realFetch(url);
    };
    const t0 = Date.now();
    await sandbox.handleLatestUpdates();
    const elapsed = Date.now() - t0;
    sandbox.fetch = realFetch;
    const serial = allKeys.length * delay;
    assert.ok(elapsed < serial / 2,
        `最近更新应并行（串行约 ${serial}ms，实际 ${elapsed}ms）`);

    console.log(`OK: ${listOnlyKeys.length} 个 listOnly 源在搜索时 0 请求，普通源正常请求，最近更新覆盖全部 ${allKeys.length} 个源且并行（${elapsed}ms < 串行 ${serial}ms）`);
})().catch(err => {
    console.error(err);
    process.exit(1);
});
