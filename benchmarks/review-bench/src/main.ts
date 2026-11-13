import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CODE_REVIEW_PRESET_PLAN,
  CODE_REVIEW_SEVERITY_ORDER,
  isCodeReviewPreset,
  parseCodeReviewFindings,
  type CodeReviewPreset,
  type ParsedCodeReviewFindings,
  type RawCodeReviewFinding,
} from '@talyn/shared';
import {
  buildJudgePrompt,
  buildLensPrompt,
  buildSweepPrompt,
  lensByKey,
  lensesForPreset,
  type ReviewPromptContext,
} from '../../../packages/backend/src/services/codeReview/lenses.js';
import {
  anchorVerifier,
  filesForChunk,
  keyFor,
  matchJudgeKeep,
} from '../../../packages/backend/src/services/codeReview/unitPure.js';

type ReviewFile = ReviewPromptContext['files'][number];

function gitPath(value: string): string {
  if (!value.startsWith('"')) return value.replace(/\t.*$/, '');
  const bytes: number[] = [];
  const escapes: Record<string, string> = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r' };
  for (let i = 1; i < value.length && value[i] !== '"'; i++) {
    if (value[i] === '\\') {
      const octal = value.slice(i + 1).match(/^[0-7]{1,3}/)?.[0];
      if (octal) {
        bytes.push(parseInt(octal, 8));
        i += octal.length;
      } else {
        const escaped = value[++i]!;
        bytes.push(...Buffer.from(escapes[escaped] ?? escaped));
      }
    } else {
      const char = String.fromCodePoint(value.codePointAt(i)!);
      bytes.push(...Buffer.from(char));
      i += char.length - 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

export function parseDiff(diff: string): ReviewFile[] {
  const files: ReviewFile[] = [];
  let file: ReviewFile | undefined;
  let hunks: string[] = [];
  let inHunk = false;
  const finish = () => {
    if (!file) return;
    if (hunks.length) file.patch = hunks.join('\n').replace(/\n$/, '');
    files.push(file);
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      finish();
      const paths = line.match(/^diff --git ("(?:\\.|[^"])*"|a\/.*?) ("(?:\\.|[^"])*"|b\/.*)$/);
      if (!paths) throw new Error(`Cannot parse the diff header: ${line}`);
      file = { filename: gitPath(paths[2]!).slice(2), status: 'modified', additions: 0, deletions: 0 };
      hunks = [];
      inHunk = false;
    } else if (file) {
      if (line.startsWith('@@')) inHunk = true;
      if (inHunk) {
        hunks.push(line);
        if (line.startsWith('+')) file.additions++;
        if (line.startsWith('-')) file.deletions++;
      } else if (line.startsWith('new file mode ')) file.status = 'added';
      else if (line.startsWith('deleted file mode ')) file.status = 'removed';
      else if (line.startsWith('rename to ')) {
        file.status = 'renamed';
        file.filename = gitPath(line.slice(10));
      } else if (line.startsWith('--- ') && file.status === 'removed') {
        file.filename = gitPath(line.slice(4)).slice(2);
      } else if (line.startsWith('+++ ') && line !== '+++ /dev/null') {
        file.filename = gitPath(line.slice(4)).slice(2);
      }
    }
  }
  finish();
  if (diff.trim() && !files.length) throw new Error('The diff has no Git file headers.');
  return files;
}

export interface Settings {
  preset: CodeReviewPreset;
  model: string;
  judgeModel: string;
  effort?: string;
  concurrency: number;
  unitTimeoutSec: number;
}

export function readSettings(env: NodeJS.ProcessEnv): Settings {
  const preset = env.RB_CONFIG_PRESET ?? 'standard';
  if (!isCodeReviewPreset(preset)) throw new Error(`Invalid preset: ${preset}`);
  const positiveInteger = (name: string, fallback: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
    return value;
  };
  const model = env.RB_CONFIG_MODEL || 'gpt-6.1-terra';
  return {
    preset,
    model,
    judgeModel: env.RB_CONFIG_JUDGE_MODEL || model,
    effort: env.RB_CONFIG_EFFORT || undefined,
    concurrency: positiveInteger('RB_CONFIG_CONCURRENCY', 5),
    unitTimeoutSec: positiveInteger('RB_CONFIG_UNIT_TIMEOUT_SEC', 900),
  };
}

export interface Candidate extends RawCodeReviewFinding {
  dedupeKey: string;
  seenCount: number;
  lenses: string[];
}

export interface AgentUnit {
  name: string;
  kind: 'lens' | 'sweep' | 'judge';
  lens: string;
  prompt: string;
  model: string;
}

export type AgentRunner = (unit: AgentUnit) => Promise<string>;
export class UnitEnvironmentError extends Error {}

export function assertUnitEnvironment(events: string, diagnostics: string): void {
  const commands: { exit_code?: number; aggregated_output?: string }[] = [];
  for (const line of events.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'item.completed' && event.item?.type === 'command_execution') {
      commands.push(event.item);
    }
  }
  const output = [diagnostics, ...commands.map((command) => command.aggregated_output ?? '')].join('\n');
  const blocked = output.match(/(?:^|\n)\s*(?:bwrap:[^\n]*|(?:bash|sh|\/bin\/\w+):[^\n]*Permission denied|sandbox[^\n]*(?:not permitted|denied|failed))/i);
  if (blocked) throw new UnitEnvironmentError(`Shell environment failed: ${blocked[0].trim()}`);
  if (commands.length && commands.every((command) => command.exit_code !== 0)) {
    throw new UnitEnvironmentError(`Every shell command failed (${commands.length} commands). Inspect the unit record.`);
  }
}

type Log = (message: string) => void;
const rank = (finding: RawCodeReviewFinding) => CODE_REVIEW_SEVERITY_ORDER.indexOf(finding.severity);

export function mergeFindings(
  stored: Map<string, Candidate>,
  findings: RawCodeReviewFinding[],
  lens: string,
  verified: (finding: RawCodeReviewFinding) => boolean,
): void {
  for (const finding of findings) {
    const dedupeKey = keyFor(finding, verified(finding));
    const previous = stored.get(dedupeKey);
    if (!previous) {
      stored.set(dedupeKey, { ...finding, dedupeKey, seenCount: 1, lenses: [lens] });
    } else {
      stored.set(dedupeKey, {
        ...previous,
        severity: rank(previous) <= rank(finding) ? previous.severity : finding.severity,
        lineStart: finding.lineStart,
        lineEnd: finding.lineEnd,
        body: finding.body,
        suggestion: finding.suggestion,
        confidence: finding.confidence,
        seenCount: previous.seenCount + 1,
        lenses: [...new Set([...previous.lenses, lens])],
      });
    }
  }
}

export function applyJudge(
  candidates: Candidate[],
  result: ParsedCodeReviewFindings,
  verified: (finding: RawCodeReviewFinding) => boolean,
  log: Log = console.log,
): Candidate[] {
  if (!result.ok) {
    log(`Judge failed. Keeping the unjudged findings: ${result.error}`);
    return candidates;
  }
  const keys = new Set(candidates.map((candidate) => candidate.dedupeKey));
  const keeps = new Map<string, RawCodeReviewFinding>();
  let unmatched = 0;
  for (const finding of result.findings) {
    const key = matchJudgeKeep(finding, keys, verified(finding));
    if (key) keeps.set(key, finding);
    else unmatched++;
  }
  const drops = new Set(result.dropped.map((drop) => drop.id));
  if (unmatched) log(`The judge returned ${unmatched} unmatched keeps. Applying only named drops.`);
  return candidates.flatMap((candidate) => {
    const keep = keeps.get(candidate.dedupeKey);
    if (keep) return [{ ...candidate, severity: keep.severity, body: keep.body }];
    return unmatched && !drops.has(candidate.dedupeKey) ? [candidate] : [];
  });
}

async function parallel<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await run(items[next++]!);
  }));
}

