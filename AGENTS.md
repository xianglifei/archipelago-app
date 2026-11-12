# AGENTS.md — archipelago-app(客户端+官网,开源仓)

> **拆仓声明(2026-11-12)**:本仓 = 客户端 + 官网(公开);服务端在 `xianglifei/archipelago-cloud`(严格私有,部署链/能力协议/拒脏树等红线见其 AGENTS.md)。
> 本文件下文为单仓时代的历史全文,**涉及 `cd cloud && npm run deploy`、cloud 部署门禁(旧 1.5 指纹)、cloud 迁移登记的段落已由新机制取代**:客户端发版门禁现为 **release.mjs 第 1.5b 能力版本门禁**(构建期 build-manifest 声明需求 × 线上 GET /meta/capabilities 比对);两仓 **RELEASE-PENDING.md 各挂各的**(本仓管客户端/官网发版事项,cloud 仓管服务端部署事项);cloud 部署在 cloud 仓独立进行,不因本仓发版而触发。
> 双平台发版节奏、README/CHANGELOG 同步、verify 质量闸、i18n 双闸、设置页规范、命名公约等下文约定继续有效。

# 历史全文(单仓时代,下文 cloud 相关段落按上方声明解读)

本仓库由多个并行开发 session(人类 + AI agent)共同工作。以下规则任何 agent 开工前都应知晓。
进度唯一事实源 = `doc/进度追踪.md`;本文件只放「任何 session 都会撞上、漏读会出事故」的机制性约定,不重复需求内容。

## 发版(联动要求已固化进脚本,不靠任何 session 口头提醒)

**双平台发版节奏(2026-11-04 约定)**:**「发版」一词默认指 Mac 版**——Mac 高频迭代,Felix 每天可能发新版。**Windows 版低频推送**:等 Mac 攒了若干版本后,由 Felix **明确说「发 Windows 版」**才打包——任何 session 不得自行发 Windows 版。两平台版本号共用同一序列(package.json version,随内容走,谁先发谁先占号)。

- **Mac 发版** = `npm run dist` → `npm run release`(全链:公证/R2/update.json/官网 Mac 按钮/GitHub Release 留档,见下)。
- **Windows 发版 checklist**(手动,不走 release.mjs):①确认 Felix 明确指示 ②`npm run dist:win` ③exe 传 R2 `updates/stable/`(wrangler,Content-Type application/octet-stream,cache-control 短期)④验直链 200 ⑤官网 `website/download.html` Windows 按钮 href 改指本版 exe、状态行版本号改「v<本版> · Windows 10/11」(Mac 状态行版本由 website-deploy.mjs 自动同步,Windows 这行只能手改)并 `npm run website:deploy` ⑥CHANGELOG/进度追踪登记 ⑦r2-prune 双平台各留 3(可手跑 `node scripts/r2-prune.mjs --channel stable --keep 3 --dry-run` 核对)。Windows 更新器现为「不支持」诚实态,无清单联动;签名未接(SmartScreen 需手动放行)。
- **R2 保留策略按平台分开计**:stable 频道 Mac(arm64)与 Windows(x64)各留最近 3 版互不挤占(r2-prune.mjs 已实现);test 频道各留 1。

**客户端(Mac)**:`npm run dist` → `npm run release`。

- release.mjs 发版前有 **cloud 部署联动门禁**(第 1.5 步,`scripts/cloud-deploy-state.mjs`):对比 `cloud/` 源码指纹与本机部署台账 `cloud/.deploy-fingerprint`,cloud 有未部署改动(或本机无台账)会**拦下发版**。
  - 本版客户端若依赖 cloud 变更(新端点/新配置):先 `cd cloud && npm run deploy`,再回来发版。
  - 确认无关:`npm run release -- --cloud-pending-ok` 显式跳过。
  - 台账按机器本地有效(不进 git):换机器/清台账后首跑误拦属正常,按提示处理。
- 上传成功后第 7 步自动 **GitHub Release 留档 DMG**(仅 stable):`gh release create v<版本>` 附本版 DMG,notes 复用 CHANGELOG user-notes 块——R2 保留策略只留最近 3 版,GitHub Release 是历史版本永久档案(私有库,资产下载需仓库读权限,对外分发仍走官网/R2)。前置:gh CLI 已登录 + **远端 tag 已推送**(先打 tag 再发版,否则脚本拦下);失败拦下发版收尾,应急 `--github-skip`。

**cloud**:`cd cloud && npm run deploy`。该命令已自动串联(顺序即红线,2026-10-26 事故教训):

1. `node --check console/app.js`(纯 JS 后台,语法错=整页空白)
2. wrangler.toml 三条自定义域名路由齐全校验(漏声明存量域名,wrangler deploy 会直接删它的 DNS)
3. 远程 D1 迁移(幂等链,必须先于 deploy)
4. `wrangler deploy`
5. 三域名探活(sea / api / usage 任一不通即报错),成功后记录部署台账

