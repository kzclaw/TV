// functions/proxy/[[path]].js

// --- 配置 (现在从 Cloudflare 环境变量读取) ---
// 在 Cloudflare Pages 设置 -> 函数 -> 环境变量绑定 中设置以下变量:
// CACHE_TTL (例如 86400)
// MAX_RECURSION (例如 5)
// FILTER_DISCONTINUITY (不再需要，设为 false 或移除)
// USER_AGENTS_JSON (例如 ["UA1", "UA2"]) - JSON 字符串数组
// DEBUG (例如 false 或 true)
// PASSWORD (例如 "your_password") - 鉴权密码
// --- 配置结束 ---

// --- 常量 (之前在 config.js 中，现在移到这里，因为它们与代理逻辑相关) ---
const MEDIA_FILE_EXTENSIONS = [
    '.mp4', '.webm', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.f4v', '.m4v', '.3gp', '.3g2', '.ts', '.mts', '.m2ts',
    '.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac', '.wma', '.alac', '.aiff', '.opus',
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.svg', '.avif', '.heic'
];
const MEDIA_CONTENT_TYPES = ['video/', 'audio/', 'image/'];
// --- 常量结束 ---

// ==== SSRF 防护（Cloudflare Pages 等价实现）====
// 上游（Node 版）靠 node:dns + undici Agent 做连接级防护，Edge runtime 两样都没有，
// 这里换成 Pages 跑得动的等价物，判定口径与上游 ssrf.ts 保持一致：
//   ① 协议白名单（只允许 http/https）、禁止 userinfo、端口白名单（80/443）
//   ② 字面量 IP：回环/私有/链路本地（含 169.254.169.254）/0.0.0.0 及其 IPv6 等价段
//   ③ 域名：DoH 解析（Edge 没有 node:dns），命中私网即拒；结果按 host 缓存，避免每个请求多一次外网往返
//   ④ 重定向：redirect: 'manual'，每一跳重新校验，最多跟 3 跳
// DoH 解析失败时保守拒绝：宁可少一个源，也不能把 Pages Function 变成内网探测跳板。

const ALLOWED_PROXY_PORTS = ['80', '443'];
const MAX_REDIRECT_HOPS = 3;
const DOH_TTL_MS = 60 * 1000;
const DOH_FAIL_TTL_MS = 10 * 1000;
// DNS 记录类型号（DoH JSON API 的 Answer.type 用数字）
const DNS_TYPE_A = 1;
const DNS_TYPE_AAAA = 28;
// 主端点用 Cloudflare DoH；备用端点用 doh.pub（JSON 结构相同）
// 两个端点并发查、谁先回用谁：串行查时主端点一旦挂住，备用端点永远轮不到，
// 而 24 个源共用这一个 DNS 解析入口 → 主端点一卡就是「所有源同时超时」。
const DOH_ENDPOINTS = [
    'https://cloudflare-dns.com/dns-query',
    'https://doh.pub/dns-query'
];
// DoH 单次查询超时：外部端点不可达时 fetch 不会报错而是挂住，
// 没有超时就会一路拖到平台上限，把整条代理链路拖死。
const DOH_TIMEOUT_MS = 3000;
// 模块级 DNS 缓存：host -> { at, ttl, ips, error }
const dnsCache = new Map();

// JSON 响应在浏览器 / KV 里的缓存时长（秒）。
// 搜索结果与「最近更新」必须新鲜 —— 之前 JSON 被判成非 JSON 时落到了 24h 分支，
// 结果同一个关键词一天之内搜出来的都是旧数据。
const JSON_CACHE_TTL = 60;

/**
 * 出网信号 = 硬超时 ∪ 客户端断开
 *
 * 为什么两样都要：
 *   ① 硬超时 —— 源站挂住时代理不能无限等。客户端（探针 8s、搜索 10s）会先放弃，
 *      但服务端连接还占着 → 把浏览器对本站的连接槽占满 → 用户点搜索「没反应」。
 *   ② 客户端断开 —— 用户已经走了，服务端不该继续把源站请求挂着。
 *
 * 纯函数，导出给自检（tests/proxy-upstream-timeout.test.js）。
 * ⚠ clientSignal 通常是 request.signal；平台要在开了 enable_request_signal 兼容标志
 *   （或 compatibility date ≥ 2026-11-17）之后，客户端断开时它才会真的 abort。
 */
export function buildUpstreamSignal(clientSignal, timeoutMs) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    if (!clientSignal) return timeoutSignal;
    if (typeof AbortSignal.any === 'function') {
        try {
            return AbortSignal.any([clientSignal, timeoutSignal]);
        } catch (e) {
            // 运行环境不支持就退化成只用超时信号（仍能防无限挂）
        }
    }
    return timeoutSignal;
}

/**
 * JSON 判定：不能只看 content-type。
 * 采集站普遍用 text/html 送 JSON（实测 21/24 个源如此），只看 content-type 会判错，
 * 让 JSON 落到长缓存分支（搜索结果 24 小时不更新）。
 * 兜底看 body 的首个非空白字符：{ 或 [ 就是 JSON。
 */
