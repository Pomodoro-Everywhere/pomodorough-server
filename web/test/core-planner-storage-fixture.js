"use strict";

// These adapters translate historical fixture inputs into public Core planner
// requests. They do not allocate identities, build commands, or decide outcomes.
const storage = require("../sync-storage.js");
const sync = require("../sync-core.js");
const crypto = require("node:crypto");
const receipts = [];
require("node:test").after(() => {
  if (process.env.CORE_PORT_EVIDENCE) require("node:fs").writeFileSync(process.env.CORE_PORT_EVIDENCE,
    JSON.stringify(receipts, null, 2));
});

function observedCore(instance) {
  return { call(operation, input) {
    const inputRaw = JSON.stringify(input);
    const receipt = { operation, inputRaw, input: JSON.parse(inputRaw) };
    receipts.push(receipt);
    try {
      const result = instance?.call ? instance.call(operation, input) : storage.callWorkspaceCore(operation, input);
      receipt.result = structuredClone(result);
      return result;
    } catch (error) { receipt.error = { name: error.name, message: error.message }; throw error; }
  } };
}

async function requestContext(database, input, deviceId) {
  const records = await storage.readSyncState(database);
  const userId = input.expectedUserId ?? null;
  return { ...input, ownerId: userId, expectedUserId: userId, sharedCore: observedCore(input.sharedCore),
    deviceId: deviceId || input.deviceId || records.deviceId || "device-1",
    tabId: input.tabId || input.timerOwner?.tabId || "tab-owner",
    nowMs: input.nowMs, localNowMs: input.localNowMs ?? input.nowMs,
    leaseMs: input.leaseMs || input.timerOwner?.leaseMs || 60000,
    timerUuid: input.breakTimerId ?? crypto.randomUUID() };
}

function completionResult(plan) {
  return { transitioned: plan.outcome === "planned", reason: plan.reason || "",
    commands: plan.durableCommands || plan.commands,
    ...(plan.outcome === "planned" ? { selectedPhase: plan.selection.phase,
      selectedPhaseDurationMs: plan.projection.durationsMs[plan.selection.phase] } : {}),
    ...(plan.retryAtMs == null ? {} : { retryAtMs: plan.retryAtMs }) };
}

async function finishTimer(database, input) {
  input = { ...input };
  const request = await requestContext(database, input);
  const records = await storage.readSyncState(database);
  const projected = storage.projectWorkspace({ ...records, deviceId: request.deviceId, nowMs: 0 }).workspace.canonicalTimer;
  request.requestedTimer = input.requestedTimer || (projected ? { ...projected,
    id: input.timerId ?? projected.id, phase: input.phase ?? projected.phase } : null);
  request.stage = input.manual === false ? "automaticFinishCommit" : "finishCommit";
  return completionResult(await storage.planWorkspaceMutation(database, request));
}

async function cancelAndClearTimer(database, input) {
  input = { ...input };
  const request = await requestContext(database, input);
  const records = await storage.readSyncState(database);
  const projected = storage.projectWorkspace({ ...records, deviceId: request.deviceId, nowMs: 0 }).workspace.canonicalTimer;
  request.requestedTimer = input.requestedTimer || (projected ? { ...projected,
    id: input.timerId ?? projected.id, phase: input.phase ?? projected.phase } : null);
  request.intent = { kind: "cancelAndClear" };
  const plan = await storage.planWorkspaceMutation(database, request);
  return { transitioned: plan.outcome === "planned", reason: plan.reason || "", commands: plan.durableCommands || plan.commands };
}

async function allocateMutation(database, input) {
  input = { ...input };
  const value = input.build({ id: "fixture-observation", wallMs: input.nowMs, counter: 0, deviceSequence: 1 });
  const request = await requestContext(database, input, input.timerOwner?.deviceId || value.deviceId);
  const intents = {
    pending: { kind: value.type }, pendingTasks: value.type === "delete"
      ? { kind: "deleteTask", taskId: value.taskId } : { kind: "upsertTask", title: value.title },
    pendingDurations: { kind: "setDuration", phase: value.phase, minutes: value.durationMs / 60000 },
    pendingAutoStarts: { kind: "setAutoStart", enabled: value.enabled },
    pendingSelectedTasks: { kind: "selectTask", taskId: value.taskId }
  };
  request.intent = intents[input.storeName];
  request.preference = input.storeName !== "pending";
  const plan = await storage.planWorkspaceMutation(database, request);
  const domain = Object.keys(require("../workspace-transaction.js").QUEUE_STORES)
    .find((key) => require("../workspace-transaction.js").QUEUE_STORES[key] === input.storeName);
  return (plan.durableOperations || { commands: plan.durableCommands || plan.commands })[domain]?.[0] ?? null;
}

module.exports = { finishTimer, cancelAndClearTimer, allocateMutation, completionResult };
