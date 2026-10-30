// Saved views of a live web page (the capture gallery): pictures of the page as it looked while the
// presenter rehearsed or presented it, kept with the talk so the slide still shows the page when the
// site is offline, has changed or refuses to be framed (preview, exports, handouts).
// Design: research/external-url-embed-2026-10-27/design-live-web-page-view-and-capture-gallery-2026-10-27.md
// ("Next feature: capture gallery") and research/live-page-capture-gallery-2026-10-27/.
//
// Storage: one folder per talk, written only by TalkWeaver's capture writer
// (src/main/live-page-capture-core.ts):
//   <talk folder>/assets/live-page-captures/<sha256:16>.jpg          one picture, named by its bytes
//   <talk folder>/assets/live-page-captures/<time>-<capture id>.json one saved view (its record)
// Each saved view is its OWN small file, created once and never rewritten (review 2026-10-27, P1/P2):
// there is no shared list to replace, so no rename can be redirected and no concurrent edit lost. The
// gallery is every valid record in the folder, in name order (the name starts with the capture time).
//
// Limits are the same for the writer and every reader (review 2026-10-27, P2 size): a record above
// MAX_CAPTURE_ENTRY_BYTES or out of shape is not part of the gallery, and the writer never writes one;
// readers take at most MAX_CAPTURES_TOTAL records (and MAX_CAPTURES_PER_PAGE per page) in name order,
// and the writer refuses a capture past either count. Several TalkWeaver writers at once can each pass
// the count and exceed it by the captures in flight; readers still show the first ones, in order.
//
// Every picture path in a record must be exactly `assets/live-page-captures/<16 hex>.jpg`: no path from a
// web page, a URL or the record's own text is ever opened as written. Keyed by the page's address as
// written on the slide (normalised), not by the slide. The outline is never touched.
//
// What is public (shown in a compiled deck, export or handout): the picture and the capture date, under
// the slide's own address (already on the slide). The address the page had reached, its scroll
// position and viewport stay in the record only (PUBLIC_CAPTURE_FIELDS).

export const LIVE_PAGE_CAPTURES_DIR = "assets/live-page-captures";
export const LIVE_PAGE_CAPTURES_VERSION = 1;
/** At most this many saved views per page. */
export const MAX_CAPTURES_PER_PAGE = 60;
/** At most this many saved views per talk (all pages). */
export const MAX_CAPTURES_TOTAL = 600;
/** One saved view's record, as stored; larger files are not records. */
export const MAX_CAPTURE_ENTRY_BYTES = 4096;
/** One picture's limit, as stored. */
export const MAX_CAPTURE_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_CAPTURE_URL_LENGTH = 2048;
/** The fields of a capture that a compiled deck, export or handout shows. */
export const PUBLIC_CAPTURE_FIELDS = Object.freeze(["image", "capturedAt", "mode"]);
/** The tallest picture kept, in stored pixels: an Entire page capture is cut there (and says so). */
export const MAX_CAPTURE_HEIGHT = 16384;
/** The widest picture kept, in stored pixels (wider views are scaled down). */
export const MAX_CAPTURE_WIDTH = 1920;

const IMAGE_NAME = /^[0-9a-f]{16}\.jpg$/;
const IMAGE_PATH = /^assets\/live-page-captures\/[0-9a-f]{16}\.jpg$/;
const ENTRY_NAME = /^(\d{8}T\d{9}Z)-(cap-[0-9a-f]{12})\.json$/;
const CAPTURE_ID = /^cap-[0-9a-f]{12}$/;
const SLIDE_ID = /^[A-Za-z0-9._:-]{0,128}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The picture's file name (in the folder) for its bytes' sha256 (hex). */
export function captureImageName(sha256Hex) {
  const hex = String(sha256Hex || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("capture-image-hash");
  return `${hex.slice(0, 16)}.jpg`;
}
/** The picture's path below the talk folder, as a record names it. */
export function captureImagePath(sha256Hex) {
  return `${LIVE_PAGE_CAPTURES_DIR}/${captureImageName(sha256Hex)}`;
}
export function isCaptureImageName(value) {
  return typeof value === "string" && IMAGE_NAME.test(value);
}
export function isCaptureImagePath(value) {
  return typeof value === "string" && IMAGE_PATH.test(value);
}
/** A saved view's record file name: capture time (sortable) and id. */
export function captureEntryName(capture) {
  const t = String(capture && capture.capturedAt || "");
  if (!ISO_TIME.test(t) || !CAPTURE_ID.test(String(capture && capture.id || ""))) throw new Error("capture-invalid");
  return `${t.replace(/[-:.]/g, "")}-${capture.id}.json`;
}
export function isCaptureEntryName(value) {
  return typeof value === "string" && ENTRY_NAME.test(value);
}

/** An http(s) address as the gallery keys it (URL.href), or null. No user name or password. */
export function normaliseCaptureUrl(raw) {
  if (typeof raw !== "string" || !raw || raw.length > MAX_CAPTURE_URL_LENGTH) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || !url.hostname) return null;
  return url.href.length > MAX_CAPTURE_URL_LENGTH ? null : url.href;
}