export function isJsonPayload(bytes, contentType) {
    const ct = (contentType || '').toLowerCase();
    if (ct.includes('application/json') || ct.includes('+json')) return true;
    if (!bytes || !bytes.length) return false;
    for (let i = 0; i < Math.min(bytes.length, 64); i++) {
        const c = bytes[i];
        if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue; // 跳过空白
        return c === 0x7b || c === 0x5b;                                  // { 或 [
    }
    return false;
}

/** 去掉 IPv6 字面量外层的方括号（"[::1]" → "::1"） */
function stripBrackets(host) {
    return String(host == null ? '' : host).trim().replace(/^\[+/, '').replace(/\]+$/, '');
}

/**
 * IPv4 私有/保留网段：
 * 0.0.0.0/8、127/8、10/8、172.16/12、192.168/16、169.254/16（含云元数据 169.254.169.254）、
 * 100.64/10（CGNAT）、192.0.0/24（协议分配块）
 */
function isPrivateIPv4(ip) {
    const parts = String(ip).split('.');
    if (parts.length !== 4) return false;
    const nums = parts.map(part => (part === '' ? NaN : Number(part)));
    if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const [a, b, c] = nums;
    if (a === 0) return true;                                   // 0.0.0.0/8
    if (a === 127) return true;                                 // 回环
    if (a === 10) return true;                                  // 私有
    if (a === 172 && b >= 16 && b <= 31) return true;           // 172.16/12
    if (a === 192 && b === 168) return true;                    // 192.168/16
    if (a === 169 && b === 254) return true;                    // 链路本地（含元数据地址）
    if (a === 100 && b >= 64 && b <= 127) return true;           // CGNAT
    if (a === 192 && b === 0 && c === 0) return true;            // 192.0.0/24
    return false;
}

/** IPv6 字面量 → 8 个 16 位分组；不是合法 IPv6 返回 null */
function parseIPv6Groups(ip) {
    let value = stripBrackets(ip).toLowerCase();
    const zone = value.indexOf('%');
    if (zone >= 0) value = value.slice(0, zone);
    if (!value.includes(':')) return null;

    // 末尾内嵌 IPv4（::ffff:192.168.1.1）→ 折成两个十六进制分组
    const embedded = /^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(value);
    if (embedded) {
        const octets = embedded[2].split('.').map(Number);
        if (octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        const hi = (octets[0] << 8) | octets[1];
        const lo = (octets[2] << 8) | octets[3];
        value = embedded[1] + hi.toString(16) + ':' + lo.toString(16);
    }

    const halves = value.split('::');
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    let groups;
    if (halves.length === 2) {
        const fill = 8 - head.length - tail.length;
        if (fill < 0) return null;
        groups = head.concat(new Array(fill).fill('0'), tail);
    } else {
        groups = head;
    }
    if (groups.length !== 8) return null;
    const parsed = groups.map(group => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN));
    return parsed.some(Number.isNaN) ? null : parsed;
}

