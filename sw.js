const CACHE = 'ota-v3';

// Self-hosted fonts (see scripts/fetch-fonts.mjs) precached for true offline use.
const FONTS = [
  'assistant-400-hebrew', 'assistant-400-latin',
  'assistant-500-hebrew', 'assistant-500-latin',
  'assistant-600-hebrew', 'assistant-600-latin',
  'assistant-700-hebrew', 'assistant-700-latin',
  'assistant-800-hebrew', 'assistant-800-latin',
  'frank-ruhl-libre-500-hebrew', 'frank-ruhl-libre-500-latin',
  'frank-ruhl-libre-700-hebrew', 'frank-ruhl-libre-700-latin',
  'frank-ruhl-libre-900-hebrew', 'frank-ruhl-libre-900-latin',
].map(n => `/fonts/${n}.woff2`);

const PRECACHE = [
  '/',
  '/app.js',
  '/dompurify.min.js',
  '/favicon.svg',
  '/og-image.webp',
  '/fonts.css',
  ...FONTS,
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

// Fetch: stale-while-revalidate for same-origin GET requests only.
// Cross-origin requests (e.g. the analytics beacon's host, any CDN) are left
// to the browser — intercepting them risks turning a transient network blip
// into a hard ERR_FAILED with no fallback.
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (new URL(event.request.url).origin !== location.origin) return;

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
