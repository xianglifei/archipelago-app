import type { Metadata } from 'next';
import { Provider } from '@/components/provider';
import { appName, siteUrl } from '@/lib/shared';
import './global.css';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: `${appName} · 群岛 Archipelago`,
    template: `%s · ${appName}`,
  },
  description:
    '群岛 Archipelago 的官方文档:安装与上手、权限与审批、任务、技能卡、积分,以及给贡献者的本地开发与技能卡格式规范。',
  openGraph: {
    type: 'website',
    locale: 'zh_CN',
    url: siteUrl,
    siteName: appName,
  },
  robots: { index: true, follow: true },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    // 中文首发:lang 固定 zh-CN,不挂 i18n 路由。将来要英文再引入 fumadocs i18n
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="flex flex-col min-h-screen antialiased">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
