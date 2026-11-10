// 全局常量配置
const PROXY_URL = '/proxy/';    // 适用于 Cloudflare, Netlify (带重写), Vercel (带重写)
// const HOPLAYER_URL = 'https://hoplayer.com/index.html';
const SEARCH_HISTORY_KEY = 'videoSearchHistory';
const MAX_HISTORY_ITEMS = 5;

// 默认启用的源（首次访问、还没在本地存过勾选时用）：**全部源**。
// ⚠ 这是「默认源」的唯一真源：js/app.js 的初始化、js/board.js 的状态板、
// js/source-picker.js 的选源候选都从这里取 —— 三处各写一份会漂移
// （source-picker.js 曾手抄过一份 ['dyttzy','bfzy','ruyi','ffzy']，改这里它不会跟着变）。
//
// 全部源默认开启的代价（2026-11-11 实测）：搜索的代理请求 8 → 25（3.1×），
// 耗时 2.1s → 3.3s，结果从「13 部影片·来自 4 个来源」变成「15 部·来自 17 个来源」。
// 多数源第一页就有结果，浏览器 6 个连接槽的排队能消化掉增量 → 换来的覆盖面更划算。
//
// ⚠ 必须放在 API_SITES 之后定义（要由它派生），且不能用 Object.keys 的快照 —
// js/customer_site.js 会在运行时 extendAPISites 追加源，快照会漏掉新加的。

// API站点配置
// 注意：ruyi/xiaomaomi/heimuer/iqiyi/mozhua/wwzy/ikun/wolong/hwba 这 9 个 key 是历史遗留名
// （对应的老源已全部失效），现指向新的可用接口；key 名保持不变，避免影响前端已有引用。
// listOnly: true —— 该源的列表接口可用、但关键词搜索不可用（实测：返回「暂不支持搜索」/
// code!=1 / 403 / Cloudflare 挑战页）。标记后搜索链路直接跳过它（不发请求），
// 「最近更新」仍照常拉取；设置面板里会显示「仅列表」标记。
const API_SITES = {
    dyttzy: {
        api: 'http://caiji.dyttzyapi.com/api.php/provide/vod',
        name: '电影天堂资源',
        detail: 'http://caiji.dyttzyapi.com', 
    },
    ruyi: {
        api: 'https://api.guangsuapi.com/api.php/provide/vod/',
        name: '光速资源',
    },
    bfzy: {
        api: 'https://bfzyapi.com/api.php/provide/vod',
        name: '暴风资源',
    },
    tyyszy: {
        api: 'https://tyyszy.com/api.php/provide/vod',
        name: '天涯资源',
        listOnly: true,
    },
    xiaomaomi: {
        api: 'https://www.hongniuzy2.com/api.php/provide/vod/',
        name: '红牛资源',
    },
    ffzy: {
        api: 'http://ffzy5.tv/api.php/provide/vod',
        name: '非凡影视',
        detail: 'http://ffzy5.tv', 
    },
    heimuer: {
        api: 'https://hhzyapi.com/api.php/provide/vod/',
        name: '豪华资源',
    },
    zy360: {
        api: 'https://360zy.com/api.php/provide/vod',
        name: '360资源',
    },
    iqiyi: {
        api: 'https://suoniapi.com/api.php/provide/vod/',
        name: '索尼资源',
        listOnly: true,
    },
    wolong: {
        api: 'https://caiji.kuaichezy.org/api.php/provide/vod/',
        name: '快车资源',
        listOnly: true,
    }, 
    hwba: {
        api: 'https://caiji.xgzyapi.com/api.php/provide/vod/',
        name: '西瓜资源',
    },
    jisu: {
        api: 'https://jszyapi.com/api.php/provide/vod',
        name: '极速资源',
        detail: 'https://jszyapi.com', 
    },
    // dbzy（豆瓣资源）已停用：2026-11-10 实测源站域名解析失败（ERR_NAME_NOT_RESOLVED，
    // CNAME 链 dbzy.tv → dizubagu.cdnfree.org → zivaso20.cdnfree.org 终点无 A 记录）。
    // 留着只会白占一次请求；它原本也是 listOnly 源，不影响搜索面。
    // dbzy: {
    //     api: 'https://dbzy.tv/api.php/provide/vod',
    //     name: '豆瓣资源',
    //     listOnly: true,
    // },
    mozhua: {
        api: 'https://sdzyapi.com/api.php/provide/vod/',
        name: '闪电资源',
        listOnly: true,
    },
    mdzy: {
        api: 'https://www.mdzyapi.com/api.php/provide/vod',
        name: '魔都资源',
    },
    zuid: {
        api: 'https://api.zuidapi.com/api.php/provide/vod',
        name: '最大资源'
    },
    yinghua: {
        api: 'https://m3u8.apiyhzy.com/api.php/provide/vod',
        name: '樱花资源',
        listOnly: true,
    },
    baidu: {
        api: 'https://api.apibdzy.com/api.php/provide/vod',
        name: '百度云资源'
    },
    wujin: {
        api: 'https://api.wujinapi.me/api.php/provide/vod',
        name: '无尽资源',
        listOnly: true,
    },
    wwzy: {
        api: 'https://jyzyapi.com/api.php/provide/vod/',
        name: '金鹰资源'
    },
    ikun: {
        api: 'https://api.maoyanapi.top/api.php/provide/vod/',
        name: '猫眼资源'
    },
    lzi: {
        api: 'https://cj.lziapi.com/api.php/provide/vod/',
        name: '量子资源站'
    },
    // 新增源（2026-11-05 实测：列表 code=1/最新条目在 7 天内 + 关键词搜索有结果，各连测 2 次均通过）
    subo: {
        api: 'https://subocaiji.com/api.php/provide/vod',
        name: '速播资源'
    },
    xinlang: {
        api: 'https://api.xinlangapi.com/xinlangapi.php/provide/vod',
        name: '新浪资源'
    },
    //ARCHIVE https://telegra.ph/APIs-08-12
};

