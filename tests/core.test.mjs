import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, promptLayout, landscapeLensSide, formatTime, nextScroll, recordingName } from '../dist/core.js';

test('corrupt saved preferences cannot put the script outside the screen', () => {
  const s = normalizeSettings({ width: 95, x: -100, y: 90, speed: 'bad', fontSize: 1000, mirror: 'false' });
  assert.equal(s.x, 47.5); assert.equal(s.y, 4); assert.equal(s.speed, 32); assert.equal(s.fontSize, 64); assert.equal(s.mirror, true);
});
test('old central positions migrate to the lens while preserving script preferences', () => {
  const settings = normalizeSettings({ x: 50, y: 35, fontSize: 40, speed: 18, width: 90, opacity: 50 });
  assert.equal(settings.y, 4);
  assert.equal(settings.fontSize, 40);
  assert.equal(settings.width, 90);
  assert.equal(settings.speed, 18);
  assert.equal(normalizeSettings({ ...settings, y: 60 }).y, 8);
  assert.equal(normalizeSettings({ ...settings, y: -10 }).y, 2);
});
test('portrait reading windows stay at the top even after dragging or entering focus mode', () => {
  for (const viewport of [{ width: 363, height: 487 }, { width: 393, height: 689 }]) {
    for (const y of [2, 4, 8, 62]) {
      const layout = promptLayout({ promptLayoutVersion: 2, y, width: 100 }, viewport);
      assert.equal(layout.edge, 'top');
      assert.ok(layout.left >= 0);
      assert.ok(layout.left + layout.width <= viewport.width);
      assert.ok(layout.top <= viewport.height * .08);
      assert.ok(layout.top + layout.height < viewport.height * .5);
      assert.ok(layout.height <= 210);
    }
  }
});
test('landscape windows and every drag extreme remain beside the selected lens', () => {
  const viewport = { width: 850, height: 328, landscape: true, topInset: 34 };
  for (const lensSide of ['left', 'right']) {
    for (const width of [45, 82, 100]) {
      for (const x of [0, 100]) {
        for (const y of [0, 100]) {
          const layout = promptLayout({ width, landscapeX: x, landscapeY: y }, { ...viewport, lensSide });
          assert.equal(layout.edge, lensSide);
          assert.ok(layout.width <= viewport.width * .34);
          assert.ok(layout.top >= 34);
          assert.ok(layout.top + layout.height <= viewport.height);
          if (lensSide === 'left') assert.ok(layout.left + layout.width <= viewport.width * .4);
          else assert.ok(layout.left >= viewport.width * .6);
        }
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
