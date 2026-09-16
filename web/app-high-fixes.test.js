"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const incarnationFixture = require("./test/incarnation-fixture.js");
const syncModule = require("./app-sync.js");
const viewModule = require("./app-view.js");

const webDirectory = __dirname;
const english = JSON.parse(fs.readFileSync(path.join(webDirectory, "locales/en.json"), "utf8"));
const rtl = JSON.parse(fs.readFileSync(path.join(webDirectory, "locales/ar-XB.json"), "utf8"));

function stubElement(overrides = {}) {
  const listeners = new Map();
  return {
    textContent: "", hidden: true, disabled: false, dataset: {}, open: true,
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, callback) { listeners.set(name, callback); },
    click() { listeners.get("click")?.(); },
    ...overrides
  };
}

function viewState(overrides = {}) {
  return {
    authenticated: true, bootstrapBlocked: false, bootstrapConflict: false,
    bootstrapError: null, bootstrapLimitError: null, bootstrapOwnershipConfirmation: false,
    bootstrapPending: null, bootstrapPlan: null, bootstrapPreview: { history: [] },
    bootstrapStrategy: null, bootstrapSubmitting: false, logoutRecoveryRequired: false,
    ...overrides
  };
}

function viewFixture({ state: stateOverrides = {}, tr, plan = null } = {}) {
  const state = viewState({ bootstrapPlan: plan, ...stateOverrides });
  const names = ["bootstrapTitle", "bootstrapSummary", "bootstrapDialog", "bootstrapChoices",
    "bootstrapConfirmation", "bootstrapError", "bootstrapRetry", "bootstrapSignOut",
    "bootstrapConfirm", "bootstrapCancel", "logoutButton", "deleteAccountButton",
    "conflictDismiss", "notice", "noticeText", "noticeDismiss"];
  const elements = Object.fromEntries(names.map((name) => [name, stubElement()]));
  elements.notice.hidden = true;
  elements.bootstrapChoiceButtons = [];
  const host = {
    document: {}, navigator: { onLine: true }, console: { warn() {} },
    addEventListener() {}, setTimeout: (callback) => { callback(); return 1; }
  };
  const syncCore = {
    ...incarnationFixture.sync,
    bootstrapDialogView: () => ({ open: true, busy: false, choosing: true, confirming: false, failed: false }),
    completedHistoryCount: (history = []) => history.length,
    confirmationFor: () => ({ title: "Confirm", message: "Apply?", confirmLabel: "Apply" })
  };
  const use = {
    localBootstrapState: () => ({ history: [] }),
    logout: () => {}, deleteAccount: () => {}, retryPendingLogout: () => {},
    redirectToLogin: () => {}, closeRevisionStreamForIdentityChange: () => {},
    clearLocalData: async () => {},
    tr: tr || ((_key, _args, fallback) => fallback)
  };
  const view = viewModule.create({ state, external: { host, syncCore, syncStorage: {}, elements }, use });
  return { elements, host, state, use, view };
}

function recordingTr(seen) {
  return (key, args, fallback) => {
    seen.push([key, args]);
    return `[[${key}]]`;
  };
}

test("bootstrap summary localizes title, run counts, and divergence note", () => {
  const fixture = viewFixture({ plan: { mode: "choose", localHistoryCount: 1, remoteHistoryCount: 2 } });
  fixture.view.renderBootstrapDialog();
  assert.equal(fixture.elements.bootstrapTitle.textContent, "Choose synchronized state");
  assert.equal(fixture.elements.bootstrapSummary.textContent,
    "1 local completed run; 2 remote completed runs. Timers, tasks, or settings may also differ.");
});

test("bootstrap limit recovery localizes title and summary", () => {
  const fixture = viewFixture({ state: { bootstrapLimitError: "too many operations" } });
  fixture.view.renderBootstrapDialog();
  assert.equal(fixture.elements.bootstrapTitle.textContent, "Local queue too large");
  assert.equal(fixture.elements.bootstrapSummary.textContent,
    "Upload stopped before any local or remote data changed.");
});

