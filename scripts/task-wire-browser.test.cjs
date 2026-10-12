"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const { chromium } = require(process.env.POMODOROUGH_PLAYWRIGHT_MODULE || "playwright");
const fixture = JSON.parse(readFileSync(0, "utf8"));

async function authenticatedContext(browser) {
  const context = await browser.newContext({ serviceWorkers: "allow", bypassCSP: false, ignoreHTTPSErrors: true });
  await context.addCookies([
    { name: fixture.sessionCookie, value: fixture.sessionToken, httpOnly: true },
    { name: fixture.csrfCookie, value: fixture.csrfToken, httpOnly: false }
  ].map(cookie => ({ ...cookie, url: fixture.url + "/", secure: true, sameSite: "Lax" })));
  await context.addInitScript(() => { window.PomodoroughAppTest = { disableAutoStart: false }; });
  return context;
}

async function waitForReady(page) {
  try {
    await page.waitForFunction(() => window.PomodoroughAppTest?.state?.ready
      && !window.PomodoroughAppTest.state.bootstrapBlocked, null, { timeout: 15_000 });
  } catch (error) {
    const failure = await page.evaluate(() => ({ ready: window.PomodoroughAppTest?.state?.ready,
      notice: document.querySelector("#noticeText")?.textContent }));
    throw new Error(`Cold startup did not reach ready: ${JSON.stringify(failure)}`, { cause: error });
  }
}

async function readDurableState(page) {
  return page.evaluate(async () => {
    const request = indexedDB.open("pomodorough");
    const database = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => { request.transaction.abort(); reject(new Error("Durable database missing")); };
    });
    try {
      const names = [...database.objectStoreNames];
      const transaction = database.transaction(names, "readonly");
      const done = new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error);
      });
      const records = await Promise.all(names.map(name => new Promise((resolve, reject) => {
        const read = transaction.objectStore(name).getAll();
        read.onsuccess = () => resolve([name, read.result]);
        read.onerror = () => reject(read.error);
      })));
      await done;
      return Object.fromEntries(records);
    } finally {
      database.close();
    }
  });
}

test("R48-S02 mixed task and Start batch syncs with strict wire bytes, exact retry, and reload",
  { timeout: 90_000 }, async t => {
    const browser = await chromium.launch({ headless: true, args: ["--ignore-certificate-errors"],
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
    t.after(() => browser.close());
    console.log(`Browser ${browser.version()}`);
    const context = await authenticatedContext(browser);
    t.after(() => context.close());
    const page = await context.newPage();
    const response = await page.goto(fixture.url + "/app");
    assert.equal(response.status(), 200);
    await waitForReady(page);

    await context.setOffline(true);
    await page.waitForFunction(() => !navigator.onLine && !PomodoroughAppTest.state?.syncing);
    await page.locator("#tasksTab").click();
    await page.locator("#taskInput").fill("Review offline task");
    await page.locator("#taskForm button[type=submit]").click();
    await page.waitForFunction(
      () => (PomodoroughAppTest.state?.pendingTaskOperations || []).length === 1
        && !PomodoroughAppTest.state?.actionLocked);
    await page.locator("#timerTab").click();    await page.locator("#timerToggle").click();
    await page.waitForFunction(() => PomodoroughAppTest.state?.timer?.status === "running"
      && !PomodoroughAppTest.state?.actionLocked);
    const stored = await readDurableState(page);
    assert.equal(stored.pendingTasks.length, 1);
    assert.equal(typeof stored.pendingTasks[0].deviceId, "string", "Core durable row carries deviceId");
    assert.equal(stored.pending.length, 1);
    console.log("Offline task and Start committed to actual IndexedDB with Core deviceId rows");
    await context.setOffline(false);
    await page.waitForFunction(() => navigator.onLine);

    const wire = await page.evaluate(() => {
      const state = PomodoroughAppTest.state;
      const { sent } = PomodoroughStorage.selectWorkspaceBatch({
        commands: state.pending, taskOperations: state.pendingTaskOperations,
        durationOperations: state.pendingDurationOperations,
        autoStartOperations: state.pendingAutoStartOperations,
        selectedTaskOperations: state.pendingSelectedTaskOperations,
        timerDependencies: state.timerDependencies
      }, state.deviceId);
      const body = JSON.stringify({ deviceId: state.deviceId, lastRevision: state.revision,
        commands: sent.commands, taskOperations: sent.taskOperations,
        durationOperations: sent.durationOperations, autoStartOperations: sent.autoStartOperations,
        selectedTaskOperations: sent.selectedTaskOperations });
      return { sent, body };
    });
    assert.equal(wire.sent.taskOperations.length, 1);
    assert.equal(Object.hasOwn(wire.sent.taskOperations[0], "deviceId"), false);
    assert.deepEqual(Object.keys(wire.sent.taskOperations[0]).sort(),
      ["hlcCounter", "hlcWallMs", "id", "occurredAt", "taskId", "title", "type"]);
    const parsed = JSON.parse(wire.body);
    assert.equal(Object.hasOwn(parsed.taskOperations[0], "deviceId"), false);
    console.log("Wire claim carries strict task bytes without per-operation deviceId");

    const posted = await page.evaluate(async (body) => {
      const post = async () => {
        const reply = await fetch("/api/v1/sync", { method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json",
            "X-CSRF-Token": PomodoroughAppTest.state.csrfToken }, body });
        return { status: reply.status, json: await reply.json().catch(() => null) };
      };
      const first = await post();
      const retry = await post();
      return { first, retry, identical: true };
    }, wire.body);
    for (const [name, reply] of [["first", posted.first], ["retry", posted.retry]]) {
      assert.equal(reply.status, 200, `${name} sync`);
      assert.equal(reply.json.taskAcknowledgements.length, 1);
      assert.equal(reply.json.taskAcknowledgements[0].outcome, "applied");
      assert.equal(reply.json.acknowledgements.length, 1);
      assert.equal(reply.json.acknowledgements[0].outcome, "applied");
    }
    assert.equal(posted.retry.json.taskAcknowledgements[0].operationId,
      posted.first.json.taskAcknowledgements[0].operationId, "exact retry keeps ack identity");
    console.log("Real HTTP accepts strict bytes twice with identical applied acks (lost-response retry)");

    await page.evaluate(() => PomodoroughApp.syncNow());
    await page.waitForFunction(() => !PomodoroughAppTest.state?.syncing
      && (PomodoroughAppTest.state?.pending || []).length === 0
      && (PomodoroughAppTest.state.pendingTaskOperations || []).length === 0, null, { timeout: 15_000 });
    const settled = await readDurableState(page);
    assert.deepEqual(settled.pendingTasks, []);
    assert.deepEqual(settled.pending, []);
    console.log("App sync applies the mixed acknowledgement and clears every queue");

    await page.reload();
    await waitForReady(page);
    const restored = await page.evaluate(() => ({
      status: PomodoroughAppTest.state?.timer?.status,
      tasks: (PomodoroughAppTest.state?.tasks || []).map((task) => task.title),
      pendingTasks: (PomodoroughAppTest.state?.pendingTaskOperations || []).length
    }));
    assert.equal(restored.status, "running");
    assert.ok(restored.tasks.includes("Review offline task"), JSON.stringify(restored.tasks));
    assert.equal(restored.pendingTasks, 0);
    console.log("Reload restores the running timer and synced task with zero retained queue entries");
  });
