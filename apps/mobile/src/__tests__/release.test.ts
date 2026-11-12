import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import appConfig from '../../app.config';

const { readReleaseSettings, profiles } = require('../../release/policy.cjs');
const { releasePlan, assertExecution, assertRuntime, assertBuild, assertChannel } = require('../../scripts/release.cjs');
const { checkMetadata, checkUnsignedUpdates, checkUpdateWorkflow } = require('../../scripts/check-release.cjs');
const { autoUpdatePlan, assertAutoExecution, parseDotenv, publishEnvironment, assertUpdateConfig, redact } = require('../../scripts/publish-update.cjs');
const yaml = require('js-yaml');
const metadata = require('../../release/store-metadata.json');

// These values are inert fixtures. They are never used for a hosted build.
const fixture = {
  APP_ENV: 'production', MOBILE_RELEASE_PROFILE: 'production', MOBILE_BUILD_NUMBER: '42',
  TALYN_MOBILE_IOS_BUNDLE_ID: 'org.fixture.mobile', TALYN_MOBILE_ANDROID_PACKAGE: 'org.fixture.mobile', TALYN_MOBILE_SCHEME: 'fixture-mobile',
  EXPO_PUBLIC_EAS_PROJECT_ID: '10000000-0000-4000-8000-000000000001',
  EXPO_PUBLIC_API_ORIGIN: 'https://api.fixture.dev', EXPO_PUBLIC_SUPABASE_URL: 'https://auth.fixture.dev',
  EXPO_PUBLIC_SUPABASE_KEY: 'sb_publishable_fixture', EXPO_PUBLIC_AUTH_CALLBACK_URL: 'https://mobile.fixture.dev/callback',
  TALYN_MOBILE_SUPPORT_URL: 'https://fixture.dev/support', TALYN_MOBILE_PRIVACY_URL: 'https://fixture.dev/privacy', TALYN_MOBILE_DELETION_URL: 'https://fixture.dev/delete',
};

const enabled = () => ({ MOBILE_UPDATES_ENABLED: '1' });

