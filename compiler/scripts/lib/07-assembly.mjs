import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { scriptDir, slugify, escapeHtml, timerRuntimeSource, overviewRuntimeSource, markmapVendorSource } from "./01-cli-utils.mjs";
import { accentForSectionIndex, accentForSectionName, titlePlacementFor, renderInline } from "./02-triggers-layout.mjs";
import { findSlideSections, updateDeckTitle, withoutScripts } from "./04-html-extraction.mjs";
import { createIconVocabulary, buildDeckIconMap } from "./05-icons.mjs";
import { groupImageRows, groupQrRows, groupActionBlocks, renderBlock, renderBlocks } from "./06-block-renderers.mjs";
import { renderLicenseBody } from "./08-source-adapters.mjs";

// =============================================================================
// 7. Slide & presentation assembly — renderModelSlides, template splice (buildDeckHtmlFromModel)
// =============================================================================

function normalizeNotes(value) {
  if (!value) return "";
  if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? item : item.text || item.content || "").filter(Boolean).map(escapeHtml).join("<br>");
  if (typeof value === "object" && value.html) return withoutScripts(value.html);
  if (typeof value === "object") return escapeHtml(value.text || value.content || "");
  return escapeHtml(value);
}

// ADR-0022 carousel: render the inner CONTENT of one slide-like object — the
// `<div class="slide-content layout-X">…head…body…</div>` plus any pulled-out corner QR — WITHOUT
// the wrapping <section>. Used twice: once per real slide (the <section> wraps the return below),
// and once per CAROUSEL SUB-SLIDE (each sub-slide runs through this same full layout pipeline so it
// renders FULL-BLEED via inferLayout + the normal block renderers, NOT card-chrome). The sub-slide
// is then wrapped in the existing data-exclusive stepping container as a `.card.carousel-subslide`.
function renderSlideContent(slide, deckUsed) {
    const usesHtmlBody = Boolean(slide.html);
    const layoutSlug = slugify(slide.layout || "list") || "list";
    // Title placement (2026-06-09 title spec): left rail (35/65 default) for content layouts, top
    // bar for wide layouts; {titletop}/{split} override. Stamped as data-title-layout / data-split
    // so ONE set of template rules positions the title across every layout. Structural/centred and
    // self-columned layouts return mode "" and are left to their own treatment.
    const titlePlacement = titlePlacementFor({
      layout: layoutSlug,
      attrs: { titletop: slide.titleTop === true, split: slide.split || "" },
      timelineHorizontal: slide.timelineHorizontal === true,
    });
    // I1 (Wave-1 review): {title=side} must force the sidebar rail on ANY layout, not only
    // TITLE_LEFT_LAYOUTS. titlePlacementFor decides from the layout name and never sees frame.title,
    // so layouts that default to top/centre return mode "" or "top". Override here: if the author
    // explicitly wrote {title=side}, stamp mode "left" so data-title-layout="left" is emitted and
    // the rail renders. "off" and "top" fall through untouched.
    if (slide.frame?.title === "side") titlePlacement.mode = "left";
    // 2026-07-08: an EXPLICIT {title=top} likewise forces the top bar on any layout (quote and
    // other left-rail defaults included). frameTitleExplicit distinguishes it from the builtin
    // "top" default, which must keep falling through to each layout's own treatment.
    if (slide.frameTitleExplicit && slide.frame?.title === "top") titlePlacement.mode = "top";
    // D5: on a cards-layout slide, a leading prose paragraph is a source/citation reference
    // for the gallery (e.g. "Turing, Alan M. *Intelligent Machinery*. … https://…"). It must
    // read BELOW the gallery as a small muted line, not above it. Pull such paragraph blocks
    // out of the normal body flow and re-emit them as a .slide-source footer after the cards.
    // Media (image/embed/video) and all other block types stay in place.
    let sourceHtml = "";
    let bodyBlocks = slide.blocks;
    if (!usesHtmlBody && layoutSlug === "cards" && Array.isArray(slide.blocks)) {
      const sourceBlocks = slide.blocks.filter((b) => b && b.type === "paragraph");
      if (sourceBlocks.length) {
        bodyBlocks = slide.blocks.filter((b) => !(b && b.type === "paragraph"));
        sourceHtml = `\n<p class="slide-source">${sourceBlocks.map((b) => renderInline(b.text ?? "")).join("<br>")}</p>`;
      }
    }
    // D7: a cards-layout slide can carry leading media (image/embed/video) in its body that
    // belongs WITH the whole gallery — e.g. a newsreel clip above two quote cards. Stacking
    // the media above the gallery cuts the quote off. Instead lay the media and the gallery
    // side-by-side: media in a left column, the card gallery in a right column. Detected here
    // (cards layout + ≥1 media body block + a cards block) and wrapped in .cards-media-split.
    const MEDIA_BLOCK_TYPES = new Set(["image", "embed", "video"]);
    let cardsMediaSplit = false;
    if (!usesHtmlBody && layoutSlug === "cards" && Array.isArray(bodyBlocks)) {
      const hasMedia = bodyBlocks.some((b) => b && MEDIA_BLOCK_TYPES.has(b.type));
      const hasGallery = bodyBlocks.some((b) => b && b.type === "cards");
      cardsMediaSplit = hasMedia && hasGallery;
    }
    // F1: list-visual — split media and feature-list into two columns inside .lv-body.
    // The .slide-head (title/kicker) lives outside as a full-width row above the body.
    let listVisual = false;
    if (!usesHtmlBody && layoutSlug === "list-visual" && Array.isArray(bodyBlocks)) {
      const hasMediaBlk = bodyBlocks.some((b) => b && MEDIA_BLOCK_TYPES.has(b.type));
      const hasListBlk = bodyBlocks.some((b) => b && (b.type === "feature-list" || b.type === "list"));
      listVisual = hasMediaBlk && hasListBlk;
    }
    // copy-visual: keep every media node in one column and every text/table node in the other.
    // Direct grid children used to place a paragraph and a table in the same explicit cell, so
    // mixed copy literally overlapped. The wrappers make each column a normal vertical flow.
    let copyVisual = false;
    if (!usesHtmlBody && layoutSlug === "copy-visual" && Array.isArray(bodyBlocks)) {
      const hasMediaBlk = bodyBlocks.some((b) => b && MEDIA_BLOCK_TYPES.has(b.type));
      const hasCopyBlk = bodyBlocks.some((b) => b && !MEDIA_BLOCK_TYPES.has(b.type));
      copyVisual = hasMediaBlk && hasCopyBlk;
    }
    // Fix 1: timeline-visual — a timeline (graphical element) beside a comment (paragraph/quote).
    // The timeline fills the left column, the comment the right, the pair vertically centred.
    // Below 950px the columns stack (CSS). Same column grammar as list-visual (.tv-body grid).
    let timelineVisual = false;
    if (!usesHtmlBody && layoutSlug === "timeline-visual" && Array.isArray(bodyBlocks)) {
      const hasTl = bodyBlocks.some((b) => b && b.type === "timeline");
      const hasComment = bodyBlocks.some((b) => b && (b.type === "paragraph" || b.type === "quote"));
      timelineVisual = hasTl && hasComment;
    }
    // SD-14 (Task 4): image-beside-content split. When the slide has exactly one image block and
    // at least one non-image block, AND frame.image was explicitly authored ({image=left|right}),
    // wrap them in a .split container. The image sits in .media (42% flex), the rest in .copy
    // (vertically centred). Side is controlled by frame.image: "right" → .media-right (image on
    // right, copy on left), "left" → .media-left (image left, copy right via row-reverse). Uses
    // slide.frameImageExplicit to avoid forcing a split on pre-existing slides with mixed content.
    let mediaSplit = false;
    if (!usesHtmlBody && slide.frameImageExplicit && Array.isArray(bodyBlocks)) {
      const imageBlocks = bodyBlocks.filter((b) => b && b.type === "image");
      const nonImageBlocks = bodyBlocks.filter((b) => b && b.type !== "image");
      mediaSplit = imageBlocks.length === 1 && nonImageBlocks.length >= 1;
    }
    // {columns} / {2col} / {3col}: lay the slide's top-level content nodes side by side in N equal
    // columns. N = explicit {cols=2|3} (from {2col}/{3col}) else auto from the distributable block
    // count (clamped 2..4). Blocks are dealt across the columns in document order, balanced so
    // earlier columns never trail later ones. Per-column vertical alignment (the columns rule):
    // a column whose content is purely image/video/paragraph aligns MIDDLE (vertically centred);
    // a column carrying any text-structural node (subheading / feature-list / list) aligns TOP.
    let columnsLayout = false;
    // 2026-07-08: an explicit {cols=N} / {2col} / {3col} forces the column split on ANY layout,
    // not only layout=columns — e.g. {layout=code 2col} deals the paragraph and the code block
    // into two columns. (Previously the cols attr was swallowed whenever an explicit layout won
    // the layout key, so {2col} silently did nothing next to {layout=…}.)
    const colsExplicit = slide.colsCount != null && String(slide.colsCount).trim() !== "";
    if (!usesHtmlBody && Array.isArray(bodyBlocks) && (layoutSlug === "columns" || colsExplicit)) columnsLayout = true;
    // SD-10 (Task 5): frame.icons is the universal icon-level control for this slide.
    // Threaded into all block renders so the feature-list renderer can compute effectiveIcons.
    const frameIcons = slide.frame?.icons ?? "off";
    // SD-16 (Task 6): statement-beside-list layout. A paragraph block becomes the .stmt column
    // (the claim, left-border accent bar = text height, serif font); the remaining blocks form
    // the .list-side column. align-items:center on .stmt-list means the accent bar = text height.
    let stmtListLayout = false;
    if (!usesHtmlBody && layoutSlug === "stmt-list" && Array.isArray(bodyBlocks)) {
      const hasPara = bodyBlocks.some((b) => b && b.type === "paragraph");
      const hasListBlock = bodyBlocks.some((b) => b && (b.type === "feature-list" || b.type === "list"));
      stmtListLayout = hasPara && hasListBlock;
    }
    let bodyHtml;
    if (stmtListLayout) {
      const paraBlocks = bodyBlocks.filter((b) => b && b.type === "paragraph");
      const listBlocks = bodyBlocks.filter((b) => b && b.type !== "paragraph");
      const stmtInner = paraBlocks.map((b) => renderBlock(b, deckUsed, frameIcons)).filter(Boolean).join("");
      const listInner = renderBlocks(listBlocks, "", deckUsed, frameIcons);
      bodyHtml = `<div class="stmt-list"><div class="stmt">${stmtInner}</div><div class="list-side">${listInner}</div></div>`;
    } else if (mediaSplit) {
      const imageBlocks = bodyBlocks.filter((b) => b && b.type === "image");
      const copyBlocks = bodyBlocks.filter((b) => b && b.type !== "image");
      const mediaHtml = renderBlock(imageBlocks[0], deckUsed, frameIcons);
      const copyInner = renderBlocks(copyBlocks, "", deckUsed, frameIcons);
      // frame.image "right" → image on right (media-right), "left" → image on left (media-left).
      // CSS uses flex-direction:row for media-right and row-reverse for media-left.
      const side = slide.frame?.image === "right" ? "media-right" : "media-left";
      const alignTop = slide.frame?.align === "top" ? " align-top" : "";
      bodyHtml = `<div class="split ${side}${alignTop}"><div class="media">${mediaHtml}</div><div class="copy">${copyInner}</div></div>`;
    } else if (columnsLayout) {
      const distributable = bodyBlocks.filter(Boolean);
      const explicit = Number.parseInt(slide.colsCount, 10);
      const n = Number.isFinite(explicit) && explicit >= 1
        ? explicit
        : Math.min(4, Math.max(2, distributable.length || 2));
      // Deal blocks into N CONTIGUOUS chunks (not round-robin) so a subheading stays with the
      // list/figure that follows it: column boundaries fall BETWEEN document-order groups. Spread
      // the remainder across the leading columns so sizes differ by at most one block.
      const cols = Array.from({ length: n }, () => []);
      const total = distributable.length;
      const base = Math.floor(total / n);
      const extra = total % n;
      let cursor = 0;
      for (let c = 0; c < n; c += 1) {
        const take = base + (c < extra ? 1 : 0);
        cols[c] = distributable.slice(cursor, cursor + take);
        cursor += take;
      }
      // MIDDLE alignment when a column holds only image/video/paragraph nodes; TOP when it carries
      // any structural text (subheading / list / feature-list / quote / timeline / smartart …).
      const MIDDLE_TYPES = new Set(["image", "image-row", "video", "embed", "paragraph"]);
      const colHtml = cols.map((colBlocks) => {
        if (!colBlocks.length) return `<div class="col col-empty"></div>`;
        const middle = colBlocks.every((b) => b && MIDDLE_TYPES.has(b.type));
        const inner = groupActionBlocks(groupQrRows(groupImageRows(colBlocks)))
          .map((b) => renderBlock(b, deckUsed, frameIcons)).filter(Boolean).join("\n");
        return `<div class="col col-align-${middle ? "middle" : "top"}">${inner}</div>`;
      }).join("");
      bodyHtml = `<div class="columns-grid columns-${n}">${colHtml}</div>`;
    } else if (cardsMediaSplit) {
      const mediaBlocks = bodyBlocks.filter((b) => b && MEDIA_BLOCK_TYPES.has(b.type));
      const otherBlocks = bodyBlocks.filter((b) => !(b && MEDIA_BLOCK_TYPES.has(b.type)));
      const mediaHtml = groupImageRows(mediaBlocks).map((b) => renderBlock(b, deckUsed, frameIcons)).filter(Boolean).join("\n");
      const galleryHtml = renderBlocks(otherBlocks, "", deckUsed, frameIcons);
      bodyHtml = `<div class="cards-media-split"><div class="cards-media-col">${mediaHtml}</div><div class="cards-gallery-col">${galleryHtml}</div></div>`;
    } else if (listVisual) {
      const mediaBlocks = bodyBlocks.filter((b) => b && MEDIA_BLOCK_TYPES.has(b.type));
      const listBlocks = bodyBlocks.filter((b) => b && !MEDIA_BLOCK_TYPES.has(b.type));
      const listHtml = listBlocks.map((b) => renderBlock(b, deckUsed, frameIcons)).filter(Boolean).join("\n");
      const mediaHtml = groupImageRows(mediaBlocks).map((b) => renderBlock(b, deckUsed, frameIcons)).filter(Boolean).join("\n");
      bodyHtml = `<div class="lv-body"><div class="lv-list">${listHtml}</div><div class="lv-media">${mediaHtml}</div></div>`;
    } else if (copyVisual) {
      const mediaBlocks = bodyBlocks.filter((b) => b && MEDIA_BLOCK_TYPES.has(b.type));
      const copyBlocks = bodyBlocks.filter((b) => b && !MEDIA_BLOCK_TYPES.has(b.type));
      const mediaHtml = groupImageRows(mediaBlocks).map((b) => renderBlock(b, deckUsed, frameIcons)).filter(Boolean).join("\n");
      const copyHtml = renderBlocks(copyBlocks, "", deckUsed, frameIcons);
      bodyHtml = `<div class="cv-body"><div class="cv-media">${mediaHtml}</div><div class="cv-copy">${copyHtml}</div></div>`;
    } else if (timelineVisual) {
      // Timeline (graphical) one column, comment (.content-p / quote) the other. The timeline
      // keeps its full block markup (rail/columns/compact + .tl-entries) so MODE_SELECTOR steps
      // its entries exactly as in the single-column timeline layout (Fix 4 stays satisfied here).
      const tlBlocks = bodyBlocks.filter((b) => b && b.type === "timeline");
      const commentBlocks = bodyBlocks.filter((b) => b && b.type !== "timeline");
      const tlHtml = tlBlocks.map((b) => renderBlock(b, deckUsed, frameIcons)).filter(Boolean).join("\n");
      const commentHtml = renderBlocks(commentBlocks, "", deckUsed, frameIcons);
      bodyHtml = `<div class="tv-body"><div class="tv-timeline">${tlHtml}</div><div class="tv-comment">${commentHtml}</div></div>`;
    } else {
      bodyHtml = usesHtmlBody ? withoutScripts(slide.html) : renderBlocks(bodyBlocks, slide.body || "", deckUsed, frameIcons);
    }
    bodyHtml += sourceHtml;
    const blocksHaveHeading = Array.isArray(slide.blocks)
      && slide.blocks.some((b) => b && typeof b === "object" && (b.type === "heading" || b.type === "title"));
    const slideTitle = String(slide.title ?? "");
    const showTitle = !usesHtmlBody && !blocksHaveHeading && slideTitle.trim() !== "";
    const layout = layoutSlug;
    // D4: on cards (multi-subslide) slides the big h1 is navigation-only — demote it to a
    // compact eyebrow on the kicker line so the card gallery owns the stage. Authoring can
    // opt back into the big title with {title=show}; default for cards is compact.
    // D7: copy-visual slides (single media + text laid side-by-side) take the same compact
    // eyebrow so the two columns own the stage — exactly the logic galleries already use.
    const compactByLayout = layout === "cards" || layout === "copy-visual";
    const titleMode = slide.titleMode === "show" ? "show"
      : slide.titleMode === "compact" ? "compact"
      : (compactByLayout ? "compact" : "show");
    const compactTitle = compactByLayout && titleMode !== "show" && showTitle;
    // QUOTE DEFAULT = NO TITLE DRAWN (2026-06-08; html-presentations-p1 step 2). A quote slide is
    // the quote + attribution, full-bleed; the heading is NAV-ONLY (kept as an sr-only h1 so
    // overview/nav fallbacks that read h1 still work, but not painted). `{title=show}` opts the
    // visible heading back in. (Uses the RAW authored titleMode, not the resolved one, because the
    // resolved default is "show" for non-cards/copy-visual layouts.)
    // Hide the on-slide heading (nav-only sr-only h1) when:
    //   • quote layout's no-title default (2026-06-08), unless {title=show}, OR
    //   • {notitle} is set on the slide (2026-06-09) — the headline case is the title-less
    //     STATEMENT (full-bleed statement, heading nav-only), mirroring quote-no-title. {title=show}
    //     still wins so an author can always force the heading back.
    const hideByQuoteDefault = (layout === "quote" || layout === "image-quote" || layout === "compare") && slide.titleMode !== "show";
    const hideByNotitle = slide.noTitle === true && slide.titleMode !== "show";
    // Task 3 (Wave 1): frame.title drives placement/visibility as an ADDITIONAL override on top of
    // the layout defaults. `frame.title === "off"` hides the title (same as hideByNotitle). `"side"`
    // forces the sidebar rail regardless of layout (wins over quote/notitle defaults — author
    // explicitly asked for it). `"top"` falls through to the existing logic.
    const frameTitle = slide.frame?.title ?? "top";
    const authorForcesRail = frameTitle === "side";
    // 2026-07-08: an explicit {title=top} shows the title too — same override as side.
    const authorForcesTop = slide.frameTitleExplicit === true && frameTitle === "top";
    const hideTitleByFrame = frameTitle === "off" && slide.titleMode !== "show";
    // 2026-07-08: a BODYLESS {statement} slide — the heading IS the statement. Promote the
    // title text into the body as the statement paragraph (full-width, big serif via
    // .layout-statement > p) and demote the heading to nav-only (sr-only h1), so it renders
    // exactly as if the same text were authored as a paragraph. The quiet head collapses the
    // left rail (CSS :has(.slide-head-quiet)) → the statement spans the whole slide. An
    // explicit {title=side|top} or {title=show} keeps the plain heading treatment instead.
    const statementFromTitle = layout === "statement" && showTitle
      && (bodyHtml.trim() === "" || bodyHtml === "<p></p>")
      && !authorForcesRail && !authorForcesTop && slide.titleMode !== "show";
    if (statementFromTitle) bodyHtml = `<p>${escapeHtml(slideTitle)}</p>`;
    // When frame.title=side or an explicit top, skip layout-driven hide (the author asked for it).
    const hideTitleByLayout = statementFromTitle
      || (!authorForcesRail && !authorForcesTop && (hideByQuoteDefault || hideByNotitle || hideTitleByFrame) && showTitle);
    const kickerText = slide.kicker ? escapeHtml(slide.kicker) : "";
    // 2026-07-08: the blue "sidebar" panel is retired — frame.title === "side" now renders the
    // PLAIN left rail (data-title-layout="left" only). Legacy {titlestyle=sidebar} still stamps
    // the attr, but no CSS paints it.
    const effectiveTitleStyle = slide.titleStyle || "";
    let headHtml;
    if (hideTitleByLayout) {
      // Nav-only heading: sr-only h1 stays in the DOM; nothing is drawn on the slide.
      headHtml = `<header class="slide-head slide-head-quiet"><h1 class="sr-only">${escapeHtml(slideTitle)}</h1></header>\n`;
    } else if (compactTitle) {
      // Quiet single eyebrow line: SECTION KICKER · Slide title. The title part keeps the
      // big h1 in the DOM (sr-only) so nav fallbacks / overview that read h1 still work.
      const eyebrow = kickerText
        ? `<span class="kicker-eyebrow">${kickerText}</span><span class="kicker-sep" aria-hidden="true"> · </span>`
        : "";
      headHtml = `<header class="slide-head slide-head-compact"><p class="kicker kicker-compact">${eyebrow}<span class="kicker-title">${escapeHtml(slideTitle)}</span></p><h1 class="sr-only">${escapeHtml(slideTitle)}</h1></header>\n`;
    } else {
      const kickerHtml = kickerText ? `<p class="kicker">${kickerText}</p>` : "";
      const titleHtml = showTitle ? `<h1>${escapeHtml(slideTitle)}</h1>` : "";
      headHtml = (kickerHtml || titleHtml) ? `<header class="slide-head">${kickerHtml}${titleHtml}</header>\n` : "";
      if (showTitle && bodyHtml === "<p></p>") bodyHtml = "";
    }
    if ((compactTitle || hideTitleByLayout) && bodyHtml === "<p></p>") bodyHtml = "";
    // QR overhaul (refinement 6, 2026-06-09): a corner QR is pinned to the BOTTOM-LEFT of the
    // SLIDE, not placed in the content flow. Pull any `.slide-qr-corner` figures OUT of the body and
    // emit them as direct children of the <section> (siblings of .slide-content), so they are not
    // clipped/zoomed by the autofit'd content box and always sit in the corner. The body text/title
    // lay out as if the QR were not there.
    const cornerQr = [];
    bodyHtml = bodyHtml.replace(/<figure class="slide-figure slide-qr slide-qr-corner[\s\S]*?<\/figure>/g, (m) => {
      cornerQr.push(m);
      return "";
    });
    const cornerQrHtml = cornerQr.join("\n");
    // Task 3 (SD-8): section corner label. When frame.section === "corner" and the slide carries a
    // section heading, render a quiet top-right label. aria-hidden because it is purely decorative
    // context — the section is already communicated through data-section on the <section> element.
    const cornerSectionHtml = (slide.frame?.section === "corner" && slide.section)
      ? `<div class="corner-section" aria-hidden="true">${escapeHtml(slide.section)}</div>`
      : "";
    const statementVariantClass = layout === "statement" && (slide.statementVariant === "tint" || slide.statementVariant === "poster")
      ? ` statement-${slide.statementVariant}`
      : "";
    const contentHtml = `<div class="slide-content layout-${escapeHtml(layout)}${statementVariantClass}">
${headHtml}${bodyHtml}
  </div>`;
    return { contentHtml, cornerQrHtml, cornerSectionHtml, layout, titlePlacement, effectiveTitleStyle };
}

