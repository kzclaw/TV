// ==== 源健康（熔断）====
// 借鉴上游 src/lib/store.ts 的阶梯：连续失败到阈值就停用，停用时长按次数递增
// 30 分钟 → 24 小时 → 7 天。成功一次降一级（不是直接清零，偶发抽风的源能自己降回来）。
// 不改用户勾选状态：是否跳过由调用方按 isSourceSkipped 过滤。
// V3：V2 的「长期停用」是永久的（permanent:true 永不过期），源站一恢复也回不来，
// 只能逐个点黄色「已跳过」标记。换版本号直接作废旧状态 —— 网络抖动一次就可能把
// 全部源钉死，不能让用户带着这份状态升级。
const SOURCE_HEALTH_KEY = 'kzTvSourceHealthV3'; // 带版本前缀，避免与旧缓存冲突
const SOURCE_HEALTH_FAIL_LIMIT = 2;            // 连续失败次数达到该值即停用
// 停用阶梯：第 1 次 30 分钟，第 2 次 24 小时，第 3 次（及以后）7 天。
// 阶梯不再「用尽即永久」：上游用「7 天未参与即作废惩罚」达到同一目的，
// 这里直接给阶梯末级 7 天 —— 顶级也一定会有终点，不留「永远搜不到这个源」的死胡同。
const SOURCE_DISABLE_LADDER = [30 * 60 * 1000, 24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000];

function getSourceHealthStore() {
    try {
        return JSON.parse(localStorage.getItem(SOURCE_HEALTH_KEY) || '{}');
    } catch (e) {
        return {};
    }
}

function saveSourceHealthStore(store) {
    try {
        localStorage.setItem(SOURCE_HEALTH_KEY, JSON.stringify(store));
    } catch (e) {
        console.warn('源健康状态保存失败:', e);
    }
}

// 处于停用期或已长期停用 → 该源暂时不发请求
function isSourceSkipped(sourceKey) {
    const record = getSourceHealthStore()[sourceKey];
    if (!record) return false;
    return (record.disabledUntil || 0) > Date.now();
}

function markSourceFailed(sourceKey) {
    const store = getSourceHealthStore();
    const prev = store[sourceKey] || {};
    const now = Date.now();
    // 停用期已过 → 上一次的连续失败已被「停用 + 恢复」打断，重新从 1 开始累计（与上游同口径）。
    // 不这样算的话，一次网络抖动就能把计数攒到阶梯尽头，把源永久钉死。
    const interrupted = (prev.disabledUntil || 0) > 0 && (prev.disabledUntil || 0) <= now;
    const failStreak = interrupted ? 1 : (prev.failStreak || 0) + 1;
    const next = Object.assign({}, prev, { failStreak, lastFailAt: now });
    if (interrupted) next.disabledUntil = 0;

    if (failStreak >= SOURCE_HEALTH_FAIL_LIMIT) {
        // 已在停用期内 → 保持原等级，不重复升级
        const alreadyDisabled = (next.disabledUntil || 0) > now;
        if (!alreadyDisabled) {
            // 阶梯末级之后不再升级，一直按 7 天重试
            const level = Math.min((prev.disableCount || 0) + 1, SOURCE_DISABLE_LADDER.length);
            next.disableCount = level;
            next.disabledUntil = now + SOURCE_DISABLE_LADDER[level - 1];
        }
    }

    store[sourceKey] = next;
    saveSourceHealthStore(store);
}

// 成功一次即降一级（阶梯降一级，不是直接清零）
function markSourceSucceeded(sourceKey) {
    const store = getSourceHealthStore();
    const prev = store[sourceKey];
    if (!prev) return;
    store[sourceKey] = Object.assign({}, prev, {
        failStreak: 0,
        disableCount: Math.max(0, (prev.disableCount || 0) - 1),
        disabledUntil: 0,
        lastOkAt: Date.now()
    });
    saveSourceHealthStore(store);
}

// 手动清掉某个源的熔断状态（长期停用后唯一的恢复入口）
function clearSourceHealth(sourceKey) {
    const store = getSourceHealthStore();
    if (!store[sourceKey]) return;
    delete store[sourceKey];
    saveSourceHealthStore(store);
}

// 一键清掉所有源的熔断状态。
// 全部源都被停用时，逐个点黄色「已跳过」标记才能恢复 —— 24 个源点 24 次，
// 等于没有恢复入口。DNS 一挂就是全站源一起中招，所以这个出口是必需的。
function clearAllSourceHealth() {
    localStorage.removeItem(SOURCE_HEALTH_KEY);
}

function getSkippedSources() {
    const store = getSourceHealthStore();
    return Object.keys(store).filter(key => isSourceSkipped(key));
}

window.SourceHealth = {
    isSourceSkipped,
    markSourceFailed,
    markSourceSucceeded,
    clearSourceHealth,
    clearAllSourceHealth,
    getSkippedSources
};

