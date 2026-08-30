"use strict";

const { accountUser, ownerId } = require("./incarnation-fixture.js");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { IDBFactory } = require("fake-indexeddb");
const storage = require("../sync-storage.js");
const sync = require("../sync-core.js");
const stateModule = require("../app-state.js");
const storageModule = require("../app-storage.js");
const actionModule = require("../app-actions.js");
const syncModule = require("../app-sync.js");
const bootstrapModule = require("../app-bootstrap.js");
const { SharedCore } = require("../shared-core.js");
const stores = ["meta", "pending", "pendingTasks", "pendingDurations", "pendingAutoStarts", "pendingSelectedTasks"];
const nowMs = Date.parse("2026-08-30T12:00:00Z");
let sharedCorePromise;

async function loadCore() {
  globalThis.crypto ||= crypto.webcrypto;
  const bytes = fs.readFileSync(path.join(__dirname, "../pomodorough_core.wasm"));
  sharedCorePromise ||= SharedCore.fromBytes(bytes);
  const core = await sharedCorePromise;
  storage.setSharedCore(core);
  return { core, hash: crypto.createHash("sha256").update(bytes).digest("hex") };
}

function snapshot(userId, timerStatus = null) {
  return {
    user: accountUser(userId), revision: 3,
    serverTime: new Date(nowMs).toISOString(), history: [], tasks: [],
    canonicalTimer: timerStatus ? {
      id: "shared-timer", phase: "focus", status: timerStatus, plannedDurationMs: 1_500_000,
      elapsedAtAnchorMs: 0, anchorAt: new Date(nowMs).toISOString(), startedByDeviceId: "shared-device"
    } : null,
    durationsMs: { focus: 1_500_000, short_break: 300_000, long_break: 900_000 },
    autoStartBreaks: true, selectedTaskId: null
  };
}

async function seedMeta(database, values) {
  const transaction = database.transaction("meta", "readwrite");
  for (const [key, value] of Object.entries(values)) transaction.objectStore("meta").put({ key, value });
  await storage.transactionDone(transaction);
}

async function dump(database) {
  const transaction = database.transaction(stores, "readonly");
  const entries = await Promise.all(stores.map(async (storeName) => [
    storeName, await storage.requestResult(transaction.objectStore(storeName).getAll())
  ]));
  return Object.fromEntries(entries);
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

function stubHost(indexedDB, tabId, calls, callbacks) {
  return {
    crypto: crypto.webcrypto, indexedDB, navigator: { onLine: true },
    sessionStorage: { getItem: () => tabId, setItem: () => {} },
    console: { warn: (...values) => calls.push(["warn", ...values]) },
    fetch: async () => { throw new Error("Network forbidden in ownership fixture"); },
    setTimeout: (callback, delay) => { callbacks.push({ callback, delay }); return callbacks.length; },
    clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {}
  };
}

async function app(indexedDB, userId, tabId, core) {
  const calls = [];
  const callbacks = [];
  const host = stubHost(indexedDB, tabId, calls, callbacks);
  const state = stateModule.createState(host);
  Object.assign(state, {
    ready: true, authenticated: true, sessionIdentityValidated: true,
    user: accountUser(userId), localOwnerId: ownerId(userId),
    deviceId: "shared-device", csrfToken: "stub-csrf", bootstrapBlocked: false
  });
  const use = {
    render: () => {}, renderSyncStatus: () => {}, renderDurations: () => {},
    renderTaskSelector: () => {}, renderTimer: () => calls.push("render-timer"),
    showNotice: (message) => calls.push(["notice", message]),
    openRevisionStream: () => {}, closeRevisionStream: () => {}, renderBootstrapDialog: () => {},
    queueSessionRevalidation: () => calls.push("revalidate")
  };
  const external = {
    host, syncCore: sync, syncStorage: storage, elements: {},
    sharedCoreHost: { SharedCore: { load: async () => core } }
  };
  for (const module of [stateModule, storageModule, actionModule, syncModule, bootstrapModule]) {
    Object.assign(use, module.create({ state, external, use, listen: () => {} }));
  }
  use.trustedNow = () => nowMs;
  use.scheduleSync = () => calls.push("sync-scheduled");
  use.setDatabaseForTest(await use.openDatabase());
  return { state, use, external, calls, callbacks };
}

async function fixture(context, timerStatus = null, owner = "account-A") {
  context.mock.timers.enable({ apis: ["Date"], now: nowMs });
  const { core } = await loadCore();
  const indexedDB = new IDBFactory();
  const apps = [];
  const open = async (userId, tabId = `tab-${apps.length}`) => {
    const current = await app(indexedDB, userId, tabId, core);
    apps.push(current);
    return current;
  };
  const stale = await open(owner);
  const peer = await open("account-B");
  await seedMeta(stale.use.database(), {
    snapshot: snapshot(owner, timerStatus), deviceId: "shared-device", deviceSequence: 7,
    hlc: { wallMs: nowMs, counter: 2 }, [storage.UUID7_KEY]: storage.uuid7FromParts(nowMs, 20n),
    settings: { selectedPhase: "focus", durationSyncBootstrapped: true,
      autoStartSyncBootstrapped: true, selectedTaskSyncBootstrapped: true }
  });
  await stale.use.reloadPersistedState();
  context.after(() => { for (const current of apps) current.use.database()?.close(); });
  return { stale, peer, core, indexedDB, open };
}

async function switchOwner(peer, userId = "account-B", timerStatus = null) {
  const database = peer.use.database();
  peer.state.user = accountUser(userId);
  const token = peer.use.tabId();
  await storage.acquireBootstrapGate(database, { token, nowMs, leaseMs: 300_000 });
  const pending = await storage.captureResolution(database, {
    userId: ownerId(userId), requestId: crypto.randomUUID(), deviceId: "shared-device", expectedRevision: 3, strategy: "keep_remote"
  }, { gateToken: token, replaceExisting: false });
  assert.deepEqual(pending.payload.taskOperations, []);
  const payload = {
    ...snapshot(userId, timerStatus), accountIncarnation: accountUser(userId).accountIncarnation, acknowledgements: [], taskAcknowledgements: [],
    durationAcknowledgements: [], autoStartAcknowledgements: [], selectedTaskAcknowledgements: [],
    serverHlcWallMs: nowMs, serverHlcCounter: 0
  };
  delete payload.user;
  await peer.use.acceptBootstrapResponse(payload, pending, null);
  assert.equal(peer.state.localOwnerId, ownerId(userId));
  assert.equal(peer.use.controlsBlocked(), false);
}

function assertQuarantined(current) {
  assert.equal(current.use.controlsBlocked(), true);
  assert.equal(current.state.sessionIdentityValidated, false);
  assert.equal(current.state.offlineOwnerMode, false);
  assert.equal(current.state.bootstrapGateOwned, false);
  assert.ok(current.state.quarantinedLocal);
  assert.deepEqual(current.state.pendingTaskOperations, []);
  assert.ok(current.calls.includes("revalidate"));
}

module.exports = { storage, sync, stores, nowMs, loadCore, snapshot, seedMeta, dump, deferred, fixture, switchOwner, assertQuarantined };
