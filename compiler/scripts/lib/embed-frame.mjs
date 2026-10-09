// =============================================================================
// embed-frame.mjs — embedded pages run in a sandbox (0.38 ticket 11.1)
//
// The compile side of docs/plans/presenting-features-0.38/embed-sandbox-design.md: the sandbox
// token lists as named constants (sections 2.1 and 2.4), the attributes of an embed frame, and the
// lead the compiler puts at the top of an inlined local page (2.1): policy, referrer, base, agent.
//
// Used by 06-block-renderers (the figure of a local page) and 08-source-adapters (the lead and the
// page's own title). Remote sites and videos keep their markup until ticket 11.4.
// =============================================================================
import { escapeHtml } from "./00-html.mjs";
import { embedAgentSource } from "../../assets/runtime/embed-agent.js";

/** A local page (`[Embed:]` / `[Simulation:]` HTML file). Its origin is opaque: `allow-same-origin`
 *  is never in this list (design 2.1; test matrix row 1). */
export const EMBED_SANDBOX_LOCAL = Object.freeze(["allow-scripts", "allow-forms"]);

/** A remote site or a video player. `allow-same-origin` gives the site ITS OWN origin, not the
 *  deck's (design 2.4). The two pop-up tokens of 2.4 are left out, as decided for 11.4 after the
 *  security review of 11.3 (design section 11.4, "Pop-ups"). */
export const EMBED_SANDBOX_REMOTE = Object.freeze(["allow-scripts", "allow-same-origin", "allow-forms", "allow-presentation"]);

/** The `allow=` (permissions policy) value per kind (design 2.1, 2.4). */
export const EMBED_ALLOW_LOCAL = "autoplay; fullscreen";
export const EMBED_ALLOW_REMOTE = "autoplay; encrypted-media; picture-in-picture; fullscreen";

export const EMBED_REFERRER_META = '<meta name="referrer" content="no-referrer">';
/** Makes `#anchor` links same-document navigations inside a sandboxed srcdoc frame (design 2.3). */
export const EMBED_BASE_TAG = '<base href="about:srcdoc">';

// The local list is checked where it is defined: a later edit that adds the token that would give
// an embedded page the deck's origin fails at import, in the compiler and in every test.
if (EMBED_SANDBOX_LOCAL.includes("allow-same-origin") || EMBED_SANDBOX_LOCAL.join(" ") !== "allow-scripts allow-forms") {
  throw new Error("embed-frame: the local-page sandbox must be exactly allow-scripts allow-forms");
}

/** The value of the `sandbox` attribute for a kind: "local", or "remote" (sites and videos). */
export function embedSandboxValue(kind) {
  if (kind === "local") return EMBED_SANDBOX_LOCAL.join(" ");
  if (kind === "remote") return EMBED_SANDBOX_REMOTE.join(" ");
  throw new Error(`embed-frame: unknown embed kind ${JSON.stringify(kind)}`);
}

/** The sandbox and permission attributes of an embed frame, as markup text with a leading space.
 *  A frame carries its sandbox in the compiled markup, so it is never loaded without one. */
export function embedFrameAttributes(kind) {
  if (kind === "local") {
    return ` sandbox="${embedSandboxValue("local")}" credentialless referrerpolicy="no-referrer" allow="${EMBED_ALLOW_LOCAL}" allowfullscreen scrolling="no"`;
  }
  return ` sandbox="${embedSandboxValue(kind)}" allow="${EMBED_ALLOW_REMOTE}" allowfullscreen`;
}

/**
 * The lead of an inlined local page, in the design's order: the page policy `<meta>`, the referrer
 * `<meta>`, `<base href="about:srcdoc">` unless the page has a `<base>` of its own, and the agent.
 *
 * @param {string} policyMeta the ticket-10 policy element (EMBED_PAGE_POLICY_META)
 * @param {{ ownBase?: boolean }} [page]
 */
