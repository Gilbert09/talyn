import { randomBytes } from 'crypto';
import type { FleetEvent } from '../selfHosted/client.js';

/**
 * Framing for commands run through the fleet's `/exec`, so each caller reads
 * ONLY its own output.
 *
 * # Why this exists
 *
 * Exec output goes into the sandbox's events ring, and the ring is per
 * SANDBOX, not per command. The cursor an exec starts at excludes what ran
 * before it, but not what runs BESIDE it: a turn's follow stream also carries
 * the dev server's log lines, a diff's `git` output and a second chat's turn.
 * The frames name no command, so the cursor alone cannot tell them apart.
 *
 * The guest emits one frame per LINE (its `lineWriter` splits on `\n` and
 * strips it), so lines from different commands interleave but never mix
 * inside a frame. That makes a per-line tag enough: every line a framed
 * command prints starts with `@@talyn:<nonce>:<kind> `, and the demux keeps
 * only its own nonce. The nonce is random per exec, so another command cannot
 * produce a matching line by accident.
 *
 * Kinds: `o`/`e` are a raw stdout/stderr line (stream mode); `O`/`E` are
 * base64 pieces of the whole stdout/stderr (capture mode, for output that must
 * survive byte for byte — NUL-separated git output, file contents); `x` is the
 * exit code, printed once, after every other line.
 *
 * A quiet exec (the YAS branch) answers with the command's own stdout and
 * never touches the ring; the same framed script works there too, and the
 * demux reads the stdout text with the same rules.
 */

/** The guest flushes a line longer than this as a partial frame (`maxLine` in guestagent). */
export const GUEST_MAX_LINE_BYTES = 1 << 20;

/** Base64 line width for capture mode: far under the guest's line cap, so no line is ever split. */
const CAPTURE_LINE_WIDTH = 65_536;

const PID_DIR = '/tmp/talyn-run';

const MKTEMP = 'mktemp 2>/dev/null || mktemp -p /dev/shm';

export function newNonce(): string {
  return randomBytes(9).toString('hex');
}

function tag(nonce: string, kind: string): string {
  return `@@talyn:${nonce}:${kind} `;
}

/** A marker safe as a file name and as a `pkill -f` pattern. */
export function safeMarker(marker: string): string {
  return marker.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
}

/** Where a framed command records its process-group id, for `killMarkerScript`. */
export function pidFileFor(marker: string): string {
  return `${PID_DIR}/${safeMarker(marker)}.pid`;
}

/**
 * Gives every framed command `FLEET_PROXY_URL`, taken from the box's own
 * `HTTP_PROXY` (the fleet sets both to the credential proxy).
 *
 * `fleet-publish` needs it, and it is the only way to push to a repository
 * that requires signed commits. The fleet sets it for a task run only, so in a
 * session box the tool stopped with "FLEET_PROXY_URL is not set". A value the
 * box already has wins.
 */
export const FLEET_PROXY_PRELUDE =
  'if [ -z "${FLEET_PROXY_URL:-}" ] && [ -n "${HTTP_PROXY:-}" ]; then export FLEET_PROXY_URL="$HTTP_PROXY"; fi';

export type FrameMode = 'stream' | 'capture';

export interface FramedCommand {
  /** argv for the exec request. */
  cmd: string[];
  /** Env for the exec request: the caller's, plus the script itself. */
  env: Record<string, string>;
  nonce: string;
}

/**
 * Wrap `script` so its output is tagged with a fresh nonce.
 *
 * The script travels in an env var rather than inside the wrapper text, so
 * it needs no second round of quoting. It runs in its own `bash -c`, so an
 * `exit` or `set -e` in it ends the script and not the framing.
 *
 * With a `marker`, the wrapper writes its pid to a file before anything else.
 * The guest starts every exec with `Setsid`, so that pid is the process
 * GROUP, and `kill -- -<pid>` reaches the agent and everything it spawned.
 * The marker is also `$0` of both shells, for a `pkill -f` when the file is
 * gone.
 */
