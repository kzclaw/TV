// 密码兜底登录：只在「拿不到可验签的 Cloudflare Access 身份」时启用。
//
// 三条别改回去的约定：
//   1) 密码和密码哈希都不进浏览器。服务端只回一张 HttpOnly 会话 cookie
//      —— 浏览器读不到 cookie，也就没有任何可离线爆破的凭据。
//   2) 显隐只用 hidden 属性，不要再混用 style.display。
//      之前混用时，作者样式表里的 [hidden]{display:none!important} 打赢内联样式，
//      弹窗永远是 0×0，用户看到的是「点了没反应」。
//   3) 判定权全在服务端：不做本地预判，只有服务端回 401 才弹框。

function showPasswordModal() {
    const modal = document.getElementById('passwordModal');
    if (!modal) return;

    // 防止出现最近更新区块滚动条
    const latestArea = document.getElementById('latestArea');
    if (latestArea) latestArea.classList.add('hidden');

    // 取消按钮只存在于首页，播放页没有 —— 取不到就跳过，别让整页 JS 断在这里。
    // 既然这次弹框是服务端判的「你没有凭据」，就没有「跳过」这个选项，直接藏掉。
    const cancelBtn = document.getElementById('passwordCancelBtn');
    if (cancelBtn) cancelBtn.classList.add('hidden');

    hidePasswordError();
    modal.hidden = false;

    const input = document.getElementById('passwordInput');
    if (input) {
        input.value = '';
        setTimeout(() => input.focus(), 50);
    }
}

function hidePasswordModal() {
    const modal = document.getElementById('passwordModal');
    if (!modal) return;
    hidePasswordError();
    const input = document.getElementById('passwordInput');
    if (input) input.value = '';
    modal.hidden = true;
}

function showPasswordError() {
    const el = document.getElementById('passwordError');
    if (el) el.classList.remove('hidden');
}

function hidePasswordError() {
    const el = document.getElementById('passwordError');
    if (el) el.classList.add('hidden');
}

async function handlePasswordSubmit() {
    const input = document.getElementById('passwordInput');
    const password = input ? input.value.trim() : '';
    if (!password) return;

    const btn = document.getElementById('passwordSubmitBtn');
    if (btn) btn.disabled = true;

    try {
        const res = await fetch('/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password }),
        });
        if (res.ok) {
            // 会话 cookie 已经种下。重新加载一次：让所有后续请求（代理、m3u8、分片）
            // 都自动带上它 —— 比在每个请求点写重试逻辑可靠得多。
            location.reload();
            return;
        }
        showPasswordError();
        if (input) {
            input.value = '';
            input.focus();
        }
    } catch (e) {
        showPasswordError();
    } finally {
        if (btn) btn.disabled = false;
    }
}

// 首屏：服务端已经判好「你是谁」
//   'access'  → Access 身份正常，密码完全不参与
//   'session' → Access 没罩住，但密码会话还有效
//   'password'→ 两者都没有 → 要密码
document.addEventListener('DOMContentLoaded', function () {
    const mode = (window.__ENV__ && window.__ENV__.AUTH_MODE) || 'access';
    if (mode === 'password') showPasswordModal();
});
