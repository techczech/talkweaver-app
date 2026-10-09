export const instantSlideStyles = `
.instant-slide-surface{position:fixed;inset:0;z-index:55;display:grid;place-items:center;background:#fffdf2;color:#17202a;font-family:system-ui,sans-serif;container-type:inline-size;overflow:hidden}
.instant-slide-surface[hidden]{display:none!important}
.instant-slide-content{width:min(86%,1500px);display:flex;flex-direction:column;justify-content:center;align-items:center;gap:2.5cqw;min-height:60%;text-align:center}
.instant-slide-kicker{font-size:clamp(14px,2cqw,34px);font-weight:650;color:var(--accent,#0a7a5c)}
.instant-slide-text{font-size:clamp(32px,5.2cqw,100px);line-height:1.14;font-weight:600;text-align:left;overflow-wrap:anywhere;width:100%;margin:0}
.instant-slide-link{font-size:clamp(25px,3.3cqw,64px);line-height:1.2;overflow-wrap:anywhere;color:#17202a}
.instant-slide-link strong{color:var(--accent,#0a7a5c)}
.instant-slide-link a{color:inherit;text-decoration:underline;text-decoration-color:#17202a55;text-underline-offset:.15em}
.instant-slide-link a:hover{text-decoration-color:var(--accent,#0a7a5c)}
.instant-slide-corner-link a{color:inherit;text-decoration:underline;text-decoration-color:#17202a55}
.instant-slide-qr{width:min(19cqw,280px);padding:1cqw;background:white;border-radius:1cqw;box-shadow:0 5px 28px #17202a22}
.instant-slide-qr img{width:100%;height:auto;display:block}
.instant-slide-content:has(.instant-slide-image){width:calc(100% - 9cqw);height:calc(100% - 8cqw);min-height:0}
.instant-slide-image{display:block;max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain}
.instant-slide-digits{font-variant-numeric:tabular-nums;font-size:clamp(58px,15cqw,260px);font-weight:620;line-height:1}
.instant-slide-timeup{font-size:clamp(45px,9cqw,160px);font-weight:700;color:var(--accent,#0a7a5c)}
.instant-slide-corner{position:absolute;right:1.6cqw;bottom:1.6cqw;display:flex;flex-direction:column;align-items:flex-end;gap:.5cqw;max-width:34cqw;text-align:right}
.instant-slide-corner-qr{width:min(9.5cqw,200px);padding:.6cqw;background:white;border-radius:.8cqw;box-shadow:0 3px 18px #17202a22;line-height:0;box-sizing:border-box}
.instant-slide-corner-qr img{width:100%;height:auto;display:block}
.instant-slide-corner-link{font-size:clamp(11px,1.8cqw,34px);line-height:1.2;color:#17202a;overflow-wrap:anywhere}
.instant-slide-corner-link strong{color:var(--accent,#0a7a5c)}
.instant-slide-bar{height:1.2cqw;min-height:8px;width:100%;background:#17202a20;border-radius:99px;overflow:hidden}
.instant-slide-bar i{display:block;height:100%;background:var(--accent,#0a7a5c);border-radius:inherit}
.instant-slide-bar-meta{display:flex;justify-content:space-between;width:100%;color:#697682;font-size:clamp(12px,1.4cqw,24px)}
.instant-slide-thumb{position:relative;inset:auto;z-index:auto;width:100%;aspect-ratio:16/9;border:1px solid #304151;border-radius:6px}
.instant-slide-thumb .instant-slide-content{gap:1.5cqw}
.instant-slide-thumb .instant-slide-text{font-size:5cqw}
.instant-slide-thumb .instant-slide-link{font-size:3.3cqw}
.instant-slide-thumb .instant-slide-digits{font-size:14cqw}
.presenter-current-panel #currentPreview>.instant-slide-thumb{position:absolute;inset:0;width:100%;height:100%;aspect-ratio:auto;z-index:5;border:0}
.instant-compose .instant-slide-thumb{margin:9px 0}
.instant-slide-text~.instant-slide-link,.instant-slide-text~.instant-slide-qr{align-self:flex-start}
.instant-slide-thumb .instant-slide-qr{width:13cqw}
.instant-compose input[type=text],.instant-compose input:not([type]){width:100%;box-sizing:border-box;background:#17212c;color:#fff;border:1px solid #304151;border-radius:7px;padding:8px 9px;font:14px/1.4 system-ui}
.instant-link-note{color:#ffcab8;font-size:13px;margin:5px 0 0}
.instant-compose #instantLinkHint{font-size:13px}
.instant-link-note[hidden]{display:none}
.instant-compose textarea{width:100%;min-height:90px;resize:vertical;background:#17212c;color:#fff;border:1px solid #304151;border-radius:7px;padding:9px;font:14px/1.4 system-ui}
.instant-image-drop{border:1px dashed #51677b;border-radius:8px;padding:15px;min-height:74px;display:flex;align-items:center;gap:12px;color:#b7c5d1;cursor:pointer}
.instant-image-drop img{width:128px;height:72px;object-fit:contain;background:#fffdf2;border-radius:4px}
.instant-compose small{display:block;color:#b7c5d1;font-size:12px;margin-top:5px}
.instant-image-error{color:#ffcab8;margin:8px 0}
.quick-poll-compose.instant-compose{z-index:16}
.quick-poll-compose.instant-paste-preview{left:50%;right:auto;top:50%;transform:translate(-50%,-50%);width:min(520px,calc(100% - 32px))}
.instant-strip{margin-top:8px;padding:10px 14px;border:1px solid #304151;border-radius:9px;background:#101820;color:#f7f3ea;display:flex;align-items:center;gap:12px}
.instant-strip[hidden],.instant-compose[hidden]{display:none!important}
.instant-strip span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`;

