"use strict";

// Real Go HTTPS server, headless Chromium, and real IndexedDB failures.
// Scenarios: refresh and guarded fail each pending-queue read boundary of
// sign-out; bootstrap signs out from the limit-recovery dialog; crosstab makes
// the attempt stale while its read is open.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.POMODOROUGH_PLAYWRIGHT_MODULE || "playwright");
const fixture = JSON.parse(readFileSync(0, "utf8"));
const catalog = JSON.parse(readFileSync(path.join(__dirname, "../web/locales", `${fixture.locale}.json`), "utf8"));
const refusalNotice = catalog["account.logout.pendingUnavailable"];
const refusalOperation = "session.logout.pending-queues";
const loginPath = /auth\/google\/start/;
const keptTask = "R54-S02 kept task";
const scenarioId = `${fixture.scenario}@${fixture.locale}`;
const refusalTimeout = { timeout: 20_000 };

// Runs in the page before app scripts. Sign-out reads of the pending store are
// classified by call stack: mode "refresh" fails the refreshAllPendingOperations
// read and mode "guarded" fails only the later guardedMutation read. A failing
// read issues its real getAll and then aborts the readonly transaction, so
// IndexedDB itself fails it. With hold set, the transaction stays open until
// released.
function installQueueReadFailure() {
  Error.stackTraceLimit = 200;
  const probe = { mode: null, hold: false, released: false, forcedFailures: 0,
    refreshReads: 0, guardedReads: 0, refusals: 0 };
  window.PomodoroughR54S02 = probe;
  const signOutFrame = /[ .]logout \(|readPendingQueuesBeforeLogout/;
  const abortWhenReleased = (store) => {
    if (!probe.hold || probe.released) return store.transaction.abort();
    store.count().onsuccess = () => abortWhenReleased(store);
  };
  const getAll = IDBObjectStore.prototype.getAll;
  IDBObjectStore.prototype.getAll = function (...args) {
    const request = getAll.apply(this, args);
    if (this.name !== "pending") return request;
    const stack = new Error().stack || "";
    const signOut = signOutFrame.test(stack);
    const refresh = signOut && stack.includes("refreshAllPendingOperations");
    const guarded = signOut && !refresh && stack.includes("guardedMutation");
    probe.refreshReads += Number(refresh);
    probe.guardedReads += Number(guarded);
    if ((probe.mode === "refresh" && refresh) || (probe.mode === "guarded" && guarded)) {
      probe.forcedFailures += 1;
      abortWhenReleased(this);
    }
    return request;
  };
}

// Runs in the page before app scripts. Refusal warnings, error reports, and
// writes to the main notice or the dialog refusal become console events, so a
// write made just before a navigation is still recorded.
function installSignOutObservers() {
  const probe = window.PomodoroughR54S02;
  const emit = (event) => console.debug(`R54S02 ${JSON.stringify(event)}`);
  const warn = console.warn;
  console.warn = function (...args) {
    if (args[0] === "Pomodorough pending queues unavailable before logout:") {
      probe.refusals += 1;
      emit({ kind: "refusal" });
    }
    return warn.apply(this, args);
  };
  let client;
  Object.defineProperty(window, "PomodoroughSentryClient", {
    configurable: true,
    get: () => client,
    set: (value) => {
      client = value && { ...value, reportFrontendError: (error, operation) => {
        emit({ kind: "report", operation });
        return value.reportFrontendError(error, operation);
      } };
    }
  });
  document.addEventListener("DOMContentLoaded", () => {
    for (const id of ["noticeText", "bootstrapSignOutError"]) {
      const target = document.getElementById(id);
      if (!target) continue;
      new MutationObserver(() => emit({ kind: "write", id, text: target.textContent }))
        .observe(target, { childList: true, characterData: true, subtree: true });
    }
  });
}

function log(label, value) {
  console.log(`R54-S02 ${scenarioId} ${label} ${JSON.stringify(value)}`);
}

async function markers(page) {
  return page.evaluate(() => ({ marker: localStorage.getItem("pomodoroughPendingLogout"),
    owner: localStorage.getItem("pomodoroughPendingLogoutOwner") }));
}

// Cursor reads are not intercepted, so the dump sees the stored workspace even
// while queue reads fail. Background sync may move server clock fields and
// acknowledgements, or write a claim with nothing sent; none of that is
// retained user data, so the comparison leaves it out.
async function workspaceDump(page) {
  return page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("pomodorough");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const volatile = new Set(["serverTime", "serverHlcWallMs", "serverHlcCounter", "wallMs", "counter"]);
    const stable = (key, value) => volatile.has(key) || /Acknowledgements$/.test(key) ? undefined : value;
    const transient = ({ key, value }) => ["clockOffset", "clockRequestSequence"].includes(key)
      || key === "outgoingSync" && Object.values(value?.sent || {}).every((items) => Array.isArray(items) && items.length === 0);
    try {
      const names = [...database.objectStoreNames].sort();
      const transaction = database.transaction(names, "readonly");
      return JSON.stringify(await Promise.all(names.map((name) => new Promise((resolve, reject) => {
        const records = [];
        const request = transaction.objectStore(name).openCursor();
        request.onsuccess = () => {
          if (!request.result) return resolve([name, records]);
          if (!transient(request.result)) records.push([request.result.key, request.result.value]);
          request.result.continue();
        };
        request.onerror = () => reject(request.error);
      }))), stable);
    } finally { database.close(); }
  });
}

