import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, downloadUrl, gitConfig, websiteUrl } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: appName,
      url: '/',
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
    links: [
      { text: '官网', url: websiteUrl, external: true },
      { text: '下载客户端', url: downloadUrl, external: true },
    ],
  };
}
