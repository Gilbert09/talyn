import type { ReactNode } from "react";
import { Nav } from "@/components/layout/Nav";
import { Footer } from "@/components/layout/Footer";
import { DocsSidebar } from "@/components/docs/DocsSidebar";
import { CopyCode } from "@/components/docs/CopyCode";
import { docsNavTree, type DocHeading } from "@/lib/docs";

/**
 * The frame every docs page sits in: the site nav, a sidebar, the page, and
 * an "On this page" list on wide screens.
 */
export function DocsShell({
  current,
  headings = [],
  children,
}: {
  current: string | null;
  headings?: DocHeading[];
  children: ReactNode;
}) {
  const tree = docsNavTree();
  const toc = headings.filter((h) => h.depth === 2);

  return (
    <>
      <Nav />
      <CopyCode />
      <div className="container pt-24 pb-24 sm:pt-28">
        <div
          className={
            toc.length > 1
              ? "lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10 xl:grid-cols-[15rem_minmax(0,1fr)_12rem]"
              : "lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10"
          }
        >
          <aside className="lg:sticky lg:top-24 lg:z-30 lg:flex lg:max-h-[calc(100vh-7rem)] lg:flex-col lg:self-start">
            <DocsSidebar tree={tree} current={current} />
          </aside>

          <main className="mt-8 min-w-0 lg:mt-0">{children}</main>

          {toc.length > 1 && (
            <nav
              aria-label="On this page"
              className="hidden xl:sticky xl:top-24 xl:block xl:max-h-[calc(100vh-7rem)] xl:self-start xl:overflow-y-auto"
            >
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">
                On this page
              </p>
              <ul className="mt-3 space-y-2 border-l border-line">
                {toc.map((h) => (
                  <li key={h.id}>
                    <a
                      href={`#${h.id}`}
                      className="-ml-px block border-l border-transparent pl-3 text-[13px] leading-snug text-ink-500 transition-colors hover:border-clay-400 hover:text-ink"
                    >
                      {h.text}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </div>
      </div>
      <Footer />
    </>
  );
}
