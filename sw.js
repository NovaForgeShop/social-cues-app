const CACHE_NAME = "social-cues-static-v9";
const ASSETS = ["/manifest.webmanifest", "/icon.svg", "/sc-icon-192.png", "/sc-icon-512.png", "/sc-icon-1024.png", "/apple-touch-icon.png", "/favicon.png"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request));
    return;
  }
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

self.addEventListener("push", event => {
  let payload = {};
  try {
    payload = event.data?.json() || {};
  } catch {
    payload = { body: event.data?.text() || "You have a new Social Cues notification." };
  }
  const title = String(payload.title || "Social Cues").slice(0, 200);
  const options = {
    body: String(payload.body || "Open Social Cues to review the latest update.").slice(0, 1000),
    icon: "/sc-icon-192.png",
    badge: "/sc-icon-192.png",
    tag: String(payload.tag || "social-cues-notice").slice(0, 200),
    renotify: false,
    data: { url: String(payload.url || "/app") }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "/app", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => {
      const existing = clients.find(client => new URL(client.url).origin === self.location.origin);
      if (existing) {
        existing.navigate(targetUrl);
        return existing.focus();
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
