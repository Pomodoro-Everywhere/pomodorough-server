"use strict";

// R54-S03: a deferred sign-out must not sign the browser out again after the
// user signs back in. The OAuth callback revokes the session behind the cookie
// it replaces and redirects to the return path only after that succeeds. A
// landing that carries this browser's sign-in token therefore already settled
// the pending server revocation; every other landing still revokes.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { JSDOM } = require("jsdom");
const { IDBFactory } = require("fake-indexeddb");
const { accountUser, ownerId } = require("./test/incarnation-fixture.js");
const { seedMeta, dump, snapshot } = require("./test/account-ownership-fixture.js");

const marker = "pomodoroughPendingLogout";
const companion = "pomodoroughPendingLogoutOwner";
const signInToken = "pomodoroughPendingLogoutSignIn";
const scripts = ["shared-core-metadata.js", "shared-core.js", "sync-core.js", "sync-authority.js", "sync-storage-uuid.js",
  "workspace-core.js", "workspace-transaction.js", "sync-storage.js", "app-runtime.js", "account-operation.js", "app-state.js",
  "app-storage.js", "app-actions.js", "app-sync.js", "app-bootstrap.js", "app-session.js", "app-view.js", "app.js"];
const sources = new Map(scripts.concat("app.html").map((name) => [name, fs.readFileSync(path.join(__dirname, name), "utf8")]));
let core = null;

async function sharedCore(window) {
  if (core) return core;
  const bytes = fs.readFileSync(path.join(__dirname, "pomodorough_core.wasm"));
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), require("./shared-core-metadata.js").sha256);
  core = await window.PomodoroughSharedCore.SharedCore.fromBytes(bytes);
  return core;
}

function pendingMarker(account, token) {
  const storage = { [marker]: "1", [companion]: JSON.stringify({ userId: ownerId(account) }) };
  if (token !== undefined) storage[signInToken] = token;
  return storage;
}

// Wrap the actions of one browser module so a test can fail or observe them.
const moduleObservers = {
  storage: (implementation, control) => {
    const clear = implementation.clearLocalData;
    return { ...implementation, clearLocalData: async (...args) => {
      if (control.cleanupFailures > 0) {
        control.cleanupFailures -= 1;
        control.events.push("data failed");
        throw new Error("Mock local cleanup failed");
      }
      const cleared = await clear(...args);
      control.events.push("data");
      return cleared;
    } };
  },
  bootstrap: (implementation, control) => ({ ...implementation, prepareBootstrap: (...args) => {
    control.bootstrapPreparations += 1;
    return implementation.prepareBootstrap(...args);
  } })
};

function observedModule(browserModule, control) {
  const observe = moduleObservers[browserModule.manifest.name];
  if (!observe) return browserModule;
  return { ...browserModule, create: (dependencies) => observe(browserModule.create(dependencies), control) };
}

function installTabRuntime(window, control) {
  const runtime = window.PomodoroughAppRuntime.createRuntime;
  let application = null;
  window.PomodoroughAppRuntime = { ...window.PomodoroughAppRuntime, createRuntime: (input) => {
    const page = control.location || new URL(control.href);
    const navigate = (kind) => (url) => {
      control.navigations.push([kind, url]);
      control.events.push(`${kind} ${url}`);
    };
    input.externals.host.location = { href: page.href, pathname: page.pathname, search: page.search,
      assign: navigate("assign"), replace: navigate("replace") };
    const builder = runtime(input);
    return { install: (browserModule) => builder.install(observedModule(browserModule, control)),
      finalize() { application = builder.finalize(); return application; } };
  } };
  return () => application;
}

// Records marker and token removals in the order the app makes them.
function recordMarkerRemovals(window, control) {
  const removeItem = window.Storage.prototype.removeItem;
  window.Storage.prototype.removeItem = function (key) {
    if (key === marker) control.events.push("marker");
    if (key === signInToken) control.events.push("token");
    return removeItem.call(this, key);
  };
}

