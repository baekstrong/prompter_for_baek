import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const failures = [];

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = await Promise.all(entries.map(entry => entry.isDirectory() ? filesIn(resolve(directory, entry.name)) : resolve(directory, entry.name)));
  return result.flat();
}

async function checkAsset(reference, source) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(reference)) return;
  let path;
  try {
    path = decodeURIComponent(reference.split(/[?#]/)[0]);
  } catch {
    failures.push(`잘못된 에셋 URL: ${reference}`);
    return;
  }
  if (!path) return;
  const destination = path.startsWith('/') ? resolve(dist, `.${path}`) : resolve(dirname(source), path);
  if (destination !== dist && !destination.startsWith(`${dist}/`)) {
    failures.push(`배포 폴더 밖의 에셋: ${reference}`);
    return;
  }
  try {
    const info = await stat(destination);
    if (info.isDirectory()) await stat(resolve(destination, 'index.html'));
  } catch {
    failures.push(`에셋 누락: ${source.slice(root.length + 1)} → ${reference}`);
  }
}

for (const directory of ['dist', 'scripts', 'tests']) {
  let files;
  try {
    files = await filesIn(resolve(root, directory));
  } catch {
    failures.push(`폴더 누락: ${directory}`);
    continue;
  }
  for (const file of files) {
    const extension = extname(file);
    if (extension === '.js' || extension === '.mjs') {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (result.status !== 0) failures.push(result.stderr.trim() || `구문 검사 실패: ${file}`);
    }
    if (!['.html', '.css', '.js', '.mjs', '.json', '.webmanifest', '.svg'].includes(extension)) continue;
    const content = await readFile(file, 'utf8');
    if (directory === 'dist' && /(?:Lorem ipsum|YOUR_(?:API_KEY|PROJECT|APP)|__REPLACE_ME__|vite\.svg|Hello Vite)/i.test(content)) {
      failures.push(`템플릿 문구가 남아 있습니다: ${file.slice(root.length + 1)}`);
    }
    if (extension === '.html') {
      for (const match of content.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) await checkAsset(match[1], file);
    }
    if (extension === '.css') {
      for (const match of content.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/gi)) await checkAsset(match[1], file);
    }
    if (directory === 'dist' && (extension === '.js' || extension === '.mjs')) {
      for (const match of content.matchAll(/(?:\bfrom\s*|\bimport\s*)["'](\.[^"']+)["']/g)) await checkAsset(match[1], file);
    }
    if (extension === '.webmanifest') {
      try {
        const manifest = JSON.parse(content);
        for (const icon of manifest.icons ?? []) await checkAsset(icon.src, file);
        await checkAsset(manifest.start_url, file);
      } catch (error) {
        failures.push(`Manifest 검사 실패: ${error.message}`);
      }
    }
  }
}

for (const path of ['index.html', 'styles.css', 'app.js', 'core.js', 'camera.js', 'recording-store.js', 'manifest.webmanifest', 'sw.js']) {
  try {
    await stat(resolve(dist, path));
  } catch {
    failures.push(`필수 파일 누락: dist/${path}`);
  }
}

if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log('검사 통과: JavaScript 구문, 로컬 에셋 연결, PWA manifest, 템플릿 문구');
}
