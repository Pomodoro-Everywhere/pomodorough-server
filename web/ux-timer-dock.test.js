"use strict";

// UX round 2 (A3, PWA-01): while the countdown or the Start/Pause/Resume
// control is scrolled out of view on the Timer screen, a dock at the bottom
// edge mirrors both, so the primary control is always reachable.
// B2: the dock waits unseen while the strip at the bottom edge still holds the
// screen tabs, and the notice stack follows the Tasks heading instead of
// covering it.

const test = require("node:test");
const assert = require("node:assert/strict");
const { viewFixture, waitFor, spy } = require("./test/ux-view-fixture.js");

// Stands in for the browser's IntersectionObserver: tests report geometry.
function geometryReports() {
  const observers = [];
  class IntersectionObserver {
    constructor(callback, options) {
      Object.assign(this, { callback, options, targets: new Set() });
      observers.push(this);
    }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
  }
  const report = (target, intersectionRatio) => {
    for (const observer of observers) {
      if (observer.targets.has(target)) observer.callback([{ target, intersectionRatio }]);
    }
  };
  return { IntersectionObserver, observers, report };
}

async function timerScreen(t, { geometry = geometryReports(), ResizeObserver = null } = {}) {
  const current = await viewFixture(t);
  if (geometry) current.host.IntersectionObserver = geometry.IntersectionObserver;
  if (ResizeObserver) current.host.ResizeObserver = ResizeObserver;
  current.use.primeCompletionAlerts ??= () => {};
  current.use.stopCompletionAlert ??= () => {};
  current.commands = spy(current.use, "issueCommand", []);
  current.view.setupTimerEvents();
  current.showScreen = (name) => current.view.activateScreen(
    current.elements.screenButtons.find((button) => button.dataset.screenButton === name));
  current.showScreen("timer");
  return { ...current, geometry };
}

function onScreen(current, toggleRatio, displayRatio = 1) {
  current.geometry.report(current.elements.timerToggle, toggleRatio);
  current.geometry.report(current.elements.timerDisplay, displayRatio);
}

test("the dock stays hidden while the countdown and the primary control are on screen", async (t) => {
  const current = await timerScreen(t);
  const [observer] = current.geometry.observers;
  assert.deepEqual([...observer.targets], [current.elements.timerToggle, current.elements.timerDisplay]);
  assert.equal(current.elements.timerDock.hidden, true);
  onScreen(current, 1, 1);
  assert.equal(current.elements.timerDock.hidden, true);
});

for (const [name, toggleRatio, displayRatio] of [["primary control", 0, 1], ["countdown", 1, 0.4]]) {
  test(`the dock shows the countdown and the primary control while the ${name} is off screen`, async (t) => {
    const current = await timerScreen(t);
    onScreen(current, toggleRatio, displayRatio);
    const { timerDock, timerDockToggle, timerDockDisplay, timerToggle, timerDisplay } = current.elements;
    assert.equal(timerDock.hidden, false);
    assert.equal(timerDockToggle.textContent, timerToggle.textContent);
    assert.equal(timerDockToggle.textContent, "Start focus");
    assert.equal(timerDockDisplay.textContent, timerDisplay.textContent);
    assert.match(timerDockDisplay.textContent, /^\d\d:\d\d$/);
    assert.equal(timerDock.getAttribute("role"), "group");
    onScreen(current, 1, 1);
    assert.equal(timerDock.hidden, true);
  });
}

test("the dock control issues the same command as the primary control and follows the timer", async (t) => {
  const current = await timerScreen(t);
  onScreen(current, 0);
  const { timerDockToggle, timerToggle } = current.elements;
  timerDockToggle.click();
  assert.deepEqual(current.commands.map((call) => call.args), [["start"]]);
  assert.equal(await current.commands[0].result, true);
  current.view.render();
  assert.equal(timerToggle.textContent, "Pause");
  assert.equal(timerDockToggle.textContent, "Pause");
  timerDockToggle.click();
  assert.deepEqual(current.commands.map((call) => call.args), [["start"], ["pause"]]);
  assert.equal(await current.commands[1].result, true);
  current.view.render();
  assert.equal(timerDockToggle.textContent, "Resume");
  assert.equal(timerDockToggle.disabled, timerToggle.disabled);
});

