import http from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
};

function reply(response, status, body, headers = {}) {
  response.writeHead(status, {
    ...securityHeaders,
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(body);
}

function isWithin(root, path) {
  const difference = relative(root, path);
  return difference === '' || (!difference.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && difference !== '..' && !isAbsolute(difference));
}

export function createStaticServer({ root = resolve(projectRoot, 'dist') } = {}) {
  const rootPromise = realpath(root);
  return http.createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      reply(response, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent((request.url ?? '/').split('?')[0]);
    } catch {
      reply(response, 400, 'Invalid URL');
      return;
    }
    if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part === '..')) {
      reply(response, 403, 'Forbidden');
      return;
    }

    try {
      const canonicalRoot = await rootPromise;
      let filePath = resolve(canonicalRoot, `.${pathname}`);
      if (!isWithin(canonicalRoot, filePath)) {
        reply(response, 403, 'Forbidden');
        return;
      }
      let metadata = await stat(filePath);
      if (metadata.isDirectory()) {
        filePath = resolve(filePath, 'index.html');
        metadata = await stat(filePath);
      }
      const canonicalPath = await realpath(filePath);
      if (!isWithin(canonicalRoot, canonicalPath)) {
        reply(response, 403, 'Forbidden');
        return;
      }
      if (!metadata.isFile()) {
        reply(response, 404, 'Not found');
        return;
      }
      response.writeHead(200, {
        ...securityHeaders,
        'Content-Type': mimeTypes[extname(canonicalPath).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': metadata.size,
        'Cache-Control': 'no-cache',
      });
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      const stream = createReadStream(canonicalPath);
      stream.on('error', () => response.destroy());
      response.on('close', () => stream.destroy());
      stream.pipe(response);
    } catch (error) {
      reply(response, error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 500, error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'Not found' : 'Server error');
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4173);
  const host = process.env.HOST ?? '127.0.0.1';
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('PORT는 0부터 65535 사이의 정수여야 합니다.');
    process.exitCode = 1;
  } else {
    const server = createStaticServer();
    server.on('error', error => {
      console.error(`개발 서버를 시작할 수 없습니다: ${error.message}`);
      process.exitCode = 1;
    });
    server.listen(port, host, () => {
      const address = server.address();
      const displayHost = host.includes(':') ? `[${host}]` : host;
      console.log(`프롬프터: http://${displayHost}:${address.port}`);
      console.log('iPhone 카메라는 HTTPS 주소에서 사용할 수 있습니다.');
    });
  }
}
