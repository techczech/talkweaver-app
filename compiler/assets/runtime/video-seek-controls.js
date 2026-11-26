// Live controls are added after compilation, leaving authored figures and still pictures intact.
export function createVideoSeekControls({ icon, shortcut, fullscreen, markersFor, hideControls }) {
  const controls = new WeakMap();
  function clock(seconds) {
    const whole = Math.floor(seconds);
    return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0');
  }
  function makeControls(video, forwardKey) {
    const doc = video.ownerDocument;
    const bar = doc.createElement('div');
    bar.className = 'tw-video-seek';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Video playback');
    function button(name, glyph) {
      const el = doc.createElement('button');
      el.type = 'button';
      el.tabIndex = 0;
      labelButton(el, name, glyph);
      return el;
    }
    function labelButton(el, name, glyph) {
      el.setAttribute('aria-label', name);
      el.replaceChildren(icon(glyph));
    }
    const restart = button('Back to start', 'skip-back');
    const play = button('Play', 'play');
    const range = doc.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.step = '0.01';
    range.setAttribute('aria-label', 'Video position');
    const track = doc.createElement('div');
    track.className = 'tw-video-seek-track';
    track.append(range);
    const ticks = makeVideoMarkerTicks(track, marker => {
      const options = markersFor(video, Boolean(forwardKey));
      options?.jump(marker.t);
    });
    const time = doc.createElement('output');
    const elapsed = doc.createTextNode('');
    const total = doc.createElement('span');
    time.setAttribute('aria-live', 'off');
    time.append(elapsed, total);

    const seeks = [
      ['presenter.video-restart', 'Back to start', null],
      ['presenter.video-back', 'Skip video back 5 seconds', -5],
      ['presenter.video-forward', 'Skip video forward 5 seconds', 5],
    ];
    function tip(label, command) {
      const key = shortcut(command, Boolean(forwardKey)).label;
      return key ? label + ' (' + key + ')' : label;
    }
    function paintTips() {
      restart.title = tip(seeks[0][1], seeks[0][0]);
      const action = play.getAttribute('aria-label');
      play.title = forwardKey ? tip(action, 'presenter.media') : action;
      range.title = seeks.slice(1).map(([id, label]) => tip(label, id)).join(' · ');
    }
    function paint() {
      const duration = video.duration;
      const seekable = Number.isFinite(duration) && duration > 0;
      const position = clock(video.currentTime);
      const action = video.paused ? 'Play' : 'Pause';
      if (action !== play.getAttribute('aria-label')) labelButton(play, action, action.toLowerCase());
      elapsed.data = position;
      total.textContent = ' / ' + (seekable ? clock(duration) : '–:––');
      restart.disabled = range.disabled = !seekable;
      range.max = seekable ? String(duration) : '0';
      range.value = String(video.currentTime);
      range.setAttribute('aria-valuetext', seekable ? position + ' of ' + clock(duration) : position);
      track.style.setProperty('--tw-video-progress', (seekable ? video.currentTime / duration * 100 : 0) + '%');
      const markers = markersFor(video, Boolean(forwardKey));
      ticks.paint(markers?.rows ?? [], duration, video.currentTime);
      paintTips();
    }
    // Figures may be wider than their fitted video. Both the video and the bar share the
    // same positioning box, so use its layout coordinates, before pane and slide zoom.
    function align() {
      const style = video.ownerDocument.defaultView?.getComputedStyle(video);
      bar.style.left = video.offsetLeft + 'px';
      bar.style.top = (video.offsetTop + video.offsetHeight) + 'px';
      bar.style.width = video.offsetWidth + 'px';
      bar.style.borderBottomLeftRadius = style?.borderBottomLeftRadius || '';
      bar.style.borderBottomRightRadius = style?.borderBottomRightRadius || '';
      const scale = Number(video.ownerDocument.documentElement.style.getPropertyValue('--tw-video-preview-scale')) || 1;
      bar.toggleAttribute('data-compact', bar.clientWidth * scale < 420);
      ticks.fitLabels();
    }
    function syncFullscreen() {
      const native = video.ownerDocument.fullscreenElement === video;
      const hidden = hideControls(video);
      video.controls = native && !hidden;
      bar.hidden = native || hidden;
    }
    play.addEventListener('click', () => {
      if (video.paused) video.play()?.catch(() => {});
      else video.pause();
    });
    restart.addEventListener('click', () => { video.currentTime = 0; paint(); });
    range.addEventListener('input', () => { video.currentTime = range.valueAsNumber; paint(); });
    for (const event of ['loadedmetadata', 'durationchange', 'emptied', 'timeupdate', 'seeking', 'play', 'pause', 'ended']) {
      video.addEventListener(event, paint);
    }
    video.addEventListener('tw-video-markers-change', paint);
    video.addEventListener('loadedmetadata', align);
    video.addEventListener('durationchange', syncFullscreen);
    video.addEventListener('fullscreenchange', syncFullscreen);
    bar.addEventListener('pointerover', paintTips);
    bar.addEventListener('focusin', paintTips);
    bar.addEventListener('click', event => event.stopPropagation());
    bar.addEventListener('keydown', event => {
      if (event.key === 'Tab') {
        // Keep the focus order inside the Current iframe consistent on platforms that skip buttons.
        // The browser still handles leaving the bar in either direction.
        const stops = [restart, play, range].filter(control => !control.disabled);
        const index = stops.indexOf(event.target);
        const next = forwardKey && index >= 0 && stops[index + (event.shiftKey ? -1 : 1)];
        if (next) { event.preventDefault(); next.focus(); }
        return;
      }
      const activates = event.key === 'Enter' || event.key === ' ';
      const adjusts = event.target === range && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
        'Home', 'End', 'PageUp', 'PageDown'].includes(event.key);
      if (activates || adjusts) { event.stopPropagation(); return; }
      if (forwardKey) { forwardKey(event); return; }
      if (range.disabled || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const command = seeks.find(([id]) => shortcut(id, false).key === event.key);
      if (!command) return;
      const offset = command[2];
      video.currentTime = offset === null ? 0 : Math.min(video.duration, Math.max(0, video.currentTime + offset));
      event.preventDefault();
      event.stopPropagation();
      paint();
    });

    bar.append(restart, play, time, track);
    if (!forwardKey) {
      const expand = button('Video full screen', 'fullscreen');
      expand.title = 'Video full screen';
      expand.addEventListener('click', () => fullscreen(video));
      bar.append(expand);
    }
    paint();
    let observer;
    return {
      paint,
      place() {
        if (bar.parentNode !== video.parentNode) {
          video.after(bar);
          observer?.disconnect();
          const Observer = video.ownerDocument.defaultView?.ResizeObserver;
          if (Observer) {
            observer = new Observer(align);
            observer.observe(video);
            observer.observe(video.parentElement);
            observer.observe(track);
          }
        }
        syncFullscreen();
        align();
      }
    };
  }
  function place(video, forwardKey) {
    if (!video.parentElement) return;
    let control = controls.get(video);
    if (!control) {
      control = makeControls(video, forwardKey);
      controls.set(video, control);
    }
    control.place();
  }
  return { place, refresh: video => controls.get(video)?.paint() };
}

export function videoSeekControlsRuntimeSource() { return createVideoSeekControls.toString(); }