export function frameCommand(
  script: string,
  opts: { mode: FrameMode; marker?: string; env?: Record<string, string>; nonce?: string } = {
    mode: 'stream',
  },
): FramedCommand {
  const nonce = opts.nonce ?? newNonce();
  const marker = safeMarker(opts.marker ?? `talyn-exec-${nonce}`);
  const o = tag(nonce, opts.mode === 'stream' ? 'o' : 'O');
  const e = tag(nonce, opts.mode === 'stream' ? 'e' : 'E');
  const x = tag(nonce, 'x');
  const lines = [
    `s=$TALYN_SCRIPT; unset TALYN_SCRIPT`,
    FLEET_PROXY_PRELUDE,
    `mkdir -p ${PID_DIR} 2>/dev/null || true`,
    opts.marker ? `echo $$ > ${pidFileFor(marker)} 2>/dev/null || true` : ':',
    // /dev/shm when /tmp is full, so a full disk still runs the script and
    // its own "No space left on device" comes back framed.
    `rc_file=$(${MKTEMP})`,
  ];
  if (opts.mode === 'stream') {
    // fd 4 and fd 5 are the exec's real stdout and stderr. The inner pipeline
    // tags the script's stderr (via the 2>&1 1>&3 swap) and writes it to fd 5;
    // the outer one tags stdout and writes it to fd 4. ONE writer per pipe is
    // the point: two seds sharing a pipe can interleave inside a long line,
    // and the guest reads each pipe separately. The exit code goes to a file
    // because a pipeline's own status is the last sed's, and the `x` line is
    // printed only after both pipelines have drained. Its leading newline ends
    // a last stdout line that had none, which sed passes through as it is.
    lines.push(
      `exec 4>&1 5>&2`,
      `{ { bash -c "$s" ${marker} < /dev/null; echo $? > "$rc_file"; } 2>&1 1>&3 3>&- | sed -u 's/^/${e}/' >&5 5>&- 4>&-; } 3>&1 | sed -u 's/^/${o}/' >&4`,
    );
  } else {
    lines.push(
      `out=$(${MKTEMP}); err=$(${MKTEMP})`,
      `bash -c "$s" ${marker} < /dev/null > "$out" 2> "$err"; echo $? > "$rc_file"`,
      `base64 -w ${CAPTURE_LINE_WIDTH} < "$out" | sed 's/^/${o}/'`,
      `base64 -w ${CAPTURE_LINE_WIDTH} < "$err" | sed 's/^/${e}/'`,
      `rm -f "$out" "$err"`,
    );
  }
  lines.push(
    `printf '\\n%s%s\\n' '${x}' "$(cat "$rc_file" 2>/dev/null || echo -1)"`,
    `rm -f "$rc_file"`,
    opts.marker ? `rm -f ${pidFileFor(marker)} 2>/dev/null || true` : ':',
  );
  return {
    cmd: ['bash', '-c', lines.join('\n'), marker],
    env: { ...(opts.env ?? {}), TALYN_SCRIPT: script },
    nonce,
  };
}

/**
 * Stop a framed command by its marker: SIGINT to the whole process group so
 * the agent can stop the way Ctrl-C stops it, then TERM, then KILL for
 * anything that ignored the polite ones. Returns as soon as the group is gone.
 *
 * The marker travels in the ENV, never in the script text. `pkill -f` matches
 * command lines, and this script's own command line would otherwise contain
 * the marker (in the pid-file path) and match itself.
 */
export function killMarkerScript(marker: string, opts: { graceSeconds?: number } = {}): {
  script: string;
  env: Record<string, string>;
} {
  const ticks = Math.max(1, Math.round((opts.graceSeconds ?? 4) * 5));
  const script = [
    `m=$TALYN_MARKER; pf="${PID_DIR}/$m.pid"; pat="[$(printf %.1s "$m")]$(printf %s "$m" | cut -c2-)"`,
    `pid=$(cat "$pf" 2>/dev/null || true)`,
    `alive() { { [ -n "$pid" ] && kill -0 -- -"$pid" 2>/dev/null; } || pgrep -f "$pat" >/dev/null 2>&1; }`,
    `send() { if [ -n "$pid" ]; then kill -"$1" -- -"$pid" 2>/dev/null || true; fi; pkill -"$1" -f "$pat" 2>/dev/null || true; }`,
    `wait_gone() { i=0; while [ "$i" -lt "$1" ] && alive; do sleep 0.2; i=$((i+1)); done; }`,
    `send INT; wait_gone ${ticks}`,
    `if alive; then send TERM; wait_gone 10; fi`,
    `if alive; then send KILL; fi`,
    `rm -f "$pf"`,
  ].join('\n');
  return { script, env: { TALYN_MARKER: safeMarker(marker) } };
}

/** Exit 0 while the marker's process group is alive. The marker is in the env, as above. */
export function aliveMarkerScript(marker: string): { script: string; env: Record<string, string> } {
  return {
    script: `pid=$(cat "${PID_DIR}/$TALYN_MARKER.pid" 2>/dev/null) && kill -0 -- -"$pid" 2>/dev/null`,
    env: { TALYN_MARKER: safeMarker(marker) },
  };
}

export interface DemuxResult {
  /** The exit code from our own trailer, or null when it never arrived. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Reads framed output back. Feed it lines (one guest frame each, or one line
 * of a quiet exec's stdout); it keeps the ones carrying its nonce.
 *
 * Stream mode hands each stdout line to `onStdoutLine` as it arrives; capture
 * mode accumulates and decodes at `result()`.
 */
export class FrameDemux {
  private readonly prefix: string;
  private readonly stdoutLines: string[] = [];
  private readonly stderrLines: string[] = [];
  private stdoutB64 = '';
  private stderrB64 = '';
  private exit: number | null = null;
  /**
   * A tagged line longer than the guest's line cap arrives as a partial frame
   * followed by the rest, untagged. Held here until the line ends.
   */
  private partial: { kind: string; text: string } | null = null;

