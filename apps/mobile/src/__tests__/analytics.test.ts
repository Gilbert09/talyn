import { readAnalyticsConfig } from '../../app.config';
import {
  analyticsConfigOf, beforeSend, captureAnalyticsException, getAnalyticsOptOut, identifyAnalyticsUser, initAnalytics,
  isAnalyticsConfigured, OPT_OUT_KEY, registerSuperProperties, resetAnalyticsForTests, resetAnalyticsUser, screenPattern,
  setAnalyticsOptOut, setAnalyticsReachability, trackEvent, trackScreen,
} from '../lib/analytics';

type Options = Record<string, unknown> & { defaultOptIn?: boolean };

const mockStore = new Map<string, string>();
const mockCalls: string[] = [];
const mockClients: MockPostHog[] = [];
let mockExtra: Record<string, unknown> = {};

class MockPostHog {
  optedOut: boolean;
  captured: Array<{ event: string; properties?: unknown }> = [];
  ready = jest.fn(async () => { mockCalls.push('ready'); });
  optOut = jest.fn(async () => { this.optedOut = true; mockCalls.push('optOut'); });
  optIn = jest.fn(async () => { this.optedOut = false; mockCalls.push('optIn'); });
  register = jest.fn(async () => { mockCalls.push('register'); });
  identify = jest.fn();
  reset = jest.fn(() => { mockCalls.push('reset'); });
  screen = jest.fn(async () => {});
  captureException = jest.fn();
  startSessionRecording = jest.fn(async () => { mockCalls.push('startSessionRecording'); });
  stopSessionRecording = jest.fn(async () => { mockCalls.push('stopSessionRecording'); });
  // Like the SDK: an opted-out client sends nothing.
  capture = jest.fn((event: string, properties?: unknown) => { if (!this.optedOut) this.captured.push({ event, properties }); });
  constructor(public key: string, public options: Options) {
    mockCalls.push('construct');
    this.optedOut = options.defaultOptIn === false;
    mockClients.push(this);
  }
}

jest.mock('posthog-react-native', () => ({ __esModule: true, default: function PostHog(key: string, options: Options) {
  return new MockPostHog(key, options);
} }));
jest.mock('expo-constants', () => ({ __esModule: true, default: {
  get expoConfig() { return { version: '1.2.3', extra: mockExtra, ios: { buildNumber: '7' }, android: { versionCode: 7 } }; },
  platform: {},
} }));
jest.mock('expo-updates', () => ({ channel: 'preview', runtimeVersion: 'abc', isEmbeddedLaunch: false, updateId: '0123456789abcdef', createdAt: null }));
jest.mock('@react-native-async-storage/async-storage', () => ({ __esModule: true, default: {
  getItem: jest.fn(async (key: string) => { mockCalls.push('getItem'); return mockStore.get(key) ?? null; }),
  setItem: jest.fn(async (key: string, value: string) => { mockStore.set(key, value); }),
} }));

const CONFIG = { key: 'phc_fixture', host: 'https://us.i.posthog.com' };

function configure(environment: 'development' | 'preview' | 'production' = 'production', analytics: unknown = CONFIG) {
  mockExtra = { appEnvironment: environment, analytics };
}

async function started() {
  await initAnalytics();
  return mockClients[mockClients.length - 1];
}

beforeEach(() => {
  resetAnalyticsForTests();
  mockStore.clear();
  mockCalls.length = 0;
  mockClients.length = 0;
  configure();
});

describe('analytics config', () => {
  it.each([
    [{}, null],
    [{ EXPO_PUBLIC_TALYN_POSTHOG_KEY: '' }, null],
    [{ EXPO_PUBLIC_TALYN_POSTHOG_KEY: 'phc_abc' }, { key: 'phc_abc', host: 'https://us.i.posthog.com' }],
    [{ EXPO_PUBLIC_TALYN_POSTHOG_KEY: 'phc_abc', EXPO_PUBLIC_TALYN_POSTHOG_HOST: 'https://eu.i.posthog.com/' }, { key: 'phc_abc', host: 'https://eu.i.posthog.com' }],
  ])('reads %j from the build env', (env, expected) => {
    expect(readAnalyticsConfig(env)).toEqual(expected);
  });

  it.each([
    [{ EXPO_PUBLIC_TALYN_POSTHOG_KEY: 'phx_personal' }],
    [{ EXPO_PUBLIC_TALYN_POSTHOG_KEY: 'phc_abc', EXPO_PUBLIC_TALYN_POSTHOG_HOST: 'http://us.i.posthog.com' }],
    [{ EXPO_PUBLIC_TALYN_POSTHOG_KEY: 'phc_abc', EXPO_PUBLIC_TALYN_POSTHOG_HOST: 'https://us.i.posthog.com/path' }],
  ])('refuses %j', (env) => {
    expect(() => readAnalyticsConfig(env)).toThrow();
  });

  it.each([
    [undefined, null],
    [{}, null],
    [{ analytics: null }, null],
    [{ analytics: { key: '', host: 'https://x' } }, null],
    [{ analytics: CONFIG }, CONFIG],
  ])('reads the app extra %j', (extra, expected) => {
    expect(analyticsConfigOf(extra)).toEqual(expected);
  });
});

