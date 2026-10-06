"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { JSDOM } = require("jsdom");
const { fixture, storage, dump, seedMeta, snapshot, deferred, nowMs } = require("./test/account-ownership-fixture.js");
const { accountUser } = require("./test/incarnation-fixture.js");
const sync = require("./sync-core.js");
const receipts = [];

function productionModule(name) {
  if (!process.env.CORE_PWA02_CALLBACK_BASELINE) return require(`./${name}`);
  const filename = path.join(__dirname, name);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(__dirname);
  loaded._compile(fs.readFileSync(path.join(process.env.CORE_PWA02_CALLBACK_BASELINE, name), "utf8"), filename);
  return loaded.exports;
}

test.after(() => {
  if (process.env.CORE_PWA02_CALLBACK_EVIDENCE) fs.writeFileSync(process.env.CORE_PWA02_CALLBACK_EVIDENCE,
    JSON.stringify({ provenance: require("./shared-core-metadata.js"), cases: receipts }, null, 2));
});

async function prepared(t) {
  const current = await fixture(t);
  const { stale } = current;
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, "app.html"), "utf8"), { url: "https://local.test/app" });
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
  elements.phaseButtons = [...document.querySelectorAll(".phase-button")];
  elements.durationInputs = [...document.querySelectorAll(".stepper input")];
  elements.stepButtons = [...document.querySelectorAll("[data-step]")];
  elements.bootstrapChoiceButtons = [...document.querySelectorAll("[data-bootstrap-strategy]")];
  elements.screenButtons = [...document.querySelectorAll("[data-screen-button]")];
  const events = [];
  const requests = [];
  const host = stale.external.host;
  Object.assign(host, { document, localStorage: dom.window.localStorage, confirm: () => true,
    location: { assign: (url) => events.push(["redirect", url]) }, EventSource: class { addEventListener() {} close() {} } });
  stale.external.elements = elements;
  const database = stale.use.database();
  Object.assign(stale.use, productionModule("app-storage.js").create({ state: stale.state, external: stale.external, use: stale.use }));
  stale.use.setDatabaseForTest(database);
  Object.assign(stale.use, productionModule("app-session.js").create({ state: stale.state, external: stale.external, use: stale.use, emit() {} }));
  await seedMeta(database, { canonicalHead: { wallMs: nowMs, counter: 2 } });
  await stale.use.reloadPersistedState();
  const view = productionModule("app-view.js").create({ state: stale.state, external: stale.external, use: stale.use });
  stale.use.render = () => { events.push(["render", sync.accountOwnerId(stale.state.user)]); view.renderDurations(); };
  stale.use.renderProfile = () => events.push(["profile", sync.accountOwnerId(stale.state.user)]);
  stale.use.renderBootstrapDialog = () => events.push(["dialog"]);
  view.renderDurations();
  return { ...current, dom, elements, view, events, requests };
}

function response(status, payload) { return { ok: status >= 200 && status < 300, status, json: async () => payload }; }

function observeFetch(current, handler) {
  current.stale.external.host.fetch = async (url, request = {}) => {
    current.requests.push({ url, method: request.method || "GET", body: request.body, headers: { ...request.headers } });
    return handler(url, request);
  };
}

async function reopen(current, cleared = false) {
  const { stale } = current;
  const previous = stale.use.database();
  if (!cleared) await stale.use.clearLocalData(undefined, stale.use.captureDatabaseContext());
  assert.equal(stale.use.database(), null);
  const database = await stale.use.openDatabase();
  stale.use.setDatabaseForTest(database);
  assert.notEqual(database, previous);
  await seedMeta(database, { snapshot: snapshot("account-A"), deviceId: "shared-device", deviceSequence: 7,
    hlc: { wallMs: nowMs, counter: 200 }, canonicalHead: { wallMs: nowMs, counter: 200 }, settings: { selectedPhase: "focus" } });
  await stale.use.reloadPersistedState();
  await stale.use.persistDurationOperation("focus", 1800000);
  await stale.use.persistTaskOperation("upsert", current.core.taskIdentity({ title: "Reopened private work" }));
  return database;
}