test("the dock is a Timer screen control: Tasks hides it and Timer measures again", async (t) => {
  const current = await timerScreen(t);
  onScreen(current, 0);
  current.showScreen("tasks");
  assert.equal(current.elements.timerDock.hidden, true);
  current.showScreen("timer");
  assert.equal(current.elements.timerDock.hidden, true, "no geometry yet for the screen that just returned");
  onScreen(current, 0);
  assert.equal(current.elements.timerDock.hidden, false);
  assert.equal(current.geometry.observers.length, 1, "one observer serves every screen change");
});

test("focus moves to the primary control when the dock leaves", async (t) => {
  const current = await timerScreen(t);
  onScreen(current, 0);
  current.elements.timerDockToggle.focus();
  assert.equal(current.document.activeElement, current.elements.timerDockToggle);
  onScreen(current, 1);
  assert.equal(current.document.activeElement, current.elements.timerToggle);
});

test("without geometry reports the dock stays up on the Timer screen", async (t) => {
  const current = await timerScreen(t, { geometry: null });
  assert.equal(current.elements.timerDock.hidden, false);
  assert.equal(current.elements.timerDockToggle.textContent, current.elements.timerToggle.textContent);
  current.showScreen("tasks");
  assert.equal(current.elements.timerDock.hidden, true);
});

// Places the Timer panel and sizes the dock as a browser layout would.
function layOut(current, { panelTop, dockHeight = 64, viewportHeight = 375 }) {
  Object.defineProperty(current.document.documentElement, "clientHeight", { configurable: true, value: viewportHeight });
  current.elements.timerScreen.getBoundingClientRect = () => ({ top: panelTop });
  current.elements.timerDock.getBoundingClientRect = () => ({ height: dockHeight });
  current.window.dispatchEvent(new current.window.Event("scroll"));
}

test("the dock waits unseen until the Timer panel reaches its place at the bottom edge", async (t) => {
  const current = await timerScreen(t);
  const { timerDock } = current.elements;
  const root = current.document.documentElement;
  layOut(current, { panelTop: 330 });
  onScreen(current, 0);
  assert.equal(timerDock.hidden, false);
  assert.equal(timerDock.classList.contains("timer-dock-waiting"), true, "the screen tabs hold the bottom strip");
  assert.equal(root.style.scrollPaddingBottom, "", "a waiting dock reserves nothing");
  layOut(current, { panelTop: 311 });
  assert.equal(timerDock.classList.contains("timer-dock-waiting"), false, "the panel reached the dock's place");
  assert.equal(root.style.scrollPaddingBottom, "64px");
  layOut(current, { panelTop: 312 });
  assert.equal(timerDock.classList.contains("timer-dock-waiting"), true);
  assert.equal(root.style.scrollPaddingBottom, "");
  layOut(current, { panelTop: -400 });
  onScreen(current, 1);
  assert.equal(timerDock.hidden, true);
  assert.equal(root.style.scrollPaddingBottom, "", "a hidden dock reserves nothing");
});

test("focus moves to the primary control when the dock starts to wait", async (t) => {
  const current = await timerScreen(t);
  layOut(current, { panelTop: 100 });
  onScreen(current, 0);
  current.elements.timerDockToggle.focus();
  layOut(current, { panelTop: 330 });
  assert.equal(current.document.activeElement, current.elements.timerToggle);
});

test("a resize measures the dock's room again", async (t) => {
  const current = await timerScreen(t);
  layOut(current, { panelTop: 330 });
  onScreen(current, 0);
  assert.equal(current.elements.timerDock.classList.contains("timer-dock-waiting"), true);
  Object.defineProperty(current.document.documentElement, "clientHeight", { configurable: true, value: 800 });
  current.window.dispatchEvent(new current.window.Event("resize"));
  assert.equal(current.elements.timerDock.classList.contains("timer-dock-waiting"), false);
});

test("the notice stack follows the Tasks heading and leads the Timer panel", async (t) => {
  const current = await timerScreen(t);
  const { noticeStack, tasksScreen, timerScreen: panel } = current.elements;
  assert.equal(noticeStack.nextElementSibling, panel);
  current.showScreen("tasks");
  assert.equal(noticeStack.previousElementSibling, tasksScreen.querySelector(".tasks-heading"));
  assert.equal(noticeStack.parentElement, tasksScreen);
  current.showScreen("timer");
  assert.equal(noticeStack.nextElementSibling, panel);
  assert.equal(tasksScreen.contains(noticeStack), false);
});

