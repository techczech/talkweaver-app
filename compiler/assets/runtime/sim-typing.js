// Typing and token streaming for the chat and terminal simulation slides (0.38.2, owner request
// 2026-10-09; spec: docs/design/2026-10-08-ai-chat-and-terminal-simulation-designs/
// ai-chat-and-terminal-simulation-locked-spec.md, "Typing and streaming").
//
// What types: on {terminal} and {terminal-agent}, the whole text of every part that a step reveals
// (Next on a step-by-step slide; arriving at a slide shows what is visible complete, 0.38.2 owner
// verdict 9 Oct 23:30); on {chat} and {chat-lanes} with
// `stream=on`, the answer and reasoning text of the parts a step reveals (every other part of the queue appears
// whole when its turn comes). Parts that come on screen together type one after another, in
// reading order. The rate is one constant: simTypingCharsPerSecond().
//
// The shared state names the move (state.simType = { slideId, from, to, at, done }); the progress is
// a pure function of the time since `at`, so every window that shows the slide (audience, plain
// presentation window, the presenter's Current pane, a late joiner) computes the same characters
// from the same timestamp. Nothing here writes markup: a text node is shortened and the rest of
// its text goes into one `.sim-typing-rest` span (visibility: hidden, so the text keeps its place
// and nothing on screen moves); finishing puts every node back as it was.
//
// Each function is embedded in the deck by `.toString()` (simTypingRuntimeSource), so each is
// self-contained: no module-level constants.

/** 40 tokens a second at about 4 characters a token. The one place the rate is set. */
export function simTypingCharsPerSecond() {
  return 40 * 4;
}

/** Characters typed `elapsedMs` after the move. */
export function simTypedChars(elapsedMs, cps) {
  const rate = Number(cps) > 0 ? Number(cps) : simTypingCharsPerSecond();
  const elapsed = Number(elapsedMs);
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
  return Math.floor((elapsed * rate) / 1000);
}

/**
 * Where each queued part stands after `chars` characters. Parts type one after another: a part
 * waits (hidden, its space kept) until every part before it is finished, then types its own
 * length; a part with nothing to type is finished the moment its turn comes.
 * @param {number[]} lengths characters each part types, in reading order
 * @returns {{ state: 'wait' | 'typing' | 'done', shown: number }[]}
 */
export function simTypingStates(lengths, chars) {
  const typed = Math.max(0, Math.floor(Number(chars) || 0));
  const out = [];
  let start = 0;
  for (const raw of lengths || []) {
    const length = Math.max(0, Math.floor(Number(raw) || 0));
    const end = start + length;
    if (typed < start) out.push({ state: 'wait', shown: 0 });
    else if (typed >= end) out.push({ state: 'done', shown: length });
    else out.push({ state: 'typing', shown: typed - start });
    start = end;
  }
  return out;
}

/** A move's state as shared between windows, or null when it is not one. */
export function normaliseSimType(value) {
  if (!value || typeof value !== 'object' || typeof value.slideId !== 'string' || !value.slideId) return null;
  const from = Math.floor(Number(value.from));
  const to = Math.floor(Number(value.to));
  const at = Number(value.at);
  if (!Number.isFinite(from) || from < -1 || !Number.isFinite(to) || to < 0 || !Number.isFinite(at)) return null;
  return { slideId: value.slideId, from, to, at, done: Boolean(value.done) };
}

/**
 * The parts a move brings on screen, each with the text nodes it types (reading order).
 * `move.from` = how many steps were on screen before (arrival makes no move: it shows complete); `move.to` = the step after the
 * move; `move.stepped` = the slide is under step reveal (otherwise every part is on screen).
 * Text inside a disclosure control, decorative (aria-hidden) chrome and a closed part's body is
 * never typed: it is not on screen or not part of the conversation.
 * @returns {{ el: Element, nodes: Text[], length: number }[]}
 */
export function simTypingUnits(slide, move) {
  const root = slide && slide.querySelector ? slide.querySelector('.sim:not(.sim-static)') : null;
  if (!root || !move) return [];
  const terminal = root.classList.contains('sim-terminal');
  const stream = root.getAttribute('data-stream') === 'on';
  if (!terminal && !stream) return [];
  const steps = Array.from(root.querySelectorAll('.sim-step'));
  const shown = move.stepped ? steps.slice(0, Math.max(0, Math.min(steps.length, move.to))) : steps;
  let units = shown.slice(Math.max(0, move.from));
  units = units.sort((a, b) => (a === b ? 0 : a.compareDocumentPosition(b) & 4 ? -1 : 1));
  const TEXT = 4;
  return units.map((el) => {
    const nodes = [];
    const walker = el.ownerDocument.createTreeWalker(el, TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !node.data) continue;
      if (parent.closest('.sim-toggle, [aria-hidden="true"], .sim-typing-rest, .is-closed .sim-body')) continue;
      if (!terminal && !parent.closest('.sim-answer-text > p, .sim-reasoning-text')) continue;
      nodes.push(node);
    }
    return { el, nodes, length: nodes.reduce((sum, node) => sum + node.data.length, 0) };
  });
}

