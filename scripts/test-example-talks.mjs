// test:example-talks — onboarding 0.38.1 ticket 09: the five example talks and their practice slides.
//   - every chapter's practice talk and section (CHAPTER_TALK) exists in the bundle;
//   - honesty (src/shared/practice-coverage.ts): each chapter's practice section names every command the
//     chapter counts — its effective default chord as a key cap, or its palette name in bold — in the
//     chapter's sub-group order; no key cap is a chord the registry lacks, no bold name is a command
//     that does not exist, and every "Try it" line carries a key cap (so it is drawn as practice);
//   - the check fails, naming the line to write, when a command is added to a task group without one;
//   - the talks compile with the real compiler: no warning anywhere except the two intended ones in
//     Harvest supper (draft) (an empty slide, a missing picture), which are exactly what Layout Doctor
//     lists; no trigger-line finding in any talk; the slide counts as built (and as drawn, printed);
//   - opening and saving change nothing: the editor's save-time passes (position normalising, id
//     stamping) are no-ops on every talk, every slide id is unique in its talk, and a save of the two
//     talks that share slides records no new version of the shared slide;
//   - shared slides are real: three ids in both The Saturday market and Garden notes, the same text,
//     found by where-used; one has two versions in the vault's version store;
//   - the ten-minute pathway and the kept delivery read back through the app's own readers;
//   - Start here says what the drawing says; no real names, paths or addresses.
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHAPTER_TALK, chapterCommands, deriveChapters } from '../src/shared/guide-chapters.ts'
import { checkPractice, practiceMention, sectionText, slideText, talkTitle, unknownIn } from '../src/shared/practice-coverage.ts'
import { scanOutlineTriggers } from '../src/shared/layout-doctor.ts'
import { SHORTCUT_REGISTRY } from '../src/shared/shortcut-registry.ts'
import { normalizePositions } from '../src/shared/outline-normalize.ts'
import { listRuns } from '../src/main/runs.ts'
import { readPathwayManifest, resolvePathways } from '../src/main/pathways.ts'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildPerSlideProjections } from '../compiler/scripts/lib/10-projections.mjs'
import { warningsForSurface } from '../compiler/scripts/lib/warning-registry.mjs'
import { stampMissingIds } from '../compiler/scripts/lib/12-outline-edit.mjs'
import { extractIdSlides, listVersions, normalizeDepth, recordOutlineSave, whereUsed } from '../compiler/scripts/lib/13-slide-ledger.mjs'
import { EX_TALKS } from '../docs/design/2026-10-09-onboarding-and-command-help/mockup-onboarding-talkweaver-text.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(REPO, 'resources', 'example-vault')
let passed = 0
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`PASS  ${name}`) } catch (error) { console.error(`FAIL  ${name}`); throw error }
}

