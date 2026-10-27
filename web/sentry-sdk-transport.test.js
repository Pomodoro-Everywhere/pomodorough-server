"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const client = require("./sentry-client.js");
const sdkPath = process.env.POMODOROUGH_SENTRY_SDK_PATH;
const sourcePath = process.env.POMODOROUGH_SENTRY_CLIENT_PATH || path.join(__dirname, "sentry-client.js");
const CANARY = "opaque-private-canary-Z71";
const DSN = "https://offline@collector.invalid/1";

// Supply the production CDN bundle locally; never fetch an SDK or send telemetry during a test.
async function transportFixture(t) {
  const sdk = fs.readFileSync(sdkPath);
  assert.equal(`sha384-${createHash("sha384").update(sdk).digest("base64")}`, client.SDK_INTEGRITY);
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ serviceWorkers: "block" });
  const envelopes = [];
  const unexpected = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === "collector.invalid" && url.pathname === "/api/1/envelope/") {
      envelopes.push(request.postDataBuffer().toString("utf8"));
      return route.fulfill({ status: 200, body: "{}", headers: { "Access-Control-Allow-Origin": "*" } });
    }
    if (url.hostname === "privacy.invalid") {
      return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>offline</title>" });
    }
    unexpected.push(request.url());
    return route.abort();
  });
  await page.goto(`https://privacy.invalid/${CANARY}?token=${CANARY}#${CANARY}`);
  await page.addScriptTag({ content: sdk.toString("utf8") });
  await page.addScriptTag({ content: fs.readFileSync(sourcePath, "utf8") });
  await page.evaluate(({ dsn }) => {
    window.__SENTRY_DSN__ = dsn;
    window.observedReplayOptions = [];
    const original = Sentry.replayIntegration;
    Sentry.replayIntegration = (options) => {
      window.observedReplayOptions.push({ ...options });
      return original(options);
    };
    PomodoroughSentryClient.initializeSdk({ dsn, release: "pomodorough-web@offline" }, Sentry);
  }, { dsn: DSN });
  t.after(() => assert.deepEqual(unexpected, [], "all browser requests stay inside the offline fixture"));
  return { page, envelopes };
}

function eventsFrom(envelopes) {
  return envelopes.flatMap((body) => {
    const lines = body.split("\n");
    const events = [];
    for (let index = 1; index < lines.length - 1; index += 2) {
      if (JSON.parse(lines[index]).type === "event") events.push(JSON.parse(lines[index + 1]));
    }
    return events;
  });
}

function assertPrivateFieldsAbsent(envelopes, events) {
  assert.ok(events.length > 0, "real SDK must deliver event envelopes");
  assert.ok(!envelopes.join("\n").includes(CANARY), "canary must not survive final serialized transport");
  for (const event of events) {
    for (const key of ["request", "user", "extra", "contexts", "message", "transaction", "fingerprint", "futureField"]) {
      assert.equal(Object.hasOwn(event, key), false, key);
    }
    assert.equal(event.release, "pomodorough-web@offline");
    assert.equal(event.environment, "production");
    assert.match(event.event_id, /^[a-f0-9]{32}$/);
    assert.ok(Number.isFinite(event.timestamp));
  }
}

async function seedPrivateProcessor(page) {
  return page.evaluate((secret) => {
    window.observedBeforeScrub = [];
    Sentry.addEventProcessor((event) => {
      window.observedBeforeScrub.push(JSON.parse(JSON.stringify(event)));
      const nested = { innocuous: [{ deeper: { arbitrary: secret } }] };
      return { ...event, extra: nested, contexts: { custom: nested }, futureField: nested,
        user: { id: secret }, request: { url: secret, headers: { Authorization: secret } },
        fingerprint: [secret], transaction: secret,
        breadcrumbs: [...(event.breadcrumbs || []), { category: secret, message: secret, data: nested }] };
    });
    for (const category of ["fetch", "xhr", "navigation", "console"]) {
      Sentry.addBreadcrumb({ category, message: secret, data: { innocuous: [secret] } });
    }
  }, CANARY);
}

