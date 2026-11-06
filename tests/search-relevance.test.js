// 搜索相关性三档的自检：node tests/search-relevance.test.js
// A 档 = 归一后完全相等；B 档 = 归一后前缀匹配（单列、不与 A 档合并）；C 档 = 都不匹配（不展示）
// 样本用实测到的真实片名：393 个真实片名里有 13 个「别的片名以它开头」，
// 合并会把「步步惊心」和「步步惊心泰国版」当成一部，用户点进去播到错的内容。
const assert = require('node:assert/strict');

require('../js/aggregate.js');

const { searchRelevanceTier, rankSearchGroups, normalizeTitle } = globalThis.Aggregation;

const item = (name, source, id, time) => ({
    vod_name: name,
    vod_name_normalized: undefined,
    vod_year: '2026',
    vod_id: id,
    source_code: source,
    source_name: source,
    vod_time: time || '2026-11-01 10:00:00',
    vod_remarks: ''
});

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
    const groups = rankSearchGroups([
        { name: '步步惊心泰国版', sourceCount: 3, items: [item('步步惊心泰国版', 'a', '1')] },
        { name: '步步惊心', sourceCount: 2, items: [item('步步惊心', 'a', '2'), item('步步惊心', 'b', '3')] },
        { name: '宝贝 小偷与大盗', sourceCount: 5, items: [item('宝贝 小偷与大盗', 'a', '6')] }
    ], '步步惊心');

    assert.equal(groups.length, 2, 'C 档（不相关）应被丢掉');
    assert.equal(groups[0].name, '步步惊心', 'A 档应在 B 档之前');
    assert.equal(groups[0].tier, 'A');
    assert.equal(groups[1].name, '步步惊心泰国版', 'B 档单列，不与 A 档合并');
    assert.equal(groups[1].tier, 'B');
}

// 5) 同档内：源数多的在前；源数相同按 vod_time 新的在前
// （注意「庆余年2」归一后不等于「庆余年」，所以它是 B 档，不会与 A 档合并）
{
    const groups = rankSearchGroups([
        { name: '庆余年', sourceCount: 1, items: [item('庆余年', 'a', '1', '2026-11-06 10:00:00')] },
        { name: '庆余年2', sourceCount: 3, items: [item('庆余年2', 'a', '2'), item('庆余年2', 'b', '3'), item('庆余年2', 'c', '4')] },
        { name: '庆余年3', sourceCount: 2, items: [item('庆余年3', 'a', '5', '2026-11-02 10:00:00'), item('庆余年3', 'b', '6', '2026-11-05 10:00:00')] },
        { name: '庆余年4', sourceCount: 2, items: [item('庆余年4', 'a', '7', '2026-11-01 10:00:00'), item('庆余年4', 'b', '8', '2026-11-02 10:00:00')] }
    ], '庆余年');

    assert.deepEqual(groups.map(g => g.name), ['庆余年', '庆余年2', '庆余年3', '庆余年4'],
        'A 档在前；B 档内按源数倒序，源数相同按 vod_time 倒序（庆余年3 的最新时间比庆余年4 新）');
    assert.deepEqual(groups.map(g => g.tier), ['A', 'B', 'B', 'B']);
}

// 6) 归一：去空白/标点/符号 + 转小写，数字保留
assert.equal(normalizeTitle('摔跤吧!爸爸'), '摔跤吧爸爸');
assert.equal(normalizeTitle('电影2'), '电影2');
assert.equal(normalizeTitle('沧元图3D动漫版'), '沧元图3d动漫版');

console.log('search-relevance.test.js: 全部断言通过 ✓');
