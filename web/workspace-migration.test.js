"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { fixture, seedMeta, seedQueues, dump, meta, startFocus, nowMs, user, storage, sync } = require("./test/p222-completion-fixture.js");
const workspace = require("./workspace-core.js");
const receipts = [];

test.after(() => {
  if (process.env.PWA_CORE_RECEIPTS_PATH) fs.writeFileSync(process.env.PWA_CORE_RECEIPTS_PATH,
    JSON.stringify({ provenance: require("./shared-core-metadata.js"), receipts }, null, 2));
});

async function prepared(t, overrides = {}) {
  const value = await fixture(t, overrides);
  value.client.external.sharedCoreHost.SharedCore = { load: async () => value.core };
  await seedMeta(value.client.use.database(), { canonicalHead: { wallMs: nowMs, counter: 2 } });
  await value.client.use.reloadPersistedState();
  return value;
}

function mutationInput(client, extra) {
  return { ...client.use.captureAccountContext(), deviceId: client.state.deviceId,
    tabId: client.use.tabId(), nowMs, localNowMs: nowMs, leaseMs: 60000,
    timerUuid: "12345678-1234-4234-8234-123456789012", ...extra };
}

test("migration atomic add-and-select survives actual database reopen", async (t) => {
  const { client, open } = await prepared(t);
  assert.equal(await client.use.addTask("Café"), true, client.notices.join("; "));
  const before = await dump(client.use.database());
  assert.equal(before.pendingTasks.length, 1);
  assert.equal(before.pendingSelectedTasks.length, 1);
  assert.deepEqual(meta(before, "deliveryProof").taskOperations, before.pendingTasks.map((item) => item.id));
  const reopened = await open();
  await reopened.use.reloadPersistedState();
  assert.deepEqual(await dump(reopened.use.database()), before);
  assert.equal(reopened.state.selectedTaskId, before.pendingTasks[0].taskId);
});

test("migration add-and-select second-member failure aborts first member and allocation", async (t) => {
  const { client } = await prepared(t);
  let effects = 0;
  client.use.scheduleSync = () => { effects += 1; };
  const before = await dump(client.use.database());
  const original = client.use.database().transaction.bind(client.use.database());
  client.use.database().transaction = (...args) => {
    const transaction = original(...args);
    const objectStore = transaction.objectStore.bind(transaction);
    transaction.objectStore = (name) => {
      const store = objectStore(name);
      if (name === "pendingSelectedTasks" && transaction.mode === "readwrite") {
        store.add = () => { throw new Error("injected second-member failure"); };
      }
      return store;
    };
    return transaction;
  };
  assert.equal(await client.use.addTask("atomic task"), false);
  assert.equal(effects, 0);
  assert.deepEqual(await dump(client.use.database()), before);
});

test("migration retained generated break child depends on direct Start, not focus Finish", async (t) => {
  const { client } = await prepared(t, { autoStartBreaks: true });
  await startFocus(client);
  assert.equal(await client.use.finishTimer(false), true, client.notices.join("; "));
  const first = await dump(client.use.database());
  const generated = first.pending.find((item) => item.generatedBreak);
  assert.ok(generated);
  assert.equal(await client.use.finishTimer(false), true, client.notices.join("; "));
  const after = await dump(client.use.database());
  const child = after.pending.at(-1);
  assert.equal(child.dependsOnCommandId, generated.id);
  assert.equal(meta(after, "timerDependencies").find((edge) => edge.operationId === child.id).dependsOnOperationId, generated.id);
});

test("migration claimed request retries exactly and leaves newer queued duration for next claim", async (t) => {
  const { client, open } = await prepared(t);
  await client.use.persistDurationOperation("focus", 1800000);
  const first = await storage.claimWorkspaceBatch(client.use.database(), mutationInput(client, {}));
  const originalBody = first.claim.body;
  await client.use.persistDurationOperation("focus", 2100000);
  const reopened = await open();
  const retry = await storage.claimWorkspaceBatch(reopened.use.database(), mutationInput(reopened, {}));
  assert.equal(retry.plan.status, "replay_saved");
  assert.equal(retry.claim.body, originalBody);
  assert.deepEqual(retry.claim.sent, first.claim.sent);
  assert.equal((await dump(reopened.use.database())).pendingDurations.length, 2);
});

