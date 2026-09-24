import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { scriptDir, slugify, escapeHtml, timerRuntimeSource, overviewRuntimeSource, pollDisplayRuntimeSource, pollExtendedSource, markmapVendorSource, mermaidVendorSource } from "./01-cli-utils.mjs";
import { accentForSectionIndex, accentForSectionName, accentForDeckColour, titlePlacementFor, titleRegimeForLayout, renderInline, withRenderedClaims, quoteCiteEqualsTitle } from "./02-triggers-layout.mjs";
import { findSlideSections, updateDeckTitle, withoutScripts } from "./04-html-extraction.mjs";
import { createIconVocabulary, buildDeckIconMap, applySlideMonochrome } from "./05-icons.mjs";
import { groupImageRows, groupQrRows, groupActionBlocks, loadCompilerSvgSanitiser, renderBlock, renderBlocks, renderMediaBlocks } from "./06-block-renderers.mjs";
import { renderLicenseBody } from "./08-source-adapters.mjs";
import { pollFrameEligible, renderPollFrame } from "./poll-frame.mjs";
import { buildSlideScriptPayload, renderSlideScriptTag } from './slide-script.mjs';
import { slotCompositionFor, renderSlotComposition } from "./slot-composition.mjs";

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

function modelHasCodeBlock(value, language, seen = new Set()) {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (value.type === "code" && value.lang === language) return true;
  return Array.isArray(value)
    ? value.some((item) => modelHasCodeBlock(item, language, seen))
    : Object.values(value).some((item) => modelHasCodeBlock(item, language, seen));
}

// ADR-0023 §2: the ONE slide-head emitter. Every slide — content, carousel parent, the auto
// deck-title and the auto closing — gets its header from here, so a head can only take one of two
// forms and the auto and authored structural slides can never drift apart:
//
//   painted  <header class="slide-head">[<p class="kicker">SECTION</p>]<h1>Title</h1></header>
//   hidden   <header class="slide-head slide-head-quiet"><h1 class="sr-only">Title</h1></header>
//
// There is no third form. The compact kicker-title header is abolished (ADR-0023 §2: "the title is
// never demoted to a kicker"; ADR-0005: no duplicated information) — the mono .kicker carries the
// SECTION name and nothing else, so a kicker can never repeat the slide title.
function renderSlideHead({ title, kicker, showTitle, hidden }) {
  const safeTitle = escapeHtml(String(title ?? ""));
  if (hidden) {
    return `<header class="slide-head slide-head-quiet"><h1 class="sr-only">${safeTitle}</h1></header>\n`;
  }
  const kickerHtml = kicker ? `<p class="kicker">${escapeHtml(kicker)}</p>` : "";
  const titleHtml = showTitle ? `<h1>${safeTitle}</h1>` : "";
  return (kickerHtml || titleHtml) ? `<header class="slide-head">${kickerHtml}${titleHtml}</header>\n` : "";
}

