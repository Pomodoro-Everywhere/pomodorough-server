"use strict";

// UX round 2 in a real browser (Chromium).
// A1: the undo toast for a deleted task has no time limit, offers Undo and a
//     named Dismiss, and does not cover the task field or the focused control.
// B1: a reload or a navigation inside the undo window does not lose the
//     delete: the next startup completes it. Undo before the unload keeps the task.
// A2: a rejected duration, a failed save and a deferred session each show one
//     localized sentence, never the internal error text.
// A3: the countdown and the Start/Pause/Resume control are both inside the
//     viewport at every scroll position, at 100% and 200% text.
// B6: every visible text keeps 4.5:1 and every focus ring 3:1 against the
//     rendered background, on both screens, light and dark.
// B2: on short landscape viewports with safe-area insets the Timer dock never
//     lies over the screen tabs, the masthead or the footer, and the notice
//     stack never lies over the Tasks heading, at every scroll position. A
//     dock taller than a third of the viewport sits inline at the end of the
//     Timer content and keeps that place at rest.
// Pointer input uses measured coordinates and never automatic element
// scrolling, which would hide the reachability problems this test looks for.
// The B2 setup clicks are the exception: they only reach the state to measure.
// Contexts ask for reduced motion: the page then scrolls at once instead of
// smoothly, so geometry is read from a page at rest.
const assert = require("node:assert/strict");
const { mkdirSync, readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require(process.env.POMODOROUGH_PLAYWRIGHT_MODULE || "playwright");
const { contrastFindings } = require("./ux-round2-contrast.cjs");
const fixture = JSON.parse(readFileSync(0, "utf8"));

const SHOTS = process.env.POMODOROUGH_UX_ROUND2_SHOTS || "";
const TOUCH_TARGET = 44;
const OLD_UNDO_MS = 5000;
const SCROLL_SHARES = [0, 0.5, 1];
const PHONE = { width: 375, height: 667 };
const DESKTOP = { width: 1280, height: 800 };
const SCENES = [
  { name: "phone-light", viewport: PHONE, colorScheme: "light" },
  { name: "phone-dark", viewport: PHONE, colorScheme: "dark" },
  { name: "desktop-light", viewport: DESKTOP, colorScheme: "light" },
  { name: "desktop-dark", viewport: DESKTOP, colorScheme: "dark" },
];
const TIMER_SCENARIOS = [[320, 568], [375, 667], [390, 844], [844, 390], [1280, 800]].flatMap(
  ([width, height]) => [100, 200].map((font) => (
    { name: `${width}x${height} text ${font}%`, viewport: { width, height }, font })));
const SAFE_AREA = { top: 47, left: 44, right: 44, bottom: 34 };
const NO_SAFE_AREA = { top: 0, left: 0, right: 0, bottom: 0 };
const COVERAGE_SCENES = [
  { name: "landscape-667x375-inset-light", viewport: { width: 667, height: 375 }, insets: SAFE_AREA, colorScheme: "light" },
  { name: "landscape-667x375-dark", viewport: { width: 667, height: 375 }, insets: NO_SAFE_AREA, colorScheme: "dark" },
  { name: "landscape-568x320-inset-light", viewport: { width: 568, height: 320 }, insets: SAFE_AREA, colorScheme: "light" },
  { name: "landscape-844x390-inset-dark", viewport: { width: 844, height: 390 }, insets: SAFE_AREA, colorScheme: "dark" },
  { name: "phone-inset-light", viewport: PHONE, insets: SAFE_AREA, colorScheme: "light" },
  { name: "desktop-light", viewport: DESKTOP, insets: NO_SAFE_AREA, colorScheme: "light" },
  // L7: the dock and the notice stack are placed with logical properties, so
  // the right-to-left layout is measured too.
  { name: "rtl-landscape-667x375-inset-light", viewport: { width: 667, height: 375 }, insets: SAFE_AREA,
    colorScheme: "light", locale: "ar-XB" },
  { name: "rtl-phone-inset-dark", viewport: PHONE, insets: SAFE_AREA, colorScheme: "dark", locale: "ar-XB" },
];
// B2 follow-up: a dock taller than a third of the viewport sits inline at the
// end of the Timer content; a shorter one stays at the bottom edge. `dock`
// names the place each scene must measure into.
const DOCK_SIZE_SCENES = [
  { name: "portrait-320x568-inset-text-200", viewport: { width: 320, height: 568 }, insets: SAFE_AREA, font: 200, dock: "inline" },
  { name: "landscape-568x320-inset-text-200", viewport: { width: 568, height: 320 }, insets: SAFE_AREA, font: 200, dock: "inline" },
  { name: "portrait-375x667-inset-text-100", viewport: PHONE, insets: SAFE_AREA, font: 100, dock: "edge" },
  { name: "landscape-667x375-inset-text-100", viewport: { width: 667, height: 375 }, insets: SAFE_AREA, font: 100, dock: "edge" },
].map((scene) => ({ colorScheme: "light", ...scene }));
const DURATION_SENTENCE = /^Focus length was not changed: enter a whole number of minutes from \d+ to \d+\.$/;
const SAVE_SENTENCE = /^[A-Z][A-Za-z -]+ could not be saved\. Try again\.$/;
const SESSION_SENTENCE = "Your account could not be reached; try again in a moment.";

async function launchBrowser(t) {
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ["--ignore-certificate-errors"] });
  t.after(() => browser.close());
  return browser;
}

// A wait that times out reports what the app was doing, so a failure names
// its cause instead of only its line. The predicate is polled on a timer,
// not on animation frames: a busy machine can hold frames back for seconds
// while the page itself has already reached the awaited state.
async function until(page, what, predicate, arg = null, timeout = 15000) {
  try {
    return await page.waitForFunction(predicate, arg, { timeout, polling: 100 });
  } catch (error) {
    throw new Error(`${what}: ${JSON.stringify(await appState(page))}`, { cause: error });
  }
}