async function observation(current) {
  return { persisted: await dump(current.peer.use.database()), memory: structuredClone(current.stale.use.ownerStateValue()),
    marker: current.dom.window.localStorage.getItem("pomodoroughPendingLogout"),
    markerOwner: current.dom.window.localStorage.getItem("pomodoroughPendingLogoutOwner"),
    databaseOpen: current.stale.use.database() !== null, requests: structuredClone(current.requests) };
}

async function assertRetained(current, before, name) {
  const after = await observation(current);
  receipts.push({ case: name, before, after, events: structuredClone(current.events) });
  assert.deepEqual(after, before);
  assert.deepEqual(current.events, []);
}

for (const result of ["success", "http failure", "network failure"]) {
  test(`CORE-PWA02 logout keeps original cleanup authorization after late revocation ${result}`, async (t) => {
    const current = await prepared(t);
    const entered = deferred();
    const release = deferred();
    observeFetch(current, async (url) => {
      assert.equal(url, "/api/v1/auth/logout");
      entered.resolve(); await release.promise;
      if (result === "network failure") throw new Error("old revocation failed");
      return response(result === "success" ? 204 : 503);
    });
    const loggingOut = current.stale.use.logout();
    await entered.promise;
    await reopen(current);
    const before = await observation(current);
    current.events.length = 0;
    release.resolve();
    await loggingOut;
    await assertRetained(current, before, t.name);
  });
}

for (const result of ["success", "http failure"]) {
  test(`CORE-PWA02 current connection logout clears data with revocation ${result}`, async (t) => {
    const current = await prepared(t);
    await current.stale.use.persistDurationOperation("focus", 1800000);
    observeFetch(current, async (url) => {
      assert.equal(url, "/api/v1/auth/logout");
      return response(result === "success" ? 204 : 503);
    });
    await current.stale.use.logout();
    const after = await observation(current);
    receipts.push({ case: t.name, after, events: structuredClone(current.events) });
    assert.ok(Object.values(after.persisted).every((records) => records.length === 0));
    assert.equal(after.databaseOpen, false);
    assert.equal(after.marker, result === "success" ? null : "1");
    assert.equal(current.events.filter(([kind]) => kind === "redirect").length, 1);
  });
}

test("CORE-PWA02 logout's committed cleanup cannot close a reopened connection or run final effects", async (t) => {
  const current = await prepared(t);
  const committed = deferred();
  const release = deferred();
  let armed = true;
  const external = { ...current.stale.external, syncStorage: { ...storage, guardedMutation: async (...args) => {
    const result = await storage.guardedMutation(...args);
    if (armed && args[1].length === 6) { armed = false; committed.resolve(); await release.promise; }
    return result;
  } } };
  const database = current.stale.use.database();
  Object.assign(current.stale.use, productionModule("app-storage.js").create({ state: current.stale.state, external, use: current.stale.use }));
  current.stale.use.setDatabaseForTest(database);
  observeFetch(current, async () => response(503));
  const loggingOut = current.stale.use.logout();
  await committed.promise;
  database.close();
  current.stale.use.setDatabaseForTest(null);
  await reopen(current, true);
  const before = await observation(current);
  current.events.length = 0;
  release.resolve();
  await loggingOut;
  await assertRetained(current, before, t.name);
});

test("CORE-PWA02 logout after committed close cannot remove marker or redirect reopened same account", async (t) => {
  const current = await prepared(t);
  const committed = deferred();
  const release = deferred();
  const clear = current.stale.use.clearLocalData;
  current.stale.use.clearLocalData = async (...args) => {
    const result = await clear(...args);
    committed.resolve(); await release.promise;
    return result;
  };
  observeFetch(current, async () => response(204));
  const loggingOut = current.stale.use.logout();
  await committed.promise;
  await reopen(current, true);
  const before = await observation(current);
  current.events.length = 0;
  release.resolve();
  await loggingOut;
  await assertRetained(current, before, t.name);
});

