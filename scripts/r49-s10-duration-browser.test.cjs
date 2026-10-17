"use strict";

// R49-S10 tablet duration reflow regression.
// Guards readable duration numbers at 768px and 920px with 200% text.
// Baseline without the duration fieldset container fix squeezes each numeric
// input to 14.375px with native scrollWidth overflow and unit overlap while
// the document still fits its viewport. Document width alone misses that
// failure, so this test asserts the numbers themselves.
const assert = require("node:assert/strict");
const { readFileSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { chromium } = require(process.env.POMODOROUGH_PLAYWRIGHT_MODULE || "playwright");
const fixture = JSON.parse(readFileSync(0, "utf8"));

const IDS = ["focusDuration", "shortBreakDuration", "longBreakDuration"];
const VALUES = [1, 5, 15, 25, 99, 100, 180];
const LONG_PHASE = "Lange Fokussierungsdauer zur Konzentrationserhaltung ohne Unterbrechung";
const LONG_RAIL = "Dienstmuster mit aussergewoehnlich langem lokalisiertem Titel";
const SCENARIOS = [
  { name: "768-100-normal", width: 768, height: 900, font: 100, long: false, controls: true },
  { name: "920-100-normal", width: 920, height: 900, font: 100, long: false, controls: true },
  { name: "768-200-normal", width: 768, height: 900, font: 200, long: false, controls: false },
  { name: "920-200-normal", width: 920, height: 900, font: 200, long: false, controls: false },
  { name: "768-200-long", width: 768, height: 900, font: 200, long: true, controls: false },
  { name: "920-200-long", width: 920, height: 900, font: 200, long: true, controls: false },
];

async function launchBrowser(t) {
  const profile = mkdtempSync(join(tmpdir(), "pomodorough-r49-s10-"));
  const context = await chromium.launchPersistentContext(profile, {
    headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ["--ignore-certificate-errors", "--remote-debugging-port=0"], ignoreHTTPSErrors: true,
  }).catch((error) => { rmSync(profile, { recursive: true, force: true }); throw error; });
  t.after(async () => {
    try { await context.close(); }
    finally { rmSync(profile, { recursive: true, force: true }); }
  });
  console.log(`R49-S10 browser ${context.browser().version()}`);
  return context.browser();
}

async function ready(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.waitForFunction(() => window.PomodoroughAppTest?.state?.ready
        && !PomodoroughAppTest.state.bootstrapBlocked, null, { timeout: 15_000 });
      await page.evaluate(() => navigator.serviceWorker.ready);
      await page.waitForFunction(() => !!navigator.serviceWorker.controller
        && PomodoroughAppTest.state.ready && !PomodoroughAppTest.state.bootstrapBlocked,
        null, { timeout: 15_000 });
      await page.evaluate(() => document.fonts.ready);
      return;
    } catch (error) {
      if (!error.message.includes("Execution context was destroyed") || attempt === 2) throw error;
    }
  }
}

async function stylesheetHash(context, page) {
  const cdp = await context.newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    const seen = [];
    cdp.on("CSS.styleSheetAdded", ({ header }) => seen.push(header));
    await cdp.send("CSS.enable");
    const header = seen.find((item) => /\/app\.css(?:\?|$)/.test(item.sourceURL));
    assert.ok(header, "production app.css loaded");
    const { text } = await cdp.send("CSS.getStyleSheetText", { styleSheetId: header.styleSheetId });
    if (process.env.R49_S10_DURATION_NEGATIVE === "duration-fix-removed") {
      const stripped = text.replace(/\/\* R49-S10: collapse duration fieldset[\s\S]*?(?=\/\* R49-S10: stack task board)/, "");
      assert.notEqual(stripped, text, "duration fieldset fix present to remove");
      assert.ok(stripped.includes("R49-S10: stack task board"), "task board fix retained");
      await cdp.send("CSS.setStyleSheetText", { styleSheetId: header.styleSheetId, text: stripped });
      return { sha: "removed", negative: true };
    }
    return { sha: require("node:crypto").createHash("sha256").update(text).digest("hex"), negative: false };
  } finally {
    try { await cdp.detach(); } catch {}
  }
}