test("bootstrap summary routes every fragment through i18n keys", () => {
  const seen = [];
  const fixture = viewFixture({ tr: recordingTr(seen), plan: { mode: "choose", localHistoryCount: 1, remoteHistoryCount: 2 } });
  fixture.view.renderBootstrapDialog();
  assert.equal(fixture.elements.bootstrapTitle.textContent, "[[bootstrap.title]]");
  assert.ok(seen.some(([key, args]) => key === "bootstrap.localRuns" && args.count === 1));
  assert.ok(seen.some(([key, args]) => key === "bootstrap.remoteRuns" && args.count === 2));
  assert.match(fixture.elements.bootstrapSummary.textContent, /\[\[bootstrap\.localRuns\]\]/);
  assert.match(fixture.elements.bootstrapSummary.textContent, /\[\[bootstrap\.remoteRuns\]\]/);
  assert.match(fixture.elements.bootstrapSummary.textContent, /\[\[bootstrap\.divergenceNote\]\]/);
  assert.doesNotMatch(fixture.elements.bootstrapSummary.textContent, /Timers, tasks/);
});

test("bootstrap limit recovery routes title and summary through i18n keys", () => {
  const seen = [];
  const fixture = viewFixture({ tr: recordingTr(seen), state: { bootstrapLimitError: "too many operations" } });
  fixture.view.renderBootstrapDialog();
  assert.equal(fixture.elements.bootstrapTitle.textContent, "[[bootstrap.limitTitle]]");
  assert.equal(fixture.elements.bootstrapSummary.textContent, "[[bootstrap.limitSummary]]");
  assert.ok(seen.some(([key]) => key === "bootstrap.limitTitle"));
  assert.ok(seen.some(([key]) => key === "bootstrap.limitSummary"));
});

test("timer toggle has a static localized label resource", () => {
  const html = fs.readFileSync(path.join(webDirectory, "app.html"), "utf8");
  assert.match(html, /<button[^>]*id="timerToggle"[^>]*data-i18n="timer\.startFocus"[^>]*>/);
  assert.equal(english["timer.startFocus"], "Start focus");
  assert.ok(Object.hasOwn(rtl, "timer.startFocus"), "pseudolocale needs timer.startFocus");
});

test("new bootstrap resources exist in both catalogs with matching placeholders", () => {
  for (const key of ["bootstrap.limitTitle", "bootstrap.limitSummary", "bootstrap.divergenceNote"]) {
    assert.equal(typeof english[key], "string");
    assert.equal(typeof rtl[key], "string");
  }
  for (const key of ["bootstrap.localRuns", "bootstrap.remoteRuns"]) {
    assert.deepEqual(Object.keys(english[key]).sort(), ["one", "other"]);
    assert.deepEqual(Object.keys(rtl[key]).sort(), ["one", "other"]);
    assert.match(english[key].one, /\{count\}/);
    assert.match(rtl[key].one, /\{count\}/);
  }
});

function syncState(overrides = {}) {
  return {
    actionLocked: false, authenticated: true, bootstrapBlocked: false, bootstrapGateOwned: false,
    bootstrapGatePersisted: false, bootstrapPending: null, conflict: null, csrfToken: "csrf",
    deviceId: "device-1", durationsMs: { focus: 1_500_000 }, history: [], localOwnerId: incarnationFixture.ownerId("user-1"),
    pending: [], pendingAutoStartOperations: [], pendingDurationOperations: [],
    pendingSelectedTaskOperations: [], pendingTaskOperations: [], ready: true, retrying: false,
    revision: 2, selectedPhase: "focus", sessionIdentityValidated: true, syncing: false,
    timer: { status: "idle" }, user: incarnationFixture.accountUser("user-1"), ...overrides
  };
}

