"use strict";

const { accountUser, ownerId } = require("./incarnation-fixture.js");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const crypto = require("node:crypto");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const { IDBFactory } = require("fake-indexeddb");
const names = ["meta", "pending", "pendingTasks", "pendingDurations", "pendingAutoStarts", "pendingSelectedTasks"];
const marker = "pomodoroughPendingLogout";
const companion = "pomodoroughPendingLogoutOwner";
function source(name) {
  return fs.readFileSync(path.join(root, "web", name), "utf8");
}

function memory() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
}

function element(id = "") {
  const children = [];
  const listeners = new Map();
  const descendants = new Map();
  return {
    id, children, listeners, listenerCounts: new Map(), hidden: false, disabled: false, open: false,
    textContent: "", value: "", dataset: {}, style: {}, attributes: {},
    classList: { add() {}, remove() {}, toggle() {} },
    append(...values) { children.push(...values); },
    replaceChildren(...values) { children.splice(0, children.length, ...values); },
    setAttribute(key, value) { this.attributes[key] = value; },
    removeAttribute(key) { delete this.attributes[key]; },
    addEventListener(name, callback) {
      listeners.set(name, callback);
      this.listenerCounts.set(name, (this.listenerCounts.get(name) || 0) + 1);
    },
    querySelector(selector) {
      if (!descendants.has(selector)) descendants.set(selector, element(selector));
      return descendants.get(selector);
    },
    querySelectorAll() { return []; },
    focus() {}, showModal() { this.open = true; }, close() { this.open = false; }
  };
}

function htmlElements() {
  const elements = new Map();
  const stack = [];
  for (const match of source("app.html").matchAll(/<\/?([\w-]+)\b([^>]*)>/g)) {
    const [tag, name, attributes] = match;
    if (tag.startsWith("</")) { stack.pop(); continue; }
    const node = element(attributes.match(/\bid="([^"]+)"/)?.[1] || name);
    node.tagName = name;
    node.parentElement = stack.at(-1);
    node.hidden = /\bhidden\b/.test(attributes);
    node.disabled = /\bdisabled\b/.test(attributes);
    node.textContent = "";
    if (attributes.includes('id="')) elements.set("#" + node.id, node);
    if (!["meta", "link", "input", "img", "br", "hr"].includes(name)) stack.push(node);
  }
  return elements;
}

function visible(node) {
  if (!node || node.hidden || node.tagName === "dialog" && !node.open) return false;
  return !node.parentElement || visible(node.parentElement);
}

async function click(current, id) {
  const button = current.elements.get("#" + id);
  assert.ok(visible(button), id + " must be visible");
  assert.equal(button.disabled, false, id + " must be enabled");
  assert.equal(button.listenerCounts.get("click"), 1, id + " must be wired exactly once");
  return button.listeners.get("click")();
}

