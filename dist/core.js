export const DEFAULT_SCRIPT = `카메라를 바라보며,
내 속도로 이야기하세요.

이곳에 오늘의 대본을 붙여 넣어 주세요.
줄바꿈과 문단 사이의 여백은
화면에서도 그대로 유지됩니다.

먼저 읽기 연습을 하며
글자 크기와 속도를 맞춰 보세요.
준비가 되면, 녹화 버튼을 눌러 주세요.`;

export const DEFAULT_PROMPT_FRAMES = Object.freeze({
  portrait: Object.freeze({ width: 94, height: 40, x: 50, y: 24 }),
  landscape: Object.freeze({ width: 58, height: 76, x: 42, y: 50 }),
});
export const DEFAULT_SETTINGS = Object.freeze({ fontSize: 34, speed: 32, width: 82, opacity: 35, countdown: 3, mirror: true, grid: true, level: false, promptLayoutVersion: 3, lensSide: 'auto' });
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export function normalizeSettings(input = {}) {
  const number = (key, min, max) => clamp(Number.isFinite(Number(input[key])) ? Number(input[key]) : DEFAULT_SETTINGS[key], min, max);
  const promptFrames = {};
  for (const orientation of ['portrait', 'landscape']) {
    const defaults = DEFAULT_PROMPT_FRAMES[orientation];
    // Versions 1 and 2 coupled text width/font size to a restricted window.
    // Replace only the old frame geometry, preserving all reading preferences.
    const saved = input.promptLayoutVersion === 3 ? input.promptFrames?.[orientation] : null;
    const value = (key, min, max) => clamp(Number.isFinite(Number(saved?.[key])) ? Number(saved[key]) : defaults[key], min, max);
    const width = value('width', 35, 100), height = value('height', 20, 90);
    promptFrames[orientation] = { width, height, x: value('x', width / 2, 100 - width / 2), y: value('y', height / 2, 100 - height / 2) };
  }
  return { fontSize: number('fontSize', 22, 64), speed: number('speed', 8, 100), width: number('width', 45, 100),
    opacity: number('opacity', 0, 85), promptFrames,
    promptLayoutVersion: 3,
    lensSide: ['auto', 'left', 'right'].includes(input.lensSide) ? input.lensSide : 'auto',
    countdown: [0, 3, 5].includes(Number(input.countdown)) ? Number(input.countdown) : 3,
    mirror: typeof input.mirror === 'boolean' ? input.mirror : true,
    grid: typeof input.grid === 'boolean' ? input.grid : true,
    level: typeof input.level === 'boolean' ? input.level : false };
}

/** Frame geometry is independent of font size and the text's inner width. */
export function promptLayout(input, { width, height, landscape = false, lensSide = 'left', topInset = 0, bottomInset = 0 }) {
  const settings = normalizeSettings(input);
  width = Math.max(1, width); height = Math.max(1, height);
  const orientation = landscape ? 'landscape' : 'portrait', frame = settings.promptFrames[orientation];
  const margin = Math.min(8, width / 30, height / 30);
  topInset = clamp(topInset, 0, Math.max(0, height - margin * 2 - 1));
  bottomInset = clamp(bottomInset, 0, Math.max(0, height - topInset - margin * 2 - 1));
  const boxWidth = Math.min(width - margin * 2, width * frame.width / 100);
  const boxHeight = Math.min(Math.max(1, height - topInset - bottomInset - margin * 2), height * frame.height / 100);
  const centerX = landscape && lensSide === 'right' ? 100 - frame.x : frame.x;
  return { left: clamp(width * centerX / 100 - boxWidth / 2, margin, width - boxWidth - margin),
    top: clamp(height * frame.y / 100 - boxHeight / 2, topInset + margin, height - bottomInset - boxHeight - margin),
    width: boxWidth, height: boxHeight, edge: landscape ? lensSide : 'top', orientation };
}

export function landscapeLensSide({ preference = 'auto', safeLeft = 0, safeRight = 0, angle = 0 } = {}) {
  if (preference === 'left' || preference === 'right') return preference;
  // The notch's safe area is the best available cue in an installed iOS app.
  if (safeLeft !== safeRight) return safeLeft > safeRight ? 'left' : 'right';
  return ((Number(angle) % 360) + 360) % 360 === 270 ? 'right' : 'left';
}
export function formatTime(milliseconds = 0) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
  return `${h ? `${String(h).padStart(2, '0')}:` : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
export function formatBytes(bytes = 0) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(0.1, bytes / 1024 ** 2).toFixed(1)} MB`;
}
export function recordingName(recording) {
  const d = new Date(recording.createdAt);
  const pad = n => String(n).padStart(2, '0');
  return `prompter-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${recording.extension || (recording.mimeType?.includes('mp4') ? 'mp4' : 'webm')}`;
}

/** A clock independent of frame rate; background gaps never fast-forward a script. */
export function nextScroll(position, deltaMs, speed, max) {
  return clamp(position + clamp(deltaMs, 0, 100) * speed / 1000, 0, Math.max(0, max));
}

/** Screen-space tilt of the real horizon in degrees (-90..90), or null when lying flat. */
export function horizonTilt({ x, y }, screenAngle = 0) {
  if (Math.hypot(x, y) < 3) return null;
  // A line has no direction, so browsers' opposite gravity signs give the same angle.
  const angle = Math.atan2(-y, x) * 180 / Math.PI + 90 + Number(screenAngle);
  return ((angle % 180) + 270) % 180 - 90;
}
