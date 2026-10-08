export function clockTime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const minutes = Math.floor(seconds / 60);
  return `${minutes >= 60 ? `${Math.floor(minutes / 60)}:` : ''}${String(minutes % 60).padStart(minutes >= 60 ? 2 : 1, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function playbackPosition(currentTime, offset, duration) {
  return Math.min(duration || Infinity, Math.max(0, (Number(currentTime) || 0) + offset));
}

// An EVENT playlist describes only converted media. Seeking outside its available
// ranges requires starting a new conversion at the requested absolute position.
export function seekPlan(target, duration, offset, converting, ranges) {
  const position = Math.max(0, Math.min(Number(target) || 0, Math.max(0, duration - 0.1)));
  const relative = position - offset;
  const available = ranges.some(([start, end]) => relative >= start && relative < end);
  return { position, relative, restart: converting && !available };
}

export function atTitleEnd(position, duration) {
  return duration > 0 && position >= duration - 2;
}
