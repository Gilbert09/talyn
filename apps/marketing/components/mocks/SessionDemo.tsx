"use client";

/**
 * The hero's session mock, played as a short film: the prompt is typed and
 * sent, the agent reads and edits files while the diff fills in, the tests
 * run, then Create PR opens a pull request, its checks go green and Merge
 * lands it.
 *
 * Everything on screen is a function of one clock, `t` in milliseconds, read
 * against the cue times in `CUE`. That keeps each step a plain comparison and
 * makes Replay a reset of the clock.
 *
 * It plays once, when it scrolls into view, and stops on the merged pull
 * request with a Replay button. Visitors who prefer reduced motion get that
 * last frame and no animation. Labels are the app's own (Create PR, Merge,
 * Merged, the panel and dock tabs), as in the static mock.
 *
 * The box has a fixed height at every width, so nothing below it moves while
 * messages and files appear. The chat is anchored to the bottom, like the
 * real one, so the newest message stays in view.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  CircleDot,
  FileCode2,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Loader2,
  Play,
  RotateCcw,
  Terminal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  AgentText,
  AppSidebar,
  CHANGED_FILES,
  DIFF_LINES,
  DOCK_TABS,
  PANEL_TABS,
  SIDEBAR_SESSIONS,
  ToolRow,
  UserBubble,
  type SessionRow,
} from "@/components/mocks/SessionMocks";

const PROMPT =
  "Add a CSV export to the reports page. Keep the current column order and add a test.";
const TYPE_MS = 34;

/** Cue times in ms. Each is when that thing first appears or changes. */
const CUE = {
  typeStart: 700,
  send: 700 + PROMPT.length * TYPE_MS + 450,
  plan: 0,
  read: 0,
  write: 0,
  edit: 0,
  testWrite: 0,
  bash: 0,
  bashDone: 0,
  done: 0,
  createPr: 0,
  prMessage: 0,
  prOpen: 0,
  lint: 0,
  build: 0,
  tests: 0,
  merge: 0,
  merged: 0,
  end: 0,
};
{
  // Laid out from `send` so the prompt length can change without retiming.
  let at = CUE.send;
  const step = (ms: number) => (at += ms);
  CUE.plan = step(700);
  CUE.read = step(700);
  CUE.write = step(650);
  CUE.edit = step(800);
  CUE.testWrite = step(800);
  CUE.bash = step(750);
  CUE.bashDone = step(1500);
  CUE.done = step(600);
  CUE.createPr = step(1100);
  CUE.prMessage = step(450);
  CUE.prOpen = step(1300);
  CUE.lint = step(900);
  CUE.build = step(700);
  CUE.tests = step(800);
  CUE.merge = step(1100);
  CUE.merged = step(550);
  CUE.end = step(400);
}

const SESSION_NAME = "Add CSV export";
const OTHER_ROWS = SIDEBAR_SESSIONS.filter((r) => r.name !== SESSION_NAME);

/** A message or row that has just appeared fades up into place. */
const appear = "animate-fade-up";

function useClock() {
  const [t, setT] = useState(0);
  const [done, setDone] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const raf = useRef<number>();

  const run = useCallback(() => {
    cancelAnimationFrame(raf.current ?? 0);
    setDone(false);
    const start = performance.now();
    const tick = (now: number) => {
      const elapsed = now - start;
      if (elapsed >= CUE.end) {
        setT(CUE.end);
        setDone(true);
        return;
      }
      setT(elapsed);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setT(CUE.end);
      setDone(true);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !started.current) {
          started.current = true;
          run();
          io.disconnect();
        }
      },
      { threshold: 0.35 }
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf.current ?? 0);
    };
  }, [run]);

  return { t, done, replay: run, ref };
}

type ToolState = { verb: string; target: string; at: number; until: number };

const TOOLS: ToolState[] = [
  { verb: "Read", target: "app/reports/ReportsPage.tsx", at: 0, until: 0 },
  { verb: "Write", target: "app/reports/export.ts", at: 0, until: 0 },
  { verb: "Edit", target: "app/reports/ReportsPage.tsx", at: 0, until: 0 },
  { verb: "Write", target: "app/reports/export.test.ts", at: 0, until: 0 },
  { verb: "Bash", target: "npm test -- reports", at: 0, until: 0 },
];
TOOLS[0].at = CUE.read;
TOOLS[0].until = CUE.write;
TOOLS[1].at = CUE.write;
TOOLS[1].until = CUE.edit;
TOOLS[2].at = CUE.edit;
TOOLS[2].until = CUE.testWrite;
TOOLS[3].at = CUE.testWrite;
TOOLS[3].until = CUE.bash;
TOOLS[4].at = CUE.bash;
TOOLS[4].until = CUE.bashDone;

