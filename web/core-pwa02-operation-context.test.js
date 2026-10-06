"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { fixture, storage, dump, seedMeta, snapshot, deferred, nowMs } = require("./test/account-ownership-fixture.js");
const { accountUser } = require("./test/incarnation-fixture.js");
const sync = require("./sync-core.js");
const workspace = require("./workspace-core.js");
const evidence = [];

function productionModule(name) {
  if (!process.env.CORE_PWA02_OPERATION_BASELINE) return require(`./${name}`);
  const filename = path.join(__dirname, name);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(__dirname);
  loaded._compile(fs.readFileSync(path.join(process.env.CORE_PWA02_OPERATION_BASELINE, name), "utf8"), filename);
  return loaded.exports;
}

test.after(() => {
  if (process.env.CORE_PWA02_OPERATION_EVIDENCE) fs.writeFileSync(process.env.CORE_PWA02_OPERATION_EVIDENCE,
    JSON.stringify({ provenance: require("./shared-core-metadata.js"), cases: evidence }, null, 2));
});

async function prepared(t, overrides = {}) {
  const current = await fixture(t);
  const { stale } = current;
  const events = [];
  const requests = [];
  const timers = new Map();
  const host = stale.external.host;
  let timerId = 0;
  host.setTimeout = (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; };
  host.clearTimeout = (id) => timers.delete(id);
  const memory = new Map();
  host.localStorage = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value),
    removeItem: (key) => memory.delete(key) };
  host.location = { assign: (url) => events.push(["redirect", url]) };
  host.EventSource = class { addEventListener() {} close() {} };
  stale.external.elements = { bootstrapRetry: {}, bootstrapConfirm: {}, bootstrapChoiceButtons: [] };
  const external = { ...stale.external, syncStorage: { ...storage, ...overrides } };
  for (const name of ["app-state.js", "app-storage.js", "app-sync.js", "app-bootstrap.js", "app-session.js"]) {
    Object.assign(stale.use, productionModule(name).create({ state: stale.state, external, use: stale.use, emit() {}, listen() {} }));
  }
  stale.use.setDatabaseForTest(await stale.use.openDatabase());
  await seedMeta(stale.use.database(), { canonicalHead: { wallMs: nowMs, counter: 2 } });
  await stale.use.reloadPersistedState();
  for (const name of ["render", "renderProfile", "renderSyncStatus", "renderBootstrapDialog"]) {
    stale.use[name] = () => events.push([name, sync.accountOwnerId(stale.state.user)]);
  }
  return { ...current, external, events, requests, timers };
}

function response(status, payload) { return { ok: status >= 200 && status < 300, status, json: async () => payload }; }

function observeFetch(current, handler) {
  current.stale.external.host.fetch = async (url, request = {}) => {
    current.requests.push({ url, method: request.method || "GET", body: request.body, headers: { ...request.headers } });
    return handler(url, request);
  };
}

async function reopen(current) {
  const { stale } = current;
  const oldDatabase = stale.use.database();
  await stale.use.clearLocalData(undefined, stale.use.captureDatabaseContext());
  assert.equal(stale.use.database(), null);
  stale.use.setDatabaseForTest(await stale.use.openDatabase());
  assert.notEqual(stale.use.database(), oldDatabase);
  await seedMeta(stale.use.database(), { snapshot: snapshot("account-A"), deviceId: "shared-device", deviceSequence: 7,
    hlc: { wallMs: nowMs, counter: 200 }, canonicalHead: { wallMs: nowMs, counter: 200 }, settings: { selectedPhase: "focus" } });
  await stale.use.reloadPersistedState();
  Object.assign(stale.state, { bootstrapPending: null, bootstrapBlocked: false, bootstrapSubmitting: false,
    bootstrapGateOwned: false, bootstrapGatePersisted: false, csrfToken: "replacement-token" });
  await stale.use.persistDurationOperation("focus", 1800000);
  return { persisted: await dump(stale.use.database()), owner: structuredClone(stale.use.ownerStateValue()),
    session: sessionState(stale.state), requests: structuredClone(current.requests) };
}

function sessionState(state) {
  return structuredClone({ csrfToken: state.csrfToken, clockOffset: state.clockOffset,
    authenticated: state.authenticated, sessionIdentityValidated: state.sessionIdentityValidated,
    bootstrapPending: state.bootstrapPending, bootstrapBlocked: state.bootstrapBlocked,
    bootstrapError: state.bootstrapError });
}

