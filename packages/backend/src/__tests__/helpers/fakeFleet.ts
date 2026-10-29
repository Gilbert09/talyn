import {
  FleetHttpError,
  type CreateSandboxInput,
  type FleetClient,
  type FleetEvent,
  type FleetExecFrame,
  type FleetExecRequest,
} from '../../services/selfHosted/client.js';

/**
 * A stand-in for the fleet that speaks the exec contract the way the real one
 * does: one `exec_output` frame per LINE, in a ring shared by every command on
 * the sandbox, with the framed command's tags reproduced. It does not run
 * bash — CI includes Windows — so a test supplies what each script "printed".
 */

export interface ExecReply {
  /** Stdout, as lines or one string. */
  stdout?: string | string[];
  stderr?: string;
  exitCode?: number;
  /** Follow mode: resolve to let the command end. Rejecting, or `killed`, ends it with no trailer. */
  hold?: Promise<void>;
  /** The process died without printing its exit trailer. */
  killed?: boolean;
}

export type ExecHandler = (script: string, req: FleetExecRequest) => ExecReply | Promise<ExecReply>;

function nonceOf(req: FleetExecRequest): { nonce: string; capture: boolean } {
  const wrapper = req.cmd[2] ?? '';
  const match = /@@talyn:([0-9a-f]+):([oO]) /.exec(wrapper);
  if (!match) throw new Error('fake fleet: the command is not framed');
  return { nonce: match[1], capture: match[2] === 'O' };
}

/** The script that saves a session's work into Talyn's storage (`workSaveScript`). */
export function isWorkSaveScript(script: string, kind?: 'checkpoint' | 'archive'): boolean {
  return script.includes('git commit-tree') && script.includes(kind ? `talyn work ${kind} ` : 'talyn work ');
}

export class FakeFleet {
  created: CreateSandboxInput[] = [];
  deleted: string[] = [];
  credentialPushes: Array<{ id: string; creds: Record<string, unknown> }> = [];
  /** Every script run, in order. */
  scripts: string[] = [];
  execs: Array<{ script: string; req: FleetExecRequest; follow: boolean }> = [];
  handler: ExecHandler = () => ({ exitCode: 0 });
  /** How many events one SSE frame carries in follow mode. */
  frameSize = 3;
  /** Lines another command "printed" into the same ring, interleaved with ours. */
  noise: string[] = ['dev server listening on 3000', '@@talyn:deadbeef:o {"type":"assistant","foreign":true}'];
  private seq = 0;
  durableLogs = new Map<string, ExecReply>();
  durableFollowOffsets: number[] = [];
  /**
   * Decides a durable launch, by log path. `exitCode` other than 0 is a
   * launcher that gave up; `lateStart` means the supervisor started anyway.
   */
  launchHandler?: (logPath: string) => { exitCode: number; stderr?: string; lateStart?: boolean } | undefined;
  /** Log paths whose start marker a fence created. */
  fenced = new Set<string>();
  /** Forces the fence's exit code (4 = the directory is not writable). */
  fenceExitCode?: number;
  launches: string[] = [];
  /** While set, every sandbox call is refused with `remote_resume_required` until `resumeSandbox` ends. */
  hibernated = false;
  resumeGate: Promise<void> = Promise.resolve();
  resumes = 0;

  asClient(): FleetClient {
    return this as unknown as FleetClient;
  }

  private event(type: string, raw: unknown, subtype?: string): FleetEvent {
    return { seq: ++this.seq, at: new Date().toISOString(), event: { type, ...(subtype ? { subtype } : {}), raw } };
  }

  private line(data: string, stream = 'stdout'): FleetEvent {
    return this.event('exec_output', { stream, data }, stream);
  }

