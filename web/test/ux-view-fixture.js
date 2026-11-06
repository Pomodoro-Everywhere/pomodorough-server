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

// Wraps the real core so `core.version` advertises rename support and rename
// intents are captured instead of reaching the bundled core, so tests can
// inspect each request without changing stored tasks.
function renameCapableCore(core, requests) {
  const stub = {};
  for (let proto = core; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (typeof core[name] === "function" && !(name in stub)) stub[name] = core[name].bind(core);
    }
  }
  stub.call = (operation, input) => {
    if (operation === "core.version") return { coreVersion: "0.54.0", schemaVersion: 1 };
    if (operation === "workspace.intent.v1" && input.intent?.kind === "renameTask") {
      requests.push(input);
      return { outcome: "noop", reason: "unchangedOrIneligible" };
    }
    return core.call(operation, input);
  };
  return stub;
}

async function viewFixture(t, timerStatus = null, { core: coreOverride = null } = {}) {
  const current = await fixture(t, timerStatus);
  const { stale } = current;
  if (coreOverride) stale.external.sharedCoreHost.SharedCore.load = async () => coreOverride;
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, "..", "app.html"), "utf8"), { url: "https://local.test/app" });
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const elements = pageElements(document);
  const host = stale.external.host;
  Object.assign(host, { document, localStorage: dom.window.localStorage,
    addEventListener: dom.window.addEventListener.bind(dom.window) });
  stale.external.elements = elements;
  const view = viewModule.create({ state: stale.state, external: stale.external, use: stale.use });
  for (const name of VIEW_RENDERERS) stale.use[name] = view[name];
  view.setupTaskEvents();
  view.setupConnectivityEvents();
  stale.state.activeScreen = "tasks";
  view.render();
  return { ...current, dom, window: dom.window, document, elements, host, view,
    state: stale.state, use: stale.use, calls: stale.calls, callbacks: stale.callbacks };
}

function taskRows(elements) {
  return [...elements.taskList.querySelectorAll(".task-row")];
}

function rowFor(elements, taskId) {
  return taskRows(elements).find((row) => row.dataset.taskId === taskId) || null;
}

module.exports = { viewFixture, setVisibility, settle, waitFor, forceDisplayStatus, spy, renameCapableCore, taskRows, rowFor };
