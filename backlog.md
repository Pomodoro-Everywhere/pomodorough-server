# Production Readiness and Cross-Client Backlog

Audit date: 2026-08-20
Implementation status reconciled: 2026-08-21

Scope: Apple iOS/macOS, Android, Desktop (Qt/CLI/TUI), Web/PWA, and the Go synchronization service. Priorities reflect release/user-data risk rather than implementation size.

## Readiness snapshot

| Component | Current assessment | Remaining release qualification |
| --- | --- | --- |
| Apple iOS/macOS | Practical unsigned `0.3.0` release candidate | Developer signing, TestFlight, Developer ID signing, and notarization are excluded by request; tagged CI and downloaded-artifact verification remain |
| Android | API-36-targeting unsigned `0.3.0` release candidate | Production-keystore signing is excluded; the hosted API 35/36 instrumentation matrix and published unsigned artifacts require a real tagged run |
| Desktop | Practical unsigned `0.3.0` release candidate | Windows signing is excluded; tagged multi-platform builds, fresh downloads, and installed-entry-point smoke remain |
| Web/PWA | Release candidate with account deletion, localization, offline reconciliation, and conservative alert disclosure | Browser/PWA termination cannot guarantee an alert; deployed-server access is externally blocked, while the public Pages policy is staged for publication |
| Go service | Release candidate with erasure, bounded abuse controls, metrics, alerts, and scheduled restore drills | Production SSH deployment is externally blocked; tagged archives/SBOMs/attestations and the published Pages policy require release verification |

## Resolution matrix

`Complete` means the practical repository work and local verification are complete. `Release validation` means implementation exists but can only be proven by the tagged hosted workflow. Signing-related exclusions are deliberate and are not represented as completed.

| Item | Status | Resolution |
| --- | --- | --- |
| P0.1 | Complete, signing excluded | API 36 compile/target, behavior audit, tests, docs, and API 35/36 CI matrix are implemented; production signing is excluded. |
| P0.2 | Complete | Canonical versus projected timer state and every completion route are covered. |
| P0.3 | Complete | Android REST/Room/Iroh selected-task convergence and schema 12 migration are covered. |
| P0.4 | Excluded by request | Apple distribution signing, TestFlight, Developer ID signing, and notarization require unavailable credentials. |
| P0.5 | Release validation | Deletion flows and conservative policy copies are implemented; Pages publication/fetch follows the branch push. |
| P0.6 | Complete | Apple account switching is explicit, generation-safe, and non-destructive by default. |
| P0.7 | Complete | Destructive sign-out warnings include exact pending counts and safe cancellation. |
| P0.8 | Complete | Apple Iroh leave requires confirmation and preserves/restores the documented state. |
| P1.1 | Hosted-CI validation | Release depends on API 35/36 and 1.0×/2.0× instrumentation jobs with retained reports. |
| P1.2 | Complete | Desktop information architecture and terminology are documented and aligned while retaining native conventions. |
| P1.3 | Complete | Mobile Account → Network discovery and primary-route UI contracts are aligned and tested. |
| P1.4 | Complete | Android notification rationale, denial recovery, settings route, and exact-alarm fallback disclosure are implemented. |
| P1.5 | Complete with platform limitation | Overdue restoration and honest in-product guarantees are covered; Desktop/Web cannot promise alerts after process/browser termination. |
| P1.6 | Complete | Versioned byte-identical canonical fixtures and shipping-codec tests cover REST/Iroh domains and omission/null compatibility. |
| P1.7 | Complete with deployment limitation | Bounded per-IP/per-account limits, SSE caps, trusted-proxy handling, `Retry-After`, and privacy-safe audit events are tested; the limiter is process-local. |
| P1.8 | Complete except signing | SBOMs, checksums, immutable action pins, exact asset sets, and provenance attestations are implemented; Authenticode/checksum signing is excluded. |
| P1.9 | Release validation | Workflows perform clean builds, fresh downloads, exact-set/checksum/attestation checks, and supported install smoke; a real `0.3.0` run remains. |
| P1.10 | Complete | Arrivals filtering, totals, resolved/deleted/unassigned task context, and accessible summaries are aligned. |
| P1.11 | Complete | Desktop timer ownership prevents observer auto-finish/auto-start mutations. |
| P1.12 | Complete | Desktop Iroh completion advances phase independently of auto-start with ordering protection. |
| P1.13 | Complete | Local sign-out is offline-capable, retires active sync ownership, and is account-generation-safe. |
| P1.14 | Complete | Android validates drafts without clearing rejected input and reports inline localized errors. |
| P1.15 | Complete | Adaptive layouts, target sizes, font-scale matrix, and semantics are covered. |
| P1.16 | Complete | Desktop requires canonical selected-task fields and valid SSE status/media type with bounded reconnect. |
| P2.1 | Complete | Shared state/control terminology distinguishes Clear, Dismiss, and Stop sound. |
| P2.2 | Complete | VoiceOver/TalkBack, keyboard, focus order, RTL/pseudo, and large-text gates are present where locally practical. |
| P2.3 | Complete | Apple, Android, Desktop, and Web use validated English plus RTL pseudolocalization resources with plural/placeholder checks. |
| P2.4 | Partial; authentic drill externally blocked | Bounded request/error/latency metrics, alerts, backup-success monitoring guidance, and a scheduled synthetic restore regression are present. A periodic drill against an authentic encrypted production backup requires backup access unavailable to this environment. |
| P2.5 | Complete | Documentation links, versions, public policy URL, protocol fixtures, and workflow pins are CI-validated. |
| P2.6 | Complete | Finish phase provenance reconciles rejected/ignored completion without overwriting later selection. |
| P2.7 | Complete | Completion-affecting edits use documented next-timer semantics while active timer snapshots remain immutable. |
| P2.8 | Complete | Paused focus retains its captured task while next-focus selection remains explicitly editable. |
| P2.9 | Complete | Android exposes accessible completed-focus and per-task/unassigned summaries. |
| P2.10 | Complete | First-room Iroh activation is disabled or guided into Create/Join consistently. |