test("CORE-PWA02 account deletion final cleanup callback cannot remove marker or redirect reopened same account", async (t) => {
  const current = await prepared(t);
  const committed = deferred();
  const release = deferred();
  const clear = current.stale.use.clearLocalData;
  current.stale.use.clearLocalData = async (...args) => {
    const result = await clear(...args);
    committed.resolve(); await release.promise;
    return result;
  };
  observeFetch(current, async (url, request) => {
    assert.equal(url, "/api/v1/account");
    assert.equal(request.method, "DELETE");
    return response(204);
  });
  const deleting = current.stale.use.confirmDeleteAccount("DELETE");
  await committed.promise;
  await reopen(current, true);
  const before = await observation(current);
  current.events.length = 0;
  release.resolve();
  await deleting;
  await assertRetained(current, before, t.name);
});

test("CORE-PWA02 current account deletion clears data, removes marker and redirects once", async (t) => {
  const current = await prepared(t);
  observeFetch(current, async () => response(204));
  assert.equal(await current.stale.use.confirmDeleteAccount("DELETE"), true);
  const after = await observation(current);
  receipts.push({ case: t.name, after, events: structuredClone(current.events) });
  assert.ok(Object.values(after.persisted).every((records) => records.length === 0));
  assert.equal(after.marker, null);
  assert.equal(after.databaseOpen, false);
  assert.equal(current.events.filter(([kind]) => kind === "redirect").length, 1);
});

test("CORE-PWA02 deletion completion cannot reactivate after replacement connection also closes", async (t) => {
  const current = await prepared(t);
  const committed = deferred();
  const release = deferred();
  const clear = current.stale.use.clearLocalData;
  current.stale.use.clearLocalData = async (...args) => {
    const result = await clear(...args);
    committed.resolve(); await release.promise;
    return result;
  };
  observeFetch(current, async () => response(204));
  const deleting = current.stale.use.confirmDeleteAccount("DELETE");
  await committed.promise;
  await reopen(current, true);
  await clear(undefined, current.stale.use.captureDatabaseContext());
  const before = await observation(current);
  current.events.length = 0;
  release.resolve();
  await deleting;
  await assertRetained(current, before, t.name);
});

test("CORE-PWA02 real jsdom MouseEvent retries exact saved resolution using current branded context", async (t) => {
  const current = await prepared(t);
  const { stale, view, elements, dom } = current;
  stale.state.bootstrapPreview = snapshot("account-A");
  stale.state.bootstrapPlan = { mode: "choose", strategy: "merge" };
  await stale.use.persistDurationOperation("focus", 1200000);
  const pending = await stale.use.persistBootstrapResolution("merge");
  observeFetch(current, async (url) => { assert.equal(url, "/api/v1/bootstrap/resolve"); return response(503); });
  let operation;
  let failure;
  const retry = stale.use.retryBootstrapResolution;
  stale.use.retryBootstrapResolution = (...args) => {
    operation = retry(...args).catch((error) => { failure = { name: error.name, message: error.message }; });
    return operation;
  };
  view.setupBootstrapEvents();
  elements.bootstrapRetry.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await operation;
  const after = await observation(current);
  receipts.push({ case: t.name, pending, after, failure: failure || null });
  assert.equal(failure, undefined);
  assert.equal(current.requests.length, 1);
  assert.equal(current.requests[0].body, JSON.stringify(pending.payload));
  assert.equal(stale.state.bootstrapPending.payload.requestId, pending.payload.requestId);
  assert.match(stale.state.bootstrapError, /Retry sends the exact saved request/);
  await assert.rejects(retry(new dom.window.MouseEvent("click")), /bound account operation context is required/);
  assert.equal(current.requests.length, 1, "MouseEvent never becomes a branded context");
});

function installDurationEvents(current) {
  let operation;
  const issue = current.stale.use.issueDurationOperation;
  current.stale.use.issueDurationOperation = (...args) => { operation = issue(...args); return operation; };
  current.view.setupPreferenceEvents();
  return { input: current.elements.durationInputs.find((input) => input.name === "focus"),
    operation: () => operation };
}

