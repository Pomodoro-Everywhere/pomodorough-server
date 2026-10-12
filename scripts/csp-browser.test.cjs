"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require(process.env.POMODOROUGH_PLAYWRIGHT_MODULE || "playwright");
const metadata = require("../web/shared-core-metadata.js");
const fixture = JSON.parse(readFileSync(0, "utf8"));
const queueStores = ["pending", "pendingTasks", "pendingDurations", "pendingAutoStarts", "pendingSelectedTasks"];

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
    await page.waitForFunction(() => window.PomodoroughAppTest?.state.ready
      && !window.PomodoroughAppTest.state.bootstrapBlocked, null, { timeout: 15_000 });
  } catch (error) {
    const failure = await page.evaluate(() => ({ ready: window.PomodoroughAppTest?.state.ready,
      notice: document.querySelector("#noticeText")?.textContent,
      startDisabled: document.querySelector("#timerToggle")?.disabled }));
    throw new Error(`Cold startup did not reach ready: ${JSON.stringify(failure)}`, { cause: error });
  }
}

async function assertShippedWasm(response, fromServiceWorker) {
  assert.equal(response.status(), 200);
  assert.equal(response.fromServiceWorker(), fromServiceWorker);
  const bytes = await response.body();
  assert.deepEqual(bytes, readFileSync(path.join(__dirname, "../web/pomodorough_core.wasm")));
  assert.deepEqual(bytes, readFileSync(path.join(__dirname, "../internal/sharedcore/pomodorough_core.wasm")));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), metadata.sha256);
  console.log(`Official WASM sha256=${metadata.sha256}, serviceWorker=${fromServiceWorker}`);
}

async function coldStartup(page) {
  // Fresh browser profile per run guarantees cold IndexedDB/caches/workers;
  // fromServiceWorker() === false below proves the cold network load.
  const wasm = page.waitForResponse(response => new URL(response.url()).pathname === "/pomodorough_core.wasm");
  const response = await page.goto(fixture.url + "/app");
  assert.equal(response.status(), 200);
  assert.equal(response.fromServiceWorker(), false);
  await assertShippedWasm(await wasm, false);
  await waitForReady(page);
  const session = await page.evaluate(() => ({ authenticated: PomodoroughAppTest.state.authenticated,
    userID: PomodoroughAppTest.state.user?.id, timer: PomodoroughAppTest.state.timer.status }));
  assert.deepEqual(session, { authenticated: true, userID: fixture.userID, timer: "idle" });
  assert.equal(await page.locator("#timerToggle").isEnabled(), true);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const csp = response.headers()["content-security-policy"];
  console.log(`Cold authenticated ready, CSP=${csp}`);
  return csp;
}

async function assertJavaScriptEvalBlocked(context, page) {
  const session = await context.newCDPSession(page);
  // CDP defaults to bypassing eval restrictions. Explicitly enforce the document CSP.
  const { result, exceptionDetails } = await session.send("Runtime.evaluate", {
    allowUnsafeEvalBlockedByCSP: false, returnByValue: true,
    expression: `JSON.stringify(["eval", "Function"].map(kind => {
      try {
        if (kind === "eval") (0, eval)("globalThis.cspEvalExecuted = true");
        else new Function("globalThis.cspEvalExecuted = true")();
        return { kind, blocked: false };
      } catch (error) {
        return { kind, blocked: true, name: error.name, message: error.message,
          executed: globalThis.cspEvalExecuted === true };
      }
    }))`
  });
  assert.equal(exceptionDetails, undefined);
  const probes = JSON.parse(result.value);
  for (const probe of probes) {
    assert.equal(probe.blocked, true, `${probe.kind} must be blocked`);
    assert.equal(probe.name, "EvalError");
    assert.match(probe.message, /Content Security Policy|unsafe-eval/i);
    assert.equal(probe.executed, false);
  }
  await session.detach();
  console.log("Ordinary eval and Function rejected by enforced document CSP");
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

async function durableStart(context, page) {
  await context.setOffline(true);
  await page.waitForFunction(() => !navigator.onLine && !PomodoroughAppTest.state.syncing);
  await page.locator("#timerToggle").click();
  await page.waitForFunction(() => PomodoroughAppTest.state.timer.status === "running"
    && !PomodoroughAppTest.state.actionLocked);
  const stored = await readDurableState(page);
  assert.equal(stored.pending.length, 1);
  const start = stored.pending[0];
  assert.equal(start.type, "start");
  assert.equal(start.phase, "focus");
  assert.match(start.id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const state = await page.evaluate(() => ({ pending: PomodoroughAppTest.state.pending,
    timerID: PomodoroughAppTest.state.timer.id, userID: PomodoroughAppTest.state.user?.id }));
  assert.deepEqual(state.pending, stored.pending);
  assert.equal(state.timerID, start.timerId);
  assert.equal(state.userID, fixture.userID);
  assert.equal(stored.meta.find(row => row.key === "snapshot").value.user.id, fixture.userID);
  for (const name of queueStores.slice(1)) assert.deepEqual(stored[name], []);
  console.log("Offline Start committed to actual IndexedDB with one complete pending command");
  return stored;
}

async function offlineReload(page, before, csp) {
  const wasm = page.waitForResponse(response => new URL(response.url()).pathname === "/pomodorough_core.wasm");
  const response = await page.reload();
  assert.equal(response.status(), 200);
  assert.equal(response.fromServiceWorker(), true);
  assert.equal(response.headers()["content-security-policy"], csp);
  await waitForReady(page);
  await assertShippedWasm(await wasm, true);
  const after = await readDurableState(page);
  for (const name of queueStores) assert.equal(JSON.stringify(after[name]), JSON.stringify(before[name]), name);
  for (const key of ["snapshot", "deviceId", "deviceSequence", "hlc", "uuidV7", "deliveryProof", "timerDependencies"]) {
    assert.deepEqual(after.meta.find(row => row.key === key), before.meta.find(row => row.key === key), key);
  }
  const restored = await page.evaluate(() => ({ online: navigator.onLine, ready: PomodoroughAppTest.state.ready,
    offlineOwner: PomodoroughAppTest.state.offlineOwnerMode, userID: PomodoroughAppTest.state.user?.id,
    status: PomodoroughAppTest.state.timer.status, timerID: PomodoroughAppTest.state.timer.id,
    pending: PomodoroughAppTest.state.pending }));
  assert.deepEqual(restored, { online: false, ready: true, offlineOwner: true, userID: fixture.userID,
    status: "running", timerID: before.pending[0].timerId, pending: before.pending });
  console.log("Offline reload restores running timer and byte-identical durable queues under cached Go CSP");
}

test("R48-S01 actual Go CSP permits official WASM cold startup and durable offline Start, but rejects JS eval",
  { timeout: 60_000 }, async t => {
    // The disposable Go listener uses a self-signed TLS certificate for __Host cookies.
    const browser = await chromium.launch({ headless: true, args: ["--ignore-certificate-errors"],
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
    t.after(() => browser.close());
    console.log(`Browser ${browser.version()}`);
    const context = await authenticatedContext(browser);
    t.after(() => context.close());
    const page = await context.newPage();
    const csp = await coldStartup(page);
    await assertJavaScriptEvalBlocked(context, page);
    const stored = await durableStart(context, page);
    await offlineReload(page, stored, csp);
    await assertJavaScriptEvalBlocked(context, page);
  });
