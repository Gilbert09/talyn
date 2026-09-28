"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Menu, X } from "lucide-react";
import { Logo } from "@/components/brand/Logo";
import { Button } from "@/components/ui/button";
import { DownloadButton } from "@/components/ui/DownloadButton";
import { WebAppButton } from "@/components/ui/WebAppButton";
import { nav, site, type NavItem } from "@/lib/content";
import { listFeaturePages } from "@/lib/features";
import { isBlogEnabled } from "@/lib/flags";
import { cn } from "@/lib/utils";

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [mobileGroup, setMobileGroup] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Build-time constant, inlined into this bundle — not a runtime flag and not
  // a reason to re-render. Every other nav item is defined in content.ts, so
  // this is appended rather than living there.
  const links: NavItem[] = isBlogEnabled()
    ? [...nav, { label: "Writing", href: "blog" }]
    : nav;

  // Read from lib/features.ts rather than a list typed into content.ts, for
  // the reason the footer already reads its Guides column from listGuides():
  // a hand-kept copy is one page behind the first time somebody forgets. The
  // module is plain data with a type-only import, so pulling it into the
  // client bundle costs nothing at runtime.
  const features = listFeaturePages();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Escape closes the open menu, and a click anywhere outside it does too.
  // Without the first, a keyboard user who opens the menu has no way back out
  // except tabbing through every item in it.
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    const onClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [menu]);

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 transition-all duration-300",
        scrolled
          ? "border-b border-line bg-paper/80 backdrop-blur-xl"
          : "border-b border-transparent"
      )}
    >
      <nav className="container relative flex h-16 items-center justify-between gap-4">
        <a href="/#top" aria-label="Talyn home" className="shrink-0">
          <Logo />
        </a>

        {/* In FLOW and right-aligned, so the links sit against the button
            group rather than floating in the middle.
            It used to be `absolute left-1/2 -translate-x-1/2`, which takes the
            row out of the layout entirely — so it could not push the buttons
            aside, only sit on top of them. The old comment called that a
            md-width problem and dropped to a hamburger below lg; it was really
            a content-width problem, and it came back the moment the row grew.
            A flex child with `flex-1 justify-end` cannot overlap anything,
            because it is participating in the layout: the worst case is
            compression, not collision. */}
        <div
          ref={menuRef}
          className="hidden min-w-0 flex-1 items-center justify-end gap-1 lg:flex"
          // Leaving the whole row closes the menu. Scoped to the row rather
          // than the panel so moving diagonally from the trigger to an item
          // does not shut it mid-travel.
          onMouseLeave={() => setMenu(null)}
        >
          {links.map((item) =>
            item.group === "features" ? (
              <div key={item.href} className="relative">
                <button
                  className="flex items-center gap-1 whitespace-nowrap rounded-lg px-3 py-2 text-sm text-ink-600 transition-colors hover:text-ink"
                  aria-expanded={menu === item.href}
                  aria-haspopup="true"
                  onMouseEnter={() => setMenu(item.href)}
                  onClick={() => setMenu(menu === item.href ? null : item.href)}
                >
                  {item.label}
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 transition-transform",
                      menu === item.href && "rotate-180"
                    )}
                  />
                </button>

                {menu === item.href && (
                  <div className="absolute left-1/2 top-full z-50 w-[36rem] -translate-x-1/2 pt-2">
                    <div className="rounded-2xl border border-line bg-paper/95 p-2 shadow-soft backdrop-blur-xl">
                      <div className="grid grid-cols-2 gap-0.5">
                        {features.map((f) => (
                          <a
                            key={f.slug}
                            href={`/features/${f.slug}`}
                            onClick={() => setMenu(null)}
                            className="rounded-xl px-3 py-2.5 transition-colors hover:bg-ink/[0.04]"
                          >
                            <span className="block text-sm font-medium text-ink">
                              {f.navLabel}
                            </span>
                            {/* tagline, not eyebrow: the eyebrow is the
                                page's own kicker and restates the feature
                                name, which under the name reads "Loops /
                                Loops". */}
                            <span className="mt-0.5 block text-xs leading-snug text-ink-400">
                              {f.tagline}
                            </span>
                          </a>
                        ))}
                      </div>
                      <a
                        href={`/${item.href}`}
                        onClick={() => setMenu(null)}
                        className="mt-1 block border-t border-line px-3 py-2.5 text-sm text-clay-600 transition-colors hover:text-clay"
                      >
                        Everything Talyn does →
                      </a>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <a
                key={item.href}
                href={`/${item.href}`}
                onMouseEnter={() => setMenu(null)}
                className="whitespace-nowrap rounded-lg px-3 py-2 text-sm text-ink-600 transition-colors hover:text-ink"
              >
                {item.label}
              </a>
            )
          )}
        </div>

        <div className="hidden shrink-0 items-center gap-2 lg:flex">
          <a href={site.githubUrl} target="_blank" rel="noreferrer">
            <Button variant="ghost" size="sm">
              GitHub
            </Button>
          </a>
          <WebAppButton size="sm" placement="nav" showArrow={false}>
            Open app
          </WebAppButton>
          {/* No children, so the label resolves to "Download for Windows" and
              the rest at runtime. It used to be the literal string "Download",
              which overrode that — and this is the button that matters: 29 of
              the 30 real download clicks last month came from here, against
              one from the hero, at a median 27 seconds on the page. People are
              not reading the hero; they are scanning the bar for the button,
              and it should say which file they are about to get. */}
          <DownloadButton size="sm" placement="nav" />
        </div>

        <button
          className="rounded-lg p-2 text-ink lg:hidden"
          onClick={() => setOpen((v) => !v)}
          aria-label="Toggle menu"
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </nav>

      {open && (
        <div className="max-h-[calc(100dvh-4rem)] overflow-y-auto border-t border-line bg-paper/95 px-6 py-4 backdrop-blur-xl lg:hidden">
          <div className="flex flex-col gap-1">
            {links.map((item) =>
              item.group === "features" ? (
                <div key={item.href}>
                  {/* Expandable rather than a link, because a tap that both
                      navigates and reveals is a tap that does the wrong one
                      of the two. The section link sits inside, once open. */}
                  <button
                    onClick={() =>
                      setMobileGroup(mobileGroup === item.href ? null : item.href)
                    }
                    aria-expanded={mobileGroup === item.href}
                    className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-sm text-ink-600 hover:bg-ink/[0.04]"
                  >
                    {item.label}
                    <ChevronDown
                      className={cn(
                        "h-4 w-4 transition-transform",
                        mobileGroup === item.href && "rotate-180"
                      )}
                    />
                  </button>
                  {mobileGroup === item.href && (
                    <div className="ml-3 border-l border-line pl-3">
                      {features.map((f) => (
                        <a
                          key={f.slug}
                          href={`/features/${f.slug}`}
                          onClick={() => setOpen(false)}
                          className="block rounded-lg px-3 py-2 text-sm text-ink-500 hover:bg-ink/[0.04]"
                        >
                          {f.navLabel}
                        </a>
                      ))}
                      <a
                        href={`/${item.href}`}
                        onClick={() => setOpen(false)}
                        className="block rounded-lg px-3 py-2 text-sm text-clay-600"
                      >
                        Everything Talyn does →
                      </a>
                    </div>
                  )}
                </div>
              ) : (
                <a
                  key={item.href}
                  href={`/${item.href}`}
                  onClick={() => setOpen(false)}
                  className="rounded-lg px-3 py-2.5 text-sm text-ink-600 hover:bg-ink/[0.04]"
                >
                  {item.label}
                </a>
              )
            )}
            <div onClick={() => setOpen(false)} className="mt-2 flex flex-col gap-2">
              <WebAppButton
                size="md"
                className="w-full"
                placement="nav-mobile"
                showArrow={false}
              >
                Open app
              </WebAppButton>
              {/* No hardcoded platform — DownloadButton resolves it at runtime
                  now that macOS, Windows and Linux all ship. */}
              <DownloadButton size="md" className="w-full" placement="nav-mobile" />
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