function browser(environment) {
  const elements = htmlElements();
  const events = new Map();
  const timers = new Map();
  const calls = [];
  let nextTimer = 0;
  const document = {
    visibilityState: "visible", title: "Pomodorough", activeElement: null,
    querySelector(id) {
      assert.ok(elements.has(id), `App HTML missing ${id}`);
      return elements.get(id);
    },
    querySelectorAll: () => [], createElement: element,
    createElementNS: (_namespace, id) => element(id), createDocumentFragment: element,
    addEventListener: (name, callback) => events.set(name, callback)
  };
  const host = {
    document, localStorage: environment.localStorage, sessionStorage: memory(),
    crypto: crypto.webcrypto, navigator: { onLine: false }, performance,
    console: { warn: (...args) => calls.push(["warn", ...args.map(String)]) },
    location: { assign: (url) => calls.push(["redirect", url]) },
    fetch: async (...args) => { calls.push(["fetch", ...args]); throw new Error("OFFLINE: no network permitted"); },
    setTimeout: (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
    clearTimeout: (id) => timers.delete(id), setInterval: () => 1, clearInterval() {},
    addEventListener: (name, callback) => events.set(name, callback), confirm: () => true, prompt: () => null,
    indexedDB: {
      open(...args) {
        const request = environment.indexedDB.open(...args);
        request.addEventListener("success", () => environment.connections.add(request.result));
        return request;
      },
      deleteDatabase() { throw new Error("Database deletion forbidden"); }
    }
  };
  return { host, elements, events, timers, calls };
}

async function tab(environment) {
  const browserState = browser(environment);
  const context = vm.createContext({ ...browserState.host, TextEncoder, TextDecoder,
    URL, structuredClone, Uint8Array, ArrayBuffer, WebAssembly,
    PomodoroughAppTest: { disableAutoStart: true } });
  const ordered = ["shared-core-metadata.js", "shared-core.js", "sync-core.js", "sync-authority.js", "sync-storage-uuid.js", "sync-storage.js",
    "app-runtime.js", "app-state.js", "app-storage.js", "app-actions.js", "app-sync.js",
    "app-bootstrap.js", "app-session.js", "app-view.js"];
  for (const name of ordered) vm.runInContext(source(name), context, { filename: root + "/web/" + name });
  const bytes = fs.readFileSync(root + "/web/pomodorough_core.wasm");
  const metadata = require(root + "/web/shared-core-metadata.js");
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), metadata.sha256);
  assert.deepEqual(bytes, fs.readFileSync(root + "/internal/sharedcore/pomodorough_core.wasm"));
  const core = await context.PomodoroughSharedCore.SharedCore.fromBytes(bytes);
  context.PomodoroughSharedCore.SharedCore.load = async () => core;
  const storage = { ...context.PomodoroughStorage };
  context.PomodoroughStorage = storage;
  storage.setSharedCore(core);
  const originalCreate = context.PomodoroughAppRuntime.createRuntime;
  let runtime;
  context.PomodoroughAppRuntime = { createRuntime(input) {
    const builder = originalCreate(input);
    return { install: builder.install, finalize() { runtime = builder.finalize(); return runtime; } };
  } };
  vm.runInContext(source("app.js"), context, { filename: root + "/web/app.js" });
  const use = runtime.facade(runtime.describe().flatMap((manifest) => manifest.provides));
  return { ...browserState, context, core, storage, use,
    state: context.PomodoroughAppTest.state, initialize: context.PomodoroughApp.initialize };
}

async function fixture(testContext) {
  const environment = { indexedDB: new IDBFactory(), localStorage: memory(), connections: new Set() };
  testContext.after(() => { for (const database of environment.connections) database.close(); });
  const openTab = () => tab(environment);
  const current = await openTab();
  const database = await current.use.openDatabase();
  return { ...environment, openTab, current, database };
}

function identity(current, user, owner = user) {
  current.state.user = accountUser(user);
  current.state.localOwnerId = ownerId(owner);
}

function snapshot(owner) {
  return { user: accountUser(owner), revision: 7,
    canonicalTimer: null, tasks: [], history: [], durationsMs: {
      focus: 1500000, short_break: 300000, long_break: 900000
    }, autoStartBreaks: false, selectedTaskId: null };
}

function done(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", resolve);
    transaction.addEventListener("abort", () => reject(transaction.error || new Error("aborted")));
  });
}

function seedTransaction(database, owner, filled = true) {
  const transaction = database.transaction(names, "readwrite");
  for (const name of names) transaction.objectStore(name).clear();
  const meta = transaction.objectStore("meta");
  meta.put({ key: "snapshot", value: snapshot(owner) });
  meta.put({ key: "deviceId", value: "checker-device" });
  meta.put({ key: "deviceSequence", value: 23 });
  meta.put({ key: "hlc", value: { wallMs: 1000, counter: 8 } });
  meta.put({ key: "settings", value: { selectedPhase: "focus", durationSyncBootstrapped: true,
    autoStartSyncBootstrapped: true, selectedTaskSyncBootstrapped: true } });
  if (filled) for (const name of names.slice(1)) {
    transaction.objectStore(name).put({ id: "retained-" + name, privateValue: owner, evidence: name });
  }
  return transaction;
}

