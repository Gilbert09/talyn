import { describe, expect, it } from 'vitest';
import { queuedRowRequest } from '../lib/rowRequestQueue';

describe('queuedRowRequest', () => {
  it.each([[1], [4], [5], [30]])('runs %i requests at most four at a time, and all of them', async (count) => {
    let running = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        queuedRowRequest(async () => {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise((resolve) => setTimeout(resolve, 2));
          running -= 1;
          return i;
        })
      )
    );
    expect(results).toEqual(Array.from({ length: count }, (_, i) => i));
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('frees its slot when a request fails', async () => {
    const failures = Array.from({ length: 6 }, () => queuedRowRequest(() => Promise.reject(new Error('no'))));
    await Promise.allSettled(failures);
    await expect(queuedRowRequest(async () => 'ok')).resolves.toBe('ok');
  });
});
