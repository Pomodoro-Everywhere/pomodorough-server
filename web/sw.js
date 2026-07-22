"use strict";

const CACHE_NAME = "pomodorough-shell-v13";
const CACHE_PREFIX = "pomodorough-shell-";
const SHELL = [
  "/index.html",
  "/app.css?v=13",
  "/sync-core.js?v=13",
  "/sync-storage.js?v=13",
  "/app.js?v=13",
  "/manifest.webmanifest",
  "/icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(activateShell());
});

async function activateShell() {
  const cacheNames = await caches.keys();
  const staleShells = cacheNames.filter(
    (cacheName) => cacheName.startsWith(CACHE_PREFIX) && cacheName !== CACHE_NAME
  );
  await Promise.all(staleShells.map((cacheName) => caches.delete(cacheName)));
  await self.clients.claim();
  if (staleShells.length === 0) return;
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  await Promise.all(windows.map((client) => client.navigate(client.url).catch(() => null)));
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) {
    event.respondWith(fetch(request));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (!SHELL.includes(`${url.pathname}${url.search}`)) {
    event.respondWith(fetch(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

async function networkFirstNavigation(request) {
  try {
    return await fetch(request);
  } catch (error) {
    const cached = await caches.match("/index.html");
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok && response.type === "basic") {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  }
  return response;
}
