// 跨源同名聚合的自检：node tests/aggregate.test.js
// 用构造样本覆盖四种情况：同名同年份 / 同名不同年份 / 同名无年份 / 不同名，
// 外加标点差异的兜底合并与备注统一结论。
const assert = require('node:assert/strict');

require('../js/aggregate.js');

const { aggregateResults, normalizeTitle, formatRemarks, inferGroupRemarks, sortSearchGroups } = globalThis.Aggregation;

const item = (name, year, source, id, extra) => Object.assign({
    vod_name: name,
    vod_year: year,
    vod_id: id,
    source_code: source,
    source_name: source,
    vod_remarks: ''
}, extra || {});

// 1) 同名同年份 → 合成一组
{
    const groups = aggregateResults([
        item('庆余年', '2019', 'ruyi', '1'),
        item('庆余年', '2019', 'zuid', '2')
    ]);
    assert.equal(groups.length, 1, '同名同年份应只有 1 组');
    assert.equal(groups[0].items.length, 2, '组内应有 2 个来源');
    assert.equal(groups[0].year, '2019');
    assert.equal(groups[0].name, '庆余年');
}

// 2) 同名不同年份 → 按年份拆成多组（同名翻拍）
{
    const groups = aggregateResults([
        item('无间道', '2002', 'ruyi', '1'),
        item('无间道', '2013', 'zuid', '2'),
        item('无间道', '2002', 'baidu', '3')
    ]);
    assert.equal(groups.length, 2, '同名不同年份应拆成 2 组');
    assert.deepEqual(groups.map(g => g.year).sort(), ['2002', '2013']);
    assert.equal(groups.find(g => g.year === '2002').items.length, 2);
}

// 3) 同名无年份 → 桶内年份不一致时，无年份的条目单独成组
{
    const groups = aggregateResults([
        item('三体', '2023', 'ruyi', '1'),
        item('三体', '2020', 'zuid', '2'),
        item('三体', '', 'baidu', '3')
    ]);
    assert.equal(groups.length, 3, '两个年份 + 无年份应拆成 3 组');
    assert.deepEqual(groups.map(g => g.year).sort(), ['', '2020', '2023']);
    assert.equal(groups.find(g => g.year === '').items.length, 1);
}

// 3b) 同名、桶内只有一个年份 → 无年份的条目并入该组（年份不冲突，不拆）
{
    const groups = aggregateResults([
        item('三体', '2023', 'ruyi', '1'),
        item('三体', '2023', 'zuid', '2'),
        item('三体', '', 'baidu', '3')
    ]);
    assert.equal(groups.length, 1, '只有一个年份时不分拆');
    assert.equal(groups[0].items.length, 3);
    assert.equal(groups[0].year, '2023');
}

// 4) 不同名 → 不合并
{
    const groups = aggregateResults([
        item('庆余年', '2019', 'ruyi', '1'),
        item('庆余年2', '2024', 'zuid', '2'),
        item('庆余年', '2019', 'baidu', '3')
    ]);
    assert.equal(groups.length, 2, '不同名不应合并');
    assert.deepEqual(groups.map(g => g.name).sort(), ['庆余年', '庆余年2']);
}

// 5) 标点差异 → 兜底合并（归一后同名且年份一致）
{
    const groups = aggregateResults([
        item('摔跤吧!爸爸', '2018', 'ruyi', '1'),
        item('摔跤吧！爸爸', '2018', 'zuid', '2')
    ]);
    assert.equal(groups.length, 1, '标点差异的同一部片应合并');
    assert.equal(groups[0].items.length, 2);
}

// 6) 标点差异但年份不同 → 不合并（翻拍）
{
    const groups = aggregateResults([
        item('摔跤吧!爸爸', '2018', 'ruyi', '1'),
        item('摔跤吧！爸爸', '2024', 'zuid', '2')
    ]);
    assert.equal(groups.length, 2, '年份不同的不应合并');
}

// 7) 数字不被归一 → 「电影2」与「电影」不合并
{
    const groups = aggregateResults([
        item('电影', '2020', 'ruyi', '1'),
        item('电影2', '2020', 'zuid', '2')
    ]);
    assert.equal(groups.length, 2, '数字差异不应被归一掉');
    assert.equal(normalizeTitle('电影2'), '电影2');
    assert.equal(normalizeTitle('摔跤吧!爸爸'), '摔跤吧爸爸');
}

// 8) 备注统一成一句结论
{
    assert.equal(inferGroupRemarks(['全34集', '完结', '更新至34集']), '全34集');
    assert.equal(inferGroupRemarks(['完结', '已完结']), '已完结');
    assert.equal(inferGroupRemarks(['更新至12集', '更新至20集']), '更新至20集');
    assert.equal(inferGroupRemarks(['HD国语', '正片']), 'HD国语');
    assert.equal(formatRemarks('第34集'), '更新至34集');
    assert.equal(formatRemarks('34集全'), '全34集');
    assert.equal(formatRemarks('完结'), '已完结');
    assert.equal(formatRemarks('HD国语'), 'HD国语');
}

