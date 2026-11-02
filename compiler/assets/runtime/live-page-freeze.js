// Freeze and mark on a live web page, the deck's side (main's side: src/main/live-page-freeze.ts and
// live-page-host.ts). Design: docs/design/2026-10-28-embed-objects-and-pointing/
// design-live-page-pointing-and-annotation-options-2026-10-28.md (locked 2026-10-28).
//
// Turning on Pointer or Pen on a live page asks main for a freeze (the deck's polled report carries
// { seq, want }); main shows the same picture in every deck window that shows the page and only then
// tells the presenter to turn the tool on. A displayed saved view is marked as it is, without main.
// Nothing here writes, uploads or touches the remote page: the picture is an img.src in the slot.

export const LIVE_FREEZE_LIMITS = { stills: 20, srcChars: 6_000_000, pendingMs: 4000 };
export const LIVE_FREEZE_TEXT = {
  pending: 'Freezing the audience view…',
  frozen: 'Frozen view: the room sees this picture',
  frozenPresenter: 'Frozen from the presenter view',
  saved: 'Marking the saved view',
  notShowing: 'The page is not showing yet, so there is nothing to point at.',
  wholePage: 'Pointer and Pen mark a saved view of the visible page, not an Entire page view.',
  savedChanged: 'The saved view changed, so Pointer and Pen are off.',
  failed: "Couldn't freeze the page. Pointer and Pen are off; the live page is unchanged."
};
const STILL_ID = /^[0-9a-f]{16}$/;
const JPEG_SRC = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;

/** A deck's key for a saved view's picture (its data: address): 16 hex, the same in every window. */
export function liveStillKey(src) {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  const text = String(src);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
    b ^= b >>> 15;
  }
  return a.toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** Main's message about a frozen picture, checked field by field; a new plain object, or null. */
export function liveFrozenMessage(raw) {
  let m = raw;
  try { if (typeof raw === 'string') { if (raw.length > LIVE_FREEZE_LIMITS.srcChars + 4096) return null; m = JSON.parse(raw); } } catch { return null; }
  if (!m || typeof m !== 'object' || Array.isArray(m) || m.v !== 1) return null;
  if (!['show', 'on', 'clear'].includes(m.op)) return null;
  if (!Number.isSafeInteger(m.seq) || m.seq < 0) return null;
  if (typeof m.slideId !== 'string' || m.slideId.length > 128 || typeof m.url !== 'string' || !m.url || m.url.length > 2048) return null;
  const base = { v: 1, op: m.op, seq: m.seq, slideId: m.slideId, url: m.url };
  if (m.op === 'clear') return { ...base, message: typeof m.message === 'string' ? m.message.slice(0, 300) : '' };
  if (typeof m.id !== 'string' || !STILL_ID.test(m.id)) return null;
  if (m.op === 'on') return { ...base, id: m.id };
  if (typeof m.src !== 'string' || m.src.length > LIVE_FREEZE_LIMITS.srcChars || !JPEG_SRC.test(m.src)) return null;
  if (!Number.isSafeInteger(m.width) || !Number.isSafeInteger(m.height) || m.width < 1 || m.height < 1 || m.width > 10000 || m.height > 20000) return null;
  return { ...base, id: m.id, src: m.src, width: m.width, height: m.height, source: m.source === 'presenter' ? 'presenter' : 'audience' };
}

/** Two addresses are the same page when their parsed forms are (the slot's raw text may lack a slash). */
export function liveSamePage(a, b) {
  const key = (u) => { try { return new URL(String(u)).href; } catch { return String(u || ''); } };
  return key(a) === key(b);
}

/**
 * The pictures marked this talk: at most `limit` ids. A new id past the limit drops the oldest one
 * without marks, else the oldest; `note` returns the dropped id (its marks are cleared by the caller).
 */
export function createLiveStillLedger(limit = LIVE_FREEZE_LIMITS.stills) {
  const ids = [];
  return {
    note(id, hasMarks = () => false) {
      const at = ids.indexOf(id);
      if (at >= 0) { ids.splice(at, 1); ids.push(id); return null; }
      ids.push(id);
      if (ids.length <= limit) return null;
      const candidates = ids.slice(0, -1);
      const drop = candidates.find((x) => !hasMarks(x)) ?? candidates[0];
      ids.splice(ids.indexOf(drop), 1);
      return drop;
    },
    has(id) { return ids.includes(id); },
    ids() { return ids.slice(); }
  };
}

/**
 * The presenter deck's freeze, as a state machine without DOM. Phases: 'off', 'pending' (asked main),
 * 'frozen' (a picture is shown and marked). `seq` and `want()` are what the report carries; main acts
 * on a change of seq only. Each call answers what the deck should do now.
 */