async function assertDiscarded(current, before, name) {
  const after = { persisted: await dump(current.stale.use.database()), owner: structuredClone(current.stale.use.ownerStateValue()),
    session: sessionState(current.stale.state), requests: structuredClone(current.requests) };
  evidence.push({ case: name, before, after, events: structuredClone(current.events) });
  assert.deepEqual(after, before);
  assert.deepEqual(current.events, []);
}

function canonicalSuccess(current, request) {
  const body = JSON.parse(request.body);
  const pending = Object.fromEntries(workspace.DOMAINS.map((domain) => [domain,
    (body[domain] || []).map((item) => ({ ...item, deviceId: body.deviceId }))]));
  const projected = current.core.projectSynchronizedState({ base: workspace.base(snapshot("account-A")), pending,
    now: new Date(nowMs).toISOString() });
  const acknowledgements = { commands: ["acknowledgements", "commandId"], taskOperations: ["taskAcknowledgements", "operationId"],
    durationOperations: ["durationAcknowledgements", "operationId"], autoStartOperations: ["autoStartAcknowledgements", "operationId"],
    selectedTaskOperations: ["selectedTaskAcknowledgements", "operationId"] };
  return { ...projected, revision: 4, serverTime: new Date(nowMs).toISOString(),
    accountIncarnation: accountUser("account-A").accountIncarnation, serverHlcWallMs: nowMs, serverHlcCounter: 500,
    ...Object.fromEntries(workspace.DOMAINS.map((domain) => {
      const [field, idField] = acknowledgements[domain];
      return [field, (body[domain] || []).map((item) => ({ [idField]: item.id, outcome: "applied", reason: "" }))];
    })) };
}

async function saveMerge(current) {
  const { stale } = current;
  stale.state.bootstrapPreview = snapshot("account-A");
  stale.state.bootstrapPlan = { mode: "choose", strategy: "merge" };
  await stale.use.persistDurationOperation("focus", 1200000);
  return stale.use.persistBootstrapResolution("merge");
}

for (const savedRetry of [false, true]) {
  test(`CORE-PWA02 bootstrap actual 403 cannot resend discarded merge: saved retry=${savedRetry}`, async (t) => {
    const current = await prepared(t);
    const posted = deferred();
    const release = deferred();
    let firstFailure = savedRetry;
    observeFetch(current, async (url) => {
      if (url === "/api/v1/me") return response(200, { user: accountUser("account-A"), csrfToken: "obsolete-bootstrap-token" });
      assert.equal(url, "/api/v1/bootstrap/resolve");
      if (firstFailure) { firstFailure = false; return response(503); }
      if (!posted.done) { posted.done = true; posted.resolve(); await release.promise; return response(403); }
      return response(503);
    });
    await saveMerge(current);
    if (savedRetry) await current.stale.use.submitBootstrapResolution();
    const submitting = savedRetry ? current.stale.use.retryBootstrapResolution() : current.stale.use.submitBootstrapResolution();
    await posted.promise;
    const before = await reopen(current);
    current.events.length = 0;
    release.resolve();
    await submitting;
    await assertDiscarded(current, before, t.name);
  });
}

for (const boundary of ["validatePendingForSend", "applyResolution", "readSyncState"]) {
  test(`CORE-PWA02 bootstrap preserves issuing connection across committed ${boundary}`, async (t) => {
    const entered = deferred();
    const release = deferred();
    let armed = false;
    const current = await prepared(t, { [boundary]: async (...args) => {
      const value = await storage[boundary](...args);
      if (armed) { armed = false; entered.resolve(); await release.promise; }
      return value;
    } });
    await saveMerge(current);
    observeFetch(current, async (_url, request) => {
      if (boundary === "readSyncState") armed = true;
      return response(200, canonicalSuccess(current, request));
    });
    if (boundary !== "readSyncState") armed = true;
    const submitting = current.stale.use.submitBootstrapResolution();
    await entered.promise;
    const before = await reopen(current);
    current.events.length = 0;
    release.resolve();
    await submitting;
    await assertDiscarded(current, before, t.name);
  });
}

test("CORE-PWA02 sync 503 auth recovery cannot publish session or drain reopened duration queue", async (t) => {
  const current = await prepared(t);
  const entered = deferred();
  const release = deferred();
  observeFetch(current, async (url, request) => {
    if (url === "/api/v1/me") {
      entered.resolve(); await release.promise;
      return response(200, { user: accountUser("account-A"), csrfToken: "obsolete-recovery-token" });
    }
    return current.requests.filter((item) => item.method === "POST").length === 1
      ? response(503) : response(200, canonicalSuccess(current, request));
  });
  await current.stale.use.persistDurationOperation("focus", 1200000);
  await current.stale.use.syncNow(false);
  Object.assign(current.stale.state, { authenticated: false, csrfToken: null, sessionIdentityValidated: false });
  const recovering = [...current.timers.values()].at(-1).callback();
  await entered.promise;
  const before = await reopen(current);
  current.events.length = 0;
  release.resolve();
  await recovering;
  await assertDiscarded(current, before, t.name);
});

