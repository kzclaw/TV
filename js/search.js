// 单源搜索：返回 { list, failed, sourceName, reason }
// - list：命中的结果（跨源合并由调用方做）
// - failed：该源这次没响应（超时/请求失败/熔断跳过），供页面提示「N 个源没响应」
// 单源总死线 API_CONFIG.search.sourceTimeout（默认 10 秒）：到点整体放弃该源，
// 而不是只放弃某一页——慢源会把整次搜索拖到十几秒。
async function searchByAPIAndKeyWord(apiId, query, signal) {
    const outcome = { list: [], failed: false, sourceName: '', reason: '' };

    let apiUrl, apiName, apiBaseUrl;

    // 处理自定义API
    if (apiId.startsWith('custom_')) {
        const customIndex = apiId.replace('custom_', '');
        const customApi = getCustomApiInfo(customIndex);
        if (!customApi) return outcome;

        apiBaseUrl = customApi.url;
        apiUrl = apiBaseUrl + API_CONFIG.search.path + encodeURIComponent(query);
        apiName = customApi.name;
    } else {
        // 内置API
        if (!API_SITES[apiId]) return outcome;
        // 仅列表可用的源：搜索接口实测不可用，跳过以免空转等待（最近更新仍会拉取它）
        if (API_SITES[apiId].listOnly) {
            console.info(`API ${apiId} 仅支持列表，搜索跳过`);
            return outcome;
        }
        apiBaseUrl = API_SITES[apiId].api;
        apiUrl = apiBaseUrl + API_CONFIG.search.path + encodeURIComponent(query);
        apiName = API_SITES[apiId].name;
    }
    outcome.sourceName = apiName;

    // 连续失败的源在停用窗口内不再发请求（算「没响应」，但不算新故障）
    if (isSourceSkipped(apiId)) {
        console.info(`API ${apiId} 连续失败，暂时跳过`);
        outcome.failed = true;
        outcome.reason = '连续失败，暂时跳过';
        return outcome;
    }

    // 单源总死线：到点中止该源所有在途分页请求
    const controller = new AbortController();
    let timedOut = false;
    const timeoutMs = API_CONFIG.search.sourceTimeout;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    const toItem = item => ({
        ...item,
        source_name: apiName,
        source_code: apiId,
        api_url: apiId.startsWith('custom_') ? getCustomApiInfo(apiId.replace('custom_', ''))?.url : undefined
    });

    try {
        // 第一页结果
        let data;
        try {
            data = await fetchSourceData(apiUrl, timeoutMs, controller.signal);
        } catch (error) {
            // 弹窗关闭导致的中止不算源故障，不计入熔断
            if (!timedOut && error && error.name === 'AbortError') return outcome;
            outcome.failed = true;
            outcome.reason = timedOut ? `超时（>${Math.round(timeoutMs / 1000)}s）` : '请求失败';
            console.warn(`API ${apiId} 搜索失败:`, error);
            markSourceFailed(apiId);
            return outcome;
        }
        markSourceSucceeded(apiId);

        outcome.list = (data.list || []).map(toItem);

        // 获取总页数
        const pageCount = data.pagecount || 1;
        // 确定需要获取的额外页数 (最多获取maxPages页)
        const pagesToFetch = Math.min(pageCount - 1, API_CONFIG.search.maxPages - 1);

        // 如果有额外页数，获取更多页的结果
        if (pagesToFetch > 0) {
            const additionalPagePromises = [];

            for (let page = 2; page <= pagesToFetch + 1; page++) {
                // 构建分页URL
                const pageUrl = apiBaseUrl + API_CONFIG.search.pagePath
                    .replace('{query}', encodeURIComponent(query))
                    .replace('{page}', page);

                // 创建获取额外页的Promise
                const pagePromise = (async () => {
                    try {
                        const pageData = await fetchSourceData(pageUrl, timeoutMs, controller.signal);
                        return (pageData.list || []).map(toItem);
                    } catch (error) {
                        console.warn(`API ${apiId} 第${page}页搜索失败:`, error);
                        return [];
                    }
                })();

                additionalPagePromises.push(pagePromise);
            }

            // 等待所有额外页的结果
            const additionalResults = await Promise.all(additionalPagePromises);

            // 合并所有页的结果
            additionalResults.forEach(pageResults => {
                if (pageResults.length > 0) {
                    outcome.list.push(...pageResults);
                }
            });
        }

        // 超时即整体放弃该源（不是只放弃超时的那一页）
        if (timedOut) {
            outcome.list = [];
            outcome.failed = true;
            outcome.reason = `超时（>${Math.round(timeoutMs / 1000)}s）`;
            markSourceFailed(apiId);
        }

        return outcome;
    } catch (error) {
        console.warn(`API ${apiId} 搜索失败:`, error);
        outcome.failed = true;
        outcome.reason = '请求失败';
        return outcome;
    } finally {
        clearTimeout(timer);
    }
}
