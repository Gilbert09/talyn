const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { profiles, required } = require('../release/policy.cjs');

const root = path.resolve(__dirname, '..');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function releasePlan(action, profile, platform, env) {
  const policy = profiles[profile];
  if (!policy || !['ios', 'android'].includes(platform)) throw new Error('Choose a release profile and one native platform.');
  const args = [];
  if (action === 'build') args.push('build', '--profile', profile, '--platform', platform, '--non-interactive', '--wait');
  else if (action === 'submit') {
    if (!policy.store) throw new Error('Submission requires a store profile.');
    const id = required(env, 'MOBILE_BUILD_ID');
    if (!uuid.test(id)) throw new Error('Use an exact EAS build ID.');
    if (platform === 'ios' && (!/^\d+$/.test(env.MOBILE_ASC_APP_ID ?? '') || !/^[A-Z0-9]{10}$/.test(env.MOBILE_APPLE_TEAM_ID ?? ''))) throw new Error('Configure the approved Apple app and team IDs.');
    args.push('submit', '--profile', profile, '--platform', platform, '--id', id, '--non-interactive', '--wait', '--no-auto-testflight-setup');
  } else if (action === 'update' || action === 'rollback') {
    if (profile === 'development' || env.MOBILE_UPDATES_ENABLED !== '1') throw new Error('Updates must be enabled in the installed binary.');
    const runtime = required(env, 'MOBILE_RUNTIME_VERSION');
    if (!/^[a-f0-9]{40,64}$/.test(runtime)) throw new Error('Use the installed platform fingerprint as the runtime.');
    // Updates are unsigned by decision (2026-11-09): EAS code signing needs a paid EAS plan.
    const message = `Mobile ${action} ${profile}`;
    if (action === 'rollback') args.push('update:roll-back-to-embedded', '--channel', policy.channel,
      '--runtime-version', runtime, '--platform', platform, '--message', message, '--non-interactive');
    else args.push('update', '--channel', policy.channel, '--environment', policy.environment,
      '--platform', platform, '--message', message, '--non-interactive');
  } else throw new Error('Choose build, submit, update, or rollback.');
  return { action, profile, platform, policy, args };
}

function assertExecution(plan, env, git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()) {
  if (env.CI !== 'true' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main' ||
    env.MOBILE_RELEASE_APPROVED !== 'true' || env.MOBILE_RELEASE_ENVIRONMENT !== `mobile-${plan.policy.store ? 'production' : 'preview'}`) {
    throw new Error('Execution requires the protected manual release workflow on main.');
  }
  required(env, 'EXPO_TOKEN');
  if (!/^[0-9a-f]{40}$/.test(env.MOBILE_RELEASE_SHA ?? '') || git(['rev-parse', 'HEAD']) !== env.MOBILE_RELEASE_SHA || git(['status', '--porcelain', '--untracked-files=no'])) {
    throw new Error('Use a clean checkout at the approved source commit.');
  }
  if (plan.policy.store) {
    const evidence = JSON.parse(fs.readFileSync(required(env, 'MOBILE_RELEASE_EVIDENCE_PATH'), 'utf8'));
    if (evidence.sourceCommit !== env.MOBILE_RELEASE_SHA || evidence.profile !== plan.profile || evidence.platform !== plan.platform ||
      evidence.buildNumber !== env.MOBILE_BUILD_NUMBER || (plan.action !== 'build' && evidence.runtimeVersion !== env.MOBILE_RUNTIME_VERSION)) throw new Error('Release evidence does not match this candidate.');
    const gates = plan.action === 'build' ? ['security', 'privacy', 'policy', 'metadata', 'signing'] :
      ['security', 'privacy', 'policy', 'metadata', 'signing', 'devices', 'links', 'push', 'deletion', 'rollback', 'backendCompatibility'];
    for (const gate of gates) {
      if (typeof evidence.approvals?.[gate] !== 'string' || !evidence.approvals[gate].trim()) throw new Error(`Record the ${gate} approval reference.`);
    }
    if (plan.action === 'submit' && evidence.buildId !== env.MOBILE_BUILD_ID) throw new Error('Submission evidence must match the inspected build.');
    if (plan.action === 'submit') {
      const metadata = fs.readFileSync(required(env, 'MOBILE_STORE_METADATA_PATH'));
      require('./check-release.cjs').checkMetadata(JSON.parse(metadata), true);
      if (evidence.metadataSha256 !== require('node:crypto').createHash('sha256').update(metadata).digest('hex') || !/^[a-f0-9]{64}$/.test(evidence.artifactSha256 ?? '')) {
        throw new Error('Record the approved metadata and inspected artifact checksums.');
      }
    }
  }
  return true;
}

