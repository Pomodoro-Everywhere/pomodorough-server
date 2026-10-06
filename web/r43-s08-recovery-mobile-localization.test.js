"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { createI18n } = require("./i18n.js");
const appView = require("./app-view.js");

const catalogs = Object.fromEntries(["en", "ar-XB"].map((locale) => [
  locale, JSON.parse(fs.readFileSync(path.join(__dirname, "locales", `${locale}.json`), "utf8"))
]));
const ENGLISH = {
  retryRefresh: "Refresh and retry",
  retry: "Retry saved choice",
  applying: "Applying choice",
  finished: "Finished",
  time: "Time"
};

function pseudo(english) {
  const vowels = { A: "Å", E: "Ë", I: "Ï", O: "Ö", U: "Û", a: "à", e: "ë", i: "ï", o: "ö", u: "û" };
  return `‏⟦${english.replace(/[AEIOUaeiou]/g, (letter) => vowels[letter])}⟧‏`;
}

function fixture(t, locale) {
  const dom = new JSDOM(`<dialog id="bootstrapDialog"><h2 id="bootstrapTitle"></h2><p id="bootstrapSummary"></p>
    <div id="bootstrapChoices"><button type="button" data-bootstrap-strategy="keep_remote">remote</button></div>
    <section id="bootstrapConfirmation"><h3 id="bootstrapConfirmationTitle"></h3><p id="bootstrapConfirmationMessage"></p>
    <button id="bootstrapConfirm" type="button">confirm</button><button id="bootstrapCancel" type="button">cancel</button></section>
    <p id="bootstrapError"></p><button id="bootstrapRetry" type="button">retry</button>
    <button id="bootstrapSignOut" type="button">signout</button>
    <section id="logoutRecovery"><button id="logoutRecoveryRetry" type="button">retry</button>
    <button id="logoutRecoverySignIn" type="button">signin</button></section></dialog>
    <section id="tasksScreen"><span id="taskCount"></span><form id="taskForm"><input id="taskInput">
    <button type="submit">Add</button></form><div id="taskList"></div></section>`);
  t.after(() => dom.window.close());
  const { document } = dom.window;
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((el) => [el.id, el]));
  elements.bootstrapChoiceButtons = [...document.querySelectorAll("[data-bootstrap-strategy]")];
  const i18n = createI18n({ catalogs, locale });
  const state = {
    logoutRecoveryRequired: false, bootstrapLimitError: null, bootstrapOwnershipConfirmation: null,
    bootstrapPlan: { mode: "choose" }, bootstrapStrategy: "merge", bootstrapPending: null,
    bootstrapError: "boom", bootstrapSubmitting: false, bootstrapBlocked: false,
    authenticated: true, bootstrapConflict: false, bootstrapFocusTarget: null,
    ready: false, tasks: []
  };
  const syncCore = {
    bootstrapDialogView: (input) => input,
    confirmationFor: () => ({ title: "Confirm", message: "Apply?", confirmLabel: "Apply" })
  };
  const use = { tr: (...args) => i18n.t(...args), controlsBlocked: () => false, deleteTask: () => {} };
  const view = appView.create({ state, external: { host: dom.window, elements, syncCore }, use });
  return { document, elements, state, syncCore, view };
}

function renderDialog(f, dialogView) {
  f.syncCore.bootstrapDialogView = () => dialogView;
  f.view.renderBootstrapDialog();
}

function failedView(extra = {}) {
  return { open: true, failed: true, choosing: false, confirming: false, busy: false, ...extra };
}

for (const [conflict, key, english] of [
  [true, "bootstrap.retryRefresh", ENGLISH.retryRefresh],
  [false, "bootstrap.retry", ENGLISH.retry]
]) {
  test(`R43-S08 ar-XB renders ${key} from resources, not raw English`, (t) => {
    assert.ok(Object.hasOwn(catalogs["ar-XB"], key), `missing ar-XB resource ${key}`);
    const f = fixture(t, "ar-XB");
    f.state.bootstrapConflict = conflict;
    renderDialog(f, failedView());
    assert.equal(f.elements.bootstrapRetry.textContent, pseudo(english));
    assert.notEqual(f.elements.bootstrapRetry.textContent, english);
  });
}

test("R43-S08 ar-XB renders submitting confirmation label from resources", (t) => {
  assert.equal(catalogs.en["bootstrap.applyingChoice"], ENGLISH.applying);
  assert.ok(Object.hasOwn(catalogs["ar-XB"], "bootstrap.applyingChoice"), "missing ar-XB resource bootstrap.applyingChoice");
  const f = fixture(t, "ar-XB");
  f.state.bootstrapSubmitting = true;
  renderDialog(f, failedView({ failed: false, confirming: true }));
  assert.equal(f.elements.bootstrapConfirm.textContent, pseudo(ENGLISH.applying));
  assert.notEqual(f.elements.bootstrapConfirm.textContent, ENGLISH.applying);
});

test("R43-S08 ar-XB exposes mobile task labels from resources, not raw English", (t) => {
  const f = fixture(t, "ar-XB");
  f.state.tasks = [{ id: "a", title: "a" }];
  f.view.renderTasks();
  const stats = [...f.elements.taskList.querySelectorAll(".task-stat")];
  assert.equal(stats.length, 2);
  assert.deepEqual(stats.map((el) => el.getAttribute("data-stat-label")),
    [pseudo(ENGLISH.finished), pseudo(ENGLISH.time)]);
  for (const el of stats) assert.ok(!["Finished", "Time"].includes(el.getAttribute("data-stat-label")));
});

test("R43-S08 mobile stylesheet carries no hardcoded English stat labels", () => {
  const css = fs.readFileSync(path.join(__dirname, "app.css"), "utf8");
  assert.ok(!/content:\s*"Finished"/.test(css), "app.css still hardcodes Finished");
  assert.ok(!/content:\s*"Time"/.test(css), "app.css still hardcodes Time");
  assert.ok(/content:\s*attr\(data-stat-label\)/.test(css), "app.css must present the localized DOM label");
});

test("R43-S08 English locale keeps exact recovery and mobile strings", (t) => {
  const f = fixture(t, "en");
  f.state.bootstrapConflict = true;
  renderDialog(f, failedView());
  assert.equal(f.elements.bootstrapRetry.textContent, ENGLISH.retryRefresh);
  f.state.bootstrapSubmitting = true;
  renderDialog(f, failedView({ failed: false, confirming: true }));
  assert.equal(f.elements.bootstrapConfirm.textContent, ENGLISH.applying);
  f.state.tasks = [{ id: "a", title: "a" }];
  f.view.renderTasks();
  assert.deepEqual([...f.elements.taskList.querySelectorAll(".task-stat")]
    .map((el) => el.getAttribute("data-stat-label")), [ENGLISH.finished, ENGLISH.time]);
});
