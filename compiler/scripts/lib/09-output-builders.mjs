import { escapeHtml, qrGeneratorSource, overviewRuntimeSource, slideFitRuntimeSource, pollExtendedStyles, markmapVendorSource, mermaidVendorSource, boardScreenRuntimeSource } from "./01-cli-utils.mjs";
import { withoutScripts } from "./04-html-extraction.mjs";
import { plainInlineText } from "./00-inline-render.mjs";
import { renderLicenseBody } from "./08-source-adapters.mjs";
import { liveFollowRuntimeSource } from "../../assets/runtime/live-follow.js";
import { instantSlideStyles } from "../../assets/runtime/instant-slide.js";
import { emphasisStepsRuntimeSource } from "../../assets/runtime/emphasis-steps.js";
import { audioChipRuntimeSource } from "../../assets/runtime/audio-chip.js";
import { mediaStepsRuntimeSource } from "../../assets/runtime/media-steps.js";
import { embedChannelSource } from "../../assets/runtime/embed-channel.js";
import { EMBED_DOC_ATTRIBUTE } from "./embed-frame.mjs";
import { audienceReactionsStyles } from "../../assets/runtime/audience-reactions.js";
import { audienceAskStyles } from "../../assets/runtime/audience-ask.js";
import { audienceBoardStyles } from "../../assets/runtime/audience-board.js";
import { audienceMyNotesStyles } from "../../assets/runtime/audience-my-notes.js";
import { sharedTalkRuntimeSource } from "../../assets/runtime/shared-talk-page.js";
import { sharedTalkStyles } from "../../assets/runtime/shared-talk-styles.js";
import { preworkStatusRuntimeSource } from "../../assets/runtime/prework-status.js";
import { preworkFormStyles, preworkFormRuntimeSource } from "../../assets/runtime/prework-form.js";
import { renderScriptBlocks, renderSlideNavTitle } from "./slide-script-render.mjs";
import { handoutHomeMarkup } from "./handout-home.mjs";
import { handoutHomeStyles, handoutHomeRuntimeSource } from "../../assets/runtime/handout-home.js";
import { lazySlideAssetsStyles, lazySlideAssetsRuntimeSource } from "../../assets/runtime/lazy-slide-assets.js";

// =============================================================================
// 9. Output builders — share exports + local launch tools; mostly literal injected JS/CSS strings
// =============================================================================

// Live-presenting ticket 04 (frame V6): the talk's QR overlay on the venue screen. Same shape as
// the presenter template's .qr-fullscreen — the code large, the short link written the way
// someone would copy it down (scheme, www. and trailing slash dropped) with the talk id in bold.
function venueTalkQrMarkup(svg, url) {
  const written = String(url || "").replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
  const slash = written.indexOf("/");
  const link = slash > 0
    ? `<span>${escapeHtml(written.slice(0, slash))}</span><strong>${escapeHtml(written.slice(slash))}</strong>`
    : escapeHtml(written);
  return `<div class="qr-fullscreen venue-talk-qr" id="venueTalkQr" role="dialog" aria-label="QR code, full screen" hidden>`
    + `<div class="qr-fs-code">${svg || ""}</div>${written ? `<div class="qr-fs-url">${link}</div>` : ""}</div>`;
}

// `sharedTalk` (ticket 04, share for comments): true, or { proposals, ownerName }, builds the page the
// shared-talk Worker serves — the handout with the colleague's comments runtime (LOCKED Margin
// design). The runtime stays inert unless the Worker's #tw-shared-talk-config block is present.
// `proposals: false` limits her to notes; `ownerName` is the name the page's copy uses.
// `prework` (feedback-boards ticket 09): a planned Run's handout published before the day carries
// `{ preworkId, workerBaseUrl, form, steps: [{ id, html }] }` — the public form (never a right answer)
// and the step slides, kept in an inert <template> so they are never ordinary slides. The page asks
// the Worker whether pre-work is open and marks body[data-prework]; while it is open the form (ticket 10,
// prework-form.js) takes the place of the slide list, and once it has closed a banner sits over the list.
// Handout, phone, print and venue pages show an audio chip as a static label and never load or play
// the file: the <audio> element (and any data URI it carries) is dropped from the share markup.
// One exception (0.38 ticket 05): the venue screen plays a {play-on-next} chip when the presenter's
// step reaches it, so `keepPlayOnNext` leaves the <audio> of those chips in place.
const AUDIO_ELEMENT_RE = /<audio\b[^>]*>\s*<\/audio>/gi;
export function stripAudioElements(html, { keepPlayOnNext = false } = {}) {
  const source = String(html ?? "");
  if (!keepPlayOnNext) return source.replace(AUDIO_ELEMENT_RE, "");
  // A chip holds spans and its <audio>, never another <div>.
  const kept = [];
  const held = source.replace(/<div class="slide-audio" data-audio-state="ready" data-play-on-next[\s>][\s\S]*?<\/div>/g, (chip) => {
    kept.push(chip);
    return `<!--tw-kept-audio-${kept.length - 1}-->`;
  });
  return held.replace(AUDIO_ELEMENT_RE, "").replace(/<!--tw-kept-audio-(\d+)-->/g, (_, i) => kept[Number(i)]);
}

