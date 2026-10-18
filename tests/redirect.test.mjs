import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const scope = 'https://example.test/prompter/';
const loginHTML = '<!doctype html><html><title>Sign in</title><form action="/auth/login">Sign in with ChatGPT</form></html>';

// Cache Storage preserves the final URL and redirect flag of fetched responses.
// Keep these properties when cloning fixtures so the VM can reproduce Safari's
// rejection of a redirected response for a navigation whose redirect mode is manual.
function fetchedResponse(body, { url = `${scope}index.html`, redirected = false, type = 'basic', headers = { 'content-type': 'text/html; charset=utf-8' }, status = 200 } = {}) {
  function attachMetadata(response) {
    const nativeClone = response.clone.bind(response);
    Object.defineProperties(response, {
      url: { value: url },
      redirected: { value: redirected },
      type: { value: type },
      clone: { value: () => attachMetadata(nativeClone()) },
    });
    return response;
  }
  return attachMetadata(new Response(body, { headers, status }));
}

function navigationRequest(url) {
  const request = new Request(url, { redirect: 'manual', credentials: 'include' });
  Object.defineProperties(request, {
    mode: { value: 'navigate' },
    destination: { value: 'document' },
  });
  return request;
}

function safariNavigationResponse(request, response) {
  if (request.redirect !== 'follow' && response.redirected) {
    throw new TypeError('Response served by service worker has redirections');
  }
  return response;
}

async function createHarness({ documentResponse, previousHTML } = {}) {
  const appHTML = await readFile(resolve(dist, 'index.html'), 'utf8');
  const listeners = new Map();
  const cacheStores = new Map();
  const state = { online: true, network: [], deletedCaches: [], claimedClients: 0, skipWaitingCalls: 0 };

  function key(request) {
    return new URL(typeof request === 'string' ? request : request.url, scope).href;
  }

  async function network(request, options) {
    const url = key(request);
    state.network.push({ url, options });
    if (!state.online) throw new Error('offline');
    if (url === scope || new URL(url).pathname.endsWith('/index.html')) {
      return (documentResponse ?? fetchedResponse(appHTML, { redirected: true })).clone();
    }
    const localPath = new URL(url).pathname.slice(new URL(scope).pathname.length);
    const body = await readFile(resolve(dist, localPath));
    const extension = localPath.split('.').at(-1);
    const types = { js: 'text/javascript', css: 'text/css', webmanifest: 'application/manifest+json', svg: 'image/svg+xml', png: 'image/png' };
    return fetchedResponse(body, {
      url,
      headers: { 'content-type': types[extension] ?? 'application/octet-stream' },
    });
  }

  async function openCache(name) {
    if (!cacheStores.has(name)) cacheStores.set(name, new Map());
    const entries = cacheStores.get(name);
    return {
      async addAll(requests) {
        const fetched = await Promise.all(requests.map(async request => [key(request), await network(request)]));
        for (const [url, response] of fetched) entries.set(url, response.clone());
      },
      async add(request) { entries.set(key(request), (await network(request)).clone()); },
      async put(request, response) { entries.set(key(request), response.clone()); },
      async match(request) { return entries.get(key(request))?.clone(); },
      async delete(request) { return entries.delete(key(request)); },
      async keys() { return [...entries.keys()].map(url => new Request(url)); },
    };
  }

  if (previousHTML) {
    const oldCache = await openCache('prompter-shell-v2');
    await oldCache.put(`${scope}index.html`, fetchedResponse(previousHTML, { redirected: true }));
    await oldCache.put(scope, fetchedResponse(previousHTML, { redirected: true }));
  }

  runInNewContext(await readFile(resolve(dist, 'sw.js'), 'utf8'), {
    URL, Request, Response, Headers, console,
    fetch: network,
    caches: {
      open: openCache,
      async keys() { return [...cacheStores.keys()]; },
      async delete(name) { state.deletedCaches.push(name); return cacheStores.delete(name); },
      async match(request) {
        for (const entries of cacheStores.values()) {
          const response = entries.get(key(request));
          if (response) return response.clone();
        }
        return undefined;
      },
    },
    self: {
      registration: { scope },
      location: new URL('sw.js', scope),
      clients: { async claim() { state.claimedClients += 1; } },
      async skipWaiting() { state.skipWaitingCalls += 1; },
      addEventListener(type, listener) { listeners.set(type, listener); },
    },
  });

  async function dispatch(type, values = {}) {
    const pending = [];
    listeners.get(type)?.({ ...values, waitUntil(promise) { pending.push(promise); } });
    await Promise.all(pending);
  }

  async function navigate(url = scope) {
    const request = navigationRequest(url);
    const pending = [];
    let responsePromise;
    listeners.get('fetch')({
      request,
      waitUntil(promise) { pending.push(promise); },
      respondWith(promise) { responsePromise = Promise.resolve(promise); },
    });
    const response = responsePromise && safariNavigationResponse(request, await responsePromise);
    await Promise.all(pending);
    return response;
  }

  return { appHTML, cacheStores, state, dispatch, navigate };
}