/** When each changed file shows up in the Changes list. */
const FILE_AT = [CUE.edit, CUE.testWrite, CUE.bash];

const CHECKS = [
  { name: "lint", at: () => CUE.lint },
  { name: "build", at: () => CUE.build },
  { name: "test", at: () => CUE.tests },
];

export function SessionDemo() {
  const { t, done, replay, ref } = useClock();
  const at = (cue: number) => t >= cue;

  const typed = at(CUE.send)
    ? ""
    : PROMPT.slice(0, Math.max(0, Math.floor((t - CUE.typeStart) / TYPE_MS)));
  const typing = at(CUE.typeStart) && !at(CUE.send);

  const files = CHANGED_FILES.filter((_, i) => at(FILE_AT[i]));
  const added = files.reduce((n, f) => n + f.add, 0);

  const prTab = at(CUE.prOpen);
  const merged = at(CUE.merged);
  const green = at(CUE.tests);

  const rowState: SessionRow["state"] = merged
    ? "merged"
    : prTab
      ? "pr"
      : at(CUE.done)
        ? "idle"
        : "running";
  const rows: SessionRow[] = at(CUE.send)
    ? [{ name: SESSION_NAME, repo: "web", state: rowState }, ...OTHER_ROWS]
    : OTHER_ROWS;

  return (
    <div
      ref={ref}
      className="relative flex h-[640px] bg-white text-left md:h-[460px] lg:h-[480px]"
    >
      <AppSidebar active={at(CUE.send) ? SESSION_NAME : ""} rows={rows} />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
        {/* chat */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col border-line md:border-r">
          <div className="flex h-[46px] shrink-0 items-center gap-2 border-b border-line px-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold text-ink">
                {at(CUE.send) ? SESSION_NAME : "New session"}
              </p>
              <p className="flex items-center gap-1 truncate font-mono text-[9.5px] text-ink-400">
                <GitBranch className="h-2.5 w-2.5 shrink-0" /> sundial/web
                {at(CUE.send) && " · dana/add-csv-export"}
              </p>
            </div>
            <HeaderAction t={t} />
          </div>

          <div className="flex min-h-0 flex-1 flex-col justify-end gap-2.5 overflow-hidden p-3">
            {!at(CUE.send) && (
              <p className="m-auto text-center text-[11px] text-ink-400">
                Sandbox ready · sundial/web
              </p>
            )}
            {at(CUE.send) && (
              <div className={appear}>
                <UserBubble>{PROMPT}</UserBubble>
              </div>
            )}
            {at(CUE.plan) && (
              <div className={appear}>
                <AgentText>
                  I will add an export helper, put a button above the table, and
                  cover it with a test.
                </AgentText>
              </div>
            )}
            {at(CUE.read) && (
              <div className="space-y-1">
                {TOOLS.filter((x) => at(x.at)).map((x) => (
                  <div key={x.verb + x.target} className={appear}>
                    <ToolRow verb={x.verb} target={x.target} running={!at(x.until)} />
                  </div>
                ))}
              </div>
            )}
            {at(CUE.done) && (
              <div className={appear}>
                <AgentText>
                  Done. The export keeps the column order, and the 6 new tests pass.
                </AgentText>
              </div>
            )}
            {at(CUE.prMessage) && (
              <div className={appear}>
                <UserBubble>Create a pull request</UserBubble>
              </div>
            )}
            {at(CUE.prOpen) && (
              <div className={appear}>
                <AgentText>
                  Opened #482, &ldquo;Add a CSV export to the reports page&rdquo;.
                </AgentText>
              </div>
            )}
          </div>

          <DemoComposer value={typed} typing={typing} sending={at(CUE.send - 250) && !at(CUE.send)} />
        </div>

        {/* right panel */}
        <div className="flex h-[260px] w-full min-w-0 shrink-0 flex-col border-t border-line md:h-auto md:w-[44%] md:border-t-0 lg:w-[42%]">
          <div className="flex items-center gap-0.5 overflow-hidden border-b border-line px-2 py-1.5">
            {PANEL_TABS.map((tab) => {
              const active = prTab ? tab === "Pull request" : tab === "Changes";
              return (
                <span
                  key={tab}
                  className={cn(
                    "shrink-0 rounded-md px-2 py-1 text-[10px] transition-colors",
                    active ? "bg-paper-200 font-medium text-ink" : "text-ink-500",
                    (tab === "All files" || tab === "Sandbox") && "hidden sm:inline"
                  )}
                >
                  {tab}
                  {tab === "Changes" && added > 0 && (
                    <span className="ml-1 text-status-green">+{added}</span>
                  )}
                </span>
              );
            })}
          </div>

          {prTab ? (
            <PullRequestPanel t={t} merged={merged} green={green} />
          ) : (
            <ChangesPanel files={files} showDiff={at(CUE.testWrite)} />
          )}

          {/* terminal dock */}
          <div className="hidden border-t border-line md:block">
            <div className="flex items-center gap-0.5 px-2 py-1">
              {DOCK_TABS.map((tab) => (
                <span
                  key={tab}
                  className={cn(
                    "rounded px-2 py-0.5 text-[10px]",
                    tab === "Terminal" ? "bg-paper-200 font-medium text-ink" : "text-ink-500"
                  )}
                >
                  {tab === "Run" && <Play className="mr-1 inline h-2.5 w-2.5" />}
                  {tab === "Terminal" && <Terminal className="mr-1 inline h-2.5 w-2.5" />}
                  {tab}
                </span>
              ))}
            </div>
            <div className="h-[62px] bg-[#1e1b17] px-3 py-2 font-mono text-[10px] leading-relaxed">
              {at(CUE.bash) ? (
                <>
                  <div className="text-paper-100/80">$ npm test -- reports</div>
                  {at(CUE.bashDone) ? (
                    <>
                      <div className="text-status-green">✓ export.test.ts (6 tests)</div>
                      <div className="text-paper-300/60">Tests  6 passed</div>
                    </>
                  ) : (
                    <div className="text-paper-300/60">running…</div>
                  )}
                </>
              ) : (
                <div className="text-paper-300/60">$</div>
              )}
            </div>
          </div>
        </div>
      </div>

      {done && !reducedMotion() && (
        <button
          type="button"
          onClick={replay}
          className="absolute bottom-3 right-3 z-10 flex items-center gap-1.5 rounded-full border border-line-strong bg-white/90 px-3 py-1.5 text-[11px] font-medium text-ink-600 shadow-soft backdrop-blur transition-colors hover:text-ink"
        >
          <RotateCcw className="h-3 w-3" /> Replay
        </button>
      )}
    </div>
  );
}

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** The header button follows the app: Create PR, then Merge, then Merged. */
function HeaderAction({ t }: { t: number }) {
  if (t >= CUE.merged) {
    return (
      <span className="flex shrink-0 items-center gap-1 rounded-md bg-status-purple/10 px-2 py-1 text-[10px] font-medium text-status-purple">
        <GitMerge className="h-3 w-3" /> Merged
      </span>
    );
  }
  if (t >= CUE.tests) {
    return (
      <span
        className={cn(
          "flex shrink-0 items-center gap-1 rounded-md bg-ink px-2 py-1 text-[10px] font-medium text-paper transition-transform",
          t >= CUE.merge && "scale-95 ring-2 ring-clay/40"
        )}
      >
        <GitMerge className="h-3 w-3" /> Merge
      </span>
    );
  }
  if (t >= CUE.prOpen) {
    return (
      <span className="flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-1 text-[10px] text-ink-500">
        <GitPullRequest className="h-3 w-3 text-status-green" /> #482
      </span>
    );
  }
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-md bg-ink px-2 py-1 text-[10px] font-medium text-paper transition-all",
        t < CUE.done && "opacity-40",
        t >= CUE.createPr && "scale-95 ring-2 ring-clay/40"
      )}
    >
      <GitPullRequest className="h-3 w-3" /> Create PR
    </span>
  );
}