/** IPv6 私有/保留网段：::1 回环、:: 未指定、fc00::/7、fe80::/10、IPv4 映射/兼容、NAT64 */
function isPrivateIPv6(ip) {
    const groups = parseIPv6Groups(ip);
    if (!groups) return false;
    const zeros = (from, to) => {
        for (let i = from; i < to; i++) if (groups[i] !== 0) return false;
        return true;
    };
    const v4From = (hi, lo) => isPrivateIPv4([hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'));
    if (zeros(0, 7)) return true;                                                    // :: 与 ::1
    if (zeros(0, 5) && (groups[5] === 0xffff || groups[5] === 0)) return v4From(groups[6], groups[7]);
    if (groups[0] === 0x0064 && groups[1] === 0xff9b && zeros(2, 6)) return v4From(groups[6], groups[7]);
    if ((groups[0] & 0xfe00) === 0xfc00) return true;                                // fc00::/7
    if ((groups[0] & 0xffc0) === 0xfe80) return true;                                // fe80::/10
    return false;
}

/** 是否私有/保留地址（IPv4 + IPv6） */
function isPrivateIP(ip) {
    const value = stripBrackets(ip);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return isPrivateIPv4(value);
    if (value.includes(':')) return isPrivateIPv6(value);
    return false;
}

/** host 是否本身就是 IP 字面量 */
function isLiteralIP(host) {
    const value = stripBrackets(host);
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(value) || value.includes(':');
}

/**
 * URL 字面量校验（纯函数，无网络）：协议白名单 + 禁止 userinfo + 端口白名单 + 字面量 IP 黑名单。
 * 返回 { ok: true, host } 或 { ok: false, reason }。
 */
function checkProxyUrlSyntax(urlString) {
    let parsed;
    try {
        parsed = new URL(urlString);
    } catch (e) {
        return { ok: false, reason: '无效的 URL' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, reason: '只允许 http/https 协议' };
    }
    if (parsed.username || parsed.password) {
        return { ok: false, reason: 'URL 不允许携带用户名或密码' };
    }
    if (parsed.port && !ALLOWED_PROXY_PORTS.includes(parsed.port)) {
        return { ok: false, reason: '只允许 80/443 端口' };
    }
    const host = stripBrackets(parsed.hostname).toLowerCase();
    if (!host) return { ok: false, reason: '缺少主机名' };
    if (host === 'localhost' || host.endsWith('.localhost')) {
        return { ok: false, reason: '不允许的主机名' };
    }
    if (isLiteralIP(host) && isPrivateIP(host)) {
        return { ok: false, reason: '目标地址属于私有/保留网络' };
    }
    return { ok: true, host };
}

/** DoH 查询：返回该类型的记录（IP 列表）；端点全部不可达时抛错，无记录返回空数组
 *  两个端点并发查、谁先回用谁；每个端点都有超时。
 *  为什么不能串行：主端点挂住（不是报错，是黑洞）时串行要等它自己超时，
 *  备用端点根本轮不上；而所有源共用这一个 DNS 入口，一个端点卡住就等于全站源超时。
 */
async function dohQuery(host, type) {
    const attempts = DOH_ENDPOINTS.map(async endpoint => {
        const response = await fetch(`${endpoint}?name=${encodeURIComponent(host)}&type=${type}`, {
            headers: { 'Accept': 'application/dns-json' },
            signal: AbortSignal.timeout(DOH_TIMEOUT_MS)
        });
        if (!response.ok) throw new Error(`DoH HTTP ${response.status}`);
        const data = await response.json();
        const answers = Array.isArray(data && data.Answer) ? data.Answer : [];
        return answers
            .filter(answer => answer && answer.type === type && typeof answer.data === 'string')
            .map(answer => answer.data);
    });

    // 第一个成功的端点即结果（与旧版「先答的端点就用它的」口径一致），不等另一个；
    // 两个端点都失败才抛错。
    try {
        return await Promise.any(attempts);
    } catch (e) {
        const reasons = e && e.errors ? e.errors.map(r => r && r.message).filter(Boolean) : [];
        throw new Error(reasons[0] || 'DoH 端点全部不可用');
    }
}

/** 解析主机名（DoH），结果进模块级缓存（成功 60 秒 / 失败 10 秒） */
async function resolveHostAddresses(host) {
    const now = Date.now();
    const cached = dnsCache.get(host);
    if (cached && now - cached.at < cached.ttl) {
        if (cached.error) throw new Error(cached.error);
        return cached.ips;
    }

    let ips = [];
    let error = '';
    try {
        const [v4, v6] = await Promise.all([dohQuery(host, DNS_TYPE_A), dohQuery(host, DNS_TYPE_AAAA)]);
        ips = v4.concat(v6);
        if (!ips.length) error = 'DNS 没有解析记录';
    } catch (e) {
        error = 'DNS 解析失败';
    }
    dnsCache.set(host, { at: now, ttl: error ? DOH_FAIL_TTL_MS : DOH_TTL_MS, ips, error });
    if (error) throw new Error(error);
    return ips;
}

/**
 * 出网前的统一校验：字面量规则 + DoH 解析结果。
 * DoH 解析失败时保守拒绝（不放过未知地址）。
 */
async function checkOutboundTarget(urlString) {
    const syntax = checkProxyUrlSyntax(urlString);
    if (!syntax.ok) return syntax;
    if (isLiteralIP(syntax.host)) return { ok: true };    // 公网 IP 字面量：无需解析
    let ips;
    try {
        ips = await resolveHostAddresses(syntax.host);
    } catch (e) {
        return { ok: false, reason: `目标主机无法解析（${e.message}，保守拒绝）` };
    }
    for (const ip of ips) {
        if (isPrivateIP(ip)) {
            return { ok: false, reason: `目标主机解析到私有/保留地址（${ip}）` };
        }
    }
    return { ok: true };
}

/** SSRF 拦截：单独一类错误，便于回 403 而不是 500 */
class SsrfBlockedError extends Error {
    constructor(target, reason) {
        super(reason);
        this.name = 'SsrfBlockedError';
        this.target = target;
        this.reason = reason;
    }
}

/** 带 SSRF 校验的取数：每一跳重定向都重新校验，最多跟 MAX_REDIRECT_HOPS 跳 */
async function fetchWithSsrfGuard(targetUrl, headers, signal) {
    let current = targetUrl;
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
        const verdict = await checkOutboundTarget(current);
        if (!verdict.ok) throw new SsrfBlockedError(current, verdict.reason);
        const response = await fetch(current, { headers, redirect: 'manual', signal });
        const location = (response.status >= 300 && response.status < 400)
            ? response.headers.get('location')
            : null;
        if (!location) return response;
        if (hop >= MAX_REDIRECT_HOPS) throw new SsrfBlockedError(current, '重定向跳数过多');
        let next;
        try {
            next = new URL(location, current).toString();
        } catch (e) {
            throw new SsrfBlockedError(current, '重定向地址无效');
        }
        current = next;
    }
}

/** JSON 响应（带 CORS 头） */
function createJsonResponse(payload, status) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
            'Access-Control-Allow-Headers': '*',
            'Content-Type': 'application/json'
        }
    });
}

/**
 * sha256 十六进制哈希（代理鉴权用，结果与浏览器端 js/sha256.js 一致）
 */
async function sha256Hex(text) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** 二进制安全的 base64（KV 只能存字符串，分片必须这样存取，否则二进制会被 UTF-8 替换字符破坏） */
function bytesToBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
}

function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}


/**
 * 主要的 Pages Function 处理函数
 * 拦截发往 /proxy/* 的请求
 */
