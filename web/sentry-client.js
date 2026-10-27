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
  const FRONTEND_ERROR_DEDUP_MS = 30_000;
  const FRONTEND_ERROR_DEDUP_MAX_MS = 300_000;
  const SAFE_ERROR_NAMES = new Set([
    "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError",
    "EvalError", "AggregateError", "AbortError", "TimeoutError", "AccountOwnershipError",
    "QuotaExceededError", "SecurityError", "StorageError"
  ]);
  const SAFE_OPERATIONS = new Set([
    "sync.preflight.bootstrap-gate", "sync.preflight.pending-queues", "sync.deferred",
    "sync.immutable.recovery", "session.stream.error", "session.restore.offline",
    "session.logout.marker-write-failed", "session.delete-account.marker-write-failed",
    "session.delete-account.cleanup-retry", "session.logout-recovery.cleanup-failed",
    "session.initialize.deferred", "session.delete-account.request-failed",
    "session.logout.revocation-deferred", "session.logout.pending-queues",
    "session.logout.cleanup-incomplete", "bootstrap.restart.deferred",
    "bootstrap.resolution.deferred", "bootstrap.retry.deferred", "bootstrap.choice.deferred",
    "view.cross-tab-logout.cleanup-incomplete", "view.timer-ownership.release-failed",
    "view.phase.save-failed", "actions.timer-ownership.renewal-failed",
    "actions.duration.save-failed", "actions.auto-start.save-failed",
    "actions.selected-task.save-failed", "actions.selected-task.retarget-missing",
    "actions.task.save-failed", "actions.task.identity-failed", "actions.timer.save-failed",
    "actions.timer.clear-failed", "actions.timer.finish-failed",
    "actions.completion.notification-failed", "actions.completion.audio-init-failed",
    "actions.completion.audio-resume-failed", "actions.completion.permission-failed",
    "storage.failure", "i18n.locale.fallback", "startup.localization.unavailable",
    "startup.storage.unavailable", "startup.offline-shell.unavailable"
  ]);

  const frontendErrorTimestamps = [];
  const frontendErrorSamples = new Map();

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

  function hostNameFromHost(host) {
    const scope = (host && host.window) || {};
    const location = scope.location || (host && host.location) || null;
    const raw = location && (location.hostname || location.host) || "";
    return typeof raw === "string" ? raw : "";
  }

  function isDevHostName(value) {
    if (typeof value !== "string") return false;
    let host = value.trim().toLowerCase();
    if (!host) return false;
    if (host.startsWith("[")) {
      const end = host.indexOf("]");
      if (end > 0) host = host.slice(1, end);
    } else if (host === "::1") {
      return true;
    } else if (host.indexOf(":") !== host.lastIndexOf(":")) {
      host = host.split("%")[0];
    } else {
      host = host.split(":")[0].split("%")[0];
    }
    host = host.replace(/\.$/, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1" ||
      host.endsWith(".local") || host.endsWith(".localhost");
  }

  function isDevHost(host) {
    return isDevHostName(hostNameFromHost(host));
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
      beforeSend: (event) => scrubFinalEvent(event, settings.release),
      beforeBreadcrumb: scrubBreadcrumb,
      replaysSessionSampleRate: SESSION_SAMPLE_RATE,
      replaysOnErrorSampleRate: ERROR_SAMPLE_RATE,
      integrations: [
        sentry.replayIntegration({ maskAllText: true, maskAllInputs: true, blockAllMedia: true })
      ]
    });
    return true;
  }

  function safeErrorName(value) {
    return SAFE_ERROR_NAMES.has(value) ? value : "Error";
  }

  function scrubBreadcrumb(crumb) {
    try {
      const category = ["fetch", "xhr", "navigation", "console", "error.repeat"].includes(crumb.category)
        ? crumb.category : "diagnostic";
      const operation = category === "error.repeat" && SAFE_OPERATIONS.has(crumb.message)
        ? crumb.message : "[redacted]";
      return { category, message: operation };
    } catch {
      return null;
    }
  }

  // Rebuild rather than blacklist: SDK processors can attach new private fields at any depth.
  function scrubFinalEvent(event, release) {
    try {
      const operation = SAFE_OPERATIONS.has(event.tags?.["error.operation"])
        ? event.tags["error.operation"] : "browser.automatic";
      const values = event.exception?.values;
      const clean = {
        platform: "javascript", environment: ENVIRONMENT, release,
        level: ["fatal", "error", "warning", "info", "debug"].includes(event.level) ? event.level : "error",
        tags: { "error.operation": operation },
        exception: { values: (Array.isArray(values) && values.length ? values.slice(0, 5) : [{}])
          .map((value) => ({ type: safeErrorName(value.type), value: operation })) },
        breadcrumbs: Array.isArray(event.breadcrumbs)
          ? event.breadcrumbs.slice(-100).map(scrubBreadcrumb).filter(Boolean) : []
      };
      if (typeof event.event_id === "string" && /^[a-f0-9]{32}$/.test(event.event_id)) {
        clean.event_id = event.event_id;
      }
      if (Number.isFinite(event.timestamp)) clean.timestamp = event.timestamp;
      return clean;
    } catch {
      return null;
    }
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
    if (isDevHost(host)) return { enabled: false };
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
    frontendErrorSamples.clear();
  }

  function frontendErrorBackoff(repeats, randomValue = Math.random()) {
    const shift = Math.min(Math.max(repeats, 0), 4);
    const base = Math.min(FRONTEND_ERROR_DEDUP_MS * (2 ** shift), FRONTEND_ERROR_DEDUP_MAX_MS);
    const jitter = ((Number.isFinite(randomValue) ? randomValue : 0.5) * 2 - 1) * 0.2;
    return Math.max(base * (1 + jitter), FRONTEND_ERROR_DEDUP_MS * 0.5);
  }

  function frontendErrorSuppressed(key, nowMs) {
    const sample = frontendErrorSamples.get(key);
    if (!sample) {
      frontendErrorSamples.set(key, { last: nowMs, repeats: 0 });
      return false;
    }
    if (nowMs - sample.last < frontendErrorBackoff(sample.repeats)) {
      sample.repeats += 1;
      return true;
    }
    frontendErrorSamples.set(key, { last: nowMs, repeats: 0 });
    return false;
  }

  function noteFrontendErrorRepeat(operation) {
    try {
      const scope = typeof globalThis === "undefined" ? null : globalThis;
      const add = scope?.Sentry?.addBreadcrumb;
      if (typeof add === "function") add.call(scope.Sentry, {
        message: operation, category: "error.repeat", level: "warning"
      });
    } catch { /* breadcrumb never blocks reporting */ }
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
  // monitoring at warning level. Rate-safe (bounded per minute) and PII-free
  // by construction: the payload carries only the static operation tag plus
  // the error name, never the error message (task content, URLs, emails,
  // tokens, or credentials cannot survive a field that is never sent). It is
  // a no-op when no usable DSN is configured or the SDK failed to load.
  function reportFrontendError(error, operation) {
    try {
      if (typeof operation !== "string" || !operation) return false;
      if (error === null || error === undefined) return false;
      if (!canReportFrontendError()) return false;
      const scope = typeof globalThis === "undefined" ? null : globalThis;
      if (!scope || !scope.Sentry || typeof scope.Sentry.captureException !== "function") return false;
      const name = safeErrorName(error.name);
      const nowMs = Date.now();
      if (frontendErrorSuppressed(`${operation}\n${String(name).slice(0, 100)}`, nowMs)) {
        noteFrontendErrorRepeat(operation);
        return false;
      }
      if (frontendErrorRateLimited(nowMs)) return false;
      const wrapped = new Error(operation);
      wrapped.name = name;
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
    FRONTEND_ERROR_DEDUP_MS, FRONTEND_ERROR_DEDUP_MAX_MS,
    isUsableDsn, readMetaContent, releaseFromDocument, collectSettings, initializeSdk, start,
    isDevHostName, hostNameFromHost, isDevHost, frontendErrorBackoff,
    scrubFrontendErrorMessage, reportFrontendError, resetFrontendErrorRateLimitForTest
  });

  if (typeof document !== "undefined" && typeof document.querySelector === "function") {
    start({ document, window: typeof globalThis === "undefined" ? {} : globalThis });
  }
  return api;
});
