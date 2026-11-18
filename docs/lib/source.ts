import { z } from 'zod';
import { llms, loader } from 'fumadocs-core/source';
import { docsRoute } from './shared';
import { defineDocs } from 'fumadocs-mdx/macro';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';

/**
 * 每页 frontmatter 在默认 schema 上追加两个字段(均为必填,缺了构建期就红——
 * 页脚的「适用版本/最后更新」是防腐化公约,漏写要拦在 PR,不靠页脚静默兜底):
 * - updated:最后复核日期(YYYY-MM-DD)
 * - appliesTo:适用客户端版本(如「≥ 1.5.0」),机制改动时先改这里
 */
const docsPageSchema = pageSchema.extend({
  updated: z.string(),
  appliesTo: z.string(),
});

const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    schema: docsPageSchema,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

// See https://fumadocs.dev/docs/headless/source-api for more info
export const source = loader({
  baseUrl: docsRoute,
  source: docs.toFumadocsSource(),
  plugins: [],
});

export const docsLlms = llms(source, {
  renderPage: async (page) => `# ${page.data.title} (${page.url})

${await page.data.getText('processed')}`,
});
