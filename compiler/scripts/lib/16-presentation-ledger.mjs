// Presentation Ledger (Recording Capture, Phase 1): the pure session math behind a
// recorded run-through — pause-aware duration, the slide-time index, the session id,
// the discard rule, and the session.json (de)serialise. Everything here is plain Node
// (no Electron) so scripts/test-presentation-ledger.mjs exercises it directly. Like
// 13-slide-ledger's mintId(rng), nothing here reads the clock or randomness itself:
// callers pass `now`/`rand` in, keeping every function deterministic and testable.

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

// `sess-<utc>-<rand>`: a UTC wall-clock stamp plus one base36 char of entropy to
// break ties within the same second. `rand()` is a [0,1) source (Math.random in
// production); `(0.5).toString(36)` → "0.i", so slice(2,3) takes the char after the
// dot. The `|| "0"` guards the rand()===0 edge, where toString(36) has no fraction.
export function newSessionId(now, rand) {
  const randChar = rand().toString(36).slice(2, 3) || "0";
  return `sess-${utcStamp(now)}-${randChar}`;
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

// The stored slide-time index: enter/reveal/highlight/pause/resume marks re-based from the
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
    } else if (m.event === "enter" || m.event === "reveal" || m.event === "highlight") {
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
