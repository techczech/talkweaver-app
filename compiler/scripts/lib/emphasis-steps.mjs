// =============================================================================
// emphasis-steps.mjs — "Emphasis appears on Next" (0.38 ticket 02)
//
// On a slide with {emphasis-steps} every piece of bold, underline, strikethrough and highlight in
// the slide BODY is a step: it starts as plain text and gains its emphasis on Next. The compiler's
// part is to mark those spans; the stepping is the runtimes' (assets/runtime/emphasis-steps.js).
//
// markEmphasisSteps() rewrites one slide's rendered content:
//   <strong> | <u> | <s> | <mark class="ink-marker">   →  the same tag + data-emph-step="<kind>"
//   each word inside a marked <strong>                 →  <span class="es-w" data-w="word">word</span>
// The word spans are what lets bold keep its width before it is on: the bold word is laid out and
// styles/emphasis-steps.css draws `data-w` over it at the weight of the surrounding text. Text
// content is unchanged (no character is added or moved).
//
// Only the four tags exactly as the inline renderer writes them are marked, so a tag the compiler
// builds for structure (it always carries an attribute) is never a step. Italic is not a step.
// Not marked: the slide title (header.slide-head, any h1, the title poster's title) and anything
// inside an element whose content is not slide prose (svg, script, style, template, textarea,
// iframe, math, pre).
// =============================================================================

const TAG = /<!--[\s\S]*?-->|<\/?[A-Za-z](?:"[^"]*"|'[^']*'|[^>"'])*>/g;

const STEP_KIND_BY_TAG = new Map([
  ["<strong>", "bold"],
  ["<u>", "underline"],
  ["<s>", "strike"],
  ['<mark class="ink-marker">', "highlight"]
]);

const OPAQUE_ELEMENTS = new Set(["svg", "script", "style", "template", "textarea", "iframe", "math", "pre", "h1"]);

function opensUnmarkedRegion(name, tag) {
  if (OPAQUE_ELEMENTS.has(name)) return true;
  if (name === "header") return /\bclass="[^"]*\bslide-head\b/.test(tag);
  if (name === "h2") return /\bclass="[^"]*\btp-title\b/.test(tag);
  return false;
}

// One span per unbreakable piece: split at whitespace, and after a hyphen, dash or slash so a long
// compound keeps the places it could break at before.
function wrapBoldWords(text) {
  return text.replace(/\S+/g, (run) => run
    .split(/(?<=[-‐-—/])(?=\S)/)
    .map((piece) => `<span class="es-w" data-w="${piece.replace(/"/g, "&quot;")}">${piece}</span>`)
    .join(""));
}

/**
 * @param {string} html one slide's rendered content (the `.slide-content` block)
 * @returns {{ html: string, count: number }} the marked content and how many spans became steps
 */
export function markEmphasisSteps(html) {
  const source = String(html ?? "");
  let out = "";
  let last = 0;
  let count = 0;
  let opaque = null;        // { name, depth } while inside an unmarked region
  let boldDepth = 0;        // open marked <strong>s
  const strongs = [];       // one entry per open <strong>: was it marked?
  for (const match of source.matchAll(TAG)) {
    const text = source.slice(last, match.index);
    last = match.index + match[0].length;
    out += !opaque && boldDepth > 0 ? wrapBoldWords(text) : text;
    const tag = match[0];
    if (tag.startsWith("<!--")) { out += tag; continue; }
    const closing = tag[1] === "/";
    const name = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(tag)[1].toLowerCase();
    if (opaque) {
      if (name === opaque.name && !tag.endsWith("/>")) {
        opaque.depth += closing ? -1 : 1;
        if (opaque.depth === 0) opaque = null;
      }
      out += tag;
      continue;
    }
    if (!closing && opensUnmarkedRegion(name, tag)) {
      if (!tag.endsWith("/>")) opaque = { name, depth: 1 };
      out += tag;
      continue;
    }
    const kind = closing ? undefined : STEP_KIND_BY_TAG.get(tag);
    if (kind) {
      count += 1;
      out += `${tag.slice(0, -1)} data-emph-step="${kind}">`;
      if (name === "strong") { strongs.push(true); boldDepth += 1; }
      continue;
    }
    if (name === "strong") {
      if (!closing) strongs.push(false);
      else if (strongs.pop()) boldDepth -= 1;
    }
    out += tag;
  }
  out += source.slice(last);
  return { html: out, count };
}

/**
 * Whether the slide's emphasis steps: `{emphasis-steps}` on the slide, unless `{nostep}` is there
 * too (nothing steps on such a slide, so all its emphasis shows at once).
 * @param {Record<string, unknown>|undefined} attrs the slide's trigger attributes
 */
export function resolveEmphasisSteps(attrs) {
  return attrs?.["emphasis-steps"] === true && attrs?.nostep !== true;
}
