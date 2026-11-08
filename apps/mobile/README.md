# Talyn mobile foundation

This workspace adds native GitHub sign-in, workspace selection, and account settings for iOS and Android.
Sessions, Threads, and Attention still show examples. Product workflows and push notifications will follow in later phases.
See [the mobile plan](../../docs/MOBILE_APP_PLAN.md), [#116](https://github.com/Gilbert09/talyn/pull/116),
[#119](https://github.com/Gilbert09/talyn/pull/119), and [#121](https://github.com/Gilbert09/talyn/pull/121).

## Local setup

Use Node.js 22.23.4 and npm 10.9.9, or a compatible version from `package.json`.
Run installation commands from the repository root. Keep one root lockfile.

```sh
npm ci --ignore-scripts
npm run mobile:build:packages
npm run mobile:start
```

Use Expo Dev Client. Expo Go does not validate this app's native configuration.
The app uses Expo SDK 58, React Native 0.88.1, and React 19.3.0.
SDK 58 lists NetInfo 12.0.1 and AsyncStorage 2.2.0 in `expo/bundledNativeModules.json`.
Supabase 2.103.3 matches the existing apps. Pin updates until callback and cleanup tests pass with the new version.

With no configuration, development and preview builds show a setup screen.
No production credentials are required for exports or tests.
To test sign-in, supply all four public values below for an approved test environment.
Use your own account. Do not put private test accounts in the repository.

## Public configuration

Set these values before native generation, Metro startup, or an export. Restart Metro after changes.
Expo places the values in public app configuration. Every `EXPO_PUBLIC` value is public.
Use a Supabase publishable key or legacy anon key. Never use a secret key or service-role key.

| Variable | Required value |
| --- | --- |
| `EXPO_PUBLIC_API_ORIGIN` | Backend origin without a path, query, or trailing slash. |
| `EXPO_PUBLIC_SUPABASE_URL` | Supabase project origin without a path or query. |
| `EXPO_PUBLIC_SUPABASE_KEY` | Public publishable key or legacy anon key. |
| `EXPO_PUBLIC_AUTH_CALLBACK_URL` | Exact callback URL for this environment, ending in `/callback`. |

Set `APP_ENV` to `development`, `preview`, or `production`. Development is the default.
Production configuration fails if any public value is missing. Production requires HTTPS for all three URLs.
Only development permits HTTP API and Supabase origins for local services.
Callbacks permit no credentials, explicit non-default port, query parameters, or fragments.

| Environment | Candidate iOS and Android ID | Default scheme | Callback configuration |
| --- | --- | --- | --- |
| Development | `dev.talyn.mobile.development` | `talyn-mobile-development` | `talyn-mobile-development://auth/callback` |
| Preview | `dev.talyn.mobile.preview` | `talyn-mobile-preview` | `talyn-mobile-preview://auth/callback` |
| Production | `dev.talyn.mobile` | `talyn-mobile` | An explicitly approved HTTPS host with `/callback`. |

These identifiers are candidates. Store availability and organization ownership remain unverified.
`TALYN_MOBILE_IOS_BUNDLE_ID`, `TALYN_MOBILE_ANDROID_PACKAGE`, and `TALYN_MOBILE_SCHEME` replace the complete identity values.
Overrides receive no automatic suffix. Keep them separate between environments.
A custom callback must use the configured app scheme. No callback URL is inferred from an incoming link.

For each Supabase project, add only its exact callback URL to the redirect allowlist.
For the default test identities, these entries are:

```text
talyn-mobile-development://auth/callback
talyn-mobile-preview://auth/callback
```

Add the approved production HTTPS callback verbatim after its host is confirmed.
Do not add wildcards. Retain the existing web and desktop entries.
GitHub's provider callback remains the Supabase project callback, rather than a mobile scheme.
The app does not merge identities by matching email text.

## Callback and storage behavior

The app uses Supabase PKCE and a system authentication session through `expo-web-browser`.
It never uses a WebView. `skipBrowserRedirect` keeps browser control in the native app.
Expo Crypto supplies secure random values and SHA-256 when the runtime lacks these APIs.
The integration test checks an actual Supabase S256 challenge and verifier exchange.

SecureStore must pass a read, write, and removal check before Supabase is created.
The asynchronous adapter stores sessions, refresh tokens, PKCE verifiers, and attempt metadata in SecureStore.
It uses `WHEN_UNLOCKED_THIS_DEVICE_ONLY` and no biometric requirement.
ASCII chunks stay below 1800 bytes. A secure journal and an atomic manifest replace complete values.
Interrupted writes retain the previous complete value or the new complete value.
Recovery removes unused chunks. Storage failure blocks sign-in instead of using plaintext storage.
See the [implementation threat assessment](../../docs/MOBILE_APP_PLAN.md#phase-2-implementation-evidence).

One pending attempt records the expected callback, start time, and exchange phase in SecureStore.
Supabase owns OAuth state and the PKCE verifier. The app does not invent a second OAuth state value.
Callbacks require the exact configured scheme, host, and path. Extra, duplicate, and malformed parameters fail safely.
The attempt expires after five minutes. The app claims a code before exchange and exchanges it once.
A cold callback requires the saved attempt and verifier.
A restart after an exchange starts requires a fresh attempt if no session was saved.
Cancel, timeout, rejected exchange, and logout remove pending attempt data.
Native intent handling removes callback parameters before navigation.
The callback route never reads OAuth parameters from route state.

AsyncStorage contains only the selected workspace ID, scoped by environment and Supabase user ID.
The workspace list stays in memory. Selection is checked against the current workspaces API after restoration.
Failed validation blocks access. Revoked access removes the saved selection.
No transcript, repository data, token, or verifier is cached in AsyncStorage or a query cache.

## Native lifecycle and account boundaries

`@talyn/client/native` receives token and recovery functions from the auth controller.
AppState and NetInfo provide active/suspended and online/offline/unknown states.
Unknown reachability permits a request. It does not prove internet access.
Supabase refresh stops while suspended or offline. The shared client owns concurrent 401 recovery.
No workflow socket is opened in this phase. Later workflows can use the configured native client.

Transient network errors, timeouts, rate limits, unknown auth failures, and 5xx responses retain the account.
Only explicit refresh-token rejection permits automatic sign-out.
Unknown refresh errors become retryable responses before Supabase can discard the stored session.
Auth requests have a 15-second deadline, including the response body.
User sign-out remains available offline. It clears local state even when remote logout fails.
Offline sign-out does not promise immediate server revocation.

Logout, deletion, account changes, and environment changes reset sockets and invalidate old token lookups and REST requests.
They clear workspace preferences and user memory. Environment changes also clear the previous SecureStore namespace.
Delayed callbacks cannot restore a signed-out account.
Native listeners and auth subscriptions are removed when the runtime is disposed.
Disposed storage rejects stale SDK reads, writes, and removals. Refresh start and stop operations run in order.

## Account deletion and support

Settings uses `users.wipeMe()` and the existing `DELETE /users/me` contract.
A native destructive confirmation describes the loss and makes Cancel the preferred action.
HTTP 409 means the account is the last administrator of a paying team.
The app asks the person to add another administrator or cancel the team subscription through Talyn on the web.
It keeps the account signed in when deletion is blocked or fails.

Success clears local secure auth data, workspace selection, sockets, and user memory.
The sign-in screen confirms deletion of Talyn account data.
The backend removes the user row and owned workspaces. Auth-provider deletion and billing cancellation remain best effort.
A success response does not prove removal from Supabase, billing providers, backups, or external integrations.
No backend change or completion-tracking contract is included in this phase.

Before release, publish a support and deletion page with an escalation path for partial deletion.
The privacy owner must confirm retention periods and deletion completion checks.
Confirm any separate Google Play deletion URL requirement before submission.
Never ask a person to send an access token, refresh token, verifier, or callback URL to support.

## Native builds

Android needs Android Studio and its SDK. iOS needs macOS and Xcode.

```sh
npm run mobile:android
npm run mobile:ios
```

These commands generate native projects and install a development build.
Generated `ios/`, `android/`, `.expo/`, and export output stay out of git.
EAS profiles preserve separate development, preview, and production identities.
Confirm organization ownership and link an approved EAS project before an EAS build.
This change supplies no signing credentials, EAS tokens, store uploads, or OTA updates.

An explicit HTTPS callback configures iOS Associated Domains and an exact Android intent filter.
Expo's `preferUniversalLinks` enables the HTTPS authentication callback on iOS 17.4 and later.
No AASA or `assetlinks.json` file is added because production identifiers are unverified.
A configured domain or a mock callback does not prove universal-link verification.
Confirm the production iOS minimum version and test the exact signed binary before release.

## Checks

```sh
npm run mobile:build:packages
npm run mobile:check:graph
npm run mobile:expo:check
npm run mobile:doctor
npm run mobile:lint
npm run mobile:typecheck
npm run mobile:test
npm run mobile:export:smoke
npm test -w @talyn/client
npm run lint
npm run typecheck
```

Mobile tests cover storage failures, callback validation, cancellation, restarts, refresh recovery, account crossover, lifecycle, workspace access, deletion, and navigation gates.
They include a real Supabase client with a fake HTTP transport. They do not authenticate a production account.
The export command creates both iOS and Android bundles without signing credentials.
Existing web and desktop auth tests must also pass before review.

## Device and release gates

- Resolve Apple App Review 4.8 before iOS submission. GitHub remains the only provider.
  Obtain a written exception rationale, or approve Sign in with Apple and an explicit identity-linking design.
- Confirm production app identifiers, callback host, Apple Team ID, Android signing certificates, and signing ownership.
  Publish matching AASA and `assetlinks.json` files, then verify both signed apps on real devices.
- Test GitHub login, browser cancel, expired codes, warm/cold callbacks, process death, lock/unlock, refresh, logout, deletion, and account switching.
  Use the minimum supported OS versions and representative large Supabase sessions.
- Review the storage threat assessment. Check interrupted writes, native value limits, backup exclusions, restore behavior, and iOS Keychain persistence after uninstall.
- Test VoiceOver, TalkBack, 200 percent text, keyboard focus, dark mode, contrast, rotation, tablets, and confirmation focus.
  Auth transitions disable animation. Native controls retain platform text scaling and focus behavior.
- Complete signed archives, EAS builds, TestFlight and Play internal testing, store privacy forms, retention disclosures, support pages, and store review.

No physical device, simulator, emulator, live OAuth account, universal-link association, signed archive, or store review was tested in this sandbox.
Use the native preview to inspect sign-in, workspace selection, and Settings after test configuration is supplied.
