"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const viewModule = require("./app-view.js");

function mockButton(strategy) {
  return {
    dataset: { bootstrapStrategy: strategy },
    hidden: false,
    disabled: false,
    focused: false,
    listeners: new Map(),
    addEventListener(name, callback) { this.listeners.set(name, callback); },
    focus() { this.focused = true; },
  };
}

function mockElement() {
  return {
    children: [],
    hidden: false,
    disabled: false,
    focused: false,
    open: false,
    textContent: "",
    dataset: {},
    listeners: new Map(),
    addEventListener(name, callback) { this.listeners.set(name, callback); },
    close() { this.open = false; },
    focus() { this.focused = true; },
    showModal() { this.open = true; },
    setAttribute() {},
    removeAttribute() {},
  };
}

function cancelFixture({ stateOverrides = {}, dialogView = null } = {}) {
  const keepLocal = mockButton("keep_local");
  const keepRemote = mockButton("keep_remote");
  const state = {
    authenticated: true,
    bootstrapBlocked: true,
    bootstrapConflict: false,
    bootstrapError: null,
    bootstrapFocusTarget: null,
    bootstrapLimitError: null,
    bootstrapOwnershipConfirmation: false,
    bootstrapPending: null,
    bootstrapPlan: { mode: "choose" },
    bootstrapPreview: { revision: 3, history: [] },
    bootstrapStrategy: null,
    bootstrapSubmitting: false,
    logoutRecoveryRequired: false,
    ...stateOverrides,
  };
  const elements = {
    bootstrapCancel: mockElement(),
    bootstrapChoices: mockElement(),
    bootstrapConfirm: mockElement(),
    bootstrapConfirmation: mockElement(),
    bootstrapConfirmationMessage: mockElement(),
    bootstrapConfirmationTitle: mockElement(),
    bootstrapDialog: mockElement(),
    bootstrapError: mockElement(),
    bootstrapRetry: mockElement(),
    bootstrapSignOut: mockElement(),
    bootstrapSummary: mockElement(),
    bootstrapTitle: mockElement(),
    logoutRecovery: mockElement(),
    logoutRecoveryRetry: mockElement(),
    logoutRecoverySignIn: mockElement(),
    bootstrapChoiceButtons: [keepLocal, keepRemote],
  };
  elements.bootstrapDialog.open = true;
  const blurred = { called: false };
  const document = {
    activeElement: null,
    markBlurred() {
      blurred.called = true;
    },
  };
  document.activeElement = { blur() { blurred.called = true; } };
  const host = {
    document,
    navigator: { onLine: true },
    console: { warn() {} },
    addEventListener() {},
    clearTimeout() {},
    setTimeout(callback) { callback(); return 1; },
  };
  const syncCore = {
    bootstrapDialogView: dialogView || (() => ({
      open: true, busy: false, choosing: true, confirming: false, failed: false,
    })),
    completedHistoryCount: () => 0,
    confirmationFor: () => ({ title: "Confirm", message: "Apply?", confirmLabel: "Apply" }),
  };
  const use = {
    chooseBootstrapStrategy() {},
    localBootstrapState: () => ({ history: [] }),
    logout() {},
    retryBootstrapResolution() {},
    tr: (_key, _args, fallback) => fallback,
  };
  const view = viewModule.create({
    state,
    external: { host, syncCore, syncStorage: {}, elements },
    use,
  });
  view.setupBootstrapEvents();
  return { state, elements, view, blurred, keepLocal, keepRemote };
}

function fireCancel(fixture) {
  let prevented = false;
  fixture.elements.bootstrapDialog.listeners.get("cancel")({ preventDefault() { prevented = true; } });
  return prevented;
}

test("Esc in confirming state resets to prior choice", () => {
  const fixture = cancelFixture({ stateOverrides: { bootstrapStrategy: "keep_remote" } });
  assert.equal(fireCancel(fixture), true);
  assert.equal(fixture.state.bootstrapStrategy, null);
  assert.equal(fixture.keepRemote.focused, true);
});

test("Esc with no strategy refocuses first choice without state change", () => {
  const fixture = cancelFixture();
  assert.equal(fireCancel(fixture), true);
  assert.equal(fixture.blurred.called, true);
  assert.equal(fixture.state.bootstrapStrategy, null);
  assert.equal(fixture.keepLocal.focused, true);
});

test("Esc in failed state moves focus to retry and preserves error", () => {
  const fixture = cancelFixture({
    dialogView: () => ({ open: true, busy: false, choosing: false, confirming: false, failed: true }),
    stateOverrides: { bootstrapError: "interrupted" },
  });
  fixture.elements.bootstrapChoiceButtons.forEach((button) => { button.hidden = true; });
  fixture.elements.bootstrapRetry.hidden = false;
  fixture.elements.bootstrapRetry.disabled = false;
  assert.equal(fireCancel(fixture), true);
  assert.equal(fixture.state.bootstrapError, "interrupted");
  assert.equal(fixture.elements.bootstrapRetry.focused, true);
});

test("Esc with pending submission preserves intent and blurs", () => {
  const pending = { userId: "user-1", payload: { strategy: "keep_remote" } };
  const fixture = cancelFixture({
    stateOverrides: { bootstrapStrategy: "keep_remote", bootstrapPending: pending },
  });
  assert.equal(fireCancel(fixture), true);
  assert.equal(fixture.state.bootstrapStrategy, "keep_remote");
  assert.equal(fixture.state.bootstrapPending, pending);
  assert.equal(fixture.blurred.called, true);
});

test("pointer Cancel keeps existing clear-error semantics", () => {
  const fixture = cancelFixture({
    stateOverrides: { bootstrapStrategy: "keep_local", bootstrapError: "stale" },
  });
  fixture.elements.bootstrapCancel.listeners.get("click")();
  assert.equal(fixture.state.bootstrapStrategy, null);
  assert.equal(fixture.state.bootstrapError, null);
});
