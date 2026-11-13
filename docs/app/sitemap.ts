import type { MetadataRoute } from 'next';
import { source } from '@/lib/source';
import { siteUrl } from '@/lib/shared';

export const dynamic = 'force-static';

export default function sitemap(): MetadataRoute.Sitemap {
  // 根路径 301 到 /docs(见 public/_redirects),所以站点根不进 sitemap:
  // 重定向目标不是可索引的页面,收录 /docs 就够了。
  return source.getPages().map((page) => ({
    url: `${siteUrl}${page.url}`,
    changeFrequency: 'weekly' as const,
    priority: page.slugs.length === 0 ? 1 : 0.7,
  }));
}