### Explicit remaining exclusions and external blockers

- Apple signing/TestFlight/Developer ID/notarization, Windows Authenticode, Android production-keystore signing, and signed checksum manifests are excluded by the user's current constraint.
- Production service deployment cannot be performed because both configured SSH targets reject the available credentials.
- A real restore drill cannot select/decrypt an authentic production backup because this environment has no backup-store access; the scheduled synthetic drill only protects restore tooling/schema mechanics.
- Android instrumentation cannot run locally because no device/emulator was connected; the hosted matrix is the required proof.
- Local SBOM/reproducible GNU-tar checks are unavailable because `syft`, Docker, and `gtar` are absent; pinned hosted workflows perform these gates.
- Account erasure removes the live per-user store and active sessions; it does not claim immediate deletion from backups, retained peer/Iroh logs, or external infrastructure.

## P0 — release and correctness blockers

### P0.1 Target Android 16 / API 36 before the Play deadline

**Evidence:** `android/app/build.gradle.kts` currently compiles with API 35 and targets API 34. Google’s official target API requirement says that starting 2026-08-31 new apps and updates must target Android 16 / API 36 or higher; existing API-34 apps also lose availability to new users on newer Android versions.

**Acceptance criteria:**
- Compile and target API 36.
- Audit Android 15/16 behavior changes, especially exact alarms, background execution, edge-to-edge, notifications, and credential flows.
- Run unit, lint, release-signing, migration, and instrumented UI/repository suites on API 35 and 36.
- Update README/toolchain and CI image declarations.

### P0.2 Make Android completed timers advance and display the next phase consistently

**Evidence:** `android/.../TimerRepository.kt:789-810` advances `selectedPhase` only when a running timer naturally expires (`completedAtDeadline`), not when the user manually presses Finish. `android/.../PomodoroughScreen.kt:1974-1981` always renders a non-null completed timer’s original phase/duration, producing the old phase at `00:00`. Apple, Desktop, and Web now show the selected next phase at full duration while retaining the completed source timer for history/alerts.

**Acceptance criteria:**
- Manual and deadline completion both select short/long break after focus and focus after either break.
- Completed presentation uses the next phase at its configured full duration; source completion identity/status remains authoritative for alerts, history, sync, and dismissal.
- Cover focus→short break, fourth focus→long break, both breaks→focus, manual completion, alarm completion, remote completion, restart, and auto-start behavior.

### P0.3 Add selected-task synchronization to Android

**Evidence:** server OpenAPI and Apple/Desktop/Web support `selectedTaskOperations`; Android `SyncRequest`, `BootstrapResolutionRequest`, and `SyncResponse` at `android/.../data/Models.kt:232-301` omit that domain, and Room has no pending selected-task operation queue. Android’s `selectedTaskId` is therefore local state while the other clients converge it across devices.

