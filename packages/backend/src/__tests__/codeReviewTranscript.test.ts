import { describe, expect, it } from 'vitest';
import {
  buildBlocks,
  CODE_REVIEW_TRANSCRIPT_EVENT_TYPE,
  CODE_REVIEW_TRANSCRIPT_SUMMARY_MAX_CHARS,
  codeReviewFindingSummary,
  codeReviewTranscriptCounts,
  codeReviewTranscriptDetail,
  codeReviewTranscriptEvent,
  codeReviewTranscriptFindingLocation,
  codeReviewTranscriptText,
  codeReviewTranscriptTitle,
  messageTrigger,
  messageTriggerText,
  parseCodeReviewTranscriptEvent,
  sortCodeReviewTranscriptFindings,
  type AgentEvent,
  type CodeReviewTranscriptEvent,
  type CodeReviewTranscriptFinding,
} from '@talyn/shared';

/**
 * The shared helpers behind code review transcript cards. packages/shared has
 * no test runner, so they are tested here.
 */

const SHA = '0123456789abcdef0123456789abcdef01234567';
const BASE = { reviewId: 'rev-1', pullRequestId: 'pr-1', prNumber: 42, cycle: 3, headSha: SHA };

const finding = (over: Partial<CodeReviewTranscriptFinding> = {}): CodeReviewTranscriptFinding => ({
  id: 'f1',
  severity: 'major',
  title: 'Wrong default',
  summary: 'The default is 0.',
  filePath: 'src/a.ts',
  lineStart: 3,
  lineEnd: 5,
  ...over,
});

const started: CodeReviewTranscriptEvent = { ...BASE, action: 'started', fileCount: 4, reviewerCount: 2 };
const finished = (over: Partial<Extract<CodeReviewTranscriptEvent, { action: 'finished' }>> = {}): CodeReviewTranscriptEvent => ({
  ...BASE,
  action: 'finished',
  findingCount: 1,
  findings: [finding()],
  sentToAgent: false,
  ...over,
});
const failed: CodeReviewTranscriptEvent = { ...BASE, action: 'failed', message: 'No reviewer finished.' };

describe('codeReviewTranscriptEvent and parseCodeReviewTranscriptEvent', () => {
  it.each([
    { name: 'started', event: started },
    { name: 'finished', event: finished() },
    { name: 'finished, sent, no findings', event: finished({ findingCount: 0, findings: [], sentToAgent: true }) },
    { name: 'failed', event: failed },
    { name: 'no number or head', event: { ...failed, prNumber: null, headSha: null } },
  ])('round-trips a $name event', ({ event }) => {
    const stored = codeReviewTranscriptEvent(event);
    expect(stored.type).toBe(CODE_REVIEW_TRANSCRIPT_EVENT_TYPE);
    expect(parseCodeReviewTranscriptEvent(JSON.parse(JSON.stringify(stored)))).toEqual(event);
  });

  it.each([
    { name: 'another type', raw: { ...codeReviewTranscriptEvent(started), type: 'talyn_pr' } },
    { name: 'no review id', raw: { ...codeReviewTranscriptEvent(started), reviewId: undefined } },
    { name: 'an empty review id', raw: { ...codeReviewTranscriptEvent(started), reviewId: '' } },
    { name: 'no pull request id', raw: { ...codeReviewTranscriptEvent(started), pullRequestId: 7 } },
    { name: 'an unknown action', raw: { ...codeReviewTranscriptEvent(started), action: 'cancelled' } },
    { name: 'no action', raw: { type: 'talyn_code_review', reviewId: 'r', pullRequestId: 'p' } },
  ])('answers null for $name', ({ raw }) => {
    expect(parseCodeReviewTranscriptEvent(raw as Record<string, unknown>)).toBeNull();
  });

  it('fills defaults for missing and malformed fields', () => {
    const raw = {
      type: 'talyn_code_review',
      action: 'started',
      reviewId: 'r',
      pullRequestId: 'p',
      prNumber: '42',
      cycle: Number.NaN,
      headSha: '',
      fileCount: -3,
      reviewerCount: 2.7,
    };
    expect(parseCodeReviewTranscriptEvent(raw)).toEqual({
      reviewId: 'r',
      pullRequestId: 'p',
      prNumber: null,
      cycle: 0,
      headSha: null,
      action: 'started',
      fileCount: 0,
      reviewerCount: 2,
    });
  });

  it.each([
    { name: 'a bad severity', bad: { ...finding({ id: 'x' }), severity: 'critical' } },
    { name: 'no id', bad: { ...finding(), id: '' } },
    { name: 'not an object', bad: 'f2' },
    { name: 'null', bad: null },
  ])('drops a finding with $name and keeps the rest', ({ bad }) => {
    const parsed = parseCodeReviewTranscriptEvent({
      ...codeReviewTranscriptEvent(finished({ findingCount: 2 })),
      findings: [finding(), bad],
    });
    expect(parsed?.action === 'finished' && parsed.findings.map((f) => f.id)).toEqual(['f1']);
    expect(parsed?.action === 'finished' && parsed.findingCount).toBe(2);
  });

  it('cleans a finding: empty path to null, missing text to empty, lines truncated', () => {
    const parsed = parseCodeReviewTranscriptEvent({
      ...codeReviewTranscriptEvent(finished()),
      findings: [{ id: 'f1', severity: 'nit', filePath: '', lineStart: 4.9, lineEnd: 'x' }],
    });
    expect(parsed?.action === 'finished' && parsed.findings).toEqual([
      { id: 'f1', severity: 'nit', title: '', summary: '', filePath: null, lineStart: 4, lineEnd: null },
    ]);
  });

  it.each([
    { name: 'a count below the list', count: 0, findings: [finding(), finding({ id: 'f2' })], out: 2 },
    { name: 'a missing count', count: undefined, findings: [finding()], out: 1 },
    { name: 'a count above the list', count: 30, findings: [finding()], out: 30 },
    { name: 'findings that are not a list', count: 3, findings: 'nope', out: 3 },
  ])('keeps findingCount >= findings.length for $name', ({ count, findings, out }) => {
    const parsed = parseCodeReviewTranscriptEvent({
      ...codeReviewTranscriptEvent(finished()),
      findingCount: count,
      findings,
    });
    expect(parsed?.action === 'finished' && parsed.findingCount).toBe(out);
    if (parsed?.action === 'finished') expect(parsed.findingCount).toBeGreaterThanOrEqual(parsed.findings.length);
  });

  it.each([
    { value: true, out: true },
    { value: 'true', out: false },
    { value: undefined, out: false },
  ])('reads sentToAgent $value as $out', ({ value, out }) => {
    const parsed = parseCodeReviewTranscriptEvent({ ...codeReviewTranscriptEvent(finished()), sentToAgent: value });
    expect(parsed?.action === 'finished' && parsed.sentToAgent).toBe(out);
  });

  it('reads a failed event with no message as empty', () => {
    const parsed = parseCodeReviewTranscriptEvent({ ...codeReviewTranscriptEvent(failed), message: 5 });
    expect(parsed).toMatchObject({ action: 'failed', message: '' });
  });
});

