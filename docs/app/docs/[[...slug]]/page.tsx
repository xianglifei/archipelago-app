import { source } from '@/lib/source';
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from 'fumadocs-ui/layouts/docs/page';
import { notFound } from 'next/navigation';
import { getMDXComponents } from '@/components/mdx';
import type { Metadata } from 'next';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import { docsSourceDir, getPageMarkdownUrl, gitConfig, siteUrl } from '@/lib/shared';

export default async function Page(props: PageProps<'/docs/[[...slug]]'>) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const markdownUrl = getPageMarkdownUrl(page).url;
  const editUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/${docsSourceDir}/${page.path}`;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription className="mb-0">{page.data.description}</DocsDescription>
      <div className="flex flex-row gap-2 items-center border-b pb-6">
        <MarkdownCopyButton markdownUrl={markdownUrl} />
        <ViewOptionsPopover markdownUrl={markdownUrl} githubUrl={editUrl} />
      </div>
      <DocsBody>
        <MDX
          components={getMDXComponents({
            // this allows you to link to other pages with relative file paths
            a: createRelativeLink(source, page),
          })}
        />
      </DocsBody>
      {/* 文档会腐化:每页必须能看出「适用哪个版本、上次什么时候复核」 */}
      <div className="mt-14 border-t pt-4 text-xs text-fd-muted-foreground">
        <p>
          适用版本:{page.data.appliesTo ?? 'v1.5.2'}
          <span className="mx-2">·</span>
          最后更新:{page.data.updated ?? '2026-11-13'}
        </p>
        <p className="mt-1">
          发现写错或过时?点上方「编辑此页」提 PR,或在{' '}
          <a className="text-fd-primary underline-offset-4 hover:underline" href={`${siteUrl}/docs/help/faq`}>
            常见问题
          </a>{' '}
          里找到反馈入口。
        </p>
      </div>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: PageProps<'/docs/[[...slug]]'>): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
    alternates: { canonical: page.url },
    openGraph: {
      type: 'article',
      url: page.url,
      title: page.data.title,
      description: page.data.description,
    },
  };
}
