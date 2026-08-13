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
  const MAX_CLOCK_SKEW_MS = 5 * 60_000;
  const MAX_CLOCK_UNCERTAINTY_MS = 30_000;
  const LEGACY_EPOCH = new Date(0).toISOString();

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
    return (Array.isArray(local.history) && local.history.length > 0)
      || (Array.isArray(local.commands) && local.commands.length > 0)
      || (Array.isArray(local.taskOperations) && local.taskOperations.length > 0)
      || (Array.isArray(local.durationOperations) && local.durationOperations.length > 0)
      || (Array.isArray(local.autoStartOperations) && local.autoStartOperations.length > 0)
      || (Array.isArray(local.selectedTaskOperations) && local.selectedTaskOperations.length > 0)
      || (Array.isArray(local.tasks) && local.tasks.length > 0)
      || Boolean(local.timer?.id)
      || Boolean(local.timer?.status && local.timer.status !== "idle")
      || Boolean(local.selectedTaskId)
      || local.autoStartBreaks === true
      || durationsDiffer(local.durationsMs, local.defaultDurationsMs);
  }

  function hasRemoteState(remote) {
    return (Array.isArray(remote.history) && remote.history.length > 0)
      || (Array.isArray(remote.tasks) && remote.tasks.length > 0)
      || Boolean(remote.canonicalTimer?.id)
      || Boolean(remote.selectedTaskId)
      || remote.autoStartBreaks === true
      || durationsDiffer(remote.durationsMs, remote.defaultDurationsMs);
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
    const localStateExists = Boolean(input.hasLocalState)
      || (Array.isArray(input.localHistory) && input.localHistory.length > 0);
    const remoteStateExists = Boolean(input.hasRemoteState)
      || (Array.isArray(input.remoteHistory) && input.remoteHistory.length > 0);
    if ((localHistoryCount > 0 && remoteStateExists)
        || (remoteHistoryCount > 0 && localStateExists)) {
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
      strategy: localStateExists ? "merge" : "keep_remote",
      reason: localStateExists ? "local_state_only" : "empty"
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
    const includesAutoStart = Object.prototype.hasOwnProperty.call(operations, "autoStartOperations");
    if (strategy === "keep_remote") {
      const result = { commands: [], taskOperations: [], durationOperations: [], selectedTaskOperations: [] };
      if (includesAutoStart) result.autoStartOperations = [];
      return result;
    }
    const result = {
      commands: sendableTimerCommands(operations.commands, Number.POSITIVE_INFINITY),
      taskOperations: clone(operations.taskOperations || []),
      durationOperations: (operations.durationOperations || []).map(durationRequestOperation),
      selectedTaskOperations: (operations.selectedTaskOperations || []).map(selectedTaskRequestOperation)
    };
    if (includesAutoStart) {
      result.autoStartOperations = (operations.autoStartOperations || []).map(autoStartRequestOperation);
    }
    return result;
  }

  function buildResolutionPayload(input) {
    const operations = resolutionOperations(input.strategy, input);
    const payload = {
      requestId: input.requestId,
      deviceId: input.deviceId,
      expectedRevision: input.expectedRevision,
      strategy: input.strategy,
      commands: operations.commands,
      taskOperations: operations.taskOperations,
      durationOperations: operations.durationOperations,
      selectedTaskOperations: operations.selectedTaskOperations
    };
    if (Object.prototype.hasOwnProperty.call(operations, "autoStartOperations")) {
      payload.autoStartOperations = operations.autoStartOperations;
    }
    return payload;
  }

  function queueIds(input) {
    return {
      commands: (input.commands || []).map((item) => item.id),
      taskOperations: (input.taskOperations || []).map((item) => item.id),
      durationOperations: (input.durationOperations || []).map((item) => item.id),
      autoStartOperations: (input.autoStartOperations || []).map((item) => item.id),
      selectedTaskOperations: (input.selectedTaskOperations || []).map((item) => item.id)
    };
  }

  function createPendingResolution(input) {
    const payload = buildResolutionPayload(input);
    const queued = queueIds(input);
    if (input.strategy !== "keep_remote") {
      queued.commands = payload.commands.map((item) => item.id);
    }
    return {
      userId: input.userId,
      payload,
      queueIds: queued
    };
  }

  function resolutionLimitViolation(payload, limit = RESOLUTION_OPERATION_LIMIT) {
    for (const field of ["commands", "taskOperations", "durationOperations", "autoStartOperations", "selectedTaskOperations"]) {
      const count = Array.isArray(payload?.[field]) ? payload[field].length : 0;
      if (count > limit) return { field, count, limit };
    }
    return null;
  }

  function durationRequestOperation(operation) {
    const occurredAt = Number(operation.hlcWallMs) === 0 && Number(operation.hlcCounter) === 0
      ? LEGACY_EPOCH
      : operation.occurredAt;
    return {
      id: operation.id,
      phase: operation.phase,
      durationMs: operation.durationMs,
      occurredAt,
      hlcWallMs: operation.hlcWallMs,
      hlcCounter: operation.hlcCounter
    };
  }

  function timerRequestCommand(command) {
    const result = {
      id: command.id,
      deviceSequence: command.deviceSequence,
      timerId: command.timerId,
      type: command.type,
      phase: command.phase,
      plannedDurationMs: command.plannedDurationMs,
      occurredAt: command.occurredAt,
      hlcWallMs: command.hlcWallMs,
      hlcCounter: command.hlcCounter,
      observedElapsedMs: command.observedElapsedMs
    };
    if (command.taskId) result.taskId = command.taskId;
    return result;
  }

  function sendableTimerCommands(commands, limit) {
    const result = [];
    const ordered = [...(commands || [])].sort(compareTimerCommands);
    for (const command of ordered) {
      if (command.dependsOnCommandId) break;
      result.push(timerRequestCommand(command));
      if (result.length === limit) break;
    }
    return result;
  }

  function autoStartRequestOperation(operation) {
    return {
      id: operation.id,
      enabled: operation.enabled,
      occurredAt: operation.occurredAt,
      hlcWallMs: operation.hlcWallMs,
      hlcCounter: operation.hlcCounter
    };
  }

  function selectedTaskRequestOperation(operation) {
    return {
      id: operation.id,
      taskId: operation.taskId ?? null,
      occurredAt: operation.occurredAt,
      hlcWallMs: operation.hlcWallMs,
      hlcCounter: operation.hlcCounter
    };
  }

  function compareAutoStartOperations(left, right) {
    return Number(left.hlcWallMs) - Number(right.hlcWallMs)
      || Number(left.hlcCounter) - Number(right.hlcCounter)
      || compareStrings(left.deviceId, right.deviceId)
      || compareStrings(left.id, right.id);
  }

  function compareStrings(left, right) {
    const leftValue = String(left || "");
    const rightValue = String(right || "");
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  }

  function clockComponent(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : -1;
  }

  function compareTimerCommands(left, right) {
    return clockComponent(left.hlcWallMs) - clockComponent(right.hlcWallMs)
      || clockComponent(left.hlcCounter) - clockComponent(right.hlcCounter)
      || compareStrings(left.deviceId, right.deviceId)
      || compareStrings(left.id, right.id);
  }

  function applyAutoStartOperations(baseAutoStartBreaks, operations) {
    const ordered = [...(operations || [])].sort(compareAutoStartOperations);
    return ordered.length ? ordered[ordered.length - 1].enabled === true : baseAutoStartBreaks === true;
  }

  function applySelectedTaskOperations(baseSelectedTaskId, operations) {
    const ordered = [...(operations || [])].sort(compareAutoStartOperations);
    return ordered.length ? ordered[ordered.length - 1].taskId ?? null : baseSelectedTaskId ?? null;
  }

  function applyDurationOperations(baseDurationsMs, operations) {
    const durationsMs = clone(baseDurationsMs || {});
    for (const operation of [...(operations || [])].sort((left, right) =>
      clockComponent(left.hlcWallMs) - clockComponent(right.hlcWallMs)
      || clockComponent(left.hlcCounter) - clockComponent(right.hlcCounter)
      || compareStrings(left.id, right.id)
    )) {
      durationsMs[operation.phase] = operation.durationMs;
    }
    return durationsMs;
  }

  function buildSyncBatch(input, limit = 256) {
    return {
      commands: sendableTimerCommands(input.commands, limit),
      taskOperations: clone((input.taskOperations || []).slice(0, limit)),
      durationOperations: (input.durationOperations || []).slice(0, limit).map(durationRequestOperation),
      autoStartOperations: (input.autoStartOperations || []).slice(0, limit).map(autoStartRequestOperation),
      selectedTaskOperations: (input.selectedTaskOperations || []).slice(0, limit).map(selectedTaskRequestOperation)
    };
  }

  function generatedBreakUpdates(commands, acknowledgements, canonical) {
    const outcomes = new Map((acknowledgements || []).map((item) => [item.commandId, item.outcome]));
    const commandsById = new Map((commands || []).map((item) => [item.id, item]));
    const promoteCommands = [];
    const dropCommandIds = [];
    const dropTimerIds = [];
    const sourceIds = [...new Set((commands || [])
      .map((command) => command.dependsOnCommandId)
      .filter((sourceId) => sourceId && outcomes.has(sourceId)))];
    for (const sourceId of sourceIds) {
      const source = commandsById.get(sourceId);
      const dependents = (commands || []).filter((command) => command.dependsOnCommandId === sourceId);
      const generatedStart = dependents.find((command) =>
        command.type === "start" && command.generatedBreak === true
      );
      const exactHistoryItem = (canonical?.history || []).find((item) =>
        item.timerId === source?.timerId
          && item.commandId === source?.id
          && item.phase === "focus"
          && item.status === "completed"
      );
      const exactTimer = canonical?.canonicalTimer?.id === source?.timerId
        && canonical.canonicalTimer.phase === "focus"
        && canonical.canonicalTimer.status === "completed"
        && canonical.canonicalTimer.lastIntent?.type === "finish"
        && canonical.canonicalTimer.lastIntent?.commandId === source?.id;
      const superseded = canonical?.canonicalTimer
        && ["running", "paused"].includes(canonical.canonicalTimer.status)
        && canonical.canonicalTimer.id !== source?.timerId
        && canonical.canonicalTimer.id !== generatedStart?.timerId;
      const sourceAccepted = source?.type === "finish"
        && ["applied", "ignored"].includes(outcomes.get(sourceId))
        && (exactHistoryItem || exactTimer)
        && !superseded
        && generatedStart;
      if (!sourceAccepted) {
        for (const command of dependents) {
          dropCommandIds.push(command.id);
          if (command.generatedBreak === true) dropTimerIds.push(command.timerId);
        }
        continue;
      }
      const sourceCompletedAt = exactHistoryItem?.completedAt || exactHistoryItem?.endedAt
        || (exactTimer ? canonical.canonicalTimer.anchorAt : null)
        || source.physicalOccurredAt || source.occurredAt;
      const sourceDate = new Date(sourceCompletedAt);
      const sameLocalDay = (timestamp) => {
        const date = new Date(timestamp);
        return Number.isFinite(date.getTime()) && Number.isFinite(sourceDate.getTime())
          && date.getFullYear() === sourceDate.getFullYear()
          && date.getMonth() === sourceDate.getMonth()
          && date.getDate() === sourceDate.getDate();
      };
      const completedFocuses = (canonical?.history || [])
        .filter((item) => item.phase === "focus" && item.status === "completed"
          && sameLocalDay(item.completedAt || item.endedAt))
        .sort((left, right) =>
          compareStrings(left.completedAt || "", right.completedAt || "")
            || compareStrings(left.commandId || "", right.commandId || "")
        );
      const sourceIndex = completedFocuses.findIndex((item) =>
        item.commandId === source.id || item.timerId === source.timerId
      );
      const completedCount = sourceIndex >= 0 ? sourceIndex + 1 : completedFocuses.length + 1;
      const generatedBreakCompleted = dependents.some((command) => command.type === "finish");
      const phase = generatedBreakCompleted
        ? generatedStart.phase
        : completedCount > 0 && completedCount % 4 === 0
          ? "long_break"
          : "short_break";
      const durationMs = generatedBreakCompleted
        ? Number(generatedStart.plannedDurationMs)
        : Number(canonical?.durationsMs?.[phase]);
      for (const command of dependents) {
        const promoted = clone(command);
        delete promoted.dependsOnCommandId;
        delete promoted.generatedBreak;
        promoted.phase = phase;
        if (Number.isSafeInteger(durationMs) && durationMs > 0) {
          promoted.plannedDurationMs = durationMs;
          promoted.observedElapsedMs = Math.min(
            durationMs,
            Math.max(0, Number(promoted.observedElapsedMs) || 0)
          );
        }
        promoteCommands.push(promoted);
      }
    }
    return { promoteCommands, dropCommandIds, dropTimerIds };
  }

  function exactAcknowledgements(payload, field, sentItems, idField) {
    const acknowledgements = payload[field];
    if (sentItems === undefined && acknowledgements == null) {
      return { acknowledgements: [], acknowledgedIds: new Set() };
    }
    if (!Array.isArray(acknowledgements)) {
      throw new Error(`Sync response omitted ${field}.`);
    }
    const expectedItems = sentItems || [];
    const expectedIds = new Set(expectedItems.map((item) => item.id));
    if (expectedIds.size !== expectedItems.length || acknowledgements.length !== expectedIds.size) {
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
      durations: exactAcknowledgements(payload, "durationAcknowledgements", sent.durationOperations, "operationId"),
      autoStart: exactAcknowledgements(payload, "autoStartAcknowledgements", sent.autoStartOperations, "operationId"),
      selectedTask: exactAcknowledgements(payload, "selectedTaskAcknowledgements", sent.selectedTaskOperations, "operationId")
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

  function dateTimeMs(value) {
    const parsed = parseDateTime(value);
    if (!parsed) return null;
    const milliseconds = Number((parsed.fraction || "").padEnd(3, "0").slice(0, 3)) || 0;
    const result = parsed.seconds * 1000 + milliseconds;
    return Number.isSafeInteger(result) ? result : null;
  }

  function serverClockOffset(serverTime, requestAtMs, receivedAtMs, requestSequence) {
    const serverTimeMs = dateTimeMs(serverTime);
    if (serverTimeMs === null || !Number.isSafeInteger(requestAtMs) || !Number.isSafeInteger(receivedAtMs)
      || requestAtMs <= 0 || receivedAtMs < requestAtMs || !validInteger(requestSequence, 1)) {
      throw new Error("Canonical response timing is invalid.");
    }
    const roundTripMs = receivedAtMs - requestAtMs;
    const uncertaintyMs = Math.ceil(roundTripMs / 2);
    if (uncertaintyMs > MAX_CLOCK_UNCERTAINTY_MS) {
      throw new Error("Canonical response clock uncertainty is too high.");
    }
    const sampledAtWallMs = requestAtMs + Math.floor(roundTripMs / 2);
    const sample = {
      offsetMs: serverTimeMs - sampledAtWallMs,
      uncertaintyMs,
      sampledAtWallMs,
      requestSequence,
      receivedAtWallMs: receivedAtMs
    };
    if (!validClockSample(sample)) throw new Error("Canonical response clock sample is invalid.");
    return sample;
  }

  function validClockSample(sample) {
    if (!isObject(sample)
      || !Number.isSafeInteger(sample.offsetMs)
      || !validInteger(sample.uncertaintyMs, 0, MAX_CLOCK_UNCERTAINTY_MS)
      || !validInteger(sample.sampledAtWallMs, 1)
      || !validInteger(sample.requestSequence, 1)
      || !validInteger(sample.receivedAtWallMs, 1)) {
      return false;
    }
    if (sample.receivedAtWallMs < sample.sampledAtWallMs) return false;
    const sampledServerTimeMs = sample.sampledAtWallMs + sample.offsetMs;
    return Number.isSafeInteger(sampledServerTimeMs) && sampledServerTimeMs > 0;
  }

  function trustedNow(localNowMs, clockOffset, minimumWallMs = 0) {
    if (!validInteger(localNowMs, 1)
      || clockOffset != null && !validClockSample(clockOffset)
      || !validInteger(minimumWallMs, 0)) {
      throw new Error("Trusted clock is outside the synchronization range.");
    }
    const candidate = localNowMs + (clockOffset?.offsetMs || 0);
    const result = Math.max(candidate, minimumWallMs);
    if (!Number.isSafeInteger(result) || result <= 0) throw new Error("Trusted clock is outside the synchronization range.");
    return result;
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
      || timer.startedByDeviceId !== undefined && (typeof timer.startedByDeviceId !== "string"
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(timer.startedByDeviceId))
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
    if (typeof payload.autoStartBreaks !== "boolean") {
      throw new Error("Bootstrap response omitted autoStartBreaks.");
    }
    if (!Object.prototype.hasOwnProperty.call(payload, "selectedTaskId")
      || payload.selectedTaskId !== null && (typeof payload.selectedTaskId !== "string" || !payload.selectedTaskId)) {
      throw new Error("Bootstrap response returned an invalid selectedTaskId.");
    }
    if (!validDateTime(payload.serverTime)) throw new Error("Bootstrap response omitted serverTime.");
    if (!validInteger(payload.serverHlcWallMs, 1) || !validInteger(payload.serverHlcCounter, 0)) {
      throw new Error("Bootstrap response returned an invalid server HLC.");
    }
    const serverTimeMs = dateTimeMs(payload.serverTime);
    if (payload.serverHlcWallMs < serverTimeMs || payload.serverHlcWallMs > serverTimeMs + MAX_CLOCK_SKEW_MS) {
      throw new Error("Bootstrap response returned a server HLC inconsistent with serverTime.");
    }
    return acknowledgements;
  }

  async function postJSONWithCsrfRetry(input) {
    const now = input.now || Date.now;
    const fetcher = input.fetcher;
    const send = async (csrfToken) => {
      const requestSequence = await input.nextRequestSequence();
      const requestAtMs = now();
      const response = await fetcher(input.url, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken
        },
        body: input.body
      });
      const receivedAtMs = now();
      input.onTiming?.({ requestAtMs, receivedAtMs, requestSequence });
      return response;
    };
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
    const pendingAutoStartOperations = (local.autoStartOperations || []).filter((item) => !validated.autoStart.acknowledgedIds.has(item.id));
    const pendingSelectedTaskOperations = (local.selectedTaskOperations || []).filter((item) => !validated.selectedTask.acknowledgedIds.has(item.id));
    return canonicalRebase(local, payload, pending, pendingTaskOperations, pendingDurationOperations, pendingAutoStartOperations, pendingSelectedTaskOperations, validated);
  }

  function applyResolutionState(local, payload, pendingResolution) {
    const validated = validateAcknowledgements(payload, pendingResolution.payload);
    const discarded = pendingResolution.queueIds || {};
    const commandIds = new Set(discarded.commands || []);
    const taskOperationIds = new Set(discarded.taskOperations || []);
    const durationOperationIds = new Set(discarded.durationOperations || []);
    const autoStartOperationIds = new Set(discarded.autoStartOperations || []);
    const selectedTaskOperationIds = new Set(discarded.selectedTaskOperations || []);
    const pending = (local.commands || []).filter((item) => !commandIds.has(item.id));
    const pendingTaskOperations = (local.taskOperations || []).filter((item) => !taskOperationIds.has(item.id));
    const pendingDurationOperations = (local.durationOperations || []).filter((item) => !durationOperationIds.has(item.id));
    const pendingAutoStartOperations = (local.autoStartOperations || []).filter((item) => !autoStartOperationIds.has(item.id));
    const pendingSelectedTaskOperations = (local.selectedTaskOperations || []).filter((item) => !selectedTaskOperationIds.has(item.id));
    return canonicalRebase(local, payload, pending, pendingTaskOperations, pendingDurationOperations, pendingAutoStartOperations, pendingSelectedTaskOperations, validated);
  }

  function canonicalRebase(local, payload, pending, pendingTaskOperations, pendingDurationOperations, pendingAutoStartOperations, pendingSelectedTaskOperations, validated) {
    const baseTasks = Array.isArray(payload.tasks) ? clone(payload.tasks) : clone(local.baseTasks || []);
    const baseAutoStartBreaks = Object.prototype.hasOwnProperty.call(payload, "autoStartBreaks")
      ? payload.autoStartBreaks
      : local.baseAutoStartBreaks === true;
    const baseSelectedTaskId = Object.prototype.hasOwnProperty.call(payload, "selectedTaskId")
      ? payload.selectedTaskId
      : local.baseSelectedTaskId ?? null;
    return {
      acknowledgements: validated,
      pending,
      pendingTaskOperations,
      pendingDurationOperations,
      pendingAutoStartOperations,
      pendingSelectedTaskOperations,
      baseTimer: Object.prototype.hasOwnProperty.call(payload, "canonicalTimer") ? clone(payload.canonicalTimer) : clone(local.baseTimer),
      baseHistory: Array.isArray(payload.history) ? clone(payload.history) : clone(local.baseHistory || []),
      baseTasks,
      baseDurationsMs: Object.prototype.hasOwnProperty.call(payload, "durationsMs") ? clone(payload.durationsMs) : clone(local.baseDurationsMs),
      baseAutoStartBreaks,
      baseSelectedTaskId,
      autoStartBreaks: applyAutoStartOperations(baseAutoStartBreaks, pendingAutoStartOperations),
      selectedTaskId: applySelectedTaskOperations(baseSelectedTaskId, pendingSelectedTaskOperations),
      tasks: applyTaskOperations(baseTasks, pendingTaskOperations),
      revision: payload.revision ?? local.revision
    };
  }

  return Object.freeze({
    applyResolutionState,
    applyAutoStartOperations,
    applySelectedTaskOperations,
    applyDurationOperations,
    applyTaskOperations,
    autoStartRequestOperation,
    bootstrapDialogView,
    buildResolutionPayload,
    buildSyncBatch,
    canExposeOwnerState,
    canSubmitResolution,
    canUseCachedOwnerOffline,
    completedHistoryCount,
    compareTimerCommands,
    confirmationFor,
    createPendingResolution,
    decideBootstrap,
    durationRequestOperation,
    generatedBreakUpdates,
    hasLocalState,
    hasRemoteState,
    isResolutionStrategy,
    pendingMatchesUser,
    pendingResolutionCanSubmit,
    postJSONWithCsrfRetry,
    rebaseSyncState,
    requiresBootstrapResolution,
    RESOLUTION_OPERATION_LIMIT,
    resolutionLimitViolation,
    serverClockOffset,
    sendableTimerCommands,
    selectedTaskRequestOperation,
    timerRequestCommand,
    trustedNow,
    validClockSample,
    validDateTime,
    validateCanonicalResponse,
    validateAcknowledgements
  });
});
