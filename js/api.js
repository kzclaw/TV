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

// 改进的API请求处理函数
async function handleApiRequest(url) {
    const customApi = url.searchParams.get('customApi') || '';
    const customDetail = url.searchParams.get('customDetail') || '';
    const source = url.searchParams.get('source') || 'heimuer';
    
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
                return await handleSpecialSourceDetail(id, sourceCode);
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
async function handleSpecialSourceDetail(id, sourceCode) {
    try {
        // 构建详情页URL（使用配置中的detail URL而不是api URL）
        const detailUrl = `${API_SITES[sourceCode].detail}/index.php/vod/detail/id/${id}.html`;
        
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

// 最近更新：各源拉取最新列表（不带关键词），合并后按更新时间倒序
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
            const apiUrl = `${API_SITES[source].api}?ac=videolist`;
            const data = await fetchSourceData(apiUrl, AGGREGATED_SEARCH_CONFIG.timeout);
            markSourceSucceeded(source);

            return data.list.map(item => ({
                ...item,
                source_name: API_SITES[source].name,
                source_code: source
            }));
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

    // 按更新时间倒序（新的在前）
    allResults.sort(compareByVodTime);

    return JSON.stringify({
        code: 200,
        list: allResults.slice(0, 200)
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
                const data = await handleApiRequest(requestUrl);
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
// 无封面时的占位图（内联 SVG，不依赖外部图片服务）
const LATEST_PLACEHOLDER_IMAGE = "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='450'%3E%3Crect width='300' height='450' fill='%23111'/%3E%3Ctext x='150' y='225' fill='%23666' font-size='18' text-anchor='middle'%3E暂无封面%3C/text%3E%3C/svg%3E";

let latestItems = [];                          // 已加载的最近更新数据
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

// 取分类名：没有 type_name 的归入「其他」
function getLatestCategoryName(item) {
    const typeName = item && item.type_name ? String(item.type_name).trim() : '';
    return typeName || LATEST_OTHER_CATEGORY;
}

// 分类标签列表：完全由实际加载到的数据生成，按条目数降序，同数量按名称排
function getLatestCategories() {
    const counts = new Map();
    latestItems.forEach(item => {
        const name = getLatestCategoryName(item);
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
            renderLatestCards(filterLatestItems());
        });

        tagContainer.appendChild(btn);
    };

    addTag(LATEST_ALL_CATEGORY, LATEST_ALL_CATEGORY);
    getLatestCategories().forEach(name => addTag(name, name));
}

// 按当前分类过滤已加载的列表
function filterLatestItems() {
    if (latestCategory === LATEST_ALL_CATEGORY) return latestItems;
    return latestItems.filter(item => getLatestCategoryName(item) === latestCategory);
}

// 渲染最近更新卡片
function renderLatestCards(items) {
    const container = document.getElementById('latest-results');
    if (!container) return;

    const fragment = document.createDocumentFragment();

    if (!items || items.length === 0) {
        const emptyEl = document.createElement('div');
        emptyEl.className = 'col-span-full text-center py-8';
        emptyEl.innerHTML = '<div class="text-pink-500">❌ 暂无数据，请稍后重试</div>';
        fragment.appendChild(emptyEl);
    } else {
        items.forEach(item => fragment.appendChild(createLatestCard(item)));
    }

    container.innerHTML = '';
    container.appendChild(fragment);
}

// 构造单张卡片（动态文本全部走 textContent，避免 XSS / 破版）
function createLatestCard(item) {
    const title = item.vod_name ? String(item.vod_name) : '';
    const source = item.source_name ? String(item.source_name) : '';
    const time = item.vod_time ? String(item.vod_time) : '';
    const pic = item.vod_pic ? String(item.vod_pic) : '';

    const card = document.createElement('div');
    card.className = 'bg-[#111] hover:bg-[#222] transition-all duration-300 rounded-lg overflow-hidden flex flex-col transform hover:scale-105 shadow-md hover:shadow-lg';

    const cover = document.createElement('div');
    cover.className = 'relative w-full aspect-[2/3] overflow-hidden cursor-pointer';
    cover.addEventListener('click', () => fillAndSearchWithLatest(title));

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

    if (source) {
        const badge = document.createElement('div');
        badge.className = 'absolute bottom-2 left-2 bg-black/70 text-white text-xs px-2 py-1 rounded-sm';
        badge.textContent = source;
        cover.appendChild(badge);
    }
    if (time) {
        const badge = document.createElement('div');
        badge.className = 'absolute bottom-2 right-2 bg-black/70 text-white text-xs px-2 py-1 rounded-sm';
        badge.textContent = time;
        cover.appendChild(badge);
    }

    const info = document.createElement('div');
    info.className = 'p-2 text-center bg-[#111]';

    const titleBtn = document.createElement('button');
    titleBtn.className = 'text-sm font-medium text-white truncate w-full hover:text-pink-400 transition';
    titleBtn.title = title;
    titleBtn.textContent = title;
    titleBtn.addEventListener('click', () => fillAndSearchWithLatest(title));
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

        // 刷新后若原分类已不存在，回到「全部」
        if (latestCategory !== LATEST_ALL_CATEGORY && !getLatestCategories().includes(latestCategory)) {
            latestCategory = LATEST_ALL_CATEGORY;
        }

        renderLatestTags();
        renderLatestCards(filterLatestItems());
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
