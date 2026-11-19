// 审批的模型侧协议文案(2026-11-19,借 Linger tool-approval-protocol 思路)。
// 独立零依赖叶子模块:审批拒绝回执要拼进 tool 结果,mock './approval' 的集成测试
// 才不被 electron 依赖链拖累;改措辞必须同步 tests/unit/prompt-anchors.test.ts 的 golden。

/**
 * 执行类拒绝(run_command / 写围栏 / MCP 调用,tool 结果回给模型)的统一尾句:
 * 拒绝挡住的不只这一次调用,而是「同一效果」本身——原样重试与换工具/脚本/写法绕过都不行,
 * 唯一出路是岛主自己执行。三处共用、措辞单源防漂移;S2 权限档位行(prompts.ts)
 * 持有同一语义的完整版,两处必须同调。
 */
export const DENIED_BYPASS_LINE =
  '不要原样重试,也不要改用别的工具、脚本或写法去达到同一效果;确需执行,请岛主自己来。'
