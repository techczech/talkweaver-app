// Reference Deck fixtures — one real, compiling Markdown snippet per supported feature.
//
// FOR ME (agent-facing). These are the single source of truth for the Reference Deck:
// build-reference-deck.mjs assembles every `markdown` here into ONE outline, compiles it
// through the real generator pipeline (scripts/generate-presentation-bundle.mjs), then shows
// each fixture's source beside its actual compiled render. If a fixture stops compiling the
// build fails loudly, so this file doubles as the format's regression corpus.
//
// Each entry:
//   id        stable slug; also the slide `data-id` the render is matched back by (via {id=…}).
//   group     "everyday" | "structural" | "specialised" | "modes" (readability grouping only;
//             ADR-0004: no support tiers — every feature is equally first-class).
//   name      human label for the entry.
//   explicit  the explicit trigger form, e.g. "{layout=statement}".
//   shorthand the bare-word form, e.g. "{statement}". The resolver is LIVE (scripts/triggers.mjs):
//             a bare word resolves to its explicit (key,value), so either spelling compiles. The
//             deck labels this column "shorthand (live)".
//   blurb     one-line "what it does / when to reach for it".
//   markdown  a real outline fragment that compiles TODAY. Must contain exactly one `###`
//             slide (or `##` for the structural section/subsection entries) carrying `{id=<id>}`
//             so the render can be matched back. May use the bare-word shorthand where natural
//             (the resolver is live) — combine the id with the trigger, e.g. `{statement id=…}`.
//
// Adding a feature: add an entry, run `npm run reference`. If it compiles and renders, it is
// documented; if not, the build fails.

/** @typedef {{id:string,group:string,name:string,explicit:string,shorthand:string,blurb:string,markdown:string,kind?:string}} Fixture */

