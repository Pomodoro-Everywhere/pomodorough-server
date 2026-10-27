"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const client = require("./sentry-client.js");
const CANARY = "private-task user@example.test token=secret invite=abc /private/path #fragment";
const settings = { dsn: "https://key@o1.ingest.sentry.io/2", release: "pomodorough-web@0.52.0" };

// Models the SDK boundary: processors enrich events before beforeSend; only its result reaches transport.
function finalEventSeam() {
  let options;
  const envelopes = [];
  const breadcrumbs = [];
  const sdk = {
    replayIntegration: (options) => ({ options }),
    init: (value) => { options = value; },
    addBreadcrumb(crumb) {
      const clean = options.beforeBreadcrumb(crumb);
      if (clean) breadcrumbs.push(clean);
    },
    captureException(error, context) {
      return this.deliver({
        ...privateEvent(), level: context.level, tags: context.tags,
        exception: { values: [{ type: error.name, value: error.message, stacktrace: { frames: [{ filename: CANARY }] } }] },
        breadcrumbs
      });
    },
    deliver(event) {
      const clean = options.beforeSend(event, { originalException: new Error(CANARY) });
      if (clean !== null) envelopes.push(JSON.parse(JSON.stringify(clean)));
      return clean;
    }
  };
  assert.equal(client.initializeSdk(settings, sdk), true);
  return { sdk, envelopes, get options() { return options; } };
}

function privateEvent(type = "TypeError") {
  return {
    event_id: "abcdef0123456789abcdef0123456789", timestamp: 123, level: "error",
    message: CANARY, logentry: { message: CANARY }, transaction: CANARY,
    request: { url: `https://example.test/?${CANARY}`, headers: { Authorization: CANARY }, data: CANARY },
    exception: { values: [{ type, value: CANARY, mechanism: { data: { reason: CANARY } },
      stacktrace: { frames: [{ filename: CANARY, function: CANARY, vars: { secret: CANARY } }] } }] },
    user: { id: CANARY, email: CANARY }, extra: { secret: CANARY },
    contexts: { trace: { data: { secret: CANARY } }, browser: { name: CANARY } },
    tags: { arbitrary: CANARY }, fingerprint: [CANARY], sdk: { name: CANARY },
    breadcrumbs: ["fetch", "xhr", "navigation", "console"].map((category) => ({
      category, message: CANARY, data: { url: CANARY, from: CANARY, to: CANARY, arguments: [CANARY] }
    })), unexpectedFutureField: CANARY
  };
}

function assertSafe(event, type, operation) {
  const serialized = JSON.stringify(event);
  for (const secret of CANARY.split(" ")) assert.ok(!serialized.includes(secret), secret);
  assert.deepEqual(event.exception, { values: [{ type, value: operation }] });
  assert.deepEqual(event.tags, { "error.operation": operation });
  for (const field of ["request", "user", "extra", "contexts", "message", "transaction", "fingerprint", "unexpectedFutureField"]) {
    assert.equal(Object.hasOwn(event, field), false, field);
  }
  assert.equal(event.release, settings.release);
  assert.equal(event.environment, "production");
  assert.equal(event.event_id, "abcdef0123456789abcdef0123456789");
}

test("automatic uncaught and rejection final events discard all private processor fields", () => {
  const seam = finalEventSeam();
  for (const [type, mechanism] of [["ReferenceError", "onerror"], ["TypeError", "onunhandledrejection"], [CANARY, "onerror"]]) {
    const event = privateEvent(type);
    event.exception.values[0].mechanism = { type: mechanism, handled: false, data: { value: CANARY } };
    seam.sdk.deliver(event);
    const sent = seam.envelopes.at(-1);
    assertSafe(sent, type === CANARY ? "Error" : type, "browser.automatic");
    assert.equal(sent.timestamp, 123);
    assert.equal(sent.level, "error");
    assert.deepEqual(sent.breadcrumbs, ["fetch", "xhr", "navigation", "console"]
      .map((category) => ({ category, message: "[redacted]" })));
  }
  assert.equal(seam.envelopes.length, 3);
});

test("breadcrumb ingestion and final event both scrub fetch/navigation/console and unknown fields", () => {
  const seam = finalEventSeam();
  for (const crumb of privateEvent().breadcrumbs) seam.sdk.addBreadcrumb(crumb);
  seam.sdk.addBreadcrumb({ category: CANARY, message: CANARY, data: { secret: CANARY } });
  seam.sdk.addBreadcrumb({ category: "error.repeat", message: "sync.deferred", data: CANARY });
  assert.deepEqual(seam.options.beforeBreadcrumb({ category: "error.repeat", message: CANARY }),
    { category: "error.repeat", message: "[redacted]" });
  assert.deepEqual(seam.options.beforeBreadcrumb({ category: "console", message: CANARY }),
    { category: "console", message: "[redacted]" });
  const event = privateEvent();
  event.breadcrumbs.push({ category: "error.repeat", message: "sync.deferred", data: CANARY });
  seam.sdk.deliver(event);
  assert.deepEqual(seam.envelopes[0].breadcrumbs.at(-1), { category: "error.repeat", message: "sync.deferred" });
  assertSafe(seam.envelopes[0], "TypeError", "browser.automatic");
});

