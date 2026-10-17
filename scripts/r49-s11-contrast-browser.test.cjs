"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { inflateSync } = require("node:zlib");
const test = require("node:test");
const { chromium } = require(process.env.POMODOROUGH_PLAYWRIGHT_MODULE || "playwright");
const fixture = JSON.parse(readFileSync(0, "utf8"));

const SCENARIOS = [
  { name: "1440-default", width: 1440, height: 900, font: 100, scale: 1 },
  { name: "375-default", width: 375, height: 667, font: 100, scale: 1 },
  { name: "320-large-text", width: 320, height: 568, font: 200, scale: 1 },
  { name: "375-zoom200", width: 375, height: 667, font: 100, scale: 2 },
];

function axeFile() {
  if (process.env.POMODOROUGH_AXE_PATH) return process.env.POMODOROUGH_AXE_PATH;
  const mod = process.env.POMODOROUGH_PLAYWRIGHT_MODULE || "";
  if (mod.includes("server-browser-tools")) return path.join(path.dirname(mod), "axe-core", "axe.min.js");
  return path.join(path.dirname(require.resolve(mod)), "axe-core", "axe.min.js");
}

function luminance(rgb) {
  const linear = rgb.map((channel) => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function parseColor(text) {
  const hex = /#([0-9a-fA-F]{6})/.exec(text);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
  const match = /rgba?\(([^)]+)\)/.exec(text);
  assert.ok(match, `parse color ${text}`);
  return match[1].split(",").slice(0, 3).map((part) => Number.parseFloat(part));
}

function contrastRatio(foreground, background) {
  const high = Math.max(luminance(foreground), luminance(background));
  const low = Math.min(luminance(foreground), luminance(background));
  return (high + 0.05) / (low + 0.05);
}

function paeth(left, above, aboveLeft) {
  const score = left + above - aboveLeft;
  const candidates = [[left, Math.abs(score - left)], [above, Math.abs(score - above)],
    [aboveLeft, Math.abs(score - aboveLeft)]];
  candidates.sort((a, b) => a[1] - b[1]);
  return candidates[0][0];
}

function unfilterScanlines(raw, width, height, bytesPerPixel) {
  const stride = width * bytesPerPixel;
  const pixels = Buffer.alloc(width * height * bytesPerPixel);
  let previous = Buffer.alloc(stride, 0);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[offset];
    offset += 1;
    const current = Buffer.alloc(stride, 0);
    for (let i = 0; i < stride; i += 1) {
      const left = i >= bytesPerPixel ? current[i - bytesPerPixel] : 0;
      const above = previous[i];
      const aboveLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel] : 0;
      const rawByte = raw[offset + i];
      if (filter === 1) current[i] = (rawByte + left) & 255;
      else if (filter === 2) current[i] = (rawByte + above) & 255;
      else if (filter === 3) current[i] = (rawByte + ((left + above) >> 1)) & 255;
      else if (filter === 4) current[i] = (rawByte + paeth(left, above, aboveLeft)) & 255;
      else current[i] = rawByte;
    }
    current.copy(pixels, y * stride);
    previous = current;
    offset += stride;
  }
  return pixels;
}

function decodePng(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "PNG signature");
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const kind = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (kind === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, "8-bit PNG");
      colorType = data[9];
      assert.ok(colorType === 2 || colorType === 6, `RGB PNG, got ${colorType}`);
      assert.equal(data[12], 0, "non-interlaced PNG");
    } else if (kind === "IDAT") idat.push(data);
    else if (kind === "IEND") break;
    offset += 12 + length;
  }
  const bytesPerPixel = colorType === 2 ? 3 : 4;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = unfilterScanlines(raw, width, height, bytesPerPixel);
  return { width, height, pixels, bytesPerPixel };
}

function pngAt(png, factor, x, y) {
  const px = Math.min(png.width - 1, Math.max(0, Math.round(x * factor)));
  const py = Math.min(png.height - 1, Math.max(0, Math.round(y * factor)));
  const base = (py * png.width + px) * png.bytesPerPixel;
  return [png.pixels[base], png.pixels[base + 1], png.pixels[base + 2]];
}

async function ready(page) {
  await page.waitForFunction(() => window.PomodoroughAppTest?.state?.ready
    && !PomodoroughAppTest.state.bootstrapBlocked, null, { timeout: 15_000 });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15_000 });
}