export function embedDocumentLead(policyMeta, page = {}) {
  const agent = embedAgentSource();
  // The agent is written into a <script> element as it is; neither sequence may occur in it.
  if (/<\/script/i.test(agent) || agent.includes("<!--")) throw new Error("embed-frame: the agent source cannot be inlined");
  return `${policyMeta}${EMBED_REFERRER_META}${page.ownBase ? "" : EMBED_BASE_TAG}<script>${agent}</script>`;
}

// ── Reading a page's text the way the HTML parser will ──────────────────────────────────────────
// Two decisions depend on what the page's markup IS, not on what its text mentions: where the lead
// goes, and whether the page has a <base> of its own. Both use this small scan, which knows
// comments, the doctype, start tags with their attributes, and the elements whose content is not
// markup. It is not a parser: it answers these questions and nothing else.

const HTML_SPACE = "\t\n\f\r ";
// Elements whose content the parser does not read as HTML markup: raw text and escapable raw text
// (with scripting on, which a sandboxed page has), an inert <template>, and foreign content, where
// a <base> or a <title> is an SVG or MathML element of that name and not the HTML one.
const NOT_MARKUP_INSIDE = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript", "template", "svg", "math"]);

/** The index just past the comment that starts at `at` ("<!--"), as the tokenizer ends it:
 *  "<!-->" and "<!--->" are complete comments; otherwise the first "-->" or "--!>"; else the end.
 *  One forward search for either terminator, so it reads no further than the comment's own end: two
 *  separate searches read to the end of the document for whichever terminator the page never uses,
 *  once per comment, and a page with thousands of comments then took seconds to scan. */
function commentEnd(text, at) {
  const from = at + 4;
  if (text.startsWith(">", from)) return from + 1;
  if (text.startsWith("->", from)) return from + 2;
  const terminator = /--!?>/g;
  terminator.lastIndex = from;
  return terminator.test(text) ? terminator.lastIndex : text.length;
}

/** The index just past the bogus comment that starts at `at` ("<?…", or "<!…" that is neither a
 *  comment nor a doctype): the tokenizer ends it at the first ">"; else the end. */
function bogusCommentEnd(text, at) {
  const gt = text.indexOf(">", at);
  return gt < 0 ? text.length : gt + 1;
}

/**
 * Visit each HTML start tag of a document's text, in order: `visit({ name, attributes, contentStart,
 * contentEnd })` with the tag name in lower case, its attribute names (lower case) mapped to their
 * raw values, and, for an element whose content is not markup, where that content starts and ends.
 * Comments, the doctype, end tags and the content of those elements are skipped. A visitor that
 * returns true stops the scan.
 */
function scanStartTags(html, visit) {
  const text = String(html ?? "");
  const lower = text.toLowerCase();
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) return;
    if (text.startsWith("<!--", lt)) { i = commentEnd(text, lt); continue; }
    const next = text[lt + 1] ?? "";
    if (next === "!" || next === "?" || next === "/") {
      // A doctype, a bogus comment, an end tag: to the next ">".
      i = bogusCommentEnd(text, lt);
      continue;
    }
    if (!/[a-zA-Z]/.test(next)) { i = lt + 1; continue; }
    let j = lt + 1;
    while (j < text.length && !HTML_SPACE.includes(text[j]) && text[j] !== "/" && text[j] !== ">") j += 1;
    const name = lower.slice(lt + 1, j);
    const attributes = new Map();
    for (;;) {
      while (j < text.length && (HTML_SPACE.includes(text[j]) || text[j] === "/")) j += 1;
      if (j >= text.length) break;
      if (text[j] === ">") { j += 1; break; }
      const nameStart = j;
      if (text[j] === "=") j += 1; // a leading "=" belongs to the name
      while (j < text.length && !HTML_SPACE.includes(text[j]) && text[j] !== "/" && text[j] !== ">" && text[j] !== "=") j += 1;
      const attribute = lower.slice(nameStart, j);
      let value = "";
      while (j < text.length && HTML_SPACE.includes(text[j])) j += 1;
      if (text[j] === "=") {
        j += 1;
        while (j < text.length && HTML_SPACE.includes(text[j])) j += 1;
        if (text[j] === '"' || text[j] === "'") {
          const close = text.indexOf(text[j], j + 1);
          value = text.slice(j + 1, close < 0 ? text.length : close);
          j = close < 0 ? text.length : close + 1;
        } else {
          const valueStart = j;
          while (j < text.length && !HTML_SPACE.includes(text[j]) && text[j] !== ">") j += 1;
          value = text.slice(valueStart, j);
        }
      }
      if (attribute && !attributes.has(attribute)) attributes.set(attribute, value); // the first one counts
    }
    if (name === "plaintext") { visit({ name, attributes, contentStart: j, contentEnd: text.length }); return; }
    if (NOT_MARKUP_INSIDE.has(name)) {
      const close = lower.indexOf(`</${name}`, j);
      const contentEnd = close < 0 ? text.length : close;
      if (visit({ name, attributes, contentStart: j, contentEnd }) === true) return;
      i = close < 0 ? text.length : close + 2;
      continue;
    }
    if (visit({ name, attributes, contentStart: -1, contentEnd: -1 }) === true) return;
    i = j;
  }
}

