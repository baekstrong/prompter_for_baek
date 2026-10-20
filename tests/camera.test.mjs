import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CameraEngine } from '../dist/camera.js';
import { listRecordings, getRecording, saveRecording, deleteRecording } from '../dist/recording-store.js';

// A small transactional IndexedDB fake exercises our storage contract without a
// package dependency. Writes commit atomically, and failed chunks can be injected.
class FakeTransaction {
  constructor(db, mode) {
    this.db = db;
    this.mode = mode;
    this.maps = Object.fromEntries(Object.entries(db.maps).map(([name, map]) => [name, new Map(map)]));
    this.pending = 0;
    this.scheduleComplete();
  }
  scheduleComplete() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.pending || this.aborted) return;
      if (this.mode === 'readwrite') this.db.maps = this.maps;
      this.oncomplete?.();
    }, 0);
  }
  request(fn) {
    const request = {};
    this.pending++;
    clearTimeout(this.timer);
    queueMicrotask(() => {
      if (this.aborted) return;
      try { request.result = fn(); request.onsuccess?.(); }
      catch (error) {
        this.error = error;
        request.error = error;
        request.onerror?.();
        this.abort();
      }
      this.pending--;
      this.scheduleComplete();
    });
    return request;
  }
  abort() {
    if (this.aborted) return;
    this.aborted = true;
    clearTimeout(this.timer);
    queueMicrotask(() => this.onabort?.());
  }
  objectStore(name) {
    const keyOf = value => name === 'recordings' ? value.id : JSON.stringify([value.recordingId, value.index]);
    const map = this.maps[name];
    return {
      get: key => this.request(() => map.get(key)),
      getAll: () => this.request(() => [...map.values()]),
      put: value => this.request(() => { map.set(keyOf(value), value); }),
      add: value => this.request(() => {
        if (name === 'chunks' && this.db.failNextChunk) {
          this.db.failNextChunk = false;
          throw Object.assign(new Error('Quota exceeded'), { name: 'QuotaExceededError' });
        }
        const key = keyOf(value);
        if (map.has(key)) throw new Error('Duplicate key');
        map.set(key, value);
      }),
      delete: key => this.request(() => map.delete(key)),
      index: () => ({
        getAll: id => this.request(() => [...map.values()].filter(value => value.recordingId === id)),
        openCursor: id => {
          const values = [...map.entries()].filter(([, value]) => value.recordingId === id);
          let index = 0;
          const request = {};
          const next = () => {
            this.pending++;
            clearTimeout(this.timer);
            queueMicrotask(() => {
              const item = values[index++];
              request.result = item ? { delete: () => map.delete(item[0]), continue: next } : null;
              request.onsuccess?.();
              this.pending--;
              this.scheduleComplete();
            });
          };
          next();
          return request;
        },
      }),
    };
  }
}
class FakeDatabase {
  maps = { recordings: new Map(), chunks: new Map() };
  objectStoreNames = { contains: () => true };
  transaction(names, mode) { return new FakeTransaction(this, mode); }
  close() { this.onclose?.(); }
}
class FakeIndexedDB {
  constructor() { this.db = new FakeDatabase(); }
  open() {
    const request = {};
    queueMicrotask(() => { request.result = this.db; request.onsuccess?.(); });
    return request;
  }
}
class FakeTrack extends EventTarget {
  constructor(kind) { super(); this.kind = kind; this.readyState = 'live'; this.stops = 0; this.muted = false; }
  stop() { this.readyState = 'ended'; this.stops++; }
  end() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
  mute() { this.muted = true; this.dispatchEvent(new Event('mute')); }
  unmute() { this.muted = false; this.dispatchEvent(new Event('unmute')); }
  getSettings() { return { width: 1920, height: 1080, frameRate: 30 }; }
}
class FakeStream {
  tracks = [new FakeTrack('video'), new FakeTrack('audio')];
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
}
class FakeRecorder extends EventTarget {
  static instances = [];
  static isTypeSupported(type) { return type === 'video/mp4'; }
  constructor(stream, options) {
    super(); this.stream = stream; this.options = options; this.mimeType = options.mimeType;
    this.state = 'inactive'; this.starts = 0; this.stops = 0;
    FakeRecorder.instances.push(this);
  }
  start(timeslice) { this.state = 'recording'; this.starts++; this.timeslice = timeslice; }
  chunk(data) {
    const event = new Event('dataavailable');
    event.data = data instanceof Blob ? data : new Blob([data]);
    this.dispatchEvent(event);
  }
  stop() {
    this.stops++;
    this.state = 'inactive';
    queueMicrotask(() => { this.chunk('tail'); this.dispatchEvent(new Event('stop')); });
  }
}