function appState(page) {
  return page.evaluate(() => {
    const state = window.PomodoroughAppTest?.state || {};
    const text = (id) => document.getElementById(id)?.textContent.replace(/\s+/g, " ").trim();
    return { ready: state.ready, bootstrapBlocked: state.bootstrapBlocked, workspaceBlocked: state.workspaceBlocked,
      actionLocked: state.actionLocked, syncing: state.syncing, retrying: state.retrying, conflict: state.conflict,
      pending: state.pending?.length, pendingTaskOperations: state.pendingTaskOperations?.length,
      tasks: state.tasks?.length, screen: state.activeScreen, status: text("syncStatus"),
      notice: document.getElementById("notice")?.hidden ? null : text("noticeText"),
      undoToast: !document.getElementById("undoToast")?.hidden, focus: document.activeElement?.id,
      taskInput: document.getElementById("taskInput")?.value, visibility: document.visibilityState,
      online: navigator.onLine,
      dialogs: [...document.querySelectorAll("dialog[open]")].map((dialog) => dialog.id) };
  });
}

// A synchronization or another action holds the action lock for a moment. A
// change made meanwhile waits for it (B4), so a test that reads the result of
// a change first waits until neither the lock nor a synchronization is held.
function idle(page, what) {
  return until(page, `${what}: the app did not become idle`, () => {
    const state = window.PomodoroughAppTest.state;
    return !state.actionLocked && !state.syncing;
  });
}

async function ready(page) {
  await until(page, "the app did not become ready", () => window.PomodoroughAppTest?.state?.ready
    && !window.PomodoroughAppTest.state.bootstrapBlocked, null, 20000);
  await page.evaluate(() => document.fonts.ready);
}

async function openApp(browser, { viewport, colorScheme = "light", locale = null }) {
  const context = await browser.newContext(
    { viewport, colorScheme, reducedMotion: "reduce", ignoreHTTPSErrors: true, bypassCSP: false,
      serviceWorkers: "block" });
  await context.addCookies([
    { name: fixture.sessionCookie, value: fixture.sessionToken, httpOnly: true },
    { name: fixture.csrfCookie, value: fixture.csrfToken, httpOnly: false },
  ].map((cookie) => ({ ...cookie, url: `${fixture.url}/`, secure: true, sameSite: "Lax" })));
  await context.addInitScript(() => { window.PomodoroughAppTest = { disableAutoStart: false }; });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  assert.equal((await page.goto(locale ? `${fixture.url}/app?locale=${locale}` : `${fixture.url}/app`)).status(), 200);
  await ready(page);
  if (locale) {
    const shown = await page.evaluate(() => ({ lang: document.documentElement.lang, dir: document.documentElement.dir }));
    assert.deepEqual(shown, { lang: locale, dir: locale === "ar-XB" ? "rtl" : "ltr" }, `the page is shown in ${locale}`);
  }
  return { context, page, errors };
}

// Two frames and a short task let layout, IntersectionObserver reports and
// the resulting render finish.
function settle(page) {
  return page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 80)));
  }));
}

async function shot(page, scene, state) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `r2-pwa-${state}-${scene.name}.png`) });
}

// Runs in the page. An element is in view when its whole box is inside the
// viewport and a hit test at its centre reaches it; anything else is null.
function inView(ids) {
  const seen = (id) => {
    const element = id === ":focus" ? document.activeElement : document.getElementById(id);
    if (!element || element.closest("[hidden]")) return null;
    const box = element.getBoundingClientRect();
    const inside = box.height > 0 && box.top >= -0.5 && box.left >= -0.5
      && box.bottom <= window.innerHeight + 0.5 && box.right <= window.innerWidth + 0.5;
    const centre = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    if (!inside || !element.contains(document.elementFromPoint(centre.x, centre.y))) return null;
    return { ...centre, id: element.id, top: box.top, bottom: box.bottom, height: box.height,
      text: element.textContent.replace(/\s+/g, " ").trim() };
  };
  return Object.fromEntries(ids.map((id) => [id, seen(id)]));
}

async function seen(page, id) {
  return (await page.evaluate(inView, [id]))[id];
}

async function clickInView(page, id, label) {
  const target = await seen(page, id);
  const place = target ? "" : await page.evaluate((elementId) => {
    const box = document.getElementById(elementId).getBoundingClientRect();
    const over = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return `top ${Math.round(box.top)}, bottom ${Math.round(box.bottom)}, viewport ${window.innerHeight}, `
      + `scroll ${Math.round(window.scrollY)}, at its centre: ${over ? over.id || over.className || over.tagName : "nothing"}`;
  }, id);
  assert.ok(target, `${label}: #${id} is not fully inside the viewport and on top (${place})`);
  await page.mouse.click(target.x, target.y);
}

function scrollToShare(page, share) {
  return page.evaluate((part) => {
    window.scrollTo(0, (document.documentElement.scrollHeight - window.innerHeight) * part);
  }, share);
}

async function primaryInView(page) {
  const found = await page.evaluate(inView, ["timerToggle", "timerDockToggle", "timerDisplay", "timerDockDisplay"]);
  return { control: found.timerToggle || found.timerDockToggle, countdown: found.timerDisplay || found.timerDockDisplay };
}

async function assertPrimaryInView(page, label) {
  let view = await primaryInView(page);
  for (let attempt = 0; attempt < 20 && !(view.control && view.countdown); attempt += 1) {
    await page.waitForTimeout(50);
    view = await primaryInView(page);
  }
  assert.ok(view.control, `${label}: no Start/Pause/Resume control is fully inside the viewport`);
  assert.ok(view.countdown, `${label}: no countdown is fully inside the viewport`);
  assert.ok(view.control.height >= TOUCH_TARGET - 0.5,
    `${label}: #${view.control.id} is ${view.control.height}px high, below the ${TOUCH_TARGET}px touch target`);
  assert.match(view.control.text, /^(Start|Pause|Resume)/, label);
  assert.match(view.countdown.text, /\d\d:\d\d/, label);
  return view;
}

