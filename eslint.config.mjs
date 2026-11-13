// ESLint(2026-11-02 落地):只开 bug 类规则,零风格规则——风格 churn 会与多 session 并行「只改自己的码」约定打架,
// 格式化(Prettier 等)是另一个话题,刻意不进本配置。
// 规则面四块:
//   ① js/ts recommended 基础层(死代码/重复声明/比较陷阱)
//   ② 类型感知两条:no-floating-promises / no-misused-promises(tsc 管不到的「忘 await 静默吞错」)
//   ③ react-hooks 两条(渲染层 hooks 依赖漏写/条件调用)
// 挂载点:npm run lint → verify 链 + ci.yml;pre-push 刻意不挂(文档类推送不该被拦)。
// 新增规则先全量跑清存量再开;确属误报用 eslint-disable-next-line 带理由,不许裸 disable。
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

const TS_FILES = ['src/**/*.{ts,tsx}', 'tests/**/*.ts']

export default tseslint.config(
  // 非源码:构建产物/内部文档(不进 git)/官网/文档站/归档/wrangler 缓存
  { ignores: ['dist/**', 'out/**', 'website/**', 'docs/**', 'doc/**', 'design-kit/**', 'minutes/**', '.wrangler/**', 'client/**'] },

  {
    files: TS_FILES,
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
  },

  // ── TS:类型感知层(需要 tsconfig 工程;tests 也在 tsconfig.test.json 里)──
  // md-autolink-integration 被 tsconfig.test.json exclude(import 渲染层 tsx 会拉进 DOM 类型),
  // 类型感知层须同源排除,否则 parser 报 file not found;基础层规则仍覆盖它
  {
    files: TS_FILES,
    ignores: ['tests/unit/md-autolink-integration.test.ts'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.web.json', './tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },

  // ── 渲染层:react-hooks ──
  {
    files: ['src/renderer/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // ── tests:只做导入级/行为级把关 ──
  {
    files: ['tests/**/*.ts'],
    rules: {
      // payload 深层字段按惯例 as any 放行(vitest.config.ts 头注释同源口径),导入级断裂由 typecheck:test 把关
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // ── 构建/发版脚本(.mjs,纯 Node;release.mjs 在发版关键路径上,值得语义检查)──
  {
    files: ['scripts/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
)
