"use strict";

const { accountUser, ownerId } = require("./test/incarnation-fixture.js");

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  storage, stores, markerKey, ownerKey, fixture, dump, seedAccount, setOwner, assertEmpty, pauseGuard
} = require("./test/cold-logout-recovery-fixture.js");

test("P1.20 cold logout recovers the issuing owner without loading private state", async (context) => {
  const { cold, database, localStorage } = await fixture(context);
  assert.equal(cold.state.user, null);
  assert.equal(cold.state.localOwnerId, null);
  assert.equal(localStorage.getItem(markerKey), "1");
  assert.deepEqual(JSON.parse(localStorage.getItem(ownerKey)), { userId: ownerId("account-A") });
  assert.equal(await cold.use.clearPendingLogoutData(), true);
  assertEmpty(await dump(database));
  assert.equal(cold.state.user, null);
  assert.equal(cold.state.localOwnerId, null);
  assert.equal(cold.use.pendingLocalLogout(), true);
  assert.equal(cold.calls.some(([name]) => name === "fetch"), false);
});

test("P1.20 actual cold startup reaches ready after pending cleanup while offline", async (context) => {
  const { cold, database } = await fixture(context);
  await cold.initialize();
  assert.equal(cold.state.ready, true);
  assert.equal(cold.state.user, null);
  assert.equal(cold.state.localOwnerId, null);
  assert.equal(cold.state.offlineOwnerMode, false);
  assert.equal(cold.state.authenticated, false);
  assert.equal(cold.state.sessionIdentityValidated, false);
  assert.equal(cold.use.pendingLocalLogout(), true);
  const records = await dump(database);
  assert.equal(records.meta.some((record) => record.key === "snapshot"), false);
  for (const name of stores.slice(1)) assert.deepEqual(records[name], []);
  assert.deepEqual(cold.calls.filter(([name]) => name === "fetch").map((entry) => entry[1]), ["/api/v1/me"]);
});

test("P1.20 repeated offline startup tolerates recreated metadata without clearing it", async (context) => {
  const { cold, openTab, database } = await fixture(context);
  await cold.initialize();
  assert.equal(cold.state.ready, true);
  const records = await dump(database);
  const restarted = openTab();
  assert.equal(await restarted.use.clearPendingLogoutData(), true);
  assert.deepEqual(await dump(database), records);
  await restarted.initialize();
  assert.equal(restarted.state.ready, true);
  assert.equal(restarted.state.user, null);
  assert.equal(restarted.state.offlineOwnerMode, false);
});

test("P1.20 cold recovery remains idempotent after cleanup committed before interruption", async (context) => {
  const { issuer, openTab, database } = await fixture(context);
  await issuer.use.clearLocalData();
  const reopened = await openTab().use.openDatabase();
  assertEmpty(await dump(reopened));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const cold = openTab();
    assert.equal(await cold.use.clearPendingLogoutData(), true);
    assert.equal(cold.use.pendingLocalLogout(), true);
    assertEmpty(await dump(reopened));
  }
  assert.equal(database.name, "pomodorough");
});

test("P1.20 aborted cleanup rolls back every store and cold retry retains authorization", async (context) => {
  const { cold, openTab, database } = await fixture(context);
  const before = await dump(database);
  cold.syncStorage.guardedMutation = (connection, names, operation, input) => storage.guardedMutation(
    connection, names, (transaction, ...args) => { operation(transaction, ...args); transaction.abort(); }, input
  );
  assert.equal(await cold.use.clearPendingLogoutData(), false);
  assert.deepEqual(await dump(database), before);
  assert.equal(cold.use.pendingLocalLogout(), true);
  assert.equal(await openTab().use.clearPendingLogoutData(), true);
  assertEmpty(await dump(database));
});

test("P1.20 concurrent cold tabs and duplicate same-tab cleanup converge safely", async (context) => {
  const { cold, openTab, database } = await fixture(context);
  const peer = openTab();
  assert.deepEqual(await Promise.all([
    cold.use.clearPendingLogoutData(), cold.use.clearPendingLogoutData(), peer.use.clearPendingLogoutData()
  ]), [true, true, true]);
  assertEmpty(await dump(database));
});