export function createLiveFreeze() {
  let s = { phase: 'off', seq: 0, tool: null, id: null, src: null, source: null, slideId: '', url: '', since: 0 };
  const off = () => { s = { ...s, phase: 'off', tool: null, id: null, src: null, source: null, since: 0 }; };
  return {
    state() { return { ...s }; },
    /** The report's want: the tool while main's freeze runs or shows, else null (a saved view needs no main). */
    want() { return s.phase !== 'off' && s.source !== 'saved' ? s.tool : null; },
    /**
     * Pointer or Pen turned on. `ctx`: { slideId, url, live (the page shows and can be captured),
     * saved: { src, mode } | null (a saved view is shown instead of the page), now }.
     * Answers { do: 'pending' | 'cancel' | 'swap' | 'arm' | 'refuse', message? }.
     */
    press(tool, ctx) {
      if (s.phase === 'pending') {
        if (s.tool === tool) { s.seq++; off(); return { do: 'cancel' }; }
        s.tool = tool; return { do: 'swap' };
      }
      if (s.phase === 'frozen') { s.tool = tool; return { do: 'arm' }; }
      if (ctx.saved) {
        if (ctx.saved.mode === 'page') return { do: 'refuse', message: LIVE_FREEZE_TEXT.wholePage };
        s = { ...s, phase: 'frozen', tool, id: liveStillKey(ctx.saved.src), src: ctx.saved.src, source: 'saved', slideId: ctx.slideId, url: ctx.url, since: 0 };
        return { do: 'arm' };
      }
      if (!ctx.live) return { do: 'refuse', message: LIVE_FREEZE_TEXT.notShowing };
      s = { ...s, phase: 'pending', seq: s.seq + 1, tool, slideId: ctx.slideId, url: ctx.url, since: ctx.now ?? 0 };
      return { do: 'pending' };
    },
    /** Esc or the tool button turned off: a pending freeze is cancelled; a frozen picture stays. */
    toolOff() {
      if (s.phase === 'pending') { s.seq++; off(); return 'cancel'; }
      return s.phase === 'frozen' ? 'keep' : null;
    },
    /** Return Live: the freeze ends (a saved view goes back to the live page too). */
    live() {
      if (s.phase === 'off') return null;
      const source = s.source;
      s.seq++; off();
      return source === 'saved' ? 'saved' : 'live';
    },
    /** Main showed the picture: accepted only for this press, slide and page. */
    show(m) {
      if (s.phase !== 'pending' || m.seq !== s.seq || m.slideId !== s.slideId || !liveSamePage(m.url, s.url)) return false;
      s = { ...s, id: m.id, src: m.src, source: m.source };
      return true;
    },
    /** Main: every window shows it; the tool to turn on now (null when this is not the pending press). */
    on(m) {
      if (s.phase !== 'pending' || m.seq !== s.seq || m.id !== s.id) return null;
      s = { ...s, phase: 'frozen' };
      return s.tool;
    },
    /** Main dropped the picture (failure, cancel, Live elsewhere): true when it was this freeze. */
    clear(m) {
      if (s.phase === 'off' || s.source === 'saved' || m.seq !== s.seq) return false;
      off();
      return true;
    },
    /** The press has waited too long for main: given up (seq bumped so main drops it too). */
    expire(now) {
      if (s.phase !== 'pending' || now - s.since < LIVE_FREEZE_LIMITS.pendingMs) return false;
      s.seq++; off();
      return true;
    },
    /** Another slide or page: the freeze ends with it. */
    leave() {
      if (s.phase === 'off') return false;
      if (s.source !== 'saved') s.seq++;
      off();
      return true;
    }
  };
}

export function liveFreezeRuntimeSource() {
  return [`const LIVE_FREEZE_LIMITS = ${JSON.stringify(LIVE_FREEZE_LIMITS)};`, `const LIVE_FREEZE_TEXT = ${JSON.stringify(LIVE_FREEZE_TEXT)};`,
    `const LIVE_STILL_ID = ${STILL_ID};`, `const LIVE_JPEG_SRC = ${JPEG_SRC};`]
    .concat([liveStillKey, liveFrozenMessage, liveSamePage, createLiveStillLedger, createLiveFreeze].map((fn) => fn.toString()))
    .join('\n').replace(/\bSTILL_ID\b/g, 'LIVE_STILL_ID').replace(/\bJPEG_SRC\b/g, 'LIVE_JPEG_SRC').replace(/LIVE_LIVE_/g, 'LIVE_');
}
