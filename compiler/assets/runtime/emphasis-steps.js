// "Emphasis appears on Next" (0.38 ticket 02): the order and the count of a slide's steps when its
// bold, underline, strikethrough and highlight are steps. No closure state; the first five
// functions touch no DOM.
//
// A slide with {emphasis-steps} carries `data-emphasis-steps` on its <section> and
// `data-emph-step` on every <strong>, <u>, <s> and <mark class="ink-marker"> in its body (the
// compiler, lib/emphasis-steps.mjs). The runtimes list the slide's UNITS in page order: the block
// units the reveal and focus modes already step (`kind: 'block'`) and the emphasis spans
// (`kind: 'emphasis'`, `parent` = the position in the list of the block unit that holds the span,
// or null). One integer walks that list:
//
//   mode null (no reveal, no focus)   only the emphasis spans are steps. Step n: the first n
//                                     spans are on. Blocks are not stepped (state null).
//   mode 'reveal' | 'focus'           every unit is a step, in page order: a block appears (or
//                                     comes into focus), then each span inside it turns on, then
//                                     the next block. Step n: the first n units are on. Where the
//                                     slide has two or more blocks one closing step shows them all
//                                     at full strength, as the modes did before emphasis stepped.
//
// The venue screen is sent `{ kind: 'reveal' | 'focus', step }` and nothing else, so the first case
// has no kind of its own on the wire. It is sent as kind 'reveal' with a step PAST the last step
// of the reveal order: `emphasisStepMax(units, 'reveal') + 1 + n`. emphasisWireFocus writes that
// and emphasisFromWire reads it; both sides count the same unit list, so no protocol field changes.
//
// "Play as a step" (0.38 ticket 05) adds a third kind of unit to the SAME list, `kind: 'media'`: a
// video or audio file with {play-on-next} (`data-play-on-next` on its figure or chip, stamped by
// the compiler only on a slide that steps). It is one more position in the one order, carried by
// the same integer and the same wire form, so it needs no field of its own:
//
//   mode null                         a file is a step beside the emphasis spans, in page order.
//   mode 'reveal' | 'focus'           a file is its own block: the step that shows it starts it.
//                                     Where the file sits inside a block unit (a list item, a
//                                     grid cell) that block IS the file's unit (`parent` null); a
//                                     second file in the same block is a step of its own after it
//                                     (`parent` = the block's position).
//
// Playback is read from the step, never sent: mediaStepStates gives each file 'waiting' (its step
// has not come), 'playing' (its step is the newest one reached) or 'played' (the step has moved
// on). A window that opens mid-talk and the venue screen start the file from the step they are sent.
// The image sequence (image-steps.js) runs after these steps without moving the integer, in the
// lightbox state every window is also sent; once it has begun, every file is 'played'.
//
// A file starts only when Next reaches its step. Two rules keep Back from starting one:
//   arriving backwards   a slide entered from the one after it lands "finished": everything on and
//                        every file 'played'. Where the slide's last step is a file's own step that
//                        is one step PAST the last (mediaStepDone); a step past the last always
//                        reads as finished. Next from there leaves the slide.
//   Back inside a slide  never lands on a step at which a file plays: it carries on down to the
//                        nearest step where none does (mediaStepQuiet), so the file whose step is
//                        left goes back to 'waiting' and no earlier one starts.
// On the wire the finished position is the ADR-0035 form with one more:
// `emphasisStepMax(units, 'reveal') + 1 + emphasisStepMax(units, null) + 1`, whatever the mode.
//
// `emphasisStepsRuntimeSource()` serialises all of this into the deck template (07-assembly,
// `<!--EMPHASIS_STEPS_RUNTIME-->`) and into the handout / venue page (09-output-builders);
// scripts/test-emphasis-steps.mjs asserts the same source.

/** The emphasis spans that are steps. Stamped by the compiler only on slides with the option. */
export const EMPH_STEP_SELECTOR = '[data-emph-step]';

