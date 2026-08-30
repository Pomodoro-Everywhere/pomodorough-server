(function (root, factory) {
  "use strict";

  const dependencies = typeof module === "object" && module.exports
    ? {
      core: require("./sync-core.js"), authority: require("./sync-authority.js"),
      uuid: require("./sync-storage-uuid.js")
    }
    : {
      core: root.PomodoroughSync, authority: root.PomodoroughSyncAuthority,
      uuid: root.PomodoroughStorageUuid
    };
  const api = factory(dependencies.core, dependencies.authority, dependencies.uuid);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PomodoroughStorage = api;
})(typeof globalThis === "object" ? globalThis : this, function (core, authorityModule, uuidModule) {
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
    if (canonicalTimer && history.some((item) => item?.timerId === canonicalTimer.id)) {
      canonicalTimer = null;
    }
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
    const value = dispatcher.projectSynchronizedState({
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

  function localDayBounds(value) {
    const instant = new Date(value);
    if (!Number.isFinite(instant.getTime())) throw new Error("Timer dependency has an invalid source time.");
    const start = new Date(instant.getFullYear(), instant.getMonth(), instant.getDate());
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { sourceDayStart: start.toISOString(), sourceDayEnd: end.toISOString() };
  }

  function timerDependencies(commands = []) {
    const commandById = new Map(commands.map((command) => [command.id, command]));
    return commands.flatMap((command) => {
      if (typeof command?.dependsOnCommandId !== "string" || !command.dependsOnCommandId) return [];
      const dependency = {
        operationId: command.id,
        dependsOnOperationId: command.dependsOnCommandId
      };
      if (command.generatedBreak === true) {
        const source = commandById.get(command.dependsOnCommandId);
        const bounds = typeof command.sourceDayStart === "string" && typeof command.sourceDayEnd === "string"
          ? { sourceDayStart: command.sourceDayStart, sourceDayEnd: command.sourceDayEnd }
          : localDayBounds(source?.physicalOccurredAt || source?.occurredAt);
        Object.assign(dependency, { generatedBreak: true, ...bounds });
      }
      return [dependency];
    });
  }

  function validateReconciliationOutput(value) {
    const expectedKeys = [
      "autoStartBreaks", "baseAutoStartBreaks", "baseDurationsMs", "baseHistory",
      "baseSelectedTaskId", "baseTasks", "baseTimer", "droppedTimerIds",
      "droppedTimerOperationIds", "durationsMs", "history", "pending",
      "pendingAutoStartOperations", "pendingDurationOperations", "pendingSelectedTaskOperations",
      "pendingTaskOperations", "pendingTimerDependencies", "promotedTimerOperationIds", "revision",
      "selectedTaskId", "tasks", "timer"
    ];
    if (!plainObject(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys.sort())
      || !Number.isSafeInteger(value.revision) || value.revision < 0
      || !Array.isArray(value.pending) || !Array.isArray(value.pendingTaskOperations)
      || !Array.isArray(value.pendingDurationOperations) || !Array.isArray(value.pendingAutoStartOperations)
      || !Array.isArray(value.pendingSelectedTaskOperations) || !Array.isArray(value.pendingTimerDependencies)
      || !Array.isArray(value.promotedTimerOperationIds) || !Array.isArray(value.droppedTimerOperationIds)
      || !Array.isArray(value.droppedTimerIds) || !Array.isArray(value.baseHistory)
      || !Array.isArray(value.baseTasks) || !Array.isArray(value.history) || !Array.isArray(value.tasks)
      || typeof value.baseAutoStartBreaks !== "boolean" || typeof value.autoStartBreaks !== "boolean"
      || !plainObject(value.baseDurationsMs) || !plainObject(value.durationsMs)) {
      throw new Error("Shared core returned an invalid reconciliation.");
    }
    validateCanonicalTimer(value.baseTimer);
    validateCanonicalTimer(value.timer);
    return value;
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

  function reconciliationProjection(value, queues, input, dispatcher) {
    return projectState({
      snapshot: {
        canonicalTimer: value.baseTimer,
        history: value.baseHistory,
        tasks: value.baseTasks,
        durationsMs: value.baseDurationsMs,
        autoStartBreaks: value.baseAutoStartBreaks,
        selectedTaskId: value.baseSelectedTaskId
      },
      queues,
      nowMs: Date.parse(input.response?.serverTime),
      deviceId: input.deviceId,
      sharedCore: dispatcher
    });
  }

  function assertReconciliationProjection(value, projection) {
    const projectedFields = {
      timer: projection.canonicalTimer,
      history: projection.history,
      tasks: projection.tasks,
      durationsMs: projection.durationsMs,
      autoStartBreaks: projection.autoStartBreaks,
      selectedTaskId: projection.selectedTaskId
    };
    const reconciledFields = {
      timer: value.timer,
      history: value.history,
      tasks: value.tasks,
      durationsMs: value.durationsMs,
      autoStartBreaks: value.autoStartBreaks,
      selectedTaskId: value.selectedTaskId
    };
    if (JSON.stringify(projectedFields) !== JSON.stringify(reconciledFields)) {
      throw new Error("Shared core reconciliation disagrees with synchronized projection.");
    }
  }

  function restoreTimerDependencies(commands, dependencies) {
    const dependencyById = new Map(dependencies.map((dependency) => [dependency.operationId, dependency]));
    return commands.map((command) => {
      const dependency = dependencyById.get(command.id);
      if (!dependency) return command;
      return {
        ...command,
        dependsOnCommandId: dependency.dependsOnOperationId,
        ...(dependency.generatedBreak === true ? {
          generatedBreak: true,
          sourceDayStart: dependency.sourceDayStart,
          sourceDayEnd: dependency.sourceDayEnd
        } : {})
      };
    });
  }

  function reconcileState(input) {
    const dispatcher = sharedCoreAdapter(
      input,
      "reconcileSynchronizedState",
      "Shared core is unavailable for synchronized reconciliation."
    );
    const value = validateReconciliationOutput(dispatcher.reconcileSynchronizedState({
      local: projectionQueues(input.queues, input.deviceId),
      sent: input.sent || {},
      response: input.response,
      timerDependencies: input.timerDependencies || timerDependencies(input.queues?.commands || [])
    }));
    const queues = reconciledQueues(value);
    const projection = reconciliationProjection(value, queues, input, dispatcher);
    assertReconciliationProjection(value, projection);
    queues.commands = restoreTimerDependencies(value.pending, value.pendingTimerDependencies);
    return { ...value, queues, projection };
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
      timerDependencies: timerDependencies(shaped.queues?.commands || []),
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
      sharedCore: input.sharedCore
    });
  }

  function validateProspectiveProjection(projection, operation, storeName) {
    const winners = projection.winningOperationIds;
    if (storeName === PENDING_STORE) {
      if (projection.timerOutcomes[operation.id]?.outcome !== "applied") {
        throw new Error("Shared core rejected the timer command projection.");
      }
      return;
    }
    if (storeName === TASK_PENDING_STORE) {
      const projected = projection.tasks.find((task) => task.id === operation.taskId) || null;
      const expected = operation.type === "upsert"
        ? { id: operation.taskId, title: operation.title }
        : null;
      if (winners.tasks[operation.taskId] !== operation.id
        || JSON.stringify(projected) !== JSON.stringify(expected)) {
        throw new Error("Shared core returned an invalid task projection.");
      }
      return;
    }
    if (storeName === DURATION_PENDING_STORE) {
      if (winners.durations[operation.phase] !== operation.id
        || projection.durationsMs[operation.phase] !== operation.durationMs) {
        throw new Error("Shared core returned an invalid duration projection.");
      }
      return;
    }
    if (storeName === AUTO_START_PENDING_STORE) {
      if (winners.autoStart !== operation.id || projection.autoStartBreaks !== operation.enabled) {
        throw new Error("Shared core returned an invalid auto-start projection.");
      }
      return;
    }
    if (storeName === SELECTED_TASK_PENDING_STORE
      && (winners.selectedTask !== operation.id || projection.selectedTaskId !== operation.taskId)) {
      throw new Error("Shared core returned an invalid selected-task projection.");
    }
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
        selectedTaskOperations: "selected-task operations"
      };
      super(`Cannot upload ${violation.count.toLocaleString("en-US")} queued ${labels[violation.field]}; server limit is ${violation.limit.toLocaleString("en-US")}. Keep Remote can discard local queued data without uploading it.`);
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

  function uuid7RequestSet(transaction, metaStore) {
    return {
      uuidV7: metaStore.get(UUID7_KEY),
      uuidCommands: transaction.objectStore(PENDING_STORE).getAllKeys(),
      uuidTasks: transaction.objectStore(TASK_PENDING_STORE).getAllKeys(),
      uuidDurations: transaction.objectStore(DURATION_PENDING_STORE).getAllKeys(),
      uuidAutoStarts: transaction.objectStore(AUTO_START_PENDING_STORE).getAllKeys(),
      uuidSelectedTasks: transaction.objectStore(SELECTED_TASK_PENDING_STORE).getAllKeys()
    };
  }

  function pendingUuidIds(results) {
    return [
      ...(results.uuidCommands || []),
      ...(results.uuidTasks || []),
      ...(results.uuidDurations || []),
      ...(results.uuidAutoStarts || []),
      ...(results.uuidSelectedTasks || [])
    ];
  }

  function reserveTransactionUuid7(metaStore, results, timestampMs, count, entropy) {
    const identifiers = reserveUuid7(
      timestampMs,
      count,
      results.uuidV7?.value || null,
      pendingUuidIds(results),
      entropy
    );
    metaStore.put({ key: UUID7_KEY, value: identifiers.at(-1) });
    return identifiers;
  }

  function requireMutationRange(nowMs, wallMs, counter, deviceSequence) {
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0
      || !Number.isSafeInteger(wallMs) || wallMs <= 0
      || !Number.isSafeInteger(counter) || counter < 0
      || deviceSequence !== undefined && (!Number.isSafeInteger(deviceSequence) || deviceSequence <= 0)) {
      throw new ClockRangeError();
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
    const leftWallMs = Number(left?.wallMs) || 0;
    const rightWallMs = Number(right?.wallMs) || 0;
    if (leftWallMs !== rightWallMs) return leftWallMs > rightWallMs ? left : right;
    return (Number(left?.counter) || 0) >= (Number(right?.counter) || 0) ? left : right;
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
      const transaction = database.transaction(META_STORE, "readwrite");
      const store = transaction.objectStore(META_STORE);
      const requests = Object.fromEntries([...new Set(["snapshot", GATE_KEY, RESOLUTION_KEY, ...keys])]
        .map((key) => [key === GATE_KEY ? "gate" : key === RESOLUTION_KEY ? "resolution" : key, store.get(key)]));
      let outcome;
      let failure;
      const results = {};
      collectTransactionRequests(requests, results, () => {
        assertStorageContext(results, input);
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
      const names = [...new Set([META_STORE, ...storeNames])];
      const transaction = database.transaction(names, "readwrite");
      const metaStore = transaction.objectStore(META_STORE);
      const outcome = { value: undefined };
      let failure = null;
      const requests = {
        gate: metaStore.get(GATE_KEY), resolution: metaStore.get(RESOLUTION_KEY),
        snapshot: metaStore.get("snapshot")
      };
      collectRequestResults(requests, (results) => {
        try {
          if (!input.allowBootstrap && (results.gate || results.resolution)) throw new BootstrapGateError();
          assertStorageContext(results, input);
          assertAccountOwnership(results.snapshot?.value, expectedUserId);
          operation(transaction, outcome, (error) => {
            failure = error;
            transaction.abort();
          });
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

  function synchronizedMutationStores(input) {
    if (!input.withUuidV7) return [META_STORE, input.storeName];
    return [
      META_STORE,
      PENDING_STORE,
      TASK_PENDING_STORE,
      DURATION_PENDING_STORE,
      AUTO_START_PENDING_STORE,
      SELECTED_TASK_PENDING_STORE
    ];
  }

  function mutationAllocationRequests(transaction, metaStore, input, requiresProjection) {
    const requests = {
      gate: metaStore.get(GATE_KEY),
      resolution: metaStore.get(RESOLUTION_KEY),
      projectionSnapshot: metaStore.get("snapshot"),
      hlc: metaStore.get("hlc")
    };
    if (input.withDeviceSequence) requests.deviceSequence = metaStore.get("deviceSequence");
    if (input.withUuidV7) Object.assign(requests, uuid7RequestSet(transaction, metaStore));
    if (!requiresProjection) return requests;
    Object.assign(requests, {
      projectionDeviceId: metaStore.get("deviceId"),
      projectionCommands: transaction.objectStore(PENDING_STORE).getAll(),
      projectionTasks: transaction.objectStore(TASK_PENDING_STORE).getAll(),
      projectionDurations: transaction.objectStore(DURATION_PENDING_STORE).getAll(),
      projectionAutoStarts: transaction.objectStore(AUTO_START_PENDING_STORE).getAll(),
      projectionSelectedTasks: transaction.objectStore(SELECTED_TASK_PENDING_STORE).getAll()
    });
    return requests;
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

  function allocateAuthorityHlc(input, storedHlc, count) {
    try {
      return storageAuthority(input).allocateHlcBatch(storedHlc, input.nowMs, count);
    } catch (error) {
      if (/invalid shared-core input:.*(?:counter|wallMs)|overflow/i.test(String(error?.message || ""))) {
        throw new ClockRangeError();
      }
      throw error;
    }
  }

  function mutationClock(input, results) {
    const storedHlc = results.hlc?.value || { wallMs: 0, counter: 0 };
    const tick = allocateAuthorityHlc(input, storedHlc, 1);
    const wallMs = tick.wallMs;
    const counter = tick.counter;
    const deviceSequence = input.withDeviceSequence
      ? (Number(results.deviceSequence?.value) || 0) + 1
      : undefined;
    requireMutationRange(input.nowMs, wallMs, counter, deviceSequence);
    const id = input.withUuidV7
      ? reserveUuid7(wallMs, 1, results.uuidV7?.value || null, pendingUuidIds(results), input.entropy)[0]
      : undefined;
    return { id, wallMs, counter, deviceSequence };
  }

  function validateAllocatedMutation(transaction, input, results, allocated, wallMs) {
    const queues = {
      commands: results.projectionCommands || [],
      taskOperations: results.projectionTasks || [],
      durationOperations: results.projectionDurations || [],
      autoStartOperations: results.projectionAutoStarts || [],
      selectedTaskOperations: results.projectionSelectedTasks || []
    };
    const queueField = PROJECTION_QUEUE_FIELDS[input.storeName];
    if (!queueField) throw new Error("Synchronized mutation store is unsupported.");
    const superseded = typeof input.supersede === "function"
      ? queues[queueField].filter((operation) => input.supersede(operation, allocated))
      : [];
    const supersededIds = new Set(superseded.map((operation) => operation.id));
    queues[queueField] = queues[queueField]
      .filter((operation) => !supersededIds.has(operation.id))
      .concat(allocated);
    const projection = projectState({
      snapshot: results.projectionSnapshot?.value || null,
      queues,
      nowMs: wallMs,
      deviceId: allocated?.deviceId || results.projectionDeviceId?.value || null,
      sharedCore: input.sharedCore
    });
    validateProspectiveProjection(projection, allocated, input.storeName);
    for (const operation of superseded) transaction.objectStore(input.storeName).delete(operation.id);
  }

  function persistAllocatedMutation(transaction, metaStore, input, allocated, clock) {
    transaction.objectStore(input.storeName).add(allocated);
    if (input.withUuidV7) metaStore.put({ key: UUID7_KEY, value: clock.id });
    metaStore.put({ key: "hlc", value: { wallMs: clock.wallMs, counter: clock.counter } });
    if (input.withDeviceSequence) {
      metaStore.put({ key: "deviceSequence", value: clock.deviceSequence });
    }
    if (input.timerOwner && allocated?.type === "start" && allocated.timerId) {
      metaStore.put({
        key: TIMER_OWNER_KEY,
        value: timerOwnerValue(allocated.timerId, input.timerOwner)
      });
    }
  }

  function allocateMutation(database, input) {
    const expectedUserId = input.expectedUserId ?? null;
    return new Promise((resolve, reject) => {
      const requiresProjection = input.requireProjection === true || input.sharedCore != null;
      const transaction = database.transaction(synchronizedMutationStores(input), "readwrite");
      const metaStore = transaction.objectStore(META_STORE);
      let allocated;
      let failure = null;
      const requests = mutationAllocationRequests(transaction, metaStore, input, requiresProjection);
      collectRequestResults(requests, (results) => {
        try {
          if (results.gate || results.resolution) throw new BootstrapGateError();
          input.assertCurrent?.();
          assertAccountOwnership(results.projectionSnapshot?.value, expectedUserId);
          const clock = mutationClock(input, results);
          allocated = input.build(clock);
          if (requiresProjection) {
            validateAllocatedMutation(transaction, input, results, allocated, clock.wallMs);
          }
          persistAllocatedMutation(transaction, metaStore, input, allocated, clock);
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      });
      transaction.oncomplete = () => resolve(allocated);
      transaction.onabort = () => reject(failure || transaction.error || new Error("Storage transaction aborted."));
      transaction.onerror = () => {};
    });
  }

  function projectedTimer(snapshot, commands, nowMs, overrideCore = null) {
    const result = projectState({
      snapshot,
      queues: { commands: commands || [] },
      nowMs,
      sharedCore: overrideCore
    });
    const timer = result.canonicalTimer;
    if (timer === null) return null;
    const start = [...(commands || [])]
      .filter((command) => command.type === "start" && command.timerId === timer.id)
      .sort(core.compareTimerCommands)
      .at(-1);
    return start?.dependsOnCommandId
      ? { ...timer, dependsOnCommandId: start.dependsOnCommandId }
      : timer;
  }

  function timerOwnerValue(timerId, input) {
    return {
      timerId,
      deviceId: input.deviceId,
      tabId: input.tabId,
      leaseExpiresAtMs: input.nowMs + input.leaseMs
    };
  }

  function canClaimMissingTimerOwner(snapshot, commands, timer, deviceId) {
    if (!timer || !["running", "paused"].includes(timer.status)) return false;
    const canonicalTimer = snapshot?.canonicalTimer || null;
    if (canonicalTimer?.id === timer.id && canonicalTimer.startedByDeviceId !== undefined) {
      return canonicalTimer.startedByDeviceId === deviceId;
    }
    return (commands || []).some((command) => command.type === "start" && command.timerId === timer.id);
  }

  function plannedMissingTimerOwner(owner, snapshot, commands, input) {
    if (owner || !input?.deviceId || !input.tabId) return null;
    const timer = projectedTimer(snapshot, commands, input.nowMs, input.sharedCore);
    if (!canClaimMissingTimerOwner(snapshot, commands, timer, input.deviceId)) return null;
    return timerOwnerValue(timer.id, input);
  }

  function claimMissingTimerOwner(metaStore, owner, snapshot, commands, input) {
    const claimed = plannedMissingTimerOwner(owner, snapshot, commands, input);
    if (claimed) metaStore.put({ key: TIMER_OWNER_KEY, value: claimed });
    return claimed;
  }

  function retainedCommands(commands, removedIds, promotedCommands) {
    const retained = new Map((commands || []).map((command) => [command.id, command]));
    for (const id of removedIds || []) retained.delete(id);
    for (const command of promotedCommands || []) retained.set(command.id, command);
    return [...retained.values()];
  }

  function responseTransactionRebase(input, results, discardedQueueIds = null) {
    if (!input.reconciliation) {
      return {
        queues: input.retainedQueues,
        droppedCommandIds: input.dropCommandIds || [],
        droppedTimerIds: input.dropTimerIds || []
      };
    }
    const storedQueues = {
      commands: results.commands || [],
      taskOperations: results.taskOperations || [],
      durationOperations: results.durationOperations || [],
      autoStartOperations: results.autoStartOperations || [],
      selectedTaskOperations: results.selectedTaskOperations || []
    };
    const rebased = discardedQueueIds
      ? reconcileResolution({
        queues: storedQueues,
        queueIds: discardedQueueIds,
        ...input.reconciliation
      })
      : reconcileState({ queues: storedQueues, ...input.reconciliation });
    return {
      queues: rebased.queues,
      droppedCommandIds: rebased.droppedTimerOperationIds,
      droppedTimerIds: rebased.droppedTimerIds
    };
  }

  function timerMutationStoreNames(withUuidV7) {
    if (!withUuidV7) return [META_STORE, PENDING_STORE];
    return [
      META_STORE,
      PENDING_STORE,
      TASK_PENDING_STORE,
      DURATION_PENDING_STORE,
      AUTO_START_PENDING_STORE,
      SELECTED_TASK_PENDING_STORE
    ];
  }

  function timerMutationRequests(transaction, input, includeOwner) {
    const metaStore = transaction.objectStore(META_STORE);
    const requests = {
      gate: metaStore.get(GATE_KEY),
      resolution: metaStore.get(RESOLUTION_KEY),
      snapshot: metaStore.get("snapshot"),
      deviceSequence: metaStore.get("deviceSequence"),
      hlc: metaStore.get("hlc")
    };
    if (includeOwner) requests.timerOwner = metaStore.get(TIMER_OWNER_KEY);
    requests.commands = transaction.objectStore(PENDING_STORE).getAll();
    if (input.withUuidV7) Object.assign(requests, uuid7RequestSet(transaction, metaStore));
    return requests;
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

  function timerMutationPosition(results, commands, input, count) {
    const highestSequence = commands.reduce(
      (highest, command) => Math.max(highest, Number(command.deviceSequence) || 0),
      Number(results.deviceSequence?.value) || 0
    );
    const storedHlc = results.hlc?.value || { wallMs: 0, counter: 0 };
    const batch = allocateAuthorityHlc(input, storedHlc, count);
    requireMutationRange(input.nowMs, batch.wallMs, batch.counter, highestSequence + count);
    return { highestSequence, wallMs: batch.wallMs, firstCounter: batch.firstCounter };
  }

  function timerMutationIds(results, input, position, count, fallbackIds) {
    if (!input.withUuidV7) return fallbackIds.slice(0, count);
    return reserveUuid7(
      position.wallMs,
      count,
      results.uuidV7?.value || null,
      pendingUuidIds(results),
      input.entropy
    );
  }

  function validateTimerCommandBatch(results, input, commands, persisted, wallMs) {
    const projection = projectState({
      snapshot: results.snapshot?.value || null,
      queues: { commands: commands.concat(persisted) },
      nowMs: wallMs,
      deviceId: input.deviceId,
      sharedCore: input.sharedCore
    });
    for (const command of persisted) {
      validateProspectiveProjection(projection, command, PENDING_STORE);
    }
  }

  function cancelCommandTypes(timer, input) {
    if (!timer || timer.id !== input.timerId || timer.phase !== input.phase) return [];
    if (["running", "paused"].includes(timer.status)) return ["cancel", "clear"];
    if (["completed", "cancelled"].includes(timer.status)) return ["clear"];
    return [];
  }

  function cancelCommandBatch(results, input, timer, commands, types) {
    const position = timerMutationPosition(results, commands, input, types.length);
    const fallbackIds = types.map((type) => type === "cancel" ? input.cancelCommandId : input.clearCommandId);
    const commandIds = timerMutationIds(results, input, position, types.length, fallbackIds);
    const occurredAt = new Date(position.wallMs).toISOString();
    const elapsedMs = Math.min(
      Number(timer.plannedDurationMs),
      Math.max(0, Number(input.observedElapsedMs) || 0)
    );
    const persisted = types.map((type, index) => {
      const command = {
        id: commandIds[index],
        deviceId: input.deviceId,
        deviceSequence: position.highestSequence + index + 1,
        timerId: timer.id,
        type,
        phase: timer.phase,
        plannedDurationMs: timer.plannedDurationMs,
        occurredAt,
        hlcWallMs: position.wallMs,
        hlcCounter: position.firstCounter + index,
        observedElapsedMs: elapsedMs
      };
      if (timer.dependsOnCommandId) command.dependsOnCommandId = timer.dependsOnCommandId;
      return command;
    });
    return { ...position, commandIds, persisted };
  }

  function persistCancelledTimer(metaStore, pendingStore, input, batch) {
    for (const command of batch.persisted) pendingStore.add(command);
    if (input.withUuidV7) metaStore.put({ key: UUID7_KEY, value: batch.commandIds.at(-1) });
    metaStore.delete(TIMER_OWNER_KEY);
    metaStore.put({ key: "deviceSequence", value: batch.highestSequence + batch.persisted.length });
    metaStore.put({
      key: "hlc",
      value: { wallMs: batch.wallMs, counter: batch.firstCounter + batch.persisted.length - 1 }
    });
  }

  function applyCancelAndClearTimer(transaction, input, results) {
    if (results.gate || results.resolution) throw new BootstrapGateError();
    input.assertCurrent?.();
    assertAccountOwnership(results.snapshot?.value, input.expectedUserId);
    const commands = results.commands || [];
    const timer = projectedTimer(results.snapshot?.value, commands, input.nowMs, input.sharedCore);
    const types = cancelCommandTypes(timer, input);
    if (types.length === 0) return { transitioned: false, reason: "stale", commands: [] };
    const batch = cancelCommandBatch(results, input, timer, commands, types);
    validateTimerCommandBatch(results, input, commands, batch.persisted, batch.wallMs);
    persistCancelledTimer(
      transaction.objectStore(META_STORE),
      transaction.objectStore(PENDING_STORE),
      input,
      batch
    );
    return { transitioned: true, reason: "", commands: batch.persisted };
  }

  function cancelAndClearTimer(database, input) {
    input = { ...input };
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(timerMutationStoreNames(input.withUuidV7), "readwrite");
      const requests = timerMutationRequests(transaction, input, false);
      const results = {};
      let outcome;
      let failure = null;
      collectTransactionRequests(requests, results, () => {
        outcome = applyCancelAndClearTimer(transaction, input, results);
      }, (error) => {
        failure = error;
        transaction.abort();
      });
      transaction.oncomplete = () => resolve(outcome);
      transaction.onabort = () => reject(failure || transaction.error || new Error("Storage transaction aborted."));
      transaction.onerror = () => {};
    });
  }

  function finishTimerOwnership(metaStore, results, input, commands, timer) {
    let owner = results.timerOwner?.value || null;
    if (!owner && canClaimMissingTimerOwner(results.snapshot?.value, commands, timer, input.deviceId)) {
      owner = timerOwnerValue(timer.id, input);
      metaStore.put({ key: TIMER_OWNER_KEY, value: owner });
    }
    const ownerIsCurrentTimer = owner?.timerId === input.timerId;
    const ownerDeviceMatches = ownerIsCurrentTimer && owner.deviceId === input.deviceId;
    const leaseNowMs = input.localNowMs ?? input.nowMs;
    const ownerLeaseLive = Number(owner?.leaseExpiresAtMs) > leaseNowMs;
    const ownerGranted = input.manual === true || ownerDeviceMatches
      && (owner.tabId === input.tabId || !ownerLeaseLive);
    let denied = null;
    if (input.requireOwner === true && !ownerGranted) {
      denied = { transitioned: false, reason: "not_owner", commands: [] };
      if (ownerDeviceMatches && Number.isFinite(Number(owner.leaseExpiresAtMs))) {
        denied.retryAtMs = Number(owner.leaseExpiresAtMs);
      }
    }
    return { ownerGranted, leaseNowMs, denied };
  }

  function completionOwnership(timerId, input, ownerGranted) {
    return ownerGranted
      ? { timerId, ownerDeviceId: input.deviceId }
      : null;
  }

  function completionCommandRequest(input, timer, projection, ownerGranted) {
    return storageAuthority(input).completionPlan({
      kind: "commandRequest",
      commandType: "finish",
      requestedTimer: input.requestedTimer || timer,
      projectedTimer: projection.canonicalTimer,
      automatic: input.manual !== true,
      generateAutoBreak: true,
      autoStartBreaks: projection.autoStartBreaks,
      localDeviceId: input.deviceId,
      ownership: completionOwnership(timer.id, input, ownerGranted)
    });
  }

  function finishTimerCommand(timer, input, id, position) {
    const command = {
      id,
      deviceId: input.deviceId,
      deviceSequence: position.highestSequence + 1,
      timerId: timer.id,
      type: "finish",
      phase: timer.phase,
      plannedDurationMs: timer.plannedDurationMs,
      occurredAt: position.occurredAt,
      hlcWallMs: position.wallMs,
      hlcCounter: position.firstCounter,
      observedElapsedMs: Math.min(
        Number(timer.plannedDurationMs),
        Math.max(0, Number(input.observedElapsedMs) || 0)
      )
    };
    if (timer.dependsOnCommandId) command.dependsOnCommandId = timer.dependsOnCommandId;
    return command;
  }

  function generatedBreakCommand(input, id, finishCommand, position, phase, durationMs) {
    return {
      id,
      deviceId: input.deviceId,
      deviceSequence: position.highestSequence + 2,
      timerId: input.breakTimerId,
      type: "start",
      phase,
      plannedDurationMs: durationMs,
      occurredAt: position.occurredAt,
      hlcWallMs: position.wallMs,
      hlcCounter: position.firstCounter + 1,
      observedElapsedMs: 0,
      dependsOnCommandId: finishCommand.id,
      generatedBreak: true
    };
  }

  function finishProjection(results, input, commands, finishCommand, wallMs) {
    const pending = commands.concat(finishCommand);
    const projection = projectState({
      snapshot: results.snapshot?.value || null,
      queues: {
        commands: pending,
        taskOperations: results.taskOperations,
        durationOperations: results.durationOperations,
        autoStartOperations: results.autoStartOperations,
        selectedTaskOperations: results.selectedTaskOperations
      },
      nowMs: wallMs,
      deviceId: input.deviceId,
      sharedCore: input.sharedCore
    });
    const timer = projection.canonicalTimer;
    const start = pending.filter((command) => command.type === "start" && command.timerId === timer?.id)
      .sort(core.compareTimerCommands).at(-1);
    if (timer && start?.dependsOnCommandId) {
      projection.canonicalTimer = { ...timer, dependsOnCommandId: start.dependsOnCommandId };
    }
    return projection;
  }

  function finishAppliedCompletion(input, finishCommand, projection, ownerGranted) {
    return storageAuthority(input).finishAppliedPlan({
      commandId: finishCommand.id,
      timerId: finishCommand.timerId,
      phase: finishCommand.phase,
      occurredAt: finishCommand.occurredAt,
      history: projection.history,
      autoStartBreaks: projection.autoStartBreaks,
      localDeviceId: input.deviceId,
      ownsTimer: ownerGranted,
      referenceMs: Date.parse(finishCommand.occurredAt)
    });
  }

  function finishCommandBatch(results, input, timer, commands, ownerGranted, requestPlan) {
    const generatedCount = requestPlan.reserveGeneratedBreak ? 2 : 1;
    const position = timerMutationPosition(results, commands, input, generatedCount);
    position.occurredAt = new Date(position.wallMs).toISOString();
    const commandIds = timerMutationIds(
      results, input, position, generatedCount, [input.finishCommandId, input.breakCommandId]
    );
    const finishCommand = finishTimerCommand(timer, input, commandIds[0], position);
    const projection = finishProjection(results, input, commands, finishCommand, position.wallMs);
    const completion = finishAppliedCompletion(input, finishCommand, projection, ownerGranted);
    if (completion.queueAutoBreak !== requestPlan.reserveGeneratedBreak) {
      throw new Error("Shared core returned inconsistent generated-break plans.");
    }
    const selectedPhaseDurationMs = projection.durationsMs[completion.selectedPhase];
    const persisted = [finishCommand];
    if (completion.queueAutoBreak) {
      const phase = completion.selectedPhase;
      persisted.push(generatedBreakCommand(
        input, commandIds[1], finishCommand, position, phase, selectedPhaseDurationMs
      ));
    }
    return {
      ...position, commandIds, persisted, selectedPhase: completion.selectedPhase,
      selectedPhaseDurationMs, counter: position.firstCounter + generatedCount - 1
    };
  }

  function persistFinishedTimer(metaStore, pendingStore, input, batch, ownership, settings) {
    for (const command of batch.persisted) pendingStore.add(command);
    if (input.withUuidV7) metaStore.put({ key: UUID7_KEY, value: batch.commandIds.at(-1) });
    if (batch.persisted.length === 2 && ownership.ownerGranted) {
      const breakCommand = batch.persisted[1];
      metaStore.put({
        key: TIMER_OWNER_KEY,
        value: {
          timerId: breakCommand.timerId,
          deviceId: input.deviceId,
          tabId: input.tabId,
          leaseExpiresAtMs: ownership.leaseNowMs + input.leaseMs
        }
      });
    } else if (ownership.ownerGranted) metaStore.delete(TIMER_OWNER_KEY);
    metaStore.put({ key: "deviceSequence", value: batch.highestSequence + batch.persisted.length });
    metaStore.put({ key: "hlc", value: { wallMs: batch.wallMs, counter: batch.counter } });
    if (input.settings) {
      metaStore.put({ key: "settings", value: { ...settings, selectedPhase: batch.selectedPhase } });
    }
  }

  function applyFinishedTimer(transaction, input, results) {
    if (results.gate || results.resolution) throw new BootstrapGateError();
    input.assertCurrent?.();
    assertAccountOwnership(results.snapshot?.value, input.expectedUserId);
    const commands = results.commands || [];
    const projection = finishProjection(results, input, commands, [], input.nowMs);
    const projected = projection.canonicalTimer;
    const timer = input.requestedTimer || finishProjection(
      results, input, commands, [], input.localNowMs ?? input.nowMs
    ).canonicalTimer;
    if (!timer || timer.id !== input.timerId || timer.phase !== input.phase
      || !["running", "paused"].includes(timer.status) || projected?.id !== timer.id
      || projected.lastIntent?.type === "finish") {
      return { transitioned: false, reason: "stale", commands: [] };
    }
    const metaStore = transaction.objectStore(META_STORE);
    const ownership = finishTimerOwnership(metaStore, results, input, commands, timer);
    if (ownership.denied) return ownership.denied;
    const requestPlan = completionCommandRequest(input, timer, projection, ownership.ownerGranted);
    if (!requestPlan.commandEligible) {
      return { transitioned: false, reason: "stale", commands: [] };
    }
    const batch = finishCommandBatch(
      results, input, timer, commands, ownership.ownerGranted, requestPlan
    );
    const prospective = finishProjection(results, input, commands, batch.persisted, batch.wallMs);
    for (const command of batch.persisted) {
      validateProspectiveProjection(prospective, command, PENDING_STORE);
    }
    persistFinishedTimer(
      metaStore,
      transaction.objectStore(PENDING_STORE),
      input,
      batch,
      ownership,
      results.settings?.value || {}
    );
    return {
      transitioned: true, reason: "", commands: batch.persisted, selectedPhase: batch.selectedPhase,
      selectedPhaseDurationMs: batch.selectedPhaseDurationMs
    };
  }

  function finishTimer(database, input) {
    input = { ...input };
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(timerMutationStoreNames(true), "readwrite");
      const requests = finishedTimerRequests(transaction, input);
      const results = {};
      let outcome;
      let failure = null;
      collectTransactionRequests(requests, results, () => {
        outcome = applyFinishedTimer(transaction, input, results);
      }, (error) => {
        failure = error;
        transaction.abort();
      });
      transaction.oncomplete = () => resolve(outcome);
      transaction.onabort = () => reject(failure || transaction.error || new Error("Storage transaction aborted."));
      transaction.onerror = () => {};
    });
  }

  function finishedTimerRequests(transaction, input) {
    return {
      ...timerMutationRequests(transaction, input, true),
      settings: transaction.objectStore(META_STORE).get("settings"),
      taskOperations: transaction.objectStore(TASK_PENDING_STORE).getAll(),
      durationOperations: transaction.objectStore(DURATION_PENDING_STORE).getAll(),
      autoStartOperations: transaction.objectStore(AUTO_START_PENDING_STORE).getAll(),
      selectedTaskOperations: transaction.objectStore(SELECTED_TASK_PENDING_STORE).getAll()
    };
  }

  function renewTimerOwnership(database, input) {
    return guardedMutation(database, [PENDING_STORE], (transaction, outcome, abort) => {
      const store = transaction.objectStore(META_STORE);
      const requests = {
        owner: store.get(TIMER_OWNER_KEY),
        snapshot: store.get("snapshot"),
        commands: transaction.objectStore(PENDING_STORE).getAll()
      };
      const results = {};
      outcome.value = false;
      collectTransactionRequests(requests, results, () => {
        input.assertCurrent?.();
        let owner = results.owner?.value || null;
        owner ||= claimMissingTimerOwner(
          store,
          owner,
          results.snapshot?.value,
          results.commands || [],
          input
        );
        const sameTimerAndDevice = owner?.timerId === input.timerId && owner.deviceId === input.deviceId;
        const leaseLive = Number(owner?.leaseExpiresAtMs) > input.nowMs;
        if (!sameTimerAndDevice || owner.tabId !== input.tabId && leaseLive) return;
        store.put({ key: TIMER_OWNER_KEY, value: timerOwnerValue(input.timerId, input) });
        outcome.value = true;
      }, abort);
    }, { ...input, allowBootstrap: true });
  }

  function releaseTimerOwnership(database, input) {
    return guardedMutation(database, [], (transaction, outcome, abort) => {
      const store = transaction.objectStore(META_STORE);
      const request = store.get(TIMER_OWNER_KEY);
      request.onsuccess = () => {
        try { input.assertCurrent?.(); } catch (error) { abort(error); return; }
        const owner = request.result?.value || null;
        if (owner?.deviceId !== input.deviceId || owner.tabId !== input.tabId) return;
        store.put({ key: TIMER_OWNER_KEY, value: { ...owner, leaseExpiresAtMs: input.nowMs } });
      };
    }, { ...input, allowBootstrap: true });
  }

  function resolutionCaptureRequests(transaction) {
    const metaStore = transaction.objectStore(META_STORE);
    return {
      snapshot: metaStore.get("snapshot"),
      gate: metaStore.get(GATE_KEY),
      resolution: metaStore.get(RESOLUTION_KEY),
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
    if (existingResolution && !options.replaceExisting) {
      throw new BootstrapGateError("Saved history resolution already exists.");
    }
    if (existingResolution && (existingResolution.gateToken !== options.gateToken
      || typeof input.requestId !== "string" || !input.requestId
      || input.requestId === existingResolution.payload?.requestId)) {
      throw new BootstrapGateError("Saved history resolution replacement requires its owner and a fresh request ID.");
    }
  }

  function compareResolutionOperations(left, right) {
    return Number(left.hlcWallMs) - Number(right.hlcWallMs)
      || Number(left.hlcCounter) - Number(right.hlcCounter)
      || String(left.id).localeCompare(String(right.id));
  }

  function canonicalCapturedDurations(durationStore, operations) {
    return operations.map((operation) => {
      const normalized = core.durationRequestOperation(operation);
      if (normalized.occurredAt !== operation.occurredAt) {
        durationStore.put({ ...operation, occurredAt: normalized.occurredAt });
      }
      return { ...operation, occurredAt: normalized.occurredAt };
    }).sort(compareResolutionOperations);
  }

  function resolutionCaptureInput(transaction, results, input) {
    const commands = (results.commands || []).sort(core.compareTimerCommands);
    const durationOperations = canonicalCapturedDurations(
      transaction.objectStore(DURATION_PENDING_STORE),
      results.durationOperations || []
    );
    const resolutionInput = {
      ...input,
      commands,
      taskOperations: (results.taskOperations || []).sort(compareResolutionOperations),
      durationOperations,
      selectedTaskOperations: (results.selectedTaskOperations || []).sort(compareResolutionOperations)
    };
    const autoStartOperations = (results.autoStartOperations || []).sort(compareResolutionOperations);
    if (autoStartOperations.length > 0 || input.autoStartOperationsPresent === true) {
      resolutionInput.autoStartOperations = autoStartOperations;
    }
    return resolutionInput;
  }

  function createCapturedResolution(transaction, results, input, options) {
    validateResolutionCapture(results, input, options);
    const pending = {
      ...core.createPendingResolution(resolutionCaptureInput(transaction, results, input)),
      gateToken: options.gateToken,
      sourceOwnerId: core.accountOwnerId(results.snapshot?.value?.user) || null
    };
    const violation = core.resolutionLimitViolation(pending.payload);
    if (violation) throw new ResolutionLimitError(violation);
    transaction.objectStore(META_STORE).put({ key: RESOLUTION_KEY, value: pending });
    return pending;
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
    return accountMetadataMutation(database, input, [], (store, results) => {
      const resolution = results.resolution?.value || null;
      if (!input.pending || input.pending.userId !== input.currentUserId
        || !resolution || resolution.userId !== input.currentUserId
        || JSON.stringify(resolution) !== JSON.stringify(input.pending)) {
        throw new BootstrapGateError("Saved history resolution does not match current account.");
      }
      validateResolutionApply(results, input.pending);
      store.put({ key: GATE_KEY, value: boundBootstrapLease(input.gateToken, input) });
      return resolution;
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
    claimMissingTimerOwner(
      metaStore,
      results.timerOwner?.value || null,
      storedSnapshot,
      results.commands || [],
      canonical.timerOwnerClaim
    );
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
    return { hlc, clockOffset };
  }

  function applyResolutionTimerOwner(metaStore, results, canonical, queueIds, rebased) {
    const owner = results.timerOwner?.value || null;
    if (rebased.droppedTimerIds.includes(owner?.timerId)) {
      metaStore.delete(TIMER_OWNER_KEY);
      return;
    }
    const commands = canonical.reconciliation
      ? rebased.queues.commands
      : retainedCommands(
        results.commands,
        [...(queueIds.commands || []), ...rebased.droppedCommandIds],
        canonical.promoteCommands
      );
    claimMissingTimerOwner(
      metaStore,
      owner,
      canonical.snapshot,
      commands,
      canonical.timerOwnerClaim
    );
  }

  function applyPendingResolution(transaction, results, pending, canonical) {
    canonical.assertCurrent?.();
    assertAccountOwnership(canonical.snapshot, pending.userId);
    const metaStore = transaction.objectStore(META_STORE);
    const staleOutcome = staleResolutionOutcome(metaStore, results, pending, canonical);
    if (staleOutcome) return staleOutcome;
    validateResolutionApply(results, pending);
    const queueIds = pending.queueIds || {};
    const rebased = responseTransactionRebase(canonical, results, queueIds);
    applyResolutionQueues(transaction, queueIds, canonical, rebased);
    completeResolutionLegacyMigrations(metaStore, results.settings, pending);
    const { hlc, clockOffset } = applyResolutionMetadata(metaStore, results, canonical);
    applyResolutionTimerOwner(metaStore, results, canonical, queueIds, rebased);
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

  function syncResponseRequests(transaction) {
    const metaStore = transaction.objectStore(META_STORE);
    return {
      gate: metaStore.get(GATE_KEY), resolution: metaStore.get(RESOLUTION_KEY),
      snapshot: metaStore.get("snapshot"), hlc: metaStore.get("hlc"),
      clockOffset: metaStore.get(CLOCK_OFFSET_KEY), timerOwner: metaStore.get(TIMER_OWNER_KEY),
      commands: transaction.objectStore(PENDING_STORE).getAll(),
      taskOperations: transaction.objectStore(TASK_PENDING_STORE).getAll(),
      durationOperations: transaction.objectStore(DURATION_PENDING_STORE).getAll(),
      autoStartOperations: transaction.objectStore(AUTO_START_PENDING_STORE).getAll(),
      selectedTaskOperations: transaction.objectStore(SELECTED_TASK_PENDING_STORE).getAll()
    };
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

  function plannedTimerOwner(input, results, rebased) {
    const owner = results.timerOwner?.value || null;
    if (rebased.droppedTimerIds.includes(owner?.timerId)) return { remove: true, value: null };
    const commands = retainedCommands(
      results.commands,
      [...(input.queueIds.commands || []), ...rebased.droppedCommandIds],
      rebased.queues?.commands || input.promoteCommands
    );
    return {
      remove: false,
      value: plannedMissingTimerOwner(owner, input.snapshot, commands, input.timerOwnerClaim)
    };
  }

  function planSyncResponse(input, results) {
    const storedSnapshot = results.snapshot?.value || null;
    validateSyncResponseApply(input, results, storedSnapshot);
    const clockOffset = latestClockOffset(results.clockOffset?.value || null, input.clockOffset);
    if (Number(storedSnapshot?.revision || 0) > Number(input.snapshot.revision)) {
      const owner = results.timerOwner?.value || null;
      const ownerClaim = plannedMissingTimerOwner(
        owner, storedSnapshot, results.commands || [], input.timerOwnerClaim
      );
      return {
        kind: "stale", clockOffset, ownerClaim,
        outcome: { applied: false, stale: true, snapshot: storedSnapshot, clockOffset }
      };
    }
    const rebased = responseTransactionRebase(input, results);
    const responseHlc = input.clockOffset != null && clockOffset === input.clockOffset
      ? input.hlc
      : input.serverHlc || input.hlc;
    const hlc = laterHlc(results.hlc?.value, responseHlc);
    return {
      kind: "apply", rebased, clockOffset, hlc,
      owner: plannedTimerOwner(input, results, rebased),
      outcome: { applied: true, stale: false, snapshot: input.snapshot, hlc, clockOffset }
    };
  }

  function persistReconciledQueue(store, capturedIds, retained) {
    for (const id of capturedIds || []) store.delete(id);
    for (const item of retained || []) store.put(item);
  }

  function persistSyncResponsePlan(transaction, input, plan) {
    const metaStore = transaction.objectStore(META_STORE);
    if (plan.clockOffset === input.clockOffset) {
      metaStore.put({ key: CLOCK_OFFSET_KEY, value: input.clockOffset });
    }
    if (plan.kind === "stale") {
      if (plan.ownerClaim) metaStore.put({ key: TIMER_OWNER_KEY, value: plan.ownerClaim });
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
    if (input.settings) metaStore.put({ key: "settings", value: input.settings });
    if (plan.owner.remove) metaStore.delete(TIMER_OWNER_KEY);
    else if (plan.owner.value) metaStore.put({ key: TIMER_OWNER_KEY, value: plan.owner.value });
    metaStore.put({ key: "hlc", value: plan.hlc });
  }

  function applySyncResponseCoordinator(database, input) {
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
    const [snapshot, hlc, clockOffset, commands, taskOperations, durationOperations, autoStartOperations, selectedTaskOperations] = await Promise.all([
      requestResult(metaStore.get("snapshot")),
      requestResult(metaStore.get("hlc")),
      requestResult(metaStore.get(CLOCK_OFFSET_KEY)),
      requestResult(transaction.objectStore(PENDING_STORE).getAll()),
      requestResult(transaction.objectStore(TASK_PENDING_STORE).getAll()),
      requestResult(transaction.objectStore(DURATION_PENDING_STORE).getAll()),
      requestResult(transaction.objectStore(AUTO_START_PENDING_STORE).getAll()),
      requestResult(transaction.objectStore(SELECTED_TASK_PENDING_STORE).getAll())
    ]);
    return {
      snapshot: snapshot?.value || null,
      hlc: hlc?.value || null,
      clockOffset: core.validClockSample(clockOffset?.value) ? clockOffset.value : null,
      commands,
      taskOperations,
      durationOperations,
      autoStartOperations,
      selectedTaskOperations
    };
  }

  function migrateLegacySelectedTask(database, input) {
    return legacySettingsMutation(database, SELECTED_TASK_PENDING_STORE, input, (transaction, settings) => {
      if (settings.selectedTaskSyncBootstrapped === true) return { migrated: false, operation: null };
      const { selectedTaskId, ...nextSettings } = settings;
      const operation = typeof selectedTaskId === "string" && selectedTaskId
        ? { id: input.operationId, taskId: selectedTaskId, occurredAt: LEGACY_EPOCH, hlcWallMs: 0, hlcCounter: 0 }
        : null;
      if (operation) transaction.objectStore(SELECTED_TASK_PENDING_STORE).add(operation);
      transaction.objectStore(META_STORE).put({
        key: "settings", value: { ...nextSettings, selectedTaskSyncBootstrapped: true }
      });
      return { migrated: operation !== null, operation };
    });
  }

  function migrateLegacyAutoStart(database, input) {
    return legacySettingsMutation(database, AUTO_START_PENDING_STORE, input, (transaction, settings) => {
      if (settings.autoStartSyncBootstrapped === true) return { migrated: false, operation: null };
      const { autoStartBreaks, autoStartBreaksExplicit, ...nextSettings } = settings;
      const operation = autoStartBreaks === true || autoStartBreaksExplicit === true
        ? { id: input.operationId, enabled: autoStartBreaks === true,
          occurredAt: LEGACY_EPOCH, hlcWallMs: 0, hlcCounter: 0 } : null;
      if (operation) transaction.objectStore(AUTO_START_PENDING_STORE).add(operation);
      transaction.objectStore(META_STORE).put({
        key: "settings", value: { ...nextSettings, autoStartSyncBootstrapped: true }
      });
      return { migrated: operation !== null, operation };
    });
  }

  function legacySettingsMutation(database, storeName, input, change) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction([META_STORE, storeName], "readwrite");
      const metaStore = transaction.objectStore(META_STORE);
      const results = {};
      const requests = { settings: metaStore.get("settings"), snapshot: metaStore.get("snapshot"),
        gate: metaStore.get(GATE_KEY), resolution: metaStore.get(RESOLUTION_KEY) };
      let result;
      let failure;
      collectTransactionRequests(requests, results, () => {
        assertStorageContext(results, input);
        result = change(transaction, results.settings?.value || {});
      }, (error) => { failure = error; transaction.abort(); });
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(failure || transaction.error || new Error("Storage transaction aborted."));
      transaction.onerror = () => {};
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
      const transaction = database.transaction([META_STORE, DURATION_PENDING_STORE], "readwrite");
      const metaStore = transaction.objectStore(META_STORE);
      const durationStore = transaction.objectStore(DURATION_PENDING_STORE);
      const requests = {
        snapshot: metaStore.get("snapshot"),
        durations: durationStore.getAll(),
        gate: metaStore.get(GATE_KEY),
        resolution: metaStore.get(RESOLUTION_KEY)
      };
      const results = {};
      const state = { changed: 0, resolution: null };
      let failure = null;
      collectTransactionRequests(requests, results, () => {
        assertStorageContext(results, options);
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
    acquireBootstrapGate,
    acquireBootstrapGateWithLegacyAutoStart,
    allocateClockRequestSequence,
    allocateMutation,
    applyResolution,
    applySyncResponse,
    applySyncResponseCoordinator,
    planSyncResponse,
    cancelAndClearTimer,
    captureResolution,
    clearBootstrapGate,
    finishAppliedPlan,
    finishTimer,
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
    validatePendingForSend
  });
});