describe('release configuration boundaries', () => {
  const previous = process.env;
  afterEach(() => { process.env = previous; });
  it.each(Object.keys(profiles))('resolves the %s profile with a fingerprint runtime', (profile: string) => {
    const environment = profiles[profile].environment;
    process.env = { ...previous, ...fixture, APP_ENV: environment, MOBILE_RELEASE_PROFILE: profile };
    const result = appConfig({ config: {} } as Parameters<typeof appConfig>[0]);
    expect(result.runtimeVersion).toEqual({ policy: 'fingerprint' });
    expect(result.version).toBe(require('../../package.json').version);
    expect(result.ios?.buildNumber).toBe('42'); expect(result.android?.versionCode).toBe(42);
    expect(result.updates?.enabled).toBe(false);
    expect(result.extra?.release.profile).toBe(profile);
    expect(result.plugins).toContainEqual(['expo-notifications', { mode: profile === 'development' ? 'development' : 'production', enableBackgroundRemoteNotifications: false,
      icon: './assets/notification-icon.png', color: '#a94d2e' }]);
    expect(result.android?.intentFilters?.[0].data).toContainEqual({ scheme: 'https', host: 'mobile.fixture.dev', pathPrefix: '/sessions/' });
  });
  it.each(['MOBILE_BUILD_NUMBER', 'TALYN_MOBILE_SUPPORT_URL', 'TALYN_MOBILE_PRIVACY_URL', 'TALYN_MOBILE_DELETION_URL'])('blocks a store build without %s', (key) => {
    expect(() => readReleaseSettings({ ...fixture, [key]: undefined }, 'production', fixture.EXPO_PUBLIC_EAS_PROJECT_ID)).toThrow();
  });
  it.each(['0', '-1', '1.1', '01', 'NaN', '2100000001', '1000000000'])('rejects invalid build number %s', (build) => {
    expect(() => readReleaseSettings({ ...fixture, MOBILE_BUILD_NUMBER: build }, 'production')).toThrow();
  });
  it.each(['http://fixture.dev', 'https://example.com', 'https://localhost', 'https://user:pass@fixture.dev', 'https://fixture.dev?key=value'])('rejects an unsafe store URL %s', (url) => {
    expect(() => readReleaseSettings({ ...fixture, TALYN_MOBILE_PRIVACY_URL: url }, 'production')).toThrow();
  });
  it('blocks a mismatched environment and profile', () => {
    expect(() => readReleaseSettings(fixture, 'preview')).toThrow('must match');
  });
  it.each(Object.keys(profiles))('ignores the Expo internal project root for %s configuration', (profile: string) => {
    process.env = { ...previous, ...fixture, APP_ENV: profiles[profile].environment, MOBILE_RELEASE_PROFILE: profile };
    const expected = appConfig({ config: {} } as Parameters<typeof appConfig>[0]);
    process.env.EXPO_PUBLIC_PROJECT_ROOT = path.resolve(__dirname, '../..');
    expect(appConfig({ config: {} } as Parameters<typeof appConfig>[0])).toEqual(expected);
  });
  it.each(['EXPO_PUBLIC_SERVICE_ROLE_KEY', 'EXPO_PUBLIC_PROJECT_ROOT_EXTRA'])('rejects unreviewed public build variable %s', (name) => {
    expect(() => readReleaseSettings({ ...fixture, EXPO_PUBLIC_PROJECT_ROOT: path.resolve(__dirname, '../..'), [name]: 'fixture' }, 'production')).toThrow('unexpected public');
  });
  it.each(['yes', 'true', ' 1'])('rejects the malformed update switch %p', (value) => {
    expect(() => readReleaseSettings({ ...fixture, MOBILE_UPDATES_ENABLED: value }, 'production', fixture.EXPO_PUBLIC_EAS_PROJECT_ID)).toThrow('Use 0 or 1');
  });
  // Leftover signing settings must not reach a binary: a certificate there rejects every unsigned update.
  it.each([
    { MOBILE_UPDATE_CERTIFICATE: './release/update-certificate.pem' },
    { MOBILE_UPDATE_KEY_ID: 'main' },
    { MOBILE_UPDATE_CERTIFICATE: './release/update-certificate.pem', MOBILE_UPDATE_KEY_ID: 'main' },
  ])('configures no code signing with leftover %j', (patch) => {
    const result = readReleaseSettings({ ...fixture, ...enabled(), ...patch }, 'production', fixture.EXPO_PUBLIC_EAS_PROJECT_ID);
    expect(result.updates).toMatchObject({ enabled: true });
    expect(result.updates).not.toHaveProperty('codeSigningCertificate');
    expect(result.updates).not.toHaveProperty('codeSigningMetadata');
  });
  it('keeps the development client on Metro', () => {
    expect(() => readReleaseSettings({ ...fixture, ...enabled(), APP_ENV: 'development', MOBILE_RELEASE_PROFILE: 'development' }, 'development', fixture.EXPO_PUBLIC_EAS_PROJECT_ID)).toThrow('Metro');
  });
  it.each(Object.keys(profiles).filter((name) => profiles[name].updates))('configures unsigned updates for %s', (profile: string) => {
    // An empty value is how an unset GitHub variable arrives.
    process.env = { ...previous, ...fixture, ...enabled(), APP_ENV: profiles[profile].environment, MOBILE_RELEASE_PROFILE: profile, EXPO_PUBLIC_EAS_PROJECT_ID: '' };
    const result = appConfig({ config: {} } as Parameters<typeof appConfig>[0]);
    expect(result.owner).toBe('talyn-app');
    expect(result.updates).toEqual({
      enabled: true, url: 'https://u.expo.dev/69499768-c478-44c0-8588-355c674515df', checkAutomatically: 'ON_ERROR_RECOVERY',
      requestHeaders: { 'expo-channel-name': profiles[profile].channel }, fallbackToCacheTimeout: 0, useEmbeddedUpdate: true,
    });
    expect(result.runtimeVersion).toEqual({ policy: 'fingerprint' });
  });
  it('enables updates in eas.json for exactly the profiles the policy names', () => {
    const eas = require('../../eas.json');
    for (const [name, policy] of Object.entries(profiles) as [string, { updates: boolean }][]) {
      expect(eas.build[name].env.MOBILE_UPDATES_ENABLED).toBe(policy.updates ? '1' : '0');
    }
    expect(Object.keys(profiles).filter((name) => profiles[name].autoUpdate)).toEqual(['preview', 'internal-beta']);
  });
  it('keeps store templates incomplete until owner approval', () => {
    expect(() => checkMetadata(metadata)).not.toThrow(); expect(() => checkMetadata(metadata, true)).toThrow();
  });
});

