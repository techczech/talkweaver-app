// The trace window (ADR-0039, 0.41 ticket 11): a {trace} transcript is a fixed window at the
// scene's larger text. It is never shrunk or cut to fit. Turns arrive one at a time under reveal
// (and come into focus under focus); when the pile no longer fits the window it scrolls up by
// WHOLE turns, so the newest turn is complete and no turn is clipped mid-way at the top. Drawing:
// docs/design/2026-10-16-slide-scene-formatting/after/18-trace.html (and 18-trace-scroll.html).
//
// The window position is derived from the step alone (as the simulation's anchorSimScroll is), so
// the audience window, the presenter's Current pane, a step back and a late joiner agree:
//   newest = the turn whose data-mode-state is "current"; the last turn when the slide shows every
//            turn ("full", or no mode at all); none at step 0 (every turn hidden or fuzzy).
//   top    = the first turn from which every turn down to the newest fits in the window.
// The trace stays a scroll box; the runtime sets its scrollTop to that turn's top. When the turns do
// not all fit (a long trace, or one turn taller than the window) it can also be scrolled by hand,
// so nothing is ever out of reach. Its vertical padding is a border in the panel colour
// (skin/zz-scene-trace.css), so a turn scrolled above the window never shows in the padding. When
// the last turn is the newest there may be too little below it to scroll that far: the runtime
// then adds the missing room as bottom padding (the empty space under the answer in the drawing).
// A move between steps eases over 0.8 s (power2.inOut), as the drawing's presenter note says;
// arriving at a slide, a reduced-motion setting and the presenter's preview place it at once.
//
// Both runtimes inline these functions by `.toString()` (traceWindowRuntimeSource): the deck
// (07-assembly, <!--TRACE_WINDOW_RUNTIME-->) and the handout / venue page (09-output-builders). So
// each function is self-contained: no module-level constants.

/**
 * Index of the turn the window starts at: the least k such that turns k..newest fit in `room`.
 * @param {number[]} tops each turn's top, in one coordinate space
 * @param {number[]} bottoms each turn's bottom (without its trailing gap)
 * @param {number} room the window's inner height
 * @param {number} newest index of the newest shown turn; -1 when none is shown
 */
export function traceWindowStart(tops, bottoms, room, newest) {
  if (!(newest >= 0) || !tops.length) return 0;
  const last = Math.min(newest, tops.length - 1);
  let k = 0;
  // 0.5 px of slack: sub-pixel layout must not push a turn that fits off the top.
  while (k < last && bottoms[last] - tops[k] > room + 0.5) k += 1;
  return k;
}

/**
 * The newest shown turn of a trace from the states the runtime painted on its turns.
 * @param {string[]} states each turn's data-mode-state ("" when the turn carries none)
 */
export function traceNewestTurn(states) {
  if (!states.length) return -1;
  // No state on any turn: no mode on this slide, every turn is shown.
  if (states.every((s) => !s)) return states.length - 1;
  const current = states.indexOf("current");
  if (current >= 0) return current;
  if (states.some((s) => s === "full")) return states.length - 1;
  // Soft turns without a current one (should not happen): the last soft one is the newest.
  const soft = states.lastIndexOf("soft");
  return soft;
}

/** power2.inOut over t in [0, 1]. */
export function traceEase(t) {
  const x = Math.max(0, Math.min(1, t));
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}

/**
 * Place every trace window on `slide`.
 * @param {Element} slide
 * @param {{ animate?: boolean }} [options] animate: ease the move (a step on the slide already shown)
 */
export function placeTraceWindows(slide, options) {
  if (!slide || typeof slide.querySelectorAll !== "function") return;
  const animate = Boolean(options && options.animate);
  const view = slide.ownerDocument && slide.ownerDocument.defaultView;
  const reduced = Boolean(view && view.matchMedia && view.matchMedia("(prefers-reduced-motion: reduce)").matches);
  slide.querySelectorAll(".trace").forEach(function (trace) {
    const turns = Array.prototype.filter.call(trace.children, function (el) { return el.classList.contains("turn"); });
    if (!turns.length || !trace.clientHeight) return;
    const newest = traceNewestTurn(turns.map(function (el) { return el.getAttribute("data-mode-state") || ""; }));
    // Offsets from the trace's own padding edge (the trace is position: relative): the tail
    // padding added on an earlier step does not move them.
    const tops = turns.map(function (el) { return el.offsetTop; });
    const bottoms = turns.map(function (el) { return el.offsetTop + el.offsetHeight; });
    const cs = view ? view.getComputedStyle(trace) : null;
    const padTop = cs ? parseFloat(cs.paddingTop) || 0 : 0;
    const room = trace.clientHeight - padTop;
    const k = traceWindowStart(tops, bottoms, room, newest);
    const target = Math.max(0, tops[k] - tops[0]);
    // Room under the last turn so the box can scroll as far as the target. Only when it moves: a
    // trace that fits is sized to its turns, and room added there would make the box grow.
    const contentBottom = bottoms[bottoms.length - 1] - tops[0] + padTop;
    const tail = target > 0 ? Math.max(0, Math.ceil(target + trace.clientHeight - contentBottom)) : 0;
    const tailCss = tail ? tail + "px" : "";
    if (trace.style.paddingBottom !== tailCss) trace.style.paddingBottom = tailCss;
    trace.setAttribute("data-trace-start", String(k));
    // Never truncates (review fix, 0.41 ticket 11): stepping reaches every turn's top, but not the
    // tail of a turn taller than the window, nor the turns above the start of a long trace shown
    // with no mode. So whenever the turns do not all fit, the window can also be scrolled by hand
    // (wheel or trackpad; skin/zz-scene-trace.css). The next step still puts it back at its
    // whole-turn position.
    const overflow = bottoms[bottoms.length - 1] - tops[0] > room + 0.5;
    if (overflow) trace.setAttribute("data-trace-overflow", ""); else trace.removeAttribute("data-trace-overflow");
    if (trace.__twTraceTarget === target && trace.__twTraceTween) return;
    if (trace.__twTraceTween && view) view.cancelAnimationFrame(trace.__twTraceTween);
    trace.__twTraceTween = 0;
    trace.__twTraceTarget = target;
    const from = trace.scrollTop;
    if (!animate || reduced || !view || Math.abs(target - from) < 1) {
      trace.scrollTop = target;
      return;
    }
    const start = view.performance.now();
    const step = function (now) {
      const t = Math.min(1, (now - start) / 800);
      trace.scrollTop = from + (target - from) * traceEase(t);
      trace.__twTraceTween = t < 1 ? view.requestAnimationFrame(step) : 0;
    };
    trace.__twTraceTween = view.requestAnimationFrame(step);
  });
}

/** Put every trace on `root` back to its top, without tail room or window marks (print, and a handout slide with no stepping mode, show the trace as before). */
export function resetTraceWindows(root) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  root.querySelectorAll(".trace").forEach(function (trace) {
    const view = trace.ownerDocument && trace.ownerDocument.defaultView;
    if (trace.__twTraceTween && view) view.cancelAnimationFrame(trace.__twTraceTween);
    trace.__twTraceTween = 0;
    trace.__twTraceTarget = undefined;
    trace.style.paddingBottom = "";
    trace.removeAttribute("data-trace-start");
    trace.removeAttribute("data-trace-overflow");
    trace.scrollTop = 0;
  });
}

export function traceWindowRuntimeSource() {
  return [traceWindowStart, traceNewestTurn, traceEase, placeTraceWindows, resetTraceWindows]
    .map((fn) => fn.toString()).join("\n");
}
