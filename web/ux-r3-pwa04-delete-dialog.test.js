"use strict";

// PWA-04: the account deletion dialog is a form, so Enter confirms; the typed
// word has a visible label; a wrong word keeps the dialog open with the error
// beside the field; and the confirm button carries the destructive style.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const sessionModule = require("./app-session.js");
const incarnationFixture = require("./test/incarnation-fixture.js");

const appCss = fs.readFileSync(path.join(__dirname, "app.css"), "utf8");

function deletionDialogFixture() {
  const dom = new JSDOM("<!doctype html><body></body>");
  const { document } = dom.window;
  const proto = dom.window.HTMLDialogElement.prototype;
  if (typeof proto.showModal !== "function") proto.showModal = function () { this.setAttribute("open", ""); };
  if (typeof proto.close !== "function") proto.close = function () { this.removeAttribute("open"); };
  const notices = [];
  const fetches = [];
  const database = {};
  const state = {
    authenticated: true, sessionIdentityValidated: true, csrfToken: "csrf",
    user: incarnationFixture.accountUser("user-1"), localOwnerId: incarnationFixture.ownerId("user-1"),
  };
  const host = {
    document, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    console: { warn: () => {} },
    fetch: async (url) => { fetches.push(url); return { ok: false, status: 500 }; },
    setTimeout: (callback) => { callback(); return 1; },
  };
  const use = {
    captureAccountContext: () => incarnationFixture.captureAccountContext(state, host, () => database),
    tr: (_key, _values, fallback) => fallback,
    showNotice: (message) => notices.push(message),
  };
  const actions = sessionModule.create({
    state, use, emit: () => {},
    external: {
      host, syncCore: { ...incarnationFixture.sync },
      syncStorage: { AccountOwnershipError: incarnationFixture.storage.AccountOwnershipError },
      elements: { deleteAccountButton: { disabled: false } },
    },
  });
  return { actions, document, notices, fetches };
}

function submitWithEnter(document) {
  const form = document.querySelector("dialog form");
  form.requestSubmit();
}

test("PWA-04 deletion dialog field has a visible label and Enter submits the form", async () => {
  const fixture = deletionDialogFixture();
  await fixture.actions.deleteAccount();
  const dialog = fixture.document.querySelector("dialog.confirmation-dialog");
  assert.ok(dialog, "dialog exists");
  assert.equal(dialog.open, true);
  const input = dialog.querySelector("input.bootstrap-dialog-input");
  const label = input.closest("label");
  assert.ok(label, "input sits inside a label");
  assert.equal(label.querySelector(".confirmation-field-label").textContent, "Type DELETE");
  assert.equal(input.getAttribute("aria-label"), null, "visible label replaces the aria-label");
  const confirm = dialog.querySelector("button.confirmation-danger");
  assert.equal(confirm.type, "submit");
  assert.equal(confirm.textContent, "Delete account");
  input.value = "DELETE";
  submitWithEnter(fixture.document);
  await new Promise((resolve) => setImmediate(resolve));
  // The fixture has no storage, so the request fails after validation. That
  // failure notice proves Enter passed the typed word to the deletion path.
  assert.equal(dialog.open, false);
  assert.deepEqual(fixture.notices, ["Account deletion failed. Your local data was kept."]);
});

test("PWA-04 wrong word keeps the dialog open with the error beside the field", async () => {
  const fixture = deletionDialogFixture();
  await fixture.actions.deleteAccount();
  const dialog = fixture.document.querySelector("dialog");
  const input = dialog.querySelector("input");
  const error = dialog.querySelector(".confirmation-error");
  assert.equal(error.hidden, true);
  input.value = "delete";
  submitWithEnter(fixture.document);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dialog.open, true, "dialog stays open");
  assert.equal(fixture.fetches.length, 0);
  assert.equal(error.hidden, false);
  assert.match(error.textContent, /Type DELETE exactly/);
  assert.equal(error.getAttribute("role"), "alert");
  assert.equal(input.getAttribute("aria-invalid"), "true");
  assert.match(input.getAttribute("aria-describedby"), new RegExp(error.id));
  assert.deepEqual(fixture.notices, [], "no off-screen page notice");
  await fixture.actions.deleteAccount();
  assert.equal(error.hidden, true, "reopening clears the old error");
  assert.equal(input.getAttribute("aria-invalid"), null);
});

test("PWA-04 deletion dialog styles field, error, and destructive confirm", () => {
  assert.match(appCss, /\.confirmation-field \.bootstrap-dialog-input \{[^}]*min-height:\s*2\.75rem/);
  assert.match(appCss, /\.confirmation-field \.bootstrap-dialog-input \{[^}]*padding:/);
  assert.match(appCss, /\.confirmation-danger \{[^}]*background:\s*var\(--danger\)/);
  assert.match(appCss, /\.bootstrap-ticket > \.confirmation-error \{[^}]*color:\s*var\(--danger\)/);
});