function syncFixture(postMutation) {
  const current = syncState();
  const calls = [];
  const timers = [];
  const host = {
    navigator: { onLine: true }, console: { warn: (...args) => calls.push(["warn", ...args]) },
    clearTimeout: () => {}, setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; }
  };
  const acknowledgement = { acknowledgements: [], acknowledgedIds: [] };
  const syncCore = {
    ...incarnationFixture.sync,
    requiresBootstrapResolution: () => false, compareTimerCommands: () => 0,
    buildSyncBatch: (queues) => queues,
    validateCanonicalResponse: () => ({ commands: acknowledgement, tasks: acknowledgement,
      durations: acknowledgement, autoStart: acknowledgement, selectedTask: acknowledgement })
  };
  const syncStorage = {
    AccountOwnershipError: incarnationFixture.storage.AccountOwnershipError,
    assertAccountOwnership: incarnationFixture.storage.assertAccountOwnership,
    normalizeLegacyDurationOperations: async () => {},
    readBootstrapState: async () => ({ gate: null, resolution: null }),
    readQueues: async () => ({ commands: [{ id: "command-1" }] }),
    readSyncState: async () => ({ snapshot: { user: current.user }, commands: [{ id: "command-1" }] }),
    reconcileState: () => { throw new Error("must not reconcile a rejected batch"); },
    retireProofAndPersistOutgoing: async () => ({ proof: null }),
    applySyncResponse: async () => { calls.push("apply"); return { applied: true }; }
  };
  const use = {
    captureAccountContext: () => incarnationFixture.captureAccountContext(current, host),
    clone: structuredClone, normalizeTimer: (value) => value,
    emptyTimer: (phase, duration) => ({ phase, duration }), selectedDurationMs: () => 1_500_000,
    normalizeDurationsMs: (value) => value, selectedPhaseAfterCommandAcknowledgements: (phase) => phase,
    snapshotValue: (value) => value, settingsValue: (value) => value, tabId: () => "tab-1",
    reloadPersistedState: async () => {}, database: () => ({}),
    setInFlightDurationOperationIds: () => {}, stopCompletionAlert: () => {},
    closeRevisionStream: () => {}, quarantineOwnerState: () => {},
    render: () => calls.push("render"), renderSyncStatus: () => calls.push("status"),
    tr: (_key, _args, fallback) => fallback, redirectToLogin: () => calls.push("login"),
    queueSessionRevalidation: () => calls.push("revalidate"),
    restoreSessionAndSync: () => calls.push("restore"),
    compareDurationOperations: () => 0, rebuildOptimisticState: () => {}, postMutation
  };
  const actions = syncModule.create({ state: current, external: { host, syncCore, syncStorage }, use, listen: () => {} });
  return { actions, calls, current, timers, use };
}

function conflictResponse(error) {
  return async () => ({ response: { ok: false, status: 409, json: async () => ({ error }) }, timing: {} });
}

test("sync incarnation conflict revalidates the session without retrying", async () => {
  const fixture = syncFixture(conflictResponse("account incarnation changed"));
  await fixture.actions.syncNow(true);
  assert.ok(fixture.calls.includes("revalidate"));
  assert.ok(!fixture.calls.includes("apply"));
  assert.equal(fixture.current.retrying, false);
  assert.equal(fixture.timers.length, 0);
});

test("sync revision exhaustion retries instead of revalidating ownership", async () => {
  const fixture = syncFixture(conflictResponse("revision exhausted"));
  await fixture.actions.syncNow(true);
  assert.ok(!fixture.calls.includes("revalidate"));
  assert.ok(!fixture.calls.includes("apply"));
  assert.equal(fixture.current.retrying, true);
  assert.equal(fixture.timers.length, 1);
  assert.ok(fixture.calls.some((call) => Array.isArray(call) && call[0] === "warn"));
});

test("sync conflict without a readable body retries instead of revalidating ownership", async () => {
  const fixture = syncFixture(async () => ({ response: { ok: false, status: 409 }, timing: {} }));
  await fixture.actions.syncNow(true);
  assert.ok(!fixture.calls.includes("revalidate"));
  assert.equal(fixture.current.retrying, true);
  assert.equal(fixture.timers.length, 1);
});

test("notices stay visible with an alert role until dismissed", () => {
  const fixture = viewFixture();
  fixture.view.showNotice("Timer action could not be saved.");
  assert.equal(fixture.elements.notice.hidden, false);
  assert.equal(fixture.elements.noticeText.textContent, "Timer action could not be saved.");
  assert.equal(fixture.elements.notice.attributes.role, "alert");
  assert.equal(fixture.elements.notice.attributes["aria-live"], "assertive");
  fixture.view.dismissNotice();
  assert.equal(fixture.elements.notice.hidden, true);
});

test("notices fall back to the container when no text child exists", () => {
  const fixture = viewFixture();
  delete fixture.elements.noticeText;
  fixture.view.showNotice("Phase choice could not be saved.");
  assert.equal(fixture.elements.notice.hidden, false);
  assert.equal(fixture.elements.notice.textContent, "Phase choice could not be saved.");
});

test("notice dismiss button hides the notice", () => {
  const fixture = viewFixture();
  fixture.view.setupAccountEvents();
  fixture.view.showNotice("Task could not be added.");
  assert.equal(fixture.elements.notice.hidden, false);
  fixture.elements.noticeDismiss.click();
  assert.equal(fixture.elements.notice.hidden, true);
});
