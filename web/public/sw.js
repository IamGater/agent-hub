// Caches only the static shell (hashed assets and icons). API calls, the WebSocket and the HTML
// page (it carries a per-response CSP nonce) always go to the network, so no session data is cached.
const CACHE = 'shell-v3';
// Hashed build files never change under the same name, so the cached copy is always right.
const HASHED = /^\/assets\/[\w.-]+$/;
// Icons and the manifest keep their names across releases: the network wins, the cache is a fallback.
const STABLE = /^\/(icon-\d+\.png|favicon\.svg|manifest\.webmanifest)$/;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (HASHED.test(url.pathname)) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match(event.request);
        if (hit) return hit;
        const res = await fetch(event.request);
        if (res.ok) await cache.put(event.request, res.clone());
        return res;
      }),
    );
  } else if (STABLE.test(url.pathname)) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        try {
          const res = await fetch(event.request);
          if (res.ok) await cache.put(event.request, res.clone());
          return res;
        } catch (err) {
          const hit = await cache.match(event.request);
          if (hit) return hit;
          throw err;
        }
      }),
    );
  }
});
