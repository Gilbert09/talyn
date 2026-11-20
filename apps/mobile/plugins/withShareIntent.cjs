// "Share to Talyn": the `expo-share-intent` plugin adds an iOS share extension and an Android SEND intent filter.
// A link or text shared from another app opens Talyn, and the app puts it in the new-session composer
// (src/features/share). Only text and links: the extension takes no images, videos or files.
//
// iOS: the extension saves the shared item in the app group `group.<bundle id>` and opens `<scheme>://dataUrl=...`.
// EAS signs the extension target `ShareExtension` (`<bundle id>.share-extension`) from
// `extra.eas.build.experimental.ios.appExtensions`, which the plugin adds.
const fs = require('node:fs');
const path = require('node:path');
const { withFinalizedMod } = require('@expo/config-plugins');
const plist = require('@expo/plist').default;
const sharePlugin = require('expo-share-intent/app.plugin');

const withExpoShareIntent = sharePlugin.default ?? sharePlugin;

const SHARE_EXTENSION_TARGET = 'ShareExtension';
const SHARE_EXTENSION_INFO = `${SHARE_EXTENSION_TARGET}/${SHARE_EXTENSION_TARGET}-Info.plist`;

const SHARE_INTENT_OPTIONS = Object.freeze({
  iosActivationRules: Object.freeze({
    NSExtensionActivationSupportsText: true,
    NSExtensionActivationSupportsWebURLWithMaxCount: 1,
    NSExtensionActivationSupportsWebPageWithMaxCount: 1,
  }),
  // No `androidMultiIntentFilters`: even an empty list adds a SEND_MULTIPLE filter.
  androidIntentFilters: Object.freeze(['text/*']),
});

/**
 * The share sheet shows the extension's display name. The plugin names it "<app> - Share Extension", and its own
 * name option also renames the Xcode target, which then clashes with the "Talyn" app target. Set the name last.
 */
function withShareExtensionDisplayName(config) {
  return withFinalizedMod(config, ['ios', async (modConfig) => {
    const file = path.join(modConfig.modRequest.platformProjectRoot, SHARE_EXTENSION_INFO);
    const info = plist.parse(await fs.promises.readFile(file, 'utf8'));
    info.CFBundleDisplayName = modConfig.name;
    await fs.promises.writeFile(file, plist.build(info));
    return modConfig;
  }]);
}

function withShareIntent(config) {
  return withShareExtensionDisplayName(withExpoShareIntent(config, {
    ...SHARE_INTENT_OPTIONS,
    iosActivationRules: { ...SHARE_INTENT_OPTIONS.iosActivationRules },
    androidIntentFilters: [...SHARE_INTENT_OPTIONS.androidIntentFilters],
  }));
}

// `default` is the plugin for the app config's `plugins` list.
module.exports = { default: withShareIntent, SHARE_EXTENSION_INFO, SHARE_EXTENSION_TARGET, SHARE_INTENT_OPTIONS, withShareIntent };
