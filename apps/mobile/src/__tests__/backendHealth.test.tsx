import { fireEvent, render, screen } from '@testing-library/react-native';
import * as React_ from 'react';
import { Text } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import { BackendHealth, classifyProbe, classifyRequestError, PROBE_DELAYS_MS } from '../workflow/backendHealth';
import { BackendHealthFrame, healthCopy } from '../components/BackendHealthBanner';

const networkError = (online: boolean) => Object.assign(new Error('fetch failed'), { name: 'ApiNetworkError', online });

describe('backend health classification', () => {
  it.each([
    [{ error: networkError(true) }, 'unreachable'],
    [{ error: networkError(false) }, null],
    [{ error: new Error('x'), status: 500 }, 'degraded'],
    [{ error: new Error('x'), status: 502 }, 'degraded'],
    [{ error: new Error('x'), status: 503 }, 'degraded'],
    [{ error: new Error('x'), status: 400 }, null],
    [{ error: new Error('x'), status: 401 }, null],
    [{ error: new Error('x'), status: 402 }, null],
    [{ error: new Error('x'), status: 404 }, null],
    [{ error: new Error('x') }, null],
    [{ error: null }, null],
  ] as const)('a failed request %j says %s', (input, expected) => {
    expect(classifyRequestError(input)).toBe(expected);
  });

  it.each([[200, 'ok'], [204, 'ok'], [404, 'ok'], [500, 'degraded'], [503, 'degraded'], [null, 'unreachable']] as const)(
    'a probe answering %s reads %s', (status, expected) => {
      expect(classifyProbe(status)).toBe(expected);
    });

  it('has copy for the two bad states only, with no dashes', () => {
    expect(healthCopy('ok')).toBeNull();
    for (const state of ['unreachable', 'degraded'] as const) {
      const copy = healthCopy(state)!;
      expect(`${copy.title} ${copy.detail}`).not.toMatch(/[—–]/);
    }
  });
});

describe('BackendHealth monitor', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const make = (answers: Array<number | 'throw'>, canProbe = () => true) => {
    const fetch = jest.fn(async () => {
      const next = answers.length > 1 ? answers.shift()! : answers[0];
      if (next === 'throw') throw new Error('network');
      return { status: next };
    });
    const health = new BackendHealth('https://api.test/health', { fetch, canProbe, now: () => 1000 });
    const seen: string[] = [];
    health.subscribe(() => seen.push(health.getSnapshot().state));
    return { health, fetch, seen };
  };
  const flush = async (ms = 0) => { await jest.advanceTimersByTimeAsync(ms); };

  it('does not poll while nothing failed', async () => {
    const { fetch } = make([200]);
    await flush(120_000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ignores a failure the probe does not confirm, so one blip shows no banner', async () => {
    const { health, fetch } = make([200]);
    health.report({ error: networkError(true) });
    await flush();
    expect(fetch).toHaveBeenCalledWith('https://api.test/health', expect.objectContaining({ signal: expect.anything() }));
    expect(health.getSnapshot().state).toBe('ok');
    await flush(120_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('shows unreachable when the probe gets no answer, backs off, and clears on recovery', async () => {
    const { health, fetch } = make(['throw', 'throw', 'throw', 200]);
    health.report({ error: networkError(true) });
    await flush();
    expect(health.getSnapshot()).toMatchObject({ state: 'unreachable', since: 1000 });
    await flush(PROBE_DELAYS_MS[1]);
    expect(fetch).toHaveBeenCalledTimes(2);
    await flush(PROBE_DELAYS_MS[2]);
    expect(fetch).toHaveBeenCalledTimes(3);
    await flush(PROBE_DELAYS_MS[3]);
    expect(health.getSnapshot().state).toBe('ok');
    await flush(300_000);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('reads a 503 from the health route as degraded', async () => {
    const { health } = make([503]);
    health.report({ error: new Error('x'), status: 502 });
    await flush();
    expect(health.getSnapshot().state).toBe('degraded');
  });

  it('caps the backoff at one probe a minute', async () => {
    const { health, fetch } = make(['throw']);
    health.report({ error: networkError(true) });
    await flush();
    await flush(PROBE_DELAYS_MS.reduce((sum, ms) => sum + ms, 0));
    const before = fetch.mock.calls.length;
    await flush(60_000);
    expect(fetch.mock.calls.length).toBe(before + 1);
  });

  it('does not probe while the phone cannot, and does not count that as down', async () => {
    let online = false;
    const { health, fetch } = make([200], () => online);
    health.report({ error: networkError(true) });
    await flush(30_000);
    expect(fetch).not.toHaveBeenCalled();
    expect(health.getSnapshot().state).toBe('ok');
    online = true;
    await flush(PROBE_DELAYS_MS[1]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('Try now probes at once and ignores reports that say nothing', async () => {
    const { health, fetch } = make(['throw']);
    health.report({ error: new Error('x'), status: 404 });
    await flush(10_000);
    expect(fetch).not.toHaveBeenCalled();
    health.report({ error: networkError(true) });
    await flush();
    await flush(1_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    health.checkNow();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('stops after dispose', async () => {
    const { health, fetch } = make(['throw']);
    health.report({ error: networkError(true) });
    health.dispose();
    await flush(120_000);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('BackendHealthFrame', () => {
  const fake = (state: 'ok' | 'unreachable' | 'degraded') => {
    const snapshot = { state, checking: false, since: state === 'ok' ? null : 1 };
    return { getSnapshot: () => snapshot, subscribe: () => () => {}, checkNow: jest.fn() } as unknown as BackendHealth & { checkNow: jest.Mock };
  };
  const Child = () => {
    const insets = React_.useContext(SafeAreaInsetsContext);
    return React_.createElement(Text, null, `top ${insets?.top}`);
  };
  const tree = (health: BackendHealth) => React_.createElement(SafeAreaInsetsContext.Provider, { value: { top: 40, bottom: 20, left: 0, right: 0 } },
    React_.createElement(BackendHealthFrame, { health }, React_.createElement(Child)));

  it('shows nothing and leaves the insets alone while healthy', async () => {
    await render(tree(fake('ok')));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('top 40')).toBeTruthy();
  });

  it.each([
    ['unreachable', "Can't reach Talyn"],
    ['degraded', 'Talyn is having trouble on our side'],
  ] as const)('%s shows its banner, takes the top inset, and Try now probes', async (state, title) => {
    const health = fake(state);
    await render(tree(health));
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByText('top 0')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Try now' }));
    expect(health.checkNow).toHaveBeenCalled();
  });
});