test("CORE-PWA02 late committed duration UI continuation cannot replace B's draft 47 with saved 30", async (t) => {
  const current = await prepared(t);
  const { stale } = current;
  const committed = deferred();
  const release = deferred();
  const persist = stale.use.persistWorkspaceIntent;
  stale.use.persistWorkspaceIntent = async (...args) => {
    const plan = await persist(...args);
    committed.resolve(); await release.promise;
    return plan;
  };
  const duration = installDurationEvents(current);
  duration.input.value = "35";
  duration.input.dispatchEvent(new current.dom.window.Event("change", { bubbles: true }));
  await committed.promise;
  stale.state.user = accountUser("account-B");
  stale.state.localOwnerId = sync.accountOwnerId(stale.state.user);
  await seedMeta(stale.use.database(), { snapshot: { ...snapshot("account-B"), durationsMs: { ...snapshot("account-B").durationsMs, focus: 1800000 } } });
  const transaction = stale.use.database().transaction(["pendingDurations", "meta"], "readwrite");
  transaction.objectStore("pendingDurations").clear();
  transaction.objectStore("meta").delete("projectionPending");
  transaction.objectStore("meta").delete("deliveryProof");
  await storage.transactionDone(transaction);
  await stale.use.reloadPersistedState();
  duration.input.value = "47";
  duration.input.blur();
  const before = await observation(current);
  current.events.length = 0;
  release.resolve();
  const result = await duration.operation();
  await Promise.resolve();
  const after = await observation(current);
  receipts.push({ case: t.name, result, before, after, input: duration.input.value, events: structuredClone(current.events) });
  assert.equal(result, false);
  assert.equal(duration.input.value, "47");
  assert.deepEqual(after, before);
  assert.deepEqual(current.events, []);
});

test("CORE-PWA02 current duration change commits and renders controls normally", async (t) => {
  const current = await prepared(t);
  const duration = installDurationEvents(current);
  duration.input.value = "35";
  duration.input.dispatchEvent(new current.dom.window.Event("change", { bubbles: true }));
  assert.equal(await duration.operation(), true);
  assert.equal(duration.input.value, "35");
  const after = await observation(current);
  receipts.push({ case: t.name, after, input: duration.input.value, events: structuredClone(current.events) });
  assert.equal(after.persisted.pendingDurations[0].durationMs, 2100000);
  assert.equal(current.events.filter(([kind]) => kind === "render").length, 1);
});

test("CORE-PWA02 current refused duration still restores controls through scoped fallback", async (t) => {
  const current = await prepared(t);
  const duration = installDurationEvents(current);
  const shortBreak = current.elements.durationInputs.find((input) => input.name === "short_break");
  shortBreak.value = "13";
  duration.input.value = "25";
  duration.input.dispatchEvent(new current.dom.window.Event("change", { bubbles: true }));
  const result = await duration.operation();
  await Promise.resolve();
  const after = await observation(current);
  receipts.push({ case: t.name, result, after, input: duration.input.value, shortBreak: shortBreak.value });
  assert.equal(result, false);
  assert.equal(duration.input.value, "25");
  assert.equal(shortBreak.value, "5");
  assert.deepEqual(after.persisted.pendingDurations, []);
});

test("CORE-PWA02 callback source contracts retain cleanup scopes and adapt MouseEvent explicitly", () => {
  const session = fs.readFileSync(path.join(__dirname, "app-session.js"), "utf8");
  const view = fs.readFileSync(path.join(__dirname, "app-view.js"), "utf8");
  const repository = fs.readFileSync(path.join(__dirname, "app-storage.js"), "utf8");
  assert.match(session, /requestSessionRevocation\(this\.state\.csrfToken, context\.ownerId, cleanupContext\)/);
  assert.match(session, /clearLocalData\(identity, context\)/);
  assert.match(session, /accountOperation\.isCurrent\(completed\)/);
  assert.match(repository, /assertCurrent: \(\) => this\.assertAuthorizedCleanup\(identity, context\)/);
  assert.match(repository, /accountOperation\.requireBound\(completed\)/);
  assert.doesNotMatch(view, /addEventListener\("click", use\.retryBootstrapResolution\)/);
  assert.match(view, /\(\) => use\.retryBootstrapResolution\(use\.captureAccountContext\(\)\)/);
  assert.match(view, /!saved && accountOperation\.isCurrent\(context\)/);
});