不要绕过 `npm run deploy` 直接跑裸 `wrangler deploy`——会跳过 1/2/3/5 和记账,下次客户端发版会被门禁误拦。

## 发版前置事项集中登记(RELEASE-PENDING.md)

**任何 session 开发完一个功能,若需要 cloud 配合或任何发版前置动作(cloud 部署 / D1 迁移 / 后台运营配置 / 顺序要求),必须在仓库根 `RELEASE-PENDING.md` 登记一条**——一行一条,`- [ ]` 开头,写清「日期 · 来源功能 · 要做什么 · 怎么做」。这是各 session 发版备注的**唯一集中地**:不要只写在会话里、记忆里或口头交代,那些都到不了发版时刻。

- `npm run release` 发版前强制读取该清单:**未勾选条目会拦下发版并逐条打印**(应急 `--pending-ok`,不推荐);清单为空时也会打印一行主动确认——发版者须想一遍「本版真的没有 cloud 配合/后台配置类依赖吗」,登记遗漏在此现形。
- 动作完成后把条目勾成 `[x]`;成功发版后已勾条目自动归档删除。
- 推送时 husky pre-push 钩子会对含 `cloud/` 或 `src/` 改动的推送打印登记提醒(不阻断)——session 收到即自查。
- cloud 部署台账管「cloud 代码是否已部署」(按机器本地),RELEASE-PENDING.md 管「跨系统配合事项与备注」(进 git,全机器共享)——两者互补,发版都要过;即使登记遗漏,改过 cloud/ 代码未部署仍会被台账门禁硬拦。

## 官网(qundao.app,2026-11-03 起上线)

- 官网=仓库 `website/` 三页自包含 HTML(首页/下载/新功能 whatsnew),部署在 Cloudflare Workers static assets(配置 `website/wrangler.jsonc`,qundao.app + www 双 Custom Domain);手动部署/改文案后重部:`npm run website:deploy`。「新功能」页=最近 3 版用户版更新日志(与 user-notes 同源口径),发新版后手工补一版;完整档案页 whatsnew-archive 暂不部署(「更多版本历史」入口以注释隐藏在页内);三页导航/页脚共享布局口径,改导航样式三页同步。
- **发版自动联动**:`npm run release`(仅 stable 频道)上传完成后第 6 步自动把官网下载页 Mac 按钮指到刚上传的 DMG 直链、状态行版本号同步为「v<版本> · Apple Silicon」并重新部署,失败即拦下发版收尾(应急 `--website-skip`);href 与版本号改动写回 `website/download.html`,**随发版收尾提交**。
- 设计稿重建(归档包 `design-kit/website-2026-11-02/` 的 build_site.py)会把按钮还原成「待配置」disabled 态——部署脚本会响亮报错,按归档内 `本地修改记录.md` 恢复激活态标记。

## 界面文案双语(i18n,2026-10-30 起所有新功能适用)

**渲染层禁止硬编码中文**——界面文案一律走词典:zh.ts 加词条 → 组件 `t('section.key')` → en.ts 同步补(`en: typeof zh` 在 typecheck 强制 parity)。**主进程给用户看的字**(菜单/系统通知/对话框/About)必须走 `ui-strings.ts` 的 `uiStr()`。**居民世界文本**(工具结果/回执/prompt/审批 payload)保持中文不翻,对它的匹配/解析串同样不翻(渲染端标 `// locale:protocol` 豁免)。

静态闸挂在 `typecheck:web`(写完跑 typecheck 即被强制检查):check-ui-locale 扫渲染层硬编码 CJK 与主进程 Notification/dialog 调用;check-i18n-keys 校验在用词条 key 全部命中词典。加第三语言、英文文案规范、三域判定表见 **doc/开发约定 - 界面文案双语.md**(新功能动文案前先读它)。

## 代码质量闸(lint / typecheck,2026-11-02 起适用)