/** @type {Fixture[]} */
export const fixtures = [
  // ──────────────────────────────── EVERYDAY ────────────────────────────────
  {
    id: "ref-statement",
    group: "everyday",
    name: "Statement",
    explicit: "{layout=statement}",
    shorthand: "{statement}",
    blurb: "One big idea, full-bleed. The default for a prose-only slide.",
    markdown: `### The model only ever returns a string. {statement id=ref-statement}

Everything else — tools, memory, the loop — is the harness arranging that string.`,
  },
  {
    id: "ref-list",
    group: "everyday",
    name: "List (plain by default)",
    explicit: "(default — no trigger)",
    shorthand: "{list}",
    blurb: "Bulleted points become panel cards. DEFAULT = plain, NO auto icons (icons are opt-in).",
    markdown: `### What changed this year {id=ref-list}

- Models got cheap enough to call in a loop
- Tool use became reliable enough to trust
- Context windows grew past whole codebases
- Harness patterns converged on a few shapes`,
  },
  {
    id: "ref-iconlist",
    group: "everyday",
    name: "Icon list (opt-in)",
    explicit: "{liststyle=icons}",
    shorthand: "{iconlist}",
    blurb: "Opt IN to semantic icons — each item gets a unique glyph (concept/lucide, and brands).",
    markdown: `### Where the work lives {iconlist id=ref-iconlist}

- GitHub repositories
- YouTube videos
- Research papers
- Podcast interviews`,
  },
  {
    id: "ref-numbered",
    group: "everyday",
    name: "Numbered list (opt-in)",
    explicit: "{liststyle=numbers}",
    shorthand: "{numbered}",
    blurb: "Force numbered discs on any list. (An ordered `1.`/`2.` source still auto-numbers.)",
    markdown: `### How a turn runs {numbered id=ref-numbered}

- The harness assembles the prompt
- The model responds with a string
- The harness parses and runs the tools
- The result is appended and the loop repeats`,
  },
  {
    id: "ref-quote",
    group: "everyday",
    name: "Quote (no title by default)",
    explicit: "(default — `>` block)",
    shorthand: "{quote}",
    blurb: "A `>` block + trailing `—` line, full-bleed. The heading is NAV-ONLY ({title=show} draws it).",
    markdown: `### Voices from the field {id=ref-quote}

> It's like a very fast, very confident, occasionally very wrong first draft.
— Project manager, 2025`,
  },
  {
    id: "ref-contrast-panels",
    group: "everyday",
    name: "Contrast panels (complex comparison)",
    explicit: "{layout=contrast} (5+ pairs)",
    shorthand: "{contrast}",
    blurb: "5+ A/B pairs become two opposing panels (light vs ink); the FIRST pair names the columns.",
    markdown: `### Two sides of one loop {layout=contrast id=ref-contrast-panels}

- HARNESS · on your computer · does things / MODEL · in the cloud · thinks
- parses model output / follows instructions
- runs shell commands / makes plans, reasons
- loads files into context / keeps things in context
- shows the user what's going on / decides what happens next
- works inside a folder / string in, string out`,
  },
  {
    id: "ref-annotated",
    group: "everyday",
    name: "Annotated list (label + aside)",
    explicit: "{sublist=aside}",
    shorthand: "{annotated}",
    blurb: "Icon-Label-Description cards: big label, children as a quiet right-hand annotation column.",
    markdown: `### What to learn {annotated icons id=ref-annotated}

- **Learn that**
	- it is an issue
	- it is possible
- **Learn how**
	- to use / do
	- to configure
- **Learn to**
	- make it part of your practice`,
  },
  {
    id: "ref-sidebar",
    group: "everyday",
    name: "Sidebar title (left rail)",
    explicit: "{title=side}",
    shorthand: "{sidebar}",
    blurb: "The title in a plain left rail beside the content — enforced on every layout, quotes and statements included.",
    markdown: `### Why work locally {sidebar icons id=ref-sidebar}

- The work is saved to a folder on your machine
- Outputs become part of your normal file structure
- The chat is not the main archive`,
  },
  {
    id: "ref-image",
    group: "everyday",
    name: "Image (media)",
    explicit: "{layout=media}",
    shorthand: "{media}",
    blurb: "A slide with only an image renders full-bleed; bytes are inlined unchanged.",
    markdown: `### A single diagram {layout=media id=ref-image}

![Two boxes: MODEL and HARNESS, joined by arrows](assets/two-box.svg "The model / harness split")`,
  },
  {
    id: "ref-contrast",
    group: "everyday",
    name: "Contrast",
    explicit: "{layout=contrast}",
    shorthand: "{contrast}",
    blurb: "List items split on ` / ` into side-by-side pairs — this versus that.",
    markdown: `### Chatbot versus agent {contrast id=ref-contrast}

- One turn / a loop of turns
- You drive / it drives itself
- Text in, text out / text in, actions out
- Predictable / surprising`,
  },
  {
    id: "ref-copy-visual",
    group: "everyday",
    name: "Copy + visual",
    explicit: "(auto — media + text)",
    shorthand: "{copy-visual}",
    blurb: "A slide with both an image and text lays them SIDE BY SIDE (two-column) by default.",
    markdown: `### Evidence so far {id=ref-copy-visual}

![Adoption chart](assets/two-box.svg "Adoption by sector, 2025")

Most knowledge workers now touch an AI tool every week. The open question is no
longer adoption — it is judgement: knowing when the fast draft is good enough.`,
  },
  {
    id: "ref-cards",
    group: "everyday",
    name: "Cards (static grid)",
    explicit: "{cards}",
    shorthand: "{cards}",
    blurb: "A flat `{cards}` list is a STATIC grid — every card on screen at once. Stepping is opt-in via #### or {carousel} (the Carousel).",
    markdown: `### Two ways to work {cards id=ref-cards}

- The static grid
  - every card visible together
- The stepped carousel
  - one full-bleed sub-slide at a time`,
  },
  {
    id: "ref-carousel",
    group: "everyday",
    name: "Carousel (stepped sub-slides)",
    explicit: "(auto — `####` cards)",
    shorthand: "{carousel}",
    blurb: "Each `####` (or, with `{carousel}`, each top-level block) becomes a FULL-BLEED sub-slide, stepped one at a time inside one slide — a real slide per step, not card-chrome.",
    markdown: `### Two reactions {id=ref-carousel}

#### The sceptic

> I don't trust text I didn't write.
— Senior researcher, 2025

#### The pragmatist

> I treat it as a tireless intern I have to check.
— Team lead, 2025`,
  },
  {
    id: "ref-carousel-trigger",
    group: "everyday",
    name: "Carousel from {carousel}",
    explicit: "{carousel}",
    shorthand: "{carousel}",
    blurb: "No `####` needed: `{carousel}` splits the slide's TOP-LEVEL blocks into one full-bleed sub-slide each; nested bullets stay as children.",
    markdown: `### One thought per step {carousel id=ref-carousel-trigger}

The shape of the slide is the shape of the thought.

> Say one thing at a time.
— Showcase, 2026

- A list is a sub-slide too
  - with its detail kept as children`,
  },
  {
    id: "ref-gallery",
    group: "everyday",
    name: "Gallery (image grid + lightbox)",
    explicit: "(auto — 2+ images)",
    shorthand: "(2+ images)",
    blurb: "2+ images with no #### / {carousel} are a GALLERY: a grid on ONE slide, all visible. Click an image to enlarge and step through in the lightbox. Never split.",
    markdown: `### Three early machines {id=ref-gallery}

![Vacuum-tube neuron](assets/two-box.svg "A vacuum-tube artificial neuron")
![Perceptron demo](assets/two-box.svg "The perceptron demo")
![Newsreel still](assets/two-box.svg "An ENIAC newsreel still")`,
  },

  // ─────────────────────────────── STRUCTURAL ───────────────────────────────
  {
    id: "ref-title",
    group: "structural",
    name: "Title",
    explicit: "{layout=title}",
    shorthand: "{title}",
    blurb: "Opening treatment. Normally auto-generated from frontmatter; can be authored.",
    markdown: `### Understanding agents {layout=title role=opening kicker="AICC Workshop 2026" id=ref-title}

From a string to a system.`,
  },
  {
    id: "ref-section",
    group: "structural",
    name: "Section divider",
    explicit: "## Heading",
    shorthand: "## Heading",
    blurb: "A `##` heading pushes a section and auto-generates a divider slide.",
    kind: "section",
    markdown: `## How a harness works {id=ref-section}`,
  },
  {
    id: "ref-subsection",
    group: "structural",
    name: "Subsection divider",
    explicit: "## Heading {sub}",
    shorthand: "## Heading {sub}",
    blurb: "A `##` carrying `{sub}` is a subsection of the current section, not a new one.",
    kind: "subsection",
    markdown: `## The loop {sub id=ref-subsection}`,
  },
  {
    id: "ref-closing",
    group: "structural",
    name: "Closing",
    explicit: "{layout=closing role=ending}",
    shorthand: "{closing}",
    blurb: "Closing treatment. Normally the auto thanks slide; can be authored.",
    markdown: `### Thank you {layout=closing role=ending id=ref-closing}

Questions — dominik@example.org`,
  },
  {
    id: "ref-timeline",
    group: "structural",
    name: "Timeline",
    explicit: "{timeline=rail} (auto on `**Timeline:**`)",
    shorthand: "{timeline}",
    blurb: "A `**Timeline:**` list becomes a dated rail; rail/columns/compact modes.",
    markdown: `### A short history {timeline=rail id=ref-timeline}

**Timeline:**
- 1950 — Turing asks "can machines think?"
- 2017 — Transformers arrive
- 2022 — Chat interfaces reach everyone
- 2024 — Tool-using agents become practical`,
  },
  {
    id: "ref-timeline-vertical",
    group: "structural",
    name: "Timeline — vertical",
    explicit: "{timeline=rail}",
    shorthand: "{timelinevertical}",
    blurb: "The conventional vertical dated rail named explicitly (an alias of rail).",
    markdown: `### A vertical history {timelinevertical id=ref-timeline-vertical}

**Timeline:**
- 1950 — Turing asks "can machines think?"
- 2017 — Transformers arrive
- 2022 — Chat interfaces reach everyone
- 2024 — Tool-using agents become practical`,
  },
  {
    id: "ref-timeline-horizontal",
    group: "structural",
    name: "Timeline — horizontal",
    explicit: "{timeline=horizontal}",
    shorthand: "{timelinehorizontal}",
    blurb: "A left-to-right track of dated stops along a single line (collapses to a vertical rail when narrow).",
    markdown: `### A horizontal history {timelinehorizontal id=ref-timeline-horizontal}

**Timeline:**
- 1950 — Turing's question
- 2017 — Transformers
- 2022 — Chat for everyone
- 2024 — Agents`,
  },
  {
    id: "ref-timeline-spine",
    group: "structural",
    name: "Timeline — spine",
    explicit: "{timeline=spine}",
    shorthand: "{timelinespine}",
    blurb: "A horizontal Oxford-blue spine; one dot per date stop on the line; the date label sits on the spine; event cards alternate above/below joined by dotted leaders. Built for ~6 legible stops — a longer timeline auto-splits into continuation slides (≤6 each).",
    markdown: `### A history of the idea of thinking machines {timelinespine id=ref-timeline-spine}

**Timeline:**
- 1950
  - Turing asks "can machines think?"
- 1966
  - ELIZA fakes a conversation
- 1997
  - Deep Blue beats Kasparov
- 2012
  - AlexNet ignites deep learning
- 2017
  - Transformers arrive
- 2024
  - Tool-using agents become practical`,
  },
  {
    id: "ref-timeline-pills",
    group: "structural",
    name: "Timeline — pills",
    explicit: "{timeline=pills}",
    shorthand: "{timeline-pills}",
    blurb: "The spine in its uniform variant: the date renders as a solid accent pill on the spine, and a single event card hangs below each stop (no alternation), joined by a dotted leader. Scannable. Same ~6-stop cap and auto-split rule as the spine.",
    markdown: `### The same history as date pills {timeline-pills id=ref-timeline-pills}

**Timeline:**
- 1950
  - Turing asks "can machines think?"
- 1966
  - ELIZA fakes a conversation
- 1997
  - Deep Blue beats Kasparov
- 2012
  - AlexNet ignites deep learning
- 2017
  - Transformers arrive
- 2024
  - Tool-using agents become practical`,
  },
  {
    id: "ref-grid",
    group: "structural",
    name: "Grid",
    explicit: "{layout=grid}",
    shorthand: "{grid}",
    blurb: "List items become tiles — a set of parallel options at a glance.",
    markdown: `### Five things you can do {grid id=ref-grid}

- Catalogue and organise data
- Manage a project
- Build a small tool
- Draft and revise writing
- Query a remote service`,
  },
  {
    id: "ref-system-map",
    group: "structural",
    name: "System map",
    explicit: "{layout=system-map centre=Agent}",
    shorthand: "{system-map}",
    blurb: "List items become radial nodes around a centre node you name.",
    markdown: `### What the harness wires together {layout=system-map centre=Harness id=ref-system-map}

- The model
- Tools
- Memory
- The loop
- Your prompt`,
  },

  // ────────────────────────────── SPECIALISED ───────────────────────────────
  {
    id: "ref-smartart",
    group: "specialised",
    name: "SmartArt",
    explicit: "{layout=smartart}",
    shorthand: "{smartart}",
    blurb: "A nested list becomes a PowerPoint-style hierarchical node grid.",
    markdown: `### Two shapes {layout=smartart id=ref-smartart}

- Chatbot
  - Prompt
  - Model responds
- Agent
  - Prompt
  - Model makes a plan
  - Model calls tools
  - Model revises the plan`,
  },
  {
    id: "ref-flow",
    group: "specialised",
    name: "Flow diagram",
    explicit: "{layout=flow flow=loop}",
    shorthand: "{flow}",
    blurb: "A list becomes connected node cards joined by arrows; horizontal/vertical/loop/branch.",
    markdown: `### The agentic loop {layout=flow flow=loop id=ref-flow}

- **Assemble** the prompt
  - harness builds context
- **Respond** with a string
  - model thinks
- **Parse and run** the tools
- **Append** the result`,
  },
  {
    id: "ref-image-claim",
    group: "specialised",
    name: "Image + claim",
    explicit: "{layout=image-claim}",
    shorthand: "{image-claim}",
    blurb: "First image is the visual; the list becomes callouts beside it.",
    markdown: `### What the picture shows {layout=image-claim id=ref-image-claim}

![The model / harness split](assets/two-box.svg "Model and harness")

- The model is stateless
- The harness holds all the state
- Every tool call round-trips through the harness`,
  },
  {
    id: "ref-cta-screenshots",
    group: "specialised",
    name: "CTA + screenshots",
    explicit: "{layout=cta-screenshots}",
    shorthand: "{cta-screenshots}",
    blurb: "Screenshot strip + callouts + action buttons — the call-to-action slide.",
    markdown: `### Try it yourself {layout=cta-screenshots id=ref-cta-screenshots}

![A worked example](assets/two-box.svg "Worked example")

- Open the playground
- Paste the example prompt
- Watch the loop run

[Action: Open the playground → https://example.org/play]`,
  },
  {
    id: "ref-trace",
    group: "specialised",
    name: "Trace (transcript)",
    explicit: "(auto — ```trace fence)",
    shorthand: "{trace}",
    blurb: "Role-tagged turns become a coloured transcript — an agent loop here; any speaker works (see next).",
    markdown: `### A tool call, start to finish {id=ref-trace}

\`\`\`trace
user
How many PDFs are in my Downloads folder?
reasoning
I should list the directory, then count .pdf files.
model: MODEL → HARNESS
<tool_call name="list_dir" args={"path": "~/Downloads"}/>
tool
paper.pdf  receipt.pdf  slides.pdf
model: MODEL → USER
Three PDFs: paper.pdf, receipt.pdf, slides.pdf.
\`\`\``,
  },
  {
    id: "ref-trace-dialogue",
    group: "specialised",
    name: "Trace (any dialogue)",
    explicit: "(auto — ```trace fence)",
    shorthand: "{trace}",
    blurb: "Same fence, arbitrary speakers: `Speaker: text`. Each distinct name gets an auto colour — interviews, debates, two-person exchanges, not just agent loops.",
    markdown: `### An interview, two voices {id=ref-trace-dialogue}

\`\`\`trace
Interviewer: What changed after you shipped it?
Maya: The feedback loop tightened. We could see a misread within minutes.
Interviewer: And the team's reaction?
Maya: Mixed at first — one engineer said: "this will never scale." It did.
\`\`\``,
  },
  {
    id: "ref-code",
    group: "specialised",
    name: "Code",
    explicit: "(auto — fenced code)",
    shorthand: "{code}",
    blurb: "A fenced block (not `trace`) becomes a verbatim monospace panel.",
    markdown: `### The loop in ten lines {id=ref-code}

\`\`\`python
while True:
    prompt = harness.assemble(history)
    reply = model.respond(prompt)
    calls = parse_tool_calls(reply)
    if not calls:
        break
    history += run_tools(calls)
\`\`\``,
  },
  {
    id: "ref-table",
    group: "specialised",
    name: "Table",
    explicit: "(default — pipe table)",
    shorthand: "{table}",
    blurb: "A pipe table with a header separator renders as an HTML table.",
    markdown: `### Roles in a trace {id=ref-table}

| Role | Who speaks | Shown as |
|---|---|---|
| user | the person | USER |
| model | the LLM | MODEL |
| tool | the harness | TOOL RESULT |`,
  },
  {
    id: "ref-qr",
    group: "specialised",
    name: "QR code",
    explicit: "(default — `[QR: …]`)",
    shorthand: "{qr}",
    blurb: "A `[QR: url | label]` directive bakes an offline QR SVG at build time.",
    markdown: `### Scan to continue {layout=statement id=ref-qr}

The slides and the playground live here.

[QR: https://example.org | Open the slides]`,
  },
  {
    id: "ref-action",
    group: "specialised",
    name: "Action button",
    explicit: "(default — `[Action: …]`)",
    shorthand: "{action}",
    blurb: "An `[Action: label → url]` directive becomes an accent call-to-action button.",
    markdown: `### Get started {layout=statement id=ref-action}

Everything you need is one click away.

[Action: Open the workshop → https://example.org/workshop]
[Action: Read the notes → https://example.org/notes]`,
  },
  {
    id: "ref-embed",
    group: "specialised",
    name: "Embed / simulation",
    explicit: "(default — `[Embed: …]` / `[Simulation: …]`)",
    shorthand: "{embed}",
    blurb: "An `[Embed: url]` or `[Simulation: path]` directive becomes a live iframe.",
    markdown: `### Live demo {layout=media id=ref-embed}

[Embed: https://example.org/demo]`,
  },
  {
    id: "ref-auto-embed",
    group: "specialised",
    name: "Auto-embed (bare URL)",
    explicit: "(default — a bare URL on its own)",
    shorthand: "(no trigger)",
    blurb: "A slide whose only content is a bare URL auto-embeds; YouTube/Vimeo links convert to player iframes.",
    markdown: `### Watch the talk {id=ref-auto-embed}

https://www.youtube.com/watch?v=cNxadbrN_aI`,
  },
  {
    id: "ref-logolist",
    group: "specialised",
    name: "Logo list (opt-in brands)",
    explicit: "{liststyle=logos}",
    shorthand: "{logolist}",
    blurb: "Opt IN to brand logos (svgl/extra) for a list of products or services.",
    markdown: `### Tools we lean on {logolist id=ref-logolist}

- GitHub
- Figma
- Notion
- Slack`,
  },

  // ───────────────────────────────── DIAGRAMS ───────────────────────────────
  {
    id: "ref-columns",
    group: "diagrams",
    name: "Columns (2col / 3col)",
    explicit: "{layout=columns} · {cols=2}",
    shorthand: "{columns} · {2col} · {3col}",
    blurb: "Top-level content laid side by side in N equal columns. Text-structural columns align TOP, image/paragraph columns align MIDDLE.",
    markdown: `### Two ways to read it {2col id=ref-columns}

**What changes**

- Models got cheap to loop
- Tool use became reliable
- Context grew past codebases

![The model / harness split](assets/two-box.svg "Model and harness")`,
  },
  {
    id: "ref-pyramid",
    group: "diagrams",
    name: "Pyramid",
    explicit: "{layout=pyramid}",
    shorthand: "{pyramid}",
    blurb: "A list becomes stacked tiers — narrow apex on top, widest base at the bottom (first item = apex, last = base).",
    markdown: `### From idea to action {pyramid id=ref-pyramid}

- Vision
- Strategy
- Tactics
- Daily work`,
  },
  {
    id: "ref-orgchart",
    group: "diagrams",
    name: "Org chart",
    explicit: "{layout=orgchart}",
    shorthand: "{orgchart}",
    blurb: "A nested list becomes a top-down hierarchy tree — the root item, then its children, joined by rails.",
    markdown: `### Who reports to whom {orgchart id=ref-orgchart}

- Director
  - Engineering lead
    - Backend
    - Frontend
  - Design lead`,
  },
  {
    id: "ref-mindmap",
    group: "diagrams",
    name: "Mind map",
    explicit: "{layout=mindmap}",
    shorthand: "{mindmap}",
    blurb: "A list with a root item + children becomes a central node with branches radiating left and right.",
    markdown: `### What a harness wires together {mindmap id=ref-mindmap}

- Harness
  - The model
  - Tools
  - Memory
  - The loop`,
  },

  {
    id: "ref-conceptmap",
    group: "diagrams",
    name: "Concept map",
    explicit: "{layout=conceptmap}",
    shorthand: "{conceptmap}",
    blurb: "Relation lines `A -label- B` become a labelled node-edge graph (nodes deduped, edges labelled), drawn as SVG.",
    markdown: `### How the pieces relate {conceptmap id=ref-conceptmap}

- car -type of- vehicle
- car -made of- metal
- car -needs- fuel
- vehicle -used for- transport`,
  },

  // ── PPT-replication batch (2026-06-11) — shapes ported from PPT2HandoutSkill ──
  {
    id: "ref-stats",
    group: "diagrams",
    name: "Stats (big-number row)",
    explicit: "{layout=stats}",
    shorthand: "{stats}",
    blurb: "Each item is `value label` (first token with a digit = the value) or `value · label`; a nested child becomes a small caption.",
    markdown: `### Reach so far {stats id=ref-stats}

- 1000+ people trained
  - across 3 divisions
- 2,000+ slides produced
- 95% satisfaction`,
  },
  {
    id: "ref-process",
    group: "diagrams",
    name: "Process / agenda strip",
    explicit: "{layout=process}",
    shorthand: "{process} (alias {agenda})",
    blurb: "Numbered discs on a connector line — `label · time` puts the time under the label; nested children become quiet detail lines.",
    markdown: `### Plan for the day {process id=ref-process}

- Welcome · 9:00
- Hands-on session · 9:30
- Discussion · 11:00
- Wrap-up · 12:00`,
  },
  {
    id: "ref-steps",
    group: "diagrams",
    name: "Steps (ascending stairs)",
    explicit: "{layout=steps}",
    shorthand: "{steps} (alias {stairs})",
    blurb: "Bottom-aligned columns rising left→right (first item = lowest step; the top step fills accent). The staircase sibling of {pyramid}.",
    markdown: `### Levels of adoption {steps id=ref-steps}

- Curiosity
  - reading, trying
- Adoption
- Integration
- Transformation`,
  },
  {
    id: "ref-iconrow",
    group: "diagrams",
    name: "Icon row",
    explicit: "{layout=iconrow}",
    shorthand: "{iconrow} (alias {icon-row})",
    blurb: "A horizontal icon + label + description row — the landscape sibling of {iconlist}; unresolvable icons fall back to numbered discs.",
    markdown: `### Where the work lives {iconrow id=ref-iconrow}

- GitHub repositories
  - code and issues
- YouTube videos
  - talks and demos
- Research papers
  - the primary record`,
  },
  {
    id: "ref-image-quote",
    group: "specialised",
    name: "Image + quote",
    explicit: "{layout=image-quote}",
    shorthand: "{image-quote}",
    blurb: "Image beside the quotation with the attribution as a full-width accent bar — the classic PPT photo/tweet + quote slide. Title nav-only by default.",
    markdown: `### What they said {image-quote id=ref-image-quote}

![A diagram standing in for a portrait](assets/two-box.svg "The speaker")

> The model is no longer the product — the loop around it is.

— Dominik Lukeš, 2026`,
  },
  {
    id: "ref-image-grid",
    group: "specialised",
    name: "Image grid (annotated)",
    explicit: "{layout=image-grid}",
    shorthand: "{image-grid}",
    blurb: "A STATIC annotated grid: #### cards (image + note) or bare captioned images become figure cells, ALL visible at once (stepped galleries stay {cards}).",
    markdown: `### Tools we tried {image-grid id=ref-image-grid}

#### ChatGPT
![ChatGPT](assets/two-box.svg)
General-purpose assistant.

#### Claude
![Claude](assets/two-box.svg)
- Strong with long documents

#### NotebookLM
![NotebookLM](assets/two-box.svg)
Grounded in your sources.`,
  },

  // ───────────────────────────────── MODES ──────────────────────────────────
  {
    id: "ref-reveal",
    group: "modes",
    name: "Reveal mode",
    explicit: "{mode=reveal}",
    shorthand: "{reveal}",
    blurb: "Start hidden; each → reveals the next unit (earlier ones softened). Sub-bullets are their own units — a parent appears, then its indented points one at a time, with the parent staying readable.",
    markdown: `### Built up one point at a time {reveal id=ref-reveal}

- First this lands on its own
  - with a sub-point that steps in next
  - and another after it
- Then this joins it
- Then this completes the picture`,
  },
  {
    id: "ref-group",
    group: "modes",
    name: "Group reveal",
    explicit: "{revealgroup}",
    shorthand: "{group}",
    blurb: "Reveal a whole list as ONE beat — every bullet appears together on a single →, instead of one at a time. Use it for points that belong together, or to reveal one side of a side-by-side at once. v1 applies to the slide's list.",
    markdown: `### These belong together {reveal group id=ref-group}

- All three of these
- appear on the same step
- the moment you advance`,
  },
  {
    id: "ref-focus",
    group: "modes",
    name: "Focus mode",
    explicit: "{mode=focus}",
    shorthand: "{focus}",
    blurb: "Start all visible-but-fuzzy; each → sharpens the next unit.",
    markdown: `### Everything's there — attention moves {focus id=ref-focus}

- The whole list is visible from the start
- But only one item is sharp at a time
- The rest stay softly blurred until you reach them`,
  },
  {
    id: "ref-trigger-line",
    group: "modes",
    name: "Trigger line (ADR-0015)",
    explicit: "{layout=contrast} on the line after the heading",
    shorthand: "{contrast} on the line after the heading",
    blurb: "Any Trigger may sit on the FIRST line under the heading instead of on it — headings stay clean for outline sidebars. Same vocabulary; on a same-key clash the Trigger line wins. Third level: frontmatter `triggers:` sets deck-wide defaults (layout/id barred there). Precedence: trigger line > heading > frontmatter.",
    markdown: `### Keep codes off the heading
{contrast id=ref-trigger-line}

#### On the heading
- \`### Title {statement}\` works as always
- But codes clutter the Obsidian sidebar

#### On the Trigger line
- A line of only \`{…}\` groups right under the heading
- Same words, same effect — title stays clean`,
  },
  // ──────────────────────── LAYOUT BATCH 2 (2026-06-12) ────────────────────────
  {
    id: "ref-chart-bar",
    group: "specialised",
    name: "Bar chart",
    explicit: "{layout=chart}",
    shorthand: "{chart} (or {barchart})",
    blurb: "Vertical columns from an outline: a numeric item with its label as the first child, or `label · 30`. Heights scale to the max at build time; columns step one by one.",
    markdown: `### Decks built per quarter {chart id=ref-chart-bar}

- 12
  - Q1
- 19
  - Q2
- 31
  - Q3
- 48
  - Q4`,
  },
  {
    id: "ref-chart-pie",
    group: "specialised",
    name: "Pie chart",
    explicit: "{chart=pie}",
    shorthand: "{piechart}",
    blurb: "Build-time SVG slices from percentage shares + a legend (label · value · %). Slice colours cycle the multicolour diagram palette. One composition — no stepping.",
    markdown: `### Where the time goes {piechart id=ref-chart-pie}

- Writing the outline · 50
- Checking the render · 30
- Final polish · 20`,
  },
  {
    id: "ref-chart-line",
    group: "specialised",
    name: "Line chart",
    explicit: "{chart=line}",
    shorthand: "{linechart} (or {curve})",
    blurb: "Build-time SVG polyline + dots; values above the dots, x labels under the baseline. When both sides of `·` are numeric (`2023 · 90`), left is the label, right the value.",
    markdown: `### Rebuild time kept falling {curve id=ref-chart-line}

- 2023 · 90
- 2024 · 40
- 2025 · 8`,
  },
  {
    id: "ref-sigmoid",
    group: "specialised",
    name: "S-curve (sigmoid)",
    explicit: "{layout=sigmoid}",
    shorthand: "{sigmoid} (or {curve=sigmoid})",
    blurb: "A CONCEPTUAL S-curve — not a data plot. Each item is placed ON the curve at a named stage (early / rising / inflection / mature / plateau) or a 0–100 percent, written before a `:` or dash. Items with no position auto-space along the curve in order.",
    markdown: `### Adoption follows an S-curve {sigmoid id=ref-sigmoid}

- early: innovators
- inflection: the tipping point
- plateau: saturation`,
  },
  {
    id: "ref-timetable",
    group: "specialised",
    name: "Timetable (day schedule)",
    explicit: "{layout=timetable}",
    shorthand: "{timetable}",
    blurb: "A day schedule: each item is `time · event`. Break rows are tinted + italicised — mark one with a leading `~` or a break word (break / lunch / coffee / tea / recess). In the presenter view each timed row arms a reminder at its wall-clock time, so the schedule paces you.",
    markdown: `### Plan for the day {timetable id=ref-timetable}

- 09:00 · Welcome
- 10:30 · Coffee break
- 11:00 · Hands-on lab
- 12:30 · Lunch`,
  },
  {
    id: "ref-table",
    group: "specialised",
    name: "Table from outline",
    explicit: "{layout=table}",
    shorthand: "{table}",
    blurb: "Depth-0 items are the column HEADERS; each item's children are that column's cells (transposed at build time, short columns pad blank). All-numeric columns right-align. Markdown pipe tables still work as before.",
    markdown: `### Format at a glance {table id=ref-table}

- Layer
  - Outline
  - Compiler
- You edit it?
  - yes
  - no
- Lines
  - 200
  - 15000`,
  },
  {
    id: "ref-cycle",
    group: "diagrams",
    name: "Cycle",
    explicit: "{layout=cycle}",
    shorthand: "{cycle}",
    blurb: "Circular arrow flow: stages sit on an ellipse joined by accent arc arrows closing the loop. A first child becomes the node's small caption. Stages step clockwise; arrows are chrome.",
    markdown: `### The authoring loop {cycle id=ref-cycle}

- Outline
  - write in markdown
- Build
  - seconds, deterministic
- Present
- Refine`,
  },
  {
    id: "ref-equation",
    group: "diagrams",
    name: "Equation",
    explicit: "{layout=equation}",
    shorthand: "{equation}",
    blurb: "The converging relationship: items combine A + B → C, the LAST item is the result (solid accent disc). One composition — it reads as a single statement.",
    markdown: `### What makes a presentation {equation id=ref-equation}

- One markdown outline
- A deterministic compiler
- A browser-native talk`,
  },
  {
    id: "ref-countdown",
    group: "modes",
    name: "Countdown (element)",
    explicit: "{countdown=90s} / {countdown=3min countdown-style=bar}",
    shorthand: "{countdown-digits-90s} / {countdown-bar-3min}",
    blurb: "A per-slide timer ELEMENT composable with any layout: quiet mm:ss bottom-right (digits) or a shrinking bottom bar. Arms when the slide activates in the live deck; re-arrival resets; never auto-advances; final 10s turns crimson, 0:00 flashes gently and stays. Handouts/print never show it. Durations: 30s, 90, 3min, 1:30.",
    markdown: `### Try it in ninety seconds {countdown-digits-90s id=ref-countdown}

- Open the sampler
- Pick one layout
- Copy its source`,
  },
];

/** Group order + display labels for the deck. */
export const groups = [
  { key: "everyday", label: "Everyday", blurb: "The handful you reach for in almost every deck." },
  { key: "structural", label: "Structural", blurb: "Bookends, dividers, and shape for the whole talk." },
  { key: "specialised", label: "Specialised", blurb: "Diagrams, transcripts, code, and interactive bits." },
  { key: "diagrams", label: "Diagrams", blurb: "List-and-shape layouts: columns, SmartArt variants, concept maps." },
  { key: "modes", label: "Modes", blurb: "Stepping behaviour layered on any slide." },
];
