(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PomodoroughAppSession = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PENDING_LOGOUT_KEY = "pomodoroughPendingLogout";

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
      "database", "clearLocalData", "tr", "render", "renderProfile", "renderSyncStatus",
      "showNotice", "quarantineOwnerState", "restoreOwnerState", "restartBootstrapForCurrentAccount",
      "needsBootstrapResolution", "prepareBootstrap", "syncNow", "scheduleSync", "scheduleRetry",
      "resetSyncRetry", "refreshAllPendingOperations", "tabId"
    ],
    provides: [
      "activateCachedOwnerOffline", "fetchSessionPayload", "applySessionPayload", "loadSession",
      "refreshMutationCsrf", "postMutation", "redirectToLogin", "openRevisionStream",
      "closeRevisionStreamForIdentityChange", "closeRevisionStream", "pollRemoteState",
      "queueSessionRevalidation", "restoreSessionAndSync", "handleOnline", "handleOffline",
      "accountDeletionConfirmationIsValid", "pendingLocalLogout", "markPendingLogout",
      "clearPendingLogout", "clearPendingLogoutData", "initializeSession",
      "requestSessionRevocation", "deleteAccount", "logout",
      "setFetchForTest", "setStorageMethodForTest", "setRevisionStreamForTest",
      "hasRevisionStreamForTest"
    ],
    emits: ["revision-hint"],
    listens: []
  });

  class RevisionStream {
    constructor(state, host, use, emit) {
      Object.assign(this, { state, host, use, emit });
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
      this.eventSource.onmessage = this.receiveRevision;
      this.eventSource.addEventListener("revision", this.receiveRevision);
      this.eventSource.onerror = () => {
        if (!this.host.navigator.onLine) this.closeRevisionStream();
      };
    }

    closeRevisionStreamForIdentityChange(nextUserId) {
      if (!nextUserId || (this.state.user?.id && this.state.user.id !== nextUserId)) this.closeRevisionStream();
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
    }

    actions() {
      return bindActions(this, [
        "activateCachedOwnerOffline", "fetchSessionPayload", "applySessionPayload", "loadSession",
        "refreshMutationCsrf", "postMutation", "redirectToLogin", "queueSessionRevalidation",
        "restoreSessionAndSync", "handleOnline", "handleOffline", "accountDeletionConfirmationIsValid",
        "pendingLocalLogout", "markPendingLogout", "clearPendingLogout", "clearPendingLogoutData",
        "initializeSession", "requestSessionRevocation", "deleteAccount", "logout",
        "setFetchForTest", "setStorageMethodForTest"
      ]);
    }

    async activateCachedOwnerOffline() {
      const local = this.state.quarantinedLocal;
      if (!this.syncCore.canUseCachedOwnerOffline({
        sessionValidated: this.state.sessionIdentityValidated, cachedUserId: local?.user?.id,
        localOwnerId: this.state.localOwnerId, gateOwned: this.state.bootstrapGateOwned,
        pending: this.state.bootstrapPending
      })) return false;
      try {
        await this.syncStorage.clearBootstrapGate(this.use.database(), this.use.tabId());
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
      const response = await this.host.fetch("/api/v1/me", {
        credentials: "same-origin", cache: "no-store"
      });
      if (response.status === 401) {
        if (this.pendingLocalLogout()) this.clearPendingLogout();
        this.redirectToLogin();
        return null;
      }
      if (!response.ok) throw new Error(this.use.tr(
        "session.checkFailed", { status: response.status }, `Session check failed (${response.status}).`
      ));
      return response.json();
    }

    applySessionPayload(payload) {
      this.stream.closeRevisionStreamForIdentityChange(payload.user?.id);
      this.state.user = payload.user || null;
      this.state.csrfToken = payload.csrfToken || null;
      this.state.authenticated = true;
      this.state.sessionIdentityValidated = true;
      this.state.offlineOwnerMode = false;
      this.use.renderProfile();
    }

    async loadSession() {
      const payload = await this.fetchSessionPayload();
      if (!payload) return false;
      if (this.pendingLocalLogout()) {
        if (!await this.requestSessionRevocation(payload.csrfToken || null)) throw new Error(this.use.tr(
          "account.logout.revocationPending", {}, "Pending sign-out could not be revoked yet."
        ));
        this.clearPendingLogout();
        this.stream.closeRevisionStreamForIdentityChange();
        await this.use.clearLocalData();
        this.redirectToLogin();
        return false;
      }
      const previousOwnerId = this.state.user?.id || this.state.localOwnerId;
      if (previousOwnerId && payload.user?.id !== previousOwnerId) {
        this.stream.closeRevisionStreamForIdentityChange(payload.user?.id);
        this.use.quarantineOwnerState();
        this.state.localOwnerId = previousOwnerId;
        this.state.bootstrapBlocked = true;
        this.applySessionPayload(payload);
        await this.use.restartBootstrapForCurrentAccount();
        this.use.render();
        return true;
      }
      this.applySessionPayload(payload);
      return true;
    }

    async refreshMutationCsrf(expectedUserId) {
      const payload = await this.fetchSessionPayload();
      if (!payload) throw new Error(this.use.tr(
        "session.refreshRequiresSignIn", {}, "Session refresh requires sign-in."
      ));
      if (!payload.user?.id || payload.user.id !== expectedUserId) {
        this.stream.closeRevisionStreamForIdentityChange(payload.user?.id);
        this.use.quarantineOwnerState();
        this.state.localOwnerId = expectedUserId;
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
      let timing = null;
      const response = await this.syncCore.postJSONWithCsrfRetry({
        fetcher: this.host.fetch, url, body, csrfToken: this.state.csrfToken,
        refreshCsrf: () => this.refreshMutationCsrf(expectedUserId),
        nextRequestSequence: () => this.syncStorage.allocateClockRequestSequence(this.use.database()),
        onTiming: (value) => { timing = value; }
      });
      return { response, timing };
    }

    redirectToLogin() {
      if (this.redirecting) return;
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
      this.host.setTimeout(() => this.restoreSessionAndSync(), 0);
    }

    async restoreSessionAndSync() {
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
      this.use.renderSyncStatus();
      this.restoreSessionAndSync();
    }

    handleOffline() {
      this.state.syncing = false;
      this.state.retrying = false;
      this.stream.closeRevisionStream();
      this.use.renderSyncStatus();
    }

    accountDeletionConfirmationIsValid(value) {
      return value === "DELETE";
    }

    pendingLocalLogout() {
      try { return this.host.localStorage.getItem(PENDING_LOGOUT_KEY) === "1"; } catch { return false; }
    }

    markPendingLogout() {
      try {
        this.host.localStorage.setItem(PENDING_LOGOUT_KEY, "1");
      } catch {
        // IndexedDB is still cleared below when durable marker storage is unavailable.
      }
    }

    clearPendingLogout() {
      try {
        this.host.localStorage.removeItem(PENDING_LOGOUT_KEY);
      } catch {
        // A successful server revocation makes a stale inaccessible marker harmless.
      }
    }

    async clearPendingLogoutData() {
      if (!this.pendingLocalLogout()) return true;
      try {
        await this.use.clearLocalData();
        return true;
      } catch (error) {
        this.use.showNotice(this.use.tr(
          "account.logout.cleanupFailed", { error: error.message },
          `Signed-out local data could not be cleared: ${error.message}`
        ));
        this.use.renderSyncStatus();
        return false;
      }
    }

    async initializeSession() {
      try {
        if (await this.loadSession()) await this.use.prepareBootstrap();
      } catch (error) {
        if (!this.state.sessionIdentityValidated) {
          this.state.authenticated = false;
          this.state.csrfToken = null;
          await this.activateCachedOwnerOffline();
        }
        if (this.host.navigator.onLine) this.state.retrying = true;
        this.use.render();
        this.use.scheduleRetry();
        this.host.console.warn("Pomodorough session deferred:", error);
      }
    }

    async requestSessionRevocation(csrfToken) {
      if (!csrfToken) return false;
      const response = await this.host.fetch("/api/v1/auth/logout", {
        method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": csrfToken }
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
      if (!await this.requestAccountDeletion(confirmation)) return;
      this.markPendingLogout();
      this.stream.closeRevisionStreamForIdentityChange();
      try {
        await this.use.clearLocalData();
        this.clearPendingLogout();
      } catch (error) {
        this.host.console.warn("Deleted account local-data cleanup will retry on next launch:", error);
      }
      this.redirectToLogin();
    }

    async requestAccountDeletion(confirmation) {
      try {
        const response = await this.host.fetch("/api/v1/account", {
          method: "DELETE", credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": this.state.csrfToken },
          body: JSON.stringify({ confirmation })
        });
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
      try {
        await this.use.refreshAllPendingOperations();
      } catch (error) {
        this.host.console.warn("Pomodorough pending queues unavailable before logout:", error);
      }
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
      let serverRevoked = false;
      try {
        serverRevoked = await this.requestSessionRevocation(this.state.csrfToken);
      } catch (error) {
        this.host.console.warn("Pomodorough server revocation deferred until reconnect:", error);
      }
      this.stream.closeRevisionStream();
      let localDataCleared = false;
      try {
        await this.use.clearLocalData();
        localDataCleared = true;
      } catch (error) {
        this.host.console.warn("Pomodorough local sign-out cleanup was incomplete:", error);
      }
      if (serverRevoked && localDataCleared) this.clearPendingLogout();
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
    const stream = new RevisionStream(state, external.host, use, emit);
    const lifecycle = new SessionLifecycle(state, external, use, stream);
    return { ...stream.actions(), ...lifecycle.actions() };
  }

  return Object.freeze({ manifest, create });
});
