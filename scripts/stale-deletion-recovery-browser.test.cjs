"use strict";

const assert = require("node:assert/strict");
const { readFileSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { chromium } = require(process.env.POMODOROUGH_PLAYWRIGHT_MODULE || "playwright");
const fixture = JSON.parse(readFileSync(0, "utf8"));
const stores = ["meta", "pending", "pendingAutoStarts", "pendingDurations", "pendingSelectedTasks", "pendingTasks"];

function installCleanupPause() {
  let storage;
  Object.defineProperty(window, "PomodoroughAppStorage", { configurable: true,
    get: () => storage,
    set: (module) => {
      storage = { ...module, create(input) {
        const actions = module.create(input);
        const clear = actions.clearLocalData;
        return { ...actions, clearLocalData: async (...args) => {
          if (window.recoveryAssertIssuer && args[1].database !== recoveryIssuer.database) {
            throw new Error("Cleanup adopted a replacement issuing connection");
          }
          const completed = await clear(...args);
          if (window.recoveryHoldCompletion) {
            window.recoveryCompletionReached = true;
            await new Promise((resolve) => { window.releaseRecoveryCompletion = resolve; });
          }
          return completed;
        } };
      } };
    }
  });
}

async function profileContext(profile, manual = false) {
  const context = await chromium.launchPersistentContext(profile, {
    headless: true, ignoreHTTPSErrors: true, serviceWorkers: "allow", bypassCSP: false,
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ["--ignore-certificate-errors"]
  });
  await Promise.all(context.pages().map((page) => page.close()));
  await context.addCookies([
    { name: fixture.sessionCookie, value: fixture.sessionToken, httpOnly: true },
    { name: fixture.csrfCookie, value: fixture.csrfToken, httpOnly: false }
  ].map((cookie) => ({ ...cookie, url: `${fixture.url}/`, secure: true, sameSite: "Lax" })));
  await context.addInitScript(installCleanupPause);
  await context.addInitScript((manual) => {
    window.PomodoroughAppTest = { disableAutoStart: manual };
    const timeout = window.setTimeout.bind(window);
    window.recoveryTimers = [];
    window.setTimeout = (callback, delay, ...args) => {
      if (delay >= 1000) return 0;
      const handle = timeout(callback, delay, ...args);
      recoveryTimers.push(handle);
      return handle;
    };
    window.setInterval = () => 0;
    window.addEventListener("online", (event) => event.stopImmediatePropagation(), { capture: true });
    document.addEventListener("visibilitychange", (event) => event.stopImmediatePropagation(), { capture: true });
  }, manual);
  await context.route("**/api/v1/sync", (route) => route.abort("failed"));
  return context;
}

async function readStores(page) {
  return page.evaluate(async () => {
    const opening = indexedDB.open("pomodorough");
    const database = await new Promise((resolve, reject) => {
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
      opening.onupgradeneeded = () => { opening.transaction.abort(); reject(new Error("Missing persistent stores")); };
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

async function queueWork(context, page) {
  await context.setOffline(true);
  await page.waitForFunction(() => !navigator.onLine && !PomodoroughAppTest.state.syncing);
  await page.locator("#tasksTab").click();
  await page.locator("#taskInput").fill("R49-S02 retained offline task");
  await page.locator("#taskForm button[type=submit]").click();
  await page.waitForFunction(() => PomodoroughAppTest.state.pendingTaskOperations.length === 1
    && !PomodoroughAppTest.state.actionLocked);
  await page.locator("#timerTab").click();
  await page.locator("#focusDuration").fill("31");
  await page.locator("#focusDuration").dispatchEvent("change");
  await page.waitForFunction(() => PomodoroughAppTest.state.pendingDurationOperations.length > 0
    && !PomodoroughAppTest.state.actionLocked);
  await page.locator("#autoStartBreaks").setChecked(!await page.locator("#autoStartBreaks").isChecked());
  await page.waitForFunction(() => PomodoroughAppTest.state.pendingAutoStartOperations.length > 0
    && !PomodoroughAppTest.state.actionLocked);
  await page.locator("#timerToggle").click();
  await page.waitForFunction(() => PomodoroughAppTest.state.pending.length > 0 && !PomodoroughAppTest.state.actionLocked);
  await page.locator("#timerToggle").click();
  await page.waitForFunction(() => PomodoroughAppTest.state.pending.length > 1 && !PomodoroughAppTest.state.actionLocked);
  await page.evaluate(() => {
    recoveryTimers.forEach((handle) => clearTimeout(handle));
    window.setTimeout = () => 0;
  });
  await context.setOffline(false);
  await page.waitForFunction(() => navigator.onLine && !PomodoroughAppTest.state.syncing);
  const rows = await readStores(page);
  assert.deepEqual(Object.keys(rows), stores);
  for (const name of stores) assert.ok(rows[name].length > 0, `${name} contains retained work`);
  return rows;
}

async function beginRecovery(page, stage) {
  await page.evaluate((stage) => {
    const app = PomodoroughAppTest;
    const attempt = { userId: app.captureAccountContext().ownerId, csrfToken: app.state.csrfToken,
      ...(stage ? { stage } : {}) };
    localStorage.setItem("pomodoroughPendingDeletion", JSON.stringify(attempt));
    window.recoveryIssuer = app.captureAccountContext();
    window.recoveryAssertIssuer = true;
    window.recoveryReports = [];
    window.recoveryWarnings = [];
    PomodoroughSentryClient = { reportFrontendError: (error, operation) => recoveryReports.push({ name: error.name, operation }) };
    console.warn = (...args) => recoveryWarnings.push(args.map(String));
    window.recoveryResult = null;
    app.loadSession(recoveryIssuer).then((value) => { recoveryResult = { value }; },
      (error) => { recoveryResult = { error: error.name }; });
  }, stage);
}

async function replaceScope(page, change) {
  return page.evaluate(async (change) => {
    const app = PomodoroughAppTest;
    if (change === "connection") {
      // The original handle is retained only to prove the new handle differs.
      const old = recoveryIssuer.database;
      old.close();
      app.setDatabaseForTest(null);
      const opened = await app.openDatabase();
      if (opened === old) throw new Error("Reopen reused the issuing handle");
      app.setDatabaseForTest(opened);
      const transaction = opened.transaction("meta", "readwrite");
      transaction.objectStore("meta").put({ key: "R49-S02-replacement", value: "retain replacement connection" });
      await app.transactionDone(transaction);
    } else if (change === "incarnation") {
      const incarnation = app.state.user.accountIncarnation === "b".repeat(64) ? "c".repeat(64) : "b".repeat(64);
      app.state.user = { ...app.state.user, accountIncarnation: incarnation };
      app.state.localOwnerId = PomodoroughSync.accountOwnerId(app.state.user);
      const transaction = app.captureAccountContext().database.transaction("meta", "readwrite");
      const store = transaction.objectStore("meta");
      const read = store.get("snapshot");
      read.onsuccess = () => store.put({ ...read.result,
        value: { ...read.result.value, user: structuredClone(app.state.user) } });
      await app.transactionDone(transaction);
    } else {
      const attempt = JSON.parse(localStorage.getItem("pomodoroughPendingDeletion"));
      localStorage.setItem("pomodoroughPendingDeletion", JSON.stringify({ ...attempt,
        ...(change === "candidate" ? { stage: "candidate" } : { attemptId: crypto.randomUUID() }) }));
    }
    let invalid = false;
    try { recoveryIssuer.assertCurrent(); }
    catch (error) { if (error.name !== "AccountOwnershipError") throw error; invalid = true; }
    return { invalid, user: structuredClone(app.state.user), localOwnerId: app.state.localOwnerId,
      memory: app.ownerStateValue(), markers: ["pomodoroughPendingDeletion", "pomodoroughPendingLogout",
        "pomodoroughPendingLogoutOwner"].map((key) => localStorage.getItem(key)) };
  }, change);
}

async function staleReply(page, context, stage, change, status) {
  let arrived;
  let release;
  const reached = new Promise((resolve) => { arrived = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const path = stage ? "**/api/v1/account" : "**/api/v1/account/deletion-receipt";
  const route = async (request) => {
    assert.equal(request.request().method(), stage ? "DELETE" : "POST");
    assert.equal(request.request().headers()["x-csrf-token"], fixture.csrfToken);
    arrived();
    await held;
    await request.fulfill({ status, body: "" });
  };
  await context.route(path, route);
  await beginRecovery(page, stage);
  await reached;
  const expected = await replaceScope(page, change);
  assert.equal(expected.invalid, ["connection", "incarnation"].includes(change));
  const before = await readStores(page);
  release();
  await page.waitForFunction(() => window.recoveryResult !== null);
  assert.equal(page.url(), `${fixture.url}/app`);
  assert.deepEqual(await readStores(page), before, `${stage || "legacy"} ${change} ${status} exact stores`);
  const after = await page.evaluate(() => ({ memory: PomodoroughAppTest.ownerStateValue(),
    markers: ["pomodoroughPendingDeletion", "pomodoroughPendingLogout", "pomodoroughPendingLogoutOwner"]
      .map((key) => localStorage.getItem(key)), reports: recoveryReports, warnings: recoveryWarnings }));
  assert.deepEqual(after.memory, expected.memory);
  assert.deepEqual(after.markers, expected.markers);
  assert.deepEqual(after.reports, []);
  assert.deepEqual(after.warnings, []);
  await context.unroute(path, route);
  await page.evaluate((expected) => {
    PomodoroughAppTest.state.user = expected.user;
    PomodoroughAppTest.state.localOwnerId = expected.localOwnerId;
    localStorage.removeItem("pomodoroughPendingDeletion");
  }, page.originalAccount);
  if (change === "incarnation") await page.evaluate(async (account) => {
    const app = PomodoroughAppTest;
    const transaction = app.captureAccountContext().database.transaction("meta", "readwrite");
    const store = transaction.objectStore("meta");
    const read = store.get("snapshot");
    read.onsuccess = () => store.put({ ...read.result, value: { ...read.result.value, user: account.user } });
    await app.transactionDone(transaction);
  }, page.originalAccount);
}

async function staleCleanupReturn(context, page, retained) {
  await context.route("**/api/v1/account", (route) => route.fulfill({ status: 204, body: "" }));
  await page.evaluate(() => { window.recoveryHoldCompletion = true; });
  await beginRecovery(page, "issued");
  await page.waitForFunction(() => window.recoveryCompletionReached === true);
  const expected = await replaceScope(page, "connection");
  await page.evaluate(async (retained) => {
    const opened = PomodoroughAppTest.captureAccountContext().database;
    const transaction = opened.transaction(Object.keys(retained), "readwrite");
    for (const [name, rows] of Object.entries(retained)) {
      for (const row of rows) transaction.objectStore(name).put(row);
    }
    await PomodoroughAppTest.transactionDone(transaction);
  }, retained);
  const before = await readStores(page);
  for (const name of stores) assert.ok(before[name].length > 0, `${name} contains replacement work`);
  await page.evaluate(() => releaseRecoveryCompletion());
  await page.waitForFunction(() => window.recoveryResult !== null);
  assert.equal(page.url(), `${fixture.url}/app`);
  assert.deepEqual(await readStores(page), before, "old cleanup close receipt cannot adopt reopened database");
  assert.deepEqual(await page.evaluate(() => ["pomodoroughPendingDeletion", "pomodoroughPendingLogout",
    "pomodoroughPendingLogoutOwner"].map((key) => localStorage.getItem(key))), expected.markers);
  assert.deepEqual(await page.evaluate(() => recoveryReports), []);
  assert.deepEqual(await page.evaluate(() => recoveryWarnings), []);
  await context.unroute("**/api/v1/account");
}

async function staleTransaction(page, context) {
  await context.route("**/api/v1/account", (route) => route.fulfill({ status: 204, body: "" }));
  const before = await readStores(page);
  await page.evaluate(() => {
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      const opened = transaction.apply(this, args);
      if (args[1] === "readwrite") queueMicrotask(() => {
        const attempt = JSON.parse(localStorage.getItem("pomodoroughPendingDeletion"));
        localStorage.setItem("pomodoroughPendingDeletion", JSON.stringify({ ...attempt, attemptId: "new-transaction-attempt" }));
      });
      return opened;
    };
    window.restoreRecoveryTransaction = () => { IDBDatabase.prototype.transaction = transaction; };
  });
  await beginRecovery(page, "issued");
  await page.waitForFunction(() => window.recoveryResult !== null);
  await page.evaluate(() => restoreRecoveryTransaction());
  assert.equal(page.url(), `${fixture.url}/app`);
  assert.deepEqual(await readStores(page), before, "attempt replacement aborts real six-store cleanup transaction");
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("pomodoroughPendingDeletion")).attemptId),
    "new-transaction-attempt");
  assert.deepEqual(await page.evaluate(() => recoveryReports), []);
  assert.deepEqual(await page.evaluate(() => recoveryWarnings), []);
  await context.unroute("**/api/v1/account");
  await page.evaluate(() => {
    PomodoroughAppTest.clearPendingLogout();
    localStorage.removeItem("pomodoroughPendingDeletion");
  });
}

async function lostResponse(context, page) {
  const before = await readStores(page);
  let committed = 0;
  await context.route("**/api/v1/account", async (route) => {
    const marker = await page.evaluate(() => JSON.parse(localStorage.getItem("pomodoroughPendingDeletion")));
    assert.equal(marker.stage, "issued");
    assert.equal(marker.csrfToken, route.request().headers()["x-csrf-token"]);
    assert.equal((await route.fetch()).status(), 204);
    committed += 1;
    await route.abort("failed");
  });
  assert.equal(await page.evaluate(() => PomodoroughAppTest.deleteAccount("DELETE")), false);
  assert.equal(committed, 1);
  assert.deepEqual(await readStores(page), before, "current lost response retains every store");
  assert.equal(await page.evaluate(() => localStorage.getItem("pomodoroughPendingLogout")), null);
  const marker = await page.evaluate(() => localStorage.getItem("pomodoroughPendingDeletion"));
  assert.equal(JSON.parse(marker).stage, "issued");
  return marker;
}

test("R49-S02 persistent connection and attempt fences preserve current lost-response recovery",
  { timeout: 120_000 }, async (t) => {
    const profile = mkdtempSync(join(tmpdir(), "pomodorough-stale-deletion-"));
    let context;
    t.after(async () => { await context?.close(); rmSync(profile, { recursive: true, force: true }); });
    context = await profileContext(profile);
    const page = await context.newPage();
    assert.equal((await page.goto(`${fixture.url}/app`)).status(), 200);
    await page.waitForFunction(() => window.PomodoroughAppTest?.state?.ready
      && !PomodoroughAppTest.state.bootstrapBlocked && !PomodoroughAppTest.state.syncing
      && !!navigator.serviceWorker.controller);
    page.originalAccount = await page.evaluate(() => ({ user: PomodoroughAppTest.state.user,
      localOwnerId: PomodoroughAppTest.state.localOwnerId }));
    const initial = await queueWork(context, page);
    const snapshot = initial.meta.find((row) => row.key === "snapshot");
    for (const stage of ["issued", null]) {
      for (const change of ["connection", "attempt", "candidate", "incarnation"]) {
        for (const status of [204, 400, 401, 403]) await staleReply(page, context, stage, change, status);
      }
    }
    await staleTransaction(page, context);
    assert.equal(await page.evaluate(async () => (await fetch("/api/v1/me")).status), 200);
    const marker = await lostResponse(context, page);
    await context.close();
    context = await profileContext(profile);
    const restarted = await context.newPage();
    let replayed = 0;
    await context.route("**/api/v1/account", async (route) => {
      assert.equal(route.request().headers()["x-csrf-token"], JSON.parse(marker).csrfToken);
      assert.equal((await route.fetch()).status(), 204);
      replayed += 1;
      await route.fulfill({ status: 204, body: "" });
    });
    await restarted.goto(`${fixture.url}/app`);
    await restarted.waitForURL(/\/auth\/google\/start\?return=%2Fapp/);
    assert.equal(replayed, 1);
    const rows = await readStores(restarted);
    assert.deepEqual(Object.keys(rows), stores);
    for (const name of stores) assert.deepEqual(rows[name], [], name);
    assert.deepEqual(await restarted.evaluate(() => ["pomodoroughPendingDeletion", "pomodoroughPendingLogout",
      "pomodoroughPendingLogoutOwner"].map((key) => localStorage.getItem(key))), [null, null, null]);
    console.log("32 stale issued/legacy replies retain exact six stores; process restart recovers current committed lost response");
    // A completed local close is legitimate only while its returned context is
    // current. Run this after real erasure so the synthetic reply cannot erase a live account.
    await context.close();
    context = await profileContext(profile, true);
    const final = await context.newPage();
    await final.goto(`${fixture.url}/app`);
    await final.waitForFunction(() => !!window.PomodoroughAppTest);
    await final.evaluate((account) => {
      Object.assign(PomodoroughAppTest.state, { user: account.user, localOwnerId: account.localOwnerId,
        csrfToken: account.csrfToken });
    }, { ...page.originalAccount, csrfToken: fixture.csrfToken });
    // Open and install real IndexedDB without normal session loading on the deleted account.
    await final.evaluate(async (snapshot) => {
      const app = PomodoroughAppTest;
      PomodoroughStorage.setSharedCore(await app.loadSharedCore());
      const opened = await app.openDatabase();
      app.setDatabaseForTest(opened);
      const transaction = opened.transaction("meta", "readwrite");
      transaction.objectStore("meta").put(snapshot);
      await app.transactionDone(transaction);
    }, snapshot);
    await staleCleanupReturn(context, final, initial);
    console.log("Delayed real cleanup close receipt preserves reopened same-account database and both markers without diagnostics");
  });
