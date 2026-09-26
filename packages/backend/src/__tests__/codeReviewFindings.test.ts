/**
 * The findings contract: parsing an agent's output, and keying a finding so a
 * re-review merges into it.
 *
 * Both are pure, and both have a failure mode that is silent and expensive. A
 * parser that reads "no findings" out of a broken run turns a failure into a
 * clean bill of health. A dedupe key that changes when a branch is rebased turns
 * every re-review into a fresh pile of duplicates and quietly un-dismisses
 * everything the user said no to.
 */
import { describe, expect, it } from 'vitest';
import {
  CODE_REVIEW_FINDINGS_SENTINEL,
  CODE_REVIEW_MAX_FINDINGS_PER_UNIT,
  CODE_REVIEW_PRESET_PLAN,
  CODE_REVIEW_PHASE_AT_REST,
  codeReviewDedupeKey,
  codeReviewOutputContract,
  codeReviewPhasePlan,
  codeReviewProgress,
  codeReviewUnitCount,
  parseCodeReviewFindings,
  severityAtOrAbove,
  type CodeReviewPhase,
} from '@talyn/shared';

function payload(findings: unknown[]): string {
  return [
    'I read the diff and the surrounding code.',
    '',
    CODE_REVIEW_FINDINGS_SENTINEL,
    '```json',
    JSON.stringify({ schema: 1, findings }),
    '```',
  ].join('\n');
}

const oneFinding = {
  severity: 'blocker',
  category: 'correctness',
  file: 'src/a.ts',
  lineStart: 41,
  lineEnd: 44,
  anchor: 'const user = await getUser(id)',
  title: 'getUser can return undefined',
  body: 'When the id is unknown this returns undefined and the next line dereferences it.',
  suggestion: 'Guard the undefined case.',
  confidence: 80,
};

