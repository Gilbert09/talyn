import type { Metadata } from "next";
import { Globe, Laptop, Monitor, Terminal } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Nav } from "@/components/layout/Nav";
import { Footer } from "@/components/layout/Footer";
import { Breadcrumbs } from "@/components/layout/Breadcrumbs";
import { DownloadButton, type PlatformKey } from "@/components/ui/DownloadButton";
import { WebAppButton } from "@/components/ui/WebAppButton";
import { Reveal } from "@/components/ui/Reveal";
import { JsonLd, breadcrumbSchema, type Crumb } from "@/components/seo/JsonLd";
import { site } from "@/lib/content";

const title = "Download Talyn";
const description =
  "Talyn for macOS, Windows and Linux, or open it in your browser. Same account, same sessions and pull requests on every one.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/download" },
  openGraph: {
    type: "website",
    title,
    description,
    url: `${site.url}/download`,
  },
};

const crumbs: Crumb[] = [
  { name: "Talyn", href: "/" },
  { name: "Download", href: "/download" },
];

const RELEASES_URL = `${site.githubUrl}/releases`;

const platforms: Array<{
  key: PlatformKey;
  name: string;
  icon: LucideIcon;
  file: string;
  note: string;
}> = [
  {
    key: "mac",
    name: "macOS",
    icon: Laptop,
    file: "Apple silicon .dmg, signed and notarized",
    note: "On an Intel Mac, take the x64 build from the releases page.",
  },
  {
    key: "windows",
    name: "Windows",
    icon: Monitor,
    file: "Installer (.exe)",
    note: "The installer is not signed yet. SmartScreen will warn you on first install: choose More info, then Run anyway.",
  },
  {
    key: "linux",
    name: "Linux",
    icon: Terminal,
    file: "AppImage",
    note: "Make it executable with chmod +x, then run it.",
  },
];

export default function DownloadPage() {
  return (
    <>
      <Nav />
      <main>
        <section className="pb-8 pt-28 sm:pt-32">
          <div className="container">
            <Breadcrumbs crumbs={crumbs} />
            <Reveal className="mt-8 max-w-3xl">
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-clay-600">
                Download
              </p>
              <h1 className="mt-3 font-display text-4xl font-semibold leading-[1.08] tracking-tight text-ink sm:text-5xl">
                Get Talyn
              </h1>
              <p className="mt-5 text-lg leading-relaxed text-ink-500">{description}</p>
            </Reveal>
          </div>
        </section>

        <section className="pb-12">
          <div className="container grid gap-4 md:grid-cols-3">
            {platforms.map((p, i) => (
              <Reveal key={p.key} delay={i * 0.06}>
                <div className="flex h-full flex-col rounded-2xl border border-line bg-white p-6 shadow-soft">
                  <p.icon className="h-6 w-6 text-clay" />
                  <h2 className="mt-4 font-display text-xl font-semibold text-ink">{p.name}</h2>
                  <p className="mt-1 text-sm text-ink-500">{p.file}</p>
                  <p className="mt-3 flex-1 text-xs leading-relaxed text-ink-400">{p.note}</p>
                  <DownloadButton
                    size="md"
                    platform={p.key}
                    placement={`download-page-${p.key}`}
                    className="mt-5 w-full"
                  >
                    {"Download for {platform}"}
                  </DownloadButton>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        <section className="pb-24">
          <div className="container">
            <Reveal className="flex flex-col items-start gap-4 rounded-2xl border border-line bg-paper-100 p-6 sm:flex-row sm:items-center">
              <Globe className="h-6 w-6 shrink-0 text-clay" />
              <div className="flex-1">
                <h2 className="font-display text-lg font-semibold text-ink">Nothing to install</h2>
                <p className="mt-1 text-sm leading-relaxed text-ink-500">
                  The web app at app.talyn.dev is the same product. The desktop app adds local
                  sessions, previews on localhost and skills from ~/.claude/skills.
                </p>
              </div>
              <WebAppButton size="md" placement="download-page" showArrow={false} />
            </Reveal>
            <p className="mt-6 text-sm text-ink-400">
              Every build, with release notes, is on the{" "}
              <a
                href={RELEASES_URL}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-clay-600"
              >
                releases page
              </a>
              . A new stable release goes out every six hours when there is something in it.
            </p>
          </div>
        </section>
      </main>
      <Footer />
      <JsonLd data={breadcrumbSchema(crumbs)} />
    </>
  );
}
