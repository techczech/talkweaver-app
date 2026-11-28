// Presenter panes: the presenter's Current, Next and Then pictures (previewSlide), the shared deck
// stylesheet they use (PREVIEW_STYLES), the swap-when-fitted rule and the input rule (THE PANE RULE).
// Inlined verbatim (no export) into the presenter template via `<!--PRESENTER_PANES_RUNTIME-->`, where
// the template calls createPresenterPanes once, at the place the code used to sit. Tested at this seam
// by scripts/test-presenter-preview-styles.mjs (the stylesheet, from this source) and, in the built deck,
// by scripts/presenter-pane-swap-dom.test.mjs, presenter-pane-rule-dom.test.mjs and
// presenter-pane-input-dom.test.mjs.
//
// Interface: createPresenterPanes(deck) → { previewSlide, paneRequested, paneShown, paneInputPicture,
//   previewStylesHead }. `deck` is what the code reads from the template's closure:
//   - read once: isPresenter, els, slides, EMBED_LOCAL_FRAMES, previewFitSources,
//     previewResizeObserver, fittedPanePictures, and the template's (and its runtimes') functions
//     listed in the destructuring below;
//   - read live, as getters (reassigned by the template, or declared after the call): state,
//     currentHighlight, highlightArmed, lightboxVideo, penGesture, penDraftKey, pointerPending,
//     pointerOverlay, pollProjection, pollFrameFitBoard (undefined when the deck has none).
//   It also registers the window's visibilitychange listener that settles overdue panes.
//   previewStylesHead is returned for its test only; the template does not use it.
export function createPresenterPanes(deck) {
  const {
    isPresenter, els, slides, EMBED_LOCAL_FRAMES, previewFitSources, previewResizeObserver, fittedPanePictures,
    galleryIn, renderInteractiveSim, livePageFrameOf, renderLivePageSlot, renderLivePreviewEmbed, releasePaneEmbeds,
    retainCurrentVideos, connectCurrentVideos, flatStepSlide, imageSequenceBegun, containerSignature,
    stampEmphasisPlainWeight, linkPreviewClone, paintEmphasisStates, paintAudioStates, fragments,
    applyExclusiveCards, slideSteps, clampStepTo, paintMediaStepMarks, mediaStepMarkIcon, applyHighlightPayload,
    decorateContainer, clearContainer, fitPreviewIframe, fitPaneEmbed, applySimScroll, syncSimTyping,
    anchorSimScroll, placeTraceWindows, captureHighlightFromPreview, currentSlide, broadcastPointer,
  } = deck;

  // === PREVIEW_STYLES_START
  // The deck's stylesheet for the preview panes. Every pane picture is its own document, and an inline
  // <style> of the whole deck stylesheet (about 700 KB) was parsed again for every picture, three per
  // slide change. The same text is handed to them as ONE blob: stylesheet, made again only when the
  // text changes, so the renderer parses it once and every picture reuses it. Same rules, same order
  // (the pane's own rules follow it). The text is inlined as before where blob: URLs are not
  // available, and when it has an @import or a url() that is not absolute (a blob: stylesheet would
  // resolve those against itself, not against the deck).
  const PREVIEW_STYLES_RELATIVE = /@import|url\(\s*(['"]?)(?!\s*(?:[a-z][a-z0-9+.-]*:|#|var\())[^'")]*\1\s*\)/i;
  let previewStyles = { text: null, url: null };
  // Set when a picture's blob: stylesheet did not load (a content policy that refuses blob:
  // stylesheets, a revoked address): every picture from then on takes the text inline.
  let previewStylesRefused = false;
  // Whether a picture's document got the shared stylesheet. Chromium gives a failed <link> an
  // empty sheet rather than none, so the rules are counted. No link (the inline path) is fine.
  function previewStylesLoaded(doc) {
    const link = doc?.querySelector("link[data-preview-styles]");
    if (!link) return true;
    try { return !!link.sheet && link.sheet.cssRules.length > 0; } catch { return false; }
  }
  function previewStylesHead(styles) {
    try {
      if (previewStylesRefused) throw new Error("blob stylesheets refused");
      if (typeof URL.createObjectURL !== "function" || typeof Blob !== "function") throw new Error("no blob URLs");
      if (styles !== previewStyles.text) {
        if (PREVIEW_STYLES_RELATIVE.test(styles)) throw new Error("relative addresses");
        const old = previewStyles.url;
        previewStyles = { text: styles, url: URL.createObjectURL(new Blob([styles], { type: "text/css" })) };
        // A picture still loading the old sheet keeps it: revoked only well after.
        if (old) setTimeout(() => URL.revokeObjectURL(old), 60000);
      }
      return `<link rel="stylesheet" data-preview-styles href="${previewStyles.url}">`;
    } catch {
      return `<style>${styles}</style>`;
    }
  }
  // === PREVIEW_STYLES_END

  // === THE PANE RULE ==============================================================================
  // When a pane is asked for a new picture, whatever was in progress on it is cancelled and the pane
  // takes no input until that picture is shown. A pane never applies input from one picture to another.
  //
  // How it is kept:
  //   - paneRequested is the one place a request takes effect (previewSlide calls it whenever what
  //     the pane is asked to show changes: slide, card, reveal step, mode, text size, highlight,
  //     disclosures). It cancels every gesture in progress on the pane without publishing anything
  //     (a pen stroke: capture released, draft dropped, the audience told to drop it; a highlight
  //     selection or a capture still to run; the pointer, which the audience is told is gone; a text
  //     selection; the hand over a disclosure) and makes the whole pane inert: `inert` and
  //     data-pane-pending (pointer-events: none !important, which outranks Highlight mode), so no
  //     pointer, pen, highlight, keyboard or native input reaches any picture, running page, chip or
  //     link in it, and focus leaves it. The pointer and pen overlay sits outside the pane: it asks
  //     paneInputPicture, which answers nothing while the pane is pending, and so stands down.
  //   - paneShown makes the pane live again once the picture asked for is the one on show: at the
  //     swap (commit), at once when there was no picture to keep, or when the pane is emptied.
  //   - Second layer: every picture carries the identity it was drawn for (data-render-key,
  //     data-slide-id) and the pane the identity asked for last (data-picture-key). paneInputPicture
  //     answers only for a picture whose identity is the one asked for (in Current, of the slide the
  //     talk is on), and the pen keys a stroke to the layer it began on. The first layer alone is
  //     sufficient (scripts/presenter-pane-input-dom.test.mjs, mutation notes in PR 413).
  //   - A successor waits hidden (previewSlide) and replaces the picture on show when it is drawn
  //     and fitted, or at the latest PANE_SWAP_DEADLINE_MS after the pane first fell behind
  //     (settlePane). Newer requests do not move that deadline.
  //
  // The limit, accepted: at the deadline the successor is shown as far as it has got and completes
  // in place, which is what 0.45.1 did on every step. If its shared stylesheet has not applied by
  // then it is drawn again with the stylesheet inline, so it is never shown unstyled, and its own fit
  // runs as soon as its document allows and again on load. The wait is never extended.
  const PANE_SWAP_DEADLINE_MS = 250;
  const paneSwaps = new WeakMap();      // pane -> { due, timer, shown }: the pane shows a previous picture
  const pictureCommits = new WeakMap(); // successor picture -> its swap (previewSlide)
  let highlightCaptureTimer = 0;        // a highlight capture still to run (after a mouseup in Current)
  function panePending(target) { return Boolean(target && target.hasAttribute("data-pane-pending")); }
  // A request: cancel what is in progress on the pane, then take all input away from it.
  function paneRequested(target) {
    if (!target) return;
    // A text selection in any picture of the pane (a highlight being made, or just text).
    target.querySelectorAll(":scope > iframe").forEach((frame) => { try { frame.contentWindow?.getSelection()?.removeAllRanges(); } catch {} });
    target.classList.remove("sim-pane-control");
    if (isPresenter && target === els.currentPreview) {
      // At start-up the tools below are not yet defined, and nothing is in progress.
      try {
        clearTimeout(highlightCaptureTimer); highlightCaptureTimer = 0;
        // A pen stroke on the slide's picture (not one on a zoomed image or a frozen page picture):
        // capture released, nothing committed, and the draft already sent replaced by none.
        if (deck.penGesture?.dragging() && (!deck.penDraftKey || deck.penDraftKey.endsWith("\u0000slide"))) deck.penGesture.cancel();
        if (deck.pointerPending !== "gone" && deck.pointerPending.space === "slide") { deck.pointerOverlay?.show("gone"); broadcastPointer("gone"); }
      } catch {}
    }
    target.setAttribute("data-pane-pending", "");
    target.inert = true;
    if (target.contains(document.activeElement)) {
      try { document.activeElement.blur(); } catch {}
      try { window.focus(); } catch {}
    }
    try { deck.pointerOverlay?.refresh(); } catch {}
  }
  // The picture asked for is on show (or the pane holds no picture to keep): input reaches it again.
  function paneShown(target) {
    if (!target) return;
    paneCaughtUp(target);
    if (!panePending(target)) return;
    target.removeAttribute("data-pane-pending");
    target.inert = false;
    try { deck.pointerOverlay?.refresh(); } catch {}
  }
  // The first frame on show in a pane, as the pointer and the highlighter have always read it, or
  // null while the pane waits for its new picture (first layer) or that frame is a picture of
  // anything but where the pane has been asked to be (second layer).
  function paneInputPicture(target) {
    if (!target) return null;
    settlePane(target);
    if (panePending(target)) return null;
    const frame = target.querySelector(":scope > iframe:not(.preview-incoming)");
    if (!frame || !frame.dataset.renderKey) return frame; // a running page, not a picture
    if (frame.dataset.renderKey !== target.dataset.pictureKey) return null;
    if (target === els.currentPreview && frame.dataset.slideId !== (currentSlide()?.dataset.id || "")) return null;
    return frame;
  }
  // The pane has fallen behind: the clock starts when the picture on show stops being the one asked
  // for, and keeps running however many newer requests follow.
  function paneBehind(target) {
    const shown = target.querySelector(":scope > iframe.preview-outgoing");
    if (paneSwaps.get(target)?.shown !== shown) paneCaughtUp(target);
    if (!paneSwaps.has(target)) {
      const entry = { due: Date.now() + PANE_SWAP_DEADLINE_MS, timer: 0, shown };
      entry.timer = setTimeout(() => settlePane(target), PANE_SWAP_DEADLINE_MS);
      paneSwaps.set(target, entry);
    }
  }
  function paneCaughtUp(target) {
    const entry = paneSwaps.get(target);
    if (entry) { clearTimeout(entry.timer); paneSwaps.delete(target); }
  }
  // At the deadline (or later, if the window's timers were held back) the pane stops showing the
  // previous picture: its waiting successor is shown as far as it has got.
  function settlePane(target, now = Date.now()) {
    const entry = paneSwaps.get(target);
    if (!entry || now < entry.due) return;
    const incoming = target.querySelector(":scope > iframe.preview-incoming");
    const commit = incoming && pictureCommits.get(incoming);
    if (commit) { commit(true); return; }
    target.querySelectorAll(":scope > iframe.preview-outgoing").forEach((node) => node.remove());
    paneShown(target);
  }
  // A hidden window's timers may run late: on coming back the overdue panes settle at once.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || !isPresenter) return;
    for (const target of [els.currentPreview, els.nextPreview, els.followingPreview]) if (target) settlePane(target);
  });

  function previewSlide(target, slide, revealValue = 999, modeState = null, beat = null, beatIndex = -1, staticCurrent = false) {
    // B1/B2: the presenter's CURRENT slide, when it carries an embed, renders it LIVE in the
    // current pane instead of the static thumbnail clone (which strips embed src → blank). A local
    // page is loaded in its sandbox, interactive, and mirrored to the audience through the embed
    // channel (ticket 11); a remote URL embed is shown
    // live when the site permits framing; the audience loads its own copy.
    if (!staticCurrent && isPresenter && target === els.currentPreview && slide && !slide.dataset.poll && !deck.pollProjection.quick().visible) {
      // Scope the embed lookup to the ACTIVE exclusive-gallery card. A whole-slide querySelector
      // grabs the FIRST embed in ANY card — even a hidden one — so a carousel whose later card is
      // an embed wrongly rendered that embed LIVE as "current" while an earlier card (e.g. an
      // image) was actually on screen. The active card index is the clamped reveal, exactly as
      // applyExclusiveCards computes it. Non-gallery slides keep searching the whole slide (there
      // the slide IS the embed). embedIndex is the sim's position among ALL the slide's embed
      // frames so audience mirroring still targets the right frame.
      const gallery = galleryIn(slide);
      let embedRoot = slide;
      if (gallery) {
        const cards = Array.from(gallery.querySelectorAll(":scope > .card"));
        embedRoot = cards[Math.max(0, Math.min(cards.length - 1, revealValue))] || slide;
      }
      const allEmbedFrames = Array.from(slide.querySelectorAll("figure.slide-embed iframe"));
      const sim = embedRoot.querySelector(EMBED_LOCAL_FRAMES);
      if (sim) {
        renderInteractiveSim(target, slide, sim, Math.max(0, allEmbedFrames.indexOf(sim)), revealValue, modeState, beat, beatIndex);
        return;
      }
      const remote = embedRoot.querySelector("figure.slide-embed > iframe[data-embed-url]");
      // 2026-07-08: only take over the whole pane when the embed IS the slide's visual (media
      // layout / embed-only slide). On a COMPOSED slide (copy-visual, columns, …) the full-pane
      // live embed hid the rest of the slide — keep the static clone there so the presenter sees
      // the layout the audience sees (the embed area shows as a placeholder; the audience deck
      // plays the real embed independently).
      const embedOwnsSlide = !!slide.querySelector(".slide-content.layout-media, .slide-content.layout-embed");
      if (remote && embedOwnsSlide && livePageFrameOf(slide) === remote) {
        renderLivePageSlot(target, remote);
        return;
      }
      if (remote && embedOwnsSlide && !remote.parentElement?.classList.contains("has-saved-views")) {
        renderLivePreviewEmbed(target, remote);
        return;
      }
    }
    if (!slide) {
      if (target.dataset.previewKey === "end") return;
      paneRequested(target);
      releasePaneEmbeds(target);
      target.dataset.previewKey = "end";
      target.replaceChildren();
      paneShown(target);
      target.classList.add("preview-end");
      target.textContent = "End";
      return;
    }
    target.classList.remove("preview-end");
    // staticCurrent (ticket 13): the picture of the slide UNDER the Current pane's running page.
    // The pane keeps its page, cover and state; only the picture is drawn, and replaced in place.
    if (!staticCurrent) target.classList.remove("preview-live-sim", "preview-live-page", "embed-stopped");
    // The mode state changes the preview's appearance, so it is part of the cache key.
    // A slide whose emphasis steps has steps with no mode on, so its key carries the step too.
    // A file stops once the slide's image sequence begins, which the step does not show: that too.
    const modeKey = modeState && (modeState.kind || flatStepSlide(slide))
      ? `${modeState.kind || "e"}${modeState.step}${slide.hasAttribute("data-media-steps") && imageSequenceBegun(slide) ? "i" : ""}`
      : "m-";
    // F1: highlights on this slide also change the preview, so the highlight signature is part of
    // the key — otherwise a new/cleared highlight on the same slide/step would be cache-skipped.
    const hlKey = (deck.currentHighlight.slideId === slide.dataset.id && deck.currentHighlight.ranges.length)
      ? "h" + deck.currentHighlight.ranges.map((r) => `${r.block}.${r.start}.${r.end}`).join("_")
      : "h-";
    // Container-mode beats can share a slide id (a grid section's grid + grid-return beats all
    // resolve to the SAME section slide) yet must paint different Card Table states, so the beat's
    // container signature is part of the cache key — otherwise the second grid state is skipped.
    const ctKey = containerSignature(beat);
    // Simulation disclosures (state.sim) change the slide they belong to: the clone carries the
    // live open/closed classes, so the open set is part of the key or a mirrored click is skipped.
    const simKey = deck.state.sim && deck.state.sim.slideId === slide.dataset.id ? `s${deck.state.sim.open.join(".")}` : "s-";
    const previewKey = `${slide.dataset.id || ""}:${revealValue}:${deck.state.fontSize}:${modeKey}:${hlKey}:${ctKey}:${simKey}:${deck.pollProjection.previewKey(slide, target === els.currentPreview)}`;
    if (staticCurrent) {
      if (target.dataset.paneSlideKey === previewKey) return;
      target.dataset.paneSlideKey = previewKey;
      paneRequested(target);
      // The picture under the running page stays on show until its successor is ready (below).
      target.querySelectorAll(":scope > iframe.preview-incoming:not(.live-sim-frame)").forEach((node) => node.remove());
      target.querySelectorAll(":scope > iframe:not(.live-sim-frame)").forEach((node) => node.classList.add("preview-outgoing"));
    } else {
      if (target.dataset.previewKey === previewKey) return;
      paneRequested(target);
      // Every new picture in a pane (a step, a slide change, in Current, Next and Then) waits, hidden,
      // behind the picture on show until it is drawn, styled and fitted; only then are the two
      // swapped (onPictureLoad, below). Emptying the pane first showed it blank for a frame or more
      // on every step, which reads as the whole view redrawing when stepping quickly (owner report
      // 16 Nov 2026; first seen as the "terminal reveal flickers" of 0.38.1-preview.2, when only
      // simulation slides swapped). A newer request drops a successor that is not ready yet, never
      // the picture on show. A pane that holds anything but pictures (a running page, "End") is
      // emptied as before.
      // The ink badge (renderInkBadge) is decoration, redrawn after every picture: it does not stop a swap.
      const nodes = Array.from(target.childNodes);
      const frames = nodes.filter((node) => node.nodeName === "IFRAME");
      const swap = frames.length > 0
        && nodes.every((node) => (node.nodeName === "IFRAME" && !node.classList.contains("live-sim-frame"))
          || (node.nodeType === 1 && node.classList.contains("tw-ink-mark")))
        && frames.some((node) => !node.classList.contains("preview-incoming"));
      if (swap) {
        // The picture on show keeps its videos until its successor takes its place (the swap below).
        releasePaneEmbeds(target);
        target.querySelectorAll(":scope > iframe.preview-incoming").forEach((node) => node.remove());
        target.querySelectorAll(":scope > iframe").forEach((node) => node.classList.add("preview-outgoing"));
      } else {
        if (isPresenter && target === els.currentPreview) retainCurrentVideos(target, slide);
        releasePaneEmbeds(target);
        target.replaceChildren();
        paneCaughtUp(target);
      }
      target.dataset.previewKey = previewKey;
      delete target.dataset.paneSlideKey;
    }
    // Where the pane has been asked to be (the pane rule, above).
    target.dataset.pictureKey = previewKey;
    // The plain-weight hand-over for stepped bold is read from the deck's own slide (a clone has
    // no computed style) and travels to the clone as an inline custom property.
    if (flatStepSlide(slide)) stampEmphasisPlainWeight(slide, getComputedStyle);
    const clone = slide.cloneNode(true);
    if (!clone) return;
    // Its steps are counted as the projector counts them (isVisibleUnit): linked before anything
    // is taken out of the clone.
    if (modeState && (modeState.kind || flatStepSlide(slide))) linkPreviewClone(slide, clone);
    clone.querySelectorAll(".lightbox-video-placeholder").forEach(p => { if (deck.lightboxVideo?.el) p.replaceWith(deck.lightboxVideo.el.cloneNode(true)); });
    clone.querySelectorAll(".tw-video-seek").forEach(bar => bar.remove());
    clone.querySelectorAll("video").forEach(v => {
      delete v.dataset.twPlaybackWatched;
      v.removeAttribute("autoplay"); v.setAttribute("muted", ""); v.muted = true; v.defaultMuted = true; v.tabIndex = -1;
      if (target !== els.currentPreview) { v.removeAttribute("src"); v.removeAttribute("data-lazy-src"); v.querySelectorAll("source").forEach(n => n.remove()); }
    });
    // A preview shows a {play-on-next} file in its static form: nothing the live display wrote on
    // it (its step state, a "Tap for sound" control) is carried over.
    clone.querySelectorAll(".media-step-tap").forEach((node) => node.remove());
    clone.querySelectorAll("[data-media-step]").forEach((node) => {
      node.removeAttribute("data-media-step");
      node.removeAttribute("data-media-step-started");
      node.removeAttribute("data-media-step-muted");
    });
    // A preview shows all emphasis unless this pane mirrors the step (below).
    paintEmphasisStates(clone, [], []);
    clone.classList.remove("emph-anim");
    deck.pollProjection.decoratePreview(clone, target === els.currentPreview);
    clone.classList.add("active");
    // A picture of the slide is the slide as laid out: never the full-screen page (ticket 13).
    clone.classList.remove("embed-full-screen");
    clone.querySelectorAll(".embed-stage-expanded").forEach((node) => node.classList.remove("embed-stage-expanded"));
    clone.style.zoom = deck.state.fontSize / 100;
    // Disable any runtime autofit zoom carried over by the clone — the whole stage is scaled
    // to fit the box instead, so internal autofit must not fight the outer scale (D8).
    clone.querySelectorAll(".slide-content").forEach((node) => { node.style.zoom = ""; });
    clone.querySelectorAll("aside.notes").forEach((node) => node.remove());
    // A predrawn map belongs to the source canvas and can be at a different reveal step.
    clone.querySelectorAll(".mindmap-mm").forEach((host) => {
      host.querySelector(":scope > svg")?.remove();
      delete host.dataset.mmDone;
      delete host.dataset.mmAhead;
      delete host.dataset.mmPainted;
    });
    clone.querySelectorAll(".mermaid-mm:not(:has(svg, .mmd-error))").forEach((host) => {
      // The draw in the source deck might have started but has not yet produced its SVG.
      delete host.dataset.mmdDone;
    });
    // Audio chips: the preview never carries the <audio> (it must stay silent); on the live slide's
    // preview the chip shows the state the projector last reported.
    clone.querySelectorAll("audio").forEach((node) => node.remove());
    if (isPresenter && target === els.currentPreview) paintAudioStates(clone, slides.indexOf(slide));
    // Strip interactive gallery chrome (nav dots, mini-grid button, grid-view state) the
    // live slide may carry — a preview is a static thumbnail, not a control surface.
    clone.querySelectorAll(".gallery-nav").forEach((node) => node.remove());
    clone.querySelectorAll(".card-gallery.grid-view").forEach((node) => {
      node.classList.remove("grid-view");
      node.querySelectorAll(".card.grid-current").forEach((card) => card.classList.remove("grid-current"));
    });
    fragments(clone).forEach((node, index) => {
      node.classList.toggle("hidden-fragment", index >= revealValue);
    });
    // 999 is the normal-slide "fully revealed" sentinel. Folded carousel Next/Then panes pass
    // their context index instead, selecting the exact arrival card; modeState remains null so
    // that card's mode units are fully shown.
    applyExclusiveCards(clone, revealValue >= 999 ? 0 : revealValue);
    // Mirror the stepping mode in the presenter Current preview. Reveal/exclusive cards are
    // already applied to the clone, so its units match the live slide; bake the mode classes
    // + per-unit data-mode-state onto the clone so the serialised iframe CSS paints it exactly.
    if (modeState && (modeState.kind || flatStepSlide(clone))) {
      const plan = slideSteps(clone, modeState.kind || null);
      const previewStep = clampStepTo(modeState.step, plan.max);
      const states = plan.states(previewStep);
      const units = modeState.kind ? plan.els.filter((_, i) => plan.isBlock(i)) : [];
      if (units.length > 0) clone.classList.add("mode-active", `mode-${modeState.kind}`);
      // The presenter's current-slide preview marks a file that plays on Next, and stays silent.
      if (isPresenter && target === els.currentPreview) paintMediaStepMarks(plan.files, plan.media(Number(modeState.step) || 0, imageSequenceBegun(slide)), mediaStepMarkIcon);
      plan.els.forEach((el, i) => {
        if (!plan.isBlock(i)) return;
        if (!modeState.kind) return;
        el.classList.add("mode-el");
        el.setAttribute("data-mode-state", states[i]);
      });
      // The emphasis steps the projector shows at this step.
      if (plan.flat) paintEmphasisStates(clone, plan.els, states);
    }
    // F1: bake the slide's highlight marks into the clone so the presenter Current preview shows
    // exactly what the audience sees. Only when this clone is the slide the highlight addresses.
    if (deck.currentHighlight.slideId && deck.currentHighlight.slideId === slide.dataset.id) {
      applyHighlightPayload(clone, deck.currentHighlight);
    }
    clone.querySelectorAll("iframe[data-src]").forEach((frame) => {
      frame.removeAttribute("data-src");
      frame.removeAttribute("src");
    });
    // A preview never contains an embedded page: the clone keeps the placeholder and an empty frame.
    clone.querySelectorAll("iframe[data-embed-doc], iframe[srcdoc]").forEach((frame) => {
      frame.removeAttribute("data-embed-doc");
      frame.removeAttribute("srcdoc");
      frame.classList.remove("embed-live");
    });
    clone.querySelectorAll("figure.slide-embed[data-embed-state]").forEach((figure) => figure.setAttribute("data-embed-state", "idle"));
    // Container-mode renderings (ADR-0007): paint the Card Table / rail / strip onto the CLONE for
    // this beat, so the presenter's Current/Next/Then panes preview a grid beat AS the exact state
    // it will show. decorateContainer is the same pure(slideEl, beat)→DOM used on the live slide.
    if (beat) decorateContainer(clone, beat, beatIndex); else clearContainer(clone);
    const styles = Array.from(document.querySelectorAll("style")).map((style) => style.textContent).join("\n");
    const stylesHead = previewStylesHead(styles);
    const iframe = document.createElement("iframe");
    iframe.title = "Slide preview";
    iframe.setAttribute("aria-hidden", "true");
    iframe.tabIndex = -1;
    // What this picture shows (the pane rule): input reaches it only while the pane asks for this.
    iframe.dataset.renderKey = previewKey;
    iframe.dataset.slideId = slide.dataset.id || "";
    // In-iframe fit: the preview runs the SAME fit pipeline the projector runs (card densify, then
    // runtime/slide-fit.js: quote, code and title fit, the list ladder, the whole-slide zoom) on
    // the same 1280×720 canvas, so a slide lands in the preview exactly as it lands on the
    // projector and nothing re-wraps between the two (ADR-0030). The outer transform then scales
    // this whole canvas into the box. Runs two frames after load so embeds/fonts settle.
    const previewAutofit = `(function(){
      var densifyActiveCards = ${previewFitSources.densify};
      var slideFit = (${previewFitSources.slideFit})();
      var fitBoard = ${typeof deck.pollFrameFitBoard === "function" ? deck.pollFrameFitBoard.toString() : "function(){}"};
      function fit(){
        // A live board: the same card-size fit the projector runs (poll-frame.mjs pollFrameFitBoard).
        document.querySelectorAll('.poll-frame[data-poll-type="board"]:not([hidden])').forEach(fitBoard);
        document.querySelectorAll('.slide.active > .slide-content').forEach(function(content){
          densifyActiveCards(content);
          slideFit.fitContent(content);
        });
      }
      function schedule(){requestAnimationFrame(function(){requestAnimationFrame(fit);});}
      document.addEventListener('load', function(e){if(e.target.tagName === 'IMG') schedule();}, true);
      document.addEventListener('error', function(e){if(e.target.tagName === 'IMG') schedule();}, true);
      if(document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
      slideFit.watchFonts(schedule);
      // Once more on load; and the presenter runs it at once when it shows a picture at its deadline.
      window.addEventListener('load', schedule);
      window.__twPreviewFit = fit;
      schedule();
    })();`;
    // The clone's container is the 1280×720 .stage (deck CSS: container-type: size), exactly as on
    // the projector, so every cqw/cqh inside the preview resolves against the same canvas. The slide
    // is full-height (margin:auto/grid pin a title poster's QR + byline to the bottom) but is NOT a
    // size container: that would resolve the slide's type against its padded box, 89% of the canvas.
    const pictureDoc = (head) => `<!doctype html><html lang="en-GB"><head><meta charset="utf-8">${head}<style>
      html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: var(--paper); }
      body { min-height: 100%; }
      .deck { min-height: 100%; display: block; }
      .stage { position: relative; width: 100vw; height: 100vh; overflow: hidden; }
      .slide { display: grid !important; position: absolute; inset: 0; width: 100%; height: 100%; min-height: 100%; }
      .footer, .drawer, .notes-drawer, .progress, .presenter-root { display: none !important; }
    </style></head><body><main class="deck"><div class="stage">${clone.outerHTML}</div><script>${previewAutofit}<\/script></main></body></html>`;
    iframe.srcdoc = pictureDoc(stylesHead);
    const inCurrent = isPresenter && target === els.currentPreview;
    let pictureLoaded = false;
    // Once this picture is both on show and loaded: the Current pane's videos come into it and its
    // conversation is placed (a waiting successor is not touched; the picture on show still is).
    const settleShownPicture = () => {
      if (!inCurrent) return;
      if (staticCurrent) {
        iframe.contentWindow?.__twPreviewFit?.();
        fittedPanePictures.add(iframe);
        fitPaneEmbed(target);
      }
      connectCurrentVideos(iframe, slide);
      applySimScroll();
      syncSimTyping();
    };
    // The swap: this picture replaces the one on show. Run when it is drawn and fitted (onPictureLoad)
    // or at the pane's deadline (settlePane), whichever is first; a successor dropped by a newer
    // request is never swapped in.
    const commit = (atDeadline = false) => {
      if (!iframe.isConnected || !iframe.classList.contains("preview-incoming")) return;
      pictureCommits.delete(iframe);
      const outgoing = Array.from(target.querySelectorAll(":scope > iframe.preview-outgoing"));
      // The videos playing in the picture on show move to this one now, never before.
      if (inCurrent && !staticCurrent && outgoing[0]) retainCurrentVideos(target, slide, outgoing[0]);
      outgoing.forEach((node) => node.remove());
      iframe.classList.remove("preview-incoming");
      fitPreviewIframe(target);
      if (pictureLoaded) settleShownPicture();
      // Shown at the deadline as far as it has got (the accepted limit, above previewSlide): never
      // unstyled, and fitted now if its document has got that far (and again on its load).
      if (atDeadline && !pictureLoaded) {
        if (!sharedStylesApplied()) drawWithInlineStyles();
        else { try { iframe.contentWindow?.__twPreviewFit?.(); } catch {} }
      }
      paneShown(target);
    };
    // Whether this picture has its stylesheet: inline, or the shared one loaded and applied.
    const sharedStylesApplied = () => {
      if (iframe.dataset.previewStylesInline || !stylesHead.startsWith("<link")) return true;
      try {
        const link = iframe.contentDocument?.querySelector("link[data-preview-styles]");
        return !!link?.sheet && link.sheet.cssRules.length > 0;
      } catch { return true; }
    };
    // Drawn again with the stylesheet inline (the fallback for a stylesheet that failed or is late).
    let awaitingLoad = false;
    const drawWithInlineStyles = () => {
      iframe.dataset.previewStylesInline = "1";
      if (!awaitingLoad) { awaitingLoad = true; iframe.addEventListener("load", onPictureLoad, { once: true }); }
      iframe.srcdoc = pictureDoc(`<style>${styles}</style>`);
    };
    const onPictureLoad = async () => {
      awaitingLoad = false;
      // The shared stylesheet did not load: this picture is drawn again with the text inline
      // (as before 0.45.1), before it is fitted or shown, and so is every later one.
      let loaded = true;
      try { loaded = styles.trim() === "" || previewStylesLoaded(iframe.contentDocument); } catch { loaded = true; }
      if (!loaded && !iframe.dataset.previewStylesInline) {
        previewStylesRefused = true;
        drawWithInlineStyles();
        return;
      }
      const picture = iframe.contentDocument;
      if (picture?.querySelector(".mindmap-mm, .mermaid-mm:not([data-mmd-done])")) {
        await picture.fonts?.ready;
        if (!iframe.isConnected || iframe.contentDocument !== picture) return;
        initMarkmaps(picture, true);
        await Promise.all([
          initMermaids(picture, true),
          ...[...picture.querySelectorAll(".mindmap-mm")].map((host) => host.__mmDrawn)
        ]);
        if (!iframe.isConnected || iframe.contentDocument !== picture) return;
      }
      pictureLoaded = true;
      // A successor is shown only once its own fit has run (two frames after its script, then again
      // when fonts and images arrive): it is swapped in two frames after load, or after 150 ms if
      // a hidden picture gets no frames, or at the pane's deadline if that comes first.
      const waiting = iframe.classList.contains("preview-incoming");
      if (waiting) {
        try {
          const view = iframe.contentWindow;
          view.requestAnimationFrame(() => view.requestAnimationFrame(() => commit()));
        } catch { commit(); }
        setTimeout(() => commit(), 150);
      }
      fitPreviewIframe(target);
      deck.pointerOverlay?.refresh();
      // The page's place moves when the picture's own fit runs (two frames after load) and
      // whenever its content is laid out again: follow it.
      if (staticCurrent) {
        try {
          const figure = iframe.contentDocument?.querySelector("figure.slide-embed");
          if (figure && iframe.contentWindow?.ResizeObserver) new iframe.contentWindow.ResizeObserver(() => fitPaneEmbed(target)).observe(figure);
          iframe.contentWindow?.requestAnimationFrame(() => iframe.contentWindow.requestAnimationFrame(() => iframe.contentWindow.requestAnimationFrame(() => fitPaneEmbed(target))));
        } catch { /* the picture is being replaced: its successor fits */ }
      }
      // A stepped simulation in the preview sits where the audience's does (anchorSimScroll):
      // the clone carries the baked data-mode-state, so the revealed count is read from it.
      try {
        const previewSlide = iframe.contentDocument?.querySelector(".slide.mode-active");
        if (previewSlide && previewSlide.querySelector(".sim .sim-scroll")) {
          const units = Array.from(previewSlide.querySelectorAll(".sim .sim-step"));
          const shown = units.filter((el) => !["hidden", "fuzzy"].includes(el.getAttribute("data-mode-state"))).length;
          anchorSimScroll(previewSlide, units, shown);
        }
        // A trace in the preview shows the window the audience sees (placeTraceWindows reads the
        // baked data-mode-state on its turns).
        const traceHost = iframe.contentDocument?.querySelector(".slide");
        if (traceHost && traceHost.querySelector(".trace")) placeTraceWindows(traceHost, { animate: false });
      } catch {}
      // The Current pane's videos, the published scroll, and any text still typing: now if this
      // picture is on show, else when it is swapped in.
      if (!waiting) settleShownPicture();
      // F1: on the Current preview, let the presenter select text inside the iframe to highlight.
      // Events don't cross the iframe boundary, so attach the capture to the iframe's document.
      if (inCurrent) {
        try {
          iframe.contentDocument?.addEventListener("mouseup", () => {
            if (deck.highlightArmed) { clearTimeout(highlightCaptureTimer); highlightCaptureTimer = setTimeout(captureHighlightFromPreview, 0); }
          });
        } catch {}
      }
    };
    awaitingLoad = true;
    iframe.addEventListener("load", onPictureLoad, { once: true });
    // The picture on show is the pane's first frame that is not a successor (the pointer and the
    // highlighter read it as such). A successor waits, hidden, behind the one on show until ready;
    // until then the pane takes no input (paneRequested). With nothing to keep, this picture is on
    // show at once and the pane is live again.
    if (target.querySelector(":scope > iframe.preview-outgoing")) {
      iframe.classList.add("preview-incoming");
      pictureCommits.set(iframe, commit);
      paneBehind(target);
    } else paneShown(target);
    if (staticCurrent) target.prepend(iframe); else target.appendChild(iframe);
    fitPreviewIframe(target);
    if (previewResizeObserver && target.dataset.previewObserved !== "1") {
      target.dataset.previewObserved = "1";
      previewResizeObserver.observe(target);
    }
  }

  return { previewSlide, paneRequested, paneShown, paneInputPicture, previewStylesHead };
}

export function presenterPanesRuntimeSource() {
  return createPresenterPanes.toString();
}
