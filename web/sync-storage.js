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
  const SELECTED_TASK_PENDING_STORE = "pendingSelectedTasks";
  const GATE_KEY = "bootstrapGate";
  const RESOLUTION_KEY = "bootstrapResolution";
  const TIMER_OWNER_KEY = "timerOwner";
  const CLOCK_OFFSET_KEY = "clockOffset";
  const CLOCK_REQUEST_SEQUENCE_KEY = "clockRequestSequence";
  const UUID7_KEY = "uuidV7";
  const UUID7_MAX_TIMESTAMP_MS = (2 ** 48) - 1;
  const UUID7_RANDOM_MAX = (1n << 74n) - 1n;
  const UUID7_RAND_B_MASK = (1n << 62n) - 1n;
  const UUID7_ENTROPY_ATTEMPTS = 16;
  const LEGACY_EPOCH = new Date(0).toISOString();

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
        autoStartOperations: "auto-start operations",
        selectedTaskOperations: "selected-task operations"
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

  class ClockRangeError extends Error {
    constructor() {
      super("Local clock or sequence is outside the synchronization range.");
      this.name = "ClockRangeError";
    }
  }

  class UUIDRangeError extends Error {
    constructor(message = "UUIDv7 generator state is outside the supported range.") {
      super(message);
      this.name = "UUIDRangeError";
    }
  }

  function uuidText(integer) {
    const hex = integer.toString(16).padStart(32, "0");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function uuid7FromParts(timestampMs, randomValue) {
    if (!Number.isSafeInteger(timestampMs) || timestampMs < 0 || timestampMs > UUID7_MAX_TIMESTAMP_MS
      || typeof randomValue !== "bigint" || randomValue < 0n || randomValue > UUID7_RANDOM_MAX) {
      throw new UUIDRangeError();
    }
    const randA = randomValue >> 62n;
    const randB = randomValue & UUID7_RAND_B_MASK;
    return uuidText(
      (BigInt(timestampMs) << 80n)
      | (7n << 76n)
      | (randA << 64n)
      | (0b10n << 62n)
      | randB
    );
  }

  function uuid7Parts(value) {
    if (typeof value !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new UUIDRangeError("Persisted UUIDv7 state is invalid.");
    }
    const integer = BigInt(`0x${value.replaceAll("-", "")}`);
    const timestampMs = Number(integer >> 80n);
    const randA = (integer >> 64n) & 0xFFFn;
    const randB = integer & UUID7_RAND_B_MASK;
    return {
      integer,
      timestampMs,
      randomValue: (randA << 62n) | randB
    };
  }

  function reserveUuid7(timestampMs, count, stored, pendingIds = [], entropy = null) {
    if (!Number.isSafeInteger(timestampMs) || timestampMs <= 0 || timestampMs > UUID7_MAX_TIMESTAMP_MS
      || !Number.isSafeInteger(count) || count <= 0 || BigInt(count) > UUID7_RANDOM_MAX + 1n) {
      throw new UUIDRangeError();
    }
    const storedParts = stored == null ? null : uuid7Parts(stored);
    const pendingParts = [];
    for (const identifier of pendingIds || []) {
      try {
        pendingParts.push(uuid7Parts(identifier));
      } catch {
        // Historical UUIDv4 and opaque identifiers remain valid.
      }
    }
    const latestPending = pendingParts.reduce(
      (latest, item) => latest == null || item.integer > latest.integer ? item : latest,
      null
    );
    if (storedParts && latestPending && latestPending.integer > storedParts.integer) {
      throw new UUIDRangeError("Persisted UUIDv7 state predates a pending identifier.");
    }
    const previous = storedParts || latestPending;
    const countBigInt = BigInt(count);
    if (previous && timestampMs <= previous.timestampMs) {
      if (previous.randomValue > UUID7_RANDOM_MAX - countBigInt) {
        throw new UUIDRangeError("UUIDv7 random value has no headroom.");
      }
      return Array.from(
        { length: count },
        (_, index) => uuid7FromParts(
          previous.timestampMs,
          previous.randomValue + 1n + BigInt(index)
        )
      );
    }

    const maximumFirst = UUID7_RANDOM_MAX - (countBigInt - 1n);
    const fillEntropy = entropy || ((bytes) => {
      if (!globalThis.crypto?.getRandomValues) {
        throw new UUIDRangeError("Secure UUIDv7 entropy is unavailable.");
      }
      return globalThis.crypto.getRandomValues(bytes);
    });
    for (let attempt = 0; attempt < UUID7_ENTROPY_ATTEMPTS; attempt += 1) {
      const bytes = new Uint8Array(10);
      const filled = fillEntropy(bytes);
      const source = filled === undefined ? bytes : filled;
      if (!(source instanceof Uint8Array) || source.length !== 10) {
        throw new UUIDRangeError("UUIDv7 entropy source returned invalid data.");
      }
      let randomValue = 0n;
      for (const byte of source) randomValue = (randomValue << 8n) | BigInt(byte);
      randomValue &= UUID7_RANDOM_MAX;
      if (randomValue <= maximumFirst) {
        return Array.from(
          { length: count },
          (_, index) => uuid7FromParts(timestampMs, randomValue + BigInt(index))
        );
      }
    }
    throw new UUIDRangeError("UUIDv7 entropy lacks reservation headroom.");
  }

  function uuid7RequestSet(transaction, metaStore) {
    return {
      uuidV7: metaStore.get(UUID7_KEY),
      uuidCommands: transaction.objectStore(PENDING_STORE).getAllKeys(),
      uuidTasks: transaction.objectStore(TASK_PENDING_STORE).getAllKeys(),
      uuidDurations: transaction.objectStore(DURATION_PENDING_STORE).getAllKeys(),
      uuidAutoStarts: transaction.objectStore(AUTO_START_PENDING_STORE).getAllKeys(),
      uuidSelectedTasks: transaction.objectStore(SELECTED_TASK_PENDING_STORE).getAllKeys()
    };
  }

  function pendingUuidIds(results) {
    return [
      ...(results.uuidCommands || []),
      ...(results.uuidTasks || []),
      ...(results.uuidDurations || []),
      ...(results.uuidAutoStarts || []),
      ...(results.uuidSelectedTasks || [])
    ];
  }

  function reserveTransactionUuid7(metaStore, results, timestampMs, count, entropy) {
    const identifiers = reserveUuid7(
      timestampMs,
      count,
      results.uuidV7?.value || null,
      pendingUuidIds(results),
      entropy
    );
    metaStore.put({ key: UUID7_KEY, value: identifiers.at(-1) });
    return identifiers;
  }

  function requireMutationRange(nowMs, wallMs, counter, deviceSequence) {
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0
      || !Number.isSafeInteger(wallMs) || wallMs <= 0
      || !Number.isSafeInteger(counter) || counter < 0
      || deviceSequence !== undefined && (!Number.isSafeInteger(deviceSequence) || deviceSequence <= 0)) {
      throw new ClockRangeError();
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

  function putLatestClockOffset(metaStore, stored, incoming) {
    if (incoming == null) return core.validClockSample(stored) ? stored : null;
    if (!core.validClockSample(incoming)) throw new ClockRangeError();
    if (core.validClockSample(stored)) {
      if (stored.requestSequence > incoming.requestSequence
        || stored.requestSequence === incoming.requestSequence
          && (stored.receivedAtWallMs > incoming.receivedAtWallMs
            || stored.receivedAtWallMs === incoming.receivedAtWallMs
              && stored.uncertaintyMs <= incoming.uncertaintyMs)) {
        return stored;
      }
    }
    metaStore.put({ key: CLOCK_OFFSET_KEY, value: incoming });
    return incoming;
  }

  function allocateClockRequestSequence(database) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(META_STORE, "readwrite");
      const store = transaction.objectStore(META_STORE);
      const request = store.get(CLOCK_REQUEST_SEQUENCE_KEY);
      let sequence;
      let failure;
      request.onsuccess = () => {
        sequence = (Number(request.result?.value) || 0) + 1;
        if (!Number.isSafeInteger(sequence) || sequence <= 0) {
          failure = new ClockRangeError();
          transaction.abort();
          return;
        }
        store.put({ key: CLOCK_REQUEST_SEQUENCE_KEY, value: sequence });
      };
      transaction.oncomplete = () => resolve(sequence);
      transaction.onabort = () => reject(failure || transaction.error || new Error("Storage transaction aborted."));
      transaction.onerror = () => {};
    });
  }

  function saveClockOffset(database, sample) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(META_STORE, "readwrite");
      const store = transaction.objectStore(META_STORE);
      const request = store.get(CLOCK_OFFSET_KEY);
      let saved;
      let failure;
      request.onsuccess = () => {
        try {
          saved = putLatestClockOffset(store, request.result?.value || null, sample);
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      transaction.oncomplete = () => resolve(saved);
      transaction.onabort = () => reject(failure || transaction.error || new Error("Storage transaction aborted."));
      transaction.onerror = () => {};
    });
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
    const legacySelectedTaskMigration = await migrateLegacySelectedTask(database, {
      operationId: input.legacySelectedTaskOperationId,
      nowMs: input.nowMs
    });
    return { ...gate, legacyAutoStartMigration, legacySelectedTaskMigration };
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
          operation(transaction, outcome, (error) => {
            failure = error;
            transaction.abort();
          });
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
      const transaction = database.transaction(
        input.withUuidV7
          ? [
              META_STORE,
              PENDING_STORE,
              TASK_PENDING_STORE,
              DURATION_PENDING_STORE,
              AUTO_START_PENDING_STORE,
              SELECTED_TASK_PENDING_STORE
            ]
          : [META_STORE, input.storeName],
        "readwrite"
      );
      const metaStore = transaction.objectStore(META_STORE);
      const requests = {
        gate: metaStore.get(GATE_KEY),
        resolution: metaStore.get(RESOLUTION_KEY),
        hlc: metaStore.get("hlc")
      };
      if (input.withDeviceSequence) requests.deviceSequence = metaStore.get("deviceSequence");
      if (input.withUuidV7) Object.assign(requests, uuid7RequestSet(transaction, metaStore));
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
        try {
          requireMutationRange(input.nowMs, wallMs, counter, deviceSequence);
          const id = input.withUuidV7
            ? reserveTransactionUuid7(metaStore, results, wallMs, 1, input.entropy)[0]
            : undefined;
          allocated = input.build({ id, wallMs, counter, deviceSequence });
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
        } catch (error) {
          failure = error;
          transaction.abort();
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
    for (const command of [...(commands || [])].sort(core.compareTimerCommands)) {
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

  function cancelAndClearTimer(database, input) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        input.withUuidV7
          ? [
              META_STORE,
              PENDING_STORE,
              TASK_PENDING_STORE,
              DURATION_PENDING_STORE,
              AUTO_START_PENDING_STORE,
              SELECTED_TASK_PENDING_STORE
            ]
          : [META_STORE, PENDING_STORE],
        "readwrite"
      );
      const metaStore = transaction.objectStore(META_STORE);
      const pendingStore = transaction.objectStore(PENDING_STORE);
      const requests = {
        gate: metaStore.get(GATE_KEY),
        resolution: metaStore.get(RESOLUTION_KEY),
        snapshot: metaStore.get("snapshot"),
        deviceSequence: metaStore.get("deviceSequence"),
        hlc: metaStore.get("hlc"),
        commands: pendingStore.getAll()
      };
      if (input.withUuidV7) Object.assign(requests, uuid7RequestSet(transaction, metaStore));
      const results = {};
      let remaining = Object.keys(requests).length;
      let outcome;
      let failure = null;
      const cancelAndClear = () => {
        remaining -= 1;
        if (remaining !== 0) return;
        if (results.gate || results.resolution) {
          failure = new BootstrapGateError();
          transaction.abort();
          return;
        }
        const commands = results.commands || [];
        const timer = projectedTimer(results.snapshot?.value?.canonicalTimer, commands);
        if (!timer || timer.id !== input.timerId || timer.phase !== input.phase) {
          outcome = { transitioned: false, reason: "stale", commands: [] };
          return;
        }
        const types = ["running", "paused"].includes(timer.status)
          ? ["cancel", "clear"]
          : ["completed", "cancelled"].includes(timer.status) ? ["clear"] : [];
        if (types.length === 0) {
          outcome = { transitioned: false, reason: "stale", commands: [] };
          return;
        }

        const highestSequence = commands.reduce(
          (highest, command) => Math.max(highest, Number(command.deviceSequence) || 0),
          Number(results.deviceSequence?.value) || 0
        );
        const storedHlc = results.hlc?.value || {};
        const storedWallMs = Number(storedHlc.wallMs) || 0;
        const wallMs = Math.max(input.nowMs, storedWallMs);
        const firstCounter = wallMs === storedWallMs ? (Number(storedHlc.counter) || 0) + 1 : 0;
        let commandIds;
        try {
          requireMutationRange(
            input.nowMs,
            wallMs,
            firstCounter + types.length - 1,
            highestSequence + types.length
          );
          commandIds = input.withUuidV7
            ? reserveTransactionUuid7(metaStore, results, wallMs, types.length, input.entropy)
            : types.map((type) => type === "cancel" ? input.cancelCommandId : input.clearCommandId);
        } catch (error) {
          failure = error;
          transaction.abort();
          return;
        }
        const occurredAt = new Date(wallMs).toISOString();
        const elapsedMs = Math.min(
          Number(timer.plannedDurationMs),
          Math.max(0, Number(input.observedElapsedMs) || 0)
        );
        const persisted = types.map((type, index) => {
          const command = {
            id: commandIds[index],
            deviceId: input.deviceId,
            deviceSequence: highestSequence + index + 1,
            timerId: timer.id,
            type,
            phase: timer.phase,
            plannedDurationMs: timer.plannedDurationMs,
            occurredAt,
            hlcWallMs: wallMs,
            hlcCounter: firstCounter + index,
            observedElapsedMs: elapsedMs
          };
          if (timer.dependsOnCommandId) command.dependsOnCommandId = timer.dependsOnCommandId;
          pendingStore.add(command);
          return command;
        });
        metaStore.delete(TIMER_OWNER_KEY);
        metaStore.put({ key: "deviceSequence", value: highestSequence + persisted.length });
        metaStore.put({
          key: "hlc",
          value: { wallMs, counter: firstCounter + persisted.length - 1 }
        });
        outcome = { transitioned: true, reason: "", commands: persisted };
      };
      for (const [name, request] of Object.entries(requests)) {
        request.onsuccess = () => {
          results[name] = request.result;
          cancelAndClear();
        };
      }
      transaction.oncomplete = () => resolve(outcome);
      transaction.onabort = () => reject(failure || transaction.error || new Error("Storage transaction aborted."));
      transaction.onerror = () => {};
    });
  }

  function finishTimer(database, input) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        input.withUuidV7
          ? [
              META_STORE,
              PENDING_STORE,
              TASK_PENDING_STORE,
              DURATION_PENDING_STORE,
              AUTO_START_PENDING_STORE,
              SELECTED_TASK_PENDING_STORE
            ]
          : [META_STORE, PENDING_STORE],
        "readwrite"
      );
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
      if (input.withUuidV7) Object.assign(requests, uuid7RequestSet(transaction, metaStore));
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
        const leaseNowMs = input.localNowMs ?? input.nowMs;
        const ownerLeaseLive = Number(owner?.leaseExpiresAtMs) > leaseNowMs;
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
        const generatedCount = input.breakPhase && ownerGranted ? 2 : 1;
        let commandIds;
        try {
          requireMutationRange(input.nowMs, wallMs, counter + generatedCount - 1, highestSequence + generatedCount);
          commandIds = input.withUuidV7
            ? reserveTransactionUuid7(
                metaStore,
                results,
                wallMs,
                generatedCount,
                input.entropy
              )
            : [input.finishCommandId, input.breakCommandId].slice(0, generatedCount);
        } catch (error) {
          failure = error;
          transaction.abort();
          return;
        }
        const occurredAt = new Date(wallMs).toISOString();
        const finishCommand = {
          id: commandIds[0],
          deviceId: input.deviceId,
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
            id: commandIds[1],
            deviceId: input.deviceId,
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
              leaseExpiresAtMs: leaseNowMs + input.leaseMs
            }
          });
        } else if (ownerGranted) {
          metaStore.delete(TIMER_OWNER_KEY);
        }
        metaStore.put({ key: "deviceSequence", value: highestSequence + persisted.length });
        metaStore.put({ key: "hlc", value: { wallMs, counter } });
        if (input.settings) metaStore.put({ key: "settings", value: input.settings });
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
        [META_STORE, PENDING_STORE, TASK_PENDING_STORE, DURATION_PENDING_STORE, AUTO_START_PENDING_STORE, SELECTED_TASK_PENDING_STORE],
        "readwrite"
      );
      const metaStore = transaction.objectStore(META_STORE);
      const requests = {
        gate: metaStore.get(GATE_KEY),
        resolution: metaStore.get(RESOLUTION_KEY),
        commands: transaction.objectStore(PENDING_STORE).getAll(),
        taskOperations: transaction.objectStore(TASK_PENDING_STORE).getAll(),
        durationOperations: transaction.objectStore(DURATION_PENDING_STORE).getAll(),
        autoStartOperations: transaction.objectStore(AUTO_START_PENDING_STORE).getAll(),
        selectedTaskOperations: transaction.objectStore(SELECTED_TASK_PENDING_STORE).getAll()
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
        if (existingResolution && (existingResolution.gateToken !== options.gateToken
          || typeof input.requestId !== "string" || !input.requestId
          || input.requestId === existingResolution.payload?.requestId)) {
          failure = new BootstrapGateError("Saved history resolution replacement requires its owner and a fresh request ID.");
          transaction.abort();
          return;
        }
        const commands = (results.commands || []).sort(core.compareTimerCommands);
        const operationOrder = (left, right) =>
          Number(left.hlcWallMs) - Number(right.hlcWallMs)
          || Number(left.hlcCounter) - Number(right.hlcCounter)
          || String(left.id).localeCompare(String(right.id));
        const durationOperations = (results.durationOperations || [])
          .map((operation) => {
            const normalized = core.durationRequestOperation(operation);
            if (normalized.occurredAt !== operation.occurredAt) {
              transaction.objectStore(DURATION_PENDING_STORE).put({ ...operation, occurredAt: normalized.occurredAt });
            }
            return { ...operation, occurredAt: normalized.occurredAt };
          })
          .sort(operationOrder);
        const resolutionInput = {
          ...input,
          commands,
          taskOperations: (results.taskOperations || []).sort(operationOrder),
          durationOperations,
          selectedTaskOperations: (results.selectedTaskOperations || []).sort(operationOrder)
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
    if (canonical.clockOffset != null && !core.validClockSample(canonical.clockOffset)) {
      return Promise.reject(new ClockRangeError());
    }
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        [META_STORE, PENDING_STORE, TASK_PENDING_STORE, DURATION_PENDING_STORE, AUTO_START_PENDING_STORE, SELECTED_TASK_PENDING_STORE],
        "readwrite"
      );
      const metaStore = transaction.objectStore(META_STORE);
      const requests = {
        gate: metaStore.get(GATE_KEY),
        resolution: metaStore.get(RESOLUTION_KEY),
        snapshot: metaStore.get("snapshot"),
        hlc: metaStore.get("hlc"),
        settings: metaStore.get("settings"),
        clockOffset: metaStore.get(CLOCK_OFFSET_KEY),
        timerOwner: metaStore.get(TIMER_OWNER_KEY),
        commands: transaction.objectStore(PENDING_STORE).getAll()
      };
      const results = {};
      let remaining = Object.keys(requests).length;
      let outcome;
      let failure = null;
      const completeLegacyMigrations = () => {
        const value = { ...(results.settings?.value || {}) };
        if (!Object.prototype.hasOwnProperty.call(pending.payload || {}, "autoStartOperations")) {
          delete value.autoStartBreaks;
          delete value.autoStartBreaksExplicit;
          value.autoStartSyncBootstrapped = true;
        }
        if (Object.prototype.hasOwnProperty.call(pending.payload || {}, "selectedTaskOperations")) {
          delete value.selectedTaskId;
          value.selectedTaskSyncBootstrapped = true;
        }
        metaStore.put({
          key: "settings",
          value
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
          completeLegacyMigrations();
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
          outcome.clockOffset = putLatestClockOffset(metaStore, results.clockOffset?.value || null, canonical.clockOffset);
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
        const selectedTaskPendingStore = transaction.objectStore(SELECTED_TASK_PENDING_STORE);
        for (const id of queueIds.selectedTaskOperations || []) selectedTaskPendingStore.delete(id);
        completeLegacyMigrations();
        metaStore.put({ key: "snapshot", value: canonical.snapshot });
        const clockOffset = putLatestClockOffset(metaStore, results.clockOffset?.value || null, canonical.clockOffset);
        const responseHlc = canonical.clockOffset != null && clockOffset === canonical.clockOffset
          ? canonical.hlc
          : canonical.serverHlc || canonical.hlc;
        const hlc = laterHlc(results.hlc?.value, responseHlc);
        metaStore.put({ key: "hlc", value: hlc });
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
        outcome = { applied: true, staleSuccess: false, snapshot: canonical.snapshot, hlc, clockOffset };
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
    if (input.clockOffset != null && !core.validClockSample(input.clockOffset)) {
      return Promise.reject(new ClockRangeError());
    }
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        [META_STORE, PENDING_STORE, TASK_PENDING_STORE, DURATION_PENDING_STORE, AUTO_START_PENDING_STORE, SELECTED_TASK_PENDING_STORE],
        "readwrite"
      );
      const metaStore = transaction.objectStore(META_STORE);
      const requests = {
        gate: metaStore.get(GATE_KEY),
        resolution: metaStore.get(RESOLUTION_KEY),
        snapshot: metaStore.get("snapshot"),
        hlc: metaStore.get("hlc"),
        clockOffset: metaStore.get(CLOCK_OFFSET_KEY),
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
        if (!core.validDateTime(input.snapshot.serverTime)) {
          failure = new Error("Sync response returned an invalid serverTime.");
          transaction.abort();
          return;
        }
        const storedRevision = Number(storedSnapshot?.revision || 0);
        const incomingRevision = Number(input.snapshot.revision);
        if (storedRevision > incomingRevision) {
          const clockOffset = putLatestClockOffset(metaStore, results.clockOffset?.value || null, input.clockOffset);
          claimMissingTimerOwner(
            metaStore,
            results.timerOwner?.value || null,
            storedSnapshot,
            results.commands || [],
            input.timerOwnerClaim
          );
          outcome = { applied: false, stale: true, snapshot: storedSnapshot, clockOffset };
          return;
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
        const selectedTaskPendingStore = transaction.objectStore(SELECTED_TASK_PENDING_STORE);
        for (const id of input.queueIds.selectedTaskOperations || []) selectedTaskPendingStore.delete(id);
        metaStore.put({ key: "snapshot", value: input.snapshot });
        if (input.settings) metaStore.put({ key: "settings", value: input.settings });
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
        const clockOffset = putLatestClockOffset(metaStore, results.clockOffset?.value || null, input.clockOffset);
        const responseHlc = input.clockOffset != null && clockOffset === input.clockOffset
          ? input.hlc
          : input.serverHlc || input.hlc;
        const hlc = laterHlc(results.hlc?.value, responseHlc);
        metaStore.put({ key: "hlc", value: hlc });
        outcome = { applied: true, stale: false, snapshot: input.snapshot, hlc, clockOffset };
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
      [PENDING_STORE, TASK_PENDING_STORE, DURATION_PENDING_STORE, AUTO_START_PENDING_STORE, SELECTED_TASK_PENDING_STORE],
      "readonly"
    );
    const [commands, taskOperations, durationOperations, autoStartOperations, selectedTaskOperations] = await Promise.all([
      requestResult(transaction.objectStore(PENDING_STORE).getAll()),
      requestResult(transaction.objectStore(TASK_PENDING_STORE).getAll()),
      requestResult(transaction.objectStore(DURATION_PENDING_STORE).getAll()),
      requestResult(transaction.objectStore(AUTO_START_PENDING_STORE).getAll()),
      requestResult(transaction.objectStore(SELECTED_TASK_PENDING_STORE).getAll())
    ]);
    return { commands, taskOperations, durationOperations, autoStartOperations, selectedTaskOperations };
  }

  async function readCanonicalState(database) {
    const transaction = database.transaction(META_STORE, "readonly");
    const store = transaction.objectStore(META_STORE);
    const [snapshot, hlc, clockOffset] = await Promise.all([
      requestResult(store.get("snapshot")),
      requestResult(store.get("hlc")),
      requestResult(store.get(CLOCK_OFFSET_KEY))
    ]);
    return {
      snapshot: snapshot?.value || null,
      hlc: hlc?.value || null,
      clockOffset: core.validClockSample(clockOffset?.value) ? clockOffset.value : null
    };
  }

  async function readSyncState(database) {
    const transaction = database.transaction(
      [META_STORE, PENDING_STORE, TASK_PENDING_STORE, DURATION_PENDING_STORE, AUTO_START_PENDING_STORE, SELECTED_TASK_PENDING_STORE],
      "readonly"
    );
    const metaStore = transaction.objectStore(META_STORE);
    const [snapshot, hlc, clockOffset, commands, taskOperations, durationOperations, autoStartOperations, selectedTaskOperations] = await Promise.all([
      requestResult(metaStore.get("snapshot")),
      requestResult(metaStore.get("hlc")),
      requestResult(metaStore.get(CLOCK_OFFSET_KEY)),
      requestResult(transaction.objectStore(PENDING_STORE).getAll()),
      requestResult(transaction.objectStore(TASK_PENDING_STORE).getAll()),
      requestResult(transaction.objectStore(DURATION_PENDING_STORE).getAll()),
      requestResult(transaction.objectStore(AUTO_START_PENDING_STORE).getAll()),
      requestResult(transaction.objectStore(SELECTED_TASK_PENDING_STORE).getAll())
    ]);
    return {
      snapshot: snapshot?.value || null,
      hlc: hlc?.value || null,
      clockOffset: core.validClockSample(clockOffset?.value) ? clockOffset.value : null,
      commands,
      taskOperations,
      durationOperations,
      autoStartOperations,
      selectedTaskOperations
    };
  }

  function migrateLegacySelectedTask(database, input) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction([META_STORE, SELECTED_TASK_PENDING_STORE], "readwrite");
      const metaStore = transaction.objectStore(META_STORE);
      const settingsRequest = metaStore.get("settings");
      let result;
      settingsRequest.onsuccess = () => {
        const settings = settingsRequest.result?.value || {};
        if (settings.selectedTaskSyncBootstrapped === true) {
          result = { migrated: false, operation: null };
          return;
        }
        const { selectedTaskId, ...nextSettings } = settings;
        let operation = null;
        if (typeof selectedTaskId === "string" && selectedTaskId) {
          operation = {
            id: input.operationId,
            taskId: selectedTaskId,
            occurredAt: LEGACY_EPOCH,
            hlcWallMs: 0,
            hlcCounter: 0
          };
          transaction.objectStore(SELECTED_TASK_PENDING_STORE).add(operation);
        }
        metaStore.put({
          key: "settings",
          value: { ...nextSettings, selectedTaskSyncBootstrapped: true }
        });
        result = { migrated: operation !== null, operation };
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error || new Error("Storage transaction aborted."));
      transaction.onerror = () => {};
    });
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

  function normalizeLegacyDurationOperations(database, options = {}) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction([META_STORE, DURATION_PENDING_STORE], "readwrite");
      const metaStore = transaction.objectStore(META_STORE);
      const durationStore = transaction.objectStore(DURATION_PENDING_STORE);
      const durationsRequest = durationStore.getAll();
      const gateRequest = metaStore.get(GATE_KEY);
      const resolutionRequest = metaStore.get(RESOLUTION_KEY);
      let durations;
      let gateRecord;
      let resolutionRecord;
      let remaining = 3;
      let changed = 0;
      let resolution = null;
      let failure = null;
      const normalize = (operation) => {
        if (Number(operation?.hlcWallMs) !== 0 || Number(operation?.hlcCounter) !== 0 || operation.occurredAt === LEGACY_EPOCH) return operation;
        changed += 1;
        return { ...operation, occurredAt: LEGACY_EPOCH };
      };
      const complete = () => {
        remaining -= 1;
        if (remaining !== 0) return;
        for (const operation of durations || []) {
          const normalized = normalize(operation);
          if (normalized !== operation) durationStore.put(normalized);
        }
        const captured = resolutionRecord?.value || null;
        const capturedOperations = captured?.payload?.durationOperations;
        const needsRotation = Array.isArray(capturedOperations) && capturedOperations.some((operation) =>
          Number(operation?.hlcWallMs) === 0 && Number(operation?.hlcCounter) === 0 && operation.occurredAt !== LEGACY_EPOCH
        );
        if (!needsRotation) {
          resolution = captured;
          return;
        }
        const gate = gateRecord?.value || null;
        if (!options.gateToken) {
          resolution = captured;
          return;
        }
        if (gate?.token !== options.gateToken || captured.gateToken !== options.gateToken) {
          failure = new BootstrapGateError("Bootstrap gate is owned by another tab.");
          transaction.abort();
          return;
        }
        if (typeof options.replacementRequestId !== "string" || !options.replacementRequestId
          || options.replacementRequestId === captured.payload.requestId) {
          failure = new BootstrapGateError("Legacy history resolution requires a fresh request ID.");
          transaction.abort();
          return;
        }
        const normalized = capturedOperations.map(normalize);
        resolution = {
          ...captured,
          payload: { ...captured.payload, requestId: options.replacementRequestId, durationOperations: normalized }
        };
        metaStore.put({ key: RESOLUTION_KEY, value: resolution });
      };
      durationsRequest.onsuccess = () => {
        durations = durationsRequest.result || [];
        complete();
      };
      gateRequest.onsuccess = () => {
        gateRecord = gateRequest.result;
        complete();
      };
      resolutionRequest.onsuccess = () => {
        resolutionRecord = resolutionRequest.result;
        complete();
      };
      transaction.oncomplete = () => resolve({ changed, resolution });
      transaction.onabort = () => reject(failure || transaction.error || new Error("Storage transaction aborted."));
      transaction.onerror = () => {};
    });
  }

  return Object.freeze({
    BootstrapGateError,
    AccountOwnershipError,
    ClockRangeError,
    UUIDRangeError,
    ResolutionLimitError,
    GATE_KEY,
    RESOLUTION_KEY,
    UUID7_KEY,
    UUID7_MAX_TIMESTAMP_MS,
    UUID7_RANDOM_MAX,
    acquireBootstrapGate,
    acquireBootstrapGateWithLegacyAutoStart,
    allocateClockRequestSequence,
    allocateMutation,
    applyResolution,
    applySyncResponse,
    cancelAndClearTimer,
    captureResolution,
    clearBootstrapGate,
    finishTimer,
    guardedMutation,
    invalidateForeignResolution,
    leaseIsLive,
    migrateLegacyAutoStart,
    migrateLegacySelectedTask,
    normalizeLegacyDurationOperations,
    releaseTimerOwnership,
    readBootstrapState,
    readCanonicalState,
    readQueues,
    readSyncState,
    requestResult,
    renewTimerOwnership,
    saveClockOffset,
    transactionDone,
    reserveUuid7,
    uuid7FromParts,
    uuid7Parts,
    validatePendingForSend
  });
});
