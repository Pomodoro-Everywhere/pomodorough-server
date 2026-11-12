"use strict";

// Regression for a reload while a sync POST is in flight. The reloaded page
// must leave the "Checking history" startup gate without user action. HEAD
// 0e675e0 stalls in round 0 on hostingby, but the stall depends on whether a
// sync POST is in flight at the reload, so the scene repeats with two
// timings. Even rounds send the first sync POST of the round to the server and
// hold its response until the reload has finished, so the server applies the
// batch and the old page never sees the acknowledgement. Odd rounds reload as
// soon as the delete leaves the task list, which is the timing the original
// probe used.

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const { chromium } = require(process.env.POMODOROUGH_PLAYWRIGHT_MODULE || "playwright");
const fixture = JSON.parse(readFileSync(0, "utf8"));
const ROUNDS = Number(process.env.POMODOROUGH_BOOTSTRAP_RELOAD_ROUNDS || 10);
const STARTUP_TIMEOUT_MS = 12_000;
const TRACE_PREFIX = "Pomodorough ";

async function authenticatedContext(browser) {
  const context = await browser.newContext({ serviceWorkers: "allow", bypassCSP: false, ignoreHTTPSErrors: true });
  await context.addCookies([
    { name: fixture.sessionCookie, value: fixture.sessionToken, httpOnly: true },
    { name: fixture.csrfCookie, value: fixture.csrfToken, httpOnly: false }
  ].map(cookie => ({ ...cookie, url: fixture.url + "/", secure: true, sameSite: "Lax" })));
  await context.addInitScript(() => {
    window.PomodoroughAppTest = { disableAutoStart: false };
    // Read only by the diagnostic trace patch; HEAD ignores it.
    globalThis.PomodoroughBootstrapTrace = true;
  });
  return context;
}

