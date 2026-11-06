"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { viewFixture, setVisibility, settle, forceDisplayStatus } = require("./test/ux-view-fixture.js");

function fakeWakeLock(current, { reject = null } = {}) {
  const log = { requests: [], sentinels: [] };
  current.host.navigator.wakeLock = {
    request: async (type) => {
      log.requests.push(type);
      if (reject) throw reject();
      const listeners = [];
      const sentinel = { type, released: false,
        addEventListener: (name, listener) => { if (name === "release") listeners.push(listener); },
        release: async () => { sentinel.released = true; listeners.forEach((listener) => listener()); } };
      log.sentinels.push(sentinel);
      return sentinel;
    }
  };
  return log;
}

function warnings(current) {
  return current.calls.filter((entry) => Array.isArray(entry) && entry[0] === "warn" && entry[1] === "Screen wake lock unavailable:");
}

test("running timer requests one screen wake lock and releases it when paused", async (t) => {
  const current = await viewFixture(t, "running");
  const lock = fakeWakeLock(current);
  current.view.renderTimer();
  await settle();
  assert.deepEqual(lock.requests, ["screen"]);
  current.view.renderTimer();
  await settle();
  assert.deepEqual(lock.requests, ["screen"], "held lock is not re-requested");
  forceDisplayStatus(current, "paused");
  current.view.renderTimer();
  await settle();
  assert.equal(lock.sentinels[0].released, true);
  forceDisplayStatus(current, "running");
  current.view.renderTimer();
  await settle();
  assert.deepEqual(lock.requests, ["screen", "screen"], "resumed run re-acquires");
});

for (const status of [null, "completed"]) {
  test(`${status || "idle"} timer never requests a wake lock`, async (t) => {
    const current = await viewFixture(t, status);
    const lock = fakeWakeLock(current);
    current.view.renderTimer();
    await settle();
    assert.deepEqual(lock.requests, []);
  });
}

test("missing Wake Lock API is a no-op", async (t) => {
  const current = await viewFixture(t, "running");
  assert.equal(current.host.navigator.wakeLock, undefined);
  current.view.renderTimer();
  await settle();
  assert.deepEqual(warnings(current), []);
});

test("a refused request warns once and retries only after the page becomes visible", async (t) => {
  const current = await viewFixture(t, "running");
  const lock = fakeWakeLock(current, { reject: () => Object.assign(new Error("not allowed"), { name: "NotAllowedError" }) });
  current.view.renderTimer();
  await settle();
  current.view.renderTimer();
  await settle();
  assert.deepEqual(lock.requests, ["screen"], "denied request is not retried on every tick");
  assert.equal(warnings(current).length, 1);
  assert.equal(current.elements.notice.hidden, true);
  setVisibility(current.document, "visible");
  await settle();
  assert.deepEqual(lock.requests, ["screen", "screen"]);
  assert.equal(warnings(current).length, 1, "second refusal stays silent");
});

test("a lock granted after the run ended is released immediately", async (t) => {
  const current = await viewFixture(t, "running");
  let grant;
  const sentinel = { released: false, addEventListener: () => {}, release: async () => { sentinel.released = true; } };
  current.host.navigator.wakeLock = { request: () => new Promise((resolve) => { grant = () => resolve(sentinel); }) };
  current.view.renderTimer();
  await settle();
  forceDisplayStatus(current, "paused");
  current.view.renderTimer();
  grant();
  await settle();
  assert.equal(sentinel.released, true);
});

test("a lock released by the browser is re-requested on the next running render", async (t) => {
  const current = await viewFixture(t, "running");
  const lock = fakeWakeLock(current);
  current.view.renderTimer();
  await settle();
  await lock.sentinels[0].release();
  current.view.renderTimer();
  await settle();
  assert.deepEqual(lock.requests, ["screen", "screen"]);
});