// ADR-0022 carousel: render one carousel sub-slide as a FULL-BLEED frame inside the existing
// data-exclusive stepping container. Each sub-slide reuses renderSlideContent (so its content runs
// through inferLayout + the normal block renderers), wrapped as a `.card.carousel-subslide` so the
// runtime's applyExclusiveCards steps it exactly like a gallery card — but with NO card-chrome
// (the CSS strips the panel border/padding to leave a real full-bleed slide). The first sub-slide
// carries `active-card` so it shows on arrival.
function renderCarouselSubSlide(subSlide, deckUsed, isFirst, subIndex) {
  const { contentHtml } = renderSlideContent(subSlide, deckUsed);
  // Every sub-slide except the first carries data-fragment — the SAME contract a stepped
  // card-gallery uses (06-block-renderers `fragmentAttr`). The runtime's next()/previous()
  // count [data-fragment] units to know how many in-slide steps precede crossing to the next
  // slide; without it fragments().length is 0 and plain "Next" jumps straight past the carousel
  // (reveal/focus modes stepped fine because they walk the [data-exclusive] gallery directly).
  // The first sub-slide is visible on arrival (active-card, reveal 0) so it is not a fragment.
  const fragmentAttr = isFirst ? "" : " data-fragment";
  // Carousel children are real content the map must show; ADR-0022 made them sub-slides.
  const subAttrs = ` data-sub-title="${escapeHtml(String(subSlide.title ?? ""))}" data-sub-index="${subIndex}"`;
  return `<div class="card carousel-subslide${isFirst ? " active-card" : ""}"${subAttrs}${fragmentAttr}>${contentHtml}</div>`;
}

