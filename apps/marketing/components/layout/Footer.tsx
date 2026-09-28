import { Logo } from "@/components/brand/Logo";
import { AsciiOwl } from "@/components/brand/AsciiOwl";
import { footer, site } from "@/lib/content";
import { isBlogEnabled } from "@/lib/flags";
import { listGuides } from "@/lib/guides";
import { listFeaturePages } from "@/lib/features";
import { listComparePages } from "@/lib/compare";

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

  // Features, comparisons and guides all get columns built from the files
  // rather than typed out here. Without a link from somewhere on the site
  // they are orphans — reachable only from the sitemap, which is how a page
  // ends up "crawled, currently not indexed". A hand-kept list would also be
  // one page behind from the first time somebody forgot.
  const generated = [
    {
      title: "Features",
      links: listFeaturePages().map((f) => ({
        label: f.navLabel,
        href: `/features/${f.slug}`,
      })),
    },
    {
      title: "Compare",
      links: listComparePages().map((c) => ({
        label: c.navLabel,
        href: `/compare/${c.slug}`,
      })),
    },
    {
      title: "Guides",
      links: listGuides().map((g) => ({ label: g.navLabel, href: `/${g.slug}` })),
    },
  ].filter((col) => col.links.length > 0);

  const columns = [...withWriting, ...generated];

  return (
    <footer className="border-t border-line bg-paper-100">
      {/* The brand block sits ABOVE the link row rather than beside it. It
          used to be the first cell of a five-column grid; with six columns
          every one of them wrapped to two lines at lg, and squeezing them
          into the md width was worse. Splitting the two means the link
          columns get the full container. */}
      <div className="container py-14">
        <div className="flex flex-wrap items-end justify-between gap-8">
          <div>
            <Logo />
            <p className="mt-4 max-w-xs text-sm text-ink-500">{footer.blurb}</p>
          </div>
          <AsciiOwl className="animate-blink" />
        </div>

        <div className="mt-12 grid gap-10 border-t border-line pt-10 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
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
