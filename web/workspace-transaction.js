(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PomodoroughWorkspaceTransaction = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const workspaceCore = typeof module === "object" && module.exports
    ? require("./workspace-core.js") : globalThis.PomodoroughWorkspaceCore;

  const QUEUE_STORES = Object.freeze({
    commands: "pending", taskOperations: "pendingTasks", durationOperations: "pendingDurations",
    autoStartOperations: "pendingAutoStarts", selectedTaskOperations: "pendingSelectedTasks"
  });
  const META_KEYS = Object.freeze([
    "snapshot", "settings", "deviceId", "deviceSequence", "hlc", "uuidV7", "clockOffset",
    "canonicalHead", "deliveryProof", "projectionPending", "outgoingSync", "timerDependencies",
    "workspaceObservation", "workspaceGroups", "completionRecords", "completionState", "displayHistory", "timerOwner", "batchNextDomain", "bootstrapGate", "bootstrapResolution",
    "sourceAcknowledgements"
  ]);
  const STORES = Object.freeze(["meta", ...Object.values(QUEUE_STORES)]);

  function requests(transaction) {
    const meta = transaction.objectStore("meta");
    return Object.fromEntries([
      ...META_KEYS.map((key) => [key, { request: meta.get(key), metadata: true }]),
      ...Object.entries(QUEUE_STORES).map(([key, name]) => [key, { request: transaction.objectStore(name).getAll() }])
    ]);
  }

  function run(database, mode, change) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORES, mode);
      const pending = requests(transaction);
      const records = {};
      let remaining = Object.keys(pending).length;
      let result;
      let failure;
      for (const [key, { request, metadata }] of Object.entries(pending)) {
        request.onsuccess = () => {
          records[key] = metadata ? request.result?.value : request.result;
          remaining -= 1;
          if (remaining) return;
          try { result = change(records, transaction); }
          catch (error) { failure = error; transaction.abort(); }
        };
      }
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(failure || transaction.error || new Error("Storage transaction aborted."));
      transaction.onerror = () => {};
    });
  }

  function put(meta, key, value) {
    meta.put({ key, value });
  }

  function writeLegacyPreferences(transaction, plan) {
    if (plan.outcome === "noop") return;
    if (plan.outcome !== "planned" || plan.outgoingAction !== "preserve") throw new Error("Invalid legacy preference plan.");
    const meta = transaction.objectStore("meta");
    for (const [domain, name] of Object.entries(QUEUE_STORES)) {
      for (const operation of plan.operations[domain]) transaction.objectStore(name).add(operation);
    }
    if (plan.writeSettings) put(meta, "settings", plan.settings);
    put(meta, "deliveryProof", plan.workspace.neverSent);
    put(meta, "projectionPending", plan.workspace.displayContext.projectionPending);
  }

  function writeOwnership(meta, writes, lease) {
    for (const write of writes) {
      if (write.kind === "removeTimerOwner") { meta.delete("timerOwner"); continue; }
      if (write.kind === "recordTimerOwner") {
        const { kind, ...owner } = write;
        put(meta, "timerOwner", owner);
        continue;
      }
      if (write.kind !== "recordStart") throw new Error("Unsupported PWA ownership effect.");
      put(meta, "timerOwner", { timerId: write.timerId, deviceId: write.deviceId,
        tabId: lease.tabId, leaseExpiresAtMs: lease.nowMs + lease.durationMs });
    }
  }

  function writePlan(transaction, records, plan, lease) {
    if (plan.outcome === "noop") return;
    if (plan.outcome !== "planned") throw new Error("Invalid workspace mutation outcome.");
    const meta = transaction.objectStore("meta");
    const operations = plan.durableOperations || { commands: plan.durableCommands || plan.commands };
    for (const [domain, name] of Object.entries(QUEUE_STORES)) {
      for (const operation of operations[domain] || []) transaction.objectStore(name).add(operation);
    }
    for (const id of plan.retiredDurationOperationIds || []) transaction.objectStore("pendingDurations").delete(id);
    put(meta, "settings", { ...(records.settings || {}), selectedPhase: plan.selection.phase });
    if (Object.hasOwn(plan, "lifecycle")) put(meta, "completionState", { selection: plan.selection, lifecycle: plan.lifecycle });
    put(meta, "hlc", plan.allocation.hlc);
    put(meta, "deviceSequence", plan.allocation.deviceSequence);
    put(meta, "uuidV7", plan.allocation.lastUuid);
    put(meta, "deliveryProof", plan.workspace.neverSent);
    put(meta, "timerDependencies", plan.workspace.timerDependencies);
    put(meta, "workspaceObservation", plan.observation);
    const retained = Object.fromEntries(Object.keys(QUEUE_STORES).map((domain) =>
      [domain, (records[domain] || []).concat(operations[domain] || [])]));
    put(meta, "projectionPending", workspaceCore.persistedProjection(plan.workspace.displayContext.projectionPending, retained));
    put(meta, "displayHistory", plan.projection.history);
    const completionRecords = { ...(records.completionRecords || {}), ...(plan.completionRecords || {}) };
    const workspaceGroups = [...(records.workspaceGroups || []), {
      atomicCommandIds: plan.atomicCommandIds, atomicOperationIds: plan.atomicOperationIds ?? null,
      commandOutcomes: plan.commandOutcomes ?? [], groupOutcomes: plan.groupOutcomes ?? null
    }];
    put(meta, "completionRecords", completionRecords);
    put(meta, "workspaceGroups", workspaceGroups);
    writeOwnership(meta, plan.ownershipWrites, lease);
    return { completionRecords, workspaceGroups };
  }

  return Object.freeze({ QUEUE_STORES, STORES, run, put, writePlan, writeOwnership, writeLegacyPreferences });
});
