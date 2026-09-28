import type { ReactNode } from "react";
import { Nav } from "@/components/layout/Nav";
import { Footer } from "@/components/layout/Footer";
import { Prose } from "@/components/ui/Prose";

/** Shared shell + prose styling for the Privacy / Terms pages. */
export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <>
      <Nav />
      <main className="container max-w-3xl pt-32 pb-24 sm:pt-40">
        <a
          href="/"
          className="font-mono text-xs text-clay-600 transition-colors hover:text-clay"
        >
          ← Back to talyn.dev
        </a>
        <h1 className="mt-4 font-display text-4xl font-semibold tracking-tight text-ink">
          {title}
        </h1>
        <p className="mt-2 text-sm text-ink-400">Last updated {updated}</p>

        <Prose className="mt-10">{children}</Prose>
      </main>
      <Footer />
    </>
  );
}
