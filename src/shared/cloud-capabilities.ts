// 本版客户端所需的最低线上能力(阶段 2 能力版本协议,方案=doc/方案 - 仓库拆分 - 2026-11-12.md §6.2 v2)。
// 与 cloud/src/capabilities.json 的「服务端具备清单」配对:发版门禁比对「REQUIRED ≤ 线上」,
// 逐项缺失即拦下发版并指名缺哪项(--cloud-pending-ok 逃生口仅覆盖此类「已知不兼容」)。
//
// 规则(2026-11-12 codex 终审):
// - 只声明 cloud 侧服务语义,客户端本地能力(工作目录/MCP 直连/本地 web 回退)不入表;
// - 数值语义=「需要线上 ≥ 此值」;升版仅限向后兼容的累积扩展,破坏性变更走新能力名;
// - 消费方=构建期 build manifest(electron.vite.config.ts 快照进 out/build-manifest.json,
//   绑定 git SHA 与版本)→ release.mjs 门禁读 manifest 而非工作树(防「先 dist 后改声明」错位)。
export const REQUIRED_CAPABILITIES: Record<string, number> = {
  'account.devices.bind': 1,
  'billing.fifo': 1,
  'post.invites.landing': 1,
  'post.letters': 1,
  'post.station': 1,
  'relay.stream': 1,
  'skills.catalog': 1,
  'skills.catalog.connector-entries': 1,
  'webtools.cloud': 1,
}
