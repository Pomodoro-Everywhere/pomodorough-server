"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const incarnationFixture = require("./test/incarnation-fixture.js");
const sessionModule = require("./app-session.js");

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    values,
  };
}

function sessionState(overrides = {}) {
  return {
    authenticated: true, sessionIdentityValidated: true, csrfToken: "csrf-original",
    user: incarnationFixture.accountUser("user-1"), localOwnerId: incarnationFixture.ownerId("user-1"),
    bootstrapGateOwned: false, bootstrapPending: null, bootstrapBlocked: false,
    quarantinedLocal: null, ready: true, retrying: false, syncing: false, offlineOwnerMode: false,
    pending: [], pendingTaskOperations: [], pendingDurationOperations: [],
    pendingAutoStartOperations: [], pendingSelectedTaskOperations: [], ...overrides,
  };
}

function sessionFixture(overrides = {}) {
  const state = sessionState(overrides.state);
  let database = {};
  const calls = [];
  const localStorage = overrides.localStorage || memoryStorage();
  const host = {
    crypto: require("node:crypto").webcrypto,
    navigator: { onLine: true }, localStorage,
    location: { assign: (value) => calls.push(["assign", value]) },
    console: { warn: (...args) => calls.push(["warn", ...args]) },
    fetch: async () => ({ ok: true, status: 204 }),
    setTimeout: (callback) => { calls.push("timeout"); return 1; },
    document: { createElement: () => null, body: { append: () => {} } },
    confirm: () => true,
    EventSource: class { addEventListener() {} close() {} },
    ...overrides.host,
  };
  const syncCore = { ...incarnationFixture.sync, ...overrides.syncCore };
  const syncStorage = {
    AccountOwnershipError: incarnationFixture.storage.AccountOwnershipError,
    readAccountBinding: async () => ({ sourceOwnerId: state.localOwnerId, gateOwnerId: null }),
    guardedMutation: async () => {},
    allocateClockRequestSequence: async () => 1,
    clearBootstrapGate: async () => {},
    ...overrides.syncStorage,
  };
  const cleanup = require("./app-storage.js").create({ state, external: { host, syncCore, syncStorage }, use: {} });
  const use = {
    captureAccountContext: () => incarnationFixture.captureAccountContext(state, host, () => database),
    cleanupIdentity: cleanup.cleanupIdentity,
    assertCleanupIdentity: cleanup.assertCleanupIdentity,
    database: () => database, tabId: () => "tab-1",
    needsBootstrapResolution: () => false,
    clearLocalData: async () => {
      calls.push("clear"); database = null;
      return incarnationFixture.captureAccountContext(state, host, () => database);
    },
    tr: (_k, _v, fallback) => fallback,
    render: () => calls.push("render"), renderProfile: () => {},
    renderSyncStatus: () => {}, showNotice: (v) => calls.push(["notice", v]),
    quarantineOwnerState: () => {}, restoreOwnerState: () => {},
    restartBootstrapForCurrentAccount: async () => {},
    prepareBootstrap: async () => {}, syncNow: async () => {},
    scheduleSync: () => {}, scheduleRetry: () => {},
    resetSyncRetry: () => {}, refreshAllPendingOperations: async () => {},
    ...overrides.use,
  };
  const elements = { deleteAccountButton: { disabled: false }, logoutButton: { disabled: false } };
  const actions = sessionModule.create({ state, external: { host, syncCore, syncStorage, elements }, use,
    emit: () => {} });
  return { actions, calls, elements, host, localStorage, state, syncCore, use, getDatabase: () => database };
}