/**
 * Whether the page sets a base URL of its own: a real `<base>` element with an `href` attribute.
 * A `<base` that is only mentioned (in a comment, a script, a string, a style, a textarea, a
 * template) is not one, and neither is a `<base>` with no `href` (it sets a target, not an address).
 */
export function embedHasOwnBase(html) {
  let found = false;
  scanStartTags(html, (tag) => {
    if (tag.name === "base" && tag.attributes.has("href")) { found = true; return true; }
    return false;
  });
  return found;
}

/**
 * Where the lead goes: directly after the doctype when the document starts with one, counting a
 * byte-order mark, white space and COMMENTS before it as the parser does (a comment before the
 * doctype is legal and leaves the page in standards mode; putting the lead before that doctype
 * would put the page in quirks mode). A comment here is what the parser makes a comment of before
 * the doctype: "<!-- … -->", and the bogus comments, which end at the first ">": a processing
 * instruction ("<?xml version="1.0"?>") and a "<!…>" declaration that is not a doctype. Otherwise
 * the very start. Either way nothing the page's author wrote that can run, load or set a policy
 * comes before the lead: only inert comments can.
 */
export function embedLeadPosition(html) {
  const text = String(html);
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    while (i < text.length && HTML_SPACE.includes(text[i])) i += 1;
    if (text.startsWith("<!--", i)) { i = commentEnd(text, i); continue; }
    const bogus = text.startsWith("<?", i) || (text.startsWith("<!", i) && text.slice(i + 2, i + 9).toLowerCase() !== "doctype");
    if (!bogus) break;
    i = bogusCommentEnd(text, i);
  }
  const doctype = /^<!doctype[^>]*>/i.exec(text.slice(i, i + 4096));
  return doctype ? i + doctype[0].length : 0;
}

/**
 * A local page's text with the lead in place (see embedLeadPosition), so nothing the page's author
 * writes comes before the policy or the agent. A page with a base URL of its own keeps it and is
 * not given ours (design 2.3): its `#` links then follow its own base, as in any browser.
 */
export function withEmbedLead(html, policyMeta) {
  const text = String(html);
  const at = embedLeadPosition(text);
  const lead = embedDocumentLead(policyMeta, { ownBase: embedHasOwnBase(text) });
  return text.slice(0, at) + lead + text.slice(at);
}

/** The attribute that holds a local page's inlined document while its frame is not live. The deck
 *  runtime copies it into `srcdoc` on the slide being presented and removes `srcdoc` on leaving. */
export const EMBED_DOC_ATTRIBUTE = "data-embed-doc";
export const EMBED_POSTER_KIND_LOCAL = "Interactive page";
export const EMBED_POSTER_NOTE_LOCAL = "Runs when this slide is presented";
export const EMBED_TITLE_MAX = 80;