// SD-17: render collected deck links as a plain feature-list of clickable URLs.
function renderLinksBlock(deckLinks) {
  if (!Array.isArray(deckLinks) || !deckLinks.length) return "";
  const items = deckLinks.map(({ text, url }) => {
    const safeUrl = escapeHtml(url);
    const safeText = escapeHtml(text);
    return `<li><span class="fl-text"><a href="${safeUrl}" target="_blank" rel="noopener">${safeText}</a> — <span class="link-url">${safeUrl}</span></span></li>`;
  }).join("\n");
  return `<ul class="feature-list fl-plain fl-wide">\n${items}\n</ul>`;
}

function renderModelSlides(slides, palette = "", deckIcons = null, deckLinks = null) {
  // Assign a cycling accent per section (in first-seen order) so each section
  // reads as a distinct movement; every accent-driven CSS device keys off --accent.
  // The deck `palette` ({palette:green}) selects which section-accent cycle to use.
  const sectionOrder = [];
  const accentBySection = new Map();
  for (const slide of slides) {
    const key = slide.section || "";
    if (!accentBySection.has(key)) {
      accentBySection.set(key, accentForSectionName(slide.sectionAccent, palette) || accentForSectionIndex(sectionOrder.length, palette));
      sectionOrder.push(key);
    }
  }
  // v3 (revised 2026-06-09): deck-level concept→icon VOCABULARY. Threaded through every block so
  // the same concept reuses the same glyph deck-wide (consistency); distinct concepts stay
  // distinct. Logos never touch it. See assignFeatureIconsV3 / decideFeatureListStyle.
  // A deck `icons:` block (Layer 2) rides on the vocabulary as an override map.
  const deckUsed = createIconVocabulary(buildDeckIconMap(deckIcons));
  return slides.map((slide, index) => {
    const id = slide.id || `slide-${index + 1}`;
    // Per-section skin (ADR-0005): accentForSectionIndex now returns { accent, tint }. Stamp
    // --accent (back-compat: accent-driven CSS still reads --accent directly) PLUS the new
    // --sec-accent/--sec-tint so :root's `--accent: var(--sec-accent,…)` / `--tint: var(--sec-tint,…)`
    // resolve per section and the tint reaches sidebars/panels/boxes.
    const sectionSkin = accentBySection.get(slide.section || "") || null;
    const styleDeclarations = sectionSkin
      ? [`--accent: ${sectionSkin.accent}`, `--sec-accent: ${sectionSkin.accent}`, `--sec-tint: ${sectionSkin.tint}`]
      : [];
    if (slide.backgroundTint) {
      styleDeclarations.push(`--slide-bg: ${slide.backgroundTint}`, "background: var(--slide-bg)");
    }
    const accentStyle = styleDeclarations.length ? ` style="${styleDeclarations.join("; ")}"` : "";
    const title = slide.navTitle || slide.title || id;
    const section = slide.section || "";
    const subsection = slide.subsection || "";
    const role = slide.role || "content";
    const authoredMode = slide.mode === "reveal" || slide.mode === "focus" ? slide.mode : "";
    const preparesFor = slide.prepares_for || slide.preparesFor || "";
    const notes = normalizeNotes(slide.notes);

    // Container-mode renderings (ADR-0007, Task 6): a section carrying a grid/contents container
    // trigger stamps its mode + ORDERED direct-child ids (projected in 08-source-adapters, where
    // the tree node is still attached) so the presenter runtime can paint the Card Table / rail /
    // strip. The runtime prefers deriving children from the beat stream (grid-zoom grid-return
    // completed lists; contents child context), but grid-linear has neither, so this build-time
    // list is the authoritative fallback.
    const containerAttrs = slide.containerMode
      ? ` data-container-mode="${escapeHtml(slide.containerMode)}"${slide.containerVariant === "strip" ? ' data-contents-variant="strip"' : ""}${Array.isArray(slide.containerChildIds) && slide.containerChildIds.length ? ` data-child-ids="${escapeHtml(slide.containerChildIds.join(" "))}"` : ""}`
      : "";

    // ADR-0022 CAROUSEL: a slide carrying `carousel` sub-slides (#### cards or {carousel}) renders
    // its body as the existing data-exclusive stepping container, with each sub-slide a full-bleed
    // frame. The parent <section> keeps the slide's section/role/data-layout="carousel"; the parent
    // heading is shared context (the eyebrow + the TalkWeaver strip group label), so the carousel's
    // own slide head shows the parent title as a quiet compact eyebrow above the stepped frames.
    if (Array.isArray(slide.carousel) && slide.carousel.length) {
      const layout = "carousel";
      const subHtml = slide.carousel
        .map((sub, subIdx) => renderCarouselSubSlide(sub, deckUsed, subIdx === 0, subIdx))
        .join("\n");
      const slideTitle = String(slide.title ?? "");
      const showHead = slideTitle.trim() !== "" && slide.titleMode !== "show-bigtitle";
      const kickerText = slide.kicker ? escapeHtml(slide.kicker) : "";
      // Shared-context eyebrow: SECTION KICKER · parent slide title (mirrors slide-head-compact).
      const eyebrow = kickerText
        ? `<span class="kicker-eyebrow">${kickerText}</span><span class="kicker-sep" aria-hidden="true"> · </span>`
        : "";
      const headHtml = showHead
        ? `<header class="slide-head slide-head-compact"><p class="kicker kicker-compact">${eyebrow}<span class="kicker-title">${escapeHtml(slideTitle)}</span></p><h1 class="sr-only">${escapeHtml(slideTitle)}</h1></header>\n`
        : "";
      // Leading prose paragraph(s) before the first #### are the carousel's shared source/citation
      // line — re-emitted as a quiet .slide-source BELOW the stepped frames (the cards-source pass).
      const sourceBlocks = Array.isArray(slide.blocks)
        ? slide.blocks.filter((b) => b && b.type === "paragraph")
        : [];
      const sourceHtml = sourceBlocks.length
        ? `\n<p class="slide-source">${sourceBlocks.map((b) => renderInline(b.text ?? "")).join("<br>")}</p>`
        : "";
      const contentHtml = `<div class="slide-content layout-carousel">
${headHtml}<div class="card-gallery carousel" data-exclusive>${subHtml}</div>${sourceHtml}
  </div>`;
      return `<section class="slide" data-id="${escapeHtml(id)}" data-section="${escapeHtml(section)}" data-subsection="${escapeHtml(subsection)}" data-role="${escapeHtml(role)}" data-layout="${escapeHtml(layout)}" data-carousel data-nav-title="${escapeHtml(title)}"${authoredMode ? ` data-mode="${escapeHtml(authoredMode)}"` : ""}${preparesFor ? ` data-prepares-for="${escapeHtml(preparesFor)}"` : ""}${slide.noStep ? " data-nostep" : ""}${slide.noValues ? " data-novalues" : ""}${slide.fontBody ? ` data-font-body="${slide.fontBody}"` : ""}${slide.fontTitle ? ` data-font-title="${slide.fontTitle}"` : ""}${accentStyle}>
  ${contentHtml}
  ${notes ? `<aside class="notes">${notes}</aside>` : ""}
</section>`;
    }

    let { contentHtml, cornerQrHtml, cornerSectionHtml, layout, titlePlacement, effectiveTitleStyle } = renderSlideContent(slide, deckUsed);
    // SD-17: for a links-layout slide, append the deck link list into the content HTML (inside
    // the .slide-content div, after the authored blocks but before the closing </div>).
    if (layout === "links" && Array.isArray(deckLinks) && deckLinks.length) {
      const linksHtml = renderLinksBlock(deckLinks);
      contentHtml = contentHtml.replace(/(\s*<\/div>\s*)$/, `\n${linksHtml}$1`);
    }
    return `<section class="slide" data-id="${escapeHtml(id)}" data-section="${escapeHtml(section)}" data-subsection="${escapeHtml(subsection)}" data-role="${escapeHtml(role)}" data-layout="${escapeHtml(layout)}" data-nav-title="${escapeHtml(title)}"${authoredMode ? ` data-mode="${escapeHtml(authoredMode)}"` : ""}${preparesFor ? ` data-prepares-for="${escapeHtml(preparesFor)}"` : ""}${slide.noStep ? " data-nostep" : ""}${slide.noValues ? " data-novalues" : ""}${slide.fontBody ? ` data-font-body="${slide.fontBody}"` : ""}${slide.fontTitle ? ` data-font-title="${slide.fontTitle}"` : ""}${slide.countdownSeconds ? ` data-countdown="${slide.countdownSeconds}" data-countdown-style="${slide.countdownStyle || "digits"}"` : ""}${slide.sectionTimerSeconds ? ` data-section-timer="${slide.sectionTimerSeconds}" data-section-timer-show="${slide.sectionTimerShow || "presenter"}"` : ""}${slide.remindText ? ` data-remind="${escapeHtml(slide.remindText)}"${slide.remindAtMinutes != null ? ` data-remind-at="${slide.remindAtMinutes}"` : ""}${slide.remindInSeconds != null ? ` data-remind-in="${slide.remindInSeconds}"` : ""}` : ""}${titlePlacement.mode ? ` data-title-layout="${titlePlacement.mode}"` : ""}${effectiveTitleStyle ? ` data-title-style="${escapeHtml(effectiveTitleStyle)}"` : ""}${titlePlacement.split ? ` data-split="${titlePlacement.split}"` : ""}${containerAttrs}${accentStyle}>
  ${contentHtml}
${cornerQrHtml ? `  ${cornerQrHtml}\n` : ""}${cornerSectionHtml ? `  ${cornerSectionHtml}\n` : ""}  ${notes ? `<aside class="notes">${notes}</aside>` : ""}
</section>`;
  }).join("\n\n");
}