test("R48-S03 persists account-bound attempt with original CSRF before DELETE", async () => {
  const seen = [];
  const localStorage = memoryStorage();
  const fixture = sessionFixture({ localStorage, host: { fetch: async (url, init) => {
    const { attemptId, ...attempt } = JSON.parse(localStorage.getItem("pomodoroughPendingDeletion"));
    assert.match(attemptId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(attempt, { userId: incarnationFixture.ownerId("user-1"), csrfToken: "csrf-original", stage: "issued" });
    seen.push({ url, init }); return { ok: true, status: 204 };
  } } });
  assert.equal(await fixture.actions.deleteAccount("DELETE"), true);
  const raw = fixture.localStorage.getItem("pomodoroughPendingDeletion");
  assert.equal(raw, null);
  assert.equal(seen[0].url, "/api/v1/account");
  assert.equal(seen[0].init.headers["X-CSRF-Token"], "csrf-original");
  assert.ok(seen[0].init.headers["X-Pomodorough-Account-Incarnation"]);
  assert.equal(fixture.calls.filter((c) => c === "clear").length, 1);
});

test("R48-S03 lost DELETE response keeps marker and never falsely confirms", async () => {
  const fixture = sessionFixture({ host: { fetch: async () => { throw new Error("Failed to fetch"); } } });
  assert.equal(await fixture.actions.deleteAccount("DELETE"), false);
  const attempt = JSON.parse(fixture.localStorage.getItem("pomodoroughPendingDeletion"));
  assert.equal(attempt.csrfToken, "csrf-original");
  assert.equal(attempt.userId, incarnationFixture.ownerId("user-1"));
  assert.equal(fixture.calls.includes("clear"), false);
  assert.equal(fixture.elements.deleteAccountButton.disabled, false);
});

test("R48-S03 5xx keeps marker while definitive rejection clears without cleanup", async () => {
  const ambiguous = sessionFixture({ host: { fetch: async () => ({ ok: false, status: 503 }) } });
  assert.equal(await ambiguous.actions.deleteAccount("DELETE"), false);
  assert.ok(ambiguous.localStorage.getItem("pomodoroughPendingDeletion") !== null);
  assert.equal(ambiguous.calls.includes("clear"), false);
  for (const status of [400, 401, 403]) {
    const definitive = sessionFixture({ host: { fetch: async () => ({ ok: false, status }) } });
    assert.equal(await definitive.actions.deleteAccount("DELETE"), false);
    assert.equal(definitive.localStorage.getItem("pomodoroughPendingDeletion"), null);
    assert.equal(definitive.calls.includes("clear"), false);
  }
});

test("R48-S03 restart replays original receipt before ordinary session and cleans atomically", async () => {
  const shared = memoryStorage();
  const first = sessionFixture({ localStorage: shared, host: { fetch: async () => { throw new Error("abort"); } } });
  assert.equal(await first.actions.deleteAccount("DELETE"), false);
  assert.ok(shared.getItem("pomodoroughPendingDeletion") !== null);
  const order = [];
  const second = sessionFixture({ localStorage: shared, host: { fetch: async (url) => {
    order.push(url);
    if (url === "/api/v1/account") return { ok: true, status: 204 };
    return { ok: true, status: 200, json: async () => ({ user: incarnationFixture.accountUser("user-1"), csrfToken: "new" }) };
  } } });
  assert.equal(await second.actions.loadSession(), false);
  assert.deepEqual(order[0], "/api/v1/account");
  assert.equal(second.calls.includes("clear"), true);
  assert.equal(shared.getItem("pomodoroughPendingDeletion"), null);
  assert.equal(shared.getItem("pomodoroughPendingLogout"), null);
  assert.ok(second.calls.some((c) => Array.isArray(c) && c[0] === "assign"));
});

test("R48-S03 another account never clears unrelated state", async () => {
  const shared = memoryStorage({ pomodoroughPendingDeletion: JSON.stringify({
    userId: incarnationFixture.ownerId("user-1"), csrfToken: "csrf-original" }) });
  const seen = [];
  const other = sessionFixture({ localStorage: shared,
    state: { user: incarnationFixture.accountUser("user-2"), localOwnerId: incarnationFixture.ownerId("user-2") },
    host: { fetch: async (url) => {
      seen.push(url);
      return { ok: true, status: 200, json: async () => ({ user: incarnationFixture.accountUser("user-2"), csrfToken: "new" }) };
    } } });
  assert.equal(await other.actions.loadSession(), true);
  assert.equal(seen.includes("/api/v1/account"), false);
  assert.equal(other.calls.includes("clear"), false);
  assert.ok(shared.getItem("pomodoroughPendingDeletion") !== null);
});

test("R48-S03 storage abort retains markers without false confirmation", async () => {
  const fixture = sessionFixture({ host: { fetch: async () => ({ ok: true, status: 204 }) },
    use: { clearLocalData: async () => { throw new Error("disk full"); } } });
  assert.equal(await fixture.actions.deleteAccount("DELETE"), true);
  assert.equal(fixture.localStorage.getItem("pomodoroughPendingLogout"), "1");
  assert.ok(fixture.localStorage.getItem("pomodoroughPendingDeletion") !== null);
});

function markerReporting(t) {
  const previousReporter = globalThis.PomodoroughSentryClient;
  const client = require("./sentry-client.js");
  const saved = Object.fromEntries(["Sentry", "document", "PomodoroughSentryClient"]
    .map((name) => [name, globalThis[name]]));
  saved.PomodoroughSentryClient = previousReporter;
  const events = [];
  globalThis.document = { querySelector: (selector) => selector.includes("sentry-dsn")
    ? { content: "https://public@example.invalid/1" } : null };
  globalThis.Sentry = { captureException: (error, context) => events.push({
    name: error.name, message: error.message, context
  }) };
  globalThis.PomodoroughSentryClient = client;
  client.resetFrontendErrorRateLimitForTest();
  t.after(() => {
    client.resetFrontendErrorRateLimitForTest();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  });
  return events;
}

for (const name of ["QuotaExceededError", "SecurityError", "private-owner-csrf-task-name"]) {
  test(`R49-S01 ${name} refuses transport and bounds sanitized diagnostics`, async (t) => {
    const events = markerReporting(t);
    const localStorage = memoryStorage({ unrelated: "keep" });
    const write = localStorage.setItem;
    let blocked = true;
    localStorage.setItem = (key, value) => {
      if (blocked && key === "pomodoroughPendingDeletion") {
        throw Object.assign(new Error("private-owner-csrf-task-message"), { name });
      }
      return write(key, value);
    };
    let deletes = 0;
    const fixture = sessionFixture({ localStorage,
      state: { pendingTaskOperations: [{ id: "retained-task" }] },
      host: { fetch: async () => { deletes += 1; return { ok: true, status: 204 }; } } });
    const before = structuredClone(fixture.state);
    for (let index = 0; index < 20; index += 1) {
      assert.equal(await fixture.actions.deleteAccount("DELETE"), false);
    }
    assert.equal(deletes, 0);
    assert.deepEqual(fixture.state, before);
    assert.deepEqual([...localStorage.values], [["unrelated", "keep"]]);
    assert.equal(fixture.calls.includes("clear"), false);
    assert.equal(fixture.calls.some((call) => call[0] === "assign"), false);
    assert.equal(fixture.elements.deleteAccountButton.disabled, false);
    assert.ok(fixture.calls.some((call) => call[0] === "notice" && /recovery information/.test(call[1])));
    assert.equal(fixture.calls.filter((call) => call[0] === "warn").length, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].name, name.startsWith("private") ? "StorageError" : name);
    assert.equal(events[0].message, "session.delete-account.marker-write-failed");
    assert.equal(events[0].context.tags["error.operation"], events[0].message);
    assert.doesNotMatch(JSON.stringify([events, fixture.calls]), /private-owner|csrf-original|account:v1:/);
    blocked = false;
    assert.equal(await fixture.actions.deleteAccount("DELETE"), true);
    assert.equal(deletes, 1);
  });
}

