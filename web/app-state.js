(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PomodoroughAppState = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const accountOperation = typeof module === "object" && module.exports
    ? require("./account-operation.js") : globalThis.PomodoroughAccountOperation;

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
      pending: [], pendingTaskOperations: [], pendingDurationOperations: [],
      pendingAutoStartOperations: [], pendingSelectedTaskOperations: [],
      deliveryProof: null, canonicalHead: null, projectionPending: null, outgoingSync: null,
      timerDependencies: null, workspaceObservation: null, workspaceBlocked: false, readModel: null,
      completionState: null
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
      activeScreen: "timer", syncing: false, retrying: false, conflict: null, savedClaimRecovery: null,
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
    requires: ["database", "activeCompletionAlertTimerId", "stopCompletionAlert", "queueSessionRevalidation"],
    provides: [
      "clone", "emptyTimer", "controlsBlocked", "normalizeTimer", "loadSharedCore",
      "sharedTaskIdentity", "positiveNumber", "clampNumber", "selectedDurationMs",
      "selectedTaskIdForNextFocus", "normalizeDurationsMs", "compareDurationOperations",
      "compareTimerCommands", "trustedNow", "monotonicNow", "clockContinuityId", "getWorkspaceReadModel", "elapsedFor", "projectOwnerState",
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
    constructor(state, host, syncStorage) {
      this.state = state;
      this.host = host;
      this.syncStorage = syncStorage;
      this.continuityId = null;
      this.runtime = null;
    }

    actions() {
      return bindActions(this, ["trustedNow", "monotonicNow", "clockContinuityId"]);
    }

    monotonicNow() {
      const value = this.host.performance?.now?.();
      return Number.isFinite(value) ? value : null;
    }

    trustedNow(localNowMs = Date.now(), monotonicMs = this.monotonicNow()) {
      const value = this.syncStorage.observeClock({ clockOffset: this.state.clockOffset,
        minimumWallMs: this.state.hlcWallMs, runtime: this.runtime }, { wallMs: localNowMs, monotonicMs });
      this.runtime = value.state.runtime ?? null;
      return value.trustedNowMs;
    }

    clockContinuityId() { return this.continuityId ||= this.host.crypto.randomUUID(); }
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
      const pending = (this.promise ||= this.sharedCoreHost.SharedCore.load());
      try {
        return await pending;
      } catch (error) {
        if (this.promise === pending) this.promise = null;
        throw error;
      }
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
        "selectedTaskIdForNextFocus", "normalizeDurationsMs", "compareDurationOperations",
        "projectOwnerState", "getWorkspaceReadModel", "elapsedFor", "rebuildOptimisticState", "ownerStateValue", "resetOwnerState",
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
      return this.syncStorage.projectWorkspace({ snapshot: { canonicalTimer: null, history: [], tasks: [],
        durationsMs: value ?? DEFAULT_DURATIONS_MS, autoStartBreaks: false, selectedTaskId: null },
        deviceId: this.state.deviceId, nowMs: 0 }).workspace.durationsMs;
    }

    selectedDurationMs() {
      return this.state.durationsMs[this.state.selectedPhase];
    }

    selectedTaskIdForNextFocus() {
      return this.state.tasks.some((task) => task.id === this.state.selectedTaskId)
        ? this.state.selectedTaskId : null;
    }

    emptyTimer(phase, plannedDurationMs) {
      return emptyTimerValue(phase, plannedDurationMs);
    }

    normalizeTimer(timer) {
      const result = this.syncStorage.projectWorkspace({ snapshot: {
        canonicalTimer: timer?.id ? timer : null, history: [], tasks: [], durationsMs: this.state.durationsMs,
        autoStartBreaks: false, selectedTaskId: null }, deviceId: this.state.deviceId, nowMs: 0 });
      return result.workspace.canonicalTimer || this.emptyTimer(this.state.selectedPhase, this.selectedDurationMs());
    }

    compareDurationOperations(left, right) {
      return Number(left.hlcWallMs) - Number(right.hlcWallMs)
        || Number(left.hlcCounter) - Number(right.hlcCounter)
        || String(left.id).localeCompare(String(right.id));
    }

    workspaceInput(local = this.state) {
      return {
        snapshot: { canonicalTimer: local.baseTimer?.id ? local.baseTimer : null,
          user: local.user ?? this.state.user,
          history: local.baseHistory, tasks: local.baseTasks, durationsMs: local.baseDurationsMs,
          autoStartBreaks: local.baseAutoStartBreaks, selectedTaskId: local.baseSelectedTaskId },
        commands: local.pending, taskOperations: local.pendingTaskOperations,
        durationOperations: local.pendingDurationOperations, autoStartOperations: local.pendingAutoStartOperations,
        selectedTaskOperations: local.pendingSelectedTaskOperations,
        deliveryProof: local.deliveryProof, canonicalHead: local.canonicalHead,
        timerDependencies: local.timerDependencies, deviceId: this.state.deviceId,
        projectionPending: local.projectionPending, outgoing: local.outgoingSync, completionState: local.completionState
      };
    }

    getWorkspaceReadModel() {
      const monotonicMs = this.clock.monotonicNow();
      const nowMs = this.clock.trustedNow(Date.now(), monotonicMs);
      const observed = this.syncStorage.observeWorkspace({ ...this.workspaceInput(), nowMs, monotonicMs,
        selectedPhase: this.state.selectedPhase, continuityId: this.clock.clockContinuityId(),
        deviceSequence: this.state.deviceSequence, hlc: { wallMs: this.state.hlcWallMs, counter: this.state.hlcCounter },
        workspaceObservation: this.state.workspaceObservation });
      this.state.workspaceObservation = observed.observation;
      const readModel = this.syncStorage.readWorkspace({ ...this.workspaceInput(),
        selectedPhase: this.state.selectedPhase, nowMs,
        monotonic: monotonicMs === null || !this.state.workspaceObservation?.monotonicAnchor ? null
          : { nowMs: monotonicMs, continuityId: this.clock.clockContinuityId(),
            anchor: this.state.workspaceObservation.monotonicAnchor } });
      this.state.readModel = readModel;
      return readModel;
    }

    elapsedFor() {
      return this.getWorkspaceReadModel().canonical.elapsedMs;
    }

    projectOwnerState(local) {
      const result = this.syncStorage.projectWorkspace({ ...this.workspaceInput(local), nowMs: 0 });
      const projection = result.workspace;
      local.timer = projection.canonicalTimer || this.emptyTimer(local.selectedPhase, projection.durationsMs[local.selectedPhase]);
      Object.assign(local, {
        history: projection.history, tasks: projection.tasks, durationsMs: projection.durationsMs,
        autoStartBreaks: projection.autoStartBreaks, selectedTaskId: projection.selectedTaskId
      });
      local.workspaceBlocked = false;
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
        baseSelectedTaskId: this.state.baseSelectedTaskId, selectedTaskId: this.state.selectedTaskId,
        baseAutoStartBreaks: this.state.baseAutoStartBreaks, autoStartBreaks: this.state.autoStartBreaks,
        baseDurationsMs: clone(this.state.baseDurationsMs), durationsMs: clone(this.state.durationsMs),
        baseTimer: clone(this.state.baseTimer), timer: clone(this.state.timer),
        baseHistory: clone(this.state.baseHistory), history: clone(this.state.history),
        baseTasks: clone(this.state.baseTasks), tasks: clone(this.state.tasks), pending: clone(this.state.pending),
        pendingTaskOperations: clone(this.state.pendingTaskOperations),
        pendingDurationOperations: clone(this.state.pendingDurationOperations),
        pendingAutoStartOperations: clone(this.state.pendingAutoStartOperations),
        pendingSelectedTaskOperations: clone(this.state.pendingSelectedTaskOperations), user: clone(this.state.user),
        deliveryProof: clone(this.state.deliveryProof), canonicalHead: clone(this.state.canonicalHead),
        projectionPending: clone(this.state.projectionPending), outgoingSync: clone(this.state.outgoingSync),
        timerDependencies: clone(this.state.timerDependencies), workspaceObservation: clone(this.state.workspaceObservation),
        workspaceBlocked: this.state.workspaceBlocked, completionState: clone(this.state.completionState)
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
      return accountOperation.bind(this.accountIdentity(), () => this.use.database(), this.syncStorage.AccountOwnershipError,
        () => this.accountIdentity());
    }

    accountIdentity() {
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
        "revision", "selectedPhase", "baseSelectedTaskId", "selectedTaskId",
        "baseAutoStartBreaks", "autoStartBreaks", "baseDurationsMs", "durationsMs",
        "baseTimer", "timer", "baseHistory", "history", "baseTasks", "tasks", "pending",
        "pendingTaskOperations", "pendingDurationOperations", "pendingAutoStartOperations",
        "pendingSelectedTaskOperations", "user",
        "deliveryProof", "canonicalHead", "projectionPending", "outgoingSync",
        "timerDependencies", "workspaceObservation", "workspaceBlocked", "completionState"
      ];
      for (const field of fields) this.state[field] = local[field];
    }

    phaseConfig() { return PHASES; }
    defaultDurationsMs() { return DEFAULT_DURATIONS_MS; }
    tabId() { return this.state.tabId; }
  }

  function create({ state, external, use }) {
    const clock = new TrustedClock(state, external.host, external.syncStorage);
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
