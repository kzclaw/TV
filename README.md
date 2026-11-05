# KzTv

> **KzTv 是一个免费的多源视频搜索与观看平台，聚合多个公开视频源，无需注册，打开即用。**

KzTv 把多个公开的视频采集接口聚合到一处：站内搜索 → 浏览各来源片单 → 跳转播放。
站点**只做搜索与跳转**，不存储、不上传、不转存任何视频文件；视频由浏览器直接向源站请求。

- 站名：KzTv
- 域名：https://tv.kwokzit.info
- 协议：GNU Affero General Public License v3.0 或更高版本

---

## 部署到 Cloudflare Pages

本项目是一个**纯静态站 + Cloudflare Pages Functions**，不需要任何构建步骤。

1. Fork 本仓库
2. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
3. 选择你的 fork 仓库
4. 构建配置：
   - **Framework preset**：`None`
   - **Build command**：**留空**
   - **Build output directory**：**留空**
5. Deploy

> push 到 `main` 即触发生产部署。

### 环境变量

在 Pages 项目的 **Settings → Environment variables** 添加：

| 变量 | 必填 | 说明 |
|---|---|---|
| `PASSWORD` | 否 | 站点访问密码。设置后，访客需通过密码验证才能使用代理接口 |
| `LIBRETV_PROXY_KV` | 否 | KV 命名空间绑定名，用于缓存代理响应（[KV 命名空间](https://developers.cloudflare.com/kv/)） |
| `CACHE_TTL` | 否 | 缓存有效期（秒），默认 `86400` |
| `MAX_RECURSION` | 否 | 代理最大递归层数，默认 `5` |
| `USER_AGENTS_JSON` | 否 | 代理使用的 User-Agent 列表（JSON 数组） |
| `DEBUG` | 否 | 调试日志开关 |

> ⚠️ `LIBRETV_PROXY_KV` 是**绑定名**，需在 Pages 项目的 KV 绑定里配置同名变量。

## 内置采集源

`js/config.js` 的 `API_SITES` 内置了多个公开采集源，均为**第三方公开接口**，可用性由源站决定。
新增源只需在该对象里追加一项。

> 其中部分源使用 `http://` 明文访问，这是源站自身的情况。

## 目录结构

```
index.html            首页
player.html           播放页
watch.html            跳转中转页
about.html            关于我们
manifest.json         PWA manifest
service-worker.js     Service Worker（空壳，不做缓存）
css/                  样式
js/                   前端逻辑（config / api / player / search / ...）
functions/
  _middleware.js      Pages Function 中间件
  proxy/[[path]].js   代理接口（搜索、详情、豆瓣）
libs/                 第三方库（ArtPlayer / hls.js / Tailwind / js-sha256）
image/                图标与静态图
```

## 许可与来源

本项目基于 [LibreTV](https://github.com/LibreSpark/LibreTV) 派生并修改，原项目的作者与版权声明予以保留。

本项目按 **GNU Affero General Public License v3.0 或更高版本** 授权，完整许可证文本见 [`LICENSE`](LICENSE)。

## 免责声明

本站仅提供视频搜索与播放入口，不提供资源下载。全部片单与播放地址来自第三方公开接口，
其内容由第三方独立提供并独立负责。视频中出现的广告与本站无关，请勿相信或点击。
