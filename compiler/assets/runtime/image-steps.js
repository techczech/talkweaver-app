// "Step through images" (0.38 ticket 03, ADR-0034): the decisions, with no DOM and no closure state.
//
// Where the setting applies, Next on a slide runs
//   the slide as laid out → each still image in the zoomed view (the Z lightbox) → the slide as
//   laid out again → the next slide
// and Back runs it in reverse. The whole sequence is expressed in the lightbox state the deck
// already publishes to the projector window and the venue screen, `{ open, index }`:
//   before  { open: false, index: 0 }               the slide as laid out, sequence not yet run
//   zoomed  { open: true,  index: <a stop> }        one image enlarged
//   after   { open: false, index: <last stop> + 1 } the slide as laid out again
// A closed lightbox looks the same on every screen whatever its index, so "before" and "after"
// need no new field and no protocol change. `index` addresses the slide's whole zoomable list
// (still images, videos, QR codes), which is what the lightbox renders from; the STOPS are the
// positions of the still images in that list.
//
// `imageStepsRuntimeSource()` serialises these functions into the deck template (07-assembly,
// `<!--IMAGE_STEPS_RUNTIME-->`); scripts/test-image-steps.mjs asserts the same source.

/**
 * The lightbox positions the sequence visits on one slide, in order. Empty = no sequence here.
 * `entries` is the slide's zoomable list in lightbox order: `{ kind?: 'video', isQr?: boolean,
 * fullBleed?: boolean }`. Videos and QR codes are never stops. A slide whose ONLY still image
 * already fills the slide (`fullBleed`) has no sequence: zooming would show nothing new.
 */
export function imageStepStops(enabled, entries) {
  if (!enabled || !Array.isArray(entries)) return [];
  const stops = [];
  entries.forEach(function (entry, index) {
    if (entry && entry.kind !== 'video' && !entry.isQr) stops.push(index);
  });
  if (stops.length === 1 && entries[stops[0]].fullBleed) return [];
  return stops;
}

/**
 * The closed state at either end of the sequence: 'before' (arriving forwards, or backing out of
 * the first image) or 'after' (the last image left, the zoom dismissed with Esc or Z, or the slide
 * entered backwards). With no stops both are the plain closed lightbox.
 */
export function imageStepRest(stops, where) {
  const after = where === 'after' && Array.isArray(stops) && stops.length > 0;
  return { open: false, index: after ? stops[stops.length - 1] + 1 : 0 };
}

/**
 * Next. Returns the lightbox state to publish, or null when the sequence has nothing to do and the
 * caller's own grammar decides (a reveal step, a carousel card, or the next beat).
 * `stepsRemaining` is the slide's own remaining reveal/focus steps: they run first.
 */
export function imageStepForward(input) {
  const stops = (input && input.stops) || [];
  if (stops.length === 0) return null;
  const lightbox = (input && input.lightbox) || {};
  const index = Math.max(0, Number(lightbox.index) || 0);
  if (lightbox.open) {
    const next = stops.find(function (stop) { return stop > index; });
    return next === undefined ? imageStepRest(stops, 'after') : { open: true, index: next };
  }
  if (index > 0) return null;
  if ((Number(input.stepsRemaining) || 0) > 0) return null;
  return { open: true, index: stops[0] };
}

/**
 * Back: the exact reverse of imageStepForward. Null from 'before', where the caller un-steps the
 * slide's own reveal steps or crosses to the previous beat.
 */
export function imageStepBackward(input) {
  const stops = (input && input.stops) || [];
  if (stops.length === 0) return null;
  const lightbox = (input && input.lightbox) || {};
  const index = Math.max(0, Number(lightbox.index) || 0);
  if (lightbox.open) {
    let previous;
    stops.forEach(function (stop) { if (stop < index) previous = stop; });
    return previous === undefined ? imageStepRest(stops, 'before') : { open: true, index: previous };
  }
  if (index > 0) return { open: true, index: stops[stops.length - 1] };
  return null;
}

export function imageStepsRuntimeSource() {
  return [imageStepStops, imageStepRest, imageStepForward, imageStepBackward].map((fn) => fn.toString()).join('\n');
}
