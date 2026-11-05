import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { DocsShell } from "@/components/docs/DocsShell";
import { Prose } from "@/components/ui/Prose";
import { Breadcrumbs } from "@/components/layout/Breadcrumbs";
import { JsonLd, breadcrumbSchema, type Crumb } from "@/components/seo/JsonLd";
import { site } from "@/lib/content";
import { docNeighbours, getDoc, listDocs } from "@/lib/docs";

export function generateStaticParams() {
  return listDocs().map((d) => ({ slug: d.slug }));
}

export const dynamicParams = false;

interface Params {
  params: { slug: string };
}

export function generateMetadata({ params }: Params): Metadata {
  const doc = getDoc(params.slug);
  if (!doc) return {};
  const title = `${doc.title} · Talyn docs`;
  return {
    title: { absolute: title },
    description: doc.description,
    alternates: { canonical: `/docs/${doc.slug}` },
    openGraph: {
      type: "article",
      title,
      description: doc.description,
      url: `${site.url}/docs/${doc.slug}`,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: doc.description,
    },
  };
}

export default function DocPage({ params }: Params) {
  const doc = getDoc(params.slug);
  if (!doc) notFound();
  const { prev, next } = docNeighbours(doc.slug);

  const crumbs: Crumb[] = [
    { name: "Docs", href: "/docs" },
    { name: doc.title, href: `/docs/${doc.slug}` },
  ];

  return (
    <DocsShell current={doc.slug} headings={doc.headings}>
      <Breadcrumbs crumbs={crumbs} />
      <p className="mt-6 text-xs font-semibold uppercase tracking-wide text-clay-600">
        {doc.section}
      </p>
      <h1 className="mt-2 font-display text-3xl font-semibold leading-tight tracking-tight text-ink sm:text-4xl">
        {doc.title}
      </h1>
      <p className="mt-3 text-lg leading-relaxed text-ink-600">{doc.description}</p>

      <Prose as="article" className="docs-prose mt-8 max-w-3xl" html={doc.html} />

      <nav
        aria-label="Previous and next pages"
        className="mt-14 grid max-w-3xl gap-3 border-t border-line pt-6 sm:grid-cols-2"
      >
        {prev ? (
          <a
            href={`/docs/${prev.slug}`}
            className="group rounded-xl border border-line px-4 py-3 transition-colors hover:border-clay-300"
          >
            <span className="flex items-center gap-1 text-xs text-ink-400">
              <ArrowLeft className="h-3 w-3" /> Previous
            </span>
            <span className="mt-1 block text-sm font-medium text-ink group-hover:text-clay-600">
              {prev.title}
            </span>
          </a>
        ) : (
          <span className="hidden sm:block" />
        )}
        {next && (
          <a
            href={`/docs/${next.slug}`}
            className="group rounded-xl border border-line px-4 py-3 text-right transition-colors hover:border-clay-300"
          >
            <span className="flex items-center justify-end gap-1 text-xs text-ink-400">
              Next <ArrowRight className="h-3 w-3" />
            </span>
            <span className="mt-1 block text-sm font-medium text-ink group-hover:text-clay-600">
              {next.title}
            </span>
          </a>
        )}
      </nav>

      <JsonLd
        data={[
          breadcrumbSchema(crumbs),
          {
            "@context": "https://schema.org",
            "@type": "TechArticle",
            headline: doc.title,
            description: doc.description,
            url: `${site.url}/docs/${doc.slug}`,
          },
        ]}
      />
    </DocsShell>
  );
}
