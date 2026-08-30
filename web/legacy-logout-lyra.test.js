"use strict";

const { accountUser, ownerId } = require("./test/incarnation-fixture.js");

const test = require("node:test");
const assert = require("node:assert/strict");
const { interruptedLogout, respondAs, assertRecovery, assertRecovered, click,
  marker, companion, identity, done, seedTransaction, dump, drain, writeMarker, names
} = require("./test/legacy-logout-lyra-fixture.js");

const corruptMarkers = [
  ["released flag only", undefined, "1"], ["truncated JSON", "{", "1"],
  ["empty object", "{}", "1"], ["null companion", "null", "1"],
  ["null owner", '{"userId":null}', "1"], ["empty owner", '{"userId":""}', "1"],
  ["numeric owner", '{"userId":17}', "1"], ["array owner", '{"userId":[]}', "1"],
  ["corrupt flag", undefined, "invalid"], ["empty flag", undefined, ""]
];

for (const [label, record, flag] of corruptMarkers) {
  test(`Lyra ${label}: offline recovery stays visible across retries and reload`, async (context) => {
    const environment = await interruptedLogout(context);
    const { current, database, localStorage, retained, openTab } = environment;
    writeMarker(localStorage, record, flag);
    await current.initialize();
    await drain(current, 5);
    assertRecovery(current);
    assert.equal(current.state.ready, false);
    assert.equal(current.elements.get("#logoutRecoverySignIn").disabled, true);
    await click(current, "logoutRecoveryRetry");
    const cold = await openTab();
    await cold.initialize();
    assertRecovery(cold);
    assert.equal(localStorage.getItem(marker), flag);
    assert.equal(localStorage.getItem(companion), record ?? null);
    assert.deepEqual(await dump(database), retained);
  });

  test(`Lyra ${label}: authenticated A commits cleanup before marker drop and resumes startup`, async (context) => {
    const environment = await interruptedLogout(context);
    const { current, database, localStorage } = environment;
    writeMarker(localStorage, record, flag);
    respondAs(current, "account-A", { beforeRevocation: async () => {
      assert.equal(localStorage.getItem(marker), flag);
      assert.equal(localStorage.getItem(companion), record ?? null);
      assert.ok(Object.values(await dump(database)).every((rows) => rows.length === 0));
    } });
    await current.initialize();
    await assertRecovered(environment);
  });

  test(`Lyra ${label}: authenticated A cannot authorize unknown B`, async (context) => {
    const environment = await interruptedLogout(context, "account-B");
    const { current, database, localStorage, retained } = environment;
    writeMarker(localStorage, record, flag);
    respondAs(current, "account-A");
    await current.initialize();
    assertRecovery(current);
    assert.equal(current.state.ready, false);
    assert.equal(localStorage.getItem(marker), flag);
    assert.equal(localStorage.getItem(companion), record ?? null);
    assert.deepEqual(await dump(database), retained);
    assert.equal(current.calls.some((call) => call[1] === "/api/v1/auth/logout"), false);
  });
}

test("Lyra released marker: actual retry button authenticates owner and resumes startup once", async (context) => {
  const environment = await interruptedLogout(context);
  const { current, localStorage, database } = environment;
  await current.initialize();
  assertRecovery(current);
  respondAs(current, "account-A");
  const retry = click(current, "logoutRecoveryRetry");
  assert.equal(current.state.logoutRecoveryBusy, true);
  assert.equal(current.elements.get("#logoutRecoveryRetry").disabled, true);
  assert.equal(current.elements.get("#logoutRecoverySignIn").disabled, true);
  assert.equal(await current.use.retryPendingLogout(), false);
  assert.equal(localStorage.getItem(marker), "1");
  await retry;
  await assertRecovered(environment);
  assert.equal(current.elements.get("#timerToggle").listenerCounts.get("click"), 1);
  const cold = await environment.openTab();
  await cold.initialize();
  assert.equal(cold.state.ready, true);
  assert.equal(cold.state.offlineOwnerMode, false);
  assert.equal(cold.state.user, null);
  assert.deepEqual((await dump(database)).pendingTasks, []);
});

