import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createStaticServer } from '../scripts/serve.mjs';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');

async function withServer(callback, root = dist) {
  const server = createStaticServer({ root });
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(accept => server.close(accept));
  }
}

async function rawRequest(base, path) {
  return new Promise((accept, reject) => {
    const request = http.get(`${base}${path}`, response => {
      response.resume();
      response.once('end', () => accept(response));
    });
    request.once('error', reject);
  });
}

test('serves the application and PWA assets with correct types and security headers', async () => {
  await withServer(async base => {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.match(page.headers.get('permissions-policy'), /camera=\(self\)/);
    assert.match(page.headers.get('content-security-policy'), /object-src 'none'/);
    const manifest = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get('content-type'), /^application\/manifest\+json/);
    const module = await fetch(`${base}/app.js`);
    assert.equal(module.status, 200);
    assert.match(module.headers.get('content-type'), /^text\/javascript/);
    const icon = await fetch(`${base}/icons/icon-192.png`);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${base}/absent`)).status, 404);
    assert.equal((await fetch(base, { method: 'POST' })).status, 405);
    const head = await fetch(base, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  });
});

test('rejects encoded traversal, malformed encoding and symlinks outside the served root', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'prompter-static-'));
  const outside = `${temporary}-private.txt`;
  try {
    await writeFile(outside, 'private');
    await writeFile(resolve(temporary, 'index.html'), 'safe');
    await symlink(outside, resolve(temporary, 'escape.txt'));
    await withServer(async base => {
      assert.equal((await rawRequest(base, '/..%2fpackage.json')).statusCode, 403);
      assert.equal((await rawRequest(base, '/%2e%2e%5cpackage.json')).statusCode, 403);
      assert.equal((await rawRequest(base, '/%E0%A4%A')).statusCode, 400);
      assert.equal((await fetch(`${base}/escape.txt`)).status, 403);
    }, temporary);
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});

test('PWA manifest contains working PNG icons and an installable standalone shell', async () => {
  const manifest = JSON.parse(await readFile(resolve(dist, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.name, '프롬프터');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.start_url, './');
  for (const icon of manifest.icons) {
    const bytes = await readFile(resolve(dist, icon.src));
    assert.ok(bytes.length > 0);
    if (icon.type === 'image/png') {
      assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      const expected = Number(icon.sizes.split('x')[0]);
      assert.equal(bytes.readUInt32BE(16), expected);
      assert.equal(bytes.readUInt32BE(20), expected);
    }
  }
});

async function createServiceWorkerHarness() {
  const scope = 'https://example.test/prompter/';
  const handlers = new Map();
  const cached = new Map();
  const cacheStores = new Map([
    ['prompter-shell-v1', new Map()],
    ['prompter-shell-v2', new Map()],
    ['prompter-shell-v3', new Map()],
    ['prompter-shell-v4', new Map()],
    ['prompter-shell-v5', new Map()],
    ['prompter-shell-v6', cached],
    ['other-app-shell-v1', new Map()],
    ['recordings', new Map()],
  ]);
  const state = { online: true, networkHTML: null, openedCaches: [], deletedCaches: [], skipWaitingCalls: 0, claimedClients: 0, networkRequests: [] };
  const key = request => new URL(typeof request === 'string' ? request : request.url, scope).href;
  const network = async request => {
    state.networkRequests.push(key(request));
    if (!state.online) throw new Error('offline');
    const url = new URL(key(request));
    const localPath = url.pathname.slice(new URL(scope).pathname.length) || 'index.html';
    const bytes = localPath === 'index.html' && state.networkHTML !== null
      ? state.networkHTML
      : await readFile(resolve(dist, localPath));
    const extension = localPath.split('.').at(-1);
    const types = { html: 'text/html', js: 'text/javascript', css: 'text/css', webmanifest: 'application/manifest+json', svg: 'image/svg+xml', png: 'image/png' };
    const response = new Response(bytes, { headers: { 'content-type': types[extension] ?? 'application/octet-stream' } });
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  };
  runInNewContext(await readFile(resolve(dist, 'sw.js'), 'utf8'), {
    URL,
    Request,
    Response,
    Headers,
    fetch: network,
    caches: {
      async open(name) {
        state.openedCaches.push(name);
        if (!cacheStores.has(name)) cacheStores.set(name, new Map());
        const entries = cacheStores.get(name);
        return {
          async addAll(paths) {
            for (const path of paths) entries.set(key(path), await network(path));
          },
          async put(request, response) { entries.set(key(request), response.clone()); },
          async match(request) { return entries.get(key(request))?.clone(); },
          async delete(request) { return entries.delete(key(request)); },
        };
      },
      async keys() { return [...cacheStores.keys()]; },
      async delete(name) { state.deletedCaches.push(name); return cacheStores.delete(name); },
    },
    self: {
      registration: { scope },
      location: new URL('sw.js', scope),
      async skipWaiting() { state.skipWaitingCalls += 1; },
      clients: { async claim() { state.claimedClients += 1; } },
      addEventListener(name, callback) { handlers.set(name, callback); },
    },
  });
  async function dispatch(name, data = {}) {
    const pending = [];
    handlers.get(name)({ ...data, waitUntil(promise) { pending.push(promise); } });
    await Promise.all(pending);
  }
  async function request(url, mode = 'cors', method = 'GET') {
    let responsePromise;
    const pending = [];
    const request = new Request(url, { method, redirect: mode === 'navigate' ? 'manual' : 'follow' });
    Object.defineProperty(request, 'mode', { value: mode });
    handlers.get('fetch')({
      request,
      waitUntil(promise) { pending.push(promise); },
      respondWith(promise) { responsePromise = Promise.resolve(promise); },
    });
    const response = await responsePromise;
    await Promise.all(pending);
    return response;
  }
  return { scope, cached, cacheStores, state, dispatch, request };
}

test('service worker installs its complete shell, serves it offline and ignores recordings', async () => {
  const { scope, cached, state, dispatch, request } = await createServiceWorkerHarness();
  await dispatch('install');
  assert.ok(cached.has(`${scope}index.html`));
  assert.ok(cached.has(`${scope}app.js?v=6`));
  assert.ok(cached.has(`${scope}styles.css?v=6`));
  assert.ok(cached.has(`${scope}camera.js?v=6`));
  assert.ok(state.openedCaches.every(name => name === 'prompter-shell-v6'));
  assert.equal(state.skipWaitingCalls, 1);
  const installedRequests = state.networkRequests.length;
  state.online = false;

  const navigation = await request(scope, 'navigate');
  assert.equal(navigation.status, 200);
  assert.match(await navigation.text(), /<html/i);

  assert.equal((await request(`${scope}core.js?v=6`)).status, 200);
  assert.equal((await request(`${scope}app.js?v=6`)).status, 200);
  assert.equal((await request(`${scope}styles.css?v=6`)).status, 200);
  assert.equal((await request(`${scope}camera.js?v=6`)).status, 200);
  for (const url of [`${scope}recording.webm`, `${scope}recording.mp4`, 'https://elsewhere.test/video.mp4', `blob:${scope}recording`]) {
    assert.equal(await request(url), undefined, url);
    assert.equal(cached.has(url), false, url);
  }
  assert.equal(await request('https://example.test/another-app/core.js'), undefined);
  assert.equal(await request(`${scope}app.js`, 'cors', 'POST'), undefined);
  assert.equal(state.networkRequests.length, installedRequests + 1, 'only navigation tries the network before using the offline shell');
});

test('service worker refreshes navigation online and retains versioned assets for offline use', async () => {
  const { scope, state, dispatch, request } = await createServiceWorkerHarness();
  await dispatch('install');
  const installedRequests = state.networkRequests.length;
  const appHTML = await readFile(resolve(dist, 'index.html'), 'utf8');
  state.networkHTML = appHTML.replace('</body>', '<p>New network document</p></body>');
  assert.equal(await (await request(scope, 'navigate')).text(), state.networkHTML);
  assert.match(await (await request(`${scope}core.js?v=6`)).text(), /export /);
  assert.equal(await (await request(`${scope}app.js?v=6`)).text(), await readFile(resolve(dist, 'app.js'), 'utf8'));
  assert.equal(await (await request(`${scope}styles.css?v=6`)).text(), await readFile(resolve(dist, 'styles.css'), 'utf8'));
  assert.equal(state.networkRequests.length, installedRequests + 1);
  state.online = false;
  assert.equal(await (await request(scope, 'navigate')).text(), state.networkHTML);
});

test('emergency worker activates without app interaction and preserves unrelated caches', async () => {
  const { state, cacheStores, dispatch } = await createServiceWorkerHarness();
  await dispatch('install');
  assert.equal(state.skipWaitingCalls, 1);
  for (const data of [undefined, null, {}, 'ACTIVATE_UPDATE', { type: 'CHECK_UPDATE' }]) {
    await dispatch('message', { data });
    assert.equal(state.skipWaitingCalls, 1);
  }
  await dispatch('message', { data: { type: 'ACTIVATE_UPDATE' } });
  assert.equal(state.skipWaitingCalls, 2);
  await dispatch('activate');
  assert.deepEqual(state.deletedCaches, ['prompter-shell-v1', 'prompter-shell-v2', 'prompter-shell-v3', 'prompter-shell-v4', 'prompter-shell-v5']);
  assert.ok(cacheStores.has('recordings'));
  assert.ok(cacheStores.has('other-app-shell-v1'));
  assert.equal(state.claimedClients, 1);
});

test('emergency worker activates and removes old caches even when shell installation is offline', async () => {
  const { state, cacheStores, dispatch } = await createServiceWorkerHarness();
  state.online = false;
  await dispatch('install');
  assert.equal(state.skipWaitingCalls, 1);
  await dispatch('activate');
  assert.equal(cacheStores.has('prompter-shell-v1'), false);
  assert.equal(cacheStores.has('prompter-shell-v2'), false);
  assert.ok(cacheStores.has('recordings'));
  assert.equal(state.claimedClients, 1);
});
