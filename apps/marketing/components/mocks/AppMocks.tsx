/**
 * In-browser mockups of the real Talyn desktop UI, rendered in HTML/CSS on a
 * light surface (the real app is light too). Structure mirrors the actual
 * components — sidebar, PR-row anatomy, status pill + 3-segment check rollup,
 * filter bar, task split-view, merge-queue grouping — so it reads as the app.
 * Swap <ScreenshotPlaceholder> for an <Image> once real captures exist.
 */
import {
  GitPullRequest,
  Eye,
  GitMerge,
  ListTodo,
  ChevronsUpDown,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  ExternalLink,
  FolderGit2,
  GitBranch,
  Laptop,
  Search,
  Sparkles,
  Wand2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { OwlMark } from "@/components/brand/Logo";

/** Mock components accept this so callers can toggle the filter bar. */
type MockProps = { filters?: boolean };

/* ---------- status pill + rollup (mirrors widgets/PRStatusPill) ---------- */

type Tone = "green" | "red" | "amber" | "blue" | "purple" | "grey";

const toneClass: Record<Tone, string> = {
  green: "border-status-green/30 bg-status-green/10 text-status-green",
  red: "border-status-red/30 bg-status-red/10 text-status-red",
  amber: "border-status-amber/30 bg-status-amber/10 text-status-amber",
  blue: "border-status-blue/30 bg-status-blue/10 text-status-blue",
  purple: "border-status-purple/30 bg-status-purple/10 text-status-purple",
  grey: "border-line-strong bg-paper-200 text-ink-500",
};

function CheckRollupBar({
  passed = 0,
  failed = 0,
  running = 0,
  skipped = 0,
  optional = false,
}: {
  passed?: number;
  failed?: number;
  running?: number;
  skipped?: number;
  optional?: boolean;
}) {
  const total = Math.max(passed + failed + running + skipped, 1);
  return (
    <span className="ml-1 flex h-1.5 w-12 overflow-hidden rounded-sm bg-paper-300">
      <span style={{ width: `${((passed + skipped) / total) * 100}%` }} className="bg-status-green" />
      <span
        style={{ width: `${(failed / total) * 100}%` }}
        className={optional ? "bg-status-amber" : "bg-status-red"}
      />
      <span style={{ width: `${(running / total) * 100}%` }} className="bg-status-blue" />
    </span>
  );
}

function StatusPill({
  tone,
  icon: Icon,
  label,
  spin = false,
  rollup,
}: {
  tone: Tone;
  icon: LucideIcon;
  label: string;
  spin?: boolean;
  rollup?: { passed?: number; failed?: number; running?: number; optional?: boolean };
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium",
        toneClass[tone]
      )}
    >
      <Icon className={cn("h-3.5 w-3.5 shrink-0", spin && "animate-spin")} />
      <span>{label}</span>
      {rollup && <CheckRollupBar {...rollup} />}
    </span>
  );
}

/* ---------- sidebar (mirrors layout/Sidebar) ---------- */

function Sidebar({ active = "prs" }: { active?: string }) {
  const items = [
    { id: "prs", label: "My PRs", icon: GitPullRequest, badge: 4 },
    { id: "reviews", label: "Reviews", icon: Eye, badge: 5 },
    { id: "queue", label: "Merge Queue", icon: GitMerge, badge: 3 },
    { id: "tasks", label: "Tasks", icon: ListTodo, badge: 2 },
  ];
  return (
    <div className="hidden w-48 shrink-0 flex-col border-r border-line bg-paper-100 sm:flex">
      {/* workspace switcher */}
      <div className="flex items-center gap-2 border-b border-line p-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-clay/15">
          <OwlMark className="h-4 w-4 text-clay" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">Sundial</p>
          <p className="text-[10px] text-ink-400">3 repos</p>
        </div>
        <ChevronsUpDown className="h-3.5 w-3.5 text-ink-400" />
      </div>

      {/* nav */}
      <div className="flex-1 space-y-0.5 p-2">
        {items.map((it) => (
          <div
            key={it.id}
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs",
              active === it.id
                ? "bg-white font-medium text-ink shadow-soft"
                : "text-ink-500"
            )}
          >
            <it.icon className="h-3.5 w-3.5" />
            <span className="flex-1">{it.label}</span>
            <span className="rounded-full bg-paper-300 px-1.5 text-[10px] text-ink-600">
              {it.badge}
            </span>
          </div>
        ))}
      </div>

      {/* footer: provider dots + user chip */}
      <div className="border-t border-line p-2">
        <div className="mb-2 flex flex-col gap-0.5 px-1 text-[10px] text-ink-400">
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-status-green" /> Claude Code
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-status-green" /> PostHog Code
          </span>
        </div>
        <div className="flex items-center gap-2 px-1">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-clay text-[10px] font-semibold text-white">
            D
          </span>
          <span className="text-xs text-ink-600">@dana</span>
        </div>
      </div>
    </div>
  );
}

