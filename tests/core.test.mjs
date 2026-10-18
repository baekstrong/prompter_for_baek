import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, formatTime, nextScroll, recordingName } from '../dist/core.js';

test('corrupt saved preferences cannot put the script outside the screen', () => {
  const s = normalizeSettings({ width: 95, x: -100, y: 90, speed: 'bad', fontSize: 1000, mirror: 'false' });
  assert.equal(s.x, 47.5); assert.equal(s.y, 62); assert.equal(s.speed, 32); assert.equal(s.fontSize, 64); assert.equal(s.mirror, true);
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
