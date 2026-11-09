// 测速口径的自检：node tests/source-speed.test.js
//
// 背景：原来的测速把「经本站代理取片单」和「浏览器直连播放地址」两段耗时
// 加成一个总数拿来排序 —— 边缘开销会把本来很快的源压到慢源后面，
// 而且第②步（直连）失败时直接 return，角标还写着「无播放源」，用户以为源没了。
//
// 这里验证：
//   ① 直连与代理分段计时，排序用直连那段
//   ② 直连不通 → 标「仅测到片单」，并退回代理耗时（不静默混算）
//   ③ 本站取不到片单 → 如实说「本站取不到片单」，不冒充「源没了」
//   ④ 直连测速只打源站地址，绝不经过本站代理
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

// ---- 可控的假环境：固定时钟 + 假 fetch，让耗时可断言 ----
let clock = 0;                       // 假时钟（毫秒）
const fetchCalls = [];
let detailData = null;               // /api/detail 返回什么
let detailFails = false;             // /api/detail 是否直接抛错
let directFails = false;             // 直连播放地址是否连不通
const PROXY_DELAY = 100;             // 代理取片单的假耗时
const DIRECT_DELAY = 30;             // 直连播放地址的假耗时

const fetchStub = async (url, opts) => {
    fetchCalls.push({ url: String(url), opts: opts || {} });
    if (String(url).startsWith('/api/detail')) {
        clock += PROXY_DELAY;
        if (detailFails) throw new TypeError('Failed to fetch');
        return { json: async () => detailData };
    }
    clock += DIRECT_DELAY;
    if (directFails) throw new TypeError('Failed to fetch');
    return { ok: true };
};

const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    window: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] },
    setTimeout, clearTimeout, Date, URL, URLSearchParams,
    AbortController, AbortSignal,
    performance: { now: () => clock },
    fetch: fetchStub
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8'), sandbox, { filename: 'js/ui.js' });
vm.runInContext(fs.readFileSync(path.join(root, 'js/source-picker.js'), 'utf8'), sandbox, { filename: 'js/source-picker.js' });

const { probeDirectLatency, formatSpeedDisplay, testSourcePickerSpeed } = sandbox;

const M3U8 = 'https://cdn.example.com/play/abc/index.m3u8';

async function main() {

// ============ ① 直连探速：只打源站，不经本站代理 ============
{
    fetchCalls.length = 0;
    const ms = await probeDirectLatency(M3U8, null, 5000);
    assert.equal(ms, DIRECT_DELAY, '直连耗时应等于假时钟里的直连耗时');
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, M3U8, '直连测速必须打源站原始地址');
    assert.ok(!fetchCalls[0].url.includes('/proxy/'), '直连测速不许绕本站代理');
    assert.equal(fetchCalls[0].opts.method, 'HEAD');
    assert.equal(fetchCalls[0].opts.mode, 'no-cors');
}

// ============ ② 直连连不通 → -1（而不是 0，也不是抛错） ============
{
    directFails = true;
    fetchCalls.length = 0;
    const ms = await probeDirectLatency(M3U8, null, 5000);
    assert.equal(ms, -1, '连不通应返回 -1');
    directFails = false;
}

// ============ ③ 非 http 地址不发请求 ============
{
    fetchCalls.length = 0;
    assert.equal(await probeDirectLatency('', null, 5000), -1);
    assert.equal(await probeDirectLatency('javascript:alert(1)', null, 5000), -1);
    assert.equal(fetchCalls.length, 0, '非法地址不该发出请求');
}

// ============ ④ 角标：直连与切源分开显示 ============
{
    const html = formatSpeedDisplay({ speed: 30, directMs: 30, proxyMs: 100 });
    assert.ok(html.includes('直连 30ms'), `角标应显示直连耗时：${html}`);
    assert.ok(html.includes('切源 100ms'), `角标应显示切源耗时：${html}`);
}

// ============ ⑤ 直连不通 → 写明「仅测到片单」，不拿代理耗时冒充 ============
{
    const html = formatSpeedDisplay({ speed: 100, directMs: -1, proxyMs: 100 });
    assert.ok(html.includes('仅测到片单'), `角标应说明只测到片单：${html}`);
    assert.ok(html.includes('切源 100ms'), `角标仍应给出切源耗时：${html}`);
    assert.ok(!html.includes('直连 100ms'), `不能把代理耗时写成直连：${html}`);
}

// ============ ⑥ 失败时显示失败原因 ============
{
    const html = formatSpeedDisplay({ speed: -1, error: '本站取不到片单' });
    assert.ok(html.includes('本站取不到片单'), `错误角标应带原因：${html}`);
}

// ============ ⑦ 测速主流程：两段分开记，排序用直连 ============
{
    clock = 0;
    fetchCalls.length = 0;
    detailData = { code: 200, episodes: [M3U8, 'https://cdn.example.com/play/def/index.m3u8'] };
    const controller = new AbortController();
    const result = await testSourcePickerSpeed('ruyi', '12345', controller.signal);

    assert.equal(result.error, null, '成功时不应有错误');
    assert.equal(result.proxyMs, PROXY_DELAY, '代理段耗时应单独记');
    assert.equal(result.directMs, DIRECT_DELAY, '直连段耗时应单独记');
    assert.equal(result.speed, DIRECT_DELAY, '排序值应取直连那段');
    assert.equal(result.episodes, 2);
    assert.equal(fetchCalls.length, 2, '应只发两次请求：取片单 + 直连');
}

// ============ ⑧ 直连不通 → speed 退回代理耗时，并标出只是测到片单 ============
{
    clock = 0;
    directFails = true;
    detailData = { code: 200, episodes: [M3U8] };
    const controller = new AbortController();
    const result = await testSourcePickerSpeed('ruyi', '12345', controller.signal);

    assert.equal(result.error, null);
    assert.equal(result.directMs, -1, '直连不通应记 -1');
    assert.equal(result.speed, PROXY_DELAY, '直连不通时排序退回代理耗时');
    const badge = formatSpeedDisplay(result);
    assert.ok(badge.includes('仅测到片单'), `应显示仅测到片单：${badge}`);
    directFails = false;
}

// ============ ⑨ 本站取不到片单 → 如实说「本站取不到片单」 ============
{
    clock = 0;
    detailData = { code: 200, episodes: [] };
    const controller = new AbortController();
    const result = await testSourcePickerSpeed('ruyi', '12345', controller.signal);

    assert.equal(result.speed, -1);
    assert.equal(result.error, '本站取不到片单');
    assert.equal(result.directMs, -1, '取不到片单就不该有直连耗时');
}

// ============ ⑩ 本站接口挂了 → 报错，不静默 ============
{
    clock = 0;
    detailFails = true;
    const controller = new AbortController();
    const result = await testSourcePickerSpeed('ruyi', '12345', controller.signal);

    assert.equal(result.speed, -1);
    assert.equal(result.error, '测试失败');
    detailFails = false;
}

// ============ ⑪ 取消 → 报「已取消」，不留下半截结果 ============
{
    clock = 0;
    detailData = { code: 200, episodes: [M3U8] };
    const controller = new AbortController();
    controller.abort();
    const result = await testSourcePickerSpeed('ruyi', '12345', controller.signal);

    assert.equal(result.speed, -1);
    assert.equal(result.error, '已取消');
}

console.log('source-speed.test.js: 全部断言通过 ✓');

}

main().catch(error => {
    console.error('source-speed.test.js: 断言失败 →', error);
    process.exit(1);
});
