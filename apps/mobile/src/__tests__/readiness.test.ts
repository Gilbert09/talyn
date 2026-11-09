import type { WorkbenchReadiness } from '@talyn/shared';

import { listItems, readinessProblem } from '../features/sessions/model';
import { session } from './workflowFixtures';

const ready = (patch: Partial<WorkbenchReadiness['sandbox']> = {}): WorkbenchReadiness =>
  ({ sandbox: { ok: true, reasons: [], agents: { claude: { ok: true }, codex: { ok: true } }, ...patch } });

describe('readiness problems', () => {
  it.each([
    ['nothing loaded', undefined, null],
    ['everything ready', ready(), null],
    ['an agent that needs a connection', ready({ agents: { claude: { ok: true }, codex: { ok: false, reason: { code: 'agent_not_connected', message: 'Connect Codex.' } } } }), 'Connect Codex.'],
    ['an agent with no reason', ready({ agents: { claude: { ok: true }, codex: { ok: false } } }), 'This agent cannot run right now.'],
    ['an unavailable sandbox', ready({ ok: false, reasons: [{ code: 'fleet_disabled', message: 'Paused.' }] }), 'Paused.'],
  ])('reports %s', (_name, readiness, expected) => expect(readinessProblem(readiness, 'codex')).toBe(expected));
});

describe('session list sections', () => {
  it('labels each repository and leaves repository-free rows unlabelled', () => {
    const items = listItems([session({ id: 'a', repoFullName: 'x/one' }), session({ id: 'b', repoFullName: '', createdAt: '2026-11-01T00:00:00Z' })]);
    expect(items.map((item) => item.type === 'section' ? `section:${item.repo}` : `${item.key}:${item.last}`)).toEqual(['section:x/one', 'a:true', 'b:true']);
  });
});
