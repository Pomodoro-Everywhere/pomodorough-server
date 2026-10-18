"use strict";

// R50-S03: horizontal fold must not cross the deletion dialog or its input.
// The vertical-segment rule anchors the complete scrollable dialog to the
// first segment's top/bottom bounds plus safe insets instead of only capping
// max-height under viewport centering. Live-browser evidence is recorded in
// scratch/fix-R50-S03.md (960x720 folds at y=400/350, 200% text, unequal
// segments, safe insets, scrolled descendants, Escape/no-DELETE).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appCss = fs.readFileSync(path.join(__dirname, "app.css"), "utf8");
const sessionSource = fs.readFileSync(path.join(__dirname, "app-session.js"), "utf8");
const sessionModule = require("./app-session.js");
const incarnationFixture = require("./test/incarnation-fixture.js");

const REM = 16;

function verticalBlock() {
  const start = appCss.indexOf("@media (vertical-viewport-segments: 2)");
  assert.ok(start >= 0, "vertical segment rule exists");
  return appCss.slice(start);
}

function verticalDialogRule() {
  const block = verticalBlock();
  const match = /\.bootstrap-dialog\s*\{[^}]*\}/.exec(block);
  assert.ok(match, "vertical dialog rule exists");
  return match[0];
}

function dialogRems() {
  const rule = verticalDialogRule();
  const margin = /margin-top:[^;]*\+\s*([0-9.]+)rem/.exec(rule);
  const total = /max-height:[^;]*-\s*([0-9.]+)rem\s*\)/.exec(rule);
  assert.ok(margin && total, "dialog margin/total rems parse from CSS");
  return { marginRem: Number(margin[1]), totalRem: Number(total[1]) };
}

function dialogBounds(segTop, segBottom, safeTop, safeBottom, intrinsic) {
  const { marginRem, totalRem } = dialogRems();
  assert.ok(marginRem > 0 && totalRem >= marginRem, "parsed rems stay positive");
  const marginTop = segTop + safeTop + marginRem * REM;
  const maxHeight = segBottom - segTop - safeTop - safeBottom - totalRem * REM;
  assert.ok(maxHeight > 0, "segment leaves usable height");
  const height = Math.min(intrinsic, maxHeight);
  return { top: marginTop, bottom: marginTop + height, maxHeight };
}

function assertAvoidsStrip(bounds, segTop, segBottom, hinge, safeTop, safeBottom) {
  assert.ok(bounds.top >= segTop + safeTop, "dialog starts inside usable top");
  assert.ok(bounds.bottom <= segBottom - safeBottom, "dialog ends above safe bottom");
  assert.ok(bounds.bottom <= segBottom, `dialog bottom ${bounds.bottom} avoids ${segBottom}..${segBottom + hinge}`);
  assert.ok(bounds.top < segBottom, "dialog sits in first segment");
}

