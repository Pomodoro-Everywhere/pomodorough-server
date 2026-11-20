"use strict";

// PWA-12: a sign-out the server confirmed ends on the server's signed-out page,
// which says "You are signed out" and links home, instead of the Google account
// chooser. A sign-out whose revocation is still pending keeps the sign-in
// redirect, because its landing token proves the revocation ran (R54-S03).

const test = require("node:test");
const assert = require("node:assert/strict");
const { openApp, waitFor } = require("./test/ux-round2-app-fixture.js");

async function signOut(t, logoutStatus, prepare = () => {}) {
  const current = await openApp(t, { historyResolveStatus: 200, prepare });
  await waitFor(() => !current.state.bootstrapBlocked && !current.state.actionLocked, "the workspace to open");
  current.control.logoutStatus = logoutStatus;
  current.element("logoutButton").click();
  await waitFor(() => current.control.navigations.length > 0, "the page to leave the app");
  return current;
}

test("PWA-12 a confirmed sign-out opens the signed-out page, not the account chooser", async (t) => {
  const current = await signOut(t, 200);
  assert.deepEqual(current.control.navigations, ["/app"]);
  assert.equal(current.window.localStorage.getItem("pomodoroughPendingLogout"), null, "nothing is left to revoke");
});

test("PWA-12 a sign-out that still waits for revocation keeps the sign-in redirect", async (t) => {
  const current = await signOut(t, 503);
  assert.equal(current.control.navigations.length, 1);
  const address = new URL(current.control.navigations[0], "https://local.test");
  assert.equal(address.pathname, "/auth/google/start");
  assert.match(address.searchParams.get("return"), /^\/app\?signin=/);
  assert.equal(current.window.localStorage.getItem("pomodoroughPendingLogout"), "1");
});

// Without a stored marker nothing would recover the sign-out after a reload,
// and the server would open the app again for the session it still accepts.
test("PWA-12 an unconfirmed sign-out whose marker cannot be stored never reloads the app", async (t) => {
  const current = await signOut(t, 503, (window) => {
    const setItem = window.Storage.prototype.setItem;
    window.Storage.prototype.setItem = function (key, value) {
      if (String(key).startsWith("pomodoroughPendingLogout")) throw new window.DOMException("denied", "SecurityError");
      return setItem.call(this, key, value);
    };
  });
  assert.equal(current.window.localStorage.getItem("pomodoroughPendingLogout"), null);
  assert.deepEqual(current.control.navigations, ["/auth/google/start?return=%2Fapp"]);
});
