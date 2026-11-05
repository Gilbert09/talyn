import { listDocs } from "@/lib/docs";
import type { SearchEntry } from "@/components/docs/DocsSearch";

/**
 * The docs search index, written once at build time as a static file.
 * `components/docs/DocsSearch.tsx` fetches it on first focus.
 */
export const dynamic = "force-static";

export function GET() {
  const entries: SearchEntry[] = listDocs().map((d) => ({
    slug: d.slug,
    title: d.title,
    section: d.section,
    description: d.description,
    headings: d.headings.map((h) => ({ id: h.id, text: h.text })),
    text: d.text,
  }));
  return Response.json(entries);
}