test("R50-S03 vertical dialog anchors with segment top/bottom plus safe insets", () => {
  const rule = verticalDialogRule();
  assert.match(rule, /env\(viewport-segment-top 0 0/);
  assert.match(rule, /env\(viewport-segment-bottom 0 0/);
  assert.match(rule, /env\(safe-area-inset-top/);
  assert.match(rule, /env\(safe-area-inset-bottom/);
  assert.match(rule, /margin-top:\s*calc\(env\(viewport-segment-top 0 0[^;]*\+\s*env\(safe-area-inset-top/);
  assert.match(rule, /margin-bottom:\s*auto/);
  assert.match(rule, /max-height:\s*calc\(env\(viewport-segment-bottom 0 0[^;]*-\s*env\(viewport-segment-top 0 0/);
  const { marginRem, totalRem } = dialogRems();
  assert.equal(marginRem, 1, "parsed top margin stays 1rem");
  assert.equal(totalRem, 2, "parsed height reserve stays 2rem");
  assert.doesNotMatch(rule, /100vh\s*-/);
  assert.doesNotMatch(verticalBlock(), /viewport-segment-gap/);
  assert.doesNotMatch(rule, /400px|420px|350px|370px/);
});

test("R50-S03 dialog and input avoid reported horizontal strips", () => {
  const cases = [
    { segTop: 0, segBottom: 400, hinge: 20, safeTop: 0, safeBottom: 0, intrinsic: 178, label: "400 fold default" },
    { segTop: 0, segBottom: 350, hinge: 20, safeTop: 0, safeBottom: 0, intrinsic: 178, label: "350 fold default" },
    { segTop: 0, segBottom: 350, hinge: 20, safeTop: 0, safeBottom: 0, intrinsic: 286, label: "350 fold 200% text" },
  ];
  for (const item of cases) {
    const bounds = dialogBounds(item.segTop, item.segBottom, item.safeTop, item.safeBottom, item.intrinsic);
    assertAvoidsStrip(bounds, item.segTop, item.segBottom, item.hinge, item.safeTop, item.safeBottom);
    const input = { top: bounds.top + 124, bottom: bounds.top + 149 };
    const buttons = { top: bounds.top + 155, bottom: bounds.top + 172 };
    const text = { top: bounds.top + 20, bottom: bounds.top + 90 };
    for (const [name, rect] of [["input", input], ["buttons", buttons], ["text", text]]) {
      assert.ok(rect.top >= bounds.top && rect.bottom <= bounds.bottom, `${item.label} ${name} inside dialog`);
      assert.ok(rect.bottom <= item.segBottom, `${item.label} ${name} avoids strip`);
    }
  }
});

test("R50-S03 unequal segments and safe insets keep dialog usable", () => {
  const cases = [
    { segTop: 0, segBottom: 280, hinge: 20, safeTop: 0, safeBottom: 0, intrinsic: 178, label: "small top segment" },
    { segTop: 0, segBottom: 500, hinge: 20, safeTop: 0, safeBottom: 0, intrinsic: 286, label: "large top segment" },
    { segTop: 0, segBottom: 400, hinge: 20, safeTop: 47, safeBottom: 34, intrinsic: 178, label: "inset top segment" },
    { segTop: 0, segBottom: 350, hinge: 20, safeTop: 20, safeBottom: 20, intrinsic: 286, label: "inset enlarged text" },
  ];
  for (const item of cases) {
    const bounds = dialogBounds(item.segTop, item.segBottom, item.safeTop, item.safeBottom, item.intrinsic);
    assert.ok(bounds.top >= item.segTop + item.safeTop, `${item.label} top inside safe`);
    assert.ok(bounds.bottom <= item.segBottom - item.safeBottom, `${item.label} bottom above safe`);
    assert.ok(bounds.maxHeight <= item.segBottom - item.segTop, `${item.label} height from segment`);
  }
});

test("R50-S03 scrolled descendants and single-segment fallback stay safe", () => {
  assert.match(appCss, /\.bootstrap-dialog\s*\{[^}]*overflow:\s*auto/);
  assert.match(appCss, /\.bootstrap-dialog-input,\s*\.bootstrap-dialog > input\s*\{[^}]*max-width:\s*100%/);
  assert.match(appCss, /\.bootstrap-dialog-actions,\s*\.bootstrap-dialog > div\s*\{[^}]*flex-wrap:\s*wrap/);
  const bounds = dialogBounds(0, 280, 0, 0, 400);
  assert.ok(bounds.bottom <= 280, "tall content caps at segment, dialog scrolls");
  const scrolled = bounds.top + 300 - 150;
  assert.ok(scrolled >= bounds.top && scrolled <= bounds.bottom, "scrolled child stays in scrollport");
  assert.match(appCss, /\.bootstrap-dialog\s*\{[^}]*max-height:\s*calc\(100vh - env\(safe-area-inset-top/);
  assert.match(verticalDialogRule(), /env\(viewport-segment-bottom 0 0,\s*100vh\)/);
});

function dialogElement(tag) {
  const listeners = new Map();
  return {
    tag, children: [], textContent: "", value: "", open: false, focused: false,
    setAttribute() {}, append(...kids) { this.children.push(...kids); },
    addEventListener(type, callback) { listeners.set(type, callback); },
    fire(type, event) { listeners.get(type)?.(event); },
    showModal() { this.open = true; }, close() { this.open = false; },
    focus() { this.focused = true; },
  };
}

function deleteFixture(overrides = {}) {
  const created = [];
  const document = {
    body: { appended: [], append(node) { this.appended.push(node); } },
    createElement(tag) { const el = dialogElement(tag); created.push(el); return el; },
  };
  const timeouts = [];
  const calls = [];
  const state = {
    authenticated: true, sessionIdentityValidated: true, csrfToken: "csrf",
    user: incarnationFixture.accountUser("user-1"), localOwnerId: incarnationFixture.ownerId("user-1"), ...overrides.state,
  };
  const host = {
    document, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    console: { warn: () => {} }, fetch: async () => ({ ok: true, status: 204 }),
    setTimeout: (callback) => { timeouts.push(callback); return timeouts.length; }, ...overrides.host,
  };
  const use = {
    captureAccountContext: () => incarnationFixture.captureAccountContext(state, host, () => ({})),
    tr: (_key, _values, fallback) => fallback, showNotice: (message) => calls.push(["notice", message]), ...overrides.use,
  };
  const syncCore = { ...incarnationFixture.sync, ...overrides.syncCore };
  const syncStorage = { AccountOwnershipError: incarnationFixture.storage.AccountOwnershipError };
  const elements = { deleteAccountButton: { disabled: false }, ...overrides.elements };
  const actions = sessionModule.create({ state, external: { host, syncCore, syncStorage, elements }, use, emit: () => {} });
  return { actions, calls, host, timeouts, document };
}

test("R50-S03 Escape closes the dialog without sending DELETE", async () => {
  const fixture = deleteFixture();
  await fixture.actions.deleteAccount();
  const dialog = fixture.document.body.appended[0];
  assert.equal(dialog.open, true);
  let fetches = 0;
  fixture.host.fetch = async () => { fetches += 1; return { ok: true }; };
  dialog.fire("cancel");
  assert.equal(dialog.open, false);
  assert.equal(fetches, 0);
  assert.ok(!fixture.calls.some((entry) => entry[0] === "notice" && /Type DELETE/.test(entry[1])));
});

test("R50-S03 wrong phrase never deletes and focus defers to input", async () => {
  const fixture = deleteFixture();
  assert.equal(fixture.actions.accountDeletionConfirmationIsValid("DELETE"), true);
  for (const value of ["", "delete", "DELETE ", " DELETE"]) {
    assert.equal(fixture.actions.accountDeletionConfirmationIsValid(value), false, String(value));
  }
  let fetches = 0;
  fixture.host.fetch = async () => { fetches += 1; return { ok: true }; };
  assert.equal(await fixture.actions.confirmDeleteAccount("delete"), false);
  assert.equal(fetches, 0);
  assert.ok(fixture.calls.some((entry) => entry[0] === "notice" && /Type DELETE exactly/.test(entry[1])));
  await fixture.actions.deleteAccount();
  const dialog = fixture.document.body.appended[0];
  const input = dialog.children[2];
  assert.equal(fixture.timeouts.length, 1);
  fixture.timeouts[0]();
  assert.equal(input.focused, true);
  assert.match(sessionSource, /dialog\.addEventListener\?\.\("cancel", \(\) => this\.cancelDeleteAccount\(\)\)/);
  assert.match(sessionSource, /try \{ this\.deleteAccountDialogRefs\?\.dialog\.close\?\.\(\); \}/);
});

test("R50-S03 preserves R49-S09 width repair and R50-S02 focus rings", () => {
  const start = appCss.indexOf("@media (horizontal-viewport-segments: 2)");
  const next = appCss.indexOf("@media (vertical-viewport-segments: 2)", start);
  const horizontal = appCss.slice(start, next);
  assert.match(horizontal, /env\(viewport-segment-width 0 0/);
  assert.match(horizontal, /margin-left:\s*calc\(env\(viewport-segment-left 0 0/);
  assert.match(appCss, /\.bootstrap-dialog > \* \{[^}]*max-width:\s*100%/);
  assert.match(appCss, /\.action-bank button:focus-visible:not\(\.action-clear\)\s*\{[^}]*inset 0 0 0 3px var\(--porcelain\)/);
  assert.match(appCss, /\.action-bank \.action-primary:focus-visible\s*\{[^}]*5px 5px 0 var\(--signal\)/);
});