/** The character a numeric reference names, or U+FFFD when it names none a title may hold. */
function fromCodePoint(value) {
  if (!Number.isInteger(value) || value <= 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return "�";
  return value < 0x20 || (value >= 0x7f && value <= 0x9f) ? " " : String.fromCodePoint(value);
}

/** A title's raw content with each tag ("<" to the next ">") replaced by a space. A "<" with no ">"
 *  after it is text and ends the search: one pass, where a pattern would look for the missing ">"
 *  again from every later "<". */
function withoutTags(raw) {
  let out = "";
  let i = 0;
  for (;;) {
    const lt = raw.indexOf("<", i);
    const gt = lt < 0 ? -1 : raw.indexOf(">", lt + 1);
    if (gt < 0) return out + raw.slice(i);
    out += `${raw.slice(i, lt)} `;
    i = gt + 1;
  }
}

/**
 * A page's own `<title>`, read as text: the first HTML `<title>` element (not one inside a comment,
 * a script or an SVG), tags inside it dropped, character references decoded (the named ones a title
 * commonly has: amp, lt, gt, quot, apos, nbsp; and every decimal or hexadecimal one), white space
 * collapsed, cut to 80 characters. Empty when the page has none. The result is plain text and is
 * escaped again wherever it is written.
 */
export function embedPageTitle(html) {
  const source = String(html ?? "");
  let raw = null;
  scanStartTags(source, (tag) => {
    if (tag.name !== "title") return false;
    raw = source.slice(tag.contentStart, tag.contentEnd);
    return true;
  });
  if (raw === null) return "";
  const named = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&", nbsp: " " };
  const text = withoutTags(raw)
    .replace(/&(?:#x([0-9a-f]{1,8})|#([0-9]{1,8})|(lt|gt|quot|apos|amp|nbsp));/gi, (whole, hex, decimal, name) =>
      (hex ? fromCodePoint(Number.parseInt(hex, 16)) : decimal ? fromCodePoint(Number.parseInt(decimal, 10)) : named[name.toLowerCase()]))
    .replace(/[\s ]+/g, " ")
    .trim();
  return Array.from(text).slice(0, EMBED_TITLE_MAX).join("");
}

/**
 * The labelled box shown wherever an embedded page is not running: its kind, its title and one
 * line. `<span>` elements only, so the step plans (Reveal, Focus, emphasis) do not count it, and
 * in the compiled markup, so it needs no script: previews, thumbnails, print and the phone list
 * show it as they show any other slide content. Every argument is escaped here except `icon`,
 * which is the compiler's own SVG.
 */
export function embedPosterMarkup({ kind, title, note, icon = "" }) {
  return `<span class="embed-poster" aria-hidden="true">`
    + (icon ? `<span class="embed-poster-icon">${icon}</span>` : "")
    + `<span class="embed-poster-kind">${escapeHtml(kind)}</span>`
    + `<span class="embed-poster-title">${escapeHtml(title)}</span>`
    + (note ? `<span class="embed-poster-note">${escapeHtml(note)}</span>` : "")
    + `</span>`;
}

/**
 * The figure of a local page: the placeholder, an EMPTY sandboxed frame that carries the inlined
 * document in `data-embed-doc` (no `src`, no `srcdoc`: it holds about:blank and nothing runs), and
 * whatever follows the frame (the Interact chip). `figureAttrs` and `after` are markup the caller
 * has already built; `doc` and `title` are escaped here.
 */
export function embedLocalFigureMarkup({ doc, title, simulation = false, figureAttrs = "", icon = "", after = "" }) {
  const shown = String(title ?? "");
  return `<figure class="slide-embed${simulation ? " slide-simulation" : ""}" data-embed="local" data-embed-state="idle"${figureAttrs}>`
    + embedPosterMarkup({ kind: EMBED_POSTER_KIND_LOCAL, title: shown, note: EMBED_POSTER_NOTE_LOCAL, icon })
    + `<iframe ${EMBED_DOC_ATTRIBUTE}="${escapeHtml(doc)}"${embedFrameAttributes("local")} title="${escapeHtml(`${EMBED_POSTER_KIND_LOCAL}: ${shown}`)}"></iframe>`
    + after
    + `</figure>`;
}

export { embedAgentSource };
