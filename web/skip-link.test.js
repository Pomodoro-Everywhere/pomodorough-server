"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const viewModule = require("./app-view.js");

function fixture(t) {
  const dom = new JSDOM(fs.readFileSync(`${__dirname}/app.html`, "utf8"), {
    url: "https://pomodorough.test/app?source=skip", pretendToBeVisual: true
  });
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((el) => [el.id, el]));
  elements.screenButtons = [...document.querySelectorAll("[data-screen-button]")];
  const state = { activeScreen: "timer" };
  const view = viewModule.create({ state, external: { host: dom.window, elements }, use: {} });
  view.setupScreenNavigation();
  view.renderScreens();
  return { dom, document, elements, state, view, link: document.querySelector(".skip-link") };
}

function assertScreen(f, screen) {
  assert.equal(f.state.activeScreen, screen);
  for (const tab of f.elements.screenButtons) {
    const selected = tab.dataset.screenButton === screen;
    assert.equal(tab.getAttribute("aria-selected"), String(selected));
    assert.equal(tab.tabIndex, selected ? 0 : -1);
    const panel = f.document.getElementById(tab.getAttribute("aria-controls"));
    assert.equal(panel.hidden, !selected);
    assert.equal(panel.getAttribute("role"), "tabpanel");
    assert.ok(panel.getAttribute("aria-labelledby").split(" ").includes(tab.id));
  }
}

function activateLink(f, activation) {
  if (activation === "Enter") {
    // Browsers deliver Enter on a focused link as a click event. JSDOM has
    // no default key activation, so prove Enter stays unblocked, then send
    // the click the browser would produce.
    const keydown = new f.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    f.link.dispatchEvent(keydown);
    assert.equal(keydown.defaultPrevented, false, "Enter must keep native link activation");
  }
  f.link.click();
}

for (const screen of ["timer", "tasks"]) {
  for (const activation of ["click", "Enter"]) {
  test(`R43-S07 skip from ${screen} via ${activation} focuses visible timer and preserves native fragment navigation`, async (t) => {
    const f = fixture(t);
    for (let repeat = 0; repeat < 3; repeat += 1) {
      f.elements[`${screen}Tab`].click();
      assertScreen(f, screen);
      f.link.focus();
      assert.equal(f.document.activeElement, f.link);
      const navigation = f.dom.window.location.hash === f.link.hash ? Promise.resolve()
        : new Promise((resolve) => f.dom.window.addEventListener("hashchange", resolve, { once: true }));
      activateLink(f, activation);
      const target = f.document.getElementById(f.link.hash.slice(1));
      assert.equal(f.document.activeElement, target, "focus must leave link for actual destination");
      assert.equal(target.closest("[hidden], [inert]"), null);
      assert.equal(target.tabIndex, -1);
      assert.equal(target.getAttribute("aria-labelledby"), "workbench-title");
      assert.equal(f.link.getAttribute("data-i18n"), "nav.skipTimer");
      assertScreen(f, "timer");
      await navigation;
      assert.equal(f.dom.window.location.hash, "#timer-workbench");
      assert.equal(f.dom.window.location.search, "?source=skip");
    }
  });
  }
}

test("R43-S07 skip preserves arrow, Home, End and click tab navigation after repeated focus transfers", (t) => {
  const f = fixture(t);
  for (const [key, screen] of [["End", "tasks"], ["Home", "timer"], ["ArrowRight", "tasks"], ["ArrowLeft", "tasks"]]) {
    f.elements.timerTab.focus();
    f.elements.timerTab.dispatchEvent(new f.dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    assertScreen(f, screen);
    assert.equal(f.document.activeElement, f.elements[`${screen}Tab`]);
    f.link.focus();
    f.link.click();
    assertScreen(f, "timer");
    assert.equal(f.document.activeElement, f.elements["timer-workbench"]);
    f.view.renderScreens();
    assert.equal(f.document.activeElement, f.elements["timer-workbench"]);
  }
  f.elements.tasksTab.click();
  assertScreen(f, "tasks");
  assert.equal(f.document.activeElement, f.elements.tasksTab);
});
