"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const sync = require("./sync-core.js");

const defaults = { focus: 1_500_000, short_break: 300_000, long_break: 900_000 };

function history(id) {
  return {
    id,
    timerId: `timer-${id}`,
    status: "completed",
    phase: "focus",
    plannedDurationMs: 1_500_000,
    completedAt: "2026-07-22T12:25:00Z"
  };
}

function command(id, sequence = 1) {
  return {
    id,
    deviceSequence: sequence,
    timerId: `timer-${id}`,
    type: "start",
    phase: "focus",
    plannedDurationMs: 1_500_000,
    occurredAt: "2026-07-22T12:00:00Z",
    hlcWallMs: sequence,
    hlcCounter: 0,
    observedElapsedMs: 0
  };
}

function taskOperation(id, taskId, title, wall = 1) {
  return {
    id,
    taskId,
    type: "upsert",
    title,
    occurredAt: "2026-07-22T12:00:00Z",
    hlcWallMs: wall,
    hlcCounter: 0
  };
}

function durationOperation(id, wall = 1) {
  return {
    id,
    ownerId: "browser-tab-only",
    phase: "focus",
    durationMs: 1_800_000,
    occurredAt: "2026-07-22T12:00:00Z",
    hlcWallMs: wall,
    hlcCounter: 0
  };
}

function autoStartOperation(id, enabled, wall = 1, counter = 0) {
  return {
    id,
    enabled,
    occurredAt: "2026-07-22T12:00:00Z",
    hlcWallMs: wall,
    hlcCounter: counter
  };
}

function selectedTaskOperation(id, taskId, wall = 1, counter = 0) {
  return {
    id,
    taskId,
    occurredAt: "2026-07-22T12:00:00Z",
    hlcWallMs: wall,
    hlcCounter: counter
  };
}

function permutations(values) {
  if (values.length === 0) return [[]];
  return values.flatMap((value, index) => {
    const rest = values.slice(0, index).concat(values.slice(index + 1));
    return permutations(rest).map((permutation) => [value, ...permutation]);
  });
}

function responseFor(sent, overrides = {}) {
  return {
    acknowledgements: sent.commands.map((item) => ({ commandId: item.id, outcome: "applied", reason: "" })),
    taskAcknowledgements: sent.taskOperations.map((item) => ({ operationId: item.id, outcome: "applied", reason: "" })),
    durationAcknowledgements: sent.durationOperations.map((item) => ({ operationId: item.id, outcome: "applied", reason: "" })),
    autoStartAcknowledgements: (sent.autoStartOperations || []).map((item) => ({ operationId: item.id, outcome: "applied", reason: "" })),
    selectedTaskAcknowledgements: (sent.selectedTaskOperations || []).map((item) => ({ operationId: item.id, outcome: "applied", reason: "" })),
    revision: 9,
    canonicalTimer: null,
    history: [],
    tasks: [],
    durationsMs: defaults,
    autoStartBreaks: false,
    selectedTaskId: null,
    serverTime: "2026-07-22T12:30:00Z",
    serverHlcWallMs: Date.parse("2026-07-22T12:30:00Z"),
    serverHlcCounter: 0,
    ...overrides
  };
}

test("bootstrap decision separates ownership, empty sides, and conflicting meaningful state", () => {
  assert.deepEqual(sync.decideBootstrap({ localOwnerId: "user-1", currentUserId: "user-1" }), {
    mode: "normal_sync",
    reason: "same_owner"
  });
  assert.deepEqual(sync.decideBootstrap({
    localOwnerId: "user-1",
    currentUserId: "user-2",
    localHistory: [history("local")],
    remoteHistory: [history("remote")],
    hasLocalState: true
  }), { mode: "auto", strategy: "keep_remote", reason: "different_owner" });
  assert.equal(sync.decideBootstrap({ localHistory: [history("local")], remoteHistory: [] }).strategy, "replace_remote");
  assert.equal(sync.decideBootstrap({ localHistory: [], remoteHistory: [history("remote")] }).strategy, "keep_remote");
  assert.deepEqual(sync.decideBootstrap({
    localHistory: [history("local")],
    remoteHistory: [history("remote")]
  }), { mode: "choose", localHistoryCount: 1, remoteHistoryCount: 1 });
  assert.equal(sync.decideBootstrap({ localHistory: [], remoteHistory: [], hasLocalState: true }).strategy, "merge");
  assert.equal(sync.decideBootstrap({ localHistory: [], remoteHistory: [], hasLocalState: false }).strategy, "keep_remote");
  assert.deepEqual(sync.decideBootstrap({
    localHistory: [],
    remoteHistory: [],
    hasLocalState: true
  }), { mode: "auto", strategy: "merge", reason: "local_state_only" });

  const conflictCases = [
    { localHistory: [history("local")], remoteHistory: [], hasRemoteState: true, localHistoryCount: 1, remoteHistoryCount: 0 },
    { localHistory: [], remoteHistory: [history("remote")], hasLocalState: true, localHistoryCount: 0, remoteHistoryCount: 1 },
    { localHistory: [history("local")], remoteHistory: [history("remote")], localHistoryCount: 1, remoteHistoryCount: 1 }
  ];
  for (const input of conflictCases) {
    assert.deepEqual(sync.decideBootstrap(input), {
      mode: "choose",
      localHistoryCount: input.localHistoryCount,
      remoteHistoryCount: input.remoteHistoryCount
    });
  }
});

test("bootstrap preflight counts unique completed timers and ignores terminal non-completions", () => {
  const completed = history("completed");
  const duplicate = structuredClone(completed);
  const cancelled = {
    ...history("cancelled"),
    status: "cancelled",
    completedAt: undefined,
    endedAt: "2026-07-22T12:20:00Z"
  };
  assert.equal(sync.completedHistoryCount([]), 0);
  assert.equal(sync.completedHistoryCount([completed, duplicate, cancelled]), 1);
  assert.deepEqual(sync.decideBootstrap({
    localHistory: [completed, duplicate, cancelled],
    remoteHistory: [history("remote"), history("remote")]
  }), { mode: "choose", localHistoryCount: 1, remoteHistoryCount: 1 });
});

