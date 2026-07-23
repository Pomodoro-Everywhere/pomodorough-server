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
  const AUTO_START_PENDING_STORE = "pendingAutoStarts";
  const GATE_KEY = "bootstrapGate";
  const RESOLUTION_KEY = "bootstrapResolution";
  const TIMER_OWNER_KEY = "timerOwner";

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
        durationOperations: "duration operations",
        autoStartOperations: "auto-start operations"
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

  async function acquireBootstrapGateWithLegacyAutoStart(database, input) {
    const gate = await acquireBootstrapGate(database, input);
    if (!gate.acquired || gate.resolution) return gate;
    const legacyAutoStartMigration = await migrateLegacyAutoStart(database, {
      operationId: input.legacyAutoStartOperationId,
      nowMs: input.nowMs
    });
    return { ...gate, legacyAutoStartMigration };
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
        if (input.timerOwner && allocated?.type === "start" && allocated.timerId) {
          metaStore.put({
            key: TIMER_OWNER_KEY,
            value: {
              timerId: allocated.timerId,
              deviceId: input.timerOwner.deviceId,
              tabId: input.timerOwner.tabId,
              leaseExpiresAtMs: input.timerOwner.nowMs + input.timerOwner.leaseMs
            }
          });
        }
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

  function projectedTimer(canonicalTimer, commands) {
    let timer = canonicalTimer ? { ...canonicalTimer } : null;
    const matches = (command) => timer && timer.id === command.timerId
      && timer.phase === command.phase
      && Number(timer.plannedDurationMs) === Number(command.plannedDurationMs);
    for (const command of [...(commands || [])].sort((left, right) =>
      Number(left.deviceSequence) - Number(right.deviceSequence) || String(left.id).localeCompare(String(right.id))
    )) {
      switch (command.type) {
        case "start":
          timer = {
            id: command.timerId,
            phase: command.phase,
            status: "running",
            plannedDurationMs: command.plannedDurationMs,
            dependsOnCommandId: command.dependsOnCommandId || null
          };
          break;
        case "pause":
          if (matches(command) && timer.status === "running") timer.status = "paused";
          break;
        case "resume":
          if (matches(command) && timer.status === "paused") timer.status = "running";
          break;
        case "finish":
          if (matches(command) && ["running", "paused"].includes(timer.status)) timer.status = "completed";
          break;
        case "cancel":
          if (matches(command) && ["running", "paused"].includes(timer.status)) timer.status = "cancelled";
          break;
        case "clear":
          if (matches(command) && !["running", "paused"].includes(timer.status)) timer = null;
          break;
      }
    }
    return timer;
  }

  function timerOwnerValue(timerId, input) {
    return {
      timerId,
      deviceId: input.deviceId,
      tabId: input.tabId,
      leaseExpiresAtMs: input.nowMs + input.leaseMs
    };
  }

  function canClaimMissingTimerOwner(snapshot, commands, timer, deviceId) {
    if (!timer || !["running", "paused"].includes(timer.status)) return false;
    const canonicalTimer = snapshot?.canonicalTimer || null;
    if (canonicalTimer?.id === timer.id && canonicalTimer.startedByDeviceId !== undefined) {
      return canonicalTimer.startedByDeviceId === deviceId;
    }
    return (commands || []).some((command) => command.type === "start" && command.timerId === timer.id);
  }

  function claimMissingTimerOwner(metaStore, owner, snapshot, commands, input) {
    if (owner || !input?.deviceId || !input.tabId) return null;
    const timer = projectedTimer(snapshot?.canonicalTimer, commands);
    if (!canClaimMissingTimerOwner(snapshot, commands, timer, input.deviceId)) return null;
    const claimed = timerOwnerValue(timer.id, input);
    metaStore.put({ key: TIMER_OWNER_KEY, value: claimed });
    return claimed;
  }

  function retainedCommands(commands, removedIds, promotedCommands) {
    const retained = new Map((commands || []).map((command) => [command.id, command]));
    for (const id of removedIds || []) retained.delete(id);
    for (const command of promotedCommands || []) retained.set(command.id, command);
    return [...retained.values()];
  }

  function finishTimer(database, input) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction([META_STORE, PENDING_STORE], "readwrite");
      const metaStore = transaction.objectStore(META_STORE);
      const pendingStore = transaction.objectStore(PENDING_STORE);
      const requests = {
        gate: metaStore.get(GATE_KEY),
        resolution: metaStore.get(RESOLUTION_KEY),
        snapshot: metaStore.get("snapshot"),
        deviceSequence: metaStore.get("deviceSequence"),
        hlc: metaStore.get("hlc"),
        timerOwner: metaStore.get(TIMER_OWNER_KEY),
        commands: pendingStore.getAll()
      };
      const results = {};
      let remaining = Object.keys(requests).length;
      let outcome;
      let failure = null;
      const finish = () => {
        remaining -= 1;
        if (remaining !== 0) return;
        if (results.gate || results.resolution) {
          failure = new BootstrapGateError();
          transaction.abort();
          return;
        }
        const commands = results.commands || [];
        const timer = projectedTimer(results.snapshot?.value?.canonicalTimer, commands);
        if (!timer || timer.id !== input.timerId || timer.phase !== input.phase
          || !["running", "paused"].includes(timer.status)) {
          outcome = { transitioned: false, reason: "stale", commands: [] };
          return;
        }
        let owner = results.timerOwner?.value || null;
        owner ||= claimMissingTimerOwner(
          metaStore,
          owner,
          results.snapshot?.value,
          commands,
          input
        );
        const ownerIsCurrentTimer = owner?.timerId === input.timerId;
        const ownerDeviceMatches = ownerIsCurrentTimer && owner.deviceId === input.deviceId;
        const ownerLeaseLive = Number(owner?.leaseExpiresAtMs) > input.nowMs;
        const ownerGranted = input.manual === true || ownerDeviceMatches
          && (owner.tabId === input.tabId || !ownerLeaseLive);
        if (input.requireOwner === true && !ownerGranted) {
          outcome = { transitioned: false, reason: "not_owner", commands: [] };
          if (ownerDeviceMatches && Number.isFinite(Number(owner.leaseExpiresAtMs))) {
            outcome.retryAtMs = Number(owner.leaseExpiresAtMs);
          }
          return;
        }

        const highestSequence = commands.reduce(
          (highest, command) => Math.max(highest, Number(command.deviceSequence) || 0),
          Number(results.deviceSequence?.value) || 0
        );
        const storedHlc = results.hlc?.value || {};
        const storedWallMs = Number(storedHlc.wallMs) || 0;
        const wallMs = Math.max(input.nowMs, storedWallMs);
        let counter = wallMs === storedWallMs ? (Number(storedHlc.counter) || 0) + 1 : 0;
        const occurredAt = new Date(input.nowMs).toISOString();
        const finishCommand = {
          id: input.finishCommandId,
          deviceSequence: highestSequence + 1,
          timerId: timer.id,
          type: "finish",
          phase: timer.phase,
          plannedDurationMs: timer.plannedDurationMs,
          occurredAt,
          hlcWallMs: wallMs,
          hlcCounter: counter,
          observedElapsedMs: Math.min(
            Number(timer.plannedDurationMs),
            Math.max(0, Number(input.observedElapsedMs) || 0)
          )
        };
        if (timer.dependsOnCommandId) finishCommand.dependsOnCommandId = timer.dependsOnCommandId;
        const persisted = [finishCommand];
        pendingStore.add(finishCommand);

        if (input.breakPhase && ownerGranted) {
          counter += 1;
          const breakCommand = {
            id: input.breakCommandId,
            deviceSequence: highestSequence + 2,
            timerId: input.breakTimerId,
            type: "start",
            phase: input.breakPhase,
            plannedDurationMs: input.breakDurationMs,
            occurredAt,
            hlcWallMs: wallMs,
            hlcCounter: counter,
            observedElapsedMs: 0,
            dependsOnCommandId: finishCommand.id,
            generatedBreak: true
          };
          pendingStore.add(breakCommand);
          persisted.push(breakCommand);
          metaStore.put({
            key: TIMER_OWNER_KEY,
            value: {
              timerId: breakCommand.timerId,
              deviceId: input.deviceId,
              tabId: input.tabId,
              leaseExpiresAtMs: input.nowMs + input.leaseMs
            }
          });
        } else if (ownerGranted) {
          metaStore.delete(TIMER_OWNER_KEY);
        }
        metaStore.put({ key: "deviceSequence", value: highestSequence + persisted.length });
        metaStore.put({ key: "hlc", value: { wallMs, counter } });
        outcome = { transitioned: true, reason: "", commands: persisted };
      };
      for (const [name, request] of Object.entries(requests)) {
        request.onsuccess = () => {
          results[name] = request.result;
          finish();
        };
      }
      transaction.oncomplete = () => resolve(outcome);
      transaction.onabort = () => reject(failure || transaction.error || new Error("Storage transaction aborted."));
      transaction.onerror = () => {};
    });
  }

  function renewTimerOwnership(database, input) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction([META_STORE, PENDING_STORE], "readwrite");
      const store = transaction.objectStore(META_STORE);
      const requests = {
        owner: store.get(TIMER_OWNER_KEY),
        snapshot: store.get("snapshot"),
        commands: transaction.objectStore(PENDING_STORE).getAll()
      };
      const results = {};
      let remaining = Object.keys(requests).length;
      let renewed = false;
      const renew = () => {
        remaining -= 1;
        if (remaining !== 0) return;
        let owner = results.owner?.value || null;
        owner ||= claimMissingTimerOwner(
          store,
          owner,
          results.snapshot?.value,
          results.commands || [],
          input
        );
        const sameTimerAndDevice = owner?.timerId === input.timerId && owner.deviceId === input.deviceId;
        const leaseLive = Number(owner?.leaseExpiresAtMs) > input.nowMs;
        if (!sameTimerAndDevice || owner.tabId !== input.tabId && leaseLive) return;
        store.put({ key: TIMER_OWNER_KEY, value: timerOwnerValue(input.timerId, input) });
        renewed = true;
      };
      for (const [name, request] of Object.entries(requests)) {
        request.onsuccess = () => {
          results[name] = request.result;
          renew();
        };
      }
      transaction.oncomplete = () => resolve(renewed);
      transaction.onabort = () => reject(transaction.error || new Error("Storage transaction aborted."));
      transaction.onerror = () => {};
    });
  }

  function releaseTimerOwnership(database, input) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(META_STORE, "readwrite");
      const store = transaction.objectStore(META_STORE);
      const request = store.get(TIMER_OWNER_KEY);
      request.onsuccess = () => {
        const owner = request.result?.value || null;
        if (owner?.deviceId !== input.deviceId || owner.tabId !== input.tabId) return;
        store.put({ key: TIMER_OWNER_KEY, value: { ...owner, leaseExpiresAtMs: input.nowMs } });
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error("Storage transaction aborted."));
      transaction.onerror = () => {};
    });
  }

  function captureResolution(database, input, options) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        [META_STORE, PENDING_STORE, TASK_PENDING_STORE, DURATION_PENDING_STORE, AUTO_START_PENDING_STORE],
        "readwrite"
      );
      const metaStore = transaction.objectStore(META_STORE);
      const requests = {
        gate: metaStore.get(GATE_KEY),
        resolution: metaStore.get(RESOLUTION_KEY),
        commands: transaction.objectStore(PENDING_STORE).getAll(),
        taskOperations: transaction.objectStore(TASK_PENDING_STORE).getAll(),
        durationOperations: transaction.objectStore(DURATION_PENDING_STORE).getAll(),
        autoStartOperations: transaction.objectStore(AUTO_START_PENDING_STORE).getAll()
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
        const resolutionInput = {
          ...input,
          commands,
          taskOperations: (results.taskOperations || []).sort(operationOrder),
          durationOperations: (results.durationOperations || []).sort(operationOrder)
        };
        const autoStartOperations = (results.autoStartOperations || []).sort(operationOrder);
        if (autoStartOperations.length > 0 || input.autoStartOperationsPresent === true) {
          resolutionInput.autoStartOperations = autoStartOperations;
        }
        pending = {
          ...core.createPendingResolution(resolutionInput),
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
        [META_STORE, PENDING_STORE, TASK_PENDING_STORE, DURATION_PENDING_STORE, AUTO_START_PENDING_STORE],
        "readwrite"
      );
      const metaStore = transaction.objectStore(META_STORE);
      const requests = {
        gate: metaStore.get(GATE_KEY),
        resolution: metaStore.get(RESOLUTION_KEY),
        snapshot: metaStore.get("snapshot"),
        hlc: metaStore.get("hlc"),
        settings: metaStore.get("settings"),
        timerOwner: metaStore.get(TIMER_OWNER_KEY),
        commands: transaction.objectStore(PENDING_STORE).getAll()
      };
      const results = {};
      let remaining = Object.keys(requests).length;
      let outcome;
      let failure = null;
      const completeLegacyAutoStartMigration = () => {
        if (Object.prototype.hasOwnProperty.call(pending.payload || {}, "autoStartOperations")) return;
        const { autoStartBreaks, autoStartBreaksExplicit, ...settings } = results.settings?.value || {};
        metaStore.put({
          key: "settings",
          value: { ...settings, autoStartSyncBootstrapped: true }
        });
      };
      const apply = () => {
        remaining -= 1;
        if (remaining !== 0) return;
        const gate = results.gate?.value || null;
        const resolution = results.resolution?.value || null;
        const storedSnapshot = results.snapshot?.value || null;
        if (!resolution && !gate && storedSnapshot?.user?.id === pending.userId
          && Number(storedSnapshot.revision) >= Number(canonical.snapshot.revision)) {
          completeLegacyAutoStartMigration();
          claimMissingTimerOwner(
            metaStore,
            results.timerOwner?.value || null,
            storedSnapshot,
            results.commands || [],
            canonical.timerOwnerClaim
          );
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
        for (const command of canonical.promoteCommands || []) pendingStore.put(command);
        for (const id of canonical.dropCommandIds || []) pendingStore.delete(id);
        const taskPendingStore = transaction.objectStore(TASK_PENDING_STORE);
        for (const id of queueIds.taskOperations || []) taskPendingStore.delete(id);
        const durationPendingStore = transaction.objectStore(DURATION_PENDING_STORE);
        for (const id of queueIds.durationOperations || []) durationPendingStore.delete(id);
        const autoStartPendingStore = transaction.objectStore(AUTO_START_PENDING_STORE);
        for (const id of queueIds.autoStartOperations || []) autoStartPendingStore.delete(id);
        completeLegacyAutoStartMigration();
        metaStore.put({ key: "snapshot", value: canonical.snapshot });
        metaStore.put({ key: "hlc", value: canonical.hlc });
        const owner = results.timerOwner?.value || null;
        if ((canonical.dropTimerIds || []).includes(owner?.timerId)) metaStore.delete(TIMER_OWNER_KEY);
        else claimMissingTimerOwner(
          metaStore,
          owner,
          canonical.snapshot,
          retainedCommands(
            results.commands,
            [...(queueIds.commands || []), ...(canonical.dropCommandIds || [])],
            canonical.promoteCommands
          ),
          canonical.timerOwnerClaim
        );
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
        [META_STORE, PENDING_STORE, TASK_PENDING_STORE, DURATION_PENDING_STORE, AUTO_START_PENDING_STORE],
        "readwrite"
      );
      const metaStore = transaction.objectStore(META_STORE);
      const requests = {
        gate: metaStore.get(GATE_KEY),
        resolution: metaStore.get(RESOLUTION_KEY),
        snapshot: metaStore.get("snapshot"),
        hlc: metaStore.get("hlc"),
        timerOwner: metaStore.get(TIMER_OWNER_KEY),
        commands: transaction.objectStore(PENDING_STORE).getAll()
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
          claimMissingTimerOwner(
            metaStore,
            results.timerOwner?.value || null,
            storedSnapshot,
            results.commands || [],
            input.timerOwnerClaim
          );
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
            claimMissingTimerOwner(
              metaStore,
              results.timerOwner?.value || null,
              storedSnapshot,
              results.commands || [],
              input.timerOwnerClaim
            );
            outcome = { applied: false, stale: true, idempotent: false, snapshot: storedSnapshot };
            return;
          }
          if (order === 0) {
            claimMissingTimerOwner(
              metaStore,
              results.timerOwner?.value || null,
              storedSnapshot,
              results.commands || [],
              input.timerOwnerClaim
            );
            outcome = { applied: false, stale: false, idempotent: true, snapshot: storedSnapshot };
            return;
          }
        }
        const pendingStore = transaction.objectStore(PENDING_STORE);
        for (const id of input.queueIds.commands || []) pendingStore.delete(id);
        for (const command of input.promoteCommands || []) pendingStore.put(command);
        for (const id of input.dropCommandIds || []) pendingStore.delete(id);
        const taskPendingStore = transaction.objectStore(TASK_PENDING_STORE);
        for (const id of input.queueIds.taskOperations || []) taskPendingStore.delete(id);
        const durationPendingStore = transaction.objectStore(DURATION_PENDING_STORE);
        for (const id of input.queueIds.durationOperations || []) durationPendingStore.delete(id);
        const autoStartPendingStore = transaction.objectStore(AUTO_START_PENDING_STORE);
        for (const id of input.queueIds.autoStartOperations || []) autoStartPendingStore.delete(id);
        metaStore.put({ key: "snapshot", value: input.snapshot });
        const owner = results.timerOwner?.value || null;
        if ((input.dropTimerIds || []).includes(owner?.timerId)) metaStore.delete(TIMER_OWNER_KEY);
        else claimMissingTimerOwner(
          metaStore,
          owner,
          input.snapshot,
          retainedCommands(
            results.commands,
            [...(input.queueIds.commands || []), ...(input.dropCommandIds || [])],
            input.promoteCommands
          ),
          input.timerOwnerClaim
        );
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
      [PENDING_STORE, TASK_PENDING_STORE, DURATION_PENDING_STORE, AUTO_START_PENDING_STORE],
      "readonly"
    );
    const [commands, taskOperations, durationOperations, autoStartOperations] = await Promise.all([
      requestResult(transaction.objectStore(PENDING_STORE).getAll()),
      requestResult(transaction.objectStore(TASK_PENDING_STORE).getAll()),
      requestResult(transaction.objectStore(DURATION_PENDING_STORE).getAll()),
      requestResult(transaction.objectStore(AUTO_START_PENDING_STORE).getAll())
    ]);
    return { commands, taskOperations, durationOperations, autoStartOperations };
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
      [META_STORE, PENDING_STORE, TASK_PENDING_STORE, DURATION_PENDING_STORE, AUTO_START_PENDING_STORE],
      "readonly"
    );
    const metaStore = transaction.objectStore(META_STORE);
    const [snapshot, hlc, commands, taskOperations, durationOperations, autoStartOperations] = await Promise.all([
      requestResult(metaStore.get("snapshot")),
      requestResult(metaStore.get("hlc")),
      requestResult(transaction.objectStore(PENDING_STORE).getAll()),
      requestResult(transaction.objectStore(TASK_PENDING_STORE).getAll()),
      requestResult(transaction.objectStore(DURATION_PENDING_STORE).getAll()),
      requestResult(transaction.objectStore(AUTO_START_PENDING_STORE).getAll())
    ]);
    return {
      snapshot: snapshot?.value || null,
      hlc: hlc?.value || null,
      commands,
      taskOperations,
      durationOperations,
      autoStartOperations
    };
  }

  function migrateLegacyAutoStart(database, input) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction([META_STORE, AUTO_START_PENDING_STORE], "readwrite");
      const metaStore = transaction.objectStore(META_STORE);
      const settingsRequest = metaStore.get("settings");
      let settingsRecord;
      let result;
      const migrate = () => {
        const settings = settingsRecord?.value || {};
        if (settings.autoStartSyncBootstrapped === true) {
          result = { migrated: false, operation: null };
          return;
        }
        const { autoStartBreaks, autoStartBreaksExplicit, ...nextSettings } = settings;
        let operation = null;
        const explicitChoice = autoStartBreaks === true || autoStartBreaksExplicit === true;
        if (explicitChoice) {
          operation = {
            id: input.operationId,
            enabled: autoStartBreaks === true,
            occurredAt: new Date(0).toISOString(),
            hlcWallMs: 0,
            hlcCounter: 0
          };
          transaction.objectStore(AUTO_START_PENDING_STORE).add(operation);
        }
        metaStore.put({
          key: "settings",
          value: { ...nextSettings, autoStartSyncBootstrapped: true }
        });
        result = { migrated: operation !== null, operation };
      };
      settingsRequest.onsuccess = () => {
        settingsRecord = settingsRequest.result;
        migrate();
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error || new Error("Storage transaction aborted."));
      transaction.onerror = () => {};
    });
  }

  return Object.freeze({
    BootstrapGateError,
    AccountOwnershipError,
    ResolutionLimitError,
    GATE_KEY,
    RESOLUTION_KEY,
    acquireBootstrapGate,
    acquireBootstrapGateWithLegacyAutoStart,
    allocateMutation,
    applyResolution,
    applySyncResponse,
    captureResolution,
    clearBootstrapGate,
    finishTimer,
    guardedMutation,
    invalidateForeignResolution,
    leaseIsLive,
    migrateLegacyAutoStart,
    releaseTimerOwnership,
    readBootstrapState,
    readCanonicalState,
    readQueues,
    readSyncState,
    requestResult,
    renewTimerOwnership,
    transactionDone,
    validatePendingForSend
  });
});
