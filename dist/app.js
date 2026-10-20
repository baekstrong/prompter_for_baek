import { CameraEngine } from './camera.js?v=8';
import { listRecordings, getRecording, deleteRecording } from './recording-store.js';
import { DEFAULT_SCRIPT, DEFAULT_PROMPT_FRAMES, normalizeSettings, promptLayout, landscapeLensSide, clamp, formatTime, formatBytes, recordingName, nextScroll } from './core.js?v=8';

const $ = id => document.getElementById(id);
const scriptInput = $('script-input'), promptScroll = $('prompt-scroll'), promptText = $('prompt-text');
const engine = new CameraEngine({ videoElement: $('camera-preview') });
const STORAGE_KEY = 'prompter.workspace.v1';
let settings = normalizeSettings(), script = DEFAULT_SCRIPT, playing = false, frame = 0, lastFrame = 0, scrollPosition = 0;
let saveTimer, toastTimer, wakeLock = null, wakePending = false, countdownToken = 0, starting = false, cancelling = false;
let recordStart = 0, recordTimer, recordings = [], playbackURL = null, playbackFile = null, playbackToken = 0;
let editorReturnFocus = null, interruptedMessage = '', lastStorageCheck = 0;
const volatileTakes = new Map();
let serviceWorkerRegistration = null, applyingUpdate = false;
let promptGeometry = null;

function toast(message, duration = 5500) {
  const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
  (dialog || document.body).append($('toast'));
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, duration);
}

try {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
  if (saved && typeof saved === 'object') {
    if (typeof saved.script === 'string') script = saved.script;
    settings = normalizeSettings(saved.settings || {});
  }
} catch { $('save-status').textContent = '저장 내용을 불러오지 못함'; }
// Script text is always inserted with textContent, never interpreted as markup.
scriptInput.value = script;

