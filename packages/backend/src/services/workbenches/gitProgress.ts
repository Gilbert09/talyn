/**
 * Git's own progress lines from a clone or fetch, read one stderr line at a
 * time (the clone script turns git's `\r` updates into lines), and mapped to
 * one percentage for the whole step that never goes backwards.
 */

export type GitProgressPhase = 'remote' | 'receiving' | 'resolving' | 'updating';

export interface GitProgressLine {
  phase: GitProgressPhase;
  /** What git calls the phase, e.g. "Receiving objects". */
  label: string;
  percent: number;
}

const PHASES: Array<{ re: RegExp; phase: GitProgressPhase }> = [
  { re: /^remote: (Enumerating objects|Counting objects|Compressing objects):\s+(\d{1,3})%/, phase: 'remote' },
  { re: /^(Receiving objects):\s+(\d{1,3})%/, phase: 'receiving' },
  { re: /^(Resolving deltas):\s+(\d{1,3})%/, phase: 'resolving' },
  { re: /^(Updating files):\s+(\d{1,3})%/, phase: 'updating' },
];

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

function clean(line: string): string {
  // A `\r` left in a line means the last update in it is the one that counts.
  const parts = line.replace(ANSI, '').split('\r').map((p) => p.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** One progress line, or null for anything else. */
export function parseGitProgressLine(line: string): GitProgressLine | null {
  const text = clean(line);
  for (const { re, phase } of PHASES) {
    const m = re.exec(text);
    if (!m) continue;
    const percent = Number(m[2]);
    if (!Number.isFinite(percent) || percent > 100) return null;
    return { phase, label: phase === 'remote' ? 'Preparing objects' : m[1], percent };
  }
  return null;
}

/** True for any line that is git progress, including the summary lines that end a phase. */
export function isGitProgressLine(line: string): boolean {
  const text = clean(line);
  if (!text) return false;
  if (parseGitProgressLine(text)) return true;
  return /^(remote: )?(Enumerating objects|Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files|Checking connectivity|Checking objects|Unpacking objects|Total \d+)\b/.test(text);
}

/** The last `count` stderr lines that are not git progress: what an error message should quote. */
export function meaningfulStderrTail(stderr: string, count = 3): string {
  return stderr
    .split('\n')
    .map((line) => line.replace(ANSI, '').split('\r').pop()!.trim())
    .filter((line) => line && !isGitProgressLine(line))
    .slice(-count)
    .join(' ');
}

/**
 * Where each phase sits in one round of a fetch. A later round (a deepen,
 * or a second fetch) maps into what is left below the checkout's share.
 */
const ROUND_RANGE: Record<Exclude<GitProgressPhase, 'updating'>, [number, number]> = {
  remote: [0, 10],
  receiving: [10, 80],
  resolving: [80, 95],
};
const ROUND_END = 95;
const ORDER: Record<GitProgressPhase, number> = { remote: 0, receiving: 1, resolving: 2, updating: 3 };

export interface GitProgressState {
  percent: number;
  detail: string;
}

/**
 * Turns progress lines into one percentage. Feed it every stderr line; it
 * answers the new state when a progress line moved the percentage or changed
 * the phase, else null.
 */
export class GitProgressTracker {
  private overall = 0;
  private roundStart = 0;
  private lastOrder = -1;
  private lastDetail: string | null = null;
  private seen = false;

  push(line: string): GitProgressState | null {
    const parsed = parseGitProgressLine(line);
    if (!parsed) return null;
    const order = ORDER[parsed.phase];
    // A phase earlier than the last one starts a new round: a second fetch.
    if (parsed.phase !== 'updating' && order < this.lastOrder && this.lastOrder !== ORDER.updating) {
      this.roundStart = this.overall;
    }
    this.lastOrder = order;
    let mapped: number;
    if (parsed.phase === 'updating') {
      mapped = ROUND_END + (100 - ROUND_END) * (parsed.percent / 100);
    } else {
      const [from, to] = ROUND_RANGE[parsed.phase];
      const scale = (ROUND_END - this.roundStart) / ROUND_END;
      mapped = this.roundStart + scale * (from + (to - from) * (parsed.percent / 100));
    }
    const next = Math.max(this.overall, Math.min(100, mapped));
    const changed = !this.seen || Math.floor(next) !== Math.floor(this.overall) || parsed.label !== this.lastDetail;
    this.seen = true;
    this.overall = next;
    this.lastDetail = parsed.label;
    return changed ? { percent: Math.floor(next), detail: parsed.label } : null;
  }

  get percent(): number | null {
    return this.seen ? Math.floor(this.overall) : null;
  }
}