export function instantSlideFromText(value, shownAt = Date.now()) {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && text.length <= 2048)
      return { kind: 'link', url: text, qrSvg: '', shownAt };
  } catch {}
  return { kind: 'text', text: text.slice(0, 2000), shownAt };
}

export function writtenInstantLink(url) {
  const written = String(url || '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
  const slash = written.search(/[/?#]/);
  const parts = slash >= 0 ? { host: written.slice(0, slash), path: written.slice(slash) } : { host: written, path: '' };
  // The host as the browser will resolve it: lower case, and punycode when it holds non-ASCII letters, so the written link cannot mislead.
  try { parts.host = new URL('https://' + parts.host).host; } catch {}
  return parts;
}

// A link typed or pasted into the composer, made into the address that is shown and encoded.
// Returns { url, written } for a web address (a bare `example.com/form` becomes https://example.com/form),
// { empty: true } for nothing, or { error } for anything that is not http(s): javascript:, data:, file:
// and the like. `written` is the link as people read it, without the scheme. Self-contained: it is
// serialised into the audience page by instantSlideRuntimeSource.
export function normaliseInstantLink(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { empty: true };
  const refuse = { error: 'Only web links (http or https) can be shown.' };
  if (/[\s\u0000-\u001f\u007f]/.test(raw) || raw.length > 2048) return { error: 'That does not look like a web link.' };
  let url = raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    if (!/^https?:\/\//i.test(raw)) return refuse;
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[^/:?#]+:\d+([/?#]|$)/.test(raw)) return refuse;
  else url = 'https://' + raw.replace(/^\/\//, '');
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return refuse;
    if (parsed.username || parsed.password) return { error: 'Links with a username or password in them cannot be shown.' };
    if (!parsed.hostname || (parsed.hostname.indexOf('.') < 0 && parsed.hostname.charAt(0) !== '[')) return { error: 'That does not look like a web link.' };
    // The canonical form (percent-encodes < > " and path backticks); what is still unsafe in it is refused.
    url = parsed.href;
    if (url.length > 2048 || /[<>"`\u0000-\u001f\u007f]/.test(url)) return { error: 'That link has characters that cannot be shown.' };
  } catch { return { error: 'That does not look like a web link.' }; }
  const shown = writtenInstantLink(url);
  return { url, written: shown.host + shown.path };
}

// The end-of-break sound of a countdown: 'none', 'chime' or 'alarm'. Slides from before the three-way
// choice carry a boolean `soundAtEnd` (true is the chime, false is none); neither field means the chime.
export function instantEndSound(slide) {
  const value = slide && slide.endSound;
  if (value === 'none' || value === 'chime' || value === 'alarm') return value;
  return slide && slide.soundAtEnd === false ? 'none' : 'chime';
}

// Which surface plays the end-of-break sound, and when. `prev` is the state this function returned
// last time for this surface ({ key, armed, fired }); the countdown is identified by its start and
// length, so re-rendering the same countdown never re-fires and a restarted one is a new countdown.
// A countdown is "armed" once it has been seen running; one first seen already finished (a screen
// joining late) never plays. `plays` is false on phones. When `play` is true, `sound` is 'chime' or
// 'alarm' (instantEndSound: the presenter's choice; none never plays).
export function nextBreakEnd(prev, slide, remainingMs, plays) {
  const key = slide.startedAt + ':' + slide.durationMs;
  const state = prev && prev.key === key ? prev : { key, armed: false, fired: false };
  if (remainingMs > 0) return { state: state.armed ? state : { key, armed: true, fired: state.fired }, play: false, sound: null };
  if (state.armed && !state.fired) {
    const choice = instantEndSound(slide);
    const play = Boolean(plays) && choice !== 'none';
    return { state: { key, armed: true, fired: true }, play, sound: play ? choice : null };
  }
  return { state, play: false, sound: null };
}

// The two end-of-break sounds, synthesised with WebAudio: no file, no licence. The chime is a short,
// soft two-note chime (E5 then A5). The alarm is three rising square-wave beeps (A5, C#6, E6), twice
// over about three seconds: clearly more insistent. The
// context is made on the first key, click or tap on the page (the browser will not start audio
// before one) and resumed then. play() returns false and does nothing if the browser still blocks
// audio when the break ends: no error, no UI.
export function createBreakChime(win) {
  const Context = win && (win.AudioContext || win.webkitAudioContext);
  let context = null;
  const events = ['pointerdown', 'keydown', 'click', 'touchstart'];
  function ensure() {
    if (!context && Context) { try { context = new Context(); } catch { context = null; } }
    return context;
  }
  function resume() {
    const ctx = ensure();
    if (ctx && ctx.state === 'suspended') { try { const result = ctx.resume(); if (result && result.catch) result.catch(() => {}); } catch {} }
    return ctx;
  }
  function onGesture() {
    const ctx = resume();
    if (ctx && ctx.state !== 'suspended') events.forEach((name) => win.document.removeEventListener(name, onGesture, true));
  }
  if (Context && win.document) events.forEach((name) => win.document.addEventListener(name, onGesture, true));
  function play(sound) {
    try {
      const ctx = resume();
      if (!ctx || ctx.state !== 'running') return false;
      const start = ctx.currentTime + 0.05;
      const alarm = sound === 'alarm';
      const notes = alarm
        ? [0, 1.6].flatMap((group) => [880, 1108.73, 1318.51].map((frequency, i) => [frequency, group + i * 0.4, 0.28]))
        : [[659.25, 0, 1.4], [880, 0.32, 1.4]];
      notes.forEach(([frequency, offset, length]) => {
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.type = alarm ? 'square' : 'sine';
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, start + offset);
        gain.gain.exponentialRampToValueAtTime(alarm ? 0.2 : 0.28, start + offset + 0.02);
        if (alarm) gain.gain.setValueAtTime(0.2, start + offset + length - 0.04);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + length);
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.start(start + offset);
        oscillator.stop(start + offset + length + 0.1);
      });
      return true;
    } catch { return false; }
  }
  return { play, unlock: resume };
}

export function createInstantSlideSurface(mount, options = {}) {
  const document = mount.ownerDocument;
  const surface = document.createElement('div');
  surface.className = 'instant-slide-surface' + (options.thumbnail ? ' instant-slide-thumb' : '');
  surface.hidden = true;
  mount.appendChild(surface);
  let slide = null;
  let timer = null;
  let breakEnd = null;
  const now = options.now || Date.now;
  function add(tag, className, text, parent = surface) {
    const node = document.createElement(tag);
    node.className = className;
    if (text != null) node.textContent = text;
    parent.appendChild(node);
    return node;
  }
  function updateClock() {
    if (!slide) return;
    if (slide.kind === 'time') {
      const digits = surface.querySelector('.instant-slide-digits');
      if (digits) digits.textContent = new Date(now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    if (slide.kind === 'countdown') {
      const remaining = Math.max(0, slide.startedAt + slide.durationMs - now());
      const seconds = Math.ceil(remaining / 1000);
      const digits = surface.querySelector('.instant-slide-digits');
      if (digits) digits.textContent = String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
      const bar = surface.querySelector('.instant-slide-bar i');
      if (bar) bar.style.width = (100 * remaining / slide.durationMs) + '%';
      const done = surface.querySelector('.instant-slide-timeup');
      if (done) done.hidden = remaining > 0;
      const decision = nextBreakEnd(breakEnd, slide, remaining, Boolean(options.chime));
      breakEnd = decision.state;
      if (decision.play) { try { options.chime.play(decision.sound); } catch {} }
    }
  }
  // A written link: an anchor on surfaces people can tap, plain text elsewhere (thumbnails, projector, venue). `options.clickable === false` turns anchors off.
  function addWrittenLink(parent, url, className) {
    const written = writtenInstantLink(url);
    const box = add('div', className, null, parent);
    const holder = options.clickable === false || options.thumbnail ? box : add('a', '', null, box);
    if (holder !== box) { holder.href = url; holder.target = '_blank'; holder.rel = 'noopener noreferrer'; }
    holder.appendChild(document.createTextNode(written.host));
    if (written.path) add('strong', '', written.path, holder);
    return box;
  }
  // A QR code in a box of class `boxClass`. Drawn only on surfaces that opt in with `options.showQr`
  // (projector, presenter preview, venue screen); phones never get one.
  function addQr(parent, boxClass, svg, alt) {
    if (!options.showQr || !svg) return;
    const image = add('img', '', null, add('div', boxClass, null, parent));
    image.alt = alt;
    image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  // The talk's QR code, and its link when the talk has a published handout, bottom-right of the
  // clock, break and text slides that carry no link of their own. `options.qr()` supplies { svg, url, link } where the page has one;
  // phones pass none and never show a QR.
  function addCornerQr() {
    // A countdown that carries its own link shows that link's QR here instead of the talk's.
    if (slide.kind === 'countdown' && slide.link) {
      const corner = add('div', 'instant-slide-corner');
      addQr(corner, 'instant-slide-corner-qr', slide.linkQrSvg, 'QR code for this link');
      addWrittenLink(corner, slide.link, 'instant-slide-corner-link');
      return;
    }
    let qr = null;
    try { qr = options.qr ? options.qr() : null; } catch { qr = null; }
    if (!qr || !qr.svg || !options.showQr) return;
    const corner = add('div', 'instant-slide-corner');
    addQr(corner, 'instant-slide-corner-qr', qr.svg, 'QR code for this talk');
    // The written link is the published handout (qr.linkUrl), which can differ from what the QR encodes (the live join link).
    const linkUrl = qr.linkUrl || qr.url;
    if (qr.link && linkUrl) addWrittenLink(corner, linkUrl, 'instant-slide-corner-link');
  }
  function show(next) {
    if (timer != null) clearInterval(timer);
    timer = null;
    slide = next;
    if (!slide) breakEnd = null;
    surface.replaceChildren();
    surface.hidden = !slide;
    if (!slide) return;
    const content = add('div', 'instant-slide-content');
    if (slide.kind === 'text') {
      add('p', 'instant-slide-text', slide.text, content);
      if (slide.link) {
        addWrittenLink(content, slide.link, 'instant-slide-link');
        addQr(content, 'instant-slide-qr', slide.linkQrSvg, 'QR code for this link');
      } else addCornerQr();
    }
    else if (slide.kind === 'image') {
      const image = add('img', 'instant-slide-image', null, content);
      image.src = slide.dataUrl;
      image.alt = 'Image shown by the presenter';
    }
    else if (slide.kind === 'link') {
      add('div', 'instant-slide-kicker', 'Link', content);
      addWrittenLink(content, slide.url, 'instant-slide-link');
      addQr(content, 'instant-slide-qr', slide.qrSvg, 'QR code for this link');
    } else {
      const label = slide.kind === 'countdown' ? String(slide.label || '').trim() : '';
      if (label) add('div', 'instant-slide-kicker', label, content);
      if (slide.kind === 'countdown') add('div', 'instant-slide-timeup', "Time’s up", content);
      add('div', 'instant-slide-digits', '', content);
      if (slide.kind === 'countdown') {
        const bar = add('div', 'instant-slide-bar', null, content);
        add('i', '', null, bar);
        const meta = add('div', 'instant-slide-bar-meta', null, content);
        add('span', '', '0:00', meta);
        add('span', '', String(Math.round(slide.durationMs / 60000)) + ':00', meta);
      }
      addCornerQr();
      updateClock();
      timer = setInterval(updateClock, slide.kind === 'time' ? 1000 : 100);
    }
  }
  return { show, element: surface, destroy() { if (timer != null) clearInterval(timer); surface.remove(); } };
}

export function instantSlideRuntimeSource() {
  return [instantSlideFromText, writtenInstantLink, normaliseInstantLink, instantEndSound, nextBreakEnd, createBreakChime, createInstantSlideSurface].map((fn) => fn.toString()).join('\n');
}