export async function review(
  ctx: ReviewPromptContext,
  settings: Settings,
  runner: AgentRunner,
  log: Log = console.log,
): Promise<Candidate[]> {
  const plan = CODE_REVIEW_PRESET_PLAN[settings.preset];
  const lensKeys = lensesForPreset(settings.preset);
  const chunkTotal = plan.chunk ? Math.max(1, Math.ceil(ctx.files.length / 25)) : 1;
  const scoped = (index: number): ReviewPromptContext => ({
    ...ctx, files: filesForChunk(ctx.files, index, chunkTotal), chunkIndex: index + 1, chunkTotal,
  });
  const verified = anchorVerifier(ctx.files);
  const stored = new Map<string, Candidate>();
  const candidates = () => [...stored.values()].sort((a, b) => rank(a) - rank(b));
  const execute = async (unit: AgentUnit): Promise<ParsedCodeReviewFindings> => {
    try {
      const parsed = parseCodeReviewFindings(await runner(unit));
      if (!parsed.ok) log(`${unit.name} failed: ${parsed.error}`);
      return parsed;
    } catch (error) {
      if (error instanceof UnitEnvironmentError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      log(`${unit.name} failed: ${message}`);
      return { ok: false, error: message };
    }
  };
  const units: AgentUnit[] = [];
  for (let chunk = 0; chunk < chunkTotal; chunk++) {
    for (const lens of lensKeys) {
      units.push({
        name: `lens-${lens}-${chunk + 1}`, kind: 'lens', lens, model: settings.model,
        prompt: buildLensPrompt(lensByKey(lens)!, scoped(chunk)),
      });
    }
  }
  let succeeded = 0;
  await parallel(units, settings.concurrency, async (unit) => {
    const parsed = await execute(unit);
    if (parsed.ok) {
      succeeded++;
      mergeFindings(stored, parsed.findings, unit.lens, verified);
    }
  });
  if (!succeeded) throw new Error('Every lens unit failed. Retry this pull request.');

  if (plan.sweep) {
    const covered = candidates().map((finding) => ({
      severity: finding.severity, filePath: finding.file, title: finding.title,
    }));
    const sweeps: AgentUnit[] = Array.from({ length: chunkTotal }, (_, chunk) => ({
      name: `sweep-${chunk + 1}`, kind: 'sweep', lens: 'sweep', model: settings.model,
      prompt: buildSweepPrompt(scoped(chunk), covered, lensKeys),
    }));
    await parallel(sweeps, settings.concurrency, async (unit) => {
      const parsed = await execute(unit);
      if (parsed.ok) mergeFindings(stored, parsed.findings, 'sweep', verified);
    });
  }
  const unjudged = candidates();
  if (!plan.validate || !unjudged.length) return unjudged;
  const parsed = await execute({
    name: 'judge', kind: 'judge', lens: '', model: settings.judgeModel,
    prompt: buildJudgePrompt(scoped(0), unjudged.map((finding) => ({
      id: finding.dedupeKey,
      severity: finding.severity,
      filePath: finding.file,
      lines: finding.lineStart ? `${finding.lineStart}${finding.lineEnd ? `-${finding.lineEnd}` : ''}` : '?',
      title: finding.title,
      body: finding.body,
      raisedBy: finding.lenses,
    }))),
  });
  return applyJudge(unjudged, parsed, verified, log);
}

export function codexRunner(settings: Settings, repoDir = '/work/repo', debugDir = '/work/out/units'): AgentRunner {
  return async (unit) => {
    await mkdir(debugDir, { recursive: true });
    const temporary = await mkdtemp(join(tmpdir(), 'talyn-review-'));
    const output = join(temporary, 'last-message.txt');
    let stderr = '';
    let events = '';
    let finalText = '';
    let failure: unknown;
    try {
      await new Promise<void>((resolveRun, reject) => {
        const args = [
          // The ReviewBench container is the isolation boundary. Codex's own Linux
          // sandbox needs user namespaces, which Docker refuses, so every shell
          // command failed and the agent reviewed blind from the diff alone.
          'exec', '--model', unit.model, '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check',
          '--color', 'never', '--json', '-o', output,
          '-c', 'approval_policy="never"', '-c', 'features.apps=false',
          '-c', 'web_search="disabled"', '-c', 'tools.web_search=false',
        ];
        if (settings.effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(settings.effort)}`);
        const child = spawn('codex', args, {
          cwd: repoDir, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            ...(process.env.RB_MODEL_BASE_URL ? { OPENAI_BASE_URL: process.env.RB_MODEL_BASE_URL } : {}),
          },
        });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          if (child.pid) {
            try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
          }
        }, Math.min(settings.unitTimeoutSec * 1000, 2_147_483_647));
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => { stderr += chunk; });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => { events += chunk; });
        child.stdin.on('error', (error) => { stderr += `\n${error.message}`; });
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('close', (code, signal) => {
          clearTimeout(timer);
          if (timedOut) reject(new Error(`Unit timed out after ${settings.unitTimeoutSec} seconds.`));
          else if (code !== 0) reject(new Error(`Codex exited with code ${code}, signal ${signal}.`));
          else resolveRun();
        });
        child.stdin.end(unit.prompt);
      });
    } catch (error) {
      failure = error;
    } finally {
      finalText = await readFile(output, 'utf8').catch(() => '');
      try {
        assertUnitEnvironment(events, `${stderr}\n${finalText}`);
      } catch (error) {
        failure = error;
      }
      try {
        await writeFile(join(debugDir, `${unit.name}.txt`),
          `${finalText}\n\n--- command events ---\n${events}\n--- stderr ---\n${stderr}\n${failure ? String(failure) : ''}\n`);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
    if (failure) throw failure;
    return finalText;
  };
}

export interface ContractFinding {
  file: string;
  start_line: number;
  end_line: number;
  message: string;
  producer: string;
}

function relativePath(file: string): string | null {
  const normalized = file.trim().replace(/\\/g, '/').replace(/^(?:\.\/|\/)+/, '');
  if (!normalized || normalized.includes('\0') || /^[A-Za-z]:/.test(normalized)) return null;
  if (normalized.split('/').some((part) => !part || part === '..' || part === '.')) return null;
  return normalized;
}

export function mapFinding(finding: RawCodeReviewFinding, agent: string, headText?: string): ContractFinding | null {
  const file = relativePath(finding.file);
  if (!file) return null;
  const validLine = (line: number | null): line is number => Number.isSafeInteger(line) && (line ?? 0) > 0;
  let anchorStart = 1;
  let anchorEnd = 1;
  if (headText && finding.anchor.trim()) {
    const pattern = finding.anchor.trim().split(/\s+/).map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    const match = new RegExp(pattern).exec(headText);
    if (match) {
      anchorStart = headText.slice(0, match.index).split('\n').length;
      anchorEnd = anchorStart + match[0].split('\n').length - 1;
    }
  }
  const start = validLine(finding.lineStart) ? finding.lineStart : anchorStart;
  const end = validLine(finding.lineEnd) ? Math.max(start, finding.lineEnd)
    : validLine(finding.lineStart) ? start : anchorEnd;
  const message = `[${finding.severity}] ${finding.title} — ${finding.body}`
    + (finding.suggestion ? `\nSuggested fix: ${finding.suggestion}` : '');
  return { file, start_line: start, end_line: end, message: message.trim().slice(0, 12_000), producer: agent };
}

interface Identity {
  repo: string;
  pr_number: number;
  base: string;
  head: string;
}

export interface ContractOutput {
  pr: Identity;
  agent: string;
  findings: ContractFinding[];
}

export function validateOutput(output: ContractOutput, expected: Identity, agent: string): void {
  if (JSON.stringify(output.pr) !== JSON.stringify(expected)
    || !/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(output.pr.repo)
    || !Number.isSafeInteger(output.pr.pr_number) || output.pr.pr_number < 1
    || !/^[a-f\d]{40}$/i.test(output.pr.head) || !/^[a-f\d]{40}$/i.test(output.pr.base)
    || !agent || output.agent !== agent || !Array.isArray(output.findings) || output.findings.length > 50) {
    throw new Error('The review output has an invalid identity or findings list.');
  }
  for (const finding of output.findings) {
    if (relativePath(finding.file) !== finding.file || !finding.message.trim()
      || finding.producer !== agent || !Number.isSafeInteger(finding.start_line) || finding.start_line < 1
      || !Number.isSafeInteger(finding.end_line) || finding.end_line < finding.start_line) {
      throw new Error('The review output has an invalid finding.');
    }
  }
}

export async function main(): Promise<void> {
  const env = process.env;
  const required = (name: string) => {
    if (!env[name]) throw new Error(`Missing ${name}.`);
    return env[name]!;
  };
  const settings = readSettings(env);
  console.log(`preset=${settings.preset} model=${settings.model} judge_model=${settings.judgeModel}`
    + ` effort=${settings.effort ?? 'default'} concurrency=${settings.concurrency} unit_timeout_sec=${settings.unitTimeoutSec}`);
  const nwo = required('RB_NWO');
  const agent = required('RB_AGENT');
  const out = required('RB_OUT');
  const pr = JSON.parse(await readFile(env.RB_PR_JSON || '/work/pr/pr.json', 'utf8')) as Record<string, unknown>;
  const identity: Identity = {
    repo: `https://github.com/${nwo}`, pr_number: Number(required('RB_PR_NUMBER')),
    base: required('RB_BASE'), head: required('RB_HEAD'),
  };
  validateOutput({ pr: identity, agent, findings: [] }, identity, agent);
  if (pr.repo !== identity.repo || pr.pr_number !== identity.pr_number
    || pr.base !== identity.base || pr.head !== identity.head || pr.nwo !== nwo) {
    throw new Error('PR metadata does not match the ReviewBench environment.');
  }
  const ctx: ReviewPromptContext = {
    ref: `${nwo}#${identity.pr_number}`, title: typeof pr.title === 'string' ? pr.title : '',
    body: typeof pr.body === 'string' ? pr.body : '', headBranch: `pr-${identity.pr_number}`, baseBranch: 'base',
    files: parseDiff(await readFile(env.RB_DIFF || '/work/pr/diff.patch', 'utf8')), chunkIndex: 1, chunkTotal: 1,
  };
  const findings = await review(ctx, settings, codexRunner(settings));
  const mapped: ContractFinding[] = [];
  const repoRoot = await realpath('/work/repo');
  for (const finding of findings.sort((a, b) => rank(a) - rank(b))) {
    const file = relativePath(finding.file);
    if (!file) { console.log(`Skipping a finding with an invalid path: ${finding.file}`); continue; }
    let headText: string | undefined;
    if (!finding.lineStart || !finding.lineEnd) {
      const fullPath = await realpath(resolve(repoRoot, file)).catch(() => '');
      if (fullPath.startsWith(repoRoot + sep)) headText = await readFile(fullPath, 'utf8').catch(() => undefined);
    }
    const mappedFinding = mapFinding(finding, agent, headText);
    if (mappedFinding) mapped.push(mappedFinding);
    if (mapped.length === 50) break;
  }
  const output: ContractOutput = { pr: identity, agent, findings: mapped };
  validateOutput(output, identity, agent);
  await mkdir(dirname(out), { recursive: true });
  const temporary = `${out}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(output) + '\n');
    await rename(temporary, out);
  } finally {
    await rm(temporary, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
