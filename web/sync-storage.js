(function (root, factory) {
  "use strict";

  const dependencies = typeof module === "object" && module.exports
    ? {
      core: require("./sync-core.js"), authority: require("./sync-authority.js"),
      uuid: require("./sync-storage-uuid.js"), workspace: require("./workspace-core.js"),
      transaction: require("./workspace-transaction.js")
    }
    : {
      core: root.PomodoroughSync, authority: root.PomodoroughSyncAuthority,
      uuid: root.PomodoroughStorageUuid, workspace: root.PomodoroughWorkspaceCore,
      transaction: root.PomodoroughWorkspaceTransaction
    };
  const api = factory(dependencies.core, dependencies.authority, dependencies.uuid, dependencies.workspace, dependencies.transaction);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PomodoroughStorage = api;
})(typeof globalThis === "object" ? globalThis : this, function (core, authorityModule, uuidModule, workspaceCore, workspaceTransaction) {
  "use strict";

  const META_STORE = "meta";
  const PENDING_STORE = "pending";
  const TASK_PENDING_STORE = "pendingTasks";
  const DURATION_PENDING_STORE = "pendingDurations";
  const AUTO_START_PENDING_STORE = "pendingAutoStarts";
  const SELECTED_TASK_PENDING_STORE = "pendingSelectedTasks";
  const GATE_KEY = "bootstrapGate";
  const RESOLUTION_KEY = "bootstrapResolution";
  const TIMER_OWNER_KEY = "timerOwner";
  const CLOCK_OFFSET_KEY = "clockOffset";
  const CLOCK_REQUEST_SEQUENCE_KEY = "clockRequestSequence";
  const DELIVERY_PROOF_KEY = "deliveryProof";
  const OUTGOING_KEY = "outgoingSync";
  const CANONICAL_HEAD_KEY = "canonicalHead";
  const PROJECTION_PENDING_KEY = "projectionPending";
  const UUID7_KEY = "uuidV7";
  const UUID7_MAX_TIMESTAMP_MS = uuidModule.MAX_TIMESTAMP_MS;
  const UUID7_RANDOM_MAX = uuidModule.RANDOM_MAX;
  const UUIDRangeError = uuidModule.UUIDRangeError;
  const uuid7FromParts = uuidModule.fromParts;
  const uuid7Parts = uuidModule.parts;
  const reserveUuid7 = uuidModule.reserve;
  const LEGACY_EPOCH = new Date(0).toISOString();
  const DEFAULT_DURATIONS_MS = Object.freeze({
    focus: 1_500_000,
    short_break: 300_000,
    long_break: 900_000
  });
  const PROJECTION_QUEUE_FIELDS = Object.freeze({
    [PENDING_STORE]: "commands",
    [TASK_PENDING_STORE]: "taskOperations",
    [DURATION_PENDING_STORE]: "durationOperations",
    [AUTO_START_PENDING_STORE]: "autoStartOperations",
    [SELECTED_TASK_PENDING_STORE]: "selectedTaskOperations"
  });
  let sharedCore = null;
  let sharedAuthority = null;

  function callWorkspaceCore(operation, input, instance = sharedCore) {
    if (typeof instance?.call !== "function") throw new Error("Official workspace Core is unavailable.");
    return instance.call(operation, input);
  }

  function workspaceRecords(input) {
    assertPersistedDisplayContext(input, input.deviceId);
    const records = { ...input, deliveryProof: neverSentFromProof(input.deliveryProof, input, input.outgoingSync?.sent || input.outgoing?.sent) };
    return workspaceCore.workspace(records, input.deviceId,
      validatedTimerDependencies(records, input.deviceId, input.nowMs ?? Date.now()));
  }

  function observeClock(state, reading) {
    return workspaceCore.clockCurrent(callWorkspaceCore, state, reading);
  }

  function sampleClock(clockOffset, serverTime, timing) {
    return workspaceCore.clockSample(callWorkspaceCore, clockOffset, serverTime, timing);
  }

  function readWorkspace(input) {
    const raw = workspaceRecords(input);
    const context = workspaceCore.completionContext(input);
    const request = workspaceCore.readRequest(raw, context.selection.phase, input.nowMs, input.monotonic ?? null, context);
    return callWorkspaceCore("workspace.readModel.v1", request);
  }

  function observeWorkspace(input) {
    const at = new Date(input.nowMs).toISOString();
    // PWA restart is a documented no-op. Its pure result supplies Core's live
    // anchor, which readModel consumes without rewriting the canonical timer.
    return callWorkspaceCore("workspace.intent.v1", {
      compatibility: "pwaStorage", replicationMode: "centralized", intent: { kind: "restart" },
      workspace: workspaceRecords(input), ...workspaceCore.completionContext(input),
      allocation: { deviceId: input.deviceId, deviceSequence: input.deviceSequence,
        hlc: input.hlc, lastUuid: input.uuidV7 ?? null },
      observation: input.workspaceObservation || { canonicalAnchorAt: null, commandTimes: {} },
      clock: { occurredAt: at, physicalNow: at, observedAt: at,
        ...(input.monotonicMs == null ? {} : { monotonicNowMs: input.monotonicMs, continuityId: input.continuityId }) },
      identities: { commandUuids: [], timerUuid: null }, calendarIntervals: []
    });
  }

  function projectWorkspace(input) {
    return callWorkspaceCore("workspace.project.v1", {
      ...workspaceRecords(input), now: new Date(input.nowMs).toISOString()
    });
  }

  function bootstrapWorkspace(input) {
    return callWorkspaceCore("bootstrap.workspacePlan.v1", workspaceCore.bootstrapRequest(
      input, input.deviceId, input.timerDependencies ?? [], input.currentUserId,
      input.nowMs, input.defaultDurationsMs || DEFAULT_DURATIONS_MS
    ));
  }

  class PersistedDisplayContextError extends Error {
    constructor(cause) {
      super(cause.message, { cause });
      this.name = "PersistedDisplayContextError";
    }
  }

  function assertPersistedDisplayContext(records, deviceId = records.deviceId) {
    if (records.projectionPending == null) return;
    const ownerId = core.accountOwnerId(records.snapshot?.user) || null;
    try {
      const legacyRecords = workspaceCore.DOMAINS.some((domain) => (records[domain] || []).some((item) => !Object.hasOwn(item, "deviceId")));
      if (legacyRecords) {
        const plan = dependencyPlan(records, deviceId, Date.now());
        if (plan.outcome === "blocked") throw new LegacyDependencyRecoveryError(plan);
        return;
      }
      // Bootstrap is the official operation that accepts raw PWA display queues.
      // Its result is not used to decide mutation eligibility or rewrite proof.
      const deliveryProof = neverSentFromProof(records.deliveryProof, records, records.outgoingSync?.sent || records.outgoing?.sent);
      bootstrapWorkspace({ ...records, deliveryProof, deviceId, ownerId, currentUserId: ownerId,
        remote: workspaceCore.base(records.snapshot), nowMs: Date.now(), defaultDurationsMs: DEFAULT_DURATIONS_MS });
    } catch (error) { throw new PersistedDisplayContextError(error); }
  }

  function assertResponseDisplayContext(results, deviceId) {
    assertPersistedDisplayContext({ snapshot: results.snapshot?.value,
      projectionPending: results.projectionPending?.value, canonicalHead: results.canonicalHead?.value,
      deliveryProof: results.deliveryProof?.value, outgoing: results.outgoing?.value,
      timerDependencies: results.timerDependencies?.value,
      ...Object.fromEntries(workspaceCore.DOMAINS.map((domain) => [domain, results[domain] || []])) },
    deviceId || results.deviceId?.value);
  }

  function completionSelection(input) {
    const history = input.history || [];
    const commands = input.commands || [];
    const referenceTime = input.referenceTime || new Date().toISOString();
    return callWorkspaceCore("timer.completionState.v1", {
      kind: "install", compatibility: "pwaRejectedFinish", beforeHistory: input.beforeHistory || [],
      afterHistory: input.afterHistory || history, canonicalTimer: input.canonicalTimer || null,
      ...workspaceCore.completionContext(input),
      pending: { commandIds: input.pendingCommandIds || [], sendableCommandIds: input.sendableCommandIds || [],
        otherOperationIds: input.otherOperationIds || [] },
      advances: [], acknowledgements: input.acknowledgements.map(({ commandId, outcome }) => ({ commandId, outcome })),
      discardedCommandIds: input.discardedCommandIds || [],
      referenceTime, calendarIntervals: workspaceCore.calendarIntervals([referenceTime, ...commands.map((command) => command.occurredAt)]),
      sentContext: { kind: "pwa", commands, rollbackHistory: history }
    });
  }

  function assertWorkspaceContext(records, input) {
    input.assertCurrent?.();
    const expectedOwnerId = Object.hasOwn(input, "ownerId") ? input.ownerId : input.expectedUserId ?? null;
    assertAccountOwnership(records.snapshot, expectedOwnerId);
    if (records.bootstrapGate || records.bootstrapResolution) throw new BootstrapGateError();
    if (records.deviceId != null && records.deviceId !== input.deviceId) throw new AccountOwnershipError();
    if (typeof input.deviceId !== "string" || !input.deviceId) throw new AccountOwnershipError();
  }

  function workspaceMutationRequest(records, input) {
    const raw = workspaceRecords(records);
    const inFlight = new Set(input.inFlightDurationOperationIds || []);
    raw.neverSent.durationOperations = (raw.neverSent.durationOperations || []).filter((id) => !inFlight.has(id));
    const nowMs = input.nowMs;
    const allocation = { deviceId: records.deviceId, deviceSequence: records.deviceSequence ?? 0,
      hlc: records.hlc ?? { wallMs: 0, counter: 0 }, lastUuid: records.uuidV7 ?? null };
    const tick = callWorkspaceCore("hlc.tick.v1", { local: allocation.hlc, physicalNowMs: nowMs }, input.sharedCore || sharedCore);
    const pendingIds = workspaceCore.DOMAINS.flatMap((domain) => (records[domain] || []).map((item) => item.id));
    const identities = { commandUuids: reserveUuid7(tick.wallMs, input.preference ? 3 : 2, allocation.lastUuid, pendingIds, input.entropy),
      timerUuid: input.timerUuid };
    const occurredAt = new Date(nowMs).toISOString();
    return {
      compatibility: "pwaStorage", replicationMode: "centralized", workspace: raw,
      ...workspaceCore.completionContext(records), allocation,
      observation: records.workspaceObservation || { canonicalAnchorAt: null, commandTimes: {} },
      clock: { occurredAt, physicalNow: occurredAt, observedAt: occurredAt,
        ...(input.continuityId ? { continuityId: input.continuityId } : {}),
        ...(input.monotonicMs == null ? {} : { monotonicNowMs: input.monotonicMs }) },
      identities, calendarIntervals: workspaceCore.calendarIntervals([nowMs,
        ...(records.commands || []).map((command) => command.occurredAt)]),
      ...(input.requestedTimer ? { requestedTimer: input.requestedTimer } : {})
    };
  }

  function mutationDurability(records, input) {
    const sentIds = records.outgoingSync?.sent?.durationOperations?.map((item) => item.id) || [];
    return {
      ownership: { expectedOwnerId: Object.hasOwn(input, "ownerId") ? input.ownerId : input.expectedUserId ?? null,
        ownerId: core.accountOwnerId(records.snapshot?.user) },
      durability: { outgoingDurationOperationIds: [...new Set([...sentIds, ...(input.inFlightDurationOperationIds || [])])],
        localTabId: input.tabId }
    };
  }

  function planWorkspaceMutation(database, input) {
    input = { ...input };
    return workspaceTransaction.run(database, "readwrite", (records, transaction) => {
      assertWorkspaceContext(records, input);
      const newIdentity = records.deviceId == null;
      if (newIdentity) records.deviceId = input.deviceId;
      assertPersistedDisplayContext(records, input.deviceId);
      migrateDependencyMetadata(records, input, transaction);
      const request = workspaceMutationRequest(records, input);
      let plan;
      if (input.stage) {
        Object.assign(request, { stage: input.stage, ownership: records.timerOwner ?? null,
          localTabId: input.tabId, leaseNowMs: input.localNowMs, leaseDurationMs: input.leaseMs });
        plan = callWorkspaceCore("workspace.completionMutation.v1", request, input.sharedCore || sharedCore);
      } else {
        if (input.preference) Object.assign(request, mutationDurability(records, input));
        request.intent = input.intent;
        plan = callWorkspaceCore("workspace.intent.v1", request, input.sharedCore || sharedCore);
      }
      input.assertCurrent?.();
      workspaceTransaction.writePlan(transaction, records, plan,
        { tabId: input.tabId, nowMs: input.localNowMs, durationMs: input.leaseMs });
      if (newIdentity && plan.outcome === "planned") {
        const meta = transaction.objectStore(META_STORE);
        workspaceTransaction.put(meta, "deviceId", input.deviceId);
        if (!records.snapshot) workspaceTransaction.put(meta, "snapshot", { ...plan.workspace.base, revision: 0, user: null });
      }
      return plan;
    });
  }

  function encodeSelectedBatch(selected) {
    return {
      commands: selected.commands.map(core.timerRequestCommand),
      taskOperations: selected.taskOperations,
      durationOperations: selected.durationOperations.map(core.durationRequestOperation),
      autoStartOperations: selected.autoStartOperations.map(core.autoStartRequestOperation),
      selectedTaskOperations: selected.selectedTaskOperations.map(core.selectedTaskRequestOperation)
    };
  }

  function selectWorkspaceBatch(records, deviceId, nextDomain = "commands", limits = null, mode = "sync") {
    const plan = callWorkspaceCore("sync.batchPlan.v1", workspaceCore.batchRequest(
      records, deviceId, records.timerDependencies ?? [], nextDomain, mode, limits
    ));
    return { plan, sent: encodeSelectedBatch(workspaceCore.selectedRecords(plan, records)) };
  }

  function claimWorkspaceBatch(database, input) {
    return workspaceTransaction.run(database, "readwrite", (records, transaction) => {
      assertWorkspaceContext(records, input);
      assertPersistedDisplayContext(records, input.deviceId);
      const saved = records.outgoingSync;
      if (saved?.sent) {
        if (saved.ownerId != null && saved.ownerId !== input.ownerId) throw new AccountOwnershipError();
        const plan = callWorkspaceCore("sync.batchPlan.v1", workspaceCore.savedBatchRequest(saved.sent));
        if (plan.status !== "replay_saved") return { plan, claim: saved, proof: records.deliveryProof };
        if (saved.body != null) {
          const body = JSON.parse(saved.body);
          if (body.deviceId !== records.deviceId || workspaceCore.DOMAINS.some((domain) =>
            !workspaceCore.recordsEqual(body[domain], saved.sent[domain]))) {
            throw new Error("Saved request bytes disagree with retained claim metadata. Recovery is required.");
          }
        }
        return { plan, claim: saved, proof: records.deliveryProof };
      }
      const dependencies = migrateDependencyMetadata(records, input, transaction).timerDependencies;
      const plan = callWorkspaceCore("sync.batchPlan.v1", workspaceCore.batchRequest(
        records, records.deviceId, dependencies, records.batchNextDomain
      ));
      if (plan.status !== "planned") return { plan, claim: null, proof: records.deliveryProof };
      const sent = encodeSelectedBatch(workspaceCore.selectedRecords(plan, records));
      const claim = { claimId: globalThis.crypto.randomUUID(), sent, ownerId: input.ownerId,
        retiredAt: new Date(input.localNowMs).toISOString(),
        body: JSON.stringify({ deviceId: records.deviceId, lastRevision: records.snapshot.revision, ...sent }) };
      const proof = removeProofIds(records.deliveryProof, sent);
      const meta = transaction.objectStore(META_STORE);
      workspaceTransaction.put(meta, DELIVERY_PROOF_KEY, proof);
      workspaceTransaction.put(meta, OUTGOING_KEY, claim);
      workspaceTransaction.put(meta, "batchNextDomain", plan.nextDomain);
      input.assertCurrent?.();
      return { plan, claim, proof, timerDependencies: records.timerDependencies };
    });
  }

  function savedClaimRecoveryQueues(saved, queues = null) {
    const sent = plainObject(saved?.sent) ? saved.sent : {};
    const retained = plainObject(queues) ? queues : {};
    return workspaceCore.DOMAINS.filter((domain) => {
      if (Array.isArray(sent[domain]) && sent[domain].length > 0) return true;
      return Array.isArray(retained[domain]) && retained[domain].length > 0;
    });
  }

  function savedClaimRecoveryMessage(saved, tr = (key, values, fallback) => fallback, queues = null) {
    const names = savedClaimRecoveryQueues(saved, queues);
    const list = names.length ? names.join(", ") : "sync queue";
    const fallback = `Saved sync request lacks original request bytes. Sync of ${list} remains blocked. Queued work is intact.`;
    try {
      return tr("sync.savedClaimBlocked", { queues: list }, fallback);
    } catch {
      return fallback;
    }
  }

  function discardUnrecoverableSavedClaim(database, input) {
    return workspaceTransaction.run(database, "readwrite", (records, transaction) => {
      assertWorkspaceContext(records, input);
      assertPersistedDisplayContext(records, input.deviceId);
      if (input?.confirmed !== true) {
        throw new Error("Discarding the unrecoverable saved claim requires explicit confirmation.");
      }
      const saved = records.outgoingSync;
      if (!saved?.sent) throw new Error("No unrecoverable saved sync claim is retained.");
      if (saved.body != null) throw new Error("Saved sync claim retains its original request body and must replay exactly.");
      if (saved.ownerId != null && saved.ownerId !== input.ownerId) throw new AccountOwnershipError();
      const meta = transaction.objectStore(META_STORE);
      meta.delete(OUTGOING_KEY);
      records.outgoingSync = undefined;
      const dependencies = migrateDependencyMetadata(records, input, transaction).timerDependencies;
      const plan = callWorkspaceCore("sync.batchPlan.v1", workspaceCore.batchRequest(
        records, records.deviceId, dependencies, records.batchNextDomain
      ));
      if (plan.status !== "planned") return { plan, claim: null, proof: records.deliveryProof };
      const sent = encodeSelectedBatch(workspaceCore.selectedRecords(plan, records));
      const retiredAt = new Date(input.localNowMs ?? Date.now()).toISOString();
      const claim = { claimId: globalThis.crypto.randomUUID(), sent, ownerId: input.ownerId,
        retiredAt, body: JSON.stringify({ deviceId: records.deviceId, lastRevision: records.snapshot.revision, ...sent }) };
      const proof = removeProofIds(records.deliveryProof, sent);
      workspaceTransaction.put(meta, DELIVERY_PROOF_KEY, proof);
      workspaceTransaction.put(meta, OUTGOING_KEY, claim);
      workspaceTransaction.put(meta, "batchNextDomain", plan.nextDomain);
      input.assertCurrent?.();
      return { plan, claim, proof, timerDependencies: records.timerDependencies };
    });
  }

  function setSharedCore(instance) {
    const methods = [
      "projectSynchronizedState", "planBootstrap", "reconcileSynchronizedState",
      "planTimerCompletion", "tickHlc"
    ];
    if (!instance || methods.some((method) => typeof instance[method] !== "function")) {
      throw new TypeError("A loaded shared core instance is required.");
    }
    sharedCore = instance;
    sharedAuthority = authorityModule.create(instance);
  }

  function storageAuthority(input) {
    if (typeof input?.sharedCore?.tickHlc === "function"
      && typeof input.sharedCore.planTimerCompletion === "function") {
      return authorityModule.create(input.sharedCore);
    }
    if (!sharedAuthority) throw new Error("Shared core is unavailable for completion and HLC policy.");
    return sharedAuthority;
  }

  function finishAppliedPlan(input) {
    return storageAuthority(input).finishAppliedPlan(input);
  }

  function sharedCoreAdapter(input, method, message) {
    const adapter = input?.sharedCore || sharedCore;
    if (!adapter || typeof adapter[method] !== "function") throw new Error(message);
    return adapter;
  }

  function plainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function projectedOperation(operation, fallbackDeviceId) {
    if (!plainObject(operation)) return operation;
    if (typeof operation.deviceId === "string" && operation.deviceId) return operation;
    return { ...operation, deviceId: fallbackDeviceId || "legacy-web" };
  }

  function projectionQueues(queues = {}, fallbackDeviceId = null) {
    return {
      commands: (queues.commands || []).map((item) => projectedOperation(item, fallbackDeviceId)),
      taskOperations: (queues.taskOperations || []).map((item) => projectedOperation(item, fallbackDeviceId)),
      durationOperations: (queues.durationOperations || []).map((item) => projectedOperation(item, fallbackDeviceId)),
      autoStartOperations: (queues.autoStartOperations || []).map((item) => projectedOperation(item, fallbackDeviceId)),
      selectedTaskOperations: (queues.selectedTaskOperations || []).map((item) => projectedOperation(item, fallbackDeviceId))
    };
  }

  function projectionBase(snapshot = null) {
    const history = Array.isArray(snapshot?.history) ? snapshot.history : [];
    let canonicalTimer = plainObject(snapshot?.canonicalTimer) && snapshot.canonicalTimer.id
      ? snapshot.canonicalTimer
      : null;
    return {
      canonicalTimer,
      history,
      tasks: Array.isArray(snapshot?.tasks) ? snapshot.tasks : [],
      durationsMs: plainObject(snapshot?.durationsMs)
        ? snapshot.durationsMs
        : DEFAULT_DURATIONS_MS,
      autoStartBreaks: snapshot?.autoStartBreaks === true,
      selectedTaskId: typeof snapshot?.selectedTaskId === "string" && snapshot.selectedTaskId
        ? snapshot.selectedTaskId
        : null
    };
  }

  function validateCanonicalTimer(timer) {
    if (timer === null) return;
    if (!plainObject(timer)
      || typeof timer.id !== "string" || !timer.id
      || !["focus", "short_break", "long_break"].includes(timer.phase)
      || !["running", "paused", "completed", "cancelled", "superseded"].includes(timer.status)
      || !Number.isSafeInteger(timer.plannedDurationMs)
      || !Number.isSafeInteger(timer.elapsedAtAnchorMs)
      || typeof timer.anchorAt !== "string") {
      throw new Error("Shared core returned an invalid canonical timer.");
    }
  }

  function validateProjectionShape(value) {
    const expectedKeys = [
      "autoStartBreaks",
      "canonicalTimer",
      "durationsMs",
      "history",
      "selectedTaskId",
      "tasks",
      "timerOutcomes",
      "winningOperationIds"
    ];
    if (!plainObject(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)) {
      throw new Error("Shared core returned an invalid synchronized projection.");
    }
    validateCanonicalTimer(value.canonicalTimer);
    if (!Array.isArray(value.history) || value.history.some((item) => !plainObject(item))
      || !Array.isArray(value.tasks)
      || value.tasks.some((item) => !plainObject(item)
        || typeof item.id !== "string" || !item.id
        || typeof item.title !== "string" || !item.title)
      || !plainObject(value.durationsMs)
      || JSON.stringify(Object.keys(value.durationsMs).sort()) !== JSON.stringify(["focus", "long_break", "short_break"])
      || Object.values(value.durationsMs).some((durationMs) =>
        !Number.isSafeInteger(durationMs) || durationMs < 60_000 || durationMs > 14_400_000)
      || typeof value.autoStartBreaks !== "boolean"
      || value.selectedTaskId !== null && (typeof value.selectedTaskId !== "string" || !value.selectedTaskId)
      || value.selectedTaskId !== null && !value.tasks.some((task) => task.id === value.selectedTaskId)
      || !plainObject(value.timerOutcomes)
      || !plainObject(value.winningOperationIds)) {
      throw new Error("Shared core returned an invalid synchronized projection.");
    }
  }

  function validateProjectedTasks(tasks) {
    const taskIds = new Set();
    for (const task of tasks) {
      if (taskIds.has(task.id)) throw new Error("Shared core returned duplicate projected tasks.");
      taskIds.add(task.id);
    }
  }

  function validateTimerOutcomes(outcomes, commands) {
    const commandIds = (commands || []).map((command) => command.id).sort();
    if (JSON.stringify(Object.keys(outcomes).sort()) !== JSON.stringify(commandIds)) {
      throw new Error("Shared core returned incomplete timer outcomes.");
    }
    for (const outcome of Object.values(outcomes)) {
      if (!plainObject(outcome)
        || !["applied", "ignored", "rejected"].includes(outcome.outcome)
        || typeof outcome.reason !== "string") {
        throw new Error("Shared core returned an invalid timer outcome.");
      }
    }
  }

  function validateOperationWinners(winners, pending) {
    if (JSON.stringify(Object.keys(winners).sort()) !== JSON.stringify(["autoStart", "durations", "selectedTask", "tasks"])
      || !plainObject(winners.tasks) || !plainObject(winners.durations)
      || winners.autoStart !== null && (typeof winners.autoStart !== "string" || !winners.autoStart)
      || winners.selectedTask !== null && (typeof winners.selectedTask !== "string" || !winners.selectedTask)) {
      throw new Error("Shared core returned invalid operation winners.");
    }
    const taskOperations = new Map((pending.taskOperations || []).map((operation) => [operation.id, operation]));
    for (const [taskId, operationId] of Object.entries(winners.tasks)) {
      if (typeof operationId !== "string" || taskOperations.get(operationId)?.taskId !== taskId) {
        throw new Error("Shared core returned an invalid task winner.");
      }
    }
    const durationOperations = new Map((pending.durationOperations || []).map((operation) => [operation.id, operation]));
    for (const [phase, operationId] of Object.entries(winners.durations)) {
      if (!Object.hasOwn(DEFAULT_DURATIONS_MS, phase)
        || typeof operationId !== "string"
        || durationOperations.get(operationId)?.phase !== phase) {
        throw new Error("Shared core returned an invalid duration winner.");
      }
    }
    if (winners.autoStart !== null
      && !(pending.autoStartOperations || []).some((operation) => operation.id === winners.autoStart)) {
      throw new Error("Shared core returned an invalid auto-start winner.");
    }
    if (winners.selectedTask !== null
      && !(pending.selectedTaskOperations || []).some((operation) => operation.id === winners.selectedTask)) {
      throw new Error("Shared core returned an invalid selected-task winner.");
    }
  }

  function validateProjectionOutput(value, pending) {
    validateProjectionShape(value);
    validateProjectedTasks(value.tasks);
    validateTimerOutcomes(value.timerOutcomes, pending.commands);
    validateOperationWinners(value.winningOperationIds, pending);
    return value;
  }

  function projectState(input) {
    const dispatcher = sharedCoreAdapter(
      input,
      "projectSynchronizedState",
      "Shared core is unavailable for synchronized projection."
    );
    if (!Number.isSafeInteger(input?.nowMs) || input.nowMs < 0) {
      throw new RangeError("Synchronized projection time is invalid.");
    }
    const pending = projectionQueues(input.queues, input.deviceId);
    const value = typeof dispatcher.call === "function" ? dispatcher.call("workspace.project.v1", {
      base: workspaceCore.base(input.snapshot), local: pending, now: new Date(input.nowMs).toISOString(),
      canonicalHead: input.canonicalHead ?? null, neverSent: input.deliveryProof ?? {},
      timerDependencies: input.timerDependencies ?? [],
      displayContext: { profile: "pwaStorage", projectionPending: input.projectionPending ?? null }
    }).workspace : dispatcher.projectSynchronizedState({
      base: projectionBase(input.snapshot),
      pending,
      now: new Date(input.nowMs).toISOString()
    });
    return validateProjectionOutput(value, pending);
  }

  function validateBootstrapPlan(value) {
    if (!plainObject(value) || !["auto", "choose", "normal_sync"].includes(value.mode)) {
      throw new Error("Shared core returned an invalid bootstrap plan.");
    }
    const expectedKeys = value.mode === "choose"
      ? ["localHistoryCount", "mode", "remoteHistoryCount"]
      : value.strategy == null
        ? ["mode", "reason"]
        : ["mode", "reason", "strategy"];
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)
      || value.mode === "choose" && (!Number.isSafeInteger(value.localHistoryCount)
        || value.localHistoryCount < 0
        || !Number.isSafeInteger(value.remoteHistoryCount)
        || value.remoteHistoryCount < 0)
      || value.mode !== "choose" && (typeof value.reason !== "string" || !value.reason)
      || value.strategy != null && !["keep_remote", "replace_remote", "merge"].includes(value.strategy)) {
      throw new Error("Shared core returned an invalid bootstrap plan.");
    }
    return value;
  }

  function bootstrapPlan(input) {
    const dispatcher = sharedCoreAdapter(
      input,
      "planBootstrap",
      "Shared core is unavailable for bootstrap planning."
    );
    return validateBootstrapPlan(dispatcher.planBootstrap({
      localOwnerId: input.localOwnerId || null,
      currentUserId: input.currentUserId || null,
      localHistory: Array.isArray(input.localHistory) ? input.localHistory : [],
      remoteHistory: Array.isArray(input.remoteHistory) ? input.remoteHistory : [],
      hasLocalState: input.hasLocalState === true,
      hasRemoteState: input.hasRemoteState === true
    }));
  }

  class LegacyDependencyRecoveryError extends Error {
    constructor(plan) {
      super("Legacy timer dependencies need recovery. Retained operations and saved requests remain unchanged.");
      this.name = "LegacyDependencyRecoveryError";
      this.recovery = plan.recovery;
    }
  }

  function dependencyPlan(records, deviceId, nowMs, expectedOwnerId = core.accountOwnerId(records.snapshot?.user)) {
    return callWorkspaceCore("workspace.legacyDependencyPlan.v1", workspaceCore.dependencyRequest(
      records, deviceId || records.deviceId || "legacy-web", expectedOwnerId,
      core.accountOwnerId(records.snapshot?.user), nowMs ?? Date.now()
    ));
  }

  function validatedTimerDependencies(records, deviceId, nowMs) {
    if (records.timerDependencies != null) return records.timerDependencies;
    const plan = dependencyPlan(records, deviceId, nowMs);
    if (plan.outcome === "blocked") throw new LegacyDependencyRecoveryError(plan);
    return plan.timerDependencies;
  }

  function migrateDependencyMetadata(records, input, transaction) {
    if (records.timerDependencies != null) return { timerDependencies: records.timerDependencies, metadataWrites: [] };
    return writeDependencyMigration(records, input, transaction);
  }

  function writeDependencyMigration(records, input, transaction) {
    const expectedOwnerId = Object.hasOwn(input, "expectedUserId") ? input.expectedUserId : input.ownerId ?? null;
    const plan = dependencyPlan(records, records.deviceId || input.deviceId, input.nowMs ?? input.localNowMs, expectedOwnerId);
    if (plan.outcome === "blocked") throw new LegacyDependencyRecoveryError(plan);
    input.assertCurrent?.();
    for (const write of plan.metadataWrites) {
      if (write.kind !== "recordTimerDependencies") throw new Error("Unsupported legacy dependency write.");
      workspaceTransaction.put(transaction.objectStore(META_STORE), "timerDependencies", write.value);
    }
    records.timerDependencies = plan.timerDependencies;
    return plan;
  }

  function validateProjectionPending(pending) {
    if (!plainObject(pending)) throw new Error("Shared core returned an invalid projectionPending.");
    const queues = projectionPendingQueues(pending);
    for (const items of Object.values(queues)) {
      if (!Array.isArray(items)) throw new Error("Shared core returned an invalid projectionPending.");
    }
  }

  function projectionPendingQueues(pending) {
    return {
      commands: pending.commands || [],
      taskOperations: pending.taskOperations || [],
      durationOperations: pending.durationOperations || [],
      autoStartOperations: pending.autoStartOperations || [],
      selectedTaskOperations: pending.selectedTaskOperations || []
    };
  }

  function emptyDeliveryProof() {
    return {
      commands: [], taskOperations: [], durationOperations: [],
      autoStartOperations: [], selectedTaskOperations: []
    };
  }

  function sanitizeDeliveryProof(proof) {
    const clean = emptyDeliveryProof();
    if (!plainObject(proof)) return clean;
    for (const queue of Object.keys(clean)) {
      if (!Array.isArray(proof[queue])) continue;
      clean[queue] = [...new Set(proof[queue].filter((id) => typeof id === "string" && id))];
    }
    return clean;
  }

  function addProofId(proof, queue, id) {
    const clean = sanitizeDeliveryProof(proof);
    if (typeof id === "string" && id && !clean[queue].includes(id)) clean[queue].push(id);
    return clean;
  }

  function removeProofIds(proof, sent) {
    const clean = sanitizeDeliveryProof(proof);
    const drop = (queue, items) => {
      const ids = new Set((items || []).map((item) => item.id));
      clean[queue] = clean[queue].filter((id) => !ids.has(id));
    };
    drop("commands", sent?.commands);
    drop("taskOperations", sent?.taskOperations);
    drop("durationOperations", sent?.durationOperations);
    drop("autoStartOperations", sent?.autoStartOperations);
    drop("selectedTaskOperations", sent?.selectedTaskOperations);
    return clean;
  }

  function neverSentFromProof(proof, local, sent) {
    const clean = sanitizeDeliveryProof(proof);
    const sentIds = {
      commands: new Set((sent?.commands || []).map((item) => item.id)),
      taskOperations: new Set((sent?.taskOperations || []).map((item) => item.id)),
      durationOperations: new Set((sent?.durationOperations || []).map((item) => item.id)),
      autoStartOperations: new Set((sent?.autoStartOperations || []).map((item) => item.id)),
      selectedTaskOperations: new Set((sent?.selectedTaskOperations || []).map((item) => item.id))
    };
    const localIds = {
      commands: new Set((local?.commands || []).map((item) => item.id)),
      taskOperations: new Set((local?.taskOperations || []).map((item) => item.id)),
      durationOperations: new Set((local?.durationOperations || []).map((item) => item.id)),
      autoStartOperations: new Set((local?.autoStartOperations || []).map((item) => item.id)),
      selectedTaskOperations: new Set((local?.selectedTaskOperations || []).map((item) => item.id))
    };
    const result = emptyDeliveryProof();
    for (const queue of Object.keys(result)) {
      result[queue] = clean[queue].filter((id) => localIds[queue].has(id) && !sentIds[queue].has(id));
    }
    return result;
  }

  function reconciledQueues(value) {
    return {
      commands: value.pending,
      taskOperations: value.pendingTaskOperations,
      durationOperations: value.pendingDurationOperations,
      autoStartOperations: value.pendingAutoStartOperations,
      selectedTaskOperations: value.pendingSelectedTaskOperations
    };
  }

  function cloneOutgoing(sent) {
    return JSON.parse(JSON.stringify({
      commands: sent?.commands || [], taskOperations: sent?.taskOperations || [],
      durationOperations: sent?.durationOperations || [],
      autoStartOperations: sent?.autoStartOperations || [],
      selectedTaskOperations: sent?.selectedTaskOperations || []
    }));
  }

  function outgoingMatchesStored(outgoing, sent) {
    if (!outgoing?.sent) return true;
    const sameItems = (previous, current) => {
      const rebuilt = new Map((current || []).map((item) => [item.id, item]));
      for (const item of previous || []) {
        if (JSON.stringify(rebuilt.get(item.id)) !== JSON.stringify(item)) return false;
      }
      return true;
    };
    return sameItems(outgoing.sent.commands, sent?.commands)
      && sameItems(outgoing.sent.taskOperations, sent?.taskOperations)
      && sameItems(outgoing.sent.durationOperations, sent?.durationOperations)
      && sameItems(outgoing.sent.autoStartOperations, sent?.autoStartOperations)
      && sameItems(outgoing.sent.selectedTaskOperations, sent?.selectedTaskOperations);
  }

  function captureSyncClaim(claim, sent, ownerId, deviceId) {
    if (!plainObject(claim) || typeof claim.body !== "string" || !core.validDateTime(claim.retiredAt)
      || claim.claimId != null && (typeof claim.claimId !== "string" || !claim.claimId)
      || !plainObject(claim.sent) || !workspaceCore.recordsEqual(claim.sent, sent)) {
      throw new TypeError("An exact captured sync claim is required.");
    }
    if (claim.ownerId !== ownerId) throw new AccountOwnershipError();
    const body = JSON.parse(claim.body);
    if (body.deviceId !== deviceId || !Number.isSafeInteger(body.lastRevision) || body.lastRevision < 0
      || workspaceCore.DOMAINS.some((domain) => !Array.isArray(body[domain])
        || !workspaceCore.recordsEqual(body[domain], sent[domain]))) {
      throw new Error("Captured request bytes disagree with the acknowledged sync claim.");
    }
    return JSON.parse(JSON.stringify(claim));
  }

  function sanitizeCanonicalHead(head) {
    if (!plainObject(head)) return null;
    const wallMs = Number(head.wallMs);
    const counter = Number(head.counter);
    if (!Number.isSafeInteger(wallMs) || wallMs <= 0) return null;
    if (!Number.isSafeInteger(counter) || counter < 0) return null;
    return { wallMs, counter };
  }

  function sanitizeProjectionPending(value) {
    // Keep the legacy exported name, but never repair persisted validator input.
    return value ?? null;
  }

  function reconcileState(input) {
    const dispatcher = sharedCoreAdapter(
      input,
      "reconcileSynchronizedState",
      "Shared core is unavailable for synchronized reconciliation."
    );
    const local = projectionQueues(input.queues, input.deviceId);
    const sent = input.sent || {};
    const neverSent = input.neverSent || neverSentFromProof(input.deliveryProof, local, sent);
    const value = dispatcher.reconcileSynchronizedState({
      local,
      sent,
      response: input.response,
      timerDependencies: input.timerDependencies ?? [],
      neverSent,
      displayContext: { profile: "pwaStorage", projectionPending: input.projectionPending ?? null }
    });
    if (value?.schemaVersion !== 3 || !plainObject(value.canonicalResponse) || !plainObject(value.workspace)) {
      throw new Error("Core returned an invalid reconciliation envelope for terminal-aware v3.");
    }
    const queues = reconciledQueues(value);
    return { ...value, queues, projection: value.workspace, neverSent };
  }

  const RESOLUTION_ACKNOWLEDGEMENTS = Object.freeze([
    ["commands", "acknowledgements", "commandId"],
    ["taskOperations", "taskAcknowledgements", "operationId"],
    ["durationOperations", "durationAcknowledgements", "operationId"],
    ["autoStartOperations", "autoStartAcknowledgements", "operationId"],
    ["selectedTaskOperations", "selectedTaskAcknowledgements", "operationId"]
  ]);

  function keepRemoteReconciliation(input) {
    core.validateAcknowledgements(input.response, input.sent);
    const sent = { ...input.sent };
    const response = { ...input.response };
    for (const [queueField, responseField, identifierField] of RESOLUTION_ACKNOWLEDGEMENTS) {
      const capturedIds = new Set(input.queueIds?.[queueField] || []);
      const captured = (input.queues?.[queueField] || []).filter((item) => capturedIds.has(item.id));
      sent[queueField] = captured;
      response[responseField] = captured.map((item) => ({
        [identifierField]: item.id,
        outcome: "rejected",
        reason: "keep_remote"
      }));
    }
    return { ...input, sent, response };
  }

  function reconcileResolution(input) {
    const shaped = input.sent?.strategy === "keep_remote"
      ? keepRemoteReconciliation(input)
      : input;
    return reconcileState({
      queues: shaped.queues,
      sent: shaped.sent,
      response: shaped.response,
      deviceId: shaped.deviceId,
      timerDependencies: shaped.timerDependencies ?? [],
      neverSent: shaped.sent?.strategy === "keep_remote" ? neverSentFromProof(shaped.deliveryProof, shaped.queues, shaped.sent) : shaped.neverSent,
      deliveryProof: shaped.deliveryProof,
      projectionPending: shaped.projectionPending,
      sharedCore: shaped.sharedCore
    });
  }

  function reconcileResolutionState(input) {
    const pending = input.pendingResolution;
    if (!plainObject(pending) || !plainObject(pending.payload)) {
      throw new TypeError("A captured bootstrap resolution is required.");
    }
    return reconcileResolution({
      queues: input.queues,
      queueIds: pending.queueIds,
      sent: pending.payload,
      response: input.response,
      deviceId: input.deviceId,
      neverSent: input.neverSent,
      deliveryProof: input.deliveryProof,
      projectionPending: input.projectionPending,
      sharedCore: input.sharedCore
    });
  }

  class BootstrapGateError extends Error {
    constructor(message = "History resolution blocks local changes.") {
      super(message);
      this.name = "BootstrapGateError";
    }
  }

  class ResolutionLimitError extends Error {
    constructor(violation) {
      const labels = {
        commands: "timer commands",
        taskOperations: "task operations",
        durationOperations: "duration operations",
        autoStartOperations: "auto-start operations",
        selectedTaskOperations: "selected-task operations",
        oversized: "operations"
      };
      const message = violation.field === "blocked_dependency"
        ? "Atomic history request waits for retained timer acknowledgements. No partial request was saved."
        : `Cannot upload ${violation.count.toLocaleString("en-US")} queued ${labels[violation.field]}; server limit is ${violation.limit.toLocaleString("en-US")}. Keep Remote can discard local queued data without uploading it.`;
      super(message);
      this.name = "ResolutionLimitError";
      this.field = violation.field;
      this.count = violation.count;
      this.limit = violation.limit;
    }
  }

  class AccountOwnershipError extends Error {
    constructor(message = "Canonical account changed before sync apply.") {
      super(message);
      this.name = "AccountOwnershipError";
    }
  }

  function assertAccountOwnership(snapshot, expectedUserId = null) {
    const ownerId = core.accountOwnerId(snapshot?.user);
    if (expectedUserId !== null && (typeof expectedUserId !== "string" || !expectedUserId)
      || ownerId !== expectedUserId) {
      throw new AccountOwnershipError("Local account changed. Revalidate the session before making changes.");
    }
  }

  class ClockRangeError extends Error {
    constructor() {
      super("Local clock or sequence is outside the synchronization range.");
      this.name = "ClockRangeError";
    }
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error("Storage transaction aborted."));
      transaction.onerror = () => reject(transaction.error);
    });
  }

  function leaseValue(token, nowMs, leaseMs) {
    return { token, acquiredAtMs: nowMs, expiresAtMs: nowMs + leaseMs };
  }

  function leaseIsLive(gate, nowMs) {
    return Boolean(gate?.token && Number(gate.expiresAtMs) > nowMs);
  }

  function laterHlc(left, right) {
    return callWorkspaceCore("hlc.head.v1", { physicalNowMs: 0, observed: [left, right].filter((clock) => clock != null) });
  }

  function latestClockOffset(stored, incoming) {
    if (incoming == null) return core.validClockSample(stored) ? stored : null;
    if (!core.validClockSample(incoming)) throw new ClockRangeError();
    if (core.validClockSample(stored)) {
      if (stored.requestSequence > incoming.requestSequence
        || stored.requestSequence === incoming.requestSequence
          && (stored.receivedAtWallMs > incoming.receivedAtWallMs
            || stored.receivedAtWallMs === incoming.receivedAtWallMs
              && stored.uncertaintyMs <= incoming.uncertaintyMs)) {
        return stored;
      }
    }
    return incoming;
  }

  function putLatestClockOffset(metaStore, stored, incoming) {
    const latest = latestClockOffset(stored, incoming);
    if (latest === incoming) metaStore.put({ key: CLOCK_OFFSET_KEY, value: incoming });
    return latest;
  }

  function assertStorageContext(results, input = {}) {
    input.assertCurrent?.();
    if (Object.prototype.hasOwnProperty.call(input, "expectedUserId")) {
      assertAccountOwnership(results.snapshot?.value, input.expectedUserId);
    }
    const target = results.gate?.value?.accountOwnerId;
    if (target && input.currentUserId && target !== input.currentUserId) throw new AccountOwnershipError();
  }

  function accountMetadataMutation(database, input, keys, change) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(workspaceTransaction.STORES, "readwrite");
      const store = transaction.objectStore(META_STORE);
      const requests = mutationContextRequests(transaction, Object.fromEntries([...new Set(keys)]
        .map((key) => [key, store.get(key)])));
      let outcome;
      let failure;
      const results = {};
      collectTransactionRequests(requests, results, () => {
        assertStorageContext(results, input);
        assertResponseDisplayContext(results, input.deviceId);
        outcome = change(store, results);
      }, (error) => { failure = error; transaction.abort(); });
      transaction.oncomplete = () => resolve(outcome);
      transaction.onabort = () => reject(failure || transaction.error || new Error("Storage transaction aborted."));
      transaction.onerror = () => {};
    });
  }

  function allocateClockRequestSequence(database, input = {}) {
    return accountMetadataMutation(database, input, [CLOCK_REQUEST_SEQUENCE_KEY], (store, results) => {
      const sequence = (Number(results[CLOCK_REQUEST_SEQUENCE_KEY]?.value) || 0) + 1;
      if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new ClockRangeError();
      store.put({ key: CLOCK_REQUEST_SEQUENCE_KEY, value: sequence });
      return sequence;
    });
  }

  function saveClockOffset(database, sample, input = {}) {
    return accountMetadataMutation(database, input, [CLOCK_OFFSET_KEY], (store, results) =>
      putLatestClockOffset(store, results[CLOCK_OFFSET_KEY]?.value || null, sample));
  }

  function acquireBootstrapGate(database, input) {
    return accountMetadataMutation(database, { ...input, currentUserId: null }, [], (store, results) => {
      const existing = results.gate?.value || null;
      let resolution = results.resolution?.value || null;
      if (existing?.accountOwnerId && input.currentUserId && existing.accountOwnerId !== input.currentUserId) {
        return { acquired: false, takenOver: false, gate: existing, resolution };
      }
      if (existing?.token !== input.token && leaseIsLive(existing, input.nowMs)) {
        return { acquired: false, takenOver: false, gate: existing, resolution };
      }
      const gate = boundBootstrapLease(input.token, input);
      const takenOver = Boolean(existing && existing.token !== input.token);
      if (resolution && resolution.gateToken !== input.token) {
        resolution = { ...resolution, gateToken: input.token };
        store.put({ key: RESOLUTION_KEY, value: resolution });
      }
      store.put({ key: GATE_KEY, value: gate });
      return { acquired: true, takenOver, gate, resolution };
    });
  }

  function boundBootstrapLease(token, input) {
    return { ...leaseValue(token, input.nowMs, input.leaseMs),
      ...(input.currentUserId ? { accountOwnerId: input.currentUserId } : {}) };
  }

  async function acquireBootstrapGateWithLegacyAutoStart(database, input) {
    const gate = await acquireBootstrapGate(database, input);
    if (!gate.acquired || gate.resolution) return gate;
    const legacyAutoStartMigration = await migrateLegacyAutoStart(database, {
      ...input, operationId: input.legacyAutoStartOperationId,
      nowMs: input.nowMs
    });
    const legacySelectedTaskMigration = await migrateLegacySelectedTask(database, {
      ...input, operationId: input.legacySelectedTaskOperationId,
      nowMs: input.nowMs
    });
    return { ...gate, legacyAutoStartMigration, legacySelectedTaskMigration };
  }

  async function readBootstrapState(database) {
    const transaction = database.transaction(META_STORE, "readonly");
    const store = transaction.objectStore(META_STORE);
    const [gate, resolution] = await Promise.all([
      requestResult(store.get(GATE_KEY)),
      requestResult(store.get(RESOLUTION_KEY))
    ]);
    return {
      gate: gate?.value || null,
      resolution: resolution?.value || null
    };
  }

  function clearBootstrapGate(database, token, input = {}) {
    return accountMetadataMutation(database, input, [], (store, results) => {
      if (results.resolution) throw new BootstrapGateError("Saved history resolution still requires completion.");
      if (results.gate?.value?.token !== token) throw new BootstrapGateError("Bootstrap gate is owned by another tab.");
      store.delete(GATE_KEY);
      return true;
    });
  }

  function guardedMutation(database, storeNames, operation, input = {}) {
    const expectedUserId = input.expectedUserId ?? null;
    return new Promise((resolve, reject) => {
      const names = [...new Set([...workspaceTransaction.STORES, ...storeNames])];
      const transaction = database.transaction(names, "readwrite");
      const outcome = { value: undefined };
      let failure = null;
      const requests = mutationContextRequests(transaction);
      collectRequestResults(requests, (results) => {
        try {
          if (!input.allowBootstrap && (results.gate || results.resolution)) throw new BootstrapGateError();
          assertStorageContext(results, input);
          assertAccountOwnership(results.snapshot?.value, expectedUserId);
          assertResponseDisplayContext(results, input.deviceId);
          operation(transaction, outcome, (error) => {
            failure = error;
            transaction.abort();
          }, results);
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      });
      transaction.oncomplete = () => resolve(outcome.value);
      transaction.onabort = () => reject(failure || transaction.error || new Error("Storage transaction aborted."));
      transaction.onerror = () => {};
    });
  }

  function collectRequestResults(requests, onComplete) {
    const results = {};
    let remaining = Object.keys(requests).length;
    for (const [name, request] of Object.entries(requests)) {
      request.onsuccess = () => {
        results[name] = request.result;
        remaining -= 1;
        if (remaining === 0) onComplete(results);
      };
    }
  }

  function ownershipPlan(records, input, action) {
    return callWorkspaceCore("workspace.ownershipPlan.v1", {
      profile: "pwaStorage", action, workspace: workspaceRecords({ ...records, deviceId: input.deviceId }),
      ownership: records.timerOwner ?? null, localDeviceId: input.deviceId, localTabId: input.tabId,
      clock: action.kind === "release" ? { nowMs: input.nowMs }
        : { nowMs: input.nowMs, leaseDurationMs: input.leaseMs }
    });
  }

  function transactionWorkspace(results, snapshot = results.snapshot?.value, queues = results, overrides = {}) {
    return { snapshot, deviceId: results.deviceId?.value,
      projectionPending: results.projectionPending?.value, canonicalHead: results.canonicalHead?.value,
      deliveryProof: results.deliveryProof?.value, outgoing: results.outgoing?.value,
      timerDependencies: results.timerDependencies?.value, timerOwner: results.timerOwner?.value,
      sourceAcknowledgements: results.sourceAcknowledgements?.value,
      ...Object.fromEntries(workspaceCore.DOMAINS.map((domain) => [domain, queues[domain] || []])), ...overrides };
  }

  function migrateLegacyPreferences(database, input = {}) {
    return guardedMutation(database, [], (transaction, outcome, _abort, results) => {
      const records = { ...transactionWorkspace(results), settings: results.settings?.value || {} };
      const ownerId = core.accountOwnerId(records.snapshot?.user);
      const deviceId = results.deviceId?.value || input.deviceId || "legacy-web";
      migrateDependencyMetadata(records, { ...input, deviceId }, transaction);
      const plan = callWorkspaceCore("workspace.legacyPreferences.v1", workspaceCore.preferenceRequest(records,
        deviceId, input.expectedUserId ?? null, ownerId, Date.now(),
        input.operationUuids || Array.from({ length: 5 }, () => globalThis.crypto.randomUUID())));
      input.assertCurrent?.();
      workspaceTransaction.writeLegacyPreferences(transaction, plan);
      outcome.value = plan;
    }, { ...input, allowBootstrap: true });
  }

  function migrateLegacyDependencies(database, input = {}) {
    return guardedMutation(database, [], (transaction, outcome, _abort, results) => {
      const records = transactionWorkspace(results);
      outcome.value = writeDependencyMigration(records, input, transaction);
    }, { ...input, allowBootstrap: true });
  }

  function installationOwnership(input, results, rebased = null) {
    const claim = input.timerOwnerClaim;
    if (!claim) return { ownershipWrites: [] };
    const records = rebased ? transactionWorkspace(results, input.snapshot, rebased.queues ?? results, {
      projectionPending: rebased.projectionPending, timerDependencies: rebased.timerDependencies,
      canonicalHead: input.serverHlc ?? results.canonicalHead?.value,
      deliveryProof: neverSentFromProof(results.deliveryProof?.value, rebased.queues ?? results, input.reconciliation?.sent),
      outgoing: null
    }) : transactionWorkspace(results);
    return ownershipPlan(records, claim, { kind: "install" });
  }

  function responseTransactionRebase(input, results, discardedQueueIds = null) {
    if (!input.reconciliation) {
      return {
        queues: input.retainedQueues,
        droppedCommandIds: input.dropCommandIds || [],
        droppedTimerIds: input.dropTimerIds || [],
        projectionPending: null
      };
    }
    const storedQueues = {
      commands: results.commands || [],
      taskOperations: results.taskOperations || [],
      durationOperations: results.durationOperations || [],
      autoStartOperations: results.autoStartOperations || [],
      selectedTaskOperations: results.selectedTaskOperations || []
    };
    const proof = results.deliveryProof?.value || null;
    const neverSent = neverSentFromProof(proof, storedQueues, input.reconciliation.sent);
    const dependencies = validatedTimerDependencies({ ...transactionWorkspace(results), ...storedQueues },
      input.reconciliation.deviceId, Date.parse(input.reconciliation.response.serverTime));
    const rebased = discardedQueueIds
      ? reconcileResolution({
        queues: storedQueues,
        queueIds: discardedQueueIds,
        deliveryProof: proof,
        ...input.reconciliation, neverSent, timerDependencies: dependencies,
        projectionPending: results.projectionPending?.value ?? null
      })
      : reconcileState({
        queues: storedQueues,
        deliveryProof: proof,
        ...input.reconciliation, neverSent, timerDependencies: dependencies,
        projectionPending: results.projectionPending?.value ?? null
      });
    return {
      queues: rebased.queues,
      droppedCommandIds: rebased.droppedTimerOperationIds,
      droppedTimerIds: rebased.droppedTimerIds,
      projectionPending: rebased.displayContext.projectionPending,
      timerDependencies: rebased.pendingTimerDependencies, projection: rebased.projection,
      canonicalResponse: rebased.canonicalResponse, workspace: rebased.workspace
    };
  }

  function retainedObservation(observation, queues) {
    if (!observation) return null;
    const retainedIds = new Set((queues?.commands || []).map((command) => command.id));
    return { ...observation, commandTimes: Object.fromEntries(Object.entries(observation.commandTimes || {})
      .filter(([id]) => retainedIds.has(id))) };
  }

  function collectTransactionRequests(requests, results, onReady, onFailure) {
    let remaining = Object.keys(requests).length;
    for (const [name, request] of Object.entries(requests)) {
      request.onsuccess = () => {
        results[name] = request.result;
        remaining -= 1;
        if (remaining !== 0) return;
        try {
          onReady();
        } catch (error) {
          onFailure(error);
        }
      };
    }
  }

  function renewTimerOwnership(database, input) {
    return guardedMutation(database, [PENDING_STORE], (transaction, outcome, abort) => {
      const results = {};
      outcome.value = false;
      collectTransactionRequests(syncResponseRequests(transaction), results, () => {
        input.assertCurrent?.();
        const plan = ownershipPlan(transactionWorkspace(results), input, { kind: "renew", timerId: input.timerId });
        input.assertCurrent?.();
        workspaceTransaction.writeOwnership(transaction.objectStore(META_STORE), plan.ownershipWrites);
        outcome.value = plan.renewed;
      }, abort);
    }, { ...input, allowBootstrap: true });
  }

  function releaseTimerOwnership(database, input) {
    return guardedMutation(database, [], (transaction, outcome, abort) => {
      const results = {};
      collectTransactionRequests(syncResponseRequests(transaction), results, () => {
        input.assertCurrent?.();
        const plan = ownershipPlan(transactionWorkspace(results), input, { kind: "release" });
        input.assertCurrent?.();
        workspaceTransaction.writeOwnership(transaction.objectStore(META_STORE), plan.ownershipWrites);
      }, abort);
    }, { ...input, allowBootstrap: true });
  }

  function resolutionCaptureRequests(transaction) {
    const metaStore = transaction.objectStore(META_STORE);
    return {
      snapshot: metaStore.get("snapshot"),
      gate: metaStore.get(GATE_KEY),
      resolution: metaStore.get(RESOLUTION_KEY),
      deliveryProof: metaStore.get(DELIVERY_PROOF_KEY), outgoing: metaStore.get(OUTGOING_KEY),
      projectionPending: metaStore.get(PROJECTION_PENDING_KEY), canonicalHead: metaStore.get(CANONICAL_HEAD_KEY),
      timerDependencies: metaStore.get("timerDependencies"),
      commands: transaction.objectStore(PENDING_STORE).getAll(),
      taskOperations: transaction.objectStore(TASK_PENDING_STORE).getAll(),
      durationOperations: transaction.objectStore(DURATION_PENDING_STORE).getAll(),
      autoStartOperations: transaction.objectStore(AUTO_START_PENDING_STORE).getAll(),
      selectedTaskOperations: transaction.objectStore(SELECTED_TASK_PENDING_STORE).getAll()
    };
  }

  function validateResolutionCapture(results, input, options) {
    assertStorageContext(results, { ...options, currentUserId: input.userId });
    const gate = results.gate?.value || null;
    if (!gate || gate.token !== options.gateToken) {
      throw new BootstrapGateError("Bootstrap gate is owned by another tab.");
    }
    const existingResolution = results.resolution?.value || null;
    if (existingResolution && options.replaceExisting && existingResolution.deliveryState !== "neverSent") {
      throw new BootstrapGateError("Possibly delivered history request cannot be replaced without non-delivery evidence.");
    }
    if (existingResolution && !options.replaceExisting) {
      throw new BootstrapGateError("Saved history resolution already exists.");
    }
    if (existingResolution && (existingResolution.gateToken !== options.gateToken
      || typeof input.requestId !== "string" || !input.requestId
      || input.requestId === existingResolution.payload?.requestId)) {
      throw new BootstrapGateError("Saved history resolution replacement requires its owner and a fresh request ID.");
    }
  }

  function createCapturedResolution(transaction, results, input, options) {
    validateResolutionCapture(results, input, options);
    assertResponseDisplayContext(results, input.deviceId);
    const queues = { commands: results.commands || [], taskOperations: results.taskOperations || [],
      durationOperations: results.durationOperations || [], autoStartOperations: results.autoStartOperations || [],
      selectedTaskOperations: results.selectedTaskOperations || [] };
    const planningQueues = input.strategy === "keep_remote" ? core.emptyNeverSent() : queues;
    const plan = callWorkspaceCore("sync.batchPlan.v1", workspaceCore.batchRequest(
      planningQueues, input.deviceId, input.strategy === "keep_remote" ? [] : validatedTimerDependencies(
        transactionWorkspace(results), input.deviceId, Date.now()),
      "commands", input.strategy
    ));
    if (plan.status !== "planned") {
      throw new ResolutionLimitError({ field: plan.status, count: plan.total, limit: 8192 });
    }
    const selected = encodeSelectedBatch(workspaceCore.selectedRecords(plan, planningQueues));
    persistCapturedDurationEncoding(transaction, results, queues, selected.durationOperations);
    const payload = { requestId: input.requestId, deviceId: input.deviceId,
      expectedRevision: input.expectedRevision, strategy: input.strategy,
      commands: selected.commands, taskOperations: selected.taskOperations,
      durationOperations: selected.durationOperations, selectedTaskOperations: selected.selectedTaskOperations };
    if (queues.autoStartOperations.length || input.autoStartOperationsPresent) payload.autoStartOperations = selected.autoStartOperations;
    const pending = {
      userId: input.userId, payload, queueIds: Object.fromEntries(workspaceCore.DOMAINS.map((domain) =>
        [domain, queues[domain].map((item) => item.id)])), deliveryState: "neverSent",
      gateToken: options.gateToken,
      sourceOwnerId: core.accountOwnerId(results.snapshot?.value?.user) || null
    };
    transaction.objectStore(META_STORE).put({ key: RESOLUTION_KEY, value: pending });
    return pending;
  }

  function persistCapturedDurationEncoding(transaction, results, queues, encoded) {
    const proven = new Set(neverSentFromProof(results.deliveryProof?.value, queues,
      results.outgoing?.value?.sent).durationOperations);
    const retained = new Map(queues.durationOperations.map((operation) => [operation.id, operation]));
    if (encoded.some((operation) => operation.occurredAt !== retained.get(operation.id).occurredAt
      && !proven.has(operation.id))) {
      throw new BootstrapGateError("Possibly delivered legacy duration cannot be rewritten for history resolution.");
    }
    for (const operation of encoded) {
      const original = retained.get(operation.id);
      if (operation.occurredAt !== original.occurredAt) transaction.objectStore(DURATION_PENDING_STORE)
        .put({ ...original, occurredAt: operation.occurredAt });
    }
  }

  function captureResolution(database, input, options) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        [META_STORE, PENDING_STORE, TASK_PENDING_STORE, DURATION_PENDING_STORE, AUTO_START_PENDING_STORE, SELECTED_TASK_PENDING_STORE],
        "readwrite"
      );
      const requests = resolutionCaptureRequests(transaction);
      const results = {};
      let pending;
      let failure = null;
      collectTransactionRequests(requests, results, () => {
        pending = createCapturedResolution(transaction, results, input, options);
      }, (error) => {
        failure = error;
        transaction.abort();
      });
      transaction.oncomplete = () => resolve(pending);
      transaction.onabort = () => reject(failure || transaction.error || new Error("Storage transaction aborted."));
      transaction.onerror = () => {};
    });
  }

  async function readAccountBinding(database) {
    const transaction = database.transaction(META_STORE, "readonly");
    const store = transaction.objectStore(META_STORE);
    const [snapshot, gate] = await Promise.all([requestResult(store.get("snapshot")), requestResult(store.get(GATE_KEY))]);
    return { sourceOwnerId: core.accountOwnerId(snapshot?.value?.user) || null,
      gateOwnerId: gate?.value?.accountOwnerId || null };
  }

  function assertBootstrapAccountBinding(results, input) {
    const gateOwnerId = results.gate?.value?.accountOwnerId;
    if (!gateOwnerId || gateOwnerId === input.currentUserId) return;
    const binding = input.accountBinding;
    if (!binding || binding.ownerId !== input.currentUserId || binding.gateOwnerId !== gateOwnerId
      || binding.sourceOwnerId !== (core.accountOwnerId(results.snapshot?.value?.user) || null)) {
      throw new AccountOwnershipError();
    }
  }

  function invalidateForeignResolution(database, input) {
    const sourceFence = { ...input, currentUserId: null };
    return accountMetadataMutation(database, sourceFence, [], (store, results) => {
      assertBootstrapAccountBinding(results, input);
      let gate = results.gate?.value || null;
      let resolution = results.resolution?.value || null;
      if (gate?.token !== input.gateToken && leaseIsLive(gate, input.nowMs)) {
        return { acquired: false, invalidated: false, gate,
          resolution: resolution?.userId === input.currentUserId ? resolution : null };
      }
      const invalidated = Boolean(resolution && resolution.userId !== input.currentUserId);
      if (invalidated) {
        store.delete(RESOLUTION_KEY);
        resolution = null;
      } else if (resolution && resolution.gateToken !== input.gateToken) {
        resolution = { ...resolution, gateToken: input.gateToken };
        store.put({ key: RESOLUTION_KEY, value: resolution });
      }
      gate = boundBootstrapLease(input.gateToken, input);
      store.put({ key: GATE_KEY, value: gate });
      return { acquired: true, invalidated, resolution, gate };
    });
  }

  function validatePendingForSend(database, input) {
    return accountMetadataMutation(database, input, [DELIVERY_PROOF_KEY], (store, results) => {
      const resolution = results.resolution?.value || null;
      if (!input.pending || input.pending.userId !== input.currentUserId
        || !resolution || resolution.userId !== input.currentUserId
        || JSON.stringify(resolution) !== JSON.stringify(input.pending)) {
        throw new BootstrapGateError("Saved history resolution does not match current account.");
      }
      validateResolutionApply(results, input.pending);
      const plan = callWorkspaceCore("sync.batchPlan.v1", workspaceCore.savedBatchRequest(resolution.payload, resolution.payload.strategy));
      if (plan.status !== "replay_saved") throw new BootstrapGateError("Saved history request exceeds Core limits. Retained request remains blocked and unchanged.");
      const claimed = { ...resolution, deliveryState: "possiblyDelivered" };
      store.put({ key: RESOLUTION_KEY, value: claimed });
      store.put({ key: DELIVERY_PROOF_KEY, value: removeProofIds(results[DELIVERY_PROOF_KEY]?.value, resolution.payload) });
      store.put({ key: GATE_KEY, value: boundBootstrapLease(input.gateToken, input) });
      return claimed;
    });
  }

  function resolutionApplyRequests(transaction) {
    const metaStore = transaction.objectStore(META_STORE);
    return {
      gate: metaStore.get(GATE_KEY),
      resolution: metaStore.get(RESOLUTION_KEY),
      snapshot: metaStore.get("snapshot"),
      hlc: metaStore.get("hlc"),
      settings: metaStore.get("settings"),
      clockOffset: metaStore.get(CLOCK_OFFSET_KEY),
      timerOwner: metaStore.get(TIMER_OWNER_KEY),
      deliveryProof: metaStore.get(DELIVERY_PROOF_KEY),
      timerDependencies: metaStore.get("timerDependencies"),
      workspaceObservation: metaStore.get("workspaceObservation"),
      completionState: metaStore.get("completionState"), sourceAcknowledgements: metaStore.get("sourceAcknowledgements"),
      projectionPending: metaStore.get(PROJECTION_PENDING_KEY), canonicalHead: metaStore.get(CANONICAL_HEAD_KEY),
      outgoing: metaStore.get(OUTGOING_KEY),
      commands: transaction.objectStore(PENDING_STORE).getAll(),
      taskOperations: transaction.objectStore(TASK_PENDING_STORE).getAll(),
      durationOperations: transaction.objectStore(DURATION_PENDING_STORE).getAll(),
      autoStartOperations: transaction.objectStore(AUTO_START_PENDING_STORE).getAll(),
      selectedTaskOperations: transaction.objectStore(SELECTED_TASK_PENDING_STORE).getAll()
    };
  }

  function completeResolutionLegacyMigrations(metaStore, settingsRecord, pending) {
    const value = { ...(settingsRecord?.value || {}) };
    if (!Object.prototype.hasOwnProperty.call(pending.payload || {}, "autoStartOperations")) {
      delete value.autoStartBreaks;
      delete value.autoStartBreaksExplicit;
      value.autoStartSyncBootstrapped = true;
    }
    if (Object.prototype.hasOwnProperty.call(pending.payload || {}, "selectedTaskOperations")) {
      delete value.selectedTaskId;
      value.selectedTaskSyncBootstrapped = true;
    }
    metaStore.put({ key: "settings", value });
  }

  function staleResolutionOutcome(metaStore, results, pending, canonical) {
    const gate = results.gate?.value || null;
    const resolution = results.resolution?.value || null;
    const storedSnapshot = results.snapshot?.value || null;
    const isStaleSuccess = !resolution && !gate && core.accountOwnerId(storedSnapshot?.user) === pending.userId
      && Number(storedSnapshot.revision) >= Number(canonical.snapshot.revision);
    if (!isStaleSuccess) return null;
    completeResolutionLegacyMigrations(metaStore, results.settings, pending);
    const ownerPlan = installationOwnership(canonical, results);
    canonical.assertCurrent?.();
    workspaceTransaction.writeOwnership(metaStore, ownerPlan.ownershipWrites);
    const outcome = {
      applied: false,
      staleSuccess: true,
      snapshot: storedSnapshot,
      hlc: results.hlc?.value || canonical.hlc
    };
    outcome.clockOffset = putLatestClockOffset(
      metaStore,
      results.clockOffset?.value || null,
      canonical.clockOffset
    );
    return outcome;
  }

  function validateResolutionApply(results, pending) {
    assertStorageContext(results, { currentUserId: pending.userId,
      ...(Object.hasOwn(pending, "sourceOwnerId") ? { expectedUserId: pending.sourceOwnerId } : {}) });
    const resolution = results.resolution?.value || null;
    if (!resolution || JSON.stringify(resolution) !== JSON.stringify(pending)) {
      throw new BootstrapGateError("Saved history resolution changed before apply.");
    }
    const gate = results.gate?.value || null;
    if (!gate || gate.token !== pending.gateToken) {
      throw new BootstrapGateError("Bootstrap gate is owned by another tab.");
    }
  }

  function persistResolutionQueue(store, capturedIds, reconciled, exact) {
    if (exact) store.clear();
    else for (const id of capturedIds || []) store.delete(id);
    for (const item of reconciled || []) store.put(item);
  }

  function applyResolutionQueues(transaction, queueIds, canonical, rebased) {
    const exact = Boolean(canonical.reconciliation);
    const commands = exact ? rebased.queues.commands : canonical.promoteCommands;
    const pendingStore = transaction.objectStore(PENDING_STORE);
    persistResolutionQueue(pendingStore, queueIds.commands, commands, exact);
    if (!exact) for (const id of rebased.droppedCommandIds) pendingStore.delete(id);
    persistResolutionQueue(transaction.objectStore(TASK_PENDING_STORE), queueIds.taskOperations,
      rebased.queues?.taskOperations, exact);
    persistResolutionQueue(transaction.objectStore(DURATION_PENDING_STORE), queueIds.durationOperations,
      rebased.queues?.durationOperations, exact);
    persistResolutionQueue(transaction.objectStore(AUTO_START_PENDING_STORE), queueIds.autoStartOperations,
      rebased.queues?.autoStartOperations, exact);
    persistResolutionQueue(transaction.objectStore(SELECTED_TASK_PENDING_STORE), queueIds.selectedTaskOperations,
      rebased.queues?.selectedTaskOperations, exact);
  }

  function applyResolutionMetadata(metaStore, results, canonical) {
    metaStore.put({ key: "snapshot", value: canonical.snapshot });
    const clockOffset = putLatestClockOffset(
      metaStore,
      results.clockOffset?.value || null,
      canonical.clockOffset
    );
    const responseHlc = canonical.clockOffset != null && clockOffset === canonical.clockOffset
      ? canonical.hlc
      : canonical.serverHlc || canonical.hlc;
    const hlc = laterHlc(results.hlc?.value, responseHlc);
    metaStore.put({ key: "hlc", value: hlc });
    if (sanitizeCanonicalHead(canonical.serverHlc)) {
      metaStore.put({ key: CANONICAL_HEAD_KEY, value: sanitizeCanonicalHead(canonical.serverHlc) });
    }
    return { hlc, clockOffset };
  }

  function applyResolutionTimerOwner(metaStore, results, canonical, queueIds, rebased) {
    const plan = installationOwnership(canonical, results, rebased);
    canonical.assertCurrent?.();
    workspaceTransaction.writeOwnership(metaStore, plan.ownershipWrites);
  }

  function applyPendingResolution(transaction, results, pending, canonical) {
    canonical.assertCurrent?.();
    assertAccountOwnership(canonical.snapshot, pending.userId);
    assertResponseDisplayContext(results, pending.payload?.deviceId);
    const metaStore = transaction.objectStore(META_STORE);
    const staleOutcome = staleResolutionOutcome(metaStore, results, pending, canonical);
    if (staleOutcome) return staleOutcome;
    validateResolutionApply(results, pending);
    const queueIds = pending.queueIds || {};
    const rebased = responseTransactionRebase(canonical, results, queueIds);
    applyResolutionQueues(transaction, queueIds, canonical, rebased);
    completeResolutionLegacyMigrations(metaStore, results.settings, pending);
    const { hlc, clockOffset } = applyResolutionMetadata(metaStore, results, canonical);
    if (rebased.projectionPending) {
      metaStore.put({ key: PROJECTION_PENDING_KEY, value: rebased.projectionPending });
    } else {
      metaStore.delete(PROJECTION_PENDING_KEY);
    }
    applyResolutionTimerOwner(metaStore, results, canonical, queueIds, rebased);
    if (rebased.timerDependencies) metaStore.put({ key: "timerDependencies", value: rebased.timerDependencies });
    metaStore.put({ key: "workspaceObservation", value: retainedObservation(results.workspaceObservation?.value, rebased.queues) });
    if (rebased.queues) metaStore.put({ key: DELIVERY_PROOF_KEY,
      value: neverSentFromProof(results.deliveryProof?.value, rebased.queues, pending.payload) });
    metaStore.put({ key: "displayHistory", value: rebased.projection?.history || canonical.snapshot.history });
    metaStore.delete(OUTGOING_KEY);
    metaStore.delete(RESOLUTION_KEY);
    metaStore.delete(GATE_KEY);
    return { applied: true, staleSuccess: false, snapshot: canonical.snapshot, hlc, clockOffset };
  }

  function applyResolution(database, pending, canonical) {
    if (canonical.clockOffset != null && !core.validClockSample(canonical.clockOffset)) {
      return Promise.reject(new ClockRangeError());
    }
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        [META_STORE, PENDING_STORE, TASK_PENDING_STORE, DURATION_PENDING_STORE, AUTO_START_PENDING_STORE, SELECTED_TASK_PENDING_STORE],
        "readwrite"
      );
      const requests = resolutionApplyRequests(transaction);
      const results = {};
      let outcome;
      let failure = null;
      collectTransactionRequests(requests, results, () => {
        outcome = applyPendingResolution(transaction, results, pending, canonical);
      }, (error) => {
        failure = error;
        transaction.abort();
      });
      transaction.oncomplete = () => resolve(outcome);
      transaction.onabort = () => reject(failure || transaction.error || new Error("Storage transaction aborted."));
      transaction.onerror = () => {};
    });
  }

  function syncResponseRequests(transaction, metaStore = transaction.objectStore(META_STORE)) {
    return {
      gate: metaStore.get(GATE_KEY), resolution: metaStore.get(RESOLUTION_KEY),
      snapshot: metaStore.get("snapshot"), hlc: metaStore.get("hlc"),
      clockOffset: metaStore.get(CLOCK_OFFSET_KEY), timerOwner: metaStore.get(TIMER_OWNER_KEY),
      deliveryProof: metaStore.get(DELIVERY_PROOF_KEY),
      outgoing: metaStore.get(OUTGOING_KEY),
      canonicalHead: metaStore.get(CANONICAL_HEAD_KEY),
      projectionPending: metaStore.get(PROJECTION_PENDING_KEY),
      settings: metaStore.get("settings"), displayHistory: metaStore.get("displayHistory"),
      timerDependencies: metaStore.get("timerDependencies"), deviceId: metaStore.get("deviceId"),
      deviceSequence: metaStore.get("deviceSequence"), uuidV7: metaStore.get(UUID7_KEY),
      workspaceGroups: metaStore.get("workspaceGroups"), completionRecords: metaStore.get("completionRecords"),
      workspaceObservation: metaStore.get("workspaceObservation"),
      commands: transaction.objectStore(PENDING_STORE).getAll(),
      taskOperations: transaction.objectStore(TASK_PENDING_STORE).getAll(),
      durationOperations: transaction.objectStore(DURATION_PENDING_STORE).getAll(),
      autoStartOperations: transaction.objectStore(AUTO_START_PENDING_STORE).getAll(),
      selectedTaskOperations: transaction.objectStore(SELECTED_TASK_PENDING_STORE).getAll()
    };
  }

  function mutationContextRequests(transaction, requests = {}) {
    // The same transaction reads the raw context and every retained queue before
    // any metadata, migration, proof, gate, or operation callback may write.
    return { ...syncResponseRequests(transaction), ...requests };
  }

  function validateSyncResponseApply(input, results, storedSnapshot) {
    input.assertCurrent?.();
    const storedUserId = core.accountOwnerId(storedSnapshot?.user) || null;
    const incomingUserId = core.accountOwnerId(input.snapshot?.user) || null;
    if (!input.expectedUserId || storedUserId !== input.expectedUserId
      || incomingUserId !== input.expectedUserId) throw new AccountOwnershipError();
    if (results.gate || results.resolution) throw new BootstrapGateError();
    if (!core.validDateTime(input.snapshot.serverTime)) {
      throw new Error("Sync response returned an invalid serverTime.");
    }
  }

  function responseClaimPlan(input, results) {
    const saved = results.outgoing?.value || null;
    // Unclaimed snapshot installation cannot release a retained request. Network
    // response callers supply the immutable claim captured before their send.
    if (input.capturedClaim == null) return { applicable: !saved, clearClaim: false };
    const captured = captureSyncClaim(input.capturedClaim, input.reconciliation?.sent,
      input.expectedUserId, input.reconciliation?.deviceId);
    const matches = workspaceCore.recordsEqual(saved, captured);
    return { applicable: matches, clearClaim: matches };
  }

  function responseCompletionState(input, results, rebased) {
    if (!input.reconciliation) return null;
    const sendable = callWorkspaceCore("sync.batchPlan.v1", workspaceCore.batchRequest(
      rebased.queues, input.reconciliation.deviceId, rebased.timerDependencies, "commands"
    ));
    return completionSelection({
      selectedPhase: results.settings?.value?.selectedPhase || "focus", commands: results.commands,
      acknowledgements: input.reconciliation.response.acknowledgements,
      beforeHistory: results.snapshot.value.history, afterHistory: input.snapshot.history,
      history: results.displayHistory?.value || results.snapshot.value.history,
      canonicalTimer: input.snapshot.canonicalTimer?.id ? input.snapshot.canonicalTimer : null,
      referenceTime: input.snapshot.serverTime, discardedCommandIds: rebased.droppedCommandIds,
      pendingCommandIds: rebased.queues.commands.map((command) => command.id),
      sendableCommandIds: sendable.selected.commands,
      otherOperationIds: workspaceCore.DOMAINS.slice(1).flatMap((domain) => rebased.queues[domain].map((operation) => operation.id)),
      completionState: results.completionState?.value
    });
  }

  function planSyncResponse(input, results) {
    const storedSnapshot = results.snapshot?.value || null;
    validateSyncResponseApply(input, results, storedSnapshot);
    const claim = responseClaimPlan(input, results);
    if (!claim.applicable) return { kind: "ignored", outcome: {
      applied: false, stale: true, claimChanged: true, snapshot: storedSnapshot
    } };
    assertResponseDisplayContext(results, input.reconciliation?.deviceId);
    const clockOffset = latestClockOffset(results.clockOffset?.value || null, input.clockOffset);
    if (Number(storedSnapshot?.revision || 0) > Number(input.snapshot.revision)) {
      const ownerPlan = installationOwnership(input, results);
      return {
        kind: "stale", clockOffset, ownerPlan,
        outcome: { applied: false, stale: true, snapshot: storedSnapshot, clockOffset }
      };
    }
    const rebased = responseTransactionRebase(input, results);
    const responseHlc = input.clockOffset != null && clockOffset === input.clockOffset
      ? input.hlc
      : input.serverHlc || input.hlc;
    const hlc = laterHlc(results.hlc?.value, responseHlc);
    const canonicalHead = sanitizeCanonicalHead(input.serverHlc)
      || sanitizeCanonicalHead(results.canonicalHead?.value) || null;
    const settings = results.settings?.value || {};
    const completion = responseCompletionState(input, results, rebased);
    const selectedPhase = completion?.selection.phase ?? input.settings?.selectedPhase ?? settings.selectedPhase ?? "focus";
    return {
      kind: "apply", rebased, clockOffset, hlc, canonicalHead, completion, clearClaim: claim.clearClaim,
      settings: { ...settings, selectedPhase },
      observation: retainedObservation(results.workspaceObservation?.value, rebased.queues),
      proof: neverSentFromProof(results.deliveryProof?.value, rebased.queues, input.reconciliation?.sent),
      ownerPlan: installationOwnership(input, results, rebased),
      outcome: { applied: true, stale: false, snapshot: input.snapshot, hlc, clockOffset }
    };
  }

  function persistReconciledQueue(store, capturedIds, retained) {
    for (const id of capturedIds || []) store.delete(id);
    for (const item of retained || []) store.put(item);
  }

  function persistSyncResponsePlan(transaction, input, plan) {
    if (plan.kind === "ignored") return;
    const metaStore = transaction.objectStore(META_STORE);
    if (plan.clockOffset === input.clockOffset) {
      metaStore.put({ key: CLOCK_OFFSET_KEY, value: input.clockOffset });
    }
    if (plan.kind === "stale") {
      workspaceTransaction.writeOwnership(metaStore, plan.ownerPlan.ownershipWrites);
      return;
    }
    const pendingStore = transaction.objectStore(PENDING_STORE);
    persistReconciledQueue(pendingStore, input.queueIds.commands, input.promoteCommands);
    for (const id of plan.rebased.droppedCommandIds) pendingStore.delete(id);
    for (const command of plan.rebased.queues?.commands || []) pendingStore.put(command);
    persistReconciledQueue(transaction.objectStore(TASK_PENDING_STORE),
      input.queueIds.taskOperations, plan.rebased.queues?.taskOperations);
    persistReconciledQueue(transaction.objectStore(DURATION_PENDING_STORE),
      input.queueIds.durationOperations, plan.rebased.queues?.durationOperations);
    persistReconciledQueue(transaction.objectStore(AUTO_START_PENDING_STORE),
      input.queueIds.autoStartOperations, plan.rebased.queues?.autoStartOperations);
    persistReconciledQueue(transaction.objectStore(SELECTED_TASK_PENDING_STORE),
      input.queueIds.selectedTaskOperations, plan.rebased.queues?.selectedTaskOperations);
    metaStore.put({ key: "snapshot", value: input.snapshot });
    if (plan.rebased.canonicalResponse) metaStore.put({ key: "canonicalResponse", value: plan.rebased.canonicalResponse });
    if (plan.rebased.workspace) metaStore.put({ key: "reconciledWorkspace", value: plan.rebased.workspace });
    if (plan.completion) metaStore.put({ key: "completionState", value: plan.completion });
    if (plan.canonicalHead) metaStore.put({ key: CANONICAL_HEAD_KEY, value: plan.canonicalHead });
    if (plan.rebased.projectionPending) {
      metaStore.put({ key: PROJECTION_PENDING_KEY, value: plan.rebased.projectionPending });
    } else {
      metaStore.delete(PROJECTION_PENDING_KEY);
    }
    if (plan.clearClaim) metaStore.delete(OUTGOING_KEY);
    if (plan.settings) metaStore.put({ key: "settings", value: plan.settings });
    if (plan.rebased.timerDependencies) metaStore.put({ key: "timerDependencies", value: plan.rebased.timerDependencies });
    metaStore.put({ key: "workspaceObservation", value: plan.observation });
    metaStore.put({ key: "displayHistory", value: plan.rebased.projection?.history || input.snapshot.history });
    metaStore.put({ key: DELIVERY_PROOF_KEY, value: plan.proof });
    workspaceTransaction.writeOwnership(metaStore, plan.ownerPlan.ownershipWrites);
    metaStore.put({ key: "hlc", value: plan.hlc });
  }

  function retireProofAndPersistOutgoing(database, sent, context = {}) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(workspaceTransaction.STORES, "readwrite");
      const metaStore = transaction.objectStore(META_STORE);
      const requests = syncResponseRequests(transaction, metaStore);
      const results = {};
      let outcome = null;
      let failure = null;
      collectTransactionRequests(requests, results, () => {
        context.assertCurrent?.();
        assertAccountOwnership(results.snapshot?.value, context.ownerId);
        if (results.gate || results.resolution) throw new BootstrapGateError();
        assertResponseDisplayContext(results, context.deviceId);
        const proof = sanitizeDeliveryProof(results.deliveryProof?.value);
        const retired = removeProofIds(proof, sent);
        metaStore.put({ key: DELIVERY_PROOF_KEY, value: retired });
        metaStore.put({ key: OUTGOING_KEY, value: { sent: cloneOutgoing(sent), retiredAt: new Date().toISOString() } });
        outcome = { proof: retired };
      }, (error) => { failure = error; transaction.abort(); });
      transaction.oncomplete = () => resolve(outcome);
      transaction.onabort = () => reject(failure || transaction.error || new Error("Storage transaction aborted."));
      transaction.onerror = () => {};
    });
  }

  function readDeliveryProof(database) {
    return accountMetadataMutation(database, {}, [DELIVERY_PROOF_KEY], (store, results) =>
      sanitizeDeliveryProof(results[DELIVERY_PROOF_KEY]?.value));
  }

  function applySyncResponseCoordinator(database, input) {
    try {
      if (input.capturedClaim != null) input = { ...input,
        capturedClaim: captureSyncClaim(input.capturedClaim, input.reconciliation?.sent,
          input.expectedUserId, input.reconciliation?.deviceId) };
    } catch (error) { return Promise.reject(error); }
    if (input.clockOffset != null && !core.validClockSample(input.clockOffset)) {
      return Promise.reject(new ClockRangeError());
    }
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        [META_STORE, PENDING_STORE, TASK_PENDING_STORE, DURATION_PENDING_STORE,
          AUTO_START_PENDING_STORE, SELECTED_TASK_PENDING_STORE],
        "readwrite"
      );
      const results = {};
      let plan;
      let failure = null;
      collectTransactionRequests(syncResponseRequests(transaction), results, () => {
        plan = planSyncResponse(input, results);
        persistSyncResponsePlan(transaction, input, plan);
      }, (error) => {
        failure = error;
        transaction.abort();
      });
      transaction.oncomplete = () => resolve(plan.outcome);
      transaction.onabort = () => reject(failure || transaction.error || new Error("Storage transaction aborted."));
      transaction.onerror = () => {};
    });
  }

  const applySyncResponse = applySyncResponseCoordinator;

  async function readQueues(database) {
    const transaction = database.transaction(
      [PENDING_STORE, TASK_PENDING_STORE, DURATION_PENDING_STORE, AUTO_START_PENDING_STORE, SELECTED_TASK_PENDING_STORE],
      "readonly"
    );
    const [commands, taskOperations, durationOperations, autoStartOperations, selectedTaskOperations] = await Promise.all([
      requestResult(transaction.objectStore(PENDING_STORE).getAll()),
      requestResult(transaction.objectStore(TASK_PENDING_STORE).getAll()),
      requestResult(transaction.objectStore(DURATION_PENDING_STORE).getAll()),
      requestResult(transaction.objectStore(AUTO_START_PENDING_STORE).getAll()),
      requestResult(transaction.objectStore(SELECTED_TASK_PENDING_STORE).getAll())
    ]);
    return { commands, taskOperations, durationOperations, autoStartOperations, selectedTaskOperations };
  }

  async function readCanonicalState(database) {
    const transaction = database.transaction(META_STORE, "readonly");
    const store = transaction.objectStore(META_STORE);
    const [snapshot, hlc, clockOffset] = await Promise.all([
      requestResult(store.get("snapshot")),
      requestResult(store.get("hlc")),
      requestResult(store.get(CLOCK_OFFSET_KEY))
    ]);
    return {
      snapshot: snapshot?.value || null,
      hlc: hlc?.value || null,
      clockOffset: core.validClockSample(clockOffset?.value) ? clockOffset.value : null
    };
  }

  async function readSyncState(database) {
    const transaction = database.transaction(
      [META_STORE, PENDING_STORE, TASK_PENDING_STORE, DURATION_PENDING_STORE, AUTO_START_PENDING_STORE, SELECTED_TASK_PENDING_STORE],
      "readonly"
    );
    const metaStore = transaction.objectStore(META_STORE);
    const [snapshot, hlc, clockOffset, commands, taskOperations, durationOperations, autoStartOperations, selectedTaskOperations, proof, outgoing, head, projectionPending, dependencies, observation, settings, deviceSequence, completionState, sourceAcknowledgements, deviceId] = await Promise.all([
      requestResult(metaStore.get("snapshot")),
      requestResult(metaStore.get("hlc")),
      requestResult(metaStore.get(CLOCK_OFFSET_KEY)),
      requestResult(transaction.objectStore(PENDING_STORE).getAll()),
      requestResult(transaction.objectStore(TASK_PENDING_STORE).getAll()),
      requestResult(transaction.objectStore(DURATION_PENDING_STORE).getAll()),
      requestResult(transaction.objectStore(AUTO_START_PENDING_STORE).getAll()),
      requestResult(transaction.objectStore(SELECTED_TASK_PENDING_STORE).getAll()),
      requestResult(metaStore.get(DELIVERY_PROOF_KEY)),
      requestResult(metaStore.get(OUTGOING_KEY)),
      requestResult(metaStore.get(CANONICAL_HEAD_KEY)),
      requestResult(metaStore.get(PROJECTION_PENDING_KEY)),
      requestResult(metaStore.get("timerDependencies")), requestResult(metaStore.get("workspaceObservation")),
      requestResult(metaStore.get("settings")), requestResult(metaStore.get("deviceSequence")),
      requestResult(metaStore.get("completionState")), requestResult(metaStore.get("sourceAcknowledgements")), requestResult(metaStore.get("deviceId"))
    ]);
    return {
      snapshot: snapshot?.value || null,
      hlc: hlc?.value || null,
      clockOffset: core.validClockSample(clockOffset?.value) ? clockOffset.value : null,
      commands,
      taskOperations,
      durationOperations,
      autoStartOperations,
      selectedTaskOperations,
      deliveryProof: sanitizeDeliveryProof(proof?.value),
      outgoing: outgoing?.value || null,
      canonicalHead: sanitizeCanonicalHead(head?.value),
      projectionPending: projectionPending?.value ?? null,
      timerDependencies: dependencies?.value ?? null, workspaceObservation: observation?.value ?? null,
      settings: settings?.value ?? null, deviceSequence: deviceSequence?.value ?? null,
      completionState: completionState?.value ?? null, sourceAcknowledgements: sourceAcknowledgements?.value ?? [], deviceId: deviceId?.value ?? null
    };
  }

  function migrateLegacySelectedTask(database, input) {
    return migrateLegacyPreferences(database, input).then((plan) => {
      const operation = plan.operations.selectedTaskOperations[0] || null;
      return { migrated: operation !== null, operation };
    });
  }

  function migrateLegacyAutoStart(database, input) {
    return migrateLegacyPreferences(database, input).then((plan) => {
      const operation = plan.operations.autoStartOperations[0] || null;
      return { migrated: operation !== null, operation };
    });
  }

  function needsLegacyDurationCanonicalization(operation) {
    return Number(operation?.hlcWallMs) === 0
      && Number(operation?.hlcCounter) === 0
      && operation.occurredAt !== LEGACY_EPOCH;
  }

  function canonicalizeLegacyDuration(operation, state) {
    if (!needsLegacyDurationCanonicalization(operation)) return operation;
    state.changed += 1;
    return { ...operation, occurredAt: LEGACY_EPOCH };
  }

  function canonicalizeLegacyDurationQueue(durationStore, operations, state) {
    for (const operation of operations) {
      const normalized = canonicalizeLegacyDuration(operation, state);
      if (normalized !== operation) durationStore.put(normalized);
    }
  }

  function rotateLegacyDurationResolution(metaStore, gateRecord, resolutionRecord, options, state) {
    const captured = resolutionRecord?.value || null;
    const capturedOperations = captured?.payload?.durationOperations;
    const needsRotation = Array.isArray(capturedOperations)
      && capturedOperations.some(needsLegacyDurationCanonicalization);
    if (!needsRotation || !options.gateToken) return captured;
    if (captured.deliveryState !== "neverSent") {
      throw new BootstrapGateError("Possibly delivered legacy history request cannot be rewritten.");
    }
    const gate = gateRecord?.value || null;
    if (gate?.token !== options.gateToken || captured.gateToken !== options.gateToken) {
      throw new BootstrapGateError("Bootstrap gate is owned by another tab.");
    }
    if (typeof options.replacementRequestId !== "string" || !options.replacementRequestId
      || options.replacementRequestId === captured.payload.requestId) {
      throw new BootstrapGateError("Legacy history resolution requires a fresh request ID.");
    }
    const normalized = capturedOperations.map((operation) => canonicalizeLegacyDuration(operation, state));
    const resolution = {
      ...captured,
      payload: { ...captured.payload, requestId: options.replacementRequestId, durationOperations: normalized }
    };
    metaStore.put({ key: RESOLUTION_KEY, value: resolution });
    return resolution;
  }

  function normalizeLegacyDurationOperations(database, options = {}) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(workspaceTransaction.STORES, "readwrite");
      const metaStore = transaction.objectStore(META_STORE);
      const durationStore = transaction.objectStore(DURATION_PENDING_STORE);
      const requests = mutationContextRequests(transaction, {
        snapshot: metaStore.get("snapshot"),
        proof: metaStore.get(DELIVERY_PROOF_KEY), outgoing: metaStore.get(OUTGOING_KEY),
        durations: durationStore.getAll(),
        gate: metaStore.get(GATE_KEY),
        resolution: metaStore.get(RESOLUTION_KEY)
      });
      const results = {};
      const state = { changed: 0, resolution: null };
      let failure = null;
      collectTransactionRequests(requests, results, () => {
        assertStorageContext(results, options);
        assertResponseDisplayContext(results, options.deviceId);
        const outgoingIds = new Set((results.outgoing?.value?.sent?.durationOperations || []).map((item) => item.id));
        const proven = new Set(sanitizeDeliveryProof(results.proof?.value).durationOperations);
        if ((results.durations || []).some((item) => needsLegacyDurationCanonicalization(item)
          && (!proven.has(item.id) || outgoingIds.has(item.id)))) {
          throw new BootstrapGateError("Possibly delivered legacy duration cannot be rewritten.");
        }
        canonicalizeLegacyDurationQueue(durationStore, results.durations || [], state);
        state.resolution = rotateLegacyDurationResolution(
          metaStore,
          results.gate,
          results.resolution,
          options,
          state
        );
      }, (error) => {
        failure = error;
        transaction.abort();
      });
      transaction.oncomplete = () => resolve({ changed: state.changed, resolution: state.resolution });
      transaction.onabort = () => reject(failure || transaction.error || new Error("Storage transaction aborted."));
      transaction.onerror = () => {};
    });
  }

  return Object.freeze({
    BootstrapGateError,
    AccountOwnershipError,
    assertAccountOwnership,
    ClockRangeError,
    UUIDRangeError,
    ResolutionLimitError,
    GATE_KEY,
    RESOLUTION_KEY,
    UUID7_KEY,
    UUID7_MAX_TIMESTAMP_MS,
    UUID7_RANDOM_MAX,
    callWorkspaceCore, recordsEqual: workspaceCore.recordsEqual, workspaceRecords, observeClock, sampleClock,
    observeWorkspace, readWorkspace, projectWorkspace,
    bootstrapWorkspace, completionSelection, planWorkspaceMutation, claimWorkspaceBatch, selectWorkspaceBatch,
    savedClaimRecoveryQueues, savedClaimRecoveryMessage, discardUnrecoverableSavedClaim,
    migrateLegacyPreferences, migrateLegacyDependencies, LegacyDependencyRecoveryError,
    assertPersistedDisplayContext, PersistedDisplayContextError,
    acquireBootstrapGate,
    acquireBootstrapGateWithLegacyAutoStart,
    allocateClockRequestSequence,
    applyResolution,
    applySyncResponse,
    applySyncResponseCoordinator,
    planSyncResponse,
    captureResolution,
    clearBootstrapGate,
    finishAppliedPlan,
    guardedMutation,
    invalidateForeignResolution,
    readAccountBinding,
    leaseIsLive,
    migrateLegacyAutoStart,
    migrateLegacySelectedTask,
    normalizeLegacyDurationOperations,
    bootstrapPlan,
    projectState,
    reconcileState,
    reconcileResolutionState,
    releaseTimerOwnership,
    readBootstrapState,
    readCanonicalState,
    readQueues,
    readSyncState,
    requestResult,
    renewTimerOwnership,
    saveClockOffset,
    setSharedCore,
    transactionDone,
    reserveUuid7,
    uuid7FromParts,
    uuid7Parts,
    validatePendingForSend,
    retireProofAndPersistOutgoing,
    readDeliveryProof,
    sanitizeDeliveryProof,
    emptyDeliveryProof,
    neverSentFromProof,
    sanitizeCanonicalHead,
    sanitizeProjectionPending,
    cloneOutgoing,
    outgoingMatchesStored, captureSyncClaim,
    DELIVERY_PROOF_KEY,
    OUTGOING_KEY,
    CANONICAL_HEAD_KEY,
    PROJECTION_PENDING_KEY
  });
});
