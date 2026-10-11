// The handout home page's markup (locked design 2026-10-07, "Handout 4b": the navy band holds the
// actions). buildShareHtml({ home }) puts it in front of the handout's own shell;
// compiler/assets/runtime/handout-home.js picks one of its three layouts at run time (before the talk,
// live, handout) by showing the elements whose data-hh-for names that layout.
// Everything here is built from the publisher's values and escaped; the QR code is the compiler's own SVG.
import { escapeHtml } from "./00-html.mjs";
import { renderInline } from "./00-inline-render.mjs";
import { renderSlideNavTitle } from "./slide-script-render.mjs";

const decodeEntities = (value) => String(value)
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const sameTarget = (a, b) => {
  const norm = (u) => String(u || "").trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "").toLowerCase();
  return Boolean(a) && Boolean(b) && norm(a) === norm(b);
};

/**
 * The external links the talk's slides carry, in slide order, once each: { href, labelHtml } where the
 * label is the slide's title as the compiler's renderer builds it (escaped, no links). The handout's own
 * address is left out (it is the page itself), and only http(s) targets count.
 */
/**
 * A link from a published page to a file beside it, by the file's NAME: always relative to the page
 * and under its own address, whatever the name. A name is not a link: `http:127.0.0.1#.html` used
 * as one opens another host, `file:x.html` a file on the reader's computer, `//host` another site.
 * Encoding the whole name leaves no `:`, `/`, `#` or `?` for a browser to read as anything but a
 * name; an ordinary name comes out exactly as it is.
 */
export function pageLink(name) {
  return encodeURIComponent(String(name ?? ""));
}

export function collectTalkLinks(slides, { exclude = [] } = {}) {
  const seen = new Set();
  const links = [];
  for (const slide of Array.isArray(slides) ? slides : []) {
    const html = String(slide && slide.html || "");
    const labelHtml = renderSlideNavTitle(html, { links: false });
    for (const match of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/gi)) {
      const href = decodeEntities(match[1]).trim();
      if (!/^https?:\/\/[^\s]+$/i.test(href)) continue;
      if (exclude.some((url) => sameTarget(url, href))) continue;
      const key = href.replace(/\/+$/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      let host = "";
      try { host = new URL(href).host.replace(/^www\./, ""); } catch { continue; }
      links.push({ href, labelHtml: labelHtml || escapeHtml(host) });
    }
  }
  return links;
}

// The design's own icons (24px grid, 2px round strokes), inline: no icon font, no outside origin.
const ICON_PATHS = {
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M3 10h18M8 3v4M16 3v4"></path>',
  play: '<path d="M8 5v14l11-7z"></path>',
  slides: '<rect x="3" y="4" width="18" height="12" rx="2"></rect><path d="M8 20h8M12 16v4"></path>',
  book: '<path d="M4 5h6a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H4z"></path><path d="M20 5h-6a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h6z"></path>',
  pencil: '<path d="M4 20l4-1 11-11-3-3L5 16z"></path>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4z"></path>',
  question: '<circle cx="12" cy="12" r="9"></circle><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.7M12 17v.01"></path>',
  link: '<path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1"></path><path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1"></path>',
  chevron: '<path d="M9 6l6 6-6 6"></path>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"></path>',
  back: '<path d="M15 6l-6 6 6 6"></path>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"></path>',
  shrink: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"></path>',
  speaker: '<circle cx="12" cy="12" r="3"></circle><path d="M12 3v3M12 18v3M3 12h3M18 12h3"></path>',
};
const icon = (name, size = 18) => `<svg class="hh-ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
const chevron = () => `<svg class="hh-ico hh-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS.chevron}</svg>`;
const STEP_ICONS = { task: "play", slide: "book", check: "question", question: "question" };

