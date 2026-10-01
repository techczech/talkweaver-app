// Slide fitting: the ONE fit pipeline every slide view runs (ADR-0005 floor, ADR-0023, ADR-0028 §5).
// Inlined verbatim (no export) into the presenter template (the SLIDE_FIT_RUNTIME placeholder, so the app's
// presentation, presenter, audience and export all run it) AND into the share page
// (buildShareHtml: the handout and the /p venue screen). SINGLE SOURCE OF TRUTH — see
// 01-cli-utils.slideFitRuntimeSource; scripts/slide-fit-dom.test.mjs tests it at this seam.
//
// Interface: createSlideFit() → { fitContent(content), canvasScale(el) }.
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
function createSlideFit() {
  // The scale between painted and canvas px for the slide holding `el`: the painted width of the
  // slide's canvas (its parent: .stage, a phone row, the full-screen host) over its layout width.
  function canvasScale(el) {
    const slide = el && el.closest ? el.closest(".slide") : null;
    const canvas = slide ? slide.parentElement || slide : null;
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
    range.selectNodeContents(h1);
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
    const stage = slide.parentElement;
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
    root.querySelectorAll(".slide.active .layout-quote > blockquote, .slide.active .image-quote blockquote").forEach(fitQuote);
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
    const stage = slide.parentElement;
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
    root.querySelectorAll(".slide.active .slide-code").forEach(fitCode);
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
  const SMALL_CHROME = ".sr-only, .kicker, .compare-label, .quote-continuation, .code-lang, .poll-frame-eyebrow, .poll-frame-kind, .poll-frame-sep, .poll-frame-chip, .poll-frame-join-note, .qr-caption, .footer, .gallery-nav, .lightbox-nav";
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
  function autofitContent(content) {
    if (!content) return;
    content.style.zoom = "";
    delete content.dataset.textFit;
    delete content.dataset.textTooTall;
    // A quote that still overflows at 31px is reported by the compiler. Whole-slide zoom would
    // silently violate that floor, so leave the exception visible at its accessible type size.
    if (content.querySelector('blockquote[data-quote-fit="too-long"], .slide-code[data-code-fit="too-long"]')) return;
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
    const contentH = content.scrollHeight;
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
    const stage = slide.parentElement;
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
  function fitLists(content) {
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
    const stageWidth = slide.parentElement?.clientWidth || slide.clientWidth;
    // Width first: the size every word fits at is the ceiling the height ladder starts from.
    fitListWords(content, stageWidth);
    const gapMin = content.querySelector(LIST_SPACED_SELECTOR) ? LIST_SPACED_GAP_MIN : LIST_GAP_MIN;
    const cs = getComputedStyle(slide);
    // The band is the slide minus its own padding AND the content column's padding (Ticket 21 gives
    // the sidebar regime's content column 6cqh above and below; stage.css @order 1341).
    const contentStyle = getComputedStyle(content);
    const availH = slide.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
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
    const stage = slide.parentElement;
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

  function fitContent(content) {
    if (!content) return;
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
    autofitContent(content);
  }

  return { fitContent, canvasScale };
}
