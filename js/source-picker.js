// ==== 共用选源弹窗 ====
// 首页「最近更新」点卡片 与 播放器页「切换资源」共用这一个实现：
//   ① 按片名跨源搜同名候选（复用 search.js 的 searchByAPIAndKeyWord，与搜索页同一套源）
//   ② 并发测速：两段分开计时 —— 经本站代理取片单（切源要等多久）、
//      浏览器直连播放地址（播起来快不快）；排序用直连那段
//      （取不到片单 → 标成不可用并写明原因）
//   ③ 排序：当前播放的源置顶，其余按速度从快到慢；测速失败的源留在列表里不静默消失
//   ④ 渲染源卡片（封面 + 速度角标 + 集数 + 当前播放标记），卡片紧跟标题
// 点卡片 = 选中该源；「播放此源」或直接点卡片触发的播放动作交给调用方
//（首页开详情页、播放器调 switchToResource 切源）。

const sourcePickerState = {
    controller: null,      // 关闭弹窗时用它中止在途的搜索/测速请求
    entries: [],           // 候选源：测速结果 + DOM 引用
    selectedKey: '',       // 选中态绑稳定标识（源key_片id），测速重排后仍指向同一个源
    open: false,
    onPick: null,          // 播放动作：首页开详情页 / 播放器切源
    clickToPlay: false,    // 点卡片直接播放（播放器用）；否则点卡片只选中
    currentSourceKey: '',
    currentVodId: '',
    knownItems: []         // 调用方已知的同片条目（首页最近更新的聚合结果）
};

// 来源在弹窗里的稳定标识：测速结果会重排，绑下标会指错源
function sourcePickerEntryKey(entry) {
    return `${entry.sourceKey}_${entry.vodId}`;
}

// 自定义源配置：app.js 的 getCustomApiInfo 只在首页页可用（player.html 不加载 app.js），
// 这里自己从 localStorage 读一份，两个页面都能用
function getSourcePickerCustomApi(index) {
    try {
        const list = JSON.parse(localStorage.getItem('customAPIs') || '[]');
        const i = parseInt(index, 10);
        return (Number.isInteger(i) && i >= 0 && i < list.length) ? list[i] : null;
    } catch (e) {
        return null;
    }
}

// 跨源搜候选时用哪些源：用户在设置里勾选的源（与搜索页一致）；
// 还没写过 localStorage 时用与 js/app.js 相同的默认集
function getSourcePickerOptions() {
    let keys;
    try {
        keys = JSON.parse(localStorage.getItem('selectedAPIs') || 'null');
    } catch (e) {
        keys = null;
    }
    if (!Array.isArray(keys) || !keys.length) {
        // 唯一真源在 config.js 的 getDefaultSourceKeys()（别再手抄一份 —— 改那边它不会跟着变）
        keys = typeof getDefaultSourceKeys === 'function'
            ? getDefaultSourceKeys()
            : Object.keys(window.API_SITES || {});
    }
    const sites = window.API_SITES || {};
    return keys.map(key => {
        if (sites[key]) return { key, name: sites[key].name };
        if (String(key).startsWith('custom_')) {
            const custom = getSourcePickerCustomApi(String(key).replace('custom_', ''));
            if (custom) return { key, name: custom.name || '自定义资源' };
        }
        return { key, name: '未知资源' };
    });
}

// /api/detail 的源参数：内置源直接给 source，自定义源要带 customApi（可能带 customDetail）
function sourcePickerApiParams(sourceKey) {
    if (String(sourceKey).startsWith('custom_')) {
        const custom = getSourcePickerCustomApi(String(sourceKey).replace('custom_', ''));
        if (!custom) return null;
        if (custom.detail) {
            return `&customApi=${encodeURIComponent(custom.url)}&customDetail=${encodeURIComponent(custom.detail)}&source=custom`;
        }
        return `&customApi=${encodeURIComponent(custom.url)}&source=custom`;
    }
    return `&source=${encodeURIComponent(sourceKey)}`;
}

// 档位判定：归一后完全相等 = A 档；前缀匹配 = B 档（近似）。
// 与搜索候选用同一套口径，两路来源才能合并去重。
function sourcePickerMatchTier(name, query) {
    const n = normalizeTitle(name);
    if (n === query) return 'A';
    if (n.startsWith(query)) return 'B';
    return '';
}