async function pressPrimary(page, control, label) {
  await page.mouse.click(control.x, control.y);
  try {
    await page.waitForFunction((before) => document.getElementById("timerToggle")
      .textContent.replace(/\s+/g, " ").trim() !== before, control.text, { timeout: 15000, polling: 100 });
  } catch (error) {
    const state = await page.evaluate(() => ({ notice: document.getElementById("noticeText").textContent,
      noticeShown: !document.getElementById("notice").hidden, scrollY: window.scrollY,
      disabled: document.getElementById("timerToggle").disabled,
      instruction: document.getElementById("timerInstruction")?.textContent }));
    throw new Error(`${label}: #${control.id} "${control.text}" did not change the timer: ${JSON.stringify(state)}`,
      { cause: error });
  }
}

// B2: on a short viewport the Timer panel starts so low that the dock's strip
// at the bottom edge still holds the screen tabs. The dock then waits unseen.
// The wait is measured here, not taken from the page's word: the panel must
// start below the top of the dock's strip.
function dockWaitsForPanel(page) {
  return page.evaluate(() => {
    const dock = document.getElementById("timerDock");
    if (dock.hidden || getComputedStyle(dock).visibility !== "hidden") return false;
    const panelTop = document.getElementById("timerScreen").getBoundingClientRect().top;
    return panelTop > window.innerHeight - dock.getBoundingClientRect().height;
  });
}

function dockSitsInline(page) {
  return page.evaluate(() => document.getElementById("timerDock").classList.contains("timer-dock-inline"));
}

// A dock taller than a third of the viewport sits inline at the end of the
// Timer content (B2 follow-up), so it is not in view at every scroll
// position. It still holds the countdown and the control together: scrolled
// into view, both must be inside the viewport.
async function inlineDockInView(page, label) {
  await page.evaluate(() => document.getElementById("timerDock").scrollIntoView({ block: "center" }));
  await settle(page);
  return assertPrimaryInView(page, `${label}, inline dock`);
}

// Start, Pause and Resume in turn; whichever state the shared account is in,
// each state must keep both the control and the countdown in view.
async function checkTimerScenario(browser, scenario) {
  const { context, page, errors } = await openApp(browser, scenario);
  await page.evaluate((font) => { document.documentElement.style.fontSize = `${font}%`; }, scenario.font);
  const labels = [];
  for (let step = 0; step < 3; step += 1) {
    let view = null;
    for (const share of SCROLL_SHARES) {
      await scrollToShare(page, share);
      await settle(page);
      if (await dockWaitsForPanel(page) || await dockSitsInline(page)) continue;
      view = await assertPrimaryInView(page, `${scenario.name}, step ${step}, scroll ${share}`);
    }
    if (await dockSitsInline(page)) view = await inlineDockInView(page, `${scenario.name}, step ${step}`);
    labels.push(view.control.text);
    await idle(page, `${scenario.name}, step ${step}`);
    view = await assertPrimaryInView(page, `${scenario.name}, step ${step}, before the press`);
    await pressPrimary(page, view.control, `${scenario.name}, step ${step}`);
  }
  assert.equal(new Set(labels).size >= 2, true, `${scenario.name}: the control changed the timer (${labels})`);
  assert.deepEqual(errors, [], scenario.name);
  await context.close();
}

// Setup, not behaviour under test: later scenes need an idle timer because
// durations lock while a timer is active.
async function idleTimer(page) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const idle = await page.evaluate(() => !document.getElementById("focusDuration").disabled
      && document.getElementById("cancelButton").hidden);
    if (idle) return;
    await page.evaluate(() => {
      const button = ["cancelButton", "clearButton"].map((id) => document.getElementById(id))
        .find((candidate) => !candidate.hidden && !candidate.disabled);
      button?.click();
    });
    await page.waitForTimeout(400);
  }
  assert.fail("the timer did not return to idle");
}

async function checkTimerDockScene(browser, scene) {
  const { context, page, errors } = await openApp(browser, scene);
  await idleTimer(page);
  await settle(page);
  await assertPrimaryInView(page, `${scene.name} idle`);
  await shot(page, scene, "timer-idle");
  await idle(page, `${scene.name} start`);
  const start = (await primaryInView(page)).control;
  await page.mouse.click(start.x, start.y);
  await until(page, `${scene.name}: Start did not start the timer`,
    () => document.getElementById("timerToggle").textContent.trim() === "Pause");
  await settle(page);
  await assertPrimaryInView(page, `${scene.name} running`);
  await shot(page, scene, "timer-running");
  await scrollToShare(page, 1);
  await settle(page);
  await assertPrimaryInView(page, `${scene.name} running, end of page`);
  await shot(page, scene, "timer-running-end");
  await idleTimer(page);
  assert.deepEqual(errors, [], scene.name);
  await context.close();
}

function noticeState(page) {
  return page.evaluate(() => ({
    shown: !document.getElementById("notice").hidden,
    text: document.getElementById("noticeText").textContent,
    retry: document.getElementById("noticeRetry")?.hidden === false,
  }));
}

async function shownNotice(page, label) {
  await until(page, `${label}: no notice appeared`, () => !document.getElementById("notice").hidden);
  await settle(page);
  const state = await noticeState(page);
  assert.doesNotMatch(state.text, /Error|Exception|store\.put|Quota|shared-core|\(\d{3}\)|[{}[\]]/, label);
  assert.ok(await seen(page, "noticeDismiss"), `${label}: Dismiss is in view`);
  return state;
}

