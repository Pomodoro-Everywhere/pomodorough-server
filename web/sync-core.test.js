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

function responseFor(sent, overrides = {}) {
  return {
    acknowledgements: sent.commands.map((item) => ({ commandId: item.id, outcome: "applied", reason: "" })),
    taskAcknowledgements: sent.taskOperations.map((item) => ({ operationId: item.id, outcome: "applied", reason: "" })),
    durationAcknowledgements: sent.durationOperations.map((item) => ({ operationId: item.id, outcome: "applied", reason: "" })),
    revision: 9,
    canonicalTimer: null,
    history: [],
    tasks: [],
    durationsMs: defaults,
    serverTime: "2026-07-22T12:30:00Z",
    serverHlcWallMs: 1_753_187_400_000,
    serverHlcCounter: 0,
    ...overrides
  };
}

test("bootstrap decision separates ownership and one-sided history", () => {
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
});

test("chooser strategies require confirmation and expose destructive or merge warning copy", () => {
  for (const strategy of ["replace_remote", "keep_remote", "merge"]) {
    assert.equal(sync.canSubmitResolution("choose", false), false);
    assert.equal(sync.canSubmitResolution("choose", true), true);
    assert.ok(sync.confirmationFor(strategy).confirmLabel);
  }
  assert.equal(sync.canSubmitResolution("auto", false), true);
  assert.match(sync.confirmationFor("replace_remote").message, /permanently replaced/i);
  assert.match(sync.confirmationFor("keep_remote").message, /permanently discarded/i);
  assert.match(sync.confirmationFor("merge").message, /conflicts or rejected operations/i);
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
    durationOperations: [durationOperation("duration-op-1")]
  };
  const first = sync.createPendingResolution(input);
  const retry = sync.createPendingResolution(input);

  assert.equal(JSON.stringify(first), JSON.stringify(retry));
  assert.deepEqual(first.payload.commands, []);
  assert.deepEqual(first.payload.taskOperations, []);
  assert.deepEqual(first.payload.durationOperations, []);
  assert.deepEqual(first.queueIds, {
    commands: ["command-1"],
    taskOperations: ["task-op-1"],
    durationOperations: ["duration-op-1"]
  });
  assert.ok(Array.isArray(first.payload.commands));
  assert.ok(Array.isArray(first.payload.taskOperations));
  assert.ok(Array.isArray(first.payload.durationOperations));
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
  const fields = ["commands", "taskOperations", "durationOperations"];
  for (const field of fields) {
    const exact = { commands: [], taskOperations: [], durationOperations: [] };
    exact[field] = new Array(4096);
    assert.equal(sync.resolutionLimitViolation(exact), null);

    const overflow = { commands: [], taskOperations: [], durationOperations: [] };
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
      anchorAt: "2026-07-22T12:01:00Z"
    },
    history: [history("history-1")],
    tasks: [{ id: "task-1", title: "One" }]
  });
  assert.doesNotThrow(() => sync.validateCanonicalResponse(valid, sent));

  for (const field of ["revision", "canonicalTimer", "history", "tasks", "durationsMs", "serverTime", "serverHlcWallMs", "serverHlcCounter"]) {
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

test("server time comparison is strict, offset-aware, and fraction-preserving", () => {
  assert.equal(sync.compareServerTimes("2026-07-22T12:30:00Z", "2026-07-22T14:30:00+02:00"), 0);
  assert.equal(sync.compareServerTimes("2026-07-22T12:30:00.000000002Z", "2026-07-22T12:30:00.000000001Z"), 1);
  assert.equal(sync.compareServerTimes("2026-07-22T12:29:59.9Z", "2026-07-22T12:30:00Z"), -1);
  assert.equal(sync.compareServerTimes("2026-02-30T12:30:00Z", "2026-07-22T12:30:00Z"), null);
});

test("403 refresh retries exact JSON body once and never loops", async () => {
  const events = [];
  const responses = [{ status: 403 }, { status: 403 }];
  const body = JSON.stringify({ requestId: "request-1", commands: [] });
  const response = await sync.postJSONWithCsrfRetry({
    fetcher: async (url, options) => {
      events.push({ type: "fetch", url, options: structuredClone(options) });
      return responses.shift();
    },
    url: "/api/v1/bootstrap/resolve",
    body,
    csrfToken: "old-token",
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
