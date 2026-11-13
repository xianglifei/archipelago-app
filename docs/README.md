# 群岛文档站 docs/

线上:**<https://docs.qundao.app>**
源码:本目录(独立 npm 工程,**不进根 workspace**)

这是群岛的官方用户手册与开发者文档。中文首发,不做 i18n 路由。

## 技术栈

| 项 | 版本 / 选择 |
| --- | --- |
| 框架 | Next.js 16.4 + React 19 + Tailwind 4 |
| 文档引擎 | fumadocs(`fumadocs-core` / `fumadocs-ui` / `fumadocs-mdx` 16.19 / 15.6) |
| 输出 | `output: 'export'` 静态导出 → `out/` |
| 部署 | Cloudflare Workers **静态资产**(assets-only,无 Worker 脚本) |
| 域名 | `docs.qundao.app`(Custom Domain,`wrangler deploy` 自动建 DNS 与证书) |

`docs/` 有自己的 `package.json` 与 `package-lock.json`。Next 工具链**不进** Electron 的依赖树,`npm run verify` 也不跑 docs 构建。

## 目录结构

```
docs/
├── app/
│   ├── docs/                        fumadocs 文档布局与页面渲染(站点唯一入口)
│   ├── api/search/route.ts          构建期生成静态搜索索引(/api/search)
│   ├── llms.txt / llms-full.txt     给 AI 助手的摘要与全文
│   ├── llms.mdx/docs/…/content.md   每页 markdown 原文
│   ├── robots.ts / sitemap.ts       静态生成 robots.txt 与 sitemap.xml
│   └── global.css                   品牌色与系统字体栈(不引 CJK webfont)
├── content/docs/                    文档内容(MDX + 每个目录一个 meta.json)
├── lib/                             source loader、站点常量、布局共享配置
├── components/                      Provider / 搜索对话框 / MDX 组件
├── public/_redirects                根路径 301 → /docs(没有单独的落地页)
├── public/_headers                  Cloudflare 响应头
├── next.config.mjs                  静态导出配置
└── wrangler.jsonc                   部署配置(assets-only + Custom Domain)
```

## 常用命令

```bash
npm --prefix docs install     # 首次
npm --prefix docs run dev     # http://localhost:3000

# 仓库根也可用转发脚本
npm run docs:dev
npm run docs:build            # 静态导出到 docs/out
npm run docs:deploy           # 构建 + wrangler deploy + 线上探活
node scripts/docs-deploy.mjs --skip-build   # 产物已构建,只部署
node scripts/docs-deploy.mjs --dry-run      # 只构建并检查产物,不部署(PR 预检)
```

本地预览产物(不要双击 `out/docs.html`,`file://` 下资源路径会断):

```bash
cd docs && npx serve out
# 或直接用 Cloudflare 的本地运行时,行为与线上一致:
cd docs && npx wrangler dev
```

## 部署

### CI(默认路径)

`.github/workflows/docs.yml`:

- **PR**(paths 过滤 `docs/**`):装依赖 → 静态导出 → `--skip-build --dry-run` 自检 → 上传 `docs-out-<run_id>` 产物。
- **同仓 PR 且有凭据**:额外 `wrangler versions upload --preview-alias pr-<number>`,给出可直接点开的预览版本(fork PR 拿不到 Secret,自动跳过;预览失败不阻塞合并)。
- **push 到 main**:构建 + 部署 + 线上探活。

需要的仓库 Secret:

| Secret | 权限 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Workers Scripts:Edit(最小权限) |
| `CLOUDFLARE_ACCOUNT_ID` | 账号 ID |

没配 Secret 时部署 job 会在第一步就失败并说明缺哪一项,不会部署到一半。

### 手动部署

```bash
npm run docs:deploy
```

部署后脚本会探活:根路径必须 **301 → `/docs`**,`/docs`、一个深层页、`/api/search`、`/llms.txt`、`/robots.txt`、`/sitemap.xml` 必须 200,不存在的路径必须 404,并校验线上内容包含本次产物的关键文案(防 CDN 旧缓存)。

首次绑新域名时证书签发可能需要几分钟,脚本会重试 3 次、每次间隔 20 秒。

## 有意的设计决定