// 「最近更新」已经把这些源的条目取回来了（含 source_code / vod_id / 播放地址），
// 而 listOnly 源的关键词搜索接口本身不可用 —— 它们的候选只能从这里取。
// 命中规则与搜索候选一致（A 档相等 / B 档前缀），所以两路来源可以合并去重。
function collectKnownSourceCandidates(title, knownItems) {
    if (!Array.isArray(knownItems) || !knownItems.length) return [];
    const query = normalizeTitle(title);
    const best = new Map();          // sourceKey -> {item, tier}

    knownItems.forEach(item => {
        if (!item || !item.source_code) return;
        const tier = sourcePickerMatchTier(item.vod_name, query);
        if (!tier) return;
        const key = item.source_code;
        const prev = best.get(key);
        // A 档优先；同为 A 档时保留先到的（同一源同一部片只出一个候选）
        if (!prev || (tier === 'A' && prev.tier !== 'A')) {
            best.set(key, { item, tier });
        }
    });

    const sites = window.API_SITES || {};
    return Array.from(best.entries()).map(([sourceKey, rec]) => {
        const item = rec.item;
        return {
            sourceKey,
            sourceName: (sites[sourceKey] && sites[sourceKey].name) || item.source_name || sourceKey,
            vodId: String(item.vod_id || ''),
            name: item.vod_name || title,
            pic: item.vod_pic || '',
            approx: rec.tier === 'B',
            // 标记：这条候选来自已知数据，不需要再跨源搜一次
            fromKnown: true
        };
    });
}

// 跨源搜同名候选，两档：
//   A 档 = 归一后完全相等（「庆余年」）；B 档 = 归一后前缀匹配（「庆余年 第二季」「小偷 HD」「小偷[电影解说]」）
// C 档（既不相等也不是前缀）不展示——以前只认原文完全相等，「小偷 HD」这类修饰名版本会让整个源消失；
// B 档单列并标注「近似」，不与 A 档合并（避免把两部片子当成一部、播到错的内容）。
// knownItems：调用方已知的同片条目（如首页最近更新的聚合结果）。
//   它的作用是补上「搜不到但确实有这部片」的源 —— 典型就是 listOnly 源：
//   它们的关键词搜索接口不可用，但最近更新已经把它们取回来了。
async function collectSourcePickerCandidates(title, signal, knownItems) {
    const options = getSourcePickerOptions();
    const query = normalizeTitle(title);
    const searched = await Promise.all(options.map(async opt => {
        const outcome = await searchByAPIAndKeyWord(opt.key, title, signal);
        const list = outcome && outcome.list;
        if (!list || !list.length) return null;

        let hit = null;
        let tier = '';
        list.forEach(item => {
            const t = sourcePickerMatchTier(item && item.vod_name, query);
            if (t === 'A') {
                hit = item;
                tier = 'A';
            } else if (t === 'B' && !tier) {
                hit = item;
                tier = 'B';
            }
        });
        if (!hit) return null;

        return {
            sourceKey: opt.key,
            sourceName: opt.name,
            vodId: String(hit.vod_id || ''),
            name: hit.vod_name || title,
            pic: hit.vod_pic || '',
            approx: tier === 'B'
        };
    }));

    const fromSearch = searched.filter(Boolean);
    const fromKnown = collectKnownSourceCandidates(title, knownItems);

    // 两路合并：同一源只留一条（搜索结果优先 —— 它是现搜的，更贴近当前片名）
    const merged = new Map();
    fromKnown.forEach(c => merged.set(c.sourceKey, c));
    fromSearch.forEach(c => merged.set(c.sourceKey, c));
    return Array.from(merged.values());
}