async function startupFinished(page) {
  try {
    await page.waitForFunction(() => window.PomodoroughAppTest?.state?.ready
      && !window.PomodoroughAppTest.state.bootstrapBlocked, null, { timeout: STARTUP_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

// Keeps the app's own console lines and API traffic so a stalled round
// reports where startup stopped.
function recordStartup(page) {
  const lines = [];
  page.on("console", (message) => {
    const reported = message.text().startsWith(TRACE_PREFIX) || ["error", "warning"].includes(message.type());
    if (reported) lines.push(`${message.type()} ${message.text().slice(0, 240)}`);
  });
  const pageErrors = new Set();
  page.on("pageerror", (error) => {
    const text = String(error.stack || error).split("\n").slice(0, 12).join(" | ").slice(0, 1600);
    if (pageErrors.has(text)) return;
    pageErrors.add(text);
    lines.push(`pageerror ${text}`);
  });
  page.on("request", (request) => {
    if (/\/api\//.test(request.url())) lines.push(`request ${request.method()} ${new URL(request.url()).pathname}`);
  });
  page.on("response", (response) => {
    if (/\/api\/v1\/sync/.test(response.url())) lines.push(`response ${response.status()} ${response.request().method()} sync`);
  });
  return lines;
}

async function stalledStartupState(page) {
  return page.evaluate(() => {
    const state = window.PomodoroughAppTest?.state || {};
    return {
      ready: state.ready, bootstrapBlocked: state.bootstrapBlocked, bootstrapGateOwned: state.bootstrapGateOwned,
      sessionIdentityValidated: state.sessionIdentityValidated, retrying: state.retrying,
      quarantined: state.quarantinedLocal != null, bootstrapPlan: state.bootstrapPlan?.mode ?? null,
      actionLocked: state.actionLocked, syncing: state.syncing, workspaceBlocked: state.workspaceBlocked,
      projectionPending: state.projectionPending != null,
      queues: [state.pending, state.pendingTaskOperations, state.pendingSelectedTaskOperations].map((queue) => queue?.length),
      tasks: state.tasks?.length, baseTasks: state.baseTasks?.length,
      notice: document.getElementById("noticeText")?.textContent || "",
      status: document.getElementById("syncStatus")?.textContent.replace(/\s+/g, " ").trim()
    };
  });
}

// Waits until the add is acknowledged, so the next sync POST of the round
// carries the delete or a later pull rather than the add.
async function addTask(page, title) {
  await page.locator("#taskInput").fill(title);
  await page.locator("#taskForm button[type=submit]").click();
  const handle = await page.waitForFunction((name) => {
    const state = window.PomodoroughAppTest.state;
    const queues = [state.pending, state.pendingTaskOperations, state.pendingDurationOperations,
      state.pendingAutoStartOperations, state.pendingSelectedTaskOperations];
    const settled = !state.actionLocked && !state.syncing && queues.every((queue) => queue.length === 0);
    return settled && state.tasks.find((task) => task.title === name)?.id;
  }, title, { timeout: 10_000 });
  return handle.jsonValue();
}

// Delete opens the undo window. Hiding the page flushes the delete at once,
// as the visibilitychange handler in app-view.js does. Applying a sync
// response holds the action lock, and a task operation issued meanwhile
// returns false without a notice (issueWorkspaceIntent in app-actions.js), so
// the flush waits in the page until the lock is free. That lock check runs
// synchronously inside the dispatch, so no response can take the lock between
// the wait and the flush.
async function deleteThroughUndo(page, taskId) {
  await page.locator(`#taskList .task-row[data-task-id="${taskId}"] .task-delete`).click();
  await page.waitForFunction(() => !document.getElementById("undoToast").hidden);
  await page.evaluate(async (timeoutMs) => {
    const state = window.PomodoroughAppTest.state;
    const deadline = Date.now() + timeoutMs;
    while (state.actionLocked) {
      if (Date.now() > deadline) throw new Error("action lock stayed held before the delete flush");
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, 4_000);
  await page.waitForFunction((id) => !window.PomodoroughAppTest.state.tasks.some((task) => task.id === id),
    taskId, { timeout: 10_000 });
}

// Sends the first sync POST after installation to the server and holds the
// response until release. Later sync requests pass through unchanged.
async function holdFirstSyncResponse(page) {
  let release;
  let markPosted;
  const released = new Promise((resolve) => { release = resolve; });
  const posted = new Promise((resolve) => { markPosted = resolve; });
  let holding = false;
  await page.route("**/api/v1/sync", async (route) => {
    if (holding || route.request().method() !== "POST") return route.continue();
    holding = true;
    const response = await route.fetch();
    markPosted();
    await released;
    // The page that sent this request is gone after the reload.
    await route.fulfill({ response }).catch(() => {});
  });
  return { posted, release };
}

async function reloadDuringSync(browser, round) {
  const context = await authenticatedContext(browser);
  try {
    const page = await context.newPage();
    const lines = recordStartup(page);
    assert.equal((await page.goto(fixture.url + "/app")).status(), 200);
    assert.equal(await startupFinished(page), true, `round ${round}: cold startup`);
    await page.locator("#tasksTab").click();
    const taskId = await addTask(page, `Reload stall ${round}`);
    const hold = round % 2 === 0 ? await holdFirstSyncResponse(page) : null;
    await deleteThroughUndo(page, taskId).catch(async (error) => {
      assert.fail(`round ${round}: delete did not leave the task list: ${error.message.split("\n")[0]} `
        + `${JSON.stringify(await stalledStartupState(page))}\n${lines.join("\n")}`);
    });
    if (hold) await Promise.race([hold.posted, page.waitForTimeout(15_000).then(() => {
      throw new Error(`round ${round}: no sync POST reached the server after the delete`);
    })]);
    lines.length = 0;
    await page.reload();
    hold?.release();
    if (await startupFinished(page)) return;
    const state = await stalledStartupState(page);
    assert.fail(`round ${round} (${hold ? "held response" : "probe timing"}) stayed in startup: `
      + `${JSON.stringify(state)}\n${lines.join("\n")}`);
  } finally {
    await context.close();
  }
}

test("a reload during an in-flight sync POST leaves Checking history on its own",
  { timeout: ROUNDS * 60_000 }, async (t) => {
    const browser = await chromium.launch({ headless: true, args: ["--ignore-certificate-errors"],
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
    t.after(() => browser.close());
    console.log(`Browser ${browser.version()}, ${ROUNDS} rounds`);
    for (let round = 0; round < ROUNDS; round += 1) {
      await reloadDuringSync(browser, round);
      console.log(`round ${round} left startup`);
    }
  });
