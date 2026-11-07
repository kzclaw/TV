// ============================================================
// 命令面板（⌘K / Ctrl+K）
// ------------------------------------------------------------
// 一个输入框同时做三件事：搜片、切源、跳历史/设置。
// 这里把「多源」这件事变成一个可以直接调用的对象 —— 换源不用先进详情。
// ============================================================

const CMD_HISTORY_KEY = 'videoSearchHistory';

let cmdItems = [];
let cmdMatched = [];
let cmdIndex = 0;

function cmdEscape(text) {
    return String(text == null ? '' : text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function cmdIcon(name) {
    const paths = {
        film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 10h18"/>',
        zap: '<path d="M13 2L3 14h7l-1 8 10-12h-7z"/>',
        clock: '<circle cx="12" cy="12" r="10"/><path d="M12 7v5.2l3.4 2"/>',
        gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9c.17.6.7 1.03 1.31 1H21a2 2 0 110 4h-.09c-.61 0-1.14.4-1.51 1z"/>',
        down: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>'
    };
    return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (paths[name] || paths.film) + '</svg>';
}

// 当前的搜索结果（用于「继续看这一部」）
function cmdCurrentResults() {
    const wrap = document.getElementById('results');
    if (!wrap) return [];
    return Array.prototype.slice.call(wrap.querySelectorAll('.kt-poster'))
        .map(function (el) {
            const nameEl = el.querySelector('.name');
            return nameEl ? nameEl.textContent : '';
        })
        .filter(Boolean);
}

function cmdHistory() {
    try {
        const raw = JSON.parse(localStorage.getItem(CMD_HISTORY_KEY) || '[]');
        return Array.isArray(raw) ? raw : [];
    } catch (e) {
        return [];
    }
}

// 组装候选
function cmdBuildItems() {
    const items = [];
    const seen = {};

    function pushMovie(text, source) {
        const key = 'm:' + text;
        if (!text || seen[key]) return;
        seen[key] = true;
        items.push({
            group: '影片',
            icon: 'film',
            label: text,
            kb: source || '',
            run: function () {
                const input = document.getElementById('searchInput');
                if (input) {
                    input.value = text;
                    if (typeof toggleClearButton === 'function') toggleClearButton();
                }
                if (typeof search === 'function') search();
            }
        });
    }

    // 当前结果里的片
    cmdCurrentResults().forEach(function (t) { pushMovie(t, '当前结果'); });

    // 最近搜索
    cmdHistory().forEach(function (h) {
        const text = (h && typeof h === 'object') ? h.text : h;
        pushMovie(text, '最近');
    });

    // 片源：切源（直接改勾选状态）
    const sites = window.API_SITES || {};
    let selected = [];
    try {
        selected = JSON.parse(localStorage.getItem('selectedAPIs') || '[]');
    } catch (e) { selected = []; }
    if (!Array.isArray(selected)) selected = [];

    Object.keys(sites).forEach(function (key) {
        const site = sites[key];
        const on = selected.indexOf(key) !== -1;
        items.push({
            group: '片源',
            icon: 'zap',
            label: (on ? '停用 ' : '启用 ') + (site.name || key),
            kb: on ? '已启用' : '未启用',
            run: function () {
                const box = document.getElementById('api_' + key);
                if (box && typeof box.click === 'function') {
                    box.click();               // 走设置面板原有的 change 流程
                } else {
                    // 设置面板还没渲染：直接改存储并刷新
                    const list = selected.indexOf(key) === -1
                        ? selected.concat([key])
                        : selected.filter(function (k) { return k !== key; });
                    try { localStorage.setItem('selectedAPIs', JSON.stringify(list)); } catch (e) {}
                    if (window.SourceBoard && window.SourceBoard.refresh) window.SourceBoard.refresh();
                }
            }
        });
    });

    // 操作
    [
        { label: '打开设置', icon: 'gear', run: function () { if (typeof toggleSettings === 'function') toggleSettings(); } },
        { label: '观看历史', icon: 'clock', run: function () { if (typeof toggleHistory === 'function') toggleHistory(); } },
        { label: '导出配置', icon: 'down', run: function () { if (typeof exportConfig === 'function') exportConfig(); } },
        { label: '导入配置', icon: 'down', run: function () { if (typeof importConfig === 'function') importConfig(); } },
        { label: '关于我们', icon: 'film', run: function () { window.location.href = 'about.html'; } }
    ].forEach(function (a) {
        items.push({ group: '操作', icon: a.icon, label: a.label, kb: '', run: a.run });
    });

    return items;
}

function cmdRender(query) {
    const list = document.getElementById('ktCmdList');
    if (!list) return;

    const q = String(query || '').trim().toLowerCase();
    const matched = !q ? cmdItems : cmdItems.filter(function (it) {
        return it.label.toLowerCase().indexOf(q) !== -1;
    });

    cmdMatched = matched;
    cmdIndex = 0;
    if (!matched.length) {
        list.innerHTML = '<div class="kt-empty" style="padding:28px 16px">没有匹配项</div>';
        return;
    }

    let html = '';
    let group = '';
    matched.forEach(function (it, i) {
        if (it.group !== group) {
            group = it.group;
            html += '<div class="kt-cmd-gh">' + cmdEscape(group) + '</div>';
        }
        html += '<div class="kt-cmd-i' + (i === 0 ? ' on' : '') + '" data-cmd-index="' + i + '" role="option">' +
            '<span class="ic">' + cmdIcon(it.icon) + '</span>' +
            '<span>' + cmdEscape(it.label) + '</span>' +
            '<span class="sp"></span>' +
            (it.kb ? '<span class="kb">' + cmdEscape(it.kb) + '</span>' : '') +
            '</div>';
    });
    list.innerHTML = html;

    list.querySelectorAll('[data-cmd-index]').forEach(function (el) {
        el.addEventListener('click', function () {
            const idx = Number(el.getAttribute('data-cmd-index'));
            cmdRun(idx);
        });
    });
}

function cmdRun(index) {
    const target = cmdMatched[index];
    if (!target) return;
    closeCmd();
    if (typeof target.run === 'function') target.run();
}

function cmdMove(delta) {
    const list = document.getElementById('ktCmdList');
    if (!list) return;
    const els = list.querySelectorAll('[data-cmd-index]');
    if (!els.length) return;
    els[cmdIndex].classList.remove('on');
    cmdIndex = (cmdIndex + delta + els.length) % els.length;
    els[cmdIndex].classList.add('on');
    els[cmdIndex].scrollIntoView({ block: 'nearest' });
}

// 顶栏的搜索框：点它应当能直接打字 —— 聚焦主搜索框（命令面板留给 ⌘K）
function focusMainSearch() {
    const input = document.getElementById('searchInput');
    if (!input) return;
    input.focus();
    try { input.select(); } catch (e) { /* 部分浏览器在隐藏时不支持 */ }
    input.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function openCmd() {
    const panel = document.getElementById('ktCmd');
    if (!panel) return;
    cmdItems = cmdBuildItems();
    cmdRender('');
    panel.hidden = false;
    const input = document.getElementById('ktCmdInput');
    if (input) {
        input.value = '';
        setTimeout(function () { input.focus(); }, 0);
    }
}

function closeCmd() {
    const panel = document.getElementById('ktCmd');
    if (panel) panel.hidden = true;
}

function cmdToggle() {
    const panel = document.getElementById('ktCmd');
    if (!panel) return;
    if (panel.hidden) openCmd(); else closeCmd();
}

document.addEventListener('DOMContentLoaded', function () {
    const openBtn = document.getElementById('openCmd');
    if (openBtn) openBtn.addEventListener('click', focusMainSearch);

    const closeBtn = document.querySelector('#ktCmd .kt-icon-btn');
    if (closeBtn) closeBtn.addEventListener('click', closeCmd);

    const input = document.getElementById('ktCmdInput');
    if (input) {
        input.addEventListener('input', function () { cmdRender(input.value); });
        input.addEventListener('keydown', function (e) {
            if (e.key === 'ArrowDown') { e.preventDefault(); cmdMove(1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); cmdMove(-1); }
            else if (e.key === 'Enter') { e.preventDefault(); cmdRun(cmdIndex); }
        });
    }

    const panel = document.getElementById('ktCmd');
    if (panel) {
        panel.addEventListener('click', function (e) {
            if (e.target === panel) closeCmd();
        });
    }

    // 全局快捷键
    document.addEventListener('keydown', function (e) {
        if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
            e.preventDefault();
            cmdToggle();
            return;
        }
        if (e.key === 'Escape') {
            const p = document.getElementById('ktCmd');
            if (p && !p.hidden) { closeCmd(); }
        }
    });
});

window.KzCmd = { open: openCmd, close: closeCmd, focusSearch: focusMainSearch };
