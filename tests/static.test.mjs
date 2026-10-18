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

async function createServiceWorkerHarness({ online = false } = {}) {
  const scope = 'https://example.test/prompter/';
  const handlers = new Map();
  const cached = new Map();
  const state = { openedCaches: [], deletedCaches: [], skipWaitingCalls: 0, claimedClients: 0, networkRequests: [] };
  const cache = {
    async addAll(paths) {
      for (const path of paths) {
        const url = new URL(path, scope);
        const localPath = url.pathname.slice(new URL(scope).pathname.length) || 'index.html';
        const bytes = await readFile(resolve(dist, localPath));
        cached.set(url.href, new Response(bytes));
      }
    },
    async match(request) {
      return cached.get(typeof request === 'string' ? request : request.url)?.clone();
    },
  };
  runInNewContext(await readFile(resolve(dist, 'sw.js'), 'utf8'), {
    URL,
    Response,
    fetch: async request => {
      state.networkRequests.push(request);
      if (online) return new Response('newer network shell');
      throw new Error('offline');
    },
    caches: {
      async open(name) { state.openedCaches.push(name); return cache; },
      async keys() { return ['prompter-shell-v1', 'prompter-shell-v2', 'other-app-shell-v1', 'recordings']; },
      async delete(name) { state.deletedCaches.push(name); return true; },
    },
    self: {
      registration: { scope },
      async skipWaiting() { state.skipWaitingCalls += 1; },
      clients: { async claim() { state.claimedClients += 1; } },
      addEventListener(name, callback) { handlers.set(name, callback); },
    },
  });
  async function dispatch(name, data = {}) {
    let pending;
    handlers.get(name)({ ...data, waitUntil(promise) { pending = promise; } });
    await pending;
  }
  async function request(url, mode = 'cors', method = 'GET') {
    let response;
    handlers.get('fetch')({
      request: { method, url, mode },
      respondWith(promise) { response = promise; },
    });
    return response;
  }
  return { scope, cached, state, dispatch, request };
}

test('service worker installs its complete shell, serves it offline and ignores recordings', async () => {
  const { scope, cached, state, dispatch, request } = await createServiceWorkerHarness();
  await dispatch('install');
  assert.ok(cached.has(`${scope}index.html`));
  assert.ok(cached.has(`${scope}app.js?v=2`));
  assert.ok(cached.has(`${scope}styles.css?v=2`));
  assert.deepEqual(state.openedCaches, ['prompter-shell-v2']);
  assert.equal(state.skipWaitingCalls, 0);

  const navigation = await request(scope, 'navigate');
  assert.equal(navigation.status, 200);
  assert.match(await navigation.text(), /<html/i);

  assert.equal((await request(`${scope}core.js`)).status, 200);
  assert.equal((await request(`${scope}app.js?v=2`)).status, 200);
  assert.equal((await request(`${scope}styles.css?v=2`)).status, 200);
  for (const url of [`${scope}recording.webm`, `${scope}recording.mp4`, 'https://elsewhere.test/video.mp4', `blob:${scope}recording`]) {
    assert.equal(await request(url), undefined, url);
    assert.equal(cached.has(url), false, url);
  }
  assert.equal(await request('https://example.test/another-app/core.js'), undefined);
  assert.equal(await request(`${scope}app.js`, 'cors', 'POST'), undefined);
  assert.equal(state.networkRequests.length, 0);
});

test('service worker keeps installed HTML and assets together until an update is applied', async () => {
  const { scope, state, dispatch, request } = await createServiceWorkerHarness({ online: true });
  await dispatch('install');
  assert.match(await (await request(scope, 'navigate')).text(), /<html/i);
  assert.match(await (await request(`${scope}core.js`)).text(), /export /);
  assert.equal(await (await request(`${scope}app.js?v=2`)).text(), await readFile(resolve(dist, 'app.js'), 'utf8'));
  assert.equal(await (await request(`${scope}styles.css?v=2`)).text(), await readFile(resolve(dist, 'styles.css'), 'utf8'));
  assert.equal(state.networkRequests.length, 0);
  assert.equal(state.skipWaitingCalls, 0);
});

test('service worker activates an update only on an explicit application request and preserves unrelated caches', async () => {
  const { state, dispatch } = await createServiceWorkerHarness();
  await dispatch('install');
  for (const data of [undefined, null, {}, 'ACTIVATE_UPDATE', { type: 'CHECK_UPDATE' }]) {
    await dispatch('message', { data });
    assert.equal(state.skipWaitingCalls, 0);
  }
  await dispatch('message', { data: { type: 'ACTIVATE_UPDATE' } });
  assert.equal(state.skipWaitingCalls, 1);
  await dispatch('activate');
  assert.deepEqual(state.deletedCaches, ['prompter-shell-v1']);
  assert.equal(state.claimedClients, 1);
});
