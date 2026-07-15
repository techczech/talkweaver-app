// Metadata Registry (ADR-0036, presentation-system) — declared, documented, categorical.
//
// Every metadata key the app or the compiler reads MUST be declared here. This module is the
// single source of truth for what a key means, who owns it, and what values are valid; UI
// surfaces (the per-talk Metadata panel, future tag picker and run forms) render FROM these
// entries — never from raw YAML. `scripts/test-metadata-registry.mjs` enforces the categorical
// guarantee: a static scan of the compiler + app source fails the build when a key is read in
// code but missing here.
//
// IMPORTANT: keep this file plain, erasable-syntax TypeScript (interfaces + const data; no
// enums, no namespaces, no parameter properties). It is imported by the main process, the
// renderer, AND the enforcement test (which runs it under Node's native type stripping).

/** Where a key physically lives (ADR-0036 locations). */
export type MetadataLocation = 'frontmatter' | 'trigger' | 'manifest' | 'run'

/** How the key's value is shaped. 'map' keys are structured YAML blocks (edited elsewhere). */
export type MetadataType = 'text' | 'boolean' | 'number' | 'map'

export interface ClosedOption {
  /** The literal value written to the outline ('' = key absent / default). */
  value: string
  /** Short label for the option button. */
  label: string
  /** User-facing, shown when the option is highlighted or picked. */
  explanation: string
}

export type MetadataVocabulary =
  /** Any value; no vault-wide aggregation. */
  | { kind: 'freeform' }
  /** Free values, aggregated vault-wide: a value chosen once is offered everywhere. */
  | { kind: 'open' }
  /** Enumerated AND documented — the UI offers exactly these. */
  | { kind: 'closed'; options: ClosedOption[] }

export interface MetadataEntry {
  /** Canonical key as written in the outline. */
  key: string
  /** Alternate spellings the compiler also accepts (kebab/camel variants). */
  aliases?: string[]
  location: MetadataLocation
  type: MetadataType
  vocabulary: MetadataVocabulary
  /** Field label in the Metadata panel. */
  label: string
  /** Panel section the field renders under (user-editable frontmatter keys only). */
  group?: string
  /** User-facing explanation, shown at choose-time. British English; honest about behaviour. */
  explanation: string
  /**
   * 'user' = fully editable in the UI. 'system' = TalkWeaver manages it: collapsed under the
   * locked System section, deletable only through a confirm that names the consequence.
   */
  ownership: 'user' | 'system'
  /** Required for system keys: what actually breaks when the key is deleted. */
  deleteConsequence?: string
  /** Present = declared for a FUTURE stage (reserved); the version/wave that activates it. */
  since?: string
}

const bool = (onWhat: string, offWhat: string): MetadataVocabulary => ({
  kind: 'closed',
  options: [
    { value: '', label: 'Default', explanation: 'Key absent — the compiler default applies.' },
    { value: 'true', label: 'On', explanation: onWhat },
    { value: 'false', label: 'Off', explanation: offWhat }
  ]
})