test("Lyra released marker: 401 preserves retained owner and exposes working sign-in action", async (context) => {
  const environment = await interruptedLogout(context);
  const { current, database, localStorage, retained } = environment;
  respondAs(current, null);
  await current.initialize();
  assertRecovery(current);
  assert.equal(localStorage.getItem(marker), "1");
  assert.deepEqual(await dump(database), retained);
  assert.equal(current.calls.some((call) => call[0] === "redirect"), false);
  await click(current, "logoutRecoverySignIn");
  assert.ok(current.calls.some((call) => call[0] === "redirect"
    && call[1] === "/auth/google/start?return=%2Fapp"));
  assert.equal(localStorage.getItem(marker), "1");
  assert.deepEqual(await dump(database), retained);
  const signedIn = await environment.openTab();
  respondAs(signedIn, "account-A");
  await signedIn.initialize();
  await assertRecovered({ ...environment, current: signedIn });
});

test("Lyra owner-bound A marker rejects authenticated B without discarding marker", async (context) => {
  const environment = await interruptedLogout(context, "account-B");
  const { current, database, localStorage, retained } = environment;
  writeMarker(localStorage, JSON.stringify({ userId: ownerId("account-A") }));
  respondAs(current, "account-B");
  await current.initialize();
  assertRecovery(current);
  assert.equal(localStorage.getItem(marker), "1");
  assert.equal(localStorage.getItem(companion), JSON.stringify({ userId: ownerId("account-A") }));
  assert.deepEqual(await dump(database), retained);
});

test("Lyra bound A cleanup reaches ready offline with visible pending-revocation recovery", async (context) => {
  const environment = await interruptedLogout(context);
  const { current, database, localStorage } = environment;
  writeMarker(localStorage, JSON.stringify({ userId: ownerId("account-A") }));
  await current.initialize();
  assert.equal(current.state.ready, true);
  assertRecovery(current);
  assert.equal(localStorage.getItem(marker), "1");
  assert.equal(localStorage.getItem(companion), JSON.stringify({ userId: ownerId("account-A") }));
  const records = await dump(database);
  assert.equal(records.meta.some((row) => row.key === "snapshot"), false);
  for (const name of names.slice(1)) assert.deepEqual(records[name], []);
  respondAs(current, null);
  await click(current, "logoutRecoveryRetry");
  await assertRecovered(environment);
});

test("Lyra bound A cleanup remains idempotent with authenticated A after storage resumes", async (context) => {
  const environment = await interruptedLogout(context);
  writeMarker(environment.localStorage, JSON.stringify({ userId: ownerId("account-A") }));
  respondAs(environment.current, "account-A");
  await environment.current.initialize();
  await assertRecovered(environment);
});

test("Lyra authorized transaction abort rolls back every store, retains marker, then retry succeeds", async (context) => {
  const environment = await interruptedLogout(context);
  const { current, database, localStorage } = environment;
  await done(seedTransaction(database, "account-A"));
  const retained = await dump(database);
  const guarded = current.storage.guardedMutation;
  let aborted = false;
  current.storage.guardedMutation = (connection, stores, work, options) => guarded(connection, stores,
    (transaction, outcome, abort) => {
      work(transaction, outcome, abort);
      if (options.expectedUserId === ownerId("account-A")) {
        aborted = true;
        abort(new Error("Lyra forced cleanup abort"));
      }
    }, options);
  respondAs(current, "account-A");
  await current.initialize();
  assert.equal(aborted, true);
  assertRecovery(current);
  assert.equal(localStorage.getItem(marker), "1");
  assert.deepEqual(await dump(database), retained);
  current.storage.guardedMutation = guarded;
  await click(current, "logoutRecoveryRetry");
  await assertRecovered(environment);
});

test("Lyra committed cleanup with failed revocation retains marker until retry completes", async (context) => {
  const environment = await interruptedLogout(context);
  const { current, database, localStorage } = environment;
  respondAs(current, "account-A", { logoutStatus: 503 });
  await current.initialize();
  assertRecovery(current);
  assert.equal(localStorage.getItem(marker), "1");
  assert.ok(Object.values(await dump(database)).every((rows) => rows.length === 0));
  respondAs(current, "account-A");
  await click(current, "logoutRecoveryRetry");
  await assertRecovered(environment);
});

