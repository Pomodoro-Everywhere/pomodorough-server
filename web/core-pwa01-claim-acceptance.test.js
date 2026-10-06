"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");
const { fixture, seedMeta, dump, deferred, snapshot } = require("./test/account-ownership-fixture.js");
const sync = require("./sync-core.js");
const workspace = require("./workspace-core.js");
const receipts = [];
let server;

function productionModule(name) {
  if (!process.env.CORE_PWA01_BASELINE) return require(`./${name}`);
  const filename = path.join(__dirname, name);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(__dirname);
  loaded._compile(fs.readFileSync(path.join(process.env.CORE_PWA01_BASELINE, name), "utf8"), filename);
  return loaded.exports;
}

const storage = productionModule("sync-storage.js");
const syncModule = productionModule("app-sync.js");

test.before(() => {
  const bytes = fs.readFileSync(path.join(__dirname, "pomodorough_core.wasm"));
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), require("./shared-core-metadata.js").sha256);
  assert.deepEqual(bytes, fs.readFileSync(path.join(__dirname, "../internal/sharedcore/pomodorough_core.wasm")));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "core-pwa01-server-"));
  const output = path.join(directory, "response.json");
  try {
    execFileSync("go", ["test", "./internal/server", "-run", "^TestCorePWA01ServerResponseFixture$", "-count=1"],
      { cwd: path.join(__dirname, ".."), env: { ...process.env, CORE_PWA01_SERVER_FIXTURE: output }, timeout: 120000 });
    server = JSON.parse(fs.readFileSync(output, "utf8"));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  assert.equal(server.response.revision, 1);
  assert.equal(server.duplicate.revision, 1);
  assert.equal(server.response.canonicalTimer.status, "running");
  assert.deepEqual(JSON.parse(server.responseRaw), server.response);
  assert.deepEqual(JSON.parse(server.duplicateRaw), server.duplicate);
}, { timeout: 120000 });

test.after(() => {
  if (process.env.CORE_PWA01_EVIDENCE) fs.writeFileSync(process.env.CORE_PWA01_EVIDENCE,
    JSON.stringify({ provenance: require("./shared-core-metadata.js"), server, cases: receipts }, null, 2));
});

async function prepared(t) {
  const current = await fixture(t);
  t.mock.timers.setTime(server.nowMs);
  storage.setSharedCore(current.core);
  const { stale, peer } = current;
  const database = stale.use.database();
  const external = { ...stale.external, syncStorage: storage };
  for (const name of ["app-storage.js", "app-sync.js", "app-session.js"]) {
    const module = name === "app-sync.js" ? syncModule : require(`./${name}`);
    Object.assign(stale.use, module.create({ state: stale.state, external, use: stale.use, emit() {}, listen() {} }));
  }
  stale.use.setDatabaseForTest(database);
  Object.assign(stale.state, { user: server.user, localOwnerId: sync.accountOwnerId(server.user), deviceId: server.request.deviceId });
  Object.assign(peer.state, { user: server.user, localOwnerId: sync.accountOwnerId(server.user), deviceId: server.request.deviceId });
  stale.use.trustedNow = () => Date.now();
  peer.use.trustedNow = () => Date.now();
  const memory = new Map();
  stale.external.host.localStorage = { getItem: (key) => memory.get(key) ?? null };
  stale.external.host.location = { assign() { assert.fail("Unexpected redirect"); } };
  stale.use.renderProfile = () => {};
  stale.use.openRevisionStream = () => {};
  await seedMeta(database, { snapshot: { ...snapshot("account-A"), user: server.user, revision: 0, autoStartBreaks: false },
    deviceId: server.request.deviceId, deviceSequence: 1, uuidV7: null,
    hlc: { wallMs: server.nowMs, counter: 0 }, canonicalHead: { wallMs: server.nowMs, counter: 0 } });
  const command = { ...server.request.commands[0], deviceId: server.request.deviceId };
  const transaction = database.transaction(["pending", "meta"], "readwrite");
  transaction.objectStore("pending").put(command);
  transaction.objectStore("meta").put({ key: "deliveryProof", value: { ...sync.emptyNeverSent(), commands: [command.id] } });
  await storage.transactionDone(transaction);
  await stale.use.reloadPersistedState();
  await peer.use.reloadPersistedState();
  const requests = [];
  stale.external.host.fetch = async (url, input) => {
    requests.push({ url, method: input.method, body: input.body, headers: { ...input.headers } });
    return { ok: false, status: 503, json: async () => ({}) };
  };
  return { ...current, external, requests };
}