async function openScenario(browser, scenario) {
  const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height },
    serviceWorkers: "allow", bypassCSP: false, ignoreHTTPSErrors: true });
  try {
    await context.addCookies([
      { name: fixture.sessionCookie, value: fixture.sessionToken, httpOnly: true },
      { name: fixture.csrfCookie, value: fixture.csrfToken, httpOnly: false },
    ].map((cookie) => ({ ...cookie, url: `${fixture.url}/`, secure: true, sameSite: "Lax" })));
    await context.addInitScript(() => { window.PomodoroughAppTest = { disableAutoStart: false }; });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    assert.equal((await page.goto(`${fixture.url}/app`)).status(), 200);
    await ready(page);
    await page.route("**/api/v1/sync", (route) => route.abort("internetdisconnected"));
    const style = await stylesheetHash(context, page);
    await page.evaluate((font) => { document.documentElement.style.fontSize = `${font}%`; }, scenario.font);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(120);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (scenario.long) await applyLongLabels(page);
    return { context, page, errors, style };
  } catch (error) { await context.close(); throw error; }
}

async function applyLongLabels(page) {
  await page.evaluate(({ phase, rail }) => {
    for (const node of document.querySelectorAll(".phase-button span:last-child")) node.textContent = phase;
    document.querySelector(".rail-heading strong").textContent = rail;
    document.querySelector(".rail-heading small").textContent = `${rail} ${rail}`;
    document.querySelector(".task-selector-row strong").textContent = "Ausgewaehlte Konzentrationsaufgabe fuer den naechsten Durchlauf";
    document.querySelector(".task-selector-row small").textContent = "Gilt fuer den laufenden Fokuszeitgeber und den nachfolgenden Zeitgeber.";
    document.querySelector(".auto-start-copy strong").textContent = "Erholungspausen automatisch nach abgeschlossener Konzentrationsphase starten";
  }, { phase: LONG_PHASE, rail: LONG_RAIL });
  await page.waitForTimeout(120);
}

async function assertEnvironment(page, scenario) {
  const observed = await page.evaluate(() => ({ width: innerWidth, height: innerHeight,
    font: getComputedStyle(document.documentElement).fontSize,
    worker: !!navigator.serviceWorker.controller }));
  assert.equal(observed.width, scenario.width, "actual layout viewport width");
  assert.equal(observed.height, scenario.height, "actual layout viewport height");
  assert.equal(observed.font, `${scenario.font * 0.16}px`, "actual root text size");
  assert.equal(observed.worker, true, "production service worker controls the page");
}

async function numericFrame(page) {
  return page.evaluate((ids) => {
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const canvas = document.createElement("canvas");
    const ink = canvas.getContext("2d");
    const inputs = ids.map((id) => {
      const el = document.getElementById(id);
      const style = getComputedStyle(el);
      ink.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const metrics = ink.measureText(el.value);
      const spacing = parseFloat(style.letterSpacing) || 0;
      const label = el.closest("label");
      const unit = label.querySelector(".minute-unit");
      return { id, name: el.name, value: el.value, rect: rect(el),
        clientWidth: el.clientWidth, scrollWidth: el.scrollWidth,
        contentWidth: el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        contentHeight: el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
        textWidth: metrics.width + spacing * el.value.length,
        glyphHeight: metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent,
        fontSize: style.fontSize, transform: style.transform, zoom: style.zoom,
        label: rect(label), unit: rect(unit), row: rect(el.closest(".duration-row")) };
    });
    const fieldset = document.querySelector(".recipe-rail fieldset");
    const columns = getComputedStyle(fieldset).gridTemplateColumns;
    const repeat = /repeat\((\d+),/.exec(columns);
    let tracks = 0;
    if (repeat) tracks = parseInt(repeat[1], 10);
    else if (columns.trim() !== "" && columns.trim() !== "none") {
      let depth = 0;
      tracks = 1;
      for (const ch of columns) {
        if (ch === "(") depth += 1;
        else if (ch === ")") depth -= 1;
        else if (ch === " " && depth === 0) tracks += 1;
      }
    }
    return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      rootFont: getComputedStyle(document.documentElement).fontSize,
      fieldsetColumns: columns, fieldsetTracks: tracks, inputs };
  }, IDS);
}

