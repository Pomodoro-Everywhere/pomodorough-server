"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const Module = require("node:module");
function actionModule(name) {
  if (name === "app-sync.js" && process.env.CORE_PWA02_SYNC_BASELINE_DIR) {
    const filename = path.join(__dirname, name);
    const loaded = new Module(filename, module);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(__dirname);
    loaded._compile(fs.readFileSync(path.join(process.env.CORE_PWA02_SYNC_BASELINE_DIR, name), "utf8"), filename);
    return loaded.exports;
  }
  if (!process.env.CORE_PWA02_BASELINE_DIR) return require(`./${name}`);
  const filename = path.join(__dirname, name);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(__dirname);
  loaded._compile(fs.readFileSync(path.join(process.env.CORE_PWA02_BASELINE_DIR, name), "utf8"), filename);
  return loaded.exports;
}
const syncModule = actionModule("app-sync.js");
const { accountUser } = require("./test/incarnation-fixture.js");
const { fixture, storage, sync, dump, seedMeta, snapshot, deferred, nowMs } = require("./test/account-ownership-fixture.js");
const evidence = [];

test.after(() => {
  if (process.env.CORE_PWA02_EVIDENCE) fs.writeFileSync(process.env.CORE_PWA02_EVIDENCE,
    JSON.stringify({ provenance: require("./shared-core-metadata.js"), cases: evidence }, null, 2));
});

function owner(current) { return sync.accountOwnerId(current.state.user); }

function watchEffects(current) {
  const scheduled = new Map();
  const events = [];
  const posts = [];
  let nextId = 0;
  current.external.host.setTimeout = (callback, delay) => {
    const id = ++nextId;
    scheduled.set(id, { callback, delay });
    events.push({ kind: "schedule", delay, ownerId: owner(current) });
    return id;
  };
  current.external.host.clearTimeout = (id) => scheduled.delete(id);
  current.external.host.Notification = class {
    static permission = "granted";
    constructor(title, options) { events.push({ kind: "notification", title, ...options, ownerId: owner(current) }); }
    close() {}
  };
  current.use.render = () => events.push({ kind: "render", ownerId: owner(current) });
  current.use.renderSyncStatus = () => events.push({ kind: "renderSyncStatus", ownerId: owner(current) });
  current.use.renderTimer = () => events.push({ kind: "renderTimer", ownerId: owner(current), timerId: current.state.timer.id });
  current.use.postMutation = async (url, body, ownerId) => {
    posts.push({ url, body, ownerId });
    throw new Error("controlled lost response");
  };
  Object.assign(current.use, syncModule.create({ state: current.state, external: current.external,
    use: current.use, listen() {} }));
  return { scheduled, events, posts, reset: () => { scheduled.clear(); events.length = 0; posts.length = 0; } };
}

async function setup(t, status = null) {
  const result = await fixture(t, status);
  if (process.env.CORE_PWA02_BASELINE_DIR) {
    const database = result.stale.use.database();
    for (const name of ["app-storage.js", "app-actions.js"]) Object.assign(result.stale.use,
      actionModule(name).create({ state: result.stale.state, external: result.stale.external, use: result.stale.use }));
    result.stale.use.setDatabaseForTest(database);
  }
  await seedMeta(result.stale.use.database(), { canonicalHead: { wallMs: nowMs, counter: 2 } });
  await result.stale.use.reloadPersistedState();
  const effects = watchEffects(result.stale);
  return { ...result, effects };
}

function replaceMemory(current, replacement) {
  current.state.user = replacement;
  current.state.localOwnerId = sync.accountOwnerId(replacement);
}

function invalidateMarker(current) {
  current.external.host.localStorage = { getItem: (key) => key === "pomodoroughPendingLogout" ? "1" : "new-marker" };
}

const identityChanges = [
  { name: "different account", change: (current) => replaceMemory(current, accountUser("account-B")) },
  { name: "same public ID, new incarnation", change: (current) => replaceMemory(current, accountUser("account-A", 2)) },
  { name: "same owner, new logout context", change: invalidateMarker }
];

function changeAfterReload(current, change) {
  const rebuild = current.use.rebuildOptimisticState;
  let changed = false;
  current.use.rebuildOptimisticState = () => {
    rebuild();
    if (!changed) { changed = true; queueMicrotask(() => change(current)); }
  };
}

async function flush(callbacks) {
  for (const { callback } of callbacks) await callback();
}

