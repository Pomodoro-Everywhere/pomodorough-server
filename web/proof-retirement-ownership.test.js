"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  storage, dump, deferred, fixture, switchOwner, lifecycle, fillQueues, seedMeta,
  discoverRecreation, confirmRecreation
} = require("./test/incarnation-lifecycle-fixture.js");

async function durableBytes(database) {
  return Buffer.from(JSON.stringify(await dump(database)));
}

function pauseRetirement(current) {
  const entered = deferred();
  const resume = deferred();
  const errors = [];
  current.external.syncStorage = {
    ...storage,
    async claimWorkspaceBatch(...args) {
      entered.resolve();
      await resume.promise;
      try { return await storage.claimWorkspaceBatch(...args); }
      catch (error) { errors.push(error); throw error; }
    }
  };
  // Rebind the coordinator so its captured storage dependency includes the pause.
  Object.assign(current.use, require("./app-sync.js").create({
    state: current.state, external: current.external, use: current.use, listen() {}
  }));
  return { entered, resume, errors };
}

for (const reincarnation of [false, true]) {
  test(`R43-S02 paused A retirement rejects after keep_remote takeover, reincarnation=${reincarnation}`, async (t) => {
    const { stale, peer, core } = await (reincarnation ? lifecycle(t) : fixture(t));
    await fillQueues(stale, core);
    const paused = pauseRetirement(stale);
    let posts = 0;
    let revalidations = 0;
    stale.use.queueSessionRevalidation = () => { revalidations += 1; };
    stale.use.postMutation = async () => { posts += 1; throw new Error("stale batch posted"); };
    const syncing = stale.use.syncNow();
    await paused.entered.promise;
    if (reincarnation) {
      await discoverRecreation(peer);
      await confirmRecreation(peer);
    } else {
      await switchOwner(peer);
    }
    await fillQueues(peer, core);
    const sent = peer.use.currentSyncBatch();
    await storage.retireProofAndPersistOutgoing(peer.use.database(), sent, peer.use.captureAccountContext());
    assert.equal(await peer.use.issueDurationOperation("focus", 1_800_000), true);
    const before = await durableBytes(peer.use.database());
    paused.resume.resolve();
    await syncing;
    assert.ok((await durableBytes(peer.use.database())).equals(before), "all B metadata and queues remain byte-identical");
    assert.equal(paused.errors.length, 1);
    assert.ok(paused.errors[0] instanceof storage.AccountOwnershipError);
    assert.equal(posts, 0);
    assert.equal(revalidations, 1);
  });
}

test("R43-S02 context invalidated after transaction starts rejects before any write", async (t) => {
  const { stale, core } = await fixture(t);
  await fillQueues(stale, core);
  const database = stale.use.database();
  const before = await durableBytes(database);
  const captured = stale.use.captureAccountContext();
  const retirement = storage.retireProofAndPersistOutgoing(database, stale.use.currentSyncBatch(), captured);
  stale.state.localOwnerId = "changed-after-transaction-start";
  await assert.rejects(retirement, storage.AccountOwnershipError);
  assert.deepEqual(await durableBytes(database), before);
});

test("R43-S02 retirement reads owner after an already queued peer ownership write", async (t) => {
  const { stale, peer, core } = await fixture(t);
  await fillQueues(stale, core);
  const database = stale.use.database();
  const before = await dump(database);
  const snapshot = before.meta.find((record) => record.key === "snapshot");
  snapshot.value.user = peer.state.user;
  const ownershipWrite = seedMeta(peer.use.database(), { snapshot: snapshot.value });
  const retirement = storage.retireProofAndPersistOutgoing(database,
    stale.use.currentSyncBatch(), stale.use.captureAccountContext());
  await assert.rejects(retirement, storage.AccountOwnershipError);
  await ownershipWrite;
  assert.deepEqual(await durableBytes(database), Buffer.from(JSON.stringify(before)));
});

test("R43-S02 outgoing failure rolls proof retirement back; success preserves exact payload", async (t) => {
  const { stale, core } = await fixture(t);
  const queues = await fillQueues(stale, core);
  const database = stale.use.database();
  const sent = stale.use.currentSyncBatch();
  const before = await durableBytes(database);
  const transaction = database.transaction.bind(database);
  const writes = [];
  t.mock.method(database, "transaction", (...args) => {
    const tx = transaction(...args);
    const objectStore = tx.objectStore.bind(tx);
    tx.objectStore = (name) => {
      const store = objectStore(name);
      const put = store.put.bind(store);
      store.put = (record) => {
        writes.push(record.key);
        if (record.key === "outgoingSync") throw new Error("injected outgoing write failure");
        return put(record);
      };
      return store;
    };
    return tx;
  });
  await assert.rejects(storage.retireProofAndPersistOutgoing(database, sent, stale.use.captureAccountContext()),
    /injected outgoing write failure/);
  t.mock.restoreAll();
  assert.deepEqual(writes, ["deliveryProof", "outgoingSync"]);
  assert.deepEqual(await durableBytes(database), before);
  await storage.retireProofAndPersistOutgoing(database, sent, stale.use.captureAccountContext());
  const after = await storage.readSyncState(database);
  assert.equal(JSON.stringify(after.outgoing.sent), JSON.stringify(sent));
  assert.deepEqual(await storage.readQueues(database), queues);
  for (const ids of Object.values(after.deliveryProof)) assert.deepEqual(ids, []);
});
