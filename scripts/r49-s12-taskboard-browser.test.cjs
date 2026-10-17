"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const { chromium } = require(process.env.POMODOROUGH_PLAYWRIGHT_MODULE || "playwright");
const fixture = JSON.parse(readFileSync(0, "utf8"));

const WIDTHS = [768, 920, 921, 1024];
const LOCALES = ["en", "ar-XB"];
const FONTS = [100, 200];
const SEEDS = ["Release_Q" + "Q".repeat(112), "Normal task control",
  "مراجعة لوحة المهام الطويلة والتحقق ".repeat(4).trim()];
const SCENARIOS = WIDTHS.flatMap((width) => FONTS.flatMap((font) =>
  LOCALES.map((locale) => ({ name: `${locale} ${width}px ${font}%`, width, font, locale }))));

async function launchBrowser(t) {
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ["--ignore-certificate-errors", "--enable-automation"] });
  t.after(() => browser.close());
  console.log(`R49-S12 browser ${browser.version()}`);
  return browser;
}

async function ready(page) {
  await page.waitForFunction(() => window.PomodoroughAppTest?.state?.ready
    && PomodoroughAppTest.state.user && !PomodoroughAppTest.state.bootstrapBlocked
    && !PomodoroughAppTest.state.actionLocked && !PomodoroughAppTest.state.syncing,
  null, { timeout: 20000 });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
}

async function snapshot(page) {
  return page.evaluate(() => ({ tasks: structuredClone(PomodoroughAppTest.state.tasks),
    pending: structuredClone(PomodoroughAppTest.state.pendingTaskOperations),
    calls: structuredClone(window.__S12Calls || []),
    order: [...document.querySelectorAll(".task-row")].map((row) => row.dataset.taskId) }));
}

async function rawPending(page) {
  return page.evaluate(async () => {
    const open = () => new Promise((resolve, reject) => {
      const request = indexedDB.open("pomodorough");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const database = await open();
    try {
      const names = [...database.objectStoreNames];
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(names, "readonly");
        const result = {};
        for (const name of names) {
          const request = transaction.objectStore(name).getAll();
          request.onsuccess = () => { result[name] = request.result; };
        }
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error);
      });
    } finally { database.close(); }
  });
}

