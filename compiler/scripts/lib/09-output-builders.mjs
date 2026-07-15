import { escapeHtml, qrGeneratorSource, overviewRuntimeSource, markmapVendorSource } from "./01-cli-utils.mjs";
import { withoutScripts } from "./04-html-extraction.mjs";
import { renderLicenseBody } from "./08-source-adapters.mjs";

// =============================================================================
// 9. Output builders — share exports + local launch tools; mostly literal injected JS/CSS strings
// =============================================================================

export function buildShareHtml({ title, slides, styles, includeNotes, slug, license }) {
  const notesButton = includeNotes ? '<button class="btn" id="notesBtn" type="button"><span class="btn-label">Notes</span></button>' : "";
  // Public CC attribution travels into the share export as a no-JS <details> popover.
  const licenseDisclosure = license
    ? `<details class="share-license"><summary class="btn">License</summary><div class="license-pop">${renderLicenseBody(license)}</div></details>`
    : "";
  const slideMarkup = slides.map((slide, index) => {
    const notes = includeNotes && slide.notes
      ? `<aside class="notes">${withoutScripts(slide.notes)}</aside>`
      : "";
    return slide.html
      .replace(/<section\b([^>]*)>/i, `<section$1 data-share-index="${index}">`)
      .replace(/<\/section>\s*$/i, `${notes}</section>`);
  }).join("\n\n");
  // The overview list is rendered at RUNTIME by the shared createOverview factory so it mirrors the
  // full deck's grouped, clickable, searchable overview from the same slide data attributes.

  // String.raw: runtime JS inside this literal writes "\n" escapes (e.g. lines.join("\n")) that
  // must reach the emitted <script> as-is — a plain literal would turn them into real newlines
  // at build time and break the emitted string literals. Current content is backslash-free, so
  // the conversion itself changes nothing.
  return String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="deck-title" content="${escapeHtml(title)}">
<link rel="icon" href="data:,">
<title>${escapeHtml(title)}</title>
<style>
${styles}
body { margin: 0; }
.presenter-root, #presenterBtn { display: none !important; }
.share-shell { min-height: 100vh; display: grid; grid-template-rows: 1fr auto; }
.slide { display: none; }
.slide.active { display: grid; }
.share-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 14px; border-top: 1px solid #0001; background: #fffdf2; }
.share-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.share-license { position: relative; }
.share-license > summary { list-style: none; cursor: pointer; }
.share-license > summary::-webkit-details-marker { display: none; }
.license-pop { display: none; position: absolute; bottom: calc(100% + 8px); right: 0; width: min(420px, 86vw); background: #fffdf2; color: #17202a; border: 1px solid #17202a22; border-radius: 10px; box-shadow: 0 16px 40px #0003; padding: 16px 18px; z-index: 60; text-align: left; }
.share-license[open] .license-pop { display: block; }
.license-pop h3 { margin: 0 0 8px; font-size: 16px; }
.license-pop h4 { margin: 12px 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: #5b6572; }
.license-pop .license-name { font-weight: 700; margin: 0 0 6px; }
.license-pop ul { margin: 0; padding-left: 1.1em; }
.nav-panel, .notes-panel { position: fixed; inset: 0 0 0 auto; width: min(420px, 92vw); transform: translateX(105%); transition: transform 160ms ease; background: #fffdf2; color: #17202a; box-shadow: -18px 0 40px #0002; z-index: 50; overflow: auto; padding: 18px; }
.nav-panel.open, .notes-panel.open { transform: translateX(0); }
.nav-list { display: grid; gap: 2px; }
/* Overview rows reuse the deck stylesheet's .section-head / .subsection-head / .slide-link. */
.notes-panel .notes { display: block; color: #384452; line-height: 1.55; }
.help-fab { position: fixed; right: 14px; bottom: 64px; z-index: 60; width: 40px; height: 40px; border-radius: 999px; border: 1px solid #17202a22; background: #fffdf2; color: #17202a; font: 700 18px/1 system-ui, sans-serif; box-shadow: 0 10px 26px #0002; cursor: pointer; }
.help-fab:hover, .help-fab:focus-visible { border-color: #2563eb66; }
.help-overlay { position: fixed; inset: 0; z-index: 70; display: none; align-items: center; justify-content: center; background: #0008; }
.help-overlay.open { display: flex; }
.help-modal { width: min(520px, 92vw); max-height: 84vh; overflow: auto; background: #fffdf2; color: #17202a; border-radius: 12px; box-shadow: 0 24px 64px #0005; padding: 18px 20px; }
.help-modal h2 { margin: 0 0 12px; font-size: 18px; }
.help-rows { display: grid; gap: 8px; }
.help-row { display: grid; grid-template-columns: 180px 1fr; gap: 10px; align-items: baseline; }
.help-keys kbd { display: inline-block; border: 1px solid #17202a33; border-bottom-width: 2px; border-radius: 5px; background: #fff; padding: 2px 7px; font: 600 12px/1.2 ui-monospace, monospace; margin-right: 4px; }
.help-close { float: right; border: 1px solid #17202a24; background: #fff; border-radius: 7px; padding: 6px 10px; cursor: pointer; font: 700 13px/1 system-ui, sans-serif; }
.mynotes-panel { position: fixed; inset: 0 0 0 auto; width: min(460px, 92vw); transform: translateX(105%); transition: transform 160ms ease; background: #fffdf2; color: #17202a; box-shadow: -18px 0 40px #0002; z-index: 50; overflow: auto; padding: 18px; }
.mynotes-panel.open { transform: translateX(0); }
.mynotes-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 0 0 6px; }
.mynotes-head h2 { margin: 0; font-size: 18px; }
.note-pop { position: fixed; z-index: 65; width: min(280px, 80vw); background: #fffdf2; color: #17202a; border: 1px solid #17202a22; border-radius: 10px; box-shadow: 0 14px 38px #0004; padding: 10px; display: grid; gap: 8px; }
.note-pop[hidden] { display: none; }
.note-pop textarea { width: 100%; min-height: 44px; border: 1px solid #17202a22; border-radius: 7px; padding: 7px 8px; font: 13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; box-sizing: border-box; resize: vertical; }
.note-pop-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.note-pop-remove { border: 0; background: none; color: #9f1239; font: 600 12px/1 system-ui, sans-serif; cursor: pointer; padding: 6px 4px; }
.note-pop-remove:hover { text-decoration: underline; }
mark.note-mark { cursor: pointer; }
.mynotes-privacy { font-size: 12px; color: #5b6572; margin: 6px 0 10px; }
.mynotes-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.mynotes-hint { font-size: 12px; color: #5b6572; }
.mynotes-group h3 { margin: 14px 0 6px; font-size: 13px; }
.mynote { border: 1px solid #17202a22; border-radius: 8px; padding: 8px; margin-bottom: 8px; display: grid; gap: 6px; }
.mynote-quote { font-size: 12px; color: #384452; border-left: 3px solid #f59e0b; padding-left: 8px; }
.mynote textarea { width: 100%; min-height: 52px; border: 1px solid #17202a22; border-radius: 6px; padding: 6px; font: 13px/1.4 system-ui, sans-serif; box-sizing: border-box; }
.mynote-tools { display: flex; gap: 6px; }
mark.note-mark { background: #fde68a; padding: 0 1px; border-radius: 2px; }
/* Compact, icon-led chrome buttons so the reader's notes — not the controls — read as primary. */
.share-actions .btn, .mynotes-actions .btn, .mynotes-head .btn, .nav-panel > .btn, .notes-panel > .btn, .note-pop .btn, .mynote-tools .btn { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; line-height: 1.25; padding: 5px 9px; border-radius: 6px; }
.mynotes-actions .btn, .mynote-tools .btn { font-size: 12px; padding: 4px 8px; color: #384452; }
.share-license > summary.btn { font-size: 12.5px; padding: 5px 9px; }
.btn-ico { width: 14px; height: 14px; flex: 0 0 auto; }
.mynotes-actions .btn .btn-ico, .mynote-tools .btn .btn-ico { width: 13px; height: 13px; }
/* My Notes is the focus: roomier rows, readable comment fields, secondary controls. */
.mynote { padding: 9px 10px; }
.mynote-quote { font-size: 12.5px; }
.mynote textarea { font-size: 13.5px; min-height: 56px; }
.mynotes-head h2 { font-size: 17px; }
.share-actions .btn.is-on { background: #fde68a; border-color: #f59e0b; color: #17202a; }
/* Overview search box (the overview had none) + the hide hooks the filter toggles. */
.nav-search-wrap { position: relative; margin: 4px 0 12px; }
.nav-search-ico { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); width: 15px; height: 15px; color: #5b6572; pointer-events: none; }
.nav-search { width: 100%; box-sizing: border-box; padding: 8px 12px 8px 32px; border: 1px solid #17202a22; border-radius: 8px; background: #fff; color: #17202a; font: 14px/1.3 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.nav-search:focus-visible { outline: 2px solid #2563eb55; outline-offset: 1px; }
.section-head[hidden], .subsection-head[hidden], .slide-link[hidden] { display: none !important; }
@media print {
  .share-footer, .nav-panel, .notes-panel, .mynotes-panel, .help-fab, .help-overlay, .note-pop { display: none !important; }
  .slide { display: grid !important; break-after: page; min-height: 100vh; }
  .slide .notes { display: block; margin-top: 24px; border-top: 1px solid #0002; padding-top: 12px; }
}
</style>
</head>
<body>
<main class="share-shell">
  <div class="stage" id="stage">
${slideMarkup}
  </div>
  <footer class="share-footer">
    <div><strong id="slideCount">1 / ${slides.length}</strong></div>
    <div class="share-actions">
      <button class="btn" id="prevBtn" type="button"><span class="btn-label">Previous</span></button>
      <button class="btn" id="nextBtn" type="button"><span class="btn-label">Next</span></button>
      <button class="btn" id="overviewBtn" type="button"><span class="btn-label">Overview</span></button>
      <button class="btn" id="revealBtn" type="button" aria-pressed="false"><span class="btn-label">Reveal</span></button>
      ${notesButton}
      <button class="btn" id="myNotesBtn" type="button"><span class="btn-label">My Notes</span></button>
      ${licenseDisclosure}
      <button class="btn" id="printBtn" type="button"><span class="btn-label">Print</span></button>
    </div>
  </footer>
</main>
<aside class="nav-panel" id="navPanel" aria-label="Slide overview">
  <button class="btn" id="closeOverview" type="button"><span class="btn-label">Close</span></button>
  <h2>Overview
    <button type="button" id="navExpand" class="tw-overview-expand" aria-label="Toggle previews">&#8862; Previews</button>
  </h2>
  <div class="nav-search-wrap">
    <svg class="nav-search-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M21 21l-4.5-4.5"></path></svg>
    <input class="nav-search" id="navSearch" type="search" placeholder="Search slides&#8230;" autocomplete="off" aria-label="Search slides">
  </div>
  <div class="nav-list" id="navList"></div>
</aside>
${includeNotes ? '<aside class="notes-panel" id="notesPanel" aria-label="Speaker notes"><button class="btn" id="closeNotes" type="button"><span class="btn-label">Close</span></button><h2>Notes</h2><div id="notesBody"></div></aside>' : ""}
<button class="help-fab" id="helpBtn" type="button" aria-label="Keyboard shortcuts (?)" title="Keyboard shortcuts (?)">?</button>
<div class="help-overlay" id="helpOverlay" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
  <div class="help-modal">
    <button class="help-close" id="helpClose" type="button">Close</button>
    <h2>Keyboard shortcuts</h2>
    <div class="help-rows" id="helpRows"></div>
  </div>
</div>
<div class="note-pop" id="notePop" hidden>
  <textarea id="notePopText" rows="2" placeholder="Add a note (optional)&#8230;"></textarea>
  <div class="note-pop-row">
    <button class="btn" id="notePopDone" type="button"><span class="btn-label">Done</span></button>
    <button class="note-pop-remove" id="notePopRemove" type="button">Remove highlight</button>
  </div>
</div>
<aside class="mynotes-panel" id="myNotesPanel" aria-label="My notes">
  <div class="mynotes-head">
    <h2>My Notes</h2>
    <button class="btn" id="closeMyNotes" type="button"><span class="btn-label">Close</span></button>
  </div>
  <p class="mynotes-privacy">Notes stay in this browser until you copy or download them. They are not sent anywhere automatically.</p>
  <div class="mynotes-actions">
    <button class="btn" id="notesCopyMd" type="button"><span class="btn-label">Copy as Markdown</span></button>
    <button class="btn" id="notesDownloadMd" type="button"><span class="btn-label">Download .md</span></button>
    <button class="btn" id="notesDownloadJson" type="button"><span class="btn-label">Download JSON</span></button>
  </div>
  <p class="mynotes-hint" id="myNotesHint">Select any text on a slide to highlight it &#8212; a popup lets you add an optional note (click a highlight to edit it later). With this drawer open, clicking an image notes it too.</p>
  <div class="mynotes-list" id="myNotesList"></div>
</aside>
<div class="focus-banner" id="modeBanner" role="status" aria-live="polite"></div>
<div class="lightbox" id="lightbox" role="dialog" aria-modal="true" aria-label="Image gallery" hidden>
  <button class="lightbox-close" id="lightboxClose" type="button" aria-label="Close gallery (Esc)">&times;</button>
  <div class="lightbox-stage">
    <button class="lightbox-nav" id="lightboxPrev" type="button" aria-label="Previous image">&lsaquo;</button>
    <img class="lightbox-img" id="lightboxImg" alt="">
    <button class="lightbox-nav" id="lightboxNext" type="button" aria-label="Next image">&rsaquo;</button>
  </div>
  <div class="lightbox-bar">
    <span class="lightbox-caption" id="lightboxCaption"></span>
    <span class="lightbox-counter" id="lightboxCounter"></span>
  </div>
</div>
${markmapVendorSource}
<script>
(() => {
  const slides = Array.from(document.querySelectorAll(".slide"));
  const count = document.getElementById("slideCount");
  const navPanel = document.getElementById("navPanel");
  const navList = document.getElementById("navList");
  const notesPanel = document.getElementById("notesPanel");
  const notesBody = document.getElementById("notesBody");
  // Inline icons for the chrome buttons (kept small so the notes themselves stay the focus).
  const ICON = {
    prev: '<svg class="btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"></path></svg>',
    next: '<svg class="btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>',
    overview: '<svg class="btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"></path></svg>',
    reveal: '<svg class="btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"></path><circle cx="12" cy="12" r="3"></circle></svg>',
    note: '<svg class="btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>',
    speaker: '<svg class="btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3h7l5 5v13H7z"></path><path d="M14 3v5h5"></path><path d="M10 13h6M10 17h5"></path></svg>',
    print: '<svg class="btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 9V3h10v6"></path><path d="M6 18H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-1"></path><path d="M7 14h10v7H7z"></path></svg>',
    close: '<svg class="btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>',
    copy: '<svg class="btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a2 2 0 0 1 2-2h8"></path></svg>',
    download: '<svg class="btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"></path><path d="M7 12l5 5 5-5"></path><path d="M5 21h14"></path></svg>',
    braces: '<svg class="btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 4a3 3 0 0 0-3 3v2a2 2 0 0 1-2 2 2 2 0 0 1 2 2v2a3 3 0 0 0 3 3"></path><path d="M16 4a3 3 0 0 1 3 3v2a2 2 0 0 0 2 2 2 2 0 0 0-2 2v2a3 3 0 0 1-3 3"></path></svg>',
    jump: '<svg class="btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7"></path><path d="M8 7h9v9"></path></svg>',
    trash: '<svg class="btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"></path><path d="M10 11v6M14 11v6"></path><path d="M6 7l1 13h10l1-13"></path><path d="M9 7V4h6v3"></path></svg>',
    check: '<svg class="btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13l4 4L19 7"></path></svg>'
  };
  let index = Math.max(0, slides.findIndex((slide) => slide.dataset.id && location.hash.slice(1) === slide.dataset.id));
  // === Overview (the SHARED createOverview factory — one overview everywhere) ==================
  // Same instance the presenter drawer and standalone deck use (rankSlides search, Enter jumps and
  // closes, expand → scaled-thumbnail grid). The handout is isPresenter:false, so no shown/skipped
  // markers. Group headers read as words via these id→title maps (a section-title slide carries the
  // section's display title in its nav-title; likewise a subsection-title slide).
  const sectionTitleById = new Map();
  const subsectionTitleById = new Map();
  slides.forEach((slide) => {
    const role = slide.dataset.role;
    if (role === "section-title" && slide.dataset.section) {
      sectionTitleById.set(slide.dataset.section, slide.dataset.navTitle || slide.dataset.section);
    } else if (role === "subsection-title" && slide.dataset.subsection) {
      subsectionTitleById.set(slide.dataset.subsection, slide.dataset.navTitle || slide.dataset.subsection);
    }
  });
  const navSearch = document.getElementById("navSearch");
  const navExpand = document.getElementById("navExpand");
  // The shared overview runtime (rankSlides / deriveSlideStatus / createOverview) is injected here
  // verbatim from the same source the presenter template uses — SINGLE SOURCE OF TRUTH.
  ${overviewRuntimeSource}
  const overviewSlideData = slides.map((el, slideIndex) => ({
    index: slideIndex,
    title: el.dataset.navTitle || el.querySelector("h1,h2")?.textContent || "",
    section: el.dataset.section || "",
    subsection: el.dataset.subsection || "",
    body: el.textContent || "",
    notes: el.querySelector("aside.notes")?.textContent || "",
    subs: Array.from(el.querySelectorAll(".carousel-subslide")).map((c) => ({ title: c.dataset.subTitle || "", subIndex: Number(c.dataset.subIndex) || 0, body: c.textContent || "" })),
    el,
  }));
  const overview = createOverview({
    slideData: overviewSlideData,
    listEl: navList,
    searchEl: navSearch,
    drawerEl: navPanel,
    isPresenter: false,
    getCurrentIndex: () => index,
    getStatus: () => null,
    onJump: (i, subIndex) => {
      go(i);
      if (subIndex == null) return;
      const gallery = activeGallery();
      if (!gallery?.classList.contains("carousel")) return;
      const cards = galleryCards(gallery);
      if (!cards.length) return;
      galleryStep = Math.max(0, Math.min(cards.length - 1, Number(subIndex) || 0));
      applyGallery();
    },
    sectionTitleById, subsectionTitleById,
  });
  navExpand?.addEventListener("click", () => overview.toggleExpand());
  // === Embeds (parity with the full deck) =====================================================
  // Slide iframes ship with a lazy data-src; promote the ACTIVE slide's to a live src. Same
  // file:// rule as the full runtime: arbitrary remote embeds stay unloaded over file://, but
  // YouTube/Vimeo player iframes (data-embed-video) play from anywhere; enablejsapi is dropped
  // on file:// and origin added on http(s).
  const IS_FILE_PROTOCOL = location.protocol === "file:";
  function embedSrcFor(frame) {
    const raw = frame.dataset.src || "";
    if (frame.dataset.embedVideo !== "1") return raw;
    let u;
    try { u = new URL(raw, location.href); } catch { return raw; }
    if (u.searchParams.has("enablejsapi")) {
      if (IS_FILE_PROTOCOL) u.searchParams.delete("enablejsapi");
      else if (!u.searchParams.has("origin")) u.searchParams.set("origin", location.origin);
    }
    return u.toString();
  }
  // A self-contained sim renders from a BLOB URL, not srcdoc: a srcdoc document inherits the deck's
  // base URL, so an in-sim <a href="#section"> would load the whole deck into the frame. A blob URL
  // is the doc's own base, so #hash / relative links resolve within the sim (scroll).
  function simBlobSrc(html) {
    try { return URL.createObjectURL(new Blob([html || ""], { type: "text/html" })); }
    catch { return null; }
  }
  function blobifySrcdocSims(root) {
    if (!root) return;
    root.querySelectorAll("figure.slide-embed > iframe[srcdoc]").forEach((f) => {
      if (f.dataset.simBlobbed === "1") return;
      const url = simBlobSrc(f.getAttribute("srcdoc"));
      if (!url) return;
      f.dataset.simBlobbed = "1";
      f.removeAttribute("srcdoc");
      f.addEventListener("load", () => { try { URL.revokeObjectURL(url); } catch { /* noop */ } }, { once: true });
      f.src = url;
    });
  }
  function syncShareEmbeds() {
    blobifySrcdocSims(document.querySelector(".slide.active"));
    document.querySelectorAll(".slide.active iframe[data-src]").forEach((frame) => {
      if (!frame.src) frame.src = embedSrcFor(frame);
    });
  }
  function render() {
    slides.forEach((slide, slideIndex) => slide.classList.toggle("active", slideIndex === index));
    // The shared factory paints the "current" row itself; re-render it when the drawer is open so
    // the highlight (and any live filter) tracks slide changes.
    if (overview.isOpen()) overview.render();
    count.textContent = (index + 1) + " / " + slides.length;
    const id = slides[index]?.dataset.id;
    if (id) history.replaceState(null, "", "#" + id);
    if (notesBody) {
      const note = slides[index]?.querySelector(".notes");
      notesBody.replaceChildren();
      if (note) notesBody.appendChild(note.cloneNode(true));
    }
    syncShareEmbeds();
    drawSystemLinks(slides[index]);
    initMarkmaps(slides[index]);
  }
  function go(nextIndex) {
    index = Math.max(0, Math.min(slides.length - 1, nextIndex));
    // Handouts default to COMPLETE slides: a handout is for reading, so authored {data-mode} is
    // NOT auto-entered here. Reveal/Focus is opt-in (the Reveal button / R / F); once the reader
    // turns it on it is sticky across slides, with the step just resetting to 0 on each slide.
    modeStep = 0;
    galleryStep = 0;
    render();
    applyModeDimming();
    applyGallery();
  }
  // LOCAL reveal/focus stepping modes (no presenter sync in share exports). Same selector list,
  // stepping grammar and CSS hooks as the deck runtime; banner auto-dismiss at 2.5s.
  // Synced 2026-06-12 to the FULL template list (the share copy had drifted — contrast pairs,
  // tiles, system-map satellites, evidence/cta units, smartart/mindmap/pyramid/orgchart nodes
  // were missing, so those slides would not step in handouts) + the batch-2 units (bar-chart
  // columns, cycle nodes). When the template runtime's MODE_SELECTOR gains an entry, add it
  // HERE too — test-presentation-bundle's selector-parity check fails on drift.
  const MODE_SELECTOR = ".feature-list[data-reveal-group],.feature-list > li:not(.image-grid *):not([data-reveal-group] *),.feature-list .fl-sublist > li:not([data-reveal-group] *),.timeline .tl-entries > li,.timeline .tl-spine-track > li,.timeline > li,.slide-content > blockquote,.statement,.slide-content .content-p:not(.card-gallery *):not(.evidence-layout *):not(.cta-layout *):not(.image-grid *),figure.slide-figure:not(.evidence-layout *):not(.cta-layout *),.trace .turn,.contrast-grid > .contrast-pair,.tile-grid > div,.system-map > div:not(.system-centre),.evidence-layout .callouts > li,.cta-layout .cta-shot,.cta-layout .callouts > li,.cta-layout .slide-action,.smartart-node:not(.smartart-node *),.flow > .flow-node,.flow-cycle-row > .flow-node,.flow-snake-row > .flow-node,.flow > .flow-item,.pyramid .pyr-tier,.orgchart .org-box,.stats-row > .stat,.process-strip > .proc-step,.steps-diagram > .step-col,.icon-row > .ir-item,.image-grid > .ig-cell,.chart-cols > .chart-col,.cycle-diagram .cycle-node,.cycle-diagram .cycle-arc-svg,.timetable tbody tr,.layout-compare .compare-half.half-b";
  const CARD_UNIT_SELECTOR = ".feature-list > li,blockquote,figure.slide-figure,p.content-p";
  let modeKind = null;   // null | "reveal" | "focus"
  let modeStep = 0;
  const modeBanner = document.getElementById("modeBanner");
  const MODE_BANNER_TEXT = {
    reveal: 'Reveal &middot; <kbd>&rarr;</kbd> to add &middot; <kbd>R</kbd>/<kbd>Esc</kbd> to exit',
    focus: 'Focus &middot; <kbd>&rarr;</kbd> to step &middot; <kbd>F</kbd>/<kbd>Esc</kbd> to exit'
  };
  let modeBannerTimer = 0;
  function showModeBanner(kind) {
    if (!modeBanner || !MODE_BANNER_TEXT[kind]) return;
    modeBanner.innerHTML = MODE_BANNER_TEXT[kind];
    modeBanner.classList.add("show");
    clearTimeout(modeBannerTimer);
    modeBannerTimer = setTimeout(() => modeBanner.classList.remove("show"), 2500);
  }
  function hideModeBanner() {
    if (!modeBanner) return;
    clearTimeout(modeBannerTimer);
    modeBanner.classList.remove("show");
  }
  function isVisibleUnit(el) {
    if (!el || el.classList.contains("hidden-fragment") || el.closest(".hidden-fragment")) return false;
    // Structural visibility (not layout): walk up to the .slide; a non-active gallery card sets
    // display:none on itself. getComputedStyle returns each element's own display even under a
    // display:none ancestor, so this is safe for hidden/detached roots too.
    var node = el;
    while (node && !(node.classList && node.classList.contains("slide"))) {
      if (node.nodeType === 1 && getComputedStyle(node).display === "none") return false;
      node = node.parentElement;
    }
    return true;
  }
  function galleryIn(slide) { return slide ? slide.querySelector(".card-gallery[data-exclusive]") : null; }
  function cardUnits(card) {
    if (!card || card.classList.contains("card-title")) return [];
    const raw = Array.from(card.querySelectorAll(CARD_UNIT_SELECTOR));
    return raw.filter((el, i) => isVisibleUnit(el) && raw.indexOf(el) === i);
  }
  function modeElements() {
    const slide = slides[index];
    if (!slide) return [];
    const gallery = galleryIn(slide);
    if (gallery) return cardUnits(gallery.querySelector(".card.active-card") || gallery.querySelector(".card"));
    const raw = Array.from(slide.querySelectorAll(MODE_SELECTOR));
    return raw.filter((el, i) => isVisibleUnit(el) && raw.indexOf(el) === i);
  }
  function maxStepFor(count) { return count <= 1 ? count : count + 1; }
  function clampStep(step, total) { return Math.max(0, Math.min(maxStepFor(total), Number(step) || 0)); }
  function unitState(kind, step, total, i) {
    if (step >= maxStepFor(total) && step >= total) return "full";
    if (step <= 0) return kind === "focus" ? "fuzzy" : "hidden";
    var cur = step - 1;
    if (i === cur) return "current";
    if (i < cur) return "soft";
    return kind === "focus" ? "fuzzy" : "hidden";
  }
  // Diff, do not reset: only the unit(s) whose state changed get a new data-mode-state, so an
  // unchanged unit never loses .mode-el (and its transition) for a frame — no per-step flicker.
  function applyModeDimming() {
    const slide = slides[index];
    if (!slide) return;
    slide.classList.toggle("mode-active", Boolean(modeKind));
    slide.classList.toggle("mode-reveal", modeKind === "reveal");
    slide.classList.toggle("mode-focus", modeKind === "focus");
    syncRevealBtn();
    const units = modeKind ? modeElements() : [];
    const live = new Set(units);
    slide.querySelectorAll(".mode-el").forEach((el) => {
      if (live.has(el)) return;
      el.classList.remove("mode-el");
      el.removeAttribute("data-mode-state");
    });
    if (!modeKind || units.length === 0) return;
    modeStep = clampStep(modeStep, units.length);
    units.forEach((el, i) => {
      if (!el.classList.contains("mode-el")) el.classList.add("mode-el");
      var want = unitState(modeKind, modeStep, units.length, i);
      if (el.getAttribute("data-mode-state") !== want) el.setAttribute("data-mode-state", want);
    });
    // Scroll-follow (Fix 3): bring the newly-current unit into view inside its scroll container
    // (tall .trace / .slide-code panel, tall card, any overflow-y:auto box, or the slide). Same
    // mechanics as the deck runtime; block:"nearest" leaves already-visible units untouched.
    scrollCurrentUnitIntoView(units, modeStep);
  }
  function scrollCurrentUnitIntoView(units, step) {
    if (!units || units.length === 0 || step <= 0) return;
    var idx = Math.min(step - 1, units.length - 1);
    var el = units[idx];
    if (!el || typeof el.scrollIntoView !== "function") return;
    requestAnimationFrame(function () {
      try { el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" }); }
      catch (e) { el.scrollIntoView(false); }
    });
  }
  function enterMode(kind) { closeLightbox(); modeKind = kind; modeStep = 0; showModeBanner(kind); applyModeDimming(); }
  function exitMode() { modeKind = null; modeStep = 0; hideModeBanner(); applyModeDimming(); }
  function toggleMode(kind) { if (modeKind === kind) exitMode(); else enterMode(kind); }
  function syncRevealBtn() {
    const btn = document.getElementById("revealBtn");
    if (!btn) return;
    const on = modeKind === "reveal";
    btn.classList.toggle("is-on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
  function stepMode(delta) {
    if (!modeKind) { go(index + (delta > 0 ? 1 : -1)); return; }
    const units = modeElements();
    if (units.length === 0) { go(index + (delta > 0 ? 1 : -1)); return; }
    const target = clampStep(modeStep, units.length) + delta;
    if (target < 0) { go(index - 1); return; }
    if (target > maxStepFor(units.length)) { go(index + 1); return; }
    modeStep = target;
    applyModeDimming();
  }
  function activeGallery() {
    const slide = slides[index];
    return slide ? slide.querySelector(".card-gallery[data-exclusive]") : null;
  }
  // Exclusive card galleries (#### groups): the stylesheet hides every card except .active-card,
  // and only the FULL deck runtime used to set that class — share exports rendered these slides
  // EMPTY. Local stepping: arrival shows the title card; ArrowRight walks the cards before
  // advancing the slide; dots nav matches the full deck. (Print shows all cards via the
  // template's print rule.)
  let galleryStep = 0;
  function galleryCards(gallery) {
    return gallery ? Array.from(gallery.querySelectorAll(".card")) : [];
  }
  function ensureGalleryNav(gallery, count, visible) {
    const sibling = gallery.nextElementSibling;
    let nav = sibling && sibling.classList && sibling.classList.contains("gallery-nav") ? sibling : null;
    if (!nav) {
      nav = document.createElement("div");
      nav.className = "gallery-nav";
      const dots = document.createElement("div");
      dots.className = "gallery-dots";
      for (let i = 0; i < count; i++) {
        const dot = document.createElement("button");
        dot.type = "button";
        dot.className = "gallery-dot";
        dot.setAttribute("aria-label", "Card " + (i + 1));
        dot.addEventListener("click", () => { galleryStep = i; applyGallery(); });
        dots.appendChild(dot);
      }
      const counter = document.createElement("span");
      counter.className = "gallery-counter";
      nav.appendChild(dots);
      nav.appendChild(counter);
      gallery.parentNode.insertBefore(nav, gallery.nextSibling);
    }
    Array.from(nav.querySelectorAll(".gallery-dot")).forEach((dot, i) => dot.classList.toggle("active", i === visible));
    const counter = nav.querySelector(".gallery-counter");
    if (counter) counter.textContent = (visible + 1) + " / " + count;
  }
  function applyGallery() {
    const gallery = activeGallery();
    if (!gallery) return;
    const cards = galleryCards(gallery);
    if (cards.length === 0) return;
    const visible = Math.max(0, Math.min(cards.length - 1, galleryStep));
    cards.forEach((card, i) => card.classList.toggle("active-card", i === visible));
    ensureGalleryNav(gallery, cards.length, visible);
    densifyActiveCards();
  }
  // Parity with the full deck's D6 in-card browsability: an overflowing visible card first
  // tries a one-notch type shrink (.card-dense, quote cards only), then .is-scrollable for the
  // thin scrollbar + bottom fade affordance. Cards that fit get neither class.
  function densifyActiveCards() {
    document.querySelectorAll(".slide.active .card-gallery:not(.grid-view) .card.active-card").forEach((card) => {
      card.classList.remove("card-dense", "is-scrollable");
      const overflows = () => card.scrollHeight - card.clientHeight > 2;
      if (!overflows()) return;
      if (card.querySelector("blockquote")) {
        card.classList.add("card-dense");
        if (!overflows()) return;
      }
      card.classList.add("is-scrollable");
    });
  }
  // Parity with the full deck: system-map and mindmap connector lines are measured and drawn at
  // layout time into their SVG overlays; redraw on slide arrival and resize. Hidden slides
  // measure 0x0 and are skipped, so this is safe to call broadly.
  function drawSystemLinks(root = document) {
    if (!root) return;
    root.querySelectorAll(".system-map").forEach((map) => {
      const svg = map.querySelector(":scope > .system-links");
      const centre = map.querySelector(":scope > .system-centre");
      const sats = map.querySelectorAll(":scope > .system-sats > .system-sat");
      if (!svg || !centre || !sats.length) return;
      const mapRect = map.getBoundingClientRect();
      if (mapRect.width <= 0 || mapRect.height <= 0) return;
      svg.setAttribute("viewBox", "0 0 " + mapRect.width + " " + mapRect.height);
      const multi = map.classList.contains("system-multicolour");
      const cRect = centre.getBoundingClientRect();
      const cx = cRect.left - mapRect.left + cRect.width / 2;
      const cy = cRect.bottom - mapRect.top;
      const lines = [];
      sats.forEach((sat) => {
        const r = sat.getBoundingClientRect();
        const sx = r.left - mapRect.left + r.width / 2;
        const sy = r.top - mapRect.top;
        const stroke = multi ? (getComputedStyle(sat).getPropertyValue("--sat-c").trim() || "") : "";
        const strokeAttr = stroke ? ' style="stroke:' + stroke + '"' : "";
        lines.push('<line x1="' + cx.toFixed(1) + '" y1="' + cy.toFixed(1) + '" x2="' + sx.toFixed(1) + '" y2="' + sy.toFixed(1) + '"' + strokeAttr + "/>");
      });
      svg.innerHTML = lines.join("");
    });
    // {mindmap} is rendered by markmap (ADR-0005), not hand-positioned connectors — see initMarkmaps.
  }
  // MINDMAP ({mindmap}) — ADR-0005: rendered by vendored markmap (window.d3 / window.markmap, inlined
  // above). Same lazy first-activation init as the presenter runtime: build the SVG only when the
  // host has a non-zero box (active slide, never display:none), guarded by data-mm-done so it renders
  // once. Branch colours rotate the section palette to start from this slide's accent; node text
  // inherits the deck --sans via the extracted stylesheet's --markmap-font rule.
  const MM_ACCENTS = ["#0f4bd8", "#0a7a5c", "#c2410c"];
  function initMarkmaps(root) {
    if (!root) return;
    const mm = window.markmap;
    if (!mm || !mm.Transformer || !mm.Markmap) return;
    const hosts = root.querySelectorAll ? root.querySelectorAll(".mindmap-mm") : [];
    hosts.forEach((host) => {
      if (host.dataset.mmDone) return;
      const box = host.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return;
      const outline = host.getAttribute("data-mm-outline") || "";
      if (!outline.trim()) { host.dataset.mmDone = "1"; return; }
      let node;
      try { node = new mm.Transformer().transform(outline).root; }
      catch (e) { if (typeof console !== "undefined") console.error("MARKMAP-FAIL:", e && e.message); return; }
      const slide = host.closest(".slide");
      let accent = "";
      try { accent = (getComputedStyle(slide).getPropertyValue("--sec-accent") || "").trim().toLowerCase(); } catch (e) { /* noop */ }
      let start = MM_ACCENTS.findIndex((c) => c.toLowerCase() === accent);
      if (start < 0) start = 0;
      const colors = [0, 1, 2].map((i) => MM_ACCENTS[(start + i) % MM_ACCENTS.length]);
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      host.appendChild(svg);
      try {
        const opts = mm.deriveOptions({ colorFreezeLevel: 2, maxWidth: 340, color: colors, fitRatio: 0.92 });
        opts.maxInitialScale = 6;
        mm.Markmap.create(svg, opts, node);
        host.dataset.mmDone = "1";
      } catch (e) {
        svg.remove();
        if (typeof console !== "undefined") console.error("MARKMAP-FAIL:", e && e.message);
      }
    });
  }
  window.addEventListener("resize", () => {
    densifyActiveCards();
    drawSystemLinks(slides[index]);
    initMarkmaps(slides[index]);
  });
  // Step the gallery by delta; false = edge reached (caller advances the slide instead).
  function stepGallery(delta) {
    const gallery = activeGallery();
    if (!gallery) return false;
    const count = galleryCards(gallery).length;
    const target = galleryStep + delta;
    if (target < 0 || target > count - 1) return false;
    galleryStep = target;
    applyGallery();
    return true;
  }
  // G5: LOCAL fullscreen image gallery (browsing feature; no presenter sync in share exports).
  const lightbox = document.getElementById("lightbox");
  const lightboxImg = document.getElementById("lightboxImg");
  const lightboxCaption = document.getElementById("lightboxCaption");
  const lightboxCounter = document.getElementById("lightboxCounter");
  const lightboxPrev = document.getElementById("lightboxPrev");
  const lightboxNext = document.getElementById("lightboxNext");
  let lbImages = [];
  let lbIndex = 0;
  let lbOpen = false;
  function collectImages() {
    const slide = slides[index];
    if (!slide) return [];
    const stills = Array.from(slide.querySelectorAll("figure.slide-figure img")).map((img) => ({
      src: img.currentSrc || img.src || img.getAttribute("src") || "",
      alt: img.getAttribute("alt") || "",
      caption: (img.closest("figure.slide-figure") && img.closest("figure.slide-figure").querySelector("figcaption") || {}).textContent || ""
    }));
    // QR codes are zoomables here too (parity with the presenting runtime): Z / click blows the
    // code up with its URL display-sized beneath, so a handout reader can scan or copy it.
    const qrs = Array.from(slide.querySelectorAll(".slide-qr .qr-code svg")).map((svg) => {
      try {
        const fig = svg.closest("figure");
        const cap = fig && fig.querySelector(".qr-caption");
        return {
          src: "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg.outerHTML))),
          alt: "QR code",
          caption: (cap && cap.textContent || "QR code").trim(),
          isQr: true
        };
      } catch (e) { return null; }
    }).filter(Boolean);
    return stills.concat(qrs).filter((entry) => entry.src);
  }
  function renderLightbox() {
    if (!lbOpen || lbImages.length === 0) {
      lightbox.classList.remove("open");
      lightbox.hidden = true;
      lightboxImg.removeAttribute("src");
      return;
    }
    lbIndex = Math.max(0, Math.min(lbImages.length - 1, lbIndex));
    const entry = lbImages[lbIndex];
    lightbox.hidden = false;
    lightbox.classList.add("open");
    lightboxImg.src = entry.src;
    lightboxImg.alt = entry.alt;
    // QR entries get URL-display treatment (.qr-focus, shared CSS): the caption is the URL
    // someone is about to write down — split at the first slash, path (short id) emboldened.
    lightbox.classList.toggle("qr-focus", Boolean(entry.isQr));
    const cap = (entry.caption || "").trim();
    const slash = entry.isQr ? cap.indexOf("/") : -1;
    if (slash > 0) {
      const host = document.createElement("span");
      host.textContent = cap.slice(0, slash);
      const path = document.createElement("strong");
      path.textContent = cap.slice(slash);
      lightboxCaption.replaceChildren(host, path);
    } else {
      lightboxCaption.textContent = cap;
    }
    lightboxCounter.textContent = (lbIndex + 1) + " / " + lbImages.length;
    const single = lbImages.length <= 1;
    lightboxPrev.hidden = single;
    lightboxNext.hidden = single;
  }
  function openLightbox(at) {
    lbImages = collectImages();
    if (lbImages.length === 0) return;
    // Lightbox and stepping modes are mutually exclusive.
    if (modeKind) exitMode();
    lbIndex = Math.max(0, Math.min(lbImages.length - 1, at || 0));
    lbOpen = true;
    renderLightbox();
  }
  function closeLightbox() { lbOpen = false; renderLightbox(); }
  function stepLightbox(delta) { lbIndex += delta; renderLightbox(); }
  lightboxPrev.addEventListener("click", () => stepLightbox(-1));
  lightboxNext.addEventListener("click", () => stepLightbox(1));
  document.getElementById("lightboxClose").addEventListener("click", closeLightbox);
  lightbox.addEventListener("click", (event) => {
    if (event.target === lightboxImg || event.target.closest(".lightbox-nav") || event.target.closest(".lightbox-close")) return;
    closeLightbox();
  });
  document.querySelector(".stage").addEventListener("click", (event) => {
    // A corner QR is a button: clicking it opens the gallery AT the QR entry (parity with the
    // presenting runtime's full-screen QR), URL display-sized beneath.
    const qrBtn = event.target.closest(".slide-qr .qr-code");
    if (qrBtn) {
      const images = collectImages();
      const at = images.findIndex((entry) => entry.isQr);
      if (images.length > 0) { event.preventDefault(); openLightbox(at < 0 ? 0 : at); return; }
    }
    const img = event.target.closest("figure.slide-figure img");
    if (!img) return;
    // Drawer open = capture mode: an image click anchors a note instead of opening the gallery.
    if (myNotesPanel.classList.contains("open")) { event.preventDefault(); addImageNote(img); return; }
    const images = collectImages();
    const at = images.findIndex((entry) => entry.src === (img.currentSrc || img.src || img.getAttribute("src")));
    if (images.length > 0) { event.preventDefault(); openLightbox(at < 0 ? 0 : at); }
  });
  // Unified stepping: the Next/Prev buttons and the arrow keys run the SAME logic, so they step
  // Reveal/Focus and card galleries identically instead of the buttons always jumping a slide.
  function goNext() {
    if (modeKind) { if (activeGallery()) { go(index + 1); return; } stepMode(1); return; }
    if (!stepGallery(1)) go(index + 1);
  }
  function goPrev() {
    if (modeKind) { if (activeGallery()) { go(index - 1); return; } stepMode(-1); return; }
    if (!stepGallery(-1)) go(index - 1);
  }
  document.getElementById("prevBtn").addEventListener("click", () => goPrev());
  document.getElementById("nextBtn").addEventListener("click", () => goNext());
  document.getElementById("revealBtn").addEventListener("click", () => toggleMode("reveal"));
  document.getElementById("overviewBtn").addEventListener("click", () => overview.open());
  document.getElementById("closeOverview").addEventListener("click", () => overview.close());
  document.getElementById("printBtn").addEventListener("click", () => window.print());
  document.getElementById("notesBtn")?.addEventListener("click", () => notesPanel.classList.add("open"));
  document.getElementById("closeNotes")?.addEventListener("click", () => notesPanel.classList.remove("open"));
  // === Reader notes ("My Notes") ==============================================================
  // The READER's own notes — distinct from authored slide notes (the includeNotes panel). Drawer open
  // = capture mode: a text selection on the active slide wraps in <mark.note-mark> and opens a
  // comment row; an image click anchors an image note. Notes persist in a slug-scoped
  // localStorage key (this browser only, never transmitted); the export buttons (wired in the
  // exports task) are the durable artifact, highlights are a convenience.
  //
  // Addressing model (lifted from the presenter F1 highlight, widened): a range is
  // {block, start, end} where block indexes NOTE_BLOCK_SELECTOR matches within the slide, or -1
  // meaning the slide itself is the offset container (the "any text" fallback). Offsets count
  // characters across the container's text nodes. Re-apply after reload is best-effort.
  const myNotesPanel = document.getElementById("myNotesPanel");
  const myNotesList = document.getElementById("myNotesList");
  const myNotesHint = document.getElementById("myNotesHint");
  const notePop = document.getElementById("notePop");
  const notePopText = document.getElementById("notePopText");
  const deckTitleText = document.querySelector('meta[name="deck-title"]')?.content || document.title;
  const NOTES_KEY = "html-presentations:notes:${slug}";
  let readerNotes = [];
  let noteCounter = 0;

  function loadNotes() {
    try {
      const parsed = JSON.parse(localStorage.getItem(NOTES_KEY) || "[]");
      if (Array.isArray(parsed)) readerNotes = parsed;
    } catch { readerNotes = []; }
    noteCounter = readerNotes.reduce((max, entry) => {
      const num = Number(String(entry.id || "").split("-")[1]);
      return Number.isFinite(num) && num > max ? num : max;
    }, 0);
  }
  function saveNotes() {
    try { localStorage.setItem(NOTES_KEY, JSON.stringify(readerNotes)); } catch {}
  }

  const NOTE_BLOCK_SELECTOR = "h1,h2,h3,h4,h5,p,li,blockquote,figcaption,dt,dd,th,td,.statement,.fl-text,.card-comment,.tl-text,.smartart-node > .smartart-label";
  function blockTextNodes(container) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    return nodes;
  }
  function noteBlocks(slide) {
    if (!slide) return [];
    return Array.from(slide.querySelectorAll(NOTE_BLOCK_SELECTOR)).filter((el) => !el.closest("aside.notes"));
  }
  function charOffsetWithin(container, node, offset) {
    let acc = 0;
    for (const tn of blockTextNodes(container)) {
      if (tn === node) return acc + offset;
      acc += tn.nodeValue.length;
    }
    const pre = document.createRange();
    pre.selectNodeContents(container);
    try { pre.setEnd(node, offset); } catch { return acc; }
    return pre.toString().length;
  }
  function offsetContainerFor(slide, range) {
    const common = range.commonAncestorContainer;
    const commonEl = common.nodeType === 1 ? common : common.parentElement;
    const block = commonEl && commonEl.closest(NOTE_BLOCK_SELECTOR);
    if (block && slide.contains(block)) {
      const idx = noteBlocks(slide).indexOf(block);
      if (idx >= 0) return { el: block, index: idx };
    }
    return { el: slide, index: -1 };
  }
  function serializeSelectionWithin(slide, range) {
    if (!slide || !range || range.collapsed) return null;
    const target = offsetContainerFor(slide, range);
    let start = charOffsetWithin(target.el, range.startContainer, range.startOffset);
    let end = charOffsetWithin(target.el, range.endContainer, range.endOffset);
    if (end < start) { const t = start; start = end; end = t; }
    if (end <= start) return null;
    return { block: target.index, start: start, end: end };
  }
  // PURE: per-node slices to wrap for a [start,end) char range over concatenated text nodes.
  // Named declaration — extracted by name in scripts/test-share-notes.mjs (exports task).
  function computeRangeEdits(textNodeLengths, start, end) {
    const edits = [];
    if (!(end > start)) return edits;
    let acc = 0;
    for (let idx = 0; idx < textNodeLengths.length; idx++) {
      const len = textNodeLengths[idx];
      const nodeStart = acc;
      const nodeEnd = acc + len;
      acc = nodeEnd;
      const from = Math.max(start, nodeStart);
      const to = Math.min(end, nodeEnd);
      if (to <= from) continue;
      edits.push({ nodeIndex: idx, from: from - nodeStart, to: to - nodeStart });
    }
    return edits;
  }
  function applyNoteRange(slide, r, noteId) {
    const container = r.block >= 0 ? noteBlocks(slide)[r.block] : slide;
    if (!container) return false;
    const nodes = blockTextNodes(container);
    const edits = computeRangeEdits(nodes.map((tn) => tn.nodeValue.length), r.start, r.end)
      .map((e) => ({ node: nodes[e.nodeIndex], from: e.from, to: e.to }));
    let applied = false;
    for (const edit of edits) {
      const range = document.createRange();
      try {
        range.setStart(edit.node, edit.from);
        range.setEnd(edit.node, edit.to);
        const mark = document.createElement("mark");
        mark.className = "note-mark";
        mark.setAttribute("data-note-id", noteId);
        range.surroundContents(mark);
        applied = true;
      } catch {
        // surroundContents throws on a range that partially selects a non-text node (e.g. a
        // slice crossing an inline-element boundary). Best-effort: skip the slice — the note
        // survives in the drawer/export, only the visual highlight is lost.
      }
    }
    return applied;
  }
  function removeNoteMarks(noteId) {
    document.querySelectorAll('mark.note-mark[data-note-id="' + noteId + '"]').forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    });
  }
  function slideTitleFor(slideIndex) {
    const slide = slides[slideIndex];
    if (!slide) return "";
    const heading = slide.querySelector("h1,h2");
    return slide.dataset.navTitle || (heading && heading.textContent.trim()) || slide.dataset.id || "";
  }

  // Highlight-first flow (single-html annotatable pattern): selecting slide text highlights it
  // IMMEDIATELY; a small popover offers an optional note. The drawer never opens in this flow —
  // it is purely the review/export surface. Clicking an existing highlight reopens its popover
  // ("highlight first, add or edit the note afterwards"); Remove undoes an accidental one.
  function validSelectionRange() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const slide = slides[index];
    if (!slide || !slide.contains(range.commonAncestorContainer)) return null;
    const common = range.commonAncestorContainer;
    const commonEl = common.nodeType === 1 ? common : common.parentElement;
    if (commonEl && (commonEl.closest("mark.note-mark") || commonEl.closest("aside.notes"))) return null;
    if (!range.toString().trim()) return null;
    return range;
  }
  let notePopNoteId = null;
  function closeNotePop() { notePop.hidden = true; notePopNoteId = null; }
  function openNotePop(note, rect) {
    notePopNoteId = note.id;
    notePopText.value = note.note || "";
    notePop.hidden = false;
    const w = notePop.offsetWidth || 280;
    const x = Math.min(Math.max(8, rect.left + (rect.width || 0) / 2 - w / 2), window.innerWidth - w - 8);
    const below = (rect.bottom || rect.top || 0) + 10;
    notePop.style.left = x + "px";
    notePop.style.top = Math.min(below, window.innerHeight - 130) + "px";
    notePopText.focus();
  }
  // Rect for an element or range; getBoundingClientRect is missing on Range in some headless
  // DOMs (jsdom) — fall back to 0,0 rather than dying; clamps keep the popover on-screen.
  function rectFor(target) {
    return typeof target.getBoundingClientRect === "function"
      ? target.getBoundingClientRect()
      : { left: 0, top: 0, bottom: 0, width: 0 };
  }
  function handleSelectionMouseup() {
    const range = validSelectionRange();
    if (!range) return;
    const rect = rectFor(range);
    const note = captureSelection();
    if (note) openNotePop(note, rect);
  }
  function captureSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const slide = slides[index];
    if (!slide || !slide.contains(range.commonAncestorContainer)) return;
    const common = range.commonAncestorContainer;
    const commonEl = common.nodeType === 1 ? common : common.parentElement;
    if (commonEl && (commonEl.closest("mark.note-mark") || commonEl.closest("aside.notes"))) return;
    const quote = range.toString().trim().slice(0, 500);
    if (!quote) return;
    const serialized = serializeSelectionWithin(slide, range);
    noteCounter += 1;
    const note = {
      id: "note-" + noteCounter,
      slideIndex: index,
      slideId: slide.dataset.id || "",
      slideTitle: slideTitleFor(index),
      type: "text",
      quote: quote,
      ranges: serialized ? [serialized] : [],
      note: "",
      createdAt: new Date().toISOString()
    };
    if (serialized) applyNoteRange(slide, serialized, note.id);
    readerNotes.push(note);
    saveNotes();
    // Drawer list refreshes in the background; the drawer itself stays closed (review-only).
    renderMyNotes();
    return note;
  }
  function addImageNote(img) {
    const slide = slides[index];
    noteCounter += 1;
    const note = {
      id: "note-" + noteCounter,
      slideIndex: index,
      slideId: (slide && slide.dataset.id) || "",
      slideTitle: slideTitleFor(index),
      type: "image",
      alt: img.getAttribute("alt") || "image",
      note: "",
      createdAt: new Date().toISOString()
    };
    readerNotes.push(note);
    saveNotes();
    renderMyNotes(note.id);
  }

  function renderNoteRow(note) {
    const row = document.createElement("div");
    row.className = "mynote";
    row.setAttribute("data-note-row", note.id);
    const quote = document.createElement("div");
    quote.className = "mynote-quote";
    quote.textContent = note.type === "image" ? "[Image: " + (note.alt || "image") + "]" : note.quote;
    row.appendChild(quote);
    const input = document.createElement("textarea");
    input.placeholder = "Add your comment";
    input.value = note.note || "";
    input.addEventListener("input", () => { note.note = input.value; saveNotes(); });
    row.appendChild(input);
    const tools = document.createElement("div");
    tools.className = "mynote-tools";
    const jump = document.createElement("button");
    jump.className = "btn";
    jump.type = "button";
    jump.innerHTML = ICON.jump + '<span class="btn-label">Jump</span>';
    jump.addEventListener("click", () => {
      go(note.slideIndex);
      const mark = document.querySelector('mark.note-mark[data-note-id="' + note.id + '"]');
      if (mark && mark.scrollIntoView) mark.scrollIntoView({ block: "center" });
    });
    const del = document.createElement("button");
    del.className = "btn";
    del.type = "button";
    del.innerHTML = ICON.trash + '<span class="btn-label">Delete</span>';
    del.addEventListener("click", () => {
      removeNoteMarks(note.id);
      readerNotes = readerNotes.filter((entry) => entry.id !== note.id);
      saveNotes();
      renderMyNotes();
    });
    tools.appendChild(jump);
    tools.appendChild(del);
    row.appendChild(tools);
    return row;
  }
  function renderMyNotes(focusId) {
    myNotesList.replaceChildren();
    const groups = new Map();
    readerNotes.forEach((note) => {
      if (!groups.has(note.slideIndex)) groups.set(note.slideIndex, []);
      groups.get(note.slideIndex).push(note);
    });
    Array.from(groups.keys()).sort((a, b) => a - b).forEach((slideIndex) => {
      const group = document.createElement("div");
      group.className = "mynotes-group";
      const heading = document.createElement("h3");
      heading.textContent = "Slide " + (slideIndex + 1) + " — " + (groups.get(slideIndex)[0].slideTitle || "");
      group.appendChild(heading);
      groups.get(slideIndex).slice().reverse().forEach((note) => {
        group.appendChild(renderNoteRow(note));
      });
      myNotesList.appendChild(group);
    });
    myNotesHint.hidden = readerNotes.length > 0;
    if (focusId) {
      const focusRow = myNotesList.querySelector('[data-note-row="' + focusId + '"] textarea');
      if (focusRow) focusRow.focus();
    }
  }
  // Re-apply order matters: notes are stored and replayed in capture order, so each note sees
  // the same text-node splits that existed when its offsets were computed. Deleting a note
  // from the middle can drift offsets of later same-block notes — the failure mode is a
  // missing highlight (applyNoteRange skips), never corrupted text or a lost note.
  function reapplyNoteMarks() {
    readerNotes.forEach((note) => {
      if (note.type !== "text" || !Array.isArray(note.ranges)) return;
      const slide = slides[note.slideIndex];
      if (!slide) return;
      note.ranges.forEach((r) => applyNoteRange(slide, r, note.id));
    });
  }

  document.getElementById("myNotesBtn").addEventListener("click", () => myNotesPanel.classList.toggle("open"));
  document.getElementById("closeMyNotes").addEventListener("click", () => myNotesPanel.classList.remove("open"));
  document.querySelector(".stage").addEventListener("mouseup", () => setTimeout(handleSelectionMouseup, 0));
  notePopText.addEventListener("input", () => {
    const note = readerNotes.find((entry) => entry.id === notePopNoteId);
    if (!note) return;
    note.note = notePopText.value;
    saveNotes();
    renderMyNotes();
  });
  notePopText.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); closeNotePop(); }
  });
  document.getElementById("notePopDone").addEventListener("click", () => closeNotePop());
  document.getElementById("notePopRemove").addEventListener("click", () => {
    if (notePopNoteId) {
      removeNoteMarks(notePopNoteId);
      readerNotes = readerNotes.filter((entry) => entry.id !== notePopNoteId);
      saveNotes();
      renderMyNotes();
    }
    closeNotePop();
  });
  // Click on an existing highlight reopens its popover; any other click (that isn't making a
  // new selection and isn't inside the popover) dismisses it.
  document.addEventListener("click", (event) => {
    if (event.target.closest(".note-pop")) return;
    const mark = event.target.closest("mark.note-mark");
    if (mark) {
      const note = readerNotes.find((entry) => entry.id === mark.getAttribute("data-note-id"));
      if (note) { openNotePop(note, rectFor(mark)); return; }
    }
    // A drag-select fires a click on release with the selection still live — don't dismiss the
    // popover that mouseup just opened.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    closeNotePop();
  });

  // === My Notes exports =======================================================================
  // The export is the durable artifact (notes are otherwise this-browser-only). Markdown is the
  // paste-into-chat path; JSON is the machine-readable one. PURE cores are named declarations —
  // extracted by name in scripts/test-share-notes.mjs.
  function notesToMarkdown(deckTitle, notes, exportedAt) {
    const groups = new Map();
    notes.forEach((note) => {
      if (!groups.has(note.slideIndex)) groups.set(note.slideIndex, []);
      groups.get(note.slideIndex).push(note);
    });
    const lines = ["# Notes — " + deckTitle, "", exportedAt, ""];
    Array.from(groups.keys()).sort((a, b) => a - b).forEach((slideIndex) => {
      const group = groups.get(slideIndex);
      lines.push("## Slide " + (slideIndex + 1) + " — " + (group[0].slideTitle || group[0].slideId || ""));
      group.forEach((note) => {
        if (note.type === "image") lines.push("[Image: " + (note.alt || "image") + "]");
        // Quotes flatten to one line: a selection can span line breaks, and a raw newline
        // inside "> ..." would split the blockquote in strict Markdown.
        else if (note.quote) lines.push("> \"" + String(note.quote).replace(/\s+/g, " ") + "\"");
        if (note.note) lines.push(note.note);
        lines.push("");
      });
    });
    return lines.join("\n").trim() + "\n";
  }
  function notesExportPayload(deckTitle, notes, exportedAt) {
    return { schemaVersion: 1, deck: deckTitle, exportedAt: exportedAt, notes: notes };
  }
  function downloadFile(name, text, type) {
    const blob = new Blob([text], { type: type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function flashButton(button, text) {
    const label = button.querySelector(".btn-label") || button;
    const original = label.textContent;
    label.textContent = text;
    setTimeout(() => { label.textContent = original; }, 1400);
  }
  async function copyNotesMarkdown(button) {
    const text = notesToMarkdown(deckTitleText, readerNotes, new Date().toISOString().slice(0, 10));
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {}
    if (!copied) {
      // file:// often blocks the async clipboard API — fall back to the legacy path.
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try { copied = document.execCommand("copy"); } catch {}
      area.remove();
    }
    flashButton(button, copied ? "Copied" : "Copy failed");
  }
  document.getElementById("notesCopyMd").addEventListener("click", (event) => { copyNotesMarkdown(event.currentTarget); });
  document.getElementById("notesDownloadMd").addEventListener("click", () => {
    downloadFile("${slug}-notes.md", notesToMarkdown(deckTitleText, readerNotes, new Date().toISOString().slice(0, 10)), "text/markdown");
  });
  document.getElementById("notesDownloadJson").addEventListener("click", () => {
    downloadFile("${slug}-notes.json", JSON.stringify(notesExportPayload(deckTitleText, readerNotes, new Date().toISOString()), null, 2), "application/json");
  });

  // === Keyboard help overlay ==================================================================
  // SHORTCUTS is the single source for the help modal. Keep it in sync with the keydown
  // handler below — every binding there should have a row here.
  const SHORTCUTS = [
    { keys: ["→", "Space", "PgDn", "↓"], label: "Next slide / step" },
    { keys: ["←", "PgUp", "↑", "⌫"], label: "Previous slide / step" },
    { keys: ["Home", "End"], label: "First / last slide" },
    { keys: ["R"], label: "Reveal mode (step items one by one)" },
    { keys: ["F"], label: "Focus mode (spotlight one item)" },
    { keys: ["Z"], label: "Image gallery (when the slide has images)" },
    { keys: ["O"], label: "Overview panel" },
    { keys: ["/"], label: "Search slides (opens overview)" },
    { keys: ["N"], label: "My Notes drawer (exit Reveal/Focus first)" },
    { keys: ["?"], label: "This help" },
    { keys: ["Esc"], label: "Close panel / exit mode" }
  ];
  const helpOverlay = document.getElementById("helpOverlay");
  const helpRows = document.getElementById("helpRows");
  SHORTCUTS.forEach((item) => {
    const row = document.createElement("div");
    row.className = "help-row";
    const keys = document.createElement("span");
    keys.className = "help-keys";
    item.keys.forEach((k) => {
      const kbd = document.createElement("kbd");
      kbd.textContent = k;
      keys.appendChild(kbd);
    });
    const label = document.createElement("span");
    label.textContent = item.label;
    row.appendChild(keys);
    row.appendChild(label);
    helpRows.appendChild(row);
  });
  function toggleHelp(force) {
    helpOverlay.classList.toggle("open", force);
    // One overlay at a time: opening help closes the side panels, so the Esc that closes help
    // returns the reader to a clean stage (not a panel they'd forgotten was open behind it).
    if (helpOverlay.classList.contains("open")) {
      navPanel.classList.remove("open");
      notesPanel?.classList.remove("open");
    }
  }
  document.getElementById("helpBtn").addEventListener("click", () => toggleHelp());
  document.getElementById("helpClose").addEventListener("click", () => toggleHelp(false));
  helpOverlay.addEventListener("click", (event) => { if (event.target === helpOverlay) toggleHelp(false); });
  window.addEventListener("keydown", (event) => {
    const tag = event.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    // Any deck keystroke retires the note popover (it would float over the wrong slide).
    closeNotePop();
    // Help modal is modal: while open it owns the keyboard (Esc / ? close it).
    if (helpOverlay.classList.contains("open")) {
      if (event.key === "Escape" || event.key === "?") { event.preventDefault(); toggleHelp(false); }
      return;
    }
    // G5: while the gallery is open, arrows browse images and Esc / z close it; deck suspended.
    if (lbOpen) {
      if (["ArrowRight", "ArrowDown", " ", "Enter", "PageDown"].includes(event.key)) { event.preventDefault(); stepLightbox(1); }
      else if (["ArrowLeft", "ArrowUp", "Backspace", "PageUp"].includes(event.key)) { event.preventDefault(); stepLightbox(-1); }
      else if (event.key === "Home") { event.preventDefault(); lbIndex = 0; renderLightbox(); }
      else if (event.key === "End") { event.preventDefault(); lbIndex = lbImages.length - 1; renderLightbox(); }
      else if (event.key === "Escape" || event.key === "z" || event.key === "Z") { event.preventDefault(); closeLightbox(); }
      return;
    }
    // "?" opens help from anywhere except the gallery (which owns the keyboard while open).
    if (event.key === "?") { event.preventDefault(); toggleHelp(true); return; }
    // "/" opens the overview focused on its search box — a global find from anywhere.
    if (event.key === "/") { event.preventDefault(); overview.open(); return; }
    // R / F toggle the optional stepping modes (mutually exclusive). They always work.
    if (event.key === "r" || event.key === "R") { event.preventDefault(); toggleMode("reveal"); return; }
    if (event.key === "f" || event.key === "F") { event.preventDefault(); toggleMode("focus"); return; }
    // While a mode is on, arrows step it. On a cards slide → drives the cards and N/P step the
    // mode within the active card; on other slides arrows AND N/P step the mode. Esc exits.
    if (modeKind) {
      if (event.key === "Escape") { event.preventDefault(); exitMode(); return; }
      if (event.key === "n" || event.key === "N") { event.preventDefault(); stepMode(1); return; }
      if (event.key === "p" || event.key === "P") { event.preventDefault(); stepMode(-1); return; }
      if (["ArrowRight", "ArrowDown", " ", "Enter", "PageDown"].includes(event.key)) { event.preventDefault(); goNext(); return; }
      if (["ArrowLeft", "ArrowUp", "Backspace", "PageUp"].includes(event.key)) { event.preventDefault(); goPrev(); return; }
      if (event.key === "Home") { event.preventDefault(); go(0); return; }
      if (event.key === "End") { event.preventDefault(); go(slides.length - 1); return; }
      return;
    }
    if (["ArrowRight", "ArrowDown", " ", "Enter", "PageDown"].includes(event.key)) { event.preventDefault(); goNext(); }
    else if (["ArrowLeft", "ArrowUp", "Backspace", "PageUp"].includes(event.key)) { event.preventDefault(); goPrev(); }
    else if (event.key === "Home") { event.preventDefault(); go(0); }
    else if (event.key === "End") { event.preventDefault(); go(slides.length - 1); }
    else if (event.key === "z" || event.key === "Z") { event.preventDefault(); openLightbox(0); }
    else if (event.key === "o" || event.key === "O") { event.preventDefault(); overview.toggle(); }
    else if (event.key === "n" || event.key === "N") { event.preventDefault(); myNotesPanel.classList.toggle("open"); }
    else if (event.key === "Escape") { navPanel.classList.remove("open"); notesPanel?.classList.remove("open"); myNotesPanel.classList.remove("open"); }
  });
  window.addEventListener("hashchange", () => {
    const nextIndex = slides.findIndex((slide) => slide.dataset.id === location.hash.slice(1));
    if (nextIndex >= 0) go(nextIndex);
  });
  loadNotes();
  reapplyNoteMarks();
  renderMyNotes();
  // Handouts open in complete mode — no authored {data-mode} auto-entry; Reveal is opt-in.
  // Give the chrome buttons their leading icon (skips the speaker-notes button if absent).
  const BTN_ICONS = { prevBtn: ICON.prev, nextBtn: ICON.next, overviewBtn: ICON.overview, revealBtn: ICON.reveal, myNotesBtn: ICON.note, notesBtn: ICON.speaker, printBtn: ICON.print, closeOverview: ICON.close, closeNotes: ICON.close, closeMyNotes: ICON.close, notesCopyMd: ICON.copy, notesDownloadMd: ICON.download, notesDownloadJson: ICON.braces, notePopDone: ICON.check };
  Object.keys(BTN_ICONS).forEach((id) => {
    const el = document.getElementById(id);
    if (el && el.querySelector(".btn-label") && !el.querySelector(".btn-ico")) el.insertAdjacentHTML("afterbegin", BTN_ICONS[id]);
  });
  render();
  applyModeDimming();
  applyGallery();
})();
</script>
</body>
</html>
`;
}

function buildLocalLaunchEnhancement() {
  return String.raw`
<style data-local-launch-tools>
.stale-build-banner {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 9999;
  display: flex;
  gap: 14px;
  align-items: center;
  justify-content: center;
  padding: 10px 16px;
  background: #9f1239;
  color: #fff;
  font: 600 15px/1.3 -apple-system, system-ui, sans-serif;
}
.stale-build-banner button {
  padding: 5px 14px;
  border: 0;
  border-radius: 7px;
  background: #fff;
  color: #9f1239;
  font-weight: 700;
  cursor: pointer;
}
.local-launch-toggle {
  position: fixed;
  right: 14px;
  bottom: 72px;
  z-index: 80;
  border: 1px solid #17202a22;
  border-radius: 999px;
  background: #fffdf2;
  color: #17202a;
  box-shadow: 0 14px 34px #0002;
  font: 700 13px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  padding: 10px 13px;
  cursor: pointer;
}
.local-launch-toggle:focus-visible,
.local-launch-panel button:focus-visible,
.local-launch-panel a:focus-visible {
  outline: 3px solid #2563eb;
  outline-offset: 2px;
}
.local-launch-panel {
  position: fixed;
  right: 14px;
  bottom: 120px;
  z-index: 80;
  width: min(460px, calc(100vw - 28px));
  max-height: min(680px, calc(100vh - 86px));
  overflow: auto;
  border: 1px solid #17202a22;
  border-radius: 8px;
  background: #fffdf2;
  color: #17202a;
  box-shadow: 0 24px 64px #0003;
  padding: 14px;
  font: 14px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.local-launch-panel[hidden] { display: none; }
@media print {
  .local-launch-toggle,
  .local-launch-panel { display: none !important; }
}
.local-launch-panel h2 {
  margin: 0 0 10px;
  font-size: 16px;
  line-height: 1.2;
}
.local-launch-panel h3 {
  margin: 14px 0 8px;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: .08em;
  color: #5b6572;
}
.local-launch-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.local-launch-panel button,
.local-launch-panel a.local-launch-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 28px;
  border: 1px solid #17202a22;
  border-radius: 6px;
  background: #ffffff;
  color: #2a333d;
  font: 600 12px/1.1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  text-decoration: none;
  padding: 5px 9px;
  cursor: pointer;
  transition: background .12s ease, border-color .12s ease;
}
.local-launch-panel button:hover,
.local-launch-panel a.local-launch-link:hover {
  background: #f3eee3;
  border-color: #17202a40;
}
.local-launch-panel button.lp-primary {
  background: #0b3a6b;
  border-color: #0b3a6b;
  color: #fff;
}
.local-launch-panel button.lp-primary:hover { background: #0d4684; border-color: #0d4684; }
.local-launch-panel .lp-ico { display: inline-flex; opacity: .85; }
.local-launch-panel .lp-ico svg { width: 14px; height: 14px; display: block; }
.local-launch-handout {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  align-items: center;
}
a.local-launch-handout-link {
  display: inline-flex;
  align-items: center;
  text-align: left;
  text-decoration: none;
  font-weight: 600;
  font-size: 12px;
  color: #0b3a6b;
  background: #edf2f9;
  border: 1px solid #0b3a6b26;
  border-radius: 6px;
  padding: 6px 10px;
  overflow-wrap: anywhere;
}
a.local-launch-handout-link:hover { background: #e1eaf6; }
.local-launch-url {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 7px;
  align-items: center;
  margin: 6px 0;
}
.local-launch-url code {
  min-width: 0;
  overflow-wrap: anywhere;
  border: 1px solid #17202a14;
  border-radius: 7px;
  background: #fff;
  padding: 7px 8px;
  font-size: 12px;
}
.local-launch-qr {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 12px;
  align-items: center;
}
.local-launch-qr svg {
  width: 132px;
  height: 132px;
  image-rendering: pixelated;
  border: 1px solid #17202a14;
  background: #fff;
}
.local-launch-muted {
  color: #5b6572;
  font-size: 12px;
}
.publish-ok { color: #1a7f4b; font-weight: 600; font-size: 13px; }
.publish-warn { color: #9f1239; font-weight: 600; font-size: 13px; }
.publish-log { white-space: pre-wrap; font-size: 11px; color: #5b6572; max-height: 140px; overflow: auto; margin: 6px 0 0; background: #f4efe5; padding: 6px 8px; border-radius: 6px; }
.local-launch-status {
  display: grid;
  gap: 6px;
  margin: 8px 0 0;
}
.local-launch-status div {
  border: 1px solid #17202a14;
  border-radius: 7px;
  background: #fff;
  padding: 7px 8px;
}
.local-launch-file {
  display: grid;
  gap: 6px;
  margin: 8px 0 14px;
}
.local-launch-file code {
  min-width: 0;
  overflow-wrap: anywhere;
  border: 1px solid #17202a14;
  border-radius: 7px;
  background: #fff;
  padding: 7px 8px;
  font-size: 12px;
}
.local-launch-file-label {
  font-weight: 700;
  font-size: 12px;
}
.local-launch-advanced {
  margin-top: 18px;
  border-top: 1px solid #17202a22;
  padding-top: 10px;
}
.local-launch-advanced summary {
  cursor: pointer;
  font: 700 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  text-transform: uppercase;
  letter-spacing: .08em;
  color: #5b6572;
}
.local-launch-advanced summary:hover { color: #17202a; }
/* Slide grid (S) — every slide as a scaled live clone, grouped by section. Local app only. */
.slide-grid-overlay {
  position: fixed;
  inset: 0;
  z-index: 76;
  overflow: auto;
  background: var(--paper, #f7f3ea);
  color: var(--ink, #17202a);
  padding: 0 22px 90px;
  font: 14px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.slide-grid-top {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 14px 0 10px;
  margin-bottom: 16px;
  background: var(--paper, #f7f3ea);
  border-bottom: 1px solid var(--line, #d9d0c1);
}
.slide-grid-top h2 { margin: 0; font-size: 16px; }
.slide-grid-hint { color: var(--muted, #5d6875); font-size: 12px; }
.slide-grid-spacer { flex: 1; }
.slide-grid-overlay button {
  border: 1px solid #17202a24;
  border-radius: 7px;
  background: #fff;
  color: var(--ink, #17202a);
  font: 700 12px/1.1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  padding: 7px 10px;
  cursor: pointer;
}
.slide-grid-overlay button:hover { border-color: #2563eb66; }
.slide-grid-overlay button:focus-visible,
.slide-grid-check:focus-visible {
  outline: 3px solid #2563eb;
  outline-offset: 2px;
}
.slide-grid-section-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 26px 0 10px;
}
.slide-grid-section-head h3 {
  margin: 0;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: .08em;
  color: var(--muted, #5d6875);
}
.slide-grid-section-head.slide-grid-sub { margin: 14px 0 8px; }
.slide-grid-section-head.slide-grid-sub h3 { text-transform: none; letter-spacing: 0; }
.slide-grid-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--sg-thumb, 230px), 1fr));
  gap: 14px;
}
.slide-grid-zoom { width: 130px; accent-color: var(--accent, #0b3a6b); }
/* Rebuild notice (Editing Mode): offered when the bundle was rebuilt underneath a live
   window (a Save from /edit). Never auto-reloads. */
.rebuild-toast {
  position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 96;
  display: flex; gap: 12px; align-items: center;
  background: var(--ink, #17202a); color: #fff; border-radius: 999px;
  padding: 10px 12px 10px 20px; box-shadow: 0 14px 34px #0006;
  font: 700 13.5px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.rebuild-toast button {
  font: 700 12.5px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #fff; background: var(--accent, #0b3a6b); border: 0; border-radius: 999px;
  padding: 8px 14px; cursor: pointer;
}
.rebuild-toast button:hover { filter: brightness(1.15); }
.rebuild-toast .rebuild-toast-dismiss { background: #3c4a5b; }
.slide-grid-card {
  position: relative;
  border: 1px solid var(--line, #d9d0c1);
  border-radius: 8px;
  background: var(--panel, #fffdf8);
  padding: 0 0 6px;
  cursor: pointer;
  text-align: left;
}
.slide-grid-card:focus-visible { outline: 3px solid #2563eb; outline-offset: 2px; }
.slide-grid-card.selected { outline: 3px solid var(--accent, #0b3a6b); outline-offset: 1px; }
.slide-grid-thumb {
  position: relative;
  overflow: hidden;
  border-radius: 8px 8px 0 0;
  background: var(--paper, #f7f3ea);
  border-bottom: 1px solid var(--line, #d9d0c1);
}
.slide-grid-thumb .slide {
  display: grid !important;
  position: absolute;
  inset: auto;
  top: 0;
  left: 0;
  transform-origin: top left;
  pointer-events: none;
}
.slide-grid-media-ph {
  display: grid;
  place-items: center;
  min-height: 320px;
  border: 2px dashed var(--line, #d9d0c1);
  border-radius: 12px;
  background: #17202a0a;
  color: var(--muted, #5d6875);
  font: 600 54px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.slide-grid-caption {
  display: flex;
  gap: 7px;
  align-items: baseline;
  padding: 7px 10px 2px;
  font-size: 12px;
}
.slide-grid-num { font-weight: 700; color: var(--muted, #5d6875); }
.slide-grid-caption .slide-grid-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.slide-grid-controls {
  position: absolute;
  top: 8px;
  left: 8px;
  right: 8px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  z-index: 2;
}
.slide-grid-check {
  width: 18px;
  height: 18px;
  accent-color: var(--accent, #0b3a6b);
  cursor: pointer;
}
.slide-grid-copy { opacity: 0; }
.slide-grid-card:hover .slide-grid-copy,
.slide-grid-copy:focus-visible { opacity: 1; }
.slide-grid-bar {
  position: fixed;
  left: 50%;
  bottom: 18px;
  transform: translateX(-50%);
  z-index: 77;
  display: flex;
  gap: 10px;
  align-items: center;
  background: var(--ink, #17202a);
  color: #fff;
  border-radius: 999px;
  padding: 9px 12px 9px 18px;
  box-shadow: 0 14px 34px #0005;
  font: 700 13px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.slide-grid-bar[hidden] { display: none; }
.slide-grid-bar button { border: 0; border-radius: 999px; font-weight: 700; }
.slide-grid-fallback {
  position: fixed;
  left: 50%;
  bottom: 70px;
  transform: translateX(-50%);
  z-index: 78;
  width: min(640px, 90vw);
  background: var(--panel, #fffdf8);
  border: 1px solid var(--line, #d9d0c1);
  border-radius: 8px;
  padding: 10px;
  box-shadow: 0 24px 64px #0003;
}
.slide-grid-fallback textarea { width: 100%; height: 140px; }
.copy-source-toast {
  position: fixed;
  left: 50%;
  bottom: 64px;
  transform: translateX(-50%);
  z-index: 90;
  display: none;
  background: var(--ink, #17202a);
  color: #fff;
  border-radius: 8px;
  padding: 9px 16px;
  box-shadow: 0 14px 34px #0004;
  font: 600 13px/1.3 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
@media print {
  .slide-grid-overlay, .slide-grid-bar, .slide-grid-fallback, .copy-source-toast { display: none !important; }
}
</style>
<script data-local-launch-tools>
(() => {
  const params = new URLSearchParams(location.search);
  if (params.has("presenter") || params.has("audience")) return;

  const nextKeys = new Set(["ArrowRight", "ArrowDown", "PageDown", " ", "Enter", "MediaTrackNext", "N", "n"]);
  const previousKeys = new Set(["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "MediaTrackPrevious", "P", "p"]);
  let clickerTestActive = false;
  let generatedSession = "";

  function makeSession() {
    if (!generatedSession) {
      generatedSession = window.crypto && crypto.randomUUID
        ? crypto.randomUUID()
        : "local-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
    }
    return generatedSession;
  }

  function deckUrl(extraParams) {
    const url = new URL(location.pathname || "/", location.href);
    url.search = "";
    url.hash = location.hash;
    for (const pair of Object.entries(extraParams || {})) {
      url.searchParams.set(pair[0], pair[1]);
    }
    return url.href;
  }

  function bundleUrl(path) {
    return new URL(path, location.origin + "/").href;
  }

  async function loadManifest() {
    try {
      const response = await fetch("/presentation.json", { cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      return await response.json();
    } catch {
      return {
        title: document.title || "Presentation",
        exports: {},
        hosting: { policy: "unknown" },
        local_app: {}
      };
    }
  }

  function createElement(tag, attrs, children) {
    const element = document.createElement(tag);
    for (const pair of Object.entries(attrs || {})) {
      const key = pair[0];
      const value = pair[1];
      if (key === "className") element.className = value;
      else if (key === "text") element.textContent = value;
      else if (key === "html") element.innerHTML = value;
      else if (value !== null && value !== undefined) element.setAttribute(key, String(value));
    }
    for (const child of children || []) {
      element.append(child);
    }
    return element;
  }

  // Small, consistent button glyphs (Lucide-style: 24-viewBox, 2px round stroke, currentColor).
  // Hand-picked per action; rendered at 14px. Kept inline so the panel needs no icon runtime.
  const LP_ICONS = {
    publish: '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M20 15v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    icons: '<circle cx="8.5" cy="8.5" r="4.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/>',
    rebuild: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v5h-5"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'
  };
  function iconButton(label, iconName, attrs) {
    const button = createElement("button", Object.assign({ type: "button" }, attrs || {}));
    button.append(
      createElement("span", { className: "lp-ico", html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (LP_ICONS[iconName] || "") + "</svg>" }),
      createElement("span", { className: "lp-label", text: label })
    );
    return button;
  }

  function copyButton(value, label) {
    const idle = label || "Copy";
    const button = createElement("button", { type: "button", text: idle });
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(value);
        button.textContent = "Copied";
        setTimeout(() => { button.textContent = idle; }, 1200);
      } catch {
        button.textContent = "Select";
        setTimeout(() => { button.textContent = idle; }, 1200);
      }
    });
    return button;
  }

  function urlRow(label, value) {
    return createElement("div", { className: "local-launch-url" }, [
      createElement("code", { text: label + ": " + value }),
      copyButton(value)
    ]);
  }

  // QR encoder — INJECTED from the shared build-time/runtime source (qrGeneratorSource). The
  // runtime encodes the presenter CURRENT local deck URL (unknown at build time), so the same
  // algorithm the build-time QR directive uses ships here verbatim: one source, identical output.
  // gfTables, gf and makeQrSvg are declared by the injected source.
  ${qrGeneratorSource(JSON.stringify("QR code for local deck URL"))}

  function classifyKey(event) {
    if (nextKeys.has(event.key)) return "Next slide";
    if (previousKeys.has(event.key)) return "Previous slide";
    if (event.key === "Home") return "First slide";
    if (event.key === "End") return "Last slide";
    if (event.key === "f" || event.key === "F") return "Fullscreen";
    return "Unmapped";
  }

  function openPresenter() {
    const session = makeSession();
    window.open(deckUrl({ presenter: "1", session }), "presentation-presenter-" + session, "popup,width=1220,height=820");
  }

  function openAudience() {
    const session = makeSession();
    window.open(deckUrl({ audience: "1", session }), "presentation-audience-" + session, "popup,width=1280,height=720");
  }

  function preflightRow(label, status, detail) {
    return createElement("div", { text: label + ": " + status + (detail ? " - " + detail : "") });
  }

  async function fetchStatus(url) {
    try {
      let response = await fetch(url, { method: "HEAD", cache: "no-store" });
      if (!response.ok || response.status === 405) response = await fetch(url, { cache: "no-store" });
      return { ok: response.ok, status: response.status };
    } catch (error) {
      return { ok: false, status: error.message };
    }
  }

  async function fetchText(url) {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    return response.text();
  }

  function privateTextPatterns() {
    return [
      new RegExp("/" + "Users/[A-Za-z0-9._-]+", "i"),
      new RegExp("Nexus" + "365", "i"),
      // OneDrive only as a leaked PATH, not the bare word (legitimate slide content). See 08-source-adapters.
      new RegExp("[\\\\/]One" + "Drive|One" + "Drive\\s*-\\s*\\w", "i"),
      new RegExp("CF" + "_API", "i"),
      new RegExp("api" + "[_-]?" + "token", "i"),
      new RegExp("account" + "[_-]?" + "id", "i")
    ];
  }

  function shareRuntimePatterns() {
    // localStorage allowed: reader notes are local-only (My Notes); this guard targets presenter sync.
    return [
      /BroadcastChannel/,
      /postMessage/,
      /Open Presenter View/,
      /\bpresenter=1\b/,
      /\baudience=1\b/
    ];
  }

  async function checkExports(manifest) {
    const exports = manifest.exports || {};
    const paths = [
      exports.html_full && exports.html_full.path,
      exports.html_share_notes && exports.html_share_notes.path,
      exports.html_share_no_notes && exports.html_share_no_notes.path
    ].filter(Boolean);
    if (paths.length === 0) return { ok: false, detail: "No exports declared in presentation.json." };
    const checks = await Promise.all(paths.map(async (path) => {
      const status = await fetchStatus(bundleUrl(path));
      return { path, status };
    }));
    const missing = checks.filter((check) => !check.status.ok);
    return {
      ok: missing.length === 0,
      detail: missing.length === 0
        ? paths.length + " export file(s) reachable."
        : missing.map((check) => check.path + " (" + check.status.status + ")").join("; ")
    };
  }

  async function checkSharePrivacy(manifest) {
    const exports = manifest.exports || {};
    const sharePaths = [
      { label: "share notes", path: exports.html_share_notes && exports.html_share_notes.path, notes: true },
      { label: "share no notes", path: exports.html_share_no_notes && exports.html_share_no_notes.path, notes: false }
    ].filter((item) => item.path);
    if (sharePaths.length === 0) return { ok: false, detail: "No share exports declared." };
    const privatePatterns = privateTextPatterns();
    const runtimePatterns = shareRuntimePatterns();
    const failures = [];
    for (const item of sharePaths) {
      try {
        const text = await fetchText(bundleUrl(item.path));
        if (privatePatterns.some((pattern) => pattern.test(text))) failures.push(item.label + " has private-looking text");
        if (runtimePatterns.some((pattern) => pattern.test(text))) failures.push(item.label + " has presenter sync code");
        if (!item.notes && /<aside\b[^>]*class=["'][^"']*\bnotes\b/i.test(text)) failures.push(item.label + " has notes");
      } catch (error) {
        failures.push(item.label + " unreadable: " + error.message);
      }
    }
    return {
      ok: failures.length === 0,
      detail: failures.length === 0 ? "Share exports look stripped." : failures.join("; ")
    };
  }

  async function checkAssets() {
    const candidates = [];
    document.querySelectorAll("[src],link[href]").forEach((element) => {
      const raw = element.getAttribute("src") || element.getAttribute("href");
      if (!raw || raw.startsWith("#") || /^(data:|blob:|mailto:|javascript:|about:)/i.test(raw)) return;
      const url = new URL(raw, location.href);
      if (url.origin !== location.origin) {
        candidates.push({ label: raw, remote: true });
      } else {
        candidates.push({ label: raw, url: url.href });
      }
    });
    const remote = candidates.filter((candidate) => candidate.remote);
    const local = candidates.filter((candidate) => candidate.url);
    const checks = await Promise.all(local.map(async (candidate) => {
      return { candidate, status: await fetchStatus(candidate.url) };
    }));
    const missing = checks.filter((check) => !check.status.ok);
    return {
      ok: remote.length === 0 && missing.length === 0,
      detail: remote.length === 0 && missing.length === 0
        ? local.length + " linked asset(s) reachable; no remote asset links found."
        : remote.map((item) => "remote " + item.label).concat(missing.map((check) => check.candidate.label + " (" + check.status.status + ")")).join("; ")
    };
  }

  async function checkSyncChannels() {
    const deckId = document.body.dataset.deckId || location.pathname;
    const session = "preflight-" + Date.now().toString(36);
    const key = "html-presentations:" + deckId + ":" + session + ":state";
    const value = JSON.stringify({ index: 0, reveal: 0, seq: 1, updatedAt: Date.now() });
    let storageOk = false;
    try {
      localStorage.setItem(key, value);
      storageOk = localStorage.getItem(key) === value;
      localStorage.removeItem(key);
    } catch {
      storageOk = false;
    }
    let broadcastOk = false;
    if ("BroadcastChannel" in window) {
      broadcastOk = await new Promise((resolve) => {
        const channelName = "html-presentations:" + deckId + ":" + session;
        const left = new BroadcastChannel(channelName);
        const right = new BroadcastChannel(channelName);
        const timer = setTimeout(() => {
          left.close();
          right.close();
          resolve(false);
        }, 400);
        right.addEventListener("message", (event) => {
          if (event.data && event.data.type === "preflight") {
            clearTimeout(timer);
            left.close();
            right.close();
            resolve(true);
          }
        });
        left.postMessage({ type: "preflight" });
      });
    }
    return {
      ok: storageOk && broadcastOk,
      detail: "localStorage " + (storageOk ? "ok" : "blocked") + ", BroadcastChannel " + (broadcastOk ? "ok" : "blocked")
    };
  }

  // Stale-build banner (2026-06-10): a rebuild never refreshes an already-open tab — the
  // single most repeated confusion in practice ("the fix isn't there" → it was, on disk).
  // The page remembers the build-log timestamp it loaded with and polls for a newer one;
  // when the bundle is rebuilt underneath, a reload banner appears. Server-served only.
  async function watchForRebuilds() {
    const latest = async () => {
      try {
        const text = await (await fetch("/build-log.jsonl", { cache: "no-store" })).text();
        const lines = text.trim().split("\n").filter(Boolean);
        return lines.length ? (JSON.parse(lines[lines.length - 1]).timestamp || null) : null;
      } catch { return null; }
    };
    const loadedStamp = await latest();
    if (!loadedStamp) return; // file:// viewing or no build log — nothing to watch
    let shown = false;
    setInterval(async () => {
      if (shown) return;
      const current = await latest();
      if (current && current !== loadedStamp) {
        shown = true;
        const reload = createElement("button", { type: "button", text: "Reload" });
        reload.addEventListener("click", () => location.reload());
        const banner = createElement("div", { className: "stale-build-banner" }, [
          createElement("span", { text: "This presentation was rebuilt — this tab is showing the older version." }),
          reload
        ]);
        document.body.append(banner);
      }
    }, 5000);
  }
  watchForRebuilds();

  // Files section (2026-06-10): the on-disk exports, each with Reveal-in-Finder (the server
  // does it — browsers block file:// from http pages) and a copyable absolute path.
  async function populateFilesSection(target, manifest) {
    let info = null;
    try { info = await (await fetch("/talk-info")).json(); } catch { /* file:// */ }
    if (!info || !info.bundleDir) {
      target.append(createElement("div", { className: "local-launch-muted", text: "File actions need the local server (present.command)." }));
      return;
    }
    const exports = manifest.exports || {};
    const entries = [
      ["Full", exports.html_full && exports.html_full.path],
      ["Share notes", exports.html_share_notes && exports.html_share_notes.path],
      ["Share no notes", exports.html_share_no_notes && exports.html_share_no_notes.path]
    ].filter((e) => e[1]);
    for (const [label, rel] of entries) {
      const absolute = info.bundleDir + "/" + rel;
      const name = rel.split("/").pop();
      const reveal = createElement("button", { type: "button", text: "Reveal in Finder" });
      reveal.addEventListener("click", () => { fetch("/reveal?f=" + encodeURIComponent(name)).catch(() => {}); });
      target.append(createElement("div", { className: "local-launch-file" }, [
        createElement("div", { className: "local-launch-file-label", text: label }),
        createElement("code", { text: absolute }),
        createElement("div", { className: "local-launch-grid" }, [
          createElement("a", { className: "local-launch-link", href: bundleUrl(rel), target: "_blank", rel: "noopener", text: "Open" }),
          reveal,
          copyButton(absolute, "Copy path")
        ])
      ]));
    }
  }

  // Copy slide source (2026-06-10): VERBATIM outline markdown, stamped with {from=slug#id}
  // lineage (ADR-0002 — reuse is a materialised copy that records its origin) and with asset
  // paths made ABSOLUTE via /talk-info, so Obsidian or any markdown editor previews the images
  // and the importer re-resolves them on the next build. buildCopyPayload is the ONE assembler —
  // the panel button, the C shortcut, the footer button and the slide grid all go through it.
  let projectionsCache = null;
  async function loadProjections() {
    if (projectionsCache) return projectionsCache;
    const res = await fetch("/app/per-slide-projections.jsonl");
    if (!res.ok) throw new Error("missing");
    projectionsCache = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    return projectionsCache;
  }
  let talkInfoCache = null;
  async function loadTalkInfo() {
    if (talkInfoCache) return talkInfoCache;
    try { talkInfoCache = await (await fetch("/talk-info")).json(); } catch { talkInfoCache = {}; }
    return talkInfoCache;
  }
  function absolutizeAssetPaths(text, talkDir) {
    if (!talkDir) return text;
    let out = text.replace(/\]\((assets\/[^)]+)\)/g, (m, rel) => "](" + talkDir + "/" + rel + ")");
    out = out.replace(/^(\[(?:Embed|Simulation|Video):\s*)(assets\/[^\]]+)(\])/gim, (m, head, rel, tail) => head + talkDir + "/" + rel + tail);
    return out;
  }
  function stampLineage(markdown, origin) {
    const lines = markdown.split("\n");
    if (lines.length && /^###\s/.test(lines[0]) && lines[0].indexOf("{from=") === -1) {
      lines[0] += " {from=" + origin + "}";
    }
    return lines.join("\n");
  }
  // Combined copy: slides in DECK order regardless of pick order. Section dividers carry no
  // source_markdown, so a "## Section" (and, for nested groups, "### Sub") heading is
  // RECONSTRUCTED from the divider's nav title — and emitted only when EVERY copyable slide of
  // that group is in the selection. A partial pick is just slides, pasteable mid-section.
  async function buildCopyPayload(slideIds, manifest) {
    const projections = await loadProjections();
    const info = await loadTalkInfo();
    const talkDir = info && info.talkDir ? info.talkDir : "";
    const byId = new Map(projections.map((r) => [r.slide_id, r]));
    const wanted = slideIds.map((id) => byId.get(id)).filter((r) => r && r.source_markdown);
    if (wanted.length === 0) return null;
    wanted.sort((a, b) => a.order - b.order);
    const wantedIds = new Set(wanted.map((r) => r.slide_id));
    const copyableOf = (field, key) => projections.filter((r) => r.source_markdown && r[field] === key);
    const coversAll = (field, key) => copyableOf(field, key).every((r) => wantedIds.has(r.slide_id));
    const groupTitle = (role, field, key) => {
      const divider = projections.find((r) => r.role === role && r[field] === key);
      return (divider && divider.nav_title) || key;
    };
    const slug = manifest.slug || "unknown";
    const parts = [];
    let lastSection = null;
    let lastSubsection = null;
    for (const record of wanted) {
      if (record.section !== lastSection) {
        lastSection = record.section;
        lastSubsection = null;
        if (record.section && coversAll("section", record.section)) {
          parts.push("## " + groupTitle("section-title", "section", record.section));
        }
      }
      const sub = record.subsection || "";
      if (sub !== lastSubsection) {
        lastSubsection = sub;
        if (sub && coversAll("subsection", sub)) {
          parts.push("### " + groupTitle("subsection-title", "subsection", sub));
        }
      }
      parts.push(stampLineage(absolutizeAssetPaths(record.source_markdown, talkDir), slug + "#" + record.slide_id));
    }
    const provenance = "<!-- reused from " + slug
      + (info && info.outline ? " | " + info.outline : "")
      + " | " + wanted.length + " slide(s) | copied " + new Date().toISOString().slice(0, 10) + " -->";
    return { text: provenance + "\n\n" + parts.join("\n\n") + "\n", count: wanted.length };
  }
  function activeSlideId() {
    const active = document.querySelector(".slide.active");
    return active ? active.getAttribute("data-id") : "";
  }
  async function copySlideSource(manifest, statusEl) {
    const note = (text) => statusEl.replaceChildren(createElement("div", { text }));
    const slideId = activeSlideId();
    if (!slideId) { note("No active slide."); return; }
    let payload = null;
    try {
      payload = await buildCopyPayload([slideId], manifest);
    } catch {
      note("Slide sources unavailable — open the presentation via its local server (present.command).");
      return;
    }
    if (!payload) {
      note("This slide is auto-generated (title/section divider) — no outline source to copy.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload.text);
      note("Copied " + slideId + " — paste anywhere; image paths are absolute so editors preview them.");
    } catch {
      note("Clipboard blocked — select and copy below:");
      const ta = document.createElement("textarea");
      ta.value = payload.text;
      ta.readOnly = true;
      ta.style.width = "100%";
      ta.style.height = "120px";
      statusEl.append(ta);
      ta.focus();
      ta.select();
    }
  }
  let toastEl = null;
  let toastTimer = 0;
  function toast(message) {
    if (!toastEl) {
      toastEl = createElement("div", { className: "copy-source-toast" });
      document.body.append(toastEl);
    }
    toastEl.textContent = message;
    toastEl.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.display = "none"; }, 2000);
  }
  // Quick copy (C / footer button): same payload as the panel button, toast feedback. The
  // clipboard-blocked case points at the Tools panel, which has the select-and-copy fallback.
  async function quickCopySource(manifest) {
    const slideId = activeSlideId();
    if (!slideId) { toast("No active slide."); return; }
    let payload = null;
    try {
      payload = await buildCopyPayload([slideId], manifest);
    } catch {
      toast("Slide sources need the local server (present.command).");
      return;
    }
    if (!payload) { toast("No source to copy — this slide is auto-generated."); return; }
    try {
      await navigator.clipboard.writeText(payload.text);
      toast("Copied source of " + slideId + ".");
    } catch {
      toast("Clipboard blocked — use Tools, Copy slide source.");
    }
  }

  // Slide grid (S, 2026-06-10): every slide as a scaled LIVE clone (real layout, images,
  // colours — what you need to recognise a slide worth reusing), grouped by section. Click
  // jumps (the deck runtime's hashchange listener does the navigation); checkboxes select —
  // shift-click for a range, the section-head checkbox for the whole section. Copying goes
  // through buildCopyPayload. Clones are inert: notes stripped, ids dropped (no duplicate
  // getElementById targets), iframes/videos swapped for a placeholder tile.
  let gridOverlay = null;
  let gridBar = null;
  let gridBarLabel = null;
  let gridFallback = null;
  const gridSelection = new Set();
  let gridLastToggled = "";
  let gridCopyableIds = [];
  let gridZoomNudge = null; // set when the grid opens (zoom +/- keys)

  // ── Editing Mode door (decision editor-staged-drafts, 2026-06-12) ──────────
  // The grid is BROWSING/REVIEW ONLY — all editing lives in the /edit page (staged drafts,
  // one commit per Save). The grid only checks whether editing is available so it can show
  // the "Edit" door; file:// or a missing repo hides it silently.
  let editorState = null; // null | {editable, ...}
  async function fetchEditorState() {
    if (!/^https?:$/.test(location.protocol)) return null;
    try {
      const res = await fetch("/editor/state");
      return await res.json();
    } catch {
      return null;
    }
  }
  function openEditingMode() {
    if (editorState && editorState.editable) window.open("/edit", "_blank");
  }
  // Edit icons (/edit-icons): like openEditingMode but for the per-bullet icon picker. editorState
  // may not be fetched yet when a panel button is clicked, so fetch-then-open; the page itself
  // shows a clear "editor unavailable" note when there's no local server, so opening is always safe.
  function openEditIcons() {
    if (editorState) { if (editorState.editable) window.open("/edit-icons", "_blank"); return; }
    fetchEditorState().then((st) => { editorState = st; if (st && st.editable) window.open("/edit-icons", "_blank"); });
  }

  function slideThumb(slide) {
    const w = Math.max(window.innerWidth, 320);
    const h = Math.max(window.innerHeight, 240);
    const thumb = createElement("div", { className: "slide-grid-thumb" });
    thumb.style.aspectRatio = w + " / " + h;
    const clone = slide.cloneNode(true);
    clone.classList.remove("active", "mode-reveal", "mode-focus", "mode-active");
    clone.removeAttribute("id");
    clone.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
    clone.querySelectorAll("aside.notes").forEach((el) => el.remove());
    clone.querySelectorAll("[data-mode-state]").forEach((el) => el.removeAttribute("data-mode-state"));
    clone.querySelectorAll("iframe, video").forEach((el) => {
      el.replaceWith(createElement("div", { className: "slide-grid-media-ph", text: el.tagName === "VIDEO" ? "Video" : "Embed" }));
    });
    clone.setAttribute("aria-hidden", "true");
    // vw/vh inside slides resolve against the REAL viewport, so the clone is laid out at the
    // real viewport size and scaled down as one unit — that is what keeps thumbnails faithful.
    clone.style.width = w + "px";
    clone.style.height = h + "px";
    thumb.append(clone);
    requestAnimationFrame(() => {
      if (thumb.clientWidth > 0) clone.style.transform = "scale(" + (thumb.clientWidth / w) + ")";
    });
    return thumb;
  }

  function setGridSelected(id, on) {
    if (on) gridSelection.add(id); else gridSelection.delete(id);
    const card = gridOverlay ? gridOverlay.querySelector('[data-slide-id="' + id + '"]') : null;
    if (card) {
      card.classList.toggle("selected", on);
      const check = card.querySelector(".slide-grid-check");
      if (check) check.checked = on;
    }
  }

  function updateGridBar() {
    if (!gridBar) return;
    gridBar.hidden = gridSelection.size === 0;
    if (gridBarLabel) gridBarLabel.textContent = gridSelection.size + " selected";
  }

  function toggleGridSelection(id, on, shiftRange) {
    if (shiftRange && gridLastToggled && gridLastToggled !== id) {
      const a = gridCopyableIds.indexOf(gridLastToggled);
      const b = gridCopyableIds.indexOf(id);
      if (a !== -1 && b !== -1) {
        for (let i = Math.min(a, b); i <= Math.max(a, b); i += 1) setGridSelected(gridCopyableIds[i], on);
      } else {
        setGridSelected(id, on);
      }
    } else {
      setGridSelected(id, on);
    }
    gridLastToggled = id;
    updateGridBar();
  }

  function showGridFallback(text) {
    if (gridFallback) gridFallback.remove();
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.readOnly = true;
    gridFallback = createElement("div", { className: "slide-grid-fallback" }, [
      createElement("div", { className: "local-launch-muted", text: "Clipboard blocked — select and copy:" }),
      ta
    ]);
    document.body.append(gridFallback);
    ta.focus();
    ta.select();
  }

  async function copyFromGrid(slideIds, manifest) {
    let payload = null;
    try {
      payload = await buildCopyPayload(slideIds, manifest);
    } catch {
      toast("Slide sources need the local server (present.command).");
      return;
    }
    if (!payload) { toast("Nothing copyable in this selection."); return; }
    try {
      await navigator.clipboard.writeText(payload.text);
      toast("Copied " + payload.count + " slide(s) as markdown.");
    } catch {
      showGridFallback(payload.text);
    }
  }

  function closeSlideGrid() {
    if (gridOverlay) gridOverlay.remove();
    if (gridBar) gridBar.remove();
    if (gridFallback) gridFallback.remove();
    gridOverlay = null;
    gridBar = null;
    gridBarLabel = null;
    gridFallback = null;
    gridSelection.clear();
    gridLastToggled = "";
    gridCopyableIds = [];
  }

  async function openSlideGrid(manifest) {
    if (gridOverlay) { closeSlideGrid(); return; }
    let projections = null;
    try { projections = await loadProjections(); } catch { /* viewing-only grid below */ }
    const byId = projections ? new Map(projections.map((r) => [r.slide_id, r])) : null;
    editorState = await fetchEditorState();
    const canEdit = Boolean(editorState && editorState.editable);
    const slides = Array.from(document.querySelectorAll(".stage > .slide"));
    if (slides.length === 0) return;
    const sectionTitles = new Map();
    const subsectionTitles = new Map();
    slides.forEach((slide) => {
      if (slide.dataset.role === "section-title" && slide.dataset.section) {
        sectionTitles.set(slide.dataset.section, slide.dataset.navTitle || slide.dataset.section);
      } else if (slide.dataset.role === "subsection-title" && slide.dataset.subsection) {
        subsectionTitles.set(slide.dataset.subsection, slide.dataset.navTitle || slide.dataset.subsection);
      }
    });
    gridCopyableIds = slides
      .map((slide) => slide.dataset.id || "")
      .filter((id) => byId && byId.get(id) && byId.get(id).source_markdown);

    function cardFor(slide, index) {
      const id = slide.dataset.id || "";
      const record = byId ? byId.get(id) : null;
      const copyable = Boolean(record && record.source_markdown);
      const heading = slide.querySelector("h1,h2");
      const title = slide.dataset.navTitle || (heading && heading.textContent.trim()) || id || "Slide";
      const card = createElement("div", {
        className: "slide-grid-card",
        tabindex: "0",
        role: "button",
        "data-slide-id": id,
        "aria-label": "Slide " + (index + 1) + ": " + title
      });
      const controls = createElement("div", { className: "slide-grid-controls" });
      if (copyable) {
        const check = createElement("input", { type: "checkbox", className: "slide-grid-check", "aria-label": "Select slide " + (index + 1) });
        check.addEventListener("click", (event) => {
          event.stopPropagation();
          toggleGridSelection(id, check.checked, event.shiftKey);
        });
        controls.append(check);
        const copyBtn = createElement("button", { type: "button", className: "slide-grid-copy", text: "Copy" });
        copyBtn.addEventListener("click", (event) => {
          event.stopPropagation();
          copyFromGrid([id], manifest);
        });
        controls.append(copyBtn);
      }
      card.append(
        controls,
        slideThumb(slide),
        createElement("div", { className: "slide-grid-caption" }, [
          createElement("span", { className: "slide-grid-num", text: String(index + 1) }),
          createElement("span", { className: "slide-grid-title", text: title })
        ])
      );
      const jump = () => {
        closeSlideGrid();
        if (id) location.hash = "#" + id;
      };
      card.addEventListener("click", jump);
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          jump();
        }
      });
      return card;
    }

    const closeBtn = createElement("button", { type: "button", text: "Close (Esc)" });
    closeBtn.addEventListener("click", closeSlideGrid);
    // Zoom (browse-only grid, 2026-06-12): +/- keys and this slider size the thumbnails by
    // driving the cards' minmax() var; the preference persists per browser.
    const zoomInit = (() => { try { return Number(localStorage.getItem("slideGridZoom")) || 230; } catch { return 230; } })();
    const applyZoom = (px) => {
      const v = Math.max(150, Math.min(560, Math.round(px)));
      gridOverlay.style.setProperty("--sg-thumb", v + "px");
      try { localStorage.setItem("slideGridZoom", String(v)); } catch { /* fine */ }
      return v;
    };
    let zoomLevel = zoomInit;
    const zoomSlider = createElement("input", { type: "range", min: "150", max: "560", step: "10", className: "slide-grid-zoom", title: "Thumbnail size (+ / -)", "aria-label": "Thumbnail size" });
    zoomSlider.value = String(zoomInit);
    zoomSlider.addEventListener("input", () => { zoomLevel = applyZoom(Number(zoomSlider.value)); });
    zoomSlider.addEventListener("click", (event) => event.stopPropagation());
    gridZoomNudge = (delta) => { zoomLevel = applyZoom(zoomLevel + delta); zoomSlider.value = String(zoomLevel); };
    const topRow = [
      createElement("h2", { text: "All slides" }),
      createElement("span", { className: "slide-grid-hint", text: projections
        ? "Click a slide to jump · tick to select (shift-click for a range) · copy as markdown · +/- to zoom"
        : "Click a slide to jump. Copying source needs the local server (present.command)." }),
      createElement("span", { className: "slide-grid-spacer" }),
      zoomSlider
    ];
    if (canEdit) {
      const editBtn = createElement("button", { type: "button", text: "Edit ↗", title: "Open the Editing Mode (staged drafts — nothing changes until you save) (E)" });
      editBtn.addEventListener("click", openEditingMode);
      topRow.push(editBtn);
      const editIconsBtn = createElement("button", { type: "button", text: "Edit icons ↗", title: "Pick an icon for each bullet (staged draft — one Save & rebuild at the end)" });
      editIconsBtn.addEventListener("click", () => { if (editorState && editorState.editable) window.open("/edit-icons", "_blank"); });
      topRow.push(editIconsBtn);
    }
    topRow.push(closeBtn);
    gridOverlay = createElement("div", { className: "slide-grid-overlay", role: "dialog", "aria-modal": "true", "aria-label": "All slides" }, [
      createElement("div", { className: "slide-grid-top" }, topRow)
    ]);
    gridOverlay.style.setProperty("--sg-thumb", zoomInit + "px");
    // Keys pressed on the grid's own controls (Enter/Space on buttons, checkboxes) must not
    // bubble to the deck runtime's window-level handler and move slides behind the overlay.
    gridOverlay.addEventListener("keydown", (event) => { event.stopPropagation(); });

    let cardsHost = null;
    let lastSection = null;
    let lastSubsection = null;
    slides.forEach((slide, index) => {
      const section = slide.dataset.section || "";
      if (section !== lastSection) {
        lastSection = section;
        lastSubsection = null;
        const head = createElement("div", { className: "slide-grid-section-head" });
        const sectionIds = slides
          .filter((s) => (s.dataset.section || "") === section)
          .map((s) => s.dataset.id || "")
          .filter((id) => gridCopyableIds.indexOf(id) !== -1);
        if (sectionIds.length > 0) {
          const check = createElement("input", { type: "checkbox", className: "slide-grid-check", "aria-label": "Select whole section" });
          check.addEventListener("change", () => {
            sectionIds.forEach((id) => setGridSelected(id, check.checked));
            updateGridBar();
          });
          head.append(check);
        }
        head.append(createElement("h3", { text: sectionTitles.get(section) || (section || "Slides") }));
        if (sectionIds.length > 0) {
          const copySectionBtn = createElement("button", { type: "button", text: "Copy section" });
          copySectionBtn.addEventListener("click", () => copyFromGrid(sectionIds, manifest));
          head.append(copySectionBtn);
        }
        gridOverlay.append(head);
        cardsHost = createElement("div", { className: "slide-grid-cards" });
        gridOverlay.append(cardsHost);
      }
      const sub = slide.dataset.subsection || "";
      if (sub !== lastSubsection) {
        lastSubsection = sub;
        if (sub) {
          gridOverlay.append(createElement("div", { className: "slide-grid-section-head slide-grid-sub" }, [
            createElement("h3", { text: subsectionTitles.get(sub) || sub })
          ]));
        }
        cardsHost = createElement("div", { className: "slide-grid-cards" });
        gridOverlay.append(cardsHost);
      }
      cardsHost.append(cardFor(slide, index));
    });

    const copySelectedBtn = createElement("button", { type: "button", text: "Copy selected" });
    copySelectedBtn.addEventListener("click", () => {
      copyFromGrid(gridCopyableIds.filter((id) => gridSelection.has(id)), manifest);
    });
    const clearBtn = createElement("button", { type: "button", text: "Clear" });
    clearBtn.addEventListener("click", () => {
      Array.from(gridSelection).forEach((id) => setGridSelected(id, false));
      updateGridBar();
    });
    gridBarLabel = createElement("span", { text: "0 selected" });
    gridBar = createElement("div", { className: "slide-grid-bar", hidden: "hidden" }, [gridBarLabel, copySelectedBtn, clearBtn]);
    document.body.append(gridOverlay, gridBar);
  }

  // Publish handout (2026-06-10; verified-deploy + persistent result 2026-06-15): user-initiated
  // republish of the handout to the web. The outcome — verified-live / preview-only / unreachable
  // / failed — renders into the panel and is remembered in localStorage so it survives a reload.
  // No blocking confirm() dialog.
  const PUBLISH_KEY = "htmlpres:lastPublish";
  function renderPublishResult(statusEl, data, button) {
    const stripScheme = (url) => String(url || "").replace("https://", "").replace("http://", "");
    const link = (url) => createElement("a", { className: "local-launch-handout-link", href: url, target: "_blank", rel: "noopener", text: stripScheme(url) });
    const stamp = data.time ? [createElement("div", { className: "local-launch-muted", text: "Last publish: " + data.time })] : [];
    const flip = () => { if (!button) return; const lbl = button.querySelector(".lp-label"); if (lbl) lbl.textContent = "Update handout"; };
    if (data.verified === "verified-live") {
      statusEl.replaceChildren(createElement("div", { className: "publish-ok" }, [document.createTextNode("✓ Live & verified — "), link(data.url)]), ...stamp);
      flip();
    } else if (data.verified === "preview-only") {
      statusEl.replaceChildren(
        createElement("div", { className: "publish-warn", text: "⚠ Deployed, but production still shows the OLD build (preview-only) — the deploy didn't reach the production branch. Re-run, or check the Pages production branch." }),
        createElement("div", { className: "local-launch-muted" }, [document.createTextNode("Target: "), link(data.url)]), ...stamp
      );
      flip();
    } else if (data.verified === "unreachable") {
      statusEl.replaceChildren(
        createElement("div", { className: "publish-warn", text: "⚠ Deployed, but couldn't verify the live URL (network). Open it to check:" }),
        createElement("div", { className: "local-launch-muted" }, [link(data.url)]), ...stamp
      );
      flip();
    } else if (data.ok && data.url) {
      statusEl.replaceChildren(createElement("div", { className: "publish-ok" }, [document.createTextNode("Published — "), link(data.url)]), ...stamp);
      flip();
    } else {
      statusEl.replaceChildren(createElement("div", { className: "publish-warn", text: "✗ Publish failed: " + (data.error || "unknown error") }));
      if (data.log) statusEl.appendChild(createElement("pre", { className: "publish-log", text: data.log }));
    }
  }
  function loadLastPublish() { try { const s = localStorage.getItem(PUBLISH_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
  async function publishHandout(button, statusEl) {
    button.disabled = true;
    statusEl.replaceChildren(createElement("div", { className: "local-launch-muted", text: "Publishing — recompresses images, deploys to production, then verifies the live URL. This can take a minute…" }));
    try {
      const res = await fetch("/publish-handout", { method: "POST" });
      const data = await res.json();
      try { data.time = new Date().toLocaleString(); localStorage.setItem(PUBLISH_KEY, JSON.stringify(data)); } catch (e) { /* private mode */ }
      renderPublishResult(statusEl, data, button);
    } catch (e) {
      statusEl.replaceChildren(createElement("div", { className: "publish-warn", text: "Publishing needs the local server (present.command / Raycast launch)." }));
    } finally {
      button.disabled = false;
    }
  }
  // Rebuild the served bundle from the outline (no Raycast). On success offer a reload to view it.
  async function rebuildHandout(button, statusEl) {
    button.disabled = true;
    statusEl.replaceChildren(createElement("div", { className: "local-launch-muted", text: "Rebuilding from the outline…" }));
    try {
      const res = await fetch("/editor/rebuild", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        const reload = createElement("button", { type: "button", text: "Reload to view" });
        reload.addEventListener("click", () => location.reload());
        statusEl.replaceChildren(createElement("div", { className: "publish-ok", text: "✓ Rebuilt." }), reload);
      } else {
        statusEl.replaceChildren(createElement("div", { className: "publish-warn", text: "✗ Rebuild failed: " + (data.error || "unknown error") }));
      }
    } catch (e) {
      statusEl.replaceChildren(createElement("div", { className: "publish-warn", text: "Rebuild needs the local server (present.command / Raycast launch)." }));
    } finally {
      button.disabled = false;
    }
  }

  async function runPreflight(target, manifest, clickerTarget) {
    target.replaceChildren(preflightRow("Preflight", "Running", "checking local presentation bundle"));
    clickerTestActive = true;
    clickerTarget.replaceChildren(createElement("div", { text: "Preflight clicker capture is active. Press a clicker key." }));
    const results = [];
    const popup = window.open("", "presentation-popup-test", "popup,width=260,height=160");
    if (popup) {
      popup.document.write("<!doctype html><title>Popup test</title><p>Popup allowed.</p>");
      popup.setTimeout(() => popup.close(), 600);
    }
    results.push(preflightRow("Popup launch", popup ? "Available" : "Blocked", popup ? "" : "allow pop-ups for this local presentation URL"));
    results.push(preflightRow("Fullscreen API", document.fullscreenEnabled ? "Available" : "Unavailable", document.fullscreenEnabled ? "" : "use browser controls or another browser"));
    results.push(preflightRow("Screen picker API", "getScreenDetails" in window ? "Available" : "Unavailable", "progressive enhancement only"));
    results.push(preflightRow("Local HTTP", location.protocol.startsWith("http") && /^(127\.0\.0\.1|localhost)$/.test(location.hostname) ? "Yes" : "No", ""));
    results.push(preflightRow("Presenter control", document.getElementById("presenterBtn") ? "Available" : "Missing", ""));
    const exportCheck = await checkExports(manifest);
    results.push(preflightRow("Exports", exportCheck.ok ? "OK" : "Problem", exportCheck.detail));
    const privacyCheck = await checkSharePrivacy(manifest);
    results.push(preflightRow("Share privacy", privacyCheck.ok ? "OK" : "Problem", privacyCheck.detail));
    const assetCheck = await checkAssets();
    results.push(preflightRow("Assets", assetCheck.ok ? "OK" : "Problem", assetCheck.detail));
    const syncCheck = await checkSyncChannels();
    results.push(preflightRow("Sync channels", syncCheck.ok ? "OK" : "Problem", syncCheck.detail));
    results.push(preflightRow("Clicker capture", "Active", "press the clicker and confirm the mapped action above"));
    target.replaceChildren(...results);
  }

  async function init() {
    const manifest = await loadManifest();
    const browseUrl = deckUrl();
    const exports = manifest.exports || {};
    const fullUrl = bundleUrl((exports.html_full && exports.html_full.path) || "dist/presentation-full.html");
    const shareNotesUrl = bundleUrl((exports.html_share_notes && exports.html_share_notes.path) || "dist/presentation-share-notes.html");
    const shareNoNotesUrl = bundleUrl((exports.html_share_no_notes && exports.html_share_no_notes.path) || "dist/presentation-share-no-notes.html");

    const toggle = createElement("button", {
      type: "button",
      className: "local-launch-toggle",
      "aria-expanded": "false",
      "aria-controls": "localLaunchPanel",
      title: "Presentation tools (T)",
      text: "Tools"
    });
    const panel = createElement("aside", {
      id: "localLaunchPanel",
      className: "local-launch-panel",
      hidden: "hidden",
      "aria-label": "Local presentation tools"
    });
    const clickerStatus = createElement("div", { className: "local-launch-status" }, [
      createElement("div", { text: "Clicker test is off." })
    ]);
    const preflightStatus = createElement("div", { className: "local-launch-status" }, [
      createElement("div", { text: "Preflight has not run." })
    ]);
    const qrSvg = makeQrSvg(browseUrl);
    const copySourceStatus = createElement("div", { className: "local-launch-muted" });
    const filesSection = createElement("div", {});
    // Published short link (manifest hosting.handout_url, stamped by publish-handout): the
    // thing to email or read out. Shown cleaned (no scheme); the copy button copies the full URL.
    const publicHandoutUrl = (manifest.hosting && typeof manifest.hosting.handout_url === "string" && manifest.hosting.handout_url) || "";
    const publicHandoutDisplay = publicHandoutUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");

    // Icon advisories (Tools panel, Phase 1 of the icon-fix UI): a list shows icons only if EVERY
    // bullet resolves, so one unresolved bullet drops the whole list to plain. Surface those gaps
    // (and the "could take icons" suggestions) here instead of in the build log. Fix a gap by
    // pinning the bullet with an icon tag. NOTE: this whole block is emitted INSIDE the client
    // runtime template literal — no backticks and no dollar-brace interpolation; use double quotes
    // and string concatenation only (a stray backtick or interpolation breaks the whole runtime).
    const authoring = manifest.authoring || {};
    const iconGaps = Array.isArray(authoring.icon_gaps) ? authoring.icon_gaps : [];
    const iconSuggestions = Array.isArray(authoring.icon_suggestions) ? authoring.icon_suggestions : [];
    const iconFixBtn = createElement("button", { type: "button", className: "local-launch-link", text: "Open Edit icons →", title: "Fix these with the per-bullet icon picker" });
    iconFixBtn.addEventListener("click", openEditIcons);
    // Collapsed by default — match issues are reference, not something to stare at every launch.
    const iconSummary = iconGaps.length
      ? "Icons — " + iconGaps.length + " bullet" + (iconGaps.length === 1 ? "" : "s") + " to fix"
      : "Icons — " + iconSuggestions.length + " suggestion" + (iconSuggestions.length === 1 ? "" : "s");
    const iconSection = (iconGaps.length || iconSuggestions.length) ? [
      createElement("details", { className: "local-launch-icons" }, [
        createElement("summary", { text: iconSummary }),
        ...(iconGaps.length ? [
          createElement("p", { className: "local-launch-muted", text: "These bullets block their list from showing icons — pin each with an {icon=name} tag, or use Edit icons:" }),
          createElement("ul", { className: "local-launch-icon-gaps" }, iconGaps.map((g) =>
            createElement("li", {}, [
              createElement("code", { text: g.slide }),
              createElement("span", { text: g.item ? " — " + g.item : "" })
            ])
          ))
        ] : []),
        ...(iconSuggestions.length ? [
          createElement("p", { className: "local-launch-muted", text: iconSuggestions.length + " plain list" + (iconSuggestions.length === 1 ? "" : "s") + " could take icons (add the {icons} trigger): " + iconSuggestions.join(", ") })
        ] : []),
        iconFixBtn
      ])
    ] : [];

    // Panel layout (2026-06-10 redesign): the things Dominik actually reaches for live on
    // top — copy slide source, publish handout, the share file, and the export files with
    // open/reveal/copy-path. Presenting-from-this-machine plumbing (launch buttons, URLs,
    // QR, clicker, preflight) is real but rarely needed — collapsed behind a details toggle.
    const copySourceBtn = iconButton("Copy source", "copy", { title: "Copy this slide's markdown (C)" });
    const gridPanelBtn = iconButton("Slide grid", "grid", { title: "All slides — select and copy (S)" });
    const publishBtn = iconButton(publicHandoutUrl ? "Update handout" : "Publish handout", "publish", { className: "lp-primary", title: "Deploy the handout to the web and verify it's live" });
    const editBtnPanel = iconButton("Edit", "edit", { title: "Open Editing Mode (staged drafts — nothing changes until you save)" });
    editBtnPanel.addEventListener("click", openEditingMode);
    const editIconsBtn = iconButton("Edit icons", "icons", { title: "Pick an icon for each bullet (staged draft — one Save & rebuild at the end)" });
    editIconsBtn.addEventListener("click", openEditIcons);
    const rebuildBtn = iconButton("Rebuild", "rebuild", { title: "Rebuild this presentation from its outline (no Raycast needed)" });
    rebuildBtn.addEventListener("click", () => rebuildHandout(rebuildBtn, rebuildStatus));
    const publishStatus = createElement("div", { className: "local-launch-muted" });
    const rebuildStatus = createElement("div", { className: "local-launch-muted" });
    const openPresenterBtn = createElement("button", { type: "button", text: "Open presenter" });
    const openAudienceBtn = createElement("button", { type: "button", text: "Open audience" });
    const clickerBtn = createElement("button", { type: "button", text: "Clicker test" });
    const preflightBtn = createElement("button", { type: "button", text: "Preflight" });

    panel.append(
      createElement("h2", { text: manifest.title || document.title || "Presentation" }),
      // ── Handout ── deploy to the web + the offline file.
      createElement("h3", { text: "Handout" }),
      createElement("div", { className: "local-launch-grid" }, [publishBtn]),
      publishStatus,
      ...(publicHandoutUrl ? [
        createElement("div", { className: "local-launch-handout" }, [
          createElement("a", { className: "local-launch-handout-link", href: publicHandoutUrl, target: "_blank", rel: "noopener", text: publicHandoutDisplay }),
          copyButton(publicHandoutUrl, "Copy public link")
        ])
      ] : []),
      createElement("div", { className: "local-launch-handout" }, [
        createElement("a", { className: "local-launch-handout-link", href: shareNoNotesUrl, target: "_blank", rel: "noopener", text: "Open local handout (offline file)" }),
        copyButton(shareNoNotesUrl)
      ]),
      createElement("p", { className: "local-launch-muted", text: "Publish deploys the audience-ready handout to the web and verifies it is live; the file above is the same handout, offline." }),
      // ── Edit ── change the deck, then rebuild.
      createElement("h3", { text: "Edit" }),
      createElement("div", { className: "local-launch-grid" }, [editBtnPanel, editIconsBtn, rebuildBtn]),
      rebuildStatus,
      ...iconSection,
      // ── Tools ──
      createElement("h3", { text: "Tools" }),
      createElement("div", { className: "local-launch-grid" }, [copySourceBtn, gridPanelBtn]),
      copySourceStatus,
      createElement("h3", { text: "Files" }),
      filesSection,
      createElement("details", { className: "local-launch-advanced" }, [
        createElement("summary", { text: "Presenting & diagnostics" }),
        createElement("div", { className: "local-launch-grid" }, [openPresenterBtn, openAudienceBtn, clickerBtn, preflightBtn]),
        createElement("h3", { text: "URLs (this machine's local server)" }),
        urlRow("Browse", browseUrl),
        urlRow("Full", fullUrl),
        urlRow("Share notes", shareNotesUrl),
        urlRow("Share no notes", shareNoNotesUrl),
        createElement("h3", { text: "QR (local URL — useful only on this network)" }),
        createElement("div", { className: "local-launch-qr" }, [
          createElement("div", { html: qrSvg || "" }),
          createElement("div", { className: "local-launch-muted", text: qrSvg ? "Current local deck URL." : "URL is too long for the built-in QR encoder." })
        ]),
        createElement("h3", { text: "Clicker" }),
        clickerStatus,
        createElement("h3", { text: "Preflight" }),
        preflightStatus
      ])
    );
    populateFilesSection(filesSection, manifest);

    copySourceBtn.addEventListener("click", () => copySlideSource(manifest, copySourceStatus));
    gridPanelBtn.addEventListener("click", () => {
      panel.setAttribute("hidden", "hidden");
      toggle.setAttribute("aria-expanded", "false");
      openSlideGrid(manifest);
    });
    publishBtn.addEventListener("click", () => publishHandout(publishBtn, publishStatus));
    { const last = loadLastPublish(); if (last) renderPublishResult(publishStatus, last, publishBtn); } // remembered result
    openPresenterBtn.addEventListener("click", openPresenter);
    openAudienceBtn.addEventListener("click", openAudience);
    clickerBtn.addEventListener("click", () => {
      clickerTestActive = !clickerTestActive;
      clickerStatus.replaceChildren(createElement("div", { text: clickerTestActive ? "Press a clicker key." : "Clicker test is off." }));
    });
    preflightBtn.addEventListener("click", () => runPreflight(preflightStatus, manifest, clickerStatus));

    toggle.addEventListener("click", () => {
      const open = panel.hasAttribute("hidden");
      panel.toggleAttribute("hidden", !open);
      toggle.setAttribute("aria-expanded", String(open));
    });
    document.addEventListener("keydown", (event) => {
      if (!clickerTestActive) return;
      const tag = event.target && event.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      event.preventDefault();
      event.stopPropagation();
      clickerStatus.replaceChildren(createElement("div", { text: "key=" + event.key + " code=" + event.code + " action=" + classifyKey(event) }));
    }, true);

    // Copy/reuse reach (2026-06-10): the deck's own footer toolbar gets Grid + Copy source
    // (styled by the deck's .btn) — local app only, this script never ships in share exports.
    const footerRight = document.querySelector(".footer .footer-right");
    if (footerRight) {
      const footerGridBtn = createElement("button", { type: "button", className: "btn", text: "Grid", title: "All slides — select and copy source (S)" });
      footerGridBtn.addEventListener("click", () => openSlideGrid(manifest));
      const footerCopyBtn = createElement("button", { type: "button", className: "btn", text: "Copy source", title: "Copy this slide's markdown (C)" });
      footerCopyBtn.addEventListener("click", () => quickCopySource(manifest));
      const footerEditBtn = createElement("button", { type: "button", className: "btn", text: "Edit", title: "Open the Editing Mode — staged drafts, nothing changes until you save (E)" });
      footerEditBtn.addEventListener("click", () => {
        if (!editorState) fetchEditorState().then((st) => { editorState = st; openEditingMode(); });
        else openEditingMode();
      });
      footerRight.prepend(footerGridBtn, footerCopyBtn, footerEditBtn);
    }

    // S (slide grid) and C (copy current slide source). G was the obvious grid key but the
    // deck runtime already binds it to the card-gallery mini-grid; S = slide sorter. CAPTURE
    // on document so a stopPropagation here keeps the runtime's window-level handler from
    // also acting; while the grid is open it is MODAL — navigation keys are swallowed so the
    // deck does not move underneath (Tab/Enter/Space pass through to the grid's own controls,
    // whose keydowns the overlay's bubble listener stops before they reach the runtime).
    document.addEventListener("keydown", (event) => {
      if (clickerTestActive) return;
      const tag = event.target && event.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (gridOverlay) {
        if (event.key === "Escape" || event.key === "s" || event.key === "S") {
          event.preventDefault();
          event.stopPropagation();
          closeSlideGrid();
          return;
        }
        if ((event.key === "+" || event.key === "=" || event.key === "-") && gridZoomNudge) {
          event.preventDefault();
          event.stopPropagation();
          gridZoomNudge(event.key === "-" ? -40 : 40);
          return;
        }
        if (event.key === "e" || event.key === "E") {
          event.preventDefault();
          event.stopPropagation();
          openEditingMode();
          return;
        }
        if (event.key === "Tab" || event.key === "Enter" || event.key === " ") return;
        event.stopPropagation();
        return;
      }
      if (event.key === "s" || event.key === "S") {
        event.preventDefault();
        event.stopPropagation();
        openSlideGrid(manifest);
      } else if (event.key === "c" || event.key === "C") {
        event.preventDefault();
        event.stopPropagation();
        quickCopySource(manifest);
      } else if (event.key === "e" || event.key === "E") {
        if (!editorState) { fetchEditorState().then((st) => { editorState = st; openEditingMode(); }); }
        else openEditingMode();
      } else if (event.key === "t" || event.key === "T") {
        event.preventDefault();
        event.stopPropagation();
        toggle.click(); // T toggles the Tools panel
      }
    }, true);

    // Test hooks (pattern: the deck runtime's window.__highlightForTest) — jsdom suites drive
    // the copy-payload assembler and the grid without a clipboard or a real server.
    window.__slideGridForTest = {
      buildCopyPayload: (ids) => buildCopyPayload(ids, manifest),
      openSlideGrid: () => openSlideGrid(manifest),
      closeSlideGrid,
      gridState: () => ({ open: Boolean(gridOverlay), selected: Array.from(gridSelection), copyable: gridCopyableIds.slice() })
    };

    document.body.append(panel, toggle);

    // Rebuild notice (Editing Mode, 2026-06-12): a Save from /edit rebuilds the bundle under
    // this window. Poll the manifest's source hash and OFFER a reload — never force one. The
    // deck runtime's persisted state restores the position (paired windows via localStorage;
    // standalone via the slide hash set just before reloading).
    (function watchForRebuild() {
      if (!/^https?:$/.test(location.protocol)) return;
      let baseline = null;
      let toastShown = false;
      const readHash = async () => {
        try {
          const res = await fetch("/manifest.json", { cache: "no-store" });
          const m = await res.json();
          return m && m.source ? m.source.source_hash : null;
        } catch { return null; }
      };
      setInterval(async () => {
        if (toastShown) return;
        const h = await readHash();
        if (!h) return;
        if (baseline === null) { baseline = h; return; }
        if (h === baseline) return;
        toastShown = true;
        const isPairedWindow = /[?&](presenter|audience)=1/.test(location.search);
        const toastEl = createElement("div", { className: "rebuild-toast" }, [
          createElement("span", { text: "Presentation rebuilt" })
        ]);
        const reloadBtn = createElement("button", { type: "button", text: "Reload (keeps your place)" });
        reloadBtn.addEventListener("click", () => {
          const active = document.querySelector(".slide.active");
          if (active && active.dataset.id && !isPairedWindow) location.hash = "#" + active.dataset.id;
          location.reload();
        });
        const laterBtn = createElement("button", { type: "button", className: "rebuild-toast-dismiss", text: "Later" });
        laterBtn.addEventListener("click", () => { toastEl.remove(); baseline = h; toastShown = false; });
        toastEl.append(reloadBtn, laterBtn);
        document.body.appendChild(toastEl);
      }, 5000);
    })();

  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
</script>`;
}

export function injectLocalLaunchTools(html) {
  const enhancement = buildLocalLaunchEnhancement();
  const bodyCloseIndex = html.toLowerCase().lastIndexOf("</body>");
  if (bodyCloseIndex !== -1) {
    return `${html.slice(0, bodyCloseIndex)}${enhancement}\n${html.slice(bodyCloseIndex)}`;
  }
  return `${html}\n${enhancement}\n`;
}

// Embed the deck's own Markdown source behind an unobtrusive "View source" control, so a shared
// single-file demo shows exactly what its source looks like. OPT-IN (--embed-source) and used
// only for the demo/showcase decks — real talks never embed their source, since the raw outline
// carries speaker notes. The Markdown lives in an inert <script type="text/markdown"> block and
// is shown verbatim (read back via textContent) in a dialog with a copy button; no rendering.
export function injectEmbeddedSource(html, sourceMarkdown) {
  // Only the script terminator must be neutralised so the raw Markdown survives inside the
  // non-executed block; everything else is plain text the viewer reads back via textContent.
  const safe = String(sourceMarkdown).replace(/<\/(script)/gi, "<\\/$1");
  const enhancement = `
<style>
  .view-source-btn{position:fixed;right:14px;bottom:14px;z-index:60;opacity:.5;transition:opacity .15s;
    font:600 13px/1 var(--sans,system-ui),sans-serif;color:#fff;background:var(--accent,#0b3a6b);border:none;
    border-radius:999px;padding:9px 15px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.18)}
  .view-source-btn:hover,.view-source-btn:focus-visible{opacity:1}
  .view-source-dialog{width:min(920px,92vw);max-height:84vh;border:none;border-radius:14px;padding:0;
    box-shadow:0 18px 60px rgba(0,0,0,.35);background:#fbf9f3;color:#17202a}
  .view-source-dialog::backdrop{background:rgba(10,20,35,.5)}
  .vs-head{display:flex;align-items:center;gap:10px;padding:13px 16px;border-bottom:1px solid #d9d0c1;
    font:700 14px/1 var(--sans,system-ui),sans-serif;position:sticky;top:0;background:#fbf9f3}
  .vs-head .vs-title{flex:1}
  .vs-head button{font:600 12px/1 var(--sans,system-ui),sans-serif;border:1px solid #c9bfac;background:#fff;
    border-radius:7px;padding:6px 11px;cursor:pointer;color:#17202a}
  .vs-head button:hover{background:#f2ece0}
  .view-source-dialog pre{margin:0;padding:16px 18px;overflow:auto;max-height:calc(84vh - 52px)}
  .view-source-dialog code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre;color:#17202a}
  @media print{.view-source-btn{display:none}}
</style>
<button class="view-source-btn" id="viewSourceBtn" type="button" aria-haspopup="dialog">View source</button>
<dialog class="view-source-dialog" id="viewSourceDialog" aria-label="Deck Markdown source">
  <div class="vs-head"><span class="vs-title">Deck source — Markdown</span>
    <button type="button" id="vsCopy">Copy</button>
    <button type="button" id="vsClose">Close</button></div>
  <pre><code id="vsCode"></code></pre>
</dialog>
<script type="text/markdown" id="deckSourceMarkdown">${safe}</script>
<script>
(() => {
  const md = document.getElementById("deckSourceMarkdown");
  const dlg = document.getElementById("viewSourceDialog");
  const code = document.getElementById("vsCode");
  const btn = document.getElementById("viewSourceBtn");
  if (!md || !dlg || !code || !btn) return;
  const text = md.textContent || "";
  code.textContent = text;
  const open = () => { if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", ""); };
  btn.addEventListener("click", open);
  document.getElementById("vsClose").addEventListener("click", () => dlg.close());
  document.getElementById("vsCopy").addEventListener("click", async () => {
    const copyBtn = document.getElementById("vsCopy");
    try { await navigator.clipboard.writeText(text); copyBtn.textContent = "Copied"; }
    catch {
      const range = document.createRange(); range.selectNodeContents(code);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); copyBtn.textContent = "Selected";
    }
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 1400);
  });
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
})();
</script>`;
  const bodyCloseIndex = html.toLowerCase().lastIndexOf("</body>");
  if (bodyCloseIndex !== -1) {
    return `${html.slice(0, bodyCloseIndex)}${enhancement}\n${html.slice(bodyCloseIndex)}`;
  }
  return `${html}\n${enhancement}\n`;
}
