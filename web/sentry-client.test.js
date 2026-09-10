"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const client = require("./sentry-client.js");

const WEB_DSN = "https://web-key@o1.ingest.sentry.io/2";

function fakeDocument({ meta = {}, withHead = true } = {}) {
  const appended = [];
  return {
    appended,
    querySelector(selector) {
      const match = /^meta\[name="([^"]+)"\]$/.exec(selector);
      if (!match) return null;
      const content = meta[match[1]];
      return typeof content === "string" ? { content } : null;
    },
    createElement(tag) {
      return { tagName: tag };
    },
    head: withHead ? { appendChild(node) { appended.push(node); } } : null
  };
}

test("sentry DSN slot accepts only well-formed HTTPS DSNs", () => {
  assert.equal(client.isUsableDsn(WEB_DSN), true);
  assert.equal(client.isUsableDsn(""), false);
  assert.equal(client.isUsableDsn("%POMODOROUGH_SENTRY_DSN%"), false);
  assert.equal(client.isUsableDsn("http://key@o1.ingest.sentry.io/2"), false);
  assert.equal(client.isUsableDsn("not a dsn"), false);
  assert.equal(client.isUsableDsn(null), false);
});

test("sentry settings prefer the window slot over the meta tag", () => {
  const document = fakeDocument({ meta: { "sentry-dsn": WEB_DSN } });
  const settings = client.collectSettings({ document, window: { __SENTRY_DSN__: "https://other@o9.ingest.sentry.io/9" } });
  assert.equal(settings.dsn, "https://other@o9.ingest.sentry.io/9");
});

test("sentry settings fall back to the server-rendered meta tag", () => {
  const document = fakeDocument({
    meta: { "sentry-dsn": `  ${WEB_DSN}  `, "pomodorough-version": "0.14.0" }
  });
  const settings = client.collectSettings({ document, window: {} });
  assert.equal(settings.dsn, WEB_DSN);
  assert.equal(settings.release, "pomodorough-web@0.14.0");
});

test("sentry settings stay disabled without a usable DSN", () => {
  assert.deepEqual(client.collectSettings({ document: fakeDocument(), window: {} }), { dsn: "" });
  assert.deepEqual(
    client.collectSettings({ document: fakeDocument({ meta: { "sentry-dsn": "%POMODOROUGH_SENTRY_DSN%" } }), window: {} }),
    { dsn: "" }
  );
  assert.equal(client.releaseFromDocument(fakeDocument()), "pomodorough-web@unknown");
});

test("sentry init pins replay sampling and masks recorded content", () => {
  const calls = [];
  const sentry = {
    replayIntegration: (options) => ({ name: "replay", options }),
    init: (options) => calls.push(options)
  };
  const initialized = client.initializeSdk({ dsn: WEB_DSN, release: "pomodorough-web@0.14.0" }, sentry);
  assert.equal(initialized, true);
  assert.equal(calls.length, 1);
  const options = calls[0];
  assert.equal(options.dsn, WEB_DSN);
  assert.equal(options.release, "pomodorough-web@0.14.0");
  assert.equal(options.environment, "production");
  assert.equal(options.replaysSessionSampleRate, 0.1);
  assert.equal(options.replaysOnErrorSampleRate, 1.0);
  assert.deepEqual(
    options.integrations.map((integration) => integration.options),
    [{ maskAllText: true, maskAllInputs: true, blockAllMedia: true }]
  );
});

test("sentry init refuses to start without the SDK replay integration", () => {
  assert.equal(client.initializeSdk({ dsn: WEB_DSN }, null), false);
  assert.equal(client.initializeSdk({ dsn: WEB_DSN }, { init: () => {} }), false);
});

test("sentry start injects the pinned SDK bundle only when enabled", () => {
  const document = fakeDocument({ meta: { "sentry-dsn": WEB_DSN } });
  const started = client.start({ document, window: {} });
  assert.deepEqual(started, { enabled: true });
  assert.equal(document.appended.length, 1);
  const script = document.appended[0];
  assert.equal(script.src, client.SDK_URL);
  assert.ok(script.src.includes(client.SDK_VERSION));
  assert.equal(script.integrity, client.SDK_INTEGRITY);
  assert.equal(script.crossOrigin, "anonymous");
});

