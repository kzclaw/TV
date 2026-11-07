// 页面加载后：身份位 + 使用声明 + URL 搜索参数处理
document.addEventListener('DOMContentLoaded', function() {
    // Cloudflare Access 身份：由服务端验签 JWT 后注入 window.__ENV__.ACCESS_NAME
    // 没有通过 Access（或验签不过）就是空字符串 —— 此时不显示任何身份信息
    const accessName = (window.__ENV__ && window.__ENV__.ACCESS_NAME) || '';

    renderIdentity(accessName);
    maybeShowDisclaimer(accessName);

    // 播放URL（/watch 开头）不做额外处理，watch.html 会处理重定向
    if (window.location.pathname.startsWith('/watch')) {
        return;
    }

    // 路径参数 /s=keyword
    const path = window.location.pathname;
    const searchPrefix = '/s=';

    if (path.startsWith(searchPrefix)) {
        const keyword = decodeURIComponent(path.substring(searchPrefix.length));
        if (keyword) {
            document.getElementById('searchInput').value = keyword;
            toggleClearButton();
            setTimeout(() => {
                search();
                try {
                    window.history.replaceState(
                        { search: keyword },
                        `搜索: ${keyword} - KzTv`,
                        window.location.href
                    );
                } catch (e) {
                    console.error('更新浏览器历史失败:', e);
                }
            }, 300);
        }
    }

    // 查询参数 ?s=keyword
    const urlParams = new URLSearchParams(window.location.search);
    const searchQuery = urlParams.get('s');

    if (searchQuery) {
        document.getElementById('searchInput').value = searchQuery;
        setTimeout(() => {
            search();
            try {
                window.history.replaceState(
                    { search: searchQuery },
                    `搜索: ${searchQuery} - KzTv`,
                    `/s=${encodeURIComponent(searchQuery)}`
                );
            } catch (e) {
                console.error('更新浏览器历史失败:', e);
            }
        }, 300);
    }
});

// 顶栏身份位：没身份就整块不显示（不显示任何欢迎词）
function renderIdentity(name) {
    const box = document.getElementById('ktIdentity');
    const label = document.getElementById('ktIdentityName');
    if (!box || !label || !name) return;
    label.textContent = name;      // 名字来自 JWT，走 textContent 防注入
    box.hidden = false;
    box.title = `已登录：${name}`;
}

// 使用声明：按版本号记忆 —— 声明内容改了，老用户会重新看到一次
const KT_DISCLAIMER_VERSION = 'v2-2026-11';
const KT_DISCLAIMER_KEY = 'ktDisclaimerSeen';

function maybeShowDisclaimer(name) {
    let seen = null;
    try {
        seen = localStorage.getItem(KT_DISCLAIMER_KEY);
    } catch (e) {
        seen = null;             // 隐私模式下 localStorage 可能不可用
    }
    if (seen === KT_DISCLAIMER_VERSION) return;

    const modal = document.getElementById('ktDisclaimer');
    if (!modal) return;

    // 有身份时把欢迎词提到标题里（衬线 + 品牌金）
    const title = document.getElementById('ktDiscTitle');
    if (title && name) {
        title.textContent = '欢迎回来，';
        const em = document.createElement('em');
        em.textContent = name;
        title.appendChild(em);
    }

    modal.hidden = false;

    const accept = document.getElementById('ktDiscAccept');
    if (accept) {
        accept.addEventListener('click', function () {
            try {
                localStorage.setItem(KT_DISCLAIMER_KEY, KT_DISCLAIMER_VERSION);
            } catch (e) { /* 存不了就下次再弹，无所谓 */ }
            modal.hidden = true;
        }, { once: true });
    }

    // 点遮罩也能关闭（但不算「已接受」，下次仍会弹）
    modal.addEventListener('click', function (e) {
        if (e.target === modal) modal.hidden = true;
    });
}
