(function (root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PomodoroughSync = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  const STRATEGIES = new Set(["keep_remote", "replace_remote", "merge"]);
  const PHASES = new Set(["focus", "short_break", "long_break"]);
  const TIMER_STATUSES = new Set(["running", "paused", "completed", "cancelled", "superseded"]);
  const HISTORY_STATUSES = new Set(["completed", "cancelled", "superseded"]);
  const ACK_OUTCOMES = new Set(["applied", "ignored", "rejected"]);
  const RESOLUTION_OPERATION_LIMIT = 4096;

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function completedHistoryCount(history) {
    if (!Array.isArray(history)) return 0;
    const identities = new Set();
    let count = 0;
    for (const item of history) {
      if (item?.status && item.status !== "completed") continue;
      const identity = typeof item?.timerId === "string" && item.timerId
        ? `timer:${item.timerId}`
        : typeof item?.id === "string" && item.id
          ? `id:${item.id}`
          : null;
      if (identity && identities.has(identity)) continue;
      if (identity) identities.add(identity);
      count += 1;
    }
    return count;
  }

  function durationsDiffer(durationsMs, defaults) {
    if (!durationsMs || !defaults) return false;
    return Object.keys(defaults).some((phase) => Number(durationsMs[phase]) !== Number(defaults[phase]));
  }

  function hasLocalState(local) {
    return completedHistoryCount(local.history) > 0
      || (Array.isArray(local.commands) && local.commands.length > 0)
      || (Array.isArray(local.taskOperations) && local.taskOperations.length > 0)
      || (Array.isArray(local.durationOperations) && local.durationOperations.length > 0)
      || (Array.isArray(local.tasks) && local.tasks.length > 0)
      || Boolean(local.timer?.id)
      || Boolean(local.timer?.status && local.timer.status !== "idle")
      || durationsDiffer(local.durationsMs, local.defaultDurationsMs);
  }

  function decideBootstrap(input) {
    const localOwnerId = input.localOwnerId || null;
    const currentUserId = input.currentUserId || null;
    if (localOwnerId && localOwnerId === currentUserId) {
      return { mode: "normal_sync", reason: "same_owner" };
    }
    if (localOwnerId && localOwnerId !== currentUserId) {
      return { mode: "auto", strategy: "keep_remote", reason: "different_owner" };
    }

    const localHistoryCount = completedHistoryCount(input.localHistory);
    const remoteHistoryCount = completedHistoryCount(input.remoteHistory);
    if (localHistoryCount > 0 && remoteHistoryCount > 0) {
      return { mode: "choose", localHistoryCount, remoteHistoryCount };
    }
    if (localHistoryCount > 0) {
      return { mode: "auto", strategy: "replace_remote", reason: "local_only" };
    }
    if (remoteHistoryCount > 0) {
      return { mode: "auto", strategy: "keep_remote", reason: "remote_only" };
    }
    return {
      mode: "auto",
      strategy: input.hasLocalState ? "merge" : "keep_remote",
      reason: input.hasLocalState ? "local_state_only" : "empty"
    };
  }

  function confirmationFor(strategy) {
    switch (strategy) {
      case "replace_remote":
        return {
          title: "Replace remote history?",
          message: "Remote history and current account state will be permanently replaced by data from this device.",
          confirmLabel: "Replace with local"
        };
      case "keep_remote":
        return {
          title: "Discard local history?",
          message: "Unsigned local history and queued changes on this device will be permanently discarded.",
          confirmLabel: "Keep remote"
        };
      case "merge":
        return {
          title: "Combine both histories?",
          message: "Combining concurrent timer, task, and duration changes can produce conflicts or rejected operations. Review any sync warning after completion.",
          confirmLabel: "Combine histories"
        };
      default:
        throw new Error(`Unknown bootstrap strategy: ${strategy}`);
    }
  }

  function canSubmitResolution(mode, confirmed) {
    return mode === "auto" || mode === "choose" && confirmed === true;
  }

  function requiresBootstrapResolution(input) {
    return input.blocked === true
      || input.persistedGate === true
      || Boolean(input.pending)
      || Boolean(input.currentUserId && input.localOwnerId !== input.currentUserId);
  }

  function canExposeOwnerState(input) {
    return input.sessionValidated === true
      && Boolean(input.localOwnerId)
      && input.localOwnerId === input.currentUserId;
  }

  function canUseCachedOwnerOffline(input) {
    return input.sessionValidated !== true
      && Boolean(input.cachedUserId)
      && input.cachedUserId === input.localOwnerId
      && input.gateOwned === true
      && !input.pending;
  }

  function pendingMatchesUser(pending, userId) {
    return Boolean(pending && userId && pending.userId === userId);
  }

  function isResolutionStrategy(strategy) {
    return STRATEGIES.has(strategy);
  }

  function pendingResolutionCanSubmit(pending, userId) {
    return pendingMatchesUser(pending, userId) && isResolutionStrategy(pending.payload?.strategy);
  }

  function bootstrapDialogView(input) {
    const chooser = input.planMode === "choose";
    const failed = Boolean(input.error);
    const choosing = chooser && !input.strategy && !input.pending && !failed;
    const confirming = chooser && Boolean(input.strategy) && !failed;
    return {
      open: input.blocked === true && input.authenticated === true && (choosing || confirming || failed),
      choosing,
      confirming,
      failed,
      busy: input.submitting === true
    };
  }

  function resolutionOperations(strategy, operations) {
    if (!STRATEGIES.has(strategy)) throw new Error(`Unknown bootstrap strategy: ${strategy}`);
    if (strategy === "keep_remote") {
      return { commands: [], taskOperations: [], durationOperations: [] };
    }
    return {
      commands: clone(operations.commands || []),
      taskOperations: clone(operations.taskOperations || []),
      durationOperations: (operations.durationOperations || []).map(durationRequestOperation)
    };
  }

  function buildResolutionPayload(input) {
    const operations = resolutionOperations(input.strategy, input);
    return {
      requestId: input.requestId,
      deviceId: input.deviceId,
      expectedRevision: input.expectedRevision,
      strategy: input.strategy,
      commands: operations.commands,
      taskOperations: operations.taskOperations,
      durationOperations: operations.durationOperations
    };
  }

  function queueIds(input) {
    return {
      commands: (input.commands || []).map((item) => item.id),
      taskOperations: (input.taskOperations || []).map((item) => item.id),
      durationOperations: (input.durationOperations || []).map((item) => item.id)
    };
  }

  function createPendingResolution(input) {
    return {
      userId: input.userId,
      payload: buildResolutionPayload(input),
      queueIds: queueIds(input)
    };
  }

  function resolutionLimitViolation(payload, limit = RESOLUTION_OPERATION_LIMIT) {
    for (const field of ["commands", "taskOperations", "durationOperations"]) {
      const count = Array.isArray(payload?.[field]) ? payload[field].length : 0;
      if (count > limit) return { field, count, limit };
    }
    return null;
  }

  function durationRequestOperation(operation) {
    return {
      id: operation.id,
      phase: operation.phase,
      durationMs: operation.durationMs,
      occurredAt: operation.occurredAt,
      hlcWallMs: operation.hlcWallMs,
      hlcCounter: operation.hlcCounter
    };
  }

  function buildSyncBatch(input, limit = 256) {
    return {
      commands: clone((input.commands || []).slice(0, limit)),
      taskOperations: clone((input.taskOperations || []).slice(0, limit)),
      durationOperations: (input.durationOperations || []).slice(0, limit).map(durationRequestOperation)
    };
  }

  function exactAcknowledgements(payload, field, sentItems, idField) {
    const acknowledgements = payload[field];
    if (!Array.isArray(acknowledgements)) {
      throw new Error(`Sync response omitted ${field}.`);
    }
    const expectedIds = new Set(sentItems.map((item) => item.id));
    if (expectedIds.size !== sentItems.length || acknowledgements.length !== expectedIds.size) {
      throw new Error(`Sync response returned an invalid ${field} set.`);
    }
    const acknowledgedIds = new Set();
    for (const acknowledgement of acknowledgements) {
      const id = acknowledgement?.[idField];
      if (typeof id !== "string" || !expectedIds.has(id) || acknowledgedIds.has(id)
        || !ACK_OUTCOMES.has(acknowledgement.outcome) || typeof acknowledgement.reason !== "string") {
        throw new Error(`Sync response returned an invalid ${field} set.`);
      }
      acknowledgedIds.add(id);
    }
    return { acknowledgements, acknowledgedIds };
  }

  function validateAcknowledgements(payload, sent) {
    return {
      commands: exactAcknowledgements(payload, "acknowledgements", sent.commands, "commandId"),
      tasks: exactAcknowledgements(payload, "taskAcknowledgements", sent.taskOperations, "operationId"),
      durations: exactAcknowledgements(payload, "durationAcknowledgements", sent.durationOperations, "operationId")
    };
  }

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function parseDateTime(value) {
    if (typeof value !== "string") return null;
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|([+-])(\d{2}):(\d{2}))$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    const fraction = match[7] || "";
    const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
    const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const valid = month >= 1 && month <= 12
      && day >= 1 && day <= daysInMonth[month - 1]
      && hour <= 23
      && minute <= 59
      && second <= 59
      && offsetHour <= 23
      && offsetMinute <= 59;
    if (!valid) return null;
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(hour, minute, second, 0);
    const offsetDirection = match[9] === "+" ? 1 : match[9] === "-" ? -1 : 0;
    return {
      seconds: date.getTime() / 1000 - offsetDirection * (offsetHour * 60 + offsetMinute) * 60,
      fraction: fraction.replace(/0+$/, "")
    };
  }

  function validDateTime(value) {
    return parseDateTime(value) !== null;
  }

  function compareServerTimes(left, right) {
    const parsedLeft = parseDateTime(left);
    const parsedRight = parseDateTime(right);
    if (!parsedLeft || !parsedRight) return null;
    if (parsedLeft.seconds !== parsedRight.seconds) return parsedLeft.seconds < parsedRight.seconds ? -1 : 1;
    const width = Math.max(parsedLeft.fraction.length, parsedRight.fraction.length);
    const leftFraction = parsedLeft.fraction.padEnd(width, "0");
    const rightFraction = parsedRight.fraction.padEnd(width, "0");
    if (leftFraction === rightFraction) return 0;
    return leftFraction < rightFraction ? -1 : 1;
  }

  function validInteger(value, minimum, maximum = Number.MAX_SAFE_INTEGER) {
    return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
  }

  function validateCanonicalTimer(timer) {
    if (timer === null) return;
    if (!isObject(timer)
      || typeof timer.id !== "string" || !timer.id
      || !PHASES.has(timer.phase)
      || !TIMER_STATUSES.has(timer.status)
      || !validInteger(timer.plannedDurationMs, 60_000, 14_400_000)
      || !validInteger(timer.elapsedAtAnchorMs, 0, timer.plannedDurationMs)
      || !validDateTime(timer.anchorAt)
      || timer.taskId !== undefined && typeof timer.taskId !== "string") {
      throw new Error("Bootstrap response returned an invalid canonicalTimer.");
    }
    if (timer.lastIntent !== undefined && (!isObject(timer.lastIntent)
      || typeof timer.lastIntent.type !== "string"
      || typeof timer.lastIntent.commandId !== "string"
      || !validDateTime(timer.lastIntent.occurredAt))) {
      throw new Error("Bootstrap response returned an invalid canonicalTimer.");
    }
  }

  function validateHistory(history) {
    if (!Array.isArray(history)) throw new Error("Bootstrap response omitted history.");
    const ids = new Set();
    const timerIds = new Set();
    for (const item of history) {
      if (!isObject(item)
        || typeof item.id !== "string" || !item.id
        || typeof item.timerId !== "string" || !item.timerId
        || ids.has(item.id)
        || timerIds.has(item.timerId)
        || !PHASES.has(item.phase)
        || !HISTORY_STATUSES.has(item.status)
        || !validInteger(item.plannedDurationMs, 60_000, 14_400_000)
        || item.status === "completed" && !validDateTime(item.completedAt)
        || item.status !== "completed" && !validDateTime(item.endedAt)
        || item.taskId !== undefined && typeof item.taskId !== "string"
        || item.commandId !== undefined && typeof item.commandId !== "string"
        || item.completedAt !== undefined && !validDateTime(item.completedAt)
        || item.endedAt !== undefined && !validDateTime(item.endedAt)) {
        throw new Error("Bootstrap response returned invalid history.");
      }
      ids.add(item.id);
      timerIds.add(item.timerId);
    }
  }

  function validateTasks(tasks) {
    if (!Array.isArray(tasks)) throw new Error("Bootstrap response omitted tasks.");
    for (const task of tasks) {
      if (!isObject(task) || typeof task.id !== "string" || !task.id || typeof task.title !== "string") {
        throw new Error("Bootstrap response returned invalid tasks.");
      }
    }
  }

  function validateDurations(durationsMs) {
    if (!isObject(durationsMs)) throw new Error("Bootstrap response omitted durationsMs.");
    for (const phase of PHASES) {
      if (!validInteger(durationsMs[phase], 60_000, 10_800_000) || durationsMs[phase] % 60_000 !== 0) {
        throw new Error("Bootstrap response returned invalid durationsMs.");
      }
    }
  }

  function validateCanonicalResponse(payload, sent) {
    if (!isObject(payload)) throw new Error("Bootstrap response was not an object.");
    const acknowledgements = validateAcknowledgements(payload, sent);
    if (!validInteger(payload.revision, 0)) throw new Error("Bootstrap response omitted revision.");
    if (!Object.prototype.hasOwnProperty.call(payload, "canonicalTimer")) {
      throw new Error("Bootstrap response omitted canonicalTimer.");
    }
    validateCanonicalTimer(payload.canonicalTimer);
    validateHistory(payload.history);
    validateTasks(payload.tasks);
    validateDurations(payload.durationsMs);
    if (!validDateTime(payload.serverTime)) throw new Error("Bootstrap response omitted serverTime.");
    if (!validInteger(payload.serverHlcWallMs, 1) || !validInteger(payload.serverHlcCounter, 0)) {
      throw new Error("Bootstrap response returned an invalid server HLC.");
    }
    return acknowledgements;
  }

  async function postJSONWithCsrfRetry(input) {
    const send = (csrfToken) => input.fetcher(input.url, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken
      },
      body: input.body
    });
    let response = await send(input.csrfToken);
    if (response.status !== 403) return response;
    const refreshedToken = await input.refreshCsrf();
    if (typeof refreshedToken !== "string" || !refreshedToken) {
      throw new Error("CSRF refresh failed.");
    }
    response = await send(refreshedToken);
    return response;
  }

  function applyTaskOperations(baseTasks, operations) {
    const tasks = new Map((baseTasks || []).map((task) => [task.id, clone(task)]));
    const ordered = [...(operations || [])].sort((left, right) =>
      Number(left.hlcWallMs) - Number(right.hlcWallMs)
      || Number(left.hlcCounter) - Number(right.hlcCounter)
      || String(left.id).localeCompare(String(right.id))
    );
    for (const operation of ordered) {
      if (operation.type === "upsert") tasks.set(operation.taskId, { id: operation.taskId, title: operation.title });
      if (operation.type === "delete") tasks.delete(operation.taskId);
    }
    return [...tasks.values()].sort((left, right) =>
      left.title.localeCompare(right.title) || left.id.localeCompare(right.id)
    );
  }

  function rebaseSyncState(local, payload, sent) {
    const validated = validateAcknowledgements(payload, sent);
    const pending = (local.commands || []).filter((item) => !validated.commands.acknowledgedIds.has(item.id));
    const pendingTaskOperations = (local.taskOperations || []).filter((item) => !validated.tasks.acknowledgedIds.has(item.id));
    const pendingDurationOperations = (local.durationOperations || []).filter((item) => !validated.durations.acknowledgedIds.has(item.id));
    return canonicalRebase(local, payload, pending, pendingTaskOperations, pendingDurationOperations, validated);
  }

  function applyResolutionState(local, payload, pendingResolution) {
    const validated = validateAcknowledgements(payload, pendingResolution.payload);
    const discarded = pendingResolution.queueIds || {};
    const commandIds = new Set(discarded.commands || []);
    const taskOperationIds = new Set(discarded.taskOperations || []);
    const durationOperationIds = new Set(discarded.durationOperations || []);
    const pending = (local.commands || []).filter((item) => !commandIds.has(item.id));
    const pendingTaskOperations = (local.taskOperations || []).filter((item) => !taskOperationIds.has(item.id));
    const pendingDurationOperations = (local.durationOperations || []).filter((item) => !durationOperationIds.has(item.id));
    return canonicalRebase(local, payload, pending, pendingTaskOperations, pendingDurationOperations, validated);
  }

  function canonicalRebase(local, payload, pending, pendingTaskOperations, pendingDurationOperations, validated) {
    const baseTasks = Array.isArray(payload.tasks) ? clone(payload.tasks) : clone(local.baseTasks || []);
    return {
      acknowledgements: validated,
      pending,
      pendingTaskOperations,
      pendingDurationOperations,
      baseTimer: Object.prototype.hasOwnProperty.call(payload, "canonicalTimer") ? clone(payload.canonicalTimer) : clone(local.baseTimer),
      baseHistory: Array.isArray(payload.history) ? clone(payload.history) : clone(local.baseHistory || []),
      baseTasks,
      baseDurationsMs: Object.prototype.hasOwnProperty.call(payload, "durationsMs") ? clone(payload.durationsMs) : clone(local.baseDurationsMs),
      tasks: applyTaskOperations(baseTasks, pendingTaskOperations),
      revision: payload.revision ?? local.revision
    };
  }

  return Object.freeze({
    applyResolutionState,
    applyTaskOperations,
    bootstrapDialogView,
    buildResolutionPayload,
    buildSyncBatch,
    canExposeOwnerState,
    canSubmitResolution,
    canUseCachedOwnerOffline,
    compareServerTimes,
    completedHistoryCount,
    confirmationFor,
    createPendingResolution,
    decideBootstrap,
    durationRequestOperation,
    hasLocalState,
    isResolutionStrategy,
    pendingMatchesUser,
    pendingResolutionCanSubmit,
    postJSONWithCsrfRetry,
    rebaseSyncState,
    requiresBootstrapResolution,
    RESOLUTION_OPERATION_LIMIT,
    resolutionLimitViolation,
    validateCanonicalResponse,
    validateAcknowledgements
  });
});