async function claim(current) {
  const input = { ...current.stale.use.captureAccountContext(), deviceId: server.request.deviceId, localNowMs: Date.now() };
  return (await storage.claimWorkspaceBatch(current.stale.use.database(), input)).claim;
}

async function accept(current, captured, payload = server.response, client = current.stale) {
  return client.use.acceptSyncResponse(payload, captured.sent, sync.accountOwnerId(server.user), null,
    client.use.captureAccountContext(), captured);
}

async function acknowledgedA(current) {
  const captured = await claim(current);
  assert.deepEqual(JSON.parse(captured.body).commands, server.request.commands);
  await accept(current, captured);
  const after = await dump(current.stale.use.database());
  assert.deepEqual(after.pending, []);
  assert.equal(meta(after, "outgoingSync"), undefined);
  assert.equal(meta(after, "snapshot").revision, 1);
  return captured;
}

function meta(records, key) { return records.meta.find((item) => item.key === key)?.value; }

for (const mode of ["same connection", "reopen", "cross-tab"]) {
  test(`CORE-PWA01 delayed real Start duplicate preserves newer B claim: ${mode}`, async (t) => {
    const current = await prepared(t);
    const capturedA = await acknowledgedA(current);
    await current.stale.use.persistDurationOperation("focus", 1800000);
    const capturedB = await claim(current);
    assert.deepEqual(meta(await dump(current.stale.use.database()), "deliveryProof").durationOperations, []);
    let client = current.stale;
    if (mode === "reopen") {
      current.stale.use.database().close();
      current.stale.use.setDatabaseForTest(await current.stale.use.openDatabase());
      await current.stale.use.reloadPersistedState();
    } else if (mode === "cross-tab") {
      client = current.peer;
      Object.assign(client.use, syncModule.create({ state: client.state, external: { ...client.external, syncStorage: storage }, use: client.use, listen() {} }));
      await client.use.reloadPersistedState();
    }
    const before = await dump(current.stale.use.database());
    await accept(current, capturedA, server.duplicate, client);
    const after = await dump(current.stale.use.database());
    await current.stale.use.persistDurationOperation("focus", 2100000);
    const afterC = await dump(current.stale.use.database());
    const replay = await claim(current);
    await current.stale.use.reloadPersistedState();
    await current.stale.use.syncNow(false);
    receipts.push({ case: t.name, capturedA, capturedB, before, after, afterC, replay, requests: structuredClone(current.requests) });
    assert.deepEqual(after, before);
    assert.equal(meta(afterC, "outgoingSync").body, capturedB.body);
    assert.equal(replay.body, capturedB.body);
    assert.equal(current.requests.length, 1);
    assert.equal(current.requests[0].body, capturedB.body);
    assert.equal(JSON.parse(current.requests[0].body).durationOperations.length, 1);
    assert.equal(afterC.pendingDurations.length, 2);
  });
}

test("CORE-PWA01 absent current claim makes repeated A response a store-preserving no-op", async (t) => {
  const current = await prepared(t);
  const captured = await acknowledgedA(current);
  await current.stale.use.persistDurationOperation("focus", 1800000);
  const before = await dump(current.stale.use.database());
  await accept(current, captured, server.duplicate);
  const after = await dump(current.stale.use.database());
  receipts.push({ case: t.name, captured, before, after });
  assert.deepEqual(after, before);
});

test("CORE-PWA01 captured claim identity/body/revision cannot be forged to acknowledge current work", async (t) => {
  const current = await prepared(t);
  const captured = await claim(current);
  const mutations = [
    (value) => { value.retiredAt = new Date(server.nowMs + 1).toISOString(); },
    (value) => { const body = JSON.parse(value.body); body.lastRevision += 1; value.body = JSON.stringify(body); },
    (value) => { const body = JSON.parse(value.body); body.commands[0].plannedDurationMs += 60000; value.body = JSON.stringify(body); },
    (value) => { value.ownerId = "another-owner"; },
    (value) => { value.claimId = "forged-claim"; }
  ];
  const before = await dump(current.stale.use.database());
  const observations = [];
  for (const mutate of mutations) {
    const forged = structuredClone(captured);
    mutate(forged);
    let failure;
    try { await accept(current, forged); } catch (error) { failure = { name: error.name, message: error.message }; }
    observations.push({ forged, failure, after: await dump(current.stale.use.database()) });
  }
  receipts.push({ case: t.name, captured, before, observations });
  for (const observed of observations) assert.deepEqual(observed.after, before);
});

