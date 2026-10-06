"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
require("./test/official-core-fixture.js");
const sync = require("./sync-core.js");
const storage = require("./sync-storage.js");
const workspace = require("./workspace-core.js");

function timerCommand(id, sequence, wall = sequence) {
  return {
    id, deviceSequence: sequence, timerId: `timer-${id}`, type: "start", phase: "focus",
    plannedDurationMs: 1_500_000, occurredAt: "2026-07-22T12:00:00Z",
    hlcWallMs: wall, hlcCounter: 0, observedElapsedMs: 0, deviceId: "device-1"
  };
}

function taskOperation(id, wall) {
  return {
    id, taskId: `task-${id}`, type: "upsert", title: `Title ${id}`,
    occurredAt: "2026-07-22T12:00:00Z", hlcWallMs: wall, hlcCounter: 0, deviceId: "device-1"
  };
}

function durationOperation(id, wall) {
  return {
    id, phase: "focus", durationMs: 1_800_000, occurredAt: "2026-07-22T12:00:00Z",
    hlcWallMs: wall, hlcCounter: 0, deviceId: "device-1"
  };
}

function autoStartOperation(id, wall) {
  return {
    id, enabled: true, occurredAt: "2026-07-22T12:00:00Z",
    hlcWallMs: wall, hlcCounter: 0, deviceId: "device-1"
  };
}

function selectedTaskOperation(id, wall) {
  return {
    id, taskId: null, occurredAt: "2026-07-22T12:00:00Z",
    hlcWallMs: wall, hlcCounter: 0, deviceId: "device-1"
  };
}

function totalCount(batch) {
  return Object.values(batch).flat().length;
}

function payloadCount(payload) {
  return ["commands", "taskOperations", "durationOperations", "autoStartOperations", "selectedTaskOperations"]
    .map((field) => (Array.isArray(payload[field]) ? payload[field].length : 0))
    .reduce((sum, count) => sum + count, 0);
}

test("R43-S03 normal batch accepts exactly 512 mixed operations", () => {
  const commands = Array.from({ length: 256 }, (_, i) => timerCommand(`n512-c-${i}`, i + 1));
  const tasks = Array.from({ length: 256 }, (_, i) => taskOperation(`n512-t-${i}`, i + 1));
  const batch = sync.buildSyncBatch({ commands, taskOperations: tasks, deviceId: "device-1" });
  assert.equal(totalCount(batch), 512);
  assert.equal(batch.commands.length, 256);
  assert.equal(batch.taskOperations.length, 256);
});

test("R43-S03 normal batch caps 513 mixed operations at aggregate 512", () => {
  const commands = Array.from({ length: 256 }, (_, i) => timerCommand(`n513-c-${i}`, i + 1));
  const tasks = Array.from({ length: 256 }, (_, i) => taskOperation(`n513-t-${i}`, i + 1));
  const durations = [durationOperation("n513-d-0", 1)];
  const batch = sync.buildSyncBatch({
    commands, taskOperations: tasks, durationOperations: durations, deviceId: "device-1"
  });
  assert.equal(totalCount(batch), 512);
  for (const items of Object.values(batch)) assert.ok(items.length <= 256);
});

test("R43-S03 bootstrap accepts exactly 8192 operations across domains", () => {
  const commands = Array.from({ length: 4096 }, (_, i) => timerCommand(`b8192-c-${i}`, i + 1, i + 1));
  const tasks = Array.from({ length: 4096 }, (_, i) => taskOperation(`b8192-t-${i}`, i + 1));
  const input = {
    userId: "user-1", requestId: "r43-s03-8192", deviceId: "device-1",
    expectedRevision: 1, strategy: "merge", commands, taskOperations: tasks,
    durationOperations: [], timerDependencies: []
  };
  const pending = sync.createPendingResolution(input);
  assert.equal(payloadCount(pending.payload), 8192);
  assert.equal(sync.resolutionLimitViolation(pending.payload), null);
});