describe('without a key', () => {
  beforeEach(() => configure('production', null));

  it('does nothing at all', async () => {
    expect(isAnalyticsConfigured()).toBe(false);
    await expect(initAnalytics()).resolves.toBeNull();
    trackEvent('app_opened');
    trackScreen('/home');
    identifyAnalyticsUser('user');
    resetAnalyticsUser();
    registerSuperProperties({ workspace_id: 'w' });
    captureAnalyticsException(new Error('boom'));
    await setAnalyticsOptOut(true);
    expect(mockClients).toHaveLength(0);
    expect(mockCalls).not.toContain('construct');
  });
});

describe('initialisation', () => {
  it('reads the saved opt-out before the client exists, so nothing is sent', async () => {
    mockStore.set(OPT_OUT_KEY, 'true');
    const client = await started();
    expect(mockCalls.indexOf('getItem')).toBeLessThan(mockCalls.indexOf('construct'));
    expect(client.options.defaultOptIn).toBe(false);
    expect(getAnalyticsOptOut()).toBe(true);
    trackEvent('session_created', { kind: 'session' });
    expect(client.captured).toEqual([]);
  });

  it('opts in by default and sends app_opened after the super properties', async () => {
    const client = await started();
    expect(client.options.defaultOptIn).toBe(true);
    expect(client.captured.map((event) => event.event)).toEqual(['app_opened']);
    expect(mockCalls.indexOf('register')).toBeLessThan(mockCalls.length);
    expect(client.register).toHaveBeenCalledWith({
      client: 'mobile', platform: 'ios', app_version: '1.2.3', app_build: '7', update_id: '01234567', update_channel: 'preview',
      environment: 'production',
    });
  });

  it('makes the SDK agree with the saved choice', async () => {
    mockStore.set(OPT_OUT_KEY, 'false');
    const client = await started();
    expect(client.optOut).not.toHaveBeenCalled();
    expect(client.optIn).not.toHaveBeenCalled();
  });

  it('starts once', async () => {
    await Promise.all([initAnalytics(), initAnalytics()]);
    expect(mockClients).toHaveLength(1);
  });

  it.each([
    ['development', false, false],
    ['preview', true, true],
    ['production', true, true],
  ] as const)('in %s, replay is %s and exception autocapture is %s', async (environment, replay, exceptions) => {
    configure(environment);
    const { options } = await started();
    expect(options).toMatchObject({ host: CONFIG.host, personProfiles: 'identified_only', captureAppLifecycleEvents: true, enableSessionReplay: replay });
    expect(options.sessionReplayConfig).toMatchObject({ maskAllTextInputs: true, maskAllImages: true, maskAllSandboxedViews: true, captureLog: false });
    expect(options.errorTracking).toEqual(exceptions
      ? { autocapture: { uncaughtExceptions: true, unhandledRejections: true, console: ['error'] } }
      : { autocapture: false });
    expect(options.before_send).toBe(beforeSend);
  });
});

