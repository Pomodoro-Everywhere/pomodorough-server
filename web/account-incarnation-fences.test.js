"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  storage, seedMeta, dump, deferred, accountUser, ownerId, publicId, queueNames,
  canonical, attachSession, serveIncarnation, lifecycle, fillQueues, discoverRecreation, confirmRecreation
} = require("./test/incarnation-lifecycle-fixture.js");

async function expireGate(database) {
  const persisted = await storage.readBootstrapState(database);
  await seedMeta(database, { bootstrapGate: { ...persisted.gate, expiresAtMs: 0 } });
}

test("P2.21 stale source cannot reclaim an expired replacement gate or discard its pending choice", async (context) => {
  const { stale, peer, core } = await lifecycle(context);
  await fillQueues(stale, core);
  await peer.use.reloadPersistedState();
  await discoverRecreation(peer);
  peer.state.bootstrapOwnershipApproved = true;
  await peer.use.persistBootstrapResolution("keep_remote");
  await expireGate(peer.use.database());
  const before = await dump(peer.use.database());
  await assert.rejects(stale.use.restartBootstrapForCurrentAccount(), storage.AccountOwnershipError);
  assert.deepEqual(await dump(peer.use.database()), before);
});

test("P2.21 third incarnation retains original source and rejects a formerly authenticated second incarnation", async (context) => {
  const { peer, core, open, memory } = await lifecycle(context);
  const queues = await fillQueues(peer, core);
  await discoverRecreation(peer);
  const staleSecond = await open(publicId);
  attachSession(staleSecond, memory);
  staleSecond.state.user = accountUser(publicId, 2);
  staleSecond.state.authenticatedAccountBinding = peer.state.authenticatedAccountBinding;
  serveIncarnation(peer, 3);
  await peer.use.loadSession();
  await peer.use.prepareBootstrap();
  assert.equal(peer.state.localOwnerId, ownerId(publicId));
  assert.equal(peer.state.user.accountIncarnation, accountUser(publicId, 3).accountIncarnation);
  assert.equal(peer.state.bootstrapPlan.reason, "different_owner");
  assert.deepEqual(await storage.readQueues(peer.use.database()), queues);
  await expireGate(peer.use.database());
  const before = await dump(peer.use.database());
  await assert.rejects(staleSecond.use.restartBootstrapForCurrentAccount(), storage.AccountOwnershipError);
  assert.deepEqual(await dump(peer.use.database()), before);
});

test("P2.21 stale cleanup and sign-out cannot erase unconfirmed replacement work", async (context) => {
  const { stale, peer, core, memory } = await lifecycle(context);
  await fillQueues(stale, core);
  await peer.use.reloadPersistedState();
  await discoverRecreation(peer);
  const before = await dump(peer.use.database());
  await stale.use.logout();
  assert.equal(memory.size, 0);
  assert.deepEqual(await dump(peer.use.database()), before);
  stale.use.markPendingLogout();
  const marker = [...memory];
  await assert.rejects(stale.use.clearLocalData(stale.use.cleanupIdentity()), storage.AccountOwnershipError);
  assert.deepEqual(await dump(peer.use.database()), before);
  assert.deepEqual([...memory], marker);
});

for (const legacy of [false, true]) {
  test(`P2.21 ${legacy ? "legacy public-ID" : "old-incarnation"} logout recovery cannot authorize replacement cleanup`, async (context) => {
    const { stale, core, oldSnapshot, memory } = await lifecycle(context);
    await fillQueues(stale, core);
    if (legacy) {
      await seedMeta(stale.use.database(), { snapshot: { ...oldSnapshot, user: { id: publicId } } });
      Object.assign(stale.state, { user: { id: publicId }, localOwnerId: publicId });
    }
    stale.use.markPendingLogout();
    const marker = [...memory];
    const before = await dump(stale.use.database());
    serveIncarnation(stale, 2);
    await assert.rejects(stale.use.loadSession(), storage.AccountOwnershipError);
    assert.deepEqual(await dump(stale.use.database()), before);
    assert.deepEqual([...memory], marker);
  });
}

