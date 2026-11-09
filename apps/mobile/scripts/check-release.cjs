const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { profiles } = require('../release/policy.cjs');

const root = path.resolve(__dirname, '../../..');
const mobile = path.join(root, 'apps/mobile');
const read = (file) => fs.readFileSync(path.join(mobile, file), 'utf8');

function privacyDigest() {
  const lock = fs.readFileSync(path.join(root, 'package-lock.json'));
  return crypto.createHash('sha256').update(lock).digest('hex');
}

function checkMetadata(metadata, ready = false) {
  for (const platform of ['apple', 'google']) {
    assert(metadata[platform] && typeof metadata[platform] === 'object', `Missing ${platform} metadata.`);
    for (const name of ['name', 'description', 'category', 'supportUrl', 'privacyUrl', 'deletionUrl', 'copyright', 'reviewAccess', 'releaseNotes', 'countries', 'ageRating', 'privacyAnswers', 'assets']) {
      assert(Object.hasOwn(metadata[platform], name), `Missing ${platform}.${name}.`);
      if (ready) assert(metadata[platform][name] !== null && metadata[platform][name] !== '', `Approve ${platform}.${name}.`);
    }
  }
  if (ready) {
    const { publicUrl } = require('../release/policy.cjs');
    for (const platform of ['apple', 'google']) {
      for (const field of ['supportUrl', 'privacyUrl', 'deletionUrl']) publicUrl(metadata[platform][field], `${platform}.${field}`);
      assert(Array.isArray(metadata[platform].countries) && metadata[platform].countries.length, `Choose ${platform} countries.`);
      assert(Array.isArray(metadata[platform].assets) && metadata[platform].assets.length, `Record ${platform} assets.`);
    }
  }
  for (const [platform, limits] of Object.entries({ apple: { name: 30, subtitle: 30, description: 4000, keywords: 100, releaseNotes: 4000 }, google: { name: 30, shortDescription: 80, description: 4000, releaseNotes: 500 } })) {
    for (const [field, limit] of Object.entries(limits)) if (metadata[platform][field]) assert(metadata[platform][field].length <= limit, `${platform}.${field} exceeds its limit.`);
  }
}