describe('opt-out', () => {
  it('stops replay before opting out, and saves the choice', async () => {
    const client = await started();
    mockCalls.length = 0;
    await setAnalyticsOptOut(true);
    expect(mockCalls).toEqual(['stopSessionRecording', 'optOut']);
    expect(mockStore.get(OPT_OUT_KEY)).toBe('true');
    trackEvent('session_archived');
    expect(client.captured.map((event) => event.event)).toEqual(['app_opened']);
  });

  it('opts back in and starts replay', async () => {
    mockStore.set(OPT_OUT_KEY, 'true');
    await started();
    mockCalls.length = 0;
    await setAnalyticsOptOut(false);
    expect(mockCalls).toEqual(['optIn', 'startSessionRecording']);
    expect(mockStore.get(OPT_OUT_KEY)).toBe('false');
  });

  it('does not start replay in a development build', async () => {
    configure('development');
    mockStore.set(OPT_OUT_KEY, 'true');
    await started();
    mockCalls.length = 0;
    await setAnalyticsOptOut(false);
    expect(mockCalls).toEqual(['optIn']);
  });

  it('saves the choice before analytics starts', async () => {
    await setAnalyticsOptOut(true);
    expect(mockStore.get(OPT_OUT_KEY)).toBe('true');
    expect((await started()).options.defaultOptIn).toBe(false);
  });
});

describe('identity', () => {
  it('identifies with the Supabase user id and the web person properties', async () => {
    const client = await started();
    identifyAnalyticsUser('user-1', { email: 'a@b.dev', github_login: 'octo' });
    expect(client.identify).toHaveBeenCalledWith('user-1', { email: 'a@b.dev', github_login: 'octo' });
  });

  it('puts the build super properties back after a reset', async () => {
    const client = await started();
    client.register.mockClear();
    mockCalls.length = 0;
    resetAnalyticsUser();
    expect(mockCalls).toEqual(['reset', 'register']);
    expect(client.register).toHaveBeenCalledWith(expect.objectContaining({ client: 'mobile', environment: 'production' }));
  });

  it('passes screens, workspace and exceptions through', async () => {
    const client = await started();
    trackScreen('/pulls/[id]');
    registerSuperProperties({ workspace_id: 'w1' });
    const error = new Error('boom');
    captureAnalyticsException(error, { boundary: 'This message' });
    expect(client.screen).toHaveBeenCalledWith('/pulls/[id]');
    expect(client.register).toHaveBeenCalledWith({ workspace_id: 'w1' });
    expect(client.captureException).toHaveBeenCalledWith(error, { boundary: 'This message' });
  });
});

describe('screenPattern', () => {
  it.each([
    [[], '/'],
    [['(drawer)'], '/'],
    [['(drawer)', 'home'], '/home'],
    [['(drawer)', 'index'], '/'],
    [['pulls', '[id]'], '/pulls/[id]'],
    [['pulls', 'index'], '/pulls'],
    [['sessions', '[id]'], '/sessions/[id]'],
    [['settings', 'instructions', 'prompt', '[kind]'], '/settings/instructions/prompt/[kind]'],
    [['(auth)', 'sign-in'], '/sign-in'],
    [['[...missing]'], '/[...missing]'],
  ])('%j is %s', (segments, pattern) => {
    expect(screenPattern(segments)).toBe(pattern);
  });
});

describe('beforeSend', () => {
  const exception = (value: string, frames: Array<Record<string, string>> = []) => ({
    uuid: 'u', event: '$exception', properties: { $exception_list: [{ value, stacktrace: { frames } }] },
  });

  it('passes other events through untouched', () => {
    const event = { uuid: 'u', event: 'session_created', properties: { kind: 'session' } };
    expect(beforeSend(event as never)).toBe(event);
    expect(beforeSend(null)).toBeNull();
  });

  it.each([
    ['offline', 'Network request failed: Failed to fetch', 'offline', null],
    ['online', 'Failed to fetch', 'online', { online: true, connectivity_error: true }],
    ['unknown', 'Failed to fetch', 'unknown', { online: null, connectivity_error: true }],
    ['online', 'TypeError: x is not a function', 'online', { online: true, connectivity_error: false }],
    ['offline', 'TypeError: x is not a function', 'offline', { online: false, connectivity_error: false }],
    ['online', 'Lock "lock:sb-abc-auth-token" was released because another request stole it', 'online', null],
  ] as const)('with the device %s, "%s"', (_label, message, reachability, tags) => {
    setAnalyticsReachability(reachability);
    const result = beforeSend(exception(message) as never);
    if (tags === null) expect(result).toBeNull();
    else expect(result?.properties).toMatchObject(tags);
  });

  it('drops an exception from a hot update frame', () => {
    setAnalyticsReachability('online');
    expect(beforeSend(exception('boom', [{ filename: 'http://localhost:8081/main.hot-update.js' }]) as never)).toBeNull();
  });
});