/** The files that are steps: the video figure or the audio chip of a {play-on-next} file. */
export const MEDIA_STEP_SELECTOR = '[data-play-on-next]';

function emphasisSteppedMode(mode) {
  return mode === 'reveal' || mode === 'focus';
}

/** A unit the modes show and hide: a block, or a file that is its own block. */
export function stepUnitIsBlock(unit) {
  if (!unit) return true;
  if (unit.kind === 'emphasis') return false;
  return !(unit.kind === 'media' && unit.parent != null);
}

/** The last step of the slide: after it, Next leaves the slide. */
export function emphasisStepMax(units, mode) {
  const list = Array.isArray(units) ? units : [];
  let blocks = 0;
  let inline = 0;
  list.forEach(function (unit) {
    if (stepUnitIsBlock(unit)) blocks += 1;
    if (unit && (unit.kind === 'emphasis' || unit.kind === 'media')) inline += 1;
  });
  if (!emphasisSteppedMode(mode)) return inline;
  return list.length + (blocks > 1 ? 1 : 0);
}

/**
 * The state of every unit at `step`, in the order of `units`.
 *   emphasis span: 'on' | 'off'  (never hidden: 'off' reads as the plain text around it)
 *   block unit:    null where blocks are not stepped (mode null), else the mode's own states,
 *                  'hidden' | 'soft' | 'current' | 'full' for reveal and 'fuzzy' in place of
 *                  'hidden' for focus. 'current' is the newest block shown; it stays current while
 *                  the spans inside it turn on.
 *   file:          as a block where it is its own block, else null (it is never hidden by itself).
 *                  Whether it plays is mediaStepStates.
 */
export function emphasisStepStates(units, mode, step) {
  const list = Array.isArray(units) ? units : [];
  const max = emphasisStepMax(list, mode);
  const at = Math.max(0, Math.min(max, Number(step) || 0));
  if (!emphasisSteppedMode(mode)) {
    let seen = 0;
    return list.map(function (unit) {
      if (unit && unit.kind === 'media') seen += 1;
      if (!unit || unit.kind !== 'emphasis') return null;
      seen += 1;
      return seen <= at ? 'on' : 'off';
    });
  }
  const full = at >= max && at >= list.length;
  const waiting = mode === 'focus' ? 'fuzzy' : 'hidden';
  let current = -1;
  list.forEach(function (unit, i) { if (i < at && stepUnitIsBlock(unit)) current = i; });
  return list.map(function (unit, i) {
    if (unit && unit.kind === 'emphasis') {
      // A span inside a block that has not appeared stays off, wherever the list puts it.
      const parentShown = unit.parent == null || unit.parent < at;
      return i < at && parentShown ? 'on' : 'off';
    }
    if (!stepUnitIsBlock(unit)) return null;
    if (full) return 'full';
    if (i >= at) return waiting;
    return i === current ? 'current' : 'soft';
  });
}

/**
 * Whether each file plays at `step`, in the order of `units`: null for a unit that is not a file,
 * else 'waiting' (its step has not come), 'playing' (its step is the newest one reached) or
 * 'played' (the step has moved past it). At most one file is 'playing'. `movedOn` is true once the
 * slide's image sequence has begun (a later step than any here): every file is then 'played'.
 */
export function mediaStepStates(units, mode, step, movedOn) {
  const list = Array.isArray(units) ? units : [];
  // A step past the last: the slide was entered backwards and is finished (mediaStepDone).
  if (!movedOn && (Number(step) || 0) > emphasisStepMax(list, mode)) movedOn = true;
  if (movedOn) return list.map(function (unit) { return unit && unit.kind === 'media' ? 'played' : null; });
  const at = Math.max(0, Math.min(emphasisStepMax(list, mode), Number(step) || 0));
  const stepped = emphasisSteppedMode(mode);
  let seen = 0;
  return list.map(function (unit, i) {
    const counts = stepped || (unit && (unit.kind === 'emphasis' || unit.kind === 'media'));
    if (counts) seen += 1;
    if (!unit || unit.kind !== 'media') return null;
    return seen === at ? 'playing' : seen < at ? 'played' : 'waiting';
  });
}

