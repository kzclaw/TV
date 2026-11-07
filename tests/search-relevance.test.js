// 搜索相关性两档 + 年份序（新的在前）的自检：node tests/search-relevance.test.js
// A 档 = 归一后完全相等；B 档 = 同系列（季数别名 / 前缀扩展 / 公共前缀≥4），单列、不与 A 档合并；其余不展示
// 样本用实测到的真实片名：393 个真实片名里有 13 个「别的片名以它开头」，
// 合并会把「步步惊心」和「步步惊心泰国版」当成一部，用户点进去播到错的内容。
const assert = require('node:assert/strict');

require('../js/aggregate.js');

const { aggregateResults, searchRelevanceTier, rankSearchGroups, normalizeTitle, parseSeasonSuffix, parseYear } = globalThis.Aggregation;

const item = (name, source, id, time, year) => ({
    vod_name: name,
    vod_name_normalized: undefined,
    vod_year: year === undefined ? '2026' : year,
    vod_id: id,
    source_code: source,
    source_name: source,
    vod_time: time || '2026-11-01 10:00:00',
    vod_remarks: ''
});

// 分组走真实的聚合路径（与线上同一条），不手搓 group 结构——
// 手搓的组没有 year 字段，与线上喂进来的东西不一致，排序断言会验错东西。
const groupsOf = items => aggregateResults(items);

// 1) A 档：归一后完全相等（标点差异算相等）
assert.equal(searchRelevanceTier('庆余年', '庆余年'), 'A');
assert.equal(searchRelevanceTier('摔跤吧!爸爸', '摔跤吧！爸爸'), 'A');
assert.equal(searchRelevanceTier('庆余年', '庆余年'), 'A');

// 2) B 档：归一后前缀匹配（修饰名/续集名版本）
assert.equal(searchRelevanceTier('步步惊心泰国版', '步步惊心'), 'B');
assert.equal(searchRelevanceTier('沧元图3D动漫版', '沧元图'), 'B');
assert.equal(searchRelevanceTier('人气美食2026', '人气美食'), 'B');
assert.equal(searchRelevanceTier('夜曲2026', '夜曲'), 'B');

// 3) C 档：既不相等也不是前缀 → 不展示
assert.equal(searchRelevanceTier('宝贝 小偷与大盗', '小偷'), '');
assert.equal(searchRelevanceTier('夜曲', '人气美食'), '');

// 4) 排序：A 档在前 → 同档源数多的在前 → 再 vod_time 新的在前；C 档被丢掉
{
    const groups = rankSearchGroups(groupsOf([
        item('步步惊心泰国版', 'a', '1'),
        item('步步惊心', 'a', '2'), item('步步惊心', 'b', '3'),
        item('宝贝 小偷与大盗', 'a', '6')
    ]), '步步惊心');

    assert.equal(groups.length, 2, 'C 档（不相关）应被丢掉');
    assert.equal(groups[0].name, '步步惊心', 'A 档应在 B 档之前');
    assert.equal(groups[0].tier, 'A');
    assert.equal(groups[1].name, '步步惊心泰国版', 'B 档单列，不与 A 档合并');
    assert.equal(groups[1].tier, 'B');
}

// 5) 同档内：源数多的在前；源数相同按 vod_time 新的在前
// （注意「庆余年2」归一后不等于「庆余年」，所以它是 B 档，不会与 A 档合并）
{
    const groups = rankSearchGroups(groupsOf([
        item('庆余年', 'a', '1', '2026-11-06 10:00:00'),
        item('庆余年2', 'a', '2'), item('庆余年2', 'b', '3'), item('庆余年2', 'c', '4'),
        item('庆余年3', 'a', '5', '2026-11-02 10:00:00'), item('庆余年3', 'b', '6', '2026-11-05 10:00:00'),
        item('庆余年4', 'a', '7', '2026-11-01 10:00:00'), item('庆余年4', 'b', '8', '2026-11-02 10:00:00')
    ]), '庆余年');

    assert.deepEqual(groups.map(g => g.name), ['庆余年', '庆余年2', '庆余年3', '庆余年4'],
        'A 档在前；B 档内年份相同则按源数倒序，源数相同按 vod_time 倒序（庆余年3 的最新时间比庆余年4 新）');
    assert.deepEqual(groups.map(g => g.tier), ['A', 'B', 'B', 'B']);
}

// 6) 归一：去空白/标点/符号 + 转小写，数字保留
assert.equal(normalizeTitle('摔跤吧!爸爸'), '摔跤吧爸爸');
assert.equal(normalizeTitle('电影2'), '电影2');
assert.equal(normalizeTitle('沧元图3D动漫版'), '沧元图3d动漫版');