test("migration Core batch plan limits total and persists fairness cursor with proof", async (t) => {
  const { client } = await prepared(t);
  const operation = (id, index) => ({ id, deviceId: client.state.deviceId, hlcWallMs: nowMs + 1,
    hlcCounter: index, occurredAt: new Date(nowMs + 1).toISOString() });
  const taskOperations = Array.from({ length: 256 }, (_, i) => ({ ...operation(`task-${i}`, i),
    type: "delete", taskId: `target-${i}` }));
  const durationOperations = Array.from({ length: 256 }, (_, i) => ({ ...operation(`duration-${i}`, i),
    phase: "focus", durationMs: 1800000 }));
  const autoStartOperations = Array.from({ length: 256 }, (_, i) => ({ ...operation(`auto-${i}`, i), enabled: true }));
  await seedQueues(client.use.database(), { taskOperations, durationOperations, autoStartOperations });
  const before = await dump(client.use.database());
  const result = await storage.claimWorkspaceBatch(client.use.database(), mutationInput(client, {}));
  assert.equal(Object.values(result.claim.sent).flat().length, 512);
  const after = await dump(client.use.database());
  assert.equal(meta(after, "batchNextDomain"), result.plan.nextDomain);
  assert.deepEqual(after.pendingTasks, before.pendingTasks);
  assert.deepEqual(after.pendingDurations, before.pendingDurations);
  assert.deepEqual(after.pendingAutoStarts, before.pendingAutoStarts);
});

test("migration oversized possibly delivered saved claim stays unchanged through reopen", async (t) => {
  const { client, open } = await prepared(t);
  const sent = Object.fromEntries(workspace.DOMAINS.map((key) => [key, []]));
  sent.durationOperations = Array.from({ length: 257 }, (_, i) => ({ id: `saved-${i}`, extension: "original" }));
  const claim = { sent, body: "original request bytes", requestId: "old-identity", retiredAt: "2026-07-01T00:00:00Z" };
  await seedMeta(client.use.database(), { outgoingSync: claim, deliveryProof: {} });
  const before = await dump(client.use.database());
  const reopened = await open();
  const result = await storage.claimWorkspaceBatch(reopened.use.database(), mutationInput(reopened, {}));
  assert.equal(result.plan.status, "oversized_saved");
  assert.deepEqual(result.claim, claim);
  assert.deepEqual(await dump(reopened.use.database()), before);
});

test("migration oversized possibly delivered bootstrap remains visibly blocked without identity rotation", async (t) => {
  const { client } = await prepared(t);
  client.external.host.navigator.onLine = true;
  const pending = { userId: sync.accountOwnerId(user), gateToken: client.use.tabId(),
    deliveryState: "possiblyDelivered", payload: { requestId: "immutable-history-request",
      deviceId: client.state.deviceId, expectedRevision: 3, strategy: "merge",
      ...Object.fromEntries(workspace.DOMAINS.map((domain) => [domain, []])) } };
  pending.payload.durationOperations = Array.from({ length: 4097 }, (_, index) => ({ id: `oversized-${index}` }));
  await seedMeta(client.use.database(), { bootstrapGate: { token: client.use.tabId(), leaseExpiresAtMs: nowMs + 300000 },
    bootstrapResolution: pending });
  Object.assign(client.state, { bootstrapPending: pending, bootstrapGateOwned: true });
  let renders = 0;
  let posts = 0;
  client.use.renderBootstrapDialog = () => { renders += 1; };
  client.use.postMutation = () => { posts += 1; };
  const actions = require("./app-bootstrap.js").create({ state: client.state, external: client.external, use: client.use });
  const before = await dump(client.use.database());
  await actions.submitBootstrapResolution();
  assert.match(client.state.bootstrapError, /exceeds Core limits/);
  assert.equal(renders, 1);
  assert.equal(posts, 0);
  assert.deepEqual(await dump(client.use.database()), before);
  assert.equal(client.state.bootstrapPending.payload.requestId, pending.payload.requestId);
});

async function compareCommittedPlan(client, core, extra) {
  const before = await dump(client.use.database());
  const calls = [];
  const original = core.call.bind(core);
  core.call = (operation, input) => {
    const inputRaw = JSON.stringify(input);
    const value = original(operation, input);
    calls.push({ operation, inputRaw, input: JSON.parse(inputRaw), value: structuredClone(value) });
    return value;
  };
  let result;
  try { result = await storage.planWorkspaceMutation(client.use.database(), mutationInput(client, extra)); }
  finally { core.call = original; }
  const operation = extra.stage ? "workspace.completionMutation.v1" : "workspace.intent.v1";
  const receipt = calls.find((call) => call.operation === operation);
  assert.ok(receipt);
  assert.deepEqual(JSON.parse(receipt.inputRaw), receipt.input);
  assert.deepEqual(receipt.input.workspace.base, workspace.base(meta(before, "snapshot")));
  assert.deepEqual(receipt.input.workspace.canonicalHead, meta(before, "canonicalHead") ?? null);
  assert.deepEqual(receipt.input.workspace.timerDependencies, meta(before, "timerDependencies") ?? []);
  assert.deepEqual(receipt.input.workspace.displayContext, { profile: "pwaStorage",
    projectionPending: meta(before, "projectionPending") ?? null });
  for (const [domain, storeName] of Object.entries(require("./workspace-transaction.js").QUEUE_STORES)) {
    assert.deepEqual(receipt.input.workspace.local[domain], before[storeName]);
  }
  assert.deepEqual(receipt.input.allocation.hlc, meta(before, "hlc"));
  assert.equal(receipt.input.allocation.deviceSequence, meta(before, "deviceSequence"));
  assert.equal(receipt.input.allocation.lastUuid, meta(before, "uuidV7"));
  assert.equal(Date.parse(receipt.input.clock.occurredAt), extra.nowMs ?? nowMs);
  assert.deepEqual(result, receipt.value);
  assert.deepEqual(result, original(operation, receipt.input));
  const after = await dump(client.use.database());
  receipts.push({ ...receipt, persistedBefore: before, persistedAfter: after,
    rawDeliveryProof: meta(before, "deliveryProof") ?? null,
    rawOutgoingClaim: meta(before, "outgoingSync") ?? null,
    browserObservations: { nowMs: extra.nowMs ?? nowMs, localNowMs: extra.localNowMs ?? nowMs,
      monotonicNowMs: extra.monotonicMs ?? null }, completeProductionReturn: result });
  assertCommittedPlan(before, after, result);
  return result;
}

