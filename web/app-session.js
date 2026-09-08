(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PomodoroughAppSession = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PENDING_LOGOUT_KEY = "pomodoroughPendingLogout";
  const PENDING_LOGOUT_OWNER_KEY = "pomodoroughPendingLogoutOwner";

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
    name: "session",
    externals: ["host", "syncCore", "syncStorage", "elements"],
    requires: [
      "captureAccountContext",
      "database", "clearLocalData", "tr", "render", "renderProfile", "renderSyncStatus",
      "showNotice", "quarantineOwnerState", "restoreOwnerState", "restartBootstrapForCurrentAccount",
      "needsBootstrapResolution", "prepareBootstrap", "syncNow", "scheduleSync", "scheduleRetry",
      "resetSyncRetry", "refreshAllPendingOperations", "tabId", "cleanupIdentity",
      "assertCleanupIdentity", "resumeStartup"
    ],
    provides: [
      "activateCachedOwnerOffline", "fetchSessionPayload", "applySessionPayload", "loadSession",
      "refreshMutationCsrf", "postMutation", "redirectToLogin", "openRevisionStream",
      "closeRevisionStreamForIdentityChange", "closeRevisionStream", "pollRemoteState",
      "queueSessionRevalidation", "restoreSessionAndSync", "handleOnline", "handleOffline",
      "accountDeletionConfirmationIsValid", "pendingLocalLogout", "markPendingLogout",
      "clearPendingLogout", "clearPendingLogoutData", "initializeSession",
      "requestSessionRevocation", "deleteAccount", "logout", "retryPendingLogout",
      "setFetchForTest", "setStorageMethodForTest", "setRevisionStreamForTest",
      "hasRevisionStreamForTest"
    ],
    emits: ["revision-hint"],
    listens: []
  });

  class RevisionStream {
    constructor(state, host, use, emit, syncCore) {
      Object.assign(this, { state, host, use, emit, syncCore });
      this.eventSource = null;
      this.receiveRevision = this.receiveRevision.bind(this);
    }

    actions() {
      return bindActions(this, [
        "openRevisionStream", "closeRevisionStreamForIdentityChange", "closeRevisionStream",
        "pollRemoteState", "setRevisionStreamForTest", "hasRevisionStreamForTest"
      ]);
    }

    receiveRevision(event) {
      let revision = Number(event.data);
      try {
        const payload = JSON.parse(event.data);
        revision = Number(payload.revision ?? payload);
      } catch {
        // Plain revision strings are valid event payloads.
      }
      this.emit("revision-hint", { revision: Number.isFinite(revision) ? revision : null });
    }

    openRevisionStream() {
      if (!this.state.sessionIdentityValidated || !this.state.authenticated
        || this.use.needsBootstrapResolution() || !this.host.navigator.onLine || this.eventSource) return;
      this.eventSource = new this.host.EventSource("/api/v1/stream");
      const stream = this.eventSource;
      const ownerId = this.syncCore.accountOwnerId(this.state.user);
      const receive = (event) => {
        if (stream === this.eventSource && ownerId === this.syncCore.accountOwnerId(this.state.user)) this.receiveRevision(event);
      };
      this.eventSource.onmessage = receive;
      this.eventSource.addEventListener("revision", receive);
      this.eventSource.onerror = () => {
        if (stream === this.eventSource && ownerId === this.syncCore.accountOwnerId(this.state.user)
          && !this.host.navigator.onLine) this.closeRevisionStream();
      };
    }

    closeRevisionStreamForIdentityChange(nextUserId) {
      if (!nextUserId || (this.syncCore.accountOwnerId(this.state.user) && this.syncCore.accountOwnerId(this.state.user) !== nextUserId)) this.closeRevisionStream();
    }

    closeRevisionStream() {
      this.eventSource?.close();
      this.eventSource = null;
    }

    pollRemoteState(runSync = this.use.syncNow) {
      if (!this.state.ready || !this.state.sessionIdentityValidated || !this.state.authenticated
        || !this.state.csrfToken || this.use.needsBootstrapResolution() || !this.host.navigator.onLine) return false;
      runSync(true);
      return true;
    }

    setRevisionStreamForTest(value) {
      this.eventSource = value;
    }

    hasRevisionStreamForTest() {
      return Boolean(this.eventSource);
    }
  }

  class SessionLifecycle {
    constructor(state, external, use, stream) {
      Object.assign(this, { state, use, stream }, external);
      this.redirecting = false;
      this.sessionRequestSequence = 0;
    }

    actions() {
      return bindActions(this, [
        "activateCachedOwnerOffline", "fetchSessionPayload", "applySessionPayload", "loadSession",
        "refreshMutationCsrf", "postMutation", "redirectToLogin", "queueSessionRevalidation",
        "restoreSessionAndSync", "handleOnline", "handleOffline", "accountDeletionConfirmationIsValid",
        "pendingLocalLogout", "markPendingLogout", "clearPendingLogout", "clearPendingLogoutData",
        "initializeSession", "requestSessionRevocation", "deleteAccount", "logout", "retryPendingLogout",
        "setFetchForTest", "setStorageMethodForTest"
      ]);
    }

    async activateCachedOwnerOffline() {
      if (this.pendingLocalLogout()) return false;
      const local = this.state.quarantinedLocal;
      if (!this.syncCore.validAccountIncarnation(local?.user?.accountIncarnation)) return false;
      if (!this.syncCore.canUseCachedOwnerOffline({
        sessionValidated: this.state.sessionIdentityValidated, cachedUserId: this.syncCore.accountOwnerId(local?.user),
        localOwnerId: this.state.localOwnerId, gateOwned: this.state.bootstrapGateOwned,
        pending: this.state.bootstrapPending
      })) return false;
      try {
        const context = this.use.captureAccountContext();
        await this.syncStorage.clearBootstrapGate(this.use.database(), this.use.tabId(), context);
        context.assertCurrent();
      } catch {
        return false;
      }
      this.use.restoreOwnerState(local);
      Object.assign(this.state, {
        quarantinedLocal: null, authenticated: false, csrfToken: null, offlineOwnerMode: true,
        bootstrapBlocked: false, bootstrapGatePersisted: false, bootstrapGateOwned: false
      });
      return true;
    }

    async fetchSessionPayload() {
      const context = this.use.captureAccountContext();
      const sequence = ++this.sessionRequestSequence;
      const identity = this.pendingLocalLogout() ? this.use.cleanupIdentity() : null;
      const binding = await this.syncStorage.readAccountBinding(this.use.database());
      context.assertCurrent();
      const response = await this.host.fetch("/api/v1/me", {
        credentials: "same-origin", cache: "no-store"
      });
      await this.validateSessionBinding(binding, context, sequence);
      if (response.status === 401) {
        if (identity) {
          if (!await this.clearPendingLogoutData(identity)) return null;
          this.use.assertCleanupIdentity(identity);
          this.clearPendingLogout();
        }
        this.redirectToLogin();
        return null;
      }
      if (!response.ok) throw new Error(this.use.tr(
        "session.checkFailed", { status: response.status }, `Session check failed (${response.status}).`
      ));
      const payload = await response.json();
      await this.validateSessionBinding(binding, context, sequence);
      Object.defineProperty(payload, "accountBinding", { value: {
        ...binding, ownerId: this.syncCore.authenticatedOwnerId(payload.user)
      } });
      return payload;
    }

    async validateSessionBinding(binding, context, sequence) {
      const current = await this.syncStorage.readAccountBinding(this.use.database());
      context.assertCurrent();
      if (sequence !== this.sessionRequestSequence || JSON.stringify(current) !== JSON.stringify(binding)) {
        throw new this.syncStorage.AccountOwnershipError();
      }
    }

    applySessionPayload(payload) {
      this.stream.closeRevisionStreamForIdentityChange(this.syncCore.authenticatedOwnerId(payload.user));
      this.state.authenticatedAccountBinding = payload.accountBinding || null;
      this.state.user = payload.user || null;
      this.state.csrfToken = payload.csrfToken || null;
      this.state.authenticated = true;
      this.state.sessionIdentityValidated = true;
      this.state.offlineOwnerMode = false;
      this.use.renderProfile();
    }

    async loadSession() {
      const identity = this.pendingLocalLogout() ? this.use.cleanupIdentity() : null;
      const payload = await this.fetchSessionPayload();
      if (!payload) return false;
      if (identity || this.pendingLocalLogout()) return this.finishPendingLogout(payload, identity);
      const previousOwnerId = this.syncCore.accountOwnerId(this.state.user) || this.state.localOwnerId;
      if (previousOwnerId && this.syncCore.accountOwnerId(payload.user) !== previousOwnerId) {
        const sourceOwnerId = this.state.localOwnerId || previousOwnerId;
        this.stream.closeRevisionStreamForIdentityChange(this.syncCore.accountOwnerId(payload.user));
        this.use.quarantineOwnerState();
        this.state.localOwnerId = sourceOwnerId;
        this.state.bootstrapBlocked = true;
        this.applySessionPayload(payload);
        await this.use.restartBootstrapForCurrentAccount();
        this.use.render();
        return true;
      }
      this.applySessionPayload(payload);
      return true;
    }

    async finishPendingLogout(payload, identity) {
      const userId = this.syncCore.accountOwnerId(payload.user);
      if (!identity || typeof userId !== "string" || !userId
        || identity.expectedUserId && identity.expectedUserId !== userId) {
        throw new this.syncStorage.AccountOwnershipError();
      }
      const authorized = { ...identity, expectedUserId: userId, authenticatedUserId: userId };
      this.use.assertCleanupIdentity(authorized);
      this.stream.closeRevisionStream();
      await this.use.clearLocalData(authorized);
      this.state.logoutRecoveryRequired = false;
      if (!await this.requestSessionRevocation(payload.csrfToken || null, userId)) throw new Error(this.use.tr(
        "account.logout.revocationPending", {}, "Pending sign-out could not be revoked yet."
      ));
      this.use.assertCleanupIdentity(authorized);
      this.clearPendingLogout();
      this.redirectToLogin();
      return false;
    }

    async refreshMutationCsrf(expectedUserId) {
      const payload = await this.fetchSessionPayload();
      if (!payload) throw new Error(this.use.tr(
        "session.refreshRequiresSignIn", {}, "Session refresh requires sign-in."
      ));
      if (!this.syncCore.accountOwnerId(payload.user) || this.syncCore.accountOwnerId(payload.user) !== expectedUserId) {
        const sourceOwnerId = this.state.localOwnerId || expectedUserId;
        this.stream.closeRevisionStreamForIdentityChange(this.syncCore.accountOwnerId(payload.user));
        this.use.quarantineOwnerState();
        this.state.localOwnerId = sourceOwnerId;
        this.state.bootstrapBlocked = true;
        this.applySessionPayload(payload);
        await this.use.restartBootstrapForCurrentAccount();
        this.use.render();
        throw new Error(this.use.tr(
          "session.accountChanged", {}, "Signed-in account changed during mutation retry."
        ));
      }
      this.applySessionPayload(payload);
      return this.state.csrfToken;
    }

    async postMutation(url, body, expectedUserId) {
      const context = this.use.captureAccountContext();
      if (context.ownerId !== expectedUserId) throw new this.syncStorage.AccountOwnershipError();
      const headers = this.syncCore.accountHeaders(expectedUserId);
      let timing = null;
      const response = await this.syncCore.postJSONWithCsrfRetry({
        fetcher: async (...args) => {
          await this.syncStorage.guardedMutation(this.use.database(), [], () => {}, {
            ...context, allowBootstrap: url === "/api/v1/bootstrap/resolve"
          });
          context.assertCurrent();
          return this.host.fetch(...args);
        }, url, body, headers, csrfToken: this.state.csrfToken,
        refreshCsrf: () => this.refreshMutationCsrf(expectedUserId),
        nextRequestSequence: () => this.syncStorage.allocateClockRequestSequence(this.use.database(), context),
        onTiming: (value) => { timing = value; }
      });
      context.assertCurrent();
      return { response, timing };
    }

    redirectToLogin() {
      if (this.redirecting) return;
      if (this.state.logoutRecoveryRequired
        && (this.state.logoutRecoveryBusy || !this.host.navigator.onLine)) {
        this.use.render();
        return;
      }
      this.redirecting = true;
      this.host.location.assign("/auth/google/start?return=%2Fapp");
    }

    queueSessionRevalidation() {
      Object.assign(this.state, {
        bootstrapSubmitting: false, bootstrapPending: null, bootstrapStrategy: null,
        bootstrapConflict: false, bootstrapError: null, bootstrapLimitError: null,
        bootstrapBlocked: true, bootstrapGateOwned: false, sessionIdentityValidated: false
      });
      this.stream.closeRevisionStream();
      this.use.render();
      if (this.pendingLocalLogout()) return;
      this.host.setTimeout(() => this.restoreSessionAndSync(), 0);
    }

    async restoreSessionAndSync() {
      if (this.state.logoutRecoveryRequired) return this.retryPendingLogout();
      try {
        if (!this.state.sessionIdentityValidated || !this.state.authenticated || !this.state.csrfToken) {
          await this.loadSession();
        }
        if (this.state.authenticated) {
          if (this.use.needsBootstrapResolution()) await this.use.prepareBootstrap();
          else {
            this.stream.openRevisionStream();
            await this.use.syncNow(true);
          }
        }
      } catch (error) {
        await this.activateCachedOwnerOffline();
        this.state.retrying = true;
        this.use.render();
        this.use.scheduleRetry();
        this.host.console.warn("Pomodorough remains offline:", error);
      }
    }

    handleOnline() {
      this.state.retrying = false;
      this.use.resetSyncRetry();
      this.use.render();
      this.restoreSessionAndSync();
    }

    handleOffline() {
      this.state.syncing = false;
      this.state.retrying = false;
      this.stream.closeRevisionStream();
      this.use.render();
    }

    accountDeletionConfirmationIsValid(value) {
      return value === "DELETE";
    }

    pendingLocalLogout() {
      try { return this.host.localStorage.getItem(PENDING_LOGOUT_KEY) !== null; } catch { return false; }
    }

    markPendingLogout() {
      try {
        this.host.localStorage.setItem(PENDING_LOGOUT_OWNER_KEY, JSON.stringify({
          userId: this.syncCore.accountOwnerId(this.state.user) || this.state.localOwnerId || null
        }));
        this.host.localStorage.setItem(PENDING_LOGOUT_KEY, "1");
      } catch {
        // IndexedDB is still cleared below when durable marker storage is unavailable.
      }
    }

    clearPendingLogout() {
      try {
        this.host.localStorage.removeItem(PENDING_LOGOUT_KEY);
        this.host.localStorage.removeItem(PENDING_LOGOUT_OWNER_KEY);
      } catch {
        // A successful server revocation makes a stale inaccessible marker harmless.
      }
    }

    async clearPendingLogoutData(identity) {
      if (!this.pendingLocalLogout()) return true;
      try {
        await this.use.clearLocalData(identity);
        this.state.logoutRecoveryRequired = false;
        return true;
      } catch (error) {
        this.state.logoutRecoveryRequired = true;
        this.use.showNotice(this.use.tr(
          "account.logout.cleanupFailed", { error: error.message },
          `Signed-out local data could not be cleared: ${error.message}`
        ));
        this.use.render();
        return false;
      }
    }

    async retryPendingLogout() {
      if (this.state.logoutRecoveryBusy) return false;
      this.state.logoutRecoveryBusy = true;
      this.use.render();
      try {
        return await this.use.resumeStartup();
      } finally {
        this.state.logoutRecoveryBusy = false;
        this.use.render();
      }
    }

    async initializeSession() {
      try {
        if (await this.loadSession()) await this.use.prepareBootstrap();
      } catch (error) {
        if (this.pendingLocalLogout()) this.state.logoutRecoveryRequired = true;
        if (!this.state.sessionIdentityValidated) {
          this.state.authenticated = false;
          this.state.csrfToken = null;
          await this.activateCachedOwnerOffline();
        }
        if (this.host.navigator.onLine) this.state.retrying = true;
        this.use.render();
        this.use.scheduleRetry();
        this.use.showNotice(error.message);
        this.host.console.warn("Pomodorough session deferred:", error);
        reportFrontendError(error, "session.initialize.deferred");
      }
    }

    async requestSessionRevocation(csrfToken, ownerId = this.syncCore.accountOwnerId(this.state.user)) {
      if (!csrfToken) return false;
      const response = await this.host.fetch("/api/v1/auth/logout", {
        method: "POST", credentials: "same-origin",
        headers: { "X-CSRF-Token": csrfToken, ...this.syncCore.accountHeaders(ownerId) }
      });
      if (!response.ok && response.status !== 401) throw new Error(this.use.tr(
        "account.logout.failed", { status: response.status }, `Sign out failed (${response.status}).`
      ));
      return true;
    }

    async deleteAccount() {
      const confirmation = this.host.prompt(this.use.tr(
        "account.delete.prompt", {},
        "Delete your Pomodorough account, timer history, tasks, settings, sessions, and server device records permanently? Type DELETE to confirm."
      ));
      if (confirmation === null) return;
      if (!this.accountDeletionConfirmationIsValid(confirmation)) {
        this.use.showNotice(this.use.tr(
          "account.delete.invalid", {}, "Account was not deleted. Type DELETE exactly to confirm."
        ));
        return;
      }
      if (!this.state.csrfToken) {
        this.use.showNotice(this.use.tr(
          "account.delete.offline", {}, "Connect to the account server before deleting your account."
        ));
        return;
      }
      this.elements.deleteAccountButton.disabled = true;
      const context = this.use.captureAccountContext();
      if (!await this.requestAccountDeletion(confirmation)) return;
      context.assertCurrent();
      this.markPendingLogout();
      const identity = this.use.cleanupIdentity();
      this.stream.closeRevisionStreamForIdentityChange();
      try {
        await this.use.clearLocalData(identity);
        this.use.assertCleanupIdentity(identity);
        this.clearPendingLogout();
      } catch (error) {
        this.host.console.warn("Deleted account local-data cleanup will retry on next launch:", error);
      }
      this.redirectToLogin();
    }

    async requestAccountDeletion(confirmation) {
      try {
        const context = this.use.captureAccountContext();
        await this.syncStorage.guardedMutation(this.use.database(), [], () => {}, { ...context, allowBootstrap: true });
        context.assertCurrent();
        const response = await this.host.fetch("/api/v1/account", {
          method: "DELETE", credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": this.state.csrfToken,
            ...this.syncCore.accountHeaders(context.ownerId) },
          body: JSON.stringify({ confirmation })
        });
        context.assertCurrent();
        if (!response.ok) throw new Error(this.use.tr(
          "account.delete.httpFailed", { status: response.status },
          `Account deletion failed (${response.status}).`
        ));
        return true;
      } catch (error) {
        this.elements.deleteAccountButton.disabled = false;
        this.use.showNotice(error.message || this.use.tr(
          "account.delete.failed", {}, "Account deletion failed. Your local data was kept."
        ));
        return false;
      }
    }

    pendingOperationCount() {
      return this.state.pending.length + this.state.pendingTaskOperations.length
        + this.state.pendingDurationOperations.length + this.state.pendingAutoStartOperations.length
        + this.state.pendingSelectedTaskOperations.length;
    }

    async logout() {
      const context = this.use.captureAccountContext();
      try {
        await this.use.refreshAllPendingOperations();
        await this.syncStorage.guardedMutation(this.use.database(), [], () => {}, { ...context, allowBootstrap: true });
      } catch (error) {
        this.host.console.warn("Pomodorough pending queues unavailable before logout:", error);
        reportFrontendError(error, "session.logout.pending-queues");
        return;
      }
      context.assertCurrent();
      const pendingCount = this.pendingOperationCount();
      if (pendingCount > 0) {
        const confirmed = this.host.confirm(this.use.tr(
          "account.logout.pending", { count: pendingCount },
          `${pendingCount} change${pendingCount === 1 ? " is" : "s are"} waiting to sync. Signing out will discard ${pendingCount === 1 ? "it" : "them"}. Continue?`
        ));
        if (!confirmed) return;
      }
      this.elements.logoutButton.disabled = true;
      this.markPendingLogout();
      const identity = this.use.cleanupIdentity();
      let serverRevoked = false;
      try {
        serverRevoked = await this.requestSessionRevocation(this.state.csrfToken, context.ownerId);
      } catch (error) {
        this.host.console.warn("Pomodorough server revocation deferred until reconnect:", error);
        reportFrontendError(error, "session.logout.revocation-deferred");
      }
      this.use.assertCleanupIdentity(identity);
      this.stream.closeRevisionStream();
      let localDataCleared = false;
      try {
        await this.use.clearLocalData(identity);
        localDataCleared = true;
      } catch (error) {
        this.host.console.warn("Pomodorough local sign-out cleanup was incomplete:", error);
        reportFrontendError(error, "session.logout.cleanup-incomplete");
      }
      if (serverRevoked && localDataCleared) {
        this.use.assertCleanupIdentity(identity);
        this.clearPendingLogout();
      }
      this.redirectToLogin();
    }

    setFetchForTest(value) {
      this.host.fetch = value;
    }

    setStorageMethodForTest(name, value) {
      this.syncStorage[name] = value;
    }
  }

  function create({ state, external, use, emit }) {
    const stream = new RevisionStream(state, external.host, use, emit, external.syncCore);
    const lifecycle = new SessionLifecycle(state, external, use, stream);
    return { ...stream.actions(), ...lifecycle.actions() };
  }

  return Object.freeze({ manifest, create });
});