- **写完码跑 `npm run verify`**(= typecheck 三工程含 tests + vitest + eslint),应全绿再收工;CI 每个 PR/main 推送强制跑同一链。pre-push 刻意不挂 lint(文档类推送不该被拦)。
- **ESLint(eslint.config.mjs)只开 bug 类规则,零风格规则、不上 Prettier**——风格 churn 会与多 session 并行「只改自己的码」约定打架。现有规则面:floating/misused promises(忘 await)、react-hooks、死代码、console 纯 JS 语义检查、scripts/*.mjs。**新增规则先全量跑清存量再开**;确属误报用 `eslint-disable-next-line 规则名 -- 中文理由`,不许裸 disable。
- **async 事件处理器一律 `() => void fn()` 风格**(直接挂 async 到 onClick 等属性=抛错变渲染进程未捕获 rejection,misused-promises 规则拦)。
- **tsconfig 四工程(node/web/cloud/test)全 strict + `noUncheckedIndexedAccess`**:`arr[i]` 可能为 undefined 时写真守卫;**可证不变式**(如同条件已查 length、modulo 取下标、构造保证非空)用 `!` 并留一行短注释;禁止无脑 `!` 掩盖真问题。
- tests 在 tsconfig.test.json(node+workers-types 混域,零冲突);测试 payload 深层字段按惯例 `as any` 放行(no-explicit-any 对 tests 关闭),**导入级断裂由 typecheck 把关不许 any 逃逸**。

## 命名公约:「任务」两个家族(2026-11-06 起)

岛上有两个都叫「任务」的东西,代码按家族归队,新增代码不得跨界命名:

- **定时任务族**(时间表驱动,2026-10-28):表 `tasks`/`task_runs`、模块 `tasks.ts`/`tasks-core.ts`、居民工具 `set_task`/`update_task`/`cancel_task`/`list_tasks`、类型 `BotTask`/`ScheduleKind`、回合类型 `TurnKind='scheduled'`、档案页签「定时」。
- **任务会话族**(上下文隔离的专属会话,2026-11-06):表 `task_threads`、模块 `task-threads.ts`、居民工具 `open_task`/`rename_task`、类型 `TaskThreadInfo`、sessions 表 `kind='task'`、列表行/视图 `kind='task'`、IPC `TaskThread*`、事件 `ThreadsChanged`。

判别口诀:看到裸 `Task*`/`task` 前缀=定时任务;带 `Thread` =任务会话;`TurnKind` 里的 `'scheduled'`=定时任务回合、`'chat'`=任务会话回合。

## 设置页设计规范(2026-11-09 定标,设置类新功能一律沿用)

全套口径的**事实源 = styles.css `.settings-card` 定义处的「设置页设计规范总纲」注释块**(各标准件定义旁另有分则注释)。速查:

- **结构**:小节标题 = 灰色常规体 `.card-section-title` 裸在背景上;**内容一律进卡** `.settings-card`(var(--sidebar) 底/14px 圆角,内容块加 `.pad`,卡内多行 `.settings-card-row` 发丝线分组)。危险操作横幅/低余额警示等例外可留卡外。
- **间距**:标题与上方内容 16px/与下方卡 8px,机制 = 页签容器 flex gap 8 + 标题 margin-top 8(五容器同机制,勿自造间距)。
- **字号**:卡内行标题 13px/600/深色(`.toggle-title`);正文 12px;小字 11.5px 灰。
- **说明浮窗**:`.qmark` 标准件(CircleHelp+data-tip),间距单一旋钮 `--qmark-gap`;宿主在内容**顶行**必须挂 `.qmark-down`(朝上开会被滚动容器上缘裁掉);文案走 i18n 词典。
- **开关**:左右滑动 `.switch`(checkbox 重绘 38×22);打勾框只用于多选。
- **按钮两档+图标位**:A 档基础 `.btn`(卡级主行动)/B 档 `.btn.sm`(行内/卡头轻量)/图标位 `.icon-btn.sm` 30×30——**按位置选档,不许自定 padding/字号**。
- **图表**:柱状图比例基准=纯绘图区(`.credits-chart-plot`),数值骑柱顶,零值显 0,禁比例假地板。
- **页签卡**:Tab 与内容一体(`.mem-tabs-card` 软卡+卡头页签+白底 `.mem-inner`),不做散胶囊+孤卡。
- 一行状态小字可并进标题括号(`titleWithStatus` 插值模式)。

## 其他跨 session 约定

- 同一时间只允许一个 session 跑 `dist` / `release`(产物目录与单实例锁会互相踩);并行开发时其余 session 只改码、不发版、不 `git add -A`(防混入他人未完成改动)。
- 每次 `git push` 须同步更新 README.md 与 CHANGELOG.md([未发布] 小节),pre-push 钩子强制;发版归档版本小节时须写 `<!--user-notes-->` 面向用户的更新日志块(release.mjs 强制校验)。**用户版口径(2026-11-04)**:只挑用户看得见、会在乎的变更,与官网「新功能」页同源,服务端/运营后台类条目不进用户版——取材细则见 CHANGELOG.md 头部约定。
- 仓库根 `minutes/` 是评审逐字稿,**勿提交**(已在 .gitignore);`doc/` 与 `design-kit/` 已在 .gitignore(内部文档不进版本管理),对外产物(官网等)严禁链接内部文档。
- **Cici 接力日志**:ZCode 额度不足时由居民 Cici 接手开发,工作日志写在 `doc/接力日志 - Cici.md`(时间精确到分钟,七段结构:做了什么／踩了什么坑／断点在哪／别碰什么／已知红灯／待确认的决策／下一步)。**接手前必读该文件最后一条**,它记着上次的断点;Cici 每次收工前追加一条。注意与 `doc/进度追踪.md` 分工:进度追踪是全程事实源,接力日志只记 Cici 接力期间的动作与断点。**`doc/` 在 `.gitignore` 里**,本文件不随 git 走,跨机器交接时关键断点须同步落到 `RELEASE-PENDING.md`。
- 机制类改动(权限/审批/计费语义)先出方案文档交审、拍板后才写码;小 bug 直接修。
