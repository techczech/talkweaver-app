// Layout-name → Reference-fixture-id map (single source of truth, ADR-0004).
//
// FOR ME (agent-facing). TalkWeaver's layout picker (data/layouts.ts) keys layouts by a bare
// trigger NAME (e.g. "statement", "contrast-cards", "barchart"). The Reference Deck fixtures
// (fixtures.mjs) key by a stable {id=…} slug (e.g. "ref-statement"). This map bridges the two so
// the picker can show each layout's REAL compiled render as its preview thumbnail.
//
// Most picker names map to `ref-<name>` directly; the OVERRIDES below cover the handful where the
// picker name and the fixture slug diverge (a fixture renamed for clarity, or one fixture standing
// in for several picker variants — e.g. all three chart types share their own fixtures, the two
// table entries share ref-table). Keep this in sync with data/layouts.ts and fixtures.mjs; a
// picker name with no fixture simply falls back to the hand-drawn preview in the picker.

import { fixtures } from "./fixtures.mjs";

// Picker layout name → fixture id, ONLY where it is not the trivial `ref-<name>`.
const OVERRIDES = {
  "contrast-cards": "ref-contrast-panels",
  media: "ref-image",
  barchart: "ref-chart-bar",
  piechart: "ref-chart-pie",
  linechart: "ref-chart-line",
  "table-outline": "ref-table",
  // The picker spells the timeline variants as one word; the fixtures hyphenate them.
  timelinevertical: "ref-timeline-vertical",
  timelinehorizontal: "ref-timeline-horizontal",
  timelinespine: "ref-timeline-spine",
};

const fixtureIds = new Set(fixtures.map((f) => f.id));

/**
 * Resolve a picker layout name to the Reference fixture id whose compiled slide best stands in
 * for it, or null when no fixture exists (the picker then keeps its hand-drawn preview).
 * @param {string} name picker layout name, e.g. "statement" / "contrast-cards" / "barchart"
 * @returns {string|null} fixture id, e.g. "ref-statement", or null
 */
export function fixtureIdForLayout(name) {
  const id = OVERRIDES[name] ?? `ref-${name}`;
  return fixtureIds.has(id) ? id : null;
}

/**
 * Build a { layoutName: fixtureId } map for a list of picker layout names. Names with no fixture
 * are omitted so the caller can fall back per-name.
 * @param {string[]} layoutNames
 * @returns {Record<string,string>}
 */
export function layoutFixtureMap(layoutNames) {
  const out = {};
  for (const name of layoutNames) {
    const id = fixtureIdForLayout(name);
    if (id) out[name] = id;
  }
  return out;
}
