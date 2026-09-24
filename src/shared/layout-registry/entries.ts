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
/**
 * ADR-0023 §2 (A3): where a slide's title goes when the author set no override.
 * Declared once per layout here; the compiler reads it from the generated trigger dictionary
 * (TITLE_REGIME_BY_LAYOUT) and never keeps a second list.
 *   sidebar  tint rail on the left, title vertically centred, content column centred (text layouts)
 *   top      title at the top with the hairline rule, content band centred below (full-band structures)
 *   hidden   title not painted; the navigation h1 stays as sr-only (quote, compare, image-quote)
 *   own      structural slides that compose their whole stage (title, section, subsection, closing)
 */
export type TitleRegime = 'sidebar' | 'top' | 'hidden' | 'own'
export type LayoutStatus = 'stable' | 'unverified' | 'experimental'
// GFM-table detection remains hardcoded in detect.ts; registry derivation belongs with C-D.
export type ObjectStorage = 'trigger-list' | 'fence'
export type ObjectEditor = 'grid' | 'outline' | 'source'

export interface OptionValue {
  token: string
  label: string
  description?: string
  /** Colour options render a dot in this hex beside the label (ADR-0005 palette names). */
  swatch?: string
  /**
   * T32 (Decision 1A): further authored tokens this ONE button also means. The button still
   * writes its canonical `token`; the extras only make the row READ them (selectionForGroup
   * lights this button for them, and a rival commit sweeps them with the rest of the group).
   * The case that needs it: Plain accepts the authored `{plainlist}` override, so a list that
   * explicitly opts out of a deck-wide icons default still lights Plain.
   */
  altTokens?: string[]
}

/**
 * ADR-0020 §5 — WHEN an option group is relevant, declared as data.
 *
 * Before this declaration existed, `groupApplies` hard-coded two rules by group name (the poll
 * limits by poll type; Container mode on `##`/parents) and nothing else, so every other global
 * group rendered on every slide — Media placement on a chart, Claim style on a table, Title
 * placement on a section divider. The registry now carries the rule and `options.ts` is a pure
 * interpreter: no surface decides relevance for itself.
 *
 * READING THE SHAPE
 * - Every declared facet must hold (AND). An undeclared facet constrains nothing.
 * - A fact the calling context does not know NEVER excludes a group. An unresolved layout has no
 *   name, kind or regime, so a plain `###` slide keeps the universal groups; `requiresTokens` is
 *   likewise skipped when the caller passes no `selectedTokens` (that two-stage filter is what the
 *   Inspector has always done: `optionGroupsForSlide` offers the candidates, then re-filters them
 *   once the authored trigger line is parsed).
 * - `layouts` is the positive membership test, `excludeLayouts` the negative one. Which direction
 *   a group uses is a judgement about its default for a layout nobody has considered yet: Claim
 *   style names the prose layouts it belongs to (a new layout does not silently gain a type
 *   treatment), Media placement names the bodies that can never hold a media slot (a new layout
 *   inherits the compiler's "any layout with an authored {image=left|right}" arm).
 * - `anyOf` is a disjunction of whole clauses, for the one rule that is genuinely an OR: Container
 *   mode belongs on a `##` section OR on any heading that has child slides.
 */
export interface OptionApplicability {
  /** The resolved entry's kind must be one of these. */
  kinds?: readonly LayoutKind[]
  /** The resolved layout must be one of these names (its registry name, not a compiled alias). */
  layouts?: readonly string[]
  /** The resolved layout must NOT be one of these names. */
  excludeLayouts?: readonly string[]
  /** The resolved layout's ADR-0023 §2 title regime must be one of these. */
  titleRegimes?: readonly TitleRegime[]
  /** The slide's authored heading level must be one of these. */
  headingLevels?: readonly number[]
  /** The slide must have child slides beneath it. */
  requiresChildren?: boolean
  /**
   * Another group's selection must already be one of the listed tokens — checked only when the
   * caller supplies `selectedTokens`, so a candidate listing never loses the group.
   */
  requiresTokens?: Readonly<Record<string, readonly string[]>>
  /** At least one of these clauses must hold, in addition to the facets declared beside it. */
  anyOf?: readonly OptionApplicability[]
}

export interface OptionGroup {
  key: string
  label: string
  values: OptionValue[]
  preview?: 'thumbs' | 'segmented'
  /** Positive integer input, sharing the canonical trigger-line commit path. */
  numberKey?: string
  allowUnlimited?: boolean
  /** Accepted value-form triggers that intentionally do not create duplicate UI choices. */
  dictionaryTokens?: string[]
  /**
   * ADR-0020 §5. Required on every GLOBAL_OPTION_GROUPS entry (scripts/test-option-applicability
   * enforces it). A group declared inside a layout's own `options` needs none: it applies to that
   * layout by construction.
   */
  appliesTo?: OptionApplicability
  /**
   * T32 (Decision 2A): the Inspector section a GLOBAL group renders in. Undeclared means Slide, the
   * catch-all. Entry-owned groups, and global groups a modifier entry adopts (iconlist-variant),
   * always render in the slide's own layout section, so they need no field. A group that only
   * applies because of another group's value nests under that group — in that group's section —
   * whatever it declares here (`sectionedOptionGroups`, options.ts, derives it from `appliesTo`).
   */
  section?: GlobalOptionSection
  /**
   * T32 (Decision 2A, as drawn): the shorter label the group carries INSIDE an Inspector section,
   * whose heading already names the context ("Placement" under Title). Every other surface — the
   * ⌘L picker, the inline palette, the control's accessible name — keeps `label`.
   */
  sectionLabel?: string
}