test("CORE-PWA02 queued session revalidation keeps original connection before callback starts", async (t) => {
  const current = await prepared(t);
  observeFetch(current, async (url, request) => url === "/api/v1/me"
    ? response(200, { user: accountUser("account-A"), csrfToken: "obsolete-queued-token" })
    : response(200, canonicalSuccess(current, request)));
  current.stale.use.queueSessionRevalidation();
  const callback = [...current.timers.values()].at(-1).callback;
  const before = await reopen(current);
  current.events.length = 0;
  await callback();
  await assertDiscarded(current, before, t.name);
});

for (const savedRetry of [false, true]) {
  test(`CORE-PWA02 normal bootstrap actual 403 preserves exact saved merge: saved retry=${savedRetry}`, async (t) => {
    const current = await prepared(t);
    let firstFailure = savedRetry;
    let refresh = true;
    observeFetch(current, async (url, request) => {
      if (url === "/api/v1/me") return response(200, { user: accountUser("account-A"), csrfToken: "normal-token" });
      if (firstFailure) { firstFailure = false; return response(503); }
      if (refresh) { refresh = false; return response(403); }
      return response(200, canonicalSuccess(current, request));
    });
    const pending = await saveMerge(current);
    if (savedRetry) await current.stale.use.submitBootstrapResolution();
    await current.stale.use.retryBootstrapResolution();
    const posts = current.requests.filter((item) => item.method === "POST");
    const after = await dump(current.stale.use.database());
    evidence.push({ case: t.name, pending, requests: structuredClone(current.requests), after });
    assert.equal(posts.length, savedRetry ? 3 : 2);
    for (const post of posts) assert.equal(post.body, JSON.stringify(pending.payload));
    assert.equal(posts.at(-1).headers["X-CSRF-Token"], "normal-token");
    assert.equal(current.stale.state.bootstrapPending, null);
    assert.deepEqual(after.pendingDurations, []);
  });
}