function assertCommittedPlan(before, after, result) {
  if (result.outcome === "noop") { assert.deepEqual(after, before); return; }
    assert.deepEqual(meta(after, "hlc"), result.allocation.hlc);
    assert.equal(meta(after, "deviceSequence"), result.allocation.deviceSequence);
    assert.equal(meta(after, "uuidV7"), result.allocation.lastUuid);
    assert.deepEqual(meta(after, "workspaceObservation"), result.observation);
    assert.deepEqual(meta(after, "timerDependencies"), result.workspace.timerDependencies);
    assert.deepEqual(meta(after, "deliveryProof"), result.workspace.neverSent);
    assert.deepEqual(meta(after, "projectionPending"), result.workspace.displayContext.projectionPending);
    const durable = result.durableOperations || { commands: result.durableCommands || result.commands };
    for (const [domain, name] of Object.entries(require("./workspace-transaction.js").QUEUE_STORES)) {
      const retired = new Set(domain === "durationOperations" ? result.retiredDurationOperationIds || [] : []);
      const expected = before[name].filter((row) => !retired.has(row.id)).concat(durable[domain] || []);
      const byId = (left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      assert.deepEqual([...after[name]].sort(byId), expected.sort(byId), `${domain}: complete durable rows`);
    }
    assert.equal(meta(after, "settings").selectedPhase, result.selection.phase);
    assert.deepEqual(meta(after, "snapshot"), meta(before, "snapshot"));
    assert.deepEqual(meta(after, "outgoingSync"), meta(before, "outgoingSync"));
}

for (const intent of [
  { kind: "start" }, { kind: "selectPhase", phase: "long_break" },
  { kind: "addAndSelectTask", title: "Café" }, { kind: "setDuration", phase: "short_break", minutes: 7 },
  { kind: "setAutoStart", enabled: true }
]) {
  test(`migration complete persisted source parity: ${intent.kind}`, async (t) => {
    const { client, core, open } = await prepared(t);
    const result = await compareCommittedPlan(client, core, { intent,
      preference: ["addAndSelectTask", "setDuration", "setAutoStart"].includes(intent.kind) });
    assert.equal(result.outcome, "planned");
    const saved = await dump(client.use.database());
    const reopened = await open();
    assert.deepEqual(await dump(reopened.use.database()), saved);
  });
}

for (const phase of ["focus", "short_break", "long_break"]) {
  test(`migration timer controls and early/expiry completion source parity: ${phase}`, async (t) => {
    const { client, core } = await prepared(t);
    await storage.planWorkspaceMutation(client.use.database(), mutationInput(client, { intent: { kind: "selectPhase", phase } }));
    await compareCommittedPlan(client, core, { intent: { kind: "start" } });
    await compareCommittedPlan(client, core, { intent: { kind: "pause" } });
    await compareCommittedPlan(client, core, { intent: { kind: "resume" } });
    await client.use.reloadPersistedState();
    const timer = structuredClone(client.state.timer);
    const early = await compareCommittedPlan(client, core, { stage: "automaticFinishCommit", requestedTimer: timer });
    assert.equal(early.outcome, "noop");
    assert.equal(early.reason, "notExpired");
    const expired = await storage.planWorkspaceMutation(client.use.database(), mutationInput(client, {
      stage: "automaticFinishCommit", requestedTimer: timer, nowMs: nowMs + timer.plannedDurationMs,
      localNowMs: nowMs + timer.plannedDurationMs
    }));
    assert.equal(expired.outcome, "planned");
    assert.equal(expired.commands[0].observedElapsedMs, timer.plannedDurationMs);
    await client.use.reloadPersistedState();
    const cancel = await compareCommittedPlan(client, core, { intent: { kind: "cancelAndClear" }, requestedTimer: client.state.timer,
      nowMs: nowMs + timer.plannedDurationMs, localNowMs: nowMs + timer.plannedDurationMs });
    assert.equal(cancel.commands[0].type, "clear");
  });
}

for (const stage of ["finishCommit", "automaticFinishCommit"]) {
  test(`migration complete persisted completion and generated Start source parity: ${stage}`, async (t) => {
    const { client, core, open } = await prepared(t, { autoStartBreaks: true });
    await startFocus(client);
    const timer = structuredClone(client.state.timer);
    const observationMs = stage === "automaticFinishCommit" ? nowMs + timer.plannedDurationMs : nowMs;
    const result = await compareCommittedPlan(client, core, { stage, requestedTimer: timer,
      nowMs: observationMs, localNowMs: observationMs });
    assert.equal(result.outcome, "planned");
    assert.equal(result.commands.length, 2);
    assert.equal(result.commands[1].dependsOnCommandId, result.commands[0].id);
    const saved = await dump(client.use.database());
    assert.equal(meta(saved, "timerOwner").timerId, result.commands[1].timerId);
    assert.deepEqual(meta(saved, "workspaceGroups").at(-1).atomicCommandIds, result.atomicCommandIds);
    const reopened = await open();
    assert.deepEqual(await dump(reopened.use.database()), saved);
  });
}

test("migration Core clock/read model preserves fractional progress across wall jumps and browser restart", async (t) => {
  const { client, open } = await prepared(t);
  let monotonic = 100;
  client.external.host.performance = { now: () => monotonic };
  await startFocus(client);
  const raw = await dump(client.use.database());
  assert.equal(client.use.getWorkspaceReadModel().canonical.elapsedMs, 0);
  monotonic = 16099.5;
  t.mock.timers.tick(3600000);
  const read = client.use.getWorkspaceReadModel();
  assert.equal(read.canonical.elapsedMs, 15999.5);
  assert.equal(read.display.remainingSecondsCeil, 1485);
  assert.deepEqual(await dump(client.use.database()), raw);
  t.mock.timers.setTime(nowMs + 10000);
  const reopened = await open();
  reopened.external.host.performance = { now: () => 20000 };
  await reopened.use.reloadPersistedState();
  assert.notEqual(reopened.use.clockContinuityId(), client.use.clockContinuityId());
  assert.equal(reopened.use.getWorkspaceReadModel().canonical.elapsedMs, 10000);
  assert.deepEqual(await dump(reopened.use.database()), raw);
});

test("migration idle browser monotonic reading does not serialize a null Anchor object", async (t) => {
  const { client } = await prepared(t);
  client.external.host.performance = { now: () => 123.5 };
  const model = client.use.getWorkspaceReadModel();
  assert.equal(model.canonical.status, "idle");
  assert.equal(model.display.remainingSecondsCeil, 1500);
});

test("migration expired timer presentation and primary control use Core read status, not retained running source", async (t) => {
  const { client } = await prepared(t);
  await startFocus(client);
  t.mock.timers.setTime(nowMs + client.state.timer.plannedDurationMs);
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, "app.html"), "utf8"));
  t.after(() => dom.window.close());
  const elements = Object.fromEntries([...dom.window.document.querySelectorAll("[id]")].map((element) => [element.id, element]));
  let action;
  let source;
  client.use.issueCommand = (kind) => { action = kind; };
  client.use.primeCompletionAlerts = () => {};
  client.use.updateTimerCompletion = (timer, status, remaining) => { source = { timerId: timer.id, status, remaining }; };
  const view = require("./app-view.js").create({ state: client.state, use: client.use,
    external: { ...client.external, host: { ...client.external.host, document: dom.window.document }, elements } });
  view.setupTimerEvents();
  view.renderTimer();
  assert.equal(client.state.timer.status, "running", "keep the raw presented source for automatic completion admission");
  assert.equal(client.state.readModel.display.status, "completed");
  assert.match(elements.timerDetail.textContent, /COMPLETED/);
  assert.equal(elements.timerToggle.textContent, "Start short break");
  assert.equal(elements.finishButton.disabled, false);
  assert.equal(source.status, "running");
  assert.equal(source.remaining, 0);
  elements.timerToggle.click();
  assert.equal(action, "start");
});

