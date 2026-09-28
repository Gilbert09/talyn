import { ArrowRight, Check } from "lucide-react";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { Reveal } from "@/components/ui/Reveal";
import { FeatureCard } from "@/components/ui/FeatureCard";
import { ScreenshotPlaceholder } from "@/components/ui/ScreenshotPlaceholder";
import { features } from "@/lib/content";
import { listFeaturePages } from "@/lib/features";
import type { MockId } from "@/components/mocks/AppMocks";

/**
 * The homepage feature section.
 *
 * This used to render all nine features as full-width alternating blocks with
 * a mock each, which was most of the page's length and gave every feature the
 * same weight — so the merge queue and a one-line convenience read as equally
 * important, in a scroll nobody finished.
 *
 * Three now get the full treatment and the rest are cards that link to their
 * own page. The three are not the three we like most; they are the pitch:
 * fixing a pull request is the core verb, the merge queue is the "wake up to
 * green PRs" promise, and code review is the clearest thing we do that
 * nobody else does.
 */
const SPOTLIGHT_IDS = ["delegate", "auto-merge", "code-review"] as const;

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
  const spotlights = SPOTLIGHT_IDS.map((id) =>
    features.find((f) => f.id === id)
  ).filter((f): f is (typeof features)[number] => Boolean(f));

  const spotlit = new Set<string>(SPOTLIGHT_IDS);

  // The grid is built from the homepage `features` array, minus the three
  // above and minus `context` (folded into the dashboard page), plus any
  // feature page that has no homepage entry at all — MCP servers is the
  // current one, and it is the reason this is a union rather than a filter.
  const gridFromHomepage = features
    .filter((f) => !spotlit.has(f.id) && f.id !== "context")
    .map((f) => ({
      id: f.id,
      eyebrow: f.eyebrow,
      title: f.title,
      body: f.body,
      href: `/features/${PAGE_FOR_ID[f.id] ?? ""}`,
    }))
    .filter((c) => c.href !== "/features/");

  const covered = new Set([
    ...spotlights.map((f) => PAGE_FOR_ID[f.id]),
    ...gridFromHomepage.map((c) => PAGE_FOR_ID[c.id]),
    // Agents has a whole section of its own further down the page. A card
    // here as well would be the third time the homepage says "bring your own
    // agent"; the Providers section links to the page instead.
    "agents",
  ]);

  const gridFromPages = listFeaturePages()
    .filter((p) => !covered.has(p.slug))
    .map((p) => ({
      id: p.slug,
      eyebrow: p.eyebrow,
      title: p.title,
      body: p.description,
      href: `/features/${p.slug}`,
    }));

  const grid = [...gridFromHomepage, ...gridFromPages];

  return (
    <section id="features" className="py-20">
      <div className="container">
        {/* Both numbers are counted, never typed. The subhead here used to
            say "Seven things" as a literal one line above a map over the
            array, and it went stale the first time a feature was added. The
            same trap is now two numbers wide. */}
        <SectionHeading
          kicker="The day job"
          title="The PR busywork, handled."
          sub={`${countWord(spotlights.length)} things Talyn does for you, and ${countWord(grid.length).toLowerCase()} more it does while you are not looking.`}
        />

        <div className="mt-14 space-y-20">
          {spotlights.map((f, i) => {
            const flip = i % 2 === 1;
            const href = `/features/${PAGE_FOR_ID[f.id]}`;
            return (
              <div
                key={f.id}
                id={f.id}
                className="grid scroll-mt-24 items-center gap-10 lg:grid-cols-2"
              >
                {/* min-w-0 on both grid items — see HowItWorks for the why. */}
                <Reveal className={flip ? "min-w-0 lg:order-2" : "min-w-0"}>
                  <p className="font-mono text-xs uppercase tracking-[0.2em] text-clay-600">
                    {f.eyebrow}
                  </p>
                  <h3 className="mt-3 font-display text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
                    {f.title}
                  </h3>
                  <p className="mt-4 max-w-md text-ink-500">{f.body}</p>
                  <ul className="mt-6 space-y-3">
                    {f.bullets.map((b) => (
                      <li key={b} className="flex items-start gap-3 text-sm text-ink-700">
                        <span className="mt-0.5 inline-flex rounded-full border border-clay/30 bg-clay/10 p-0.5">
                          <Check className="h-3.5 w-3.5 text-clay-600" />
                        </span>
                        {b}
                      </li>
                    ))}
                  </ul>
                  <a
                    href={href}
                    className="group mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-clay-600 hover:text-clay"
                  >
                    How it works
                    <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                  </a>
                </Reveal>

                <Reveal delay={0.1} className={flip ? "min-w-0 lg:order-1" : "min-w-0"}>
                  <ScreenshotPlaceholder shot={f.shot as MockId} filters={false} />
                </Reveal>
              </div>
            );
          })}
        </div>

        <div className="mt-20 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
