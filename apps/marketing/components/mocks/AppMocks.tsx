/**
 * In-browser mockups of the real Talyn desktop UI, rendered in HTML/CSS on a
 * light surface (the real app is light too). These stand in for product
 * screenshots — when you have real captures, swap <ScreenshotPlaceholder> for
 * an <Image>. See components/ui/ScreenshotPlaceholder.
 */
import {
  GitPullRequest,
  Eye,
  GitMerge,
  ListTodo,
  Sparkles,
  Check,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { OwlMark } from "@/components/brand/Logo";

/* ---------- shared bits ---------- */

function CheckRollup({
  pass = 0,
  fail = 0,
  run = 0,
}: {
  pass?: number;
  fail?: number;
  run?: number;
}) {
  const total = Math.max(pass + fail + run, 1);
  return (
    <div className="flex h-1.5 w-20 overflow-hidden rounded-full bg-paper-300">
      <span style={{ width: `${(pass / total) * 100}%` }} className="bg-status-green" />
      <span style={{ width: `${(fail / total) * 100}%` }} className="bg-status-red" />
      <span style={{ width: `${(run / total) * 100}%` }} className="bg-status-blue" />
    </div>
  );
}

const pillTone: Record<string, string> = {
  green: "bg-status-green/10 text-status-green border-status-green/25",
  red: "bg-status-red/10 text-status-red border-status-red/25",
  amber: "bg-status-amber/10 text-status-amber border-status-amber/25",
  blue: "bg-status-blue/10 text-status-blue border-status-blue/25",
  purple: "bg-status-purple/10 text-status-purple border-status-purple/25",
};

function Pill({ tone, children }: { tone: keyof typeof pillTone; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
        pillTone[tone]
      )}
    >
      {children}
    </span>
  );
}

function Sidebar({ active = "prs" }: { active?: string }) {
  const items = [
    { id: "prs", label: "My PRs", icon: GitPullRequest, badge: 3 },
    { id: "reviews", label: "Reviews", icon: Eye, badge: 5 },
    { id: "queue", label: "Merge Queue", icon: GitMerge, badge: 2 },
    { id: "tasks", label: "Tasks", icon: ListTodo, badge: 1 },
  ];
  return (
    <div className="hidden w-44 shrink-0 flex-col gap-1 border-r border-line bg-paper-100 p-3 sm:flex">
      <div className="mb-3 flex items-center gap-2 px-1">
        <OwlMark className="h-5 w-5 text-clay" />
        <span className="text-sm font-semibold text-ink">Talyn</span>
      </div>
      {items.map((it) => (
        <div
          key={it.id}
          className={cn(
            "flex items-center justify-between rounded-lg px-2.5 py-1.5 text-xs",
            active === it.id ? "bg-white text-ink shadow-soft" : "text-ink-500"
          )}
        >
          <span className="flex items-center gap-2">
            <it.icon className="h-3.5 w-3.5" />
            {it.label}
          </span>
          {it.badge ? (
            <span className="rounded-full bg-paper-300 px-1.5 text-[10px] text-ink-600">
              {it.badge}
            </span>
          ) : null}
        </div>
      ))}
      <div className="mt-auto flex items-center gap-2 px-1 pt-3 text-[10px] text-ink-400">
        <span className="h-1.5 w-1.5 rounded-full bg-status-green" /> Claude Code · connected
      </div>
    </div>
  );
}

/* ---------- dashboard ---------- */

const prRows = [
  { title: "feat: streaming token usage in composer", repo: "owl", tone: "red", label: "CI failing", pass: 6, fail: 2, run: 0 },
  { title: "fix: debounce websocket reconnect", repo: "owl", tone: "amber", label: "Changes requested", pass: 8, fail: 0, run: 0 },
  { title: "perf: batch GraphQL PR refresh", repo: "posthog", tone: "blue", label: "Running", pass: 4, fail: 0, run: 3 },
  { title: "chore: bump drizzle to 0.32", repo: "owl", tone: "green", label: "Ready", pass: 9, fail: 0, run: 0 },
] as const;

