"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const session = require("./app-session.js");
const { accountUser, ownerId } = require("./test/incarnation-fixture.js");
const { fixture, dump, deferred, seedMeta } = require("./test/account-ownership-fixture.js");
const deletionKey = "pomodoroughPendingDeletion";

async function recovery(t, stage = "issued") {
  const { stale: current } = await fixture(t);
  const values = new Map([[deletionKey, JSON.stringify({ userId: ownerId("account-A"),
    csrfToken: "original-csrf", ...(stage ? { stage } : {}) })]]);
  const reached = deferred();
  const reply = deferred();
  const requests = [];
  Object.assign(current.external.host, {
    localStorage: { getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) },
    location: { assign: (url) => current.calls.push(["assign", url]) },
    fetch: async (url, init) => { requests.push({ url, init }); reached.resolve(); return reply.promise; }
  });
  Object.assign(current.use, session.create({ state: current.state, external: current.external,
    use: current.use, emit: () => {} }));
  return { ...current, values, requests, reached, reply };
}

function assertSilent(current, markers) {
  assert.deepEqual([...current.values], markers);
  assert.equal(current.calls.some((call) => ["warn", "assign", "notice"].includes(call[0])), false);
}

for (const stage of ["issued", null]) {
  for (const change of ["connection", "attempt", "candidate", "incarnation"]) {
    for (const status of [204, 400, 401, 403]) {
      test(`R49-S02 ${stage || "legacy"} ${change} fences delayed ${status}`, async (t) => {
        const current = await recovery(t, stage);
        const issuer = current.use.captureAccountContext();
        const pending = current.use.loadSession(issuer);
        await current.reached.promise;
        if (change === "connection") {
          current.use.database().close();
          current.use.setDatabaseForTest(null);
          current.use.setDatabaseForTest(await current.use.openDatabase());
          await seedMeta(current.use.database(), { replacement: "retain" });
        } else if (change === "incarnation") {
          current.state.user = accountUser("account-A", 2);
          current.state.localOwnerId = ownerId("account-A", 2);
        } else {
          const attempt = JSON.parse(current.values.get(deletionKey));
          current.values.set(deletionKey, JSON.stringify({ ...attempt,
            ...(change === "candidate" ? { stage: "candidate" } : { attemptId: "replacement" }) }));
        }
        const before = await dump(current.use.database());
        const markers = [...current.values];
        current.reply.resolve({ ok: status === 204, status });
        await pending.catch((error) => assert.equal(error.name, "AccountOwnershipError"));
        assert.deepEqual(await dump(current.use.database()), before);
        assertSilent(current, markers);
        assert.equal(current.requests.length, 1);
      });
    }
  }
}

test("R49-S02 invalid issuer cannot submit recovery transport", async (t) => {
  const current = await recovery(t);
  const issuer = current.use.captureAccountContext();
  current.use.setDatabaseForTest(null);
  const markers = [...current.values];
  await assert.rejects(current.use.loadSession(issuer), { name: "AccountOwnershipError" });
  assert.equal(current.requests.length, 0);
  assertSilent(current, markers);
});

test("R49-S02 attempt replacement inside cleanup aborts the guarded transaction silently", async (t) => {
  const current = await recovery(t);
  const database = current.use.database();
  const transaction = database.transaction.bind(database);
  const before = await dump(current.use.database());
  database.transaction = (...args) => {
    const opened = transaction(...args);
    if (args[1] === "readwrite") queueMicrotask(() => current.values.set(deletionKey, JSON.stringify({
      userId: ownerId("account-A"), csrfToken: "replacement-csrf", stage: "issued"
    })));
    return opened;
  };
  const pending = current.use.loadSession();
  await current.reached.promise;
  current.reply.resolve({ ok: true, status: 204 });
  assert.equal(await pending, false);
  assert.deepEqual(await dump(current.use.database()), before);
  assert.equal(JSON.parse(current.values.get(deletionKey)).csrfToken, "replacement-csrf");
  assert.equal(current.calls.some((call) => ["warn", "assign", "notice"].includes(call[0])), false);
});

test("R49-S02 renewed confirmations with identical credentials have distinct attempt identities", async (t) => {
  const current = await recovery(t);
  current.external.elements.deleteAccountButton = { disabled: false };
  current.external.host.fetch = async () => { throw new Error("lost response"); };
  assert.equal(await current.use.deleteAccount("DELETE"), false);
  const first = JSON.parse(current.values.get(deletionKey));
  assert.equal(await current.use.deleteAccount("DELETE"), false);
  const second = JSON.parse(current.values.get(deletionKey));
  assert.notEqual(first.attemptId, second.attemptId);
  assert.deepEqual({ ...first, attemptId: null }, { ...second, attemptId: null });
});

test("R49-S02 replacement after cleanup returns cannot remove replacement markers or redirect", async (t) => {
  const current = await recovery(t);
  const clear = current.use.clearLocalData;
  current.use.clearLocalData = async (...args) => {
    const completed = await clear(...args);
    current.values.set(deletionKey, JSON.stringify({ userId: ownerId("account-A"),
      csrfToken: "replacement-csrf", stage: "issued" }));
    return completed;
  };
  const pending = current.use.loadSession();
  await current.reached.promise;
  current.reply.resolve({ ok: true, status: 204 });
  assert.equal(await pending, false);
  assert.equal(JSON.parse(current.values.get(deletionKey)).csrfToken, "replacement-csrf");
  assert.equal(current.values.get("pomodoroughPendingLogout"), "1");
  assert.equal(current.calls.some((call) => ["warn", "assign", "notice"].includes(call[0])), false);
});

test("R49-S02 genuine current cleanup failure retains existing retry diagnostic", async (t) => {
  const current = await recovery(t);
  const before = await dump(current.use.database());
  current.use.clearLocalData = async () => { throw new Error("disk full"); };
  const pending = current.use.loadSession();
  await current.reached.promise;
  current.reply.resolve({ ok: true, status: 204 });
  assert.equal(await pending, false);
  assert.deepEqual(await dump(current.use.database()), before);
  assert.ok(current.values.has(deletionKey));
  assert.equal(current.values.get("pomodoroughPendingLogout"), "1");
  assert.equal(current.calls.filter((call) => call[0] === "warn").length, 1);
  assert.equal(current.calls.filter((call) => call[0] === "assign").length, 1);
});

test("R49-S02 delayed cleanup failure after attempt replacement remains silent", async (t) => {
  const current = await recovery(t);
  const before = await dump(current.use.database());
  current.use.clearLocalData = async () => {
    current.values.set(deletionKey, JSON.stringify({ userId: ownerId("account-A"),
      csrfToken: "replacement-csrf", stage: "issued" }));
    throw new Error("disk full");
  };
  const pending = current.use.loadSession();
  await current.reached.promise;
  current.reply.resolve({ ok: true, status: 204 });
  assert.equal(await pending, false);
  assert.deepEqual(await dump(current.use.database()), before);
  assert.equal(JSON.parse(current.values.get(deletionKey)).csrfToken, "replacement-csrf");
  assert.equal(current.calls.some((call) => ["warn", "assign", "notice"].includes(call[0])), false);
});
