import { ChevronRight } from "lucide-react";
import type { Crumb } from "@/components/seo/JsonLd";

/**
 * The visible trail on a two-level page.
 *
 * The last crumb is the current page and is deliberately NOT a link — a link
 * to where you already are is noise to a reader and a self-referencing edge
 * to a crawler. It still appears in the `BreadcrumbList` schema, because
 * Google expects the final item to be there.
 */
export function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1 font-mono text-xs text-ink-400">
        {crumbs.map((crumb, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li key={crumb.href} className="flex items-center gap-1">
              {last ? (
                <span aria-current="page" className="text-ink-500">
                  {crumb.name}
                </span>
              ) : (
                <a
                  href={crumb.href}
                  className="transition-colors hover:text-clay-600"
                >
                  {crumb.name}
                </a>
              )}
              {!last && <ChevronRight className="h-3 w-3 text-ink-400/60" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