const finite = (v, min, max) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const plainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** One capture, checked and copied field by field (nothing unknown survives), or null. */
export function validateCapture(raw) {
  if (!plainObject(raw)) return null;
  const { id, image, capturedAt, currentUrl, slideId, width, height, bytes, viewport, scroll, source, mode, truncated, slideMarkup } = raw;
  if (typeof id !== "string" || !CAPTURE_ID.test(id)) return null;
  if (!isCaptureImagePath(image)) return null;
  if (typeof capturedAt !== "string" || !ISO_TIME.test(capturedAt) || Number.isNaN(Date.parse(capturedAt))) return null;
  if (!finite(width, 1, MAX_CAPTURE_WIDTH) || !finite(height, 1, MAX_CAPTURE_HEIGHT) || !Number.isInteger(width) || !Number.isInteger(height)) return null;
  // What was captured: the visible view (the default; records before 2026-10-27 have no mode) or the
  // entire scrollable page as far as it had loaded, `truncated` when the page was taller than kept.
  if (mode !== undefined && mode !== "view" && mode !== "page") return null;
  if (truncated !== undefined && truncated !== true) return null;
  // Made to be listed by the slide's {capture} lines (2026-10-27, live-page-capture-markup.mjs): once a
  // page has one such record, its gallery is its lines only, so deleting the last line leaves none.
  if (slideMarkup !== undefined && slideMarkup !== true) return null;
  if (!finite(bytes, 1, MAX_CAPTURE_IMAGE_BYTES) || !Number.isInteger(bytes)) return null;
  if (typeof slideId !== "string" || !SLIDE_ID.test(slideId)) return null;
  if (source !== "audience" && source !== "presenter" && source !== "window") return null;
  const current = currentUrl == null ? null : normaliseCaptureUrl(currentUrl);
  if (currentUrl != null && !current) return null;
  if (!plainObject(viewport) || !finite(viewport.w, 1, 16384) || !finite(viewport.h, 1, 65536) || !finite(viewport.zoom, 0.05, 10)) return null;
  if (!plainObject(scroll) || !finite(scroll.fx, 0, 1) || !finite(scroll.fy, 0, 1)) return null;
  return {
    id, image, capturedAt, ...(current ? { currentUrl: current } : {}), slideId, width, height, bytes, source,
    ...(mode === "page" ? { mode } : {}), ...(mode === "page" && truncated === true ? { truncated: true } : {}),
    ...(slideMarkup === true ? { slideMarkup: true } : {}),
    viewport: { w: viewport.w, h: viewport.h, zoom: viewport.zoom },
    scroll: { fx: scroll.fx, fy: scroll.fy }
  };
}

/**
 * A saved view's record as stored: checked, within MAX_CAPTURE_ENTRY_BYTES. Throws `capture-invalid`
 * or `capture-too-large`; what it returns is exactly what a reader accepts.
 */
export function encodeCaptureEntry(pageUrl, capture) {
  const key = normaliseCaptureUrl(pageUrl);
  const entry = validateCapture(capture);
  if (!key || !entry) throw new Error("capture-invalid");
  const text = `${JSON.stringify({ v: LIVE_PAGE_CAPTURES_VERSION, pageUrl: key, capture: entry })}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_CAPTURE_ENTRY_BYTES) throw new Error("capture-too-large");
  if (!parseCaptureEntry(text, captureEntryName(entry))) throw new Error("capture-invalid");
  return text;
}

/** A record file's text, checked against its own name; null for anything that is not a saved view. */
export function parseCaptureEntry(text, name) {
  const m = typeof name === "string" ? ENTRY_NAME.exec(name) : null;
  if (!m || typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_CAPTURE_ENTRY_BYTES) return null;
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!plainObject(raw) || raw.v !== LIVE_PAGE_CAPTURES_VERSION || Object.keys(raw).sort().join(",") !== "capture,pageUrl,v") return null;
  const pageUrl = normaliseCaptureUrl(raw.pageUrl);
  const capture = validateCapture(raw.capture);
  if (!pageUrl || pageUrl !== raw.pageUrl || !capture) return null;
  if (captureEntryName(capture) !== name) return null;
  return { pageUrl, capture };
}

/**
 * The gallery from parsed records (any order): name order, at most MAX_CAPTURES_TOTAL in all and
 * MAX_CAPTURES_PER_PAGE per page. `{ pages: { <url>: [capture, …] }, total }`.
 */
export function galleryFromEntries(entries) {
  const sorted = [...entries].filter(Boolean).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const pages = {};
  let total = 0;
  const seen = new Set();
  for (const e of sorted) {
    if (total >= MAX_CAPTURES_TOTAL) break;
    if (seen.has(e.capture.id)) continue;
    const list = pages[e.pageUrl] ?? (pages[e.pageUrl] = []);
    if (list.length >= MAX_CAPTURES_PER_PAGE) continue;
    list.push(e.capture);
    seen.add(e.capture.id);
    total++;
  }
  return { pages, total };
}

/**
 * The views an embed with no marker and no {capture} line shows (live-page-capture-markup.mjs;
 * compatibility with views saved before the markup): the page's records made before it (no
 * `slideMarkup`), in order. A record made for the markup never shows this way, only through its line.
 * Which embeds are in the markup is said by the outline, never by a record (review 2026-10-27, P2).
 */
export function earlierCapturesFor(gallery, pageUrl) {
  const key = normaliseCaptureUrl(pageUrl);
  if (!key || !gallery) return [];
  return publicCapturesFor({ pages: { [key]: (gallery.pages?.[key] ?? []).filter((c) => c.slideMarkup !== true) } }, key);
}

/** The public view of a page's gallery: picture path and capture date only, in order. */
export function publicCapturesFor(gallery, pageUrl) {
  const key = normaliseCaptureUrl(pageUrl);
  const list = key && gallery && gallery.pages ? gallery.pages[key] : null;
  if (!list) return [];
  return list.map((c) => ({ image: c.image, capturedAt: c.capturedAt, ...(c.mode === "page" ? { mode: "page" } : {}) }));
}