function saveWorkspace() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ script: scriptInput.value, settings }));
    $('save-status').textContent = '기기에 저장됨';
  } catch {
    $('save-status').textContent = '자동 저장 불가';
    toast('대본을 자동 저장할 수 없어요. 브라우저 저장 공간을 확인해 주세요.');
  }
}
function scheduleSave() {
  $('save-status').textContent = '저장 중…'; clearTimeout(saveTimer);
  saveTimer = setTimeout(saveWorkspace, 250);
}
function renderScript() {
  promptText.textContent = scriptInput.value || '대본을 입력해 주세요.';
  $('character-count').textContent = `${scriptInput.value.length.toLocaleString('ko-KR')}자`;
  updateProgress();
}
function updateGrid() {
  const video = $('camera-preview'), stage = $('camera-stage'), grid = $('camera-grid');
  grid.hidden = !settings.grid || !engine.stream || !['ready', 'recording', 'stopping'].includes(engine.state) || !video.videoWidth || !video.videoHeight;
  if (grid.hidden) return;
  // Follow the contained video image, excluding any letterboxing around it.
  const scale = Math.min(stage.clientWidth / video.videoWidth, stage.clientHeight / video.videoHeight);
  const width = video.videoWidth * scale, height = video.videoHeight * scale;
  Object.assign(grid.style, { width: `${width}px`, height: `${height}px`, left: `${(stage.clientWidth - width) / 2}px`, top: `${(stage.clientHeight - height) / 2}px` });
}
function renderPromptLayout() {
  const stage = $('camera-stage'), box = $('prompt-box');
  const rect = stage.getBoundingClientRect(), toolbar = document.querySelector('.studio-top').getBoundingClientRect();
  const landscape = matchMedia('(orientation: landscape)').matches && (matchMedia('(max-height: 540px)').matches || matchMedia('(pointer: coarse)').matches);
  const style = getComputedStyle(stage);
  const lensSide = landscapeLensSide({ preference: settings.lensSide,
    safeLeft: parseFloat(style.getPropertyValue('--camera-safe-left')) || 0,
    safeRight: parseFloat(style.getPropertyValue('--camera-safe-right')) || 0,
    angle: screen.orientation?.angle ?? window.orientation ?? 0 });
  const topInset = toolbar.top <= rect.top + 1 && toolbar.bottom > rect.top ? toolbar.bottom - rect.top : 0;
  const controls = document.querySelector('.studio-bottom').getBoundingClientRect();
  const bottomInset = controls.bottom >= rect.bottom - 1 && controls.top < rect.bottom ? rect.bottom - controls.top : 0;
  promptGeometry = promptLayout(settings, { width: stage.clientWidth, height: stage.clientHeight, landscape, lensSide, topInset, bottomInset });
  for (const key of ['left', 'top', 'width', 'height']) box.style[key] = `${promptGeometry[key]}px`;
  box.dataset.lensEdge = promptGeometry.edge;
  box.dataset.orientation = promptGeometry.orientation;
  const currentFrame = settings.promptFrames[promptGeometry.orientation];
  for (const key of ['width', 'height']) {
    $(`frame-${key}`).value = currentFrame[key];
    $(`frame-${key}-value`).value = `${currentFrame[key]}%`;
  }
  $('frame-orientation').textContent = promptGeometry.orientation === 'landscape' ? '가로 창' : '세로 창';
  box.style.setProperty('--prompt-line-height', `${settings.fontSize * 1.65}px`);
  box.style.setProperty('--prompt-reading-height', `${Math.max(0, promptGeometry.height - $('drag-handle').offsetHeight - 2)}px`);
  scrollPosition = promptScroll.scrollTop;
  updateProgress();
}
function renderSettings() {
  settings = normalizeSettings(settings);
  const box = $('prompt-box');
  box.style.backgroundColor = `rgb(0 0 0 / ${settings.opacity}%)`;
  promptText.style.fontSize = `${settings.fontSize}px`;
  promptText.style.width = `${settings.width}%`;
  $('camera-preview').classList.toggle('mirrored', settings.mirror && engine.facing !== 'environment');
  $('frame-hint').textContent = settings.mirror && engine.facing !== 'environment' ? '미리보기 좌우 반전 · 원본으로 녹화' : '대본 없이 원본으로 녹화';
  for (const [id, key, label, suffix] of [
    ['font-size', 'fontSize', 'font-value', 'px'], ['scroll-speed', 'speed', 'speed-value', 'px/초'],
    ['prompt-width', 'width', 'width-value', '%'], ['prompt-opacity', 'opacity', 'opacity-value', '%'],
  ]) { $(id).value = settings[key]; $(label).value = `${settings[key]}${suffix}`; }
  $('countdown-select').value = settings.countdown;
  $('lens-side-select').value = settings.lensSide;
  $('mirror-input').checked = settings.mirror;
  $('grid-button').setAttribute('aria-pressed', String(settings.grid));
  renderPromptLayout(); updateGrid();
  updateProgress();
}
for (const [id, key] of [['font-size','fontSize'],['scroll-speed','speed'],['prompt-width','width'],['prompt-opacity','opacity']]) {
  $(id).addEventListener('input', e => { settings[key] = Number(e.target.value); renderSettings(); scheduleSave(); });
}
for (const key of ['width', 'height']) $(`frame-${key}`).addEventListener('input', e => {
  settings.promptFrames[promptGeometry.orientation][key] = Number(e.target.value); renderSettings(); scheduleSave();
});
$('countdown-select').addEventListener('change', e => { settings.countdown = Number(e.target.value); scheduleSave(); });
$('mirror-input').addEventListener('change', e => { settings.mirror = e.target.checked; renderSettings(); scheduleSave(); });
$('grid-button').addEventListener('click', () => { settings.grid = !settings.grid; renderSettings(); scheduleSave(); });
$('lens-side-select').addEventListener('change', e => { settings.lensSide = e.target.value; renderSettings(); scheduleSave(); });
$('position-reset').addEventListener('click', () => {
  settings.promptFrames[promptGeometry.orientation] = { ...DEFAULT_PROMPT_FRAMES[promptGeometry.orientation] }; renderSettings(); scheduleSave();
});
scriptInput.addEventListener('input', () => { setPlaying(false); renderScript(); scheduleSave(); });
$('sample-button').addEventListener('click', () => {
  if (scriptInput.value.trim() && scriptInput.value !== DEFAULT_SCRIPT && !confirm('현재 대본을 예시 대본으로 바꿀까요?')) return;
  scriptInput.value = DEFAULT_SCRIPT; setPlaying(false); promptScroll.scrollTop = 0; renderScript(); saveWorkspace();
});
$('file-input').addEventListener('change', async e => {
  const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
  if (file.size > 2 * 1024 * 1024) return toast('대본은 2MB 이하의 TXT 파일로 불러와 주세요.');
  if (scriptInput.value.trim() && scriptInput.value !== DEFAULT_SCRIPT && !confirm('현재 대본을 파일 내용으로 바꿀까요?')) return;
  try {
    const text = await file.text();
    if (text.includes('\0')) return toast('텍스트 파일을 선택해 주세요.');
    scriptInput.value = text.replace(/^\uFEFF/, ''); setPlaying(false); promptScroll.scrollTop = 0; renderScript(); saveWorkspace(); toast('대본을 불러왔어요.');
  } catch { toast('파일을 불러오지 못했어요. TXT 파일을 다시 선택해 주세요.'); }
});
document.querySelector('.file-button').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file-input').click(); } });