// 测速一个来源：两段分开计时 ——
//   ① 代理取片单（proxyMs）：本站边缘 → 源站 CMS，切到这一源要先等它
//   ② 直连播放地址（directMs）：用户浏览器 → 源站 CDN，播起来快不快
// 排序用 ②（直连优先）；②不通时退回 ① 并注明「仅测到片单」——
// 两种耗时不再混成一个总数，否则边缘开销会把快源压到慢源后面。
async function testSourcePickerSpeed(sourceKey, vodId, signal) {
    // 失败一律走这个形状：directMs/proxyMs 恒为数字，调用方不用判 undefined
    const fail = (error, proxyMs = -1) => ({ speed: -1, directMs: -1, proxyMs, error });
    try {
        const params = sourcePickerApiParams(sourceKey);
        if (!params) return fail('API配置无效');

        const proxyStarted = performance.now();
        const response = await fetch(`/api/detail?id=${encodeURIComponent(vodId)}${params}&_t=${Date.now()}`, {
            method: 'GET',
            cache: 'no-cache',
            signal
        });
        if (signal.aborted) return fail('已取消');

        const data = await response.json();
        const proxyMs = Math.round(performance.now() - proxyStarted);
        if (!data || data.code !== 200) {
            return fail((data && data.msg) || '获取失败', proxyMs);
        }
        // 本站取不到片单 ≠ 这个源不存在：可能只是没收录或上游接口挂了，如实说清楚
        if (!Array.isArray(data.episodes) || !data.episodes.length) {
            return fail('本站取不到片单', proxyMs);
        }
        const firstUrl = data.episodes[0];
        if (!firstUrl) return fail('链接无效', proxyMs);

        // 直连播放地址：用户真正要连的那台服务器（不经代理、不碰 KV）
        const directMs = await probeDirectLatency(firstUrl, signal, 5000);
        if (signal.aborted) return fail('已取消', proxyMs);

        return {
            speed: directMs >= 0 ? directMs : proxyMs,
            directMs,
            proxyMs,
            episodes: data.episodes.length,
            playUrl: firstUrl,        // 画质探测用：已是挑过 m3u8 直链的可播放地址
            error: null
        };
    } catch (error) {
        if (signal.aborted) return fail('已取消');
        return fail(error.name === 'AbortError' ? '超时' : '测试失败');
    }
}

// 单个来源的卡片（与播放器页「切换资源」的卡片同款）
function sourcePickerCardHtml(entry) {
    const key = sourcePickerEntryKey(entry);
    const currentClass = entry.isCurrent ? 'current' : '';
    // 侧栏只有 440px 宽 —— 用一行（源名 + 实测延迟）而不是海报网格
    // 画质徽章紧跟源名文字：名字自己省略，徽章不被挤到行尾（名字是 flex:1，直接排会把徽章顶到速度角标旁边）
    return `
        <div class="kt-pick ${currentClass}" data-source-key="${escapeText(key)}" role="button" tabindex="0"
             title="${escapeText(entry.sourceName)}${entry.isCurrent ? '（当前播放）' : ''}">
            <span class="nm-row"><span class="nm">${escapeText(entry.name)}${entry.approx ? ' <span class="kt-src-badge approx">近似</span>' : ''}</span><span class="q-badge" data-quality-badge hidden></span></span>
            <span class="ms" data-source-badge><span class="speed-indicator">测速中</span></span>
        </div>`;
}

// 渲染源卡片网格（紧跟标题，详情信息在网格之后）
function renderSourcePickerGrid() {
    const grid = document.getElementById('sourcePickerGrid');
    if (!grid) return;

    grid.innerHTML = sourcePickerState.entries.map(sourcePickerCardHtml).join('');

    grid.querySelectorAll('[data-source-key]').forEach(card => {
        const key = card.getAttribute('data-source-key');
        const entry = sourcePickerState.entries.find(item => sourcePickerEntryKey(item) === key);
        if (!entry) return;
        entry.card = card;
        entry.badge = card.querySelector('[data-source-badge]');
        entry.qualityBadge = card.querySelector('[data-quality-badge]');
        renderQualityBadge(entry.qualityBadge, entry.quality);
        entry.noteEl = card.querySelector('[data-source-note]');
        const img = card.querySelector('img');
        if (img) {
            img.addEventListener('error', () => {
                img.onerror = null;
                img.src = LATEST_PLACEHOLDER_IMAGE;
                img.classList.add('object-contain');
            });
        }
        if (!entry.isCurrent) {
            card.addEventListener('click', () => selectSourcePickerEntry(key, true));
        }
    });
}