async function openScenario(browser, scenario, theme) {
  const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height },
    colorScheme: theme, deviceScaleFactor: scenario.scale,
    serviceWorkers: "allow", bypassCSP: false, ignoreHTTPSErrors: true });
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
  if (scenario.font === 200) await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  await page.locator("#tasksTab").click();
  for (const title of ["R49 S11 contrast first", "R49 S11 contrast second", "R49 S11 contrast third"]) {
    await page.locator("#taskInput").fill(title);
    await page.locator("#taskForm button").click();
    await page.waitForFunction((wanted) => PomodoroughAppTest.state.tasks.some((task) => task.title === wanted), title);
  }
  await page.evaluate(() => document.fonts.ready);
  return { context, page, errors };
}

async function measureDelete(page) {
  return page.locator(".task-delete").first().evaluate((element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
    const points = [];
    for (const x of [0.1, 0.5, 0.9]) for (const y of [0.1, 0.5, 0.9]) {
      const hit = document.elementFromPoint(rect.left + rect.width * x, rect.top + rect.height * y);
      points.push(hit === element || element.contains(hit));
    }
    const ancestors = [];
    for (let node = element; node; node = node.parentElement) {
      const nodeStyle = getComputedStyle(node);
      ancestors.push({ hidden: node.hidden, inert: node.inert, opacity: nodeStyle.opacity, visible: node.checkVisibility() });
    }
    return { rect, points, ancestors, visible: element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
      disabled: element.disabled, focused: element === document.activeElement, focusVisible: element.matches(":focus-visible"),
      hover: element.matches(":hover"), color: style.color, background: style.backgroundColor,
      border: style.borderTopColor, outline: style.outlineColor, outlineWidth: style.outlineWidth,
      outlineStyle: style.outlineStyle, font: style.fontSize, rootFont: getComputedStyle(document.documentElement).fontSize,
      textRects: [...range.getClientRects()].map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })),
      innerWidth: window.innerWidth, innerHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio,
      documentScrollWidth: document.documentElement.scrollWidth, taskCount: PomodoroughAppTest.state.tasks.length,
      serviceWorker: !!navigator.serviceWorker.controller, dark: matchMedia("(prefers-color-scheme: dark)").matches };
  });
}

async function axeDelete(page, name) {
  const loaded = await page.evaluate(() => !!window.axe);
  if (!loaded) await page.evaluate(readFileSync(axeFile(), "utf8"));
  const report = await page.evaluate(async () => window.axe.run({ include: [[".task-delete"]] },
    { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } }));
  const violations = report.violations.flatMap((entry) => entry.nodes.map((node) => node.target));
  const incomplete = report.incomplete.flatMap((entry) => entry.nodes.map((node) => node.target));
  const passes = report.passes.filter((entry) => entry.id === "color-contrast").flatMap((entry) => entry.nodes);
  return { name, version: report.testEngine.version, violations, incomplete, passes: passes.length };
}

function isTransparentBackground(background) {
  if (background === "transparent") return true;
  const match = /rgba?\(([^)]+)\)/.exec(background);
  if (!match) return false;
  const parts = match[1].split(",").map((part) => Number.parseFloat(part.trim()));
  return parts.length === 4 && parts[3] === 0;
}

function assertComputedContrast(measured, theme, state) {
  const label = `${theme} ${state}`;
  const pageBg = theme === "light" ? [220, 234, 241] : [13, 23, 34];
  const textBg = isTransparentBackground(measured.background) ? pageBg : parseColor(measured.background);
  const text = contrastRatio(parseColor(measured.color), textBg);
  assert.ok(text >= 4.5, `${label} text ${measured.color} on ${measured.background} = ${text.toFixed(2)} below 4.5`);
  const edge = Math.max(contrastRatio(parseColor(measured.background), parseColor(measured.border)),
    contrastRatio(parseColor(measured.border), parseColor(measured.background)));
  const borderPage = contrastRatio(parseColor(measured.border), pageBg);
  const fillPage = contrastRatio(parseColor(measured.background), pageBg);
  assert.ok(Math.max(edge, borderPage, fillPage) >= 3, `${label} edge below 3`);
  if (state === "focus") {
    const ring = contrastRatio(parseColor(measured.outline), pageBg);
    assert.ok(ring >= 3, `${label} focus ${measured.outline} = ${ring.toFixed(2)} below 3`);
  }
  return { text, edge: Math.max(edge, borderPage, fillPage) };
}

