"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  storage, sync, nowMs, seedMeta, dump, deferred, accountUser, ownerId, publicId, queueNames,
  canonical, attachSession, serveIncarnation, lifecycle, fillQueues, discoverRecreation, confirmRecreation
} = require("./test/incarnation-lifecycle-fixture.js");

test("P2.21 actual Core requires explicit replacement across same-public-ID incarnations", async (context) => {
  const { stale, peer, core, open } = await lifecycle(context);
  const queues = await fillQueues(stale, core);
  await peer.use.reloadPersistedState();
  const requests = await discoverRecreation(peer);
  assert.equal(peer.state.user.id, stale.state.user.id);
  assert.notEqual(peer.state.user.accountIncarnation, stale.state.user.accountIncarnation);
  assert.deepEqual(await storage.readQueues(peer.use.database()), queues);
  assert.equal(requests.some(({ request }) => request.method === "POST"), false);
  await assert.rejects(peer.use.persistBootstrapResolution("keep_local"), storage.AccountOwnershipError);
  await assert.rejects(peer.use.persistBootstrapResolution("keep_remote"), storage.AccountOwnershipError);
  assert.deepEqual(await storage.readQueues(peer.use.database()), queues);
  await confirmRecreation(peer);
  const resolved = requests.find(({ url }) => url.endsWith("/resolve"));
  const request = JSON.parse(resolved.request.body);
  assert.equal(request.strategy, "keep_remote");
  assert.equal(request.expectedRevision, 0);
  for (const name of queueNames) assert.deepEqual(request[name], [], name);
  const reopened = await open(publicId);
  reopened.state.user = accountUser(publicId, 2);
  await reopened.use.reloadPersistedState();
  assert.equal(reopened.state.localOwnerId, ownerId(publicId, 2));
  assert.equal(reopened.state.revision, 0);
  for (const name of queueNames) assert.deepEqual((await storage.readQueues(reopened.use.database()))[name], []);
});

const mutations = [
  ["task", (current, task) => current.use.issueTaskOperation("upsert", task)],
  ["task deletion", (current, task) => current.use.deleteTask(task)],
  ["duration", (current) => current.use.issueDurationOperation("short_break", 600_000)],
  ["auto start", (current) => current.use.issueAutoStartOperation(false)],
  ["selection", (current, task) => current.use.issueSelectedTaskOperation(task.id)],
  ["timer start", (current) => current.use.issueCommand("start", { phase: "focus" })],
  ["timer pause", (current) => current.use.issueCommand("pause"), "running"],
  ["timer resume", (current) => current.use.issueCommand("resume"), "paused"],
  ["timer finish", (current) => current.use.finishTimer(false), "running"],
  ["timer cancel", (current) => current.use.cancelAndClearTimer(), "running"]
];

for (const [name, mutate, timerStatus] of mutations) {
  test(`P2.21 stale same-ID tab cannot write ${name} after recreation`, async (context) => {
    const { stale, peer, core } = await lifecycle(context, timerStatus);
    const task = core.taskIdentity({ title: "Stale confidential task" });
    await discoverRecreation(peer);
    await confirmRecreation(peer);
    const before = await dump(peer.use.database());
    assert.equal(stale.use.controlsBlocked(), false);
    assert.equal(await mutate(stale, task), false);
    assert.deepEqual(await dump(peer.use.database()), before);
    assert.equal(stale.use.controlsBlocked(), true);
    assert.equal(await peer.use.addTask("New incarnation work"), true);
  });
}

const metadataMutations = [
  ["settings", (current) => current.use.persistSettings()],
  ["clock sequence", (current, fence) => storage.allocateClockRequestSequence(current.use.database(), fence)],
  ["clock offset", (current, fence) => storage.saveClockOffset(current.use.database(), { offsetMs: 1, sampledAtMs: nowMs, requestSequence: 1 }, fence)],
  ["gate acquisition", (current) => current.use.acquireBootstrapGate()],
  ["gate clearing", (current, fence) => storage.clearBootstrapGate(current.use.database(), null, fence)],
  ["bootstrap restart", (current) => current.use.restartBootstrapForCurrentAccount()],
  ["normalization", (current, fence) => storage.normalizeLegacyDurationOperations(current.use.database(), fence)],
  ["legacy auto start", (current, fence) => storage.migrateLegacyAutoStart(current.use.database(), { ...fence, nowMs })],
  ["legacy selection", (current, fence) => storage.migrateLegacySelectedTask(current.use.database(), { ...fence, nowMs })],
  ["local cleanup", (current) => current.use.clearLocalData(current.use.cleanupIdentity())]
];

