// Single layout registry for every authoring surface and compiler trigger.
//
// PARITY TARGETS:
// - compiler/scripts/triggers.mjs is the live compiler resolver for bare-word triggers.
// - docs/layout-sampler-outline.md must mention every registry entry name.
// - scripts/test-layout-registry-parity.mjs enforces both directions.
//
// ADR-0006 keeps layout knowledge here: pickers and autocomplete consume this registry instead of
// maintaining private vocabularies. Entries are never deleted just because rendering is uncertain;
// use status: "unverified" until coverage catches up.

export type LayoutCategory = 'everyday' | 'structural' | 'specialised' | 'diagrams' | 'modes'
export type LayoutKind = 'layout' | 'component' | 'modifier' | 'container'
export type LayoutStatus = 'stable' | 'unverified' | 'experimental'

export interface OptionValue {
  token: string
  label: string
  description?: string
  /** Colour options render a dot in this hex beside the label (ADR-0005 palette names). */
  swatch?: string
}

export interface OptionGroup {
  key: string
  label: string
  values: OptionValue[]
  preview?: 'thumbs' | 'segmented'
  /** Accepted value-form triggers that intentionally do not create duplicate UI choices. */
  dictionaryTokens?: string[]
}

export interface LayoutDef {
  name: string
  label: string
  trigger: string
  aliases: string[]
  triggerWords: string[]
  kind: LayoutKind
  status: LayoutStatus
  sample: string
  description: string
  category: LayoutCategory
  cssModule?: string
  sectionOnly?: true
  resolvesTo?: { key: string; value: string | boolean }
  dynamicPatterns?: DynamicPattern[]
  options?: OptionGroup[]
}

export interface DynamicPattern {
  source: string
  resolution: Array<{ key: string; value: string }>
}

export const systemTokens = ['id', 'tags', 'from', 'clonedFrom'] as const

// ADR-0011: every choosing surface consumes these values and writes their exact tokens.
export const GLOBAL_OPTION_GROUPS: OptionGroup[] = [
  {
    key: 'background',
    label: 'Background',
    preview: 'segmented',
    values: [
      { token: '', label: 'Auto', description: 'Use the normal paper background' },
      { token: 'bg=cobalt', label: 'Cobalt', swatch: '#e8eefc' },
      { token: 'bg=emerald', label: 'Emerald', swatch: '#e4f3ee' },
      { token: 'bg=vermilion', label: 'Vermilion', swatch: '#fcece3' },
      { token: 'bg=forest', label: 'Forest', swatch: '#e4f3ee' }
    ]
  },
  {
    key: 'container-mode',
    label: 'Container mode',
    preview: 'segmented',
    values: [
      { token: '', label: 'Linear', description: 'Show child slides in outline order' },
      { token: 'carousel', label: 'Carousel', description: 'Step through child slides one at a time' },
      { token: 'contents', label: 'Contents', description: 'Show child slides as a contents rail' },
      { token: 'grid-linear', label: 'Grid linear', description: 'Show the child grid and step through it in order' },
      { token: 'grid-zoom', label: 'Grid zoom', description: 'Show the child grid and zoom into each child' }
    ]
  },
  {
    key: 'title-placement',
    label: 'Title placement',
    preview: 'segmented',
    values: [
      { token: '', label: 'Auto', description: "Use the layout's own title placement" },
      { token: 'titletop', label: 'Top', description: 'Force the top-title treatment' },
      { token: 'notitle', label: 'Hidden', description: 'Hide the on-slide title while keeping navigation text' },
      { token: 'sidebar', label: 'Sidebar', description: 'Solid tint title panel' },
      { token: 'split=30', label: '30', description: 'Put the title in a 30% left rail' },
      { token: 'split=35', label: '35', description: 'Put the title in a 35% left rail' },
      { token: 'split=40', label: '40', description: 'Put the title in a 40% left rail' },
      { token: 'split=50', label: '50', description: 'Put the title in a 50% left rail' }
    ]
  },
  {
    key: 'title-display',
    label: 'Title display',
    preview: 'segmented',
    values: [
      { token: '', label: 'Layout default', description: 'Use the layout’s normal title treatment' },
      { token: 'title=show', label: 'Show', description: 'Restore a full visible heading on title-quiet layouts' },
      { token: 'title=compact', label: 'Compact', description: 'Use the compact heading treatment' }
    ]
  },
  {
    key: 'media-placement',
    label: 'Media placement',
    preview: 'segmented',
    dictionaryTokens: ['media=left', 'media=right'],
    values: [
      { token: '', label: 'Auto', description: 'Use the frame or layout default' },
      { token: 'image=left', label: 'Left', description: 'Place the media slot left of the copy' },
      { token: 'image=right', label: 'Right', description: 'Place the media slot right of the copy' }
    ]
  },
  {
    key: 'arrival-mode',
    label: 'Arrival mode',
    preview: 'segmented',
    dictionaryTokens: ['mode=reveal', 'mode=focus', 'reveal=steps'],
    values: [
      { token: '', label: 'None' },
      { token: 'reveal', label: 'Reveal', description: 'Reveal content one beat at a time' },
      { token: 'focus', label: 'Focus', description: 'Focus each beat, dimming the rest' },
      { token: 'group', label: 'Group', description: 'Reveal a list as one beat' }
    ]
  },
  {
    key: 'stepping',
    label: 'Stepping',
    preview: 'segmented',
    values: [
      { token: '', label: 'Auto' },
      { token: 'nostep', label: 'Nostep', description: 'Disable stepping on this slide' }
    ]
  },
  {
    key: 'font-body',
    label: 'Body size',
    preview: 'segmented',
    values: [
      { token: 'font-body=xs', label: 'XS' },
      { token: 'font-body=s', label: 'S' },
      { token: '', label: 'M' },
      { token: 'font-body=l', label: 'L' },
      { token: 'font-body=xl', label: 'XL' }
    ]
  },
  {
    key: 'font-title',
    label: 'Title size',
    preview: 'segmented',
    values: [
      { token: 'font-title=xs', label: 'XS' },
      { token: 'font-title=s', label: 'S' },
      { token: '', label: 'M' },
      { token: 'font-title=l', label: 'L' },
      { token: 'font-title=xl', label: 'XL' }
    ]
  }
]