// Sizes the dock at the bottom edge and the viewport, then reports a resize,
// which measures the dock's height at the bottom edge again.
function resizeDock(current, { dockHeight, viewportHeight = 375, panelTop = -400 }) {
  layOut(current, { panelTop, dockHeight, viewportHeight });
  current.window.dispatchEvent(new current.window.Event("resize"));
}

function dockPlace(current) {
  const { timerDock, timerScreen: panel } = current.elements;
  return {
    inline: timerDock.classList.contains("timer-dock-inline"),
    last: timerDock.parentElement.lastElementChild === timerDock,
    inPanel: panel.contains(timerDock),
    hidden: timerDock.hidden,
    reserve: current.document.documentElement.style.scrollPaddingBottom,
  };
}

test("a dock taller than a third of the viewport sits inline at the end of the Timer content", async (t) => {
  const current = await timerScreen(t);
  onScreen(current, 0);
  resizeDock(current, { dockHeight: 126 });
  assert.deepEqual(dockPlace(current), { inline: true, last: true, inPanel: true, hidden: false, reserve: "" });
  onScreen(current, 1, 1);
  assert.equal(current.elements.timerDock.hidden, false, "an inline dock stays in the page flow");
  resizeDock(current, { dockHeight: 126, viewportHeight: 800 });
  assert.deepEqual(dockPlace(current), { inline: false, last: true, inPanel: false, hidden: true, reserve: "" });
  assert.equal(current.elements.timerDock.parentElement, current.document.body);
});

test("a dock of exactly a third of the viewport stays at the bottom edge", async (t) => {
  const current = await timerScreen(t);
  onScreen(current, 0);
  resizeDock(current, { dockHeight: 125 });
  assert.deepEqual(dockPlace(current), { inline: false, last: true, inPanel: false, hidden: false, reserve: "125px" });
});

test("the dock's inline height never moves it back to the bottom edge", async (t) => {
  const current = await timerScreen(t);
  onScreen(current, 0);
  resizeDock(current, { dockHeight: 126 });
  // Inline, the dock is narrower and shorter; a scroll must not read that height.
  current.elements.timerDock.getBoundingClientRect = () => ({ height: 40 });
  for (let render = 0; render < 3; render += 1) {
    current.window.dispatchEvent(new current.window.Event("scroll"));
    assert.equal(dockPlace(current).inline, true, `render ${render}`);
  }
});

test("the dock measures its height at the bottom edge while it sits inline", async (t) => {
  const current = await timerScreen(t);
  onScreen(current, 0);
  resizeDock(current, { dockHeight: 126 });
  const { timerDock } = current.elements;
  const placesMeasured = [];
  timerDock.getBoundingClientRect = () => {
    placesMeasured.push(timerDock.classList.contains("timer-dock-inline") ? "inline" : "edge");
    return { height: placesMeasured.at(-1) === "edge" ? 126 : 40 };
  };
  current.window.dispatchEvent(new current.window.Event("resize"));
  assert.deepEqual(placesMeasured, ["edge"]);
  assert.equal(dockPlace(current).inline, true);
});

test("focus stays on the dock control when the dock moves inline", async (t) => {
  const current = await timerScreen(t);
  onScreen(current, 0);
  current.elements.timerDockToggle.focus();
  resizeDock(current, { dockHeight: 126 });
  assert.equal(dockPlace(current).inline, true);
  assert.equal(current.document.activeElement, current.elements.timerDockToggle);
});

test("the Tasks screen hides an inline dock and returns it to the bottom edge", async (t) => {
  const current = await timerScreen(t);
  onScreen(current, 0);
  resizeDock(current, { dockHeight: 126 });
  current.showScreen("tasks");
  assert.deepEqual(dockPlace(current), { inline: false, last: true, inPanel: false, hidden: true, reserve: "" });
});

test("a new size of the inline dock measures it at the bottom edge again", async (t) => {
  const resized = [];
  const current = await timerScreen(t, { ResizeObserver: class {
    constructor(callback) { resized.push(callback); }
    observe() {}
  } });
  assert.equal(resized.length, 1, "the dock's size is observed");
  onScreen(current, 0);
  resizeDock(current, { dockHeight: 126 });
  assert.equal(dockPlace(current).inline, true);
  current.elements.timerDock.getBoundingClientRect = () => ({ height: 100 });
  for (const callback of resized) callback([]);
  assert.equal(dockPlace(current).inline, false, "the smaller text fits at the bottom edge again");
});