let indexedDB;
let engines;
beforeEach(() => {
  indexedDB = new FakeIndexedDB();
  globalThis.indexedDB = indexedDB;
  globalThis.MediaRecorder = FakeRecorder;
  globalThis.document = new EventTarget();
  globalThis.document.visibilityState = 'visible';
  globalThis.window = new EventTarget();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => new FakeStream() } } });
  FakeRecorder.instances = [];
  engines = [];
});
afterEach(async () => {
  await Promise.all(engines.map(engine => engine.destroy()));
  indexedDB.db.close();
});
function engine() {
  const instance = new CameraEngine({ videoElement: { play: async () => {}, srcObject: null } });
  engines.push(instance);
  return instance;
}
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

test('one recorder starts once; concurrent stop emits one saved take with ordered chunks', async () => {
  const camera = engine();
  const recorded = [];
  camera.addEventListener('recorded', event => recorded.push(event.detail));
  await camera.open();
  assert.equal(camera.videoElement.muted, true);
  assert.equal(camera.videoElement.playsInline, true);
  await Promise.all([camera.start(), camera.start()]);
  const recorder = FakeRecorder.instances[0];
  assert.equal(FakeRecorder.instances.length, 1);
  assert.equal(recorder.starts, 1);
  assert.equal(recorder.timeslice, 1000);
  assert.equal(recorder.options.videoBitsPerSecond, 4_000_000);
  recorder.chunk('first');
  recorder.chunk('second');
  const [first, second] = await Promise.all([camera.stop(), camera.stop()]);
  assert.equal(first, second);
  assert.equal(recorded.length, 1);
  assert.equal(recorder.stops, 1);
  assert.equal(first.extension, 'mp4');
  assert.equal(first.complete, true);
  assert.equal(first.persisted, true);
  assert.equal(await first.blob.text(), 'firstsecondtail');
  assert.equal(camera.state, 'ready');
  const list = await listRecordings();
  assert.equal(list.length, 1);
  assert.equal('blob' in list[0], false);
  assert.equal(list[0].size, first.blob.size);
  assert.equal(await (await getRecording(first.id)).blob.text(), 'firstsecondtail');
  assert.equal(await camera.stop(), null);
});

test('closing a pending permission request stops the eventually granted tracks', async () => {
  let grant;
  navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { grant = resolve; });
  const camera = engine();
  const opening = camera.open();
  await camera.close();
  const stream = new FakeStream();
  grant(stream);
  assert.equal(await opening, null);
  assert.equal(camera.state, 'idle');
  assert.equal(camera.stream, null);
  assert.equal(stream.getTracks().every(track => track.stops === 1), true);
});

test('a new camera connection waits for the canceled permission response to release its tracks', async () => {
  const grants = [];
  navigator.mediaDevices.getUserMedia = () => new Promise(resolve => grants.push(resolve));
  const camera = engine();
  const staleOpen = camera.open();
  await camera.close();
  const currentOpen = camera.open('environment');
  assert.equal(grants.length, 1);
  const stale = new FakeStream();
  grants[0](stale);
  await staleOpen;
  await tick();
  assert.equal(grants.length, 2);
  assert.equal(stale.getTracks().every(track => track.stops === 1), true);
  const current = new FakeStream();
  grants[1](current);
  await currentOpen;
  assert.equal(camera.stream, current);
  assert.equal(camera.state, 'ready');
  assert.equal(camera.facing, 'environment');
  assert.equal(stale.getTracks().every(track => track.stops === 1), true);
  assert.equal(current.getTracks().every(track => track.stops === 0), true);
});

