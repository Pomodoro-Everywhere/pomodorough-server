"use strict";

const assert = require("node:assert/strict");
const { readFileSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { chromium } = require(process.env.POMODOROUGH_PLAYWRIGHT_MODULE || "playwright");
const fixture = JSON.parse(readFileSync(0, "utf8"));

async function openProfile(profile) {
  const context = await chromium.launchPersistentContext(profile, {
    headless: true, ignoreHTTPSErrors: true, serviceWorkers: "allow", bypassCSP: false,
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ["--ignore-certificate-errors"]
  });
  await Promise.all(context.pages().map((page) => page.close()));
  await context.addInitScript(() => {
    window.PomodoroughAppTest = { disableAutoStart: false };
    // Suppress periodic sync and freeze timers after creating the retained queue.
    const setTimeout = window.setTimeout.bind(window);
    window.markerRealTimeout = setTimeout;
    window.markerTimers = [];
    window.setTimeout = (callback, delay, ...args) => {
      if (delay >= 1000) return 0;
      const timer = setTimeout(callback, delay, ...args);
      markerTimers.push(timer);
      return timer;
    };
    window.setInterval = () => 0;
    window.addEventListener("online", (event) => event.stopImmediatePropagation(), { capture: true });
    document.addEventListener("visibilitychange", (event) => event.stopImmediatePropagation(), { capture: true });
  });
  await context.route("**/api/v1/sync", (route) => route.abort("failed"));
  return context;
}

async function authenticate(context) {
  await context.addCookies([
    { name: fixture.sessionCookie, value: fixture.sessionToken, httpOnly: true },
    { name: fixture.csrfCookie, value: fixture.csrfToken, httpOnly: false }
  ].map((cookie) => ({ ...cookie, url: `${fixture.url}/`, secure: true, sameSite: "Lax" })));
}

async function ready(page) {
  try {
    await page.waitForFunction(() => window.PomodoroughAppTest?.state?.ready
      && !PomodoroughAppTest.state.bootstrapBlocked && !PomodoroughAppTest.state.syncing);
  } catch (error) {
    const state = await page.evaluate(() => ({ ready: window.PomodoroughAppTest?.state?.ready,
      blocked: window.PomodoroughAppTest?.state?.bootstrapBlocked,
      notice: document.querySelector("#noticeText")?.textContent,
      title: document.title }));
    throw new Error(`Startup failed: ${JSON.stringify(state)}`, { cause: error });
  }
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
}

async function durable(page) {
  return page.evaluate(async () => {
    const request = indexedDB.open("pomodorough");
    const database = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => { request.transaction.abort(); reject(new Error("Missing durable state")); };
    });
    try {
      const names = [...database.objectStoreNames];
      const transaction = database.transaction(names, "readonly");
      const done = new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error);
      });
      const rows = await Promise.all(names.map((name) => new Promise((resolve, reject) => {
        const read = transaction.objectStore(name).getAll();
        read.onsuccess = () => resolve([name, read.result]);
        read.onerror = () => reject(read.error);
      })));
      await done;
      return Object.fromEntries(rows);
    } finally { database.close(); }
  });
}

async function queueOfflineTask(context, page) {
  await context.setOffline(true);
  await page.waitForFunction(() => !navigator.onLine && !PomodoroughAppTest.state.syncing);
  await page.locator("#tasksTab").click();
  await page.locator("#taskInput").fill("R49 private retained task");
  await page.locator("#taskForm button[type=submit]").click();
  await page.waitForFunction(() => PomodoroughAppTest.state.pendingTaskOperations.length === 1
    && !PomodoroughAppTest.state.actionLocked);
  const rows = await durable(page);
  assert.equal(rows.pendingTasks.length, 1);
  assert.equal(rows.pendingSelectedTasks.length, 1);
  await page.evaluate(() => {
    markerTimers.forEach((timer) => clearTimeout(timer));
    window.setTimeout = () => 0;
  });
  await context.setOffline(false);
  await page.waitForFunction(() => navigator.onLine && !PomodoroughAppTest.state.syncing);
  return rows;
}

