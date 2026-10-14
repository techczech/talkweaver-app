// A slide's attributes as the compiler resolves them (moved out of 08-source-adapters.mjs so the app reads them
// with the compiler's own code instead of a copy: src/shared/feedback-accept.ts `slideEffectiveAttrs`).
// Precedence, lowest first (ADR-0015): the talk's frontmatter `triggers:`, the heading and its Trigger line (already
// folded into `node.attrs` by the tree parse), then any Trigger-shaped line in the slide's content outside code fences.
// Pure: no node: imports.
import { parseHeadingAttrs, parseTriggerLine } from "./02-triggers-layout.mjs";
import { chartObjectTokenAt, parseMarkdownFenceOpeningLine, isMarkdownFenceClosingLine } from "./03-object-token.mjs";
import { parseSimpleYaml } from "./simple-yaml.mjs";

/** The frontmatter of an outline as the compiler reads it: `{}` when there is none or it is not closed. */
export function outlineFrontmatterMeta(markdown) {
  const text = String(markdown ?? "");
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  return end >= 0 ? parseSimpleYaml(text.slice(3, end).trim()) : {};
}

/**
 * ADR-0015: frontmatter `triggers:` is the deck-wide DEFAULTS level: the same vocabulary (bare words / key=value,
 * space-separated, no braces needed), applied to every `###` slide and overridden by anything the slide sets itself.
 * Per-slide-only keys make no sense deck-wide and are barred with a warning: layout (and its bare-word shorthands)
 * and id. Returns the defaults and the warnings, in the order the compiler reports them.
 */
export function deckTriggerDefaultsFromMeta(meta) {
  const attrs = {};
  const warnings = [];
  if (typeof meta?.triggers === "string" && meta.triggers.trim()) {
    const parsed = parseHeadingAttrs(`{${meta.triggers.replace(/[{}]/g, " ").trim()}}`);
    for (const w of parsed.warnings || []) warnings.push(w);
    for (const [key, value] of Object.entries(parsed.attrs)) {
      if (key === "layout" || key === "id") {
        warnings.push(`frontmatter-trigger-ignored:${key}=${value}`);
        continue;
      }
      attrs[key] = value;
    }
  }
  return { attrs, warnings };
}

/** The attributes a node starts from: the deck's defaults under its own (heading and Trigger line). A new object. */
export function slideAttrsFromNode(node, deckTriggerDefaults) {
  return { ...deckTriggerDefaults, ...(node?.attrs || {}) };
}

/**
 * Which content lines the compiler folds as Trigger lines: for each line, the parsed line (`parseTriggerLine`: its
 * `attrs` and `warnings`) when it is Trigger-shaped and outside a code fence, else null. A chart token that owns the
 * list below it stays content. The one decision, read by `foldContentTriggerLines` below and by the app's reading of
 * a slide's lines (src/shared/layout-verbs.ts `quoteBody`), which needs each line's place as well.
 */
export function contentTriggerLines(contentLines) {
  const lines = contentLines || [];
  const folded = new Array(lines.length).fill(null);
  let fenceOpening = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fenceOpening) {
      if (isMarkdownFenceClosingLine(line, fenceOpening)) fenceOpening = null;
      continue;
    }
    const open = parseMarkdownFenceOpeningLine(line);
    if (open) {
      fenceOpening = open;
      continue;
    }
    folded[index] = chartObjectTokenAt(lines, index) ? null : parseTriggerLine(line);
  }
  return folded;
}

/**
 * The node's content lines with every Trigger-shaped line outside a code fence taken out and folded into `attrs`
 * (mutated). A chart token that owns the list below it stays content. `onWarning` receives each folded line's
 * warnings; `authoredKeys` (a Set) gains the keys those lines set.
 */
export function foldContentTriggerLines(node, attrs, { onWarning = null, authoredKeys = null } = {}) {
  const linesOut = [];
  const contentLines = node?.contentLines || [];
  const folded = contentTriggerLines(contentLines);
  for (let index = 0; index < contentLines.length; index += 1) {
    const stray = folded[index];
    if (stray) {
      if (onWarning) {
        for (const w of stray.warnings || []) onWarning(w);
      }
      Object.assign(attrs, stray.attrs);
      if (authoredKeys) for (const key of Object.keys(stray.attrs || {})) authoredKeys.add(key);
    } else {
      linesOut.push(contentLines[index]);
    }
  }
  return linesOut;
}

/** The attributes the compiler gives the node's slide: `slideAttrsFromNode`, then `foldContentTriggerLines`. */
export function effectiveSlideAttrs(node, deckTriggerDefaults) {
  const attrs = slideAttrsFromNode(node, deckTriggerDefaults);
  foldContentTriggerLines(node, attrs);
  return attrs;
}