/** "Before the session": the form's steps with their minutes, or its one-row summary when it lists none. */
function preworkCard(prework, href) {
  const steps = Array.isArray(prework.steps) ? prework.steps.filter((step) => step && step.label) : [];
  const total = Number(prework.minutes) > 0 ? `<span class="hh-tag">About ${Number(prework.minutes)} min</span>` : "";
  const rows = steps.length
    ? steps.map((step) => `<a class="hh-row" href="${href}">${icon(STEP_ICONS[step.kind] || "play")}<span class="hh-row-text">${escapeHtml(step.label)}</span>${Number(step.minutes) > 0 ? `<span class="hh-row-detail">${Number(step.minutes)} min</span>` : ""}${chevron()}</a>`).join("")
    : `<a class="hh-row" href="${href}">${icon("play")}<span class="hh-row-text">${escapeHtml(prework.label)}</span>${prework.detail ? `<span class="hh-row-detail">${escapeHtml(prework.detail)}</span>` : ""}${chevron()}</a>`;
  return `<section class="hh-card hh-list" id="hhPrework" data-hh-for="before"><div class="hh-card-head"><h2>Before the session</h2>${steps.length ? total : ""}</div><div class="hh-rows">${rows}</div></section>`;
}

/**
 * home: { slidesHref, slidesFile?, downloadFile? (the NAME of the self-contained file Download saves, linked
 *   with pageLink; else downloadHref, a ready link; default slidesHref), url, qr,
 *   day?, date?, startTime?, event?, author?, subtitle?, affiliation? (handoutHomeDetails),
 *   prework?: { label, detail, minutes?, steps?: [{ label, minutes, kind }] } | null, links? }
 * One page, three layouts. Every element that belongs to some layouts only carries data-hh-for with their
 * names; the run-time module shows the ones for the layout the page is in. The page's live parts (stage,
 * poll card, board, reaction bar) are moved into #hhStageSlot / #hhCoverSlot and #hhLiveCol at run time.
 */
