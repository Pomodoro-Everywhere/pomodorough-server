(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PomodoroughAppStorage = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DB_NAME = "pomodorough";
  const DB_VERSION = 5;
  const META_STORE = "meta";
  const PENDING_STORE = "pending";
  const TASK_PENDING_STORE = "pendingTasks";
  const DURATION_PENDING_STORE = "pendingDurations";
  const AUTO_START_PENDING_STORE = "pendingAutoStarts";
  const SELECTED_TASK_PENDING_STORE = "pendingSelectedTasks";
  const BOOTSTRAP_LEASE_MS = 5 * 60_000;
  const TIMER_OWNER_LEASE_MS = 60_000;
  const PENDING_LOGOUT_KEY = "pomodoroughPendingLogout";
  const PENDING_LOGOUT_OWNER_KEY = "pomodoroughPendingLogoutOwner";
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

  function storageFailure(error, use) {
    if (error.name === "AccountOwnershipError") use.quarantineAccountMismatch();
    throw error;
  }

  const manifest = Object.freeze({
    name: "storage",
    externals: ["host", "syncCore", "syncStorage"],
    requires: [
      "captureAccountContext",
      "clone", "emptyTimer", "normalizeTimer", "normalizeDurationsMs", "selectedDurationMs",
      "selectedTaskIdForNextFocus", "compareDurationOperations", "compareTimerCommands",
      "clampNumber", "trustedNow", "elapsedFor", "rebuildOptimisticState",
      "quarantineOwnerState", "quarantineAccountMismatch", "assertExpectedAccount", "projectOwnerState", "tr", "phaseConfig",
      "defaultDurationsMs", "tabId"
    ],
    provides: [
      "openDatabase", "requestResult", "transactionDone", "settingsValue", "snapshotValue",
      "migrateDurationQueueFromSettings", "bootstrapLegacyDurations", "readPendingDurationOperations",
      "refreshPendingDurationOperations", "readLocalRecords", "restoreLocalRecords",
      "persistNewLocalIdentity", "loadLocalState", "acquireBootstrapGate",
      "refreshMigratedPreferences", "persistSettings", "persistCommand", "persistTaskOperation",
      "persistAutoStartOperation", "persistSelectedTaskOperation", "persistDurationOperation",
      "reloadPersistedState", "clearLocalData", "database", "setDatabaseForTest",
      "setInFlightDurationOperationIds", "cleanupIdentity", "assertCleanupIdentity"
    ],
    emits: [],
    listens: []
  });

  class DatabaseConnection {
    constructor(state, external, use) {
      Object.assign(this, { state, use }, external);
      this.db = null;
    }

    actions() {
      return bindActions(this, [
        "openDatabase", "requestResult", "transactionDone", "clearLocalData",
        "database", "setDatabaseForTest", "cleanupIdentity", "assertCleanupIdentity"
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

    confirmCleanupAlreadyComplete(identity) {
      return this.syncStorage.guardedMutation(this.db, ALL_STORES, (transaction, _outcome, abort) => {
        this.assertCleanupIdentity(identity);
        const meta = transaction.objectStore(META_STORE);
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
        assertCurrent: () => this.assertCleanupIdentity(identity) });
    }

    async clearAuthorizedLocalData(identity) {
      if (!this.db) this.db = await this.openDatabase();
      await this.syncStorage.guardedMutation(this.db, ALL_STORES, (transaction) => {
        this.assertCleanupIdentity(identity);
        for (const storeName of ALL_STORES) transaction.objectStore(storeName).clear();
      }, { expectedUserId: identity.expectedUserId, currentUserId: identity.expectedUserId,
        assertCurrent: () => this.assertCleanupIdentity(identity), allowBootstrap: true }).catch((error) => {
        if (error.name !== "AccountOwnershipError" || !(identity.recovery || identity.authenticatedUserId)) throw error;
        return this.confirmCleanupAlreadyComplete(identity);
      }).catch((error) => storageFailure(error, this.use));
      this.db.close();
      this.db = null;
    }

    async clearLocalData(identity = this.cleanupIdentity()) {
      if (!this.cleanup) {
        this.cleanup = this.clearAuthorizedLocalData(identity).finally(() => {
          this.cleanup = null;
        });
      } else {
        await this.cleanup;
        return this.clearLocalData(identity);
      }
      await this.cleanup;
      this.assertCleanupIdentity(identity);
    }

    database() { return this.db; }
    setDatabaseForTest(value) { this.db = value; }
  }

  class LocalStateRepository {
    constructor(state, external, use, connection) {
      Object.assign(this, { state, use, connection }, external);
    }

    actions() {
      return bindActions(this, [
        "settingsValue", "snapshotValue", "migrateDurationQueueFromSettings",
        "bootstrapLegacyDurations", "readPendingDurationOperations", "refreshPendingDurationOperations",
        "readLocalRecords", "restoreLocalRecords", "persistNewLocalIdentity", "loadLocalState",
        "acquireBootstrapGate", "refreshMigratedPreferences", "persistSettings", "reloadPersistedState"
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
        revision: this.state.revision, canonicalTimer: this.use.clone(this.state.baseTimer),
        history: this.use.clone(this.state.baseHistory), tasks: this.use.clone(this.state.baseTasks),
        durationsMs: this.use.clone(this.state.baseDurationsMs), autoStartBreaks: this.state.baseAutoStartBreaks,
        selectedTaskId: this.state.baseSelectedTaskId, user: this.use.clone(this.state.user), ...overrides
      };
    }

    async migrateDurationQueueFromSettings() {
      const context = this.use.captureAccountContext();
      await this.syncStorage.guardedMutation(this.connection.database(), [DURATION_PENDING_STORE], (transaction) => {
        const metaStore = transaction.objectStore(META_STORE);
        const durationStore = transaction.objectStore(DURATION_PENDING_STORE);
        const request = metaStore.get("settings");
        request.onsuccess = () => {
          const record = request.result;
          const pending = record?.value?.pendingDurationOperations;
          if (!Array.isArray(pending)) return;
          for (const operation of pending) {
            durationStore.put(Number(operation?.hlcWallMs) === 0 && Number(operation?.hlcCounter) === 0
              ? { ...operation, occurredAt: new Date(0).toISOString() } : operation);
          }
          const { pendingDurationOperations, ...settings } = record.value;
          metaStore.put({ key: "settings", value: settings });
        };
      }, { ...context, allowBootstrap: true });
    }

    async bootstrapLegacyDurations() {
      const context = this.use.captureAccountContext();
      await this.syncStorage.guardedMutation(this.connection.database(), [DURATION_PENDING_STORE], (transaction) => {
        const metaStore = transaction.objectStore(META_STORE);
        const durationStore = transaction.objectStore(DURATION_PENDING_STORE);
        const request = metaStore.get("settings");
        request.onsuccess = () => {
          const settings = request.result?.value || {};
          if (settings.durationSyncBootstrapped === true) return;
          for (const phase of Object.keys(this.use.phaseConfig())) {
            if (settings.durations?.[phase] == null) continue;
            const durationMs = Math.round(this.use.clampNumber(settings.durations[phase], 1, 180)) * 60_000;
            if (durationMs === this.use.defaultDurationsMs()[phase]) continue;
            durationStore.put({
              id: this.host.crypto.randomUUID(), ownerId: "bootstrap", phase, durationMs,
              occurredAt: new Date(0).toISOString(), hlcWallMs: 0, hlcCounter: 0
            });
          }
          const { durations, ...localSettings } = settings;
          metaStore.put({
            key: "settings", value: { ...localSettings, durationSyncBootstrapped: true }
          });
        };
      }, { ...context, allowBootstrap: true });
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
        this.connection.requestResult(transaction.objectStore(SELECTED_TASK_PENDING_STORE).getAll())
      ]);
      const names = [
        "deviceId", "deviceSequence", "hlc", "clockOffset", "settings", "snapshot",
        "bootstrapResolution", "pending", "pendingTaskOperations", "pendingDurationOperations",
        "pendingAutoStartOperations", "pendingSelectedTaskOperations"
      ];
      return Object.fromEntries(names.map((name, index) => [name, values[index]]));
    }

    restoreLocalSnapshot(snapshot) {
      if (!snapshot) {
        this.state.baseTimer = this.use.emptyTimer(this.state.selectedPhase, this.use.selectedDurationMs());
        return;
      }
      this.state.revision = snapshot.revision ?? 0;
      this.state.baseTimer = this.use.normalizeTimer(snapshot.canonicalTimer);
      this.state.baseHistory = Array.isArray(snapshot.history) ? snapshot.history : [];
      this.state.baseTasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
      this.state.baseDurationsMs = this.use.normalizeDurationsMs(snapshot.durationsMs);
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
      this.state.clockOffset = this.syncCore.validClockSample(clockOffset?.value) ? clockOffset.value : null;
      this.state.pending = (records.pending || []).sort(this.use.compareTimerCommands);
      this.state.pendingTaskOperations = records.pendingTaskOperations || [];
      this.state.pendingDurationOperations = (records.pendingDurationOperations || []).sort(this.use.compareDurationOperations);
      this.state.pendingAutoStartOperations = records.pendingAutoStartOperations || [];
      this.state.pendingSelectedTaskOperations = records.pendingSelectedTaskOperations || [];
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

    async persistNewLocalIdentity(records) {
      if (records.deviceId?.value) return;
      const context = this.use.captureAccountContext();
      await this.syncStorage.guardedMutation(this.connection.database(), [], (transaction) => {
        const store = transaction.objectStore(META_STORE);
        store.put({ key: "deviceId", value: this.state.deviceId });
        store.put({ key: "deviceSequence", value: this.state.deviceSequence });
        store.put({ key: "hlc", value: { wallMs: this.state.hlcWallMs, counter: this.state.hlcCounter } });
        store.put({ key: "settings", value: this.settingsValue() });
      }, { ...context, allowBootstrap: true });
    }

    acquireBootstrapGate() {
      return this.syncStorage.acquireBootstrapGateWithLegacyAutoStart(this.connection.database(), {
        ...this.use.captureAccountContext(),
        token: this.use.tabId(), nowMs: Date.now(), leaseMs: BOOTSTRAP_LEASE_MS,
        legacyAutoStartOperationId: this.host.crypto.randomUUID(),
        legacySelectedTaskOperationId: this.host.crypto.randomUUID()
      });
    }

    async loadLocalState() {
      this.connection.setDatabaseForTest(await this.connection.openDatabase());
      const initial = await this.syncStorage.readSyncState(this.connection.database());
      this.state.localOwnerId = this.syncCore.accountOwnerId(initial.snapshot?.user);
      const context = this.use.captureAccountContext();
      const lease = await this.acquireBootstrapGate();
      this.state.bootstrapGatePersisted = true;
      this.state.bootstrapGateOwned = lease.acquired;
      const database = this.connection.database();
      const bootstrapState = await this.syncStorage.readBootstrapState(database);
      if (this.state.bootstrapGateOwned && !bootstrapState.resolution) {
        await this.migrateDurationQueueFromSettings();
        await this.bootstrapLegacyDurations();
      }
      const normalized = this.state.bootstrapGateOwned ? await this.syncStorage.normalizeLegacyDurationOperations(database, {
        ...context, ...(this.state.bootstrapGateOwned ? {
          gateToken: this.use.tabId(), replacementRequestId: this.host.crypto.randomUUID()
        } : {})
      }) : { resolution: bootstrapState.resolution };
      const records = await this.readLocalRecords();
      context.assertCurrent();
      this.syncStorage.assertAccountOwnership(records.snapshot?.value, context.expectedUserId);
      this.restoreLocalRecords(records, normalized);
      await this.persistNewLocalIdentity(records);
      this.use.rebuildOptimisticState();
      this.use.quarantineOwnerState();
    }

    async refreshMigratedPreferences(gate) {
      if (!gate?.legacyAutoStartMigration?.migrated && !gate?.legacySelectedTaskMigration?.migrated) return;
      const context = this.use.captureAccountContext();
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
      while (this.state.actionLocked) await new Promise((resolve) => this.host.setTimeout(resolve, 0));
      await this.syncStorage.guardedMutation(this.connection.database(), [], (transaction) => {
        transaction.objectStore(META_STORE).put({ key: "settings", value: settings });
      }, { ...context, expectedUserId }).catch((error) => storageFailure(error, this.use));
    }

    async reloadPersistedState(persisted = null) {
      const expectedUserId = this.syncCore.accountOwnerId(this.state.user) || this.state.localOwnerId || null;
      const context = this.use.captureAccountContext();
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
        storageFailure(error, this.use);
      }
      this.state.revision = Number(snapshot.revision) || 0;
      this.state.baseDurationsMs = this.use.normalizeDurationsMs(snapshot.durationsMs);
      this.state.durationsMs = this.use.clone(this.state.baseDurationsMs);
      this.state.baseAutoStartBreaks = snapshot.autoStartBreaks === true;
      this.state.baseSelectedTaskId = snapshot.selectedTaskId ?? null;
      this.state.baseTimer = snapshot.canonicalTimer ? this.use.normalizeTimer(snapshot.canonicalTimer)
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
      this.use.rebuildOptimisticState();
    }
  }

  class MutationRepository {
    constructor(state, external, use, connection) {
      Object.assign(this, { state, use, connection }, external);
      this.inFlightDurationOperationIds = new Set();
    }

    actions() {
      return bindActions(this, [
        "persistCommand", "persistTaskOperation", "persistAutoStartOperation",
        "persistSelectedTaskOperation", "persistDurationOperation", "setInFlightDurationOperationIds"
      ]);
    }

    timerCommandContext(type, options, localNow) {
      const activeTimer = this.state.timer;
      const starting = type === "start";
      const startingPhase = this.use.phaseConfig()[options.phase] ? options.phase : this.state.selectedPhase;
      const phase = starting ? startingPhase : activeTimer.phase;
      const timerId = starting ? this.host.crypto.randomUUID() : activeTimer.id;
      if (!timerId) throw new Error(this.use.tr("timer.noTimer", {}, "No timer is available for this action."));
      return {
        type, activeTimer, starting, startingPhase, phase, timerId, localNow,
        now: this.use.trustedNow(localNow),
        plannedDurationMs: starting ? this.state.durationsMs[startingPhase] : activeTimer.plannedDurationMs
      };
    }

    buildTimerCommand(context, allocation) {
      const command = {
        id: allocation.id, deviceId: this.state.deviceId, deviceSequence: allocation.deviceSequence,
        timerId: context.timerId, type: context.type, phase: context.phase,
        plannedDurationMs: context.plannedDurationMs,
        occurredAt: new Date(allocation.wallMs).toISOString(), hlcWallMs: allocation.wallMs,
        hlcCounter: allocation.counter, observedElapsedMs: context.starting ? 0
          : Math.round(this.use.elapsedFor(context.activeTimer, context.now))
      };
      const selectedTaskId = this.use.selectedTaskIdForNextFocus();
      if (context.starting && context.startingPhase === "focus" && selectedTaskId) command.taskId = selectedTaskId;
      if (!context.starting && context.activeTimer.dependsOnCommandId) {
        command.dependsOnCommandId = context.activeTimer.dependsOnCommandId;
      }
      return command;
    }

    async persistCommand(type, options = {}) {
      const localNow = Date.now();
      const context = this.timerCommandContext(type, options, localNow);
      const command = await this.allocateOperation({
        ...this.use.captureAccountContext(),
        expectedUserId: this.syncCore.accountOwnerId(this.state.user) || this.state.localOwnerId || null,
        storeName: PENDING_STORE, requireProjection: true, nowMs: context.now,
        withDeviceSequence: true, withUuidV7: true,
        timerOwner: context.starting ? {
          deviceId: this.state.deviceId, tabId: this.use.tabId(), nowMs: localNow, leaseMs: TIMER_OWNER_LEASE_MS
        } : null,
        build: (allocation) => this.buildTimerCommand(context, allocation)
      });
      this.state.deviceSequence = command.deviceSequence;
      this.state.hlcWallMs = command.hlcWallMs;
      this.state.hlcCounter = command.hlcCounter;
      return command;
    }

    mutationOptions(storeName, build, expectedUserId = this.syncCore.accountOwnerId(this.state.user) || this.state.localOwnerId || null) {
      return {
        ...this.use.captureAccountContext(), storeName, expectedUserId, requireProjection: true, nowMs: this.use.trustedNow(),
        withDeviceSequence: false, withUuidV7: true, build
      };
    }

    async allocateOperation(options) {
      const expectedUserId = options.expectedUserId;
      const operation = await this.syncStorage.allocateMutation(this.connection.database(), options)
        .catch((error) => storageFailure(error, this.use));
      try { options.assertCurrent?.(); } catch (error) { storageFailure(error, this.use); }
      this.use.assertExpectedAccount(expectedUserId);
      return operation;
    }

    async persistTaskOperation(type, task, expectedUserId) {
      const operation = await this.allocateOperation(this.mutationOptions(
        TASK_PENDING_STORE, ({ id, wallMs, counter }) => {
          const value = {
            id, deviceId: this.state.deviceId, taskId: task.id, type,
            occurredAt: new Date(wallMs).toISOString(), hlcWallMs: wallMs, hlcCounter: counter
          };
          if (type === "upsert") value.title = task.title;
          return value;
        }, expectedUserId
      ));
      this.recordOperationHlc(operation);
      return operation;
    }

    async persistAutoStartOperation(enabled, expectedUserId) {
      const operation = await this.allocateOperation(this.mutationOptions(
        AUTO_START_PENDING_STORE, ({ id, wallMs, counter }) => ({
          id, deviceId: this.state.deviceId, enabled, occurredAt: new Date(wallMs).toISOString(),
          hlcWallMs: wallMs, hlcCounter: counter
        }), expectedUserId
      ));
      this.recordOperationHlc(operation);
      return operation;
    }

    async persistSelectedTaskOperation(taskId, expectedUserId) {
      const operation = await this.allocateOperation(this.mutationOptions(
        SELECTED_TASK_PENDING_STORE, ({ id, wallMs, counter }) => ({
          id, deviceId: this.state.deviceId, taskId, occurredAt: new Date(wallMs).toISOString(),
          hlcWallMs: wallMs, hlcCounter: counter
        }), expectedUserId
      ));
      this.recordOperationHlc(operation);
      return operation;
    }

    recordOperationHlc(operation) {
      this.state.hlcWallMs = operation.hlcWallMs;
      this.state.hlcCounter = operation.hlcCounter;
    }

    async persistDurationOperation(phase, durationMs) {
      const options = this.mutationOptions(DURATION_PENDING_STORE, ({ id, wallMs, counter }) => ({
        id, deviceId: this.state.deviceId, ownerId: this.use.tabId(), phase, durationMs,
        occurredAt: new Date(wallMs).toISOString(), hlcWallMs: wallMs, hlcCounter: counter
      }));
      options.supersede = (existing) => existing.phase === phase
        && existing.ownerId === this.use.tabId() && !this.inFlightDurationOperationIds.has(existing.id);
      const database = this.connection.database();
      const operation = await this.allocateOperation(options);
      const queues = await this.syncStorage.readSyncState(database);
      try {
        options.assertCurrent();
        this.use.assertExpectedAccount(options.expectedUserId);
        this.syncStorage.assertAccountOwnership(queues.snapshot, options.expectedUserId);
      } catch (error) {
        storageFailure(error, this.use);
      }
      this.recordOperationHlc(operation);
      return {
        operation,
        pendingDurationOperations: (queues.durationOperations || []).sort(this.use.compareDurationOperations)
      };
    }

    setInFlightDurationOperationIds(values) {
      this.inFlightDurationOperationIds = new Set(values);
    }
  }

  function create({ state, external, use }) {
    const connection = new DatabaseConnection(state, external, use);
    const localState = new LocalStateRepository(state, external, use, connection);
    const mutations = new MutationRepository(state, external, use, connection);
    return { ...connection.actions(), ...localState.actions(), ...mutations.actions() };
  }

  return Object.freeze({
    DB_NAME, DB_VERSION, META_STORE, PENDING_STORE, TASK_PENDING_STORE,
    DURATION_PENDING_STORE, AUTO_START_PENDING_STORE, SELECTED_TASK_PENDING_STORE,
    manifest, create
  });
});
