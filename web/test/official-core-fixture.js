"use strict";

const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { SharedCore } = require("../shared-core.js");
const storage = require("../sync-storage.js");

let core;
test.before(async () => {
  core = await SharedCore.fromBytes(fs.readFileSync(path.join(__dirname, "../pomodorough_core.wasm")));
  storage.setSharedCore(core);
});

function plannedWorkspace(intent = { kind: "setDuration", phase: "focus", minutes: 30 }) {
  const nowMs = 1000;
  const workspace = require("../workspace-core.js");
  return core.call("workspace.intent.v1", {
    compatibility: "pwaStorage", replicationMode: "centralized", intent,
    workspace: workspace.workspace({ snapshot: { ...workspace.base(null), user: null },
      canonicalHead: { wallMs: nowMs, counter: 0 } }, "device-1", []),
    selection: { phase: "focus", generation: "0", explicit: false },
    allocation: { deviceId: "device-1", deviceSequence: 0, hlc: { wallMs: nowMs, counter: 0 }, lastUuid: null },
    observation: { canonicalAnchorAt: null, commandTimes: {} },
    clock: { occurredAt: new Date(nowMs).toISOString(), physicalNow: new Date(nowMs).toISOString(), observedAt: new Date(nowMs).toISOString() },
    identities: { commandUuids: storage.reserveUuid7(nowMs, 3, null, []), timerUuid: "12345678-1234-4234-8234-123456789012" },
    calendarIntervals: workspace.calendarIntervals([nowMs]),
    ownership: { expectedOwnerId: null, ownerId: null }, durability: { outgoingDurationOperationIds: [], localTabId: "tab-1" }
  });
}

function renderModel(state, nowMs = Date.now()) {
  const workspace = require("../workspace-core.js");
  const source = state.timer || {};
  const timer = source.id && source.status !== "idle" ? {
    id: source.id, phase: source.phase || "focus", status: source.status,
    plannedDurationMs: source.plannedDurationMs || 1500000,
    elapsedAtAnchorMs: source.status === "completed" ? source.plannedDurationMs || 1500000 : source.elapsedAtAnchorMs || 0,
    anchorAt: source.anchorAt || new Date(nowMs).toISOString(), lastIntent: source.lastIntent || null
  } : null;
  const raw = workspace.workspace({ snapshot: { ...workspace.base(null), canonicalTimer: timer,
    durationsMs: { ...workspace.DEFAULT_DURATIONS, ...state.durationsMs } } }, "render-device", []);
  return core.call("workspace.readModel.v1", workspace.readRequest(raw, state.selectedPhase || "focus", nowMs, null));
}

module.exports = { storage, core: () => core, plannedWorkspace, renderModel };
