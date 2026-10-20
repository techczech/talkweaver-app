// Presentation Ledger (Recording Capture, Phase 1): the pure session math behind a
// recorded run-through — pause-aware duration, the slide-time index, the session id,
// the discard rule, and the session.json (de)serialise. Everything here is plain Node
// (no Electron) so scripts/test-presentation-ledger.mjs exercises it directly. Like
// 13-slide-ledger's mintId(rng), nothing here reads the clock or randomness itself:
// callers pass `now`/`rand` in, keeping every function deterministic and testable.

import { penInkView } from '../../assets/runtime/pen-ink.js';

// YYYYMMDD-HHMMSS in UTC. Identical recipe to 13-slide-ledger's utcStamp (kept local
// so this module imports nothing from its sibling — no coupling, no cycle risk).
function utcStamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    "-" + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds())
  );
}

// `sess-<utc>-<rand>`: a UTC wall-clock stamp plus SESSION_ID_RAND_CHARS base36 chars of
// entropy, so two saves in the same second do not share an id (one char gave a 1-in-36 clash;
// eight give about 1 in 2.8 trillion). `rand()` is a [0,1) source — main passes a crypto-backed
// one; each char is floor(rand()*36), clamped so a stray 1 or NaN still yields a valid char.
// Ids made before this change carry one char (`sess-20260710-141204-u`); every reader treats an id
// as an opaque safe token, so old and new ids both keep working.
export const SESSION_ID_RAND_CHARS = 8;
const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";
export function newSessionId(now, rand) {
  let tail = "";
  for (let i = 0; i < SESSION_ID_RAND_CHARS; i++) {
    const r = Number(rand());
    const k = Number.isFinite(r) ? Math.floor(r * 36) : 0;
    tail += BASE36[Math.min(35, Math.max(0, k))];
  }
  return `sess-${utcStamp(now)}-${tail}`;
}

// Pause-aware recorded length. `marks` are on the raw MediaRecorder clock; a `pause`
// opens a paused span that its next `resume` closes, and those spans are subtracted
// from the total. Returns lastTMs − totalPaused. If the run ends while still paused
// (no closing resume), the open span is charged up to the last mark, so the recorded
// length is the content captured before the pause.
export function recordingMsFromMarks(marks) {
  let totalPaused = 0;
  let pauseStart = null;
  let last = 0;
  for (const m of marks) {
    if (typeof m.tMs === "number") last = m.tMs;
    if (m.event === "pause" && pauseStart === null) pauseStart = m.tMs;
    else if (m.event === "resume" && pauseStart !== null) {
      totalPaused += m.tMs - pauseStart;
      pauseStart = null;
    }
  }
  if (pauseStart !== null) totalPaused += last - pauseStart;
  return last - totalPaused;
}

// The stored slide-time index: enter/reveal/highlight/ink/clip/pause/resume marks re-based from the
// raw clock onto the recording clock (paused spans removed). A pause and its resume collapse
// to the same recording-clock instant, since no recorded time passes while paused. `enter`
// (slide change), `reveal` (an in-slide build step) and `highlight` (a live highlight change)
// each carry their slideId so replay can reproduce exactly what was on screen; `stop`/unknown
// events are not part of the index.
export function buildSlideTimeIndex(rawMarks) {
  const out = [];
  let paused = 0;         // total completed paused time so far
  let pauseStart = null;  // start of an open pause, or null
  for (const m of rawMarks) {
    if (m.event === "pause") {
      out.push({ event: "pause", tMs: m.tMs - paused });
      if (pauseStart === null) pauseStart = m.tMs;
    } else if (m.event === "resume") {
      if (pauseStart !== null) { paused += m.tMs - pauseStart; pauseStart = null; }
      out.push({ event: "resume", tMs: m.tMs - paused });
    } else if (m.event === "enter" || m.event === "reveal" || m.event === "highlight" || m.event === "ink" || m.event === "clip") {
      // If a mark somehow lands inside an open pause, freeze it at the pause start.
      const openPaused = pauseStart !== null ? m.tMs - pauseStart : 0;
      const mark = { event: m.event, slideId: m.slideId, tMs: m.tMs - paused - openPaused };
      // Carry the state the replay needs: reveal = fragments still hidden; highlight = mark count
      // plus reconstructed ranges when the capture bridge could resolve them.
      if (m.event === "reveal") mark.hidden = m.hidden;
      if (m.event === "highlight") {
        mark.marks = m.marks;
        if (Array.isArray(m.ranges)) mark.ranges = m.ranges;
      }
      // clip = a slide video started playing: the clip as authored and where in it (seconds). It
      // changes no slide window, duration or text; a malformed one is dropped.
      if (m.event === "clip") {
        const c = m.clip;
        if (typeof m.slideId !== "string" || m.slideId.length > 100 || !c || typeof c.src !== "string" || c.src.length > 2000 || typeof c.atS !== "number" || !Number.isFinite(c.atS) || c.atS < 0 || c.atS > 86400) continue;
        mark.clip = { src: c.src, atS: c.atS };
      }
      // ink = the Pen's strokes on the layer shown (ticket 08): the slide's own, or a zoomed image's
      // (space "image" and its index, in the image's 0–1 units). Checked again, caps and bytes
      // included, before they are stored; a malformed mark is dropped.
      if (m.event === "ink") {
        const image = m.space === "image";
        const view = typeof m.slideId === "string"
          ? penInkView({ slideId: m.slideId, space: image ? "image" : "slide", ...(image ? { image: m.image } : {}), strokes: m.ink, draft: null })
          : null;
        if (!view) continue;
        if (image) { mark.space = "image"; mark.image = view.image; }
        mark.ink = view.strokes;
      }
      out.push(mark);
    }
  }
  return out;
}

// A run shorter than the threshold is offered for discard (too brief to be worth keeping).
export function isDiscardable(recordingMs, thresholdMs) {
  return recordingMs < thresholdMs;
}

// session.json (de)serialise. Pretty-printed so the on-disk file stays readable and
// greppable, matching the house preference for legible stores.
export function serialiseSession(session) {
  return JSON.stringify(session, null, 2);
}

export function parseSession(text) {
  return JSON.parse(text);
}
