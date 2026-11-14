// =============================================================================
// Section lead colours (0.44 Ocean look; compiler/scripts/lib/section-leads.mjs and
// skin/zz-x-ocean-70-section-colours.css). Plain Node.
//
//   1. The rotation, the list, `off`, the section override and the pre-work section, resolved by the pure module.
//   2. Stability: a slide added inside a section changes no colour; a section added moves the later ones by one step;
//      an override on one section moves no other section.
//   3. The compiled model: every Ocean slide carries data-lead; classic and green carry none; bold leads amber;
//      unknown names warn; slides outside a section take the first colour.
//   4. `palette: classic` markup is byte-identical to main's: every slide section of the neutral fixtures, compiled as
//      classic, hashed against scripts/fixtures/ocean-look/classic-markup-main.json (recorded with
//      `node scripts/test-section-colours.mjs --record-main=<a checkout or extract of main's compiler/>`).
//   5. Contrast (WCAG 2.1) of every pair the five leads set: the type on each lead and the leads as text or line on
//      white and on the light panel. Pairs that fail are listed by name with their ratio and must match exactly:
//      the approved colours are not adjusted, the failures are reported (build record, known limits).
// =============================================================================
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync, statSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { SECTION_LEADS, SECTION_LEAD_ROTATION, readSectionColours, resolveSectionLeads, sectionLeadName } from '../compiler/scripts/lib/section-leads.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildDeckHtmlFromModel, renderSlideSections } from '../compiler/scripts/lib/07-assembly.mjs'
import { unresolvedTriggerFindings } from '../src/shared/layout-doctor.ts'
import { METADATA_REGISTRY, metadataListError } from '../src/shared/metadata-registry.ts'
import { frontmatterFieldViewModel } from '../src/shared/metadata-surfaces.ts'
import { acceptedValue, schema } from '../src/shared/settings-schema.ts'
import { checkValue } from '@app-patterns/settings'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLASSIC_REFERENCE = join(repo, 'scripts/fixtures/ocean-look/classic-markup-main.json')
const NEUTRAL = [
  'docs/layout-sampler-outline.md',
  'scripts/fixtures/ocean-look/ten-kinds-outline.md',
  'scripts/fixtures/ocean-look/edge-cases-outline.md',
  'scripts/fixtures/ocean-look/review-cases-outline.md',
  'scripts/fixtures/ocean-look/statement-combinations-outline.md',
  'scripts/fixtures/ocean-look/talk-combinations-outline.md',
  'scripts/fixtures/ocean-look/section-colours-outline.md',
]
// main's compiler does not know {section-colour=…}, so the token is taken out on both sides before comparing.
const asClassic = (text) => text.replace(/\{section-colour=[a-z-]+\}/g, '').replace(/^title: .*$/m, (line) => `${line}\npalette: classic`)
async function classicHashes(compilerRoot) {
  const { prepareSource: prepare } = await import(pathToFileURL(join(compilerRoot, 'compiler/scripts/lib/08-source-adapters.mjs')).href)
  const { renderSlideSections: render } = await import(pathToFileURL(join(compilerRoot, 'compiler/scripts/lib/07-assembly.mjs')).href)
  const out = {}
  for (const rel of NEUTRAL) {
    const path = join(repo, rel)
    const text = asClassic(readFileSync(path, 'utf8'))
    assert.ok(/palette: classic/.test(text), `${rel} has a title line`)
    const model = await prepare(path, text, 'classic', statSync(path), undefined, { allowedAssetRoots: [dirname(path), join(repo, 'e2e/fixtures')] })
    out[rel] = render(model).map((markup) => createHash('sha256').update(markup).digest('hex').slice(0, 20))
  }
  return out
}
const recordMain = process.argv.find((arg) => arg.startsWith('--record-main='))?.slice('--record-main='.length)
if (recordMain) {
  const hashes = await classicHashes(resolve(recordMain))
  const fingerprint = Object.fromEntries(NEUTRAL.map((rel) => [rel, createHash('sha256').update(readFileSync(join(repo, rel))).digest('hex').slice(0, 20)]))
  writeFileSync(CLASSIC_REFERENCE, `${JSON.stringify({ recordedFrom: 'origin/main f79e5ce1c', fingerprint, hashes }, null, 1)}\n`)
  console.log(`recorded classic markup of ${NEUTRAL.length} outlines to ${CLASSIC_REFERENCE}`)
  process.exit(0)
}