// 按更新时间倒序（新的在前）；时间相同或无法解析时按名称、来源排序
function compareByVodTime(a, b) {
    const timeDiff = parseVodTime(b.vod_time) - parseVodTime(a.vod_time);
    if (timeDiff !== 0) return timeDiff;

    const nameCompare = (a.vod_name || '').localeCompare(b.vod_name || '');
    if (nameCompare !== 0) return nameCompare;

    return (a.source_name || '').localeCompare(b.source_name || '');
}

// 采集源请求：统一走站点代理 + 超时控制；失败抛异常，便于统计熔断
// externalSignal：外部取消信号（选源弹窗关闭时中止在途请求）
async function fetchSourceData(apiUrl, timeoutMs, externalSignal) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    linkAbortSignal(externalSignal, controller);

    try {
        // 添加鉴权参数到代理URL
        const proxiedUrl = await window.ProxyAuth?.addAuthToProxyUrl ?
            await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(apiUrl)) :
            PROXY_URL + encodeURIComponent(apiUrl);

        const response = await fetch(proxiedUrl, {
            headers: API_CONFIG.search.headers,
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`请求失败: ${response.status}`);
        }

        const data = await response.json();

        if (!data || !Array.isArray(data.list)) {
            throw new Error('返回的数据格式无效');
        }

        return data;
    } finally {
        clearTimeout(timeoutId);
    }
}

