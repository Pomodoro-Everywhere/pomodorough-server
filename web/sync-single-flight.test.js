"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const appSync = require("./app-sync.js");
const { fixture, storage, deferred, snapshot, nowMs, switchOwner } = require("./test/account-ownership-fixture.js");

function controlledSync(current) {
  const preflight = deferred();
  const request = deferred();
  const posted = deferred();
  const reads = [];
  const posts = [];
  const inFlight = [];
  const timers = new Map();
  let nextTimer = 0;
  let failure = null;
  current.external.host.setTimeout = (callback, delay) => {
    timers.set(++nextTimer, { callback, delay });
    return nextTimer;
  };
  current.external.host.clearTimeout = (id) => timers.delete(id);
  current.external.syncStorage = { ...storage, async readBootstrapState(database) {
    reads.push(database);
    await preflight.promise;
    if (failure) throw failure;
    return storage.readBootstrapState(database);
  } };
  const setInFlight = current.use.setInFlightDurationOperationIds;
  current.use.setInFlightDurationOperationIds = (ids) => {
    inFlight.push([...ids]);
    setInFlight(ids);
  };
  current.use.postMutation = async (url, body, owner) => {
    posts.push({ url, sent: JSON.parse(body), owner });
    posted.resolve();
    return request.promise;
  };
  const actions = appSync.create({ state: current.state, external: current.external, use: current.use, listen() {} });
  return { ...actions, preflight, request, posted, reads, posts, inFlight, timers,
    failPreflight(error) { failure = error; } };
}

function success(current, sent) {
  const payload = { ...snapshot(current.state.user.id), revision: 4,
    accountIncarnation: current.state.user.accountIncarnation,
    serverHlcWallMs: nowMs, serverHlcCounter: 50,
    acknowledgements: [], taskAcknowledgements: [], autoStartAcknowledgements: [], selectedTaskAcknowledgements: [],
    durationAcknowledgements: sent.durationOperations.map(({ id }) => ({ operationId: id, outcome: "applied", reason: "" })) };
  for (const operation of sent.durationOperations) payload.durationsMs[operation.phase] = operation.durationMs;
  return { response: { ok: true, status: 200, json: async () => payload } };
}

async function runTimer(control) {
  assert.equal(control.timers.size, 1);
  const [id, timer] = [...control.timers][0];
  control.timers.delete(id);
  await timer.callback();
}

test("R43-S05 concurrent preflight callers share one POST and retain duration protection until completion", async (t) => {
  const { stale } = await fixture(t);
  const firstDuration = (await stale.use.persistDurationOperation("focus", 1_800_000)).operation;
  const control = controlledSync(stale);
  const first = control.syncNow();
  const second = control.syncNow(true);
  await Promise.resolve();
  assert.equal(control.reads.length, 1, "preflight is part of the reserved operation");
  control.preflight.resolve();
  await control.posted.promise;
  let joinedSettled = false;
  const third = control.syncNow().then(() => { joinedSettled = true; });
  const edit = (await stale.use.persistDurationOperation("focus", 2_100_000)).operation;
  assert.equal(joinedSettled, false);
  assert.equal(stale.state.syncing, true);
  assert.deepEqual(control.inFlight, [[firstDuration.id]], "joining callers cannot clear protection");
  assert.deepEqual((await storage.readQueues(stale.use.database())).durationOperations, [firstDuration, edit]);
  assert.equal(control.posts.length, 1, JSON.stringify(stale.calls.flat().map(String)));
  control.request.resolve(success(stale, control.posts[0].sent));
  await Promise.all([first, second, third]);
  assert.equal(stale.state.syncing, false);
  assert.deepEqual(control.inFlight, [[firstDuration.id], []]);
  assert.deepEqual((await storage.readQueues(stale.use.database())).durationOperations, [edit]);
  assert.equal(control.timers.size, 1, "coalesced follow-up scheduled only by owner");
});

test("R43-S05 forced join during empty preflight survives as one forced follow-up", async (t) => {
  const { stale } = await fixture(t);
  const control = controlledSync(stale);
  const first = control.syncNow();
  const forced = control.syncNow(true);
  await Promise.resolve();
  assert.equal(control.reads.length, 1);
  control.preflight.resolve();
  await Promise.all([first, forced]);
  assert.equal(control.posts.length, 0);
  control.request.resolve(success(stale, { durationOperations: [] }));
  await runTimer(control);
  assert.equal(control.posts.length, 1, JSON.stringify(stale.calls.flat().map(String)));
  assert.equal(control.timers.size, 0);
});

