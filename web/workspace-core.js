(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PomodoroughWorkspaceCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DOMAINS = Object.freeze([
    "commands", "taskOperations", "durationOperations", "autoStartOperations", "selectedTaskOperations"
  ]);
  const DEFAULT_DURATIONS = Object.freeze({ focus: 1500000, short_break: 300000, long_break: 900000 });

  function canonicalJSON(value) {
    if (Array.isArray(value)) return value.map(canonicalJSON);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort()
      .map((key) => [key, canonicalJSON(value[key])]));
    return value;
  }

  function recordsEqual(left, right) {
    return JSON.stringify(canonicalJSON(left)) === JSON.stringify(canonicalJSON(right));
  }

  function calendarIntervals(values) {
    const intervals = new Map();
    for (const value of values) {
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) throw new Error("Invalid calendar observation.");
      const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
      intervals.set(start.toISOString(), { start: start.toISOString(), end: end.toISOString() });
    }
    return [...intervals.values()];
  }

  function base(snapshot) {
    if (!snapshot) return {
      canonicalTimer: null, history: [], tasks: [], durationsMs: DEFAULT_DURATIONS,
      autoStartBreaks: false, selectedTaskId: null
    };
    return {
      // The pre-Core PWA stored an idle UI placeholder as its null wire timer.
      canonicalTimer: snapshot.canonicalTimer?.id ? snapshot.canonicalTimer : null,
      history: snapshot.history, tasks: snapshot.tasks, durationsMs: snapshot.durationsMs,
      autoStartBreaks: snapshot.autoStartBreaks, selectedTaskId: snapshot.selectedTaskId
    };
  }

  function workspace(records, deviceId, dependencies) {
    const local = Object.fromEntries(DOMAINS.map((domain) => [domain, (records[domain] || []).map((item) =>
      Object.hasOwn(item, "deviceId") ? item : { ...item, deviceId }
    )]));
    return {
      base: base(records.snapshot), local, canonicalHead: records.canonicalHead ?? null,
      neverSent: records.deliveryProof ?? {}, timerDependencies: records.timerDependencies ?? dependencies,
      displayContext: { profile: "pwaStorage", projectionPending: projectionIdentity(records.projectionPending, deviceId) }
    };
  }

  function completionContext(records = {}) {
    const stored = records.completionState;
    const initialLifecycle = { consumedCompletions: [], pendingBreaks: [], finishEvidence: [] };
    return stored == null ? {
      selection: { phase: records.settings?.selectedPhase ?? records.selectedPhase ?? "focus", generation: "0", explicit: false },
      lifecycle: initialLifecycle
    } : { selection: stored.selection,
      lifecycle: Object.hasOwn(stored, "lifecycle") ? stored.lifecycle : initialLifecycle };
  }

  function projectionIdentity(context, deviceId) {
    if (context == null || typeof context !== "object" || Array.isArray(context)) return context ?? null;
    return Object.fromEntries(Object.entries(context).map(([key, values]) => [key,
      DOMAINS.includes(key) && Array.isArray(values) ? values.map((item) =>
        item && typeof item === "object" && !Array.isArray(item) && !Object.hasOwn(item, "deviceId")
          ? { ...item, deviceId } : item) : values]));
  }

  function persistedProjection(context, records) {
    if (context == null) return context;
    return Object.fromEntries(Object.entries(context).map(([key, values]) => {
      if (!DOMAINS.includes(key) || !Array.isArray(values)) return [key, values];
      const retained = new Map((records[key] || []).map((item) => [item.id, item]));
      return [key, values.map((item) => {
        const original = retained.get(item.id);
        if (!original) throw new Error("Core display context references an unknown retained identity.");
        if (Object.hasOwn(original, "deviceId")) return item;
        const { deviceId, ...local } = item;
        return local;
      })];
    }));
  }

  function rawWorkspace(records, nowMs) {
    return { base: base(records.snapshot), local: Object.fromEntries(DOMAINS.map((domain) => [domain, records[domain] || []])),
      canonicalHead: records.canonicalHead ?? null, neverSent: records.deliveryProof ?? {},
      timerDependencies: records.timerDependencies ?? null,
      displayContext: { profile: "pwaStorage", projectionPending: records.projectionPending ?? null },
      now: new Date(nowMs).toISOString() };
  }

  function dependencyRequest(records, deviceId, expectedOwnerId, ownerId, nowMs) {
    const raw = rawWorkspace(records, nowMs);
    const commands = records.commands || [];
    const observations = [nowMs, ...commands.map((command) => command.physicalOccurredAt || command.occurredAt),
      ...(records.snapshot?.history || []).map((row) => row.completedAt || row.endedAt),
      ...(records.outgoingSync?.sent?.commands || records.outgoing?.sent?.commands || []).map((command) => command.occurredAt)];
    return { profile: "pwaStorage", workspace: raw, ownership: { ownerId, expectedOwnerId, timerOwner: records.timerOwner ?? null },
      deviceId, outgoing: records.outgoingSync ?? records.outgoing ?? null,
      calendarIntervals: calendarIntervals(observations), sourceAcknowledgements: records.sourceAcknowledgements ?? [] };
  }

  function preferenceRequest(records, deviceId, expectedOwnerId, ownerId, nowMs, operationUuids) {
    return { profile: "pwaStorage", settings: records.settings || {}, workspace: rawWorkspace(records, nowMs),
      ownership: { ownerId, expectedOwnerId }, deviceId, identities: { operationUuids },
      outgoing: records.outgoingSync ?? records.outgoing ?? null };
  }

  function clockCurrent(call, state, reading) {
    return call("clock.observe.v1", {
      schemaVersion: 1, compatibility: "pwaTrustedClock", action: "current", state, reading
    });
  }

  function clockSample(call, clockOffset, serverTime, timing) {
    return call("clock.observe.v1", {
      schemaVersion: 1, compatibility: "pwaTrustedClock", action: "sample",
      state: { clockOffset }, server: {
        serverTimeMs: Date.parse(serverTime), requestWallMs: timing.requestAtMs,
        responseWallMs: timing.receivedAtMs, requestSequence: timing.requestSequence
      }
    }).state.clockOffset;
  }

  function batchRequest(queues, deviceId, dependencies, cursor, mode = "sync", limits = null) {
    return {
      kind: "new", mode, limits: limits || (mode === "sync"
        ? { perDomain: 256, total: 512 } : { perDomain: 4096, total: 8192 }),
      nextDomain: cursor ?? "commands",
      queues: Object.fromEntries(DOMAINS.map((domain) => [domain, (queues[domain] || []).map((item) => ({
        id: item.id, deviceId: item.deviceId || deviceId,
        hlcWallMs: item.hlcWallMs, hlcCounter: item.hlcCounter,
        ...(domain === "commands" ? { deviceSequence: item.deviceSequence } : {})
      }))])),
      timerDependencies: dependencies.map(({ operationId, dependsOnOperationId }) => ({ operationId, dependsOnOperationId }))
    };
  }

  function savedBatchRequest(sent, mode = "sync") {
    return {
      kind: "saved", mode,
      limits: mode === "sync" ? { perDomain: 256, total: 512 } : { perDomain: 4096, total: 8192 },
      queues: Object.fromEntries(DOMAINS.map((domain) => [domain, (sent[domain] || []).map((item) => item.id)]))
    };
  }

  function selectedRecords(plan, queues) {
    return Object.fromEntries(DOMAINS.map((domain) => {
      const records = new Map((queues[domain] || []).map((item) => [item.id, item]));
      return [domain, plan.selected[domain].map((id) => {
        if (!records.has(id)) throw new Error("Core selected an unknown retained operation.");
        return records.get(id);
      })];
    }));
  }

  function readRequest(raw, phase, nowMs, monotonic, context = null) {
    return {
      profile: "pwaStorage", source: { kind: "workspace", value: raw }, selectedPhase: phase,
      observedAt: new Date(nowMs).toISOString(), calendarIntervals: calendarIntervals([nowMs]), monotonic,
      ...(context || {})
    };
  }

  function bootstrapRequest(records, deviceId, dependencies, currentUserId, nowMs, defaults) {
    const { displayContext, ...raw } = workspace(records, deviceId, dependencies);
    return {
      profile: "pwaStorage", currentUserId,
      local: {
        ownerId: records.ownerId ?? null, workspace: { ...raw, now: new Date(nowMs).toISOString() },
        preferences: { durationsMs: raw.base.durationsMs, autoStartBreaks: raw.base.autoStartBreaks,
          selectedTaskId: raw.base.selectedTaskId, defaultDurationsMs: defaults }, knownTasks: records.knownTasks || [],
        projectionPending: displayContext.projectionPending
      }, remote: records.remote
    };
  }

  return Object.freeze({ DOMAINS, DEFAULT_DURATIONS, recordsEqual, calendarIntervals, base, workspace, completionContext,
    rawWorkspace, dependencyRequest, preferenceRequest, projectionIdentity, persistedProjection,
    clockCurrent, clockSample, batchRequest, savedBatchRequest, selectedRecords, readRequest, bootstrapRequest });
});
