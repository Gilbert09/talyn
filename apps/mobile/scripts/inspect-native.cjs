const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const plist = require('@expo/plist').default;
const { AndroidConfig } = require('@expo/config-plugins');
const { getConfig } = require('@expo/config');
const { SHARE_EXTENSION_INFO, SHARE_EXTENSION_TARGET, SHARE_INTENT_OPTIONS } = require('../plugins/withShareIntent.cjs');

const root = path.resolve(__dirname, '..');

async function inspect() {
  const { exp } = getConfig(root);
  const manifest = await AndroidConfig.Manifest.readAndroidManifestAsync(path.join(root, 'android/app/src/main/AndroidManifest.xml'));
  const permissions = (manifest.manifest['uses-permission'] ?? []).filter((entry) => entry.$['tools:node'] !== 'remove').map((entry) => entry.$['android:name']);
  const allowed = ['android.permission.INTERNET', 'android.permission.ACCESS_NETWORK_STATE', 'android.permission.VIBRATE', 'android.permission.POST_NOTIFICATIONS', 'com.google.android.c2dm.permission.RECEIVE'];
  for (const permission of permissions) assert(allowed.includes(permission), `Review unexpected Android permission: ${permission}`);
  assert(permissions.includes('android.permission.INTERNET'));
  assert(permissions.includes('android.permission.POST_NOTIFICATIONS'));
  const gradle = fs.readFileSync(path.join(root, 'android/app/build.gradle'), 'utf8');
  assert(gradle.includes(`applicationId '${exp.android.package}'`) || gradle.includes(`applicationId "${exp.android.package}"`));
  assert(new RegExp(`versionCode\\s+${exp.android.versionCode}\\b`).test(gradle));
  assert(gradle.includes(`versionName "${exp.version}"`) || gradle.includes(`versionName '${exp.version}'`));
  const app = manifest.manifest.application[0];
  assert.notEqual(app.$['android:usesCleartextTraffic'], 'true');
  // "Share to Talyn" takes one shared text or link, nothing else (plugins/withShareIntent.cjs).
  const mainActivity = app.activity.find((activity) => activity.$['android:name'] === '.MainActivity');
  const sends = (mainActivity['intent-filter'] ?? []).filter((filter) => (filter.action ?? []).some((action) => /\.SEND(_MULTIPLE)?$/.test(action.$['android:name'])));
  assert.deepEqual(sends.map((filter) => [filter.action.map((action) => action.$['android:name']), (filter.data ?? []).map((data) => data.$['android:mimeType'])]),
    [[['android.intent.action.SEND'], [...SHARE_INTENT_OPTIONS.androidIntentFilters]]], 'Review the Android share intent filters.');
  assert.equal(mainActivity.$['android:launchMode'], 'singleTask');
  if (exp.updates.enabled) {
    // The app starts its own checks (src/features/updates); native code checks only to recover from a failed launch.
    const meta = Object.fromEntries((app['meta-data'] ?? []).map((entry) => [entry.$['android:name'], entry.$['android:value']]));
    assert(!meta['expo.modules.updates.CODE_SIGNING_CERTIFICATE'] && !meta['expo.modules.updates.CODE_SIGNING_METADATA'], 'Updates are unsigned. Remove the update certificate.');
    assert.equal(meta['expo.modules.updates.EXPO_UPDATES_CHECK_ON_LAUNCH'], 'ERROR_RECOVERY_ONLY');
    assert.equal(meta['expo.modules.updates.EXPO_UPDATES_LAUNCH_WAIT_MS'], '0');
  }
  const iosRoot = path.join(root, 'ios');
  const project = fs.readdirSync(iosRoot).find((name) => fs.existsSync(path.join(iosRoot, name, 'Info.plist')));
  assert(project, 'Generate the iOS project first.');
  const parse = (file) => plist.parse(fs.readFileSync(path.join(iosRoot, project, file), 'utf8'));
  const info = parse('Info.plist');
  assert.equal(info.CFBundleShortVersionString, exp.version);
  assert.equal(info.CFBundleVersion, exp.ios.buildNumber);
  assert.notEqual(info.NSAppTransportSecurity?.NSAllowsArbitraryLoads, true);
  // Image attachments ask for the camera and the photo library. Every other sensitive description needs review.
  const reviewedUsage = ['NSCameraUsageDescription', 'NSPhotoLibraryUsageDescription'];
  for (const key of Object.keys(info)) {
    if (reviewedUsage.includes(key)) continue;
    assert(!/^NS(Camera|Microphone|Contacts|Location|PhotoLibrary|UserTracking).*UsageDescription$/.test(key), `Review unexpected iOS usage description: ${key}`);
  }
  const entitlementsFile = fs.readdirSync(path.join(iosRoot, project)).find((name) => name.endsWith('.entitlements'));
  assert(entitlementsFile, 'Missing iOS entitlements.');
  const entitlements = parse(entitlementsFile);
  const reviewedEntitlements = ['aps-environment', 'com.apple.developer.associated-domains', 'com.apple.security.application-groups'];
  for (const key of Object.keys(entitlements)) assert(reviewedEntitlements.includes(key), `Review unexpected iOS entitlement: ${key}`);
  // The share extension hands the shared item to the app through one app group, named after the bundle ID.
  const appGroup = `group.${exp.ios.bundleIdentifier}`;
  assert.deepEqual(entitlements['com.apple.security.application-groups'], [appGroup]);
  assert.equal(info.AppGroupIdentifier, appGroup);
  const readIos = (file) => plist.parse(fs.readFileSync(path.join(iosRoot, file), 'utf8'));
  const shareInfo = readIos(SHARE_EXTENSION_INFO);
  assert.equal(shareInfo.CFBundleDisplayName, exp.name, 'The share sheet must show the app name.');
  assert.equal(shareInfo.AppGroupIdentifier, appGroup);
  assert.equal(shareInfo.NSExtension.NSExtensionPointIdentifier, 'com.apple.share-services');
  assert.deepEqual({ ...shareInfo.NSExtension.NSExtensionAttributes.NSExtensionActivationRule }, { ...SHARE_INTENT_OPTIONS.iosActivationRules }, 'Review the iOS share activation rules.');
  assert.deepEqual({ ...readIos(`${SHARE_EXTENSION_TARGET}/${SHARE_EXTENSION_TARGET}.entitlements`) }, { 'com.apple.security.application-groups': [appGroup] });
  // EAS signs only the targets listed here. A second listed extension needs its own review.
  assert.deepEqual((exp.extra.eas.build?.experimental?.ios?.appExtensions ?? []).map(({ targetName, bundleIdentifier }) => ({ targetName, bundleIdentifier })),
    [{ targetName: SHARE_EXTENSION_TARGET, bundleIdentifier: `${exp.ios.bundleIdentifier}.share-extension` }]);
  assert.equal(entitlements['aps-environment'], exp.extra.release.profile === 'development' ? 'development' : 'production');
  assert.deepEqual(entitlements['com.apple.developer.associated-domains'] ?? [], exp.ios.associatedDomains ?? []);
  assert(!(info.UIBackgroundModes ?? []).includes('remote-notification'), 'No background push execution is approved.');
  const privacy = parse('PrivacyInfo.xcprivacy');
  // PostHog analytics and masked replay are first-party with no cross-app tracking (Tom's call, 2026-11-10), so tracking stays false.
  assert.equal(privacy.NSPrivacyTracking, false);
  assert.deepEqual(privacy.NSPrivacyTrackingDomains ?? [], []);
  const expoPlist = parse('Supporting/Expo.plist');
  assert.equal(expoPlist.EXUpdatesEnabled, !!exp.updates.enabled);
  // Updates are unsigned by decision (2026-11-09). A certificate would make the binary reject every unsigned update.
  assert(!expoPlist.EXUpdatesCodeSigningCertificate && !expoPlist.EXUpdatesCodeSigningMetadata, 'Updates are unsigned. Remove the update certificate.');
  if (exp.updates.enabled) {
    assert.equal(expoPlist.EXUpdatesURL, exp.updates.url);
    assert.equal(expoPlist.EXUpdatesRequestHeaders['expo-channel-name'], exp.extra.release.profile);
    assert.equal(expoPlist.EXUpdatesCheckOnLaunch, 'ERROR_RECOVERY_ONLY');
    assert.equal(expoPlist.EXUpdatesLaunchWaitMs, 0);
  }
  console.log('Generated native identity, version, permissions, entitlements, share extension, privacy, and update settings passed.');
  console.log('Signed archives, merged dependency manifests, and 16 KB binary alignment remain release gates.');
}

if (require.main === module) inspect().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { inspect };