function updateProgress() {
  const max = Math.max(0, promptScroll.scrollHeight - promptScroll.clientHeight);
  const progress = max ? clamp(promptScroll.scrollTop / max * 100, 0, 100) : 0;
  $('read-progress').textContent = `${Math.round(progress)}%`; $('timeline-fill').style.width = `${progress}%`;
}
function tick(now) {
  if (!playing) return;
  if (!lastFrame) lastFrame = now;
  const max = promptScroll.scrollHeight - promptScroll.clientHeight;
  // WebKit exposes integer scrollTop offsets. Keep fractional movement here so
  // a frame smaller than 1px is retained for the next frame (including 120Hz).
  scrollPosition = nextScroll(scrollPosition, now - lastFrame, settings.speed, max);
  promptScroll.scrollTop = scrollPosition;
  lastFrame = now; updateProgress();
  if (scrollPosition >= max) { setPlaying(false); return; }
  frame = requestAnimationFrame(tick);
}
function setPlaying(value) {
  if (value && !scriptInput.value.trim()) { toast('먼저 대본을 입력해 주세요.'); return; }
  playing = value; cancelAnimationFrame(frame); lastFrame = 0;
  if (playing) {
    if (promptScroll.scrollTop >= promptScroll.scrollHeight - promptScroll.clientHeight - 1) promptScroll.scrollTop = 0;
    scrollPosition = promptScroll.scrollTop;
    frame = requestAnimationFrame(tick);
  }
  $('play-button').setAttribute('aria-pressed', String(playing));
  $('play-button').querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('play-button').querySelector('span').textContent = playing ? '대본 일시정지' : engine.state === 'recording' ? '대본 재생' : '읽기 연습';
  $('camera-gate').hidden = engine.state === 'ready' || engine.state === 'recording' || engine.state === 'stopping' || playing;
  syncWakeLock();
}
$('play-button').addEventListener('click', () => setPlaying(!playing));
$('rewind-button').addEventListener('click', () => { scrollPosition = 0; promptScroll.scrollTop = 0; updateProgress(); });
promptScroll.addEventListener('scroll', updateProgress, { passive: true });
promptScroll.addEventListener('pointerdown', () => setPlaying(false));
promptScroll.addEventListener('wheel', () => setPlaying(false), { passive: true });

