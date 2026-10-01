// A slide's own reactions: the {reactions=…} Trigger-line token (ADR-0027 amendment §6; ticket 04;
// docs/design/2026-09-28-reactions-questions/surfaces-and-states.md § Trigger-line token).
//
// One reader and one writer, shared by the compiler (what the audience page and the presenter chip
// get), the Inspector's Audience section (what it shows and what it writes) and the tests:
//
//   readReactionsValue(value)  what a token value means: standard, off, a chosen set or custom labels
//   reactionsToken(choice)     the one token the Inspector writes for a choice ('' for Standard)
//   customLabelsProblem(list)  why a list of custom labels cannot be written, or ''
//
// The registered reactions (names, icons, words) live in the audience runtime,
// compiler/assets/runtime/audience-reactions.js audienceReactionRegistry(): the page embeds that
// function, so it is the one list and this module reads it.
//
// Values arrive as the Trigger-line tokenizer leaves them: `reactions` is a list-valued key
// (LIST_VALUE_KEYS), so the commas belong to the value, and quotes are already unwrapped
// (`{reactions="Too fast","Just right"}` reads `Too fast,Just right`). A value that is exactly a
// registered id is that reaction; any other value is a custom label, stored as `custom:<label>`.
import { audienceReactionRegistry } from "../../assets/runtime/audience-reactions.js";

export const REACTIONS_KEY = "reactions";
/** The set a slide carries when its Trigger line names none (ADR-0027 §2). */
export const STANDARD_REACTIONS = Object.freeze(["puzzled", "helped", "bookmark"]);
/** At most four reactions on a slide, so the phone bar fits with Ask at 360px with words. */
export const MAX_REACTIONS = 4;
/** The live worker's limit for a custom label (worker/protocol.ts AUDIENCE_FEEDBACK_LIMITS). */
export const CUSTOM_LABEL_MAX = 40;

const REGISTRY = audienceReactionRegistry();

/** Every registered reaction in the order the Inspector offers them: `{ id, icon, words, short }`. */
export function registeredReactions() {
  return Object.entries(REGISTRY).map(([id, entry]) => ({ id, icon: entry.icon, words: entry.words, short: entry.short }));
}

export function isRegisteredReaction(id) {
  return Object.prototype.hasOwnProperty.call(REGISTRY, id);
}

/** The registered id a label spells ignoring case ("Agree" → "agree"), or ''. */
export function registeredReactionIgnoringCase(label) {
  const lower = String(label).trim().toLowerCase();
  return isRegisteredReaction(lower) ? lower : "";
}

/**
 * What a `{reactions=…}` value means.
 *   mode 'standard'  no token (or nothing readable in it): the standard three
 *   mode 'off'       `off`: no reactions, the bar keeps Ask
 *   mode 'choose'    registered reactions only, in the order written
 *   mode 'custom'    at least one custom label (registered ones beside it keep their icons)
 * `ids` is what the slide offers, as stored on the Run (`agree`, `custom:Too fast`): at most four,
 * duplicates once, labels cut to 40 characters. `issues` names each thing that was changed to get
 * there, for the compiler's warnings: too-many (with `count`), duplicate, label-too-long,
 * off-with-others; and two hints that change nothing: list-space (the value ends in a comma, the
 * mark of a space after a comma, `{reactions=agree, disagree}`, which the tokenizer ends at the
 * space) and label-like-named (a custom label spelled as a registered id in other case, with `id`).
 * @param {unknown} value
 */
export function readReactionsValue(value) {
  const issues = [];
  if (typeof value !== "string") return { mode: "standard", ids: [...STANDARD_REACTIONS], issues };
  if (/,\s*$/.test(value)) issues.push({ code: "list-space" });
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return { mode: "standard", ids: [...STANDARD_REACTIONS], issues };
  if (parts.includes("off")) {
    if (parts.length > 1) issues.push({ code: "off-with-others" });
    return { mode: "off", ids: [], issues };
  }
  const ids = [];
  let custom = false;
  for (const part of parts) {
    let id;
    if (isRegisteredReaction(part)) id = part;
    else {
      custom = true;
      const named = registeredReactionIgnoringCase(part);
      if (named && !issues.some((issue) => issue.code === "label-like-named")) issues.push({ code: "label-like-named", id: named });
      if (part.length > CUSTOM_LABEL_MAX) {
        issues.push({ code: "label-too-long" });
        // Cut by characters, never through a surrogate pair, to the worker's length.
        let cut = "";
        for (const char of Array.from(part)) { if ((cut + char).length > CUSTOM_LABEL_MAX) break; cut += char; }
        id = `custom:${cut.trim()}`;
      } else id = `custom:${part}`;
    }
    if (ids.includes(id)) { if (!issues.some((issue) => issue.code === "duplicate")) issues.push({ code: "duplicate" }); continue; }
    ids.push(id);
  }
  if (ids.length > MAX_REACTIONS) issues.push({ code: "too-many", count: ids.length });
  return { mode: custom ? "custom" : "choose", ids: ids.slice(0, MAX_REACTIONS), issues };
}