let passed = 0
const ok = (name, fn) => { fn(); passed += 1; console.log(`  ok  ${name}`) }
const ids = (n) => Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}` }))
const leadsOf = (result) => [...result.bySection.values()]

console.log('section colours')

// ---- 1. the resolver -------------------------------------------------------------------------------
ok('five leads, default rotation A, B, D, C, E', () => {
  assert.deepEqual(SECTION_LEADS, ['blue', 'amber', 'deep-blue', 'light', 'light-amber'])
  assert.deepEqual(SECTION_LEAD_ROTATION, ['blue', 'amber', 'light', 'deep-blue', 'light-amber'])
  const result = resolveSectionLeads({ sections: ids(7) })
  assert.deepEqual(leadsOf(result), ['blue', 'amber', 'light', 'deep-blue', 'light-amber', 'blue', 'amber'])
  assert.equal(result.outside, 'blue')
})
ok('section-colours: absent, auto, off, a list, one colour, a YAML list, unknown names', () => {
  assert.equal(readSectionColours(undefined).state, 'rotate')
  assert.equal(readSectionColours('auto').state, 'rotate')
  assert.equal(readSectionColours('Off').state, 'off')
  assert.equal(readSectionColours(false).state, 'off')
  assert.deepEqual(readSectionColours('blue, Light').list, ['blue', 'light'])
  assert.deepEqual(readSectionColours(['amber', 'deep blue']).list, ['amber', 'deep-blue'])
  const mixed = readSectionColours('blue, purple, light')
  assert.deepEqual(mixed.list, ['blue', 'light'])
  assert.deepEqual(mixed.unknown, ['purple'])
  const none = readSectionColours('purple')
  assert.equal(none.state, 'rotate', 'a list with no known colour keeps the default rotation')
  assert.deepEqual(none.unknown, ['purple'])
  assert.equal(sectionLeadName(' Light_Amber '), 'light-amber')
  assert.equal(sectionLeadName('ocean'), '')
})
ok('a list rotates through its own colours; one colour or off gives every section the same', () => {
  assert.deepEqual(leadsOf(resolveSectionLeads({ sections: ids(5), setting: readSectionColours('blue, light') })), ['blue', 'light', 'blue', 'light', 'blue'])
  assert.deepEqual(leadsOf(resolveSectionLeads({ sections: ids(3), setting: readSectionColours('amber') })), ['amber', 'amber', 'amber'])
  assert.deepEqual(leadsOf(resolveSectionLeads({ sections: ids(3), setting: readSectionColours('off') })), ['blue', 'blue', 'blue'])
  assert.equal(resolveSectionLeads({ sections: ids(2), setting: readSectionColours('light, amber') }).outside, 'light')
})
ok('palette: bold — amber everywhere unless a list is given; off is the look’s own lead (amber)', () => {
  assert.deepEqual(leadsOf(resolveSectionLeads({ sections: ids(3), bold: true })), ['amber', 'amber', 'amber'])
  assert.deepEqual(leadsOf(resolveSectionLeads({ sections: ids(3), bold: true, setting: readSectionColours('off') })), ['amber', 'amber', 'amber'])
  assert.deepEqual(leadsOf(resolveSectionLeads({ sections: ids(3), bold: true, setting: readSectionColours('blue, light') })), ['blue', 'light', 'blue'])
})
ok('an override sets one section and moves no other; a pre-work section takes no step', () => {
  const sections = ids(5)
  sections[1].override = 'light-amber'
  assert.deepEqual(leadsOf(resolveSectionLeads({ sections })), ['blue', 'light-amber', 'light', 'deep-blue', 'light-amber'])
  const withPrework = [{ id: 'pre', prework: true }, ...ids(3)]
  assert.deepEqual(leadsOf(resolveSectionLeads({ sections: withPrework })), ['blue', 'blue', 'amber', 'light'])
})

// ---- the field: one choice, or a typed list, named when wrong --------------------------------------------
const field = METADATA_REGISTRY.find((entry) => entry.key === 'section-colours')
ok('section-colours takes a single choice or a list, and names the item that is not a colour', () => {
  for (const good of ['', 'off', 'amber', 'blue, light', 'Light_Amber, deep blue', 'amber,amber']) assert.equal(metadataListError(field, good), null, good)
  assert.match(metadataListError(field, 'blue, purple'), /“purple” is not one of: blue, amber, deep-blue, light, light-amber/)
  assert.match(metadataListError(field, 'off, blue'), /“off”/)
  assert.match(metadataListError(field, 'blue,,light'), /empty/)
})
ok('Settings accepts a list for new talks and refuses an unknown name, saying which', () => {
  assert.equal(acceptedValue('talkDefaults.section-colours', 'blue, light'), true)
  assert.equal(acceptedValue('talkDefaults.section-colours', 'amber'), true)
  assert.equal(acceptedValue('talkDefaults.section-colours', 'blue, purple'), false)
  assert.match(String(checkValue(schema.def('talkDefaults.section-colours'), 'blue, purple')), /purple/)
})
ok('the Talk tab offers the choices and a list, and shows a list as valid', () => {
  const list = frontmatterFieldViewModel(field, 'blue, light', true)
  assert.ok(list.options?.length >= 7, 'the single choices stay offered')
  assert.equal(list.custom, null, 'a valid list is not a custom value')
  assert.deepEqual(list.list, { items: ['blue', 'amber', 'deep-blue', 'light', 'light-amber'], isList: true, error: null, placeholder: 'blue, amber' })
  const one = frontmatterFieldViewModel(field, 'amber', true)
  assert.equal(one.list.isList, false)
  assert.ok(one.options.find((o) => o.value === 'amber').selected)
  const bad = frontmatterFieldViewModel(field, 'blue, purple', true)
  assert.match(bad.list.error, /purple/)
})

// ---- 2. stability on a compiled outline -----------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'tw-section-colours-'))
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
let n = 0
async function compile(text) {
  const path = join(dir, `${++n}.md`)
  writeFileSync(path, text, 'utf8')
  const model = await prepareSource(path, text, 'Section colours', statSync(path))
  const html = await buildDeckHtmlFromModel(model)
  const bySlide = Object.fromEntries([...html.matchAll(/<section class="slide" data-id="([^"]+)"[^>]*?>/g)].map((m) => [m[1], /data-lead="([^"]+)"/.exec(m[0])?.[1] ?? null]))
  return { model, html, bySlide }
}
const outline = ({ meta = [], sections = ['One', 'Two', 'Three', 'Four'], extra = {}, triggers = {} } = {}) => [
  '---', 'title: Lead fixture', ...meta, '---', '',
  ...sections.flatMap((name) => [`## ${name}`, ...(triggers[name] ? [triggers[name]] : []), '', `### ${name} first {id=${name.toLowerCase()}-first}`, '', '- A point', '', ...(extra[name] ?? [])]),
].join('\n')