let drag;
$('drag-handle').addEventListener('pointerdown', e => {
  const rect = $('camera-stage').getBoundingClientRect();
  drag = { x: e.clientX, y: e.clientY, frame: { ...settings.promptFrames[promptGeometry.orientation] }, geometry: { ...promptGeometry }, rect };
  e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault();
});
$('drag-handle').addEventListener('pointermove', e => {
  if (!drag) return;
  movePrompt(e.clientX - drag.x, e.clientY - drag.y, drag); renderSettings();
});
function finishDrag() { if (drag) { drag = null; saveWorkspace(); } }
function movePrompt(dx, dy, start = { frame: { ...settings.promptFrames[promptGeometry.orientation] }, geometry: promptGeometry, rect: $('camera-stage').getBoundingClientRect() }) {
  settings.promptFrames[start.geometry.orientation] = { ...start.frame,
    x: start.frame.x + dx / start.rect.width * 100 * (start.geometry.edge === 'right' ? -1 : 1),
    y: start.frame.y + dy / start.rect.height * 100 };
}
$('drag-handle').addEventListener('pointerup', finishDrag);
$('drag-handle').addEventListener('pointercancel', finishDrag);
$('drag-handle').addEventListener('keydown', e => {
  const shift = { ArrowLeft: [-2, 0], ArrowRight: [2, 0], ArrowUp: [0, -2], ArrowDown: [0, 2] }[e.key];
  if (!shift) return; e.preventDefault(); movePrompt(shift[0] * 4, shift[1] * 4); renderSettings(); scheduleSave();
});

async function syncWakeLock() {
  const active = playing || engine.state === 'recording' || starting;
  if (!active || document.visibilityState !== 'visible') {
    if (wakeLock) { const old = wakeLock; wakeLock = null; await old.release().catch(() => {}); }
    $('wake-status').textContent = '촬영 전 화면 방향을 맞춰 주세요.'; return;
  }
  if (!navigator.wakeLock) { $('wake-status').textContent = '화면이 꺼지지 않도록 확인해 주세요.'; return; }
  if (wakeLock || wakePending) return;
  wakePending = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if ((!playing && engine.state !== 'recording' && !starting) || document.visibilityState !== 'visible') { await lock.release(); return; }
    wakeLock = lock; $('wake-status').textContent = '화면 꺼짐 방지 켜짐';
    lock.addEventListener('release', () => { if (wakeLock === lock) { wakeLock = null; $('wake-status').textContent = '화면이 꺼지지 않도록 확인해 주세요.'; } });
  } catch { $('wake-status').textContent = '화면이 꺼지지 않도록 확인해 주세요.'; }
  finally { wakePending = false; }
}
async function updateStorage() {
  if (!navigator.storage?.estimate) return;
  try {
    const { quota, usage } = await navigator.storage.estimate();
    const free = Math.max(0, quota - usage);
    if (Number.isFinite(free)) $('storage-status').textContent = `브라우저 저장 여유 약 ${formatBytes(free)}`;
    return free;
  } catch { return undefined; }
}
function updateCameraUI() {
  const state = engine.state, recording = state === 'recording', busy = state === 'opening' || state === 'stopping';
  $('camera-status').textContent = { idle: '촬영 준비', opening: '카메라 연결 중…', ready: '카메라 준비 완료', recording: '촬영 중', stopping: '영상 보관 중…', error: '카메라를 확인해 주세요' }[state] || state;
  $('state-dot').className = `state-dot ${recording ? 'recording' : state === 'ready' ? 'ready' : ''}`;
  $('open-camera').disabled = busy || starting;
  $('open-camera').lastChild.textContent = state === 'opening' ? '연결 중…' : '카메라 켜기';
  $('camera-gate').hidden = ['ready', 'recording', 'stopping'].includes(state) || playing;
  $('flip-button').disabled = state !== 'ready' || starting;
  $('camera-off-button').disabled = state !== 'ready' || starting;
  // Deleting the take being written would abort it and drop its saved chunks.
  $('library-button').disabled = recording || state === 'stopping' || starting;
  $('record-button').disabled = state === 'stopping' || cancelling || applyingUpdate;
  $('record-button').classList.toggle('is-recording', recording);
  $('record-label').textContent = cancelling ? '준비 취소 중…' : starting ? '준비 취소' : recording ? '녹화 종료' : state === 'stopping' ? '영상 보관 중' : '녹화 시작';
  $('recording-badge').hidden = !recording;
  $('record-button').setAttribute('aria-label', $('record-label').textContent);
  if (state === 'ready' || recording) {
    const s = engine.settings;
    $('quality-status').textContent = `${s.width || '?'} × ${s.height || '?'}${s.frameRate ? ` · ${Math.round(s.frameRate)}fps` : ''} · ${engine.facing === 'environment' ? '후면' : '전면'} 카메라`;
  }
  renderSettings(); syncWakeLock();
}
engine.addEventListener('statechange', updateCameraUI);
engine.addEventListener('error', e => toast(e.detail.message || '카메라를 다시 확인해 주세요.', 8500));
engine.addEventListener('warning', e => toast(e.detail.message, 5500));
engine.addEventListener('interrupted', e => { interruptedMessage = e.detail.message; setPlaying(false); toast(interruptedMessage, 8500); });
engine.addEventListener('progress', e => {
  $('recording-time').textContent = formatTime(e.detail.durationMs);
  if (e.detail.storageState === 'memory') $('storage-status').textContent = '임시 보관 중 · 촬영 후 바로 파일로 저장해 주세요.';
  if (Date.now() - lastStorageCheck > 30000) { lastStorageCheck = Date.now(); updateStorage(); }
});
engine.addEventListener('recorded', async e => {
  const take = e.detail;
  clearInterval(recordTimer); setPlaying(false);
  if (!take) return;
  if (!take.persisted) volatileTakes.set(take.id, take);
  await refreshLibrary(); updateStorage();
  if (document.visibilityState === 'visible') await showTake(take);
  else toast('촬영이 종료되었어요. 보관함에서 영상을 확인해 주세요.', 9000);
});
async function openCamera() {
  try { await engine.open(); focusMobileCamera(); updateCameraUI(); }
  catch { /* CameraEngine reports an actionable permission or device error. */ }
}
$('open-camera').addEventListener('click', openCamera);
$('camera-off-button').addEventListener('click', async () => { setPlaying(false); await engine.close(); updateCameraUI(); });
$('flip-button').addEventListener('click', async () => { try { await engine.switchCamera(); updateCameraUI(); } catch { /* engine error event */ } });