function record(name, values) {
  evidence.push({ case: name, ...structuredClone(values) });
}

for (const scenario of identityChanges) {
  test(`CORE-PWA02 action fences post-reload microtask: ${scenario.name}`, async (t) => {
    const { stale, effects } = await setup(t);
    const issuedOwner = owner(stale);
    changeAfterReload(stale, scenario.change);
    const returned = await stale.use.issueCommand("start");
    const persistedBeforeCallbacks = await dump(stale.use.database());
    await flush([...effects.scheduled.values()]);
    const persistedAfterCallbacks = await dump(stale.use.database());
    record(t.name, { returned, issuedOwner, finalOwner: owner(stale), events: effects.events,
      posts: effects.posts, persistedBeforeCallbacks, persistedAfterCallbacks });
    assert.equal(returned, false);
    assert.equal(persistedBeforeCallbacks.pending[0].type, "start", "A Start really commits before the race");
    assert.equal(effects.events.some((event) => ["render", "schedule", "notification", "renderTimer"].includes(event.kind)), false);
    assert.deepEqual(effects.posts, []);
    assert.deepEqual(persistedAfterCallbacks, persistedBeforeCallbacks);
  });

  test(`CORE-PWA02 repository rechecks after persisted reload: ${scenario.name}`, async (t) => {
    const { stale, effects } = await setup(t);
    changeAfterReload(stale, scenario.change);
    let result;
    let error;
    try { result = await stale.use.persistWorkspaceIntent({ kind: "start" }); }
    catch (failure) { error = failure; }
    const persisted = await dump(stale.use.database());
    record(t.name, { result, errorName: error?.name, persisted, events: effects.events });
    assert.equal(error?.name, "AccountOwnershipError");
    assert.equal(persisted.pending[0].type, "start");
    assert.equal(effects.events.some((event) => event.kind === "schedule" || event.kind === "notification"), false);
  });
}

async function keepRemote(peer, replacement) {
  peer.state.user = replacement;
  const gateToken = peer.use.tabId();
  await storage.acquireBootstrapGate(peer.use.database(), { token: gateToken, nowMs, leaseMs: 300000 });
  const pending = await storage.captureResolution(peer.use.database(), { userId: owner(peer),
    requestId: crypto.randomUUID(), deviceId: peer.state.deviceId, expectedRevision: peer.state.revision,
    strategy: "keep_remote" }, { gateToken });
  const payload = { ...snapshot(replacement.id, "running"), accountIncarnation: replacement.accountIncarnation,
    canonicalTimer: { ...snapshot(replacement.id, "running").canonicalTimer, id: "replacement-private-timer" },
    acknowledgements: [], taskAcknowledgements: [], durationAcknowledgements: [],
    autoStartAcknowledgements: [], selectedTaskAcknowledgements: [], serverHlcWallMs: nowMs, serverHlcCounter: 100 };
  delete payload.user;
  await peer.use.acceptBootstrapResponse(payload, pending, null, peer.use.captureAccountContext());
  await peer.use.persistDurationOperation("focus", 1800000);
  return dump(peer.use.database());
}

async function adoptReplacement(current, replacement) {
  replaceMemory(current, replacement);
  await current.use.reloadPersistedState();
}

const replacements = [accountUser("account-B"), accountUser("account-A", 2)];

function pauseCommittedReturn(current, method) {
  const committed = deferred();
  const release = deferred();
  const persist = current.use[method];
  current.use[method] = async (...args) => {
    const plan = await persist(...args);
    committed.resolve(plan);
    await release.promise;
    return plan;
  };
  return { committed, release };
}

