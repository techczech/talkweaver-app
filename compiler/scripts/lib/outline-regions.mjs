// The outline's private and opaque regions, as the compiler reads them: speaker notes, HTML comments and
// the kind of a fenced block. One definition for the compiler's readers, the capture markup and the
// editor's object cards (ADR-0042 and its notes/comments addendum, 2026-10-28). Pure: no fs, no DOM.
//
//   notes      a line that, trimmed and lower-cased, equals `:::notes` opens a block; a line equal to
//              `:::` closes it while one is open (14-outline-tree.mjs). `::: notes` and `:::notes x`
//              are ordinary text. A `##`-`######` heading ends an unclosed block.
//   comments   every closed `<!-- … -->`, matched lazily from the start of the text
//              (html-comments.mjs blankHtmlComments). An unclosed `<!--` is text.
//   fences     the kind is chosen by the WHOLE info string, lower-cased, as the lexer's
//              `lang = rawInfo.toLowerCase()` does (03-markdown-lexer-core.mjs takeFence):
//              ```svg foo is a code panel, not a figure.
import { SIM_FENCE_LANGS } from "./simulation-fences.mjs";

/** The saved-views marker line (live-page-capture-markup.mjs re-exports it): exactly this, alone on its line. */
export const CAPTURE_VIEWS_MARKER = "<!-- saved views {capture} -->";

/** True when the line opens speaker notes (exactly `:::notes`, any case, surrounding space ignored). */
export function isNotesOpenLine(line) {
  return String(line ?? "").replace(/\r$/, "").trim().toLowerCase() === ":::notes";
}

/** True when the line closes an open speaker-notes block (exactly `:::`). */
export function isNotesCloseLine(line) {
  return String(line ?? "").replace(/\r$/, "").trim() === ":::";
}

/** The compiler's slide heading (`##`-`######` then whitespace): it ends an unclosed notes block. */
export function isNodeHeadingLine(line) {
  return /^(#{2,6})\s+\S/.test(String(line ?? "").replace(/\r$/, ""));
}

const COMMENT_RE = /<!--[\s\S]*?-->/g;

/** Every closed HTML comment of `text` as `{ from, to }` offsets, in the order the blanker removes them. */
export function closedHtmlComments(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(COMMENT_RE)) out.push({ from: m.index, to: m.index + m[0].length });
  return out;
}

/** The fence kinds the editor shows as cards. Chart fences are recognised by the chart grammar first. */
export const FENCE_KINDS = Object.freeze(["svg", "mermaid", "chat", "terminal", "trace", "code"]);

/** The kind of a closed fence from its info string (whole, lower-cased): svg, mermaid, chat, terminal, trace or code. */
export function fenceKindForInfo(info) {
  const lang = String(info ?? "").trim().toLowerCase();
  if (lang === "svg" || lang === "mermaid" || lang === "trace") return lang;
  if (SIM_FENCE_LANGS.has(lang)) return lang;
  return "code";
}

const REUSED_RE = /^<!--\s*reused from\s+(\S+)\s*\|[^|]*\|\s*(\d+)\s+slides?\s*\|\s*copied\s+(\d{4}-\d{2}-\d{2})\s*-->$/i;

/**
 * What a closed comment is, from exact patterns only (design §5.2). `text` is the comment from `<!--`
 * through `-->`; `context.aloneOnLine` and `context.pageAbove` say where it stands. Never guesses a purpose:
 * anything unmatched is an ordinary comment, labelled with its own first words.
 * → `{ kind, label, explanation, effect }` where effect is "deck" (the compiler reads it), "hides" (it
 * switches off a heading) or "none".
 */
export function describeHtmlComment(text, context = {}) {
  const source = String(text ?? "");
  const inner = source.replace(/^<!--/, "").replace(/-->$/, "");
  const lines = inner.split(/\r?\n/);
  const count = source.split(/\r?\n/).length;
  const linesWord = `${count} line${count === 1 ? "" : "s"}`;
  if (source.trim() === CAPTURE_VIEWS_MARKER && context.aloneOnLine) {
    return context.pageAbove
      ? { kind: "capture-marker", label: "Saved views for the web page above", effect: "deck",
        explanation: "TalkWeaver wrote this when you saved a view of the live page above. It says the views listed under the page are the ones to show. Deleting it lets the page show views recorded before saved-view lines existed, if there are any." }
      : { kind: "capture-marker-orphan", label: "Saved-views mark with no page above it", effect: "none",
        explanation: "This does nothing now." };
  }
  const reused = source.trim().match(REUSED_RE);
  if (reused) {
    const n = Number(reused[2]);
    return { kind: "reused", label: `Slides reused from ${reused[1]} (${n} slide${n === 1 ? "" : "s"}, copied ${reused[3]})`, effect: "none",
      explanation: "Added when you copied these slides from another talk. It records where they came from. It is not shown anywhere and nothing depends on it." };
  }
  if (/^<!--\s*\/?added\s*-->$/i.test(source.trim())) {
    return { kind: "added-mark", label: "Marks text added by Talk text", effect: "none",
      explanation: "Talk text's Notes document uses these to mark sentences an agent added. In an outline they do nothing." };
  }
  if (!inner.trim()) return { kind: "empty", label: "Empty comment", effect: "none", explanation: "An empty comment. It is not shown anywhere." };
  if (lines.some((line) => /^\s*#{1,6}\s+\S/.test(line))) {
    return { kind: "hidden-heading", label: `Hidden text · ${linesWord} · contains a slide heading`, effect: "hides",
      explanation: "Everything inside a comment is hidden from the deck. A heading inside one is a slide switched off, not shown." };
  }
  const first = lines.map((line) => line.trim()).find(Boolean) ?? "";
  const words = first.length > 60 ? `${first.slice(0, 59)}…` : first;
  return { kind: "comment", label: `Comment · ${words}${count > 1 ? ` · ${linesWord}` : ""}`, effect: "none",
    explanation: "A note in the outline. It is not shown in the deck, handout or share, and TalkWeaver does not use it." };
}