test("bootstrap gate blocks sync for unknown, pending, persisted, and mismatched owners", () => {
  assert.equal(sync.requiresBootstrapResolution({ blocked: true }), true);
  assert.equal(sync.requiresBootstrapResolution({ persistedGate: true }), true);
  assert.equal(sync.requiresBootstrapResolution({ pending: { payload: {} } }), true);
  assert.equal(sync.requiresBootstrapResolution({ currentUserId: "user-2", localOwnerId: "user-1" }), true);
  assert.equal(sync.requiresBootstrapResolution({ currentUserId: "user-1", localOwnerId: "user-1" }), false);
  assert.equal(sync.canExposeOwnerState({ sessionValidated: false, currentUserId: "user-1", localOwnerId: "user-1" }), false);
  assert.equal(sync.canExposeOwnerState({ sessionValidated: true, currentUserId: "user-2", localOwnerId: "user-1" }), false);
  assert.equal(sync.canExposeOwnerState({ sessionValidated: true, currentUserId: "user-1", localOwnerId: "user-1" }), true);
  assert.equal(sync.pendingMatchesUser({ userId: "user-1" }, "user-1"), true);
  assert.equal(sync.pendingMatchesUser({ userId: "user-1" }, "user-2"), false);
});

test("cached owner can work offline only before session validation with its owned gate", () => {
  assert.equal(sync.canUseCachedOwnerOffline({
    sessionValidated: false,
    cachedUserId: "user-1",
    localOwnerId: "user-1",
    gateOwned: true,
    pending: null
  }), true);
  assert.equal(sync.canUseCachedOwnerOffline({
    sessionValidated: true,
    cachedUserId: "user-1",
    localOwnerId: "user-1",
    gateOwned: true,
    pending: null
  }), false);
  assert.equal(sync.canUseCachedOwnerOffline({
    sessionValidated: false,
    cachedUserId: "user-1",
    localOwnerId: "user-2",
    gateOwned: true,
    pending: null
  }), false);
  assert.equal(sync.canUseCachedOwnerOffline({
    sessionValidated: false,
    cachedUserId: "user-1",
    localOwnerId: "user-1",
    gateOwned: false,
    pending: null
  }), false);
});

test("local-state detection ignores empty defaults and sees queued or projected state", () => {
  const empty = {
    history: [],
    commands: [],
    taskOperations: [],
    durationOperations: [],
    tasks: [],
    timer: { id: null, status: "idle" },
    durationsMs: defaults,
    defaultDurationsMs: defaults
  };
  assert.equal(sync.hasLocalState(empty), false);
  assert.equal(sync.hasLocalState({ ...empty, taskOperations: [taskOperation("op-1", "task-1", "Local")] }), true);
  assert.equal(sync.hasLocalState({ ...empty, durationsMs: { ...defaults, focus: 1_800_000 } }), true);
  assert.equal(sync.hasLocalState({ ...empty, history: [{ ...history("cancelled"), status: "cancelled" }] }), true);
  assert.equal(sync.hasLocalState({ ...empty, autoStartBreaks: true }), true);
  assert.equal(sync.hasLocalState({ ...empty, selectedTaskId: "task-local" }), true);
  assert.equal(sync.hasLocalState({ ...empty, selectedTaskOperations: [selectedTaskOperation("selected-local", null)] }), true);
});

test("remote-state detection covers every synchronized canonical domain", () => {
  const empty = {
    canonicalTimer: null,
    history: [],
    tasks: [],
    durationsMs: defaults,
    defaultDurationsMs: defaults,
    autoStartBreaks: false
  };
  assert.equal(sync.hasRemoteState(empty), false);
  for (const remote of [
    { ...empty, canonicalTimer: { id: "timer-remote" } },
    { ...empty, history: [{ ...history("cancelled"), status: "cancelled" }] },
    { ...empty, tasks: [{ id: "task-remote", title: "Remote" }] },
    { ...empty, durationsMs: { ...defaults, short_break: 600_000 } },
    { ...empty, autoStartBreaks: true },
    { ...empty, selectedTaskId: "task-remote" }
  ]) {
    assert.equal(sync.hasRemoteState(remote), true);
  }
});

test("bootstrap state matrix never silently discards one-sided completed history conflicts", () => {
  const cases = [
    { localHistory: [], remoteHistory: [], hasLocalState: false, hasRemoteState: false, mode: "auto", strategy: "keep_remote" },
    { localHistory: [], remoteHistory: [], hasLocalState: true, hasRemoteState: false, mode: "auto", strategy: "merge" },
    { localHistory: [], remoteHistory: [], hasLocalState: true, hasRemoteState: true, mode: "auto", strategy: "merge" },
    { localHistory: [history("local")], remoteHistory: [], hasLocalState: true, hasRemoteState: false, mode: "auto", strategy: "replace_remote" },
    { localHistory: [], remoteHistory: [history("remote")], hasLocalState: false, hasRemoteState: true, mode: "auto", strategy: "keep_remote" },
    { localHistory: [history("local")], remoteHistory: [], hasLocalState: true, hasRemoteState: true, mode: "choose" },
    { localHistory: [], remoteHistory: [history("remote")], hasLocalState: true, hasRemoteState: true, mode: "choose" }
  ];
  for (const item of cases) {
    const decision = sync.decideBootstrap(item);
    assert.equal(decision.mode, item.mode);
    if (item.strategy) assert.equal(decision.strategy, item.strategy);
  }
});

test("chooser strategies require confirmation and expose destructive or merge warning copy", () => {
  for (const strategy of ["replace_remote", "keep_remote", "merge"]) {
    assert.equal(sync.canSubmitResolution("choose", false), false);
    assert.equal(sync.canSubmitResolution("choose", true), true);
    assert.ok(sync.confirmationFor(strategy).confirmLabel);
  }
  assert.equal(sync.canSubmitResolution("auto", false), true);
  assert.match(sync.confirmationFor("replace_remote").message, /replaced by this device/i);
  assert.match(sync.confirmationFor("keep_remote").message, /replaced by account data/i);
  assert.match(sync.confirmationFor("merge").message, /conflicts or rejected changes/i);
});

test("chooser dialog stays modal and busy while confirmed choice submits", () => {
  assert.deepEqual(sync.bootstrapDialogView({
    planMode: "choose",
    strategy: "merge",
    pending: { payload: {} },
    submitting: true,
    blocked: true,
    authenticated: true
  }), {
    open: true,
    choosing: false,
    confirming: true,
    failed: false,
    busy: true
  });
});

