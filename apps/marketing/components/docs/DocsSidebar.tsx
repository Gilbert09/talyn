"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { DocsSearch } from "@/components/docs/DocsSearch";
import { cn } from "@/lib/utils";

export interface DocsNavTree {
  title: string;
  pages: Array<{ slug: string; label: string }>;
}

function NavList({
  tree,
  current,
  onNavigate,
}: {
  tree: DocsNavTree[];
  current: string | null;
  onNavigate?: () => void;
}) {
  return (
    <div className="space-y-6">
      <a
        href="/docs"
        onClick={onNavigate}
        aria-current={current === null ? "page" : undefined}
        className={cn(
          "block rounded-lg px-3 py-1.5 text-sm transition-colors",
          current === null
            ? "bg-clay-100/70 font-medium text-clay-600"
            : "text-ink-600 hover:bg-ink/[0.04] hover:text-ink"
        )}
      >
        Overview
      </a>
      {tree.map((section) => (
        <div key={section.title}>
          <p className="px-3 text-xs font-semibold uppercase tracking-wide text-ink-400">
            {section.title}
          </p>
          <ul className="mt-2 space-y-0.5">
            {section.pages.map((page) => {
              const active = page.slug === current;
              return (
                <li key={page.slug}>
                  <a
                    href={`/docs/${page.slug}`}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "block rounded-lg px-3 py-1.5 text-sm transition-colors",
                      active
                        ? "bg-clay-100/70 font-medium text-clay-600"
                        : "text-ink-600 hover:bg-ink/[0.04] hover:text-ink"
                    )}
                  >
                    {page.label}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * The docs navigation. A sticky column from `lg` up, and a collapsed
 * "Docs menu" disclosure below it, so a phone gets the page first and the
 * menu on demand.
 */
export function DocsSidebar({
  tree,
  current,
}: {
  tree: DocsNavTree[];
  /** The current page slug, or null on the docs landing page. */
  current: string | null;
}) {
  const [open, setOpen] = useState(false);
  const desktopNav = useRef<HTMLElement>(null);

  // Bring the current page's link into view in the scrolling sidebar, so a
  // page near the bottom of the list does not open with its link hidden.
  useEffect(() => {
    const nav = desktopNav.current;
    const link = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !link) return;
    const below = link.offsetTop + link.offsetHeight > nav.scrollTop + nav.clientHeight;
    if (below) nav.scrollTop = link.offsetTop - nav.clientHeight / 2;
  }, [current]);
  const currentLabel =
    current === null
      ? "Overview"
      : tree.flatMap((s) => s.pages).find((p) => p.slug === current)?.label ?? "Docs";

  return (
    <>
      {/* Phone and tablet. */}
      <div className="lg:hidden">
        <DocsSearch />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="docs-mobile-nav"
          className="mt-3 flex w-full items-center justify-between rounded-xl border border-line bg-paper-50 px-4 py-3 text-left text-sm"
        >
          <span className="min-w-0 truncate">
            <span className="text-ink-400">Docs menu: </span>
            <span className="font-medium text-ink">{currentLabel}</span>
          </span>
          <ChevronDown
            className={cn("h-4 w-4 shrink-0 text-ink-500 transition-transform", open && "rotate-180")}
          />
        </button>
        {open && (
          <nav
            id="docs-mobile-nav"
            aria-label="Docs"
            className="mt-2 rounded-xl border border-line bg-paper-50 p-3"
          >
            <NavList tree={tree} current={current} onNavigate={() => setOpen(false)} />
          </nav>
        )}
      </div>

      {/* Desktop. */}
      <div className="hidden min-h-0 flex-col lg:flex">
        <DocsSearch />
        <nav ref={desktopNav} aria-label="Docs" className="relative mt-6 min-h-0 overflow-y-auto pb-8 pr-2">
          <NavList tree={tree} current={current} />
        </nav>
      </div>
    </>
  );
}
