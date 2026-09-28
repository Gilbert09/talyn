import type { MetadataRoute } from "next";
import { site } from "@/lib/content";
import { isBlogEnabled } from "@/lib/flags";
import { listPosts } from "@/lib/posts";
import { listGuides } from "@/lib/guides";
import { listFeaturePages } from "@/lib/features";
import { listComparePages } from "@/lib/compare";

export default function sitemap(): MetadataRoute.Sitemap {
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

  const staticPages: MetadataRoute.Sitemap = [
    {
      url: site.url,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${site.url}/features`,
      changeFrequency: "weekly",
      priority: 0.9,
    },
    {
      url: `${site.url}/compare`,
      changeFrequency: "monthly",
      priority: 0.7,
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

  const always = [...staticPages, ...features, ...comparisons, ...guides];

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
