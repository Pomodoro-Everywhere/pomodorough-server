"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const client = require("./sentry-client.js");

const WEB_DSN = "https://web-key@o1.ingest.sentry.io/2";

function fakeDocument({ meta = {} } = {}) {
  return {
    querySelector(selector) {
      const match = /^meta\[name="([^"]+)"\]$/.exec(selector);
      if (!match) return null;
      const content = meta[match[1]];
      return typeof content === "string" ? { content } : null;
    },
    createElement(tag) {
      return { tagName: tag };
    },
    head: { appendChild() {} }
  };
}

function withReporting(t, { dsn = WEB_DSN } = {}) {
  const calls = [];
  const breadcrumbs = [];
  const previousSentry = globalThis.Sentry;
  const previousDocument = globalThis.document;
  const hadDsnSlot = Object.hasOwn(globalThis, "__SENTRY_DSN__");
  const previousDsnSlot = globalThis.__SENTRY_DSN__;
  globalThis.Sentry = {
    captureException: (error, context) => calls.push({ error, context }),
    addBreadcrumb: (crumb) => breadcrumbs.push(crumb)
  };
  calls.breadcrumbs = breadcrumbs;
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

test("R43-S10 repeat burst preserves quota for distinct storage failure", (t) => {
  const calls = withReporting(t);
  const budget = client.FRONTEND_ERROR_MAX_PER_WINDOW;
  assert.equal(client.reportFrontendError(new Error("boom"), "sync.deferred"), true);
  for (let index = 1; index < budget; index += 1) {
    assert.equal(client.reportFrontendError(new Error("boom"), "sync.deferred"), false);
  }
  assert.equal(calls.length, 1);
  assert.equal(client.reportFrontendError(new Error("disk full"), "storage.failure"), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].context.tags["error.operation"], "sync.deferred");
  assert.equal(calls[1].context.tags["error.operation"], "storage.failure");
});

test("R43-S10 identical repeats collapse without consuming quota", (t) => {
  const calls = withReporting(t);
  assert.equal(client.reportFrontendError(new Error("boom"), "sync.deferred"), true);
  for (let index = 0; index < 4; index += 1) {
    assert.equal(client.reportFrontendError(new Error("boom"), "sync.deferred"), false);
  }
  assert.equal(calls.length, 1);
  assert.equal(calls.breadcrumbs.length, 4);
  for (let index = 0; index < client.FRONTEND_ERROR_MAX_PER_WINDOW - 1; index += 1) {
    assert.equal(client.reportFrontendError(new Error(`other ${index}`), `sync.deferred.${index}`), true);
  }
  assert.equal(calls.length, client.FRONTEND_ERROR_MAX_PER_WINDOW);
});

test("R43-S10 unavailable SDK never consumes quota", (t) => {
  const calls = [];
  const previousSentry = globalThis.Sentry;
  const previousDocument = globalThis.document;
  const hadDsnSlot = Object.hasOwn(globalThis, "__SENTRY_DSN__");
  const previousDsnSlot = globalThis.__SENTRY_DSN__;
  globalThis.document = fakeDocument({ meta: { "sentry-dsn": WEB_DSN } });
  delete globalThis.Sentry;
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
  for (let index = 0; index < client.FRONTEND_ERROR_MAX_PER_WINDOW; index += 1) {
    assert.equal(client.reportFrontendError(new Error("boom"), "sync.deferred"), false);
  }
  globalThis.Sentry = {
    captureException: (error, context) => calls.push({ error, context }),
    addBreadcrumb: () => {}
  };
  assert.equal(client.reportFrontendError(new Error("disk full"), "storage.failure"), true);
  assert.equal(calls.length, 1);
});