async function failMarker(page) {
  return page.evaluate(async (name) => {
    const original = Storage.prototype.setItem;
    const read = Storage.prototype.getItem;
    const remove = Storage.prototype.removeItem;
    Storage.prototype.getItem = function (key) {
      if (key === "pomodoroughPendingDeletion" && ["denied-readback", "legacy-readback"].includes(name)) {
        throw new DOMException("private readback content", "SecurityError");
      }
      if (key === "pomodoroughPendingDeletion" && name === "changed-readback") return "{}";
      return read.call(this, key);
    };
    Storage.prototype.removeItem = function (key) {
      if (key === "pomodoroughPendingDeletion") throw new DOMException("removal denied", "SecurityError");
      return remove.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === "pomodoroughPendingDeletion" && name.endsWith("Error")) {
        throw new DOMException("R49 private CSRF and task content", name);
      }
      if (key === "pomodoroughPendingDeletion" && name === "promotion-quota" && JSON.parse(value).stage === "issued") {
        throw new DOMException("promotion denied", "QuotaExceededError");
      }
      if (key === "pomodoroughPendingDeletion" && name === "legacy-readback") {
        const legacy = JSON.parse(value);
        delete legacy.stage;
        return original.call(this, key, JSON.stringify(legacy));
      }
      return original.call(this, key, value);
    };
    window.markerReports = [];
    PomodoroughSentryClient = { reportFrontendError: (error, operation) => {
      markerReports.push({ name: error.name, message: error.message, operation });
    } };
    const results = [];
    for (let index = 0; index < 20; index += 1) results.push(await PomodoroughAppTest.deleteAccount("DELETE"));
    Storage.prototype.setItem = original;
    Storage.prototype.getItem = read;
    Storage.prototype.removeItem = remove;
    return { results, reports: markerReports,
      notice: document.querySelector("#noticeText").textContent,
      disabled: document.querySelector("#deleteAccountButton").disabled,
      marker: localStorage.getItem("pomodoroughPendingDeletion"),
      logout: localStorage.getItem("pomodoroughPendingLogout") };
  }, fixture.errorName);
}

async function crashDuringMarker(page) {
  const browser = await page.context().browser().newBrowserCDPSession();
  const { processInfo } = await browser.send("SystemInfo.getProcessInfo");
  const browserPid = processInfo.find((entry) => entry.type === "browser").id;
  const prefix = "marker crash boundary:";
  const point = page.waitForEvent("console", { predicate: (message) => message.text().startsWith(prefix) });
  await page.evaluate((mode) => {
    const write = Storage.prototype.setItem;
    const read = Storage.prototype.getItem;
    const suspend = () => {
      console.debug(`marker crash boundary:${read.call(localStorage, "pomodoroughPendingDeletion")}`);
      for (;;) {}
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === "pomodoroughPendingDeletion" && mode === "crash-after-readback" && JSON.parse(value).stage === "issued") suspend();
      const result = write.call(this, key, value);
      if (key === "pomodoroughPendingDeletion" && mode === "crash-after-candidate") suspend();
      if (key === "pomodoroughPendingDeletion" && mode === "crash-after-issued" && JSON.parse(value).stage === "issued") suspend();
      return result;
    };
    Storage.prototype.getItem = function (key) {
      if (key === "pomodoroughPendingDeletion" && mode === "crash-before-readback") suspend();
      return read.call(this, key);
    };
    window.markerRealTimeout(() => PomodoroughAppTest.deleteAccount("DELETE"), 0);
  }, fixture.errorName);
  const marker = (await point).text().slice(prefix.length);
  assert.equal(JSON.parse(marker).stage, fixture.errorName === "crash-after-issued" ? "issued" : "candidate");
  // Let Chromium flush its localStorage backend while the renderer remains
  // stopped at the boundary. No application catch or promotion can run.
  await new Promise((resolve) => setTimeout(resolve, 6000));
  process.kill(browserPid, "SIGKILL");
  await page.context().close().catch(() => {});
  return marker;
}

async function assertRestart(context, before, requests, marker) {
  const page = await context.newPage();
  assert.equal((await page.goto(`${fixture.url}/app`)).status(), 200);
  await page.waitForFunction(() => window.PomodoroughAppTest?.state?.ready
    && PomodoroughAppTest.state.sessionIdentityValidated && !PomodoroughAppTest.state.syncing);
  assert.equal(await page.evaluate(() => PomodoroughAppTest.state.user.id), fixture.userID);
  assert.equal(await page.evaluate(() => localStorage.getItem("pomodoroughPendingDeletion")), marker);
  assert.equal(await page.evaluate(() => localStorage.getItem("pomodoroughPendingLogout")), null);
  const after = await durable(page);
  for (const [name, rows] of Object.entries(before)) {
    if (name !== "meta") assert.deepEqual(after[name], rows, `${name} survives browser restart`);
  }
  for (const key of ["snapshot", "timerDependencies"]) {
    assert.deepEqual(after.meta.find((row) => row.key === key), before.meta.find((row) => row.key === key), key);
  }
  assert.equal(requests.length, 0);
  assert.equal(await page.evaluate(() => (PomodoroughAppTest.state.quarantinedLocal
    || PomodoroughAppTest.state).pendingTaskOperations.length), 1);
  assert.equal(await page.evaluate(() => PomodoroughAppTest.loadSession()), true);
  assert.equal(await page.evaluate(async () => (await fetch("/api/v1/me")).status), 200);
  assert.equal(requests.length, 0);
  return page;
}

