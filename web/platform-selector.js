"use strict";

(function exposePlatformSelector(root, factory) {
  const selector = factory();
  if (typeof module === "object" && module.exports) module.exports = selector;
  if (root) root.PomodoroughPlatform = selector;
})(typeof globalThis === "undefined" ? this : globalThis, function createPlatformSelector() {
  const releases = Object.freeze({
    apple: "https://github.com/Pomodoro-Everywhere/pomodorough-apple/releases/latest",
    desktop: "https://github.com/Pomodoro-Everywhere/pomodorough-desktop/releases/latest",
    android: "https://github.com/Pomodoro-Everywhere/pomodorough-android/releases/latest"
  });

  const selections = Object.freeze({
    android: Object.freeze({ id: "android", name: "Android", label: "Get Android app", href: releases.android }),
    ios: Object.freeze({ id: "ios", name: "iPhone or iPod", label: "Get Apple app", href: releases.apple }),
    ipados: Object.freeze({ id: "ipados", name: "iPad", label: "Get Apple app", href: releases.apple }),
    macos: Object.freeze({ id: "macos", name: "Mac", label: "Get macOS app", href: releases.apple }),
    windows: Object.freeze({ id: "windows", name: "Windows", label: "Get Windows app", href: releases.desktop }),
    linux: Object.freeze({ id: "linux", name: "Linux", label: "Get Linux app", href: releases.desktop }),
    unknown: Object.freeze({ id: "unknown", name: "Native apps", label: "View native apps", href: "#native-options" })
  });

  function detectPlatform(userAgent, maxTouchPoints) {
    const value = String(userAgent || "");
    const touches = Number(maxTouchPoints) || 0;
    if (/Android/i.test(value)) return "android";
    if (/iPad/i.test(value)) return "ipados";
    if (/iPhone|iPod/i.test(value)) return "ios";
    if (/Macintosh/i.test(value) && touches > 1) return "ipados";
    if (/Macintosh|Mac OS X/i.test(value)) return "macos";
    if (/Windows/i.test(value)) return "windows";
    if (/Linux/i.test(value)) return "linux";
    return "unknown";
  }

  function selectPlatform(userAgent, maxTouchPoints) {
    return selections[detectPlatform(userAgent, maxTouchPoints)];
  }

  return Object.freeze({ releases, detectPlatform, selectPlatform });
});
