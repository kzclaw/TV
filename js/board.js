// ============================================================
// 片源状态板
// ------------------------------------------------------------
// 仓库里已有的能力，这里只是摆出来：
//   · API_SITES        —— 24 个采集源的清单与名字（js/config.js）
//   · SourceHealth     —— 熔断状态：哪些源被连续失败暂时跳过（js/api.js）
//   · fetchSourceData  —— 走站内代理取一次源数据并计时（js/api.js）
//
// 不新增任何后端接口：测速就是浏览器侧对 /proxy/ 的一次真实请求计时，
// 也就是用户真正会感受到的那个延迟。
// ============================================================

const BOARD_PROBE_KEY = 'ktSourceProbe';     // sessionStorage
const BOARD_PROBE_TTL = 5 * 60 * 1000;       // 5 分钟内不重复探测
const BOARD_PROBE_TIMEOUT = 8000;            // 单个源 8 秒超时
const BOARD_PROBE_CONCURRENCY = 2;           // 同时最多探 2 个源

let boardProbeTimer = null;

// 读当前勾选的源（与 js/app.js 的默认集一致）
function boardSelectedKeys() {
    let keys;
    try {
        keys = JSON.parse(localStorage.getItem('selectedAPIs') || 'null');
    } catch (e) {
        keys = null;
    }
    if (!Array.isArray(keys) || !keys.length) {
        keys = ['dyttzy', 'bfzy', 'ruyi', 'ffzy'];
    }
    return keys;
}

function boardProbeCache() {
    try {
        const raw = JSON.parse(sessionStorage.getItem(BOARD_PROBE_KEY) || '{}');
        return (raw && typeof raw === 'object') ? raw : {};
    } catch (e) {
        return {};
    }
}

function boardSaveProbeCache(cache) {
    try {
        sessionStorage.setItem(BOARD_PROBE_KEY, JSON.stringify(cache));
    } catch (e) { /* 隐私模式下写不了，忽略 */ }
}

// 渲染状态板
function renderSourceBoard() {
    const list = document.getElementById('ktSrcList');
    const foot = document.getElementById('ktBoardFoot');
    if (!list) return;

    const sites = window.API_SITES || {};
    const selected = boardSelectedKeys();
    const cache = boardProbeCache();
    const skipped = window.SourceHealth && window.SourceHealth.getSkippedSources
        ? window.SourceHealth.getSkippedSources() : [];

    list.innerHTML = '';

    // 只列「已启用」的源 —— 24 个源全列会把首屏撑爆（真正会用的通常只有 4~8 个）
    Object.keys(sites).filter(function (key) {
        return selected.indexOf(key) !== -1;
    }).forEach(function (key) {
        const site = sites[key];
        const name = site.name || key;
        const isOn = true;
        const isListOnly = !!site.listOnly;
        const isSkipped = skipped.indexOf(key) !== -1;
        const probe = cache[key];

        const row = document.createElement('div');
        row.className = 'kt-src' + (!isOn || isListOnly || isSkipped ? ' off' : '');

        let dotColor = '#6F6A62';   // 弱文本：未启用 / 仅列表
        let barWidth = 0;
        let msText = '未启用';

        if (isListOnly) {
            msText = '仅列表';
        } else if (isSkipped) {
            dotColor = '#C2603E';   // 不可用
            msText = '已跳过';
        } else if (!isOn) {
            msText = '未启用';
        } else if (probe && probe.ok) {
            dotColor = '#6FA88A';   // 健康
            const ratio = Math.max(0, Math.min(1, (1200 - probe.ms) / 1140));
            barWidth = Math.round(8 + ratio * 92);
            msText = probe.ms + ' ms';
        } else if (probe && !probe.ok) {
            dotColor = '#C2603E';
            msText = '超时';
        } else {
            dotColor = '#FBBF24';   // 探测中
            msText = '探测中';
        }

        row.innerHTML =
            '<span class="nm"><i class="kt-dot" style="background:' + dotColor + '"></i><em>' +
            escapeText(name) + '</em></span>' +
            '<span class="bar"><i style="width:' + barWidth + '%"></i></span>' +
            '<span class="ms">' + escapeText(msText) + '</span>';

        list.appendChild(row);
    });

    if (foot) {
        const total = Object.keys(sites).length;
        const on = selected.length;
        const listOnly = Object.keys(sites).filter(function (k) { return sites[k].listOnly; }).length;
        foot.textContent = '已启用 ' + on + ' / ' + total + ' 个源' + (listOnly ? ' · ' + listOnly + ' 个仅列表' : '');
    }
}

// 探一个源：一次真实请求，记耗时
async function probeOneSource(key) {
    const site = (window.API_SITES || {})[key];
    if (!site || !site.api) return { ok: false, ms: -1 };
    const started = performance.now();
    try {
        await fetchSourceData(site.api + '?ac=videolist&pg=1', BOARD_PROBE_TIMEOUT);
        return { ok: true, ms: Math.max(1, Math.round(performance.now() - started)), at: Date.now() };
    } catch (e) {
        return { ok: false, ms: -1, at: Date.now() };
    }
}

// 并发探测已启用的源（限流 2 个），结果逐个点亮
async function probeSources(force) {
    const cache = boardProbeCache();
    const now = Date.now();

    // 没强制刷新时，缓存里新鲜的直接用
    const fresh = {};
    let needProbe = [];

    boardSelectedKeys().forEach(function (key) {
        const site = (window.API_SITES || {})[key];
        if (!site || site.listOnly) return;
        const hit = cache[key];
        if (!force && hit && hit.at && (now - hit.at) < BOARD_PROBE_TTL) {
            fresh[key] = hit;
        } else {
            needProbe.push(key);
        }
    });

    const merged = Object.assign({}, cache, fresh);
    boardSaveProbeCache(merged);
    renderSourceBoard();

    if (!needProbe.length) return;

    let index = 0;
    const worker = async function () {
        while (index < needProbe.length) {
            const key = needProbe[index++];
            const result = await probeOneSource(key);
            const c = boardProbeCache();
            c[key] = result;
            boardSaveProbeCache(c);
            renderSourceBoard();     // 逐个点亮，不等全部跑完
        }
    };

    const workers = [];
    for (let i = 0; i < Math.min(BOARD_PROBE_CONCURRENCY, needProbe.length); i++) {
        workers.push(worker());
    }
    await Promise.all(workers);
    renderSourceBoard();
}

// 初始化
function initSourceBoard() {
    renderSourceBoard();

    // 「重新测速」按钮
    const probeBtn = document.getElementById('ktBoardProbe');
    if (probeBtn) {
        probeBtn.addEventListener('click', function () { probeSources(true); });
    }

    // 首次进页面探一次；之后 60 秒内不重复
    if (!boardProbeTimer) {
        boardProbeTimer = setTimeout(function () {
            probeSources(false);
        }, 800);
    }
}

window.SourceBoard = {
    refresh: renderSourceBoard,
    probe: probeSources
};

document.addEventListener('DOMContentLoaded', initSourceBoard);
