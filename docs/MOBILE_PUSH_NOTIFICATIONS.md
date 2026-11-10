# Mobile push operations

Push delivery uses Expo Push Service through a backend provider interface.
Direct APNs and FCM providers are outside this phase.
Keep push disabled until privacy and device checks are complete.
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
Counters cover queued rows, tickets, retries, expiry, permanent errors, receipts, latency totals, and active installations.
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
| `PUT /mobile/notification-preferences` | Replace the caller's version 1 workspace preferences. |
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

Only generic alerts leave the backend.
Payload fields are `schemaVersion`, `eventId`, `category`, and `destination`.
Destinations contain an internal kind, workspace ID, and entity ID.
No prompt, transcript, code, repository name, PR title, or CI log enters the payload.
Tokens do not enter route responses, logs, metric labels, or audit records.
Sensitive preview settings are reserved. They do not enable private alert text.

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
- Update Apple App Privacy disclosures and required privacy manifests for the final native binary.
- Update Google Play Data safety and the privacy policy for push processing and deletion.
- Confirm retention, backup removal, and deletion support procedures with backend and privacy owners.
- Confirm that no tracking, advertising identifier, or ATT prompt was added.
  PostHog analytics and masked session replay are allowed (Tom's call, 2026-11-10). Confirm that no push token or payload reaches them.
- Complete phase 5 beta, signing, release, and store submission procedures separately.