const base = await compile(outline())
ok('compiled: each section’s slides carry its lead; title and closing take the first colour', () => {
  assert.equal(base.bySlide['one-first'], 'blue')
  assert.equal(base.bySlide['two-first'], 'amber')
  assert.equal(base.bySlide['three-first'], 'light')
  assert.equal(base.bySlide['four-first'], 'deep-blue')
  assert.equal(base.bySlide['deck-title'], 'blue')
  assert.equal(base.bySlide['deck-thanks'], 'blue')
  assert.ok(base.model.slides.every((slide) => SECTION_LEADS.includes(slide.sectionLead)))
})
const moreSlides = await compile(outline({ extra: { Two: ['### Another slide {id=two-second}', '', '- More', ''] } }))
ok('adding a slide inside a section changes no colour', () => {
  for (const id of ['one-first', 'two-first', 'three-first', 'four-first']) assert.equal(moreSlides.bySlide[id], base.bySlide[id], id)
  assert.equal(moreSlides.bySlide['two-second'], 'amber')
})
const moreSections = await compile(outline({ sections: ['One', 'New', 'Two', 'Three', 'Four'] }))
ok('adding a section moves the later sections by one step', () => {
  assert.equal(moreSections.bySlide['one-first'], 'blue')
  assert.equal(moreSections.bySlide['new-first'], 'amber')
  assert.equal(moreSections.bySlide['two-first'], 'light')
  assert.equal(moreSections.bySlide['three-first'], 'deep-blue')
  assert.equal(moreSections.bySlide['four-first'], 'light-amber')
})
const overridden = await compile(outline({ triggers: { Two: '{section-colour=deep-blue}' } }))
ok('{section-colour=…} on a ## heading sets that section only', () => {
  assert.equal(overridden.bySlide['two-first'], 'deep-blue')
  for (const id of ['one-first', 'three-first', 'four-first']) assert.equal(overridden.bySlide[id], base.bySlide[id], id)
  assert.ok(!overridden.model.warnings.some((w) => /section-colour|trigger-unknown/.test(w)), overridden.model.warnings.join(', '))
})
for (const spelling of ['AMBER', 'Amber', 'Light_Amber', 'deep_blue']) {
  const written = await compile(outline({ triggers: { Two: `{section-colour=${spelling}}` } }))
  ok(`{section-colour=${spelling}} draws and raises no warning; the editor's validator agrees`, () => {
    assert.equal(written.bySlide['two-first'], spelling.toLowerCase().replace('_', '-'))
    assert.deepEqual(written.model.warnings.filter((w) => /section-colour|trigger/.test(w)), [])
    assert.deepEqual(unresolvedTriggerFindings(outline({ triggers: { Two: `{section-colour=${spelling}}` } })), [])
  })
}
ok('the editor\'s validator still flags an unknown section colour', () => {
  assert.equal(unresolvedTriggerFindings(outline({ triggers: { Two: '{section-colour=purple}' } })).length, 1)
})
const badOverride = await compile(outline({ triggers: { Two: '{section-colour=purple}' } }))
ok('an unknown section colour warns and keeps the rotation', () => {
  assert.equal(badOverride.bySlide['two-first'], 'amber')
  assert.ok(badOverride.model.warnings.some((w) => /^section-colour-unknown:purple$|purple/.test(w)), badOverride.model.warnings.join(', '))
})
const badList = await compile(outline({ meta: ['section-colours: blue, purple'] }))
ok('an unknown name in section-colours warns; the known names rotate', () => {
  assert.ok(badList.model.warnings.includes('section-colours-unknown:purple'), badList.model.warnings.join(', '))
  assert.equal(badList.bySlide['two-first'], 'blue')
})
for (const palette of ['classic', 'green']) {
  const classic = await compile(outline({ meta: [`palette: ${palette}`] }))
  ok(`palette: ${palette} stamps no lead`, () => {
    assert.ok(!/data-lead=/.test(classic.html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '')))
  })
}
const bold = await compile(outline({ meta: ['palette: bold'] }))
ok('palette: bold leads every section in amber', () => {
  for (const id of ['deck-title', 'one-first', 'two-first', 'three-first', 'four-first']) assert.equal(bold.bySlide[id], 'amber', id)
})

