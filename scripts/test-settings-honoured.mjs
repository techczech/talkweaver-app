// =============================================================================
// Settings honoured end to end (Composition Programme, Ticket 10)
//
// Dominik: "Not sure everything honours settings."
//
// This gate answers that question per KEY and per VALUE, from the registry rather than from a
// hand-written list: every user-owned frontmatter key in `src/shared/metadata-registry.ts` must
// appear in EFFECTS below, and every value of a CLOSED vocabulary gets its own compiled deck and
// its own assertion on the rendered HTML. A key added to the registry with no proven effect fails
// here; a value added to a closed vocabulary with no proven effect fails here.
//
// It compiles real decks — prepareSource → buildDeckHtmlFromModel, the same pair
// scripts/build-layout-sampler.mjs uses — and asserts on the DOM, never on the model alone, so
// "the compiler read it" is never mistaken for "the deck shows it".
//
// Three things are asserted for a closed vocabulary:
//   1. every documented value produces the effect the registry option promises;
//   2. at least two values differ from each other in the rendered HTML (a vocabulary whose values
//      all render identically is a dead control);
//   3. an UNDOCUMENTED value raises a registered compiler warning rather than falling back in
//      silence (the Ticket 9 audit's "reads narrower than the surface implies").
// =============================================================================
import { strict as assert } from 'node:assert'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildDeckHtmlFromModel } from '../compiler/scripts/lib/07-assembly.mjs'
import { warningDefinition } from '../compiler/scripts/lib/warning-registry.mjs'
import { METADATA_REGISTRY } from '../src/shared/metadata-registry.ts'

const dir = mkdtempSync(join(tmpdir(), 'tw-settings-honoured-'))
let probe = 0

// The deck every fixture starts from: identity slots filled so a poster assertion has something
// to find, and two sections so the section-accent cycle is observable.
const BASE_META = [
  'title: Settings Fixture',
  'author: Dominik Lukeš (author@example.com)'
]

const BASE_BODY = [
  '## First section',
  '',
  '### A content slide',
  '',
  'Some prose about the setting under test.',
  '',
  '### A slide with a link',
  '',
  'See [the handbook](https://example.org/handbook) for more.'
]

async function compile({ meta = [], body = BASE_BODY } = {}) {
  const source = ['---', ...BASE_META, ...meta, '---', '', ...body].join('\n')
  const path = join(dir, `${++probe}.md`)
  writeFileSync(path, source, 'utf8')
  const model = await prepareSource(path, source, 'Settings Fixture', statSync(path))
  const html = await buildDeckHtmlFromModel(model)
  const { document } = new JSDOM(html).window
  return { model, html, document, warnings: model.warnings ?? [] }
}