async function checkDurationNotice(page, scene) {
  await page.focus("#focusDuration");
  await page.fill("#focusDuration", "0");
  await page.keyboard.press("Enter");
  const rejected = await shownNotice(page, "duration below the minimum");
  assert.match(rejected.text, DURATION_SENTENCE);
  assert.equal(rejected.retry, false);
  assert.equal(await page.getAttribute("#focusDuration", "aria-invalid"), "true");
  assert.ok(await seen(page, ":focus"), "the rejected field stays in view under the notice");
  await shot(page, scene, "notice-duration");
  const next = await page.evaluate(() => (Number(document.getElementById("focusDuration").min) + 25
    + (Date.now() % 20)));
  await idle(page, "valid duration");
  await page.fill("#focusDuration", String(next));
  await page.keyboard.press("Enter");
  await until(page, "a saved duration did not clear the notice", () => document.getElementById("notice").hidden);
  assert.equal(await page.getAttribute("#focusDuration", "aria-invalid"), null);
}

async function checkSaveFailureNotice(page, scene) {
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = function put() {
      throw new DOMException("store.put failed {\"code\":22}", "QuotaExceededError");
    };
  });
  await page.focus("#autoStartBreaks");
  await page.keyboard.press("Space");
  const failed = await shownNotice(page, "failed save");
  assert.match(failed.text, SAVE_SENTENCE);
  await shot(page, scene, "notice-save-failed");
}

async function checkSessionNotice(page, scene) {
  await page.route("**/api/v1/me", (route) => route.fulfill({ status: 503, body: "unavailable" }));
  await page.reload();
  const deferred = await shownNotice(page, "deferred session");
  assert.equal(deferred.text, SESSION_SENTENCE);
  assert.equal(deferred.retry, true);
  await scrollToShare(page, 0);
  await settle(page);
  await shot(page, scene, "notice-session");
  await page.unroute("**/api/v1/me");
  await clickInView(page, "noticeRetry", "session notice");
  await until(page, "Try again did not clear the session notice", () => document.getElementById("notice").hidden);
}

async function checkNoticeScene(browser, scene) {
  const { context, page, errors } = await openApp(browser, scene);
  await idleTimer(page);
  await checkDurationNotice(page, scene);
  await checkSaveFailureNotice(page, scene);
  await checkSessionNotice(page, scene);
  assert.deepEqual(errors, [], scene.name);
  await context.close();
}

function taskIds(page) {
  return page.evaluate(() => window.PomodoroughAppTest.state.tasks.map((task) => task.id));
}

async function addTask(page, title) {
  await idle(page, `task "${title}"`);
  await page.fill("#taskInput", title);
  await page.keyboard.press("Enter");
  const handle = await until(page, `task "${title}" was not added`, (name) => window.PomodoroughAppTest.state.tasks
    .find((task) => task.title === name)?.id, title);
  return handle.jsonValue();
}

// The row's Delete is centred first: this is setup for the toast checks.
async function deleteRow(page, taskId) {
  const point = await page.evaluate((id) => {
    const button = document.querySelector(`#taskList .task-row[data-task-id="${id}"] .task-delete`);
    button.scrollIntoView({ block: "center", behavior: "instant" });
    const box = button.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }, taskId);
  await page.mouse.click(point.x, point.y);
  await until(page, "Delete did not open the undo window", () => !document.getElementById("undoToast").hidden);
  await settle(page);
}

function rowShown(page, taskId) {
  return page.evaluate((id) => document.querySelector(`#taskList .task-row[data-task-id="${id}"]`) !== null, taskId);
}

async function assertUndoToastOpen(page, taskId, label) {
  const toast = await page.evaluate(inView, ["undoToast", "undoToastUndo", "undoToastDismiss", ":focus"]);
  for (const id of ["undoToast", "undoToastUndo", "undoToastDismiss"]) assert.ok(toast[id], `${label}: #${id} is in view`);
  assert.ok(toast[":focus"], `${label}: the focused control is not covered by the toast`);
  assert.equal(await rowShown(page, taskId), false, `${label}: the deleted row is hidden`);
  assert.equal((await taskIds(page)).includes(taskId), true, `${label}: nothing is deleted while the window is open`);
}

async function checkUndoToastPlacement(page, scene, taskId) {
  await assertUndoToastOpen(page, taskId, "after delete");
  assert.equal(await page.textContent("#undoToastHint"), "Undo is available.");
  assert.equal(await page.textContent("#undoToastDismiss"), "Delete now");
  assert.equal(await page.getAttribute("#undoToastDismiss", "aria-label"), null);
  await page.waitForTimeout(OLD_UNDO_MS + 1000);
  await assertUndoToastOpen(page, taskId, "after the old five-second limit");
  await page.evaluate(() => document.getElementById("taskInput").focus());
  await settle(page);
  assert.ok(await seen(page, "taskInput"), "the focused task field is not covered by the toast");
  assert.ok(await seen(page, "undoToastUndo"), "Undo is still in view next to the task field");
  await shot(page, scene, "undo-toast");
  await scrollToShare(page, 0);
  await settle(page);
  const overlap = await page.evaluate(() => {
    const toast = document.getElementById("undoToast").getBoundingClientRect();
    const form = document.getElementById("taskForm").getBoundingClientRect();
    return toast.bottom > form.top && toast.top < form.bottom;
  });
  assert.equal(overlap, false, "at the top of the page the toast does not overlap the task form");
  // B2: the toast follows the Tasks heading, so on a small phone it can start
  // at the fold when the page is at the very top; a scroll reaches it.
  await page.evaluate(() => document.getElementById("undoToast").scrollIntoView({ block: "nearest" }));
  await settle(page);
}

async function checkUndoAndDismiss(page, taskId) {
  await clickInView(page, "undoToastUndo", "Undo");
  await until(page, "Undo did not close the toast", () => document.getElementById("undoToast").hidden);
  assert.equal(await rowShown(page, taskId), true, "Undo brings the row back");
  await deleteRow(page, taskId);
  assert.equal(await page.evaluate(() => document.getElementById("undoToastDismiss").tabIndex), 0);
  await page.focus("#undoToastDismiss");
  await page.keyboard.press("Enter");
  await until(page, "Dismiss did not complete the delete",
    (id) => !window.PomodoroughAppTest.state.tasks.some((task) => task.id === id), taskId);
  assert.equal(await page.evaluate(() => document.getElementById("undoToast").hidden), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), "taskInput");
}

