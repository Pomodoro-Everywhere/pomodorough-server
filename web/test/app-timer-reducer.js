"use strict";

function terminalHistoryItem(timer, command, status) {
  return {
    id: timer._historyId || timer.id,
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

function sortableRFC3339Nanoseconds(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value || "");
  if (!match) throw new Error("History contains an invalid RFC3339 timestamp");
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = "", zone] = match;
  const values = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const [year, month, day, hour, minute, second] = values;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const offsetHour = zone === "Z" ? 0 : Number(zone.slice(1, 3));
  const offsetMinute = zone === "Z" ? 0 : Number(zone.slice(4, 6));
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth ||
      hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    throw new Error("History contains an invalid RFC3339 timestamp");
  }
  const wholeSecond = `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}${zone}`;
  const milliseconds = Date.parse(wholeSecond);
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error("History contains an out-of-range RFC3339 timestamp");
  }
  return BigInt(milliseconds) * 1_000_000n + BigInt(fraction.padEnd(9, "0") || "0");
}

function sortTerminalHistory(items) {
  return [...items].sort((left, right) => {
    const leftEndedAt = sortableRFC3339Nanoseconds(left.endedAt || left.completedAt || "");
    const rightEndedAt = sortableRFC3339Nanoseconds(right.endedAt || right.completedAt || "");
    if (leftEndedAt !== rightEndedAt) return leftEndedAt > rightEndedAt ? -1 : 1;
    if (left.timerId < right.timerId) return -1;
    if (left.timerId > right.timerId) return 1;
    return 0;
  });
}

function autoCompleteTimer(timer, history, occurredAt, clone, clampNumber) {
  const nextTimer = clone(timer);
  const nextHistory = clone(history || []);
  if (!nextTimer || nextTimer.status !== "running") return { timer: nextTimer, history: nextHistory };
  const anchorMs = Date.parse(nextTimer.anchorAt);
  const occurredAtMs = Date.parse(occurredAt);
  if (!Number.isFinite(anchorMs) || !Number.isFinite(occurredAtMs)) return { timer: nextTimer, history: nextHistory };
  const planned = Math.max(0, Number(nextTimer.plannedDurationMs) || 0);
  const stored = clampNumber(nextTimer.elapsedAtAnchorMs, 0, planned);
  const remaining = planned - stored;
  if (Math.max(0, occurredAtMs - anchorMs) < remaining) return { timer: nextTimer, history: nextHistory };
  const completedAt = new Date(anchorMs + remaining).toISOString();
  nextTimer.status = "completed";
  nextTimer.elapsedAtAnchorMs = planned;
  nextTimer.anchorAt = completedAt;
  if (!nextHistory.some((item) => item.timerId === nextTimer.id)) {
    nextHistory.unshift({
      id: nextTimer.id, timerId: nextTimer.id, commandId: null, phase: nextTimer.phase,
      status: "completed", plannedDurationMs: nextTimer.plannedDurationMs, completedAt,
      endedAt: completedAt, taskId: nextTimer.taskId || null
    });
  }
  return { timer: nextTimer, history: nextHistory };
}

class TimerReduction {
  constructor(timer, history, command, sessions, dependencies) {
    this.timer = timer;
    this.history = history;
    this.command = command;
    this.sessions = sessions;
    this.clone = dependencies.clone;
    this.clampNumber = dependencies.clampNumber;
    this.emptyTimer = dependencies.emptyTimer;
    this.intent = { type: command.type, commandId: command.id, occurredAt: command.occurredAt };
  }

  commandMatches(timer = this.timer) {
    return Boolean(timer?.id && this.command.timerId === timer.id);
  }

  addTerminalHistory(source, status) {
    const duplicate = this.history.some((item) => item.commandId === this.command.id && item.timerId === source.id);
    if (!duplicate) this.history.unshift(terminalHistoryItem(source, this.command, status));
  }

  targetTimer() {
    if (this.commandMatches()) return this.clone(this.timer);
    const item = this.history.find((candidate) => candidate.timerId === this.command.timerId);
    if (!item) return this.clone(this.sessions.get(this.command.timerId) || null);
    const planned = Number(item.plannedDurationMs || 0);
    return {
      id: item.timerId, _historyId: item.id, phase: item.phase, status: item.status,
      plannedDurationMs: planned, elapsedAtAnchorMs: item.status === "completed" ? planned : 0,
      anchorAt: item.endedAt || this.command.occurredAt, lastIntent: null,
      taskId: item.taskId || null, dependsOnCommandId: null
    };
  }