for (let count = 0; count <= 12; count += 1) {
  test(`migration daily totals and skip count ${count} use official read model`, async (t) => {
    const { client, core } = await prepared(t);
    const { id: taskId, title } = core.taskIdentity({ title: "Current task" });
    const { id: deletedTaskId } = core.taskIdentity({ title: "Deleted task" });
    const completedAt = new Date(nowMs - 1000).toISOString();
    const history = Array.from({ length: count }, (_, index) => ({ id: `history-${index}`, timerId: `timer-${index}`,
      phase: "focus", status: "completed", plannedDurationMs: 60000, completedAt, endedAt: completedAt,
      taskId: index % 2 ? deletedTaskId : taskId }));
    const saved = meta(await dump(client.use.database()), "snapshot");
    await seedMeta(client.use.database(), { snapshot: { ...saved, history, tasks: [{ id: taskId, title }] } });
    await client.use.reloadPersistedState();
    const model = client.use.getWorkspaceReadModel();
    assert.equal(model.cadence.completedFocusToday, count);
    assert.equal(model.cadence.completedFocusTodayPlannedDurationMs, count * 60000);
    assert.equal(model.tasks.completedFocusTodayByTask[taskId].count, Math.ceil(count / 2));
    assert.equal(model.cadence.skipDestination, count % 4 === 3 ? "long_break" : "short_break");
  });
}