const text = (element) => String(element?.textContent ?? '').replace(/\s+/g, ' ').trim()
const slideById = (document, id) => document.querySelector(`section.slide[data-id="${id}"]`)
const deckMain = (document) => document.querySelector('main.deck')
const posterAccent = (document, id) => {
  const slide = slideById(document, id)
  const match = /--accent:\s*([^;"]+)/.exec(slide?.getAttribute('style') ?? '')
  return match ? match[1].trim() : ''
}
/** The `key: value` line a fixture writes, or nothing at all when the value is the empty default. */
const metaLine = (key, value) => (value === '' ? [] : [`${key}: ${value}`])

// -----------------------------------------------------------------------------
// The effects table. One entry per user-owned frontmatter key.
//
//   effect  — prose: what the reader should be able to SEE. Reported in the coverage table.
//   body    — the outline body this key needs to be observable (defaults to BASE_BODY).
//   meta    — extra frontmatter every fixture for this key carries.
//   probe   — ({document, model, html, warnings}) → a comparable value (string/number/boolean).
//   expect  — closed keys only: value → the probe result that value promises.
//   assert  — open keys only: (probe result, fixture value) → throws when dishonoured.
//   value   — open keys only: the value written into the fixture.
//   unknown — closed keys only: an undocumented value, and the warning id it must raise.
// -----------------------------------------------------------------------------
const LOGO_BODY = [
  '## Marks',
  '',
  '### Model makers {logolist}',
  '',
  '- OpenAI',
  '- Google',
  '- MiniMax'
]

const CLAIM_BODY = [
  '## First section',
  '',
  '### A claim slide',
  '',
  '**This is the claim the slide makes.**',
  '',
  'And ordinary prose beneath it.'
]

const EFFECTS = {
  // ── Closed vocabularies ────────────────────────────────────────────────────
  hide_email: {
    effect: 'the email inside the author byline is stripped from the title poster',
    probe: ({ document }) => (text(slideById(document, 'deck-title')?.querySelector('.tp-who')).includes('@') ? 'email' : 'no-email'),
    expect: { '': 'email', true: 'no-email', false: 'email' },
    unknown: { value: 'perhaps', warning: 'deck-flag-unknown' }
  },
  auto_title_slide: {
    effect: 'the deck opens with the generated title poster',
    probe: ({ document }) => Boolean(slideById(document, 'deck-title')),
    expect: { '': true, true: true, false: false },
    unknown: { value: 'perhaps', warning: 'deck-flag-unknown' }
  },
  auto_thanks_slide: {
    effect: 'the deck closes with the generated thanks poster',
    probe: ({ document }) => Boolean(slideById(document, 'deck-thanks')),
    expect: { '': true, true: true, false: false },
    unknown: { value: 'perhaps', warning: 'deck-flag-unknown' }
  },
  links_index: {
    effect: 'a Links slide listing every link in the deck is appended',
    probe: ({ document }) => Boolean(slideById(document, 'deck-links')),
    expect: { '': false, true: true, false: false },
    unknown: { value: 'perhaps', warning: 'deck-flag-unknown' }
  },
  section_labels: {
    effect: 'each content slide carries its section name as a kicker',
    probe: ({ document }) => text(document.querySelector('section.slide[data-role="content"] .kicker')),
    expect: { '': '', on: 'First section' },
    unknown: { value: 'perhaps', warning: 'deck-flag-unknown' }
  },
  colour: {
    effect: 'the title poster is painted in the named accent',
    probe: ({ document }) => posterAccent(document, 'deck-title'),
    // '' is the section cycle's own first accent (cobalt) — the documented "Automatic".
    expect: { '': '#0f4bd8', cobalt: '#0f4bd8', emerald: '#0a7a5c', vermilion: '#c2410c', forest: '#166534' },
    unknown: { value: 'puce', warning: 'colour-unknown' }
  },
  title_style: {
    effect: 'the opening poster takes the named variant',
    probe: ({ document }) => [...(slideById(document, 'deck-title')?.querySelector('.tp')?.classList ?? [])].sort().join(' '),
    expect: { '': 'tp tp-poster', poster: 'tp tp-poster', split: 'tp tp-split', banner: 'tp tp-banner' },
    unknown: { value: 'mural', warning: 'title-style-unknown' }
  },
  font: {
    effect: 'the deck container carries the chosen face',
    probe: ({ document }) => deckMain(document)?.getAttribute('data-deck-font') ?? '',
    // Trebuchet is the locked default face: it stamps no attribute, and must not warn.
    expect: { '': '', trebuchet: '', 'gill-sans': 'gill-sans', verdana: 'verdana' },
    unknown: { value: 'papyrus', warning: 'font-unknown' }
  },
  claim_style: {
    effect: 'a wholly bold paragraph takes the deck claim treatment',
    body: CLAIM_BODY,
    probe: ({ document }) => document.querySelector('p.claim')?.getAttribute('data-claim-style') ?? '',
    expect: { '': 'plain', plain: 'plain', bar: 'bar' },
    unknown: { value: 'underline', warning: 'claim-style-unknown' }
  },
  palette: {
    effect: 'the section accent cycle switches to the green palette',
    probe: ({ document }) => posterAccent(document, 'deck-title'),
    expect: { '': '#0f4bd8', green: '#166534' },
    unknown: { value: 'purple', warning: 'palette-unknown' }
  },
  'logo-colour': {
    effect: 'a mixed logo row keeps each brand’s own colours instead of the unified accent',
    body: LOGO_BODY,
    // A row mixing full-colour svgl marks with a silhouette-only mark goes monochrome as one; the
    // brand opt-out is visible as hex paint surviving inside the brand marks themselves.
    probe: ({ html }) => ((html.match(/<svg[^>]*fl-svg-brand[^>]*>[\s\S]*?<\/svg>/g) ?? []).some((mark) => /#[0-9a-fA-F]{3,6}/.test(mark)) ? 'brand-colours' : 'monochrome'),
    expect: { '': 'monochrome', unified: 'monochrome', brand: 'brand-colours' },
    unknown: { value: 'rainbow', warning: 'logo-colour-unknown' }
  },
  license: {
    effect: 'the licence footer button is live and names the licence',
    probe: ({ document }) => text(document.querySelector('.license-name')),
    expect: {
      '': '',
      by: 'CC BY 4.0',
      'by-sa': 'CC BY-SA 4.0',
      'by-nc': 'CC BY-NC 4.0',
      'by-nd': 'CC BY-ND 4.0',
      'by-nc-sa': 'CC BY-NC-SA 4.0',
      'by-nc-nd': 'CC BY-NC-ND 4.0',
      CC0: 'CC0 1.0'
    },
    // `license:` honours ANY value verbatim (parseLicense keeps an unrecognised name and the
    // explicit `license-url`), so there is no silent fallback to warn about. Asserted, not skipped.
    unknown: { value: 'Crown copyright', honoursVerbatim: 'Crown copyright' }
  },

  // ── Open / freeform keys with a compiler effect ────────────────────────────
  title: {
    effect: 'the title poster headline',
    probe: ({ document }) => text(slideById(document, 'deck-title')?.querySelector('.tp-title')),
    value: 'Settings Fixture',
    assert: (got, value) => assert.equal(got, value)
  },
  subtitle: {
    effect: 'the title poster subtitle line',
    value: 'The second line',
    probe: ({ document }) => text(slideById(document, 'deck-title')?.querySelector('.tp-sub')),
    assert: (got, value) => assert.equal(got, value)
  },
  author: {
    effect: 'the poster byline name',
    value: 'Ada Lovelace',
    probe: ({ document }) => text(slideById(document, 'deck-title')?.querySelector('.tp-name')),
    assert: (got, value) => assert.equal(got, value)
  },
  affiliation: {
    effect: 'the poster byline affiliation',
    value: 'University of Oxford',
    probe: ({ document }) => text(slideById(document, 'deck-title')?.querySelector('.tp-soft')),
    assert: (got, value) => assert.equal(got, value)
  },
  web: {
    effect: 'the poster web address',
    value: 'dominiklukes.net',
    probe: ({ document }) => text(slideById(document, 'deck-title')?.querySelector('.tp-web')),
    assert: (got, value) => assert.equal(got, value)
  },
  date: {
    effect: 'the poster date line',
    value: '12 September 2026',
    probe: ({ document }) => text(slideById(document, 'deck-title')?.querySelector('.tp-whenweb')),
    assert: (got, value) => assert(got.includes(value), `poster date line ${JSON.stringify(got)} omits ${JSON.stringify(value)}`)
  },
  series: {
    effect: 'the poster kicker',
    value: 'TalkWeaver Sessions',
    probe: ({ document }) => text(slideById(document, 'deck-title')?.querySelector('.tp-kicker')),
    assert: (got, value) => assert(got.includes(value), `poster kicker ${JSON.stringify(got)} omits ${JSON.stringify(value)}`)
  },
  event: {
    effect: 'the poster kicker and the opening slide kicker',
    value: 'Settings Day 2026',
    probe: ({ document }) => text(slideById(document, 'deck-title')?.querySelector('.tp-kicker')),
    assert: (got, value) => assert(got.includes(value), `poster kicker ${JSON.stringify(got)} omits ${JSON.stringify(value)}`)
  },
  logo: {
    effect: 'the poster logo image',
    value: 'https://example.org/logo.png',
    probe: ({ document }) => slideById(document, 'deck-title')?.querySelector('img.tp-logo')?.getAttribute('src') ?? '',
    assert: (got, value) => assert.equal(got, value)
  },
  thanks: {
    effect: 'the closing poster headline',
    value: 'Thanks for listening',
    probe: ({ document }) => text(slideById(document, 'deck-thanks')?.querySelector('.tp-title')),
    assert: (got, value) => assert.equal(got, value)
  },
  cta: {
    effect: 'the closing poster call to action',
    value: 'Write to me',
    probe: ({ document }) => text(slideById(document, 'deck-thanks')?.querySelector('.tp-cta')),
    assert: (got, value) => assert.equal(got, value)
  },
  duration: {
    effect: 'the presenter clock’s countdown length',
    value: '60min',
    probe: ({ document }) => deckMain(document)?.getAttribute('data-talk-duration') ?? '',
    assert: (got) => assert.equal(got, '3600')
  },
  'warn-at': {
    effect: 'the presenter clock’s amber threshold',
    value: '9',
    probe: ({ document }) => deckMain(document)?.getAttribute('data-warn-at') ?? '',
    assert: (got, value) => assert.equal(got, value)
  },
  'urgent-at': {
    effect: 'the presenter clock’s dark-amber threshold',
    value: '3',
    meta: ['warn-at: 9'],
    probe: ({ document }) => deckMain(document)?.getAttribute('data-urgent-at') ?? '',
    assert: (got, value) => assert.equal(got, value)
  },
  triggers: {
    effect: 'a deck-wide trigger default reaches every slide',
    value: 'bg=cobalt',
    probe: ({ document }) => document.querySelector('section.slide[data-role="content"]')?.getAttribute('style') ?? '',
    assert: (got) => assert(got.includes('--slide-bg'), `deck trigger default did not reach the slide: ${JSON.stringify(got)}`)
  },
  'license-note': {
    effect: 'the licence popup’s free-text note',
    value: 'Slides only; images as credited.',
    meta: ['license: by'],
    probe: ({ document }) => text(document.querySelector('.license-note')),
    assert: (got, value) => assert.equal(got, value)
  },
  'license-url': {
    effect: 'the licence link target',
    value: 'https://example.org/licence',
    meta: ['license: Crown copyright'],
    probe: ({ document }) => document.querySelector('.license-name a')?.getAttribute('href') ?? '',
    assert: (got, value) => assert.equal(got, value)
  },
  credits: {
    effect: 'the licence popup’s credits list',
    value: 'Icons by Simple Icons',
    probe: ({ document }) => text(document.querySelector('.license-credits')),
    assert: (got, value) => assert.equal(got, value)
  },
  defaults: {
    effect: 'deck-wide frame defaults reach every slide',
    value: '\n  title: side',
    probe: ({ document }) => document.querySelector('section.slide[data-role="content"]')?.getAttribute('data-title-layout') ?? '',
    assert: (got) => assert.equal(got, 'left')
  },
  sections: {
    effect: 'per-section frame overrides reach that section’s slides',
    value: '\n  First section:\n    title: side',
    probe: ({ document }) => document.querySelector('section.slide[data-role="content"]')?.getAttribute('data-title-layout') ?? '',
    assert: (got) => assert.equal(got, 'left')
  },
  icons: {
    effect: 'the deck icon vocabulary overrides a concept’s glyph',
    value: '\n  handbook: lucide:book',
    body: ['## First section', '', '### Reading {iconlist}', '', '- Handbook', '- Notes'],
    probe: ({ document }) => Boolean(document.querySelector('.feature-list .fl-icon svg')),
    assert: (got) => assert.equal(got, true, 'the deck icon vocabulary put a glyph on the list item')
  }
}

// -----------------------------------------------------------------------------
// 1. Registry coverage — the table is enumerated FROM the registry.
// -----------------------------------------------------------------------------
const userKeys = METADATA_REGISTRY.filter(
  (entry) => entry.location === 'frontmatter' && entry.ownership === 'user' && !entry.since
)
const missing = userKeys.map((entry) => entry.key).filter((key) => !EFFECTS[key])
assert.deepEqual(missing, [], `every user frontmatter key needs a proven compiler effect: ${missing.join(', ')}`)
const stray = Object.keys(EFFECTS).filter((key) => !userKeys.some((entry) => entry.key === key))
assert.deepEqual(stray, [], `EFFECTS names key(s) the registry does not declare: ${stray.join(', ')}`)

// -----------------------------------------------------------------------------
// 2. One fixture per value, one assertion per effect.
// -----------------------------------------------------------------------------
const rows = []
let checks = 0

for (const entry of userKeys) {
  const spec = EFFECTS[entry.key]
  const fixture = (extra) => compile({ meta: [...(spec.meta ?? []), ...extra], body: spec.body })

  if (entry.vocabulary.kind === 'closed') {
    const seen = new Map()
    for (const option of entry.vocabulary.options) {
      assert(
        Object.prototype.hasOwnProperty.call(spec.expect, option.value),
        `${entry.key}: documented value ${JSON.stringify(option.value)} has no asserted effect`
      )
      const run = await fixture(metaLine(entry.key, option.value))
      const got = spec.probe(run)
      assert.equal(got, spec.expect[option.value], `${entry.key}: ${JSON.stringify(option.value)} — ${spec.effect}`)
      assert.deepEqual(
        run.warnings.filter((warning) => String(warning).startsWith(`${spec.unknown.warning ?? 'never'}:`)),
        [],
        `${entry.key}: documented value ${JSON.stringify(option.value)} must not warn`
      )
      seen.set(option.value, String(got))
      checks += 1
    }
    assert(
      new Set(seen.values()).size > 1,
      `${entry.key}: every documented value renders identically — the control is dead`
    )

    // An UNDOCUMENTED value: either a registered warning, or honoured verbatim. Never silence.
    const off = await fixture(metaLine(entry.key, spec.unknown.value))
    if (spec.unknown.honoursVerbatim !== undefined) {
      assert.equal(spec.probe(off), spec.unknown.honoursVerbatim, `${entry.key}: an undocumented value is honoured verbatim`)
    } else {
      const raised = off.warnings.filter((warning) => String(warning).startsWith(`${spec.unknown.warning}:`))
      assert.equal(raised.length, 1, `${entry.key}: an undocumented value must raise ${spec.unknown.warning} (got ${JSON.stringify(off.warnings)})`)
      assert(warningDefinition(raised[0]), `${entry.key}: ${raised[0]} is not in the warning registry`)
    }
    checks += 1
    rows.push(`${entry.key.padEnd(18)} ${entry.vocabulary.options.map((option) => option.value || '(absent)').join(' · ')}  →  ${spec.effect}`)
    continue
  }

  // Open / freeform: one fixture, one assertion that the value lands where the surface says.
  const run = await fixture([`${entry.key}: ${spec.value}`])
  spec.assert(spec.probe(run), spec.value)
  checks += 1
  rows.push(`${entry.key.padEnd(18)} ${JSON.stringify(spec.value)}  →  ${spec.effect}`)
}

// -----------------------------------------------------------------------------
// 3. The narrow reads the Ticket 9 audit named, pinned as their own regressions.
// -----------------------------------------------------------------------------

// A quoted boolean is what a hand-authored outline (or any YAML writer that quotes) produces.
// Every documented flag must read it the same way it reads the bare form.
for (const [key, quoted, probe, expected] of [
  ['links_index', '"true"', ({ document }) => Boolean(slideById(document, 'deck-links')), true],
  ['auto_title_slide', '"false"', ({ document }) => Boolean(slideById(document, 'deck-title')), false],
  ['auto_thanks_slide', '"false"', ({ document }) => Boolean(slideById(document, 'deck-thanks')), false],
  ['section_labels', '"true"', ({ document }) => text(document.querySelector('section.slide[data-role="content"] .kicker')), 'First section'],
  ['hide_email', '"yes"', ({ document }) => text(slideById(document, 'deck-title')?.querySelector('.tp-who')).includes('@'), false]
]) {
  const run = await compile({ meta: [`${key}: ${quoted}`] })
  assert.equal(probe(run), expected, `${key}: a quoted ${quoted} is honoured exactly as the bare form is`)
  checks += 1
}

// `links_index: true` with no links in the deck emits nothing. That is a setting the author asked
// for and did not get — it must say so rather than disappear.
const emptyLinks = await compile({
  meta: ['links_index: true'],
  body: ['## First section', '', '### A content slide', '', 'No links anywhere in this deck.']
})
assert.equal(slideById(emptyLinks.document, 'deck-links'), null, 'no links means no links slide')
assert(
  emptyLinks.warnings.some((warning) => String(warning).startsWith('links-index-empty')),
  `links_index: true with no links must warn (got ${JSON.stringify(emptyLinks.warnings)})`
)
checks += 1

// warn-at / urgent-at: an unreadable value must not become NaN in silence, and a clamp must say so.
const badWarnAt = await compile({ meta: ['warn-at: soon'] })
assert.equal(deckMain(badWarnAt.document)?.getAttribute('data-warn-at'), '5', 'an unreadable warn-at falls back to the 5-minute default')
assert(
  badWarnAt.warnings.some((warning) => String(warning).startsWith('timer-threshold-unreadable:warn-at')),
  `an unreadable warn-at must warn (got ${JSON.stringify(badWarnAt.warnings)})`
)
checks += 1

const clamped = await compile({ meta: ['warn-at: 3', 'urgent-at: 8'] })
assert.equal(deckMain(clamped.document)?.getAttribute('data-urgent-at'), '3', 'urgent-at is clamped to warn-at')
assert(
  clamped.warnings.some((warning) => String(warning).startsWith('timer-threshold-clamped:urgent-at')),
  `a clamped urgent-at must warn (got ${JSON.stringify(clamped.warnings)})`
)
checks += 1

// Every warning this gate demands must be a REGISTERED code with a message and a remedy.
for (const id of [
  'deck-flag-unknown',
  'colour-unknown',
  'title-style-unknown',
  'claim-style-unknown',
  'palette-unknown',
  'logo-colour-unknown',
  'links-index-empty',
  'timer-threshold-unreadable',
  'timer-threshold-clamped'
]) {
  assert(warningDefinition(`${id}:x`), `${id} must be in the warning registry`)
  checks += 1
}

console.log(rows.join('\n'))
console.log(`settings honoured: ${userKeys.length} keys, ${checks} assertions`)