export const METADATA_REGISTRY: MetadataEntry[] = [
  // ── Cover & identity ─────────────────────────────────────────────────────────
  {
    key: 'title',
    location: 'frontmatter',
    type: 'text',
    vocabulary: { kind: 'freeform' },
    label: 'Title',
    group: 'Cover & identity',
    explanation:
      'The talk’s name — shown on the cover slide and in the Talks panel, exactly as you write it (never re-capitalised). Renaming here retitles the talk only; use Rename in the Talks panel to move its folder too.',
    ownership: 'user'
  },
  {
    key: 'subtitle',
    location: 'frontmatter',
    type: 'text',
    vocabulary: { kind: 'freeform' },
    label: 'Subtitle',
    group: 'Cover & identity',
    explanation:
      'A second line for the cover slide, used when no event is set. Also shown under the talk in the Talks panel.',
    ownership: 'user'
  },
  {
    key: 'event',
    location: 'frontmatter',
    type: 'text',
    vocabulary: { kind: 'open' },
    label: 'Event',
    group: 'Cover & identity',
    explanation:
      'Where this talk was or will be given — appears under the title on the cover slide and in the closing sign-off. Pick an event you have used before, or type a new one; it will be offered in every future talk.',
    ownership: 'user'
  },
  {
    key: 'author',
    location: 'frontmatter',
    type: 'text',
    vocabulary: { kind: 'freeform' },
    label: 'Author',
    group: 'Cover & identity',
    explanation:
      'Who is giving the talk. Shown on the cover slide and woven into the closing slide’s sign-off line.',
    ownership: 'user'
  },
  {
    key: 'hide_email',
    aliases: ['hide-email'],
    location: 'frontmatter',
    type: 'boolean',
    vocabulary: bool(
      'Any e-mail address is stripped from the author line on the cover — for decks that will be published.',
      'The author line renders exactly as written, e-mail included.'
    ),
    label: 'Hide e-mail',
    group: 'Cover & identity',
    explanation:
      'Strips any e-mail address from the author line on the compiled cover slide — useful when the deck will be published.',
    ownership: 'user'
  },

  // ── Presenting ───────────────────────────────────────────────────────────────
  {
    key: 'duration',
    location: 'frontmatter',
    type: 'text',
    vocabulary: { kind: 'freeform' },
    label: 'Duration',
    group: 'Presenting',
    explanation:
      'Talk length for the presenter’s countdown clock — e.g. 60min, 1:30 or 90. Without it the presenter shows elapsed time only.',
    ownership: 'user'
  },
  {
    key: 'warn-at',
    aliases: ['warn_at'],
    location: 'frontmatter',
    type: 'number',
    vocabulary: { kind: 'freeform' },
    label: 'Warn at (minutes left)',
    group: 'Presenting',
    explanation:
      'How many minutes before the deadline the presenter clock turns amber. Overrides the app-wide Timer setting for this talk (default 5).',
    ownership: 'user'
  },
  {
    key: 'urgent-at',
    aliases: ['urgent_at'],
    location: 'frontmatter',
    type: 'number',
    vocabulary: { kind: 'freeform' },
    label: 'Urgent at (minutes left)',
    group: 'Presenting',
    explanation:
      'How many minutes before the deadline the presenter clock turns dark amber — the final warning. Overrides the app-wide Timer setting for this talk (default 1).',
    ownership: 'user'
  },

  // ── Opening & closing slides ─────────────────────────────────────────────────
  {
    key: 'auto_title_slide',
    location: 'frontmatter',
    type: 'boolean',
    vocabulary: bool(
      'The compiler builds the opening title slide from this metadata (the default behaviour).',
      'No automatic cover — the deck starts on your first authored slide, or your own {role=opening} slide.'
    ),
    label: 'Automatic title slide',
    group: 'Opening & closing',
    explanation:
      'Whether the compiler builds the opening cover slide from title, event and author. Turn off when you author your own opening slide.',
    ownership: 'user'
  },
  {
    key: 'auto_thanks_slide',
    location: 'frontmatter',
    type: 'boolean',
    vocabulary: bool(
      'The compiler appends a closing “Thank you” slide (the default behaviour).',
      'No automatic closing slide — the deck ends on your last authored slide, or your own {role=ending} slide.'
    ),
    label: 'Automatic thanks slide',
    group: 'Opening & closing',
    explanation:
      'Whether the compiler appends a closing slide built from the thanks text, call to action, author and event.',
    ownership: 'user'
  },
  {
    key: 'thanks',
    location: 'frontmatter',
    type: 'text',
    vocabulary: { kind: 'freeform' },
    label: 'Thanks text',
    group: 'Opening & closing',
    explanation: 'The automatic closing slide’s headline. Defaults to “Thank you”.',
    ownership: 'user'
  },
  {
    key: 'series',
    location: 'frontmatter',
    type: 'text',
    vocabulary: { kind: 'freeform' },
    label: 'Series name',
    group: 'Title & identity',
    explanation: 'The talk-series line on the title poster (e.g. “AI & Expertise series”).',
    ownership: 'user'
  },
  {
    key: 'date',
    location: 'frontmatter',
    type: 'text',
    vocabulary: { kind: 'freeform' },
    label: 'Talk date',
    group: 'Title & identity',
    explanation: 'The date shown on the title and closing posters.',
    ownership: 'user'
  },
  {
    key: 'web',
    location: 'frontmatter',
    type: 'text',
    vocabulary: { kind: 'freeform' },
    label: 'Web address',
    group: 'Title & identity',
    explanation: 'The speaker’s web address on the title and closing posters.',
    ownership: 'user'
  },
  {
    key: 'affiliation',
    location: 'frontmatter',
    type: 'text',
    vocabulary: { kind: 'freeform' },
    label: 'Affiliation',
    group: 'Title & identity',
    explanation: 'The speaker’s affiliation on the title and closing posters.',
    ownership: 'user'
  },
  {
    key: 'title_style',
    location: 'frontmatter',
    type: 'text',
    vocabulary: { kind: 'closed', options: [{ value: 'poster', label: 'Poster', explanation: 'White poster with metadata bands (default).' }, { value: 'split', label: 'Split', explanation: 'Narrow tinted sidebar; title and author in the main column.' }, { value: 'banner', label: 'Banner', explanation: 'Centred title with an accent identity footer.' }] },
    label: 'Title slide style',
    group: 'Title & identity',
    explanation: 'Which locked ADR-0005 title design the poster uses: poster (default), split or banner.',
    ownership: 'user'
  },
  {
    key: 'font',
    location: 'frontmatter',
    type: 'text',
    vocabulary: { kind: 'closed', options: [{ value: 'trebuchet', label: 'Trebuchet', explanation: 'Trebuchet MS — the locked deck face (default).' }, { value: 'gill-sans', label: 'Gill Sans', explanation: 'Gill Sans / Gill Sans MT.' }, { value: 'verdana', label: 'Verdana', explanation: 'Verdana — widest, most conservative.' }] },
    label: 'Deck face',
    group: 'Design',
    explanation: 'Deck font option: trebuchet (default), gill-sans or verdana (ADR-0005).',
    ownership: 'user'
  },
  {
    key: 'cta',
    location: 'frontmatter',
    type: 'text',
    vocabulary: { kind: 'freeform' },
    label: 'Call to action',
    group: 'Opening & closing',
    explanation:
      'One line shown on the automatic closing slide beneath the thanks — where to find you, what to read next.',
    ownership: 'user'
  },
  {
    key: 'links_index',
    aliases: ['links-index'],
    location: 'frontmatter',
    type: 'boolean',
    vocabulary: bool(
      'The compiler collects every link in the deck onto an automatic “Links” slide near the end.',
      'No automatic links slide (the default).'
    ),
    label: 'Automatic links slide',
    group: 'Opening & closing',
    explanation:
      'Adds an automatic slide near the end collecting every URL used in the deck, so the audience can find them in one place.',
    ownership: 'user'
  },

  // ── Appearance ───────────────────────────────────────────────────────────────
  {
    key: 'palette',
    location: 'frontmatter',
    type: 'text',
    vocabulary: {
      kind: 'closed',
      options: [
        { value: '', label: 'Default', explanation: 'The default Oxford-blue / crimson accent cycle.' },
        { value: 'green', label: 'Green', explanation: 'The green alternate accent cycle — the only alternate the compiler honours.' }
      ]
    },
    label: 'Palette',
    group: 'Appearance',
    explanation:
      'The deck’s accent colour cycle. Only the documented alternate is honoured; any other value silently keeps the default.',
    ownership: 'user'
  },
  {
    key: 'section_labels',
    aliases: ['section-labels'],
    location: 'frontmatter',
    type: 'boolean',
    vocabulary: {
      kind: 'closed',
      options: [
        { value: '', label: 'Off', explanation: 'No automatic section labels (the default). An explicit {kicker=…} still shows.' },
        { value: 'on', label: 'On', explanation: 'Each slide shows its section’s title as a small kicker label above the heading.' }
      ]
    },
    label: 'Section labels',
    group: 'Appearance',
    explanation:
      'Shows each section’s title as a small kicker label on its slides. Off by default; an explicit {kicker=…} on a slide always shows.',
    ownership: 'user'
  },
  {
    key: 'triggers',
    location: 'frontmatter',
    type: 'text',
    vocabulary: { kind: 'freeform' },
    label: 'Deck-wide triggers',
    group: 'Appearance',
    explanation:
      'Default trigger words applied to every slide — the same vocabulary as a slide’s {…} line (e.g. reveal numbered), overridden by anything a slide sets itself. layout and id are ignored here.',
    ownership: 'user'
  },
  {
    key: 'defaults',
    location: 'frontmatter',
    type: 'map',
    vocabulary: { kind: 'freeform' },
    label: 'Frame defaults',
    group: 'Appearance',
    explanation:
      'Deck-level frame defaults (image side, title placement…) applied to every slide. Edited on the Deck design panel — shown here for completeness.',
    ownership: 'user'
  },
  {
    key: 'sections',
    location: 'frontmatter',
    type: 'map',
    vocabulary: { kind: 'freeform' },
    label: 'Per-section frame overrides',
    group: 'Appearance',
    explanation:
      'Frame overrides keyed by section title — the section’s slides inherit them over the deck defaults. Advanced; edited as raw YAML in the outline.',
    ownership: 'user'
  },
  {
    key: 'icons',
    location: 'frontmatter',
    type: 'map',
    vocabulary: { kind: 'freeform' },
    label: 'Icon overrides',
    group: 'Appearance',
    explanation:
      'A concept-phrase → icon-name map that overrides the automatic icon vocabulary for this deck. Advanced; edited as raw YAML in the outline.',
    ownership: 'user'
  },

  // ── Licence & credits ────────────────────────────────────────────────────────
  {
    key: 'license',
    location: 'frontmatter',
    type: 'text',
    vocabulary: {
      kind: 'closed',
      options: [
        { value: '', label: 'None', explanation: 'No licence popup on the compiled deck.' },
        { value: 'by', label: 'CC BY', explanation: 'Reuse allowed with attribution.' },
        { value: 'by-sa', label: 'CC BY-SA', explanation: 'Reuse with attribution; derivatives must carry the same licence.' },
        { value: 'by-nc', label: 'CC BY-NC', explanation: 'Non-commercial reuse with attribution.' },
        { value: 'by-nd', label: 'CC BY-ND', explanation: 'Verbatim redistribution with attribution; no derivatives.' },
        { value: 'by-nc-sa', label: 'CC BY-NC-SA', explanation: 'Non-commercial, attribution, share-alike.' },
        { value: 'by-nc-nd', label: 'CC BY-NC-ND', explanation: 'Non-commercial verbatim redistribution with attribution.' },
        { value: 'CC0', label: 'CC0', explanation: 'Public-domain dedication — no rights reserved.' }
      ]
    },
    label: 'Licence',
    group: 'Licence & credits',
    explanation:
      'A Creative Commons licence for the deck — shown as a footer popup on the compiled presentation and its handout, linking to the licence text.',
    ownership: 'user'
  },
  {
    key: 'license-note',
    aliases: ['licenseNote'],
    location: 'frontmatter',
    type: 'text',
    vocabulary: { kind: 'freeform' },
    label: 'Licence note',
    group: 'Licence & credits',
    explanation: 'A free-text line added to the licence popup — exceptions, requests, or context.',
    ownership: 'user'
  },
  {
    key: 'license-url',
    aliases: ['licenseUrl'],
    location: 'frontmatter',
    type: 'text',
    vocabulary: { kind: 'freeform' },
    label: 'Licence URL',
    group: 'Licence & credits',
    explanation: 'Overrides the link the licence popup points to (otherwise the standard CC deed).',
    ownership: 'user'
  },
  {
    key: 'credits',
    aliases: ['attribution', 'icon-credits'],
    location: 'frontmatter',
    type: 'text',
    vocabulary: { kind: 'freeform' },
    label: 'Credits',
    group: 'Licence & credits',
    explanation:
      'Attribution lines (images, icons, sources) listed in the licence popup. Accepts a single line here; a YAML list in the outline also works.',
    ownership: 'user'
  },

  // ── System-managed (frontmatter) ─────────────────────────────────────────────
  {
    key: 'outline_version',
    aliases: ['outline-version'],
    location: 'frontmatter',
    type: 'number',
    vocabulary: { kind: 'freeform' },
    label: 'Outline version',
    explanation:
      'Stamped by migrations — records which outline-format upgrades have already run, so the app never re-offers them.',
    ownership: 'system',
    deleteConsequence:
      'TalkWeaver will treat this outline as unmigrated and offer the v2 migration again on next open (writing a .bak backup).'
  },
  {
    key: 'handout_url',
    location: 'frontmatter',
    type: 'text',
    vocabulary: { kind: 'freeform' },
    label: 'Handout URL',
    explanation:
      'Stamped when you publish the handout to Cloudflare Pages. The compiled deck renders it as the corner QR code and short link, and History’s delivered-talks ledger reads it.',
    ownership: 'system',
    deleteConsequence:
      'the QR code and short link disappear from the next build, and History stops listing this talk as published. Re-publishing stamps it again.'
  },

  // ── System-managed (Trigger line) ────────────────────────────────────────────
  {
    key: 'id',
    location: 'trigger',
    type: 'text',
    vocabulary: { kind: 'freeform' },
    label: 'Slide identity ({id=…})',
    explanation:
      'Every slide’s identity stamp, written into its {…} trigger line on save. Version history, where-used, cross-talk adoption and future tag aggregation all hang off it.',
    ownership: 'system',
    deleteConsequence:
      'the slide loses its history — the next save mints a fresh id with an empty ledger, and where-used links to other talks break.'
  },

  // ── Slide tags (ADR-0037, active since 0.15 wave 1 stage 2) ─────────────────
  {
    key: 'tags',
    location: 'trigger',
    type: 'text',
    vocabulary: { kind: 'open' },
    label: 'Tags',
    explanation:
      'Curated labels on a slide’s {id=… tags=…} line, lowercase-kebab, per slide copy. Set them from the Slide Browser (select slides, press T) or “Tag current slide…” in the command palette; every tag used anywhere in the vault is offered with counts. Browser tag FILTERS arrive with the unified rail.',
    ownership: 'user'
  },

  // ── Reserved for later v0.15+ stages (declared now, built later — ADR-0036) ──
  {
    key: 'audience',
    location: 'run',
    type: 'text',
    vocabulary: { kind: 'open' },
    label: 'Audience',
    explanation:
      'The audience or host for this particular delivery. Values chosen anywhere in the vault are suggested in future Run planners.',
    ownership: 'user',
    since: '0.17 (ADR-0038)'
  },
  {
    key: 'clonedFrom',
    location: 'frontmatter',
    type: 'text',
    vocabulary: { kind: 'freeform' },
    label: 'Cloned from',
    explanation:
      'Records which talk this one was cloned from, so the Browser can link slide families across generations.',
    ownership: 'system',
    deleteConsequence:
      'family detection breaks for this talk — the Browser stops linking its slides to the original’s.',
    since: '0.17 (ADR-0039)'
  },
  {
    key: 'pathways',
    location: 'manifest',
    type: 'text',
    vocabulary: { kind: 'freeform' },
    label: 'Pathways',
    explanation:
      'Named, ordered slide-id lenses stored in the Talk manifest. Each pathway keeps one optional note and one ordered slideIds list; the outline itself never changes.',
    ownership: 'user'
  },
  {
    key: 'pathwayId',
    location: 'run',
    type: 'text',
    vocabulary: { kind: 'freeform' },
    label: 'Run pathway',
    explanation:
      'The pathway lens used for a Run, or null when the whole Talk was presented. This keeps History honest about the exact slide set delivered.',
    ownership: 'system',
    deleteConsequence:
      'History can no longer identify which pathway supplied this Run’s slide set, although the recorded slide-time index remains intact.'
  },
  {
    key: 'status',
    location: 'run',
    type: 'text',
    vocabulary: { kind: 'closed', options: [
      { value: 'planned', label: 'Planned', explanation: 'The Run exists in advance and has not yet been delivered.' },
      { value: 'delivered', label: 'Delivered', explanation: 'The Run has delivery timing or recording data. A missing status on a legacy record means delivered.' }
    ] },
    label: 'Run status',
    explanation: 'Distinguishes an upcoming planned Run from a completed delivery; legacy Run files without this key remain delivered.',
    ownership: 'system',
    deleteConsequence: 'A planned Run would be interpreted as a completed legacy delivery.'
  },
  {
    key: 'plannedDate',
    location: 'run',
    type: 'text',
    vocabulary: { kind: 'freeform' },
    label: 'Planned date',
    explanation: 'The event date in YYYY-MM-DD form. It stays on the Run when the planned entry becomes a delivered one.',
    ownership: 'user'
  },
  {
    key: 'eventTitle',
    location: 'run',
    type: 'text',
    vocabulary: { kind: 'freeform' },
    label: 'Event',
    explanation: 'The event or delivery name shown in History and printed beneath the talk title on this Run’s handout cover.',
    ownership: 'user'
  },
  {
    key: 'slideSet',
    location: 'run',
    type: 'map',
    vocabulary: { kind: 'freeform' },
    label: 'Slide set',
    explanation: 'The exact source for this Run: either the full talk or one named pathway. Pathway order controls delivery and Run-handout order.',
    ownership: 'user'
  },
  {
    key: 'handoutUrl',
    location: 'run',
    type: 'text',
    vocabulary: { kind: 'freeform' },
    label: 'Run handout URL',
    explanation: 'The independently published handout for this Run. It never changes the evergreen handout_url in the talk outline.',
    ownership: 'system',
    deleteConsequence: 'History loses the link to this Run’s published handout; the evergreen talk handout remains unchanged.'
  }
]