function cancelCountdown() {
  countdownToken++;
  if (starting) { cancelling = true; engine.stop('cancelled').catch(() => {}); }
  $('countdown').hidden = true; updateCameraUI();
}
async function startRecording() {
  if (applyingUpdate) return;
  starting = true; const token = ++countdownToken; updateCameraUI();
  try {
    if (engine.state !== 'ready') await engine.open();
    if (token !== countdownToken || document.visibilityState !== 'visible') return;
    focusMobileCamera();
    const free = await updateStorage();
    if (token !== countdownToken) return;
    if (free !== undefined && free < 64 * 1024 ** 2) { toast('저장 공간이 거의 없어요. 기존 영상을 파일로 옮긴 뒤 보관함을 비워 주세요.', 9000); return; }
    if (free !== undefined && free < 1024 ** 3) toast('긴 촬영에는 저장 공간이 부족할 수 있어요. 30분 기준 약 1GB의 여유 공간을 권장합니다.', 7000);
    navigator.storage?.persist?.().catch(() => {});
    setPlaying(false);
    for (let count = settings.countdown; count > 0; count--) {
      $('countdown').textContent = count; $('countdown').hidden = false;
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (token !== countdownToken || document.visibilityState !== 'visible') return;
    }
    $('countdown').hidden = true;
    const didStart = await engine.start();
    if (!didStart) return;
    if (token !== countdownToken || document.visibilityState !== 'visible') { await engine.stop('cancelled'); return; }
    recordStart = performance.now(); $('recording-time').textContent = '00:00';
    clearInterval(recordTimer); recordTimer = setInterval(() => { if (engine.state === 'recording') $('recording-time').textContent = formatTime(performance.now() - recordStart); }, 500);
    if (scriptInput.value.trim()) setPlaying(true);
  } catch (e) { toast(e.message || '녹화를 시작하지 못했어요. 카메라를 다시 켜 주세요.', 7500); }
  finally { starting = false; cancelling = false; $('countdown').hidden = true; updateCameraUI(); }
}
$('record-button').addEventListener('click', async () => {
  if (starting) { cancelCountdown(); return; }
  if (engine.state === 'recording') {
    setPlaying(false); clearInterval(recordTimer);
    try { await engine.stop(); } catch (e) { toast(e.message || '촬영을 종료하지 못했어요.'); }
  } else if (engine.state !== 'stopping') startRecording();
});

