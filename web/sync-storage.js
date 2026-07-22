(function (root, factory) {
  "use strict";

  const core = typeof module === "object" && module.exports
    ? require("./sync-core.js")
    : root.PomodoroughSync;
  const api = factory(core);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PomodoroughStorage = api;
})(typeof globalThis === "object" ? globalThis : this, function (core) {
  "use strict";

  const META_STORE = "meta";
  const PENDING_STORE = "pending";
  const TASK_PENDING_STORE = "pendingTasks";
  const DURATION_PENDING_STORE = "pendingDurations";
  const GATE_KEY = "bootstrapGate";
  const RESOLUTION_KEY = "bootstrapResolution";

  class BootstrapGateError extends Error {
    constructor(message = "History resolution blocks local changes.") {
      super(message);
      this.name = "BootstrapGateError";
    }
  }

  class ResolutionLimitError extends Error {
    constructor(violation) {
      const labels = {
        commands: "timer commands",
        taskOperations: "task operations",
        durationOperations: "duration operations"
      };
      super(`Cannot upload ${violation.count.toLocaleString("en-US")} queued ${labels[violation.field]}; server limit is ${violation.limit.toLocaleString("en-US")}. Keep Remote can discard local queued data without uploading it.`);
      this.name = "ResolutionLimitError";
      this.field = violation.field;
      this.count = violation.count;
      this.limit = violation.limit;
    }
  }

  class AccountOwnershipError extends Error {
    constructor() {
      super("Canonical account changed before sync apply.");
      this.name = "AccountOwnershipError";
    }
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error("Storage transaction aborted."));
      transaction.onerror = () => reject(transaction.error);
    });
  }

  function leaseValue(token, nowMs, leaseMs) {
    return { token, acquiredAtMs: nowMs, expiresAtMs: nowMs + leaseMs };
  }

  function leaseIsLive(gate, nowMs) {
    return Boolean(gate?.token && Number(gate.expiresAtMs) > nowMs);
  }

  function laterHlc(left, right) {
    const leftWallMs = Number(left?.wallMs) || 0;
    const rightWallMs = Number(right?.wallMs) || 0;
    if (leftWallMs !== rightWallMs) return leftWallMs > rightWallMs ? left : right;
    return (Number(left?.counter) || 0) >= (Number(right?.counter) || 0) ? left : right;
  }

  function acquireBootstrapGate(database, input) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(META_STORE, "readwrite");
      const store = transaction.objectStore(META_STORE);
      const gateRequest = store.get(GATE_KEY);
      const resolutionRequest = store.get(RESOLUTION_KEY);
      let remaining = 2;
      let existing;
      let resolution;
      let result;
      const acquire = () => {
        remaining -= 1;
        if (remaining !== 0) return;
        if (existing?.token !== input.token && leaseIsLive(existing, input.nowMs)) {
          result = { acquired: false, takenOver: false, gate: existing, resolution };
          return;
        }
        const gate = leaseValue(input.token, input.nowMs, input.leaseMs);
        const takenOver = Boolean(existing && existing.token !== input.token);
        if (resolution && resolution.gateToken !== input.token) {
          resolution = { ...resolution, gateToken: input.token };
          store.put({ key: RESOLUTION_KEY, value: resolution });
        }
        result = {
          acquired: true,
          takenOver,
          gate,
          resolution
        };
        store.put({ key: GATE_KEY, value: gate });
      };
      gateRequest.onsuccess = () => {
        existing = gateRequest.result?.value || null;
        acquire();
      };
      resolutionRequest.onsuccess = () => {
        resolution = resolutionRequest.result?.value || null;
        acquire();
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error || new Error("Storage transaction aborted."));
      transaction.onerror = () => {};
    });
  }

  async function readBootstrapState(database) {
    const transaction = database.transaction(META_STORE, "readonly");
    const store = transaction.objectStore(META_STORE);
    const [gate, resolution] = await Promise.all([
      requestResult(store.get(GATE_KEY)),
      requestResult(store.get(RESOLUTION_KEY))
    ]);
    return {
      gate: gate?.value || null,
      resolution: resolution?.value || null
    };
  }

  function clearBootstrapGate(database, token) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(META_STORE, "readwrite");
      const store = transaction.objectStore(META_STORE);
      const gateRequest = store.get(GATE_KEY);
      const resolutionRequest = store.get(RESOLUTION_KEY);
      let remaining = 2;
      let gate;
      let resolution;
      let failure = null;
      const clear = () => {
        remaining -= 1;
        if (remaining !== 0) return;
        if (resolution) {
          failure = new BootstrapGateError("Saved history resolution still requires completion.");
          transaction.abort();
          return;
        }
        if (!gate || gate.token !== token) {
          failure = new BootstrapGateError("Bootstrap gate is owned by another tab.");
          transaction.abort();
          return;
        }
        store.delete(GATE_KEY);
      };
      gateRequest.onsuccess = () => {
        gate = gateRequest.result?.value || null;
        clear();
      };
      resolutionRequest.onsuccess = () => {
        resolution = resolutionRequest.result?.value || null;
        clear();
      };
      transaction.oncomplete = () => resolve(true);
      transaction.onabort = () => reject(failure || transaction.error || new Error("Storage transaction aborted."));
      transaction.onerror = () => {};
    });
  }

  function guardedMutation(database, storeNames, operation) {
    return new Promise((resolve, reject) => {
      const names = [...new Set([META_STORE, ...storeNames])];
      const transaction = database.transaction(names, "readwrite");
      const metaStore = transaction.objectStore(META_STORE);
      const outcome = { value: undefined };
      let failure = null;
      let checksRemaining = 2;
      let gate;
      let resolution;
      const proceed = () => {
        checksRemaining -= 1;
        if (checksRemaining !== 0) return;
        if (gate || resolution) {
          failure = new BootstrapGateError();
          transaction.abort();
          return;
        }
        try {
          operation(transaction, outcome);
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      const gateRequest = metaStore.get(GATE_KEY);
      gateRequest.onsuccess = () => {
        gate = gateRequest.result;
        proceed();
      };
      const resolutionRequest = metaStore.get(RESOLUTION_KEY);
      resolutionRequest.onsuccess = () => {
        resolution = resolutionRequest.result;
        proceed();
      };
      transaction.oncomplete = () => resolve(outcome.value);
      transaction.onabort = () => reject(failure || transaction.error || new Error("Storage transaction aborted."));
      transaction.onerror = () => {};
    });
  }

  function allocateMutation(database, input) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction([META_STORE, input.storeName], "readwrite");
      const metaStore = transaction.objectStore(META_STORE);
      const requests = {
        gate: metaStore.get(GATE_KEY),
        resolution: metaStore.get(RESOLUTION_KEY),
        hlc: metaStore.get("hlc")
      };
      if (input.withDeviceSequence) requests.deviceSequence = metaStore.get("deviceSequence");
      const results = {};
      let remaining = Object.keys(requests).length;
      let allocated;
      let failure = null;
      const allocate = () => {
        remaining -= 1;
        if (remaining !== 0) return;
        if (results.gate || results.resolution) {
          failure = new BootstrapGateError();
          transaction.abort();
          return;
        }
        const storedHlc = results.hlc?.value || {};
        const storedWallMs = Number(storedHlc.wallMs) || 0;
        const storedCounter = Number(storedHlc.counter) || 0;
        const wallMs = Math.max(input.nowMs, storedWallMs);
        const counter = wallMs === storedWallMs ? storedCounter + 1 : 0;
        const deviceSequence = input.withDeviceSequence
          ? (Number(results.deviceSequence?.value) || 0) + 1
          : undefined;
        allocated = input.build({ wallMs, counter, deviceSequence });
        transaction.objectStore(input.storeName).add(allocated);
        metaStore.put({ key: "hlc", value: { wallMs, counter } });
        if (input.withDeviceSequence) metaStore.put({ key: "deviceSequence", value: deviceSequence });
      };
      for (const [name, request] of Object.entries(requests)) {
        request.onsuccess = () => {
          results[name] = request.result;
          allocate();
        };
      }
      transaction.oncomplete = () => resolve(allocated);
      transaction.onabort = () => reject(failure || transaction.error || new Error("Storage transaction aborted."));
      transaction.onerror = () => {};
    });
  }

  function captureResolution(database, input, options) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        [META_STORE, PENDING_STORE, TASK_PENDING_STORE, DURATION_PENDING_STORE],
        "readwrite"
      );
      const metaStore = transaction.objectStore(META_STORE);
      const requests = {
        gate: metaStore.get(GATE_KEY),
        resolution: metaStore.get(RESOLUTION_KEY),
        commands: transaction.objectStore(PENDING_STORE).getAll(),
        taskOperations: transaction.objectStore(TASK_PENDING_STORE).getAll(),
        durationOperations: transaction.objectStore(DURATION_PENDING_STORE).getAll()
      };
      const results = {};
      let remaining = Object.keys(requests).length;
      let pending;
      let failure = null;
      const persist = () => {
        remaining -= 1;
        if (remaining !== 0) return;
        const gate = results.gate?.value || null;
        if (!gate || gate.token !== options.gateToken) {
          failure = new BootstrapGateError("Bootstrap gate is owned by another tab.");
          transaction.abort();
          return;
        }
        const existingResolution = results.resolution?.value || null;
        if (existingResolution && !options.replaceExisting) {
          failure = new BootstrapGateError("Saved history resolution already exists.");
          transaction.abort();
          return;
        }
        const commands = (results.commands || []).sort((left, right) =>
          Number(left.deviceSequence) - Number(right.deviceSequence) || String(left.id).localeCompare(String(right.id))
        );
        const operationOrder = (left, right) =>
          Number(left.hlcWallMs) - Number(right.hlcWallMs)
          || Number(left.hlcCounter) - Number(right.hlcCounter)
          || String(left.id).localeCompare(String(right.id));
        pending = {
          ...core.createPendingResolution({
            ...input,
            commands,
            taskOperations: (results.taskOperations || []).sort(operationOrder),
            durationOperations: (results.durationOperations || []).sort(operationOrder)
          }),
          gateToken: options.gateToken
        };
        const violation = core.resolutionLimitViolation(pending.payload);
        if (violation) {
          failure = new ResolutionLimitError(violation);
          transaction.abort();
          return;
        }
        metaStore.put({ key: RESOLUTION_KEY, value: pending });
      };
      for (const [name, request] of Object.entries(requests)) {
        request.onsuccess = () => {
          results[name] = request.result;
          persist();
        };
      }
      transaction.oncomplete = () => resolve(pending);
      transaction.onabort = () => reject(failure || transaction.error || new Error("Storage transaction aborted."));
      transaction.onerror = () => {};
    });
  }

  function invalidateForeignResolution(database, input) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(META_STORE, "readwrite");
      const store = transaction.objectStore(META_STORE);
      const gateRequest = store.get(GATE_KEY);
      const resolutionRequest = store.get(RESOLUTION_KEY);
      let remaining = 2;
      let gate;
      let resolution;
      let result;
      const invalidate = () => {
        remaining -= 1;
        if (remaining !== 0) return;
        if (gate?.token !== input.gateToken && leaseIsLive(gate, input.nowMs)) {
          result = {
            acquired: false,
            invalidated: false,
            gate,
            resolution: resolution?.userId === input.currentUserId ? resolution : null
          };
          return;
        }
        const invalidated = Boolean(resolution && resolution.userId !== input.currentUserId);
        if (invalidated) {
          store.delete(RESOLUTION_KEY);
          resolution = null;
        } else if (resolution && resolution.gateToken !== input.gateToken) {
          resolution = { ...resolution, gateToken: input.gateToken };
          store.put({ key: RESOLUTION_KEY, value: resolution });
        }
        gate = leaseValue(input.gateToken, input.nowMs, input.leaseMs);
        store.put({ key: GATE_KEY, value: gate });
        result = { acquired: true, invalidated, resolution, gate };
      };
      gateRequest.onsuccess = () => {
        gate = gateRequest.result?.value || null;
        invalidate();
      };
      resolutionRequest.onsuccess = () => {
        resolution = resolutionRequest.result?.value || null;
        invalidate();
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error || new Error("Storage transaction aborted."));
      transaction.onerror = () => {};
    });
  }

  function validatePendingForSend(database, input) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(META_STORE, "readwrite");
      const store = transaction.objectStore(META_STORE);
      const gateRequest = store.get(GATE_KEY);
      const resolutionRequest = store.get(RESOLUTION_KEY);
      let remaining = 2;
      let gate;
      let resolution;
      let failure = null;
      const validate = () => {
        remaining -= 1;
        if (remaining !== 0) return;
        if (!input.pending || input.pending.userId !== input.currentUserId
          || !resolution || resolution.userId !== input.currentUserId
          || JSON.stringify(resolution) !== JSON.stringify(input.pending)) {
          failure = new BootstrapGateError("Saved history resolution does not match current account.");
          transaction.abort();
          return;
        }
        if (!gate || gate.token !== input.gateToken || resolution.gateToken !== input.gateToken) {
          failure = new BootstrapGateError("Bootstrap gate is owned by another tab.");
          transaction.abort();
          return;
        }
        store.put({
          key: GATE_KEY,
          value: leaseValue(input.gateToken, input.nowMs, input.leaseMs)
        });
      };
      gateRequest.onsuccess = () => {
        gate = gateRequest.result?.value || null;
        validate();
      };
      resolutionRequest.onsuccess = () => {
        resolution = resolutionRequest.result?.value || null;
        validate();
      };
      transaction.oncomplete = () => resolve(resolution);
      transaction.onabort = () => reject(failure || transaction.error || new Error("Storage transaction aborted."));
      transaction.onerror = () => {};
    });
  }

  function applyResolution(database, pending, canonical) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        [META_STORE, PENDING_STORE, TASK_PENDING_STORE, DURATION_PENDING_STORE],
        "readwrite"
      );
      const metaStore = transaction.objectStore(META_STORE);
      const requests = {
        gate: metaStore.get(GATE_KEY),
        resolution: metaStore.get(RESOLUTION_KEY),
        snapshot: metaStore.get("snapshot"),
        hlc: metaStore.get("hlc")
      };
      const results = {};
      let remaining = Object.keys(requests).length;
      let outcome;
      let failure = null;
      const apply = () => {
        remaining -= 1;
        if (remaining !== 0) return;
        const gate = results.gate?.value || null;
        const resolution = results.resolution?.value || null;
        const storedSnapshot = results.snapshot?.value || null;
        if (!resolution && !gate && storedSnapshot?.user?.id === pending.userId
          && Number(storedSnapshot.revision) >= Number(canonical.snapshot.revision)) {
          outcome = {
            applied: false,
            staleSuccess: true,
            snapshot: storedSnapshot,
            hlc: results.hlc?.value || canonical.hlc
          };
          return;
        }
        if (!resolution || JSON.stringify(resolution) !== JSON.stringify(pending)) {
          failure = new BootstrapGateError("Saved history resolution changed before apply.");
          transaction.abort();
          return;
        }
        if (!gate || gate.token !== pending.gateToken) {
          failure = new BootstrapGateError("Bootstrap gate is owned by another tab.");
          transaction.abort();
          return;
        }
        const queueIds = pending.queueIds || {};
        const pendingStore = transaction.objectStore(PENDING_STORE);
        for (const id of queueIds.commands || []) pendingStore.delete(id);
        const taskPendingStore = transaction.objectStore(TASK_PENDING_STORE);
        for (const id of queueIds.taskOperations || []) taskPendingStore.delete(id);
        const durationPendingStore = transaction.objectStore(DURATION_PENDING_STORE);
        for (const id of queueIds.durationOperations || []) durationPendingStore.delete(id);
        metaStore.put({ key: "snapshot", value: canonical.snapshot });
        metaStore.put({ key: "hlc", value: canonical.hlc });
        metaStore.delete(RESOLUTION_KEY);
        metaStore.delete(GATE_KEY);
        outcome = { applied: true, staleSuccess: false, snapshot: canonical.snapshot, hlc: canonical.hlc };
      };
      for (const [name, request] of Object.entries(requests)) {
        request.onsuccess = () => {
          results[name] = request.result;
          apply();
        };
      }
      transaction.oncomplete = () => resolve(outcome);
      transaction.onabort = () => reject(failure || transaction.error || new Error("Storage transaction aborted."));
      transaction.onerror = () => {};
    });
  }

  function applySyncResponse(database, input) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        [META_STORE, PENDING_STORE, TASK_PENDING_STORE, DURATION_PENDING_STORE],
        "readwrite"
      );
      const metaStore = transaction.objectStore(META_STORE);
      const requests = {
        gate: metaStore.get(GATE_KEY),
        resolution: metaStore.get(RESOLUTION_KEY),
        snapshot: metaStore.get("snapshot"),
        hlc: metaStore.get("hlc")
      };
      const results = {};
      let remaining = Object.keys(requests).length;
      let outcome;
      let failure = null;
      const apply = () => {
        remaining -= 1;
        if (remaining !== 0) return;
        const storedSnapshot = results.snapshot?.value || null;
        const storedUserId = storedSnapshot?.user?.id || null;
        const incomingUserId = input.snapshot?.user?.id || null;
        if (!input.expectedUserId || storedUserId !== input.expectedUserId || incomingUserId !== input.expectedUserId) {
          failure = new AccountOwnershipError();
          transaction.abort();
          return;
        }
        if (results.gate || results.resolution) {
          failure = new BootstrapGateError();
          transaction.abort();
          return;
        }
        const incomingTimeOrder = core.compareServerTimes(input.snapshot.serverTime, input.snapshot.serverTime);
        if (incomingTimeOrder !== 0) {
          failure = new Error("Sync response returned an invalid serverTime.");
          transaction.abort();
          return;
        }
        const storedRevision = Number(storedSnapshot?.revision || 0);
        const incomingRevision = Number(input.snapshot.revision);
        if (storedRevision > incomingRevision) {
          outcome = { applied: false, stale: true, snapshot: storedSnapshot };
          return;
        }
        if (storedRevision === incomingRevision && storedSnapshot.serverTime !== undefined) {
          const order = core.compareServerTimes(input.snapshot.serverTime, storedSnapshot.serverTime);
          if (order === null) {
            failure = new Error("Persisted canonical state has an invalid serverTime.");
            transaction.abort();
            return;
          }
          if (order < 0) {
            outcome = { applied: false, stale: true, idempotent: false, snapshot: storedSnapshot };
            return;
          }
          if (order === 0) {
            outcome = { applied: false, stale: false, idempotent: true, snapshot: storedSnapshot };
            return;
          }
        }
        const pendingStore = transaction.objectStore(PENDING_STORE);
        for (const id of input.queueIds.commands || []) pendingStore.delete(id);
        const taskPendingStore = transaction.objectStore(TASK_PENDING_STORE);
        for (const id of input.queueIds.taskOperations || []) taskPendingStore.delete(id);
        const durationPendingStore = transaction.objectStore(DURATION_PENDING_STORE);
        for (const id of input.queueIds.durationOperations || []) durationPendingStore.delete(id);
        metaStore.put({ key: "snapshot", value: input.snapshot });
        const hlc = laterHlc(results.hlc?.value, input.hlc);
        metaStore.put({ key: "hlc", value: hlc });
        outcome = { applied: true, stale: false, snapshot: input.snapshot, hlc };
      };
      for (const [name, request] of Object.entries(requests)) {
        request.onsuccess = () => {
          results[name] = request.result;
          apply();
        };
      }
      transaction.oncomplete = () => resolve(outcome);
      transaction.onabort = () => reject(failure || transaction.error || new Error("Storage transaction aborted."));
      transaction.onerror = () => {};
    });
  }

  async function readQueues(database) {
    const transaction = database.transaction(
      [PENDING_STORE, TASK_PENDING_STORE, DURATION_PENDING_STORE],
      "readonly"
    );
    const [commands, taskOperations, durationOperations] = await Promise.all([
      requestResult(transaction.objectStore(PENDING_STORE).getAll()),
      requestResult(transaction.objectStore(TASK_PENDING_STORE).getAll()),
      requestResult(transaction.objectStore(DURATION_PENDING_STORE).getAll())
    ]);
    return { commands, taskOperations, durationOperations };
  }

  async function readCanonicalState(database) {
    const transaction = database.transaction(META_STORE, "readonly");
    const store = transaction.objectStore(META_STORE);
    const [snapshot, hlc] = await Promise.all([
      requestResult(store.get("snapshot")),
      requestResult(store.get("hlc"))
    ]);
    return { snapshot: snapshot?.value || null, hlc: hlc?.value || null };
  }

  async function readSyncState(database) {
    const transaction = database.transaction(
      [META_STORE, PENDING_STORE, TASK_PENDING_STORE, DURATION_PENDING_STORE],
      "readonly"
    );
    const metaStore = transaction.objectStore(META_STORE);
    const [snapshot, hlc, commands, taskOperations, durationOperations] = await Promise.all([
      requestResult(metaStore.get("snapshot")),
      requestResult(metaStore.get("hlc")),
      requestResult(transaction.objectStore(PENDING_STORE).getAll()),
      requestResult(transaction.objectStore(TASK_PENDING_STORE).getAll()),
      requestResult(transaction.objectStore(DURATION_PENDING_STORE).getAll())
    ]);
    return {
      snapshot: snapshot?.value || null,
      hlc: hlc?.value || null,
      commands,
      taskOperations,
      durationOperations
    };
  }

  return Object.freeze({
    BootstrapGateError,
    AccountOwnershipError,
    ResolutionLimitError,
    GATE_KEY,
    RESOLUTION_KEY,
    acquireBootstrapGate,
    allocateMutation,
    applyResolution,
    applySyncResponse,
    captureResolution,
    clearBootstrapGate,
    guardedMutation,
    invalidateForeignResolution,
    leaseIsLive,
    readBootstrapState,
    readCanonicalState,
    readQueues,
    readSyncState,
    requestResult,
    transactionDone,
    validatePendingForSend
  });
});
