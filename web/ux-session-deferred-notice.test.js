"use strict";

// UX round 2 (A2, PWA-05): a session check that fails at launch must not put
// the error's own text on the page. Offline has its own status and shows no
// notice; server trouble shows one localized sentence with a retry.

const test = require("node:test");
const assert = require("node:assert/strict");
const { ownerId } = require("./test/incarnation-fixture.js");
const { openApp, settle, shownNotice } = require("./test/ux-round2-app-fixture.js");
const { viewFixture } = require("./test/ux-view-fixture.js");

const SESSION_NOTICE = "Your account could not be reached; try again in a moment.";

function sessionChecks(current) {
  return current.control.requests.filter((request) => request.url === "/api/v1/me").length;
}

function deferredReports(current) {
  return current.control.reports.filter(([, operation]) => operation === "session.initialize.deferred");
}

test("server trouble at launch shows one localized sentence with a retry, not the error text", async (t) => {
  const current = await openApp(t, { meStatus: 503 });
  assert.deepEqual(shownNotice(current), { text: SESSION_NOTICE, retry: true });
  assert.equal(current.element("noticeRetry").textContent, "Try again");
  const [[error]] = deferredReports(current);
  assert.match(error.message, /503/, "the raw detail still reaches error reporting");
});

test("an offline launch shows the offline status and no notice", async (t) => {
  const current = await openApp(t, { online: false });
  assert.equal(shownNotice(current), null);
  assert.equal(current.element("syncStatusText").textContent.trim(), "Offline / local");
  assert.equal(deferredReports(current).length > 0, true, "the failure is still reported");
});

test("Try again repeats the session check and the notice leaves after recovery", async (t) => {
  const current = await openApp(t, { meStatus: 503 });
  const before = sessionChecks(current);
  current.element("noticeRetry").click();
  await settle();
  assert.equal(sessionChecks(current) > before, true);
  assert.deepEqual(shownNotice(current), { text: SESSION_NOTICE, retry: true }, "still failing: the sentence returns");
  current.control.meStatus = 200;
  current.element("noticeRetry").click();
  await settle();
  assert.equal(current.state.authenticated, true);
  assert.equal(shownNotice(current), null);
});

test("the session notice leaves when the browser goes offline", async (t) => {
  const current = await openApp(t, { meStatus: 503 });
  assert.notEqual(shownNotice(current), null);
  current.control.online = false;
  current.window.dispatchEvent(new current.window.Event("offline"));
  assert.equal(shownNotice(current), null);
});

test("Dismiss hides the session notice and a later render does not bring it back", async (t) => {
  const current = await openApp(t, { meStatus: 503 });
  current.element("noticeDismiss").click();
  current.app.render();
  assert.equal(shownNotice(current), null);
});

test("sign-out recovery explains itself, so the session failure adds no notice", async (t) => {
  const storage = { pomodoroughPendingLogout: "1", pomodoroughPendingLogoutOwner: JSON.stringify({ userId: ownerId("account-A") }) };
  const current = await openApp(t, { meStatus: 503, storage });
  assert.equal(current.state.logoutRecoveryRequired, true);
  assert.equal(shownNotice(current), null);
});

// Batch B (B3): the scheduled retry syncs when the session is already known,
// so no session check runs that could withdraw the notice. The retry itself
// settles the deferred session; "the notice leaves after recovery" above
// covers what settling does to the page.
test("the scheduled retry that goes straight to sync settles the deferred session", async (t) => {
  const current = await viewFixture(t);
  const timers = [];
  const settled = [];
  current.host.setTimeout = (callback, delay) => timers.push({ callback, delay });
  current.use.settleDeferredSession = () => settled.push(current.state.syncing);
  Object.assign(current.state, { authenticated: true, csrfToken: "csrf-ux" });
  current.use.scheduleRetry();
  await timers.at(-1).callback();
  assert.deepEqual(settled, [false], "settled once, before the sync starts");
});

test("the scheduled retry that repeats the session check leaves the notice to that check", async (t) => {
  const current = await viewFixture(t);
  const timers = [];
  const calls = [];
  current.host.setTimeout = (callback, delay) => timers.push({ callback, delay });
  current.use.settleDeferredSession = () => calls.push("settle");
  current.use.restoreSessionAndSync = async () => calls.push("session check");
  Object.assign(current.state, { authenticated: false, csrfToken: null });
  current.use.scheduleRetry();
  await timers.at(-1).callback();
  assert.deepEqual(calls, ["session check"]);
});

test("an account deletion that fails on the network shows the localized sentence", async (t) => {
  const current = await openApp(t, {});
  current.control.online = false;
  assert.equal(await current.app.deleteAccount("DELETE"), false);
  await settle();
  assert.deepEqual(shownNotice(current),
    { text: "Account deletion failed. Your local data was kept.", retry: false });
  assert.equal(current.control.reports.some(([error, operation]) =>
    error.message === "Failed to fetch" && operation === "session.delete-account.request-failed"), true);
});

test("an account deletion the server refuses keeps its localized status sentence", async (t) => {
  const current = await openApp(t, {});
  assert.equal(await current.app.deleteAccount("DELETE"), false);
  await settle();
  assert.deepEqual(shownNotice(current), { text: "Account deletion failed (503).", retry: false });
});

test("storage that cannot open at launch is told in one localized sentence", async (t) => {
  const failure = new Error("UnknownError: Internal error opening backing store for indexedDB.open.");
  const current = await openApp(t, { indexedDB: { open() { throw failure; } } });
  assert.deepEqual(shownNotice(current), {
    text: "Storage on this device is unavailable, so changes cannot be saved. Check browser storage, then reload the page.",
    retry: false
  });
  assert.equal(current.control.reports.some(([error, operation]) =>
    error === failure && operation === "startup.storage.unavailable"), true);
});
