import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, docsRoute, downloadUrl, gitConfig, websiteUrl } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      // 站内只有文档一个入口:顶栏标题直接回 /docs,不走根路径的 301
      title: appName,
      url: docsRoute,
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
    links: [
      { text: '官网', url: websiteUrl, external: true },
      { text: '下载客户端', url: downloadUrl, external: true },
    ],
  };
}
