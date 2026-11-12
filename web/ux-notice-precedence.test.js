"use strict";

// bc2r M2 (R54 acceptance of server-batch-bc2): a change that waited for the
// action lock and is refused does not replace a standing notice that the lock
// holder showed. The rule is the notice precedence in app-view.js: a refusal
// never replaces a standing notice; every other notice replaces the one shown.

const test = require("node:test");
const assert = require("node:assert/strict");
const { storage } = require("./test/account-ownership-fixture.js");
const storageModule = require("./app-storage.js");
const sessionModule = require("./app-session.js");
const { viewFixture } = require("./test/ux-view-fixture.js");

const SAVED_DATA_BLOCKED = "Data saved on this device needs recovery. Reload the page.";
const CLEANUP_FAILED = "Signed-out data on this device could not be cleared. Try again.";

function fireHostTimers(t, host) {
  const handles = new Set();
  host.setTimeout = (callback, delay) => {
    const handle = setTimeout(() => { handles.delete(handle); callback(); }, delay);
    handle.unref();
    handles.add(handle);
    return handle;
  };
  t.after(() => { for (const handle of handles) clearTimeout(handle); });
}

// The fixture records notices; these tests need the page's own presenter.
async function presenterFixture(t) {
  const current = await viewFixture(t);
  fireHostTimers(t, current.host);
  current.use.showNotice = current.view.showNotice;
  return current;
}

function shownNotice(current) {
  return current.elements.notice.hidden ? null : current.elements.noticeText.textContent;
}

// Starts a change while a synchronization holds the lock, lets the holder
// run, then releases the lock.
async function waiterBehind(current, holder, change) {
  current.state.actionLocked = true;
  const waiting = change();
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  await holder();
  current.state.actionLocked = false;
  return waiting;
}

// The lock holder validates saved display context and finds it needs
// recovery: the storage module blocks the workspace and shows its notice.
function displayContextHolder(current) {
  const failing = Object.freeze({
    ...storage,
    readSyncState: async () => ({ projectionPending: { stale: true }, deviceId: current.state.deviceId }),
    assertPersistedDisplayContext: () => {
      const error = new Error("display context does not match");
      error.name = "PersistedDisplayContextError";
      throw error;
    }
  });
  const blocked = storageModule.create({ state: current.state,
    external: { ...current.stale.external, syncStorage: failing }, use: current.use });
  return async () => {
    const projectionPending = current.state.projectionPending;
    await assert.rejects(blocked.validatePersistedDisplayContext(current.use.captureAccountContext()),
      { name: "PersistedDisplayContextError" });
    current.state.projectionPending = projectionPending;
  };
}

// The lock holder retries a pending sign-out cleanup and it fails: the session
// module enters sign-out recovery and shows its notice.
function cleanupHolder(t, current) {
  const session = sessionModule.create({ state: current.state, external: current.stale.external,
    use: current.use, emit: () => {} });
  // jsdom has no modal dialogs; sign-out recovery opens one when it renders.
  const dialog = current.elements.bootstrapDialog;
  dialog.showModal = () => dialog.setAttribute("open", "");
  dialog.close = () => dialog.removeAttribute("open");
  const warnings = [];
  current.host.console = { ...console, warn: (...values) => warnings.push(values) };
  const previous = globalThis.PomodoroughSentryClient;
  globalThis.PomodoroughSentryClient = { reportFrontendError: () => {} };
  t.after(() => { globalThis.PomodoroughSentryClient = previous; });
  return async () => {
    current.host.localStorage.setItem("pomodoroughPendingLogout", "1");
    const clearLocalData = current.use.clearLocalData;
    current.use.clearLocalData = async () => { throw new Error("cleanup failed"); };
    const result = await session.clearPendingLogoutData(current.use.cleanupIdentity(), current.use.captureAccountContext());
    current.use.clearLocalData = clearLocalData;
    assert.equal(result.cleared, false);
    assert.equal(current.state.logoutRecoveryRequired, true);
    assert.equal(warnings.length, 1);
  };
}

const WAITERS = Object.freeze({
  duration: (current) => current.use.issueDurationOperation("focus", 1_800_000),
  start: (current) => current.use.issueCommand("start"),
  addTask: (current) => current.use.addTask("Write report")
});