test("pending resolution preserves exact retry payload and separate discard identities", () => {
  const input = {
    userId: "user-1",
    requestId: "request-1",
    deviceId: "device-1",
    expectedRevision: 4,
    strategy: "keep_remote",
    commands: [command("command-1")],
    taskOperations: [taskOperation("task-op-1", "task-1", "One")],
    durationOperations: [durationOperation("duration-op-1")],
    autoStartOperations: [autoStartOperation("auto-start-op-1", true)],
    selectedTaskOperations: [selectedTaskOperation("selected-task-op-1", "task-1")]
  };
  const first = sync.createPendingResolution(input);
  const retry = sync.createPendingResolution(input);

  assert.equal(JSON.stringify(first), JSON.stringify(retry));
  assert.deepEqual(first.payload.commands, []);
  assert.deepEqual(first.payload.taskOperations, []);
  assert.deepEqual(first.payload.durationOperations, []);
  assert.deepEqual(first.payload.autoStartOperations, []);
  assert.deepEqual(first.queueIds, {
    commands: ["command-1"],
    taskOperations: ["task-op-1"],
    durationOperations: ["duration-op-1"],
    autoStartOperations: ["auto-start-op-1"],
    selectedTaskOperations: ["selected-task-op-1"]
  });
  assert.ok(Array.isArray(first.payload.commands));
  assert.ok(Array.isArray(first.payload.taskOperations));
  assert.ok(Array.isArray(first.payload.durationOperations));
  assert.ok(Array.isArray(first.payload.autoStartOperations));
  assert.ok(Array.isArray(first.payload.selectedTaskOperations));
});

test("bootstrap submission requires current owner and defined strategy", () => {
  const pending = sync.createPendingResolution({
    userId: "user-1",
    requestId: "request-1",
    deviceId: "device-1",
    expectedRevision: 1,
    strategy: "merge",
    commands: [],
    taskOperations: [],
    durationOperations: []
  });
  assert.equal(sync.pendingResolutionCanSubmit(pending, "user-1"), true);
  assert.equal(sync.pendingResolutionCanSubmit(pending, "user-2"), false);
  assert.equal(sync.pendingResolutionCanSubmit({ ...pending, payload: { ...pending.payload, strategy: undefined } }, "user-1"), false);
  assert.equal(sync.isResolutionStrategy(undefined), false);
});

test("bootstrap resolution limit accepts 4096 and rejects 4097 for every collection", () => {
  const fields = ["commands", "taskOperations", "durationOperations", "autoStartOperations", "selectedTaskOperations"];
  for (const field of fields) {
    const exact = { commands: [], taskOperations: [], durationOperations: [], autoStartOperations: [] };
    exact[field] = new Array(4096);
    assert.equal(sync.resolutionLimitViolation(exact), null);

    const overflow = { commands: [], taskOperations: [], durationOperations: [], autoStartOperations: [] };
    overflow[field] = new Array(4097);
    assert.deepEqual(sync.resolutionLimitViolation(overflow), { field, count: 4097, limit: 4096 });
  }

  const queued = new Array(4097).fill(null).map((_, index) => ({ id: `command-${index}` }));
  const discard = sync.createPendingResolution({
    userId: "user-1",
    requestId: "request-1",
    deviceId: "device-1",
    expectedRevision: 1,
    strategy: "keep_remote",
    commands: queued,
    taskOperations: [],
    durationOperations: []
  });
  assert.equal(sync.resolutionLimitViolation(discard.payload), null);
  assert.equal(discard.payload.commands.length, 0);
  assert.equal(discard.queueIds.commands.length, 4097);
});

test("resolution application follows canonical remote, local replacement, and merge snapshots", () => {
  const localCommand = command("local-command");
  const localTask = taskOperation("local-task-op", "local-task", "Local task");
  const localDuration = durationOperation("local-duration");
  const local = {
    commands: [localCommand],
    taskOperations: [localTask],
    durationOperations: [localDuration],
    baseTimer: null,
    baseHistory: [],
    baseTasks: [],
    baseDurationsMs: defaults,
    revision: 0
  };
  const common = {
    userId: "user-1",
    requestId: "request-1",
    deviceId: "device-1",
    expectedRevision: 1,
    commands: local.commands,
    taskOperations: local.taskOperations,
    durationOperations: local.durationOperations
  };

  const keep = sync.createPendingResolution({ ...common, strategy: "keep_remote" });
  const kept = sync.applyResolutionState(local, responseFor(keep.payload, {
    history: [history("remote")],
    tasks: [{ id: "remote-task", title: "Remote task" }]
  }), keep);
  assert.deepEqual(kept.pending, []);
  assert.deepEqual(kept.baseHistory, [history("remote")]);
  assert.deepEqual(kept.tasks, [{ id: "remote-task", title: "Remote task" }]);

  for (const strategy of ["replace_remote", "merge"]) {
    const pending = sync.createPendingResolution({ ...common, requestId: `request-${strategy}`, strategy });
    assert.deepEqual(pending.payload.commands, local.commands);
    assert.deepEqual(pending.payload.taskOperations, local.taskOperations);
    assert.equal(Object.hasOwn(pending.payload.durationOperations[0], "ownerId"), false);
    const canonicalHistory = strategy === "merge"
      ? [history("remote"), history("local")]
      : [history("local")];
    const applied = sync.applyResolutionState(local, responseFor(pending.payload, {
      history: canonicalHistory,
      tasks: [{ id: "local-task", title: "Local task" }]
    }), pending);
    assert.deepEqual(applied.pendingTaskOperations, []);
    assert.deepEqual(applied.baseHistory, canonicalHistory);
    assert.deepEqual(applied.tasks, [{ id: "local-task", title: "Local task" }]);
  }
});

test("invalid acknowledgement set throws without changing local queues", () => {
  const sent = {
    commands: [command("command-1")],
    taskOperations: [taskOperation("task-op-1", "task-1", "One")],
    durationOperations: [durationOperation("duration-op-1")]
  };
  const local = {
    commands: [...sent.commands],
    taskOperations: [...sent.taskOperations],
    durationOperations: [...sent.durationOperations],
    baseTasks: [],
    baseHistory: [],
    baseDurationsMs: defaults,
    revision: 0
  };
  const before = structuredClone(local);
  const response = responseFor(sent);
  response.taskAcknowledgements = [];

  assert.throws(() => sync.rebaseSyncState(local, response, sent), /invalid taskAcknowledgements set/);
  assert.deepEqual(local, before);
});