for (const mode of ["ignored-write", "changed-readback", "denied-readback"]) {
  test(`R49-S01 ${mode} refuses DELETE despite successful setItem return`, async () => {
    const localStorage = memoryStorage();
    const read = localStorage.getItem;
    if (mode === "ignored-write") localStorage.setItem = () => {};
    else localStorage.getItem = (key) => {
      if (key !== "pomodoroughPendingDeletion") return read(key);
      if (mode === "denied-readback") throw new DOMException("denied", "SecurityError");
      return JSON.stringify({ userId: incarnationFixture.ownerId("user-2"), csrfToken: "other" });
    };
    let deletes = 0;
    const fixture = sessionFixture({ localStorage,
      host: { fetch: async () => { deletes += 1; return { ok: true, status: 204 }; } } });
    assert.equal(await fixture.actions.deleteAccount("DELETE"), false);
    assert.equal(deletes, 0);
    assert.equal(fixture.calls.includes("clear"), false);
    assert.equal(fixture.elements.deleteAccountButton.disabled, false);
  });
}

function retainedSession(localStorage, requests) {
  return sessionFixture({ localStorage, state: { pendingTaskOperations: [{ id: "retained-task" }] },
    host: { fetch: async (url) => {
      requests.push(url);
      if (url === "/api/v1/account") return { ok: true, status: 204 };
      return { ok: true, status: 200, json: async () => ({
        user: incarnationFixture.accountUser("user-1"), csrfToken: "csrf-original"
      }) };
    } } });
}