test('constraint errors alone retry, and permission denials preserve their cause', async () => {
  const constraints = [];
  navigator.mediaDevices.getUserMedia = async value => {
    constraints.push(value);
    if (constraints.length === 1) throw Object.assign(new Error('Too large'), { name: 'OverconstrainedError' });
    return new FakeStream();
  };
  const camera = engine();
  await camera.open('environment');
  assert.equal(constraints.length, 2);
  assert.equal(constraints[0].video.width.ideal, 1920);
  assert.deepEqual(constraints[1], { video: { facingMode: { ideal: 'environment' } }, audio: true });
  await camera.close();
  constraints.length = 0;
  const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
  navigator.mediaDevices.getUserMedia = async value => { constraints.push(value); throw denied; };
  await assert.rejects(camera.open(), error => error === denied);
  assert.equal(constraints.length, 1);
  assert.equal(camera.state, 'error');
});

test('a disconnected track stops once, retains data, and releases the other track', async () => {
  const camera = engine();
  const interruptions = [];
  camera.addEventListener('interrupted', event => interruptions.push(event.detail));
  await camera.open();
  await camera.start();
  const stream = camera.stream;
  FakeRecorder.instances[0].chunk('before');
  stream.getVideoTracks()[0].end();
  stream.getAudioTracks()[0].end();
  const recording = await camera.stop();
  assert.equal(interruptions.length, 1);
  assert.equal(recording.reason, 'track-ended');
  assert.equal(recording.complete, false);
  assert.equal(await recording.blob.text(), 'beforetail');
  assert.equal(camera.state, 'idle');
  assert.equal(stream.getAudioTracks()[0].stops, 1);
});

test('a track muted for five seconds interrupts once, preserves data, and releases hardware', async () => {
  const camera = engine();
  await camera.open();
  await camera.start();
  const stream = camera.stream;
  const interrupted = [];
  camera.addEventListener('interrupted', event => interrupted.push(event.detail));
  FakeRecorder.instances[0].chunk('before-call');
  const recorded = new Promise(resolve => camera.addEventListener('recorded', event => resolve(event.detail), { once: true }));
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, delay === 5000 ? 1 : delay, ...args);
  let recording;
  try {
    stream.getVideoTracks()[0].mute();
    stream.getAudioTracks()[0].mute();
    recording = await recorded;
  } finally { globalThis.setTimeout = originalSetTimeout; }
  assert.equal(interrupted.length, 1);
  assert.equal(recording.reason, 'track-muted');
  assert.equal(recording.complete, false);
  assert.equal(await recording.blob.text(), 'before-calltail');
  assert.equal(stream.getTracks().every(track => track.stops === 1), true);
  assert.equal(camera.state, 'idle');
  assert.equal(camera._trackMuteTimers.size, 0);
  assert.equal(camera._trackListeners.length, 0);
});

test('unmute cancels the interruption deadline and releasing a stream clears a pending deadline', async () => {
  const camera = engine();
  await camera.open();
  await camera.start();
  const stream = camera.stream;
  const videoTrack = stream.getVideoTracks()[0];
  const interruptions = [];
  camera.addEventListener('interrupted', event => interruptions.push(event.detail));
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, delay === 5000 ? 1 : delay, ...args);
  try {
    videoTrack.mute();
    videoTrack.unmute();
    await tick();
    assert.equal(camera.state, 'recording');
    assert.equal(camera._trackMuteTimers.size, 0);
    videoTrack.mute();
    await camera.close();
    await tick();
  } finally { globalThis.setTimeout = originalSetTimeout; }
  assert.equal(interruptions.length, 0);
  assert.equal(camera._trackMuteTimers.size, 0);
  assert.equal(camera._trackListeners.length, 0);
  assert.equal(FakeRecorder.instances[0].stops, 1);
});

test('hidden page and pagehide interrupt once and pagehide releases the camera', async () => {
  const camera = engine();
  await camera.open();
  const stream = camera.stream;
  await camera.start();
  FakeRecorder.instances[0].chunk('visible');
  document.visibilityState = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event('pagehide'));
  const recording = await camera.stop();
  assert.equal(recording.reason, 'visibility');
  assert.equal(recording.complete, false);
  assert.equal(stream.getTracks().every(track => track.stops === 1), true);
  assert.equal(camera.state, 'idle');
});