test("canonical bootstrap response requires every projection and server clock field", () => {
  const sent = { commands: [], taskOperations: [], durationOperations: [] };
  const valid = responseFor(sent, {
    canonicalTimer: {
      id: "timer-1",
      phase: "focus",
      status: "paused",
      plannedDurationMs: 1_500_000,
      elapsedAtAnchorMs: 60_000,
      anchorAt: "2026-07-22T12:01:00Z",
      startedByDeviceId: "device-1"
    },
    history: [history("history-1")],
    tasks: [{ id: "task-1", title: "One" }]
  });
  assert.doesNotThrow(() => sync.validateCanonicalResponse(valid, sent));

  const invalidOrigin = structuredClone(valid);
  invalidOrigin.canonicalTimer.startedByDeviceId = "short";
  assert.throws(() => sync.validateCanonicalResponse(invalidOrigin, sent), /canonicalTimer/);

  for (const field of ["revision", "canonicalTimer", "history", "tasks", "durationsMs", "autoStartBreaks", "selectedTaskId", "serverTime", "serverHlcWallMs", "serverHlcCounter"]) {
    const invalid = structuredClone(valid);
    delete invalid[field];
    assert.throws(() => sync.validateCanonicalResponse(invalid, sent), /Bootstrap response/);
  }
});

test("canonical response requires RFC3339 and status-specific history timestamps", () => {
  const sent = { commands: [], taskOperations: [], durationOperations: [] };
  const valid = responseFor(sent, { history: [history("completed")] });
  assert.doesNotThrow(() => sync.validateCanonicalResponse(valid, sent));

  for (const serverTime of ["2026-07-22 12:30:00Z", "2026-02-30T12:30:00Z", "2026-07-22T12:30:60Z", "Wed, 22 Jul 2026 12:30:00 GMT"]) {
    assert.throws(
      () => sync.validateCanonicalResponse({ ...valid, serverTime }, sent),
      /serverTime/
    );
  }

  const missingCompletedAt = structuredClone(valid);
  delete missingCompletedAt.history[0].completedAt;
  assert.throws(() => sync.validateCanonicalResponse(missingCompletedAt, sent), /invalid history/);

  const cancelledWithoutEnd = structuredClone(valid);
  cancelledWithoutEnd.history[0].status = "cancelled";
  delete cancelledWithoutEnd.history[0].completedAt;
  assert.throws(() => sync.validateCanonicalResponse(cancelledWithoutEnd, sent), /invalid history/);

  const malformedCompletedAt = structuredClone(valid);
  malformedCompletedAt.history[0].completedAt = "2026-07-22";
  assert.throws(() => sync.validateCanonicalResponse(malformedCompletedAt, sent), /invalid history/);

  const malformedAnchor = structuredClone(valid);
  malformedAnchor.canonicalTimer = {
    id: "timer-1",
    phase: "focus",
    status: "paused",
    plannedDurationMs: 1_500_000,
    elapsedAtAnchorMs: 60_000,
    anchorAt: "2026-07-22 12:01:00Z"
  };
  assert.throws(() => sync.validateCanonicalResponse(malformedAnchor, sent), /canonicalTimer/);
});

test("canonical response rejects duplicate history identities", () => {
  const sent = { commands: [], taskOperations: [], durationOperations: [] };
  const duplicateId = responseFor(sent, { history: [history("one"), history("two")] });
  duplicateId.history[1].id = duplicateId.history[0].id;
  assert.throws(() => sync.validateCanonicalResponse(duplicateId, sent), /invalid history/);

  const duplicateTimer = responseFor(sent, { history: [history("one"), history("two")] });
  duplicateTimer.history[1].timerId = duplicateTimer.history[0].timerId;
  assert.throws(() => sync.validateCanonicalResponse(duplicateTimer, sent), /invalid history/);
});

test("server time validation accepts offsets and fractions without ordering snapshots", () => {
  assert.equal(sync.validDateTime("2026-07-22T12:30:00Z"), true);
  assert.equal(sync.validDateTime("2026-07-22T14:30:00+02:00"), true);
  assert.equal(sync.validDateTime("2026-07-22T12:30:00.000000002Z"), true);
  assert.equal(sync.validDateTime("2026-02-30T12:30:00Z"), false);
});

test("canonical server HLC is bounded by trusted server time", () => {
  const sent = { commands: [], taskOperations: [], durationOperations: [] };
  const serverTime = "2026-07-22T12:30:00Z";
  const wallMs = Date.parse(serverTime);
  assert.doesNotThrow(() => sync.validateCanonicalResponse(responseFor(sent, { serverTime, serverHlcWallMs: wallMs }), sent));
  assert.doesNotThrow(() => sync.validateCanonicalResponse(responseFor(sent, { serverTime, serverHlcWallMs: wallMs + 300_000 }), sent));
  assert.throws(() => sync.validateCanonicalResponse(responseFor(sent, { serverTime, serverHlcWallMs: wallMs - 1 }), sent), /inconsistent/);
  assert.throws(() => sync.validateCanonicalResponse(responseFor(sent, { serverTime, serverHlcWallMs: wallMs + 300_001 }), sent), /inconsistent/);
});

test("server clock offset uses response midpoint and trusted now survives one-hour device skew", () => {
  const serverTime = "2026-07-22T12:30:00Z";
  const serverTimeMs = Date.parse(serverTime);
  const fastLocal = serverTimeMs + 3_600_000;
  const slowLocal = serverTimeMs - 3_600_000;
  const fast = sync.serverClockOffset(serverTime, fastLocal, fastLocal + 100, 1);
  const slow = sync.serverClockOffset(serverTime, slowLocal, slowLocal + 100, 2);

  assert.deepEqual(fast, {
    offsetMs: -3_600_050, uncertaintyMs: 50, sampledAtWallMs: fastLocal + 50,
    requestSequence: 1, receivedAtWallMs: fastLocal + 100
  });
  assert.deepEqual(slow, {
    offsetMs: 3_599_950, uncertaintyMs: 50, sampledAtWallMs: slowLocal + 50,
    requestSequence: 2, receivedAtWallMs: slowLocal + 100
  });
  assert.equal(sync.trustedNow(fastLocal + 1_000, fast), serverTimeMs + 950);
  assert.equal(sync.trustedNow(slowLocal + 1_000, slow), serverTimeMs + 950);
  assert.equal(sync.trustedNow(fastLocal - 7_200_000, fast, serverTimeMs + 2_000), serverTimeMs + 2_000);
  assert.throws(() => sync.serverClockOffset(serverTime, fastLocal + 1, fastLocal, 3), /timing/);
});

