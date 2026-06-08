const CACHE = 'ota-v1';

const PRECACHE = [
  '/',
  '/app.js',
  '/dompurify.min.js',
  '/favicon.svg',
  '/og-image.webp',
];

// Install: precache core assets (allSettled so one failure won't abort install)
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.allSettled(PRECACHE.map(url => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

// Activate: delete old caches, claim clients immediately
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key !== CACHE).map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch: stale-while-revalidate for all GET requests
// Serves from cache instantly, updates cache in background.
// Next visit gets the fresh version.
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(event.request);

      const networkFetch = fetch(event.request).then(response => {
        if (response && response.ok) cache.put(event.request, response.clone());
        return response;
      }).catch(() => null);

      return cached ?? await networkFetch;
    })
  );
});
