(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PomodoroughAppSync = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const accountOperation = typeof module === "object" && module.exports
    ? require("./account-operation.js") : globalThis.PomodoroughAccountOperation;

  function timingMs(name, fallback) {
    try {
      const runtime = typeof globalThis !== "undefined" ? globalThis.PomodoroughAppRuntime : null;
      const value = runtime?.TIMING_MS?.[name] ?? runtime?.timingMs?.(name, fallback);
      if (Number.isFinite(value)) return value;
    } catch { /* timing config never blocks sync */ }
    return fallback;
  }

  const RETRY_MAX_MS = timingMs("retryMax", 60_000);
  const REMOTE_SYNC_INTERVAL_MS = timingMs("remoteSyncInterval", 15_000);
  const TIMER_OWNER_LEASE_MS = timingMs("timerOwnerLease", 60_000);

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
      "resetSyncRetry", "armSavedClaimRecovery", "cancelSavedClaimRecovery",
      "discardSavedClaimRecovery"
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
      const physicalNowMs = this.syncStorage.observeClock({ clockOffset }, { wallMs: Date.now(), monotonicMs: null }).trustedNowMs;
      return this.syncStorage.callWorkspaceCore("hlc.head.v1", { physicalNowMs, observed: [
        { wallMs: this.state.hlcWallMs, counter: this.state.hlcCounter },
        { wallMs: Number(serverWallMs), counter: Number(serverCounter) }
      ] });
    }

    responseClockOffset(payload, timing, cacheable) {
      if (cacheable || !timing) return this.state.clockOffset;
      return this.syncStorage.sampleClock(this.state.clockOffset, payload.serverTime, timing);
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
        ? rebased.baseTimer : this.state.baseTimer?.id ? this.state.baseTimer : null;
      const durationsMs = this.use.clone(rebased.baseDurationsMs);
      const clockOffset = this.responseClockOffset(payload, timing, false);
      const selectedPhase = this.state.selectedPhase;
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

    syncResponsePersistence(payload, sent, expectedUserId, validated, rebased, next, neverSent) {
      return {
        expectedUserId, snapshot: next.snapshot, hlc: next.hlc, serverHlc: next.serverHlc,
        clockOffset: next.clockOffset, queueIds: this.acknowledgedQueueIds(validated),
        timerOwnerClaim: {
          deviceId: this.state.deviceId, tabId: this.use.tabId(), nowMs: Date.now(), leaseMs: TIMER_OWNER_LEASE_MS
        },
        retainedQueues: rebased.queues, dropCommandIds: rebased.droppedTimerOperationIds,
        dropTimerIds: rebased.droppedTimerIds,
        neverSent,
        deliveryProof: this.state.deliveryProof || null,
        reconciliation: {
          sent, response: payload, deviceId: this.state.deviceId,
          neverSent, deliveryProof: this.state.deliveryProof || null
        },
        ...(next.selectedPhase !== this.state.selectedPhase
          ? { settings: this.use.settingsValue({ selectedPhase: next.selectedPhase }) } : {})
      };
    }

    currentQueues() {
      return {
        commands: this.state.pending, taskOperations: this.state.pendingTaskOperations,
        durationOperations: this.state.pendingDurationOperations,
        autoStartOperations: this.state.pendingAutoStartOperations,
        selectedTaskOperations: this.state.pendingSelectedTaskOperations
      };
    }

    neverSentForBatch(local, sent) {
      if (typeof this.syncCore.neverSentForQueues === "function") {
        return this.syncCore.neverSentForQueues(this.state.deliveryProof, local, sent);
      }
      return { commands: [], taskOperations: [], durationOperations: [],
        autoStartOperations: [], selectedTaskOperations: [] };
    }

    isImmutableRecoveryError(error) {
      return /possibly delivered|not causally ordered|device sequence|neverSent|rewrite|overlaps timer history/i
        .test(String(error?.message || ""));
    }

    async waitForUnlockedAction() {
      while (this.state.actionLocked) await new Promise((resolve) => this.host.setTimeout(resolve, timingMs("defer", 0)));
    }

    async acceptSyncResponse(payload, sent, expectedUserId, timing, context, capturedClaim) {
      accountOperation.requireBound(context);
      if (context.ownerId !== expectedUserId) throw new this.syncStorage.AccountOwnershipError();
      this.syncCore.assertResponseAccount(payload, expectedUserId);
      const claim = this.syncStorage.captureSyncClaim(capturedClaim, sent, expectedUserId, this.state.deviceId);
      const validated = this.syncCore.validateCanonicalResponse(payload, sent);
      await this.waitForUnlockedAction();
      context.assertCurrent();
      this.state.actionLocked = true;
      try {
        const local = this.currentQueues();
        const neverSent = this.neverSentForBatch(local, sent);
        let rebased;
        try {
          rebased = this.syncStorage.reconcileState({
            queues: local, sent, response: payload, deviceId: this.state.deviceId,
            neverSent, deliveryProof: this.state.deliveryProof || null,
            projectionPending: this.state.projectionPending
          });
        } catch (error) {
          if (this.isImmutableRecoveryError(error)) {
            this.state.conflict = error.message || "Immutable delivery conflict. Retained work was not rewritten.";
            reportFrontendError(error, "sync.immutable.recovery");
          }
          throw error;
        }
        const next = this.syncResponseState(payload, rebased, validated, timing);
        const input = this.syncResponsePersistence(payload, sent, expectedUserId, validated, rebased, next, neverSent);
        input.capturedClaim = claim;
        input.assertCurrent = context.assertCurrent;
        const outcome = await this.syncStorage.applySyncResponse(this.use.database(), input);
        context.assertCurrent();
        await this.use.reloadPersistedState(null, context);
        context.assertCurrent();
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
      this.syncContext = null;
      this.pendingSync = null;
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
        "remoteSyncIntervalMs", "retryDelayMsForTest", "resetSyncRetry",
        "armSavedClaimRecovery", "cancelSavedClaimRecovery", "discardSavedClaimRecovery"
      ]);
    }

    captureSyncContext(context = this.use.captureAccountContext()) {
      accountOperation.isCurrent(context);
      return context;
    }

    isCurrent(context) {
      return accountOperation.isCurrent(context);
    }

    hasPendingOperations() {
      return this.state.pending.length > 0 || this.state.pendingTaskOperations.length > 0
        || this.state.pendingDurationOperations.length > 0 || this.state.pendingAutoStartOperations.length > 0
        || this.state.pendingSelectedTaskOperations.length > 0;
    }

    blockSyncForBootstrap(bootstrapState, context) {
      context.assertCurrent();
      this.use.stopCompletionAlert();
      this.use.closeRevisionStream();
      this.state.sessionIdentityValidated = false;
      this.state.bootstrapGatePersisted = true;
      this.state.bootstrapGateOwned = false;
      this.state.bootstrapPending = bootstrapState.resolution;
      this.state.bootstrapBlocked = true;
      this.use.quarantineOwnerState(true);
      this.state.retrying = true;
      this.scheduleRetry(context);
      this.use.render();
      this.use.renderSyncStatus();
    }

    async refreshAllPendingOperations(context = this.use.captureAccountContext()) {
      accountOperation.requireBound(context);
      await this.syncStorage.normalizeLegacyDurationOperations(this.use.database(), context);
      context.assertCurrent();
      const queues = await this.syncStorage.readSyncState(this.use.database());
      context.assertCurrent();
      this.syncStorage.assertAccountOwnership(queues.snapshot, context.ownerId);
      this.state.pending = (queues.commands || []).sort(this.syncCore.compareTimerCommands);
      this.state.pendingTaskOperations = queues.taskOperations || [];
      this.state.pendingDurationOperations = (queues.durationOperations || []).sort(this.use.compareDurationOperations);
      this.state.pendingAutoStartOperations = queues.autoStartOperations || [];
      this.state.pendingSelectedTaskOperations = queues.selectedTaskOperations || [];
      this.state.deliveryProof = this.syncStorage.sanitizeDeliveryProof
        ? this.syncStorage.sanitizeDeliveryProof(queues.deliveryProof)
        : queues.deliveryProof || null;
      this.state.canonicalHead = this.syncStorage.sanitizeCanonicalHead
        ? this.syncStorage.sanitizeCanonicalHead(queues.canonicalHead)
        : queues.canonicalHead || null;
      this.state.projectionPending = this.syncStorage.sanitizeProjectionPending
        ? this.syncStorage.sanitizeProjectionPending(queues.projectionPending)
        : queues.projectionPending || null;
      this.state.outgoingSync = queues.outgoing || null;
      this.state.timerDependencies = queues.timerDependencies ?? null;
      this.state.workspaceObservation = queues.workspaceObservation ?? null;
      this.state.completionState = queues.completionState ?? null;
      this.use.rebuildOptimisticState();
    }

    async syncPreflight(force, context = this.captureSyncContext()) {
      if (!this.isCurrent(context)) return false;
      if (!this.state.ready || this.needsBootstrapResolution() || !this.state.sessionIdentityValidated
        || !this.state.authenticated || !this.state.csrfToken || !this.host.navigator.onLine) {
        this.use.renderSyncStatus();
        return false;
      }
      try {
        const bootstrapState = await this.syncStorage.readBootstrapState(this.use.database());
        context.assertCurrent();
        if (bootstrapState.gate || bootstrapState.resolution) {
          this.blockSyncForBootstrap(bootstrapState, context);
          return false;
        }
      } catch (error) {
        if (!this.isCurrent(context)) return false;
        if (error instanceof this.syncStorage.AccountOwnershipError) {
          this.use.queueSessionRevalidation(context);
          return false;
        }
        this.state.retrying = true;
        this.use.renderSyncStatus();
        this.scheduleRetry(context);
        this.host.console.warn("Pomodorough bootstrap gate unavailable:", error);
        reportFrontendError(error, "sync.preflight.bootstrap-gate");
        return false;
      }
      if (!await this.refreshForSync(context)) return false;
      context.assertCurrent();
      if (!force && !this.hasPendingOperations()) {
        this.state.retrying = false;
        this.use.renderSyncStatus();
        return false;
      }
      return true;
    }

    async refreshForSync(context) {
      try {
        await this.refreshAllPendingOperations(context);
        context.assertCurrent();
        return true;
      } catch (error) {
        if (!this.isCurrent(context)) return false;
        if (error instanceof this.syncStorage.AccountOwnershipError) {
          this.use.queueSessionRevalidation(context);
          return false;
        }
        this.state.retrying = true;
        this.use.renderSyncStatus();
        this.scheduleRetry(context);
        this.host.console.warn("Pomodorough pending queues unavailable:", error);
        reportFrontendError(error, "sync.preflight.pending-queues");
        return false;
      }
    }

    currentSyncBatch() {
      if (this.state.outgoingSync?.sent) return this.state.outgoingSync.sent;
      return this.syncStorage.selectWorkspaceBatch({
        commands: this.state.pending, taskOperations: this.state.pendingTaskOperations,
        durationOperations: this.state.pendingDurationOperations,
        autoStartOperations: this.state.pendingAutoStartOperations,
        selectedTaskOperations: this.state.pendingSelectedTaskOperations, timerDependencies: this.state.timerDependencies
      }, this.state.deviceId).sent;
    }

    syncRequestBody(sent) {
      return JSON.stringify({
        deviceId: this.state.deviceId, lastRevision: this.state.revision, commands: sent.commands,
        taskOperations: sent.taskOperations, durationOperations: sent.durationOperations,
        autoStartOperations: sent.autoStartOperations,
        selectedTaskOperations: sent.selectedTaskOperations
      });
    }

    async retireProofForBatch(sent, context) {
      this.verifyOutgoingExactness(sent);
      const retired = await this.syncStorage.retireProofAndPersistOutgoing(this.use.database(), sent, context);
      context.assertCurrent();
      this.state.deliveryProof = retired.proof;
      this.state.outgoingSync = { sent: this.syncStorage.cloneOutgoing
        ? this.syncStorage.cloneOutgoing(sent) : JSON.parse(JSON.stringify(sent)) };
    }

    async submitSyncBatch(sent, expectedUserId, context, capturedClaim) {
      context.assertCurrent();
      const claim = this.syncStorage.captureSyncClaim(capturedClaim, sent, expectedUserId, this.state.deviceId);
      this.use.setInFlightDurationOperationIds(sent.durationOperations.map((operation) => operation.id));
      const { response, timing } = await this.use.postMutation(
        "/api/v1/sync", claim.body, expectedUserId, context
      );
      context.assertCurrent();
      if (response.status === 401) {
        this.use.redirectToLogin();
        return;
      }
      if (response.status === 409) {
        const conflict = typeof response.json === "function"
          ? await response.json().catch(() => ({}))
          : {};
        context.assertCurrent();
        if (conflict && conflict.error === "account incarnation changed") {
          throw new this.syncStorage.AccountOwnershipError();
        }
        throw new Error(this.use.tr(
          "sync.failed", { status: response.status }, `Sync failed (${response.status}).`
        ));
      }
      if (!response.ok) throw new Error(this.use.tr(
        "sync.failed", { status: response.status }, `Sync failed (${response.status}).`
      ));
      const payload = await response.json();
      context.assertCurrent();
      await this.reconciler.acceptSyncResponse(payload, sent, expectedUserId, timing, context, claim);
      context.assertCurrent();
      if (this.hasPendingOperations()) this.syncAgain = true;
      this.retryDelayMs = 1000;
      this.state.retrying = false;
    }

    reportSyncError(error, context) {
      if (!this.isCurrent(context)) return;
      if (this.reconciler.isImmutableRecoveryError
        && this.reconciler.isImmutableRecoveryError(error)) {
        this.state.retrying = true;
        this.scheduleRetry(context);
        this.host.console.warn("Pomodorough immutable sync needs recovery:", error);
        reportFrontendError(error, "sync.immutable.recovery");
        return;
      }
      this.state.retrying = true;
      this.scheduleRetry(context);
      this.host.console.warn("Pomodorough sync deferred:", error);
      reportFrontendError(error, "sync.deferred");
    }

    async performSync(context = this.captureSyncContext()) {
      context = this.captureSyncContext(context);
      if (!this.isCurrent(context)) return;
      this.state.syncing = true;
      this.state.retrying = false;
      this.use.renderSyncStatus();
      try {
        const expectedUserId = context.ownerId;
        const result = await this.syncStorage.claimWorkspaceBatch(this.use.database(), {
          ...context, deviceId: this.state.deviceId, localNowMs: Date.now()
        });
        context.assertCurrent();
        if (!["planned", "replay_saved"].includes(result.plan.status) || !result.claim?.body) {
          if (result.plan.status === "oversized_saved") {
            this.state.savedClaimRecovery = null;
            this.state.conflict = "Saved sync request exceeds Core limits. Possibly delivered work remains blocked and unchanged.";
          } else if (result.plan.status === "blocked_dependency") {
            this.state.savedClaimRecovery = null;
            this.state.conflict = "Sync is waiting for a retained command acknowledgement.";
          } else if (result.claim?.sent) {
            const queues = this.recoveryQueues(result.claim);
            const names = this.syncStorage.savedClaimRecoveryQueues
              ? this.syncStorage.savedClaimRecoveryQueues(result.claim, queues) : [];
            this.state.savedClaimRecovery = { queues: names, armed: false };
            this.state.conflict = this.syncStorage.savedClaimRecoveryMessage
              ? this.syncStorage.savedClaimRecoveryMessage(result.claim, this.use.tr.bind(this.use), queues)
              : "Saved sync request lacks original request bytes. Retained work needs recovery.";
          } else {
            this.state.savedClaimRecovery = null;
            this.state.conflict = "Saved sync request lacks original request bytes. Retained work needs recovery.";
          }
          throw new Error(this.state.conflict);
        }
        const sent = result.claim.sent;
        this.state.deliveryProof = result.proof;
        this.state.outgoingSync = result.claim;
        if (result.timerDependencies != null) this.state.timerDependencies = result.timerDependencies;
        this.use.rebuildOptimisticState();
        context.assertCurrent();
        await this.submitSyncBatch(sent, expectedUserId, context, result.claim);
      } catch (error) {
        if (!this.isCurrent(context)) return;
        if (error instanceof this.syncStorage.AccountOwnershipError) {
          this.use.queueSessionRevalidation(context);
          return;
        }
        this.reportSyncError(error, context);
      } finally {
        this.use.setInFlightDurationOperationIds([]);
        this.state.syncing = false;
        if (this.isCurrent(context)) this.use.render();
      }
    }

    recoveryQueues(saved) {
      return {
        commands: this.state.pending || [],
        taskOperations: this.state.pendingTaskOperations || [],
        durationOperations: this.state.pendingDurationOperations || [],
        autoStartOperations: this.state.pendingAutoStartOperations || [],
        selectedTaskOperations: this.state.pendingSelectedTaskOperations || []
      };
    }

    armSavedClaimRecovery() {
      if (!this.state.savedClaimRecovery) throw new Error("No unrecoverable saved claim needs recovery.");
      this.state.savedClaimRecovery.armed = true;
      this.use.render();
      this.use.renderSyncStatus();
    }

    cancelSavedClaimRecovery() {
      if (!this.state.savedClaimRecovery) return;
      this.state.savedClaimRecovery.armed = false;
      this.use.render();
      this.use.renderSyncStatus();
    }

    async discardSavedClaimRecovery(context = this.use.captureAccountContext()) {
      if (this.state.savedClaimRecovery?.armed !== true) {
        throw new Error("Discarding the unrecoverable saved claim requires explicit confirmation.");
      }
      const result = await this.syncStorage.discardUnrecoverableSavedClaim(this.use.database(), {
        ...context, deviceId: this.state.deviceId, localNowMs: Date.now(), confirmed: true
      });
      context.assertCurrent();
      this.state.savedClaimRecovery = null;
      this.state.conflict = null;
      this.state.deliveryProof = result.proof ?? this.state.deliveryProof;
      this.state.outgoingSync = result.claim;
      await this.use.reloadPersistedState(null, context);
      context.assertCurrent();
      this.use.render();
      this.use.renderSyncStatus();
      return result;
    }

    verifyOutgoingExactness(sent) {
      const outgoing = this.state.outgoingSync;
      if (!outgoing?.sent || typeof this.syncStorage.outgoingMatchesStored !== "function") return;
      if (!this.syncStorage.outgoingMatchesStored(outgoing, sent)) {
        throw new Error("Outgoing payload changed under an existing identity. Recovery is required.");
      }
    }

    syncNow(force = false, context = null) {
      context = this.captureSyncContext(context || undefined);
      if (!this.isCurrent(context)) return Promise.resolve();
      if (this.pendingSync && this.isCurrent(this.pendingSync.context)) {
        this.pendingSync.force ||= force;
        return this.pendingSync.promise;
      }
      if (this.syncPromise) {
        if (!this.isCurrent(this.syncContext)) return this.queueSyncCaller(force, context);
        this.syncAgain = true;
        this.syncAgainForce ||= force;
        return this.syncPromise;
      }
      // Reserve the whole operation before preflight can yield or reenter syncNow.
      const operation = Promise.resolve().then(async () => {
        try {
          context.assertCurrent();
          if (await this.syncPreflight(force, context)) {
            context.assertCurrent();
            await this.performSync(context);
          }
        } catch (error) {
          if (error.name !== "AccountOwnershipError") throw error;
        }
      }).finally(() => {
        if (this.syncPromise !== operation) return;
        this.syncPromise = null;
        this.syncContext = null;
        const shouldRunAgain = this.syncAgain;
        const runAgainForce = this.syncAgainForce;
        this.syncAgain = false;
        this.syncAgainForce = false;
        if (shouldRunAgain && !this.state.retrying) this.scheduleSync(0, runAgainForce, context);
      });
      this.syncContext = context;
      this.syncPromise = operation;
      return operation;
    }

    queueSyncCaller(force, context) {
      const request = { force, context, promise: null };
      const resume = () => {
        if (this.pendingSync === request) this.pendingSync = null;
        if (!this.isCurrent(request.context)) return;
        return this.syncNow(request.force, request.context);
      };
      // Only this invocation authorizes the new scope. The prior operation
      // releases its own guard before this caller-owned continuation starts.
      request.promise = this.syncPromise.then(resume, resume);
      this.pendingSync = request;
      return request.promise;
    }

    scheduleSync(delayMs = 0, force = false, context = null) {
      context = this.captureSyncContext(context || undefined);
      if (!this.isCurrent(context)) return;
      this.host.clearTimeout(this.retryTimer);
      this.retryTimer = this.host.setTimeout(() => {
        if (this.isCurrent(context)) return this.syncNow(force, context);
      }, delayMs);
    }

    needsBootstrapResolution() {
      return this.syncCore.requiresBootstrapResolution({
        blocked: this.state.bootstrapBlocked, persistedGate: this.state.bootstrapGatePersisted,
        pending: this.state.bootstrapPending, currentUserId: this.syncCore.accountOwnerId(this.state.user),
        localOwnerId: this.state.localOwnerId
      });
    }

    scheduleRetry(context = this.captureSyncContext()) {
      context = this.captureSyncContext(context);
      if (!this.isCurrent(context)) return;
      if (!this.host.navigator.onLine) return;
      this.host.clearTimeout(this.retryTimer);
      this.retryTimer = this.host.setTimeout(() => {
        if (!this.isCurrent(context)) return;
        if (this.state.authenticated && this.state.csrfToken && !this.needsBootstrapResolution()) return this.syncNow(false, context);
        return this.use.restoreSessionAndSync(context);
      }, this.retryDelayMs);
      this.retryDelayMs = Math.min(this.retryDelayMs * 2, RETRY_MAX_MS);
    }

    resetSyncRetry() {
      this.retryDelayMs = timingMs("retryInitial", 1000);
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