async function openSession(browser) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: "allow" });
  await context.addCookies([
    { name: fixture.sessionCookie, value: fixture.sessionToken, httpOnly: true },
    { name: fixture.csrfCookie, value: fixture.csrfToken, httpOnly: false }
  ].map((cookie) => ({ ...cookie, url: fixture.url, secure: true, sameSite: "Lax" })));
  await context.addInitScript(() => { window.PomodoroughAppTest = { disableAutoStart: false }; });
  await context.addInitScript(installQueueReadFailure);
  await context.addInitScript(installSignOutObservers);
  const page = await context.newPage();
  const session = { context, page, logoutRequests: [], dialogs: [], events: [] };
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/auth/logout") session.logoutRequests.push(request);
  });
  page.on("dialog", (dialog) => { session.dialogs.push(dialog.message()); dialog.accept(); });
  page.on("console", (message) => {
    if (message.text().startsWith("R54S02 ")) session.events.push(JSON.parse(message.text().slice(7)));
  });
  await page.route("**/auth/google/start?*", (route) => route.fulfill({
    contentType: "text/html", body: "OAuth intercepted for local regression" }));
  await page.goto(`${fixture.url}/app?locale=${encodeURIComponent(fixture.locale)}`);
  await page.waitForFunction(() => PomodoroughAppTest.state.ready && !PomodoroughAppTest.state.bootstrapBlocked);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  session.cdp = await context.newCDPSession(page);
  await session.cdp.send("Accessibility.enable");
  return session;
}

async function keptWorkspace(page) {
  await page.locator("#tasksTab").click();
  await page.locator("#taskInput").fill(keptTask);
  await page.locator("#taskInput").press("Enter");
  await page.waitForFunction((title) => PomodoroughAppTest.state.tasks.some((task) => task.title === title)
    && PomodoroughAppTest.state.pendingTaskOperations.length === 0 && !PomodoroughAppTest.state.syncing, keptTask);
  const before = await workspaceDump(page);
  assert.ok(before.includes(keptTask));
  return before;
}

// What a pointer and assistive technology get from a message: the element hit
// at its centre, and its node and text in Chromium's accessibility tree.
async function observeMessage({ page, cdp }, container, text) {
  const geometry = await page.evaluate((selector) => {
    const element = document.querySelector(selector);
    element.scrollIntoView({ block: "nearest" });
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { dir: document.documentElement.dir, lang: document.documentElement.lang,
      direction: getComputedStyle(element).direction, topmost: !!hit && element.contains(hit),
      hit: hit ? `${hit.tagName}#${hit.id}` : null, modal: document.querySelector("dialog[open]:modal")?.id || null };
  }, container);
  const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
  const nodeId = async (selector) => (await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector })).nodeId;
  const { nodes: [node = {}] } = await cdp.send("Accessibility.getPartialAXTree",
    { nodeId: await nodeId(container), fetchRelatives: false });
  const { nodes: texts } = await cdp.send("Accessibility.queryAXTree", { nodeId: await nodeId(text), role: "StaticText" });
  return { ...geometry, axIgnored: node.ignored === true, axRole: node.role?.value,
    axReasons: (node.ignoredReasons || []).map((reason) => reason.name),
    axText: texts.filter((item) => !item.ignored).map((item) => item.name?.value || "").join("") };
}