// ADR-0022 carousel: render the inner CONTENT of one slide-like object — the
// `<div class="slide-content layout-X">…head…body…</div>` plus any pulled-out corner QR — WITHOUT
// the wrapping <section>. Used twice: once per real slide (the <section> wraps the return below),
// and once per CAROUSEL SUB-SLIDE (each sub-slide runs through this same full layout pipeline so it
// renders FULL-BLEED via inferLayout + the normal block renderers, NOT card-chrome). The sub-slide
// is then wrapped in the existing data-exclusive stepping container as a `.card.carousel-subslide`.
function renderSlideContent(slide, deckUsed, brandLogoColour = "unified") {
    // ADR-0023 §4: a `claim` block is a paragraph for EVERY composition decision below (and in
    // the block renderers) — only its own markup differs. One normalisation at the entry point,
    // covering real slides and carousel sub-slides alike; a slide with no claim is not copied.
    slide = withRenderedClaims(slide);
    const usesHtmlBody = Boolean(slide.html);
    const layoutSlug = slugify(slide.layout || "list") || "list";
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
    // ADR-0023 §3 (Dominik's pick B2) — THE MEDIA SLOT. Five branches used to live here
    // (cardsMediaSplit, listVisual, copyVisual, timelineVisual, mediaSplit), each re-deciding
    // "media beside copy" with its own trigger, wrapper and stylesheet. They are now ONE
    // decision in compiler/scripts/lib/slot-composition.mjs: any slide that mixes copy with
    // media gets copy in one column and every media block stacked in the other, side from the
    // media-placement option group. Copy-only and media-only slides are untouched.
    const slotComposition = usesHtmlBody
      ? { kind: "none" }
      : slotCompositionFor(slide, bodyBlocks, layoutSlug);
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
    } else if (slotComposition.kind === "beside") {
      // ONE grammar: div.slot[data-slot-side][data-slot-media-count] > .slot-copy + .slot-media.
      bodyHtml = renderSlotComposition(slotComposition, renderBlock, {
        deckUsed, frameIcons, renderBlocks
      });
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
    } else {
      bodyHtml = usesHtmlBody
        ? withoutScripts(slide.html)
        : layoutSlug === "media"
          ? renderMediaBlocks(bodyBlocks, slide.body || "", deckUsed, frameIcons)
          : renderBlocks(bodyBlocks, slide.body || "", deckUsed, frameIcons);
    }
    bodyHtml += sourceHtml;
    // Task 7 — slide-level monochrome coherence. Every icon this slide renders is now in bodyHtml
    // (this is THE per-slide seam that all layout branches and both carousel and non-carousel paths
    // funnel through). iconSvg has tagged each monochrome-only Simple Icons mark with data-mono; if
    // any is present, bring every brand mark on the slide down to currentColor in one pass so a row
    // never mixes vivid svgl marks with grey silhouettes. Post-processing the assembled HTML keeps
    // the decision genuinely slide-wide without resolving any icon a second time.
    // The deck `logo-colour` option (08-source-adapters → model.brandLogoColour) gates this pass:
    // "brand" skips it so each mark keeps its real colours; the unified default (key absent or any
    // other value) runs it exactly as before, so an untouched deck renders byte-identically.
    bodyHtml = brandLogoColour === "brand" ? bodyHtml : applySlideMonochrome(bodyHtml);
    // Ticket 5 (ADR-0017): a poll slide's STAGE is its poll frame — the question, the poll type, the
    // authored options, the join slot and the state chip — compiled statically, so the editor
    // preview, the prerendered thumbnails and the handout show the poll instead of an empty slide
    // (or a bare bullet list that never says it is a poll). The authored body is replaced, exactly
    // as the live projection replaces it: the options are IN the frame, so keeping the list too
    // would print them twice. The runtime mounts its live display over this same frame.
    if (pollFrameEligible(slide)) bodyHtml = renderPollFrame(slide.poll, { title: slide.title });
    const blocksHaveHeading = Array.isArray(slide.blocks)
      && slide.blocks.some((b) => b && typeof b === "object" && (b.type === "heading" || b.type === "title"));
    const slideTitle = String(slide.title ?? "");
    const showTitle = !usesHtmlBody && !blocksHaveHeading && slideTitle.trim() !== "";
    const layout = layoutSlug;
    // ADR-0023 §2: THE TITLE IS NEVER DEMOTED TO A KICKER. The compact eyebrow (SECTION · Title)
    // that cards, copy-visual and the carousel parent used to emit duplicated the slide title on
    // the kicker line — ADR-0005 "no duplicated information", and the mono kicker is reserved for
    // the SECTION name. Those layouts now take the `top` regime declared in the registry.
    // `{title=compact}` survives as an accepted token (old decks must not start warning) but is
    // no longer a distinct treatment: it renders as the layout's own regime.
    //
    // QUOTE/COMPARE DEFAULT = NO TITLE DRAWN (ADR-0005; the registry's `hidden` regime). The slide
    // is the quote + attribution, full-bleed; the heading is NAV-ONLY (an sr-only h1 so
    // overview/nav fallbacks that read h1 still work). `{title=show}` opts the heading back in.
    // Hide the on-slide heading (nav-only sr-only h1) when:
    //   • the layout's registry regime is `hidden` (quote, image-quote, compare), unless {title=show}, OR
    //   • {notitle} / {title=off} is set on the slide — the headline case is the title-less
    //     STATEMENT (full-bleed statement, heading nav-only). {title=show} still wins.
    const hideByQuoteDefault = titleRegimeForLayout(layout) === "hidden" && slide.titleMode !== "show";
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
    // exactly as if the same text were authored as a paragraph. The quiet head means the hidden
    // regime → the statement spans the whole slide. An explicit {title=side|top} or {title=show}
    // keeps the plain heading treatment instead.
    const statementFromTitle = layout === "statement" && showTitle
      && (bodyHtml.trim() === "" || bodyHtml === "<p></p>")
      && !authorForcesRail && !authorForcesTop && slide.titleMode !== "show";
    if (statementFromTitle) bodyHtml = `<p>${escapeHtml(slideTitle)}</p>`;
    // `{titletop}` is a placement override, not authored body content: keep the promoted statement
    // paragraph, but draw its title at the requested top position instead of making it nav-only.
    const hidePromotedStatementTitle = statementFromTitle && slide.titleTop !== true;
    // When frame.title=side or an explicit top, skip layout-driven hide (the author asked for it).
    const hideTitleByLayout = hidePromotedStatementTitle
      || (!authorForcesRail && !authorForcesTop && (hideByQuoteDefault || hideByNotitle || hideTitleByFrame) && showTitle);
    // ONE resolver, ONE stamp: override → registry regime → data-title-layout / data-split.
    const titlePlacement = titlePlacementFor({
      layout,
      attrs: { titletop: slide.titleTop === true, split: slide.split || "" },
      frameTitle,
      frameTitleExplicit: slide.frameTitleExplicit === true,
      titleHidden: hideTitleByLayout,
    });
    // 2026-07-08: the blue "sidebar" panel is retired — frame.title === "side" now renders the
    // PLAIN left rail (data-title-layout="left" only). Legacy {titlestyle=sidebar} still stamps
    // the attr, but no CSS paints it.
    const effectiveTitleStyle = slide.titleStyle || "";
    const headHtml = renderSlideHead({
      title: slideTitle,
      kicker: slide.kicker,
      showTitle,
      hidden: hideTitleByLayout,
    });
    if (showTitle && !hideTitleByLayout && bodyHtml === "<p></p>") bodyHtml = "";
    if (hideTitleByLayout && bodyHtml === "<p></p>") bodyHtml = "";
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
function renderCarouselSubSlide(subSlide, deckUsed, isFirst, subIndex, brandLogoColour = "unified") {
  const { contentHtml } = renderSlideContent(subSlide, deckUsed, brandLogoColour);
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

function renderModelSlides(slides, palette = "", deckIcons = null, deckLinks = null, brandLogoColour = "unified") {
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
    // A deck `colour:` resolves across the whole accent vocabulary, not only the deck's own
    // palette cycle — see accentForDeckColour (Ticket 10).
    const titleSkin = accentForDeckColour(slide.titleAccent, palette);
    const sectionSkin = titleSkin || accentBySection.get(slide.section || "") || null;
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
    // Stage 2 live polls: the presenter window is the compiled deck itself. Keep the authored
    // definition on its canonical slide so the runtime can arm it on arrival without a second
    // model channel. HTML escaping preserves the JSON bytes while dataset.poll decodes entities.
    const pollAttr = slide.poll && typeof slide.poll === "object"
      ? ` data-poll="${escapeHtml(JSON.stringify(slide.poll))}"`
      : "";

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
        .map((sub, subIdx) => renderCarouselSubSlide(sub, deckUsed, subIdx === 0, subIdx, brandLogoColour))
        .join("\n");
      const slideTitle = String(slide.title ?? "");
      const showHead = slideTitle.trim() !== "" && slide.titleMode !== "show-bigtitle";
      // ADR-0023 §2: the carousel parent's title is a real title in the `top` regime — the old
      // "SECTION · Title" eyebrow duplicated it on the kicker line. Same emitter as every
      // other slide.
      const headHtml = renderSlideHead({
        title: slideTitle,
        kicker: slide.kicker,
        showTitle: showHead,
        hidden: false,
      });
      const titlePlacement = titlePlacementFor({
        layout,
        attrs: { titletop: slide.titleTop === true, split: slide.split || "" },
        frameTitle: slide.frame?.title ?? "top",
        frameTitleExplicit: slide.frameTitleExplicit === true,
        titleHidden: false,
      });
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
      return `<section class="slide" data-id="${escapeHtml(id)}" data-section="${escapeHtml(section)}" data-subsection="${escapeHtml(subsection)}" data-role="${escapeHtml(role)}" data-layout="${escapeHtml(layout)}" data-carousel data-nav-title="${escapeHtml(title)}"${titlePlacement.mode ? ` data-title-layout="${titlePlacement.mode}"` : ""}${titlePlacement.split ? ` data-split="${titlePlacement.split}"` : ""}${pollAttr}${authoredMode ? ` data-mode="${escapeHtml(authoredMode)}"` : ""}${preparesFor ? ` data-prepares-for="${escapeHtml(preparesFor)}"` : ""}${slide.noStep ? " data-nostep" : ""}${slide.noValues ? " data-novalues" : ""}${slide.fontBody ? ` data-font-body="${slide.fontBody}"` : ""}${slide.fontTitle ? ` data-font-title="${slide.fontTitle}"` : ""}${accentStyle}>
  ${contentHtml}
  ${notes ? `<aside class="notes">${notes}</aside>` : ""}
</section>`;
    }

    // Ticket 5: the poll frame already carries the question, so the slide's own heading must not be
    // painted a second time. `noTitle` is the flag the head emitter already honours — it keeps the
    // nav-only sr-only h1 (overview, search and nav fallbacks still read it) and collapses the title
    // rail. Set on a COPY so the deck model itself is never mutated. {title=show} still wins.
    // ADR-0023 §5 rule 3 joins it: when a quote attributes itself to the slide's own title
    // (authored, or filled from the title by rule 2) the painted title would just repeat the cite.
    const framedSlide = pollFrameEligible(slide) || quoteCiteEqualsTitle(slide) ? { ...slide, noTitle: true } : slide;
    let { contentHtml, cornerQrHtml, cornerSectionHtml, layout, titlePlacement, effectiveTitleStyle } = renderSlideContent(framedSlide, deckUsed, brandLogoColour);
    // SD-17: for a links-layout slide, append the deck link list into the content HTML (inside
    // the .slide-content div, after the authored blocks but before the closing </div>).
    if (layout === "links" && Array.isArray(deckLinks) && deckLinks.length) {
      const linksHtml = renderLinksBlock(deckLinks);
      contentHtml = contentHtml.replace(/(\s*<\/div>\s*)$/, `\n${linksHtml}$1`);
    }
    return `<section class="slide" data-id="${escapeHtml(id)}" data-section="${escapeHtml(section)}" data-subsection="${escapeHtml(subsection)}" data-role="${escapeHtml(role)}" data-layout="${escapeHtml(layout)}" data-nav-title="${escapeHtml(title)}"${pollAttr}${authoredMode ? ` data-mode="${escapeHtml(authoredMode)}"` : ""}${preparesFor ? ` data-prepares-for="${escapeHtml(preparesFor)}"` : ""}${slide.noStep ? " data-nostep" : ""}${slide.noValues ? " data-novalues" : ""}${slide.fontBody ? ` data-font-body="${slide.fontBody}"` : ""}${slide.fontTitle ? ` data-font-title="${slide.fontTitle}"` : ""}${slide.countdownSeconds ? ` data-countdown="${slide.countdownSeconds}" data-countdown-style="${slide.countdownStyle || "digits"}"` : ""}${slide.sectionTimerSeconds ? ` data-section-timer="${slide.sectionTimerSeconds}" data-section-timer-show="${slide.sectionTimerShow || "presenter"}"` : ""}${slide.remindText ? ` data-remind="${escapeHtml(slide.remindText)}"${slide.remindAtMinutes != null ? ` data-remind-at="${slide.remindAtMinutes}"` : ""}${slide.remindInSeconds != null ? ` data-remind-in="${slide.remindInSeconds}"` : ""}` : ""}${titlePlacement.mode ? ` data-title-layout="${titlePlacement.mode}"` : ""}${effectiveTitleStyle ? ` data-title-style="${escapeHtml(effectiveTitleStyle)}"` : ""}${titlePlacement.split ? ` data-split="${titlePlacement.split}"` : ""}${containerAttrs}${accentStyle}>
  ${contentHtml}
${cornerQrHtml ? `  ${cornerQrHtml}\n` : ""}${cornerSectionHtml ? `  ${cornerSectionHtml}\n` : ""}  ${notes ? `<aside class="notes">${notes}</aside>` : ""}
</section>`;
  });
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
  if (modelHasCodeBlock(model.slides, "svg")) await loadCompilerSvgSanitiser();
  const slideMarkup = renderModelSlides(model.slides, model.palette || "", model.icons || null, model.deckLinks || null, model.brandLogoColour || "unified");
  const allSlides = slideMarkup.join("\n\n");
  let html = updateDeckTitle(replaceSlideSections(templateHtml, allSlides), model.title);
  // Inline the pure presenter timer core (fmtClock / bigTimerState) verbatim — single source of truth.
  html = html.replace("<!--TIMER_RUNTIME-->", timerRuntimeSource);
  // Inline the shared overview runtime (rankSlides / deriveSlideStatus / createOverview) verbatim —
  // the presenter drawer runs the SAME factory the handout does. Single source of truth.
  html = html.replace("<!--OVERVIEW_RUNTIME-->", overviewRuntimeSource);
  html = html.replace("<!--POLL_EXTENDED_RUNTIME-->", () => pollExtendedSource);
  html = html.replace("<!--POLL_DISPLAY_RUNTIME-->", () => pollDisplayRuntimeSource);
  // Inline the vendored markmap runtime (d3 + markmap-view + markmap-lib) for the {mindmap} layout
  // (ADR-0005). One top-level <script> so each vendor IIFE binds to window; runs before the main
  // runtime. No CDN — the deck stays a self-contained single HTML file. A REPLACER FUNCTION is used
  // (not a string) so the minified vendor code's `$&`/`$\``/`$'` sequences are inserted verbatim
  // rather than interpreted as String.replace special patterns (which would splice in copies of the
  // surrounding HTML).
  html = html.replace("<!--MARKMAP_VENDOR-->", () => markmapVendorSource);
  const hasMermaid = modelHasCodeBlock(model.slides, "mermaid");
  html = html.replace("<!--MERMAID_VENDOR-->", () => hasMermaid ? mermaidVendorSource : "");
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
  // ADR-0018: the phone's script companion, parsed from each slide's own outline source at COMPILE
  // time. Stamped into the deck so it reaches the handout the same way slide markup does — the
  // handout copies the compiled deck verbatim, so there is exactly one emission point and the two
  // outputs cannot drift.
  const slideScript = buildSlideScriptPayload(model.slides);
  let companionTag = "";
  if (Object.keys(slideScript).length) {
    // Inject before the LAST </body>, never the first. The presenter template contains an earlier
    // </body> INSIDE a JS template literal (the preview iframe's srcdoc, ~line 8384); a plain
    // .replace() put the payload inside that string and killed the whole deck runtime — blank
    // presenter, blank Inspector preview, dead buttons (2026-07-19).
    const closeIndex = html.lastIndexOf("</body>");
    const tag = `${renderSlideScriptTag(slideScript)}\n`;
    companionTag = tag;
    html = closeIndex >= 0
      ? html.slice(0, closeIndex) + tag + html.slice(closeIndex)
      : html + tag;
  }
  // Hash the actual rendered slide with the common document shell. This retains section
  // accents, inlined assets, fonts, runtimes and beats, without making an
  // ordinary text edit invalidate every PNG. Navigation changes remain conservative; the phone script is not slide artwork.
  const shellHash = createHash("sha256").update(html.replace(allSlides, "").replace(companionTag, "")).digest("hex");
  model.thumbnailHashes = slideMarkup.map(markup =>
    createHash("sha256").update(shellHash).update(markup).digest("hex"));
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