test("migration account replacement aborts complete group and allocation", async (t) => {
  const { client } = await prepared(t);
  const originalSnapshot = meta(await dump(client.use.database()), "snapshot");
  await seedMeta(client.use.database(), { snapshot: { ...originalSnapshot,
    user: { ...user, accountIncarnation: "d".repeat(64) } } });
  const before = await dump(client.use.database());
  await assert.rejects(storage.planWorkspaceMutation(client.use.database(), mutationInput(client, {
    preference: true, intent: { kind: "addAndSelectTask", title: "private old-account title" }
  })), storage.AccountOwnershipError);
  assert.deepEqual(await dump(client.use.database()), before);
});

function canonicalResponse(core, records, sent, outcome = "applied", terminalPair = false) {
  const snapshot = meta(records, "snapshot");
  const pending = Object.fromEntries(workspace.DOMAINS.map((domain) => [domain, sent[domain].map((item) =>
    item.deviceId ? item : { ...item, deviceId: meta(records, "deviceId") }
  )]));
  const projection = outcome === "applied" ? core.projectSynchronizedState({
    base: { ...workspace.base(snapshot), canonicalTimer: snapshot.history.some((item) => item.timerId === snapshot.canonicalTimer?.id)
      ? null : snapshot.canonicalTimer }, pending, now: new Date(nowMs).toISOString()
  }) : workspace.base(snapshot);
  const canonicalTimer = !terminalPair && projection.history.some((item) => item.timerId === projection.canonicalTimer?.id)
    ? null : projection.canonicalTimer;
  return { ...snapshot, ...projection, canonicalTimer, revision: snapshot.revision + 1,
    serverTime: new Date(nowMs).toISOString(), serverHlcWallMs: nowMs, serverHlcCounter: 100,
    accountIncarnation: user.accountIncarnation,
    acknowledgements: sent.commands.map(({ id }) => ({ commandId: id, outcome, reason: "" })),
    taskAcknowledgements: [], durationAcknowledgements: [], autoStartAcknowledgements: [], selectedTaskAcknowledgements: [] };
}

async function installResponse(client, capturedClaim, response) {
  const sent = capturedClaim.sent;
  return storage.applySyncResponse(client.use.database(), {
    capturedClaim,
    ...client.use.captureAccountContext(), expectedUserId: sync.accountOwnerId(user),
    snapshot: { revision: response.revision, serverTime: response.serverTime,
      ...workspace.base(response), user }, hlc: { wallMs: nowMs, counter: 100 },
    serverHlc: { wallMs: nowMs, counter: 100 },
    queueIds: Object.fromEntries(workspace.DOMAINS.map((key) => [key, sent[key].map((item) => item.id)])),
    reconciliation: { sent, response, deviceId: client.state.deviceId }
  });
}

