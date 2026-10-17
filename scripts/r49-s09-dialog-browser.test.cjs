"use strict";

const assert = require("node:assert/strict");
const { readFileSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { chromium } = require(process.env.POMODOROUGH_PLAYWRIGHT_MODULE || "playwright");
const fixture = JSON.parse(readFileSync(0, "utf8"));
const INSETS = { top: 47, right: 44, bottom: 34, left: 44 };
const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };
const TOLERANCE = 0.75;
const SCENARIOS = [
  { name: "320x568, 200% text, 44px side insets", width: 320, height: 568, font: 200, insets: INSETS },
  { name: "960x720, fold 470..490, 100% text", width: 960, height: 720, font: 100, fold: true },
  { name: "960x720, fold 470..490, 200% text", width: 960, height: 720, font: 200, fold: true },
  { name: "960x720, normal controls", width: 960, height: 720, font: 100 },
  { name: "320x568, normal controls", width: 320, height: 568, font: 100 },
];

async function launchBrowser(t) {
  const profile = mkdtempSync(join(tmpdir(), "pomodorough-r49-s09-"));
  const context = await chromium.launchPersistentContext(profile, {
    headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ["--ignore-certificate-errors", "--remote-debugging-port=0"], ignoreHTTPSErrors: true,
  }).catch((error) => { rmSync(profile, { recursive: true, force: true }); throw error; });
  t.after(async () => {
    try { await context.close(); }
    finally { rmSync(profile, { recursive: true, force: true }); }
  });
  console.log(`R49-S09 browser ${context.browser().version()}`);
  return context.browser();
}

async function ready(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.waitForFunction(() => window.PomodoroughAppTest?.state?.ready
        && !PomodoroughAppTest.state.bootstrapBlocked);
      await page.evaluate(() => navigator.serviceWorker.ready);
      await page.waitForFunction(() => !!navigator.serviceWorker.controller
        && PomodoroughAppTest.state.ready && !PomodoroughAppTest.state.bootstrapBlocked);
      return;
    } catch (error) {
      if (!error.message.includes("Execution context was destroyed") || attempt === 2) throw error;
    }
  }
}

async function openPage(browser, scenario) {
  const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height },
    serviceWorkers: "allow", bypassCSP: false, ignoreHTTPSErrors: true });
  try {
    await context.addCookies([
      { name: fixture.sessionCookie, value: fixture.sessionToken, httpOnly: true },
      { name: fixture.csrfCookie, value: fixture.csrfToken, httpOnly: false },
    ].map((cookie) => ({ ...cookie, url: `${fixture.url}/`, secure: true, sameSite: "Lax" })));
    await context.addInitScript(() => { window.PomodoroughAppTest = { disableAutoStart: false }; });
    const page = await context.newPage();
    const errors = [], deletions = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (request.method() === "DELETE" && new URL(request.url()).pathname === "/api/v1/account") {
        deletions.push(request.url());
      }
    });
    assert.equal((await page.goto(`${fixture.url}/app`)).status(), 200);
    await ready(page);
    // Keep background replication from changing this layout/interaction fixture's local timer and tasks.
    await page.route("**/api/v1/sync", (route) => route.abort("internetdisconnected"));
    await emulate(page, context, scenario);
    return { context, page, errors, deletions };
  } catch (error) { await context.close(); throw error; }
}

async function emulate(page, context, scenario) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: scenario.insets || ZERO_INSETS });
  if (scenario.fold) {
    const feature = { orientation: "vertical", offset: 470, maskLength: 20 };
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: scenario.width, height: scenario.height,
      screenWidth: scenario.width, screenHeight: scenario.height, deviceScaleFactor: 1, mobile: true,
      displayFeature: feature });
    await cdp.send("Emulation.setDisplayFeaturesOverride", { features: [feature] });
  }
  await page.evaluate((font) => { document.documentElement.style.fontSize = `${font}%`; }, scenario.font);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(({ width, height }) => innerWidth === width && innerHeight === height, scenario);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  // The CDP session owns these overrides. Keep it attached until its isolated context closes.
}

async function assertEnvironment(page, scenario) {
  const observed = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;visibility:hidden;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);width:env(viewport-segment-width 0 0,100vw);left:env(viewport-segment-left 0 0,0px)";
    document.body.append(probe);
    const style = getComputedStyle(probe);
    const result = { width: innerWidth, height: innerHeight,
      font: getComputedStyle(document.documentElement).fontSize,
      insets: Object.fromEntries(["top", "right", "bottom", "left"].map((side) =>
        [side, parseFloat(style.getPropertyValue(`padding-${side}`))])),
      fold: matchMedia("(horizontal-viewport-segments:2)").matches,
      segmentWidth: parseFloat(style.width), segmentLeft: parseFloat(style.left),
      serviceWorker: !!navigator.serviceWorker.controller };
    probe.remove();
    return result;
  });
  assert.equal(observed.width, scenario.width, "actual layout viewport width");
  assert.equal(observed.height, scenario.height, "actual layout viewport height");
  assert.equal(observed.font, `${scenario.font * 0.16}px`, "actual root text size");
  assert.deepEqual(observed.insets, scenario.insets || ZERO_INSETS, "actual CSS environment insets");
  assert.equal(observed.fold, !!scenario.fold, "actual segment media query");
  assert.equal(observed.segmentWidth, scenario.fold ? 470 : scenario.width, "indexed segment width");
  assert.equal(observed.segmentLeft, 0, "indexed first segment origin");
  assert.equal(observed.serviceWorker, true, "production service worker controls the page");
}