for (const mode of ["denied-readback", "changed-readback", "crash-after-candidate", "crash-after-readback", "promotion-quota"]) {
  test(`R49-S01 ${mode} leaves an inert candidate across restart even when removal fails`, async () => {
    const localStorage = memoryStorage();
    const read = localStorage.getItem;
    const write = localStorage.setItem;
    localStorage.removeItem = () => { throw new DOMException("cannot remove", "SecurityError"); };
    localStorage.setItem = (key, value) => {
      if (key === "pomodoroughPendingDeletion" && JSON.parse(value).stage === "issued") {
        throw new DOMException("promotion failed", "QuotaExceededError");
      }
      write(key, value);
      if (mode === "crash-after-candidate") throw new Error("process interrupted after candidate write");
    };
    localStorage.getItem = (key) => {
      if (key !== "pomodoroughPendingDeletion") return read(key);
      if (mode === "changed-readback") return "{}";
      if (mode === "denied-readback") throw new DOMException("interrupted readback", "SecurityError");
      return read(key);
    };
    const requests = [];
    const first = retainedSession(localStorage, requests);
    assert.equal(await first.actions.deleteAccount("DELETE"), false);
    assert.deepEqual(requests, []);
    const candidate = read("pomodoroughPendingDeletion");
    assert.equal(JSON.parse(candidate).stage, "candidate");
    localStorage.getItem = read;
    localStorage.setItem = write;
    const restarted = retainedSession(localStorage, requests);
    const before = structuredClone(restarted.state.pendingTaskOperations);
    assert.equal(await restarted.actions.loadSession(), true);
    assert.deepEqual(requests, ["/api/v1/me"]);
    assert.equal(read("pomodoroughPendingDeletion"), candidate);
    assert.deepEqual(restarted.state.pendingTaskOperations, before);
    assert.equal(restarted.calls.includes("clear"), false);
    assert.equal(await restarted.actions.deleteAccount("DELETE"), true);
    assert.equal(requests.filter((url) => url === "/api/v1/account").length, 1);
  });
}

test("R49-S01 issued commit retains authorized recovery with original credentials", async () => {
  const localStorage = memoryStorage();
  let release;
  const reachedFetch = new Promise((resolve) => { release = resolve; });
  let finish;
  const first = sessionFixture({ localStorage, host: {
    fetch: () => { release(); return new Promise((resolve) => { finish = resolve; }); }
  } });
  const stopped = first.actions.deleteAccount("DELETE");
  await reachedFetch;
  assert.equal(JSON.parse(localStorage.getItem("pomodoroughPendingDeletion")).stage, "issued");
  const requests = [];
  const restarted = retainedSession(localStorage, requests);
  assert.equal(await restarted.actions.loadSession(), false);
  assert.deepEqual(requests, ["/api/v1/account"]);
  assert.equal(restarted.calls.includes("clear"), true);
  // Retire the suspended old context instead of dispatching its abandoned request.
  first.state.localOwnerId = incarnationFixture.ownerId("user-2");
  finish({ ok: true, status: 204 });
  await stopped;
});

