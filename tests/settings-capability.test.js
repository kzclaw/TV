// 共享 UI 的能力审计：node tests/settings-capability.test.js
//
// 背景（播放页「一堆点了没反应的按钮」的根因）：
//   ① chrome.js 把设置面板注入到**所有页面**，但面板里选源相关的按钮调用 app.js 的函数，
//      而播放页不加载 app.js → 那些按钮点了没反应。
//   ② ui.js 的导入弹窗里「从URL导入」按钮调用 app.js 的 importConfigFromUrl → 同样死。
//   ③ app.js 的导入/导出配置调用全局 sha256 —— 但 js/sha256.js 是 ES module，
//      浏览器**从来没加载过它** → 所有页面的导入/导出都是静默失败（ReferenceError 被 async 吞掉）。
//
// 判据（本站的硬规矩）：
//   共享外壳引用的函数，要么在**这一页真的存在**，要么它所在的分组会在这一页**整块被藏起来**
//   —— 不给「看着像能用、点了没反应」的条目。
//
// 审计范围：会被**真正渲染**出来的模板。
//   · chrome.js 的外壳模板（每个页面都注入）→ 逐页核对
//   · ui.js 里按需创建的弹窗 → 其生成函数必须在该页可用，否则那个弹窗压根不会出现
//   · 无人调用的函数（死代码）→ 它的模板永不渲染，不纳入审计（但会在输出里点名）
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

// ---------- 顶层函数/常量定义（只看行首，避免把嵌套函数算进来） ----------
function defsIn(file) {
    const out = new Set();
    const src = read(file);
    for (const re of [/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm,
                      /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm]) {
        let m;
        while ((m = re.exec(src))) out.add(m[1]);
    }
    return out;
}

// ---------- 页面加载了哪些本站脚本 ----------
function scriptsOf(page) {
    const out = [];
    const re = /<script[^>]+src="([^"]+)"/g;
    let m;
    while ((m = re.exec(read(page)))) {
        if (m[1].startsWith('js/')) out.push(m[1].slice(3));
    }
    return out;
}

// ---------- 模板字符串里的 onclick 目标 + 它是否落在「会被整块藏起来」的分组里 ----------
const HIDDEN_WHEN_NO_APP = ['kt-src-group', 'kt-custom-api-group'];

function onclickTargets(html) {
    const targets = [];
    const stack = [];               // 每层开标签的 class
    let m;
    const re = /<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/g;
    while ((m = re.exec(html))) {
        const full = m[0];
        const attrs = m[2] || '';
        if (full.startsWith('</')) { stack.pop(); continue; }
        const cls = (attrs.match(/class="([^"]*)"/) || ['', ''])[1];
        const inGroup = stack.some(c => HIDDEN_WHEN_NO_APP.some(g => c.includes(g)));
        const fn = (attrs.match(/onclick="([A-Za-z_$][\w$]*)\s*\(/) || [])[1];
        if (fn) targets.push({ fn, inGroup });
        if (m[3] !== '/') stack.push(cls);   // 自闭合标签不进栈
    }
    return targets;
}

// 模板字符串 + 它归属谁（最近的顶层函数 / 模块级变量）
function templatesOf(file) {
    const src = read(file);
    const out = [];
    let owner = '(module)';
    const re = /`([\s\S]*?)`/g;
    let m;
    while ((m = re.exec(src))) {
        const before = src.slice(0, m.index);
        // 归属：最后一个「顶层函数定义」或「模块级变量赋值」
        const fns = [...before.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)];
        const vars = [...before.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)];
        const lastFn = fns.length ? fns[fns.length - 1] : null;
        const lastVar = vars.length ? vars[vars.length - 1] : null;
        if (lastFn && (!lastVar || lastFn.index > lastVar.index)) owner = lastFn[1];
        else if (lastVar) owner = lastVar[1];
        out.push({ owner, body: m[1] });
    }
    return out;
}

// ---------- 全站共享的脚本（每个页面都加载） ----------
const SHARED = ['js/chrome.js', 'js/cmd.js', 'js/config.js', 'js/ui.js', 'js/api.js'];

const sharedDefs = new Set();
for (const f of SHARED) for (const d of defsIn(f)) sharedDefs.add(d);

const appDefs = defsIn('js/app.js');
const appOnly = new Set([...appDefs].filter(d => !sharedDefs.has(d)));

