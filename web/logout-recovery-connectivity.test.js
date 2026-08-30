"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { interruptedLogout, respondAs, assertRecovery, assertRecovered, click,
  marker, companion, done, seedTransaction, dump, writeMarker, names
} = require("./test/legacy-logout-lyra-fixture.js");

function serveOwner(current, options = {}) {
  respondAs(current, "account-A", options);
  const onlineFetch = current.context.fetch;
  current.context.fetch = (...args) => current.context.navigator.onLine
    ? onlineFetch(...args) : current.host.fetch(...args);
}

async function unknownOwnerRecovery(context, record, flag = "1") {
  const environment = await interruptedLogout(context, "account-B");
  const { current, database, localStorage, retained } = environment;
  const transaction = seedTransaction(database, "account-B");
  const tasks = transaction.objectStore("pendingTasks");
  tasks.clear();
  tasks.put(retained.pendingTasks[0]);
  await done(transaction);
  writeMarker(localStorage, record, flag);
  const register = current.context.addEventListener;
  current.context.addEventListener = (name, callback) => {
    current.calls.push(["listener", name]);
    register(name, callback);
  };
  const before = await dump(database);
  serveOwner(current);
  await current.initialize();
  return { ...environment, retained: before, record: record ?? null, flag };
}

function connectivity(current, online) {
  const event = online ? "online" : "offline";
  const listener = current.events.get(event);
  assert.equal(typeof listener, "function", event + " must be initialized");
  assert.equal(current.calls.filter(([kind, name]) => kind === "listener" && name === event).length, 1);
  current.context.navigator.onLine = online;
  listener();
}

function assertActions(current, busy = false) {
  assertRecovery(current);
  assert.equal(current.state.logoutRecoveryBusy, busy);
  assert.equal(current.elements.get("#logoutRecoveryRetry").disabled, busy);
  assert.equal(current.elements.get("#logoutRecoverySignIn").disabled,
    busy || !current.context.navigator.onLine);
  assert.equal(current.elements.get("#bootstrapDialog").attributes["aria-busy"], String(busy));
  for (const id of ["logoutRecoveryRetry", "logoutRecoverySignIn", "timerToggle"]) {
    assert.equal(current.elements.get("#" + id).listenerCounts.get("click"), 1);
  }
}

async function assertPreserved(environment, redirects = []) {
  const { current, database, localStorage, retained, record, flag } = environment;
  assert.equal(current.state.ready, false);
  assert.equal(localStorage.getItem(marker), flag);
  assert.equal(localStorage.getItem(companion), record);
  assert.deepEqual(await dump(database), retained);
  for (const name of names) assert.ok(retained[name].length > 0, name + " must be populated");
  assert.equal(current.calls.some((call) => call[1] === "/api/v1/auth/logout"), false);
  assert.deepEqual(current.calls.filter(([kind]) => kind === "redirect"), redirects);
}