// Starts the real PWA in one browser tab. `indexedDB` and `storage` carry one
// browser's state across tabs and page loads. `location` replaces the page
// location the app reads.
async function openTab(t, { href, indexedDB, storage = {}, account, csrf, cleanupFailures = 0,
  logoutStatus = 204, location = null, webCrypto = crypto.webcrypto }) {
  const dom = new JSDOM(sources.get("app.html"), { url: `https://local.test${href}`, runScripts: "outside-only" });
  const { window } = dom;
  t.after(() => window.close());
  Object.defineProperty(window.navigator, "onLine", { get: () => true });
  Object.defineProperty(window, "crypto", { value: webCrypto });
  Object.assign(window, { indexedDB, TextEncoder, TextDecoder, structuredClone,
    PomodoroughAppTest: { disableAutoStart: true }, confirm: () => true, setInterval: () => 1, clearInterval() {} });
  const warnings = [];
  window.console.warn = (...args) => warnings.push(args);
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, value);
  for (const name of scripts.slice(0, -1)) window.eval(sources.get(name));
  const loaded = await sharedCore(window);
  window.PomodoroughSharedCore.SharedCore.load = async () => loaded;
  const control = { href: window.location.href, location, navigations: [], events: [], requests: [], warnings, cleanupFailures, logoutStatus,
    bootstrapPreparations: 0 };
  recordMarkerRemovals(window, control);
  window.fetch = async (url, input = {}) => {
    control.requests.push({ url, method: input.method || "GET", csrf: input.headers?.["X-CSRF-Token"] ?? null });
    if (url === "/api/v1/me") {
      return { ok: true, status: 200, json: async () => ({ user: accountUser(account), csrfToken: csrf }) };
    }
    if (url === "/api/v1/auth/logout") return { ok: control.logoutStatus === 204, status: control.logoutStatus };
    throw new Error("Mock endpoint unavailable");
  };
  const application = installTabRuntime(window, control);
  window.eval(sources.get("app.js"));
  const use = application().facade(application().describe().flatMap((item) => item.provides));
  return { window, use, control, state: application().state };
}

async function seedAccount(tab, account) {
  const database = await tab.use.openDatabase();
  const operation = { id: `retained-${account}`, deviceId: "shared-device", ownerId: "old-tab", phase: "focus",
    durationMs: 1800000, occurredAt: new Date().toISOString(), hlcWallMs: Date.now(), hlcCounter: 0 };
  await seedMeta(database, { snapshot: snapshot(account), deviceId: "shared-device", deviceSequence: 7,
    hlc: { wallMs: operation.hlcWallMs, counter: 0 }, settings: { selectedPhase: "focus", durationSyncBootstrapped: true,
      autoStartSyncBootstrapped: true, selectedTaskSyncBootstrapped: true },
    projectionPending: { commands: [], taskOperations: [], durationOperations: [operation], autoStartOperations: [], selectedTaskOperations: [] },
    deliveryProof: { commands: [], taskOperations: [], durationOperations: [operation.id], autoStartOperations: [], selectedTaskOperations: [] } });
  const transaction = database.transaction("pendingDurations", "readwrite");
  transaction.objectStore("pendingDurations").put(operation);
  await tab.window.PomodoroughStorage.transactionDone(transaction);
  return database;
}

function storageOf(tab) {
  const storage = tab.window.localStorage;
  return Object.fromEntries(Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .map((key) => [key, storage.getItem(key)]));
}

function markerState(tab) {
  const storage = tab.window.localStorage;
  return [storage.getItem(marker), storage.getItem(companion), storage.getItem(signInToken)];
}

function revocations(tab) {
  return tab.control.requests.filter((request) => request.url === "/api/v1/auth/logout");
}

function loginReturnPath(navigation) {
  assert.equal(navigation?.[0], "assign");
  const url = new URL(navigation[1], "https://local.test");
  assert.equal(url.pathname, "/auth/google/start");
  return url.searchParams.get("return");
}

async function settle() {
  for (let turn = 0; turn < 30; turn += 1) await new Promise(setImmediate);
}

async function waitFor(condition) {
  for (let turn = 0; turn < 2000 && !condition(); turn += 1) await new Promise((resolve) => setTimeout(resolve, 1));
}