// ---------- 全仓库里一个名字被引用了几次（判断是不是死代码） ----------
const repoFiles = fs.readdirSync(path.join(root, 'js')).filter(f => f.endsWith('.js')).map(f => 'js/' + f)
    .concat(fs.readdirSync(path.join(root)).filter(f => f.endsWith('.html')));
const repoText = repoFiles.map(read).join('\n');
function refCount(name) {
    const re = new RegExp('\\b' + name + '\\b', 'g');
    return (repoText.match(re) || []).length;
}

// ---------- 收集「会被渲染」的模板 ----------
const deadOwners = [];
const injected = [];
for (const file of ['js/chrome.js', 'js/ui.js']) {
    for (const t of templatesOf(file)) {
        if (!t.body.includes('onclick=')) continue;
        const targets = onclickTargets(t.body);
        if (!targets.length) continue;
        if (t.owner !== '(module)' && refCount(t.owner) <= 1) {
            deadOwners.push(`${t.owner} (${file})`);
            continue;                       // 没人调用 → 模板永不渲染
        }
        injected.push({ file, owner: t.owner, targets });
    }
}

// ============ ① 逐页核对：每个 onclick 目标要么本页有，要么所在分组会被藏起来 ============
for (const page of ['index.html', 'player.html', 'about.html']) {
    const scripts = scriptsOf(page);
    const available = new Set(sharedDefs);
    for (const s of scripts) for (const d of defsIn('js/' + s)) available.add(d);
    const hasApp = scripts.includes('app.js');

    for (const tpl of injected) {
        // 生成这个模板的函数本身必须在本页可用，否则模板不会出现（不必再查它的按钮）
        if (tpl.owner !== '(module)' && !available.has(tpl.owner)) continue;
        for (const t of tpl.targets) {
            if (available.has(t.fn)) continue;                        // 本页真的能调用 ✅
            if (appOnly.has(t.fn) && !hasApp && t.inGroup) continue;  // app 独有 + 本页没 app.js + 分组会被藏 ✅
            assert.fail(
                `${page}：${tpl.file} 的 ${tpl.owner} 模板引用了本页不存在的函数 ${t.fn}()` +
                (t.inGroup ? '（且它所在分组并不会被藏）' : '（死按钮：点了没反应）')
            );
        }
    }
}

// ============ ② sha256 必须只有一份实现，且浏览器能拿到 ============
// 唯一实现是 ES module 的 js/sha256.js；浏览器端靠 ui.js 的动态 import 复用它
assert.ok(/export\s+async\s+function\s+sha256/.test(read('js/sha256.js')),
    'js/sha256.js 应保持为 ES module（服务端在用）');
assert.ok(read('js/ui.js').includes("import('./sha256.js')"),
    '浏览器端应通过动态 import 复用 js/sha256.js');