function installReporting(t, seam) {
  const saved = { Sentry: globalThis.Sentry, document: globalThis.document, __SENTRY_DSN__: globalThis.__SENTRY_DSN__ };
  globalThis.Sentry = seam.sdk;
  globalThis.__SENTRY_DSN__ = settings.dsn;
  globalThis.document = { querySelector: () => null };
  client.resetFrontendErrorRateLimitForTest();
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
    client.resetFrontendErrorRateLimitForTest();
  });
}

test("manual final events retain static operation and finite error identity, with quotas and dedup intact", (t) => {
  const seam = finalEventSeam();
  installReporting(t, seam);
  const error = new Error(CANARY);
  error.name = CANARY;
  assert.equal(client.reportFrontendError(error, "actions.task.save-failed"), true);
  assertSafe(seam.envelopes[0], "Error", "actions.task.save-failed");
  assert.equal(seam.envelopes[0].level, "warning");
  assert.equal(client.reportFrontendError(error, "actions.task.save-failed"), false);
  assert.equal(seam.envelopes.length, 1);
  assert.equal(client.reportFrontendError(new TypeError(CANARY), "sync.deferred"), true);
  assertSafe(seam.envelopes[1], "TypeError", "sync.deferred");
  assert.deepEqual(seam.envelopes[1].breadcrumbs, [{ category: "error.repeat", message: "actions.task.save-failed" }]);
  for (let index = 0; index < 12; index += 1) client.reportFrontendError(error, `unknown.${index}.${CANARY}`);
  assert.equal(seam.envelopes.length, client.FRONTEND_ERROR_MAX_PER_WINDOW);
  for (const event of seam.envelopes.slice(2)) assertSafe(event, "Error", "browser.automatic");
});

test("scrubber failures drop events and breadcrumbs rather than forwarding original input", () => {
  const seam = finalEventSeam();
  const throwing = new Proxy({}, { get() { throw new Error(CANARY); } });
  assert.equal(seam.sdk.deliver(throwing), null);
  assert.equal(seam.sdk.deliver({ exception: { values: [throwing] } }), null);
  assert.equal(seam.sdk.deliver(null), null);
  assert.equal(seam.options.beforeBreadcrumb(throwing), null);
  assert.equal(seam.options.beforeBreadcrumb(null), null);
  assert.equal(seam.envelopes.length, 0);
  const event = privateEvent();
  event.breadcrumbs.push(throwing);
  seam.sdk.deliver(event);
  assertSafe(seam.envelopes[0], "TypeError", "browser.automatic");
  assert.equal(seam.envelopes[0].breadcrumbs.length, 4);
});

test("final scrub retains only valid bounded event metadata and bounded exceptions/breadcrumbs", () => {
  const seam = finalEventSeam();
  const event = privateEvent("RangeError");
  event.event_id = CANARY;
  event.timestamp = Infinity;
  event.level = CANARY;
  event.exception.values = Array(20).fill(event.exception.values[0]);
  event.breadcrumbs = Array(200).fill(event.breadcrumbs[0]);
  seam.sdk.deliver(event);
  const sent = seam.envelopes[0];
  assert.equal(sent.event_id, undefined);
  assert.equal(sent.timestamp, undefined);
  assert.equal(sent.level, "error");
  assert.equal(sent.exception.values.length, 5);
  assert.equal(sent.breadcrumbs.length, 100);
  assert.ok(sent.exception.values.every((value) => value.type === "RangeError"));
  assert.ok(!JSON.stringify(sent).includes(CANARY));
});

test("every literal production reporting operation survives the final allowlist", () => {
  const seam = finalEventSeam();
  const operations = new Set();
  for (const file of fs.readdirSync(__dirname).filter((file) => file.endsWith(".js") && !file.endsWith(".test.js"))) {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");
    for (const match of source.matchAll(/reportFrontendError\([^,\n]+,\s*"([^"]+)"\)/g)) operations.add(match[1]);
  }
  assert.ok(operations.size >= 40);
  for (const operation of operations) {
    const event = privateEvent();
    event.tags["error.operation"] = operation;
    seam.sdk.deliver(event);
    assertSafe(seam.envelopes.at(-1), "TypeError", operation);
  }
});

test("finite standard and application error names retain identity while custom names collapse", () => {
  const seam = finalEventSeam();
  const names = ["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError",
    "EvalError", "AggregateError", "AbortError", "TimeoutError", "AccountOwnershipError",
    "QuotaExceededError", "SecurityError", "StorageError"];
  for (const name of names) {
    seam.sdk.deliver(privateEvent(name));
    assertSafe(seam.envelopes.at(-1), name, "browser.automatic");
  }
  for (const name of [CANARY, "CustomError", "TypeError " , "x".repeat(10000), null, {}]) {
    seam.sdk.deliver(privateEvent(name));
    assertSafe(seam.envelopes.at(-1), "Error", "browser.automatic");
  }
});
