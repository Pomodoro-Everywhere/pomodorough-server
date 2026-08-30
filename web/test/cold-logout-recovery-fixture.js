"use strict";

const { accountUser, ownerId } = require("./incarnation-fixture.js");

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { IDBFactory } = require("fake-indexeddb");
const storage = require("../sync-storage.js");
const syncCore = require("../sync-core.js");
const runtimeModule = require("../app-runtime.js");
const { SharedCore } = require("../shared-core.js");
const metadata = require("../shared-core-metadata.js");
const modules = Object.fromEntries(["State", "Storage", "Actions", "Sync", "Bootstrap", "Session", "View"]
  .map((name) => [`PomodoroughApp${name}`, require(`../app-${name.toLowerCase()}.js`)]));
const stores = ["meta", "pending", "pendingTasks", "pendingDurations", "pendingAutoStarts", "pendingSelectedTasks"];
const markerKey = "pomodoroughPendingLogout";
const ownerKey = "pomodoroughPendingLogoutOwner";
let corePromise;

async function loadCore() {
  globalThis.crypto ||= crypto.webcrypto;
  const bytes = fs.readFileSync(path.join(__dirname, "../pomodorough_core.wasm"));
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), metadata.sha256);
  assert.deepEqual(bytes, fs.readFileSync(path.join(__dirname, "../../internal/sharedcore/pomodorough_core.wasm")));
  corePromise ||= SharedCore.fromBytes(bytes);
  const core = await corePromise;
  storage.setSharedCore(core);
  return core;
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
}

function headlessView(calls) {
  return {
    manifest: modules.PomodoroughAppView.manifest,
    create: () => Object.fromEntries(modules.PomodoroughAppView.manifest.provides.map((name) => [
      name, (...args) => { calls.push([name, ...args]); }
    ]))
  };
}

function browserHost(indexedDB, localStorage, connections, calls) {
  return {
    indexedDB: {
      open(...args) {
        const request = indexedDB.open(...args);
        request.addEventListener("success", () => connections.add(request.result));
        return request;
      },
      deleteDatabase: () => { throw new Error("Database deletion forbidden in cold-logout fixture"); }
    },
    localStorage, sessionStorage: memoryStorage(), crypto: crypto.webcrypto,
    navigator: { onLine: false }, performance,
    document: { querySelector: () => ({}), querySelectorAll: () => [] },
    console: { warn: (...args) => calls.push(["warn", ...args]) },
    location: { assign: (url) => calls.push(["redirect", url]) },
    fetch: async (...args) => { calls.push(["fetch", ...args]); throw new Error("Offline fixture; network forbidden"); },
    setTimeout: (callback) => { calls.push(["timeout", callback]); return calls.length; },
    clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {},
    addEventListener: () => {}, confirm: () => true, prompt: () => null
  };
}

function createTab(indexedDB, localStorage, connections, core) {
  const calls = [];
  const host = browserHost(indexedDB, localStorage, connections, calls);
  const syncStorage = { ...storage };
  let runtime;
  const root = {
    ...host, ...modules, PomodoroughAppTest: { disableAutoStart: true },
    PomodoroughStorage: syncStorage, PomodoroughSync: syncCore,
    PomodoroughSharedCore: { SharedCore: { load: async () => core } },
    PomodoroughAppView: headlessView(calls),
    PomodoroughAppRuntime: {
      createRuntime(input) {
        const builder = runtimeModule.createRuntime(input);
        return { install: builder.install, finalize: () => { runtime = builder.finalize(); return runtime; } };
      }
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../app.js"), "utf8"), root, { filename: "app.js" });
  const use = runtime.facade(Object.values(modules).flatMap((module) => module.manifest.provides));
  return { host, calls, use, syncStorage, state: root.PomodoroughAppTest.state, initialize: root.PomodoroughApp.initialize };
}

function setOwner(tab, userId) {
  tab.state.user = accountUser(userId);
  tab.state.localOwnerId = ownerId(userId);
}

function snapshot(userId) {
  return {
    user: accountUser(userId), revision: 3, canonicalTimer: null, history: [], tasks: [],
    durationsMs: { focus: 1_500_000, short_break: 300_000, long_break: 900_000 },
    autoStartBreaks: false, selectedTaskId: null
  };
}

async function seedAccount(database, userId) {
  const transaction = database.transaction(stores, "readwrite");
  for (const name of stores) transaction.objectStore(name).clear();
  const meta = transaction.objectStore("meta");
  meta.put({ key: "snapshot", value: snapshot(userId) });
  meta.put({ key: "deviceId", value: `${userId}-device` });
  meta.put({ key: "deviceSequence", value: 19 });
  meta.put({ key: "hlc", value: { wallMs: 100, counter: 3 } });
  meta.put({ key: "settings", value: { selectedPhase: "focus", durationSyncBootstrapped: true } });
  meta.put({ key: "bootstrapGate", value: { token: `${userId}-tab`, expiresAtMs: Date.now() + 300_000 } });
  for (const name of stores.slice(1)) {
    transaction.objectStore(name).put({ id: `${userId}-${name}`, ownerId: userId, privateValue: `${name} retained` });
  }
  await storage.transactionDone(transaction);
}

async function dump(database) {
  const transaction = database.transaction(stores, "readonly");
  return Object.fromEntries(await Promise.all(stores.map(async (name) => [
    name, await storage.requestResult(transaction.objectStore(name).getAll())
  ])));
}

async function fixture(context, userId = "account-A") {
  const core = await loadCore();
  const indexedDB = new IDBFactory();
  const localStorage = memoryStorage();
  const connections = new Set();
  const openTab = () => createTab(indexedDB, localStorage, connections, core);
  context.after(() => { for (const database of connections) database.close(); });
  const issuer = openTab();
  setOwner(issuer, userId);
  const database = await issuer.use.openDatabase();
  issuer.use.setDatabaseForTest(database);
  await seedAccount(database, userId);
  issuer.use.markPendingLogout();
  return { issuer, cold: openTab(), openTab, database, localStorage };
}

function assertEmpty(records) {
  assert.ok(Object.values(records).every((values) => values.length === 0), JSON.stringify(records));
}

function pauseGuard(tab) {
  let entered;
  let resume;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const paused = new Promise((resolve) => { resume = resolve; });
  tab.syncStorage.guardedMutation = async (...args) => {
    entered();
    await paused;
    return storage.guardedMutation(...args);
  };
  return { waiting, resume };
}

module.exports = { storage, stores, markerKey, ownerKey, fixture, dump, seedAccount, setOwner, assertEmpty, pauseGuard };