**Acceptance criteria:**
- Implement the selected-task operation wire model, durable Room queue/migration, HLC ordering, acknowledgements, optimistic replay, bootstrap keep/replace/merge, account-switch handling, and Iroh representation.
- Add API contract tests and cross-client fixtures proving Android converges with Web, Apple, and Desktop after offline concurrent selections/deletions.
- Preserve omission-vs-present-empty compatibility for older clients.

### P0.4 Ship installable, trusted Apple artifacts

**Evidence:** `apple/.github/workflows/release.yml:189-265` builds with signing disabled, removes signatures, and publishes an unsigned iOS IPA and unsigned/non-notarized macOS app. These are build artifacts, not normal production installation channels.

**Acceptance criteria:**
- Add protected signing credentials and produce a signed iOS archive/TestFlight build and a Developer ID-signed, hardened-runtime, notarized macOS package.
- Verify entitlements, provisioning, signatures, notarization tickets, clean-device install, launch, OAuth callback, notifications, and alarms.
- Retain clearly named unsigned simulator artifacts only as developer artifacts.

### P0.5 Publish privacy disclosures and implement account deletion

**Evidence:** all authenticated clients expose sign-in/sign-out, while the documented API surface provides logout/device revocation but no account-erasure endpoint. No repository contains a product privacy policy surfaced from the app. Store distribution with Google-backed accounts requires a clear privacy disclosure and user-accessible deletion path.

**Acceptance criteria:**
- Publish a stable HTTPS privacy policy describing Google profile data, timer/task/history data, tokens, retention, Iroh peer metadata, logs, backups, and deletion timelines.
- Add authenticated, re-confirmed account deletion that revokes all sessions and removes or tombstones user data safely, with tested backup-retention behavior.
- Link privacy and deletion from iOS, macOS, Android, Desktop, and Web account screens and store metadata.

## P1 — high-value production work

### P1.1 Enforce Android device tests in the release pipeline

The Android README requires a manual API-35 emulator gate, but hosted release CI only assembles the Android-test APK and can publish without running migration, repository, or Compose instrumentation tests.

**Acceptance criteria:** release publication depends on instrumented tests at supported font scales on API 35 and 36 (managed device, Firebase Test Lab, or a reliable self-hosted runner), with retained reports and screenshots.

### P1.2 Align macOS information architecture between Apple and Desktop

Apple macOS exposes Timer/Tasks/Arrivals as tabs, puts Pattern in a settings inspector, and places Network inside the Account sheet (`apple/Sources/Views/MainContainer.swift:23-50`). Desktop exposes Timer/Tasks/Arrivals/Network as top navigation and keeps Service Pattern in the timer layout (`desktop/src/pomodorough/ui.py:355-356,446-487`). The same feature changes location and hierarchy depending on which macOS client is installed.

**Acceptance criteria:** choose and document one desktop information architecture; use the same names and comparable hierarchy for Timer, Tasks, Pattern, Arrivals, Network, Account, and Settings while preserving native controls and window conventions.

### P1.3 Align iOS and Android navigation/discoverability

Apple iOS has four tabs (Timer, Tasks, Pattern, Arrivals) and hides Network/Account behind toolbar sheets (`apple/Sources/Views/ModernTabs.swift:10-22`). Android has five tabs including Network (`android/.../PomodoroughScreen.kt:1015-1021`) and keeps account actions in the header. This changes where users look for sync status and replication controls.

**Acceptance criteria:** define a shared mobile navigation map and terminology; make account, cloud sync status, and Iroh route controls discoverable in equivalent locations without violating iOS/Material conventions; add UI tests for every route.

### P1.4 Give Android notification permission the same explanatory onboarding as Apple

Apple presents a dedicated notification/alarm introduction before prompting (`PermissionIntroductionView.swift`). Android requests notification permission when Start is pressed (`MainActivity.kt:94-106`) without equivalent pre-permission context.

**Acceptance criteria:** explain timer-alert value before the Android system dialog, handle denial/permanent denial with a settings path, and clearly disclose when exact alarms are unavailable and an inexact fallback is active.

### P1.5 Define reliable completion behavior when clients are closed

Apple and Android schedule OS alarms. Desktop uses an in-process Qt tray notification (`desktop/src/pomodorough/ui.py:2132-2139`), and Web uses an in-page `Notification` (`server/web/app.js:1434-1450`); neither guarantees completion after process/browser termination.

**Acceptance criteria:** document each platform guarantee in-product; add supported background scheduling where possible, restore overdue timers deterministically on launch, and test sleep/reboot/process-kill/browser-close scenarios. Never imply closed-app alerts where the platform cannot provide them.