test('Safari regression fixture rejects a cached redirected response for manual navigation', async () => {
  const cachedIndex = fetchedResponse('<html>Cached application</html>', { redirected: true });
  assert.equal(cachedIndex.clone().redirected, true);
  assert.equal(cachedIndex.clone().url, `${scope}index.html`);
  assert.throws(
    () => safariNavigationResponse(navigationRequest(scope), cachedIndex),
    /Response served by service worker has redirections/,
  );
});

test('redirected application HTML is served with its complete body and without redirect metadata', async () => {
  const { appHTML, state, dispatch, navigate } = await createHarness();
  await dispatch('install');
  await dispatch('activate');
  for (const online of [true, false]) {
    state.online = online;
    for (const url of [scope, `${scope}index.html`]) {
      const response = await navigate(url);
      assert.ok(response, 'the application entry point is handled by the worker');
      assert.equal(response.status, 200);
      assert.equal(response.redirected, false);
      assert.match(response.headers.get('content-type'), /^text\/html/);
      assert.equal(await response.text(), appHTML);
    }
  }
});

test('sign-in redirects never become the cached application document', async () => {
  const authenticationResponses = [
    { redirected: true, url: 'https://auth.openai.com/log-in' },
    { redirected: true, url: `${scope}__sign-in` },
    { redirected: true, url: `${scope}index.html` },
    { redirected: false, url: `${scope}index.html` },
  ];
  for (const metadata of authenticationResponses) {
    const { cacheStores, dispatch } = await createHarness({
      documentResponse: fetchedResponse(loginHTML, metadata),
    });
    // Rejecting installation is also valid: authentication must not poison a shell.
    await dispatch('install').catch(() => {});
    for (const entries of cacheStores.values()) {
      for (const [url, response] of entries) {
        if (url !== scope && url !== `${scope}index.html`) continue;
        assert.notEqual(await response.clone().text(), loginHTML, `cached authentication HTML from ${metadata.url} at ${url}`);
      }
    }
  }
});

test('authentication and callback navigations bypass the application service worker', async () => {
  const { dispatch, navigate, state } = await createHarness();
  await dispatch('install');
  const previousNetworkCount = state.network.length;
  for (const path of ['auth/login', 'auth/callback?code=test&state=test', 'api/auth/callback', 'login', 'signin', '__sign-in']) {
    assert.equal(await navigate(new URL(path, scope).href), undefined, path);
  }
  assert.equal(state.network.length, previousNetworkCount, 'the browser handles authentication navigation directly');
});

test('redirected sign-in navigation reaches its final login URL without Safari redirect metadata', async () => {
  const finalURL = 'https://auth.openai.com/log-in';
  const { dispatch, navigate } = await createHarness({
    documentResponse: fetchedResponse(loginHTML, { redirected: true, url: finalURL }),
  });
  await dispatch('install');
  const response = await navigate();
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), finalURL);
  assert.equal(response.redirected, false);
});

test('a sign-in response that redirects back to itself shows recovery instead of looping', async () => {
  const { dispatch, navigate } = await createHarness({
    documentResponse: fetchedResponse(loginHTML, { redirected: true, url: `${scope}index.html` }),
  });
  await dispatch('install');
  const response = await navigate(`${scope}index.html`);
  assert.equal(response.status, 503);
  assert.equal(response.redirected, false);
  assert.match(await response.text(), /ChatGPT/);
});

test('activation discards a poisoned previous cache without carrying it into the new shell', async () => {
  const previousHTML = '<!doctype html><html><title>Old poisoned cache</title></html>';
  const { appHTML, cacheStores, state, dispatch, navigate } = await createHarness({ previousHTML });
  await dispatch('install');
  await dispatch('activate');
  assert.ok(state.deletedCaches.includes('prompter-shell-v2'));
  assert.equal(cacheStores.has('prompter-shell-v2'), false);
  state.online = false;
  const response = await navigate();
  assert.equal(response.redirected, false);
  assert.equal(await response.text(), appHTML);
  for (const entries of cacheStores.values()) {
    for (const [url, cachedResponse] of entries) {
      if (url !== scope && url !== `${scope}index.html`) continue;
      assert.notEqual(await cachedResponse.clone().text(), previousHTML);
    }
  }
});