describe('release execution safeguards', () => {
  it.each(Object.keys(profiles))('plans a build for %s without credentials', (profile: string) => {
    expect(releasePlan('build', profile, 'ios', {}).args).toContain('--non-interactive');
  });
  it.each(['preview', 'development'])('blocks store submission for %s', (profile) => {
    expect(() => releasePlan('submit', profile, 'android', {})).toThrow();
  });
  it('requires an exact build, platform, profile, and action', () => {
    expect(() => releasePlan('submit', 'production', 'ios', {})).toThrow('MOBILE_BUILD_ID');
    expect(() => releasePlan('build', 'prod', 'ios', {})).toThrow();
    expect(() => releasePlan('build', 'production', 'all', {})).toThrow();
    expect(() => releasePlan('publish', 'production', 'ios', {})).toThrow();
  });
  const updateEnv = { MOBILE_UPDATES_ENABLED: '1', MOBILE_RUNTIME_VERSION: 'a'.repeat(40) };
  it('rejects a changed native fingerprint before publication', () => {
    expect(() => assertRuntime('a'.repeat(40), 'b'.repeat(40))).toThrow('Build a new binary');
    expect(() => assertRuntime(undefined, undefined)).toThrow();
    expect(() => assertRuntime('a'.repeat(40), 'a'.repeat(40))).not.toThrow();
  });
  it.each(['name', 'isPaused', 'updateBranches', 'branchMapping'])('blocks unsafe channel field %s', (field) => {
    const channel = { name: 'production', isPaused: false, updateBranches: [{ id: 'branch-one', name: 'production' }], branchMapping: JSON.stringify({ version: 0, data: [{ branchId: 'branch-one', branchMappingLogic: 'true' }] }) };
    expect(() => assertChannel({ currentPage: channel }, 'production')).not.toThrow();
    expect(() => assertChannel({ currentPage: { ...channel, [field]: null } }, 'production')).toThrow();
  });
  it.each(['status', 'platform', 'buildProfile', 'appIdentifier', 'gitCommitHash', 'appVersion', 'appBuildVersion', 'runtime', 'updateChannel'])('rejects a mismatched hosted build %s', (field) => {
    const build = { status: 'FINISHED', platform: 'IOS', buildProfile: 'production', appIdentifier: fixture.TALYN_MOBILE_IOS_BUNDLE_ID,
      gitCommitHash: 'a'.repeat(40), appVersion: '0.1.0', appBuildVersion: '42', runtime: { version: 'b'.repeat(40) }, updateChannel: { name: 'production' } };
    const env = { MOBILE_RELEASE_SHA: 'a'.repeat(40), MOBILE_BUILD_NUMBER: '42', MOBILE_RUNTIME_VERSION: 'b'.repeat(40) };
    const exp = { version: '0.1.0', ios: { bundleIdentifier: fixture.TALYN_MOBILE_IOS_BUNDLE_ID } };
    const submitPlan = { platform: 'ios', profile: 'production', policy: profiles.production };
    expect(() => assertBuild(build, submitPlan, env, exp)).not.toThrow();
    expect(() => assertBuild({ ...build, [field]: null }, submitPlan, env, exp)).toThrow();
  });
  it.each(['update', 'rollback'])('targets only one compatible platform for %s', (action) => {
    const plan = releasePlan(action, 'internal-beta', 'android', updateEnv);
    expect(plan.args).toContain('internal-beta'); expect(plan.args).toContain('android');
    if (action === 'rollback') expect(plan.args).toContain('a'.repeat(40));
    expect(() => releasePlan(action, 'production', 'ios', { ...updateEnv, MOBILE_RUNTIME_VERSION: 'incompatible' })).toThrow();
    expect(() => releasePlan(action, 'production', 'ios', { ...updateEnv, MOBILE_UPDATES_ENABLED: '0' })).toThrow();
  });
  const plan = releasePlan('build', 'production', 'ios', {});
  const sha = 'a'.repeat(40);
  const approvalEnv = { CI: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', MOBILE_RELEASE_APPROVED: 'true', MOBILE_RELEASE_ENVIRONMENT: 'mobile-production', MOBILE_RELEASE_SHA: sha, EXPO_TOKEN: 'fixture' };
  const git = (args: string[]) => args[0] === 'rev-parse' ? sha : '';
  it.each(Object.keys(approvalEnv))('blocks execution when approval context %s is missing', (key) => {
    expect(() => assertExecution(plan, { ...approvalEnv, [key]: undefined }, git)).toThrow();
  });
  it.each(['pull_request', 'pull_request_target', 'push'])('blocks %s execution', (event) => {
    expect(() => assertExecution(plan, { ...approvalEnv, GITHUB_EVENT_NAME: event }, git)).toThrow();
  });
  it('blocks an untested commit and missing evidence', () => {
    expect(() => assertExecution(plan, approvalEnv, () => 'different')).toThrow();
    expect(() => assertExecution(plan, approvalEnv, git)).toThrow();
  });
  it('requires every store approval and candidate identity', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-release-test-'));
    try {
      const file = path.join(dir, 'evidence.json');
      const evidence = { ...require('../../release/evidence.template.json'), sourceCommit: sha, profile: 'production', platform: 'ios', buildNumber: '42', runtimeVersion: 'a'.repeat(40) };
      const env = { ...approvalEnv, MOBILE_RELEASE_EVIDENCE_PATH: file, MOBILE_BUILD_NUMBER: '42', MOBILE_RUNTIME_VERSION: 'a'.repeat(40) };
      fs.writeFileSync(file, JSON.stringify(evidence)); expect(() => assertExecution(plan, env, git)).toThrow();
      for (const key of Object.keys(evidence.approvals)) evidence.approvals[key] = 'fixture approval reference';
      fs.writeFileSync(file, JSON.stringify(evidence)); expect(assertExecution(plan, env, git)).toBe(true);
      expect(() => assertExecution(plan, { ...env, MOBILE_BUILD_NUMBER: '43' }, git)).toThrow();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('requires complete metadata, inspected checksums, and the exact build for submission', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-submit-test-'));
    try {
      const evidenceFile = path.join(dir, 'evidence.json'); const metadataFile = path.join(dir, 'metadata.json');
      const snapshot = structuredClone(metadata);
      for (const platform of ['apple', 'google']) {
        for (const key of Object.keys(snapshot[platform])) snapshot[platform][key] = 'Fixture';
        Object.assign(snapshot[platform], { supportUrl: 'https://fixture.dev/support', privacyUrl: 'https://fixture.dev/privacy', deletionUrl: 'https://fixture.dev/delete', countries: ['US'], assets: ['fixture.png'] });
      }
      const bytes = JSON.stringify(snapshot); fs.writeFileSync(metadataFile, bytes);
      const evidence = { ...require('../../release/evidence.template.json'), sourceCommit: sha, profile: 'production', platform: 'android', buildNumber: '42', runtimeVersion: 'b'.repeat(40), buildId: fixture.EXPO_PUBLIC_EAS_PROJECT_ID, artifactSha256: 'c'.repeat(64) };
      for (const key of Object.keys(evidence.approvals)) evidence.approvals[key] = 'Fixture approval reference';
      const env = { ...approvalEnv, MOBILE_RELEASE_EVIDENCE_PATH: evidenceFile, MOBILE_STORE_METADATA_PATH: metadataFile, MOBILE_BUILD_NUMBER: '42', MOBILE_RUNTIME_VERSION: 'b'.repeat(40), MOBILE_BUILD_ID: fixture.EXPO_PUBLIC_EAS_PROJECT_ID };
      const submit = releasePlan('submit', 'production', 'android', env);
      fs.writeFileSync(evidenceFile, JSON.stringify(evidence)); expect(() => assertExecution(submit, env, git)).toThrow('checksums');
      evidence.metadataSha256 = createHash('sha256').update(bytes).digest('hex');
      fs.writeFileSync(evidenceFile, JSON.stringify(evidence)); expect(assertExecution(submit, env, git)).toBe(true);
      expect(() => assertExecution(submit, { ...env, MOBILE_STORE_METADATA_PATH: undefined }, git)).toThrow('MOBILE_STORE_METADATA_PATH');
      expect(() => assertExecution(submit, { ...env, MOBILE_BUILD_ID: 'different' }, git)).toThrow('inspected build');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('unsigned updates', () => {
  const read = (file: string) => fs.readFileSync(path.resolve(__dirname, '../../../..', file), 'utf8');
  const workflows = () => [read('.github/workflows/mobile-release.yml'), read('.github/workflows/mobile-update.yml')];
  it('passes as committed', () => { expect(() => checkUnsignedUpdates(workflows())).not.toThrow(); });
  it.each([
    '          KEY: ${{ secrets.MOBILE_UPDATE_PRIVATE_KEY_PEM }}',
    '          CERT: ${{ secrets.MOBILE_UPDATE_CERTIFICATE_PEM }}',
    '        run: eas update --private-key-path key.pem',
    '          cp cert apps/mobile/release/update-certificate.pem',
  ])('rejects a workflow that signs with %p', (line) => {
    const [release, update] = workflows();
    expect(() => checkUnsignedUpdates([release, `${update}\n${line}\n`])).toThrow('unsigned');
  });
  it.each(['update', 'rollback'])('plans an unsigned %s', (action) => {
    expect(releasePlan(action, 'preview', 'ios', { MOBILE_UPDATES_ENABLED: '1', MOBILE_RUNTIME_VERSION: 'a'.repeat(40) }).args).not.toContain('--private-key-path');
  });
});

describe('automatic update workflow', () => {
  const text = fs.readFileSync(path.resolve(__dirname, '../../../../.github/workflows/mobile-update.yml'), 'utf8');
  it('passes as committed', () => { expect(() => checkUpdateWorkflow(text, yaml)).not.toThrow(); });
  it.each<[string, string, string]>([
    ['the fork guard', "github.repository == 'Gilbert09/talyn' && ", ''],
    ['the kill switch', " && (vars.MOBILE_UPDATES_AUTO || '1') != '0'", ''],
    ['a kill switch that skips when unset', "(vars.MOBILE_UPDATES_AUTO || '1') != '0'", "vars.MOBILE_UPDATES_AUTO != '0' && (vars.MOBILE_UPDATES_AUTO || '1') != '0'"],
    ['ordered publishes', 'cancel-in-progress: false', 'cancel-in-progress: true'],
    ['the internal-beta publish', 'publish-update.cjs internal-beta --execute', 'publish-update.cjs preview --execute'],
    ['a direct production publish', 'publish-update.cjs internal-beta --execute', 'publish-update.cjs internal-beta --execute && eas update --channel production'],
    ['the pinned EAS CLI', 'eas-cli@27.5.0', 'eas-cli@latest'],
    ['a PR trigger', 'workflow_dispatch:', 'workflow_dispatch:\n  pull_request:'],
  ])('rejects a workflow without %s', (_name, from, to) => {
    expect(text.includes(from)).toBe(true);
    expect(() => checkUpdateWorkflow(text.replace(from, to), yaml)).toThrow();
  });
});

describe('automatic update publication', () => {
  const sha = 'c'.repeat(40);
  const ciEnv = { CI: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push', GITHUB_SHA: sha, EXPO_TOKEN: 'fixture', MOBILE_EAS_CLI_PATH: '/fixture/eas' };
  const git = (args: string[]) => args[0] === 'rev-parse' ? sha : '';
  const planEnv = { MOBILE_UPDATE_MESSAGE: 'feat: fixture (ccccccc)' };

  it.each([['preview', 'preview'], ['internal-beta', 'production']])('publishes %s with its EAS environment and every platform', (profile, environment) => {
    const { args } = autoUpdatePlan(profile, planEnv);
    expect(args).toEqual(['update', '--channel', profile, '--environment', environment, '--platform', 'all',
      '--message', planEnv.MOBILE_UPDATE_MESSAGE, '--non-interactive', '--json']);
    expect(args).not.toContain('--runtime-version');
    expect(args).not.toContain('--private-key-path');
  });
  it.each(['production', 'development', 'prod', undefined])('refuses an automatic publish to %s', (profile) => {
    expect(() => autoUpdatePlan(profile, planEnv)).toThrow('Automatic updates publish only to preview and internal-beta');
  });
  it('requires a message', () => {
    expect(() => autoUpdatePlan('preview', {})).toThrow('MOBILE_UPDATE_MESSAGE');
  });
  it.each(['push', 'workflow_dispatch'])('allows %s on main', (event) => {
    expect(assertAutoExecution({ ...ciEnv, GITHUB_EVENT_NAME: event }, git)).toBe(true);
  });
  it.each<[string, Record<string, string | undefined>]>([
    ['outside CI', { CI: undefined }],
    ['another branch', { GITHUB_REF: 'refs/heads/feature' }],
    ['a pull request', { GITHUB_EVENT_NAME: 'pull_request' }],
    ['a pull_request_target run', { GITHUB_EVENT_NAME: 'pull_request_target' }],
    ['the kill switch', { MOBILE_UPDATES_AUTO: '0' }],
    ['no Expo token', { EXPO_TOKEN: undefined }],
    ['no EAS CLI', { MOBILE_EAS_CLI_PATH: undefined }],
    ['a malformed commit', { GITHUB_SHA: 'main' }],
  ])('blocks execution for %s', (_name, patch) => {
    expect(() => assertAutoExecution({ ...ciEnv, ...patch }, git)).toThrow();
  });
  it.each<[string, (args: string[]) => string]>([
    ['a different commit', (args) => args[0] === 'rev-parse' ? 'd'.repeat(40) : ''],
    ['a dirty checkout', (args) => args[0] === 'rev-parse' ? sha : ' M apps/mobile/app.config.ts'],
  ])('blocks execution from %s', (_name, gitFake) => {
    expect(() => assertAutoExecution(ciEnv, gitFake)).toThrow('clean checkout');
  });

  it('reads the pulled EAS environment file', () => {
    expect(parseDotenv('# Environment: preview\n\nEXPO_PUBLIC_API_ORIGIN=https://api.fixture.dev\n# SECRET=***** (secret)\nQUOTED="a=b"\nbad line\n'))
      .toEqual({ EXPO_PUBLIC_API_ORIGIN: 'https://api.fixture.dev', QUOTED: 'a=b' });
  });
  it.each(['preview', 'internal-beta'])('evaluates %s as its binary does', (profile) => {
    const env = publishEnvironment({ PATH: '/bin', EAS_BUILD_PROFILE: 'production' },
      { EXPO_PUBLIC_API_ORIGIN: 'https://api.fixture.dev', TALYN_MOBILE_SCHEME: 'fixture', UNRELATED: 'x', MOBILE_UPDATES_ENABLED: '1' }, profile);
    expect(env).toMatchObject({ PATH: '/bin', APP_ENV: profiles[profile].environment, MOBILE_RELEASE_PROFILE: profile, MOBILE_UPDATES_ENABLED: '1',
      EXPO_PUBLIC_API_ORIGIN: 'https://api.fixture.dev', TALYN_MOBILE_SCHEME: 'fixture' });
    expect(env.EAS_BUILD_PROFILE).toBeUndefined();
    expect(env.UNRELATED).toBeUndefined();
  });
  it.each(['0', 'off'])('refuses a publish when EAS sets the update switch to %s', (value) => {
    expect(() => publishEnvironment({}, { MOBILE_UPDATES_ENABLED: value }, 'preview')).toThrow('eas.json owns the switch');
  });
  it('drops leftover signing values pulled from EAS', () => {
    const env = publishEnvironment({}, { MOBILE_UPDATE_KEY_ID: 'main', MOBILE_UPDATE_CERTIFICATE: './release/update-certificate.pem' }, 'preview');
    expect(env.MOBILE_UPDATE_KEY_ID).toBeUndefined();
    expect(env.MOBILE_UPDATE_CERTIFICATE).toBeUndefined();
  });

  const exp = { extra: { eas: { projectId: '69499768-c478-44c0-8588-355c674515df' } }, updates: {
    enabled: true, url: 'https://u.expo.dev/69499768-c478-44c0-8588-355c674515df', checkAutomatically: 'ON_ERROR_RECOVERY',
    requestHeaders: { 'expo-channel-name': 'preview' } } };
  it('accepts the configuration of an unsigned preview binary', () => { expect(() => assertUpdateConfig(exp, 'preview')).not.toThrow(); });
  it.each<[string, Record<string, unknown>]>([
    ['updates off', { enabled: false }],
    ['another project URL', { url: 'https://u.expo.dev/10000000-0000-4000-8000-000000000001' }],
    ['native automatic checks', { checkAutomatically: 'ON_LOAD' }],
    ['another channel', { requestHeaders: { 'expo-channel-name': 'production' } }],
  ])('refuses a configuration with %s', (_name, patch) => {
    expect(() => assertUpdateConfig({ ...exp, updates: { ...exp.updates, ...patch } }, 'preview')).toThrow('does not enable updates');
  });
  it.each<[string, Record<string, unknown>]>([
    ['a certificate', { codeSigningCertificate: './release/update-certificate.pem' }],
    ['signing metadata', { codeSigningMetadata: { keyid: 'main', alg: 'rsa-v1_5-sha256' } }],
  ])('refuses a configuration with %s', (_name, patch) => {
    expect(() => assertUpdateConfig({ ...exp, updates: { ...exp.updates, ...patch } }, 'preview')).toThrow('Updates are unsigned');
  });
  it('keeps signed URLs and long tokens out of logs', () => {
    const text = redact(`GET https://storage.fixture.dev/a.js?X-Amz-Signature=abc failed with ${'t'.repeat(48)}`);
    expect(text).toBe('GET [signed URL removed] failed with [long value removed]');
  });
});
