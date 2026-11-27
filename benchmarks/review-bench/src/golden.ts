import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { filesWorthReviewing, isCodeReviewPreset, type CodeReviewPreset } from '@talyn/shared';
import type { ReviewPromptContext } from '../../../packages/backend/src/services/codeReview/lenses.js';
import { review, type AgentRunner, type Candidate, type Settings } from './main.js';

/**
 * A golden-case eval with Claude Code.
 *
 * ReviewBench scores against a fixed public corpus with Codex. This runner
 * reviews one real pull request whose true problems are known, with the agent
 * that production review units use most, and scores recall per golden issue.
 * It runs the same prompts and the same lens, sweep and judge sequence as
 * `review()` in main.ts.
 */

export interface GoldenIssue {
  id: string;
  severity: 'high' | 'medium' | 'low';
  file: string;
  summary: string;
}

export interface GoldenCase {
  repo: string;
  pr: number;
  head: string;
  base: string;
  issues: GoldenIssue[];
}

interface Args {
  caseFile: string;
  repoDir: string;
  filesJson: string;
  prJson: string;
  out: string;
  preset: CodeReviewPreset;
  model: string;
  judgeModel: string;
  scoreModel: string;
  concurrency: number;
  unitTimeoutSec: number;
  scoreOnly: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string, fallback?: string) => {
    const i = argv.indexOf(`--${name}`);
    const value = i >= 0 ? argv[i + 1] : fallback;
    if (value === undefined) throw new Error(`Missing --${name}.`);
    return value;
  };
  const preset = get('preset', 'standard');
  if (!isCodeReviewPreset(preset)) throw new Error(`Invalid preset: ${preset}`);
  const model = get('model', 'claude-opus-5-5');
  return {
    caseFile: resolve(get('case')),
    repoDir: resolve(get('repo')),
    filesJson: resolve(get('files')),
    prJson: resolve(get('pr')),
    out: resolve(get('out')),
    preset,
    model,
    judgeModel: get('judge-model', model),
    scoreModel: get('score-model', 'claude-sonnet-5-5'),
    concurrency: Number(get('concurrency', '4')),
    unitTimeoutSec: Number(get('unit-timeout', '1500')),
    scoreOnly: argv.includes('--score-only'),
  };
}

/**
 * Runs `claude -p` in the checkout with read-only tools.
 *
 * HOME points at an empty directory so the operator's own CLAUDE.md and
 * settings do not reach the reviewer. The fleet units do not carry them either.
 */
export function claudeRunner(repoDir: string, debugDir: string, timeoutSec: number, home: string): AgentRunner {
  return async (unit) => {
    await mkdir(debugDir, { recursive: true });
    const started = Date.now();
    const raw = await new Promise<string>((resolveRun, reject) => {
      const child = spawn(
        'claude',
        [
          '-p', '--model', unit.model, '--output-format', 'stream-json', '--verbose',
          '--permission-mode', 'bypassPermissions',
          '--disallowedTools', 'Edit,Write,NotebookEdit,WebFetch,WebSearch,Agent,Task',
        ],
        { cwd: repoDir, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HOME: home } }
      );
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
      }, timeoutSec * 1000);
      child.stdout.setEncoding('utf8').on('data', (c: string) => { stdout += c; });
      child.stderr.setEncoding('utf8').on('data', (c: string) => { stderr += c; });
      child.once('error', (e) => { clearTimeout(timer); reject(e); });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 && !stdout) reject(new Error(`claude exited ${code}: ${stderr.slice(-500)}`));
        else resolveRun(stdout);
      });
      child.stdin.end(unit.prompt);
    });
    let result = '';
    let meta: Record<string, unknown> = {};
    // One line per tool call, so a run shows what the reviewer actually read.
    const tools: string[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let event: {
        type?: string;
        result?: string;
        total_cost_usd?: number;
        num_turns?: number;
        is_error?: boolean;
        message?: { content?: { type?: string; name?: string; input?: Record<string, unknown> }[] };
      };
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'result') {
        result = event.result ?? '';
        meta = { cost: event.total_cost_usd, turns: event.num_turns, error: event.is_error };
      }
      for (const block of event.message?.content ?? []) {
        if (block.type !== 'tool_use') continue;
        const input = block.input ?? {};
        const arg = input.file_path ?? input.command ?? input.pattern ?? JSON.stringify(input);
        tools.push(`${block.name}: ${String(arg).replace(/\s+/g, ' ').slice(0, 200)}`);
      }
    }
    await writeFile(join(debugDir, `${unit.name}.tools.txt`), tools.join('\n'));
    meta.seconds = Math.round((Date.now() - started) / 1000);
    await writeFile(join(debugDir, `${unit.name}.prompt.md`), unit.prompt);
    await writeFile(join(debugDir, `${unit.name}.out.md`), `${JSON.stringify(meta)}\n\n${result}`);
    console.log(`${unit.name} done ${JSON.stringify(meta)}`);
    return result;
  };
}