### P1.6 Add end-to-end cross-client protocol compatibility CI

The four timer convergence fixture copies currently have identical SHA-256 values, but repositories can evolve independently and most operation domains are tested only within one implementation.

**Acceptance criteria:** publish/version canonical fixtures for timer, tasks, durations, auto-start, selected task, bootstrap, UUIDv7/HLC, and Iroh; make every client consume the same revision; run mixed-version interoperability tests against the server before release.

### P1.7 Add abuse controls to public authentication and sync endpoints

The server has strong headers, CSRF/session controls, bounded payloads, and hardened systemd settings, but no application-level rate limiter or `429` handling is visible for auth challenge/exchange, refresh, bootstrap, sync, or SSE connection creation.

**Acceptance criteria:** define per-IP and per-account limits, bounded concurrent SSE sessions, reverse-proxy coordination, `Retry-After`, structured audit events, and tests that legitimate offline batch recovery remains possible.

### P1.8 Sign Windows releases and add artifact provenance

Desktop publishes an unsigned Windows executable, and Linux/server archives are checksum-only. This creates SmartScreen friction and weakens provenance.

**Acceptance criteria:** Authenticode-sign Windows binaries, publish SBOMs and build attestations for every artifact, sign checksum manifests, verify signatures in release CI, and document verification commands.

### P1.9 Add clean-install/upgrade smoke tests for published artifacts

Build checks do not fully prove that an end user can install, launch, upgrade, authenticate, preserve local data, and receive a timer alert from every published format.

**Acceptance criteria:** after publishing, download and checksum every artifact; install in clean iOS/macOS/Windows/Linux/Android environments; launch and verify version, migration, offline timer, notification, OAuth callback, and uninstall/upgrade behavior before marking the release complete.

## P2 — quality and operational hardening

### P2.1 Standardize timer dismissal language and state presentation

Use a shared state/control matrix for idle, running, paused, completed, cancelled, overdue, and alerting states. Standardize when controls say **Clear**, **Dismiss**, or **Stop sound**, and ensure a sound-related label is not shown when no sound is active.

### P2.2 Add accessibility and adaptive-layout parity gates

Automate VoiceOver/TalkBack semantics, keyboard-only navigation, focus order, contrast, reduced motion, RTL, and large text/font-scale checks. Desktop Qt and macOS should receive the same release-blocking accessibility attention as iOS/Android.

### P2.3 Add localization infrastructure

User-facing strings are largely embedded directly in Swift, Kotlin, Python, and HTML. Move them into platform localization resources, define plural rules and timer terminology once, and begin with English plus pseudolocalization/RTL CI.

### P2.4 Improve service observability and recovery drills

Add structured request/sync latency/error metrics, queue/conflict/bootstrap counters, alerting, backup success monitoring, and periodic tested restore drills. Keep identifiers and timer/task content out of logs by default.

### P2.5 Repair stale documentation and repository links

Examples found during the audit: Apple README still identifies the removed monolithic `Sources/Views.swift`; Android README links the server under the old personal namespace and says API 35 compile/API 34 target. Add a doc-link/version check to CI.

## Additional verified cross-client findings

### P0.6 Protect local Apple data during account switches

Android detects a mismatched account and requires an explicit destructive choice (`TimerRepository.kt:1583-1598`, `PomodoroughScreen.kt:648-685`). Apple proceeds after authentication and `prepare(for:)` replaces mismatched-owner state with fresh state (`AppModel.swift:2020-2029`, `Models.swift:1354-1377`). Block sync/mutations until the user chooses **Switch and remove local data** or cancels; never clear the previous workspace before confirmation, and test retry/relaunch.

### P0.7 Make destructive sign-out warnings equivalent

Apple reports pending changes in its sign-out confirmation (`AccountView.swift:101-120`); Desktop does not count or mention them (`desktop/src/pomodorough/ui.py:2058-2064`). Desktop must state the exact queued-change count, keep Cancel as the safe default, and test zero/nonzero queues.

### P0.8 Confirm leaving an Apple Iroh room

Desktop and Android explain that leaving restores the previous workspace; Apple immediately invokes `leaveIrohRoom()` (`NetworkSectionView.swift:195-203`, `AppModel.swift:1423-1436`). Add a destructive confirmation, describe restoration and retained room log, prevent duplicate submission, and preserve state on cancellation.

### P1.10 Standardize Arrivals scope, totals, and task context