/* ---------- filter bar (mirrors GitHubPageShell) ---------- */

function FilterBar() {
  return (
    <div className="flex items-center gap-2 overflow-hidden border-b border-line px-4 py-2 text-[11px]">
      <span className="shrink-0 rounded-md border border-line bg-white px-2 py-1 text-ink-500">
        All repos
      </span>
      <span className="shrink-0 rounded-md border border-status-amber/30 bg-status-amber/10 px-2 py-1 text-status-amber">
        Needs attention · 2
      </span>
      <span className="shrink-0 rounded-md border border-line px-2 py-1 text-ink-500">
        Needs review · 1
      </span>
      <span className="shrink-0 rounded-md border border-line px-2 py-1 text-ink-500">
        Ready to merge · 1
      </span>
    </div>
  );
}

/* ---------- dashboard ---------- */

const prRows = [
  {
    title: "feat: streaming results in the dashboard",
    sub: "sundial/web#412 · @dana · opened 2h ago",
    pill: { tone: "red" as Tone, icon: XCircle, label: "2/14 failing", rollup: { passed: 11, failed: 2, running: 1 } },
    updated: "12m",
  },
  {
    title: "fix: retry the flaky checkout webhook",
    sub: "sundial/api#418 · @theo · opened 5h ago",
    pill: { tone: "amber" as Tone, icon: AlertTriangle, label: "Changes requested", rollup: { passed: 9 } },
    updated: "1h",
  },
  {
    title: "perf: cache the search index",
    sub: "sundial/web#407 · @dana · opened 6h ago",
    pill: { tone: "amber" as Tone, icon: Eye, label: "Review", rollup: { passed: 12 } },
    updated: "3h",
  },
  {
    title: "chore: bump dependencies",
    sub: "sundial/mobile#21 · @priya · opened 1d ago",
    pill: { tone: "green" as Tone, icon: CheckCircle2, label: "Ready", rollup: { passed: 11 } },
    updated: "8h",
  },
];

