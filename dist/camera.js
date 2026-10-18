import { beginRecordingSession, appendRecordingChunk, finishRecordingSession, getRecording } from './recording-store.js';

/**
 * Browser-only camera/recorder, with no runtime dependencies.
 * new CameraEngine({videoElement}); await open('user'|'environment');
 * await start(); await stop(reason) -> recording|null; close() releases hardware.
 * States: idle, opening, ready, recording, stopping, error.
 * Events: statechange {state}, recorded recording, error {message,error},
 * interrupted {message}, progress {durationMs,size,storageState}.
 * A recording is {id,blob,mimeType,extension,createdAt,durationMs,reason,complete,
 * size,persisted}. A recorded event is emitted at most once per nonempty take.
 * IndexedDB receives one-second chunks; fallback/backlog memory is bounded at
 * 64 MiB plus the recorder's final chunk. Saved takes are never auto-deleted.
 * A track muted for two seconds interrupts recording and releases its stream;
 * unmute before that deadline cancels the interruption.
 */
const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const MIME_TYPES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4',
  'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm',
];

function eventWithDetail(name, detail) {
  if (typeof CustomEvent === 'function') return new CustomEvent(name, { detail });
  const event = new Event(name);
  Object.defineProperty(event, 'detail', { value: detail });
  return event;
}
function now() { return globalThis.performance?.now() ?? Date.now(); }
function stopTracks(stream) { stream?.getTracks().forEach(track => track.stop()); }
function isConstraintError(error) { return ['OverconstrainedError', 'ConstraintNotSatisfiedError'].includes(error?.name); }
function readableError(error) {
  if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(error?.name)) return '카메라와 마이크 권한을 허용한 뒤 다시 연결해 주세요.';
  if (['NotFoundError', 'DevicesNotFoundError'].includes(error?.name)) return '카메라 또는 마이크를 찾지 못했습니다.';
  if (['NotReadableError', 'TrackStartError'].includes(error?.name)) return '카메라를 사용할 수 없습니다. 다른 앱에서 사용 중인지 확인해 주세요.';
  return error?.message || '카메라를 연결하지 못했습니다.';
}

export class CameraEngine extends EventTarget {
  constructor({ videoElement } = {}) {
    super();
    this.videoElement = videoElement;
    this._state = 'idle';
    this._stream = null;
    this._facing = 'user';
    this._generation = 0;
    this._openPromise = null;
    this._startPromise = null;
    this._take = null;
    this._trackListeners = [];
    this._trackMuteTimers = new Map();
    this._onVisibility = () => {
      if (globalThis.document?.visibilityState !== 'hidden') return;
      if (this._startPromise && !this._take) {
        ++this._generation;
        this._emit('interrupted', { message: '화면이 가려져 녹화 시작을 취소했습니다.' });
      }
      this._interrupt('화면이 가려져 녹화를 중지했습니다. 저장된 구간을 확인해 주세요.', 'visibility');
    };
    this._onPageHide = () => {
      this._interrupt('페이지를 떠나 녹화를 중지했습니다. 다음 접속 시 보관함에서 저장된 구간을 확인할 수 있습니다.', 'pagehide');
      this.close('pagehide');
    };
    globalThis.document?.addEventListener('visibilitychange', this._onVisibility);
    globalThis.window?.addEventListener('pagehide', this._onPageHide);
    if (videoElement) { videoElement.muted = true; videoElement.playsInline = true; }
  }

  get state() { return this._state; }
  get stream() { return this._stream; }
  get facing() { return this._facing; }
  get settings() { return this._stream?.getVideoTracks()[0]?.getSettings?.() || {}; }

  _emit(name, detail) { this.dispatchEvent(eventWithDetail(name, detail)); }
  _setState(state) {
    if (this._state === state) return;
    this._state = state;
    this._emit('statechange', { state });
  }
  _error(error, message = readableError(error), changeState = false) {
    if (changeState) this._setState('error');
    this._emit('error', { message, error });
  }
  _releaseStream() {
    this._clearTrackMuteTimers();
    this._trackListeners.forEach(([track, type, listener]) => track.removeEventListener(type, listener));
    this._trackListeners = [];
    const stream = this._stream;
    this._stream = null;
    if (this.videoElement) this.videoElement.srcObject = null;
    stopTracks(stream);
  }

  _clearTrackMuteTimers() {
    this._trackMuteTimers.forEach(timeout => clearTimeout(timeout));
    this._trackMuteTimers.clear();
  }