test("CORE-PWA01 ordinary exact saved retry accepts real Start ACK and clears only that claim", async (t) => {
  const current = await prepared(t);
  const captured = await claim(current);
  await current.stale.use.syncNow(false);
  const retained = await dump(current.stale.use.database());
  current.stale.external.host.fetch = async (url, input) => {
    current.requests.push({ url, method: input.method, body: input.body });
    return { ok: true, status: 200, json: async () => server.response };
  };
  await current.stale.use.syncNow(false);
  const after = await dump(current.stale.use.database());
  receipts.push({ case: t.name, captured, retained, after, requests: structuredClone(current.requests) });
  assert.equal(meta(retained, "outgoingSync").body, captured.body);
  assert.deepEqual(current.requests.map((item) => item.body), [captured.body, captured.body]);
  assert.deepEqual(after.pending, []);
  assert.equal(meta(after, "outgoingSync"), undefined);
  assert.equal(meta(after, "snapshot").revision, 1);
});

test("CORE-PWA01 distinct claims with identical body and timestamp do not share acknowledgement ownership", async (t) => {
  const current = await prepared(t);
  await acknowledgedA(current);
  const capturedA = await claim(current);
  const payload = { ...server.response, acknowledgements: [] };
  await accept(current, capturedA, payload);
  const capturedB = await claim(current);
  const before = await dump(current.stale.use.database());
  await accept(current, capturedA, payload);
  const after = await dump(current.stale.use.database());
  receipts.push({ case: t.name, capturedA, capturedB, before, after });
  assert.equal(capturedA.body, capturedB.body);
  assert.equal(capturedA.retiredAt, capturedB.retiredAt);
  assert.deepEqual(after, before);
  assert.notEqual(capturedA.claimId, capturedB.claimId);
});

test("CORE-PWA01 exact prior-format saved body remains retryable without claimId reconstruction", async (t) => {
  const current = await prepared(t);
  const captured = await claim(current);
  delete captured.claimId;
  await seedMeta(current.stale.use.database(), { outgoingSync: captured });
  const before = await dump(current.stale.use.database());
  current.stale.external.host.fetch = async (url, input) => {
    current.requests.push({ url, method: input.method, body: input.body });
    return { ok: true, status: 200, json: async () => server.response };
  };
  await current.stale.use.syncNow(false);
  const after = await dump(current.stale.use.database());
  receipts.push({ case: t.name, captured, before, after, requests: structuredClone(current.requests) });
  assert.equal(current.requests.length, 1);
  assert.equal(current.requests[0].body, captured.body);
  assert.deepEqual(after.pending, []);
  assert.equal(meta(after, "outgoingSync"), undefined);
});

function durationResponse(current, records, captured) {
  const projected = current.core.projectSynchronizedState({ base: workspace.base(meta(records, "snapshot")),
    pending: Object.fromEntries(workspace.DOMAINS.map((domain) => [domain,
      captured.sent[domain].map((item) => ({ ...item, deviceId: server.request.deviceId }))])),
    now: new Date(server.nowMs).toISOString() });
  return { ...server.response, ...projected, revision: 2, serverTime: new Date(server.nowMs).toISOString(),
    serverHlcWallMs: server.nowMs, serverHlcCounter: 100, acknowledgements: [],
    durationAcknowledgements: captured.sent.durationOperations.map((item) => ({ operationId: item.id, outcome: "applied", reason: "" })) };
}

function persistenceInput(captured, payload = server.response) {
  return { expectedUserId: sync.accountOwnerId(server.user), capturedClaim: captured,
    snapshot: { ...workspace.base(payload), revision: payload.revision, serverTime: payload.serverTime, user: server.user },
    hlc: { wallMs: payload.serverHlcWallMs, counter: payload.serverHlcCounter },
    serverHlc: { wallMs: payload.serverHlcWallMs, counter: payload.serverHlcCounter },
    queueIds: Object.fromEntries(workspace.DOMAINS.map((domain) => [domain, captured.sent[domain].map((item) => item.id)])),
    reconciliation: { sent: captured.sent, response: payload, deviceId: server.request.deviceId } };
}

test("CORE-PWA01 delayed real A response cannot install rev1 over acknowledged B rev2 or retire C proof", async (t) => {
  const current = await prepared(t);
  const capturedA = await acknowledgedA(current);
  await current.stale.use.persistDurationOperation("focus", 1800000);
  const capturedB = await claim(current);
  const payloadB = durationResponse(current, await dump(current.stale.use.database()), capturedB);
  await accept(current, capturedB, payloadB);
  await current.stale.use.persistDurationOperation("focus", 2100000);
  const before = await dump(current.stale.use.database());
  await accept(current, capturedA, server.duplicate);
  const after = await dump(current.stale.use.database());
  receipts.push({ case: t.name, capturedA, capturedB, payloadB, before, after });
  assert.equal(meta(before, "snapshot").revision, 2);
  assert.equal(meta(before, "deliveryProof").durationOperations.length, 1);
  assert.deepEqual(after, before);
});