/** The position in `units` of the file that plays at `step`; -1 when none does. */
export function mediaStepPlaying(units, mode, step, movedOn) {
  return mediaStepStates(units, mode, step, movedOn).indexOf('playing');
}

/**
 * The step a slide entered BACKWARDS lands on: its last step, or one past it where a file would
 * play at the last step (arriving backwards never starts a file; a step past the last reads as
 * finished, every file 'played').
 */
export function mediaStepDone(units, mode) {
  const max = emphasisStepMax(units, mode);
  return mediaStepPlaying(units, mode, max) >= 0 ? max + 1 : max;
}

/** The nearest step at or below `step` at which no file plays: where Back may land. */
export function mediaStepQuiet(units, mode, step) {
  let at = Math.max(0, Math.min(emphasisStepMax(units, mode), Number(step) || 0));
  while (at > 0 && mediaStepPlaying(units, mode, at) >= 0) at -= 1;
  return at;
}

/** What the venue screen is sent for `mode` + `step` on a slide with emphasis steps. */
export function emphasisWireFocus(units, mode, step) {
  // Finished after a backwards arrival: one past the no-mode range, whatever the mode.
  if ((Number(step) || 0) > emphasisStepMax(units, mode) && mediaStepDone(units, mode) > emphasisStepMax(units, mode)) {
    return { kind: 'reveal', step: emphasisStepMax(units, 'reveal') + 1 + emphasisStepMax(units, null) + 1 };
  }
  const at = Math.max(0, Math.min(emphasisStepMax(units, mode), Number(step) || 0));
  if (emphasisSteppedMode(mode)) return { kind: mode, step: at };
  return { kind: 'reveal', step: emphasisStepMax(units, 'reveal') + 1 + at };
}

/** The reverse of emphasisWireFocus: `{ mode, step }` for a received `{ kind, step }`; null without one. */
export function emphasisFromWire(units, focus) {
  if (!focus || !emphasisSteppedMode(focus.kind)) return null;
  const step = Math.max(0, Number(focus.step) || 0);
  const top = emphasisStepMax(units, focus.kind);
  if (step > top) return { mode: null, step: Math.min(mediaStepDone(units, null), step - top - 1) };
  return { mode: focus.kind, step: step };
}

// ── The DOM side, shared by the runtimes so none of them repeats it ─────────────────────────────

/**
 * The listed element a {play-on-next} file sits in: its nearest ancestor in `listed` that is
 * neither an emphasis span nor a file. Null when it sits in none.
 */
