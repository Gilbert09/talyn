"use client";

import { useEffect, useState } from "react";
import { Menu, X, Download } from "lucide-react";
import { Logo } from "@/components/brand/Logo";
import { Button } from "@/components/ui/button";
import { nav, site } from "@/lib/content";
import { cn } from "@/lib/utils";

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 transition-all duration-300",
        scrolled
          ? "border-b border-white/[0.06] bg-ink/70 backdrop-blur-xl"
          : "border-b border-transparent"
      )}
    >
      <nav className="container flex h-16 items-center justify-between">
        <a href="#top" aria-label="Talyn home">
          <Logo />
        </a>

        <div className="hidden items-center gap-1 md:flex">
          {nav.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="rounded-lg px-3 py-2 text-sm text-owl-50/70 transition-colors hover:text-white"
            >
              {item.label}
            </a>
          ))}
        </div>

        <div className="hidden items-center gap-2 md:flex">
          <a href={site.githubUrl} target="_blank" rel="noreferrer">
            <Button variant="ghost" size="sm">
              GitHub
            </Button>
          </a>
          <a href={site.downloadUrl}>
            <Button size="sm">
              <Download className="h-4 w-4" />
              Download
            </Button>
          </a>
        </div>

        <button
          className="rounded-lg p-2 text-white md:hidden"
          onClick={() => setOpen((v) => !v)}
          aria-label="Toggle menu"
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </nav>

      {open && (
        <div className="border-t border-white/[0.06] bg-ink/95 px-6 py-4 backdrop-blur-xl md:hidden">
          <div className="flex flex-col gap-1">
            {nav.map((item) => (
              <a
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-2.5 text-sm text-owl-50/80 hover:bg-white/[0.05]"
              >
                {item.label}
              </a>
            ))}
            <a href={site.downloadUrl} onClick={() => setOpen(false)} className="mt-2">
              <Button className="w-full">
                <Download className="h-4 w-4" />
                Download for Mac
              </Button>
            </a>
          </div>
        </div>
      )}
    </header>
  );
}
