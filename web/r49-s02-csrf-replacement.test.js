"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const session = require("./app-session.js");
const { ownerId } = require("./test/incarnation-fixture.js");
const { fixture, dump, deferred } = require("./test/account-ownership-fixture.js");
const deletionKey = "pomodoroughPendingDeletion";

async function recovery(t, stage) {
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
    fetch: async (url, init) => { requests.push({ url, init }); reached.resolve(); return reply.promise; },
  });
  Object.assign(current.use, session.create({ state: current.state, external: current.external,
    use: current.use, emit: () => {} }));
  return { ...current, values, requests, reached, reply };
}

for (const stage of ["issued", null]) {
  for (const status of [204, 401]) {
    test(`R49-S02 ${stage || "legacy"} CSRF rotation fences delayed ${status}`, async (t) => {
      const current = await recovery(t, stage);
      const issuer = current.use.captureAccountContext();
      const pending = current.use.loadSession(issuer);
      await current.reached.promise;
      const attempt = JSON.parse(current.values.get(deletionKey));
      current.values.set(deletionKey, JSON.stringify({ ...attempt, csrfToken: "rotated-csrf" }));
      const before = await dump(current.use.database());
      const markers = [...current.values];
      current.reply.resolve({ ok: status === 204, status });
      await pending.catch((error) => assert.equal(error.name, "AccountOwnershipError"));
      assert.deepEqual(await dump(current.use.database()), before);
      assert.deepEqual([...current.values], markers);
      assert.equal(current.calls.some((call) => ["warn", "assign", "notice"].includes(call[0])), false);
      assert.equal(current.requests.length, 1);
      assert.equal(current.requests[0].init.headers["X-CSRF-Token"], "original-csrf");
    });
  }
}
