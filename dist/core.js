export const DEFAULT_SCRIPT = `카메라를 바라보며,
내 속도로 이야기하세요.

이곳에 오늘의 대본을 붙여 넣어 주세요.
줄바꿈과 문단 사이의 여백은
화면에서도 그대로 유지됩니다.

먼저 읽기 연습을 하며
글자 크기와 속도를 맞춰 보세요.
준비가 되면, 녹화 버튼을 눌러 주세요.`;

export const DEFAULT_SETTINGS = Object.freeze({ fontSize: 34, speed: 32, width: 82, opacity: 35, x: 50, y: 4, countdown: 3, mirror: true, grid: true, promptLayoutVersion: 2, lensSide: 'auto', landscapeX: 0, landscapeY: 50 });
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export function normalizeSettings(input = {}) {
  const number = (key, min, max) => clamp(Number.isFinite(Number(input[key])) ? Number(input[key]) : DEFAULT_SETTINGS[key], min, max);
  const width = number('width', 45, 100);
  return { fontSize: number('fontSize', 22, 64), speed: number('speed', 8, 100), width,
    opacity: number('opacity', 0, 85), x: clamp(number('x', 0, 100), width / 2, 100 - width / 2),
    // Older workspaces allowed a central reading window. Move them back to
    // the lens once, then retain adjustments within the new reading area.
    y: input.promptLayoutVersion === 2 ? number('y', 2, 8) : DEFAULT_SETTINGS.y,
    promptLayoutVersion: 2,
    lensSide: ['auto', 'left', 'right'].includes(input.lensSide) ? input.lensSide : 'auto',
    landscapeX: number('landscapeX', 0, 100), landscapeY: number('landscapeY', 0, 100),
    countdown: [0, 3, 5].includes(Number(input.countdown)) ? Number(input.countdown) : 3,
    mirror: typeof input.mirror === 'boolean' ? input.mirror : true,
    grid: typeof input.grid === 'boolean' ? input.grid : true };
}

/** Keep the complete reading window in a small band beside the camera lens. */
export function promptLayout(input, { width, height, landscape = false, lensSide = 'left', topInset = 0 }) {
  const settings = normalizeSettings(input);
  const margin = Math.min(10, width / 20, height / 20);
  const availableHeight = Math.max(1, height - topInset - margin * 2);
  if (landscape) {
    const bandWidth = width * .4;
    const boxWidth = Math.min(300, width * .34) * settings.width / 100;
    const boxHeight = Math.min(260, availableHeight);
    const travelX = Math.max(0, bandWidth - boxWidth - margin * 2);
    const travelY = Math.max(0, availableHeight - boxHeight);
    const inset = margin + travelX * settings.landscapeX / 100;
    return { left: lensSide === 'right' ? width - boxWidth - inset : inset,
      top: topInset + margin + travelY * settings.landscapeY / 100,
      width: boxWidth, height: boxHeight, travelX, travelY, edge: lensSide };
  }
  const boxWidth = Math.min(width - margin * 2, width * settings.width / 100);
  const boxHeight = Math.min(210, availableHeight, Math.max(height * .34, settings.fontSize * 1.65 + 49));
  const minTop = topInset + margin;
  const maxTop = Math.max(minTop, Math.min(height * .08, height - boxHeight - margin));
  return { left: clamp(width * settings.x / 100 - boxWidth / 2, margin, width - boxWidth - margin),
    top: clamp(height * settings.y / 100, minTop, maxTop), width: boxWidth, height: boxHeight, edge: 'top' };
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
