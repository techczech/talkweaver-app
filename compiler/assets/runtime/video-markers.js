export function markerClock(seconds) {
  const whole = Math.floor(seconds);
  const pad = value => String(value).padStart(2, '0');
  const minutes = Math.floor(whole / 60);
  return minutes < 60 ? minutes + ':' + pad(whole % 60) :
    Math.floor(minutes / 60) + ':' + pad(minutes % 60) + ':' + pad(whole % 60);
}

export function readVideoMarkers(video) {
  const value = video?.dataset.videoMarkers;
  if (!value) return [];
  try {
    const markers = JSON.parse(value);
    if (!Array.isArray(markers)) return [];
    return markers.filter(marker => marker && Number.isInteger(marker.t) && marker.t >= 0 &&
      marker.t <= 86400 && typeof marker.name === 'string').sort((a, b) => a.t - b.t);
  } catch { return []; }
}

export function videoMarkerRows(video, numbered = true) {
  const duration = video?.duration;
  return readVideoMarkers(video).map((marker, index) => {
    const past = Number.isFinite(duration) && marker.t > duration;
    return { t: marker.t, name: marker.name || markerClock(marker.t), past, key: numbered && !past && index < 9 ? index + 1 : null };
  });
}

export function activeVideoMarker(rows, time) {
  return rows.findLastIndex(marker => !marker.past && marker.t <= time);
}

export function adjacentVideoMarker(rows, time, direction) {
  if (direction > 0) return rows.find(marker => !marker.past && marker.t > time);
  const current = rows[activeVideoMarker(rows, time)];
  if (!current || Math.floor(time) !== current.t) return current;
  return rows.findLast(marker => !marker.past && marker.t < current.t);
}

export function makeVideoMarkerTicks(track, jump) {
  const doc = track.ownerDocument;
  const layer = doc.createElement('div');
  layer.className = 'tw-video-marker-ticks';
  let identity = '', activeTime = null;
  function fitLabels() {
    const scale = Number(doc.documentElement.style.getPropertyValue('--tw-video-preview-scale')) || 1;
    const numbered = [...layer.querySelectorAll('.tw-video-marker-tick:has(.tw-video-marker-tick-key)')].map(node => {
      const rect = node.getBoundingClientRect();
      return (rect.left + rect.right) / 2;
    });
    const gap = numbered.slice(1).reduce((min, x, index) => Math.min(min, (x - numbered[index]) * scale), Infinity);
    const keyWidth = Math.max(6, Math.min(12, Math.floor(gap - 1)));
    layer.style.setProperty('--tw-video-marker-key-width', String(keyWidth));
    const labels = [...layer.querySelectorAll('.tw-video-marker-tick-label')].map(node => node.getBoundingClientRect());
    const bounds = track.getBoundingClientRect();
    layer.toggleAttribute('data-labels', labels.length > 0 && labels.every((rect, index) =>
      rect.left >= bounds.left && rect.right <= bounds.right && (index === 0 || (rect.left - labels[index - 1].right) * scale >= 4)));
  }
  return {
    paint(rows, duration, time) {
      if (!Number.isFinite(duration) || duration <= 0) rows = [];
      const next = JSON.stringify([duration, rows]);
      if (identity !== next) {
        identity = next;
        activeTime = null;
        const unique = new Map();
        for (const marker of rows) if (!marker.past && !unique.has(marker.t)) unique.set(marker.t, marker);
        layer.replaceChildren(...[...unique.values()].map(marker => {
          const tick = doc.createElement('button');
          tick.type = 'button';
          tick.className = 'tw-video-marker-tick';
          tick.dataset.time = String(marker.t);
          tick.style.left = (marker.t / duration * 100) + '%';
          const stamp = markerClock(marker.t);
          tick.title = marker.name === stamp ? stamp : stamp + ' ' + marker.name;
          tick.setAttribute('aria-label', 'Jump to ' + tick.title);
          const label = doc.createElement('span');
          label.className = 'tw-video-marker-tick-label';
          if (marker.key) {
            const key = doc.createElement('span');
            key.className = 'tw-video-marker-tick-key';
            key.textContent = String(marker.key);
            label.append(key);
          }
          const name = doc.createElement('span');
          name.className = 'tw-video-marker-tick-name';
          name.textContent = marker.name;
          label.append(name);
          tick.append(label);
          tick.addEventListener('click', () => jump(marker));
          return tick;
        }));
        if (unique.size) track.append(layer);
        else layer.remove();
        fitLabels();
      }
      const now = rows[activeVideoMarker(rows, time)]?.t;
      if (activeTime !== now) {
        activeTime = now;
        for (const tick of layer.children) tick.toggleAttribute('data-current', Number(tick.dataset.time) === now);
      }
    },
    fitLabels
  };
}

export function videoMarkersRuntimeSource() {
  return [markerClock, readVideoMarkers, videoMarkerRows, activeVideoMarker, adjacentVideoMarker, makeVideoMarkerTicks]
    .map(fn => fn.toString()).join('\n');
}