async function click(tab, id) {
  tab.window.document.getElementById(id).dispatchEvent(new tab.window.MouseEvent("click", { bubbles: true }));
  await settle();
}

// Deferred sign-out: the revoke request fails, so the marker stays and the
// recovery offers "Sign in to recover".
async function deferredSignOut(t, indexedDB) {
  const tab = await openTab(t, { href: "/app", indexedDB, storage: pendingMarker("account-A"), account: "account-A", csrf: "csrf-S1" });
  await seedAccount(tab, "account-A");
  tab.control.logoutStatus = 503;
  await tab.window.PomodoroughApp.initialize();
  await settle();
  assert.equal(tab.state.logoutRecoveryRequired, true);
  assert.deepEqual(revocations(tab).map((request) => request.csrf), ["csrf-S1"]);
  assert.equal(tab.window.localStorage.getItem(marker), "1");
  await click(tab, "logoutRecoverySignIn");
  assert.equal(tab.control.navigations.length, 1);
  return tab;
}

test("R54-S03 completed re-sign-in after deferred sign-out keeps the new session", async (t) => {
  const indexedDB = new IDBFactory();
  const signedOut = await deferredSignOut(t, indexedDB);
  const returnPath = loginReturnPath(signedOut.control.navigations[0]);

  // The callback revoked S1, set S2 and redirected to the return path.
  const landing = await openTab(t, { href: returnPath, indexedDB, storage: storageOf(signedOut), account: "account-A", csrf: "csrf-S2" });
  await landing.window.PomodoroughApp.initialize();
  await settle();
  assert.deepEqual(revocations(landing), [], "the landing must not revoke the session the user just signed in with");
  const token = signedOut.window.localStorage.getItem(signInToken);
  assert.match(token ?? "", /^[0-9a-f]{32}$/);
  assert.equal(returnPath, `/app?signin=${token}`);
  assert.deepEqual(landing.control.navigations, [["replace", "/app"]]);
  assert.deepEqual(markerState(landing), [null, null, null]);

  const reloaded = await openTab(t, { href: "/app", indexedDB, storage: storageOf(landing), account: "account-A", csrf: "csrf-S2" });
  await reloaded.window.PomodoroughApp.initialize();
  await settle();
  assert.deepEqual(revocations(reloaded), []);
  assert.deepEqual(reloaded.control.navigations, []);
  assert.equal(reloaded.state.authenticated, true);
  assert.equal(reloaded.state.logoutRecoveryRequired, false);
});

// The landing consumed its token, so the same URL proves nothing once a later
// sign-out marks this browser again.
test("R54-S03 replaying a used landing URL after a later sign-out revokes", async (t) => {
  const indexedDB = new IDBFactory();
  const signedOut = await deferredSignOut(t, indexedDB);
  const returnPath = loginReturnPath(signedOut.control.navigations[0]);
  const landing = await openTab(t, { href: returnPath, indexedDB, storage: storageOf(signedOut), account: "account-A", csrf: "csrf-S2" });
  await landing.window.PomodoroughApp.initialize();
  await settle();
  assert.deepEqual(revocations(landing), []);
  assert.deepEqual(markerState(landing), [null, null, null]);

  const reloaded = await openTab(t, { href: "/app", indexedDB, storage: storageOf(landing), account: "account-A", csrf: "csrf-S2" });
  await reloaded.window.PomodoroughApp.initialize();
  await settle();
  reloaded.use.markPendingLogout();
  reloaded.use.redirectToLogin();
  const fresh = reloaded.window.localStorage.getItem(signInToken);
  assert.match(fresh ?? "", /^[0-9a-f]{32}$/);
  assert.notEqual(`/app?signin=${fresh}`, returnPath);

  const replay = await openTab(t, { href: returnPath, indexedDB, storage: storageOf(reloaded), account: "account-A", csrf: "csrf-S3", logoutStatus: 503 });
  await replay.window.PomodoroughApp.initialize();
  await settle();
  assert.deepEqual(revocations(replay).map((request) => request.csrf), ["csrf-S3"]);
  assert.deepEqual(replay.control.navigations, []);
  assert.equal(replay.window.localStorage.getItem(marker), "1");
  assert.equal(replay.window.localStorage.getItem(signInToken), fresh, "a replayed URL must not consume the live token");
});

