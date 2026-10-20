import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROMPT_FRAMES, normalizeSettings, promptLayout, landscapeLensSide, formatTime, nextScroll, recordingName } from '../dist/core.js';

test('corrupt saved preferences cannot put the script outside the screen', () => {
  const s = normalizeSettings({ width: 95, x: -100, y: 90, speed: 'bad', fontSize: 1000, mirror: 'false' });
  assert.deepEqual(s.promptFrames, DEFAULT_PROMPT_FRAMES); assert.equal(s.speed, 32); assert.equal(s.fontSize, 64); assert.equal(s.mirror, true);
});
test('old narrow frames migrate to larger defaults while preserving reading preferences', () => {
  const settings = normalizeSettings({ promptLayoutVersion: 2, x: 50, y: 4, landscapeX: 100, fontSize: 40, speed: 18, width: 90, opacity: 50, lensSide: 'right' });
  assert.equal(settings.promptLayoutVersion, 3);
  assert.deepEqual(settings.promptFrames, DEFAULT_PROMPT_FRAMES);
  assert.equal(settings.fontSize, 40);
  assert.equal(settings.width, 90);
  assert.equal(settings.speed, 18);
  assert.equal(settings.opacity, 50);
  assert.equal(settings.lensSide, 'right');
});
test('default frames are large with inset landscape positioning and a mirrored right default', () => {
  const portrait = promptLayout({}, { width: 393, height: 727 });
  assert.ok(Math.abs(portrait.width / 393 - .94) < .001);
  assert.ok(Math.abs(portrait.height / 727 - .4) < .001);
  const viewport = { width: 852, height: 329, landscape: true, topInset: 34 };
  const left = promptLayout({}, viewport), right = promptLayout({}, { ...viewport, lensSide: 'right' });
  assert.ok(Math.abs(left.width / 852 - .58) < .001);
  assert.ok(Math.abs(left.height / 329 - .76) < .001);
  assert.ok(Math.abs(left.left / 852 - .13) < .001);
  assert.ok(Math.abs(right.left - (852 - left.left - left.width)) < .001);
});
test('font size and inner text width cannot change the outer frame', () => {
  for (const landscape of [false, true]) {
    const viewport = { width: 852, height: 329, landscape, topInset: 34 };
    const baseline = promptLayout({}, viewport);
    for (const fontSize of [22, 34, 64]) {
      for (const width of [45, 82, 100]) assert.deepEqual(promptLayout({ fontSize, width }, viewport), baseline);
    }
  }
});
test('portrait and landscape frame dimensions and positions save independently', () => {
  const settings = normalizeSettings();
  settings.promptFrames.landscape = { width: 70, height: 65, x: 50, y: 50 };
  const restored = normalizeSettings(JSON.parse(JSON.stringify(settings)));
  assert.deepEqual(restored.promptFrames.portrait, DEFAULT_PROMPT_FRAMES.portrait);
  assert.deepEqual(restored.promptFrames.landscape, { width: 70, height: 65, x: 50, y: 50 });
  const center = promptLayout(restored, { width: 852, height: 329, landscape: true });
  assert.ok(Math.abs(center.left + center.width / 2 - 426) < .001, 'window can be moved to the center');
});
test('frame dragging and resizing stay inside the screen including a very short stage', () => {
  for (const viewport of [{ width: 393, height: 727 }, { width: 852, height: 329, landscape: true, topInset: 34 }, { width: 320, height: 25, landscape: true, topInset: 34 }]) {
    for (const x of [-100, 50, 300]) {
      for (const y of [-100, 50, 300]) {
        const settings = normalizeSettings();
        settings.promptFrames[viewport.landscape ? 'landscape' : 'portrait'] = { width: 100, height: 90, x, y };
        const layout = promptLayout(settings, viewport);
        assert.ok(layout.left >= 0);
        assert.ok(layout.top >= 0);
        assert.ok(layout.left + layout.width <= viewport.width);
        assert.ok(layout.top + layout.height <= viewport.height);
      }
    }
  }
});
test('landscape lens detection respects explicit choices, notch insets, and both rotation angles', () => {
  assert.equal(landscapeLensSide({ preference: 'right', safeLeft: 44 }), 'right');
  assert.equal(landscapeLensSide({ safeLeft: 44, angle: 270 }), 'left');
  assert.equal(landscapeLensSide({ safeRight: 44, angle: 90 }), 'right');
  assert.equal(landscapeLensSide({ angle: 90 }), 'left');
  assert.equal(landscapeLensSide({ angle: -90 }), 'right');
});
test('countdown only accepts supported choices', () => {
  assert.equal(normalizeSettings({ countdown: 0 }).countdown, 0);
  assert.equal(normalizeSettings({ countdown: 999 }).countdown, 3);
});
test('scroll is time based, bounded, and cannot jump after a suspended frame', () => {
  assert.equal(nextScroll(10, 50, 40, 100), 12);
  assert.equal(nextScroll(98, 100, 40, 100), 100);
  assert.equal(nextScroll(10, 30000, 40, 100), 14);
  assert.equal(nextScroll(0, 50, 40, -20), 0);
});
test('recording times handle long takes and file names match the format', () => {
  assert.equal(formatTime(1830000), '30:30'); assert.equal(formatTime(3601000), '01:00:01');
  assert.match(recordingName({ createdAt: '2026-10-18T10:00:00Z', mimeType: 'video/mp4' }), /^prompter-\d{8}-\d{6}\.mp4$/);
});

test('prompt window stays between overlaid top and bottom controls', () => {
  const layout = promptLayout({ promptLayoutVersion: 3, promptFrames: { portrait: { width: 90, height: 90, x: 50, y: 90 } } },
    { width: 400, height: 800, topInset: 60, bottomInset: 100 });
  assert.ok(layout.top >= 60);
  assert.ok(layout.top + layout.height <= 700);
});