for (const replacement of replacements) {
  test(`CORE-PWA02 delayed committed Finish cannot alert or sync replacement ${replacement.id}`, async (t) => {
    const { stale, peer, effects } = await setup(t, "running");
    const { committed, release } = pauseCommittedReturn(stale, "persistWorkspaceCompletion");
    const issuing = stale.use.finishTimer(false);
    const plan = await committed.promise;
    assert.equal(plan.outcome, "planned");
    assert.equal((await dump(stale.use.database())).pending[0].type, "finish");
    const replacementBefore = await keepRemote(peer, replacement);
    await adoptReplacement(stale, replacement);
    effects.reset();
    release.resolve();
    const returned = await issuing;
    await flush([...effects.scheduled.values()]);
    const replacementAfter = await dump(peer.use.database());
    record(t.name, { plan, returned, replacementBefore, replacementAfter, alertTimerId: stale.use.activeCompletionAlertTimerId(),
      events: effects.events, posts: effects.posts });
    assert.equal(returned, false);
    assert.equal(stale.use.activeCompletionAlertTimerId(), null);
    assert.deepEqual(effects.posts, []);
    assert.equal(effects.events.some((event) => ["notification", "schedule", "render", "renderTimer"].includes(event.kind)), false);
    assert.deepEqual(replacementAfter, replacementBefore);
    assert.equal(stale.state.timer.id, "replacement-private-timer");
  });

  test(`CORE-PWA02 delayed committed Start cannot render or schedule replacement ${replacement.id}`, async (t) => {
    const { stale, peer, effects } = await setup(t);
    const { committed, release } = pauseCommittedReturn(stale, "persistWorkspaceIntent");
    const issuing = stale.use.issueCommand("start");
    const plan = await committed.promise;
    assert.equal(plan.outcome, "planned");
    assert.equal((await dump(stale.use.database())).pending[0].id, plan.commands[0].id);
    const replacementBefore = await keepRemote(peer, replacement);
    await adoptReplacement(stale, replacement);
    effects.reset();
    release.resolve();
    const returned = await issuing;
    await flush([...effects.scheduled.values()]);
    const replacementAfter = await dump(peer.use.database());
    record(t.name, { plan, returned, replacementBefore, replacementAfter, events: effects.events, posts: effects.posts });
    assert.equal(returned, false);
    assert.deepEqual(effects.events, []);
    assert.deepEqual(effects.posts, []);
    assert.deepEqual(replacementAfter, replacementBefore);
    assert.equal(stale.state.timer.id, "replacement-private-timer");
  });

  test(`CORE-PWA02 queued Core effects retain issuer after replacement ${replacement.id}`, async (t) => {
    const { stale, peer, effects } = await setup(t);
    assert.equal(await stale.use.issueCommand("start"), true);
    const queued = [...effects.scheduled.values()];
    assert.deepEqual(queued.map((item) => item.delay), [0, 1500000]);
    const replacementBefore = await keepRemote(peer, replacement);
    await adoptReplacement(stale, replacement);
    effects.reset();
    await flush(queued);
    const replacementAfter = await dump(peer.use.database());
    record(t.name, { replacementBefore, replacementAfter, events: effects.events, posts: effects.posts });
    assert.deepEqual(effects.posts, []);
    assert.deepEqual(effects.events, []);
    assert.deepEqual(replacementAfter, replacementBefore);
  });
}

test("CORE-PWA02 render-triggered context change stops remaining post-commit effects", async (t) => {
  const { stale, effects } = await setup(t);
  stale.use.render = () => { effects.events.push({ kind: "render", ownerId: owner(stale) }); invalidateMarker(stale); };
  const returned = await stale.use.issueCommand("start");
  const beforeCallbacks = await dump(stale.use.database());
  await flush([...effects.scheduled.values()]);
  record(t.name, { returned, events: effects.events, posts: effects.posts, beforeCallbacks,
    afterCallbacks: await dump(stale.use.database()) });
  assert.equal(returned, false);
  assert.deepEqual(effects.events.map((event) => event.kind), ["render"]);
  assert.deepEqual(effects.posts, []);
  assert.deepEqual(await dump(stale.use.database()), beforeCallbacks);
});

test("CORE-PWA02 queued sync rechecks issuer after asynchronous preflight", async (t) => {
  const { stale, peer, effects } = await setup(t);
  const preflight = stale.use.syncPreflight;
  // Rebind the coordinator with the real preflight paused after its persisted read.
  const external = { ...stale.external, syncStorage: { ...storage, readBootstrapState: async (...args) => {
    const result = await storage.readBootstrapState(...args);
    await keepRemote(peer, accountUser("account-B"));
    await adoptReplacement(stale, accountUser("account-B"));
    return result;
  } } };
  const coordinator = syncModule.create({ state: stale.state, external, use: stale.use, listen() {} });
  stale.use.scheduleSync = coordinator.scheduleSync;
  assert.equal(await stale.use.issueCommand("start"), true);
  const queued = [...effects.scheduled.values()];
  await flush(queued.filter((item) => item.delay === 0));
  const replacementAfter = await dump(peer.use.database());
  record(t.name, { posts: effects.posts, replacementAfter });
  assert.deepEqual(effects.posts, []);
  assert.equal(replacementAfter.meta.some((record) => record.key === "outgoingSync"), false);
  assert.equal(stale.state.timer.id, "replacement-private-timer");
  assert.equal(typeof preflight, "function");
});