async function openScenario(browser, scenario) {
  const context = await browser.newContext({ viewport: { width: scenario.width, height: 900 },
    ignoreHTTPSErrors: true, bypassCSP: false, serviceWorkers: "allow", colorScheme: "light" });
  try {
    await context.addCookies([
      { name: fixture.sessionCookie, value: fixture.sessionToken, httpOnly: true },
      { name: fixture.csrfCookie, value: fixture.csrfToken, httpOnly: false },
    ].map((cookie) => ({ ...cookie, url: fixture.url, secure: true, sameSite: "Lax" })));
    await context.addInitScript(() => {
      window.PomodoroughAppTest = { disableAutoStart: false };
      window.__S12Calls = [];
      let actions;
      const wrap = (implementation, name) => (...args) => {
        window.__S12Calls.push({ name, args: structuredClone(args) });
        return implementation[name](...args);
      };
      Object.defineProperty(window, "PomodoroughAppActions", { configurable: true,
        get: () => actions,
        set: (value) => {
          actions = { ...value, create: (options) => {
            const implementation = value.create(options);
            return { ...implementation, addTask: wrap(implementation, "addTask"),
              deleteTask: wrap(implementation, "deleteTask") };
          } };
        } });
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    assert.equal((await page.goto(`${fixture.url}/app?locale=${scenario.locale}`)).status(), 200);
    await ready(page);
    await context.setOffline(true);
    await page.locator("#tasksTab").click();
    return { context, page, errors };
  } catch (error) { await context.close(); throw error; }
}

async function settleFont(page, scenario) {
  await page.evaluate((font) => { document.documentElement.style.fontSize = `${font}%`; }, scenario.font);
  await page.waitForFunction(({ width, font }) => innerWidth === width
    && parseFloat(getComputedStyle(document.documentElement).fontSize) === 16 * font / 100
    && document.querySelector(".task-delete").getBoundingClientRect().height >= 44 * font / 100 - 0.1,
  scenario);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function readGeometry(page) {
  return page.evaluate(() => {
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const range = document.createRange();
      range.selectNodeContents(element);
      return { id: element.id, className: element.className, tag: element.tagName,
        rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
          width: rect.width, height: rect.height },
        clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
        font: style.fontSize, zoom: style.zoom, transform: style.transform,
        columns: style.gridTemplateColumns, display: style.display,
        stat: element.getAttribute("data-stat-label"),
        before: getComputedStyle(element, "::before").content,
        glyphs: [...range.getClientRects()].map((item) => ({ left: item.left,
          right: item.right, top: item.top, bottom: item.bottom })) };
    };
    const main = document.querySelector("main");
    const style = getComputedStyle(main);
    const rect = main.getBoundingClientRect();
    return { width: innerWidth, document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth, font: getComputedStyle(document.documentElement).fontSize,
      lang: document.documentElement.lang, dir: document.documentElement.dir,
      main: { left: rect.left + parseFloat(style.paddingLeft), right: rect.right - parseFloat(style.paddingRight) },
      head: box(document.querySelector(".task-board-head")),
      items: [...document.querySelectorAll(".task-form, .task-form > div, #taskInput, .task-form button, .task-board, .task-row, .task-name, .task-stat, .task-delete")].map(box) };
  });
}

function assertGeometry(value, scenario) {
  assert.equal(value.document, scenario.width, `${scenario.name} no document overflow`);
  assert.ok(value.body <= scenario.width, `${scenario.name} no body overflow`);
  assert.equal(value.font, scenario.font === 200 ? "32px" : "16px", `${scenario.name} text enlargement`);
  assert.equal(value.lang, scenario.locale, `${scenario.name} locale catalog`);
  assert.equal(value.dir, scenario.locale === "ar-XB" ? "rtl" : "ltr", `${scenario.name} direction`);
  for (const item of value.items) {
    assert.ok(item.rect.left >= value.main.left - 1 && item.rect.right <= value.main.right + 1,
      `${scenario.name} main contains ${item.className || item.id}`);
    assert.ok(item.rect.width > 0 && item.rect.height > 0, `${scenario.name} rendered area`);
    assert.equal(item.zoom, "1", `${scenario.name} no zoom`);
    assert.equal(item.transform, "none", `${scenario.name} no transform`);
    if (item.tag !== "INPUT") assert.ok(item.scrollWidth <= item.clientWidth + 1,
      `${scenario.name} text fits ${item.className}`);
    for (const glyph of item.glyphs) {
      assert.ok(glyph.left >= item.rect.left - 1 && glyph.right <= item.rect.right + 1,
        `${scenario.name} visible glyphs fit ${item.className}`);
    }
  }
  const controls = value.items.filter((item) => item.tag === "INPUT" || item.tag === "BUTTON");
  for (const control of controls) assert.ok(control.rect.width >= 44 && control.rect.height >= 44,
    `${scenario.name} 44px target ${control.className || control.id}`);
  const deletes = value.items.filter((item) => item.className === "task-delete");
  assert.ok(deletes.length >= 3, `${scenario.name} populated deletes`);
  for (const item of deletes) assert.ok(item.rect.width > 0 && item.clientWidth > 0,
    `${scenario.name} nonzero Delete`);
  const rows = value.items.filter((item) => item.className === "task-row");
  for (const row of rows) assert.equal(row.columns.split(" ").length, scenario.font === 200 ? 2 : 4,
    `${scenario.name} board columns`);
  assert.equal(value.head.display, scenario.font === 200 ? "none" : "grid", `${scenario.name} header`);
}

async function assertHits(page, scenario) {
  const hits = await page.evaluate(() => [...document.querySelectorAll("#taskInput, .task-form button, .task-delete")]
    .map((element) => {
      element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return { task: element.closest(".task-row")?.dataset.taskId || null,
        hit: hit === element || element.contains(hit),
        struck: hit?.closest(".task-row")?.dataset.taskId || null,
        top: rect.top, bottom: rect.bottom, height: innerHeight, stopped: element.disabled };
    }));
  for (const item of hits) {
    assert.ok(item.hit && !item.stopped, `${scenario.name} center reaches control`);
    assert.equal(item.struck, item.task, `${scenario.name} hit keeps task identity`);
    assert.ok(item.top >= -1 && item.bottom <= item.height + 1, `${scenario.name} vertically visible`);
  }
}

async function addViaKeyboard(page, title) {
  const before = await snapshot(page);
  await page.locator("#taskInput").focus();
  await page.keyboard.insertText(title);
  await page.keyboard.press("Enter");
  await page.waitForFunction((title) => !PomodoroughAppTest.state.actionLocked
    && document.querySelector("#taskInput").value === ""
    && PomodoroughAppTest.state.tasks.some((task) => task.title === title), title);
  return before;
}

async function keyboardDelete(page, task, key, scenario) {
  const before = await snapshot(page);
  await page.locator(".task-form button").focus();
  await page.waitForTimeout(850);
  let focused = null;
  for (let count = 0; count < before.tasks.length + 1; count += 1) {
    await page.keyboard.press("Tab");
    focused = await page.evaluate(() => ({ task: document.activeElement.closest(".task-row")?.dataset.taskId,
      style: getComputedStyle(document.activeElement).outlineStyle,
      width: getComputedStyle(document.activeElement).outlineWidth }));
    if (focused.task === task.id) break;
  }
  assert.equal(focused.task, task.id, `${scenario.name} Tab reaches Delete`);
  assert.notEqual(focused.style, "none", `${scenario.name} visible focus`);
  assert.ok(parseFloat(focused.width) > 0, `${scenario.name} nonzero outline`);
  await page.waitForTimeout(850);
  const seen = await page.evaluate(() => {
    const element = document.activeElement;
    const rect = element.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, height: innerHeight,
      hit: document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === element };
  });
  assert.ok(seen.top >= -1 && seen.bottom <= seen.height + 1 && seen.hit, `${scenario.name} Delete visible`);
  await page.keyboard.press(key);
  await page.waitForFunction((id) => !PomodoroughAppTest.state.actionLocked
    && !PomodoroughAppTest.state.tasks.some((task) => task.id === id), task.id);
  return before;
}