test("trusted clock rejects high uncertainty and invalid persisted tuples", () => {
  const serverTime = "2026-07-22T12:30:00Z";
  const localTime = Date.parse(serverTime) + 3_600_000;
  assert.doesNotThrow(() => sync.serverClockOffset(serverTime, localTime, localTime + 60_000, 1));
  assert.throws(() => sync.serverClockOffset(serverTime, localTime, localTime + 60_001, 2), /uncertainty/);
  for (const sample of [
    { offsetMs: 0, uncertaintyMs: 30_001, sampledAtWallMs: localTime, requestSequence: 1, receivedAtWallMs: localTime },
    { offsetMs: 0, uncertaintyMs: 0, sampledAtWallMs: 0, requestSequence: 1, receivedAtWallMs: localTime },
    { offsetMs: Number.MAX_SAFE_INTEGER, uncertaintyMs: 0, sampledAtWallMs: localTime, requestSequence: 1, receivedAtWallMs: localTime },
    { offsetMs: 0, uncertaintyMs: 0, sampledAtWallMs: localTime, requestSequence: 0, receivedAtWallMs: localTime },
    { offsetMs: 0, uncertaintyMs: 0, sampledAtWallMs: localTime, requestSequence: 1, receivedAtWallMs: localTime - 1 }
  ]) {
    assert.equal(sync.validClockSample(sample), false);
    assert.throws(() => sync.trustedNow(localTime, sample), /outside/);
  }
  assert.equal(sync.trustedNow(localTime, null), localTime);
});

test("legacy duration wire migration always uses Unix epoch sentinel", () => {
  const migrated = sync.durationRequestOperation({
    id: "duration-legacy", phase: "focus", durationMs: 1_800_000,
    occurredAt: "2026-07-22T12:30:00Z", hlcWallMs: 0, hlcCounter: 0
  });
  assert.equal(migrated.occurredAt, "1970-01-01T00:00:00.000Z");
});

test("timer batches order by HLC, device, and command ID, never device sequence", () => {
  const laterSequenceEarlierHlc = { ...command("command-a", 99), hlcWallMs: 100 };
  laterSequenceEarlierHlc.deviceId = "device-1";
  const earlierSequenceLaterHlc = { ...command("command-b", 1), deviceId: "device-1", hlcWallMs: 200 };
  const tied = { ...command("command-c", 50), deviceId: "device-2", hlcWallMs: 200 };
  const sameDeviceIdTie = { ...command("command-c", 50), deviceId: "device-1", hlcWallMs: 200 };
  assert.deepEqual(
    sync.sendableTimerCommands([tied, sameDeviceIdTie, earlierSequenceLaterHlc, laterSequenceEarlierHlc], 4).map((item) => item.id),
    ["command-a", "command-b", "command-c", "command-c"]
  );
  assert.deepEqual(
    [tied, sameDeviceIdTie, earlierSequenceLaterHlc, laterSequenceEarlierHlc].sort(sync.compareTimerCommands).map((item) => `${item.deviceId}:${item.id}`),
    ["device-1:command-a", "device-1:command-b", "device-1:command-c", "device-2:command-c"]
  );
  assert.deepEqual(
    sync.sendableTimerCommands([tied, earlierSequenceLaterHlc, laterSequenceEarlierHlc], 3).map((item) => item.id),
    ["command-a", "command-b", "command-c"]
  );
});

test("timer comparator is transitive with missing legacy device IDs", () => {
  const commands = [
    { ...command("command-z", 3), deviceId: "device-z", hlcWallMs: 100 },
    { ...command("command-m", 2), hlcWallMs: 100 },
    { ...command("command-a", 1), deviceId: "device-a", hlcWallMs: 100 },
    { ...command("command-invalid", 4), deviceId: "device-b", hlcWallMs: undefined, hlcCounter: Number.NaN }
  ];
  const expected = ["command-invalid", "command-m", "command-a", "command-z"];
  for (const order of permutations(commands)) {
    assert.deepEqual([...order].sort(sync.compareTimerCommands).map((item) => item.id), expected);
  }
  for (const left of commands) {
    for (const right of commands) {
      const forward = Math.sign(sync.compareTimerCommands(left, right));
      const reverse = Math.sign(sync.compareTimerCommands(right, left));
      assert.equal(forward === 0 && reverse === 0 || forward === -reverse, true);
    }
  }
});

test("403 refresh retries exact JSON body once and never loops", async () => {
  const events = [];
  const responses = [{ status: 403 }, { status: 403 }];
  const body = JSON.stringify({ requestId: "request-1", commands: [] });
  let sequence = 0;
  let timing;
  const response = await sync.postJSONWithCsrfRetry({
    fetcher: async (url, options) => {
      events.push({ type: "fetch", url, options: structuredClone(options) });
      return responses.shift();
    },
    url: "/api/v1/bootstrap/resolve",
    body,
    csrfToken: "old-token",
    nextRequestSequence: async () => sequence += 1,
    onTiming: (value) => { timing = value; },
    refreshCsrf: async () => {
      events.push({ type: "refresh" });
      return "new-token";
    }
  });

  assert.equal(response.status, 403);
  assert.deepEqual(events.map((event) => event.type), ["fetch", "refresh", "fetch"]);
  assert.equal(events[0].options.body, body);
  assert.equal(events[2].options.body, body);
  assert.equal(events[0].options.headers["X-CSRF-Token"], "old-token");
  assert.equal(events[2].options.headers["X-CSRF-Token"], "new-token");
  assert.equal(timing.requestSequence, 2);
});

test("CSRF retry invokes injected fetcher without binding it to input", async () => {
  const fetcher = async function () {
    assert.equal(this, undefined);
    return { status: 200 };
  };

  const response = await sync.postJSONWithCsrfRetry({
    fetcher,
    url: "/api/v1/sync",
    body: "{}",
    csrfToken: "token",
    nextRequestSequence: async () => 1,
    refreshCsrf: async () => "unused"
  });

  assert.equal(response.status, 200);
});