function assertPngContrast(png, measured, theme, state) {
  const factor = png.width / measured.innerWidth;
  assert.ok(Math.abs(png.height - measured.innerHeight * factor) <= 2, "screenshot scale matches layout");
  const middle = (measured.rect.top + measured.rect.bottom) / 2;
  const fill = pngAt(png, factor, measured.rect.left + 5, measured.rect.top + 5);
  const page = pngAt(png, factor, measured.rect.left - 8, middle);
  const border = pngAt(png, factor, measured.rect.left + 1, middle);
  assert.deepEqual(fill, [124, 29, 24], "opaque Delete fill preserved");
  const text = contrastRatio([247, 248, 242], fill);
  assert.ok(text >= 4.5, `PNG text ${text.toFixed(2)} below 4.5`);
  const edge = Math.max(contrastRatio(fill, page), contrastRatio(border, page));
  assert.ok(edge >= 3, `PNG edge ${edge.toFixed(2)} below 3`);
  if (state === "focus") {
    const ring = pngAt(png, factor, measured.rect.left - 4, middle);
    const ringContrast = contrastRatio(ring, page);
    assert.ok(ringContrast >= 3, `PNG focus ${ringContrast.toFixed(2)} below 3`);
  }
  return { text, edge };
}

async function captureState(page, theme, scenario, state) {
  await page.locator(".task-delete").first().evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const measured = await measureDelete(page);
  assert.ok(measured.visible && measured.points.every(Boolean), `${theme} ${scenario.name} ${state} hidden`);
  assert.ok(measured.rect.width > 0 && measured.rect.height > 0, `${theme} ${scenario.name} ${state} bounds`);
  assert.ok(measured.documentScrollWidth <= measured.innerWidth + 1, `${theme} ${scenario.name} overflow`);
  assert.ok(measured.textRects.length > 0, `${theme} ${scenario.name} ${state} text`);
  assert.ok(measured.serviceWorker, "service worker controls page");
  assert.equal(measured.dark, theme === "dark", "theme matches");
  if (state === "focus") {
    assert.ok(measured.focused && measured.focusVisible, "keyboard focus visible");
    assert.equal(measured.outlineStyle, "solid", "focus outline solid");
    assert.ok(Number.parseFloat(measured.outlineWidth) >= 3 - 0.01, `focus width ${measured.outlineWidth}`);
  }
  if (state === "disabled") assert.ok(measured.disabled, "disabled state");
  else assert.ok(!measured.disabled, "unexpected disabled");
  const png = decodePng(await page.screenshot({ type: "png" }));
  const computed = assertComputedContrast(measured, theme, state);
  const pixels = assertPngContrast(png, measured, theme, state);
  const axe = await axeDelete(page, `${theme}-${scenario.name}-${state}`);
  assert.deepEqual(axe.violations, [], `${theme} ${scenario.name} ${state} axe violations`);
  assert.deepEqual(axe.incomplete, [], `${theme} ${scenario.name} ${state} axe incomplete`);
  if (state !== "disabled") assert.equal(axe.passes, 3, "axe evaluates all three Delete labels");
  console.log(`${theme} ${scenario.name} ${state} text=${computed.text.toFixed(2)}/${pixels.text.toFixed(2)} edge=${computed.edge.toFixed(2)}/${pixels.edge.toFixed(2)} axe=${axe.version}`);
}

async function keyboardReachDelete(page) {
  await page.mouse.move(0, 0);
  await page.locator("#taskForm button").focus();
  await page.keyboard.press("Tab");
  assert.ok(await page.locator(".task-delete").first().evaluate((el) => el === document.activeElement), "Tab reaches Delete");
  await page.locator(".task-delete").first().evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
}

