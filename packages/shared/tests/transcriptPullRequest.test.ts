import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/index.js';
import { buildBlocks } from '../src/transcript.js';
import { pullRequestOutcomeEvent } from '../src/workbenchPullRequest.js';

const reply = (seq: number, text: string): AgentEvent => ({
  seq, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const details = '```talyn-pr\n{"title":"feat: done","body":"B","commitMessage":"","draft":false}\n```';
const outcome = (seq: number, o: Parameters<typeof pullRequestOutcomeEvent>[0]) => ({ seq, ...pullRequestOutcomeEvent(o) }) as AgentEvent;

describe('the talyn_pr block', () => {
  it.each([
    ['opened', { ok: true, number: 4, url: 'u', existing: false } as const, { number: 4, title: 'feat: done', existing: false, adopted: false }],
    ['linked', { ok: true, number: 4, url: 'u', existing: true } as const, { number: 4, title: 'feat: done', existing: true, adopted: false }],
  ])('carries the PR and the agent title when %s', (_n, o, expected) => {
    const blocks = buildBlocks([reply(1, `Done.\n\n${details}`), outcome(2, o)]);
    expect(blocks.at(-1)).toMatchObject({ kind: 'system', subtype: 'talyn_pr', url: 'u', pullRequest: expected });
  });

  it('has no title when no reply carried details', () => {
    const block = buildBlocks([outcome(1, { ok: true, number: 4, url: 'u', existing: false })]).at(-1);
    expect(block).toMatchObject({ pullRequest: { number: 4 } });
    expect((block as { pullRequest: object }).pullRequest).not.toHaveProperty('title');
  });

  it('has no pull request on an error', () => {
    const block = buildBlocks([outcome(1, { ok: false, message: 'No.' })]).at(-1);
    expect(block).toMatchObject({ isError: true, text: 'No.' });
    expect(block).not.toHaveProperty('pullRequest');
  });
});
