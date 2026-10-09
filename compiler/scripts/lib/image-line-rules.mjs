// =============================================================================
// image-line-rules.mjs — the pure line rules the compiler and the editor share
//
// NO node: imports and nothing that pulls them in: the renderer bundles this file for the
// browser. It holds what "an image line" means (the lexer's image syntax, the video-file rule,
// fence markers, :::notes, HTML comments) so the editor counts exactly the lines the compiler
// turns into image blocks.
// =============================================================================
import { blankHtmlComments } from "./html-comments.mjs";

// Robustly extract a YouTube/Vimeo video id (+ optional start time) from any common URL form.
// Returns null for non-video URLs. Forms covered:
//   YouTube: watch?v=ID, youtu.be/ID, /embed/ID, /v/ID, /shorts/ID (id = 11 url-safe chars).
//   Vimeo:   vimeo.com/ID, vimeo.com/video/ID, player.vimeo.com/video/ID (numeric id).
//   Start time: YouTube t= / start= (accepts "90", "90s", "1m30s", "1h2m3s"); Vimeo #t=… .
export function parseVideoEmbed(rawSrc) {
  const src = String(rawSrc || "").trim();
  if (!src) return null;
  const yt = src.match(/(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([\w-]{11})/i);
  if (yt) {
    const query = src.includes("?") ? src.slice(src.indexOf("?") + 1).split("#")[0] : "";
    const params = new URLSearchParams(query);
    const start = secondsFromTimeToken(params.get("start") || params.get("t") || timeFromHash(src));
    return { kind: "youtube", id: yt[1], start };
  }
  const vimeo = src.match(/(?:player\.)?vimeo\.com\/(?:video\/)?(\d+)/i);
  if (vimeo) {
    const start = secondsFromTimeToken(timeFromHash(src));
    return { kind: "vimeo", id: vimeo[1], start };
  }
  return null;
}

function timeFromHash(src) {
  const h = src.includes("#") ? src.slice(src.indexOf("#") + 1) : "";
  const m = h.match(/(?:^|[&;])t=([^&;]+)/i);
  return m ? m[1] : "";
}

// Parse a YouTube-style time token into integer seconds. Accepts plain seconds ("90", "90s")
// and the "1h2m3s" colon-free form. Returns 0 when nothing parseable is present.
function secondsFromTimeToken(token) {
  const t = String(token || "").trim();
  if (!t) return 0;
  if (/^\d+s?$/.test(t)) return parseInt(t, 10);
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (m && (m[1] || m[2] || m[3])) {
    return (parseInt(m[1] || 0, 10) * 3600) + (parseInt(m[2] || 0, 10) * 60) + parseInt(m[3] || 0, 10);
  }
  return 0;
}

// True when a URL is a YouTube or Vimeo video (any common form). These embed endpoints PLAY
// from file:// (the iframe loads over https; only third-party cookies are limited), so unlike an
// arbitrary site embed they must never be swapped for the offline fallback card.
export function isVideoEmbedUrl(rawSrc) {
  return parseVideoEmbed(rawSrc) !== null;
}

/** Parse one Markdown backtick- or tilde-fence opening and retain its marker character and length. */
export function parseMarkdownFenceOpeningLine(line) {
  const match = String(line ?? '').replace(/\r$/, '').trim().match(/^(`{3,}|~{3,})(.*)$/)
  if (!match) return null
  return {
    marker: match[1],
    info: match[2].trim()
  }
}

/** A closing marker uses the opening marker's character and is at least as long. */
export function isMarkdownFenceClosingLine(line, opening) {
  const match = String(line ?? '').replace(/\r$/, '').trim().match(/^(`{3,}|~{3,})\s*$/)
  return Boolean(
    match
    && opening
    && match[1][0] === opening.marker[0]
    && match[1].length >= opening.marker.length
  )
}

// The lexer's image-syntax line, and the one rule for whether it is an IMAGE (a video file in
// image syntax is a video block). Shared with image-placement.mjs so the editor counts exactly
// the image lines the lexer turns into image blocks.
export const IMAGE_SYNTAX_RE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)\s*((?:\{[^}]*\}\s*)*)$/;
const VIDEO_FILE_RE = /\.(mp4|webm|mov|m4v)$/i;
export function imageSyntaxIsVideo(src) {
  return VIDEO_FILE_RE.test(src.split(/[?#]/)[0]) && !isVideoEmbedUrl(src);
}
// An audio FILE in image syntax is an `audio` block (a speaker chip in the slide's text flow,
// ticket 04 of 0.38): never an image, never a video, so it takes no media slot.
const AUDIO_FILE_RE = /\.(mp3|m4a|wav|ogg)$/i;
export function imageSyntaxIsAudio(src) {
  return AUDIO_FILE_RE.test(src.split(/[?#]/)[0]);
}
/** True when this (trimmed) outline line lexes to an `image` block (not a video, not audio, not prose). */
export function isImageBlockLine(trimmedLine) {
  const m = IMAGE_SYNTAX_RE.exec(trimmedLine);
  return Boolean(m) && !imageSyntaxIsVideo(m[2]) && !imageSyntaxIsAudio(m[2]);
}

/**
 * 1-based indexes (into `lines`) of the lines the compiler turns into image blocks: image syntax
 * that is not a video file, outside `:::notes`, code fences and HTML comments. The editor counts
 * image lines with THIS, so its Nth image line is the compiler's Nth image.
 */
export function audienceImageLineNumbers(lines) {
  const blanked = blankHtmlComments(lines.join("\n")).split("\n");
  const out = [];
  let inNotes = false;
  let fence = null;
  blanked.forEach((line, i) => {
    const t = line.trim();
    if (fence) { if (isMarkdownFenceClosingLine(line, fence)) fence = null; return; }
    if (inNotes) { if (t === ":::") inNotes = false; return; }
    if (t.toLowerCase() === ":::notes") { inNotes = true; return; }
    const opening = parseMarkdownFenceOpeningLine(line);
    if (opening) { fence = opening; return; }
    if (isImageBlockLine(t)) out.push(i + 1);
  });
  return out;
}