for (const [name, mutate] of metadataMutations) {
  test(`P2.21 stale same-ID ${name} preserves replacement storage`, async (context) => {
    const { stale, peer } = await lifecycle(context);
    const fence = stale.use.captureAccountContext();
    await discoverRecreation(peer);
    await confirmRecreation(peer);
    const before = await dump(peer.use.database());
    await assert.rejects(mutate(stale, fence), storage.AccountOwnershipError);
    assert.deepEqual(await dump(peer.use.database()), before);
  });
}

test("P2.21 same-incarnation lower revision cannot remove any acknowledged queue", async (context) => {
  const { stale, core } = await lifecycle(context);
  await fillQueues(stale, core);
  const sent = stale.use.currentSyncBatch();
  const response = canonical(1, 1);
  const acknowledgements = ["acknowledgements", "taskAcknowledgements", "durationAcknowledgements", "autoStartAcknowledgements", "selectedTaskAcknowledgements"];
  queueNames.forEach((name, index) => {
    response[acknowledgements[index]] = sent[name].map((operation) => ({
      [index === 0 ? "commandId" : "operationId"]: operation.id, outcome: "applied", reason: ""
    }));
  });
  const before = await storage.readQueues(stale.use.database());
  await stale.use.acceptSyncResponse(response, sent, ownerId(publicId), null);
  assert.deepEqual(await storage.readQueues(stale.use.database()), before);
  assert.equal(stale.state.revision, 20);
});

test("P2.21 fresh revision-one acknowledgements remove applied and duplicate work", async (context) => {
  const { peer, core } = await lifecycle(context);
  await discoverRecreation(peer);
  await confirmRecreation(peer);
  for (const delivery of ["first delivery", "duplicate replay"]) {
    await peer.use.issueTaskOperation("upsert", core.taskIdentity({ title: delivery }));
    const sent = structuredClone(peer.use.currentSyncBatch());
    const response = canonical(2, 1);
    response.taskAcknowledgements = sent.taskOperations.map((operation) => ({ operationId: operation.id, outcome: "applied", reason: "" }));
    await peer.use.issueTaskOperation("upsert", core.taskIdentity({ title: `Concurrent ${delivery}` }));
    const concurrent = peer.state.pendingTaskOperations.at(-1).id;
    await peer.use.acceptSyncResponse(response, sent, ownerId(publicId, 2), null);
    assert.equal(peer.state.revision, 1);
    assert.deepEqual(peer.state.pendingTaskOperations.map((operation) => operation.id), [concurrent]);
  }
});

test("P2.21 legacy cached owner uses Core mismatch policy and preserves all unsent queues", async (context) => {
  const { stale, core, oldSnapshot } = await lifecycle(context);
  const queues = await fillQueues(stale, core);
  await seedMeta(stale.use.database(), { snapshot: { ...oldSnapshot, user: { id: publicId } } });
  Object.assign(stale.state, { user: { id: publicId }, localOwnerId: publicId });
  await stale.use.reloadPersistedState();
  await discoverRecreation(stale);
  assert.equal(stale.state.localOwnerId, publicId);
  assert.deepEqual(await storage.readQueues(stale.use.database()), queues);
  await confirmRecreation(stale);
});

test("P2.21 fresh lower revision removes acknowledgements from all five queues only after replacement", async (context) => {
  const { peer, core } = await lifecycle(context);
  await discoverRecreation(peer);
  await confirmRecreation(peer);
  await fillQueues(peer, core);
  const sent = peer.use.currentSyncBatch();
  const response = canonical(2, 1);
  const fields = ["acknowledgements", "taskAcknowledgements", "durationAcknowledgements", "autoStartAcknowledgements", "selectedTaskAcknowledgements"];
  queueNames.forEach((name, index) => {
    response[fields[index]] = sent[name].map((operation) => ({
      [index === 0 ? "commandId" : "operationId"]: operation.id, outcome: "applied", reason: ""
    }));
  });
  await peer.use.acceptSyncResponse(response, sent, ownerId(publicId, 2), null);
  assert.equal(peer.state.revision, 1);
  for (const name of queueNames) assert.deepEqual((await storage.readQueues(peer.use.database()))[name], [], name);
});