for (const status of [200, 401]) {
  test(`P2.21 late session HTTP ${status} cannot cross a peer incarnation change`, async (context) => {
    const { stale, peer } = await lifecycle(context);
    const delayed = deferred();
    const entered = deferred();
    stale.external.host.fetch = () => { entered.resolve(); return delayed.promise; };
    const loading = stale.use.loadSession();
    await entered.promise;
    await discoverRecreation(peer);
    await confirmRecreation(peer);
    const before = await dump(peer.use.database());
    delayed.resolve({ ok: status === 200, status, json: async () => ({ user: accountUser(publicId), csrfToken: "old" }) });
    await assert.rejects(loading, storage.AccountOwnershipError);
    assert.deepEqual(await dump(peer.use.database()), before);
    assert.equal(stale.calls.some((call) => call[0] === "navigate"), false);
  });
}

test("P2.21 mutation CSRF retry discovers recreation without resending old work", async (context) => {
  const { stale, core } = await lifecycle(context);
  const queues = await fillQueues(stale, core);
  let syncRequests = 0;
  stale.external.host.fetch = async (url, request) => {
    if (url === "/api/v1/me") return { ok: true, status: 200, json: async () => ({ user: accountUser(publicId, 2), csrfToken: "new" }) };
    assert.equal(url, "/api/v1/sync");
    assert.equal(request.headers["X-Pomodorough-Account-Incarnation"], accountUser(publicId).accountIncarnation);
    syncRequests += 1;
    return { ok: false, status: 403, clone: () => ({ json: async () => ({ error: "invalid CSRF token" }) }) };
  };
  await assert.rejects(stale.use.postMutation("/api/v1/sync", JSON.stringify(queues), ownerId(publicId)), /account changed/i);
  assert.equal(syncRequests, 1);
  assert.equal(stale.state.user.accountIncarnation, accountUser(publicId, 2).accountIncarnation);
  assert.deepEqual(await storage.readQueues(stale.use.database()), queues);
});

test("P2.21 old revision stream events and errors cannot affect replacement stream", async (context) => {
  const { stale } = await lifecycle(context);
  const sources = [];
  stale.external.host.EventSource = class {
    constructor() { this.listeners = {}; sources.push(this); }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    close() { this.closed = true; }
  };
  stale.use.openRevisionStream();
  assert.equal(sources.length, 1);
  await discoverRecreation(stale);
  await confirmRecreation(stale);
  stale.use.openRevisionStream();
  assert.equal(sources.length, 2);
  assert.equal(sources[0].closed, true);
  stale.external.host.navigator.onLine = false;
  sources[0].onmessage({ data: "999" });
  sources[0].listeners.revision({ data: "1000" });
  sources[0].onerror();
  assert.equal(sources[1].closed, undefined);
  assert.equal(stale.calls.some((call) => call[0] === "revision-hint"), false);
  sources[1].listeners.revision({ data: "1" });
  assert.equal(stale.calls.filter((call) => call[0] === "revision-hint").length, 1);
  sources[1].onerror();
  assert.equal(sources[1].closed, true);
});

test("P2.21 late old-incarnation canonical acknowledgements cannot clear any replacement queue", async (context) => {
  const { stale, peer, core } = await lifecycle(context);
  await fillQueues(stale, core);
  const sent = stale.use.currentSyncBatch();
  const response = canonical(1, 21);
  const fields = ["acknowledgements", "taskAcknowledgements", "durationAcknowledgements", "autoStartAcknowledgements", "selectedTaskAcknowledgements"];
  queueNames.forEach((name, index) => {
    response[fields[index]] = sent[name].map((operation) => ({
      [index === 0 ? "commandId" : "operationId"]: operation.id, outcome: "applied", reason: ""
    }));
  });
  await discoverRecreation(peer);
  await confirmRecreation(peer);
  await fillQueues(peer, core);
  const before = await dump(peer.use.database());
  await assert.rejects(stale.use.acceptSyncResponse(response, sent, ownerId(publicId), null), storage.AccountOwnershipError);
  assert.deepEqual(await dump(peer.use.database()), before);
});

test("P2.21 delayed task identity cannot bind an old title to a recreated account", async (context) => {
  const { stale, peer, core } = await lifecycle(context);
  const identity = deferred();
  stale.use.sharedTaskIdentity = () => identity.promise;
  const adding = stale.use.addTask("Old confidential title");
  await discoverRecreation(peer);
  await confirmRecreation(peer);
  stale.use.applySessionPayload({ user: accountUser(publicId, 2), csrfToken: "new" });
  await stale.use.reloadPersistedState();
  const before = await dump(peer.use.database());
  identity.resolve(core.taskIdentity({ title: "Old confidential title" }));
  assert.equal(await adding, false);
  assert.deepEqual(await dump(peer.use.database()), before);
});
