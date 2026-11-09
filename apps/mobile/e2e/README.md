# Release device flows

Use Maestro for device automation. Use the existing Expo Jest and React Native Testing Library stack for deterministic release journeys.
Run `npm run mobile:test:release` from the repository root. Run the full mobile suite before each candidate.
The deterministic journeys cover OAuth, workspace validation, product reads, notification resolution, logout, deletion, and session expiry.
Existing storage, network, callback, notification, and screen suites cover failure and offline branches.
These tests use synthetic data. They do not prove native delivery or store readiness.

Install the current approved Maestro binary from its official release distribution.
Record its version in the release record. Do not install an unpinned test tool inside a production publish job.
Use physical devices for accessibility, push, associations, secure storage, and release smoke.
An emulator or simulator can provide extra UI evidence. It cannot replace those physical checks.

Prepare an isolated backend workspace with one session, one thread, one linked PR, and synthetic transcript content.
Use an authorized disposable account. Sign in through the system browser.
Do not automate passwords, OAuth codes, real tokens, browser storage, or account creation.
Supply non-secret fixture labels and IDs through local environment variables.

Run from `apps/mobile` after installing the exact candidate:

```sh
maestro test -e APP_ID="$APP_ID" -e WORKSPACE_NAME="$WORKSPACE_NAME" e2e/auth.yaml
maestro test -e APP_ID="$APP_ID" -e WORKSPACE_NAME="$WORKSPACE_NAME" -e SESSION_LABEL="$SESSION_LABEL" -e THREAD_LABEL="$THREAD_LABEL" -e PR_LABEL="$PR_LABEL" e2e/workflows.yaml
maestro test -e APP_ID="$APP_ID" -e SESSION_LINK="$SESSION_LINK" -e THREAD_LINK="$THREAD_LINK" -e PR_LINK="$PR_LINK" e2e/deep-links.yaml
maestro test -e APP_ID="$APP_ID" e2e/notifications.yaml
maestro test -e APP_ID="$APP_ID" -e SESSION_TITLE="$SESSION_TITLE" e2e/notification-tap.yaml
maestro test -e APP_ID="$APP_ID" -e SESSION_LINK="$SESSION_LINK" e2e/logout.yaml
```

Use the exact accessible row label from the seeded fixture for each `*_LABEL`.
`auth.yaml` pauses for the tester to complete GitHub OAuth within three minutes.
`workflows.yaml` starts at workspace selection after authentication.
`deep-links.yaml` requires an authenticated account and a validated workspace.
Repeat cold links while signed out and while no workspace is selected. Complete those gates manually, then verify the detail.
`notifications.yaml` starts with a validated workspace. The tester answers the operating system prompt.
Run `notification-tap.yaml` only after a tester taps a real session notification.
Send that alert through the durable backend worker. Opening a URL cannot prove push delivery.
`logout.yaml` starts signed in. Confirm that protected content stays hidden after logout.

Deletion is a separate destructive flow. Confirm the isolated backend and disposable account first.
Sign in again, choose the fixture workspace, then run:

```sh
maestro test -e APP_ID="$APP_ID" -e ALLOW_ACCOUNT_DELETION=disposable-test-account e2e/deletion.yaml
```

This marker prevents an accidental test invocation. It cannot verify that an account is disposable.
The tester must check the account and backend before running the flow.
Check provider deletion and billing cleanup separately. The backend success response does not prove their completion.

Maestro can create screenshots, hierarchy dumps, and logs. Use synthetic content and a restricted local output directory.
Do not upload automatic captures to CI artifacts, PRs, snapshots, or caches.
Inspect and redact evidence before sharing it. Remove raw captures under the approved retention policy.
No device flow or hosted credential is required by pull request CI.
Complete [the release checklist](../../../docs/MOBILE_RELEASE_CHECKLIST.md) for human-only checks and each failure branch.
