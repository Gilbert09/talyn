import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveRepository } from '../services/trunk/client.js';
import { clearMergeEtaCache, mergeEtaForPr, type MergeEtaPr } from '../services/trunk/mergeEta.js';

vi.mock('../services/trunk/credentials.js', () => ({
  getTrunkCredentials: vi.fn(async () => ({ token: 'trunk_v2_test', tokenFingerprint: 'ciphertext', reauthRequired: false })),
  isTrunkApiKey: (key: string) => key.startsWith('trunk_v2_'),
  clearTrunkReauth: vi.fn(),
  markTrunkReauthRequired: vi.fn(),
}));

const pr = (number: number): MergeEtaPr => ({
  id: `pr-${number}`, workspaceId: 'ws1', owner: 'PostHog', repo: 'posthog', number, state: 'open', labels: [],
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const responseFor = (url: string) => {
  if (url.includes('/v2/repositories')) return json({ data: [{ id: 'repo-1' }] });
  if (url.includes('/v2/pull-requests?')) {
    const numbers = new URL(url).searchParams.getAll('number').map(Number);
    return json({ data: numbers.map((number) => ({ id: `trunk-pr-${number}`, number, isCurrentlySubmittedToQueue: true, queueEntry: { state: 'pending' } })) });
  }
  return json({ status: 'available', kind: 'merge', estimatedAt: '2026-10-30T12:30:00Z' });
};

beforeEach(() => {
  clearMergeEtaCache();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  clearMergeEtaCache();
});

describe('Trunk merge ETA service', () => {
  it.each([
    ['seconds', '120', 121_000],
    ['HTTP date', 'Fri, 30 Oct 2026 12:02:00 GMT', 121_000],
    ['default', null, 11_000],
    ['15 minute cap', '3600', 901_000],
  ])('pauses all PR reads after a 429 with %s Retry-After', async (_name, header, advance) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('slow down', { status: 429, headers: header ? { 'Retry-After': header } : {} })
    );
    expect((await mergeEtaForPr(pr(1))).reason).toBe('unavailable');
    const paused = await Promise.all([mergeEtaForPr(pr(2)), mergeEtaForPr(pr(3)), mergeEtaForPr(pr(4))]);
    expect(paused.map((answer) => answer.reason)).toEqual(['unavailable', 'unavailable', 'unavailable']);
    expect(fetch).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + advance);
    fetch.mockImplementation(async (input) => responseFor(String(input)));
    expect((await mergeEtaForPr(pr(2))).eta).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('pauses after a 503 with Retry-After', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('busy', { status: 503, headers: { 'Retry-After': '120' } }));
    expect((await mergeEtaForPr(pr(1))).reason).toBe('unavailable');
    expect((await mergeEtaForPr(pr(2))).reason).toBe('unavailable');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('shares a cold repository lookup across PRs', async () => {
    let resolveRepositoryResponse!: (response: Response) => void;
    const repository = new Promise<Response>((resolve) => { resolveRepositoryResponse = resolve; });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).includes('/v2/repositories') ? repository : responseFor(String(input))
    );
    const pending = [mergeEtaForPr(pr(1)), mergeEtaForPr(pr(2)), mergeEtaForPr(pr(3))];
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    resolveRepositoryResponse(json({ data: [{ id: 'repo-1' }] }));
    expect((await Promise.all(pending)).every((answer) => answer.eta !== null)).toBe(true);
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/v2/repositories'))).toHaveLength(1);
  });

  it('retries a failed repository lookup and labels repository 404', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ error: { code: 'NOT_FOUND' } }, 404));
    expect(await mergeEtaForPr(pr(1))).toMatchObject({ reason: 'no_access', message: 'This Trunk key cannot see PostHog/posthog' });
    fetch.mockImplementation(async (input) => responseFor(String(input)));
    expect((await mergeEtaForPr(pr(2))).eta).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('keeps a PR lookup 404 as not queued', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).includes('/v2/pull-requests?') ? json({ error: { code: 'NOT_FOUND' } }, 404) : responseFor(String(input))
    );
    expect((await mergeEtaForPr(pr(1))).reason).toBe('not_queued');
  });

  it('keeps an estimate 404 as not queued', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).includes('/queue-entry-estimate') ? json({ error: { code: 'NOT_FOUND' } }, 404) : responseFor(String(input))
    );
    expect((await mergeEtaForPr(pr(1))).reason).toBe('not_queued');
  });

  it('combines 20 PR lookups and estimates each active PR once', async () => {
    vi.useFakeTimers();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => responseFor(String(input)));
    const pending = Promise.all(Array.from({ length: 20 }, (_, index) => mergeEtaForPr(pr(index + 1))));
    await vi.runAllTimersAsync();
    expect((await pending).every((answer) => answer.eta !== null)).toBe(true);
    const lookups = fetch.mock.calls.filter(([url]) => String(url).includes('/v2/pull-requests?'));
    expect(lookups).toHaveLength(1);
    expect(new URL(String(lookups[0][0])).searchParams.getAll('number')).toHaveLength(20);
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/queue-entry-estimate'))).toHaveLength(20);
  });

  it('splits lookups after 50 numbers and marks missing PRs as not queued', async () => {
    vi.useFakeTimers();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/v2/pull-requests?')) {
        const numbers = new URL(url).searchParams.getAll('number').map(Number);
        return json({ data: numbers.filter((number) => number !== 51).map((number) => ({
          id: `trunk-pr-${number}`, number, isCurrentlySubmittedToQueue: true, queueEntry: { state: 'pending' },
        })) });
      }
      return responseFor(url);
    });
    const pending = Promise.all(Array.from({ length: 51 }, (_, index) => mergeEtaForPr(pr(index + 1))));
    await vi.runAllTimersAsync();
    const answers = await pending;
    const lookups = fetch.mock.calls.filter(([url]) => String(url).includes('/v2/pull-requests?'));
    expect(lookups).toHaveLength(2);
    expect(lookups.map(([url]) => new URL(String(url)).searchParams.getAll('number').length).sort()).toEqual([1, 50]);
    expect(answers[50].reason).toBe('not_queued');
  });

  it('spaces all requests for one key at least 251 ms apart', async () => {
    vi.useFakeTimers();
    const at: number[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      at.push(Date.now());
      return json({ data: [{ id: 'repo-1' }] });
    });
    const pending = Promise.all(Array.from({ length: 12 }, () => resolveRepository('trunk_v2_test', pr(1))));
    await vi.runAllTimersAsync();
    await pending;
    expect(at).toHaveLength(12);
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(251);
  });

  it('returns unavailable when the key queue exceeds ten seconds', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => responseFor(String(input)));
    const pending = Promise.all(Array.from({ length: 50 }, (_, index) => mergeEtaForPr(pr(index + 1))));
    await vi.runAllTimersAsync();
    const answers = await pending;
    expect(answers.some((answer) => answer.reason === 'unavailable')).toBe(true);
    expect(answers.some((answer) => answer.eta !== null)).toBe(true);
  });

  it('pauses ten seconds after a 429 without Retry-After', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('slow down', { status: 429 }));
    expect((await mergeEtaForPr(pr(1))).reason).toBe('unavailable');
    vi.setSystemTime(new Date('2026-10-30T12:00:09.999Z'));
    expect((await mergeEtaForPr(pr(2))).reason).toBe('unavailable');
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-10-30T12:00:10Z'));
    fetch.mockImplementation(async (input) => responseFor(String(input)));
    expect((await mergeEtaForPr(pr(2))).eta).not.toBeNull();
  });

  it('asks for no estimate when a PR is not active', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('/v2/pull-requests?')) {
        return json({ data: [{ id: 'trunk-pr-1', number: 1, isCurrentlySubmittedToQueue: false, queueEntry: { state: 'pending' } }] });
      }
      return responseFor(String(input));
    });
    expect((await mergeEtaForPr(pr(1))).reason).toBe('not_queued');
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/queue-entry-estimate'))).toBe(false);
  });
});
