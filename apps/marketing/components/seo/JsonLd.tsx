import { site } from "@/lib/content";

/**
 * Structured data, emitted as a `<script type="application/ld+json">`.
 *
 * The site carried none at all before this. Next's `metadata` export cannot
 * express schema.org, so the documented App Router answer is a script tag in
 * the page body — it does not need to be in `<head>` and Google reads it
 * either way.
 *
 * `JSON.stringify` rather than a template literal, deliberately: every value
 * below comes from our own content files today, but a hand-built JSON string
 * is one interpolated apostrophe away from invalid markup, and invalid
 * structured data fails silently rather than loudly.
 */
export function JsonLd({ data }: { data: object | object[] }) {
  return (
    <script
      type="application/ld+json"
      // Stringified, not user input, and React escapes nothing inside a
      // script tag — which is exactly why the content must stay ours.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}

export interface Crumb {
  name: string;
  /** Path relative to the site root, with a leading slash. */
  href: string;
}

/**
 * `BreadcrumbList` for a sub-page.
 *
 * Takes the same `Crumb[]` the visible `<Breadcrumbs>` renders, so the trail a
 * person reads and the trail Google reads cannot drift apart. Google shows
 * breadcrumbs in place of the raw URL in a result, which is the whole reason
 * this exists on a two-level path.
 */
export function breadcrumbSchema(crumbs: Crumb[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((crumb, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: crumb.name,
      item: `${site.url}${crumb.href}`,
    })),
  };
}

/**
 * `FAQPage` from the same question list the accordion renders.
 *
 * Google's guidance is that the answer must be visible on the page, so this
 * never takes copy of its own — pass the array the component was given.
 */
export function faqSchema(items: ReadonlyArray<{ q: string; a: string }>) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  };
}

/** `Article`, for the guides and blog posts. */
export function articleSchema({
  title,
  description,
  path,
  published,
  modified,
}: {
  title: string;
  description: string;
  path: string;
  published?: string;
  modified?: string;
}) {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: title,
    description,
    mainEntityOfPage: `${site.url}${path}`,
    ...(published ? { datePublished: published } : {}),
    ...(modified ? { dateModified: modified } : {}),
    author: { "@type": "Organization", name: site.name, url: site.url },
    publisher: { "@type": "Organization", name: site.name, url: site.url },
  };
}
