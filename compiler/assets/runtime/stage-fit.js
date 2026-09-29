// Stage fit: the app's slide views lay a slide out on ONE fixed canvas and scale it (ADR-0030).
// Inlined verbatim (no export) into the presenter template via `<!--STAGE_FIT_RUNTIME-->`, so the
// presentation window, the audience window, the exported deck, the Inspector preview and thumbnails
// all run it. The share page (handout, /p venue) keeps its own fitStage() for the same canvas.
// Tested at this seam by scripts/stage-fit-dom.test.mjs.
//
// Interface: createStageFit({ box, stage, onScale }) → { fit(), scale() }.
//   `stage` is laid out at its own fixed canvas size (CSS .stage: 1280×720) and never re-laid out
//   for the window. fit() scales that layout box uniformly to the largest size that fits `box`,
//   centres it, and paints the rest of the box (the letterbox) in the active slide's background, so a non-16:9 window
//   letterboxes and nothing is cropped. fit() runs on creation, on every resize of the box and on
//   window resize; the caller also calls it after a slide change (the letterbox colour follows the
//   slide). onScale(scale) fires when the applied scale changes, so the caller can re-run anything
//   that measured painted px (the fit pipeline measures in canvas units, but a fit taken while the
//   box was still zero-sized has to be taken again).
//   A box with no size (display:none, e.g. the deck in the presenter window) is left as it is.
function createStageFit(options) {
  const box = options.box;
  const stage = options.stage;
  const onScale = typeof options.onScale === "function" ? options.onScale : null;
  let applied = 0;

  // The active slide's own background, or the stage's; a transparent slide leaves the box to the
  // page background it already shows.
  function letterboxColour() {
    const slide = stage.querySelector(":scope > .slide.active");
    for (const el of [slide, stage]) {
      if (!el) continue;
      const colour = getComputedStyle(el).backgroundColor;
      if (colour && colour !== "transparent" && !/^rgba\([^)]*,\s*0\)$/.test(colour)) return colour;
    }
    return "";
  }

  function fit() {
    const availW = box.clientWidth;
    const availH = box.clientHeight;
    // The canvas size is the stage's own layout box (offset sizes ignore the transform), so a
    // harness that lays the stage out at its window size gets scale 1 rather than a double scale.
    const width = stage.offsetWidth;
    const height = stage.offsetHeight;
    if (!(availW > 0) || !(availH > 0) || !(width > 0) || !(height > 0)) return applied;
    const scale = Math.min(availW / width, availH / height);
    // Whole px offsets keep text on the pixel grid; the scale itself stays exact so the canvas
    // fills the limiting axis edge to edge.
    const left = Math.max(0, Math.round((availW - width * scale) / 2));
    const top = Math.max(0, Math.round((availH - height * scale) / 2));
    stage.style.transform = "translate(" + left + "px," + top + "px) scale(" + scale + ")";
    box.style.backgroundColor = letterboxColour();
    if (scale !== applied) {
      applied = scale;
      if (onScale) onScale(scale);
    }
    return scale;
  }

  if (typeof ResizeObserver === "function") new ResizeObserver(() => fit()).observe(box);
  window.addEventListener("resize", fit);
  fit();

  return { fit, scale: () => applied };
}