describe('text helpers', () => {
  it.each([
    { event: started, title: 'Code review started', detail: '4 changed files · 2 reviewers at 0123456' },
    {
      event: { ...started, fileCount: 1, reviewerCount: 1, headSha: null },
      title: 'Code review started',
      detail: '1 changed file · 1 reviewer',
    },
    { event: { ...started, fileCount: 0, reviewerCount: 3 }, title: 'Code review started', detail: '3 reviewers at 0123456' },
    {
      event: { ...started, fileCount: 0, reviewerCount: 0 },
      title: 'Code review started',
      detail: 'Reviewing the pull request at 0123456',
    },
    {
      event: finished({ findingCount: 0, findings: [] }),
      title: 'Code review finished with no findings',
      detail: 'Reviewed at 0123456.',
    },
    { event: finished(), title: 'Code review finished with 1 finding', detail: 'Reviewed at 0123456.' },
    {
      event: finished({ findingCount: 25, sentToAgent: true, headSha: null }),
      title: 'Code review finished with 25 findings',
      detail: 'Reviewed. Talyn sent the findings to the agent.',
    },
    { event: failed, title: 'Code review failed', detail: 'No reviewer finished.' },
    { event: { ...failed, message: '' }, title: 'Code review failed', detail: 'The review stopped with an error.' },
  ])('$title / $detail', ({ event, title, detail }) => {
    const e = event as CodeReviewTranscriptEvent;
    expect(codeReviewTranscriptTitle(e)).toBe(title);
    expect(codeReviewTranscriptDetail(e)).toBe(detail);
    expect(codeReviewTranscriptText(e)).toBe(`${title}. ${detail}`);
  });

  it.each([
    { body: 'One sentence. Two sentences.', max: undefined, out: 'One sentence.' },
    { body: '  spread\n\nover   lines  ', max: undefined, out: 'spread over lines' },
    { body: 'Why? Because.', max: undefined, out: 'Why?' },
    { body: 'a.b is fine here. Next.', max: undefined, out: 'a.b is fine here.' },
    { body: '', max: undefined, out: '' },
    {
      body: 'x'.repeat(400),
      max: undefined,
      out: `${'x'.repeat(CODE_REVIEW_TRANSCRIPT_SUMMARY_MAX_CHARS - 1)}…`,
    },
    { body: 'x'.repeat(300), max: 200, out: `${'x'.repeat(199)}…` },
    { body: `${'x'.repeat(8)}   ${'y'.repeat(8)}`, max: 10, out: `${'x'.repeat(8)}…` },
    { body: 'x'.repeat(10), max: 10, out: 'x'.repeat(10) },
  ])('summarises "$body" with max $max', ({ body, max, out }) => {
    expect(codeReviewFindingSummary(body, max)).toBe(out);
  });

  it.each([
    { f: { filePath: null, lineStart: 3, lineEnd: 4 }, out: null },
    { f: { filePath: 'a.ts', lineStart: null, lineEnd: null }, out: 'a.ts' },
    { f: { filePath: 'a.ts', lineStart: 3, lineEnd: null }, out: 'a.ts:3' },
    { f: { filePath: 'a.ts', lineStart: 3, lineEnd: 3 }, out: 'a.ts:3' },
    { f: { filePath: 'a.ts', lineStart: 3, lineEnd: 5 }, out: 'a.ts:3-5' },
  ])('writes the location of $f as $out', ({ f, out }) => {
    expect(codeReviewTranscriptFindingLocation(f)).toBe(out);
  });
});

