"use strict";

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
const { SharedCore } = require("../shared-core.js");
const nowMs = Date.parse("2026-08-31T12:00:00Z");
const user = { id: "p222-account", accountIncarnation: "c".repeat(64) };
const stores = ["meta", "pending", "pendingTasks", "pendingDurations", "pendingAutoStarts", "pendingSelectedTasks"];
const queueStores = Object.fromEntries([
  ["commands", "pending"], ["taskOperations", "pendingTasks"], ["durationOperations", "pendingDurations"],
  ["autoStartOperations", "pendingAutoStarts"], ["selectedTaskOperations", "pendingSelectedTasks"]
]);
let corePromise;

function snapshot(overrides = {}) {
  return {
    user, revision: 3, serverTime: new Date(nowMs).toISOString(), canonicalTimer: null,
    history: [], tasks: [], selectedTaskId: null, autoStartBreaks: false,
    durationsMs: { focus: 1_500_000, short_break: 300_000, long_break: 900_000 }, ...overrides
  };
}

async function seedMeta(database, values) {
  const transaction = database.transaction("meta", "readwrite");
  for (const [key, value] of Object.entries(values)) transaction.objectStore("meta").put({ key, value });
  await storage.transactionDone(transaction);
}

async function seedQueues(database, queues) {
  const transaction = database.transaction(Object.values(queueStores), "readwrite");
  for (const [name, operations] of Object.entries(queues)) {
    for (const operation of operations) transaction.objectStore(queueStores[name]).add(operation);
  }
  await storage.transactionDone(transaction);
}

async function dump(database) {
  const transaction = database.transaction(stores, "readonly");
  const entries = await Promise.all(stores.map(async (name) => [
    name, await storage.requestResult(transaction.objectStore(name).getAll())
  ]));
  return Object.fromEntries(entries);
}

function meta(records, key) {
  return records.meta.find((record) => record.key === key)?.value;
}

async function app(indexedDB, tabId) {
  const notices = [];
  const host = {
    crypto: crypto.webcrypto, indexedDB, navigator: { onLine: false }, console,
    sessionStorage: { getItem: () => tabId, setItem: () => {} },
    setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {}
  };
  const state = stateModule.createState(host);
  Object.assign(state, {
    ready: true, authenticated: true, sessionIdentityValidated: true, user,
    localOwnerId: sync.accountOwnerId(user), deviceId: "p222-device", bootstrapBlocked: false
  });
  const use = {
    render: () => {}, renderTimer: () => {}, renderDurations: () => {}, renderTaskSelector: () => {},
    renderSyncStatus: () => {}, showNotice: (message) => notices.push(message), scheduleSync: () => {},
    queueSessionRevalidation: () => {}
  };
  const external = { host, syncCore: sync, syncStorage: storage, sharedCoreHost: {}, elements: {} };
  for (const module of [stateModule, storageModule, actionModule]) {
    Object.assign(use, module.create({ state, external, use }));
  }
  use.trustedNow = () => nowMs;
  use.setDatabaseForTest(await use.openDatabase());
  return { state, use, external, notices };
}

async function fixture(context, overrides = {}) {
  context.mock.timers.enable({ apis: ["Date"], now: nowMs });
  globalThis.crypto ||= crypto.webcrypto;
  corePromise ||= SharedCore.fromBytes(fs.readFileSync(path.join(__dirname, "../pomodorough_core.wasm")));
  const core = await corePromise;
  storage.setSharedCore(core);
  const indexedDB = new IDBFactory();
  const apps = [];
  const open = async () => {
    const current = await app(indexedDB, `p222-tab-${apps.length}`);
    apps.push(current);
    return current;
  };
  const client = await open();
  await seedMeta(client.use.database(), {
    snapshot: snapshot(overrides), deviceId: client.state.deviceId, deviceSequence: 7,
    hlc: { wallMs: nowMs, counter: 2 }, [storage.UUID7_KEY]: storage.uuid7FromParts(nowMs, 20n),
    settings: { selectedPhase: "focus", durationSyncBootstrapped: true,
      autoStartSyncBootstrapped: true, selectedTaskSyncBootstrapped: true }
  });
  await client.use.reloadPersistedState();
  context.after(() => { for (const current of apps) current.use.database()?.close(); });
  return { client, core, open };
}

async function startFocus(client) {
  assert.equal(await client.use.issueCommand("start", { phase: "focus" }), true, client.notices.join("; "));
}

