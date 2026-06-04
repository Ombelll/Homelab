// Minimal service worker — exists so the dashboard is installable as a PWA.
// The dashboard is live data, so we deliberately do NOT cache responses
// (no stale metrics/alerts); the fetch handler is a network pass-through.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