// 9) 组的年份/分类/封面取组内第一个有的那个
{
    const groups = aggregateResults([
        item('庆余年', '2019', 'ruyi', '1', { type_name: '', vod_pic: '' }),
        item('庆余年', '2019', 'zuid', '2', { type_name: '国产剧', vod_pic: 'http://x/1.jpg' })
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].typeName, '国产剧');
    assert.equal(groups[0].pic, 'http://x/1.jpg');
}

// 10) 单条结果 → 1 组 1 条（单源体验不变）
{
    const groups = aggregateResults([item('唯一的片', '2020', 'ruyi', '1')]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].items.length, 1);
}

// 11) sourceCount：组内来源数（同一源的重复条目只算一次）
{
    const groups = aggregateResults([
        item('庆余年', '2019', 'ruyi', '1'),
        item('庆余年', '2019', 'zuid', '2'),
        item('庆余年', '2019', 'ruyi', '3')   // 同一源的重复条目
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].items.length, 3, '重复条目仍在组内');
    assert.equal(groups[0].sourceCount, 2, '来源数按不同源算，重复条目只算一次');
}

// 12) sourceCount：单源组为 1
{
    const groups = aggregateResults([item('唯一的片', '2020', 'ruyi', '1')]);
    assert.equal(groups[0].sourceCount, 1);
}

// 13) 年份脏值不拆卡：源站把同一部片写成 "2019" 和 "2019–"，应合成 1 组
{
    const groups = aggregateResults([
        item('庆余年第一季', '2019', 'ruyi', '1'),
        item('庆余年第一季', '2019–', 'mdzy', '2')
    ]);
    assert.equal(groups.length, 1, '年份写法不同不应拆成多组');
    assert.equal(groups[0].items.length, 2);
    assert.equal(groups[0].year, '2019', '年份应归一为 4 位');
}

// 14) 年份脏值 "0" 视为无年份，且不与真实年份合并
{
    const groups = aggregateResults([
        item('春酒庆团圆', '0', 'bfzy', '1'),
        item('春酒庆团圆', '', 'ruyi', '2')
    ]);
    assert.equal(groups.length, 1, '"0" 与空年份应视为同一年份');
    assert.equal(groups[0].year, '', '"0" 不是年份，应归到无年份');
}

// 15) 排序档位：最相关 / 最新 / 源最多（搜索结果页那三个按钮）
{
    const groups = aggregateResults([
        item('大侦探', '1988', 'ruyi', '1', { vod_time: '2024-01-01 00:00:00' }),
        item('大侦探', '1988', 'zuid', '2', { vod_time: '2024-02-01 00:00:00' }),
        item('大侦探', '1988', 'baidu', '3', { vod_time: '2024-03-01 00:00:00' }),
        item('大侦探第十一季', '2026', 'ruyi', '4', { vod_time: '2025-01-01 00:00:00' }),
        item('名侦探柯南', '1996', 'ruyi', '5', { vod_time: '2026-01-01 00:00:00' })
    ]);

    // 最新：年份新的在前
    const byTime = sortSearchGroups(groups, 'time');
    assert.deepEqual(byTime.map(g => g.year), ['2026', '1996', '1988'],
        '「最新」应按年份倒序');
    assert.equal(byTime[0].name, '大侦探第十一季');

    // 源最多：来源多的在前（3 源 > 1 源）
    const bySources = sortSearchGroups(groups, 'sources');
    assert.equal(bySources[0].sourceCount, 3, '「源最多」应把 3 源的排在最前');
    assert.equal(bySources[0].name, '大侦探');
    assert.equal(bySources.filter(g => g.sourceCount === 1).length, 2);

    // 最相关：保持传入原序
    assert.deepEqual(sortSearchGroups(groups, 'relevance').map(g => g.name),
        groups.map(g => g.name), '「最相关」不应改变顺序');

    // 并列时：最新 → 更新时间新的在前；源最多 → 年份新的在前
    const tie = [
        { name: 'A', year: '2020', sourceCount: 1, items: [{ vod_time: '2024-01-01 00:00:00' }] },
        { name: 'B', year: '2020', sourceCount: 1, items: [{ vod_time: '2025-01-01 00:00:00' }] }
    ];
    assert.deepEqual(sortSearchGroups(tie, 'time').map(g => g.name), ['B', 'A'],
        '年份相同时应按更新时间新的在前');
    const tie2 = [
        { name: 'A', year: '2020', sourceCount: 2, items: [] },
        { name: 'B', year: '2026', sourceCount: 2, items: [] }
    ];
    assert.deepEqual(sortSearchGroups(tie2, 'sources').map(g => g.name), ['B', 'A'],
        '源数相同时应按年份新的在前');

    // 不改原数组（重排后原数组仍是相关性序，否则来回切档会漂）
    const before = groups.map(g => g.name).join(',');
    sortSearchGroups(groups, 'time');
    assert.equal(groups.map(g => g.name).join(','), before, '排序不该改动传入的数组');

    // 空输入不炸
    assert.deepEqual(sortSearchGroups(null, 'time'), []);
}

console.log('aggregate.test.js: 全部断言通过 ✓');
