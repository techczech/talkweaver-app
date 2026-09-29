export const instantSlideStyles = `
.instant-slide-surface{position:fixed;inset:0;z-index:55;display:grid;place-items:center;background:#fffdf2;color:#17202a;font-family:system-ui,sans-serif;container-type:inline-size;overflow:hidden}
.instant-slide-surface[hidden]{display:none!important}
.instant-slide-content{width:min(86%,1500px);display:flex;flex-direction:column;justify-content:center;align-items:center;gap:2.5cqw;min-height:60%;text-align:center}
.instant-slide-kicker{font-size:clamp(14px,2cqw,34px);font-weight:650;color:var(--accent,#0a7a5c)}
.instant-slide-text{font-size:clamp(32px,5.2cqw,100px);line-height:1.14;font-weight:600;text-align:left;overflow-wrap:anywhere;width:100%;margin:0}
.instant-slide-link{font-size:clamp(25px,3.3cqw,64px);line-height:1.2;overflow-wrap:anywhere;color:#17202a}
.instant-slide-link strong{color:var(--accent,#0a7a5c)}
.instant-slide-qr{width:min(19cqw,280px);padding:1cqw;background:white;border-radius:1cqw;box-shadow:0 5px 28px #17202a22}
.instant-slide-qr img{width:100%;height:auto;display:block}
.instant-slide-content:has(.instant-slide-image){width:calc(100% - 9cqw);height:calc(100% - 8cqw);min-height:0}
.instant-slide-image{display:block;max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain}
.instant-slide-digits{font-variant-numeric:tabular-nums;font-size:clamp(58px,15cqw,260px);font-weight:620;line-height:1}
.instant-slide-timeup{font-size:clamp(45px,9cqw,160px);font-weight:700;color:var(--accent,#0a7a5c)}
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
.instant-compose .instant-slide-qr{display:none}
.instant-compose textarea{width:100%;min-height:90px;resize:vertical;background:#17212c;color:#fff;border:1px solid #304151;border-radius:7px;padding:9px;font:14px/1.4 system-ui}
.instant-image-drop{border:1px dashed #51677b;border-radius:8px;padding:15px;min-height:74px;display:flex;align-items:center;gap:12px;color:#b7c5d1;cursor:pointer}
.instant-image-drop img{width:128px;height:72px;object-fit:contain;background:#fffdf2;border-radius:4px}
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

export function createInstantSlideSurface(mount, options = {}) {
  const document = mount.ownerDocument;
  const surface = document.createElement('div');
  surface.className = 'instant-slide-surface' + (options.thumbnail ? ' instant-slide-thumb' : '');
  surface.hidden = true;
  mount.appendChild(surface);
  let slide = null;
  let timer = null;
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
    }
  }
  function show(next) {
    if (timer != null) clearInterval(timer);
    timer = null;
    slide = next;
    surface.replaceChildren();
    surface.hidden = !slide;
    if (!slide) return;
    const content = add('div', 'instant-slide-content');
    if (slide.kind === 'text') add('p', 'instant-slide-text', slide.text, content);
    else if (slide.kind === 'image') {
      const image = add('img', 'instant-slide-image', null, content);
      image.src = slide.dataUrl;
      image.alt = 'Image shown by the presenter';
    }
    else if (slide.kind === 'link') {
      add('div', 'instant-slide-kicker', 'Link', content);
      const link = add('div', 'instant-slide-link', null, content);
      try {
        const url = new URL(slide.url);
        add('strong', '', url.host, link);
        link.appendChild(document.createTextNode(url.pathname + url.search + url.hash));
      } catch { link.textContent = slide.url; }
      const qr = add('div', 'instant-slide-qr', null, content);
      if (slide.qrSvg) {
        const image = add('img', '', null, qr);
        image.alt = 'QR code for this link';
        image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(slide.qrSvg);
      }
    } else {
      add('div', 'instant-slide-kicker', slide.kind === 'time' ? 'Current time' : (slide.label || 'Countdown'), content);
      if (slide.kind === 'countdown') add('div', 'instant-slide-timeup', "Time’s up", content);
      add('div', 'instant-slide-digits', '', content);
      if (slide.kind === 'countdown') {
        const bar = add('div', 'instant-slide-bar', null, content);
        add('i', '', null, bar);
        const meta = add('div', 'instant-slide-bar-meta', null, content);
        add('span', '', '0:00', meta);
        add('span', '', String(Math.round(slide.durationMs / 60000)) + ':00', meta);
      }
      updateClock();
      timer = setInterval(updateClock, slide.kind === 'time' ? 1000 : 100);
    }
  }
  return { show, element: surface, destroy() { if (timer != null) clearInterval(timer); surface.remove(); } };
}

export function instantSlideRuntimeSource() {
  return [instantSlideFromText, createInstantSlideSurface].map((fn) => fn.toString()).join('\n');
}
