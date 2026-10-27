"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { chromium } = require("playwright");
const { accountUser } = require("./test/incarnation-fixture.js");

async function browserPage(t) {
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error(error.message));
  await page.route("http://localhost/**", async (route) => {
    const name = new URL(route.request().url()).pathname.slice(1) || "app.html";
    if (name === "sentry-client.js") return route.fulfill({ body: "" });
    if (name === "auth/google/start") return route.fulfill({ contentType: "text/html", body: "Signed out" });
    if (name.startsWith("api/")) return route.abort("internetdisconnected");
    if (name === "app-session.js" && process.env.R53_S01_BASELINE === "1") {
      return route.fulfill({ contentType: "text/javascript",
        body: execFileSync("git", ["show", "HEAD:web/app-session.js"], { cwd: path.join(__dirname, "..") }) });
    }
    const file = path.join(__dirname, name);
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: "Not found" });
    const contentType = name.endsWith(".js") ? "text/javascript"
      : name.endsWith(".html") ? "text/html" : name.endsWith(".css") ? "text/css" : "application/octet-stream";
    return route.fulfill({ path: file, contentType });
  });
  await page.addInitScript(() => {
    window.PomodoroughAppTest = { disableAutoStart: true };
    window.logoutReports = [];
    window.PomodoroughSentryClient = { reportFrontendError: (error, operation) =>
      window.logoutReports.push({ name: error.name, message: error.message, stack: error.stack, operation }) };
  });
  await page.goto("http://localhost/app.html");
  await page.waitForFunction(() => !!window.PomodoroughAppTest?.state);
  await page.evaluate(seedBrowserAccount, accountUser("private-account"));
  page.on("dialog", (dialog) => dialog.accept());
  return page;
}

async function seedBrowserAccount(user) {
  const app = window.PomodoroughAppTest;
  window.PomodoroughStorage.setSharedCore(await app.loadSharedCore());
  const database = await app.openDatabase();
  app.setDatabaseForTest(database);
  const owner = window.PomodoroughSync.accountOwnerId(user);
  Object.assign(app.state, { user, localOwnerId: owner, authenticated: true,
    sessionIdentityValidated: true, csrfToken: "private-csrf", deviceId: "private-device",
    ready: true, bootstrapBlocked: false });
  const transaction = database.transaction("meta", "readwrite");
  transaction.objectStore("meta").put({ key: "snapshot", value: {
    user, revision: 3, canonicalTimer: null, history: [], tasks: [],
    durationsMs: app.state.durationsMs, autoStartBreaks: false, selectedTaskId: null
  } });
  transaction.objectStore("meta").put({ key: "deviceId", value: "private-device" });
  await app.transactionDone(transaction);
  app.setupEvents();
  app.render();
  window.logoutDatabase = database;
  window.logoutFaults = { denyMarker: true, abortCleanup: true, aborts: 0, markerAttempts: 0, clearing: false };
  const setItem = Storage.prototype.setItem.bind(Storage.prototype);
  Storage.prototype.setItem = function (key, value) {
    if (key.startsWith("pomodoroughPendingLogout") && window.logoutFaults.denyMarker) {
      window.logoutFaults.markerAttempts += 1;
      throw new DOMException("private-marker private-csrf private-account", "SecurityError");
    }
    return setItem(key, value);
  };
  // PomodoroughStorage is frozen, so fault real IndexedDB clearing instead: a
  // synchronous throw inside the cleanup transaction aborts it and rolls back.
  const clear = IDBObjectStore.prototype.clear;
  IDBObjectStore.prototype.clear = function (...args) {
    if (window.logoutFaults.abortCleanup && window.logoutFaults.clearing) {
      window.logoutFaults.aborts += 1;
      throw new DOMException("IDB cleanup aborted", "AbortError");
    }
    return clear.apply(this, args);
  };
}

async function records(page) {
  return page.evaluate(async () => {
    const resultOf = (request) => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const request = indexedDB.open("pomodorough");
    const database = await resultOf(request);
    const names = Array.from(database.objectStoreNames);
    const transaction = database.transaction(names, "readonly");
    const result = Object.fromEntries(await Promise.all(names.map(async (name) =>
      [name, await resultOf(transaction.objectStore(name).getAll())])));
    database.close();
    return result;
  });
}

async function assertFenced(page, before) {
  assert.equal(new URL(page.url()).pathname, "/app.html");
  assert.equal(await page.locator("#bootstrapDialog").evaluate((element) => element.open), true);
  assert.equal(await page.locator("#logoutRecoveryRetry").isVisible(), true);
  assert.equal(await page.locator("#logoutRecoveryRetry").isEnabled(), true);
  assert.match(await page.locator("#noticeText").innerText(), /could not be cleared/);
  assert.equal(await page.locator("#timerToggle").isDisabled(), true);
  assert.equal(await page.locator("#taskInput").isDisabled(), true);
  assert.deepEqual(await records(page), before);
  assert.deepEqual(await page.evaluate(() => ({
    marker: localStorage.getItem("pomodoroughPendingLogout"),
    owner: localStorage.getItem("pomodoroughPendingLogoutOwner"),
    required: PomodoroughAppTest.state.logoutRecoveryRequired,
    busy: PomodoroughAppTest.state.logoutRecoveryBusy
  })), { marker: null, owner: null, required: true, busy: false });
}

test("R53-S01 browser storage denial plus offline revoke and IDB abort exposes a fenced working retry", async (t) => {
  const page = await browserPage(t);
  const before = await records(page);
  await page.evaluate(() => { logoutFaults.clearing = true; });
  await page.evaluate(() => PomodoroughAppTest.logout());
  await assertFenced(page, before);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await assertFenced(page, before);
  await page.locator("#logoutRecoveryRetry").click();
  await page.waitForFunction(() => logoutFaults.aborts === 2 && !PomodoroughAppTest.state.logoutRecoveryBusy);
  await assertFenced(page, before);
  const diagnostics = await page.evaluate(() => logoutReports.filter((entry) =>
    entry.operation === "session.logout.marker-write-failed"));
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].name, "SecurityError");
  assert.equal(diagnostics[0].message, "Sign-out recovery marker storage failed.");
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-marker|private-csrf|private-account/);
  await page.evaluate(() => { logoutFaults.abortCleanup = false; });
  await page.locator("#logoutRecoveryRetry").click();
  await page.waitForURL(/auth\/google\/start/);
  assert.ok(Object.values(await records(page)).every((values) => values.length === 0));
});

test("R53-S01 browser marker denial does not prevent best-effort committed cleanup", async (t) => {
  const page = await browserPage(t);
  await page.evaluate(() => { logoutFaults.abortCleanup = false; });
  await page.evaluate(() => PomodoroughAppTest.logout()).catch((error) => {
    if (!/Execution context was destroyed/.test(error.message)) throw error;
  });
  await page.waitForURL(/auth\/google\/start/);
  assert.ok(Object.values(await records(page)).every((values) => values.length === 0));
});