// ---- 4. classic is main's markup -------------------------------------------------------------------------
{
  const reference = JSON.parse(readFileSync(CLASSIC_REFERENCE, 'utf8'))
  const now = await classicHashes(repo)
  ok('palette: classic slide markup is identical to main on the neutral fixtures', () => {
    for (const rel of NEUTRAL) {
      assert.equal(createHash('sha256').update(readFileSync(join(repo, rel))).digest('hex').slice(0, 20), reference.fingerprint[rel], `${rel} changed since the reference was recorded: record it again from main`)
      assert.deepEqual(now[rel], reference.hashes[rel], rel)
    }
  })
}

// ---- 5. contrast -------------------------------------------------------------------------------------
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
const OCEAN = '#1273C4', DEEP = '#0D5A9E', AMBER = '#FF9F1C', WHITE = '#FFFFFF', LIGHT = '#F2F4F7', INK = '#16181D'
// [what, foreground, background, required ratio]: 4.5 for type, 3 for type of 40px and over and for lines and shapes.
const PAIRS = [
  ['blue: white type on the Ocean field, rail and tab', WHITE, OCEAN, 4.5],
  ['amber: near-black type on the amber field, rail and tab', INK, AMBER, 4.5],
  ['deep-blue: white type on the Deeper Ocean field, rail and tab', WHITE, DEEP, 4.5],
  ['light: Ocean statement type on white', OCEAN, WHITE, 4.5],
  ['light: Ocean rail title on the light panel (40px and over)', OCEAN, LIGHT, 3],
  ['light: Ocean rail title on the light panel (running size)', OCEAN, LIGHT, 4.5],
  ['light: near-black divider title on white', INK, WHITE, 4.5],
  ['light-amber: Deeper Ocean statement type on white', DEEP, WHITE, 4.5],
  ['light-amber: Deeper Ocean rail title on the light panel', DEEP, LIGHT, 4.5],
  ['light-amber: near-black number on the amber disc', INK, AMBER, 4.5],
  ['deep-blue: Deeper Ocean key words on white', DEEP, WHITE, 4.5],
  ['blue: Ocean as text or line on white', OCEAN, WHITE, 4.5],
  ['blue: Ocean as text or line on the light panel', OCEAN, LIGHT, 4.5],
  ['deep-blue: Deeper Ocean as text or line on white', DEEP, WHITE, 4.5],
  ['deep-blue: Deeper Ocean as text or line on the light panel', DEEP, LIGHT, 4.5],
  ['amber: amber as a line or shape on white (light statement rule, title tab, disc)', AMBER, WHITE, 3],
  ['amber: amber as a line or shape on the light panel (rail edge)', AMBER, LIGHT, 3],
  ['amber: Ocean title tab on the amber field (shape)', OCEAN, AMBER, 3],
]
const KNOWN_FAILURES = {
  'light: Ocean rail title on the light panel (running size)': 4.46,
  'blue: Ocean as text or line on the light panel': 4.46,
  'amber: amber as a line or shape on white (light statement rule, title tab, disc)': 2.05,
  'amber: amber as a line or shape on the light panel (rail edge)': 1.86,
  'amber: Ocean title tab on the amber field (shape)': 2.39,
}
ok('contrast: every type pair on a lead passes; the failing pairs are exactly the known ones', () => {
  const failing = {}
  for (const [what, fg, bg, need] of PAIRS) {
    const value = Math.round(ratio(fg, bg) * 100) / 100
    if (value < need) failing[what] = value
  }
  assert.deepEqual(failing, KNOWN_FAILURES)
  // the type set on the five leads, the numbers the look's comments state
  assert.equal(Math.round(ratio(WHITE, OCEAN) * 100) / 100, 4.91)
  assert.equal(Math.round(ratio(INK, AMBER) * 100) / 100, 8.65)
  assert.equal(Math.round(ratio(WHITE, DEEP) * 100) / 100, 7.06)
})

console.log(`section colours: ${passed} passed`)
