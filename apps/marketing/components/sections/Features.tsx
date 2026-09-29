import { ArrowRight } from "lucide-react";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { Reveal } from "@/components/ui/Reveal";
import { FeatureCard } from "@/components/ui/FeatureCard";
import { features } from "@/lib/content";
import { listFeaturePages } from "@/lib/features";

/**
 * The homepage feature section: one grid, no spotlights.
 *
 * It has been cut twice. It started as all nine features as full-width
 * alternating blocks with a mock each — most of the page's length, and every
 * feature at identical weight in a scroll nobody finished. The first cut kept
 * three of those blocks and gridded the rest.
 *
 * This is the second, and the number that forced it: the section was
 * **2,706px**, a quarter of the whole page, against ~560px for the equivalent
 * section on t3.codes. Talyn's home page was 12.1 viewport-heights to their
 * 5.0 — and the three spotlights were the single biggest contributor.
 *
 * Nothing is lost. Every one of these has had its own page since the feature
 * pages shipped, and those pages carry the long-form argument, the mocks and
 * the FAQ far better than a homepage block can. The grid's job is to say what
 * exists and get people to the page about the one they care about; it is not
 * to sell all ten at once.
 */

const COUNT_WORDS = [
  "No",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
];

function countWord(n: number): string {
  return COUNT_WORDS[n] ?? String(n);
}

/**
 * Homepage feature id → the page it belongs to.
 *
 * Two of the homepage entries collapse into one page: `#context` was "see the
 * diff, checks and conversation without leaving Talyn", which is a paragraph
 * of the dashboard page rather than a page of its own.
 */
const PAGE_FOR_ID: Record<string, string> = {
  dashboard: "pr-dashboard",
  context: "pr-dashboard",
  reviews: "reviews",
  "code-review": "code-review",
  delegate: "fix-pull-requests",
  "auto-merge": "merge-queue",
  workflows: "workflows",
  loops: "loops",
  skills: "skills",
};

export function Features() {
  const fromHomepage = features
    .filter((f) => f.id !== "context")
    .map((f) => ({
      id: f.id,
      eyebrow: f.eyebrow,
      title: f.title,
      body: f.body,
      href: `/features/${PAGE_FOR_ID[f.id] ?? ""}`,
    }))
    .filter((c) => c.href !== "/features/");

  const covered = new Set([
    ...fromHomepage.map((c) => PAGE_FOR_ID[c.id]),
    // Agents has a whole section of its own further down the page. A card
    // here as well would be the third time the homepage says "bring your own
    // agent"; the Providers section links to the page instead.
    "agents",
  ]);

  // Any feature page with no homepage entry at all — MCP servers is the
  // current one, and it is why this is a union rather than a filter.
  const fromPages = listFeaturePages()
    .filter((p) => !covered.has(p.slug))
    .map((p) => ({
      id: p.slug,
      eyebrow: p.eyebrow,
      title: p.title,
      body: p.description,
      href: `/features/${p.slug}`,
    }));

  const grid = [...fromHomepage, ...fromPages];

  return (
    <section id="features" className="py-20">
      <div className="container">
        {/* Counted, never typed. This subhead once said "Seven things" as a
            literal, one line above a map over the array, and went stale the
            first time a feature was added. */}
        <SectionHeading
          kicker="The day job"
          title="The PR busywork, handled."
          sub={`${countWord(grid.length)} things Talyn does while you are somewhere else.`}
        />

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {grid.map((c, i) => (
            <Reveal key={c.id} delay={(i % 3) * 0.06}>
              {/* The anchor id from the old full-width block is kept on the
                  card, so an inbound /#workflows link written before these
                  pages existed still lands on something about workflows. */}
              <FeatureCard
                id={c.id}
                eyebrow={c.eyebrow}
                title={c.title}
                body={c.body}
                href={c.href}
                className="h-full"
              />
            </Reveal>
          ))}
        </div>

        <div className="mt-10 text-center">
          <a
            href="/features"
            className="group inline-flex items-center gap-1.5 text-sm font-medium text-clay-600 hover:text-clay"
          >
            Everything Talyn does
            <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
          </a>
        </div>
      </div>
    </section>
  );
}
