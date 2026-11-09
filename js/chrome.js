// ============================================================
// 全站 chrome：顶栏 + 页脚 + 两个抽屉面板
// ------------------------------------------------------------
// 这三个块**只在这里写一份**，各页面只留占位符：
//     <div data-chrome="header"></div>
//     <div data-chrome="panels"></div>
//     <div data-chrome="footer"></div>
//     <script src="js/chrome.js"></script>     ← 放 body 末尾（同步执行）
//
// 脚本在 body 末尾同步执行 → 首次绘制前就替换完，不会看到「先空后有」的跳动。
//
// 按页面能力自动裁剪：
//   · 没有 #historyPanel  → 不显示「历史」按钮
//   · 没有 #settingsPanel → 不显示「设置」按钮
//   · 没有 #searchInput   → 搜索框点击改为回首页
// ============================================================

(function () {
  var HEADER_HTML = `<header class="kt-topbar">
        <a href="/" class="kt-logo" aria-label="KzTv 首页">
            <svg class="kt-mark" viewBox="0 0 512 512" fill="none" aria-hidden="true">
                <g stroke="currentColor" stroke-width="30" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M256 100 L194 44 M256 100 L318 44"/>
                    <rect x="52" y="100" width="408" height="306" rx="48"/>
                </g>
                <path d="M196 168 L196 338 L334 253 Z" fill="currentColor"/>
            </svg>
            KzTv
        </a>
        <span class="sp"></span>

        <!-- Cloudflare Access 身份位（无身份时整块隐藏） -->
        <div class="kt-id" id="ktIdentity" hidden title="已登录">
            <i aria-hidden="true"></i><span id="ktIdentityName"></span>
        </div>

        <button class="kt-search-mini" id="openCmd" type="button" aria-label="搜索影片（⌘K 打开命令面板）" title="搜索影片（⌘K 打开命令面板）">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>
            </svg>
            <span class="tx">搜索影片…</span>
            <kbd>⌘K</kbd>
        </button>

        <button class="kt-icon-btn" data-chrome-btn="history" onclick="toggleHistory(event)" type="button" aria-label="观看历史" title="观看历史">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <circle cx="12" cy="12" r="10"/><path d="M12 7v5.2l3.4 2"/>
            </svg>
        </button>
        <button class="kt-icon-btn" data-chrome-btn="settings" onclick="toggleSettings(event)" type="button" aria-label="打开设置" title="设置">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9c.17.6.7 1.03 1.31 1H21a2 2 0 110 4h-.09c-.61 0-1.14.4-1.51 1z"/>
            </svg>
        </button>
    </header>`;

  var PANELS_HTML = `<div id="historyPanel" class="history-panel fixed left-0 top-0 h-full bg-[var(--kt-bg2)] border-r border-[var(--kt-line)] p-6 z-40 -translate-x-full transition-transform duration-300" aria-label="观看历史" aria-hidden="true">
        <div class="flex justify-between items-center mb-6">
            <button onclick="toggleHistory()" class="close-btn" style="position:static" type="button" aria-label="关闭">
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                </svg>
            </button>
            <h3 class="text-xl font-bold gradient-text mx-auto">观看历史</h3>
            <div class="w-4"></div>
        </div>
        <div id="historyList" class="pb-4">
            <div class="text-center text-gray-500 py-8">暂无观看记录</div>
        </div>
        <div class="mt-4 text-center sticky bottom-0 pb-2 pt-2 bg-[var(--kt-bg2)]">
            <button onclick="clearViewingHistory()" class="kt-btn pri w-full" type="button">清空历史记录</button>
        </div>
    </div>

<div id="settingsPanel" class="settings-panel fixed right-0 top-0 h-full w-[380px] max-w-[92vw] bg-[var(--kt-bg2)] border-l border-[var(--kt-line)] p-6 z-40 overflow-y-auto" aria-label="设置面板" aria-hidden="true">
        <div class="flex justify-between items-center mb-6">
            <h3 class="text-xl font-bold gradient-text">设置</h3>
            <button onclick="toggleSettings()" class="close-btn" style="position:static" type="button" aria-label="关闭">
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                </svg>
            </button>
        </div>
        <div class="space-y-5">
            <!-- 数据源设置 -->
            <div class="kt-src-group p-3 bg-[var(--kt-raised)] rounded-lg">
                <label class="block text-sm font-medium text-gray-400 mb-3 border-b border-[var(--kt-line)] pb-1 w-full">数据源设置</label>

                <div class="flex space-x-2 mb-3">
                    <button onclick="selectAllAPIs(true)" class="kt-btn" type="button">全选</button>
                    <button onclick="selectAllAPIs(false)" class="kt-btn" type="button">全不选</button>
                    <button onclick="selectAllAPIs(true, true)" class="kt-btn" type="button">全选普通资源</button>
                </div>

                <div class="max-h-40 overflow-y-auto bg-[var(--kt-bg)] p-2 rounded-lg mb-3">
                    <div id="apiCheckboxes"></div>
                </div>

                <div class="text-xs text-gray-500 flex justify-between items-center">
                    <span>已选API数量：<span id="selectedApiCount" class="text-white">0</span></span>
                    <span id="siteStatus" class="ml-2"></span>
                </div>
            </div>

            <!-- 自定义API -->
            <div class="p-3 bg-[var(--kt-raised)] rounded-lg">
                <div class="flex justify-between items-center mb-2">
                    <label class="block text-sm font-medium text-gray-400 border-b border-[var(--kt-line)] w-full pb-1">自定义API</label>
                    <button onclick="showAddCustomApiForm()" class="kt-icon-btn" style="width:26px;height:26px" type="button" aria-label="添加自定义API">+</button>
                </div>
                <div id="customApisList" class="max-h-32 overflow-y-auto mb-2"></div>

                <div id="addCustomApiForm" class="hidden mt-2 p-2 bg-[var(--kt-bg)] rounded-lg">
                    <input type="text" id="customApiName" placeholder="API名称" class="w-full bg-[var(--kt-raised)] border border-[var(--kt-line)] text-white px-2 py-1 rounded mb-2" autocomplete="off">
                    <input type="text" id="customApiUrl" placeholder="https://abc.com" class="w-full bg-[var(--kt-raised)] border border-[var(--kt-line)] text-white px-2 py-1 rounded mb-2" autocomplete="off">
                    <input type="text" id="customApiDetail" placeholder="detail地址（可选）" class="w-full bg-[var(--kt-raised)] border border-[var(--kt-line)] text-white px-2 py-1 rounded mb-2" autocomplete="off">
                    <div class="flex items-center mb-2">
                        <input type="checkbox" id="customApiIsAdult" class="form-checkbox h-4 w-4 text-pink-500 bg-[var(--kt-raised)] border border-[var(--kt-line)]">
                        <label for="customApiIsAdult" class="ml-2 text-xs text-pink-400">黄色资源站</label>
                    </div>
                    <div class="flex space-x-2">
                        <button onclick="addCustomApi()" class="kt-btn pri" type="button">添加</button>
                        <button onclick="cancelAddCustomApi()" class="kt-btn" type="button">取消</button>
                    </div>
                </div>
            </div>

            <!-- 功能开关 -->
            <div class="p-3 bg-[var(--kt-raised)] rounded-lg">
                <label class="block text-sm font-medium text-gray-400 mb-3 border-b border-[var(--kt-line)] pb-1 w-full">功能开关</label>

                <div class="flex flex-col mb-3 pb-3 border-b border-[var(--kt-line)] relative">
                    <div class="flex items-center justify-between">
                        <div>
                            <label class="text-sm font-medium text-gray-400">黄色内容过滤</label>
                            <p class="text-xs text-gray-500 mt-1 filter-description">过滤"伦理片"等黄色内容</p>
                        </div>
                        <div class="relative inline-block w-12 align-middle select-none">
                            <input type="checkbox" id="yellowFilterToggle" class="opacity-0 absolute w-full h-full cursor-pointer z-10">
                            <div class="toggle-bg bg-[#333] w-12 h-6 rounded-full transition-colors duration-300 ease-in-out"></div>
                            <div class="toggle-dot absolute w-5 h-5 bg-white rounded-full top-0.5 left-0.5 transition-transform duration-300 ease-in-out"></div>
                        </div>
                    </div>
                </div>

                <div class="flex items-center justify-between mb-3 pb-3 border-b border-[var(--kt-line)]">
                    <div>
                        <label class="text-sm font-medium text-gray-400">分片广告过滤</label>
                        <p class="text-xs text-gray-500 mt-1">关闭可减少旧版浏览器卡顿</p>
                    </div>
                    <div class="relative inline-block w-12 align-middle select-none">
                        <input type="checkbox" id="adFilterToggle" class="opacity-0 absolute w-full h-full cursor-pointer z-10">
                        <div class="toggle-bg bg-[#333] w-12 h-6 rounded-full transition-colors duration-300 ease-in-out"></div>
                        <div class="toggle-dot absolute w-5 h-5 bg-white rounded-full top-0.5 left-0.5 transition-transform duration-300 ease-in-out"></div>
                    </div>
                </div>

                <div class="flex items-center justify-between">
                    <div>
                        <label class="text-sm font-medium text-gray-400">首页显示最近更新</label>
                        <p class="text-xs text-gray-500 mt-1">在首页显示最近更新的影视内容</p>
                    </div>
                    <div class="relative inline-block w-12 align-middle select-none">
                        <input type="checkbox" id="latestToggle" class="opacity-0 absolute w-full h-full cursor-pointer z-10">
                        <div class="toggle-bg bg-[#333] w-12 h-6 rounded-full transition-colors duration-300 ease-in-out"></div>
                        <div class="toggle-dot absolute w-5 h-5 bg-white rounded-full top-0.5 left-0.5 transition-transform duration-300 ease-in-out"></div>
                    </div>
                </div>
            </div>

            <!-- 一般功能 -->
            <div class="p-3 bg-[var(--kt-raised)] rounded-lg">
                <label class="block text-sm font-medium text-gray-400 mb-3 border-b border-[var(--kt-line)] pb-1 w-full">一般功能</label>
                <button onclick="importConfig()" class="kt-btn w-full mb-2" type="button">导入配置</button>
                <button onclick="exportConfig()" class="kt-btn w-full mb-2" type="button">导出配置</button>
                <button onclick="clearLocalStorage()" class="kt-btn danger w-full" type="button">清除Cookie</button>
            </div>
        </div>
    </div>

    <!-- ===================== 信息弹窗（关于我们 / 隐私政策 / 使用声明） =====================
         全站只此一份，由 chrome.js 注入 → 三个页面行为一致，内容也只有一份。
         使用声明的「首次访问自动弹出」复用同一个弹窗（mode=accept），页脚入口是 view 模式。 -->
    <div class="kt-modal" id="ktInfoModal" hidden>
        <div class="kt-modal-card" role="dialog" aria-modal="true" aria-labelledby="ktInfoTitle">
            <div class="kt-modal-head">
                <svg class="mark" viewBox="0 0 512 512" fill="none" aria-hidden="true">
                    <g stroke="currentColor" stroke-width="30" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M256 100 L194 44 M256 100 L318 44"/>
                        <rect x="52" y="100" width="408" height="306" rx="48"/>
                    </g>
                    <path d="M196 168 L196 338 L334 253 Z" fill="currentColor"/>
                </svg>
                <div>
                    <div class="kick" id="ktInfoKick"></div>
                    <h3 id="ktInfoTitle"></h3>
                </div>
            </div>
            <div class="kt-modal-body" id="ktInfoBody"></div>
            <div class="kt-modal-foot">
                <span class="note" id="ktInfoNote"></span>
                <a id="ktInfoLink" href="about.html">查看完整说明 →</a>
                <button class="kt-btn pri big" id="ktInfoBtn" type="button">知道了</button>
            </div>
        </div>
    </div>`;

  // 关于页上这三个链接指本页锚点（内容就在同一页）；其它页面指 about.html，由 JS 接管成弹窗
  var onAboutPage = /about\.html$/.test(location.pathname) || location.pathname === '/about';
  function footLink(id, anchor, label) {
    return '<a href="' + (onAboutPage ? '#' + anchor : 'about.html') + '"'
         + (onAboutPage ? '' : ' data-about="' + id + '"') + '>' + label + '</a>';
  }

  var FOOTER_HTML = `<footer class="footer">
        <div class="kt-shell kt-foot">
            <div>
                <p class="text-gray-500 text-sm">© 2026 KzTv · 自由观影，畅享精彩</p>
                <p class="text-sm mt-1 text-center md:text-left" style="color: var(--kt-text-3)"><a href="https://www.cloudflare.com" target="_blank" rel="noopener">Powered by Cloudflare</a></p>
            </div>
            <div>
                ${footLink('about', 'about', '关于我们')}
                ${footLink('privacy', 'privacy', '隐私政策')}
                ${footLink('terms', 'terms', '使用声明')}
            </div>
        </div>
    </footer>`;

  // ============================================================
  // 信息弹窗内容：全站唯一真本
  //   terms   使用声明（沿用原声明弹窗文案）
  //   privacy 隐私政策（取自 about.html）
  //   about   关于 KzTv（取自 about.html）
  // 弹窗里 <b> 是块级小标题（.kt-modal-body b{display:block}），
  // 句中强调一律用 <strong>，否则会被撑成独立一行。
  // ============================================================
  var KT_INFO_CONTENT = {
    terms: {
      kick: 'KzTv · 使用声明',
      title: '使用声明',
      body: '<p><b>服务性质</b>KzTv 只做搜索与跳转：不存储、不上传、不转存任何视频文件。片单与播放地址均来自第三方公开接口，由浏览器直接向源站请求。</p>'
          + '<p><b>用户责任</b>使用本站服务须遵守相关法律法规，不得利用搜索结果从事侵权行为，如下载、传播未经授权的作品。</p>'
          + '<p><b>广告风险</b>视频中的广告与本站无关，来自第三方采集站。请勿相信或点击视频内的任何广告内容。</p>',
      noteAccept: '继续浏览即表示已阅读并接受上述条款',
      noteView: '首次访问时会自动弹出这份声明',
      link: '查看完整说明 →',
      href: 'about.html'
    },
    privacy: {
      kick: 'KzTv · 隐私政策',
      title: '隐私政策',
      body: '<p><b>数据保护</b>本站不收集你的个人身份信息，不接入第三方统计与广告追踪。你输入的搜索词只会发送到对应的采集接口，用于返回结果，不会被本站留存。</p>'
          + '<p><b>本地存储</b>仅在你自己的浏览器里保存少量必要状态，例如搜索偏好、播放进度，以及（若站点设置了访问密码）该密码的<strong>哈希值</strong>——用于向站内代理发起请求时出示凭证。<strong>密码本体不会写入浏览器存储</strong>，也只会以哈希形式出现在页面脚本里。清空浏览器数据即可全部清除。</p>',
      noteAccept: '',
      noteView: '完整版含版权声明与技术授权',
      link: '查看完整说明 →',
      href: 'about.html'
    },
    about: {
      kick: 'KzTv · 关于',
      title: '关于 KzTv',
      body: '<p><b>这是什么</b>KzTv 是一个免费的多源视频搜索与观看平台。它把多个公开的视频采集接口聚合到一处，你在站内搜索，即可浏览各个来源提供的片单并跳转播放。</p>'
          + '<p><b>只做搜索与跳转</b>不存储、不上传、不转存任何视频文件，视频内容全部来自第三方公开接口，由浏览器直接向源站请求。</p>',
      noteAccept: '',
      noteView: '完整版含版权声明与技术授权',
      link: '查看完整说明 →',
      href: 'about.html'
    }
  };

  function closeInfoModal() {
    var modal = document.getElementById('ktInfoModal');
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    var t = modal._trigger;
    if (t && t.focus) { try { t.focus(); } catch (e) {} }
  }

  // kind: terms | privacy | about
  // opts: { mode: 'view' | 'accept', name: 身份名, onAccept: 回调 }
  window.showInfoModal = function (kind, opts) {
    var c = KT_INFO_CONTENT[kind];
    var modal = document.getElementById('ktInfoModal');
    if (!c || !modal) return;
    opts = opts || {};
    var isAccept = opts.mode === 'accept';

    var kick = document.getElementById('ktInfoKick');
    if (kick) kick.textContent = c.kick;

    var title = document.getElementById('ktInfoTitle');
    if (title) {
      title.textContent = '';
      if (isAccept && opts.name) {
        title.appendChild(document.createTextNode('欢迎回来，'));
        var em = document.createElement('em');
        em.textContent = opts.name;          // 名字来自 JWT，走 textContent 防注入
        title.appendChild(em);
      } else {
        title.textContent = c.title;
      }
    }

    var body = document.getElementById('ktInfoBody');
    if (body) body.innerHTML = c.body;

    var note = document.getElementById('ktInfoNote');
    if (note) note.textContent = isAccept ? c.noteAccept : c.noteView;
    var link = document.getElementById('ktInfoLink');
    if (link) { link.textContent = c.link; link.href = c.href; link.hidden = isAccept || !c.link; }
    var btn = document.getElementById('ktInfoBtn');
    if (btn) btn.textContent = isAccept ? '我已了解并接受' : '知道了';

    modal._onAccept = isAccept ? (opts.onAccept || null) : null;
    modal._trigger = document.activeElement;
    modal.hidden = false;
    if (btn) { try { btn.focus(); } catch (e) {} }
  };

  function bindInfoModal() {
    var modal = document.getElementById('ktInfoModal');
    if (!modal) return;

    modal.addEventListener('click', function (e) {
      if (e.target === modal) { closeInfoModal(); return; }   // 点遮罩关闭
      if (e.target.closest && e.target.closest('#ktInfoBtn')) {
        var cb = modal._onAccept;
        if (cb) { try { cb(); } catch (err) {} }
        closeInfoModal();
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !modal.hidden) closeInfoModal();
    });

    // 页脚三个入口：事件委托（内容是注入的，绑定在 document 上）
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[data-about]');
      if (!a) return;
      e.preventDefault();                 // 无 JS 时 href="about.html" 照常跳页
      window.showInfoModal(a.getAttribute('data-about'));
    });

    // 关于页的声明段落：内容真本在上面那张表里，这里只负责把它放进页面
    var aboutTerms = document.getElementById('ktAboutTerms');
    if (aboutTerms) aboutTerms.innerHTML = KT_INFO_CONTENT.terms.body;
  }

  function fill(attr, html) {
    var nodes = document.querySelectorAll('[data-chrome="' + attr + '"]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].outerHTML = html;
    }
  }

  function applyCapabilities() {
    // 历史 / 设置：页面没有对应面板就把按钮摘掉，免得点了没反应
    if (!document.getElementById('historyPanel')) {
      var hb = document.querySelector('[data-chrome-btn="history"]');
      if (hb) hb.remove();
    }
    if (!document.getElementById('settingsPanel')) {
      var sb = document.querySelector('[data-chrome-btn="settings"]');
      if (sb) sb.remove();
    }
    // 搜索：没有主搜索框的页面（播放页等）→ 搜索框改为回首页
    if (!document.getElementById('searchInput')) {
      var box = document.getElementById('openCmd');
      if (box) {
        box.setAttribute('title', '搜索影片');
        box.setAttribute('aria-label', '搜索影片');
        box.addEventListener('click', function (e) {
          e.preventDefault();
          window.location.href = '/';
        });
      }
    }
  }

  function renderIdentity() {
    // 身份由服务端注入（functions/_middleware.js 验签 Access JWT 后写进 window.__ENV__）
    var name = (window.__ENV__ && window.__ENV__.ACCESS_NAME) || '';
    var box = document.getElementById('ktIdentity');
    var label = document.getElementById('ktIdentityName');
    if (!box || !label || !name) return;
    label.textContent = name;          // 名字来自 JWT，走 textContent 防注入
    box.hidden = false;
    box.title = '已登录：' + name;
  }

  fill('header', HEADER_HTML);
  fill('panels', PANELS_HTML);
  fill('footer', FOOTER_HTML);
  renderIdentity();
  applyCapabilities();
  bindInfoModal();

  // 设置面板里的「数据源设置」要靠 app.js 的 initAPICheckboxes 填充源列表；
  // 没加载 app.js 的页面（播放页/关于页）把这一组藏掉，别给一个空框。
  if (typeof window.initAPICheckboxes !== 'function') {
    document.body.classList.add('kt-no-src-list');
  }
})();
