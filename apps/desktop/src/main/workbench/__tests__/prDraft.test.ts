/** @jest-environment node */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { buildPrDraftArgv } from '@talyn/shared';
import { PrDrafts } from '../prDraft';
import * as environment from '../environment';
import { testEnv } from '../testSupport';

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'talyn-prdraft-test-'));
  jest.spyOn(environment, 'processEnv').mockResolvedValue(testEnv);
});
afterEach(async () => {
  jest.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

const draftText =
  'Here it is.\n```json\n{"title":"feat: add it","body":"## Summary\\nAdds it.","commitMessage":"feat: wip"}\n```';

/** A fake CLI that prints these JSON lines, then exits with `code`. */
async function fakeCli(lines: unknown[], code = 0): Promise<string> {
  const cli = path.join(directory, 'fake.cjs');
  await fs.writeFile(
    cli,
    `process.stdout.write(${JSON.stringify(lines.map((l) => JSON.stringify(l)).join('\n'))});
process.exitCode = ${code};`,
  );
  return cli;
}

const input = { path: '', agent: 'claude' as const, prompt: 'draft it', resumeSessionId: 'sess-1' };

test.each([
  [
    'claude',
    [
      { type: 'system', subtype: 'init', session_id: 'fork-1' },
      { type: 'result', subtype: 'success', result: draftText, is_error: false },
    ],
  ],
  [
    'codex',
    [
      { type: 'thread.started', thread_id: 't' },
      { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: draftText } },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
    ],
  ],
] as const)('parses a %s draft from the final message', async (agent, lines) => {
  const cli = await fakeCli([...lines]);
  const drafts = new PrDrafts(() => [process.execPath, cli]);
  await expect(drafts.draft({ ...input, agent, path: directory })).resolves.toEqual({
    title: 'feat: add it',
    body: '## Summary\nAdds it.',
    commitMessage: 'feat: wip',
  });
});

test.each([
  ['an error result', [{ type: 'result', subtype: 'error_during_execution', result: 'Not logged in', is_error: true }], 1, 'Not logged in'],
  ['an answer with no JSON', [{ type: 'result', subtype: 'success', result: 'I could not.', is_error: false }], 0, 'did not answer'],
  ['no result at all', [], 3, 'exited with code 3'],
])('fails with the reason on %s', async (_name, lines, code, reason) => {
  const cli = await fakeCli(lines, code);
  const drafts = new PrDrafts(() => [process.execPath, cli]);
  await expect(drafts.draft({ ...input, path: directory })).rejects.toThrow(reason);
});

test('stops a draft that runs too long', async () => {
  const cli = path.join(directory, 'slow.cjs');
  await fs.writeFile(cli, 'setTimeout(() => {}, 60_000);');
  const drafts = new PrDrafts(() => [process.execPath, cli], 200);
  await expect(drafts.draft({ ...input, path: directory })).rejects.toThrow('took too long');
});

test('the Claude argv forks the session read-only, and Codex runs read-only and fresh', () => {
  const claude = buildPrDraftArgv({ agent: 'claude', prompt: 'p', resumeSessionId: 'sess-1' });
  expect(claude).toEqual(expect.arrayContaining(['--resume', 'sess-1', '--fork-session', '--permission-mode', 'dontAsk']));
  const codex = buildPrDraftArgv({ agent: 'codex', prompt: 'p', resumeSessionId: 'sess-1' });
  expect(codex).toContain('sandbox_mode="read-only"');
  expect(codex).not.toContain('resume');
});
