// Builds the iOS internal-beta binary and submits it to TestFlight from a push to main.
// It builds only when the iOS native fingerprint has no internal-beta build yet. A change with the same fingerprint
// reaches testers as an EAS update, so a new binary would only use the EAS build quota.
// The guarded wrapper in release.cjs needs a reserved build number and an approval record, which a push cannot supply.
// This path reserves the next build number itself, in the EAS production environment that the build reads.
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { profiles, required } = require('../release/policy.cjs');
const { easOrThrow, pullEnvironment, redact, summarize } = require('./publish-update.cjs');

const root = path.resolve(__dirname, '..');
const PROFILE = 'internal-beta';
const PLATFORM = 'ios';
const policy = profiles[PROFILE];
const STORE_PROFILES = Object.keys(profiles).filter((name) => profiles[name].store);
// A build in one of these states already covers its fingerprint.
const LIVE_STATUSES = ['NEW', 'IN_QUEUE', 'IN_PROGRESS', 'FINISHED'];
const SELECTORS = ['APP_ENV', 'MOBILE_RELEASE_PROFILE', 'EAS_BUILD_PROFILE', 'MOBILE_UPDATES_ENABLED', 'MOBILE_BUILD_NUMBER'];

function assertTestflightExecution(env, git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()) {
  if (env.CI !== 'true' || env.GITHUB_REF !== 'refs/heads/main' || !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME ?? '')) {
    throw new Error('Automatic TestFlight builds run only from the Mobile TestFlight workflow on main.');
  }
  if (env.MOBILE_TESTFLIGHT_AUTO === '0') throw new Error('MOBILE_TESTFLIGHT_AUTO is 0. Automatic TestFlight builds are off.');
  for (const name of ['EXPO_TOKEN', 'MOBILE_EAS_CLI_PATH']) required(env, name);
  if (!/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '') || git(['rev-parse', 'HEAD']) !== env.GITHUB_SHA || git(['status', '--porcelain', '--untracked-files=no'])) {
    throw new Error('Build from a clean checkout of the pushed commit.');
  }
  return true;
}

/** EAS evaluates the profile itself. Local selectors must not override what eas.json and the EAS environment set. */
function neutralEnvironment(env) {
  const neutral = { ...env, EXPO_NO_DOTENV: '1' };
  for (const name of SELECTORS) delete neutral[name];
  return neutral;
}

function fingerprintArgs() {
  return ['fingerprint:generate', '--build-profile', PROFILE, '--platform', PLATFORM, '--json', '--non-interactive'];
}

function existingBuildArgs(runtime) {
  return ['build:list', '--platform', PLATFORM, '--build-profile', PROFILE, '--runtime-version', runtime, '--limit', '10', '--json', '--non-interactive'];
}

function recentBuildArgs() {
  return ['build:list', '--platform', 'all', '--limit', '50', '--json', '--non-interactive'];
}

function buildArgs(message) {
  return ['build', '--profile', PROFILE, '--platform', PLATFORM, '--auto-submit-with-profile', PROFILE,
    '--message', message, '--no-wait', '--non-interactive', '--json'];
}

/** The build that already covers this fingerprint, or null when a new binary is needed. */
function coveringBuild(builds) {
  return builds.find((build) => LIVE_STATUSES.includes(build.status)) ?? null;
}

/**
 * The next store build number. Both stores and both store profiles share MOBILE_BUILD_NUMBER, so it must exceed
 * the current reservation and every recent store build, including failed ones.
 */
function nextBuildNumber(current, builds) {
  const used = [current, ...builds.filter((build) => STORE_PROFILES.includes(build.buildProfile)).map((build) => build.appBuildVersion)]
    .map((value) => (/^\d+$/.test(String(value ?? '')) ? Number(value) : 0));
  const next = Math.max(0, ...used) + 1;
  if (next > 999999999) throw new Error('The next build number exceeds the store limit.');
  return String(next);
}