// The browser cannot hide a headless tab on request, so the page reports the
// hidden state the same way a tab switch does.
async function checkHiddenTabCompletesDelete(page, taskId) {
  await deleteRow(page, taskId);
  const sent = page.waitForResponse((response) => response.url().endsWith("/api/v1/sync") && response.ok(),
    { timeout: 15000 });
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await until(page, "the hidden tab did not complete the delete",
    (id) => !window.PomodoroughAppTest.state.tasks.some((task) => task.id === id), taskId);
  assert.equal(await page.evaluate(() => document.getElementById("undoToast").hidden), true);
  await sent;
  await until(page, "the delete was not synchronized", () => {
    const state = window.PomodoroughAppTest.state;
    return !state.syncing && state.pending.length + state.pendingTaskOperations.length === 0;
  }, null, 15000);
}

async function checkUndoScene(browser, scene) {
  const { context, page, errors } = await openApp(browser, scene);
  await clickInView(page, "tasksTab", "Tasks tab");
  const stamp = `${scene.name} ${Date.now() % 100000}`;
  const kept = await addTask(page, `Keep ${stamp}`);
  const dismissed = await addTask(page, `Dismiss ${stamp}`);
  const hidden = await addTask(page, `Hide ${stamp}`);
  await deleteRow(page, dismissed);
  await checkUndoToastPlacement(page, scene, dismissed);
  await checkUndoAndDismiss(page, dismissed);
  await checkHiddenTabCompletesDelete(page, hidden);
  // The reload waits for the sync above: a reload that interrupts a sync is a
  // separate startup problem and not what this scene measures.
  await page.reload();
  await ready(page);
  const afterReload = await taskIds(page);
  assert.equal(afterReload.includes(kept), true, "the untouched task survives a reload");
  assert.equal(afterReload.includes(dismissed), false, "the dismissed delete is durable");
  assert.equal(afterReload.includes(hidden), false, "the delete completed by a hidden tab is durable");
  assert.deepEqual(errors, [], scene.name);
  await context.close();
}

function synchronized(page, what) {
  return until(page, `${what}: the workspace was not synchronized`, () => {
    const state = window.PomodoroughAppTest.state;
    return !state.actionLocked && !state.syncing && state.pending.length + state.pendingTaskOperations.length === 0;
  }, null, 20000);
}

async function openTasks(page) {
  await scrollToShare(page, 0);
  await settle(page);
  await clickInView(page, "tasksTab", "Tasks tab");
}

function pendingDeletionMarker(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("pomodoroughPendingTaskDeletions") || "[]")
    .map((record) => record.taskId));
}

// The page leaves inside the undo window and comes back. The unload cannot
// finish the delete; the next startup must.
async function checkUnloadCompletesDelete(page, taskId, label, leaveAndReturn) {
  await synchronized(page, `${label}: before the delete`);
  await openTasks(page);
  await deleteRow(page, taskId);
  assert.deepEqual(await pendingDeletionMarker(page), [taskId], `${label}: the delete is marked before the page leaves`);
  await leaveAndReturn();
  await ready(page);
  await until(page, `${label}: the next startup did not complete the delete`,
    (id) => !window.PomodoroughAppTest.state.tasks.some((task) => task.id === id), taskId);
  assert.deepEqual(await pendingDeletionMarker(page), [], `${label}: the marker is cleared`);
  assert.equal(await page.evaluate(() => document.getElementById("undoToast").hidden), true);
}

async function checkUndoBeforeUnloadKeepsTask(page, taskId) {
  await synchronized(page, "before the undone delete");
  await openTasks(page);
  await deleteRow(page, taskId);
  await clickInView(page, "undoToastUndo", "Undo");
  assert.deepEqual(await pendingDeletionMarker(page), [], "Undo clears the marker");
  await page.reload();
  await ready(page);
  await synchronized(page, "after the reload that follows Undo");
  assert.equal((await taskIds(page)).includes(taskId), true, "an undone delete is not replayed by the next startup");
}

async function checkUnloadScene(browser, scene) {
  const { context, page, errors } = await openApp(browser, scene);
  await clickInView(page, "tasksTab", "Tasks tab");
  const stamp = `${scene.name} ${Date.now() % 100000}`;
  const kept = await addTask(page, `Stay ${stamp}`);
  const reloaded = await addTask(page, `Reload ${stamp}`);
  const navigated = await addTask(page, `Navigate ${stamp}`);
  await checkUnloadCompletesDelete(page, reloaded, "reload", () => page.reload());
  await checkUnloadCompletesDelete(page, navigated, "navigation", async () => {
    assert.equal((await page.goto(`${fixture.url}/privacy`)).status(), 200);
    assert.equal((await page.goto(`${fixture.url}/app`)).status(), 200);
  });
  await checkUndoBeforeUnloadKeepsTask(page, kept);
  await synchronized(page, "before the last reload");
  await page.reload();
  await ready(page);
  assert.deepEqual((await taskIds(page)).filter((id) => [kept, reloaded, navigated].includes(id)), [kept],
    "both replayed deletes are durable and the undone one never happened");
  assert.deepEqual(errors, [], scene.name);
  await context.close();
}