// 定义合并方法
function extendAPISites(newSites) {
    Object.assign(API_SITES, newSites);
}

// 暴露到全局
window.API_SITES = API_SITES;
window.extendAPISites = extendAPISites;

// 默认启用的源 = 当前全部源（函数而不是常量快照：源清单会变，
// 快照会在新增源时静默漏掉它 —— 那正是「初始状态启用所有源」这个要求要防的事）。
function getDefaultSourceKeys() {
    return Object.keys(API_SITES).filter(key => key !== 'aggregated' && key !== 'custom');
}


// 抽象API请求配置
const API_CONFIG = {
    search: {
        // 只拼接参数部分，不再包含 /api.php/provide/vod/
        path: '?ac=videolist&wd=',
        pagePath: '?ac=videolist&wd={query}&pg={page}',
        maxPages: 5,           // 每源最多翻 5 页（上游 SEARCH_MAX_PAGES 默认 5；原来 50 页太慢且没有必要）
        sourceTimeout: 10000,  // 单源总死线 10 秒（上游 SEARCH_SOURCE_TIMEOUT_MS 默认 10s）：到点整体放弃该源
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'application/json'
        }
    },
    detail: {
        // 只拼接参数部分
        path: '?ac=videolist&ids=',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'application/json'
        }
    }
};

// 优化后的正则表达式模式
const M3U8_PATTERN = /\$https?:\/\/[^"'\s]+?\.m3u8/g;

// 添加自定义播放器URL
const CUSTOM_PLAYER_URL = 'player.html'; // 使用相对路径引用本地player.html

// 增加视频播放相关配置
const PLAYER_CONFIG = {
    autoplay: true,
    allowFullscreen: true,
    width: '100%',
    height: '600',
    timeout: 15000,  // 播放器加载超时时间
    filterAds: true,  // 是否启用广告过滤
    autoPlayNext: true,  // 默认启用自动连播功能
    adFilteringEnabled: true, // 默认开启分片广告过滤
    adFilteringStorage: 'adFilteringEnabled' // 存储广告过滤设置的键名
};

// 增加错误信息本地化
const ERROR_MESSAGES = {
    NETWORK_ERROR: '网络连接错误，请检查网络设置',
    TIMEOUT_ERROR: '请求超时，服务器响应时间过长',
    API_ERROR: 'API接口返回错误，请尝试更换数据源',
    PLAYER_ERROR: '播放器加载失败，请尝试其他视频源',
    UNKNOWN_ERROR: '发生未知错误，请刷新页面重试'
};

// 添加进一步安全设置
const SECURITY_CONFIG = {
    enableXSSProtection: true,  // 是否启用XSS保护
    sanitizeUrls: true,         // 是否清理URL
    maxQueryLength: 100,        // 最大搜索长度
    // allowedApiDomains 不再需要，因为所有请求都通过内部代理
};

// 添加多个自定义API源的配置
const CUSTOM_API_CONFIG = {
    separator: ',',           // 分隔符
    maxSources: 5,            // 最大允许的自定义源数量
    testTimeout: 5000,        // 测试超时时间(毫秒)
    namePrefix: 'Custom-',    // 自定义源名称前缀
    validateUrl: true,        // 验证URL格式
    cacheResults: true,       // 缓存测试结果
    cacheExpiry: 5184000000,  // 缓存过期时间(2个月)
    adultPropName: 'isAdult' // 用于标记成人内容的属性名
};

// 隐藏内置黄色采集站API的变量
const HIDE_BUILTIN_ADULT_APIS = false;

// ==== 分类别名表 ====
// 各采集源对同一分类的叫法不统一（实测 22 个源最近更新共 43 种分类名，
// 其中「国产剧 / 大陆剧 / 内地剧」是同义、「记录片」是「纪录片」的错别字……），
// 分类标签按这张表合并后，同义分类不再撑爆标签栏。
// 只作用于「最近更新」的分类标签，不会改片名。可随时调整：
// key = 源站原始分类名，value = 合并后展示的标签名。
const CATEGORY_ALIASES = {
    // 国产剧系
    '大陆剧': '国产剧',
    '内地剧': '国产剧',
    // 港台剧系
    '香港剧': '港台剧',
    '港剧': '港台剧',
    '台湾剧': '港台剧',
    '台剧': '港台剧',
    // 日韩泰剧系
    '日剧': '日本剧',
    '韩剧': '韩国剧',
    '泰剧': '泰国剧',
    // 欧美剧系
    '美国剧': '欧美剧',
    '海外剧': '欧美剧',
    // 动漫系
    '国产动漫': '动漫',
    '中国动漫': '动漫',
    '日本动漫': '动漫',
    '欧美动漫': '动漫',
    '动画片': '动漫',
    // 纪录片（错别字归正）
    '记录片': '纪录片',
    // 综艺系
    '日韩综艺': '综艺',
    '港台综艺': '综艺',
    '大陆综艺': '综艺',
    '欧美综艺': '综艺'
};

// 暴露到全局
window.CATEGORY_ALIASES = CATEGORY_ALIASES;