/** The automatic path publishes to exactly the auto-update channels, from main, with no cache or artifact. */
function checkUpdateWorkflow(text, yaml) {
  const workflow = yaml.load(text);
  assert.deepEqual(Object.keys(workflow.on).sort(), ['push', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(workflow.concurrency['cancel-in-progress'], false, 'Update publishes must queue in order.');
  const job = workflow.jobs.publish;
  for (const guard of ["github.repository == 'Gilbert09/talyn'", "github.ref == 'refs/heads/main'", "vars.MOBILE_UPDATES_AUTO != '0'"]) {
    assert(job.if.includes(guard), `The update workflow needs the guard ${guard}.`);
  }
  assert(!/actions\/(?:upload-artifact|cache)|cache:\s*npm|set\s+-x|pull_request|--channel\s+production|eas\s+update/.test(text),
    'The update workflow publishes only through publish-update.cjs, with no cache, artifact, or PR trigger.');
  assert(text.includes(`eas-cli@${JSON.parse(read('eas.json')).cli.version}`), 'Keep the external EAS CLI pin aligned.');
  const published = [...text.matchAll(/publish-update\.cjs\s+(\S+)\s+--execute/g)].map((match) => match[1]);
  assert.deepEqual(published, Object.keys(profiles).filter((name) => profiles[name].autoUpdate), 'Publish to every automatic channel, preview first.');
}

function scanFiles() {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
  for (const file of files.filter((name) => /^(apps\/mobile\/|docs\/MOBILE|\.github\/workflows\/mobile|\.easignore$|package(?:-lock)?\.json$)/.test(name))) {
    if (!fs.existsSync(path.join(root, file))) continue;
    const bytes = fs.readFileSync(path.join(root, file));
    if (bytes.includes(0)) continue;
    const value = bytes.toString('utf8');
    const privateKey = /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]{40}/;
    const providerSecret = /(?:sb_secret_[A-Za-z0-9_-]{24,}|(?:ghp|gho|github_pat)_[A-Za-z0-9_]{30,}|ExponentPushToken\[[A-Za-z0-9_-]{20,}\])/;
    const googleKey = /"type"\s*:\s*"service_account"/;
    assert(!privateKey.test(value) && !providerSecret.test(value) && !googleKey.test(value), `Possible credential in ${file}. Remove it before release.`);
    for (const match of value.matchAll(/eyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g)) {
      let payload;
      try { payload = JSON.parse(Buffer.from(match[1], 'base64url').toString()); } catch { continue; }
      assert(!['service_role', 'authenticated'].includes(payload.role), `Possible private JWT in ${file}.`);
    }
    assert(!/(?:^|\/)(?:credentials\.json|.*\.(?:p8|p12|jks|keystore|mobileprovision))$/.test(file), `Signing file in ${file}.`);
  }
}

function check() {
  const yaml = require('js-yaml');
  const prText = fs.readFileSync(path.join(root, '.github/workflows/mobile.yml'), 'utf8');
  const releaseText = fs.readFileSync(path.join(root, '.github/workflows/mobile-release.yml'), 'utf8');
  const prWorkflow = yaml.load(prText); const releaseWorkflow = yaml.load(releaseText);
  assert(Object.hasOwn(prWorkflow.on, 'pull_request'));
  assert(!/secrets\.|--execute|eas\s+(?:submit|update)|pull_request_target/.test(prText), 'PR checks must have no release path or secrets.');
  assert.deepEqual(Object.keys(releaseWorkflow.on), ['workflow_dispatch']);
  assert.equal(releaseWorkflow.permissions.contents, 'read');
  assert(releaseWorkflow.jobs.release.environment && releaseWorkflow.jobs.release.if.includes("refs/heads/main"));
  assert(!/actions\/(?:upload-artifact|cache)|cache:\s*npm|set\s+-x/.test(releaseText), 'Release secrets must stay outside logs, caches, and artifacts.');
  assert(releaseText.includes("MOBILE_UPDATES_ENABLED: ${{ inputs.profile == 'development' && '0' || '1' }}"), 'The release workflow must enable updates as eas.json does.');
  checkUpdateWorkflow(fs.readFileSync(path.join(root, '.github/workflows/mobile-update.yml'), 'utf8'), yaml);
  for (const name of ['auth', 'workflows', 'deep-links', 'notifications', 'notification-tap', 'logout', 'deletion']) {
    const flow = yaml.loadAll(read(`e2e/${name}.yaml`));
    assert.equal(flow.length, 2, `Invalid Maestro flow: ${name}.`);
    assert.equal(flow[0].appId, '${APP_ID}');
    assert(Array.isArray(flow[1]) && flow[1].length, `Missing Maestro steps: ${name}.`);
  }
  const eas = JSON.parse(read('eas.json'));
  assert.equal(eas.cli.appVersionSource, 'local');
  assert.equal(eas.cli.requireCommit, true);
  assert.equal(eas.cli.version, JSON.parse(read('release/toolchain.json')).easCli);
  assert(fs.readFileSync(path.join(root, '.github/workflows/mobile-release.yml'), 'utf8').includes(`eas-cli@${eas.cli.version}`), 'Keep the external EAS CLI pin aligned.');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'))).packages['apps/mobile'].version, JSON.parse(read('package.json')).version, 'Mobile version differs from the root lockfile.');
  assert.deepEqual(Object.keys(eas.build).sort(), Object.keys(profiles).sort());
  for (const [name, policy] of Object.entries(profiles)) {
    const profile = eas.build[name];
    assert.equal(profile.env.APP_ENV, policy.environment);
    assert.equal(profile.environment, policy.environment);
    assert.equal(profile.channel, policy.channel);
    assert.equal(profile.autoIncrement, false);
    assert.equal(profile.env.MOBILE_UPDATES_ENABLED, policy.updates ? '1' : '0', `eas.json must ${policy.updates ? 'enable' : 'disable'} updates for ${name}.`);
    assert.equal(profile.distribution, policy.store ? 'store' : 'internal');
    if (policy.store) {
      assert.equal(profile.credentialsSource, 'remote');
      assert.equal(profile.android.buildType, 'app-bundle');
      assert.equal(eas.submit[name].android.releaseStatus, 'draft');
      assert.equal(eas.submit[name].android.changesNotSentForReview, true);
      assert.equal(eas.submit[name].android.track, name === 'production' ? 'production' : 'internal');
    }
  }
  const metadata = JSON.parse(read('release/store-metadata.json'));
  checkMetadata(metadata);
  const inventory = JSON.parse(read('release/privacy-inventory.json'));
  assert.equal(inventory.lockfileSha256, privacyDigest(), 'Dependency graph changed. Review privacy disclosures and update the inventory.');
  assert.deepEqual(inventory.mobileDependencies, JSON.parse(read('package.json')).dependencies, 'Review each mobile dependency for privacy changes.');
  assert.deepEqual(inventory.prohibited, ['analytics', 'advertising', 'tracking', 'session-replay']);
  assert(inventory.data.length >= 6 && inventory.processors.length >= 4);
  scanFiles();
  console.log('Release profiles, metadata structure, privacy graph, and credential scan passed. Store approvals remain external gates.');
}

if (require.main === module) {
  if (process.argv[2] === '--privacy-digest') console.log(privacyDigest());
  else check();
}
module.exports = { checkMetadata, checkUpdateWorkflow, privacyDigest, scanFiles };
