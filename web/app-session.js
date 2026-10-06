(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PomodoroughAppSession = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const accountOperation = typeof module === "object" && module.exports
    ? require("./account-operation.js") : globalThis.PomodoroughAccountOperation;

  const PENDING_LOGOUT_KEY = "pomodoroughPendingLogout";
  const PENDING_LOGOUT_OWNER_KEY = "pomodoroughPendingLogoutOwner";

  function timingMs(name, fallback) {
    try {
      const runtime = typeof globalThis !== "undefined" ? globalThis.PomodoroughAppRuntime : null;
      const value = runtime?.TIMING_MS?.[name] ?? runtime?.timingMs?.(name, fallback);
      if (Number.isFinite(value)) return value;
    } catch { /* timing config never blocks session */ }
    return fallback;
  }

  function reportFrontendError(error, operation) {
    try {
      const reporter = typeof globalThis !== "undefined"
        ? globalThis.PomodoroughSentryClient?.reportFrontendError
        : null;
      if (typeof reporter === "function") reporter(error, operation);
    } catch { /* error monitoring must never break the app */ }
  }

  function safeLoginReturnPath(value) {
    if (typeof value !== "string" || value.length === 0 || value.length > 1024) return "/app";
    if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/app";
    return value;
  }

  function currentLoginReturnPath(location) {
    try {
      if (!location) return "/app";
      if (typeof location.pathname === "string" && location.pathname) {
        const search = typeof location.search === "string" ? location.search : "";
        const query = search === "" || search.startsWith("?") ? search : "";
        return safeLoginReturnPath(`${location.pathname}${query}`.split("#")[0] || "/app");
      }
      if (typeof location.href === "string" && location.href.startsWith("/")) {
        return safeLoginReturnPath(location.href.split("#")[0] || "/app");
      }
      if (typeof location.href === "string" && location.href) {
        const parsed = new URL(location.href, "http://localhost");
        return safeLoginReturnPath(`${parsed.pathname}${parsed.search}` || "/app");
      }
    } catch { /* malformed location falls back below */ }
    return "/app";
  }

  function loginStartUrl(location) {
    return `/auth/google/start?return=${encodeURIComponent(currentLoginReturnPath(location))}`;
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
      "captureAccountContext", "captureDatabaseContext",
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
      "requestSessionRevocation", "deleteAccount", "confirmDeleteAccount",
      "cancelDeleteAccount", "logout", "retryPendingLogout",
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
      this.streamContext = null;
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

    openRevisionStream(context = this.use.captureAccountContext()) {
      if (!accountOperation.isCurrent(context)) return;
      if (this.eventSource && !accountOperation.isCurrent(this.streamContext)) this.closeRevisionStream();
      if (!this.state.sessionIdentityValidated || !this.state.authenticated
        || this.use.needsBootstrapResolution() || !this.host.navigator.onLine || this.eventSource) return;
      this.eventSource = new this.host.EventSource("/api/v1/stream");
      const stream = this.eventSource;
      this.streamContext = context;
      const receive = (event) => {
        if (stream === this.eventSource && accountOperation.isCurrent(context)) this.receiveRevision(event);
      };
      this.eventSource.onmessage = receive;
      this.eventSource.addEventListener("revision", receive);
      this.eventSource.onerror = (event) => {
        if (stream !== this.eventSource || !accountOperation.isCurrent(context)) return;
        const failure = event instanceof Error ? event : new Error("revision stream error");
        reportFrontendError(failure, "session.stream.error");
        if (!this.host.navigator.onLine) this.closeRevisionStream();
      };
    }

    closeRevisionStreamForIdentityChange(nextUserId) {
      if (!nextUserId || (this.syncCore.accountOwnerId(this.state.user) && this.syncCore.accountOwnerId(this.state.user) !== nextUserId)) this.closeRevisionStream();
    }

    closeRevisionStream() {
      this.eventSource?.close();
      this.eventSource = null;
      this.streamContext = null;
    }

    pollRemoteState(runSync = this.use.syncNow) {
      if (!this.state.ready || !this.state.sessionIdentityValidated || !this.state.authenticated
        || !this.state.csrfToken || this.use.needsBootstrapResolution() || !this.host.navigator.onLine) return false;
      runSync(true);
      return true;
    }

    setRevisionStreamForTest(value) {
      this.eventSource = value;
      this.streamContext = value ? this.use.captureAccountContext() : null;
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
      this.logoutFailureContexts = new WeakMap();
      this.authenticatedContexts = new WeakMap();
      this.sessionCompletionContexts = new WeakMap();
    }

    actions() {
      return bindActions(this, [
        "activateCachedOwnerOffline", "fetchSessionPayload", "applySessionPayload", "loadSession",
        "refreshMutationCsrf", "postMutation", "redirectToLogin", "queueSessionRevalidation",
        "restoreSessionAndSync", "handleOnline", "handleOffline", "accountDeletionConfirmationIsValid",
        "pendingLocalLogout", "markPendingLogout", "clearPendingLogout", "clearPendingLogoutData",
        "initializeSession", "requestSessionRevocation", "deleteAccount", "confirmDeleteAccount",
        "cancelDeleteAccount", "logout", "retryPendingLogout",
        "setFetchForTest", "setStorageMethodForTest"
      ]);
    }

    async activateCachedOwnerOffline(context = this.use.captureAccountContext()) {
      if (!accountOperation.isCurrent(context)) return false;
      if (this.pendingLocalLogout()) return false;
      const local = this.state.quarantinedLocal;
      if (!this.syncCore.validAccountIncarnation(local?.user?.accountIncarnation)) return false;
      if (!this.syncCore.canUseCachedOwnerOffline({
        sessionValidated: this.state.sessionIdentityValidated, cachedUserId: this.syncCore.accountOwnerId(local?.user),
        localOwnerId: this.state.localOwnerId, gateOwned: this.state.bootstrapGateOwned,
        pending: this.state.bootstrapPending
      })) return false;
      try {
        await this.syncStorage.clearBootstrapGate(this.use.database(), this.use.tabId(), context);
        context.assertCurrent();
      } catch {
        return false;
      }
      context.publishIdentity(() => this.use.restoreOwnerState(local));
      Object.assign(this.state, {
        quarantinedLocal: null, authenticated: false, csrfToken: null, offlineOwnerMode: true,
        bootstrapBlocked: false, bootstrapGatePersisted: false, bootstrapGateOwned: false
      });
      return true;
    }

    async fetchSessionPayload(context) {
      accountOperation.requireBound(context);
      const sequence = ++this.sessionRequestSequence;
      const identity = this.pendingLocalLogout() ? this.use.cleanupIdentity() : null;
      const binding = await this.readSessionBinding(context);
      context.assertCurrent();
      const response = await this.host.fetch("/api/v1/me", {
        credentials: "same-origin", cache: "no-store"
      });
      context.assertCurrent();
      await this.validateSessionBinding(binding, context, sequence);
      context.assertCurrent();
      if (response.status === 401) {
        let completed = context;
        if (identity) {
          const cleanup = await this.clearPendingLogoutData(identity, context);
          if (!cleanup.cleared) return null;
          accountOperation.requireBound(cleanup.context);
          completed = cleanup.context;
          this.use.assertCleanupIdentity(identity);
          completed.publishIdentity(() => this.clearPendingLogout());
          this.sessionCompletionContexts.set(context, completed);
        }
        accountOperation.requireBound(completed);
        this.redirectToLogin();
        return null;
      }
      if (!response.ok) throw new Error(this.use.tr(
        "session.checkFailed", { status: response.status }, `Session check failed (${response.status}).`
      ));
      const payload = await response.json();
      context.assertCurrent();
      await this.validateSessionBinding(binding, context, sequence);
      context.assertCurrent();
      Object.defineProperty(payload, "accountBinding", { value: {
        ...binding, ownerId: this.syncCore.authenticatedOwnerId(payload.user)
      } });
      return payload;
    }

    async validateSessionBinding(binding, context, sequence) {
      accountOperation.requireBound(context);
      const current = await this.readSessionBinding(context);
      context.assertCurrent();
      if (sequence !== this.sessionRequestSequence || JSON.stringify(current) !== JSON.stringify(binding)) {
        throw new this.syncStorage.AccountOwnershipError();
      }
    }

    readSessionBinding(context) {
      accountOperation.requireBound(context);
      // Pending sign-out recovery can authenticate before storage opens.
      return context.database ? this.syncStorage.readAccountBinding(context.database)
        : Promise.resolve({ sourceOwnerId: null, gateOwnerId: null });
    }

    applySessionPayload(payload, context) {
      accountOperation.requireBound(context);
      const authenticatedContext = context.publishIdentity(() => {
        this.stream.closeRevisionStreamForIdentityChange(this.syncCore.authenticatedOwnerId(payload.user));
        this.state.authenticatedAccountBinding = payload.accountBinding || null;
        this.state.user = payload.user || null;
        this.state.csrfToken = payload.csrfToken || null;
        this.state.authenticated = true;
        this.state.sessionIdentityValidated = true;
        this.state.offlineOwnerMode = false;
      });
      authenticatedContext.assertCurrent();
      this.use.renderProfile();
      return authenticatedContext;
    }

    async loadSession(context = this.use.captureAccountContext()) {
      accountOperation.requireBound(context);
      const identity = this.pendingLocalLogout() ? this.use.cleanupIdentity() : null;
      const payload = await this.fetchSessionPayload(context);
      const completed = this.sessionCompletionContexts.get(context) || context;
      completed.assertCurrent();
      if (!payload) return false;
      if (identity || this.pendingLocalLogout()) return this.finishPendingLogout(payload, identity, context);
      const previousOwnerId = this.syncCore.accountOwnerId(this.state.user) || this.state.localOwnerId;
      if (previousOwnerId && this.syncCore.accountOwnerId(payload.user) !== previousOwnerId) {
        const sourceOwnerId = this.state.localOwnerId || previousOwnerId;
        this.stream.closeRevisionStreamForIdentityChange(this.syncCore.accountOwnerId(payload.user));
        context.publishIdentity(() => {
          this.use.quarantineOwnerState();
          this.state.localOwnerId = sourceOwnerId;
        });
        this.state.bootstrapBlocked = true;
        const authenticatedContext = this.applySessionPayload(payload, context);
        this.authenticatedContexts.set(context, authenticatedContext);
        await this.use.restartBootstrapForCurrentAccount(authenticatedContext);
        authenticatedContext.assertCurrent();
        this.use.render();
        return true;
      }
      const authenticatedContext = this.applySessionPayload(payload, context);
      this.authenticatedContexts.set(context, authenticatedContext);
      return true;
    }

    async finishPendingLogout(payload, identity, issuer) {
      const userId = this.syncCore.accountOwnerId(payload.user);
      if (!identity || typeof userId !== "string" || !userId
        || identity.expectedUserId && identity.expectedUserId !== userId) {
        throw new this.syncStorage.AccountOwnershipError();
      }
      const authorized = { ...identity, expectedUserId: userId, authenticatedUserId: userId };
      this.use.assertCleanupIdentity(authorized);
      this.stream.closeRevisionStream();
      const context = await this.use.clearLocalData(authorized, issuer);
      accountOperation.requireBound(context);
      this.use.assertCleanupIdentity(authorized);
      if (this.use.database() !== null) throw new this.syncStorage.AccountOwnershipError();
      try {
        if (!await this.requestSessionRevocation(payload.csrfToken || null, userId, context)) throw new Error(this.use.tr(
          "account.logout.revocationPending", {}, "Pending sign-out could not be revoked yet."
        ));
      } catch (error) {
        if (accountOperation.isCurrent(context)) {
          this.use.assertCleanupIdentity(authorized);
          this.state.logoutRecoveryRequired = true;
          this.logoutFailureContexts.set(error, context);
        }
        throw error;
      }
      this.use.assertCleanupIdentity(authorized);
      context.publishIdentity(() => {
        this.state.logoutRecoveryRequired = false;
        this.clearPendingLogout();
      });
      this.sessionCompletionContexts.set(issuer, context);
      this.redirectToLogin();
      return false;
    }

    async refreshMutationCsrf(expectedUserId, context) {
      accountOperation.requireBound(context);
      if (context.ownerId !== expectedUserId) throw new this.syncStorage.AccountOwnershipError();
      const payload = await this.fetchSessionPayload(context);
      context.assertCurrent();
      if (!payload) throw new Error(this.use.tr(
        "session.refreshRequiresSignIn", {}, "Session refresh requires sign-in."
      ));
      if (!this.syncCore.accountOwnerId(payload.user) || this.syncCore.accountOwnerId(payload.user) !== expectedUserId) {
        const sourceOwnerId = this.state.localOwnerId || expectedUserId;
        this.stream.closeRevisionStreamForIdentityChange(this.syncCore.accountOwnerId(payload.user));
        context.publishIdentity(() => {
          this.use.quarantineOwnerState();
          this.state.localOwnerId = sourceOwnerId;
        });
        this.state.bootstrapBlocked = true;
        const authenticatedContext = this.applySessionPayload(payload, context);
        await this.use.restartBootstrapForCurrentAccount(authenticatedContext);
        authenticatedContext.assertCurrent();
        this.use.render();
        throw new Error(this.use.tr(
          "session.accountChanged", {}, "Signed-in account changed during mutation retry."
        ));
      }
      this.applySessionPayload(payload, context);
      context.assertCurrent();
      return this.state.csrfToken;
    }

    async postMutation(url, body, expectedUserId, context) {
      accountOperation.requireBound(context);
      if (context.ownerId !== expectedUserId) throw new this.syncStorage.AccountOwnershipError();
      const headers = this.syncCore.accountHeaders(expectedUserId);
      let timing = null;
      const response = await this.syncCore.postJSONWithCsrfRetry({
        fetcher: async (...args) => {
          context.assertCurrent();
          await this.syncStorage.guardedMutation(this.use.database(), [], () => {}, {
            ...context, allowBootstrap: url === "/api/v1/bootstrap/resolve"
          });
          context.assertCurrent();
          return this.host.fetch(...args);
        }, url, body, headers, csrfToken: this.state.csrfToken,
        assertCurrent: context.assertCurrent,
        refreshCsrf: () => this.refreshMutationCsrf(expectedUserId, context),
        nextRequestSequence: () => {
          context.assertCurrent();
          return this.syncStorage.allocateClockRequestSequence(this.use.database(), context);
        },
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
      this.host.location.assign(loginStartUrl(this.host.location));
    }

    queueSessionRevalidation(context = this.use.captureAccountContext()) {
      if (!accountOperation.isCurrent(context)) return;
      Object.assign(this.state, {
        bootstrapSubmitting: false, bootstrapPending: null, bootstrapStrategy: null,
        bootstrapConflict: false, bootstrapError: null, bootstrapLimitError: null,
        bootstrapBlocked: true, bootstrapGateOwned: false, sessionIdentityValidated: false
      });
      this.stream.closeRevisionStream();
      this.use.render();
      if (this.pendingLocalLogout()) return;
      this.host.setTimeout(() => {
        if (accountOperation.isCurrent(context)) return this.restoreSessionAndSync(context);
      }, timingMs("defer", 0));
    }

    async restoreSessionAndSync(context) {
      if (!accountOperation.isCurrent(context)) return;
      if (this.state.ready === false || this.state.logoutRecoveryRequired) return this.resumePendingStartup(context);
      try {
        if (!this.state.sessionIdentityValidated || !this.state.authenticated || !this.state.csrfToken) {
          await this.loadSession(context);
          context.assertCurrent();
        }
        if (this.state.authenticated) {
          if (this.use.needsBootstrapResolution()) await this.use.prepareBootstrap(context);
          else {
            this.stream.openRevisionStream(context);
            await this.use.syncNow(true, context);
          }
          context.assertCurrent();
        }
      } catch (error) {
        if (!accountOperation.isCurrent(context)) return;
        await this.activateCachedOwnerOffline(context);
        if (!accountOperation.isCurrent(context)) return;
        this.state.retrying = true;
        this.use.render();
        this.use.scheduleRetry(context);
        this.host.console.warn("Pomodorough remains offline:", error);
        reportFrontendError(error, "session.restore.offline");
      }
    }

    handleOnline() {
      this.state.retrying = false;
      this.use.resetSyncRetry();
      this.use.render();
      const context = this.state.ready === false || this.state.logoutRecoveryRequired
        ? this.use.captureDatabaseContext() : this.use.captureAccountContext();
      return this.restoreSessionAndSync(context);
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

    async clearPendingLogoutData(identity, issuer) {
      accountOperation.requireBound(issuer);
      if (!this.pendingLocalLogout()) return { cleared: true, context: issuer };
      try {
        const completed = await this.use.clearLocalData(identity, issuer);
        accountOperation.requireBound(completed);
        this.state.logoutRecoveryRequired = false;
        return { cleared: true, context: completed };
      } catch (error) {
        const context = error.cleanupContext || issuer;
        if (!accountOperation.isCurrent(context)) return { cleared: false, context };
        this.state.logoutRecoveryRequired = true;
        this.use.showNotice(this.use.tr(
          "account.logout.cleanupFailed", { error: error.message },
          `Signed-out local data could not be cleared: ${error.message}`
        ));
        this.host.console.warn("Pomodorough pending logout cleanup failed:", error);
        reportFrontendError(error, "session.logout-recovery.cleanup-failed");
        this.use.render();
        return { cleared: false, context };
      }
    }

    async retryPendingLogout() {
      return this.resumePendingStartup(this.use.captureDatabaseContext());
    }

    async resumePendingStartup(context) {
      if (!accountOperation.isCurrent(context)) return false;
      if (this.state.logoutRecoveryBusy) return false;
      this.state.logoutRecoveryBusy = true;
      this.use.render();
      let completed = context;
      try {
        const outcome = await this.use.resumeStartup(context);
        completed = outcome?.context || context;
        return outcome?.result ?? outcome;
      } finally {
        this.state.logoutRecoveryBusy = false;
        if (accountOperation.isCurrent(completed)) this.use.render();
      }
    }

    async initializeSession(issuer = this.use.captureAccountContext()) {
      let context = issuer;
      accountOperation.requireBound(context);
      try {
        const loaded = await this.loadSession(context);
        context = this.authenticatedContexts.get(context) || this.sessionCompletionContexts.get(context) || context;
        if (loaded) {
          context.assertCurrent();
          await this.use.prepareBootstrap(context);
        }
        accountOperation.requireBound(context);
        return context;
      } catch (error) {
        context = this.logoutFailureContexts.get(error) || context;
        if (!accountOperation.isCurrent(context)) return null;
        if (this.pendingLocalLogout()) this.state.logoutRecoveryRequired = true;
        if (!this.state.sessionIdentityValidated) {
          this.state.authenticated = false;
          this.state.csrfToken = null;
          await this.activateCachedOwnerOffline(context);
          if (!accountOperation.isCurrent(context)) return null;
        }
        if (this.host.navigator.onLine) this.state.retrying = true;
        this.use.render();
        this.use.scheduleRetry(context);
        this.use.showNotice(error.message);
        this.host.console.warn("Pomodorough session deferred:", error);
        reportFrontendError(error, "session.initialize.deferred");
        return context;
      }
    }

    async requestSessionRevocation(csrfToken, ownerId, context) {
      accountOperation.requireBound(context);
      if (!csrfToken) return false;
      const response = await this.host.fetch("/api/v1/auth/logout", {
        method: "POST", credentials: "same-origin",
        headers: { "X-CSRF-Token": csrfToken, ...this.syncCore.accountHeaders(ownerId) }
      });
      context.assertCurrent();
      if (!response.ok && response.status !== 401) throw new Error(this.use.tr(
        "account.logout.failed", { status: response.status }, `Sign out failed (${response.status}).`
      ));
      return true;
    }

    deleteAccountDialog() {
      if (this.deleteAccountDialogRefs) return this.deleteAccountDialogRefs;
      const document = this.host.document;
      if (!document?.createElement || !document?.body?.append) return null;
      const dialog = document.createElement("dialog");
      if (!dialog) return null;
      dialog.className = "bootstrap-dialog";
      dialog.setAttribute?.("aria-labelledby", "deleteAccountTitle");
      dialog.setAttribute?.("aria-describedby", "deleteAccountMessage");
      dialog.setAttribute?.("aria-modal", "true");
      const title = document.createElement("h2");
      title.id = "deleteAccountTitle";
      const message = document.createElement("p");
      message.id = "deleteAccountMessage";
      const input = document.createElement("input");
      input.type = "text";
      input.autocomplete = "off";
      const buttons = document.createElement("div");
      const confirm = document.createElement("button");
      confirm.type = "button";
      const cancel = document.createElement("button");
      cancel.type = "button";
      confirm.addEventListener?.("click", () => this.confirmDeleteAccount());
      cancel.addEventListener?.("click", () => this.cancelDeleteAccount());
      dialog.addEventListener?.("cancel", () => this.cancelDeleteAccount());
      buttons.append?.(confirm, cancel);
      dialog.append?.(title, message, input, buttons);
      document.body.append(dialog);
      this.deleteAccountDialogRefs = { dialog, title, message, input, confirm, cancel };
      return this.deleteAccountDialogRefs;
    }

    openDeleteAccountDialog() {
      const refs = this.deleteAccountDialog();
      if (!refs) {
        this.use.showNotice(this.use.tr(
          "account.delete.prompt", {},
          "Delete your Pomodorough account, timer history, tasks, settings, sessions, and server device records permanently? Type DELETE to confirm."
        ));
        return false;
      }
      refs.title.textContent = this.use.tr("account.delete", {}, "Delete account");
      refs.message.textContent = this.use.tr(
        "account.delete.prompt", {},
        "Delete your Pomodorough account, timer history, tasks, settings, sessions, and server device records permanently? Type DELETE to confirm."
      );
      refs.confirm.textContent = this.use.tr("bootstrap.confirm", {}, "Confirm");
      refs.cancel.textContent = this.use.tr("bootstrap.cancel", {}, "Cancel");
      refs.input.value = "";
      refs.input.setAttribute?.("aria-label", refs.message.textContent);
      if (!refs.dialog.open) refs.dialog.showModal?.();
      this.host.setTimeout?.(() => refs.input.focus?.(), timingMs("focusDefer", 0));
      return true;
    }

    closeDeleteAccountDialog() {
      try { this.deleteAccountDialogRefs?.dialog.close?.(); } catch { /* close never blocks deletion */ }
    }

    cancelDeleteAccount() {
      this.closeDeleteAccountDialog();
    }

    async deleteAccount(confirmation) {
      if (typeof confirmation === "string") return this.confirmDeleteAccount(confirmation);
      this.openDeleteAccountDialog();
    }

    async confirmDeleteAccount(confirmation) {
      const value = typeof confirmation === "string" ? confirmation : this.deleteAccountDialogRefs?.input?.value;
      this.closeDeleteAccountDialog();
      if (!this.accountDeletionConfirmationIsValid(value)) {
        this.use.showNotice(this.use.tr(
          "account.delete.invalid", {}, "Account was not deleted. Type DELETE exactly to confirm."
        ));
        return false;
      }
      if (!this.state.csrfToken) {
        this.use.showNotice(this.use.tr(
          "account.delete.offline", {}, "Connect to the account server before deleting your account."
        ));
        return false;
      }
      this.elements.deleteAccountButton.disabled = true;
      const context = this.use.captureAccountContext();
      if (!await this.requestAccountDeletion(value, context)) return false;
      context.assertCurrent();
      this.markPendingLogout();
      const cleanupContext = this.use.captureAccountContext();
      const identity = this.use.cleanupIdentity();
      this.stream.closeRevisionStreamForIdentityChange();
      return this.completeAccountCleanup(identity, cleanupContext, {
        clearMarker: true, reportFailure: (error) => {
          this.host.console.warn("Deleted account local-data cleanup will retry on next launch:", error);
          reportFrontendError(error, "session.delete-account.cleanup-retry");
        }
      });
    }

    async completeAccountCleanup(identity, context, completion) {
      if (!accountOperation.isCurrent(context)) return false;
      let effectsContext = context;
      try {
        const completed = await this.use.clearLocalData(identity, context);
        if (!accountOperation.isCurrent(completed)) return false;
        effectsContext = completed;
        this.use.assertCleanupIdentity(identity);
        if (completion.clearMarker) completed.publishIdentity(() => this.clearPendingLogout());
      } catch (error) {
        if (!accountOperation.isCurrent(context)) return false;
        completion.reportFailure(error);
      }
      if (!accountOperation.isCurrent(effectsContext)) return false;
      this.redirectToLogin();
      return true;
    }

    async requestAccountDeletion(confirmation, context) {
      accountOperation.requireBound(context);
      try {
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
        if (!accountOperation.isCurrent(context)) return false;
        this.elements.deleteAccountButton.disabled = false;
        this.use.showNotice(error.message || this.use.tr(
          "account.delete.failed", {}, "Account deletion failed. Your local data was kept."
        ));
        this.host.console.warn("Pomodorough account deletion request failed:", error);
        reportFrontendError(error, "session.delete-account.request-failed");
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
        await this.use.refreshAllPendingOperations(context);
        context.assertCurrent();
        await this.syncStorage.guardedMutation(this.use.database(), [], () => {}, { ...context, allowBootstrap: true });
      } catch (error) {
        if (!accountOperation.isCurrent(context)) return;
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
      context.assertCurrent();
      this.elements.logoutButton.disabled = true;
      this.markPendingLogout();
      const cleanupContext = this.use.captureAccountContext();
      const identity = this.use.cleanupIdentity();
      let serverRevoked = false;
      try {
        serverRevoked = await this.requestSessionRevocation(this.state.csrfToken, context.ownerId, cleanupContext);
      } catch (error) {
        if (!accountOperation.isCurrent(cleanupContext)) return;
        this.host.console.warn("Pomodorough server revocation deferred until reconnect:", error);
        reportFrontendError(error, "session.logout.revocation-deferred");
      }
      if (!accountOperation.isCurrent(cleanupContext)) return;
      this.use.assertCleanupIdentity(identity);
      this.stream.closeRevisionStream();
      await this.completeAccountCleanup(identity, cleanupContext, {
        clearMarker: serverRevoked, reportFailure: (error) => {
          this.host.console.warn("Pomodorough local sign-out cleanup was incomplete:", error);
          reportFrontendError(error, "session.logout.cleanup-incomplete");
        }
      });
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
