"use strict";

(function prepareDeparture() {
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches
    || navigator.standalone === true;
  if (standalone && window.location.pathname === "/") {
    window.location.replace("/app");
    return;
  }

  const selector = globalThis.PomodoroughPlatform;
  if (!selector) return;

  const selection = selector.selectPlatform(navigator.userAgent, navigator.maxTouchPoints);
  const nativeLink = document.querySelector("[data-native-cta]");
  const platformName = document.querySelector("[data-platform-name]");
  const platformNote = document.querySelector("[data-platform-note]");
  if (!nativeLink || !platformName || !platformNote) return;

  nativeLink.textContent = selection.label;
  nativeLink.href = selection.href;
  platformName.textContent = selection.name;
  platformNote.textContent = selection.id === "unknown"
    ? "Choose from available native apps below."
    : `Platform check suggests ${selection.name}. You still choose what opens.`;
})();