export function MockDashboard() {
  return (
    <div className="flex h-[340px] bg-white text-left">
      <Sidebar active="prs" />
      <div className="flex-1 overflow-hidden p-4">
        <div className="mb-3 flex items-center gap-2">
          <h4 className="text-sm font-semibold text-ink">My PRs</h4>
          <span className="rounded-full border border-status-amber/25 bg-status-amber/10 px-2 py-0.5 text-[10px] text-status-amber">
            2 need attention
          </span>
          <span className="ml-auto font-mono text-[10px] text-ink-400">4 open · 3 repos</span>
        </div>
        <div className="space-y-1.5">
          {prRows.map((r) => (
            <div
              key={r.title}
              className="flex items-center gap-3 rounded-lg border border-line bg-paper-50 px-3 py-2"
            >
              <GitPullRequest className="h-3.5 w-3.5 shrink-0 text-clay" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-ink">{r.title}</p>
                <p className="font-mono text-[10px] text-ink-400">{r.repo}</p>
              </div>
              <CheckRollup pass={r.pass} fail={r.fail} run={r.run} />
              <Pill tone={r.tone}>{r.label}</Pill>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------- task running ---------- */

const transcript = [
  { k: "sys", t: "Cloud run started · Claude Code · sandbox owl-3f2a" },
  { k: "tool", t: "read  .github/workflows/ci.yml" },
  { k: "tool", t: "run   npm test -- packages/backend" },
  { k: "err", t: "× 2 failing: prMonitor.fastPoll egress assertion" },
  { k: "txt", t: "Patching projection to drop lastSummary blob…" },
  { k: "tool", t: "edit  services/prMonitor.ts" },
  { k: "ok", t: "✓ all checks green — opening pull request" },
];

export function MockTaskRunning() {
  return (
    <div className="flex h-[340px] bg-white text-left">
      <Sidebar active="tasks" />
      <div className="flex w-40 shrink-0 flex-col gap-1.5 border-r border-line p-3">
        <p className="px-1 text-[10px] uppercase tracking-wide text-ink-400">Running</p>
        <div className="rounded-lg border border-status-blue/25 bg-status-blue/10 p-2">
          <div className="flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin text-status-blue" />
            <span className="text-[11px] text-ink">Fix CI #482</span>
          </div>
          <p className="mt-0.5 font-mono text-[9px] text-ink-400">owl · 12s</p>
        </div>
        <p className="mt-2 px-1 text-[10px] uppercase tracking-wide text-ink-400">Queued</p>
        <div className="rounded-lg border border-line p-2">
          <span className="text-[11px] text-ink-500">Reply review #471</span>
        </div>
      </div>
      <div className="flex-1 overflow-hidden p-4">
        <div className="mb-2 flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-clay" />
          <span className="text-xs font-semibold text-ink">Fix failing CI</span>
          <span className="ml-auto rounded-md border border-status-blue/25 bg-status-blue/10 px-1.5 py-0.5 text-[10px] text-status-blue">
            Working
          </span>
        </div>
        <div className="h-[260px] overflow-hidden rounded-lg border border-line bg-ink p-3 font-mono text-[10.5px] leading-relaxed">
          {transcript.map((l, i) => (
            <div
              key={i}
              className={cn(
                "whitespace-pre",
                l.k === "err" && "text-status-red",
                l.k === "ok" && "text-status-green",
                l.k === "tool" && "text-clay-300",
                l.k === "sys" && "text-paper-300/60",
                l.k === "txt" && "text-paper-100/90"
              )}
            >
              {l.t}
            </div>
          ))}
          <span className="text-clay-300">▍</span>
        </div>
      </div>
    </div>
  );
}

/* ---------- merge queue ---------- */

export function MockMergeQueue() {
  const rows = [
    { n: 1, title: "chore: bump drizzle to 0.32", state: "Merging", tone: "blue" },
    { n: 2, title: "feat: provider picker modal", state: "Ready", tone: "green" },
    { n: 3, title: "fix: stale branch auto-rebase", state: "Auto-fixing", tone: "amber" },
  ] as const;
  return (
    <div className="flex h-[340px] bg-white text-left">
      <Sidebar active="queue" />
      <div className="flex-1 p-4">
        <h4 className="mb-1 text-sm font-semibold text-ink">Merge Queue</h4>
        <p className="mb-3 font-mono text-[10px] text-ink-400">owl · base: main</p>
        <div className="space-y-2">
          {rows.map((r) => (
            <div
              key={r.n}
              className="flex items-center gap-3 rounded-lg border border-line bg-paper-50 px-3 py-2.5"
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-paper-300 font-mono text-[11px] text-ink-600">
                {r.n}
              </span>
              <GitMerge className="h-3.5 w-3.5 text-clay" />
              <span className="min-w-0 flex-1 truncate text-xs text-ink">{r.title}</span>
              <Pill tone={r.tone}>{r.state}</Pill>
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-clay/20 bg-clay/[0.06] px-3 py-2 text-[11px] text-clay-600">
          <Sparkles className="h-3.5 w-3.5" />
          Auto-keep-mergeable is on — Talyn re-fixes and lands these as they go green.
        </div>
      </div>
    </div>
  );
}

/* ---------- pr detail ---------- */

export function MockPrDetail() {
  return (
    <div className="flex h-[340px] bg-white text-left">
      <Sidebar active="prs" />
      <div className="flex-1 overflow-hidden p-4">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-xs font-semibold text-ink">#482 · Fix CI on token streaming</span>
          <Pill tone="green">Mergeable</Pill>
        </div>
        <div className="mb-3 flex gap-2 border-b border-line pb-2 text-[11px]">
          {["Summary", "Checks", "Files", "Conversation"].map((t, i) => (
            <span
              key={t}
              className={cn(
                "rounded-md px-2 py-0.5",
                i === 2 ? "bg-paper-200 text-ink" : "text-ink-400"
              )}
            >
              {t}
            </span>
          ))}
        </div>
        <div className="space-y-1 font-mono text-[10.5px] leading-relaxed">
          <p className="text-ink-400">services/prMonitor.ts</p>
          <p className="rounded bg-status-red/10 px-2 text-status-red">- const rows = await db.select().from(pullRequests)</p>
          <p className="rounded bg-status-green/10 px-2 text-status-green">+ const rows = await db.select(PR_FLAG_COLUMNS).from(pullRequests)</p>
          <p className="text-ink-400">&nbsp;</p>
          <div className="flex items-center gap-3 px-1 pt-1 font-sans">
            <span className="flex items-center gap-1 text-[11px] text-status-green"><Check className="h-3 w-3" /> build</span>
            <span className="flex items-center gap-1 text-[11px] text-status-green"><Check className="h-3 w-3" /> test</span>
            <span className="flex items-center gap-1 text-[11px] text-status-green"><Check className="h-3 w-3" /> lint</span>
          </div>
        </div>
        <button className="mt-4 w-full rounded-lg bg-status-green/10 py-2 text-[11px] font-semibold text-status-green ring-1 ring-status-green/25">
          Add to merge queue
        </button>
      </div>
    </div>
  );
}

/* ---------- onboarding ---------- */

export function MockOnboarding() {
  return (
    <div className="flex h-[340px] flex-col items-center justify-center gap-4 bg-white p-6 text-center">
      <OwlMark className="h-14 w-14 animate-blink text-clay" />
      <div>
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-400">
          step 1 / 3
        </p>
        <h4 className="mt-1 text-lg font-semibold text-ink">Connect your repos</h4>
        <p className="mt-1 text-xs text-ink-500">
          Sign in with GitHub and pick the repos you live in.
        </p>
      </div>
      <div className="w-64 space-y-1.5">
        {["Gilbert09/owl", "posthog/posthog", "your/side-project"].map((r, i) => (
          <div
            key={r}
            className={cn(
              "flex items-center justify-between rounded-lg border px-3 py-1.5 text-[11px]",
              i < 2
                ? "border-clay/30 bg-clay/[0.06] text-ink"
                : "border-line text-ink-400"
            )}
          >
            <span className="font-mono">{r}</span>
            {i < 2 && <Check className="h-3.5 w-3.5 text-clay" />}
          </div>
        ))}
      </div>
      <button className="rounded-lg bg-clay px-5 py-1.5 text-[11px] font-semibold text-white">
        Continue
      </button>
    </div>
  );
}

export const MOCKS = {
  dashboard: MockDashboard,
  "task-running": MockTaskRunning,
  "merge-queue": MockMergeQueue,
  "pr-detail": MockPrDetail,
  onboarding: MockOnboarding,
} as const;

export type MockId = keyof typeof MOCKS;