function assertNumericFrame(frame, label, enlarged) {
  assert.ok(frame.scrollWidth <= frame.width + 1, `${label}: document ${frame.scrollWidth} exceeds ${frame.width}`);
  for (const input of frame.inputs) {
    assert.ok(input.rect.width > 30, `${label} ${input.id}: squeezed to ${input.rect.width}px`);
    assert.ok(input.contentWidth + 0.5 >= input.textWidth,
      `${label} ${input.id}: value ${input.value} needs ${input.textWidth}, content ${input.contentWidth}`);
    assert.ok(input.clientWidth + 1 >= input.scrollWidth,
      `${label} ${input.id}: native scrollWidth ${input.scrollWidth} exceeds clientWidth ${input.clientWidth}`);
    assert.ok(input.contentHeight >= input.glyphHeight, `${label} ${input.id}: glyph height clipped`);
    assert.ok(input.rect.left >= -0.5 && input.rect.right <= frame.width + 0.5,
      `${label} ${input.id}: outside viewport`);
    assert.ok(input.rect.right <= input.unit.left + 0.5, `${label} ${input.id}: overlaps minute unit`);
    assert.equal(input.transform, "none", `${label} ${input.id}: scaled`);
    assert.equal(input.zoom, "1", `${label} ${input.id}: scaled`);
    const expected = parseFloat(frame.rootFont) * 0.95;
    assert.ok(Math.abs(parseFloat(input.fontSize) - expected) < 0.01,
      `${label} ${input.id}: input font shrank to ${input.fontSize}`);
  }
  assert.equal(frame.fieldsetTracks, enlarged ? 1 : 3, `${label}: fieldset columns ${frame.fieldsetColumns}`);
}

async function readControls(page) {
  return page.evaluate(() => {
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    return [...document.querySelectorAll("#durationForm button,#durationForm input,#durationForm select")]
      .filter((el) => el.checkVisibility()).map((el) => {
        el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
        const box = rect(el);
        const style = getComputedStyle(el);
        const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
        const texts = [];
        if (el.classList.contains("phase-button")) {
          for (const span of el.querySelectorAll("span:not(.visually-hidden)")) {
            const range = document.createRange();
            range.selectNodeContents(span);
            for (const r of range.getClientRects()) texts.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
          }
        }
        return { id: el.id || `${el.dataset.phase || el.dataset.for}:${el.dataset.step || "phase"}`,
          tag: el.tagName, className: el.className, disabled: el.disabled, rect: box,
          row: rect(el.closest(".duration-row") || el.parentElement), font: style.fontSize,
          hit: hit === el || el.contains(hit), texts, scrollX };
      });
  });
}

function assertControls(rows, width, label, enlarged) {
  assert.ok(rows.length >= 12, `${label}: expected duration controls, got ${rows.length}`);
  const root = enlarged ? 32 : 16;
  for (const item of rows) {
    assert.ok(item.rect.left >= -0.5 && item.rect.right <= width + 0.5,
      `${label} ${item.id}: control outside viewport`);
    assert.ok(item.rect.left + 0.5 >= item.row.left && item.rect.right - 0.5 <= item.row.right,
      `${label} ${item.id}: control outside row`);
    assert.equal(item.scrollX, 0, `${label} ${item.id}: page panned horizontally`);
    if (!item.disabled) assert.ok(item.hit, `${label} ${item.id}: control center occluded`);
    if (item.tag === "BUTTON") {
      const phase = item.className.includes("phase-button");
      const heightRem = width <= 640 && phase ? 3 : 3.25;
      assert.ok(item.rect.height + 0.5 >= heightRem * root, `${label} ${item.id}: target height shrank`);
      if (!phase) assert.ok(item.rect.width + 0.5 >= 2.75 * root, `${label} ${item.id}: target width shrank`);
      const fontRem = width <= 640 && phase ? 0.93 : 1.05;
      assert.ok(Math.abs(parseFloat(item.font) - fontRem * root) < 0.01,
        `${label} ${item.id}: button font shrank to ${item.font}`);
    }
    for (const text of item.texts) {
      assert.ok(text.left + 0.5 >= item.rect.left && text.right - 0.5 <= item.rect.right
        && text.top + 0.5 >= item.rect.top && text.bottom - 0.5 <= item.rect.bottom,
        `${label} ${item.id}: label text outside button`);
    }
  }
}

async function waitValue(page, id, value) {
  await page.waitForFunction(({ id, value }) => {
    const input = document.getElementById(id);
    return input.value === String(value) && PomodoroughAppTest.state.durationsMs[input.name] === value * 60000;
  }, { id, value }, { timeout: 15_000 });
  await page.waitForTimeout(100);
}

async function commitValue(page, id, value) {
  await page.locator(`#${id}`).fill(String(value));
  await page.locator(`#${id}`).press("Tab");
  await waitValue(page, id, value);
}

