"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
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
