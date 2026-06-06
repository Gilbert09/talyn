import { ArrowUpDown } from 'lucide-react';

export type SortDir = 'asc' | 'desc';

/** Repo dropdown — native select keeps the bar compact + keyboard-friendly. */
export function RepoFilter({
  value,
  onChange,
  repos,
}: {
  value: string;
  onChange: (v: string) => void;
  repos: Array<{ id: string; name: string }>;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-7 rounded-md border bg-background px-2 py-0 text-xs leading-7"
    >
      <option value="all">All repos</option>
      {repos.map((r) => (
        <option key={r.id} value={r.id}>
          {r.name}
        </option>
      ))}
    </select>
  );
}

/** Created-at sort toggle (newest/oldest first). */
export function SortToggle({ sortDir, onToggle }: { sortDir: SortDir; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex items-center gap-1 rounded-md border px-2 py-1 text-muted-foreground transition-colors hover:text-foreground"
      title={`Sorted by created date — ${
        sortDir === 'desc' ? 'newest first' : 'oldest first'
      }. Click to flip.`}
    >
      <ArrowUpDown className="h-3 w-3" />
      {sortDir === 'desc' ? 'Newest' : 'Oldest'}
    </button>
  );
}

/** Order two PRs by when they were opened on GitHub (DB createdAt fallback). */
export function compareByCreated(
  a: { summary: { createdAt?: string }; createdAt: string },
  b: { summary: { createdAt?: string }; createdAt: string },
  sortDir: SortDir
): number {
  const ta = new Date(a.summary.createdAt || a.createdAt).getTime();
  const tb = new Date(b.summary.createdAt || b.createdAt).getTime();
  return sortDir === 'desc' ? tb - ta : ta - tb;
}
