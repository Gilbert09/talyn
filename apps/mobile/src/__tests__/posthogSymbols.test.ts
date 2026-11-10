import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { POSTHOG_SYMBOL_UPLOADS, posthogUploadCredentials } = require('../../release/policy.cjs');
const { posthogCli } = require('../../release/toolchain.json');
const { DOTENV_FILE, symbolUploadCredentials, writeCredentials, withPostHogSymbolUploads } = require('../../plugins/withPostHogSymbolUploads.cjs');
const { hermesUploadPlan, uploadUpdateSourceMaps, easInstallPlan, runEasInstall } = require('../../scripts/posthog-symbols.cjs');
const { publishEnvironment } = require('../../scripts/publish-update.cjs');
const { checkUpdateWorkflow } = require('../../scripts/check-release.cjs');
const yaml = require('js-yaml');

// Inert fixtures: not real keys.
const KEY = 'phx_fixtureFixtureFixture';
const CREDENTIALS = { POSTHOG_CLI_API_KEY: KEY, POSTHOG_CLI_PROJECT_ID: '459813', POSTHOG_CLI_HOST: 'https://us.posthog.com' };
const EXP = { version: '0.1.0', ios: { bundleIdentifier: 'dev.talyn.mobile.preview' }, android: { package: 'dev.talyn.mobile.preview' } };
const METADATA = { fileMetadata: { ios: { bundle: '_expo/static/js/ios/entry-a.hbc' }, android: { bundle: '_expo/static/js/android/entry-b.hbc' } } };

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'posthog-symbols-'));
}

const NO_METADATA = Symbol('no metadata.json');

function exportedRoot(metadata: unknown = METADATA): string {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'dist'));
  if (metadata !== NO_METADATA) fs.writeFileSync(path.join(root, 'dist/metadata.json'), typeof metadata === 'string' ? metadata : JSON.stringify(metadata));
  return root;
}

describe('posthogUploadCredentials', () => {
  it('keeps the project and host in one place', () => {
    expect(POSTHOG_SYMBOL_UPLOADS).toEqual({ projectId: '459813', host: 'https://us.posthog.com', keyName: 'POSTHOG_CLI_API_KEY' });
    expect(Object.isFrozen(POSTHOG_SYMBOL_UPLOADS)).toBe(true);
  });

  it.each([
    ['absent', {}],
    ['empty', { POSTHOG_CLI_API_KEY: '' }],
    ['blank', { POSTHOG_CLI_API_KEY: '   ' }],
  ])('is null when the key is %s', (_name, env) => {
    expect(posthogUploadCredentials(env)).toBeNull();
  });

  it.each([
    ['a project key', 'phc_projectKeyValue'],
    ['a key with a newline', 'phx_abc\nPOSTHOG_CLI_HOST=https://evil.example'],
    ['a key with spaces', 'phx_abc def'],
    ['some other token', 'ghp_abcdef'],
  ])('refuses %s', (_name, key) => {
    expect(() => posthogUploadCredentials({ POSTHOG_CLI_API_KEY: key })).toThrow('personal API key (phx_)');
  });

  it.each([
    ['as given', KEY],
    ['trimmed', `  ${KEY}\n`],
  ])('returns the CLI values for a personal API key %s', (_name, key) => {
    expect(posthogUploadCredentials({ POSTHOG_CLI_API_KEY: key })).toEqual(CREDENTIALS);
  });
});

describe('symbolUploadCredentials', () => {
  it.each([
    ['development', { POSTHOG_CLI_API_KEY: KEY }, null],
    [undefined, { POSTHOG_CLI_API_KEY: KEY }, null],
    ['', { POSTHOG_CLI_API_KEY: KEY }, null],
    ['preview', {}, null],
    ['preview', { POSTHOG_CLI_API_KEY: KEY }, CREDENTIALS],
    ['internal-beta', { POSTHOG_CLI_API_KEY: KEY }, CREDENTIALS],
    ['production', { POSTHOG_CLI_API_KEY: KEY }, CREDENTIALS],
  ])('for profile %s with %j', (profile, env, expected) => {
    expect(symbolUploadCredentials(env, profile)).toEqual(expected);
  });
});