/**
 * The animator for one window. `now()` and `frame(callback)` / `cancelFrame(handle)` are injected
 * (the deck passes Date.now and requestAnimationFrame; tests pass a fake clock). Typing ignores
 * prefers-reduced-motion on purpose: it is the simulated answer the author asked for, not decoration.
 *   sync(slide, move)  show `slide` as `move` says at this moment, and keep it moving until the
 *                      move is finished. A null or finished move shows the text
 *                      whole. Called after every shared-state change and when the Current pane's
 *                      picture is rebuilt; the same move on the same slide just carries on.
 *   busy(slide, move)  whether the move is still typing now (the next Next press finishes it).
 *   stop()             put every text node back and stop.
 */
export function createSimTyping(options) {
  const now = options.now;
  const frame = options.frame;
  const cancelFrame = options.cancelFrame || function () {};
  const cps = options.cps || simTypingCharsPerSecond();
  let job = null;
  let handle = 0;

  function keyOf(slide, move) {
    return move ? [move.slideId, move.from, move.to, move.at, move.stepped ? 1 : 0].join(':') : '';
  }
  function showNode(record, count) {
    const full = record.full;
    let k = Math.max(0, Math.min(full.length, count));
    // Never split a surrogate pair.
    if (k > 0 && k < full.length) {
      const code = full.charCodeAt(k - 1);
      if (code >= 0xd800 && code <= 0xdbff) k += 1;
    }
    if (record.node.data !== full.slice(0, k)) record.node.data = full.slice(0, k);
    if (k >= full.length) {
      if (record.rest) { record.rest.remove(); record.rest = null; }
      return;
    }
    if (!record.rest) {
      record.rest = record.node.ownerDocument.createElement('span');
      record.rest.className = 'sim-typing-rest';
      record.node.after(record.rest);
    }
    if (record.rest.textContent !== full.slice(k)) record.rest.textContent = full.slice(k);
  }
  function showUnit(unit, state, shown) {
    unit.el.classList.toggle('sim-typing-wait', state === 'wait');
    unit.el.classList.toggle('sim-typing', state === 'typing');
    let left = state === 'typing' ? shown : Infinity;
    for (const record of unit.records) {
      showNode(record, left);
      left = Math.max(0, left - record.full.length);
    }
  }
  function restore() {
    if (handle) { cancelFrame(handle); handle = 0; }
    if (!job) return;
    for (const unit of job.units) showUnit(unit, 'done', 0);
    job = null;
  }
  function paint() {
    handle = 0;
    if (!job) return;
    const chars = simTypedChars(now() - job.at, cps);
    if (chars >= job.total) { restore(); return; }
    const states = simTypingStates(job.units.map((unit) => unit.length), chars);
    job.units.forEach((unit, i) => showUnit(unit, states[i].state, states[i].shown));
    handle = frame(paint);
  }
  function lengthOf(slide, move) {
    if (job && job.slide === slide && job.key === keyOf(slide, move)) return job.total;
    return simTypingUnits(slide, move).reduce((sum, unit) => sum + unit.length, 0);
  }
  return {
    sync(slide, move) {
      if (!slide || !move || move.done) { restore(); return; }
      const key = keyOf(slide, move);
      if (job && job.slide === slide && job.key === key) { if (!handle) paint(); return; }
      restore();
      const units = simTypingUnits(slide, move).map((unit) => ({
        el: unit.el,
        length: unit.length,
        records: unit.nodes.map((node) => ({ node, full: node.data, rest: null }))
      }));
      const total = units.reduce((sum, unit) => sum + unit.length, 0);
      if (!total) return;
      job = { slide, key, at: move.at, units, total };
      paint();
    },
    busy(slide, move) {
      if (!slide || !move || move.done) return false;
      return simTypedChars(now() - move.at, cps) < lengthOf(slide, move);
    },
    stop: restore
  };
}

export function simTypingRuntimeSource() {
  return [simTypingCharsPerSecond, simTypedChars, simTypingStates, normaliseSimType, simTypingUnits, createSimTyping]
    .map((fn) => fn.toString()).join('\n');
}
