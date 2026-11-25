// Shared by the compiler and authoring views. A marker owns no slide content.
export const VIDEO_MARKER_RE = /^\[Marker:\s*((?:\d{1,2}:[0-5]\d|\d{1,3}):[0-5]\d)(?:\s+(.*?))?\s*\]$/i;
export const VIDEO_MARKER_MAX_SECONDS = 24 * 60 * 60;
const MARKER_TIME_RE = /^(?:\d{1,2}:[0-5]\d|\d{1,3}):[0-5]\d$/;

export function parseMarkerTime(value) {
  const time = value.trim();
  if (!MARKER_TIME_RE.test(time)) return null;
  const seconds = time.split(":").reduce((total, part) => total * 60 + Number(part), 0);
  return seconds <= VIDEO_MARKER_MAX_SECONDS ? seconds : null;
}

export function formatMarkerTime(seconds) {
  const whole = Math.floor(seconds);
  const pad = value => String(value).padStart(2, "0");
  const minutes = Math.floor(whole / 60);
  const tail = pad(whole % 60);
  return minutes < 60 ? `${minutes}:${tail}` : `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${tail}`;
}

export function readVideoMarker(line) {
  const match = VIDEO_MARKER_RE.exec(line.trim());
  if (!match) return null;
  const t = parseMarkerTime(match[1]);
  return t === null ? null : { t, time: match[1], name: match[2] ?? "" };
}

export function videoMarkersAfter(lines, videoLine, blocked = () => false, skip = () => false) {
  const markers = [];
  for (let line = videoLine + 1; line < lines.length && !blocked(line); line += 1) {
    if (!lines[line].trim() || skip(line)) continue;
    const marker = readVideoMarker(lines[line]);
    if (!marker) break;
    markers.push({ ...marker, line });
  }
  return markers;
}