function assertReachable(observation) {
  const detail = JSON.stringify(observation);
  assert.equal(observation.dir, catalog.$meta.dir, detail);
  assert.equal(observation.direction, catalog.$meta.dir, detail);
  assert.equal(observation.lang, fixture.locale, detail);
  assert.equal(observation.topmost, true, detail);
  assert.equal(observation.axIgnored, false, detail);
  assert.equal(observation.axRole, "alert", detail);
  assert.equal(observation.axText, refusalNotice, detail);
}

// A refusal keeps the local workspace, the server session, and the logout
// markers, sends no logout request, and reports the read failure once.
async function assertRefused(session, before, attempts) {
  const { context, page, logoutRequests, dialogs } = session;
  await page.waitForFunction((count) => PomodoroughR54S02.refusals >= count, attempts, refusalTimeout);
  const probe = await page.evaluate(() => ({ ...PomodoroughR54S02 }));
  assert.equal(probe.refusals, attempts, JSON.stringify(probe));
  assert.ok(probe.forcedFailures >= attempts, JSON.stringify(probe));
  assert.equal(await page.locator("#notice").isVisible(), true);
  assert.equal(await page.locator("#noticeText").textContent(), refusalNotice);
  assert.equal(new URL(page.url()).pathname, "/app");
  assert.equal(logoutRequests.length, 0);
  assert.deepEqual(dialogs, []);
  assert.deepEqual(await markers(page), { marker: null, owner: null });
  assert.equal(await page.evaluate(() => PomodoroughAppTest.state.logoutRecoveryRequired), false);
  assert.equal(await workspaceDump(page), before);
  assert.equal((await context.request.get(`${fixture.url}/api/v1/me`)).status(), 200);
  const reports = session.events.filter((event) => event.kind === "report" && event.operation === refusalOperation);
  assert.equal(reports.length, attempts, JSON.stringify(session.events));
  return probe;
}

function refusalEvents(session, start) {
  return session.events.slice(start).filter((event) => event.kind === "refusal"
    || (event.kind === "report" && event.operation === refusalOperation)
    || (event.kind === "write" && event.text === refusalNotice));
}

async function signOutSucceeds(session, button) {
  const { context, page, logoutRequests } = session;
  await page.evaluate(() => { PomodoroughR54S02.mode = null; });
  const start = session.events.length;
  await page.locator(button).click();
  await page.waitForURL(loginPath);
  assert.equal(logoutRequests.length, 1);
  assert.ok(logoutRequests[0].headers()["x-csrf-token"]);
  assert.deepEqual(await markers(page), { marker: null, owner: null });
  assert.equal((await context.request.get(`${fixture.url}/api/v1/me`)).status(), 401);
  assert.deepEqual(refusalEvents(session, start), [], "successful sign-out wrote a refusal");
}

async function failingReadScenario(session, mode) {
  const { page } = session;
  const before = await keptWorkspace(page);
  await page.evaluate((value) => { PomodoroughR54S02.mode = value; }, mode);
  await page.locator("#logoutButton").click();
  const first = await assertRefused(session, before, 1);
  log("reads", { refresh: first.refreshReads, guarded: first.guardedReads, forced: first.forcedFailures });
  if (mode === "guarded") assert.ok(first.refreshReads >= 1 && first.guardedReads >= 1, JSON.stringify(first));
  else assert.equal(first.guardedReads, 0, JSON.stringify(first));
  const notice = await observeMessage(session, "#notice", "#noticeText");
  log("notice", notice);
  assertReachable(notice);
  await page.locator("#logoutButton").dblclick();
  await assertRefused(session, before, 3);
  await page.locator("#noticeDismiss").click();
  assert.equal(await page.locator("#notice").isVisible(), false);
  await page.locator("#logoutButton").click();
  await assertRefused(session, before, 4);
  assert.equal(await page.locator("#logoutButton").isEnabled(), true);
  await signOutSucceeds(session, "#logoutButton");
}