test('a visibility interruption cancels a pending start even when the user returns immediately', async () => {
  const camera = engine();
  const interruptions = [];
  camera.addEventListener('interrupted', event => interruptions.push(event.detail));
  await camera.open();
  const starting = camera.start();
  document.visibilityState = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  document.visibilityState = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(await starting, false);
  assert.equal(FakeRecorder.instances[0].starts, 0);
  assert.equal(camera.state, 'ready');
  assert.equal(interruptions.length, 1);
});

test('stop cancels a start that is still preparing durable storage', async () => {
  const camera = engine();
  await camera.open();
  const starting = camera.start();
  const stopping = camera.stop('cancelled');
  assert.equal(await starting, false);
  assert.equal(await stopping, null);
  assert.equal(FakeRecorder.instances[0].starts, 0);
  assert.equal(camera.state, 'ready');
});

test('quota failure auto-stops and returns saved prefix plus unsaved final chunks', async () => {
  const camera = engine();
  await camera.open();
  await camera.start();
  const recorder = FakeRecorder.instances[0];
  recorder.chunk('saved');
  await tick();
  indexedDB.db.failNextChunk = true;
  const recorded = new Promise(resolve => camera.addEventListener('recorded', event => resolve(event.detail), { once: true }));
  recorder.chunk('unsaved');
  const take = await recorded;
  assert.equal(take.reason, 'storage-error');
  assert.equal(take.persisted, false);
  assert.equal(take.complete, false);
  assert.equal(await take.blob.text(), 'savedunsavedtail');
  const recovery = await getRecording(take.id);
  assert.equal(await recovery.blob.text(), 'saved');
  assert.equal(recovery.complete, false);
  assert.equal((await listRecordings()).length, 1);
});

test('unavailable IndexedDB permits bounded memory recording and explicit later saving', async () => {
  globalThis.indexedDB = undefined;
  const camera = engine();
  await camera.open();
  await camera.start();
  FakeRecorder.instances[0].chunk('memory');
  const take = await camera.stop();
  assert.equal(take.persisted, false);
  assert.equal(take.complete, true);
  assert.equal(await take.blob.text(), 'memorytail');
  globalThis.indexedDB = indexedDB;
  await saveRecording(take);
  assert.equal(await (await getRecording(take.id)).blob.text(), 'memorytail');
  await deleteRecording(take.id);
  assert.deepEqual(await listRecordings(), []);
  assert.equal(await getRecording(take.id), null);
});

test('saved chunks are recoverable before recording has been finalized', async () => {
  const camera = engine();
  await camera.open();
  await camera.start();
  FakeRecorder.instances[0].chunk('recoverable');
  await tick();
  const [metadata] = await listRecordings();
  assert.equal(metadata.complete, false);
  assert.equal(metadata.reason, 'interrupted');
  assert.equal(await (await getRecording(metadata.id)).blob.text(), 'recoverable');
  await camera.stop();
});

test('persisted chunks leave the recording memory queue before finalization', async () => {
  const camera = engine();
  await camera.open();
  await camera.start();
  const recorder = FakeRecorder.instances[0];
  for (let index = 0; index < 60; index++) recorder.chunk(`chunk-${index};`);
  await camera._take.writeChain;
  assert.equal(camera._take.pending.size, 0);
  assert.equal(camera._take.pendingBytes, 0);
  assert.equal(camera._take.persistedChunks, 60);
  const take = await camera.stop();
  assert.equal(take.persisted, true);
  assert.equal((await take.blob.text()).includes('chunk-59;tail'), true);
});

test('a slow final encoder chunk is retained after the stop waiting notice', async () => {
  const camera = engine();
  await camera.open();
  await camera.start();
  const recorder = FakeRecorder.instances[0];
  recorder.chunk('first');
  const notices = [];
  camera.addEventListener('error', event => notices.push(event.detail.message));
  const originalSetTimeout = globalThis.setTimeout;
  // Advance only the four-second UI notice, while the encoder still completes
  // later. IndexedDB's normal task and timeout scheduling stays unchanged.
  globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, delay === 4000 ? 1 : delay, ...args);
  recorder.stop = () => {
    recorder.state = 'inactive';
    originalSetTimeout(() => { recorder.chunk('late-tail'); recorder.dispatchEvent(new Event('stop')); }, 20);
  };
  let take;
  try { take = await camera.stop(); }
  finally { globalThis.setTimeout = originalSetTimeout; }
  assert.equal(notices.some(message => message.includes('마무리')), true);
  assert.equal(await take.blob.text(), 'firstlate-tail');
  assert.equal(take.complete, true);
});