/** The queued build must be the binary this run reserved its number for. */
function assertQueuedBuild(builds, { sha, buildNumber }) {
  if (!Array.isArray(builds) || builds.length !== 1) throw new Error('Expected EAS to queue exactly one build.');
  const [build] = builds;
  if (build.platform?.toLowerCase() !== PLATFORM || build.buildProfile !== PROFILE || build.gitCommitHash !== sha ||
    String(build.appBuildVersion) !== buildNumber || (build.updateChannel?.name && build.updateChannel.name !== policy.channel)) {
    throw new Error(`EAS queued build ${build.id ?? 'unknown'} that does not match this ${PROFILE} ${PLATFORM} candidate.`);
  }
  return build;
}

function json(env, args, what) {
  const text = easOrThrow(env, args, what);
  try { return JSON.parse(text); } catch { throw new Error(`${what} returned no JSON.`); }
}

function run() {
  const mode = process.argv[2];
  if (mode && !['--execute', '--dry-run'].includes(mode)) throw new Error('Use --dry-run or --execute.');
  const force = process.env.MOBILE_TESTFLIGHT_FORCE === 'true';
  console.log(JSON.stringify({ action: 'build-and-submit', profile: PROFILE, platform: PLATFORM, force, execute: mode === '--execute' }));
  if (mode !== '--execute') return;
  assertTestflightExecution(process.env);
  const env = neutralEnvironment(process.env);

  const { hash } = json(env, fingerprintArgs(), `Generating the ${PROFILE} ${PLATFORM} fingerprint`);
  if (!/^[a-f0-9]{40,64}$/.test(hash ?? '')) throw new Error('EAS returned no fingerprint hash.');
  const covering = coveringBuild(json(env, existingBuildArgs(hash), `Listing ${PROFILE} ${PLATFORM} builds`));
  if (covering && !force) {
    summarize(env, [`${PROFILE} ${PLATFORM}: build ${covering.id} (${covering.status}, build number ${covering.appBuildVersion}) already runs fingerprint ${hash}. No new binary; the EAS update reaches it.`]);
    return;
  }

  const current = pullEnvironment(env, policy.environment).MOBILE_BUILD_NUMBER;
  const buildNumber = nextBuildNumber(current, json(env, recentBuildArgs(), 'Listing recent builds'));
  easOrThrow(env, ['env:set', '--name', 'MOBILE_BUILD_NUMBER', '--value', buildNumber, '--environment', policy.environment,
    '--visibility', 'plaintext', '--type', 'string', '--non-interactive'], `Reserving build number ${buildNumber}`);

  const message = required(process.env, 'MOBILE_BUILD_MESSAGE').slice(0, 1000);
  const builds = json({ ...env, MOBILE_BUILD_NUMBER: buildNumber }, buildArgs(message), `Queueing the ${PROFILE} ${PLATFORM} build`);
  const build = assertQueuedBuild(builds, { sha: process.env.GITHUB_SHA, buildNumber });
  const page = build.app?.ownerAccount?.name && build.app?.slug ? ` https://expo.dev/accounts/${build.app.ownerAccount.name}/projects/${build.app.slug}/builds/${build.id}` : '';
  summarize(env, [
    `${PROFILE} ${PLATFORM}: queued build ${build.id} with build number ${buildNumber} for fingerprint ${hash}${covering ? ' (forced)' : ''}.${page}`,
    'EAS submits it to App Store Connect when it finishes. Follow both in the EAS dashboard.',
  ]);
}

if (require.main === module) {
  Promise.resolve().then(run).catch((error) => {
    console.error(`TestFlight build blocked: ${redact(error instanceof Error ? error.message : String(error))}`);
    process.exitCode = 1;
  });
}
module.exports = { assertTestflightExecution, neutralEnvironment, fingerprintArgs, existingBuildArgs, recentBuildArgs, buildArgs, coveringBuild, nextBuildNumber, assertQueuedBuild };