test("sync batching, task acknowledgements, and optimistic task rebase preserve later operations", () => {
  const commands = Array.from({ length: 300 }, (_, index) => command(`command-${index}`, index + 1));
  const sentTask = taskOperation("task-op-sent", "task-sent", "Sent", 1);
  const laterTask = taskOperation("task-op-later", "task-later", "Later", 2);
  const durations = Array.from({ length: 300 }, (_, index) => durationOperation(`duration-${index}`, index + 1));
  const batch = sync.buildSyncBatch({ commands, taskOperations: [sentTask], durationOperations: durations });

  assert.equal(batch.commands.length, 256);
  assert.equal(batch.durationOperations.length, 256);
  assert.equal(Object.hasOwn(batch.durationOperations[0], "ownerId"), false);
  const response = responseFor(batch, { tasks: [{ id: "task-sent", title: "Sent" }] });
  const local = {
    commands,
    taskOperations: [sentTask, laterTask],
    durationOperations: durations,
    baseTasks: [],
    baseHistory: [],
    baseDurationsMs: defaults,
    revision: 0
  };
  const rebased = sync.rebaseSyncState(local, response, batch);

  assert.equal(rebased.pending.length, 44);
  assert.deepEqual(rebased.pendingTaskOperations, [laterTask]);
  assert.deepEqual(rebased.tasks, [
    { id: "task-later", title: "Later" },
    { id: "task-sent", title: "Sent" }
  ]);
  assert.equal(rebased.pendingDurationOperations.length, 44);
});

test("sync batching covers protocol boundaries and multiple batches for every queue", () => {
  const cases = new Map([
    [1, [1]],
    [255, [255]],
    [256, [256]],
    [257, [256, 1]],
    [513, [256, 256, 1]]
  ]);
  const factories = {
    commands: (index) => command(`batch-command-${index}`, index + 1),
    taskOperations: (index) =>
      taskOperation(`batch-task-operation-${index}`, `batch-task-${index}`, `Task ${index}`, index + 1),
    durationOperations: (index) => durationOperation(`batch-duration-${index}`, index + 1),
    autoStartOperations: (index) =>
      autoStartOperation(`batch-auto-start-${index}`, index % 2 === 0, index + 1),
    selectedTaskOperations: (index) =>
      selectedTaskOperation(`batch-selected-task-${index}`, index % 2 === 0 ? `task-${index}` : null, index + 1)
  };

  for (const [field, factory] of Object.entries(factories)) {
    for (const [operationCount, expectedBatchSizes] of cases) {
      let pending = Array.from({ length: operationCount }, (_, index) => factory(index));
      const batchSizes = [];
      while (pending.length) {
        const batch = sync.buildSyncBatch({ [field]: pending });
        batchSizes.push(batch[field].length);
        pending = pending.slice(batch[field].length);
      }
      assert.deepEqual(batchSizes, expectedBatchSizes, `${field} count ${operationCount}`);
    }
  }
});

test("rebase removes every acknowledged outcome while preserving unsent mixed work", () => {
  const sent = {
    commands: [command("sent-command")],
    taskOperations: [taskOperation("sent-task", "task-sent", "Sent")],
    durationOperations: [durationOperation("sent-duration")]
  };
  const later = {
    commands: [command("later-command", 2)],
    taskOperations: [taskOperation("later-task", "task-later", "Later", 2)],
    durationOperations: [durationOperation("later-duration", 2)]
  };
  const response = responseFor(sent, { tasks: [] });
  response.acknowledgements[0].outcome = "rejected";
  response.acknowledgements[0].reason = "conflict";
  response.taskAcknowledgements[0].outcome = "ignored";
  response.taskAcknowledgements[0].reason = "superseded";
  const rebased = sync.rebaseSyncState({
    commands: sent.commands.concat(later.commands),
    taskOperations: sent.taskOperations.concat(later.taskOperations),
    durationOperations: sent.durationOperations.concat(later.durationOperations),
    baseTasks: [],
    baseHistory: [],
    baseDurationsMs: defaults,
    revision: 8
  }, response, sent);

  assert.deepEqual(rebased.pending, later.commands);
  assert.deepEqual(rebased.pendingTaskOperations, later.taskOperations);
  assert.deepEqual(rebased.pendingDurationOperations, later.durationOperations);
  assert.deepEqual(rebased.tasks, [{ id: "task-later", title: "Later" }]);
});

test("auto-start true and false operations use exact wire shape and 256-item batches", () => {
  const operations = Array.from({ length: 257 }, (_, index) =>
    autoStartOperation(`auto-start-${index}`, index % 2 === 0, index + 1)
  );
  operations[0].ownerId = "local-only";
  operations[0].deviceId = "top-level-device-only";

  const first = sync.buildSyncBatch({ autoStartOperations: operations });
  const second = sync.buildSyncBatch({ autoStartOperations: operations.slice(256) });

  assert.equal(first.autoStartOperations.length, 256);
  assert.equal(second.autoStartOperations.length, 1);
  assert.equal(first.autoStartOperations[0].enabled, true);
  assert.equal(first.autoStartOperations[1].enabled, false);
  assert.deepEqual(Object.keys(first.autoStartOperations[0]), [
    "id", "enabled", "occurredAt", "hlcWallMs", "hlcCounter"
  ]);
});

test("auto-start acknowledgements reject missing extra duplicate and malformed sets without mutation", () => {
  const operation = autoStartOperation("auto-start-sent", true);
  const sent = { commands: [], taskOperations: [], durationOperations: [], autoStartOperations: [operation] };
  const local = {
    commands: [], taskOperations: [], durationOperations: [], autoStartOperations: [operation],
    baseTasks: [], baseHistory: [], baseDurationsMs: defaults, baseAutoStartBreaks: false, revision: 0
  };
  const invalidSets = [
    undefined,
    [],
    [
      { operationId: operation.id, outcome: "applied", reason: "" },
      { operationId: "auto-start-extra", outcome: "applied", reason: "" }
    ],
    [
      { operationId: operation.id, outcome: "applied", reason: "" },
      { operationId: operation.id, outcome: "applied", reason: "" }
    ],
    [{ operationId: operation.id, outcome: "unknown", reason: "" }],
    [{ operationId: operation.id, outcome: "applied" }]
  ];

  for (const acknowledgements of invalidSets) {
    const response = responseFor(sent);
    if (acknowledgements === undefined) delete response.autoStartAcknowledgements;
    else response.autoStartAcknowledgements = acknowledgements;
    const before = structuredClone(local);
    assert.throws(() => sync.rebaseSyncState(local, response, sent), /autoStartAcknowledgements/);
    assert.deepEqual(local, before);
  }
});

