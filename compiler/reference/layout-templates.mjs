// Blank Markdown templates — the structure each layout expects, ready to fill in.
//
// Single source of truth (ADR-0021): TalkWeaver's layout picker imports this so ⌘-Enter inserts
// the scaffold and Space previews it; the same map can document the catalogue. Each template is
// the Trigger line plus a placeholder body, meant to REPLACE the `/` line the author is on (the
// `### Heading` stays above). Keyed by the bare-word trigger the picker offers.
//
// Drift guard: scripts/test-layout-templates.mjs compiles every template and asserts it produces
// the layout it claims, with no warnings — so a template that stops matching the engine fails CI.

export const LAYOUT_TEMPLATES = {
  // everyday
  statement: "{statement}\n\nThe one sentence that lands.",
  list: "{list}\n\n- First point\n- Second point\n- Third point",
  numbered: "{numbered}\n\n- First step\n- Second step\n- Third step",
  iconlist: "{iconlist}\n\n- GitHub {icon=github}\n- Research papers {icon=file-text}\n- Podcasts {icon=mic}",
  quote: "{quote}\n\n> The quotation goes here.\n— Source, Year",
  contrast: "{contrast}\n\n- Before / After\n- Manual / Automated\n- Slow / Fast",
  "copy-visual": "{copy-visual}\n\n![](paste-or-search-an-image)\n\nThe explanatory copy beside the image.",
  media: "{media}\n\n![](paste-or-search-an-image)",
  "image-claim": "{image-claim}\n\n![](paste-or-search-an-image)\n\n- First callout\n- Second callout",

  // cards / grids
  cards: "{cards}\n\n- First card\n  - supporting detail\n- Second card\n  - supporting detail\n- Third card\n  - supporting detail",
  // ADR-0022: {carousel} splits TOP-LEVEL blocks into full-bleed stepped sub-slides (no #### needed).
  carousel: "{carousel}\n\nThe first sub-slide.\n\n> A quote sub-slide.\n— Source\n\n- A list sub-slide\n  - kept as a child",
  "image-grid": "{image-grid}\n\n![](paste-or-search-an-image)\n- First label\n![](paste-or-search-an-image)\n- Second label",
  columns: "{columns}\n\n#### Left column\n- point\n\n#### Right column\n- point",

  // structured / hierarchical (nested list)
  smartart: "{smartart}\n\n- First node\n  - detail\n- Second node\n  - detail",
  pyramid: "{pyramid}\n\n- Apex (top tier)\n- Middle tier\n- Base (bottom tier)",
  orgchart: "{orgchart}\n\n- Top\n  - Report A\n  - Report B",
  mindmap: "{mindmap}\n\n- Central idea\n  - Branch one\n  - Branch two",
  flow: "{flow}\n\n- First\n- Then\n- Finally",
  "system-map": "{system-map}\n\n- Satellite one\n- Satellite two\n- Satellite three",
  conceptmap: "{conceptmap}\n\n- Cause -drives- Effect\n- Effect -enables- Outcome",

  // temporal
  timeline: "{timeline}\n\n- 2023: First milestone\n- 2024: Second milestone\n- 2025: Third milestone",
  timetable: "{timetable}\n\n- 09:00: Welcome\n- 10:30: Break\n- 11:00: Session",
  sigmoid: "{sigmoid}\n\n- Early: slow start\n- Middle: rapid growth\n- Late: plateau",

  // ppt-replication batch
  stats: "{stats}\n\n- 75%: of teams\n- 3x: faster\n- 12k: users",
  process: "{process}\n\n- Gather\n- Build\n- Ship",
  steps: "{steps}\n\n- First step\n- Second step\n- Third step",
  iconrow: "{iconrow}\n\n- GitHub {icon=github}\n  - code host\n- Papers {icon=file-text}\n  - research",
  "image-quote": "{image-quote}\n\n![](paste-or-search-an-image)\n\n> The quotation.\n— Source",

  // diagrams / data
  chart: "{barchart}\n\n- Alpha: 40\n- Beta: 35\n- Gamma: 25",
  table: "{table}\n\n- Row one\n  - Cell A\n  - Cell B\n- Row two\n  - Cell A\n  - Cell B",
  cycle: "{cycle}\n\n- Plan\n- Do\n- Check\n- Act",
  equation: "{equation}\n\n- Input\n- Process\n- Output",
  "cta-screenshots": "{cta-screenshots}\n\n![](paste-or-search-an-image)\n\n- First benefit\n- Second benefit",

  // code / transcript
  code: "{code}\n\n```js\n// your code here\n```",
  trace: "{trace}\n\n```trace\nYou: the question\nAssistant: the answer\n```"
}

// Aliases that share another layout's structure (the picker may offer either bare word).
export const ALIASES = {
  barchart: "chart", piechart: "chart", linechart: "chart", curve: "chart",
  agenda: "process", stairs: "steps", "icon-row": "iconrow",
  imagegrid: "image-grid", imagequote: "image-quote", "2col": "columns", "3col": "columns",
  timelinevertical: "timeline", timelinehorizontal: "timeline", timelinespine: "timeline",
  "timeline-pills": "timeline", timelinepills: "timeline", "plain-list": "list", plainlist: "list"
}

// The scaffold for a trigger, or a generic list fallback (adaptive layouts make a flat list a
// reasonable default for most layouts). `trigger` is a bare word like "cards" or "image-grid".
export function templateFor(trigger) {
  const key = ALIASES[trigger] || trigger
  return (
    LAYOUT_TEMPLATES[key] ||
    `{${trigger}}\n\n- First point\n- Second point\n- Third point`
  )
}