export function buildShareHtml({ title, slides, styles, includeNotes, slug, license, workerBaseUrl = "", liveTalkSlug = slug, venue = false, venueQr = "", venueUrl = "", sharedTalk = false, prework = null, home = null, lazyAssets = false }) {
  // `lazyAssets` (published index.html and <slug>.html): the page carries the slide-asset loader; the
  // publisher then moves heavy inline media out (handout-lazy-assets.mjs). The Download handout and
  // every other export leave it off and stay self-contained.
  const lazyOn = Boolean(lazyAssets && !venue && !sharedTalk);
  // `home` (handout home page, design 2026-10-02 B): the page the QR code and short link open is this
  // bundle in home mode (handout-home-page.mjs), so its live surface is this page's own live client.
  const homeOn = Boolean(home && !venue && !sharedTalk);
  const homeStartsAt = homeOn && Number.isSafeInteger(home.startsAt) ? home.startsAt : null;
  const sharedTalkOptions = sharedTalk && !venue
    ? JSON.stringify({ proposals: sharedTalk === true || sharedTalk.proposals !== false, ownerName: String((sharedTalk && sharedTalk.ownerName) || "").slice(0, 60) }).replace(/</g, "\\u003c")
    : "null";
  // The pre-work steps are slides too: one that carries a diagram needs the vendor as much as a talk slide.
  const hasMermaid = [...slides, ...(prework && !venue && Array.isArray(prework.steps) ? prework.steps : [])]
    .some((slide) => /\bclass=["'][^"']*\bmermaid-mm\b/.test(String(slide && slide.html || "")));
  const notesButton = includeNotes ? '<button class="btn" id="notesBtn" type="button"><span class="btn-label">Notes</span></button>' : "";
  // Public CC attribution travels into the share export as a no-JS <details> popover.
  const licenseDisclosure = license
    ? `<details class="share-license"><summary class="btn">License</summary><div class="license-pop">${renderLicenseBody(license)}</div></details>`
    : "";
  const liveConfig = workerBaseUrl
    ? JSON.stringify({ workerBaseUrl: String(workerBaseUrl).replace(/\/+$/, ""), talkSlug: String(liveTalkSlug) }).replace(/</g, "\\u003c")
    : "null";
  const preworkOn = Boolean(prework && !venue && prework.preworkId && prework.workerBaseUrl && prework.form);
  const preworkConfig = preworkOn
    ? JSON.stringify({ preworkId: String(prework.preworkId), workerBaseUrl: String(prework.workerBaseUrl).replace(/\/+$/, ""), form: prework.form }).replace(/</g, "\\u003c")
    : "null";
  const preworkTemplate = preworkOn
    ? `<template id="preworkSteps">${(prework.steps || []).map((step) => stripAudioElements(withoutScripts(String(step.html || "")))).join("\n")}</template>`
    : "";
  const liveControls = workerBaseUrl
    ? '<button class="btn follow-live-btn" id="followLiveBtn" type="button" hidden><span class="live-dot" aria-hidden="true"></span><span class="btn-label">Stop following</span></button><button class="btn return-live-btn" id="returnToPresenterBtn" type="button" hidden>Return to presenter</button><label class="live-name" id="liveNameWrap" hidden>Your name <input id="liveName" type="text" placeholder="optional" autocomplete="name"></label><span class="live-follow-status" id="liveFollowStatus" role="status" aria-live="polite" hidden></span>'
    : "";
  const slideMarkup = slides.map((slide, index) => {
    const notes = includeNotes && slide.notes
      ? `<aside class="notes">${withoutScripts(slide.notes)}</aside>`
      : "";
    return stripAudioElements(slide.html, { keepPlayOnNext: venue })
      .replace(/<section\b([^>]*)>/i, `<section$1 data-share-index="${index}">`)
      .replace(/<\/section>\s*$/i, `${notes}</section>`);
  }).join("\n\n");
  // Embedded local pages (ticket 11): the channel is inlined only when a slide carries one.
  const hasLocalEmbed = slideMarkup.includes(` ${EMBED_DOC_ATTRIBUTE}="`);
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
<meta name="deck-title" content="${escapeHtml(plainInlineText(title))}">
<link rel="icon" href="data:,">
<title>${escapeHtml(plainInlineText(title))}</title>
<style>
${pollExtendedStyles}
${styles}
${sharedTalk && !venue ? sharedTalkStyles : ""}
${preworkOn ? preworkFormStyles : ""}
${homeOn ? handoutHomeStyles : ""}
${lazyOn ? lazySlideAssetsStyles : ""}
body { margin: 0; }
.presenter-root, #presenterBtn { display: none !important; }
.share-shell { min-height: 100vh; display: grid; grid-template-rows: 1fr auto; }
.slide { display: none; }
.slide.active { display: grid; }
/* ADR-0018 — the slide is a FIXED canvas, uniformly scaled to fit its box, never reflowed.
   Deck CSS is canvas-relative (cqw/cqh + @container), so everything inside follows --slide-w
   rather than the window. The scale factor is set by fitStage() below. */
:root { --slide-w: 1280px; --slide-h: 720px; }
.stage-fit { position: relative; overflow: hidden; min-height: 0; }
.stage { position: absolute; top: 0; left: 0; width: var(--slide-w); height: var(--slide-h); transform-origin: top left; }

/* ---- ADR-0018 phone view: a LIST of slides; tap one for the slide detail ---- */
.phone-list, .phone-bar, .fs-overlay, .phone-script { display: none; }
.phone-list[hidden], .phone-bar[hidden] { display: none !important; }
@media (max-width: 699px) {
  /* The shell gains rows in phone mode; declare them per mode or the extra children land in
     implicit rows, the list stops being the scroller, and lazy row-filling never bites. */
  body.phone-list-mode .share-shell { grid-template-rows: 1fr; height: 100dvh; min-height: 0; }
  body.phone-detail-mode .share-shell { grid-template-rows: auto auto 1fr auto; height: 100dvh; min-height: 0; }
  /* One column no wider than the phone: without minmax(0, …) the column grows to the phone
     bar's min-content, which includes a long title's full nowrap width (found 2026-09-28). */
  body.phone-list-mode .share-shell, body.phone-detail-mode .share-shell { grid-template-columns: minmax(0, 1fr); }
  body.phone-list-mode .stage-fit, body.phone-list-mode .share-footer { display: none; }
  body.phone-list-mode .phone-list { display: block; }
  body.phone-detail-mode .phone-bar { display: flex; }
  .phone-list { min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; background: #fdfdfb; }
  .pslide-row { display: block; width: 100%; appearance: none; border: 0; border-bottom: 1px solid #e3e2dc; background: transparent; padding: 12px 0 13px; font: inherit; text-align: left; cursor: pointer; touch-action: manipulation; }
  .pslide-row:focus-visible { outline: 2px solid #0f4bd8; outline-offset: -3px; }
  /* aspect-ratio reserves each row's height BEFORE its clone exists, so the list has its true
     scroll length from the start and lazy filling does not make it jump. */
  .pslide-canvas { position: relative; width: 100%; aspect-ratio: 16 / 9; overflow: hidden; background: #fff; border-top: 1px solid #e3e2dc; border-bottom: 1px solid #e3e2dc; }
  .pslide-inner { position: absolute; top: 0; left: 0; width: var(--slide-w); height: var(--slide-h); transform-origin: top left; pointer-events: none; }
  .pslide-inner > .slide { display: grid !important; position: absolute; inset: 0; }
  /* Nothing sits above a slide — the label reads as a caption under it (ADR-0018). */
  .pslide-label { display: flex; align-items: baseline; gap: 8px; padding: 8px 14px 0; }
  .pslide-num { flex: none; white-space: nowrap; font-family: ui-monospace, Menlo, monospace; font-size: 10px; color: #5c6570; letter-spacing: .08em; }
  .pslide-title { font-size: 14px; font-weight: 700; letter-spacing: -.01em; }
  .phone-bar { align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid #e3e2dc; background: #fdfdfb; }
  .phone-bar button { min-height: 44px; border: 1px solid #e3e2dc; background: #fff; font: inherit; font-size: 13px; padding: 0 13px; cursor: pointer; touch-action: manipulation; }
  .phone-bar .phone-bar-title { font-size: 13px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  body.phone-detail-mode .stage-fit { aspect-ratio: 16 / 9; max-height: 52dvh; }
  body.phone-detail-mode .phone-script { display: block; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 14px 15px 24px; background: #fdfdfb; }
  .phone-script, .pslide-title { min-width: 0; overflow-wrap: anywhere; }
  .phone-script .ps-title { margin: 0 0 10px; font-size: 19px; line-height: 1.25; letter-spacing: -.01em; }
  .phone-script code { font-family: ui-monospace, Menlo, monospace; font-size: .88em; background: #f1f0ea; padding: 0 3px; }
  .phone-script .ps-code { margin: 0 0 12px; padding: 10px 12px; background: #f1f0ea; white-space: pre-wrap; font-size: 14px; line-height: 1.45; }
  .phone-script .ps-code code { background: none; padding: 0; font-size: inherit; }
  .phone-script a { color: #0f4bd8; }
  .phone-script ul { margin: 0 0 12px; padding-left: 20px; }
  .phone-script ul ul { margin: 5px 0 6px; }
  .phone-script li { font-size: 17px; line-height: 1.5; margin: 0 0 6px; }
  .phone-script li::marker { color: #0f4bd8; }
  .phone-script p { font-size: 17px; line-height: 1.55; margin: 0 0 12px; }
  .phone-script .ps-pair { color: #5c6570; }
  .phone-script .ps-pair::before { content: " \2014 "; }
  .phone-script blockquote { margin: 0 0 8px; padding: 10px 14px; background: #e8eefc; border-left: 3px solid #0f4bd8; font-size: 17px; line-height: 1.5; }
  .phone-script .ps-attrib { font-size: 14px; color: #5c6570; margin: 0 0 14px; }
  .phone-script .ps-media { display: flex; align-items: center; gap: 9px; margin: 0 0 13px; padding: 9px 12px; border: 1px dashed #e3e2dc; background: #fff; font-size: 14px; color: #5c6570; }
  .phone-script .ps-media b { color: #101418; }
  .phone-script table { border-collapse: collapse; width: 100%; margin: 0 0 13px; font-size: 15px; }
  .phone-script th, .phone-script td { border: 1px solid #e3e2dc; padding: 7px 9px; text-align: left; line-height: 1.4; }
  .phone-script th { background: #e8eefc; font-weight: 700; }
}
/* Full screen: one slide rotated to landscape at the largest scale the device allows. */
.fs-overlay.is-open { display: flex; position: fixed; inset: 0; z-index: 70; background: #0b1117; align-items: center; justify-content: center; }
.fs-rot { position: relative; overflow: hidden; background: #fff; }
.fs-inner { position: absolute; top: 0; left: 0; width: var(--slide-w); height: var(--slide-h); transform-origin: top left; }
.fs-inner > .slide { display: grid !important; position: absolute; inset: 0; }
.fs-close { position: absolute; top: max(10px, env(safe-area-inset-top)); right: 10px; z-index: 2; min-width: 44px; min-height: 44px; border: 0; border-radius: 50%; background: #ffffff26; color: #fff; font-size: 20px; cursor: pointer; touch-action: manipulation; }
.fs-nav { position: absolute; bottom: max(10px, env(safe-area-inset-bottom)); left: 0; right: 0; z-index: 2; display: flex; align-items: center; justify-content: center; gap: 14px; color: #fff; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
.fs-nav button { min-width: 44px; min-height: 44px; border: 0; border-radius: 50%; background: #ffffff26; color: #fff; font-size: 17px; cursor: pointer; touch-action: manipulation; }
.share-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 14px; border-top: 1px solid #0001; background: #fffdf2; }
.share-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.follow-live-btn { border-color: #0f4bd855; color: #0f4bd8; }
.follow-live-btn.is-on { background: #e8eefc; border-color: #0f4bd8; color: #0f4bd8; }
.return-live-btn { border-color: #0f4bd855; color: #0f4bd8; }
.follow-live-btn[hidden], .return-live-btn[hidden], .live-name[hidden], .live-follow-status[hidden] { display: none !important; }
.live-dot { width: 7px; height: 7px; border-radius: 50%; background: #b3372c; box-shadow: 0 0 0 3px #b3372c20; }
.now-live-badge { display: inline-flex; align-items: center; gap: 6px; margin-left: 8px; border: 1px solid #b3372c33; border-radius: 999px; background: #fff5f1; color: #9b3028; padding: 3px 8px; font-size: 11px; font-weight: 700; }
.now-live-badge[hidden] { display: none !important; }
.live-name { display: inline-flex; align-items: center; gap: 5px; color: #5b6572; font-size: 12px; }
.live-name input { width: 105px; border: 1px solid #17202a22; border-radius: 6px; background: #fff; color: #17202a; padding: 5px 7px; font: inherit; }
.live-follow-status { align-self: center; color: #5b6572; font-size: 12px; }
${instantSlideStyles}
${workerBaseUrl && !venue ? audienceReactionsStyles + audienceAskStyles + audienceBoardStyles : ""}
/* Responsive foundation per IMPLEMENTATION-PLAN: reusable phone touch, gutter, viewport and safe-area primitives. */
:root {
  --tw-touch-target: 44px;
  --tw-fluid-gutter: clamp(14px, 4vw, 24px);
  --tw-fluid-content: 640px;
  --tw-mobile-viewport: 100dvh;
  --tw-safe-top: max(14px, env(safe-area-inset-top));
  --tw-safe-bottom: max(16px, env(safe-area-inset-bottom));
}
.audience-poll-surface { position: fixed; inset: 0; z-index: 45; display: grid; place-items: end center; width: 100%; min-height: 100svh; height: var(--tw-mobile-viewport); max-width: 100vw; overflow-x: hidden; background: #fffdf2; color: #17202a; box-sizing: border-box; }
.audience-poll-surface[hidden] { display: none !important; }
.audience-poll-surface > .poll-card { width: min(100%, var(--tw-fluid-content)); max-height: 100%; overflow: auto; overscroll-behavior: contain; box-sizing: border-box; padding: var(--tw-safe-top) var(--tw-fluid-gutter) var(--tw-safe-bottom); background: #fff; }
.poll-card .ptype { color: #0f4bd8; font: 700 10px/1.1 ui-monospace, "SFMono-Regular", Consolas, monospace; letter-spacing: .1em; text-transform: uppercase; }
.poll-card { position: relative; }
.poll-card .pq { margin: 8px 0 16px; padding-right: 40px; font: 700 clamp(18px, 5vw, 22px)/1.25 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.poll-dismiss { position: absolute; top: 8px; right: 8px; width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; border: 0; border-radius: 9px; background: #f0ede3; color: #5c6570; font: 400 22px/1 system-ui; cursor: pointer; touch-action: manipulation; z-index: 2; }
.poll-dismiss:hover { background: #e7e3d5; color: #17202a; }
.poll-options { min-width: 0; margin: 0; padding: 0; border: 0; }
.poll-option { display: flex; align-items: center; gap: 11px; width: 100%; min-height: var(--tw-touch-target); margin-bottom: 9px; padding: 10px 12px; border: 1.5px solid #e7e3d5; border-radius: 9px; box-sizing: border-box; background: #fff; font: 500 15px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; cursor: pointer; touch-action: manipulation; }
.poll-option input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.poll-option .box { display: grid; flex: 0 0 20px; width: 20px; height: 20px; place-items: center; border: 2px solid #c3bdae; box-sizing: border-box; }
.poll-option.single .box { border-radius: 50%; }
.poll-option.multi .box { border-radius: 5px; }
.poll-option.sel { border-color: #0f4bd8; background: #e8eefc; }
.poll-option.sel .box { border-color: #0f4bd8; background: #0f4bd8; box-shadow: inset 0 0 0 4px #e8eefc; }
.poll-open-text { display: block; width: 100%; min-height: 110px; padding: 12px; border: 1.5px solid #e7e3d5; border-radius: 9px; box-sizing: border-box; background: #fff; color: #17202a; font: 16px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; resize: vertical; }
.poll-submit { width: 100%; min-height: var(--tw-touch-target); margin-top: 10px; border: 0; border-radius: 9px; background: #0f4bd8; color: #fff; font: 700 15px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; cursor: pointer; touch-action: manipulation; }
.poll-submit:disabled { cursor: default; opacity: .42; }
.poll-option:focus-within, .poll-open-text:focus-visible, .poll-submit:focus-visible { outline: 3px solid #0f4bd855; outline-offset: 2px; }
.poll-allowance { width: min(100%, var(--tw-fluid-content)); box-sizing: border-box; margin: 0; padding: 10px var(--tw-fluid-gutter); color: #5c6570; background: #fff; font: 13px/1.4 system-ui, sans-serif; text-align: center; }
.poll-option:has(input:disabled) { opacity: .55; cursor: default; }
.poll-inline-status { min-height: 18px; margin-top: 8px; color: #5c6570; font-size: 12.5px; text-align: center; }
.poll-inline-status[hidden] { visibility: hidden; }
.poll-results .rtitle { display: flex; align-items: center; gap: 6px; margin-bottom: 14px; color: #5c6570; font-size: 13px; }
.poll-results .ok { color: #1a7f4b; }
.poll-bar { margin-bottom: 12px; }
.poll-bar .bl { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 5px; font-size: 14px; }
.poll-bar .pct { flex: none; color: #0f4bd8; font: 700 12px/1.2 ui-monospace, "SFMono-Regular", Consolas, monospace; }
.poll-bar .track { height: 10px; overflow: hidden; border-radius: 5px; background: #eee7d6; }
.poll-bar .track i { display: block; height: 100%; border-radius: inherit; background: #0f4bd8; }
.poll-bar.mine .bl { font-weight: 700; }
.board { display: grid; gap: 8px; }
.poll-response { padding: 10px 12px; border: 1px solid #e7e3d5; border-radius: 9px; background: #fdfbf0; font-size: 14px; line-height: 1.4; overflow-wrap: anywhere; }
.poll-response .who { margin-top: 4px; color: #5c6570; font-size: 11px; }
.poll-response.mine { border-color: #0f4bd8; background: #e8eefc; }
.waiting { padding: clamp(28px, 10vh, 72px) 12px; color: #5c6570; text-align: center; }
.waiting .ic { color: #1a7f4b; font-size: 30px; }
.waiting .t { margin: 9px 0 5px; color: #17202a; font-size: 17px; font-weight: 700; }
.waiting .p { font-size: 13px; line-height: 1.45; }
.poll-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
@media (min-width: 700px) {
  .audience-poll-surface { place-items: center; padding: var(--tw-safe-top) var(--tw-fluid-gutter) var(--tw-safe-bottom); background: #17202a66; }
  .audience-poll-surface > .poll-card { max-height: min(760px, calc(100dvh - 48px)); border: 1px solid #e7e3d5; border-radius: 14px; box-shadow: 0 18px 54px #0004; }
}
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
.note-pop { position: fixed; z-index: 65; width: min(352px, 92vw); background: #fffdf2; color: #17202a; border: 1px solid #17202a22; border-radius: 10px; box-shadow: 0 14px 38px #0004; padding: 10px; display: grid; gap: 8px; }
.note-pop[hidden] { display: none; }
.note-pop textarea { width: 100%; min-height: 44px; border: 1px solid #17202a22; border-radius: 7px; padding: 7px 8px; font: 13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; box-sizing: border-box; resize: vertical; }
.note-pop-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.note-pop-quote { margin: 0; padding-left: 8px; border-left: 3px solid #f59e0b; font: 13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; overflow-wrap: anywhere; max-height: 4.2em; overflow: hidden; }
.note-pop-quote:empty { display: none; }
.note-pop-words { margin: 0; font: 14px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; white-space: pre-wrap; overflow-wrap: anywhere; }
.note-pop-words[hidden], .note-pop-sent[hidden], .np-btn[hidden], .note-pop-line[hidden], .note-pop textarea[hidden] { display: none; }
.note-pop-sent { display: flex; align-items: center; gap: 8px; font: 700 15px/1.2 system-ui, -apple-system, sans-serif; }
.note-pop-sent svg { width: 22px; height: 22px; color: #15803d; flex: none; }
.np-btn { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; min-height: 40px; padding: 0 12px; border-radius: 8px; font: 700 13px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; cursor: pointer; box-sizing: border-box; }
.np-btn .np-ico { width: 16px; height: 16px; flex: none; }
.np-save { border: 1px solid #17202a33; background: #fff; color: #17202a; }
.note-pop.is-sent .note-pop-line { order: 1; }
.note-pop.is-sent .np-save { order: 2; }
.np-save.primary { border: 0; background: #0f4bd8; color: #fff; }
.np-send { border: 0; background: #0f4bd8; color: #fff; }
.np-send[disabled] { background: #c9d3e8; color: #33415c; cursor: default; }
.np-btn:focus-visible, .note-pop-remove:focus-visible { outline: 3px solid #0f4bd8; outline-offset: 2px; }
.note-pop-line { margin: 0; font: 12px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #5b6572; overflow-wrap: anywhere; }
.note-pop-remove { border: 0; background: none; color: #9f1239; font: 600 12px/1 system-ui, sans-serif; cursor: pointer; padding: 6px 4px; }
.note-pop-remove:hover { text-decoration: underline; }
mark.note-mark { cursor: pointer; }
mark.note-mark { background: #fde68a; padding: 0 1px; border-radius: 2px; }
/* Compact, icon-led chrome buttons so the reader's notes — not the controls — read as primary. */
.share-actions .btn, .mn-foot .btn, .mn-head .btn, .nav-panel > .btn, .notes-panel > .btn, .note-pop .btn { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; line-height: 1.25; padding: 5px 9px; border-radius: 6px; }
.mn-foot .btn { color: #384452; }
.share-license > summary.btn { font-size: 12.5px; padding: 5px 9px; }
.btn-ico { width: 14px; height: 14px; flex: 0 0 auto; }
.mn-foot .btn .btn-ico, .mn-head .btn .btn-ico { width: 15px; height: 15px; }
${audienceMyNotesStyles}
.share-actions .btn.is-on { background: #fde68a; border-color: #f59e0b; color: #17202a; }
/* Overview search box (the overview had none) + the hide hooks the filter toggles. */
.nav-search-wrap { position: relative; margin: 4px 0 12px; }
.nav-search-ico { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); width: 15px; height: 15px; color: #5b6572; pointer-events: none; }
.nav-search { width: 100%; box-sizing: border-box; padding: 8px 12px 8px 32px; border: 1px solid #17202a22; border-radius: 8px; background: #fff; color: #17202a; font: 14px/1.3 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.nav-search:focus-visible { outline: 2px solid #2563eb55; outline-offset: 1px; }
.section-head[hidden], .subsection-head[hidden], .slide-link[hidden] { display: none !important; }
@media print {
  .share-footer, .nav-panel, .notes-panel, .mynotes-panel, .help-fab, .help-overlay, .note-pop, .audience-poll-surface, .rx-dock { display: none !important; }
  .slide { display: grid !important; break-after: page; min-height: 100vh; }
  .slide .notes { display: block; margin-top: 24px; border-top: 1px solid #0002; padding-top: 12px; }
}
${venue ? `
/* The venue keeps the share slide renderer and live poll surface, but none of its reading chrome. */
html, body, .share-shell { width: 100%; height: 100%; overflow: hidden; }
.share-shell { display: block; min-height: 0; }
.stage-fit { width: 100vw; height: 100dvh; }
.share-footer, .phone-bar, .phone-list, .phone-script, .nav-panel, .notes-panel,
.mynotes-panel, .help-fab, .help-overlay, .note-pop, .focus-banner, .fs-overlay,
.gallery-nav, .now-live-badge, .live-follow-status { display: none !important; }
.venue-screen .lightbox[hidden] { display: none !important; }
.venue-screen .lightbox.open { position: fixed; inset: 0; z-index: 200; display: grid; place-items: center; background: #080c12; }
.venue-screen .lightbox-stage { display: grid; place-items: center; width: 100%; height: 100%; min-height: 0; }
.venue-screen .lightbox-img { max-width: 100vw; max-height: 100dvh; width: auto; height: auto; object-fit: contain; }
.venue-screen .lightbox-nav, .venue-screen .lightbox-close, .venue-screen .lightbox-bar { display: none !important; }
.venue-hint { position: fixed; left: 50%; bottom: 9%; z-index: 50; transform: translateX(-50%); padding: 10px 17px; border-radius: 8px; background: #17202acc; color: white; font: 14px system-ui, sans-serif; pointer-events: none; white-space: nowrap; }
.venue-hint[hidden], .venue-closing[hidden] { display: none !important; }
.venue-closing { position: absolute; right: 4%; top: 13%; z-index: 4; width: 25%; display: grid; justify-items: center; gap: 12px; padding: 25px; box-sizing: border-box; background: #fffdf2; color: #17202a; text-align: center; font: 700 28px system-ui, sans-serif; }
.venue-closing svg { display: block; width: 100%; height: auto; background: white; }
.venue-closing small { font-size: 16px; font-weight: 400; overflow-wrap: anywhere; }
.venue-talk-qr { position: fixed; inset: 0; z-index: 300; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 24px; background: #17202aee; padding: 5vh 5vw; box-sizing: border-box; }
.venue-talk-qr[hidden] { display: none !important; }
.venue-talk-qr .qr-fs-code { width: min(60vh, 70vw); background: #fff; padding: clamp(16px, 2.4vw, 32px); border-radius: 14px; line-height: 0; box-sizing: border-box; }
.venue-talk-qr .qr-fs-code svg { display: block; width: 100%; height: auto; }
.venue-talk-qr .qr-fs-url { color: #e8eef5; font: 400 max(34px, 5vw)/1.15 system-ui, sans-serif; word-break: break-all; max-width: 92vw; text-align: center; }
.venue-talk-qr .qr-fs-url strong { font-weight: 800; color: #ffffff; }
` : ''}
</style>
</head>
<body class="${venue ? 'venue-screen' : homeOn ? 'hh-mode' : ''}">
${homeOn ? handoutHomeMarkup(home, { title, slideCount: slides.length }) : ''}
${preworkOn ? '<div class="pw-closed-host pw-closed-top" id="preworkClosedTop" hidden></div>' : ''}
<main class="share-shell">
  <div class="phone-bar" id="phoneBar" hidden>
    <button type="button" id="phoneBack" aria-label="All slides">‹ All slides</button>
    <span class="phone-bar-title" id="phoneBarTitle"></span>
    <button type="button" id="phoneFull" style="margin-left:auto" aria-label="Full screen">⤢ Full screen</button>
  </div>
  <div class="phone-list" id="phoneList" hidden>${preworkOn ? '<div class="pw-closed-host pw-closed-list" id="preworkClosedList" hidden></div>' : ''}</div>
  <div class="stage-fit" id="stageFit">
  <div class="stage" id="stage">
${slideMarkup}
  ${venue ? `<div class="venue-closing" id="venueClosing" hidden>${venueQr}<span>Slides and links</span><small>${escapeHtml(venueUrl)}</small></div>` : ''}
  </div>
  </div>
  ${workerBaseUrl && !venue ? '<div class="rx-dock" id="rxDock" hidden></div>' : ''}
  ${workerBaseUrl && !venue ? '<section class="bd-panel" id="bdPanel" aria-label="Board" hidden></section>' : ''}
  ${venue ? '<div class="venue-hint" id="venueHint">Click anywhere for full screen</div>' : ''}
  ${venue ? venueTalkQrMarkup(venueQr, venueUrl) : ''}
  <section class="phone-script" id="phoneScript" hidden></section>
  ${workerBaseUrl ? '<section class="audience-poll-surface" id="audiencePollSurface" aria-label="Audience poll" aria-live="polite" hidden></section>' : ''}
  <footer class="share-footer">
    <div><strong id="slideCount">1 / ${slides.length}</strong>${workerBaseUrl ? '<span class="now-live-badge" id="nowLiveBadge" hidden><span class="live-dot" aria-hidden="true"></span>Now live</span>' : ''}</div>
    <div class="share-actions">
      <button class="btn" id="prevBtn" type="button"><span class="btn-label">Previous</span></button>
      <button class="btn" id="nextBtn" type="button"><span class="btn-label">Next</span></button>
      <button class="btn" id="overviewBtn" type="button"><span class="btn-label">Overview</span></button>
      <button class="btn" id="revealBtn" type="button" aria-pressed="false"><span class="btn-label">Reveal</span></button>
      ${notesButton}
      <button class="btn" id="myNotesBtn" type="button"><span class="btn-label">My Notes</span></button>
      ${licenseDisclosure}
      <button class="btn" id="printBtn" type="button"><span class="btn-label">Print</span></button>
      ${liveControls}
    </div>
  </footer>
</main>
<aside class="nav-panel" id="navPanel" aria-label="Slide overview">
  <button class="btn" id="closeOverview" type="button"><span class="btn-label">Close</span></button>
  <h2>Overview
    <button type="button" id="navExpand" class="tw-overview-expand" aria-label="Toggle previews">&#8862; Previews</button>
    ${workerBaseUrl ? '<span class="now-live-badge" id="overviewNowLiveBadge" hidden><span class="live-dot" aria-hidden="true"></span>Now live</span>' : ''}
  </h2>
  <div class="nav-search-wrap">
    <svg class="nav-search-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M21 21l-4.5-4.5"></path></svg>
    <input class="nav-search" id="navSearch" type="search" placeholder="Search slides&#8230;" autocomplete="off" aria-label="Search slides">
  </div>
  <div id="navLegendHost"></div>
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
<div class="note-pop" id="notePop" role="dialog" aria-label="Highlight" hidden>
  <div class="note-pop-sent" id="notePopSentMark" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="m9 12 2 2 4-4"></path></svg><span>Sent to the speaker</span></div>
  <p class="note-pop-quote" id="notePopQuote"></p>
  <textarea id="notePopText" rows="2" maxlength="340" placeholder="Add a note (optional)&#8230;"></textarea>
  <p class="note-pop-words" id="notePopWords" hidden></p>
  <button class="np-btn np-save" id="notePopDone" type="button"><svg class="np-ico" id="notePopDoneIco" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13l4 4L19 7"></path></svg><span class="btn-label" id="notePopDoneLabel">Save to notes</span></button>
  <button class="np-btn np-send" id="notePopSend" type="button" hidden><svg class="np-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"></path><path d="m21.854 2.147-10.94 10.939"></path></svg><span class="btn-label" id="notePopSendLabel">Send to the speaker as a question</span></button>
  <p class="note-pop-line" id="notePopLine" role="status" hidden></p>
  <div class="note-pop-row">
    <button class="note-pop-remove" id="notePopRemove" type="button">Remove highlight</button>
  </div>
</div>
<aside class="mynotes-panel" id="myNotesPanel" aria-label="My notes">
  <div class="mn-head">
    <h2>My Notes</h2>
    <button class="btn" id="closeMyNotes" type="button"><span class="btn-label">Close</span></button>
  </div>
  <div class="mn-body" id="myNotesBody"></div>
  <div class="mn-foot">
    <p class="mn-foot-h">Take it away</p>
    <button class="btn mn-primary" id="notesPrint" type="button"><span class="btn-label">Print or save as PDF</span></button>
    <div class="mn-foot-actions">
      <button class="btn" id="notesCopyMd" type="button"><span class="btn-label">Copy as Markdown</span></button>
      <button class="btn" id="notesDownloadMd" type="button"><span class="btn-label">Download .md</span></button>
    </div>
  </div>
</aside>
<div class="focus-banner" id="modeBanner" role="status" aria-live="polite"></div>
<div class="fs-overlay" id="fsOverlay" role="dialog" aria-modal="true" aria-label="Slide full screen">
  <button class="fs-close" id="fsClose" type="button" aria-label="Close full screen">&times;</button>
  <div class="fs-rot" id="fsRot"><div class="fs-inner" id="fsInner"></div></div>
  <div class="fs-nav"><button id="fsPrev" type="button" aria-label="Previous slide">&lsaquo;</button><span id="fsCount"></span><button id="fsNext" type="button" aria-label="Next slide">&rsaquo;</button></div>
</div>
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
${preworkTemplate}${preworkOn ? '<div class="pw-app" id="preworkApp" hidden></div>' : ''}${markmapVendorSource}
${hasMermaid ? mermaidVendorSource : ""}
<script>
(() => {
  const VENUE_MODE = ${venue ? 'true' : 'false'};
  const HOME_MODE = ${homeOn ? 'true' : 'false'};
  var handoutHome = null;
  const slides = Array.from(document.querySelectorAll(".slide"));
  ${lazyOn ? `${lazySlideAssetsRuntimeSource()}
  // Heavy slide media arrive after the page: live → the speaker's slide first; otherwise what is on screen.
  var lazySlideAssets = createLazySlideAssets({ document, window, slides, liveConfigured: ${workerBaseUrl ? "true" : "false"} });` : "var lazySlideAssets = null;"}
  // Shared talk: each slide's markup as served, read before anything below touches it, so a
  // later push can tell exactly which slides changed.
  const SHARED_TALK_OPTIONS = ${sharedTalkOptions};
  const sharedTalkPristine = SHARED_TALK_OPTIONS ? slides.map((slide) => slide.outerHTML) : null;
  window.mermaid && window.mermaid.initialize({
    startOnLoad: false,
    theme: "neutral",
    securityLevel: "strict",
    suppressErrorRendering: true,
    flowchart: { htmlLabels: false }
  });
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
    jump: '<svg class="btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7"></path><path d="M8 7h9v9"></path></svg>',
    trash: '<svg class="btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"></path><path d="M10 11v6M14 11v6"></path><path d="M6 7l1 13h10l1-13"></path><path d="M9 7V4h6v3"></path></svg>',
    check: '<svg class="btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13l4 4L19 7"></path></svg>'
  };
  let index = VENUE_MODE ? 0 : Math.max(0, slides.findIndex((slide) => slide.dataset.id && location.hash.slice(1) === slide.dataset.id));
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
      sectionTitleById.set(slide.dataset.section, slide.dataset.navLabel || slide.dataset.navTitle || slide.dataset.section);
    } else if (role === "subsection-title" && slide.dataset.subsection) {
      subsectionTitleById.set(slide.dataset.subsection, slide.dataset.navLabel || slide.dataset.navTitle || slide.dataset.subsection);
    }
  });
  const navSearch = document.getElementById("navSearch");
  const navExpand = document.getElementById("navExpand");
  // The shared overview runtime (rankSlides / deriveSlideStatus / createOverview) is injected here
  // verbatim from the same source the presenter template uses — SINGLE SOURCE OF TRUTH.
  ${overviewRuntimeSource}
  const overviewSlideData = slides.map((el, slideIndex) => ({
    index: slideIndex,
    title: el.dataset.navLabel || el.dataset.navTitle || el.querySelector("h1,h2")?.textContent || "",
    section: el.dataset.section || "",
    subsection: el.dataset.subsection || "",
    body: el.textContent || "",
    notes: el.querySelector("aside.notes")?.textContent || "",
    subs: Array.from(el.querySelectorAll(".carousel-subslide")).map((c) => ({ title: c.dataset.subTitle || "", subIndex: Number(c.dataset.subIndex) || 0, body: c.textContent || "" })),
    el,
  }));
  var slideMarks = null;
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
    // Marks on each row: read from this device each time the list is built (createSlideMarks is below).
    beforeBuild: () => { if (slideMarks) slideMarks.refresh(); },
    slideMarks: (i) => (slideMarks ? slideMarks.marksFor(i) : null),
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
  // === Embedded local pages (0.38 ticket 11) ==================================================
  // The same mechanism as the deck (templates/presenter-popup-single-html.html): a local page is an
  // empty sandboxed frame (opaque origin) carrying its document in data-embed-doc beside a labelled
  // placeholder. It is loaded only on the active slide and unloaded on leaving it. This page gives
  // every frame role "none": the page's agent forwards navigation keys and Escape, and nothing is
  // mirrored. The channel source is inlined only when the page has such a slide.
  ${hasLocalEmbed ? embedChannelSource() : ""}
  var SHARE_EMBED_FRAMES = 'figure.slide-embed[data-embed="local"] > iframe[data-embed-doc]';
  var shareEmbedChannel = typeof embedCreateChannel === "function" ? embedCreateChannel({
    // The channel has checked the fixed key list, that THIS page engaged the frame (the reader
    // pressed its Interact chip), that the frame has the focus, a live user activation, and the rate.
    onKey: function (who, key) {
      if (key === "Escape") { leaveShareEmbed(who.frame); return; }
      window.dispatchEvent(new KeyboardEvent("keydown", { key: key, bubbles: true }));
    }
  }) : null;
  // The page's own frames that are live now, and the one the reader is using (engaged), if any.
  function liveShareEmbeds() {
    return Array.prototype.slice.call(document.querySelectorAll('figure.slide-embed[data-embed="local"][data-embed-state="live"] > iframe'));
  }
  function shareEmbedInUse() {
    if (!shareEmbedChannel) return null;
    return liveShareEmbeds().filter(function (frame) { var status = shareEmbedChannel.status(frame); return status && status.engaged; })[0] || null;
  }
  // THE RULE (runtime/embed-focus.js, the deck's own guard): an embedded page the reader has not
  // engaged never holds this page's focus; a text field of this page that a page took the focus
  // from gets it back; a frame hands the focus to this page before it is unloaded.
  var shareEmbedFocus = shareEmbedChannel && typeof embedCreateFocusGuard === "function"
    ? embedCreateFocusGuard({ channel: shareEmbedChannel, livePresent: function () { return liveShareEmbeds().length > 0; }, inUse: shareEmbedInUse, guarded: shareFrameMayNotHoldFocus, pages: unusedShareEmbeds, onStopped: function () { syncLocalShareEmbeds(); } })
    : null;
  // STOPPED (the guard's budget, counted for the slide): when the pages of the slide keep taking
  // the keyboard, every page of it that is not in use is unloaded to its placeholder, which says
  // so, until the slide is left and opened again, or the reader chooses one with its chip. The
  // record is the guard's; the figures carry it as an attribute (syncLocalShareEmbeds).
  function shareEmbedOrder(slide, frame) {
    return Math.max(0, Array.prototype.indexOf.call(slide.querySelectorAll("figure.slide-embed iframe"), frame));
  }
  // Frames with no record that may not hold the focus either (a page can put the focus on any
  // frame of this page): a local page's frame, loaded or not, and a frame of a slide not shown.
  function shareFrameMayNotHoldFocus(el) {
    if (el === shareEmbedInUse()) return false;
    if (el.matches(SHARE_EMBED_FRAMES)) return true;
    var slide = el.closest(".slide");
    return Boolean(slide && Array.prototype.indexOf.call(slides, slide) >= 0 && slide !== slides[index]);
  }
  function unusedShareEmbeds() {
    var slide = slides[index];
    if (!slide) return [];
    var inUse = shareEmbedInUse();
    return Array.prototype.slice.call(slide.querySelectorAll(SHARE_EMBED_FRAMES)).filter(function (frame) { return frame !== inUse; }).map(function (frame) { return shareEmbedOrder(slide, frame); });
  }
  // A local page's frame is compiled with scrolling="no" (no scrollbar, no wheel). While the reader
  // is using the page the attribute is off, so it scrolls with the wheel; it goes back afterwards.
  function setShareEmbedScrollable(frame, scrollable) {
    if (scrollable) frame.removeAttribute("scrolling");
    else frame.setAttribute("scrolling", "no");
  }
  function leaveShareEmbed(frame) {
    if (shareEmbedChannel) shareEmbedChannel.disengage(frame);
    frame.classList.remove("embed-live");
    setShareEmbedScrollable(frame, false);
    try { frame.blur(); } catch (e) { /* noop */ }
    try { window.focus(); } catch (e) { /* noop */ }
    // The pages suspended while this one was in use run again (from their beginning).
    syncLocalShareEmbeds();
  }
  // The stage is the view the reader is looking at. It is not while the phone's slide list, the
  // phone's full-screen picture or the pre-work form covers it, nor on the home page outside its
  // Live tab. Each of those calls syncLocalShareEmbeds() when it comes and goes.
  function shareStageShowing() {
    var body = document.body;
    if (body.classList.contains("phone-list-mode") || body.classList.contains("pw-open")) return false;
    var full = document.getElementById("fsOverlay");
    if (full && full.classList.contains("is-open")) return false;
    if (HOME_MODE && !(handoutHome && handoutHome.view() === "live")) return false;
    return true;
  }
  // A copy of a slide (a phone list row, the phone's full-screen picture) is a picture of it and
  // never runs a page: it carries no document, whatever state the slide it was copied from is in.
  // Called before the copy is put in the page.
  function idleEmbedClone(clone) {
    clone.querySelectorAll('figure.slide-embed[data-embed="local"]').forEach(function (figure) {
      figure.setAttribute("data-embed-state", "idle");
      figure.querySelectorAll("iframe").forEach(function (frame) {
        frame.removeAttribute("data-embed-doc");
        frame.removeAttribute("srcdoc");
        frame.classList.remove("embed-live");
      });
    });
    return clone;
  }
  // A page runs in ONE place: the current slide of the stage, while the stage is the view showing.
  // Only the stage's own slides are looked at (never the document: a copy of a slide carries
  // .active for its layout), so nothing outside the stage can be loaded from here.
  function syncLocalShareEmbeds() {
    var showing = !document.body.hasAttribute("data-tw-preview") && shareStageShowing();
    // SUSPENSION, as in the deck: while the reader is using one page, every other local page is
    // unloaded to its placeholder. A page that is engaged has this page's focus, and the browser
    // does not report a second page taking the keyboard from it.
    var inUse = shareEmbedInUse();
    if (inUse && !(slides[index] && slides[index].contains(inUse))) inUse = null;
    // A visit to a slide ends when another slide is opened: the record of stopped pages goes with it.
    if (shareEmbedFocus) shareEmbedFocus.visit(index);
    slides.forEach(function (slide, slideIndex) { slide.querySelectorAll(SHARE_EMBED_FRAMES).forEach(function (frame) {
      var figure = frame.parentElement;
      var live = figure.getAttribute("data-embed-state") === "live";
      figure.toggleAttribute("data-embed-stopped", Boolean(shareEmbedFocus && slideIndex === index && shareEmbedFocus.isStopped(shareEmbedOrder(slide, frame))));
      // Only a frame whose sandbox gives it an opaque origin is ever loaded.
      var want = Boolean(showing && shareEmbedChannel && slideIndex === index && slide.classList.contains("active")
        && frame.hasAttribute("sandbox") && !frame.sandbox.contains("allow-same-origin") && (!inUse || inUse === frame) && !figure.hasAttribute("data-embed-stopped"));
      if (want && !live) {
        var order = shareEmbedOrder(slide, frame);
        // The record first, then the document: the agent's ready must find it.
        if (!shareEmbedChannel.activate(frame, { slide: slide.dataset.id || "", index: order, role: "none" })) return;
        figure.setAttribute("data-embed-state", "live");
        // Not a tab stop: the way into a page is its Interact chip, which this page sees.
        frame.tabIndex = -1;
        frame.setAttribute("srcdoc", frame.getAttribute("data-embed-doc") || "");
        if (shareEmbedFocus) shareEmbedFocus.watch();
      } else if (!want && live) {
        // Before the page is unloaded: a frame that goes away holding the focus leaves this page with none.
        if (shareEmbedFocus) shareEmbedFocus.release(frame);
        shareEmbedChannel.deactivate(frame);
        frame.classList.remove("embed-live");
        setShareEmbedScrollable(frame, false);
        figure.setAttribute("data-embed-state", "idle");
        // Without srcdoc (and it never has src) the frame goes back to about:blank.
        frame.removeAttribute("srcdoc");
      }
    }); });
  }
  // Interact: a local page takes the pointer and the keyboard only after its chip is pressed;
  // Escape inside it, a press anywhere outside it, or leaving the slide hands them back.
  document.addEventListener("click", function (event) {
    var chip = event.target instanceof Element ? event.target.closest('figure.slide-embed[data-embed="local"] > .embed-interact-chip') : null;
    if (!chip) return;
    var frame = chip.parentElement.querySelector("iframe");
    if (!frame || !event.isTrusted) return;
    event.preventDefault();
    // One page at a time: a page still in use is left first, which also runs this one again if it
    // was suspended (its record is made before it is engaged).
    document.querySelectorAll(SHARE_EMBED_FRAMES + ".embed-live").forEach(function (other) { if (other !== frame) leaveShareEmbed(other); });
    // A stopped page that the reader chooses runs again (the slide's other stopped pages do not).
    if (chip.parentElement.hasAttribute("data-embed-stopped") && shareEmbedFocus && slides[index]) {
      shareEmbedFocus.resume(shareEmbedOrder(slides[index], frame));
      syncLocalShareEmbeds();
    }
    frame.classList.add("embed-live");
    // ENGAGED: a trusted press on the chip, in this document. Only then may a stepping key the page
    // forwards move the deck (a page can focus itself, and this window's user activation outlives
    // the reader's own key press, so neither proves the reader is using the page).
    if (shareEmbedChannel) shareEmbedChannel.engage(frame);
    setShareEmbedScrollable(frame, true);
    // At once: from here on no other local page may be running.
    syncLocalShareEmbeds();
    try { frame.focus(); } catch (e) { /* noop */ }
  });
  // A trusted key press that reaches THIS document means the reader is back in the deck.
  window.addEventListener("keydown", function (event) {
    if (event.isTrusted) document.querySelectorAll(SHARE_EMBED_FRAMES + ".embed-live").forEach(leaveShareEmbed);
  }, true);
  // So does a trusted press (mouse, touch or pen) anywhere outside the figure of the page in use.
  // pointerdown, not mousedown: a touch that becomes a drag or a scroll sends no mouse events.
  // (Presses inside the page never arrive here; its own chip is hidden while it is in use.)
  window.addEventListener("pointerdown", function (event) {
    if (!event.isTrusted) return;
    var target = event.target instanceof Element ? event.target : null;
    document.querySelectorAll(SHARE_EMBED_FRAMES + ".embed-live").forEach(function (frame) {
      if (target && frame.parentElement && frame.parentElement.contains(target)) return;
      leaveShareEmbed(frame);
    });
  }, true);
  function syncShareEmbeds() {
    syncLocalShareEmbeds();
    document.querySelectorAll(".slide.active iframe[data-src]").forEach((frame) => {
      if (!frame.src) frame.src = embedSrcFor(frame);
    });
  }
  // ADR-0018: scale the fixed slide canvas to fit its box, centred, and give the box the height
  // the scaled canvas actually occupies. This is the ONE place the slide is sized; nothing inside
  // it ever reflows, on any screen.
  var SLIDE_W = 1280, SLIDE_H = 720;
  function fitStage() {
    var fit = document.getElementById("stageFit");
    var stage = document.getElementById("stage");
    if (!fit || !stage) return;
    var availW = fit.clientWidth;
    var availH = fit.clientHeight || Math.round(availW * SLIDE_H / SLIDE_W);
    var scale = Math.min(availW / SLIDE_W, availH / SLIDE_H);
    if (!(scale > 0)) return;
    var left = Math.max(0, Math.round((availW - SLIDE_W * scale) / 2));
    var top = Math.max(0, Math.round((availH - SLIDE_H * scale) / 2));
    stage.style.transform = "translate(" + left + "px," + top + "px) scale(" + scale + ")";
  }
  window.addEventListener("resize", fitStage);
  window.addEventListener("orientationchange", fitStage);
  if (window.ResizeObserver) {
    var stageFitEl = document.getElementById("stageFit");
    if (stageFitEl) new ResizeObserver(fitStage).observe(stageFitEl);
  }

  // The app's slide fit pipeline — quote, code and title fit, the list ladder (ADR-0028 width
  // step, leading, gaps, type) and the whole-slide zoom — inlined verbatim from
  // compiler/assets/runtime/slide-fit.js, the SAME source the presenter template runs. It measures
  // in canvas units, so it fits the 1280x720 canvas identically whatever scale fitStage() applies.
  ${slideFitRuntimeSource}
  const slideFit = createSlideFit();
  function fitSlideClone(slide) {
    const content = slide ? slide.querySelector(":scope > .slide-content") : null;
    if (content) slideFit.fitContent(content);
  }
  // Run on the settled layout, as the app does (scheduleAutofit): two frames after the change, so
  // the gallery's active card, the reveal state and late images have laid out.
  function fitActiveSlide() {
    const slide = slides[index];
    if (!slide || !slide.classList.contains("active")) return;
    densifyActiveCards();
    fitSlideClone(slide);
    // Connector lines follow the final (possibly zoomed) positions.
    drawSystemLinks(slide);
  }
  let slideFitFrame = 0;
  function scheduleSlideFit() {
    cancelAnimationFrame(slideFitFrame);
    slideFitFrame = requestAnimationFrame(() => { slideFitFrame = requestAnimationFrame(fitActiveSlide); });
  }
  window.addEventListener("resize", scheduleSlideFit);
  document.addEventListener("load", (event) => {
    const target = event.target;
    if (target && target.tagName === "IMG" && target.closest && target.closest(".stage > .slide.active")) scheduleSlideFit();
  }, true);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleSlideFit);

  /* ---- ADR-0018 phone view: LIST of slides -> slide detail -> rotated full screen ----
     The list clones each real slide onto its own fixed canvas (the mechanism the overview
     drawer already uses) and scales it to full width. Clones are built lazily on scroll so a
     200-slide deck does not pay for 200 renders up front. */
  // ADR-0018 script companion: parsed from each slide's OUTLINE at compile time and carried on the
  // compiled deck, so the handout ships data rather than a markdown parser. Its outline text is
  // rendered to inline HTML here, at build time, by the compiler's renderer (slide-script-render.mjs)
  // so authoring syntax (**bold**, {icon=…}, [QR: …]) never reaches the phone as raw text.
  var SLIDE_SCRIPT = ${JSON.stringify(slides.map((slide) => renderScriptBlocks(slide.script))).replace(/</g, "\\u003c")};
  // Titles keep their formatting but never a link: the slide's own heading links nothing, and an
  // anchor in a tappable row or the bar would swallow the tap meant for the row. The renderer
  // builds them without links, so innerHTML only ever receives HTML the renderer made.
  var PHONE_TITLE_HTML = ${JSON.stringify(slides.map((slide) => renderSlideNavTitle(slide.html, { links: false }))).replace(/</g, "\\u003c")};
  function setPhoneTitle(el, i) {
    el.innerHTML = PHONE_TITLE_HTML[i] || "";
  }
  var PHONE_BP = 699;
  // Must be read BEFORE render(), which does history.replaceState("#"+id) on every paint — read
  // it later and every load looks like a deep link, so the list would never appear.
  var hadInitialHash = Boolean(location.hash);
  var phoneList = document.getElementById("phoneList");
  var phoneBar = document.getElementById("phoneBar");
  var phoneBarTitle = document.getElementById("phoneBarTitle");
  var phoneListBuilt = false;

  function isPhone() { return window.matchMedia("(max-width: " + PHONE_BP + "px)").matches; }

  function fitPhoneRow(row) {
    var inner = row.querySelector(".pslide-inner");
    var box = row.querySelector(".pslide-canvas");
    if (!inner || !box) return;
    var scale = box.clientWidth / SLIDE_W;
    inner.style.transform = "scale(" + scale + ")";
  }

  function buildPhoneList() {
    if (phoneListBuilt || !phoneList) return;
    phoneListBuilt = true;
    var observer = window.IntersectionObserver ? new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var row = entry.target;
        if (row.dataset.filled) return;
        row.dataset.filled = "1";
        var i = Number(row.dataset.index);
        var clone = idleEmbedClone(slides[i].cloneNode(true));
        clone.classList.add("active");
        clone.removeAttribute("id");
        var note = clone.querySelector(".notes");
        if (note) note.remove();
        row.querySelector(".pslide-inner").appendChild(clone);
        fitPhoneRow(row);
        fitSlideClone(clone);
        observer.unobserve(row);
      });
    }, { root: phoneList, rootMargin: "400px 0px" }) : null;

    slides.forEach(function (slide, i) {
      var row = document.createElement("button");
      row.type = "button";
      row.className = "pslide-row";
      row.dataset.index = String(i);
      var box = document.createElement("div");
      box.className = "pslide-canvas";
      var inner = document.createElement("div");
      inner.className = "pslide-inner";
      box.appendChild(inner);
      row.appendChild(box);
      var label = document.createElement("div");
      label.className = "pslide-label";
      var num = document.createElement("span");
      num.className = "pslide-num";
      num.textContent = (i + 1) + " / " + slides.length;
      var title = document.createElement("span");
      title.className = "pslide-title";
      setPhoneTitle(title, i);
      label.appendChild(num);
      label.appendChild(title);
      row.appendChild(label);
      row.addEventListener("click", function () { showPhoneDetail(i); });
      phoneList.appendChild(row);
      if (observer) observer.observe(row); else { row.dataset.filled = "1"; }
    });

    if (!observer) {
      // No IntersectionObserver: fill everything, correctness over cost.
      phoneList.querySelectorAll(".pslide-row").forEach(function (row) {
        var i = Number(row.dataset.index);
        var clone = idleEmbedClone(slides[i].cloneNode(true));
        clone.classList.add("active");
        row.querySelector(".pslide-inner").appendChild(clone);
        fitPhoneRow(row);
        fitSlideClone(clone);
      });
    }
  }

  function showPhoneList() {
    if (!isPhone()) return;
    document.body.classList.add("phone-list-mode");
    document.body.classList.remove("phone-detail-mode");
    if (phoneBar) phoneBar.hidden = true;
    if (phoneList) phoneList.hidden = false;
    // The list covers the stage: the page on its current slide stops.
    syncLocalShareEmbeds();
    buildPhoneList();
    refreshPhoneListMarks();
  }
  // The phone slide list carries, at its top, a strip that opens My Notes and the legend of the marks, and one
  // small mark per kind on each row. Rebuilt whenever what the device holds may have changed.
  function refreshPhoneListMarks() {
    if (!phoneList || !phoneListBuilt || !slideMarks) return;
    slideMarks.refresh();
    phoneList.querySelectorAll(".mn-marks").forEach(function (node) { node.remove(); });
    phoneList.querySelectorAll(".pslide-row").forEach(function (row) {
      var marks = slideMarks.marksFor(Number(row.dataset.index));
      var label = row.querySelector(".pslide-label");
      if (marks && label) label.appendChild(marks);
    });
    var count = slideMarks.slides();
    var head = phoneList.querySelector(".mn-listhead");
    if (!head) {
      head = document.createElement("div");
      head.className = "mn-listhead";
      var open = document.createElement("button");
      open.type = "button";
      open.className = "mn-open-notes";
      var name = document.createElement("span");
      name.className = "mn-open-notes-name";
      name.textContent = "My Notes";
      var small = document.createElement("small");
      open.appendChild(name);
      open.appendChild(small);
      open.addEventListener("click", function () { setMyNotesOpen(true); });
      head.appendChild(open);
      head.appendChild(slideMarks.legend());
      phoneList.insertBefore(head, phoneList.firstChild);
    }
    head.querySelector(".mn-open-notes small").textContent = count === 0 ? "Nothing yet" : count === 1 ? "1 slide" : count + " slides";
  }

  /* The script companion. Authored structure is rebuilt verbatim: depth becomes real nesting,
     prose stays prose, quotes stay quotes, media is named. No apology copy — a slide the outline
     never authored simply shows nothing here (ADR-0018 §5). */
  function renderPhoneScript(i) {
    var host = document.getElementById("phoneScript");
    if (!host) return;
    host.replaceChildren();
    var title = document.createElement("h2");
    title.className = "ps-title";
    setPhoneTitle(title, i);
    host.appendChild(title);

    var blocks = SLIDE_SCRIPT[i];
    if (!blocks || !blocks.length) return;

    blocks.forEach(function (block) {
      if (block.type === "list") {
        var root = document.createElement("ul");
        var stack = [root];
        block.items.forEach(function (item) {
          var depth = Math.max(0, Math.min(Number(item.depth) || 0, stack.length));
          while (stack.length - 1 > depth) stack.pop();
          while (stack.length - 1 < depth) {
            var parentLi = stack[stack.length - 1].lastElementChild;
            var sub = document.createElement("ul");
            (parentLi || stack[stack.length - 1]).appendChild(sub);
            stack.push(sub);
          }
          var li = document.createElement("li");
          li.innerHTML = item.html || "";
          if (item.pairHtml) {
            var span = document.createElement("span");
            span.className = "ps-pair";
            span.innerHTML = item.pairHtml;
            li.appendChild(span);
          }
          stack[stack.length - 1].appendChild(li);
        });
        host.appendChild(root);
      } else if (block.type === "quote") {
        var q = document.createElement("blockquote");
        q.innerHTML = block.html || "";
        host.appendChild(q);
      } else if (block.type === "attrib") {
        var a = document.createElement("p");
        a.className = "ps-attrib";
        a.innerHTML = "— " + (block.html || "");
        host.appendChild(a);
      } else if (block.type === "qr") {
        var qr = document.createElement("div");
        qr.className = "ps-media";
        var qrLabel = document.createElement("b");
        qrLabel.textContent = "QR code";
        var qrLink = document.createElement("span");
        qrLink.innerHTML = block.html || "";
        qr.appendChild(qrLabel);
        qr.appendChild(qrLink);
        host.appendChild(qr);
      } else if (block.type === "code") {
        var pre = document.createElement("pre");
        pre.className = "ps-code";
        var code = document.createElement("code");
        code.textContent = block.text || "";
        pre.appendChild(code);
        host.appendChild(pre);
      } else if (block.type === "audio") {
        // An audio file is a static label here: the phone never loads or plays it.
        var au = document.createElement("div");
        au.className = "ps-media";
        var auLabel = document.createElement("b");
        auLabel.textContent = "Audio";
        var auTitle = document.createElement("span");
        auTitle.textContent = block.title || "";
        au.appendChild(auLabel);
        au.appendChild(auTitle);
        host.appendChild(au);
      } else if (block.type === "diagram") {
        // A diagram fence (mermaid, svg) is a picture on the slide: named, never its source.
        var dg = document.createElement("div");
        dg.className = "ps-media";
        var dgLabel = document.createElement("b");
        dgLabel.textContent = "Diagram";
        dg.appendChild(dgLabel);
        host.appendChild(dg);
      } else if (block.type === "media") {
        var m = document.createElement("div");
        m.className = "ps-media";
        var label = document.createElement("b");
        label.textContent = "Figure";
        var alt = document.createElement("span");
        alt.textContent = block.alt || "";
        m.appendChild(label);
        m.appendChild(alt);
        host.appendChild(m);
      } else if (block.type === "table") {
        var table = document.createElement("table");
        block.rows.forEach(function (row, rowIndex) {
          var tr = document.createElement("tr");
          row.forEach(function (cell) {
            var td = document.createElement(rowIndex === 0 ? "th" : "td");
            td.innerHTML = cell;
            tr.appendChild(td);
          });
          table.appendChild(tr);
        });
        host.appendChild(table);
      } else {
        var p = document.createElement("p");
        p.innerHTML = block.html || "";
        host.appendChild(p);
      }
    });
  }

  /* Keep the detail view's title and script on the slide that is actually showing. Called from
     render(), so every navigation path stays in step. */
  function syncPhoneDetail() {
    if (!document.body.classList.contains("phone-detail-mode")) return;
    if (phoneBarTitle) setPhoneTitle(phoneBarTitle, index);
    renderPhoneScript(index);
  }

  function showPhoneDetail(i) {
    if (typeof i === "number") go(i);
    if (!isPhone()) return;
    document.body.classList.remove("phone-list-mode");
    document.body.classList.add("phone-detail-mode");
    if (phoneList) phoneList.hidden = true;
    if (phoneBar) phoneBar.hidden = false;
    syncPhoneDetail();
    fitStage();
    // The stage shows again: the page on its current slide starts from its beginning.
    syncLocalShareEmbeds();
  }

  function applyPhoneMode() {
    if (isPhone()) {
      if (!document.body.classList.contains("phone-detail-mode")) showPhoneList();
      else showPhoneDetail();
    } else {
      document.body.classList.remove("phone-list-mode", "phone-detail-mode");
      if (phoneList) phoneList.hidden = true;
      if (phoneBar) phoneBar.hidden = true;
      fitStage();
      syncLocalShareEmbeds();
    }
  }

  /* ---- full screen: rotate the slide so its long edge runs down the phone ---- */
  var fsOverlay = document.getElementById("fsOverlay");
  var fsRot = document.getElementById("fsRot");
  var fsInner = document.getElementById("fsInner");
  var fsCount = document.getElementById("fsCount");

  function layoutFullScreen() {
    if (!fsOverlay || !fsOverlay.classList.contains("is-open")) return;
    var vw = window.innerWidth, vh = window.innerHeight;
    var portrait = vh > vw;
    var scale = portrait ? Math.min(vh / SLIDE_W, vw / SLIDE_H) : Math.min(vw / SLIDE_W, vh / SLIDE_H);
    if (portrait) {
      fsRot.style.width = Math.round(SLIDE_H * scale) + "px";
      fsRot.style.height = Math.round(SLIDE_W * scale) + "px";
      fsInner.style.transform = "translateX(" + Math.round(SLIDE_H * scale) + "px) rotate(90deg) scale(" + scale + ")";
    } else {
      fsRot.style.width = Math.round(SLIDE_W * scale) + "px";
      fsRot.style.height = Math.round(SLIDE_H * scale) + "px";
      fsInner.style.transform = "scale(" + scale + ")";
    }
    if (fsCount) fsCount.textContent = (index + 1) + " / " + slides.length;
  }

  function paintFullScreen() {
    if (!fsInner) return;
    fsInner.replaceChildren();
    var clone = idleEmbedClone(slides[index].cloneNode(true));
    clone.classList.add("active");
    clone.removeAttribute("id");
    var note = clone.querySelector(".notes");
    if (note) note.remove();
    fsInner.appendChild(clone);
    layoutFullScreen();
    fitSlideClone(clone);
  }

  function openFullScreen() {
    if (!fsOverlay) return;
    fsOverlay.classList.add("is-open");
    // The full-screen picture covers the stage: the page under it stops (the picture holds none).
    syncLocalShareEmbeds();
    paintFullScreen();
  }
  function closeFullScreen() {
    if (fsOverlay) fsOverlay.classList.remove("is-open");
    syncLocalShareEmbeds();
  }
  function stepFullScreen(delta) {
    go((index + delta + slides.length) % slides.length);
    paintFullScreen();
  }

  document.getElementById("phoneBack")?.addEventListener("click", showPhoneList);
  document.getElementById("phoneFull")?.addEventListener("click", openFullScreen);
  document.getElementById("fsClose")?.addEventListener("click", closeFullScreen);
  document.getElementById("fsPrev")?.addEventListener("click", function () { stepFullScreen(-1); });
  document.getElementById("fsNext")?.addEventListener("click", function () { stepFullScreen(1); });
  window.addEventListener("resize", layoutFullScreen);
  window.addEventListener("orientationchange", function () { setTimeout(layoutFullScreen, 60); });
  window.addEventListener("resize", function () { setTimeout(applyPhoneMode, 60); });
  // Full screen owns the keyboard while it is open, so Esc/arrows never fall through to the deck.
  document.addEventListener("keydown", function (event) {
    if (!fsOverlay || !fsOverlay.classList.contains("is-open")) return;
    if (event.key === "Escape") { event.preventDefault(); closeFullScreen(); }
    else if (event.key === "ArrowRight") { event.preventDefault(); stepFullScreen(1); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); stepFullScreen(-1); }
  }, true);
  var fsTouchX = 0;
  fsOverlay?.addEventListener("touchstart", function (e) { fsTouchX = e.touches[0].clientX; }, { passive: true });
  fsOverlay?.addEventListener("touchend", function (e) {
    var dx = e.changedTouches[0].clientX - fsTouchX;
    if (Math.abs(dx) > 45) stepFullScreen(dx < 0 ? 1 : -1);
  }, { passive: true });

  function render() {
    slides.forEach((slide, slideIndex) => slide.classList.toggle("active", slideIndex === index));
    fitStage();
    // The script companion must follow the slide from EVERY navigation path — full-screen swipe,
    // the footer's Next/Previous, keyboard, live follow. render() is the one place the current
    // slide changes, so the sync lives here rather than in each caller (stepping full screen used
    // to move the slide while the text below stayed on the previous one).
    syncPhoneDetail();
    // The shared factory paints the "current" row itself; re-render it when the drawer is open so
    // the highlight (and any live filter) tracks slide changes.
    if (overview.isOpen()) overview.render();
    count.textContent = (index + 1) + " / " + slides.length;
    const id = slides[index]?.dataset.id;
    if (id && !HOME_MODE) history.replaceState(null, "", "#" + id);
    if (handoutHome) handoutHome.slideChanged(index);
    if (notesBody) {
      const note = slides[index]?.querySelector(".notes");
      notesBody.replaceChildren();
      if (note) notesBody.appendChild(note.cloneNode(true));
    }
    syncShareEmbeds();
    drawSystemLinks(slides[index]);
    initMarkmaps(slides[index]);
    initMermaids(slides[index]);
    scheduleSlideFit();
    ${venue ? "venueBoards.slideChanged();" : ""}
    if (sharedTalkController) sharedTalkController.slideChanged();
  }
  let liveNavigationObserver = null;
  // The venue screen's playback of {play-on-next} files (set further down; null on every other page).
  let venueMediaSteps = null;
  let sharedTalkController = null;
  let audienceRevealIndex = 0;
  function go(nextIndex, options = {}) {
    index = Math.max(0, Math.min(slides.length - 1, nextIndex));
    // Handouts default to COMPLETE slides: a handout is for reading, so authored {data-mode} is
    // NOT auto-entered here. Reveal/Focus is opt-in (the Reveal button / R / F); once the reader
    // turns it on it is sticky across slides, with the step just resetting to 0 on each slide.
    modeStep = 0;
    // Whatever the presenter last sent belonged to the slide being left (a live arrival sets it
    // again in applyLiveSlideState).
    liveFocus = null;
    galleryStep = 0;
    audienceRevealIndex = 0;
    render();
    applyModeDimming();
    applyGallery();
    // A move of the venue screen's own (its keyboard, with no presenter driving) stops every file.
    if (venueMediaSteps && !options.fromLive) venueMediaSteps.apply(slides[index], [], []);
    if (liveNavigationObserver) liveNavigationObserver(slides[index]?.dataset.id || "", Boolean(options.fromLive));
  }
  // Live protocol helpers are injected from compiler/assets/runtime/live-follow.js, the same
  // testable module exercised by scripts/live-follow-client.test.mjs.
  ${liveFollowRuntimeSource()}
  const LIVE_CONFIG = ${liveConfig};
  ${venue ? `// Feedback boards (ADR-0032, ticket 04): the venue screen draws each board into its slide with the
  // frame the big screen uses. The join is the talk's own link, the one phones open.
  ${boardScreenRuntimeSource}
  const VENUE_JOIN = ${JSON.stringify({ shortUrl: String(venueUrl || ""), qrSvg: String(venueQr || "") }).replace(/</g, "\\u003c")};
  const venueBoards = createBoardScreen({ slides: () => slides, join: () => VENUE_JOIN });` : ""}
  let venueFollowController = null;
  let audienceFollowController = null;
  function initialiseLiveFollow() {
    if (!LIVE_CONFIG) return;
    const controller = createAudienceFollowRuntime({
      document,
      liveConfig: LIVE_CONFIG,
      venue: VENUE_MODE,
      breakQr: ${venue ? '() => ({ svg: VENUE_JOIN.qrSvg, url: VENUE_JOIN.shortUrl, link: /^https?:\\/\\//i.test(VENUE_JOIN.shortUrl) })' : 'null'},
      getViewerPosition: currentViewerPosition,
      applyLiveSlideState,
      releaseLiveSlideState,
      // A phone that joins a board left open after End live has no slide to follow: take it to the board's slide.
      showSlide: (slideId) => {
        const at = slides.findIndex((slide) => slide.dataset.id === slideId);
        if (at < 0) return;
        go(at);
        if (isPhone()) showPhoneDetail(at);
      },
      // The reaction bar (ADR-0027): never on the venue screen; its marks are kept beside My Notes' key.
      reactions: VENUE_MODE ? null : {
        storageKey: REACTIONS_KEY,
        questionsKey: QUESTIONS_KEY,
        // My Notes lists what the bar and Ask keep on this device, so they tell it when that changes.
        onMarksChanged: () => renderMyNotes(),
        onQuestionKept: () => renderMyNotes(),
        // A question sent from a highlight's note is answered to that note (the popup and My Notes show it).
        onNoteQuestion: (receipt) => {
          liveNoteSends.delete(receipt.submissionId);
          const note = readerNotes.find((entry) => entry.sendId && entry.sendId === receipt.submissionId);
          if (!note) return false;
          if (receipt.status === "confirmed") { note.sentAt = new Date().toISOString(); noteSendErrors.delete(note.id); }
          else {
            noteSendErrors.set(note.id, receipt.error || "");
            // A stored id is only worth reusing when the worker may have stored the question.
            if (receipt.error !== "no_answer" && receipt.error !== "protocol_error") delete note.sendId;
          }
          saveNotes();
          if (notePopNoteId === note.id && !notePop.hidden) renderNotePop();
          renderMyNotes();
          // A phone note has no popup: the bar's line says how its send ended.
          const bar = audienceFollowController && audienceFollowController.reactions;
          if (note.type === "slide" && bar) {
            bar.notify(receipt.status === "confirmed"
              ? { tone: "ok", icon: "circle-check", text: "Saved on this phone. Sent to the speaker." }
              : { tone: "failed", icon: "circle-x", text: "Saved on this phone. Not sent to the speaker. Open My Notes to try again." }, receipt.status === "confirmed" ? 5000 : 8000);
          }
          return true;
        },
        // Note on the phone bar: a note kept on this device for a slide, sent as a question only when ticked.
        onSlideNote: (input) => addSlideNote(input),
        getNoteCount: (slideId) => readerNotes.filter((entry) => entry.slideId === slideId).length,
        // The speaker paused or resumed questions, or the live session started or stopped: the popup follows.
        onSwitchesChanged: () => { if (!notePop.hidden) renderNotePop(); },
        isPhone,
        // Ask the speaker heads its box with the slide it is about, and gives way to the overlays that own the keyboard.
        getSlideInfo: (slideId) => { const at = slides.findIndex((slide) => slide.dataset.id === slideId); return { number: at + 1, title: slideTitleFor(at) }; },
        // The slide's own reactions, stamped by the compiler from its {reactions=…} (ticket 04): a list of
        // registered ids and custom:<label> ids, [] for off; no attribute is the standard set (null).
        getSlideReactions: (slideId) => {
          const slide = slides.find((candidate) => candidate.dataset.id === slideId);
          if (!slide || slide.dataset.reactions == null) return null;
          try { const list = JSON.parse(slide.dataset.reactions); return Array.isArray(list) ? list : null; } catch { return null; }
        },
        isBlocked: () => helpOverlay.classList.contains("open") || lbOpen,
      },
      onPollAnswered: () => renderMyNotes(),
      // The home page (design 2026-10-02 B) turns to its Live tab while a session is live.
      onLiveChanged: (live) => { if (handoutHome) handoutHome.setLive(live); if (lazySlideAssets) lazySlideAssets.setLive(live); },
      // The speaker's slide, followed or not: its media are fetched first.
      onLiveSlideState: (slideId) => { if (lazySlideAssets) lazySlideAssets.setLiveSlide(slides.findIndex((slide) => slide.dataset.id === slideId)); },
      // A full-screen instant slide waits while the person reads the Handout tab; the Live tab says it is there.
      instantAllowed: () => !handoutHome || handoutHome.view() === 'live' || !handoutHome.isLive(),
      onInstantChanged: (slide) => { if (handoutHome) handoutHome.setInstant(slide); },
      // A board that cannot be drawn must not drop the live connection the client guards with fail().
      onBoardState: ${venue ? "(message) => { try { venueBoards.receive(message); } catch (error) { console.error(error); } }" : "undefined"},
      onEnded: VENUE_MODE ? showVenueClosing : undefined,
    });
    if (controller) {
      audienceFollowController = VENUE_MODE ? null : controller;
      venueFollowController = VENUE_MODE ? controller : null;
      liveNavigationObserver = (_viewedSlideId, fromLive) => { if (!fromLive && !VENUE_MODE) controller.viewerMoved(); controller.slideChanged(); };
    }
  }
  // Shared talk (ticket 04): the colleague's comments runtime, injected like Follow live from
  // compiler/assets/runtime/shared-talk-page.js (tested by scripts/shared-talk-runtime.test.mjs).
  ${sharedTalkOptions !== "null" ? sharedTalkRuntimeSource() : ""}
  function initialiseSharedTalk() {
    if (!SHARED_TALK_OPTIONS) return;
    sharedTalkController = createSharedTalkPage({
      document,
      window,
      features: SHARED_TALK_OPTIONS,
      host: {
        slides: () => slides,
        pristineHtml: (i) => sharedTalkPristine[i] || "",
        currentIndex: () => index,
        go: (i) => go(i),
        render: () => render(),
        fitStage: () => fitStage(),
        fitClone: (clone) => fitSlideClone(clone),
        setCount: (text) => { count.textContent = text || ((index + 1) + " / " + slides.length); },
      },
    });
  }
  function showVenueClosing() {
    go(0, { fromLive: true });
    showVenueTalkQr(false);
    document.getElementById('venueClosing').hidden = false;
  }
  // Ticket 04: the presenter's "Show the talk's QR code" rides slide.state as talkQr; only the
  // venue screen renders it (phones never build the overlay, so they carry on as they were).
  function showVenueTalkQr(open) {
    const overlay = document.getElementById('venueTalkQr');
    if (overlay) overlay.hidden = !open;
  }
  // LOCAL reveal/focus stepping modes (no presenter sync in share exports). Same selector list,
  // stepping grammar and CSS hooks as the deck runtime; banner auto-dismiss at 2.5s.
  // Synced 2026-06-12 to the FULL template list (the share copy had drifted — contrast pairs,
  // tiles, system-map satellites, evidence/cta units, smartart/mindmap/pyramid/orgchart nodes
  // were missing, so those slides would not step in handouts) + the batch-2 units (bar-chart
  // columns, cycle nodes). When the template runtime's MODE_SELECTOR gains an entry, add it
  // HERE too — "npm run test:mode-selector-parity" fails on drift.
  // NOTE: this block lives inside a String.raw template literal — never use backticks in it.
  // 2026-07-19: ".timeline .tl-dyn-entries > li" was missing here, so {timeline=dynamic} slides
  // enumerated ZERO units on the audience handout and reveal/focus following silently no-opped
  // on them. The parity test named above did not exist at the time; it does now.
  const MODE_SELECTOR = ".feature-list[data-reveal-group],.feature-list > li:not(.image-grid *):not([data-reveal-group] *),.feature-list .fl-sublist > li:not([data-reveal-group] *),.timeline .tl-entries > li,.timeline .tl-dyn-entries > li,.timeline .tl-spine-track > li,.timeline > li,.slide-content > blockquote,.statement,.slide-content .content-p:not(.card-gallery *):not(.evidence-layout *):not(.cta-layout *):not(.image-grid *),figure.slide-figure:not(.evidence-layout *):not(.cta-layout *),.trace .turn,.contrast-grid > .contrast-pair,.tile-grid > div,.system-map > div:not(.system-centre),.evidence-layout .callouts > li,.cta-layout .cta-shot,.cta-layout .callouts > li,.cta-layout .slide-action,.smartart-node:not(.smartart-node *),.flow > .flow-node,.flow-cycle-row > .flow-node,.flow-snake-row > .flow-node,.flow > .flow-item,.pyramid .pyr-tier,.orgchart .org-box,.stats-row > .stat,.process-strip > .proc-step,.steps-diagram > .step-col,.icon-row > .ir-item,.image-grid > .ig-cell,.chart-cols > .chart-col,.cycle-diagram .cycle-node,.cycle-diagram .cycle-arc-svg,.timetable tbody tr,.slide-table tbody tr,.mindmap-mm > .mm-step,.layout-compare .compare-half.half-b";
  const CARD_UNIT_SELECTOR = ".feature-list > li,blockquote,figure.slide-figure,p.content-p";
  let modeKind = null;   // null | "reveal" | "focus"
  let modeStep = 0;
  // "Emphasis appears on Next" (0.38 ticket 02). The order and count of a slide's steps when its
  // emphasis steps, inlined from compiler/assets/runtime/emphasis-steps.js: the SAME source the
  // deck runtime runs, so the venue screen and the projector read one step the same way.
  ${emphasisStepsRuntimeSource()}
  ${venue ? `// "Play as a step" (0.38 ticket 05): the venue screen starts and stops a {play-on-next} file from
  // the step it is sent, with the SAME playback source the projector runs (runtime/media-steps.js)
  // and the audio chip's own runtime. A handout and a phone never carry either: they show the file
  // in its static form.
  ${audioChipRuntimeSource()}
  ${mediaStepsRuntimeSource()}
  venueMediaSteps = createMediaStepController({
    canPlay: function () { return !document.body.hasAttribute("data-tw-preview"); },
    audioChips: createAudioChipController({})
  });` : ""}
  // A handout, the phone view and print show all emphasis: the reader's own Reveal / Focus steps
  // the block units only. Emphasis follows a step only while this page shows what the presenter
  // sent, which is what the venue screen always shows.
  //
  // liveFocus is that message's focus AS SENT ({ kind, step }, the wire form of ADR-0035), kept
  // only while the page still shows it; null for the reader's own modes and after any move of the
  // reader's own. modeKind / modeStep are the mode ON SHOW, decoded: an emphasis-only step is sent
  // as kind "reveal" and is no mode at all, so modeKind is null there and one click on Reveal (or
  // Focus) enters the reader's own mode.
  let liveFocus = null;
  let emphasisPainted = null;
  // Whether the image sequence runs on this slide: the deck runtime's imageStops rule, read from
  // the same markup (the setting's stamp, no carousel, no {nostep}, a still image that is not the
  // slide's lone full-bleed figure).
  function imageSequenceHere(slide) {
    if (!slide.hasAttribute("data-image-steps") || slide.hasAttribute("data-carousel") || slide.hasAttribute("data-nostep") || galleryIn(slide)) return false;
    const stills = slide.querySelectorAll("figure.slide-figure img, .image-grid .ig-media img");
    if (stills.length !== 1) return stills.length > 0;
    const figure = stills[0].closest("figure.slide-figure");
    return !(figure && figure.parentElement && figure.parentElement.matches(".slide-content.layout-media"));
  }
  // "Play as a step" on the venue screen: each {play-on-next} file's state is read from ONE live
  // message, its focus (the step, in the wire form of ADR-0035) and its lightbox (the image
  // sequence, which runs after the slide's own steps: once it has begun no file plays). Called
  // once per message, after the slide, the card and the mode are in place, so a message that
  // repeats the step never restarts a file. With no focus every file on the slide waits.
  function applyVenueMedia(focus, lightbox) {
    if (!venueMediaSteps) return;
    const slide = slides[index];
    const found = focus ? liveEmphasisUnits(slide) : null;
    const at = found ? emphasisFromWire(found.units, focus) : null;
    if (!at) { venueMediaSteps.apply(slide, [], []); return; }
    const movedOn = Boolean(lightbox && (lightbox.open || Number(lightbox.index) > 0)) && imageSequenceHere(slide);
    venueMediaSteps.apply(slide, mediaStepFiles(found.els), mediaStepStates(found.units, at.mode, at.step, movedOn));
  }
  function liveEmphasisUnits(slide) {
    if (!slide || !(slide.hasAttribute("data-emphasis-steps") || slide.hasAttribute("data-media-steps"))) return null;
    const gallery = galleryIn(slide);
    const card = gallery ? (gallery.querySelector(".card.active-card") || gallery.querySelector(".card")) : null;
    const blocks = !gallery ? MODE_SELECTOR : (card && !card.classList.contains("card-title") ? CARD_UNIT_SELECTOR : "");
    const els = emphasisStepElements(gallery ? card : slide, blocks, isVisibleUnit);
    // Something steps with no mode on: an emphasis span or a {play-on-next} file.
    const units = emphasisStepUnits(els);
    if (!units.some((unit) => unit.kind !== "block")) return null;
    return { els, units };
  }
  function liveEmphasisPlan(slide) {
    const found = liveFocus ? liveEmphasisUnits(slide) : null;
    if (!found) return null;
    const at = emphasisFromWire(found.units, liveFocus);
    return { els: found.els, units: found.units, kind: at.mode, states: emphasisStepStates(found.units, at.mode, at.step) };
  }
  // The reader stops following without moving (the Follow button, or the session ends): the page
  // goes back to what a handout shows, all emphasis on. The venue screen never leaves the session's
  // last state this way.
  function releaseLiveSlideState() {
    if (VENUE_MODE || !liveFocus) return;
    liveFocus = null;
    applyModeDimming();
  }
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
    // A reveal step changes what is laid out: fit again, as the app does on every step.
    scheduleSlideFit();
    // Emphasis steps sent by the presenter (null on every other slide and for the reader's own
    // modes). Its kind is the mode the step belongs to: null when only emphasis steps.
    const emphasis = liveEmphasisPlan(slide);
    const kind = emphasis ? emphasis.kind : modeKind;
    slide.classList.toggle("mode-active", Boolean(kind));
    slide.classList.toggle("mode-reveal", kind === "reveal");
    slide.classList.toggle("mode-focus", kind === "focus");
    syncRevealBtn(kind);
    if (emphasisPainted && emphasisPainted !== slide) {
      paintEmphasisStates(emphasisPainted, [], []);
      emphasisPainted.classList.remove("emph-anim");
      emphasisPainted = null;
    }
    if (emphasis) {
      stampEmphasisPlainWeight(slide, getComputedStyle);
      paintEmphasisStates(slide, emphasis.els, emphasis.states);
      if (emphasisPainted !== slide) {
        emphasisPainted = slide;
        requestAnimationFrame(() => { if (emphasisPainted === slide) slide.classList.add("emph-anim"); });
      }
    } else if (emphasisPainted === slide) {
      paintEmphasisStates(slide, [], []);
      slide.classList.remove("emph-anim");
      emphasisPainted = null;
    }
    const units = !kind ? [] : emphasis ? emphasis.els.filter((_, i) => stepUnitIsBlock(emphasis.units[i])) : modeElements();
    const live = new Set(units);
    slide.querySelectorAll(".mode-el").forEach((el) => {
      if (live.has(el)) return;
      el.classList.remove("mode-el");
      el.removeAttribute("data-mode-state");
    });
    if (emphasis) {
      const blockStates = emphasis.states.filter((_, i) => stepUnitIsBlock(emphasis.units[i]));
      const blocksOn = blockStates.some((value) => value === "full") ? units.length + 1 : blockStates.filter((value) => value === "soft" || value === "current").length;
      applyMindmapRevealForSlide(slide, kind, kind ? blocksOn : 0);
      if (!kind || units.length === 0) return;
      var newest = null;
      units.forEach((el, i) => {
        if (!el.classList.contains("mode-el")) el.classList.add("mode-el");
        if (blockStates[i] === "current") newest = el;
        if (el.getAttribute("data-mode-state") !== blockStates[i]) el.setAttribute("data-mode-state", blockStates[i]);
      });
      if (newest) scrollCurrentUnitIntoView([newest], 1);
      return;
    }
    // Mindmap unfold rides the same step as the .mm-step markers (counted in units).
    applyMindmapRevealForSlide(slide, modeKind, clampStep(modeStep, units.length));
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
  function setModeState(kind, step, announce, fromLive) {
    closeLightbox();
    modeKind = kind === "reveal" || kind === "focus" ? kind : null;
    modeStep = modeKind ? Math.max(0, Number(step) || 0) : 0;
    liveFocus = fromLive === true && modeKind ? { kind: modeKind, step: modeStep } : null;
    // On a slide whose emphasis steps, what was sent is decoded before it becomes the page's mode.
    const sent = liveFocus ? liveEmphasisUnits(slides[index]) : null;
    if (sent) {
      const at = emphasisFromWire(sent.units, liveFocus);
      modeKind = at.mode;
      modeStep = at.mode ? at.step : 0;
    }
    if (announce && modeKind) showModeBanner(modeKind); else hideModeBanner();
    applyModeDimming();
  }
  function enterMode(kind) { setModeState(kind, 0, true); }
  function exitMode() { setModeState(null, 0, false); }
  function toggleMode(kind) { if (modeKind === kind) exitMode(); else enterMode(kind); liveNavigationObserver?.("", false); }
  function syncRevealBtn(kind) {
    const btn = document.getElementById("revealBtn");
    if (!btn) return;
    const on = kind === "reveal";
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
    liveFocus = null;
    modeStep = target;
    applyModeDimming();
    liveNavigationObserver?.("", false);
  }
  function currentViewerPosition() {
    return {
      slideId: slides[index]?.dataset.id || "",
      reveal: activeGallery() ? galleryStep : audienceRevealIndex,
      // While the page shows what the presenter sent, its position is that message's own focus.
      focus: liveFocus ? { kind: liveFocus.kind, step: liveFocus.step } : modeKind ? { kind: modeKind, step: modeStep } : null,
    };
  }
  function applyLiveSlideState(message) {
    const nextIndex = slides.findIndex((slide) => slide.dataset.id === message.slideId);
    if (nextIndex < 0) return false;
    go(nextIndex, { fromLive: true });
    audienceRevealIndex = Math.max(0, Number(message.reveal) || 0);
    galleryStep = audienceRevealIndex;
    applyGallery();
    setModeState(message.focus?.kind || null, message.focus?.step || 0, false, true);
    if (VENUE_MODE) {
      document.getElementById('venueClosing').hidden = true;
      if (message.lightbox?.open) openLightbox(message.lightbox.index);
      else closeLightbox();
      showVenueTalkQr(message.talkQr === true);
      applyVenueMedia(message.focus || null, message.lightbox || null);
    }
    return true;
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
        dot.addEventListener("click", () => { galleryStep = i; applyGallery(); liveNavigationObserver?.("", false); });
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
    scheduleSlideFit();
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
  function initMermaids(root) {
    if (!root || typeof window.mermaid === "undefined") return;
    const hosts = root.querySelectorAll ? root.querySelectorAll(".mermaid-mm:not([data-mmd-done])") : [];
    hosts.forEach((host) => {
      const box = host.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return;
      host.dataset.mmdDone = "1";
      const src = host.getAttribute("data-mmd-src") || "";
      window.mermaid.render("mmd-" + Math.random().toString(36).slice(2), src)
        // Accepted risk N-6: deck output has no DOMPurify; test:mermaid-vendor-security pins Mermaid's strict internal sanitisation at this innerHTML boundary.
        .then((r) => { host.innerHTML = r.svg; })
        .catch((e) => {
          host.innerHTML = "";
          const pre = document.createElement("pre"); pre.textContent = src; host.appendChild(pre);
          const note = document.createElement("div"); note.className = "mmd-error"; note.textContent = String(e && e.message || e);
          host.appendChild(note);
          if (typeof console !== "undefined") console.error("MERMAID-FAIL:", e && e.message);
        });
    });
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
        const inst = mm.Markmap.create(svg, opts, node);
        host.__mmInstance = inst;
        host.__mmFullRoot = node;
        host.dataset.mmDone = "1";
        applyMindmapRevealForSlide(host.closest(".slide"), modeKind, modeStep);
      } catch (e) {
        svg.remove();
        if (typeof console !== "undefined") console.error("MARKMAP-FAIL:", e && e.message);
      }
    });
  }

  // ADR-0005 amend (2026-07-19): reveal a mindmap one top-level branch per step. Mirrors the
  // presenter template runtime (kept in parity by mode-selector-parity / reveal-cross-runtime): the
  // compile-time .mm-step markers are the reveal units the shared machinery counts, and this
  // translates the current step into how many branches markmap renders.
  function pruneMarkmapBranches(fullRoot, showN) {
    const kids = (fullRoot.children || []).slice(0, Math.max(0, showN));
    return Object.assign({}, fullRoot, { children: kids });
  }
  function applyMindmapRevealForSlide(slide, kind, step) {
    if (!slide) return;
    const host = slide.querySelector(".mindmap-mm");
    if (!host || !host.__mmInstance || !host.__mmFullRoot) return;
    const total = (host.__mmFullRoot.children || []).length;
    const showN = kind === "reveal" ? Math.max(0, Math.min(Number(step) || 0, total)) : total;
    if (host.__mmShown === showN) return;
    host.__mmShown = showN;
    try {
      host.__mmInstance.setData(pruneMarkmapBranches(host.__mmFullRoot, showN));
      if (typeof host.__mmInstance.fit === "function") host.__mmInstance.fit();
    } catch (e) { if (typeof console !== "undefined") console.error("MARKMAP-REVEAL-FAIL:", e && e.message); }
  }
  window.addEventListener("resize", () => {
    densifyActiveCards();
    drawSystemLinks(slides[index]);
    initMarkmaps(slides[index]);
    initMermaids(slides[index]);
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
    liveNavigationObserver?.("", false);
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
    // Image-grid cells are zoomables in the presenting runtime (slideImages), after the figures and
    // before the QR codes. The venue screen is sent that runtime's lightbox index, so the list here
    // keeps the same order (0.38 ticket 03: the image sequence steps through grid cells too).
    const cellText = (img, selector) => {
      const cell = img.closest(".ig-cell");
      const node = cell && cell.querySelector(selector);
      return (node && node.textContent || "").trim();
    };
    const gridImages = Array.from(slide.querySelectorAll(".image-grid .ig-media img")).map((img) => ({
      src: img.currentSrc || img.src || img.getAttribute("src") || "",
      alt: img.getAttribute("alt") || "",
      caption: cellText(img, ".ig-note h4") || cellText(img, ".ig-note") || img.getAttribute("alt") || ""
    }));
    return stills.concat(gridImages, qrs).filter((entry) => entry.src);
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
    // The image's place in the slide's zoomables: the venue screen's Pen ink belongs to it (ticket 08).
    lightbox.dataset.index = String(lbIndex);
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
  const myNotesBody = document.getElementById("myNotesBody");
  const notePop = document.getElementById("notePop");
  const notePopText = document.getElementById("notePopText");
  const notePopQuote = document.getElementById("notePopQuote");
  const notePopWords = document.getElementById("notePopWords");
  const notePopSentMark = document.getElementById("notePopSentMark");
  const notePopDone = document.getElementById("notePopDone");
  const notePopSend = document.getElementById("notePopSend");
  const notePopLine = document.getElementById("notePopLine");
  const deckTitleText = document.querySelector('meta[name="deck-title"]')?.content || document.title;
  const NOTES_KEY = "html-presentations:notes:${slug}";
  // The other things this device keeps for the talk, which My Notes lists beside the notes: the reaction
  // marks and bookmarks (audience-reactions.js), the questions Ask sent (audience-my-notes.js) and the
  // poll answers (keyed by live run; audience-my-notes.js).
  const REACTIONS_KEY = "html-presentations:reactions:${slug}";
  const QUESTIONS_KEY = "html-presentations:questions:${slug}";
  let myNotesStorage = null;
  try { myNotesStorage = window.localStorage; } catch {}
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
    // The phone bar shows the slide's note count.
    try { if (audienceFollowController && audienceFollowController.reactions) audienceFollowController.reactions.refresh(); } catch {}
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
    return slide.dataset.navLabel || slide.dataset.navTitle || (heading && heading.textContent.trim()) || slide.dataset.id || "";
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
  let notePopRect = null;
  // What went wrong with a note's send, by note id (this page only; the note itself is always kept).
  const noteSendErrors = new Map();
  function closeNotePop() { notePop.hidden = true; notePopNoteId = null; notePopRect = null; }
  // Send is offered under the same conditions as Ask: live, following, questions on.
  function noteSendState() {
    const rx = audienceFollowController && audienceFollowController.reactions;
    if (!rx || !audienceFollowController.ask || !rx.isVisible()) return "none";
    return rx.questionsAllowed() ? "open" : "paused";
  }
  // Sends made on this page and not yet answered. A send recorded on a note that is not in here was made on an
  // earlier page: its answer arrives if the device's queue still holds it, and if the queue was lost the note
  // is "Not sent" (with Try again), never "Sending…" for good.
  const liveNoteSends = new Set();
  function noteSendPhase(note) {
    if (note.sentAt) return "sent";
    if (noteSendErrors.has(note.id)) return "failed";
    if (!note.sendId) return "compose";
    return liveNoteSends.has(note.sendId) ? "sending" : "failed";
  }
  // What My Notes shows of each note's send that has not landed: { [note id]: { state, retry, reason } }.
  function noteSendStates() {
    const out = {};
    readerNotes.forEach((note) => {
      const phase = noteSendPhase(note);
      if (phase === "sending") out[note.id] = { state: "sending" };
      else if (phase === "failed") {
        const refusal = askRefusal(noteSendErrors.has(note.id) ? noteSendErrors.get(note.id) : "no_answer");
        out[note.id] = { state: "failed", retry: refusal.retry, reason: refusal.text };
      }
    });
    return out;
  }
  // One question for a note through the Ask queue (the popup's Send, the phone sheet's tick and My Notes' Try again).
  // Returns the submission id, false when it could not be kept, or null when questions are not open right now.
  function sendNoteQuestion(note) {
    const words = (note.note || "").trim();
    const phase = noteSendPhase(note);
    if (phase === "sent" || phase === "sending" || !words) return false;
    const ask = audienceFollowController && audienceFollowController.ask;
    if (!ask || noteSendState() !== "open") return null;
    noteSendErrors.delete(note.id);
    const id = note.slideId ? ask.sendNote({ text: noteQuestionText(note.quote, words), slideId: note.slideId, submissionId: note.sendId || "" }) : false;
    if (id === false) noteSendErrors.set(note.id, note.slideId ? ask.refusalReason() : "ended");
    else { note.sendId = id; liveNoteSends.add(id); saveNotes(); }
    return id;
  }
  // The phone's note sheet saved a note (input: { slideId, words, send }).
  function addSlideNote(input) {
    const at = slides.findIndex((slide) => slide.dataset.id === input.slideId);
    if (at < 0) return { sent: false };
    noteCounter += 1;
    const note = { id: "note-" + noteCounter, slideIndex: at, slideId: input.slideId, slideTitle: slideTitleFor(at), type: "slide", note: input.words, createdAt: new Date().toISOString() };
    readerNotes.push(note);
    saveNotes();
    if (!input.send) { renderMyNotes(); return { sent: false }; }
    const id = sendNoteQuestion(note);
    renderMyNotes();
    return { sent: id ? "queued" : "failed" };
  }
  // The popup opens below the highlight when it fits above the page's footer and the reaction bar,
  // otherwise above it: never on the highlight.
  function placeNotePop() {
    const rect = notePopRect || { left: 0, top: 0, bottom: 0, width: 0 };
    const w = notePop.offsetWidth || 352;
    const h = notePop.offsetHeight || 0;
    const x = Math.min(Math.max(8, rect.left + (rect.width || 0) / 2 - w / 2), window.innerWidth - w - 8);
    let limit = window.innerHeight - 8;
    [document.querySelector(".share-footer"), document.getElementById("rxDock")].forEach((bar) => {
      if (!bar || bar.hidden) return;
      const r = bar.getBoundingClientRect();
      if (r.height && r.top < limit && r.right > x && r.left < x + w) limit = r.top - 8;
    });
    const below = (rect.bottom || rect.top || 0) + 10;
    const top = below + h <= limit ? below : (rect.top || 0) - h - 10;
    notePop.style.left = x + "px";
    notePop.style.top = Math.max(8, Math.min(top, limit - h)) + "px";
  }
  function renderNotePop() {
    const note = readerNotes.find((entry) => entry.id === notePopNoteId);
    if (!note) return;
    const phase = noteSendPhase(note);
    const avail = noteSendState();
    const sent = phase === "sent";
    const words = (note.note || "").trim();
    notePopSentMark.hidden = !sent;
    notePop.classList.toggle("is-sent", sent);
    notePopQuote.textContent = note.quote || "";
    notePopText.hidden = sent;
    notePopWords.hidden = !sent || !words;
    notePopWords.textContent = sent ? words : "";
    notePopDone.classList.toggle("primary", sent);
    document.getElementById("notePopDoneIco").style.display = sent ? "none" : "";
    document.getElementById("notePopDoneLabel").textContent = sent ? "Done" : "Save to notes";
    document.getElementById("notePopRemove").hidden = sent;
    const refusal = phase === "failed" ? askRefusal(noteSendErrors.get(note.id)) : null;
    notePopSend.hidden = sent || avail !== "open" || Boolean(refusal && !refusal.retry);
    notePopSend.disabled = phase === "sending" || !words;
    document.getElementById("notePopSendLabel").textContent = phase === "sending" ? "Sending\u2026" : "Send to the speaker as a question";
    let line = "";
    if (sent) line = "About slide " + (note.slideIndex + 1) + (note.slideTitle ? " \u00b7 " + note.slideTitle.replace(/[.?!]+$/, "") : "") + ". Only the speaker sees it. Also in My Notes, marked \u201cSent as a question\u201d.";
    else if (refusal) line = "Not sent. Your note is saved on this device. " + refusal.text;
    else if (phase === "sending") line = "Sending to the speaker\u2026 Your note is saved on this device.";
    else if (avail === "open") line = "Save to notes stays on this device. Sending shows the quote, your words and slide " + (note.slideIndex + 1) + " to the speaker only.";
    else if (avail === "paused") line = "The speaker is not taking questions right now. Your note stays on this device.";
    notePopLine.textContent = line;
    notePopLine.hidden = !line;
    placeNotePop();
  }
  function openNotePop(note, rect) {
    notePopNoteId = note.id;
    notePopRect = { left: rect.left || 0, top: rect.top || 0, bottom: rect.bottom || rect.top || 0, width: rect.width || 0 };
    notePopText.value = note.note || "";
    notePop.hidden = false;
    renderNotePop();
    if (note.sentAt) notePopDone.focus(); else notePopText.focus();
  }
  // Rect for an element or range; getBoundingClientRect is missing on Range in some headless
  // DOMs (jsdom) — fall back to 0,0 rather than dying; clamps keep the popover on-screen.
  function rectFor(target) {
    return typeof target.getBoundingClientRect === "function"
      ? target.getBoundingClientRect()
      : { left: 0, top: 0, bottom: 0, width: 0 };
  }
  function handleSelectionMouseup() {
    // The phone has no highlight popup: its notes are written from the bar's Note button.
    if (isPhone()) return;
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

  // My Notes: one drawer over one read model (audience-my-notes.js). The drawer never asks anything
  // outside this device. The chip it is set to stays until the drawer is closed; on a phone "Open slide"
  // only steps the drawer aside so the slide can be seen.
  function gatherEverything() {
    return gatherMyNotes({
      storage: myNotesStorage,
      keys: { notes: NOTES_KEY, reactions: REACTIONS_KEY, questions: QUESTIONS_KEY },
      slides: slides.map((slide, i) => ({ id: slide.dataset.id || "", title: slideTitleFor(i) })),
      notes: readerNotes,
      sendStates: noteSendStates()
    });
  }
  const myNotesDrawer = createMyNotesDrawer({
    document,
    panel: myNotesPanel,
    isPhone,
    gather: gatherEverything,
    // Try again for a note whose send did not land (refused, or lost with the device's queue).
    onRetryNote: (noteId) => {
      const note = readerNotes.find((entry) => entry.id === noteId);
      if (!note) return;
      if (sendNoteQuestion(note) === null) noteSendErrors.set(note.id, noteSendState() === "paused" ? "questions_paused" : "ended");
      renderMyNotes();
    },
    onOpenSlide: (slideIndex) => openSlideFromMyNotes(slideIndex),
    onJump: (noteId, slideIndex) => {
      openSlideFromMyNotes(slideIndex);
      const mark = document.querySelector('mark.note-mark[data-note-id="' + noteId + '"]');
      if (mark && mark.scrollIntoView) mark.scrollIntoView({ block: "center" });
    },
    onDeleteNote: (noteId) => {
      removeNoteMarks(noteId);
      readerNotes = readerNotes.filter((entry) => entry.id !== noteId);
      saveNotes();
      renderMyNotes();
    },
    onEditNote: (noteId, text) => {
      const note = readerNotes.find((entry) => entry.id === noteId);
      if (note && !note.sentAt) { note.note = text; saveNotes(); }
    },
    // Removing a bookmark or reaction changes this device only: the speaker's counts stay as they were.
    onRemoveMark: (slideId, kind) => {
      removeMyNotesMark({ storage: myNotesStorage, key: REACTIONS_KEY }, slideId, kind);
      if (audienceFollowController && audienceFollowController.reactions) audienceFollowController.reactions.refresh();
      renderMyNotes();
    }
  });
  // The marks in the slide lists (Overview, phone list) and their legend: icons only, from the same read model.
  slideMarks = createSlideMarks({ document, gather: gatherEverything });
  const navLegendHost = document.getElementById("navLegendHost");
  if (navLegendHost) navLegendHost.appendChild(slideMarks.legend());
  function refreshSlideMarks() {
    slideMarks.refresh();
    if (overview.isOpen()) overview.render();
    refreshPhoneListMarks();
  }
  function openSlideFromMyNotes(slideIndex) {
    if (isPhone()) { showPhoneDetail(slideIndex); setMyNotesOpen(false, true); }
    else go(slideIndex);
  }
  function setMyNotesOpen(open, keepChip) {
    myNotesPanel.classList.toggle("open", open);
    if (open) renderMyNotes();
    else if (!keepChip) myNotesDrawer.resetChip();
  }
  function renderMyNotes(focusNoteId) {
    refreshSlideMarks();
    if (!myNotesPanel.classList.contains("open")) return;
    if (focusNoteId) myNotesDrawer.edit(focusNoteId);
    else myNotesDrawer.render();
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

  document.getElementById("myNotesBtn").addEventListener("click", () => setMyNotesOpen(!myNotesPanel.classList.contains("open")));
  document.getElementById("closeMyNotes").addEventListener("click", () => setMyNotesOpen(false));
  document.querySelector(".stage").addEventListener("mouseup", () => setTimeout(handleSelectionMouseup, 0));
  notePopText.addEventListener("input", () => {
    const note = readerNotes.find((entry) => entry.id === notePopNoteId);
    if (!note || note.sentAt) return;
    note.note = notePopText.value;
    saveNotes();
    renderMyNotes();
    renderNotePop();
  });
  // Send to the speaker as a question: one question through the Ask queue, carrying the quote, the words and
  // the slide. The note is kept whatever happens; a second press while one is in flight or after it landed does nothing.
  notePopSend.addEventListener("click", () => {
    const note = readerNotes.find((entry) => entry.id === notePopNoteId);
    if (!note) return;
    sendNoteQuestion(note);
    renderNotePop();
    renderMyNotes();
  });
  notePopText.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); closeNotePop(); }
  });
  notePopDone.addEventListener("click", () => closeNotePop());
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
    if (mark && !isPhone()) {
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
  // Taking it away: the notes page to print or save as PDF (the main action), and Markdown to copy or
  // download. Both are pure functions of the read model (audience-my-notes.js), so every kind is in both.
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
    const text = myNotesMarkdown(gatherEverything(), { title: deckTitleText, date: new Date().toISOString().slice(0, 10) });
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
    downloadFile("${slug}-notes.md", myNotesMarkdown(gatherEverything(), { title: deckTitleText, date: new Date().toISOString().slice(0, 10) }), "text/markdown");
  });
  // The notes page opens in its own tab (text only, the notes with their slide titles, not the slides); the
  // screen bar's button prints it, and "Save as PDF" in the print window keeps a copy.
  document.getElementById("notesPrint").addEventListener("click", (event) => {
    const page = window.open("", "_blank");
    if (!page) { flashButton(event.currentTarget, "Allow pop-ups to print"); return; }
    page.document.open();
    page.document.write(myNotesPrintHtml(gatherEverything(), { title: deckTitleText }));
    page.document.close();
    const go = page.document.getElementById("printNow");
    if (go) go.addEventListener("click", () => page.print());
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
    ${workerBaseUrl && !venue ? '{ keys: ["A"], label: "Ask the speaker a question (live)" },' : ""}
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
  const NEXT_KEYS = ["ArrowRight", "ArrowDown", " ", "Enter", "PageDown"];
  const PREVIOUS_KEYS = ["ArrowLeft", "ArrowUp", "Backspace", "PageUp"];
  const VENUE_DECK_KEYS = NEXT_KEYS.concat(PREVIOUS_KEYS, ["Home", "End", "z", "Z", "f", "F", "r", "R"]);
  const VENUE_READER_KEYS = ["?", "/"];
  window.addEventListener("keydown", (event) => {
    // ADR-0026 (2026-09-28): with no laptop driving it, the venue screen takes the deck's
    // presenting keys — navigation, Z gallery, F focus, R reveal, and each mode's own keys —
    // through the SAME branches below. Reader-only keys (? help, / search, O overview, N notes,
    // Esc panel-close) stay inert: the venue has no reading chrome. Inside the gallery or a mode
    // that mode owns the keyboard (N/P step, Esc exits), but ? and / never open reader surfaces.
    if (VENUE_MODE) {
      if (!venueFollowController?.venueKeyboardAvailable() || event.metaKey || event.ctrlKey || event.altKey) return;
      if (VENUE_READER_KEYS.includes(event.key)) return;
      if (!lbOpen && !modeKind && !VENUE_DECK_KEYS.includes(event.key)) return;
      document.getElementById('venueClosing').hidden = true;
    }
    // The home page follows the speaker: no deck keys move it (Esc still closes My Notes).
    if (HOME_MODE) { if (event.key === "Escape") setMyNotesOpen(false); return; }
    const tag = event.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    // Modifier chords belong to the reader's browser (Cmd+R reload, Cmd+F find), not the deck.
    // Plain Shift stays allowed: "?" needs it.
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // Enter and Space belong to the focused control — a button, link, disclosure or editable box
    // must activate, not advance the deck (Enter on the focused Overview button used to jump a
    // slide AND switch the follow state). Space on a plain target still pages forward.
    if ((event.key === "Enter" || event.key === " ") &&
        (event.target?.closest?.("button, a[href], summary, [role='button']") || event.target?.isContentEditable)) return;
    // Any deck keystroke retires the note popover (it would float over the wrong slide).
    closeNotePop();
    // Help modal is modal: while open it owns the keyboard (Esc / ? close it).
    if (helpOverlay.classList.contains("open")) {
      if (event.key === "Escape" || event.key === "?") { event.preventDefault(); toggleHelp(false); }
      return;
    }
    // G5: while the gallery is open, arrows browse images and Esc / z close it; deck suspended.
    if (lbOpen) {
      if (NEXT_KEYS.includes(event.key)) { event.preventDefault(); stepLightbox(1); }
      else if (PREVIOUS_KEYS.includes(event.key)) { event.preventDefault(); stepLightbox(-1); }
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
      if (NEXT_KEYS.includes(event.key)) { event.preventDefault(); goNext(); return; }
      if (PREVIOUS_KEYS.includes(event.key)) { event.preventDefault(); goPrev(); return; }
      if (event.key === "Home") { event.preventDefault(); go(0); return; }
      if (event.key === "End") { event.preventDefault(); go(slides.length - 1); return; }
      return;
    }
    if (NEXT_KEYS.includes(event.key)) { event.preventDefault(); goNext(); }
    else if (PREVIOUS_KEYS.includes(event.key)) { event.preventDefault(); goPrev(); }
    else if (event.key === "Home") { event.preventDefault(); go(0); }
    else if (event.key === "End") { event.preventDefault(); go(slides.length - 1); }
    else if (event.key === "z" || event.key === "Z") { event.preventDefault(); openLightbox(0); }
    else if (event.key === "o" || event.key === "O") { event.preventDefault(); overview.toggle(); }
    else if (event.key === "n" || event.key === "N") { event.preventDefault(); setMyNotesOpen(!myNotesPanel.classList.contains("open")); }
    else if (event.key === "Escape") { navPanel.classList.remove("open"); notesPanel?.classList.remove("open"); setMyNotesOpen(false); }
  });
  window.addEventListener("hashchange", () => {
    if (HOME_MODE) return;
    const nextIndex = slides.findIndex((slide) => slide.dataset.id === location.hash.slice(1));
    if (nextIndex >= 0) go(nextIndex);
  });
  loadNotes();
  reapplyNoteMarks();
  // Handouts open in complete mode — no authored {data-mode} auto-entry; Reveal is opt-in.
  // Give the chrome buttons their leading icon (skips the speaker-notes button if absent).
  const BTN_ICONS = { prevBtn: ICON.prev, nextBtn: ICON.next, overviewBtn: ICON.overview, revealBtn: ICON.reveal, myNotesBtn: ICON.note, notesBtn: ICON.speaker, printBtn: ICON.print, closeOverview: ICON.close, closeNotes: ICON.close, closeMyNotes: ICON.close, notesCopyMd: ICON.copy, notesDownloadMd: ICON.download, notesPrint: ICON.print };
  Object.keys(BTN_ICONS).forEach((id) => {
    const el = document.getElementById(id);
    if (el && el.querySelector(".btn-label") && !el.querySelector(".btn-ico")) el.insertAdjacentHTML("afterbegin", BTN_ICONS[id]);
  });
  ${homeOn ? `${handoutHomeRuntimeSource()}
  handoutHome = createHandoutHome({
    document,
    slideCount: slides.length,
    titleHtml: (i) => PHONE_TITLE_HTML[i] || "",
    startsAt: ${homeStartsAt === null ? "null" : homeStartsAt},
    openMyNotes: () => setMyNotesOpen(true),
    onShowLive: () => { fitStage(); scheduleSlideFit(); },
    onViewChanged: (view) => { if (view === 'live' && audienceFollowController) audienceFollowController.refreshInstant(); },
    // The stage lives in the Live pane: a page on its slide runs only while that pane shows.
    onStageShown: () => syncLocalShareEmbeds(),
    parts: { stage: document.getElementById("stageFit"), poll: document.getElementById("audiencePollSurface"), board: document.getElementById("bdPanel"), reactions: document.getElementById("rxDock") },
  });` : ""}
  render();
  applyModeDimming();
  applyGallery();
  // ADR-0018: on a phone the handout opens on the slide LIST, unless a deep link named a slide.
  if (HOME_MODE) {
    // The home page has no slide list or deep links: its Live tab shows the slide the speaker is on.
  } else if (!VENUE_MODE) {
    applyPhoneMode();
    if (isPhone() && hadInitialHash) showPhoneDetail();
  } else {
    document.addEventListener('click', () => {
      document.getElementById('venueHint').hidden = true;
      if (!document.fullscreenElement) void document.documentElement.requestFullscreen?.().catch(() => {});
    }, { once: true });
  }
  initialiseLiveFollow();
  initialiseSharedTalk();${preworkOn ? `
  // Pre-work (ticket 09): ask the Worker whether this Run's pre-work is open and mark the page.
  const PREWORK_CONFIG = ${preworkConfig};
  ${preworkStatusRuntimeSource()}
  ${preworkFormRuntimeSource()}
  const preworkStatus = createPreworkStatus({ document, config: PREWORK_CONFIG });
  const preworkForm = createPreworkForm({
    document, mount: document.getElementById("preworkApp"), config: PREWORK_CONFIG,
    client: createPreworkClient({ fetch: window.fetch.bind(window), workerBaseUrl: PREWORK_CONFIG.workerBaseUrl, preworkId: PREWORK_CONFIG.preworkId }),
    storage: { get: (key) => window.localStorage.getItem(key), set: (key, value) => window.localStorage.setItem(key, value) },
    random: (n) => { const bytes = new Uint8Array(n); if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes); else for (let i = 0; i < n; i += 1) bytes[i] = Math.floor(Math.random() * 256); return bytes; },
    fitSlide: fitSlideClone, isPhone,
    deckTitle: (document.querySelector('meta[name="deck-title"]') || {}).content || document.title,
    recheck: () => { void preworkStatus.check(); },
  });
  document.addEventListener("tw:prework-status", (event) => {
    const detail = event.detail || {};
    const status = detail.status;
    preworkForm.setStatus(status, detail.steps);
    // The pre-work form covers the stage while it is open (body.pw-open).
    syncLocalShareEmbeds();
    if (status && status.state === "closed") {
      showPreworkClosed(document, [document.getElementById("preworkClosedTop"), document.getElementById("preworkClosedList")], status);
      document.body.classList.add("pw-closed-page");
    }
  });
  void preworkStatus.check();` : ""}
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
    clone.querySelectorAll("[data-emph-state]").forEach((el) => el.removeAttribute("data-emph-state"));
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
        sectionTitles.set(slide.dataset.section, slide.dataset.navLabel || slide.dataset.navTitle || slide.dataset.section);
      } else if (slide.dataset.role === "subsection-title" && slide.dataset.subsection) {
        subsectionTitles.set(slide.dataset.subsection, slide.dataset.navLabel || slide.dataset.navTitle || slide.dataset.subsection);
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
      const title = slide.dataset.navLabel || slide.dataset.navTitle || (heading && heading.textContent.trim()) || id || "Slide";
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
