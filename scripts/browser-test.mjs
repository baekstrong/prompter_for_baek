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
async function checkPromptPlacement(page, edge) {
  const stage = await page.locator('#camera-stage').boundingBox();
  const box = await page.locator('#prompt-box').boundingBox();
  const scroll = await page.locator('#prompt-scroll').boundingBox();
  assert.ok(box.width > 0 && scroll.height > 0);
  assert.ok(box.x >= stage.x - 1 && box.y >= stage.y - 1, JSON.stringify({ stage, box }));
  assert.ok(box.x + box.width <= stage.x + stage.width + 1);
  assert.ok(box.y + box.height <= stage.y + stage.height + 1);
  assert.equal(await page.locator('#prompt-box').getAttribute('data-lens-edge'), edge);
  if (edge === 'top') {
    assert.ok(box.width >= stage.width * .9);
    assert.ok(box.y + box.height <= stage.y + stage.height * .5 + 1);
  }
  else {
    assert.ok(box.width >= stage.width * .55 && box.width <= stage.width * .61);
    const gap = edge === 'left' ? box.x - stage.x : stage.x + stage.width - box.x - box.width;
    assert.ok(gap >= stage.width * .1 && gap <= stage.width * .17, JSON.stringify({ edge, stage, box }));
  }
}
async function setRange(page, id, value) {
  await page.locator(`#${id}`).evaluate((input, value) => {
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}
async function checkIndependentPromptSizing(page) {
  const box = page.locator('#prompt-box');
  const before = await box.boundingBox();
  await page.locator('#settings-button').click();
  const oldFont = await page.locator('#font-size').inputValue(), oldTextWidth = await page.locator('#prompt-width').inputValue();
  const oldFrameWidth = await page.locator('#frame-width').inputValue(), oldFrameHeight = await page.locator('#frame-height').inputValue();
  let narrowTextWidth;
  for (const [font, textWidth] of [[64, 45], [22, 100]]) {
    await setRange(page, 'font-size', font);
    await setRange(page, 'prompt-width', textWidth);
    const after = await box.boundingBox();
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(after[key] - before[key]) < 1, JSON.stringify({ key, before, after }));
    const text = await page.locator('#prompt-text').boundingBox();
    if (textWidth === 45) narrowTextWidth = text.width;
    else assert.ok(text.width > narrowTextWidth * 1.8);
  }
  await setRange(page, 'font-size', oldFont);
  await setRange(page, 'prompt-width', oldTextWidth);
  await setRange(page, 'frame-width', 45);
  const resizedWidth = await box.boundingBox();
  assert.ok(resizedWidth.width < before.width - 10);
  assert.ok(Math.abs(resizedWidth.height - before.height) < 1);
  await setRange(page, 'frame-height', 25);
  const resizedHeight = await box.boundingBox();
  assert.ok(resizedHeight.height < before.height - 10);
  assert.ok(Math.abs(resizedHeight.width - resizedWidth.width) < 1);
  await setRange(page, 'frame-width', oldFrameWidth);
  await setRange(page, 'frame-height', oldFrameHeight);
  await page.locator('#settings-dialog [data-close]').click();
}
await mkdir('.artifacts', { recursive: true });
try {
  // A separate context blocks service-worker caching so the deterministic
  // storage delay actually reaches the camera module under test.
  const cancelContext = await browser.newContext({ serviceWorkers: 'block', permissions: ['camera', 'microphone'] });
  const cancelPage = await cancelContext.newPage();
  await cancelPage.route('**/camera.js*', async route => {
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
  assert.equal(await page.locator('body').evaluate(body => body.classList.contains('focus-mode')), false);
  await page.locator('#record-button').click();
  await page.waitForFunction(() => document.querySelector('#record-label').textContent === '녹화 종료');
  assert.equal(await page.locator('#flip-button').isDisabled(), true);
  // A paused preview must recover without stopping the recording or replacing
  // the capture stream (a different stream would split the saved take).
  await page.locator('#camera-preview').evaluate(video => { window.testCaptureStream = video.srcObject; video.pause(); });
  await page.waitForFunction(() => !document.querySelector('#camera-preview').paused);
  assert.equal(await page.locator('#camera-preview').evaluate(video => video.srcObject === window.testCaptureStream), true);
  assert.equal(await page.locator('#record-label').textContent(), '녹화 종료');
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
  assert.equal(await page.locator('body').evaluate(body => body.classList.contains('focus-mode')), true);
  await checkPromptPlacement(page, 'top');
  await checkIndependentPromptSizing(page);
  await page.screenshot({ path: '.artifacts/iphone-camera.png', fullPage: true });
  await page.locator('#focus-button').click();
  assert.equal(await page.locator('body').evaluate(body => body.classList.contains('focus-mode')), false);
  await checkPromptPlacement(page, 'top');
  await page.screenshot({ path: '.artifacts/iphone-camera-basic.png', fullPage: true });
  await page.locator('#focus-button').click();
  assert.equal(await page.locator('body').evaluate(body => body.classList.contains('focus-mode')), true);
  await checkPromptPlacement(page, 'top');
  await page.screenshot({ path: '.artifacts/iphone-focus.png', fullPage: true });
  await page.setViewportSize({ width: 852, height: 393 });
  await page.waitForTimeout(250);
  await page.locator('#settings-button').click();
  await page.locator('#lens-side-select').selectOption('left');
  await page.locator('#settings-dialog [data-close]').click();
  await checkPromptPlacement(page, 'left');
  await checkIndependentPromptSizing(page);
  await page.screenshot({ path: '.artifacts/landscape.png' });
  await page.locator('#settings-button').click();
  await page.locator('#lens-side-select').selectOption('right');
  await page.locator('#settings-dialog [data-close]').click();
  await checkPromptPlacement(page, 'right');
  await page.screenshot({ path: '.artifacts/landscape-right.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const recordBounds = await page.locator('#record-button').boundingBox();
  assert.ok(recordBounds.y + recordBounds.height <= 393, JSON.stringify(recordBounds));
  await page.locator('#camera-off-button').click();
  assert.equal(await page.locator('#camera-status').textContent(), '촬영 준비');
  assert.deepEqual(failures, []);
  console.log(JSON.stringify({ passed: ['script persistence', 'line breaks', 'scroll/pause/rewind', 'camera with synthetic video/audio', 'pending start cancellation', 'paused preview recovery with same recording stream', 'record/stop', 'playable recording', 'download', 'IndexedDB reload recovery', 'offline reload', 'mobile edit', 'mobile camera auto focus', 'portrait/focus/landscape left and right lens placement', 'camera release'], video, consoleErrors: failures }, null, 2));
} finally { await browser.close(); }
