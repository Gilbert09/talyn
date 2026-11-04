/**
 * HTML mockups of a session and a thread, built from the real app's layout:
 * the sidebar (threads above sessions, then the PR area), the chat in the
 * middle, the right panel's tabs (All files / Changes / Pull request /
 * Sandbox) and the terminal dock (Setup / Run / Terminal). Labels are the
 * app's own, so the picture cannot promise a panel the download does not have.
 *
 * Phones get the middle and the right panel stacked, with the sidebar hidden.
 */
import {
  ArrowUp,
  Check,
  CircleCheck,
  FileCode2,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Eye,
  Loader2,
  MessageCircleQuestion,
  MessagesSquare,
  Moon,
  Play,
  Plus,
  Search,
  Terminal,
  Workflow,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { OwlMark } from "@/components/brand/Logo";

/**
 * `filters` is the shared mock prop. Here it means "the full window": with it
 * off (feature pages, half-width columns) the sidebar is left out, because at
 * that width it would squeeze the chat and the diff to nothing.
 */
type MockProps = { filters?: boolean };

/* ---------- sidebar (mirrors layout/AppSidebar) ---------- */

type SessionRow = { name: string; repo: string; state: "running" | "idle" | "pr" | "asleep" };

const SIDEBAR_SESSIONS: SessionRow[] = [
  { name: "Add CSV export", repo: "web", state: "running" },
  { name: "Rate limit webhooks", repo: "api", state: "pr" },
  { name: "Fix flaky login test", repo: "web", state: "idle" },
  { name: "Upgrade to Node 22", repo: "api", state: "asleep" },
];

function SessionStateIcon({ state }: { state: SessionRow["state"] }) {
  switch (state) {
    case "running":
      return <Loader2 className="h-3 w-3 shrink-0 animate-spin text-status-blue" />;
    case "pr":
      return <GitPullRequest className="h-3 w-3 shrink-0 text-status-green" />;
    case "asleep":
      return <Moon className="h-3 w-3 shrink-0 text-ink-400" />;
    default:
      return <CircleCheck className="h-3 w-3 shrink-0 text-ink-400" />;
  }
}

function NavRow({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1 text-[11px] text-ink-500">
      <Icon className="h-3 w-3 shrink-0" />
      <span className="truncate">{label}</span>
    </div>
  );
}

function AppSidebar({
  active,
  thread = "Usage billing rollout",
}: {
  active: string;
  thread?: string;
}) {
  return (
    <div className="hidden w-48 shrink-0 flex-col border-r border-line bg-paper-100 lg:flex">
      <div className="flex items-center gap-2 border-b border-line p-2.5">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-clay/15">
          <OwlMark className="h-3.5 w-3.5 text-clay" />
        </span>
        <span className="truncate text-xs font-medium text-ink">Sundial</span>
      </div>
      <div className="space-y-0.5 p-1.5">
        <div className="flex items-center gap-2 rounded-md bg-white px-2 py-1 text-[11px] font-medium text-ink shadow-soft">
          <Plus className="h-3 w-3" /> New session
        </div>
        <NavRow icon={Search} label="Search" />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden px-1.5">
        <p className="px-2 pb-1 pt-2 text-[9px] font-medium uppercase tracking-wide text-ink-400">
          Threads
        </p>
        <div
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1 text-[11px]",
            active === thread ? "bg-white font-medium text-ink shadow-soft" : "text-ink-600"
          )}
        >
          <MessagesSquare className="h-3 w-3 shrink-0 text-clay" />
          <span className="truncate">{thread}</span>
        </div>
        <p className="px-2 pb-1 pt-3 text-[9px] font-medium uppercase tracking-wide text-ink-400">
          Sessions
        </p>
        {SIDEBAR_SESSIONS.map((s) => (
          <div
            key={s.name}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1 text-[11px]",
              active === s.name ? "bg-white font-medium text-ink shadow-soft" : "text-ink-600"
            )}
          >
            <SessionStateIcon state={s.state} />
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
            <span className="font-mono text-[9px] text-ink-400">{s.repo}</span>
          </div>
        ))}
      </div>
      <div className="space-y-0.5 border-t border-line p-1.5">
        <NavRow icon={GitPullRequest} label="Pull requests" />
        <NavRow icon={Eye} label="Review requests" />
        <NavRow icon={GitMerge} label="Merge queue" />
        <NavRow icon={Workflow} label="Automations" />
      </div>
    </div>
  );
}

