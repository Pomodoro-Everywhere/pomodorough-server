"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const stateModule = require("./app-state.js");
const { storage, loadCore } = require("./test/account-ownership-fixture.js");
const crypto = require("node:crypto");
const { viewFixture, settle, waitFor, spy, renameCapableCore, rowFor } = require("./test/ux-view-fixture.js");

function capabilityProbe(versionResult) {
  const host = { crypto: crypto.webcrypto, sessionStorage: { getItem: () => "tab-probe", setItem: () => {} } };
  const state = stateModule.createState(host);
  const use = stateModule.create({ state, external: { host, syncCore: storage.syncCore || {}, syncStorage: storage,
    sharedCoreHost: { SharedCore: { load: async () => ({ call: (operation) => {
      assert.equal(operation, "core.version");
      return versionResult();
    } }) } } }, use: {} });
  return { state, use };
}

test("core capability gate: rename needs core 0.54.0 or newer", async () => {
  for (const [version, renameTask] of [["0.53.0", false], ["0.53.99", false], ["0.54.0", true], ["0.54.1", true], ["1.0.0", true], ["10.0.0", true]]) {
    const { state, use } = capabilityProbe(() => ({ coreVersion: version, schemaVersion: 1 }));
    await use.loadSharedCore();
    assert.deepEqual(state.coreCapabilities, { coreVersion: version, renameTask }, version);
  }
  const unsupported = capabilityProbe(() => { throw new Error("invalid shared-core input: unsupported shared-core operation: core.version"); });
  await unsupported.use.loadSharedCore();
  assert.deepEqual(unsupported.state.coreCapabilities, { coreVersion: null, renameTask: false });
  const malformed = capabilityProbe(() => ({ coreVersion: "latest" }));
  await malformed.use.loadSharedCore();
  assert.deepEqual(malformed.state.coreCapabilities, { coreVersion: null, renameTask: false });
  const broken = capabilityProbe(() => { throw new Error("digest mismatch"); });
  await assert.rejects(broken.use.loadSharedCore(), /digest mismatch/);
  assert.equal(broken.state.coreCapabilities, null);
});

// Reports an older core version while every other operation reaches the
// bundled core, so the view sees a core without rename support.
function coreReporting(core, coreVersion) {
  const stub = renameCapableCore(core, []);
  const call = stub.call;
  stub.call = (operation, input) => (operation === "core.version" ? { coreVersion, schemaVersion: 1 } : call(operation, input));
  return stub;
}

test("bundled core 0.54.0 shows the rename control", async (t) => {
  const current = await viewFixture(t);
  assert.equal(await current.use.addTask("Alpha"), true);
  assert.deepEqual(current.state.coreCapabilities, { coreVersion: "0.54.0", renameTask: true });
  const row = rowFor(current.elements, current.state.tasks[0].id);
  assert.ok(row.querySelector(".task-rename"));
  assert.ok(row.querySelector(".task-delete"));
});

test("core 0.53.0 hides the rename control entirely", async (t) => {
  const { core } = await loadCore();
  const current = await viewFixture(t, null, { core: coreReporting(core, "0.53.0") });
  assert.equal(await current.use.addTask("Alpha"), true);
  assert.deepEqual(current.state.coreCapabilities, { coreVersion: "0.53.0", renameTask: false });
  const row = rowFor(current.elements, current.state.tasks[0].id);
  assert.equal(row.querySelector(".task-rename"), null);
  assert.ok(row.querySelector(".task-delete"));
  assert.equal(current.document.querySelector(".task-rename"), null);
});

async function renameFixture(t) {
  const { core } = await loadCore();
  const requests = [];
  const stub = renameCapableCore(core, requests);
  const current = await viewFixture(t, null, { core: stub });
  // The ownership fixture re-registers the real core while loading, so the
  // storage-level stub is installed after it.
  storage.setSharedCore(stub);
  t.after(() => storage.setSharedCore(core));
  assert.equal(await current.use.addTask("Alpha"), true);
  assert.equal(await current.use.addTask("Beta"), true);
  current.requests = requests;
  current.renames = spy(current.use, "renameTask", []);
  current.deletes = spy(current.use, "deleteTask", []);
  return current;
}

function beginRename(current, task) {
  const row = rowFor(current.elements, task.id);
  const button = row.querySelector(".task-rename");
  button.click();
  const input = rowFor(current.elements, task.id).querySelector(".task-rename-input");
  assert.ok(input, "editor rendered");
  return input;
}