export function handoutHomeMarkup(home, { title, slideCount, firstSlideId = "" }) {
  const href = escapeHtml(home.slidesHref || "");
  const startHref = escapeHtml((home.slidesHref || "") + (firstSlideId ? `#${firstSlideId}` : ""));
  const display = String(home.url || "").replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const links = Array.isArray(home.links) ? home.links : [];
  const prework = home.prework && home.prework.label ? home.prework : null;
  const text = (value) => String(value || "").trim();
  const count = Number(slideCount) || 0;
  const slidesWords = `${count} slide${count === 1 ? "" : "s"}`;
  const when = [text(home.day), text(home.startTime)].filter(Boolean).join(", ");
  const event = text(home.event);
  const given = event ? [`Given at ${event}`, text(home.date)].filter(Boolean).join(" · ") : text(home.date);
  const speaker = [text(home.author), text(home.affiliation)].filter(Boolean).join(" · ");
  const slidesButton = `<a class="hh-btn primary" href="${href}">${icon("slides")}Open slides</a>`;
  const share = display
    ? `<section class="hh-card hh-share" id="hhShare" aria-label="Share this page">${home.qr ? `<div class="hh-qr">${home.qr}</div>` : ""}<p class="hh-share-text"><b>${escapeHtml(display)}</b><span>Share this page with someone else attending.</span></p></section>`
    : "";
  const sessionRow = (kind, glyph, label) => `<button type="button" class="hh-row" data-hh-my-notes data-hh-kept="${kind}" hidden>${icon(glyph)}<span class="hh-row-text">${label}</span><span class="hh-tag" data-hh-count></span>${chevron()}</button>`;
  return `<div class="handout-home" id="handoutHome" data-layout="handout" data-prework="${prework ? "yes" : "no"}">
<p class="hh-sr" id="hhAnnounce" role="status" aria-live="polite"></p>
<header class="hh-band">
  <div class="hh-band-in">
    <div class="hh-band-text">
      ${when ? `<p class="hh-chip" data-hh-for="before">${icon("calendar", 16)}${escapeHtml(when)}</p>` : ""}
      <div class="hh-titles">
        ${event ? `<p class="hh-event" data-hh-for="before">${escapeHtml(event)}</p>` : ""}
        ${given ? `<p class="hh-event" data-hh-for="handout">${escapeHtml(given)}</p>` : ""}
        <h1 id="hhTitle">${renderInline(String(title || ""))}</h1>
        ${text(home.subtitle) ? `<p class="hh-sub" data-hh-for="before handout">${escapeHtml(text(home.subtitle))}</p>` : ""}
        ${speaker ? `<p class="hh-speaker" data-hh-for="before handout">${escapeHtml(speaker)}</p>` : ""}
      </div>
    </div>
    <p class="hh-chip hh-livenow" data-hh-for="live" hidden><span class="hh-dot" aria-hidden="true"></span>Live now</p>
    <div class="hh-band-actions" data-hh-for="before" hidden>
      ${prework ? `<p class="hh-label">Get ready</p>` : ""}
      ${prework ? `<a class="hh-btn primary" id="hhStartPrework" href="${href}">${icon("play")}Start the pre-work</a>` : slidesButton}
    </div>
    <div class="hh-band-actions" data-hh-for="handout">
      ${slidesButton}
      <button type="button" class="hh-btn" id="hhMyNotes" data-hh-my-notes>${icon("pencil")}My notes<span class="hh-badge" id="hhNotesCount" hidden></span></button>
    </div>
  </div>
</header>
<section class="hh-live" id="hhLive" aria-label="Live" hidden>
  <div class="hh-stagecol">
    <div class="hh-slidebox" id="hhSlideBox">
      <div class="hh-slide" id="hhStageSlot"></div>
      <div class="hh-stepbar" id="hhStepBar">
        <p class="hh-cap" id="hhCap"><span class="hh-dot" aria-hidden="true"></span><span id="hhSlideNum" aria-live="polite"></span></p>
        <div class="hh-steps">
          <button type="button" class="hh-step" id="hhStepBack" aria-label="Previous slide" title="Previous slide (left arrow)" hidden>${icon("back", 20)}</button>
          <button type="button" class="hh-step" id="hhStepForward" aria-label="Next slide" title="Next slide (right arrow)" hidden>${chevron().replace('width="18" height="18"', 'width="20" height="20"')}</button>
          <button type="button" class="hh-step hh-fullbtn" id="hhFull" aria-pressed="false" title="Full screen (Esc leaves it)"><span class="hh-full-on">${icon("expand", 20)}</span><span class="hh-full-off">${icon("shrink", 20)}</span><span class="hh-full-word" id="hhFullWord">Full screen</span></button>
        </div>
        <button type="button" class="hh-btn primary hh-tospeaker" id="hhToSpeaker" hidden>${icon("speaker")}Back to the speaker's slide</button>
      </div>
    </div>
    <div class="hh-rxslot" id="hhRxSlot"></div>
    <h2 class="hh-slide-title" id="hhSlideTitle"></h2>
  </div>
  <div class="hh-livecol" id="hhLiveCol"></div>
</section>
<div class="hh-cols" id="hhPage">
  <div class="hh-col hh-main">
    <section class="hh-card" id="hhAbout" data-hh-for="before" hidden><h2>About this talk</h2><p class="hh-facts"><span>${icon("slides", 16)}${slidesWords}</span></p></section>
    <section class="hh-card hh-cover" id="hhCover" data-hh-for="handout" aria-label="The slides"><div class="hh-slide" id="hhCoverSlot"></div><div class="hh-cover-row"><span>${slidesWords}</span><a class="hh-pill" href="${startHref}">${icon("play", 16)}Start from slide 1</a></div></section>
    ${links.length ? `<section class="hh-card hh-list" id="hhLinks" data-hh-for="handout"><h2>Links mentioned</h2><div class="hh-rows">${links.map((link) => `<a class="hh-row" href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer">${icon("link")}<span class="hh-row-text">${link.labelHtml}</span>${chevron()}</a>`).join("")}</div></section>` : ""}
  </div>
  <div class="hh-col hh-side">
    ${prework ? preworkCard(prework, href) : ""}
    <section class="hh-card hh-list" id="hhSession" hidden><h2>From your session</h2><div class="hh-rows">${sessionRow("notes", "pencil", "Your notes")}${sessionRow("bookmarks", "bookmark", "Bookmarked slides")}${sessionRow("questions", "question", "Your questions")}</div></section>
    <a class="hh-btn" id="hhDownload" data-hh-for="handout" href="${escapeHtml((home.downloadFile ? pageLink(home.downloadFile) : home.downloadHref) || home.slidesHref || "")}" download="${escapeHtml(home.slidesFile || home.slidesHref || "")}">${icon("download")}Download slides</a>
    ${share}
  </div>
</div>
</div>`;
}
