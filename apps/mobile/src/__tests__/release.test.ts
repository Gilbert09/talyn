import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import appConfig from '../../app.config';

const { readReleaseSettings, profiles } = require('../../release/policy.cjs');
const { releasePlan, assertExecution, assertRuntime, assertBuild, assertChannel } = require('../../scripts/release.cjs');
const { checkMetadata } = require('../../scripts/check-release.cjs');
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
    expect(result.plugins).toContainEqual(['expo-notifications', { mode: profile === 'development' ? 'development' : 'production', enableBackgroundRemoteNotifications: false }]);
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
  it('rejects unreviewed public build variables', () => {
    expect(() => readReleaseSettings({ ...fixture, EXPO_PUBLIC_SERVICE_ROLE_KEY: 'fixture' }, 'production')).toThrow('unexpected public');
  });
  it.each(['MOBILE_UPDATE_CERTIFICATE', 'MOBILE_UPDATE_KEY_ID'])('blocks signed updates without %s', (key) => {
    expect(() => readReleaseSettings({ ...fixture, MOBILE_UPDATES_ENABLED: '1', MOBILE_UPDATE_CERTIFICATE: 'fixture.pem', MOBILE_UPDATE_KEY_ID: 'fixture', [key]: undefined }, 'production', fixture.EXPO_PUBLIC_EAS_PROJECT_ID)).toThrow();
  });
  it('configures signed updates with an embedded fallback', () => {
    const result = readReleaseSettings({ ...fixture, MOBILE_UPDATES_ENABLED: '1', MOBILE_UPDATE_CERTIFICATE: './fixture.pem', MOBILE_UPDATE_KEY_ID: 'fixture' }, 'production', fixture.EXPO_PUBLIC_EAS_PROJECT_ID);
    expect(result.updates).toMatchObject({ enabled: true, useEmbeddedUpdate: true, fallbackToCacheTimeout: 0,
      codeSigningMetadata: { keyid: 'fixture', alg: 'rsa-v1_5-sha256' } });
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
  const updateEnv = { MOBILE_UPDATES_ENABLED: '1', MOBILE_RUNTIME_VERSION: 'a'.repeat(40), MOBILE_UPDATE_PRIVATE_KEY_PATH: '/fixture/key.pem' };
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
