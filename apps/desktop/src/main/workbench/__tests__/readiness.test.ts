/** @jest-environment node */
jest.mock('node-pty', () => {
  throw new Error('NODE_MODULE_VERSION 123 mismatch');
}, { virtual: true });

import { localReadiness, resetReadinessCache } from '../environment';

beforeEach(resetReadinessCache);

test('reports the shape and a pty failure message', async () => {
  const result = await localReadiness(true);
  expect(result.pty).toEqual({ ok: false, error: expect.stringContaining('NODE_MODULE_VERSION') });
  for (const key of ['claude', 'codex', 'git'] as const) {
    expect(typeof result[key].ok).toBe('boolean');
    expect(result[key].ok).toBe(result[key].path !== undefined);
  }
  expect(result.git.ok).toBe(true);
});

test('caches for 30 seconds unless forced', async () => {
  const first = await localReadiness(true);
  expect(await localReadiness()).toBe(first);
  expect(await localReadiness(true)).not.toBe(first);
});
