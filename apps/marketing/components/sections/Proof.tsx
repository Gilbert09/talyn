import { Github, ShieldCheck, Timer, Boxes } from "lucide-react";
import { Reveal } from "@/components/ui/Reveal";
import { site } from "@/lib/content";
import { getRepoStats, relativeTime } from "@/lib/repoStats";

/**
 * Trust, restricted to things a sceptic can check in ten seconds.
 *
 * The honest position is that Talyn has no customers to name, so the usual
 * fifth CRO dimension — logos, testimonials, review scores — has nothing to
 * put in it. The available choices were to invent something, to leave the
 * slot empty, or to find facts that are both true and verifiable. This is the
 * third.
 *
 * Every item here can be checked without taking our word for it: the star
 * count and the release tag come from GitHub's own API, the notarization is
 * visible in the build workflow, and the sandbox claim is the one thing on
 * this site a competitor cannot match by adding a model.
 *
 * Each cell renders only if its fact resolved. A build that could not reach
 * GitHub shows three items instead of four rather than an em dash where a
 * number should be.
 */
export async function Proof() {
  const stats = await getRepoStats();
  const shipped = relativeTime(stats.latestPublishedAt);

  const items = [
    {
      icon: Github,
      // Deliberately NOT a star count. A number is only a trust signal when
      // it is a big one — at single or double digits a developer reads it as
      // "nobody is here", which is worse than saying nothing. The verifiable
      // claim underneath it needs no number: the source is there, and the
      // link is the proof.
      label: "The source is public",
      detail: "Read what it does before you install it, or check how it does it.",
      href: site.githubUrl,
    },
    stats.latestVersion && {
      icon: Timer,
      // Two facts in one: which build is current, and that the project is
      // alive. "Is anybody still working on this" is the unasked question
      // behind every public-beta badge.
      label: shipped
        ? `${stats.latestVersion} shipped ${shipped}`
        : `${stats.latestVersion} is the current build`,
      detail: "A stable release goes out every six hours when there is anything in it.",
      href: `${site.githubUrl}/releases`,
    },
    {
      icon: ShieldCheck,
      label: "Signed and notarized on macOS",
      detail:
        "Windows is not signed yet and will warn you on first install — we would rather say so here.",
    },
    {
      icon: Boxes,
      label: "Your token never enters the sandbox",
      detail:
        "Each task gets a fresh microVM; credentials are attached from outside it and the machine is destroyed afterwards.",
    },
  ].filter(Boolean) as Array<{
    icon: typeof Github;
    label: string;
    detail: string;
    href?: string;
  }>;

  return (
    <section className="border-t border-line py-14">
      <div className="container">
        <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
          {items.map((item, i) => {
            const Icon = item.icon;
            const body = (
              <>
                <div className="flex items-center gap-2">
                  <Icon className="h-4 w-4 shrink-0 text-clay-600" />
                  <p className="text-sm font-medium text-ink">{item.label}</p>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-ink-400">
                  {item.detail}
                </p>
              </>
            );
            return (
              <Reveal key={item.label} delay={(i % 4) * 0.05}>
                {item.href ? (
                  <a
                    href={item.href}
                    target="_blank"
                    rel="noreferrer"
                    className="block transition-opacity hover:opacity-80"
                  >
                    {body}
                  </a>
                ) : (
                  body
                )}
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}
