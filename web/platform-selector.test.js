"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const selector = require("./platform-selector.js");

const APPLE_RELEASE = "https://github.com/Pomodoro-Everywhere/pomodorough-apple/releases/latest";
const DESKTOP_RELEASE = "https://github.com/Pomodoro-Everywhere/pomodorough-desktop/releases/latest";
const ANDROID_RELEASE = "https://github.com/Pomodoro-Everywhere/pomodorough-android/releases/latest";

test("detects supported operating systems and maps their native CTA", () => {
  const cases = [
    {
      name: "Android before Linux",
      userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9)",
      expected: { id: "android", label: "Get Android app", href: ANDROID_RELEASE }
    },
    {
      name: "iPhone",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
      expected: { id: "ios", label: "Get Apple app", href: APPLE_RELEASE }
    },
    {
      name: "iPad",
      userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)",
      expected: { id: "ipados", label: "Get Apple app", href: APPLE_RELEASE }
    },
    {
      name: "iPod",
      userAgent: "Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X)",
      expected: { id: "ios", label: "Get Apple app", href: APPLE_RELEASE }
    },
    {
      name: "iPadOS desktop user agent",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15",
      maxTouchPoints: 5,
      expected: { id: "ipados", label: "Get Apple app", href: APPLE_RELEASE }
    },
    {
      name: "macOS",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6)",
      expected: { id: "macos", label: "Get macOS app", href: APPLE_RELEASE }
    },
    {
      name: "Windows",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      expected: { id: "windows", label: "Get Windows app", href: DESKTOP_RELEASE }
    },
    {
      name: "Linux",
      userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
      expected: { id: "linux", label: "Get Linux app", href: DESKTOP_RELEASE }
    },
    {
      name: "unknown",
      userAgent: "PomodoroughTest/1.0",
      expected: { id: "unknown", label: "View native apps", href: "#native-options" }
    }
  ];

  for (const entry of cases) {
    const selection = selector.selectPlatform(entry.userAgent, entry.maxTouchPoints || 0);
    assert.equal(selection.id, entry.expected.id, entry.name);
    assert.equal(selection.label, entry.expected.label, entry.name);
    assert.equal(selection.href, entry.expected.href, entry.name);
  }
});

test("landing changes the native CTA without navigating", () => {
  const selectorSource = fs.readFileSync(path.join(__dirname, "platform-selector.js"), "utf8");
  const landingSource = fs.readFileSync(path.join(__dirname, "landing.js"), "utf8");
  let navigations = 0;
  const nativeLink = { textContent: "View native apps", href: "#native-options" };
  const platformName = { textContent: "Native apps" };
  const platformNote = { textContent: "Choose from available native apps below." };
  const context = {
    console,
    navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64)", maxTouchPoints: 0 },
    matchMedia: () => ({ matches: false }),
    document: {
      querySelector(value) {
        return {
          "[data-native-cta]": nativeLink,
          "[data-platform-name]": platformName,
          "[data-platform-note]": platformNote
        }[value];
      }
    },
    location: {
      href: "https://pomodorough.test/",
      origin: "https://pomodorough.test",
      pathname: "/",
      assign() { navigations += 1; },
      replace() { navigations += 1; }
    }
  };
  context.globalThis = context;
  context.window = context;
  vm.runInNewContext(selectorSource, context, { filename: "platform-selector.js" });
  vm.runInNewContext(landingSource, context, { filename: "landing.js" });

  assert.equal(nativeLink.textContent, "Get Linux app");
  assert.equal(nativeLink.href, DESKTOP_RELEASE);
  assert.equal(platformName.textContent, "Linux");
  assert.equal(context.location.href, "https://pomodorough.test/");
  assert.equal(navigations, 0);
});

test("legacy standalone root launch redirects to app while browser root does not", () => {
  const landingSource = fs.readFileSync(path.join(__dirname, "landing.js"), "utf8");
  let replacement = null;
  const context = {
    console,
    PomodoroughPlatform: selector,
    navigator: { userAgent: "PomodoroughTest/1.0", maxTouchPoints: 0 },
    matchMedia: () => ({ matches: true }),
    document: { querySelector: () => null },
    location: {
      origin: "https://pomodorough.test",
      pathname: "/",
      replace(value) { replacement = value; }
    }
  };
  context.globalThis = context;
  context.window = context;
  vm.runInNewContext(landingSource, context, { filename: "landing.js" });
  assert.equal(replacement, "/app");
});