async function checkKeyboard(page, scenario, core) {
  const unchanged = await snapshot(page);
  await page.locator("#tasksTab").focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.id), "taskInput", `${scenario.name} Tab to input`);
  await page.keyboard.insertText("Incorrect draft");
  await page.keyboard.press("Meta+A");
  const title = `Keyboard ${scenario.width} ${scenario.font} ${scenario.locale} ` + "Z".repeat(96);
  await page.keyboard.insertText(title);
  assert.equal(await page.locator("#taskInput").inputValue(), title, `${scenario.name} editable draft`);
  const edited = await snapshot(page);
  assert.deepEqual(edited.tasks, unchanged.tasks, `${scenario.name} draft keeps tasks`);
  assert.deepEqual(edited.pending, unchanged.pending, `${scenario.name} draft queues nothing`);
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.matches(".task-form button")), true,
    `${scenario.name} Tab to Add`);
  await page.keyboard.press("Enter");
  await page.waitForFunction((title) => !PomodoroughAppTest.state.actionLocked
    && document.querySelector("#taskInput").value === ""
    && PomodoroughAppTest.state.tasks.some((task) => task.title === title), title);
  const created = await snapshot(page);
  const task = created.tasks.find((item) => item.title === title);
  assert.equal(task.id, core.taskIdentity({ title }).id, `${scenario.name} Core identity`);
  assert.equal(created.calls.filter((call) => call.name === "addTask").length,
    unchanged.calls.filter((call) => call.name === "addTask").length + 1, `${scenario.name} one callback`);
  return { task, title, unchanged, created };
}