export const LAYOUTS: LayoutDef[] = [
  // -- Everyday ---------------------------------------------------------------
  {
    name: 'statement',
    label: 'Statement',
    trigger: '{statement}',
    aliases: [],
    triggerWords: ['statement'],
    kind: 'layout',
    status: 'stable',
    sample: `### One sentence that lands
{statement}

The registry is the product contract.`,
    description: 'Single bold claim beside the title',
    category: 'everyday',
    cssModule: 'statement',
    options: [{
      key: 'statement-variant',
      label: 'Statement treatment',
      preview: 'thumbs',
      dictionaryTokens: ['statement=default'],
      values: [
        { token: '', label: 'Default', description: 'Use the current statement treatment' },
        { token: 'statement=tint', label: 'Tint', description: 'Tint panel with an accent left bar' },
        { token: 'statement=poster', label: 'Poster', description: 'Oversized centred claim with boxed emphasis' }
      ]
    }]
  },
  {
    name: 'list',
    label: 'List',
    trigger: '{list}',
    aliases: [],
    triggerWords: ['list'],
    kind: 'layout',
    status: 'stable',
    sample: `### Plain list
{list}

- First point
- Second point
- Third point`,
    description: 'Plain bullet list; the default content layout',
    category: 'everyday',
    cssModule: 'list',
    options: [{
      key: 'list-style',
      label: 'List style',
      preview: 'segmented',
      values: [
        { token: '', label: 'Plain', description: 'Plain bullet list' },
        { token: 'iconlist', label: 'Icons', description: 'Semantic icon bullets' },
        { token: 'logolist', label: 'Logos', description: 'Use brand-logo bullets where mappings exist' },
        { token: 'numbered', label: 'Numbered', description: 'Numbered discs' },
        { token: 'annotated', label: 'Annotated', description: 'Nested children become right-hand annotations' }
      ]
    }]
  },
  {
    name: 'iconlist',
    label: 'Icon list',
    trigger: '{iconlist}',
    aliases: ['icons'],
    triggerWords: ['iconlist','icons'],
    kind: 'modifier',
    resolvesTo: { key: 'liststyle', value: 'icons' },
    status: 'stable',
    sample: `### Icon list
{iconlist}

- Speed {icon=lucide:zap}
- Judgement {icon=lucide:brain}
- Craft {icon=lucide:wrench}`,
    description: 'List styling flag: semantic icon bullets',
    category: 'everyday',
    cssModule: 'list',
    options: [{
      key: 'iconlist-variant',
      label: 'Icon list treatment',
      preview: 'thumbs',
      dictionaryTokens: ['iconlist=boxes'],
      values: [
        { token: '', label: 'Boxes', description: 'Hairline card grid with icons and mono numbers' },
        { token: 'iconlist=list', label: 'List', description: 'Plain icon rows without card chrome or numbers' }
      ]
    }]
  },
  {
    name: 'numbered',
    label: 'Numbered list',
    trigger: '{numbered}',
    aliases: [],
    triggerWords: ['numbered'],
    kind: 'modifier',
    resolvesTo: { key: 'liststyle', value: 'numbers' },
    status: 'stable',
    sample: `### Numbered list
{numbered}

- Plan
- Build
- Verify`,
    description: 'List styling flag: numbered discs',
    category: 'everyday',
    cssModule: 'list'
  },
  {
    name: 'quote',
    label: 'Quote',
    trigger: '{quote}',
    aliases: [],
    triggerWords: ['quote'],
    kind: 'layout',
    status: 'stable',
    sample: `### Quote
{quote}

> Capability is not the same as judgement.

- Source`,
    description: 'Full-bleed pull quote; no title by default',
    category: 'everyday',
    cssModule: 'quote'
  },
  {
    name: 'contrast-cards',
    label: 'Contrast panels',
    trigger: '{contrast=cards}',
    aliases: [],
    triggerWords: [],
    kind: 'layout',
    status: 'stable',
    sample: `### Contrast panels
{contrast=cards}

#### Before

- Manual slides

#### After

- Living layouts`,
    description: 'Rich side-by-side comparison panels',
    category: 'everyday',
    cssModule: 'contrast'
  },
  {
    name: 'annotated',
    label: 'Annotated list',
    trigger: '{annotated}',
    aliases: [],
    triggerWords: ['annotated'],
    kind: 'modifier',
    resolvesTo: { key: 'sublist', value: 'aside' },
    status: 'stable',
    sample: `### Annotated list
{annotated}

- Registry
  - one source of truth
- Sampler
  - the contract`,
    description: 'List modifier: nested children become right-hand annotations',
    category: 'everyday',
    cssModule: 'list'
  },
  {
    name: 'sidebar',
    label: 'Sidebar title',
    trigger: '{sidebar}',
    aliases: ['title=side'],
    triggerWords: ['sidebar'],
    kind: 'modifier',
    resolvesTo: { key: 'title', value: 'side' },
    status: 'stable',
    sample: `### Sidebar title
{sidebar}

- The title sits in a left rail
- Content flows beside it`,
    description: 'Title placement modifier: title in a plain left rail',
    category: 'everyday',
    cssModule: 'statement'
  },
  {
    name: 'media',
    label: 'Image',
    trigger: '{media}',
    aliases: [],
    triggerWords: ['media'],
    kind: 'layout',
    status: 'stable',
    sample: `### Image
{media}

![](assets/sample-image.png)`,
    description: 'Full-bleed image, video or embed with title on top',
    category: 'everyday',
    cssModule: 'media'
  },
  {
    name: 'contrast',
    label: 'Contrast',
    trigger: '{contrast}',
    aliases: [],
    triggerWords: ['contrast'],
    kind: 'layout',
    status: 'stable',
    sample: `### Contrast
{contrast}

- Manual / Automated
- Slow / Fast

### Contrast rows
{contrast=rows}

- Manual / Automated
- Slow / Fast`,
    description: 'Two-column comparison; opt-in variants: ledger, rows, tint and flip',
    category: 'everyday',
    cssModule: 'contrast',
    options: [{
      key: 'variant',
      label: 'Variant',
      preview: 'thumbs',
      values: [
        { token: '', label: 'Default', description: 'Opposing ledger rows, accent tick' },
        { token: 'contrast=ledger', label: 'Ledger', description: 'Struck negative, ink positive' },
        { token: 'contrast=rows', label: 'Rows', description: 'Muted → ink typographic arrows' },
        { token: 'contrast=tint', label: 'Tint', description: 'Plain old, tinted-panel new' },
        { token: 'contrast=flip', label: 'Flip', description: 'Carded old-above-new grid' }
      ]
    }]
  },
  {
    name: 'compare',
    label: 'Compare',
    trigger: '{compare}',
    aliases: [],
    triggerWords: ['compare'],
    kind: 'layout',
    status: 'stable',
    sample: `### What LLMs can and cannot do
{compare}

#### What LLMs can do for you

Be a **ramp** to higher learning.

#### What LLMs cannot do for you

The learning.`,
    description: '50/50 comparison — two halves (tint vs paper), title hidden, second half reveals',
    category: 'everyday',
    cssModule: 'contrast'
  },
  {
    name: 'copy-visual',
    label: 'Copy + visual',
    trigger: '{copy-visual}',
    aliases: [],
    triggerWords: ['copy-visual'],
    kind: 'layout',
    status: 'stable',
    sample: `### Copy and visual
{copy-visual}

![](assets/sample-image.png)

Text sits beside a single visual.`,
    description: 'Text and a single visual side by side',
    category: 'everyday',
    cssModule: 'media'
  },
  {
    name: 'cards',
    label: 'Cards',
    trigger: '{cards}',
    aliases: [],
    triggerWords: ['cards'],
    kind: 'layout',
    status: 'stable',
    sample: `### Cards
{cards}

- Oracle
- Tool maker
- Tool user

### Cards as label rows {cards=rows}

#### AI as Oracle

- Capabilities: answer questions, summarise
- Chatbots: ChatGPT, Gemini, Claude

#### AI as Tool Maker

- Capabilities: write code, manage a code base
- Tools: Cursor, Lovable, Google AI Studio`,
    description: 'Static grid of equal-weight cards; {cards=grid} pins #### groups to the grid, {cards=rows} lays them as full-width label rows (Label: value lines become label groups)',
    category: 'everyday',
    cssModule: 'cards',
    options: [{
      key: 'form',
      label: 'Form',
      preview: 'thumbs',
      values: [
        { token: '', label: 'Adaptive', description: 'Static grid of equal-weight cards' },
        { token: 'cards=grid', label: 'Grid', description: 'Pin heading groups to the grid' },
        { token: 'cards=rows', label: 'Rows', description: 'Lay groups out as full-width label rows' },
        { token: 'cards=stepped', label: 'Stepped', description: 'Step through the cards in sequence' }
      ]
    }]
  },
  {
    name: 'carousel',
    label: 'Carousel',
    trigger: '{carousel}',
    aliases: [],
    triggerWords: ['carousel'],
    kind: 'container',
    sectionOnly: true,
    status: 'stable',
    sample: `### Carousel
{carousel}

First thought.

Second thought.`,
    description: 'Step through full sub-slides one at a time',
    category: 'everyday',
    cssModule: 'carousel'
  },

  // -- Structural -------------------------------------------------------------
  {
    name: 'title',
    label: 'Title',
    trigger: '{title}',
    aliases: [],
    triggerWords: ['title'],
    kind: 'layout',
    status: 'stable',
    sample: `### Understanding agents
{title}

AICC Workshop 2026`,
    description: 'Opening title slide',
    category: 'structural',
    cssModule: 'title'
  },
  {
    name: 'section',
    label: 'Section divider',
    trigger: '{role=section-title}',
    aliases: [],
    triggerWords: [],
    kind: 'layout',
    status: 'stable',
    sample: `## Section divider

### Child slide

- Content makes the parent a section.`,
    description: 'Divider between major parts of the talk',
    category: 'structural',
    cssModule: 'title'
  },
  {
    name: 'subsection',
    label: 'Subsection divider',
    trigger: '{sub}',
    aliases: ['sub'],
    triggerWords: ['sub'],
    kind: 'layout',
    resolvesTo: { key: 'sub', value: true },
    status: 'stable',
    sample: `## Main section

### Subsection divider
{sub}

#### Child slide

- Content makes the parent a subsection.`,
    description: 'Divider under the current section',
    category: 'structural',
    cssModule: 'title'
  },
  {
    name: 'closing',
    label: 'Closing',
    trigger: '{closing}',
    aliases: [],
    triggerWords: ['closing'],
    kind: 'layout',
    status: 'stable',
    sample: `### Thank you
{closing}

**Thank you**

yoursite.example`,
    description: 'Closing or thanks slide',
    category: 'structural',
    cssModule: 'title'
  },
  {
    name: 'timeline',
    label: 'Timeline',
    trigger: '{timeline}',
    aliases: [],
    triggerWords: ['timeline'],
    kind: 'layout',
    status: 'stable',
    sample: `### Timeline
{timeline}

- 2022
  - Launch
- 2026
  - Agents`,
    description: 'Dated chronology rail',
    category: 'structural',
    cssModule: 'timeline'
  },
  {
    name: 'timelinevertical',
    label: 'Timeline - vertical',
    trigger: '{timelinevertical}',
    aliases: [],
    triggerWords: ['timelinevertical'],
    kind: 'layout',
    resolvesTo: { key: 'timeline', value: 'vertical' },
    status: 'stable',
    sample: `### Timeline vertical
{timelinevertical}

- 2022
  - Launch
- 2026
  - Agents`,
    description: 'Chronology laid out top-to-bottom',
    category: 'structural',
    cssModule: 'timeline'
  },
  {
    name: 'timelinehorizontal',
    label: 'Timeline - horizontal',
    trigger: '{timelinehorizontal}',
    aliases: [],
    triggerWords: ['timelinehorizontal'],
    kind: 'layout',
    resolvesTo: { key: 'timeline', value: 'horizontal' },
    status: 'stable',
    sample: `### Timeline horizontal
{timelinehorizontal}

- 2022
  - Launch
- 2026
  - Agents`,
    description: 'Chronology laid out left-to-right',
    category: 'structural',
    cssModule: 'timeline'
  },
  {
    name: 'timelinespine',
    label: 'Timeline - spine',
    trigger: '{timelinespine}',
    aliases: [],
    triggerWords: ['timelinespine'],
    kind: 'layout',
    resolvesTo: { key: 'timeline', value: 'spine' },
    status: 'stable',
    sample: `### Timeline spine
{timelinespine}

- 2022
  - Launch
- 2026
  - Agents`,
    description: 'Chronology as a labelled central spine',
    category: 'structural',
    cssModule: 'timeline'
  },
  {
    name: 'timeline-pills',
    label: 'Timeline - pills',
    trigger: '{timeline-pills}',
    aliases: ['timelinepills'],
    triggerWords: ['timeline-pills','timelinepills'],
    kind: 'layout',
    resolvesTo: { key: 'timeline', value: 'pills' },
    status: 'stable',
    sample: `### Timeline pills
{timeline-pills}

- 2022
- 2024
- 2026`,
    description: 'Chronology as a row of pill stops',
    category: 'structural',
    cssModule: 'timeline'
  },
  {
    name: 'grid',
    label: 'Grid',
    trigger: '{grid}',
    aliases: [],
    triggerWords: ['grid'],
    kind: 'layout',
    status: 'stable',
    sample: `### Grid
{grid}{blocks:2x2}

- One
- Two
- Three
- Four`,
    description: 'Tiled grid of blocks',
    category: 'structural',
    cssModule: 'cards'
  },
  {
    name: 'system-map',
    label: 'System map',
    trigger: '{system-map}',
    aliases: [],
    triggerWords: ['system-map'],
    kind: 'layout',
    status: 'stable',
    sample: `### System map
{system-map}

- TalkWeaver
  - Compiler
  - Editor
  - Runtime`,
    description: 'Central node with satellites and connector rails',
    category: 'structural',
    cssModule: 'diagrams',
    options: [{
      key: 'palette',
      label: 'Palette',
      preview: 'segmented',
      values: [
        { token: '', label: 'Accent', description: 'Use the accent palette' },
        { token: 'multicolour', label: 'Multicolour', description: 'Use a varied palette for diagram nodes' }
      ]
    }]
  },

  // -- Specialised ------------------------------------------------------------
  {
    name: 'smartart',
    label: 'SmartArt',
    trigger: '{smartart}',
    aliases: [],
    triggerWords: ['smartart'],
    kind: 'layout',
    status: 'stable',
    sample: `### SmartArt
{smartart}

- Cognition
  - Judgement
- Tools
  - Retrieval`,
    description: 'SmartArt-style node diagram from a nested list',
    category: 'specialised',
    cssModule: 'diagrams'
  },
  {
    name: 'flow',
    label: 'Flow diagram',
    trigger: '{flow}',
    aliases: [],
    triggerWords: ['flow'],
    kind: 'layout',
    status: 'stable',
    sample: `### Flow
{flow}

- Outline
- Compile
- Present`,
    description: 'Left-to-right flow diagram from a list',
    category: 'specialised',
    cssModule: 'diagrams',
    options: [{
      key: 'direction',
      label: 'Direction',
      preview: 'segmented',
      values: [
        { token: '', label: 'Horizontal', description: 'Default left-to-right flow' },
        { token: 'flow=horizontal', label: 'Horizontal', description: 'Lay nodes out left to right' },
        { token: 'flow=vertical', label: 'Vertical', description: 'Lay nodes out top to bottom' },
        { token: 'flow=loop', label: 'Loop', description: 'Connect the last node back to the first' },
        { token: 'flow=branch', label: 'Branch', description: 'Show a branching flow' }
      ]
    }]
  },
  {
    name: 'image-claim',
    label: 'Image + claim',
    trigger: '{image-claim}',
    aliases: [],
    triggerWords: ['image-claim'],
    kind: 'layout',
    status: 'stable',
    sample: `### Image and claim
{image-claim}

![](assets/sample-image.png)

- The visual carries the moment
- Claims annotate it`,
    description: 'Image with a callout list of claims beside it',
    category: 'specialised',
    cssModule: 'media'
  },
  {
    name: 'cta-screenshots',
    label: 'CTA + screenshots',
    trigger: '{cta-screenshots}',
    aliases: [],
    triggerWords: ['cta-screenshots'],
    kind: 'layout',
    status: 'stable',
    sample: `### CTA screenshots
{cta-screenshots}

![](assets/sample-image.png)

- Try it today
- [Action: Get started -> https://example.com]`,
    description: 'Screenshot strip beside callouts and action items',
    category: 'specialised',
    cssModule: 'media'
  },
  {
    name: 'trace',
    label: 'Trace (transcript)',
    trigger: '{trace}',
    aliases: [],
    triggerWords: ['trace'],
    kind: 'layout',
    status: 'stable',
    sample: `### Trace
{trace}

- User: What is a layout?
- Agent: A named slide geometry.`,
    description: 'Role-tagged transcript of a turn-taking exchange',
    category: 'specialised',
    cssModule: 'trace'
  },
  {
    name: 'trace-dialogue',
    label: 'Trace (any dialogue)',
    trigger: '{trace}',
    aliases: [],
    triggerWords: ['trace'],
    kind: 'layout',
    resolvesTo: { key: 'layout', value: 'trace' },
    status: 'stable',
    sample: `### trace-dialogue
{trace}

Speaker: Plain dialogue works too.
Listener: It is still a trace.`,
    description: 'Any speaker-labelled dialogue rendered as a trace',
    category: 'specialised',
    cssModule: 'trace'
  },
  {
    name: 'code',
    label: 'Code',
    trigger: '{code}',
    aliases: [],
    triggerWords: ['code'],
    kind: 'component',
    resolvesTo: { key: 'layout', value: 'code' },
    status: 'stable',
    sample: `### Code
{code}

\`\`\`python
def greet():
    return "hello"
\`\`\``,
    description: 'Build-time syntax-highlighted code panel',
    category: 'specialised',
    cssModule: 'trace'
  },
  {
    name: 'table',
    label: 'Table',
    trigger: '{table}',
    aliases: [],
    triggerWords: ['table'],
    kind: 'layout',
    status: 'stable',
    sample: `### Table
{table}

- Role
  - Oracle
  - Tool user
- Where
  - ChatGPT
  - Codex`,
    description: 'Nested list rendered as a table',
    category: 'specialised',
    cssModule: 'table'
  },
  {
    name: 'qr',
    label: 'QR code',
    trigger: '[QR: https://example.com | Label]',
    aliases: [],
    triggerWords: [],
    kind: 'component',
    status: 'stable',
    sample: `### QR code

[QR: https://example.com | Label]`,
    description: 'Build-time QR code element',
    category: 'specialised',
    cssModule: 'media'
  },
  {
    name: 'action',
    label: 'Action button',
    trigger: '[Action: Label -> https://example.com]',
    aliases: [],
    triggerWords: [],
    kind: 'component',
    status: 'stable',
    sample: `### Action button

[Action: Label -> https://example.com]`,
    description: 'Accent action button element',
    category: 'specialised'
  },
  {
    name: 'embed',
    label: 'Embed / simulation',
    trigger: '[Embed: https://example.com]',
    aliases: [],
    triggerWords: [],
    kind: 'component',
    status: 'stable',
    sample: `### Embed

[Embed: https://example.com]`,
    description: 'Embedded iframe or live simulation element',
    category: 'specialised'
  },
  {
    name: 'auto-embed',
    label: 'Auto-embed (bare URL)',
    trigger: 'https://example.com',
    aliases: [],
    triggerWords: [],
    kind: 'component',
    status: 'stable',
    sample: `### Auto-embed

https://example.com`,
    description: 'A bare URL on its own line auto-embeds',
    category: 'specialised'
  },
  {
    name: 'logolist',
    label: 'Logo list',
    trigger: '{logolist}',
    aliases: ['logos'],
    triggerWords: ['logolist','logos'],
    kind: 'modifier',
    resolvesTo: { key: 'liststyle', value: 'logos' },
    status: 'stable',
    sample: `### Logo list
{logolist}

- OpenAI
- Anthropic
- Google`,
    description: 'List styling flag: brand logos only',
    category: 'specialised'
  },
  {
    name: 'image-quote',
    label: 'Image + quote',
    trigger: '{image-quote}',
    aliases: ['imagequote'],
    triggerWords: ['image-quote','imagequote'],
    kind: 'layout',
    status: 'stable',
    sample: `### Image quote
{image-quote}

![](assets/sample-image.png)

> Practical tools for daily use.

- Source`,
    description: 'Quote beside an image with an accent attribution bar',
    category: 'specialised',
    cssModule: 'media'
  },
  {
    name: 'image-grid',
    label: 'Image grid',
    trigger: '{image-grid}',
    aliases: ['imagegrid'],
    triggerWords: ['image-grid','imagegrid'],
    kind: 'layout',
    status: 'stable',
    sample: `### Image grid
{image-grid}

![First](assets/sample-image.png)

![Second](assets/sample-image.png)`,
    description: 'Figure cells with a caption under each',
    category: 'specialised',
    cssModule: 'media'
  },
  {
    name: 'chart',
    label: 'Chart',
    trigger: '{chart}',
    aliases: [],
    triggerWords: ['chart'],
    kind: 'layout',
    status: 'stable',
    sample: `### Chart
{chart}

- Alpha: 40
- Beta: 25
- Gamma: 35`,
    description: 'Generic chart container; bar chart by default',
    category: 'specialised',
    cssModule: 'charts',
    options: [{
      key: 'values',
      label: 'Values',
      preview: 'segmented',
      values: [
        { token: '', label: 'Shown' },
        { token: 'novalues', label: 'Hidden', description: 'Hide chart value labels; keep relative shape' }
      ]
    }]
  },
  {
    name: 'barchart',
    label: 'Bar chart',
    trigger: '{barchart}',
    aliases: [],
    triggerWords: ['barchart'],
    kind: 'layout',
    resolvesTo: { key: 'chart', value: 'bar' },
    status: 'stable',
    sample: `### Bar chart
{barchart}

- Alpha: 40
- Beta: 25
- Gamma: 35`,
    description: 'Bar chart from a value list',
    category: 'specialised',
    cssModule: 'charts'
  },
  {
    name: 'piechart',
    label: 'Pie chart',
    trigger: '{piechart}',
    aliases: [],
    triggerWords: ['piechart'],
    kind: 'layout',
    resolvesTo: { key: 'chart', value: 'pie' },
    status: 'stable',
    sample: `### Pie chart
{piechart}

- Alpha: 40
- Beta: 25
- Gamma: 35`,
    description: 'Pie chart from a value list',
    category: 'specialised',
    cssModule: 'charts'
  },
  {
    name: 'linechart',
    label: 'Line chart',
    trigger: '{linechart}',
    aliases: ['curve'],
    triggerWords: ['linechart','curve'],
    kind: 'layout',
    resolvesTo: { key: 'chart', value: 'line' },
    status: 'stable',
    sample: `### Line chart
{linechart}

- 2022: 1
- 2024: 50
- 2026: 100`,
    description: 'Line chart from a value list',
    category: 'specialised',
    cssModule: 'charts'
  },
  {
    name: 'sigmoid',
    label: 'S-curve (sigmoid)',
    trigger: '{sigmoid}',
    aliases: [],
    triggerWords: ['sigmoid'],
    kind: 'layout',
    status: 'stable',
    sample: `### S-curve
{sigmoid}

- Early: 10
- Growth: 50
- Mature: 90`,
    description: 'Conceptual S-curve from staged items',
    category: 'specialised',
    cssModule: 'charts'
  },
  {
    name: 'timetable',
    label: 'Timetable',
    trigger: '{timetable}',
    aliases: [],
    triggerWords: ['timetable'],
    kind: 'layout',
    status: 'stable',
    sample: `### Timetable
{timetable}

- 09:00 - Welcome
- 10:30 - Break
- 11:00 - Workshop`,
    description: 'Day schedule rows with distinct break styling',
    category: 'specialised',
    cssModule: 'table'
  },
  {
    name: 'table-outline',
    label: 'Table from outline',
    trigger: '{table}',
    aliases: [],
    triggerWords: ['table'],
    kind: 'layout',
    resolvesTo: { key: 'layout', value: 'table' },
    status: 'stable',
    sample: `### table-outline
{table}

- Column A
  - One
  - Two
- Column B
  - Three
  - Four`,
    description: 'Depth-0 list items become column headers',
    category: 'specialised',
    cssModule: 'table'
  },
  {
    name: 'plainlist',
    label: 'Plain list',
    trigger: '{plainlist}',
    aliases: [],
    triggerWords: ['plainlist'],
    kind: 'modifier',
    resolvesTo: { key: 'liststyle', value: 'plain' },
    status: 'stable',
    sample: `### plainlist
{plainlist}

- Plain item
- Another plain item`,
    description: 'List styling flag: force a plain list',
    category: 'specialised',
    cssModule: 'media'
  },
  {
    name: 'stmt-list',
    label: 'Statement + list',
    trigger: '{stmt-list}',
    aliases: ['stmtlist'],
    triggerWords: ['stmt-list','stmtlist'],
    kind: 'layout',
    status: 'stable',
    sample: `### stmt-list
{stmt-list}

The claim sits beside the list.

- First point
- Second point`,
    description: 'Statement column beside a list column',
    category: 'specialised',
    cssModule: 'statement'
  },
  {
    name: 'links',
    label: 'Links index',
    trigger: '{links}',
    aliases: [],
    triggerWords: ['links'],
    kind: 'layout',
    status: 'stable',
    sample: `### links
{links}

[Example](https://example.com)`,
    description: 'Manual links index slide',
    category: 'specialised',
    cssModule: 'list'
  },

  // -- Diagrams ---------------------------------------------------------------
  {
    name: 'columns',
    label: 'Columns',
    trigger: '{columns}',
    aliases: [],
    triggerWords: ['columns'],
    kind: 'layout',
    status: 'stable',
    sample: `### Columns
{columns}

#### Left

- One
- Two

#### Right

- Three
- Four`,
    description: 'Top-level nodes in equal columns',
    category: 'diagrams',
    cssModule: 'columns'
  },
  {
    name: '2col',
    label: 'Two columns',
    trigger: '{2col}',
    aliases: [],
    triggerWords: ['2col'],
    kind: 'modifier',
    resolvesTo: { key: 'cols', value: '2' },
    status: 'stable',
    sample: `### 2col
{2col}

#### Left

- One

#### Right

- Two`,
    description: 'Column arity flag: two equal columns',
    category: 'diagrams',
    cssModule: 'statement'
  },
  {
    name: '3col',
    label: 'Three columns',
    trigger: '{3col}',
    aliases: [],
    triggerWords: ['3col'],
    kind: 'modifier',
    resolvesTo: { key: 'cols', value: '3' },
    status: 'stable',
    sample: `### 3col
{3col}

#### One

- A

#### Two

- B

#### Three

- C`,
    description: 'Column arity flag: three equal columns',
    category: 'diagrams'
  },
  {
    name: 'pyramid',
    label: 'Pyramid',
    trigger: '{pyramid}',
    aliases: [],
    triggerWords: ['pyramid'],
    kind: 'layout',
    status: 'stable',
    sample: `### Pyramid
{pyramid}

- Apex
- Middle
- Base`,
    description: 'Stacked tiers: narrow apex, widest base',
    category: 'diagrams',
    cssModule: 'diagrams'
  },
  {
    name: 'orgchart',
    label: 'Org chart',
    trigger: '{orgchart}',
    aliases: [],
    triggerWords: ['orgchart'],
    kind: 'layout',
    status: 'stable',
    sample: `### Org chart
{orgchart}

- Lead
  - Team A
  - Team B`,
    description: 'Top node with a child tree from a nested list',
    category: 'diagrams',
    cssModule: 'diagrams'
  },
  {
    name: 'mindmap',
    label: 'Mind map',
    trigger: '{mindmap}',
    aliases: [],
    triggerWords: ['mindmap'],
    kind: 'layout',
    status: 'stable',
    sample: `### Mind map
{mindmap}

- AI as oracle
  - Capabilities
  - Chatbots`,
    description: 'Central node with children radiating as branches',
    category: 'diagrams',
    cssModule: 'diagrams'
  },
  {
    name: 'conceptmap',
    label: 'Concept map',
    trigger: '{conceptmap}',
    aliases: [],
    triggerWords: ['conceptmap'],
    kind: 'layout',
    status: 'stable',
    sample: `### Concept map
{conceptmap}

- Model -powers- Agent
- Agent -uses- Tools`,
    description: 'Node-edge graph from relation lines',
    category: 'diagrams',
    cssModule: 'diagrams'
  },
  {
    name: 'stats',
    label: 'Stats',
    trigger: '{stats}',
    aliases: [],
    triggerWords: ['stats'],
    kind: 'layout',
    status: 'stable',
    sample: `### Stats
{stats}

- 1 billion: weekly users
- 5 days: to one million users`,
    description: 'Big-number row',
    category: 'diagrams',
    cssModule: 'stats'
  },
  {
    name: 'process',
    label: 'Process / agenda strip',
    trigger: '{process}',
    aliases: ['agenda'],
    triggerWords: ['process','agenda'],
    kind: 'layout',
    status: 'stable',
    sample: `### Process strip
{process}

- Discover
- Design
- Build`,
    description: 'Numbered-circle agenda strip on a connector line',
    category: 'diagrams',
    cssModule: 'diagrams'
  },
  {
    name: 'steps',
    label: 'Steps',
    trigger: '{steps}',
    aliases: ['stairs'],
    triggerWords: ['steps','stairs'],
    kind: 'layout',
    status: 'stable',
    sample: `### Steps
{steps}

- Crawl
- Walk
- Run`,
    description: 'Ascending staircase',
    category: 'diagrams',
    cssModule: 'diagrams'
  },
  {
    name: 'iconrow',
    label: 'Icon row',
    trigger: '{iconrow}',
    aliases: ['icon-row'],
    triggerWords: ['iconrow','icon-row'],
    kind: 'layout',
    status: 'stable',
    sample: `### Icon row
{iconrow}

- Model {icon=lucide:brain}
  - outputs tokens
- Orchestration {icon=lucide:computer}
  - runs them`,
    description: 'Horizontal icon, label and description row',
    category: 'diagrams',
    cssModule: 'icon-row'
  },
  {
    name: 'cycle',
    label: 'Cycle',
    trigger: '{cycle}',
    aliases: [],
    triggerWords: ['cycle'],
    kind: 'layout',
    status: 'stable',
    sample: `### Cycle
{cycle}

- Repetition
- Reflection`,
    description: 'Circular arrow flow',
    category: 'diagrams',
    cssModule: 'cycle'
  },
  {
    name: 'equation',
    label: 'Equation',
    trigger: '{equation=pills}',
    aliases: ['equation=circle', 'equation=square', 'equation=oval'],
    triggerWords: ['equation'],
    kind: 'layout',
    status: 'stable',
    sample: `### Equation
{equation=pills}

- Time
- Effort
- Learning`,
    description: 'Converging relationship: items combine into a result',
    category: 'diagrams',
    cssModule: 'equation',
    options: [{
      key: 'shape',
      label: 'Term shape',
      preview: 'thumbs',
      values: [
        { token: '', label: 'Pills', description: 'Use the default pill-shaped terms' },
        { token: 'equation=pills', label: 'Pills', description: 'Use pill-shaped terms' },
        { token: 'equation=circle', label: 'Circle', description: 'Use circular terms' },
        { token: 'equation=square', label: 'Square', description: 'Use square terms' },
        { token: 'equation=oval', label: 'Oval', description: 'Use oval terms' }
      ]
    }]
  },

  // -- Modes and modifiers ----------------------------------------------------
  {
    name: 'reveal',
    label: 'Reveal mode',
    trigger: '{reveal}',
    aliases: ['mode=reveal'],
    triggerWords: ['reveal'],
    kind: 'modifier',
    resolvesTo: { key: 'mode', value: 'reveal' },
    status: 'stable',
    sample: `### Reveal mode
{reveal}

- Beat one
- Beat two
- Beat three`,
    description: 'Step mode: reveal content one beat at a time',
    category: 'modes',
    cssModule: 'diagrams'
  },
  {
    name: 'group',
    label: 'Group reveal',
    trigger: '{group}',
    aliases: [],
    triggerWords: ['group'],
    kind: 'modifier',
    resolvesTo: { key: 'revealgroup', value: true },
    status: 'stable',
    sample: `### Group reveal
{group}{reveal}

- These arrive
- as one beat`,
    description: 'Reveal a list as one beat instead of one bullet',
    category: 'modes'
  },
  {
    name: 'focus',
    label: 'Focus mode',
    trigger: '{focus}',
    aliases: ['mode=focus'],
    triggerWords: ['focus'],
    kind: 'modifier',
    resolvesTo: { key: 'mode', value: 'focus' },
    status: 'stable',
    sample: `### Focus mode
{focus}

- Focus this
- Then this
- Then this`,
    description: 'Step mode: focus each beat, dimming the rest',
    category: 'modes'
  },
  {
    name: 'trigger-line',
    label: 'Trigger line',
    trigger: '{contrast}',
    aliases: [],
    triggerWords: ['contrast'],
    kind: 'modifier',
    resolvesTo: { key: 'layout', value: 'contrast' },
    status: 'stable',
    sample: `### trigger-line
{contrast}

- Heading stays clean
- Trigger sits on its own line`,
    description: 'Put a trigger on the line under a heading',
    category: 'modes'
  },
  {
    name: 'countdown',
    label: 'Countdown',
    trigger: '{countdown-digits-90s}',
    aliases: ['countdown-bar-3min'],
    triggerWords: [],
    kind: 'component',
    dynamicPatterns: [{
      source: '^countdown-(digits|bar)-(.+)$',
      resolution: [
        { key: 'countdown', value: '$2' },
        { key: 'countdown-style', value: '$1' }
      ]
    }],
    status: 'stable',
    sample: `### Countdown element
{countdown-digits-90s}

Discuss with your neighbour.`,
    description: 'Per-slide countdown element',
    category: 'modes',
    cssModule: 'stats'
  },
  {
    name: 'notitle',
    label: 'No title',
    trigger: '{notitle}',
    aliases: [],
    triggerWords: ['notitle'],
    kind: 'modifier',
    status: 'stable',
    sample: `### notitle
{notitle}

The visible heading is suppressed.`,
    description: 'Hide the on-slide title while keeping navigation text',
    category: 'modes',
    cssModule: 'stats'
  },
  {
    name: 'titletop',
    label: 'Title top',
    trigger: '{titletop}',
    aliases: ['title=top'],
    triggerWords: ['titletop'],
    kind: 'modifier',
    status: 'stable',
    sample: `### titletop
{titletop}

- Force the title rail to the top
- Keep the layout otherwise intact`,
    description: 'Force the top-title treatment',
    category: 'modes'
  },
  {
    name: 'accent',
    label: 'Section accent',
    trigger: '{accent=vermilion}',
    aliases: [],
    triggerWords: [],
    kind: 'modifier',
    sectionOnly: true,
    status: 'stable',
    sample: `## accent — pinned section colour
{accent=vermilion}

### Every child keeps the pin

- Named colour, never a hex value`,
    description: 'Pin this section to a named colour from the deck palette',
    category: 'modes',
    options: [{
      key: 'accent',
      label: 'Section accent',
      preview: 'segmented',
      values: [
        { token: '', label: 'Cycle', description: 'Use the deterministic section-index cycle' },
        { token: 'accent=cobalt', label: 'Cobalt', swatch: '#0f4bd8' },
        { token: 'accent=emerald', label: 'Emerald', swatch: '#0a7a5c' },
        { token: 'accent=vermilion', label: 'Vermilion', swatch: '#c2410c' },
        { token: 'accent=forest', label: 'Forest', description: 'Available in the green palette', swatch: '#166534' }
      ]
    }]
  },
  {
    name: 'nostep',
    label: 'No stepping',
    trigger: '{nostep}',
    aliases: [],
    triggerWords: ['nostep'],
    kind: 'modifier',
    status: 'unverified',
    sample: `### nostep
{nostep}{reveal}

- Everything stays visible
- Even when reveal mode is active`,
    description: 'Disable stepping on this slide',
    category: 'modes'
  },
  {
    name: 'novalues',
    label: 'No values',
    trigger: '{novalues}',
    aliases: ['nonumbers'],
    triggerWords: ['novalues','nonumbers'],
    kind: 'modifier',
    status: 'stable',
    sample: `### novalues — shape-only comparison
{barchart}{novalues}

- Organising your life: 15
- Finding resources: 20
- Learning subject: 40`,
    description: 'Hide chart value labels — bars keep only their relative shape',
    category: 'modes'
  },
  {
    name: 'sidebar-40',
    label: 'Sidebar width',
    trigger: '{sidebar-40}',
    aliases: ['{sidebar-30}', '{sidebar-35}', '{sidebar-50}'],
    triggerWords: [],
    kind: 'modifier',
    dynamicPatterns: [{
      source: '^sidebar-(30|35|40|50)$',
      resolution: [
        { key: 'title', value: 'side' },
        { key: 'split', value: '$1' }
      ]
    }],
    status: 'stable',
    sample: `### sidebar-40 — pinned rail width
{sidebar-40}

- Wide rail shortens the text measure
- 30 and 35 and 50 are the other stops`,
    description: 'Pin the title-sidebar rail width (30/35/40/50%)',
    category: 'modes'
  },
  {
    name: 'font-body',
    label: 'Font size',
    trigger: '{font-body=l}',
    aliases: ['{font-title=xl}'],
    triggerWords: [],
    kind: 'modifier',
    status: 'stable',
    sample: `### font-body — per-slide type override
{font-body=l}{font-title=s}

- Body steps up one size
- The title steps down one`,
    description: 'Per-slide body/title size: xs s m l xl',
    category: 'modes'
  },
  {
    name: 'grid-linear',
    label: 'Grid linear',
    trigger: '{grid-linear}',
    aliases: [],
    triggerWords: ['grid-linear'],
    kind: 'container',
    sectionOnly: true,
    status: 'stable',
    sample: `## grid-linear
{grid-linear}

### First child

- One

### Second child

- Two`,
    description: 'Section container mode: grid, stepped in order',
    category: 'modes'
  },
  {
    name: 'grid-zoom',
    label: 'Grid zoom',
    trigger: '{grid-zoom}',
    aliases: [],
    triggerWords: ['grid-zoom'],
    kind: 'container',
    sectionOnly: true,
    status: 'stable',
    sample: `## grid-zoom
{grid-zoom}

### First child

- One

### Second child

- Two`,
    description: 'Section container mode: grid, zoom into each child',
    category: 'modes'
  },
  {
    name: 'contents',
    label: 'Contents',
    trigger: '{contents}',
    aliases: [],
    triggerWords: ['contents'],
    kind: 'container',
    sectionOnly: true,
    status: 'stable',
    sample: `## contents
{contents}

### First child

- One

### Second child

- Two

## contents strip {contents=strip}

### Third child

- Three

### Fourth child

- Four`,
    description: 'Section container mode: agenda rail; {contents=strip} = filmstrip footer variant (ADR-0007)',
    category: 'modes',
    options: [{
      key: 'variant',
      label: 'Variant',
      preview: 'segmented',
      values: [
        { token: '', label: 'Rail', description: 'Thin agenda rail' },
        { token: 'contents=strip', label: 'Strip', description: 'Filmstrip footer of child miniatures' }
      ]
    }]
  },
  {
    name: 'timer-audience',
    label: 'Timer audience',
    trigger: '{timer-audience}',
    aliases: [],
    triggerWords: ['timer-audience'],
    kind: 'container',
    resolvesTo: { key: 'timer-show', value: 'audience' },
    sectionOnly: true,
    status: 'unverified',
    sample: `## timer-audience
{timer=10min}{timer-audience}

### Timed child

- The section timer is visible to the room.`,
    description: 'Show a section timer to the audience',
    category: 'modes'
  },
  {
    name: 'multicolour',
    label: 'Multicolour nodes',
    trigger: '{multicolour}',
    aliases: ['multicolor'],
    triggerWords: ['multicolour','multicolor'],
    kind: 'modifier',
    status: 'stable',
    sample: `### multicolour
{system-map}{multicolour}{centre=TalkWeaver}

- Compiler
- Editor
- Runtime
- Presenter`,
    description: 'Opt-in varied palette for supported diagram nodes',
    category: 'modes'
  }
]
