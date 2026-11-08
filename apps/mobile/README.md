# Talyn mobile shell

This workspace contains the native development shell for iOS and Android.
The screens show example data. No account, API, or socket connects.
The client adapter PR can land independently.
See [the approved plan](../../docs/MOBILE_APP_PLAN.md) and [PR #116](https://github.com/Gilbert09/talyn/pull/116).

## Local setup

Use Node.js 22.23.4 and npm 10.9.9, or a compatible Node.js version from `package.json`.
Run all installation commands from the repository root. Keep one root lockfile.

```sh
npm install
npm run mobile:build:packages
npm run mobile:start
```

Use a development build with Expo Dev Client.
The SDK uses React Native 0.88.1 and React 19.3.0.
Metro uses Expo's defaults for the monorepo.
Root overrides keep React, React DOM, and the test renderer at 19.3.0 across workspaces.
Generated `ios/`, `android/`, `.expo/`, and export files stay out of git.
`@talyn/shared` supplies an inert status helper and types.
`@talyn/client` supplies a type only. This does not prove native transport support.

## Development builds

Install Android Studio and its SDK for a local Android build.
Use macOS with Xcode for a local iOS build.
Run these commands from the root:

```sh
npm run mobile:android
npm run mobile:ios
```

These commands generate native projects and install a development build.
After that build, use `npm run mobile:start` for Metro.
Expo Go does not validate this app's native configuration.

EAS profiles also define development, preview, and production identities.
To use EAS, first confirm organization ownership and link an approved EAS project.
Then run `npx eas-cli build --profile development --platform android` from `apps/mobile`.
Use `--platform ios` for iOS. EAS requires account access and platform signing setup.
This PR does not provide signing credentials, build jobs, store uploads, or OTA updates.

## Environment configuration

Set these variables before a build or native generation. Restart Metro after a change.
Set `APP_ENV` to `development` (the default), `preview`, or `production`.
Other values fail configuration.

| Environment | Candidate iOS and Android ID | Candidate scheme |
| --- | --- | --- |
| Development | `dev.talyn.mobile.development` | `talyn-mobile-development` |
| Preview | `dev.talyn.mobile.preview` | `talyn-mobile-preview` |
| Production | `dev.talyn.mobile` | `talyn-mobile` |

The plan supplies the organization prefix. Identifier availability remains unverified.
The schemes are development defaults. They do not prove domain ownership or provide OAuth callbacks.
Use these explicit overrides when an approved identity differs:

| Variable | Effect |
| --- | --- |
| `TALYN_MOBILE_IOS_BUNDLE_ID` | Replaces the full iOS bundle identifier. |
| `TALYN_MOBILE_ANDROID_PACKAGE` | Replaces the full Android package name. |
| `TALYN_MOBILE_SCHEME` | Replaces the complete custom scheme. |

An override replaces the full value. It does not receive an environment suffix.
Keep override values separate for each environment in local tooling or EAS configuration.
App configuration is public. Do not put credentials in it.
The shell has no backend origin, Supabase key, OAuth callback, push registration, or auth storage.
Add these contracts in later PRs.

## Checks

Build shared and client packages before mobile checks:

```sh
npm run mobile:build:packages
npm run mobile:check:graph
npm run mobile:lint
npm run mobile:typecheck
npm run mobile:test
npm run mobile:expo:check
npm run mobile:doctor
npm run mobile:export:smoke
```

Typecheck generates Expo Router declarations before it checks valid and invalid route examples.
Jest uses the Expo preset and React Native Testing Library.
Tests check accessible headings, links, startup, detail navigation, back navigation, direct URLs, and environment identities.
The export smoke test creates both native bundles without release credentials.
The dedicated CI workflow runs these checks on pull requests.

## Device and release gaps

No physical device, simulator, emulator, EAS build, signed archive, or store upload was tested in this sandbox.
Exports and component tests do not prove that a native binary starts.
A later device pass must check native tabs, per-tab history, back gestures, safe areas, and screen reader focus.
Also check VoiceOver, TalkBack, 200 percent text, contrast, dark mode, rotation, and tablet layouts.
Confirm the EAS image, minimum OS versions, app identities, and signing ownership before building release archives.
OAuth, transport lifecycle, notifications, product actions, and release automation remain separate work.