test("canonical auto-start converges remotely while newer in-flight local intent stays projected", () => {
  const sentOperation = autoStartOperation("auto-start-sent", true, 1);
  const newerOperation = autoStartOperation("auto-start-newer", false, 2);
  const sent = { commands: [], taskOperations: [], durationOperations: [], autoStartOperations: [sentOperation] };
  const response = responseFor(sent, { autoStartBreaks: true });
  const rebased = sync.rebaseSyncState({
    commands: [],
    taskOperations: [],
    durationOperations: [],
    autoStartOperations: [sentOperation, newerOperation],
    baseTasks: [],
    baseHistory: [],
    baseDurationsMs: defaults,
    baseAutoStartBreaks: false,
    revision: 0
  }, response, sent);

  assert.equal(rebased.baseAutoStartBreaks, true);
  assert.equal(rebased.autoStartBreaks, false);
  assert.deepEqual(rebased.pendingAutoStartOperations, [newerOperation]);

  const empty = { commands: [], taskOperations: [], durationOperations: [], autoStartOperations: [] };
  const remoteOnly = sync.rebaseSyncState({
    ...empty,
    baseTasks: [],
    baseHistory: [],
    baseDurationsMs: defaults,
    baseAutoStartBreaks: false,
    revision: 0
  }, responseFor(empty, { autoStartBreaks: true }), empty);
  assert.equal(remoteOnly.autoStartBreaks, true);
});

test("selected-task operations preserve nullable wire shape and LWW projection", () => {
  const operations = Array.from({ length: 257 }, (_, index) =>
    selectedTaskOperation(`selected-task-${index}`, index % 2 === 0 ? `task-${index}` : null, index + 1)
  );
  operations[0].ownerId = "local-only";
  operations[0].deviceId = "local-device";

  const first = sync.buildSyncBatch({ selectedTaskOperations: operations });
  const second = sync.buildSyncBatch({ selectedTaskOperations: operations.slice(256) });

  assert.equal(first.selectedTaskOperations.length, 256);
  assert.equal(second.selectedTaskOperations.length, 1);
  assert.deepEqual(Object.keys(first.selectedTaskOperations[0]), [
    "id", "taskId", "occurredAt", "hlcWallMs", "hlcCounter"
  ]);
  assert.equal(first.selectedTaskOperations[1].taskId, null);
  for (const order of permutations([
    selectedTaskOperation("selected-old", "task-old", 1),
    selectedTaskOperation("selected-new", null, 2)
  ])) {
    assert.equal(sync.applySelectedTaskOperations("task-base", order), null);
  }
});

test("canonical selected task installs before newer pending operation reprojects", () => {
  const sentOperation = selectedTaskOperation("selected-sent", "task-sent", 1);
  const newerOperation = selectedTaskOperation("selected-newer", "task-newer", 2);
  const sent = {
    commands: [], taskOperations: [], durationOperations: [], autoStartOperations: [],
    selectedTaskOperations: [sentOperation]
  };
  const rebased = sync.rebaseSyncState({
    commands: [],
    taskOperations: [],
    durationOperations: [],
    autoStartOperations: [],
    selectedTaskOperations: [sentOperation, newerOperation],
    baseTasks: [],
    baseHistory: [],
    baseDurationsMs: defaults,
    baseAutoStartBreaks: false,
    baseSelectedTaskId: "task-base",
    revision: 0
  }, responseFor(sent, { selectedTaskId: "task-sent" }), sent);

  assert.equal(rebased.baseSelectedTaskId, "task-sent");
  assert.equal(rebased.selectedTaskId, "task-newer");
  assert.deepEqual(rebased.pendingSelectedTaskOperations, [newerOperation]);
});

test("selected-task acknowledgements require exact operation set without mutation", () => {
  const operation = selectedTaskOperation("selected-sent", null);
  const sent = {
    commands: [], taskOperations: [], durationOperations: [], autoStartOperations: [],
    selectedTaskOperations: [operation]
  };
  const local = {
    ...sent,
    baseTasks: [], baseHistory: [], baseDurationsMs: defaults,
    baseAutoStartBreaks: false, baseSelectedTaskId: "task-old", revision: 0
  };
  for (const acknowledgements of [
    undefined,
    [],
    [{ operationId: "selected-extra", outcome: "applied", reason: "" }],
    [
      { operationId: operation.id, outcome: "applied", reason: "" },
      { operationId: operation.id, outcome: "applied", reason: "" }
    ],
    [{ operationId: operation.id, outcome: "unknown", reason: "" }],
    [{ operationId: operation.id, outcome: "applied" }]
  ]) {
    const response = responseFor(sent);
    if (acknowledgements === undefined) delete response.selectedTaskAcknowledgements;
    else response.selectedTaskAcknowledgements = acknowledgements;
    const before = structuredClone(local);
    assert.throws(() => sync.rebaseSyncState(local, response, sent), /selectedTaskAcknowledgements/);
    assert.deepEqual(local, before);
  }
});

test("bootstrap selected-task operations discard on keep and upload on replace or merge", () => {
  const operation = selectedTaskOperation("selected-local", null, 7);
  const input = {
    userId: "user-1",
    requestId: "request-selected-task",
    deviceId: "device-1",
    expectedRevision: 3,
    commands: [],
    taskOperations: [],
    durationOperations: [],
    autoStartOperations: [],
    selectedTaskOperations: [operation]
  };

  for (const strategy of ["replace_remote", "merge"]) {
    const pending = sync.createPendingResolution({ ...input, strategy });
    assert.deepEqual(pending.payload.selectedTaskOperations, [operation]);
    assert.deepEqual(pending.queueIds.selectedTaskOperations, [operation.id]);
  }
  const keep = sync.createPendingResolution({ ...input, strategy: "keep_remote" });
  assert.deepEqual(keep.payload.selectedTaskOperations, []);
  assert.deepEqual(keep.queueIds.selectedTaskOperations, [operation.id]);
});

test("bootstrap auto-start preserves absent, explicit-empty, and exact saved payload semantics", () => {
  const operation = autoStartOperation("auto-start-local", true, 7);
  const input = {
    userId: "user-1",
    requestId: "request-auto-start",
    deviceId: "device-1",
    expectedRevision: 3,
    strategy: "replace_remote",
    commands: [],
    taskOperations: [],
    durationOperations: [],
    autoStartOperations: [operation]
  };
  const pending = sync.createPendingResolution(input);

  assert.equal(Object.hasOwn(pending.payload, "autoStartOperations"), true);
  assert.deepEqual(pending.payload.autoStartOperations, [operation]);
  assert.equal(JSON.stringify(sync.createPendingResolution(input).payload), JSON.stringify(pending.payload));

  const explicitDefault = sync.buildResolutionPayload({ ...input, autoStartOperations: [] });
  const keepRemote = sync.buildResolutionPayload({ ...input, strategy: "keep_remote" });
  const omitted = sync.buildResolutionPayload({
    userId: "user-1",
    requestId: "request-auto-start-omitted",
    deviceId: "device-1",
    expectedRevision: 3,
    strategy: "replace_remote",
    commands: [],
    taskOperations: [],
    durationOperations: []
  });
  assert.deepEqual(explicitDefault.autoStartOperations, []);
  assert.deepEqual(keepRemote.autoStartOperations, []);
  assert.equal(Object.hasOwn(omitted, "autoStartOperations"), false);
});