/** The label of a stored id: the registered short name, or the custom label. */
export function reactionLabel(id) {
  if (isRegisteredReaction(id)) return REGISTRY[id].short;
  return String(id).startsWith("custom:") ? String(id).slice("custom:".length) : String(id);
}

/**
 * Why these custom labels cannot be written as one token, or '' when they can: at least one, at most
 * four, each at most 40 characters, and none with a character the Trigger line cannot hold in a
 * quoted value (a double quote, a brace) or a comma (it would split the label).
 * @param {readonly string[]} labels
 */
export function customLabelsProblem(labels) {
  const list = labels.map((label) => String(label).trim()).filter(Boolean);
  if (!list.length) return "Write at least one label.";
  if (list.length > MAX_REACTIONS) return `Up to ${MAX_REACTIONS} labels.`;
  if (list.some((label) => /["{},]/.test(label))) return "Labels cannot contain quotes, braces or commas.";
  if (list.some((label) => label.length > CUSTOM_LABEL_MAX)) return `Each label at most ${CUSTOM_LABEL_MAX} characters.`;
  if (new Set(list).size !== list.length) return "Each label once.";
  // A label spelled as a registered id, in any case, is that reaction: exactly, it would read back as
  // the named reaction with its icon; in other case ("Agree"), it would be a look-alike of it.
  const named = list.find((label) => registeredReactionIgnoringCase(label));
  if (named) return `“${named}” is the named reaction ${registeredReactionIgnoringCase(named)}; choose it under Choose.`;
  return "";
}

/**
 * The one token for a choice, as the Inspector writes it (Standard writes none):
 *   { mode: 'standard' }                  → ''
 *   { mode: 'off' }                       → 'reactions=off'
 *   { mode: 'choose', ids: [...] }        → 'reactions=agree,disagree' (registered ids only)
 *   { mode: 'custom', labels: [...] }     → 'reactions="Too fast","Just right","Too slow"'
 * An empty choose or custom list is Standard. Throws on a list this module would not read back as
 * the same choice (an unregistered id in choose; labels customLabelsProblem refuses).
 * @param {{ mode: string, ids?: readonly string[], labels?: readonly string[] }} choice
 */
export function reactionsToken(choice) {
  if (choice.mode === "off") return `${REACTIONS_KEY}=off`;
  if (choice.mode === "choose") {
    const ids = [...new Set(choice.ids ?? [])];
    if (!ids.length) return "";
    if (ids.some((id) => !isRegisteredReaction(id))) throw new Error(`Not a registered reaction: ${ids.filter((id) => !isRegisteredReaction(id)).join(", ")}`);
    if (ids.length > MAX_REACTIONS) throw new Error(`Up to ${MAX_REACTIONS} reactions.`);
    return `${REACTIONS_KEY}=${ids.join(",")}`;
  }
  if (choice.mode === "custom") {
    const labels = (choice.labels ?? []).map((label) => String(label).trim()).filter(Boolean);
    if (!labels.length) return "";
    const problem = customLabelsProblem(labels);
    if (problem) throw new Error(problem);
    return `${REACTIONS_KEY}=${labels.map((label) => `"${label}"`).join(",")}`;
  }
  return "";
}

/** The compiler's warnings for one slide's issues (warning-registry.mjs `reactions-*`). */
export function reactionWarnings(slideId, issues) {
  return issues.map((issue) => issue.code === "too-many"
    ? `reactions-too-many:${slideId}:${issue.count}`
    : issue.code === "label-like-named"
      ? `reactions-label-like-named:${slideId}:${issue.id}`
      : `reactions-${issue.code}:${slideId}`);
}
