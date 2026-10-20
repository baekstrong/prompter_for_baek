import { beginRecordingSession, appendRecordingChunk, finishRecordingSession, getRecording, deleteRecording } from './recording-store.js';

/**
 * Browser-only camera/recorder, with no runtime dependencies.
 * new CameraEngine({videoElement}); await open('user'|'environment');
 * await start(); await stop(reason) -> recording|null; close() releases hardware.
 * States: idle, opening, ready, recording, stopping, error.
 * Events: statechange {state}, recorded recording, error {message,error}, warning {message},
 * interrupted {message}, progress {durationMs,size,storageState}.
 * A recording is {id,blob,mimeType,extension,createdAt,durationMs,reason,complete,
 * size,persisted}. A recorded event is emitted at most once per nonempty take.
 * IndexedDB receives one-second chunks; fallback/backlog memory is bounded at
 * 64 MiB plus the recorder's final chunk. Saved takes are never auto-deleted.
 * A track muted for five seconds interrupts recording and releases its stream;
 * unmute before that deadline cancels the interruption. An ended preview can
 * reconnect once, and foregrounding resumes paused inline video playback.
 */
const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const INPUT_MUTE_GRACE_MS = 5000;
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
function stopTracks(stream) { stream?.getTracks().filter(track => track.readyState !== 'ended').forEach(track => track.stop()); }
function isConstraintError(error) { return ['OverconstrainedError', 'ConstraintNotSatisfiedError'].includes(error?.name); }
function hasLiveTracks(stream) {
  return Boolean(stream?.getVideoTracks().length && stream?.getAudioTracks().length &&
    stream.getTracks().every(track => track.readyState !== 'ended'));
}
function standardCamera(devices, facing) {
  // Labels are optional and localized. Only act on a recognized direction and
  // lens; device order and opaque numeric names do not identify an optical lens.
  const front = /\b(front|user|facetime|true\s?depth|selfie)\b|전면|앞면|前置|フロント/i;
  const rear = /\b(back|rear|environment)\b|후면|뒷면|背面|後置|后置|リア/i;
  const otherLens = /\b(ultra|dual|triple|telephoto|tele|macro|virtual|desk\s?view)\b|초광각|망원|듀얼|트리플|울트라|超広角|超广角|望遠/i;
  const wide = /\b(wide|main|primary|standard)\b|광각|기본|메인|広角|广角/i;
  return devices.filter(device => device.kind === 'videoinput' && device.deviceId)
    .map(device => ({ device, label: device.label || '' }))
    .filter(({ label }) => (facing === 'user' ? front : rear).test(label) && !otherLens.test(label))
    .sort((a, b) => Number(wide.test(b.label)) - Number(wide.test(a.label)))[0]?.device;
}
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
    this._captureRequest = null;
    this._provisionalStreams = new Set();
    this._previewAttempt = null;
    this._previewErrorStream = null;
    this._previewRecoveryAttempted = false;
    this._resumeAfterPageShow = false;
    this._startPromise = null;
    this._take = null;
    this._trackListeners = [];
    this._trackMuteTimers = new Map();
    this._inputWarningActive = false;
    this._inputPauseReported = false;
    this._onVisibility = () => {
      if (globalThis.document?.visibilityState !== 'hidden') { this._resumeCamera(); return; }
      if (this._startPromise && !this._take) {
        ++this._generation;
        this._emit('interrupted', { message: '화면이 가려져 녹화 시작을 취소했습니다.' });
      }
      this._interrupt('화면이 가려져 녹화를 중지했습니다. 저장된 구간을 확인해 주세요.', 'visibility');
    };
    this._onPageHide = () => {
      this._resumeAfterPageShow = Boolean(this._stream || this._openPromise);
      this._interrupt('페이지를 떠나 녹화를 중지했습니다. 다음 접속 시 보관함에서 저장된 구간을 확인할 수 있습니다.', 'pagehide');
      this.close('pagehide');
    };
    this._onPageShow = () => {
      if (this._resumeAfterPageShow && !this._take && !this._startPromise) {
        this._resumeAfterPageShow = false;
        void this.open(this._facing).catch(() => {}); // open reports its error.
      } else this._resumeCamera();
    };
    this._onPreviewPause = () => { void this._playPreview(); };
    globalThis.document?.addEventListener('visibilitychange', this._onVisibility);
    globalThis.window?.addEventListener('pagehide', this._onPageHide);
    globalThis.window?.addEventListener('pageshow', this._onPageShow);
    for (const type of ['pause', 'loadedmetadata', 'stalled']) videoElement?.addEventListener?.(type, this._onPreviewPause);
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
    this._previewErrorStream = null;
    this._inputWarningActive = false;
    this._inputPauseReported = false;
    if (this.videoElement) this.videoElement.srcObject = null;
    stopTracks(stream);
    this._provisionalStreams.forEach(pending => stopTracks(pending));
    this._provisionalStreams.clear();
  }

  _discardStream(stream) {
    this._provisionalStreams.delete(stream);
    stopTracks(stream);
  }

  _clearTrackMuteTimers() {
    this._trackMuteTimers.forEach(timeout => clearTimeout(timeout));
    this._trackMuteTimers.clear();
  }

  async _playPreview(stream = this._stream) {
    if (!stream || this._stream !== stream || !this.videoElement || globalThis.document?.visibilityState === 'hidden') return true;
    if (this._previewAttempt?.stream === stream) return this._previewAttempt.promise;
    const attempt = { stream };
    this._previewAttempt = attempt;
    attempt.promise = (async () => {
      try {
        this.videoElement.muted = true;
        this.videoElement.playsInline = true;
        await this.videoElement.play?.();
        if (this._stream === stream) {
          this._previewErrorStream = null;
          if (this._state === 'error' && hasLiveTracks(stream) && !stream.getTracks().some(track => track.muted)) this._setState('ready');
        }
        return true;
      } catch (error) {
        if (this._stream !== stream) return false;
        if (this._previewErrorStream === stream) {
          if (!this._take && !this._startPromise) this._setState('error');
          return false;
        }
        this._previewErrorStream = stream;
        this._error(error, this._take ? '카메라 미리보기를 재생하지 못했습니다. 녹화 입력은 유지되며 화면을 다시 열면 재생을 시도합니다.' :
          '카메라 미리보기를 재생하지 못했습니다. 카메라 연결 버튼을 다시 눌러 주세요.', !this._take && !this._startPromise);
        return false;
      } finally { if (this._previewAttempt === attempt) this._previewAttempt = null; }
    })();
    return attempt.promise;
  }

  _resumeCamera() {
    const stream = this._stream;
    if (!stream || globalThis.document?.visibilityState === 'hidden') return;
    if (!hasLiveTracks(stream) && !this._take && !this._startPromise) {
      this._recoverPreview(stream);
      return;
    }
    void this._playPreview(stream);
    stream.getTracks().filter(track => track.muted).forEach(track => this._watchMutedTrack(stream, track));
  }

  _recoverPreview(stream) {
    if (this._stream !== stream || this._take || this._startPromise || this._openPromise ||
        globalThis.document?.visibilityState === 'hidden') return;
    if (this._previewRecoveryAttempted) {
      this._releaseStream();
      this._error(new Error('Media track ended after reconnecting.'), '카메라 연결이 다시 끊겼습니다. 다른 앱의 카메라 사용을 마친 뒤 다시 연결해 주세요.', true);
      return;
    }
    this._previewRecoveryAttempted = true;
    this._releaseStream();
    void this.open(this._facing, { recovery: true }).catch(() => {});
  }

  _watchMutedTrack(stream, track) {
    const take = this._take;
    if (this._stream !== stream || take?.reason || this._trackMuteTimers.has(track)) return;
    if (!this._inputWarningActive) {
      this._inputWarningActive = true;
      this._emit('warning', { message: '카메라 또는 마이크 입력이 잠시 멎었습니다. 연결을 확인하고 있습니다.' });
    }
    const timeout = setTimeout(() => {
      this._trackMuteTimers.delete(track);
      if (this._stream !== stream || !track.muted) return;
      if (this._take) {
        if (this._take !== take || take.reason) return;
        this._interrupt('카메라 또는 마이크 입력이 5초 이상 중단되어 녹화를 중지했습니다. 저장된 구간을 확인해 주세요.', 'track-muted');
        this._releaseStream();
      } else {
        // Safari's own capture pause intentionally mutes tracks. Do not override
        // that choice with an automatic getUserMedia request.
        this._setState('error');
        if (!this._inputPauseReported) {
          this._inputPauseReported = true;
          this._emit('warning', { message: '카메라 또는 마이크 입력이 중단된 상태입니다. 일시정지를 해제하거나 카메라 연결 버튼을 다시 눌러 주세요.' });
        }
      }
    }, INPUT_MUTE_GRACE_MS);
    this._trackMuteTimers.set(track, timeout);
  }

  async open(facing = this._facing, { recovery = false } = {}) {
    if (this._openPromise) return this._openPromise;
    if (this._take || this._startPromise) throw new Error('녹화 중에는 카메라를 바꿀 수 없습니다.');
    if (!['user', 'environment'].includes(facing)) throw new TypeError('Invalid camera facing.');
    if (!recovery) this._previewRecoveryAttempted = false;
    if (hasLiveTracks(this._stream) && !this._stream.getTracks().some(track => track.muted) && this._facing === facing && ['ready', 'error'].includes(this._state)) {
      await this._playPreview();
      return this._stream;
    }
    const generation = ++this._generation;
    this._releaseStream();
    this._setState('opening');
    const operation = this._openCamera(facing, generation);
    this._openPromise = operation;
    try { return await operation; }
    finally { if (this._openPromise === operation) this._openPromise = null; }
  }

  async _enumerateStandardCamera(mediaDevices, facing) {
    try { return standardCamera(await mediaDevices.enumerateDevices(), facing); }
    catch { return null; } // Permission-limited labels must not block capture.
  }

  async _acquireStream(mediaDevices, constraints, generation) {
    // In Safari a second capture request can mute the first. Wait for a canceled
    // permission request to settle and release its result before opening another.
    const previous = this._captureRequest;
    let release;
    const request = new Promise(resolve => { release = resolve; });
    this._captureRequest = request;
    try {
      if (previous) await previous;
      if (generation !== this._generation) return null;
      const stream = await mediaDevices.getUserMedia(constraints);
      if (generation !== this._generation) { stopTracks(stream); return null; }
      // Enumeration and source zoom can still await after permission resolves.
      // close() must release this stream during that provisional setup too.
      this._provisionalStreams.add(stream);
      return stream;
    } finally {
      if (this._captureRequest === request) this._captureRequest = null;
      release();
    }
  }

  async _requestStream(mediaDevices, facing, generation, device) {
    try {
      return await this._acquireStream(mediaDevices, { video: {
        facingMode: { ideal: facing }, ...(device ? { deviceId: { exact: device.deviceId } } : {}),
        width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 },
      }, audio: true }, generation);
    } catch (error) {
      if ((!isConstraintError(error) && !(device && error?.name === 'NotFoundError')) || generation !== this._generation) throw error;
      return this._acquireStream(mediaDevices, { video: { facingMode: { ideal: facing } }, audio: true }, generation);
    }
  }

  async _openCamera(facing, generation) {
    let stream;
    try {
      if (!globalThis.navigator?.mediaDevices?.getUserMedia) throw new Error('카메라는 HTTPS 또는 localhost에서 지원되는 브라우저로 열어 주세요.');
      const mediaDevices = globalThis.navigator.mediaDevices;
      let preferred = mediaDevices.enumerateDevices ? await this._enumerateStandardCamera(mediaDevices, facing) : null;
      if (generation !== this._generation) return null;
      stream = await this._requestStream(mediaDevices, facing, generation, preferred);
      if (!stream) return null;
      if (!preferred && mediaDevices.enumerateDevices) {
        preferred = await this._enumerateStandardCamera(mediaDevices, facing);
        if (generation !== this._generation) { this._discardStream(stream); return null; }
        if (preferred && preferred.deviceId !== stream.getVideoTracks()[0]?.getSettings?.().deviceId) {
          this._discardStream(stream);
          stream = await this._requestStream(mediaDevices, facing, generation, preferred);
          if (!stream) return null;
        }
      }
      if (generation !== this._generation) { this._discardStream(stream); return null; }
      if (!stream.getVideoTracks().length || !stream.getAudioTracks().length) {
        this._discardStream(stream);
        throw new Error('영상과 음성 트랙을 모두 연결하지 못했습니다. 카메라·마이크를 확인해 주세요.');
      }
      const videoTrack = stream.getVideoTracks()[0];
      const zoom = videoTrack.getCapabilities?.().zoom;
      if (videoTrack.applyConstraints && zoom && Number.isFinite(zoom.min) && Number.isFinite(zoom.max) && zoom.min <= 1 && zoom.max >= 1) {
        // Web zoom=1 denotes the browser's standard view, including WebKit's
        // normalization for virtual cameras. Apply to the source so saved video
        // and preview share the same framing; a CSS crop cannot do that.
        try { await videoTrack.applyConstraints({ advanced: [{ zoom: 1 }] }); }
        catch { /* Some browsers expose zoom but reject this constraint. */ }
      }
      if (generation !== this._generation) { this._discardStream(stream); return null; }
      this._stream = stream;
      this._provisionalStreams.delete(stream);
      this._facing = facing;
      stream.getTracks().forEach(track => {
        const onEnded = () => {
          if (this._stream !== stream) return;
          const activeTake = this._take;
          this._interrupt('카메라 또는 마이크 연결이 끊겨 녹화를 중지했습니다.', 'track-ended');
          if (activeTake || this._startPromise) {
            this._releaseStream();
            if (!activeTake) this._error(new Error('Media track ended.'), '카메라 연결이 끊겨 녹화 시작을 취소했습니다. 다시 연결해 주세요.', true);
          }
          else this._recoverPreview(stream);
        };
        const onUnmute = () => {
          clearTimeout(this._trackMuteTimers.get(track));
          this._trackMuteTimers.delete(track);
          if (!stream.getTracks().some(item => item.muted)) {
            this._inputWarningActive = false;
            this._inputPauseReported = false;
          }
          void this._playPreview(stream);
        };
        const onMute = () => this._watchMutedTrack(stream, track);
        for (const [type, listener] of [['ended', onEnded], ['mute', onMute], ['unmute', onUnmute]]) {
          track.addEventListener(type, listener);
          this._trackListeners.push([track, type, listener]);
        }
      });
      let previewReady = true;
      if (this.videoElement) {
        this.videoElement.srcObject = stream;
        previewReady = await this._playPreview(stream);
      }
      if (generation !== this._generation) return null;
      if (!hasLiveTracks(stream)) throw new Error('카메라를 연결하는 동안 입력이 중단되었습니다. 다시 연결해 주세요.');
      this._setState(previewReady ? 'ready' : 'error');
      stream.getTracks().filter(track => track.muted).forEach(track => this._watchMutedTrack(stream, track));
      return stream;
    } catch (error) {
      if (generation !== this._generation) { this._discardStream(stream); return null; }
      if (this._stream === stream) this._releaseStream();
      else this._discardStream(stream);
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
    if (!hasLiveTracks(this._stream)) throw new Error('카메라 연결이 끊겼습니다. 카메라를 다시 연결해 주세요.');
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
    const discard = () => { if (take.storageActive) deleteRecording(id).catch(() => {}); return false; };
    if (generation !== this._generation || this._stream !== stream || this._state !== 'ready') return discard();
    if (!hasLiveTracks(stream) || stream.getTracks().some(track => track.muted)) {
      discard();
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
        if (this._resumeAfterPageShow && globalThis.document?.visibilityState !== 'hidden') this._onPageShow();
        else this._resumeCamera();
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
    if (reason !== 'pagehide') this._resumeAfterPageShow = false;
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
    globalThis.window?.removeEventListener('pageshow', this._onPageShow);
    for (const type of ['pause', 'loadedmetadata', 'stalled']) this.videoElement?.removeEventListener?.(type, this._onPreviewPause);
    return this.close();
  }
}
