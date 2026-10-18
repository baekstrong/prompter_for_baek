// Bump this version whenever publishing a new application shell.
const APP_VERSION = '2';
const CACHE_PREFIX = 'prompter-shell-';
const CACHE_NAME = `${CACHE_PREFIX}v${APP_VERSION}`;
const APP_SHELL = [
  './',
  './index.html',
  './styles.css?v=2',
  './app.js?v=2',
  './core.js',
  './camera.js',
  './recording-store.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

const shellURLs = new Set(APP_SHELL.map(path => new URL(path, self.registration.scope).href));

self.addEventListener('install', event => {
  // Let an installed update wait until existing tabs close, including recording tabs.
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
});

self.addEventListener('message', event => {
  // The app sends this only after the user applies an update while it is idle.
  if (event.data?.type === 'ACTIVATE_UPDATE') event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      // Keep HTML and JS on the same installed version until the update is applied.
      const cache = await caches.open(CACHE_NAME);
      return (await cache.match(new URL('./index.html', scope).href)) ?? fetch(request);
    })());
    return;
  }

  // Ignore recording blobs, arbitrary fetches, and external media entirely.
  if (!shellURLs.has(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    return (await cache.match(request)) ?? fetch(request);
  })());
});
