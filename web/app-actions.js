(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PomodoroughAppActions = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const accountOperation = typeof module === "object" && module.exports
    ? require("./account-operation.js") : globalThis.PomodoroughAccountOperation;

  const COMPLETION_SOUND_INTERVAL_MS = 1_200;
  // Westminster first quarter (G#4 F#4 E4 B3): one bell per repeat tick so the
  // full phrase emerges over successive alerts without overlapping playback.
  const COMPLETION_CHIME_FREQUENCIES = [415.30, 369.99, 329.63, 246.94];
  function timingMs(name, fallback) {
    try {
      const runtime = typeof globalThis !== "undefined" ? globalThis.PomodoroughAppRuntime : null;
      const value = runtime?.TIMING_MS?.[name] ?? runtime?.timingMs?.(name, fallback);
      if (Number.isFinite(value)) return value;
    } catch { /* timing config never blocks actions */ }
    return fallback;
  }

  const TIMER_OWNER_LEASE_MS = timingMs("timerOwnerLease", 60_000);
  const TIMER_OWNER_HEARTBEAT_MS = timingMs("timerOwnerHeartbeat", 15_000);

  function reportFrontendError(error, operation) {
    try {
      const reporter = typeof globalThis !== "undefined"
        ? globalThis.PomodoroughSentryClient?.reportFrontendError
        : null;
      if (typeof reporter === "function") reporter(error, operation);
    } catch { /* error monitoring must never break the app */ }
  }

  function bindActions(owner, names) {
    return Object.fromEntries(names.map((name) => {
      owner[name] = owner[name].bind(owner);
      return [name, owner[name]];
    }));
  }

  function reportMutationFailure(error, operation) {
    switch (operation) {
      case "actions.duration.save-failed": reportFrontendError(error, "actions.duration.save-failed"); break;
      case "actions.auto-start.save-failed": reportFrontendError(error, "actions.auto-start.save-failed"); break;
      case "actions.selected-task.save-failed": reportFrontendError(error, "actions.selected-task.save-failed"); break;
      case "actions.selected-task.retarget-missing": reportFrontendError(error, "actions.selected-task.retarget-missing"); break;
      case "actions.task.save-failed": reportFrontendError(error, "actions.task.save-failed"); break;
      case "actions.timer.clear-failed": reportFrontendError(error, "actions.timer.clear-failed"); break;
      case "view.phase.save-failed": reportFrontendError(error, "view.phase.save-failed"); break;
      default: reportFrontendError(error, "actions.timer.save-failed");
    }
  }

  function mutationFailureNotice(use, operation) {
    switch (operation) {
      case "actions.duration.save-failed": return use.tr("notice.durationSaveFailed", {}, "Duration change could not be saved.");
      case "actions.auto-start.save-failed": return use.tr("notice.autoStartSaveFailed", {}, "Auto-start preference could not be saved.");
      case "actions.selected-task.save-failed": return use.tr("notice.taskChoiceSaveFailed", {}, "Task choice could not be saved.");
      case "actions.task.save-failed": return use.tr("notice.taskSaveFailed", {}, "Task change could not be saved.");
      case "view.phase.save-failed": return use.tr("notice.phaseSaveFailed", {}, "Phase choice could not be saved.");
      default: return use.tr("notice.timerSaveFailed", {}, "Timer action could not be saved.");
    }
  }

  const manifest = Object.freeze({
    name: "actions",
    externals: ["host", "syncCore", "syncStorage"],
    requires: [
      "controlsBlocked", "persistDurationOperation", "persistAutoStartOperation",
      "persistSelectedTaskOperation", "persistTaskOperation", "persistCommand",
      "persistRetargetOperation", "persistWorkspaceIntent", "persistWorkspaceCompletion", "database", "getWorkspaceReadModel",
      "settingsValue", "rebuildOptimisticState", "sharedTaskIdentity", "clone", "trustedNow",
      "elapsedFor", "tr", "phaseLabel", "phaseConfig", "tabId", "render", "renderDurations",
      "renderTaskSelector", "renderTimer", "renderSyncStatus", "showNotice", "scheduleSync",
      "quarantineAccountMismatch", "assertExpectedAccount", "captureAccountContext", "captureDatabaseContext",
      "reloadPersistedState"
    ],
    provides: [
      "issueDurationOperation", "issueAutoStartOperation", "issueSelectedTaskOperation",
      "issueTaskOperation", "addTask", "deleteTask", "issueCommand", "cancelAndClearTimer", "issuePhaseSelection", "executeWorkspaceEffects",
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
      return this.use.getWorkspaceReadModel().cadence.completedFocusToday;
    }

    longBreakProgress(completedFocusCount) {
      return this.use.getWorkspaceReadModel().cadence.longBreakProgress;
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
      return this.selectedPhaseAfterCommandAcknowledgements(selectedPhase, [finishCommand],
        [{ commandId: finishCommand.id, outcome: "rejected" }], history);
    }

    selectedPhaseAfterCommandAcknowledgements(selectedPhase, commands, acknowledgements, history = this.state.history) {
      return this.syncStorage.completionSelection({ selectedPhase, commands, acknowledgements, history }).selection.phase;
    }
  }

  class ActionMutations {
    constructor(state, external, use) {
      Object.assign(this, { state, use }, external);
    }

    actions() {
      return bindActions(this, [
        "issueDurationOperation", "issueAutoStartOperation", "issueSelectedTaskOperation",
        "issueTaskOperation", "addTask", "deleteTask", "issueCommand", "cancelAndClearTimer", "issuePhaseSelection", "executeWorkspaceEffects"
      ]);
    }

    async issueDurationOperation(phase, durationMs) {
      return this.issueWorkspaceIntent({ kind: "setDuration", phase, minutes: durationMs / 60000 },
        { preference: true }, "actions.duration.save-failed");
    }

    async waitForUnlockedAction() {
      while (this.state.actionLocked) await new Promise((resolve) => this.host.setTimeout(resolve, timingMs("defer", 0)));
    }

    async issueAutoStartOperation(enabled, expectedUserId = this.syncCore.accountOwnerId(this.state.user) || this.state.localOwnerId || null) {
      const context = this.use.captureAccountContext();
      await this.waitForUnlockedAction();
      return this.issueWorkspaceIntent({ kind: "setAutoStart", enabled }, { preference: true, context, ownerId: expectedUserId }, "actions.auto-start.save-failed");
    }

    async issueSelectedTaskOperation(taskId, expectedUserId = this.syncCore.accountOwnerId(this.state.user) || this.state.localOwnerId || null) {
      const context = this.use.captureAccountContext();
      await this.waitForUnlockedAction();
      return this.issueWorkspaceIntent({ kind: "selectTask", taskId }, { preference: true, context, ownerId: expectedUserId }, "actions.selected-task.save-failed");
    }

    async issueTaskOperation(type, task, expectedUserId = this.syncCore.accountOwnerId(this.state.user) || this.state.localOwnerId || null) {
      const intent = type === "upsert" ? { kind: "upsertTask", title: task.title } : { kind: "deleteTask", taskId: task.id };
      return this.issueWorkspaceIntent(intent, { preference: true, ownerId: expectedUserId }, "actions.task.save-failed");
    }

    async addTask(title) {
      const context = this.use.captureAccountContext();
      try { await this.use.sharedTaskIdentity(String(title || "")); }
      catch (error) {
        const message = String(error?.message || "");
        if (/printable|must not be empty|title is empty/.test(message)) throw new Error(this.use.tr("notice.taskPrintable", {}, "Enter a printable task name."));
        if (/512|too long/.test(message)) throw new Error(this.use.tr("notice.taskTooLong", {}, "Task name is too long."));
        this.host.console.warn("Pomodorough task identity failed:", error);
        reportFrontendError(error, "actions.task.identity-failed");
        throw error;
      }
      return this.issueWorkspaceIntent({ kind: "addAndSelectTask", title: String(title || "") },
        { preference: true, context }, "actions.task.save-failed");
    }

    async deleteTask(task) {
      return this.issueTaskOperation("delete", task);
    }

    async issueCommand(type, options = {}) {
      return this.issueWorkspaceIntent({ kind: type }, {}, "actions.timer.save-failed");
    }

    async issuePhaseSelection(phase) {
      return this.issueWorkspaceIntent({ kind: "selectPhase", phase }, {}, "view.phase.save-failed");
    }

    async issueWorkspaceIntent(intent, options, operation) {
      if (this.use.controlsBlocked() || this.state.actionLocked) return false;
      if (!options.preference && this.state.workspaceBlocked) {
        this.use.showNotice(this.state.conflict);
        return false;
      }
      const context = options.context || this.use.captureAccountContext();
      this.state.actionLocked = true;
      try {
        const plan = await this.use.persistWorkspaceIntent(intent, { ...options, context });
        context.assertCurrent();
        if (plan.outcome === "noop") {
          if (intent.kind === "selectTask" && await this.selectedTaskRetargetMissing(intent.taskId, context)) {
            const error = new Error(this.use.tr("notice.taskRetargetMissing", {},
              "Focus timer still shows the previous task. Choose another task, then choose this one again."));
            reportMutationFailure(error, "actions.selected-task.retarget-missing");
            this.use.showNotice(error.message);
            return false;
          }
          return intent.kind === "addAndSelectTask";
        }
        this.use.render();
        context.assertCurrent();
        if (intent.kind === "addAndSelectTask" && plan.operations.taskOperations.length === 0) {
          this.use.showNotice(this.use.tr("notice.taskExists", {}, "Task already exists and is now selected."));
        }
        const outcomes = plan.commandOutcomes || Object.values(plan.groupOutcomes || {}).flat();
        if (outcomes.some((item) => item.outcome === "queued")) {
          this.use.showNotice(this.use.tr("notice.coreQueued", {}, "Change saved. Display waits for synchronization of retained work."));
        }
        this.executeWorkspaceEffects(plan.effectsAfterCommit, context);
        return true;
      } catch (error) {
        if (error.name === "AccountOwnershipError") { reportMutationFailure(error, operation); return false; }
        reportMutationFailure(error, operation);
        this.use.showNotice(error.message || mutationFailureNotice(this.use, operation));
        return false;
      } finally {
        this.state.actionLocked = false;
      }
    }

    async cancelAndClearTimer() {
      return this.issueWorkspaceIntent({ kind: "cancelAndClear" }, { requestedTimer: this.use.clone(this.state.timer) }, "actions.timer.clear-failed");
    }

    async selectedTaskRetargetMissing(taskId, context) {
      const diverged = (timer) => Boolean(timer?.id) && ["running", "paused"].includes(timer.status)
        && timer.phase === "focus" && (timer.taskId ?? null) !== (taskId ?? null);
      if (!diverged(this.state.timer)) return false;
      try {
        context.assertCurrent();
        await this.use.reloadPersistedState(null, context, "mutation");
        context.assertCurrent();
      } catch { return false; }
      return diverged(this.state.timer);
    }

    executeWorkspaceEffects(effects, context) {
      accountOperation.requireBound(context);
      for (const effect of effects) {
        context.assertCurrent();
        switch (effect.kind) {
          case "launchSync": this.use.scheduleSync(0, false, context); break;
          case "clearCompletionAlert": this.use.stopCompletionAlert(); break;
          case "cancelAlarm": case "pauseAlarm": this.host.clearTimeout(this.alarmTimer); break;
          case "scheduleAlarm": case "resumeAlarm": {
            this.host.clearTimeout(this.alarmTimer);
            this.alarmTimer = this.host.setTimeout(() => {
              try { context.assertCurrent(); this.use.renderTimer(); }
              catch (error) { if (error.name !== "AccountOwnershipError") throw error; }
            }, effect.durationMs);
            break;
          }
          default: throw new Error("Unsupported Core browser effect.");
        }
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
      this.heartbeatRenewal = null;
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

    async finishTimer(automatic = false, expectedUserId = this.syncCore.accountOwnerId(this.state.user) || this.state.localOwnerId || null) {
      if (this.use.controlsBlocked() || this.state.actionLocked) return false;
      if (this.state.workspaceBlocked) return false;
      const context = this.use.captureAccountContext();
      const timer = this.use.clone(this.state.timer);
      this.state.actionLocked = true;
      try {
        this.use.assertExpectedAccount(expectedUserId);
        const plan = await this.use.persistWorkspaceCompletion(automatic ? "automaticFinishCommit" : "finishCommit", timer, context);
        context.assertCurrent();
        if (plan.outcome === "noop") {
          if (automatic && plan.reason === "not_owner") {
            this.scheduleCompletionRetry(timer.id, plan, context);
            return true;
          }
          return automatic;
        }
        this.host.clearTimeout(this.completionRetryTimer);
        this.completionRetryTimer = null;
        this.startCompletionAlert(timer);
        context.assertCurrent();
        this.use.render();
        this.executeEffects(plan.effectsAfterCommit, context);
        return true;
      } catch (error) {
        if (error.name === "AccountOwnershipError") return false;
        this.host.console.warn("Pomodorough timer finish failed:", error);
        reportFrontendError(error, "actions.timer.finish-failed");
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
      } catch (error) {
        // S53: a denied/broken Notification ctor must stay visible in
        // diagnostics; audio + retry paths still alert.
        this.host.console.warn("Pomodorough completion notification unavailable:", error);
        reportFrontendError(error, "actions.completion.notification-failed");
        this.completionAlertNotification = null;
        return false;
      }
    }

    async primeCompletionAlerts() {
      const AudioContextType = this.host.AudioContext || this.host.webkitAudioContext;
      if (!this.completionAlertContext && AudioContextType) {
        try { this.completionAlertContext = new AudioContextType(); } catch (error) {
          // S54: audio-alert failures stay visible in diagnostics;
          // the notification path still alerts.
          this.host.console.warn("Pomodorough completion audio unavailable:", error);
          reportFrontendError(error, "actions.completion.audio-init-failed");
          this.completionAlertContext = null;
        }
      }
      if (this.completionAlertContext?.state === "suspended") {
        try { await this.completionAlertContext.resume(); } catch (error) {
          this.host.console.warn("Pomodorough completion audio resume failed:", error);
          reportFrontendError(error, "actions.completion.audio-resume-failed");
        }
      }
      const NotificationType = this.host.Notification;
      if (NotificationType?.permission === "default") {
        try { await NotificationType.requestPermission(); } catch (error) {
          // S60: denied-permission failures stay visible in diagnostics;
          // audio + retry paths still alert.
          this.host.console.warn("Pomodorough completion permission unavailable:", error);
          reportFrontendError(error, "actions.completion.permission-failed");
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

    scheduleCompletionRetry(timerId, outcome, context = this.use.captureAccountContext()) {
      context.assertCurrent();
      const delay = this.completionRetryDelay(outcome);
      if (delay === null) return;
      this.host.clearTimeout(this.completionRetryTimer);
      this.completionRetryTimer = this.host.setTimeout(() => {
        try { context.assertCurrent(); }
        catch (error) { if (error.name === "AccountOwnershipError") return; throw error; }
        this.completionRetryTimer = null;
        if (!this.releaseCompletionRetry(timerId, context.ownerId)) return;
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

    heartbeatTimerOwnership(context = null) {
      if (context && !accountOperation.isCurrent(context)) return;
      if (this.heartbeatRenewal) return this.heartbeatRenewal;
      const database = this.use.database();
      if (!database || !this.state.ready || !this.state.deviceId || !this.state.timer.id
        || !["running", "paused"].includes(this.state.timer.status)) return;
      context ||= this.use.captureDatabaseContext();
      accountOperation.requireBound(context);
      const input = {
        ...context, expectedUserId: context.ownerId,
        timerId: this.state.timer.id, deviceId: this.state.deviceId, tabId: this.use.tabId(),
        nowMs: Date.now(), leaseMs: TIMER_OWNER_LEASE_MS
      };
      // Coalesce interval ticks with this renewal. Only a later independent tick
      // may capture a new scope after the issuing operation releases its guard.
      const operation = Promise.resolve().then(() => {
        if (!accountOperation.isCurrent(context)) return;
        return this.syncStorage.renewTimerOwnership(context.database, input);
      }).then((renewed) => accountOperation.isCurrent(context) ? renewed : undefined).catch((error) => {
        if (!accountOperation.isCurrent(context)) return;
        if (error.name === "AccountOwnershipError") this.use.quarantineAccountMismatch();
        else {
          this.host.console.warn("Timer ownership renewal failed:", error);
          reportFrontendError(error, "actions.timer-ownership.renewal-failed");
        }
      }).finally(() => {
        if (this.heartbeatRenewal === operation) this.heartbeatRenewal = null;
      });
      this.heartbeatRenewal = operation;
      return operation;
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
    const mutations = new ActionMutations(state, external, use);
    timerLifecycle.executeEffects = mutations.executeWorkspaceEffects.bind(mutations);
    return { ...phasePolicy.actions(), ...timerLifecycle.actions(), ...mutations.actions() };
  }

  return Object.freeze({ manifest, create });
});
