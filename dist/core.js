export const DEFAULT_SCRIPT = `카메라를 바라보며,
내 속도로 이야기하세요.

이곳에 오늘의 대본을 붙여 넣어 주세요.
줄바꿈과 문단 사이의 여백은
화면에서도 그대로 유지됩니다.

먼저 읽기 연습을 하며
글자 크기와 속도를 맞춰 보세요.
준비가 되면, 녹화 버튼을 눌러 주세요.`;

export const DEFAULT_SETTINGS = Object.freeze({ fontSize: 34, speed: 32, width: 82, opacity: 35, x: 50, y: 16, countdown: 3, mirror: true });
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export function normalizeSettings(input = {}) {
  const number = (key, min, max) => clamp(Number.isFinite(Number(input[key])) ? Number(input[key]) : DEFAULT_SETTINGS[key], min, max);
  const width = number('width', 45, 100);
  return { fontSize: number('fontSize', 22, 64), speed: number('speed', 8, 100), width,
    opacity: number('opacity', 0, 85), x: clamp(number('x', 0, 100), width / 2, 100 - width / 2),
    y: number('y', 4, 62), countdown: [0, 3, 5].includes(Number(input.countdown)) ? Number(input.countdown) : 3,
    mirror: typeof input.mirror === 'boolean' ? input.mirror : true };
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