// 回填一个来源的测速结果（只改角标，不重建卡片：重建会让封面重复请求）
function refreshSourcePickerEntry(entry) {
    renderQualityBadge(entry.qualityBadge, entry.quality);
    if (entry.badge) {
        entry.badge.innerHTML = entry.pending
            ? '<span class="speed-indicator">测速中</span>'
            : formatSpeedDisplay(entry.speed >= 0
                ? { speed: entry.speed, directMs: entry.directMs, proxyMs: entry.proxyMs }
                : { speed: -1, error: escapeText(entry.error || '失败') });
    }
    if (entry.noteEl) {
        entry.noteEl.textContent = entry.pending ? '' : (entry.speed >= 0
            ? `${entry.episodes}集`
            : (entry.error || '测速失败'));
        entry.noteEl.title = entry.noteEl.textContent;
        entry.noteEl.className = entry.pending || entry.speed >= 0
            ? 'text-[10px] text-gray-500 mt-1'
            : 'text-[10px] text-red-400 mt-1';
    }
}

// 排序：当前播放的源置顶，其余按速度从快到慢，测速失败的排最后（但仍留在列表里）
// 返回排好序的数组（调用方据此决定默认选中哪个）
function sortSourcePickerEntries() {
    const grid = document.getElementById('sourcePickerGrid');

    const rank = entry => {
        if (entry.isCurrent) return 0;
        if (sourcePickerState.currentSourceKey && entry.sourceKey === sourcePickerState.currentSourceKey) return 1;
        return 2;
    };
    const speedOf = entry => (entry.speed >= 0 ? entry.speed : Number.MAX_SAFE_INTEGER);

    const sorted = [...sourcePickerState.entries].sort((a, b) => rank(a) - rank(b) || speedOf(a) - speedOf(b));
    if (grid) sorted.forEach(entry => { if (entry.card) grid.appendChild(entry.card); });
    return sorted;
}

function updateSourcePickerSummary() {
    const summary = document.getElementById('sourcePickerSummary');
    if (!summary) return;
    const total = sourcePickerState.entries.length;
    const ok = sourcePickerState.entries.filter(entry => entry.speed >= 0).length;
    summary.textContent = total ? `来源 ${total} · 可用 ${ok}` : '没有找到同名资源';
}

// 选中某个来源（绑稳定标识，测速重排后仍然指向同一个源）
// triggerPlay：用户点了卡片（播放器里点卡片即切源）；测速结束后的自动选中不传
function selectSourcePickerEntry(key, triggerPlay) {
    sourcePickerState.selectedKey = key;
    sourcePickerState.entries.forEach(entry => {
        if (!entry.card) return;
        const active = sourcePickerEntryKey(entry) === key;
        entry.card.classList.toggle('ring-2', active);
        entry.card.classList.toggle('ring-pink-500', active);
    });
    renderSourcePickerDetail();

    const entry = sourcePickerState.entries.find(item => sourcePickerEntryKey(item) === key);
    // 播放器：用户点卡片直接切源；首页：点卡片只选中，由「播放此源」按钮走详情流程
    if (triggerPlay && entry && sourcePickerState.clickToPlay && sourcePickerState.onPick) {
        const onPick = sourcePickerState.onPick;
        closeSourcePicker();
        onPick(entry);
    }
}

// 选中源的详情与播放入口
function renderSourcePickerDetail() {
    const detail = document.getElementById('sourcePickerDetail')
        || document.getElementById('sourcePickerTop');
    if (!detail) return;

    const entry = sourcePickerState.entries.find(item => sourcePickerEntryKey(item) === sourcePickerState.selectedKey);
    if (!entry) {
        detail.innerHTML = '<div class="text-center py-4 text-gray-500 text-sm">选择一个来源</div>';
        return;
    }

    // 详情面板与角标同一套口径（直连 / 切源），别再显示混算的总数
    const speedText = entry.pending
        ? '测速中...'
        : (entry.speed >= 0
            ? `${entry.directMs >= 0 ? `直连 ${entry.directMs}ms` : '仅测到片单'}`
                + (entry.proxyMs >= 0 ? ` · 切源 ${entry.proxyMs}ms` : '')
            : `不可用：${entry.error || '测速失败'}`);

    detail.innerHTML = `
        <div class="flex items-start gap-3 p-3 bg-[var(--kt-raised)] rounded-lg border border-[var(--kt-line)]">
            <img src="${escapeText(entry.pic) || LATEST_PLACEHOLDER_IMAGE}" alt=""
                 class="w-14 aspect-[2/3] object-cover rounded shrink-0">
            <div class="flex-1 min-w-0">
                <div class="kt-pick-name-row">
                    <div class="text-sm font-semibold text-white truncate" title="${escapeText(entry.sourceName)}">${escapeText(entry.sourceName)}</div>
                    <span class="q-badge" data-quality-badge hidden></span>
                </div>
                <div class="mt-1 text-xs text-gray-400">
                    ${escapeText(speedText)}${entry.episodes ? ` · ${entry.episodes} 集` : ''}
                </div>
                <button id="sourcePickerPlayBtn" class="kt-btn pri mt-2">
                    播放此源
                </button>
            </div>
        </div>`;

    // 详情卡里的画质徽章跟列表行是同一份数据（重建了 DOM，重新填一次）
    renderQualityBadge(detail.querySelector('[data-quality-badge]'), entry.quality);

    const img = detail.querySelector('img');
    if (img) {
        img.addEventListener('error', () => {
            img.onerror = null;
            img.src = LATEST_PLACEHOLDER_IMAGE;
            img.classList.add('object-contain');
        });
    }
    const playBtn = document.getElementById('sourcePickerPlayBtn');
    if (playBtn) {
        playBtn.addEventListener('click', () => {
            const onPick = sourcePickerState.onPick;
            closeSourcePicker();
            if (onPick) onPick(entry);
        });
    }
}