const slugs = readdirSync(BUNDLE, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_')).map((e) => e.name).sort()
const outlinePath = (slug) => join(BUNDLE, slug, `${slug}-outline.md`)
const talks = slugs.map((slug) => ({ slug, path: outlinePath(slug), text: readFileSync(outlinePath(slug), 'utf8') }))
const byTitle = new Map(talks.map((talk) => [talkTitle(talk.text), talk]))
const chapters = deriveChapters()
const commands = chapterCommands()

// The slide counts as built. The drawing's are in EX_TALKS; where they differ, it is because every
// counted command has a line on a slide that still fits at 1280×720 (test:example-talks-fit).
const BUILT_COUNTS = { 'The Saturday market': 22, 'Garden notes': 14, 'Walking the old town': 30, 'Lightning round': 8, 'Harvest supper (draft)': 10 }
// The shared slides (The Saturday market ↔ Garden notes) and the one with two versions.
const SHARED = ['s4', 's14', 's15']
const TWO_VERSIONS = 's4'

const compiled = new Map()
for (const talk of talks) {
  const model = await prepareSource(talk.path, talk.text, talk.slug, statSync(talk.path))
  compiled.set(talk.slug, { model, rows: buildPerSlideProjections(model, talk.slug) ?? [] })
}

await test('the five talks are the drawing’s, by title, in their own folders', () => {
  assert.deepEqual([...byTitle.keys()].sort(), EX_TALKS.map((t) => t[0]).sort())
})

for (const chapter of chapters) {
  const [title, section] = CHAPTER_TALK[chapter.task]
  await test(`${chapter.task}: section “${section}” of ${title} names all ${chapter.rows.length} rows, in sub-group order`, () => {
    const talk = byTitle.get(title)
    assert.ok(talk, `${title} is in the bundle`)
    const text = sectionText(talk.text, section)
    assert.ok(text, `${title} has a ## ${section} section`)
    const check = checkPractice(chapter, text)
    assert.deepEqual(check.missing.map((g) => `${g.subgroup} · ${g.row} · ${g.id} needs ${g.expects}`), [])
    assert.deepEqual(check.outOfOrder.map((g) => `${g.subgroup} · ${g.row} · ${g.id}: ${g.expects} before an earlier sub-group`), [])
    assert.equal(check.covered, check.total)
    assert.equal(check.total, chapter.rows.length)
  })
}

await test('no talk shows a key the registry lacks, names a command that does not exist, or has a Try it line without a key cap', () => {
  for (const talk of talks) assert.deepEqual(unknownIn(talk.text), { unknownKeys: [], unknownNames: [], withoutKeyCap: [] }, talk.slug)
})

await test('every Try it line is a quotation, and every key cap is written as one (never as inline code)', () => {
  for (const talk of talks) {
    const text = slideText(talk.text)
    for (const line of text.split('\n')) if (line.includes('**Try it')) assert.match(line, /^> \*\*Try it[.:]/, `${talk.slug}: ${line}`)
    assert.deepEqual(text.match(/`[^`\n]*[⌘⌥⌃⇧↵][^`\n]*`/g) ?? [], [], talk.slug)
  }
})

await test('a command added to a task group without a line fails the check, naming the line to write', () => {
  const write = chapters.find((c) => c.task === 'Write the outline')
  const [title, section] = CHAPTER_TALK['Write the outline']
  const text = sectionText(byTitle.get(title).text, section)
  const keyless = { id: 'fold.invented', label: 'Fold everything but this', taskGroup: 'Write the outline', subgroup: 'Fold' }
  const keyed = { id: 'fold.invented-key', label: 'Fold the rest', taskGroup: 'Write the outline', subgroup: 'Fold', shortcutId: 'invented.fold-rest' }
  const registry = [{ id: 'invented.fold-rest', keys: '⌃⌥⇧F9', codes: [], scope: 'editor', label: 'Fold the rest', explanation: '', group: '' }]
  const withAdded = deriveChapters([...commands, keyless, keyed]).find((c) => c.task === 'Write the outline')
  assert.equal(withAdded.rows.length, write.rows.length + 2)
  const check = checkPractice(withAdded, text, [...commands, keyless, keyed], [...SHORTCUT_REGISTRY, ...registry])
  assert.equal(check.covered, check.total - 2)
  assert.deepEqual(check.missing, [
    { subgroup: 'Fold', row: 'Fold everything but this', id: 'fold.invented', expects: '**Fold everything but this**' },
    { subgroup: 'Fold', row: 'Fold the rest', id: 'fold.invented-key', expects: '<kbd>⌃⌥⇧F9</kbd>' }
  ])
})

await test('a key nothing answers to, a made-up command name, a Try it line with no key cap and a line out of order are all reported', () => {
  const market = byTitle.get('The Saturday market').text
  const invented = `${market}\n> **Try it.** Press <kbd>⌃⌥⇧F19</kbd>, or choose **Tidy the whole talk**.\n\n> **Try it.** Choose **Bold** from the list.\n`
  assert.deepEqual(unknownIn(invented), { unknownKeys: ['⌃⌥⇧F19'], unknownNames: ['Tidy the whole talk'], withoutKeyCap: ['**Try it.** Choose **Bold** from the list.'] })
  // Undo's key moved to the top of the section, before every other sub-group.
  const write = chapters.find((c) => c.task === 'Write the outline')
  const section = sectionText(market, '01 Write the outline')
  const undo = practiceMention(commands.find((c) => c.id === 'undo'))
  const moved = section.replaceAll(undo, 'undo').replace('## 01 Write the outline', `## 01 Write the outline\n\n> **Try it.** ${undo} undoes.`)
  assert.deepEqual(checkPractice(write, moved).outOfOrder.map((g) => g.id), ['undo'])
})

await test('the talks compile with no warning but the two intended ones, which are what Layout Doctor lists', () => {
  const all = []
  for (const talk of talks) {
    const { model, rows } = compiled.get(talk.slug)
    for (const warning of model.warnings) all.push(`${talk.slug}: ${warning}`)
    for (const row of rows) for (const warning of row.warnings ?? []) if (!model.warnings.includes(warning)) all.push(`${talk.slug} row: ${warning}`)
  }
  assert.deepEqual(all.sort(), [
    'harvest-supper-draft: carousel-empty:photos-from-last-year',
    'harvest-supper-draft: missing-image:the-long-table:pictures/long-table.jpg'
  ])
  const doctorNotes = talks.flatMap((talk) => compiled.get(talk.slug).rows.flatMap((row) => warningsForSurface(row.warnings, 'doctor').map((m) => `${talk.slug}: ${m}`)))
  assert.equal(doctorNotes.length, 2, doctorNotes.join('\n'))
  assert.ok(doctorNotes.every((note) => note.startsWith('harvest-supper-draft: ')))
  for (const talk of talks) assert.deepEqual(scanOutlineTriggers(talk.text), [], `${talk.slug}: trigger-line findings`)
})

await test('the empty slide is empty and the missing picture is inside the vault', () => {
  const harvest = byTitle.get('Harvest supper (draft)').text
  const slides = extractIdSlides(harvest)
  const empty = slides.find((s) => s.id === 'photos-from-last-year')
  assert.deepEqual(empty.markdown.split('\n').filter((l) => l.trim() && !l.startsWith('#') && !/^\{.*\}$/.test(l.trim())), [])
  const picture = /!\[[^\]]*\]\(([^)]+)\)/.exec(harvest)[1]
  assert.equal(picture, 'pictures/long-table.jpg')
  assert.ok(!picture.startsWith('/') && !picture.includes('..'))
  for (const talk of talks) assert.equal((talk.text.match(/!\[/g) ?? []).length, talk.slug === 'harvest-supper-draft' ? 1 : 0, talk.slug)
})

