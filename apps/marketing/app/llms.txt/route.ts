import { site, pricing } from "@/lib/content";
import { listFeaturePages } from "@/lib/features";
import { listComparePages, compareCardTitle } from "@/lib/compare";
import { listGuides } from "@/lib/guides";
import { listDocs } from "@/lib/docs";

/**
 * /llms.txt (llmstxt.org): a plain summary of the site for AI search engines
 * and agents, with links to the pages worth reading. Built from the same data
 * the pages render, so a new feature, comparison, guide or doc appears here
 * without anybody remembering to add it.
 */
export const dynamic = "force-static";

const url = (path: string) => `${site.url}${path}`;

export function GET(): Response {
  const free = pricing.tiers.find((t) => t.name === "Free");
  const pro = pricing.tiers.find((t) => t.name === "Pro");

  const lines = [
    `# ${site.name}`,
    "",
    `> ${site.description}`,
    "",
    "Talyn runs first-party Claude Code (on a Claude Pro or Max plan) and Codex (on a ChatGPT Plus or Pro plan) in cloud sandboxes. Each session is one task with its own branch, agent, Firecracker microVM, diff and terminal, so many can run at once and they keep working with the laptop closed. Talyn then opens the pull request, fixes failing checks and conflicts, and merges through a merge queue. It also runs loops (prompts on a schedule) and workflows (rules on pull request events). GitHub only. Desktop apps for macOS, Windows and Linux, and a web app at app.talyn.dev.",
    "",
    `Pricing: Free is ${free?.priceMonthly ?? "$0"} with 10 box-hours a month. Pro is ${pro?.priceMonthly ?? "$40"} a month (${pro?.priceAnnualTotal ?? "$400"} a year) with 200 box-hours. Max is $100 a month (monthly only) with 1,000 box-hours. A box-hour is one standard sandbox awake for one hour, billed per second; a sleeping sandbox is free. The model runs on your own subscription, so Talyn bills machines, not tokens.`,
    "",
    "Conductor Cloud shuts down on November 20, 2026. Talyn reads conductor.json and .conductor/settings.toml as they are.",
    "",
    "## Start here",
    `- [Home](${url("/")}): what Talyn is`,
    `- [Pricing](${url("/pricing")}): plans, box-hours and credits`,
    `- [Download](${url("/download")}): macOS, Windows, Linux or the browser`,
    `- [Web app](${site.appUrl}): sign in with GitHub, nothing to install`,
    "",
    "## Features",
    ...listFeaturePages().map(
      (f) => `- [${f.navLabel}](${url(`/features/${f.slug}`)}): ${f.description}`
    ),
    "",
    "## Comparisons",
    ...listComparePages().map(
      (c) => `- [${compareCardTitle(c)}](${url(`/compare/${c.slug}`)}): ${c.description}`
    ),
    "",
    "## Guides",
    ...listGuides().map(
      (g) => `- [${g.title}](${url(`/${g.slug}`)}): ${g.description}`
    ),
    "",
    "## Docs",
    ...listDocs().map(
      (d) => `- [${d.title}](${url(`/docs/${d.slug}`)}): ${d.description}`
    ),
    "",
  ];

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
