"use strict";

(function prepareDeparture() {
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches
    || navigator.standalone === true;
  if (standalone && window.location.pathname === "/") {
    const search = window.location.search || "";
    const hash = window.location.hash || "";
    window.location.replace("/app" + search + hash);
    return;
  }

  // The public pages ship English markup; a loaded catalog relabels every
  // data-i18n element and then the platform recommendation below.
  const localization = loadPublicTranslations();

  const selector = globalThis.PomodoroughPlatform;
  if (!selector) return;

  const selection = selector.selectPlatform(navigator.userAgent, navigator.maxTouchPoints);
  const nativeLink = document.querySelector("[data-native-cta]");
  const platformName = document.querySelector("[data-platform-name]");
  const platformNote = document.querySelector("[data-platform-note]");
  if (!nativeLink || !platformName || !platformNote) return;

  nativeLink.href = selection.href;
  describePlatform(null);
  localization.then((translations) => { if (translations) describePlatform(translations); });

  function describePlatform(translations) {
    const tr = (key, values, fallback) => translations ? translations.t(key, values) : fallback;
    const name = tr(`landing.platform.${selection.id}.name`, {}, selection.name);
    nativeLink.textContent = tr(`landing.platform.${selection.id}.label`, {}, selection.label);
    platformName.textContent = name;
    platformNote.textContent = selection.id === "unknown"
      ? tr("landing.platform.unknownNote", {}, "Choose from available native apps below.")
      : tr("landing.platform.suggestion", { platform: name },
        `Platform check suggests ${name}. You still choose what opens.`);
  }

  // A missing catalog keeps the English markup; the page stays usable, so
  // the failure is logged rather than raised.
  function loadPublicTranslations() {
    const loader = globalThis.PomodoroughI18n?.loadBrowserI18n;
    if (typeof loader !== "function") return Promise.resolve(null);
    return loader().catch((error) => {
      console.warn("Pomodorough public page kept English:", error);
      return null;
    });
  }
})();