async function assertKeyboard(page, label) {
  await page.locator("#timerTab").focus();
  await page.waitForTimeout(900);
  const expected = await page.evaluate(() => [...document.querySelectorAll("#durationForm button,#durationForm input[type=number]")]
    .map((el) => el.id || `${el.dataset.phase || el.dataset.for}:${el.dataset.step || "phase"}`));
  const visited = [];
  for (let index = 0; index < 60; index += 1) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(900);
    const focus = await page.evaluate(() => {
      const el = document.activeElement;
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return { id: el.id || `${el.dataset.phase || el.dataset.for}:${el.dataset.step || "phase"}`,
        left: r.left, right: r.right, top: r.top, bottom: r.bottom,
        visible: el.matches(":focus-visible"), outline: style.outlineStyle,
        outlineWidth: style.outlineWidth, scrollX, width: innerWidth, height: innerHeight };
    });
    if (expected.includes(focus.id)) {
      visited.push(focus);
      assert.ok(focus.left >= -0.5 && focus.right <= focus.width + 0.5
        && focus.top >= -0.5 && focus.bottom <= focus.height + 0.5,
        `${label} keyboard ${focus.id}: focused control not in viewport`);
      assert.ok(focus.visible && focus.outline !== "none" && parseFloat(focus.outlineWidth) > 0,
        `${label} keyboard ${focus.id}: focus indicator absent`);
    }
    if (expected.every((id) => visited.some((item) => item.id === id))) break;
  }
  for (const id of expected) assert.ok(visited.some((item) => item.id === id), `${label}: Tab misses ${id}`);
  for (const id of IDS) {
    const input = page.locator(`#${id}`);
    await commitValue(page, id, 99);
    await input.focus();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Tab");
    await waitValue(page, id, 100);
    assert.equal(await input.inputValue(), "100", `${label} ${id}: ArrowUp missed 100`);
    await page.locator(`[data-for="${id}"][data-step="1"]`).focus();
    await page.keyboard.press("Enter");
    await waitValue(page, id, 101);
    assert.equal(await input.inputValue(), "101", `${label} ${id}: Enter plus missed 101`);
    await page.locator(`[data-for="${id}"][data-step="-1"]`).focus();
    await page.keyboard.press("Space");
    await waitValue(page, id, 100);
    assert.equal(await input.inputValue(), "100", `${label} ${id}: Space minus missed 100`);
  }
  console.log(`${label}: Tab reaches ${visited.length} duration controls, keyboard edits 99/100/101 pass`);
}

async function timerKey(page, selector, key, status) {
  assert.equal(await page.locator(selector).isEnabled(), true, `${selector} remains enabled`);
  await page.locator(selector).focus();
  await page.keyboard.press(key);
  await page.waitForFunction((status) => PomodoroughAppTest.state.timer.status === status, status,
    { timeout: 15_000 });
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
  const title = `R49-S10 keyboard task ${scenario.name}`;
  await page.locator("#taskInput").fill(title);
  await page.locator("#taskForm button").focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction((title) => PomodoroughAppTest.state.tasks.some((task) => task.title === title),
    title, { timeout: 15_000 });
  console.log(`${scenario.name}: timer Start/Pause/Resume/Finish/Start/Cancel and keyboard task creation pass`);
}

async function checkScenario(browser, scenario) {
  const { context, page, errors, style } = await openScenario(browser, scenario);
  try {
    await assertEnvironment(page, scenario);
    const enlarged = scenario.font === 200;
    const defaults = await numericFrame(page);
    assertNumericFrame(defaults, `${scenario.name} defaults`, enlarged);
    const controls = await readControls(page);
    assertControls(controls, scenario.width, scenario.name, enlarged);
    for (const value of VALUES) {
      for (const id of IDS) await commitValue(page, id, value);
      const frame = await numericFrame(page);
      for (const input of frame.inputs) assert.equal(input.value, String(value), `${scenario.name} ${input.id}`);
      assertNumericFrame(frame, `${scenario.name} value=${value}`, enlarged);
    }
    await assertKeyboard(page, scenario.name);
    const after = await numericFrame(page);
    assertNumericFrame(after, `${scenario.name} keyboard`, enlarged);
    if (scenario.controls) await assertNormalControls(page, scenario);
    console.log(JSON.stringify({ scenario: scenario.name, css: style.sha,
      fieldset: after.fieldsetColumns, document: `${after.scrollWidth}/${after.width}`,
      focus: after.inputs[0], short: after.inputs[1], long: after.inputs[2] }));
    assert.deepEqual(errors, [], "no browser page errors");
  } finally { await context.close(); }
}

test("R49-S10 tablet durations stay readable at 768px and 920px with 200% text",
  { timeout: 300_000 }, async (t) => {
    const browser = await launchBrowser(t);
    for (const scenario of SCENARIOS) {
      await t.test(scenario.name, async () => checkScenario(browser, scenario));
    }
  });
