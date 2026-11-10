const CUSTOMER_SITES = {
    // qiqi（七七资源）已停用：2026-11-10 实测源站连接被关（ERR_CONNECTION_CLOSED），
    // 经本站代理出网则是 HTTP 525（Cloudflare 到源站 TLS 握手失败）——源站 SSL 坏了。
    // qiqi: {
    //     api: 'https://www.qiqidys.com/api.php/provide/vod',
    //     name: '七七资源',
    // },
};

// 调用全局方法合并
if (window.extendAPISites) {
    window.extendAPISites(CUSTOMER_SITES);
} else {
    console.error("错误：请先加载 config.js！");
}
