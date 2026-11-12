"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { fixture } = require("./account-ownership-fixture.js");
const viewModule = require("../app-view.js");

const SELECTOR_GROUPS = Object.freeze({
  phaseButtons: ".phase-button", durationInputs: ".stepper input", stepButtons: "[data-step]",
  bootstrapChoiceButtons: "[data-bootstrap-strategy]", screenButtons: "[data-screen-button]"
});
const VIEW_RENDERERS = Object.freeze([
  "render", "renderTimer", "renderSyncStatus", "renderDurations", "renderTaskSelector", "renderBootstrapDialog"
]);

function pageElements(document) {
  const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
  for (const [name, selector] of Object.entries(SELECTOR_GROUPS)) elements[name] = [...document.querySelectorAll(selector)];
  return elements;
}

// jsdom reports "prerender" until told otherwise; override the prototype
// getter on this document so visibilitychange handlers see the requested state.
function setVisibility(document, visibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibilityState });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => visibilityState !== "visible" });
  document.dispatchEvent(new document.defaultView.Event("visibilitychange"));
}

async function settle(rounds = 6) {
  for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

// IndexedDB work in the fixture spans many macrotasks, so event-driven
// mutations are awaited by condition rather than by a fixed number of turns.
async function waitFor(check, label, rounds = 5000) {
  for (let round = 0; round < rounds; round += 1) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}

// The view refreshes the read model on every render, so a test that needs a
// different display status patches the refresh instead of the stored model.
function forceDisplayStatus(current, status) {
  const real = current.use.getWorkspaceReadModel;
  current.use.getWorkspaceReadModel = () => {
    const model = real();
    const patched = { ...model, display: { ...model.display, status } };
    current.state.readModel = patched;
    return patched;
  };
}

// Wraps a `use` action so tests can count calls and await the promise the
// production handler ignored.
function spy(use, name, log) {
  const original = use[name];
  use[name] = (...args) => {
    const result = original(...args);
    log.push({ name, args, result });
    return result;
  };
  return log;
}

// Gives one fixture app its own page: the real view on app.html, with the
// task and connectivity events wired.
function attachView(t, app) {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, "..", "app.html"), "utf8"), { url: "https://local.test/app" });
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const elements = pageElements(document);
  const host = app.external.host;
  Object.assign(host, { document, localStorage: dom.window.localStorage,
    addEventListener: dom.window.addEventListener.bind(dom.window) });
  app.external.elements = elements;
  const view = viewModule.create({ state: app.state, external: app.external, use: app.use });
  for (const name of VIEW_RENDERERS) app.use[name] = view[name];
  view.setupTaskEvents();
  view.setupConnectivityEvents();
  app.state.activeScreen = "tasks";
  view.render();
  return { dom, window: dom.window, document, elements, host, view,
    state: app.state, use: app.use, calls: app.calls, callbacks: app.callbacks };
}

async function viewFixture(t, timerStatus = null, { core: coreOverride = null } = {}) {
  const current = await fixture(t, timerStatus);
  const { stale } = current;
  if (coreOverride) stale.external.sharedCoreHost.SharedCore.load = async () => coreOverride;
  return { ...current, ...attachView(t, stale) };
}

// A second tab of the same browser profile: the same workspace database, the
// first tab's localStorage and, when the first tab has them, its Web Locks.
async function secondTab(t, current, tabId = "tab-second") {
  const app = await current.open("account-A", tabId);
  await app.use.reloadPersistedState();
  const tab = attachView(t, app);
  tab.host.localStorage = current.host.localStorage;
  tab.host.navigator = current.host.navigator;
  tab.view.render();
  return tab;
}

function taskRows(elements) {
  return [...elements.taskList.querySelectorAll(".task-row")];
}

function rowFor(elements, taskId) {
  return taskRows(elements).find((row) => row.dataset.taskId === taskId) || null;
}

module.exports = { viewFixture, secondTab, setVisibility, settle, waitFor, forceDisplayStatus, spy, taskRows, rowFor };
