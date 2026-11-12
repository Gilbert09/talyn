# Mobile push operations

Push delivery uses Expo Push Service through a backend provider interface.
Direct APNs and FCM providers are outside this phase.
Push is ON in production since 2026-11-12 (Tom's call): `TALYN_MOBILE_PUSH_ENABLED=true`, and the allowlist is
`dev.talyn.mobile.preview@preview,dev.talyn.mobile.development@development,dev.talyn.mobile@production`.
Android registration was checked on a Pixel. iOS waits for the Apple push key (Apple Developer account in EAS).
To stop all dispatch, set `TALYN_MOBILE_PUSH_ENABLED` to anything but `true`.
The app remains usable when push is disabled, delayed, duplicated, or absent.

## Deployment configuration

Configure backend values through the deployment secret and environment controls.
Never commit credentials, real push tokens, or account fixtures.

| Value | Purpose |
| --- | --- |
| `TALYN_MOBILE_PUSH_ENABLED` | Explicit dispatch opt-in. Set `true` only after approval and configuration. |
| `TALYN_TOKEN_KEY` | Existing backend encryption key. Protects stored token values. |
| `TALYN_MOBILE_PUSH_APP_IDENTITIES` | Comma-separated `appIdentity@environment` allowlist. Registration and dispatch both check it. |
| `EXPO_ACCESS_TOKEN` | Optional server-side Expo credential. No token is required by default. |
| `EXPO_PUBLIC_EAS_PROJECT_ID` | Optional public mobile project UUID. The app config defaults to the Talyn project `@talyn-app/talyn-mobile`. |

The provider can use Expo without an Expo access token.
If deployment supplies an access token, keep it on the backend.
The public EAS project ID identifies the native project. It is not a credential.
Use separate app identities and environments for development, preview, and production.
Reject incomplete production configuration before building the app.
Missing backend enablement, encryption key, or app allowlist disables dispatch.

## Android credentials (FCM)

Expo sends Android alerts through Firebase Cloud Messaging. The Firebase project is `talyn-514510` (set up 2026-11-12).
It has one Android app for each package: `dev.talyn.mobile`, `dev.talyn.mobile.preview` and `dev.talyn.mobile.development`.

- **FCM V1 service account key.** It is stored in EAS (account `talyn-app`) and assigned to all three packages.
  The original is the 1Password item "Talyn FCM V1 service account key (Firebase talyn-514510)" in the `Private` vault.
  Expo uses it to send. The app and the backend never read it.
- **`google-services.json`.** It is the EAS text variable `TALYN_MOBILE_GOOGLE_SERVICES_JSON` (base64, sensitive) in the
  development, preview and production environments. The original is the 1Password item
  "Talyn mobile google-services.json (Firebase talyn-514510)". `app.config.ts` decodes it into `.expo/google-services.json`
  and sets `android.googleServicesFile`. Without the variable, a build has no Firebase config and cannot get a push token.
  It is a text variable and not an EAS file variable, because `eas update` does not receive the contents of a file
  variable. The fingerprint hashes the file contents, so a build and an update must see the same file.
  Never commit the file: GitHub secret scanning flags the API key in it.
- A local build needs the variable too, for example
  `export TALYN_MOBILE_GOOGLE_SERVICES_JSON="$(op document get <item> | base64 | tr -d '\n')"`.
- Adding, changing or removing the variable changes the fingerprint. Installed binaries then need a new build.

iOS needs no Firebase. Expo sends iOS alerts through APNs with the Apple push key from the Apple Developer account.

## Worker schedule and limits

The backend starts one sweep at startup, then every 30 seconds.
Each process prevents overlapping sweeps. Database row claims coordinate separate processes.
Each reconciliation pass claims at most 100 journal entries.
Each dispatch pass claims at most 50 outbox rows.
Dispatch leases expire after five minutes.
Expo send requests contain at most 100 messages. Receipt requests contain at most 1000 ticket IDs.
Provider requests have a ten-second timeout and bounded response bodies.

Delivery permits six attempts.
Temporary failures wait 30 seconds, then double the delay, with a one-hour cap.
Quiet hours defer delivery by 15 minutes without consuming an attempt.
Receipt processing starts 15 minutes after ticket acceptance.
It permits eight polls with bounded backoff. Missing receipts become unknown.
Expired journal events are removed after 24 hours.
Outbox events expire after 24 hours. Terminal records remain for seven more days.
Registration audit records remain for 30 days.
Installations become inactive after 30 days without a successful registration or heartbeat.
Disabled installation records are removed after another 30 days.

Operators can read counters at `GET /api/v1/admin/mobile-notifications/metrics`.
The existing admin guard protects this route.
Counters cover queued rows, tickets, retries, expiry, permanent errors, receipts, latency totals, active installations, and pushes skipped at the desk (`atDesk`).
Counters are local to each process and reset on restart. They contain no account or destination labels.
Use deployment monitoring to collect snapshots when historical rates are needed.

Do not add a second scheduler or a public unauthenticated dispatch route.
Use existing backend deployment and shutdown controls.

## Data and access

All mobile routes use the existing authenticated `/api/v1` API.
The native client owns request transport.

| Method and path | Result |
| --- | --- |
| `POST /mobile/installations` | Register or rotate the caller's installation. Returns its stable ID and availability. |
| `PATCH /mobile/installations/:installationId` | Refresh authorized installation metadata and last-seen time. |
| `DELETE /mobile/installations/:installationId` | Disable one installation. Repeated removal is safe. |
| `GET /mobile/notification-preferences?workspaceId=…` | Read preferences for an accessible workspace. |
| `PUT /mobile/notification-preferences` | Replace the caller's version 1 workspace preferences. `onlyWhenAway` is optional; when it is absent, the stored value stays. |
| `GET /mobile/notifications/:eventId` | Resolve an unexpired event with current owner, workspace, and entity checks. |

Mobile writes share the existing limiter with 30 requests per minute for each authenticated user.
Registration also limits each account to 20 active installations.
The limiter is local to each backend process, as in the existing rate-limit pattern.
Use deployment controls for a distributed abuse ceiling when scaling the backend.

Registration binds one installation to the authenticated account.
Registration and preference changes require current workspace access.
An active token cannot be claimed by another account.
Token rotation updates the protected installation record.
Several devices can register for one account.
Registration responses expose the installation ID and provider availability, without the token.

Push tables deny direct access through Supabase Data API roles.
Backend routes enforce ownership with explicit queries.
Account deletion removes installation records and related notification data.
Dispatch rechecks access before each attempt.
Workspace access loss prevents delivery and event resolution.

Alert text uses the same words as the desktop notification (Tom's call, 2026-11-12).
This replaces the earlier rule that only generic alerts leave the backend.
`services/mobileNotifications/text.ts` makes the title and body when the worker sends the alert.
A session alert has the session name and status, for example "Done: Fix login".
Its body is a short summary of the latest turn: the PR it opened, the agent's question, the error, or the last reply.
The session text comes from `notificationText` in `packages/shared`. Desktop and web use the same function.
A PR alert has the repository, the PR number, and the PR title, for example "posthog/posthog#12 Fix login".
A merge queue block has its blocked reason. A human gate has the gate name.
The title is 80 characters or fewer. The body is 178 characters or fewer.
If the worker cannot make the text, it sends the generic text for the category.
This text goes through Expo, Google FCM, and Apple APNs.
Android channels use private lock-screen visibility, so a locked Android device hides the text.
On iOS, the system "Show Previews" setting controls the lock-screen text.

The data payload does not change. Its fields are `schemaVersion`, `eventId`, `category`, and `destination`.
Destinations contain an internal kind, workspace ID, and entity ID.
The app uses only the data payload to open the destination.
No prompt, transcript, code, or CI log enters the data payload.
Tokens do not enter route responses, logs, metric labels, or audit records.
The sensitive preview setting is not used. Every alert has the text above.

## Delivery semantics

State transitions enter a durable database journal.
The journal captures changes in the transaction that updates the source row.
Reconciliation consumes a bounded journal batch and adds deduplicated outbox rows in one transaction.
This durable path handles updates from old binaries, webhooks, and polls.
It does not depend on an in-memory callback after a commit.
Session completion and failure use `session_update`.
New input requests use `human_gate`, so one request produces one category alert.
PR transitions use `pr_review`, `ci_failure`, `merge_ready`, or `human_gate`.
Queue gates for agent input and blocked code reviews also use `human_gate`.
Required CI failures are grouped by PR and head commit.

The outbox stores separate delivery state for each installation.
Concurrent workers use row claims and expiring leases.
A stopped worker releases its claim through lease expiry.
Retries can produce duplicate delivery after an ambiguous network result.
The app deduplicates taps by event ID. Navigation uses a current server read.
Expo can delay or drop an accepted message.
A successful ticket means acceptance by Expo. A receipt is a separate provider outcome.
Neither outcome proves that the person saw an alert.

Quiet hours use the preference timezone.
Equal start and end times pause alerts all day while quiet hours are enabled.
Category switches and the workspace global switch apply before delivery.
Expired events cannot cause navigation.
Product screens retain their normal authoritative refresh behavior.

## Away-only delivery

A push goes to the phone only when the person is away from their computer (Tom's call, 2026-11-12).
While Talyn on the computer is in use, the desktop notification or the open app shows the alert.
No feature flag controls this. The `onlyWhenAway` preference controls it for each workspace.

The desktop app and the web app send a WebSocket message `{ "type": "desk_presence", "state": "active" | "away" }`.
The message has no other fields. It has no idle time, no app name, and no window title.
The vocabulary and the times are in `packages/shared/src/deskPresence.ts`.
The 30-second beat and the change rules are in `packages/client/src/deskPresence.ts`.

- **Desktop**: the main process reads system input, not only input in Talyn (`apps/desktop/src/main/deskPresence.ts`).
  The state is `active` when `powerMonitor.getSystemIdleState(180)` is `active`, the screen is unlocked, and the computer is awake.
  If Electron reports `unknown`, the desktop uses `getSystemIdleTime()` less than 180 seconds.
  `lock-screen`, `unlock-screen`, `suspend`, and `resume` tell the renderer to check at once.
- **Web**: the state is `active` when the tab is visible and the page had pointer or keyboard input in the last three minutes.
  The web does not use the Idle Detection API, so it shows no permission prompt.
  Input in a different app reads as idle in the browser.
- **Mobile**: the phone never sends desk presence.

While the state is `active`, the client sends `active` immediately and then every 30 seconds.
When the state changes to `away` (idle for three minutes, a lock, sleep, or a hidden tab), the client sends `away` one time.
Then it sends nothing until the state is `active` again. The first input after idle sends `active` immediately.
The socket sends the latest state again after a reconnect.

The backend keeps one record for each authenticated socket (`services/deskPresence.ts`).
The user ID comes from the socket's authentication. The backend ignores IDs in the message body.
A person is at the desk while any of their sockets sent `active` in the last 60 seconds.
`away` and a closed socket remove the record immediately.
When the beats stop (sleep, quit, or network loss), the record expires after 60 seconds.
With `REDIS_URL`, the records are in one Redis hash for each user, so all replicas give the same answer.
A Lua script writes the field and the key expiry together. Without Redis, the records are in process memory.
The WebSocket debug trace records a change of state only, not each beat.

The dispatch preflight checks presence after the workspace and category switches.
If `onlyWhenAway` is on and the person is at the desk, the row becomes `cancelled` with `lastErrorClass: 'at_desk'`.
The push is skipped, not delayed. A dispatch pass does one presence lookup for each owner.
If the presence lookup fails, the push is sent.

`onlyWhenAway` defaults to `true`. No migration is necessary, because the preferences column is jsonb.
A stored row without the field reads as `true`.
App builds from before this change send preferences without the field.
For such a PUT, the backend keeps the stored value, so an older app cannot turn a stored `false` back to `true`.
The mobile app reads a missing field from an older backend as `true`.
The mobile setting is **Only when I'm away from my computer** in the workspace notification settings.

## Removal and device checks

Online logout removes or disables the installation before local credentials are cleared.
If the server cannot be reached, local logout still clears credentials.
The server relies on access checks and the installation inactivity limit for eventual cleanup.
Account deletion removes all installations through backend cleanup.
Do not store payloads or tokens in AsyncStorage, route state, logs, analytics, or crash fields.
SecureStore holds only the installation material needed by the native runtime.

Before activation, test signed builds on physical iOS and Android devices.
Cover permission denial, rotation, reinstall, several devices, logout, account switching, and workspace access loss.
Test foreground, background, killed process, cold start, delayed delivery, duplicates, and missing delivery.
Check Android channels, VoiceOver, TalkBack, text scaling, errors, disabled states, and notification permission settings.
Record the final generated native permissions and plugin effects.
Exports and test doubles do not establish these results.

## Privacy and store gates

- Privacy and security owners must approve Expo as a processor before activation.
- Review the Expo service terms, subprocessors, transfer terms, retention, and incident process.
- Record the approved field inventory, including device tokens and opaque account-linked event identifiers.
- Record that alert text contains session names, agent summaries, questions and errors, and PR references and titles.
  Expo, FCM, and APNs process this text. Disclose it as user content in the store privacy answers.
- Update Apple App Privacy disclosures and required privacy manifests for the final native binary.
- Update Google Play Data safety and the privacy policy for push processing and deletion.
- Confirm retention, backup removal, and deletion support procedures with backend and privacy owners.
- Confirm that no tracking, advertising identifier, or ATT prompt was added.
  PostHog analytics and masked session replay are allowed (Tom's call, 2026-11-10). Confirm that no push token or payload reaches them.
- Complete phase 5 beta, signing, release, and store submission procedures separately.
