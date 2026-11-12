# AGENTS.md — archipelago-app 开发约定

本仓 = 群岛客户端(Electron)+ 官网(静态三页+邀请落地页 Worker),Apache-2.0 开源。服务端(Cloudflare Worker/D1/R2+运营后台)在私有仓 `xianglifei/archipelago-cloud`,不在本仓也不在本文件描述范围。

> **内部项目上下文**:项目记忆/当前状态/挂账见仓库根 `PROJECT-MEMORY.md`(本地私有,gitignore,不随公开仓分发);完整决策与轮次记录见 `doc/进度追踪.md`(同为本地内部文档)。

## 质量闸(写完码必跑)

`npm run verify` = typecheck(node+web+test 三工程) + vitest(unit+integration) + eslint。CI 每个 PR/main 推送跑同链。

- **ESLint 只开 bug 类规则,零风格规则、不上 Prettier**——风格 churn 会与并行开发冲突;误报用 `eslint-disable-next-line 规则名 -- 中文理由`,不许裸 disable。
- **async 事件处理器一律 `() => void fn()`**(直接挂 async 到 onClick 等属性=抛错变未捕获 rejection)。
- **tsconfig 三工程全 strict + `noUncheckedIndexedAccess`**:`arr[i]` 可能为 undefined 时写真守卫;可证不变式用 `!` 并留一行短注释;禁止无脑 `!`。
- tests 在 tsconfig.test.json;payload 深层字段按惯例 `as any` 放行,导入级断裂由 typecheck 把关。

## 界面文案双语(i18n)

渲染层禁止硬编码中文——界面文案一律走词典:`zh.ts` 加词条 → 组件 `t('section.key')` → `en.ts` 同步补(`en: typeof zh` 在 typecheck 强制 parity)。主进程给用户看的字(菜单/系统通知/对话框/About)走 `ui-strings.ts` 的 `uiStr()`。写完码跑 typecheck 即被强制检查(check-ui-locale 扫硬编码 CJK;check-i18n-keys 校验在用 key 命中词典)。

## 命名公约:「任务」两个家族

- **定时任务族**(时间表驱动):表 `tasks`/`task_runs`、模块 `tasks.ts`/`tasks-core.ts`、工具 `set_task`/`update_task`/`cancel_task`/`list_tasks`、类型 `BotTask`、回合 `TurnKind='scheduled'`。
- **任务会话族**(上下文隔离会话):表 `task_threads`、模块 `task-threads.ts`、工具 `open_task`/`rename_task`、类型 `TaskThreadInfo`、回合 `TurnKind='chat'`。
- 口诀:裸 `Task*`=定时任务;带 `Thread`=任务会话。

## 设置页设计规范

事实源 = styles.css `.settings-card` 定义处的「设置页设计规范总纲」注释块。速查:小节标题=灰色常规体 `.card-section-title`;内容一律进卡 `.settings-card`(内容块 `.pad`,多行 `.settings-card-row` 发丝线分组);说明浮窗 `.qmark`(宿主在内容顶行挂 `.qmark-down`);开关 `.switch`(checkbox 重绘);按钮两档 `.btn` / `.btn.sm` + 图标位 `.icon-btn.sm`,按位置选档不自定 padding;图表柱状图比例基准=纯绘图区。

## 测试

- unit=纯逻辑/源码契约静态断言;integration=真 TS 函数+better-sqlite3 内存库。
- 新增行为修复必须带回归测试;源码契约类断言(防漂移)优先静态断言实现。
- 跨端组合测试在本仓没有(服务端测试在 cloud 私有仓)。

## 发版(维护者)

`npm run dist` → `npm run release`。发版链含能力版本门禁(构建期 out/build-manifest.json × 线上服务端能力端点比对)、R2 上传、官网下载页同步、GitHub Release 留档。贡献者无需也不应运行发版链;prune/公证/签名均为维护者本机凭据。

## 头像素材(仅维护者)

`scripts/prepare-avatars.mjs` 从设计原稿重建头像素材,依赖本机 pngquant(GPL)与设计稿文件;**产物已入库,开发者与构建无需运行本脚本**。
