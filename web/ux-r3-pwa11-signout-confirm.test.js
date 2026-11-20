"use strict";

// PWA-11: signing out with unsynced changes asks in an in-page dialog styled
// like the rest of the app, with a title, a destructive confirm that names the
// loss, and Cancel focused as the safe default. The native confirm is unused.

const test = require("node:test");
const assert = require("node:assert/strict");
const { openApp, settle, waitFor } = require("./test/ux-round2-app-fixture.js");

async function workspaceWithPendingTask(t) {
  const nativeAsks = [];
  const current = await openApp(t, { historyResolveStatus: 200, prepare: (window) => {
    window.confirm = (message) => { nativeAsks.push(String(message)); return true; };
  } });
  await waitFor(() => !current.state.bootstrapBlocked && !current.state.actionLocked, "the workspace to open");
  current.control.online = false;
  current.element("taskInput").value = "Alpha";
  current.element("taskForm").dispatchEvent(new current.window.Event("submit", { cancelable: true }));
  await waitFor(() => current.state.tasks.some((task) => task.title === "Alpha"), "the task to appear");
  await waitFor(() => current.state.actionLocked === false, "the add to settle");
  return { current, nativeAsks };
}

function signOutQuestion(current) {
  return current.document.getElementById("logoutConfirmation");
}

async function askToSignOut(current) {
  current.element("logoutButton").click();
  await waitFor(() => signOutQuestion(current)?.open === true, "the sign-out question");
  return signOutQuestion(current);
}

test("PWA-11 sign-out with pending changes asks in a titled in-page dialog with Cancel focused", async (t) => {
  const { current, nativeAsks } = await workspaceWithPendingTask(t);
  const dialog = await askToSignOut(current);
  await waitFor(() => current.document.activeElement === dialog.querySelector(".confirmation-cancel"), "Cancel focus");
  assert.deepEqual(nativeAsks, [], "the native confirm is not used");
  assert.ok(dialog.classList.contains("bootstrap-dialog"), "styled like the other in-page dialogs");
  assert.equal(dialog.querySelector("#logoutConfirmationTitle").textContent, "Discard unsynced changes?");
  assert.equal(dialog.getAttribute("aria-labelledby"), "logoutConfirmationTitle");
  assert.match(dialog.querySelector("#logoutConfirmationMessage").textContent, /waiting to sync\. Signing out will discard/);
  const confirm = dialog.querySelector(".confirmation-danger");
  assert.equal(confirm.textContent, "Sign out and discard");
  assert.equal(confirm.type, "submit");
  assert.equal(dialog.querySelector(".confirmation-cancel").textContent, "Cancel");
});

function unsyncedCount(current) {
  return current.state.pending.length + current.state.pendingTaskOperations.length;
}

// A confirmed sign-out disables the button and fences the workspace in the
// same turn that the question resolves, so a few turns show either answer.
async function assertAnsweredCancel(current, dialog, before, how) {
  await settle();
  assert.equal(dialog.open, false, `${how} closes the question`);
  assert.equal(current.element("logoutButton").disabled, false, `${how} leaves Sign out usable`);
  assert.equal(current.state.logoutRecoveryRequired, false, `${how} starts no sign-out`);
  assert.equal(unsyncedCount(current), before, `${how} keeps the unsynced changes`);
  assert.ok(current.state.user, `${how} keeps the account`);
  assert.equal(current.control.requests.some((request) => request.url === "/api/v1/auth/logout"), false);
}

test("PWA-11 Cancel, Escape and closing the question keep the account and its pending changes", async (t) => {
  const { current } = await workspaceWithPendingTask(t);
  current.control.online = true;
  const before = unsyncedCount(current);
  assert.ok(before > 0, "there is unsynced work to lose");
  let dialog = await askToSignOut(current);
  dialog.querySelector(".confirmation-cancel").click();
  await assertAnsweredCancel(current, dialog, before, "Cancel");
  // Escape reaches the page as a cancel event on the dialog.
  dialog = await askToSignOut(current);
  dialog.dispatchEvent(new current.window.Event("cancel"));
  await assertAnsweredCancel(current, dialog, before, "Escape");
  // A dialog that closes without a cancel event, as a browser's own dismissal
  // can do, reports only a close event. That answers Cancel too.
  dialog = await askToSignOut(current);
  dialog.dispatchEvent(new current.window.Event("close"));
  await assertAnsweredCancel(current, dialog, before, "a close event");
});

test("PWA-11 the destructive confirm signs out", async (t) => {
  const { current } = await workspaceWithPendingTask(t);
  current.control.online = true;
  const dialog = await askToSignOut(current);
  dialog.querySelector("form").requestSubmit();
  await waitFor(() => current.control.requests.some((request) => request.url === "/api/v1/auth/logout"),
    "the sign-out request after confirm");
  assert.equal(dialog.open, false);
});