  constructor(
    readonly nonce: string,
    private readonly onStdoutLine?: (line: string) => void,
    private readonly onStderrLine?: (line: string) => void,
  ) {
    this.prefix = `@@talyn:${nonce}:`;
  }

  /** True once the `x` trailer has been read. */
  get done(): boolean {
    return this.exit !== null;
  }

  pushLine(line: string): void {
    if (this.partial) {
      // The continuation of our over-long line. Ambiguous only if another
      // command printed between the two halves, which the guest makes rare by
      // emitting both halves from one write.
      const joined = this.partial.text + line;
      if (Buffer.byteLength(line, 'utf8') > GUEST_MAX_LINE_BYTES) {
        this.partial.text = joined;
        return;
      }
      const kind = this.partial.kind;
      this.partial = null;
      this.accept(kind, joined);
      return;
    }
    if (!line.startsWith(this.prefix)) return;
    const rest = line.slice(this.prefix.length);
    const kind = rest[0];
    if (!kind || rest[1] !== ' ') return;
    const body = rest.slice(2);
    if (
      (kind === 'o' || kind === 'e') &&
      Buffer.byteLength(line, 'utf8') > GUEST_MAX_LINE_BYTES
    ) {
      this.partial = { kind, text: body };
      return;
    }
    this.accept(kind, body);
  }

  /** A quiet exec's stdout (or stderr) as one string. */
  pushText(text: string): void {
    for (const line of text.split('\n')) {
      if (line) this.pushLine(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
  }

  /** Every `exec_output` frame among `events`. Other frame kinds are ignored. */
  pushEvents(events: readonly FleetEvent[]): void {
    for (const ev of events) {
      const data = execOutputData(ev);
      if (data !== null) this.pushLine(data);
    }
  }

  private accept(kind: string, body: string): void {
    switch (kind) {
      case 'o':
        if (this.onStdoutLine) this.onStdoutLine(body);
        else this.stdoutLines.push(body);
        return;
      case 'e':
        if (this.onStderrLine) this.onStderrLine(body);
        // Kept either way, bounded: the tail is what explains a failure.
        this.stderrLines.push(body);
        if (this.stderrLines.length > 200) this.stderrLines.shift();
        return;
      case 'O':
        this.stdoutB64 += body;
        return;
      case 'E':
        this.stderrB64 += body;
        return;
      case 'x': {
        const code = Number.parseInt(body.trim(), 10);
        this.exit = Number.isFinite(code) ? code : -1;
        return;
      }
      default:
        return;
    }
  }

  result(): DemuxResult {
    const decode = (b64: string) => (b64 ? Buffer.from(b64, 'base64').toString('utf8') : '');
    return {
      exitCode: this.exit,
      stdout: this.stdoutB64 ? decode(this.stdoutB64) : this.stdoutLines.join('\n'),
      stderr: this.stderrB64 ? decode(this.stderrB64) : this.stderrLines.join('\n'),
    };
  }

  /** The raw bytes of a capture-mode stdout, for binary file contents. */
  stdoutBytes(): Buffer {
    return Buffer.from(this.stdoutB64, 'base64');
  }
}

/** The line an `exec_output` frame carries, or null for any other frame. */
export function execOutputData(ev: FleetEvent): string | null {
  const e = ev.event as { type?: unknown; raw?: unknown };
  if (e?.type !== 'exec_output') return null;
  const raw = e.raw as { data?: unknown } | undefined;
  return typeof raw?.data === 'string' ? raw.data : null;
}

/**
 * Sections in one capture: each `label` command's stdout, base64'd on its own
 * line, so several outputs (NUL-separated git lists among them) come back from
 * one exec without a delimiter that could appear inside them.
 */
export function sectionsScript(sections: Array<{ label: string; command: string }>): string {
  const out = ['emit() { printf "%s %s\\n" "$1" "$(base64 -w 0)"; }'];
  for (const s of sections) {
    if (!/^[A-Z_]+$/.test(s.label)) throw new Error(`invalid section label: ${s.label}`);
    out.push(`{ ${s.command} ; } 2>/dev/null | emit ${s.label}`);
  }
  return out.join('\n');
}

export function parseSections(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const match = /^([A-Z_]+) ?(.*)$/.exec(line);
    if (!match) continue;
    out[match[1]] = match[2] ? Buffer.from(match[2], 'base64').toString('utf8') : '';
  }
  return out;
}
