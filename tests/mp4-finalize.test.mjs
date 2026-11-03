import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalizeMp4 } from '../dist/mp4-finalize.js';

// 3 s 64×48 fragmented MP4 (ffmpeg, 1 s fragments) whose first video
// fragment ends with Safari's -1 tick sample duration.
const fixture = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/safari-fragmented.mp4');
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf']);

function boxes(bytes, start = 0, end = bytes.length, path = '') {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), list = [];
  for (let at = start; at < end;) {
    const size = view.getUint32(at), type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const name = path ? `${path}/${type}` : type;
    list.push({ name, start: at, size, view });
    if (CONTAINERS.has(type)) list.push(...boxes(bytes, at + 8, at + size, name));
    at += size;
  }
  return list;
}
function videoTable(list, name) {
  const traks = list.filter(item => item.name === 'moov/trak');
  const video = traks.find(trak => list.some(item => item.name === 'moov/trak/mdia/hdlr' && item.start > trak.start &&
    item.start < trak.start + trak.size && item.view.getUint32(item.start + 16) === 0x76696465));
  return list.find(item => item.name === `moov/trak/mdia/minf/stbl/${name}` && item.start > video.start && item.start < video.start + video.size);
}

test('finalizeMp4 indexes a fragmented recording without touching sample data', async () => {
  const input = new Blob([await readFile(fixture)], { type: 'video/mp4' });
  const output = new Uint8Array(await (await finalizeMp4(input)).arrayBuffer());
  const list = boxes(output);
  assert.deepEqual(list.filter(item => !item.name.includes('/')).map(item => item.name), ['ftyp', 'moov', 'mdat']);
  assert.ok(!list.some(item => item.name.endsWith('mvex') || item.name === 'moof'));

  const stts = videoTable(list, 'stts');
  let samples = 0, ticks = 0;
  for (let i = 0, count = stts.view.getUint32(stts.start + 12); i < count; i++) {
    const n = stts.view.getUint32(stts.start + 16 + i * 8), delta = stts.view.getUint32(stts.start + 20 + i * 8);
    assert.ok(delta > 0 && delta < 600, `frame duration ${delta}`);
    samples += n; ticks += n * delta;
  }
  assert.equal(samples, 90);
  assert.ok(Math.abs(ticks - 1800) <= 20, `video lasts ${ticks / 600}s`);
  assert.ok(videoTable(list, 'stss'), 'keyframes stay marked');

  // Every video chunk offset points into mdat, and payload bytes are unchanged.
  const stco = videoTable(list, 'stco'), mdat = list.find(item => item.name === 'mdat');
  for (let i = 0, count = stco.view.getUint32(stco.start + 12); i < count; i++) {
    const offset = stco.view.getUint32(stco.start + 16 + i * 4);
    assert.ok(offset >= mdat.start + 8 && offset < mdat.start + mdat.size);
  }
  const source = new Uint8Array(await input.arrayBuffer());
  const payload = boxes(source).filter(item => item.name === 'mdat').reduce((sum, item) => sum + item.size - 8, 0);
  assert.equal(mdat.size - 8, payload);
});

test('finalizeMp4 returns a regular MP4 or other data unchanged', async () => {
  const plain = new Blob([new Uint8Array([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65])]);
  assert.equal(await finalizeMp4(plain), plain);
});