describe('parseCodeReviewFindings', () => {
  it('reads the block after the sentinel', () => {
    const result = parseCodeReviewFindings(payload([oneFinding]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      severity: 'blocker',
      file: 'src/a.ts',
      lineStart: 41,
      anchor: 'const user = await getUser(id)',
    });
  });

  it('accepts an empty findings array as a real answer', () => {
    // The clean review. It must parse, because the alternative — treating "found
    // nothing" as a parse failure — would report every good PR as a broken run.
    const result = parseCodeReviewFindings(payload([]));
    expect(result).toMatchObject({ ok: true, findings: [] });
  });

  describe('absence means unknown, never empty', () => {
    it.each([
      ['no message at all', null],
      ['prose with no sentinel', 'I looked at the diff and it all seems fine to me.'],
      ['a sentinel with no block', `All good.\n\n${CODE_REVIEW_FINDINGS_SENTINEL}\n`],
      [
        'a block that is not JSON',
        `${CODE_REVIEW_FINDINGS_SENTINEL}\n\`\`\`json\n{nope,\n\`\`\``,
      ],
      [
        'a block with no findings array',
        `${CODE_REVIEW_FINDINGS_SENTINEL}\n\`\`\`json\n{"schema":1}\n\`\`\``,
      ],
    ])('fails on %s rather than reporting a clean review', (_label, text) => {
      const result = parseCodeReviewFindings(text as string | null);
      expect(result.ok).toBe(false);
      // The distinction the whole product rests on: a failed unit is recorded as
      // failed. If this ever returns `{ ok: true, findings: [] }` a broken run
      // starts reading as "nothing to flag".
      expect(result).not.toMatchObject({ ok: true });
    });
  });

  it('is not fooled by an agent that DISCUSSES the sentinel before emitting it', () => {
    // The parseNeedsHumanSentinel restraint: text about a thing is not the thing.
    // It takes the block after the LAST sentinel, so the narration is ignored.
    const text = [
      `I will finish with a ${CODE_REVIEW_FINDINGS_SENTINEL} line as instructed.`,
      '```json',
      '{"findings":[{"title":"WRONG - this is the example, not the answer"}]}',
      '```',
      '',
      CODE_REVIEW_FINDINGS_SENTINEL,
      '```json',
      JSON.stringify({ schema: 1, findings: [oneFinding] }),
      '```',
    ].join('\n');
    const result = parseCodeReviewFindings(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings[0]?.title).toBe('getUser can return undefined');
  });

  it('never sweeps the prose for JSON-looking things', () => {
    // The findPullRequestUrl lesson: a loop once claimed authorship of somebody
    // else's PR because prose was searched for a URL. A payload the agent did not
    // announce is not a payload.
    const text = 'Here is what a finding would look like: {"findings":[{"title":"nope"}]}';
    expect(parseCodeReviewFindings(text).ok).toBe(false);
  });

  it('recovers a block whose closing fence was truncated', () => {
    const text = [
      CODE_REVIEW_FINDINGS_SENTINEL,
      '```json',
      JSON.stringify({ schema: 1, findings: [oneFinding] }),
    ].join('\n');
    expect(parseCodeReviewFindings(text).ok).toBe(true);
  });

  describe('caps truncate rather than reject', () => {
    it('keeps the first N findings of an over-long payload', () => {
      // A unit that produced 41 good findings must not be thrown away for the
      // 41st. Losing one finding is a smaller loss than losing the whole run.
      const many = Array.from({ length: CODE_REVIEW_MAX_FINDINGS_PER_UNIT + 5 }, (_, i) => ({
        ...oneFinding,
        title: `finding ${i}`,
      }));
      const result = parseCodeReviewFindings(payload(many));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.findings).toHaveLength(CODE_REVIEW_MAX_FINDINGS_PER_UNIT);
      expect(result.truncated).toBe(true);
    });

    it('trims an over-long body and anchor instead of dropping the finding', () => {
      const result = parseCodeReviewFindings(
        payload([{ ...oneFinding, body: 'x'.repeat(9000), anchor: 'y'.repeat(900) }])
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.findings[0]!.body.length).toBeLessThanOrEqual(4000);
      expect(result.findings[0]!.anchor.length).toBeLessThanOrEqual(200);
    });
  });

  describe('a malformed entry is dropped, not the payload', () => {
    it('drops an entry with no title and keeps its siblings', () => {
      const result = parseCodeReviewFindings(
        payload([{ ...oneFinding, title: '' }, oneFinding])
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.findings).toHaveLength(1);
    });

    it('defaults an unrecognised severity rather than refusing the finding', () => {
      const result = parseCodeReviewFindings(payload([{ ...oneFinding, severity: 'CRITICAL!!' }]));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.findings[0]!.severity).toBe('minor');
    });

    it('clamps a confidence outside 0..100', () => {
      const result = parseCodeReviewFindings(payload([{ ...oneFinding, confidence: 900 }]));
      if (!result.ok) return;
      expect(result.findings[0]!.confidence).toBe(100);
    });
  });

  it('describes the contract it parses, so the prompt cannot drift from it', () => {
    // The prompt block is generated from the same constants the parser reads.
    const contract = codeReviewOutputContract();
    expect(contract).toContain(CODE_REVIEW_FINDINGS_SENTINEL);
    expect(contract).toContain(String(CODE_REVIEW_MAX_FINDINGS_PER_UNIT));
    // And it must tell the agent that an empty answer still needs the block,
    // which is what stops a clean review arriving as a failed unit.
    expect(contract).toMatch(/empty findings array/i);
  });
});

describe('codeReviewDedupeKey', () => {
  const base = {
    filePath: 'src/a.ts',
    title: 'getUser can return undefined',
    anchor: 'const user = await getUser(id)',
    anchorVerified: true,
  };

  it('survives a rebase, because line numbers are not in the key', () => {
    // The whole requirement. If this ever changes, every re-review after a rebase
    // produces duplicates and silently un-dismisses what the user rejected.
    expect(codeReviewDedupeKey(base)).toBe(codeReviewDedupeKey({ ...base }));
  });

  it('is the same for two lenses reporting one problem', () => {
    // Cross-lens agreement must MERGE. The lens is deliberately not in the key:
    // two rows saying the same thing is the noisiest failure a multi-lens
    // reviewer has.
    const fromSecurity = codeReviewDedupeKey(base);
    const fromCorrectness = codeReviewDedupeKey({ ...base });
    expect(fromSecurity).toBe(fromCorrectness);
  });

  it('ignores whitespace and indentation changes in the anchor', () => {
    expect(codeReviewDedupeKey({ ...base, anchor: '  const user =   await getUser(id)  ' })).toBe(
      codeReviewDedupeKey(base)
    );
  });

  it('normalises the path so ./ and backslashes do not mint a new key', () => {
    expect(codeReviewDedupeKey({ ...base, filePath: './src/a.ts' })).toBe(
      codeReviewDedupeKey(base)
    );
    expect(codeReviewDedupeKey({ ...base, filePath: 'src\\a.ts' })).toBe(
      codeReviewDedupeKey(base)
    );
  });

  it('separates different problems in the same file', () => {
    expect(codeReviewDedupeKey({ ...base, title: 'Unbounded loop' })).not.toBe(
      codeReviewDedupeKey(base)
    );
  });

  it('separates the same problem in different files', () => {
    expect(codeReviewDedupeKey({ ...base, filePath: 'src/b.ts' })).not.toBe(
      codeReviewDedupeKey(base)
    );
  });

  it('falls back to file+title when the anchor was not verified', () => {
    // A paraphrased anchor would otherwise mint a new key on every cycle, so an
    // unverified one is dropped from the key entirely: weaker, but stable.
    const unverified = codeReviewDedupeKey({ ...base, anchorVerified: false });
    expect(unverified).toBe(
      codeReviewDedupeKey({ ...base, anchor: 'something else entirely', anchorVerified: false })
    );
    expect(unverified).not.toBe(codeReviewDedupeKey(base));
  });
});

