(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PomodoroughAppActions = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const COMPLETION_SOUND_INTERVAL_MS = 1_200;
  // Westminster first quarter (G#4 F#4 E4 B3): one bell per repeat tick so the
  // full phrase emerges over successive alerts without overlapping playback.
  const COMPLETION_CHIME_FREQUENCIES = [415.30, 369.99, 329.63, 246.94];
  const TIMER_OWNER_LEASE_MS = 60_000;
  const TIMER_OWNER_HEARTBEAT_MS = 15_000;
  const MIN_DURATION_MS = 60_000;
  const MAX_DURATION_MS = 14_400_000;
  const FINISH_RESULT_KEYS = Object.freeze([
    "commands", "reason", "selectedPhase", "selectedPhaseDurationMs", "transitioned"
  ].sort());
  const FINISH_COMMAND_KEYS = Object.freeze([
    "id", "deviceId", "deviceSequence", "timerId", "type", "phase", "plannedDurationMs",
    "occurredAt", "hlcWallMs", "hlcCounter", "observedElapsedMs"
  ].sort());
  const DEPENDENT_FINISH_COMMAND_KEYS = Object.freeze(
    FINISH_COMMAND_KEYS.concat("dependsOnCommandId").sort()
  );
  const GENERATED_BREAK_COMMAND_KEYS = Object.freeze([
    ...DEPENDENT_FINISH_COMMAND_KEYS, "generatedBreak"
  ].sort());

  function reportFrontendError(error, operation) {
    try {
      const reporter = typeof globalThis !== "undefined"
        ? globalThis.PomodoroughSentryClient?.reportFrontendError
        : null;
      if (typeof reporter === "function") reporter(error, operation);
    } catch { /* error monitoring must never break the app */ }
  }

  function hasExactKeys(value, expectedKeys) {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const actualKeys = Object.keys(value).sort();
    return actualKeys.length === expectedKeys.length
      && actualKeys.every((key, index) => key === expectedKeys[index]);
  }

  function bindActions(owner, names) {
    return Object.fromEntries(names.map((name) => {
      owner[name] = owner[name].bind(owner);
      return [name, owner[name]];
    }));
  }

  const manifest = Object.freeze({
    name: "actions",
    externals: ["host", "syncCore", "syncStorage"],
    requires: [
      "controlsBlocked", "persistDurationOperation", "persistAutoStartOperation",
      "persistSelectedTaskOperation", "persistTaskOperation", "persistCommand", "database",
      "settingsValue", "rebuildOptimisticState", "sharedTaskIdentity", "clone", "trustedNow",
      "elapsedFor", "tr", "phaseLabel", "phaseConfig", "tabId", "render", "renderDurations",
      "renderTaskSelector", "renderTimer", "renderSyncStatus", "showNotice", "scheduleSync",
      "quarantineAccountMismatch", "assertExpectedAccount", "captureAccountContext"
    ],
    provides: [
      "issueDurationOperation", "issueAutoStartOperation", "issueSelectedTaskOperation",
      "issueTaskOperation", "addTask", "deleteTask", "issueCommand", "cancelAndClearTimer",
      "completedFocusCountForDay", "longBreakProgress", "nextBreakPhase", "nextPhaseAfterCompletion",
      "selectedPhaseAfterRejectedFinish", "selectedPhaseAfterCommandAcknowledgements", "finishTimer",
      "completionRetryDelay", "completionAlertTitle", "primeCompletionAlerts", "startCompletionAlert",
      "stopCompletionAlert", "scheduleCompletionRetry", "releaseCompletionRetry",
      "updateTimerCompletion", "activeCompletionAlertTimerId", "completionSoundIntervalMs",
      "completionAlertTimerIDTest", "completionAlertDismissedTimerIDTest",
      "setCompletionQueuedForTest", "completionQueuedForTest", "historyDateMs",
      "heartbeatTimerOwnership", "timerOwnerHeartbeatMs"
    ],
    emits: [],
    listens: []
  });

  class CompletionPlanPolicy {
    constructor(state, use, syncStorage) {
      Object.assign(this, { state, use, syncStorage });
    }

    actions() {
      const actions = bindActions(this, [
        "completedFocusCountForDay", "longBreakProgress", "phaseAfterFocus", "nextPhaseAfterCompletion",
        "selectedPhaseAfterRejectedFinish", "selectedPhaseAfterCommandAcknowledgements", "historyDateMs"
      ]);
      actions.nextBreakPhase = actions.phaseAfterFocus;
      delete actions.phaseAfterFocus;
      return actions;
    }

    historyDateMs(item) {
      const value = item?.completedAt || item?.endedAt || item?.occurredAt || item?.createdAt;
      const parsed = Date.parse(value);
      return Number.isNaN(parsed) ? 0 : parsed;
    }

    completedFocusCountForDay(history = this.state.history, referenceDate = new Date()) {
      const reference = new Date(referenceDate);
      const start = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate()).getTime();
      const end = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate() + 1).getTime();
      return history.filter((item) => {
        const completed = !item.status || item.status === "completed";
        const completedAt = this.historyDateMs(item);
        return completed && item.phase === "focus" && completedAt >= start && completedAt < end;
      }).length;
    }

    longBreakProgress(completedFocusCount) {
      return completedFocusCount > 0 ? ((completedFocusCount - 1) % 4) + 1 : 0;
    }

    finishPlan(timer, history, referenceDate, commandId = "pending-finish") {
      const occurredAt = new Date(referenceDate);
      const referenceMs = Number.isFinite(occurredAt.getTime()) ? occurredAt.getTime() : Date.now();
      return this.syncStorage.finishAppliedPlan({
        commandId, timerId: timer.id || "pending-timer", phase: timer.phase,
        occurredAt: new Date(referenceMs).toISOString(), history,
        autoStartBreaks: this.state.autoStartBreaks === true,
        localDeviceId: this.state.deviceId || "legacy-web", ownsTimer: true, referenceMs
      });
    }

    phaseAfterFocus(history = this.state.history, referenceDate = new Date()) {
      return this.finishPlan({ id: "pending-focus", phase: "focus" }, history, referenceDate).selectedPhase;
    }

    nextPhaseAfterCompletion(timer, history = this.state.history, referenceDate = new Date()) {
      return this.finishPlan(timer, history, referenceDate).selectedPhase;
    }

    selectedPhaseAfterRejectedFinish(selectedPhase, finishCommand, history = this.state.history) {
      if (finishCommand?.type !== "finish" || !this.use.phaseConfig()[finishCommand.phase]) return selectedPhase;
      const plan = this.finishPlan(
        { id: finishCommand.timerId, phase: finishCommand.phase }, history,
        finishCommand.occurredAt, finishCommand.id
      );
      return selectedPhase === plan.selectedPhase ? finishCommand.phase : selectedPhase;
    }

    selectedPhaseAfterCommandAcknowledgements(selectedPhase, commands, acknowledgements, history = this.state.history) {
      const rejectedIDs = new Set(acknowledgements
        .filter((item) => String(item.outcome || "").toLowerCase() === "rejected")
        .map((item) => item.commandId));
      const rejectedFinishes = commands
        .filter((command) => command.type === "finish" && rejectedIDs.has(command.id))
        .sort((left, right) => Number(right.deviceSequence || 0) - Number(left.deviceSequence || 0));
      return rejectedFinishes.reduce(
        (phase, command) => this.selectedPhaseAfterRejectedFinish(phase, command, history), selectedPhase
      );
    }
  }

  class ActionMutations {
    constructor(state, external, use, timerLifecycle) {
      Object.assign(this, { state, use, timerLifecycle }, external);
    }

    actions() {
      return bindActions(this, [
        "issueDurationOperation", "issueAutoStartOperation", "issueSelectedTaskOperation",
        "issueTaskOperation", "addTask", "deleteTask", "issueCommand", "cancelAndClearTimer"
      ]);
    }

    async issueDurationOperation(phase, durationMs) {
      if (this.use.controlsBlocked() || this.state.actionLocked
        || this.state.durationsMs[phase] === durationMs) return false;
      this.state.actionLocked = true;
      try {
        const persisted = await this.use.persistDurationOperation(phase, durationMs);
        this.state.pendingDurationOperations = persisted.pendingDurationOperations;
        this.use.rebuildOptimisticState();
        this.use.render();
        this.use.scheduleSync(0);
        return true;
      } catch (error) {
        reportFrontendError(error, "actions.duration.save-failed");
        this.use.showNotice(error.message || this.use.tr(
          "notice.durationSaveFailed", {}, "Duration change could not be saved."
        ));
        return false;
      } finally {
        this.state.actionLocked = false;
      }
    }

    async waitForUnlockedAction() {
      while (this.state.actionLocked) await new Promise((resolve) => this.host.setTimeout(resolve, 0));
    }

    async issueAutoStartOperation(enabled, expectedUserId = this.syncCore.accountOwnerId(this.state.user) || this.state.localOwnerId || null) {
      if (this.use.controlsBlocked()) return false;
      await this.waitForUnlockedAction();
      if (this.use.controlsBlocked() || this.state.autoStartBreaks === enabled) {
        this.use.renderDurations();
        return false;
      }
      this.state.actionLocked = true;
      try {
        const operation = await this.use.persistAutoStartOperation(enabled, expectedUserId);
        this.state.pendingAutoStartOperations.push(operation);
        this.use.rebuildOptimisticState();
        this.use.renderDurations();
        this.use.renderSyncStatus();
        this.use.scheduleSync(0);
        return true;
      } catch (error) {
        reportFrontendError(error, "actions.auto-start.save-failed");
        this.use.showNotice(error.message || this.use.tr(
          "notice.autoStartSaveFailed", {}, "Auto-start preference could not be saved."
        ));
        this.use.renderDurations();
        return false;
      } finally {
        this.state.actionLocked = false;
      }
    }

    retargetRunningFocusTimer(taskId) {
      const timer = this.state.timer;
      if (!timer?.id || !["running", "paused"].includes(timer.status) || timer.phase !== "focus") return;
      if (taskId !== null && !this.state.tasks.some((task) => task.id === taskId)) return;
      // Local-only retarget marker: display follows the newly picked task at
      // once, even post-ack. Remote selected-task syncs never write here, so
      // they cannot hijack the active timer.
      if (!this.state.retargetedTaskByTimerId || typeof this.state.retargetedTaskByTimerId !== "object") {
        this.state.retargetedTaskByTimerId = {};
      }
      this.state.retargetedTaskByTimerId[timer.id] = taskId;
      // Rewrite the still-pending start command so eventual history follows
      // the newly selected task with no duplicate identity.
      for (const command of this.state.pending) {
        if (command?.timerId === timer.id && command.type === "start") {
          if (taskId === null) delete command.taskId;
          else command.taskId = taskId;
        }
      }
    }

    async issueSelectedTaskOperation(taskId, expectedUserId = this.syncCore.accountOwnerId(this.state.user) || this.state.localOwnerId || null) {
      if (this.use.controlsBlocked()) return false;
      await this.waitForUnlockedAction();
      if (this.use.controlsBlocked() || this.state.selectedTaskId === taskId) {
        this.use.renderTaskSelector();
        return false;
      }
      this.state.actionLocked = true;
      try {
        const operation = await this.use.persistSelectedTaskOperation(taskId, expectedUserId);
        this.state.pendingSelectedTaskOperations.push(operation);
        this.retargetRunningFocusTimer(taskId);
        this.use.rebuildOptimisticState();
        this.use.renderTaskSelector();
        this.use.renderSyncStatus();
        this.use.scheduleSync(0);
        return true;
      } catch (error) {
        reportFrontendError(error, "actions.selected-task.save-failed");
        this.use.showNotice(error.message || this.use.tr(
          "notice.taskChoiceSaveFailed", {}, "Task choice could not be saved."
        ));
        this.use.renderTaskSelector();
        return false;
      } finally {
        this.state.actionLocked = false;
      }
    }

    async issueTaskOperation(type, task, expectedUserId = this.syncCore.accountOwnerId(this.state.user) || this.state.localOwnerId || null) {
      if (this.use.controlsBlocked() || this.state.actionLocked) return false;
      this.state.actionLocked = true;
      try {
        const operation = await this.use.persistTaskOperation(type, task, expectedUserId);
        this.state.pendingTaskOperations.push(operation);
        this.use.rebuildOptimisticState();
        this.use.render();
        this.use.scheduleSync(0);
        return true;
      } catch (error) {
        reportFrontendError(error, "actions.task.save-failed");
        this.use.showNotice(error.message || this.use.tr(
          "notice.taskSaveFailed", {}, "Task change could not be saved."
        ));
        return false;
      } finally {
        this.state.actionLocked = false;
      }
    }

    async addTask(title) {
      const expectedUserId = this.syncCore.accountOwnerId(this.state.user) || this.state.localOwnerId || null;
      let identity;
      try {
        identity = await this.use.sharedTaskIdentity(String(title || ""));
      } catch (error) {
        const message = String(error?.message || "");
        if (message.includes("printable") || message.includes("must not be empty")) {
          throw new Error(this.use.tr("notice.taskPrintable", {}, "Enter a printable task name."));
        }
        if (message.includes("512") || message.includes("too long")) {
          throw new Error(this.use.tr("notice.taskTooLong", {}, "Task name is too long."));
        }
        this.host.console.warn("Pomodorough task identity failed:", error);
        reportFrontendError(error, "actions.task.identity-failed");
        throw error;
      }
      const { id, title: normalized } = identity;
      const existing = this.state.tasks.find((task) => task.id === id);
      if (existing) {
        const selected = await this.issueSelectedTaskOperation(existing.id, expectedUserId);
        if (selected) this.use.showNotice(this.use.tr(
          "notice.taskExists", {}, "Task already exists and is now selected."
        ));
        return true;
      }
      const saved = await this.issueTaskOperation("upsert", { id, title: normalized }, expectedUserId);
      if (saved) await this.issueSelectedTaskOperation(id, expectedUserId);
      return saved;
    }

    async deleteTask(task) {
      return this.issueTaskOperation("delete", task);
    }

    async issueCommand(type, options = {}) {
      if (this.use.controlsBlocked() || this.state.actionLocked) return false;
      this.state.actionLocked = true;
      try {
        const command = await this.use.persistCommand(type, options);
        this.state.pending.push(command);
        this.use.rebuildOptimisticState();
        this.use.render();
        this.use.scheduleSync(0);
        return true;
      } catch (error) {
        reportFrontendError(error, "actions.timer.save-failed");
        this.use.showNotice(error.message || this.use.tr(
          "notice.timerSaveFailed", {}, "Timer action could not be saved."
        ));
        return false;
      } finally {
        this.state.actionLocked = false;
      }
    }

    async cancelAndClearTimer() {
      const context = this.use.captureAccountContext();
      const expectedUserId = this.syncCore.accountOwnerId(this.state.user) || this.state.localOwnerId || null;
      if (this.use.controlsBlocked() || this.state.actionLocked) return false;
      const timer = this.use.clone(this.state.timer);
      const now = this.use.trustedNow();
      this.state.actionLocked = true;
      try {
        const outcome = await this.syncStorage.cancelAndClearTimer(this.use.database(), {
          ...context, expectedUserId,
          timerId: timer.id, phase: timer.phase, deviceId: this.state.deviceId, nowMs: now,
          observedElapsedMs: Math.round(this.use.elapsedFor(timer, now)), withUuidV7: true
        });
        context.assertCurrent();
        this.use.assertExpectedAccount(expectedUserId);
        if (!outcome.transitioned) return false;
        this.state.pending.push(...outcome.commands);
        this.timerLifecycle.recordLastCommand(outcome.commands);
        this.use.rebuildOptimisticState();
        this.use.render();
        this.use.scheduleSync(0);
        return true;
      } catch (error) {
        if (error.name === "AccountOwnershipError") this.use.quarantineAccountMismatch();
        else reportFrontendError(error, "actions.timer.clear-failed");
        this.use.showNotice(error.message || this.use.tr(
          "notice.timerSaveFailed", {}, "Timer action could not be saved."
        ));
        return false;
      } finally {
        this.state.actionLocked = false;
      }
    }
  }

  class TimerLifecycle {
    constructor(state, external, use) {
      Object.assign(this, { state, use }, external);
      this.completionQueuedFor = null;
      this.completionRetryTimer = null;
      this.completionAlertTimer = null;
      this.completionAlertContext = null;
      this.completionAlertNotification = null;
      this.completionAlertTimerID = null;
      this.completionAlertDismissedTimerID = null;
      this.completionAlertSnapshot = null;
      this.playCompletionTone = this.playCompletionTone.bind(this);
    }

    actions() {
      return bindActions(this, [
        "finishTimer", "completionRetryDelay", "completionAlertTitle", "primeCompletionAlerts",
        "startCompletionAlert", "stopCompletionAlert", "scheduleCompletionRetry",
        "releaseCompletionRetry", "updateTimerCompletion", "activeCompletionAlertTimerId",
        "completionSoundIntervalMs", "completionAlertTimerIDTest", "completionAlertDismissedTimerIDTest",
        "setCompletionQueuedForTest", "completionQueuedForTest", "heartbeatTimerOwnership",
        "timerOwnerHeartbeatMs"
      ]);
    }

    finishTimerRequest(timer, automatic, localNow, now, expectedUserId) {
      return {
        ...this.use.captureAccountContext(), expectedUserId,
        timerId: timer.id, phase: timer.phase, deviceId: this.state.deviceId, tabId: this.use.tabId(),
        requestedTimer: timer,
        leaseMs: TIMER_OWNER_LEASE_MS, manual: !automatic,
        requireOwner: automatic && timer.phase === "focus", nowMs: now, localNowMs: localNow,
        observedElapsedMs: Math.round(this.use.elapsedFor(timer, now)), withUuidV7: true,
        autoStartBreaks: this.state.autoStartBreaks === true,
        breakTimerId: this.host.crypto.randomUUID(), settings: this.use.settingsValue()
      };
    }

    recordLastCommand(commands) {
      const last = commands[commands.length - 1];
      this.state.deviceSequence = last.deviceSequence;
      this.state.hlcWallMs = last.hlcWallMs;
      this.state.hlcCounter = last.hlcCounter;
    }

    validFinishedCommand(command, expectedKeys) {
      const occurredAtMs = typeof command?.occurredAt === "string" ? Date.parse(command.occurredAt) : NaN;
      return hasExactKeys(command, expectedKeys)
        && typeof command.id === "string" && command.id.length > 0
        && typeof command.deviceId === "string" && command.deviceId.length > 0
        && typeof command.timerId === "string" && command.timerId.length > 0
        && ["finish", "start"].includes(command.type)
        && Object.hasOwn(this.use.phaseConfig(), command.phase)
        && Number.isSafeInteger(command.plannedDurationMs)
        && command.plannedDurationMs >= MIN_DURATION_MS && command.plannedDurationMs <= MAX_DURATION_MS
        && Number.isSafeInteger(command.deviceSequence) && command.deviceSequence > 0
        && Number.isSafeInteger(command.hlcWallMs) && command.hlcWallMs >= 0
        && Number.isSafeInteger(command.hlcCounter) && command.hlcCounter >= 0
        && Number.isFinite(occurredAtMs) && new Date(occurredAtMs).toISOString() === command.occurredAt
        && occurredAtMs === command.hlcWallMs
        && Number.isSafeInteger(command.observedElapsedMs) && command.observedElapsedMs >= 0
        && command.observedElapsedMs <= command.plannedDurationMs;
    }

    validatedFinishedOutcome(outcome, request) {
      const commands = outcome?.commands;
      const first = commands?.[0];
      const generated = commands?.[1];
      const finishKeys = request.requestedTimer.dependsOnCommandId
        ? DEPENDENT_FINISH_COMMAND_KEYS : FINISH_COMMAND_KEYS;
      const validFirst = this.validFinishedCommand(first, finishKeys)
        && first.type === "finish" && first.timerId === request.requestedTimer.id
        && first.phase === request.requestedTimer.phase
        && first.plannedDurationMs === request.requestedTimer.plannedDurationMs
        && first.observedElapsedMs === Math.min(
          first.plannedDurationMs, Math.max(0, Number(request.observedElapsedMs) || 0)
        )
        && first.dependsOnCommandId === (request.requestedTimer.dependsOnCommandId || undefined)
        && first.hlcWallMs >= request.nowMs
        && first.deviceId === request.deviceId;
      const validGenerated = commands?.length === 1
        || this.validFinishedCommand(generated, GENERATED_BREAK_COMMAND_KEYS)
        && generated.type === "start" && generated.generatedBreak === true
        && generated.dependsOnCommandId === first?.id && generated.deviceId === request.deviceId
        && generated.timerId === request.breakTimerId && generated.phase === outcome?.selectedPhase
        && generated.plannedDurationMs === outcome?.selectedPhaseDurationMs
        && generated.deviceSequence === first?.deviceSequence + 1
        && generated.hlcWallMs === first?.hlcWallMs && generated.hlcCounter === first?.hlcCounter + 1
        && generated.observedElapsedMs === 0;
      if (!hasExactKeys(outcome, FINISH_RESULT_KEYS)
        || outcome.transitioned !== true || outcome.reason !== ""
        || !Array.isArray(commands) || ![1, 2].includes(commands.length)
        || !Number.isSafeInteger(outcome.selectedPhaseDurationMs)
        || outcome.selectedPhaseDurationMs < MIN_DURATION_MS
        || outcome.selectedPhaseDurationMs > MAX_DURATION_MS
        || !validFirst || !validGenerated) {
        throw new Error("Timer completion returned an invalid command batch.");
      }
      if (!Object.hasOwn(this.use.phaseConfig(), outcome.selectedPhase)) {
        throw new Error("Timer completion returned an invalid selected phase.");
      }
      return { commands, selectedPhase: outcome.selectedPhase };
    }

    acceptFinishedTimer(timer, commands) {
      this.host.clearTimeout(this.completionRetryTimer);
      this.completionRetryTimer = null;
      this.state.pending.push(...commands);
      this.recordLastCommand(commands);
      this.startCompletionAlert(timer);
      this.use.rebuildOptimisticState();
      this.use.render();
      this.use.scheduleSync(0);
    }

    async finishTimer(automatic = false, expectedUserId = this.syncCore.accountOwnerId(this.state.user) || this.state.localOwnerId || null) {
      if (this.use.controlsBlocked() || this.state.actionLocked) return false;
      const timer = this.use.clone(this.state.timer);
      const localNow = Date.now();
      this.state.actionLocked = true;
      try {
        const now = this.use.trustedNow(localNow);
        const request = this.finishTimerRequest(timer, automatic, localNow, now, expectedUserId);
        const outcome = await this.syncStorage.finishTimer(this.use.database(), request);
        request.assertCurrent();
        this.use.assertExpectedAccount(expectedUserId);
        if (!outcome.transitioned) {
          if (automatic && outcome.reason === "not_owner") {
            this.scheduleCompletionRetry(timer.id, outcome);
            return true;
          }
          return automatic;
        }
        const validated = this.validatedFinishedOutcome(outcome, request);
        this.state.selectedPhase = validated.selectedPhase;
        this.acceptFinishedTimer(timer, validated.commands);
        return true;
      } catch (error) {
        if (error.name === "AccountOwnershipError") this.use.quarantineAccountMismatch();
        else {
          this.host.console.warn("Pomodorough timer finish failed:", error);
          reportFrontendError(error, "actions.timer.finish-failed");
        }
        this.use.showNotice(error.message || this.use.tr(
          "notice.timerSaveFailed", {}, "Timer action could not be saved."
        ));
        return false;
      } finally {
        this.state.actionLocked = false;
      }
    }

    completionRetryDelay(outcome, nowMs = Date.now()) {
      if (outcome?.reason !== "not_owner") return null;
      const retryAtMs = Number.isFinite(Number(outcome.retryAtMs))
        ? Number(outcome.retryAtMs) : nowMs + TIMER_OWNER_HEARTBEAT_MS;
      return Math.max(250, retryAtMs - nowMs + 1);
    }

    completionAlertTitle(timer) {
      const phase = this.use.phaseConfig()[timer?.phase] ? timer.phase : "focus";
      return this.use.tr(
        "timer.complete", { phase: this.use.phaseLabel(phase) }, `${this.use.phaseLabel(phase)} complete`
      );
    }

    showCompletionNotification() {
      const NotificationType = this.host.Notification;
      if (!this.completionAlertSnapshot || this.completionAlertNotification
        || NotificationType?.permission !== "granted") return false;
      try {
        this.completionAlertNotification = new NotificationType(this.completionAlertTitle(this.completionAlertSnapshot), {
          body: this.use.tr("timer.notification.body", {}, "Your next Pomodorough interval is ready."),
          tag: `pomodorough-${this.completionAlertSnapshot.id}`, requireInteraction: true
        });
        this.completionAlertNotification.onclick = this.stopCompletionAlert;
        return true;
      } catch {
        this.completionAlertNotification = null;
        return false;
      }
    }

    async primeCompletionAlerts() {
      const AudioContextType = this.host.AudioContext || this.host.webkitAudioContext;
      if (!this.completionAlertContext && AudioContextType) {
        try { this.completionAlertContext = new AudioContextType(); } catch { this.completionAlertContext = null; }
      }
      if (this.completionAlertContext?.state === "suspended") {
        try { await this.completionAlertContext.resume(); } catch {
          // Notification still provides an alert when browser audio is unavailable.
        }
      }
      const NotificationType = this.host.Notification;
      if (NotificationType?.permission === "default") {
        try { await NotificationType.requestPermission(); } catch {
          // Audio remains available when notification permission is unavailable.
        }
      }
      this.showCompletionNotification();
      if (this.completionAlertTimerID && this.completionAlertTimer === null && this.playCompletionTone()) {
        this.completionAlertTimer = this.host.setInterval(this.playCompletionTone, COMPLETION_SOUND_INTERVAL_MS);
      }
    }

    playCompletionTone() {
      if (!this.completionAlertContext || this.completionAlertContext.state !== "running") return false;
      const chimeIndex = this.completionChimeIndex || 0;
      this.completionChimeIndex = (chimeIndex + 1) % COMPLETION_CHIME_FREQUENCIES.length;
      const now = this.completionAlertContext.currentTime;
      const oscillator = this.completionAlertContext.createOscillator();
      const gain = this.completionAlertContext.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = COMPLETION_CHIME_FREQUENCIES[chimeIndex];
      if (typeof gain.gain.setTargetAtTime === "function") {
        gain.gain.setValueAtTime(0, now);
        gain.gain.setTargetAtTime(0.12, now, 0.03);
        gain.gain.setTargetAtTime(0, now + 0.7, 0.09);
      } else {
        gain.gain.value = 0.12;
      }
      oscillator.connect(gain);
      gain.connect(this.completionAlertContext.destination);
      oscillator.start();
      oscillator.stop(now + 1.0);
      return true;
    }

    startCompletionAlert(timer) {
      if (!timer?.id || this.completionAlertTimerID === timer.id
        || this.completionAlertDismissedTimerID === timer.id) return false;
      this.stopCompletionAlert();
      this.completionAlertDismissedTimerID = null;
      this.completionAlertTimerID = timer.id;
      this.completionAlertSnapshot = { id: timer.id, phase: timer.phase };
      this.showCompletionNotification();
      if (this.playCompletionTone()) {
        this.completionAlertTimer = this.host.setInterval(this.playCompletionTone, COMPLETION_SOUND_INTERVAL_MS);
      }
      return true;
    }

    stopCompletionAlert() {
      if (this.completionAlertTimer !== null) this.host.clearInterval(this.completionAlertTimer);
      this.completionAlertTimer = null;
      this.completionAlertNotification?.close();
      this.completionAlertNotification = null;
      if (this.completionAlertTimerID) this.completionAlertDismissedTimerID = this.completionAlertTimerID;
      this.completionAlertTimerID = null;
      this.completionAlertSnapshot = null;
    }

    scheduleCompletionRetry(timerId, outcome) {
      const expectedUserId = this.syncCore.accountOwnerId(this.state.user) || this.state.localOwnerId || null;
      const delay = this.completionRetryDelay(outcome);
      if (delay === null) return;
      this.host.clearTimeout(this.completionRetryTimer);
      this.completionRetryTimer = this.host.setTimeout(() => {
        this.completionRetryTimer = null;
        if (!this.releaseCompletionRetry(timerId, expectedUserId)) return;
        this.use.renderTimer();
      }, delay);
    }

    releaseCompletionRetry(timerId, expectedUserId = this.syncCore.accountOwnerId(this.state.user) || this.state.localOwnerId || null) {
      if ((this.syncCore.accountOwnerId(this.state.user) || this.state.localOwnerId || null) !== expectedUserId) return false;
      if (this.state.timer.id !== timerId || this.state.timer.status !== "running") return false;
      this.completionQueuedFor = null;
      return true;
    }

    updateTimerCompletion(timer, status, remaining, blocked) {
      if (!blocked && status === "running" && remaining <= 0 && this.completionQueuedFor !== timer.id) {
        this.completionQueuedFor = timer.id;
        this.finishTimer(true).then((saved) => { if (!saved) this.completionQueuedFor = null; });
      } else if (status !== "running") {
        this.host.clearTimeout(this.completionRetryTimer);
        this.completionRetryTimer = null;
        this.completionQueuedFor = null;
      }
      if (status === "completed") this.startCompletionAlert(timer);
    }

    heartbeatTimerOwnership() {
      const database = this.use.database();
      if (!database || !this.state.ready || !this.state.deviceId || !this.state.timer.id
        || !["running", "paused"].includes(this.state.timer.status)) return;
      this.syncStorage.renewTimerOwnership(database, {
        ...this.use.captureAccountContext(),
        expectedUserId: this.syncCore.accountOwnerId(this.state.user) || this.state.localOwnerId || null,
        timerId: this.state.timer.id, deviceId: this.state.deviceId, tabId: this.use.tabId(),
        nowMs: Date.now(), leaseMs: TIMER_OWNER_LEASE_MS
      }).catch((error) => {
        if (error.name === "AccountOwnershipError") this.use.quarantineAccountMismatch();
        else {
          this.host.console.warn("Timer ownership renewal failed:", error);
          reportFrontendError(error, "actions.timer-ownership.renewal-failed");
        }
      });
    }

    activeCompletionAlertTimerId() { return this.completionAlertTimerID; }
    completionSoundIntervalMs() { return COMPLETION_SOUND_INTERVAL_MS; }
    completionAlertTimerIDTest() { return this.completionAlertTimerID; }
    completionAlertDismissedTimerIDTest() { return this.completionAlertDismissedTimerID; }
    setCompletionQueuedForTest(value) { this.completionQueuedFor = value; }
    completionQueuedForTest() { return this.completionQueuedFor; }
    timerOwnerHeartbeatMs() { return TIMER_OWNER_HEARTBEAT_MS; }
  }

  function create({ state, external, use }) {
    const phasePolicy = new CompletionPlanPolicy(state, use, external.syncStorage);
    const timerLifecycle = new TimerLifecycle(state, external, use);
    const mutations = new ActionMutations(state, external, use, timerLifecycle);
    return { ...phasePolicy.actions(), ...timerLifecycle.actions(), ...mutations.actions() };
  }

  return Object.freeze({ manifest, create });
});