test("sentry start loads the SDK on script load and stays silent without a DSN", () => {
  const document = fakeDocument({ meta: { "sentry-dsn": WEB_DSN } });
  client.start({ document, window: {} });
  const previous = globalThis.Sentry;
  const calls = [];
  globalThis.Sentry = { replayIntegration: () => ({ name: "replay" }), init: (options) => calls.push(options) };
  try {
    document.appended[0].onload();
  } finally {
    if (previous === undefined) delete globalThis.Sentry;
    else globalThis.Sentry = previous;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dsn, WEB_DSN);

  const idle = fakeDocument();
  assert.deepEqual(client.start({ document: idle, window: {} }), { enabled: false });
  assert.equal(idle.appended.length, 0);
  assert.deepEqual(client.start({ document: fakeDocument({ meta: { "sentry-dsn": WEB_DSN }, withHead: false }), window: {} }), { enabled: false });
  assert.deepEqual(client.start(null), { enabled: false });
});

function withFrontendReporting(t, { dsn = WEB_DSN } = {}) {
  const calls = [];
  const previousSentry = globalThis.Sentry;
  const previousDocument = globalThis.document;
  const hadDsnSlot = Object.hasOwn(globalThis, "__SENTRY_DSN__");
  const previousDsnSlot = globalThis.__SENTRY_DSN__;
  globalThis.Sentry = { captureException: (error, context) => calls.push({ error, context }) };
  globalThis.document = fakeDocument({ meta: dsn ? { "sentry-dsn": dsn } : {} });
  delete globalThis.__SENTRY_DSN__;
  client.resetFrontendErrorRateLimitForTest();
  t.after(() => {
    if (previousSentry === undefined) delete globalThis.Sentry;
    else globalThis.Sentry = previousSentry;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (hadDsnSlot) globalThis.__SENTRY_DSN__ = previousDsnSlot;
    else delete globalThis.__SENTRY_DSN__;
    client.resetFrontendErrorRateLimitForTest();
  });
  return calls;
}

test("frontend errors stay silent without a usable DSN or SDK", (t) => {
  client.resetFrontendErrorRateLimitForTest();
  t.after(() => client.resetFrontendErrorRateLimitForTest());
  assert.equal(client.reportFrontendError(new Error("boom"), "sync.deferred"), false);
  const calls = withFrontendReporting(t, { dsn: "" });
  assert.equal(client.reportFrontendError(new Error("boom"), "sync.deferred"), false);
  assert.equal(calls.length, 0);
});

test("frontend errors reject missing operations and empty errors", (t) => {
  const calls = withFrontendReporting(t);
  assert.equal(client.reportFrontendError(new Error("boom"), ""), false);
  assert.equal(client.reportFrontendError(new Error("boom")), false);
  assert.equal(client.reportFrontendError(null, "sync.deferred"), false);
  assert.equal(client.reportFrontendError(undefined, "sync.deferred"), false);
  assert.equal(calls.length, 0);
});

test("frontend errors report warning-level PII-free events with the operation tag", (t) => {
  const calls = withFrontendReporting(t);
  const error = new TypeError("Sync failed (503) at https://example.com/sync user@example.com");
  assert.equal(client.reportFrontendError(error, "sync.deferred"), true);
  assert.equal(calls.length, 1);
  const { error: reported, context } = calls[0];
  assert.equal(reported.name, "TypeError");
  assert.equal(context.level, "warning");
  assert.equal(context.tags["error.operation"], "sync.deferred");
  assert.match(reported.message, /sync\.deferred: Sync failed \(503\)/);
  assert.doesNotMatch(reported.message, /https:\/\/example\.com\/sync/);
  assert.doesNotMatch(reported.message, /user@example\.com/);
  assert.match(reported.message, /\[url\]/);
  assert.match(reported.message, /\[email\]/);
  assert.ok(reported.message.length <= "sync.deferred: ".length + client.FRONTEND_ERROR_MESSAGE_MAX);
});

test("frontend errors are rate-safe within a minute window", (t) => {
  const calls = withFrontendReporting(t);
  for (let index = 0; index < client.FRONTEND_ERROR_MAX_PER_WINDOW; index += 1) {
    assert.equal(client.reportFrontendError(new Error(`failure ${index}`), "sync.deferred"), true);
  }
  assert.equal(calls.length, client.FRONTEND_ERROR_MAX_PER_WINDOW);
  assert.equal(client.reportFrontendError(new Error("overflow"), "sync.deferred"), false);
  assert.equal(calls.length, client.FRONTEND_ERROR_MAX_PER_WINDOW);
});

test("frontend scrubber truncates and redacts URLs and emails", () => {
  assert.equal(client.scrubFrontendErrorMessage(""), "");
  assert.equal(client.scrubFrontendErrorMessage(null), "");
  const long = `https://example.com/${"x".repeat(2000)} user@example.com ${"y".repeat(2000)}`;
  const scrubbed = client.scrubFrontendErrorMessage(long);
  assert.ok(scrubbed.length <= client.FRONTEND_ERROR_MESSAGE_MAX);
  assert.doesNotMatch(scrubbed, /user@example\.com/);
});

