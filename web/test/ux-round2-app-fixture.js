"use strict";

// Starts the real PWA (every production script and app.html) in jsdom for the
// UX round 2 regression tests. The server is a stub: nothing leaves the process.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { JSDOM } = require("jsdom");
const { IDBFactory } = require("fake-indexeddb");
const { accountUser } = require("./incarnation-fixture.js");
const { nowMs, snapshot } = require("./account-ownership-fixture.js");

const webRoot = path.join(__dirname, "..");
const scripts = ["shared-core-metadata.js", "shared-core.js", "sync-core.js", "sync-authority.js", "sync-storage-uuid.js",
  "workspace-core.js", "workspace-transaction.js", "sync-storage.js", "app-runtime.js", "account-operation.js", "app-state.js",
  "app-storage.js", "app-actions.js", "app-sync.js", "app-bootstrap.js", "app-session.js", "app-view.js", "app.js"];
const sources = new Map(scripts.concat("app.html").map((name) => [name, fs.readFileSync(path.join(webRoot, name), "utf8")]));
let core = null;

async function sharedCore(window) {
  if (core) return core;
  core = await window.PomodoroughSharedCore.SharedCore.fromBytes(fs.readFileSync(path.join(webRoot, "pomodorough_core.wasm")));
  return core;
}

// The server's history for an account with no history yet.
function remoteHistory(account) {
  const payload = { ...snapshot(account), revision: 0, accountIncarnation: accountUser(account).accountIncarnation,
    serverHlcWallMs: nowMs, serverHlcCounter: 0, acknowledgements: [], taskAcknowledgements: [],
    durationAcknowledgements: [], autoStartAcknowledgements: [], selectedTaskAcknowledgements: [] };
  delete payload.user;
  return payload;
}

// `control.online` is what navigator.onLine reports; an offline fetch fails the
// way a browser's does. `control.meStatus` is the session check's HTTP status.
// `control.accountDeleteStatus` is the account deletion request's HTTP status.
// `control.historyResolveStatus` is the history resolution's HTTP status: the
// workspace stays blocked until a resolution succeeds.
function serve(control, account) {
  return async (url, input = {}) => {
    control.requests.push({ url, method: input.method || "GET" });
    if (!control.online) throw new TypeError("Failed to fetch");
    if (url === "/api/v1/me") {
      if (control.meStatus !== 200) return { ok: false, status: control.meStatus };
      return { ok: true, status: 200, json: async () => ({ user: accountUser(account), csrfToken: "csrf-ux" }) };
    }
    if (url === "/api/v1/auth/logout") return { ok: false, status: 503 };
    if (url === "/api/v1/account") return { ok: control.accountDeleteStatus === 200, status: control.accountDeleteStatus };
    if (url === "/api/v1/bootstrap") return { ok: true, status: 200, json: async () => remoteHistory(account) };
    if (url === "/api/v1/bootstrap/resolve" && control.historyResolveStatus === 200) {
      return { ok: true, status: 200, json: async () => remoteHistory(account) };
    }
    return { ok: false, status: 503 };
  };
}

function prepareWindow(window, control, storage, indexedDB) {
  Object.defineProperty(window.navigator, "onLine", { get: () => control.online });
  Object.defineProperty(window, "crypto", { value: crypto.webcrypto });
  Object.assign(window, { indexedDB, TextEncoder, TextDecoder, structuredClone,
    PomodoroughAppTest: { disableAutoStart: true }, confirm: () => true, setInterval: () => 1, clearInterval() {} });
  window.console.warn = (message, error) => control.warnings.push([message, error]);
  window.PomodoroughSentryClient = { reportFrontendError: (error, operation) => control.reports.push([error, operation]) };
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, value);
}

async function settle(turns = 30) {
  for (let turn = 0; turn < turns; turn += 1) await new Promise(setImmediate);
}

async function waitFor(check, label, rounds = 5000) {
  for (let round = 0; round < rounds; round += 1) {
    if (check()) return;
    await new Promise(setImmediate);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// `prepare(window)` runs after the production modules load and before the app
// starts, so a test can install a browser API jsdom lacks. A second app opened
// with the first one's `indexedDB`, `tabId` and local storage is that tab after
// a reload; a different `tabId` makes it another tab of the same browser. A
// reload with unsynchronized operations is not supported here (the stub
// server's history does not match them); the Chromium legs cover that.
async function openApp(t, { online = true, meStatus = 200, storage = {}, account = "account-A", prepare = () => {},
  indexedDB = new IDBFactory(), tabId = null, historyResolveStatus = 503 } = {}) {
  const dom = new JSDOM(sources.get("app.html"), { url: "https://local.test/app", runScripts: "outside-only" });
  const { window } = dom;
  t.after(() => window.close());
  const control = { requests: [], warnings: [], reports: [], online, meStatus, accountDeleteStatus: 503, historyResolveStatus };
  prepareWindow(window, control, storage, indexedDB);
  if (tabId) window.sessionStorage.setItem("pomodoroughTabId", tabId);
  for (const name of scripts.slice(0, -1)) window.eval(sources.get(name));
  const loaded = await sharedCore(window);
  window.PomodoroughSharedCore.SharedCore.load = async () => loaded;
  const runtime = window.PomodoroughAppRuntime.createRuntime;
  window.PomodoroughAppRuntime = { ...window.PomodoroughAppRuntime, createRuntime: (input) => {
    input.externals.host.location = { href: window.location.href, pathname: "/app", search: "", assign() {}, replace() {} };
    return runtime(input);
  } };
  window.fetch = serve(control, account);
  prepare(window);
  window.eval(sources.get("app.js"));
  await window.PomodoroughApp.initialize();
  await settle();
  const app = window.PomodoroughAppTest;
  return { window, document: window.document, control, app, state: app.state,
    element: (id) => window.document.getElementById(id) };
}

// What the page shows in the notice, or null while the notice is hidden.
function shownNotice(current) {
  const notice = current.element("notice");
  if (notice.hidden) return null;
  return { text: current.element("noticeText").textContent, retry: current.element("noticeRetry")?.hidden === false };
}

module.exports = { openApp, settle, waitFor, shownNotice };