function DemoComposer({
  value,
  typing,
  sending,
}: {
  value: string;
  typing: boolean;
  sending: boolean;
}) {
  return (
    <div className="shrink-0 border-t border-line p-2.5">
      <div className="rounded-xl border border-line-strong bg-white px-3 py-2 shadow-soft">
        <p className={cn("min-h-[17px] text-[11px]", value ? "text-ink" : "text-ink-400")}>
          {value || (typing ? "" : "Ask the agent… (@ for files, / for commands)")}
          {typing && (
            <span className="ml-px inline-block h-[11px] w-px translate-y-[2px] animate-caret bg-ink" />
          )}
        </p>
        <div className="mt-2 flex items-center gap-1.5">
          <span className="rounded border border-line px-1.5 py-0.5 text-[9px] text-ink-500">
            Claude
          </span>
          <span className="rounded border border-line px-1.5 py-0.5 text-[9px] text-ink-500">
            Plan
          </span>
          <span
            className={cn(
              "ml-auto flex h-5 w-5 items-center justify-center rounded-full bg-clay text-white transition-transform",
              sending && "scale-90 ring-2 ring-clay/40"
            )}
          >
            <ArrowUp className="h-3 w-3" />
          </span>
        </div>
      </div>
    </div>
  );
}

function ChangesPanel({
  files,
  showDiff,
}: {
  files: typeof CHANGED_FILES;
  showDiff: boolean;
}) {
  if (files.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-[11px] text-ink-400">
        No changes yet
      </div>
    );
  }
  return (
    <>
      <div className="border-b border-line">
        {files.map((f, i) => (
          <div
            key={f.path}
            className={cn(
              "flex items-center gap-2 px-3 py-1 font-mono text-[10px]",
              appear,
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
      <div className="min-h-0 flex-1 overflow-hidden py-1.5 font-mono text-[10px] leading-[1.6]">
        {showDiff &&
          DIFF_LINES.map((l, i) => (
            <div
              key={i}
              className={cn(
                "whitespace-pre px-3",
                appear,
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
    </>
  );
}

function PullRequestPanel({
  t,
  merged,
  green,
}: {
  t: number;
  merged: boolean;
  green: boolean;
}) {
  return (
    <div className={cn("min-h-0 flex-1 space-y-3 overflow-hidden p-3", appear)}>
      <div>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
              merged
                ? "bg-status-purple/10 text-status-purple"
                : "bg-status-green/10 text-status-green"
            )}
          >
            {merged ? (
              <GitMerge className="h-3 w-3" />
            ) : (
              <GitPullRequest className="h-3 w-3" />
            )}
            {merged ? "Merged" : "Open"}
          </span>
          <span className="font-mono text-[10px] text-ink-400">#482</span>
        </div>
        <p className="mt-1.5 text-xs font-semibold text-ink">
          Add a CSV export to the reports page
        </p>
        <p className="mt-0.5 font-mono text-[9.5px] text-ink-400">
          dana/add-csv-export → main · 3 files · +117 −3
        </p>
      </div>

      <div className="rounded-lg border border-line">
        <p className="border-b border-line px-2.5 py-1.5 text-[10px] font-medium text-ink-600">
          {green ? "All checks passed" : "Checks"}
        </p>
        {CHECKS.map((c) => {
          const passed = t >= c.at();
          return (
            <div
              key={c.name}
              className="flex items-center gap-2 px-2.5 py-1 font-mono text-[10px] text-ink-600"
            >
              {passed ? (
                <Check className="h-3 w-3 shrink-0 text-status-green" />
              ) : (
                <Loader2 className="h-3 w-3 shrink-0 animate-spin text-status-amber" />
              )}
              <span className="flex-1">{c.name}</span>
              <span className="text-ink-400">{passed ? "passed" : "running"}</span>
            </div>
          );
        })}
      </div>

      {/* Left out on phones: the panel is a short strip there, and the
          checks are the part that matters. */}
      <div className="hidden items-start gap-2 text-[10.5px] leading-relaxed text-ink-500 md:flex">
        <CircleDot className="mt-0.5 h-3 w-3 shrink-0 text-ink-300" />
        <span>
          Adds an Export CSV button above the reports table. Columns keep their
          current order. Covered by 6 new tests.
        </span>
      </div>
    </div>
  );
}