test("SDK load failure warns instead of staying silent", () => {
  const document = fakeDocument({ meta: { "sentry-dsn": WEB_DSN } });
  assert.deepEqual(client.start({ document, window: {} }), { enabled: true });
  const warnings = [];
  const previousConsole = globalThis.console;
  globalThis.console = { warn: (...args) => warnings.push(args) };
  try {
    document.appended[0].onerror();
  } finally {
    globalThis.console = previousConsole;
  }
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /error monitoring unavailable/);
});

test("warn-only sync/session/bootstrap/view/actions sites report with static operations", () => {
  const wiredSites = [
    ["app-sync.js", "Pomodorough bootstrap gate unavailable:", "sync.preflight.bootstrap-gate"],
    ["app-sync.js", "Pomodorough pending queues unavailable:", "sync.preflight.pending-queues"],
    ["app-sync.js", "Pomodorough sync deferred:", "sync.deferred"],
    ["app-session.js", "Pomodorough session deferred:", "session.initialize.deferred"],
    ["app-session.js", "Pomodorough pending queues unavailable before logout:", "session.logout.pending-queues"],
    ["app-session.js", "Pomodorough pending logout cleanup failed:", "session.logout-recovery.cleanup-failed"],
    ["app-session.js", "Pomodorough account deletion request failed:", "session.delete-account.request-failed"],
    ["app-session.js", "Pomodorough server revocation deferred until reconnect:", "session.logout.revocation-deferred"],
    ["app-session.js", "Pomodorough local sign-out cleanup was incomplete:", "session.logout.cleanup-incomplete"],
    ["app-bootstrap.js", "Pomodorough bootstrap restart deferred:", "bootstrap.restart.deferred"],
    ["app-bootstrap.js", "Pomodorough bootstrap resolution deferred:", "bootstrap.resolution.deferred"],
    ["app-view.js", "Cross-tab sign-out cleanup was incomplete:", "view.cross-tab-logout.cleanup-incomplete"],
    ["app-view.js", "Timer ownership release failed:", "view.timer-ownership.release-failed"],
    ["app-actions.js", "Timer ownership renewal failed:", "actions.timer-ownership.renewal-failed"]
  ];
  assert.equal(wiredSites.length, 14);
  for (const [file, message, operation] of wiredSites) {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");
    assert.match(source, new RegExp(message.replace(/[.?]/g, "\\$&")),
      `${file} must keep its warn message`);
    const call = `reportFrontendError(error, "${operation}")`;
    assert.ok(source.includes(call), `${file} must report with ${operation}`);
  }
});

test("S28 startup/session/storage sites report with static operations", () => {
  const warnSites = [
    ["app.js", "Pomodorough localization unavailable; using embedded English:", "startup.localization.unavailable"],
    ["app.js", "Pomodorough offline shell unavailable:", "startup.offline-shell.unavailable"],
    ["app-session.js", "Pomodorough remains offline:", "session.restore.offline"],
    ["app-session.js", "Deleted account local-data cleanup will retry on next launch:", "session.delete-account.cleanup-retry"]
  ];
  assert.equal(warnSites.length, 4);
  for (const [file, message, operation] of warnSites) {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");
    assert.match(source, new RegExp(message.replace(/[.?]/g, "\\$&")),
      `${file} must keep its warn message`);
    const call = `reportFrontendError(error, "${operation}")`;
    assert.ok(source.includes(call), `${file} must report with ${operation}`);
  }
  const session = fs.readFileSync(path.join(__dirname, "app-session.js"), "utf8");
  assert.ok(session.includes('reportFrontendError(failure, "session.stream.error")'),
    "app-session.js must report stream errors with session.stream.error");
  assert.match(session, /\.onerror\s*=/, "app-session.js must wire revision stream onerror");
  const storage = fs.readFileSync(path.join(__dirname, "app-storage.js"), "utf8");
  assert.ok(storage.includes('reportFrontendError(error, "storage.failure")'),
    "app-storage.js must report with storage.failure");
  assert.match(storage, /AccountOwnershipError/, "app-storage.js must keep ownership quarantine");
});

