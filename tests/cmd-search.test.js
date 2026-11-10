// 命令面板（⌘K）在播放页的自检：node tests/cmd-search.test.js
//
// 背景（owner 报的 bug）：
//   ① 播放页点顶栏搜索框 → 直接跳回首页，搜索框成了摆设
//      （chrome.js 的 applyCapabilities 把没有 #searchInput 的页面的搜索框改成了「回首页」）
//   ② 播放页按 ⌘K 什么都不弹
//      （命令面板的 HTML 只写在 index.html 里，播放页既没有面板，也没加载 js/cmd.js）
//   ③ 面板本身要能当搜索框用：有主搜索框就地搜，没有就带词回首页搜（/?s=关键词）
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const PAGE_URL = 'https://tv.kwokzit.info/player.html';

// 造一个页面环境：
//   hasSearchInput —— 首页有主搜索框，播放页没有
//   hasAppJs       —— 首页加载了 app.js（导出/导入配置在这），播放页没有
function makeEnv(opts) {
    opts = opts || {};
    const calls = { search: [], focus: 0 };
    const els = {};

    function el(id) {
        return {
            id,
            hidden: true,
            value: '',
            innerHTML: '',
            listeners: {},
            addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
            dispatch(type, ev) { (this.listeners[type] || []).forEach(fn => fn(ev || { preventDefault() {} })); },
            focus() { calls.focus++; },
            select() {},
            scrollIntoView() {},
            querySelectorAll() { return []; },
            setAttribute() {},
        };
    }

    els.openCmd = el('openCmd');
    els.ktCmd = el('ktCmd');
    els.ktCmdInput = el('ktCmdInput');
    els.ktCmdList = el('ktCmdList');
    if (opts.hasSearchInput) els.searchInput = el('searchInput');

    // 全站页面都加载 ui.js → 设置/历史面板的开关有实现
    const win = { location: { href: PAGE_URL }, toggleSettings() {}, toggleHistory() {} };
    if (opts.hasAppJs) { win.exportConfig = function () {}; win.importConfig = function () {}; }

    const docListeners = {};
    const sandbox = {
        console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
        window: win,
        localStorage: { getItem: () => null, setItem() {} },
        document: {
            addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
            getElementById: id => els[id] || null,
            querySelector: () => null,
            querySelectorAll: () => [],
        },
        setTimeout: fn => fn(),      // 面板聚焦是 setTimeout(0)，这里直接同步跑
        clearTimeout() {},
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(root, 'js/cmd.js'), 'utf8'), sandbox, { filename: 'js/cmd.js' });

    // 跑 DOMContentLoaded 里的绑定
    (docListeners.DOMContentLoaded || []).forEach(fn => fn());

    return { sandbox, els, calls, docListeners };
}

// ============ ① 播放页：点顶栏搜索框 → 打开面板，不跳首页 ============
{
    const env = makeEnv({ hasSearchInput: false });
    env.els.openCmd.dispatch('click');

    assert.equal(env.els.ktCmd.hidden, false, '播放页点搜索框应打开命令面板');
    assert.equal(env.sandbox.window.location.href, PAGE_URL, '播放页点搜索框不应跳首页');
}

// ============ ② 首页：点顶栏搜索框 → 聚焦主搜索框（老行为不变） ============
{
    const env = makeEnv({ hasSearchInput: true });
    env.els.openCmd.dispatch('click');

    assert.equal(env.calls.focus, 1, '首页点搜索框应聚焦主搜索框');
    assert.equal(env.els.ktCmd.hidden, true, '首页点搜索框不该弹命令面板');
    assert.equal(env.sandbox.window.location.href, PAGE_URL, '首页点搜索框不应跳页');
}