  private output(req: FleetExecRequest, reply: ExecReply): { body: FleetEvent[]; trailer: FleetEvent[] } {
    const { nonce, capture } = nonceOf(req);
    const stdout = Array.isArray(reply.stdout) ? reply.stdout : (reply.stdout ?? '').split('\n');
    const tag = (kind: string) => `@@talyn:${nonce}:${kind} `;
    const body: FleetEvent[] = [];
    if (capture) {
      const out = Array.isArray(reply.stdout) ? reply.stdout.join('\n') : (reply.stdout ?? '');
      const b64 = Buffer.from(out, 'utf8').toString('base64');
      for (let i = 0; i < b64.length; i += 60) body.push(this.line(tag('O') + b64.slice(i, i + 60)));
      if (reply.stderr) body.push(this.line(tag('E') + Buffer.from(reply.stderr, 'utf8').toString('base64')));
    } else {
      for (const l of stdout) if (l !== '') body.push(this.line(tag('o') + l));
      for (const l of (reply.stderr ?? '').split('\n')) if (l) body.push(this.line(tag('e') + l, 'stderr'));
    }
    const code = reply.exitCode ?? 0;
    const trailer = reply.killed
      ? [this.event('exec_exit', { exitCode: -1, signal: 'interrupt' })]
      : [this.line(''), this.line(`${tag('x')}${code}`), this.event('exec_exit', { exitCode: code })];
    return { body, trailer };
  }

  private async run(req: FleetExecRequest, follow: boolean): Promise<ExecReply> {
    if (this.hibernated) throw new FleetHttpError('this sandbox is hibernated', 409, 'remote_resume_required');
    if (req.env?.TALYN_LOG_FENCE) {
      const log = req.env.TALYN_LOG_FENCE.replace(/\.started$/, '.log');
      if (this.fenceExitCode !== undefined) return { exitCode: this.fenceExitCode };
      if (this.durableLogs.has(log) || this.fenced.has(log)) return { exitCode: 3 };
      this.fenced.add(log);
      return { exitCode: 0 };
    }
    if (req.env?.TALYN_LOG_PROBE) {
      const log = req.env.TALYN_LOG_PROBE;
      return { exitCode: this.durableLogs.has(log) || this.fenced.has(log) ? 0 : 1 };
    }
    if (req.env?.TALYN_DURABLE_SCRIPT) {
      const script = req.env.TALYN_DURABLE_SCRIPT;
      const key = JSON.parse(req.env.TALYN_LOG_PATHS).log as string;
      this.launches.push(key);
      // A fenced attempt's supervisor finds the marker and exits: its launcher gives up.
      if (this.fenced.has(key)) return { exitCode: 1, stderr: 'start marker exists' };
      const decided = this.launchHandler?.(key);
      if (decided && decided.exitCode !== 0) {
        if (decided.lateStart && !this.durableLogs.has(key)) {
          this.scripts.push(script);
          this.execs.push({ script, req, follow });
          this.durableLogs.set(key, await this.handler(script, req));
        }
        return { exitCode: decided.exitCode, stderr: decided.stderr };
      }
      this.scripts.push(script);
      this.execs.push({ script, req, follow });
      if (!this.durableLogs.has(key)) this.durableLogs.set(key, await this.handler(script, req));
      return { exitCode: 0 };
    }
    if (req.env?.TALYN_LOG_OFFSET !== undefined) {
      this.durableFollowOffsets.push(Number(req.env.TALYN_LOG_OFFSET));
      const key = JSON.parse(req.env.TALYN_LOG_PATHS).log as string;
      const reply = this.durableLogs.get(key);
      if (!reply) return { exitCode: 125 };
      const records: Array<{stream: string; line: string}> = [];
      for (const line of Array.isArray(reply.stdout) ? reply.stdout : (reply.stdout ?? '').split('\n')) {
        if (line) records.push({ stream: 'stdout', line });
      }
      for (const line of (reply.stderr ?? '').split('\n')) if (line) records.push({ stream: 'stderr', line });
      let offset = 0;
      const stdout = records.map((record) => {
        const raw = JSON.stringify(record);
        offset += Buffer.byteLength(raw + '\n');
        return offset > Number(req.env?.TALYN_LOG_OFFSET) && (!Number(req.env?.TALYN_LOG_LIMIT) || offset <= Number(req.env?.TALYN_LOG_LIMIT)) ? `${offset} ${Buffer.from(raw).toString('base64')}` : '';
      }).filter(Boolean);
      return { ...reply, stdout, stderr: '', hold: Number(req.env?.TALYN_LOG_LIMIT) ? undefined : reply.hold, killed: false, exitCode: Number(req.env?.TALYN_LOG_LIMIT) ? 0 : reply.killed ? 125 : reply.exitCode };
    }
    const script = req.env?.TALYN_SCRIPT ?? '';
    this.scripts.push(script);
    this.execs.push({ script, req, follow });
    const reply = await this.handler(script, req);
    // A box with nothing to save, unless the test says otherwise: a saved-work
    // script that "printed" nothing would read as a failure to save.
    // A handler that answers every `git commit-tree` with a sha is answering the turn checkpoint, not this.
    const out = Array.isArray(reply.stdout) ? reply.stdout.join('\n') : reply.stdout ?? '';
    if (isWorkSaveScript(script) && !reply.exitCode && !reply.killed && !reply.hold && !/^(CLEAN|UNCHANGED|BUNDLE|TOO_LARGE)\b/m.test(out)) {
      return { ...reply, stdout: 'CLEAN' };
    }
    return reply;
  }