// The limit error is raised by the client batch plan before any request is
// sent, so no server response produces it. The leg sets the state that
// handleResolutionLimit leaves, with the production error message.
async function enterLimitRecovery(page) {
  const limitText = await page.evaluate(() => {
    const error = new PomodoroughStorage.ResolutionLimitError({ field: "oversized", count: 8193, limit: 8192 });
    Object.assign(PomodoroughAppTest.state, { bootstrapBlocked: true, bootstrapSubmitting: false,
      bootstrapError: null, bootstrapLimitError: error.message, bootstrapSignOutError: null,
      bootstrapStrategy: null, bootstrapPending: null });
    PomodoroughApp.render();
    return error.message;
  });
  await page.locator("#bootstrapSignOut").waitFor({ state: "visible" });
  assert.equal(await page.evaluate(() => document.querySelector("dialog[open]:modal")?.id), "bootstrapDialog");
  return limitText;
}

// showModal() makes the page behind the dialog inert, so the refusal must be
// readable inside the dialog, beside the Sign out control that caused it.
async function assertDialogRefusal(session, limitText) {
  const { page } = session;
  log("mainNotice", await observeMessage(session, "#notice", "#noticeText"));
  assert.equal(await page.evaluate(() => document.querySelector("dialog[open]:modal")?.id), "bootstrapDialog");
  assert.equal(await page.locator("#bootstrapError").textContent(), limitText);
  assert.equal(await page.locator("#bootstrapSignOut").isEnabled(), true);
  assert.equal(await page.locator("#bootstrapSignOutError").isVisible(), true, "dialog shows no sign-out refusal");
  assert.equal(await page.locator("#bootstrapSignOutError").textContent(), refusalNotice);
  const message = await observeMessage(session, "#bootstrapSignOutError", "#bootstrapSignOutError");
  log("dialogRefusal", message);
  assertReachable(message);
}

async function bootstrapScenario(session) {
  const { page } = session;
  const before = await keptWorkspace(page);
  const limitText = await enterLimitRecovery(page);
  await page.evaluate(() => { PomodoroughR54S02.mode = "refresh"; });
  await page.locator("#bootstrapSignOut").click();
  await assertRefused(session, before, 1);
  await assertDialogRefusal(session, limitText);
  await page.locator("#bootstrapSignOut").click();
  await assertRefused(session, before, 2);
  await assertDialogRefusal(session, limitText);
  await signOutSucceeds(session, "#bootstrapSignOut");
}

// A second tab starts sign-out while this tab's queue read is held open. The
// stale attempt must stay silent: no refusal, report, or notice.
async function crossTabScenario(session) {
  const { page, logoutRequests } = session;
  await keptWorkspace(page);
  await page.evaluate(() => { PomodoroughR54S02.mode = "refresh"; PomodoroughR54S02.hold = true; });
  await page.locator("#logoutButton").click();
  await page.waitForFunction(() => PomodoroughR54S02.forcedFailures >= 1);
  const start = session.events.length;
  const other = await session.context.newPage();
  // A script-free same-origin stylesheet shares localStorage without booting a
  // second app; the manifest's content type makes Chromium download it.
  await other.goto(`${fixture.url}/landing.css`);
  await other.evaluate(() => localStorage.setItem("pomodoroughPendingLogout", "1"));
  await page.waitForFunction(() => localStorage.getItem("pomodoroughPendingLogout") === "1");
  await page.evaluate(() => { PomodoroughR54S02.released = true; });
  await page.waitForURL(loginPath, { timeout: 30_000 });
  await page.waitForTimeout(500);
  assert.deepEqual(refusalEvents(session, start), [], "stale sign-out attempt wrote a refusal");
  assert.equal(logoutRequests.length, 0);
}

const scenarios = {
  refresh: (session) => failingReadScenario(session, "refresh"),
  guarded: (session) => failingReadScenario(session, "guarded"),
  bootstrap: bootstrapScenario,
  crosstab: crossTabScenario
};

(async () => {
  assert.ok(Object.hasOwn(scenarios, fixture.scenario), `unknown scenario ${fixture.scenario}`);
  const browser = await chromium.launch({ headless: true, args: ["--ignore-certificate-errors"],
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    const session = await openSession(browser);
    await scenarios[fixture.scenario](session);
    await session.context.close();
    console.log(`R54-S02-OK ${scenarioId}`);
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