/** The Inspector sections a global group can declare (T32, Decision 2A). */
export type GlobalOptionSection = 'title' | 'slide' | 'steps' | 'poll'
/** Every Inspector section, in its fixed order: the slide's own layout first. */
export type InspectorSectionId = 'layout' | GlobalOptionSection

export interface ObjectDeclaration {
  storage: ObjectStorage
  /** Older written forms that remain readable but are never manufactured by insert doors. */
  compatStorage?: ObjectStorage[]
  widget: string
  editor: ObjectEditor
  emptySkeleton: () => string
}

export interface LayoutDef {
  name: string
  label: string
  trigger: string
  aliases: string[]
  triggerWords: string[]
  kind: LayoutKind
  /**
   * ADR-0023 §2: the layout's title regime. Required on every `kind: 'layout'` entry; also
   * declared on the component/container entries that become a compiled layout slug of their own
   * ({code}, {carousel}). Author overrides in the title-placement / title-display option groups
   * beat it; nothing else does.
   */
  titleRegime?: TitleRegime
  status: LayoutStatus
  sample: string
  description: string
  category: LayoutCategory
  cssModule?: string
  sectionOnly?: true
  resolvesTo?: { key: string; value: string | boolean }
  dynamicPatterns?: DynamicPattern[]
  bareAliases?: Array<{ word: string; key: string; value: string }>
  options?: OptionGroup[]
  object?: ObjectDeclaration
}

export interface DynamicPattern {
  source: string
  resolution: Array<{ key: string; value: string }>
}

export const systemTokens = ['id', 'tags', 'from', 'clonedFrom'] as const

/**
 * Finite compiler vocabularies that are registry truth but are not picker choices.
 * Keep these separate from OptionGroups: adding a token here validates authored input without
 * manufacturing an option surface.
 */
export const FINITE_VALUE_TOKENS = [
  'role=opening',
  'role=ending',
  'role=section-title',
  'role=subsection-title',
  'role=content',
  'role=linking'
] as const

export interface OpenPatternToken {
  key: string
  /** Valued open forms, or a value-free presence declaration for a compiler-read legacy flag. */
  form: 'equals' | 'colon' | 'bare'
  /** Regex the VALUE must match; absent only for a value-free bare declaration. */
  pattern?: string
  description: string
  /** Why this key has no finite UI vocabulary (the options-parity justification). */
  justification: string
}

export const OPEN_PATTERN_TOKENS: OpenPatternToken[] = [
  { key: 'pollselections', form: 'equals', pattern: '[1-9][0-9]*', description: 'Maximum options per multiple-choice answer.', justification: 'Positive integer configured in poll controls.' },
  { key: 'pollsubmissions', form: 'equals', pattern: '[1-9][0-9]*|unlimited', description: 'Free-text submissions per participant.', justification: 'Positive integer or unlimited configured in poll controls.' },
  { key: 'id', form: 'equals', pattern: '[A-Za-z0-9-]+', description: 'Stable slide identity.', justification: 'System-managed stable slide identity.' },
  { key: 'tags', form: 'equals', pattern: '[^\\s]+', description: 'Comma-separated author tags.', justification: 'Author metadata managed by the tag picker.' },
  { key: 'from', form: 'equals', pattern: '.+', description: 'Provenance of an adopted slide.', justification: 'System provenance for adopted slides.' },
  { key: 'clonedFrom', form: 'equals', pattern: '.+', description: 'Provenance of a cloned slide.', justification: 'System provenance for cloned slides.' },
  { key: 'icon', form: 'equals', pattern: '.+', description: 'Icon payload chosen by the icon picker.', justification: 'Free icon payload chosen by the icon picker.' },
  { key: 'kicker', form: 'equals', pattern: '.+', description: 'Authored kicker text.', justification: 'Free authored display text.' },
  { key: 'remind', form: 'equals', pattern: '.+', description: 'Presenter reminder text.', justification: 'Free presenter-reminder text.' },
  { key: 'remind-at', form: 'equals', pattern: '.+', description: 'Reminder wall-clock time.', justification: 'Free wall-clock time for a presenter reminder.' },
  { key: 'remind-in', form: 'equals', pattern: '.+', description: 'Reminder relative duration.', justification: 'Free relative duration for a presenter reminder.' },
  { key: 'countdown', form: 'equals', pattern: '.+', description: 'Countdown duration (30s, 3min, 1:30).', justification: 'Free countdown duration; the compiler validates and warns countdown-unparsed.' },
  { key: 'timer', form: 'equals', pattern: '.+', description: 'Section timer duration (10min, 10m, 1:30).', justification: 'Free section-timer duration; the compiler validates and warns section-timer-unparsed.' },
  { key: 'countdown-style', form: 'equals', pattern: 'digits|bar', description: 'Countdown rendering style.', justification: 'Generated by the countdown dynamic trigger.' },
  { key: 'blocks', form: 'colon', pattern: '\\d+x\\d+', description: 'Grid rows-by-columns, e.g. 3x3.', justification: 'Free RxC grid dimensions.' },
  { key: 'polltop', form: 'equals', pattern: '\\d+', description: 'Exact number of choices to rank.', justification: 'Author chooses an integer bounded by the number of poll options; the compiler validates the range.' },
  { key: 'cols', form: 'equals', pattern: '\\d+', description: 'Column count.', justification: 'Free column count; bare {2col}/{3col} resolve here.' },
  { key: 'palette', form: 'equals', pattern: '.+', description: 'Legacy slide-level palette escape hatch.', justification: 'Deck settings owns the UI.' },
  { key: 'centre', form: 'equals', pattern: '.+', description: 'Diagram centre label.', justification: 'Free diagram centre label text.' },
  { key: 'center', form: 'equals', pattern: '.+', description: 'US-spelling alias for centre.', justification: 'US-spelling alias for the free diagram centre label.' },
  { key: 'curve', form: 'equals', pattern: 'sigmoid', description: 'Conceptual S-curve layout.', justification: 'Legacy chart-shape alias retained for source compatibility.' },
  { key: 'titlestyle', form: 'equals', pattern: '.+', description: 'Compiler-internal title-rail style.', justification: 'Emitted by the registered sidebar trigger.' }
]

