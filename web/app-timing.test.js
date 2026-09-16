"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const runtime = require("./app-runtime.js");
const viewModule = require("./app-view.js");

test("timing config is frozen with one value per timeout", () => {
  assert.ok(Object.isFrozen(runtime.TIMING_MS));
  assert.deepEqual({ ...runtime.TIMING_MS }, {
    defer: 0,
    focusDefer: 0,
    retryInitial: 1000,
    retryMax: 60_000,
    remoteSyncInterval: 15_000,
    bootstrapLease: 300_000,
    timerOwnerLease: 60_000,
    timerOwnerHeartbeat: 15_000
  });
  assert.equal(runtime.timingMs("retryMax", 1), 60_000);
  assert.equal(runtime.timingMs("missing", 7), 7);
});

test("timeout consumers read the single timing config", () => {
  for (const file of ["app-sync.js", "app-bootstrap.js", "app-storage.js", "app-actions.js", "app-session.js", "app-view.js"]) {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");
    assert.ok(source.includes("PomodoroughAppRuntime"), `${file} must read the shared timing config`);
    assert.ok(source.includes("timingMs("), `${file} must resolve delays through timingMs`);
  }
  for (const literal of ["TIMER_OWNER_LEASE_MS = 60_000", "BOOTSTRAP_LEASE_MS = 5 * 60_000", "RETRY_MAX_MS = 60_000"]) {
    const hits = ["app-sync.js", "app-bootstrap.js", "app-storage.js", "app-actions.js"]
      .filter((file) => fs.readFileSync(path.join(__dirname, file), "utf8").includes(`const ${literal}`));
    assert.equal(hits.length, 0, `literal ${literal} must live in app-runtime.js only, found in ${hits}`);
  }
});

test("bootstrap dialog reaches screen readers as modal", () => {
  const html = fs.readFileSync(path.join(__dirname, "app.html"), "utf8");
  assert.match(html, /<dialog[^>]*id="bootstrapDialog"[^>]*aria-modal="true"[^>]*>/);
  const session = fs.readFileSync(path.join(__dirname, "app-session.js"), "utf8");
  assert.ok(session.includes('setAttribute?.("aria-modal", "true")'), "delete-account dialog must set aria-modal");
});

function focusFixture(delays) {
  const host = {
    document: {}, navigator: { onLine: true }, console: { warn() {} },
    addEventListener() {},
    setTimeout: (callback, delay) => { delays.push(delay); callback(); return 1; }
  };
  const dialog = {
    open: true, hidden: false, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    showModal() { this.open = true; }
  };
  const target = { hidden: false, focused: false, focus() { this.focused = true; } };
  const elements = {
    bootstrapDialog: dialog,
    bootstrapFocusTarget: undefined
  };
  const state = { bootstrapFocusTarget: target };
  const view = viewModule.create({
    state,
    external: { host, syncCore: {}, syncStorage: {}, elements: { ...elements, bootstrapDialog: dialog } },
    use: {}
  });
  return { dialog, target, view };
}

test("bootstrap focus uses the shared focus delay and keeps aria-modal", () => {
  const delays = [];
  const fixture = focusFixture(delays);
  fixture.view.focusBootstrapDialog();
  assert.equal(fixture.dialog.attributes["aria-modal"], "true");
  assert.deepEqual(delays, [runtime.TIMING_MS.focusDefer]);
  assert.equal(fixture.target.focused, true);
});

test("delete-account dialog sets aria-modal on creation", () => {
  const source = fs.readFileSync(path.join(__dirname, "app-session.js"), "utf8");
  assert.ok(source.includes('dialog.setAttribute?.("aria-modal", "true")'));
});
