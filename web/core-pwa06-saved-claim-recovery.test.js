"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture, seedMeta, dump, meta, nowMs, user, storage, sync } = require("./test/p222-completion-fixture.js");
const workspace = require("./workspace-core.js");

async function prepared(t) {
  const value = await fixture(t);
  value.client.external.sharedCoreHost.SharedCore = { load: async () => value.core };
  await seedMeta(value.client.use.database(), { canonicalHead: { wallMs: nowMs, counter: 2 } });
  await value.client.use.reloadPersistedState();
  return value;
}

function mutationInput(client) {
  return { ...client.use.captureAccountContext(), deviceId: client.state.deviceId,
    tabId: client.use.tabId(), nowMs, localNowMs: nowMs, leaseMs: 60000,
    timerUuid: "12345678-1234-4234-8234-123456789012" };
}

function emptySent() {
  return Object.fromEntries(workspace.DOMAINS.map((domain) => [domain, []]));
}

test("CORE-PWA06 baseline: saved claim without body stays blocked across reopen", async (t) => {
  const { client, open } = await prepared(t);
  await client.use.persistDurationOperation("focus", 1800000);
  const queuedBefore = await dump(client.use.database());
  assert.equal(queuedBefore.pendingDurations.length, 1);
  const claim = { sent: emptySent(), retiredAt: "2026-01-01T00:00:00Z" };
  await seedMeta(client.use.database(), { outgoingSync: claim });
  const before = await dump(client.use.database());
  const first = await storage.claimWorkspaceBatch(client.use.database(), mutationInput(client));
  assert.equal(first.plan.status, "replay_saved");
  assert.equal(first.claim.body, undefined);
  assert.deepEqual(await dump(client.use.database()), before);
  const reopened = await open();
  const second = await storage.claimWorkspaceBatch(reopened.use.database(), mutationInput(reopened));
  assert.equal(second.plan.status, "replay_saved");
  assert.equal(second.claim.body, undefined);
  assert.deepEqual(second.claim, claim);
  assert.deepEqual(await dump(reopened.use.database()), before);
  assert.equal((await dump(reopened.use.database())).pendingDurations.length, 1);
});

test("CORE-PWA06 recovery discards only envelope and replans fresh claim with exact queue preservation", async (t) => {
  const { client, open } = await prepared(t);
  await client.use.persistDurationOperation("focus", 1800000);
  const persistedOp = (await dump(client.use.database())).pendingDurations[0];
  const proofBefore = meta(await dump(client.use.database()), "deliveryProof");
  const snapshotBefore = meta(await dump(client.use.database()), "snapshot");
  const claim = { sent: emptySent(), retiredAt: "2026-01-01T00:00:00Z" };
  await seedMeta(client.use.database(), { outgoingSync: claim });
  const before = await dump(client.use.database());
  assert.equal(typeof storage.discardUnrecoverableSavedClaim, "function");
  const result = await storage.discardUnrecoverableSavedClaim(client.use.database(),
    { ...mutationInput(client), confirmed: true });
  assert.equal(typeof result.claim.body, "string");
  assert.notDeepEqual(result.claim, claim);
  const after = await dump(client.use.database());
  assert.deepEqual(after.pendingDurations, before.pendingDurations);
  assert.deepEqual(after.pendingDurations, [persistedOp]);
  assert.deepEqual(after.pending, before.pending);
  assert.deepEqual(after.pendingTasks, before.pendingTasks);
  assert.deepEqual(after.pendingAutoStarts, before.pendingAutoStarts);
  assert.deepEqual(after.pendingSelectedTasks, before.pendingSelectedTasks);
  assert.deepEqual(meta(after, "snapshot"), snapshotBefore);
  const proofAfter = meta(after, "deliveryProof");
  assert.deepEqual(Object.keys(proofAfter).sort(), Object.keys(proofBefore).sort());
  for (const domain of workspace.DOMAINS) {
    const retired = new Set((result.claim.sent[domain] || []).map((item) => item.id));
    const expected = (proofBefore[domain] || []).filter((id) => !retired.has(id));
    assert.deepEqual(proofAfter[domain] || [], expected, `${domain}: proof only retires the replanned claim`);
  }
  const body = JSON.parse(result.claim.body);
  assert.deepEqual(body.durationOperations.map((item) => item.id), [persistedOp.id]);
  const reopened = await open();
  const replay = await storage.claimWorkspaceBatch(reopened.use.database(), mutationInput(reopened));
  assert.equal(replay.plan.status, "replay_saved");
  assert.equal(replay.claim.body, result.claim.body);
  assert.deepEqual(await dump(reopened.use.database()), after);
});

test("CORE-PWA06 discard requires explicit confirmation and leaves storage untouched", async (t) => {
  const { client } = await prepared(t);
  await client.use.persistDurationOperation("focus", 1800000);
  await seedMeta(client.use.database(), { outgoingSync: { sent: emptySent(), retiredAt: "2026-01-01T00:00:00Z" } });
  const before = await dump(client.use.database());
  assert.equal(typeof storage.discardUnrecoverableSavedClaim, "function");
  await assert.rejects(storage.discardUnrecoverableSavedClaim(client.use.database(), mutationInput(client)),
    /confirm/i);
  await assert.rejects(storage.discardUnrecoverableSavedClaim(client.use.database(),
    { ...mutationInput(client), confirmed: false }), /confirm/i);
  assert.deepEqual(await dump(client.use.database()), before);
});

