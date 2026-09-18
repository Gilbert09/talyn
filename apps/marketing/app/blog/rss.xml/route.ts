import { isBlogEnabled } from "@/lib/flags";
import { listPosts } from "@/lib/posts";
import { site } from "@/lib/content";

/**
 * The RSS feed.
 *
 * Statically generated with the rest of the site — this route reads no
 * request, so Next renders it once at build time rather than on demand.
 * Aggregators and newsletter syndicators are how a write-up reaches people who
 * will never visit the site, which is most of them.
 */
export const dynamic = "force-static";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function GET(): Response {
  // Gated like every other blog surface. A feed is a list of URLs, so serving
  // one while the section is dark would hand out exactly what the gate exists
  // to withhold.
  if (!isBlogEnabled()) {
    return new Response("Not found", { status: 404 });
  }

  const posts = listPosts().filter((p) => !p.draft);
  const updated = posts[0]?.date;

  const items = posts
    .map((post) => {
      const url = `${site.url}/blog/${post.slug}`;
      return [
        "    <item>",
        `      <title>${escapeXml(post.title)}</title>`,
        `      <link>${escapeXml(url)}</link>`,
        `      <guid isPermaLink="true">${escapeXml(url)}</guid>`,
        `      <description>${escapeXml(post.description)}</description>`,
        `      <pubDate>${new Date(`${post.date}T00:00:00Z`).toUTCString()}</pubDate>`,
        "    </item>",
      ].join("\n");
    })
    .join("\n");

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    `    <title>${escapeXml(`${site.name} — Writing`)}</title>`,
    `    <link>${site.url}/blog</link>`,
    `    <description>${escapeXml(site.description)}</description>`,
    "    <language>en-GB</language>",
    `    <atom:link href="${site.url}/blog/rss.xml" rel="self" type="application/rss+xml" />`,
    ...(updated
      ? [`    <lastBuildDate>${new Date(`${updated}T00:00:00Z`).toUTCString()}</lastBuildDate>`]
      : []),
    items,
    "  </channel>",
    "</rss>",
  ]
    .filter(Boolean)
    .join("\n");

  return new Response(xml, {
    headers: { "content-type": "application/rss+xml; charset=utf-8" },
  });
}
