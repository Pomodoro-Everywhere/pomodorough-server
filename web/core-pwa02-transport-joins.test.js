"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const crypto = require("node:crypto");
const { fixture, storage, dump, seedMeta, snapshot, deferred, nowMs } = require("./test/account-ownership-fixture.js");
const { accountUser } = require("./test/incarnation-fixture.js");
const workspace = require("./workspace-core.js");
const evidence = [];

function productionModule(name) {
  if (!process.env.CORE_PWA02_TRANSPORT_BASELINE) return require(`./${name}`);
  const filename = path.join(__dirname, name);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(__dirname);
  loaded._compile(fs.readFileSync(path.join(process.env.CORE_PWA02_TRANSPORT_BASELINE, name), "utf8"), filename);
  return loaded.exports;
}

const sync = productionModule("sync-core.js");
const syncModule = productionModule("app-sync.js");
const sessionModule = productionModule("app-session.js");

test.after(() => {
  if (process.env.CORE_PWA02_TRANSPORT_EVIDENCE) fs.writeFileSync(process.env.CORE_PWA02_TRANSPORT_EVIDENCE,
    JSON.stringify({ provenance: require("./shared-core-metadata.js"), cases: evidence }, null, 2));
});

async function prepared(t) {
  const result = await fixture(t);
  const { stale } = result;
  const timers = new Map();
  const events = [];
  const requests = [];
  let timerId = 0;
  stale.external.syncCore = sync;
  stale.external.host.setTimeout = (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; };
  stale.external.host.clearTimeout = (id) => timers.delete(id);
  const memory = new Map();
  stale.external.host.localStorage = { getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, value), removeItem: (key) => memory.delete(key) };
  stale.external.host.location = { assign: (url) => events.push({ kind: "redirect", url }) };
  stale.use.render = () => events.push({ kind: "render", owner: sync.accountOwnerId(stale.state.user) });
  stale.use.renderProfile = () => events.push({ kind: "profile", owner: sync.accountOwnerId(stale.state.user) });
  stale.use.renderSyncStatus = () => events.push({ kind: "status", owner: sync.accountOwnerId(stale.state.user) });
  stale.use.scheduleSync = () => {};
  Object.assign(stale.use, sessionModule.create({ state: stale.state, external: stale.external, use: stale.use, emit() {} }));
  Object.assign(stale.use, syncModule.create({ state: stale.state, external: stale.external, use: stale.use, listen() {} }));
  await seedMeta(stale.use.database(), { canonicalHead: { wallMs: nowMs, counter: 2 } });
  await stale.use.reloadPersistedState();
  return { ...result, timers, events, requests };
}

function response(status, payload) { return { ok: status >= 200 && status < 300, status, json: async () => payload }; }

function observeFetch(current, handler) {
  current.stale.external.host.fetch = async (url, request = {}) => {
    current.requests.push({ url, method: request.method || "GET", body: request.body,
      headers: { ...(request.headers || {}) } });
    return handler(url, request);
  };
}

async function reopenSameOwner(current) {
  const { stale, open } = current;
  const oldDatabase = stale.use.database();
  await stale.use.clearLocalData(undefined, stale.use.captureDatabaseContext());
  assert.equal(stale.use.database(), null);
  const fresh = await open("account-A");
  await seedMeta(fresh.use.database(), { snapshot: snapshot("account-A"), deviceId: "shared-device", deviceSequence: 7,
    hlc: { wallMs: nowMs, counter: 200 }, canonicalHead: { wallMs: nowMs, counter: 200 }, settings: { selectedPhase: "focus" } });
  stale.use.setDatabaseForTest(fresh.use.database());
  assert.notEqual(stale.use.database(), oldDatabase);
  await stale.use.reloadPersistedState();
  await stale.use.persistDurationOperation("focus", 1800000);
  return dump(stale.use.database());
}