async function dump(database) {
  const transaction = database.transaction(names, "readonly");
  return Object.fromEntries(await Promise.all(names.map((name) => new Promise((resolve, reject) => {
    const request = transaction.objectStore(name).getAll();
    request.onsuccess = () => resolve([name, request.result]);
    request.onerror = () => reject(request.error);
  }))));
}

function writeMarker(localStorage, ownerRecord, ...flags) {
  const flag = flags.length ? flags[0] : "1";
  for (const [key, value] of [[marker, flag], [companion, ownerRecord]]) {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  }
}

async function drain(current, count = 4) {
  for (let index = 0; index < count; index += 1) {
    const item = [...current.timers].sort((left, right) => left[1].delay - right[1].delay)[0];
    if (!item) break;
    current.timers.delete(item[0]);
    await item[1].callback();
    await new Promise(setImmediate);
  }
}

async function interruptedLogout(context, owner = "account-A") {
  const environment = await fixture(context);
  const { current, database, localStorage, openTab } = environment;
  await done(seedTransaction(database, owner, false));
  const task = current.core.taskIdentity({ title: "Legitimate retained legacy task" });
  await current.storage.allocateMutation(database, {
    expectedUserId: ownerId(owner), storeName: "pendingTasks", nowMs: 10000,
    withUuidV7: true, requireProjection: true,
    build: ({ id, wallMs, counter }) => ({ id, deviceId: "checker-device",
      occurredAt: new Date(wallMs).toISOString(), hlcWallMs: wallMs, hlcCounter: counter,
      type: "upsert", taskId: task.id, title: task.title })
  });
  localStorage.setItem(marker, "1");
  assert.equal(localStorage.getItem(companion), null);
  return { ...environment, current: await openTab(), retained: await dump(database) };
}

function respondAs(current, userId, options = {}) {
  let revoked = false;
  current.context.navigator.onLine = true;
  current.context.fetch = async (url) => {
    current.calls.push(["synthetic", url]);
    if (url === "/api/v1/me") {
      await options.beforeSession?.();
      if (revoked || userId === null) return { ok: false, status: 401 };
      return { ok: true, status: 200,
        json: async () => ({ user: accountUser(userId), csrfToken: "synthetic-csrf" }) };
    }
    assert.equal(url, "/api/v1/auth/logout");
    await options.beforeRevocation?.();
    const status = options.logoutStatus || 204;
    revoked = status === 204;
    return { ok: revoked, status };
  };
}

function assertRecovery(current) {
  assert.equal(current.state.logoutRecoveryRequired, true);
  assert.equal(current.use.controlsBlocked(), true);
  assert.equal(current.state.offlineOwnerMode, false);
  assert.equal(current.elements.get("#timerToggle").disabled, true);
  assert.equal(current.elements.get("#profile").hidden, true);
  assert.equal(current.elements.get("#bootstrapDialog").open, true);
  assert.equal(visible(current.elements.get("#logoutRecoveryRetry")), true);
  assert.equal(visible(current.elements.get("#logoutRecoverySignIn")), true);
  assert.match(current.elements.get("#bootstrapTitle").textContent, /pending sign-out/i);
  assert.match(current.elements.get("#bootstrapSummary").textContent, /account.*owns/i);
  assert.equal(visible(current.elements.get("#bootstrapChoices")), false);
}

async function assertRecovered(environment) {
  const { current, database, localStorage } = environment;
  assert.equal(current.state.ready, true);
  assert.equal(current.state.logoutRecoveryRequired, false);
  assert.equal(localStorage.getItem(marker), null);
  assert.equal(localStorage.getItem(companion), null);
  assert.equal(visible(current.elements.get("#logoutRecoveryRetry")), false);
  assert.equal(current.elements.get("#bootstrapDialog").open, false);
  const records = await dump(database);
  assert.equal(records.meta.some((row) => row.value?.user?.id), false);
  for (const name of names.slice(1)) assert.deepEqual(records[name], []);
  assert.ok(current.calls.some((call) => call[0] === "redirect"));
}

module.exports = { click, interruptedLogout, respondAs, assertRecovery, assertRecovered,
  names, marker, companion, identity, done, seedTransaction, dump, writeMarker, drain };
