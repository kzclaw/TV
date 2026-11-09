// 详情弹窗元信息行的自检：node tests/detail-facts.test.js
//
// 回归点：remarks（vod_remarks）是**源站自己写的备注**——集数/完结状态（「更新至第7集」
// 「全34集」）或「HD国语」「正片」这类说明，它**不是画质**。
// 曾经这一行直接标成「画质」，于是「更新至第7集」被当成画质展示给用户。
//
// 断言用逐元素比较而不是 deepEqual：函数在 vm sandbox 里跑，
// 跨 realm 的数组原型不同，deepStrictEqual 会误判。
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
        createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
        body: { appendChild() {} },
    },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, URL, URLSearchParams,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    navigator: { language: 'zh-CN' },
    location: { href: 'https://example.invalid/', search: '', origin: 'https://example.invalid', hash: '' },
    history: { replaceState() {} },
    alert() {}, confirm() { return true; },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['js/config.js', 'js/aggregate.js', 'js/app.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
}

const { buildDetailFacts } = sandbox;

const labelOf = (facts, name) => {
    const hit = facts.find(f => f[0] === name);
    return hit ? hit[1] : undefined;
};

// 1) 集数备注：标签是「备注」，且**绝不能**是「画质」
{
    const facts = buildDetailFacts({ remarks: '更新至第7集' });
    assert.equal(facts.length, 1, '只应有备注这一行');
    assert.equal(facts[0][0], '备注', 'remarks 的标签必须是「备注」');
    assert.equal(facts[0][1], '更新至7集', '集数备注应归一');
    const labels = facts.map(f => f[0]);
    assert.ok(!labels.includes('画质'), 'remarks 不得再被标成画质');
}

// 2) 完结 / 总集数
{
    assert.equal(labelOf(buildDetailFacts({ remarks: '全34集' }), '备注'), '全34集');
    assert.equal(labelOf(buildDetailFacts({ remarks: '完结' }), '备注'), '已完结');
}

// 3) 非集数备注（HD国语 / 正片）原样保留，但标签同样是「备注」
{
    assert.equal(labelOf(buildDetailFacts({ remarks: 'HD国语' }), '备注'), 'HD国语');
    assert.equal(labelOf(buildDetailFacts({ remarks: '正片' }), '备注'), '正片');
}

// 4) 没有 remarks → 不出这一行（也别留一个空标签）
{
    const facts = buildDetailFacts({ type: '电影', year: '2019' });
    assert.equal(facts.length, 2, '只有类型与年份两行');
    assert.equal(labelOf(facts, '备注'), undefined);
    assert.equal(labelOf(buildDetailFacts({ remarks: '' }), '备注'), undefined);
    assert.equal(labelOf(buildDetailFacts({ remarks: '   ' }), '备注'), undefined);
}

// 5) 其余字段的标签与取值不受影响
{
    const facts = buildDetailFacts({
        type: '科幻', year: '2019', area: '中国大陆',
        director: '郭帆', actor: '吴京', remarks: '更新至第656集',
    });
    assert.equal(labelOf(facts, '类型'), '科幻');
    assert.equal(labelOf(facts, '年份'), '2019');
    assert.equal(labelOf(facts, '地区'), '中国大陆');
    assert.equal(labelOf(facts, '导演'), '郭帆');
    assert.equal(labelOf(facts, '主演'), '吴京');
    assert.equal(labelOf(facts, '备注'), '更新至656集');
    assert.equal(facts.length, 6, '六行齐全');
}

// 6) 没有 videoInfo → 空数组，不炸
{
    assert.equal(buildDetailFacts(null).length, 0);
    assert.equal(buildDetailFacts(undefined).length, 0);
}

console.log('detail-facts 自检通过');
