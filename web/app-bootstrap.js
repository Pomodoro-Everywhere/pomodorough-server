(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PomodoroughAppBootstrap = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const accountOperation = typeof module === "object" && module.exports
    ? require("./account-operation.js") : globalThis.PomodoroughAccountOperation;

  function timingMs(name, fallback) {
    try {
      const runtime = typeof globalThis !== "undefined" ? globalThis.PomodoroughAppRuntime : null;
      const value = runtime?.TIMING_MS?.[name] ?? runtime?.timingMs?.(name, fallback);
      if (Number.isFinite(value)) return value;
    } catch { /* timing config never blocks bootstrap */ }
    return fallback;
  }

  const BOOTSTRAP_LEASE_MS = timingMs("bootstrapLease", 5 * 60_000);
  const TIMER_OWNER_LEASE_MS = timingMs("timerOwnerLease", 60_000);
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
      "queueSessionRevalidation", "refreshAllPendingOperations", "validatePersistedDisplayContext"
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
      this.submissionContext = null;
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

    async restartBootstrapForCurrentAccount(context = this.use.captureAccountContext()) {
      accountOperation.requireBound(context);
      if (!this.syncCore.accountOwnerId(this.state.user)) return;
      await this.use.validatePersistedDisplayContext(context);
      context.assertCurrent();
      const restarted = await this.syncStorage.invalidateForeignResolution(this.use.database(), {
        ...context, accountBinding: this.state.authenticatedAccountBinding,
        currentUserId: this.syncCore.accountOwnerId(this.state.user), gateToken: this.use.tabId(), nowMs: Date.now(),
        leaseMs: BOOTSTRAP_LEASE_MS
      });
      context.assertCurrent();
      if (restarted.acquired && !restarted.resolution) {
        restarted.legacyAutoStartMigration = await this.syncStorage.migrateLegacyAutoStart(this.use.database(), {
          ...context, operationId: this.host.crypto.randomUUID(), nowMs: Date.now()
        });
        context.assertCurrent();
        restarted.legacySelectedTaskMigration = await this.syncStorage.migrateLegacySelectedTask(this.use.database(), {
          ...context, operationId: this.host.crypto.randomUUID(), nowMs: Date.now()
        });
        context.assertCurrent();
        await this.use.refreshMigratedPreferences(restarted, context);
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

    queueBootstrapPreparation(context = this.use.captureAccountContext()) {
      accountOperation.requireBound(context);
      this.host.setTimeout(() => {
        if (!accountOperation.isCurrent(context)) return;
        return this.preparation.prepareBootstrap(context).catch((error) => {
          if (!accountOperation.isCurrent(context)) return;
          this.state.retrying = true;
          this.use.scheduleRetry(context);
          this.host.console.warn("Pomodorough bootstrap restart deferred:", error);
          reportFrontendError(error, "bootstrap.restart.deferred");
        });
      }, timingMs("defer", 0));
    }

    async loadBootstrapPreview(context = this.use.captureAccountContext()) {
      accountOperation.requireBound(context);
      const requestSequence = await this.syncStorage.allocateClockRequestSequence(this.use.database(), context);
      context.assertCurrent();
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
        this.syncStorage.sampleClock(this.state.clockOffset, payload.serverTime,
          { requestAtMs, receivedAtMs, requestSequence }), context
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

    async persistBootstrapResolution(strategy, replaceExisting = false, context = this.use.captureAccountContext()) {
      accountOperation.requireBound(context);
      if (this.state.bootstrapOwnershipConfirmation
        && (!this.state.bootstrapOwnershipApproved || strategy !== this.state.bootstrapPlan.strategy)) {
        throw new this.syncStorage.AccountOwnershipError();
      }
      if (!this.syncCore.isResolutionStrategy(strategy)) {
        throw new this.syncStorage.BootstrapGateError("History resolution changed in another tab.");
      }
      await this.use.validatePersistedDisplayContext(context);
      context.assertCurrent();
      const lease = await this.use.acquireBootstrapGate(context);
      context.assertCurrent();
      if (!lease.acquired) throw new this.syncStorage.BootstrapGateError("Another tab owns history resolution.");
      await this.use.refreshMigratedPreferences(lease, context);
      context.assertCurrent();
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
        pendingResolution: pending, response: payload, deviceId: pending.payload.deviceId,
        deliveryProof: local.deliveryProof || null
      });
      const revision = Number(applied.revision);
      if (!Number.isFinite(revision) || revision < 0) throw new Error(this.use.tr(
        "bootstrap.missingRevision", {}, "Bootstrap response omitted revision."
      ));
      const durationsMs = this.use.clone(applied.baseDurationsMs);
      const clockOffset = this.use.responseClockOffset(payload, timing, true);
      return {
        local, validated,
        snapshot: {
          revision, serverTime: payload.serverTime,
          canonicalTimer: this.use.clone(applied.baseTimer),
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
      while (this.state.actionLocked) await new Promise((resolve) => this.host.setTimeout(resolve, timingMs("defer", 0)));
    }

    async acceptBootstrapResponse(payload, pending, timing, context) {
      accountOperation.requireBound(context);
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
        await this.use.reloadPersistedState(null, context);
        context.assertCurrent();
        this.resetBootstrapState();
        const conflicts = this.bootstrapConflicts(next.validated);
        if (outcome.applied && conflicts.length) {
          this.state.conflict = conflicts[0].reason || `Operation outcome: ${conflicts[0].outcome}`;
        }
      } finally {
        this.state.actionLocked = false;
      }
      context.assertCurrent();
      this.use.render();
      context.assertCurrent();
      this.use.openRevisionStream(context);
      if (this.use.hasPendingOperations()) this.use.scheduleSync(0, false, context);
    }

    async validateBootstrapSubmission(pending, context) {
      accountOperation.requireBound(context);
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
      const claimed = await this.syncStorage.validatePendingForSend(this.use.database(), {
        ...context,
        pending: current, currentUserId: this.syncCore.accountOwnerId(this.state.user), gateToken: this.use.tabId(),
        nowMs: Date.now(), leaseMs: BOOTSTRAP_LEASE_MS
      });
      context.assertCurrent();
      this.state.bootstrapPending = claimed;
      return claimed;
    }

    async recoverInvalidBootstrapSubmission(context) {
      accountOperation.requireBound(context);
      const persisted = await this.syncStorage.readBootstrapState(this.use.database());
      context.assertCurrent();
      if (!this.syncCore.pendingMatchesUser(persisted.resolution, this.syncCore.accountOwnerId(this.state.user))) {
        this.use.queueSessionRevalidation(context);
        return;
      }
      this.state.bootstrapPending = persisted.resolution;
      this.state.bootstrapGateOwned = false;
      this.queueBootstrapPreparation(context);
    }

    async sendBootstrapResolution(pending, context) {
      accountOperation.requireBound(context);
      const body = JSON.stringify(pending.payload);
      const { response, timing } = await this.use.postMutation(
        "/api/v1/bootstrap/resolve", body, pending.userId, context
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
          this.use.queueSessionRevalidation(context);
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
      await this.acceptBootstrapResponse(payload, pending, timing, context);
      context.assertCurrent();
    }

    async submitBootstrapResolution(context = this.use.captureAccountContext()) {
      if (!accountOperation.isCurrent(context)) return;
      if (this.submissionActive() || !this.state.bootstrapPending || !this.host.navigator.onLine) return;
      let pending = this.state.bootstrapPending;
      if (!this.syncCore.pendingResolutionCanSubmit(pending, this.syncCore.accountOwnerId(this.state.user))) {
        this.use.queueSessionRevalidation(context);
        return;
      }
      try {
        pending = await this.validateBootstrapSubmission(pending, context);
        context.assertCurrent();
      } catch (error) {
        if (!accountOperation.isCurrent(context)) return;
        if (/possibly delivered|exceeds Core limits|cannot be rewritten|non-delivery evidence/i.test(error.message || "")) {
          this.state.bootstrapError = error.message;
          this.state.bootstrapFocusTarget = this.elements.bootstrapRetry;
          this.use.renderBootstrapDialog();
          return;
        }
        await this.recoverInvalidBootstrapSubmission(context);
        return;
      }
      this.submissionContext = context;
      this.state.bootstrapSubmitting = true;
      this.state.bootstrapError = null;
      this.use.renderBootstrapDialog();
      try {
        await this.sendBootstrapResolution(pending, context);
      } catch (error) {
        if (!accountOperation.isCurrent(context)) return;
        if (!this.syncCore.pendingMatchesUser(this.state.bootstrapPending, this.syncCore.accountOwnerId(this.state.user))) {
          this.state.bootstrapError = null;
          this.queueBootstrapPreparation(context);
          return;
        }
        this.state.bootstrapError = `${error.message || "History resolution was interrupted."} Retry sends the exact saved request.`;
        this.state.bootstrapFocusTarget = this.elements.bootstrapRetry;
        this.host.console.warn("Pomodorough bootstrap resolution deferred:", error);
        reportFrontendError(error, "bootstrap.resolution.deferred");
      } finally {
        if (this.submissionContext === context) {
          this.submissionContext = null;
          this.state.bootstrapSubmitting = false;
          if (accountOperation.isCurrent(context)) this.use.render();
        }
      }
    }

    submissionActive() {
      return this.state.bootstrapSubmitting && (!this.submissionContext || accountOperation.isCurrent(this.submissionContext));
    }

    async retryBootstrapResolution(context = this.use.captureAccountContext()) {
      if (!accountOperation.isCurrent(context)) return;
      if (this.submissionActive()) return;
      try {
        if (this.state.bootstrapConflict) {
          const strategy = this.state.bootstrapStrategy || this.state.bootstrapPending?.payload?.strategy;
          if (!this.syncCore.isResolutionStrategy(strategy)) {
            this.use.queueSessionRevalidation(context);
            return;
          }
          this.submissionContext = context;
          this.state.bootstrapSubmitting = true;
          this.use.renderBootstrapDialog();
          const preview = await this.loadBootstrapPreview(context);
          context.assertCurrent();
          this.state.bootstrapPreview = preview;
          await this.persistBootstrapResolution(strategy, true, context);
          context.assertCurrent();
          this.state.bootstrapSubmitting = false;
        }
        await this.submitBootstrapResolution(context);
      } catch (error) {
        if (!accountOperation.isCurrent(context)) return;
        if (this.handleResolutionLimit(error)) return;
        reportFrontendError(error, "bootstrap.retry.deferred");
        this.state.bootstrapSubmitting = false;
        this.state.bootstrapError = error.message || "History resolution could not be retried.";
        this.state.bootstrapFocusTarget = this.elements.bootstrapRetry;
        this.use.renderBootstrapDialog();
      }
    }

    async chooseBootstrapStrategy(strategy, confirmed = false) {
      const context = this.use.captureAccountContext();
      accountOperation.requireBound(context);
      if (this.submissionActive() || this.state.bootstrapPending) return;
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
      this.submissionContext = context;
      this.state.bootstrapSubmitting = true;
      this.use.renderBootstrapDialog();
      try {
        await this.persistBootstrapResolution(strategy, false, context);
        context.assertCurrent();
      } catch (error) {
        if (!accountOperation.isCurrent(context)) return;
        if (this.handleResolutionLimit(error)) return;
        reportFrontendError(error, "bootstrap.choice.deferred");
        this.use.showNotice(error.message || this.use.tr(
          "notice.historyChoiceFailed", {}, "History choice could not be saved."
        ));
        this.state.bootstrapFocusTarget = this.elements.bootstrapConfirm;
        this.state.bootstrapSubmitting = false;
        this.use.renderBootstrapDialog();
        return;
      }
      this.state.bootstrapSubmitting = false;
      await this.submitBootstrapResolution(context);
    }
  }

  class BootstrapPreparation {
    constructor(state, external, use, submission) {
      Object.assign(this, { state, use, submission }, external);
      this.bootstrapPromise = null;
      this.bootstrapContext = null;
    }

    actions() {
      return bindActions(this, [
        "prepareBootstrap", "resumeNormalSyncFromBootstrap", "bootstrapPreparationPaused",
        "reconcileBootstrapAccount", "deferBootstrapPreparation", "acquireBootstrapPreparationGate",
        "submitMatchingBootstrapResolution", "reconcilePersistedBootstrapState", "buildBootstrapPlan",
        "prepareBootstrapPlan", "persistAutomaticBootstrapResolution", "prepareBootstrapOnce"
      ]);
    }

    async prepareBootstrap(context = this.use.captureAccountContext()) {
      if (!accountOperation.isCurrent(context)) return;
      if (this.bootstrapPromise) {
        if (accountOperation.isCurrent(this.bootstrapContext)) return this.bootstrapPromise;
        await this.bootstrapPromise;
        if (!accountOperation.isCurrent(context)) return;
        return this.prepareBootstrap(context);
      }
      this.bootstrapContext = context;
      this.bootstrapPromise = this.prepareBootstrapOnce(context).catch((error) => {
        if (accountOperation.isCurrent(context)) throw error;
      });
      try { return await this.bootstrapPromise; } finally {
        this.bootstrapPromise = null;
        this.bootstrapContext = null;
      }
    }

    async resumeNormalSyncFromBootstrap(persisted, context) {
      accountOperation.requireBound(context);
      await this.use.reloadPersistedState(persisted, context);
      context.assertCurrent();
      this.state.quarantinedLocal = null;
      await this.syncStorage.clearBootstrapGate(this.use.database(), this.use.tabId(), context);
      context.assertCurrent();
      Object.assign(this.state, {
        bootstrapPending: null, bootstrapGatePersisted: false,
        bootstrapGateOwned: false, bootstrapBlocked: false, retrying: false
      });
      this.use.render();
      await this.use.syncNow(true, context);
      context.assertCurrent();
      this.use.openRevisionStream(context);
    }

    bootstrapPreparationPaused() {
      return Boolean(this.state.bootstrapError || this.state.bootstrapLimitError
        || this.state.bootstrapOwnershipConfirmation && !this.state.bootstrapPending
        || this.state.bootstrapPlan?.mode === "choose" && !this.state.bootstrapPending);
    }

    async reconcileBootstrapAccount(context) {
      accountOperation.requireBound(context);
      const currentUserId = this.syncCore.accountOwnerId(this.state.user);
      const pendingMatches = !this.state.bootstrapPending
        || this.syncCore.pendingMatchesUser(this.state.bootstrapPending, currentUserId);
      const needsAccountHandoff = !this.state.bootstrapGateOwned
        && this.state.localOwnerId && this.state.localOwnerId !== currentUserId;
      if (pendingMatches && !needsAccountHandoff) return false;
      if (!this.state.sessionIdentityValidated) {
        this.use.queueSessionRevalidation(context);
        return true;
      }
      try {
        await this.submission.restartBootstrapForCurrentAccount(context);
        context.assertCurrent();
      } catch (error) {
        if (!accountOperation.isCurrent(context)) throw error;
        if (!(error instanceof this.syncStorage.AccountOwnershipError)) throw error;
        this.use.queueSessionRevalidation(context);
        return true;
      }
      return false;
    }

    deferBootstrapPreparation(context) {
      accountOperation.requireBound(context);
      this.state.retrying = true;
      this.use.scheduleRetry(context);
      this.use.render();
    }

    async acquireBootstrapPreparationGate(context) {
      accountOperation.requireBound(context);
      if (this.state.bootstrapGateOwned) return false;
      const lease = await this.use.acquireBootstrapGate(context);
      context.assertCurrent();
      if (!lease.acquired) {
        this.deferBootstrapPreparation(context);
        return true;
      }
      this.state.bootstrapGateOwned = true;
      this.state.bootstrapGatePersisted = true;
      await this.use.refreshMigratedPreferences(lease, context);
      context.assertCurrent();
      if (lease.resolution) this.state.bootstrapPending = lease.resolution;
      if (this.state.bootstrapPending
        && !this.syncCore.pendingResolutionCanSubmit(this.state.bootstrapPending, this.syncCore.accountOwnerId(this.state.user))) {
        if (!this.state.sessionIdentityValidated) {
          this.use.queueSessionRevalidation(context);
          return true;
        }
        await this.submission.restartBootstrapForCurrentAccount(context);
        context.assertCurrent();
      }
      if (this.state.bootstrapPending) return false;
      const persisted = await this.syncStorage.readSyncState(this.use.database());
      context.assertCurrent();
      if (this.syncCore.accountOwnerId(persisted.snapshot?.user) === this.syncCore.accountOwnerId(this.state.user)) {
        await this.resumeNormalSyncFromBootstrap(persisted, context);
        return true;
      }
      if (this.syncCore.accountOwnerId(persisted.snapshot?.user)) this.state.localOwnerId = this.syncCore.accountOwnerId(persisted.snapshot.user);
      return false;
    }

    async submitMatchingBootstrapResolution(context) {
      accountOperation.requireBound(context);
      if (this.state.bootstrapPending?.userId !== this.syncCore.accountOwnerId(this.state.user)) return false;
      this.state.bootstrapStrategy = this.state.bootstrapPending.payload.strategy;
      await this.submission.submitBootstrapResolution(context);
      return true;
    }

    async reconcilePersistedBootstrapState(context) {
      accountOperation.requireBound(context);
      if (this.state.bootstrapPending || !this.syncCore.canExposeOwnerState({
        sessionValidated: this.state.sessionIdentityValidated, localOwnerId: this.state.localOwnerId,
        currentUserId: this.syncCore.accountOwnerId(this.state.user)
      })) return false;
      const bootstrapState = await this.syncStorage.readBootstrapState(this.use.database());
      context.assertCurrent();
      if (bootstrapState.resolution) {
        this.state.bootstrapPending = bootstrapState.resolution;
        if (await this.submitMatchingBootstrapResolution(context)) return true;
        context.assertCurrent();
      }
      if (!this.state.bootstrapPending && bootstrapState.gate && !this.state.bootstrapGateOwned) {
        this.deferBootstrapPreparation(context);
        return true;
      }
      if (this.state.bootstrapPending || !this.state.bootstrapGateOwned) return false;
      const persisted = await this.syncStorage.readSyncState(this.use.database());
      context.assertCurrent();
      if (this.syncCore.accountOwnerId(persisted.snapshot?.user) !== this.syncCore.accountOwnerId(this.state.user)) return false;
      await this.resumeNormalSyncFromBootstrap(persisted, context);
      return true;
    }

    async buildBootstrapPlan(context = this.use.captureAccountContext()) {
      accountOperation.requireBound(context);
      const records = await this.syncStorage.readSyncState(this.use.database());
      context.assertCurrent();
      const result = this.syncStorage.bootstrapWorkspace({ ...records,
        deviceId: this.state.deviceId, ownerId: this.syncCore.accountOwnerId(records.snapshot?.user),
        currentUserId: this.syncCore.accountOwnerId(this.state.user), remote: this.state.bootstrapPreview,
        nowMs: Date.now(), defaultDurationsMs: this.use.defaultDurationsMs() });
      this.state.bootstrapClassification = result.classification;
      return result.plan;
    }

    async prepareBootstrapPlan(context) {
      accountOperation.requireBound(context);
      const preview = await this.submission.loadBootstrapPreview(context);
      context.assertCurrent();
      this.state.bootstrapPreview = preview;
      const plan = await this.buildBootstrapPlan(context);
      context.assertCurrent();
      this.state.bootstrapPlan = plan;
      this.state.bootstrapOwnershipConfirmation = this.state.bootstrapPlan.reason === "different_owner";
      if (this.state.bootstrapPlan.mode !== "normal_sync") return false;
      const persisted = await this.syncStorage.readSyncState(this.use.database());
      context.assertCurrent();
      if (this.syncCore.accountOwnerId(persisted.snapshot?.user) === this.syncCore.accountOwnerId(this.state.user)) {
        await this.resumeNormalSyncFromBootstrap(persisted, context);
        return true;
      }
      this.state.localOwnerId = this.syncCore.accountOwnerId(persisted.snapshot?.user) || null;
      const revisedPlan = await this.buildBootstrapPlan(context);
      context.assertCurrent();
      this.state.bootstrapPlan = revisedPlan;
      this.state.bootstrapOwnershipConfirmation = this.state.bootstrapPlan.reason === "different_owner";
      return false;
    }

    async persistAutomaticBootstrapResolution(context) {
      accountOperation.requireBound(context);
      try {
        if (!this.syncCore.isResolutionStrategy(this.state.bootstrapPlan.strategy)) {
          this.use.queueSessionRevalidation(context);
          return;
        }
        await this.submission.persistBootstrapResolution(
          this.state.bootstrapPlan.strategy,
          Boolean(this.state.bootstrapPending && this.state.bootstrapPending.userId !== this.syncCore.accountOwnerId(this.state.user)), context
        );
        context.assertCurrent();
      } catch (error) {
        if (!accountOperation.isCurrent(context)) throw error;
        if (this.submission.handleResolutionLimit(error)) return;
        throw error;
      }
      await this.submission.submitBootstrapResolution(context);
    }

    async prepareBootstrapOnce(context) {
      accountOperation.requireBound(context);
      await this.use.validatePersistedDisplayContext(context);
      context.assertCurrent();
      this.state.bootstrapBlocked = true;
      this.use.render();
      if (this.bootstrapPreparationPaused()) return;
      if (await this.reconcileBootstrapAccount(context)) return;
      context.assertCurrent();
      if (await this.acquireBootstrapPreparationGate(context)) return;
      context.assertCurrent();
      if (await this.submitMatchingBootstrapResolution(context)) return;
      context.assertCurrent();
      if (await this.reconcilePersistedBootstrapState(context)) return;
      context.assertCurrent();
      if (await this.prepareBootstrapPlan(context)) return;
      context.assertCurrent();
      if (this.state.bootstrapPlan.mode === "choose" || this.state.bootstrapOwnershipConfirmation) {
        this.state.bootstrapStrategy = null;
        this.state.bootstrapFocusTarget = this.elements.bootstrapChoiceButtons[0];
        this.use.render();
        return;
      }
      await this.persistAutomaticBootstrapResolution(context);
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