test("CORE-PWA02 completion retry retains issuing logout context", async (t) => {
  const { stale, effects } = await setup(t, "running");
  await seedMeta(stale.use.database(), { timerOwner: { timerId: stale.state.timer.id, deviceId: stale.state.deviceId,
    tabId: "peer-owner-tab", leaseExpiresAtMs: nowMs + 15000 } });
  t.mock.timers.setTime(nowMs + stale.state.timer.plannedDurationMs);
  stale.use.trustedNow = () => Date.now();
  await seedMeta(stale.use.database(), { timerOwner: { timerId: stale.state.timer.id, deviceId: stale.state.deviceId,
    tabId: "peer-owner-tab", leaseExpiresAtMs: Date.now() + 15000 } });
  const returned = await stale.use.finishTimer(true);
  const queued = [...effects.scheduled.values()];
  assert.equal(returned, true);
  assert.equal(queued.length, 1);
  const before = await dump(stale.use.database());
  invalidateMarker(stale);
  effects.reset();
  await flush(queued);
  record(t.name, { before, after: await dump(stale.use.database()), events: effects.events, posts: effects.posts });
  assert.deepEqual(effects.events, []);
  assert.deepEqual(await dump(stale.use.database()), before);
});

test("CORE-PWA02 coalesced sync follow-up cannot recapture replacement account", async (t) => {
  const { stale, peer, effects } = await setup(t);
  const posted = deferred();
  const response = deferred();
  stale.use.postMutation = async (url, body, ownerId) => {
    effects.posts.push({ url, body, ownerId });
    posted.resolve();
    return response.promise;
  };
  const context = stale.use.captureAccountContext();
  assert.equal(await stale.use.issueCommand("start"), true);
  const syncing = [...effects.scheduled.values()].find((item) => item.delay === 0).callback();
  await posted.promise;
  const joined = stale.use.syncNow(true, context);
  const replacementBefore = await keepRemote(peer, accountUser("account-B"));
  await adoptReplacement(stale, accountUser("account-B"));
  effects.reset();
  response.resolve({ response: { ok: false, status: 401 } });
  let error;
  try { await Promise.all([syncing, joined]); } catch (failure) { error = failure; }
  await flush([...effects.scheduled.values()]);
  record(t.name, { errorName: error?.name, events: effects.events, posts: effects.posts,
    replacementBefore, replacementAfter: await dump(peer.use.database()) });
  assert.equal(error, undefined, "stale completion is classified, not an unhandled promise rejection");
  assert.equal(effects.events.some((event) => event.kind === "schedule"), false);
  assert.deepEqual(effects.events, [], "the old completion must not render the replacement workspace");
  assert.deepEqual(effects.posts, []);
  assert.deepEqual(await dump(peer.use.database()), replacementBefore);
});

test("CORE-PWA02 normal Finish preserves notification, sync and generated-break alarm effects", async (t) => {
  const { stale, effects } = await setup(t, "running");
  const persist = stale.use.persistWorkspaceCompletion;
  let plan;
  stale.use.persistWorkspaceCompletion = async (...args) => { plan = await persist(...args); return plan; };
  const returned = await stale.use.finishTimer(false);
  const persisted = await dump(stale.use.database());
  record(t.name, { plan, returned, persisted, events: effects.events });
  assert.equal(returned, true);
  assert.deepEqual(plan.effectsAfterCommit.map((effect) => effect.kind), ["launchSync", "cancelAlarm", "scheduleAlarm"]);
  assert.equal(stale.use.activeCompletionAlertTimerId(), "shared-timer");
  assert.deepEqual(effects.events.map((event) => event.kind), ["notification", "render", "schedule", "schedule"]);
  assert.deepEqual([...effects.scheduled.values()].map((item) => item.delay), [0, plan.effectsAfterCommit[2].durationMs]);
  assert.deepEqual(persisted.pending.map((command) => command.id), plan.atomicCommandIds);
  assert.ok(effects.events.every((event) => event.ownerId === owner(stale)));
});

