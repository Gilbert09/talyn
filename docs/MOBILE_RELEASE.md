# Mobile release operations

Phase 5 supplies release tooling. It does not approve launch or prove store acceptance.
Merge [#128](https://github.com/Gilbert09/talyn/pull/128), then [#129](https://github.com/Gilbert09/talyn/pull/129), then this release change.
Earlier work: [#116](https://github.com/Gilbert09/talyn/pull/116), [#119](https://github.com/Gilbert09/talyn/pull/119),
[#121](https://github.com/Gilbert09/talyn/pull/121), and [#126](https://github.com/Gilbert09/talyn/pull/126).

## Owners and release record

Assign named people to these roles before beta. A role name alone does not satisfy an approval.

| Role | Responsibility |
| --- | --- |
| Release owner | Reserve versions, approve source, manage credentials, submit builds, halt distribution. |
| Mobile owner | Native configuration, device tests, accessibility, updates, and recovery drills. |
| Auth/backend owner | OAuth, association files, API compatibility, push workers, and deletion completion. |
| Security/privacy owner | Data inventory, processors, manifests, disclosures, retention, and incident handling. |
| Product/store owner | Login policy, payment scope, content safeguards, listings, countries, and review access. |
| Support owner | Public support pages, deletion escalation, beta feedback, and incident communication. |

Copy `apps/mobile/release/evidence.template.json` into the restricted release record.
Record approval references. Do not put credentials, user data, or private code in that record.
Record source SHA, tested tree SHA, root lockfile SHA-256, EAS CLI version, and build profile.
Record the EAS build ID, exact builder image, Node, Xcode, Android SDK, NDK, AGP, and Java versions.
Record each platform runtime, version, build number, channel, branch, certificate digest, artifact checksum, and signing identity.
Record update IDs, embedded update IDs, test results, backend compatibility, owners, and approval dates.
Retain records under the organization's access and retention policy. That policy needs owner approval.

## Profiles, identity, and versions

| Profile | APP_ENV / EAS environment | Distribution | Channel → branch | OTA updates | Identity |
| --- | --- | --- | --- | --- | --- |
| development | development | Internal development client | development → development | Off. The client loads from Metro. | `.development` variant |
| preview | preview | Internal preview | preview → preview | Automatic on each push to main | `.preview` variant |
| internal-beta | production | Store: TestFlight / Play internal | internal-beta → internal-beta | Automatic on each push to main | Approved production identity |
| production | production | Store release candidate | production → production | Manual, approved dispatch only | Same approved production identity |

Internal beta uses the production backend and push environment. Use disposable, isolated workspaces and approved test accounts.
Use preview for staging backend tests. Do not register staging tokens with production dispatch.
The beta and production apps replace each other because they share store identities.
Their channels remain separate. Store production candidates need their own production-profile build and smoke evidence.

Development and preview have useful defaults without production secrets.
Production requires `TALYN_MOBILE_IOS_BUNDLE_ID`, `TALYN_MOBILE_ANDROID_PACKAGE`, and `TALYN_MOBILE_SCHEME`.
No production identity is reserved by this change. Validate availability and organization ownership in both stores.
Never use the proposed defaults as evidence of ownership.

`apps/mobile/package.json` owns the numeric marketing version. The Expo config and client version read it directly.
Change it through npm so the root lockfile stays current. Do not use `eas build:version:set` with this local policy.
`MOBILE_BUILD_NUMBER` supplies both the iOS build number and Android version code.
Use a positive integer from 1 through 999999999. Reserve it in the release record before each store build.
The number must exceed every uploaded number for that application, including failed or abandoned releases.
Both store profiles require this value. Non-store builds default to 1.
EAS uses `appVersionSource: local`; every profile disables `autoIncrement`.
Do not reuse a store number or allow concurrent version reservations. CI serializes release jobs.

EAS CLI is pinned to 27.5.0 in `release/toolchain.json`, `eas.json`, and the release workflow.
CI installs it outside the app. Doctor rejects a local EAS CLI dependency.
Expo owns the supported native dependency versions.
Recheck store SDK and builder requirements at each release freeze.
Choose and record an approved builder image before the first signed build.
EAS defaults can change. Freeze an explicit supported image in a reviewed configuration change after the first native validation.

## Public configuration and external URLs

Configure these public values in the protected GitHub environment and matching EAS environment:

- `EXPO_PUBLIC_API_ORIGIN`, `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_KEY`.
- `EXPO_PUBLIC_AUTH_CALLBACK_URL`. `EXPO_PUBLIC_EAS_PROJECT_ID` is optional: the config defaults to the Talyn project
  `@talyn-app/talyn-mobile` (`69499768-c478-44c0-8588-355c674515df`). Set it only for a fork.
- `TALYN_MOBILE_IOS_BUNDLE_ID`, `TALYN_MOBILE_ANDROID_PACKAGE`, `TALYN_MOBILE_SCHEME`.
- `TALYN_MOBILE_SUPPORT_URL`, `TALYN_MOBILE_PRIVACY_URL`, `TALYN_MOBILE_DELETION_URL`.
- `MOBILE_UPDATE_KEY_ID` (`main`). Set it in both EAS environments and as a GitHub repository variable.
  `eas.json` owns `MOBILE_UPDATES_ENABLED` per profile. Do not set it in an EAS environment.
- `MOBILE_ASC_APP_ID` and `MOBILE_APPLE_TEAM_ID` for iOS submission.

All bundled values are public. Use only a Supabase publishable or legacy anon key.
Never put private keys or service-role keys in any `EXPO_PUBLIC_*` value.
The production callback must use HTTPS and the exact `/callback` path.
The three public pages must use approved HTTPS URLs. Example and localhost URLs are rejected.
This change supplies no fake public pages. Deployment and page review remain release gates.
Verify each page without authentication, on a phone, and in each supported listing language.
The deletion page must explain requests, paying-admin restrictions, retention, provider cleanup, and support escalation.
Publish retention claims only after backend and privacy owners confirm them.

Publish the exact AASA and `assetlinks.json` files through the domain owner's normal deployment.
Use the final Apple team and bundle ID. Use the Play App Signing certificate for Android store links.
The upload certificate is a different identity. Verify both callback and product link paths.
Configuration tests use inert fixtures. They do not verify domain ownership or production association files.

## Protected release workflow and credentials

The workflow is `.github/workflows/mobile-release.yml`. It accepts only manual dispatch on `main`.
It rejects source commits outside `origin/main`. This stacked PR cannot release before its parents merge.
Create `mobile-preview` and `mobile-production` GitHub environments before enabling the workflow.
Restrict both environments to `main`. Require reviewers. Disable self-approval and administrative bypass where available.
Set environment variable `MOBILE_RELEASE_APPROVED=true` only after these rules exist.
Keep that variable absent while setup is incomplete. A missing value blocks execution.
The production environment protects both store profiles, including signed beta builds.
Separate approval is required for every build, update, rollback, or submission dispatch.
Require code-owner review for mobile release scripts, this workflow, app configuration, and dependency changes.
Add the Mobile checks to required branch protection. These GitHub settings are external gates.

Use EAS-managed iOS distribution, provisioning, APNs, Android upload, and submission credentials.
Use Play App Signing. Confirm custody, least privilege, recovery access, two-factor authentication, and rotation owners.
Provision credentials through the approved EAS dashboard before non-interactive builds.
For iOS submission, reserve the app in App Store Connect and configure the approved ASC app and Apple team IDs.
The submit profiles resolve those IDs from environment variables. No Apple password enters CI.
For Android, assign the service account to the correct EAS app and Play application with minimum release permissions.
The first Play upload may require a manual Console upload before API submission becomes available.

Protected GitHub secret names:

| Name | Use |
| --- | --- |
| `EXPO_TOKEN` | Restricted Expo account or robot access. Available only to the approved operation step and the automatic publish steps. |
| `MOBILE_UPDATE_CERTIFICATE_PEM` | Public update certificate. Required for every preview, beta, and production build, because all three enable signed updates. |
| `MOBILE_UPDATE_PRIVATE_KEY_PEM` | Private update signing key. Required for update publication or rollback, including the automatic publish. |
| `MOBILE_RELEASE_EVIDENCE_JSON` | Candidate-specific approval references. Required for store operations. |
| `MOBILE_STORE_METADATA_JSON` | Approved complete metadata snapshot. Required for submission; contains review instructions without credentials. |

Hosted credentials remain in EAS. If the organization later chooses CI-managed submission credentials, use reviewed file secrets.
Suggested names are `EXPO_ASC_API_KEY_P8`, `EXPO_ASC_KEY_ID`, `EXPO_ASC_ISSUER_ID`, and `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`.
They are not consumed by this workflow. Adding them requires a separate reviewed configuration change.
Never supply Apple, Google, Expo, service-role, API, signing, or store credentials in repository files.

The workflow installs dependencies before it receives secrets. It uses no dependency or release-output cache.
Provider output is suppressed because it can contain signed download URLs.
Inspect failures in the restricted EAS dashboard. Do not enable shell tracing or verbose Fastlane output.
No PR workflow receives release credentials. PR checks cannot build through EAS, publish, or submit.
The operation writes private files under `RUNNER_TEMP` with mode 0600. Cleanup runs after success or failure.
The public certificate uses `apps/mobile/release/update-certificate.pem` during the operation.
That generated public file is ignored by git but included in the EAS source archive.
Private keys and evidence stay outside the repository and EAS source archive.
`.easignore` excludes native output, environment files, signing files, and private key patterns.
Review the actual EAS source archive before the first hosted build. A filename filter is not a complete secret audit.

## Build, inspect, then submit

Run local checks from the repository root:

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --ignore-scripts
npm run mobile:build:packages
npm run mobile:check:graph
npm run mobile:expo:check
npm run mobile:doctor
npm run mobile:release:check
npm run mobile:lint
npm run mobile:typecheck
npm run mobile:test
npm run mobile:native:check
python3 -m unittest discover -s apps/mobile/scripts -p '*_test.py'
npm run mobile:export:smoke
npm run lint
npm run typecheck
git diff --check
```

`mobile:native:check` generates all four profiles with inert fixtures and a temporary test certificate.
It refuses existing native directories, then removes its generated files. It runs no hosted EAS or release-signing command.
It also checks certificate/key mismatch and proves that native link changes produce an incompatible Expo fingerprint.
`mobile:release:check` checks profile/channel mapping, version policy, metadata structure, privacy graph, and credential patterns.
It does not treat incomplete store templates as approved listings.
After a dependency change, review the full lockfile and privacy inventory before updating its digest:

```sh
node apps/mobile/scripts/check-release.cjs --privacy-digest
```

Local release plans have no side effects:

```sh
npm run mobile:release:plan -- build development android --dry-run
npm run mobile:release:plan -- build preview ios --dry-run
npm run mobile:release:plan -- build internal-beta ios --dry-run
npm run mobile:release:plan -- build production android --dry-run
```

`--execute` rejects local shells, pull requests, push jobs, wrong refs, dirty source, missing secrets, and absent approvals.
Do not bypass the wrapper with a direct publication command.
In GitHub Actions, choose **Mobile release → Run workflow** on `main`.
Select one action, profile, and platform. Supply the approved full source SHA and reserved build number.
For submit, update, or rollback, supply the exact platform runtime. Submission also needs the inspected EAS build ID.
The protected environment reviewer must compare these values with the release record.
Build approvals cover security, privacy, policy, metadata, and signing readiness.
Submission and update approvals also require devices, links, push, deletion, rollback, and backend compatibility evidence.
The initial build can precede final device evidence. It cannot be submitted before that evidence exists.
EAS build hooks build shared and client packages after dependency installation.

Download the exact finished artifacts through the restricted EAS dashboard.
Do not put signed download URLs or credentials in CI logs or PR comments.
Calculate SHA-256 over each IPA, AAB, dSYM archive, and mapping file.
Record EAS build metadata and source SHA alongside these checksums.
Use access-controlled storage for artifacts. Set access, retention, and deletion rules before uploading them.
If EAS supplies provenance or an attestation for the selected builder, retain and verify it.
Do not claim an attestation exists without retrieving and checking it.
The workflow intentionally uploads no artifacts or raw provider JSON to GitHub.

### Signed iOS gate

Use a macOS release host with the approved Xcode version. Keep extracted archives outside git.

```sh
shasum -a 256 "$IPA_PATH"
unzip -q "$IPA_PATH" -d "$INSPECTION_DIR"
codesign --verify --deep --strict "$APP_PATH"
codesign -d --entitlements :- "$APP_PATH" > "$INSPECTION_DIR/entitlements.plist" 2>/dev/null
security cms -D -i "$APP_PATH/embedded.mobileprovision" > "$INSPECTION_DIR/profile.plist"
plutil -lint "$APP_PATH/Info.plist" "$INSPECTION_DIR/entitlements.plist"
find "$APP_PATH" -name PrivacyInfo.xcprivacy -print
```

Inspect these restricted files locally. Do not publish complete provisioning profiles or certificate details as public artifacts.
Confirm bundle ID, team, version, build, distribution certificate, expiry, and App Store provisioning.
Require `get-task-allow=false`, approved application/keychain identifiers, production APNs, and exact Associated Domains.
Reject extra iCloud, HealthKit, location, tracking, background push, camera, microphone, or photo entitlements and usage strings.
Review every framework privacy manifest and the merged Xcode privacy report.
Confirm required reason API categories and codes against actual dependencies and use.
The generated app manifest sets tracking false. It does not supply App Privacy questionnaire answers.
When enabled, Expo Updates sends a persistent EAS client ID for update delivery.
It stores that ID in native preferences, outside auth storage. Review its retention and processor handling before activation.
Validate the signed archive in Xcode Organizer and App Store Connect without publishing it.
Record export options, signing evidence, dSYM UUIDs, and validation results.
No signed archive or Xcode validation is available in this Linux sandbox.

### Signed Android and 16 KB gate

Use current approved Android SDK tools and an independently verified bundletool release.

```sh
sha256sum "$AAB_PATH"
jarsigner -verify "$AAB_PATH"
keytool -printcert -jarfile "$AAB_PATH"
java -jar "$BUNDLETOOL_PATH" validate --bundle="$AAB_PATH"
java -jar "$BUNDLETOOL_PATH" dump manifest --bundle="$AAB_PATH" --module=base > "$INSPECTION_DIR/manifest.xml"
java -jar "$BUNDLETOOL_PATH" dump config --bundle="$AAB_PATH" > "$INSPECTION_DIR/bundle-config.txt"
python3 apps/mobile/scripts/check-android-artifact.py "$AAB_PATH"
zipalign -c -P 16 -v 4 "$GENERATED_APK_PATH"
apksigner verify --verbose --print-certs "$GENERATED_APK_PATH"
adb shell getconf PAGE_SIZE
```

Generate representative split APKs with bundletool on the approved release host.
Confirm `PAGE_ALIGNMENT_16K` in the bundle configuration and 16384 from the test device.
The ELF script checks every packaged `.so` LOAD segment. It cannot prove APK ZIP alignment or operating system behavior.
Require all three checks: ELF alignment, generated APK alignment, and a 16 KB device or emulator smoke run.
Inspect the final merged manifest, package ID, version code, min/target SDK, native ABIs, and signing certificate.
Compare certificate digests and expiry with the approved signing record. Android upload certificates can be self-signed.
Generated APKs use the selected local signing key. Inspect the Play-installed base APK separately for the Play signing identity.
The generated manifest allows internet, network state, vibration, and notification permissions.
FCM can add its receive permission during library merging. Review every final permission, including library additions.
Camera, microphone, external storage, overlay, and boot receiver permissions are explicitly blocked.
Reject unexpected exported components, cleartext traffic, debug flags, backup scope, and sensitive permissions.
Verify SecureStore backup exclusions in the exact package.
Check Play Console's native compatibility and pre-launch reports. Expo generation cannot prove 16 KB acceptance.

## TestFlight and Play preparation

Create organization-owned Apple Developer, App Store Connect, Play Console, and Expo organization access.
Accept current agreements and complete required organization verification.
Reserve identifiers and app records. Enable required push capabilities and assign credential owners.
Resolve Apple guideline 4.8 for GitHub login before submission. No Sign in with Apple implementation is included here.
Resolve payment policy, generated-content safeguards, encryption/export compliance, age ratings, and country decisions.
Do not invent an exception rationale, export declaration, review account, or privacy attestation.

Fill `apps/mobile/release/store-metadata.json` after product, privacy, and store review.
Store the approved snapshot in `MOBILE_STORE_METADATA_JSON`. Record its exact byte SHA-256 as `metadataSha256` in the evidence.
Record the inspected binary SHA-256 as `artifactSha256`. Missing metadata or checksums block submission.
Use the inventory in [MOBILE_STORE_ASSETS.md](MOBILE_STORE_ASSETS.md).
Supply support and deletion pages. Confirm provider deletion, retention, backups, and paying-admin escalation.
Provide disposable review access through App Store Connect or Play Console's restricted review fields.
Keep passwords and OAuth codes out of metadata files and automated flows.

Submit the inspected beta build ID through the protected workflow.
The wrapper verifies hosted platform, profile, identity, commit, version, build, runtime, and channel before submission.
Android submission creates a draft on the internal track. A store owner must review and release that draft.
iOS submission uploads to App Store Connect. It does not release the app to the public.
Automatic TestFlight group setup is disabled. Assign approved internal testers in App Store Connect.
Confirm processing, export compliance, tester access, and TestFlight expiry dates.
External TestFlight testers can require beta review. Record the review result before distribution.
Google personal accounts can require a closed test before production access. Confirm the current Console requirements.
Play internal testing alone does not satisfy every production-access requirement.

## Automatic updates for preview and internal-beta

`.github/workflows/mobile-update.yml` publishes a signed update after each push to `main`.
It runs when the push changes `apps/mobile/**`, `packages/client/**`, `packages/shared/**`, or `package-lock.json`.
**Actions → Mobile update → Run workflow** publishes the current `main` again.
It publishes to `preview` first. A failure there stops the run before `internal-beta` gets the change.
It never publishes to `production`. Production updates and every rollback stay on the protected release workflow.
One run publishes at a time. A queued run waits for the run in progress, so updates arrive in push order.

The workflow uses these settings:

| Name | Kind | Use |
| --- | --- | --- |
| `EXPO_TOKEN` | Secret | Expo robot token. When it is absent, the run skips with a notice and does not fail. |
| `MOBILE_UPDATE_CERTIFICATE_PEM` | Secret | Public certificate. It is written to `apps/mobile/release/update-certificate.pem` for the run. |
| `MOBILE_UPDATE_PRIVATE_KEY_PEM` | Secret | Signing key. It is written under `RUNNER_TEMP` with mode 0600 and removed after the run. |
| `MOBILE_UPDATE_KEY_ID` | Variable | Code-signing key ID (`main`). It must match the EAS environment value when both are set. |
| `MOBILE_UPDATES_AUTO` | Variable | Kill switch. `0` stops every automatic publish. Absent or any other value lets it run. |
The internal-beta leg also needs the repository variable `MOBILE_UPDATES_INTERNAL_BETA=1`. Leave it unset until the production identity (bundle IDs, scheme and HTTPS callback) is approved and set in the EAS `production` environment, because internal-beta builds read that environment.

The job uses the GitHub environment `mobile-updates`. Restrict it to `main` and give it no required reviewers.
Store the three secrets in that environment, not at repository level, so no other branch or workflow can read them.
A missing certificate, key, or key ID fails the run. Only a missing `EXPO_TOKEN` skips it.

`apps/mobile/scripts/publish-update.cjs` does each publish. The guarded wrapper in `release.cjs` cannot do it:
the wrapper requires the installed runtime, a manual dispatch, and approval evidence, and a push supplies none of them.
The script keeps the wrapper's other checks and adds its own:

1. It runs only in CI, on `main`, from a clean checkout of the pushed commit, and only for preview or internal-beta.
2. It reads the public configuration from the EAS environment with `eas env:pull`. EAS builds use the same values.
   The update therefore has the native fingerprint of a binary built from that environment.
3. It resolves the app config and requires signed updates, the project URL, the channel header, and the key ID.
4. It checks that the certificate is current RSA and matches the private key.
5. It requires one active channel mapped only to its matching branch, as the wrapper does.
6. It runs `eas update --channel <channel> --environment <environment> --platform all --private-key-path <key> --non-interactive --json`.
   The message is the commit subject and short SHA. No runtime override is passed. The fingerprint policy chooses the runtime.
7. It warns when no finished build on the channel runs the new runtime.
   That means the push changed native configuration. The update reaches no installed app until a new binary ships.

A change that needs a new native build must not ship as an update. That includes a native module, a config plugin,
and the native fields in `app.config.ts`. The change gives a new fingerprint, so its update reaches no current binary.
Build and distribute a new binary for it.

The app checks for an update at cold start and when it returns to the foreground, at most every 15 minutes.
It downloads the update in the background and shows **Update ready** with **Restart**. It never restarts by itself.
A person who closes the banner gets the update at the next cold start. Native code checks only to recover from a launch error
(`checkAutomatically: ON_ERROR_RECOVERY`), so the app controls every normal check. Settings → About shows the channel,
runtime, running update, and a **Check for updates** row. Check errors show only there.

To verify on a device:

1. Install a preview or beta build made after this change. Open Settings → About and record the channel and runtime.
2. Merge a harmless JavaScript change to `main`. Wait for **Mobile update** to finish. Its summary lists the update IDs.
3. Put the app in the background and open it again, or select **Check for updates**. Wait for **Update ready**.
4. Select **Restart**. About must show the new update ID and its publication time.
5. Cold start the app offline. It must open the cached update.

Before an embedded rollback on preview or internal-beta, set `MOBILE_UPDATES_AUTO=0`.
Otherwise the next push to `main` publishes over the rollback. Set it back after the fix merges.

## Runtime compatibility, channels, and rollback

Every profile uses `runtimeVersion: { policy: 'fingerprint' }`.
A native dependency, permission, entitlement, SDK, build configuration, or certificate change needs a compatible new binary.
Put native changes in app configuration or source-controlled config plugins. Generated native projects are ignored CNG output.
Do not edit generated native files for a release. The release wrapper rejects existing native directories.
The update wrapper compares the local platform fingerprint with the inspected installed runtime before publishing.
It never supplies a hand-written runtime override to `eas update`.
Inspect the EAS environment before approval. Keep its public configuration identical to the approved GitHub environment.
Do not change the native app configuration or build number between a build and its update.
API deployments and database migrations must preserve older installed binaries and payload schema version 1.
Test the previous release and current candidate against the intended backend before rollout.

`eas.json` sets `MOBILE_UPDATES_ENABLED=1` for preview, internal-beta, and production, and `0` for development.
`release/policy.cjs` records the same choice, and `mobile:release:check` fails when they differ.
An enabled build requires the public certificate at `apps/mobile/release/update-certificate.pem` and `MOBILE_UPDATE_KEY_ID`.
Without them, the app config stops with an error that names the missing value.
A binary built before this change has updates off. An update cannot turn updates on in that binary. Install a new build.
Use an organization-controlled RSA update key. Keep its private half in approved secret custody.
The public certificate is part of the native fingerprint. Rotation requires a new compatible binary and a migration plan.
EAS transport authentication and update signature verification protect different boundaries.

Before the first update, create each channel and its matching branch through the approved Expo administration process.
Record the one-to-one mapping in the release record. Never map preview, beta, and production to one branch.
Inspect mapping before every update or rollback. Stop if a rollout or unexpected branch mapping is active.
Use `eas channel:view CHANNEL --json` only in a restricted shell. Do not publish its raw output.
The wrapper verifies a single active mapping to the matching branch before update or rollback.
It targets channels explicitly. It does not move channel pointers or promote beta updates to production.

Preview and internal-beta also receive automatic updates (see above). Production receives updates only this way.
For an update, dispatch `update` with the exact profile, platform, source, build number, and installed runtime.
Approve a preview drill first, then a beta drill. Test signature rejection and compatible update delivery.
Record update group and platform IDs from the EAS dashboard.
Test online, offline, restart, cache fallback, and the previous binary.
Do not use OTA to bypass store policies or change unapproved native functionality.

For recovery, dispatch `rollback` with the same channel and exact affected platform runtime.
The guarded command uses `eas update:roll-back-to-embedded` with the update signing key.
The rollback directive returns compatible clients to their embedded update after they contact the update service.
It does not instantly reach offline devices. It cannot repair a native crash before update handling starts.
It does not downgrade native code, undo server mutations, or remove a broken store binary.
Republishing a known-good update is an alternative only after its runtime and signing identity match.
Use a separately reviewed operation for that alternative. This wrapper exposes only embedded rollback.
Do not change channel mappings or force-end an active rollout without a separate incident review.

Before beta, run this drill on each physical platform:

1. Install the exact signed binary. Record the embedded ID, channel, platform runtime, and certificate digest.
2. Publish an approved harmless compatible preview update through the protected workflow.
3. Restart and confirm the update. Disconnect and verify cached startup.
4. Publish the signed embedded rollback for that exact platform runtime.
5. Reconnect and restart until the embedded version returns. Record timing and update IDs.
6. Confirm an incompatible native change is rejected by the wrapper and requires a new binary.
7. Test a signature mismatch on an isolated preview build. Confirm recovery without leaking the test key.
8. Repeat on beta. Store the evidence before production approval.

## Release smoke, rollout, and incident response

Complete [MOBILE_RELEASE_CHECKLIST.md](MOBILE_RELEASE_CHECKLIST.md) on the exact TestFlight and Play internal builds.
Use [mobile E2E instructions](../apps/mobile/e2e/README.md). Deterministic tests cannot prove operating system integration.
Require zero known critical security defects and zero unresolved auth or data-loss defects.
Agree on beta baselines for crashes, sign-in success, API failures, duplicate sends, and push receipt failures.
Record numeric thresholds and owners before rollout. No new analytics, tracking, advertising, or replay SDK is added.
Use approved existing backend signals and voluntary tester reports. Redact private content and device tokens.

Start with internal testers. Expand to approved external beta audiences after review.
For initial public release, choose countries and manual publication carefully.
Apple phased release applies to eligible version updates. It is not an initial-launch percentage control.
Google's first production release does not offer the same staged-percentage controls as later eligible updates.
Confirm current store controls in the Console before approval. Never promise that a store binary can be rolled back.
For later eligible releases, record each rollout step, observation period, stop threshold, and approving owner.

If a threshold or security condition fails:

1. The release owner stops expansion and halts eligible store rollout controls.
2. The mobile owner identifies affected build numbers, runtimes, channels, and update IDs.
3. The backend owner checks auth, API, push workers, and compatibility before changing shared services.
4. Disable approved push categories or dispatch through the existing backend controls when needed.
5. Roll back a compatible update through the protected workflow if the embedded build remains safe.
6. For a native defect, ship a corrected binary with a higher build/version code. Keep older APIs working.
7. The privacy owner handles any disclosure or credential incident. Rotate affected keys through their custody systems.
8. Support sends approved instructions. Never request tokens, verifiers, callback URLs, or private repository content.
9. Record cause, affected audience, evidence, recovery time, and follow-up changes before resuming rollout.

## External gates that remain open

No hosted EAS build, EAS submission, production update, store upload, or physical-device run occurred in this phase's sandbox.
The release owner must supply organization accounts, identifiers, domains, EAS project access, and signing custody.
Protected GitHub environments, reviewers, required checks, and Expo channel mappings need administrator setup.
Store metadata, screenshots, privacy forms, retention, policy decisions, review access, and public pages need owner approval.
Signed archive validation, merged SDK privacy manifests, final package permissions, and 16 KB binary/device tests remain required.
TestFlight, Play internal distribution, physical push delivery, universal/app links, accessibility, and rollback drills need real evidence.
Backend deletion success does not prove Supabase cleanup, billing cancellation, or backup deletion.
Resolve that completion and support gap before launch. Do not describe these external gates as completed tests.
