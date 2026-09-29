// ADR-0028 §10 (and its 2026-09-28 amendment): a statement or a painted slide title never ends on
// one word alone. CSS `text-wrap: pretty` / `balance` is the first layer (Chromium); this is the
// second, which works in every browser a handout or export opens in: when the compiler writes a
// statement paragraph or a title it joins the LAST TWO WORDS with a no-break space, provided the
// two words together are at most 20 characters (so two long words never become one unbreakable
// run that could overflow the measure) and neither holds a break opportunity of its own (a hyphen,
// dash or slash).
//
// Invariants:
//   - The outline is never changed; only the compiled HTML carries the no-break space.
//   - Never inside code, links or authoring tokens: when either word sits (even partly) inside
//     <code>/<a>/<kbd>/… or contains a brace, the paragraph is left exactly as it was.
//   - Inline formatting (<strong>, <em>, <mark>, <span>) is transparent; any other tag between or
//     inside the two words (a <br>, an image, a closing block) means "not two words on one line"
//     and the paragraph is left alone.
//
// Text copied or searched from the slide carries U+00A0 where the outline has a space; anything
// that matches slide text against the outline must treat the two as equal.

const MAX_PAIR_CHARS = 20;
const BREAKS_INSIDE = /^(?:-|\u2010|\u2013|\u2014|\/|&ndash;|&mdash;|&#8211;|&#8212;)$/;
const NBSP = "&nbsp;";
// Elements whose text is never touched: the words inside them are code, a link or markup.
const PROTECTED = new Set(["a", "code", "kbd", "pre", "samp", "script", "style", "svg", "math", "var", "textarea"]);
// Inline elements a word may run through.
const TRANSPARENT = new Set(["strong", "b", "em", "i", "mark", "span", "u", "s", "small", "sub", "sup", "abbr", "cite", "q", "del", "ins"]);
const VOID = new Set(["br", "img", "hr", "input", "wbr", "source", "track", "embed", "col", "area", "base", "link", "meta", "param"]);

const tagName = (tag) => (tag.match(/^<\/?\s*([a-zA-Z][\w-]*)/)?.[1] ?? "").toLowerCase();
const isSpace = (unit) => unit === " " || unit === "\t" || unit === "\n" || unit === "\r";
const isBreakFree = (unit) => unit === "&nbsp;" || unit === "&#160;" || unit === "&#xa0;" || unit === " ";

/** Join the last two words of ONE paragraph's inner HTML; returns it unchanged when it must not. */
export function keepLastTwoWordsTogether(innerHtml) {
  const html = String(innerHtml ?? "");
  // Units: one per character (an entity counts as one), or one per tag.
  const units = [];
  let protectedDepth = 0;
  for (const piece of html.split(/(<[^>]*>)/)) {
    if (!piece) continue;
    if (piece.startsWith("<")) {
      const name = tagName(piece);
      const closing = /^<\//.test(piece);
      const selfClosing = /\/>$/.test(piece) || VOID.has(name);
      if (PROTECTED.has(name) && !selfClosing) protectedDepth = Math.max(0, protectedDepth + (closing ? -1 : 1));
      units.push({ tag: true, name, text: piece, protected: protectedDepth > 0 || PROTECTED.has(name) });
      continue;
    }
    for (const match of piece.matchAll(/&#?[a-zA-Z0-9]+;|[\s\S]/g)) {
      units.push({ tag: false, text: match[0], protected: protectedDepth > 0 });
    }
  }
  let i = units.length - 1;
  const skipTransparentTags = () => { while (i >= 0 && units[i].tag && TRANSPARENT.has(units[i].name)) i--; };
  // Trailing whitespace and closing inline tags.
  while (i >= 0 && (units[i].tag ? TRANSPARENT.has(units[i].name) : isSpace(units[i].text))) i--;
  const readWord = () => {
    const word = [];
    while (i >= 0) {
      const unit = units[i];
      if (unit.tag) {
        if (!TRANSPARENT.has(unit.name)) return null;
        i--;
        continue;
      }
      if (isSpace(unit.text)) break;
      if (isBreakFree(unit.text)) return null; // already joined by the author or a previous pass
      word.unshift(unit);
      i--;
    }
    return word;
  };
  const last = readWord();
  if (!last || !last.length) return html;
  // The separator: one whitespace run, in plain (unprotected) text, with no tag inside it.
  const sepEnd = i;
  while (i >= 0 && !units[i].tag && isSpace(units[i].text)) i--;
  const sepStart = i + 1;
  if (sepStart > sepEnd) return html;
  skipTransparentTags();
  const prev = readWord();
  if (!prev || !prev.length) return html;
  const words = [...prev, ...last];
  if (words.some((unit) => unit.protected || unit.text === "{" || unit.text === "}")) return html;
  // A hyphen, dash or slash inside the pair is a break opportunity of its own: joining would only
  // move the break there and leave a fragment alone on the line above ("multi-" / "point, stepped"),
  // which is worse than the lone last word (Layout Doctor: an internal one-word line is a defect).
  if (words.some((unit) => BREAKS_INSIDE.test(unit.text))) return html;
  for (let k = sepStart; k <= sepEnd; k++) if (units[k].protected) return html;
  if (prev.length + last.length > MAX_PAIR_CHARS) return html;
  // Exactly three words cannot wrap without one of them alone on a line: joining the last two
  // would only move the lone word to the first line ("About" / "this showcase"), which the Layout
  // Doctor counts as the worse defect (an internal one-word line). Leave those as authored.
  const plain = units.filter((unit) => !unit.tag).map((unit) => (isSpace(unit.text) ? " " : "x")).join("");
  if (plain.trim().split(/ +/).length === 3) return html;
  return [
    ...units.slice(0, sepStart).map((unit) => unit.text),
    NBSP,
    ...units.slice(sepEnd + 1).map((unit) => unit.text)
  ].join("");
}

/**
 * Apply the guard to every TOP-LEVEL paragraph of a statement slide's body HTML (not the kicker
 * or the source line, and never a paragraph nested inside another element such as a poll frame).
 */
export function keepStatementLastWordsTogether(bodyHtml) {
  const html = String(bodyHtml ?? "");
  let depth = 0;
  let out = "";
  let cursor = 0;
  const tagRe = /<\/?\s*([a-zA-Z][\w-]*)[^>]*>/g;
  let match;
  while ((match = tagRe.exec(html))) {
    const tag = match[0];
    const name = match[1].toLowerCase();
    const closing = tag.startsWith("</");
    if (VOID.has(name) || tag.endsWith("/>")) continue;
    if (!closing && name === "p" && depth === 0 && !/\bclass="[^"]*\b(?:kicker|slide-source)\b/.test(tag)) {
      const end = html.indexOf("</p>", tagRe.lastIndex);
      if (end < 0) break;
      const inner = html.slice(tagRe.lastIndex, end);
      out += html.slice(cursor, tagRe.lastIndex) + keepLastTwoWordsTogether(inner) + "</p>";
      cursor = end + 4;
      tagRe.lastIndex = cursor;
      continue;
    }
    depth = Math.max(0, depth + (closing ? -1 : 1));
  }
  return out + html.slice(cursor);
}