test("CORE-PWA02 supported normal action keeps ordered Core effects and owner-bound POST", async (t) => {
  const { stale, effects } = await setup(t);
  const issuedOwner = owner(stale);
  assert.equal(await stale.use.issueCommand("start"), true);
  const queued = [...effects.scheduled.values()];
  const persisted = await dump(stale.use.database());
  assert.deepEqual(effects.events.map((event) => event.kind), ["render", "schedule", "schedule"]);
  assert.deepEqual(queued.map((item) => item.delay), [0, 1500000]);
  await flush(queued);
  assert.equal(effects.posts.length, 1);
  assert.equal(effects.posts[0].ownerId, issuedOwner);
  assert.equal(JSON.parse(effects.posts[0].body).commands[0].id, persisted.pending[0].id);
  assert.ok(effects.events.some((event) => event.kind === "renderTimer" && event.ownerId === issuedOwner));
  record(t.name, { persisted, events: effects.events, posts: effects.posts });
});

function replacementMemory(current) {
  return structuredClone(current.use.ownerStateValue());
}

function pauseTransport(current, effects) {
  const posted = deferred();
  const response = deferred();
  current.use.postMutation = async (url, body, ownerId) => {
    effects.posts.push({ url, body, ownerId });
    posted.resolve();
    const value = await response.promise;
    if (value instanceof Error) throw value;
    return value;
  };
  return { posted, response };
}

function firstSyncCallback(effects) {
  const callback = [...effects.scheduled.entries()].find(([, item]) => item.delay === 0);
  assert.ok(callback, "the real Core Start schedules sync after its IndexedDB commit");
  effects.scheduled.delete(callback[0]);
  return callback[1].callback();
}