// Acceptance L7: offline has its own status and no notice (A2), and a delete
// made offline after the undo window is saved locally and reaches the server
// when the connection returns (B1).
async function checkOfflineScene(browser, scene) {
  const { context, page, errors } = await openApp(browser, scene);
  await clickInView(page, "tasksTab", "Tasks tab");
  const stamp = `${scene.name} ${Date.now() % 100000}`;
  const kept = await addTask(page, `Online ${stamp}`);
  const deleted = await addTask(page, `Offline delete ${stamp}`);
  await synchronized(page, "before going offline");
  await context.setOffline(true);
  await until(page, "the status did not say offline", () => !navigator.onLine
    && /\bOffline \//.test(document.getElementById("syncStatus").textContent));
  assert.equal(await page.evaluate(() => document.getElementById("notice").hidden), true, "offline adds no notice");
  await deleteRow(page, deleted);
  await clickInView(page, "undoToastDismiss", "Delete now");
  await until(page, "the offline delete was not saved locally",
    (id) => !window.PomodoroughAppTest.state.tasks.some((task) => task.id === id), deleted);
  assert.deepEqual(await pendingDeletionMarker(page), [], "a delete saved offline leaves no marker");
  assert.equal(await page.evaluate(() => document.getElementById("notice").hidden), true, "the offline delete adds no notice");
  await context.setOffline(false);
  await synchronized(page, "after the connection returned");
  await page.reload();
  await ready(page);
  await synchronized(page, "after the reload");
  assert.deepEqual((await taskIds(page)).filter((id) => [kept, deleted].includes(id)), [kept],
    `${scene.name}: the offline delete reached the server`);
  assert.deepEqual(errors, [], scene.name);
  await context.close();
}

// Core 0.56.0 rename: a task with a finished focus run is renamed. The row
// under the new title keeps the run, and after a reload the server's own
// history names the new identity (task.carryHistory.v1). The start, finish
// and clear clicks are setup and use element clicks, not measured pointers.
function taskStats(page, taskId) {
  return page.evaluate((id) => {
    const row = document.querySelector(`#taskList .task-row[data-task-id="${id}"]`);
    return row && { title: row.querySelector(".task-name").textContent,
      count: row.querySelector(".task-stat").textContent };
  }, taskId);
}

async function finishFocusRun(page, taskId) {
  await scrollToShare(page, 0);
  await settle(page);
  await clickInView(page, "timerTab", "Timer tab");
  await page.selectOption("#taskSelector", taskId);
  await synchronized(page, "after selecting the task");
  await page.evaluate(() => document.getElementById("timerToggle").click());
  await until(page, "the focus run did not start", () => !document.getElementById("finishButton").disabled);
  await page.evaluate(() => document.getElementById("finishButton").click());
  await until(page, "the focus run did not finish", (id) => window.PomodoroughAppTest.state.baseHistory
    .concat(window.PomodoroughAppTest.state.history).some((row) => row.taskId === id && row.status === "completed"), taskId);
  await synchronized(page, "after the finished run");
}

async function renameRow(page, taskId, title) {
  await openTasks(page);
  await page.evaluate((id) => document.querySelector(`#taskList .task-row[data-task-id="${id}"] .task-rename`).click(), taskId);
  await page.fill("#taskList .task-rename-input", title);
  await page.keyboard.press("Enter");
  const handle = await until(page, `the task was not renamed to "${title}"`, (name) => window.PomodoroughAppTest.state.tasks
    .find((task) => task.title === name)?.id, title);
  return handle.jsonValue();
}

function serverHistoryTasks(page) {
  return page.evaluate(() => window.PomodoroughAppTest.state.baseHistory.map((row) => row.taskId || ""));
}

async function checkRenameScene(browser, scene) {
  const { context, page, errors } = await openApp(browser, scene);
  await clickInView(page, "tasksTab", "Tasks tab");
  const stamp = `${scene.name} ${Date.now() % 100000}`;
  const before = await addTask(page, `Before rename ${stamp}`);
  await synchronized(page, "before the run");
  await finishFocusRun(page, before);
  await openTasks(page);
  assert.equal((await taskStats(page, before)).count, "1", "the finished run counts for the task");
  const after = await renameRow(page, before, `After rename ${stamp}`);
  assert.notEqual(after, before, "a rename moves the task to a new identity");
  await synchronized(page, "after the rename");
  assert.deepEqual(await taskStats(page, after), { title: `After rename ${stamp}`, count: "1" },
    "the renamed row keeps today's run");
  assert.equal(await taskStats(page, before), null, "the old row is gone");
  await page.reload();
  await ready(page);
  await synchronized(page, "after the reload");
  const history = await serverHistoryTasks(page);
  assert.equal(history.includes(after), true, `the server history names the new identity: ${JSON.stringify(history)}`);
  assert.equal(history.includes(before), false, "the server history no longer names the old identity");
  await openTasks(page);
  assert.deepEqual(await taskStats(page, after), { title: `After rename ${stamp}`, count: "1" },
    "the renamed row keeps today's run after a reload");
  await idleTimer(page);
  assert.deepEqual(errors, [], scene.name);
  await context.close();
}

// The sign-in page is not part of this leg: the navigation that follows a
// completed sign-out ends on a blank page of the same origin.
async function stubSignInStart(context) {
  await context.route((url) => url.pathname === "/auth/google/start",
    (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>signed out</title>" }));
}

// A user who is asked about changes that still wait to sync answers no, waits
// for the sync and signs out again. Returns how often the question was asked.
async function signOutKeepingChanges(page) {
  let asked = 0;
  page.on("dialog", (dialog) => { asked += 1; dialog.dismiss(); });
  const signedOut = (timeout) => page.waitForURL((url) => url.pathname === "/auth/google/start", { timeout })
    .then(() => true, () => false);
  await page.locator("#logoutButton").click();
  if (await signedOut(5000)) return asked;
  assert.equal(asked, 1, "sign-out neither finished nor asked about the unsynced delete");
  await synchronized(page, "after the sign-out question");
  await page.locator("#logoutButton").click();
  assert.equal(await signedOut(20000), true, "the second sign-out did not finish");
  return asked;
}

async function signInAgain(context, page) {
  await context.clearCookies();
  await context.addCookies([
    { name: fixture.sessionCookie, value: fixture.secondSessionToken, httpOnly: true },
    { name: fixture.csrfCookie, value: fixture.secondCsrfToken, httpOnly: false },
  ].map((cookie) => ({ ...cookie, url: `${fixture.url}/`, secure: true, sameSite: "Lax" })));
  assert.equal((await page.goto(`${fixture.url}/app`)).status(), 200);
  await ready(page);
  await synchronized(page, "after the second sign-in");
}

// Acceptance M1: sign-out inside the undo window used to discard the delete,
// and the task came back with the next sign-in.
async function checkSignOutScene(browser, scene) {
  const { context, page, errors } = await openApp(browser, scene);
  await stubSignInStart(context);
  await clickInView(page, "tasksTab", "Tasks tab");
  const stamp = `${scene.name} ${Date.now() % 100000}`;
  const kept = await addTask(page, `Kept ${stamp}`);
  const deleted = await addTask(page, `Deleted ${stamp}`);
  await synchronized(page, "before the delete");
  await deleteRow(page, deleted);
  await signOutKeepingChanges(page);
  await signInAgain(context, page);
  assert.deepEqual((await taskIds(page)).filter((id) => [kept, deleted].includes(id)), [kept],
    `${scene.name}: a task deleted before sign-out stays deleted after the next sign-in`);
  assert.deepEqual(await pendingDeletionMarker(page), [], "no marker is left behind");
  assert.deepEqual(errors, [], scene.name);
  await context.close();
}

// Runs in the page. Scrolls through the whole page in quarter-viewport steps
// and names every position where the visible cover lies over another element.
async function coverageWhileScrolling({ coverId, selectors, atEnd = [] }) {
  const settled = () => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 80)));
  });
  const cover = document.getElementById(coverId);
  const report = { overlaps: [], shownAt: 0, positions: 0 };
  for (let top = 0, atPageEnd = false; !atPageEnd; top += window.innerHeight / 4) {
    window.scrollTo(0, top);
    await settled();
    atPageEnd = top >= document.documentElement.scrollHeight - window.innerHeight;
    report.positions += 1;
    const box = cover.getBoundingClientRect();
    const unseen = cover.closest("[hidden]") || getComputedStyle(cover).visibility === "hidden";
    if (unseen || box.height === 0 || box.top >= window.innerHeight || box.bottom <= 0) continue;
    report.shownAt += 1;
    for (const selector of atPageEnd ? [...selectors, ...atEnd] : selectors) {
      const other = document.querySelector(selector).getBoundingClientRect();
      if (other.height > 0 && box.bottom > other.top + 0.5 && box.top < other.bottom - 0.5) {
        report.overlaps.push(`${selector} at scroll ${Math.round(window.scrollY)}`);
      }
    }
  }
  return report;
}