for (const f of ['js/app.js', 'js/ui.js']) {
    const bare = read(f).split('\n').filter(l => /(?<![.\w])sha256\s*\(/.test(l));
    assert.equal(bare.length, 0, `${f} 不该再有裸的全局 sha256( 调用（浏览器里它是 undefined）`);
}

// ============ ③ 播放页的能力：设置面板里不该留下死分组 ============
assert.ok(read('js/chrome.js').includes('kt-custom-api-group'), '自定义API 分组应有标记类（用于按能力隐藏）');
assert.ok(read('css/components.css').includes('.kt-no-src-list .kt-custom-api-group'),
    '没加载 app.js 的页面应把自定义API 分组整块藏起来');
assert.ok(read('css/components.css').includes('.kt-no-src-list .kt-src-group'),
    '没加载 app.js 的页面应把数据源设置分组整块藏起来');
// 导入/导出配置搬到了共享层 → 播放页也能用（而不是被藏起来）
assert.ok(defsIn('js/ui.js').has('exportConfig'), 'exportConfig 应在共享层 ui.js（三个页面都能用）');
assert.ok(defsIn('js/ui.js').has('importConfig'), 'importConfig 应在共享层 ui.js（三个页面都能用）');
assert.ok(defsIn('js/ui.js').has('importConfigFromUrl'), 'importConfigFromUrl 应在共享层 ui.js');
assert.ok(!defsIn('js/app.js').has('exportConfig'), 'app.js 不该再留一份 exportConfig（两份实现会漂移）');

// ============ ④ 命令面板的层级必须压过播放器页的所有层 ============
const css = read('css/components.css');
const zOf = sel => {
    const i = css.indexOf(sel);
    assert.ok(i > 0, `css/components.css 里找不到 ${sel}`);
    const m = css.slice(i, i + 400).match(/z-index:\s*(\d+)/);
    assert.ok(m, `${sel} 没有 z-index`);
    return Number(m[1]);
};
const cmdZ = zOf('.kt-cmd {');
const modalZ = zOf('.kt-modal {');
// 播放器页的层：错误/加载遮罩 100、快捷键提示 1000、ArtPlayer 固定顶栏 9000、toast 9999、
// 网页全屏 10000、恢复按钮 10001 —— 面板必须全部压过，否则播放页会被播放器盖住
for (const z of [100, 1000, 9000, 9999, 10000, 10001]) {
    assert.ok(cmdZ > z, `命令面板 z-index(${cmdZ}) 必须高于播放器层的 ${z}`);
}
assert.ok(modalZ > cmdZ, '信息/密码弹窗应盖在命令面板之上（z-index 必须更高）');

// ============ ⑤ 设置面板里的开关：三页都必须能响应 ============
// 开关不是 onclick，是 JS 绑的 change 事件 → 单独审计：
//   绑它的脚本必须在**每个页面**都加载（以前黄色过滤/广告过滤只绑在 app.js 里 → 播放页上开关是死的）
const switchIds = ['yellowFilterToggle', 'adFilterToggle', 'latestToggle'];
for (const page of ['index.html', 'player.html', 'about.html']) {
    const scripts = scriptsOf(page).map(s => 'js/' + s);
    for (const id of switchIds) {
        const bound = scripts.filter(f => {
            const src = read(f);
            if (!src.includes(`getElementById('${id}')`)) return false;
            return /addEventListener\(\s*['"]change['"]/.test(src);
        });
        assert.ok(bound.length > 0, `${page}：开关 ${id} 没有任何本页加载的脚本绑定 change 事件`);
    }
}
// 开关的视觉反馈（滑块要动）也要有，且只有一份实现
assert.ok(defsIn('js/ui.js').has('syncToggleVisual'), '开关的视觉反馈应在共享层 ui.js');
assert.ok(defsIn('js/ui.js').has('initSettingSwitches'), '三个开关的初始化应在共享层 ui.js');
assert.ok(!defsIn('js/app.js').has('initSettingSwitches'), 'app.js 不该再留一份开关初始化');

// ============ ⑥ 静态 HTML 里的按钮必须有人接（不能只是「看着像能点」） ============
// 搜索页那三个排序按钮（最相关/最新/源最多）就是这么死的：标记写在 HTML 里、
// CSS 里连高亮态都备好了，却没有一行 JS 绑它们 → 点了毫无反应。
// 判据（要能区分「声明过」和「真的绑了」，否则会假绿）：
//   静态 <button> 必须有 id，且本页加载的某个脚本里有字面量 getElementById('<id>')
//   或 querySelector('#<id>')，并且那个脚本确实绑了 click。
for (const page of ['index.html', 'player.html', 'about.html']) {
    const html = read(page);
    const scripts = scriptsOf(page).map(s => 'js/' + s);
    for (const m of html.matchAll(/<button\b[^>]*>/g)) {
        const tag = m[0].replace(/\s+/g, ' ');
        if (/onclick\s*=/.test(tag)) continue;               // 行内 onclick 已接
        if (/type\s*=\s*["']submit["']/.test(tag)) continue;  // 表单提交
        const id = (tag.match(/\bid\s*=\s*["']([^"']+)["']/) || [])[1];
        assert.ok(id, `${page}：静态按钮 ${tag.slice(0, 90)} 没有 id —— 没有 id 就没法证明有人接它`);
        const bound = scripts.some(f => {
            const src = read(f);
            const referenced = src.includes(`getElementById('${id}')`) || src.includes(`getElementById("${id}")`)
                || src.includes(`querySelector('#${id}')`) || src.includes(`querySelector("#${id}")`);
            return referenced && /addEventListener\(\s*['"]click['"]/.test(src);
        });
        assert.ok(bound,
            `${page}：静态按钮 ${tag.slice(0, 90)} 没人接 —— 本页脚本里没有对 '${id}' 的 click 绑定（点了不会有反应）`);
    }
}

console.log(`能力审计通过：${injected.length} 个会被渲染的模板，各页面的 onclick 目标均可用或被隐藏`);
if (deadOwners.length) console.log(`（提示：以下函数无人调用，其模板不纳入审计 —— ${deadOwners.join('、')}）`);