  preserveDisplaced(replacementId) {
    if (!this.timer || this.timer.id === replacementId) return;
    if (["running", "paused"].includes(this.timer.status)) {
      this.addTerminalHistory(this.timer, "superseded");
      return;
    }
    if (!["completed", "cancelled", "superseded"].includes(this.timer.status) ||
        this.history.some((item) => item.timerId === this.timer.id)) return;
    this.history.unshift({
      id: this.timer.id, timerId: this.timer.id, commandId: this.timer.lastIntent?.commandId || null,
      phase: this.timer.phase, status: this.timer.status, plannedDurationMs: this.timer.plannedDurationMs,
      completedAt: this.timer.status === "completed" ? this.timer.anchorAt : null,
      endedAt: this.timer.anchorAt, taskId: this.timer.taskId || null
    });
  }

  activateTarget(target) {
    this.preserveDisplaced(target.id);
    this.history = this.history.filter((item) => item.timerId !== target.id);
    this.timer = this.clone(target);
  }

  applyStart() {
    this.history = this.history.filter((item) => item.timerId !== this.command.timerId);
    this.preserveDisplaced(this.command.timerId);
    this.timer = {
      id: this.command.timerId, phase: this.command.phase, status: "running",
      plannedDurationMs: this.command.plannedDurationMs, elapsedAtAnchorMs: 0,
      anchorAt: this.command.occurredAt, lastIntent: this.intent, taskId: this.command.taskId || null,
      dependsOnCommandId: this.command.dependsOnCommandId || null
    };
    this.sessions.set(this.command.timerId, this.clone(this.timer));
  }

  applyPause() {
    const target = this.targetTimer();
    if (!target) return;
    this.activateTarget(target);
    this.timer.status = "paused";
    this.reanchor();
  }

  applyResume() {
    const target = this.targetTimer();
    if (!target) return;
    this.activateTarget(target);
    this.timer.status = "running";
    this.reanchor();
  }

  reanchor() {
    this.timer.elapsedAtAnchorMs = this.clampNumber(
      this.command.observedElapsedMs, 0, this.timer.plannedDurationMs
    );
    this.timer.anchorAt = this.command.occurredAt;
    this.timer.lastIntent = this.intent;
  }

  applyTerminal(status) {
    const target = this.targetTimer();
    if (!target) return;
    this.activateTarget(target);
    this.timer.status = status;
    this.timer.elapsedAtAnchorMs = status === "completed"
      ? this.timer.plannedDurationMs
      : this.clampNumber(this.command.observedElapsedMs, 0, this.timer.plannedDurationMs);
    this.timer.anchorAt = this.command.occurredAt;
    this.timer.lastIntent = this.intent;
    this.addTerminalHistory(this.timer, status);
  }

  applyClear() {
    const target = this.targetTimer();
    if (!target) return;
    this.sessions.set(this.command.timerId, this.clone(target));
    if (this.commandMatches()) {
      this.timer = this.emptyTimer(this.command.phase, this.command.plannedDurationMs);
    }
  }

  apply() {
    if (this.command.type === "start") this.applyStart();
    else if (this.command.type === "pause") this.applyPause();
    else if (this.command.type === "resume") this.applyResume();
    else if (this.command.type === "finish") this.applyTerminal("completed");
    else if (this.command.type === "cancel") this.applyTerminal("cancelled");
    else if (this.command.type === "clear") this.applyClear();
    if (this.timer) {
      delete this.timer._historyId;
      if (this.timer.id) this.sessions.set(this.timer.id, this.clone(this.timer));
    }
    return { timer: this.timer, history: sortTerminalHistory(this.history) };
  }
}

module.exports = function createTimerReducer(dependencies) {
  return function reduceCommand(timer, history, command, sessions = new Map()) {
    const projected = autoCompleteTimer(
      timer, history, command.occurredAt, dependencies.clone, dependencies.clampNumber
    );
    return new TimerReduction(
      projected.timer, projected.history, command, sessions, dependencies
    ).apply();
  };
};
