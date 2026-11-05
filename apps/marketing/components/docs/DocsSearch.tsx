"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Client-side search over a static JSON index (`/docs/search.json`), built
 * at the same time as the pages. No service, no dependency: the whole docs
 * section is a few dozen pages, which a substring scan handles in well under
 * a frame.
 *
 * The index is fetched on first focus, not on page load, so a reader who
 * never searches never downloads it.
 */

export interface SearchEntry {
  slug: string;
  title: string;
  section: string;
  description: string;
  headings: Array<{ id: string; text: string }>;
  text: string;
}

interface Result {
  href: string;
  title: string;
  context: string;
  snippet: string;
  score: number;
}

let indexPromise: Promise<SearchEntry[]> | null = null;

function loadIndex(): Promise<SearchEntry[]> {
  if (!indexPromise) {
    indexPromise = fetch("/docs/search.json")
      .then((r) => (r.ok ? (r.json() as Promise<SearchEntry[]>) : []))
      .catch(() => {
        indexPromise = null;
        return [];
      });
  }
  return indexPromise;
}

function snippetAround(text: string, term: string): string {
  const i = text.toLowerCase().indexOf(term);
  if (i < 0) return "";
  const start = Math.max(0, i - 50);
  const end = Math.min(text.length, i + term.length + 70);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function search(index: SearchEntry[], query: string): Result[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const results: Result[] = [];

  for (const doc of index) {
    const title = doc.title.toLowerCase();
    const description = doc.description.toLowerCase();
    const body = doc.text.toLowerCase();
    // Every term must appear somewhere on the page.
    if (!terms.every((t) => title.includes(t) || description.includes(t) || body.includes(t))) {
      continue;
    }

    let score = 0;
    for (const t of terms) {
      if (title.includes(t)) score += 10;
      if (description.includes(t)) score += 3;
      if (body.includes(t)) score += 1;
    }

    // Point at the best-matching heading when one carries the terms.
    const heading = doc.headings.find((h) => {
      const text = h.text.toLowerCase();
      return terms.every((t) => text.includes(t));
    });
    if (heading) score += 5;

    results.push({
      href: heading ? `/docs/${doc.slug}#${heading.id}` : `/docs/${doc.slug}`,
      title: doc.title,
      context: heading ? `${doc.section} · ${heading.text}` : doc.section,
      snippet: snippetAround(doc.text, terms[0]) || doc.description,
      score,
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 8);
}

export function DocsSearch({ className }: { className?: string }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState<SearchEntry[] | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const results = useMemo(() => (index ? search(index, query) : []), [index, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const onFocus = () => {
    setOpen(true);
    if (!index) loadIndex().then(setIndex);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setOpen(false);
      (e.target as HTMLInputElement).blur();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && results[active]) {
      window.location.href = results[active].href;
    }
  };

  const showPanel = open && query.trim().length > 0;

  return (
    <div ref={wrapRef} className={cn("relative", className)}>
      <label className="flex items-center gap-2 rounded-xl border border-line bg-paper-50 px-3 py-2 text-sm focus-within:border-clay-300">
        <Search className="h-4 w-4 shrink-0 text-ink-400" aria-hidden />
        <span className="sr-only">Search the docs</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={onFocus}
          onKeyDown={onKeyDown}
          placeholder="Search the docs"
          className="w-full min-w-0 bg-transparent text-ink outline-none placeholder:text-ink-400"
          role="combobox"
          aria-controls={listId}
          aria-expanded={showPanel}
          aria-autocomplete="list"
        />
      </label>

      {showPanel && (
        <div className="absolute inset-x-0 top-full z-40 mt-2 max-h-[60vh] overflow-y-auto rounded-xl border border-line bg-paper-50 p-1.5 shadow-soft lg:w-[26rem]">
          {!index ? (
            <p className="px-3 py-2 text-sm text-ink-400">Loading…</p>
          ) : results.length === 0 ? (
            <p className="px-3 py-2 text-sm text-ink-400">No pages match.</p>
          ) : (
            <ul role="listbox" id={listId}>
              {results.map((r, i) => (
                <li key={r.href} role="option" aria-selected={i === active}>
                  <a
                    href={r.href}
                    onMouseEnter={() => setActive(i)}
                    className={cn(
                      "block rounded-lg px-3 py-2",
                      i === active ? "bg-ink/[0.05]" : "hover:bg-ink/[0.04]"
                    )}
                  >
                    <span className="block text-sm font-medium text-ink">{r.title}</span>
                    <span className="block text-xs text-ink-400">{r.context}</span>
                    {r.snippet && (
                      <span className="mt-1 line-clamp-2 block text-xs leading-snug text-ink-500">
                        {r.snippet}
                      </span>
                    )}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
