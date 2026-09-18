import type { MetadataRoute } from "next";
import { site } from "@/lib/content";
import { isBlogEnabled } from "@/lib/flags";
import { listPosts } from "@/lib/posts";

export default function sitemap(): MetadataRoute.Sitemap {
  const staticPages: MetadataRoute.Sitemap = [
    {
      url: site.url,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${site.url}/privacy`,
      changeFrequency: "monthly",
      priority: 0.3,
    },
    {
      url: `${site.url}/terms`,
      changeFrequency: "monthly",
      priority: 0.3,
    },
  ];

  // Nothing about the blog is listed while it is gated. A sitemap is an
  // invitation to crawl, so this is the surface that would do the most damage
  // by leaking a URL the section gate is meant to be withholding — and drafts
  // are excluded even once it is on.
  if (!isBlogEnabled()) return staticPages;

  const posts = listPosts().filter((post) => !post.draft);

  return [
    ...staticPages,
    {
      url: `${site.url}/blog`,
      changeFrequency: "weekly",
      priority: 0.7,
    },
    ...posts.map((post) => ({
      url: `${site.url}/blog/${post.slug}`,
      lastModified: new Date(`${post.date}T00:00:00Z`),
      changeFrequency: "yearly" as const,
      priority: 0.6,
    })),
  ];
}