function openDialog(id) {
  const dialog = $(id); if (!dialog.open) dialog.showModal();
  if (!$('toast').hidden) dialog.append($('toast'));
}
for (const [button, dialog] of [['settings-button', 'settings-dialog'], ['help-button', 'help-dialog']]) $(button).addEventListener('click', () => openDialog(dialog));
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => button.closest('dialog').close());
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', e => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); } });
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('close', () => {
  if (dialog.contains($('toast'))) ([...document.querySelectorAll('dialog[open]')].at(-1) || document.body).append($('toast'));
});
function closeEditor() {
  $('editor-panel').classList.remove('is-open'); $('editor-panel').removeAttribute('role'); $('editor-panel').removeAttribute('aria-modal'); editorReturnFocus?.focus();
}
$('mobile-editor-button').addEventListener('click', () => {
  setPlaying(false); editorReturnFocus = document.activeElement; $('editor-panel').classList.add('is-open');
  $('editor-panel').setAttribute('role', 'dialog'); $('editor-panel').setAttribute('aria-modal', 'true'); scriptInput.focus();
});
$('editor-close').addEventListener('click', closeEditor);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('editor-panel').classList.contains('is-open')) closeEditor();
  else if (e.key === 'Escape' && document.body.classList.contains('camera-full') && !document.querySelector('dialog[open]')) setCameraFull(false);
  if (e.key === 'Tab' && $('editor-panel').classList.contains('is-open')) {
    const nodes = [...$('editor-panel').querySelectorAll('button,input:not([hidden]),textarea,[tabindex="0"]')].filter(el => el.offsetParent !== null);
    const first = nodes[0], last = nodes.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  if (e.code === 'Space' && !e.repeat && !e.defaultPrevented && !['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(e.target.tagName) && !document.querySelector('dialog[open]')) { e.preventDefault(); setPlaying(!playing); }
});
function setFocusMode(focused) {
  document.body.classList.toggle('focus-mode', focused); $('focus-button').setAttribute('aria-pressed', String(focused));
  $('focus-button').setAttribute('aria-label', focused ? '기본 화면으로 돌아가기' : '촬영 화면 크게 보기');
  renderPromptLayout();
}
function focusMobileCamera() {
  if (matchMedia('(max-width:740px), (max-height:540px) and (orientation:landscape)').matches) setFocusMode(true);
}
$('focus-button').addEventListener('click', () => setFocusMode(!document.body.classList.contains('focus-mode')));
// Full screen camera: the preview fills the screen and the controls float over it.
// iPhone Safari has no element full screen, so the CSS layout works on its own.
function setCameraFull(full) {
  document.body.classList.toggle('camera-full', full);
  $('fullscreen-button').setAttribute('aria-pressed', String(full));
  $('fullscreen-button').setAttribute('aria-label', full ? '전체화면 끝내기' : '카메라 전체화면');
  const root = document.documentElement;
  if (full && !document.fullscreenElement) root.requestFullscreen?.({ navigationUI: 'hide' })?.catch(() => {});
  else if (!full && document.fullscreenElement) document.exitFullscreen?.()?.catch(() => {});
  renderPromptLayout();
}
$('fullscreen-button').addEventListener('click', () => setCameraFull(!document.body.classList.contains('camera-full')));
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && document.body.classList.contains('camera-full')) setCameraFull(false); });