async function waitForRetry(current) {
  for (let turn = 0; current.state.logoutRecoveryBusy && turn < 200; turn += 1) {
    await new Promise(setImmediate);
  }
  assert.equal(current.state.logoutRecoveryBusy, false, "connectivity retry must settle");
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

for (const [label, record, flag] of [
  ["released marker", undefined, "1"],
  ["malformed marker", "{", ""],
  ["mismatched owner companion", '{"userId":"account-A"}', "1"]
]) {
  test(`connectivity: ${label} preserves unknown B through repeated real events and retries`, async (context) => {
    const environment = await unknownOwnerRecovery(context, record, flag);
    const { current } = environment;
    assertActions(current);
    await assertPreserved(environment);
    for (let cycle = 0; cycle < 3; cycle += 1) {
      let closed = false;
      current.use.setRevisionStreamForTest({ close() { closed = true; } });
      current.state.syncing = true;
      current.state.retrying = true;
      connectivity(current, false);
      assert.equal(closed, true);
      assert.equal(current.use.hasRevisionStreamForTest(), false);
      assert.equal(current.state.syncing, false);
      assert.equal(current.state.retrying, false);
      assertActions(current);
      await assertPreserved(environment);
      await click(current, "logoutRecoveryRetry");
      assertActions(current);
      await assertPreserved(environment);
      connectivity(current, true);
      assertActions(current, true);
      await waitForRetry(current);
      assertActions(current);
      await assertPreserved(environment);
    }
  });
}

test("connectivity: stale enabled sign-in cannot redirect offline and works once online", async (context) => {
  const environment = await unknownOwnerRecovery(context);
  const { current } = environment;
  assertActions(current);
  current.context.navigator.onLine = false;
  assert.equal(current.elements.get("#logoutRecoverySignIn").disabled, false);
  await click(current, "logoutRecoverySignIn");
  assertActions(current);
  await assertPreserved(environment);
  await click(current, "logoutRecoveryRetry");
  assertActions(current);
  await assertPreserved(environment);
  connectivity(current, true);
  await waitForRetry(current);
  assertActions(current);
  await click(current, "logoutRecoverySignIn");
  await click(current, "logoutRecoverySignIn");
  await assertPreserved(environment, [["redirect", "/auth/google/start?return=%2Fapp"]]);
});

test("connectivity: busy retry blocks stale sign-in and overlapping real events without touching B", async (context) => {
  const environment = await unknownOwnerRecovery(context);
  const { current } = environment;
  const entered = deferred();
  const release = deferred();
  context.after(release.resolve);
  serveOwner(current, { beforeSession: () => { entered.resolve(); return release.promise; } });
  const retry = click(current, "logoutRecoveryRetry");
  assertActions(current, true);
  await entered.promise;
  const sessionCalls = current.calls.filter((call) => call[1] === "/api/v1/me").length;
  current.elements.get("#logoutRecoverySignIn").disabled = false;
  await click(current, "logoutRecoverySignIn");
  assertActions(current, true);
  await assertPreserved(environment);
  for (let cycle = 0; cycle < 3; cycle += 1) {
    connectivity(current, false);
    assertActions(current, true);
    connectivity(current, true);
    assertActions(current, true);
    assert.equal(await current.elements.get("#logoutRecoveryRetry").listeners.get("click")(), false);
    await assertPreserved(environment);
  }
  assert.equal(current.calls.filter((call) => call[1] === "/api/v1/me").length, sessionCalls);
  connectivity(current, false);
  release.resolve();
  await retry;
  assertActions(current);
  await assertPreserved(environment);
  await click(current, "logoutRecoveryRetry");
  assertActions(current);
  await assertPreserved(environment);
  connectivity(current, true);
  await waitForRetry(current);
  assertActions(current);
  await assertPreserved(environment);
});

test("connectivity: online event still finishes authorized cleanup during busy recovery", async (context) => {
  const environment = await interruptedLogout(context);
  const { current, database, localStorage } = environment;
  await current.initialize();
  assertActions(current);
  serveOwner(current, { beforeRevocation: async () => {
    assert.equal(current.state.logoutRecoveryBusy, true);
    assert.equal(localStorage.getItem(marker), "1");
    assert.equal(localStorage.getItem(companion), null);
    assert.ok(Object.values(await dump(database)).every((rows) => rows.length === 0));
  } });
  current.events.get("online")();
  assertActions(current, true);
  await waitForRetry(current);
  await assertRecovered(environment);
  const cold = await environment.openTab();
  await cold.initialize();
  assert.equal(cold.state.ready, true);
  assert.equal(cold.state.offlineOwnerMode, false);
  assert.equal(cold.state.user, null);
  for (const name of names.slice(1)) assert.deepEqual((await dump(database))[name], []);
});

test("connectivity: offline peer cleanup rejection keeps recovery and every unknown B store", async (context) => {
  const environment = await unknownOwnerRecovery(context);
  const { current, localStorage } = environment;
  connectivity(current, false);
  assertActions(current);
  environment.record = '{"userId":"account-A"}';
  writeMarker(localStorage, environment.record);
  await assertPreserved(environment);
  const rejected = deferred();
  const warn = current.context.console.warn;
  current.context.console.warn = (...args) => {
    warn(...args);
    if (args[0] === "Cross-tab sign-out cleanup was incomplete:") rejected.resolve(args[1]);
  };
  current.elements.get("#logoutRecoverySignIn").disabled = false;
  const listener = current.events.get("storage");
  assert.equal(typeof listener, "function");
  assert.equal(current.calls.filter(([kind, name]) => kind === "listener" && name === "storage").length, 1);
  listener({ key: marker, newValue: "1" });
  assert.equal((await rejected.promise).name, "AccountOwnershipError");
  await new Promise(setImmediate);
  assertActions(current);
  await assertPreserved(environment);
  await click(current, "logoutRecoveryRetry");
  assertActions(current);
  await assertPreserved(environment);
});
