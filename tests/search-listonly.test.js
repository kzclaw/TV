// 搜索链路跳过「仅列表」源的自检：node tests/search-listonly.test.js
// 断言 1：listOnly 源在搜索时一个请求都不发（省时间、不空转）。
// 断言 2：普通源照常发搜索请求（别把搜索面削没了）。
// 断言 3：最近更新链路照常包含 listOnly 源（它们只是搜不了，列表还能用）。
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

for (const file of ['js/config.js', 'js/api.js', 'js/search.js']) {
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

    // 断言 3：最近更新链路照常包含 listOnly 源
    requests.length = 0;
    await sandbox.handleLatestUpdates();
    for (const key of listOnlyKeys) {
        assert.ok(requestedFor(key).length > 0, `${key} 是 listOnly 源，最近更新仍应请求它`);
    }

    console.log(`OK: ${listOnlyKeys.length} 个 listOnly 源在搜索时 0 请求，普通源正常请求，最近更新仍覆盖全部源`);
})().catch(err => {
    console.error(err);
    process.exit(1);
});
