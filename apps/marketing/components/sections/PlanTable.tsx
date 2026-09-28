import { pricing } from "@/lib/content";

/**
 * Both prices and every limit, as plain server-rendered text.
 *
 * The pricing cards are a client component with a monthly/annual toggle, so
 * only ONE price is ever in the HTML — and the toggle defaults to annual, so
 * anything that reads the page without running it sees $12.50 and never sees
 * $15. That is fine for a person and bad for everything else: a search
 * crawler, an AI answer engine, or somebody pasting the URL into a chat and
 * asking what it costs.
 *
 * This table is the fix and it is deliberately dumb — a server component, no
 * state, every number and every cap written out. It doubles as the scannable
 * comparison a buyer wants after the cards have sold them, which is why it is
 * visible rather than hidden for crawlers. Hiding it would be cloaking.
 */
const LIMITS: Array<{ label: string; free: string; paid: string }> = [
  { label: "Price, billed monthly", free: "$0", paid: "$15 per month" },
  { label: "Price, billed annually", free: "$0", paid: "$150 per year ($12.50 per month)" },
  { label: "Pull request dashboard, all repositories", free: "Included", paid: "Included" },
  { label: "Agent providers (Claude, Codex, PostHog Code)", free: "All of them", paid: "All of them" },
  { label: "Tasks running at once", free: "3", paid: "Unlimited" },
  { label: "Pull requests in the merge queue", free: "3", paid: "Unlimited" },
  { label: "Workflows", free: "3", paid: "Unlimited" },
  { label: "Loops", free: "3", paid: "Unlimited" },
  { label: "Code review cycles", free: "1", paid: "Unlimited" },
  { label: "Connected MCP servers", free: "Unlimited", paid: "Unlimited" },
  { label: "Keep a pull request mergeable, flagged by hand", free: "Included", paid: "Included" },
  { label: "Keep every new pull request mergeable automatically", free: "—", paid: "Included" },
  { label: "Review every new pull request automatically", free: "—", paid: "Included" },
  { label: "Agent usage", free: "Your own subscription", paid: "Your own subscription" },
];

export function PlanTable() {
  const [free, paid] = pricing.tiers;

  return (
    <section className="border-t border-line bg-paper-100 py-20">
      <div className="container">
        <h2 className="font-display text-2xl font-semibold tracking-tight text-ink">
          Every limit, side by side
        </h2>
        <p className="mt-2 max-w-2xl text-ink-500">
          Both prices, in full, so you do not have to flip a toggle to compare
          them.
        </p>

        <div className="mt-8 overflow-x-auto">
          <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-line-strong">
                <th className="py-3 pr-4 font-semibold text-ink-400">&nbsp;</th>
                <th className="py-3 pr-4 font-display text-base font-semibold text-ink">
                  {free.name}
                </th>
                <th className="py-3 font-display text-base font-semibold text-ink">
                  {paid.name}
                </th>
              </tr>
            </thead>
            <tbody>
              {LIMITS.map((row) => (
                <tr key={row.label} className="border-b border-line">
                  <td className="py-3 pr-4 text-ink-600">{row.label}</td>
                  <td className="py-3 pr-4 text-ink-700">{row.free}</td>
                  <td className="py-3 text-ink-700">{row.paid}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-6 max-w-2xl text-xs leading-relaxed text-ink-400">
          {pricing.footnote}
        </p>
      </div>
    </section>
  );
}