test("R43-S05 failed deferred preflight releases guard and preserves retry instead of immediate follow-up", async (t) => {
  const { stale } = await fixture(t);
  await stale.use.persistDurationOperation("focus", 1_800_000);
  const control = controlledSync(stale);
  control.failPreflight(new Error("injected preflight failure"));
  const first = control.syncNow();
  const second = control.syncNow(true);
  await Promise.resolve();
  assert.equal(control.reads.length, 1);
  control.preflight.resolve();
  await Promise.all([first, second]);
  assert.equal(control.posts.length, 0);
  assert.deepEqual(control.inFlight, []);
  assert.equal(stale.state.retrying, true);
  assert.deepEqual([...control.timers.values()].map(({ delay }) => delay), [1000]);
  control.failPreflight(null);
  const rendered = deferred();
  stale.use.render = () => rendered.resolve();
  const retry = runTimer(control);
  await control.posted.promise;
  control.request.resolve(success(stale, control.posts[0].sent));
  await rendered.promise;
  await retry;
  assert.equal(control.posts.length, 1);
  assert.equal(stale.state.retrying, false);
  assert.equal(control.timers.size, 0);
  assert.deepEqual(control.inFlight.at(-1), []);
  assert.deepEqual((await storage.readQueues(stale.use.database())).durationOperations, []);
});

test("R43-S05 joining deferred response decoding retains guard and duration IDs through reconciliation", async (t) => {
  const { stale } = await fixture(t);
  const duration = (await stale.use.persistDurationOperation("focus", 1_800_000)).operation;
  const control = controlledSync(stale);
  control.preflight.resolve();
  const first = control.syncNow();
  await control.posted.promise;
  const decoding = deferred();
  const payload = deferred();
  control.request.resolve({ response: { ok: true, status: 200, json: () => {
    decoding.resolve();
    return payload.promise;
  } } });
  await decoding.promise;
  let settled = false;
  const second = control.syncNow(true).then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(control.reads.length, 1);
  assert.equal(control.posts.length, 1);
  assert.equal(stale.state.syncing, true);
  assert.deepEqual(control.inFlight, [[duration.id]]);
  payload.resolve(await success(stale, control.posts[0].sent).response.json());
  await Promise.all([first, second]);
  assert.deepEqual(control.inFlight, [[duration.id], []]);
  assert.deepEqual((await storage.readQueues(stale.use.database())).durationOperations, []);
  assert.equal(stale.state.syncing, false);
});

test("R43-S05 request failure keeps one backoff; explicit schedule cancels it and retry drains", async (t) => {
  const { stale } = await fixture(t);
  await stale.use.persistDurationOperation("focus", 1_800_000);
  const control = controlledSync(stale);
  control.preflight.resolve();
  const first = control.syncNow();
  await control.posted.promise;
  const second = control.syncNow(true);
  control.request.resolve({ response: { ok: false, status: 503 } });
  await Promise.all([first, second]);
  assert.deepEqual([...control.timers.values()].map(({ delay }) => delay), [1000]);
  assert.deepEqual(control.inFlight.at(-1), []);
  stale.use.postMutation = async (_url, body) => success(stale, JSON.parse(body));
  control.scheduleSync(0, true);
  assert.deepEqual([...control.timers.values()].map(({ delay }) => delay), [0]);
  await runTimer(control);
  assert.equal(stale.state.retrying, false);
  assert.equal(control.retryDelayMsForTest(), 1000);
  assert.deepEqual((await storage.readQueues(stale.use.database())).durationOperations, []);
});

test("R43-S05 ownership change during shared preflight fences POST and preserves peer state", async (t) => {
  const { stale, peer } = await fixture(t);
  await stale.use.persistDurationOperation("focus", 1_800_000);
  const control = controlledSync(stale);
  const first = control.syncNow();
  const second = control.syncNow(true);
  await switchOwner(peer);
  const before = await storage.readSyncState(peer.use.database());
  control.preflight.resolve();
  await Promise.all([first, second]);
  assert.equal(control.reads.length, 1);
  assert.equal(control.posts.length, 0);
  assert.deepEqual(await storage.readSyncState(peer.use.database()), before);
  assert.equal(stale.calls.filter((call) => call === "revalidate").length, 1);
});