async function settleBackoff(callback) {
  await callback();
  // The rejected scheduler does not return its sync promise. Let its real
  // IndexedDB requests finish so baseline evidence cannot miss a later POST.
  for (let turn = 0; turn < 40; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

for (const replacement of replacements) {
  test(`CORE-PWA02 direct forced join keeps its issuing render/retry scope after replacement ${replacement.id}`, async (t) => {
    const { stale, peer, effects } = await setup(t);
    const transport = pauseTransport(stale, effects);
    assert.equal(await stale.use.issueCommand("start"), true);
    effects.reset();
    const syncing = stale.use.syncNow(false);
    await transport.posted.promise;
    const joined = stale.use.syncNow(true);
    const before = await keepRemote(peer, replacement);
    await adoptReplacement(stale, replacement);
    effects.reset();
    transport.response.resolve({ response: { ok: false, status: 401 } });
    await Promise.all([syncing, joined]);
    await flush([...effects.scheduled.values()]);
    record(t.name, { before, after: await dump(peer.use.database()), events: effects.events, posts: effects.posts });
    assert.deepEqual(effects.events, []);
    assert.deepEqual(effects.posts, []);
    assert.deepEqual(await dump(peer.use.database()), before);
    assert.equal(stale.state.syncing, false);
  });

  test(`CORE-PWA02 backoff from A lost Start response cannot claim or POST replacement ${replacement.id}`, async (t) => {
    const { stale, peer, effects } = await setup(t);
    assert.equal(await stale.use.issueCommand("start"), true);
    await firstSyncCallback(effects);
    const retainedA = await dump(stale.use.database());
    const outgoingA = retainedA.meta.find((item) => item.key === "outgoingSync").value;
    assert.equal(outgoingA.sent.commands[0].type, "start");
    assert.deepEqual(JSON.parse(outgoingA.body).commands, outgoingA.sent.commands);
    const backoff = [...effects.scheduled.values()].find((item) => item.delay === 1000);
    assert.ok(backoff, "the production error path arms A's backoff");
    const replacementBefore = await keepRemote(peer, replacement);
    await adoptReplacement(stale, replacement);
    const memoryBefore = replacementMemory(stale);
    effects.reset();
    await settleBackoff(backoff.callback);
    const replacementAfter = await dump(peer.use.database());
    record(t.name, { outgoingA, replacementBefore, replacementAfter, memoryBefore,
      memoryAfter: replacementMemory(stale), events: effects.events, posts: effects.posts });
    assert.deepEqual(effects.posts, []);
    assert.deepEqual(effects.events, []);
    assert.deepEqual(replacementAfter, replacementBefore);
    assert.deepEqual(replacementMemory(stale), memoryBefore);
  });

  test(`CORE-PWA02 awaited committed A claim cannot publish proof or outgoing under replacement ${replacement.id}`, async (t) => {
    const { stale, peer, effects } = await setup(t);
    const committed = deferred();
    const release = deferred();
    const external = { ...stale.external, syncStorage: { ...storage, claimWorkspaceBatch: async (...args) => {
      const result = await storage.claimWorkspaceBatch(...args);
      committed.resolve(result);
      await release.promise;
      return result;
    } } };
    Object.assign(stale.use, syncModule.create({ state: stale.state, external, use: stale.use, listen() {} }));
    assert.equal(await stale.use.issueCommand("start"), true);
    const syncing = firstSyncCallback(effects);
    const claim = await committed.promise;
    assert.equal((await dump(stale.use.database())).meta.find((item) => item.key === "outgoingSync").value.body, claim.claim.body);
    const replacementBefore = await keepRemote(peer, replacement);
    await adoptReplacement(stale, replacement);
    const memoryBefore = replacementMemory(stale);
    effects.reset();
    release.resolve();
    await syncing;
    const replacementAfter = await dump(peer.use.database());
    record(t.name, { claim, replacementBefore, replacementAfter, memoryBefore,
      memoryAfter: replacementMemory(stale), events: effects.events, posts: effects.posts });
    assert.deepEqual(replacementMemory(stale), memoryBefore, "no A claim/proof publishes before the ownership check");
    assert.deepEqual(effects.events, []);
    assert.deepEqual(effects.posts, []);
    assert.deepEqual(replacementAfter, replacementBefore);
    assert.equal(stale.state.syncing, false, "the old operation releases its single-flight state");
  });

  for (const failure of ["controlled late network error", "possibly delivered old claim needs recovery"]) {
    test(`CORE-PWA02 late ${failure} cannot render or arm replacement ${replacement.id}`, async (t) => {
      const { stale, peer, effects } = await setup(t);
      const transport = pauseTransport(stale, effects);
      assert.equal(await stale.use.issueCommand("start"), true);
      const syncing = firstSyncCallback(effects);
      await transport.posted.promise;
      const replacementBefore = await keepRemote(peer, replacement);
      await adoptReplacement(stale, replacement);
      const memoryBefore = replacementMemory(stale);
      const retryingBefore = stale.state.retrying;
      effects.reset();
      transport.response.resolve(new Error(failure));
      await syncing;
      await flush([...effects.scheduled.values()]);
      record(t.name, { failure, replacementBefore, replacementAfter: await dump(peer.use.database()),
        events: effects.events, posts: effects.posts, retryingBefore, retryingAfter: stale.state.retrying });
      assert.deepEqual(effects.events, []);
      assert.deepEqual(effects.posts, []);
      assert.equal(stale.state.retrying, retryingBefore);
      assert.deepEqual(replacementMemory(stale), memoryBefore);
      assert.deepEqual(await dump(peer.use.database()), replacementBefore);
    });
  }
}

test("CORE-PWA02 actual clearLocalData teardown invalidates a queued retry even with the same account restored", async (t) => {
  const { stale, peer, effects, open } = await setup(t);
  assert.equal(await stale.use.issueCommand("start"), true);
  await firstSyncCallback(effects);
  const backoff = [...effects.scheduled.values()].find((item) => item.delay === 1000);
  assert.ok(backoff);
  const oldDatabase = stale.use.database();
  await stale.use.clearLocalData(undefined, stale.use.captureDatabaseContext());
  assert.equal(stale.use.database(), null);
  const fresh = await open("account-A");
  await seedMeta(fresh.use.database(), { snapshot: snapshot("account-A"), deviceId: "shared-device",
    hlc: { wallMs: nowMs, counter: 200 }, deviceSequence: 7, settings: { selectedPhase: "focus" } });
  stale.use.setDatabaseForTest(fresh.use.database());
  assert.notEqual(stale.use.database(), oldDatabase);
  await stale.use.reloadPersistedState();
  await stale.use.persistDurationOperation("focus", 1800000);
  const before = await dump(peer.use.database());
  effects.reset();
  await settleBackoff(backoff.callback);
  record(t.name, { before, after: await dump(peer.use.database()), events: effects.events, posts: effects.posts });
  assert.deepEqual(effects.events, []);
  assert.deepEqual(effects.posts, []);
  assert.deepEqual(await dump(peer.use.database()), before);
});

test("CORE-PWA02 actual clearLocalData teardown fences a delayed committed claim return", async (t) => {
  const { stale, peer, effects } = await setup(t);
  const committed = deferred();
  const release = deferred();
  const external = { ...stale.external, syncStorage: { ...storage, claimWorkspaceBatch: async (...args) => {
    const result = await storage.claimWorkspaceBatch(...args);
    committed.resolve(result);
    await release.promise;
    return result;
  } } };
  Object.assign(stale.use, syncModule.create({ state: stale.state, external, use: stale.use, listen() {} }));
  assert.equal(await stale.use.issueCommand("start"), true);
  const syncing = firstSyncCallback(effects);
  const claim = await committed.promise;
  await stale.use.clearLocalData(undefined, stale.use.captureDatabaseContext());
  assert.equal(stale.use.database(), null);
  const before = await dump(peer.use.database());
  const memoryBefore = replacementMemory(stale);
  effects.reset();
  release.resolve();
  await syncing;
  record(t.name, { claim, before, after: await dump(peer.use.database()), events: effects.events,
    memoryBefore, memoryAfter: replacementMemory(stale), posts: effects.posts });
  assert.deepEqual(replacementMemory(stale), memoryBefore);
  assert.deepEqual(effects.events, []);
  assert.deepEqual(effects.posts, []);
  assert.deepEqual(await dump(peer.use.database()), before);
});

test("CORE-PWA02 delayed claim checks changed local owner even when issuing session incarnation is unchanged", async (t) => {
  const { stale, peer, effects } = await setup(t);
  const committed = deferred();
  const release = deferred();
  const external = { ...stale.external, syncStorage: { ...storage, claimWorkspaceBatch: async (...args) => {
    const result = await storage.claimWorkspaceBatch(...args);
    committed.resolve(result);
    await release.promise;
    return result;
  } } };
  Object.assign(stale.use, syncModule.create({ state: stale.state, external, use: stale.use, listen() {} }));
  assert.equal(await stale.use.issueCommand("start"), true);
  const syncing = firstSyncCallback(effects);
  const claim = await committed.promise;
  const before = await keepRemote(peer, accountUser("account-B"));
  await adoptReplacement(stale, accountUser("account-B"));
  stale.state.user = accountUser("account-A");
  const memoryBefore = replacementMemory(stale);
  effects.reset();
  release.resolve();
  await syncing;
  record(t.name, { claim, before, after: await dump(peer.use.database()), memoryBefore,
    memoryAfter: replacementMemory(stale), events: effects.events, posts: effects.posts });
  assert.deepEqual(replacementMemory(stale), memoryBefore);
  assert.deepEqual(effects.events, []);
  assert.deepEqual(effects.posts, []);
  assert.deepEqual(await dump(peer.use.database()), before);
});

test("CORE-PWA02 backoff callback keeps the original same-owner logout context", async (t) => {
  const { stale, effects } = await setup(t);
  assert.equal(await stale.use.issueCommand("start"), true);
  await firstSyncCallback(effects);
  const backoff = [...effects.scheduled.values()].find((item) => item.delay === 1000);
  assert.ok(backoff);
  const before = await dump(stale.use.database());
  invalidateMarker(stale);
  effects.reset();
  await settleBackoff(backoff.callback);
  record(t.name, { before, after: await dump(stale.use.database()), events: effects.events, posts: effects.posts });
  assert.deepEqual(effects.events, []);
  assert.deepEqual(effects.posts, []);
  assert.deepEqual(await dump(stale.use.database()), before);
});

test("CORE-PWA02 current-owner backoff still replays the exact committed Start claim", async (t) => {
  const { stale, effects } = await setup(t);
  const issuedOwner = owner(stale);
  assert.equal(await stale.use.issueCommand("start"), true);
  await firstSyncCallback(effects);
  const before = await dump(stale.use.database());
  const firstPost = structuredClone(effects.posts[0]);
  const backoff = [...effects.scheduled.values()].find((item) => item.delay === 1000);
  assert.ok(backoff);
  effects.reset();
  await settleBackoff(backoff.callback);
  const after = await dump(stale.use.database());
  record(t.name, { before, after, firstPost, posts: effects.posts, events: effects.events });
  assert.deepEqual(effects.posts, [firstPost]);
  assert.equal(effects.posts[0].ownerId, issuedOwner);
  assert.ok(effects.events.some((event) => event.kind === "render" && event.ownerId === issuedOwner));
  assert.ok([...effects.scheduled.values()].some((item) => item.delay === 2000));
  assert.deepEqual(after, before);
});