async function drainMicrotasks() {
  for (let turn = 0; turn < 40; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("CORE-PWA02 actual API 403 cannot refresh CSRF, allocate clock or resend after same-owner connection disposal", async (t) => {
  const current = await prepared(t);
  const { stale, requests, events } = current;
  const posted = deferred();
  const release = deferred();
  observeFetch(current, async (url, request) => {
    if (url === "/api/v1/me") return response(200, { user: accountUser("account-A"), csrfToken: "rotated-token" });
    assert.equal(url, "/api/v1/sync");
    if (requests.filter((item) => item.method === "POST").length === 1) { posted.resolve(); await release.promise; return response(403); }
    return response(503);
  });
  assert.equal(await stale.use.issueCommand("start"), true);
  const syncing = stale.use.syncNow(false);
  await posted.promise;
  const originalRequest = structuredClone(requests[0]);
  const before = await reopenSameOwner(current);
  const memoryBefore = structuredClone(stale.use.ownerStateValue());
  events.length = 0;
  release.resolve();
  await syncing;
  await drainMicrotasks();
  const after = await dump(stale.use.database());
  evidence.push({ case: t.name, originalRequest, requests: structuredClone(requests), before, after,
    events: structuredClone(events), memoryBefore, memoryAfter: structuredClone(stale.use.ownerStateValue()) });
  assert.deepEqual(requests, [originalRequest]);
  assert.deepEqual(after, before, "no request sequence or claim metadata changes in the reopened connection");
  assert.deepEqual(stale.use.ownerStateValue(), memoryBefore);
  assert.deepEqual(events, []);
});

function canonicalSuccess(current, request, base, user) {
  const body = JSON.parse(request.body);
  const queues = Object.fromEntries(workspace.DOMAINS.map((domain) => [domain,
    body[domain].map((item) => ({ ...item, deviceId: body.deviceId }))]));
  const projected = current.core.projectSynchronizedState({ base: workspace.base(base), pending: queues,
    now: new Date(nowMs).toISOString() });
  const acknowledgements = { commands: ["acknowledgements", "commandId"], taskOperations: ["taskAcknowledgements", "operationId"],
    durationOperations: ["durationAcknowledgements", "operationId"], autoStartOperations: ["autoStartAcknowledgements", "operationId"],
    selectedTaskOperations: ["selectedTaskAcknowledgements", "operationId"] };
  return { ...projected, revision: base.revision + 1, serverTime: new Date(nowMs).toISOString(),
    accountIncarnation: user.accountIncarnation, serverHlcWallMs: nowMs, serverHlcCounter: 500,
    ...Object.fromEntries(workspace.DOMAINS.map((domain) => {
      const [field, idField] = acknowledgements[domain];
      return [field, body[domain].map((item) => ({ [idField]: item.id, outcome: "applied", reason: "" }))];
    })) };
}

test("CORE-PWA02 actual API normal 403 refresh retries exact request once with the same issuer", async (t) => {
  const current = await prepared(t);
  const { stale, requests } = current;
  const base = snapshot("account-A");
  observeFetch(current, async (url, request) => {
    if (url === "/api/v1/me") return response(200, { user: accountUser("account-A"), csrfToken: "rotated-token" });
    assert.equal(url, "/api/v1/sync");
    if (requests.filter((item) => item.method === "POST").length === 1) return response(403);
    return response(200, canonicalSuccess(current, request, base, accountUser("account-A")));
  });
  assert.equal(await stale.use.issueCommand("start"), true);
  await stale.use.syncNow(false);
  const after = await dump(stale.use.database());
  evidence.push({ case: t.name, requests: structuredClone(requests), after });
  assert.deepEqual(requests.map((item) => [item.method, item.url]), [["POST", "/api/v1/sync"], ["GET", "/api/v1/me"], ["POST", "/api/v1/sync"]]);
  assert.equal(requests[0].body, requests[2].body);
  assert.equal(requests[0].headers["X-CSRF-Token"], "stub-csrf");
  assert.equal(requests[2].headers["X-CSRF-Token"], "rotated-token");
  assert.equal(after.meta.find((item) => item.key === "clockRequestSequence").value, 2);
  assert.deepEqual(after.pending, []);
  assert.equal(stale.state.retrying, false);
});

test("CORE-PWA02 actual CSRF GET result cannot rebind its issuer after same-account disposal", async (t) => {
  const current = await prepared(t);
  const { stale, requests, events } = current;
  const refreshing = deferred();
  const release = deferred();
  observeFetch(current, async (url) => {
    if (url === "/api/v1/me") {
      refreshing.resolve();
      await release.promise;
      return response(200, { user: accountUser("account-A"), csrfToken: "obsolete-refresh-token" });
    }
    assert.equal(url, "/api/v1/sync");
    return requests.filter((item) => item.method === "POST").length === 1 ? response(403) : response(503);
  });
  assert.equal(await stale.use.issueCommand("start"), true);
  const syncing = stale.use.syncNow(false);
  await refreshing.promise;
  const before = await reopenSameOwner(current);
  const csrfBefore = stale.state.csrfToken;
  const requestsBefore = structuredClone(requests);
  events.length = 0;
  release.resolve();
  await syncing;
  const after = await dump(stale.use.database());
  evidence.push({ case: t.name, before, after, requestsBefore, requests: structuredClone(requests),
    csrfBefore, csrfAfter: stale.state.csrfToken, events: structuredClone(events) });
  assert.deepEqual(requests, requestsBefore);
  assert.equal(stale.state.csrfToken, csrfBefore);
  assert.deepEqual(after, before);
  assert.deepEqual(events, []);
});

test("CORE-PWA02 actual second clock allocation return is fenced before a discarded-body resend", async (t) => {
  const current = await prepared(t);
  const { stale, requests, events } = current;
  const allocated = deferred();
  const release = deferred();
  let allocations = 0;
  const external = { ...stale.external, syncStorage: { ...storage, allocateClockRequestSequence: async (...args) => {
    const value = await storage.allocateClockRequestSequence(...args);
    if (++allocations === 2) { allocated.resolve(value); await release.promise; }
    return value;
  } } };
  Object.assign(stale.use, sessionModule.create({ state: stale.state, external, use: stale.use, emit() {} }));
  observeFetch(current, async (url) => url === "/api/v1/me"
    ? response(200, { user: accountUser("account-A"), csrfToken: "rotated-token" })
    : requests.filter((item) => item.method === "POST").length === 1 ? response(403) : response(503));
  assert.equal(await stale.use.issueCommand("start"), true);
  const syncing = stale.use.syncNow(false);
  assert.equal(await allocated.promise, 2);
  const before = await reopenSameOwner(current);
  const requestsBefore = structuredClone(requests);
  events.length = 0;
  release.resolve();
  await syncing;
  const after = await dump(stale.use.database());
  evidence.push({ case: t.name, before, after, requestsBefore, requests: structuredClone(requests), events: structuredClone(events) });
  assert.deepEqual(requests, requestsBefore);
  assert.deepEqual(after, before);
  assert.deepEqual(events, []);
});

async function replaceWorkspace(current, replacement) {
  const { stale, peer } = current;
  peer.state.user = replacement;
  const gateToken = peer.use.tabId();
  await storage.acquireBootstrapGate(peer.use.database(), { token: gateToken, nowMs, leaseMs: 300000 });
  const pending = await storage.captureResolution(peer.use.database(), { userId: sync.accountOwnerId(replacement),
    requestId: crypto.randomUUID(), deviceId: "shared-device", expectedRevision: 3, strategy: "keep_remote" }, { gateToken });
  const base = { ...snapshot(replacement.id, "running"), user: replacement,
    canonicalTimer: { ...snapshot(replacement.id, "running").canonicalTimer, id: "B-private-timer" } };
  const payload = { ...base, accountIncarnation: replacement.accountIncarnation, serverHlcWallMs: nowMs,
    serverHlcCounter: 100, acknowledgements: [], taskAcknowledgements: [], durationAcknowledgements: [],
    autoStartAcknowledgements: [], selectedTaskAcknowledgements: [] };
  delete payload.user;
  await peer.use.acceptBootstrapResponse(payload, pending, null, peer.use.captureAccountContext());
  await peer.use.persistDurationOperation("focus", 1800000);
  stale.state.user = replacement;
  stale.state.localOwnerId = sync.accountOwnerId(replacement);
  await stale.use.reloadPersistedState();
  return base;
}

function controlOwnerPosts(current) {
  const postedA = deferred();
  const releaseA = deferred();
  const postedB = deferred();
  const releaseB = deferred();
  const state = { baseB: null };
  observeFetch(current, async (url, request) => {
    assert.equal(url, "/api/v1/sync");
    if (current.requests.length === 1) { postedA.resolve(); await releaseA.promise; return response(503); }
    postedB.resolve();
    await releaseB.promise;
    return response(200, canonicalSuccess(current, request, state.baseB, current.stale.state.user));
  });
  return { postedA, releaseA, postedB, releaseB, state };
}

async function verifyReplacementContinuation(current, control, operationA, operationB, replacement, name) {
  let settledB = false;
  operationB.then(() => { settledB = true; });
  current.events.length = 0;
  control.releaseA.resolve();
  await operationA;
  const continuation = await Promise.race([control.postedB.promise.then(() => "posted"), operationB.then(() => "settled")]);
  const afterA = await dump(current.stale.use.database());
  const receipt = { case: name, requestsAfterA: structuredClone(current.requests), afterA,
    samePromise: operationA === operationB, settledB, continuation, events: structuredClone(current.events) };
  evidence.push(receipt);
  assert.notEqual(operationA, operationB);
  assert.equal(continuation, "posted");
  assert.equal(current.requests.length, 2, "only the explicit B invocation authorizes its POST");
  assert.equal(settledB, false, "B's promise waits for B's own response");
  assert.equal(current.stale.state.syncing, true, "A cleanup does not clear B's guard");
  assert.equal(current.requests[1].headers["X-Pomodorough-Account-Incarnation"], replacement.accountIncarnation);
  assert.deepEqual(JSON.parse(current.requests[1].body).commands, []);
  assert.equal(JSON.parse(current.requests[1].body).durationOperations.length, 1);
  control.releaseB.resolve();
  await operationB;
  receipt.afterB = await dump(current.stale.use.database());
  receipt.requestsAfterB = structuredClone(current.requests);
  receipt.settledAfterBResponse = settledB;
  assert.equal(settledB, true);
  assert.equal(current.requests.length, 2, "coalesced B callers do not create a duplicate POST");
  assert.equal(current.stale.state.syncing, false);
  assert.deepEqual((await storage.readQueues(current.stale.use.database())).durationOperations, []);
}

for (const replacement of [accountUser("account-B"), accountUser("account-A", 2)]) {
  test(`CORE-PWA02 explicit replacement sync owns a separate continuation and promise: ${replacement.id}`, async (t) => {
    const current = await prepared(t);
    const { stale } = current;
    const control = controlOwnerPosts(current);
    assert.equal(await stale.use.issueCommand("start"), true);
    const operationA = stale.use.syncNow(false);
    await control.postedA.promise;
    control.state.baseB = await replaceWorkspace(current, replacement);
    const operationB = stale.use.syncNow(false);
    const forcedB = stale.use.syncNow(true);
    assert.equal(forcedB, operationB, "same-scope B joins share B's continuation");
    await verifyReplacementContinuation(current, control, operationA, operationB, replacement, t.name);
  });
}

test("CORE-PWA02 same-owner concurrent joins still coalesce one actual transport request", async (t) => {
  const current = await prepared(t);
  const { stale, requests } = current;
  const posted = deferred();
  const release = deferred();
  observeFetch(current, async (url, request) => {
    assert.equal(url, "/api/v1/sync");
    posted.resolve();
    await release.promise;
    return response(200, canonicalSuccess(current, request, snapshot("account-A"), accountUser("account-A")));
  });
  assert.equal(await stale.use.issueCommand("start"), true);
  const first = stale.use.syncNow(false);
  await posted.promise;
  const second = stale.use.syncNow(true);
  const third = stale.use.syncNow(false);
  assert.equal(first, second);
  assert.equal(second, third);
  assert.equal(requests.length, 1);
  release.resolve();
  await Promise.all([first, second, third]);
  evidence.push({ case: t.name, requests: structuredClone(requests), after: await dump(stale.use.database()) });
  assert.equal(requests.length, 1);
  assert.equal(stale.state.syncing, false);
  assert.deepEqual((await storage.readQueues(stale.use.database())).commands, []);
});
