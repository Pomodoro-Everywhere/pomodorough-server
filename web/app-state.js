(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PomodoroughAppState = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PHASES = Object.freeze({
    focus: Object.freeze({ labelKey: "phase.focus", shortKey: "phase.focus.short", defaultMinutes: 25 }),
    short_break: Object.freeze({ labelKey: "phase.shortBreak", shortKey: "phase.shortBreak.short", defaultMinutes: 5 }),
    long_break: Object.freeze({ labelKey: "phase.longBreak", shortKey: "phase.longBreak.short", defaultMinutes: 15 })
  });
  const DEFAULT_DURATIONS_MS = Object.freeze({
    focus: 1_500_000,
    short_break: 300_000,
    long_break: 900_000
  });

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function emptyTimerValue(phase, plannedDurationMs) {
    return {
      id: null,
      phase,
      status: "idle",
      plannedDurationMs,
      elapsedAtAnchorMs: 0,
      anchorAt: null,
      lastIntent: null,
      taskId: null,
      dependsOnCommandId: null
    };
  }

  function positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  function clampNumber(value, minimum, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number)) return minimum;
    return Math.min(maximum, Math.max(minimum, number));
  }

  function bindActions(owner, names) {
    return Object.fromEntries(names.map((name) => {
      owner[name] = owner[name].bind(owner);
      return [name, owner[name]];
    }));
  }

  function tabID(host) {
    try {
      const existing = host.sessionStorage.getItem("pomodoroughTabId");
      if (existing) return existing;
      const created = host.crypto.randomUUID();
      host.sessionStorage.setItem("pomodoroughTabId", created);
      return created;
    } catch {
      return host.crypto.randomUUID();
    }
  }

  function initialOwnershipState() {
    return {
      revision: 0,
      selectedPhase: "focus",
      baseSelectedTaskId: null,
      selectedTaskId: null,
      baseAutoStartBreaks: false,
      autoStartBreaks: false,
      baseDurationsMs: clone(DEFAULT_DURATIONS_MS),
      durationsMs: clone(DEFAULT_DURATIONS_MS),
      baseTimer: emptyTimerValue("focus", DEFAULT_DURATIONS_MS.focus),
      timer: emptyTimerValue("focus", DEFAULT_DURATIONS_MS.focus),
      baseHistory: [], history: [], baseTasks: [], tasks: [],
      retargetedTaskByTimerId: {},
      pending: [], pendingTaskOperations: [], pendingDurationOperations: [],
      pendingAutoStartOperations: [], pendingSelectedTaskOperations: []
    };
  }

  function initialBootstrapState() {
    return {
      bootstrapBlocked: true, bootstrapPreview: null, bootstrapPlan: null,
      bootstrapOwnershipConfirmation: false, bootstrapOwnershipApproved: false,
      bootstrapStrategy: null, bootstrapPending: null, bootstrapSubmitting: false,
      bootstrapConflict: false, bootstrapError: null, bootstrapLimitError: null,
      bootstrapGatePersisted: false, bootstrapGateOwned: false, bootstrapFocusTarget: null
    };
  }

  function createState(host = globalThis) {
    return {
      ready: false, authenticated: false, sessionIdentityValidated: false,
      logoutRecoveryRequired: false, logoutRecoveryBusy: false,
      offlineOwnerMode: false, user: null, csrfToken: null, deviceId: null,
      deviceSequence: 0, hlcWallMs: 0, hlcCounter: 0, clockOffset: null,
      activeScreen: "timer", syncing: false, retrying: false, conflict: null,
      durationSyncBootstrapped: false, autoStartSyncBootstrapped: false,
      selectedTaskSyncBootstrapped: false, actionLocked: false,
      tabId: tabID(host),
      ...initialOwnershipState(),
      localOwnerId: null, quarantinedLocal: null,
      ...initialBootstrapState()
    };
  }

  const manifest = Object.freeze({
    name: "state",
    externals: ["host", "sharedCoreHost", "syncCore", "syncStorage"],
    requires: ["activeCompletionAlertTimerId", "stopCompletionAlert", "queueSessionRevalidation"],
    provides: [
      "clone", "emptyTimer", "controlsBlocked", "normalizeTimer", "loadSharedCore",
      "sharedTaskIdentity", "positiveNumber", "clampNumber", "selectedDurationMs",
      "selectedTaskIdForNextFocus", "applyTaskRetarget", "normalizeDurationsMs", "compareDurationOperations",
      "compareTimerCommands", "trustedNow", "monotonicNow", "elapsedFor", "projectOwnerState",
      "rebuildOptimisticState", "ownerStateValue", "resetOwnerState", "quarantineOwnerState",
      "restoreOwnerState", "quarantineAccountMismatch", "assertExpectedAccount", "captureAccountContext", "tr", "phaseLabel", "phaseShortLabel", "timerStatusLabel",
      "setI18nForTest", "phaseConfig", "defaultDurationsMs", "tabId"
    ],
    emits: [],
    listens: []
  });

  class LanguageCatalog {
    constructor() {
      this.i18n = null;
    }

    actions() {
      return bindActions(this, ["tr", "phaseLabel", "phaseShortLabel", "timerStatusLabel", "setI18nForTest"]);
    }

    tr(key, values = {}, fallback = key) {
      const translated = this.i18n?.t(key, values);
      return translated && translated !== key ? translated : fallback;
    }

    phaseLabel(phase) {
      const fallback = phase === "focus" ? "Focus" : phase === "short_break" ? "Short break" : "Long break";
      return this.tr(PHASES[phase].labelKey, {}, fallback);
    }

    phaseShortLabel(phase) {
      const fallback = phase === "focus" ? "F" : phase === "short_break" ? "SB" : "LB";
      return this.tr(PHASES[phase].shortKey, {}, fallback);
    }

    timerStatusLabel(status) {
      const keys = {
        idle: ["timer.status.idle", "Idle"], running: ["timer.status.running", "Running"],
        paused: ["timer.status.paused", "Paused"], completed: ["timer.status.completed", "Completed"],
        cancelled: ["timer.status.cancelled", "Cancelled"], superseded: ["timer.status.superseded", "Superseded"]
      };
      const [key, fallback] = keys[status] || keys.idle;
      return this.tr(key, {}, fallback);
    }

    setI18nForTest(value) {
      this.i18n = value;
    }
  }

  class TrustedClock {
    constructor(state, host, syncCore) {
      this.state = state;
      this.host = host;
      this.syncCore = syncCore;
      this.elapsedMonotonicAnchor = null;
      this.runtime = null;
    }

    actions() {
      return bindActions(this, ["trustedNow", "monotonicNow", "elapsedFor"]);
    }

    monotonicNow() {
      const value = this.host.performance?.now?.();
      return Number.isFinite(value) ? value : null;
    }

    trustedNow(localNowMs = Date.now(), monotonicMs = this.monotonicNow()) {
      const sample = this.syncCore.validClockSample(this.state.clockOffset) ? this.state.clockOffset : null;
      const identity = sample ? `${sample.offsetMs}:${sample.uncertaintyMs}:${sample.sampledAtWallMs}` : "local";
      if (monotonicMs === null) return this.syncCore.trustedNow(localNowMs, sample, this.state.hlcWallMs);
      if (this.runtime?.identity !== identity || monotonicMs < this.runtime.monotonicMs) {
        const wallMs = this.syncCore.trustedNow(localNowMs, sample, this.state.hlcWallMs);
        this.runtime = { identity, monotonicMs, wallMs };
        return wallMs;
      }
      const wallMs = this.runtime.wallMs + Math.round(monotonicMs - this.runtime.monotonicMs);
      return this.syncCore.trustedNow(wallMs, null, this.state.hlcWallMs);
    }

    elapsedFor(timer, now = this.trustedNow(), monotonicMs = this.monotonicNow()) {
      if (!timer) return 0;
      const planned = positiveNumber(timer.plannedDurationMs, 0);
      let elapsed = clampNumber(timer.elapsedAtAnchorMs, 0, planned);
      if (timer.status === "running" && timer.anchorAt) {
        const anchorMs = Date.parse(timer.anchorAt);
        if (Number.isFinite(anchorMs)) elapsed += Math.max(0, now - anchorMs);
        const key = `${timer.id || ""}\u0000${timer.anchorAt}\u0000${timer.elapsedAtAnchorMs}`;
        if (monotonicMs !== null && this.elapsedMonotonicAnchor?.key === key
          && monotonicMs >= this.elapsedMonotonicAnchor.monotonicMs) {
          elapsed = this.elapsedMonotonicAnchor.elapsedMs + monotonicMs - this.elapsedMonotonicAnchor.monotonicMs;
        } else if (monotonicMs !== null) this.elapsedMonotonicAnchor = { key, elapsedMs: elapsed, monotonicMs };
      } else if (this.elapsedMonotonicAnchor) this.elapsedMonotonicAnchor = null;
      return clampNumber(elapsed, 0, planned);
    }
  }

  class SharedTaskCore {
    constructor(sharedCoreHost) {
      this.sharedCoreHost = sharedCoreHost;
      this.promise = null;
    }

    actions() {
      return bindActions(this, ["loadSharedCore", "sharedTaskIdentity"]);
    }

    async loadSharedCore() {
      if (!this.sharedCoreHost?.SharedCore) throw new Error("Shared core is unavailable.");
      this.promise ||= this.sharedCoreHost.SharedCore.load();
      return this.promise;
    }

    async sharedTaskIdentity(title) {
      const identity = (await this.loadSharedCore()).taskIdentity({ title });
      if (!identity || typeof identity.id !== "string" || typeof identity.title !== "string") {
        throw new Error("Shared core returned an invalid task identity.");
      }
      return identity;
    }
  }

  class OwnerStateProjector {
    constructor(state, syncCore, syncStorage, use, clock, host) {
      Object.assign(this, { state, syncCore, syncStorage, use, clock, host });
    }

    actions() {
      return bindActions(this, [
        "emptyTimer", "controlsBlocked", "normalizeTimer", "selectedDurationMs",
        "selectedTaskIdForNextFocus", "applyTaskRetarget", "normalizeDurationsMs", "compareDurationOperations",
        "projectOwnerState", "rebuildOptimisticState", "ownerStateValue", "resetOwnerState",
        "quarantineOwnerState", "restoreOwnerState", "quarantineAccountMismatch", "assertExpectedAccount", "captureAccountContext", "phaseConfig", "defaultDurationsMs", "tabId"
      ]);
    }

    controlsBlocked() {
      return !this.state.ready || this.state.logoutRecoveryRequired || this.needsBootstrap();
    }

    needsBootstrap() {
      return this.syncCore.requiresBootstrapResolution({
        blocked: this.state.bootstrapBlocked, persistedGate: this.state.bootstrapGatePersisted,
        pending: this.state.bootstrapPending, currentUserId: this.syncCore.accountOwnerId(this.state.user),
        localOwnerId: this.state.localOwnerId
      });
    }

    normalizeDurationsMs(value) {
      return Object.fromEntries(Object.keys(PHASES).map((phase) => [phase, Math.round(clampNumber(
        value?.[phase] ?? DEFAULT_DURATIONS_MS[phase], 60_000, 10_800_000
      ))]));
    }

    selectedDurationMs() {
      return this.state.durationsMs[this.state.selectedPhase];
    }

    selectedTaskIdForNextFocus() {
      return this.state.tasks.some((task) => task.id === this.state.selectedTaskId)
        ? this.state.selectedTaskId : null;
    }

    applyTaskRetarget() {
      if (!this.state.retargetedTaskByTimerId || typeof this.state.retargetedTaskByTimerId !== "object") {
        this.state.retargetedTaskByTimerId = {};
      }
      const markers = this.state.retargetedTaskByTimerId;
      const timer = this.state.timer;
      if (timer && typeof timer.id === "string" && timer.id
        && ["running", "paused"].includes(timer.status) && timer.phase === "focus"
        && Object.hasOwn(markers, timer.id)) {
        timer.taskId = markers[timer.id] ?? null;
      }
      const live = new Set();
      if (timer?.id) live.add(timer.id);
      for (const item of this.state.history || []) {
        if (item?.timerId) live.add(item.timerId);
      }
      for (const key of Object.keys(markers)) {
        if (!live.has(key)) delete markers[key];
      }
      return markers;
    }

    emptyTimer(phase, plannedDurationMs) {
      return emptyTimerValue(phase, plannedDurationMs);
    }

    normalizeTimer(timer) {
      if (!timer || typeof timer !== "object") {
        return this.emptyTimer(this.state.selectedPhase, this.selectedDurationMs());
      }
      const phase = PHASES[timer.phase] ? timer.phase : "focus";
      const plannedDurationMs = positiveNumber(timer.plannedDurationMs, this.state.durationsMs[phase]);
      return {
        ...timer,
        id: timer.id || null,
        phase,
        status: ["idle", "running", "paused", "completed", "cancelled", "superseded"].includes(timer.status)
          ? timer.status : "idle",
        plannedDurationMs,
        elapsedAtAnchorMs: clampNumber(timer.elapsedAtAnchorMs, 0, plannedDurationMs),
        anchorAt: timer.anchorAt || null,
        lastIntent: timer.lastIntent || null,
        taskId: timer.taskId || null,
        dependsOnCommandId: timer.dependsOnCommandId || null
      };
    }

    compareDurationOperations(left, right) {
      return Number(left.hlcWallMs) - Number(right.hlcWallMs)
        || Number(left.hlcCounter) - Number(right.hlcCounter)
        || String(left.id).localeCompare(String(right.id));
    }

    projectOwnerState(local) {
      const projection = this.syncStorage.projectState({
        snapshot: {
          canonicalTimer: local.baseTimer?.id ? clone(local.baseTimer) : null,
          history: clone(local.baseHistory || []), tasks: clone(local.baseTasks || []),
          durationsMs: this.normalizeDurationsMs(local.baseDurationsMs),
          autoStartBreaks: local.baseAutoStartBreaks === true,
          selectedTaskId: local.baseSelectedTaskId ?? null
        },
        queues: {
          commands: local.pending, taskOperations: local.pendingTaskOperations,
          durationOperations: local.pendingDurationOperations,
          autoStartOperations: local.pendingAutoStartOperations,
          selectedTaskOperations: local.pendingSelectedTaskOperations
        },
        nowMs: this.clock.trustedNow(), deviceId: this.state.deviceId
      });
      const pendingStart = [...local.pending].filter((command) =>
        command.type === "start" && command.timerId === projection.canonicalTimer?.id
      ).sort(this.syncCore.compareTimerCommands).at(-1);
      local.timer = projection.canonicalTimer
        ? this.normalizeTimer(pendingStart?.dependsOnCommandId
          ? { ...projection.canonicalTimer, dependsOnCommandId: pendingStart.dependsOnCommandId }
          : projection.canonicalTimer)
        : this.emptyTimer(local.selectedPhase, projection.durationsMs[local.selectedPhase]);
      Object.assign(local, {
        history: projection.history, tasks: projection.tasks, durationsMs: projection.durationsMs,
        autoStartBreaks: projection.autoStartBreaks, selectedTaskId: projection.selectedTaskId
      });
      if (local === this.state) this.applyTaskRetarget();
    }

    rebuildOptimisticState() {
      this.projectOwnerState(this.state);
      const alertTimerId = this.use.activeCompletionAlertTimerId();
      if (alertTimerId && this.state.timer?.id !== alertTimerId
        && ["running", "paused"].includes(this.state.timer?.status)) this.use.stopCompletionAlert();
    }

    ownerStateValue() {
      return {
        revision: this.state.revision, selectedPhase: this.state.selectedPhase,
        retargetedTaskByTimerId: this.state.retargetedTaskByTimerId
          ? JSON.parse(JSON.stringify(this.state.retargetedTaskByTimerId)) : {},
        baseSelectedTaskId: this.state.baseSelectedTaskId, selectedTaskId: this.state.selectedTaskId,
        baseAutoStartBreaks: this.state.baseAutoStartBreaks, autoStartBreaks: this.state.autoStartBreaks,
        baseDurationsMs: clone(this.state.baseDurationsMs), durationsMs: clone(this.state.durationsMs),
        baseTimer: clone(this.state.baseTimer), timer: clone(this.state.timer),
        baseHistory: clone(this.state.baseHistory), history: clone(this.state.history),
        baseTasks: clone(this.state.baseTasks), tasks: clone(this.state.tasks), pending: clone(this.state.pending),
        pendingTaskOperations: clone(this.state.pendingTaskOperations),
        pendingDurationOperations: clone(this.state.pendingDurationOperations),
        pendingAutoStartOperations: clone(this.state.pendingAutoStartOperations),
        pendingSelectedTaskOperations: clone(this.state.pendingSelectedTaskOperations), user: clone(this.state.user)
      };
    }

    resetOwnerState() {
      Object.assign(this.state, initialOwnershipState());
    }

    quarantineOwnerState(preserveValidatedUser = false) {
      const user = preserveValidatedUser ? this.state.user : null;
      if (!this.state.quarantinedLocal) this.state.quarantinedLocal = this.ownerStateValue();
      this.resetOwnerState();
      if (user) this.state.user = user;
    }

    quarantineAccountMismatch() {
      this.state.bootstrapBlocked = true;
      this.state.sessionIdentityValidated = false;
      this.state.offlineOwnerMode = false;
      this.state.bootstrapGateOwned = false;
      this.use.stopCompletionAlert();
      this.quarantineOwnerState(true);
      this.use.queueSessionRevalidation();
    }

    captureAccountContext() {
      const ownerId = this.syncCore.accountOwnerId(this.state.user) || this.state.localOwnerId || null;
      const localOwnerId = this.state.localOwnerId;
      const marker = () => {
        try { return JSON.stringify([this.host.localStorage?.getItem("pomodoroughPendingLogout"),
          this.host.localStorage?.getItem("pomodoroughPendingLogoutOwner")]); }
        catch { return "unavailable"; }
      };
      const logoutMarker = marker();
      return { ownerId, localOwnerId, expectedUserId: localOwnerId || null, currentUserId: ownerId, assertCurrent: () => {
        if ((this.syncCore.accountOwnerId(this.state.user) || this.state.localOwnerId || null) !== ownerId
          || this.state.localOwnerId !== localOwnerId || marker() !== logoutMarker) {
          throw new this.syncStorage.AccountOwnershipError();
        }
      } };
    }

    assertExpectedAccount(expectedUserId) {
      if ((this.syncCore.accountOwnerId(this.state.user) || this.state.localOwnerId || null) === expectedUserId) return;
      this.quarantineAccountMismatch();
      throw new this.syncStorage.AccountOwnershipError();
    }

    restoreOwnerState(local) {
      const fields = [
        "revision", "selectedPhase", "retargetedTaskByTimerId", "baseSelectedTaskId", "selectedTaskId",
        "baseAutoStartBreaks", "autoStartBreaks", "baseDurationsMs", "durationsMs",
        "baseTimer", "timer", "baseHistory", "history", "baseTasks", "tasks", "pending",
        "pendingTaskOperations", "pendingDurationOperations", "pendingAutoStartOperations",
        "pendingSelectedTaskOperations", "user"
      ];
      for (const field of fields) this.state[field] = local[field];
      if (!this.state.retargetedTaskByTimerId || typeof this.state.retargetedTaskByTimerId !== "object") {
        this.state.retargetedTaskByTimerId = {};
      }
    }

    phaseConfig() { return PHASES; }
    defaultDurationsMs() { return DEFAULT_DURATIONS_MS; }
    tabId() { return this.state.tabId; }
  }

  function create({ state, external, use }) {
    const clock = new TrustedClock(state, external.host, external.syncCore);
    const owner = new OwnerStateProjector(state, external.syncCore, external.syncStorage, use, clock, external.host);
    const language = new LanguageCatalog();
    const sharedTasks = new SharedTaskCore(external.sharedCoreHost);
    return {
      clone, positiveNumber, clampNumber, compareTimerCommands: external.syncCore.compareTimerCommands,
      ...clock.actions(), ...owner.actions(), ...language.actions(), ...sharedTasks.actions()
    };
  }

  return Object.freeze({ DEFAULT_DURATIONS_MS, PHASES, createState, manifest, create });
});
