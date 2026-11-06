// ==== 跨源同名聚合 ====
// 同一部片子常常同时存在于多个源，各源的集数/完结文案又各写各的
// （「全34集」/「完结」/「更新至34集」说的是同一件事）。
// 这里把扁平的结果按「同名影片」聚成组：卡片只出一张，并把各源状态推成一句统一结论。
// 本文件是纯函数模块，不碰 DOM，也不改请求逻辑。

// 归一化标题：去空白、标点与符号，转小写。
// 用途是跨标点差异匹配（源站存「摔跤吧!爸爸」而用户搜「摔跤吧！爸爸」）。
// 数字不会被去掉，所以「电影2」与「电影」不会被归一成同一个。
function normalizeTitle(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

// 解析 vod_time：兼容 "2026-11-05 18:22:07" 与 "2026-11-05"；无法解析返回 0（排序时排最后）
function parseVodTime(value) {
    if (!value || typeof value !== 'string') return 0;
    const matched = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (!matched) return 0;
    const [, year, month, day, hour, minute, second] = matched;
    const time = new Date(+year, +month - 1, +day, +(hour || 0), +(minute || 0), +(second || 0)).getTime();
    return Number.isFinite(time) ? time : 0;
}

// ==== 搜索相关性三档 ====
// A 档 = 归一后完全相等；B 档 = 归一后前缀匹配；C 档 = 都不匹配（不展示）。
// 上游把「精确命中」排前面、「前缀命中」混在同一档；这里把前缀单列成 B 档、不与 A 档合并：
// 实测 393 个真实片名里有 13 个「别的片名以它开头」（步步惊心 / 步步惊心泰国版、
// 沧元图 / 沧元图3D动漫版、人气美食 / 人气美食2026……），
// 合并会把两部片子当成一部，用户点进去播到的却是另一部的内容。
const SEARCH_TIER_EXACT = 'A';
const SEARCH_TIER_PREFIX = 'B';

/** 归一后完全相等 → A 档；归一后前缀匹配 → B 档；其余（C 档）返回空串 */
function searchRelevanceTier(name, query) {
    const n = normalizeTitle(name);
    const q = normalizeTitle(query);
    if (!n || !q) return '';
    if (n === q) return SEARCH_TIER_EXACT;
    if (n.startsWith(q)) return SEARCH_TIER_PREFIX;
    return '';
}

/** 组内最新的更新时间（毫秒时间戳；无法解析按 0） */
function groupLatestTime(group) {
    return (group.items || []).reduce((max, item) => {
        const time = parseVodTime(item && item.vod_time);
        return time > max ? time : max;
    }, 0);
}

/**
 * 搜索结果分档 + 排序：
 * - C 档直接丢弃（上游特意不兜底取搜索第一条，否则搜到的会是别的影片）
 * - A 档在前、B 档在后；同档内「源数多的在前」，再「vod_time 新的在前」
 * 返回带 tier 标记的分组（B 档渲染时标「近似」，始终与 A 档分开）。
 */
function rankSearchGroups(groups, query) {
    return (groups || [])
        .map(group => {
            const tier = searchRelevanceTier(group.name, query);
            return tier ? { group, tier, time: groupLatestTime(group) } : null;
        })
        .filter(Boolean)
        .sort((a, b) => {
            if (a.tier !== b.tier) return a.tier === SEARCH_TIER_EXACT ? -1 : 1;
            if (a.group.sourceCount !== b.group.sourceCount) return b.group.sourceCount - a.group.sourceCount;
            return b.time - a.time;
        })
        .map(entry => Object.assign({}, entry.group, { tier: entry.tier }));
}

// ==== 备注（vod_remarks）归一 ====
// 该字段由各源自由填写，只归一「集数」与「完结状态」两类，
// 其余（HD国语 / 正片 / 年份等）原样保留——它们不是集数信息，强行改写只会把内容丢掉。

// 集数：「全34集」「第34集」「更新至12集」「共24集」都能取出数字
const REMARK_EPISODE_COUNT = /(\d+)\s*集/;
// 完结的明确表述。「剧终」而不单是「终」——否则「终极版」会被误判成已完结
const REMARK_FINISHED_WORD = /完结|大结局|全集|剧终/;
// 前置全称：「全34集」「共24集」
const REMARK_FINISHED_PREFIX = /(?:全|共)\s*\d+\s*集/;
// 后置全称：「34集全」
const REMARK_FINISHED_SUFFIX = /\d+\s*集\s*全/;

function isFinishedRemarks(text) {
    return REMARK_FINISHED_WORD.test(text) ||
        REMARK_FINISHED_PREFIX.test(text) ||
        REMARK_FINISHED_SUFFIX.test(text);
}

function remarkEpisodeCount(text) {
    const matched = REMARK_EPISODE_COUNT.exec(text);
    return matched ? Number(matched[1]) : 0;
}

/**
 * 归一备注文案，输出只有三种形态：
 * - 全N集：已完结且知道总集数
 * - 更新至N集：连载中且知道当前集数
 * - 已完结：完结但没有集数信息
 * 其余（HD国语 / 正片等）原样返回。幂等：归一过再跑一次结果不变。
 */
function formatRemarks(raw) {
    const text = raw == null ? '' : String(raw).trim();
    if (!text) return undefined;

    const finished = isFinishedRemarks(text);
    const count = remarkEpisodeCount(text);
    if (count > 0) return finished ? `全${count}集` : `更新至${count}集`;
    // 没有集数时，只有「完结」类表述能归一，别的保持原样
    if (finished) return '已完结';
    return text;
}

/**
 * 选源列表里的紧凑备注：「更新至1277集」→「1277 集」。
 * 非集数备注（HD国语 / 正片）剥掉无意义前缀后原样保留。
 */
function compactRemarks(raw) {
    const text = formatRemarks(raw);
    if (!text) return undefined;
    const episode = /^(?:全|更新至)(\d+)集$/.exec(text);
    if (episode) {
        const count = parseInt(episode[1], 10);
        return count > 1 ? `${count} 集` : undefined;
    }
    const prefixed = /^(?:全|更(?:新至|新|至))\s*(.+)$/.exec(text);
    if (prefixed) return prefixed[1].trim() || undefined;
    return text;
}

/**
 * 推断整组（同一部剧所有来源）的统一备注。
 * 单看一个源补不出集数：标「已完结」的源就是没写总集数。
 * 但同一部剧的总集数是客观的，组内只要有源写了「全34集」，就能确定这部剧是 34 集。
 * 优先级：总集数 > 完结 > 进度（拿「更新至N集」当总集数是错的，那是进度不是总数）。
 * 注意这是推断：该源自己的原始标注仍保留在来源行的备注里，信息不丢。
 */
function inferGroupRemarks(raws) {
    let total = 0;
    let progress = 0;
    let finished = false;
    let fallback;

    (raws || []).forEach(raw => {
        const text = formatRemarks(raw);
        if (!text) return;
        if (fallback === undefined) fallback = text;

        const totalMatch = /^全(\d+)集$/.exec(text);
        if (totalMatch) {
            total = Math.max(total, Number(totalMatch[1]));
            return;
        }
        const progressMatch = /^更新至(\d+)集$/.exec(text);
        if (progressMatch) {
            progress = Math.max(progress, Number(progressMatch[1]));
            return;
        }
        if (text === '已完结') finished = true;
    });

    if (total > 0) return `全${total}集`;
    if (finished) return '已完结';
    if (progress > 0) return `更新至${progress}集`;
    return fallback;
}

// ==== 分组 ====

// 条目的年份：缺失/空白一律当作没有年份
function vodYearOf(item) {
    return item && item.vod_year ? String(item.vod_year).trim() : '';
}

// 组内来源数：同一源同一片名只算一次（同一源的列表里偶尔会出现重复条目）
function countGroupSources(items) {
    const sources = new Set();
    (items || []).forEach(item => {
        if (item && item.source_code) sources.add(item.source_code);
    });
    return sources.size;
}

// 组内取第一个有的年份/分类/封面
function buildAggregatedGroup(name, year, items) {
    const firstOf = field => {
        const hit = items.find(item => item && item[field]);
        return hit ? hit[field] : undefined;
    };

    return {
        key: `${name}|${year}|${items.map(item =>
            `${(item && item.source_code) || ''}_${(item && item.vod_id) || ''}`
        ).join(',')}`,
        name,
        year,
        typeName: firstOf('type_name'),
        pic: firstOf('vod_pic'),
        remarks: inferGroupRemarks(items.map(item => (item && item.vod_remarks) || undefined)),
        sourceCount: countGroupSources(items),
        items
    };
}

/**
 * 把扁平的跨源结果按「同名影片」聚成组：
 * - 以「名称（trim 后）」精确分桶（不做激进归一）；
 * - 桶内年份不一致时（同名翻拍）按年份拆成多个组，无年份的条目单独成组；
 * - 兜底：归一后同名且年份一致的组再合并（标点差异的同一部片）；
 * - 组的年份/分类/封面取组内第一个有的那个，备注推成一句统一结论。
 * 保持传入顺序，因此调用方原有的排序（按更新时间倒序）不会被破坏。
 */
function aggregateResults(list) {
    const items = Array.isArray(list) ? list.filter(Boolean) : [];

    // 1) 精确名分桶
    const byName = new Map();
    items.forEach(item => {
        const name = item && item.vod_name ? String(item.vod_name).trim() : '';
        if (!name) return;
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name).push(item);
    });

    // 2) 桶内按年份拆分（同名不同年是不同作品）
    const split = [];
    byName.forEach((bucket, name) => {
        const years = [...new Set(bucket.map(vodYearOf).filter(Boolean))];
        if (years.length > 1) {
            years.forEach(year => {
                split.push({ name, year, items: bucket.filter(item => vodYearOf(item) === year) });
            });
            const noYear = bucket.filter(item => !vodYearOf(item));
            if (noYear.length) split.push({ name, year: '', items: noYear });
        } else {
            split.push({ name, year: years[0] || '', items: bucket });
        }
    });

    // 3) 兜底合并：归一后同名且年份一致的组合并（年份不同不合并，避免把翻拍并成一部）
    const merged = new Map();
    split.forEach(group => {
        const key = `${normalizeTitle(group.name)}|${group.year}`;
        if (!merged.has(key)) merged.set(key, { name: group.name, year: group.year, items: [] });
        merged.get(key).items.push(...group.items);
    });

    return Array.from(merged.values()).map(group =>
        buildAggregatedGroup(group.name, group.year, group.items)
    );
}

// 暴露到全局（浏览器里即 window.Aggregation，Node 自检里用 globalThis.Aggregation）
globalThis.Aggregation = {
    aggregateResults,
    normalizeTitle,
    parseVodTime,
    searchRelevanceTier,
    rankSearchGroups,
    formatRemarks,
    compactRemarks,
    inferGroupRemarks
};