async function openDialog(page) {
  await page.locator("#deleteAccountButton").focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement.matches("dialog[open] input"));
  assert.equal(await page.locator("dialog[open] input").inputValue(), "", "reopening resets confirmation");
  assert.equal(await page.locator("dialog[open]").evaluate((dialog) => dialog.matches(":modal")), true);
}

async function readGeometry(page, scrollEach) {
  return page.evaluate((scrollEach) => {
    const dialog = document.querySelector("dialog[open]");
    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const rows = [dialog, ...dialog.querySelectorAll("*")].map((element) => {
      if (scrollEach) element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      const range = document.createRange();
      range.selectNodeContents(element);
      const text = ["H2", "P", "BUTTON"].includes(element.tagName)
        ? [...range.getClientRects()].map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })) : [];
      const box = rect(element);
      const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
      return { tag: element.tagName, box, dialog: rect(dialog), text,
        visible: element.checkVisibility(), clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
        hit: hit === element || element.contains(hit), scrollLeft: dialog.scrollLeft,
        clientHeight: element.clientHeight, scrollHeight: element.scrollHeight };
    });
    return { rows, documentWidth: document.documentElement.scrollWidth, scrollX };
  }, scrollEach);
}

function assertHorizontal(box, bounds, label, scenario) {
  assert.ok(box.left >= bounds.left - TOLERANCE && box.right <= bounds.right + TOLERANCE,
    `${label} [${box.left},${box.right}] outside [${bounds.left},${bounds.right}]`);
  if (scenario.fold) assert.ok(box.right <= 470 + TOLERANCE || box.left >= 490 - TOLERANCE,
    `${label} [${box.left},${box.right}] intersects hinge 470..490`);
}

function assertGeometry(observed, scenario, scrollEach) {
  const insets = scenario.insets || ZERO_INSETS;
  const safe = { left: insets.left, right: scenario.width - insets.right };
  assert.deepEqual(observed.rows.map((row) => row.tag), ["DIALOG", "H2", "P", "INPUT", "DIV", "BUTTON", "BUTTON"],
    "measure the dialog and every descendant, including text and action containers");
  assert.ok(observed.documentWidth <= scenario.width + 1, "no document horizontal overflow");
  assert.equal(observed.scrollX, 0, "no horizontal document pan");
  for (const row of observed.rows) {
    const label = `${scenario.name} ${scrollEach ? "scrolled" : "initial"} ${row.tag}`;
    assert.ok(row.visible && row.box.width > 0 && row.box.height > 0, `${label} has rendered bounds`);
    assertHorizontal(row.box, safe, `${label} safe bounds`, scenario);
    assertHorizontal(row.box, row.dialog, `${label} dialog containment`, scenario);
    assert.ok(row.scrollWidth <= row.clientWidth + 1, `${label} horizontal overflow ${row.scrollWidth}/${row.clientWidth}`);
    assert.equal(row.scrollLeft, 0, `${label} needs no horizontal dialog pan`);
    if (["H2", "P", "BUTTON"].includes(row.tag)) assert.ok(row.text.length > 0, `${label} renders text`);
    for (const text of row.text) {
      assertHorizontal(text, safe, `${label} text safe bounds`, scenario);
      assertHorizontal(text, row.box, `${label} text containment`, scenario);
    }
    if (scrollEach || row.tag === "DIALOG") {
      assert.ok(row.box.top >= insets.top - TOLERANCE
        && row.box.bottom <= scenario.height - insets.bottom + TOLERANCE, `${label} vertical safe bounds`);
      assert.ok(row.box.top >= row.dialog.top - TOLERANCE
        && row.box.bottom <= row.dialog.bottom + TOLERANCE, `${label} vertically reachable inside dialog`);
      if (scrollEach && ["INPUT", "BUTTON"].includes(row.tag)) assert.ok(row.hit, `${label} center hit test`);
    }
  }
}

async function activeFocus(page) {
  return page.evaluate(() => ({ tag: document.activeElement.tagName, id: document.activeElement.id,
    text: document.activeElement.textContent.trim(), inside: !!document.activeElement.closest("dialog[open]"),
    outline: getComputedStyle(document.activeElement).outlineStyle,
    outlineWidth: parseFloat(getComputedStyle(document.activeElement).outlineWidth) }));
}