test("P1.20 A recovery cannot clear B after a committed owner replacement", async (context) => {
  const { cold, database } = await fixture(context);
  await seedAccount(database, "account-B");
  const before = await dump(database);
  assert.equal(await cold.use.clearPendingLogoutData(), false);
  assert.deepEqual(await dump(database), before);
  assert.equal(cold.state.bootstrapBlocked, true);
  assert.equal(cold.state.sessionIdentityValidated, false);
  assert.equal(cold.use.pendingLocalLogout(), true);
});

test("P1.20 stale A cannot borrow a newer B logout marker", async (context) => {
  const { issuer, openTab, database } = await fixture(context);
  const peer = openTab();
  setOwner(peer, "account-B");
  await seedAccount(database, "account-B");
  peer.use.markPendingLogout();
  const before = await dump(database);
  await assert.rejects(issuer.use.clearLocalData(), { name: "AccountOwnershipError" });
  assert.deepEqual(await dump(database), before);
  assert.equal(await peer.use.clearPendingLogoutData(), true);
});

test("P1.20 changed in-memory B cannot repurpose an older A logout marker", async (context) => {
  const { issuer, database } = await fixture(context);
  setOwner(issuer, "account-B");
  await seedAccount(database, "account-B");
  const before = await dump(database);
  await assert.rejects(issuer.use.clearLocalData(), { name: "AccountOwnershipError" });
  assert.deepEqual(await dump(database), before);
});

