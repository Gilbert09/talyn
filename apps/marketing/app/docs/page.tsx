import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import { DocsShell } from "@/components/docs/DocsShell";
import { site } from "@/lib/content";
import { DOCS_NAV, getDoc } from "@/lib/docs";

const title = "Talyn docs: sessions, sandboxes, pull requests and API";
const description =
  "How to set up Talyn, run agent sessions in cloud sandboxes, fix and review pull requests, automate the routine work, and use the API.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "/docs" },
  openGraph: {
    type: "website",
    title,
    description,
    url: `${site.url}/docs`,
  },
  twitter: { card: "summary_large_image", title, description },
};

const START_HERE = [
  {
    slug: "quickstart",
    blurb: "Sign in, connect GitHub and an agent, and start your first session.",
  },
  {
    slug: "sessions",
    blurb: "How sessions, threads and sandboxes fit together.",
  },
  {
    slug: "api",
    blurb: "Create a token and drive Talyn from your own scripts.",
  },
];

export default function DocsIndex() {
  return (
    <DocsShell current={null}>
      <p className="text-xs font-semibold uppercase tracking-wide text-clay-600">Docs</p>
      <h1 className="mt-2 font-display text-3xl font-semibold leading-tight tracking-tight text-ink sm:text-4xl">
        Talyn documentation
      </h1>
      <p className="mt-3 max-w-2xl text-lg leading-relaxed text-ink-600">
        Talyn gives every task its own coding agent in its own cloud sandbox, and helps you get
        the pull requests merged. These pages show you how to set it up and use it.
      </p>

      <div className="mt-10 grid gap-3 sm:grid-cols-3">
        {START_HERE.map((item) => {
          const doc = getDoc(item.slug);
          if (!doc) return null;
          return (
            <a
              key={item.slug}
              href={`/docs/${item.slug}`}
              className="group rounded-2xl border border-line bg-paper-50 p-5 transition-colors hover:border-clay-300"
            >
              <span className="flex items-center justify-between font-display text-base font-semibold text-ink">
                {doc.title}
                <ArrowRight className="h-4 w-4 text-ink-400 transition-transform group-hover:translate-x-0.5 group-hover:text-clay-600" />
              </span>
              <span className="mt-1.5 block text-sm leading-relaxed text-ink-500">{item.blurb}</span>
            </a>
          );
        })}
      </div>

      <div className="mt-14 grid gap-x-10 gap-y-10 md:grid-cols-2">
        {DOCS_NAV.map((section) => (
          <section key={section.title}>
            <h2 className="font-display text-lg font-semibold text-ink">{section.title}</h2>
            <ul className="mt-3 space-y-3">
              {section.slugs.map((slug) => {
                const doc = getDoc(slug);
                if (!doc) return null;
                return (
                  <li key={slug}>
                    <a href={`/docs/${slug}`} className="group block">
                      <span className="text-[15px] font-medium text-clay-600 underline-offset-2 group-hover:underline">
                        {doc.title}
                      </span>
                      <span className="mt-0.5 block text-sm leading-relaxed text-ink-500">
                        {doc.description}
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>

      <p className="mt-14 max-w-2xl text-sm text-ink-500">
        Something missing or wrong? Open an issue on{" "}
        <a
          href={site.supportUrl}
          className="text-clay-600 underline underline-offset-2"
          target="_blank"
          rel="noreferrer"
        >
          GitHub
        </a>
        .
      </p>
    </DocsShell>
  );
}
