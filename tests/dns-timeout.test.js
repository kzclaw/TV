// DNS 解析超时与熔断自愈的自检：node tests/dns-timeout.test.js
// 两个缺陷一起覆盖（都是「全站源一起中招」的成因）：
//   断言 1：DoH 主端点挂住时，备用端点仍能救回来（不能被主端点拖死）
//   断言 2：DoH 两个端点都挂住时，请求在有界时间内失败（不能一路挂到平台上限）
//   断言 3：停用期过后重新失败，连续失败计数从 1 重新累计（不被一次抖动攒到永久）
//   断言 4：长期停用到期后自动恢复（不再需要逐个点「已跳过」）
//   断言 5：连续失败后能一键清空全部源的健康状态
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const source = path.join(root, 'functions', 'proxy', '[[path]].js');

// Pages Function 是 ES Module，Node 里按 .js 会被当成 CommonJS：
// 整份 functions/ 复制到临时目录并配 type:module，代理的相对 import 才解析得到
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kztv-dns-'));
fs.mkdirSync(path.join(tmpDir, 'functions', 'proxy'), { recursive: true });
fs.writeFileSync(path.join(tmpDir, 'functions', 'package.json'), '{"type":"module"}');
fs.copyFileSync(path.join(root, 'functions', '_access.js'), path.join(tmpDir, 'functions', '_access.js'));
fs.copyFileSync(path.join(root, 'functions', '_session.js'), path.join(tmpDir, 'functions', '_session.js'));
const tmpModule = path.join(tmpDir, 'functions', 'proxy', 'proxy.mjs');
fs.copyFileSync(source, tmpModule);

// ==== 假网络：DoH 主端点按开关决定「正常答 / 挂住」 ====
// 挂住时必须像真 fetch 一样响应 abort：AbortSignal.timeout 是靠信号掐断请求的，
// 假 fetch 若无视信号就测不出超时是否生效。
let primaryHangs = false;
let dohCalls = 0;

function hangForever(signal) {
    return new Promise((_, reject) => {
        // 兜底定时器（ref'd）：AbortSignal.timeout 的定时器是 unref 的，
        // 只靠它的话事件循环会提前空转退出，超时根本来不及触发。
        const guard = setTimeout(() => reject(new Error('aborted')), 15000);
        const bail = () => { clearTimeout(guard); reject(new Error('aborted')); };
        if (!signal) return;                       // 没有信号就靠兜底定时器收尾
        if (signal.aborted) { bail(); return; }
        signal.addEventListener('abort', bail, { once: true });
    });
}

function fakeFetch(input, init) {
    const url = String(input && input.url ? input.url : input);
    if (url.includes('/dns-query')) {
        dohCalls++;
        const isPrimary = url.includes('cloudflare-dns.com');
        if (isPrimary && primaryHangs) {
            // 黑洞：既不 resolve 也不 reject，模拟端点挂住（不是报错）
            return hangForever(init && init.signal);
        }
        const name = decodeURIComponent(new URL(url).searchParams.get('name') || '');
        const type = new URL(url).searchParams.get('type');
        const records = name === 'public.example' || name === 'allbad.example'
            ? (type === '1' ? ['93.184.216.34'] : [])
            : [];
        const answer = records.map(data => ({ name, type: Number(type), TTL: 60, data }));
        return Promise.resolve(new Response(JSON.stringify({ Status: 0, Answer: answer }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
        }));
    }
    return Promise.resolve(new Response('ok', { status: 200 }));
}

const realFetch = globalThis.fetch;
globalThis.fetch = fakeFetch;