for (const [label, marker, owner] of [
  ["legacy unbound", "1", null], ["corrupt owner JSON", "1", "{"],
  ["missing owner field", "1", "{}"], ["empty owner", "1", '{"userId":""}'],
  ["null owner", "1", '{"userId":null}'], ["numeric owner", "1", '{"userId":7}'],
  ["array owner", "1", '[{"userId":"account-A"}]'],
  ["missing pending marker", null, '{"userId":"account-A"}'],
  ["corrupt pending marker", "invalid", '{"userId":"account-A"}']
]) {
  test(`P1.20 ${label} never authorizes cold deletion of named account`, async (context) => {
    const { cold, database, localStorage } = await fixture(context);
    for (const [key, value] of [[markerKey, marker], [ownerKey, owner]]) {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
    const before = await dump(database);
    await assert.rejects(cold.use.clearLocalData(), { name: "AccountOwnershipError" });
    assert.deepEqual(await dump(database), before);
  });
}

test("P1.20 inaccessible marker storage cannot authorize a cold named account", async (context) => {
  const { cold, database, localStorage } = await fixture(context);
  const before = await dump(database);
  context.mock.method(localStorage, "getItem", () => { throw new Error("Storage access denied"); });
  await assert.rejects(cold.use.clearLocalData(), { name: "AccountOwnershipError" });
  assert.deepEqual(await dump(database), before);
});

test("P1.20 issuing cached owner offline remains an explicit cleanup authority", async (context) => {
  const { issuer, cold, database, localStorage } = await fixture(context);
  issuer.state.user = null;
  issuer.use.markPendingLogout();
  assert.deepEqual(JSON.parse(localStorage.getItem(ownerKey)), { userId: ownerId("account-A") });
  assert.equal(await cold.use.clearPendingLogoutData(), true);
  assertEmpty(await dump(database));
});

test("P1.20 named recovery refuses a null-owned offline snapshot", async (context) => {
  const { cold, database } = await fixture(context);
  await seedAccount(database, null);
  const before = await dump(database);
  assert.equal(await cold.use.clearPendingLogoutData(), false);
  assert.deepEqual(await dump(database), before);
});

for (const name of stores.slice(1)) {
  test(`P1.20 absent snapshot with retained ${name} is not completed cleanup`, async (context) => {
    const { cold, database } = await fixture(context);
    const transaction = database.transaction(stores, "readwrite");
    for (const store of stores) transaction.objectStore(store).clear();
    transaction.objectStore(name).put({ id: "offline-change", privateValue: "keep" });
    await storage.transactionDone(transaction);
    const before = await dump(database);
    assert.equal(await cold.use.clearPendingLogoutData(), false);
    assert.deepEqual(await dump(database), before);
  });
}

test("P1.20 absent snapshot with retained bootstrap resolution is not completed cleanup", async (context) => {
  const { cold, database } = await fixture(context);
  const transaction = database.transaction(stores, "readwrite");
  for (const name of stores) transaction.objectStore(name).clear();
  transaction.objectStore("meta").put({ key: "bootstrapResolution", value: { userId: ownerId("account-A"), payload: "keep" } });
  await storage.transactionDone(transaction);
  const before = await dump(database);
  assert.equal(await cold.use.clearPendingLogoutData(), false);
  assert.deepEqual(await dump(database), before);
});

test("P1.20 explicitly null-owned logout still clears only null-owned storage", async (context) => {
  const { cold, database } = await fixture(context, null);
  assert.equal(await cold.use.clearPendingLogoutData(), true);
  assertEmpty(await dump(database));
});

test("P1.20 cold authorization survives open await but not an A-to-B database race", async (context) => {
  const { cold, database } = await fixture(context);
  const gate = pauseGuard(cold);
  const cleanup = cold.use.clearPendingLogoutData();
  await gate.waiting;
  await seedAccount(database, "account-B");
  const before = await dump(database);
  gate.resume();
  assert.equal(await cleanup, false);
  assert.deepEqual(await dump(database), before);
});

for (const field of ["user", "localOwnerId"]) {
  test(`P1.20 ${field} changing inside the transaction aborts cleanup`, async (context) => {
    const { cold, database } = await fixture(context);
    const before = await dump(database);
    cold.syncStorage.guardedMutation = (connection, names, operation, input) => storage.guardedMutation(
      connection, names, (transaction, ...args) => {
        cold.state[field] = field === "user" ? accountUser("account-B") : "account-B";
        operation(transaction, ...args);
      }, input
    );
    assert.equal(await cold.use.clearPendingLogoutData(), false);
    assert.deepEqual(await dump(database), before);
  });
}

for (const replacement of [null, "{", '{"userId":"account-B"}']) {
  test(`P1.20 changed recovery authorization ${replacement} aborts after await`, async (context) => {
    const { cold, database, localStorage } = await fixture(context);
    const before = await dump(database);
    const gate = pauseGuard(cold);
    const cleanup = cold.use.clearPendingLogoutData();
    await gate.waiting;
    if (replacement === null) localStorage.removeItem(markerKey);
    else localStorage.setItem(ownerKey, replacement);
    gate.resume();
    assert.equal(await cleanup, false);
    assert.deepEqual(await dump(database), before);
  });
}

test("P1.20 retry cannot treat B installed before empty confirmation as cleared", async (context) => {
  const { cold, issuer, openTab } = await fixture(context);
  await issuer.use.clearLocalData();
  const database = await openTab().use.openDatabase();
  let before;
  cold.syncStorage.guardedMutation = async (connection, names, operation, input) => {
    if (input.expectedUserId === null) {
      await seedAccount(database, "account-B");
      before = await dump(database);
    }
    return storage.guardedMutation(connection, names, operation, input);
  };
  assert.equal(await cold.use.clearPendingLogoutData(), false);
  assert.ok(before);
  assert.deepEqual(await dump(database), before);
});

test("P1.20 cleared revocation removes its companion and preserves the legacy flag contract", async (context) => {
  const { issuer, localStorage } = await fixture(context);
  assert.equal(localStorage.getItem(markerKey), "1");
  issuer.use.clearPendingLogout();
  assert.equal(localStorage.getItem(markerKey), null);
  assert.equal(localStorage.getItem(ownerKey), null);
});
