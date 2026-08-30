"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { storage, dump, ownerId, publicId, queueNames, canonical,
  serve, environment, pauseSource, assertConfirmation } = require("./test/lease-expiry-retry-fixture.js");

async function retryThreeTimes(target) {
  for (let attempt = 0; attempt < 3; attempt += 1) await target.use.restoreSessionAndSync();
}

test("P2.21 lease retry: same-incarnation lower revision cannot clear five acknowledged queues", async (context) => {
  const setup = await environment(context);
  const { target } = setup;
  const sampledAtWallMs = Date.now();
  await storage.saveClockOffset(setup.database, { offsetMs: 0, uncertaintyMs: 1,
    sampledAtWallMs, receivedAtWallMs: sampledAtWallMs, requestSequence: 1 });
  const sent = target.use.currentSyncBatch();
  const response = canonical(1, 1);
  const ackNames = ["acknowledgements", "taskAcknowledgements", "durationAcknowledgements",
    "autoStartAcknowledgements", "selectedTaskAcknowledgements"];
  queueNames.forEach((name, index) => {
    response[ackNames[index]] = sent[name].map((operation) => ({
      [index === 0 ? "commandId" : "operationId"]: operation.id, outcome: "applied", reason: ""
    }));
  });
  const before = await dump(setup.database);
  await target.use.acceptSyncResponse(response, sent, ownerId(publicId), null);
  assert.deepEqual(await dump(setup.database), before);
  assert.equal(target.state.revision, 20);
});

async function assertRetained(setup) {
  assert.deepEqual(await storage.readQueues(setup.database), setup.queues);
  const persisted = await storage.readSyncState(setup.database);
  assert.equal(persisted.snapshot.revision, 20);
  assert.equal(`account:v1:${persisted.snapshot.user.accountIncarnation}`, ownerId(publicId));
}

test("P2.21 lease retry: already expired source with no pending resolution recovers at initialization", async (context) => {
  const setup = await environment(context);
  const gate = await pauseSource(context, setup);
  context.mock.timers.setTime(gate.expiresAtMs + 1);
  const target = setup.openTab();
  serve(target, 2);
  await target.initialize();
  await retryThreeTimes(target);
  assertConfirmation(target);
  await assertRetained(setup);
});

test("P2.21 lease retry: unvalidated target reauthenticates before expired handoff", async (context) => {
  const setup = await environment(context);
  const { target } = setup;
  const gate = await pauseSource(context, setup);
  const requests = serve(target, 2);
  await target.use.loadSession();
  context.mock.timers.setTime(gate.expiresAtMs + 1);
  target.state.sessionIdentityValidated = false;
  const before = await dump(setup.database);
  await target.use.prepareBootstrap();
  assert.equal(target.state.sessionIdentityValidated, false);
  assert.equal(target.state.bootstrapGateOwned, false);
  assert.deepEqual(await dump(setup.database), before);
  await retryThreeTimes(target);
  assertConfirmation(target);
  assert.deepEqual(requests.map(({ url }) => url), ["/api/v1/me", "/api/v1/me", "/api/v1/bootstrap"]);
  await assertRetained(setup);
});

for (const startup of ["running", "cold"]) {
  test(`P2.21 lease retry: ${startup} target recovers without pending resolution or reauthentication`, async (context) => {
    const setup = await environment(context);
    const gate = await pauseSource(context, setup);
    const target = startup === "cold" ? setup.openTab() : setup.target;
    const requests = serve(target, 2);
    await (startup === "cold" ? target.initialize() : target.use.loadSession());
    assert.equal(target.state.bootstrapGateOwned, false);
    assert.equal(target.state.bootstrapPending, null);
    const before = await dump(setup.database);
    await retryThreeTimes(target);
    assert.deepEqual(await dump(setup.database), before, "live lease preserves every store");
    context.mock.timers.setTime(gate.expiresAtMs + 1);
    await retryThreeTimes(target);
    assertConfirmation(target);
    assert.deepEqual(await storage.readQueues(setup.database), setup.queues);
    assert.deepEqual(requests.map(({ url }) => url), ["/api/v1/me", "/api/v1/bootstrap"]);
  });
}

test("P2.21 lease retry: stale proof cannot reclaim third incarnation and requires fresh session", async (context) => {
  const setup = await environment(context);
  const { target } = setup;
  const gate = await pauseSource(context, setup);
  serve(target, 2);
  await target.use.loadSession();
  const staleProof = target.state.authenticatedAccountBinding;
  context.mock.timers.setTime(gate.expiresAtMs + 1);
  const third = setup.openTab();
  serve(third, 3);
  await third.initialize();
  assertConfirmation(third, 3);
  const replacement = await storage.readBootstrapState(setup.database);
  context.mock.timers.setTime(replacement.gate.expiresAtMs + 1);
  const before = await dump(setup.database);
  await target.use.restoreSessionAndSync();
  assert.equal(target.state.sessionIdentityValidated, false);
  assert.equal(target.state.bootstrapGateOwned, false);
  assert.equal(target.state.bootstrapPlan, null);
  assert.equal(target.state.authenticatedAccountBinding, staleProof);
  assert.deepEqual(await dump(setup.database), before, "stale proof cannot change third-incarnation lease");
  const requests = serve(target, 3);
  await retryThreeTimes(target);
  assertConfirmation(target, 3);
  assert.notEqual(target.state.authenticatedAccountBinding, staleProof);
  assert.deepEqual(requests.map(({ url }) => url), ["/api/v1/me", "/api/v1/bootstrap"]);
  await assertRetained(setup);
});

test("P2.21 lease retry: three reopens retain five queues until actual Core confirmation", async (context) => {
  const setup = await environment(context);
  const gate = await pauseSource(context, setup);
  serve(setup.target, 2);
  await setup.target.use.loadSession();
  context.mock.timers.setTime(gate.expiresAtMs + 1);
  await retryThreeTimes(setup.target);
  let target = setup.target;
  let requests;
  for (let reopen = 0; reopen < 3; reopen += 1) {
    const persisted = await storage.readBootstrapState(setup.database);
    context.mock.timers.setTime(persisted.gate.expiresAtMs + 1);
    target = setup.openTab();
    requests = serve(target, 2);
    await target.initialize();
    await retryThreeTimes(target);
    assertConfirmation(target);
    await assertRetained(setup);
  }
  await target.use.chooseBootstrapStrategy("keep_local", true);
  await target.use.chooseBootstrapStrategy("keep_remote", false);
  await assertRetained(setup);
  assert.equal(target.state.bootstrapPending, null);
  assert.equal(requests.some(({ url }) => url.endsWith("/resolve")), false);
  await target.use.chooseBootstrapStrategy("keep_remote", true);
  assert.equal(target.state.bootstrapError, null);
  assert.equal(target.use.controlsBlocked(), false);
  const resolution = JSON.parse(requests.find(({ url }) => url.endsWith("/resolve")).options.body);
  for (const name of queueNames) {
    assert.equal((resolution[name] || []).length, 0, name);
    assert.deepEqual((await storage.readQueues(setup.database))[name], [], name);
  }
  assert.equal((await storage.readSyncState(setup.database)).snapshot.revision, 0);
  assert.equal(target.state.localOwnerId, ownerId(publicId, 2));
});