/* ---------- shared bits ---------- */

function UserBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="ml-auto max-w-[85%] rounded-xl rounded-br-sm bg-paper-200 px-3 py-2 text-[11.5px] leading-relaxed text-ink">
      {children}
    </div>
  );
}

function AgentText({ children }: { children: React.ReactNode }) {
  return <p className="text-[11.5px] leading-relaxed text-ink-700">{children}</p>;
}

function ToolRow({ verb, target, running }: { verb: string; target: string; running?: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-line bg-paper-50 px-2 py-1 font-mono text-[10px] text-ink-500">
      {running ? (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-status-blue" />
      ) : (
        <Check className="h-3 w-3 shrink-0 text-status-green" />
      )}
      <span className="text-ink-600">{verb}</span>
      <span className="min-w-0 truncate">{target}</span>
    </div>
  );
}

function Composer({ placeholder, agent }: { placeholder: string; agent: string }) {
  return (
    <div className="border-t border-line p-2.5">
      <div className="rounded-xl border border-line-strong bg-white px-3 py-2 shadow-soft">
        <p className="text-[11px] text-ink-400">{placeholder}</p>
        <div className="mt-2 flex items-center gap-1.5">
          <span className="rounded border border-line px-1.5 py-0.5 text-[9px] text-ink-500">{agent}</span>
          <span className="rounded border border-line px-1.5 py-0.5 text-[9px] text-ink-500">Plan</span>
          <span className="ml-auto flex h-5 w-5 items-center justify-center rounded-full bg-clay text-white">
            <ArrowUp className="h-3 w-3" />
          </span>
        </div>
      </div>
    </div>
  );
}

/* ---------- session ---------- */

const CHANGED_FILES = [
  { path: "app/reports/export.ts", add: 64, del: 0 },
  { path: "app/reports/ReportsPage.tsx", add: 12, del: 3 },
  { path: "app/reports/export.test.ts", add: 41, del: 0 },
];

const DIFF_LINES: Array<{ k: "ctx" | "add" | "del"; t: string }> = [
  { k: "ctx", t: "export function ReportsPage() {" },
  { k: "del", t: "  return <Table rows={rows} />;" },
  { k: "add", t: "  return (" },
  { k: "add", t: "    <>" },
  { k: "add", t: "      <ExportButton rows={rows} />" },
  { k: "add", t: "      <Table rows={rows} />" },
  { k: "add", t: "    </>" },
  { k: "add", t: "  );" },
  { k: "ctx", t: "}" },
];

const PANEL_TABS = ["All files", "Changes", "Pull request", "Sandbox"];
const DOCK_TABS = ["Setup", "Run", "Terminal"];

