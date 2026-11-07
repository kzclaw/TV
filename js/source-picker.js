// ==== 共用选源弹窗 ====
// 首页「最近更新」点卡片 与 播放器页「切换资源」共用这一个实现：
//   ① 按片名跨源搜同名候选（复用 search.js 的 searchByAPIAndKeyWord，与搜索页同一套源）
//   ② 并发测速：两次请求 —— 先请求该源详情，再请求该源的第一个播放地址，
//      两次的总耗时当速度指标（取不到剧集 → 标成不可用并写明原因）
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
    currentVodId: ''
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
        keys = ['dyttzy', 'bfzy', 'ruyi', 'ffzy'];
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

// 跨源搜同名候选，两档：
//   A 档 = 归一后完全相等（「庆余年」）；B 档 = 归一后前缀匹配（「庆余年 第二季」「小偷 HD」「小偷[电影解说]」）
// C 档（既不相等也不是前缀）不展示——以前只认原文完全相等，「小偷 HD」这类修饰名版本会让整个源消失；
// B 档单列并标注「近似」，不与 A 档合并（避免把两部片子当成一部、播到错的内容）。
async function collectSourcePickerCandidates(title, signal) {
    const options = getSourcePickerOptions();
    const query = normalizeTitle(title);
    const found = await Promise.all(options.map(async opt => {
        const outcome = await searchByAPIAndKeyWord(opt.key, title, signal);
        const list = outcome && outcome.list;
        if (!list || !list.length) return null;

        let hit = null;
        let tier = '';
        list.forEach(item => {
            const name = normalizeTitle(item && item.vod_name);
            if (name === query) {
                hit = item;
                tier = 'A';
            } else if (!tier && name.startsWith(query)) {
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
    return found.filter(Boolean);
}

// 测速一个来源：两次请求 —— ① 该源详情 ② 该源的第一个播放地址，总耗时当速度指标
async function testSourcePickerSpeed(sourceKey, vodId, signal) {
    const started = performance.now();
    try {
        const params = sourcePickerApiParams(sourceKey);
        if (!params) return { speed: -1, error: 'API配置无效' };

        const response = await fetch(`/api/detail?id=${encodeURIComponent(vodId)}${params}&_t=${Date.now()}`, {
            method: 'GET',
            cache: 'no-cache',
            signal
        });
        if (signal.aborted) return { speed: -1, error: '已取消' };

        const data = await response.json();
        if (!data || data.code !== 200) {
            return { speed: -1, error: (data && data.msg) || '获取失败' };
        }
        // 该源取不到剧集 → 不可用（写明原因，源仍留在列表里）
        if (!Array.isArray(data.episodes) || !data.episodes.length) {
            return { speed: -1, error: '无播放源' };
        }
        const firstUrl = data.episodes[0];
        if (!firstUrl) return { speed: -1, error: '链接无效' };

        try {
            await fetch(firstUrl, {
                method: 'HEAD',
                mode: 'no-cors',
                cache: 'no-cache',
                signal: AbortSignal.any([signal, AbortSignal.timeout(5000)])
            });
        } catch (videoError) {
            if (signal.aborted) return { speed: -1, error: '已取消' };
            // 播放地址测不通：仍按已耗时算速度，角标注明只测了详情接口
            return {
                speed: Math.round(performance.now() - started),
                episodes: data.episodes.length,
                error: null,
                note: 'API响应'
            };
        }

        return {
            speed: Math.round(performance.now() - started),
            episodes: data.episodes.length,
            error: null
        };
    } catch (error) {
        if (signal.aborted) return { speed: -1, error: '已取消' };
        return { speed: -1, error: error.name === 'AbortError' ? '超时' : '测试失败' };
    }
}

// 单个来源的卡片（与播放器页「切换资源」的卡片同款）
function sourcePickerCardHtml(entry) {
    const key = sourcePickerEntryKey(entry);
    const currentClass = entry.isCurrent ? 'current' : '';
    // 侧栏只有 440px 宽 —— 用一行（源名 + 实测延迟）而不是海报网格
    return `
        <div class="kt-pick ${currentClass}" data-source-key="${escapeText(key)}" role="button" tabindex="0"
             title="${escapeText(entry.sourceName)}${entry.isCurrent ? '（当前播放）' : ''}">
            <span class="nm">${escapeText(entry.name)}${entry.approx ? ' <span class="kt-src-badge approx">近似</span>' : ''}</span>
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
    if (entry.badge) {
        entry.badge.innerHTML = entry.pending
            ? '<span class="speed-indicator">测速中</span>'
            : formatSpeedDisplay(entry.speed >= 0
                ? { speed: entry.speed, note: entry.note }
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
    const detail = document.getElementById('sourcePickerDetail');
    if (!detail) return;

    const entry = sourcePickerState.entries.find(item => sourcePickerEntryKey(item) === sourcePickerState.selectedKey);
    if (!entry) {
        detail.innerHTML = '<div class="text-center py-4 text-gray-500 text-sm">选择一个来源</div>';
        return;
    }

    const speedText = entry.pending
        ? '测速中...'
        : (entry.speed >= 0 ? `速度 ${entry.speed}ms` : `速度：${entry.error || '不可用'}`);

    detail.innerHTML = `
        <div class="flex items-start gap-3 p-3 bg-[var(--kt-raised)] rounded-lg border border-[var(--kt-line)]">
            <img src="${escapeText(entry.pic) || LATEST_PLACEHOLDER_IMAGE}" alt=""
                 class="w-14 aspect-[2/3] object-cover rounded shrink-0">
            <div class="flex-1 min-w-0">
                <div class="text-sm font-semibold text-white truncate" title="${escapeText(entry.sourceName)}">${escapeText(entry.sourceName)}</div>
                <div class="mt-1 text-xs text-gray-400">
                    ${escapeText(speedText)}${entry.episodes ? ` · ${entry.episodes} 集` : ''}
                </div>
                <button id="sourcePickerPlayBtn" class="kt-btn pri mt-2">
                    播放此源
                </button>
            </div>
        </div>`;

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
    sourcePickerState.open = true;
    sourcePickerState.selectedKey = '';

    if (title) title.innerHTML = `<span class="break-words">${escapeText(pickerTitle)}</span>`;
    // 选源接管这个面板：把节目单底部的主操作清掉，别留着上一部片的「播放」
    const cta = document.getElementById('modalCta');
    if (cta) cta.innerHTML = '';
    content.innerHTML = `
        <div id="sourcePickerSummary" class="text-xs text-gray-400 mb-3">正在搜索其它来源...</div>
        <div id="sourcePickerGrid" class="kt-pick-list"></div>
        <div id="sourcePickerDetail" class="mt-4"></div>`;
    modal.classList.remove('hidden');

    const controller = new AbortController();
    sourcePickerState.controller = controller;

    collectSourcePickerCandidates(pickerTitle, controller.signal)
        .then(candidates => {
            // 弹窗已关闭：不启动测速，避免关闭后还有请求在飞
            if (!sourcePickerState.open) return;

            sourcePickerState.entries = candidates.map(item => ({
                ...item,
                speed: -1,
                error: '',
                episodes: 0,
                note: '',
                pending: true,
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
                    entry.error = result.error || '';
                    entry.episodes = result.episodes || 0;
                    entry.note = result.note || '';
                    entry.pending = false;
                    refreshSourcePickerEntry(entry);
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