describe('sortCodeReviewTranscriptFindings and codeReviewTranscriptCounts', () => {
  const list = [
    finding({ id: 'n1', severity: 'nit' }),
    finding({ id: 'm1', severity: 'major' }),
    finding({ id: 'b1', severity: 'blocker' }),
    finding({ id: 'mi1', severity: 'minor' }),
    finding({ id: 'm2', severity: 'major' }),
    finding({ id: 'b2', severity: 'blocker' }),
  ];

  it('puts the most serious first and keeps the order within a severity', () => {
    expect(sortCodeReviewTranscriptFindings(list).map((f) => f.id)).toEqual(['b1', 'b2', 'm1', 'm2', 'mi1', 'n1']);
  });

  it('does not change the input', () => {
    const copy = [...list];
    sortCodeReviewTranscriptFindings(list);
    expect(list).toEqual(copy);
  });

  it.each([
    { name: 'no findings', findings: [], out: { blocker: 0, major: 0, minor: 0, nit: 0 } },
    { name: 'a mix', findings: list, out: { blocker: 2, major: 2, minor: 1, nit: 1 } },
    { name: 'one severity', findings: [finding(), finding({ id: 'f2' })], out: { blocker: 0, major: 2, minor: 0, nit: 0 } },
  ])('counts $name', ({ findings, out }) => {
    expect(codeReviewTranscriptCounts(findings)).toEqual(out);
  });
});

describe('buildBlocks with a code review event', () => {
  const at = (seq: number, event: Record<string, unknown>) => ({ seq, ...event }) as unknown as AgentEvent;

  it.each([
    { event: started, isError: false },
    { event: finished({ sentToAgent: true }), isError: false },
    { event: failed, isError: true },
  ])('draws a $event.action event as a system card', ({ event, isError }) => {
    const blocks = buildBlocks([at(7, codeReviewTranscriptEvent(event))]);
    expect(blocks).toEqual([
      {
        kind: 'system',
        key: '7',
        subtype: 'talyn_code_review',
        text: codeReviewTranscriptText(event),
        codeReview: event,
        ...(isError ? { isError: true } : {}),
      },
    ]);
  });

  it.each([
    { name: 'no review id', raw: { type: 'talyn_code_review', action: 'started', pullRequestId: 'p' } },
    { name: 'an unknown action', raw: { ...codeReviewTranscriptEvent(started), action: 'paused' } },
  ])('drops a malformed event with $name', ({ raw }) => {
    expect(buildBlocks([at(1, raw)])).toEqual([]);
  });

  it('draws a Talyn message with the code_review trigger as a talyn_message row', () => {
    const trigger = { kind: 'code_review', reviewId: 'rev-1', findingCount: 2 };
    const blocks = buildBlocks([
      at(3, {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '[Talyn] The code review finished.' }] },
        talyn: { kind: 'user_message', origin: 'talyn', trigger },
      }),
    ]);
    expect(blocks).toEqual([
      { kind: 'system', key: '3', subtype: 'talyn_message', text: '[Talyn] The code review finished.', trigger },
    ]);
  });
});

describe('the code_review message trigger', () => {
  it.each([
    { name: 'a code_review trigger', talyn: { trigger: { kind: 'code_review', reviewId: 'r', findingCount: 3 } }, ok: true },
    { name: 'a pr_retry trigger', talyn: { trigger: { kind: 'pr_retry', attempt: 1, error: 'x' } }, ok: true },
    { name: 'an unknown kind', talyn: { trigger: { kind: 'code_reviewed' } }, ok: false },
    { name: 'no trigger', talyn: { origin: 'talyn' }, ok: false },
    { name: 'a string trigger', talyn: { trigger: 'code_review' }, ok: false },
    { name: 'no talyn block', talyn: null, ok: false },
  ])('messageTrigger reads $name', ({ talyn, ok }) => {
    expect(messageTrigger(talyn)).toEqual(ok ? talyn!.trigger : null);
  });

  it.each([
    { findingCount: 0, text: 'Talyn sent 0 code review findings to the agent to check.' },
    { findingCount: 1, text: 'Talyn sent 1 code review finding to the agent to check.' },
    { findingCount: 12, text: 'Talyn sent 12 code review findings to the agent to check.' },
  ])('messageTriggerText for $findingCount findings', ({ findingCount, text }) => {
    expect(messageTriggerText({ kind: 'code_review', reviewId: 'r', findingCount })).toBe(text);
  });
});
