(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PomodoroughAppSync = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const RETRY_MAX_MS = 60_000;
  const REMOTE_SYNC_INTERVAL_MS = 15_000;
  const TIMER_OWNER_LEASE_MS = 60_000;

  function bindActions(owner, names) {
    return Object.fromEntries(names.map((name) => {
      owner[name] = owner[name].bind(owner);
      return [name, owner[name]];
    }));
  }

  const manifest = Object.freeze({
    name: "sync",
    externals: ["host", "syncCore", "syncStorage"],
    requires: [
      "captureAccountContext",
      "clone", "normalizeTimer", "emptyTimer", "selectedDurationMs", "normalizeDurationsMs",
      "selectedPhaseAfterCommandAcknowledgements", "snapshotValue", "settingsValue", "tabId",
      "reloadPersistedState", "database", "setInFlightDurationOperationIds", "stopCompletionAlert",
      "closeRevisionStream", "quarantineOwnerState", "render", "renderSyncStatus", "tr",
      "postMutation", "redirectToLogin", "queueSessionRevalidation", "restoreSessionAndSync",
      "compareDurationOperations", "rebuildOptimisticState"
    ],
    provides: [
      "mergeServerHlc", "responseClockOffset", "rejectedSyncAcknowledgements",
      "acceptSyncResponse", "hasPendingOperations", "syncPreflight", "currentSyncBatch",
      "syncRequestBody", "syncNow", "scheduleSync", "scheduleRetry", "needsBootstrapResolution",
      "refreshAllPendingOperations", "remoteSyncIntervalMs", "retryDelayMsForTest",
      "resetSyncRetry"
    ],
    emits: [],
    listens: ["revision-hint"]
  });

  class SyncResponseReconciler {
    constructor(state, external, use) {
      Object.assign(this, { state, use }, external);
    }

    actions() {
      return bindActions(this, [
        "mergeServerHlc", "responseClockOffset", "rejectedSyncAcknowledgements", "acceptSyncResponse"
      ]);
    }

    mergeServerHlc(serverWallMs, serverCounter, clockOffset = this.state.clockOffset) {
      const candidates = [
        { wallMs: this.syncCore.trustedNow(Date.now(), clockOffset), counter: 0 },
        { wallMs: this.state.hlcWallMs, counter: this.state.hlcCounter },
        { wallMs: Number(serverWallMs) || 0, counter: Number(serverCounter) || 0 }
      ];
      return candidates.reduce((latest, candidate) =>
        candidate.wallMs > latest.wallMs
          || candidate.wallMs === latest.wallMs && candidate.counter > latest.counter
          ? candidate : latest
      );
    }

    responseClockOffset(payload, timing, cacheable) {
      if (cacheable || !timing) return this.state.clockOffset;
      return this.syncCore.serverClockOffset(
        payload.serverTime, timing.requestAtMs, timing.receivedAtMs, timing.requestSequence
      );
    }

    rejectedSyncAcknowledgements(validated) {
      const timerConflicts = validated.commands.acknowledgements.filter(
        (acknowledgement) => acknowledgement.outcome === "rejected"
      );
      return timerConflicts.concat(
        validated.tasks.acknowledgements.filter((item) => item.outcome === "rejected"),
        validated.durations.acknowledgements.filter((item) => item.outcome === "rejected"),
        validated.autoStart.acknowledgements.filter((item) => item.outcome === "rejected"),
        validated.selectedTask.acknowledgements.filter((item) => item.outcome === "rejected")
      );
    }

    acknowledgedQueueIds(validated) {
      return {
        commands: [...validated.commands.acknowledgedIds],
        taskOperations: [...validated.tasks.acknowledgedIds],
        durationOperations: [...validated.durations.acknowledgedIds],
        autoStartOperations: [...validated.autoStart.acknowledgedIds],
        selectedTaskOperations: [...validated.selectedTask.acknowledgedIds]
      };
    }

    syncResponseState(payload, rebased, validated, timing) {
      const canonicalTimer = Object.prototype.hasOwnProperty.call(rebased, "baseTimer")
        ? rebased.baseTimer ? this.use.normalizeTimer(rebased.baseTimer)
          : this.use.emptyTimer(this.state.selectedPhase, this.use.selectedDurationMs())
        : this.state.baseTimer;
      const durationsMs = this.use.normalizeDurationsMs(rebased.baseDurationsMs);
      const clockOffset = this.responseClockOffset(payload, timing, false);
      const selectedPhase = this.use.selectedPhaseAfterCommandAcknowledgements(
        this.state.selectedPhase, this.state.pending, validated.commands.acknowledgements, this.state.history
      );
      return {
        selectedPhase, conflicts: this.rejectedSyncAcknowledgements(validated), clockOffset,
        serverHlc: { wallMs: Number(payload.serverHlcWallMs), counter: Number(payload.serverHlcCounter) },
        hlc: this.mergeServerHlc(payload.serverHlcWallMs, payload.serverHlcCounter, clockOffset),
        snapshot: this.use.snapshotValue({
          revision: rebased.revision, serverTime: payload.serverTime,
          canonicalTimer: this.use.clone(canonicalTimer), history: this.use.clone(rebased.baseHistory),
          tasks: this.use.clone(rebased.baseTasks), durationsMs: this.use.clone(durationsMs),
          autoStartBreaks: rebased.baseAutoStartBreaks, selectedTaskId: rebased.baseSelectedTaskId
        })
      };
    }

    syncResponsePersistence(payload, sent, expectedUserId, validated, rebased, next) {
      return {
        expectedUserId, snapshot: next.snapshot, hlc: next.hlc, serverHlc: next.serverHlc,
        clockOffset: next.clockOffset, queueIds: this.acknowledgedQueueIds(validated),
        timerOwnerClaim: {
          deviceId: this.state.deviceId, tabId: this.use.tabId(), nowMs: Date.now(), leaseMs: TIMER_OWNER_LEASE_MS
        },
        retainedQueues: rebased.queues, dropCommandIds: rebased.droppedTimerOperationIds,
        dropTimerIds: rebased.droppedTimerIds, reconciliation: { sent, response: payload, deviceId: this.state.deviceId },
        ...(next.selectedPhase !== this.state.selectedPhase
          ? { settings: this.use.settingsValue({ selectedPhase: next.selectedPhase }) } : {})
      };
    }

    async waitForUnlockedAction() {
      while (this.state.actionLocked) await new Promise((resolve) => this.host.setTimeout(resolve, 0));
    }

    async acceptSyncResponse(payload, sent, expectedUserId, timing) {
      const context = this.use.captureAccountContext();
      if (context.ownerId !== expectedUserId) throw new this.syncStorage.AccountOwnershipError();
      this.syncCore.assertResponseAccount(payload, expectedUserId);
      const validated = this.syncCore.validateCanonicalResponse(payload, sent);
      await this.waitForUnlockedAction();
      context.assertCurrent();
      this.state.actionLocked = true;
      try {
        const rebased = this.syncStorage.reconcileState({
          queues: {
            commands: this.state.pending, taskOperations: this.state.pendingTaskOperations,
            durationOperations: this.state.pendingDurationOperations,
            autoStartOperations: this.state.pendingAutoStartOperations,
            selectedTaskOperations: this.state.pendingSelectedTaskOperations
          },
          sent, response: payload, deviceId: this.state.deviceId
        });
        const next = this.syncResponseState(payload, rebased, validated, timing);
        const input = this.syncResponsePersistence(payload, sent, expectedUserId, validated, rebased, next);
        input.assertCurrent = context.assertCurrent;
        const outcome = await this.syncStorage.applySyncResponse(this.use.database(), input);
        context.assertCurrent();
        await this.use.reloadPersistedState();
        if (outcome.applied) this.state.selectedPhase = next.selectedPhase;
        if (outcome.applied && next.conflicts.length) {
          const conflict = next.conflicts[0];
          this.state.conflict = conflict.reason || `Command outcome: ${conflict.outcome}`;
        }
      } finally {
        this.state.actionLocked = false;
      }
    }
  }

  class SyncCoordinator {
    constructor(state, external, use, reconciler) {
      Object.assign(this, { state, use, reconciler }, external);
      this.syncPromise = null;
      this.syncAgain = false;
      this.syncAgainForce = false;
      this.retryTimer = null;
      this.retryDelayMs = 1000;
      this.receiveRevisionHint = this.receiveRevisionHint.bind(this);
    }

    actions() {
      return bindActions(this, [
        "hasPendingOperations", "syncPreflight", "currentSyncBatch", "syncRequestBody", "syncNow",
        "scheduleSync", "scheduleRetry", "needsBootstrapResolution", "refreshAllPendingOperations",
        "remoteSyncIntervalMs", "retryDelayMsForTest", "resetSyncRetry"
      ]);
    }

    hasPendingOperations() {
      return this.state.pending.length > 0 || this.state.pendingTaskOperations.length > 0
        || this.state.pendingDurationOperations.length > 0 || this.state.pendingAutoStartOperations.length > 0
        || this.state.pendingSelectedTaskOperations.length > 0;
    }

    blockSyncForBootstrap(bootstrapState) {
      this.use.stopCompletionAlert();
      this.use.closeRevisionStream();
      this.state.sessionIdentityValidated = false;
      this.state.bootstrapGatePersisted = true;
      this.state.bootstrapGateOwned = false;
      this.state.bootstrapPending = bootstrapState.resolution;
      this.state.bootstrapBlocked = true;
      this.use.quarantineOwnerState(true);
      this.state.retrying = true;
      this.scheduleRetry();
      this.use.render();
      this.use.renderSyncStatus();
    }

    async refreshAllPendingOperations() {
      const context = this.use.captureAccountContext();
      await this.syncStorage.normalizeLegacyDurationOperations(this.use.database(), context);
      const queues = await this.syncStorage.readSyncState(this.use.database());
      context.assertCurrent();
      this.syncStorage.assertAccountOwnership(queues.snapshot, context.ownerId);
      this.state.pending = (queues.commands || []).sort(this.syncCore.compareTimerCommands);
      this.state.pendingTaskOperations = queues.taskOperations || [];
      this.state.pendingDurationOperations = (queues.durationOperations || []).sort(this.use.compareDurationOperations);
      this.state.pendingAutoStartOperations = queues.autoStartOperations || [];
      this.state.pendingSelectedTaskOperations = queues.selectedTaskOperations || [];
      this.use.rebuildOptimisticState();
    }

    async syncPreflight(force) {
      const context = this.use.captureAccountContext();
      if (!this.state.ready || this.needsBootstrapResolution() || !this.state.sessionIdentityValidated
        || !this.state.authenticated || !this.state.csrfToken || !this.host.navigator.onLine) {
        this.use.renderSyncStatus();
        return false;
      }
      try {
        const bootstrapState = await this.syncStorage.readBootstrapState(this.use.database());
        context.assertCurrent();
        if (bootstrapState.gate || bootstrapState.resolution) {
          this.blockSyncForBootstrap(bootstrapState);
          return false;
        }
      } catch (error) {
        this.state.retrying = true;
        this.use.renderSyncStatus();
        this.scheduleRetry();
        this.host.console.warn("Pomodorough bootstrap gate unavailable:", error);
        return false;
      }
      try {
        await this.refreshAllPendingOperations();
        context.assertCurrent();
      } catch (error) {
        this.state.retrying = true;
        this.use.renderSyncStatus();
        this.scheduleRetry();
        this.host.console.warn("Pomodorough pending queues unavailable:", error);
        return false;
      }
      if (!force && !this.hasPendingOperations()) {
        this.state.retrying = false;
        this.use.renderSyncStatus();
        return false;
      }
      return true;
    }

    currentSyncBatch() {
      return this.syncCore.buildSyncBatch({
        commands: this.state.pending, taskOperations: this.state.pendingTaskOperations,
        durationOperations: this.state.pendingDurationOperations,
        autoStartOperations: this.state.pendingAutoStartOperations,
        selectedTaskOperations: this.state.pendingSelectedTaskOperations
      });
    }

    syncRequestBody(sent) {
      return JSON.stringify({
        deviceId: this.state.deviceId, lastRevision: this.state.revision, commands: sent.commands,
        taskOperations: sent.taskOperations, durationOperations: sent.durationOperations,
        autoStartOperations: sent.autoStartOperations,
        selectedTaskOperations: sent.selectedTaskOperations
      });
    }

    async performSync() {
      const context = this.use.captureAccountContext();
      this.state.syncing = true;
      this.state.retrying = false;
      this.use.renderSyncStatus();
      try {
        const expectedUserId = this.syncCore.accountOwnerId(this.state.user);
        const sent = this.currentSyncBatch();
        this.use.setInFlightDurationOperationIds(sent.durationOperations.map((operation) => operation.id));
        const { response, timing } = await this.use.postMutation(
          "/api/v1/sync", this.syncRequestBody(sent), expectedUserId
        );
        context.assertCurrent();
        if (response.status === 401) {
          this.use.redirectToLogin();
          return;
        }
        if (response.status === 409) throw new this.syncStorage.AccountOwnershipError();
        if (!response.ok) throw new Error(this.use.tr(
          "sync.failed", { status: response.status }, `Sync failed (${response.status}).`
        ));
        const payload = await response.json();
        context.assertCurrent();
        await this.reconciler.acceptSyncResponse(payload, sent, expectedUserId, timing);
        if (this.hasPendingOperations()) this.syncAgain = true;
        this.retryDelayMs = 1000;
        this.state.retrying = false;
      } catch (error) {
        if (error instanceof this.syncStorage.AccountOwnershipError) {
          this.use.queueSessionRevalidation();
          return;
        }
        this.state.retrying = true;
        this.scheduleRetry();
        this.host.console.warn("Pomodorough sync deferred:", error);
      } finally {
        this.use.setInFlightDurationOperationIds([]);
        this.state.syncing = false;
        this.use.render();
      }
    }

    async syncNow(force = false) {
      if (this.syncPromise) {
        this.syncAgain = true;
        this.syncAgainForce ||= force;
        return this.syncPromise;
      }
      if (!await this.syncPreflight(force)) return;
      this.syncPromise = this.performSync();
      try {
        await this.syncPromise;
      } finally {
        this.syncPromise = null;
        const shouldRunAgain = this.syncAgain;
        const runAgainForce = this.syncAgainForce;
        this.syncAgain = false;
        this.syncAgainForce = false;
        if (shouldRunAgain && !this.state.retrying) this.scheduleSync(0, runAgainForce);
      }
    }

    scheduleSync(delayMs = 0, force = false) {
      this.host.clearTimeout(this.retryTimer);
      this.retryTimer = this.host.setTimeout(() => this.syncNow(force), delayMs);
    }

    needsBootstrapResolution() {
      return this.syncCore.requiresBootstrapResolution({
        blocked: this.state.bootstrapBlocked, persistedGate: this.state.bootstrapGatePersisted,
        pending: this.state.bootstrapPending, currentUserId: this.syncCore.accountOwnerId(this.state.user),
        localOwnerId: this.state.localOwnerId
      });
    }

    scheduleRetry() {
      if (!this.host.navigator.onLine) return;
      this.host.clearTimeout(this.retryTimer);
      this.retryTimer = this.host.setTimeout(() => {
        if (this.state.authenticated && this.state.csrfToken && !this.needsBootstrapResolution()) this.syncNow(false);
        else this.use.restoreSessionAndSync();
      }, this.retryDelayMs);
      this.retryDelayMs = Math.min(this.retryDelayMs * 2, RETRY_MAX_MS);
    }

    resetSyncRetry() {
      this.retryDelayMs = 1000;
      this.host.clearTimeout(this.retryTimer);
    }

    receiveRevisionHint({ revision }) {
      if (revision === null || revision > Number(this.state.revision)) this.scheduleSync(0, true);
    }

    installRevisionListener(listen) {
      listen("revision-hint", this.receiveRevisionHint);
    }

    remoteSyncIntervalMs() { return REMOTE_SYNC_INTERVAL_MS; }
    retryDelayMsForTest() { return this.retryDelayMs; }
  }

  function create({ state, external, use, listen }) {
    const reconciler = new SyncResponseReconciler(state, external, use);
    const coordinator = new SyncCoordinator(state, external, use, reconciler);
    const actions = { ...reconciler.actions(), ...coordinator.actions() };
    coordinator.installRevisionListener(listen);
    return actions;
  }

  return Object.freeze({ manifest, create });
});