// 7) 季数别名：查询「庆余年2」↔ 标题「庆余年第二季」（上游 parseSeasonSuffix 同款口径）
assert.equal(searchRelevanceTier('庆余年第二季', '庆余年2'), 'B', '季数别名应命中同系列');
assert.equal(searchRelevanceTier('庆余年 第二季', '庆余年2'), 'B');
assert.equal(searchRelevanceTier('电影第二季', '电影2'), 'B');
assert.equal(searchRelevanceTier('庆余年第二季', '庆余年'), 'B', '查询无季数、标题有季数也算同系列');

// 8) 季数冲突：不同季必须丢弃（上游同款）
assert.equal(searchRelevanceTier('庆余年第一季', '庆余年2'), '', '季数不同应丢弃');
assert.equal(searchRelevanceTier('庆余年第三季', '庆余年2'), '', '季数不同应丢弃');

// 9) 公共前缀 ≥4 字：同系列不同写法（实测「哈利波特4火焰杯」↔「哈利·波特与火焰杯」）
assert.equal(searchRelevanceTier('哈利·波特与火焰杯', '哈利波特4火焰杯'), 'B', '同系列不同写法应命中');
assert.equal(searchRelevanceTier('哈利波特4：火焰杯', '哈利波特4火焰杯'), 'A', '归一后相等仍是 A 档');
assert.equal(searchRelevanceTier('宝贝 小偷与大盗', '小偷'), '', '公共前缀不足 4 字，不应误伤');

// 10) 年份解析：vod_year 带杂值时抽 4 位，抽不到退回 vod_pubdate
assert.equal(parseYear({ vod_year: '2005' }), 2005);
assert.equal(parseYear({ vod_year: '0' }), 0, '"0" 不是年份');
assert.equal(parseYear({ vod_year: '2019–' }), 2019, '"2019–" 抽出 2019');
assert.equal(parseYear({ vod_year: '0', vod_pubdate: '2019-11-26(中国内地)' }), 2019, '退回 pubdate');

// 11) 年份序：同系列按上映年份排，新的在前（实测「哈利波特」→ 混血王子2009 → 火焰杯2005 → 魔法石2001）
{
    const groups = rankSearchGroups(groupsOf([
        item('哈利·波特与混血王子', 'a', '1', undefined, '2009'),
        item('哈利·波特与火焰杯', 'a', '2', undefined, '2005'),
        item('哈利·波特与魔法石', 'a', '3', undefined, '2001')
    ]), '哈利波特');

    assert.deepEqual(groups.map(g => g.name), ['哈利·波特与混血王子', '哈利·波特与火焰杯', '哈利·波特与魔法石'],
        '同系列按上映年份降序（新的在前），不是按源数或更新时间的倒序');
}

// 12) 年份缺失排最后（vod_year="0" 且无 pubdate）
{
    const groups = rankSearchGroups(groupsOf([
        item('哈利·波特与魔法石', 'a', '1', undefined, '2001'),
        item('哈利·波特与未知年份', 'a', '2', undefined, '0')
    ]), '哈利波特');

    assert.deepEqual(groups.map(g => g.name), ['哈利·波特与魔法石', '哈利·波特与未知年份'],
        '无年份的条目排到同档末尾');
}

// 13) 具体度优先：搜具体某一部时，最贴合查询的条目必须排在同系列老片前面
// （实测「哈利波特4火焰杯」下「哈利波特4火焰杯(普通话版)」前缀 8 字、「哈利·波特与魔法石」只有 4 字）
{
    const groups = rankSearchGroups(groupsOf([
        item('哈利·波特与魔法石', 'a', '1', undefined, '2001'),
        item('哈利波特4火焰杯(普通话版)', 'a', '2', undefined, '2005'),
        item('哈利·波特与混血王子', 'a', '3', undefined, '2009')
    ]), '哈利波特4火焰杯');

    assert.deepEqual(groups.map(g => g.name),
        ['哈利波特4火焰杯(普通话版)', '哈利·波特与混血王子', '哈利·波特与魔法石'],
        '搜具体某一部时，最贴合查询的排最前，其余同系列按年份降序');
}

// 14) 搜系列名时具体度并列 → 仍按年份序（不能让具体度键压掉年份序）
{
    const groups = rankSearchGroups(groupsOf([
        item('哈利·波特与混血王子', 'a', '1', undefined, '2009'),
        item('哈利·波特与魔法石', 'a', '2', undefined, '2001')
    ]), '哈利波特');

    assert.deepEqual(groups.map(g => g.name), ['哈利·波特与混血王子', '哈利·波特与魔法石'],
        '搜系列名时前缀长度相同并列，落回年份降序（新的在前）');
}

console.log('search-relevance.test.js: 全部断言通过 ✓');
