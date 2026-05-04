// port.folio Fab — Service Worker minimal
// Stratégie : cache-first pour le shell HTML, network-only pour l'API Yahoo
const CACHE = "fab-pf-v7-2026-04-27-005";
const SHELL = ["./", "./index.html", "./manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => null));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Network-only pour Yahoo Finance et proxies CORS (toujours frais)
  if (url.hostname.includes("yahoo") || url.hostname.includes("allorigins") ||
      url.hostname.includes("corsproxy") || url.hostname.includes("codetabs")) {
    return; // laisse passer normalement
  }
  // Cache-first pour le shell
  if (e.request.method === "GET" && (url.origin === self.location.origin || url.hostname === "unpkg.com")) {
    e.respondWith(
      caches.match(e.request).then(hit => {
        return hit || fetch(e.request).then(r => {
          if (r && r.ok) {
            const copy = r.clone();
            caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => null);
          }
          return r;
        }).catch(() => caches.match("./index.html"));
      })
    );
  }
});