// 让外部取消信号（弹窗关闭）也能中断内部请求：
// 内部请求用的是自己的超时控制器，外部不介入的话，弹窗关了请求还在跑。
function linkAbortSignal(externalSignal, controller) {
    if (!externalSignal) return;
    if (externalSignal.aborted) {
        controller.abort();
    } else {
        externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
}

// 改进的API请求处理函数
async function handleApiRequest(url, init) {
    const customApi = url.searchParams.get('customApi') || '';
    const customDetail = url.searchParams.get('customDetail') || '';
    const source = url.searchParams.get('source') || 'heimuer';
    const externalSignal = init && init.signal;

    try {
        if (url.pathname === '/api/search') {
            const searchQuery = url.searchParams.get('wd');
            if (!searchQuery) {
                throw new Error('缺少搜索参数');
            }
            
            // 验证API和source的有效性
            if (source === 'custom' && !customApi) {
                throw new Error('使用自定义API时必须提供API地址');
            }
            
            if (!API_SITES[source] && source !== 'custom') {
                throw new Error('无效的API来源');
            }
            
            const apiUrl = customApi
                ? `${customApi}${API_CONFIG.search.path}${encodeURIComponent(searchQuery)}`
                : `${API_SITES[source].api}${API_CONFIG.search.path}${encodeURIComponent(searchQuery)}`;
            
            // 添加超时处理
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);
            
            try {
                // 添加鉴权参数到代理URL
                const proxiedUrl = await window.ProxyAuth?.addAuthToProxyUrl ? 
                    await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(apiUrl)) :
                    PROXY_URL + encodeURIComponent(apiUrl);
                    
                const response = await fetch(proxiedUrl, {
                    headers: API_CONFIG.search.headers,
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                
                if (!response.ok) {
                    throw new Error(`API请求失败: ${response.status}`);
                }
                
                const data = await response.json();
                
                // 检查JSON格式的有效性
                if (!data || !Array.isArray(data.list)) {
                    throw new Error('API返回的数据格式无效');
                }
                
                // 添加源信息到每个结果
                data.list.forEach(item => {
                    item.source_name = source === 'custom' ? '自定义源' : API_SITES[source].name;
                    item.source_code = source;
                    // 对于自定义源，添加API URL信息
                    if (source === 'custom') {
                        item.api_url = customApi;
                    }
                });
                
                return JSON.stringify({
                    code: 200,
                    list: data.list || [],
                });
            } catch (fetchError) {
                clearTimeout(timeoutId);
                throw fetchError;
            }
        }

        // 详情处理
        if (url.pathname === '/api/detail') {
            const id = url.searchParams.get('id');
            const sourceCode = url.searchParams.get('source') || 'heimuer'; // 获取源代码
            
            if (!id) {
                throw new Error('缺少视频ID参数');
            }
            
            // 验证ID格式 - 只允许数字和有限的特殊字符
            if (!/^[\w-]+$/.test(id)) {
                throw new Error('无效的视频ID格式');
            }

            // 验证API和source的有效性
            if (sourceCode === 'custom' && !customApi) {
                throw new Error('使用自定义API时必须提供API地址');
            }
            
            if (!API_SITES[sourceCode] && sourceCode !== 'custom') {
                throw new Error('无效的API来源');
            }

            // 对于有detail参数的源，都使用特殊处理方式
            if (sourceCode !== 'custom' && API_SITES[sourceCode].detail) {
                return await handleSpecialSourceDetail(id, sourceCode, externalSignal);
            }
            
            // 如果是自定义API，并且传递了detail参数，尝试特殊处理
            // 优先 customDetail
            if (sourceCode === 'custom' && customDetail) {
                return await handleCustomApiSpecialDetail(id, customDetail);
            }
            if (sourceCode === 'custom' && url.searchParams.get('useDetail') === 'true') {
                return await handleCustomApiSpecialDetail(id, customApi);
            }
            
            const detailUrl = customApi
                ? `${customApi}${API_CONFIG.detail.path}${id}`
                : `${API_SITES[sourceCode].api}${API_CONFIG.detail.path}${id}`;
            
            // 添加超时处理
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);
            linkAbortSignal(externalSignal, controller);
            
            try {
                // 添加鉴权参数到代理URL
                const proxiedUrl = await window.ProxyAuth?.addAuthToProxyUrl ? 
                    await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(detailUrl)) :
                    PROXY_URL + encodeURIComponent(detailUrl);
                    
                const response = await fetch(proxiedUrl, {
                    headers: API_CONFIG.detail.headers,
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                
                if (!response.ok) {
                    throw new Error(`详情请求失败: ${response.status}`);
                }
                
                // 解析JSON
                const data = await response.json();
                
                // 检查返回的数据是否有效
                if (!data || !data.list || !Array.isArray(data.list) || data.list.length === 0) {
                    throw new Error('获取到的详情内容无效');
                }
                
                // 获取第一个匹配的视频详情
                const videoDetail = data.list[0];
                
                // 提取播放地址
                let episodes = [];
                
                if (videoDetail.vod_play_url) {
                    // 分割不同播放源
                    const playSources = videoDetail.vod_play_url.split('$$$');
                    
                    // 提取第一个播放源的集数（通常为主要源）
                    if (playSources.length > 0) {
                        const mainSource = playSources[0];
                        const episodeList = mainSource.split('#');
                        
                        // 从每个集数中提取URL
                        episodes = episodeList.map(ep => {
                            const parts = ep.split('$');
                            // 返回URL部分(通常是第二部分，如果有的话)
                            return parts.length > 1 ? parts[1] : '';
                        }).filter(url => url && (url.startsWith('http://') || url.startsWith('https://')));
                    }
                }
                
                // 如果没有找到播放地址，尝试使用正则表达式查找m3u8链接
                if (episodes.length === 0 && videoDetail.vod_content) {
                    const matches = videoDetail.vod_content.match(M3U8_PATTERN) || [];
                    episodes = matches.map(link => link.replace(/^\$/, ''));
                }
                
                return JSON.stringify({
                    code: 200,
                    episodes: episodes,
                    detailUrl: detailUrl,
                    videoInfo: {
                        title: videoDetail.vod_name,
                        cover: videoDetail.vod_pic,
                        desc: videoDetail.vod_content,
                        type: videoDetail.type_name,
                        year: videoDetail.vod_year,
                        area: videoDetail.vod_area,
                        director: videoDetail.vod_director,
                        actor: videoDetail.vod_actor,
                        remarks: videoDetail.vod_remarks,
                        // 添加源信息
                        source_name: sourceCode === 'custom' ? '自定义源' : API_SITES[sourceCode].name,
                        source_code: sourceCode
                    }
                });
            } catch (fetchError) {
                clearTimeout(timeoutId);
                throw fetchError;
            }
        }

        // 最近更新
        if (url.pathname === '/api/latest') {
            return await handleLatestUpdates();
        }

        throw new Error('未知的API路径');
    } catch (error) {
        console.error('API处理错误:', error);
        return JSON.stringify({
            code: 400,
            msg: error.message || '请求处理失败',
            list: [],
            episodes: [],
        });
    }
}

// 处理自定义API的特殊详情页
async function handleCustomApiSpecialDetail(id, customApi) {
    try {
        // 构建详情页URL
        const detailUrl = `${customApi}/index.php/vod/detail/id/${id}.html`;
        
        // 添加超时处理
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        
        // 添加鉴权参数到代理URL
        const proxiedUrl = await window.ProxyAuth?.addAuthToProxyUrl ? 
            await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(detailUrl)) :
            PROXY_URL + encodeURIComponent(detailUrl);
            
        // 获取详情页HTML
        const response = await fetch(proxiedUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            },
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            throw new Error(`自定义API详情页请求失败: ${response.status}`);
        }
        
        // 获取HTML内容
        const html = await response.text();
        
        // 使用通用模式提取m3u8链接
        const generalPattern = /\$(https?:\/\/[^"'\s]+?\.m3u8)/g;
        let matches = html.match(generalPattern) || [];
        
        // 处理链接
        matches = matches.map(link => {
            link = link.substring(1, link.length);
            const parenIndex = link.indexOf('(');
            return parenIndex > 0 ? link.substring(0, parenIndex) : link;
        });
        
        // 提取基本信息
        const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
        const titleText = titleMatch ? titleMatch[1].trim() : '';
        
        const descMatch = html.match(/<div[^>]*class=["']sketch["'][^>]*>([\s\S]*?)<\/div>/);
        const descText = descMatch ? descMatch[1].replace(/<[^>]+>/g, ' ').trim() : '';
        
        return JSON.stringify({
            code: 200,
            episodes: matches,
            detailUrl: detailUrl,
            videoInfo: {
                title: titleText,
                desc: descText,
                source_name: '自定义源',
                source_code: 'custom'
            }
        });
    } catch (error) {
        console.error(`自定义API详情获取失败:`, error);
        throw error;
    }
}

// 通用特殊源详情处理函数
async function handleSpecialSourceDetail(id, sourceCode, externalSignal) {
    try {
        // 构建详情页URL（使用配置中的detail URL而不是api URL）
        const detailUrl = `${API_SITES[sourceCode].detail}/index.php/vod/detail/id/${id}.html`;
        
        // 添加超时处理
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        linkAbortSignal(externalSignal, controller);
        
        // 添加鉴权参数到代理URL
        const proxiedUrl = await window.ProxyAuth?.addAuthToProxyUrl ? 
            await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(detailUrl)) :
            PROXY_URL + encodeURIComponent(detailUrl);
            
        // 获取详情页HTML
        const response = await fetch(proxiedUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            },
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            throw new Error(`详情页请求失败: ${response.status}`);
        }
        
        // 获取HTML内容
        const html = await response.text();
        
        // 根据不同源类型使用不同的正则表达式
        let matches = [];
        
        if (sourceCode === 'ffzy') {
            // 非凡影视使用特定的正则表达式
            const ffzyPattern = /\$(https?:\/\/[^"'\s]+?\/\d{8}\/\d+_[a-f0-9]+\/index\.m3u8)/g;
            matches = html.match(ffzyPattern) || [];
        }
        
        // 如果没有找到链接或者是其他源类型，尝试一个更通用的模式
        if (matches.length === 0) {
            const generalPattern = /\$(https?:\/\/[^"'\s]+?\.m3u8)/g;
            matches = html.match(generalPattern) || [];
        }
        // 去重处理，避免一个播放源多集显示
        matches = [...new Set(matches)];
        // 处理链接
        matches = matches.map(link => {
            link = link.substring(1, link.length);
            const parenIndex = link.indexOf('(');
            return parenIndex > 0 ? link.substring(0, parenIndex) : link;
        });
        
        // 提取可能存在的标题、简介等基本信息
        const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
        const titleText = titleMatch ? titleMatch[1].trim() : '';
        
        const descMatch = html.match(/<div[^>]*class=["']sketch["'][^>]*>([\s\S]*?)<\/div>/);
        const descText = descMatch ? descMatch[1].replace(/<[^>]+>/g, ' ').trim() : '';
        
        return JSON.stringify({
            code: 200,
            episodes: matches,
            detailUrl: detailUrl,
            videoInfo: {
                title: titleText,
                desc: descText,
                source_name: API_SITES[sourceCode].name,
                source_code: sourceCode
            }
        });
    } catch (error) {
        console.error(`${API_SITES[sourceCode].name}详情获取失败:`, error);
        throw error;
    }
}

// 采集单个源的最近更新：按 pg=1,2,3... 翻页，只留时间窗口（最近 3 天）内的条目。
// 某一页里最旧的条目已早于窗口 → 该源到此为止（不用再翻后面的页）。
// 同一批的页并发发出：上游单页要 0.5~3s，逐页串行会累加到十几秒，首页等不起。
async function collectLatestFromSource(source, signal) {
    const cutoff = Date.now() - LATEST_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const base = API_SITES[source].api;
    const collected = [];

    // 取一页，顺带返回「这一页里最旧条目的时间」
    const takePage = async (pg) => {
        const data = await fetchSourceData(`${base}?ac=videolist&pg=${pg}`, LATEST_PAGE_TIMEOUT_MS, signal);
        let oldest = 0;
        for (const item of data.list) {
            // vod_time 是本地时间字符串、无时区，parseVodTime 按浏览器本地时区解析
            const time = parseVodTime(item.vod_time);
            if (time && (!oldest || time < oldest)) oldest = time;
            if (!time || time < cutoff) continue;                 // 窗口外直接丢弃
            collected.push({
                ...item,
                source_name: API_SITES[source].name,
                source_code: source
            });
        }
        return oldest;
    };

    // 第 1 页单独取：多数源第 1 页就已经覆盖了 3 天窗口 → 一个源只花 1 个请求。
    // 原来是把 3 页一次性并行发出去、判断放在后面 → 典型情况白花 2 个请求
    // （每页都是几十~几百 KB 的全量列表，白白占带宽和连接槽）。
    let firstOldest;
    try {
        firstOldest = await takePage(1);
    } catch (error) {
        if (signal && signal.aborted) return collected;
        console.warn(`${source}源第 1 页获取失败:`, error);
        throw new Error(`${source}源第 1 页获取失败`);
    }
    // 该页最旧的条目已早于窗口 → 不用再翻后面的页
    if (firstOldest && firstOldest < cutoff) return collected;

    // 窗口还没覆盖 → 剩下的页并行取
    const rest = [];
    for (let pg = 2; pg <= LATEST_MAX_PAGES_PER_SOURCE && rest.length < LATEST_PAGE_BATCH; pg++) {
        rest.push(pg);
    }
    const results = await Promise.all(rest.map(async (pg) => {
        try {
            return { pg, oldest: await takePage(pg) };
        } catch (error) {
            if (signal && signal.aborted) return null;
            console.warn(`${source}源第 ${pg} 页获取失败:`, error);
            return null;
        }
    }));

    // 某页失败 → 该源就到此为止，用已取到的部分，不影响其它源
    for (const r of results) {
        if (!r) return collected;
        if (r.oldest && r.oldest < cutoff) break;
    }

    return collected;
}

// 最近更新的在途请求：用户开始搜索时让路。
// 背景加载若把浏览器到本站的连接占满，用户的搜索请求会排在队列里 —— 表现就是「点了搜索没反应」。
let latestAbortController = null;

function abortLatestUpdates() {
    if (latestAbortController) {
        try { latestAbortController.abort(); } catch (e) { /* 已经结束了 */ }
        latestAbortController = null;
    }
}

// 当前勾选的源（与搜索口径一致）
// 最近更新：各源分页拉取最近 3 天的更新列表（不带关键词），合并后交给聚合层分组
async function handleLatestUpdates() {
    // 「最近更新」覆盖**全部预设源**（不只是设置里勾选的那几个）——
    // 它是聚合首页的主体内容，勾选只决定"搜索"的范围。
    const availableSources = Object.keys(API_SITES).filter(key => key !== 'aggregated' && key !== 'custom');

    abortLatestUpdates();
    const controller = new AbortController();
    latestAbortController = controller;
    const signal = controller.signal;

    const resultsArray = [];
    // 限并发并行：25 个源**串行**拉要等好几分钟（每源最多 3 页、每页几秒），
    // 用户看到的是"首页一直空着"。改成 6 个源一批 → 十几秒级填满。
    // 上限 6 是留余量：用户的搜索请求要抢连接槽，不能被后台任务占满。
    const LATEST_CONCURRENCY = 6;
    let cursor = 0;
    const worker = async () => {
        while (cursor < availableSources.length) {
            if (signal.aborted) break;
            const source = availableSources[cursor++];
            // 连续失败的源在跳过窗口内不再发请求
            if (isSourceSkipped(source)) {
                console.info(`${source}源连续失败，暂时跳过`);
                resultsArray.push([]);
                continue;
            }

            try {
                const items = await collectLatestFromSource(source, signal);
                markSourceSucceeded(source);
                resultsArray.push(items);
            } catch (error) {
                if (signal.aborted) break;
                console.warn(`${source}源获取最新更新失败:`, error);
                markSourceFailed(source);
                resultsArray.push([]);
            }
        }
    };
    const workers = [];
    for (let i = 0; i < Math.min(LATEST_CONCURRENCY, availableSources.length); i++) {
        workers.push(worker());
    }
    await Promise.all(workers);
    if (latestAbortController === controller) latestAbortController = null;

    let allResults = [];
    resultsArray.forEach(results => {
        if (Array.isArray(results) && results.length > 0) {
            allResults = allResults.concat(results);
        }
    });

    // 按更新时间倒序（新的在前）；分组与「2 个及以上源」的过滤在渲染层做（复用 aggregate.js）
    allResults.sort(compareByVodTime);

    return JSON.stringify({
        code: 200,
        list: allResults
    });
}

// 拦截API请求
(function() {
    const originalFetch = window.fetch;
    
    window.fetch = async function(input, init) {
        const requestUrl = typeof input === 'string' ? new URL(input, window.location.origin) : input.url;
        
        if (requestUrl.pathname.startsWith('/api/')) {
            if (window.isPasswordProtected && window.isPasswordVerified) {
                if (window.isPasswordProtected() && !window.isPasswordVerified()) {
                    return new Response(JSON.stringify({ code: 401, msg: '请先输入访问密码' }), {
                        status: 401,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
            }
            try {
                const data = await handleApiRequest(requestUrl, init);
                return new Response(data, {
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*',
                    },
                });
            } catch (error) {
                return new Response(JSON.stringify({
                    code: 500,
                    msg: '服务器内部错误',
                }), {
                    status: 500,
                    headers: {
                        'Content-Type': 'application/json',
                    },
                });
            }
        }
        
        // 非API请求使用原始fetch
        return originalFetch.apply(this, arguments);
    };
})();

// ==== 最近更新区块（首页） ====
// 数据来自 /api/latest：各源最新列表合并、按 vod_time 倒序，分类取 Apple CMS 的 type_name
const LATEST_ALL_CATEGORY = '全部';
const LATEST_OTHER_CATEGORY = '其他';
// 时间窗口：最近 3 天（vod_time 是本地时间字符串、无时区，按浏览器本地时区与当前时间比较）
const LATEST_WINDOW_DAYS = 3;
// 单源翻页硬上限：防止个别源刷不出头把请求量打爆
const LATEST_MAX_PAGES_PER_SOURCE = 3;
// 每批发出的页数：同一批并发取，批内仍按页序处理（上游单页要 0.5~3s，逐页串行会累加到十几秒）
const LATEST_PAGE_BATCH = 4;
// 单页超时：上游单页 p99 约 3.2s。2.5s 时约四成页请求超时 → 对应源只能拿到第 1 页，
// 卡片数在 180~400 之间跳；放宽到 3s 后采集稳定在 2900~3600 条。
const LATEST_PAGE_TIMEOUT_MS = 3000;
// 只保留「2 个及以上源都有」的片：同一部片在多个源都更新过才算最近更新
const LATEST_MIN_SOURCES = 2;
// 卡片数上限（兜底）
const LATEST_MAX_ITEMS = 400;
// 无封面时的占位图（内联 SVG，不依赖外部图片服务）
const LATEST_PLACEHOLDER_IMAGE = "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='450'%3E%3Crect width='300' height='450' fill='%23111'/%3E%3Ctext x='150' y='225' fill='%23666' font-size='18' text-anchor='middle'%3E暂无封面%3C/text%3E%3C/svg%3E";

let latestItems = [];                          // 已加载的最近更新原始条目
let latestGroups = [];                         // 聚合后的分组（卡片数据源）
let latestCategory = LATEST_ALL_CATEGORY;      // 当前选中的分类
let latestLoading = false;                     // 防止重复请求
let latestInitialized = false;                 // 事件只绑定一次

// 开关是否开启（首次访问默认开启）
function isLatestEnabled() {
    let value = localStorage.getItem('latestEnabled');
    if (value === null) {
        localStorage.setItem('latestEnabled', 'true');
        value = 'true';
    }
    return value === 'true';
}

// 根据设置更新最近更新区块的显示状态
function updateLatestVisibility() {
    const latestArea = document.getElementById('latestArea');
    if (!latestArea) return;

    const resultsArea = document.getElementById('resultsArea');
    const isSearching = resultsArea && !resultsArea.classList.contains('hidden');

    // 只有在开启且没有搜索结果显示时才显示最近更新区块
    if (isLatestEnabled() && !isSearching) {
        latestArea.classList.remove('hidden');
        // 没有数据才重新拉；正在加载时不用重复拉 —— 加载完自己会渲染，
        // 否则开关会被 latestLoading 挡成「点了没反应」
        if (!latestItems.length && !latestLoading) {
            loadLatestUpdates();
        }
    } else {
        latestArea.classList.add('hidden');
    }
}

// 取分类名：同义不同名的分类先按别名表合并（别名表在 js/config.js，可随时调整）；
// 没有 type_name 的归入「其他」
function getLatestCategoryName(item) {
    const typeName = item && item.type_name ? String(item.type_name).trim() : '';
    if (!typeName) return LATEST_OTHER_CATEGORY;
    const aliases = window.CATEGORY_ALIASES || {};
    return aliases[typeName] || typeName;
}

// 分组的分类名：组内各源的分类名先过别名表，再取出现最多的那个。
// 同一部片在不同源常写不同分类名（「电影」/「动作片」），只取第一个会让分类筛选随机丢片。
function getLatestGroupCategory(group) {
    const counts = new Map();
    (group.items || []).forEach(item => {
        const name = getLatestCategoryName(item);
        if (name === LATEST_OTHER_CATEGORY) return;   // 「其他」不算票，出现得再多次也是兜底
        counts.set(name, (counts.get(name) || 0) + 1);
    });
    if (!counts.size) return LATEST_OTHER_CATEGORY;

    let best = LATEST_OTHER_CATEGORY;
    let bestCount = 0;
    counts.forEach((count, name) => {
        if (count > bestCount) {
            best = name;
            bestCount = count;
        }
    });
    return best;
}

// 分类标签列表：完全由实际加载到的数据生成，按卡片数降序，同数量按名称排
function getLatestCategories() {
    const counts = new Map();
    latestGroups.forEach(group => {
        const name = getLatestGroupCategory(group);
        counts.set(name, (counts.get(name) || 0) + 1);
    });
    return Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
        .map(entry => entry[0]);
}

// 渲染分类标签（默认选中「全部」）
function renderLatestTags() {
    const tagContainer = document.getElementById('latest-tags');
    if (!tagContainer) return;

    tagContainer.innerHTML = '';

    const addTag = (label, name) => {
        const btn = document.createElement('button');

        // 选中才上主色（原来是粉色选中 + 粉色 hover，和品牌色打架）
        btn.className = 'kt-chip' + (name === latestCategory ? ' on' : '');
        btn.setAttribute('aria-selected', name === latestCategory ? 'true' : 'false');
        btn.textContent = label;

        btn.addEventListener('click', () => {
            if (latestCategory === name) return;
            latestCategory = name;
            latestShown = LATEST_PAGE_SIZE;   // 换分类回到第一屏
            renderLatestTags();
            // 只重绘网格，不重新拉数据
            renderLatestCards(filterLatestGroups());
        });

        tagContainer.appendChild(btn);
    };

    addTag(LATEST_ALL_CATEGORY, LATEST_ALL_CATEGORY);
    getLatestCategories().forEach(name => addTag(name, name));
}

// 区块标题旁的加载状态提示（原来只在区块底部转圈，用户看不到）
function setLatestState(text) {
    const el = document.getElementById('latestState');
    if (el) el.textContent = text || '';
}

// 按当前分类过滤已加载的分组
function filterLatestGroups() {
    if (latestCategory === LATEST_ALL_CATEGORY) return latestGroups;
    return latestGroups.filter(group => getLatestGroupCategory(group) === latestCategory);
}

// 组内更新时间最新的一条（卡片封面上的时间取它）
function latestItemOf(group) {
    return (group.items || []).reduce((best, item) =>
        !best || parseVodTime(item.vod_time) > parseVodTime(best.vod_time) ? item : best, null);
}

// 最近更新的分组：复用 aggregate.js 的同名聚合，
// 只保留「2 个及以上源都有」的片，按源数倒序（源多的排前面），源数相同按最近更新时间倒序。
function buildLatestGroups(items) {
    return aggregateResults(items)
        .map(group => ({ group, time: parseVodTime((latestItemOf(group) || {}).vod_time) }))
        .filter(entry => entry.group.sourceCount >= LATEST_MIN_SOURCES)
        .sort((a, b) => b.group.sourceCount - a.group.sourceCount || b.time - a.time)
        .slice(0, LATEST_MAX_ITEMS)
        .map(entry => entry.group);
}

// 渲染最近更新卡片
// 最近更新一屏放多少张（剩下的点「显示更多」继续加）
const LATEST_PAGE_SIZE = 24;
let latestShown = LATEST_PAGE_SIZE;

function renderLatestCards(groups) {
    const container = document.getElementById('latest-results');
    if (!container) return;

    const fragment = document.createDocumentFragment();

    if (!groups || groups.length === 0) {
        const emptyEl = document.createElement('div');
        emptyEl.className = 'col-span-full text-center py-8';
        emptyEl.innerHTML = '<div style="color:var(--kt-rust)">暂无数据，请稍后重试</div>';
        fragment.appendChild(emptyEl);
    } else {
        groups.slice(0, latestShown).forEach(group => fragment.appendChild(createLatestCard(group)));
    }

    container.innerHTML = '';
    container.appendChild(fragment);

    // 「显示更多」
    const more = document.getElementById('latestMore');
    if (more) {
        const left = (groups ? groups.length : 0) - latestShown;
        more.innerHTML = left > 0
            ? '<button class="kt-btn" type="button" onclick="showMoreLatest()">显示更多（还有 ' + left + ' 部）</button>'
            : '';
    }
}

// 「显示更多」：一次再加一屏
function showMoreLatest() {
    latestShown += LATEST_PAGE_SIZE;
    renderLatestCards(filterLatestGroups());
}

// 构造单张卡片（动态文本全部走 textContent，避免 XSS / 破版）
function createLatestCard(group) {
    const latest = latestItemOf(group);
    const multi = group.sourceCount > 1;
    const title = group.name ? String(group.name) : '';
    // 封面显示该组最近一次的更新时间（组内最新的那条）
    const time = latest && latest.vod_time ? String(latest.vod_time) : '';
    const picValue = multi ? group.pic : (latest && latest.vod_pic);
    const pic = picValue ? String(picValue) : '';

    // 单源：点击填标题并搜索；多源：点击打开共用选源弹窗（跨源现搜 + 测速 + 选源）
    const activate = () => {
        if (multi) {
            if (typeof openSourcePicker !== 'function') return;
            openSourcePicker({
                title: group.name || title,
                // 选中后走现有的详情/播放流程（app.js 的 showDetails）
                onPick: entry => {
                    if (typeof showDetails === 'function') {
                        showDetails(entry.vodId, entry.name, entry.sourceKey, entry.pic || '');
                    }
                }
            });
        } else {
            fillAndSearchWithLatest(title);
        }
    };

    const card = document.createElement('div');
    card.className = 'kt-poster';

    const cover = document.createElement('div');
    cover.className = 'cover cursor-pointer';
    cover.addEventListener('click', activate);

    const img = document.createElement('img');
    img.className = 'w-full h-full object-cover transition-transform duration-500 hover:scale-110';
    img.loading = 'lazy';
    img.alt = title;
    if (pic) {
        img.src = pic;
        img.addEventListener('error', () => {
            img.onerror = null;
            img.src = LATEST_PLACEHOLDER_IMAGE;
            img.classList.add('object-contain');
        });
    } else {
        img.src = LATEST_PLACEHOLDER_IMAGE;
        img.classList.add('object-contain');
    }
    cover.appendChild(img);

    const overlay = document.createElement('div');
    overlay.className = 'veil';
    cover.appendChild(overlay);

    if (time) {
        // 只有一个角标（右下角）：之前「X 个来源」也在左下角，两条一起会挤在一起互相压字
        const badge = document.createElement('div');
        badge.className = 'kt-badge';
        badge.textContent = time;
        cover.appendChild(badge);
    }

    const info = document.createElement('div');
    info.className = 'name';
    info.title = title;
    info.textContent = title;
    info.addEventListener('click', activate);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const typeName = group.typeName || (latest && latest.type_name) || '';
    const year = group.year || (latest && latest.vod_year) || '';
    meta.textContent = [typeName, year].filter(Boolean).join(' · ');

    card.appendChild(cover);
    card.appendChild(info);
    if (meta.textContent) card.appendChild(meta);

    return card;
}

// 点击卡片：把标题填进搜索框并触发搜索
function fillAndSearchWithLatest(title) {
    if (!title) return;

    const input = document.getElementById('searchInput');
    if (!input) return;

    input.value = title;
    if (typeof search === 'function') {
        search();
    }
}


// 加载最近更新数据并渲染标签与卡片
async function loadLatestUpdates() {
    if (latestLoading) return;
    // 密码门未验证时请求会被拦截（拿不到数据），等验证通过后 initLatestUpdates() 会重新触发
    if (window.isPasswordProtected && window.isPasswordProtected() && !window.isPasswordVerified()) return;
    latestLoading = true;
    setLatestState('正在加载最近更新…');

    const container = document.getElementById('latest-results');
    if (container) {
        container.innerHTML = `
            <div class="col-span-full text-center py-8">
                <div class="w-6 h-6 border-2 border-pink-500 border-t-transparent rounded-full animate-spin inline-block"></div>
                <span class="text-pink-500 ml-4">加载中...</span>
            </div>
        `;
    }

    try {
        const response = await fetch('/api/latest');
        const data = await response.json();

        if (!data || data.code !== 200) {
            throw new Error((data && data.msg) || '获取失败');
        }

        const items = Array.isArray(data.list) ? data.list : [];
        latestItems = typeof applyYellowFilter === 'function' ? applyYellowFilter(items) : items;
        // 按「片名+年份」聚合成组，只留 2 个及以上源都有的片，源多的排前面
        latestGroups = buildLatestGroups(latestItems);

        // 刷新后若原分类已不存在，回到「全部」
        if (latestCategory !== LATEST_ALL_CATEGORY && !getLatestCategories().includes(latestCategory)) {
            latestCategory = LATEST_ALL_CATEGORY;
        }

        renderLatestTags();
        renderLatestCards(filterLatestGroups());
        setLatestState('');
        // 数据到了就把区块亮出来（加载期间可能已被搜索结果顶掉）
        updateLatestVisibility();
    } catch (error) {
        console.error('最近更新获取失败:', error);
        setLatestState('加载失败，点「刷新」重试');
        if (container) {
            container.innerHTML = `
                <div class="col-span-full text-center py-8">
                    <div class="text-red-400">❌ 获取最近更新失败，请稍后重试</div>
                </div>
            `;
        }
        showToast('最近更新获取失败，请稍后重试', 'error');
    } finally {
        latestLoading = false;
    }
}

// 已通过密码门的用户不会再看到密码弹窗 → hidePasswordModal() 不会被调用，
// 「最近更新」就永远不初始化（首页空着）。这里补一次初始化。
document.addEventListener('DOMContentLoaded', function () {
    if (typeof initLatestUpdates !== 'function') return;
    if (window.isPasswordProtected && window.isPasswordVerified && window.isPasswordVerified()) {
        initLatestUpdates();
    }
});

// 初始化最近更新区块：开关状态 + 刷新按钮 + 自动加载
function initLatestUpdates() {
    if (!latestInitialized) {
        latestInitialized = true;

        const toggle = document.getElementById('latestToggle');
        if (toggle) {
            const isEnabled = isLatestEnabled();
            toggle.checked = isEnabled;

            const toggleBg = toggle.nextElementSibling;
            const toggleDot = toggleBg.nextElementSibling;
            if (isEnabled) {
                toggleBg.classList.add('bg-pink-600');
                toggleDot.classList.add('translate-x-6');
            }

            toggle.addEventListener('change', function (e) {
                const isChecked = e.target.checked;
                localStorage.setItem('latestEnabled', isChecked);

                if (isChecked) {
                    toggleBg.classList.add('bg-pink-600');
                    toggleDot.classList.add('translate-x-6');
                } else {
                    toggleBg.classList.remove('bg-pink-600');
                    toggleDot.classList.remove('translate-x-6');
                }

                updateLatestVisibility();
            });
        }

        const refreshBtn = document.getElementById('latest-refresh');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => loadLatestUpdates());
        }
    }

    updateLatestVisibility();
}

document.addEventListener('DOMContentLoaded', initLatestUpdates);

async function testSiteAvailability(apiUrl) {
    try {
        // 使用更简单的测试查询
        const response = await fetch('/api/search?wd=test&customApi=' + encodeURIComponent(apiUrl), {
            // 添加超时
            signal: AbortSignal.timeout(5000)
        });
        
        // 检查响应状态
        if (!response.ok) {
            return false;
        }
        
        const data = await response.json();
        
        // 检查API响应的有效性
        return data && data.code !== 400 && Array.isArray(data.list);
    } catch (error) {
        console.error('站点可用性测试失败:', error);
        return false;
    }
}