await test('slide counts as built (drawn counts printed beside them)', () => {
  for (const [title, drawn] of EX_TALKS) {
    const talk = byTitle.get(title)
    const built = compiled.get(talk.slug).rows.length
    console.log(`      ${title}: ${built} slides (drawn ${drawn})`)
    assert.equal(built, BUILT_COUNTS[title], title)
  }
})

await test('opening and saving change nothing: the save passes are no-ops and every slide id is unique', () => {
  for (const talk of talks) {
    assert.equal(normalizePositions(talk.text), talk.text, `${talk.slug}: normalizePositions`)
    assert.deepEqual(stampMissingIds(talk.text).stamped, [], `${talk.slug}: every heading carries its id`)
    const ids = extractIdSlides(talk.text).map((s) => s.id)
    assert.equal(new Set(ids).size, ids.length, `${talk.slug}: ids unique`)
    assert.ok(talk.text.endsWith('\n') && !talk.text.includes('\r') && !talk.text.includes('\t'), `${talk.slug}: LF, final newline, no tabs`)
  }
})

await test('shared slides are real: same id and text in both talks, found by where-used; one has two versions; a save records none', () => {
  const market = extractIdSlides(byTitle.get('The Saturday market').text)
  const garden = extractIdSlides(byTitle.get('Garden notes').text)
  const shared = market.filter((s) => garden.some((g) => g.id === s.id)).map((s) => s.id).sort()
  assert.deepEqual(shared, [...SHARED].sort())
  for (const id of SHARED) {
    assert.equal(normalizeDepth(market.find((s) => s.id === id).markdown), normalizeDepth(garden.find((s) => s.id === id).markdown), id)
  }
  const scratch = mkdtempSync(join(tmpdir(), 'tw-example-talks-'))
  try {
    cpSync(BUNDLE, scratch, { recursive: true })
    const readme = readFileSync(join(scratch, '_SLIDE-VERSIONS', 'README.md'), 'utf8')
    for (const id of SHARED) assert.deepEqual(whereUsed(scratch, id).map((h) => h.talk).sort(), ['garden-notes', 'the-saturday-market'], id)
    const versions = listVersions(scratch, TWO_VERSIONS)
    assert.equal(versions.length, 2)
    assert.notEqual(versions[0].markdown, versions[1].markdown)
    assert.equal(versions[0].markdown, normalizeDepth(market.find((s) => s.id === TWO_VERSIONS).markdown).replace(/\n+$/, ''), 'the head is the slide as it is now')
    assert.equal(readFileSync(join(scratch, '_SLIDE-VERSIONS', 'README.md'), 'utf8'), readme, 'the store’s README is the one the app writes')
    for (const slug of ['the-saturday-market', 'garden-notes']) {
      const path = join(scratch, slug, `${slug}-outline.md`)
      const result = recordOutlineSave(scratch, path, readFileSync(path, 'utf8'), { now: Date.parse('2026-10-09T12:00:00Z') })
      assert.ok(result.unchanged.includes(TWO_VERSIONS) && !result.versioned.includes(TWO_VERSIONS), `${slug}: no new version of ${TWO_VERSIONS}`)
    }
    assert.equal(listVersions(scratch, TWO_VERSIONS).length, 2)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

await test('the ten-minute pathway and the kept delivery read back through the app’s own readers', () => {
  const walk = compiled.get('walking-the-old-town').rows
  const [pathway] = resolvePathways(readPathwayManifest(BUNDLE, 'walking-the-old-town').pathways, walk)
  assert.equal(pathway.name, 'Ten minutes')
  assert.equal(pathway.present.length, 8)
  assert.deepEqual(pathway.missing, [])
  const runs = listRuns(BUNDLE, 'lightning-round')
  assert.equal(runs.length, 1)
  assert.equal(runs[0].kind, 'delivery')
  assert.equal(runs[0].status, 'delivered')
  const ids = new Set(compiled.get('lightning-round').rows.map((r) => r.slide_id))
  assert.ok(runs[0].slideTimeIndex.every((mark) => ids.has(mark.slideId)), 'every slide the delivery entered is in the talk')
  const file = join(BUNDLE, '_PRESENTATIONS', 'lightning-round', `${runs[0].id}.json`)
  assert.equal(readFileSync(file, 'utf8'), `${JSON.stringify(runs[0], null, 2)}\n`, 'the run file is byte for byte what the app would write')
  assert.ok(extractIdSlides(byTitle.get('Lightning round').text).every((s) => s.id.endsWith('-present') || /:::notes/.test(byTitle.get('Lightning round').text.split(`{id=${s.id}}`)[1].split(/\n#{1,3} /)[0])), 'every Lightning round slide has speaker notes')
})

await test('Start here: the example, nothing can be broken, the Guide; no real names, paths or addresses', () => {
  const start = sectionText(byTitle.get('The Saturday market').text, '00 Start here')
  assert.match(start, /This talk is the example/)
  assert.match(start, /Nothing here can be broken: <kbd>⌘Z<\/kbd> undoes/)
  assert.match(start, /Guide at the foot of the left sidebar/)
  for (const talk of talks) {
    assert.doesNotMatch(talk.text, /https?:|www\.|@|\/Users\/|~\/|Oxford|Dominik|Lukeš|University/i, talk.slug)
  }
})

console.log(`\ntest:example-talks — ${passed} passed`)