Apple includes all retained history and counts every item, while Desktop filters completed entries and displays only eight (`HistoryScreen.swift:18-40`, `desktop/src/pomodorough/ui.py:1237-1259`). iOS rows also omit associated task titles that Android displays (`HistoryRow.swift:14-35`, Android `PomodoroughScreen.kt:2305-2310`). Define one completed/cancelled/superseded contract, label pagination honestly, and display/announce resolved or deleted task context consistently.

### P1.11 Prevent Desktop observer devices from auto-finishing remote timers

Desktop expiry paths enqueue Finish without durable timer ownership (`ui.py:1377-1404,1451-1497`), unlike Apple, Android, and Web ownership guards. Persist owner identity; only the owner may auto-finish/auto-start, while observers project expiry without outbox mutations. Test two desktops, remote starts, offline/restart, and canonical replacement.

### P1.12 Advance Desktop Iroh phase independently of auto-start

Desktop installs completed Iroh projections but derives the next phase only inside the auto-start-focus branch (`storage.py:4211-4241,4289-4323`). Persist focus→short/long-break and break→focus even when auto-start is disabled, without overwriting a later explicit phase change; test all phases and both auto-start states.

### P1.13 Make local sign-out work offline and during active sync

Web and Android retain local account data when server logout fails, while Desktop silently ignores confirmed logout during busy cloud work; Apple clears locally and revokes remotely best-effort. After pending-change confirmation, every client must invalidate local session/sync ownership and remove account-bound local state offline, with remote revocation retried separately. Test logout races, offline logout, and immediate account-B login.

### P1.14 Validate Android task drafts before clearing them

Android enables Add without domain validation and clears drafts before repository rejection (`PomodoroughScreen.kt:1418-1440`, `TimerRepository.kt:953-960`); iOS validates trimmed UTF-8 length first. Disable invalid drafts, retain rejected text with inline feedback, and test whitespace, control characters, multibyte 512-byte boundaries, duplicates, and success.

### P1.15 Close mobile adaptive-layout gaps

Android Pattern rows retain fixed horizontal controls at large font scales (`PomodoroughScreen.kt:2178-2237`), while iOS stacks controls and exposes adjustable semantics (`DurationRow.swift:13-51`). Verify narrow-width 1.3×/1.5×/2.0× layouts, 48dp targets, and complete TalkBack semantics.

### P1.16 Require canonical selected-task fields and valid SSE on Desktop

Desktop accepts sync responses missing required `selectedTaskId`/acknowledgements and does not validate SSE status/media type (`storage.py:2455-2522`, `network.py:799-841`). Reject incomplete snapshots without mutating durable claims, require HTTP 200 plus `text/event-stream`, and add bounded jittered reconnect with malformed/204/non-SSE tests.

### P2.6 Reconcile optimistic phase advancement after rejected Finish

Apple and Web advance phase when queuing Finish but lack Desktop/Android-style outcome provenance and rollback (`AppModel.swift:738-760`, `web/app.js:1363-1391`). Persist source timer, advanced phase, and generation; retain advancement only for matching canonical completion; roll back rejected/ignored finishes without overwriting later user selection.

### P2.7 Standardize settings mutability during active timers

Apple freezes duration and auto-start settings while active; Desktop allows both, and Android allows auto-start but not duration changes. Adopt one rule—prefer clearly labeled “applies to next timer” edits or freeze all completion-affecting settings—and prove the active timer remains immutable.

### P2.8 Align paused-timer next-task editing

Apple shows static task text while paused; Desktop permits selecting the next focus task. Decide one semantic, communicate that it never reassigns the paused timer, and test it across clients.

### P2.9 Add Android completed-focus breakdown parity

iOS offers totals, charts, and per-task focus summaries (`CompletedFocusBreakdownScreen.swift`); Android’s Arrivals count is noninteractive. Add an accessible Android summary using identical completed-focus filtering and explicit unassigned totals.

### P2.10 Guide Iroh activation consistently

Apple disables Iroh until a room exists; Android/Desktop allow actions that can persist or attempt an unusable route. Either disable with an accessible explanation or launch Create/Join directly, and test signed-out first-room setup.

## Shared definition of done

Every backlog item that changes core state or sync must include:
1. durable-write-before-render behavior;
2. offline queue and restart tests;
3. exact acknowledgement/reconciliation tests;
4. account switch and bootstrap keep/replace/merge tests;
5. trusted-clock/HLC and duplicate/retry tests;
6. cross-client compatibility coverage;
7. user-visible error/recovery states and accessibility semantics;
8. release artifact install/upgrade verification where applicable.
