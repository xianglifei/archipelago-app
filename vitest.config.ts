import { defineConfig } from 'vitest/config'
import path from 'node:path'

// 质量回归(方案 §3,G1 批次 A):unit=纯逻辑/源码契约静态断言,integration=真 TS 函数+better-sqlite3
// 适配 D1 接口替身(事务模拟 D1 batch 原子回滚)。Electron 专项(tests/electron)与本地 D1 专项
// 另行触发(方案 §3.2:不得因默认命令通过伪称已执行),CI 见 .github/workflows/。
// tests 自 2026-11-02 起进 typecheck 链(tsconfig.test.json):types = node + workers-types 混域实测
// 零冲突(node 26 内置 fetch 全域与 workers-types 可共存),当年担心的「类型域噪音」未成立;
// 导入级断裂(改名/签名漂移)由 typecheck:test 把关,payload 深层字段在测试里按惯例 as any 放行。
export default defineConfig({
  resolve: {
    alias: { '@shared': path.resolve(__dirname, 'src/shared') }
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts']
  }
})
