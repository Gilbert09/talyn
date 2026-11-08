# Native mobile client plan

Status: approved plan; phases 1 through 4 have implementation evidence below. Research date: **2026-11-08**.
Scope: production planning for iOS and Android in `Gilbert09/talyn`.
The original research is preserved below. Implementation evidence records the current mobile foundation.

## Phase 4 implementation evidence

This phase adds durable mobile push delivery through Expo Push Service.
It stacks on [#128](https://github.com/Gilbert09/talyn/pull/128), which must merge first.
Earlier work is [#116](https://github.com/Gilbert09/talyn/pull/116),
[#119](https://github.com/Gilbert09/talyn/pull/119), [#121](https://github.com/Gilbert09/talyn/pull/121),
and [#126](https://github.com/Gilbert09/talyn/pull/126).

- Shared version 1 contracts define installations, preferences, categories, quiet hours, receipts, and internal destinations.
  Native client methods use the existing authenticated transport. Existing exports remain available.
- Backend storage holds encrypted device tokens, fingerprints, preferences, an outbox, and audit events.
  Several devices can belong to one account. Active token identities cannot move between accounts through registration.
  Authenticated routes enforce ownership and current workspace access. Responses contain no provider token.
- A durable transition journal records approved changes to authoritative session and PR state.
  A bounded reconciliation worker converts journal entries into outbox events with deduplication.
  This path covers webhook and poll updates without one notification for each unchanged poll or transcript token.
- Dispatch checks current access, preferences, quiet hours, expiry, and installation status.
  Leases allow crash recovery. Temporary failures use bounded retries.
  Expo tickets and receipts have separate processing. A ticket does not prove delivery.
  Permanent token errors disable the installation.
- Alerts contain generic text. Data contains only the schema version, opaque event ID, category, and internal destination.
  Sensitive previews remain reserved. Enabling that preference does not add private text.
  Logs, audit events, and metric labels contain no tokens or private content.
- Settings explains notification value before the operating system prompt.
  Permission requests require an explicit action. Denial leaves product workflows available.
  Settings includes category, quiet hour, timezone, and preview controls.
  Registration requires authentication, a validated workspace, opt-in, and a physical device token.
- Tap handling waits for authentication and workspace validation.
  It resolves the event through the backend and fetches authoritative entity state before navigation.
  Duplicate taps are deduplicated in memory. Payloads are not persisted.
  Notification taps do not execute product mutations.

See [mobile operations](MOBILE_PUSH_NOTIFICATIONS.md) for configuration, retention, schedules, and processor approval gates.
See the [mobile README](../apps/mobile/README.md) for checks and physical-device procedures.
Mocks and exports cannot prove operating system delivery, signed native permissions, or store acceptance.
Expo processor approval, Apple privacy disclosures, and Google Data safety review remain activation gates.
Release automation, beta operations, signing, and store submission remain **phase 5**.

## Phase 3 implementation evidence

The read-focused workflow replaces the example screens in `apps/mobile`.
This section records implemented facts. It supersedes proposed content persistence and notification scope for this phase.
The earlier work is [#116](https://github.com/Gilbert09/talyn/pull/116),
[#119](https://github.com/Gilbert09/talyn/pull/119), [#121](https://github.com/Gilbert09/talyn/pull/121),
and [#126](https://github.com/Gilbert09/talyn/pull/126).

- Sessions and Threads use the existing workbench kinds and native client methods.
  Lists show scope, status, activity, and supplied text response gates.
  No shared unread contract is invented. Lists use full snapshots because these endpoints have no paging cursor.
- Session details show chat selection, transcript history, live events, readiness, current capabilities, and linked work.
  Thread details include child sessions and their pull request links.
  Current model, effort, and plan mode are read only. Capability choices need a validated per-session contract.
- A narrow memory store owns server snapshots, cursors, drafts, delivery state, selection, and reading positions.
  Keys contain schema version, environment, authenticated user, workspace, entity, and identifier.
  Runtime boundaries clear all workflow state on auth or workspace changes, logout, and successful account deletion.
  No workflow content survives a process restart. No new persistence adapter is added.
- REST snapshots remain authoritative. Socket events update transcripts and invalidate watched resources.
  The shared client owns reconnect, subscription restoration, reachability, and suspension.
  Resume and reconnect coalesce recovery. Data remains stale until a successful snapshot resolves its invalidation.
  The workflow adds no second reconnect loop or automatic message retry.
- Transcript events use chat and sequence for deduplication.
  Gaps use existing forward history. Older pages use the existing backward cursor.
  Recovery has a four-page forward bound after the initial page. Larger backlogs require another refresh.
  Late responses cannot restore deleted data or cross an auth or workspace boundary.
- FlatList virtualizes product lists, child sessions, transcript rows, and server queue rows.
  Transcript windows retain at most 1200 events and approximately 2 MB of serialized UTF-16 content.
  Text blocks are limited to 16000 characters. Selectable code chunks are limited to 4000 characters.
  Partial windows have recovery controls. Large fixtures assert fewer than 50 rendered rows in the test host.
- Text messages use existing chats and supported text responses.
  Sending, Queued on server, Sent, Failed, and Delivery unknown remain distinct.
  Unknown delivery requires refreshed history and server queue state before manual resend is offered.
  Confirmation warns about duplicate delivery. Transcript text is never matched to infer delivery.
  Offline sends are blocked. Drafts remain in memory within the same auth and workspace scope.
- Attention reuses existing PR rows and status contracts.
  PR details show supplied review, CI, mergeability, human gate, stack, session relation, queue state, and timeline.
  Unknown values remain Unknown within their status domain. No PR mutation is exposed.
  Missing provider detail is separate from a missing or inaccessible PR.
- Native text renders prose, code, system events, and interruption states.
  No raw HTML is rendered. External HTTP and HTTPS links require confirmation.
  Controls use labels, disabled states, and minimum 48-point targets.
  Streaming content has no live announcements. Important delivery changes use a polite live region.
  Text retains native scaling. Navigation has no custom animation.
- Cold and warm product links use current authorized detail reads.
  Pending destinations survive authentication and workspace selection in memory.
  A wrong-workspace link shows recovery instead of selecting an unvalidated workspace.

No backend, shared contract, or client method change was required.
No dependency was added. The existing root lockfile remains the dependency authority.
The [mobile README](../apps/mobile/README.md) lists exact check commands and manual procedures.
Checks cover mobile auth and workflow, client transport, shared transcripts, and selected web and desktop regressions.
Expo graph checks, installation checks, Doctor, lint, typecheck, and both platform exports are required before publication.

Physical iOS and Android devices remain a gate for accessibility, performance, keyboard behavior, and reading position.
Live-backend auth, streaming, revocation, delivery uncertainty, queue state, and resume need device evidence.
Exports and mocks do not prove universal links, native accessibility, signed archives, or store review.
The phase 2 Apple login, production identity, privacy, and deletion-completion gates remain open.
Push notifications remain **phase 4**. Store release operations remain **phase 5**.

## Phase 2 implementation evidence

The native adapter and Expo shell landed in [#119](https://github.com/Gilbert09/talyn/pull/119)
and [#121](https://github.com/Gilbert09/talyn/pull/121).
The original plan is [#116](https://github.com/Gilbert09/talyn/pull/116).
This section supersedes proposed phase 2 choices where the implementation now supplies evidence.
It does not remove the device or store release gates.

Resolved implementation facts:

- `apps/mobile` binds Supabase 2.103.3 to asynchronous Expo SecureStore storage and PKCE.
  The client is created after a secure read, write, and removal check.
  Persistence and automatic refresh are enabled. URL session detection is disabled.
- GitHub remains the only provider. Expo WebBrowser opens a system authentication session with `skipBrowserRedirect`.
  Expo Crypto supplies secure randomness and SHA-256 for S256 PKCE.
  A real Supabase client test checks the challenge and exchange through a fake HTTP transport.
- One attempt records the exact callback, start time, and exchange phase in secure storage.
  Supabase owns OAuth state. The app validates callback parameters and claims each code before exchange.
  Duplicate callbacks share one exchange. Cold callbacks require a saved attempt and verifier.
  Attempts expire after five minutes. An interrupted exchange is not replayed after restart.
- Native intent handling strips callback parameters before navigation.
  Development and preview accept their explicit custom schemes.
  Production requires explicit HTTPS API, Supabase, and callback configuration, plus a public Supabase key.
  Builds fail when production configuration is incomplete.
- Explicit HTTPS callbacks generate Associated Domains and an exact Android intent filter.
  Expo's HTTPS authentication option requires iOS 17.4 or later.
  No association file is published. Production domain, Apple Team ID, and signing certificate evidence remain missing.
- SDK 58 lists NetInfo 12.0.1 and AsyncStorage 2.2.0 as compatible native dependencies.
  AppState and NetInfo bind the shared client lifecycle. Reachability has online, offline, and unknown states.
  Supabase refresh pauses while suspended or offline. The shared client retains its single 401 recovery sequence.
- Unknown refresh errors, 5xx responses, timeouts, and network outages retain the account.
  Automatic sign-out requires explicit refresh-token rejection from the auth service.
  Account boundaries reset sockets, invalidate requests and token lookups, and clear user memory and preferences.
- Auth restoration gates the tab shell. Workspace selection uses the existing workspaces API.
  Only the workspace ID is persisted as a non-secret preference, scoped by environment and user.
  Restoration validates access. Invalid selections are removed.
- Settings exposes account details, sign-out, and native destructive confirmation for `users.wipeMe()`.
  HTTP 409 shows the existing last-paying-team-administrator restriction.
  Successful deletion clears secure auth storage, workspace selection, sockets, and user memory.
  The sign-in screen confirms deletion of Talyn account data.
- No backend behavior changes. Sessions, Threads, and Attention remain example screens.
  Product workflows, push notifications, billing, analytics, and persistent content caches remain outside this phase.

### Storage threat assessment

This implementation uses native SecureStore for every session, verifier, and auth attempt value.
It adds no encryption algorithm or plaintext fallback.
ASCII chunks stay below 1800 bytes to cover historical native value limits.
Secure metadata records the complete chunk count and revision.
A journal records old and new revisions before writes. A single manifest replacement selects the complete value.
Recovery removes unused chunks after an interrupted write. Cleanup failures block further auth operations.
A corrupt manifest or missing chunk fails closed and shows a safe storage message.

The covered threats include partial writes, concurrent updates, Unicode size expansion, stale callback delivery, and account crossover.
Tests interrupt writes before and after manifest replacement. They also cover corrupt, missing, and unavailable storage.
The adapter serializes storage operations. Logout waits for auth operations before its final secure removal.
Each stored chunk uses `WHEN_UNLOCKED_THIS_DEVICE_ONLY` without a biometric prompt.
SecureStore supplies the platform protection. A compromised running process can still access the active session.
The adapter does not protect against a compromised operating system.

Security review and physical-device evidence remain release gates.
Test large real Supabase sessions, lock/unlock, killed processes, backup exclusions, and restore behavior.
Confirm iOS Keychain behavior after uninstall. It can retain credentials.
A mock storage driver cannot prove platform limits or secure deletion from device backups.

### Remaining auth and release gates

Apple App Review 4.8 remains a release gate. This phase does not add Sign in with Apple.
Product must approve an exception rationale or an Apple provider and identity-linking design before iOS submission.
Do not merge accounts by matching email strings.

The deletion endpoint removes Talyn data but treats Supabase deletion and billing cancellation as best effort.
Its success response does not confirm provider cleanup, backup removal, or deletion completion.
Privacy and backend owners must define completion checks, retention periods, and support escalation before launch.
Publish the support and deletion page, including any required Google Play deletion URL.
No confirmed endpoint defect required a backend change in this phase.

Confirm production identifiers, callback ownership, OS floors, EAS project, and signing custody.
Publish AASA and Android asset links only after all required identifiers are verified.
Test exact signed binaries on physical iOS and Android devices.
Cover live OAuth, cancellations, timeouts, process death, account switching, offline recovery, workspace revocation, logout, and deletion.
Also check screen readers, text growth, keyboard focus, contrast, dark mode, reduced motion, and destructive confirmation focus.
Exports and simulated callbacks do not prove universal links, native startup, signed archives, or store acceptance.
See [the mobile README](../apps/mobile/README.md) for configuration, allowlist entries, tests, and device gaps.

## 1. Reading guide and recommendation

Labels distinguish the evidence:

- **Repository fact** describes inspected code. Relative links identify that code.
- **External rule** identifies a store or operating system requirement. Its stated conditions still apply.
- **Guidance** describes advice from a platform owner. It is not automatically a store rule.
- **Recommendation** describes a proposed Talyn decision.
- **Open decision** needs an owner and an answer before the stated phase can finish.

Citations link to primary sources in [section 13](#13-primary-sources).
All sources were accessed on **2026-11-08**.
Recheck date-sensitive requirements before each store submission.
This plan does not guarantee store acceptance.

**Recommendation:** add `apps/mobile` as an npm workspace in a later PR.
Use React Native with Expo, Expo Router, and development builds from the start.
Share types and transport through `@talyn/shared` and `@talyn/client`.
Add small platform adapters before treating that client as mobile compatible.
Keep native views, navigation, lifecycle, storage, and permission handling inside the mobile app.

Start with existing sessions and threads, transcript reading, messages, PR attention, and queue status.
Add reliable push delivery before public launch.
Use Expo Continuous Native Generation (CNG) with EAS Build by default.
Keep native projects generated until a documented native requirement makes that impractical. [E06] [E07] [E09]

## 2. Repository evidence

These facts describe the inspected branch on the research date.
Existing architecture documents contain historical sections. The files below control this plan.

| Repository fact | Evidence | Planning effect |
| --- | --- | --- |
| npm workspaces list three apps explicitly and include `packages/*`. | [Root package](../package.json) | Add `apps/mobile` explicitly. Do not replace the list with a broad app glob. |
| Other app directories include marketing. It is absent from the root workspace list. | [Marketing package](../apps/marketing/package.json), [root package](../package.json) | A directory alone does not create a workspace. |
| Shared and client packages expose CJS and ESM builds from `dist`. | [Shared package](../packages/shared/package.json), [client package](../packages/client/package.json) | Build both before Metro. Preserve desktop CJS support and web ESM support. |
| The client accepts base URL, build version, token access, and session recovery callbacks. | [Client configuration](../packages/client/src/config.ts) | Mobile can bind Supabase without importing a web auth module. |
| REST uses global `fetch`, JSON envelopes, Bearer auth, and a client version header. | [Client transport](../packages/client/src/index.ts) | Prove these paths in Hermes on both platforms. |
| GET transport failures get one retry. Concurrent 401 recovery shares one promise. | [Client transport](../packages/client/src/index.ts) | Preserve this behavior. Do not add a second auth recovery loop. |
| WebSockets authenticate in the first frame. The client restores subscriptions and has heartbeat and reconnect logic. | [Client socket](../packages/client/src/index.ts), [server socket](../packages/backend/src/services/websocket.ts) | Reuse the protocol. Tokens must stay out of socket URLs. |
| Reconnect and heartbeat code calls `window` timers. Lifecycle code listens to browser events. | [Client socket](../packages/client/src/index.ts) | Native lifecycle needs an adapter. Import success alone proves little. |
| The web app uses GitHub OAuth, Supabase PKCE, and browser callback handling. | [Auth provider](../apps/web/src/components/auth/AuthProvider.tsx), [Supabase binding](../apps/web/src/lib/supabase.ts) | Create a native binding with explicit callback exchange. |
| Missing Origin is allowed. Browser origins use an exact allowlist. | [Origin policy](../packages/backend/src/services/originPolicy.ts) | Test the actual native handshake before proposing any server change. Never weaken browser origin checks. |
| Sessions and threads share the workbench model. Lists select `kinds`; transcripts have sequence cursors. | [Workbench types](../packages/shared/src/workbench.ts), [client methods](../packages/client/src/index.ts) | Use existing models. Do not invent a separate thread transport. |
| Web stores import browser layout and analytics modules. Notifications use the browser `Notification` API. | [Workbench store](../apps/web/src/stores/workbenches.ts), [notifications](../apps/web/src/lib/workbenchNotify.ts) | Extract pure logic selectively. These modules are not mobile services. |
| Account deletion exists through `users.wipeMe()` and `DELETE /users/me`. | [Client methods](../packages/client/src/index.ts), [user routes](../packages/backend/src/routes/users.ts) | Audit and expose this flow. Do not assume a new deletion endpoint is needed. |
| Deletion can reject the last admin of a paying team. Supabase deletion is best effort. | [User routes](../packages/backend/src/routes/users.ts) | Define recovery, support, and completion checks before launch. |
| No APNs, FCM, Expo device registration, or mobile notification preference contract was found. | [Client methods](../packages/client/src/index.ts), [schema](../packages/backend/src/db/schema.ts) | Push needs future backend work. Existing browser notifications do not fill this gap. |
| CI builds shared and client before the apps. Root typecheck lists workspaces explicitly. | [CI](../.github/workflows/test.yml), [root scripts](../package.json) | Add mobile checks explicitly. Keep store releases separate from desktop publishing. |

The push finding covers inspected app code, client exports, and backend routes, services, and schema.
It does not assert that no external notification service exists.

### 2.1 Client compatibility verdict

**Recommendation:** treat `@talyn/client` as reusable after adaptation, not as compatible today.
The following work belongs in separate implementation PRs.

| Assumption or path | Current evidence | Required action and proof |
| --- | --- | --- |
| Global networking | `fetch`, `WebSocket`, `URLSearchParams`, and `AbortSignal` occur in the client. | Test the used APIs in release Hermes builds. React Native supplies networking, but browser API parity is not complete. [R05] |
| Browser timers | Socket code calls `window.setTimeout` and `window.setInterval`. | Use platform-neutral timers. Test timer cleanup, delayed ticks, and stale socket generations. |
| Lifecycle | Browser focus, online, pageshow, and visibility events drive recovery. | Add an injectable lifecycle seam. Keep the browser binding. Supply native AppState and reachability from mobile. [R04] |
| Online detection | `ApiNetworkError` reads `navigator.onLine` when `navigator` exists. | Inject reachability or expose unknown state. A native `navigator` does not prove this property exists. |
| Backoff | Socket retry grows from one second to a 30-second cap. Rejections use slower retries. | Preserve rejection floors. Add bounded jitter and suspension control through one scheduler. |
| Attachments | Uploads use `Blob`; import creates a new `Blob`. | Exclude attachment upload from MVP. Test a native file adapter before adding it. |
| Admin streaming | A client path uses `Response.body.getReader()` and `TextDecoder`. | Keep admin streaming outside MVP. Do not claim streaming compatibility from normal REST success. |
| Browser storage helpers | `reviewRankingArchive.ts` uses IndexedDB. Upload helpers accept the DOM `Storage` interface. | Keep these optional helpers out of mobile paths. Use a narrow neutral storage contract if later needed. |
| Package boundaries | Client index has broad exports. Shared index exports runtime helpers, including `croner` through loops. | Audit the actual Metro graph and startup evaluation. Verify Hermes compatibility and bundle size. Avoid blanket polyfills. |
| Node assumptions | Client configuration receives environment values from its host. No direct Node built-in import was found in client source. | Keep Node environment access in build configuration. Do not reuse backend or Electron modules. |
| Singleton scope | Client config and exported socket are process-wide. | Use one account at a time. Cancel old work and clear state before account or environment changes. |

Likely files: `packages/client/src/config.ts`, `packages/client/src/index.ts`, and new adapter modules beside them.
Keep new adapter defaults compatible with web, admin, desktop, and CLI.
Add package subpath exports only if Metro evaluation proves they are needed.
Do not solve mobile compatibility by copying REST methods into `apps/mobile`.

### 2.1.1 Resolved transport adapters

The native host imports `@talyn/client/native`.
This subpath shares the REST methods and socket implementation with the existing package entry.
Both entries have CJS and ESM exports.
The native entry has no runtime import from `@talyn/shared`.
This avoids evaluating its `croner` dependency.

The existing `@talyn/client` entry keeps browser lifecycle events and browser helpers.
The native entry excludes Blob uploads, attachment Blob downloads, admin response streaming, IndexedDB archives, and DOM Storage helpers.
Native file and streaming adapters remain future work.

`configureApiClient` accepts an optional `runtime` object:

| Adapter | Resolved interface |
| --- | --- |
| Lifecycle and reachability | `lifecycle.getSnapshot()` returns `{ activity, reachability }`. Activity is `active` or `suspended`. Reachability is `online`, `offline`, or `unknown`. |
| Host events | `lifecycle.subscribe(listener)` returns a disposal function. Emit `{ type: 'state', state }` for state changes. Emit `{ type: 'wake' }` for an explicit liveness check. |
| Scheduling | `scheduler.now()` returns milliseconds. `scheduler.timeout(callback, delayMs)` and `scheduler.interval(callback, delayMs)` each return a cancellation function. |
| Networking | `fetch` accepts the standard fetch arguments. `createWebSocket(url)` returns the narrow `ClientSocket` interface. Both default to host globals. |
| Reconnect jitter | `reconnectJitter` is an optional fraction from zero to one. `random()` supplies a testable sample. Jitter only increases delays, within the 30-second cap. The default is zero. |

The native host owns AppState and reachability subscriptions.
Keep its snapshot current before emitting an event.
Unknown reachability permits recovery; offline reachability blocks socket retries.
Suspension closes the socket, cancels timers, and invalidates pending work.
One transition back to a runnable state starts one recovery path.
Repeated state events do not start duplicate recovery paths.
A canceled REST retry rejects with `ClientInactiveError`; resume does not replay that request.

Configure the client before binding account listeners or subscriptions.
Configure it again when the account or backend changes, even if the token callback stays the same.
Configuration changes cancel old recovery and clear socket subscriptions, presence, capabilities, filters, and event handlers.
Bind the next account after configuration, then call `connect()`.
`wsClient.reset()` clears socket state when configuration does not change.
`disconnect()` stops transport work and removes host listeners; it retains subscriptions and event handlers for existing consumers.
Use `dispose()` when discarding an additional `WebSocketClient` instance.

`ApiNetworkError.reachability` is the authoritative network state.
Its legacy boolean `online` stays source-compatible: true means that the network is not known to be offline.

These adapters need no Expo shell changes.
The shell PR and transport PR can land independently.
Hermes networking and device lifecycle checks remain part of the mobile application validation.

### 2.2 Safe sharing boundary

**Recommendation:** share TypeScript models, endpoint signatures, event parsers, and pure domain selectors.
Candidates include transcript deduplication, status labels, attention rules, and PR summaries.
Move a helper only after tests show that it has no UI, storage, or lifecycle dependency.
Keep initial pure selectors in `apps/mobile/src/domain` unless two clients need the same implementation.
A later `packages/domain` workspace is optional. It must not become a second API contract.

Build native screens with React Native views and text.
Do not import DOM components, Radix, shadcn, Tailwind browser styles, Monaco, xterm, or `react-router-dom`.
Do not wrap the whole web app in a WebView.
Reuse design intent and semantic colors, rather than browser component code.
The [web dependencies](../apps/web/package.json) show why direct UI reuse is unsafe.

## 3. Framework and build baseline

**External fact, date-sensitive:** Expo SDK **58** became stable on **2026-10-15**. [E26]
The official compatibility table gives the following supported pairing. [E01]

| Item | SDK 58 baseline from Expo |
| --- | --- |
| React Native | 0.88 |
| React | 19.3.0 |
| Minimum Node.js | 22.13.x |
| Minimum Android | Android 7 |
| Minimum iOS | iOS 16.4 |
| Android compile SDK | 37 |
| Android target SDK | 36 |
| Minimum Xcode | 26.4 |

These are Expo compatibility values, not a promise about future store acceptance.
The SDK release notes also describe support for iOS 27 and Xcode 27 tools. [E26]
Select and record an available EAS image during phase 0.
Prove its archive and submission validation before fixing the production toolchain.
Do not infer that a minimum Xcode value is the recommended release image.

The [root engine](../package.json) currently permits Node 18. That is below the SDK 58 tooling minimum. [E01]
Select a compatible Node 22 patch in mobile CI and document local setup.

**Recommendation:** start from SDK 58 and its supported package versions.
Resolve exact patches with `npx expo install` and commit the root npm lockfile during implementation.
Run `npx expo install --check` and `npx expo-doctor` in CI.
Do not select an unrelated latest React Native version. Expo SDKs target specific React Native versions. [E01] [E03]

React Native's New Architecture includes its native renderer and module system. [R01]
SDK 55 and later require that architecture. Disabling it is not an escape hatch for SDK 58. [E03]
Audit every native dependency against the selected SDK and device builds.

**Recommendation:** initially support Expo's iOS 16.4 and Android 7 floors. [E01]
Confirm audience coverage, security maintenance, and dependency support in phase 0.
Raise a floor only through an explicit product decision.
Support current phone sizes, tablets, and resizable layouts from the first public release.
Do not promise specialist desktop, TV, watch, or automotive support.

### Resolved shell implementation facts

The first shell uses Expo 58.0.23, React Native 0.88.1, and React 19.3.0.
The mobile workspace uses TypeScript 6.0.3, as required by the installed Expo SDK.
Root overrides align React, React DOM, and the test renderer to 19.3.0 for one dependency graph.
This updates the installed React version for existing apps within their declared dependency ranges.
The root TypeScript version remains separate from the mobile version.

`apps/mobile` uses native tabs from `expo-router/native-tabs` and native stacks for detail routes.
Expo generates typed route declarations before the mobile typecheck.
Metro uses Expo defaults. One root npm lockfile covers the mobile workspace.
The shell imports an inert shared helper and client types. It does not connect to a backend.
The client adapter PR can land independently.

The app configuration uses the candidate identities from section 11.1 with explicit environment overrides.
Identifier ownership and availability remain unverified.
EAS profiles define build boundaries. No EAS image, physical device result, signed archive, or store upload is established here.
See [the mobile README](../apps/mobile/README.md) for setup and device gaps.

### 3.1 Managed configuration and native escape hatch

Use CNG as the default meaning of the managed Expo workflow.
Keep `app.config.ts`, config plugins, and `eas.json` as source.
Generate `ios/` and `android/` during builds with prebuild.
Do not edit generated files and expect those edits to survive regeneration. [E07] [E08]

Use a local Expo module and config plugin for a small unsupported native integration.
Commit native projects only when a spike proves that repeatable generation cannot support the requirement.
Record the owner, reason, upgrade cost, and build changes before taking that route.
EAS Build can still build projects with committed native directories. [E07] [E09]

Use EAS Build for signed binaries and internal builds.
Use EAS Submit to upload approved binaries to the store pipelines.
Submission does not replace store review, metadata, or release approval. [E09] [E10]

Use development builds with `expo-dev-client` for daily work.
Expo Go has a fixed native library set and cannot validate arbitrary native configuration. [E06]
OAuth redirects need an app identity and scheme under our control. [E16]
Universal links, app links, real push credentials, and release startup need built app tests. [E17] [E18] [E14]
Android remote notifications are unavailable in Expo Go from SDK 53 onward. [E14]
Expo Go remains useful for limited UI experiments. It is not a launch test environment.

## 4. Platform rules and design guidance

### 4.1 iOS

| Classification | Requirement or guidance | Talyn response |
| --- | --- | --- |
| Guidance: HIG | Use familiar controls, clear hierarchy, and layouts that adapt to each supported device. [A01] | Use native navigation, sheets, safe areas, and platform text behavior. Keep primary actions easy to reach. |
| Guidance: accessibility | Support larger text, VoiceOver, adequate contrast, reduced motion, and suitable control sizes. [A07] | Apply the acceptance checks in section 8. Test custom transcript and status views. |
| External rule: completeness | App Review 2.1 requires a complete, stable app and reviewer access to account features. [A02] | Supply a working review account or an approved full demo mode. Keep its backend and sample data available. |
| External rule: minimum function | App Review 4.2 expects useful app functionality beyond a repackaged website. [A02] | Ship native navigation, readable transcripts, notifications, and useful degraded states. Explain the mobile workflow in review notes. |
| External rule: privacy manifest | Describe applicable collected data and required-reason API use. Third-party SDKs have their own manifest obligations. [A03] [A04] | Audit the final archive and SDK inventory. Configure `ios.privacyManifests` through Expo where needed. [E21] |
| External rule: approved reasons | Covered APIs need approved reasons that match actual use. Fingerprinting remains prohibited. [A04] | Inspect app and SDK use. Do not copy reason codes without checking the permitted use. |
| External rule: disclosures | App Privacy answers cover app and third-party collection practices. The privacy policy must match actual behavior. [A05] [A02] | Include diagnostics, analytics, push identifiers, account data, and user content as applicable. Recheck each SDK change. |
| External rule: tracking | Tracking as Apple defines it needs App Tracking Transparency permission. [A05] [A02] | Exclude advertising and tracking from MVP. Audit SDK defaults before deciding that ATT is unnecessary. |
| External rule: deletion | Apps that support account creation must let users initiate account deletion in the app. [A12] | Provide a visible deletion flow in Settings. Audit server cleanup and retention exceptions. |
| External rule: login | App Review 4.8 governs qualifying third-party login and lists exceptions. [A02] | Resolve GitHub-only sign-in before implementation depends on it. See section 5.2. |
| External rule: notifications | App Review 4.5.4 limits push use and prevents making push necessary for app function. [A02] | Ask in context. Keep the app usable after denial. Avoid sensitive content in alerts. |
| External rule: code updates | App Review 2.5.2 restricts downloaded code that introduces or changes functionality. [A02] | Treat OTA updates as a controlled maintenance path. Send native and substantial feature changes through store review. |

**External rule:** Apple also requires manifests for listed third-party SDKs in new apps.
Listed binary SDK dependencies also need signatures. Repackaged SDKs can carry the same obligation. [A13]
Audit the resolved dependency list and archive, rather than only the app source.

**External rule, date-sensitive:** since **2026-04-28**, uploads require Xcode 26 or later and the iOS 26 SDK or later. [A06]
Since **2026-09-09**, uploaded iOS apps must target iOS 13 or later. [A06]
Expo's recommended application floor here is higher. Build SDK and deployment floor are separate settings.
Recheck Apple's requirements at release freeze. [E01] [A06]

**Open review decision:** private transcripts can contain user text and AI output.
Assess App Review 1.2 safeguards and 5.1.2 data sharing requirements against the final product. [A02]
Do not assume that a private engineering tool automatically has an exemption.
Provide a support/report path and document applicable filtering, reporting, and abuse controls before launch.
Explain which agent providers receive prompts and repository content.
Obtain required consent before sharing personal data with third-party AI services. [A02]

### 4.2 Android and Google Play

| Classification | Requirement or guidance | Talyn response |
| --- | --- | --- |
| Guidance: core quality | Android quality guidance covers stability, navigation, performance, permissions, and platform behavior. [G01] | Use it as an engineering release checklist. Do not describe every checklist item as a Play rejection rule. |
| Guidance: Material 3 | Material 3 defines components, color, typography, and interaction patterns. [G02] | Apply these patterns through native-compatible React Native components. The cited Compose page does not require a Compose rewrite. |
| Guidance: adaptive quality | Layouts should adapt across window sizes, rotation, and device postures. [G03] | Support one-pane phones and list/detail layouts on wider windows. Preserve selection after resizing. |
| Guidance: accessibility | Android recommends meaningful labels and touch areas of at least 48 by 48 dp. [G04] | Test TalkBack, font scaling, focus order, and keyboard access. |
| External platform rule: permissions | Dangerous permissions require runtime handling where applicable. Users can deny them. [G05] | Request no camera, microphone, location, contacts, or broad file access for MVP. |
| External platform rule: notifications | Android 13 and later use `POST_NOTIFICATIONS` runtime permission for non-exempt notifications. [G11] | Explain the benefit before prompting. Handle denial, settings changes, and notification channels. |
| External platform behavior: edge-to-edge | Apps targeting SDK 35 or later use edge-to-edge on Android 15 and later. [G09] | Apply safe area and keyboard insets. Test gesture and three-button navigation. |
| Guidance and platform behavior: back | Android supports predictive back and documents migration away from older interception patterns. [G08] | Use supported Router/native stack behavior. Test back-to-home, nested stacks, sheets, and draft preservation. |
| External rule: Data safety | Play requires accurate disclosures of applicable collection, sharing, security, and deletion practices. [G06] | Audit SDK behavior and backend processing. Link the same reviewed data inventory to both stores. |
| External rule: user data | Play requires a privacy policy and applicable prominent disclosures and consent. [G20] | Do not hide unexpected collection behind a policy link. Use clear in-app disclosure when required. |
| External rule: deletion | Apps with account creation need an in-app deletion path and an external web deletion resource. [G15] | Audit the current delete route. Provide a public deletion URL before submission. |
| External rule: release setup | Play release preparation includes declarations, app access, signing, and review tasks. [G12] [G14] [G22] | Complete Console tasks, reviewer access, content rating, countries, and distribution choices. |

**External platform behavior:** Android 16 enables predictive back by default for apps targeting API 36 or later. [G24]
Legacy `onBackPressed` handling is not called for that target behavior. Use supported navigation APIs. [G24]
Android 16 also ignores several orientation and resize restrictions on large displays for apps targeting API 36. [G24]
Test adaptive layouts instead of relying on a portrait lock.

**External rule, date-sensitive:** new phone apps and updates must target **Android 16, API 36**, from **2026-08-31**. [G07]
The stated extension ends **2026-11-01**, before this research date. [G07]
Do not plan against an expired extension. Recheck Play Console before every release.

**External rule, date-sensitive:** check native libraries for 16 KB page size support. [G17]
The current page requires support for Play apps targeting Android 15 or higher on 64-bit devices.
It states an update enforcement date of **2027-02-01**. [G17]
Do not rely on that date to defer compatibility for a new app.
Validate the final artifact and its third-party libraries on a 16 KB emulator. [G17]

**Conditional rule:** personal developer accounts created after **2023-11-13** have additional production access tests.
The current rule requires 12 continuously opted-in closed testers for at least 14 days. [G13]
Confirm the publisher account type. Do not apply this condition to every organization account.

**Conditional review gate:** Google has an AI-generated content policy with scope and reporting requirements. [G21]
Determine its application to Talyn's agent output before launch.
If applicable, provide the required in-app reporting path and prevention measures.
Do not assume the policy applies identically to every productivity app.

### 4.3 Paid feature access

**Open decision:** classify the mobile business model before phase 1 can finish.
The backend sells Talyn plans and usage through existing billing APIs.
A mobile client must not copy web checkout links or upgrade calls without a store policy assessment.
Apple 3.1 and Google's Payments policy contain conditions and regional exceptions. [A02] [G18]

**Recommendation:** propose a free companion app with no purchase or purchase direction in MVP.
Existing users can access their current entitlements.
This is a review proposal, not proof that Talyn qualifies for Apple's 3.1.3(f) exception.
If the stores require billing changes, revise scope and estimates before implementation continues. [A02] [G18]
Usage-limit screens must explain the limit without an unapproved purchase route.
Keep billing and subscription administration outside the mobile MVP.

## 5. Architecture and security

### 5.1 Proposed ownership and files

All paths in this section are **proposed**, unless linked in section 2.

```text
apps/mobile/
  app.config.ts                 # App identities, links, plugins, and permissions
  eas.json                      # Build, submission, and environment profiles
  metro.config.js               # Expo defaults; overrides only after proof
  src/app/_layout.tsx           # Auth, providers, and root navigation
  src/app/(auth)/sign-in.tsx
  src/app/auth/callback.tsx
  src/app/(tabs)/_layout.tsx
  src/app/(tabs)/sessions/index.tsx
  src/app/(tabs)/threads/index.tsx
  src/app/(tabs)/attention/index.tsx
  src/app/(tabs)/settings/index.tsx
  src/app/workspaces.tsx         # Workspace selection sheet
  src/app/sessions/[id].tsx      # Transcript and composer
  src/app/threads/[id].tsx       # Transcript and child sessions
  src/app/pull-requests/[id].tsx # Status, attention, and queue timeline
  src/auth/                     # Supabase, secure storage, and callbacks
  src/transport/                # API binding and lifecycle adapter
  src/domain/                   # Pure selectors and transcript reducers
  src/state/                    # Server cache and temporary UI state
  src/storage/                  # Cache policy and cache adapters
  src/notifications/            # Permission, registration, and tap handling
  src/components/               # Accessible native views
  src/telemetry/                # Redaction, consent, and crash capture
  src/__tests__/
  e2e/
```

Use Expo's monorepo defaults before adding Metro overrides. [E04]
Keep React and native dependency resolution deterministic across workspaces.
Check for duplicate React and native modules in the installed graph. [E04]
The mobile React pairing must not force an unrelated desktop upgrade.
Add root scripts, typecheck coverage, and lockfile entries only during implementation.

**Recommendation:** Expo Router provides typed route structure and link handling. [E23]
Use four native tabs: Sessions, Threads, Attention, and Settings.
SDK 58 exposes native tabs through `expo-router/native-tabs`. [E05] [E26]
Use native stacks for detail routes and sheets for workspace selection.
Fall back to Router JavaScript tabs only if phase 0 finds a tested accessibility or layout defect.
Do not make an alpha split-view API a launch dependency.
Use a stable responsive list/detail composition for wider screens.

### 5.2 Auth and deep links

**Recommendation:** use Supabase auth with system browser OAuth and PKCE. [E16] [S01] [S02]
Use `expo-web-browser` with a verified callback flow in a development build.
Do not embed provider login in a WebView.
Do not ship a client secret or Supabase service-role key. [R02]

1. Load the secure storage adapter before creating the Supabase client.
2. Configure `flowType: 'pkce'`, persistent session storage, and `detectSessionInUrl: false`.
3. Persist the verifier securely before opening the authorization URL.
4. Use `skipBrowserRedirect` and open the returned URL through the system auth session.
5. Accept only the configured environment, host, path, and expected callback parameters.
6. Exchange the authorization code once through `exchangeCodeForSession`.
7. Remove callback parameters from navigation state and diagnostic data.
8. Restore the intended route only after auth and workspace authorization succeed.

These steps combine Expo and Supabase guidance into a proposed native flow. [E16] [S01] [S02]
Supabase codes expire after five minutes and can be exchanged only once. [S02]
Serialize auth attempts so a later verifier cannot silently replace an earlier one.
Track a pending attempt and handle cancel, timeout, duplicate callbacks, and app termination.
Use the auth library's transaction validation. Do not invent a separate OAuth protocol.
Prove PKCE persistence across process death and callback delivery on each platform.

Use an owned HTTPS host for production universal links and Android app links.
Reserve a distinct path such as `/mobile/auth/callback`; do not hijack the web callback.
Serve AASA and `assetlinks.json` from the exact associated host. [A08] [E17] [G10] [E18]
Candidate hosting paths are `apps/web/public/.well-known/apple-app-site-association` and `assetlinks.json` beside it.
Confirm hosting ownership and redirects before adding these files in a later PR.
Allow the exact environment callback URLs in Supabase. Wildcard redirects are not the production default.
Include the Apple team and bundle identity, plus Play signing certificate fingerprints.
Separate development fingerprints and app identities from production. [E18] [E20]
Use custom schemes for development or a verified fallback only.
A scheme alone does not establish domain ownership. [R02]
Test the system browser's actual HTTPS return behavior before selecting the final redirect URL.

**Open decision, release blocker:** does Talyn qualify for a 4.8 login exception?
Talyn uses GitHub for primary sign-in, but its product also manages Talyn accounts and agent work.
The third-party-service exception may apply; this plan does not assume that it does. [A02]
Have the product owner and store reviewer adviser document the rationale in phase 0.
If no exception applies, plan Sign in with Apple through Supabase.
Then require a separate GitHub connection for repository access.
Audit GitHub identity assumptions, private relay addresses, account linking, and deletion token revocation.
Never merge identities only because their email strings match.
Keep backend auth changes in a separate PR after this decision.

### 5.3 Session tokens and storage

**Recommendation:** store auth secrets and the PKCE verifier through `expo-secure-store`. [E13]
Never use AsyncStorage, query persistence, logs, analytics, or route parameters for secrets.
React Native security guidance identifies AsyncStorage as unencrypted storage. [R02]

Implement the asynchronous Supabase storage interface with environment-specific keys.
Use Keychain on iOS and the platform protection supplied by SecureStore on Android. [E13]
Keep an access token in memory only as needed. Let Supabase own refresh token rotation.
Start auth refresh while active and stop it while inactive, following the native auth guidance. [S03]
Let the shared client deduplicate 401 recovery.
Sign out only on explicit refresh rejection. Keep the session after offline, timeout, and server failures.

SecureStore can reject large values. Historical iOS releases rejected values around 2048 bytes. [E13]
Test actual Supabase session and verifier sizes on the minimum supported devices.
Fail storage writes visibly. Do not fall back to plaintext storage.
If size requires a different design, use a reviewed native secure storage implementation.
Do not add an improvised chunking or encryption scheme without a threat review.

SecureStore data has different uninstall behavior across platforms.
iOS Keychain data can survive uninstall; Android backup needs the documented exclusions. [E13]
Choose a foreground token accessibility policy and test lock/unlock and restore behavior.
Do not require biometrics for routine refresh unless product explicitly chooses that behavior.
Biometric changes can invalidate protected entries. [E13]

On logout, stop sockets and refresh work before clearing caches, tokens, pending callbacks, and device registration.
Cancel in-flight requests and reject late results from the previous account generation.
Keep no prior-account transcript visible after logout or account switching.
Attempt server device removal before token cleanup when online. Local logout must still work offline.
Offline logout cannot guarantee immediate server revocation. Expire inactive registrations and reconcile them at the next authenticated launch.
Set that expiry with the privacy owner before beta. Keep alert content generic during this possible delay.

### 5.4 Live updates, suspension, and offline state

**Recommendation:** use REST as the recoverable snapshot and WebSockets as the active update channel.
Use native AppState for foreground changes and a reachability adapter for network changes. [R04]
Reachability is a hint. A connected network can still have DNS, TLS, captive portal, or server failures.

On active entry, recover auth if needed, connect once, and restore current subscriptions.
Fetch list summaries, selected PR state, and transcript events after the stored sequence cursor.
Deduplicate events by chat and sequence. Reconcile missing ranges through REST.
Do not assume that every WebSocket event can be replayed.
Keep visible content marked stale until its recovery fetch succeeds.

Pause socket retries, presence, polling, and query work when the app enters background.
Cancel timers and close the foreground socket after a short lifecycle debounce.
Do not disconnect merely because an iOS permission sheet briefly makes the app inactive.
On resume, reject stale socket handlers and run one recovery sequence.
Use exponential backoff with jitter and a 30-second foreground cap.
Keep slower retry floors for authorization and capacity failures.
Avoid duplicate reconnect loops in the query cache and socket adapter.

**External fact:** background execution is constrained and scheduled by each platform. [E19] [G23]
Apple does not guarantee delivery of background notifications. It can throttle them. [A09]
Do not run a permanent background socket or promise immediate background transcript updates.
Use visible push alerts and fetch authoritative state when the person returns.
Optional background refresh is a later optimization, not a correctness dependency.

**Recommendation:** use a server cache library, such as TanStack Query, for fetched entities and invalidation.
Use small Zustand stores for selection, composer state, and temporary UI state.
This is a proposed dependency choice, not a repository fact or platform requirement.
Keep one owner for each fetched object. Do not duplicate it in both stores.

Cache keys must include environment, authenticated user, workspace, entity, and schema version.
Keep transcript content and unsent drafts in memory for MVP.
Persist only a bounded read cache of list summaries and last update times, with user consent.
Suggested initial limits: 24 hours and 5 MB per account; expose Clear offline data.
Session titles and repository names can be sensitive. Protect this cache with an approved encrypted database adapter.
Keep its encryption key in secure storage and exclude protected content from backup.
Encryption at rest does not replace logout cleanup or device threat analysis. [O01]
If no reviewed adapter is ready, ship memory-only cache and show a clear empty offline screen after restart.
This fallback needs explicit product acceptance before beta.

Do not queue automatic message sends or merge actions offline.
The current message input has no client idempotency key. [Repository contract](../packages/shared/src/workbench.ts)
Show `Sending`, `Queued on server`, `Sent`, or `Delivery unknown` as distinct states.
After a timeout, refresh the transcript and server queue before offering a manual resend.
Do not claim exactly-once message delivery from transcript text matching.
If safe resend becomes required, add server-supported message identifiers in a separate contract PR.

### 5.5 Push architecture

**Recommendation:** use `expo-notifications` and Expo Push Service for MVP, subject to data-processing approval. [E14] [E15]
It routes delivery through APNs and FCM. A push ticket is not proof of device delivery. [E15]
Keep a provider interface so direct APNs/FCM can replace the relay later.
Do not put repository text, prompts, diffs, tokens, or CI logs in a push payload.
Default alert text should be generic, such as “A session needs your attention.”
Payload data should contain an opaque event ID and a validated internal destination.

Proposed event categories:

- Session updates: completion, failure, and a request for human input.
- PR reviews: a review request or a material review state change.
- CI failures: a newly actionable failure, grouped per PR and head commit.
- Merge readiness: transition to ready, rather than every unchanged poll.
- Human gates: a new or changed gate that needs the person to act.

Ask permission after explaining these choices. Allow workspace and category preferences.
Support quiet hours, sensitive preview controls, and a global off switch.
Do not send one alert per token or transcript event.
Use Android channels that reflect meaningful user choices. [E14] [G11]

**Future backend additions, not implemented by this plan:**

- Add authenticated installation registration and removal endpoints under `/api/v1/mobile/installations`.
- Store owner, installation ID, provider token, platform, environment, app version, and last seen time.
- Add notification preferences with workspace scope, categories, quiet hours, and timezone.
- Validate ownership and current workspace access on registration and dispatch.
- Add a durable notification outbox with deduplication, expiry, retry state, and provider receipt handling.
- Remove dead tokens after `DeviceNotRegistered`. Retry temporary provider failures with bounded backoff. [E15]
- Handle token rotation, reinstall, logout, account deletion, lost access, and several devices per user.
- Keep provider credentials server-side. Add operational metrics without logging token values.

Proposed files include `packages/backend/src/routes/mobileInstallations.ts` and `routes/notificationPreferences.ts`.
Add `services/notifications/` for the outbox and provider worker.
Extend `packages/backend/src/db/schema.ts` and add the next migration in `db/migrations/`.
Add `packages/shared/src/notifications.ts` and its shared export.
Extend `packages/client/src/index.ts`; do not create mobile-only fetch copies.
Inspect `services/workbenches/turns.ts`, `services/prMonitor.ts`, and `services/mergeQueue/` as producer candidates.
Resolve these paths under `packages/backend/src`. Inspect their transaction boundaries before adding hooks.
Persist an outbox entry with the state transition where possible.
A process-local WebSocket broadcast is not a durable push trigger.

On notification taps, wait for auth initialization, verify ownership, fetch the entity, then navigate.
Handle cold start, background, foreground, duplicate taps, deleted entities, and changed accounts.
Never execute a merge, approval, or paid action directly from an alert.
The app remains correct when notifications arrive late, twice, or never.

### 5.6 Security, analytics, and crash reporting

**Recommendation:** use OWASP MASVS as the security baseline. [O01]
It is an engineering standard, not a separate Apple or Google store certification.
Track evidence for storage, cryptography, auth, network, platform, code, resilience, and privacy controls.
Use MASTG test procedures for selected controls during the release review. [O01]

Threat review inputs include lost devices, malicious links, leaked logs, account crossover, and untrusted transcript content.
Use HTTPS and WSS for production. Preserve server authorization for every object and mutation.
Treat incoming links and transcript Markdown as untrusted data.
Render Markdown through a native allowlist without raw HTML or executable content.
Block unsafe URL schemes. Confirm external navigation when the destination is unclear.
Keep internal preview capabilities, terminal execution, and downloaded code outside MVP.
Certificate pinning is an open risk decision. MASVS does not mean every app must use identical pinning controls. [O01]

Choose one native crash reporter after reviewing SDK data, processors, retention, and regional requirements.
Disable session replay and automatic view content capture for MVP.
Allow only explicit analytics events with reviewed fields.
Exclude prompts, transcript text, code, auth URLs, tokens, push tokens, and raw request query strings.
Pseudonymous identifiers can still be personal data. Disclose them accurately. [A05] [G06] [G20]

Keep diagnostics and product analytics choices separate.
Offer appropriate consent and opt-out controls. Confirm legal bases with the privacy owner.
Audit automatic IP, device, breadcrumb, network, and identity capture before enabling an SDK.
Upload source maps in CI with restricted credentials.
Tag crashes with platform, binary version, and OTA runtime/update ID.
Set deletion and retention procedures before filling store privacy forms.

## 6. MVP product and navigation

**Recommendation:** optimize for checking work and removing small communication blocks while away from a computer.
The MVP follows existing work. Creation of new sessions and threads can follow after this loop works.

```text
Signed out -> Sign in -> Auth callback -> Workspace selection
Signed in
  Sessions tab -> Session detail -> Transcript + message composer
  Threads tab  -> Thread detail  -> Transcript + child sessions
  Attention tab -> PR detail -> Checks + review attention + queue status
  Settings tab -> Notifications, privacy, offline data, account, and support
Global sheet -> Workspace switcher
Verified link or notification -> Auth gate -> Authorized detail screen
```

A pending destination survives sign-in but cannot bypass authorization.
Keep workspace selection visible in list headers.
Preserve each tab's scroll position and navigation history.
Use a list/detail view on wide windows and a stack on narrow windows.

| Surface | MVP behavior | Empty, error, or degraded state |
| --- | --- | --- |
| Sign-in | GitHub PKCE, plus the outcome of the Apple login decision. | Cancel, expired callback, offline auth, provider error, and revoked session have distinct recovery. |
| Workspace switcher | List authorized workspaces. Restore the last valid choice. | Show bootstrap/loading state. Handle deleted workspaces and revoked access without exposing old data. |
| Sessions | List active and recent sessions with repository, status, update time, and attention marker. | Separate an empty list from a failed request. Offer pull-to-refresh and stale data labels. |
| Threads | List threads and open their child sessions. | A missing child does not break the thread transcript. Explain deleted or inaccessible destinations. |
| Transcript | Page older events. Preserve reading position. Follow new output only when already at the end. | Show missing-page errors inline. Keep loaded text readable during reconnection. |
| Composer | Send text to an existing chat. Show server queue status and cancellation of local editing. | Preserve drafts in memory. Explain delivery uncertainty and limits. Never silently resend. |
| PR attention | Show authored and requested-review PRs, check summaries, review state, and human gates. | Distinguish stale GitHub data, unavailable details, and no attention items. |
| PR detail | Show status, review attention, supported human-gate context, and queue timeline. | Open GitHub for rich review. Return to the same app route afterward. |
| Merge queue | Read basic status, blocking reason, stack dependency, and last update time. | Unknown provider states remain visible as unknown. Queue mutation is outside MVP. |
| Notifications | Explain permissions, register the installation, and apply category preferences. | Show denied, disabled, registration pending, and delivery service failure states. |
| Settings | Sign out, deletion, privacy policy, diagnostics choices, cache controls, version, support, and notification settings. | Show actionable deletion blockers and a support path. Keep logout usable during outages. |

**MVP non-goals:** rich diff editing, inline review submission, terminal access, local execution, repository file editing, and app previews.
Also exclude uploads, new session provisioning, full settings, provider credential entry, administration, and billing.
Exclude direct merge actions, queue changes, widgets, watch apps, background agent execution, and full offline authoring.
Desktop-only workflows stay in desktop. Links must not imply that those workflows exist on mobile.
Human gates are visible in MVP. Only supported text responses use the composer.
A gate that needs another action opens its detail or GitHub. It must never appear resolved without server confirmation.

## 7. API and state contract

All existing methods below live in [the shared client](../packages/client/src/index.ts).
Server data stays server-owned. The device owns temporary navigation, cache metadata, and unsent drafts.

| Mobile need | Existing contract | Gap or implementation check |
| --- | --- | --- |
| Account and workspace entry | Supabase session; `workspaces.list`; `features.get`; `workbenches.readiness` | Test first login, bootstrap, missing GitHub setup, and incomplete provider setup. Mobile can explain setup required on web. |
| Sessions and threads | `workbenches.list(workspaceId, { kinds })`; `get`; `threadSessions` | Lists currently return arrays without a pagination option. Measure large accounts before deciding whether backend pagination is required. |
| Chats and transcript | Workbench/chat data and `workbenches.events(chatId, { after, before, limit })` | Confirm chat selection and cursors against real accounts. Handle unknown event types with a safe fallback. |
| Send message | `workbenches.sendMessage` | No client idempotency key. Define uncertain delivery. Test server queue acknowledgements. |
| PR attention | `pullRequests.list`, relationship filter, `get`, `reviews` | Use existing attention fields. Avoid duplicating server ranking. Measure payload size and pagination needs. |
| Merge status | PR queue fields and `mergeQueueTimeline` | Read-only MVP. Preserve external queue and stack blocker states. |
| Service health | `system.githubHealth` and REST/network errors | Show degraded service separately from invalid credentials. |
| Account deletion | `users.wipeMe` | Audit partial Supabase failure, paying-team blockers, token revocation, retained records, and mobile installation cleanup. |
| Push and preferences | No mobile contract found | New authenticated endpoints, schema, outbox, and provider worker in phase 4. |
| Optional safe resend | No message identifier in current input | Separate additive contract only if required. Preserve old clients. |

Subscribe only to the active workspace and relevant supported spaces.
Respect server capability negotiation and access changes.
Do not assume every entity in a workspace has identical space permissions.
The [server socket](../packages/backend/src/services/websocket.ts) applies subscription and authorization rules.

Use explicit states for loading, empty, ready, stale, offline, failed, and authorization required.
Treat 401 after failed recovery, 403, 404, rate limits, usage limits, and server outages separately.
Keep errors free of raw server bodies that can contain sensitive data.
Offer a retry only when the operation can safely repeat.
Do not use a generic sign-out action for every network failure.

Keep API changes additive because old mobile binaries will remain installed.
Define an owner for compatibility tests and a supported-version policy before beta.
Do not turn the client version header into an authorization mechanism.
If a minimum version gate becomes necessary, add a server-controlled, tested contract with an outage-safe message.

## 8. Native quality and acceptance

These are **recommended Talyn acceptance checks**, informed by platform guidance. [A01] [A07] [G01] [G03] [G04] [R03]
They are not a claim that every numeric target is a store rule.

- All controls have roles, labels, values, and disabled states where relevant.
- VoiceOver and TalkBack can complete sign-in, switch workspace, read a transcript, send text, and open PR status.
- Focus moves predictably after navigation, sheets, validation errors, and new messages.
- Streaming text does not announce every token or steal the reading cursor.
- Text can grow to 200 percent without hiding essential actions or content.
- iOS touch areas target at least 44 by 44 points. Android touch areas target at least 48 by 48 dp. [A07] [G04]
- Normal text targets 4.5:1 contrast. Large text and meaningful interface graphics target at least 3:1. [A07]
- Status uses text or icons as well as color. Dark mode and increased contrast remain readable.
- Reduced motion removes nonessential movement. Haptics never provide the only feedback.
- External keyboards, Switch Control, and Android Switch Access can reach all essential actions.
- Safe areas, display cutouts, keyboard insets, and system bars do not cover the composer or tab controls.
- Back gestures and predictive back preserve routes and drafts. Destructive confirmations do not break navigation. [G08]
- Rotation, split screen, and tablet resizing preserve selected entities and reading position.
- Long messages, code blocks, links, localization expansion, and right-to-left layouts remain usable.
- Virtualized lists keep transcript memory bounded. Large pages do not block typing or scrolling.

Proposed performance budgets need phase 0 measurements on named lower-end devices.
Start with a three-second cold start target and a one-second cached list target on the agreed test device.
Measure release builds, not development mode.
Record startup, list scroll, transcript memory, message latency, and battery use before beta.
Do not promise a fixed live-message latency when the network or provider controls delivery.

## 9. Implementation phases

Estimates are **engineering effort**, not fixed delivery dates.
Assume two engineers with React Native experience and part-time design, QA, and release support.
Assume existing Apple and Google organization accounts, domain control, and access to Supabase settings.
Store review, legal assessment, account setup, and tester recruitment add elapsed time.

One engineer-week means one engineer's focused work for one week.
The expected total is **17–28 engineer-weeks**, plus review delays and unresolved scope changes.
With two engineers, allow roughly **10–16 calendar weeks** after access and policy decisions are ready.
Use the upper range when native auth, secure cache, or notification infrastructure needs revision.
Sign in with Apple, new billing flows, and major backend pagination can exceed these ranges.

| Phase and size | Deliverables and likely files | Acceptance checks and tests | Dependencies |
| --- | --- | --- | --- |
| 0. Decisions and device spikes; 1–2 engineer-weeks | Record SDK patches, EAS image, OS floors, auth callback, native tabs, storage size, and policy decisions. Later create `apps/mobile/app.config.ts`, `eas.json`, and a minimal workspace only after this plan is approved. | Both physical platforms open a development build. Prove native dependency resolution, secure write/read, PKCE callback, native tab accessibility, archive validation, and representative large payload timing. Record unresolved release blockers. | Publisher accounts, domain access, Supabase redirect control, product and privacy owners. |
| 1. Workspace and transport; 2–3 engineer-weeks | Add `apps/mobile/package.json`, app shell, `src/transport`, root scripts, lockfile, and mobile CI. Adapt client timers, lifecycle, and reachability. | Unit tests cover adapters, reconnect cleanup, jitter, auth rejection, and stale generations. Existing web/desktop socket regression tests pass. Both native release bundles import shared packages without browser shims. | Phase 0 SDK choice and monorepo graph. Login and billing scope decisions must be recorded. |
| 2. Auth and native foundation; 2–4 engineer-weeks | Add `src/auth`, auth routes, secure storage, workspace sheet, Settings account actions, and associated domain configuration. Separate backend auth/deletion fixes if required. | Integration and device tests cover cancel, code expiry, killed app, duplicate callback, token refresh, storage failure, logout, account crossover, deletion, and revoked access. Verify AASA and Play certificate associations. | Phase 1; confirmed login policy; approved identities and callback host; deletion audit. |
| 3. Mobile workflows and recovery; 5–7 engineer-weeks | Build session/thread routes, native transcript, composer, Attention, PR detail, queue status, `src/domain`, state, and cache controls. Add pagination only if phase 0 measurements require it. | Unit tests cover reducers and cursors. Component tests cover empty/error/stale states. Device E2E covers the full MVP. Reconnect tests prove no duplicate events or automatic resend. Accessibility and performance budgets pass. | Phase 2; API fixture set; cache protection decision; any necessary additive backend contracts. |
| 4. Durable push and privacy; 3–5 engineer-weeks | Add backend installation/preferences routes, shared types, client methods, schema migration, outbox, worker, `src/notifications`, and telemetry controls. Likely service hooks include workbench updates, PR monitoring, and merge queue transitions. | Backend tests cover authorization, deduplication, retries, receipts, revocation, and deletion. Devices receive all five categories. Test denial, token rotation, quiet hours, wrong-account taps, and cold-start routing. Review SDK disclosures. | Stable event semantics, provider credentials, processor approval, and phase 2 identity. Backend work can overlap phase 3 after contract approval. |
| 5. Beta and release; 4–7 engineer-weeks | Add `e2e` flows, mobile release workflow, store assets, privacy inventory, support/deletion pages, and release runbook. Finish TestFlight and Play tests. | Complete section 10 on signed store builds. Resolve policy gates. Perform security review, rollback drill, migration compatibility tests, and reviewer access checks. Product and release owners approve launch. | Phases 3–4; store forms; real devices; signing custody; any conditional closed-test period. |

Keep each phase in reviewable PRs. Do not combine backend push migration with all mobile screens.
Tests for shared adapters must protect existing clients before mobile depends on them.
Every phase must link its acceptance evidence and unresolved decisions from the implementation PR.

### 9.1 First implementation PR

**Recommendation:** `feat(mobile): add Expo workspace and native development shell`.
This PR follows the phase 0 decisions. It should not ship authentication or product mutations.

Include only the workspace entry, Expo-supported package pairing, root lockfile, app identity variants, and typed navigation shell.
Add `app.config.ts`, `eas.json`, Expo Metro defaults, and basic mobile scripts.
Prove imports from `@talyn/shared` and `@talyn/client` without opening a socket.
Keep secret material out of the app and repository.
Add lint, typecheck, dependency checks, and a native build smoke check.
Record two device build results and the exact EAS image.
Follow it with a separate client adapter PR, then the auth PR.

## 10. Test matrix

**Recommendation:** use Jest with the Expo preset and React Native Testing Library for unit and component tests.
Use Maestro for cross-platform device flows unless the phase 0 spike shows a specific coverage gap.
Do not copy DOM tests into native tests or claim mocked callbacks prove OS integration.

| Layer or scenario | iOS coverage | Android coverage | Required evidence |
| --- | --- | --- | --- |
| Unit | Domain rules, transcript cursors, storage errors, route validation, backoff, redaction. | Same shared logic and native adapter branches. | Deterministic tests with clock, transport, and auth fakes. |
| Component | Accessible roles, text scaling, sheets, composer, long transcripts, error states. | Same flows with Android semantics and back behavior. | State fixtures cover loading, empty, denied, failed, stale, and partial data. |
| API integration | Supabase storage contract, 401 recovery, REST envelopes, socket auth and subscriptions. | Same contract with native networking. | Use an isolated test backend. Test authorization and unknown response fields. |
| End-to-end | Sign-in, workspace switch, read history, send message, PR attention, Settings, sign-out. | Same essential workflow in emulator and device builds. | Repeatable fixture account with no production secrets or private repositories. |
| Device sizes | Small and large phones, tablet, rotation, split view, minimum supported OS, current OS. | Lower-memory phone, large phone, tablet/foldable, resized windows, minimum supported OS, API 36 and current OS. | Record actual model and OS versions at release freeze. |
| Accessibility | Physical VoiceOver, Dynamic Type, reduced motion, high contrast, Switch Control, keyboard. | Physical TalkBack, large fonts, display scaling, Switch Access, keyboard. | Manual task completion plus component semantics checks. |
| Network loss | Airplane mode, captive portal, slow network, DNS/TLS failure, 5xx, rate limit. | Same cases plus Wi-Fi to mobile data change. | No false logout, duplicate message, hidden stale label, or retry storm. |
| Background/resume | Lock, inactive auth sheet, background, force quit, process death, interrupted storage. | Background restrictions, process death, lock, Doze, task restoration. | One recovery sequence; authorized cache only; no permanent background socket. |
| Auth callbacks | Cold/warm universal links, browser cancel, expired code, duplicate return, wrong host, reinstall. | Verified app links with Play certificate, cold/warm return, duplicate and malicious links. | Real build identities. Mock links alone are insufficient. |
| Notifications | Permission denial, foreground/background/terminated alert, delayed tap, Focus, revoked token. | Runtime denial, disabled channel, Doze, token rotation, terminated alert. | Real APNs/FCM delivery and server receipt handling. Tap fetches authorized current state. |
| Rendering and performance | Long code blocks, malicious Markdown, large transcript, RTL, memory pressure. | Same cases, low memory, edge-to-edge, predictive back, three-button navigation. | Release measurements against phase 0 budgets. |
| Final release smoke | TestFlight archive: launch, auth, push, API, deletion, logout, links, offline, crash symbols. | Play internal AAB: same checks, 16 KB compatibility, signing certificate links. | Test the exact submitted binary, configuration, and backend environment. |
| Updates and recovery | Compatible OTA, embedded fallback, broken update recovery, old binary against new API. | Same checks and a higher-version corrective binary. | Rollback drill records runtime, update ID, channel, and app versions. |

Run focused tests on each PR. Run the full mobile suite before beta and each release candidate.
Run relevant web and desktop regressions when changing shared transport.
Start database services only for integration tests that need them. Stop services after those tests.

## 11. Release operations and launch checklist

### 11.1 Identities, environments, signing, and CI

**Recommendation:** reserve permanent app identities under an organization-controlled prefix.
Candidate production IDs are `dev.talyn.mobile` for both stores; availability is unverified.
Use `.development` and `.preview` variants for non-production builds. [E20]
Record Apple team ID, App Store Connect app ID, Play application ID, and EAS project ID.
Treat final identifiers as a phase 0 decision.

Define development, staging/preview, and production profiles in `apps/mobile/eas.json`.
Give each profile an explicit API origin, Supabase project, redirect host, app identity, and update channel.
Use separate test accounts and backends. Never test account deletion against production.
Prevent non-production push tokens from entering production dispatch.

Client configuration is public after bundling. Do not treat bundled environment values as secrets. [R02]
Publish only intended public URLs and Supabase publishable/anon keys.
Protect access through server authorization.
Keep EAS tokens, APNs keys, FCM credentials, Play service account keys, and signing material in approved secret custody.
Use organization-owned accounts with least privilege, recovery access, key rotation, and two-factor authentication.
Do not put service-role keys, signing credentials, or store credentials in `EXPO_PUBLIC_*`.

Use EAS-managed credentials initially, with documented organization ownership and recovery. [E09]
Use Play App Signing and distinguish its signing certificate from the upload certificate. [G14] [E18]
Keep Apple distribution profiles and push entitlements aligned with each bundle identity.
Restrict publishing and signing jobs to trusted branches and approved release jobs.
Fork PR checks must not receive release credentials.

A future `.github/workflows/mobile.yml` should run install, shared/client builds, lint, typecheck, tests, and Expo dependency checks.
A separate approved release workflow should build from a known commit, retain artifacts, and record provenance.
Submit only after device smoke checks.
Record binary version, build number/version code, runtime version, update ID, backend compatibility, and source commit.

### 11.2 Updates and rollback

**Recommendation:** introduce EAS Update with a small beta audience before enabling production OTA.
Use a runtime policy tied to the native build fingerprint. [E11]
Separate channels by environment. Sign updates and protect the update signing key. [E24]
A native module, entitlement, permission, or native configuration change requires a compatible new binary. [E11]
OTA cannot bypass store policies or rescue an incompatible native change. [A02] [E11]

Keep an embedded update and document republishing a known good compatible update or rolling back to embedded content. [E12]
Test this procedure before launch.
Keep a remote kill switch for notification categories and risky mobile features.
A switch must not expose unreviewed hidden features.
Backend migrations must preserve installed binary compatibility.

For a broken binary, halt rollout and ship a corrected version with a higher build/version code.
An OTA rollback does not downgrade the native binary or undo server mutations.
Apple phased release applies to version updates. It is not an initial-launch percentage control. [A11]
Google's first production release reaches the selected countries without a rollout percentage. [G14]
Start with a deliberate audience or country selection. Use staged rollout for eligible later updates. [G14]

### 11.3 iOS launch checklist

- [ ] Confirm publisher ownership, app identifiers, signing access, push entitlement, and associated domains.
- [ ] Recheck current Xcode, SDK, deployment floor, and App Store submission requirements. [A06]
- [ ] Resolve 4.8 login, 3.1 payment, AI/data sharing, and content safeguard decisions. [A02]
- [ ] Complete the security review and audit the final archive's privacy manifests and approved reasons. [A03] [A04]
- [ ] Confirm account deletion, provider revocation, retention disclosures, and support for blocked deletion. [A12]
- [ ] Complete App Privacy answers, privacy policy, applicable consent, and the updated age rating questionnaire. [A05] [A06]
- [ ] Supply icons, supported-device screenshots, description, category, copyright, and accurate release notes.
- [ ] Publish working support and privacy URLs. Keep them usable without signing in.
- [ ] Provide review notes, access instructions, sample sessions, and a working review account or approved demo. [A02]
- [ ] Distribute through TestFlight. External testing can require beta review; builds expire after 90 days. [A10]
- [ ] Test the exact TestFlight build on physical devices, including links, notifications, accessibility, and deletion.
- [ ] Confirm export compliance, distribution countries, and all remaining App Store Connect declarations.
- [ ] Assign a release owner. Rehearse update rollback and corrective binary release.
- [ ] Release manually after approval. Monitor auth, crashes, reconnects, and support reports.

### 11.4 Android launch checklist

- [ ] Confirm publisher verification, organization ownership, package ID, Play App Signing, and recovery access. [G12] [G14]
- [ ] Check whether the personal-account closed-test rule applies. Complete it if required. [G13]
- [ ] Recheck target API requirements and validate all native libraries for 16 KB page size support. [G07] [G17]
- [ ] Verify app links with the production Play signing fingerprint. [G10] [E18]
- [ ] Test edge-to-edge, predictive back, permissions, channels, adaptive windows, and process restoration. [G08] [G09] [G11]
- [ ] Complete Data safety, privacy policy, account deletion URL, app access, ads, audience, and content rating forms. [G06] [G15] [G22]
- [ ] Resolve payment policy and applicable AI content controls. [G18] [G21]
- [ ] Supply icon, feature graphic, screenshots, descriptions, support contact, privacy URL, and release notes.
- [ ] Use internal testing first. Then run closed testing and inspect pre-launch reports. [G12] [G14]
- [ ] Smoke-test the Play-installed release AAB on real devices and a 16 KB emulator. [G17]
- [ ] Verify reviewer access to representative data. Keep backend review services available. [G22]
- [ ] Choose first-release countries and manual publication controls. Later use staged rollout where eligible. [G14]
- [ ] Assign monitoring, support, halt, and corrective-release owners.

Suggested operating thresholds are product targets, not store requirements.
Require zero known critical security defects, zero unresolved auth/data loss defects, and complete core-flow smoke checks.
During beta, establish crash-free session and auth success baselines before setting numeric rollout thresholds.
Track receipt errors separately from device delivery. Neither proves that a person read an alert. [E15]
Pause expansion when auth failures, crashes, duplicate sends, or privacy incidents exceed the agreed thresholds.

## 12. Risks, open decisions, and decision log

| Risk or decision | Owner role | Needed by | Exit evidence |
| --- | --- | --- | --- |
| GitHub login may not qualify for an Apple exception. Apple login can affect backend identity. | Product and auth | Phase 0 | Written policy rationale or scoped Apple login/account-linking design. |
| Existing paid entitlements may need mobile billing changes. | Product and store release | Phase 0 | Storefront-specific policy assessment and approved MVP screens. |
| Native compatibility is unproven despite a reusable transport contract. | Mobile and client maintainers | Phase 1 | Both-platform Hermes builds and adapter regression tests. |
| SecureStore payload size or restore behavior can break auth. | Auth and security | Phase 0 spike; phase 2 complete | Representative size tests, write failure behavior, restore and logout tests. |
| Persistent cache protection can add native dependency risk. | Security and mobile | Before phase 3 beta | Approved encrypted adapter or accepted memory-only fallback. |
| High-volume lists may need server pagination. | Backend and mobile | Phase 0 measurement | Payload and latency results from large fixture accounts. |
| Duplicate or lost message delivery is possible after uncertain failure. | Backend and product | Phase 3 | Clear delivery states; optional idempotency contract if required. |
| Push delivery can be delayed or absent. | Backend and mobile | Phase 4 | Outbox tests, receipt processing, device tests, and foreground recovery. |
| Private code or prompt content can leak through SDKs or lock-screen alerts. | Privacy and security | Before enabling telemetry or push | Reviewed field inventory, payload audit, and processor approval. |
| Deletion can leave partial auth cleanup or a paying-team blocker. | Backend and privacy | Phase 2 | End-to-end cleanup, completion tracking, disclosed retention, and support path. |
| Generated content may require additional review safeguards. | Product and trust/safety | Before beta | Apple and Google policy scope assessment with required controls. |
| Signing accounts, callback host, identifiers, OS floors, and release image are not reserved by this plan. | Release and mobile | Phase 0 | Account access, ownership records, and successful signed test uploads. |
| Root dependencies can introduce duplicate React/native modules. | Mobile and build maintainers | Phase 1 | Locked install graph and both native archives. |
| Store and SDK rules change with time. | Release owner | Every release freeze | Dated recheck of section 13 and Console validation. |

The decisions below are **proposals**, not evidence of user approval.
Update the log when implementation accepts or replaces them.

| Date | Proposed decision | Reason | Revisit trigger |
| --- | --- | --- | --- |
| 2026-11-08 | Put mobile in `apps/mobile` with explicit npm workspace registration. | Keep one repository and one API contract. | Monorepo tooling proves incompatible. |
| 2026-11-08 | Use SDK 58 with its supported React Native pairing. | Use the current stable Expo baseline. [E01] [E26] | Implementation starts after another stable SDK release. |
| 2026-11-08 | Use CNG, config plugins, development builds, and EAS Build. | Keep native configuration repeatable. [E06] [E07] [E08] | A documented native requirement prevents generation. |
| 2026-11-08 | Use native Router tabs and stacks. | Fit platform navigation and mobile attention workflows. [E05] | Device accessibility or layout tests fail. |
| 2026-11-08 | Reuse transport through adapters and share pure domain logic selectively. | Avoid browser dependencies and duplicate endpoint definitions. | A measured package boundary needs extraction. |
| 2026-11-08 | Keep secrets in SecureStore and transcripts in memory for MVP. | Reduce persistent sensitive data and auth exposure. [E13] [R02] | Approved offline requirements need protected transcript storage. |
| 2026-11-08 | Use durable push plus foreground reconciliation. | Background delivery cannot guarantee correctness. [A09] [E15] | Relay, privacy, or reliability constraints require direct APNs/FCM. |
| 2026-11-08 | Keep merge queue read-only and exclude purchase flows from MVP. | Bound mobile action risk and unresolved store scope. | Separate product and policy approval expands the scope. |

## 13. Primary sources

Access date for every source: **2026-11-08**.
Apple documentation pages require JavaScript. Their official JSON content was also read where noted.
Versions, deadlines, Console rules, and SDK behavior can change. Verify them again at implementation and release freeze.

### Apple

- **A01** — [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/). Content read through [official JSON](https://developer.apple.com/tutorials/data/design/human-interface-guidelines.json).
- **A02** — [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/).
- **A03** — [Privacy manifest files](https://developer.apple.com/documentation/bundleresources/privacy-manifest-files). Content read through [official JSON](https://developer.apple.com/tutorials/data/documentation/bundleresources/privacy-manifest-files.json).
- **A04** — [Describing use of required reason API](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api). Content read through [official JSON](https://developer.apple.com/tutorials/data/documentation/bundleresources/describing-use-of-required-reason-api.json).
- **A05** — [App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/).
- **A06** — [Upcoming Requirements](https://developer.apple.com/news/upcoming-requirements/).
- **A07** — [HIG: Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility). Content read through [official JSON](https://developer.apple.com/tutorials/data/design/human-interface-guidelines/accessibility.json).
- **A08** — [Supporting universal links in your app](https://developer.apple.com/documentation/xcode/supporting-universal-links-in-your-app). Content read through [official JSON](https://developer.apple.com/tutorials/data/documentation/xcode/supporting-universal-links-in-your-app.json).
- **A09** — [Pushing background updates to your app](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app). Content read through [official JSON](https://developer.apple.com/tutorials/data/documentation/usernotifications/pushing-background-updates-to-your-app.json).
- **A10** — [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/).
- **A11** — [Release a version update in phases](https://developer.apple.com/help/app-store-connect/update-your-app/release-a-version-update-in-phases/).
- **A12** — [Offering account deletion in your app](https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion).
- **A13** — [Third-party SDK requirements](https://developer.apple.com/support/third-party-SDK-requirements/).

### Google and Android

- **G01** — [Core app quality guidelines](https://developer.android.com/docs/quality-guidelines/core-app-quality).
- **G02** — [Material Design 3 in Compose](https://developer.android.com/develop/ui/compose/designsystems/material3).
- **G03** — [Adaptive app quality guidelines](https://developer.android.com/docs/quality-guidelines/adaptive-app-quality).
- **G04** — [Principles for improving app accessibility](https://developer.android.com/guide/topics/ui/accessibility/principles).
- **G05** — [Request runtime permissions](https://developer.android.com/training/permissions/requesting).
- **G06** — [Google Play Data safety](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en).
- **G07** — [Target API level requirements for Google Play apps](https://support.google.com/googleplay/android-developer/answer/11926878?hl=en).
- **G08** — [Predictive back gesture](https://developer.android.com/guide/navigation/custom-back/predictive-back-gesture).
- **G09** — [Display content edge-to-edge](https://developer.android.com/develop/ui/views/layout/edge-to-edge).
- **G10** — [Verify Android App Links](https://developer.android.com/training/app-links/verify-applinks).
- **G11** — [Notification runtime permission](https://developer.android.com/develop/ui/compose/notifications/notification-permission).
- **G12** — [Publish your app](https://support.google.com/googleplay/android-developer/answer/9859751?hl=en).
- **G13** — [Testing requirements for new personal accounts](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en).
- **G14** — [Prepare and roll out a release](https://support.google.com/googleplay/android-developer/answer/9859348?hl=en).
- **G15** — [Account deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en).
- **G17** — [Support 16 KB page sizes](https://developer.android.com/guide/practices/page-sizes).
- **G18** — [Google Play Payments policy](https://support.google.com/googleplay/android-developer/answer/9858738?hl=en).
- **G20** — [Google Play User Data policy](https://support.google.com/googleplay/android-developer/answer/10144311?hl=en).
- **G21** — [AI-Generated Content policy](https://support.google.com/googleplay/android-developer/answer/13985936?hl=en).
- **G22** — [Prepare your app for review](https://support.google.com/googleplay/android-developer/answer/9859455?hl=en).
- **G23** — [Background tasks overview](https://developer.android.com/develop/background-work/background-tasks).
- **G24** — [Behavior changes for apps targeting Android 16](https://developer.android.com/about/versions/16/behavior-changes-16).

### Expo

- **E01** — [Expo SDK reference and compatibility table](https://docs.expo.dev/versions/latest/).
- **E03** — [React Native New Architecture in Expo](https://docs.expo.dev/guides/new-architecture/).
- **E04** — [Work with monorepos](https://docs.expo.dev/guides/monorepos/).
- **E05** — [Router native tabs](https://docs.expo.dev/router/advanced/native-tabs/).
- **E06** — [Introduction to development builds](https://docs.expo.dev/develop/development-builds/introduction/).
- **E07** — [Continuous Native Generation](https://docs.expo.dev/workflow/continuous-native-generation/).
- **E08** — [Config plugins](https://docs.expo.dev/config-plugins/introduction/).
- **E09** — [Expo Build introduction](https://docs.expo.dev/build/introduction/).
- **E10** — [Submit to app stores](https://docs.expo.dev/deploy/submit-to-app-stores/).
- **E11** — [Runtime versions and updates](https://docs.expo.dev/eas-update/runtime-versions/).
- **E12** — [Update rollbacks](https://docs.expo.dev/eas-update/rollbacks/).
- **E13** — [SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/).
- **E14** — [Notifications](https://docs.expo.dev/versions/latest/sdk/notifications/).
- **E15** — [Sending notifications with Expo Push Service](https://docs.expo.dev/push-notifications/sending-notifications/).
- **E16** — [Authentication with OAuth or OpenID providers](https://docs.expo.dev/guides/authentication/).
- **E17** — [iOS universal links](https://docs.expo.dev/linking/ios-universal-links/).
- **E18** — [Android app links](https://docs.expo.dev/linking/android-app-links/).
- **E19** — [BackgroundTask](https://docs.expo.dev/versions/latest/sdk/background-task/).
- **E20** — [Install app variants on one device](https://docs.expo.dev/build-reference/variants/).
- **E21** — [Privacy manifests in Expo](https://docs.expo.dev/guides/apple-privacy/).
- **E23** — [Introduction to Expo Router](https://docs.expo.dev/router/introduction/).
- **E24** — [End-to-end update code signing](https://docs.expo.dev/eas-update/code-signing/).
- **E26** — [Expo SDK 58 stable release](https://expo.dev/changelog/sdk-58).

### React Native

- **R01** — [About the New Architecture](https://reactnative.dev/architecture/landing-page).
- **R02** — [React Native security](https://reactnative.dev/docs/security).
- **R03** — [React Native accessibility](https://reactnative.dev/docs/accessibility).
- **R04** — [AppState](https://reactnative.dev/docs/appstate).
- **R05** — [React Native networking](https://reactnative.dev/docs/network).

### Supabase

- **S01** — [Supabase native mobile deep linking](https://supabase.com/docs/guides/auth/native-mobile-deep-linking).
- **S02** — [Supabase PKCE flow](https://supabase.com/docs/guides/auth/sessions/pkce-flow).
- **S03** — [Supabase Auth with React Native](https://supabase.com/docs/guides/auth/quickstarts/react-native).

### OWASP

- **O01** — [OWASP Mobile Application Security Verification Standard](https://mas.owasp.org/MASVS/).

[A01]: https://developer.apple.com/design/human-interface-guidelines/
[A02]: https://developer.apple.com/app-store/review/guidelines/
[A03]: https://developer.apple.com/documentation/bundleresources/privacy-manifest-files
[A04]: https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api
[A05]: https://developer.apple.com/app-store/app-privacy-details/
[A06]: https://developer.apple.com/news/upcoming-requirements/
[A07]: https://developer.apple.com/design/human-interface-guidelines/accessibility
[A08]: https://developer.apple.com/documentation/xcode/supporting-universal-links-in-your-app
[A09]: https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app
[A10]: https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/
[A11]: https://developer.apple.com/help/app-store-connect/update-your-app/release-a-version-update-in-phases/
[A12]: https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion
[A13]: https://developer.apple.com/support/third-party-SDK-requirements/
[E01]: https://docs.expo.dev/versions/latest/
[E03]: https://docs.expo.dev/guides/new-architecture/
[E04]: https://docs.expo.dev/guides/monorepos/
[E05]: https://docs.expo.dev/router/advanced/native-tabs/
[E06]: https://docs.expo.dev/develop/development-builds/introduction/
[E07]: https://docs.expo.dev/workflow/continuous-native-generation/
[E08]: https://docs.expo.dev/config-plugins/introduction/
[E09]: https://docs.expo.dev/build/introduction/
[E10]: https://docs.expo.dev/deploy/submit-to-app-stores/
[E11]: https://docs.expo.dev/eas-update/runtime-versions/
[E12]: https://docs.expo.dev/eas-update/rollbacks/
[E13]: https://docs.expo.dev/versions/latest/sdk/securestore/
[E14]: https://docs.expo.dev/versions/latest/sdk/notifications/
[E15]: https://docs.expo.dev/push-notifications/sending-notifications/
[E16]: https://docs.expo.dev/guides/authentication/
[E17]: https://docs.expo.dev/linking/ios-universal-links/
[E18]: https://docs.expo.dev/linking/android-app-links/
[E19]: https://docs.expo.dev/versions/latest/sdk/background-task/
[E20]: https://docs.expo.dev/build-reference/variants/
[E21]: https://docs.expo.dev/guides/apple-privacy/
[E23]: https://docs.expo.dev/router/introduction/
[E24]: https://docs.expo.dev/eas-update/code-signing/
[E26]: https://expo.dev/changelog/sdk-58
[G01]: https://developer.android.com/docs/quality-guidelines/core-app-quality
[G02]: https://developer.android.com/develop/ui/compose/designsystems/material3
[G03]: https://developer.android.com/docs/quality-guidelines/adaptive-app-quality
[G04]: https://developer.android.com/guide/topics/ui/accessibility/principles
[G05]: https://developer.android.com/training/permissions/requesting
[G06]: https://support.google.com/googleplay/android-developer/answer/10787469?hl=en
[G07]: https://support.google.com/googleplay/android-developer/answer/11926878?hl=en
[G08]: https://developer.android.com/guide/navigation/custom-back/predictive-back-gesture
[G09]: https://developer.android.com/develop/ui/views/layout/edge-to-edge
[G10]: https://developer.android.com/training/app-links/verify-applinks
[G11]: https://developer.android.com/develop/ui/compose/notifications/notification-permission
[G12]: https://support.google.com/googleplay/android-developer/answer/9859751?hl=en
[G13]: https://support.google.com/googleplay/android-developer/answer/14151465?hl=en
[G14]: https://support.google.com/googleplay/android-developer/answer/9859348?hl=en
[G15]: https://support.google.com/googleplay/android-developer/answer/13327111?hl=en
[G17]: https://developer.android.com/guide/practices/page-sizes
[G18]: https://support.google.com/googleplay/android-developer/answer/9858738?hl=en
[G20]: https://support.google.com/googleplay/android-developer/answer/10144311?hl=en
[G21]: https://support.google.com/googleplay/android-developer/answer/13985936?hl=en
[G22]: https://support.google.com/googleplay/android-developer/answer/9859455?hl=en
[G23]: https://developer.android.com/develop/background-work/background-tasks
[G24]: https://developer.android.com/about/versions/16/behavior-changes-16
[O01]: https://mas.owasp.org/MASVS/
[R01]: https://reactnative.dev/architecture/landing-page
[R02]: https://reactnative.dev/docs/security
[R03]: https://reactnative.dev/docs/accessibility
[R04]: https://reactnative.dev/docs/appstate
[R05]: https://reactnative.dev/docs/network
[S01]: https://supabase.com/docs/guides/auth/native-mobile-deep-linking
[S02]: https://supabase.com/docs/guides/auth/sessions/pkce-flow
[S03]: https://supabase.com/docs/guides/auth/quickstarts/react-native