export function MockSession({ filters = true }: MockProps) {
  return (
    <div className="flex bg-white text-left lg:h-[480px]">
      {filters && <AppSidebar active="Add CSV export" />}

      <div className="flex min-w-0 flex-1 flex-col md:flex-row">
        {/* chat */}
        <div className="flex min-w-0 flex-1 flex-col border-line md:border-r">
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold text-ink">Add CSV export</p>
              <p className="flex items-center gap-1 truncate font-mono text-[9.5px] text-ink-400">
                <GitBranch className="h-2.5 w-2.5 shrink-0" /> sundial/web · dana/add-csv-export
              </p>
            </div>
            <span className="flex shrink-0 items-center gap-1 rounded-md bg-ink px-2 py-1 text-[10px] font-medium text-paper">
              <GitPullRequest className="h-3 w-3" /> Create PR
            </span>
          </div>

          <div className="flex-1 space-y-2.5 overflow-hidden p-3">
            <UserBubble>
              Add a CSV export to the reports page. Keep the current column order and add a test.
            </UserBubble>
            <AgentText>
              I will add an export helper, put a button above the table, and cover it with a test.
            </AgentText>
            <div className="space-y-1">
              <ToolRow verb="Read" target="app/reports/ReportsPage.tsx" />
              <ToolRow verb="Write" target="app/reports/export.ts" />
              <ToolRow verb="Edit" target="app/reports/ReportsPage.tsx" />
              <ToolRow verb="Bash" target="npm test -- reports" running />
            </div>
          </div>

          <Composer placeholder="Ask the agent… (@ for files, / for commands)" agent="Claude" />
        </div>

        {/* right panel */}
        <div className="flex w-full min-w-0 flex-col border-t border-line md:w-[44%] md:border-t-0 lg:w-[42%]">
          <div className="flex items-center gap-0.5 overflow-hidden border-b border-line px-2 py-1.5">
            {PANEL_TABS.map((t) => (
              <span
                key={t}
                className={cn(
                  "shrink-0 rounded-md px-2 py-1 text-[10px]",
                  t === "Changes" ? "bg-paper-200 font-medium text-ink" : "text-ink-500",
                  (t === "All files" || t === "Sandbox") && "hidden sm:inline"
                )}
              >
                {t}
                {t === "Changes" && <span className="ml-1 text-status-green">+117</span>}
              </span>
            ))}
          </div>

          <div className="border-b border-line">
            {CHANGED_FILES.map((f, i) => (
              <div
                key={f.path}
                className={cn(
                  "flex items-center gap-2 px-3 py-1 font-mono text-[10px]",
                  i === 1 ? "bg-clay/[0.06] text-ink" : "text-ink-600"
                )}
              >
                <FileCode2 className="h-3 w-3 shrink-0 text-ink-400" />
                <span className="min-w-0 flex-1 truncate">{f.path}</span>
                <span className="text-status-green">+{f.add}</span>
                {f.del > 0 && <span className="text-status-red">-{f.del}</span>}
              </div>
            ))}
          </div>

          <div className="flex-1 overflow-hidden py-1.5 font-mono text-[10px] leading-[1.6]">
            {DIFF_LINES.map((l, i) => (
              <div
                key={i}
                className={cn(
                  "whitespace-pre px-3",
                  l.k === "add" && "bg-status-green/10 text-[#166534]",
                  l.k === "del" && "bg-status-red/10 text-[#991b1b]",
                  l.k === "ctx" && "text-ink-500"
                )}
              >
                <span className="mr-2 select-none text-ink-300">
                  {l.k === "add" ? "+" : l.k === "del" ? "-" : " "}
                </span>
                {l.t}
              </div>
            ))}
          </div>

          {/* terminal dock */}
          <div className="border-t border-line">
            <div className="flex items-center gap-0.5 px-2 py-1">
              {DOCK_TABS.map((t) => (
                <span
                  key={t}
                  className={cn(
                    "rounded px-2 py-0.5 text-[10px]",
                    t === "Terminal" ? "bg-paper-200 font-medium text-ink" : "text-ink-500"
                  )}
                >
                  {t === "Run" && <Play className="mr-1 inline h-2.5 w-2.5" />}
                  {t === "Terminal" && <Terminal className="mr-1 inline h-2.5 w-2.5" />}
                  {t}
                </span>
              ))}
            </div>
            <div className="bg-[#1e1b17] px-3 py-2 font-mono text-[10px] leading-relaxed">
              <div className="text-paper-100/80">$ npm test -- reports</div>
              <div className="text-status-green">✓ export.test.ts (6 tests)</div>
              <div className="text-paper-300/60">Tests  6 passed</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- thread (mirrors threads/ThreadSessionCard + WorkPanel) ---------- */

type CardKind = "started" | "pr" | "needs";

function ThreadCard({ kind, name, repo }: { kind: CardKind; name: string; repo: string }) {
  const Icon = kind === "started" ? Play : kind === "pr" ? GitPullRequest : MessageCircleQuestion;
  const title =
    kind === "started" ? "Session started" : kind === "pr" ? "Opened a pull request" : "Needs an answer";
  return (
    <div className="rounded-md border border-line bg-white text-[10.5px]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5">
        <Icon
          className={cn(
            "h-3 w-3 shrink-0",
            kind === "needs" ? "text-status-blue" : kind === "pr" ? "text-status-green" : "text-ink-400"
          )}
        />
        <span className="font-medium text-ink">{title}</span>
        <span className="min-w-0 truncate text-ink-400">
          {name} · {repo}
        </span>
        <span className="ml-auto rounded border border-line px-1.5 py-0.5 text-[9.5px] text-ink-600">
          {kind === "pr" ? "Pull request" : "Open"}
        </span>
      </div>
    </div>
  );
}

const THREAD_SESSIONS = [
  { name: "Usage API client", repo: "sundial/api", state: "PR open", tone: "text-status-green" },
  { name: "Usage page", repo: "sundial/web", state: "Needs an answer", tone: "text-status-blue" },
  { name: "Billing docs", repo: "sundial/docs", state: "Working", tone: "text-ink-500" },
];

export function MockThread({ filters = true }: MockProps) {
  return (
    <div className="flex bg-white text-left lg:h-[480px]">
      {filters && <AppSidebar active="Usage billing rollout" />}

      <div className="flex min-w-0 flex-1 flex-col md:flex-row">
        <div className="flex min-w-0 flex-1 flex-col border-line md:border-r">
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <MessagesSquare className="h-3.5 w-3.5 shrink-0 text-clay" />
            <p className="truncate text-xs font-semibold text-ink">Usage billing rollout</p>
            <span className="ml-auto shrink-0 rounded border border-line px-1.5 py-0.5 text-[9px] text-ink-500">
              Thread
            </span>
          </div>

          <div className="flex-1 space-y-2 overflow-hidden p-3">
            <UserBubble>
              Show usage in the app. The API needs an endpoint, the web app needs a page, and the docs need a section.
            </UserBubble>
            <AgentText>That touches three repositories. I am starting a session on each.</AgentText>
            <ThreadCard kind="started" name="Billing docs" repo="sundial/docs" />
            <ThreadCard kind="pr" name="Usage API client" repo="sundial/api" />
            <ThreadCard kind="needs" name="Usage page" repo="sundial/web" />
            <AgentText>
              The web session asks whether usage should round to whole hours. The API returns seconds.
            </AgentText>
          </div>

          <Composer placeholder="Reply to the thread." agent="Claude" />
        </div>

        <div className="w-full min-w-0 border-t border-line md:w-[38%] md:border-t-0">
          <p className="px-3 pb-1 pt-3 text-[9px] font-medium uppercase tracking-wide text-ink-400">
            Sessions of this thread
          </p>
          <div className="space-y-1 px-2">
            {THREAD_SESSIONS.map((s) => (
              <div key={s.name} className="rounded-md border border-line px-2.5 py-1.5">
                <p className="truncate text-[11px] font-medium text-ink">{s.name}</p>
                <p className="flex items-center gap-1.5 text-[9.5px]">
                  <span className="truncate font-mono text-ink-400">{s.repo}</span>
                  <span className={cn("ml-auto shrink-0", s.tone)}>{s.state}</span>
                </p>
              </div>
            ))}
          </div>
          <p className="px-3 pb-1 pt-4 text-[9px] font-medium uppercase tracking-wide text-ink-400">
            Repositories of this thread
          </p>
          <div className="space-y-0.5 px-3 pb-3 font-mono text-[10px] text-ink-600">
            <p>sundial/api</p>
            <p>sundial/web</p>
            <p>sundial/docs</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The banner a sleeping session shows over its changes (StoredBanner in the
 * app), as a small standalone card. Copy is the app's own.
 */
export function SleepingBanner({ className }: { className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-xl border border-line bg-white shadow-soft", className)}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[11px] text-ink-500">
        <Moon className="h-3 w-3 shrink-0" />
        <span className="min-w-0 flex-1">Sandbox is asleep. Showing changes from 2h ago.</span>
        <span className="hidden shrink-0 underline-offset-2 hover:underline sm:inline">Refresh from the sandbox</span>
      </div>
      {CHANGED_FILES.map((f) => (
        <div key={f.path} className="flex items-center gap-2 px-3 py-1 font-mono text-[10px] text-ink-600">
          <FileCode2 className="h-3 w-3 shrink-0 text-ink-400" />
          <span className="min-w-0 flex-1 truncate">{f.path}</span>
          <span className="text-status-green">+{f.add}</span>
          {f.del > 0 && <span className="text-status-red">-{f.del}</span>}
        </div>
      ))}
    </div>
  );
}