test("R49-S01 failed pre-transport guard never publishes an issued attempt", async () => {
  const localStorage = memoryStorage();
  const first = sessionFixture({ localStorage, syncStorage: {
    guardedMutation: async () => { throw new Error("guard failed"); }
  } });
  assert.equal(await first.actions.deleteAccount("DELETE"), false);
  assert.equal(localStorage.getItem("pomodoroughPendingDeletion"), null);
  const requests = [];
  assert.equal(await retainedSession(localStorage, requests).actions.loadSession(), true);
  assert.deepEqual(requests, ["/api/v1/me"]);
});

for (const status of [404, 401, 403, 503, 204]) {
  test(`R49-S01 legacy marker queries only committed receipt, status=${status}`, async () => {
    const original = JSON.stringify({ userId: incarnationFixture.ownerId("user-1"), csrfToken: "csrf-original" });
    const localStorage = memoryStorage({ pomodoroughPendingDeletion: original });
    const requests = [];
    const fixture = sessionFixture({ localStorage, host: { fetch: async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/deletion-receipt")) return { ok: status === 204, status };
      return { ok: true, status: 200, json: async () => ({
        user: incarnationFixture.accountUser("user-1"), csrfToken: "new"
      }) };
    } } });
    assert.equal(await fixture.actions.loadSession(), status !== 204);
    assert.equal(requests[0].url, "/api/v1/account/deletion-receipt");
    assert.equal(requests[0].init.method, "POST");
    assert.equal(requests[0].init.headers["X-CSRF-Token"], "csrf-original");
    assert.ok(requests.every((request) => request.init.method !== "DELETE"));
    assert.equal(fixture.calls.includes("clear"), status === 204);
    if (status === 404 || status === 503) assert.equal(localStorage.getItem("pomodoroughPendingDeletion"), original);
  });
}

test("R49-S01 marker prerequisite requires a validated account incarnation", async () => {
  let deletes = 0;
  const fixture = sessionFixture({ state: { user: { id: "legacy-user" }, localOwnerId: "legacy-user" },
    host: { fetch: async () => { deletes += 1; return { ok: true, status: 204 }; } } });
  assert.equal(await fixture.actions.deleteAccount("DELETE"), false);
  assert.equal(deletes, 0);
  assert.equal(fixture.localStorage.getItem("pomodoroughPendingDeletion"), null);
  assert.equal(fixture.calls.includes("clear"), false);
  assert.equal(fixture.elements.deleteAccountButton.disabled, false);
});

test("R49-S01 diagnostics bound distinct storage causes and reset after a successful write", async (t) => {
  const previous = globalThis.PomodoroughSentryClient;
  const reports = [];
  globalThis.PomodoroughSentryClient = { reportFrontendError: (error, operation) => reports.push({
    name: error.name, message: error.message, operation
  }) };
  t.after(() => {
    if (previous === undefined) delete globalThis.PomodoroughSentryClient;
    else globalThis.PomodoroughSentryClient = previous;
  });
  const localStorage = memoryStorage();
  const write = localStorage.setItem;
  let failureName;
  localStorage.setItem = (key, value) => {
    if (failureName && key === "pomodoroughPendingDeletion") throw { name: failureName };
    return write(key, value);
  };
  let deletes = 0;
  const fixture = sessionFixture({ localStorage, host: { fetch: async () => {
    deletes += 1; throw new Error("lost response");
  } } });
  for (const name of ["QuotaExceededError", "SecurityError", "private-name", "another-private-name"]) {
    failureName = name;
    for (let index = 0; index < 20; index += 1) assert.equal(await fixture.actions.deleteAccount("DELETE"), false);
  }
  assert.equal(deletes, 0);
  assert.deepEqual(reports.map((event) => event.name), ["QuotaExceededError", "SecurityError", "StorageError"]);
  assert.equal(fixture.calls.filter((call) => call[0] === "warn").length, 3);
  failureName = null;
  assert.equal(await fixture.actions.deleteAccount("DELETE"), false);
  assert.equal(deletes, 1);
  failureName = "QuotaExceededError";
  assert.equal(await fixture.actions.deleteAccount("DELETE"), false);
  assert.equal(deletes, 1);
  assert.equal(reports.filter((event) => event.operation === "session.delete-account.marker-write-failed").length, 4);
});