const offline = { skip: !sdkPath && "set POMODOROUGH_SENTRY_SDK_PATH to the integrity-pinned production replay bundle", timeout: 30_000 };

test("pinned browser SDK serializes scrubbed nested fields and linked exception chains", offline, async (t) => {
  const { page, envelopes } = await transportFixture(t);
  await seedPrivateProcessor(page);
  const flushed = await page.evaluate(async (secret) => {
    const cause = new TypeError(secret);
    const error = new Error(secret, { cause });
    error.name = secret;
    Sentry.captureException(error, { tags: { "error.operation": secret } });
    return Sentry.flush(5000);
  }, CANARY);
  assert.equal(flushed, true);
  const events = eventsFrom(envelopes);
  assert.equal(events.length, 1);
  assertPrivateFieldsAbsent(envelopes, events);
  assert.deepEqual(events[0].exception.values, [
    { type: "TypeError", value: "browser.automatic" }, { type: "Error", value: "browser.automatic" }
  ]);
  assert.deepEqual(events[0].tags, { "error.operation": "browser.automatic" });
  assert.deepEqual(events[0].breadcrumbs, ["fetch", "xhr", "navigation", "console", "diagnostic"]
    .map((category) => ({ category, message: "[redacted]" })));
  const observed = await page.evaluate(() => window.observedBeforeScrub);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].exception.values.length, 2, "real LinkedErrors integration expanded cause before scrubbing");
  assert.ok(JSON.stringify(observed).includes(CANARY), "processor really saw private SDK input");
});

test("pinned browser SDK preserves manual dedup, ten-event budget, repeat breadcrumbs and replay masks", offline, async (t) => {
  const { page, envelopes } = await transportFixture(t);
  await seedPrivateProcessor(page);
  const result = await page.evaluate(async (secret) => {
    const app = PomodoroughSentryClient;
    const options = Sentry.getClient().getOptions();
    const error = new Error(secret);
    error.name = secret;
    const first = app.reportFrontendError(error, "actions.task.save-failed");
    const repeat = app.reportFrontendError(error, "actions.task.save-failed");
    const typed = app.reportFrontendError(new TypeError(secret), "sync.deferred");
    const remaining = Array.from({ length: 12 }, (_, index) => app.reportFrontendError(error, `unknown.${index}.${secret}`));
    return { first, repeat, typed, remaining, flushed: await Sentry.flush(5000),
      rates: [options.replaysSessionSampleRate, options.replaysOnErrorSampleRate],
      replay: window.observedReplayOptions,
      hasBeforeSend: typeof options.beforeSend === "function",
      hasBeforeBreadcrumb: typeof options.beforeBreadcrumb === "function" };
  }, CANARY);
  assert.deepEqual(result.rates, [0.1, 1]);
  assert.equal(result.replay.length, 1);
  assert.deepEqual(result.replay[0], { maskAllText: true, maskAllInputs: true, blockAllMedia: true });
  assert.equal(result.first, true);
  assert.equal(result.repeat, false);
  assert.equal(result.typed, true);
  assert.equal(result.remaining.filter(Boolean).length, 8);
  assert.equal(result.flushed, true);
  const events = eventsFrom(envelopes);
  assert.equal(events.length, client.FRONTEND_ERROR_MAX_PER_WINDOW);
  assertPrivateFieldsAbsent(envelopes, events);
  assert.deepEqual(events[0].exception.values, [{ type: "Error", value: "actions.task.save-failed" }]);
  assert.deepEqual(events[1].exception.values, [{ type: "TypeError", value: "sync.deferred" }]);
  assert.ok(events[1].breadcrumbs.some((crumb) => crumb.category === "error.repeat"
    && crumb.message === "actions.task.save-failed"));
  for (const event of events.slice(2)) {
    assert.deepEqual(event.tags, { "error.operation": "browser.automatic" });
    assert.deepEqual(event.exception.values, [{ type: "Error", value: "browser.automatic" }]);
    assert.equal(event.level, "warning");
  }
});