// ── Lookup helpers (shared by main, renderer, and the enforcement test) ────────

/** Every accepted spelling (canonical keys + aliases), across ALL entries incl. reserved. */
export function registeredKeyNames(): Set<string> {
  const names = new Set<string>()
  for (const e of METADATA_REGISTRY) {
    names.add(e.key)
    for (const a of e.aliases ?? []) names.add(a)
  }
  return names
}

export function findEntry(key: string): MetadataEntry | null {
  for (const e of METADATA_REGISTRY) {
    if (e.key === key || (e.aliases ?? []).includes(key)) return e
  }
  return null
}

/** Fields the Metadata panel renders as editable: active (no `since`), user-owned frontmatter. */
export function activeUserFrontmatterEntries(): MetadataEntry[] {
  return METADATA_REGISTRY.filter(
    (e) => e.ownership === 'user' && e.location === 'frontmatter' && !e.since
  )
}

/** System-owned frontmatter keys (active only) — the locked System section's row source. */
export function systemFrontmatterEntries(): MetadataEntry[] {
  return METADATA_REGISTRY.filter(
    (e) => e.ownership === 'system' && e.location === 'frontmatter' && !e.since
  )
}

/** Active open-vocabulary frontmatter keys — vault:vocabulary aggregates observed values for these. */
export function openVocabularyFrontmatterKeys(): string[] {
  return METADATA_REGISTRY.filter(
    (e) => e.location === 'frontmatter' && e.vocabulary.kind === 'open' && !e.since
  ).map((e) => e.key)
}