function replaceSlideSections(templateHtml, slideMarkup) {
  const matches = findSlideSections(templateHtml);
  if (matches.length === 0) throw new Error("Starter template has no slide sections to replace.");
  const first = matches[0];
  const last = matches[matches.length - 1];
  return `${templateHtml.slice(0, first.index)}${slideMarkup}${templateHtml.slice(last.end)}`;
}

export async function buildDeckHtmlFromModel(model) {
  const templateHtml = await readFile(resolve(scriptDir, "..", "assets/templates/presenter-popup-single-html.html"), "utf8");
  let html = updateDeckTitle(replaceSlideSections(templateHtml, renderModelSlides(model.slides, model.palette || "", model.icons || null, model.deckLinks || null)), model.title);
  // Inline the pure presenter timer core (fmtClock / bigTimerState) verbatim — single source of truth.
  html = html.replace("<!--TIMER_RUNTIME-->", timerRuntimeSource);
  // Inline the shared overview runtime (rankSlides / deriveSlideStatus / createOverview) verbatim —
  // the presenter drawer runs the SAME factory the handout does. Single source of truth.
  html = html.replace("<!--OVERVIEW_RUNTIME-->", overviewRuntimeSource);
  // Inline the vendored markmap runtime (d3 + markmap-view + markmap-lib) for the {mindmap} layout
  // (ADR-0005). One top-level <script> so each vendor IIFE binds to window; runs before the main
  // runtime. No CDN — the deck stays a self-contained single HTML file. A REPLACER FUNCTION is used
  // (not a string) so the minified vendor code's `$&`/`$\``/`$'` sequences are inserted verbatim
  // rather than interpreted as String.replace special patterns (which would splice in copies of the
  // surrounding HTML).
  html = html.replace("<!--MARKMAP_VENDOR-->", () => markmapVendorSource);
  // Heading-is-slide model (Task 5): embed the sequencer's beat list so the presenter runtime
  // navigates by beat index (window.__deckBeats). Every angle bracket is escaped to its unicode
  // form (backslash-u003c) so slide-derived text inside the JSON (ids/context) can never form a
  // closing script sequence and end the tag early.
  const beatsJson = JSON.stringify(model.beats || []).replace(/</g, "\\u003c");
  html = html.replace("<!--BEATS_JSON-->", `<script>window.__deckBeats=${beatsJson};</script>`);
  // Presenter talk clock: frontmatter `duration:` rides the deck container so the runtime
  // can show remaining time beside the elapsed clock.
  if (model.durationSeconds) {
    html = html.replace('<main class="deck"', `<main class="deck" data-talk-duration="${model.durationSeconds}"`);
  }
  // Deck font option (ADR-0005): frontmatter `font:` rides the container; CSS variants key off it.
  if (model.deckFont) {
    html = html.replace('<main class="deck"', `<main class="deck" data-deck-font="${model.deckFont}"`);
  }
  // Presenter clock amber/dark-amber thresholds (Task 3): model.warnAtMinutes/urgentAtMinutes are
  // already fully resolved (frontmatter `warn-at:`/`urgent-at:` ?? Settings global default ?? 5/1)
  // by the time they reach here — mirrors the data-talk-duration stamp above. urgentAt is clamped
  // to never exceed warnAt so a misconfigured deck can't invert the two thresholds.
  const warnAt = Number(model.warnAtMinutes ?? 5);
  const urgentAt = Math.min(Number(model.urgentAtMinutes ?? 1), warnAt);
  html = html.replace('<main class="deck"', `<main class="deck" data-warn-at="${warnAt}" data-urgent-at="${urgentAt}"`);
  // Deck license (2026-06-13): inject the popup body + reveal the footer button. No slide.
  if (model.license) {
    html = html.replace("<!--LICENSE_BODY-->", renderLicenseBody(model.license));
    html = html.replace('<button class="btn" id="licenseBtn" hidden>', '<button class="btn" id="licenseBtn">');
  }
  return html;
}