test('an ended ready stream is reopened rather than returned as a working camera', async () => {
  const camera = engine();
  await camera.open();
  const previous = camera.stream;
  previous.getVideoTracks()[0].readyState = 'ended';
  await camera.open();
  assert.notEqual(camera.stream, previous);
  assert.equal(camera.stream.getTracks().every(track => track.readyState === 'live'), true);
});

test('camera selection uses the physical standard rear lens, never ultra-wide or virtual lenses', async () => {
  const requests = [];
  navigator.mediaDevices.enumerateDevices = async () => [
    { kind: 'videoinput', deviceId: 'front', label: 'Front Camera' },
    { kind: 'videoinput', deviceId: 'ultra', label: 'Back Ultra Wide Camera' },
    { kind: 'videoinput', deviceId: 'triple', label: 'Back Triple Camera' },
    { kind: 'videoinput', deviceId: 'tele', label: 'Back Telephoto Camera' },
    { kind: 'videoinput', deviceId: 'main', label: 'Back Wide Angle Camera' },
  ];
  navigator.mediaDevices.getUserMedia = async constraints => { requests.push(constraints); return new FakeStream(); };
  const camera = engine();
  await camera.open('environment');
  assert.deepEqual(requests[0].video.deviceId, { exact: 'main' });
});

test('labels revealed after permission select the Korean standard front camera and stop the provisional stream first', async () => {
  const requests = [], streams = [];
  navigator.mediaDevices.enumerateDevices = async () => requests.length ? [
    { kind: 'videoinput', deviceId: 'ultra', label: '전면 초광각 카메라' },
    { kind: 'videoinput', deviceId: 'front', label: '전면 카메라' },
    { kind: 'videoinput', deviceId: 'back', label: '후면 광각 카메라' },
  ] : [{ kind: 'videoinput', deviceId: '', label: '' }];
  navigator.mediaDevices.getUserMedia = async constraints => {
    if (requests.length) assert.equal(streams[0].getTracks().every(track => track.stops === 1), true);
    requests.push(constraints);
    const stream = new FakeStream(); streams.push(stream); return stream;
  };
  const camera = engine();
  await camera.open('user');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].video.deviceId, { exact: 'front' });
  assert.equal(camera.stream, streams[1]);
});

test('unknown camera labels keep the browser facing selection without guessing by enumeration order', async () => {
  const requests = [];
  navigator.mediaDevices.enumerateDevices = async () => [
    { kind: 'videoinput', deviceId: 'a', label: 'Camera 0' },
    { kind: 'videoinput', deviceId: 'b', label: 'Camera 1' },
  ];
  navigator.mediaDevices.getUserMedia = async constraints => { requests.push(constraints); return new FakeStream(); };
  await engine().open('environment');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].video.deviceId, undefined);
});

test('supported source zoom is reset to standard 1x for both preview and recorder input', async () => {
  const stream = new FakeStream(), applied = [];
  stream.getVideoTracks()[0].getCapabilities = () => ({ zoom: { min: 1, max: 6, step: 0.1 } });
  stream.getVideoTracks()[0].applyConstraints = async constraints => { applied.push(constraints); };
  navigator.mediaDevices.getUserMedia = async () => stream;
  const camera = engine();
  await camera.open();
  await camera.start();
  assert.deepEqual(applied, [{ advanced: [{ zoom: 1 }] }]);
  assert.equal(FakeRecorder.instances[0].stream, stream);
  assert.equal(camera.videoElement.srcObject, stream);
});

test('a paused preview resumes after foregrounding without replacing a healthy recording stream', async () => {
  const camera = engine();
  let plays = 0;
  camera.videoElement.play = async () => { plays++; };
  await camera.open();
  const stream = camera.stream;
  document.visibilityState = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  await tick();
  assert.equal(camera.stream, stream);
  assert.equal(plays, 2);
});

