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
    script.onerror = () => {};
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

  const api = Object.freeze({
    SDK_VERSION, SDK_URL, SDK_INTEGRITY, SESSION_SAMPLE_RATE, ERROR_SAMPLE_RATE, ENVIRONMENT,
    isUsableDsn, readMetaContent, releaseFromDocument, collectSettings, initializeSdk, start
  });

  if (typeof document !== "undefined" && typeof document.querySelector === "function") {
    start({ document, window: typeof globalThis === "undefined" ? {} : globalThis });
  }
  return api;
});
