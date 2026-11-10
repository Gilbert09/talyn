import type { MetadataRoute } from "next";
import { site } from "@/lib/content";
import { isBlogEnabled } from "@/lib/flags";
import { listPosts } from "@/lib/posts";
import { listGuides } from "@/lib/guides";
import { listFeaturePages } from "@/lib/features";
import { listComparePages } from "@/lib/compare";
import { listDocs } from "@/lib/docs";

const day = (d: string) => new Date(`${d}T00:00:00Z`);

/** The newest of a list of ISO dates, for a hub page that lists them. */
function newest(dates: string[]): Date {
  return day([...dates].sort().at(-1) ?? site.updated);
}

export default function sitemap(): MetadataRoute.Sitemap {
  const siteUpdated = day(site.updated);
  // Guides are ungated — unlike the blog, each ships complete or not at all,
  // and a landing page nobody can crawl earns nothing.
  const guides: MetadataRoute.Sitemap = listGuides().map((guide) => ({
    url: `${site.url}/${guide.slug}`,
    lastModified: new Date(`${guide.updated}T00:00:00Z`),
    changeFrequency: "monthly" as const,
    priority: 0.8,
  }));

  // Feature pages sit just below the home page: each one is the answer to a
  // query somebody actually types, and each is where its internal links point.
  const features: MetadataRoute.Sitemap = listFeaturePages().map((feature) => ({
    url: `${site.url}/features/${feature.slug}`,
    lastModified: new Date(`${feature.updated}T00:00:00Z`),
    changeFrequency: "monthly" as const,
    priority: 0.9,
  }));

  const comparisons: MetadataRoute.Sitemap = listComparePages().map((page) => ({
    url: `${site.url}/compare/${page.slug}`,
    lastModified: new Date(`${page.updated}T00:00:00Z`),
    changeFrequency: "monthly" as const,
    priority: 0.8,
  }));

  const docs: MetadataRoute.Sitemap = [
    {
      url: `${site.url}/docs`,
      lastModified: siteUpdated,
      changeFrequency: "weekly" as const,
      priority: 0.8,
    },
    ...listDocs().map((doc) => ({
      url: `${site.url}/docs/${doc.slug}`,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
  ];

  const staticPages: MetadataRoute.Sitemap = [
    {
      url: site.url,
      lastModified: siteUpdated,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${site.url}/features`,
      lastModified: newest(listFeaturePages().map((f) => f.updated)),
      changeFrequency: "weekly",
      priority: 0.9,
    },
    {
      url: `${site.url}/pricing`,
      lastModified: siteUpdated,
      changeFrequency: "monthly",
      priority: 0.9,
    },
    {
      url: `${site.url}/download`,
      lastModified: siteUpdated,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${site.url}/compare`,
      lastModified: newest(listComparePages().map((c) => c.updated)),
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${site.url}/about`,
      lastModified: siteUpdated,
      changeFrequency: "monthly",
      priority: 0.5,
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

  const always = [...staticPages, ...features, ...comparisons, ...guides, ...docs];

  // Nothing about the blog is listed while it is gated. A sitemap is an
  // invitation to crawl, so this is the surface that would do the most damage
  // by leaking a URL the section gate is meant to be withholding — and drafts
  // are excluded even once it is on.
  if (!isBlogEnabled()) return always;

  const posts = listPosts().filter((post) => !post.draft);

  return [
    ...always,
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