test("legacy bootstrap response accepts null auto-start acknowledgements only for omitted request field", () => {
  const sent = {
    commands: [],
    taskOperations: [],
    durationOperations: []
  };
  const legacyReplay = responseFor(sent);
  legacyReplay.autoStartAcknowledgements = null;
  assert.doesNotThrow(() => sync.validateCanonicalResponse(legacyReplay, sent));

  assert.throws(() => sync.validateCanonicalResponse(legacyReplay, {
    ...sent,
    autoStartOperations: []
  }), /autoStartAcknowledgements/);
});

test("generated break waits for applied finish while later independent start remains local", () => {
  const finish = { ...command("finish-source", 1), type: "finish", timerId: "focus-source" };
  const generated = {
    ...command("generated-break", 2),
    timerId: "break-generated",
    phase: "short_break",
    dependsOnCommandId: finish.id,
    generatedBreak: true
  };
  const independent = { ...command("independent-start", 3), timerId: "independent-timer" };
  const commands = [finish, generated, independent];

  const sent = sync.buildSyncBatch({ commands });
  assert.deepEqual(sent.commands.map((item) => item.id), [finish.id]);
  assert.equal(Object.hasOwn(sent.commands[0], "dependsOnCommandId"), false);
  const resolution = sync.createPendingResolution({
    userId: "user-1",
    requestId: "request-generated-break",
    deviceId: "device-1",
    expectedRevision: 0,
    strategy: "merge",
    commands,
    taskOperations: [],
    durationOperations: []
  });
  assert.deepEqual(resolution.payload.commands.map((item) => item.id), [finish.id]);
  assert.deepEqual(resolution.queueIds.commands, [finish.id]);

  const applied = sync.generatedBreakUpdates(commands, [
    { commandId: finish.id, outcome: "applied", reason: "" }
  ], {
    history: [{
      timerId: finish.timerId,
      commandId: finish.id,
      phase: "focus",
      status: "completed",
      completedAt: "2026-07-22T12:25:00Z"
    }],
    durationsMs: defaults,
    canonicalTimer: null
  });
  assert.deepEqual(applied.promoteCommands.map((item) => item.id), [generated.id]);
  assert.equal(Object.hasOwn(applied.promoteCommands[0], "dependsOnCommandId"), false);
  assert.deepEqual(applied.dropCommandIds, []);

  const ignored = sync.generatedBreakUpdates(commands, [
    { commandId: finish.id, outcome: "ignored", reason: "superseded" }
  ], { canonicalTimer: { id: "remote-newer", status: "running" } });
  assert.deepEqual(ignored, {
    promoteCommands: [],
    dropCommandIds: [generated.id],
    dropTimerIds: [generated.timerId]
  });
  assert.equal(ignored.dropCommandIds.includes(independent.id), false);

  const supersededAfterApply = sync.generatedBreakUpdates(commands, [
    { commandId: finish.id, outcome: "applied", reason: "" }
  ], { canonicalTimer: { id: "remote-newer", status: "running" } });
  assert.deepEqual(supersededAfterApply.dropCommandIds, [generated.id]);
});

test("generated break resolves every dependent command across outcome evidence and phase matrix", () => {
  const chains = [
    ["start"],
    ["start", "pause"],
    ["start", "pause", "resume"],
    ["start", "finish"],
    ["start", "cancel"],
    ["start", "finish", "clear"]
  ];
  for (const outcome of ["applied", "ignored", "rejected"]) {
    for (const exactCompletion of [false, true]) {
      for (const phaseCorrection of [false, true]) {
        for (const types of chains) {
          const suffix = `${outcome}-${exactCompletion}-${phaseCorrection}-${types.join("-")}`;
          const source = {
            ...command(`source-${suffix}`, 1),
            type: "finish",
            timerId: `focus-${suffix}`,
            phase: "focus"
          };
          const dependents = types.map((type, index) => ({
            ...command(`dependent-${index}-${suffix}`, index + 2),
            type,
            timerId: `break-${suffix}`,
            phase: "short_break",
            plannedDurationMs: defaults.short_break,
            observedElapsedMs: index * 1_000,
            dependsOnCommandId: source.id,
            ...(index === 0 ? { generatedBreak: true } : {})
          }));
          const prior = phaseCorrection
            ? [1, 2, 3].map((index) => ({
                ...history(`prior-${index}-${suffix}`),
                commandId: `prior-command-${index}-${suffix}`,
                completedAt: `2026-07-22T12:2${index}:00Z`
              }))
            : [];
          if (phaseCorrection) {
            prior.unshift({
              ...history(`yesterday-${suffix}`),
              commandId: `yesterday-command-${suffix}`,
              completedAt: "2026-07-21T12:00:00Z"
            });
          }
          const evidence = {
            ...history(`completion-${suffix}`),
            timerId: exactCompletion ? source.timerId : `other-${suffix}`,
            commandId: exactCompletion ? source.id : `other-command-${suffix}`,
            completedAt: "2026-07-22T12:25:00Z"
          };
          const result = sync.generatedBreakUpdates(
            [source, ...dependents],
            [{ commandId: source.id, outcome, reason: "" }],
            {
              canonicalTimer: null,
              history: [...prior, evidence],
              durationsMs: defaults
            }
          );
          const releases = exactCompletion && outcome !== "rejected";
          assert.deepEqual(
            result.promoteCommands.map((item) => item.id),
            releases ? dependents.map((item) => item.id) : [],
            suffix
          );
          assert.deepEqual(
            result.dropCommandIds,
            releases ? [] : dependents.map((item) => item.id),
            suffix
          );
          if (releases) {
            const expectedPhase = phaseCorrection && !types.includes("finish")
              ? "long_break"
              : "short_break";
            assert.ok(result.promoteCommands.every((item) =>
              item.phase === expectedPhase
                && item.plannedDurationMs === defaults[expectedPhase]
                && !Object.hasOwn(item, "dependsOnCommandId")
                && !Object.hasOwn(item, "generatedBreak")
            ), suffix);
          }
        }
      }
    }
  }
});