test("S30 storage/locale sites report with static operations", () => {
  const warnSites = [
    ["i18n.js", "Pomodorough locale fallback:", "i18n.locale.fallback"],
    ["app.js", "Pomodorough durable storage unavailable:", "startup.storage.unavailable"]
  ];
  assert.equal(warnSites.length, 2);
  for (const [file, message, operation] of warnSites) {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");
    assert.match(source, new RegExp(message.replace(/[.?]/g, "\\$&")),
      `${file} must keep its warn message`);
    const call = `reportFrontendError(error, "${operation}")`;
    assert.ok(source.includes(call), `${file} must report with ${operation}`);
  }
  const composition = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
  assert.ok(composition.includes('call(application, "tr", "storage.unavailable"'),
    "app.js must keep the resource-backed storage notice");
  assert.ok(composition.includes('call(application, "renderSyncStatus")'),
    "app.js must keep rendering sync status after storage failure");
  const storage = fs.readFileSync(path.join(__dirname, "app-storage.js"), "utf8");
  assert.ok(storage.includes('reportFrontendError(error, "storage.failure")'),
    "app-storage.js must report with storage.failure");
  assert.match(storage, /AccountOwnershipError/, "app-storage.js must keep ownership quarantine");
  const i18n = fs.readFileSync(path.join(__dirname, "i18n.js"), "utf8");
  assert.match(i18n, /function reportFrontendError\(error, operation\)/,
    "i18n.js must route reports through the frontend error wrapper");
});

test("S32 actions/bootstrap save-failed sites report with static operations", (t) => {
  const wiredSites = [
    ["app-actions.js", "actions.duration.save-failed"],
    ["app-actions.js", "actions.auto-start.save-failed"],
    ["app-actions.js", "actions.selected-task.save-failed"],
    ["app-actions.js", "actions.task.save-failed"],
    ["app-actions.js", "actions.timer.save-failed"],
    ["app-actions.js", "actions.timer.clear-failed"],
    ["app-bootstrap.js", "bootstrap.retry.deferred"],
    ["app-bootstrap.js", "bootstrap.choice.deferred"]
  ];
  assert.equal(wiredSites.length, 8);
  for (const [file, operation] of wiredSites) {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");
    const call = `reportFrontendError(error, "${operation}")`;
    assert.ok(source.includes(call), `${file} must report with ${operation}`);
    assert.match(operation, /^[a-z0-9][a-z0-9.-]*$/,
      `${operation} must stay a static PII-free operation tag`);
  }
  const actions = fs.readFileSync(path.join(__dirname, "app-actions.js"), "utf8");
  assert.match(actions, /function reportFrontendError\(error, operation\)/,
    "app-actions.js must route reports through the frontend error wrapper");
  assert.ok(actions.includes('"notice.durationSaveFailed"'),
    "app-actions.js must keep the duration save-failed notice");
  assert.ok(actions.includes('"notice.autoStartSaveFailed"'),
    "app-actions.js must keep the auto-start save-failed notice");
  assert.ok(actions.includes('"notice.taskChoiceSaveFailed"'),
    "app-actions.js must keep the task-choice save-failed notice");
  assert.ok(actions.includes('"notice.taskSaveFailed"'),
    "app-actions.js must keep the task save-failed notice");
  assert.ok(actions.includes('"notice.timerSaveFailed"'),
    "app-actions.js must keep the timer save-failed notice");
  assert.match(actions, /AccountOwnershipError/,
    "app-actions.js must keep ownership quarantine for clear");
  const bootstrap = fs.readFileSync(path.join(__dirname, "app-bootstrap.js"), "utf8");
  assert.match(bootstrap, /function reportFrontendError\(error, operation\)/,
    "app-bootstrap.js must route reports through the frontend error wrapper");
  assert.ok(bootstrap.includes("handleResolutionLimit(error)"),
    "app-bootstrap.js must keep resolution-limit handling");
  assert.ok(bootstrap.includes('"notice.historyChoiceFailed"'),
    "app-bootstrap.js must keep the history-choice notice");
  assert.ok(bootstrap.includes("History resolution could not be retried."),
    "app-bootstrap.js must keep the retry error text");
  const calls = withFrontendReporting(t);
  const piiError = new Error("Write release notes https://example.com/sync user@example.com");
  assert.equal(client.reportFrontendError(piiError, "actions.task.save-failed"), true);
  assert.equal(calls.length, 1);
  const { error: reported, context } = calls[0];
  assert.equal(context.level, "warning");
  assert.equal(context.tags["error.operation"], "actions.task.save-failed");
  assert.doesNotMatch(reported.message, /https:\/\/example\.com\/sync/);
  assert.doesNotMatch(reported.message, /user@example\.com/);
  assert.match(reported.message, /\[url\]/);
  assert.match(reported.message, /\[email\]/);
});

test("service worker stays silent with a reasoned comment", () => {
  const worker = fs.readFileSync(path.join(__dirname, "sw.js"), "utf8");
  assert.match(worker, /stay silent by design/);
  assert.doesNotMatch(worker, /reportFrontendError/);
  assert.doesNotMatch(worker, /captureException/);
});