async function checkDockClearOfNavigation(page, label) {
  // The footer is not navigation: the dock may pass over it, but at the end
  // of the page it rests below the footer.
  const dock = await page.evaluate(coverageWhileScrolling,
    { coverId: "timerDock", selectors: [".screen-nav", ".masthead"], atEnd: [".site-footer"] });
  assert.deepEqual(dock.overlaps, [], `${label}: the Timer dock lies over navigation`);
  assert.ok(dock.shownAt > 0, `${label}: the Timer dock is shown while the page scrolls (${JSON.stringify(dock)})`);
}

async function checkNoticeStackClearOfHeading(page, scene) {
  const label = scene.name;
  await scrollToShare(page, 0);
  await page.locator("#tasksTab").click();
  const taskId = await addTask(page, `Cover ${label} ${Date.now() % 100000}`);
  await deleteRow(page, taskId);
  const toast = await page.evaluate(coverageWhileScrolling,
    { coverId: "undoToast", selectors: ["#tasks-title", ".screen-nav", ".masthead"] });
  assert.deepEqual(toast.overlaps, [], `${label}: the notice stack lies over the page heading`);
  assert.ok(toast.shownAt > 0, `${label}: the undo toast is shown while the page scrolls (${JSON.stringify(toast)})`);
  assert.ok(await seen(page, "undoToastUndo"), `${label}: Undo is in view at the end of the page`);
  await shot(page, scene, "toast-below-heading");
  await page.locator("#undoToastDismiss").click();
  await synchronized(page, `${label}: dismissed delete`);
}

async function openCoverageScene(browser, scene) {
  const opened = await openApp(browser, scene);
  const cdp = await opened.context.newCDPSession(opened.page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: scene.insets });
  await settle(opened.page);
  return opened;
}

async function checkDockCoverageScene(browser, scene) {
  const { context, page, errors } = await openCoverageScene(browser, scene);
  await idleTimer(page);
  await checkDockClearOfNavigation(page, scene.name);
  await scrollToShare(page, 0);
  await settle(page);
  await shot(page, scene, "dock-top");
  await scrollToShare(page, 0.5);
  await settle(page);
  await shot(page, scene, "dock-middle");
  assert.deepEqual(errors, [], scene.name);
  await context.close();
}

// Runs in the page. Reads the dock's place over several frames at each scroll
// position: the place must not change between frames at rest. The height at
// the bottom edge is read on a copy, so the page's own dock is not moved.
async function dockPlacesWhileScrolling() {
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const dock = document.getElementById("timerDock");
  const place = () => {
    const box = dock.getBoundingClientRect();
    return { inline: dock.classList.contains("timer-dock-inline"), position: getComputedStyle(dock).position,
      inPanel: document.getElementById("timerScreen").contains(dock),
      last: dock.parentElement.lastElementChild === dock, hidden: dock.hidden,
      atBottomEdge: !dock.hidden && Math.abs(box.bottom - window.innerHeight) < 1,
      reserve: document.documentElement.style.scrollPaddingBottom };
  };
  const copy = dock.cloneNode(true);
  Object.assign(copy, { id: "", hidden: false });
  copy.classList.remove("timer-dock-inline", "timer-dock-waiting");
  document.body.append(copy);
  const report = { edgeHeight: copy.getBoundingClientRect().height, viewportHeight: window.innerHeight, positions: [] };
  copy.remove();
  for (let top = 0, atPageEnd = false; !atPageEnd; top += window.innerHeight / 4) {
    window.scrollTo(0, top);
    await frame();
    await frame();
    atPageEnd = top >= document.documentElement.scrollHeight - window.innerHeight;
    const frames = [];
    for (let count = 0; count < 8; count += 1) {
      frames.push(JSON.stringify(place()));
      await frame();
    }
    report.positions.push({ scroll: Math.round(window.scrollY), places: [...new Set(frames)].map((json) => JSON.parse(json)) });
  }
  return report;
}

