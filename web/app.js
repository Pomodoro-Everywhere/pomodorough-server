(() => {
  "use strict";

  const DB_NAME = "pomodorough";
  const DB_VERSION = 1;
  const META_STORE = "meta";
  const PENDING_STORE = "pending";
  const CACHE_PREFIX = "pomodorough-shell-";
  const DIAL_RADIUS = 108;
  const DIAL_CIRCUMFERENCE = 2 * Math.PI * DIAL_RADIUS;
  const RETRY_MAX_MS = 60000;
  const PHASES = {
    focus: { label: "Focus", short: "F", defaultMinutes: 25 },
    short_break: { label: "Short break", short: "SB", defaultMinutes: 5 },
    long_break: { label: "Long break", short: "LB", defaultMinutes: 15 }
  };
  const ACK_SUCCESS = new Set(["accepted", "acknowledged", "applied", "duplicate", "ok"]);

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
    durationForm: document.querySelector("#durationForm"),
    phaseButtons: [...document.querySelectorAll(".phase-button")],
    durationInputs: [...document.querySelectorAll(".stepper input")],
    stepButtons: [...document.querySelectorAll("[data-step]")],
    autoStartBreaks: document.querySelector("#autoStartBreaks"),
    dial: document.querySelector("#dial"),
    dialTicks: document.querySelector("#dialTicks"),
    dialProgress: document.querySelector("#dialProgress"),
    phaseLabel: document.querySelector("#phaseLabel"),
    timerDisplay: document.querySelector("#timerDisplay"),
    timerDetail: document.querySelector("#timerDetail"),
    timerStateLabel: document.querySelector("#timerStateLabel"),
    timerInstruction: document.querySelector("#timerInstruction"),
    timerToggle: document.querySelector("#timerToggle"),
    finishButton: document.querySelector("#finishButton"),
    cancelButton: document.querySelector("#cancelButton"),
    clearButton: document.querySelector("#clearButton"),
    historyList: document.querySelector("#historyList"),
    historyCount: document.querySelector("#historyCount"),
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
  let noticeTimer = null;
  let redirecting = false;

  const state = {
    ready: false,
    authenticated: false,
    user: null,
    csrfToken: null,
    deviceId: null,
    deviceSequence: 0,
    hlcWallMs: 0,
    hlcCounter: 0,
    revision: 0,
    selectedPhase: "focus",
    autoStartBreaks: false,
    durations: Object.fromEntries(
      Object.entries(PHASES).map(([phase, config]) => [phase, config.defaultMinutes])
    ),
    baseTimer: emptyTimer("focus", 25 * 60000),
    timer: emptyTimer("focus", 25 * 60000),
    baseHistory: [],
    history: [],
    pending: [],
    syncing: false,
    retrying: false,
    conflict: null
  };

  function emptyTimer(phase, plannedDurationMs) {
    return {
      id: null,
      phase,
      status: "idle",
      plannedDurationMs,
      elapsedAtAnchorMs: 0,
      anchorAt: null,
      lastIntent: null
    };
  }

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function normalizeTimer(timer) {
    if (!timer || typeof timer !== "object") {
      return emptyTimer(state.selectedPhase, selectedDurationMs());
    }

    const phase = PHASES[timer.phase] ? timer.phase : "focus";
    const plannedDurationMs = positiveNumber(
      timer.plannedDurationMs,
      state.durations[phase] * 60000
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
      lastIntent: timer.lastIntent || null
    };
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
    return state.durations[state.selectedPhase] * 60000;
  }

  function elapsedFor(timer, now = Date.now()) {
    if (!timer) return 0;

    const planned = positiveNumber(timer.plannedDurationMs, 0);
    let elapsed = clampNumber(timer.elapsedAtAnchorMs, 0, planned);

    if (timer.status === "running" && timer.anchorAt) {
      const anchorMs = Date.parse(timer.anchorAt);
      if (Number.isFinite(anchorMs)) elapsed += Math.max(0, now - anchorMs);
    }

    return clampNumber(elapsed, 0, planned);
  }

  function commandMatches(timer, command) {
    return Boolean(timer.id && command.timerId === timer.id);
  }

  function reduceCommand(timer, history, command) {
    const nextTimer = clone(timer);
    const nextHistory = history;
    const intent = { type: command.type, commandId: command.id, occurredAt: command.occurredAt };

    switch (command.type) {
      case "start":
        return {
          timer: {
            id: command.timerId,
            phase: command.phase,
            status: "running",
            plannedDurationMs: command.plannedDurationMs,
            elapsedAtAnchorMs: 0,
            anchorAt: command.occurredAt,
            lastIntent: intent
          },
          history: nextHistory
        };

      case "pause":
        if (!commandMatches(nextTimer, command) || nextTimer.status !== "running") break;
        nextTimer.status = "paused";
        nextTimer.elapsedAtAnchorMs = clampNumber(
          command.observedElapsedMs,
          0,
          nextTimer.plannedDurationMs
        );
        nextTimer.anchorAt = command.occurredAt;
        nextTimer.lastIntent = intent;
        break;

      case "resume":
        if (!commandMatches(nextTimer, command) || nextTimer.status !== "paused") break;
        nextTimer.status = "running";
        nextTimer.elapsedAtAnchorMs = clampNumber(
          command.observedElapsedMs,
          0,
          nextTimer.plannedDurationMs
        );
        nextTimer.anchorAt = command.occurredAt;
        nextTimer.lastIntent = intent;
        break;

      case "finish":
        if (!commandMatches(nextTimer, command) || !["running", "paused"].includes(nextTimer.status)) break;
        nextTimer.status = "completed";
        nextTimer.elapsedAtAnchorMs = nextTimer.plannedDurationMs;
        nextTimer.anchorAt = command.occurredAt;
        nextTimer.lastIntent = intent;
        if (!nextHistory.some((item) => item.commandId === command.id)) {
          nextHistory.unshift({
            id: `${command.timerId}:${command.id}`,
            timerId: command.timerId,
            commandId: command.id,
            phase: command.phase,
            status: "completed",
            plannedDurationMs: command.plannedDurationMs,
            completedAt: command.occurredAt,
            pending: true
          });
        }
        break;

      case "cancel":
        if (!commandMatches(nextTimer, command) || !["running", "paused"].includes(nextTimer.status)) break;
        nextTimer.status = "cancelled";
        nextTimer.elapsedAtAnchorMs = clampNumber(
          command.observedElapsedMs,
          0,
          nextTimer.plannedDurationMs
        );
        nextTimer.anchorAt = command.occurredAt;
        nextTimer.lastIntent = intent;
        break;

      case "clear":
        if (!commandMatches(nextTimer, command) || ["running", "paused"].includes(nextTimer.status)) break;
        return {
          timer: emptyTimer(command.phase, command.plannedDurationMs),
          history: nextHistory
        };
    }

    return { timer: nextTimer, history: nextHistory };
  }

  function rebuildOptimisticState() {
    let timer = normalizeTimer(state.baseTimer);
    let history = clone(state.baseHistory || []);

    for (const command of [...state.pending].sort((a, b) => a.deviceSequence - b.deviceSequence)) {
      const reduced = reduceCommand(timer, history, command);
      timer = reduced.timer;
      history = reduced.history;
    }

    state.timer = timer;
    state.history = history;
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
      };
      request.onsuccess = () => resolve(request.result);
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

  async function writeMeta(key, value) {
    const transaction = db.transaction(META_STORE, "readwrite");
    transaction.objectStore(META_STORE).put({ key, value });
    await transactionDone(transaction);
  }

  function snapshotValue(overrides = {}) {
    return {
      revision: state.revision,
      canonicalTimer: clone(state.baseTimer),
      history: clone(state.baseHistory),
      user: clone(state.user),
      ...overrides
    };
  }

  async function persistSnapshot(overrides = {}) {
    await writeMeta("snapshot", snapshotValue(overrides));
  }

  async function loadLocalState() {
    db = await openDatabase();

    const transaction = db.transaction([META_STORE, PENDING_STORE], "readonly");
    const metaStore = transaction.objectStore(META_STORE);
    const pendingStore = transaction.objectStore(PENDING_STORE);
    const [deviceId, deviceSequence, hlc, settings, snapshot, pending] = await Promise.all([
      requestResult(metaStore.get("deviceId")),
      requestResult(metaStore.get("deviceSequence")),
      requestResult(metaStore.get("hlc")),
      requestResult(metaStore.get("settings")),
      requestResult(metaStore.get("snapshot")),
      requestResult(pendingStore.getAll())
    ]);

    state.deviceId = deviceId?.value || crypto.randomUUID();
    state.deviceSequence = Number(deviceSequence?.value) || 0;
    state.hlcWallMs = Number(hlc?.value?.wallMs) || 0;
    state.hlcCounter = Number(hlc?.value?.counter) || 0;
    state.pending = (pending || []).sort((a, b) => a.deviceSequence - b.deviceSequence);

    if (settings?.value) {
      state.selectedPhase = PHASES[settings.value.selectedPhase]
        ? settings.value.selectedPhase
        : "focus";
      state.autoStartBreaks = settings.value.autoStartBreaks === true;
      for (const phase of Object.keys(PHASES)) {
        state.durations[phase] = Math.round(clampNumber(
          settings.value.durations?.[phase] ?? PHASES[phase].defaultMinutes,
          1,
          180
        ));
      }
    }

    if (snapshot?.value) {
      state.revision = snapshot.value.revision ?? 0;
      state.baseTimer = normalizeTimer(snapshot.value.canonicalTimer);
      state.baseHistory = Array.isArray(snapshot.value.history) ? snapshot.value.history : [];
      state.user = snapshot.value.user || null;
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
      store.put({
        key: "settings",
        value: {
          selectedPhase: state.selectedPhase,
          durations: state.durations,
          autoStartBreaks: state.autoStartBreaks
        }
      });
      await transactionDone(writeTransaction);
    }

    rebuildOptimisticState();
  }

  async function persistSettings() {
    await writeMeta("settings", {
      selectedPhase: state.selectedPhase,
      durations: state.durations,
      autoStartBreaks: state.autoStartBreaks
    });
  }

  async function persistCommand(type, options = {}) {
    const now = Date.now();
    const wallMs = Math.max(now, state.hlcWallMs);
    const counter = wallMs === state.hlcWallMs ? state.hlcCounter + 1 : 0;
    const sequence = state.deviceSequence + 1;
    const activeTimer = state.timer;
    const starting = type === "start";
    const timerId = starting ? crypto.randomUUID() : activeTimer.id;
    const startingPhase = PHASES[options.phase] ? options.phase : state.selectedPhase;
    const phase = starting ? startingPhase : activeTimer.phase;
    const plannedDurationMs = starting
      ? state.durations[startingPhase] * 60000
      : activeTimer.plannedDurationMs;
    const observedElapsedMs = starting ? 0 : Math.round(elapsedFor(activeTimer, now));
    const command = {
      id: crypto.randomUUID(),
      deviceSequence: sequence,
      timerId,
      type,
      phase,
      plannedDurationMs,
      occurredAt: new Date(now).toISOString(),
      hlcWallMs: wallMs,
      hlcCounter: counter,
      observedElapsedMs
    };

    if (!timerId) throw new Error("No timer is available for this action.");

    const transaction = db.transaction([PENDING_STORE, META_STORE], "readwrite");
    transaction.objectStore(PENDING_STORE).add(command);
    const metaStore = transaction.objectStore(META_STORE);
    metaStore.put({ key: "deviceSequence", value: sequence });
    metaStore.put({ key: "hlc", value: { wallMs, counter } });
    await transactionDone(transaction);

    state.deviceSequence = sequence;
    state.hlcWallMs = wallMs;
    state.hlcCounter = counter;
    return command;
  }

  async function issueCommand(type, options = {}) {
    if (!state.ready || actionLocked) return false;

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

  function nextBreakPhase() {
    const completedFocusRounds = state.history.filter((item) => {
      const completed = !item.status || item.status === "completed";
      return completed && item.phase === "focus";
    }).length;
    return completedFocusRounds > 0 && completedFocusRounds % 4 === 0
      ? "long_break"
      : "short_break";
  }

  async function finishTimer() {
    const finishedPhase = state.timer.phase;
    const saved = await issueCommand("finish");
    if (!saved || finishedPhase !== "focus" || !state.autoStartBreaks) return saved;

    const started = await issueCommand("start", { phase: nextBreakPhase() });
    if (!started) showNotice("Focus finished, but break could not be started.");
    return saved;
  }

  function mergeServerHlc(serverWallMs) {
    const wallMs = Math.max(Date.now(), state.hlcWallMs, Number(serverWallMs) || 0);
    const counter = wallMs === state.hlcWallMs ? state.hlcCounter : 0;
    return { wallMs, counter };
  }

  async function acceptSyncResponse(payload) {
    while (actionLocked) {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }

    const acknowledgements = Array.isArray(payload.acknowledgements)
      ? payload.acknowledgements
      : [];
    const acknowledgedIds = new Set(
      acknowledgements.map((acknowledgement) => acknowledgement.commandId).filter(Boolean)
    );
    const remainingPending = state.pending.filter((command) => !acknowledgedIds.has(command.id));
    const canonicalTimer = Object.prototype.hasOwnProperty.call(payload, "canonicalTimer")
      ? payload.canonicalTimer
        ? normalizeTimer(payload.canonicalTimer)
        : emptyTimer(state.selectedPhase, selectedDurationMs())
      : state.baseTimer;
    const history = Array.isArray(payload.history) ? payload.history : state.baseHistory;
    const revision = payload.revision ?? state.revision;
    const hlc = mergeServerHlc(payload.serverHlcWallMs);
    const conflicts = acknowledgements.filter((acknowledgement) => {
      const outcome = String(acknowledgement.outcome || "").toLowerCase();
      return outcome && !ACK_SUCCESS.has(outcome);
    });

    const transaction = db.transaction([PENDING_STORE, META_STORE], "readwrite");
    const pendingStore = transaction.objectStore(PENDING_STORE);
    for (const commandId of acknowledgedIds) pendingStore.delete(commandId);
    const nextSnapshot = snapshotValue({
      revision,
      canonicalTimer: clone(canonicalTimer),
      history: clone(history)
    });
    const metaStore = transaction.objectStore(META_STORE);
    metaStore.put({ key: "snapshot", value: nextSnapshot });
    metaStore.put({ key: "hlc", value: hlc });
    await transactionDone(transaction);

    state.pending = remainingPending;
    state.baseTimer = canonicalTimer;
    state.baseHistory = history;
    state.revision = revision;
    state.hlcWallMs = hlc.wallMs;
    state.hlcCounter = hlc.counter;

    if (conflicts.length) {
      const conflict = conflicts[0];
      state.conflict = conflict.reason || `Command outcome: ${conflict.outcome}`;
    }

    rebuildOptimisticState();
  }

  async function syncNow(force = false) {
    if (syncPromise) {
      syncAgain = true;
      syncAgainForce ||= force;
      return syncPromise;
    }
    if (!state.ready || !state.authenticated || !state.csrfToken || !navigator.onLine) {
      renderSyncStatus();
      return;
    }
    if (!force && state.pending.length === 0) {
      state.retrying = false;
      renderSyncStatus();
      return;
    }

    syncPromise = (async () => {
      state.syncing = true;
      state.retrying = false;
      renderSyncStatus();

      try {
        const response = await fetch("/api/v1/sync", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": state.csrfToken
          },
          body: JSON.stringify({
            deviceId: state.deviceId,
            lastRevision: state.revision,
            commands: clone(state.pending)
          })
        });

        if (response.status === 401) {
          redirectToLogin();
          return;
        }
        if (!response.ok) throw new Error(`Sync failed (${response.status}).`);

        const payload = await response.json();
        await acceptSyncResponse(payload);
        retryDelayMs = 1000;
        state.retrying = false;
      } catch (error) {
        state.retrying = true;
        scheduleRetry();
        console.warn("Pomodorough sync deferred:", error);
      } finally {
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
      if (state.authenticated && state.csrfToken) syncNow(false);
      else restoreSessionAndSync();
    }, retryDelayMs);
    retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
  }

  async function loadSession() {
    const response = await fetch("/api/v1/me", {
      credentials: "same-origin",
      cache: "no-store"
    });

    if (response.status === 401) {
      redirectToLogin();
      return false;
    }
    if (!response.ok) throw new Error(`Session check failed (${response.status}).`);

    const payload = await response.json();
    state.user = payload.user || null;
    state.csrfToken = payload.csrfToken || null;
    state.authenticated = true;
    await persistSnapshot();
    renderProfile();
    return true;
  }

  async function loadHistory() {
    const response = await fetch("/api/v1/history", {
      credentials: "same-origin",
      cache: "no-store"
    });

    if (response.status === 401) {
      redirectToLogin();
      return;
    }
    if (!response.ok) throw new Error(`History failed (${response.status}).`);

    const payload = await response.json();
    const history = Array.isArray(payload)
      ? payload
      : Array.isArray(payload.history)
        ? payload.history
        : Array.isArray(payload.items)
          ? payload.items
          : [];
    state.baseHistory = history;
    await persistSnapshot();
    rebuildOptimisticState();
    renderHistory();
  }

  function redirectToLogin() {
    if (redirecting) return;
    redirecting = true;
    window.location.assign("/auth/google/start");
  }

  function openRevisionStream() {
    if (!state.authenticated || !navigator.onLine || eventSource) return;

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

  function closeRevisionStream() {
    eventSource?.close();
    eventSource = null;
  }

  async function restoreSessionAndSync() {
    try {
      if (!state.authenticated || !state.csrfToken) await loadSession();
      if (state.authenticated) {
        openRevisionStream();
        await syncNow(true);
      }
    } catch (error) {
      state.retrying = true;
      renderSyncStatus();
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
    if (state.pending.length > 0) {
      const confirmed = window.confirm(
        `${state.pending.length} timer action${state.pending.length === 1 ? " is" : "s are"} waiting to sync. Logging out will discard ${state.pending.length === 1 ? "it" : "them"}. Continue?`
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
      const transaction = db.transaction([META_STORE, PENDING_STORE], "readwrite");
      transaction.objectStore(META_STORE).clear();
      transaction.objectStore(PENDING_STORE).clear();
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
    renderDurations();
    renderTimer();
    renderHistory();
    renderProfile();
    renderSyncStatus();
    renderConflict();
  }

  function renderDurations() {
    const active = ["running", "paused"].includes(state.timer.status);

    for (const button of elements.phaseButtons) {
      const selected = button.dataset.phase === state.selectedPhase;
      button.setAttribute("aria-pressed", String(selected));
      button.disabled = !state.ready || active;
    }

    for (const input of elements.durationInputs) {
      if (document.activeElement !== input) input.value = state.durations[input.name];
      input.disabled = !state.ready || active;
    }
    for (const button of elements.stepButtons) button.disabled = !state.ready || active;
    elements.autoStartBreaks.checked = state.autoStartBreaks;
    elements.autoStartBreaks.disabled = !state.ready;
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
    elements.timerStateLabel.textContent = status.toUpperCase();
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

    elements.timerToggle.disabled = !state.ready;
    elements.finishButton.disabled = !state.ready || !active;
    elements.cancelButton.disabled = !state.ready || !active;
    elements.clearButton.disabled = !state.ready || ["idle", "running", "paused"].includes(status);

    if (status === "running" && remaining <= 0 && completionQueuedFor !== timer.id) {
      completionQueuedFor = timer.id;
      finishTimer().then((saved) => {
        if (!saved) completionQueuedFor = null;
      });
    } else if (status !== "running") {
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
    const count = state.pending.length;
    let syncState = "synced";
    let label = "In sync";

    if (!navigator.onLine) {
      syncState = "offline";
      label = count ? `Offline / ${count} queued` : "Offline / local";
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
    state.durations[input.name] = value;
    renderTimer();
    persistSettings().catch(() => showNotice("Duration could not be saved."));
  }

  function setupEvents() {
    elements.durationForm.addEventListener("submit", (event) => event.preventDefault());

    for (const button of elements.phaseButtons) {
      button.addEventListener("click", () => {
        if (!PHASES[button.dataset.phase]) return;
        state.selectedPhase = button.dataset.phase;
        renderDurations();
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
      state.autoStartBreaks = elements.autoStartBreaks.checked;
      persistSettings().catch(() => showNotice("Auto-start preference could not be saved."));
    });

    elements.timerToggle.addEventListener("click", () => {
      if (state.timer.status === "running") issueCommand("pause");
      else if (state.timer.status === "paused") issueCommand("resume");
      else issueCommand("start");
    });
    elements.finishButton.addEventListener("click", finishTimer);
    elements.cancelButton.addEventListener("click", () => issueCommand("cancel"));
    elements.clearButton.addEventListener("click", () => issueCommand("clear"));
    elements.logoutButton.addEventListener("click", logout);
    elements.conflictDismiss.addEventListener("click", () => {
      state.conflict = null;
      renderConflict();
      renderSyncStatus();
    });

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      renderTimer();
      if (navigator.onLine) {
        if (state.authenticated && state.csrfToken) scheduleSync(0, true);
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
      await navigator.serviceWorker.register("/sw.js", { scope: "/" });
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
        try {
          await loadHistory();
        } catch (error) {
          console.warn("Pomodorough history deferred:", error);
        }
        await syncNow(true);
        openRevisionStream();
      }
    } catch (error) {
      state.authenticated = false;
      state.csrfToken = null;
      if (navigator.onLine) state.retrying = true;
      render();
      scheduleRetry();
      console.warn("Pomodorough session deferred:", error);
    }
  }

  window.setInterval(() => {
    if (state.ready) renderTimer();
  }, 250);

  initialize();
})();