async function refreshLibrary() {
  let stored = [];
  try { stored = await listRecordings(); } catch { /* An unavailable store still permits memory-only takes. */ }
  const combined = new Map(stored.map(take => [take.id, take]));
  for (const take of volatileTakes.values()) combined.set(take.id, take);
  recordings = [...combined.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  $('take-count').textContent = recordings.length;
  const list = $('takes-list'); list.replaceChildren();
  if (!recordings.length) { const p = document.createElement('p'); p.className = 'empty-library'; p.textContent = '아직 촬영한 영상이 없어요.\n첫 번째 이야기를 담아 보세요.'; list.append(p); return; }
  for (const take of recordings) {
    const card = document.createElement('div'); card.className = 'take-card';
    const play = document.createElement('button'); play.className = 'take-play'; play.textContent = '▶'; play.setAttribute('aria-label', '촬영 영상 재생');
    play.addEventListener('click', async () => { play.disabled = true; await showTake(take); play.disabled = false; });
    const details = document.createElement('div'); details.className = 'take-details';
    const title = document.createElement('strong'); title.textContent = new Date(take.createdAt).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const meta = document.createElement('p'); meta.textContent = `${formatTime(take.durationMs)} · ${formatBytes(take.size || take.blob?.size)}${take.complete === false ? ' · 중단된 촬영' : ''}${volatileTakes.has(take.id) ? ' · 임시 보관' : ''}`;
    details.append(title, meta);
    const remove = document.createElement('button'); remove.className = 'take-delete'; remove.textContent = '삭제';
    remove.addEventListener('click', async () => {
      if (!confirm('이 영상을 기기 보관함에서 삭제할까요? 공유하거나 파일로 저장했는지 확인해 주세요.')) return;
      try { if (stored.some(item => item.id === take.id)) await deleteRecording(take.id); volatileTakes.delete(take.id); await refreshLibrary(); updateStorage(); }
      catch { toast('영상을 삭제하지 못했어요. 다시 시도해 주세요.'); }
    });
    card.append(play, details, remove); list.append(card);
  }
}
$('library-button').addEventListener('click', async () => { await refreshLibrary(); openDialog('library-dialog'); });
function clearPlayback() {
  playbackToken++; $('playback-video').pause(); $('playback-video').removeAttribute('src'); $('playback-video').load();
  if (playbackURL) URL.revokeObjectURL(playbackURL);
  playbackURL = null; playbackFile = null; $('download-link').removeAttribute('href'); $('share-button').disabled = true;
}
async function showTake(metadata) {
  clearPlayback(); const token = playbackToken;
  try {
    const take = metadata.blob ? metadata : volatileTakes.get(metadata.id) || await getRecording(metadata.id);
    if (token !== playbackToken) return;
    if (!take?.blob?.size) { toast('영상 데이터를 찾지 못했어요. 저장 공간을 확인해 주세요.'); return; }
    playbackURL = URL.createObjectURL(take.blob);
    playbackFile = new File([take.blob], recordingName(take), { type: take.mimeType || take.blob.type });
    $('playback-video').src = playbackURL;
    $('download-link').href = playbackURL; $('download-link').download = playbackFile.name;
    $('playback-meta').textContent = `${formatTime(take.durationMs)} · ${formatBytes(take.size || take.blob.size)} · ${take.mimeType?.includes('mp4') ? 'MP4' : 'WebM'}${take.complete === false ? ' · 촬영 중단 전까지 보관된 영상입니다.' : ''}${!take.persisted && volatileTakes.has(take.id) ? ' · 새로고침 전에 파일로 저장해 주세요.' : ''}`;
    const canShare = Boolean(navigator.share && navigator.canShare?.({ files: [playbackFile] }));
    $('share-button').disabled = !canShare;
    $('share-hint').textContent = canShare ? '공유 화면에서 ‘비디오 저장’을 선택할 수 있습니다. 메뉴는 기기와 파일 형식에 따라 달라집니다.' : '이 기기에서는 파일로 저장해 주세요. 아이폰에서는 파일 앱의 다운로드 폴더에서 확인할 수 있어요.';
    openDialog('playback-dialog');
  } catch { toast('영상을 열지 못했어요. 보관함에서 다시 시도해 주세요.'); }
}
$('share-button').addEventListener('click', async () => {
  if (!playbackFile) return;
  // File is prepared before this click so share retains transient user activation.
  try { await navigator.share({ files: [playbackFile], title: '프롬프터 촬영 영상' }); toast('공유 화면으로 영상을 전달했어요.'); }
  catch (e) { if (e.name !== 'AbortError') toast('공유하지 못했어요. 파일로 저장을 이용해 주세요.'); }
});
$('playback-dialog').addEventListener('close', clearPlayback);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { if (starting) cancelCountdown(); setPlaying(false); saveWorkspace(); }
  else { if (interruptedMessage) { toast(interruptedMessage, 8500); interruptedMessage = ''; } syncWakeLock(); updateStorage(); refreshLibrary(); }
});
window.addEventListener('pagehide', () => { cancelCountdown(); setPlaying(false); saveWorkspace(); });
window.addEventListener('beforeunload', e => {
  if (engine.state === 'recording' || engine.state === 'stopping' || volatileTakes.size) { e.preventDefault(); e.returnValue = ''; }
});
window.addEventListener('resize', () => { renderSettings(); updateProgress(); });
$('camera-preview').addEventListener('loadedmetadata', updateGrid);
$('camera-preview').addEventListener('resize', updateGrid);
new ResizeObserver(() => { renderPromptLayout(); updateGrid(); }).observe($('camera-stage'));

