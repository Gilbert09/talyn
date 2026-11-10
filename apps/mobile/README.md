# Talyn mobile MVP

The app supports GitHub sign-in, workspace selection, conversations, and pull request status on iOS and Android.
Sessions, Threads, Attention, and notifications use the authenticated native client.
See [the mobile plan](../../docs/MOBILE_APP_PLAN.md), [#116](https://github.com/Gilbert09/talyn/pull/116),
[#119](https://github.com/Gilbert09/talyn/pull/119), [#121](https://github.com/Gilbert09/talyn/pull/121),
[#126](https://github.com/Gilbert09/talyn/pull/126), [#128](https://github.com/Gilbert09/talyn/pull/128),
and [#129](https://github.com/Gilbert09/talyn/pull/129).

## Beta and store release

Use [the release runbook](../../docs/MOBILE_RELEASE.md) for exact configuration, secrets, signing, updates, and submission steps.
Use [the release checklist](../../docs/MOBILE_RELEASE_CHECKLIST.md), [store asset inventory](../../docs/MOBILE_STORE_ASSETS.md),
and [Maestro device flows](e2e/README.md) before beta and each store candidate.
Merge #128, then #129, then this release change. Do not queue this stacked change before its parents.

Development and preview remain useful without production secrets.
Internal beta and production require explicit identities, public URLs, project configuration, and a reserved build number.
The mobile package supplies the version. Both stores use `MOBILE_BUILD_NUMBER` with local EAS version management.
Every profile uses a fingerprint runtime. Preview, internal-beta, and production builds run unsigned EAS updates.
The development client loads from Metro and has updates off.
Local plans have no side effects. Execution requires the protected manual workflow on main.

```sh
npm run mobile:release:check
npm run mobile:test:release
npm run mobile:native:check
npm run mobile:release:plan -- build preview android --dry-run
```

Native checks generate all four profiles with inert fixtures. Remove only disposable generated native directories before running them.
No hosted EAS build, signed artifact, upload, production update, store review, or device result is supplied by these checks.
Complete the documented account, policy, domain, privacy, signing, and physical-device gates before release.

## Notifications

See [push operations](../../docs/MOBILE_PUSH_NOTIFICATIONS.md) for backend configuration, worker limits, retention, and activation gates.

Open Settings after sign-in and workspace selection. Read the explanation, then select **Enable notifications on this device**.
The app requests operating system permission only after that action.
Permission denial does not block any workflow. Settings shows denied, disabled, failed, and unavailable states.
Global and category choices apply to the selected workspace. Quiet hours use the saved IANA timezone.
The sensitive preview choice is reserved. Every current alert uses generic text.

Push needs a physical device and a development build.
The config uses the Talyn EAS project (`@talyn-app/talyn-mobile`) unless `EXPO_PUBLIC_EAS_PROJECT_ID` names another one.
The public configuration exposes it as `extra.eas.projectId`. The config rejects an invalid ID.
No provider credential belongs in public configuration or this repository.
The protected release workflow owns signing and submission operations. Credentials remain in EAS or approved secret custody.

The device stores only the installation ID in SecureStore with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`.
Expo tokens stay in memory during registration. They never enter AsyncStorage, route state, logs, or crash fields.
Each account and environment has a separate installation key.
Registration requires authentication, a validated workspace, workspace opt-in, device opt-in, and a real token.
Resume and token rotation renew registration without another permission prompt.
Reinstall creates a new installation when secure storage is empty. iOS Keychain can retain an ID after uninstall.
The server enforces ownership and active token identity in either case.

Sign-out removes the current installation before it clears local authentication when the server is reachable.
Offline removal and remote failures do not block local sign-out. Local credentials and installation identity are cleared.
The server keeps token ownership and expires stale installations. It does not let another account take an active token.
Account deletion removes all installations on the server. Workspace access is checked again before dispatch.
Environment changes clear the previous local installation identity. Old server registrations expire if removal is unavailable.

Notification taps retain one pending event in memory while authentication and workspace validation finish.
The app checks the event through the authenticated API, then fetches the current authorized entity before navigation.
Expired events, deleted entities, and wrong accounts show a generic recovery message.
Wrong-workspace events wait for an authorized workspace selection. Duplicate event IDs do not navigate twice.
Taps only open Sessions, Threads, or Attention. They do not execute mutations.
Foreground alerts stay quiet when their target is visible. Notifications can arrive late, twice, or never.
Normal snapshots and foreground recovery remain authoritative. No payload is persisted by the app.

### Native configuration review

`npx expo config --type introspect --json` checks the generated plugin results.
The notification plugin adds the iOS `aps-environment` entitlement.
Its mode is `development` for development clients and `production` for preview and store profiles.
It does not add `UIBackgroundModes=remote-notification`. No background task is registered.
Android's notification library declares `POST_NOTIFICATIONS` and `RECEIVE_BOOT_COMPLETED`.
The app blocks `RECEIVE_BOOT_COMPLETED` because it does not schedule local notifications.
Five Android channels use private lock-screen visibility: session updates, PR reviews, CI failures, merge readiness, and human input.
The OS still controls lock-screen visibility and permission presentation.
Introspection does not replace review of the final merged Android manifest and signed iOS entitlements.

### Release and privacy gates

Privacy owners must approve Expo Push Service as a processor before enabling production dispatch.
Review its retention, subprocessors, service region, deletion behavior, and contractual terms.
Update Apple App Privacy and Google Play Data safety disclosures for device identifiers and notification delivery.
Confirm those disclosures match token retention and provider processing in the deployed backend.
No ATT prompt, advertising identifier, or cross-app tracking is added.
PostHog analytics is first-party product analytics (Tom's call, 2026-11-10). See "Analytics" below.
Do not approve sensitive previews without another payload and privacy review.

Physical iOS and Android checks remain required. Test foreground, background, terminated, cold-start, and delayed notifications.
Test denial, OS settings changes, token rotation, reinstall, several devices, account switching, and offline sign-out.
Test workspace revocation, deleted targets, duplicate taps, and expired events against a live backend.
Test Android channels and iOS notification settings with VoiceOver, TalkBack, and large text.
Verify final entitlements, manifest permissions, native provider credentials, and delivery receipts with signed device builds.
Exports and mocked tests do not prove physical delivery or store acceptance.

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
To test sign-in, supply the four sign-in values below for an approved test environment.
Push uses the Talyn EAS project ID by default.
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
| `EXPO_PUBLIC_EAS_PROJECT_ID` | Optional public EAS project UUID. The default is the Talyn project `69499768-c478-44c0-8588-355c674515df`. |
| `EXPO_PUBLIC_TALYN_POSTHOG_KEY` | Optional PostHog project key (`phc_`). With no key, analytics, replay, and error tracking are off. |
| `EXPO_PUBLIC_TALYN_POSTHOG_HOST` | Optional PostHog ingestion origin. The default is `https://us.i.posthog.com`. |

`POSTHOG_CLI_API_KEY` is a build secret, not a public value, and never enters the app.
It is a PostHog personal API key (`phx_`) that uploads source maps and native symbols. See the release runbook.

Set `APP_ENV` to `development`, `preview`, or `production`. Development is the default.
Production configuration fails if any public value is missing. Production requires HTTPS for all three URLs.
Only development permits HTTP API and Supabase origins for local services.
Callbacks permit no credentials, explicit non-default port, query parameters, or fragments.

| Environment | Candidate iOS and Android ID | Default scheme | Callback configuration |
| --- | --- | --- | --- |
| Development | `dev.talyn.mobile.development` | `talyn-mobile-development` | `talyn-mobile-development://auth/callback` |
| Preview | `dev.talyn.mobile.preview` | `talyn-mobile-preview` | `talyn-mobile-preview://auth/callback` |
| Production | Explicit approved identifiers are required. | An explicit approved scheme is required. | An explicitly approved HTTPS host with `/callback`. |

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
EAS profiles preserve separate development and preview identities. Internal beta and production share the approved store identities.
Confirm organization ownership and link an approved EAS project before an EAS build.
The repository holds no signing credentials or EAS tokens. Store uploads stay on the protected release workflow.

## OTA updates

Each push to `main` that changes the app, `packages/client`, `packages/shared`, or the lockfile publishes an unsigned EAS update
to the `preview` and `internal-beta` channels (`.github/workflows/mobile-update.yml`). Production updates need an approved manual dispatch.
Set the repository variable `MOBILE_UPDATES_AUTO=0` to stop automatic publishing.

The app checks at cold start and on return to the foreground, at most every 15 minutes (`src/features/updates/`).
It downloads in the background, then shows **Update ready** with **Restart**. It never restarts by itself, so a draft is safe.
A closed banner leaves the update for the next cold start. Settings → About shows the channel, runtime, running update,
and **Check for updates**. Update errors show only there. The development client and web never check.

An update can change JavaScript and assets only. A new native module, config plugin, or native field in `app.config.ts`
changes the native fingerprint, so its update reaches no installed app. Ship that change in a new binary.
Updates are unsigned by decision (2026-11-09), because EAS code signing needs a paid EAS plan. EAS HTTPS delivery and
access to `EXPO_TOKEN` and the Expo project protect them. Signing later needs that plan, a certificate in the config, and a new binary.
See [the release runbook](../../docs/MOBILE_RELEASE.md#automatic-updates-for-preview-and-internal-beta) for secrets, checks, and rollback.

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

## Implemented workflow

The native tabs remain Sessions, Threads, Attention, and Settings.
Lists show the selected workspace. Pull-to-refresh uses authoritative REST snapshots.
Session and thread lists show scope, status, latest activity, and supplied text response gates.
The contract supplies no shared unread marker. The app does not invent one.
Thread details show the conversation, child sessions, and supplied pull request links.
Session details show chat selection, readiness, status, transcript history, and related work.
Model, effort, and plan mode are shown as current values.
The app does not offer capability choices without a contract that validates available choices for that session.

Attention filters existing PR rows for review requests, human gates, and authored failures.
The list can also show all open pull requests.
PR details show review, CI, mergeability, stack, session relation, and queue history.
Missing provider details remain explicit. Unknown values remain Unknown within their status domain.
The queue and timeline are read only.
External websites require confirmation. Only HTTP and HTTPS URLs without credentials are allowed.
Rich reviews use the external website.

The composer sends text to existing chats. It sends no attachments or unsupported gate actions.
It requires a confirmed connection and current authorized session state.
Sending, Queued on server, Sent, Failed, and Delivery unknown have separate labels.
An acknowledgement records the server response. It does not prove that the agent completed the message.
A queued acknowledgement cannot later be correlated without a server message identifier.
The app shows the current server queue separately.

A send has a 30-second local deadline. A timeout or transport failure makes delivery unknown.
The underlying request can still reach the server after this deadline.
The app refreshes transcript history and the server queue before it offers manual resend.
Successful reconciliation does not change unknown delivery to Sent.
Manual resend requires confirmation because the server can receive a duplicate.
Transcript text is never used to infer delivery. Offline messages are never queued on the device.

## Memory and recovery

`src/workflow/store.ts` is the narrow server-state owner. No extra cache library or persistence adapter is needed.
It coalesces reads, tracks visible resources, and rejects late responses after a scope change or deletion.
Every cache key includes schema version, environment namespace, authenticated user, workspace, entity, and identifier.
The namespace includes the configured origins and callback.
Auth and workspace changes clear snapshots, delivery state, selection, reading positions, and drafts.
Account deletion uses the same boundary cleanup.
Navigation and background resume retain drafts within the same account and workspace.
Process restarts discard all workflow content.
Only phase 2 auth values and the workspace identifier use persistent storage.

The cache retains at most 32 inactive or active resources under normal navigation.
Active resources and pending requests are protected from eviction.
Lists use full endpoint snapshots because the current list methods expose no paging cursor.
The app does not simulate pagination by slicing those responses.
FlatList virtualizes sessions, PRs, child sessions, queue rows, and transcripts.
A transcript retains at most 1200 events and approximately 2 MB of serialized UTF-16 content.
Each displayed text block is limited to 16000 characters. Code uses selectable chunks of at most 4000 characters.
A partial history window has explicit labels and controls for older and latest history.
Titles and list data still have the size of the server snapshot. Measure large accounts before release.

REST establishes transcript cursors. Socket events are deduplicated by chat and sequence.
Missing ranges are recovered with forward REST history. Older history uses the supported backward cursor.
Each recovery reads at most four forward pages of 200 events after its initial page.
A larger backlog remains stale until another refresh. Recovery never loops without a bound.
The shared transport retains its existing single GET transport retry and 401 recovery.
The workflow adds no automatic read retry loop or message retry.
Socket invalidations are coalesced over 250 milliseconds.
Only watched resources with pending invalidation need recovery.
Suspension or loss of connectivity marks visible snapshots stale.
Foreground resume and socket restoration share that recovery batch.
The shared client alone reconnects and restores subscriptions, including the threads capability.
Non-replayable socket notifications are not treated as durable history.

Detail routes fetch current authorized state before they render cached product content.
Cold destinations survive sign-in and workspace selection in memory.
Warm destinations use the same authorization path. Wrong-workspace, missing, and inaccessible items show recovery actions.
The app does not automatically select a workspace from an untrusted entity link.

## Workflow checks

Run these commands from the repository root:

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --ignore-scripts
npm run mobile:build:packages
npm run mobile:check:graph
npm run mobile:expo:check
npm run mobile:doctor
npm run mobile:lint
npm run mobile:typecheck
npm run mobile:test
npm test -w @talyn/client
npx vitest run packages/shared/tests/transcriptInterruptions.test.ts packages/shared/tests/transcriptPullRequest.test.ts
npm run lint
npm run typecheck
npm run mobile:export:smoke
git diff --check
```

The Expo export command creates separate iOS and Android Hermes bundles.
Run the existing browser regressions:

```sh
npm test -w @talyn/web -- src/__tests__/wsConnectRace.test.ts src/__tests__/wsHeartbeat.test.ts src/__tests__/wsRejectionBackoff.test.ts src/__tests__/terminalDockSocket.test.tsx src/__tests__/posthogAuthMethod.test.tsx src/__tests__/workbenchTranscript.test.tsx
```

Run the existing desktop transport, auth, and transcript regressions:

```sh
npm test -w @talyn/desktop -- --runInBand src/__tests__/api401Recovery.test.ts src/__tests__/apiNetworkError.test.ts src/__tests__/authStorage.test.ts src/__tests__/authStorageAdapter.test.ts src/__tests__/posthogAuthMethod.test.tsx src/__tests__/presenceHeartbeat.test.tsx src/__tests__/workbenchTranscript.test.tsx
```

Desktop and web use the shared socket implementation. The client suite covers that implementation and its browser lifecycle.
These selected tests need no database or Docker stack.
The mobile fixtures include 10000 sessions and 10000 transcript events.
Component tests assert that fewer than 50 list or transcript rows render from those fixtures.
They establish a rendering bound in the test host. They do not measure device frame rate or memory.

## Physical-device and performance checks

No physical-device or live-backend workflow result is claimed.
Use the native preview with configured test services to inspect all four tabs and detail views.
Complete these checks on signed iOS and Android development builds before beta.
Use the minimum supported OS versions, a small phone, and a tablet or large Android window.
Use authorized test accounts supplied through the normal sign-in flow. Do not add credentials to fixtures.

| Check | Procedure and evidence to record |
| --- | --- |
| Cold start | Force-stop the app. Record launch-to-interactive time for ten starts. Include auth restoration and workspace validation. |
| List load | Record request start to first readable row. Use small and large workspaces. Record median and p95. |
| Scroll | Record platform frame traces during a 60-second list and transcript scroll. Include streaming output and rotation. |
| Memory | Record native resident memory before and after ten detail visits, transcript paging, resume, and workspace changes. Check retained views. |
| Message latency | Record send press, server acknowledgement, queue entry, and first response separately. Test network loss after send. |
| Recovery | Suspend during streaming. Drop socket events. Resume online and offline. Check cursors, stale labels, queue state, and one reconnect. |
| Account boundaries | Switch workspace and account during reads and sends. Revoke access. Delete an item. Check data and draft cleanup. |
| Accessibility | Use VoiceOver and TalkBack on tabs, lists, transcript, composer, links, errors, stale labels, and refresh controls. |
| Adaptation | Test 200 percent text, RTL, dark mode, increased contrast, reduced motion, external keyboards, safe areas, and keyboard insets. |
| Reading position | Rotate and resize while reading older history. Switch chats and tabs. Check the reading anchor and draft. |
| Deep links | Test cold and warm session, thread, and PR links through sign-in and workspace selection. Test wrong-workspace and deleted targets. |

New controls have 48-point minimum targets. Native text retains platform scaling and selectable code.
Status uses words. Streaming rows have no live announcements. Delivery changes use a polite live region.
Navigation and scroll updates use no custom animation.
The transcript follows new output only near its end. Jump to latest restores that mode.
Device tests must confirm screen-reader focus and reading position during streamed updates.
The test host cannot prove native accessibility, keyboard behavior, universal links, performance, or app store acceptance.

Phase 4 adds notifications, registration, preferences, and a durable worker. Physical delivery still needs device evidence.
Signed release archives, universal-link association, privacy disclosures, store operations, and review remain release gates.
The phase 2 Apple login and deletion-completion gates remain open.

## Mobile interface

The mobile theme follows the paper, ink, and clay colors in the web and desktop apps.
Semantic tokens live in `src/theme/tokens.ts`.
Muted ink and action clay are darker in light mode to keep small text readable on paper.
Shared controls live in `src/components/UI.tsx`.

Native tabs keep their platform behavior.
`ScreenContainer` handles safe areas, including the tab bar, through React Native Screens.
Automatic tab content insets are disabled to prevent duplicate padding.
System fonts can scale without a limit.
Rows and badges wrap, and content has a maximum width on tablets.

Rebuild the development client after this change because it adds `expo-navigation-bar`.
The module controls Android system navigation icons.
The root view and status bar follow the system theme.

### Review on a device

The sandbox tests cannot verify native layout, keyboards, or screen reader behavior.
Use the device preview to check these items before release:

- Open every route in light and dark mode.
- Check sign-in, callback, restore, offline, error, empty, and unavailable page states.
- Set text to 200 percent on a narrow Android phone.
- Check long workspace names, repository names, titles, badges, and messages.
- Open a conversation and show the keyboard. Check the input, send action, and bottom tabs.
- Switch conversations. Check drafts, older messages, and scroll restoration.
- Check status and navigation icons with gesture navigation and button navigation.
- Check the same routes on a tablet and in landscape.
- Use VoiceOver or TalkBack to select a workspace and read a conversation.
- Check notification permissions, quiet hours, external links, and the account deletion confirmation.
- Enable reduced motion. Check that sign-in has no transition animation.

The floating Expo development gear belongs to the development client.

## Analytics

Tom's call (2026-11-10): the app uses PostHog for product analytics, session replay, and error tracking, like web.
This reverses the MVP rule of no analytics or replay SDK.
The official SDK is `posthog-react-native`, with `@posthog/react-native-plugin` for session replay and native capture (the older `posthog-react-native-session-replay` package is deprecated).
`src/lib/analytics.ts` holds the guarded helpers. They do nothing in a build with no `EXPO_PUBLIC_TALYN_POSTHOG_KEY`.

- The distinct ID is the Supabase user ID, as on web. Email and GitHub username are person properties. Sign-out resets the identity.
- Every event carries `client: 'mobile'`, `platform`, `app_version`, `app_build`, `update_id`, `update_channel`, `environment`, and `workspace_id`.
- Each route change records a `$screen` named by its route pattern, such as `/pulls/[id]`. No IDs go in the name.
- Touches are autocaptured by component name and test ID only. Text children and accessibility labels are not captured.
- Session replay masks all text, inputs, images, and sandboxed views. It records no console logs or network requests. It is off in development builds.
- Exception autocapture runs in preview and production builds. Each exception goes through the shared `exceptionDropReason` and `isConnectivityMessage` rules, like web.
- Native crash capture (iOS, Android JVM, and Android NDK on API 31 and later) runs in preview and production builds. Native crashes skip `before_send`. The opt-out still stops them.
- Readable stack traces need uploaded symbols. With the `POSTHOG_CLI_API_KEY` secret, each OTA update uploads its Hermes source maps. Each EAS build uploads its source maps, dSYMs, R8 mapping and NDK symbols. Without the key, uploads skip with a notice. See [PostHog error tracking symbols](../../docs/MOBILE_RELEASE.md#posthog-error-tracking-symbols) for the secret and where to create it.
- Settings > Account > "Share usage data and session replays" turns it all off. The choice is saved on the device and read before the first event.
- Apple tracking stays false: there is no cross-app tracking, so there is no ATT prompt.
- Before store submission, the App Store privacy answers and Play Data safety must declare analytics, diagnostics, and the user ID.
- Event names and property keys match web. Never put titles, prompts, transcripts, code, or repository names in a property.
