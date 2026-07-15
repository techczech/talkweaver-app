import { escapeHtml } from "./01-cli-utils.mjs";

// =============================================================================
// 4. HTML extraction — extractStyles / extractSlides over self-generated HTML (strip <script> first — see handout regression)
// =============================================================================

function stripTags(value) {
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstMatch(value, pattern) {
  const match = value.match(pattern);
  return match ? match[1].trim() : "";
}

export function extractTitle(html, fallback) {
  const metaTitle = firstMatch(html, /<meta\s+name=["']deck-title["']\s+content=["']([^"']+)["'][^>]*>/i);
  if (metaTitle) return metaTitle;
  const title = firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  return stripTags(title || fallback);
}

export function extractStyles(html) {
  // Only REAL stylesheets. A <style> can also appear as TEXT inside a <script> — notably the
  // presenter-preview iframe's srcdoc, which carries `.slide { display: grid !important }` to force
  // its single cloned slide visible. Harvesting that into the share export overrode `.slide {
  // display:none }` and made EVERY slide show at once. Strip scripts first, then collect styles.
  const noScripts = String(html).replace(/<script\b[\s\S]*?<\/script>/gi, "");
  return [...noScripts.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((match) => match[1])
    .join("\n");
}

// Find every top-level `<section class="slide">…</section>` span in `html`, NESTING-AWARE.
// Layouts may nest <section> elements inside a slide (the 5+-pair contrast layout's
// <section class="cpanel"> panels); a lazy `[\s\S]*?<\/section>` match cut those slides at the
// first INNER close, leaving the slide's tags unclosed — the browser then swallowed every later
// slide inside the broken one and the share export went blank past that point (oa8c handout
// regression, 2026-06-11). Walk <section>/</section> tokens and close each slide at depth 0.
export function findSlideSections(html) {
  const source = String(html);
  const spans = [];
  const opener = /<section\b[^>]*class=["'][^"']*\bslide\b[^"']*["'][^>]*>/gi;
  let match;
  while ((match = opener.exec(source))) {
    const token = /<section\b|<\/section>/gi;
    token.lastIndex = opener.lastIndex;
    let depth = 1;
    let end = -1;
    let found;
    while (depth > 0 && (found = token.exec(source))) {
      depth += found[0] === "</section>" ? -1 : 1;
      if (depth === 0) end = token.lastIndex;
    }
    if (end === -1) break; // unclosed slide: drop the tail rather than emit a broken span
    spans.push({ index: match.index, end, html: source.slice(match.index, end) });
    opener.lastIndex = end;
  }
  return spans;
}

export function extractSlides(html) {
  return findSlideSections(html)
    .map((match, index) => {
      const sectionHtml = match.html;
      const id = firstMatch(sectionHtml, /\bdata-id=["']([^"']+)["']/i) || `slide-${index + 1}`;
      const navTitle = firstMatch(sectionHtml, /\bdata-nav-title=["']([^"']+)["']/i);
      const section = firstMatch(sectionHtml, /\bdata-section=["']([^"']+)["']/i);
      const subsection = firstMatch(sectionHtml, /\bdata-subsection=["']([^"']+)["']/i);
      const role = firstMatch(sectionHtml, /\bdata-role=["']([^"']+)["']/i) || "content";
      const preparesFor = firstMatch(sectionHtml, /\bdata-prepares-for=["']([^"']+)["']/i);
      const heading = stripTags(firstMatch(sectionHtml, /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i));
      const notes = firstMatch(sectionHtml, /<aside\b[^>]*class=["'][^"']*\bnotes\b[^"']*["'][^>]*>([\s\S]*?)<\/aside>/i);
      const visualHtml = sectionHtml.replace(/<aside\b[^>]*class=["'][^"']*\bnotes\b[^"']*["'][^>]*>[\s\S]*?<\/aside>/gi, "");
      return {
        id,
        title: navTitle || heading || id,
        section,
        subsection,
        role,
        preparesFor,
        html: visualHtml,
        notes,
      };
    });
}

export function updateDeckTitle(html, title) {
  const titleText = escapeHtml(title);
  let nextHtml = html.replace(/<title[^>]*>[\s\S]*?<\/title>/i, `<title>${titleText}</title>`);
  if (/<meta\s+name=["']deck-title["'][^>]*>/i.test(nextHtml)) {
    nextHtml = nextHtml.replace(/<meta\s+name=["']deck-title["'][^>]*>/i, `<meta name="deck-title" content="${titleText}">`);
  } else {
    nextHtml = nextHtml.replace(/<head[^>]*>/i, (match) => `${match}\n<meta name="deck-title" content="${titleText}">`);
  }
  return nextHtml;
}

export function withoutScripts(value) {
  return String(value).replace(/<script[\s\S]*?<\/script>/gi, "");
}