function assertDockPlace(report, scene) {
  const label = `${scene.name} (dock ${report.edgeHeight}px of ${report.viewportHeight}px)`;
  assert.equal(report.edgeHeight > report.viewportHeight / 3, scene.dock === "inline", `${label}: scene expectation`);
  for (const { scroll, places } of report.positions) {
    assert.equal(places.length, 1, `${label}: the dock changed place at rest at scroll ${scroll}: ${JSON.stringify(places)}`);
    const [place] = places;
    if (scene.dock === "inline") {
      assert.deepEqual({ ...place, atBottomEdge: false },
        { inline: true, position: "static", inPanel: true, last: true, hidden: false, atBottomEdge: false, reserve: "" },
        `${label}: inline at scroll ${scroll}`);
    } else {
      assert.deepEqual([place.inline, place.position, place.inPanel], [false, "sticky", false], `${label}: at scroll ${scroll}`);
    }
  }
  if (scene.dock === "edge") {
    assert.ok(report.positions.some(({ places }) => places[0].atBottomEdge), `${label}: the dock is shown at the bottom edge`);
  }
  console.log(`${label}: ${scene.dock} at ${report.positions.length} scroll positions`);
}

async function checkDockSizeScene(browser, scene) {
  const { context, page, errors } = await openCoverageScene(browser, scene);
  await page.evaluate((font) => { document.documentElement.style.fontSize = `${font}%`; }, scene.font);
  await idleTimer(page);
  await settle(page);
  assertDockPlace(await page.evaluate(dockPlacesWhileScrolling), scene);
  await scrollToShare(page, 1);
  await settle(page);
  await shot(page, scene, "dock-size-end");
  if (scene.dock === "inline") await checkDockClearOfNavigation(page, scene.name);
  assert.deepEqual(errors, [], scene.name);
  await context.close();
}

async function checkNoticeStackCoverageScene(browser, scene) {
  const { context, page, errors } = await openCoverageScene(browser, scene);
  await checkNoticeStackClearOfHeading(page, scene);
  assert.deepEqual(errors, [], scene.name);
  await context.close();
}

// A task row is added first, so the Tasks screen shows its row controls.
async function checkContrastScene(browser, scene) {
  const { context, page, errors } = await openApp(browser, scene);
  const findings = [];
  for (const screen of ["timer", "tasks"]) {
    if (screen === "tasks") {
      await clickInView(page, "tasksTab", "Tasks tab");
      await addTask(page, `Contrast ${scene.name}`);
      await idle(page, "the added task");
    }
    await settle(page);
    await shot(page, scene, `contrast-${screen}`);
    findings.push(...(await contrastFindings(page)).map((finding) => `${screen}: ${finding}`));
  }
  assert.deepEqual(findings, [], scene.name);
  assert.deepEqual(errors, [], scene.name);
  await context.close();
}

for (const scene of SCENES) {
  test(`B6: rendered text and focus ring contrast, ${scene.name}`, async (t) => checkContrastScene(await launchBrowser(t), scene));
}

test("B2: the Timer dock never lies over the screen tabs, the masthead or the footer", async (t) => {
  const browser = await launchBrowser(t);
  for (const scene of COVERAGE_SCENES) await checkDockCoverageScene(browser, scene);
});

test("B2: a dock taller than a third of the viewport sits inline at the end of the Timer content", async (t) => {
  const browser = await launchBrowser(t);
  for (const scene of DOCK_SIZE_SCENES) await checkDockSizeScene(browser, scene);
});

test("B2: the notice stack never lies over the Tasks heading", async (t) => {
  const browser = await launchBrowser(t);
  for (const scene of COVERAGE_SCENES) await checkNoticeStackCoverageScene(browser, scene);
});

test("B1: a delete survives a reload and a navigation inside the undo window", async (t) => {
  const browser = await launchBrowser(t);
  for (const scene of [SCENES[0], SCENES[2]]) await checkUnloadScene(browser, scene);
});

test("A3: the countdown and the primary control stay in view at every scroll position", async (t) => {
  const browser = await launchBrowser(t);
  for (const scenario of TIMER_SCENARIOS) await checkTimerScenario(browser, scenario);
});

for (const scene of SCENES) {
  test(`A3: timer dock, ${scene.name}`, async (t) => checkTimerDockScene(await launchBrowser(t), scene));
  test(`A1: undo window, ${scene.name}`, async (t) => checkUndoScene(await launchBrowser(t), scene));
  test(`A2: failure notices, ${scene.name}`, async (t) => checkNoticeScene(await launchBrowser(t), scene));
}

test("L7: offline shows its own status and an offline delete reaches the server when the connection returns", async (t) => {
  const browser = await launchBrowser(t);
  await checkOfflineScene(browser, SCENES[0]);
});

test("Core 0.56.0: a renamed task keeps today's run in the PWA and in the server history", async (t) => {
  const browser = await launchBrowser(t);
  await checkRenameScene(browser, SCENES[0]);
});

// Sign-out revokes the session every other leg opens the app with, so this
// leg runs last.
test("B1: a task deleted inside the undo window stays deleted after sign-out and sign-in", async (t) => {
  const browser = await launchBrowser(t);
  await checkSignOutScene(browser, SCENES[0]);
});