function keydown(current, input, key) {
  input.dispatchEvent(new current.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

function type(current, input, value) {
  input.value = value;
  input.dispatchEvent(new current.window.Event("input", { bubbles: true }));
}

test("rename control renders with a 0.54.0 core and commits the renameTask intent with four identities", async (t) => {
  const current = await renameFixture(t);
  const [alpha] = current.state.tasks;
  const button = rowFor(current.elements, alpha.id).querySelector(".task-rename");
  assert.equal(button.textContent, "Rename");
  assert.equal(button.getAttribute("aria-label"), "Rename Alpha");
  assert.equal(button.disabled, false);
  const input = beginRename(current, alpha);
  assert.equal(input.value, "Alpha");
  assert.equal(current.document.activeElement, input);
  assert.equal(rowFor(current.elements, alpha.id).querySelector("strong.task-name"), null);
  type(current, input, "  Alpha renamed  ");
  keydown(current, input, "Enter");
  await waitFor(() => current.renames.length === 1, "rename intent");
  assert.deepEqual(current.renames[0].args, [alpha, "Alpha renamed"]);
  assert.equal(await current.renames[0].result, false, "stubbed core answers noop");
  assert.equal(current.requests.length, 1);
  const request = current.requests[0];
  assert.deepEqual(request.intent, { kind: "renameTask", taskId: alpha.id, title: "Alpha renamed" });
  assert.equal(request.identities.commandUuids.length, 4);
  assert.equal(new Set(request.identities.commandUuids).size, 4);
  assert.equal(request.ownership.expectedOwnerId, current.state.localOwnerId);
  assert.ok(rowFor(current.elements, alpha.id).querySelector("strong.task-name"), "editor closed");
});

test("escape, blank, whitespace, and unchanged titles cancel without an intent", async (t) => {
  const current = await renameFixture(t);
  const [alpha] = current.state.tasks;
  let input = beginRename(current, alpha);
  type(current, input, "Changed");
  keydown(current, input, "Escape");
  assert.equal(rowFor(current.elements, alpha.id).querySelector("strong.task-name").textContent, "Alpha");
  assert.equal(current.document.activeElement, rowFor(current.elements, alpha.id).querySelector(".task-rename"));
  for (const draft of ["", "   ", "Alpha", " Alpha "]) {
    input = beginRename(current, alpha);
    type(current, input, draft);
    keydown(current, input, "Enter");
    await settle();
    assert.equal(rowFor(current.elements, alpha.id).querySelector("strong.task-name").textContent, "Alpha", JSON.stringify(draft));
  }
  assert.equal(current.renames.length, 0);
  assert.equal(current.requests.length, 0);
});

test("blur commits a changed draft and cancels an unchanged one", async (t) => {
  const current = await renameFixture(t);
  const [alpha, beta] = current.state.tasks;
  let input = beginRename(current, alpha);
  input.dispatchEvent(new current.window.FocusEvent("blur"));
  await settle();
  assert.equal(current.renames.length, 0);
  assert.ok(rowFor(current.elements, alpha.id).querySelector("strong.task-name"));
  input = beginRename(current, beta);
  type(current, input, "Beta two");
  input.dispatchEvent(new current.window.FocusEvent("blur"));
  await waitFor(() => current.renames.length === 1, "rename intent after blur");
  await current.renames[0].result;
  assert.deepEqual(current.requests.map((request) => request.intent), [{ kind: "renameTask", taskId: beta.id, title: "Beta two" }]);
});

test("rename flushes a pending delete before sending its own intent", async (t) => {
  const current = await renameFixture(t);
  const [alpha, beta] = current.state.tasks;
  rowFor(current.elements, beta.id).querySelector(".task-delete").click();
  const input = beginRename(current, alpha);
  type(current, input, "Alpha two");
  keydown(current, input, "Enter");
  await waitFor(() => current.renames.length === 1, "rename intent after flush");
  assert.equal(current.deletes.length, 1);
  assert.equal(await current.deletes[0].result, true);
  await current.renames[0].result;
  assert.deepEqual(current.state.tasks.map((task) => task.title), ["Alpha"]);
  assert.equal(current.requests[0].intent.title, "Alpha two");
});

test("rename and delete controls share the blocked state", async (t) => {
  const current = await renameFixture(t);
  current.state.ready = false;
  current.view.renderTasks();
  for (const row of current.elements.taskList.querySelectorAll(".task-row")) {
    assert.equal(row.querySelector(".task-rename").disabled, true);
    assert.equal(row.querySelector(".task-delete").disabled, true);
  }
});