for (const outcome of ["applied", "rejected"]) {
  test(`migration supported null-timer Finish ACK then Start ${outcome} preserves direct-child barrier through reopen`, async (t) => {
    const { client, core, open } = await prepared(t, { autoStartBreaks: true });
    await startFocus(client);
    // Install the accepted Start before the completion group is created.
    let claim = await storage.claimWorkspaceBatch(client.use.database(), mutationInput(client, {}));
    await installResponse(client, claim.claim, canonicalResponse(core, await dump(client.use.database()), claim.claim.sent));
    await client.use.reloadPersistedState();
    assert.equal(await client.use.finishTimer(false), true, client.notices.join("; "));
    assert.equal(await client.use.finishTimer(false), true, client.notices.join("; "));
    const group = await dump(client.use.database());
    const finish = group.pending.find((item) => item.type === "finish" && item.phase === "focus");
    const generated = group.pending.find((item) => item.generatedBreak);
    const child = group.pending.find((item) => item.dependsOnCommandId === generated.id);
    claim = await storage.claimWorkspaceBatch(client.use.database(), mutationInput(client, {}));
    assert.deepEqual(claim.claim.sent.commands.map((item) => item.id), [finish.id]);
    const before = await dump(client.use.database());
    const unrelated = canonicalResponse(core, before, claim.claim.sent);
    unrelated.acknowledgements[0].commandId = "unrelated-identity";
    await assert.rejects(installResponse(client, claim.claim, unrelated));
    assert.deepEqual(await dump(client.use.database()), before);
    await installResponse(client, claim.claim, canonicalResponse(core, before, claim.claim.sent));
    const afterFinish = await dump(client.use.database());
    assert.deepEqual(meta(afterFinish, "timerDependencies"), [{ operationId: child.id, dependsOnOperationId: generated.id }]);
    const reopened = await open();
    claim = await storage.claimWorkspaceBatch(reopened.use.database(), mutationInput(reopened, {}));
    assert.deepEqual(claim.claim.sent.commands.map((item) => item.id), [generated.id]);
    const savedClaim = await dump(reopened.use.database());
    const replay = await storage.claimWorkspaceBatch(reopened.use.database(), mutationInput(reopened, {}));
    assert.deepEqual(replay.claim, claim.claim);
    assert.deepEqual(await dump(reopened.use.database()), savedClaim);
    await installResponse(reopened, claim.claim, canonicalResponse(core, savedClaim, claim.claim.sent, outcome));
    const afterStart = await dump(reopened.use.database());
    assert.deepEqual(meta(afterStart, "timerDependencies"), []);
    assert.deepEqual(afterStart.pending.map((item) => item.id), outcome === "applied" ? [child.id] : []);
    if (outcome === "applied") {
      assert.deepEqual(afterStart.pending[0], child, "Core retires the graph edge without rewriting retained wire extensions");
      const next = await storage.claimWorkspaceBatch(reopened.use.database(), mutationInput(reopened, {}));
      assert.deepEqual(next.claim.sent.commands.map((command) => command.id), [child.id]);
    }
  });
}

test("migration terminal-pair ACK installs the raw canonical pair and complete Core display result", async (t) => {
  const { client, core } = await prepared(t);
  await startFocus(client);
  let claim = await storage.claimWorkspaceBatch(client.use.database(), mutationInput(client, {}));
  await installResponse(client, claim.claim, canonicalResponse(core, await dump(client.use.database()), claim.claim.sent));
  await client.use.reloadPersistedState();
  assert.equal(await client.use.finishTimer(false), true);
  claim = await storage.claimWorkspaceBatch(client.use.database(), mutationInput(client, {}));
  const before = await dump(client.use.database());
  const response = canonicalResponse(core, before, claim.claim.sent, "applied", true);
  assert.equal(response.canonicalTimer.status, "completed");
  assert.ok(response.history.some((item) => item.timerId === response.canonicalTimer.id));
  assert.equal((await installResponse(client, claim.claim, response)).applied, true);
  const after = await dump(client.use.database());
  assert.deepEqual(meta(after, "snapshot").canonicalTimer, response.canonicalTimer);
  assert.deepEqual(meta(after, "snapshot").history, response.history);
  assert.deepEqual(after.pending, []);
  assert.equal(meta(after, "outgoingSync"), undefined);
  await client.use.reloadPersistedState();
  assert.equal(client.state.timer.status, "completed");
  receipts.push({ case: t.name, before, response, after });
});

for (const laterChoice of [null, "long_break"]) {
  test(`migration rejected Finish selection resolves in canonical transaction, later choice=${laterChoice}`, async (t) => {
    const { client, core } = await prepared(t);
    await startFocus(client);
    let claim = await storage.claimWorkspaceBatch(client.use.database(), mutationInput(client, {}));
    await installResponse(client, claim.claim, canonicalResponse(core, await dump(client.use.database()), claim.claim.sent));
    await client.use.reloadPersistedState();
    assert.equal(await client.use.finishTimer(false), true);
    assert.equal(client.state.selectedPhase, "short_break");
    if (laterChoice) {
      const savedSettings = meta(await dump(client.use.database()), "settings");
      await seedMeta(client.use.database(), { settings: { ...savedSettings, selectedPhase: laterChoice } });
    }
    claim = await storage.claimWorkspaceBatch(client.use.database(), mutationInput(client, {}));
    const before = await dump(client.use.database());
    await installResponse(client, claim.claim, canonicalResponse(core, before, claim.claim.sent, "rejected"));
    const after = await dump(client.use.database());
    assert.equal(meta(after, "settings").selectedPhase, laterChoice || "focus");
    assert.deepEqual(after.pending, []);
    assert.equal(meta(after, "outgoingSync"), undefined);
    assert.equal(meta(after, "snapshot").canonicalTimer.status, "running");
  });
}