for (const waiter of Object.keys(WAITERS)) {
  test(`a refused ${waiter} leaves the recovery notice the lock holder showed`, async (t) => {
    const current = await presenterFixture(t);
    const result = await waiterBehind(current, displayContextHolder(current), () => WAITERS[waiter](current));
    assert.equal(result, false);
    assert.equal(current.state.workspaceBlocked, true);
    assert.equal(shownNotice(current), SAVED_DATA_BLOCKED);
  });

  test(`a refused ${waiter} leaves the sign-out cleanup notice the lock holder showed`, async (t) => {
    const current = await presenterFixture(t);
    const result = await waiterBehind(current, cleanupHolder(t, current), () => WAITERS[waiter](current));
    assert.equal(result, false);
    assert.equal(shownNotice(current), CLEANUP_FAILED);
  });
}

// A holder that blocks the controls but shows nothing: the slot is empty, so
// the waiter's own refusal, the lower-priority notice, is shown.
function silentHolder(current) {
  return async () => {
    current.state.bootstrapBlocked = true;
    current.view.render();
  };
}

const REFUSED = Object.freeze({
  duration: "Duration change could not be saved. Try again.",
  start: "Timer action could not be saved. Try again.",
  addTask: "Task change could not be saved. Try again."
});

for (const waiter of Object.keys(WAITERS)) {
  test(`a refused ${waiter} shows its own notice when no notice is shown`, async (t) => {
    const current = await presenterFixture(t);
    assert.equal(shownNotice(current), null, "no notice is shown before the wait");
    const result = await waiterBehind(current, silentHolder(current), () => WAITERS[waiter](current));
    assert.equal(result, false);
    assert.equal(shownNotice(current), REFUSED[waiter]);
  });
}

test("a refusal while saved data needs recovery says so when no standing notice is shown", async (t) => {
  const current = await presenterFixture(t);
  const holder = async () => {
    await displayContextHolder(current)();
    current.view.dismissNotice();
  };
  assert.equal(await waiterBehind(current, holder, () => WAITERS.duration(current)), false);
  assert.equal(shownNotice(current),
    "Data saved on this device needs recovery, so the change was not saved; reload the page.");
});

// bc2r3 L-1: once a later cleanup succeeds, the cleanup-failed notice no
// longer names a condition. It does not hide a later refusal, and the next
// render dismisses it.
async function cleanupFailsThenSucceeds(t, current) {
  await cleanupHolder(t, current)();
  assert.equal(shownNotice(current), CLEANUP_FAILED);
  const session = sessionModule.create({ state: current.state, external: current.stale.external,
    use: current.use, emit: () => {} });
  current.host.localStorage.setItem("pomodoroughPendingLogout", "1");
  const result = await session.clearPendingLogoutData(current.use.cleanupIdentity(), current.use.captureAccountContext());
  assert.equal(result.cleared, true);
  assert.equal(current.state.logoutRecoveryRequired, false);
}

// The holder blocks the controls without a render, so the stale cleanup notice
// is still shown when the refusal is ranked against it (bc2r4 Low-1).
function unrenderedHolder(current) {
  return async () => { current.state.bootstrapBlocked = true; };
}

test("a cleanup notice that no longer holds does not hide a later refusal", async (t) => {
  const current = await presenterFixture(t);
  await cleanupFailsThenSucceeds(t, current);
  assert.equal(shownNotice(current), CLEANUP_FAILED, "nothing has rendered since the cleanup");
  const holder = unrenderedHolder(current);
  const result = await waiterBehind(current, async () => {
    await holder();
    assert.equal(shownNotice(current), CLEANUP_FAILED, "the stale notice is still shown when the refusal is ranked");
  }, () => WAITERS.duration(current));
  assert.equal(result, false);
  assert.equal(shownNotice(current), REFUSED.duration);
});

test("a cleanup notice that no longer holds is dismissed on the next render", async (t) => {
  const current = await presenterFixture(t);
  await cleanupFailsThenSucceeds(t, current);
  current.view.render();
  assert.equal(shownNotice(current), null);
});

test("notice precedence: a refusal yields only to a standing notice", async (t) => {
  const current = await presenterFixture(t);
  const { showNotice } = current.view;
  showNotice("Ordinary failure.");
  showNotice("Refused change.", { precedence: "refusal" });
  assert.equal(shownNotice(current), "Refused change.", "a refusal replaces an ordinary notice");
  showNotice("Standing condition.", { precedence: "standing" });
  showNotice("Another refused change.", { precedence: "refusal" });
  assert.equal(shownNotice(current), "Standing condition.");
  showNotice("A newer failure.");
  assert.equal(shownNotice(current), "A newer failure.", "an ordinary notice replaces a standing one");
  showNotice("Standing condition.", { precedence: "standing" });
  current.view.dismissNotice();
  showNotice("Refused after dismiss.", { precedence: "refusal" });
  assert.equal(shownNotice(current), "Refused after dismiss.");
});
