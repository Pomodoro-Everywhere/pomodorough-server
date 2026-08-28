"use strict";

// Test-only snapshot of removed JavaScript decisions. Never use as an expected-value oracle.
const core = require("../sync-core.js");

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function compareStrings(left, right) {
  const leftValue = String(left || "");
  const rightValue = String(right || "");
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function clockComponent(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : -1;
}

function compareOperations(left, right) {
  return Number(left.hlcWallMs) - Number(right.hlcWallMs)
    || Number(left.hlcCounter) - Number(right.hlcCounter)
    || compareStrings(left.deviceId, right.deviceId)
    || compareStrings(left.id, right.id);
}

function applyAutoStartOperations(baseAutoStartBreaks, operations) {
  const ordered = [...(operations || [])].sort(compareOperations);
  return ordered.length ? ordered.at(-1).enabled === true : baseAutoStartBreaks === true;
}

function applySelectedTaskOperations(baseSelectedTaskId, operations) {
  const ordered = [...(operations || [])].sort(compareOperations);
  return ordered.length ? ordered.at(-1).taskId ?? null : baseSelectedTaskId ?? null;
}

function applyDurationOperations(baseDurationsMs, operations) {
  const durationsMs = clone(baseDurationsMs || {});
  const ordered = [...(operations || [])].sort((left, right) =>
    clockComponent(left.hlcWallMs) - clockComponent(right.hlcWallMs)
      || clockComponent(left.hlcCounter) - clockComponent(right.hlcCounter)
      || compareStrings(left.id, right.id));
  for (const operation of ordered) durationsMs[operation.phase] = operation.durationMs;
  return durationsMs;
}

function applyTaskOperations(baseTasks, operations) {
  const tasks = new Map((baseTasks || []).map((task) => [task.id, clone(task)]));
  const ordered = [...(operations || [])].sort((left, right) =>
    Number(left.hlcWallMs) - Number(right.hlcWallMs)
      || Number(left.hlcCounter) - Number(right.hlcCounter)
      || String(left.id).localeCompare(String(right.id)));
  for (const operation of ordered) {
    if (operation.type === "upsert") tasks.set(operation.taskId, { id: operation.taskId, title: operation.title });
    if (operation.type === "delete") tasks.delete(operation.taskId);
  }
  return [...tasks.values()].sort((left, right) =>
    left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
}

function completedHistoryCount(history) {
  if (!Array.isArray(history)) return 0;
  const identities = new Set();
  let count = 0;
  for (const item of history) {
    if (item?.status && item.status !== "completed") continue;
    const identity = typeof item?.timerId === "string" && item.timerId
      ? `timer:${item.timerId}`
      : typeof item?.id === "string" && item.id ? `id:${item.id}` : null;
    if (identity && identities.has(identity)) continue;
    if (identity) identities.add(identity);
    count += 1;
  }
  return count;
}

function decideBootstrap(input) {
  const localOwnerId = input.localOwnerId || null;
  const currentUserId = input.currentUserId || null;
  if (localOwnerId && localOwnerId === currentUserId) return { mode: "normal_sync", reason: "same_owner" };
  if (localOwnerId && localOwnerId !== currentUserId) {
    return { mode: "auto", strategy: "keep_remote", reason: "different_owner" };
  }
  const localHistoryCount = completedHistoryCount(input.localHistory);
  const remoteHistoryCount = completedHistoryCount(input.remoteHistory);
  const localStateExists = Boolean(input.hasLocalState) || (input.localHistory || []).length > 0;
  const remoteStateExists = Boolean(input.hasRemoteState) || (input.remoteHistory || []).length > 0;
  if (localHistoryCount > 0 && remoteStateExists || remoteHistoryCount > 0 && localStateExists) {
    return { mode: "choose", localHistoryCount, remoteHistoryCount };
  }
  if (localHistoryCount > 0) return { mode: "auto", strategy: "replace_remote", reason: "local_only" };
  if (remoteHistoryCount > 0) return { mode: "auto", strategy: "keep_remote", reason: "remote_only" };
  return {
    mode: "auto",
    strategy: localStateExists ? "merge" : "keep_remote",
    reason: localStateExists ? "local_state_only" : "empty"
  };
}

function canonicalRebase(local, payload, queues, validated) {
  const baseTasks = Array.isArray(payload.tasks) ? clone(payload.tasks) : clone(local.baseTasks || []);
  const baseAutoStartBreaks = Object.hasOwn(payload, "autoStartBreaks")
    ? payload.autoStartBreaks : local.baseAutoStartBreaks === true;
  const baseSelectedTaskId = Object.hasOwn(payload, "selectedTaskId")
    ? payload.selectedTaskId : local.baseSelectedTaskId ?? null;
  return {
    acknowledgements: validated,
    pending: queues.commands,
    pendingTaskOperations: queues.taskOperations,
    pendingDurationOperations: queues.durationOperations,
    pendingAutoStartOperations: queues.autoStartOperations,
    pendingSelectedTaskOperations: queues.selectedTaskOperations,
    baseTimer: Object.hasOwn(payload, "canonicalTimer") ? clone(payload.canonicalTimer) : clone(local.baseTimer),
    baseHistory: Array.isArray(payload.history) ? clone(payload.history) : clone(local.baseHistory || []),
    baseTasks,
    baseDurationsMs: Object.hasOwn(payload, "durationsMs") ? clone(payload.durationsMs) : clone(local.baseDurationsMs),
    baseAutoStartBreaks,
    baseSelectedTaskId,
    autoStartBreaks: applyAutoStartOperations(baseAutoStartBreaks, queues.autoStartOperations),
    selectedTaskId: applySelectedTaskOperations(baseSelectedTaskId, queues.selectedTaskOperations),
    tasks: applyTaskOperations(baseTasks, queues.taskOperations),
    revision: payload.revision ?? local.revision
  };
}

function retainedQueues(local, excluded = {}) {
  const retained = (items, ids) => {
    const excludedIds = new Set(ids || []);
    return (items || []).filter((item) => !excludedIds.has(item.id));
  };
  return {
    commands: retained(local.commands, excluded.commands),
    taskOperations: retained(local.taskOperations, excluded.taskOperations),
    durationOperations: retained(local.durationOperations, excluded.durationOperations),
    autoStartOperations: retained(local.autoStartOperations, excluded.autoStartOperations),
    selectedTaskOperations: retained(local.selectedTaskOperations, excluded.selectedTaskOperations)
  };
}

function rebaseSyncState(local, payload, sent) {
  const validated = core.validateAcknowledgements(payload, sent);
  const acknowledged = Object.fromEntries(Object.entries(validated).map(([domain, value]) => {
    const field = domain === "tasks" ? "taskOperations"
      : domain === "durations" ? "durationOperations"
        : domain === "autoStart" ? "autoStartOperations"
          : domain === "selectedTask" ? "selectedTaskOperations" : "commands";
    return [field, value.acknowledgedIds];
  }));
  return canonicalRebase(local, payload, retainedQueues(local, acknowledged), validated);
}

function applyResolutionState(local, payload, pendingResolution) {
  const validated = core.validateAcknowledgements(payload, pendingResolution.payload);
  return canonicalRebase(local, payload, retainedQueues(local, pendingResolution.queueIds), validated);
}

module.exports = Object.freeze({
  applyAutoStartOperations,
  applyDurationOperations,
  applyResolutionState,
  applySelectedTaskOperations,
  applyTaskOperations,
  decideBootstrap,
  rebaseSyncState
});
