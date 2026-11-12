(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PomodoroughAppStorage = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const accountOperation = typeof module === "object" && module.exports
    ? require("./account-operation.js") : globalThis.PomodoroughAccountOperation;

  const DB_NAME = "pomodorough";
  const DB_VERSION = 5;
  const META_STORE = "meta";
  const PENDING_STORE = "pending";
  const TASK_PENDING_STORE = "pendingTasks";
  const DURATION_PENDING_STORE = "pendingDurations";
  const AUTO_START_PENDING_STORE = "pendingAutoStarts";
  const SELECTED_TASK_PENDING_STORE = "pendingSelectedTasks";
  function timingMs(name, fallback) {
    try {
      const runtime = typeof globalThis !== "undefined" ? globalThis.PomodoroughAppRuntime : null;
      const value = runtime?.TIMING_MS?.[name] ?? runtime?.timingMs?.(name, fallback);
      if (Number.isFinite(value)) return value;
    } catch { /* timing config never blocks storage */ }
    return fallback;
  }

  const BOOTSTRAP_LEASE_MS = timingMs("bootstrapLease", 5 * 60_000);
  const TIMER_OWNER_LEASE_MS = timingMs("timerOwnerLease", 60_000);
  const PENDING_LOGOUT_KEY = "pomodoroughPendingLogout";
  const PENDING_LOGOUT_OWNER_KEY = "pomodoroughPendingLogoutOwner";
  const PENDING_TASK_DELETIONS_KEY = "pomodoroughPendingTaskDeletions";
  const TASK_DELETION_UNDO_LOCK = "pomodorough-task-deletion-undo:";
  const ALL_STORES = Object.freeze([
    META_STORE, PENDING_STORE, TASK_PENDING_STORE, DURATION_PENDING_STORE,
    AUTO_START_PENDING_STORE, SELECTED_TASK_PENDING_STORE
  ]);

  function bindActions(owner, names) {
    return Object.fromEntries(names.map((name) => {
      owner[name] = owner[name].bind(owner);
      return [name, owner[name]];
    }));
  }

  function reportFrontendError(error, operation) {
    try {
      const reporter = typeof globalThis !== "undefined"
        ? globalThis.PomodoroughSentryClient?.reportFrontendError
        : null;
      if (typeof reporter === "function") reporter(error, operation);
    } catch { /* error monitoring must never break the app */ }
  }

  function storageFailure(error, use) {
    if (error?.name !== "AccountOwnershipError") reportFrontendError(error, "storage.failure");
    if (error?.name === "AccountOwnershipError") use.quarantineAccountMismatch();
    throw error;
  }

  function rethrowOwnershipWithoutReport(error, use) {
    if (error?.name === "AccountOwnershipError") use.quarantineAccountMismatch();
    throw error;
  }

  const manifest = Object.freeze({
    name: "storage",
    externals: ["host", "syncCore", "syncStorage"],
    requires: [
      "captureAccountContext",
      "clone", "emptyTimer", "normalizeTimer", "normalizeDurationsMs", "selectedDurationMs",
      "selectedTaskIdForNextFocus", "compareDurationOperations", "compareTimerCommands",
      "clampNumber", "trustedNow", "monotonicNow", "clockContinuityId", "elapsedFor", "rebuildOptimisticState",
      "quarantineOwnerState", "quarantineAccountMismatch", "assertExpectedAccount", "projectOwnerState", "tr", "phaseConfig",
      "defaultDurationsMs", "tabId", "showNotice", "controlsBlocked", "deleteTask"
    ],
    provides: [
      "openDatabase", "requestResult", "transactionDone", "settingsValue", "snapshotValue", "captureDatabaseContext",
      "migrateDurationQueueFromSettings", "bootstrapLegacyDurations", "readPendingDurationOperations",
      "refreshPendingDurationOperations", "readLocalRecords", "restoreLocalRecords",
      "persistNewLocalIdentity", "loadLocalState", "acquireBootstrapGate", "validatePersistedDisplayContext",
      "refreshMigratedPreferences",       "persistSettings", "persistCommand", "persistTaskOperation",
      "persistAutoStartOperation", "persistSelectedTaskOperation", "persistDurationOperation",
      "persistRetargetOperation", "persistWorkspaceIntent", "persistWorkspaceCompletion",
      "reloadPersistedState", "clearLocalData", "database", "setDatabaseForTest",
      "setInFlightDurationOperationIds", "cleanupIdentity", "assertCleanupIdentity",
      "markPendingTaskDeletion", "clearPendingTaskDeletion", "clearPendingTaskDeletions",
      "pendingTaskDeletions", "replayPendingTaskDeletions", "workspaceOwnerId"
    ],
    emits: [],
    listens: []
  });

  class DatabaseConnection {
    constructor(state, external, use, deletionMarkers) {
      Object.assign(this, { state, use, deletionMarkers }, external);
      this.db = null;
      this.connectionGeneration = 0;
    }

    actions() {
      return bindActions(this, [
        "openDatabase", "requestResult", "transactionDone", "clearLocalData",
        "database", "setDatabaseForTest", "cleanupIdentity", "assertCleanupIdentity", "captureDatabaseContext"
      ]);
    }

    createStores(database) {
      const stores = [
        [META_STORE, "key"], [PENDING_STORE, "id"], [TASK_PENDING_STORE, "id"],
        [DURATION_PENDING_STORE, "id"], [AUTO_START_PENDING_STORE, "id"],
        [SELECTED_TASK_PENDING_STORE, "id"]
      ];
      for (const [name, keyPath] of stores) {
        if (!database.objectStoreNames.contains(name)) database.createObjectStore(name, { keyPath });
      }
    }

    openDatabase() {
      return new Promise((resolve, reject) => {
        const request = this.host.indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => this.createStores(request.result);
        request.onsuccess = () => {
          request.result.onversionchange = () => request.result.close();
          resolve(request.result);
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error(this.use.tr(
          "storage.outdatedTab", {}, "Timer storage is open in another outdated tab."
        )));
      });
    }

    requestResult(request) {
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    transactionDone(transaction) {
      return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error || new Error(this.use.tr(
          "storage.transactionAborted", {}, "Storage transaction aborted."
        )));
        transaction.onerror = () => reject(transaction.error);
      });
    }

    pendingLogoutRecovery() {
      try {
        if (this.host.localStorage.getItem(PENDING_LOGOUT_KEY) !== "1") return null;
        const record = this.host.localStorage.getItem(PENDING_LOGOUT_OWNER_KEY);
        const userId = JSON.parse(record)?.userId;
        return typeof userId === "string" && userId ? { record, userId } : null;
      } catch {
        return null;
      }
    }

    cleanupIdentity() {
      const userId = this.syncCore.accountOwnerId(this.state.user) || null;
      const localOwnerId = this.state.localOwnerId || null;
      const recovery = this.pendingLogoutRecovery();
      return { userId, localOwnerId, recovery, markerState: this.logoutMarkerState(),
        expectedUserId: recovery?.userId || localOwnerId || userId };
    }

    logoutMarkerState() {
      try {
        return JSON.stringify([
          this.host.localStorage.getItem(PENDING_LOGOUT_KEY),
          this.host.localStorage.getItem(PENDING_LOGOUT_OWNER_KEY)
        ]);
      } catch {
        return null;
      }
    }

    assertCleanupIdentity(identity) {
      if ((this.syncCore.accountOwnerId(this.state.user) || null) !== identity.userId
        || (this.state.localOwnerId || null) !== identity.localOwnerId
        || identity.userId && identity.userId !== identity.expectedUserId
        || identity.localOwnerId && identity.localOwnerId !== identity.expectedUserId
        || this.logoutMarkerState() !== identity.markerState
        || identity.recovery && this.pendingLogoutRecovery()?.record !== identity.recovery.record) {
        throw new this.syncStorage.AccountOwnershipError();
      }
    }

    assertAuthorizedCleanup(identity, context) {
      accountOperation.requireBound(context);
      this.assertCleanupIdentity(identity);
    }

    confirmCleanupAlreadyComplete(identity, context) {
      return this.syncStorage.guardedMutation(this.db, ALL_STORES, (transaction, _outcome, abort, results) => {
        this.assertAuthorizedCleanup(identity, context);
        const meta = transaction.objectStore(META_STORE);
        // The full clear drops this tab's bootstrap gate too. Logout recovery
        // waits with the database closed, so a gate kept here outlives the tab.
        if (results.gate?.value?.token === this.use.tabId()) meta.delete(this.syncStorage.GATE_KEY);
        const requests = [
          meta.get("snapshot"), meta.get("bootstrapResolution"),
          ...ALL_STORES.slice(1).map((name) => transaction.objectStore(name).count())
        ];
        for (const request of requests) {
          request.onsuccess = () => {
            if (request.result) abort(new this.syncStorage.AccountOwnershipError());
          };
        }
      }, { expectedUserId: null, currentUserId: identity.expectedUserId, allowBootstrap: true,
        assertCurrent: () => this.assertAuthorizedCleanup(identity, context) });
    }

    async clearAuthorizedLocalData(identity, context) {
      this.assertAuthorizedCleanup(identity, context);
      // A task deletion that waits for replay belongs to the workspace this
      // cleanup removes. It must never reach the next owner of this browser.
      this.deletionMarkers.clearPendingTaskDeletions();
      if (!this.db) context = await this.openCleanupDatabase(identity, context);
      this.assertAuthorizedCleanup(identity, context);
      const database = this.db;
      await this.syncStorage.guardedMutation(database, ALL_STORES, (transaction) => {
        this.assertAuthorizedCleanup(identity, context);
        for (const storeName of ALL_STORES) transaction.objectStore(storeName).clear();
      }, { expectedUserId: identity.expectedUserId, currentUserId: identity.expectedUserId,
        assertCurrent: () => this.assertAuthorizedCleanup(identity, context), allowBootstrap: true }).catch((error) => {
        if (error.name !== "AccountOwnershipError" || !(identity.recovery || identity.authenticatedUserId)) throw error;
        this.assertAuthorizedCleanup(identity, context);
        return this.confirmCleanupAlreadyComplete(identity, context);
      }).catch((error) => {
        if (!accountOperation.isCurrent(context)) throw error;
        if (this.db === database) {
          this.assertCleanupIdentity(identity);
          error.cleanupContext = this.captureDatabaseContext();
        }
        storageFailure(error, this.use);
      });
      this.assertAuthorizedCleanup(identity, context);
      if (this.db !== database) throw new this.syncStorage.AccountOwnershipError();
      database.close();
      this.setDatabaseForTest(null);
      // Capture completion at our own close, before an awaiting caller can resume
      // against a different connection with identical account and logout markers.
      return this.captureDatabaseContext();
    }

    async openCleanupDatabase(identity, context) {
      accountOperation.requireBound(context);
      const generation = this.connectionGeneration;
      const database = await this.openDatabase();
      try {
        accountOperation.requireBound(context);
        this.assertCleanupIdentity(identity);
        if (this.connectionGeneration !== generation) throw new this.syncStorage.AccountOwnershipError();
      } catch (error) { database.close(); throw error; }
      this.setDatabaseForTest(database);
      return this.captureDatabaseContext();
    }

    captureDatabaseContext() {
      const generation = this.connectionGeneration;
      const captureIdentity = () => {
        const identity = this.use.captureAccountContext();
        return { ...identity, assertCurrent: () => {
          identity.assertCurrent();
          if (this.connectionGeneration !== generation) throw new this.syncStorage.AccountOwnershipError();
        } };
      };
      return accountOperation.bind(captureIdentity(), () => this.db, this.syncStorage.AccountOwnershipError, captureIdentity);
    }

    async clearLocalData(identity = this.cleanupIdentity(), context) {
      this.assertAuthorizedCleanup(identity, context);
      if (!this.cleanup) {
        this.cleanup = this.clearAuthorizedLocalData(identity, context).finally(() => {
          this.cleanup = null;
        });
      }
      const completed = await this.cleanup;
      this.assertCleanupIdentity(identity);
      accountOperation.requireBound(completed);
      return completed;
    }

    database() { return this.db; }
    setDatabaseForTest(value) {
      if (this.db !== value) this.connectionGeneration += 1;
      this.db = value;
    }
  }

  class LocalStateRepository {
    constructor(state, external, use, connection) {
      Object.assign(this, { state, use, connection }, external);
    }

    actions() {
      return bindActions(this, [
        "settingsValue", "snapshotValue", "migrateDurationQueueFromSettings",
        "bootstrapLegacyDurations", "readPendingDurationOperations", "refreshPendingDurationOperations",
        "readLocalRecords", "restoreLocalRecords",
        "persistNewLocalIdentity", "loadLocalState",
        "acquireBootstrapGate", "refreshMigratedPreferences", "persistSettings", "reloadPersistedState", "validatePersistedDisplayContext"
      ]);
    }

    settingsValue(overrides = {}) {
      return {
        selectedPhase: this.state.selectedPhase,
        durationSyncBootstrapped: this.state.durationSyncBootstrapped,
        autoStartSyncBootstrapped: this.state.autoStartSyncBootstrapped,
        selectedTaskSyncBootstrapped: this.state.selectedTaskSyncBootstrapped,
        ...overrides
      };
    }

    snapshotValue(overrides = {}) {
      return {
        revision: this.state.revision, canonicalTimer: this.state.baseTimer?.id ? this.use.clone(this.state.baseTimer) : null,
        history: this.use.clone(this.state.baseHistory), tasks: this.use.clone(this.state.baseTasks),
        durationsMs: this.use.clone(this.state.baseDurationsMs), autoStartBreaks: this.state.baseAutoStartBreaks,
        selectedTaskId: this.state.baseSelectedTaskId, user: this.use.clone(this.state.user), ...overrides
      };
    }

    async migrateDurationQueueFromSettings(context = this.use.captureAccountContext()) {
      accountOperation.requireBound(context);
      await this.syncStorage.guardedMutation(this.connection.database(), [DURATION_PENDING_STORE], (transaction, _outcome, abort) => {
        const metaStore = transaction.objectStore(META_STORE);
        const durationStore = transaction.objectStore(DURATION_PENDING_STORE);
        const request = metaStore.get("settings");
        const existingRequest = durationStore.getAll();
        let existing;
        let settingsRecord;
        const transfer = () => {
          if (existing === undefined || settingsRecord === undefined) return;
          try {
            context.assertCurrent();
            const pending = settingsRecord?.value?.pendingDurationOperations;
            if (!Array.isArray(pending)) return;
            const retained = new Map(existing.map((operation) => [operation.id, operation]));
            for (const operation of pending) {
              const previous = retained.get(operation.id);
              if (previous && !this.syncStorage.recordsEqual(previous, operation)) {
                throw new Error("Legacy duration identity already has a different retained payload.");
              }
              if (!previous) durationStore.add(operation);
            }
            const { pendingDurationOperations, ...settings } = settingsRecord.value;
            metaStore.put({ key: "settings", value: settings });
          } catch (error) { abort(error); }
        };
        request.onsuccess = () => {
          settingsRecord = request.result || null;
          transfer();
        };
        existingRequest.onsuccess = () => { existing = existingRequest.result; transfer(); };
      }, { ...context, allowBootstrap: true });
    }

    async bootstrapLegacyDurations(context = this.use.captureAccountContext()) {
      accountOperation.requireBound(context);
      await this.syncStorage.migrateLegacyPreferences(this.connection.database(), {
        ...context, deviceId: this.state.deviceId, tabId: this.use.tabId(), leaseMs: TIMER_OWNER_LEASE_MS,
        nowMs: this.use.trustedNow(), localNowMs: Date.now()
      });
    }

    async readPendingDurationOperations() {
      const transaction = this.connection.database().transaction(DURATION_PENDING_STORE, "readonly");
      const operations = await this.connection.requestResult(transaction.objectStore(DURATION_PENDING_STORE).getAll());
      return (operations || []).sort(this.use.compareDurationOperations);
    }

    async refreshPendingDurationOperations() {
      this.state.pendingDurationOperations = await this.readPendingDurationOperations();
    }

    async readLocalRecords() {
      const transaction = this.connection.database().transaction(ALL_STORES, "readonly");
      const metaStore = transaction.objectStore(META_STORE);
      const values = await Promise.all([
        this.connection.requestResult(metaStore.get("deviceId")),
        this.connection.requestResult(metaStore.get("deviceSequence")),
        this.connection.requestResult(metaStore.get("hlc")),
        this.connection.requestResult(metaStore.get("clockOffset")),
        this.connection.requestResult(metaStore.get("settings")),
        this.connection.requestResult(metaStore.get("snapshot")),
        this.connection.requestResult(metaStore.get("bootstrapResolution")),
        this.connection.requestResult(transaction.objectStore(PENDING_STORE).getAll()),
        this.connection.requestResult(transaction.objectStore(TASK_PENDING_STORE).getAll()),
        this.connection.requestResult(transaction.objectStore(DURATION_PENDING_STORE).getAll()),
        this.connection.requestResult(transaction.objectStore(AUTO_START_PENDING_STORE).getAll()),
        this.connection.requestResult(transaction.objectStore(SELECTED_TASK_PENDING_STORE).getAll()),
        this.connection.requestResult(metaStore.get("deliveryProof")),
        this.connection.requestResult(metaStore.get("canonicalHead")),
        this.connection.requestResult(metaStore.get("projectionPending")),
        this.connection.requestResult(metaStore.get("outgoingSync")),
        this.connection.requestResult(metaStore.get("timerDependencies")),
        this.connection.requestResult(metaStore.get("workspaceObservation")),
        this.connection.requestResult(metaStore.get("completionState"))
      ]);
      const names = [
        "deviceId", "deviceSequence", "hlc", "clockOffset", "settings", "snapshot",
        "bootstrapResolution", "pending", "pendingTaskOperations", "pendingDurationOperations",
        "pendingAutoStartOperations", "pendingSelectedTaskOperations",
        "deliveryProof", "canonicalHead", "projectionPending", "outgoingSync", "timerDependencies", "workspaceObservation", "completionState"
      ];
      return Object.fromEntries(names.map((name, index) => [name, values[index]]));
    }

    restoreLocalSnapshot(snapshot) {
      if (!snapshot) {
        this.state.baseTimer = this.use.emptyTimer(this.state.selectedPhase, this.use.selectedDurationMs());
        return;
      }
      this.state.revision = snapshot.revision ?? 0;
      this.state.baseTimer = snapshot.canonicalTimer || this.use.emptyTimer(this.state.selectedPhase, this.use.selectedDurationMs());
      this.state.baseHistory = Array.isArray(snapshot.history) ? snapshot.history : [];
      this.state.baseTasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
      this.state.baseDurationsMs = this.use.clone(snapshot.durationsMs);
      this.state.baseAutoStartBreaks = snapshot.autoStartBreaks === true;
      this.state.baseSelectedTaskId = snapshot.selectedTaskId ?? null;
      this.state.user = snapshot.user || null;
      this.state.localOwnerId = this.syncCore.accountOwnerId(snapshot.user) || null;
    }

    restoreLocalRecords(records, normalizedLegacyDurations) {
      const { deviceId, deviceSequence, hlc, clockOffset, settings, snapshot, bootstrapResolution } = records;
      this.state.deviceId = deviceId?.value || this.host.crypto.randomUUID();
      this.state.deviceSequence = Number(deviceSequence?.value) || 0;
      this.state.hlcWallMs = Number(hlc?.value?.wallMs) || 0;
      this.state.hlcCounter = Number(hlc?.value?.counter) || 0;
      this.state.clockOffset = clockOffset?.value ?? null;
      this.state.pending = (records.pending || []).sort(this.use.compareTimerCommands);
      this.state.pendingTaskOperations = records.pendingTaskOperations || [];
      this.state.pendingDurationOperations = (records.pendingDurationOperations || []).sort(this.use.compareDurationOperations);
      this.state.pendingAutoStartOperations = records.pendingAutoStartOperations || [];
      this.state.pendingSelectedTaskOperations = records.pendingSelectedTaskOperations || [];
      this.state.deliveryProof = this.syncStorage.sanitizeDeliveryProof(records.deliveryProof?.value);
      this.state.canonicalHead = this.syncStorage.sanitizeCanonicalHead(records.canonicalHead?.value);
      this.state.projectionPending = records.projectionPending?.value ?? null;
      this.state.outgoingSync = records.outgoingSync?.value || null;
      this.state.timerDependencies = records.timerDependencies?.value ?? null;
      this.state.workspaceObservation = records.workspaceObservation?.value ?? null;
      this.state.completionState = records.completionState?.value ?? null;
      this.state.durationSyncBootstrapped = settings?.value?.durationSyncBootstrapped === true;
      this.state.autoStartSyncBootstrapped = settings?.value?.autoStartSyncBootstrapped === true;
      this.state.selectedTaskSyncBootstrapped = settings?.value?.selectedTaskSyncBootstrapped === true;
      this.state.bootstrapPending = normalizedLegacyDurations.resolution || bootstrapResolution?.value || null;
      if (settings?.value) this.state.selectedPhase = this.use.phaseConfig()[settings.value.selectedPhase]
        ? settings.value.selectedPhase : "focus";
      this.restoreLocalSnapshot(snapshot?.value);
      const highest = this.state.pending.reduce(
        (value, command) => Math.max(value, Number(command.deviceSequence) || 0), 0
      );
      this.state.deviceSequence = Math.max(this.state.deviceSequence, highest);
    }

    async persistNewLocalIdentity(records, context = this.use.captureAccountContext()) {
      accountOperation.requireBound(context);
      if (records.deviceId?.value) return;
      await this.syncStorage.guardedMutation(this.connection.database(), [], (transaction) => {
        const store = transaction.objectStore(META_STORE);
        store.put({ key: "deviceId", value: this.state.deviceId });
        store.put({ key: "deviceSequence", value: this.state.deviceSequence });
        store.put({ key: "hlc", value: { wallMs: this.state.hlcWallMs, counter: this.state.hlcCounter } });
        store.put({ key: "settings", value: this.settingsValue() });
      }, { ...context, allowBootstrap: true });
    }

    acquireBootstrapGate(context = this.use.captureAccountContext()) {
      accountOperation.requireBound(context);
      return this.syncStorage.acquireBootstrapGateWithLegacyAutoStart(this.connection.database(), {
        ...context,
        token: this.use.tabId(), nowMs: Date.now(), leaseMs: BOOTSTRAP_LEASE_MS,
        legacyAutoStartOperationId: this.host.crypto.randomUUID(),
        legacySelectedTaskOperationId: this.host.crypto.randomUUID()
      });
    }

    async loadLocalState(issuer = null) {
      if (issuer) accountOperation.requireBound(issuer);
      const opened = await this.connection.openDatabase();
      try { if (issuer) accountOperation.requireBound(issuer); }
      catch (error) { opened.close(); throw error; }
      this.connection.setDatabaseForTest(opened);
      const context = this.use.captureAccountContext();
      try { return await this.restoreLocalWorkspace(context); }
      catch (error) {
        if (accountOperation.isCurrent(context)) error.startupContext = this.connection.captureDatabaseContext();
        throw error;
      }
    }

    async restoreLocalWorkspace(context) {
      const initial = await this.syncStorage.readSyncState(this.connection.database());
      context.assertCurrent();
      this.assertDisplayContext(initial);
      context.publishIdentity(() => { this.state.localOwnerId = this.syncCore.accountOwnerId(initial.snapshot?.user); });
      const lease = await this.acquireBootstrapGate(context);
      context.assertCurrent();
      this.state.bootstrapGatePersisted = true;
      this.state.bootstrapGateOwned = lease.acquired;
      const database = this.connection.database();
      const bootstrapState = await this.syncStorage.readBootstrapState(database);
      context.assertCurrent();
      if (this.state.bootstrapGateOwned && !bootstrapState.resolution) {
        await this.syncStorage.migrateLegacyDependencies(database, {
          ...context, deviceId: initial.deviceId || this.state.deviceId, nowMs: Date.now()
        });
        context.assertCurrent();
        await this.migrateDurationQueueFromSettings(context);
        context.assertCurrent();
        await this.bootstrapLegacyDurations(context);
        context.assertCurrent();
      }
      const normalized = this.state.bootstrapGateOwned ? await this.syncStorage.normalizeLegacyDurationOperations(database, {
        ...context, ...(this.state.bootstrapGateOwned ? {
          gateToken: this.use.tabId(), replacementRequestId: this.host.crypto.randomUUID()
        } : {})
      }) : { resolution: bootstrapState.resolution };
      context.assertCurrent();
      const records = await this.readLocalRecords();
      context.assertCurrent();
      this.syncStorage.assertAccountOwnership(records.snapshot?.value, context.expectedUserId);
      context.publishIdentity(() => this.restoreLocalRecords(records, normalized));
      await this.persistNewLocalIdentity(records, context);
      context.assertCurrent();
      this.use.rebuildOptimisticState();
      this.use.quarantineOwnerState();
      return this.connection.captureDatabaseContext();
    }

    async refreshMigratedPreferences(gate, context) {
      accountOperation.requireBound(context);
      if (!gate?.legacyAutoStartMigration?.migrated && !gate?.legacySelectedTaskMigration?.migrated) return;
      const queues = await this.syncStorage.readSyncState(this.connection.database());
      context.assertCurrent();
      this.syncStorage.assertAccountOwnership(queues.snapshot, context.expectedUserId);
      const local = this.state.quarantinedLocal || this.state;
      local.pendingAutoStartOperations = queues.autoStartOperations || [];
      local.pendingSelectedTaskOperations = queues.selectedTaskOperations || [];
      if (local === this.state) this.use.rebuildOptimisticState();
      else this.use.projectOwnerState(local);
    }

    async persistSettings() {
      const expectedUserId = this.syncCore.accountOwnerId(this.state.user) || this.state.localOwnerId || null;
      const context = this.use.captureAccountContext();
      const settings = this.settingsValue();
      while (this.state.actionLocked) await new Promise((resolve) => this.host.setTimeout(resolve, timingMs("defer", 0)));
      await this.syncStorage.guardedMutation(this.connection.database(), [], (transaction) => {
        transaction.objectStore(META_STORE).put({ key: "settings", value: settings });
      }, { ...context, expectedUserId, deviceId: this.state.deviceId })
        .catch((error) => storageFailure(error, this.use));
    }

    assertDisplayContext(records) {
      // While bootstrap quarantines the local owner state, the persisted
      // projection belongs to the quarantined copy. The reset display state has
      // no retained queues, so handing it the projection makes every render
      // fail Core's projection check. Validation below still runs.
      if (!this.state.quarantinedLocal) this.state.projectionPending = records.projectionPending ?? null;
      if (records.projectionPending == null) return;
      try { this.syncStorage.assertPersistedDisplayContext(records, records.deviceId || this.state.deviceId); }
      catch (error) {
        if (error.name !== "PersistedDisplayContextError") throw error;
        const message = this.use.tr("notice.savedDataBlocked", {},
          "Data saved on this device needs recovery. Reload the page.");
        Object.assign(this.state, { workspaceBlocked: true, bootstrapBlocked: true,
          bootstrapError: message, conflict: message });
        // A standing notice: a change refused while it shows leaves it in place.
        this.use.showNotice(message, { precedence: "standing" });
        throw error;
      }
    }

    async validatePersistedDisplayContext(context) {
      accountOperation.requireBound(context);
      const records = await this.syncStorage.readSyncState(this.connection.database());
      context.assertCurrent();
      this.assertDisplayContext(records);
      return records;
    }

    async reloadPersistedState(persisted = null, context = this.use.captureAccountContext(), failureOwner = "storage") {
      accountOperation.requireBound(context);
      const expectedUserId = this.syncCore.accountOwnerId(this.state.user) || this.state.localOwnerId || null;
      const syncState = persisted || await this.syncStorage.readSyncState(this.connection.database());
      if (!syncState.snapshot) throw new Error(this.use.tr(
        "sync.snapshotUnavailable", {}, "Canonical timer snapshot is unavailable."
      ));
      const snapshot = syncState.snapshot;
      try {
        context.assertCurrent();
        this.use.assertExpectedAccount(expectedUserId);
        this.syncStorage.assertAccountOwnership(snapshot, expectedUserId);
      } catch (error) {
        if (!accountOperation.isCurrent(context) || failureOwner === "mutation") throw error;
        storageFailure(error, this.use);
      }
      this.assertDisplayContext(syncState);
      context.publishIdentity(() => this.installPersistedState(syncState));
    }

    installPersistedState(syncState) {
      const snapshot = syncState.snapshot;
      this.state.revision = Number(snapshot.revision) || 0;
      this.state.baseDurationsMs = this.use.clone(snapshot.durationsMs);
      this.state.durationsMs = this.use.clone(this.state.baseDurationsMs);
      this.state.baseAutoStartBreaks = snapshot.autoStartBreaks === true;
      this.state.baseSelectedTaskId = snapshot.selectedTaskId ?? null;
      this.state.baseTimer = snapshot.canonicalTimer ? this.use.clone(snapshot.canonicalTimer)
        : this.use.emptyTimer(this.state.selectedPhase, this.state.baseDurationsMs[this.state.selectedPhase]);
      this.state.baseHistory = Array.isArray(snapshot.history) ? snapshot.history : [];
      this.state.baseTasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
      this.state.localOwnerId = this.syncCore.accountOwnerId(snapshot.user) || this.state.localOwnerId;
      this.state.hlcWallMs = Number(syncState.hlc?.wallMs) || this.state.hlcWallMs;
      this.state.hlcCounter = Number(syncState.hlc?.counter) || 0;
      this.state.clockOffset = syncState.clockOffset || this.state.clockOffset;
      this.state.pending = (syncState.commands || []).sort(this.use.compareTimerCommands);
      this.state.pendingTaskOperations = syncState.taskOperations || [];
      this.state.pendingDurationOperations = (syncState.durationOperations || []).sort(this.use.compareDurationOperations);
      this.state.pendingAutoStartOperations = syncState.autoStartOperations || [];
      this.state.pendingSelectedTaskOperations = syncState.selectedTaskOperations || [];
      this.state.deliveryProof = this.syncStorage.sanitizeDeliveryProof(syncState.deliveryProof);
      this.state.canonicalHead = this.syncStorage.sanitizeCanonicalHead(syncState.canonicalHead);
      this.state.projectionPending = syncState.projectionPending ?? null;
      this.state.outgoingSync = syncState.outgoing || null;
      this.state.timerDependencies = syncState.timerDependencies ?? null;
      this.state.workspaceObservation = syncState.workspaceObservation ?? null;
      this.state.completionState = syncState.completionState ?? null;
      if (syncState.settings) this.state.selectedPhase = syncState.settings.selectedPhase;
      if (syncState.deviceSequence != null) this.state.deviceSequence = syncState.deviceSequence;
      this.use.rebuildOptimisticState();
    }
  }

  class MutationRepository {
    constructor(state, external, use, connection, localState) {
      Object.assign(this, { state, use, connection, localState }, external);
      this.inFlightDurationOperationIds = new Set();
    }

    actions() {
      return bindActions(this, [
        "persistCommand", "persistTaskOperation", "persistAutoStartOperation",
        "persistSelectedTaskOperation", "persistDurationOperation", "persistRetargetOperation",
        "setInFlightDurationOperationIds", "persistWorkspaceIntent", "persistWorkspaceCompletion"
      ]);
    }

    mutationInput(extra, context) {
      const localNowMs = Date.now();
      const { context: _context, ...options } = extra;
      return { ...context, deviceId: this.state.deviceId,
        tabId: this.use.tabId(), nowMs: this.use.trustedNow(localNowMs), localNowMs,
        leaseMs: TIMER_OWNER_LEASE_MS, monotonicMs: this.host.performance?.now?.() ?? null,
        continuityId: this.use.clockContinuityId?.() ?? null, timerUuid: this.host.crypto.randomUUID(),
        inFlightDurationOperationIds: [...this.inFlightDurationOperationIds], ...options };
    }

    async commitWorkspace(extra) {
      const context = extra.context || this.use.captureAccountContext();
      try { accountOperation.requireBound(context); }
      catch (error) { rethrowOwnershipWithoutReport(error, this.use); }
      const input = this.mutationInput(extra, context);
      const plan = await this.syncStorage.planWorkspaceMutation(this.connection.database(), input)
        .catch((error) => {
          if (error.name === "LegacyDependencyRecoveryError" && accountOperation.isCurrent(context)) {
            this.state.workspaceBlocked = error.recovery.blocksMutations;
            this.state.workspaceRecovery = error.recovery;
            this.state.conflict = error.message;
          }
          rethrowOwnershipWithoutReport(error, this.use);
        });
      try {
        input.assertCurrent();
        this.use.assertExpectedAccount(input.ownerId);
        if (plan.outcome === "planned") await this.localState.reloadPersistedState(null, context, "mutation");
        input.assertCurrent();
      } catch (error) { rethrowOwnershipWithoutReport(error, this.use); }
      return plan;
    }

    persistWorkspaceIntent(intent, options = {}) {
      return this.commitWorkspace({ intent, ...options });
    }

    persistWorkspaceCompletion(stage, requestedTimer, context = this.use.captureAccountContext()) {
      accountOperation.requireBound(context);
      return this.commitWorkspace({ stage, requestedTimer, context });
    }

    async persistCommand(type) {
      const plan = await this.persistWorkspaceIntent({ kind: type });
      return plan.commands[0] ?? null;
    }

    async persistTaskOperation(type, task, expectedUserId = this.use.captureAccountContext().ownerId) {
      const intent = type === "upsert" ? { kind: "upsertTask", title: task.title }
        : { kind: "deleteTask", taskId: task.id };
      const plan = await this.persistWorkspaceIntent(intent, { preference: true, ownerId: expectedUserId });
      return plan.durableOperations?.taskOperations[0] ?? null;
    }

    async persistAutoStartOperation(enabled, expectedUserId = this.use.captureAccountContext().ownerId) {
      const plan = await this.persistWorkspaceIntent({ kind: "setAutoStart", enabled }, { preference: true, ownerId: expectedUserId });
      return plan.durableOperations?.autoStartOperations[0] ?? null;
    }

    async persistSelectedTaskOperation(taskId, expectedUserId = this.use.captureAccountContext().ownerId) {
      const plan = await this.persistWorkspaceIntent({ kind: "selectTask", taskId }, { preference: true, ownerId: expectedUserId });
      return plan.durableOperations?.selectedTaskOperations[0] ?? null;
    }

    async persistRetargetOperation(timerId, taskId) {
      const plan = await this.persistWorkspaceIntent({ kind: "selectTask", taskId }, {
        preference: true, requestedTimer: this.state.timer
      });
      return plan.commands[0] ?? null;
    }

    async persistDurationOperation(phase, durationMs) {
      const plan = await this.persistWorkspaceIntent({ kind: "setDuration", phase, minutes: durationMs / 60000 }, { preference: true });
      return { operation: plan.durableOperations?.durationOperations[0] ?? null,
        pendingDurationOperations: this.state.pendingDurationOperations };
    }

    setInFlightDurationOperationIds(values) {
      this.inFlightDurationOperationIds = new Set(values);
    }
  }

  function isPendingTaskDeletion(record) {
    return typeof record?.taskId === "string" && record.taskId !== ""
      && (record.ownerId === null || typeof record.ownerId === "string")
      && typeof record.tabId === "string";
  }

  // A task delete waits in an undo window and is issued when the window ends.
  // A page that unloads inside the window cannot finish the asynchronous
  // delete, so a synchronous marker carries the intent to the next startup.
  // The page holds a Web Lock for as long as its window is open: a free lock
  // tells the next startup that no page can still offer Undo for the task.
  class PendingTaskDeletionMarkers {
    constructor(state, external, use) {
      Object.assign(this, { state, use }, external);
      this.undoWindowLocks = new Map();
      // Tasks whose undo window, or the delete that follows it, is live in
      // this page: replay leaves them to the page's own delete.
      this.liveTaskDeletions = new Set();
      this.reportedFailureNames = new Set();
    }

    actions() {
      return bindActions(this, [
        "markPendingTaskDeletion", "clearPendingTaskDeletion", "clearPendingTaskDeletions",
        "pendingTaskDeletions", "replayPendingTaskDeletions", "workspaceOwnerId"
      ]);
    }

    workspaceOwnerId() {
      return this.syncCore.accountOwnerId(this.state.user) || this.state.localOwnerId || null;
    }

    // An unreadable marker reads as no marker: nothing is deleted from it.
    pendingTaskDeletions() {
      try {
        const records = JSON.parse(this.host.localStorage.getItem(PENDING_TASK_DELETIONS_KEY) || "[]");
        return Array.isArray(records) ? records.filter(isPendingTaskDeletion) : [];
      } catch (error) {
        this.reportMarkerFailure(error);
        return [];
      }
    }

    writePendingTaskDeletions(records) {
      try {
        if (records.length) this.host.localStorage.setItem(PENDING_TASK_DELETIONS_KEY, JSON.stringify(records));
        else this.host.localStorage.removeItem(PENDING_TASK_DELETIONS_KEY);
        return true;
      } catch (error) {
        this.reportMarkerFailure(error);
        return false;
      }
    }

    reportMarkerFailure(error) {
      const name = ["QuotaExceededError", "SecurityError", "SyntaxError"].includes(error?.name) ? error.name : "StorageError";
      if (this.reportedFailureNames.has(name)) return;
      this.reportedFailureNames.add(name);
      // Storage exceptions can contain stored values; only the failure class is reported.
      const failure = new Error("Pending task deletion marker storage failed.");
      failure.name = name;
      this.host.console?.warn("Pomodorough pending task deletion marker storage failed:", failure);
      reportFrontendError(failure, "storage.failure");
    }

    markPendingTaskDeletion(task) {
      const record = { taskId: task.id, ownerId: this.workspaceOwnerId(), tabId: this.use.tabId() };
      const others = this.pendingTaskDeletions().filter((item) => item.taskId !== task.id);
      this.liveTaskDeletions.add(task.id);
      this.holdUndoWindowLock(task.id);
      return this.writePendingTaskDeletions([...others, record]);
    }

    clearPendingTaskDeletion(taskId) {
      const records = this.pendingTaskDeletions();
      const others = records.filter((item) => item.taskId !== taskId);
      if (others.length !== records.length) this.writePendingTaskDeletions(others);
      this.liveTaskDeletions.delete(taskId);
      this.releaseUndoWindowLock(taskId);
    }

    clearPendingTaskDeletions() {
      this.writePendingTaskDeletions([]);
      this.liveTaskDeletions.clear();
      for (const taskId of [...this.undoWindowLocks.keys()]) this.releaseUndoWindowLock(taskId);
    }

    holdUndoWindowLock(taskId) {
      const locks = this.host.navigator?.locks;
      if (!locks || this.undoWindowLocks.has(taskId)) return;
      let release;
      const windowEnded = new Promise((resolve) => { release = resolve; });
      this.undoWindowLocks.set(taskId, release);
      Promise.resolve(locks.request(TASK_DELETION_UNDO_LOCK + taskId, () => windowEnded))
        .catch((error) => this.reportMarkerFailure(error));
    }

    releaseUndoWindowLock(taskId) {
      this.undoWindowLocks.get(taskId)?.();
      this.undoWindowLocks.delete(taskId);
    }

    // Without Web Locks only the tab that wrote a marker replays it, after a
    // reload: another tab cannot know that the undo window is closed.
    claimEndedUndoWindow(record, replay) {
      if (this.liveTaskDeletions.has(record.taskId)) return false;
      const locks = this.host.navigator?.locks;
      if (!locks) return record.tabId === this.use.tabId() ? replay() : false;
      return locks.request(TASK_DELETION_UNDO_LOCK + record.taskId, { ifAvailable: true },
        (lock) => (lock ? replay() : false));
    }

    // Replays the markers left by a page that died inside its undo window,
    // the only way a marker outlives its page. Replay never rejects: startup
    // does not wait on it.
    async replayPendingTaskDeletions() {
      // A workspace in sign-out recovery is being discarded with its markers.
      // Under any other block each claimed marker is refused like a delete in
      // view: its marker is cleared and, when the display shows the task, the
      // refusal notice tells the person the task is still there, so it is
      // never deleted silently later.
      if (this.state.logoutRecoveryRequired) {
        this.clearPendingTaskDeletions();
        return 0;
      }
      let replayed = 0;
      for (const record of this.pendingTaskDeletions()) {
        try {
          if (await this.claimEndedUndoWindow(record, () => this.replayPendingTaskDeletion(record))) replayed += 1;
        } catch (error) {
          this.reportMarkerFailure(error);
        }
      }
      return replayed;
    }

    // Fail closed: a marker another page already settled, a marker of another
    // workspace owner and a marker for a task that is not in the workspace are
    // dropped without a notice. Only the task the marker names is ever
    // deleted, and only deleteTask decides; under blocked controls it refuses
    // with its notice. A blocked display that holds no tasks yet cannot show
    // the task exists, so its marker is dropped silently: saying "could not be
    // deleted" about a task that may already be gone would be false.
    async replayPendingTaskDeletion(record) {
      const pending = this.pendingTaskDeletions().some((item) => item.taskId === record.taskId);
      const owned = pending && record.ownerId === this.workspaceOwnerId();
      const task = owned ? this.state.tasks.find((item) => item.id === record.taskId) : null;
      try {
        if (!task) return false;
        return await this.use.deleteTask(task) === true;
      } finally {
        this.clearPendingTaskDeletion(record.taskId);
      }
    }
  }

  function create({ state, external, use }) {
    const deletionMarkers = new PendingTaskDeletionMarkers(state, external, use);
    const connection = new DatabaseConnection(state, external, use, deletionMarkers);
    const localState = new LocalStateRepository(state, external, use, connection);
    const mutations = new MutationRepository(state, external, use, connection, localState);
    return { ...connection.actions(), ...localState.actions(), ...mutations.actions(), ...deletionMarkers.actions() };
  }

  return Object.freeze({
    DB_NAME, DB_VERSION, META_STORE, PENDING_STORE, TASK_PENDING_STORE,
    DURATION_PENDING_STORE, AUTO_START_PENDING_STORE, SELECTED_TASK_PENDING_STORE,
    manifest, create
  });
});
