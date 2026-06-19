import type { ReactNode } from "react";
import { Nav } from "@/components/layout/Nav";
import { Footer } from "@/components/layout/Footer";

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

        <div
          className="
            mt-10 space-y-5 text-ink-600 leading-relaxed
            [&_h2]:mt-10 [&_h2]:font-display [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-ink
            [&_p]:text-[15px]
            [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6 [&_ul]:text-[15px]
            [&_a]:text-clay-600 [&_a]:underline [&_a]:underline-offset-2
            [&_strong]:font-semibold [&_strong]:text-ink
          "
        >
          {children}
        </div>
      </main>
      <Footer />
    </>
  );
}
