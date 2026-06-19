import { Logo } from "@/components/brand/Logo";
import { AsciiOwl } from "@/components/brand/AsciiOwl";
import { footer, site } from "@/lib/content";

export function Footer() {
  return (
    <footer className="border-t border-line bg-paper-100">
      <div className="container grid gap-10 py-14 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div>
          <Logo />
          <p className="mt-4 max-w-xs text-sm text-ink-500">{footer.blurb}</p>
          <div className="mt-5">
            <AsciiOwl className="animate-blink" />
          </div>
        </div>

        {footer.columns.map((col) => (
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