function announceUpdate(registration) {
  if (!registration.waiting) return;
  $('update-banner').hidden = false;
  $('update-status').textContent = '새 버전을 적용할 수 있어요.';
}
function observeInstallation(registration) {
  const worker = registration.installing;
  if (!worker) return;
  worker.addEventListener('statechange', () => {
    if (worker.state === 'installed') announceUpdate(registration);
  });
}
$('check-update-button').addEventListener('click', async () => {
  if (!serviceWorkerRegistration) { toast('인터넷 연결을 확인한 뒤 앱을 다시 열어 주세요.'); return; }
  $('check-update-button').disabled = true;
  $('update-status').textContent = '업데이트 확인 중…';
  try {
    await serviceWorkerRegistration.update();
    if (serviceWorkerRegistration.waiting) announceUpdate(serviceWorkerRegistration);
    else $('update-status').textContent = serviceWorkerRegistration.installing ? '새 버전 준비 중…' : '최신 버전입니다.';
  } catch { $('update-status').textContent = '확인하지 못했어요. 인터넷 연결을 확인해 주세요.'; }
  finally { $('check-update-button').disabled = false; }
});
$('apply-update-button').addEventListener('click', () => {
  if (playing || starting || ['opening', 'recording', 'stopping'].includes(engine.state)) {
    toast('대본 재생과 녹화를 마친 뒤 업데이트를 적용해 주세요.'); return;
  }
  if (volatileTakes.size) { toast('임시 보관 중인 영상을 파일로 저장하고 보관함에서 정리한 뒤 업데이트해 주세요.', 8000); return; }
  if (!serviceWorkerRegistration?.waiting) { toast('업데이트 확인을 누른 뒤 다시 시도해 주세요.'); return; }
  saveWorkspace(); applyingUpdate = true;
  $('play-button').disabled = true; $('apply-update-button').disabled = true;
  $('apply-update-button').textContent = '적용 중…'; updateCameraUI();
  serviceWorkerRegistration.waiting.postMessage({ type: 'ACTIVATE_UPDATE' });
  setTimeout(() => {
    if (!applyingUpdate) return;
    applyingUpdate = false; $('play-button').disabled = false; $('apply-update-button').disabled = false;
    $('apply-update-button').textContent = '업데이트 적용'; updateCameraUI();
    toast('업데이트가 늦어지고 있어요. 촬영을 마친 뒤 앱을 완전히 닫고 다시 열어 주세요.', 8000);
  }, 15000);
});
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Never restart an active take merely because another tab installed a release.
    if (applyingUpdate) { saveWorkspace(); window.location.reload(); }
  });
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(async registration => {
    serviceWorkerRegistration = registration;
    announceUpdate(registration); observeInstallation(registration);
    registration.addEventListener('updatefound', () => observeInstallation(registration));
    registration.update().catch(() => {});
    await navigator.serviceWorker.ready;
    $('offline-status').textContent = '오프라인 사용 준비 완료. 이 기기에서 인터넷 없이 대본과 촬영 기능을 사용할 수 있어요.';
  }).catch(() => { $('offline-status').textContent = '오프라인 준비를 완료하지 못했어요. 인터넷에 연결한 상태에서 사용해 주세요.'; });
}
if (!window.isSecureContext) {
  $('camera-gate').querySelector('p').textContent = '아이폰 카메라는 HTTPS 주소에서 사용할 수 있어요. 안전한 주소로 접속해 주세요.';
  $('open-camera').disabled = true; $('record-button').disabled = true;
}
renderScript(); renderSettings(); refreshLibrary(); updateStorage();