  async createSandbox(input: CreateSandboxInput) {
    this.created.push(input);
    return { sandbox: { id: input.id, status: 'idle' as const }, host: 'host-1' };
  }

  async exec(_id: string, req: FleetExecRequest): Promise<FleetExecFrame> {
    const start = this.seq;
    const reply = await this.run(req, false);
    const { body, trailer } = this.output(req, reply);
    return { events: [...body, ...trailer], cursor: start + body.length + trailer.length, terminal: true };
  }

  async quietExec(id: string, req: FleetExecRequest) {
    return { kind: 'events' as const, frame: await this.exec(id, req) };
  }

  async *execFollow(_id: string, req: FleetExecRequest, signal: AbortSignal): AsyncGenerator<FleetExecFrame> {
    const reply = await this.run(req, true);
    const { body } = this.output(req, { ...reply, killed: false });
    // Interleave another command's lines, as a shared ring does.
    const mixed: FleetEvent[] = [];
    body.forEach((ev, i) => {
      mixed.push(ev);
      if (this.noise.length > 0) mixed.push(this.line(this.noise[i % this.noise.length]));
    });
    for (let i = 0; i < mixed.length; i += this.frameSize) {
      if (signal.aborted) return;
      const events = mixed.slice(i, i + this.frameSize);
      yield { events, cursor: events[events.length - 1].seq, terminal: false };
    }
    let killed = reply.killed ?? false;
    let exitCode = reply.exitCode;
    if (reply.hold) await Promise.race([
      reply.hold.catch(() => {
        if (req.env?.TALYN_LOG_OFFSET !== undefined) exitCode = 125;
        else killed = true;
      }),
      new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
    ]);
    if (signal.aborted) return;
    const { trailer } = this.output(req, { ...reply, stdout: [], stderr: '', killed, exitCode });
    yield { events: trailer, cursor: this.seq, terminal: true };
  }

  async getEvents(_id: string, after: number) {
    return { events: [] as FleetEvent[], cursor: after, terminal: false };
  }

  async setSandboxCredentials(id: string, creds: Record<string, unknown>) {
    this.credentialPushes.push({ id, creds });
  }

  async resumeSandbox(_id: string) {
    this.resumes++;
    await this.resumeGate;
    this.hibernated = false;
  }

  async deleteSandbox(id: string) {
    this.deleted.push(id);
  }

  async getSandbox(id: string) {
    return { sandbox: { id, status: 'idle' }, terminal: false };
  }

  async getDiff() {
    return { supported: false };
  }

  async listFiles() {
    return { supported: false };
  }

  async readFile() {
    return { supported: false };
  }
}

/** A Claude Code `stream-json` turn, as lines. */
export function claudeTurnLines(sessionId: string, text: string): string[] {
  return [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-sonnet-5' }),
    JSON.stringify({
      type: 'assistant',
      session_id: sessionId,
      message: { role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 10 } },
    }),
    JSON.stringify({ type: 'result', subtype: 'success', session_id: sessionId, is_error: false, result: text }),
  ];
}

/** The session-title call (`services/workbenches/title.ts`), which runs beside the first turn. */
export function isTitleScript(script: string): boolean {
  return script.includes('--no-session-persistence') || script.includes(' exec --ephemeral ');
}

/** An agent turn: the agent's CLI, but not the title call. */
export function isAgentTurn(script: string, agent: 'claude' | 'codex' = 'claude'): boolean {
  return script.startsWith(`${agent} `) && !isTitleScript(script);
}
