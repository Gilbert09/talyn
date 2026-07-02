import type { MetadataRoute } from "next";
import { site } from "@/lib/content";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
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
}
