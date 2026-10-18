// Optional integration check: npm install --no-save playwright, or provide the
// absolute Playwright module path with PROMPTER_PLAYWRIGHT_MODULE.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const modulePath = process.env.PROMPTER_PLAYWRIGHT_MODULE;
const { chromium } = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright');
const browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], ...(process.env.PROMPTER_BROWSER_PATH ? { executablePath: process.env.PROMPTER_BROWSER_PATH } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['camera', 'microphone'], acceptDownloads: true });
const page = await context.newPage();
const failures = [];
page.on('pageerror', error => failures.push(error.message));
page.on('console', message => { if (message.type() === 'error') failures.push(message.text()); });
const url = process.env.PROMPTER_TEST_URL || 'http://127.0.0.1:4173/';
await mkdir('.artifacts', { recursive: true });
try {
  // A separate context blocks service-worker caching so the deterministic
  // storage delay actually reaches the camera module under test.
  const cancelContext = await browser.newContext({ serviceWorkers: 'block', permissions: ['camera', 'microphone'] });
  const cancelPage = await cancelContext.newPage();
  await cancelPage.route('**/camera.js', async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace('await beginRecordingSession(', 'await new Promise(resolve => setTimeout(resolve, 1000)); await beginRecordingSession(');
    await route.fulfill({ response, body });
  });
  await cancelPage.goto(url);
  await cancelPage.locator('#settings-button').click();
  await cancelPage.locator('#countdown-select').selectOption('0');
  await cancelPage.locator('#settings-dialog [data-close]').click();
  await cancelPage.locator('#open-camera').click();
  await cancelPage.waitForFunction(() => document.querySelector('#camera-status').textContent === '카메라 준비 완료');
  await cancelPage.locator('#record-button').click();
  await cancelPage.locator('#record-button').click();
  assert.equal(await cancelPage.locator('#record-button').isDisabled(), true);
  await cancelPage.waitForFunction(() => document.querySelector('#record-label').textContent === '녹화 시작');
  assert.equal(await cancelPage.locator('#take-count').textContent(), '0');
  await cancelContext.close();
  await page.goto(url);
  await page.locator('#script-input').fill('첫 문장입니다.\n둘째 문장입니다.\n\n문단 간격을 그대로 보존합니다.\n'.repeat(15));
  assert.match(await page.locator('#prompt-text').textContent(), /둘째 문장입니다.\n\n문단/);
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === '기기에 저장됨');
  await page.reload();
  assert.match(await page.locator('#script-input').inputValue(), /첫 문장입니다/);
  await page.screenshot({ path: '.artifacts/desktop.png', fullPage: true });
  await page.locator('#play-button').click();
  await page.waitForFunction(() => document.querySelector('#prompt-scroll').scrollTop > 8);
  await page.locator('#play-button').click();
  await page.locator('#rewind-button').click();
  assert.equal(await page.locator('#prompt-scroll').evaluate(el => el.scrollTop), 0);
  await page.locator('#settings-button').click();
  await page.locator('#countdown-select').selectOption('0');
  await page.locator('#settings-dialog [data-close]').click();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    Object.defineProperty(navigator, 'share', { configurable: true, value: () => Promise.reject(new Error('simulated share failure')) });
  });
  await page.locator('#open-camera').click();
  await page.waitForFunction(() => document.querySelector('#camera-status').textContent === '카메라 준비 완료');
  await page.locator('#record-button').click();
  await page.waitForFunction(() => document.querySelector('#record-label').textContent === '녹화 종료');
  assert.equal(await page.locator('#flip-button').isDisabled(), true);
  await page.waitForFunction(() => document.querySelector('#recording-time').textContent !== '00:00');
  await page.locator('#play-button').click();
  assert.equal(await page.locator('#record-label').textContent(), '녹화 종료');
  await page.locator('#record-button').click();
  await page.locator('#playback-dialog').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#playback-video').readyState >= 1);
  const video = await page.locator('#playback-video').evaluate(el => ({ width: el.videoWidth, height: el.videoHeight, duration: el.duration }));
  assert.ok(video.width > 0 && video.height > 0);
  assert.equal(await page.locator('#take-count').textContent(), '1');
  await page.locator('#share-button').click();
  assert.match(await page.locator('#playback-dialog #toast').textContent(), /공유하지 못했어요/);
  assert.equal(await page.locator('#playback-dialog #toast').isVisible(), true);
  const downloadPromise = page.waitForEvent('download'); await page.locator('#download-link').click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /^prompter-.*\.(mp4|webm)$/);
  await download.saveAs(`.artifacts/${download.suggestedFilename()}`);
  await page.locator('#playback-dialog [data-close]').click();
  // Native IndexedDB persistence, not an in-memory substitute.
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#take-count').textContent === '1');
  await page.locator('#library-button').click(); await page.locator('.take-play').click();
  await page.waitForFunction(() => document.querySelector('#playback-video').readyState >= 1);
  await page.locator('#playback-dialog [data-close]').click();
  await page.locator('#library-dialog [data-close]').click();
  // A visible rehearsal can run fully offline once the shell is installed.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true); await page.reload();
  await page.locator('#script-input').waitFor();
  assert.match(await page.locator('#script-input').inputValue(), /첫 문장입니다/);
  await context.setOffline(false);
  await page.setViewportSize({ width: 393, height: 852 });
  await page.screenshot({ path: '.artifacts/iphone-layout.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('#mobile-editor-button').click();
  await page.locator('#script-input').fill('모바일에서 수정한 대본\n\n줄바꿈 유지');
  await page.locator('#editor-close').click();
  assert.equal(await page.locator('#prompt-text').textContent(), '모바일에서 수정한 대본\n\n줄바꿈 유지');
  await page.locator('#open-camera').click();
  await page.waitForFunction(() => document.querySelector('#camera-status').textContent === '카메라 준비 완료');
  await page.screenshot({ path: '.artifacts/iphone-camera.png', fullPage: true });
  await page.setViewportSize({ width: 852, height: 393 });
  await page.waitForTimeout(250);
  await page.screenshot({ path: '.artifacts/landscape.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const recordBounds = await page.locator('#record-button').boundingBox();
  assert.ok(recordBounds.y + recordBounds.height <= 393, JSON.stringify(recordBounds));
  await page.locator('#camera-off-button').click();
  assert.equal(await page.locator('#camera-status').textContent(), '촬영 준비');
  assert.deepEqual(failures, []);
  console.log(JSON.stringify({ passed: ['script persistence', 'line breaks', 'scroll/pause/rewind', 'camera with synthetic video/audio', 'pending start cancellation', 'record/stop', 'playable recording', 'download', 'IndexedDB reload recovery', 'offline reload', 'mobile edit', 'portrait/landscape layouts', 'camera release'], video, consoleErrors: failures }, null, 2));
} finally { await browser.close(); }