export function MockDashboard({ filters = true }: MockProps) {
  return (
    <div className="flex h-[360px] bg-white text-left">
      <Sidebar active="prs" />
      <div className="flex min-w-0 flex-1 flex-col">
        {filters && <FilterBar />}
        <div className="flex-1 overflow-hidden">
          {prRows.map((r) => (
            <div
              key={r.title}
              className="group flex items-center gap-3 border-b border-line px-4 py-2.5 hover:bg-paper-50"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-ink">{r.title}</p>
                <p className="truncate font-mono text-[10px] text-ink-400">{r.sub}</p>
              </div>
              <StatusPill {...r.pill} />
              <span className="w-8 shrink-0 text-right text-[10px] text-ink-400">{r.updated}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------- task running (mirrors QueuePanel + TaskTerminal) ---------- */

const transcript = [
  { k: "sys", t: "Cloud run started · Claude Code · sandbox sundial-3f2a" },
  { k: "tool", t: "read  .github/workflows/ci.yml" },
  { k: "tool", t: "run   npm test -- packages/api" },
  { k: "err", t: "× 2 failing: checkout webhook retry timing" },
  { k: "txt", t: "Patching the retry backoff in the webhook handler…" },
  { k: "tool", t: "edit  services/checkout.ts" },
  { k: "ok", t: "✓ checks green — pushed fix to fix/webhook-retry" },
];

export function MockTaskRunning(_props: MockProps) {
  return (
    <div className="flex h-[360px] bg-white text-left">
      <Sidebar active="tasks" />
      {/* task list */}
      <div className="flex w-44 shrink-0 flex-col gap-2 border-r border-line p-3">
        <p className="flex items-center gap-1.5 px-1 text-[10px] font-medium uppercase tracking-wide text-ink-400">
          Running <span className="text-ink-300">1</span>
        </p>
        <div className="rounded-lg border-l-2 border-l-status-blue bg-white p-2 shadow-soft">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-paper-200">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-status-blue" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-[11px] font-medium text-ink">Fix CI #412</p>
              <p className="font-mono text-[9px] text-ink-400">12s ago · Working</p>
            </div>
          </div>
        </div>
        <p className="mt-1 flex items-center gap-1.5 px-1 text-[10px] font-medium uppercase tracking-wide text-ink-400">
          Queued <span className="text-ink-300">1</span>
        </p>
        <div className="rounded-lg border border-line p-2">
          <p className="truncate text-[11px] text-ink-600">Reply review #418</p>
          <p className="font-mono text-[9px] text-ink-400">PostHog Code</p>
        </div>
      </div>
      {/* detail */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2.5 border-b border-line p-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-paper-200">
            <Loader2 className="h-4 w-4 animate-spin text-status-blue" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-ink">Fix failing CI</p>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className="rounded border border-status-blue/30 bg-status-blue/10 px-1.5 py-0.5 text-[9px] font-medium text-status-blue">
                Working
              </span>
              <span className="flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[9px] text-ink-500">
                <Sparkles className="h-2.5 w-2.5" /> Claude Code
              </span>
              <span className="flex items-center gap-1 rounded border border-line px-1.5 py-0.5 font-mono text-[9px] text-ink-500">
                <GitBranch className="h-2.5 w-2.5" /> fix/webhook-retry
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 border-b border-line bg-paper-100 px-3 py-1.5 text-[10px] text-ink-500">
          <Sparkles className="h-3 w-3 text-clay" /> Cloud run on Claude Code
          <span className="ml-auto flex items-center gap-1 text-ink-400">
            <ExternalLink className="h-3 w-3" /> View run
          </span>
        </div>
        <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
          <span className="h-2 w-2 animate-pulse rounded-full bg-status-blue" />
          <span className="text-[10px] font-medium text-ink-600">Task Terminal</span>
          <span className="ml-auto rounded border border-status-red/30 px-1.5 py-0.5 text-[9px] font-medium text-status-red">
            Abort
          </span>
        </div>
        <div className="flex-1 overflow-hidden bg-[#1e1b17] p-3 font-mono text-[10.5px] leading-relaxed">
          {transcript.map((l, i) => (
            <div
              key={i}
              className={cn(
                "whitespace-pre",
                l.k === "err" && "text-status-red",
                l.k === "ok" && "text-status-green",
                l.k === "tool" && "text-clay-300",
                l.k === "sys" && "text-paper-300/50",
                l.k === "txt" && "text-paper-100/80"
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

/* ---------- merge queue (mirrors MergeQueuePanel) ---------- */

export function MockMergeQueue({ filters = true }: MockProps) {
  const rows = [
    { n: 1, title: "chore: bump dependencies", state: "Merging", tone: "blue" as Tone, spin: true },
    { n: 2, title: "feat: dark mode toggle", state: "Waiting", tone: "grey" as Tone },
    { n: 3, title: "fix: retry the flaky checkout webhook", state: "Fixing", tone: "purple" as Tone, spin: true },
  ];
  return (
    <div className="flex h-[360px] bg-white text-left">
      <Sidebar active="queue" />
      <div className="flex min-w-0 flex-1 flex-col">
        {filters && <FilterBar />}
        {/* group header */}
        <div className="flex items-center gap-1.5 border-b border-line bg-paper-100 px-4 py-1.5 text-[11px] font-medium text-ink-500">
          <GitMerge className="h-3.5 w-3.5" />
          sundial/web <span className="opacity-50">→</span> main
        </div>
        {rows.map((r) => (
          <div
            key={r.n}
            className="flex items-center gap-3 border-b border-line px-4 py-2.5 hover:bg-paper-50"
          >
            <div className="flex w-20 items-center gap-1.5 text-[11px]">
              <span className="font-medium text-ink">#{r.n}</span>
              <span
                className={cn(
                  "inline-flex items-center gap-1",
                  r.tone === "blue" && "text-status-blue",
                  r.tone === "purple" && "text-status-purple",
                  r.tone === "grey" && "text-ink-400"
                )}
              >
                {r.spin && <Loader2 className="h-3 w-3 animate-spin" />}
                {r.state}
              </span>
            </div>
            <span className="min-w-0 flex-1 truncate text-xs text-ink">{r.title}</span>
            <StatusPill
              tone={r.n === 2 ? "green" : "blue"}
              icon={r.n === 2 ? CheckCircle2 : Loader2}
              spin={r.n !== 2}
              label={r.n === 2 ? "Ready" : "Checks"}
              rollup={{ passed: r.n === 2 ? 12 : 8, running: r.n === 2 ? 0 : 3 }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- pr detail (sheet with Summary/Checks/Files/Conversation tabs) ---------- */

export function MockPrDetail(_props: MockProps) {
  return (
    <div className="flex h-[360px] bg-white text-left">
      <Sidebar active="prs" />
      <div className="flex min-w-0 flex-1 flex-col p-4">
        <div className="mb-2 flex items-center gap-2">
          <span className="truncate text-xs font-semibold text-ink">
            #412 · Retry the flaky checkout webhook
          </span>
          <StatusPill tone="green" icon={CheckCircle2} label="Ready" rollup={{ passed: 14 }} />
        </div>
        <div className="mb-3 flex gap-1.5 border-b border-line pb-2 text-[11px]">
          {["Summary", "Checks", "Files", "Conversation"].map((t, i) => (
            <span
              key={t}
              className={cn("rounded-md px-2 py-0.5", i === 2 ? "bg-paper-200 text-ink" : "text-ink-400")}
            >
              {t}
            </span>
          ))}
        </div>
        <div className="space-y-1 font-mono text-[10.5px] leading-relaxed">
          <p className="text-ink-400">services/checkout.ts</p>
          <p className="rounded bg-status-red/10 px-2 text-status-red">
            {"- await fetch(webhookUrl, payload)"}
          </p>
          <p className="rounded bg-status-green/10 px-2 text-status-green">
            {"+ await fetchWithRetry(webhookUrl, payload, { tries: 3 })"}
          </p>
        </div>
        <div className="mt-3 flex items-center gap-3 font-sans">
          <span className="flex items-center gap-1 text-[11px] text-status-green"><CheckCircle2 className="h-3 w-3" /> build</span>
          <span className="flex items-center gap-1 text-[11px] text-status-green"><CheckCircle2 className="h-3 w-3" /> test</span>
          <span className="flex items-center gap-1 text-[11px] text-status-green"><CheckCircle2 className="h-3 w-3" /> lint</span>
        </div>
        <button className="mt-auto w-full rounded-lg bg-status-green/10 py-2 text-[11px] font-semibold text-status-green ring-1 ring-status-green/25">
          Add to merge queue
        </button>
      </div>
    </div>
  );
}

/* ---------- skill picker (mirrors SkillPickerModal over the PR list) ---------- */

const skillRows = [
  {
    name: "pr-review",
    desc: "Deep review: correctness, tests, and API surface",
    source: "Repo",
    icon: FolderGit2,
    uses: "×12",
    hot: true,
  },
  {
    name: "security-sweep",
    desc: "Scan the diff for authz gaps and injection risks",
    source: "Talyn",
    icon: Sparkles,
    uses: "×7",
    hot: true,
  },
  {
    name: "changelog-entry",
    desc: "Draft the changelog entry from the diff",
    source: "Local",
    icon: Laptop,
    uses: "",
    hot: false,
  },
  {
    name: "perf-audit",
    desc: "Flag N+1s and hot-path allocations in the change",
    source: "Repo",
    icon: FolderGit2,
    uses: "",
    hot: false,
  },
];

export function MockSkillPicker(_props: MockProps) {
  return (
    <div className="relative flex h-[360px] bg-white text-left">
      <Sidebar active="prs" />
      {/* dimmed PR list behind the modal */}
      <div className="flex min-w-0 flex-1 flex-col opacity-40">
        <FilterBar />
        {prRows.slice(0, 3).map((r) => (
          <div key={r.title} className="flex items-center gap-3 border-b border-line px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-ink">{r.title}</p>
              <p className="truncate font-mono text-[10px] text-ink-400">{r.sub}</p>
            </div>
            <StatusPill {...r.pill} />
          </div>
        ))}
      </div>

      {/* the picker */}
      <div className="absolute inset-0 flex items-center justify-center bg-ink/10 p-4">
        <div className="w-full max-w-xs rounded-xl border border-line bg-white p-3 shadow-soft">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-ink">
            <Wand2 className="h-3.5 w-3.5 text-clay" />
            Run a skill on sundial/web#412
          </p>
          <div className="mt-2 flex items-center gap-1.5 rounded-lg border border-line bg-paper-50 px-2 py-1.5 text-[11px] text-ink-400">
            <Search className="h-3 w-3" /> Search skills…
          </div>
          <p className="mt-2.5 px-1 text-[9px] font-medium uppercase tracking-wide text-ink-400">
            Frequently used
          </p>
          <div className="mt-1 space-y-0.5">
            {skillRows.map((s, i) => (
              <div
                key={s.name}
                className={cn(
                  "flex items-start gap-2 rounded-lg px-2 py-1.5",
                  i === 0 && "bg-paper-200"
                )}
              >
                <s.icon className="mt-0.5 h-3 w-3 shrink-0 text-ink-400" />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 text-[11px] font-medium text-ink">
                    {s.name}
                    <span className="rounded border border-line px-1 py-px text-[8px] font-normal uppercase tracking-wide text-ink-400">
                      {s.source}
                    </span>
                    {s.uses && <span className="text-[9px] font-normal text-ink-400">{s.uses}</span>}
                  </p>
                  <p className="truncate text-[10px] text-ink-400">{s.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- onboarding ---------- */

export function MockOnboarding(_props: MockProps) {
  return (
    <div className="flex h-[360px] flex-col items-center justify-center gap-4 bg-white p-6 text-center">
      <OwlMark className="h-14 w-14 animate-blink text-clay" />
      <div>
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-400">step 1 / 3</p>
        <h4 className="mt-1 text-lg font-semibold text-ink">Connect your repos</h4>
        <p className="mt-1 text-xs text-ink-500">Sign in with GitHub and pick the repos you live in.</p>
      </div>
      <div className="w-64 space-y-1.5">
        {["sundial/web", "sundial/api", "sundial/mobile"].map((r, i) => (
          <div
            key={r}
            className={cn(
              "flex items-center justify-between rounded-lg border px-3 py-1.5 text-[11px]",
              i < 2 ? "border-clay/30 bg-clay/[0.06] text-ink" : "border-line text-ink-400"
            )}
          >
            <span className="font-mono">{r}</span>
            {i < 2 && <CheckCircle2 className="h-3.5 w-3.5 text-clay" />}
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
  "skill-picker": MockSkillPicker,
  onboarding: MockOnboarding,
} as const;

export type MockId = keyof typeof MOCKS;
