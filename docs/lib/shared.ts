import { createGetUrl } from 'fumadocs-core/source';

/** 站点名(顶栏、OG、llms.txt 用它) */
export const appName = '群岛文档';

/** 文档主路由。部署在 docs.qundao.app 根,不做 basePath */
export const docsRoute = '/docs';
export const docsContentRoute = '/llms.mdx/docs';

/** 线上地址(metadataBase、sitemap 用) */
export const siteUrl = 'https://docs.qundao.app';

/** 官网与下载页(文档里所有 CTA 回链都从这里取,避免散落硬编码) */
export const websiteUrl = 'https://qundao.app';
export const downloadUrl = 'https://qundao.app/download';

/**
 * 「在 GitHub 编辑此页」用。注意:文档源码在客户端仓的 docs/ 子目录下,
 * 不是仓库根的 content/docs。
 */
export const gitConfig = {
  user: 'xianglifei',
  repo: 'archipelago-app',
  branch: 'main',
};

/** 仓库内文档源码目录(相对仓库根) */
export const docsSourceDir = 'docs/content/docs';

const getContentUrl = createGetUrl(docsContentRoute);

export function getPageMarkdownUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'content.md'];

  return { segments, url: getContentUrl(segments, page.locale) };
}
