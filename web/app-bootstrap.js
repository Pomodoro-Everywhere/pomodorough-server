(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PomodoroughAppBootstrap = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const BOOTSTRAP_LEASE_MS = 5 * 60_000;
  const TIMER_OWNER_LEASE_MS = 60_000;
  const ACK_SUCCESS = new Set(["accepted", "acknowledged", "applied", "duplicate", "ok"]);

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
    name: "bootstrap",
    externals: ["host", "syncCore", "syncStorage", "elements"],
    requires: [
      "captureAccountContext",
      "database", "tabId", "refreshMigratedPreferences", "acquireBootstrapGate",
      "defaultDurationsMs", "responseClockOffset", "mergeServerHlc", "clone", "normalizeTimer",
      "emptyTimer", "normalizeDurationsMs", "tr", "reloadPersistedState", "resetSyncRetry",
      "render", "renderBootstrapDialog", "showNotice", "openRevisionStream", "hasPendingOperations",
      "scheduleSync", "syncNow", "scheduleRetry", "postMutation", "redirectToLogin",
      "queueSessionRevalidation", "refreshAllPendingOperations"
    ],
    provides: [
      "restartBootstrapForCurrentAccount", "queueBootstrapPreparation", "loadBootstrapPreview",
      "localBootstrapState", "persistBootstrapResolution", "handleResolutionLimit",
      "bootstrapConflicts", "bootstrapResponseState", "resetBootstrapState",
      "acceptBootstrapResponse", "validateBootstrapSubmission", "recoverInvalidBootstrapSubmission",
      "sendBootstrapResolution", "submitBootstrapResolution", "retryBootstrapResolution",
      "chooseBootstrapStrategy", "prepareBootstrap", "resumeNormalSyncFromBootstrap",
      "bootstrapPreparationPaused", "reconcileBootstrapAccount", "deferBootstrapPreparation",
      "acquireBootstrapPreparationGate", "submitMatchingBootstrapResolution",
      "reconcilePersistedBootstrapState", "buildBootstrapPlan", "prepareBootstrapPlan",
      "persistAutomaticBootstrapResolution", "prepareBootstrapOnce"
    ],
    emits: [],
    listens: []
  });

  class BootstrapSubmission {
    constructor(state, external, use) {
      Object.assign(this, { state, use, preparation: null }, external);
    }

    actions() {
      return bindActions(this, [
        "restartBootstrapForCurrentAccount", "queueBootstrapPreparation", "loadBootstrapPreview",
        "localBootstrapState", "persistBootstrapResolution", "handleResolutionLimit",
        "bootstrapConflicts", "bootstrapResponseState", "resetBootstrapState",
        "acceptBootstrapResponse", "validateBootstrapSubmission", "recoverInvalidBootstrapSubmission",
        "sendBootstrapResolution", "submitBootstrapResolution", "retryBootstrapResolution",
        "chooseBootstrapStrategy"
      ]);
    }

    async restartBootstrapForCurrentAccount() {
      if (!this.syncCore.accountOwnerId(this.state.user)) return;
      const context = this.use.captureAccountContext();
      const restarted = await this.syncStorage.invalidateForeignResolution(this.use.database(), {
        ...context, accountBinding: this.state.authenticatedAccountBinding,
        currentUserId: this.syncCore.accountOwnerId(this.state.user), gateToken: this.use.tabId(), nowMs: Date.now(),
        leaseMs: BOOTSTRAP_LEASE_MS
      });
      if (restarted.acquired && !restarted.resolution) {
        restarted.legacyAutoStartMigration = await this.syncStorage.migrateLegacyAutoStart(this.use.database(), {
          ...context, operationId: this.host.crypto.randomUUID(), nowMs: Date.now()
        });
        restarted.legacySelectedTaskMigration = await this.syncStorage.migrateLegacySelectedTask(this.use.database(), {
          ...context, operationId: this.host.crypto.randomUUID(), nowMs: Date.now()
        });
        await this.use.refreshMigratedPreferences(restarted);
      }
      context.assertCurrent();
      Object.assign(this.state, {
        bootstrapOwnershipConfirmation: false, bootstrapOwnershipApproved: false,
        bootstrapPending: restarted.resolution, bootstrapPreview: null, bootstrapPlan: null,
        bootstrapStrategy: null, bootstrapError: null, bootstrapLimitError: null,
        bootstrapConflict: false, bootstrapBlocked: true, bootstrapGatePersisted: true,
        bootstrapGateOwned: restarted.acquired
      });
    }

    queueBootstrapPreparation() {
      this.host.setTimeout(() => this.preparation.prepareBootstrap().catch((error) => {
        this.state.retrying = true;
        this.use.scheduleRetry();
        this.host.console.warn("Pomodorough bootstrap restart deferred:", error);
        reportFrontendError(error, "bootstrap.restart.deferred");
      }), 0);
    }

    async loadBootstrapPreview() {
      const context = this.use.captureAccountContext();
      const requestSequence = await this.syncStorage.allocateClockRequestSequence(this.use.database(), context);
      const requestAtMs = Date.now();
      const response = await this.host.fetch("/api/v1/bootstrap", {
        credentials: "same-origin", cache: "no-store", headers: this.syncCore.accountHeaders(context.ownerId)
      });
      const receivedAtMs = Date.now();
      context.assertCurrent();
      if (response.status === 401) {
        this.use.redirectToLogin();
        return;
      }
      if (!response.ok) throw new Error(this.use.tr(
        "bootstrap.failed", { status: response.status }, `Bootstrap failed (${response.status}).`
      ));
      const payload = await response.json();
      context.assertCurrent();
      this.syncCore.assertResponseAccount(payload, context.ownerId);
      this.syncCore.validateCanonicalResponse(payload, {
        commands: [], taskOperations: [], durationOperations: [], autoStartOperations: [],
        selectedTaskOperations: []
      });
      const clockOffset = await this.syncStorage.saveClockOffset(
        this.use.database(),
        this.syncCore.serverClockOffset(payload.serverTime, requestAtMs, receivedAtMs, requestSequence), context
      );
      context.assertCurrent();
      this.state.clockOffset = clockOffset;
      return payload;
    }

    localBootstrapState() {
      const local = this.state.quarantinedLocal || this.state;
      return {
        history: local.history, timer: local.timer, tasks: local.tasks,
        durationsMs: local.durationsMs, autoStartBreaks: local.autoStartBreaks,
        selectedTaskId: local.selectedTaskId, defaultDurationsMs: this.use.defaultDurationsMs(),
        commands: local.pending, taskOperations: local.pendingTaskOperations,
        durationOperations: local.pendingDurationOperations,
        autoStartOperations: local.pendingAutoStartOperations,
        selectedTaskOperations: local.pendingSelectedTaskOperations
      };
    }

    async persistBootstrapResolution(strategy, replaceExisting = false) {
      const context = this.use.captureAccountContext();
      if (this.state.bootstrapOwnershipConfirmation
        && (!this.state.bootstrapOwnershipApproved || strategy !== this.state.bootstrapPlan.strategy)) {
        throw new this.syncStorage.AccountOwnershipError();
      }
      if (!this.syncCore.isResolutionStrategy(strategy)) {
        throw new this.syncStorage.BootstrapGateError("History resolution changed in another tab.");
      }
      const lease = await this.use.acquireBootstrapGate();
      if (!lease.acquired) throw new this.syncStorage.BootstrapGateError("Another tab owns history resolution.");
      await this.use.refreshMigratedPreferences(lease);
      const pending = await this.syncStorage.captureResolution(this.use.database(), {
        userId: this.syncCore.accountOwnerId(this.state.user), requestId: this.host.crypto.randomUUID(), deviceId: this.state.deviceId,
        expectedRevision: this.state.bootstrapPreview.revision, strategy
      }, { ...context, replaceExisting, gateToken: this.use.tabId() });
      context.assertCurrent();
      Object.assign(this.state, {
        bootstrapPending: pending, bootstrapGatePersisted: true, bootstrapGateOwned: true,
        bootstrapStrategy: strategy, bootstrapConflict: false,
        bootstrapError: null, bootstrapLimitError: null
      });
      return pending;
    }

    handleResolutionLimit(error) {
      if (!(error instanceof this.syncStorage.ResolutionLimitError)) return false;
      this.state.bootstrapSubmitting = false;
      this.state.bootstrapError = null;
      this.state.bootstrapLimitError = error.message;
      this.state.bootstrapStrategy = null;
      this.state.bootstrapFocusTarget = this.elements.bootstrapChoiceButtons.find(
        (button) => button.dataset.bootstrapStrategy === "keep_remote"
      );
      this.use.render();
      return true;
    }

    bootstrapConflicts(validated) {
      return validated.commands.acknowledgements.concat(
        validated.tasks.acknowledgements, validated.durations.acknowledgements,
        validated.autoStart.acknowledgements, validated.selectedTask.acknowledgements
      ).filter((acknowledgement) => {
        const outcome = String(acknowledgement.outcome || "").toLowerCase();
        return outcome && !ACK_SUCCESS.has(outcome) && outcome !== "ignored";
      });
    }

    bootstrapResponseState(payload, pending, timing, validated) {
      const local = this.state.quarantinedLocal || this.state;
      const applied = this.syncStorage.reconcileResolutionState({
        queues: {
          commands: local.pending, taskOperations: local.pendingTaskOperations,
          durationOperations: local.pendingDurationOperations,
          autoStartOperations: local.pendingAutoStartOperations,
          selectedTaskOperations: local.pendingSelectedTaskOperations
        },
        pendingResolution: pending, response: payload, deviceId: pending.payload.deviceId
      });
      const revision = Number(applied.revision);
      if (!Number.isFinite(revision) || revision < 0) throw new Error(this.use.tr(
        "bootstrap.missingRevision", {}, "Bootstrap response omitted revision."
      ));
      const durationsMs = this.use.normalizeDurationsMs(applied.baseDurationsMs);
      const clockOffset = this.use.responseClockOffset(payload, timing, true);
      return {
        local, validated,
        snapshot: {
          revision, serverTime: payload.serverTime,
          canonicalTimer: this.use.clone(applied.baseTimer ? this.use.normalizeTimer(applied.baseTimer)
            : this.use.emptyTimer(this.state.selectedPhase, durationsMs[this.state.selectedPhase])),
          history: this.use.clone(applied.baseHistory), tasks: this.use.clone(applied.baseTasks),
          durationsMs: this.use.clone(durationsMs), autoStartBreaks: applied.baseAutoStartBreaks,
          selectedTaskId: applied.baseSelectedTaskId, user: this.use.clone(this.state.user)
        },
        clockOffset,
        serverHlc: { wallMs: Number(payload.serverHlcWallMs), counter: Number(payload.serverHlcCounter) },
        hlc: this.use.mergeServerHlc(payload.serverHlcWallMs, payload.serverHlcCounter, clockOffset)
      };
    }

    resetBootstrapState() {
      Object.assign(this.state, {
        bootstrapOwnershipConfirmation: false, bootstrapOwnershipApproved: false,
        localOwnerId: this.syncCore.accountOwnerId(this.state.user), bootstrapPending: null, bootstrapPreview: null,
        bootstrapPlan: null, bootstrapStrategy: null, bootstrapError: null,
        bootstrapConflict: false, bootstrapBlocked: false, bootstrapLimitError: null,
        bootstrapGatePersisted: false, bootstrapGateOwned: false,
        quarantinedLocal: null, retrying: false
      });
      this.use.resetSyncRetry();
    }

    async waitForUnlockedAction() {
      while (this.state.actionLocked) await new Promise((resolve) => this.host.setTimeout(resolve, 0));
    }

    async acceptBootstrapResponse(payload, pending, timing) {
      const context = this.use.captureAccountContext();
      if (context.ownerId !== pending.userId) throw new this.syncStorage.AccountOwnershipError();
      this.syncCore.assertResponseAccount(payload, pending.userId);
      const validated = this.syncCore.validateCanonicalResponse(payload, pending.payload);
      await this.waitForUnlockedAction();
      context.assertCurrent();
      this.state.actionLocked = true;
      try {
        const next = this.bootstrapResponseState(payload, pending, timing, validated);
        const queueIds = pending.queueIds || {
          commands: [], taskOperations: [], durationOperations: [], autoStartOperations: [],
          selectedTaskOperations: []
        };
        const outcome = await this.syncStorage.applyResolution(this.use.database(), { ...pending, queueIds }, {
          assertCurrent: context.assertCurrent,
          snapshot: next.snapshot, hlc: next.hlc, serverHlc: next.serverHlc,
          clockOffset: next.clockOffset,
          timerOwnerClaim: {
            deviceId: this.state.deviceId, tabId: this.use.tabId(), nowMs: Date.now(),
            leaseMs: TIMER_OWNER_LEASE_MS
          },
          reconciliation: {
            sent: pending.payload, response: payload, deviceId: pending.payload.deviceId
          }
        });
        context.assertCurrent();
        await this.use.reloadPersistedState();
        this.resetBootstrapState();
        const conflicts = this.bootstrapConflicts(next.validated);
        if (outcome.applied && conflicts.length) {
          this.state.conflict = conflicts[0].reason || `Operation outcome: ${conflicts[0].outcome}`;
        }
      } finally {
        this.state.actionLocked = false;
      }
      this.use.render();
      this.use.openRevisionStream();
      if (this.use.hasPendingOperations()) this.use.scheduleSync(0);
    }

    async validateBootstrapSubmission(pending) {
      const context = this.use.captureAccountContext();
      let current = pending;
      if (this.state.bootstrapGateOwned) {
        const normalized = await this.syncStorage.normalizeLegacyDurationOperations(this.use.database(), {
          ...context,
          gateToken: this.use.tabId(), replacementRequestId: this.host.crypto.randomUUID()
        });
        context.assertCurrent();
        current = normalized.resolution || current;
        this.state.bootstrapPending = current;
      }
      await this.syncStorage.validatePendingForSend(this.use.database(), {
        ...context,
        pending: current, currentUserId: this.syncCore.accountOwnerId(this.state.user), gateToken: this.use.tabId(),
        nowMs: Date.now(), leaseMs: BOOTSTRAP_LEASE_MS
      });
      return current;
    }

    async recoverInvalidBootstrapSubmission() {
      const context = this.use.captureAccountContext();
      const persisted = await this.syncStorage.readBootstrapState(this.use.database());
      context.assertCurrent();
      if (!this.syncCore.pendingMatchesUser(persisted.resolution, this.syncCore.accountOwnerId(this.state.user))) {
        this.use.queueSessionRevalidation();
        return;
      }
      this.state.bootstrapPending = persisted.resolution;
      this.state.bootstrapGateOwned = false;
      this.queueBootstrapPreparation();
    }

    async sendBootstrapResolution(pending) {
      const context = this.use.captureAccountContext();
      const body = JSON.stringify(pending.payload);
      const { response, timing } = await this.use.postMutation(
        "/api/v1/bootstrap/resolve", body, pending.userId
      );
      context.assertCurrent();
      if (response.status === 401) {
        this.use.redirectToLogin();
        return;
      }
      if (response.status === 409) {
        const conflict = await response.json().catch(() => ({}));
        context.assertCurrent();
        if (conflict.error === "account incarnation changed") {
          this.use.queueSessionRevalidation();
          return;
        }
        this.state.bootstrapConflict = true;
        this.state.bootstrapError = conflict.error === "request ID conflict"
          ? "This resolution ID was already used. Retry with a fresh remote snapshot."
          : "Remote history changed before this choice was applied. Retry with the latest snapshot.";
        this.state.bootstrapFocusTarget = this.elements.bootstrapRetry;
        return;
      }
      if (!response.ok) throw new Error(this.use.tr(
        "bootstrap.resolutionFailed", { status: response.status },
        `History resolution failed (${response.status}).`
      ));
      const payload = await response.json();
      context.assertCurrent();
      await this.acceptBootstrapResponse(payload, pending, timing);
    }

    async submitBootstrapResolution() {
      if (this.state.bootstrapSubmitting || !this.state.bootstrapPending || !this.host.navigator.onLine) return;
      let pending = this.state.bootstrapPending;
      if (!this.syncCore.pendingResolutionCanSubmit(pending, this.syncCore.accountOwnerId(this.state.user))) {
        this.use.queueSessionRevalidation();
        return;
      }
      try {
        pending = await this.validateBootstrapSubmission(pending);
      } catch {
        await this.recoverInvalidBootstrapSubmission();
        return;
      }
      this.state.bootstrapSubmitting = true;
      this.state.bootstrapError = null;
      this.use.renderBootstrapDialog();
      try {
        await this.sendBootstrapResolution(pending);
      } catch (error) {
        if (!this.syncCore.pendingMatchesUser(this.state.bootstrapPending, this.syncCore.accountOwnerId(this.state.user))) {
          this.state.bootstrapError = null;
          this.queueBootstrapPreparation();
          return;
        }
        this.state.bootstrapError = `${error.message || "History resolution was interrupted."} Retry sends the exact saved request.`;
        this.state.bootstrapFocusTarget = this.elements.bootstrapRetry;
        this.host.console.warn("Pomodorough bootstrap resolution deferred:", error);
        reportFrontendError(error, "bootstrap.resolution.deferred");
      } finally {
        this.state.bootstrapSubmitting = false;
        this.use.render();
      }
    }

    async retryBootstrapResolution() {
      if (this.state.bootstrapSubmitting) return;
      try {
        if (this.state.bootstrapConflict) {
          const strategy = this.state.bootstrapStrategy || this.state.bootstrapPending?.payload?.strategy;
          if (!this.syncCore.isResolutionStrategy(strategy)) {
            this.use.queueSessionRevalidation();
            return;
          }
          this.state.bootstrapSubmitting = true;
          this.use.renderBootstrapDialog();
          this.state.bootstrapPreview = await this.loadBootstrapPreview();
          await this.persistBootstrapResolution(strategy, true);
          this.state.bootstrapSubmitting = false;
        }
        await this.submitBootstrapResolution();
      } catch (error) {
        if (this.handleResolutionLimit(error)) return;
        this.state.bootstrapSubmitting = false;
        this.state.bootstrapError = error.message || "History resolution could not be retried.";
        this.state.bootstrapFocusTarget = this.elements.bootstrapRetry;
        this.use.renderBootstrapDialog();
      }
    }

    async chooseBootstrapStrategy(strategy, confirmed = false) {
      if (this.state.bootstrapSubmitting || this.state.bootstrapPending) return;
      if (this.state.bootstrapLimitError && strategy !== "keep_remote") return;
      if (this.state.bootstrapOwnershipConfirmation && strategy !== this.state.bootstrapPlan?.strategy) return;
      const selectionMode = this.state.bootstrapLimitError || this.state.bootstrapOwnershipConfirmation
        ? "choose" : this.state.bootstrapPlan?.mode;
      if (!this.syncCore.canSubmitResolution(selectionMode, confirmed)) {
        this.state.bootstrapStrategy = strategy;
        this.state.bootstrapFocusTarget = this.elements.bootstrapConfirm;
        this.use.renderBootstrapDialog();
        return;
      }
      this.state.bootstrapOwnershipApproved = confirmed;
      this.state.bootstrapSubmitting = true;
      this.use.renderBootstrapDialog();
      try {
        await this.persistBootstrapResolution(strategy);
      } catch (error) {
        if (this.handleResolutionLimit(error)) return;
        this.use.showNotice(error.message || this.use.tr(
          "notice.historyChoiceFailed", {}, "History choice could not be saved."
        ));
        this.state.bootstrapFocusTarget = this.elements.bootstrapConfirm;
        this.state.bootstrapSubmitting = false;
        this.use.renderBootstrapDialog();
        return;
      }
      this.state.bootstrapSubmitting = false;
      await this.submitBootstrapResolution();
    }
  }

  class BootstrapPreparation {
    constructor(state, external, use, submission) {
      Object.assign(this, { state, use, submission }, external);
      this.bootstrapPromise = null;
    }

    actions() {
      return bindActions(this, [
        "prepareBootstrap", "resumeNormalSyncFromBootstrap", "bootstrapPreparationPaused",
        "reconcileBootstrapAccount", "deferBootstrapPreparation", "acquireBootstrapPreparationGate",
        "submitMatchingBootstrapResolution", "reconcilePersistedBootstrapState", "buildBootstrapPlan",
        "prepareBootstrapPlan", "persistAutomaticBootstrapResolution", "prepareBootstrapOnce"
      ]);
    }

    async prepareBootstrap() {
      if (this.bootstrapPromise) return this.bootstrapPromise;
      this.bootstrapPromise = this.prepareBootstrapOnce();
      try { return await this.bootstrapPromise; } finally { this.bootstrapPromise = null; }
    }

    async resumeNormalSyncFromBootstrap(persisted) {
      await this.use.reloadPersistedState(persisted);
      const context = this.use.captureAccountContext();
      this.state.quarantinedLocal = null;
      await this.syncStorage.clearBootstrapGate(this.use.database(), this.use.tabId(), context);
      context.assertCurrent();
      Object.assign(this.state, {
        bootstrapPending: null, bootstrapGatePersisted: false,
        bootstrapGateOwned: false, bootstrapBlocked: false, retrying: false
      });
      this.use.render();
      await this.use.syncNow(true);
      this.use.openRevisionStream();
    }

    bootstrapPreparationPaused() {
      return Boolean(this.state.bootstrapError || this.state.bootstrapLimitError
        || this.state.bootstrapOwnershipConfirmation && !this.state.bootstrapPending
        || this.state.bootstrapPlan?.mode === "choose" && !this.state.bootstrapPending);
    }

    async reconcileBootstrapAccount() {
      const currentUserId = this.syncCore.accountOwnerId(this.state.user);
      const pendingMatches = !this.state.bootstrapPending
        || this.syncCore.pendingMatchesUser(this.state.bootstrapPending, currentUserId);
      const needsAccountHandoff = !this.state.bootstrapGateOwned
        && this.state.localOwnerId && this.state.localOwnerId !== currentUserId;
      if (pendingMatches && !needsAccountHandoff) return false;
      if (!this.state.sessionIdentityValidated) {
        this.use.queueSessionRevalidation();
        return true;
      }
      try {
        await this.submission.restartBootstrapForCurrentAccount();
      } catch (error) {
        if (!(error instanceof this.syncStorage.AccountOwnershipError)) throw error;
        this.use.queueSessionRevalidation();
        return true;
      }
      return false;
    }

    deferBootstrapPreparation() {
      this.state.retrying = true;
      this.use.scheduleRetry();
      this.use.render();
    }

    async acquireBootstrapPreparationGate() {
      if (this.state.bootstrapGateOwned) return false;
      const context = this.use.captureAccountContext();
      const lease = await this.use.acquireBootstrapGate();
      context.assertCurrent();
      if (!lease.acquired) {
        this.deferBootstrapPreparation();
        return true;
      }
      this.state.bootstrapGateOwned = true;
      this.state.bootstrapGatePersisted = true;
      await this.use.refreshMigratedPreferences(lease);
      context.assertCurrent();
      if (lease.resolution) this.state.bootstrapPending = lease.resolution;
      if (this.state.bootstrapPending
        && !this.syncCore.pendingResolutionCanSubmit(this.state.bootstrapPending, this.syncCore.accountOwnerId(this.state.user))) {
        if (!this.state.sessionIdentityValidated) {
          this.use.queueSessionRevalidation();
          return true;
        }
        await this.submission.restartBootstrapForCurrentAccount();
      }
      if (this.state.bootstrapPending) return false;
      const persisted = await this.syncStorage.readSyncState(this.use.database());
      context.assertCurrent();
      if (this.syncCore.accountOwnerId(persisted.snapshot?.user) === this.syncCore.accountOwnerId(this.state.user)) {
        await this.resumeNormalSyncFromBootstrap(persisted);
        return true;
      }
      if (this.syncCore.accountOwnerId(persisted.snapshot?.user)) this.state.localOwnerId = this.syncCore.accountOwnerId(persisted.snapshot.user);
      return false;
    }

    async submitMatchingBootstrapResolution() {
      if (this.state.bootstrapPending?.userId !== this.syncCore.accountOwnerId(this.state.user)) return false;
      this.state.bootstrapStrategy = this.state.bootstrapPending.payload.strategy;
      await this.submission.submitBootstrapResolution();
      return true;
    }

    async reconcilePersistedBootstrapState() {
      const context = this.use.captureAccountContext();
      if (this.state.bootstrapPending || !this.syncCore.canExposeOwnerState({
        sessionValidated: this.state.sessionIdentityValidated, localOwnerId: this.state.localOwnerId,
        currentUserId: this.syncCore.accountOwnerId(this.state.user)
      })) return false;
      const bootstrapState = await this.syncStorage.readBootstrapState(this.use.database());
      context.assertCurrent();
      if (bootstrapState.resolution) {
        this.state.bootstrapPending = bootstrapState.resolution;
        if (await this.submitMatchingBootstrapResolution()) return true;
      }
      if (!this.state.bootstrapPending && bootstrapState.gate && !this.state.bootstrapGateOwned) {
        this.deferBootstrapPreparation();
        return true;
      }
      if (this.state.bootstrapPending || !this.state.bootstrapGateOwned) return false;
      const persisted = await this.syncStorage.readSyncState(this.use.database());
      context.assertCurrent();
      if (this.syncCore.accountOwnerId(persisted.snapshot?.user) !== this.syncCore.accountOwnerId(this.state.user)) return false;
      await this.resumeNormalSyncFromBootstrap(persisted);
      return true;
    }

    buildBootstrapPlan(local) {
      return this.syncStorage.bootstrapPlan({
        localOwnerId: this.state.localOwnerId, currentUserId: this.syncCore.accountOwnerId(this.state.user),
        localHistory: local.history, remoteHistory: this.state.bootstrapPreview.history,
        hasLocalState: this.syncCore.hasLocalState(local),
        hasRemoteState: this.syncCore.hasRemoteState({
          ...this.state.bootstrapPreview, defaultDurationsMs: this.use.defaultDurationsMs()
        })
      });
    }

    async prepareBootstrapPlan() {
      const context = this.use.captureAccountContext();
      this.state.bootstrapPreview = await this.submission.loadBootstrapPreview();
      context.assertCurrent();
      const local = this.submission.localBootstrapState();
      this.state.bootstrapPlan = this.buildBootstrapPlan(local);
      this.state.bootstrapOwnershipConfirmation = this.state.bootstrapPlan.reason === "different_owner";
      if (this.state.bootstrapPlan.mode !== "normal_sync") return false;
      const persisted = await this.syncStorage.readSyncState(this.use.database());
      context.assertCurrent();
      if (this.syncCore.accountOwnerId(persisted.snapshot?.user) === this.syncCore.accountOwnerId(this.state.user)) {
        await this.resumeNormalSyncFromBootstrap(persisted);
        return true;
      }
      this.state.localOwnerId = this.syncCore.accountOwnerId(persisted.snapshot?.user) || null;
      this.state.bootstrapPlan = this.buildBootstrapPlan(local);
      this.state.bootstrapOwnershipConfirmation = this.state.bootstrapPlan.reason === "different_owner";
      return false;
    }

    async persistAutomaticBootstrapResolution() {
      try {
        if (!this.syncCore.isResolutionStrategy(this.state.bootstrapPlan.strategy)) {
          this.use.queueSessionRevalidation();
          return;
        }
        await this.submission.persistBootstrapResolution(
          this.state.bootstrapPlan.strategy,
          Boolean(this.state.bootstrapPending && this.state.bootstrapPending.userId !== this.syncCore.accountOwnerId(this.state.user))
        );
      } catch (error) {
        if (this.submission.handleResolutionLimit(error)) return;
        throw error;
      }
      await this.submission.submitBootstrapResolution();
    }

    async prepareBootstrapOnce() {
      this.state.bootstrapBlocked = true;
      this.use.render();
      if (this.bootstrapPreparationPaused()) return;
      if (await this.reconcileBootstrapAccount()) return;
      if (await this.acquireBootstrapPreparationGate()) return;
      if (await this.submitMatchingBootstrapResolution()) return;
      if (await this.reconcilePersistedBootstrapState()) return;
      if (await this.prepareBootstrapPlan()) return;
      if (this.state.bootstrapPlan.mode === "choose" || this.state.bootstrapOwnershipConfirmation) {
        this.state.bootstrapStrategy = null;
        this.state.bootstrapFocusTarget = this.elements.bootstrapChoiceButtons[0];
        this.use.render();
        return;
      }
      await this.persistAutomaticBootstrapResolution();
    }
  }

  function create({ state, external, use }) {
    const submission = new BootstrapSubmission(state, external, use);
    const preparation = new BootstrapPreparation(state, external, use, submission);
    submission.preparation = preparation;
    return { ...submission.actions(), ...preparation.actions() };
  }

  return Object.freeze({ manifest, create });
});