for (const race of ["identity", "owner record", "flag removal", "flag replacement"]) {
  test(`Lyra authenticated recovery rechecks ${race} after session await`, async (context) => {
    const environment = await interruptedLogout(context);
    const { current, database, localStorage, retained } = environment;
    respondAs(current, "account-A", { beforeSession: () => {
      if (race === "identity") identity(current, "account-B");
      if (race === "owner record") localStorage.setItem(companion, JSON.stringify({ userId: ownerId("account-B") }));
      if (race === "flag removal") localStorage.removeItem(marker);
      if (race === "flag replacement") localStorage.setItem(marker, "changed");
    } });
    await current.initialize();
    assert.deepEqual(await dump(database), retained);
    assert.equal(current.state.ready, false);
    assert.equal(current.calls.some((call) => call[1] === "/api/v1/auth/logout"), false);
    assert.equal(current.calls.some((call) => call[0] === "redirect"), false);
  });
}

test("Lyra authenticated cleanup queued behind B takeover preserves B and marker", async (context) => {
  const environment = await interruptedLogout(context);
  const { current, database, localStorage } = environment;
  const guarded = current.storage.guardedMutation;
  let retained;
  current.storage.guardedMutation = async (connection, stores, work, options) => {
    if (options.expectedUserId !== ownerId("account-A")) return guarded(connection, stores, work, options);
    const takeover = seedTransaction(database, "account-B");
    const cleanup = guarded(connection, stores, work, options);
    cleanup.catch(() => {});
    await done(takeover);
    retained = await dump(database);
    return cleanup;
  };
  respondAs(current, "account-A");
  await current.initialize();
  assertRecovery(current);
  assert.ok(retained);
  assert.equal(localStorage.getItem(marker), "1");
  assert.deepEqual(await dump(database), retained);
});

for (const race of ["identity", "marker"]) {
  test(`Lyra queued authorized cleanup rechecks ${race} inside transaction`, async (context) => {
    const environment = await interruptedLogout(context);
    const { current, database, localStorage, retained } = environment;
    const guarded = current.storage.guardedMutation;
    current.storage.guardedMutation = (connection, stores, work, options) => guarded(connection, stores,
      (transaction, outcome, abort) => {
        if (options.expectedUserId === ownerId("account-A")) {
          if (race === "identity") identity(current, "account-B");
          else localStorage.setItem(companion, JSON.stringify({ userId: ownerId("account-B") }));
        }
        work(transaction, outcome, abort);
      }, options);
    respondAs(current, "account-A");
    await current.initialize();
    assertRecovery(current);
    assert.equal(localStorage.getItem(marker), "1");
    assert.deepEqual(await dump(database), retained);
  });
}

test("Lyra delayed stale recovery cannot clear a newer marker after committed cleanup", async (context) => {
  const environment = await interruptedLogout(context);
  const { current, localStorage, database } = environment;
  respondAs(current, "account-A", { beforeRevocation: async () => {
    await done(seedTransaction(database, "account-B"));
    writeMarker(localStorage, JSON.stringify({ userId: ownerId("account-B") }));
  } });
  await current.initialize();
  assertRecovery(current);
  assert.equal(localStorage.getItem(marker), "1");
  assert.equal(localStorage.getItem(companion), JSON.stringify({ userId: ownerId("account-B") }));
  const records = await dump(database);
  assert.equal(records.meta.find((row) => row.key === "snapshot").value.user.id, "account-B");
  for (const name of names.slice(1)) assert.equal(records[name].length, 1);
});

test("Lyra simultaneous legacy recovery tabs serialize cleanup and preserve later unknown owner", async (context) => {
  const environment = await interruptedLogout(context);
  const { current, openTab, database, localStorage } = environment;
  const peer = await openTab();
  respondAs(current, "account-A");
  respondAs(peer, "account-A");
  await Promise.all([current.initialize(), peer.initialize()]);
  assert.equal((await dump(database)).pendingTasks.length, 0);
  assert.equal(localStorage.getItem(marker), null);
  await done(seedTransaction(database, "account-B"));
  writeMarker(localStorage, undefined);
  const retained = await dump(database);
  await peer.use.retryPendingLogout();
  assert.deepEqual(await dump(database), retained);
  assert.equal(localStorage.getItem(marker), "1");
  assertRecovery(peer);
});
