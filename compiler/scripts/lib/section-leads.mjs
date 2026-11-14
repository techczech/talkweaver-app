// =============================================================================
// Section lead colours of the 0.44 Ocean look (design record docs/design/2026-11-10-native-slide-redesign/,
// handoff-0.44-basics.md "Locked on 11 Nov 23:09" and "Added 11 Nov 23:27").
//
// Each `##` section of a talk has a lead colour: the colour of its single-idea slides (section divider, full
// statement, the light statement's rule), its side rail and its title tab. All five approved leads may be used:
//
//   blue         A  Ocean #1273C4, white type
//   amber        B  amber #FF9F1C, near-black type
//   deep-blue    C  Deeper Ocean #0D5A9E, white type
//   light        D  light-led: white grounds, Ocean type and shapes
//   light-amber  E  light-led: white grounds, an amber disc, Deeper Ocean type
//
// By default the sections rotate through A, B, D, C, E (the design thread's order). The talk's `section-colours:`
// line can switch the rotation off (every section the look's own lead: blue, amber with `palette: bold`), give the
// list to rotate through, or name one colour for every section; a `{section-colour=…}` on a `##` heading sets that
// one section, and wins over the rotation without moving the other sections' colours.
//
// The rotation counts sections, not slides: adding a slide inside a section changes no colour; adding a section
// moves the colours of the sections after it by one step. Slides outside any section (the title slide, the closing
// and links slides, slides before the first `##`) take the first colour of the list. A pre-work section is not
// presented, takes no step of the rotation and takes the first colour too.
//
// Pure: the compiler (08-source-adapters) resolves each slide's lead once; 07-assembly stamps it as data-lead on
// the slide, and skin/zz-x-ocean-70-section-colours.css turns that into the look's lead tokens.
// =============================================================================

import { normaliseTriggerValue } from "./trigger-value-spelling.mjs";

/** The five approved section leads, by the names an outline writes. */
export const SECTION_LEADS = ["blue", "amber", "deep-blue", "light", "light-amber"];

/** The default rotation (A, B, D, C, E). */
export const SECTION_LEAD_ROTATION = ["blue", "amber", "light", "deep-blue", "light-amber"];

const normalise = (value) => normaliseTriggerValue("section-colour", String(value ?? ""));

/** One written colour name, or "" when it is not one of the five. */
export function sectionLeadName(value) {
  const name = normalise(value);
  return SECTION_LEADS.includes(name) ? name : "";
}

/**
 * Read the talk-level `section-colours:` value.
 *   absent or `auto`  → { state: "rotate", list: the default rotation }
 *   `off`             → { state: "off" } (every section the look's own lead)
 *   a list            → { state: "list", list } (comma-separated, or a YAML list; one name = every section)
 * Names that are not one of the five are returned in `unknown` and left out of the list; a list with no known
 * name falls back to the default rotation.
 */
export function readSectionColours(raw) {
  if (raw == null || raw === "" || raw === true) return { state: "rotate", list: [...SECTION_LEAD_ROTATION], unknown: [] };
  if (raw === false) return { state: "off", list: [], unknown: [] };
  const items = Array.isArray(raw) ? raw : String(raw).split(",");
  const words = items.map(normalise).filter(Boolean);
  if (words.length === 0 || (words.length === 1 && words[0] === "auto")) return { state: "rotate", list: [...SECTION_LEAD_ROTATION], unknown: [] };
  if (words.length === 1 && ["off", "none", "false", "no"].includes(words[0])) return { state: "off", list: [], unknown: [] };
  const list = words.filter((word) => SECTION_LEADS.includes(word));
  const unknown = words.filter((word) => !SECTION_LEADS.includes(word));
  if (list.length === 0) return { state: "rotate", list: [...SECTION_LEAD_ROTATION], unknown };
  return { state: "list", list, unknown };
}

/**
 * The lead of every section and of the slides outside sections.
 *   sections: [{ id, override?, prework? }] in outline order
 *   setting:  the result of readSectionColours
 *   bold:     `palette: bold` (the look's own lead is amber: with no `section-colours:` line every section is amber)
 * Returns { outside, bySection: Map(id → lead) }.
 */
export function resolveSectionLeads({ sections = [], setting = readSectionColours(undefined), bold = false } = {}) {
  const ownLead = bold ? "amber" : "blue";
  const list = setting.state === "off" ? [ownLead]
    : setting.state === "rotate" ? (bold ? ["amber"] : setting.list)
    : setting.list;
  const bySection = new Map();
  let step = 0;
  for (const section of sections) {
    if (!section || section.id == null || bySection.has(section.id)) continue;
    if (section.prework) {
      bySection.set(section.id, sectionLeadName(section.override) || list[0]);
      continue;
    }
    const rotated = list[step % list.length];
    step += 1;
    bySection.set(section.id, sectionLeadName(section.override) || rotated);
  }
  return { outside: list[0], bySection };
}