// 并发闸：画质探测一次最多 2 个（同时开 8 个 hls 实例会把手机带宽吃光）
function createLimiter(limit) {
    let active = 0;
    const queue = [];
    const pump = () => {
        while (active < limit && queue.length) {
            active++;
            const job = queue.shift();
            job.run().then(job.resolve, job.reject).finally(() => { active--; pump(); });
        }
    };
    return run => new Promise((resolve, reject) => {
        queue.push({ run, resolve, reject });
        pump();
    });
}

const sourcePickerQualityLimiter = createLimiter(2);

// 探测这个源的画质：起一个隐藏 video 实测它自己的分辨率（不是清单声明值）
function probeSourcePickerQuality(entry, playUrl, signal) {
    // 同一个「源+影片」探过就别再探了（缓存命中直接用）
    const cached = getCachedQuality(entry.sourceKey, entry.vodId);
    if (cached) {
        entry.quality = cached;
        refreshSourcePickerEntry(entry);
        return;
    }
    if (!playUrl) {
        entry.quality = { state: 'failed' };
        putCachedQuality(entry.sourceKey, entry.vodId, entry.quality);
        refreshSourcePickerEntry(entry);
        return;
    }
    // 超时给 12s：源站 CDN 冷启动时首个分片可能要 10s 上下（实测同一地址冷 15s 超时、热 4s 出结果），
    // 超时给小了会把「慢但正常」的源误标成「未测到」
    sourcePickerQualityLimiter(() => probeVideoQuality(playUrl, signal, 12000)).then(quality => {
        if (!sourcePickerState.open) return;
        entry.quality = quality
            ? { state: 'measured', width: quality.width, height: quality.height }
            : { state: 'failed' };
        putCachedQuality(entry.sourceKey, entry.vodId, entry.quality);
        refreshSourcePickerEntry(entry);
    });
}