async function landingAfterCallback(t, { href, storage, account = "account-A", cleanupFailures = 0, seeded = true, logoutStatus = 204 }) {
  const indexedDB = new IDBFactory();
  if (seeded) {
    const seeder = await openTab(t, { href: "/app", indexedDB, storage, account, csrf: "csrf-S2" });
    await seedAccount(seeder, "account-A");
    seeder.use.database()?.close?.();
  }
  const landing = await openTab(t, { href, indexedDB, storage, account, csrf: "csrf-S2", cleanupFailures, logoutStatus });
  await landing.window.PomodoroughApp.initialize();
  await settle();
  return { landing, indexedDB };
}

// A landing without this browser's live token cannot prove that a callback
// revoked the signed-out session, so startup revokes the current one.
for (const [name, href, storage] of [
  ["a plain startup", "/app", pendingMarker("account-A", "token-T")],
  ["a wrong landing token", "/app?signin=token-X", pendingMarker("account-A", "token-T")],
  ["an empty landing token", "/app?signin=", pendingMarker("account-A", "")],
  ["a marker that never minted a token", "/app?signin=token-T", pendingMarker("account-A")]
]) {
  test(`R54-S03 ${name} still revokes the pending sign-out`, async (t) => {
    const { landing } = await landingAfterCallback(t, { href, storage });
    assert.deepEqual(revocations(landing).map((request) => request.csrf), ["csrf-S2"]);
    assert.equal(landing.control.navigations.length, 1);
    assert.equal(loginReturnPath(landing.control.navigations[0]), "/app");
    assert.deepEqual(markerState(landing), [null, null, null]);
  });
}

test("R54-S03 a wrong landing token leaves the live token for its own landing", async (t) => {
  const { landing, indexedDB } = await landingAfterCallback(t, {
    href: "/app?signin=token-X", storage: pendingMarker("account-A", "token-T"), logoutStatus: 503
  });
  assert.deepEqual(revocations(landing).map((request) => request.csrf), ["csrf-S2"]);
  assert.deepEqual(landing.control.navigations, []);
  assert.deepEqual(markerState(landing), ["1", JSON.stringify({ userId: ownerId("account-A") }), "token-T"]);

  const trueLanding = await openTab(t, { href: "/app?signin=token-T", indexedDB, storage: storageOf(landing), account: "account-A", csrf: "csrf-S3" });
  await trueLanding.window.PomodoroughApp.initialize();
  await settle();
  assert.deepEqual(revocations(trueLanding), [], "the mismatch must leave the live token usable");
  assert.deepEqual(trueLanding.control.navigations, [["replace", "/app"]]);
  assert.deepEqual(markerState(trueLanding), [null, null, null]);
});

test("R54-S03 a landing token without a pending marker starts normally", async (t) => {
  const { landing } = await landingAfterCallback(t, {
    href: "/app?signin=token-T", storage: { [signInToken]: "token-T" }, seeded: false
  });
  assert.deepEqual(revocations(landing), []);
  assert.deepEqual(landing.control.navigations, []);
  assert.equal(landing.state.authenticated, true);
});

test("R54-S03 landing keeps unrelated return fields and drops only the token", async (t) => {
  const { landing } = await landingAfterCallback(t, {
    href: "/app/tasks?filter=today&signin=token-T&view=list", storage: pendingMarker("account-A", "token-T")
  });
  assert.deepEqual(revocations(landing), []);
  assert.deepEqual(landing.control.navigations, [["replace", "/app/tasks?filter=today&view=list"]]);
  assert.deepEqual(markerState(landing), [null, null, null]);
});

