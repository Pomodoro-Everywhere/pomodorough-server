"use strict";

const assert = require("node:assert/strict");
const cold = require("./cold-logout-recovery-fixture.js");
const { accountUser, ownerId } = require("./incarnation-fixture.js");
const { canonical, fillQueues, publicId, queueNames } = require("./incarnation-lifecycle-fixture.js");

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

function serve(tab, generation, sessionResponse = null) {
  const requests = [];
  tab.host.navigator.onLine = true;
  tab.use.setFetchForTest(async (url, options = {}) => {
    requests.push({ url, options });
    if (url === "/api/v1/me") return sessionResponse ? sessionResponse() : {
      ok: true, status: 200, json: async () => ({
        user: accountUser(publicId, generation), csrfToken: `lease-csrf-${generation}`
      })
    };
    assert.equal(options.headers["X-Pomodorough-Account-Incarnation"], accountUser(publicId, generation).accountIncarnation);
    assert.ok(["/api/v1/bootstrap", "/api/v1/bootstrap/resolve", "/api/v1/sync"].includes(url), url);
    return { ok: true, status: 200, json: async () => canonical(generation) };
  });
  return requests;
}

async function seed(database) {
  const transaction = database.transaction(cold.stores, "readwrite");
  for (const name of cold.stores.slice(1)) transaction.objectStore(name).clear();
  const meta = transaction.objectStore("meta");
  meta.delete("bootstrapGate");
  meta.put({ key: "snapshot", value: { ...canonical(1, 20), user: accountUser(publicId) } });
  meta.put({ key: "settings", value: { selectedPhase: "focus", durationSyncBootstrapped: true,
    autoStartSyncBootstrapped: true, selectedTaskSyncBootstrapped: true } });
  await cold.storage.transactionDone(transaction);
}

async function environment(context) {
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const result = await cold.fixture(context, publicId);
  result.issuer.use.clearPendingLogout();
  await seed(result.database);
  const target = result.cold;
  await target.initialize();
  assert.equal(target.state.ready, true);
  assert.equal(target.state.offlineOwnerMode, true);
  const queues = await fillQueues(target, await target.use.loadSharedCore());
  return { ...result, target, queues };
}

async function pauseSource(context, setup) {
  const source = setup.openTab();
  const arrived = deferred();
  const delayed = deferred();
  serve(source, 1, () => { arrived.resolve(); return delayed.promise; });
  const starting = source.initialize();
  context.after(async () => { delayed.resolve({ ok: false, status: 401 }); await starting; });
  await Promise.race([arrived.promise, starting.then(() => assert.fail("Source must pause at session HTTP"))]);
  const { gate, resolution } = await cold.storage.readBootstrapState(setup.database);
  assert.equal(gate.accountOwnerId, ownerId(publicId));
  assert.equal(resolution, null);
  return gate;
}

function assertConfirmation(tab, generation = 2) {
  assert.equal(tab.state.localOwnerId, ownerId(publicId));
  assert.equal(tab.state.user.accountIncarnation, accountUser(publicId, generation).accountIncarnation);
  assert.equal(tab.state.bootstrapGateOwned, true);
  assert.deepEqual(tab.state.bootstrapPlan, { mode: "auto", reason: "different_owner", strategy: "keep_remote" });
  assert.equal(tab.state.bootstrapOwnershipConfirmation, true);
  assert.equal(tab.state.bootstrapOwnershipApproved, false);
  assert.equal(tab.state.bootstrapPending, null);
  assert.equal(tab.use.controlsBlocked(), true);
}

module.exports = { ...cold, accountUser, ownerId, publicId, queueNames, canonical,
  serve, environment, pauseSource, assertConfirmation };
