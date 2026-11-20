"use strict";

// R55-S09 / R55-W23: the PWA installs the canonical HLC head by the receiver
// rule. The head is the response's canonical pair when the server sends it,
// otherwise its server pair. Clock merging stays on the server pair.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const appSync = require("./app-sync.js");
const { accountUser, ownerId } = require("./test/incarnation-fixture.js");
const { fixture, storage, deferred, snapshot, seedMeta, dump, nowMs } = require("./test/account-ownership-fixture.js");

const EMPTY_PROJECTION = { commands: [], taskOperations: [], durationOperations: [],
  autoStartOperations: [], selectedTaskOperations: [] };
const SERVER = { serverHlcWallMs: nowMs, serverHlcCounter: 50 };

function meta(records, key) {
  return records.meta.find((item) => item.key === key)?.value;
}

async function displayedTimer(current) {
  await current.use.reloadPersistedState();
  return current.state.timer ? `${current.state.timer.status} ${current.state.timer.phase}` : "none";
}

// Starts a sync whose POST stays pending until the test answers it.
async function inFlightSync(current) {
  await seedMeta(current.use.database(), { canonicalHead: { wallMs: nowMs, counter: 2 }, projectionPending: EMPTY_PROJECTION });
  await current.use.reloadPersistedState();
  await current.use.persistDurationOperation("focus", 1_800_000);
  const request = deferred();
  const posted = deferred();
  const posts = [];
  current.external.host.setTimeout = () => 1;
  current.use.postMutation = async (url, body) => {
    posts.push(JSON.parse(body));
    posted.resolve();
    return request.promise;
  };
  const actions = appSync.create({ state: current.state, external: current.external, use: current.use, listen() {} });
  const syncing = actions.syncNow();
  await posted.promise;
  return { syncing, request, sent: () => posts[0] };
}

function syncPayload(current, sent, pair) {
  return { ...snapshot(current.state.user.id), revision: 4, accountIncarnation: current.state.user.accountIncarnation,
    ...SERVER, ...pair, acknowledgements: [], taskAcknowledgements: [], autoStartAcknowledgements: [],
    selectedTaskAcknowledgements: [],
    durationAcknowledgements: sent.durationOperations.map(({ id }) => ({ operationId: id, outcome: "applied", reason: "" })) };
}

async function answer(current, flight, pair) {
  const payload = syncPayload(current, flight.sent(), pair);
  flight.request.resolve({ response: { ok: true, status: 200, json: async () => payload } });
  await flight.syncing;
  return dump(current.use.database());
}

// Queues a never-sent Start while the sync is in flight. With `fresh`, the
// Start is not yet in the stored display membership, so Core admits it only
// when it is newer than the canonical head (display.rs fresh_records).
async function startDuringSync(current, { fresh }) {
  assert.equal(await current.use.issueCommand("start"), true);
  if (fresh) await seedMeta(current.use.database(), { projectionPending: EMPTY_PROJECTION });
  const start = (await dump(current.use.database())).pending.find((command) => command.type === "start");
  assert.deepEqual([start.hlcWallMs, start.hlcCounter], [nowMs, 4], "the Start sits between the heads under test");
  return start;
}

test("R55-S09 user case: a Start queued during a sync stays projected when the canonical pair is older", async (t) => {
  const { stale } = await fixture(t);
  const flight = await inFlightSync(stale);
  await startDuringSync(stale, { fresh: true });
  const after = await answer(stale, flight, { canonicalHlcWallMs: nowMs, canonicalHlcCounter: 3 });
  assert.equal(stale.state.timer.status, "running");
  assert.equal(await displayedTimer(stale), "running focus");
  assert.deepEqual(meta(after, "canonicalHead"), { wallMs: nowMs, counter: 3 });
  assert.deepEqual(meta(after, "hlc"), { wallMs: nowMs, counter: 50 }, "the clock still merges the server pair");
});

test("R55-S09 user case with display membership pinned at queue time stays projected", async (t) => {
  const { stale } = await fixture(t);
  const flight = await inFlightSync(stale);
  await startDuringSync(stale, { fresh: false });
  const after = await answer(stale, flight, { canonicalHlcWallMs: nowMs, canonicalHlcCounter: 3 });
  assert.deepEqual(meta(after, "canonicalHead"), { wallMs: nowMs, counter: 3 });
  assert.equal(await displayedTimer(stale), "running focus");
});

test("R55-S09 other device case: a canonical pair newer than the Start keeps it hidden", async (t) => {
  const { stale } = await fixture(t);
  const flight = await inFlightSync(stale);
  await startDuringSync(stale, { fresh: true });
  const after = await answer(stale, flight, { canonicalHlcWallMs: nowMs, canonicalHlcCounter: 10 });
  assert.deepEqual(meta(after, "canonicalHead"), { wallMs: nowMs, counter: 10 });
  assert.equal(await displayedTimer(stale), "idle focus");
});

test("R55-S09 fallback: a response without the pair installs the server pair as before", async (t) => {
  const { stale } = await fixture(t);
  const flight = await inFlightSync(stale);
  await startDuringSync(stale, { fresh: true });
  const after = await answer(stale, flight, {});
  assert.deepEqual(meta(after, "canonicalHead"), { wallMs: nowMs, counter: 50 });
  assert.equal(await displayedTimer(stale), "idle focus");
});

