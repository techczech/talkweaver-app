// The handout home page's markup (design 2026-10-02, direction B). buildShareHtml({ home }) puts it
// in front of the handout's own shell; compiler/assets/runtime/handout-home.js arranges it at run time.
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

/**
 * home: { slidesHref, downloadHref? (the self-contained file Download saves; default slidesHref), url, qr, meta?, notLive?: { today, later }, prework?: { label, detail } | null, links? }
 * The page's live parts (stage, poll card, reaction bar) are moved into the slots at run time.
 */
export function handoutHomeMarkup(home, { title, slideCount }) {
  const href = escapeHtml(home.slidesHref || "");
  const display = String(home.url || "").replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const links = Array.isArray(home.links) ? home.links : [];
  const prework = home.prework && home.prework.label ? home.prework : null;
  const notLive = home.notLive && home.notLive.today ? home.notLive : null;
  const cards = [
    prework ? `<section class="hh-card"><h2>Before the session</h2><a class="hh-row" href="${href}"><span>${escapeHtml(prework.label)}</span><i>${escapeHtml(prework.detail || "")} ›</i></a></section>` : "",
    links.length ? `<section class="hh-card"><h2>Links from the talk</h2>${links.map((link) => `<a class="hh-row" href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer"><span>${link.labelHtml}</span><i>›</i></a>`).join("")}</section>` : "",
  ].filter(Boolean).join("");
  return `<div class="handout-home" id="handoutHome" data-live="off" data-view="handout">
<nav class="hh-tabs" id="hhTabs" role="tablist" aria-label="Live or handout" hidden>
  <button type="button" class="hh-tab" id="hhTabLive" role="tab" aria-selected="false" aria-controls="hhLive"><span class="live-dot" aria-hidden="true"></span>Live<span class="hh-badge" id="hhPollBadge" hidden>Poll open — answer</span></button>
  <button type="button" class="hh-tab on" id="hhTabHandout" role="tab" aria-selected="true" aria-controls="hhHandout">Handout</button>
  <button type="button" class="hh-tab hh-tab-notes" data-hh-my-notes>My Notes</button>
</nav>
<section class="hh-live" id="hhLive" role="tabpanel" aria-label="Live" hidden>
  <div class="hh-live-grid">
    <div class="hh-stagecol">
      <div class="hh-slide" id="hhStageSlot"></div>
      <div class="hh-cap"><span id="hhSlideNum"></span><h3 id="hhSlideTitle"></h3></div>
    </div>
    <div class="hh-panel">
      <div class="hh-idle"><h4>Nothing to answer right now</h4><p>The speaker has not opened a poll. React to this slide or ask a question.</p></div>
      <div id="hhPollSlot"></div>
      <div class="hh-rx" id="hhRxSlot"></div>
    </div>
  </div>
</section>
<section class="hh-handout" id="hhHandout" role="tabpanel" aria-label="Handout">
  ${notLive ? `<div class="hh-quiet" id="hhNotLive" data-today="${escapeHtml(notLive.today)}" data-later="${escapeHtml(notLive.later || notLive.today)}" hidden><span class="hh-quiet-dot" aria-hidden="true"></span><span class="hh-quiet-text">${escapeHtml(notLive.today)}</span></div>` : ""}
  <div class="hh-home">
    <h1>${renderInline(String(title || ""))}</h1>
    ${home.meta ? `<p class="hh-meta">${escapeHtml(home.meta)}</p>` : ""}
    <div class="hh-actions">
      <a class="hh-btn primary" href="${href}">Open slides <b>${Number(slideCount) || 0}</b></a>
      <button type="button" class="hh-btn" data-hh-my-notes>My Notes</button>
      <a class="hh-btn" href="${escapeHtml(home.downloadHref || home.slidesHref || "")}" download="${escapeHtml(home.slidesHref || "")}">Download</a>
    </div>
    ${cards ? `<div class="hh-cols">${cards}</div>` : ""}
    ${display ? `<div class="hh-share">${home.qr ? `<div class="hh-qr">${home.qr}</div>` : ""}<p><b>${escapeHtml(display)}</b><br>Share this page with someone who just sat down.</p></div>` : ""}
  </div>
</section>
</div>`;
}
