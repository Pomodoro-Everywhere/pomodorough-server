"use strict";

// UX round 2 (A2, PWA-03): a failure the user can meet on the notice path
// shows one localized sentence. The error's own text goes to error reporting
// and never to the page.

const test = require("node:test");
const assert = require("node:assert/strict");
const { viewFixture, waitFor } = require("./test/ux-view-fixture.js");

const RAW = "QuotaExceededError: store.put failed {\"code\":22} at IDBObjectStore";
const RANGE = "Focus length was not changed: enter a whole number of minutes from 1 to 180.";

// The shared view fixture records notices; these tests present them instead.
async function presentingView(t) {
  const current = await viewFixture(t);
  current.use.showNotice = current.view.showNotice;
  current.view.setupPreferenceEvents();
  current.view.setupAccountEvents();
  current.reports = [];
  const previous = globalThis.PomodoroughSentryClient;
  globalThis.PomodoroughSentryClient = { reportFrontendError: (error, operation) => current.reports.push([error, operation]) };
  t.after(() => {
    if (previous === undefined) delete globalThis.PomodoroughSentryClient;
    else globalThis.PomodoroughSentryClient = previous;
  });
  return current;
}

function shownNotice(current) {
  const { notice, noticeText, noticeRetry } = current.elements;
  return notice.hidden ? null : { text: noticeText.textContent, retry: noticeRetry?.hidden === false };
}

async function enterDuration(current, input, value, eventName = "change") {
  const reported = current.reports.length;
  const before = current.state.durationsMs[input.name];
  input.value = value;
  input.dispatchEvent(new current.window.Event(eventName));
  await waitFor(() => current.reports.length > reported || current.state.durationsMs[input.name] !== before,
    `duration entry ${JSON.stringify(value)} to settle`);
  await new Promise((resolve) => setImmediate(resolve));
}

const FAILED_CHANGES = [
  ["duration", (use) => use.issueDurationOperation("focus", 1_800_000), "Duration change could not be saved. Try again."],
  ["auto-start", (use) => use.issueAutoStartOperation(false), "Auto-start preference could not be saved. Try again."],
  ["phase choice", (use) => use.issuePhaseSelection("short_break"), "Phase choice could not be saved. Try again."],
  ["timer start", (use) => use.issueCommand("start"), "Timer action could not be saved. Try again."]
];

for (const [name, attempt, sentence] of FAILED_CHANGES) {
  test(`a failed ${name} shows a localized sentence and reports the raw error`, async (t) => {
    const current = await presentingView(t);
    const failure = new Error(RAW);
    current.use.persistWorkspaceIntent = async () => { throw failure; };
    await attempt(current.use);
    await waitFor(() => current.reports.length === 1, "failure report");
    assert.deepEqual(shownNotice(current), { text: sentence, retry: false });
    assert.equal(current.reports[0][0], failure);
  });
}

test("saved data that fails validation asks for a reload instead of a retry", async (t) => {
  const current = await presentingView(t);
  const failure = Object.assign(new Error(RAW), { name: "PersistedDisplayContextError" });
  current.use.persistWorkspaceIntent = async () => { throw failure; };
  assert.equal(await current.use.issueDurationOperation("focus", 1_800_000), false);
  assert.deepEqual(shownNotice(current), { retry: false,
    text: "Data saved on this device needs recovery, so the change was not saved; reload the page." });
});

test("a duration below the field minimum states the allowed range and marks the focused field", async (t) => {
  const current = await presentingView(t);
  const input = current.elements.focusDuration;
  input.focus();
  await enterDuration(current, input, "0");
  assert.deepEqual(shownNotice(current), { text: RANGE, retry: false });
  assert.equal(input.getAttribute("aria-invalid"), "true");
  assert.equal(input.value, "0", "a focused field keeps the entry for correction");
  assert.equal(current.state.durationsMs.focus, 1_500_000);
  assert.match(current.reports[0][0].message, /invalid duration range/, "core's reason still reaches error reporting");
});

test("a rejected duration entry is restored on blur and the field is valid again", async (t) => {
  const current = await presentingView(t);
  const input = current.elements.focusDuration;
  await enterDuration(current, input, "", "blur");
  assert.deepEqual(shownNotice(current), { text: RANGE, retry: false });
  assert.equal(input.value, "25");
  assert.equal(input.hasAttribute("aria-invalid"), false);
});

test("a saved duration answers the range notice and clears the field mark", async (t) => {
  const current = await presentingView(t);
  const input = current.elements.focusDuration;
  input.focus();
  await enterDuration(current, input, "0");
  await enterDuration(current, input, "30");
  assert.equal(current.state.durationsMs.focus, 1_800_000);
  assert.equal(shownNotice(current), null);
  assert.equal(input.hasAttribute("aria-invalid"), false);
});

// Core answers an entry equal to the saved duration with a no-op, so nothing
// is saved and nothing is reported; the entry still answers the range notice.
test("re-entering the saved duration answers the range notice", async (t) => {
  const current = await presentingView(t);
  const input = current.elements.focusDuration;
  input.focus();
  await enterDuration(current, input, "0");
  assert.deepEqual(shownNotice(current), { text: RANGE, retry: false });
  input.value = "25";
  input.dispatchEvent(new current.window.Event("change"));
  await waitFor(() => shownNotice(current) === null, "the range notice to leave");
  assert.equal(current.state.durationsMs.focus, 1_500_000);
  assert.equal(input.hasAttribute("aria-invalid"), false);
});