describe('withPostHogSymbolUploads', () => {
  const base = () => ({ name: 'Talyn', slug: 'talyn-mobile' });
  let warn: jest.SpyInstance;
  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
  afterEach(() => warn.mockRestore());

  it.each([
    ['there is no key', 'preview', {}],
    ['the profile is development', 'development', { POSTHOG_CLI_API_KEY: KEY }],
  ])('leaves the config untouched when %s', (_name, profile, env) => {
    const config = base();
    const result = withPostHogSymbolUploads(config, { profile, env });
    expect(result).toBe(config);
    expect(result).not.toHaveProperty('mods');
  });

  it('applies the official plugin with native symbol upload when the key is set', () => {
    const result = withPostHogSymbolUploads(base(), { profile: 'preview', env: { POSTHOG_CLI_API_KEY: KEY } });
    expect(Object.keys(result.mods.ios)).toEqual(expect.arrayContaining(['dangerous', 'xcodeproj']));
    expect(Object.keys(result.mods.android)).toEqual(expect.arrayContaining(['dangerous', 'appBuildGradle', 'projectBuildGradle', 'gradleProperties']));
    // Nothing reaches the public config: only mods, so the native fingerprint is the same as without the key.
    const { mods, ...publicConfig } = result;
    expect(mods).toBeDefined();
    expect(JSON.stringify(publicConfig)).not.toContain(KEY);
  });

  it('refuses a key that is not a personal API key', () => {
    expect(() => withPostHogSymbolUploads(base(), { profile: 'production', env: { POSTHOG_CLI_API_KEY: 'phc_project' } })).toThrow('phx_');
  });

  it('writes the CLI credentials under the gitignored .expo directory, readable only by the owner', () => {
    const root = tempDir();
    writeCredentials(root, CREDENTIALS);
    const file = path.join(root, DOTENV_FILE);
    expect(DOTENV_FILE.startsWith('.expo/')).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(`POSTHOG_CLI_API_KEY=${KEY}\nPOSTHOG_CLI_PROJECT_ID=459813\nPOSTHOG_CLI_HOST=https://us.posthog.com\n`);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('hermesUploadPlan', () => {
  const dist = path.resolve('/tmp/app/dist');

  it('uploads each platform directory with that platform\'s release coordinates', () => {
    expect(hermesUploadPlan(dist, METADATA, EXP)).toEqual([
      { platform: 'ios', directory: path.join(dist, '_expo/static/js/ios'),
        args: ['hermes', 'upload', '--directory', path.join(dist, '_expo/static/js/ios'), '--release-mode', 'event', '--release-name', 'dev.talyn.mobile.preview', '--release-version', '0.1.0'] },
      { platform: 'android', directory: path.join(dist, '_expo/static/js/android'),
        args: ['hermes', 'upload', '--directory', path.join(dist, '_expo/static/js/android'), '--release-mode', 'event', '--release-name', 'dev.talyn.mobile.preview', '--release-version', '0.1.0'] },
    ]);
  });

  it.each([
    ['one platform', { fileMetadata: { android: { bundle: '_expo/static/js/android/entry.hbc' } } }, ['android']],
    ['no platforms', { fileMetadata: {} }, []],
    ['no file metadata', {}, []],
    ['null metadata', null, []],
    ['web only', { fileMetadata: { web: { bundle: '_expo/static/js/web/entry.js' } } }, []],
    ['an empty bundle path', { fileMetadata: { ios: { bundle: '' } } }, []],
    ['a non-string bundle path', { fileMetadata: { ios: { bundle: 42 } } }, []],
  ])('with %s', (_name, metadata, platforms) => {
    expect(hermesUploadPlan(dist, metadata, EXP).map((step: { platform: string }) => step.platform)).toEqual(platforms);
  });

  it('leaves out release coordinates the config does not have', () => {
    const [step] = hermesUploadPlan(dist, { fileMetadata: { ios: { bundle: 'a/entry.hbc' } } }, {});
    expect(step.args).toEqual(['hermes', 'upload', '--directory', path.join(dist, 'a'), '--release-mode', 'event']);
  });

  it.each([
    ['a parent path', '../../etc/entry.hbc'],
    ['an absolute path', '/etc/entry.hbc'],
    ['the export root itself', 'entry.hbc'],
  ])('refuses %s', (_name, bundle) => {
    expect(() => hermesUploadPlan(dist, { fileMetadata: { ios: { bundle } } }, EXP)).toThrow('leaves the export directory');
  });
});

describe('uploadUpdateSourceMaps', () => {
  const okRun = () => jest.fn(() => ({ status: 0, stdout: '', stderr: '' }));

  it('skips with a notice when no key is set, and never runs the CLI', () => {
    const run = okRun();
    const results = uploadUpdateSourceMaps({ env: { POSTHOG_CLI_PATH: '/cli.js' }, root: exportedRoot(), exp: EXP, channel: 'preview', run });
    expect(results).toEqual([{ level: 'notice', message: expect.stringContaining('POSTHOG_CLI_API_KEY is not set') }]);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ['a malformed key', { POSTHOG_CLI_API_KEY: 'phc_project', POSTHOG_CLI_PATH: '/cli.js' }, METADATA, 'phx_'],
    ['no CLI path', { POSTHOG_CLI_API_KEY: KEY }, METADATA, 'POSTHOG_CLI_PATH is not set'],
    ['no metadata.json', { POSTHOG_CLI_API_KEY: KEY, POSTHOG_CLI_PATH: '/cli.js' }, NO_METADATA, 'Could not read the exported bundles'],
    ['an unreadable metadata.json', { POSTHOG_CLI_API_KEY: KEY, POSTHOG_CLI_PATH: '/cli.js' }, '{not json', 'Could not read the exported bundles'],
    ['an unsafe bundle path', { POSTHOG_CLI_API_KEY: KEY, POSTHOG_CLI_PATH: '/cli.js' }, { fileMetadata: { ios: { bundle: '../x.hbc' } } }, 'leaves the export directory'],
    ['no native bundle', { POSTHOG_CLI_API_KEY: KEY, POSTHOG_CLI_PATH: '/cli.js' }, { fileMetadata: {} }, 'no iOS or Android bundle'],
  ])('warns and uploads nothing with %s', (_name, env, metadata, text) => {
    const run = okRun();
    const results = uploadUpdateSourceMaps({ env, root: exportedRoot(metadata), exp: EXP, channel: 'preview', run });
    expect(results).toEqual([{ level: 'warning', message: expect.stringContaining(text) }]);
    expect(results[0].message).toContain('No source maps were uploaded.');
    expect(run).not.toHaveBeenCalled();
  });

  it('uploads each platform with the credentials and without the Expo token', () => {
    const run = okRun();
    const root = exportedRoot();
    const env = { POSTHOG_CLI_API_KEY: KEY, POSTHOG_CLI_PATH: '/cli.js', EXPO_TOKEN: 'expo-secret', PATH: '/bin', POSTHOG_RELEASE_MODE: 'symbol-set' };
    const results = uploadUpdateSourceMaps({ env, root, exp: EXP, channel: 'preview', run });
    expect(results).toEqual([
      { level: 'notice', message: 'preview ios: uploaded the Hermes source maps to PostHog.' },
      { level: 'notice', message: 'preview android: uploaded the Hermes source maps to PostHog.' },
    ]);
    expect(run).toHaveBeenCalledTimes(2);
    const [cliPath, args, cliEnv] = run.mock.calls[0] as unknown as [string, string[], Record<string, string>];
    expect(cliPath).toBe('/cli.js');
    expect(args.slice(0, 4)).toEqual(['hermes', 'upload', '--directory', path.join(root, 'dist/_expo/static/js/ios')]);
    expect(cliEnv).toMatchObject({ ...CREDENTIALS, PATH: '/bin', POSTHOG_RELEASE_MODE: 'event' });
    expect(cliEnv).not.toHaveProperty('EXPO_TOKEN');
  });

  it.each([
    ['a non-zero exit', { status: 1, stdout: 'line 1\nline 2', stderr: 'Error: 401 Unauthorized' }, '401 Unauthorized'],
    ['a timeout', { status: null, error: new Error('spawnSync ETIMEDOUT'), stdout: '', stderr: '' }, 'ETIMEDOUT'],
  ])('reports %s as a warning per platform and never throws', (_name, outcome, text) => {
    const run = jest.fn().mockReturnValueOnce(outcome).mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });
    const results = uploadUpdateSourceMaps({ env: { POSTHOG_CLI_API_KEY: KEY, POSTHOG_CLI_PATH: '/cli.js' }, root: exportedRoot(), exp: EXP, channel: 'internal-beta', run });
    expect(results[0]).toEqual({ level: 'warning', message: expect.stringContaining('internal-beta ios: the PostHog source map upload failed') });
    expect(results[0].message).toContain(text);
    expect(results[1].level).toBe('notice');
  });
});

describe('easInstallPlan', () => {
  it.each([
    ['outside EAS', { EAS_BUILD_PROFILE: 'preview', POSTHOG_CLI_API_KEY: KEY }, 'not an EAS build'],
    ['for the development client', { EAS_BUILD: 'true', EAS_BUILD_PROFILE: 'development', POSTHOG_CLI_API_KEY: KEY }, 'development client'],
    ['with no profile', { EAS_BUILD: 'true', POSTHOG_CLI_API_KEY: KEY }, 'development client'],
    ['with no key', { EAS_BUILD: 'true', EAS_BUILD_PROFILE: 'production' }, 'POSTHOG_CLI_API_KEY is not set in the EAS environment'],
  ])('skips %s', (_name, env, reason) => {
    expect(easInstallPlan(env)).toEqual({ install: false, reason: expect.stringContaining(reason) });
  });

  it.each(['preview', 'internal-beta', 'production'])('installs the pinned CLI globally for %s', (profile) => {
    expect(easInstallPlan({ EAS_BUILD: 'true', EAS_BUILD_PROFILE: profile, POSTHOG_CLI_API_KEY: KEY }))
      .toEqual({ install: true, args: ['install', '--global', '--no-audit', '--no-fund', `@posthog/cli@${posthogCli}`] });
  });

  it('refuses a malformed key rather than building without uploads', () => {
    expect(() => easInstallPlan({ EAS_BUILD: 'true', EAS_BUILD_PROFILE: 'preview', POSTHOG_CLI_API_KEY: 'phc_x' })).toThrow('phx_');
  });
});

describe('runEasInstall', () => {
  let log: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => { log.mockRestore(); error.mockRestore(); });

  it('skips without running npm, and succeeds', () => {
    const spawn = jest.fn();
    expect(runEasInstall({ EAS_BUILD: 'true', EAS_BUILD_PROFILE: 'preview' }, spawn)).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('PostHog symbol upload skipped'));
  });

  it('fails for a malformed key without running npm', () => {
    const spawn = jest.fn();
    expect(runEasInstall({ EAS_BUILD: 'true', EAS_BUILD_PROFILE: 'preview', POSTHOG_CLI_API_KEY: 'phc_x' }, spawn)).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    [0, 0],
    [1, 1],
    [null, 1],
  ])('runs npm without the key and returns its status (%s → %s)', (status, expected) => {
    const spawn = jest.fn(() => ({ status }));
    expect(runEasInstall({ EAS_BUILD: 'true', EAS_BUILD_PROFILE: 'production', POSTHOG_CLI_API_KEY: KEY, PATH: '/bin' }, spawn)).toBe(expected);
    const [command, args, options] = spawn.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
    expect(command).toBe('npm');
    expect(args).toContain(`@posthog/cli@${posthogCli}`);
    expect(options.env).toEqual({ EAS_BUILD: 'true', EAS_BUILD_PROFILE: 'production', PATH: '/bin' });
  });
});

describe('the publish keeps the PostHog key away from EAS', () => {
  it('drops the key from the environment eas update runs with', () => {
    const env = publishEnvironment({ PATH: '/bin', POSTHOG_CLI_API_KEY: KEY }, {}, 'preview');
    expect(env).not.toHaveProperty('POSTHOG_CLI_API_KEY');
    expect(env.PATH).toBe('/bin');
  });
});

describe('the PostHog CLI pin', () => {
  const text = fs.readFileSync(path.join(__dirname, '../../../../.github/workflows/mobile-update.yml'), 'utf8');
  it('matches release/toolchain.json in both workflows', () => {
    const release = fs.readFileSync(path.join(__dirname, '../../../../.github/workflows/mobile-release.yml'), 'utf8');
    for (const workflow of [text, release]) expect(workflow).toContain(`@posthog/cli@${posthogCli}`);
  });
  it('fails the update workflow check when it drifts', () => {
    expect(() => checkUpdateWorkflow(text.replace(`@posthog/cli@${posthogCli}`, '@posthog/cli@0.0.1'), yaml)).toThrow('PostHog CLI pin');
  });
});