for (const invalid of [undefined, null, "", "legacy", "A".repeat(64), 2, {}]) {
  test(`P2.21 malformed or missing authenticated incarnation fails closed: ${JSON.stringify(invalid)}`, async (context) => {
    const { stale, core } = await lifecycle(context);
    await fillQueues(stale, core);
    const before = await dump(stale.use.database());
    stale.external.host.fetch = async () => ({ ok: true, status: 200, json: async () => ({
      user: { id: publicId, ...(invalid === undefined ? {} : { accountIncarnation: invalid }) }, csrfToken: "fixture"
    }) });
    await assert.rejects(stale.use.loadSession(), /incarnation/);
    assert.deepEqual(await dump(stale.use.database()), before);
    assert.equal(stale.state.user.accountIncarnation, accountUser(publicId).accountIncarnation);
  });
}

test("P2.21 late same-ID session JSON cannot restore an older incarnation", async (context) => {
  const { stale } = await lifecycle(context);
  const delayed = deferred();
  const entered = deferred();
  stale.external.host.fetch = async () => ({ ok: true, status: 200, json: () => { entered.resolve(); return delayed.promise; } });
  const oldLoad = stale.use.loadSession();
  await entered.promise;
  serveIncarnation(stale, 2);
  await stale.use.loadSession();
  delayed.resolve({ user: accountUser(publicId), csrfToken: "old" });
  await assert.rejects(oldLoad, storage.AccountOwnershipError);
  assert.equal(stale.state.user.accountIncarnation, accountUser(publicId, 2).accountIncarnation);
});

test("P2.21 late bootstrap and sync payloads cannot cross incarnation boundary", async (context) => {
  const { stale, peer } = await lifecycle(context);
  const delayed = deferred();
  const entered = deferred();
  stale.external.host.fetch = async () => ({ ok: true, status: 200, json: () => { entered.resolve(); return delayed.promise; } });
  const preview = stale.use.loadBootstrapPreview();
  await entered.promise;
  await discoverRecreation(peer);
  await confirmRecreation(peer);
  const before = await dump(peer.use.database());
  delayed.resolve(canonical(1, 21));
  await assert.rejects(preview, storage.AccountOwnershipError);
  await assert.rejects(peer.use.acceptSyncResponse(canonical(1, 21), peer.use.currentSyncBatch(), ownerId(publicId, 2), null), /incarnation/);
  assert.deepEqual(await dump(peer.use.database()), before);
});

test("P2.21 cold restart retains exact cross-incarnation bootstrap capture", async (context) => {
  const { stale, peer, core, open, memory } = await lifecycle(context);
  const queues = await fillQueues(stale, core);
  await peer.use.reloadPersistedState();
  await discoverRecreation(peer);
  peer.state.bootstrapOwnershipApproved = true;
  const pending = await peer.use.persistBootstrapResolution("keep_remote");
  assert.equal(pending.userId, ownerId(publicId, 2));
  assert.equal(pending.sourceOwnerId, ownerId(publicId));
  const reopened = await open(null);
  attachSession(reopened, memory);
  reopened.use.database().close();
  Object.assign(reopened.state, { authenticated: false, sessionIdentityValidated: false, user: null, localOwnerId: null });
  await reopened.use.loadLocalState();
  assert.deepEqual(reopened.state.bootstrapPending, pending);
  assert.deepEqual(await storage.readQueues(reopened.use.database()), queues);
  assert.equal(reopened.state.bootstrapGateOwned, false);
  serveIncarnation(reopened, 2);
  await reopened.use.loadSession();
  await reopened.use.prepareBootstrap();
  assert.deepEqual(await storage.readQueues(reopened.use.database()), queues);
});
