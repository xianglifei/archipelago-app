# 群岛 Archipelago · 官网

设计师交接版（2026-11-02）静态官网 + 工程侧图片压缩，**已部署上线 Cloudflare Workers static assets**：
- 线上地址：https://qundao.app （www.qundao.app 同内容；下载页 canonical 为 `/download`，`/download.html` 307 过去）
- 部署配置：`wrangler.jsonc`（assets-only 无脚本，双 Custom Domain）；手动部署/改文案后重部：`npm run website:deploy`
- **发版自动联动**：`npm run release`（stable 频道）上传完成后自动更新下载页 Mac 按钮 → 最新 DMG 直链并重新部署（失败拦下发版，应急 `--website-skip`）

三页 HTML + 外置图片（2026-11-05 起从设计师单文件形态拆分）：CSS/JS 仍内嵌在页面里、无第三方字体或服务；
图片在 `assets/` 目录（内容寻址命名，sha256 前 16 位，跨页同图自动合并），favicon 刻意保留内嵌。
页面 CSP 为 `img-src 'self' data:`（`connect-src 'none'` 等其余不变）。拆分动机：4.3MB 单 HTML 是渲染
阻塞资源，直连网络实测 60s 传不完（无代理大陆用户首页基本打不开），gzip 对 base64 高熵数据无效；
拆后 index 191KB（gzip 传输约 72KB）、图片走 immutable 长缓存跨页复用。

## 结构

```
website/
├── index.html      # 官网首页(191KB;原始交接单文件 17.6MB,压缩后曾 4.3MB,拆分后图片外置)
├── download.html   # 下载页(67KB;Mac 按钮已指向最新正式版 DMG;「开源与文档」卡片指向 GitHub 仓库与 docs.qundao.app)
├── whatsnew.html   # 新功能页(64KB;2026-11-04 上线,最近 3 版用户版更新日志;发新版后手工补一版)
├── assets/         # 外置图片(44 个,sha256 前 16 位命名;scripts/website-extract-assets.mjs 维护)
├── _headers        # 安全头 + HTML 短缓存(max-age=300) + /assets/* 一年 immutable 长缓存
├── wrangler.jsonc  # 部署配置(Workers assets + 邀请落地页 worker,qundao.app + www 双域名)
└── README.md
```

「新功能」页维护:内容口径=用户版 changelog(只挑用户看得见、会在乎的变更,与检查更新窗口的 user-notes 同源,取材口径见 CHANGELOG.md 头部约定);发新版后更新 whatsnew.html(新版本卡片插最上、旧的第 3 张移出、累计发版计数 +1)。「更多版本历史」入口暂隐藏(HTML 注释保留在页内),档案页 whatsnew-archive.html 刻意不存在于本目录(线上不可达),启用时按页内注释恢复。三页 header 导航与页脚布局共享同源 CSS 口径(wrap 1160/96、三联导航选择器),改导航样式须三页同步。

## 本地预览

```bash
cd website
python3 -m http.server 8000
# 打开 http://localhost:8000
```

**必须走 http server**（2026-11-05 图片外置后，直接双击 `index.html` 的 file:// 打开方式不再保证图片加载，
CSP `img-src 'self'` 在 file 协议下行为因浏览器而异）。

## 来源与重建

完整交接包归档在 `design-kit/website-2026-11-02/`（不进 git），含 `开始这里-部署说明.md`。
改文案/换图后的重建流程（两步，缺一不可）：

```bash
cd design-kit/website-2026-11-02
python3 tools/build_site.py       # 从 editable/ 源件重建 site/(此时体积会回到 17MB 级)
python3 tools/compress_site.py site/index.html site/download.html   # 压缩内嵌图片(见下)
# 把 site/ 产物拷回仓库 website/
node scripts/website-extract-assets.mjs   # 第三步:拆出外置图片,恢复拆分态(幂等)
```

**重建三步缺一不可**：build_site.py 产出的是内嵌单文件态，拷回后必须重跑提取脚本
`node scripts/website-extract-assets.mjs` 恢复图片外置 + CSP 放行 + 非首屏 lazy（同时恢复下载按钮
激活态,见归档 `本地修改记录.md`）。

`compress_site.py` 需要本机 Python + Pillow（WebP 支持）。压缩策略：

- PNG → WebP q90/method=6，逐张与原图像素级质检（不过关自动升 q95 / 无损 / 保留原样）；
  纹理类插画走放宽档（hot≤3%、mean≤4.5，颗粒噪声差异视觉不可见）
- **二维码卡**（上下文含 `qr-`）：保分辨率 + q95 高档，绝不降采样（扫码可靠性优先）
- favicon（link rel=icon）→ 128px PNG；页头 39px logo 与 44px 居民头像（512×512 方图）
  → 256px（仍有 5.8× 视网膜余量）；被放大显示的 `brand-pixels`（512→1254 像素风）保原分辨率
- JPEG 一律不动（设计师已压，且多为二维码）
- 页面 JS 会把 favicon 运行时同步为 brand-pixels 图，静态 link 是兜底——均为设计原行为

## 对交接包的本地改动（相对 Downloads 原始交接）

1. `index.html` 空 `<link rel="icon">` 补上 download.html 同款图标（两页一致性，交接不一致项），
   已回写归档模板 `editable/source/page.template.html`。
2. **图片压缩**（见上），两页 19.7MB → 5.3MB。原始未压缩版仍在归档 `site/`（哈希对得上
   SHA256SUMS），压缩只作用于仓库 `website/` 的部署版。

## 待办（2026-11-03 部署后遗留）

1. ~~Mac 安装包 URL~~ **已机制化**：下载按钮已指向当前正式版 DMG（v1.2.4），
   且 `npm run release` 发 stable 时自动更新+重新部署（`scripts/website-deploy.mjs`）。
   注意：不要再用归档包的 `download-config.json`+重建来配 Mac 链接——那条路会把按钮还原成
   「待配置」态，恢复方法见归档内 `本地修改记录.md`。
2. ~~用户群二维码~~ **已下线（2026-11-13）**：下载页「用户群与联系」板块连同群二维码一并移除，
   改为「开源与文档」卡片（客户端 GitHub 仓库 + docs.qundao.app）。同日按线上反馈二次调整：
   卡片改白底对齐两平台下载卡；正文去掉原先给二维码让位的 560px 限宽（文字不再中途折行）；
   两个入口收进正文文字链（「GitHub 开源 ↗」/「文档站 ↗」，下划线+箭头），不再直接展示 URL。
   注意设计归档 `design-kit/website-2026-11-02/editable/` 里仍是旧板块，若日后从归档重建下载页会把它带回，
   重建前须先同步这个板块（本仓库直接维护的是 `website/download.html` 部署版）。
3. 真机走查：Safari + 实体手机访问 https://qundao.app 全流程（含真机点下载按钮装包）。

## 红线：不暴露内部文档

仓库内 `doc/`、`design-kit/` 等是内部工作材料，**严禁**在官网页面链接或引用；
对外文案一律自写，不搬运内部措辞（内部阶段号、评审状态等）。