async function assertIssuedRecovery(context, requests) {
  const recovered = await context.newPage();
  const confirmed = recovered.waitForResponse((response) => response.url().endsWith("/api/v1/account")
    && response.request().method() === "DELETE" && response.status() === 204);
  await recovered.goto(`${fixture.url}/app`);
  await confirmed;
  await recovered.waitForURL(/\/auth\/google\/start\?return=%2Fapp/);
  assert.equal(requests.length, fixture.errorName === "crash-after-issued" ? 1 : 2);
  for (const [name, rows] of Object.entries(await durable(recovered))) assert.deepEqual(rows, [], name);
  assert.equal(await recovered.evaluate(() => localStorage.getItem("pomodoroughPendingDeletion")), null);
  assert.equal(await recovered.evaluate(() => localStorage.getItem("pomodoroughPendingLogout")), null);
}

test(`R49-S01 ${fixture.errorName} preserves deletion stage across browser restart`,
  { timeout: 90_000 }, async (t) => {
    const profile = mkdtempSync(join(tmpdir(), "pomodorough-deletion-marker-"));
    let context;
    t.after(async () => { await context?.close(); rmSync(profile, { recursive: true, force: true }); });
    const requests = [];
    const observe = (current) => current.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/v1/account" && request.method() === "DELETE") requests.push(request);
    });
    context = await openProfile(profile);
    await authenticate(context);
    observe(context);
    const page = await context.newPage();
    assert.equal((await page.goto(`${fixture.url}/app`)).status(), 200);
    await ready(page);
    const before = await queueOfflineTask(context, page);
    const frozen = await durable(page);
    const crashed = fixture.errorName.startsWith("crash-");
    const failed = crashed ? { marker: await crashDuringMarker(page) } : await failMarker(page);
    if (!crashed) assert.deepEqual(failed.results, Array(20).fill(false));
    assert.equal(requests.length, 0);
    if (!crashed) assert.equal(failed.disabled, false);
    if (fixture.errorName.endsWith("Error")) assert.equal(failed.marker, null);
    else assert.equal(JSON.parse(failed.marker).stage, fixture.errorName === "legacy-readback" ? undefined
      : fixture.errorName === "crash-after-issued" ? "issued" : "candidate");
    if (!crashed) assert.equal(failed.logout, null);
    if (!crashed) assert.match(failed.notice, /recovery information/);
    const errorName = ["denied-readback", "legacy-readback"].includes(fixture.errorName) ? "SecurityError"
      : fixture.errorName === "promotion-quota" ? "QuotaExceededError"
        : fixture.errorName === "changed-readback" ? "StorageError" : fixture.errorName;
    if (!crashed) assert.deepEqual(failed.reports, [{ name: errorName,
      message: "Account deletion recovery marker storage failed.", operation: "session.delete-account.marker-write-failed" }]);
    if (!crashed) assert.deepEqual(await durable(page), frozen, "failed prerequisite changes no IndexedDB row");
    if (!crashed) assert.equal(await page.evaluate(async () => (await fetch("/api/v1/me")).status), 200);
    if (!crashed) await page.close();
    await context.close();
    context = await openProfile(profile);
    await authenticate(context);
    observe(context);
    if (fixture.errorName === "crash-after-issued") {
      await assertIssuedRecovery(context, requests);
      return;
    }
    const restarted = await assertRestart(context, before, requests, failed.marker);
    await context.route("**/api/v1/account", async (route) => {
      const marker = await restarted.evaluate(() => JSON.parse(localStorage.getItem("pomodoroughPendingDeletion")));
      assert.equal(marker.userId, await restarted.evaluate(() => PomodoroughAppTest.captureAccountContext().ownerId));
      assert.equal(marker.csrfToken, route.request().headers()["x-csrf-token"]);
      assert.equal(marker.stage, "issued");
      assert.equal((await route.fetch()).status(), 204);
      await route.abort("failed");
    });
    assert.equal(await restarted.evaluate(() => PomodoroughAppTest.deleteAccount("DELETE")), false);
    assert.equal(requests.length, 1, "restored storage permits transport");
    assert.ok(await restarted.evaluate(() => localStorage.getItem("pomodoroughPendingDeletion")));
    assert.deepEqual((await durable(restarted)).pendingTasks, before.pendingTasks);
    await restarted.close();
    await context.close();
    context = await openProfile(profile);
    await authenticate(context);
    observe(context);
    await assertIssuedRecovery(context, requests);
  });
