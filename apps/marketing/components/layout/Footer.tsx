import { Logo } from "@/components/brand/Logo";
import { AsciiOwl } from "@/components/brand/AsciiOwl";
import { footer, site } from "@/lib/content";
import { isBlogEnabled } from "@/lib/flags";
import { listGuides } from "@/lib/guides";

export function Footer() {
  // Gated here rather than in content.ts, which is a plain copy file with no
  // business reading the environment. Company is the right column: the
  // writing is about how the thing is built, not a product surface.
  const withWriting = isBlogEnabled()
    ? footer.columns.map((col) =>
        col.title === "Company"
          ? { ...col, links: [{ label: "Writing", href: "/blog" }, ...col.links] }
          : col
      )
    : footer.columns;

  // Guides get a column of their own, built from the files rather than typed
  // out here. Without a link from somewhere on the site they are orphans —
  // reachable only from the sitemap, which is how a page ends up "crawled,
  // currently not indexed". A hand-kept list would also be one guide behind
  // from the first time somebody forgot.
  const guides = listGuides();
  const columns =
    guides.length > 0
      ? [
          ...withWriting,
          {
            title: "Guides",
            links: guides.map((g) => ({ label: g.navLabel, href: `/${g.slug}` })),
          },
        ]
      : withWriting;

  return (
    <footer className="border-t border-line bg-paper-100">
      {/* Four link columns now, so the brand block loses its fixed 1.4fr and
          shares a two-up layout at md before going five-across at lg —
          squeezing five columns into the md width made every one of them wrap. */}
      <div className="container grid gap-10 py-14 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-[1.3fr_1fr_1fr_1fr_1.1fr]">
        <div>
          <Logo />
          <p className="mt-4 max-w-xs text-sm text-ink-500">{footer.blurb}</p>
          <div className="mt-5">
            <AsciiOwl className="animate-blink" />
          </div>
        </div>

        {columns.map((col) => (
          <div key={col.title}>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
              {col.title}
            </h4>
            <ul className="mt-4 space-y-2.5">
              {col.links.map((l) => (
                <li key={l.label}>
                  <a
                    href={l.href}
                    className="text-sm text-ink-600 transition-colors hover:text-clay-600"
                  >
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="border-t border-line">
        <div className="container flex flex-col items-center justify-between gap-3 py-6 text-xs text-ink-400 sm:flex-row">
          <p>
            © {new Date().getFullYear()} {site.name}. {footer.madeBy}
          </p>
          <p className="font-mono">{site.domain}</p>
        </div>
      </div>
    </footer>
  );
}
