// Slide fitting: the ONE fit pipeline every slide view runs (ADR-0005 floor, ADR-0023, ADR-0028 §5).
// Inlined verbatim (no export) into the presenter template (the SLIDE_FIT_RUNTIME placeholder, so the app's
// presentation, presenter, audience and export all run it) AND into the share page
// (buildShareHtml: the handout and the /p venue screen). SINGLE SOURCE OF TRUTH — see
// 01-cli-utils.slideFitRuntimeSource; scripts/slide-fit-dom.test.mjs tests it at this seam.
//
// Interface: createSlideFit({ refit? }) → { fitContent(content, { refresh }?), canvasScale(el),
//   preparePrint(root), restorePrint(), managePrint(prepare, restoreSteps), endPrint(), leavePrint(), print() }.
// A hidden/zero-sized slide returns null: no fit decision. preparePrint runs in beforeprint and puts
// each slide into its print layout itself (see "Print" below); restorePrint returns the screen state.
// options.refit(content) is how the fitter asks its caller for a fit when an asset wait ends.
// fitContent's refresh(content) is the caller's own preparation of a slide before a fit (the deck densifies its
// stepped cards), done again when a carousel card is drawn as 0.44 drew it (see fitContent).
//   fitContent(.slide-content) runs, in order: quote soft-fit, code fit, title fit, the list ladder
//   (width step, leading, gaps, type), the statement type step and shrink-wrap (ADR-0028 §10) and
//   last the whole-slide zoom. The caller runs it on the
//   active slide after every slide change, reveal step, resize and late layout (images, fonts).
//
// Canvas units. A slide may be laid out on a fixed canvas that a CSS transform scales to its box
// (the share page's 1280×720 stage, the phone list rows, full screen; ADR-0018 / ADR-0030). Under a
// transform getBoundingClientRect() returns PAINTED px, while clientHeight, scrollHeight and
// computed lengths stay in CANVAS px. Every rect this module compares with a layout length is
// divided by canvasScale() first, so the fit is the same at any scale. Untransformed, the scale is
// exactly 1 and every expression reduces to the unscaled one.
function createSlideFit(options = {}) {
  // The slide's canvas: its parent (.stage, a phone row, the full-screen host, or on paper the
  // slide's own 1280x720 page canvas, .tw-print-canvas).
  function canvasOf(slide) {
    return slide.parentElement || slide;
  }
  // The scale between painted and canvas px for the slide holding `el`: the painted width of the
  // slide's canvas (its parent: .stage, a phone row, the full-screen host) over its layout width.
  function canvasScale(el) {
    const slide = el && el.closest ? el.closest(".slide") : null;
    const canvas = slide ? canvasOf(slide) : null;
    if (!canvas) return 1;
    const layoutWidth = canvas.offsetWidth;
    const paintedWidth = canvas.getBoundingClientRect().width;
    // offsetWidth is rounded to a whole px; within that rounding the canvas is not scaled.
    if (!(layoutWidth > 0) || !(paintedWidth > 0) || Math.abs(paintedWidth - layoutWidth) <= 0.5) return 1;
    return paintedWidth / layoutWidth;
  }

  // Title-fit: a slide title must never overrun its column. Most titles wrap on whitespace,
  // but a long single WORD at the large clamp() size can be wider than its (narrow, two-column)
  // grid cell — e.g. "Understanding" in a layout-list left column. CSS alone cannot fix this
  // without breaking the word mid-word (forbidden). So we measure each title and, if it still
  // overflows after wrapping, shrink its font-size a notch at a time until it fits — never below
  // a sensible floor (TITLE_FIT_FLOOR of the authored size). The shrink is an inline px
  // font-size, which wins over every stylesheet rule and is cleared/recomputed each pass so it
  // re-runs correctly on resize, slide change and presenter-preview clone. Wrapping is always
  // preferred first (the CSS keeps overflow-wrap/word-break normal); this only engages when a
  // single token cannot fit. Runs before autofitContent so the slide-level fit measures the
  // already-fitted title.
  const TITLE_FIT_FLOOR = 0.6; // never shrink a title below 60% of its authored size
  const TITLE_MAX_LINES = 5; // ADR-0033 §6: a title may wrap to five lines at normal size
  const TITLE_SHORT_WORDS = new Set(["a", "an", "the", "at", "of", "in", "on", "to", "and", "or", "for", "by", "with", "is"]);
  const NBSP = "\u00a0";
  // Every no-break space the compiler wrote in a title (ADR-0028 §10 last-two-words join, ADR-0033 §7
  // short-word ties), in reading order. A tie is a no-break space right after a short word; the
  // last-two-words join is any other one. (When the last pair starts with a short word the two
  // coincide, and releasing it is the same either way.)
  const titleSites = new WeakMap();
  function findTitleSites(h1) {
    const sites = [];
    const walker = document.createTreeWalker(h1, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode());) {
      for (let i = 0; i < node.data.length; i++) {
        if (node.data[i] !== NBSP) continue;
        let start = i;
        while (start > 0 && !/[\s\u00a0]/.test(node.data[start - 1])) start--;
        const word = node.data.slice(start, i).replace(/^["'\u2018\u201c(\[]+/, "").toLowerCase();
        sites.push({ node, index: i, tie: TITLE_SHORT_WORDS.has(word) });
      }
    }
    return sites;
  }
  function setSite(site, joined) {
    const c = joined ? NBSP : " ";
    if (site.node.data[site.index] !== c) site.node.data = site.node.data.slice(0, site.index) + c + site.node.data.slice(site.index + 1);
  }
  function sitesOf(h1) {
    let sites = titleSites.get(h1);
    if (!sites || sites.some((site) => !h1.contains(site.node))) {
      sites = findTitleSites(h1);
      titleSites.set(h1, sites);
    }
    return sites;
  }
  // A Range's line boxes. Every browser has getClientRects; a DOM without layout (jsdom, where the
  // handout page is tested) does not, and there nothing is measured: no line boxes, so no fit change.
  function rangeRects(range) {
    return typeof range.getClientRects === "function" ? range.getClientRects() : [];
  }
  function titleLineCount(h1) {
    const range = document.createRange();
    // A title with an icon (plain view ticket 07) counts the lines of its words only: the icon's
    // own box sits a few px off the first line's top and would read as one line more.
    range.selectNodeContents(h1.querySelector(".title-with-icon > .title-text") || h1);
    const scale = canvasScale(h1);
    const tops = new Set([...rangeRects(range)].filter((r) => r.width > 0.5 && r.height > 0.5).map((r) => Math.round(r.top / scale / 4)));
    return tops.size;
  }
  // ADR-0033 §7 / §6, judged against the real line breaks. The compiler binds each short word to the
  // next and joins the last two words, without knowing the column. Here every bond is kept unless
  // keeping it makes the title wider than its column (an unbreakable run, ADR-0033 §6: the last-two
  // join is dropped first) or leaves a word alone on a line (§7): then the bond whose release helps
  // most gives way, one at a time and only while that lowers the score (a title wider than its column
  // scores far above any count of one-word lines; on equal scores the last-two join goes before a
  // short-word tie, so no short word is left ending a line, then reading order). Released ties are counted in data-short-word-give-way.
  // A rail title keeps the rail's inner padding (stage.css @order 1349): its box may not reach into
  // the head's right padding. An unbreakable run (bound short words) wider than the padded rail
  // stretches the h1's grid item past it, where scrollWidth - clientWidth reads 0 and the last line
  // touched the rail edge. Returns how many canvas px the title box reaches into that padding.
  function railPaddingExcess(h1) {
    const slide = h1.closest(".slide");
    const head = h1.closest(".slide-head");
    if (!slide || !head || slide.dataset.titleLayout !== "left") return 0;
    const scale = canvasScale(h1);
    const limit = head.getBoundingClientRect().right - (parseFloat(getComputedStyle(head).paddingRight) || 0) * scale;
    return (h1.getBoundingClientRect().right - limit) / scale;
  }
  function titleExcess(h1) {
    return Math.max(h1.scrollWidth - h1.clientWidth, railPaddingExcess(h1));
  }
  function titleScore(h1) {
    const excess = titleExcess(h1);
    // A one-word line counts unless the word takes half the column or more: nothing else could share
    // that line, so binding a short word to it has not stranded anything (the rail is ~14 characters).
    return oneWordScore(h1, 0.5 * h1.clientWidth * canvasScale(h1)) + (excess > 1 ? 1000 + excess : 0);
  }
  function settleTitle(h1) {
    if (!h1) return;
    const sites = sitesOf(h1);
    sites.forEach((site) => setSite(site, true));
    delete h1.dataset.nbJoin;
    delete h1.dataset.shortWordGiveWay;
    let score = titleScore(h1);
    const order = [...sites.filter((site) => !site.tie), ...sites.filter((site) => site.tie)];
    const released = new Set();
    while (score > 0) {
      let best = null;
      for (const site of order) {
        if (released.has(site)) continue;
        setSite(site, false);
        const trial = titleScore(h1);
        setSite(site, true);
        if (trial < score && (!best || trial < best.score)) best = { site, score: trial };
      }
      if (!best) break;
      setSite(best.site, false);
      released.add(best.site);
      score = best.score;
    }
    const ties = [...released].filter((site) => site.tie).length;
    if (ties) h1.dataset.shortWordGiveWay = String(ties);
    if ([...released].some((site) => !site.tie)) h1.dataset.nbJoin = "released";
  }
  // Title-fit (ADR-0033 §6): a title keeps its normal size and WRAPS (settleTitle has already let the
  // bonds give way where a title was wider than its column). Only when it still overflows, or
  // needs more than TITLE_MAX_LINES lines, does it shrink, in ~3% steps, never below TITLE_FIT_FLOOR
  // of its authored size. The shrink is an inline px font-size, cleared and recomputed each pass so it
  // re-runs correctly on resize, slide change and presenter-preview clone.
  function fitTitle(h1) {
    if (!h1) return;
    h1.style.fontSize = ""; // reset to the stylesheet (clamp) size, then measure
    h1.style.overflowWrap = "";
    // A title overflows a column when its content is wider than its content box. clientWidth
    // excludes any (zero here) scrollbar; scrollWidth is the laid-out content width.
    const tooWide = () => titleExcess(h1) > 1;
    const over = () => tooWide() || titleLineCount(h1) > TITLE_MAX_LINES;
    if (!over()) return; // wraps/fits at authored size — leave it
    const base = parseFloat(getComputedStyle(h1).fontSize);
    if (!base) return;
    const minSize = base * TITLE_FIT_FLOOR;
    let size = base;
    // Shrink in ~3% steps; cap iterations so a pathological case can't loop forever.
    for (let i = 0; i < 40 && size > minSize; i++) {
      size = Math.max(minSize, size * 0.97);
      h1.style.fontSize = size + "px";
      if (!over()) break;
    }
    // Last resort: one unbreakable word wider than the column at the floor size (a long identifier or
    // compound in the left rail) breaks inside the word instead of running out of the rail or the stage.
    // Not set earlier: it would also hide the excess settleTitle and the shrink step react to.
    if (tooWide()) h1.style.overflowWrap = "anywhere";
  }
  function fitTitles(root = document) {
    root.querySelectorAll(".slide.active .slide-content h1:not(.sr-only)").forEach((h1) => { settleTitle(h1); fitTitle(h1); });
  }

  // ADR-0023 §9: every quote panel has ONE width and ONE type size; the compiler splits a long
  // quote across slides. The runtime keeps a single soft-fit FALLBACK for font metrics that differ
  // from the compiler's estimate: step type down towards the 31px floor, never change the width.
  function fitQuote(panel) {
    if (!panel) return;
    panel.style.fontSize = "";
    panel.dataset.quoteFit = "base";
    const slide = panel.closest(".slide");
    if (!slide) return;
    const host = panel.closest(".image-quote") || panel;
    host.style.removeProperty("--quote-fitted-size");
    const stage = canvasOf(slide);
    const slideStyle = getComputedStyle(slide);
    // Resolve the stage's --slide-pad-y through computed padding: reading the custom property
    // directly would return "5cqh", whose numeric prefix is not a pixel measurement.
    const verticalMargin = parseFloat(slideStyle.paddingTop);
    const chromeBand = parseFloat(slideStyle.getPropertyValue("--quote-chrome-band")) || 59;
    // Quote fitting uses the same box the stylesheet paints: the stage less the fixed footer
    // band and equal --slide-pad-y margins. Reading the tokens keeps runtime and static output
    // on one geometry contract even if the deck-wide safe area changes later.
    const availableHeight = (stage?.clientHeight || slide.clientHeight)
      - chromeBand
      - (2 * verticalMargin);
    const needsMoreRoom = () => host.scrollHeight - availableHeight > 1;
    if (!needsMoreRoom()) return;
    const base = parseFloat(getComputedStyle(panel).fontSize);
    if (!base) return;
    let size = base;
    while (size > 31 && needsMoreRoom()) {
      size = Math.max(31, size - 1);
      host.style.setProperty("--quote-fitted-size", size + "px");
    }
    panel.dataset.quoteFit = needsMoreRoom() ? "too-long" : "fallback";
  }
  function fitQuotes(root = document) {
    // Print fits every printable slide, not only the one on screen.
    const on = fittingPrint ? "" : ".slide.active ";
    root.querySelectorAll(`${on}.layout-quote > blockquote, ${on}.image-quote blockquote`).forEach(fitQuote);
    root.querySelectorAll(`${on}.layout-quote > figure.qf[data-step]`).forEach(fitQuoteForm);
  }

  // Quote forms (ADR-0038, spec 7): the compiler estimates the words' step (1 to 4); on arrival the real
  // box is checked and the step moves down while the card is taller than the form's limit, never below
  // step 4 (44 px at 1920). The compiler already refused a form that cannot fit step 4, so a form that
  // still overflows here is a font-metric difference: it stays at step 4 and its box is scaled down to fit.
  // Each form names the box that must stay under its limit (1920 design px): the tweet card 900, the video
  // player's caption block 400, the left side panel's words column 864 (video, book, paper, web), the web page's browser window 940.
  function quoteFormBox(figure) {
    if (figure.classList.contains("qf-tweet")) return { box: figure.querySelector(".qf-x-card"), max: 900 };
    if (figure.classList.contains("qf-side")) return { box: figure.querySelector(".qf-body-in"), max: 864 };
    if (figure.classList.contains("qf-video")) return { box: figure.querySelector(".qf-yt-captions"), max: 400 };
    if (figure.classList.contains("qf-web")) return { box: figure.querySelector(".qf-web-win"), max: 940 };
    return null;
  }
  function fitQuoteForm(figure) {
    const slide = figure.closest(".slide");
    const found = quoteFormBox(figure);
    if (!slide || !found || !found.box) return;
    // Heights are measured in painted px; the slide is drawn at 1920 design px across its own width.
    const scale = slide.getBoundingClientRect().width / 1920;
    if (!scale) return;
    const limit = found.max * scale;
    const card = found.box;
    // A previous pass may have scaled the box; measure it unscaled.
    card.style.transform = "";
    card.style.transformOrigin = "";
    delete figure.dataset.qfScaled;
    let step = Number(figure.dataset.step) || 2;
    while (card.getBoundingClientRect().height > limit + 1 && step < 4) {
      step += 1;
      figure.dataset.step = String(step);
    }
    // Last resort at step 4 (the estimate missed, e.g. very wide glyphs): scale the whole card down uniformly
    // from its centre, never below 0.6, so nothing is clipped. Slides scale, they do not reflow. No transition is
    // set, so reduced motion has nothing to switch off.
    const height = card.getBoundingClientRect().height;
    if (height > limit + 1) {
      const factor = Math.max(0.6, limit / height);
      card.style.transformOrigin = "50% 50%";
      card.style.transform = `scale(${Number(factor.toFixed(4))})`;
      figure.dataset.qfScaled = "true";
    }
  }

  // Code wraps at every size, so width is never a fitting or warning condition. Type may step down
  // to the shared floor only when the wrapped block exceeds the title-to-chrome content band.
  // A block that is still taller than that band stays at the floor and carries a visible marker.
  function fitCode(panel) {
    if (!panel) return;
    panel.style.fontSize = "";
    panel.dataset.codeFit = "base";
    const content = panel.closest(".slide-content");
    const slide = panel.closest(".slide");
    if (!content || !slide) return;
    content.querySelectorAll(":scope > .code-overflow-marker").forEach((marker) => marker.remove());
    const stage = canvasOf(slide);
    const head = content.querySelector(":scope > .slide-head");
    const stageRect = stage?.getBoundingClientRect() || slide.getBoundingClientRect();
    const headBottom = head?.getBoundingClientRect().bottom || content.getBoundingClientRect().top;
    const chromeBand = 59;
    // Rects are painted px; panel.scrollHeight is canvas px (see canvasScale).
    const scale = canvasScale(slide);
    const availableHeight = Math.max(0, stageRect.bottom / scale - chromeBand - headBottom / scale);
    const needsMoreRoom = () => panel.scrollHeight - availableHeight > 1;
    if (!needsMoreRoom()) return;
    const base = parseFloat(getComputedStyle(panel).fontSize);
    const floor = (stage?.clientWidth || slide.clientWidth) * 31 / 1600;
    if (!base || !floor) return;
    let size = base;
    while (size > floor && needsMoreRoom()) {
      size = Math.max(floor, size - 1);
      panel.style.fontSize = size + "px";
    }
    if (!needsMoreRoom()) {
      panel.dataset.codeFit = "stepped";
      return;
    }
    panel.dataset.codeFit = "too-long";
    const marker = document.createElement("div");
    marker.className = "code-overflow-marker";
    marker.textContent = "Code too long";
    content.appendChild(marker);
  }
  function fitCodes(root = document) {
    root.querySelectorAll(fittingPrint ? ".slide-code" : ".slide.active .slide-code").forEach(fitCode);
  }

  // PowerPoint-style autofit: shrink the active slide's content so nothing is ever
  // clipped by the stage. Applied as an inline `zoom` on .slide-content (Chrome/Safari
  // re-lay-out cleanly under zoom, and getBoundingClientRect reflects the scaled box).
  // ADR-0033 §1: the zoom may never take rendered text below the type floor (1.9375cqw, 37.2px at
  // 1920). When the content still overflows at the floor, zoom stays 1 and the slide is marked
  // data-text-fit="too-long" (with data-text-too-tall = how many percent too tall); the compiler and
  // the editor raise the `text-too-long` warning. AUTOFIT_FLOOR is the outer bound on the factor.
  // Print never autofits (see beforeprint handler).
  const AUTOFIT_FLOOR = 0.45;
  const TYPE_FLOOR_CQW = 1.9375;
  // Deliberate presentation chrome that is allowed below the floor (mirrors the Layout Doctor's
  // smallChromeSelectors in scripts/layout-doctor-render.mjs).
  const SMALL_CHROME = ".sr-only, .kicker, .compare-label, .quote-continuation, .code-lang, .poll-frame-eyebrow, .poll-frame-kind, .poll-frame-sep, .poll-frame-chip, .poll-frame-join-note, .qr-caption, .footer, .gallery-nav, .lightbox-nav, .sim, .qf";
  // The smallest rendered running-text size (canvas px) inside `content`, or 0 when it has no text.
  function smallestTextPx(content) {
    let smallest = 0;
    const seen = new Set();
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode());) {
      if (!node.data.trim()) continue;
      const el = node.parentElement;
      if (!el || seen.has(el)) continue;
      seen.add(el);
      if (el.closest(SMALL_CHROME) || el.closest("[hidden], script, style")) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const px = parseFloat(cs.fontSize);
      if (px > 0 && (!smallest || px < smallest)) smallest = px;
    }
    return smallest;
  }
  // A carousel shows one card in the band between the slide's title and the gallery dots. The band is a flex share
  // of the slide, so a card whose content is taller than its band spills over the dots without the slide itself
  // growing, and neither the zoom nor the look's fall-back saw it. carouselCardExcess is how far (canvas px) the card
  // on show runs past its band: the fit counts it as the slide's own overflow. Only under a top title, the carousel's
  // own regime: a side-title carousel is fitted as in 0.44. Overflow within OCEAN_FIT_TOLERANCE counts as none, so a
  // fraction of a pixel never earns a zoom.
  function activeCarouselCard(content) {
    return content?.querySelector(":scope > .card-gallery.carousel > .card.carousel-subslide.active-card > .slide-content") || null;
  }
  function inTopCarousel(content) {
    return Boolean(content?.classList.contains("layout-carousel") && !("carouselLegacy" in content.dataset)
      && content.closest(".slide")?.dataset.titleLayout === "top");
  }
  function carouselCardExcess(content) {
    return inTopCarousel(content) ? cardExcess(activeCarouselCard(content)) : 0;
  }
  function cardExcess(card) {
    if (!card || !(card.clientHeight > 0)) return 0;
    const box = cardBounds(card);
    if (!box) return 0;
    const excess = (box.bottom - box.top) / canvasScale(card) - card.clientHeight;
    return excess > OCEAN_FIT_TOLERANCE ? excess : 0;
  }
  // The painted extent (viewport px) of what the card draws. Every drawn box counts (a figure's caption can run past
  // the figure's own box), except what a box inside the card clips (a picture in its media column).
  function cardBounds(card) {
    let top = Infinity;
    let bottom = -Infinity;
    const clipped = (el) => {
      for (let up = el.parentElement; up && up !== card; up = up.parentElement) {
        if (/hidden|clip/.test(getComputedStyle(up).overflowY)) return true;
      }
      return false;
    };
    for (const el of card.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      // A reveal step not yet shown still takes its place, so it counts.
      if (cs.display === "none" || cs.position === "fixed") continue;
      const r = el.getBoundingClientRect();
      if (!(r.height > 0 && r.width > 0) || clipped(el)) continue;
      top = Math.min(top, r.top);
      bottom = Math.max(bottom, r.bottom);
    }
    return bottom > top ? { top, bottom } : null;
  }
  // The card on show: a list in it spends the list ladder (leading, gaps, then type to the floor) in the card's band.
  // Where the dots go is one decision for the whole carousel, taken afresh at every fit (a fit before the slide's
  // fonts arrive must not settle it): if any card still needs the dots' band, the dots move into the slide's foot
  // padding for every card (data-carousel-dots="foot") and the list on show is fitted again in the larger band. To
  // measure a card not on show, it is shown for the measurement and the card on show restored, in one task (nothing
  // is painted in between). What still does not fit falls back or is zoomed as on any other slide.
  function fitCarouselCard(content) {
    const active = activeCarouselCard(content);
    if (!active) return;
    delete content.dataset.carouselDots;
    delete content.dataset.carouselDotsOver;
    content.style.removeProperty("--carousel-chrome-clear");
    if (!inTopCarousel(content)) return;
    // Measure unzoomed: a whole-slide zoom left by the previous pass would make a card that needs its dots' band
    // look as if it fits (autofitContent clears and recomputes the zoom after this).
    content.style.zoom = "";
    fitLists(active, active.clientHeight);
    const shown = active.parentElement;
    const needsBand = (card) => {
      const inner = card.querySelector(":scope > .slide-content");
      if (!inner) return false;
      fitLists(inner, inner.clientHeight);
      return cardExcess(inner) > 0;
    };
    let needs = needsBand(shown);
    for (const card of shown.parentElement.querySelectorAll(":scope > .card.carousel-subslide")) {
      if (needs) break;
      if (card === shown) continue;
      shown.classList.remove("active-card");
      card.classList.add("active-card");
      try { needs = needsBand(card); } finally { card.classList.remove("active-card"); shown.classList.add("active-card"); }
    }
    if (!needs) return;
    content.dataset.carouselDots = "foot";
    fitLists(active, active.clientHeight);
    // Whether the card on show still reaches the dots where they rest: if the slide then stays too long for the zoom,
    // the dots are not drawn over its words (carousel.css).
    const restingDots = content.querySelector(":scope > .gallery-nav")?.getBoundingClientRect();
    const drawn = cardBounds(active);
    if (restingDots && drawn && drawn.bottom > restingDots.top + 1) content.dataset.carouselDotsOver = "";
    // The deck's control bar (.footer, fixed to the window's foot) covers the slide's foot while it shows: how far it
    // reaches into this slide, in canvas px, so the foot dots can rise clear of it (carousel.css).
    const bar = document.querySelector("footer.footer");
    const slide = content.closest(".slide");
    if (bar && slide && getComputedStyle(bar).display !== "none") {
      const barTop = window.innerHeight - (parseFloat(getComputedStyle(bar).bottom) || 0) - bar.offsetHeight;
      const reach = (slide.getBoundingClientRect().bottom - barTop) / canvasScale(slide);
      if (reach > 0) content.style.setProperty("--carousel-chrome-clear", `${Math.ceil(reach)}px`);
    }
  }
  function autofitContent(content) {
    if (!content) return;
    content.style.zoom = "";
    delete content.dataset.textFit;
    delete content.dataset.textTooTall;
    // A quote that still overflows at 31px is reported by the compiler. Whole-slide zoom would
    // silently violate that floor, so leave the exception visible at its accessible type size.
    if (content.querySelector('blockquote[data-quote-fit="too-long"], .slide-code[data-code-fit="too-long"]')) return;
    // A chat or terminal simulation is full-bleed at fixed sizes and clips its own overflow (the
    // latest turn stays in view); its text never shrinks (simulation spec, invariant 6).
    if (content.querySelector(":scope > .sim")) return;
    const slide = content.closest(".slide");
    if (!slide) return;
    const cs = getComputedStyle(slide);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const availW = slide.clientWidth - padX;
    const availH = slide.clientHeight - padY;
    if (availW <= 0 || availH <= 0) return;
    // Measure the content's NATURAL size. .slide-content carries a large min-height
    // (it fills the stage by design); neutralise it during measurement so short slides
    // are not falsely flagged as overflowing.
    const prevMinH = content.style.minHeight;
    content.style.minHeight = "0";
    const contentW = content.scrollWidth;
    // A carousel card taller than its band overflows downwards (`safe center`, carousel.css), and scrollHeight usually
    // counts it; where it does not (a card of overlapping panels), the card's own measure does. The larger of the two,
    // so the overflow is neither missed nor counted twice.
    const contentH = Math.max(content.scrollHeight, Math.ceil(content.clientHeight + carouselCardExcess(content)));
    content.style.minHeight = prevMinH;
    // scrollWidth/scrollHeight are INTEGERS (ceil of a fractional box): a full-bleed child stretched
    // to a fractional content box (5.6cqw padding) reports 1px wider than the box itself and used to
    // earn a phantom 0.999x whole-slide zoom. Compare against the ceil of the band, so only real
    // overflow (≥ 1px past the box) triggers the zoom.
    if (contentH <= Math.ceil(availH) && contentW <= Math.ceil(availW)) return; // fits: leave at zoom 1
    const factor = Math.max(AUTOFIT_FLOOR, Math.min(availH / contentH, availW / contentW, 1));
    // The zoom applies only while the smallest text stays at or above the type floor.
    const floorPx = slide.clientWidth * TYPE_FLOOR_CQW / 100;
    const smallest = smallestTextPx(content);
    if (smallest && smallest * factor < floorPx - 0.01) {
      content.dataset.textFit = "too-long";
      const ratio = Math.max(contentH / availH, contentW / availW);
      content.dataset.textTooTall = String(Math.max(1, Math.round((ratio - 1) * 100)));
      return;
    }
    content.style.zoom = String(factor);
  }

  // ADR-0028 §10 — the no-lone-word join, checked against the real line breaks. The compiler joins
  // a title's or statement's last two words with a no-break space (no-lone-word.mjs) without knowing
  // the column it will wrap in. In a narrow column (a rail title is about 14ch) the joined pair can
  // push a word onto a line of its own ("How to work with / an / agent (numbered)") — worse than the
  // lone last word it was meant to prevent. So each pass measures both breakings and keeps the join
  // unless it leaves more one-word lines (a one-word line inside the text counts double: the Layout
  // Doctor's internal one-word line is the graver defect). Ties keep the join. The choice is
  // recomputed on every pass, so a resize or a type step can bring the join back.
  const joinSites = new WeakMap();
  function lastJoin(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let site = null;
    for (let node; (node = walker.nextNode());) {
      for (let i = node.data.length - 1; i >= 0; i--) {
        if (node.data[i] === "\u00a0" || node.data[i] === " ") {
          if (node.data[i] === "\u00a0") site = { node, index: i };
          break;
        }
      }
    }
    return site;
  }
  function oneWordScore(el, excuseWidth = 0) {
    const rows = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node; (node = walker.nextNode());) {
      for (let i = 0; i < node.data.length; i++) {
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rect = rangeRects(range)[0];
        if (!rect || !rect.height) continue;
        const mid = rect.top + rect.height / 2;
        const row = rows.find((candidate) => Math.abs(candidate.mid - mid) < rect.height / 3);
        if (row) {
          row.text += node.data[i];
          row.left = Math.min(row.left, rect.left);
          row.right = Math.max(row.right, rect.right);
        } else rows.push({ mid, text: node.data[i], left: rect.left, right: rect.right });
      }
    }
    const sorted = rows.sort((a, b) => a.mid - b.mid).filter((row) => row.text.trim());
    const lines = sorted.map((row) => row.text.trim());
    if (lines.length < 2) return 0;
    let score = 0;
    lines.forEach((line, index) => {
      if (/[\s\u00a0]/.test(line)) return;
      // A word that fills excuseWidth or more of the column could not share its line anyway: not a stranded word.
      if (excuseWidth && sorted[index].right - sorted[index].left >= excuseWidth) return;
      score += index === lines.length - 1 ? 1 : 2;
    });
    return score;
  }
  function settleJoin(el) {
    if (!el) return;
    let site = joinSites.get(el);
    if (site && site.node.parentNode && el.contains(site.node)) {
      // Restore a join a previous pass took back, then judge afresh.
      site.node.data = site.node.data.slice(0, site.index) + "\u00a0" + site.node.data.slice(site.index + 1);
    } else {
      site = lastJoin(el);
      if (!site) return;
      joinSites.set(el, site);
    }
    delete el.dataset.nbJoin;
    const joined = oneWordScore(el);
    if (joined === 0) return;
    site.node.data = site.node.data.slice(0, site.index) + " " + site.node.data.slice(site.index + 1);
    const apart = oneWordScore(el);
    if (apart < joined) {
      el.dataset.nbJoin = "released";
      return;
    }
    site.node.data = site.node.data.slice(0, site.index) + "\u00a0" + site.node.data.slice(site.index + 1);
  }

  // ADR-0028 §10 — statement slides. Two steps, both before the whole-slide zoom:
  //   1. Type step. A statement that is too tall — without a title, a block taller than 72% of the
  //      canvas (so at least ~100px of air stays above and below); with any title, a slide that
  //      would overflow — steps its lead paragraph's type down 0.5px at a time, never below the
  //      quote size max(31px, 3.4cqw), scaled by the slide's text-size step (preview.10). Zooming
  //      the slide instead would shrink the measure too.
  //   2. Shrink-wrap. Every option's box (panel, tinted panel, or bar) is sized to its longest line (CSS cannot
  //      size a box to its wrapped lines), so a statement whose lines end short of the measure
  //      still sits centred with equal margins. All parts of a multi-part statement share the
  //      width, so they read as one panel. If the narrower box would re-break any line, the
  //      panel keeps its measure.
  // Both write inline styles that are cleared and recomputed on every pass.
  const STATEMENT_HEIGHT_SHARE = 0.72;
  const STATEMENT_TYPE_STEP = 0.5;
  function statementLines(p, scale) {
    const range = document.createRange();
    range.selectNodeContents(p);
    const rects = [...rangeRects(range)].filter((rect) => rect.width > 0.5 && rect.height > 0.5);
    if (!rects.length) return { count: 0, width: 0 };
    const tops = new Set(rects.map((rect) => Math.round(rect.top / scale)));
    const width = (Math.max(...rects.map((rect) => rect.right)) - Math.min(...rects.map((rect) => rect.left))) / scale;
    return { count: tops.size, width };
  }
  function contentOverflowsSlide(content, slide) {
    const cs = getComputedStyle(slide);
    const availH = slide.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const availW = slide.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const prevMinH = content.style.minHeight;
    content.style.minHeight = "0";
    const over = content.scrollHeight > Math.ceil(availH) || content.scrollWidth > Math.ceil(availW);
    content.style.minHeight = prevMinH;
    return over;
  }
  function fitStatements(content) {
    if (!content || !content.classList.contains("layout-statement")) return;
    const paras = [...content.querySelectorAll(":scope > p:not(.kicker):not(.slide-source)")];
    paras.forEach((p) => { p.style.removeProperty("font-size"); p.style.removeProperty("width"); });
    delete content.dataset.statementFit;
    const slide = content.closest(".slide");
    if (!paras.length || !slide) return;
    content.style.zoom = "";
    const scale = canvasScale(slide);
    const stage = canvasOf(slide);
    const canvasW = stage?.clientWidth || slide.clientWidth;
    const canvasH = stage?.clientHeight || slide.clientHeight;
    const untitled = slide.dataset.titleLayout === "hidden";
    const blockHeight = () => {
      let top = Infinity;
      let bottom = -Infinity;
      for (const p of paras) {
        const rect = p.getBoundingClientRect();
        top = Math.min(top, rect.top);
        bottom = Math.max(bottom, rect.bottom);
      }
      return (bottom - top) / scale;
    };
    const tooTall = () => (untitled && blockHeight() > STATEMENT_HEIGHT_SHARE * canvasH + 0.5)
      || contentOverflowsSlide(content, slide);
    const lead = paras[0];
    // preview.10: the floor follows the slide's text-size step ({font-body=…}, or the deck's
    // default) by the same ratio as the statement size: --fs-body over its M value, both measured
    // where the statement sits (so cqw resolves against the same container). CSS stays the one
    // owner of the ladder (overrides.css); nothing here knows the step names.
    const bodyScale = (() => {
      const probe = (value) => {
        const span = document.createElement("span");
        span.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;font-size:" + value;
        content.appendChild(span);
        const px = parseFloat(getComputedStyle(span).fontSize);
        span.remove();
        return px;
      };
      const step = probe("var(--fs-body)");
      const base = probe("max(var(--type-floor), 3.2cqw)");
      return step > 0 && base > 0 ? step / base : 1;
    })();
    const floor = Math.max(31, 0.034 * canvasW) * bodyScale;
    let size = parseFloat(getComputedStyle(lead).fontSize);
    const start = size;
    if (size > floor && tooTall()) {
      for (let i = 0; i < 400 && size > floor && tooTall(); i++) {
        size = Math.max(floor, Math.round((size - STATEMENT_TYPE_STEP) * 10) / 10);
        lead.style.setProperty("font-size", size + "px", "important");
      }
    }
    content.dataset.statementFit = size === start ? "base" : (tooTall() ? "too-long" : "type");
    paras.forEach(settleJoin);
    // Every option shares the measure and the shrink-wrap (preview.9 follow-up): Tint and Bar
    // differ from the Default only in the box, so their box hugs its lines too.
    const before = paras.map((p) => statementLines(p, scale));
    const widest = Math.max(...before.map((line) => line.width));
    if (!(widest > 0)) return;
    const width = Math.ceil(widest + 1) + "px";
    paras.forEach((p) => p.style.setProperty("width", width, "important"));
    const after = paras.map((p) => statementLines(p, scale));
    if (after.some((line, index) => line.count !== before[index].count)) {
      paras.forEach((p) => p.style.removeProperty("width"));
    }
  }

  // Ticket 18 — long-list fitting (ADR-0005 floor, ADR-0023 §3). A list column that would overflow
  // its band at the default type gives up LEADING first (--list-lh 1.35 → 1.18), then the air between
  // items (--list-gap 1 → .64, i.e. row padding .55em → .35em), and only then type (--fs-body, never below the stage floor).
  // Writes the same two custom properties the compile-time data-list-density presets set, inline on
  // .slide-content, so CSS stays the single owner of what those tokens mean. Runs BEFORE autofitContent
  // so the whole-slide zoom only ever sees a list that has already spent its own slack.
  const LIST_LH_MIN = 1.18;
  const LIST_GAP_MIN = 0.64;
  // ADR-0028 §5: icon lists, cards and icon rows fit by spacing before type, further than plain
  // lists do: their row padding and gaps (all written against --list-gap) give down to .3 of their
  // drawn values. At .3 an icon-list row keeps .21em above and below its dotted separator, and card
  // sub-items keep a .15em CSS floor either side of theirs (skin/list.css), so the separators stay legible.
  const LIST_SPACED_GAP_MIN = 0.3;
  const LIST_SPACED_SELECTOR = ":scope > .feature-list.fl-iconlist-list, :scope > .feature-list:not(.fl-annotated):has(> li > .fl-icon), :scope > .slot > .slot-copy .feature-list.fl-iconlist-list, :scope > .icon-row";
  // ADR-0028 §5 width step: a card or icon-row column too narrow for one of its words at the body
  // size steps --fs-body down by 0.1cqw until every word fits, never below the dense step (2.6cqw).
  // Headings ride the same token (1.15em), so the heading ratio holds at every step.
  const LIST_WIDTH_STEP_CQW = 0.1;
  const LIST_WIDTH_FLOOR_CQW = 2.6;
  function wordOverflowCells(content) {
    return [...content.querySelectorAll(":scope > .feature-list:not(.fl-annotated):not(.fl-iconlist-list):has(> li > .fl-icon) > li, :scope > .icon-row > .ir-item")];
  }
  // True when any word in a cell runs into the cell's right padding (half a pixel of tolerance, as the
  // drawing's emulation measured it: round-2/tools/jobs.py WIDTH_FIT). Icon-row text normally breaks
  // inside long words (overflow-wrap: break-word); that break is suspended while measuring, so a
  // word that only fits by being split counts as too wide.
  function cellsOverflowWords(cells) {
    const range = document.createRange();
    // Word and cell rects are painted px, the cell's padding is canvas px: compare in canvas px.
    const scale = cells.length ? canvasScale(cells[0]) : 1;
    return cells.some((cell) => {
      const limit = cell.getBoundingClientRect().right / scale - (parseFloat(getComputedStyle(cell).paddingRight) || 0) + 0.5;
      return [...cell.querySelectorAll(":scope > .fl-text, .fl-subtext, :scope > .ir-label, .ir-desc > li")].some((text) => {
        const wrap = text.style.getPropertyValue("overflow-wrap");
        const wrapPriority = text.style.getPropertyPriority("overflow-wrap");
        text.style.setProperty("overflow-wrap", "normal", "important");
        range.selectNodeContents(text);
        let right = -Infinity;
        for (const rect of rangeRects(range)) if (rect.width > 0) right = Math.max(right, rect.right / scale);
        if (wrap) text.style.setProperty("overflow-wrap", wrap, wrapPriority);
        else text.style.removeProperty("overflow-wrap");
        return right > limit;
      });
    });
  }
  function fitListWords(content, stageWidth) {
    const cells = wordOverflowCells(content);
    if (!cells.length || !stageWidth || !cellsOverflowWords(cells)) return;
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;font-size:var(--fs-body)";
    content.appendChild(probe);
    const base = parseFloat(getComputedStyle(probe).fontSize);
    probe.style.fontSize = "var(--fs-dense)";
    const floor = parseFloat(getComputedStyle(probe).fontSize) || stageWidth * LIST_WIDTH_FLOOR_CQW / 100;
    probe.remove();
    if (!base || base <= floor) return;
    const step = stageWidth * LIST_WIDTH_STEP_CQW / 100;
    let size = base;
    while (size > floor + 1e-6 && cellsOverflowWords(cells)) {
      size = Math.max(floor, Math.round((size - step) * 100) / 100);
      content.style.setProperty("--fs-body", size + "px");
    }
    content.dataset.listWidthFit = String(Math.round(size / stageWidth * 1000) / 10) + "cqw";
  }
  // `band`: the height (canvas px) to fit in when it is not the slide's own band, as for the card on show in a
  // carousel (fitCarouselCard).
  function fitLists(content, band = 0) {
    if (!content) return;
    ["--list-lh", "--list-gap", "--fs-body"].forEach((prop) => content.style.removeProperty(prop));
    delete content.dataset.listFit;
    delete content.dataset.listWidthFit;
    // The poll frame (poll-frame.css) reads the same three tokens: its option rows ride the deck's
    // own list scale, and its matrix items, scale chips and every frame gap step with them, so the
    // ladder below fits a long poll before the whole-slide zoom is allowed to touch the slide.
    // Reset the question notch on every frame, but measure the VISIBLE one: while the live
    // projection is mounted the compiled frame is [hidden] and has no box.
    content.querySelectorAll(":scope > .poll-frame").forEach((frame) => frame.removeAttribute("data-question-fit"));
    const pollFrame = content.querySelector(":scope > .poll-frame:not([hidden])");
    // Ticket 21: a table joins the seam — its cell padding rides --list-gap, its leading --list-lh
    // and its type --fs-body (skin/table.css @order 1980), so the same three steps fit it.
    // A poll frame's options and matrix rows join it too (T27): they never paginate, so a long
    // poll must spend the same leading → gap → type ladder on itself.
    // ADR-0028 §5: an icon row joins the seam too — its item padding, heading-to-items gap and item
    // lines ride --list-gap / --list-lh and its type --fs-body (skin/icon-row.css), so it spends
    // spacing, then type, before autofitContent may zoom the whole slide.
    const hasList = content.querySelector(":scope > .feature-list, :scope > .slot > .slot-copy .feature-list, :scope > ul:not(.timeline), :scope > ol:not(.timeline), :scope > .slide-table, :scope > .slot > .slot-copy .slide-table, :scope > .poll-frame ol.poll-frame-options, :scope > .poll-frame ol.poll-frame-matrix, :scope > .icon-row, :scope > .timeline-rail");
    if (!hasList || content.querySelector(".card-gallery, .timeline:not(.timeline-rail)")) return;
    // A rail timeline (ADR-0033 §8: entries at body size) is a stack of stops that can outgrow the
    // band. Its size is --fs-body only (skin/timeline.css @order 1446), so it skips the leading and
    // gap steps, which it does not read, and steps its type down toward the floor before any zoom.
    const railTimeline = !!content.querySelector(":scope > .timeline-rail");
    const slide = content.closest(".slide");
    if (!slide) return;
    // Measure unzoomed: a whole-slide zoom carried from the previous pass would rescale every rect
    // (autofitContent clears and recomputes it straight after this pass anyway).
    content.style.zoom = "";
    // The band (availH) is canvas px; every rect below is painted px and is divided by this first.
    const scale = canvasScale(slide);
    const stageWidth = canvasOf(slide)?.clientWidth || slide.clientWidth;
    // Width first: the size every word fits at is the ceiling the height ladder starts from.
    fitListWords(content, stageWidth);
    const gapMin = content.querySelector(LIST_SPACED_SELECTOR) ? LIST_SPACED_GAP_MIN : LIST_GAP_MIN;
    const cs = getComputedStyle(slide);
    // The band is the slide minus its own padding AND the content column's padding (Ticket 21 gives
    // the sidebar regime's content column 6cqh above and below; stage.css @order 1341).
    const contentStyle = getComputedStyle(content);
    const availH = band > 0 ? band : slide.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
      - (parseFloat(contentStyle.paddingTop) || 0) - (parseFloat(contentStyle.paddingBottom) || 0);
    if (availH <= 0) return;
    // In the sidebar regime the visible .slide-head IS the tint rail: it spans the column's full
    // height by construction, so it can never be the thing that overflows and must not count.
    const railHead = slide.dataset.titleLayout === "left"
      ? content.querySelector(":scope > .slide-head:not(.slide-head-quiet)")
      : null;
    // Measure the UNION of the content's children, not scrollHeight: a centred column that is taller
    // than its band overflows upwards as well as downwards, and negative overflow is never scrollable.
    // A poll frame is the exception (T27): the stage centres .slide-content, so the frame's box simply
    // GROWS with its content and no internal scroll overflow ever appears — the band breach is the box
    // itself being taller than the slide's height minus its padding. Compare the frame's own box with
    // that band, scaling by any whole-slide zoom still carried from the previous autofit pass so both
    // sides share one coordinate space (the box's px live below the zoom, the band's above it).
    const overflows = () => {
      if (pollFrame) {
        // Exact, NATURAL comparison: autofitContent — which owns the zoom and clears it at the top
        // of its own pass, immediately after this one — lets a slide pass only at contentH <= availH,
        // so the ladder must satisfy the same predicate. A zoom carried from a previous pass rescales
        // the frame's rect (getBoundingClientRect returns visual px) and would hide real overflow or
        // invent phantom overflow, so measure with it cleared.
        content.style.zoom = "";
        return pollFrame.getBoundingClientRect().height / scale > availH;
      }
      let top = Infinity;
      let bottom = -Infinity;
      for (const child of content.children) {
        if (child === railHead) continue;
        // A copy-beside-media slot STRETCHES to fill the band by construction (media.css @order 1819),
        // so its own box always measures the band — to a fractional pixel over it when the content
        // padding is fractional — and the ladder used to run every image-beside-list slide to the
        // floor. Its copy column is centred inside that row and overflows it (both ways) only when
        // the copy is really too tall, so measure the copy column, never the stretched slot. The
        // media column is bounded by the row (overflow: hidden) and can never be what overflows.
        const measured = child.classList.contains("slot") ? child.querySelector(":scope > .slot-copy") || child : child;
        const rect = measured.getBoundingClientRect();
        if (rect.height <= 0) continue;
        top = Math.min(top, rect.top);
        bottom = Math.max(bottom, rect.bottom);
      }
      // Round the way autofitContent's scrollHeight rounds (up to the next pixel): a half-pixel
      // overflow the fitter tolerated used to hand the whole slide a 0.998 zoom.
      return bottom > top && Math.ceil((bottom - top) / scale) > Math.floor(availH);
    };
    if (!overflows()) { content.dataset.listFit = "base"; return; }
    const startLh = parseFloat(getComputedStyle(content).getPropertyValue("--list-lh")) || 1.35;
    const startGap = parseFloat(getComputedStyle(content).getPropertyValue("--list-gap")) || 1;
    let lh = railTimeline ? LIST_LH_MIN : startLh;
    while (lh > LIST_LH_MIN + 1e-6 && overflows()) {
      lh = Math.max(LIST_LH_MIN, Math.round((lh - 0.02) * 100) / 100);
      content.style.setProperty("--list-lh", String(lh));
    }
    if (!railTimeline && !overflows()) { content.dataset.listFit = "leading"; return; }
    let gap = railTimeline ? gapMin : startGap;
    while (gap > gapMin + 1e-6 && overflows()) {
      gap = Math.max(gapMin, Math.round((gap - 0.06) * 100) / 100);
      content.style.setProperty("--list-gap", String(gap));
    }
    if (!railTimeline && !overflows()) { content.dataset.listFit = "gap"; return; }
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;font-size:var(--fs-body)";
    content.appendChild(probe);
    const base = parseFloat(getComputedStyle(probe).fontSize);
    probe.remove();
    const stage = canvasOf(slide);
    const floor = (stage?.clientWidth || slide.clientWidth) * 31 / 1600;
    if (!base || !floor) { content.dataset.listFit = "too-long"; return; }
    let size = base;
    while (size > floor && overflows()) {
      size = Math.max(floor, size - 1);
      content.style.setProperty("--fs-body", size + "px");
    }
    // T27, last resort before the whole-slide zoom: a poll frame whose answers already spent the
    // whole ladder steps its question down one notch — from the 3.4cqw headline to the stage type
    // floor (poll-frame.css turns the flag). Anything still overflowing after that zooms.
    if (pollFrame && overflows()) {
      pollFrame.dataset.questionFit = "stepped";
      if (!overflows()) { content.dataset.listFit = "type"; return; }
    }
    content.dataset.listFit = overflows() ? "too-long" : "type";
  }

  // Plain view ticket 07: paragraphs with an icon beside them (06-block-renderers, data-para-icon)
  // share ONE icon column on a slide. Each is laid out from its own text size and padding first
  // (title-and-paragraph-icons.css), and a slide may set its paragraphs at different sizes (a
  // statement's later parts are quieter), which would leave the icons a few px apart. Every later
  // paragraph of a container therefore takes the first one's icon position, icon size and text
  // start, as three custom properties the stylesheet reads. A slide with fewer than two such
  // paragraphs is not touched.
  function alignParagraphIcons(content) {
    const paras = [...content.querySelectorAll("p.content-p[data-para-icon]")];
    if (!paras.length) return;
    paras.forEach((p) => ["--para-icon-col", "--para-icon-inset", "--para-icon-size"].forEach((name) => p.style.removeProperty(name)));
    if (paras.length < 2) return;
    content.style.zoom = "";
    const scale = canvasScale(content);
    const groups = new Map();
    paras.forEach((p) => groups.set(p.parentElement, [...(groups.get(p.parentElement) || []), p]));
    for (const group of groups.values()) {
      const icon = group[0].querySelector(":scope > .para-icon");
      const text = group[0].querySelector(":scope > .para-icon-text");
      if (group.length < 2 || !icon || !text) continue;
      const iconRect = icon.getBoundingClientRect();
      const textLeft = text.getBoundingClientRect().left;
      if (!(iconRect.width > 0)) continue;
      for (const p of group.slice(1)) {
        const cs = getComputedStyle(p);
        const contentLeft = p.getBoundingClientRect().left + ((parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0)) * scale;
        p.style.setProperty("--para-icon-inset", ((iconRect.left - contentLeft) / scale) + "px");
        p.style.setProperty("--para-icon-col", Math.max(0, (textLeft - contentLeft) / scale) + "px");
        p.style.setProperty("--para-icon-size", (iconRect.width / scale) + "px");
      }
    }
  }

  // Image with claims (0.41 ticket 12, drawing after/21-image-claim.html): each claim's link starts on the box's
  // outer left border at the box's mid-height and its head's tip lands on the picture's outer right border at
  // y = clamp(picture top + reach, box mid, picture bottom - reach), reach = --ic-reach (24 px at 1920). A claim
  // level with the picture keeps the horizontal link the stylesheet draws; one above or below it gets two custom
  // properties on its .ic-link: --ic-angle (a rotation about the box-side end) and --ic-stretch (the link's length
  // over the gap). Both are ratios of painted px, so the stage scale and the whole-slide zoom cancel out. Without
  // this pass (no script) every link stays horizontal. Runs last in fitContent, and again when the picture or a
  // claim changes size (a late image, a reveal step) through one ResizeObserver per layout.
  const claimObservers = new WeakSet();
  function cqwOf(el, name, fallback) {
    const value = getComputedStyle(el).getPropertyValue(name).trim();
    const n = /cqw$/.test(value) ? parseFloat(value) : NaN;
    return n > 0 ? n : fallback;
  }
  function linkClaims(layout) {
    const picture = layout.querySelector(":scope > figure.slide-figure");
    const links = [...layout.querySelectorAll(":scope > .callouts > li > .ic-link")];
    if (!picture || !links.length) return;
    const pic = picture.getBoundingClientRect();
    if (!(pic.width > 0 && pic.height > 0)) return;
    const reachRatio = cqwOf(layout, "--ic-reach", 1.25) / cqwOf(layout, "--ic-gap", 6.7708);
    for (const link of links) {
      const box = link.parentElement.getBoundingClientRect();
      const dx = pic.right - box.left;
      const shown = box.height > 0 && dx < 0 && getComputedStyle(link).display !== "none";
      const mid = box.top + box.height / 2;
      const reach = Math.min(-dx * reachRatio, pic.height / 2);
      const dy = shown ? Math.max(pic.top + reach, Math.min(pic.bottom - reach, mid)) - mid : 0;
      if (Math.abs(dy) < 0.25) {
        link.style.removeProperty("--ic-angle");
        link.style.removeProperty("--ic-stretch");
        continue;
      }
      link.style.setProperty("--ic-angle", (Math.atan2(-dy, -dx) * 180 / Math.PI).toFixed(3) + "deg");
      link.style.setProperty("--ic-stretch", (Math.hypot(dx, dy) / -dx).toFixed(5));
    }
  }
  function linkImageClaims(content) {
    content.querySelectorAll(".evidence-layout").forEach((layout) => {
      linkClaims(layout);
      if (claimObservers.has(layout) || typeof ResizeObserver === "undefined") return;
      claimObservers.add(layout);
      const observer = new ResizeObserver(() => linkClaims(layout));
      const picture = layout.querySelector(":scope > figure.slide-figure");
      if (picture) observer.observe(picture);
      layout.querySelectorAll(":scope > .callouts > li").forEach((li) => observer.observe(li));
    });
  }


  // ---- 0.44 Ocean look: fit or fall back ------------------------------------------------------------------
  // A slide in the look (data-look="ocean") whose content, after the look's own sizing and the list and statement
  // ladders, still reaches past the stage, hides part of itself (overflow hidden or clip with more content than
  // box), cuts a title short, or breaks or spills a word or label is compared with its safe drawing
  // (data-look="ocean-safe": the look's colours on the 0.43 structure and sizes) and takes it, for good, only when the
  // safe drawing is strictly better (oceanDecide). A title the look had moved to the top goes back where 0.43 put it.
  const OCEAN_FIT_TOLERANCE = 1.5;
  // The fit checks below answer "is anything wrong" (no tally: true at the first fault) or, given a tally
  // ({ n, px }), count every fault and add its size in canvas px (how far it overhangs or overlaps), for comparing two
  // drawings of the same slide (oceanDecide).
  // A fault: counted, its size added, and its signature kept (kind, the elements it concerns by their index path in
  // the slide, size in steps of the fit tolerance). The safe drawing is the same markup under another data-look, so an
  // element has the same path in both drawings and two drawings' signatures can be compared (sameFaults).
  function pathOf(el) {
    const steps = [];
    for (let node = el; node && node.parentElement && !node.classList?.contains("slide"); node = node.parentElement) {
      steps.push(Array.prototype.indexOf.call(node.parentElement.children, node));
    }
    return steps.reverse().join(".");
  }
  function fault(tally, px, kind = "", ...els) {
    if (!tally) return true;
    tally.n += 1;
    tally.px += Math.max(0, px);
    if (tally.sig) tally.sig.push(`${kind}|${els.map(pathOf).join("+")}|${Math.round(Math.max(0, px) / OCEAN_FIT_TOLERANCE)}`);
    return false;
  }
  function lookOverflows(slide, tally) {
    const stage = slide.getBoundingClientRect();
    if (!(stage.width > 0 && stage.height > 0)) return null;
    const scale = canvasScale(slide);
    // A carousel card past its band, even inside the slide (carouselCardExcess is in canvas px already, so it is
    // compared with the unscaled tolerance).
    const excess = carouselCardExcess(slide.querySelector(":scope > .slide-content"));
    if (excess > OCEAN_FIT_TOLERANCE && fault(tally, excess, "card", activeCarouselCard(slide.querySelector(":scope > .slide-content")))) return true;
    const t = OCEAN_FIT_TOLERANCE * scale;
    // an element outside the stage counts once, not again for each of its children
    const outside = new Set();
    for (const el of slide.querySelectorAll(".slide-content *")) {
      if (el.closest(".notes, .sr-only, iframe, svg, .slide-qr-corner")) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.position === "fixed") continue; // hidden reveal steps still take their place
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) continue;
      if (r.left < stage.left - t || r.top < stage.top - t || r.right > stage.right + t || r.bottom > stage.bottom + t) {
        if (!outside.has(el.parentElement) && fault(tally, Math.max(stage.left - r.left, stage.top - r.top, r.right - stage.right, r.bottom - stage.bottom) / scale, "stage", el)) return true;
        outside.add(el);
      }
      if ((cs.overflowX === "hidden" || cs.overflowX === "clip") && el.scrollWidth > el.clientWidth + OCEAN_FIT_TOLERANCE && fault(tally, el.scrollWidth - el.clientWidth, "clip-x", el)) return true;
      if ((cs.overflowY === "hidden" || cs.overflowY === "clip") && el.scrollHeight > el.clientHeight + OCEAN_FIT_TOLERANCE && fault(tally, el.scrollHeight - el.clientHeight, "clip-y", el)) return true;
    }
    return tally ? tally.n > 0 : false;
  }
  // The opening poster: the title steps down from the display size until the title, subtitle and byline all fit the
  // stage without meeting (the byline's place included), to no smaller than about 0.43's poster size; past that the
  // slide falls back like any other.
  function posterCollides(poster) {
    const mid = poster.querySelector(".tp-main > .tp-mid");
    const foot = poster.querySelector(".tp-main > .tp-foot");
    if (!mid || !foot) return false;
    return mid.getBoundingClientRect().bottom > foot.getBoundingClientRect().top - OCEAN_FIT_TOLERANCE * canvasScale(poster);
  }
  function fitOceanPoster(content) {
    const slide = content.closest(".slide");
    if (!slide || slide.dataset.look !== "ocean") return;
    const poster = content.querySelector(".tp.tp-poster:not(.tp-closing)");
    const title = poster?.querySelector(".tp-title");
    if (!title) return;
    title.style.fontSize = "";
    const width = slide.offsetWidth || slide.getBoundingClientRect().width;
    if (!(width > 0)) return;
    const min = width * 0.033;
    let px = parseFloat(getComputedStyle(title).fontSize);
    for (let i = 0; i < 30 && px > min && (lookOverflows(slide) || posterCollides(poster)); i += 1) {
      px = Math.max(min, px * 0.93);
      title.style.fontSize = `${px}px`;
    }
    if (lookOverflows(slide) || posterCollides(poster)) title.style.fontSize = "";
  }
  // Two blocks of the slide drawn over each other (a paragraph under a list's bands, a list's last row under a
  // pair of boxes): the look's arrangement did not leave each its place.
  function blocksMeet(content, tally) {
    const blocks = [...content.children].filter((el) => {
      if (el.matches(".slide-head, .notes, .sr-only, script, style, template")) return false;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.position === "absolute" || cs.position === "fixed") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const rects = blocks.map((el) => el.getBoundingClientRect());
    const scale = canvasScale(content);
    const t = 4 * scale;
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i], b = rects[j];
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > t && h > t && fault(tally, Math.min(w, h) / scale, "blocks", blocks[i], blocks[j])) return true;
      }
    }
    return tally ? tally.n > 0 : false;
  }
  // Two faults the look's boxes can hide from the stage and block checks above: a word broken inside itself, and text
  // standing outside its own box (a row's label running down into the next row). The boxes are the designed items the
  // look draws (list rows and cards, icon-row items, steps, equation terms, stats, org and map boxes) and the loop's
  // label boxes. Text outside a box counts only for a box that is drawn (a fill or a border); a word counts as broken
  // when its own line boxes start on two lines at an emergency break (brokenWord). Words are the platform's
  // (Intl.Segmenter), and a run of emoji is no word. Text the deck lets break anywhere on purpose (a web address on the
  // links slide, word-break: break-all, overflow-wrap: anywhere) is not looked at.
  const OCEAN_ITEM_BOXES = ".feature-list > li, .icon-row > .ir-item, .steps-diagram > .step-col, .equation-row .eq-term, .stats-row > .stat, .orgchart .org-box, .system-map > div, .cycle-diagram .oc-loop-label";
  const wordSegmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "word" }) : null;
  function wordsOf(text) {
    if (!wordSegmenter) return [];
    return [...wordSegmenter.segment(text)].filter((seg) => seg.isWordLike && seg.segment.length > 1);
  }
  function breaksAnywhere(el) {
    if (!el || el.closest(".link-url")) return true;
    const cs = getComputedStyle(el);
    return cs.wordBreak === "break-all" || cs.overflowWrap === "anywhere";
  }
  // A word broken inside itself by an emergency break: only text that may take one (overflow-wrap: break-word) can show
  // it, and a break that stays when emergency breaks are turned off is one the line-breaking rules allow (between the
  // characters of a word in a language written without spaces), not a fault.
  function lineTops(range) {
    const lines = [...rangeRects(range)].filter((r) => r.width > 0.5 && r.height > 0.5);
    return lines.some((r) => Math.abs(r.top - lines[0].top) > r.height / 2);
  }
  // A break inside a run between spaces that is itself too long for its box (inner: the box's content width) is the last
  // resort's own break (wordsTooLong), not a fault.
  function brokenWord(node, range, inner = Infinity) {
    const el = node.parentElement;
    if (breaksAnywhere(el)) return false;
    const cs = getComputedStyle(el);
    if (cs.overflowWrap !== "break-word" && cs.wordBreak !== "break-word") return false;
    for (const word of wordsOf(node.data)) {
      range.setStart(node, word.index);
      range.setEnd(node, word.index + word.segment.length);
      if (!lineTops(range)) continue;
      const wrap = [el.style.getPropertyValue("overflow-wrap"), el.style.getPropertyPriority("overflow-wrap")];
      const brk = [el.style.getPropertyValue("word-break"), el.style.getPropertyPriority("word-break")];
      el.style.setProperty("overflow-wrap", "normal", "important");
      el.style.setProperty("word-break", "normal", "important");
      const legal = lineTops(range);
      let tooLong = false;
      if (!legal) {
        // the run between spaces that holds the word, laid out without emergency breaks
        let start = word.index, end = word.index + word.segment.length;
        while (start > 0 && !/\s/.test(node.data[start - 1])) start -= 1;
        while (end < node.data.length && !/\s/.test(node.data[end])) end += 1;
        range.setStart(node, start);
        range.setEnd(node, end);
        tooLong = [...rangeRects(range)].some((r) => r.width > inner + 1);
      }
      if (wrap[0]) el.style.setProperty("overflow-wrap", wrap[0], wrap[1]); else el.style.removeProperty("overflow-wrap");
      if (brk[0]) el.style.setProperty("word-break", brk[0], brk[1]); else el.style.removeProperty("word-break");
      if (!legal && !tooLong) return true;
    }
    return false;
  }
  function drawnBox(cs) {
    return !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(cs.backgroundColor) || ["Top", "Right", "Bottom", "Left"].some((side) => parseFloat(cs[`border${side}Width`]) > 0);
  }
  function itemBoxes(content) {
    // a carousel's cards (.card-gallery) are fitted by the carousel's own code, card by card; their lists are left as drawn
    return [...content.querySelectorAll(OCEAN_ITEM_BOXES)].filter((box) => !box.closest(".notes, .sr-only, .slide-head, .card-gallery"));
  }
  function itemsBreak(content, tally) {
    const boxes = itemBoxes(content);
    if (!boxes.length) return false;
    const scale = canvasScale(content);
    const t = OCEAN_FIT_TOLERANCE * scale;
    const range = document.createRange();
    for (const box of boxes) {
      const cs = getComputedStyle(box);
      if (cs.display === "none") continue;
      const own = box.getBoundingClientRect();
      if (!(own.width > 0 && own.height > 0)) continue;
      const drawn = drawnBox(cs);
      const inner = own.width - (parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)) * scale;
      const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      for (let node; (node = walker.nextNode());) {
        if (!node.data.trim() || node.parentElement?.closest(".sr-only, svg")) continue;
        if (drawn) {
          range.selectNodeContents(node);
          for (const r of rangeRects(range)) {
            if (!(r.width > 0.5 && r.height > 0.5)) continue;
            if ((r.left < own.left - t || r.right > own.right + t || r.top < own.top - t || r.bottom > own.bottom + t)
              && fault(tally, Math.max(own.left - r.left, r.right - own.right, own.top - r.top, r.bottom - own.bottom) / scale, "outside-box", box, node.parentElement)) return true;
          }
        }
        if (brokenWord(node, range, inner) && fault(tally, parseFloat(getComputedStyle(node.parentElement).fontSize) || 0, "broken-word", node.parentElement)) return true;
      }
    }
    return tally ? tally.n > 0 : false;
  }
  // A word that is itself too long for its box (an e-mail or web address, a path, a long compound): a piece of it, as the
  // line-breaking rules lay it out between spaces, is wider than the box's content. Measured on each run between spaces
  // (the platform's words split an address at "@" and "-" where a line may not break; a run between spaces breaks only
  // where the rules allow), never on the box's overflow, which a line of short words spilling sideways also shows.
  function wordsTooLong(content) {
    const scale = canvasScale(content);
    const range = document.createRange();
    for (const box of itemBoxes(content)) {
      const cs = getComputedStyle(box);
      const own = box.getBoundingClientRect();
      if (cs.display === "none" || !(own.width > 0)) continue;
      const inner = own.width - (parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)) * scale;
      const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      for (let node; (node = walker.nextNode());) {
        if (!node.data.trim() || node.parentElement?.closest(".sr-only, svg, .link-url")) continue;
        for (const m of node.data.matchAll(/\S+/g)) {
          range.setStart(node, m.index);
          range.setEnd(node, m.index + m[0].length);
          if ([...rangeRects(range)].some((r) => r.width > inner + 1)) return true;
        }
      }
    }
    return false;
  }
  // The loop's labels (zz-x-ocean-60-loop-labels.css): a stop's label box stays inside the slide's margins and meets no
  // other stop's label, no stop, not the ring and not the title, and keeps a gap of LOOP_LABEL_GAP_CQW from the slide's
  // other blocks (a label just under a sentence reads as the sentence's next line).
  const LOOP_LABEL_GAP_CQW = 1.5;
  function loopLabelsMeet(content, tally) {
    const scale = canvasScale(content);
    const t = 2 * scale;
    const slide = content.closest(".slide");
    const head = slide?.querySelector(".slide-head");
    const title = head ? head.getBoundingClientRect() : null;
    const box = slide.getBoundingClientRect();
    const pad = getComputedStyle(slide);
    // the top padding is the title's clearance (the title is checked on its own); a label keeps the bottom margin there
    const bottomPad = parseFloat(pad.paddingBottom) * scale;
    const inside = { left: box.left + parseFloat(pad.paddingLeft) * scale - t, right: box.right - parseFloat(pad.paddingRight) * scale + t, top: box.top + bottomPad - t, bottom: box.bottom - bottomPad + t };
    const overlap = (a, b) => Math.min(Math.min(a.right, b.right) - Math.max(a.left, b.left), Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const meet = (a, b) => overlap(a, b) > t;
    for (const ring of content.querySelectorAll(".cycle-diagram")) {
      // the slide's other blocks (a sentence above the loop): the blocks blocksMeet compares, less the loop's own, each
      // widened by the gap a label keeps from it
      const probe = document.createElement("span");
      probe.style.cssText = "position:absolute;visibility:hidden;width:100cqw;height:0";
      ring.appendChild(probe);
      const gap = probe.getBoundingClientRect().width / 100 * LOOP_LABEL_GAP_CQW;
      probe.remove();
      const others = [...content.children].filter((el) => !el.contains(ring) && !el.matches(".slide-head, .notes, .sr-only, script, style, template") && getComputedStyle(el).display !== "none")
        .map((el) => [el, el.getBoundingClientRect()]).filter(([, r]) => r.width > 0 && r.height > 0)
        .map(([el, r]) => ({ el, left: r.left - gap, right: r.right + gap, top: r.top - gap, bottom: r.bottom + gap }));
      // a word longer than its label box runs out of it
      for (const el of ring.querySelectorAll(":scope > .cycle-node > .oc-loop-label")) {
        if (el.scrollWidth > el.clientWidth + 1 && fault(tally, el.scrollWidth - el.clientWidth, "label-word", el)) return true;
      }
      const stops = [...ring.querySelectorAll(":scope > .cycle-node")].map((node) => ({ node, disc: node.getBoundingClientRect(), label: node.querySelector(":scope > .oc-loop-label")?.getBoundingClientRect() }));
      const labelled = stops.filter((stop) => stop.label && stop.label.width > 0 && stop.label.height > 0);
      if (!labelled.length) continue;
      const centres = stops.map(({ disc }) => [(disc.left + disc.right) / 2, (disc.top + disc.bottom) / 2]);
      const cx = centres.reduce((sum, c) => sum + c[0], 0) / centres.length;
      const cy = centres.reduce((sum, c) => sum + c[1], 0) / centres.length;
      const r = centres.reduce((sum, c) => sum + Math.hypot(c[0] - cx, c[1] - cy), 0) / centres.length;
      for (const { node, label } of labelled) {
        const out = Math.max(inside.left - label.left, label.right - inside.right, inside.top - label.top, label.bottom - inside.bottom);
        if (out > 0 && fault(tally, out / scale, "label-margin", node)) return true;
        if (title && title.width > 0 && meet(label, title) && fault(tally, overlap(label, title) / scale, "label-title", node)) return true;
        // the gap is kept exactly: any overlap with a widened block is a fault
        for (const other of others) if (overlap(label, other) > 0 && fault(tally, overlap(label, other) / scale, "label-block", node, other.el)) return true;
        for (const stop of stops) {
          if (meet(label, stop.disc) && fault(tally, overlap(label, stop.disc) / scale, "label-stop", node, stop.node)) return true;
          // each pair of labels once
          if (stop.label && stop.label !== label && stop.label.width > 0 && labelled.indexOf(stop) > labelled.findIndex((s) => s.label === label)
            && meet(label, stop.label) && fault(tally, overlap(label, stop.label) / scale, "label-label", node, stop.node)) return true;
        }
        // the ring passes through the box when its nearest point to the ring's centre lies inside the ring
        const nx = Math.max(label.left, Math.min(cx, label.right));
        const ny = Math.max(label.top, Math.min(cy, label.bottom));
        const inRing = r - t - Math.hypot(nx - cx, ny - cy);
        if (stops.length > 2 && inRing > 0 && fault(tally, inRing / scale, "label-ring", node)) return true;
      }
    }
    return tally ? tally.n > 0 : false;
  }
  // Icon-row items and cards whose label has a word too long for its box (a long single word in a narrow panel beside
  // the title): the labels step down from their size towards the type floor, one size for the whole row, until every
  // word fits inside its box; past the floor the slide falls back (the 0.44 drawing broke the word instead).
  const ITEM_LABEL_STEPS = [3.25, 3, 2.75, 2.5, 2.25, 2];
  const OCEAN_LABEL_BOXES = ":scope > .icon-row > .ir-item, :scope > .feature-list.fl-cards > li";
  function fitOceanItemLabels(content) {
    const slide = content.closest(".slide");
    if (!slide || slide.dataset.look !== "ocean") return;
    const items = [...content.querySelectorAll(OCEAN_LABEL_BOXES)];
    if (!items.length) return;
    const rows = [...content.querySelectorAll(":scope > .icon-row")];
    items.forEach((item) => item.style.removeProperty("--oc-label"));
    rows.forEach((row) => delete row.dataset.ocStack);
    if (!itemsBreak(content)) return;
    const label = items[0].querySelector(":scope > :is(.ir-label, .fl-text)");
    // 1cqw where the label resolves it (the stage's query container), in canvas px
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;width:100cqw;height:0";
    items[0].appendChild(probe);
    const cqw = probe.getBoundingClientRect().width / 100 / canvasScale(content);
    probe.remove();
    const start = label && cqw > 0 ? parseFloat(getComputedStyle(label).fontSize) / cqw : 0;
    // first beside the icon, as drawn; then (rows that set the icon beside the name) with the icon above the name
    for (const stack of [false, true]) {
      if (stack) {
        if (!rows.length) break;
        rows.forEach((row) => { row.dataset.ocStack = ""; });
        items.forEach((item) => item.style.removeProperty("--oc-label"));
        if (!itemsBreak(content)) return;
      }
      for (const step of ITEM_LABEL_STEPS) {
        if (start && step >= start - 0.01) continue;
        items.forEach((item) => item.style.setProperty("--oc-label", `max(var(--type-floor, 31px), ${step}cqw)`));
        if (!itemsBreak(content)) return;
      }
    }
  }
  // Icon-row panels with detail lines: the lines start at the size for their count (zz-x-ocean-50-readability.css) and
  // step down the same ladder, one size for the whole row, until the slide fits; past the floor the slide falls back.
  const PANEL_DETAIL_STEPS = [3.75, 3.45, 3, 2.5, 2.4];
  function fitOceanPanelDetails(content) {
    const slide = content.closest(".slide");
    if (!slide || slide.dataset.look !== "ocean") return;
    const rows = [...content.querySelectorAll(":scope > .icon-row:not(.ir-rows)")].filter((row) => row.querySelector(":scope > .ir-item .ir-desc > li"));
    if (!rows.length) return;
    const items = rows.flatMap((row) => [...row.querySelectorAll(":scope > .ir-item")]);
    items.forEach((item) => item.style.removeProperty("--oc-detail"));
    if (!lookOverflows(slide) && !blocksMeet(content) && !itemsBreak(content)) return;
    const li = rows[0].querySelector(":scope > .ir-item .ir-desc > li");
    const cqw = (rows[0].closest(".slide-content")?.getBoundingClientRect().width || 0) / 100;
    const start = cqw > 0 ? parseFloat(getComputedStyle(li).fontSize) / (cqw / (slide.getBoundingClientRect().width / (slide.offsetWidth || 1))) : 0;
    for (const step of PANEL_DETAIL_STEPS) {
      if (start && step >= start - 0.01) continue;
      items.forEach((item) => item.style.setProperty("--oc-detail", `max(var(--type-floor, 31px), ${step}cqw)`));
      if (!lookOverflows(slide) && !blocksMeet(content) && !itemsBreak(content)) return;
    }
  }
  // A loop whose labels meet the slide's other blocks or each other tries, in order: the top stop's label beside the stop
  // (as 0.44 drew it) instead of above it, the smaller ring (as long labels take), the smaller ring with the top label
  // beside; past that the slide's fall-back is decided like any other (oceanDecide).
  const LOOP_STEPS = [{ beside: true, tight: false }, { beside: false, tight: true }, { beside: true, tight: true }];
  function fitOceanLoop(content) {
    const slide = content.closest(".slide");
    if (!slide || slide.dataset.look !== "ocean") return;
    const rings = [...content.querySelectorAll(".cycle-diagram")].filter((ring) => ring.querySelector(".oc-loop-label"));
    if (!rings.length) return;
    const set = ({ beside, tight }) => rings.forEach((ring) => {
      if (beside) ring.dataset.ocTopBeside = ""; else delete ring.dataset.ocTopBeside;
      if (tight) ring.dataset.ocTight = ""; else delete ring.dataset.ocTight;
    });
    set({ beside: false, tight: false });
    if (!loopLabelsMeet(content)) return;
    for (const step of LOOP_STEPS) {
      set(step);
      if (!loopLabelsMeet(content)) return;
    }
  }
  // Fit or fall back, decided by comparing the two drawings. The look's drawing at its own best step is scored by the fit
  // checks with a tally (faultScore: every fault counted, each with its size in canvas px). If it has none, it stays. If
  // it has some, the safe drawing (the 0.43 structure and sizes in the look's colours) is drawn, fitted the 0.43 way and
  // scored the same way. The safe drawing is kept only when it is better (safeIsBetter). First on text lost (past the
  // stage's edge, clipped by a box, or under another block: lookOverflows and blocksMeet): a look that loses text falls
  // back (also when the safe drawing loses some too: 0.44.0's answer, as the size of what each loses is not measured
  // well enough to rank them), and a look that loses none stays when the safe drawing loses some. When neither loses
  // text, on all faults: fewer, or as many with at most four fifths of their total size (lessThan, <=); the look comes
  // back unless the safe drawing is better so, or has exactly the same faults (sameFaults: each fault's kind, the
  // elements it concerns and its size in steps of the fit tolerance; the look did not cause them, and 0.44.0 drew them
  // safe). When a word is itself too long for its
  // box in the safe drawing too (wordsTooLong: no drawing holds it whole), both drawings break it inside its box
  // (data-oc-last-resort, overflow-wrap: break-word) and are compared so; a look kept with such a word in it takes the
  // same last resort. The decision is made once the slide's fonts and pictures have settled (waitForAssets) and is
  // one-way: a slide that falls back keeps the safe drawing, and a slide whose look was kept is marked data-oc-kept and
  // not compared again (on a resize, a late font or picture, a return visit, or on paper).
  function faultScore(content) {
    const slide = content.closest(".slide");
    const tally = { n: 0, px: 0, sig: [] };
    lookOverflows(slide, tally);
    blocksMeet(content, tally);
    // text lost (past the stage's edge, clipped, or under another block) is weighed first (safeIsBetter)
    tally.cut = { n: tally.n, px: tally.px };
    loopLabelsMeet(content, tally);
    itemsBreak(content, tally);
    const poster = content.querySelector(".tp.tp-poster:not(.tp-closing)");
    if (poster && posterCollides(poster)) fault(tally, OCEAN_FIT_TOLERANCE, "poster", poster);
    return tally;
  }
  // "less": fewer faults, or as many with at most four fifths of their total size (and some size to compare)
  function lessThan(a, b) {
    return a.n < b.n || (a.n === b.n && b.px > 0 && a.px <= 0.8 * b.px);
  }
  // the same faults in both drawings: the same signatures (kind, elements, size in tolerance steps), whatever their
  // order; the look did not cause them
  function sameFaults(a, b) {
    if (!a.sig || !b.sig || a.sig.length !== b.sig.length) return false;
    const x = [...a.sig].sort(), y = [...b.sig].sort();
    return x.every((value, i) => value === y[i]);
  }
  // Is the safe drawing better than the look? Text lost first: the drawing that loses none is better; when both lose
  // some, the safe drawing (0.44.0's answer: how much text a drawing loses is not measured well enough to rank them).
  // When neither loses text, all faults: fewer, or as many with at most four fifths of their size; the same faults in
  // both (sameFaults: the same signatures): the safe drawing.
  function safeIsBetter(safe, look) {
    if (look.cut.n) return true;
    if (safe.cut.n) return false;
    return lessThan(safe, look) || sameFaults(safe, look);
  }
  function toSafeDrawing(content, slide) {
    slide.dataset.look = "ocean-safe";
    // the loop's steps (fitOceanLoop) belong to the look; the safe drawing carries none, on screen as on paper
    content.querySelectorAll(".cycle-diagram").forEach((ring) => { delete ring.dataset.ocTopBeside; delete ring.dataset.ocTight; });
    content.querySelectorAll(":scope > .icon-row > .ir-item").forEach((item) => item.style.removeProperty("--oc-detail"));
    content.querySelectorAll(OCEAN_LABEL_BOXES).forEach((item) => item.style.removeProperty("--oc-label"));
    content.querySelectorAll(":scope > .icon-row").forEach((row) => delete row.dataset.ocStack);
    content.querySelector(".tp.tp-poster:not(.tp-closing) .tp-title")?.style.removeProperty("font-size");
    if (slide.dataset.ocTitleFrom) {
      slide.dataset.titleLayout = slide.dataset.ocTitleFrom;
      if (slide.dataset.ocSplit) slide.dataset.split = slide.dataset.ocSplit;
      delete slide.dataset.titleLook;
    }
  }
  function toLookDrawing(slide, title) {
    slide.dataset.look = "ocean";
    for (const [key, value] of Object.entries(title)) {
      if (value === undefined) delete slide.dataset[key]; else slide.dataset[key] = value;
    }
  }
  function oceanDecide(content) {
    const slide = content.closest(".slide");
    if (!slide || slide.dataset.look !== "ocean" || "ocKept" in slide.dataset) return;
    // Fit provisionally while assets load, but never make the one-way layout decision yet.
    if (waitForAssets(content, slide)) return;
    content.style.zoom = "";
    let look = faultScore(content);
    if (!look.n) return;
    const title = { titleLayout: slide.dataset.titleLayout, split: slide.dataset.split, titleLook: slide.dataset.titleLook };
    // A throw while the safe drawing is up (a slide removed mid-fit) would leave it in the safe drawing undecided, and
    // every later fit would skip it: the finally puts the look back, undecided, so the next fit decides afresh.
    const hadLastResort = "ocLastResort" in slide.dataset;
    let settled = false;
    try {
      toSafeDrawing(content, slide);
      fitSafe(content);
      let safe = faultScore(content);
      if (!hadLastResort && wordsTooLong(content)) {
        slide.dataset.ocLastResort = "";
        toLookDrawing(slide, title);
        fitOcean(content);
        look = faultScore(content);
        toSafeDrawing(content, slide);
        fitSafe(content);
        safe = faultScore(content);
      }
      if (safeIsBetter(safe, look)) { settled = true; return; }
      toLookDrawing(slide, title);
      fitOcean(content);
      if (!("ocLastResort" in slide.dataset) && wordsTooLong(content)) {
        // the kept look takes the last resort; a broken word can add a line, so the result is scored again and falls
        // back if the safe drawing (scored without the last resort) is now better
        slide.dataset.ocLastResort = "";
        fitOcean(content);
        if (safeIsBetter(safe, faultScore(content))) {
          delete slide.dataset.ocLastResort;
          toSafeDrawing(content, slide);
          fitSafe(content);
          settled = true;
          return;
        }
      }
      slide.dataset.ocKept = "";
      settled = true;
    } finally {
      if (!settled) {
        if (!hadLastResort) delete slide.dataset.ocLastResort;
        toLookDrawing(slide, title);
      }
    }
  }
  function fitOcean(content) {
    content.querySelectorAll("h1:not(.sr-only)").forEach((h1) => { h1.style.fontSize = ""; settleTitle(h1); fitTitle(h1); });
    fitLists(content);
    fitStatements(content);
    alignParagraphIcons(content);
    fitOceanPoster(content);
    fitOceanItemLabels(content);
    fitOceanPanelDetails(content);
    fitOceanLoop(content);
    fitCarouselCard(content);
  }
  function fitSafe(content) {
    content.querySelectorAll("h1:not(.sr-only)").forEach((h1) => { h1.style.fontSize = ""; settleTitle(h1); fitTitle(h1); });
    fitLists(content);
    fitStatements(content);
    alignParagraphIcons(content);
    fitCarouselCard(content);
  }

  // Asset readiness. The Ocean fallback is one-way, so it waits briefly for a picture or font that
  // can still move the layout, but never indefinitely: a picture that never arrives (a lazy one out
  // of view, a hanging remote one) must not keep an overflowing slide clipped. After the wait the
  // decision is made with the reserved sizes; a picture that arrives later refits through the
  // caller's load listener. Print never waits.
  const ASSET_WAIT_MS = 1200;
  const assetWaits = new WeakMap();
  const refit = typeof options.refit === "function" ? options.refit : (content) => { fitContent(content); };
  // Font readiness lives here alone (the typeface work replaces it with its font watcher).
  function fontsSettling() {
    return Boolean(document.fonts && document.fonts.status === "loading");
  }
  function imageSettling(img) {
    if (img.complete) return false;
    // A reserved width and height: the picture's arrival cannot move the layout.
    if (img.hasAttribute("width") && img.hasAttribute("height")) return false;
    const rect = img.getClientRects()[0];
    if (!rect) return false; // not rendered: a lazy picture here never starts loading
    // A deferred picture outside the window has not started loading and may never start.
    if (img.loading === "lazy" && (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth)) return false;
    return true;
  }
  function waitForAssets(content, slide) {
    if (fittingPrint) return false;
    const settling = fontsSettling() || [...content.querySelectorAll("img")].some(imageSettling);
    let wait = assetWaits.get(slide);
    if (!settling) {
      if (wait) { clearTimeout(wait.timer); assetWaits.delete(slide); }
      return false;
    }
    const now = performance.now();
    if (!wait) {
      wait = { since: now, timer: 0 };
      assetWaits.set(slide, wait);
      // Decide at the deadline even if nothing else asks for a fit.
      // A slide that has been left (no box any more) asks for nothing.
      wait.timer = setTimeout(() => {
        wait.timer = 0;
        if (content.isConnected && slide.getBoundingClientRect().width > 0) refit(content);
      }, ASSET_WAIT_MS + 50);
    }
    return now - wait.since < ASSET_WAIT_MS;
  }

  // Print. Browsers fire beforeprint while the screen layout still applies: print media does not
  // match yet and hidden slides have no size. preparePrint therefore puts the document into the
  // layout it prints in, fits every printable slide there, and returns the document to its screen
  // layout before the browser paginates. Paper (deck, single-file export, handout, presenter route)
  // gives every slide its own fixed 1280×720 page canvas (wrapForPaper): the @media print rules are switched on
  // (print → all, screen-only → not all) while fitting, so the fitter's canvas-pixel results hold
  // at any paper size, because the page canvas is scaled uniformly.
  // A slide that fell back to the safe drawing on screen keeps it on paper, and a quote form keeps
  // its fitted step. restorePrint returns the exact screen state and removes the carousel pages; a
  // second beforeprint without an afterprint (a cancelled print in some browsers) restores first,
  // then prepares afresh.
  const PAPER_CANVAS_WIDTH = 1280;
  const authoredFits = new WeakMap();
  let printRestore = null;
  let fittingPrint = false;
  const fitAttributes = ["style", "data-look", "data-title-layout", "data-title-look", "data-split",
    "data-code-fit", "data-list-fit", "data-list-width-fit", "data-nb-join", "data-qf-scaled",
    "data-question-fit", "data-quote-fit", "data-short-word-give-way", "data-statement-fit",
    "data-text-fit", "data-text-too-tall", "data-step",
    // The carousel's fit decisions (fitCarouselCard, cannotFitCarouselCard): restored exactly after a print.
    "data-carousel-dots", "data-carousel-dots-over", "data-carousel-legacy",
    // The look's fit decisions for loops and boxed lists (fitOceanItemLabels, fitOceanLoop, oceanDecide).
    "data-oc-stack", "data-oc-tight", "data-oc-top-beside", "data-oc-last-resort", "data-oc-kept",
    // a QR address part opened for breaking (fitQrCaptions)
    "data-qr-long"];
  const fallbackAttributes = ["data-look", "data-title-layout", "data-split", "data-title-look", "data-oc-last-resort"];
  function saveFit(slide, fitStylesOnly = false) {
    const attributes = fitStylesOnly ? fitAttributes.filter((key) => key !== "style") : fitAttributes;
    const elements = [slide, ...slide.querySelectorAll("*")].map((el) => [el,
      attributes.map((key) => el.getAttribute(key)),
      fitStylesOnly ? { before: el.getAttribute("style") || "", hadStyle: el.hasAttribute("style"), changed: new Map() } : null]);
    const texts = [];
    // The width ladder releases no-break joins in body text as well as titles.
    const walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode());) {
      if (!node.parentElement?.closest("script, style")) texts.push([node, node.data]);
    }
    const restore = () => {
      elements.forEach(([el, values, styles]) => {
        attributes.forEach((key, i) => {
          if (values[i] === null) el.removeAttribute(key); else el.setAttribute(key, values[i]);
        });
        if (!styles) return;
        // Reset only overrides produced by fitting, preserving other runtimes' live styles.
        styles.changed.forEach(([value, priority], key) => {
          if (value) el.style.setProperty(key, value, priority); else el.style.removeProperty(key);
        });
        // An element that had no style attribute is left without one, not with style="".
        if (!styles.hadStyle && !el.getAttribute("style")) el.removeAttribute("style");
      });
      texts.forEach(([node, value]) => {
        // Preserve live content changes; only undo the fitter's space/no-break-space changes.
        if (node.data.replace(/\u00a0/g, " ") === value.replace(/\u00a0/g, " ")) node.data = value;
      });
    };
    const beforeFitStyles = () => elements.filter(([, , styles]) => styles).map(([el, , styles]) =>
      [el, styles, el.getAttribute("style") || ""]);
    const captureFitStyles = (beforeFit) => beforeFit.forEach(([el, styles, cssText]) => {
      if ((el.getAttribute("style") || "") === cssText) return;
      const before = document.createElement("span").style;
      before.cssText = cssText;
      const authored = document.createElement("span").style;
      authored.cssText = styles.before;
      new Set([...Array.from(before), ...Array.from(el.style)]).forEach((key) => {
        const value = before.getPropertyValue(key), priority = before.getPropertyPriority(key);
        if (el.style.getPropertyValue(key) !== value || el.style.getPropertyPriority(key) !== priority) {
          styles.changed.set(key, [authored.getPropertyValue(key), authored.getPropertyPriority(key)]);
        }
      });
    });
    return { restore, beforeFitStyles, captureFitStyles };
  }
  // The document's print rules, switched on for a measurement. Rule media and sheet media are
  // flipped (print → all; screen-only and not-print → not all) and the html element carries
  // tw-print-layout, then everything is put back before this returns.
  function printMediaText(text) {
    const media = text.trim().toLowerCase();
    if (/^(only )?print$/.test(media)) return "all";
    if (/^(only )?print and /.test(media)) return media.replace(/^(only )?print and /, "");
    if (/^(only )?screen$/.test(media) || /^(only )?screen and /.test(media) || media === "not print") return "not all";
    return null;
  }
  function withPrintLayout(fn) {
    const flipped = [];
    const flip = (list) => {
      const next = list && printMediaText(list.mediaText);
      if (next === null || next === undefined) return;
      flipped.push([list, list.mediaText]);
      list.mediaText = next;
    };
    const visit = (rules) => {
      for (const rule of rules) {
        if (rule.media && rule.cssRules) flip(rule.media);
        if (rule.cssRules) visit(rule.cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      try { flip(sheet.media); visit(sheet.cssRules); } catch { /* a sheet whose rules cannot be read */ }
    }
    document.documentElement.classList.add("tw-print-layout");
    try { return fn(); } finally {
      document.documentElement.classList.remove("tw-print-layout");
      for (let i = flipped.length - 1; i >= 0; i -= 1) flipped[i][0].mediaText = flipped[i][1];
    }
  }
  // The look kept after a comparison (oceanDecide's data-oc-kept) and its last resort: paper keeps them too, so the
  // print fit does not compare the two drawings again (near a wrapping boundary it could decide otherwise).
  const keptAttributes = ["data-oc-kept", "data-oc-last-resort"];
  function keepScreenDecisions(slide) {
    const look = slide.dataset.look === "ocean-safe" ? fallbackAttributes.map((key) => slide.getAttribute(key)) : null;
    const kept = slide.dataset.look === "ocean" && slide.hasAttribute("data-oc-kept") ? keptAttributes.map((key) => slide.getAttribute(key)) : null;
    const steps = [...slide.querySelectorAll("figure.qf[data-step]")].map((figure) => [figure, Number(figure.dataset.step) || 0]);
    return () => {
      if (look) fallbackAttributes.forEach((key, i) => { if (look[i] === null) slide.removeAttribute(key); else slide.setAttribute(key, look[i]); });
      if (kept && slide.dataset.look === "ocean") keptAttributes.forEach((key, i) => { if (kept[i] === null) slide.removeAttribute(key); else slide.setAttribute(key, kept[i]); });
      steps.forEach(([figure, step]) => { if (step > (Number(figure.dataset.step) || 0)) figure.dataset.step = String(step); });
    };
  }
  function fitForPrint(content) {
    fittingPrint = true;
    try { return fitContent(content); } finally { fittingPrint = false; }
  }
  // Keep the fitter's new pixel lengths proportional to a canvas `width` px wide: on paper the
  // slide is laid out at another width, and its type (cqw) follows that width. Authored pixel
  // values stay authored; restorePrint returns the screen values.
  function inlineStyles(slide) {
    return [slide, ...slide.querySelectorAll("*")].map((el) =>
      [el, new Map(Array.from(el.style).map((key) => [key, el.style.getPropertyValue(key)]))]);
  }
  function proportionalLengths(styles, width) {
    styles.forEach(([el, before]) => Array.from(el.style).forEach((key) => {
      const value = el.style.getPropertyValue(key);
      if (value === before.get(key) || !value.includes("px")) return;
      el.style.setProperty(key, value.replace(/(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)px\b/gi, (_, px) =>
        `${Number(px) * 100 / width}cqw`), el.style.getPropertyPriority(key));
    }));
  }
  // Carousels print one page per item (the handout's long-standing print, now shared with the deck):
  // each carousel slide is hidden for print and followed by one copy of the slide per item (title
  // and layout repeat; the item's number sits in a corner). An item taller than its page is shrunk
  // to fit, measured on a copy laid out on the slide's own canvas.
  let carouselPages = [];
  function removeCarouselPages() {
    const pages = carouselPages;
    carouselPages = [];
    runEach([...pages.map((page) => () => page.remove()),
      ...[...document.querySelectorAll(".carousel-print-src")].map((el) => () => el.classList.remove("carousel-print-src"))]);
  }
  // The content is laid out in a box 1/s times as large, then scaled by s from its top-left corner.
  function shrinkItemContent(inner, s) {
    if (s >= 1) { inner.style.cssText = ""; return; }
    inner.style.cssText = "width:" + (100 / s) + "%;max-width:none;height:" + (100 / s) + "%;min-height:0;margin:0;transform:scale(" + s + ");transform-origin:0 0";
  }
  function itemShrink(slide, itemIndex) {
    const stage = slide.parentElement;
    if (!stage) return 1;
    const probe = slide.cloneNode(true);
    probe.removeAttribute("data-id");
    probe.classList.add("active");
    probe.querySelectorAll(":scope > .slide-content").forEach((el) => { el.style.zoom = ""; });
    probe.style.cssText += ";visibility:hidden;pointer-events:none;position:absolute;inset:0;display:grid";
    const cards = Array.from(probe.querySelectorAll(".card-gallery.carousel > .card"));
    cards.forEach((card, i) => { if (i !== itemIndex) card.remove(); else { card.classList.add("active-card"); card.classList.remove("is-scrollable", "card-dense"); } });
    stage.appendChild(probe);
    let shrink = 1;
    const card = probe.querySelector(".card-gallery.carousel > .card");
    const inner = card && card.querySelector(":scope > .slide-content");
    // Scale the item's content down until it fits its page, re-measuring after each step (the text reflows).
    for (let step = 0; inner && step < 8; step++) {
      shrinkItemContent(inner, shrink);
      const ratio = inner.scrollHeight > 0 ? inner.clientHeight / inner.scrollHeight : 1;
      if (ratio >= 0.995 || shrink <= 0.45) break;
      shrink = Math.max(0.45, shrink * ratio * 0.97);
    }
    probe.remove();
    return shrink;
  }
  function prepareCarouselPages(root) {
    removeCarouselPages();
    root.querySelectorAll(".stage > .slide").forEach((slide) => {
      const gallery = slide.querySelector(".card-gallery.carousel[data-exclusive]");
      if (!gallery) return;
      const count = gallery.querySelectorAll(":scope > .card").length;
      if (count < 2) return;
      const pages = [];
      for (let i = 0; i < count; i++) {
        const shrink = itemShrink(slide, i);
        const page = slide.cloneNode(true);
        page.removeAttribute("data-id");
        page.classList.remove("active");
        page.classList.add("carousel-print-page");
        page.querySelectorAll(":scope > .slide-content").forEach((el) => { el.style.zoom = ""; });
        const cards = Array.from(page.querySelectorAll(".card-gallery.carousel > .card"));
        cards.forEach((card, k) => { if (k !== i) card.remove(); else { card.classList.add("active-card"); card.classList.remove("is-scrollable", "card-dense"); } });
        const keep = cards[i];
        const inner = keep && keep.querySelector(":scope > .slide-content");
        if (inner) shrinkItemContent(inner, shrink);
        const mark = document.createElement("div");
        mark.className = "carousel-print-count";
        mark.setAttribute("aria-hidden", "true");
        mark.textContent = (i + 1) + " / " + count;
        page.appendChild(mark);
        pages.push(page);
      }
      slide.classList.add("carousel-print-src");
      pages.reduce((after, page) => { after.after(page); return page; }, slide);
      carouselPages.push(...pages);
    });
  }
  // On paper each slide gets its own 1280x720 page canvas (.tw-print-canvas, a size container) as
  // its parent, so the slide keeps every screen rule (its padding, background, rail) and prints as
  // the screen slide scaled, with no reflow. The canvases exist only for the print.
  // A slide moves into its canvas and back with the browser's state-preserving move where there is
  // one (moveBefore): an embedded page is not reloaded and keeps its scroll and state, and the
  // focused control keeps focus. Elsewhere a plain insert (an embedded page then reloads).
  function moveSlide(parent, slide, before) {
    if (typeof parent.moveBefore === "function") {
      try { parent.moveBefore(slide, before); return; } catch (error) { /* not movable in place: insert */ }
    }
    parent.insertBefore(slide, before);
  }
  function wrapForPaper(root) {
    const canvases = [];
    root.querySelectorAll(".stage > .slide:not(.carousel-print-src)").forEach((slide) => {
      const canvas = document.createElement("div");
      canvas.className = "tw-print-canvas";
      slide.before(canvas);
      moveSlide(canvas, slide, null);
      canvases.push([canvas, slide]);
    });
    return () => runEach(canvases.map(([canvas, slide]) => () => {
      if (canvas.isConnected && canvas.parentNode) moveSlide(canvas.parentNode, slide, canvas);
      canvas.remove();
    }));
  }
  // A video on paper (deck, presenter window, handout): its poster, else its current frame, else the
  // placeholder note with the video's name; a <video> prints as a black box or, with controls, as a
  // player. A frame the browser cannot hand over (a video in a hidden slide it never drew comes out
  // fully transparent) counts as none, so a page is never left blank. Added for the print only.
  let printVideos = [];
  function removeVideoStandIns() {
    const videos = printVideos;
    printVideos = [];
    runEach(videos.map(([figure, standIn]) => () => { standIn.remove(); figure.classList.remove("tw-print-video-on"); }));
  }
  function drawnFrame(video) {
    if (!(video.readyState >= 2 && video.videoWidth > 0)) return null;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    try {
      const context = canvas.getContext("2d");
      context.drawImage(video, 0, 0);
      let pixels = null;
      try { pixels = context.getImageData(0, 0, canvas.width, canvas.height).data; } catch (error) { /* another origin: cannot look, keep it */ }
      if (pixels) {
        let seen = false;
        for (let i = 3; i < pixels.length && !seen; i += 4 * 13) seen = pixels[i] > 0;
        if (!seen) return null;
      }
      return canvas;
    } catch (error) { return null; }
  }
  function placeVideoStandIns(root) {
    removeVideoStandIns();
    root.querySelectorAll(".stage > .slide figure.slide-video > video, .stage > .tw-print-canvas > .slide figure.slide-video > video").forEach((video) => {
      const figure = video.parentElement;
      let standIn = null;
      if (video.getAttribute("poster")) {
        standIn = document.createElement("img");
        standIn.src = video.getAttribute("poster");
        standIn.alt = "";
      } else standIn = drawnFrame(video);
      if (!standIn) {
        standIn = document.createElement("div");
        standIn.className = "video-placeholder-note";
        const glyph = document.createElement("span");
        glyph.className = "vp-glyph";
        glyph.textContent = "\u25B6";
        const name = document.createElement("span");
        const src = video.getAttribute("src") || "";
        const ref = video.dataset.videoRef || figure.dataset.videoName || figure.querySelector("figcaption")?.textContent.trim()
          || (src.startsWith("data:") ? "" : src.split(/[\\/]/).pop());
        name.textContent = ref ? "Video: " + ref : "Video";
        standIn.append(glyph, name);
      }
      standIn.classList.add("tw-print-video");
      video.after(standIn);
      figure.classList.add("tw-print-video-on");
      printVideos.push([figure, standIn]);
    });
  }
  // Scroll positions inside the slides on show (a scrolled code block, a panel): the print layout
  // resizes their boxes and the browser's scroll anchoring moves them, so they are put back exactly.
  // A slide with no box (not shown) has no scroll position to keep.
  function saveScrolls(root) {
    const saved = [];
    root.querySelectorAll(".stage > .slide").forEach((slide) => {
      if (!slide.getClientRects().length) return;
      [slide, ...slide.querySelectorAll("*")].forEach((el) => { if (el.scrollTop || el.scrollLeft) saved.push([el, el.scrollTop, el.scrollLeft]); });
    });
    return () => runEach(saved.map(([el, top, left]) => () => {
      if (el.scrollTop !== top) el.scrollTop = top;
      if (el.scrollLeft !== left) el.scrollLeft = left;
    }));
  }
  function preparePrint(root = document) {
    if (printRestore) restorePrint();
    const putScrollsBack = saveScrolls(root);
    const printable = () => [...root.querySelectorAll(".stage > .slide, .stage > .tw-print-canvas > .slide")].map((slide) =>
      [slide, slide.querySelector(":scope > .slide-content")]).filter(([, content]) => content);
    const restores = [];
    const decisions = [];
    // Paper decides afresh from the authored state, never below the screen's own decision.
    printable().forEach(([slide]) => {
      restores.push(saveFit(slide).restore);
      const keep = keepScreenDecisions(slide);
      authoredFits.get(slide)?.restore();
      keep();
    });
    let unwrap = () => {};
    // Each part is restored on its own: one that fails does not stop the others (runEach).
    printRestore = () => runEach([...restores, removeVideoStandIns, () => unwrap(), removeCarouselPages, putScrollsBack]);
    // Carousel pages are cloned from the authored state, before the final pages are fitted.
    prepareCarouselPages(root);
    unwrap = wrapForPaper(root);
    // After the carousel copies (a copied canvas would lose its picture), before the fit.
    placeVideoStandIns(root);
    withPrintLayout(() => printable().forEach(([slide, content]) => {
      if (slide.classList.contains("carousel-print-src")) return;
      const width = slide.clientWidth;
      const styles = inlineStyles(slide);
      decisions.push(fitForPrint(content));
      // Chromium prints the fixed canvas, so canvas pixels hold. A print fallback without the
      // canvas zoom lays the slide out at the paper width instead.
      if (width > 0 && Math.abs(width - PAPER_CANVAS_WIDTH) > 1) proportionalLengths(styles, width);
    }));
    return decisions;
  }
  function restorePrint() {
    const restore = printRestore;
    printRestore = null;
    restore?.();
  }
  // Runs every step even when one throws, then throws the first error (if any).
  function runEach(steps) {
    let failed = null;
    steps.forEach((step) => { try { step(); } catch (error) { if (!failed) failed = { error }; } });
    if (failed) throw failed.error;
  }
  // A page's whole print arrangement (this fitter's, plus the caller's own: the deck's notes and
  // video stand-ins) is held from beforeprint until one idempotent clean-up undoes it. beforeprint
  // undoes any earlier arrangement before preparing anything (a second beforeprint without
  // afterprint), afterprint undoes it, and so, as a last resort when afterprint never arrives (a
  // print abandoned in a way the browser does not report), does the first key press, click
  // or navigation, local or from a peer window (leavePrint), while print media does not match and
  // no print() call of the page's own is under way. The clean-up's steps run one by one: a step
  // that throws does not stop the others, the arrangement counts as undone, and the first error
  // goes to the console.
  let heldPrint = null;
  let ownPrints = 0;
  function endPrint() {
    const steps = heldPrint;
    if (!steps) return false;
    heldPrint = null;
    try { runEach(steps); } catch (error) { if (typeof console !== "undefined") console.error("Print clean-up:", error); }
    return true;
  }
  function leavePrint() {
    if (!heldPrint || ownPrints > 0) return;
    if (typeof window.matchMedia === "function" && window.matchMedia("print").matches) return;
    endPrint();
  }
  // window.print() returns when the print dialog closes; until then the arrangement stays.
  function print() {
    ownPrints++;
    try { window.print(); } finally { ownPrints--; }
  }
  function managePrint(prepare, restoreSteps) {
    const steps = Array.isArray(restoreSteps) ? restoreSteps : [restoreSteps];
    window.addEventListener("beforeprint", () => {
      endPrint();
      heldPrint = steps;
      prepare();
    });
    window.addEventListener("afterprint", endPrint);
    // A key press or a click, in the capture phase: the event's target and path are fixed by then, so
    // the press is still handled, on the restored page. Not pointerdown: moving the slides between a
    // press and its release would lose the click.
    ["keydown", "click"].forEach((type) => window.addEventListener(type, leavePrint, true));
  }

  function fitContent(content, { refresh } = {}) {
    if (!content) return null;
    const slide = content.closest(".slide");
    const box = slide?.getBoundingClientRect();
    if (!box || !(box.width > 0 && box.height > 0)) return null;
    if (!authoredFits.has(slide)) authoredFits.set(slide, saveFit(slide, true));
    const authored = authoredFits.get(slide);
    const before = authored.beforeFitStyles();
    try {
      // A carousel card that cannot be fitted is drawn as 0.44 drew it, prepared (refresh) and fitted again on that
      // drawing exactly as 0.44 fitted it (cannotFitCarouselCard, below).
      delete content.dataset.carouselLegacy;
      const decision = fitMeasuredContent(content);
      if (!cannotFitCarouselCard(content)) return decision;
      markCarouselAs044(content);
      if (refresh) refresh(content);
      return fitMeasuredContent(content);
    } finally {
      authored.captureFitStyles(before);
    }
  }
  // A QR code's address (renderQr: one non-wrapping .qr-part per piece between slashes) is always shown whole. It breaks
  // after a slash; a part that alone is wider than its caption opens its inner break places (after "-", "_", ".", "?",
  // "&", "=", data-qr-long; a part with none that still does not fit breaks where it must). It takes the lines it needs;
  // past three lines it steps its type down, to no less than QR_CAPTION_FLOOR_CQW, before taking more.
  const QR_CAPTION_FLOOR_CQW = 1.2;
  const QR_CAPTION_LINES = 3;
  function qrCaptionLines(caption) {
    const range = document.createRange();
    range.selectNodeContents(caption);
    const tops = [];
    for (const r of rangeRects(range)) {
      if (!(r.width > 0.5 && r.height > 0.5)) continue;
      if (!tops.some((top) => Math.abs(top - r.top) < r.height / 2)) tops.push(r.top);
    }
    return tops.length;
  }
  function markLongQrParts(caption, parts) {
    parts.forEach((part) => delete part.dataset.qrLong);
    const width = caption.getBoundingClientRect().width;
    parts.forEach((part) => { if (part.getBoundingClientRect().width > width + 0.5) part.dataset.qrLong = ""; });
  }
  function fitQrCaptions(content) {
    const slide = content.closest(".slide");
    if (!slide || !/^ocean(-safe)?$/.test(slide.dataset.look || "")) return;
    for (const caption of content.querySelectorAll(".qr-caption")) {
      const parts = [...caption.querySelectorAll(".qr-part")];
      if (!parts.length) continue;
      caption.style.removeProperty("font-size");
      markLongQrParts(caption, parts);
      if (qrCaptionLines(caption) <= QR_CAPTION_LINES) continue;
      // 1cqw where the caption resolves it, in the caption's own px
      const probe = document.createElement("span");
      probe.style.cssText = "position:absolute;visibility:hidden;width:100cqw;height:0";
      caption.appendChild(probe);
      const cqw = probe.offsetWidth / 100;
      probe.remove();
      const floor = cqw * QR_CAPTION_FLOOR_CQW;
      let size = parseFloat(getComputedStyle(caption).fontSize);
      while (size > floor + 0.01 && qrCaptionLines(caption) > QR_CAPTION_LINES) {
        size = Math.max(floor, size * 0.92);
        caption.style.fontSize = `${size}px`;
        markLongQrParts(caption, parts);
      }
    }
  }
  function fitMeasuredContent(content) {
    fitQuotes(content);
    fitCodes(content);
    // Fit the title to its column BEFORE the slide-level autofit, so the zoom factor is
    // computed from the already-fitted layout (a fitted title may remove the need to zoom).
    content.querySelectorAll("h1:not(.sr-only)").forEach((h1) => { h1.style.fontSize = ""; settleTitle(h1); fitTitle(h1); });
    // A long list spends its own slack (leading, gaps, then type to the floor) before the
    // whole-slide zoom is allowed to touch it.
    fitLists(content);
    // ADR-0028 §10: a long statement steps its type down and its panel hugs its lines before the
    // whole-slide zoom may touch it.
    fitStatements(content);
    alignParagraphIcons(content);
    fitQrCaptions(content);
    fitOceanPoster(content);
    fitOceanItemLabels(content);
    fitOceanPanelDetails(content);
    fitOceanLoop(content);
    fitCarouselCard(content);
    // 0.44 Ocean look: fit or fall back, whichever drawing is better (oceanDecide).
    oceanDecide(content);
    // the safe drawing sets its captions at other widths
    if (content.closest(".slide")?.dataset.look === "ocean-safe") fitQrCaptions(content);
    autofitContent(content);
    linkImageClaims(content);
  }
  // A carousel card that cannot be fitted at all is drawn as 0.44 drew it (data-carousel-legacy: none of the band rules
  // apply), so it shows at least what 0.44 showed, and is fitted again the 0.44 way; it stays reported as too long.
  // Every card that can be fitted keeps the band drawing. It cannot be fitted when it is too long (the zoom's report,
  // or a quote or code block in it that its own fit reports too long, after which the zoom stops unreported) and would
  // lose something 0.44 showed: its words reach the dots where they rest, or a box in it (a code panel) now hides part
  // of its own content in the smaller band.
  function cannotFitCarouselCard(content) {
    if (!inTopCarousel(content)) return false;
    const card = activeCarouselCard(content);
    const tooLong = content.dataset.textFit === "too-long"
      || Boolean(card?.querySelector('blockquote[data-quote-fit="too-long"], .slide-code[data-code-fit="too-long"]'));
    return tooLong && ("carouselDotsOver" in content.dataset || cardHidesContent(card));
  }
  function cardHidesContent(card) {
    if (!card) return false;
    for (const el of card.querySelectorAll("*")) {
      if (el.closest("figure, .slot-media")) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || !/hidden|clip/.test(cs.overflowY)) continue;
      if (el.scrollHeight > el.clientHeight + OCEAN_FIT_TOLERANCE) return true;
    }
    return false;
  }
  function markCarouselAs044(content) {
    content.dataset.carouselLegacy = "";
    delete content.dataset.carouselDots;
    delete content.dataset.carouselDotsOver;
    content.style.removeProperty("--carousel-chrome-clear");
    content.style.zoom = "";
    content.querySelectorAll(":scope > .card-gallery.carousel > .card.carousel-subslide > .slide-content").forEach((card) => {
      ["--list-lh", "--list-gap", "--fs-body"].forEach((prop) => card.style.removeProperty(prop));
      delete card.dataset.listFit;
      delete card.dataset.listWidthFit;
    });
  }

  return { fitContent, canvasScale, preparePrint, restorePrint, managePrint, endPrint, leavePrint, print, oceanCompare: { lessThan, sameFaults, safeIsBetter } };
}