export function mediaStepHolder(file, listed) {
  let node = file.parentElement;
  while (node) {
    if (listed.has(node) && !node.hasAttribute('data-emph-step') && !node.hasAttribute('data-play-on-next')) return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * The file a listed element stands for: the element itself when it carries `data-play-on-next`,
 * else the first file inside it that is not listed by itself (the block is that file's unit).
 * Null for a plain block and for an emphasis span.
 */
export function mediaStepFile(el, listed) {
  if (el.hasAttribute('data-emph-step')) return null;
  if (el.hasAttribute('data-play-on-next')) return el;
  const inside = el.querySelectorAll('[data-play-on-next]');
  for (let i = 0; i < inside.length; i += 1) {
    if (!listed.has(inside[i]) && mediaStepHolder(inside[i], listed) === el) return inside[i];
  }
  return null;
}

/**
 * The slide's units in page order. `scope` is the slide (or the card on show in a carousel),
 * `blockSelector` the runtime's own list of block units ('' for none), `isVisible` its test for a
 * unit that is laid out. The first {play-on-next} file inside a block unit is not listed: the
 * block is its unit, so showing the block and starting the file are one step.
 */
export function emphasisStepElements(scope, blockSelector, isVisible) {
  if (!scope) return [];
  const selector = (blockSelector ? blockSelector + ',' : '') + EMPH_STEP_SELECTOR + ',' + MEDIA_STEP_SELECTOR;
  const found = Array.from(scope.querySelectorAll(selector)).filter(function (el) {
    return typeof isVisible === 'function' ? isVisible(el) : true;
  });
  const listed = new Set(found);
  const taken = new Set();
  return found.filter(function (el) {
    if (!el.hasAttribute('data-play-on-next')) return true;
    const holder = mediaStepHolder(el, listed);
    if (!holder || taken.has(holder)) return true;
    taken.add(holder);
    listed.delete(el);
    return false;
  });
}

/** `{ kind, parent }` for each element emphasisStepElements returned. */
export function emphasisStepUnits(els) {
  const listed = new Set(els);
  const blockAt = new Map();
  function holderOf(el) {
    let node = el.parentElement;
    while (node && !blockAt.has(node)) node = node.parentElement;
    return node ? blockAt.get(node) : null;
  }
  return els.map(function (el, i) {
    if (el.hasAttribute('data-emph-step')) return { kind: 'emphasis', parent: holderOf(el) };
    const parent = el.hasAttribute('data-play-on-next') ? holderOf(el) : null;
    blockAt.set(el, i);
    return { kind: mediaStepFile(el, listed) ? 'media' : 'block', parent: parent };
  });
}

/** The file each element emphasisStepElements returned stands for (null where it is not a file's unit). */
export function mediaStepFiles(els) {
  const listed = new Set(els);
  return els.map(function (el) { return mediaStepFile(el, listed); });
}

/**
 * Write `data-emph-state` ("on" | "off") on the emphasis spans in `els`, only where it changes,
 * and clear it from every other span under `root`. A span without the attribute shows its
 * emphasis: that is what handouts, print, thumbnails and previews of other slides render.
 */
export function paintEmphasisStates(root, els, states) {
  const live = new Set();
  els.forEach(function (el, i) {
    if (!el.hasAttribute('data-emph-step')) return;
    live.add(el);
    const want = states[i] === 'off' ? 'off' : 'on';
    if (el.getAttribute('data-emph-state') !== want) el.setAttribute('data-emph-state', want);
  });
  if (!root) return;
  root.querySelectorAll('[data-emph-state]').forEach(function (el) {
    if (!live.has(el)) el.removeAttribute('data-emph-state');
  });
}

/**
 * Bold reserves its width from the start (styles/emphasis-steps.css): the bold words are laid out
 * and a copy at the weight of the text AROUND the bold is drawn over them until the step. CSS
 * cannot name that weight from inside the <strong>, so it is read once here and handed over as
 * `--emph-plain-weight`. `styleOf` is getComputedStyle; it answers for a slide that is not shown.
 */
export function stampEmphasisPlainWeight(root, styleOf) {
  if (!root || typeof styleOf !== 'function') return;
  root.querySelectorAll('strong[data-emph-step]').forEach(function (el) {
    if (!el.parentElement || el.style.getPropertyValue('--emph-plain-weight')) return;
    const weight = styleOf(el.parentElement).fontWeight;
    if (weight) el.style.setProperty('--emph-plain-weight', String(weight));
  });
}

export function emphasisStepsRuntimeSource() {
  return [
    'const EMPH_STEP_SELECTOR = ' + JSON.stringify(EMPH_STEP_SELECTOR) + ';',
    'const MEDIA_STEP_SELECTOR = ' + JSON.stringify(MEDIA_STEP_SELECTOR) + ';'
  ].concat([
    emphasisSteppedMode, stepUnitIsBlock, emphasisStepMax, emphasisStepStates, mediaStepStates, mediaStepPlaying,
    mediaStepDone, mediaStepQuiet,
    emphasisWireFocus, emphasisFromWire, mediaStepHolder, mediaStepFile,
    emphasisStepElements, emphasisStepUnits, mediaStepFiles, paintEmphasisStates, stampEmphasisPlainWeight
  ].map((fn) => fn.toString())).join('\n');
}