async function checkDelete(page, scenario, task) {
  const before = await keyboardDelete(page, task, scenario.font === 200 ? "Space" : "Enter", scenario);
  const after = await snapshot(page);
  const calls = after.calls.slice(before.calls.length);
  assert.deepEqual(calls, [{ name: "deleteTask", args: [task] }], `${scenario.name} callback gets task`);
  assert.deepEqual(after.tasks, before.tasks.filter((item) => item.id !== task.id), `${scenario.name} removes one`);
  const fresh = after.pending.filter((operation) => !before.pending.some((prior) => prior.id === operation.id));
  assert.equal(fresh.length, 1, `${scenario.name} one durable operation`);
  assert.equal(fresh[0].taskId, task.id, `${scenario.name} operation identity`);
  assert.equal(fresh[0].type, "delete", `${scenario.name} delete type`);
  const position = before.order.indexOf(task.id);
  const expected = before.order[position + 1] || before.order[position - 1] || null;
  const focus = await page.evaluate(() => ({ id: document.activeElement.id,
    task: document.activeElement.closest(".task-row")?.dataset.taskId || null }));
  assert.equal(focus.task, expected, `${scenario.name} focus successor`);
  if (!expected) assert.equal(focus.id, "taskInput", `${scenario.name} empty focus to input`);
}

async function checkDurable(page, scenario, title, task) {
  const remade = await addViaKeyboard(page, title);
  const current = await snapshot(page);
  const found = current.tasks.find((item) => item.title === title);
  assert.equal(found.id, task.id, `${scenario.name} recreation keeps UUID`);
  assert.equal(current.tasks.length, remade.tasks.length + 1, `${scenario.name} count grows once`);
  const durable = await rawPending(page);
  const ordered = (items) => [...items].sort((left, right) => left.id.localeCompare(right.id));
  assert.deepEqual(ordered(durable.pendingTasks), ordered(current.pending), `${scenario.name} raw queue equals state`);
  await page.reload();
  await ready(page);
  await page.locator("#tasksTab").click();
  const after = await snapshot(page);
  const kept = await rawPending(page);
  assert.deepEqual(after.tasks, current.tasks, `${scenario.name} tasks survive reload`);
  assert.deepEqual(ordered(kept.pendingTasks), ordered(durable.pendingTasks), `${scenario.name} queue survives`);
  await settleFont(page, scenario);
}

async function checkNormal(page, scenario) {
  await page.locator("#timerTab").click();
  await page.locator("#timerToggle").focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => PomodoroughAppTest.state.timer.status === "running");
  await page.keyboard.press("Space");
  await page.waitForFunction(() => PomodoroughAppTest.state.timer.status === "paused");
  await page.locator("#cancelButton").focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => PomodoroughAppTest.state.timer.status === "idle");
  await page.locator("#tasksTab").click();
  console.log(`${scenario.name} timer Start/Pause/Cancel pass`);
}

async function checkScenario(browser, scenario, core) {
  const { context, page, errors } = await openScenario(browser, scenario);
  try {
    for (const seed of SEEDS) await addViaKeyboard(page, seed);
    await settleFont(page, scenario);
    const initial = await readGeometry(page);
    assertGeometry(initial, scenario);
    await assertHits(page, scenario);
    const draft = await readGeometry(page);
    assertGeometry(draft, scenario);
    const { task, title } = await checkKeyboard(page, scenario, core);
    await page.evaluate(() => { PomodoroughApp.render(); PomodoroughApp.render(); });
    await checkDelete(page, scenario, task);
    await checkDurable(page, scenario, title, task);
    const final = await readGeometry(page);
    assertGeometry(final, scenario);
    await checkNormal(page, scenario);
    assert.deepEqual(errors, [], `${scenario.name} no page errors`);
    console.log(`CURRENT_PASS ${scenario.name} document=${initial.document}`);
  } finally { await context.close(); }
}

test("R49-S12 populated taskboard keeps Delete usable at 200% text", { timeout: 300_000 }, async (t) => {
  const { SharedCore } = require("../web/shared-core.js");
  const core = await SharedCore.fromBytes(readFileSync(require("node:path").join(__dirname, "../web/pomodorough_core.wasm")));
  const browser = await launchBrowser(t);
  for (const scenario of SCENARIOS) {
    await t.test(scenario.name, async () => checkScenario(browser, scenario, core));
  }
});
