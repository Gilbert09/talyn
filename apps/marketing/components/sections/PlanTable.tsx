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
  { label: "Price, billed monthly", free: "$0", paid: "$40 per month" },
  { label: "Price, billed annually", free: "$0", paid: "$400 per year ($33.33 per month)" },
  { label: "Box-hours included each month", free: "10", paid: "200" },
  { label: "Box sizes", free: "Small and standard", paid: "Small, standard, medium, large and xlarge" },
  { label: "Boxes running at once", free: "2", paid: "Up to 100" },
  { label: "Credits and auto top-up", free: "Not included", paid: "Included" },
  { label: "Pull request dashboard, all repositories", free: "Included", paid: "Included" },
  { label: "Agent providers (Claude, Codex, PostHog Code)", free: "All of them", paid: "All of them" },
  { label: "Merge queue, workflows, loops and code review", free: "Included", paid: "Included" },
  { label: "Connected MCP servers", free: "Included", paid: "Included" },
  { label: "Keep a pull request mergeable, flagged by hand", free: "Included", paid: "Included" },
  { label: "Keep every new pull request mergeable automatically", free: "Not included", paid: "Included" },
  { label: "Review every new pull request automatically", free: "Not included", paid: "Included" },
  { label: "Mobile app (coming soon)", free: "Included", paid: "Included" },
  { label: "Model usage", free: "Your own subscription", paid: "Your own subscription" },
];

export function PlanTable() {
  const [free, paid] = pricing.tiers;

  return (
    <section className="border-t border-line bg-paper-100 py-20">
      <div className="container">
        <h2 className="font-display text-2xl font-semibold tracking-tight text-ink">
          Every plan, side by side
        </h2>
        <p className="mt-2 max-w-2xl text-ink-500">
          Both prices and every limit in full, so you do not have to flip a toggle to
          compare them. A team seat is $40 a month and gets Pro with its own 200
          box-hours.
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

        <h2 className="mt-16 font-display text-2xl font-semibold tracking-tight text-ink">
          {pricing.sizesTitle}
        </h2>
        <p className="mt-2 max-w-2xl text-ink-500">{pricing.sizesSub}</p>

        <div className="mt-8 overflow-x-auto">
          <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-line-strong">
                <th className="py-3 pr-4 font-display text-base font-semibold text-ink">Box size</th>
                <th className="py-3 pr-4 font-display text-base font-semibold text-ink">vCPU</th>
                <th className="py-3 pr-4 font-display text-base font-semibold text-ink">Memory</th>
                <th className="py-3 pr-4 font-display text-base font-semibold text-ink">Counts as</th>
                <th className="py-3 font-display text-base font-semibold text-ink">Per hour</th>
              </tr>
            </thead>
            <tbody>
              {pricing.sizes.map((row) => (
                <tr key={row.name} className="border-b border-line">
                  <td className="py-3 pr-4 text-ink-700">{row.name}</td>
                  <td className="py-3 pr-4 text-ink-700">{row.vcpu}</td>
                  <td className="py-3 pr-4 text-ink-700">{row.ram} GiB</td>
                  <td className="py-3 pr-4 text-ink-700">{row.weight} per hour</td>
                  <td className="py-3 text-ink-700">{row.perHour}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-ink-500">
          {pricing.sizesNote} Billed per running second. Sleeping boxes are
          free, and a box sleeps after 10 idle minutes.
        </p>

        <h3 className="mt-12 font-display text-xl font-semibold tracking-tight text-ink">
          {pricing.creditsTitle}
        </h3>
        <div className="mt-4 grid max-w-xl gap-3 sm:grid-cols-3">
          {pricing.creditPacks.map((pack) => (
            <div key={pack.amount} className="rounded-xl border border-line bg-white p-4">
              <p className="font-display text-2xl font-semibold text-ink">{pack.amount}</p>
              <p className="mt-1 text-xs text-ink-500">{pack.bonus ?? "No bonus"}</p>
            </div>
          ))}
        </div>
        <ul className="mt-5 max-w-2xl list-disc space-y-1.5 pl-5 text-sm text-ink-600">
          {pricing.creditPoints.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>

        <p className="mt-10 max-w-2xl text-xs leading-relaxed text-ink-400">
          {pricing.footnote}
        </p>
      </div>
    </section>
  );
}