async function assertDeleteBehavior(page, theme, scenario) {
  await keyboardReachDelete(page);
  const seen = [];
  for (const key of ["Enter", "Space", "Enter"]) {
    const before = await page.evaluate(() => PomodoroughAppTest.state.tasks.length);
    const focusedTitle = await page.evaluate(() => document.activeElement.getAttribute("aria-label"));
    await page.keyboard.press(key);
    await page.waitForFunction((count) => PomodoroughAppTest.state.tasks.length === count - 1, before);
    await page.waitForFunction(() => document.activeElement.matches(".task-delete, #taskInput"));
    const after = await page.evaluate(() => ({ count: PomodoroughAppTest.state.tasks.length,
      focus: document.activeElement.className || document.activeElement.id,
      visible: document.activeElement.matches(":focus-visible"), label: document.activeElement.getAttribute("aria-label") }));
    assert.ok(after.visible, `${theme} ${scenario.name} focus kept after ${key}`);
    assert.ok(!after.label || after.label !== focusedTitle || after.count === 0, "deleted identity leaves focus");
    seen.push(after);
  }
  assert.equal(seen.at(-1).focus, "taskInput", "last deletion restores input focus");
  console.log(`${theme} ${scenario.name} keyboard deletes ${seen.map((entry) => entry.count).join("->")}`);
}

async function assertDisabledPreserved(page) {
  await page.locator("#tasksTab").focus();
  const measured = await measureDelete(page);
  assert.ok(measured.disabled && !measured.focused, "disabled Delete inert");
  const box = await page.locator(".task-delete").first().boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  assert.equal(await page.evaluate(() => PomodoroughAppTest.state.tasks.length), 3, "disabled click preserves tasks");
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press("Tab");
    const focusedDelete = await page.evaluate(() => document.activeElement.className === "task-delete");
    assert.ok(!focusedDelete, "disabled Delete never takes Tab focus");
  }
}

async function assertTimerControls(page, theme, scenario) {
  await page.evaluate(() => { PomodoroughAppTest.state.ready = true; PomodoroughAppTest.render(); });
  await page.locator("#timerTab").click();
  const toggle = page.locator("#timerToggle");
  await toggle.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => PomodoroughAppTest.state.timer.status === "running");
  await page.keyboard.press("Space");
  await page.waitForFunction(() => PomodoroughAppTest.state.timer.status === "paused");
  await toggle.focus();
  await page.keyboard.press("Space");
  await page.waitForFunction(() => PomodoroughAppTest.state.timer.status === "running");
  console.log(`${theme} ${scenario.name} disabled and timer controls pass`);
}

async function checkScenario(browser, scenario, theme) {
  const { context, page, errors } = await openScenario(browser, scenario, theme);
  try {
    const environment = await page.evaluate(() => ({ width: window.innerWidth, root: getComputedStyle(document.documentElement).fontSize,
      ratio: window.devicePixelRatio, worker: !!navigator.serviceWorker.controller }));
    assert.equal(environment.width, scenario.width, "layout viewport");
    assert.equal(environment.root, `${scenario.font * 0.16}px`, "root text size");
    assert.equal(environment.worker, true, "service worker");
    if (scenario.scale === 2) assert.equal(environment.ratio, 2, "native zoom device pixels");
    await page.locator(".task-delete").first().evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
    await page.evaluate(() => document.querySelector("#taskInput").blur());
    await page.mouse.move(0, 0);
    await captureState(page, theme, scenario, "enabled");
    await page.locator(".task-delete").first().hover();
    await captureState(page, theme, scenario, "hover");
    await keyboardReachDelete(page);
    await captureState(page, theme, scenario, "focus");
    await page.locator(".task-delete").first().hover();
    await page.mouse.down();
    await captureState(page, theme, scenario, "pressed");
    await page.mouse.move(0, 0);
    await page.mouse.up();
    await page.evaluate(() => { PomodoroughAppTest.state.ready = false; PomodoroughAppTest.render(); });
    await captureState(page, theme, scenario, "disabled");
    await assertDisabledPreserved(page);
    await assertTimerControls(page, theme, scenario);
    await page.locator("#tasksTab").click();
    await assertDeleteBehavior(page, theme, scenario);
    assert.deepEqual(errors, [], "no page errors");
  } finally { await context.close(); }
}

test("R49-S11 rendered Delete contrast keeps text, edge, and focus visible", { timeout: 240_000 }, async (t) => {
  const browser = await chromium.launch({ headless: true, args: ["--ignore-certificate-errors"],
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  t.after(() => browser.close());
  console.log(`R49-S11 browser ${browser.version()}`);
  for (const theme of ["light", "dark"]) {
    for (const scenario of SCENARIOS) {
      await t.test(`${theme} ${scenario.name}`, async () => checkScenario(browser, scenario, theme));
    }
  }
});