const rejectedPairs = [
  ["only the wall field", { canonicalHlcWallMs: nowMs }],
  ["only the counter field", { canonicalHlcCounter: 3 }],
  ["a canonical pair above the server pair", { canonicalHlcWallMs: nowMs, canonicalHlcCounter: 51 }],
  ["a negative counter", { canonicalHlcWallMs: nowMs, canonicalHlcCounter: -1 }],
  ["a non-integer wall field", { canonicalHlcWallMs: nowMs - 0.5, canonicalHlcCounter: 3 }]
];

for (const [name, pair] of rejectedPairs) {
  test(`R55-S09 a sync response with ${name} is rejected and installs nothing`, async (t) => {
    const { stale } = await fixture(t);
    const flight = await inFlightSync(stale);
    const queued = (await dump(stale.use.database())).pendingDurations;
    const after = await answer(stale, flight, pair);
    assert.deepEqual(meta(after, "canonicalHead"), { wallMs: nowMs, counter: 2 });
    assert.deepEqual(after.pendingDurations, queued, "the operation stays queued for a retry");
    assert.equal(stale.state.retrying, true);
  });
}

async function keepRemoteResponse(current, pair) {
  const database = current.use.database();
  const gateToken = current.use.tabId();
  await storage.acquireBootstrapGate(database, { token: gateToken, nowMs, leaseMs: 300_000 });
  const pending = await storage.captureResolution(database, { userId: ownerId("account-A"), requestId: crypto.randomUUID(),
    deviceId: "shared-device", expectedRevision: 3, strategy: "keep_remote" }, { gateToken, replaceExisting: false });
  const payload = { ...snapshot("account-A"), accountIncarnation: accountUser("account-A").accountIncarnation,
    acknowledgements: [], taskAcknowledgements: [], durationAcknowledgements: [], autoStartAcknowledgements: [],
    selectedTaskAcknowledgements: [], ...SERVER, ...pair };
  delete payload.user;
  await current.use.acceptBootstrapResponse(payload, pending, null, current.use.captureAccountContext());
  return dump(database);
}

test("R55-S09 a bootstrap result installs its canonical pair and merges the server pair into the clock", async (t) => {
  const { stale } = await fixture(t);
  const after = await keepRemoteResponse(stale, { canonicalHlcWallMs: nowMs, canonicalHlcCounter: 3 });
  assert.deepEqual(meta(after, "canonicalHead"), { wallMs: nowMs, counter: 3 });
  assert.deepEqual(stale.state.canonicalHead, { wallMs: nowMs, counter: 3 });
  assert.deepEqual(meta(after, "hlc"), { wallMs: nowMs, counter: 50 });
});

test("R55-S09 a bootstrap result without the pair installs the server pair as before", async (t) => {
  const { stale } = await fixture(t);
  const after = await keepRemoteResponse(stale, {});
  assert.deepEqual(meta(after, "canonicalHead"), { wallMs: nowMs, counter: 50 });
});

const sync = require("./sync-core.js");
const NOTHING_SENT = { commands: [], taskOperations: [], durationOperations: [], autoStartOperations: [], selectedTaskOperations: [] };

function validatedHead(pair) {
  const payload = { ...syncPayload({ state: { user: accountUser("account-A") } }, NOTHING_SENT, pair) };
  sync.validateCanonicalResponse(payload, NOTHING_SENT);
  return sync.responseCanonicalHead(payload);
}

const acceptedPairs = [
  ["no pair falls back to the server pair", {}, { wallMs: nowMs, counter: 50 }],
  ["a pair equal to the server pair", { canonicalHlcWallMs: nowMs, canonicalHlcCounter: 50 }, { wallMs: nowMs, counter: 50 }],
  ["an earlier wall with a larger counter", { canonicalHlcWallMs: nowMs - 1, canonicalHlcCounter: 90 }, { wallMs: nowMs - 1, counter: 90 }],
  ["the empty head", { canonicalHlcWallMs: 0, canonicalHlcCounter: 0 }, { wallMs: 0, counter: 0 }]
];

for (const [name, pair, head] of acceptedPairs) {
  test(`R55-S09 receiver rule accepts ${name}`, () => {
    assert.deepEqual(validatedHead(pair), head);
  });
}

const invalidPairs = [
  ...rejectedPairs,
  ["a later wall with a smaller counter", { canonicalHlcWallMs: nowMs + 1, canonicalHlcCounter: 0 }],
  ["a negative wall field", { canonicalHlcWallMs: -1, canonicalHlcCounter: 0 }],
  ["an unsafe counter", { canonicalHlcWallMs: 0, canonicalHlcCounter: Number.MAX_SAFE_INTEGER + 1 }],
  ["a string counter", { canonicalHlcWallMs: nowMs, canonicalHlcCounter: "3" }],
  ["a null wall field", { canonicalHlcWallMs: null, canonicalHlcCounter: 3 }]
];

for (const [name, pair] of invalidPairs) {
  test(`R55-S09 receiver rule fails closed on ${name}`, () => {
    assert.throws(() => validatedHead(pair), /invalid canonical HLC head/);
  });
}