test("migration bootstrap classifier captures raw persisted base, queues and display context", async (t) => {
  const { client, core } = await prepared(t);
  await client.use.persistDurationOperation("focus", 1800000);
  const records = await storage.readSyncState(client.use.database());
  const input = { ...records, deviceId: client.state.deviceId, ownerId: sync.accountOwnerId(user),
    currentUserId: sync.accountOwnerId(user), remote: meta(await dump(client.use.database()), "snapshot"), nowMs };
  const result = storage.bootstrapWorkspace(input);
  const direct = core.call("bootstrap.workspacePlan.v1", workspace.bootstrapRequest(input,
    client.state.deviceId, records.timerDependencies || [], input.currentUserId, nowMs, workspace.DEFAULT_DURATIONS));
  assert.deepEqual(result, direct);
  assert.equal(result.plan.mode, "normal_sync");
  assert.equal(result.classification.local.hasState, true);
});

test("migration saved legacy claim without request body is retained instead of reconstructed", async (t) => {
  const { client } = await prepared(t);
  const claim = { sent: Object.fromEntries(workspace.DOMAINS.map((domain) => [domain, []])), retiredAt: "2026-01-01T00:00:00Z" };
  await seedMeta(client.use.database(), { outgoingSync: claim });
  const before = await dump(client.use.database());
  const result = await storage.claimWorkspaceBatch(client.use.database(), mutationInput(client, {}));
  assert.equal(result.plan.status, "replay_saved");
  assert.deepEqual(result.claim, claim);
  assert.equal(result.claim.body, undefined);
  assert.deepEqual(await dump(client.use.database()), before);
});

test("migration legacy settings transfer keeps possibly delivered occurrence and outgoing bytes exact", async (t) => {
  const { client } = await prepared(t);
  const settings = meta(await dump(client.use.database()), "settings");
  const operation = { id: "legacy-duration", phase: "focus", durationMs: 1800000,
    occurredAt: "2026-07-01T00:00:00Z", hlcWallMs: 0, hlcCounter: 0, extension: { empty: "", nullable: null } };
  const outgoing = { sent: { ...Object.fromEntries(workspace.DOMAINS.map((domain) => [domain, []])),
    durationOperations: [operation] }, body: "original possibly delivered bytes" };
  await seedMeta(client.use.database(), { settings: { ...settings, pendingDurationOperations: [operation] }, outgoingSync: outgoing });
  await client.use.migrateDurationQueueFromSettings();
  const transferred = await dump(client.use.database());
  assert.deepEqual(transferred.pendingDurations, [operation]);
  assert.deepEqual(meta(transferred, "outgoingSync"), outgoing);
  assert.equal(meta(transferred, "settings").pendingDurationOperations, undefined);
  await assert.rejects(storage.normalizeLegacyDurationOperations(client.use.database(), client.use.captureAccountContext()),
    /Possibly delivered legacy duration cannot be rewritten/);
  assert.deepEqual(await dump(client.use.database()), transferred);
});

test("migration conflicting legacy identity aborts transfer without overwriting retained payload", async (t) => {
  const { client } = await prepared(t);
  const operation = (await client.use.persistDurationOperation("focus", 1800000)).operation;
  const settings = meta(await dump(client.use.database()), "settings");
  await seedMeta(client.use.database(), { settings: { ...settings, pendingDurationOperations: [{ ...operation, durationMs: 2100000 }] } });
  const before = await dump(client.use.database());
  await assert.rejects(client.use.migrateDurationQueueFromSettings(), /different retained payload/);
  assert.deepEqual(await dump(client.use.database()), before);
});

test("migration claimed duration extension and original request bytes remain exact after unrelated atomic task group", async (t) => {
  const { client, core, open } = await prepared(t);
  await client.use.persistDurationOperation("focus", 1800000);
  const records = await dump(client.use.database());
  const operation = { ...records.pendingDurations[0], privateExtension: { omitted: null, empty: "", enabled: false } };
  const transaction = client.use.database().transaction(["pendingDurations", "meta"], "readwrite");
  transaction.objectStore("pendingDurations").put(operation);
  transaction.objectStore("meta").put({ key: "projectionPending", value: {
    ...meta(records, "projectionPending"), durationOperations: [operation]
  } });
  await storage.transactionDone(transaction);
  const claim = await storage.claimWorkspaceBatch(client.use.database(), mutationInput(client, {}));
  const group = await compareCommittedPlan(client, core, {
    preference: true, intent: { kind: "addAndSelectTask", title: "Later task" }
  });
  assert.equal(group.outcome, "planned");
  const later = await dump(client.use.database());
  assert.deepEqual(later.pendingDurations, [operation]);
  assert.deepEqual(meta(later, "outgoingSync"), claim.claim);
  const reopened = await open();
  assert.deepEqual(await dump(reopened.use.database()), later);
  const next = await storage.claimWorkspaceBatch(reopened.use.database(), mutationInput(reopened, {}));
  assert.equal(next.claim.body, claim.claim.body);
  assert.equal(next.plan.status, "replay_saved");
});

