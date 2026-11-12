# RELEASE-PENDING — app 仓发版前置事项清单

- 本清单管 **客户端+官网仓** 的发版前置事项;cloud 仓的部署事项在 archipelago-cloud 各自登记,互不混挂。
- `npm run release` 发版前强制读取:未勾选条目拦下发版(`--pending-ok` 应急)。

## 待办

- [ ] 2026-11-06 · MCP 连接器(首批能力卡)· **真 Key 实测追补**:三张卡(高德地图/滴滴出行·沙箱/麦当劳)已随 v1.3.2 发布但未做真 Key 三步实测——Key 到位后跑 `node scripts/mcp-endpoint-smoke.mjs <端点URL> [-H "Authorization: Bearer …"] [--call 工具名]`(滴滴必须沙箱端点);实测不过的卡 console 下架再排查,修复无需发版。
- [ ] 2026-11-12 · 拆仓后首次发版 · **新仓首次发版全程验收**:本仓为主要开发仓后的第一次 release——公证/上传/官网同步/**能力门禁实战(pass 路径)**/GitHub Release 留档(留档仓经 RELEASE_REPO 或 origin 自动解析=xianglifei/archipelago-app,公开留档已拍板)全链走一遍并复盘;旧仓(组织仓)此后停写。