/**
 * Layouts whose body is ONE structured object (a chart, a table, a diagram, a code block, an
 * equation) or a wall of media — never copy that a media block could sit beside. The compiler's
 * media slot (ADR-0023 §3, compiler/scripts/lib/slot-composition.mjs) can never compose on these:
 * `slotCompositionFor` needs at least one non-media copy block, and these bodies have none.
 * `table` is listed like any other structured body; it re-declares Media placement as its OWN
 * option, and a layout's own declaration applies by construction whatever the global rule says.
 * The four structural layouts (own title regime) are excluded by regime instead, not by name.
 */
const STRUCTURED_BODY_LAYOUTS = [
  'barchart', 'carousel', 'chart', 'code', 'conceptmap', 'cycle', 'equation', 'flow', 'grid',
  'iconrow', 'image-grid', 'linechart', 'mermaid', 'mindmap', 'orgchart', 'piechart', 'process',
  'pyramid', 'sigmoid', 'smartart', 'stats', 'steps', 'svg', 'system-map', 'table',
  'table-outline', 'timeline', 'timetable'
] as const

/**
 * Layouts whose body renders authored PARAGRAPHS, so a wholly bold paragraph can become the
 * ADR-0023 §4 claim and the claim-style choice is real. Charts, tables, diagrams, code and the
 * media wall render no paragraph at all; `quote` and `image-quote` render their body AS the
 * quotation (ADR-0023 §5 promotes the paragraph), so neither carries a claim either.
 */
const PROSE_BODY_LAYOUTS = [
  'cards', 'columns', 'compare', 'contrast', 'copy-visual', 'cta-screenshots', 'image-claim',
  'links', 'list', 'list-visual', 'media', 'statement', 'stmt-list', 'timeline-visual', 'trace',
  'trace-dialogue'
] as const

/** Every layout that paints a title of its own, i.e. everything but the structural posters. */
const TITLED_REGIMES = ['sidebar', 'top', 'hidden'] as const

/** Every poll type: the selection that makes the poll-behaviour groups mean anything. */
const POLL_TYPE_TOKENS = [
  'poll=single', 'poll=multiple', 'poll=open', 'poll=ranking', 'poll=rating', 'poll=categorisation'
] as const