1. **静态导出,不走 SSR。** 文档站不需要服务端能力;Cloudflare 静态资产请求免费且不限量,也不占 Worker 体积额度。代价是没有 middleware / ISR / next image 优化 / Server Actions——重定向与响应头只能写 `public/_redirects`、`public/_headers`。
2. **中文首发,不挂 i18n。** 不配 `fumadocs` 的 i18n 路由,`html lang="zh-CN"` 写死。将来要做英文,再加 `i18n` 配置与 locale 目录。
3. **不引 CJK webfont。** 中文字体动辄几 MB,直接用系统字体栈(PingFang SC / 微软雅黑 / Noto Sans CJK)。首屏不为字体付代价。
4. **不生成动态 OG 图。** `fumadocs-ui/og` 的 ImageResponse 默认字体没有中日韩字形,中文标题会渲染成方块;要做得额外带一份 CJK 字体。这版先不做,只保留基础 `openGraph` 元信息。
5. **搜索默认 multilingual 分词。** 模板默认 `language: 'english'` 会把中文查询切坏;不传该选项即用 `Intl.Segmenter` 的 word 粒度分词(实测「权限与审批」→ 权限 / 与 / 审批)。索引在构建期生成、浏览器端检索,两端同一套分词。
6. **`_headers` 里的 Cache-Control 必须按路径分开写。** 同一路径命中的多条规则会**合并同名头**;把 `max-age=300` 写进 `/*` 会得到 `max-age=31536000, immutable, max-age=300` 这种拼接值。现在只让 `/_next/static/*` 带 immutable,页面与内容各自单独声明。另外 `_headers` 只认 `#` 注释,写 `/* */` 会让整段规则被丢弃(踩过)。
7. **根路径 301 到 `/docs`,站内只有一个入口。** 不另做落地页:输入 `docs.qundao.app` 直接落到文档首页(URL 变成 `/docs`),`public/_redirects` 里只有这一条规则。因此产物里**没有 `out/index.html`**,根路径完全靠这条重定向;部署脚本会同时校验 `out/_redirects` 与线上 301,缺了就直接失败。顶栏站点标题也直接指 `/docs`,不再绕一次 301。

## 内容规范

- 每页 frontmatter 必填 `title`、`description`、`updated`(YYYY-MM-DD)、`appliesTo`(适用客户端版本)。页脚会展示后两项。
- **术语写全称**:「定时任务」与「任务会话」,不单用「任务」。界面里「新建任务」= 任务会话;定时任务在居民档案的「定时」页签。这是产品里最容易混淆的一处,`/docs/concepts/tasks` 有专页消歧。
- 只写**已发版**的功能;内部材料(`doc/`、`design-kit/`、阶段号、排期)一律不进。
- 能用文字/表格讲清就不截图。截图是最大的维护成本。
- 新增页面:在 `content/docs/<目录>/` 加 `.mdx`,并把文件名加进同目录 `meta.json` 的 `pages` 数组(顺序即侧栏顺序)。

## 实测预算(2026-11-13)

| 项 | 大小 |
| --- | --- |
| 全站产物 | 4.0 MB |
| 文档页 HTML(gzip) | 12.4 KB |
| 全部 JS chunk(gzip) | 355 KB |
| 搜索索引(gzip) | 151 KB(仅在打开搜索时按需加载) |
| 文档页数 | 11(不含 404 页与根路径重定向) |

搜索索引会随文档增长线性变大。超过 ~300KB gzip 时考虑拆分索引或按目录懒加载。

## 已知限制 / 后续可做

- 同仓 PR 的 Cloudflare 预览版本走 `wrangler versions upload`,**未在真实凭据下验证过**;失败不影响合并。要让 fork PR 也有 URL,需要一个能安全对外提供的预览机制(目前没有)。
- 没有动态 OG 图(见上)。
- 没有文档站专属的分析埋点;Cloudflare Web Analytics 已定在本轮开启,在 Cloudflare 控制台为 `docs.qundao.app` 打开即可,无需改代码。
- 法务页(隐私政策 / 用户协议)单独排期,本轮不含;文档里已有的「哪些数据会离开本机」页是过渡说明。

## 排障

| 症状 | 先看 |
| --- | --- |
| 构建报 MDX 语法错 | 行号指的是内容文件;裸 `<https://…>` 会被当 JSX,改成 `[文字](url)` |
| 构建报 `You need to wrap your application inside FrameworkProvider` | `app/layout.tsx` 里 `<Provider>` 包住 children |
| 页面 404 但 `out/` 里有文件 | `wrangler.jsonc` 的 `assets.directory` 必须指向 `./out`,`html_handling: auto-trailing-slash` |
| 样式不对 / 品牌色没生效 | `app/global.css` 的 `:root` 覆盖必须在 `@import 'fumadocs-ui/css/…'` 之后 |
| 线上还是旧内容 | 页面 `max-age=300`,等 5 分钟;或确认部署 job 真的跑了(不是只跑了 build) |