test('preview playback failures are actionable rather than silently reporting a working preview', async () => {
  const camera = engine(), notices = [];
  camera.videoElement.play = async () => { throw Object.assign(new Error('Gesture required'), { name: 'NotAllowedError' }); };
  camera.addEventListener('error', event => notices.push(event.detail.message));
  await camera.open();
  assert.equal(notices.some(message => message.includes('미리보기')), true);
});

test('a persistent preview-only mute reports the pause and waits for an explicit reconnect', async () => {
  const camera = engine();
  await camera.open();
  const original = camera.stream, notices = [];
  camera.addEventListener('warning', event => notices.push(event.detail.message));
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, delay === 5000 ? 1 : delay, ...args);
  try {
    original.getVideoTracks()[0].mute();
    await tick();
  } finally { globalThis.setTimeout = originalSetTimeout; }
  assert.equal(camera.stream, original);
  assert.equal(original.getTracks().every(track => track.stops === 0), true);
  assert.equal(notices.some(message => message.includes('일시정지')), true);
  await camera.open();
  assert.notEqual(camera.stream, original);
  assert.equal(original.getTracks().every(track => track.stops === 1), true);
  assert.equal(camera.state, 'ready');
  assert.equal(FakeRecorder.instances.length, 0);
});

test('preview pause and stalled events resume playback while retaining the recorder source', async () => {
  const video = new EventTarget();
  let plays = 0;
  video.play = async () => { plays++; };
  const camera = new CameraEngine({ videoElement: video }); engines.push(camera);
  await camera.open();
  await camera.start();
  const stream = camera.stream, recorder = FakeRecorder.instances[0];
  video.dispatchEvent(new Event('pause')); await tick();
  video.dispatchEvent(new Event('stalled')); await tick();
  assert.equal(plays, 3);
  assert.equal(camera.state, 'recording');
  assert.equal(camera.stream, stream);
  assert.equal(recorder.stream, stream);
  assert.equal(recorder.stops, 0);
});

test('temporary input mute warns once for both tracks and survives past the former two-second deadline', async () => {
  const camera = engine(), warnings = [], deadlines = [];
  await camera.open(); await camera.start();
  camera.addEventListener('warning', event => warnings.push(event.detail.message));
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === 5000) { deadlines.push(delay); return originalSetTimeout(callback, 60_000, ...args); }
    return originalSetTimeout(callback, delay, ...args);
  };
  try {
    camera.stream.getVideoTracks()[0].mute();
    camera.stream.getAudioTracks()[0].mute();
    assert.deepEqual(deadlines, [5000, 5000]);
    assert.equal(warnings.length, 1);
    camera.stream.getTracks().forEach(track => track.unmute());
    assert.equal(camera._trackMuteTimers.size, 0);
    assert.equal(camera.state, 'recording');
    assert.equal(FakeRecorder.instances[0].stops, 0);
  } finally { globalThis.setTimeout = originalSetTimeout; }
});

test('a preview play failure exposes reconnect state, and retry resumes the same healthy stream', async () => {
  const camera = engine();
  camera.videoElement.play = async () => { throw new Error('play refused'); };
  await camera.open('environment');
  const stream = camera.stream;
  assert.equal(camera.state, 'error');
  camera.videoElement.play = async () => {};
  await camera.open();
  assert.equal(camera.state, 'ready');
  assert.equal(camera.facing, 'environment');
  assert.equal(camera.stream, stream);
});

test('preview playback failure during a recording preserves the active take and input tracks', async () => {
  const video = new EventTarget(); video.play = async () => {};
  const camera = new CameraEngine({ videoElement: video }); engines.push(camera);
  await camera.open(); await camera.start();
  const stream = camera.stream;
  video.play = async () => { throw new Error('play refused'); };
  video.dispatchEvent(new Event('pause')); await tick();
  assert.equal(camera.state, 'recording');
  assert.equal(camera.stream, stream);
  assert.equal(stream.getTracks().every(track => track.stops === 0), true);
  const take = await camera.stop();
  assert.equal(take.complete, true);
  assert.equal(camera.state, 'error');
});