test("CORE-PWA02 manual online recovery authorizes one current duration POST", async (t) => {
  const current = await prepared(t);
  Object.assign(current.stale.state, { authenticated: false, csrfToken: null, sessionIdentityValidated: false });
  await current.stale.use.persistDurationOperation("focus", 1200000);
  observeFetch(current, async (url, request) => url === "/api/v1/me"
    ? response(200, { user: accountUser("account-A"), csrfToken: "manual-token" })
    : response(200, canonicalSuccess(current, request)));
  await current.stale.use.handleOnline();
  for (let turn = 0; turn < 1000; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  const after = await dump(current.stale.use.database());
  evidence.push({ case: t.name, requests: structuredClone(current.requests), after });
  assert.deepEqual(current.requests.map((item) => item.method), ["GET", "POST"]);
  assert.deepEqual(after.pendingDurations, []);
  assert.equal(current.stale.state.csrfToken, "manual-token");
});

test("CORE-PWA02 current 503 recovery refreshes auth and replays original claim bytes", async (t) => {
  const current = await prepared(t);
  observeFetch(current, async (url, request) => url === "/api/v1/me"
    ? response(200, { user: accountUser("account-A"), csrfToken: "backoff-token" })
    : current.requests.length === 1 ? response(503) : response(200, canonicalSuccess(current, request)));
  await current.stale.use.persistDurationOperation("focus", 1200000);
  await current.stale.use.syncNow(false);
  const saved = (await dump(current.stale.use.database())).meta.find((item) => item.key === "outgoingSync").value;
  Object.assign(current.stale.state, { authenticated: false, csrfToken: null, sessionIdentityValidated: false });
  await [...current.timers.values()].at(-1).callback();
  const after = await dump(current.stale.use.database());
  evidence.push({ case: t.name, saved, requests: structuredClone(current.requests), after });
  assert.deepEqual(current.requests.map((item) => item.method), ["POST", "GET", "POST"]);
  assert.equal(current.requests[0].body, saved.body);
  assert.equal(current.requests[2].body, saved.body);
  assert.deepEqual(after.pendingDurations, []);
});

test("CORE-PWA02 fresh startup binds empty connection before authenticated identity publication", async (t) => {
  const current = await prepared(t);
  await current.stale.use.clearLocalData(undefined, current.stale.use.captureDatabaseContext());
  current.stale.use.setDatabaseForTest(await current.stale.use.openDatabase());
  current.stale.use.resetOwnerState();
  Object.assign(current.stale.state, { user: null, localOwnerId: null, authenticated: false, csrfToken: null,
    sessionIdentityValidated: false, bootstrapGateOwned: false, bootstrapGatePersisted: false });
  observeFetch(current, async (url, request) => {
    if (url === "/api/v1/me") return response(200, { user: accountUser("account-A"), csrfToken: "startup-token" });
    if (url === "/api/v1/bootstrap") return response(200, { ...snapshot("account-A"),
      accountIncarnation: accountUser("account-A").accountIncarnation, serverHlcWallMs: nowMs, serverHlcCounter: 0,
      acknowledgements: [], taskAcknowledgements: [], durationAcknowledgements: [], autoStartAcknowledgements: [], selectedTaskAcknowledgements: [] });
    return response(200, canonicalSuccess(current, request));
  });
  await current.stale.use.initializeSession();
  const after = await dump(current.stale.use.database());
  evidence.push({ case: t.name, requests: structuredClone(current.requests), after, events: structuredClone(current.events) });
  assert.deepEqual(current.requests.map((item) => item.url), ["/api/v1/me", "/api/v1/bootstrap", "/api/v1/bootstrap/resolve"]);
  assert.equal(current.stale.state.bootstrapPending, null);
  assert.equal(current.stale.state.bootstrapBlocked, false);
  assert.equal(current.stale.state.csrfToken, "startup-token");
  assert.equal(after.meta.find((item) => item.key === "snapshot").value.user.id, "account-A");
});

for (const boundary of ["captureResolution", "allocateClockRequestSequence"]) {
  test(`CORE-PWA02 fresh bootstrap choice retains connection across committed ${boundary}`, async (t) => {
    const entered = deferred();
    const release = deferred();
    let armed = false;
    const current = await prepared(t, { [boundary]: async (...args) => {
      const value = await storage[boundary](...args);
      if (armed) { armed = false; entered.resolve(); await release.promise; }
      return value;
    } });
    current.stale.state.bootstrapPreview = snapshot("account-A");
    current.stale.state.bootstrapPlan = { mode: "choose", strategy: "merge" };
    await current.stale.use.persistDurationOperation("focus", 1200000);
    observeFetch(current, async (_url, request) => response(200, canonicalSuccess(current, request)));
    armed = true;
    const choosing = current.stale.use.chooseBootstrapStrategy("merge", true);
    await entered.promise;
    const before = await reopen(current);
    current.events.length = 0;
    release.resolve();
    await choosing;
    await assertDiscarded(current, before, t.name);
  });
}

test("CORE-PWA02 bootstrap preview cannot fetch after issuing clock allocation returns from closed connection", async (t) => {
  const entered = deferred();
  const release = deferred();
  const current = await prepared(t, { allocateClockRequestSequence: async (...args) => {
    const value = await storage.allocateClockRequestSequence(...args);
    entered.resolve(); await release.promise;
    return value;
  } });
  observeFetch(current, async () => response(503));
  const loading = current.stale.use.loadBootstrapPreview();
  await entered.promise;
  const before = await reopen(current);
  current.events.length = 0;
  release.resolve();
  let failure;
  try { await loading; } catch (error) { failure = error; }
  await assertDiscarded(current, before, t.name);
  assert.equal(failure?.name, "AccountOwnershipError");
});

test("CORE-PWA02 bootstrap preview cannot publish clock sample after committed offset write on disposed connection", async (t) => {
  const entered = deferred();
  const release = deferred();
  const current = await prepared(t, { saveClockOffset: async (...args) => {
    const value = await storage.saveClockOffset(...args);
    entered.resolve(); await release.promise;
    return value;
  } });
  observeFetch(current, async () => response(200, canonicalSuccess(current, { body: JSON.stringify({}) })));
  const loading = current.stale.use.loadBootstrapPreview();
  await entered.promise;
  const before = await reopen(current);
  current.events.length = 0;
  release.resolve();
  let failure;
  try { await loading; } catch (error) { failure = error; }
  await assertDiscarded(current, before, t.name);
  assert.equal(failure?.name, "AccountOwnershipError");
});

test("CORE-PWA02 late session recovery network failure cannot render or arm retry under reopened connection", async (t) => {
  const current = await prepared(t);
  const entered = deferred();
  const release = deferred();
  observeFetch(current, async () => { entered.resolve(); await release.promise; throw new Error("old session network failure"); });
  Object.assign(current.stale.state, { authenticated: false, csrfToken: null, sessionIdentityValidated: false });
  const recovering = current.stale.use.restoreSessionAndSync(current.stale.use.captureAccountContext());
  await entered.promise;
  const before = await reopen(current);
  const timersBefore = current.timers.size;
  current.events.length = 0;
  release.resolve();
  await recovering;
  await assertDiscarded(current, before, t.name);
  assert.equal(current.timers.size, timersBefore);
});

test("CORE-PWA02 existing-workspace transport and recovery reject missing or forged scope before effects", async (t) => {
  const current = await prepared(t);
  const before = await dump(current.stale.use.database());
  observeFetch(current, async () => response(503));
  const calls = [
    (scope) => current.stale.use.postMutation("/api/v1/sync", "{}", sync.accountOwnerId(current.stale.state.user), scope),
    (scope) => current.stale.use.refreshMutationCsrf(sync.accountOwnerId(current.stale.state.user), scope),
    (scope) => current.stale.use.fetchSessionPayload(scope),
    (scope) => current.stale.use.restoreSessionAndSync(scope),
    (scope) => current.stale.use.sendBootstrapResolution({}, scope),
    (scope) => current.stale.use.acceptBootstrapResponse({}, {}, null, scope),
    (scope) => current.stale.use.acceptSyncResponse({}, {}, null, null, scope)
  ];
  const failures = [];
  for (const call of calls) for (const scope of [undefined, { ownerId: "forged", assertCurrent() {} }]) {
    let failure;
    try { await call(scope); } catch (error) { failure = { name: error.name, message: error.message }; }
    failures.push(failure || null);
  }
  const after = await dump(current.stale.use.database());
  evidence.push({ case: t.name, failures, before, after, requests: structuredClone(current.requests), events: structuredClone(current.events) });
  for (const failure of failures) assert.deepEqual(failure,
    { name: "TypeError", message: "A bound account operation context is required." });
  assert.deepEqual(after, before);
  assert.deepEqual(current.requests, []);
  assert.deepEqual(current.events, []);
});

test("CORE-PWA02 revision hints cannot renew disposed issuer and explicit current stream still opens", async (t) => {
  const current = await prepared(t);
  const sources = [];
  const revisions = [];
  current.stale.external.host.EventSource = class {
    constructor() { sources.push(this); }
    addEventListener() {}
    close() { this.closed = true; }
  };
  Object.assign(current.stale.use, productionModule("app-session.js").create({ state: current.stale.state,
    external: current.external, use: current.stale.use, emit: (_name, payload) => {
      revisions.push(payload);
      current.events.push(["revision", payload]);
    } }));
  current.stale.use.openRevisionStream();
  const before = await reopen(current);
  current.events.length = 0;
  sources[0].onmessage({ data: "99" });
  sources[0].onerror(new Error("discarded stream"));
  await assertDiscarded(current, before, t.name);
  assert.deepEqual(revisions, []);
  current.stale.use.openRevisionStream();
  assert.equal(sources.length, 2);
  assert.equal(sources[0].closed, true);
  sources[1].onmessage({ data: "100" });
  assert.deepEqual(revisions, [{ revision: 100 }]);
  evidence.at(-1).currentStream = { count: sources.length, priorClosed: sources[0].closed, revisions: structuredClone(revisions) };
});

test("CORE-PWA02 authorized logout cleanup cannot bind revocation to a reopened workspace", async (t) => {
  const current = await prepared(t);
  current.stale.use.markPendingLogout();
  const entered = deferred();
  const release = deferred();
  const clear = current.stale.use.clearLocalData;
  let armed = true;
  current.stale.use.clearLocalData = async (...args) => {
    const result = await clear(...args);
    if (armed) { armed = false; entered.resolve(); await release.promise; }
    return result;
  };
  observeFetch(current, async (url) => url === "/api/v1/me"
    ? response(200, { user: accountUser("account-A"), csrfToken: "old-logout-token" }) : response(204));
  const loading = current.stale.use.loadSession();
  await entered.promise;
  const before = await reopen(current);
  current.events.length = 0;
  release.resolve();
  let failure;
  try { await loading; } catch (error) { failure = error; }
  await assertDiscarded(current, before, t.name);
  assert.equal(failure?.name, "AccountOwnershipError");
  assert.equal(current.stale.use.pendingLocalLogout(), true);
});
