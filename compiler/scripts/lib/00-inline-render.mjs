import { escapeHtml } from "./00-html.mjs";
import { replaceMarkSyntax, segmentInlineSource } from "./00-inline-protection.mjs";

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
  if (!escaped.includes("==")) return renderLegacyEscaped(escaped);

  // Code, links and bare URLs stay opaque only to ==mark==. Opaque control tokens isolate the
  // marker pass. The ==-free fast path above is the historical renderer byte-for-byte. On marker
  // lines, whole-line emphasis sees inert placeholders, then protected segments regain their
  // rendered forms without allowing marker matching inside them.
  const protectedSegments = [];
  let tokenPrefix = "\u0001TW";
  while (escaped.includes(tokenPrefix)) tokenPrefix += "TW";
  const marked = segmentInlineSource(escaped).map((segment) => {
    if (segment.kind === "text") {
      return replaceMarkSyntax(segment.source, (inner) => `<mark class="ink-marker">${inner}</mark>`);
    }
    const token = `${tokenPrefix}${protectedSegments.length.toString(36)}\u0002`;
    const rendered = segment.kind === "code"
      ? `<code>${renderLegacyEscaped(segment.content)}</code>`
      : renderLegacyEscaped(segment.source);
    protectedSegments.push({ token, rendered });
    return token;
  }).join("");
  let out = renderLegacyEscaped(marked);
  for (const segment of protectedSegments) {
    out = out.split(segment.token).join(segment.rendered);
  }
  return out;
}
