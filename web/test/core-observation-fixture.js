"use strict";

const { storage } = require("./official-core-fixture.js");
const workspace = require("../workspace-core.js");

function classify(local = {}, remote = {}) {
  const base = { ...workspace.base(null), history: local.history || [], tasks: local.tasks || [],
    canonicalTimer: local.timer?.id ? local.timer : null, durationsMs: local.durationsMs || workspace.DEFAULT_DURATIONS,
    autoStartBreaks: local.autoStartBreaks ?? false, selectedTaskId: local.selectedTaskId ?? null };
  return storage.bootstrapWorkspace({ snapshot: base,
    ...Object.fromEntries(workspace.DOMAINS.map((domain) => [domain, local[domain] || []])),
    deviceId: "fixture-device", ownerId: null, currentUserId: "fixture-account",
    remote: { ...workspace.base(null), ...remote }, nowMs: Date.parse("2026-07-22T12:00:00Z"),
    defaultDurationsMs: local.defaultDurationsMs || remote.defaultDurationsMs || workspace.DEFAULT_DURATIONS });
}

function completedHistoryCount(history) {
  return classify({ history }).classification.local.completedHistoryCount;
}

function hasLocalState(local) {
  return classify(local).classification.local.hasState;
}

function hasRemoteState(remote) {
  return classify({}, remote).classification.remote.hasState;
}

function serverClockOffset(serverTime, requestAtMs, receivedAtMs, requestSequence) {
  return storage.sampleClock(null, serverTime, { requestAtMs, receivedAtMs, requestSequence });
}

function trustedNow(wallMs, clockOffset, minimumWallMs = 0) {
  return storage.observeClock({ clockOffset, minimumWallMs }, { wallMs, monotonicMs: null }).trustedNowMs;
}

module.exports = { completedHistoryCount, hasLocalState, hasRemoteState, serverClockOffset, trustedNow };