// ============ ③ 播放页：⌘K / Ctrl+K 都能弹出命令面板 ============
{
    for (const mod of [{ metaKey: true }, { ctrlKey: true }]) {
        const env = makeEnv({ hasSearchInput: false });
        let prevented = false;
        (env.docListeners.keydown || []).forEach(fn => fn({
            key: 'k', metaKey: !!mod.metaKey, ctrlKey: !!mod.ctrlKey,
            preventDefault() { prevented = true; },
        }));

        assert.equal(env.els.ktCmd.hidden, false, '播放页应能用快捷键打开命令面板');
        assert.equal(prevented, true, '快捷键应阻止浏览器默认行为');
    }
}

// ============ ④ 播放页：面板里搜词 → 顶部有「搜索「词」」项，执行后带词回首页 ============
{
    const env = makeEnv({ hasSearchInput: false });
    env.sandbox.openCmd();
    env.sandbox.cmdRender('阿甘');

    assert.ok(env.els.ktCmdList.innerHTML.includes('搜索「阿甘」'), '面板顶部应出现搜索项');
    assert.ok(env.els.ktCmdList.innerHTML.includes('data-cmd-index="0"'), '搜索项应排第一');

    env.sandbox.cmdRun(0);
    assert.equal(
        env.sandbox.window.location.href,
        '/?s=' + encodeURIComponent('阿甘'),
        '播放页搜索应带词回首页（首页的 index-page.js 接手 ?s=）'
    );
}

// ============ ⑤ 首页：面板里搜词 → 就地填主搜索框并触发搜索，不跳页 ============
{
    const env = makeEnv({ hasSearchInput: true, hasAppJs: true });
    env.sandbox.search = function () { env.calls.search.push(env.els.searchInput.value); };

    env.sandbox.cmdSearch('阿甘');

    assert.equal(env.els.searchInput.value, '阿甘', '应填进主搜索框');
    assert.deepEqual(env.calls.search, ['阿甘'], '应触发一次搜索');
    assert.equal(env.sandbox.window.location.href, PAGE_URL, '首页搜索不应跳页');
}

// ============ ⑤b 面板只列本页真能执行的条目（不给死按钮） ============
{
    // 播放页：没加载 app.js → 导出/导入配置不存在，不能列
    const player = makeEnv({ hasSearchInput: false });
    player.sandbox.openCmd();
    const playerHtml = player.els.ktCmdList.innerHTML;
    assert.ok(playerHtml.includes('打开设置'), '播放页应列出「打开设置」（ui.js 有实现）');
    assert.ok(playerHtml.includes('观看历史'), '播放页应列出「观看历史」（ui.js 有实现）');
    assert.ok(!playerHtml.includes('导出配置'), '播放页不该列「导出配置」死条目');
    assert.ok(!playerHtml.includes('导入配置'), '播放页不该列「导入配置」死条目');

    // 首页：app.js 在 → 四个都在
    const home = makeEnv({ hasSearchInput: true, hasAppJs: true });
    home.sandbox.openCmd();
    const homeHtml = home.els.ktCmdList.innerHTML;
    assert.ok(homeHtml.includes('导出配置'), '首页应列出「导出配置」');
    assert.ok(homeHtml.includes('导入配置'), '首页应列出「导入配置」');
}

// ============ ⑥ 命令面板只有一份真本（chrome.js 注入，页面只留占位符） ============
{
    const chromeSrc = fs.readFileSync(path.join(root, 'js/chrome.js'), 'utf8');
    assert.ok(chromeSrc.includes('id="ktCmd"'), '命令面板真本应在 chrome.js 里');
    assert.ok(
        !chromeSrc.includes("window.location.href = '/'"),
        'chrome.js 不该再把搜索框改成「回首页」'
    );

    for (const page of ['index.html', 'player.html', 'about.html']) {
        const src = fs.readFileSync(path.join(root, page), 'utf8');
        assert.ok(!src.includes('id="ktCmd"'), page + ' 不该内联第二份命令面板');
        assert.ok(src.includes('data-chrome="cmd"'), page + ' 应留命令面板占位符');
        assert.ok(src.includes('js/cmd.js'), page + ' 应加载 cmd.js');
    }
}

console.log('命令面板（播放页）自检通过');