test("CORE-PWA06 discard refuses recoverable claim with original bytes", async (t) => {
  const { client } = await prepared(t);
  await client.use.persistDurationOperation("focus", 1800000);
  const fresh = await storage.claimWorkspaceBatch(client.use.database(), mutationInput(client));
  assert.equal(typeof fresh.claim.body, "string");
  const before = await dump(client.use.database());
  assert.equal(typeof storage.discardUnrecoverableSavedClaim, "function");
  await assert.rejects(storage.discardUnrecoverableSavedClaim(client.use.database(),
    { ...mutationInput(client), confirmed: true }), /body|recoverable/i);
  assert.deepEqual(await dump(client.use.database()), before);
});

test("CORE-PWA06 recovery notice names blocked queue and gates discard behind confirmation", async (t) => {
  assert.equal(typeof storage.savedClaimRecoveryQueues, "function");
  const sent = emptySent();
  sent.durationOperations = [{ id: "queued-duration-1" }];
  const queues = storage.savedClaimRecoveryQueues({ sent });
  assert.ok(queues.includes("durationOperations"));
  assert.equal(typeof storage.savedClaimRecoveryMessage, "function");
  const message = storage.savedClaimRecoveryMessage({ sent }, (key, values, fallback) => fallback);
  assert.match(message, /durationOperations/);
});

test("CORE-PWA06 coordinator surfaces queue-named recovery and discards only after arming", async (t) => {
  const ownership = require("./test/account-ownership-fixture.js");
  const current = await ownership.fixture(t);
  const { stale } = current;
  await stale.use.persistDurationOperation("focus", 1800000);
  const queued = (await ownership.dump(stale.use.database())).pendingDurations;
  assert.equal(queued.length, 1);
  await ownership.seedMeta(stale.use.database(), { outgoingSync: { sent: emptySent(), retiredAt: "2026-01-01T00:00:00Z" } });
  await stale.use.reloadPersistedState();
  const before = await ownership.dump(stale.use.database());
  await stale.use.syncNow(true);
  assert.ok(stale.state.conflict);
  assert.match(stale.state.conflict, /durationOperations/);
  assert.deepEqual(stale.state.savedClaimRecovery.queues, ["durationOperations"]);
  assert.equal(stale.state.savedClaimRecovery.armed, false);
  await assert.rejects(stale.use.discardSavedClaimRecovery(stale.use.captureAccountContext()), /confirm/i);
  assert.deepEqual(await ownership.dump(stale.use.database()), before);
  stale.use.armSavedClaimRecovery();
  assert.equal(stale.state.savedClaimRecovery.armed, true);
  const result = await stale.use.discardSavedClaimRecovery(stale.use.captureAccountContext());
  assert.equal(typeof result.claim.body, "string");
  assert.equal(stale.state.savedClaimRecovery, null);
  assert.equal(stale.state.conflict, null);
  const after = await ownership.dump(stale.use.database());
  assert.deepEqual(after.pendingDurations, before.pendingDurations);
  assert.deepEqual(after.pending, before.pending);
  assert.deepEqual(after.pendingTasks, before.pendingTasks);
  const replayBody = (await storage.claimWorkspaceBatch(stale.use.database(),
    { ...stale.use.captureAccountContext(), deviceId: stale.state.deviceId, localNowMs: Date.now() })).claim.body;
  assert.equal(replayBody, result.claim.body);
  assert.deepEqual(await ownership.dump(stale.use.database()), after);
});

test("CORE-PWA06 recovery panel names queue and requires confirm then cancel", async (t) => {
  const ownership = require("./test/account-ownership-fixture.js");
  const current = await ownership.fixture(t);
  const { stale } = current;
  await stale.use.persistDurationOperation("focus", 1800000);
  await ownership.seedMeta(stale.use.database(), { outgoingSync: { sent: emptySent(), retiredAt: "2026-01-01T00:00:00Z" } });
  await stale.use.reloadPersistedState();
  await stale.use.syncNow(true);
  assert.match(stale.state.conflict, /durationOperations/);
  const fs = require("node:fs");
  const path = require("node:path");
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, "app.html"), "utf8"));
  t.after(() => dom.window.close());
  const document = dom.window.document;
  const elements = Object.fromEntries(["conflictPanel", "conflictReason", "savedClaimRecovery",
    "savedClaimRecoveryText", "savedClaimDiscard", "savedClaimCancel", "conflictDismiss",
    "logoutButton", "deleteAccountButton", "noticeDismiss"].map((id) => [id, document.getElementById(id)]));
  Object.assign(stale.external, { elements,
    host: { ...stale.external.host, document, addEventListener: () => {} } });
  const view = require("./app-view.js").create({ state: stale.state, external: stale.external, use: stale.use });
  view.setupAccountEvents();
  view.renderConflict();
  assert.equal(elements.conflictPanel.hidden, false);
  assert.match(elements.conflictReason.textContent, /durationOperations/);
  assert.equal(elements.savedClaimRecovery.hidden, false);
  assert.match(elements.savedClaimRecoveryText.textContent, /durationOperations/);
  assert.match(elements.savedClaimDiscard.textContent, /Discard unrecoverable claim/);
  assert.equal(elements.savedClaimCancel.hidden, true);
  elements.savedClaimDiscard.click();
  assert.equal(stale.state.savedClaimRecovery.armed, true);
  view.renderConflict();
  assert.match(elements.savedClaimDiscard.textContent, /Confirm discard/);
  assert.equal(elements.savedClaimCancel.hidden, false);
  elements.savedClaimCancel.click();
  assert.equal(stale.state.savedClaimRecovery.armed, false);
  view.renderConflict();
  assert.equal(elements.savedClaimCancel.hidden, true);
});