export async function onRequest(context) {
    const { request, env, next, waitUntil } = context; // next 和 waitUntil 可能需要
    const url = new URL(request.url);

    // 验证鉴权（主函数调用）
    // 鉴权哈希只算一次：validateAuth 与「重写分片 URL」共用
    const serverPasswordHash = env.PASSWORD ? await sha256Hex(env.PASSWORD) : '';
    const isValidAuth = await validateAuth(request, serverPasswordHash);
    if (!isValidAuth) {
        return new Response(JSON.stringify({
            success: false,
            error: '代理访问未授权：请检查密码配置或鉴权参数'
        }), { 
            status: 401,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
                'Access-Control-Allow-Headers': '*',
                'Content-Type': 'application/json'
            }
        });
    }

    // --- 从环境变量读取配置 ---
    const DEBUG_ENABLED = (env.DEBUG === 'true');
    const CACHE_TTL = parseInt(env.CACHE_TTL || '86400'); // 默认 24 小时
    const MAX_RECURSION = parseInt(env.MAX_RECURSION || '5'); // 默认 5 层
    // 出网硬超时（毫秒）：源站挂住时代理不能无限等。
    // 取 8s：短于搜索的单源死线（10s），让服务端先收尾并给出明确状态，
    // 而不是客户端放弃后服务端还占着连接。
    const UPSTREAM_TIMEOUT_MS = parseInt(env.UPSTREAM_TIMEOUT_MS || '8000');
    // 广告过滤已移至播放器处理，代理不再执行
    let USER_AGENTS = [ // 提供一个基础的默认值
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];
    try {
        // 尝试从环境变量解析 USER_AGENTS_JSON
        const agentsJson = env.USER_AGENTS_JSON;
        if (agentsJson) {
            const parsedAgents = JSON.parse(agentsJson);
            if (Array.isArray(parsedAgents) && parsedAgents.length > 0) {
                USER_AGENTS = parsedAgents;
            } else {
                 logDebug("环境变量 USER_AGENTS_JSON 格式无效或为空，使用默认值");
            }
        }
    } catch (e) {
        logDebug(`解析环境变量 USER_AGENTS_JSON 失败: ${e.message}，使用默认值`);
    }
    // --- 配置读取结束 ---

    // 出网信号：硬超时 + 客户端断开（见 buildUpstreamSignal 的注释）
    const upstreamSignal = buildUpstreamSignal(request.signal, UPSTREAM_TIMEOUT_MS);

    // --- 辅助函数 ---

    // 验证代理请求的鉴权
    async function validateAuth(request, serverPasswordHash) {
        const url = new URL(request.url);
        const authHash = url.searchParams.get('auth');
        const timestamp = url.searchParams.get('t');

        if (!serverPasswordHash) {
            console.error('服务器未设置 PASSWORD 环境变量，代理访问被拒绝');
            return false;
        }

        if (!authHash || authHash !== serverPasswordHash) {
            console.warn('代理请求鉴权失败：密码哈希不匹配');
            return false;
        }

        // 验证时间戳（10分钟有效期）
        if (timestamp) {
            const now = Date.now();
            const maxAge = 10 * 60 * 1000; // 10分钟
            if (now - parseInt(timestamp) > maxAge) {
                console.warn('代理请求鉴权失败：时间戳过期');
                return false;
            }
        }

        return true;
    }

    // 输出调试日志 (需要设置 DEBUG: true 环境变量)
    function logDebug(message) {
        if (DEBUG_ENABLED) {
            console.log(`[Proxy Func] ${message}`);
        }
    }

    // 从请求路径中提取目标 URL
    function getTargetUrlFromPath(pathname) {
        // 路径格式: /proxy/经过编码的URL
        // 例如: /proxy/https%3A%2F%2Fexample.com%2Fplaylist.m3u8
        const encodedUrl = pathname.replace(/^\/proxy\//, '');
        if (!encodedUrl) return null;
        try {
            // 解码
            let decodedUrl = decodeURIComponent(encodedUrl);

             // 简单检查解码后是否是有效的 http/https URL
             if (!decodedUrl.match(/^https?:\/\//i)) {
                 // 也许原始路径就没有编码？如果看起来像URL就直接用
                 if (encodedUrl.match(/^https?:\/\//i)) {
                     decodedUrl = encodedUrl;
                     logDebug(`Warning: Path was not encoded but looks like URL: ${decodedUrl}`);
                 } else {
                    logDebug(`无效的目标URL格式 (解码后): ${decodedUrl}`);
                    return null;
                 }
             }
             return decodedUrl;

        } catch (e) {
            logDebug(`解码目标URL时出错: ${encodedUrl} - ${e.message}`);
            return null;
        }
    }

    // 创建标准化的响应
    function createResponse(body, status = 200, headers = {}) {
        const responseHeaders = new Headers(headers);
        // 关键：添加 CORS 跨域头，允许前端 JS 访问代理后的响应
        responseHeaders.set("Access-Control-Allow-Origin", "*"); // 允许任何来源访问
        responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS"); // 允许的方法
        responseHeaders.set("Access-Control-Allow-Headers", "*"); // 允许所有请求头

        // 处理 CORS 预检请求 (OPTIONS) - 放在这里确保所有响应都处理
         if (request.method === "OPTIONS") {
             // 使用下面的 onOptions 函数可以更规范，但在这里处理也可以
             return new Response(null, {
                 status: 204, // No Content
                 headers: responseHeaders // 包含上面设置的 CORS 头
             });
         }

        return new Response(body, { status, headers: responseHeaders });
    }

    // 创建 M3U8 类型的响应
    function createM3u8Response(content) {
        return createResponse(content, 200, {
            "Content-Type": "application/vnd.apple.mpegurl", // M3U8 的标准 MIME 类型
            "Cache-Control": `public, max-age=${CACHE_TTL}` // 允许浏览器和CDN缓存
        });
    }

    // 二进制 / JSON 原样透传（分片、密钥、图片、接口数据）
    function createPassthroughResponse(bytes, responseHeaders, contentType, status) {
        const headers = new Headers();
        // 只透传这几个头：fetch 已经解压过，再把 content-encoding / content-length 带出去
        // 会让浏览器二次解压而报错。content-range / accept-ranges 必须带，
        // 否则拖进度条、BYTERANGE 分片的 206 请求会坏。
        for (const name of ['content-type', 'accept-ranges', 'content-range', 'etag', 'last-modified']) {
            const v = responseHeaders.get(name);
            if (v) headers.set(name, v);
        }
        // API 的 JSON 数据必须保持新鲜（搜索结果 / 最近更新列表）：
        // 原先沿用 24h 缓存，会让浏览器一天内看不到新内容；媒体文件仍走长缓存。
        // 判定不能只看 content-type —— 采集站普遍用 text/html 送 JSON（实测 21/24 个源如此），
        // 只看 content-type 会把 JSON 判成非 JSON → 落进 24h 分支。
        const isJsonContent = isJsonPayload(bytes, contentType);
        headers.set('Cache-Control', isJsonContent ? `public, max-age=${JSON_CACHE_TTL}` : `public, max-age=${CACHE_TTL}`);
        return createResponse(bytes, status, headers);
    }

    // 获取随机 User-Agent
    function getRandomUserAgent() {
        return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    }

    // 获取 URL 的基础路径 (用于解析相对路径)
    function getBaseUrl(urlStr) {
        try {
            const parsedUrl = new URL(urlStr);
            // 如果路径是根目录，或者没有斜杠，直接返回 origin + /
            if (!parsedUrl.pathname || parsedUrl.pathname === '/') {
                return `${parsedUrl.origin}/`;
            }
            const pathParts = parsedUrl.pathname.split('/');
            pathParts.pop(); // 移除文件名或最后一个路径段
            return `${parsedUrl.origin}${pathParts.join('/')}/`;
        } catch (e) {
            logDebug(`获取 BaseUrl 时出错: ${urlStr} - ${e.message}`);
            // 备用方法：找到最后一个斜杠
            const lastSlashIndex = urlStr.lastIndexOf('/');
            // 确保不是协议部分的斜杠 (http://)
            return lastSlashIndex > urlStr.indexOf('://') + 2 ? urlStr.substring(0, lastSlashIndex + 1) : urlStr + '/';
        }
    }


    // 将相对 URL 转换为绝对 URL
    function resolveUrl(baseUrl, relativeUrl) {
        // 如果已经是绝对 URL，直接返回
        if (relativeUrl.match(/^https?:\/\//i)) {
            return relativeUrl;
        }
        try {
            // 使用 URL 对象来处理相对路径
            return new URL(relativeUrl, baseUrl).toString();
        } catch (e) {
            logDebug(`解析 URL 失败: baseUrl=${baseUrl}, relativeUrl=${relativeUrl}, error=${e.message}`);
            // 简单的备用方法
            if (relativeUrl.startsWith('/')) {
                // 处理根路径相对 URL
                const urlObj = new URL(baseUrl);
                return `${urlObj.origin}${relativeUrl}`;
            }
            // 处理同级目录相对 URL
            return `${baseUrl.replace(/\/[^/]*$/, '/')}${relativeUrl}`; // 确保baseUrl以 / 结尾
        }
    }

    // 将目标 URL 重写为内部代理路径 (/proxy/...)
    function rewriteUrlToProxy(targetUrl) {
        // 分片 / 密钥 / 初始化段都要经本站转发（上游不给 CORS 头时浏览器会拦死），
        // 且必须带鉴权：validateAuth 强制要求 ?auth=<sha256(PASSWORD)>。
        // 不带 t= —— 时间戳 10 分钟就过期，长视频播到一半会全 401。
        return `/proxy/${encodeURIComponent(targetUrl)}?auth=${serverPasswordHash}`;
    }

    // 获取远程内容及其类型（二进制安全：整段走 arrayBuffer，绝不用 text()）
    async function fetchContentWithType(targetUrl, rangeHeader, signal) {
        const headers = new Headers({
            'User-Agent': getRandomUserAgent(),
            'Accept': '*/*',
            // 尝试传递一些原始请求的头信息
            'Accept-Language': request.headers.get('Accept-Language') || 'zh-CN,zh;q=0.9,en;q=0.8',
            // 尝试设置 Referer 为目标网站的域名，或者传递原始 Referer
            'Referer': request.headers.get('Referer') || new URL(targetUrl).origin
        });
        // 透传 Range：hls.js 的 BYTERANGE 分片 / 拖动进度条都要靠它拿 206
        if (rangeHeader) {
            headers.set('Range', rangeHeader);
        }

        try {
            // 直接请求目标 URL
            logDebug(`开始直接请求: ${targetUrl}`);
            // 出网前做 SSRF 校验（协议/端口/私网 IP/DoH 解析），重定向逐跳重新校验
            const response = await fetchWithSsrfGuard(targetUrl, headers, signal);

            if (!response.ok) {
                 const errorBody = await response.text().catch(() => '');
                 logDebug(`请求失败: ${response.status} ${response.statusText} - ${targetUrl}`);
                 throw new Error(`HTTP error ${response.status}: ${response.statusText}. URL: ${targetUrl}. Body: ${errorBody.substring(0, 150)}`);
            }

            // 按字节读取：文本 / 二进制一视同仁，避免 text() 破坏 ts/mp4 分片
            const buf = await response.arrayBuffer();
            const contentType = response.headers.get('Content-Type') || '';
            logDebug(`请求成功: ${targetUrl}, Content-Type: ${contentType}, 字节数: ${buf.byteLength}`);
            return { bytes: new Uint8Array(buf), contentType, responseHeaders: response.headers, status: response.status };

        } catch (error) {
             if (error && error.name === 'SsrfBlockedError') throw error;  // 不吞：交给上层回 403
             logDebug(`请求彻底失败: ${targetUrl}: ${error.message}`);
            // 抛出更详细的错误
            throw new Error(`请求目标URL失败 ${targetUrl}: ${error.message}`);
        }
    }

    // 判断是否是 M3U8 内容（既看文本，也看字节前缀）
    function isM3u8Content(bytes, contentType) {
        // 检查 Content-Type
        if (contentType && (contentType.includes('application/vnd.apple.mpegurl') || contentType.includes('application/x-mpegurl') || contentType.includes('audio/mpegurl'))) {
            return true;
        }
        // 检查内容本身是否以 #EXTM3U 开头（二进制内容只看前 16 字节）
        if (!bytes || !bytes.length) return false;
        const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 16)).trim();
        return head.startsWith('#EXTM3U');
    }

    // 字节 → 文本（只有 m3u8 / JSON 用）
    function decodeText(bytes) {
        return new TextDecoder('utf-8').decode(bytes);
    }

    // 判断是否是媒体文件 (根据扩展名和 Content-Type) - 这部分在此代理中似乎未使用，但保留
    function isMediaFile(url, contentType) {
        if (contentType) {
            for (const mediaType of MEDIA_CONTENT_TYPES) {
                if (contentType.toLowerCase().startsWith(mediaType)) {
                    return true;
                }
            }
        }
        const urlLower = url.toLowerCase();
        for (const ext of MEDIA_FILE_EXTENSIONS) {
            if (urlLower.endsWith(ext) || urlLower.includes(`${ext}?`)) {
                return true;
            }
        }
        return false;
    }

    // 处理 M3U8 中的 #EXT-X-KEY 行 (加密密钥)
    function processKeyLine(line, baseUrl) {
        return line.replace(/URI="([^"]+)"/, (match, uri) => {
            const absoluteUri = resolveUrl(baseUrl, uri);
            logDebug(`处理 KEY URI: 原始='${uri}', 绝对='${absoluteUri}'`);
            return `URI="${rewriteUrlToProxy(absoluteUri)}"`; // 重写为代理路径
        });
    }

    // 处理 M3U8 中的 #EXT-X-MAP 行 (初始化片段)
    function processMapLine(line, baseUrl) {
         return line.replace(/URI="([^"]+)"/, (match, uri) => {
             const absoluteUri = resolveUrl(baseUrl, uri);
             logDebug(`处理 MAP URI: 原始='${uri}', 绝对='${absoluteUri}'`);
             return `URI="${rewriteUrlToProxy(absoluteUri)}"`; // 重写为代理路径
         });
     }

    // 处理媒体 M3U8 播放列表 (包含视频/音频片段)
    function processMediaPlaylist(url, content) {
        const baseUrl = getBaseUrl(url);
        const lines = content.split('\n');
        const output = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            // 保留最后的空行
            if (!line && i === lines.length - 1) {
                output.push(line);
                continue;
            }
            if (!line) continue; // 跳过中间的空行

            if (line.startsWith('#EXT-X-KEY')) {
                output.push(processKeyLine(line, baseUrl));
                continue;
            }
            if (line.startsWith('#EXT-X-MAP')) {
                output.push(processMapLine(line, baseUrl));
                 continue;
            }
             if (line.startsWith('#EXTINF')) {
                 output.push(line);
                 continue;
             }
             if (!line.startsWith('#')) {
                 const absoluteUrl = resolveUrl(baseUrl, line);
                 logDebug(`重写媒体片段: 原始='${line}', 绝对='${absoluteUrl}'`);
                 output.push(rewriteUrlToProxy(absoluteUrl));
                 continue;
             }
             // 其他 M3U8 标签直接添加
             output.push(line);
        }
        return output.join('\n');
    }

    // 递归处理 M3U8 内容
     async function processM3u8Content(targetUrl, content, recursionDepth = 0, env) {
         if (content.includes('#EXT-X-STREAM-INF') || content.includes('#EXT-X-MEDIA:')) {
             logDebug(`检测到主播放列表: ${targetUrl}`);
             return await processMasterPlaylist(targetUrl, content, recursionDepth, env);
         }
         logDebug(`检测到媒体播放列表: ${targetUrl}`);
         return processMediaPlaylist(targetUrl, content);
     }

    // 处理主 M3U8 播放列表
    async function processMasterPlaylist(url, content, recursionDepth, env) {
        if (recursionDepth > MAX_RECURSION) {
            throw new Error(`处理主列表时递归层数过多 (${MAX_RECURSION}): ${url}`);
        }

        const baseUrl = getBaseUrl(url);
        const lines = content.split('\n');
        let highestBandwidth = -1;
        let bestVariantUrl = '';

        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                const bandwidthMatch = lines[i].match(/BANDWIDTH=(\d+)/);
                const currentBandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1], 10) : 0;

                 let variantUriLine = '';
                 for (let j = i + 1; j < lines.length; j++) {
                     const line = lines[j].trim();
                     if (line && !line.startsWith('#')) {
                         variantUriLine = line;
                         i = j;
                         break;
                     }
                 }

                 if (variantUriLine && currentBandwidth >= highestBandwidth) {
                     highestBandwidth = currentBandwidth;
                     bestVariantUrl = resolveUrl(baseUrl, variantUriLine);
                 }
            }
        }

         if (!bestVariantUrl) {
             logDebug(`主列表中未找到 BANDWIDTH 或 STREAM-INF，尝试查找第一个子列表引用: ${url}`);
             for (let i = 0; i < lines.length; i++) {
                 const line = lines[i].trim();
                 if (line && !line.startsWith('#') && (line.endsWith('.m3u8') || line.includes('.m3u8?'))) { // 修复：检查是否包含 .m3u8?
                    bestVariantUrl = resolveUrl(baseUrl, line);
                     logDebug(`备选方案：找到第一个子列表引用: ${bestVariantUrl}`);
                     break;
                 }
             }
         }

        if (!bestVariantUrl) {
            logDebug(`在主列表 ${url} 中未找到任何有效的子播放列表 URL。可能格式有问题或仅包含音频/字幕。将尝试按媒体列表处理原始内容。`);
            return processMediaPlaylist(url, content);
        }

        // --- 获取并处理选中的子 M3U8 ---

        // 缓存键带上鉴权哈希：重写后的分片 URL 里含 auth，改密码后旧缓存会 401
        const cacheKey = `m3u8_processed:${bestVariantUrl}:${serverPasswordHash}`;

        let kvNamespace = null;
        try {
            kvNamespace = env.LIBRETV_PROXY_KV; // 从环境获取 KV 命名空间 (变量名在 Cloudflare 设置)
            if (!kvNamespace) throw new Error("KV 命名空间未绑定");
        } catch (e) {
            logDebug(`KV 命名空间 'LIBRETV_PROXY_KV' 访问出错或未绑定: ${e.message}`);
            kvNamespace = null; // 确保设为 null
        }

        if (kvNamespace) {
            try {
                const cachedContent = await kvNamespace.get(cacheKey);
                if (cachedContent) {
                    logDebug(`[缓存命中] 主列表的子列表: ${bestVariantUrl}`);
                    return cachedContent;
                } else {
                    logDebug(`[缓存未命中] 主列表的子列表: ${bestVariantUrl}`);
                }
            } catch (kvError) {
                logDebug(`从 KV 读取缓存失败 (${cacheKey}): ${kvError.message}`);
                // 出错则继续执行，不影响功能
            }
        }

        logDebug(`选择的子列表 (带宽: ${highestBandwidth}): ${bestVariantUrl}`);
        const { bytes: variantBytes, contentType: variantContentType } = await fetchContentWithType(bestVariantUrl, undefined, upstreamSignal);

        if (!isM3u8Content(variantBytes, variantContentType)) {
            logDebug(`获取到的子列表 ${bestVariantUrl} 不是 M3U8 内容 (类型: ${variantContentType})。可能直接是媒体文件，返回原始内容。`);
             // 尝试按媒体列表处理，以防万一
             return processMediaPlaylist(bestVariantUrl, decodeText(variantBytes));
        }

        const processedVariant = await processM3u8Content(bestVariantUrl, decodeText(variantBytes), recursionDepth + 1, env);

        if (kvNamespace) {
             try {
                 // 使用 waitUntil 异步写入缓存，不阻塞响应返回
                 // 注意 KV 的写入限制 (免费版每天 1000 次)
                 waitUntil(kvNamespace.put(cacheKey, processedVariant, { expirationTtl: CACHE_TTL }));
                 logDebug(`已将处理后的子列表写入缓存: ${bestVariantUrl}`);
             } catch (kvError) {
                 logDebug(`向 KV 写入缓存失败 (${cacheKey}): ${kvError.message}`);
                 // 写入失败不影响返回结果
             }
        }

        return processedVariant;
    }

    // --- 主要请求处理逻辑 ---

    try {
        const targetUrl = getTargetUrlFromPath(url.pathname);

        if (!targetUrl) {
            logDebug(`无效的代理请求路径: ${url.pathname}`);
            return createResponse("无效的代理请求。路径应为 /proxy/<经过编码的URL>", 400);
        }

        // SSRF 校验：协议/端口/userinfo/私网 IP/DoH 解析，全部在出网之前
        const ssrfVerdict = await checkOutboundTarget(targetUrl);
        if (!ssrfVerdict.ok) {
            logDebug(`SSRF 拦截: ${targetUrl} - ${ssrfVerdict.reason}`);
            return createJsonResponse({
                success: false,
                error: '目标地址被安全策略拒绝',
                target: targetUrl,
                reason: ssrfVerdict.reason
            }, 403);
        }

        logDebug(`收到代理请求: ${targetUrl}`);

        // --- 缓存检查 (KV) ---
        const cacheKey = `proxy_raw:${targetUrl}`; // 使用原始内容的缓存键
        let kvNamespace = null;
        try {
            kvNamespace = env.LIBRETV_PROXY_KV;
            if (!kvNamespace) throw new Error("KV 命名空间未绑定");
        } catch (e) {
            logDebug(`KV 命名空间 'LIBRETV_PROXY_KV' 访问出错或未绑定: ${e.message}`);
            kvNamespace = null; // 确保设为 null
        }

        // Range 请求拿到的是片段，不能进缓存（否则后面的完整请求会拿到残缺数据）
        const clientRange = request.headers.get('Range');
        const cacheable = !!kvNamespace && !clientRange;

        if (cacheable) {
            try {
                const cachedDataJson = await kvNamespace.get(cacheKey); // 直接获取字符串
                if (cachedDataJson) {
                    logDebug(`[缓存命中] 原始内容: ${targetUrl}`);
                    const cachedData = JSON.parse(cachedDataJson); // 解析 JSON
                    // body 存 base64：KV 只能存字符串，直接存二进制会被 UTF-8 替换字符破坏
                    const bytes = base64ToBytes(cachedData.body);
                    let headers = {};
                    try { headers = JSON.parse(cachedData.headers); } catch(e){} // 解析头部
                    const contentType = headers['content-type'] || headers['Content-Type'] || '';

                    if (isM3u8Content(bytes, contentType)) {
                        logDebug(`缓存内容是 M3U8，重新处理: ${targetUrl}`);
                        const processedM3u8 = await processM3u8Content(targetUrl, decodeText(bytes), 0, env);
                        return createM3u8Response(processedM3u8);
                    } else {
                        logDebug(`从缓存返回非 M3U8 内容: ${targetUrl}`);
                        return createPassthroughResponse(bytes, new Headers(headers), contentType, 200);
                    }
                } else {
                     logDebug(`[缓存未命中] 原始内容: ${targetUrl}`);
                 }
            } catch (kvError) {
                 logDebug(`从 KV 读取或解析缓存失败 (${cacheKey}): ${kvError.message}`);
                 // 出错则继续执行，不影响功能
            }
        }

        // --- 实际请求 ---
        const { bytes, contentType, responseHeaders, status } = await fetchContentWithType(targetUrl, clientRange, upstreamSignal);

        // --- 写入缓存 (KV) ---
        if (cacheable) {
             try {
                 const headersToCache = {};
                 responseHeaders.forEach((value, key) => { headersToCache[key.toLowerCase()] = value; });
                 const cacheValue = { body: bytesToBase64(bytes), headers: JSON.stringify(headersToCache) };
                 // KV 写入的 TTL 也要分类型：JSON（搜索结果 / 最近更新）用短 TTL，
                 // 否则搜索结果会在 KV 里躺满 24 小时；媒体文件沿用长 TTL。
                 const kvTtl = isJsonPayload(bytes, contentType) ? JSON_CACHE_TTL : CACHE_TTL;
                 // 注意 KV 写入限制
                 waitUntil(kvNamespace.put(cacheKey, JSON.stringify(cacheValue), { expirationTtl: kvTtl }));
                 logDebug(`已将原始内容写入缓存: ${targetUrl}`);
            } catch (kvError) {
                 logDebug(`向 KV 写入缓存失败 (${cacheKey}): ${kvError.message}`);
                 // 写入失败不影响返回结果
            }
        }

        // --- 处理响应 ---
        if (isM3u8Content(bytes, contentType)) {
            logDebug(`内容是 M3U8，开始处理: ${targetUrl}`);
            const processedM3u8 = await processM3u8Content(targetUrl, decodeText(bytes), 0, env);
            return createM3u8Response(processedM3u8);
        } else {
            logDebug(`内容不是 M3U8 (类型: ${contentType})，直接返回: ${targetUrl}`);
            return createPassthroughResponse(bytes, responseHeaders, contentType, status);
        }

    } catch (error) {
        if (error && error.name === 'SsrfBlockedError') {
            logDebug(`SSRF 拦截: ${error.target} - ${error.reason}`);
            return createJsonResponse({
                success: false,
                error: '目标地址被安全策略拒绝',
                target: error.target,
                reason: error.reason
            }, 403);
        }
        logDebug(`处理代理请求时发生严重错误: ${error.message} \n ${error.stack}`);
        return createResponse(`代理处理错误: ${error.message}`, 500);
    }
}

// 处理 OPTIONS 预检请求的函数
export async function onOptions(context) {
    // 直接返回允许跨域的头信息
    return new Response(null, {
        status: 204, // No Content
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
            "Access-Control-Allow-Headers": "*", // 允许所有请求头
            "Access-Control-Max-Age": "86400", // 预检请求结果缓存一天
        },
    });
}

// 导出判定用的纯函数，供 tests/proxy-ssrf.test.js 自检（不依赖网络）
export { isPrivateIPv4, isPrivateIPv6, isPrivateIP, isLiteralIP, checkProxyUrlSyntax };
