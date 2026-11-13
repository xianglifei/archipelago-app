import Link from 'next/link';
import { appName, downloadUrl, websiteUrl } from '@/lib/shared';

const entries = [
  {
    title: '第一次使用',
    description: '从下载安装到发出第一个任务:安装、登录、向导、邀请第一位居民。',
    href: '/docs/getting-started/install',
    items: [
      { text: '安装与更新', href: '/docs/getting-started/install' },
      { text: '登录与账号', href: '/docs/getting-started/account' },
      { text: '五分钟上手', href: '/docs/getting-started/first-task' },
    ],
  },
  {
    title: '核心机制',
    description: '岛主和居民之间到底怎么分工:权限档位、审批卡、三种任务形态。',
    href: '/docs/concepts/permissions',
    items: [
      { text: '权限与审批', href: '/docs/concepts/permissions' },
      { text: '任务的三种形态', href: '/docs/concepts/tasks' },
      { text: '技能卡与技能中心', href: '/docs/handbook/skills' },
    ],
  },
  {
    title: '开发者',
    description: '本地跑起来、过质量闸、写一张别人也能用的技能卡。',
    href: '/docs/developers/local-dev',
    items: [
      { text: '本地开发与质量闸', href: '/docs/developers/local-dev' },
      { text: '技能卡格式规范', href: '/docs/developers/skill-format' },
      { text: '常见问题', href: '/docs/help/faq' },
    ],
  },
];

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <section className="mx-auto w-full max-w-5xl px-6 pt-16 pb-12 md:pt-24">
        <p className="text-xs tracking-[0.2em] text-fd-muted-foreground uppercase">
          Archipelago · 文档
        </p>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight md:text-5xl">
          一支住在你 Mac 里的 AI 团队,
          <br className="hidden sm:block" />
          怎么用、怎么管、怎么接。
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-8 text-fd-muted-foreground">
          这里是{appName}。它讲清楚三件事:新用户怎么从下载走到第一个任务;权限、审批、任务会话这些
          高风险机制到底怎么运作;以及想改代码或写技能卡的开发者需要知道什么。
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link
            href="/docs/getting-started/install"
            className="inline-flex items-center gap-2 rounded-xl bg-fd-primary px-5 py-3 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
          >
            开始使用
          </Link>
          <a
            href={downloadUrl}
            className="inline-flex items-center gap-2 rounded-xl border border-fd-border px-5 py-3 text-sm font-medium transition-colors hover:bg-fd-accent"
          >
            下载客户端
          </a>
          <a
            href={websiteUrl}
            className="inline-flex items-center gap-2 px-2 py-3 text-sm text-fd-muted-foreground underline-offset-4 hover:underline"
          >
            返回官网
          </a>
        </div>
        <p className="mt-4 text-xs text-fd-muted-foreground">
          按 <kbd className="rounded border border-fd-border px-1.5 py-0.5">⌘</kbd> +{' '}
          <kbd className="rounded border border-fd-border px-1.5 py-0.5">K</kbd> 全文搜索
        </p>
      </section>

      <section className="mx-auto w-full max-w-5xl px-6 pb-20">
        <div className="grid gap-5 md:grid-cols-3">
          {entries.map((entry) => (
            <div
              key={entry.title}
              className="rounded-2xl border border-fd-border bg-fd-card/60 p-6"
            >
              <h2 className="text-lg font-semibold">{entry.title}</h2>
              <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">
                {entry.description}
              </p>
              <ul className="mt-4 space-y-2 text-sm">
                {entry.items.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="text-fd-primary underline-offset-4 hover:underline"
                    >
                      {item.text}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-10 rounded-2xl border border-fd-border p-6 text-sm leading-7 text-fd-muted-foreground">
          <p>
            文档源码就在客户端仓的 <code className="text-fd-foreground">docs/</code>{' '}
            目录里。看到不对的地方,每页右上角都有「编辑此页」。
          </p>
          <p className="mt-1">
            本页内容最后复核:2026-11-13 · 适用客户端 v1.5.2 及以后
          </p>
        </div>
      </section>
    </main>
  );
}
