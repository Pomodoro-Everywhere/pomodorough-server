(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PomodoroughAppView = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const accountOperation = typeof module === "object" && module.exports
    ? require("./account-operation.js") : globalThis.PomodoroughAccountOperation;

  const DIAL_RADIUS = 108;
  const DIAL_CIRCUMFERENCE = 2 * Math.PI * DIAL_RADIUS;
  const PENDING_LOGOUT_KEY = "pomodoroughPendingLogout";

  function timingMs(name, fallback) {
    try {
      const runtime = typeof globalThis !== "undefined" ? globalThis.PomodoroughAppRuntime : null;
      const value = runtime?.TIMING_MS?.[name] ?? runtime?.timingMs?.(name, fallback);
      if (Number.isFinite(value)) return value;
    } catch { /* timing config never blocks view */ }
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

  function bindActions(owner, names) {
    return Object.fromEntries(names.map((name) => {
      owner[name] = owner[name].bind(owner);
      return [name, owner[name]];
    }));
  }

  function dialTickCountForTimer(timer) {
    return Math.max(1, Math.ceil((timer?.plannedDurationMs || 0) / 60_000));
  }

  function renderDialTickMarks(document, elements, count = 60) {
    if (!elements?.dialTicks) return;
    const total = Math.max(1, Math.min(240, Math.round(count) || 0));
    elements.dialTicks.replaceChildren();
    const namespace = "http://www.w3.org/2000/svg";
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < total; index += 1) {
      const angle = (index * 360 / total - 90) * (Math.PI / 180);
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
    if (elements.dialProgress?.style) {
      elements.dialProgress.style.strokeDasharray = String(DIAL_CIRCUMFERENCE);
      elements.dialProgress.style.strokeDashoffset = String(DIAL_CIRCUMFERENCE);
    }
  }

  const manifest = Object.freeze({
    name: "view",
    externals: ["host", "syncCore", "syncStorage", "elements"],
    requires: [
      "controlsBlocked", "tr", "phaseLabel", "phaseShortLabel", "timerStatusLabel",
      "phaseConfig", "emptyTimer", "selectedDurationMs", "elapsedFor", "positiveNumber",
      "clampNumber", "completedFocusCountForDay", "longBreakProgress", "historyDateMs",
      "activeCompletionAlertTimerId", "updateTimerCompletion", "startCompletionAlert",
      "issueDurationOperation", "issueAutoStartOperation", "issueSelectedTaskOperation",
      "persistSettings", "addTask", "deleteTask", "primeCompletionAlerts", "issueCommand",
      "finishTimer", "cancelAndClearTimer", "stopCompletionAlert", "logout", "deleteAccount",
      "closeRevisionStreamForIdentityChange", "clearLocalData", "redirectToLogin",
      "chooseBootstrapStrategy", "retryBootstrapResolution", "handleOnline", "handleOffline",
      "database", "tabId", "needsBootstrapResolution", "scheduleSync", "localBootstrapState", "getWorkspaceReadModel", "issuePhaseSelection",
      "quarantineAccountMismatch", "retryPendingLogout", "captureAccountContext", "captureDatabaseContext",
      "armSavedClaimRecovery", "cancelSavedClaimRecovery", "discardSavedClaimRecovery"
    ],
    provides: [
      "render", "renderScreens", "activateScreen", "handleScreenKeydown", "setupScreenNavigation",
      "renderDurations", "renderVersion", "renderTaskSelector", "displayTimer", "timerDisplayView",
      "renderTimerClock", "renderTimerInstruction", "renderTimerControls", "renderDialTicks", "renderTimer",
      "arrivalHistoryItems", "historyTaskContext", "historyStatusLabel", "renderHistory",
      "renderTasks", "formatTaskDuration", "formatHistoryDate", "renderProfile",
      "renderSyncStatus", "renderConflict", "renderBootstrapDialog", "renderDeviceMark", "showNotice", "dismissNotice",
      "createDialTicks", "dialTickCountFor", "commitDurationInput", "setupPreferenceEvents", "setupTaskEvents",
      "setupTimerEvents", "setupAccountEvents", "resetBootstrapChoice", "focusBootstrapDialog", "refocusBootstrapAfterCancel",
      "setupBootstrapEvents", "setupConnectivityEvents", "setupInstallEvents", "setupEvents"
    ],
    emits: [],
    listens: []
  });

  class ViewPart {
    constructor(state, external, use) {
      Object.assign(this, { state, use, document: external.host.document }, external);
    }

    actions(names) {
      return bindActions(this, names);
    }
  }

  class PreferenceView extends ViewPart {
    actions() {
      return super.actions([
        "renderScreens", "activateScreen", "handleScreenKeydown", "renderDurations",
        "renderVersion", "renderTaskSelector", "renderDeviceMark", "createDialTicks",
        "dialTickCountFor", "commitDurationInput"
      ]);
    }

    renderDeviceMark() {
      const { state, elements } = this;
      elements.deviceMark.textContent = state.deviceId.slice(-4).toUpperCase();
    }

    renderScreens() {
      const { state, elements } = this;
      const showingTasks = state.activeScreen === "tasks";
      elements.timerScreen.hidden = showingTasks;
      elements.tasksScreen.hidden = !showingTasks;
      for (const button of elements.screenButtons) {
        const selected = button.dataset.screenButton === state.activeScreen;
        button.setAttribute("aria-selected", String(selected));
        button.tabIndex = selected ? 0 : -1;
      }
    }

    activateScreen(button, focus = false) {
      const { state } = this;
      state.activeScreen = button.dataset.screenButton === "tasks" ? "tasks" : "timer";
      this.renderScreens();
      if (focus) button.focus();
    }

    handleScreenKeydown(event) {
      const { elements } = this;
      const currentIndex = elements.screenButtons.indexOf(event.currentTarget);
      if (currentIndex < 0) return;
      let nextIndex;
      switch (event.key) {
        case "ArrowLeft":
          nextIndex = (currentIndex - 1 + elements.screenButtons.length) % elements.screenButtons.length;
          break;
        case "ArrowRight":
          nextIndex = (currentIndex + 1) % elements.screenButtons.length;
          break;
        case "Home": nextIndex = 0; break;
        case "End": nextIndex = elements.screenButtons.length - 1; break;
        default: return;
      }
      event.preventDefault();
      this.activateScreen(elements.screenButtons[nextIndex], true);
    }

    renderDurations() {
      const { state, use, elements, document } = this;
      const status = state.ready ? use.getWorkspaceReadModel().canonical.status : state.timer.status;
      const active = ["running", "paused"].includes(status);
      const blocked = use.controlsBlocked();
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
      this.renderVersion();
    }

    appVersion() {
      const meta = this.document.querySelector?.('meta[name="pomodorough-version"]');
      return meta?.content?.trim() || "unknown";
    }

    renderVersion() {
      const { use, elements } = this;
      if (!elements.appVersion) return;
      const version = this.appVersion();
      elements.appVersion.textContent = use.tr(
        "pattern.version", { version }, `Version ${version}`
      );
    }

    renderTaskSelector() {
      const { state, use, elements, document } = this;
      const selectedTaskId = state.selectedTaskId || "";
      const selectedTaskAvailable = state.tasks.some((task) => task.id === selectedTaskId);
      elements.taskSelector.replaceChildren();
      const noTask = document.createElement("option");
      noTask.value = "";
      noTask.textContent = use.tr("pattern.noTask", {}, "No task");
      elements.taskSelector.append(noTask);
      if (selectedTaskId && !selectedTaskAvailable) {
        const unavailable = document.createElement("option");
        unavailable.value = selectedTaskId;
        unavailable.textContent = use.tr("pattern.taskUnavailable", {}, "Selected task unavailable");
        unavailable.disabled = true;
        elements.taskSelector.append(unavailable);
      }
      for (const task of state.tasks) {
        const option = document.createElement("option");
        option.value = task.id;
        option.textContent = task.title;
        elements.taskSelector.append(option);
      }
      elements.taskSelector.value = selectedTaskId;
      elements.taskSelector.disabled = use.controlsBlocked();
    }

    dialTickCountFor(timer) {
      return dialTickCountForTimer(timer);
    }

    createDialTicks(count = 60) {
      renderDialTickMarks(this.document, this.elements, count);
    }

    commitDurationInput(input) {
      const { use } = this;
      const context = use.captureAccountContext();
      const value = Number(input.value);
      use.issueDurationOperation(input.name, value * 60_000).then((saved) => {
        if (!saved && accountOperation.isCurrent(context)) this.renderDurations();
      });
    }
  }

  class TimerView extends ViewPart {
    actions() {
      return super.actions([
        "displayTimer", "timerDisplayView", "renderTimerClock", "renderTimerInstruction",
        "renderTimerControls", "renderDialTicks", "renderTimer"
      ]);
    }

    renderDialTicks(timer) {
      renderDialTickMarks(this.document, this.elements, dialTickCountForTimer(timer));
    }

    displayTimer() {
      const { state, use } = this;
      if (!state.ready) return state.timer;
      const display = use.getWorkspaceReadModel().display;
      return { ...state.timer, ...display };
    }

    timerDisplayView(timer, status) {
      const model = this.state.ready ? this.state.readModel || this.use.getWorkspaceReadModel() : null;
      const remaining = model?.display.remainingMs ?? timer.plannedDurationMs;
      const progress = model?.display.progress ?? 0;
      const totalSeconds = model?.display.remainingSecondsCeil ?? 1500;
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      const timeText = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
      return { remaining, progress, totalSeconds, minutes, seconds, timeText, status };
    }

    renderTimerClock(timer, view) {
      const { state, use, elements } = this;
      elements.timerDisplay.textContent = view.timeText;
      elements.timerDisplay.dateTime = `PT${Math.floor(view.totalSeconds / 60)}M${view.seconds}S`;
      elements.timerDisplay.setAttribute("aria-label", use.tr(
        "timer.remainingLabel",
        { minutes: view.minutes, seconds: view.seconds, phase: use.phaseLabel(timer.phase), status: use.timerStatusLabel(view.status) },
        `${view.minutes} minutes ${view.seconds} seconds remaining, ${use.phaseLabel(timer.phase)}, ${use.timerStatusLabel(view.status)}`
      ));
      elements.phaseLabel.textContent = use.phaseLabel(timer.phase).toUpperCase();
      elements.timerDetail.textContent = use.tr(
        "timer.detail",
        { status: use.timerStatusLabel(view.status).toUpperCase(), minutes: Math.round(timer.plannedDurationMs / 60000) },
        `${use.timerStatusLabel(view.status).toUpperCase()} / ${Math.round(timer.plannedDurationMs / 60000)} MIN`
      );
      const breakProgress = state.readModel?.cadence.longBreakProgress ?? 0;
      elements.longBreakProgress.textContent = `${"●".repeat(breakProgress)}${"○".repeat(4 - breakProgress)}`;
      elements.longBreakProgress.setAttribute("aria-label", use.tr(
        "timer.pomodoroProgress", { count: breakProgress, total: 4 },
        `Pomodoro progress: ${breakProgress} of 4 today`
      ));
      elements.dial.dataset.status = view.status;
      elements.dialProgress.style.strokeDashoffset = String(DIAL_CIRCUMFERENCE * (1 - view.progress));
    }

    renderTimerInstruction(timer, status) {
      const { use, elements } = this;
      if (status === "running") {
        elements.timerToggle.textContent = use.tr("timer.pause", {}, "Pause");
        elements.timerInstruction.textContent = use.tr(
          "timer.instruction.running", {}, "Service underway. Continue here or on another device."
        );
      } else if (status === "paused") {
        elements.timerToggle.textContent = use.tr("timer.resume", {}, "Resume");
        elements.timerInstruction.textContent = use.tr(
          "timer.instruction.paused", {}, "Held at this stop. Resume when ready."
        );
      } else {
        const label = use.phaseLabel(timer.phase).toLowerCase();
        elements.timerToggle.textContent = use.tr("timer.start", { phase: label }, `Start ${label}`);
        elements.timerInstruction.textContent = this.terminalTimerInstruction(status);
      }
    }

    terminalTimerInstruction(status) {
      const { use } = this;
      if (status === "completed") return use.tr(
        "timer.instruction.completed", {}, "Run complete. Stop the sound or start another."
      );
      if (status === "cancelled") return use.tr(
        "timer.instruction.cancelled", {}, "Run cancelled. Start another."
      );
      if (status === "superseded") return use.tr(
        "timer.instruction.superseded", {}, "Another device is carrying this timer."
      );
      return use.tr("timer.instruction.idle", {}, "Choose a pattern, then start the clock.");
    }

    renderTimerControls(timer, view) {
      const { use, elements } = this;
      const intents = this.state.readModel?.availableIntents || [];
      const blocked = use.controlsBlocked() || this.state.workspaceBlocked;
      elements.timerToggle.disabled = blocked || !intents.some((intent) => ["start", "pause", "resume"].includes(intent));
      elements.finishButton.disabled = blocked || !intents.includes("finish");
      elements.cancelButton.disabled = blocked || !intents.includes("cancelAndClear");
      // Finished timers offer Start only: the clear control stops the
      // completion sound while it rings and never dismisses the terminal
      // timer. The next Start replaces it.
      elements.clearButton.disabled = blocked || !use.activeCompletionAlertTimerId();
      use.updateTimerCompletion(this.state.timer, this.state.timer.status,
        this.state.readModel?.canonical.remainingMs ?? view.remaining, blocked);
    }

    renderTimer() {
      const { state, use } = this;
      const timer = this.displayTimer();
      const status = state.readModel?.display.status || state.timer.status;
      if (state.timer.status === "completed") use.startCompletionAlert(state.timer);
      const view = this.timerDisplayView(timer, status);
      this.renderDialTicks(timer);
      this.renderTimerClock(timer, view);
      this.renderTimerInstruction(timer, status);
      this.renderTimerControls(timer, view);
    }
  }

  class ActivityView extends ViewPart {
    actions() {
      return super.actions([
        "arrivalHistoryItems", "historyTaskContext", "historyStatusLabel", "renderHistory",
        "renderTasks", "formatTaskDuration", "formatHistoryDate"
      ]);
    }

    emptyHistoryItem() {
      const { use, document } = this;
      const empty = document.createElement("li");
      empty.className = "history-empty";
      const title = document.createElement("strong");
      title.textContent = use.tr("history.empty", {}, "No arrivals yet");
      const detail = document.createElement("span");
      detail.textContent = use.tr("history.empty.detail", {}, "Your first run appears here.");
      empty.append(title, detail);
      return empty;
    }

    historyItemLabel(item, phaseKey) {
      const { state, use, document } = this;
      const label = document.createElement("span");
      label.className = "history-phase";
      label.textContent = use.phaseLabel(phaseKey);
      const task = document.createElement("small");
      task.className = "history-task";
      task.textContent = this.historyTaskContext(item, state.tasks);
      const status = document.createElement("small");
      status.className = "history-status";
      status.textContent = use.tr(
        "history.statusSeparator", { status: this.historyStatusLabel(item) },
        ` / ${this.historyStatusLabel(item)}`
      );
      label.append(task, status);
      if (item.pending) {
        const pending = document.createElement("small");
        pending.className = "history-pending";
        pending.textContent = use.tr("history.queued", {}, " / queued");
        label.append(pending);
      }
      return label;
    }

    historyListItem(item) {
      const { use, document } = this;
      const phaseKey = use.phaseConfig()[item.phase] ? item.phase : "focus";
      const durationMs = use.positiveNumber(
        item.plannedDurationMs ?? item.durationMs ?? item.timer?.plannedDurationMs, 0
      );
      const dateValue = item.completedAt || item.endedAt || item.occurredAt || item.createdAt;
      const listItem = document.createElement("li");
      listItem.className = "history-item";
      const stamp = document.createElement("span");
      stamp.className = "history-stamp";
      stamp.textContent = use.phaseShortLabel(phaseKey);
      stamp.setAttribute("aria-hidden", "true");
      const date = document.createElement("time");
      date.className = "history-date";
      if (dateValue) date.dateTime = dateValue;
      date.textContent = this.formatHistoryDate(dateValue);
      const duration = document.createElement("span");
      duration.className = "history-duration";
      const minutes = Math.max(1, Math.round(durationMs / 60000));
      duration.textContent = use.tr("history.minutes", { count: minutes }, `${minutes} min`);
      listItem.append(stamp, this.historyItemLabel(item, phaseKey), date, duration);
      return listItem;
    }

    renderHistory() {
      const { state, use, elements } = this;
      const arrivals = this.arrivalHistoryItems(state.history);
      elements.historyCount.textContent = String(arrivals.length).padStart(3, "0");
      elements.historyList.replaceChildren();
      if (arrivals.length === 0) {
        elements.historyList.append(this.emptyHistoryItem());
        return;
      }
      const sorted = [...arrivals].sort((left, right) =>
        use.historyDateMs(right) - use.historyDateMs(left)
      );
      for (const item of sorted) elements.historyList.append(this.historyListItem(item));
    }

    arrivalHistoryItems(history) {
      const terminalStatuses = new Set(["completed", "cancelled", "superseded"]);
      return history.filter((item) => !item.status || terminalStatuses.has(item.status));
    }

    effectiveHistoryTaskId(item) {
      return item?.taskId || null;
    }

    historyTaskContext(item, tasks) {
      const { use } = this;
      const taskId = this.effectiveHistoryTaskId(item);
      if (!taskId) return use.tr("history.unassigned", {}, "Unassigned");
      return tasks.find((candidate) => candidate.id === taskId)?.title
        || use.tr("history.deletedTask", {}, "Deleted task");
    }

    historyStatusLabel(item) {
      const { use } = this;
      if (!item.status || item.status === "completed") return use.tr(
        "history.completed", {}, "Completed"
      );
      if (item.status === "cancelled") return use.tr("history.cancelled", {}, "Cancelled");
      return use.tr("history.superseded", {}, "Superseded");
    }

    emptyTaskListItem() {
      const { use, document } = this;
      const empty = document.createElement("p");
      empty.className = "task-empty";
      const title = document.createElement("strong");
      title.textContent = use.tr("tasks.empty", {}, "No tasks yet");
      const detail = document.createElement("span");
      detail.textContent = use.tr(
        "tasks.empty.detail", {}, "Add a task, then assign it before starting focus."
      );
      empty.append(title, detail);
      return empty;
    }

    taskListItem(task, summary, blocked) {
      const { use, document } = this;
      const row = document.createElement("article");
      row.className = "task-row";
      row.dataset.taskId = task.id;
      const name = document.createElement("strong");
      name.className = "task-name";
      name.textContent = task.title;
      const count = document.createElement("span");
      count.className = "task-stat";
      count.textContent = String(summary.count);
      count.setAttribute("data-stat-label", use.tr("tasks.column.finished", {}, "Finished"));
      count.setAttribute("aria-label", use.tr(
        "tasks.finishedToday", { count: summary.count },
        `${summary.count} finished pomodoros today`
      ));
      const duration = document.createElement("span");
      duration.className = "task-stat";
      duration.textContent = this.formatTaskDuration(summary.durationMs);
      duration.setAttribute("data-stat-label", use.tr("tasks.column.time", {}, "Time"));
      duration.setAttribute("aria-label", use.tr(
        "tasks.spentToday", { duration: this.formatTaskDuration(summary.durationMs) },
        `${this.formatTaskDuration(summary.durationMs)} spent today`
      ));
      const remove = document.createElement("button");
      remove.className = "task-delete";
      remove.type = "button";
      remove.textContent = use.tr("action.delete", {}, "Delete");
      remove.setAttribute("aria-label", use.tr(
        "tasks.deleteNamed", { title: task.title }, `Delete ${task.title}`
      ));
      remove.disabled = blocked;
      remove.addEventListener("click", () => use.deleteTask(task));
      row.append(name, count, duration, remove);
      return row;
    }

    focusedTaskDeletion() {
      const { document, elements } = this;
      const active = document.activeElement;
      if (!active) return null;
      const rows = Array.from(elements.taskList.children);
      const index = rows.findIndex((row) => row.querySelector(".task-delete") === active);
      if (index < 0) return null;
      // Prefer the same task, then surviving successors, then predecessors.
      const candidates = [...rows.slice(index), ...rows.slice(0, index).reverse()];
      return { active, taskIds: candidates.map((row) => row.dataset.taskId) };
    }

    restoreTaskDeletionFocus(focus, blocked) {
      const { document, elements } = this;
      if (!focus || blocked || elements.tasksScreen.hidden) return;
      // A synchronous focus handler may have moved focus elsewhere during rendering.
      if (document.activeElement !== document.body && document.activeElement !== focus.active) return;
      const rows = new Map(Array.from(elements.taskList.children).map((row) => [row.dataset.taskId, row]));
      const taskId = focus.taskIds.find((id) => rows.has(id));
      const target = taskId ? rows.get(taskId).querySelector(".task-delete") : elements.taskInput;
      if (target.disabled || target.closest("[hidden], [inert]")) return;
      target.focus({ preventScroll: true });
    }

    renderTasks() {
      const { state, use, elements } = this;
      const focus = this.focusedTaskDeletion();
      const blocked = use.controlsBlocked();
      elements.taskCount.textContent = String(state.tasks.length).padStart(2, "0");
      elements.taskList.replaceChildren();
      elements.taskInput.disabled = blocked;
      elements.taskForm.querySelector("button[type='submit']").disabled = blocked;
      if (state.tasks.length === 0) {
        elements.taskList.append(this.emptyTaskListItem());
        this.restoreTaskDeletionFocus(focus, blocked);
        return;
      }
      const summaries = this.taskSummariesToday();
      for (const task of state.tasks) {
        elements.taskList.append(this.taskListItem(
          task, summaries.get(task.id) || { count: 0, durationMs: 0 }, blocked
        ));
      }
      this.restoreTaskDeletionFocus(focus, blocked);
    }

    taskSummariesToday() {
      if (!this.state.ready) return new Map();
      const rows = this.use.getWorkspaceReadModel().tasks.completedFocusTodayByTask;
      return new Map(Object.entries(rows).map(([id, row]) => [id,
        { count: row.count, durationMs: row.plannedDurationMs }]));
    }

    formatTaskDuration(durationMs) {
      const { use } = this;
      const totalMinutes = Math.round(Math.max(0, durationMs) / 60000);
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      if (!hours) return use.tr("duration.minutesShort", { count: minutes }, `${minutes} min`);
      if (!minutes) return use.tr("duration.hoursShort", { count: hours }, `${hours} hr`);
      return use.tr(
        "duration.hoursMinutesShort", { hours, minutes }, `${hours} hr ${minutes} min`
      );
    }

    formatHistoryDate(value) {
      const { use } = this;
      const date = new Date(value);
      if (!value || Number.isNaN(date.getTime())) return use.tr(
        "history.timeNotRecorded", {}, "Time not recorded"
      );
      return new Intl.DateTimeFormat(undefined, {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
      }).format(date);
    }
  }

  class AccountView extends ViewPart {
    actions() {
      return super.actions([
        "renderProfile", "renderSyncStatus", "renderConflict", "renderBootstrapDialog",
        "resetBootstrapChoice", "focusBootstrapDialog", "refocusBootstrapAfterCancel"
      ]);
    }

    renderProfile() {
      const { state, use, elements } = this;
      if (!state.user || state.logoutRecoveryRequired) {
        elements.profile.hidden = true;
        return;
      }
      elements.profile.hidden = false;
      if (state.user.avatarUrl) {
        elements.profileAvatar.src = state.user.avatarUrl;
        elements.profileAvatar.alt = use.tr("account.profilePhoto", {}, "Account profile photo");
        elements.profileAvatar.hidden = false;
      } else {
        elements.profileAvatar.removeAttribute("src");
        elements.profileAvatar.hidden = true;
      }
    }

    pendingCount() {
      const { state } = this;
      return state.pending.length + state.pendingTaskOperations.length
        + state.pendingDurationOperations.length + state.pendingAutoStartOperations.length
        + state.pendingSelectedTaskOperations.length;
    }

    renderSyncStatus() {
      const { state, use, elements, host } = this;
      const count = this.pendingCount();
      let syncState = "synced";
      let label = use.tr("sync.inSync", {}, "In sync");
      if (!host.navigator.onLine) {
        syncState = "offline";
        label = count ? use.tr("sync.offlineQueued", { count }, `Offline / ${count} queued`)
          : use.tr("sync.offlineLocal", {}, "Offline / local");
      } else if (state.bootstrapSubmitting) {
        syncState = "syncing";
        label = use.tr("sync.resolvingHistory", {}, "Resolving history");
      } else if (state.bootstrapError || state.bootstrapLimitError) {
        syncState = "error";
        label = use.tr("sync.historyChoiceNeeded", {}, "History choice needed");
      } else if (state.bootstrapBlocked) {
        syncState = "loading";
        label = state.bootstrapPlan?.mode === "choose"
          ? use.tr("sync.chooseHistory", {}, "Choose history")
          : use.tr("sync.checkingHistory", {}, "Checking history");
      } else if (state.conflict) {
        syncState = "conflict";
        label = count ? use.tr("sync.conflictQueued", { count }, `Conflict / ${count} queued`)
          : use.tr("sync.conflict", {}, "Conflict");
      } else if (state.syncing) {
        syncState = "syncing";
        label = use.tr("sync.syncing", {}, "Syncing");
      } else if (state.retrying) {
        syncState = "error";
        label = count ? use.tr("sync.retryingQueued", { count }, `Retrying / ${count} queued`)
          : use.tr("sync.retrying", {}, "Retrying sync");
      } else if (count) {
        syncState = "loading";
        label = use.tr("sync.waiting", { count }, `${count} waiting to sync`);
      } else if (!state.ready) {
        syncState = "loading";
        label = use.tr("sync.checking", {}, "Checking line");
      }
      elements.syncStatus.dataset.state = syncState;
      elements.syncStatusText.textContent = label;
    }

    renderConflict() {
      const { state, elements, use } = this;
      elements.conflictPanel.hidden = !state.conflict;
      if (state.conflict) elements.conflictReason.textContent = state.conflict;
      const recovery = state.savedClaimRecovery;
      if (!elements.savedClaimRecovery) return;
      elements.savedClaimRecovery.hidden = !recovery;
      if (!recovery) return;
      const names = (recovery.queues || []).join(", ");
      elements.savedClaimRecoveryText.textContent = use.tr("sync.savedClaimBlocked",
        { queues: names || "sync queue" }, state.conflict);
      const armed = recovery.armed === true;
      elements.savedClaimDiscard.textContent = use.tr(armed
        ? "sync.confirmDiscardSavedClaim" : "sync.discardSavedClaim", {},
        armed ? "Confirm discard — queued work stays" : "Discard unrecoverable claim");
      elements.savedClaimCancel.hidden = !armed;
    }

    renderBootstrapSummary(view, limitRecovery) {
      const { state, use, elements } = this;
      const localCount = state.bootstrapPlan?.localHistoryCount
        ?? state.bootstrapClassification?.local.completedHistoryCount ?? 0;
      const remoteCount = state.bootstrapPlan?.remoteHistoryCount
        ?? state.bootstrapClassification?.remote.completedHistoryCount ?? 0;
      elements.bootstrapTitle.textContent = limitRecovery
        ? use.tr("bootstrap.limitTitle", {}, "Local queue too large")
        : use.tr("bootstrap.title", {}, "Choose synchronized state");
      if (limitRecovery) {
        elements.bootstrapSummary.textContent = use.tr(
          "bootstrap.limitSummary", {}, "Upload stopped before any local or remote data changed."
        );
      } else {
        const localRuns = use.tr("bootstrap.localRuns", { count: localCount },
          `${localCount} local completed run${localCount === 1 ? "" : "s"}`);
        const remoteRuns = use.tr("bootstrap.remoteRuns", { count: remoteCount },
          `${remoteCount} remote completed run${remoteCount === 1 ? "" : "s"}`);
        const divergenceNote = use.tr(
          "bootstrap.divergenceNote", {}, "Timers, tasks, or settings may also differ."
        );
        elements.bootstrapSummary.textContent = `${localRuns}; ${remoteRuns}. ${divergenceNote}`;
      }
      elements.bootstrapDialog.setAttribute("aria-busy", String(view.busy));
      if (state.bootstrapOwnershipConfirmation) elements.bootstrapSummary.textContent = use.tr("bootstrap.ownershipChanged", {},
        "Account ownership changed or predates incarnation validation. Retained work cannot be uploaded to this account. Keep remote explicitly discards retained local work; cancel leaves it untouched.");
      elements.bootstrapChoices.hidden = !view.choosing;
      elements.bootstrapConfirmation.hidden = !view.confirming;
    }

    renderBootstrapActions(view, limitRecovery) {
      const { state, elements, use, host } = this;
      elements.bootstrapError.hidden = !view.failed && !limitRecovery;
      elements.bootstrapRetry.hidden = !view.failed;
      elements.bootstrapSignOut.hidden = !limitRecovery;
      elements.bootstrapSignOut.disabled = state.bootstrapSubmitting || !host.navigator.onLine;
      elements.bootstrapRetry.disabled = state.bootstrapSubmitting || !host.navigator.onLine;
      elements.bootstrapRetry.textContent = state.bootstrapConflict
        ? use.tr("bootstrap.retryRefresh", {}, "Refresh and retry")
        : use.tr("bootstrap.retry", {}, "Retry saved choice");
      if (view.failed || limitRecovery) {
        elements.bootstrapError.textContent = state.bootstrapError || state.bootstrapLimitError;
      }
      for (const button of elements.bootstrapChoiceButtons) {
        button.hidden = (limitRecovery || state.bootstrapOwnershipConfirmation)
          && button.dataset.bootstrapStrategy !== "keep_remote";
        button.disabled = state.bootstrapSubmitting;
      }
      elements.bootstrapConfirm.disabled = state.bootstrapSubmitting;
      elements.bootstrapCancel.disabled = state.bootstrapSubmitting;
    }

    renderBootstrapConfirmation(view) {
      const { state, elements, use, syncCore } = this;
      if (!view.confirming) return;
      const confirmation = syncCore.confirmationFor(state.bootstrapStrategy);
      elements.bootstrapConfirmationTitle.textContent = confirmation.title;
      elements.bootstrapConfirmationMessage.textContent = confirmation.message;
      elements.bootstrapConfirm.textContent = state.bootstrapSubmitting
        ? use.tr("bootstrap.applyingChoice", {}, "Applying choice") : confirmation.confirmLabel;
    }

    focusBootstrapDialog() {
      const { state, elements, host } = this;
      elements.bootstrapDialog.setAttribute?.("aria-modal", "true");
      if (!elements.bootstrapDialog.open) elements.bootstrapDialog.showModal();
      if (!state.bootstrapFocusTarget) return;
      const target = state.bootstrapFocusTarget;
      state.bootstrapFocusTarget = null;
      host.setTimeout(() => {
        if (elements.bootstrapDialog.open && !target.hidden) target.focus();
      }, timingMs("focusDefer", 0));
    }

    renderBootstrapDialog() {
      const { state, elements, syncCore } = this;
      if (elements.logoutRecovery) elements.logoutRecovery.hidden = !state.logoutRecoveryRequired;
      if (state.logoutRecoveryRequired) {
        this.renderLogoutRecovery();
        return;
      }
      const limitRecovery = Boolean(state.bootstrapLimitError);
      const view = syncCore.bootstrapDialogView({
        planMode: limitRecovery || state.bootstrapOwnershipConfirmation ? "choose" : state.bootstrapPlan?.mode,
        strategy: state.bootstrapStrategy, pending: state.bootstrapPending,
        error: state.bootstrapError, submitting: state.bootstrapSubmitting,
        blocked: state.bootstrapBlocked, authenticated: state.authenticated
      });
      if (!view.open) {
        if (elements.bootstrapDialog.open) elements.bootstrapDialog.close();
        return;
      }
      this.renderBootstrapSummary(view, limitRecovery);
      this.renderBootstrapActions(view, limitRecovery);
      this.renderBootstrapConfirmation(view);
      this.focusBootstrapDialog();
    }

    renderLogoutRecovery() {
      const { state, elements, use, host } = this;
      elements.bootstrapTitle.textContent = use.tr(
        "account.logout.recoveryTitle", {}, "Finish pending sign-out"
      );
      elements.bootstrapSummary.textContent = use.tr(
        "account.logout.recoverySummary", {},
        "Finish sign-out before using local data. Connect and sign in to the account that owns the pending data, then retry. A different account cannot clear it."
      );
      for (const name of ["bootstrapChoices", "bootstrapConfirmation", "bootstrapError",
        "bootstrapRetry", "bootstrapSignOut"]) elements[name].hidden = true;
      elements.bootstrapDialog.setAttribute("aria-busy", String(state.logoutRecoveryBusy));
      elements.logoutRecoveryRetry.disabled = state.logoutRecoveryBusy;
      elements.logoutRecoverySignIn.disabled = state.logoutRecoveryBusy || !host.navigator.onLine;
      this.focusBootstrapDialog();
    }

    resetBootstrapChoice(clearError = false) {
      const { state, elements } = this;
      const strategy = state.bootstrapStrategy;
      state.bootstrapStrategy = null;
      if (clearError) state.bootstrapError = null;
      state.bootstrapFocusTarget = elements.bootstrapChoiceButtons.find(
        (button) => button.dataset.bootstrapStrategy === strategy
      ) || elements.bootstrapChoiceButtons[0];
      this.renderBootstrapDialog();
    }

    refocusBootstrapAfterCancel() {
      const { state, elements, document } = this;
      if (document.activeElement?.blur) document.activeElement.blur();
      if (state.logoutRecoveryRequired) {
        state.bootstrapFocusTarget = elements.logoutRecoveryRetry;
      } else {
        state.bootstrapFocusTarget = elements.bootstrapChoiceButtons.find(
          (button) => !button.hidden && !button.disabled
        ) || ((!elements.bootstrapRetry.hidden && !elements.bootstrapRetry.disabled)
          ? elements.bootstrapRetry : elements.bootstrapChoiceButtons[0]);
      }
      this.focusBootstrapDialog();
    }
  }

  class NoticePresenter extends ViewPart {
    actions() {
      return super.actions(["showNotice", "dismissNotice"]);
    }

    showNotice(message) {
      const { elements } = this;
      const text = elements.noticeText || elements.notice;
      if (!elements.notice || !text) return;
      text.textContent = message;
      elements.notice.hidden = false;
      elements.notice.setAttribute?.("role", "alert");
      elements.notice.setAttribute?.("aria-live", "assertive");
    }

    dismissNotice() {
      const { elements } = this;
      if (elements.notice) elements.notice.hidden = true;
    }
  }

  class ViewRenderer {
    constructor(view) {
      this.view = view;
      this.render = this.render.bind(this);
    }

    render() {
      const { view } = this;
      view.renderScreens();
      view.renderDurations();
      view.renderTaskSelector();
      view.renderTimer();
      view.renderHistory();
      view.renderTasks();
      view.renderProfile();
      view.renderSyncStatus();
      view.renderConflict();
      view.renderBootstrapDialog();
    }
  }

  class ViewEventInstaller extends ViewPart {
    constructor(state, external, use, view) {
      super(state, external, use);
      this.view = view;
      this.installPrompt = null;
    }

    actions() {
      return super.actions([
        "setupScreenNavigation", "setupPreferenceEvents", "setupTaskEvents", "setupTimerEvents",
        "setupAccountEvents", "setupBootstrapEvents", "setupConnectivityEvents",
        "setupInstallEvents", "setupEvents"
      ]);
    }

    setupScreenNavigation() {
      const { elements, view, document } = this;
      for (const button of elements.screenButtons) {
        button.addEventListener("click", () => view.activateScreen(button, true));
        button.addEventListener("keydown", view.handleScreenKeydown);
      }
      document.querySelector?.("#skipTimerLink")?.addEventListener("click", () => {
        const timerTab = elements.screenButtons.find((button) => button.dataset.screenButton === "timer");
        view.activateScreen(timerTab);
        // Reveal before focusing; leave the anchor's native hash navigation intact.
        document.getElementById("timer-workbench").focus();
      });
    }

    setupPreferenceEvents() {
      const { state, use, elements, document, view, host } = this;
      elements.durationForm.addEventListener("submit", (event) => event.preventDefault());
      for (const button of elements.phaseButtons) {
        button.addEventListener("click", () => {
          use.issuePhaseSelection(button.dataset.phase);
        });
      }
      for (const input of elements.durationInputs) {
        input.addEventListener("change", () => view.commitDurationInput(input));
        input.addEventListener("blur", () => view.commitDurationInput(input));
      }
      for (const button of elements.stepButtons) {
        button.addEventListener("click", () => {
          const input = document.getElementById(button.dataset.for);
          if (!input) return;
          const step = Number(button.dataset.step);
          const delta = Number.isFinite(step) ? step : 0;
          const base = Number(input.value);
          input.value = String(base + delta);
          view.commitDurationInput(input);
        });
      }
      elements.autoStartBreaks.addEventListener("change", () => {
        use.issueAutoStartOperation(elements.autoStartBreaks.checked);
      });
      this.setupScreenNavigation();
      elements.taskSelector.addEventListener("change", () => {
        use.issueSelectedTaskOperation(elements.taskSelector.value || null);
      });
    }

    setupTaskEvents() {
      const { use, elements, view } = this;
      elements.taskForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const value = elements.taskInput.value;
        try {
          if (await use.addTask(value)) elements.taskInput.value = "";
        } catch (error) {
          view.showNotice(error.message || use.tr("notice.taskAddFailed", {}, "Task could not be added."));
        }
      });
    }

    setupTimerEvents() {
      const { state, use, elements, view } = this;
      elements.timerToggle.addEventListener("click", () => {
        const kind = use.getWorkspaceReadModel().availableIntents.find((intent) =>
          ["start", "pause", "resume"].includes(intent));
        if (!kind) return;
        use.primeCompletionAlerts();
        use.issueCommand(kind);
      });
      elements.finishButton.addEventListener("click", () => use.finishTimer(false));
      elements.cancelButton.addEventListener("click", use.cancelAndClearTimer);
      elements.clearButton.addEventListener("click", () => {
        // Stop-sound only: terminal timers are never dismissed here. The
        // next Start replaces the finished timer.
        use.stopCompletionAlert();
        view.renderTimer();
      });
    }

    setupAccountEvents() {
      const { state, use, elements, host, view } = this;
      elements.logoutButton.addEventListener("click", use.logout);
      elements.deleteAccountButton.addEventListener("click", use.deleteAccount);
      elements.logoutRecoveryRetry?.addEventListener("click", use.retryPendingLogout);
      elements.logoutRecoverySignIn?.addEventListener("click", use.redirectToLogin);
      host.addEventListener("storage", (event) => {
        if (event.key !== PENDING_LOGOUT_KEY || event.newValue !== "1") return;
        const context = use.captureDatabaseContext();
        use.closeRevisionStreamForIdentityChange();
        use.clearLocalData(undefined, context)
          .then((completed) => {
            if (accountOperation.isCurrent(completed)) use.redirectToLogin();
          }, (error) => {
            if (!accountOperation.isCurrent(context)) return;
            host.console.warn("Cross-tab sign-out cleanup was incomplete:", error);
            reportFrontendError(error, "view.cross-tab-logout.cleanup-incomplete");
            use.redirectToLogin();
          });
      });
      elements.conflictDismiss.addEventListener("click", () => {
        state.conflict = null;
        view.renderConflict();
        view.renderSyncStatus();
      });
      elements.savedClaimDiscard?.addEventListener("click", () => {
        if (state.savedClaimRecovery?.armed === true) {
          use.discardSavedClaimRecovery(use.captureAccountContext()).catch((error) => {
            view.showNotice(error.message || state.conflict);
          });
        } else {
          use.armSavedClaimRecovery();
        }
      });
      elements.savedClaimCancel?.addEventListener("click", () => {
        use.cancelSavedClaimRecovery();
      });
      elements.noticeDismiss?.addEventListener("click", () => view.dismissNotice());
    }

    setupBootstrapEvents() {
      const { state, use, elements, view } = this;
      for (const button of elements.bootstrapChoiceButtons) {
        button.addEventListener("click", () => use.chooseBootstrapStrategy(button.dataset.bootstrapStrategy));
      }
      elements.bootstrapConfirm.addEventListener("click", () => {
        use.chooseBootstrapStrategy(state.bootstrapStrategy, true);
      });
      elements.bootstrapCancel.addEventListener("click", () => view.resetBootstrapChoice(true));
      elements.bootstrapRetry.addEventListener("click", () => use.retryBootstrapResolution(use.captureAccountContext()));
      elements.bootstrapSignOut.addEventListener("click", use.logout);
      elements.bootstrapDialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        if (state.bootstrapStrategy && !state.bootstrapPending) view.resetBootstrapChoice();
        else view.refocusBootstrapAfterCancel();
      });
    }

    setupConnectivityEvents() {
      const { state, use, host, syncStorage, document, view } = this;
      host.addEventListener("online", use.handleOnline);
      host.addEventListener("offline", use.handleOffline);
      host.addEventListener("pagehide", () => {
        if (!use.database() || !state.deviceId) return;
        const context = use.captureDatabaseContext();
        accountOperation.requireBound(context);
        syncStorage.releaseTimerOwnership(context.database, {
          ...context, expectedUserId: context.ownerId,
          deviceId: state.deviceId, tabId: use.tabId(), nowMs: Date.now()
        }).catch((error) => {
          if (!accountOperation.isCurrent(context)) return;
          if (error.name === "AccountOwnershipError") use.quarantineAccountMismatch();
          else {
            host.console.warn("Timer ownership release failed:", error);
            if (!accountOperation.isCurrent(context)) return;
            reportFrontendError(error, "view.timer-ownership.release-failed");
          }
        });
      });
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        view.renderTimer();
        if (host.navigator.onLine) {
          if (state.authenticated && state.csrfToken && !use.needsBootstrapResolution()) {
            use.scheduleSync(0, true);
          } else use.handleOnline();
        }
      });
    }

    setupInstallEvents() {
      const { elements, host } = this;
      host.addEventListener("beforeinstallprompt", (event) => {
        event.preventDefault();
        this.installPrompt = event;
        elements.installButton.hidden = false;
      });
      elements.installButton.addEventListener("click", async () => {
        if (!this.installPrompt) return;
        this.installPrompt.prompt();
        await this.installPrompt.userChoice;
        this.installPrompt = null;
        elements.installButton.hidden = true;
      });
      host.addEventListener("appinstalled", () => {
        this.installPrompt = null;
        elements.installButton.hidden = true;
      });
    }

    setupEvents() {
      this.setupPreferenceEvents();
      this.setupTaskEvents();
      this.setupTimerEvents();
      this.setupAccountEvents();
      this.setupBootstrapEvents();
      this.setupConnectivityEvents();
      this.setupInstallEvents();
    }
  }

  function create({ state, external, use }) {
    const view = {
      ...new PreferenceView(state, external, use).actions(),
      ...new TimerView(state, external, use).actions(),
      ...new ActivityView(state, external, use).actions(),
      ...new AccountView(state, external, use).actions(),
      ...new NoticePresenter(state, external, use).actions()
    };
    const installer = new ViewEventInstaller(state, external, use, view);
    return { render: new ViewRenderer(view).render, ...view, ...installer.actions() };
  }

  return Object.freeze({ manifest, create });
});
