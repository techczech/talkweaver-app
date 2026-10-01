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
  /**
   * True when the key is IDENTITY or HOUSE STYLE — stable across talks, so the app may hold one
   * value in Settings and pre-fill it into new outlines (Ticket 9b). Never set on per-talk
   * content (title, event, date, duration), on a map key, on a key that already has its own
   * app-wide default elsewhere in Settings (warn-at / urgent-at → Settings → Timer), or on a
   * system key.
   */
  defaultable?: boolean
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
    defaultable: true,
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
    defaultable: true,
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
      'How many minutes before the deadline the presenter clock turns amber. Overrides the app-wide Timer setting for this talk (default 5). A value that is not a number of minutes falls back to that setting and raises a compiler warning.',
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
      'How many minutes before the deadline the presenter clock turns dark amber — the final warning. Overrides the app-wide Timer setting for this talk (default 1). It can never be earlier than the amber threshold: a larger value is brought back to “Warn at”, with a compiler warning saying so.',
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
      'Whether the compiler builds the opening cover slide from title, event and author. Turn off when you author your own opening slide — a slide you mark {role=opening} already suppresses it without this key.',
    defaultable: true,
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
      'Whether the compiler appends a closing slide built from the thanks text, call to action, author and event. A slide you mark {role=ending} already suppresses it without this key.',
    defaultable: true,
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
    defaultable: true,
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
    defaultable: true,
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
    defaultable: true,
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
    defaultable: true,
    ownership: 'user'
  },
  {
    key: 'colour',
    aliases: ['accent'],
    location: 'frontmatter',
    type: 'text',
    vocabulary: {
      kind: 'closed',
      options: [
        { value: '', label: 'Automatic', explanation: 'Key absent — the title slides use the section accent the palette cycle gives them.' },
        { value: 'cobalt', label: 'Cobalt', explanation: 'Use the cobalt section accent on the title slides.' },
        { value: 'emerald', label: 'Emerald', explanation: 'Use the emerald section accent on the title slides.' },
        { value: 'vermilion', label: 'Vermilion', explanation: 'Use the vermilion section accent on the title slides.' },
        { value: 'forest', label: 'Forest', explanation: 'Use the forest accent from the green palette on the title slides.' }
      ]
    },
    label: 'Title colour',
    group: 'Title & identity',
    explanation:
      'The named section accent used for the opening and closing title slides. All four names work whatever the palette — forest is the green palette’s lead accent but is honoured on a default-palette deck too. An unlisted name keeps the automatic accent and raises a compiler warning.',
    defaultable: true,
    ownership: 'user'
  },
  {
    key: 'logo',
    location: 'frontmatter',
    type: 'text',
    vocabulary: { kind: 'freeform' },
    label: 'Title-slide logo',
    group: 'Title & identity',
    explanation: 'Title-slide logo — asset path or registered logo key.',
    defaultable: true,
    ownership: 'user'
  },
  {
    key: 'title_style',
    location: 'frontmatter',
    type: 'text',
    vocabulary: { kind: 'closed', options: [{ value: '', label: 'Default (poster)', explanation: 'Key absent — the compiler uses the poster design.' }, { value: 'poster', label: 'Poster', explanation: 'White poster with metadata bands (default).' }, { value: 'split', label: 'Split', explanation: 'Narrow tinted sidebar; title and author in the main column.' }, { value: 'banner', label: 'Banner', explanation: 'Centred title with an accent identity footer.' }] },
    label: 'Title slide style',
    group: 'Title & identity',
    explanation:
      'Which locked ADR-0005 title design the poster uses: poster (default), split or banner. It sets the OPENING slide only — the closing slide always uses the closing poster. An unlisted style falls back to poster and raises a compiler warning.',
    defaultable: true,
    ownership: 'user'
  },
  {
    key: 'font',
    location: 'frontmatter',
    type: 'text',
    vocabulary: { kind: 'closed', options: [{ value: '', label: 'Default (Trebuchet MS)', explanation: 'Key absent — the locked Trebuchet MS deck face.' }, { value: 'trebuchet', label: 'Trebuchet', explanation: 'Trebuchet MS — the locked deck face (default).' }, { value: 'gill-sans', label: 'Gill Sans', explanation: 'Gill Sans / Gill Sans MT.' }, { value: 'verdana', label: 'Verdana', explanation: 'Verdana — widest, most conservative.' }] },
    label: 'Deck face',
    group: 'Design',
    explanation:
      'Deck font option: trebuchet (default), gill-sans or verdana (ADR-0005). Choosing Trebuchet renders exactly as leaving the key out — it is the locked house face. An unlisted face keeps the house face and raises a compiler warning.',
    defaultable: true,
    ownership: 'user'
  },
  {
    key: 'title_look',
    aliases: ['title-look'],
    location: 'frontmatter',
    type: 'text',
    vocabulary: {
      kind: 'closed',
      options: [
        { value: '', label: 'Default', explanation: 'Key absent — the plain centred top title.' },
        { value: 'default', label: 'Default', explanation: 'The plain centred top title.' },
        { value: 'kicker', label: 'Kicker', explanation: 'A small sentence-case mono line in the section colour, led by a short accent rule.' },
        { value: 'label', label: 'Label', explanation: 'A tinted tab with a coloured left edge.' },
        { value: 'tab', label: 'Tab', explanation: 'A solid accent tab flush with the slide edge.' }
      ]
    },
    label: 'Title look',
    group: 'Design',
    explanation:
      'How a top title is drawn across the talk: default, kicker, label or tab. A section’s own titlelook in sections: and a slide’s {titlelook=…} override it, in that order. It never touches the opening slide’s title_style, and left-rail titles are unchanged. An unlisted value falls back to default and raises a compiler warning.',
    defaultable: true,
    ownership: 'user'
  },
  {
    key: 'title_look_at',
    aliases: ['title-look-at'],
    location: 'frontmatter',
    type: 'text',
    vocabulary: {
      kind: 'closed',
      options: [
        { value: '', label: 'Normal', explanation: 'Key absent — the kicker keeps the usual top margin.' },
        { value: 'normal', label: 'Normal', explanation: 'The kicker keeps the usual top margin.' },
        { value: 'edge', label: 'Near top edge', explanation: 'The kicker sits near the top edge and the body gets the height.' }
      ]
    },
    label: 'Kicker placement',
    group: 'Design',
    explanation: 'Where a Kicker title sits when the talk’s title look is kicker: normal or near the top edge. Ignored for the other looks.',
    defaultable: true,
    ownership: 'user'
  },
  {
    key: 'claim_style',
    aliases: ['claim-style'],
    location: 'frontmatter',
    type: 'text',
    vocabulary: {
      kind: 'closed',
      options: [
        { value: '', label: 'Default (plain)', explanation: 'Key absent — a claim is set one type step larger, in ink, with no bar.' },
        { value: 'plain', label: 'Plain', explanation: 'One type step larger than body copy, in ink, no bar (the default).' },
        { value: 'bar', label: 'Bar', explanation: 'Body size with a section-accent bar down the left of the claim.' }
      ]
    },
    label: 'Claim style',
    group: 'Design',
    explanation:
      'How a wholly bold paragraph is set: plain (one step larger) or bar (ADR-0023 §4). A claim is never bold. A slide’s own {claim=…} overrides this; an unlisted style falls back to plain and raises a compiler warning.',
    defaultable: true,
    ownership: 'user'
  },
  {
    key: 'narrow_columns',
    aliases: ['narrow-columns'],
    location: 'frontmatter',
    type: 'boolean',
    vocabulary: bool(
      'Columns that would be narrower than 22cqw change shape: an icon row of five or more wraps to rows of three, cards beside a rail become icon rows (the default behaviour).',
      'Columns stay as authored, however narrow.'
    ),
    label: 'Reshape narrow columns',
    group: 'Design',
    explanation:
      'Whether columns too narrow for their words (under 22cqw, about 12 characters at body size) change shape (ADR-0033 §5). An authored {iconlist=boxes|list} shape always wins, and a slide’s own {narrowcols=on|off} overrides this key.',
    defaultable: true,
    ownership: 'user'
  },
  {
    key: 'screenshot_style',
    aliases: ['screenshot-style'],
    location: 'frontmatter',
    type: 'text',
    vocabulary: {
      kind: 'closed',
      options: [
        { value: '', label: 'Default (window frames)', explanation: 'Key absent — two or three screenshots in a row sit in light app windows, cropped from their top-left.' },
        { value: 'frames', label: 'Window frames', explanation: 'Each screenshot in a light app window, cropped from its top-left so it stays crisp (the default).' },
        { value: 'fanned', label: 'Fanned', explanation: 'Prints with a white border, turned a few degrees and overlapping, captions upright.' }
      ]
    },
    label: 'Screenshot row',
    group: 'Design',
    explanation:
      'How two or three screenshots in one row are drawn: window frames (default) or fanned (ADR-0033 §4). They always stay one row. A slide’s own {screenshots=…} overrides this; an unlisted style falls back to window frames and raises a compiler warning.',
    defaultable: true,
    ownership: 'user'
  },
  {
    key: 'screenshot_list',
    aliases: ['screenshot-list'],
    location: 'frontmatter',
    type: 'text',
    vocabulary: {
      kind: 'closed',
      options: [
        { value: '', label: 'Default (beside lines)', explanation: 'Key absent — each screenshot sits as a thumbnail beside its list line.' },
        { value: 'beside', label: 'Beside lines', explanation: 'Each screenshot as an equal thumbnail beside its line, cropped from its top-left and framed (the default).' },
        { value: 'stacked', label: 'Stacked', explanation: 'Each screenshot above its caption, side by side in one row.' }
      ]
    },
    label: 'Screenshots beside a list',
    group: 'Design',
    explanation:
      'How a list whose lines each carry a screenshot is drawn: thumbnails beside the lines (default) or stacked, each screenshot above its caption (ADR-0033 §4). A slide’s own {shotlist=…} overrides this; an unlisted arrangement falls back to beside lines and raises a compiler warning.',
    defaultable: true,
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
    defaultable: true,
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
      'Adds an automatic slide near the end collecting every URL used in the deck, so the audience can find them in one place. It needs at least one link in the deck (a compiler warning says so when there is none), and a slide you mark {links} yourself takes its place.',
    defaultable: true,
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
      'The deck’s accent colour cycle. Only the documented alternate is honoured; any other value keeps the default and raises a compiler warning naming the value.',
    defaultable: true,
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
      'Shows each section’s title as a small kicker label on its slides. Off by default; an explicit {kicker=…} on a slide always shows. On, true, yes and show all switch it on.',
    defaultable: true,
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
    defaultable: true,
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
  {
    key: 'logo-colour',
    aliases: ['logo-color'],
    location: 'frontmatter',
    type: 'text',
    vocabulary: {
      kind: 'closed',
      options: [
        { value: '', label: 'Default', explanation: 'Key absent — a slide mixing colour and silhouette-only brand marks is brought to the deck accent colour (the unified default).' },
        { value: 'unified', label: 'Unified accent', explanation: 'A slide mixing colour and silhouette-only brand marks renders every mark in the deck accent colour, so the row reads as one system.' },
        { value: 'brand', label: 'Brand colours', explanation: 'Each brand keeps its real colours where TalkWeaver has them; brands that exist only as a single-colour silhouette render flat, which is more recognisable but visually uneven.' }
      ]
    },
    label: 'Logo colour',
    group: 'Appearance',
    explanation:
      'How brand logos on a {logolist} slide are coloured when the slide mixes full-colour marks with single-colour silhouettes. The default brings the whole row down to the deck accent so it reads as one system; “Brand colours” keeps each brand’s real colours instead, at the cost of an uneven row. It changes nothing on a deck with no brand marks, and an unlisted value raises a compiler warning.',
    defaultable: true,
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
      'A Creative Commons licence for the deck — shown as a footer popup on the compiled presentation and its handout, linking to the licence text. A licence outside this list is not ignored: it is shown verbatim as written, and Licence URL supplies its link.',
    defaultable: true,
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
    defaultable: true,
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
    defaultable: true,
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
    defaultable: true,
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

  {
    key: 'share_url',
    location: 'frontmatter',
    type: 'text',
    vocabulary: { kind: 'freeform' },
    label: 'Shared for comments',
    explanation:
      'Stamped when you share the talk for comments (Share → Share for comments…): the link colleagues open to read the talk and comment. Stop sharing removes it.',
    ownership: 'system',
    deleteConsequence:
      'the outline no longer records its comment link. Sharing itself carries on until you choose Stop sharing; sharing again writes it back.'
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
  {
    key: 'poll',
    location: 'trigger',
    type: 'text',
    vocabulary: { kind: 'closed', options: [
      { value: 'single', label: 'Single choice', explanation: 'Each audience member chooses one option from the slide list.' },
      { value: 'multiple', label: 'Multiple choice', explanation: 'Each audience member chooses one or more options from the slide list.' },
      { value: 'open', label: 'Open response', explanation: 'Each audience member submits a free-text response; slide list items are not used.' },
      { value: 'ranking', label: 'Ranking', explanation: 'Rank every list item, or exactly the number specified by polltop.' },
      { value: 'rating', label: 'Rating', explanation: 'Rate each list item using the ordered labels in [scale: …].' },
      { value: 'categorisation', label: 'Categorisation', explanation: 'Assign each list item a label from [categories: …].' },
      { value: 'board', label: 'Board', explanation: 'A feedback board: the audience adds short cards to the columns in the slide list (two to four; a nested bullet is a column’s hint). The paragraph under the title is the instructions and a “>” line the example card.' }
    ] },
    label: 'Poll type',
    explanation: 'Turns the slide into a live poll whose question is the slide title and whose choice options are its list items.',
    ownership: 'user'
  },
  // ── Board settings (ADR-0032 §2–3, §7; ticket 01): written only when they differ from the default ──
  {
    key: 'limit', location: 'trigger', type: 'text',
    vocabulary: { kind: 'closed', options: [
      { value: '', label: '24', explanation: 'Up to 24 cards on the big screen, the most that stay above the minimum text size (the default). Beyond it new cards wait on the phones.' },
      { value: '12', label: '12', explanation: 'Up to 12 cards on the big screen; the rest wait until you release them.' },
      { value: '36', label: '36', explanation: 'Up to 36 cards on the big screen, in smaller type.' },
      { value: 'all', label: 'All', explanation: 'Every card on the big screen, as large as fits.' }
    ] },
    label: 'Big screen shows',
    explanation: 'On a board slide, how many cards the big screen shows before new cards wait (a group counts once). Phones always show every card.',
    ownership: 'user'
  },
  {
    key: 'length', location: 'trigger', type: 'text',
    vocabulary: { kind: 'closed', options: [
      { value: '', label: '140', explanation: 'A card holds up to 140 characters (the default).' },
      { value: '60', label: '60', explanation: 'A card holds up to 60 characters.' },
      { value: '100', label: '100', explanation: 'A card holds up to 100 characters.' },
      { value: '200', label: '200', explanation: 'A card holds up to 200 characters.' }
    ] },
    label: 'Card length',
    explanation: 'On a board slide, the most characters one card may hold.',
    ownership: 'user'
  },
  {
    key: 'cards', location: 'trigger', type: 'text',
    vocabulary: { kind: 'closed', options: [
      { value: '', label: '5', explanation: 'Each phone may add up to 5 cards (the default).' },
      { value: '1', label: '1', explanation: 'Each phone may add one card.' },
      { value: '3', label: '3', explanation: 'Each phone may add up to 3 cards.' },
      { value: '10', label: '10', explanation: 'Each phone may add up to 10 cards.' }
    ] },
    label: 'Cards per phone',
    explanation: 'On a board slide, how many cards one phone may add. A number here never means the cards layout; {cards=grid|rows|stepped} still does.',
    ownership: 'user'
  },
  {
    key: 'names', location: 'trigger', type: 'boolean',
    vocabulary: { kind: 'closed', options: [
      { value: '', label: 'Off', explanation: 'Cards carry no names (the default).' },
      { value: 'optional', label: 'Optional', explanation: 'Written {names}: a participant may add a name to a card; only you see it.' }
    ] },
    label: 'Names',
    explanation: 'On a board slide, whether participants may add an optional name to their cards. Names never show on the big screen.',
    ownership: 'user'
  },
  {
    key: 'closes', location: 'trigger', type: 'text',
    vocabulary: { kind: 'closed', options: [
      { value: '', label: '7 days', explanation: 'A board left open after the talk closes by itself after 7 days (the default).' },
      { value: '1d', label: '1 day', explanation: 'A board left open closes after 1 day.' },
      { value: '30d', label: '30 days', explanation: 'A board left open closes after 30 days.' }
    ] },
    label: 'Left open, closes',
    explanation: 'On a board slide, how long a board left open after the talk keeps taking cards; you can close it sooner in History.',
    ownership: 'user'
  },
  {
    key: 'polltop',
    location: 'trigger',
    type: 'number',
    vocabulary: { kind: 'open' },
    label: 'Number to rank',
    explanation: 'Ranking polls require exactly this many choices, from 1 to the number of list items. Omit to rank all items.',
    ownership: 'user'
  },
  {
    key: 'pollskip',
    location: 'trigger',
    type: 'boolean',
    vocabulary: { kind: 'closed', options: [
      { value: 'false', label: 'Required', explanation: 'Every rating or categorisation row requires an answer; this is the default.' },
      { value: 'true', label: 'Allow skipping', explanation: 'Audience members may explicitly skip a rating or categorisation row.' }
    ] },
    label: 'Allow skipped rows',
    explanation: 'Controls whether audience members may skip rows in rating and categorisation polls.',
    ownership: 'user'
  },
  {
    key: 'pollresults',
    location: 'trigger',
    type: 'text',
    vocabulary: { kind: 'closed', options: [
      { value: 'live', label: 'Live', explanation: 'Audience results update as votes arrive; this is the default when the key is absent.' },
      { value: 'held', label: 'Held', explanation: 'Audience members see only that their answer was recorded until the presenter reveals results.' }
    ] },
    label: 'Poll result visibility',
    explanation: 'Controls whether the audience sees poll results immediately or waits for the presenter to reveal them.',
    ownership: 'user'
  },

  // ── Pre-work (ADR-0032 amendment point 5, ticket 08): the talk's "Before the session" form ──
  {
    key: 'prework', location: 'trigger', type: 'boolean',
    vocabulary: { kind: 'closed', options: [
      { value: 'true', label: 'Pre-work section', explanation: 'Written {prework} on a ## section: its slides are the pre-work form’s steps, answered on the handout link before the session, and are not presented in the talk.' }
    ] },
    label: 'Pre-work section',
    explanation: 'Marks the talk’s “Before the session” section. The planned Run decides when its form opens and closes.',
    ownership: 'user'
  },
  {
    key: 'task', location: 'trigger', type: 'boolean',
    vocabulary: { kind: 'closed', options: [
      { value: 'true', label: 'Pre-task', explanation: 'Written {task} on a pre-work step: a task participants do before the session and mark as done; the slide’s list is the instructions.' }
    ] },
    label: 'Pre-task',
    explanation: 'A step of the pre-work form that asks participants to do something before the session.',
    ownership: 'user'
  },
  {
    key: 'readonly', location: 'trigger', type: 'boolean',
    vocabulary: { kind: 'closed', options: [
      { value: '', label: 'Mark as done', explanation: 'Participants tick the task off when they have done it; you see how many did (the default).' },
      { value: 'true', label: 'Read only', explanation: 'Written {readonly}: participants read the task; there is nothing to tick.' }
    ] },
    label: 'Read-only task',
    explanation: 'On a pre-task, whether participants only read it instead of ticking it off when done.',
    ownership: 'user'
  },
  {
    key: 'minutes', location: 'trigger', type: 'text',
    vocabulary: { kind: 'closed', options: [
      { value: '', label: '10 min', explanation: 'The task takes about 10 minutes (the default).' },
      { value: '5', label: '5 min', explanation: 'The task takes about 5 minutes.' },
      { value: '20', label: '20 min', explanation: 'The task takes about 20 minutes.' },
      { value: '30', label: '30 min', explanation: 'The task takes about 30 minutes.' }
    ] },
    label: 'Time it takes',
    explanation: 'On a pre-task, how long participants should expect it to take.',
    ownership: 'user'
  },
  {
    key: 'check', location: 'trigger', type: 'boolean',
    vocabulary: { kind: 'closed', options: [
      { value: 'true', label: 'Quick check', explanation: 'Written {check} on a single-choice poll in the pre-work section: a quick knowledge check whose right option ends with {right}. Participants get no marks.' }
    ] },
    label: 'Quick check',
    explanation: 'A step of the pre-work form that checks what participants already know, without marking them.',
    ownership: 'user'
  },
  {
    key: 'right', location: 'trigger', type: 'boolean',
    vocabulary: { kind: 'closed', options: [
      { value: 'true', label: 'Right answer', explanation: 'Written {right} at the end of a quick check’s list item: the right option. Only you see it; it is removed from everything participants and the room see.' }
    ] },
    label: 'Right answer',
    explanation: 'Marks a quick check’s right option. Choose it in the Inspector’s Quick check section.',
    ownership: 'user'
  },
  {
    key: 'noask', location: 'trigger', type: 'boolean',
    vocabulary: { kind: 'closed', options: [
      { value: '', label: 'On', explanation: 'Participants can ask about this step; you read the questions on the planned Run in History (the default).' },
      { value: 'true', label: 'Off', explanation: 'Written {noask}: participants cannot ask about this step.' }
    ] },
    label: 'Questions about it',
    explanation: 'On a pre-work step, whether participants can send a question about it.',
    ownership: 'user'
  },
  {
    key: 'results', location: 'trigger', type: 'text', vocabulary: { kind: 'freeform' },
    label: 'Answers from pre-work',
    explanation: 'On a talk slide, the pre-work step (its slide id) whose answers the slide shows. Choose it in the Inspector’s Results section.',
    ownership: 'user'
  },

  // ── Slide reactions (ADR-0027 amendment §6, ticket 04) ─────────────────────────────────────
  {
    key: 'reactions',
    location: 'trigger',
    type: 'text',
    vocabulary: { kind: 'freeform' },
    label: 'Reactions',
    explanation:
      'Which reactions the audience bar offers under this slide: absent for the standard set (puzzled, helped, bookmark), off for none (Ask stays), or up to four of the registered reactions (puzzled, helped, bookmark, agree, disagree, yes, no, more, slower), or quoted custom labels shown in words. Set it in the Inspector’s Audience section.',
    ownership: 'user'
  },
  {
    key: 'pollselections', location: 'trigger', type: 'number', vocabulary: { kind: 'freeform' },
    label: 'Select up to', explanation: 'Maximum distinct options in a multiple-choice answer. Omit to allow all options. Submissions are final.', ownership: 'user'
  },
  {
    key: 'pollsubmissions', location: 'trigger', type: 'text', vocabulary: { kind: 'freeform' },
    label: 'Submissions per participant', explanation: 'Free-text submissions per anonymous participant: a positive integer or unlimited. Defaults to one. Reopening preserves the allowance.', ownership: 'user'
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
  },
  {
    key: 'polls',
    location: 'run',
    type: 'map',
    vocabulary: { kind: 'freeform' },
    label: 'Run polls',
    explanation: 'The poll definitions available during this Run, including their questions, choices and result visibility.',
    ownership: 'system',
    deleteConsequence: 'History loses the definitions needed to interpret this Run’s recorded poll responses.'
  },
  {
    key: 'pollResponses',
    location: 'run',
    type: 'map',
    vocabulary: { kind: 'freeform' },
    label: 'Run poll responses',
    explanation: 'The audience choices or free-text answers recorded during this Run, stamped with time and slide identity.',
    ownership: 'system',
    deleteConsequence: 'The audience poll responses for this Run are permanently absent from its Presentation Ledger record.'
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

/**
 * Identity / house-style frontmatter keys the app may hold a default for (Ticket 9b). Active,
 * user-owned frontmatter only — Settings never offers a default for a key TalkWeaver writes.
 */
export function defaultableEntries(): MetadataEntry[] {
  return METADATA_REGISTRY.filter(
    (e) => e.defaultable === true && e.ownership === 'user' && e.location === 'frontmatter' && !e.since
  )
}

/** Active open-vocabulary frontmatter keys — vault:vocabulary aggregates observed values for these. */
export function openVocabularyFrontmatterKeys(): string[] {
  return METADATA_REGISTRY.filter(
    (e) => e.location === 'frontmatter' && e.vocabulary.kind === 'open' && !e.since
  ).map((e) => e.key)
}