test('a removed labeled camera safely falls back to facing selection without retrying permission denial', async () => {
  const requests = [];
  navigator.mediaDevices.enumerateDevices = async () => [{ kind: 'videoinput', deviceId: 'gone', label: 'Back Wide Camera' }];
  navigator.mediaDevices.getUserMedia = async constraints => {
    requests.push(constraints);
    if (constraints.video.deviceId) throw Object.assign(new Error('Gone'), { name: 'NotFoundError' });
    return new FakeStream();
  };
  await engine().open('environment');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], { video: { facingMode: { ideal: 'environment' } }, audio: true });
});

test('an unsupported source zoom does not prevent camera connection or invent a crop', async () => {
  const stream = new FakeStream(); let attempts = 0;
  stream.getVideoTracks()[0].getCapabilities = () => ({ zoom: { min: 2, max: 6 } });
  stream.getVideoTracks()[0].applyConstraints = async () => { attempts++; };
  navigator.mediaDevices.getUserMedia = async () => stream;
  const camera = engine(); await camera.open();
  assert.equal(attempts, 0);
  assert.equal(camera.stream, stream);
  assert.equal(camera.state, 'ready');
});

test('a preview-only ended input reconnects once and reports a repeated failure without a loop', async () => {
  const camera = engine(); await camera.open();
  const first = camera.stream;
  first.getVideoTracks()[0].end(); await tick();
  const second = camera.stream;
  assert.notEqual(second, first);
  assert.equal(camera.state, 'ready');
  second.getVideoTracks()[0].end(); await tick();
  assert.equal(camera.stream, null);
  assert.equal(camera.state, 'error');
});

test('pageshow reconnects a camera released by pagehide without restarting the take', async () => {
  const camera = engine(); await camera.open('environment');
  const stream = camera.stream;
  window.dispatchEvent(new Event('pagehide'));
  assert.equal(camera.stream, null);
  window.dispatchEvent(new Event('pageshow')); await tick();
  assert.notEqual(camera.stream, stream);
  assert.equal(camera.facing, 'environment');
  assert.equal(camera.state, 'ready');
  assert.equal(FakeRecorder.instances.length, 0);
});

for (const stage of ['enumeration', 'zoom']) {
  test(`canceling provisional ${stage} releases hardware before a replacement permission request`, async () => {
    const provisional = new FakeStream(), current = new FakeStream();
    let finishSetup, enteredSetup, requests = 0, enumerations = 0;
    const entered = new Promise(resolve => { enteredSetup = resolve; });
    const pending = new Promise(resolve => { finishSetup = resolve; });
    if (stage === 'enumeration') {
      navigator.mediaDevices.enumerateDevices = async () => {
        if (++enumerations === 2) { enteredSetup(); await pending; }
        return [];
      };
    } else {
      provisional.getVideoTracks()[0].getCapabilities = () => ({ zoom: { min: 1, max: 5 } });
      provisional.getVideoTracks()[0].applyConstraints = async () => { enteredSetup(); await pending; };
    }
    navigator.mediaDevices.getUserMedia = async () => {
      if (++requests === 1) return provisional;
      assert.equal(provisional.getTracks().every(track => track.stops === 1), true);
      return current;
    };
    const camera = engine(), firstOpen = camera.open();
    await entered;
    await camera.close();
    assert.equal(provisional.getTracks().every(track => track.stops === 1), true);
    await camera.open('environment');
    finishSetup();
    assert.equal(await firstOpen, null);
    assert.equal(camera.stream, current);
    assert.equal(camera.state, 'ready');
    assert.equal(provisional.getTracks().every(track => track.stops === 1), true);
  });
}

test('a prolonged preview mute exposes reconnect and recovers only when all input tracks unmute', async () => {
  const camera = engine(), warnings = [];
  await camera.open();
  camera.addEventListener('warning', event => warnings.push(event.detail.message));
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, delay === 5000 ? 1 : delay, ...args);
  try {
    camera.stream.getTracks().forEach(track => track.mute());
    await tick();
    assert.equal(camera.state, 'error');
    assert.equal(warnings.length, 2);
    camera.stream.getVideoTracks()[0].unmute(); await tick();
    assert.equal(camera.state, 'error');
    camera.stream.getAudioTracks()[0].unmute(); await tick();
    assert.equal(camera.state, 'ready');
  } finally { globalThis.setTimeout = originalSetTimeout; }
});
