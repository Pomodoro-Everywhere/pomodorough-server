(() => {
  "use strict";

  const DB_NAME = "pomodorough";
  const DB_VERSION = 4;
  const syncCore = globalThis.PomodoroughSync;
  const syncStorage = globalThis.PomodoroughStorage;
  const META_STORE = "meta";
  const PENDING_STORE = "pending";
  const TASK_PENDING_STORE = "pendingTasks";
  const DURATION_PENDING_STORE = "pendingDurations";
  const AUTO_START_PENDING_STORE = "pendingAutoStarts";
  const TAB_ID = tabID();
  const CACHE_PREFIX = "pomodorough-shell-";
  const DIAL_RADIUS = 108;
  const DIAL_CIRCUMFERENCE = 2 * Math.PI * DIAL_RADIUS;
  const RETRY_MAX_MS = 60000;
  const BOOTSTRAP_LEASE_MS = 5 * 60_000;
  const TIMER_OWNER_LEASE_MS = 60_000;
  const TIMER_OWNER_HEARTBEAT_MS = 15_000;
  const PHASES = {
    focus: { label: "Focus", short: "F", defaultMinutes: 25 },
    short_break: { label: "Short break", short: "SB", defaultMinutes: 5 },
    long_break: { label: "Long break", short: "LB", defaultMinutes: 15 }
  };
  const DEFAULT_DURATIONS_MS = {
    focus: 1_500_000,
    short_break: 300_000,
    long_break: 900_000
  };
  const ACK_SUCCESS = new Set(["accepted", "acknowledged", "applied", "duplicate", "ok"]);

  function tabID() {
    try {
      const existing = sessionStorage.getItem("pomodoroughTabId");
      if (existing) return existing;
      const created = crypto.randomUUID();
      sessionStorage.setItem("pomodoroughTabId", created);
      return created;
    } catch {
      return crypto.randomUUID();
    }
  }

  const elements = {
    installButton: document.querySelector("#installButton"),
    syncStatus: document.querySelector("#syncStatus"),
    syncStatusText: document.querySelector("#syncStatusText"),
    profile: document.querySelector("#profile"),
    profileAvatar: document.querySelector("#profileAvatar"),
    profileName: document.querySelector("#profileName"),
    logoutButton: document.querySelector("#logoutButton"),
    conflictPanel: document.querySelector("#conflictPanel"),
    conflictReason: document.querySelector("#conflictReason"),
    conflictDismiss: document.querySelector("#conflictDismiss"),
    notice: document.querySelector("#notice"),
    bootstrapDialog: document.querySelector("#bootstrapDialog"),
    bootstrapTitle: document.querySelector("#bootstrapTitle"),
    bootstrapSummary: document.querySelector("#bootstrapSummary"),
    bootstrapChoices: document.querySelector("#bootstrapChoices"),
    bootstrapChoiceButtons: [...document.querySelectorAll("[data-bootstrap-strategy]")],
    bootstrapConfirmation: document.querySelector("#bootstrapConfirmation"),
    bootstrapConfirmationTitle: document.querySelector("#bootstrapConfirmationTitle"),
    bootstrapConfirmationMessage: document.querySelector("#bootstrapConfirmationMessage"),
    bootstrapConfirm: document.querySelector("#bootstrapConfirm"),
    bootstrapCancel: document.querySelector("#bootstrapCancel"),
    bootstrapError: document.querySelector("#bootstrapError"),
    bootstrapRetry: document.querySelector("#bootstrapRetry"),
    bootstrapSignOut: document.querySelector("#bootstrapSignOut"),
    screenButtons: [...document.querySelectorAll("[data-screen-button]")],
    timerScreen: document.querySelector("#timerScreen"),
    tasksScreen: document.querySelector("#tasksScreen"),
    durationForm: document.querySelector("#durationForm"),
    phaseButtons: [...document.querySelectorAll(".phase-button")],
    durationInputs: [...document.querySelectorAll(".stepper input")],
    stepButtons: [...document.querySelectorAll("[data-step]")],
    autoStartBreaks: document.querySelector("#autoStartBreaks"),
    taskSelector: document.querySelector("#taskSelector"),
    dial: document.querySelector("#dial"),
    dialTicks: document.querySelector("#dialTicks"),
    dialProgress: document.querySelector("#dialProgress"),
    phaseLabel: document.querySelector("#phaseLabel"),
    timerDisplay: document.querySelector("#timerDisplay"),
    timerDetail: document.querySelector("#timerDetail"),
    timerInstruction: document.querySelector("#timerInstruction"),
    timerToggle: document.querySelector("#timerToggle"),
    finishButton: document.querySelector("#finishButton"),
    cancelButton: document.querySelector("#cancelButton"),
    clearButton: document.querySelector("#clearButton"),
    historyList: document.querySelector("#historyList"),
    historyCount: document.querySelector("#historyCount"),
    taskForm: document.querySelector("#taskForm"),
    taskInput: document.querySelector("#taskInput"),
    taskList: document.querySelector("#taskList"),
    taskCount: document.querySelector("#taskCount"),
    deviceMark: document.querySelector("#deviceMark")
  };

  let db;
  let syncPromise = null;
  let syncAgain = false;
  let syncAgainForce = false;
  let retryTimer = null;
  let retryDelayMs = 1000;
  let eventSource = null;
  let installPrompt = null;
  let actionLocked = false;
  let completionQueuedFor = null;
  let completionRetryTimer = null;
  let noticeTimer = null;
  let redirecting = false;
  let inFlightDurationOperationIds = new Set();
  let bootstrapPromise = null;
  let elapsedMonotonicAnchor = null;
  let trustedClockRuntime = null;

  const state = {
    ready: false,
    authenticated: false,
    sessionIdentityValidated: false,
    offlineOwnerMode: false,
    user: null,
    csrfToken: null,
    deviceId: null,
    deviceSequence: 0,
    hlcWallMs: 0,
    hlcCounter: 0,
    clockOffset: null,
    revision: 0,
    activeScreen: "timer",
    selectedPhase: "focus",
    selectedTaskId: null,
    baseAutoStartBreaks: false,
    autoStartBreaks: false,
    baseDurationsMs: clone(DEFAULT_DURATIONS_MS),
    durationsMs: clone(DEFAULT_DURATIONS_MS),
    baseTimer: emptyTimer("focus", 25 * 60000),
    timer: emptyTimer("focus", 25 * 60000),
    baseHistory: [],
    history: [],
    baseTasks: [],
    tasks: [],
    pending: [],
    pendingTaskOperations: [],
    pendingDurationOperations: [],
    pendingAutoStartOperations: [],
    durationSyncBootstrapped: false,
    autoStartSyncBootstrapped: false,
    syncing: false,
    retrying: false,
    conflict: null,
    localOwnerId: null,
    bootstrapBlocked: true,
    bootstrapPreview: null,
    bootstrapPlan: null,
    bootstrapStrategy: null,
    bootstrapPending: null,
    bootstrapSubmitting: false,
    bootstrapConflict: false,
    bootstrapError: null,
    bootstrapLimitError: null,
    bootstrapGatePersisted: false,
    bootstrapGateOwned: false,
    quarantinedLocal: null,
    bootstrapFocusTarget: null
  };

  function emptyTimer(phase, plannedDurationMs) {
    return {
      id: null,
      phase,
      status: "idle",
      plannedDurationMs,
      elapsedAtAnchorMs: 0,
      anchorAt: null,
      lastIntent: null,
      taskId: null,
      dependsOnCommandId: null
    };
  }

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function controlsBlocked() {
    return !state.ready || needsBootstrapResolution();
  }

  function normalizeTimer(timer) {
    if (!timer || typeof timer !== "object") {
      return emptyTimer(state.selectedPhase, selectedDurationMs());
    }

    const phase = PHASES[timer.phase] ? timer.phase : "focus";
    const plannedDurationMs = positiveNumber(
      timer.plannedDurationMs,
      state.durationsMs[phase]
    );

    return {
      ...timer,
      id: timer.id || null,
      phase,
      status: ["idle", "running", "paused", "completed", "cancelled", "superseded"].includes(timer.status)
        ? timer.status
        : "idle",
      plannedDurationMs,
      elapsedAtAnchorMs: clampNumber(timer.elapsedAtAnchorMs, 0, plannedDurationMs),
      anchorAt: timer.anchorAt || null,
      lastIntent: timer.lastIntent || null,
      taskId: timer.taskId || null,
      dependsOnCommandId: timer.dependsOnCommandId || null
    };
  }

  function normalizeTaskTitle(value) {
    const characters = [...String(value || "").normalize("NFC")];
    const printable = (character) => character === " " || !/[\p{C}\p{Z}]/u.test(character);
    let start = 0;
    let end = characters.length;
    while (start < end && !printable(characters[start])) start += 1;
    while (end > start && !printable(characters[end - 1])) end -= 1;
    return characters.slice(start, end).join("");
  }

  async function deterministicTaskId(title) {
    const normalized = normalizeTaskTitle(title);
    const bytes = new TextEncoder().encode(`pomodorough.task.v1\u0000${normalized}`);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const uuid = digest.slice(0, 16);
    uuid[6] = (uuid[6] & 0x0f) | 0x80;
    uuid[8] = (uuid[8] & 0x3f) | 0x80;
    const hex = [...uuid].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  function clampNumber(value, minimum, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number)) return minimum;
    return Math.min(maximum, Math.max(minimum, number));
  }

  function selectedDurationMs() {
    return state.durationsMs[state.selectedPhase];
  }

  function normalizeDurationsMs(value) {
    return Object.fromEntries(Object.keys(PHASES).map((phase) => [phase, Math.round(clampNumber(
      value?.[phase] ?? DEFAULT_DURATIONS_MS[phase],
      60_000,
      10_800_000
    ))]));
  }

  function compareDurationOperations(left, right) {
    return Number(left.hlcWallMs) - Number(right.hlcWallMs)
      || Number(left.hlcCounter) - Number(right.hlcCounter)
      || String(left.id).localeCompare(String(right.id));
  }

  const compareTimerCommands = syncCore.compareTimerCommands;

  function trustedNow(localNowMs = Date.now(), monotonicMs = monotonicNow()) {
    const sample = syncCore.validClockSample(state.clockOffset) ? state.clockOffset : null;
    const identity = sample
      ? `${sample.offsetMs}:${sample.uncertaintyMs}:${sample.sampledAtWallMs}`
      : "local";
    if (monotonicMs === null) return syncCore.trustedNow(localNowMs, sample, state.hlcWallMs);
    if (trustedClockRuntime?.identity !== identity || monotonicMs < trustedClockRuntime.monotonicMs) {
      const wallMs = syncCore.trustedNow(localNowMs, sample, state.hlcWallMs);
      trustedClockRuntime = { identity, monotonicMs, wallMs };
      return wallMs;
    }
    const wallMs = trustedClockRuntime.wallMs + Math.round(monotonicMs - trustedClockRuntime.monotonicMs);
    return syncCore.trustedNow(wallMs, null, state.hlcWallMs);
  }

  function monotonicNow() {
    const value = globalThis.performance?.now?.();
    return Number.isFinite(value) ? value : null;
  }

  function elapsedFor(timer, now = trustedNow(), monotonicMs = monotonicNow()) {
    if (!timer) return 0;

    const planned = positiveNumber(timer.plannedDurationMs, 0);
    let elapsed = clampNumber(timer.elapsedAtAnchorMs, 0, planned);

    if (timer.status === "running" && timer.anchorAt) {
      const anchorMs = Date.parse(timer.anchorAt);
      if (Number.isFinite(anchorMs)) elapsed += Math.max(0, now - anchorMs);
      const key = `${timer.id || ""}\u0000${timer.anchorAt}\u0000${timer.elapsedAtAnchorMs}`;
      if (monotonicMs !== null) {
        if (elapsedMonotonicAnchor?.key === key && monotonicMs >= elapsedMonotonicAnchor.monotonicMs) {
          elapsed = elapsedMonotonicAnchor.elapsedMs + monotonicMs - elapsedMonotonicAnchor.monotonicMs;
        } else {
          elapsedMonotonicAnchor = { key, elapsedMs: elapsed, monotonicMs };
        }
      }
    } else if (elapsedMonotonicAnchor) {
      elapsedMonotonicAnchor = null;
    }

    return clampNumber(elapsed, 0, planned);
  }

  function commandMatches(timer, command) {
    return Boolean(timer?.id && command.timerId === timer.id);
  }

  function terminalHistoryItem(timer, command, status) {
    return {
      id: timer.id,
      timerId: timer.id,
      commandId: command.id,
      phase: timer.phase,
      status,
      plannedDurationMs: timer.plannedDurationMs,
      completedAt: status === "completed" ? command.occurredAt : null,
      endedAt: command.occurredAt,
      taskId: timer.taskId || null,
      pending: true
    };
  }

  function autoCompleteTimer(timer, history, occurredAt) {
    if (!timer || timer.status !== "running") return { timer, history };
    const anchorMs = Date.parse(timer.anchorAt);
    const occurredAtMs = Date.parse(occurredAt);
    if (!Number.isFinite(anchorMs) || !Number.isFinite(occurredAtMs)) return { timer, history };

    const planned = Math.max(0, Number(timer.plannedDurationMs) || 0);
    const stored = clampNumber(timer.elapsedAtAnchorMs, 0, planned);
    const remaining = planned - stored;
    if (Math.max(0, occurredAtMs - anchorMs) < remaining) return { timer, history };

    const completedAt = new Date(anchorMs + remaining).toISOString();
    const completed = {
      ...timer,
      status: "completed",
      elapsedAtAnchorMs: planned,
      anchorAt: completedAt
    };
    if (!history.some((item) => item.timerId === timer.id)) {
      history.unshift({
        id: timer.id,
        timerId: timer.id,
        commandId: null,
        phase: timer.phase,
        status: "completed",
        plannedDurationMs: timer.plannedDurationMs,
        completedAt,
        endedAt: completedAt,
        taskId: timer.taskId || null
      });
    }
    return { timer: completed, history };
  }

  function reduceCommand(timer, history, command) {
    const projected = autoCompleteTimer(clone(timer), clone(history || []), command.occurredAt);
    let nextTimer = projected.timer;
    let nextHistory = projected.history;
    const intent = { type: command.type, commandId: command.id, occurredAt: command.occurredAt };

    function addTerminalHistory(source, status) {
      if (nextHistory.some((item) => item.commandId === command.id)) return;
      nextHistory.unshift(terminalHistoryItem(source, command, status));
    }

    switch (command.type) {
      case "start":
        if (nextTimer?.id === command.timerId || nextHistory.some((item) => item.timerId === command.timerId)) break;
        if (["running", "paused"].includes(nextTimer?.status)) addTerminalHistory(nextTimer, "superseded");
        return {
          timer: {
            id: command.timerId,
            phase: command.phase,
            status: "running",
            plannedDurationMs: command.plannedDurationMs,
            elapsedAtAnchorMs: 0,
            anchorAt: command.occurredAt,
            lastIntent: intent,
            taskId: command.taskId || null,
            dependsOnCommandId: command.dependsOnCommandId || null
          },
          history: nextHistory
        };

      case "pause":
        if (!commandMatches(nextTimer, command) || nextTimer.status !== "running") break;
        nextTimer.status = "paused";
        nextTimer.elapsedAtAnchorMs = clampNumber(command.observedElapsedMs, 0, nextTimer.plannedDurationMs);
        nextTimer.anchorAt = command.occurredAt;
        nextTimer.lastIntent = intent;
        break;

      case "resume":
        if (commandMatches(nextTimer, command) && ["paused", "superseded"].includes(nextTimer.status)) {
          if (nextTimer.status === "superseded") {
            nextHistory = nextHistory.filter((item) =>
              item.timerId !== nextTimer.id || item.status !== "superseded"
            );
          }
          nextTimer.status = "running";
          nextTimer.elapsedAtAnchorMs = clampNumber(command.observedElapsedMs, 0, nextTimer.plannedDurationMs);
          nextTimer.anchorAt = command.occurredAt;
          nextTimer.lastIntent = intent;
          break;
        }
        {
          const target = nextHistory.find((item) =>
            item.timerId === command.timerId && item.status === "superseded"
          );
          if (!target) break;
          if (["running", "paused"].includes(nextTimer?.status)) addTerminalHistory(nextTimer, "superseded");
          nextHistory = nextHistory.filter((item) =>
            item.timerId !== target.timerId || item.status !== "superseded"
          );
          return {
            timer: {
              id: target.timerId,
              phase: target.phase,
              status: "running",
              plannedDurationMs: target.plannedDurationMs,
              elapsedAtAnchorMs: clampNumber(command.observedElapsedMs, 0, target.plannedDurationMs),
              anchorAt: command.occurredAt,
              lastIntent: intent,
              taskId: target.taskId || null,
              dependsOnCommandId: null
            },
            history: nextHistory
          };
        }

      case "finish":
        if (commandMatches(nextTimer, command) && nextTimer.status === "completed") {
          const completionIndex = nextHistory.findIndex((item) =>
            item.timerId === command.timerId && item.status === "completed" && !item.commandId
          );
          if (completionIndex >= 0) {
            nextHistory[completionIndex] = {
              ...nextHistory[completionIndex],
              commandId: command.id,
              pending: true
            };
            nextTimer.lastIntent = intent;
          }
          break;
        }
        if (!commandMatches(nextTimer, command) || !["running", "paused"].includes(nextTimer.status)) break;
        {
          const source = clone(nextTimer);
          nextTimer.status = "completed";
          nextTimer.elapsedAtAnchorMs = nextTimer.plannedDurationMs;
          nextTimer.anchorAt = command.occurredAt;
          nextTimer.lastIntent = intent;
          addTerminalHistory(source, "completed");
        }
        break;

      case "cancel":
        if (!commandMatches(nextTimer, command) || !["running", "paused"].includes(nextTimer.status)) break;
        {
          const source = clone(nextTimer);
          nextTimer.status = "cancelled";
          nextTimer.elapsedAtAnchorMs = clampNumber(command.observedElapsedMs, 0, nextTimer.plannedDurationMs);
          nextTimer.anchorAt = command.occurredAt;
          nextTimer.lastIntent = intent;
          addTerminalHistory(source, "cancelled");
        }
        break;

      case "clear":
        if (!commandMatches(nextTimer, command) || !["completed", "cancelled"].includes(nextTimer.status)) break;
        return {
          timer: emptyTimer(command.phase, command.plannedDurationMs),
          history: nextHistory
        };
    }

    return { timer: nextTimer, history: nextHistory };
  }

  function rebuildOptimisticState() {
    rebuildOptimisticDurations();
    rebuildOptimisticAutoStart();
    let timer = normalizeTimer(state.baseTimer);
    let history = clone(state.baseHistory || []);

    for (const command of [...state.pending].sort(compareTimerCommands)) {
      const reduced = reduceCommand(timer, history, command);
      timer = reduced.timer;
      history = reduced.history;
    }

    state.timer = timer;
    state.history = history;
    rebuildOptimisticTasks();
  }

  function rebuildOptimisticDurations() {
    state.durationsMs = syncCore.applyDurationOperations(
      normalizeDurationsMs(state.baseDurationsMs),
      state.pendingDurationOperations
    );
  }

  function rebuildOptimisticAutoStart() {
    state.autoStartBreaks = syncCore.applyAutoStartOperations(
      state.baseAutoStartBreaks,
      state.pendingAutoStartOperations
    );
  }

  function rebuildOptimisticTasks() {
    const tasks = new Map((state.baseTasks || []).map((task) => [task.id, clone(task)]));
    const operations = [...state.pendingTaskOperations].sort((left, right) =>
      left.hlcWallMs - right.hlcWallMs || left.hlcCounter - right.hlcCounter || left.id.localeCompare(right.id)
    );
    for (const operation of operations) {
      if (operation.type === "upsert") tasks.set(operation.taskId, { id: operation.taskId, title: operation.title });
      if (operation.type === "delete") tasks.delete(operation.taskId);
    }
    state.tasks = [...tasks.values()].sort((left, right) =>
      left.title.localeCompare(right.title) || left.id.localeCompare(right.id)
    );
    if (state.selectedTaskId && !tasks.has(state.selectedTaskId)) state.selectedTaskId = null;
  }

  function ownerStateValue() {
    return {
      revision: state.revision,
      selectedPhase: state.selectedPhase,
      selectedTaskId: state.selectedTaskId,
      baseAutoStartBreaks: state.baseAutoStartBreaks,
      autoStartBreaks: state.autoStartBreaks,
      baseDurationsMs: clone(state.baseDurationsMs),
      durationsMs: clone(state.durationsMs),
      baseTimer: clone(state.baseTimer),
      timer: clone(state.timer),
      baseHistory: clone(state.baseHistory),
      history: clone(state.history),
      baseTasks: clone(state.baseTasks),
      tasks: clone(state.tasks),
      pending: clone(state.pending),
      pendingTaskOperations: clone(state.pendingTaskOperations),
      pendingDurationOperations: clone(state.pendingDurationOperations),
      pendingAutoStartOperations: clone(state.pendingAutoStartOperations),
      user: clone(state.user)
    };
  }

  function resetOwnerState() {
    state.revision = 0;
    state.selectedPhase = "focus";
    state.selectedTaskId = null;
    state.baseAutoStartBreaks = false;
    state.autoStartBreaks = false;
    state.baseDurationsMs = clone(DEFAULT_DURATIONS_MS);
    state.durationsMs = clone(DEFAULT_DURATIONS_MS);
    state.baseTimer = emptyTimer("focus", DEFAULT_DURATIONS_MS.focus);
    state.timer = emptyTimer("focus", DEFAULT_DURATIONS_MS.focus);
    state.baseHistory = [];
    state.history = [];
    state.baseTasks = [];
    state.tasks = [];
    state.pending = [];
    state.pendingTaskOperations = [];
    state.pendingDurationOperations = [];
    state.pendingAutoStartOperations = [];
    state.user = null;
  }

  function quarantineOwnerState(preserveValidatedUser = false) {
    const user = preserveValidatedUser ? state.user : null;
    if (!state.quarantinedLocal) state.quarantinedLocal = ownerStateValue();
    resetOwnerState();
    if (user) state.user = user;
  }

  function restoreOwnerState(local) {
    state.revision = local.revision;
    state.selectedPhase = local.selectedPhase;
    state.selectedTaskId = local.selectedTaskId;
    state.baseAutoStartBreaks = local.baseAutoStartBreaks;
    state.autoStartBreaks = local.autoStartBreaks;
    state.baseDurationsMs = local.baseDurationsMs;
    state.durationsMs = local.durationsMs;
    state.baseTimer = local.baseTimer;
    state.timer = local.timer;
    state.baseHistory = local.baseHistory;
    state.history = local.history;
    state.baseTasks = local.baseTasks;
    state.tasks = local.tasks;
    state.pending = local.pending;
    state.pendingTaskOperations = local.pendingTaskOperations;
    state.pendingDurationOperations = local.pendingDurationOperations;
    state.pendingAutoStartOperations = local.pendingAutoStartOperations;
    state.user = local.user;
  }

  async function activateCachedOwnerOffline() {
    const local = state.quarantinedLocal;
    if (!syncCore.canUseCachedOwnerOffline({
      sessionValidated: state.sessionIdentityValidated,
      cachedUserId: local?.user?.id,
      localOwnerId: state.localOwnerId,
      gateOwned: state.bootstrapGateOwned,
      pending: state.bootstrapPending
    })) return false;
    try {
      await syncStorage.clearBootstrapGate(db, TAB_ID);
    } catch {
      return false;
    }
    restoreOwnerState(local);
    state.quarantinedLocal = null;
    state.authenticated = false;
    state.csrfToken = null;
    state.offlineOwnerMode = true;
    state.bootstrapBlocked = false;
    state.bootstrapGatePersisted = false;
    state.bootstrapGateOwned = false;
    return true;
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(META_STORE)) {
          database.createObjectStore(META_STORE, { keyPath: "key" });
        }
        if (!database.objectStoreNames.contains(PENDING_STORE)) {
          database.createObjectStore(PENDING_STORE, { keyPath: "id" });
        }
        if (!database.objectStoreNames.contains(TASK_PENDING_STORE)) {
          database.createObjectStore(TASK_PENDING_STORE, { keyPath: "id" });
        }
        if (!database.objectStoreNames.contains(DURATION_PENDING_STORE)) {
          database.createObjectStore(DURATION_PENDING_STORE, { keyPath: "id" });
        }
        if (!database.objectStoreNames.contains(AUTO_START_PENDING_STORE)) {
          database.createObjectStore(AUTO_START_PENDING_STORE, { keyPath: "id" });
        }
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Timer storage is open in another outdated tab."));
    });
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

  function settingsValue(overrides = {}) {
    return {
      selectedPhase: state.selectedPhase,
      selectedTaskId: state.selectedTaskId,
      durationSyncBootstrapped: state.durationSyncBootstrapped,
      autoStartSyncBootstrapped: state.autoStartSyncBootstrapped,
      ...overrides
    };
  }

  function snapshotValue(overrides = {}) {
    return {
      revision: state.revision,
      canonicalTimer: clone(state.baseTimer),
      history: clone(state.baseHistory),
      tasks: clone(state.baseTasks),
      durationsMs: clone(state.baseDurationsMs),
      autoStartBreaks: state.baseAutoStartBreaks,
      user: clone(state.user),
      ...overrides
    };
  }

  async function migrateDurationQueueFromSettings() {
    const transaction = db.transaction([META_STORE, DURATION_PENDING_STORE], "readwrite");
    const metaStore = transaction.objectStore(META_STORE);
    const durationStore = transaction.objectStore(DURATION_PENDING_STORE);
    const request = metaStore.get("settings");
    request.onsuccess = () => {
      const record = request.result;
      const pending = record?.value?.pendingDurationOperations;
      if (!Array.isArray(pending)) return;
      for (const operation of pending) {
        durationStore.put(Number(operation?.hlcWallMs) === 0 && Number(operation?.hlcCounter) === 0
          ? { ...operation, occurredAt: new Date(0).toISOString() }
          : operation);
      }
      const { pendingDurationOperations, ...settings } = record.value;
      metaStore.put({ key: "settings", value: settings });
    };
    await transactionDone(transaction);
  }

  async function bootstrapLegacyDurations() {
    const transaction = db.transaction([META_STORE, DURATION_PENDING_STORE], "readwrite");
    const metaStore = transaction.objectStore(META_STORE);
    const durationStore = transaction.objectStore(DURATION_PENDING_STORE);
    const request = metaStore.get("settings");
    request.onsuccess = () => {
      const settings = request.result?.value || {};
      if (settings.durationSyncBootstrapped === true) return;
      for (const phase of Object.keys(PHASES)) {
        if (settings.durations?.[phase] == null) continue;
        const durationMs = Math.round(clampNumber(settings.durations[phase], 1, 180)) * 60_000;
        if (durationMs === DEFAULT_DURATIONS_MS[phase]) continue;
        durationStore.put({
          id: crypto.randomUUID(),
          ownerId: "bootstrap",
          phase,
          durationMs,
          occurredAt: new Date(0).toISOString(),
          hlcWallMs: 0,
          hlcCounter: 0
        });
      }
      const { durations, ...localSettings } = settings;
      metaStore.put({
        key: "settings",
        value: { ...localSettings, durationSyncBootstrapped: true }
      });
    };
    await transactionDone(transaction);
  }

  async function readPendingDurationOperations() {
    const transaction = db.transaction(DURATION_PENDING_STORE, "readonly");
    const operations = await requestResult(transaction.objectStore(DURATION_PENDING_STORE).getAll());
    return (operations || []).sort(compareDurationOperations);
  }

  async function refreshPendingDurationOperations() {
    state.pendingDurationOperations = await readPendingDurationOperations();
  }

  async function loadLocalState() {
    db = await openDatabase();

    const lease = await acquireBootstrapGate();
    state.bootstrapGatePersisted = true;
    state.bootstrapGateOwned = lease.acquired;
    const bootstrapState = await syncStorage.readBootstrapState(db);
    if (state.bootstrapGateOwned && !bootstrapState.resolution) {
      await migrateDurationQueueFromSettings();
      await bootstrapLegacyDurations();
    }
    const normalizedLegacyDurations = await syncStorage.normalizeLegacyDurationOperations(db, state.bootstrapGateOwned ? {
      gateToken: TAB_ID,
      replacementRequestId: crypto.randomUUID()
    } : undefined);

    const transaction = db.transaction(
      [META_STORE, PENDING_STORE, TASK_PENDING_STORE, DURATION_PENDING_STORE, AUTO_START_PENDING_STORE],
      "readonly"
    );
    const metaStore = transaction.objectStore(META_STORE);
    const pendingStore = transaction.objectStore(PENDING_STORE);
    const taskPendingStore = transaction.objectStore(TASK_PENDING_STORE);
    const durationPendingStore = transaction.objectStore(DURATION_PENDING_STORE);
    const autoStartPendingStore = transaction.objectStore(AUTO_START_PENDING_STORE);
    const [deviceId, deviceSequence, hlc, clockOffset, settings, snapshot, bootstrapResolution, pending, pendingTaskOperations, pendingDurationOperations, pendingAutoStartOperations] = await Promise.all([
      requestResult(metaStore.get("deviceId")),
      requestResult(metaStore.get("deviceSequence")),
      requestResult(metaStore.get("hlc")),
      requestResult(metaStore.get("clockOffset")),
      requestResult(metaStore.get("settings")),
      requestResult(metaStore.get("snapshot")),
      requestResult(metaStore.get("bootstrapResolution")),
      requestResult(pendingStore.getAll()),
      requestResult(taskPendingStore.getAll()),
      requestResult(durationPendingStore.getAll()),
      requestResult(autoStartPendingStore.getAll())
    ]);

    state.deviceId = deviceId?.value || crypto.randomUUID();
    state.deviceSequence = Number(deviceSequence?.value) || 0;
    state.hlcWallMs = Number(hlc?.value?.wallMs) || 0;
    state.hlcCounter = Number(hlc?.value?.counter) || 0;
    state.clockOffset = syncCore.validClockSample(clockOffset?.value) ? clockOffset.value : null;
    state.pending = (pending || []).sort(compareTimerCommands);
    state.pendingTaskOperations = pendingTaskOperations || [];
    state.pendingDurationOperations = (pendingDurationOperations || []).sort(compareDurationOperations);
    state.pendingAutoStartOperations = pendingAutoStartOperations || [];
    state.durationSyncBootstrapped = settings?.value?.durationSyncBootstrapped === true;
    state.autoStartSyncBootstrapped = settings?.value?.autoStartSyncBootstrapped === true;
    state.bootstrapPending = normalizedLegacyDurations.resolution || bootstrapResolution?.value || null;

    if (settings?.value) {
      state.selectedPhase = PHASES[settings.value.selectedPhase]
        ? settings.value.selectedPhase
        : "focus";
      state.selectedTaskId = settings.value.selectedTaskId || null;
    }

    if (snapshot?.value) {
      state.revision = snapshot.value.revision ?? 0;
      state.baseTimer = normalizeTimer(snapshot.value.canonicalTimer);
      state.baseHistory = Array.isArray(snapshot.value.history) ? snapshot.value.history : [];
      state.baseTasks = Array.isArray(snapshot.value.tasks) ? snapshot.value.tasks : [];
      state.baseDurationsMs = normalizeDurationsMs(snapshot.value.durationsMs);
      state.baseAutoStartBreaks = snapshot.value.autoStartBreaks === true;
      state.user = snapshot.value.user || null;
      state.localOwnerId = snapshot.value.user?.id || null;
    } else {
      state.baseTimer = emptyTimer(state.selectedPhase, selectedDurationMs());
    }

    const highestPendingSequence = state.pending.reduce(
      (highest, command) => Math.max(highest, Number(command.deviceSequence) || 0),
      0
    );
    state.deviceSequence = Math.max(state.deviceSequence, highestPendingSequence);

    if (!deviceId?.value) {
      const writeTransaction = db.transaction(META_STORE, "readwrite");
      const store = writeTransaction.objectStore(META_STORE);
      store.put({ key: "deviceId", value: state.deviceId });
      store.put({ key: "deviceSequence", value: state.deviceSequence });
      store.put({ key: "hlc", value: { wallMs: state.hlcWallMs, counter: state.hlcCounter } });
      store.put({ key: "settings", value: settingsValue() });
      await transactionDone(writeTransaction);
    }

    rebuildOptimisticState();
    quarantineOwnerState();
  }

  function acquireBootstrapGate() {
    const nowMs = Date.now();
    return syncStorage.acquireBootstrapGateWithLegacyAutoStart(db, {
      token: TAB_ID,
      nowMs,
      leaseMs: BOOTSTRAP_LEASE_MS,
      legacyAutoStartOperationId: crypto.randomUUID()
    });
  }

  async function refreshMigratedAutoStart(gate) {
    if (!gate?.legacyAutoStartMigration?.migrated) return;
    const queues = await syncStorage.readQueues(db);
    const local = state.quarantinedLocal || state;
    local.pendingAutoStartOperations = queues.autoStartOperations || [];
    local.autoStartBreaks = syncCore.applyAutoStartOperations(
      local.baseAutoStartBreaks,
      local.pendingAutoStartOperations
    );
  }

  async function persistSettings() {
    while (actionLocked) {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    await syncStorage.guardedMutation(db, [], (transaction) => {
      transaction.objectStore(META_STORE).put({ key: "settings", value: settingsValue() });
    });
  }

  async function persistCommand(type, options = {}) {
    const localNow = Date.now();
    const now = trustedNow(localNow);
    const activeTimer = state.timer;
    const starting = type === "start";
    const timerId = starting ? crypto.randomUUID() : activeTimer.id;
    const startingPhase = PHASES[options.phase] ? options.phase : state.selectedPhase;
    const phase = starting ? startingPhase : activeTimer.phase;
    const plannedDurationMs = starting
      ? state.durationsMs[startingPhase]
      : activeTimer.plannedDurationMs;
    const observedElapsedMs = starting ? 0 : Math.round(elapsedFor(activeTimer, now));

    if (!timerId) throw new Error("No timer is available for this action.");

    const command = await syncStorage.allocateMutation(db, {
      storeName: PENDING_STORE,
      nowMs: now,
      withDeviceSequence: true,
      withUuidV7: true,
      timerOwner: starting ? {
        deviceId: state.deviceId,
        tabId: TAB_ID,
        nowMs: localNow,
        leaseMs: TIMER_OWNER_LEASE_MS
      } : null,
      build: ({ id, wallMs, counter, deviceSequence }) => {
        const value = {
          id,
          deviceId: state.deviceId,
          deviceSequence,
          timerId,
          type,
          phase,
          plannedDurationMs,
          occurredAt: new Date(wallMs).toISOString(),
          hlcWallMs: wallMs,
          hlcCounter: counter,
          observedElapsedMs
        };
        if (starting && startingPhase === "focus" && state.selectedTaskId) {
          value.taskId = state.selectedTaskId;
        }
        if (!starting && activeTimer.dependsOnCommandId) {
          value.dependsOnCommandId = activeTimer.dependsOnCommandId;
        }
        return value;
      }
    });

    state.deviceSequence = command.deviceSequence;
    state.hlcWallMs = command.hlcWallMs;
    state.hlcCounter = command.hlcCounter;
    return command;
  }

  async function persistTaskOperation(type, task) {
    const now = trustedNow();
    const operation = await syncStorage.allocateMutation(db, {
      storeName: TASK_PENDING_STORE,
      nowMs: now,
      withDeviceSequence: false,
      withUuidV7: true,
      build: ({ id, wallMs, counter }) => {
        const value = {
          id,
          taskId: task.id,
          type,
          occurredAt: new Date(wallMs).toISOString(),
          hlcWallMs: wallMs,
          hlcCounter: counter
        };
        if (type === "upsert") value.title = task.title;
        return value;
      }
    });

    state.hlcWallMs = operation.hlcWallMs;
    state.hlcCounter = operation.hlcCounter;
    return operation;
  }

  async function persistAutoStartOperation(enabled) {
    const now = trustedNow();
    const operation = await syncStorage.allocateMutation(db, {
      storeName: AUTO_START_PENDING_STORE,
      nowMs: now,
      withDeviceSequence: false,
      withUuidV7: true,
      build: ({ id, wallMs, counter }) => ({
        id,
        enabled,
        occurredAt: new Date(wallMs).toISOString(),
        hlcWallMs: wallMs,
        hlcCounter: counter
      })
    });

    state.hlcWallMs = operation.hlcWallMs;
    state.hlcCounter = operation.hlcCounter;
    return operation;
  }

  async function persistDurationOperation(phase, durationMs) {
    const now = trustedNow();
    let operation;
    let pendingDurationOperations;
    await syncStorage.guardedMutation(db, [
      PENDING_STORE,
      TASK_PENDING_STORE,
      DURATION_PENDING_STORE,
      AUTO_START_PENDING_STORE
    ], (transaction, _outcome, fail) => {
      const durationStore = transaction.objectStore(DURATION_PENDING_STORE);
      const metaStore = transaction.objectStore(META_STORE);
      const requests = {
        operations: durationStore.getAll(),
        hlc: metaStore.get("hlc"),
        uuidV7: metaStore.get(syncStorage.UUID7_KEY),
        commandIds: transaction.objectStore(PENDING_STORE).getAllKeys(),
        taskIds: transaction.objectStore(TASK_PENDING_STORE).getAllKeys(),
        autoStartIds: transaction.objectStore(AUTO_START_PENDING_STORE).getAllKeys()
      };
      const results = {};
      let remaining = Object.keys(requests).length;
      const persist = () => {
        remaining -= 1;
        if (remaining !== 0) return;
        const existingOperations = results.operations || [];
        const storedHlc = results.hlc?.value || null;
        const storedWallMs = Number(storedHlc?.wallMs) || 0;
        const pendingWallMs = existingOperations.reduce(
          (maximum, existing) => Math.max(maximum, Number(existing.hlcWallMs) || 0),
          0
        );
        const previousWallMs = Math.max(state.hlcWallMs, storedWallMs, pendingWallMs);
        const wallMs = Math.max(now, previousWallMs);
        const pendingCounter = existingOperations.reduce(
          (maximum, existing) => Number(existing.hlcWallMs) === wallMs
            ? Math.max(maximum, Number(existing.hlcCounter) || 0)
            : maximum,
          0
        );
        const previousCounter = Math.max(
          wallMs === state.hlcWallMs ? state.hlcCounter : 0,
          wallMs === storedWallMs ? Number(storedHlc?.counter) || 0 : 0,
          pendingCounter
        );
        const counter = wallMs === previousWallMs ? previousCounter + 1 : 0;
        if (!Number.isSafeInteger(now) || now <= 0
          || !Number.isSafeInteger(wallMs) || wallMs <= 0
          || !Number.isSafeInteger(counter) || counter < 0) {
          fail(new syncStorage.ClockRangeError());
          return;
        }
        try {
          const id = syncStorage.reserveUuid7(
            wallMs,
            1,
            results.uuidV7?.value || null,
            [
              ...(results.commandIds || []),
              ...(results.taskIds || []),
              ...existingOperations.map((existing) => existing.id),
              ...(results.autoStartIds || [])
            ]
          )[0];
          operation = {
            id,
            ownerId: TAB_ID,
            phase,
            durationMs,
            occurredAt: new Date(wallMs).toISOString(),
            hlcWallMs: wallMs,
            hlcCounter: counter
          };
          const superseded = new Set(existingOperations
            .filter((existing) => existing.phase === phase && existing.ownerId === TAB_ID && !inFlightDurationOperationIds.has(existing.id))
            .map((existing) => existing.id));
          for (const operationID of superseded) durationStore.delete(operationID);
          durationStore.put(operation);
          pendingDurationOperations = existingOperations
            .filter((existing) => !superseded.has(existing.id))
            .concat(operation)
            .sort(compareDurationOperations);
          metaStore.put({ key: "hlc", value: { wallMs, counter } });
          metaStore.put({ key: syncStorage.UUID7_KEY, value: id });
        } catch (error) {
          fail(error);
        }
      };
      for (const [name, request] of Object.entries(requests)) {
        request.onsuccess = () => {
          results[name] = request.result;
          persist();
        };
      }
    });

    state.hlcWallMs = operation.hlcWallMs;
    state.hlcCounter = operation.hlcCounter;
    return { operation, pendingDurationOperations };
  }

  async function issueDurationOperation(phase, durationMs) {
    if (controlsBlocked() || actionLocked || state.durationsMs[phase] === durationMs) return false;
    actionLocked = true;
    try {
      const persisted = await persistDurationOperation(phase, durationMs);
      state.pendingDurationOperations = persisted.pendingDurationOperations;
      rebuildOptimisticDurations();
      render();
      scheduleSync(0);
      return true;
    } catch (error) {
      showNotice(error.message || "Duration change could not be saved.");
      return false;
    } finally {
      actionLocked = false;
    }
  }

  async function issueAutoStartOperation(enabled) {
    if (controlsBlocked()) return false;
    while (actionLocked) {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    if (controlsBlocked() || state.autoStartBreaks === enabled) {
      renderDurations();
      return false;
    }
    actionLocked = true;
    try {
      const operation = await persistAutoStartOperation(enabled);
      state.pendingAutoStartOperations.push(operation);
      rebuildOptimisticAutoStart();
      renderDurations();
      renderSyncStatus();
      scheduleSync(0);
      return true;
    } catch (error) {
      showNotice(error.message || "Auto-start preference could not be saved.");
      renderDurations();
      return false;
    } finally {
      actionLocked = false;
    }
  }

  async function issueTaskOperation(type, task) {
    if (controlsBlocked() || actionLocked) return false;
    actionLocked = true;
    try {
      const operation = await persistTaskOperation(type, task);
      state.pendingTaskOperations.push(operation);
      rebuildOptimisticTasks();
      render();
      scheduleSync(0);
      return true;
    } catch (error) {
      showNotice(error.message || "Task change could not be saved.");
      return false;
    } finally {
      actionLocked = false;
    }
  }

  async function addTask(title) {
    const normalized = normalizeTaskTitle(title);
    if (!normalized) throw new Error("Enter a printable task name.");
    if (new TextEncoder().encode(normalized).length > 512) {
      throw new Error("Task name is too long.");
    }
    const id = await deterministicTaskId(normalized);
    const existing = state.tasks.find((task) => task.id === id);
    if (existing) {
      state.selectedTaskId = existing.id;
      await persistSettings();
      render();
      showNotice("Task already exists and is now selected.");
      return true;
    }
    const saved = await issueTaskOperation("upsert", { id, title: normalized });
    if (saved) {
      state.selectedTaskId = id;
      await persistSettings();
      render();
    }
    return saved;
  }

  async function deleteTask(task) {
    const wasSelected = state.selectedTaskId === task.id;
    const saved = await issueTaskOperation("delete", task);
    if (saved && wasSelected) {
      state.selectedTaskId = null;
      await persistSettings();
      render();
    }
    return saved;
  }

  async function issueCommand(type, options = {}) {
    if (controlsBlocked() || actionLocked) return false;

    actionLocked = true;
    try {
      const command = await persistCommand(type, options);
      state.pending.push(command);
      rebuildOptimisticState();
      render();
      scheduleSync(0);
      return true;
    } catch (error) {
      showNotice(error.message || "Timer action could not be saved.");
      return false;
    } finally {
      actionLocked = false;
    }
  }

  function nextBreakPhase(history = state.history) {
    const completedFocusRounds = history.filter((item) => {
      const completed = !item.status || item.status === "completed";
      return completed && item.phase === "focus";
    }).length;
    return completedFocusRounds > 0 && completedFocusRounds % 4 === 0
      ? "long_break"
      : "short_break";
  }

  async function finishTimer(automatic = false) {
    if (controlsBlocked() || actionLocked) return false;
    const timer = clone(state.timer);
    const localNow = Date.now();
    const now = trustedNow(localNow);
    const autoBreak = timer.phase === "focus" && state.autoStartBreaks;
    const breakPhase = autoBreak
      ? nextBreakPhase(state.history.concat({ timerId: timer.id, phase: "focus", status: "completed" }))
      : null;
    actionLocked = true;
    try {
      const outcome = await syncStorage.finishTimer(db, {
        timerId: timer.id,
        phase: timer.phase,
        deviceId: state.deviceId,
        tabId: TAB_ID,
        leaseMs: TIMER_OWNER_LEASE_MS,
        manual: !automatic,
        requireOwner: automatic && timer.phase === "focus",
        nowMs: now,
        localNowMs: localNow,
        observedElapsedMs: Math.round(elapsedFor(timer, now)),
        withUuidV7: true,
        breakPhase,
        breakDurationMs: breakPhase ? state.durationsMs[breakPhase] : 0,
        breakTimerId: breakPhase ? crypto.randomUUID() : null
      });
      if (!outcome.transitioned) {
        if (automatic && outcome.reason === "not_owner") {
          scheduleCompletionRetry(timer.id, outcome);
          return true;
        }
        return automatic;
      }
      window.clearTimeout(completionRetryTimer);
      completionRetryTimer = null;
      state.pending.push(...outcome.commands);
      const last = outcome.commands[outcome.commands.length - 1];
      state.deviceSequence = last.deviceSequence;
      state.hlcWallMs = last.hlcWallMs;
      state.hlcCounter = last.hlcCounter;
      rebuildOptimisticState();
      render();
      scheduleSync(0);
      return true;
    } catch (error) {
      showNotice(error.message || "Timer action could not be saved.");
      return false;
    } finally {
      actionLocked = false;
    }
  }

  function completionRetryDelay(outcome, nowMs = Date.now()) {
    if (outcome?.reason !== "not_owner") return null;
    const retryAtMs = Number.isFinite(Number(outcome.retryAtMs))
      ? Number(outcome.retryAtMs)
      : nowMs + TIMER_OWNER_HEARTBEAT_MS;
    return Math.max(250, retryAtMs - nowMs + 1);
  }

  function scheduleCompletionRetry(timerId, outcome) {
    const delay = completionRetryDelay(outcome);
    if (delay === null) return;
    window.clearTimeout(completionRetryTimer);
    completionRetryTimer = window.setTimeout(() => {
      completionRetryTimer = null;
      if (!releaseCompletionRetry(timerId)) return;
      renderTimer();
    }, delay);
  }

  function releaseCompletionRetry(timerId) {
    if (state.timer.id !== timerId || state.timer.status !== "running") return false;
    completionQueuedFor = null;
    return true;
  }

  function mergeServerHlc(serverWallMs, serverCounter, clockOffset = state.clockOffset) {
    const candidates = [
      { wallMs: syncCore.trustedNow(Date.now(), clockOffset), counter: 0 },
      { wallMs: state.hlcWallMs, counter: state.hlcCounter },
      { wallMs: Number(serverWallMs) || 0, counter: Number(serverCounter) || 0 }
    ];
    return candidates.reduce((latest, candidate) =>
      candidate.wallMs > latest.wallMs || candidate.wallMs === latest.wallMs && candidate.counter > latest.counter
        ? candidate
        : latest
    );
  }

  function responseClockOffset(payload, timing, cacheable) {
    if (cacheable || !timing) return state.clockOffset;
    return syncCore.serverClockOffset(
      payload.serverTime,
      timing.requestAtMs,
      timing.receivedAtMs,
      timing.requestSequence
    );
  }

  async function reloadPersistedState(persisted = null) {
    const syncState = persisted || await syncStorage.readSyncState(db);
    if (!syncState.snapshot) throw new Error("Canonical timer snapshot is unavailable.");
    const snapshot = syncState.snapshot;
    state.revision = Number(snapshot.revision) || 0;
    state.baseDurationsMs = normalizeDurationsMs(snapshot.durationsMs);
    state.durationsMs = clone(state.baseDurationsMs);
    state.baseAutoStartBreaks = snapshot.autoStartBreaks === true;
    state.baseTimer = snapshot.canonicalTimer
      ? normalizeTimer(snapshot.canonicalTimer)
      : emptyTimer(state.selectedPhase, state.baseDurationsMs[state.selectedPhase]);
    state.baseHistory = Array.isArray(snapshot.history) ? snapshot.history : [];
    state.baseTasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
    state.localOwnerId = snapshot.user?.id || state.localOwnerId;
    state.hlcWallMs = Number(syncState.hlc?.wallMs) || state.hlcWallMs;
    state.hlcCounter = Number(syncState.hlc?.counter) || 0;
    state.clockOffset = syncState.clockOffset || state.clockOffset;
    state.pending = (syncState.commands || []).sort(compareTimerCommands);
    state.pendingTaskOperations = syncState.taskOperations || [];
    state.pendingDurationOperations = (syncState.durationOperations || []).sort(compareDurationOperations);
    state.pendingAutoStartOperations = syncState.autoStartOperations || [];
    rebuildOptimisticState();
  }

  async function acceptSyncResponse(payload, sent, expectedUserId, timing) {
    syncCore.validateCanonicalResponse(payload, sent);
    while (actionLocked) {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    actionLocked = true;
    try {

      const rebased = syncCore.rebaseSyncState({
        commands: state.pending,
        taskOperations: state.pendingTaskOperations,
        durationOperations: state.pendingDurationOperations,
        autoStartOperations: state.pendingAutoStartOperations,
        baseTimer: state.baseTimer,
        baseHistory: state.baseHistory,
        baseTasks: state.baseTasks,
        baseDurationsMs: state.baseDurationsMs,
        baseAutoStartBreaks: state.baseAutoStartBreaks,
        revision: state.revision
      }, payload, sent);
      const validated = rebased.acknowledgements;
      const { acknowledgements, acknowledgedIds } = validated.commands;
      const { acknowledgements: taskAcknowledgements, acknowledgedIds: acknowledgedTaskOperationIds } = validated.tasks;
      const { acknowledgements: durationAcknowledgements, acknowledgedIds: acknowledgedDurationOperationIds } = validated.durations;
      const { acknowledgements: autoStartAcknowledgements, acknowledgedIds: acknowledgedAutoStartOperationIds } = validated.autoStart;
      const canonicalTimer = Object.prototype.hasOwnProperty.call(rebased, "baseTimer")
        ? rebased.baseTimer
          ? normalizeTimer(rebased.baseTimer)
          : emptyTimer(state.selectedPhase, selectedDurationMs())
        : state.baseTimer;
      const history = rebased.baseHistory;
      const tasks = rebased.baseTasks;
      const durationsMs = normalizeDurationsMs(rebased.baseDurationsMs);
      const autoStartBreaks = rebased.baseAutoStartBreaks;
      const revision = rebased.revision;
      const clockOffset = responseClockOffset(payload, timing, false);
      const serverHlc = { wallMs: Number(payload.serverHlcWallMs), counter: Number(payload.serverHlcCounter) };
      const hlc = mergeServerHlc(payload.serverHlcWallMs, payload.serverHlcCounter, clockOffset);
      const conflicts = acknowledgements.filter((acknowledgement) => {
        const outcome = String(acknowledgement.outcome || "").toLowerCase();
        return outcome && !ACK_SUCCESS.has(outcome);
      }).concat(
        taskAcknowledgements.filter((acknowledgement) => acknowledgement.outcome === "rejected"),
        durationAcknowledgements.filter((acknowledgement) => acknowledgement.outcome === "rejected"),
        autoStartAcknowledgements.filter((acknowledgement) => acknowledgement.outcome === "rejected")
      );

      const nextSnapshot = snapshotValue({
        revision,
        serverTime: payload.serverTime,
        canonicalTimer: clone(canonicalTimer),
        history: clone(history),
        tasks: clone(tasks),
        durationsMs: clone(durationsMs),
        autoStartBreaks
      });
      const generatedBreaks = syncCore.generatedBreakUpdates(state.pending, acknowledgements, payload);
      const outcome = await syncStorage.applySyncResponse(db, {
        expectedUserId,
        snapshot: nextSnapshot,
        hlc,
        serverHlc,
        clockOffset,
        queueIds: {
          commands: [...acknowledgedIds],
          taskOperations: [...acknowledgedTaskOperationIds],
          durationOperations: [...acknowledgedDurationOperationIds],
          autoStartOperations: [...acknowledgedAutoStartOperationIds]
        },
        timerOwnerClaim: {
          deviceId: state.deviceId,
          tabId: TAB_ID,
          nowMs: Date.now(),
          leaseMs: TIMER_OWNER_LEASE_MS
        },
        ...generatedBreaks
      });
      await reloadPersistedState();

      if (outcome.applied && conflicts.length) {
        const conflict = conflicts[0];
        state.conflict = conflict.reason || `Command outcome: ${conflict.outcome}`;
      }
    } finally {
      actionLocked = false;
    }
  }

  async function syncNow(force = false) {
    if (!state.ready || needsBootstrapResolution() || !state.sessionIdentityValidated
      || !state.authenticated || !state.csrfToken || !navigator.onLine) {
      renderSyncStatus();
      return;
    }
    if (syncPromise) {
      syncAgain = true;
      syncAgainForce ||= force;
      return syncPromise;
    }
    let bootstrapState;
    try {
      bootstrapState = await syncStorage.readBootstrapState(db);
    } catch (error) {
      state.retrying = true;
      renderSyncStatus();
      scheduleRetry();
      console.warn("Pomodorough bootstrap gate unavailable:", error);
      return;
    }
    if (bootstrapState.gate || bootstrapState.resolution) {
      closeRevisionStream();
      state.sessionIdentityValidated = false;
      state.bootstrapGatePersisted = true;
      state.bootstrapGateOwned = false;
      state.bootstrapPending = bootstrapState.resolution;
      state.bootstrapBlocked = true;
      quarantineOwnerState(true);
      state.retrying = true;
      scheduleRetry();
      render();
      renderSyncStatus();
      return;
    }
    try {
      await refreshAllPendingOperations();
    } catch (error) {
      state.retrying = true;
      renderSyncStatus();
      scheduleRetry();
      console.warn("Pomodorough pending queues unavailable:", error);
      return;
    }
    if (!force && state.pending.length === 0 && state.pendingTaskOperations.length === 0
      && state.pendingDurationOperations.length === 0 && state.pendingAutoStartOperations.length === 0) {
      state.retrying = false;
      renderSyncStatus();
      return;
    }

    syncPromise = (async () => {
      state.syncing = true;
      state.retrying = false;
      renderSyncStatus();

      try {
        const expectedUserId = state.user.id;
        const sent = syncCore.buildSyncBatch({
          commands: state.pending,
          taskOperations: state.pendingTaskOperations,
          durationOperations: state.pendingDurationOperations,
          autoStartOperations: state.pendingAutoStartOperations
        });
        inFlightDurationOperationIds = new Set(sent.durationOperations.map((operation) => operation.id));
        const body = JSON.stringify({
          deviceId: state.deviceId,
          lastRevision: state.revision,
          commands: sent.commands,
          taskOperations: sent.taskOperations,
          durationOperations: sent.durationOperations,
          autoStartOperations: sent.autoStartOperations
        });
        const { response, timing } = await postMutation("/api/v1/sync", body, expectedUserId);

        if (response.status === 401) {
          redirectToLogin();
          return;
        }
        if (!response.ok) throw new Error(`Sync failed (${response.status}).`);

        const payload = await response.json();
        await acceptSyncResponse(payload, sent, expectedUserId, timing);
        if (state.pending.length || state.pendingTaskOperations.length || state.pendingDurationOperations.length
          || state.pendingAutoStartOperations.length) {
          syncAgain = true;
        }
        retryDelayMs = 1000;
        state.retrying = false;
      } catch (error) {
        if (error instanceof syncStorage.AccountOwnershipError) {
          queueSessionRevalidation();
          return;
        }
        state.retrying = true;
        scheduleRetry();
        console.warn("Pomodorough sync deferred:", error);
      } finally {
        inFlightDurationOperationIds = new Set();
        state.syncing = false;
        render();
      }
    })();

    try {
      await syncPromise;
    } finally {
      syncPromise = null;
      const shouldRunAgain = syncAgain;
      const runAgainForce = syncAgainForce;
      syncAgain = false;
      syncAgainForce = false;
      if (shouldRunAgain && !state.retrying) scheduleSync(0, runAgainForce);
    }
  }

  function scheduleSync(delayMs = 0, force = false) {
    window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(() => syncNow(force), delayMs);
  }

  function scheduleRetry() {
    if (!navigator.onLine) return;
    window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(() => {
      if (state.authenticated && state.csrfToken && !needsBootstrapResolution()) syncNow(false);
      else restoreSessionAndSync();
    }, retryDelayMs);
    retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
  }

  function needsBootstrapResolution() {
    return syncCore.requiresBootstrapResolution({
      blocked: state.bootstrapBlocked,
      persistedGate: state.bootstrapGatePersisted,
      pending: state.bootstrapPending,
      currentUserId: state.user?.id,
      localOwnerId: state.localOwnerId
    });
  }

  async function fetchSessionPayload() {
    const response = await fetch("/api/v1/me", {
      credentials: "same-origin",
      cache: "no-store"
    });

    if (response.status === 401) {
      redirectToLogin();
      return null;
    }
    if (!response.ok) throw new Error(`Session check failed (${response.status}).`);
    return response.json();
  }

  function applySessionPayload(payload) {
    closeRevisionStreamForIdentityChange(payload.user?.id);
    state.user = payload.user || null;
    state.csrfToken = payload.csrfToken || null;
    state.authenticated = true;
    state.sessionIdentityValidated = true;
    state.offlineOwnerMode = false;
    renderProfile();
  }

  async function loadSession() {
    const payload = await fetchSessionPayload();
    if (!payload) return false;
    const previousOwnerId = state.user?.id || state.localOwnerId;
    if (previousOwnerId && payload.user?.id !== previousOwnerId) {
      closeRevisionStreamForIdentityChange(payload.user?.id);
      quarantineOwnerState();
      state.localOwnerId = previousOwnerId;
      state.bootstrapBlocked = true;
      applySessionPayload(payload);
      await restartBootstrapForCurrentAccount();
      render();
      return true;
    }
    applySessionPayload(payload);
    return true;
  }

  async function refreshMutationCsrf(expectedUserId) {
    const payload = await fetchSessionPayload();
    if (!payload) throw new Error("Session refresh requires sign-in.");
    if (!payload.user?.id || payload.user.id !== expectedUserId) {
      closeRevisionStreamForIdentityChange(payload.user?.id);
      quarantineOwnerState();
      state.localOwnerId = expectedUserId;
      state.bootstrapBlocked = true;
      applySessionPayload(payload);
      await restartBootstrapForCurrentAccount();
      render();
      throw new Error("Signed-in account changed during mutation retry.");
    }
    applySessionPayload(payload);
    return state.csrfToken;
  }

  async function postMutation(url, body, expectedUserId) {
    let timing = null;
    const response = await syncCore.postJSONWithCsrfRetry({
      fetcher: fetch,
      url,
      body,
      csrfToken: state.csrfToken,
      refreshCsrf: () => refreshMutationCsrf(expectedUserId),
      nextRequestSequence: () => syncStorage.allocateClockRequestSequence(db),
      onTiming: (value) => { timing = value; }
    });
    return { response, timing };
  }

  async function restartBootstrapForCurrentAccount() {
    if (!state.user?.id) return;
    const restarted = await syncStorage.invalidateForeignResolution(db, {
      currentUserId: state.user.id,
      gateToken: TAB_ID,
      nowMs: Date.now(),
      leaseMs: BOOTSTRAP_LEASE_MS
    });
    if (restarted.acquired && !restarted.resolution) {
      restarted.legacyAutoStartMigration = await syncStorage.migrateLegacyAutoStart(db, {
        operationId: crypto.randomUUID(),
        nowMs: Date.now()
      });
      await refreshMigratedAutoStart(restarted);
    }
    state.bootstrapPending = restarted.resolution;
    state.bootstrapPreview = null;
    state.bootstrapPlan = null;
    state.bootstrapStrategy = null;
    state.bootstrapError = null;
    state.bootstrapLimitError = null;
    state.bootstrapConflict = false;
    state.bootstrapBlocked = true;
    state.bootstrapGatePersisted = true;
    state.bootstrapGateOwned = restarted.acquired;
  }

  function queueBootstrapPreparation() {
    window.setTimeout(() => prepareBootstrap().catch((error) => {
      state.retrying = true;
      scheduleRetry();
      console.warn("Pomodorough bootstrap restart deferred:", error);
    }), 0);
  }

  async function loadBootstrapPreview() {
    const requestSequence = await syncStorage.allocateClockRequestSequence(db);
    const requestAtMs = Date.now();
    const response = await fetch("/api/v1/bootstrap", {
      credentials: "same-origin",
      cache: "no-store"
    });
    const receivedAtMs = Date.now();

    if (response.status === 401) {
      redirectToLogin();
      return;
    }
    if (!response.ok) throw new Error(`Bootstrap failed (${response.status}).`);
    const payload = await response.json();
    syncCore.validateCanonicalResponse(payload, {
      commands: [],
      taskOperations: [],
      durationOperations: [],
      autoStartOperations: []
    });
    state.clockOffset = await syncStorage.saveClockOffset(
      db,
      syncCore.serverClockOffset(payload.serverTime, requestAtMs, receivedAtMs, requestSequence)
    );
    return payload;
  }

  function localBootstrapState() {
    const local = state.quarantinedLocal || state;
    return {
      history: local.history,
      timer: local.timer,
      tasks: local.tasks,
      durationsMs: local.durationsMs,
      autoStartBreaks: local.autoStartBreaks,
      defaultDurationsMs: DEFAULT_DURATIONS_MS,
      commands: local.pending,
      taskOperations: local.pendingTaskOperations,
      durationOperations: local.pendingDurationOperations,
      autoStartOperations: local.pendingAutoStartOperations
    };
  }

  async function persistBootstrapResolution(strategy, replaceExisting = false) {
    if (!syncCore.isResolutionStrategy(strategy)) {
      throw new syncStorage.BootstrapGateError("History resolution changed in another tab.");
    }
    const lease = await acquireBootstrapGate();
    if (!lease.acquired) throw new syncStorage.BootstrapGateError("Another tab owns history resolution.");
    await refreshMigratedAutoStart(lease);
    const pending = await syncStorage.captureResolution(db, {
      userId: state.user.id,
      requestId: crypto.randomUUID(),
      deviceId: state.deviceId,
      expectedRevision: state.bootstrapPreview.revision,
      strategy
    }, {
      replaceExisting,
      gateToken: TAB_ID
    });
    state.bootstrapPending = pending;
    state.bootstrapGatePersisted = true;
    state.bootstrapGateOwned = true;
    state.bootstrapStrategy = strategy;
    state.bootstrapConflict = false;
    state.bootstrapError = null;
    state.bootstrapLimitError = null;
    return pending;
  }

  function handleResolutionLimit(error) {
    if (!(error instanceof syncStorage.ResolutionLimitError)) return false;
    state.bootstrapSubmitting = false;
    state.bootstrapError = null;
    state.bootstrapLimitError = error.message;
    state.bootstrapStrategy = null;
    state.bootstrapFocusTarget = elements.bootstrapChoiceButtons.find(
      (button) => button.dataset.bootstrapStrategy === "keep_remote"
    );
    render();
    return true;
  }

  async function refreshAllPendingOperations() {
    await syncStorage.normalizeLegacyDurationOperations(db);
    const { commands, taskOperations, durationOperations, autoStartOperations } = await syncStorage.readQueues(db);
    state.pending = (commands || []).sort(compareTimerCommands);
    state.pendingTaskOperations = taskOperations || [];
    state.pendingDurationOperations = (durationOperations || []).sort(compareDurationOperations);
    state.pendingAutoStartOperations = autoStartOperations || [];
  }

  function bootstrapConflicts(validated) {
    return validated.commands.acknowledgements
      .concat(
        validated.tasks.acknowledgements,
        validated.durations.acknowledgements,
        validated.autoStart.acknowledgements
      )
      .filter((acknowledgement) => {
        const outcome = String(acknowledgement.outcome || "").toLowerCase();
        return outcome && !ACK_SUCCESS.has(outcome) && outcome !== "ignored";
      });
  }

  async function acceptBootstrapResponse(payload, pending, timing) {
    syncCore.validateCanonicalResponse(payload, pending.payload);
    while (actionLocked) {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    actionLocked = true;
    try {
      const local = state.quarantinedLocal || state;
      const applied = syncCore.applyResolutionState({
        commands: local.pending,
        taskOperations: local.pendingTaskOperations,
        durationOperations: local.pendingDurationOperations,
        autoStartOperations: local.pendingAutoStartOperations,
        baseTimer: local.baseTimer,
        baseHistory: local.baseHistory,
        baseTasks: local.baseTasks,
        baseDurationsMs: local.baseDurationsMs,
        baseAutoStartBreaks: local.baseAutoStartBreaks,
        revision: local.revision
      }, payload, pending);
      const validated = applied.acknowledgements;
      const history = applied.baseHistory;
      const tasks = applied.baseTasks;
      const durationsMs = normalizeDurationsMs(applied.baseDurationsMs);
      const autoStartBreaks = applied.baseAutoStartBreaks;
      const canonicalTimer = applied.baseTimer
        ? normalizeTimer(applied.baseTimer)
        : emptyTimer(state.selectedPhase, durationsMs[state.selectedPhase]);
      const revision = Number(applied.revision);
      if (!Number.isFinite(revision) || revision < 0) throw new Error("Bootstrap response omitted revision.");
      const clockOffset = responseClockOffset(payload, timing, true);
      const serverHlc = { wallMs: Number(payload.serverHlcWallMs), counter: Number(payload.serverHlcCounter) };
      const hlc = mergeServerHlc(payload.serverHlcWallMs, payload.serverHlcCounter, clockOffset);
      const queueIds = pending.queueIds || {
        commands: [], taskOperations: [], durationOperations: [], autoStartOperations: []
      };
      const snapshot = {
        revision,
        serverTime: payload.serverTime,
        canonicalTimer: clone(canonicalTimer),
        history: clone(history),
        tasks: clone(tasks),
        durationsMs: clone(durationsMs),
        autoStartBreaks,
        user: clone(state.user)
      };

      const generatedBreaks = syncCore.generatedBreakUpdates(
        local.pending,
        validated.commands.acknowledgements,
        payload
      );
      const outcome = await syncStorage.applyResolution(
        db,
        { ...pending, queueIds },
        {
          snapshot,
          hlc,
          serverHlc,
          clockOffset,
          timerOwnerClaim: {
            deviceId: state.deviceId,
            tabId: TAB_ID,
            nowMs: Date.now(),
            leaseMs: TIMER_OWNER_LEASE_MS
          },
          ...generatedBreaks
        }
      );
      await reloadPersistedState();
      state.localOwnerId = state.user.id;
      state.bootstrapPending = null;
      state.bootstrapPreview = null;
      state.bootstrapPlan = null;
      state.bootstrapStrategy = null;
      state.bootstrapError = null;
      state.bootstrapConflict = false;
      state.bootstrapBlocked = false;
      state.bootstrapLimitError = null;
      state.bootstrapGatePersisted = false;
      state.bootstrapGateOwned = false;
      state.quarantinedLocal = null;
      state.retrying = false;
      retryDelayMs = 1000;
      window.clearTimeout(retryTimer);

      const conflicts = bootstrapConflicts(validated);
      if (outcome.applied && conflicts.length) {
        state.conflict = conflicts[0].reason || `Operation outcome: ${conflicts[0].outcome}`;
      }
    } finally {
      actionLocked = false;
    }
    render();
    openRevisionStream();
    if (state.pending.length || state.pendingTaskOperations.length || state.pendingDurationOperations.length
      || state.pendingAutoStartOperations.length) {
      scheduleSync(0);
    }
  }

  async function submitBootstrapResolution() {
    if (state.bootstrapSubmitting || !state.bootstrapPending || !navigator.onLine) return;
    let pending = state.bootstrapPending;
    if (!syncCore.pendingResolutionCanSubmit(pending, state.user?.id)) {
      queueSessionRevalidation();
      return;
    }
    try {
      if (state.bootstrapGateOwned) {
        const normalized = await syncStorage.normalizeLegacyDurationOperations(db, {
          gateToken: TAB_ID,
          replacementRequestId: crypto.randomUUID()
        });
        pending = normalized.resolution || pending;
        state.bootstrapPending = pending;
      }
      await syncStorage.validatePendingForSend(db, {
        pending,
        currentUserId: state.user.id,
        gateToken: TAB_ID,
        nowMs: Date.now(),
        leaseMs: BOOTSTRAP_LEASE_MS
      });
    } catch (error) {
      const persisted = await syncStorage.readBootstrapState(db);
      if (!syncCore.pendingMatchesUser(persisted.resolution, state.user.id)) {
        queueSessionRevalidation();
      } else {
        state.bootstrapPending = persisted.resolution;
        state.bootstrapGateOwned = false;
        queueBootstrapPreparation();
      }
      return;
    }
    state.bootstrapSubmitting = true;
    state.bootstrapError = null;
    renderBootstrapDialog();
    try {
      const body = JSON.stringify(pending.payload);
      const { response, timing } = await postMutation("/api/v1/bootstrap/resolve", body, pending.userId);
      if (response.status === 401) {
        redirectToLogin();
        return;
      }
      if (response.status === 409) {
        const conflict = await response.json().catch(() => ({}));
        state.bootstrapConflict = true;
        state.bootstrapError = conflict.error === "request ID conflict"
          ? "This resolution ID was already used. Retry with a fresh remote snapshot."
          : "Remote history changed before this choice was applied. Retry with the latest snapshot.";
        state.bootstrapFocusTarget = elements.bootstrapRetry;
        return;
      }
      if (!response.ok) throw new Error(`History resolution failed (${response.status}).`);
      await acceptBootstrapResponse(await response.json(), pending, timing);
    } catch (error) {
      if (!syncCore.pendingMatchesUser(state.bootstrapPending, state.user?.id)) {
        state.bootstrapError = null;
        queueBootstrapPreparation();
        return;
      }
      state.bootstrapError = `${error.message || "History resolution was interrupted."} Retry sends the exact saved request.`;
      state.bootstrapFocusTarget = elements.bootstrapRetry;
      console.warn("Pomodorough bootstrap resolution deferred:", error);
    } finally {
      state.bootstrapSubmitting = false;
      render();
    }
  }

  async function retryBootstrapResolution() {
    if (state.bootstrapSubmitting) return;
    try {
      if (state.bootstrapConflict) {
        const strategy = state.bootstrapStrategy || state.bootstrapPending?.payload?.strategy;
        if (!syncCore.isResolutionStrategy(strategy)) {
          queueSessionRevalidation();
          return;
        }
        state.bootstrapSubmitting = true;
        renderBootstrapDialog();
        state.bootstrapPreview = await loadBootstrapPreview();
        await persistBootstrapResolution(strategy, true);
        state.bootstrapSubmitting = false;
      }
      await submitBootstrapResolution();
    } catch (error) {
      if (handleResolutionLimit(error)) return;
      state.bootstrapSubmitting = false;
      state.bootstrapError = error.message || "History resolution could not be retried.";
      state.bootstrapFocusTarget = elements.bootstrapRetry;
      renderBootstrapDialog();
    }
  }

  async function chooseBootstrapStrategy(strategy, confirmed = false) {
    if (state.bootstrapSubmitting || state.bootstrapPending) return;
    if (state.bootstrapLimitError && strategy !== "keep_remote") return;
    const selectionMode = state.bootstrapLimitError ? "choose" : state.bootstrapPlan?.mode;
    if (!syncCore.canSubmitResolution(selectionMode, confirmed)) {
      state.bootstrapStrategy = strategy;
      state.bootstrapFocusTarget = elements.bootstrapConfirm;
      renderBootstrapDialog();
      return;
    }
    state.bootstrapSubmitting = true;
    renderBootstrapDialog();
    try {
      await persistBootstrapResolution(strategy);
    } catch (error) {
      if (handleResolutionLimit(error)) return;
      showNotice(error.message || "History choice could not be saved.");
      state.bootstrapFocusTarget = elements.bootstrapConfirm;
      state.bootstrapSubmitting = false;
      renderBootstrapDialog();
      return;
    }
    state.bootstrapSubmitting = false;
    await submitBootstrapResolution();
  }

  async function prepareBootstrap() {
    if (bootstrapPromise) return bootstrapPromise;
    bootstrapPromise = prepareBootstrapOnce();
    try {
      return await bootstrapPromise;
    } finally {
      bootstrapPromise = null;
    }
  }

  async function resumeNormalSyncFromBootstrap(persisted) {
    await reloadPersistedState(persisted);
    state.quarantinedLocal = null;
    await syncStorage.clearBootstrapGate(db, TAB_ID);
    state.bootstrapPending = null;
    state.bootstrapGatePersisted = false;
    state.bootstrapGateOwned = false;
    state.bootstrapBlocked = false;
    state.retrying = false;
    render();
    await syncNow(true);
    openRevisionStream();
  }

  async function prepareBootstrapOnce() {
    state.bootstrapBlocked = true;
    render();

    if (state.bootstrapError || state.bootstrapLimitError
      || state.bootstrapPlan?.mode === "choose" && !state.bootstrapPending) return;

    if (state.bootstrapPending && !syncCore.pendingMatchesUser(state.bootstrapPending, state.user?.id)) {
      if (!state.sessionIdentityValidated) {
        queueSessionRevalidation();
        return;
      }
      await restartBootstrapForCurrentAccount();
    }

    if (!state.bootstrapGateOwned) {
      const lease = await acquireBootstrapGate();
      if (!lease.acquired) {
        state.retrying = true;
        scheduleRetry();
        render();
        return;
      }
      state.bootstrapGateOwned = true;
      state.bootstrapGatePersisted = true;
      await refreshMigratedAutoStart(lease);
      if (lease.resolution) state.bootstrapPending = lease.resolution;
      if (state.bootstrapPending && !syncCore.pendingResolutionCanSubmit(state.bootstrapPending, state.user?.id)) {
        if (!state.sessionIdentityValidated) {
          queueSessionRevalidation();
          return;
        }
        await restartBootstrapForCurrentAccount();
      }
      if (!state.bootstrapPending) {
        const persisted = await syncStorage.readSyncState(db);
        if (persisted.snapshot?.user?.id === state.user.id) {
          await resumeNormalSyncFromBootstrap(persisted);
          return;
        }
        if (persisted.snapshot?.user?.id) state.localOwnerId = persisted.snapshot.user.id;
      }
    }

    if (state.bootstrapPending?.userId === state.user.id) {
      state.bootstrapStrategy = state.bootstrapPending.payload.strategy;
      await submitBootstrapResolution();
      return;
    }

    if (!state.bootstrapPending && syncCore.canExposeOwnerState({
      sessionValidated: state.sessionIdentityValidated,
      localOwnerId: state.localOwnerId,
      currentUserId: state.user.id
    })) {
      const bootstrapState = await syncStorage.readBootstrapState(db);
      if (bootstrapState.resolution) {
        state.bootstrapPending = bootstrapState.resolution;
        if (state.bootstrapPending.userId === state.user.id) {
          state.bootstrapStrategy = state.bootstrapPending.payload.strategy;
          await submitBootstrapResolution();
          return;
        }
      }
      if (!state.bootstrapPending && bootstrapState.gate && !state.bootstrapGateOwned) {
        state.retrying = true;
        scheduleRetry();
        render();
        return;
      }
      if (!state.bootstrapPending && state.bootstrapGateOwned) {
        const persisted = await syncStorage.readSyncState(db);
        if (persisted.snapshot?.user?.id === state.user.id) {
          await resumeNormalSyncFromBootstrap(persisted);
          return;
        }
      }
    }

    state.bootstrapPreview = await loadBootstrapPreview();
    const local = localBootstrapState();
    state.bootstrapPlan = syncCore.decideBootstrap({
      localOwnerId: state.localOwnerId,
      currentUserId: state.user.id,
      localHistory: local.history,
      remoteHistory: state.bootstrapPreview.history,
      hasLocalState: syncCore.hasLocalState(local),
      hasRemoteState: syncCore.hasRemoteState({
        ...state.bootstrapPreview,
        defaultDurationsMs: DEFAULT_DURATIONS_MS
      })
    });
    if (state.bootstrapPlan.mode === "normal_sync") {
      const persisted = await syncStorage.readSyncState(db);
      if (persisted.snapshot?.user?.id === state.user.id) {
        await resumeNormalSyncFromBootstrap(persisted);
        return;
      }
      state.localOwnerId = persisted.snapshot?.user?.id || null;
      state.bootstrapPlan = syncCore.decideBootstrap({
        localOwnerId: state.localOwnerId,
        currentUserId: state.user.id,
        localHistory: local.history,
        remoteHistory: state.bootstrapPreview.history,
        hasLocalState: syncCore.hasLocalState(local),
        hasRemoteState: syncCore.hasRemoteState({
          ...state.bootstrapPreview,
          defaultDurationsMs: DEFAULT_DURATIONS_MS
        })
      });
    }
    if (state.bootstrapPlan.mode === "choose") {
      state.bootstrapStrategy = null;
      state.bootstrapFocusTarget = elements.bootstrapChoiceButtons[0];
      render();
      return;
    }

    try {
      if (!syncCore.isResolutionStrategy(state.bootstrapPlan.strategy)) {
        queueSessionRevalidation();
        return;
      }
      await persistBootstrapResolution(
        state.bootstrapPlan.strategy,
        Boolean(state.bootstrapPending && state.bootstrapPending.userId !== state.user.id)
      );
    } catch (error) {
      if (handleResolutionLimit(error)) return;
      throw error;
    }
    await submitBootstrapResolution();
  }

  function redirectToLogin() {
    if (redirecting) return;
    redirecting = true;
    window.location.assign("/auth/google/start?return=%2Fapp");
  }

  function openRevisionStream() {
    if (!state.sessionIdentityValidated || !state.authenticated
      || needsBootstrapResolution() || !navigator.onLine || eventSource) return;

    eventSource = new EventSource("/api/v1/stream");
    const receiveRevision = (event) => {
      let revision = Number(event.data);
      try {
        const payload = JSON.parse(event.data);
        revision = Number(payload.revision ?? payload);
      } catch {
        // Plain revision strings are valid event payloads.
      }
      if (!Number.isFinite(revision) || revision > Number(state.revision)) {
        scheduleSync(0, true);
      }
    };
    eventSource.onmessage = receiveRevision;
    eventSource.addEventListener("revision", receiveRevision);
    eventSource.onerror = () => {
      if (!navigator.onLine) closeRevisionStream();
    };
  }

  function closeRevisionStreamForIdentityChange(nextUserId) {
    if (state.user?.id && nextUserId && state.user.id !== nextUserId) closeRevisionStream();
  }

  function closeRevisionStream() {
    eventSource?.close();
    eventSource = null;
  }

  function queueSessionRevalidation() {
    state.bootstrapSubmitting = false;
    state.bootstrapPending = null;
    state.bootstrapStrategy = null;
    state.bootstrapConflict = false;
    state.bootstrapError = null;
    state.bootstrapLimitError = null;
    state.bootstrapBlocked = true;
    state.bootstrapGateOwned = false;
    state.sessionIdentityValidated = false;
    closeRevisionStream();
    render();
    window.setTimeout(() => restoreSessionAndSync(), 0);
  }

  async function restoreSessionAndSync() {
    try {
      if (!state.sessionIdentityValidated || !state.authenticated || !state.csrfToken) await loadSession();
      if (state.authenticated) {
        if (needsBootstrapResolution()) await prepareBootstrap();
        else {
          openRevisionStream();
          await syncNow(true);
        }
      }
    } catch (error) {
      await activateCachedOwnerOffline();
      state.retrying = true;
      render();
      scheduleRetry();
      console.warn("Pomodorough remains offline:", error);
    }
  }

  function handleOnline() {
    state.retrying = false;
    retryDelayMs = 1000;
    renderSyncStatus();
    restoreSessionAndSync();
  }

  function handleOffline() {
    state.syncing = false;
    state.retrying = false;
    closeRevisionStream();
    renderSyncStatus();
  }

  async function logout() {
    try {
      await refreshAllPendingOperations();
    } catch (error) {
      console.warn("Pomodorough pending queues unavailable before logout:", error);
    }
    const pendingCount = state.pending.length + state.pendingTaskOperations.length
      + state.pendingDurationOperations.length + state.pendingAutoStartOperations.length;
    if (pendingCount > 0) {
      const confirmed = window.confirm(
        `${pendingCount} change${pendingCount === 1 ? " is" : "s are"} waiting to sync. Logging out will discard ${pendingCount === 1 ? "it" : "them"}. Continue?`
      );
      if (!confirmed) return;
    }

    if (!state.csrfToken) {
      showNotice("Connect to the network before logging out.");
      return;
    }

    elements.logoutButton.disabled = true;
    try {
      const response = await fetch("/api/v1/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "X-CSRF-Token": state.csrfToken }
      });
      if (!response.ok && response.status !== 401) {
        throw new Error(`Logout failed (${response.status}).`);
      }

      closeRevisionStream();
      await clearLocalData();
      redirectToLogin();
    } catch (error) {
      elements.logoutButton.disabled = false;
      showNotice(error.message || "Logout failed. Local timer data was kept.");
    }
  }

  async function clearLocalData() {
    if (db) {
      const transaction = db.transaction(
        [META_STORE, PENDING_STORE, TASK_PENDING_STORE, DURATION_PENDING_STORE, AUTO_START_PENDING_STORE],
        "readwrite"
      );
      transaction.objectStore(META_STORE).clear();
      transaction.objectStore(PENDING_STORE).clear();
      transaction.objectStore(TASK_PENDING_STORE).clear();
      transaction.objectStore(DURATION_PENDING_STORE).clear();
      transaction.objectStore(AUTO_START_PENDING_STORE).clear();
      await transactionDone(transaction);
      db.close();
    }
    db = null;

    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => resolve();
    });

    if ("caches" in window) {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((cacheName) => cacheName.startsWith(CACHE_PREFIX))
          .map((cacheName) => caches.delete(cacheName))
      );
    }
  }

  function render() {
    renderScreens();
    renderDurations();
    renderTaskSelector();
    renderTimer();
    renderHistory();
    renderTasks();
    renderProfile();
    renderSyncStatus();
    renderConflict();
    renderBootstrapDialog();
  }

  function renderScreens() {
    const showingTasks = state.activeScreen === "tasks";
    elements.timerScreen.hidden = showingTasks;
    elements.tasksScreen.hidden = !showingTasks;
    for (const button of elements.screenButtons) {
      const selected = button.dataset.screenButton === state.activeScreen;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
  }

  function renderDurations() {
    const active = ["running", "paused"].includes(state.timer.status);
    const blocked = controlsBlocked();

    for (const button of elements.phaseButtons) {
      const selected = button.dataset.phase === state.selectedPhase;
      button.setAttribute("aria-pressed", String(selected));
      button.disabled = blocked || active;
    }

    for (const input of elements.durationInputs) {
      if (document.activeElement !== input) input.value = String(state.durationsMs[input.name] / 60_000);
      input.disabled = blocked || active;
    }
    for (const button of elements.stepButtons) button.disabled = blocked || active;
    elements.autoStartBreaks.checked = state.autoStartBreaks;
    elements.autoStartBreaks.disabled = blocked;
  }

  function renderTaskSelector() {
    const previous = state.selectedTaskId || "";
    elements.taskSelector.replaceChildren();
    const noTask = document.createElement("option");
    noTask.value = "";
    noTask.textContent = "No task";
    elements.taskSelector.append(noTask);
    for (const task of state.tasks) {
      const option = document.createElement("option");
      option.value = task.id;
      option.textContent = task.title;
      elements.taskSelector.append(option);
    }
    elements.taskSelector.value = state.tasks.some((task) => task.id === previous) ? previous : "";
    const active = ["running", "paused"].includes(state.timer.status);
    elements.taskSelector.disabled = controlsBlocked() || active || state.selectedPhase !== "focus";
  }

  function displayTimer() {
    if (state.timer.status !== "idle") return state.timer;
    return emptyTimer(state.selectedPhase, selectedDurationMs());
  }

  function renderTimer() {
    const timer = displayTimer();
    const elapsed = elapsedFor(timer);
    const remaining = Math.max(0, timer.plannedDurationMs - elapsed);
    const progress = timer.plannedDurationMs > 0 ? elapsed / timer.plannedDurationMs : 0;
    const totalSeconds = Math.ceil(remaining / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const timeText = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    const phase = PHASES[timer.phase] || PHASES.focus;
    const status = timer.status;
    const active = ["running", "paused"].includes(status);

    elements.timerDisplay.textContent = timeText;
    elements.timerDisplay.dateTime = `PT${Math.floor(totalSeconds / 60)}M${seconds}S`;
    elements.timerDisplay.setAttribute(
      "aria-label",
      `${minutes} minutes ${seconds} seconds remaining, ${phase.label}, ${status}`
    );
    elements.phaseLabel.textContent = phase.label.toUpperCase();
    elements.timerDetail.textContent = `${status.toUpperCase()} / ${Math.round(timer.plannedDurationMs / 60000)} MIN`;
    elements.dial.dataset.status = status;
    elements.dialProgress.style.strokeDashoffset = String(DIAL_CIRCUMFERENCE * (1 - progress));

    if (status === "running") {
      elements.timerToggle.textContent = "Pause";
      elements.timerInstruction.textContent = "Service underway. Continue here or on another device.";
    } else if (status === "paused") {
      elements.timerToggle.textContent = "Resume";
      elements.timerInstruction.textContent = "Held at this stop. Resume when ready.";
    } else {
      elements.timerToggle.textContent = `Start ${phase.label.toLowerCase()}`;
      elements.timerInstruction.textContent = status === "completed"
        ? "Run complete. Clear it or start another."
        : status === "cancelled"
          ? "Run cancelled. Clear it or start again."
          : status === "superseded"
            ? "Another device is carrying this timer."
            : "Choose a pattern, then start the clock.";
    }

    const blocked = controlsBlocked();
    elements.timerToggle.disabled = blocked;
    elements.finishButton.disabled = blocked || !active;
    elements.cancelButton.disabled = blocked || !active;
    elements.clearButton.disabled = blocked || ["idle", "running", "paused"].includes(status);

    if (!blocked && status === "running" && remaining <= 0 && completionQueuedFor !== timer.id) {
      completionQueuedFor = timer.id;
      finishTimer(true).then((saved) => {
        if (!saved) completionQueuedFor = null;
      });
    } else if (status !== "running") {
      window.clearTimeout(completionRetryTimer);
      completionRetryTimer = null;
      completionQueuedFor = null;
    }
  }

  function renderHistory() {
    const completed = state.history.filter((item) => !item.status || item.status === "completed");
    elements.historyCount.textContent = String(completed.length).padStart(3, "0");
    elements.historyList.replaceChildren();

    if (completed.length === 0) {
      const empty = document.createElement("li");
      empty.className = "history-empty";
      empty.textContent = "No completed runs yet. Your first finish appears here.";
      elements.historyList.append(empty);
      return;
    }

    const sorted = [...completed].sort((a, b) => historyDateMs(b) - historyDateMs(a));
    for (const item of sorted) {
      const phaseKey = PHASES[item.phase] ? item.phase : "focus";
      const phase = PHASES[phaseKey];
      const durationMs = positiveNumber(
        item.plannedDurationMs ?? item.durationMs ?? item.timer?.plannedDurationMs,
        0
      );
      const dateValue = item.completedAt || item.endedAt || item.occurredAt || item.createdAt;
      const listItem = document.createElement("li");
      listItem.className = "history-item";

      const stamp = document.createElement("span");
      stamp.className = "history-stamp";
      stamp.textContent = phase.short;
      stamp.setAttribute("aria-hidden", "true");

      const phaseName = document.createElement("span");
      phaseName.className = "history-phase";
      phaseName.textContent = phase.label;
      const task = state.tasks.find((candidate) => candidate.id === item.taskId);
      if (task) {
        const taskName = document.createElement("small");
        taskName.className = "history-task";
        taskName.textContent = task.title;
        phaseName.append(taskName);
      }
      if (item.pending) {
        const pending = document.createElement("small");
        pending.className = "history-pending";
        pending.textContent = " / queued";
        phaseName.append(pending);
      }

      const date = document.createElement("time");
      date.className = "history-date";
      if (dateValue) date.dateTime = dateValue;
      date.textContent = formatHistoryDate(dateValue);

      const duration = document.createElement("span");
      duration.className = "history-duration";
      duration.textContent = `${Math.max(1, Math.round(durationMs / 60000))} min`;

      listItem.append(stamp, phaseName, date, duration);
      elements.historyList.append(listItem);
    }
  }

  function renderTasks() {
    const blocked = controlsBlocked();
    elements.taskCount.textContent = String(state.tasks.length).padStart(2, "0");
    elements.taskList.replaceChildren();
    elements.taskInput.disabled = blocked;
    elements.taskForm.querySelector("button[type='submit']").disabled = blocked;

    if (state.tasks.length === 0) {
      const empty = document.createElement("p");
      empty.className = "task-empty";
      empty.textContent = "No tasks on the board. Add one for your next focus run.";
      elements.taskList.append(empty);
      return;
    }

    const summaries = taskSummariesToday();
    for (const task of state.tasks) {
      const summary = summaries.get(task.id) || { count: 0, durationMs: 0 };
      const row = document.createElement("article");
      row.className = "task-row";

      const name = document.createElement("strong");
      name.className = "task-name";
      name.textContent = task.title;

      const count = document.createElement("span");
      count.className = "task-stat";
      count.textContent = String(summary.count);
      count.setAttribute("aria-label", `${summary.count} finished pomodoros today`);

      const duration = document.createElement("span");
      duration.className = "task-stat";
      duration.textContent = formatTaskDuration(summary.durationMs);
      duration.setAttribute("aria-label", `${formatTaskDuration(summary.durationMs)} spent today`);

      const remove = document.createElement("button");
      remove.className = "task-delete";
      remove.type = "button";
      remove.textContent = "Delete";
      remove.setAttribute("aria-label", `Delete ${task.title}`);
      remove.disabled = blocked;
      remove.addEventListener("click", () => deleteTask(task));

      row.append(name, count, duration, remove);
      elements.taskList.append(row);
    }
  }

  function taskSummariesToday() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const summaries = new Map();
    for (const item of state.history) {
      if (item.phase !== "focus" || (item.status && item.status !== "completed") || !item.taskId) continue;
      const completedAt = historyDateMs(item);
      if (completedAt < start.getTime() || completedAt >= end.getTime()) continue;
      const summary = summaries.get(item.taskId) || { count: 0, durationMs: 0 };
      summary.count += 1;
      summary.durationMs += positiveNumber(
        item.plannedDurationMs ?? item.durationMs ?? item.timer?.plannedDurationMs,
        0
      );
      summaries.set(item.taskId, summary);
    }
    return summaries;
  }

  function formatTaskDuration(durationMs) {
    const totalMinutes = Math.round(Math.max(0, durationMs) / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (!hours) return `${minutes} min`;
    if (!minutes) return `${hours} hr`;
    return `${hours} hr ${minutes} min`;
  }

  function historyDateMs(item) {
    const value = item.completedAt || item.endedAt || item.occurredAt || item.createdAt;
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) ? milliseconds : 0;
  }

  function formatHistoryDate(value) {
    const date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) return "Time not recorded";
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(date);
  }

  function renderProfile() {
    if (!state.user) {
      elements.profile.hidden = true;
      return;
    }

    elements.profile.hidden = false;
    elements.profileName.textContent = state.user.name || state.user.email || "Signed in";
    if (state.user.avatarUrl) {
      elements.profileAvatar.src = state.user.avatarUrl;
      elements.profileAvatar.alt = `${state.user.name || "User"} profile photo`;
      elements.profileAvatar.hidden = false;
    } else {
      elements.profileAvatar.removeAttribute("src");
      elements.profileAvatar.hidden = true;
    }
  }

  function renderSyncStatus() {
    const count = state.pending.length + state.pendingTaskOperations.length
      + state.pendingDurationOperations.length + state.pendingAutoStartOperations.length;
    let syncState = "synced";
    let label = "In sync";

    if (!navigator.onLine) {
      syncState = "offline";
      label = count ? `Offline / ${count} queued` : "Offline / local";
    } else if (state.bootstrapSubmitting) {
      syncState = "syncing";
      label = "Resolving history";
    } else if (state.bootstrapError || state.bootstrapLimitError) {
      syncState = "error";
      label = "History choice needed";
    } else if (state.bootstrapBlocked) {
      syncState = "loading";
      label = state.bootstrapPlan?.mode === "choose" ? "Choose history" : "Checking history";
    } else if (state.conflict) {
      syncState = "conflict";
      label = count ? `Conflict / ${count} queued` : "Conflict";
    } else if (state.syncing) {
      syncState = "syncing";
      label = "Syncing";
    } else if (state.retrying) {
      syncState = "error";
      label = count ? `Retrying / ${count} queued` : "Retrying sync";
    } else if (count) {
      syncState = "loading";
      label = `${count} waiting to sync`;
    } else if (!state.ready) {
      syncState = "loading";
      label = "Checking line";
    }

    elements.syncStatus.dataset.state = syncState;
    elements.syncStatusText.textContent = label;
  }

  function renderConflict() {
    elements.conflictPanel.hidden = !state.conflict;
    if (state.conflict) elements.conflictReason.textContent = state.conflict;
  }

  function renderBootstrapDialog() {
    const limitRecovery = Boolean(state.bootstrapLimitError);
    const view = syncCore.bootstrapDialogView({
      planMode: limitRecovery ? "choose" : state.bootstrapPlan?.mode,
      strategy: state.bootstrapStrategy,
      pending: state.bootstrapPending,
      error: state.bootstrapError,
      submitting: state.bootstrapSubmitting,
      blocked: state.bootstrapBlocked,
      authenticated: state.authenticated
    });

    if (!view.open) {
      if (elements.bootstrapDialog.open) elements.bootstrapDialog.close();
      return;
    }

    const localCount = state.bootstrapPlan?.localHistoryCount ?? syncCore.completedHistoryCount(localBootstrapState().history);
    const remoteCount = state.bootstrapPlan?.remoteHistoryCount ?? syncCore.completedHistoryCount(state.bootstrapPreview?.history);
    elements.bootstrapTitle.textContent = limitRecovery ? "Local queue too large" : "Choose synchronized state";
    elements.bootstrapSummary.textContent = limitRecovery
      ? "Upload stopped before any local or remote data changed."
      : `${localCount} local completed run${localCount === 1 ? "" : "s"}; ${remoteCount} remote completed run${remoteCount === 1 ? "" : "s"}. Timers, tasks, or settings may also differ.`;
    elements.bootstrapDialog.setAttribute("aria-busy", String(view.busy));
    elements.bootstrapChoices.hidden = !view.choosing;
    elements.bootstrapConfirmation.hidden = !view.confirming;
    elements.bootstrapError.hidden = !view.failed && !limitRecovery;
    elements.bootstrapRetry.hidden = !view.failed;
    elements.bootstrapSignOut.hidden = !limitRecovery;
    elements.bootstrapSignOut.disabled = state.bootstrapSubmitting || !navigator.onLine;
    elements.bootstrapRetry.disabled = state.bootstrapSubmitting || !navigator.onLine;
    elements.bootstrapRetry.textContent = state.bootstrapConflict ? "Refresh and retry" : "Retry saved choice";
    if (view.failed || limitRecovery) {
      elements.bootstrapError.textContent = state.bootstrapError || state.bootstrapLimitError;
    }

    for (const button of elements.bootstrapChoiceButtons) {
      button.hidden = limitRecovery && button.dataset.bootstrapStrategy !== "keep_remote";
      button.disabled = state.bootstrapSubmitting;
    }
    elements.bootstrapConfirm.disabled = state.bootstrapSubmitting;
    elements.bootstrapCancel.disabled = state.bootstrapSubmitting;
    if (view.confirming) {
      const confirmation = syncCore.confirmationFor(state.bootstrapStrategy);
      elements.bootstrapConfirmationTitle.textContent = confirmation.title;
      elements.bootstrapConfirmationMessage.textContent = confirmation.message;
      elements.bootstrapConfirm.textContent = state.bootstrapSubmitting ? "Applying choice" : confirmation.confirmLabel;
    }
    if (!elements.bootstrapDialog.open) elements.bootstrapDialog.showModal();
    if (state.bootstrapFocusTarget) {
      const target = state.bootstrapFocusTarget;
      state.bootstrapFocusTarget = null;
      window.setTimeout(() => {
        if (elements.bootstrapDialog.open && !target.hidden) target.focus();
      }, 0);
    }
  }

  function showNotice(message) {
    window.clearTimeout(noticeTimer);
    elements.notice.textContent = message;
    elements.notice.hidden = false;
    noticeTimer = window.setTimeout(() => {
      elements.notice.hidden = true;
    }, 7000);
  }

  function createDialTicks() {
    const namespace = "http://www.w3.org/2000/svg";
    const fragment = document.createDocumentFragment();

    for (let index = 0; index < 60; index += 1) {
      const angle = (index * 6 - 90) * (Math.PI / 180);
      const major = index % 5 === 0;
      const innerRadius = major ? 117 : 122;
      const outerRadius = 128;
      const line = document.createElementNS(namespace, "line");
      line.setAttribute("x1", String(140 + Math.cos(angle) * innerRadius));
      line.setAttribute("y1", String(140 + Math.sin(angle) * innerRadius));
      line.setAttribute("x2", String(140 + Math.cos(angle) * outerRadius));
      line.setAttribute("y2", String(140 + Math.sin(angle) * outerRadius));
      if (major) line.classList.add("major");
      fragment.append(line);
    }

    elements.dialTicks.append(fragment);
    elements.dialProgress.style.strokeDasharray = String(DIAL_CIRCUMFERENCE);
    elements.dialProgress.style.strokeDashoffset = String(DIAL_CIRCUMFERENCE);
  }

  function clampInput(input) {
    const value = Math.round(clampNumber(input.value, 1, 180));
    input.value = String(value);
    issueDurationOperation(input.name, value * 60_000).then((saved) => {
      if (!saved) renderDurations();
    });
  }

  function setupEvents() {
    elements.durationForm.addEventListener("submit", (event) => event.preventDefault());

    for (const button of elements.phaseButtons) {
      button.addEventListener("click", () => {
        if (!PHASES[button.dataset.phase]) return;
        state.selectedPhase = button.dataset.phase;
        renderDurations();
        renderTaskSelector();
        renderTimer();
        persistSettings().catch(() => showNotice("Phase choice could not be saved."));
      });
    }

    for (const input of elements.durationInputs) {
      input.addEventListener("change", () => clampInput(input));
      input.addEventListener("blur", () => clampInput(input));
    }

    for (const button of elements.stepButtons) {
      button.addEventListener("click", () => {
        const input = document.getElementById(button.dataset.for);
        if (!input) return;
        input.value = String(Number(input.value) + Number(button.dataset.step));
        clampInput(input);
      });
    }

    elements.autoStartBreaks.addEventListener("change", () => {
      issueAutoStartOperation(elements.autoStartBreaks.checked);
    });

    for (const button of elements.screenButtons) {
      button.addEventListener("click", () => {
        state.activeScreen = button.dataset.screenButton === "tasks" ? "tasks" : "timer";
        renderScreens();
      });
    }

    elements.taskSelector.addEventListener("change", () => {
      state.selectedTaskId = elements.taskSelector.value || null;
      persistSettings().catch(() => showNotice("Task choice could not be saved."));
    });

    elements.taskForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const value = elements.taskInput.value;
      try {
        if (await addTask(value)) elements.taskInput.value = "";
      } catch (error) {
        showNotice(error.message || "Task could not be added.");
      }
    });

    elements.timerToggle.addEventListener("click", () => {
      if (state.timer.status === "running") issueCommand("pause");
      else if (state.timer.status === "paused") issueCommand("resume");
      else issueCommand("start");
    });
    elements.finishButton.addEventListener("click", () => finishTimer(false));
    elements.cancelButton.addEventListener("click", () => issueCommand("cancel"));
    elements.clearButton.addEventListener("click", () => issueCommand("clear"));
    elements.logoutButton.addEventListener("click", logout);
    elements.conflictDismiss.addEventListener("click", () => {
      state.conflict = null;
      renderConflict();
      renderSyncStatus();
    });
    for (const button of elements.bootstrapChoiceButtons) {
      button.addEventListener("click", () => chooseBootstrapStrategy(button.dataset.bootstrapStrategy));
    }
    elements.bootstrapConfirm.addEventListener("click", () => {
      chooseBootstrapStrategy(state.bootstrapStrategy, true);
    });
    elements.bootstrapCancel.addEventListener("click", () => {
      const strategy = state.bootstrapStrategy;
      state.bootstrapStrategy = null;
      state.bootstrapError = null;
      state.bootstrapFocusTarget = elements.bootstrapChoiceButtons.find(
        (button) => button.dataset.bootstrapStrategy === strategy
      ) || elements.bootstrapChoiceButtons[0];
      renderBootstrapDialog();
    });
    elements.bootstrapRetry.addEventListener("click", retryBootstrapResolution);
    elements.bootstrapSignOut.addEventListener("click", logout);
    elements.bootstrapDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (state.bootstrapStrategy && !state.bootstrapPending) {
        const strategy = state.bootstrapStrategy;
        state.bootstrapStrategy = null;
        state.bootstrapFocusTarget = elements.bootstrapChoiceButtons.find(
          (button) => button.dataset.bootstrapStrategy === strategy
        ) || elements.bootstrapChoiceButtons[0];
        renderBootstrapDialog();
      }
    });

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("pagehide", () => {
      if (!db || !state.deviceId) return;
      syncStorage.releaseTimerOwnership(db, {
        deviceId: state.deviceId,
        tabId: TAB_ID,
        nowMs: Date.now()
      }).catch(() => {});
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      renderTimer();
      if (navigator.onLine) {
        if (state.authenticated && state.csrfToken && !needsBootstrapResolution()) scheduleSync(0, true);
        else handleOnline();
      }
    });

    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      installPrompt = event;
      elements.installButton.hidden = false;
    });
    elements.installButton.addEventListener("click", async () => {
      if (!installPrompt) return;
      installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
      elements.installButton.hidden = true;
    });
    window.addEventListener("appinstalled", () => {
      installPrompt = null;
      elements.installButton.hidden = true;
    });
  }

  async function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    try {
      await navigator.serviceWorker.register("/sw.js", { scope: "/app" });
    } catch (error) {
      console.warn("Pomodorough offline shell unavailable:", error);
    }
  }

  async function initialize() {
    createDialTicks();
    setupEvents();
    render();
    registerServiceWorker();

    try {
      await loadLocalState();
      state.ready = true;
      elements.deviceMark.textContent = state.deviceId.slice(-4).toUpperCase();
      render();
    } catch (error) {
      showNotice(`Durable timer storage unavailable: ${error.message}`);
      renderSyncStatus();
      return;
    }

    try {
      if (await loadSession()) {
        await prepareBootstrap();
      }
    } catch (error) {
      if (!state.sessionIdentityValidated) {
        state.authenticated = false;
        state.csrfToken = null;
        await activateCachedOwnerOffline();
      }
      if (navigator.onLine) state.retrying = true;
      render();
      scheduleRetry();
      console.warn("Pomodorough session deferred:", error);
    }
  }

  function heartbeatTimerOwnership() {
    if (!db || !state.ready || !state.deviceId || !state.timer.id
      || !["running", "paused"].includes(state.timer.status)) return;
    syncStorage.renewTimerOwnership(db, {
      timerId: state.timer.id,
      deviceId: state.deviceId,
      tabId: TAB_ID,
      nowMs: Date.now(),
      leaseMs: TIMER_OWNER_LEASE_MS
    }).catch(() => {});
  }

  window.setInterval(() => {
    if (state.ready) renderTimer();
  }, 250);
  window.setInterval(heartbeatTimerOwnership, TIMER_OWNER_HEARTBEAT_MS);

  initialize();
})();
