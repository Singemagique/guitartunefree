/* TrueString service worker — network-first shell, cache-first static assets. */

const CACHE = 'truestring-v2';
const SHELL = './';
const SHELL_PATH = new URL(SHELL, self.location.href).pathname;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // The shell names the hashed bundles, so a stale shell freezes the whole app
  // on an old build; everything it names is either content-hashed or static.
  if (request.mode === 'navigate' || url.pathname === SHELL_PATH) {
    event.respondWith(networkFirst(request));
  } else {
    event.respondWith(cacheFirst(request));
  }
});

async function store(request, response) {
  if (!response.ok || response.type !== 'basic') return;
  const cache = await caches.open(CACHE);
  await cache.put(request, response.clone());
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    await store(request, response);
    return response;
  } catch (error) {
    // Offline: serve the last good copy, falling back to the cached app shell.
    const cached = await caches.match(request, { cacheName: CACHE });
    if (cached) return cached;
    const shell = await caches.match(SHELL, { cacheName: CACHE });
    if (shell) return shell;
    throw error;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { cacheName: CACHE });
  if (cached) return cached;

  const response = await fetch(request);
  await store(request, response);
  return response;
}