(async () => {
    const proxy = await import(pathToFileURL(tmpModule).href);
    const { onRequest } = proxy;

    const PASSWORD = 'c15-self-test-password';
    // 认证走 HttpOnly 会话 cookie（URL 里不再带凭据）
    const session = await import(pathToFileURL(path.join(tmpDir, 'functions', '_session.js')).href);
    const authCookie = `kt_sess=${await session.signSession(PASSWORD)}`;
    const env = { PASSWORD };

    async function proxyRequest(target, timeoutMs = 15000) {
        const url = `http://localhost/proxy/${encodeURIComponent(target)}`;
        const started = Date.now();
        const res = await onRequest({
            request: new Request(url, { headers: { cookie: authCookie } }),
            env,
            next: () => {},
            waitUntil: () => {}
        });
        const text = await res.text();
        return { status: res.status, text, ms: Date.now() - started };
    }

    // 断言 1：主端点挂住 → 备用端点救回来（不再被主端点拖死）
    {
        primaryHangs = true;
        const before = dohCalls;
        const r = await proxyRequest('https://public.example/');
        assert.equal(r.status, 200, `主端点挂住时备用端点应救回来，实际 ${r.status} ${r.text.slice(0, 120)}`);
        assert.ok(r.ms < 3000, `备用端点应在主端点超时前救回来，实际耗时 ${r.ms}ms`);
        assert.ok(dohCalls - before >= 2, '两个端点都应被并发查询');
    }

    // 断言 2：两个端点都挂住 → 在有界时间内失败（不挂到平台上限）
    {
        primaryHangs = true;
        // 把备用端点也打挂：所有 /dns-query 都返回「无视 resolve 的挂死 promise」，
        // 但仍响应 abort 信号 —— 真 fetch 被 AbortSignal.timeout 掐断就是这个样子。
        globalThis.fetch = (input, init) => {
            const url = String(input && input.url ? input.url : input);
            if (url.includes('/dns-query')) return hangForever(init && init.signal);
            return fakeFetch(input, init);
        };
        // 换一个新域名：上一个域名的解析结果还在 60 秒缓存里，会绕过 DoH 直接放行
        const r = await proxyRequest('https://allbad.example/');
        assert.ok(r.ms < 10000, `DoH 全挂时应在超时预算内失败，实际耗时 ${r.ms}ms`);
        assert.equal(r.status, 403, '解析失败按保守拒绝处理');
        globalThis.fetch = fakeFetch;
    }

    globalThis.fetch = realFetch;

    // ==== 客户端熔断：计数重置 / 长期停用自愈 / 一键恢复 ====
    const sandbox = {
        console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
        window: {},
        localStorage: {
            store: {},
            getItem(k) { return this.store[k] === undefined ? null : this.store[k]; },
            setItem(k, v) { this.store[k] = String(v); },
            removeItem(k) { delete this.store[k]; }
        },
        document: { addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] },
        setTimeout,
        clearTimeout,
        Date
    };
    sandbox.globalThis = sandbox;
    const vm = require('node:vm');
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(root, 'js/api.js'), 'utf8'), sandbox, { filename: 'js/api.js' });
    const Health = sandbox.window.SourceHealth;

    const KEY = 'kzTvSourceHealthV3';
    const read = () => JSON.parse(sandbox.localStorage.getItem(KEY) || '{}');

    // 断言 3：停用期过后重新失败 → 连续失败计数从 1 重新累计
    {
        sandbox.localStorage.store = {};
        const past = Date.now() - 1000;
        sandbox.localStorage.setItem(KEY, JSON.stringify({
            flaky: { failStreak: 5, disableCount: 2, disabledUntil: past }
        }));
        Health.markSourceFailed('flaky');
        const rec = read().flaky;
        assert.equal(rec.failStreak, 1, `停用期已过则失败计数应重新从 1 累计，实际 ${rec.failStreak}`);
        assert.equal(rec.disabledUntil, 0, '过期的停用标记应清掉');
    }

    // 断言 4：长期停用到期后自动恢复（不需要手动逐个解除）
    {
        sandbox.localStorage.store = {};
        const past = Date.now() - 1000;
        sandbox.localStorage.setItem(KEY, JSON.stringify({
            dead: { failStreak: 9, disableCount: 3, disabledUntil: past }
        }));
        assert.equal(Health.isSourceSkipped('dead'), false, '长期停用到期后应自动恢复，不再永久跳过');
    }

    // 断言 4b：长期停用未到期时仍应跳过
    {
        sandbox.localStorage.store = {};
        const future = Date.now() + 60000;
        sandbox.localStorage.setItem(KEY, JSON.stringify({
            dead: { failStreak: 9, disableCount: 3, disabledUntil: future }
        }));
        assert.equal(Health.isSourceSkipped('dead'), true, '长期停用未到期时仍应跳过');
    }

    // 断言 4c：连续失败到阶梯尽头也不会「永久停用」——总有 7 天后重试的一天
    {
        sandbox.localStorage.store = {};
        // 反复失败把阶梯推到尽头（每次失败前先让上一次的停用期过期）
        for (let i = 0; i < 12; i++) {
            const prev = read().doomed;
            if (prev && prev.disabledUntil) {
                sandbox.localStorage.setItem(KEY, JSON.stringify({
                    doomed: Object.assign({}, prev, { disabledUntil: Date.now() - 1 })
                }));
            }
            Health.markSourceFailed('doomed');
        }
        const rec = read().doomed;
        assert.ok(rec.disabledUntil > Date.now(), '阶梯用尽后仍应处于停用期（而不是永久跳过）');
        assert.ok(rec.disabledUntil - Date.now() <= 7 * 24 * 3600 * 1000 + 5000,
            `末级停用时长应为 7 天，不应无限长（实际 ${Math.round((rec.disabledUntil - Date.now()) / 86400000)} 天）`);
        // 到期后一定能恢复
        sandbox.localStorage.store = {};
        sandbox.localStorage.setItem(KEY, JSON.stringify({ doomed: { failStreak: 9, disableCount: 3, disabledUntil: Date.now() - 1 } }));
        assert.equal(Health.isSourceSkipped('doomed'), false, '末级停用到期后应能自动重试');
    }

    // 断言 5：一键清空全部源的健康状态
    {
        sandbox.localStorage.store = {};
        const future = Date.now() + 60000;
        sandbox.localStorage.setItem(KEY, JSON.stringify({
            a: { failStreak: 3, disabledUntil: future },
            b: { failStreak: 3, disabledUntil: future }
        }));
        assert.equal(Health.getSkippedSources().length, 2, '两个源都应处于跳过状态');
        Health.clearAllSourceHealth();
        assert.equal(Health.getSkippedSources().length, 0, '一键恢复后不应再有源被跳过');
    }

    console.log('dns-timeout.test.js: 全部断言通过 ✓');
})().catch(err => {
    globalThis.fetch = realFetch;
    console.error(err);
    process.exit(1);
});