// Only a field named exactly "signin" carries the landing token. A field whose
// name only ends in "signin" is an unrelated return field and stays byte-exact,
// both on the way to sign-in and on the landing.
test("R54-S03 a field whose name ends in signin is not the landing token", async (t) => {
  const storage = pendingMarker("account-A", "token-T");
  const tab = await openTab(t, { href: "/app/tasks?xsignin=1&view=list", indexedDB: new IDBFactory(), storage, account: "account-A", csrf: "csrf-S1" });
  tab.use.redirectToLogin();
  assert.equal(loginReturnPath(tab.control.navigations[0]), "/app/tasks?xsignin=1&view=list&signin=token-T");

  const { landing } = await landingAfterCallback(t, { href: "/app/tasks?xsignin=1&signin=token-T&view=list", storage });
  assert.deepEqual(revocations(landing), []);
  assert.deepEqual(landing.control.navigations, [["replace", "/app/tasks?xsignin=1&view=list"]]);
  assert.deepEqual(markerState(landing), [null, null, null]);
});

// The landing replaces the page, so startup must not go on as if a session had
// loaded: bootstrap preparation would run against a page that is leaving.
test("R54-S03 a completed landing does not prepare bootstrap", async (t) => {
  const { landing } = await landingAfterCallback(t, { href: "/app?signin=token-T", storage: pendingMarker("account-A", "token-T") });
  assert.deepEqual(landing.control.navigations, [["replace", "/app"]]);
  assert.equal(landing.control.bootstrapPreparations, 0);
  assert.deepEqual(landing.control.requests.map((request) => request.url), ["/api/v1/me"]);
  assert.deepEqual(landing.control.warnings, []);
});

// Between location.replace and unload, a cross-tab sign-out or a 401 still
// reaches the landing page. It is already navigating, so neither may start a
// second sign-in.
test("R54-S03 a completed landing does not start sign-in while it navigates", async (t) => {
  const { landing } = await landingAfterCallback(t, { href: "/app?signin=token-T", storage: pendingMarker("account-A", "token-T") });
  const { window, control } = landing;
  const landed = control.events.length;
  window.dispatchEvent(new window.StorageEvent("storage", { key: marker, newValue: "1" }));
  await waitFor(() => control.events.length > landed);
  await settle();
  assert.equal(control.events[landed], "data", "the cross-tab sign-out must reach the landing");
  landing.use.redirectToLogin();
  assert.deepEqual(control.navigations, [["replace", "/app"]]);
});

// Startup clears signed-out data once before the session check and once in the
// landing. The landing consumes its token between the two.
test("R54-S03 landing clears local data, then the marker, then the URL", async (t) => {
  const { landing } = await landingAfterCallback(t, {
    href: "/app?signin=token-T", storage: pendingMarker("account-A", "token-T")
  });
  assert.deepEqual(revocations(landing), []);
  assert.deepEqual(landing.control.events, ["data", "token", "data", "marker", "token", "replace /app"]);
});

// Two failures leave nothing cleared. The landing already consumed its token,
// so the retry cannot reuse it and takes the revoke path.
test("R54-S03 failed landing cleanup keeps the marker and URL, and the retry revokes", async (t) => {
  const { landing, indexedDB } = await landingAfterCallback(t, {
    href: "/app?signin=token-T", storage: pendingMarker("account-A", "token-T"), cleanupFailures: 2
  });
  assert.deepEqual(revocations(landing), []);
  assert.deepEqual(landing.control.events, ["data failed", "token", "data failed"], "a failed cleanup must not strip the URL");
  assert.equal(landing.state.logoutRecoveryRequired, true);
  assert.deepEqual(markerState(landing), ["1", JSON.stringify({ userId: ownerId("account-A") }), null]);
  const retained = await openTab(t, { href: "/app", indexedDB, account: "account-A", csrf: "csrf-S2" });
  const database = await retained.use.openDatabase();
  assert.equal((await dump(database)).pendingDurations.length, 1);
  database.close();

  await click(landing, "logoutRecoveryRetry");
  await waitFor(() => landing.control.navigations.length > 0);
  assert.deepEqual(revocations(landing).map((request) => request.csrf), ["csrf-S2"]);
  assert.equal(landing.control.navigations.length, 1);
  assert.equal(loginReturnPath(landing.control.navigations[0]), "/app");
  assert.deepEqual(markerState(landing), [null, null, null]);
});