test("migration claim and fairness cursor roll back with injected outgoing persistence failure", async (t) => {
  const { client } = await prepared(t);
  await client.use.persistDurationOperation("focus", 1800000);
  const before = await dump(client.use.database());
  const transaction = client.use.database().transaction.bind(client.use.database());
  t.mock.method(client.use.database(), "transaction", (...args) => {
    const current = transaction(...args);
    const objectStore = current.objectStore.bind(current);
    current.objectStore = (name) => {
      const store = objectStore(name);
      const put = store.put.bind(store);
      store.put = (record) => {
        if (record.key === "outgoingSync") throw new Error("claim persistence failed");
        return put(record);
      };
      return store;
    };
    return current;
  });
  await assert.rejects(storage.claimWorkspaceBatch(client.use.database(), mutationInput(client, {})), /claim persistence failed/);
  t.mock.restoreAll();
  assert.deepEqual(await dump(client.use.database()), before);
});

test("migration select+retarget is one atomic group and keeps immutable Start task assignment", async (t) => {
  const { client, core } = await prepared(t);
  assert.equal(await client.use.addTask("First task"), true);
  const firstTaskId = client.state.selectedTaskId;
  await startFocus(client);
  const start = client.state.pending[0];
  const secondTask = core.taskIdentity({ title: "Second task" });
  await compareCommittedPlan(client, core, { intent: { kind: "upsertTask", title: secondTask.title }, preference: true });
  await client.use.reloadPersistedState();
  const result = await compareCommittedPlan(client, core, { intent: { kind: "selectTask", taskId: secondTask.id }, preference: true });
  assert.equal(result.operations.selectedTaskOperations.length, 1);
  assert.equal(result.commands[0].type, "retarget");
  const after = await dump(client.use.database());
  assert.deepEqual(after.pending.find((command) => command.id === start.id), start);
  assert.equal(start.taskId, firstTaskId);
  assert.equal(result.commands[0].taskId, secondTask.id);
});

test("migration ownership change after planning aborts every member before effects", async (t) => {
  const { client, core } = await prepared(t);
  const before = await dump(client.use.database());
  const call = core.call.bind(core);
  let checks = 0;
  const input = mutationInput(client, { intent: { kind: "addAndSelectTask", title: "Fenced task" }, preference: true,
    assertCurrent: () => { if (++checks > 1) throw new storage.AccountOwnershipError(); } });
  await assert.rejects(storage.planWorkspaceMutation(client.use.database(), input), storage.AccountOwnershipError);
  assert.deepEqual(await dump(client.use.database()), before);
  assert.equal(checks, 2);
  assert.equal(call("core.version", {}).coreVersion, "0.46.0");
});

test("migration claimed head-covered timer survives reload and permits a scoped Pause without rewriting its claim", async (t) => {
  const { client, core, open } = await prepared(t);
  await startFocus(client);
  const start = client.state.pending[0];
  await seedMeta(client.use.database(), { canonicalHead: { wallMs: start.hlcWallMs, counter: start.hlcCounter } });
  await storage.claimWorkspaceBatch(client.use.database(), mutationInput(client, {}));
  const before = await dump(client.use.database());
  const reopened = await open();
  await reopened.use.reloadPersistedState();
  assert.equal(reopened.state.timer.status, "running");
  const result = await compareCommittedPlan(reopened, core, { intent: { kind: "pause" } });
  const after = await dump(reopened.use.database());
  assert.equal(result.commands[0].type, "pause");
  assert.deepEqual(after.pending.slice(0, -1), before.pending);
  assert.deepEqual(meta(after, "outgoingSync"), meta(before, "outgoingSync"));
  assert.deepEqual(meta(after, "snapshot"), meta(before, "snapshot"));
  await reopened.use.reloadPersistedState();
  assert.equal(reopened.state.timer.status, "paused");
});

test("migration official Core rejects supplied persisted display field rather than accepting invented policy", async (t) => {
  const { client, core } = await prepared(t);
  const records = await storage.readSyncState(client.use.database());
  const raw = storage.workspaceRecords({ ...records, deviceId: client.state.deviceId });
  assert.throws(() => core.call("workspace.readModel.v1", {
    ...workspace.readRequest(raw, "focus", nowMs, null), projectionPending: records.projectionPending
  }), /unknown field/);
});

test("migration timer and preference routes invoke official workspace planners", () => {
  const source = fs.readFileSync(path.join(__dirname, "app-storage.js"), "utf8");
  assert.match(source, /planWorkspaceMutation\(/);
  assert.doesNotMatch(source, /buildTimerCommand\(|buildRetargetCommand\(/);
});

test("migration version provenance is the immutable official 0.46 release", async (t) => {
  const { core } = await prepared(t);
  assert.equal(core.call("core.version", {}).coreVersion, "0.46.0");
  assert.equal(fs.statSync(path.join(__dirname, "pomodorough_core.wasm")).size, 2790028);
});
