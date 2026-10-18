// Emergency recovery release: old workers may fail before application JS loads.
const APP_VERSION = '3';
const CACHE_PREFIX = 'prompter-shell-';
const CACHE_NAME = `${CACHE_PREFIX}v${APP_VERSION}`;
const SCOPE = new URL(self.registration.scope);
const INDEX_URL = new URL('./index.html', SCOPE).href;
const DOCUMENT_MARKER = 'name="application-name" content="Prompter for Baek"';
const APP_SHELL = [
  './index.html', './styles.css?v=3', './app.js?v=3', './core.js',
  './camera.js', './recording-store.js', './manifest.webmanifest',
  './icons/icon.svg', './icons/icon-180.png', './icons/icon-192.png',
  './icons/icon-512.png', './icons/icon-maskable-512.png',
];
const shellURLs = new Set(APP_SHELL.map(path => new URL(path, SCOPE).href));

function expectedType(url) {
  const path = new URL(url, SCOPE).pathname;
  if (path.endsWith('.html')) return /^text\/html\b/i;
  if (path.endsWith('.js')) return /^(?:text|application)\/(?:javascript|ecmascript)\b/i;
  if (path.endsWith('.css')) return /^text\/css\b/i;
  if (path.endsWith('.webmanifest')) return /^application\/(?:manifest\+json|json)\b/i;
  if (path.endsWith('.svg')) return /^image\/svg\+xml\b/i;
  return /^image\/png\b/i;
}

async function verifiedResponse(response, url) {
  if (!response?.ok || ['opaque', 'opaqueredirect', 'error'].includes(response.type)) throw new Error('Unusable shell response');
  if (response.url && new URL(response.url).origin !== SCOPE.origin) throw new Error('Shell redirected outside its origin');
  if (!expectedType(url).test(response.headers.get('content-type') || '')) throw new Error('Unexpected shell content type');
  const body = await response.clone().blob();
  if (url === INDEX_URL && !(await body.text()).includes(DOCUMENT_MARKER)) throw new Error('Sign-in page is not the application');
  const headers = new Headers(response.headers);
  headers.delete('content-encoding'); headers.delete('content-length'); headers.delete('location');
  // clone() retains the redirect URL list. A new Response intentionally clears it,
  // which is required for Safari navigation responses with redirect mode=manual.
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

async function prepareShell() {
  // Validate the whole shell before writing any entry. Authentication responses
  // must never replace the app or stop the emergency worker from activating.
  const candidates = await Promise.all([...shellURLs].map(async url => {
    const response = await fetch(new Request(url, { credentials: 'same-origin', cache: 'reload' }));
    return [url, await verifiedResponse(response, url)];
  }));
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(candidates.map(([url, response]) => cache.put(url, response)));
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    try { await prepareShell(); }
    catch { await caches.delete(CACHE_NAME); }
    // The broken v2 page cannot press an update button. Replace its worker even
    // when signed out/offline; do not reload or navigate any already open page.
    await self.skipWaiting();
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type === 'ACTIVATE_UPDATE') event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

function recoveryPage() {
  const signIn = new URL('signin-with-chatgpt', SCOPE);
  signIn.searchParams.set('return_to', SCOPE.pathname);
  return new Response(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>프롬프터 다시 연결</title><body><h1>앱을 다시 연결해 주세요.</h1><p>인터넷 연결을 확인한 뒤 다시 열어 주세요. 기존 대본과 촬영 보관함은 지우지 않습니다.</p><p><a href="${signIn.href}" target="_top">ChatGPT로 로그인</a></p></body></html>`, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

async function navigationResponse(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    // Native manual redirects must reach the browser, including sign-in redirects.
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) return response;
    try {
      const safe = await verifiedResponse(response, INDEX_URL);
      await cache.put(INDEX_URL, safe.clone()).catch(() => {});
      return safe;
    } catch {
      if (!response.redirected) return response; // e.g. a direct 401 sign-in page
      if (response.url && response.url !== request.url) return Response.redirect(response.url, 302);
      return recoveryPage();
    }
  } catch {
    const cached = await cache.match(INDEX_URL);
    if (cached) { try { return await verifiedResponse(cached, INDEX_URL); } catch { /* Do not serve poisoned HTML. */ } }
    return recoveryPage();
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;
  if (request.mode === 'navigate') {
    // Leave sign-in, callbacks and all other routes to the browser/server.
    if (url.pathname !== SCOPE.pathname && url.pathname !== new URL(INDEX_URL).pathname) return;
    event.respondWith(navigationResponse(request));
    return;
  }
  if (!shellURLs.has(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) { try { return await verifiedResponse(cached, url.href); } catch { /* Fetch a valid asset instead. */ } }
    const response = await fetch(request);
    try {
      const safe = await verifiedResponse(response, url.href);
      await cache.put(request, safe.clone()).catch(() => {});
      return safe;
    } catch { return response; }
  })());
});