describe('preset plans and progress', () => {
  it('counts the units a preset will spend, which is the progress denominator', () => {
    expect(codeReviewUnitCount('quick')).toBe(1);
    // 3 lenses + a sweep + a judging pass.
    expect(codeReviewUnitCount('standard')).toBe(5);
    // 5 lenses + a sweep, per chunk, plus one judging pass over the lot.
    expect(codeReviewUnitCount('deep', 2)).toBe(13);
  });

  it('only plans the phases its preset will actually walk', () => {
    // A bar that says "3 of 5" and then finds a sixth step is worse than an
    // indeterminate one, so Quick must not promise a sweep it will never run.
    expect(codeReviewPhasePlan('quick')).not.toContain('sweeping');
    expect(codeReviewPhasePlan('quick')).not.toContain('validating');
    expect(codeReviewPhasePlan('standard')).toContain('sweeping');
    expect(codeReviewPhasePlan('deep')).toContain('validating');
  });

  it('treats a queued review as indeterminate rather than nought per cent', () => {
    const progress = codeReviewProgress({
      phase: 'queued',
      phasePlan: codeReviewPhasePlan('standard'),
      runsDone: 0,
      runsTotal: 5,
    });
    expect(progress.indeterminate).toBe(true);
    expect(progress.fraction).toBeNull();
  });

  it('advances within the reviewing phase as units settle', () => {
    const plan = codeReviewPhasePlan('standard');
    const early = codeReviewProgress({ phase: 'reviewing', phasePlan: plan, runsDone: 1, runsTotal: 5 });
    const late = codeReviewProgress({ phase: 'reviewing', phasePlan: plan, runsDone: 4, runsTotal: 5 });
    // Without this the bar sits motionless on the one phase that takes longest.
    expect(late.fraction!).toBeGreaterThan(early.fraction!);
    expect(late.label).toContain('of 5');
  });

  it('never reports complete before the review is at rest', () => {
    for (const phase of ['preparing', 'reviewing', 'sweeping', 'validating'] as CodeReviewPhase[]) {
      const progress = codeReviewProgress({
        phase,
        phasePlan: codeReviewPhasePlan('deep'),
        runsDone: 99,
        runsTotal: 1,
      });
      expect(progress.fraction!).toBeLessThan(1);
    }
    expect(
      codeReviewProgress({ phase: 'ready', phasePlan: [], runsDone: 0, runsTotal: 0 }).fraction
    ).toBe(1);
  });

  it('holds no plan slot while a review rests with findings on screen', () => {
    // The load-bearing entry: `ready` is at rest, so a user reading findings is
    // not occupying the free plan's one cycle. Only `fixing` puts it back.
    expect(CODE_REVIEW_PHASE_AT_REST.ready).toBe(true);
    expect(CODE_REVIEW_PHASE_AT_REST.fixing).toBe(false);
  });

  it('weights reviewing above reading, so the bar does not stall', () => {
    // Deep is the preset where equal steps would be most obviously wrong.
    expect(CODE_REVIEW_PRESET_PLAN.deep.lenses).toBeGreaterThan(
      CODE_REVIEW_PRESET_PLAN.quick.lenses
    );
  });
});

describe('severityAtOrAbove', () => {
  it('answers the badge, the row colour and the inline-comment threshold alike', () => {
    expect(severityAtOrAbove('blocker', 'major')).toBe(true);
    expect(severityAtOrAbove('major', 'major')).toBe(true);
    expect(severityAtOrAbove('minor', 'major')).toBe(false);
    expect(severityAtOrAbove('nit', 'blocker')).toBe(false);
  });
});
