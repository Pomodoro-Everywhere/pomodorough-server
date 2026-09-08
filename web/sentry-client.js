"use strict";

(function exposeSentryClient(root, factory) {
  const client = factory();
  if (typeof module === "object" && module.exports) module.exports = client;
  if (root) root.PomodoroughSentryClient = client;
})(typeof globalThis === "undefined" ? this : globalThis, function createSentryClient() {
  const SDK_VERSION = "10.73.0";
  const SDK_URL = `https://browser.sentry-cdn.com/${SDK_VERSION}/bundle.replay.min.js`;
  const SDK_INTEGRITY = "sha384-v+D1gdzSWnYx0Fj7Z67yzqXsVW4olTfhpAmdg5Nr4lVTF43prR517oApLey/5J2E";
  const SESSION_SAMPLE_RATE = 0.1;
  const ERROR_SAMPLE_RATE = 1.0;
  const ENVIRONMENT = "production";
  const FRONTEND_ERROR_WINDOW_MS = 60_000;
  const FRONTEND_ERROR_MAX_PER_WINDOW = 10;
  const FRONTEND_ERROR_MESSAGE_MAX = 500;

  const frontendErrorTimestamps = [];

  function isUsableDsn(value) {
    return typeof value === "string" &&
      /^https:\/\/[A-Za-z0-9_-]+@[A-Za-z0-9.-]+\/[0-9]+$/.test(value.trim());
  }

  function readMetaContent(document, name) {
    if (!document || typeof document.querySelector !== "function") return "";
    const meta = document.querySelector(`meta[name="${name}"]`);
    return meta && typeof meta.content === "string" ? meta.content : "";
  }

  function releaseFromDocument(document) {
    const version = readMetaContent(document, "pomodorough-version").trim();
    return `pomodorough-web@${version || "unknown"}`;
  }

  function collectSettings(host) {
    const scope = (host && host.window) || {};
    const document = host && host.document;
    if (isUsableDsn(scope.__SENTRY_DSN__)) {
      return { dsn: scope.__SENTRY_DSN__.trim(), release: releaseFromDocument(document) };
    }
    const metaDsn = readMetaContent(document, "sentry-dsn");
    if (isUsableDsn(metaDsn)) {
      return { dsn: metaDsn.trim(), release: releaseFromDocument(document) };
    }
    return { dsn: "" };
  }

  function initializeSdk(settings, sentry) {
    if (!sentry || typeof sentry.init !== "function") return false;
    if (typeof sentry.replayIntegration !== "function") return false;
    sentry.init({
      dsn: settings.dsn,
      release: settings.release,
      environment: ENVIRONMENT,
      replaysSessionSampleRate: SESSION_SAMPLE_RATE,
      replaysOnErrorSampleRate: ERROR_SAMPLE_RATE,
      integrations: [
        sentry.replayIntegration({ maskAllText: true, maskAllInputs: true, blockAllMedia: true })
      ]
    });
    return true;
  }

  function injectSdk(document, settings, onload) {
    const script = document.createElement("script");
    script.src = SDK_URL;
    script.integrity = SDK_INTEGRITY;
    script.crossOrigin = "anonymous";
    script.onload = () => onload(settings);
    script.onerror = () => {
      try {
        const scope = typeof globalThis === "undefined" ? null : globalThis;
        const consoleRef = (scope && scope.console)
          || (typeof console !== "undefined" ? console : null);
        if (consoleRef && typeof consoleRef.warn === "function") {
          consoleRef.warn("Pomodorough error monitoring unavailable");
        }
      } catch { /* monitoring failure must never break the app */ }
    };
    document.head.appendChild(script);
  }

  function start(host) {
    if (!host || !host.document || typeof host.document.createElement !== "function") {
      return { enabled: false };
    }
    const settings = collectSettings(host);
    if (!settings.dsn) return { enabled: false };
    if (!host.document.head || typeof host.document.head.appendChild !== "function") {
      return { enabled: false };
    }
    injectSdk(host.document, settings, (loaded) => initializeSdk(loaded, globalThis.Sentry));
    return { enabled: true };
  }

  function scrubFrontendErrorMessage(value) {
    if (typeof value !== "string" || !value) return "";
    let scrubbed = value.slice(0, FRONTEND_ERROR_MESSAGE_MAX * 2);
    scrubbed = scrubbed.replace(/https?:\/\/\S+/g, "[url]");
    scrubbed = scrubbed.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]");
    return scrubbed.slice(0, FRONTEND_ERROR_MESSAGE_MAX);
  }

  function frontendErrorRateLimited(nowMs) {
    const windowStart = nowMs - FRONTEND_ERROR_WINDOW_MS;
    while (frontendErrorTimestamps.length > 0 && frontendErrorTimestamps[0] <= windowStart) {
      frontendErrorTimestamps.shift();
    }
    if (frontendErrorTimestamps.length >= FRONTEND_ERROR_MAX_PER_WINDOW) return true;
    frontendErrorTimestamps.push(nowMs);
    return false;
  }

  function resetFrontendErrorRateLimitForTest() {
    frontendErrorTimestamps.length = 0;
  }

  function canReportFrontendError() {
    try {
      const scope = typeof globalThis === "undefined" ? null : globalThis;
      const sentry = scope && scope.Sentry;
      if (!sentry || typeof sentry.captureException !== "function") return false;
      const documentRef = typeof document !== "undefined"
        ? document
        : (scope && scope.document) || null;
      const settings = collectSettings({ document: documentRef, window: scope || {} });
      return Boolean(settings && settings.dsn);
    } catch {
      return false;
    }
  }

  // reportFrontendError forwards an already-warned frontend failure to error
  // monitoring at warning level. Rate-safe (bounded per minute), PII-free
  // (static operation tag plus scrubbed error name/message only, never raw
  // URLs, emails, task content, or credentials), and a no-op when no usable
  // DSN is configured or the SDK failed to load.
  function reportFrontendError(error, operation) {
    try {
      if (typeof operation !== "string" || !operation) return false;
      if (error === null || error === undefined) return false;
      if (frontendErrorRateLimited(Date.now())) return false;
      if (!canReportFrontendError()) return false;
      const scope = typeof globalThis === "undefined" ? null : globalThis;
      if (!scope || !scope.Sentry || typeof scope.Sentry.captureException !== "function") return false;
      const name = (error && typeof error.name === "string" && error.name) || "Error";
      const rawMessage = (error && typeof error.message === "string") ? error.message : String(error);
      const scrubbed = scrubFrontendErrorMessage(rawMessage);
      const wrapped = new Error(scrubbed ? `${operation}: ${scrubbed}` : operation);
      wrapped.name = String(name).slice(0, 100) || "Error";
      scope.Sentry.captureException(wrapped, {
        level: "warning",
        tags: { "error.operation": operation }
      });
      return true;
    } catch {
      return false;
    }
  }

  const api = Object.freeze({
    SDK_VERSION, SDK_URL, SDK_INTEGRITY, SESSION_SAMPLE_RATE, ERROR_SAMPLE_RATE, ENVIRONMENT,
    FRONTEND_ERROR_WINDOW_MS, FRONTEND_ERROR_MAX_PER_WINDOW, FRONTEND_ERROR_MESSAGE_MAX,
    isUsableDsn, readMetaContent, releaseFromDocument, collectSettings, initializeSdk, start,
    scrubFrontendErrorMessage, reportFrontendError, resetFrontendErrorRateLimitForTest
  });

  if (typeof document !== "undefined" && typeof document.querySelector === "function") {
    start({ document, window: typeof globalThis === "undefined" ? {} : globalThis });
  }
  return api;
});
