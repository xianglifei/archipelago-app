import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

const docsRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * 静态导出(output: 'export')→ out/ 目录 → Cloudflare Workers 静态资产。
 *
 * 为什么不用 SSR:文档站不需要服务端能力,静态资产请求在 Cloudflare 免费且不限量,
 * 也不占 Worker 体积额度。搜索索引、llms.txt、每页 markdown 都在构建期落成静态文件。
 *
 * 静态导出的限制(改动前先看):
 * - 没有 middleware / Proxy:重定向只能写 public/_redirects
 * - 不支持 next/image 默认优化:images.unoptimized 必须为 true
 * - 不支持 headers():响应头只能写 public/_headers
 *
 * @type {import('next').NextConfig}
 */
const config = {
  output: 'export',
  reactStrictMode: true,
  images: { unoptimized: true },
  // docs/ 有自己的 lockfile,而仓库根也有:显式限定 Turbopack 的根,
  // 否则它会往上找并把整个 Electron 工程纳入监视
  turbopack: { root: docsRoot },
};

export default withMDX(config);
