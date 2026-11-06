// ==== 源健康（熔断）====
// 借鉴上游：连续失败的源先跳过一段时间，避免每次搜索都白等超时
const SOURCE_HEALTH_KEY = 'kzTvSourceHealthV1'; // 带版本前缀，避免与旧缓存冲突
const SOURCE_HEALTH_FAIL_LIMIT = 2;            // 连续失败次数达到该值即跳过
const SOURCE_HEALTH_SKIP_MS = 30 * 60 * 1000;  // 跳过时长 30 分钟

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

// 连续失败达到阈值且仍在跳过窗口内 → 该源暂时不发请求
function isSourceSkipped(sourceKey) {
    const record = getSourceHealthStore()[sourceKey];
    if (!record || record.count < SOURCE_HEALTH_FAIL_LIMIT) return false;
    return Date.now() - (record.lastFailAt || 0) < SOURCE_HEALTH_SKIP_MS;
}

function markSourceFailed(sourceKey) {
    const store = getSourceHealthStore();
    const record = store[sourceKey] || { count: 0 };
    store[sourceKey] = { count: (record.count || 0) + 1, lastFailAt: Date.now() };
    saveSourceHealthStore(store);
}

// 成功一次即清零
function markSourceSucceeded(sourceKey) {
    const store = getSourceHealthStore();
    if (!store[sourceKey]) return;
    store[sourceKey] = { count: 0, lastFailAt: 0, lastOkAt: Date.now() };
    saveSourceHealthStore(store);
}

function getSkippedSources() {
    const store = getSourceHealthStore();
    return Object.keys(store).filter(key => isSourceSkipped(key));
}

window.SourceHealth = {
    isSourceSkipped,
    markSourceFailed,
    markSourceSucceeded,
    getSkippedSources
};

// 解析 vod_time：兼容 "2026-11-05 18:22:07" 与 "2026-11-05"；无法解析返回 0（排序时排最后）
function parseVodTime(value) {
    if (!value || typeof value !== 'string') return 0;
    const matched = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (!matched) return 0;
    const [, year, month, day, hour, minute, second] = matched;
    const time = new Date(+year, +month - 1, +day, +(hour || 0), +(minute || 0), +(second || 0)).getTime();
    return Number.isFinite(time) ? time : 0;
}

// 按更新时间倒序（新的在前）；时间相同或无法解析时按名称、来源排序
function compareByVodTime(a, b) {
    const timeDiff = parseVodTime(b.vod_time) - parseVodTime(a.vod_time);
    if (timeDiff !== 0) return timeDiff;

    const nameCompare = (a.vod_name || '').localeCompare(b.vod_name || '');
    if (nameCompare !== 0) return nameCompare;

    return (a.source_name || '').localeCompare(b.source_name || '');
}

