"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require(process.env.POMODOROUGH_PLAYWRIGHT_MODULE || "playwright");
const fixture = JSON.parse(readFileSync(0, "utf8"));

function axeFile() {
  const mod = process.env.POMODOROUGH_PLAYWRIGHT_MODULE || "";
  if (process.env.POMODOROUGH_AXE_PATH) return process.env.POMODOROUGH_AXE_PATH;
  if (mod.includes("server-browser-tools")) return path.join(path.dirname(mod), "axe-core", "axe.min.js");
  return path.join(path.dirname(require.resolve(mod)), "axe-core", "axe.min.js");
}

function luminance(r, g, b) {
  const lin = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function parseColor(s) {
  const hex = /#([0-9a-fA-F]{6})/.exec(s);
  if (hex) {
    const v = hex[1];
    return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
  }
  const m = /rgba?\(([^)]+)\)/.exec(s);
  assert.ok(m, `parse color ${s}`);
  return m[1].split(",").slice(0, 3).map((v) => parseFloat(v.trim()));
}

function ratio(fg, bg) {
  const a = luminance(...fg);
  const b = luminance(...bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

async function openApp(browser, bypassCSP) {
  const context = await browser.newContext({ serviceWorkers: "allow",
    bypassCSP, ignoreHTTPSErrors: true });
  await context.addCookies([
    { name: fixture.sessionCookie, value: fixture.sessionToken, httpOnly: true },
    { name: fixture.csrfCookie, value: fixture.csrfToken, httpOnly: false },
  ].map((cookie) => ({ ...cookie, url: `${fixture.url}/`, secure: true, sameSite: "Lax" })));
  await context.addInitScript(() => { window.PomodoroughAppTest = { disableAutoStart: false }; });
  const page = await context.newPage();
  const response = await page.goto(`${fixture.url}/app`);
  assert.equal(response.status(), 200);
  await page.waitForFunction(() => window.PomodoroughAppTest?.state?.ready
    && !window.PomodoroughAppTest.state.bootstrapBlocked, null, { timeout: 15_000 });
  return { context, page };
}

async function footerFrame(page) {
  return page.evaluate(() => {
    const link = document.querySelector(".site-footer a");
    const footer = document.querySelector(".site-footer");
    const cs = (el, p) => getComputedStyle(el)[p];
    const rules = {};
    for (const sheet of document.styleSheets) {
      let list = null;
      try { list = sheet.cssRules; } catch { list = null; }
      if (!list) continue;
      for (const rule of list) {
        if (rule.selectorText && rule.selectorText.includes(".site-footer a:")) {
          rules[rule.selectorText] = rule.style.color;
        }
      }
    }
    return {
      href: link?.getAttribute("href"),
      name: link?.textContent?.trim(),
      tag: link?.tagName,
      tabIndex: link?.tabIndex,
      linkColor: cs(link, "color"),
      footerBg: cs(footer, "backgroundColor"),
      linkDecoration: cs(link, "textDecorationLine"),
      rules,
    };
  });
}

async function hoverColor(page) {
  await page.locator(".site-footer a").hover();
  await page.waitForTimeout(150);
  return page.evaluate(() => getComputedStyle(document.querySelector(".site-footer a")).color);
}

async function focusFrame(page) {
  await page.evaluate(() => document.querySelector(".site-footer a").focus());
  return page.evaluate(() => {
    const link = document.querySelector(".site-footer a");
    const st = getComputedStyle(link);
    return { active: document.activeElement === link, outlineStyle: st.outlineStyle,
      outlineWidth: st.outlineWidth, outlineColor: st.outlineColor, focusColor: st.color };
  });
}

test("R48-S10 footer contrast readable in both themes", { timeout: 180_000 }, async (t) => {
  const browser = await chromium.launch({ headless: true, args: ["--ignore-certificate-errors"],
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  t.after(() => browser.close());
  console.log(`Browser ${browser.version()}`);
  const { context, page } = await openApp(browser, false);
  t.after(() => context.close());
  console.log("enforced-CSP startup ready");
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.evaluate(() => document.activeElement?.blur());
    await page.mouse.move(5, 5);
    await page.waitForTimeout(300);
    const f = await footerFrame(page);
    assert.equal(f.tag, "A", `${scheme} footer anchor is link`);
    assert.match(f.name, /Privacy/, `${scheme} link correctly named`);
    assert.ok(f.tabIndex >= 0, `${scheme} link keyboard reachable`);
    assert.notEqual(f.linkDecoration, "none", `${scheme} non-color underline kept`);
    const bg = parseColor(f.footerBg);
    const unvisited = ratio(parseColor(f.linkColor), bg);
    assert.ok(unvisited >= 4.5, `${scheme} unvisited ${f.linkColor} = ${unvisited.toFixed(2)}`);
    const visitedSrc = Object.entries(f.rules).find(([k]) => k.includes(":visited"));
    assert.ok(visitedSrc, `${scheme} visited rule present`);
    const visited = ratio(parseColor(visitedSrc[1]), bg);
    assert.ok(visited >= 4.5, `${scheme} visited ${visitedSrc[1]} = ${visited.toFixed(2)}`);
    const hover = ratio(parseColor(await hoverColor(page)), bg);
    assert.ok(hover >= 4.5, `${scheme} hover = ${hover.toFixed(2)}`);
    const ff = await focusFrame(page);
    const focus = ratio(parseColor(ff.focusColor), bg);
    assert.ok(focus >= 4.5, `${scheme} focus ${ff.focusColor} = ${focus.toFixed(2)}`);
    console.log(`${scheme} ok unvisited=${unvisited.toFixed(2)} visited=${visited.toFixed(2)} hover=${hover.toFixed(2)} focus=${focus.toFixed(2)}`);
  }
  const kb = await page.getByRole("link", { name: "Privacy" }).count();
  assert.ok(kb >= 1, "Privacy link exposed to assistive tech");
  let reached = false;
  await page.evaluate(() => document.body.focus());
  for (let i = 0; i < 60; i += 1) {
    await page.keyboard.press("Tab");
    const active = await page.evaluate(() => document.activeElement?.textContent?.trim());
    if (active === "Privacy") { reached = true; break; }
  }
  assert.ok(reached, "Privacy link reachable by Tab");
  const fin = await focusFrame(page);
  assert.ok(fin.active, "footer link takes focus");
  assert.notEqual(fin.outlineStyle, "none", "focus indicator not removed");
  assert.ok(parseFloat(fin.outlineWidth) >= 2, `visible outline ${fin.outlineWidth}`);
  const bgFin = parseColor((await footerFrame(page)).footerBg);
  assert.ok(ratio(parseColor(fin.outlineColor), bgFin) >= 3, "outline non-text contrast >= 3");
  console.log(`keyboard ok focus=${fin.focusColor} outline=${fin.outlineColor} ${fin.outlineWidth}`);
  const axeSrc = readFileSync(axeFile(), "utf8");
  const axeOpen = await openApp(browser, true);
  t.after(() => axeOpen.context.close());
  await axeOpen.page.addScriptTag({ content: axeSrc });
  const violations = await axeOpen.page.evaluate(async () => {
    const r = await axe.run(document.querySelector(".site-footer"), { runOnly: ["color-contrast"] });
    return r.violations.flatMap((v) => v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })));
  });
  assert.deepEqual(violations, [], "axe footer color-contrast clean");
  console.log("axe footer color-contrast clean");
});
