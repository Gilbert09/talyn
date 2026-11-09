# Mobile release checklist

Complete every row for iOS and Android. Attach dated evidence to the restricted release record.
Use the exact signed TestFlight and Play internal builds. Record device model, OS, source, runtime, and update ID.
Use disposable accounts and synthetic workspaces. Do not test deletion against a person's production account.
An unchecked row blocks release. An export or mock result does not satisfy a physical-device row.

| Gate | Procedure and required result |
| --- | --- |
| Install and launch | Install through TestFlight and Play internal testing. Check cold launch, warm launch, update from the previous binary, and failed-install recovery. |
| Authentication | Complete GitHub OAuth. Cancel the browser. Test expired and duplicate callbacks, wrong host, killed browser, locked device, and revoked credentials. |
| Session expiry | Expire and revoke sessions. Confirm one recovery sequence. A temporary auth outage must retain the account. Explicit rejection must clear it. |
| Workspace access | Select and switch workspaces. Revoke access during a read and send. Confirm no old account content or drafts appear. |
| Sessions | Read lists, older history, streaming output, and readiness. Send text. Test queued, failed, and unknown delivery without automatic duplicate sends. |
| Threads | Read the planning transcript and child sessions. Follow a child and its PR. Confirm no unsupported management action appears. |
| Pull requests | Read Attention, review state, CI, human gates, stack, and queue timeline. Confirm unknown values and read-only behavior. |
| Deep links | Open cold and warm session, thread, and PR links. Repeat through login and workspace selection. Test missing, deleted, and wrong-workspace destinations. |
| Universal/app links | Verify HTTPS callback and product paths with the final Apple team and Play signing certificate. Test supported browsers and fresh installs. |
| Push consent | Confirm no launch-time prompt. Enable from Settings. Test denial, permanent denial, disabled Android channel, and later permission changes. |
| Push delivery | Send all five categories through the real durable worker. Test foreground, background, terminated, Focus/Doze, delayed receipts, and expired events. |
| Push authorization | Tap stale, wrong-account, wrong-workspace, deleted, and revoked events. Confirm authoritative reads and no mutation from tap data. |
| Push lifecycle | Rotate tokens. Reinstall. Switch accounts. Logout online and offline. Confirm removal, expiry, quiet hours, and generic lock-screen text. |
| Offline and recovery | Test airplane mode, DNS/TLS failure, captive portal, 5xx, and mobile/Wi-Fi changes. Confirm stale labels and no offline sends. |
| Background | Lock, suspend, force-stop, and kill during OAuth, refresh, writes, and streaming. Confirm one reconnect and authorized recovery. |
| Reinstall and backup | Check iOS Keychain retention, device-only accessibility, SecureStore backup exclusions, restore onto another device, and oversized real auth sessions. |
| Logout | Confirm secure auth cleanup, workspace cleanup, socket reset, push removal or expiry, draft removal, and private content protection after a link. |
| Deletion | Cancel the confirmation. Test success, network failure, and paying-admin HTTP 409. Confirm local cleanup and separate provider/billing completion checks. |
| Public deletion page | Verify unauthenticated access, clear restrictions, support escalation, retention, and the Google Play account-deletion link. |
| Accessibility | Complete all core tasks with VoiceOver and TalkBack. Check focus, labels, status announcements, 48-point targets, and no streaming announcement storm. |
| Adaptive UI | Check 200 percent text, RTL, dark/light themes, high contrast, reduced motion, safe areas, rotation, tablet windows, external keyboard, and switch access. |
| Performance | Measure ten cold starts, list p50/p95, a 60-second scroll trace, memory after ten detail visits, keyboard latency, and streaming reading position. |
| Android platform | Test minimum OS, API 36/current OS, predictive back, three-button navigation, edge-to-edge, low memory, and a 16 KB page-size device. |
| iOS platform | Test the approved minimum OS and current OS. Verify universal-link OAuth support, iPad behavior, keyboard focus, and final APNs entitlement. |
| Native inspection | Verify signed archives, certificates, package identity, permissions, entitlements, backups, all SDK privacy manifests, and current SDK requirements. |
| Privacy | Approve field inventory, processors, retention, App Privacy, Data safety, and generated content policy. Confirm no analytics, tracking, advertising, ATT prompt, or replay. |
| Updates | Verify compatible signed update, signature rejection, offline cache, embedded rollback, and incompatible native rejection on each platform. Confirm an automatic preview and beta update arrives after a merge, the **Update ready** restart, About's update rows, and the `MOBILE_UPDATES_AUTO=0` stop. |
| Backend compatibility | Run the previous binary and candidate against the planned backend. Keep auth, workflow, link, and notification contracts compatible. |
| Store review | Confirm metadata, assets, reviewer access, privacy pages, policy decisions, export answers, age ratings, regions, and all required account verification. |
| Operations | Assign named release, incident, privacy, backend, and support owners. Confirm thresholds, halt authority, artifact custody, and recovery records. |

No physical devices, signing accounts, store records, production links, or hosted EAS evidence are supplied by repository tests.
Record these gaps explicitly in the release decision. Do not replace them with synthetic pass results.