function scorePrompt(golden: GoldenCase, findings: Candidate[]): string {
  return [
    'You score a code review against a list of known real problems (the golden list).',
    'For each golden issue, decide which review findings describe the SAME concrete problem:',
    'the same defect or root cause in the same code. A finding that only touches the same',
    'function but names a different defect does not match. A finding may match at most one',
    'golden issue; choose the closest.',
    'For each finding that matches no golden issue, classify it as "real" (a concrete, likely',
    'correct problem a careful engineer would fix), "doubtful", or "wrong". Use only the text;',
    'do not read files.',
    '',
    '## Golden issues',
    ...golden.issues.map((g) => `- ${g.id} [${g.severity}] ${g.file}: ${g.summary}`),
    '',
    '## Review findings',
    ...findings.map((f, i) => `- F${i + 1} [${f.severity}] ${f.file}:${f.lineStart ?? '?'} ${f.title}\n  ${f.body.replace(/\s+/g, ' ').slice(0, 900)}`),
    '',
    'Reply with only one JSON object, no fences:',
    '{"matches":{"G1":["F3"],"G2":[]},"extras":{"F5":"real","F6":"wrong"}}',
  ].join('\n');
}

export interface Score {
  recall: number;
  highRecall: number;
  /** Recall over the findings a person sees at the default bar (minor and up). */
  visibleRecall: number;
  /** Findings at minor and up that the scorer called wrong. */
  visibleWrong: number;
  matched: string[];
  missed: string[];
  findings: number;
  extras: Record<string, string>;
}

export function summarise(golden: GoldenCase, reply: string, findings: Pick<Candidate, 'severity'>[]): Score {
  const findingCount = findings.length;
  const visible = (ref: string) => {
    const f = findings[Number(ref.replace(/^F/, '')) - 1];
    return !!f && f.severity !== 'nit';
  };
  const json = reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1);
  const parsed = JSON.parse(json) as { matches: Record<string, string[]>; extras?: Record<string, string> };
  const matched = golden.issues.filter((g) => (parsed.matches[g.id] ?? []).length > 0).map((g) => g.id);
  const high = golden.issues.filter((g) => g.severity === 'high');
  const visibleMatched = golden.issues.filter((g) => (parsed.matches[g.id] ?? []).some(visible));
  return {
    visibleRecall: visibleMatched.length / golden.issues.length,
    visibleWrong: Object.entries(parsed.extras ?? {}).filter(([ref, v]) => v === 'wrong' && visible(ref)).length,
    recall: matched.length / golden.issues.length,
    highRecall: high.filter((g) => matched.includes(g.id)).length / Math.max(1, high.length),
    matched,
    missed: golden.issues.map((g) => g.id).filter((id) => !matched.includes(id)),
    findings: findingCount,
    extras: parsed.extras ?? {},
  };
}

async function score(args: Args, golden: GoldenCase, label: string, findings: Candidate[], home: string): Promise<Score> {
  const runner = claudeRunner(args.out, join(args.out, 'units'), 600, home);
  const reply = await runner({ name: `score-${label}`, kind: 'judge', lens: '', model: args.scoreModel, prompt: scorePrompt(golden, findings) });
  const result = summarise(golden, reply, findings);
  await writeFile(join(args.out, `score-${label}.json`), JSON.stringify(result, null, 2));
  const real = Object.values(result.extras).filter((v) => v === 'real').length;
  const wrong = Object.values(result.extras).filter((v) => v === 'wrong').length;
  console.log(
    `[${label}] findings=${findings.length} recall=${(result.recall * 100).toFixed(0)}% ` +
      `high=${(result.highRecall * 100).toFixed(0)}% visible=${(result.visibleRecall * 100).toFixed(0)}% ` +
      `visible-wrong=${result.visibleWrong} extras real=${real} wrong=${wrong} missed=${result.missed.join(',')}`
  );
  return result;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const golden = JSON.parse(await readFile(args.caseFile, 'utf8')) as GoldenCase;
  const home = join(args.out, '.home');
  await mkdir(home, { recursive: true });

  if (!args.scoreOnly) {
    const pr = JSON.parse(await readFile(args.prJson, 'utf8')) as { title: string; body: string; head: string; base: string };
    const files = JSON.parse(await readFile(args.filesJson, 'utf8')) as ReviewPromptContext['files'];
    const ctx: ReviewPromptContext = {
      ref: `${golden.repo}#${golden.pr}`,
      title: pr.title,
      body: pr.body ?? '',
      headBranch: pr.head,
      baseBranch: pr.base,
      files: filesWorthReviewing(files),
      chunkIndex: 1,
      chunkTotal: 1,
    };
    const settings: Settings = {
      preset: args.preset,
      model: args.model,
      judgeModel: args.judgeModel,
      concurrency: args.concurrency,
      unitTimeoutSec: args.unitTimeoutSec,
    };
    let unjudged: Candidate[] = [];
    const final = await review(ctx, settings, claudeRunner(args.repoDir, join(args.out, 'units'), args.unitTimeoutSec, home), console.log, {
      onUnjudged: (c) => { unjudged = c; },
      baseSha: golden.base,
    });
    await writeFile(join(args.out, 'unjudged.json'), JSON.stringify(unjudged, null, 2));
    await writeFile(join(args.out, 'final.json'), JSON.stringify(final, null, 2));
  }

  const unjudged = JSON.parse(await readFile(join(args.out, 'unjudged.json'), 'utf8')) as Candidate[];
  const final = JSON.parse(await readFile(join(args.out, 'final.json'), 'utf8')) as Candidate[];
  await score(args, golden, 'unjudged', unjudged, home);
  await score(args, golden, 'final', final, home);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