test("R43-S03 bootstrap rejects 8193 operations against aggregate 8192", () => {
  const commands = Array.from({ length: 4096 }, (_, i) => timerCommand(`b8193-c-${i}`, i + 1, i + 1));
  const tasks = Array.from({ length: 4096 }, (_, i) => taskOperation(`b8193-t-${i}`, i + 1));
  const durations = [durationOperation("b8193-d-0", 1)];
  const input = {
    userId: "user-1", requestId: "r43-s03-8193", deviceId: "device-1",
    expectedRevision: 1, strategy: "merge", commands, taskOperations: tasks,
    durationOperations: durations, timerDependencies: []
  };
  assert.throws(() => sync.createPendingResolution(input), /oversized|blocked|exceeds|aggregate/i);
  const oversized = {
    commands: input.commands, taskOperations: input.tasks ?? input.taskOperations,
    durationOperations: durations
  };
  assert.notEqual(sync.resolutionLimitViolation({
    commands: commands.slice(0, 4096), taskOperations: tasks.slice(0, 4096), durationOperations: durations
  }), null);
  assert.ok(oversized.commands.length === 4096);
});

test("R43-S03 starvation-free draining gives every domain a turn", () => {
  const queues = {
    commands: Array.from({ length: 4 }, (_, i) => timerCommand(`drain-c-${i}`, i + 1, i + 1)),
    taskOperations: Array.from({ length: 4 }, (_, i) => taskOperation(`drain-t-${i}`, i + 1)),
    durationOperations: Array.from({ length: 4 }, (_, i) => durationOperation(`drain-d-${i}`, i + 1)),
    autoStartOperations: Array.from({ length: 4 }, (_, i) => autoStartOperation(`drain-a-${i}`, i + 1)),
    selectedTaskOperations: Array.from({ length: 4 }, (_, i) => selectedTaskOperation(`drain-s-${i}`, i + 1)),
    timerDependencies: []
  };
  let cursor = "commands";
  let remaining = { ...queues };
  delete remaining.timerDependencies;
  const seen = new Set();
  let rounds = 0;
  while (totalCount(remaining) > 0 && rounds < 10) {
    const result = storage.selectWorkspaceBatch(
      { ...remaining, timerDependencies: [] }, "device-1", cursor, { perDomain: 1, total: 2 }, "sync");
    assert.ok(totalCount(result.sent) > 0 && totalCount(result.sent) <= 2);
    for (const [domain, items] of Object.entries(result.sent)) {
      assert.ok(items.length <= 1, `${domain} exceeds tiny per-domain budget`);
      for (const item of items) seen.add(`${domain}:${item.id}`);
    }
    remaining = Object.fromEntries(Object.entries(remaining).map(([domain, items]) => {
      const selected = new Set(result.sent[domain].map((item) => item.id));
      return [domain, items.filter((item) => !selected.has(item.id))];
    }));
    cursor = result.plan.nextDomain;
    rounds += 1;
  }
  assert.equal(totalCount(remaining), 0);
  assert.equal(seen.size, 20);
});

test("R43-S03 restart replays exact saved claim via Core", () => {
  const queues = {
    commands: [timerCommand("restart-c-0", 1, 1), timerCommand("restart-c-1", 2, 2)],
    taskOperations: [taskOperation("restart-t-0", 1)],
    durationOperations: [], autoStartOperations: [], selectedTaskOperations: []
  };
  const first = storage.selectWorkspaceBatch(
    { ...queues, timerDependencies: [] }, "device-1", "commands", null, "sync");
  assert.equal(first.plan.status, "planned");
  const savedRequest = workspace.savedBatchRequest(first.sent, "sync");
  const replay = storage.callWorkspaceCore("sync.batchPlan.v1", savedRequest);
  assert.equal(replay.status, "replay_saved");
  assert.deepEqual(replay.selected.commands, first.sent.commands.map((item) => item.id));
  assert.deepEqual(replay.selected.taskOperations, first.sent.taskOperations.map((item) => item.id));
  const oversizedSent = {
    commands: [], taskOperations: [],
    durationOperations: Array.from({ length: 257 }, (_, i) => ({ id: `oversized-${i}` })),
    autoStartOperations: [], selectedTaskOperations: []
  };
  const oversized = storage.callWorkspaceCore("sync.batchPlan.v1",
    workspace.savedBatchRequest(oversizedSent, "sync"));
  assert.equal(oversized.status, "oversized_saved");
  assert.deepEqual(oversized.selected.durationOperations, []);
});
