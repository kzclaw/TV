// 画质徽章的自检：node tests/quality-badge.test.js
//
// 背景：
//   ① 徽章只允许显示**实测**分辨率。清单里声明的 RESOLUTION 不可信
//      （实测 lzi 声明 1080x608、实际分片是 1280x720），拿声明值当画质会把片子说错。
//   ② 档位只看**短边**：横屏 1920x800 的短边是高度 800，竖屏 720x1280 的短边是宽度 720。
//   ③ 徽章必须**紧跟文字**：名字是 flex:1 + ellipsis，徽章塞进名字里会被长名裁掉，
//      直接当兄弟排又会被顶到行尾（挨着「返回」/速度角标）—— 两种都错，正确的是套一层容器。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    window: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
        addEventListener() {},
        getElementById: () => null,
        querySelectorAll: () => [],
        createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, remove() {} }),
        head: { appendChild() {} },
        body: { appendChild() {} },
    },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, URL, URLSearchParams,
    AbortController, AbortSignal,
    performance: { now: () => 0 },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    navigator: { language: 'zh-CN' },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8'), sandbox, { filename: 'js/ui.js' });
vm.runInContext(fs.readFileSync(path.join(root, 'js/source-picker.js'), 'utf8'), sandbox, { filename: 'js/source-picker.js' });

const { qualityLabel, renderQualityBadge, probeVideoQuality, sourcePickerCardHtml } = sandbox;

// 假徽章元素：只实现渲染器用到的那几个属性
function fakeBadge() {
    return { textContent: '', className: '', title: '', hidden: true };
}

// ============ ① 档位：按短边分档，边界按实测分布定 ============
{
    assert.equal(qualityLabel(1920, 1080), '1080P', '标准 1080');
    assert.equal(qualityLabel(1280, 720), '720P', '标准 720');
    assert.equal(qualityLabel(720, 1280), '720P', '竖屏按宽度算（720×1280 是 720 档）');
    assert.equal(qualityLabel(1920, 800), '720P', '裁切过的 1080（1920×800）落 720 档');
    assert.equal(qualityLabel(1920, 852), '720P', '1920×852 落 720 档');
    assert.equal(qualityLabel(1024, 576), '480P', '1024×576 落 480 档');
    assert.equal(qualityLabel(1080, 608), '480P', '1080×608 落 480 档');
    assert.equal(qualityLabel(896, 376), '360P', '896×376 落 360 档');
    assert.equal(qualityLabel(3840, 2160), '1080P', '4K 也归到最高档 1080P（本项目最高就是 1080）');
}

// ============ ② 尺寸缺失/非法 → 不给档位（调用方据此不画徽章） ============
{
    assert.equal(qualityLabel(0, 0), '');
    assert.equal(qualityLabel(1920, 0), '');
    assert.equal(qualityLabel(undefined, undefined), '');
    assert.equal(qualityLabel('abc', 'def'), '');
    assert.equal(qualityLabel(NaN, 1080), '');
}

// ============ ③ 徽章四态 ============
{
    const el = fakeBadge();
    renderQualityBadge(el, { state: 'measured', width: 1920, height: 1080 });
    assert.equal(el.textContent, '1080P', '实测态显示档位名');
    assert.ok(el.className.includes('ok'), '实测态用实心样式');
    assert.equal(el.hidden, false, '实测态要显示出来');
    assert.ok(el.title.includes('1920×1080'), 'title 里带精确尺寸');

    renderQualityBadge(el, { state: 'pending' });
    assert.equal(el.textContent, '…', '起播/探测中是省略号');
    assert.ok(el.className.includes('pending'));
    assert.equal(el.hidden, false);

    renderQualityBadge(el, { state: 'failed' });
    assert.equal(el.textContent, '未测到', '探测失败要说出来，不能当成画质');
    assert.ok(el.className.includes('unknown'));

    renderQualityBadge(el, null);
    assert.equal(el.hidden, true, '没数据时整个徽章藏掉（灰 chip 是噪音）');
    assert.equal(el.textContent, '');

    renderQualityBadge(el, { state: 'measured', width: 0, height: 0 });
    assert.equal(el.hidden, true, '尺寸非法时藏掉徽章');
}

// ============ ④ 渲染器不能因为元素不存在而炸 ============
{
    renderQualityBadge(null, { state: 'measured', width: 1920, height: 1080 });
}

// ============ ⑤ 探测器：非法地址直接放弃，不发请求 ============
async function main() {
    assert.equal(await probeVideoQuality('', null, 1000), null, '空地址不探测');
    assert.equal(await probeVideoQuality('javascript:alert(1)', null, 1000), null, '非 http 地址不探测');

    // ============ ⑥ 换源面板的卡片：徽章必须与源名平级、紧跟其后 ============
    {
        const html = sourcePickerCardHtml({
            sourceKey: 'ruyi', vodId: '123', name: '庆余年', sourceName: '光速资源', approx: false
        });
        assert.ok(html.includes('class="nm-row"'), `徽章要套一层容器：${html}`);
        assert.ok(
            html.includes('<span class="nm-row"><span class="nm">庆余年</span><span class="q-badge" data-quality-badge hidden></span></span>'),
            `徽章必须与名字平级且紧跟其后：${html}`
        );
        assert.ok(!/<span class="nm">[^<]*<span class="q-badge"/.test(html),
            '徽章不能塞进名字内部（长源名会把它一起裁掉）');
    }

    // ============ ⑦ 播放器页：徽章必须跟在片名后面，且在 h2 外面 ============
    {
        const page = fs.readFileSync(path.join(root, 'player.html'), 'utf8');
        const head = page.slice(page.indexOf('class="kt-player-head"'), page.indexOf('class="kt-hall"'));
        assert.ok(head.includes('kt-title-row'), `片名要套一层容器：${head}`);
        assert.ok(head.indexOf('id="videoTitle"') < head.indexOf('id="qualityBadge"'),
            '画质徽章要排在片名之后');
        assert.ok(!/<h2[^>]*>[^<]*<span[^>]*qualityBadge/.test(head),
            '徽章不能塞进 h2 里（长片名会把它一起裁掉）');
    }

    console.log('quality-badge.test.js: 全部断言通过 ✓');
}

main().catch(error => {
    console.error('quality-badge.test.js: 断言失败 →', error);
    process.exit(1);
});
