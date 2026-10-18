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

test('service worker installs its complete shell, serves it offline and ignores recordings', async () => {
  const scope = 'https://example.test/prompter/';
  const handlers = new Map();
  const cached = new Map();
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
  let forcedUpdate = false;
  runInNewContext(await readFile(resolve(dist, 'sw.js'), 'utf8'), {
    URL,
    Response,
    fetch: async () => { throw new Error('offline'); },
    caches: { open: async () => cache },
    self: {
      registration: { scope },
      skipWaiting() { forcedUpdate = true; },
      addEventListener(name, callback) { handlers.set(name, callback); },
    },
  });
  let installation;
  handlers.get('install')({ waitUntil(promise) { installation = promise; } });
  await installation;
  assert.ok(cached.has(`${scope}index.html`));
  assert.equal(forcedUpdate, false);

  let navigation;
  handlers.get('fetch')({
    request: { method: 'GET', url: scope, mode: 'navigate' },
    respondWith(promise) { navigation = promise; },
  });
  assert.equal((await navigation).status, 200);
  assert.match(await (await navigation).text(), /<html/i);

  let shellAsset;
  handlers.get('fetch')({
    request: { method: 'GET', url: `${scope}core.js`, mode: 'cors' },
    respondWith(promise) { shellAsset = promise; },
  });
  assert.equal((await shellAsset).status, 200);
  for (const url of [`${scope}recording.webm`, 'https://elsewhere.test/video.mp4', `blob:${scope}recording`]) {
    let intercepted = false;
    handlers.get('fetch')({
      request: { method: 'GET', url, mode: 'cors' },
      respondWith() { intercepted = true; },
    });
    assert.equal(intercepted, false, url);
  }
});