async function assertTabCycle(page, key) {
  await page.locator("dialog[open] input").focus();
  const seen = [];
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press(key);
    const active = await activeFocus(page);
    // Chromium can expose BODY at the native modal cycle boundary, but never a background control.
    assert.ok(active.inside || active.tag === "BODY", `${key} escaped the modal to ${active.id}`);
    seen.push(active);
  }
  for (const text of ["Confirm", "Cancel"]) {
    assert.ok(seen.some((active) => active.inside && active.text === text), `${key} reaches ${text}`);
  }
}

async function assertClosed(page, label) {
  await page.waitForFunction(() => !document.querySelector("dialog[open]"));
  assert.equal((await activeFocus(page)).id, "deleteAccountButton", `${label} restores focus to its opener`);
  assert.equal(await page.locator("#deleteAccountButton").isEnabled(), true, `${label} keeps the opener enabled`);
}

async function assertInteractions(page) {
  await assertTabCycle(page, "Tab");
  await assertTabCycle(page, "Shift+Tab");
  await page.locator("dialog[open] input").focus();
  await page.keyboard.press("Tab");
  assert.equal((await activeFocus(page)).text, "Confirm", "input precedes Confirm");
  await page.keyboard.press("Tab");
  const cancel = await activeFocus(page);
  assert.equal(cancel.text, "Cancel", "Confirm precedes Cancel");
  assert.equal(cancel.inside, true);
  assert.notEqual(cancel.outline, "none", "keyboard Cancel has a visible focus outline");
  assert.ok(cancel.outlineWidth >= 2, "keyboard Cancel outline remains visible");
  await page.keyboard.press("Enter");
  await assertClosed(page, "keyboard Cancel");
  await openDialog(page);
  await page.locator("dialog[open] input").fill("DELETE");
  await page.keyboard.press("Escape");
  await assertClosed(page, "Escape with a valid confirmation");
  await openDialog(page);
  await page.locator("dialog[open]").getByRole("button", { name: "Cancel", exact: true }).click();
  await assertClosed(page, "pointer Cancel");
  await openDialog(page);
  await page.keyboard.type("not DELETE");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await assertClosed(page, "invalid Confirm");
  assert.match(await page.locator("#noticeText").textContent(), /Type DELETE exactly/);
}

async function timerKey(page, selector, key, status) {
  assert.equal(await page.locator(selector).isEnabled(), true, `${selector} remains enabled`);
  await page.locator(selector).focus();
  await page.keyboard.press(key);
  await page.waitForFunction((status) => PomodoroughAppTest.state.timer.status === status, status);
}

async function assertNormalControls(page, scenario) {
  await timerKey(page, "#timerToggle", "Enter", "running");
  await timerKey(page, "#timerToggle", "Space", "paused");
  await timerKey(page, "#timerToggle", "Space", "running");
  await timerKey(page, "#finishButton", "Enter", "completed");
  await timerKey(page, "#timerToggle", "Enter", "running");
  await timerKey(page, "#cancelButton", "Enter", "idle");
  await page.locator("#tasksTab").focus();
  await page.keyboard.press("Enter");
  const title = `R49-S09 keyboard task ${scenario.name}`;
  await page.locator("#taskInput").fill(title);
  await page.locator("#taskForm button").focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction((title) => PomodoroughAppTest.state.tasks.some((task) => task.title === title), title);
  console.log(`${scenario.name}: timer Start/Pause/Resume/Finish/Start/Cancel and keyboard task creation pass`);
}

async function checkScenario(browser, scenario) {
  const { context, page, errors, deletions } = await openPage(browser, scenario);
  try {
    await assertEnvironment(page, scenario);
    await openDialog(page);
    const initial = await readGeometry(page, false);
    console.log(JSON.stringify({ scenario: scenario.name, dialog: initial.rows[0], input: initial.rows[3] }));
    assertGeometry(initial, scenario, false);
    const scrolled = await readGeometry(page, true);
    assertGeometry(scrolled, scenario, true);
    if (scenario.insets) {
      assert.ok(scrolled.rows[0].scrollHeight > scrolled.rows[0].clientHeight,
        "the enlarged inset case exercises native vertical scrolling");
    }
    await assertInteractions(page);
    if (!scenario.fold) await assertNormalControls(page, scenario);
    assert.deepEqual(deletions, [], "Cancel, Escape and invalid confirmation send no account DELETE");
    assert.deepEqual(errors, [], "no browser page errors");
  } finally { await context.close(); }
}

test("R49-S09 rendered deletion dialog safe bounds and native modal behavior", { timeout: 180_000 }, async (t) => {
  const browser = await launchBrowser(t);
  for (const scenario of SCENARIOS) {
    await t.test(scenario.name, async () => checkScenario(browser, scenario));
  }
});
