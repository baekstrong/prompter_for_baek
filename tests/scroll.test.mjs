import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { clamp, nextScroll } from '../dist/core.js';

const appSource = await readFile(new URL('../dist/app.js', import.meta.url), 'utf8');
// Exercise the real animation, controls and progress handlers against a DOM
// whose scroll offset loses fractional pixels when it is assigned.
const scrollSource = appSource.slice(appSource.indexOf('function updateProgress()'), appSource.indexOf('\nlet drag;'));
assert.ok(scrollSource.includes('function tick(now)'), 'scroll controller must be present');

function scrollingApp({ quantize = Math.round, speed = 32, max = 100000 } = {}) {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) {
      const children = new Map();
      nodes.set(id, {
        style: {}, attributes: {}, listeners: new Map(),
        setAttribute(name, value) { this.attributes[name] = value; },
        querySelector(selector) {
          if (!children.has(selector)) children.set(selector, { textContent: '', setAttribute() {} });
          return children.get(selector);
        },
        addEventListener(name, callback) { this.listeners.set(name, callback); },
      });
    }
    return nodes.get(id);
  }

  let actualPosition = 0;
  const promptScroll = node('prompt-scroll');
  Object.defineProperties(promptScroll, {
    scrollHeight: { value: max + 500 },
    clientHeight: { value: 500 },
    scrollTop: {
      get() { return actualPosition; },
      set(value) { actualPosition = quantize(clamp(value, 0, max)); },
    },
  });

  const scheduled = new Map();
  let nextFrame = 0, now = 1000;
  const context = createContext({
    $: node, promptScroll, scriptInput: { value: '읽을 대본\n'.repeat(1000) },
    settings: { speed }, engine: { state: 'idle' },
    playing: false, frame: 0, lastFrame: 0, scrollPosition: 0,
    clamp, nextScroll, syncWakeLock() {}, toast() {},
    requestAnimationFrame(callback) { scheduled.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(id) { scheduled.delete(id); },
  });
  runInContext(scrollSource, context);

  function flush() {
    const callbacks = [...scheduled.values()];
    scheduled.clear();
    for (const callback of callbacks) callback(now);
  }
  return {
    get position() { return actualPosition; },
    get playing() { return context.playing; },
    pressPlay() { node('play-button').listeners.get('click')(); },
    rewind() { node('rewind-button').listeners.get('click')(); },
    manuallyScroll(position) {
      promptScroll.listeners.get('pointerdown')();
      promptScroll.scrollTop = position;
      promptScroll.listeners.get('scroll')();
    },
    advance(milliseconds, hz = 120) {
      flush();
      const frames = Math.round(milliseconds / 1000 * hz);
      for (let frame = 0; frame < frames; frame++) { now += 1000 / hz; flush(); }
    },
  };
}

for (const quantize of [Math.round, Math.floor]) {
  for (const hz of [60, 120]) {
    for (const speed of [8, 32]) {
      test(`scroll preserves ${speed}px/s for 10 seconds at ${hz}Hz with ${quantize.name} offsets`, () => {
        const app = scrollingApp({ quantize, speed });
        app.pressPlay();
        app.advance(10000, hz);
        assert.ok(Math.abs(app.position - speed * 10) <= 1, `expected ${speed * 10}px, got ${app.position}px`);
        assert.equal(app.playing, true);
      });
    }
  }
}

test('rewinding during playback resets the animation position as well as the DOM', () => {
  const app = scrollingApp();
  app.pressPlay();
  app.advance(2000);
  assert.ok(Math.abs(app.position - 64) <= 1);
  app.rewind();
  assert.equal(app.position, 0);
  app.advance(1000);
  assert.ok(Math.abs(app.position - 32) <= 1, `expected 32px after rewind, got ${app.position}px`);
});

test('resuming starts from the manually changed position and excludes the paused interval', () => {
  const app = scrollingApp({ quantize: Math.floor });
  app.pressPlay();
  app.advance(1000);
  app.manuallyScroll(250);
  assert.equal(app.playing, false);
  app.advance(60000);
  assert.equal(app.position, 250);
  app.pressPlay();
  app.advance(1000);
  assert.ok(Math.abs(app.position - 282) <= 1, `expected 282px after resume, got ${app.position}px`);
});

test('reaching the end pauses and replay starts from the beginning', () => {
  const app = scrollingApp({ max: 100 });
  app.pressPlay();
  app.advance(4000);
  assert.equal(app.playing, false);
  assert.ok(app.position >= 99);
  app.pressPlay();
  app.advance(1000);
  assert.ok(Math.abs(app.position - 32) <= 1, `expected 32px after replay, got ${app.position}px`);
  assert.equal(app.playing, true);
});