  async open(facing = 'user') {
    if (this._openPromise) return this._openPromise;
    if (this._take || this._startPromise) throw new Error('녹화 중에는 카메라를 바꿀 수 없습니다.');
    if (!['user', 'environment'].includes(facing)) throw new TypeError('Invalid camera facing.');
    if (this._stream && this._facing === facing && this._state === 'ready') return this._stream;
    const generation = ++this._generation;
    this._releaseStream();
    this._setState('opening');
    const operation = this._openCamera(facing, generation);
    this._openPromise = operation;
    try { return await operation; }
    finally { if (this._openPromise === operation) this._openPromise = null; }
  }

  async _openCamera(facing, generation) {
    let stream;
    try {
      if (!globalThis.navigator?.mediaDevices?.getUserMedia) throw new Error('카메라는 HTTPS 또는 localhost에서 지원되는 브라우저로 열어 주세요.');
      const mediaDevices = globalThis.navigator.mediaDevices;
      try {
        stream = await mediaDevices.getUserMedia({ video: {
          facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 },
        }, audio: true });
      } catch (error) {
        if (!isConstraintError(error) || generation !== this._generation) throw error;
        stream = await mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing } }, audio: true });
      }
      if (generation !== this._generation) { stopTracks(stream); return null; }
      if (!stream.getVideoTracks().length || !stream.getAudioTracks().length) {
        stopTracks(stream);
        throw new Error('영상과 음성 트랙을 모두 연결하지 못했습니다. 카메라·마이크를 확인해 주세요.');
      }
      this._stream = stream;
      this._facing = facing;
      stream.getTracks().forEach(track => {
        const onEnded = () => {
          if (this._stream !== stream) return;
          const activeTake = this._take;
          this._interrupt('카메라 또는 마이크 연결이 끊겨 녹화를 중지했습니다.', 'track-ended');
          this._releaseStream();
          if (!activeTake) this._error(new Error('Media track ended.'), '카메라 또는 마이크 연결이 끊겼습니다. 다시 연결해 주세요.', true);
        };
        const onUnmute = () => {
          clearTimeout(this._trackMuteTimers.get(track));
          this._trackMuteTimers.delete(track);
        };
        const onMute = () => {
          const take = this._take;
          if (this._stream !== stream || !take || take.reason || this._trackMuteTimers.has(track)) return;
          const timeout = setTimeout(() => {
            this._trackMuteTimers.delete(track);
            if (this._stream !== stream || this._take !== take || take.reason || !track.muted) return;
            this._interrupt('통화 등으로 카메라 또는 마이크 입력이 2초 이상 중단되어 녹화를 중지했습니다. 저장된 구간을 확인해 주세요.', 'track-muted');
            this._releaseStream();
          }, 2000);
          this._trackMuteTimers.set(track, timeout);
        };
        for (const [type, listener] of [['ended', onEnded], ['mute', onMute], ['unmute', onUnmute]]) {
          track.addEventListener(type, listener);
          this._trackListeners.push([track, type, listener]);
        }
      });
      if (this.videoElement) {
        this.videoElement.srcObject = stream;
        this.videoElement.muted = true;
        this.videoElement.playsInline = true;
        try { await this.videoElement.play?.(); } catch { /* A visible play control can resume preview. */ }
      }
      if (generation !== this._generation) return null;
      this._setState('ready');
      return stream;
    } catch (error) {
      if (generation !== this._generation) { stopTracks(stream); return null; }
      this._error(error, readableError(error), true);
      throw error;
    }
  }

  async switchCamera() {
    if (this._take || this._startPromise || this._openPromise) throw new Error('카메라 연결 또는 녹화 중에는 전환할 수 없습니다.');
    return this.open(this._facing === 'user' ? 'environment' : 'user');
  }

  async start() {
    if (this._startPromise) return this._startPromise;
    if (this._state !== 'ready' || !this._stream || this._take) throw new Error('먼저 카메라를 연결해 주세요.');
    if (this._stream.getTracks().some(track => track.muted)) {
      const error = new Error('카메라 또는 마이크 입력이 일시 중단되었습니다. 통화를 마친 뒤 다시 녹화를 시작해 주세요.');
      this._error(error);
      throw error;
    }
    if (globalThis.document?.visibilityState === 'hidden') {
      this._emit('interrupted', { message: '화면을 다시 연 뒤 녹화를 시작해 주세요.' });
      return false;
    }
    const operation = this._startRecording(this._generation, this._stream);
    this._startPromise = operation;
    try { return await operation; }
    finally { if (this._startPromise === operation) this._startPromise = null; }
  }

  async _startRecording(generation, stream) {
    if (typeof globalThis.MediaRecorder !== 'function') {
      const error = new Error('이 브라우저는 영상 녹화를 지원하지 않습니다. Safari 또는 Chrome 최신 버전을 사용해 주세요.');
      this._error(error);
      throw error;
    }
    const mimeType = MIME_TYPES.find(type => globalThis.MediaRecorder.isTypeSupported?.(type));
    const options = { videoBitsPerSecond: 4_000_000, audioBitsPerSecond: 128_000 };
    if (mimeType) options.mimeType = mimeType;
    let recorder;
    try { recorder = new globalThis.MediaRecorder(stream, options); }
    catch (error) { this._error(error); throw error; }
    const actualType = recorder.mimeType || mimeType || 'video/webm';
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const take = {
      id, recorder, mimeType: actualType, extension: actualType.includes('mp4') ? 'mp4' : 'webm',
      createdAt: new Date().toISOString(), startedAt: now(), nextIndex: 0, pending: new Map(),
      pendingBytes: 0, size: 0, writeChain: Promise.resolve(), storageActive: false,
      persistedChunks: 0, complete: true, reason: null, finalizing: false, interrupted: false,
    };
    take.done = new Promise(resolve => { take.resolve = resolve; });
    try {
      await beginRecordingSession({ id, mimeType: actualType, extension: take.extension, createdAt: take.createdAt, durationMs: 0 });
      take.storageActive = true;
    } catch (error) {
      this._error(error, '영상 보관함을 사용할 수 없어 임시 메모리로 녹화합니다. 약 64MB에 도달하면 자동 종료되므로 바로 다운로드해 주세요.');
    }
    if (generation !== this._generation || this._stream !== stream || this._state !== 'ready') return false;
    if (stream.getTracks().some(track => track.muted)) {
      this._emit('interrupted', { message: '카메라 또는 마이크 입력이 중단되어 녹화 시작을 취소했습니다.' });
      return false;
    }
    this._take = take;
    recorder.addEventListener('dataavailable', event => this._receiveChunk(take, event.data));
    recorder.addEventListener('stop', () => { void this._finalize(take); });
    recorder.addEventListener('error', event => {
      take.complete = false;
      this._error(event.error || new Error('MediaRecorder error'), '녹화 오류로 중지했습니다. 저장된 구간을 확인해 주세요.');
      this._requestStop(take, 'recorder-error');
    });
    try {
      take.startedAt = now();
      recorder.start(1000);
      this._setState('recording');
      return true;
    } catch (error) {
      this._take = null;
      take.resolve(null);
      this._error(error);
      throw error;
    }
  }

  _receiveChunk(take, blob) {
    if (take.finalized || !blob?.size) return;
    const index = take.nextIndex++;
    const durationMs = Math.max(0, now() - take.startedAt);
    take.pending.set(index, blob);
    take.pendingBytes += blob.size;
    take.size += blob.size;
    take.writeChain = take.writeChain.then(async () => {
      if (!take.storageActive) return;
      try {
        await appendRecordingChunk(take.id, index, blob, durationMs);
        take.pending.delete(index);
        take.pendingBytes -= blob.size;
        take.persistedChunks++;
      } catch (error) {
        take.storageActive = false;
        take.complete = false;
        this._error(error, '영상 저장 공간이 부족하거나 저장에 실패해 녹화를 중지했습니다. 회수된 영상을 지금 다운로드해 주세요.');
        this._requestStop(take, 'storage-error');
      }
    });
    this._emit('progress', { durationMs, size: take.size, storageState: take.storageActive ? 'persistent' : 'memory' });
    if (take.pendingBytes >= MEMORY_LIMIT_BYTES) {
      take.complete = false;
      this._error(new Error('Recording memory limit reached.'), '임시 녹화 메모리가 64MB에 도달해 중지했습니다. 영상을 지금 다운로드해 주세요.');
      this._requestStop(take, 'memory-limit');
    }
  }

  async stop(reason = 'user') {
    if (this._startPromise) {
      if (!this._take) ++this._generation;
      try { await this._startPromise; } catch { return null; }
    }
    const take = this._take;
    if (!take) return null;
    this._requestStop(take, reason);
    return take.done;
  }

  _requestStop(take, reason) {
    if (take.reason || take.finalizing || take.finalized) return;
    take.reason = reason;
    take.endedAt = now();
    if (reason !== 'user') take.complete = false;
    if (this._take === take) this._setState('stopping');
    take.stopTimeout = setTimeout(() => {
      // Encoding the final chunk can be slow on phones. A deadline must never
      // discard that chunk: only MediaRecorder's stop event ends a normal take.
      this._error(new Error('Waiting for the final recording chunk.'), '영상을 마무리하고 있습니다. 마지막 구간이 저장될 때까지 이 화면을 유지해 주세요.');
    }, 4000);
    try {
      if (take.recorder.state !== 'inactive') take.recorder.stop();
      // An automatic stop may already have queued dataavailable and stop.
      // Await those events rather than finalizing ahead of the final data.
    } catch (error) {
      take.complete = false;
      this._error(error, '녹화 종료 중 오류가 발생했습니다. 회수된 구간을 확인해 주세요.');
      queueMicrotask(() => { void this._finalize(take); });
    }
  }

  async _finalize(take) {
    if (take.finalizing || take.finalized) return take.done;
    take.finalizing = true;
    if (this._take === take) this._setState('stopping');
    clearTimeout(take.stopTimeout);
    if (!take.reason) { take.reason = 'recorder-ended'; take.complete = false; }
    const durationMs = Math.round(Math.max(0, (take.endedAt ?? now()) - take.startedAt));
    let recording = null;
    try {
      let queuedWrites;
      do { queuedWrites = take.writeChain; await queuedWrites; }
      while (queuedWrites !== take.writeChain);
      let saved;
      if (take.storageActive || take.persistedChunks) {
        try {
          await finishRecordingSession(take.id, { durationMs, reason: take.reason, complete: take.complete && take.storageActive });
        } catch (error) {
          take.complete = false;
          take.storageActive = false;
          this._error(error, '영상의 종료 정보를 저장하지 못했습니다. 회수된 영상을 다운로드해 주세요.');
        }
        try { saved = await getRecording(take.id); }
        catch (error) {
          take.complete = false;
          this._error(error, '저장된 영상을 다시 읽지 못했습니다. 보관함에서 복구를 다시 시도해 주세요.');
        }
      }
      const pieces = saved?.blob ? [saved.blob] : [];
      pieces.push(...[...take.pending.entries()].sort(([a], [b]) => a - b).map(([, blob]) => blob));
      const blob = new Blob(pieces, { type: take.mimeType });
      if (blob.size) {
        recording = {
          id: take.id, blob, mimeType: take.mimeType, extension: take.extension,
          createdAt: take.createdAt, durationMs, reason: take.reason,
          complete: take.complete && blob.size === take.size, size: blob.size,
          persisted: Boolean(saved && take.storageActive && saved.size === blob.size),
        };
      } else {
        this._error(new Error('No recording data was received.'), '회수할 영상 데이터가 없습니다. 카메라를 다시 연결해 주세요.');
      }
    } catch (error) {
      this._error(error, '영상 마무리 중 오류가 발생했습니다. 보관함의 저장된 구간을 확인해 주세요.');
    } finally {
      take.finalized = true;
      take.pending.clear();
      if (this._take === take) {
        this._clearTrackMuteTimers();
        this._take = null;
        this._setState(this._stream ? 'ready' : 'idle');
      }
      if (recording) this._emit('recorded', recording);
      take.resolve(recording);
    }
    return recording;
  }

  _interrupt(message, reason) {
    const take = this._take;
    if (!take || take.interrupted || take.finalizing || take.finalized) return;
    take.interrupted = true;
    this._emit('interrupted', { message });
    this._requestStop(take, reason);
  }

  /** Also cancels an outstanding permission request; its eventual stream closes. */
  close(reason = 'user') {
    ++this._generation;
    this._openPromise = null;
    this._releaseStream();
    const stopping = this.stop(reason);
    if (!this._take) this._setState('idle');
    return stopping;
  }

  /** Optional final teardown for an app that permanently discards this engine. */
  destroy() {
    globalThis.document?.removeEventListener('visibilitychange', this._onVisibility);
    globalThis.window?.removeEventListener('pagehide', this._onPageHide);
    return this.close();
  }
}