test("R54-S03 landing as another account clears the signed-out account without revoking", async (t) => {
  const { landing, indexedDB } = await landingAfterCallback(t, {
    href: "/app?signin=token-T", storage: pendingMarker("account-A", "token-T"), account: "account-B"
  });
  assert.deepEqual(revocations(landing), []);
  assert.deepEqual(landing.control.navigations, [["replace", "/app"]]);
  assert.deepEqual(markerState(landing), [null, null, null]);
  const reloaded = await openTab(t, { href: "/app", indexedDB, account: "account-B", csrf: "csrf-S2" });
  await reloaded.window.PomodoroughApp.initialize();
  await settle();
  assert.deepEqual(revocations(reloaded), []);
  assert.equal(reloaded.state.authenticated, true);
  assert.equal((await dump(reloaded.use.database())).pendingDurations.length, 0);
});

test("R54-S03 one sign-in token serves the marker until a landing consumes it", async (t) => {
  const storage = pendingMarker("account-A", "token-T");
  const tab = await openTab(t, { href: "/app/tasks?filter=today&signin=stale", indexedDB: new IDBFactory(), storage, account: "account-A", csrf: "csrf-S1" });
  tab.use.redirectToLogin();
  assert.equal(loginReturnPath(tab.control.navigations[0]), "/app/tasks?filter=today&signin=token-T");

  tab.window.localStorage.removeItem(signInToken);
  const minted = await openTab(t, { href: "/app", indexedDB: new IDBFactory(), storage: storageOf(tab), account: "account-A", csrf: "csrf-S1" });
  minted.use.redirectToLogin();
  const token = minted.window.localStorage.getItem(signInToken);
  assert.match(token ?? "", /^[0-9a-f]{32}$/);
  const again = await openTab(t, { href: "/app", indexedDB: new IDBFactory(), storage: storageOf(minted), account: "account-A", csrf: "csrf-S1" });
  again.use.redirectToLogin();
  assert.equal(loginReturnPath(again.control.navigations[0]), `/app?signin=${token}`);

  again.use.markPendingLogout();
  assert.equal(again.window.localStorage.getItem(signInToken), null);
  again.window.localStorage.setItem(signInToken, "token-T");
  again.use.clearPendingLogout();
  assert.deepEqual(markerState(again), [null, null, null]);
});

test("R54-S03 the landing token is 16 bytes from crypto.getRandomValues", async (t) => {
  const draws = [];
  // Shared-core verification and tab ids still use the real Web Crypto.
  const webCrypto = { subtle: crypto.webcrypto.subtle, randomUUID: () => crypto.randomUUID(), getRandomValues(bytes) {
    draws.push(bytes.length);
    bytes.fill(0x0a);
    return bytes;
  } };
  const tab = await openTab(t, { href: "/app", indexedDB: new IDBFactory(), storage: pendingMarker("account-A"), account: "account-A", csrf: "csrf-S1", webCrypto });
  tab.use.redirectToLogin();
  assert.deepEqual(draws, [16]);
  // Every byte keeps its two hex digits, so the token is 32 characters.
  assert.equal(tab.window.localStorage.getItem(signInToken), "0a".repeat(16));
  assert.equal(loginReturnPath(tab.control.navigations[0]), `/app?signin=${"0a".repeat(16)}`);
});

test("R54-S03 without crypto.getRandomValues sign-in carries no token", async (t) => {
  // Storage and tab ids still need distinct UUIDs.
  const webCrypto = { subtle: crypto.webcrypto.subtle, randomUUID: () => crypto.randomUUID() };
  const tab = await openTab(t, { href: "/app", indexedDB: new IDBFactory(), storage: pendingMarker("account-A"), account: "account-A", csrf: "csrf-S1", webCrypto });
  tab.use.redirectToLogin();
  assert.equal(loginReturnPath(tab.control.navigations[0]), "/app");
  assert.equal(tab.window.localStorage.getItem(signInToken), null);
  assert.deepEqual(tab.control.warnings, [], "a missing CSPRNG is not a marker storage failure");

  // Without a token the landing cannot prove the callback ran, so it revokes as before.
  const landing = await openTab(t, { href: "/app", indexedDB: new IDBFactory(), storage: storageOf(tab), account: "account-A", csrf: "csrf-S2", webCrypto });
  await landing.window.PomodoroughApp.initialize();
  await settle();
  assert.deepEqual(revocations(landing).map((request) => request.csrf), ["csrf-S2"]);
  assert.equal(loginReturnPath(landing.control.navigations[0]), "/app");
  assert.deepEqual(markerState(landing), [null, null, null]);
});

