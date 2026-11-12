# RELEASE-PENDING — app 仓发版前置事项清单

- 本清单管 **客户端+官网仓** 的发版前置事项;cloud 仓的部署事项在 archipelago-cloud 各自登记,互不混挂。
- `npm run release` 发版前强制读取:未勾选条目拦下发版(`--pending-ok` 应急)。

## 待办

- [ ] 2026-11-06 · MCP 连接器(首批能力卡)· **真 Key 实测追补**:三张卡(高德地图/滴滴出行·沙箱/麦当劳)已随 v1.3.2 发布但未做真 Key 三步实测——Key 到位后跑 `node scripts/mcp-endpoint-smoke.mjs <端点URL> [-H "Authorization: Bearer …"] [--call 工具名]`(滴滴必须沙箱端点);实测不过的卡 console 下架再排查,修复无需发版。
- [ ] 2026-11-12 · 拆仓后首次发版 · 发版前确认三件:①`out/build-manifest.json` 为本次构建产出(非旧残留);②GitHub 留档仓=本仓(origin 解析,公开留档已拍板);③四条控制路径回归项(stable 默认/--website-skip/--github-skip/test)在发版后逐条补验并回填本条完成情况。
- [ ] 2026-11-12 · 拆仓后首次发版 · 发版后验收(与上一条同一次发版内完成,不构成发版前置):能力门禁 pass 实战输出留档、GitHub Release 公开留档成功、官网下载页指向新 DMG、完整升级链(旧版→发现→下载→安装+userData/账号连续性)在 test 频道或真发版后核验。