// 打开选源弹窗
// options: { title, currentSourceKey, currentVodId, onPick, clickToPlay }
function openSourcePicker(options) {
    const opts = options || {};
    const modal = document.getElementById('modal');
    const content = document.getElementById('modalContent');
    const title = document.getElementById('modalTitle');
    if (!modal || !content) return;

    closeSourcePicker();     // 关掉上一个（顺带中止在途请求）

    const pickerTitle = opts.title ? String(opts.title) : '';
    sourcePickerState.onPick = typeof opts.onPick === 'function' ? opts.onPick : null;
    sourcePickerState.clickToPlay = !!opts.clickToPlay;
    sourcePickerState.currentSourceKey = opts.currentSourceKey ? String(opts.currentSourceKey) : '';
    sourcePickerState.currentVodId = opts.currentVodId ? String(opts.currentVodId) : '';
    // 调用方已知的同片条目：用于补上「搜不到但确实有这部片」的源（listOnly 源）
    sourcePickerState.knownItems = Array.isArray(opts.knownItems) ? opts.knownItems : [];
    sourcePickerState.open = true;
    sourcePickerState.selectedKey = '';

    if (title) title.innerHTML = `<span class="break-words">${escapeText(pickerTitle)}</span>`;
    // 选源接管这个面板：把节目单底部的主操作清掉，别留着上一部片的「播放」
    const cta = document.getElementById('modalCta');
    if (cta) cta.innerHTML = '';
    // 「播放此源」卡片放最上面 —— 之前在列表末尾，要一路拉到下面才看得到
    // 播放此源卡片：优先放进面板顶部的固定槽（不随源列表滚动），
    // 没有固定槽的页面才退回内容区顶部。
    const topSlot = document.getElementById('sourcePickerTop');
    if (topSlot) topSlot.innerHTML = '';

    content.innerHTML = `
        ${topSlot ? '' : '<div id="sourcePickerDetail" class="mb-4"></div>'}
        <div id="sourcePickerSummary" class="text-xs text-gray-400 mb-3">正在搜索其它来源...</div>
        <div id="sourcePickerGrid" class="kt-pick-list"></div>`;
    modal.classList.remove('hidden');

    const controller = new AbortController();
    sourcePickerState.controller = controller;

    collectSourcePickerCandidates(pickerTitle, controller.signal, sourcePickerState.knownItems)
        .then(candidates => {
            // 弹窗已关闭：不启动测速，避免关闭后还有请求在飞
            if (!sourcePickerState.open) return;

            sourcePickerState.entries = candidates.map(item => ({
                ...item,
                speed: -1,
                directMs: -1,
                proxyMs: -1,
                error: '',
                episodes: 0,
                pending: true,
                quality: { state: 'pending' },
                isCurrent: !!sourcePickerState.currentSourceKey
                    && item.sourceKey === sourcePickerState.currentSourceKey
                    && item.vodId === sourcePickerState.currentVodId
            }));
            renderSourcePickerGrid();
            renderSourcePickerDetail();
            updateSourcePickerSummary();

            return Promise.all(sourcePickerState.entries.map(entry =>
                testSourcePickerSpeed(entry.sourceKey, entry.vodId, controller.signal).then(result => {
                    if (!sourcePickerState.open) return;
                    entry.speed = result.speed;
                    entry.directMs = result.directMs != null ? result.directMs : -1;
                    entry.proxyMs = result.proxyMs != null ? result.proxyMs : -1;
                    entry.error = result.error || '';
                    entry.episodes = result.episodes || 0;
                    entry.pending = false;
                    refreshSourcePickerEntry(entry);
                    probeSourcePickerQuality(entry, result.playUrl, controller.signal);
                })
            )).then(() => {
                if (!sourcePickerState.open) return;
                const sorted = sortSourcePickerEntries();
                updateSourcePickerSummary();
                if (!sourcePickerState.selectedKey && sorted.length) {
                    // 默认选中最快的可用源（当前播放的源除外）
                    const pick = sorted.find(entry => !entry.isCurrent && entry.speed >= 0)
                        || sorted.find(entry => entry.speed >= 0)
                        || sorted[0];
                    selectSourcePickerEntry(sourcePickerEntryKey(pick));
                }
            });
        })
        .catch(error => {
            if (!sourcePickerState.open) return;
            console.warn('选源弹窗加载失败:', error);
            updateSourcePickerSummary();
        });
}

// 关闭弹窗：中止在途的搜索/测速请求（上游特意做了这条：否则关了弹窗请求还在跑）
function closeSourcePicker() {
    if (sourcePickerState.controller) {
        sourcePickerState.controller.abort();
        sourcePickerState.controller = null;
    }
    sourcePickerState.entries = [];
    sourcePickerState.selectedKey = '';
    sourcePickerState.open = false;
}

// 弹窗基础交互：点遮罩关闭、Esc 关闭（只绑一次）
function initSourcePicker() {
    const modal = document.getElementById('modal');
    if (!modal) return;

    modal.addEventListener('click', event => {
        // 只有选源弹窗开着时才接管遮罩点击，详情弹窗（showDetails）行为不变
        if (!sourcePickerState.open) return;
        if (event.target === modal) {
            closeSourcePicker();
            if (typeof closeModal === 'function') closeModal();
        }
    });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !sourcePickerState.open) return;
        closeSourcePicker();
        if (typeof closeModal === 'function') closeModal();
    });
}
document.addEventListener('DOMContentLoaded', initSourcePicker);

window.openSourcePicker = openSourcePicker;
window.closeSourcePicker = closeSourcePicker;