function sectionTitleFor(json, slide) {
  const rawSection = slide.section || slide.section_title || slide.sectionTitle || slide.section_id || slide.sectionId || "";
  if (!rawSection || !Array.isArray(json.sections)) return rawSection;
  const match = json.sections.find((section) => {
    return section && (section.id === rawSection || section.key === rawSection || section.title === rawSection || section.name === rawSection);
  });
  return match?.title || match?.name || rawSection;
}

function flattenJsonSlides(json) {
  if (Array.isArray(json.slides)) return json.slides;
  if (!Array.isArray(json.sections)) return [];
  return json.sections.flatMap((section) => {
    if (!Array.isArray(section.slides)) return [];
    return section.slides.map((slide) => ({ ...slide, section: slide.section || section.title || section.name || section.id }));
  });
}

export function adaptCanonicalPptJson(json, fallbackTitle) {
  const rawSlides = flattenJsonSlides(json);
  return {
    title: json.title || json.deck_title || json.name || fallbackTitle,
    sourceType: "canonical-ppt-json",
    adapter: "canonical-ppt-json-v2",
    contentSchemaVersion: json.content_schema_version || json.schema_version || "ppt-json-v2.1",
    warnings: [],
    slides: rawSlides.map((slide, index) => ({
      id: slide.id || slide.slide_id || `ppt-${index + 1}`,
      section: sectionTitleFor(json, slide),
      navTitle: slide.navTitle || slide.nav_title || slide.title,
      title: slide.title || slide.navTitle || slide.nav_title || `Slide ${index + 1}`,
      blocks: slide.blocks || slide.content || slide.elements || [{ type: "paragraph", text: slide.body || slide.text || "" }],
      notes: slide.notes || slide.speaker_notes || slide.presenter_notes || ""
    }))
  };
}

export function adaptLearnWeaverExport(json, fallbackTitle) {
  const rawSlides = flattenJsonSlides(json);
  return {
    title: json.title || json.deckTitle || json.name || fallbackTitle,
    sourceType: "learnweaver-export",
    adapter: "learnweaver-export-v1",
    contentSchemaVersion: json.learnweaver_export_version || json.schema_version || null,
    warnings: [],
    slides: rawSlides.map((slide, index) => ({
      id: slide.id || slide.slideId || `learnweaver-${index + 1}`,
      section: slide.section || slide.sectionTitle || "",
      navTitle: slide.navTitle || slide.nav_title || slide.title,
      title: slide.title || slide.navTitle || slide.nav_title || `Slide ${index + 1}`,
      html: slide.html || slide.body_html || "",
      blocks: slide.blocks || slide.content || [],
      notes: slide.notes || slide.speakerNotes || slide.speaker_notes || ""
    }))
  };
}