test("a failed save of an in-range duration keeps its own sentence", async (t) => {
  const current = await presentingView(t);
  const input = current.elements.focusDuration;
  input.focus();
  await enterDuration(current, input, "0");
  current.use.persistWorkspaceIntent = async () => { throw new Error(RAW); };
  await enterDuration(current, input, "30");
  assert.deepEqual(shownNotice(current), { text: "Duration change could not be saved. Try again.", retry: false });
  assert.equal(input.hasAttribute("aria-invalid"), false);
});

async function submitTask(current, title) {
  const notices = current.elements.noticeText.textContent;
  const count = current.state.tasks.length;
  current.elements.taskInput.value = title;
  current.elements.taskForm.dispatchEvent(new current.window.Event("submit", { cancelable: true }));
  await waitFor(() => current.state.tasks.length !== count || current.elements.noticeText.textContent !== notices,
    `task ${JSON.stringify(title.slice(0, 12))} to settle`);
  await new Promise((resolve) => setImmediate(resolve));
}

test("a task that cannot be added shows a localized sentence, and the next added task answers it", async (t) => {
  const current = await presentingView(t);
  const addTask = current.use.addTask;
  current.use.addTask = async () => { throw new Error(RAW); };
  await submitTask(current, "Alpha");
  assert.deepEqual(shownNotice(current), { text: "Task could not be added. Try again.", retry: false });
  assert.equal(current.elements.taskInput.value, "Alpha", "the draft stays for the retry");
  current.use.addTask = addTask;
  await submitTask(current, "Alpha");
  assert.deepEqual(current.state.tasks.map((task) => task.title), ["Alpha"]);
  assert.equal(shownNotice(current), null);
});

test("a task title the core refuses keeps its own localized sentence", async (t) => {
  const current = await presentingView(t);
  await submitTask(current, "x".repeat(2000));
  assert.deepEqual(shownNotice(current), { text: "Task name is too long.", retry: false });
});

test("a notice carries its own retry, answers only its own kind, and leaves when stale", async (t) => {
  const current = await presentingView(t);
  const { view } = current;
  const attempts = [];
  view.showNotice("First.", { kind: "first", retry: () => attempts.push("retry") });
  assert.deepEqual(shownNotice(current), { text: "First.", retry: true });
  view.clearNotice("second");
  assert.notEqual(shownNotice(current), null);
  current.elements.noticeRetry.click();
  assert.deepEqual(attempts, ["retry"]);
  assert.equal(shownNotice(current), null);
  current.elements.noticeRetry.click();
  assert.deepEqual(attempts, ["retry"], "a hidden notice has no retry left");
  let stale = false;
  view.showNotice("Second.", { kind: "second", staleWhen: () => stale });
  assert.deepEqual(shownNotice(current), { text: "Second.", retry: false });
  view.render();
  assert.notEqual(shownNotice(current), null);
  stale = true;
  view.render();
  assert.equal(shownNotice(current), null);
  view.showNotice("Third.", { kind: "third" });
  view.clearNotice("third");
  assert.equal(shownNotice(current), null);
});

// Batch B (B3): the remaining notice paths that showed an error's own text.

test("a saved sync request that cannot be discarded shows one localized sentence", async (t) => {
  const current = await presentingView(t);
  const warnings = [];
  current.host.console.warn = (...entry) => warnings.push(entry);
  current.state.savedClaimRecovery = { armed: true };
  current.state.conflict = RAW;
  const failure = new Error(RAW);
  current.use.discardSavedClaimRecovery = async () => { throw failure; };
  current.elements.savedClaimDiscard.dispatchEvent(new current.window.Event("click"));
  await waitFor(() => shownNotice(current), "discard failure notice");
  assert.deepEqual(shownNotice(current),
    { text: "The saved sync request could not be discarded. Try again.", retry: false });
  assert.equal(warnings.some((entry) => entry[1] === failure), true, "the raw error goes to the console");
});

test("a change refused because saved data needs recovery does not show the stored error text", async (t) => {
  const current = await presentingView(t);
  Object.assign(current.state, { workspaceBlocked: true, conflict: RAW });
  assert.equal(await current.use.issueCommand("start"), false);
  assert.deepEqual(shownNotice(current), {
    text: "Data saved on this device needs recovery, so the change was not saved; reload the page.", retry: false
  });
});

test("saved display context that fails validation is told in one localized sentence", async (t) => {
  const current = await presentingView(t);
  const transaction = current.use.database().transaction("meta", "readwrite");
  transaction.objectStore("meta").put({ key: "projectionPending", value: { commands: "damaged" } });
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  await assert.rejects(current.use.validatePersistedDisplayContext(current.use.captureAccountContext()),
    { name: "PersistedDisplayContextError" });
  const sentence = "Data saved on this device needs recovery. Reload the page.";
  assert.deepEqual(shownNotice(current), { text: sentence, retry: false });
  assert.equal(current.state.conflict, sentence);
  assert.equal(current.state.bootstrapError, sentence);
  assert.equal(current.state.workspaceBlocked, true);
});

test("a history choice that cannot be saved shows the localized sentence, not the error text", async (t) => {
  const current = await presentingView(t);
  const failure = new Error(RAW);
  current.use.acquireBootstrapGate = async () => { throw failure; };
  current.state.bootstrapPlan = { mode: "choose", strategy: "keep_remote" };
  await current.use.chooseBootstrapStrategy("keep_remote", true);
  assert.deepEqual(shownNotice(current), { text: "History choice could not be saved.", retry: false });
  assert.equal(current.reports.some(([error, operation]) => error === failure && operation === "bootstrap.choice.deferred"),
    true, "the raw error is reported");
});
