# Cross-client experience contract

Status: release contract for Pomodorough clients

This document defines product semantics shared by Apple, Android, Desktop, and Web. Native controls and platform conventions may differ, but route names, state meaning, destructive actions, and accessibility labels must remain equivalent.

## Navigation

### Mobile

The primary routes are **Timer**, **Tasks**, **Pattern**, and **Arrivals**. **Account** is available from the app bar on every primary route. **Network** is a clearly labelled route inside Account, with cloud-sync status and Iroh status summarized on the Account entry control.

An implementation may use a sheet, pushed route, or Material destination according to platform convention. Network must not be a fifth primary destination on only one mobile platform.

### Desktop

The primary destinations are **Timer**, **Tasks**, **Arrivals**, and **Network**. **Account** and **Settings** are persistent app-bar/menu actions. **Pattern** is a named section of Settings and is linked from Timer; it is not presented as an unrelated timer control cluster.

Window chrome and inspector/sidebar presentation remain native to macOS, Windows, and Linux. Route names and hierarchy do not change between the Apple macOS and Qt clients.

## Timer state and controls

| Source state | Primary control | Secondary control | Presentation |
| --- | --- | --- | --- |
| Idle | Start | — | Selected phase at full configured duration |
| Running | Pause | Finish | Canonical phase and elapsed time |
| Paused | Resume | Finish | Canonical phase and elapsed time |
| Completed, alert active | Start next | Stop sound | Selected next phase at full duration; completion remains canonical |
| Completed, no alert | Start next | Dismiss | Selected next phase at full duration; completion remains canonical |
| Cancelled or superseded | Start | Dismiss | Selected phase at full duration; retained history remains canonical |
| Overdue observer projection | — | — | Expired presentation without an observer-generated Finish command |

**Clear** means removing a terminal timer from the timer surface. **Dismiss** means acknowledging a terminal state. **Stop sound** is shown only while an alert is actually sounding.

The canonical/source timer is synchronization and history truth. A full-duration next phase shown after completion is presentation state and never changes the completed timer identity or status.

## Pattern edits during an active timer

Duration, automatic-break, and selected-phase edits remain available and are labelled **Applies to next timer** while a timer is running or paused. They never change the active timer's phase, planned duration, elapsed value, task, or completion deadline.

If a client cannot communicate that distinction accessibly, it may freeze the controls during the active timer instead. It must not silently apply an edit to the current timer.

## Paused timer and task selection

Task selection while a focus timer is running or paused edits the **Next focus task** only. It never reassigns the active timer or its eventual history item. The active assignment remains visible and announced separately.

## Arrivals

Arrivals includes retained completed, cancelled, and superseded history. Filters must name the included states. Totals always describe the filtered collection, not only currently rendered rows.

Each row resolves task context as:

1. retained task title;
2. **Deleted task** when a historical task reference no longer resolves;
3. **Unassigned** when no task was assigned.

Pagination or truncation must be labelled honestly. A visual list of eight rows must not announce itself as the complete total.

## Account safety and deletion

Sign-out is local-first. After confirmation, the local session, account-bound database state, synchronization ownership, and queued dispatch are invalidated without requiring a network response. Server revocation is best-effort and durably retried.

When unsynchronized work exists, confirmation states the exact aggregate count and makes Cancel the safe default.

A different authenticated account never overwrites a previous local workspace before an explicit **Switch and remove local data** confirmation. Cancelling preserves the previous workspace.

Permanent deletion requires typing `DELETE`, calls `DELETE /api/v1/account`, and clears local account data only after the server confirms deletion. Every Account surface links to the stable privacy policy at <https://pomodorough.egigoka.me/privacy>.

## Completion guarantees

| Platform | Closed-process guarantee |
| --- | --- |
| iOS and macOS | OS notification request, subject to user authorization and operating-system delivery policy |
| Android | Exact alarm when permitted; otherwise an explicitly disclosed inexact fallback |
| Desktop Qt/CLI/TUI | No closed-process guarantee unless a separately installed OS scheduler/helper is active; overdue timers reconcile deterministically on launch |
| Web/PWA | No browser-terminated guarantee; notifications and repeating sound require an active PWA/browser context; overdue timers reconcile on launch |

Clients must present these limits before requesting notification or alarm permission and must not imply a guarantee the platform cannot provide.

## Iroh activation and leaving

When no room exists, the Network route presents **Create room** and **Join room**. Selecting Iroh launches that chooser directly or leaves the Iroh control disabled with an accessible explanation; it must not persist Iroh mode until room creation or join succeeds. Cancelling the chooser preserves the previous replication mode and workspace.

First-room setup is available while signed out because Iroh room authentication is independent of a centralized Pomodorough account. Create and Join remain usable, and cloud sign-in is not presented as a prerequisite. Clients test this signed-out path as well as failed and cancelled room setup.

The current Web/PWA is centralized/offline only and does not expose an Iroh route. It must not imply that the account server relays peer traffic; if a future Web transport adds Iroh, it follows the same chooser and activation rules.

Leaving a room is destructive, restores the previous workspace, retains the room log according to local retention rules, and requires confirmation. Duplicate leave submission is blocked.

## Wire compatibility

Shared operation, response, explicit selected-task-null, and DST fixtures are
versioned as [`protocol-fixtures-v1.json`](protocol-fixtures-v1.json). Every
repository pins SHA-256
`544fa8a8f33361e80421e1f8395223c6a1e1ff243f9583b6baee6d2a1f1112d0` in CI,
so the copies must remain byte-identical. OpenAPI and shipping decoders reject
missing required fields, invalid enum values, malformed nullable selections,
and invalid acknowledgement sets. Server timestamps are absolute RFC 3339
instants; clients do not derive elapsed time from local timezone transitions.

## Accessibility and localization gates

Release checks cover keyboard/focus order, screen-reader names and values, reduced motion, contrast, RTL mirroring, and large text at the platform's supported scales. Interactive targets are at least 44×44 pt on Apple platforms and 48×48 dp on Android.

User-facing text belongs in platform localization resources. The initial locales are English and pseudolocalized RTL. Canonical English terminology is:

- Focus
- Short break
- Long break
- Timer
- Tasks
- Pattern
- Arrivals
- Network
- Account
- Settings
- Start, Pause, Resume, Finish, Dismiss, Stop sound
- Unassigned, Deleted task, Applies to next timer

Pluralized queue warnings use platform plural rules rather than string concatenation.