test("R54-S03 sign-in without a pending marker carries no token", async (t) => {
  const tab = await openTab(t, { href: "/app?signin=stale&view=list", indexedDB: new IDBFactory(), account: "account-A", csrf: "csrf-S1" });
  tab.use.redirectToLogin();
  assert.equal(loginReturnPath(tab.control.navigations[0]), "/app?view=list");
  assert.equal(tab.window.localStorage.getItem(signInToken), null);
});

test("R54-S03 a return path too long for the token returns to the app root with it", async (t) => {
  const href = `/app/tasks?filter=${"x".repeat(1000)}`;
  const tab = await openTab(t, { href, indexedDB: new IDBFactory(), storage: pendingMarker("account-A", "token-T"), account: "account-A", csrf: "csrf-S1" });
  tab.use.redirectToLogin();
  assert.equal(loginReturnPath(tab.control.navigations[0]), "/app?signin=token-T");
});

// Return paths stay same-origin and path-only once the token joins the query.
// An unsafe path falls back to the app root, which still carries the token.
for (const [name, location, stored, expected] of [
  ["a protocol-relative path", { pathname: "//evil.example/app", search: "?signin=x" }, "token-T", "/app?signin=token-T"],
  ["an absolute URL path", { pathname: "https://evil.example/app", search: "?signin=x" }, "token-T", "/app?signin=token-T"],
  ["an absolute URL keeps only its path", { href: "https://evil.example/app/tasks?signin=x" }, "token-T", "/app/tasks?signin=token-T"],
  ["a backslash path", { pathname: "/app\\evil", search: "?signin=x" }, "token-T", "/app?signin=token-T"],
  ["a backslash query", { pathname: "/app", search: "?next=\\evil&signin=x" }, "token-T", "/app?signin=token-T"],
  ["a stored token that breaks the path", { pathname: "/app", search: "" }, "token\\T", "/app"]
]) {
  test(`R54-S03 sign-in refuses ${name}`, async (t) => {
    const tab = await openTab(t, { href: "/app", indexedDB: new IDBFactory(), storage: pendingMarker("account-A", stored), account: "account-A", csrf: "csrf-S1", location });
    tab.use.redirectToLogin();
    assert.equal(loginReturnPath(tab.control.navigations[0]), expected);
  });
}

// Storage that cannot read or consume the token fails closed.
for (const method of ["getItem", "removeItem"]) {
  test(`R54-S03 a sign-in token that fails ${method} revokes`, async (t) => {
    const storage = pendingMarker("account-A", "token-T");
    const indexedDB = new IDBFactory();
    const seeder = await openTab(t, { href: "/app", indexedDB, storage, account: "account-A", csrf: "csrf-S2" });
    await seedAccount(seeder, "account-A");
    seeder.use.database()?.close?.();
    const landing = await openTab(t, { href: "/app?signin=token-T", indexedDB, storage, account: "account-A", csrf: "csrf-S2" });
    const original = landing.window.Storage.prototype[method];
    landing.window.Storage.prototype[method] = function (key, ...rest) {
      if (key === signInToken) throw new landing.window.DOMException("Mock storage failed", "SecurityError");
      return original.call(this, key, ...rest);
    };
    await landing.window.PomodoroughApp.initialize();
    await settle();
    landing.window.Storage.prototype[method] = original;
    assert.deepEqual(revocations(landing).map((request) => request.csrf), ["csrf-S2"]);
    assert.equal(landing.control.navigations[0]?.[0], "assign");
  });
}