// ADR-0011: every choosing surface consumes these values and writes their exact tokens.
// ADR-0020 §5: each group declares WHERE it is relevant; options.ts interprets, never decides.
export const GLOBAL_OPTION_GROUPS: OptionGroup[] = [
  {
    key: 'background',
    label: 'Background',
    preview: 'segmented',
    section: 'slide',
    // Every slide has a paper, structural posters included.
    appliesTo: {},
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
    section: 'slide',
    // The pre-ADR-0020 rule, now data: a `##` section is a container by construction, and any
    // heading with child slides can sequence them.
    appliesTo: { anyOf: [{ headingLevels: [2] }, { requiresChildren: true }] },
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
    sectionLabel: 'Placement',
    preview: 'segmented',
    section: 'title',
    // ADR-0023 §2: a structural poster (`own`) composes its whole stage, and a `hidden` layout
    // (quote, compare, image-quote) has no placement to choose — only Title display's Show.
    appliesTo: { titleRegimes: ['sidebar', 'top'] },
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
    sectionLabel: 'Display',
    preview: 'segmented',
    section: 'title',
    // Anything but a structural poster can show or quieten its heading.
    appliesTo: { titleRegimes: TITLED_REGIMES },
    // RETIRED VALUE (ADR-0023 §2a, 2026-09-12): `title=compact` is no longer a choice. Ticket 2
    // abolished the compact kicker-title form, so the token renders as the layout's own regime;
    // it stays in the compiler dictionary as a legacy alias (old decks must not start erroring)
    // and the compiler answers it with the `retired-title-compact` hint.
    dictionaryTokens: ['title=compact'],
    values: [
      { token: '', label: 'Layout default', description: 'Use the layout’s normal title treatment' },
      { token: 'title=show', label: 'Show', description: 'Restore a full visible heading on title-quiet layouts' }
    ]
  },
  {
    key: 'font-body',
    label: 'Body size',
    preview: 'segmented',
    section: 'slide',
    // The ADR-0005 type scale is a property of the stage, not of a layout. Declared here — ahead
    // of Media placement — so the T32 Slide section reads in the sheet's order: Background, Body
    // size, Media, Section label. Declaration order IS the section's render order.
    appliesTo: {},
    values: [
      { token: 'font-body=xs', label: 'XS' },
      { token: 'font-body=s', label: 'S' },
      { token: '', label: 'M' },
      { token: 'font-body=l', label: 'L' },
      { token: 'font-body=xl', label: 'XL' }
    ]
  },
  {
    key: 'media-placement',
    label: 'Media placement',
    sectionLabel: 'Media',
    preview: 'segmented',
    section: 'slide',
    // ADR-0023 §3: the media slot composes on the four inferred beside layouts, on a cards gallery
    // with leading media, and on ANY layout carrying an authored {image=left|right} — so the group
    // is offered everywhere the body can hold copy AND media, and withheld only where it cannot.
    appliesTo: { titleRegimes: TITLED_REGIMES, excludeLayouts: STRUCTURED_BODY_LAYOUTS },
    dictionaryTokens: [
      'media=left', 'media=right',
      'align=top', 'align=center', 'align=centre', 'align=middle'
    ],
    values: [
      { token: '', label: 'Auto', description: 'Use the frame or layout default' },
      { token: 'image=left', label: 'Left', description: 'Place the media slot left of the copy' },
      { token: 'image=right', label: 'Right', description: 'Place the media slot right of the copy' }
    ]
  },
  {
    key: 'section-label',
    label: 'Section label',
    preview: 'segmented',
    section: 'slide',
    // The corner label names the section a CONTENT slide sits in; a structural poster either is
    // that divider or precedes every section.
    appliesTo: { titleRegimes: TITLED_REGIMES },
    dictionaryTokens: ['section=on', 'section=show', 'section=none', 'section=hide'],
    values: [
      { token: '', label: 'Auto', description: 'Use the section or deck frame default' },
      { token: 'section=corner', label: 'Corner', description: 'Show the section name in the top-right corner' },
      { token: 'section=off', label: 'Off', description: 'Hide the section name on this slide' }
    ]
  },
  {
    key: 'claim-style',
    label: 'Claim style',
    preview: 'segmented',
    // ADR-0023 §4: the claim IS a wholly bold paragraph, so the choice exists exactly where the
    // body renders authored paragraphs.
    appliesTo: { layouts: PROSE_BODY_LAYOUTS },
    values: [
      { token: '', label: 'Deck default', description: 'Use the deck’s claim style (plain unless the frontmatter sets one)' },
      { token: 'claim=plain', label: 'Plain', description: 'Set a wholly bold paragraph one type step larger, in ink, with no bar' },
      { token: 'claim=bar', label: 'Bar', description: 'Keep the claim at body size and mark it with a section-accent bar at the left' }
    ]
  },
  {
    key: 'arrival-mode',
    label: 'Arrival mode',
    sectionLabel: 'Arrival',
    preview: 'segmented',
    section: 'steps',
    // Beats are made of blocks, list items or child slides, and any heading can carry them —
    // including a `##` section stepping through its children — so arrival mode stays universal.
    appliesTo: {},
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
    section: 'steps',
    // {nostep} answers arrival mode and a sticky presenter mode alike; universal for the same
    // reason arrival mode is.
    appliesTo: {},
    values: [
      { token: '', label: 'Auto' },
      { token: 'nostep', label: 'Nostep', description: 'Disable stepping on this slide' }
    ]
  },
  {
    key: 'font-title',
    label: 'Title size',
    sectionLabel: 'Size',
    preview: 'segmented',
    section: 'title',
    // Every slide has a title in the deck navigation even when the stage hides it.
    appliesTo: {},
    values: [
      { token: 'font-title=xs', label: 'XS' },
      { token: 'font-title=s', label: 'S' },
      { token: '', label: 'M' },
      { token: 'font-title=l', label: 'L' },
      { token: 'font-title=xl', label: 'XL' }
    ]
  },
  {
    key: 'poll-type',
    label: 'Poll type',
    sectionLabel: 'Type',
    preview: 'segmented',
    section: 'poll',
    // A structural poster carries no answerable content; every other slide can become a poll.
    appliesTo: { titleRegimes: TITLED_REGIMES },
    values: [
      { token: '', label: 'None', description: 'This slide is not a poll' },
      { token: 'poll=single', label: 'Single choice', description: 'Let each audience member choose one list item' },
      { token: 'poll=multiple', label: 'Multiple choice', description: 'Let each audience member choose one or more list items' },
      { token: 'poll=open', label: 'Open response', description: 'Collect free-text responses instead of list choices' },
      { token: 'poll=ranking', label: 'Ranking', description: 'Rank all list items, or exactly polltop choices' },
      { token: 'poll=rating', label: 'Rating', description: 'Rate each list item with labels from [scale: …]' },
      { token: 'poll=categorisation', label: 'Categorisation', description: 'Assign each list item a label from [categories: …]' }
    ]
  },
  {
    key: 'poll-skip',
    label: 'Skipped poll rows',
    preview: 'segmented',
    // Only rating and categorisation have per-row answers that could be skipped.
    appliesTo: {
      titleRegimes: TITLED_REGIMES,
      requiresTokens: { 'poll-type': ['poll=rating', 'poll=categorisation'] }
    },
    values: [
      { token: '', label: 'Required', description: 'Require an answer for every rating or categorisation row (default)' },
      { token: 'pollskip=false', label: 'Required', description: 'Require an answer for every rating or categorisation row' },
      { token: 'pollskip=true', label: 'Allow skipping', description: 'Allow an explicit skip for rating or categorisation rows' }
    ]
  },
  {
    key: 'poll-results',
    label: 'Poll results',
    sectionLabel: 'Results',
    preview: 'segmented',
    section: 'poll',
    // There is nothing to reveal until the slide is a poll of some type.
    appliesTo: {
      titleRegimes: TITLED_REGIMES,
      requiresTokens: { 'poll-type': POLL_TYPE_TOKENS }
    },
    values: [
      { token: '', label: 'Live', description: 'Show results to the audience as votes arrive (default)' },
      { token: 'pollresults=live', label: 'Live', description: 'Show results to the audience as votes arrive' },
      { token: 'pollresults=held', label: 'Held', description: 'Record votes privately until the presenter reveals results' }
    ]
  },
  {
    key: 'pollselections', label: 'Select up to', numberKey: 'pollselections',
    // The pre-ADR-0020 poll rule, now data: a selection cap only means anything on multiple choice.
    appliesTo: { titleRegimes: TITLED_REGIMES, requiresTokens: { 'poll-type': ['poll=multiple'] } },
    values: [{ token: '', label: 'All options', description: 'Allow any number of options in one final answer' }]
  },
  {
    key: 'pollsubmissions', label: 'Submissions per participant', numberKey: 'pollsubmissions', allowUnlimited: true,
    // …and a submission allowance only on open response.
    appliesTo: { titleRegimes: TITLED_REGIMES, requiresTokens: { 'poll-type': ['poll=open'] } },
    values: [
      { token: '', label: 'One (default)', description: 'One final submission per participant' }
    ]
  },
  {
    // T28 (Dominik, 2026-09-17): HOW an icon list renders. Declared global because the icons
    // can come from two option groups — {iconlist} (the list-style group) or {icons=top} /
    // {icons=all} (the icon-level group) — so the token rule, not a layout name, decides
    // relevance; the iconlist entry adopts this group for its own pickers.
    // T32 (Decision 2A): no section field — the iconlist modifier adopts this group, so it renders
    // in the slide's layout section, nested under List style (the first group its rule reads).
    key: 'iconlist-variant',
    label: 'Icon list treatment',
    preview: 'thumbs',
    sectionLabel: 'Icon treatment',
    appliesTo: {
      anyOf: [
        { requiresTokens: { 'list-style': ['iconlist'] } },
        { requiresTokens: { 'icon-level': ['icons=top', 'icons=all'] } }
      ]
    },
    values: [
      { token: '', label: 'Auto', description: 'Boxes up to three items, a vertical list above that' },
      { token: 'iconlist=boxes', label: 'Boxes', description: 'Hairline card grid with icons, whatever the item count' },
      { token: 'iconlist=list', label: 'List', description: 'Plain icon rows without card chrome or numbers' }
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
    titleRegime: 'sidebar',
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
    titleRegime: 'sidebar',
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
      sectionLabel: 'Style',
      preview: 'segmented',
      values: [
        {
          token: '',
          label: 'Plain',
          description: 'Plain bullet list',
          // T32 (Decision 1A): {plainlist} is the authored PLAIN override a deck-wide icons
          // default needs. This one button still writes its canonical '' (follow the deck);
          // the Inspector alone decides to write the alt token when the deck's choice is icons.
          altTokens: ['plainlist']
        },
        { token: 'iconlist', label: 'Icons', description: 'Semantic icon bullets' },
        { token: 'logolist', label: 'Logos', description: 'Use brand-logo bullets where mappings exist' },
        { token: 'numbered', label: 'Numbered', description: 'Numbered discs' },
        { token: 'annotated', label: 'Annotated', description: 'Nested children become right-hand annotations' }
      ]
    }, {
      key: 'icon-level',
      label: 'List icons',
      sectionLabel: 'Icons on',
      preview: 'segmented',
      // T28: the real tokens the compiler honours (11-frame.mjs normIcons: top/all/off) are the
      // option's OWN values; dictionaryTokens additionally registers the normaliser's legacy
      // aliases (none/on/yes) so the Doctor stays clean for values the compiler still accepts —
      // the same pattern as section-label's show/hide aliases.
      dictionaryTokens: ['icons=top', 'icons=all', 'icons=off', 'icons=none', 'icons=on', 'icons=yes'],
      values: [
        { token: '', label: 'Auto', description: 'Use the chosen list style' },
        { token: 'icons=top', label: 'Top', description: 'Show icons on top-level list items' },
        { token: 'icons=all', label: 'All', description: 'Show icons on top-level and nested list items' },
        { token: 'icons=off', label: 'Off', description: 'Do not override the chosen list style' }
      ]
    }]
  },
  {
    name: 'iconlist',
    label: 'Icon list',
    trigger: '{iconlist}',
    aliases: ['icons', 'liststyle=icons'],
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
    // iconlist-variant is declared ONCE in GLOBAL_OPTION_GROUPS (the Inspector must offer it
    // on any list slide whose icons come via {iconlist} or {icons=top}/{icons=all}) and is
    // adopted here so the ⌘L / inline pickers still show it on this entry — the same pattern
    // as table → media-placement.
    options: [...GLOBAL_OPTION_GROUPS.filter((group) => group.key === 'iconlist-variant')]
  },
  {
    name: 'numbered',
    label: 'Numbered list',
    trigger: '{numbered}',
    aliases: ['liststyle=numbers'],
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
    titleRegime: 'hidden',
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
    name: 'annotated',
    label: 'Annotated list',
    trigger: '{annotated}',
    aliases: ['sublist=aside'],
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
    aliases: ['title=side', 'title=sidebar'],
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
    titleRegime: 'top',
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
    titleRegime: 'sidebar',
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
        { token: 'contrast=cards', label: 'Cards', description: 'Rich side-by-side comparison panels' },
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
    titleRegime: 'hidden',
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
    titleRegime: 'top',
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
    titleRegime: 'top',
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
    }, {
      // Ticket 21 ("cards should have option for icons"): the icon on each card resolves through
      // the icon-list pipeline (per-item {icon=lucide:…}, the deck `icons:` map, then the deck
      // vocabulary). `{iconlist}` on a cards slide means the same thing and is accepted as an
      // alias; the compiler answers it with the `cards-iconlist-alias` hint.
      key: 'cards-icons',
      label: 'Icons',
      preview: 'segmented',
      dictionaryTokens: ['iconlist'],
      values: [
        { token: '', label: 'None', description: 'Cards carry their label and body only' },
        { token: 'icons', label: 'Icons', description: 'An accent icon on each card, from {icon=lucide:…} or the deck vocabulary' }
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
    titleRegime: 'top',
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
    titleRegime: 'own',
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
    titleRegime: 'own',
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
    titleRegime: 'own',
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
    titleRegime: 'own',
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
    bareAliases: [
      { word: 'timelinevertical', key: 'timeline', value: 'vertical' },
      { word: 'timelinehorizontal', key: 'timeline', value: 'horizontal' },
      { word: 'timelinespine', key: 'timeline', value: 'spine' },
      { word: 'timeline-pills', key: 'timeline', value: 'pills' },
      { word: 'timelinepills', key: 'timeline', value: 'pills' },
      { word: 'timelinedynamic', key: 'timeline', value: 'dynamic' }
    ],
    kind: 'layout',
    titleRegime: 'top',
    status: 'stable',
    sample: `### Timeline
{timeline}

- 2022
  - Launch
- 2026
  - Agents`,
    description: 'Dated chronology rail',
    category: 'structural',
    cssModule: 'timeline',
    options: [{
      key: 'timeline-mode',
      label: 'Timeline mode',
      preview: 'thumbs',
      dictionaryTokens: ['timeline=vertical'],
      values: [
        { token: '', label: 'Auto', description: 'Rail, or columns for large grouped timelines' },
        { token: 'timeline=rail', label: 'Rail', description: 'Vertical dated rail' },
        { token: 'timeline=columns', label: 'Columns', description: 'Grouped columns for tall timelines' },
        { token: 'timeline=compact', label: 'Compact', description: 'Dense single-column rail' },
        { token: 'timeline=horizontal', label: 'Horizontal', description: 'Left-to-right track of dated stops' },
        { token: 'timeline=spine', label: 'Spine', description: 'Central spine, cards alternating above and below' },
        { token: 'timeline=pills', label: 'Pills', description: 'Date pills on the spine, cards below' },
        { token: 'timeline=dynamic', label: 'Dynamic', description: 'Animated build of the timeline' }
      ]
    }]
  },
  {
    name: 'grid',
    label: 'Grid',
    trigger: '{grid}',
    aliases: [],
    triggerWords: ['grid'],
    kind: 'layout',
    titleRegime: 'top',
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
    titleRegime: 'top',
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
    titleRegime: 'top',
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
    name: 'timeline-visual',
    label: 'Timeline + comment',
    trigger: '{timeline-visual}',
    aliases: [],
    triggerWords: ['timeline-visual'],
    kind: 'layout',
    titleRegime: 'top',
    status: 'stable',
    sample: `### Timeline beside a comment
{timeline-visual}

- 2024: First draft
- 2025: Registry
- 2026: The law

A timeline with a comment lays the two side by side.`,
    description: 'Timeline in one column, comment beside it. Auto-chosen for a timeline paired with a standalone paragraph or quote.',
    category: 'specialised',
    cssModule: 'timeline'
  },
  {
    name: 'list-visual',
    label: 'List + media',
    trigger: '{list-visual}',
    aliases: [],
    triggerWords: ['list-visual'],
    kind: 'layout',
    titleRegime: 'top',
    status: 'stable',
    sample: `### Feature list beside media
{list-visual}

- One
- Two
- Three

![](sample.png)`,
    description: 'Feature list in one column, media in the other. Auto-chosen for media plus a list with no prose.',
    category: 'specialised',
    cssModule: 'list'
  },
  {
    name: 'flow',
    label: 'Flow diagram',
    trigger: '{flow}',
    aliases: [],
    triggerWords: ['flow'],
    kind: 'layout',
    titleRegime: 'top',
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
    titleRegime: 'top',
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
    titleRegime: 'top',
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
    titleRegime: 'top',
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
    triggerWords: [],
    kind: 'layout',
    titleRegime: 'top',
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
    titleRegime: 'top',
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
    titleRegime: 'top',
    status: 'stable',
    object: {
      storage: 'trigger-list',
      widget: 'table',
      editor: 'grid',
      // Duplicated with insert-objects.ts because this registry must stay import-free for compiler
      // parity harnesses; scripts/test-object-blocks.mjs:38-41 pins byte equality.
      emptySkeleton: () =>
        '|  |  |  |\n| :--- | :--- | :--- |\n|  |  |  |\n|  |  |  |\n|  |  |  |'
    },
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
    cssModule: 'table',
    options: [
      ...GLOBAL_OPTION_GROUPS.filter((group) => group.key === 'media-placement'),
      // Ticket 21 (Dominik, 2026-09-13: "table should have option whether columns and header rows
      // are displayed"). Two orthogonal groups, so both can be switched on one slide; one shared
      // `table=` key would make the second token a trigger-conflict.
      {
        key: 'table-header',
        label: 'Header row',
        preview: 'segmented',
        dictionaryTokens: ['table-header=on'],
        values: [
          { token: '', label: 'Header', description: 'The first row is a tinted, bold header row' },
          { token: 'table-header=off', label: 'Plain', description: 'The first row is an ordinary row: no tint, no weight' }
        ]
      },
      {
        key: 'table-columns',
        label: 'Column rules',
        preview: 'segmented',
        dictionaryTokens: ['table-columns=on'],
        values: [
          { token: '', label: 'Grid', description: 'Hairline rules between columns and rows' },
          { token: 'table-columns=off', label: 'Rows only', description: 'Hairline rules between rows only; no column dividers' }
        ]
      }
    ]
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
    aliases: ['logos', 'liststyle=logos'],
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
    titleRegime: 'hidden',
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
    titleRegime: 'top',
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
    titleRegime: 'top',
    status: 'stable',
    object: {
      storage: 'fence',
      compatStorage: ['trigger-list'],
      widget: 'chart',
      editor: 'outline',
      emptySkeleton: () => '- Alpha: 40\n- Beta: 25\n- Gamma: 35'
    },
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
    }, {
      key: 'chart-shape',
      label: 'Chart shape',
      preview: 'thumbs',
      values: [
        { token: '', label: 'Auto', description: 'Shape inferred from the data lines' },
        { token: 'chart=bar', label: 'Bars' },
        { token: 'chart=pie', label: 'Pie' },
        { token: 'chart=line', label: 'Line' }
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
    titleRegime: 'top',
    resolvesTo: { key: 'chart', value: 'bar' },
    status: 'stable',
    object: {
      storage: 'fence',
      compatStorage: ['trigger-list'],
      widget: 'chart',
      editor: 'outline',
      emptySkeleton: () => '- Alpha: 40\n- Beta: 25\n- Gamma: 35'
    },
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
    titleRegime: 'top',
    resolvesTo: { key: 'chart', value: 'pie' },
    status: 'stable',
    object: {
      storage: 'fence',
      compatStorage: ['trigger-list'],
      widget: 'chart',
      editor: 'outline',
      emptySkeleton: () => '- Alpha: 40\n- Beta: 25\n- Gamma: 35'
    },
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
    titleRegime: 'top',
    resolvesTo: { key: 'chart', value: 'line' },
    status: 'stable',
    object: {
      storage: 'fence',
      compatStorage: ['trigger-list'],
      widget: 'chart',
      editor: 'outline',
      emptySkeleton: () => '- 2022: 1\n- 2024: 50\n- 2026: 100'
    },
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
    titleRegime: 'top',
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
    titleRegime: 'top',
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
    triggerWords: [],
    kind: 'layout',
    titleRegime: 'top',
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
    aliases: ['liststyle=plain'],
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
    titleRegime: 'top',
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
    titleRegime: 'sidebar',
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
    titleRegime: 'top',
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
    titleRegime: 'top',
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
    titleRegime: 'top',
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
    titleRegime: 'top',
    status: 'stable',
    object: {
      storage: 'trigger-list',
      widget: 'mindmap',
      editor: 'outline',
      // Duplicated with insert-objects.ts because this registry must stay import-free for compiler
      // parity harnesses; scripts/test-object-blocks.mjs:38-41 pins byte equality.
      emptySkeleton: () => '- Central idea\n  - First branch\n  - Second branch'
    },
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
    name: 'mermaid',
    label: 'Mermaid diagram',
    trigger: '```mermaid',
    aliases: [],
    triggerWords: ['mermaid'],
    kind: 'component',
    status: 'unverified',
    object: {
      storage: 'fence',
      widget: 'mermaid',
      editor: 'source',
      // Duplicated with insert-objects.ts because this registry must stay import-free for compiler
      // parity harnesses; scripts/test-object-blocks.mjs:38-41 pins byte equality.
      emptySkeleton: () => '```mermaid\nflowchart LR\n  A[Start] --> B[Next]\n```'
    },
    sample: `### Mermaid diagram

\`\`\`mermaid
flowchart LR
  A[Draft] --> B[Feedback]
\`\`\``,
    description: 'Fenced mermaid diagram, rendered client-side (vendored, strict security)',
    category: 'diagrams',
    cssModule: 'diagrams'
  },
  {
    name: 'svg',
    label: 'SVG illustration',
    trigger: '```svg',
    aliases: [],
    triggerWords: ['svg'],
    kind: 'component',
    status: 'unverified',
    object: {
      storage: 'fence',
      widget: 'svg',
      editor: 'source',
      // Duplicated with insert-objects.ts because this registry must stay import-free for compiler
      // parity harnesses; scripts/test-object-blocks.mjs:38-41 pins byte equality.
      emptySkeleton: () =>
        '```svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180">\n  <rect width="320" height="180" rx="12" fill="#f2f0ea"/>\n</svg>\n```'
    },
    sample: `### SVG illustration

\`\`\`svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180">
  <rect width="320" height="180" rx="12" fill="#f2f0ea"/>
</svg>
\`\`\``,
    description: 'Fenced inline SVG, sanitised fail-closed at build time',
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
    titleRegime: 'top',
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
    titleRegime: 'top',
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
    titleRegime: 'top',
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
    titleRegime: 'top',
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
    titleRegime: 'top',
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
    titleRegime: 'top',
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
    titleRegime: 'top',
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
    triggerWords: [],
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
    aliases: ['title=off', 'title=none', 'title=hide'],
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
    status: 'stable',
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

export type ObjectLayoutDef = LayoutDef & { object: ObjectDeclaration }

export interface ObjectInsertEntry {
  name: string
  menuLabel: string
  commandLabel: string
  commandId: `insert-object-${string}`
  action: `insert-${string}`
  route: 'object' | 'layout-picker'
  keywords: string[]
}

export function objectLayoutEntries(
  layouts: readonly LayoutDef[] = LAYOUTS
): ObjectLayoutDef[] {
  return layouts.filter((entry): entry is ObjectLayoutDef => entry.object !== undefined)
}

export function objectLayoutEntryForBlockKind(
  kind: string,
  layouts: readonly LayoutDef[] = LAYOUTS
): ObjectLayoutDef | undefined {
  // GFM and trigger-list tables share the table declaration while retaining their byte-distinct
  // internal block kinds.
  const entryName = kind === 'gfm-table' || kind === 'trigger-table' ? 'table' : kind
  return objectLayoutEntries(layouts).find((entry) => entry.name === entryName)
}

export function isFencedObjectLayout(
  entry: LayoutDef | undefined
): entry is ObjectLayoutDef {
  return entry?.object?.storage === 'fence'
}

export function objectLayoutReadsStorage(
  entry: LayoutDef | undefined,
  storage: ObjectStorage
): entry is ObjectLayoutDef {
  return Boolean(
    entry?.object
    && (
      entry.object.storage === storage
      || entry.object.compatStorage?.includes(storage)
    )
  )
}

const INSERT_PRESENTATION: Record<string, {
  menuLabel?: string
  commandLabel?: string
  keywords?: string[]
}> = {
  table: {
    menuLabel: 'Table',
    commandLabel: 'Insert table',
    keywords: ['insert', 'table', 'object', 'grid']
  },
  mindmap: {
    menuLabel: 'Mindmap',
    commandLabel: 'Insert mindmap',
    keywords: ['insert', 'mindmap', 'object', 'markmap']
  },
  mermaid: {
    menuLabel: 'Mermaid',
    commandLabel: 'Insert Mermaid diagram',
    keywords: ['insert', 'mermaid', 'diagram', 'object', 'flowchart', 'sequence']
  },
  svg: {
    menuLabel: 'SVG',
    commandLabel: 'Insert SVG',
    keywords: ['insert', 'svg', 'object', 'vector']
  }
}

const LAYOUT_FAMILY_INSERTS: ObjectInsertEntry[] = [
  {
    name: 'chart',
    menuLabel: 'Chart',
    commandLabel: 'Insert chart',
    commandId: 'insert-object-chart',
    action: 'insert-chart',
    route: 'layout-picker',
    keywords: ['insert', 'chart', 'object', 'bar', 'pie', 'line']
  },
  {
    name: 'diagram',
    menuLabel: 'Diagram',
    commandLabel: 'Insert diagram…',
    commandId: 'insert-object-diagram',
    action: 'insert-diagram',
    route: 'layout-picker',
    keywords: ['insert', 'diagram', 'object', 'pyramid', 'orgchart', 'concept', 'cycle', 'flow']
  }
]

function insertAfter(
  entries: ObjectInsertEntry[],
  anchor: string,
  inserted: ObjectInsertEntry,
  fallbackIndex: number
): void {
  const anchorIndex = entries.findIndex((entry) => entry.name === anchor)
  entries.splice(anchorIndex >= 0 ? anchorIndex + 1 : fallbackIndex, 0, inserted)
}

export function objectInsertEntries(
  layouts: readonly LayoutDef[] = LAYOUTS
): ObjectInsertEntry[] {
  const objectEntries = objectLayoutEntries(layouts)
  const declaredNames = new Set(objectEntries.map((entry) => entry.name))
  // A resolved alias such as barchart declares its own detection/rendering behaviour, but its
  // resolvesTo key points at the one family entry that owns the insert door.
  const entries = objectEntries
    .filter((entry) => !(
      entry.resolvesTo
      && declaredNames.has(entry.resolvesTo.key)
    ))
    .map((entry): ObjectInsertEntry => {
    const presentation = INSERT_PRESENTATION[entry.name]
    const menuLabel = presentation?.menuLabel
      ?? `${entry.name.slice(0, 1).toUpperCase()}${entry.name.slice(1)}`
    return {
      name: entry.name,
      menuLabel,
      commandLabel: presentation?.commandLabel ?? `Insert ${menuLabel}`,
      commandId: `insert-object-${entry.name}`,
      action: `insert-${entry.name}`,
      route: 'object',
      keywords: presentation?.keywords ?? ['insert', entry.name, 'object', entry.object.editor]
    }
  })
  const chart = entries.find((entry) => entry.name === 'chart')
  if (chart) {
    entries.splice(entries.indexOf(chart), 1)
    insertAfter(entries, 'mindmap', chart, Math.min(2, entries.length))
  } else {
    insertAfter(entries, 'mindmap', LAYOUT_FAMILY_INSERTS[0], Math.min(2, entries.length))
  }
  const svgIndex = entries.findIndex((entry) => entry.name === 'svg')
  if (!entries.some((entry) => entry.name === LAYOUT_FAMILY_INSERTS[1].name)) {
    insertAfter(
      entries,
      'mermaid',
      LAYOUT_FAMILY_INSERTS[1],
      svgIndex >= 0 ? svgIndex : entries.length
    )
  }
  return entries
}