test("CORE-PWA01 equal revision current B ACK removes only B and preserves C never-sent proof", async (t) => {
  const current = await prepared(t);
  await acknowledgedA(current);
  await current.stale.use.persistDurationOperation("focus", 1800000);
  const capturedB = await claim(current);
  const payloadB = durationResponse(current, await dump(current.stale.use.database()), capturedB);
  await seedMeta(current.stale.use.database(), { snapshot: persistenceInput(capturedB, payloadB).snapshot });
  await current.stale.use.persistDurationOperation("focus", 2100000);
  const before = await dump(current.stale.use.database());
  const freshId = before.pendingDurations.find((item) => item.id !== capturedB.sent.durationOperations[0].id).id;
  await accept(current, capturedB, payloadB);
  const after = await dump(current.stale.use.database());
  receipts.push({ case: t.name, capturedB, payloadB, freshId, before, after });
  assert.deepEqual(after.pendingDurations.map((item) => item.id), [freshId]);
  assert.deepEqual(meta(after, "deliveryProof").durationOperations, [freshId]);
  assert.equal(meta(after, "outgoingSync"), undefined);
});

test("CORE-PWA01 transaction rechecks A claim after another tab installs A then captures B", async (t) => {
  const current = await prepared(t);
  const capturedA = await claim(current);
  const entered = deferred();
  const release = deferred();
  const external = { ...current.external, syncStorage: { ...storage, applySyncResponse: async (...args) => {
    entered.resolve(); await release.promise;
    return storage.applySyncResponse(...args);
  } } };
  Object.assign(current.stale.use, syncModule.create({ state: current.stale.state, external, use: current.stale.use, listen() {} }));
  const accepting = accept(current, capturedA);
  await entered.promise;
  await storage.applySyncResponse(current.peer.use.database(), persistenceInput(capturedA));
  await current.peer.use.reloadPersistedState();
  await current.peer.use.persistDurationOperation("focus", 1800000);
  const capturedB = (await storage.claimWorkspaceBatch(current.peer.use.database(), {
    ...current.peer.use.captureAccountContext(), deviceId: server.request.deviceId, localNowMs: Date.now()
  })).claim;
  const before = await dump(current.peer.use.database());
  release.resolve();
  await accepting;
  const after = await dump(current.peer.use.database());
  receipts.push({ case: t.name, capturedA, capturedB, before, after });
  assert.deepEqual(after, before);
});

test("CORE-PWA01 missing captured claim cannot consume current saved request through acceptance or transaction", async (t) => {
  const current = await prepared(t);
  const captured = await claim(current);
  const before = await dump(current.stale.use.database());
  let failure;
  try {
    await current.stale.use.acceptSyncResponse(server.response, captured.sent, sync.accountOwnerId(server.user), null,
      current.stale.use.captureAccountContext());
  } catch (error) { failure = { name: error.name, message: error.message }; }
  const input = persistenceInput(captured);
  delete input.capturedClaim;
  const outcome = await storage.applySyncResponse(current.stale.use.database(), input);
  const after = await dump(current.stale.use.database());
  receipts.push({ case: t.name, captured, before, after, failure, outcome });
  assert.deepEqual(after, before);
  assert.equal(failure?.name, "TypeError");
  assert.equal(outcome.applied, false);
});

test("CORE-PWA01 acceptance retains copied claim while caller mutates original object across await", async (t) => {
  const current = await prepared(t);
  const captured = await claim(current);
  const original = structuredClone(captured);
  const entered = deferred();
  let resume;
  current.stale.external.host.setTimeout = (callback) => { resume = callback; entered.resolve(); return 1; };
  current.stale.state.actionLocked = true;
  const accepting = accept(current, captured);
  await entered.promise;
  captured.body = "{}";
  captured.retiredAt = new Date(server.nowMs + 1000).toISOString();
  current.stale.state.actionLocked = false;
  resume();
  await accepting;
  const after = await dump(current.stale.use.database());
  receipts.push({ case: t.name, original, mutated: captured, after });
  assert.deepEqual(after.pending, []);
  assert.equal(meta(after, "outgoingSync"), undefined);
  assert.equal(meta(after, "snapshot").revision, 1);
});