function completionInput(client, withUuidV7, overrides = {}) {
  const timer = structuredClone(client.state.timer);
  return {
    ...client.use.captureAccountContext(), expectedUserId: sync.accountOwnerId(user),
    requestedTimer: timer, timerId: timer.id, phase: timer.phase, deviceId: client.state.deviceId,
    tabId: client.use.tabId(), leaseMs: 30_000, manual: true, requireOwner: false,
    nowMs, localNowMs: nowMs, observedElapsedMs: 0, withUuidV7,
    autoStartBreaks: client.state.autoStartBreaks, settings: client.use.settingsValue(),
    finishCommandId: "p222-finish", breakCommandId: "p222-break", breakTimerId: "p222-break-timer",
    ...overrides
  };
}

function completedFocusHistory() {
  return [1, 2, 3].map((ordinal) => ({
    id: `p222-history-${ordinal}`, timerId: `p222-timer-${ordinal}`, commandId: `p222-finish-${ordinal}`,
    phase: "focus", status: "completed", plannedDurationMs: 1_500_000,
    completedAt: new Date(nowMs - ordinal * 3_600_000).toISOString(),
    endedAt: new Date(nowMs - ordinal * 3_600_000).toISOString()
  }));
}

function project(core, records, atMs = nowMs) {
  const base = meta(records, "snapshot");
  const { user: ignoredUser, revision, serverTime, ...projectionBase } = base;
  return core.projectSynchronizedState({
    base: projectionBase,
    pending: Object.fromEntries(Object.entries(queueStores).map(([name, store]) => [name, records[store]])),
    now: new Date(atMs).toISOString()
  });
}

function assertBatch(before, after, input, outcome) {
  const highestSequence = Math.max(meta(before, "deviceSequence"), ...before.pending.map((item) => item.deviceSequence));
  const [finish, generated] = outcome.commands;
  const oldClock = meta(before, "hlc");
  const wallMs = Math.max(oldClock.wallMs, input.nowMs);
  const firstCounter = wallMs === oldClock.wallMs ? oldClock.counter + 1 : 0;
  const finishBody = {
    id: finish.id, deviceId: input.deviceId, deviceSequence: highestSequence + 1,
    timerId: input.timerId, type: "finish", phase: input.phase,
    plannedDurationMs: input.requestedTimer.plannedDurationMs, occurredAt: new Date(wallMs).toISOString(),
    hlcWallMs: wallMs, hlcCounter: firstCounter, observedElapsedMs: input.observedElapsedMs
  };
  if (input.requestedTimer.dependsOnCommandId) finishBody.dependsOnCommandId = input.requestedTimer.dependsOnCommandId;
  assert.deepEqual(finish, finishBody);
  if (generated) assert.deepEqual(generated, {
    id: generated.id, deviceId: input.deviceId, deviceSequence: highestSequence + 2,
    timerId: input.breakTimerId, type: "start", phase: outcome.selectedPhase,
    plannedDurationMs: outcome.selectedPhaseDurationMs, occurredAt: finish.occurredAt,
    hlcWallMs: wallMs, hlcCounter: firstCounter + 1, observedElapsedMs: 0,
    dependsOnCommandId: finish.id, generatedBreak: true
  });
  assert.equal(meta(after, "deviceSequence"), highestSequence + outcome.commands.length);
  assert.deepEqual(meta(after, "hlc"), { wallMs, counter: firstCounter + outcome.commands.length - 1 });
  assert.deepEqual(after.pending, before.pending.concat(outcome.commands).sort((left, right) => left.id.localeCompare(right.id)));
  for (const store of stores.slice(2)) assert.deepEqual(after[store], before[store]);
  if (input.withUuidV7) {
    assert.equal(meta(after, storage.UUID7_KEY), outcome.commands.at(-1).id);
    const finishParts = storage.uuid7Parts(finish.id);
    assert.equal(finishParts.timestampMs, wallMs);
    if (generated) assert.equal(storage.uuid7Parts(generated.id).randomValue, finishParts.randomValue + 1n);
  } else {
    assert.deepEqual(outcome.commands.map((command) => command.id), [input.finishCommandId, input.breakCommandId].slice(0, outcome.commands.length));
    assert.equal(meta(after, storage.UUID7_KEY), meta(before, storage.UUID7_KEY));
  }
}

module.exports = {
  storage, sync, nowMs, user, stores, fixture, seedMeta, seedQueues, dump, meta,
  snapshot, startFocus, completionInput, completedFocusHistory, project, assertBatch
};