async function run() {
  const [action, profile, platform, mode] = process.argv.slice(2);
  if (mode && !['--execute', '--dry-run'].includes(mode)) throw new Error('Use --dry-run or --execute.');
  const env = { ...process.env, APP_ENV: profiles[profile]?.environment, MOBILE_RELEASE_PROFILE: profile };
  const plan = releasePlan(action, profile, platform, env);
  // Plans contain no credentials or raw command arguments.
  console.log(JSON.stringify({ action, profile, platform, channel: plan.policy.channel, execute: mode === '--execute' }));
  if (mode !== '--execute') return;
  assertExecution(plan, env);
  if (['ios', 'android'].some((name) => fs.existsSync(path.join(root, name)))) throw new Error('Release operations require CNG source without generated native directories.');
  const { getConfig } = require('@expo/config');
  const previous = process.env;
  process.env = env;
  try {
    const { exp } = getConfig(root, { skipSDKVersionRequirement: true });
    if (plan.action === 'update') {
      const { createFingerprintAsync } = require('@expo/fingerprint');
      const fingerprint = await createFingerprintAsync(root, { platforms: [platform], concurrentIoLimit: 2 });
      assertRuntime(fingerprint.hash, env.MOBILE_RUNTIME_VERSION);
    }
    execute(plan, env, exp);
  } finally { process.env = previous; }
}

function assertRuntime(actual, expected) {
  if (!actual || actual !== expected) throw new Error('Native fingerprint differs. Build a new binary.');
}

function assertBuild(build, plan, env, exp) {
  if (build.status !== 'FINISHED' || build.platform?.toLowerCase() !== plan.platform || build.buildProfile !== plan.profile ||
    build.appIdentifier !== (plan.platform === 'ios' ? exp.ios.bundleIdentifier : exp.android.package) ||
    build.gitCommitHash !== env.MOBILE_RELEASE_SHA || build.appVersion !== exp.version ||
    build.appBuildVersion !== env.MOBILE_BUILD_NUMBER || build.runtime?.version !== env.MOBILE_RUNTIME_VERSION ||
    build.updateChannel?.name !== plan.policy.channel) throw new Error('EAS build does not match the inspected release candidate.');
}

function assertChannel(result, name) {
  const channel = result.currentPage;
  const branches = channel?.updateBranches;
  const mapping = JSON.parse(channel?.branchMapping ?? '{}');
  if (channel?.name !== name || channel.isPaused !== false || branches?.length !== 1 || branches[0].name !== name ||
    mapping.data?.length !== 1 || mapping.data[0].branchId !== branches[0].id || mapping.data[0].branchMappingLogic !== 'true') {
    throw new Error('Require one active channel mapped only to its matching branch.');
  }
}

function execute(plan, env, exp) {
  const executable = required(env, 'MOBILE_EAS_CLI_PATH');
  const installed = JSON.parse(fs.readFileSync(path.join(path.dirname(executable), '../package.json'), 'utf8'));
  if (installed.name !== 'eas-cli' || installed.version !== require('../release/toolchain.json').easCli) throw new Error('Use the pinned external EAS CLI.');
  if (['update', 'rollback'].includes(plan.action)) {
    const view = spawnSync(process.execPath, [executable, 'channel:view', plan.policy.channel, '--json', '--non-interactive'], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (view.status !== 0) throw new Error('Cannot verify the hosted channel.');
    assertChannel(JSON.parse(view.stdout), plan.policy.channel);
  }
  if (plan.action === 'submit') {
    const view = spawnSync(process.execPath, [executable, 'build:view', env.MOBILE_BUILD_ID, '--json'], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (view.status !== 0) throw new Error('Cannot verify the hosted build.');
    assertBuild(JSON.parse(view.stdout), plan, env, exp);
  }
  // A certificate in the binary would reject every unsigned update this project publishes.
  if (exp.updates?.codeSigningCertificate || exp.updates?.codeSigningMetadata) throw new Error('Updates are unsigned. Remove update code signing from the app config.');
  // Hosted logs can contain signed URLs. Keep all provider output out of CI logs and artifacts.
  const result = spawnSync(process.execPath, [executable, ...plan.args], { cwd: root, env, stdio: 'ignore' });
  if (result.status !== 0) throw new Error('EAS failed. Inspect the restricted EAS dashboard.');
  console.log('EAS operation finished. Record its IDs from the restricted EAS dashboard.');
}

if (require.main === module) Promise.resolve().then(run).catch(() => { console.error('Release blocked. Check configuration, approval evidence, and the release runbook.'); process.exitCode = 1; });
module.exports = { releasePlan, assertExecution, assertRuntime, assertBuild, assertChannel };
