const VERSION = "moroccoflow-v2";
const STATIC_CACHE = `${VERSION}-static`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) =>
        cache.addAll([
          self.registration.scope,
          `${self.registration.scope}manifest.webmanifest`,
          `${self.registration.scope}icons/moroccoflow.svg`,
        ]),
      ),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key)),
        ),
      ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    /\/api\//.test(url.pathname) ||
    request.headers.has("authorization")
  )
    return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(async () => (await caches.match(request)) || caches.match(self.registration.scope)),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const fresh = fetch(request).then((response) => {
        if (response.ok) {
          caches.open(STATIC_CACHE).then((cache) => cache.put(request, response.clone()));
        }
        return response;
      });
      return cached || fresh;
    }),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});