// 采集源请求：统一走站点代理 + 超时控制；失败抛异常，便于统计熔断
async function fetchSourceData(apiUrl, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

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

// 处理聚合搜索
async function handleAggregatedSearch(searchQuery) {
    // 获取可用的API源列表（排除aggregated和custom）
    const availableSources = Object.keys(API_SITES).filter(key => 
        key !== 'aggregated' && key !== 'custom'
    );
    
    if (availableSources.length === 0) {
        throw new Error('没有可用的API源');
    }
    
    // 创建所有API源的搜索请求
    const searchPromises = availableSources.map(async (source) => {
        // 连续失败的源在跳过窗口内不再发请求
        if (isSourceSkipped(source)) {
            console.info(`${source}源连续失败，暂时跳过`);
            return [];
        }

        try {
            const apiUrl = `${API_SITES[source].api}${API_CONFIG.search.path}${encodeURIComponent(searchQuery)}`;
            const data = await fetchSourceData(apiUrl, AGGREGATED_SEARCH_CONFIG.timeout);
            markSourceSucceeded(source);

            // 为搜索结果添加源信息
            return data.list.map(item => ({
                ...item,
                source_name: API_SITES[source].name,
                source_code: source
            }));
        } catch (error) {
            console.warn(`${source}源搜索失败:`, error);
            markSourceFailed(source);
            return []; // 返回空数组表示该源搜索失败
        }
    });
    
    try {
        // 并行执行所有搜索请求
        const resultsArray = await Promise.all(searchPromises);
        
        // 合并所有结果
        let allResults = [];
        resultsArray.forEach(results => {
            if (Array.isArray(results) && results.length > 0) {
                allResults = allResults.concat(results);
            }
        });
        
        // 如果没有搜索结果，返回空结果
        if (allResults.length === 0) {
            return JSON.stringify({
                code: 200,
                list: [],
                msg: '所有源均无搜索结果'
            });
        }
        
        // 去重（根据vod_id和source_code组合）
        const uniqueResults = [];
        const seen = new Set();
        
        allResults.forEach(item => {
            const key = `${item.source_code}_${item.vod_id}`;
            if (!seen.has(key)) {
                seen.add(key);
                uniqueResults.push(item);
            }
        });
        
        // 按更新时间倒序（新的在前），名称/来源仅作次要排序
        uniqueResults.sort(compareByVodTime);
        
        return JSON.stringify({
            code: 200,
            list: uniqueResults,
        });
    } catch (error) {
        console.error('聚合搜索处理错误:', error);
        return JSON.stringify({
            code: 400,
            msg: '聚合搜索处理失败: ' + error.message,
            list: []
        });
    }
}

// 采集单个源的最近更新：按 pg=1,2,3... 翻页，只留时间窗口（最近 3 天）内的条目。
// 某一页里最旧的条目已早于窗口 → 该源到此为止（不用再翻后面的页）。
// 同一批的页并发发出：上游单页要 0.5~3s，逐页串行会累加到十几秒，首页等不起。
async function collectLatestFromSource(source) {
    const cutoff = Date.now() - LATEST_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const base = API_SITES[source].api;
    const collected = [];

    for (let first = 1; first <= LATEST_MAX_PAGES_PER_SOURCE; first += LATEST_PAGE_BATCH) {
        const batch = [];
        for (let pg = first; pg < first + LATEST_PAGE_BATCH && pg <= LATEST_MAX_PAGES_PER_SOURCE; pg++) {
            batch.push(fetchSourceData(`${base}?ac=videolist&pg=${pg}`, LATEST_PAGE_TIMEOUT_MS)
                .catch(error => {
                    console.warn(`${source}源第 ${pg} 页获取失败:`, error);
                    return null;
                }));
        }
        const pages = await Promise.all(batch);

        for (let i = 0; i < pages.length; i++) {
            const data = pages[i];
            const pg = first + i;
            // 某页失败 → 该源就到此为止，用已取到的部分，不影响其它源
            if (!data) {
                if (pg === first) throw new Error(`${source}源第 ${pg} 页获取失败`);
                return collected;
            }

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

            // 该页最旧的条目已早于窗口 → 不用再翻后面的页
            if (oldest && oldest < cutoff) return collected;
        }
    }

    return collected;
}

// 最近更新：各源分页拉取最近 3 天的更新列表（不带关键词），合并后交给聚合层分组
async function handleLatestUpdates() {
    const availableSources = Object.keys(API_SITES).filter(key =>
        key !== 'aggregated' && key !== 'custom'
    );

    const resultsArray = await Promise.all(availableSources.map(async (source) => {
        // 连续失败的源在跳过窗口内不再发请求
        if (isSourceSkipped(source)) {
            console.info(`${source}源连续失败，暂时跳过`);
            return [];
        }

        try {
            const items = await collectLatestFromSource(source);
            markSourceSucceeded(source);
            return items;
        } catch (error) {
            console.warn(`${source}源获取最新更新失败:`, error);
            markSourceFailed(source);
            return [];
        }
    }));

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

// 处理多个自定义API源的聚合搜索
async function handleMultipleCustomSearch(searchQuery, customApiUrls) {
    // 解析自定义API列表
    const apiUrls = customApiUrls.split(CUSTOM_API_CONFIG.separator)
        .map(url => url.trim())
        .filter(url => url.length > 0 && /^https?:\/\//.test(url))
        .slice(0, CUSTOM_API_CONFIG.maxSources);
    
    if (apiUrls.length === 0) {
        throw new Error('没有提供有效的自定义API地址');
    }
    
    // 为每个API创建搜索请求
    const searchPromises = apiUrls.map(async (apiUrl, index) => {
        try {
            const fullUrl = `${apiUrl}${API_CONFIG.search.path}${encodeURIComponent(searchQuery)}`;
            
            // 使用Promise.race添加超时处理
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error(`自定义API ${index+1} 搜索超时`)), 8000)
            );
            
            // 添加鉴权参数到代理URL
            const proxiedUrl = await window.ProxyAuth?.addAuthToProxyUrl ? 
                await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(fullUrl)) :
                PROXY_URL + encodeURIComponent(fullUrl);
            
            const fetchPromise = fetch(proxiedUrl, {
                headers: API_CONFIG.search.headers
            });
            
            const response = await Promise.race([fetchPromise, timeoutPromise]);
            
            if (!response.ok) {
                throw new Error(`自定义API ${index+1} 请求失败: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (!data || !Array.isArray(data.list)) {
                throw new Error(`自定义API ${index+1} 返回的数据格式无效`);
            }
            
            // 为搜索结果添加源信息
            const results = data.list.map(item => ({
                ...item,
                source_name: `${CUSTOM_API_CONFIG.namePrefix}${index+1}`,
                source_code: 'custom',
                api_url: apiUrl // 保存API URL以便详情获取
            }));
            
            return results;
        } catch (error) {
            console.warn(`自定义API ${index+1} 搜索失败:`, error);
            return []; // 返回空数组表示该源搜索失败
        }
    });
    
    try {
        // 并行执行所有搜索请求
        const resultsArray = await Promise.all(searchPromises);
        
        // 合并所有结果
        let allResults = [];
        resultsArray.forEach(results => {
            if (Array.isArray(results) && results.length > 0) {
                allResults = allResults.concat(results);
            }
        });
        
        // 如果没有搜索结果，返回空结果
        if (allResults.length === 0) {
            return JSON.stringify({
                code: 200,
                list: [],
                msg: '所有自定义API源均无搜索结果'
            });
        }
        
        // 去重（根据vod_id和api_url组合）
        const uniqueResults = [];
        const seen = new Set();
        
        allResults.forEach(item => {
            const key = `${item.api_url || ''}_${item.vod_id}`;
            if (!seen.has(key)) {
                seen.add(key);
                uniqueResults.push(item);
            }
        });
        
        return JSON.stringify({
            code: 200,
            list: uniqueResults,
        });
    } catch (error) {
        console.error('自定义API聚合搜索处理错误:', error);
        return JSON.stringify({
            code: 400,
            msg: '自定义API聚合搜索处理失败: ' + error.message,
            list: []
        });
    }
}

// 拦截API请求
(function() {
    const originalFetch = window.fetch;
    
    window.fetch = async function(input, init) {
        const requestUrl = typeof input === 'string' ? new URL(input, window.location.origin) : input.url;
        
        if (requestUrl.pathname.startsWith('/api/')) {
            if (window.isPasswordProtected && window.isPasswordVerified) {
                if (window.isPasswordProtected() && !window.isPasswordVerified()) {
                    return;
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
const LATEST_MAX_PAGES_PER_SOURCE = 8;
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
        // 没有数据时自动加载一次
        if (!latestItems.length) {
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

        let btnClass = 'py-1.5 px-3.5 rounded text-sm font-medium transition-all duration-300 border ';
        if (name === latestCategory) {
            btnClass += 'bg-pink-600 text-white shadow-md border-white';
        } else {
            btnClass += 'bg-[#1a1a1a] text-gray-300 hover:bg-pink-700 hover:text-white border-[#333] hover:border-white';
        }
        btn.className = btnClass;
        btn.textContent = label;

        btn.addEventListener('click', () => {
            if (latestCategory === name) return;
            latestCategory = name;
            renderLatestTags();
            // 只重绘网格，不重新拉数据
            renderLatestCards(filterLatestGroups());
        });

        tagContainer.appendChild(btn);
    };

    addTag(LATEST_ALL_CATEGORY, LATEST_ALL_CATEGORY);
    getLatestCategories().forEach(name => addTag(name, name));
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
function renderLatestCards(groups) {
    const container = document.getElementById('latest-results');
    if (!container) return;

    const fragment = document.createDocumentFragment();

    if (!groups || groups.length === 0) {
        const emptyEl = document.createElement('div');
        emptyEl.className = 'col-span-full text-center py-8';
        emptyEl.innerHTML = '<div class="text-pink-500">❌ 暂无数据，请稍后重试</div>';
        fragment.appendChild(emptyEl);
    } else {
        groups.forEach(group => fragment.appendChild(createLatestCard(group)));
    }

    container.innerHTML = '';
    container.appendChild(fragment);
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

    // 单源：点击填标题并搜索；多源：点击打开多源弹窗（测速 + 选源）
    const activate = () => {
        if (multi) {
            openSourceModal(group);
        } else {
            fillAndSearchWithLatest(title);
        }
    };

    const card = document.createElement('div');
    card.className = 'bg-[#111] hover:bg-[#222] transition-all duration-300 rounded-lg overflow-hidden flex flex-col transform hover:scale-105 shadow-md hover:shadow-lg';

    const cover = document.createElement('div');
    cover.className = 'relative w-full aspect-[2/3] overflow-hidden cursor-pointer';
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
    overlay.className = 'absolute inset-0 bg-gradient-to-t from-black to-transparent opacity-60';
    cover.appendChild(overlay);

    if (time) {
        // 只有一个角标（右下角）：之前「X 个来源」也在左下角，两条一起会挤在一起互相压字
        const badge = document.createElement('div');
        badge.className = 'absolute bottom-1.5 right-1.5 bg-black/75 text-white text-[10px] px-1.5 py-0.5 rounded-sm whitespace-nowrap';
        badge.textContent = time;
        cover.appendChild(badge);
    }

    const info = document.createElement('div');
    info.className = 'p-2 text-center bg-[#111]';

    const titleBtn = document.createElement('button');
    titleBtn.className = 'text-sm font-medium text-white truncate w-full hover:text-pink-400 transition';
    titleBtn.title = title;
    titleBtn.textContent = title;
    titleBtn.addEventListener('click', activate);
    info.appendChild(titleBtn);

    card.appendChild(cover);
    card.appendChild(info);

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

// ==== 多源选择弹窗 ====
// 最近更新的卡片点开：列出该片的各来源 → 并发测速（用各源详情接口的耗时当速度指标）
// → 按速度从快到慢排 → 选中一个源后走现有的播放流程。
// 样式与交互照播放器页的「切换资源」模块（封面卡 + 右上角速度角标 + 选中源详情）。
const sourceModalState = {
    controller: null,       // 关闭弹窗时用它中止在途测速请求
    entries: [],            // 各来源：测速结果 + DOM 引用
    selectedKey: '',        // 选中态绑稳定标识（源key_片id），不用数组下标
    bodyOverflow: ''
};

// 来源在弹窗里的稳定标识：测速结果会重排，绑下标会指错源
function sourceEntryKey(entry) {
    return `${entry.sourceCode}_${entry.vodId}`;
}

// 组内同一源只留一条（取更新时间最新的那条）
function latestPerSource(items) {
    const bySource = new Map();
    (items || []).forEach(item => {
        if (!item || !item.source_code) return;
        const prev = bySource.get(item.source_code);
        if (!prev || parseVodTime(item.vod_time) > parseVodTime(prev.vod_time)) {
            bySource.set(item.source_code, item);
        }
    });
    return Array.from(bySource.values());
}

// 单个来源的卡片（与播放器页「切换资源」的卡片同款）
function sourceEntryHtml(entry) {
    const key = sourceEntryKey(entry);
    return `
        <div class="relative cursor-pointer hover:scale-105 transition-transform" data-source-key="${escapeText(key)}">
            <div class="aspect-[2/3] rounded-lg overflow-hidden bg-gray-800 relative">
                <img src="${escapeText(entry.pic) || LATEST_PLACEHOLDER_IMAGE}" alt="${escapeText(entry.name)}"
                     loading="lazy" class="w-full h-full object-cover">
                <div class="absolute top-1 right-1 speed-badge bg-black bg-opacity-75" data-source-badge>
                    <span class="speed-indicator">测速中</span>
                </div>
            </div>
            <div class="mt-2">
                <div class="text-xs font-medium text-gray-200 truncate" title="${escapeText(entry.sourceName)}">${escapeText(entry.sourceName)}</div>
                <div class="text-[10px] text-gray-500 truncate" data-source-note></div>
            </div>
        </div>`;
}

// 打开多源弹窗
function openSourceModal(group) {
    const modal = document.getElementById('sourceModal');
    const content = document.getElementById('sourceModalContent');
    const title = document.getElementById('sourceModalTitle');
    if (!modal || !content) return;

    closeSourceModal();

    sourceModalState.entries = latestPerSource(group.items).map(item => ({
        sourceCode: item.source_code,
        sourceName: item.source_name || '',
        vodId: String(item.vod_id || ''),
        name: item.vod_name || group.name || '',
        pic: item.vod_pic || '',
        speed: -1,
        error: '',
        episodes: 0,
        pending: true,
        card: null,
        badge: null,
        note: null
    }));
    sourceModalState.selectedKey = '';

    if (title) title.textContent = group.name || '';

    content.innerHTML = `
        <div id="sourceModalGrid" class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            ${sourceModalState.entries.map(sourceEntryHtml).join('')}
        </div>
        <div id="sourceModalDetail" class="mt-4"></div>`;

    content.querySelectorAll('[data-source-key]').forEach(card => {
        const key = card.getAttribute('data-source-key');
        const entry = sourceModalState.entries.find(item => sourceEntryKey(item) === key);
        if (!entry) return;
        entry.card = card;
        entry.badge = card.querySelector('[data-source-badge]');
        entry.note = card.querySelector('[data-source-note]');
        const img = card.querySelector('img');
        if (img) {
            img.addEventListener('error', () => {
                img.onerror = null;
                img.src = LATEST_PLACEHOLDER_IMAGE;
                img.classList.add('object-contain');
            });
        }
        card.addEventListener('click', () => selectSourceEntry(key));
    });

    modal.classList.remove('hidden');
    sourceModalState.bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // 并发测速：各源详情接口的耗时当速度指标
    // （上游用的是服务端 /api/quality；我们是静态站，改成前端直接请求各源的详情接口）
    const controller = new AbortController();
    sourceModalState.controller = controller;
    Promise.all(sourceModalState.entries.map(entry => probeSourceEntry(entry, controller.signal)))
        .then(() => finishSourceModal())
        .catch(() => finishSourceModal());
}

// 关闭弹窗：中止在途测速请求（上游特意做了这条：否则关了弹窗请求还在跑）
function closeSourceModal() {
    const modal = document.getElementById('sourceModal');
    if (sourceModalState.controller) {
        sourceModalState.controller.abort();
        sourceModalState.controller = null;
    }
    sourceModalState.entries = [];
    sourceModalState.selectedKey = '';
    if (modal) modal.classList.add('hidden');
    document.body.style.overflow = sourceModalState.bodyOverflow;
    sourceModalState.bodyOverflow = '';
}

// 测速一个来源：请求该源的详情接口，用耗时当速度指标
async function probeSourceEntry(entry, signal) {
    const started = performance.now();
    try {
        const response = await fetch(
            `/api/detail?id=${encodeURIComponent(entry.vodId)}&source=${encodeURIComponent(entry.sourceCode)}&_t=${Date.now()}`,
            { signal }
        );
        const data = await response.json();
        if (signal.aborted) return;

        if (!data || data.code !== 200 || !Array.isArray(data.episodes) || !data.episodes.length) {
            entry.error = (data && data.msg) || '无可用播放资源';
        } else {
            entry.speed = Math.round(performance.now() - started);
            entry.episodes = data.episodes.length;
        }
    } catch (error) {
        if (signal.aborted) return;
        entry.error = (error && error.name === 'AbortError') ? '已取消' : ((error && error.message) || '测速失败');
    }
    entry.pending = false;
    refreshSourceEntry(entry);
}

// 回填一个来源的测速结果（只改角标，不重建卡片：重建会让封面重复请求）
function refreshSourceEntry(entry) {
    if (entry.badge) {
        entry.badge.innerHTML = entry.pending
            ? '<span class="speed-indicator">测速中</span>'
            : formatSpeedDisplay(entry.speed >= 0
                ? { speed: entry.speed }
                : { speed: -1, error: '失败' });
    }
    if (entry.note) {
        entry.note.textContent = entry.pending ? '' : (entry.speed >= 0
            ? `${entry.episodes} 集`
            : (entry.error || '测速失败'));
        entry.note.title = entry.note.textContent;
        entry.note.className = entry.pending || entry.speed >= 0
            ? 'text-[10px] text-gray-500 truncate'
            : 'text-[10px] text-red-400 truncate';
    }
}

// 测速结束：按速度重排（失败的排最后），默认选中最快的可用源
function finishSourceModal() {
    if (!sourceModalState.controller) return;      // 弹窗已关闭

    const entries = sourceModalState.entries;
    entries.forEach(entry => {
        entry.pending = false;
        refreshSourceEntry(entry);
    });

    const grid = document.getElementById('sourceModalGrid');
    if (grid) {
        [...entries]
            .sort((a, b) => {
                const speedA = a.speed >= 0 ? a.speed : Number.MAX_SAFE_INTEGER;
                const speedB = b.speed >= 0 ? b.speed : Number.MAX_SAFE_INTEGER;
                return speedA - speedB;
            })
            .forEach(entry => { if (entry.card) grid.appendChild(entry.card); });
    }

    const summary = document.getElementById('sourceModalSummary');
    if (summary) {
        const ok = entries.filter(entry => entry.speed >= 0).length;
        summary.textContent = `来源 ${entries.length} · 可用 ${ok}`;
    }

    if (!sourceModalState.selectedKey) {
        const fastest = entries.filter(entry => entry.speed >= 0).sort((a, b) => a.speed - b.speed)[0] || entries[0];
        if (fastest) selectSourceEntry(sourceEntryKey(fastest));
    }
}

// 选中某个来源（绑稳定标识，测速重排后仍然指向同一个源）
function selectSourceEntry(key) {
    sourceModalState.selectedKey = key;
    sourceModalState.entries.forEach(entry => {
        if (!entry.card) return;
        const active = sourceEntryKey(entry) === key;
        entry.card.classList.toggle('ring-2', active);
        entry.card.classList.toggle('ring-pink-500', active);
    });
    renderSourceModalDetail();
}

// 选中源的详情与播放入口
function renderSourceModalDetail() {
    const detail = document.getElementById('sourceModalDetail');
    if (!detail) return;

    const entry = sourceModalState.entries.find(item => sourceEntryKey(item) === sourceModalState.selectedKey);
    if (!entry) {
        detail.innerHTML = '<div class="text-center py-4 text-gray-500 text-sm">选择一个来源</div>';
        return;
    }

    detail.innerHTML = `
        <div class="flex items-start gap-3 p-3 bg-[#1a1a1a] rounded-lg">
            <img src="${escapeText(entry.pic) || LATEST_PLACEHOLDER_IMAGE}" alt=""
                 class="w-16 aspect-[2/3] object-cover rounded shrink-0">
            <div class="flex-1 min-w-0">
                <div class="text-sm font-semibold text-white truncate" title="${escapeText(entry.sourceName)}">${escapeText(entry.sourceName)}</div>
                <div class="mt-1 text-xs text-gray-400">
                    ${entry.speed >= 0 ? `速度 ${entry.speed}ms` : `速度：${escapeText(entry.error || '不可用')}`}
                    ${entry.episodes ? ` · ${entry.episodes} 集` : ''}
                </div>
                <button id="sourceModalPlayBtn" class="mt-2 px-3 py-1.5 bg-pink-600 hover:bg-pink-700 text-white rounded text-sm">
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
    const playBtn = document.getElementById('sourceModalPlayBtn');
    if (playBtn) playBtn.addEventListener('click', () => playFromSourceModal(entry));
}

// 选中源后走现有的播放流程（详情 + 剧集在 app.js 的 showDetails 里，不另写一套）
function playFromSourceModal(entry) {
    closeSourceModal();
    if (typeof showDetails === 'function') {
        showDetails(entry.vodId, entry.name, entry.sourceCode);
    }
}

// 弹窗基础交互：点遮罩关闭、Esc 关闭（只绑一次）
function initSourceModal() {
    const modal = document.getElementById('sourceModal');
    if (!modal) return;

    modal.addEventListener('click', event => {
        if (event.target === modal) closeSourceModal();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') closeSourceModal();
    });
}
document.addEventListener('DOMContentLoaded', initSourceModal);

// 加载最近更新数据并渲染标签与卡片
async function loadLatestUpdates() {
    if (latestLoading) return;
    latestLoading = true;

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
    } catch (error) {
        console.error('最近更新获取失败:', error);
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
