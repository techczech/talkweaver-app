import { escapeHtml } from "./00-html.mjs";
import { protectInlineSegments, replaceInlineMarks } from "./00-inline-protection.mjs";

// The one rule for which link targets become real hrefs. Every renderer that builds an href
// from outline text (this one, the phone text view in slide-script-render.mjs) calls it; a
// target that fails becomes "#".
export function isSafeLinkUrl(url) {
  return /^(https?|mailto):|^[#./]/i.test(String(url ?? ""));
}

// Bold and italic (`**`/`*`, `__`/`_`) over already-escaped text. Emits only bare <strong>/<em>
// tags around captured text, never an attribute.
export function renderEmphasisEscaped(source) {
  let out = source.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  // Underscore emphasis (__bold__ / _italic_) — common in citations and pasted prose. Matched
  // only at word boundaries so identifiers and URL paths with underscores stay literal.
  out = out.replace(/(^|[^\w`])__(?=\S)([^_]*?\S)__(?!\w)/g, "$1<strong>$2</strong>");
  out = out.replace(/(^|[^\w`])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1<em>$2</em>");
  return out;
}

// A title as plain text, for the places HTML cannot go (the <title> element, meta tags, file names):
// the same inline markers renderInline understands are dropped and their text kept; links keep their
// label. Nothing is escaped here, so the caller escapes for its own context.
export function plainInlineText(text) {
  let out = String(text == null ? "" : text);
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  out = out.replace(/\[([^\]]+)\]\(\s*[^)\s]+(?:\s+"[^"]*")?\s*\)/g, "$1");
  out = out.replace(/`([^`]+)`/g, "$1");
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1");
  out = out.replace(/\*([^*]+)\*/g, "$1");
  out = out.replace(/(^|[^\w`])__(?=\S)([^_]*?\S)__(?!\w)/g, "$1$2");
  out = out.replace(/(^|[^\w`])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1$2");
  out = out.replace(/==([^=]+)==/g, "$1");
  out = replaceInlineMarks(out, (inner) => inner);
  return out.replace(/\s+/g, " ").trim();
}

// Browser-safe extraction of the compiler's inline renderer. Keep compiler and RIVER object
// renderers on this import instead of copying the markdown/escaping grammar into the app.
export function renderInline(text) {
  const renderLegacyEscaped = (source) => {
    let out = renderEmphasisEscaped(source);
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    out = out.replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+&quot;(.*?)&quot;)?\s*\)/g, (_, label, url, title) => {
      const safe = isSafeLinkUrl(url) ? url : "#";
      const titleAttr = title ? ` title="${title}"` : "";
      return `<a href="${safe}"${titleAttr} target="_blank" rel="noopener">${label}</a>`;
    });
    out = out.replace(/(^|[\s(])(https?:\/\/[^\s<]+?)([.,;:)\]]*)(?=\s|$|<)/g,
      (_, lead, url, trail) => `${lead}<a href="${url}" target="_blank" rel="noopener">${url}</a>${trail}`);
    return out;
  };

  const escaped = escapeHtml(text);
  if (!/==|\+\+|~~/.test(escaped)) return renderLegacyEscaped(escaped);

  // Code, links and bare URLs stay opaque to the marks (==highlight==, ~~strike~~, ++underline++).
  // Opaque control tokens isolate the mark pass, so a mark may span a link but never reach into
  // one. The delimiter-free fast path above is the historical renderer byte-for-byte. On marked
  // lines, whole-line emphasis sees inert placeholders, then protected segments regain their
  // rendered forms without allowing mark matching inside them.
  const { masked, restore } = protectInlineSegments(escaped, (segment) =>
    segment.kind === "code"
      ? `<code>${renderLegacyEscaped(segment.content)}</code>`
      : renderLegacyEscaped(segment.source));
  return restore(renderLegacyEscaped(replaceInlineMarks(masked)));
}
