import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createTalkSearch, handleTalkSearchRequest } from '../src/main/talk-search.ts'
import { createVaultIndex } from '../src/main/vault-index.mjs'
import { scanTalkFoldersSync, TALK_SCAN_MAX_DEPTH } from '../src/main/talk-scan.mjs'

// Talk search, ticket 01 (ADR-0029 §1): plain words over title, file name, folder, frontmatter
// details, delivery records and slide text, ranked, with a match line — at the module's seam
// (searchTalks) over a fixture vault, with slide text compiled by the app's own compiler.

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vault = mkdtempSync(join(tmpdir(), 'tw-talk-search-'))
const base = Date.parse('2026-09-01T10:00:00Z')
let clock = 0

function talk(rel, slug, { frontmatter = '', body = '', edited = 0 } = {}) {
  const dir = join(vault, rel, slug)
  mkdirSync(dir, { recursive: true })
  const outlinePath = join(dir, `${slug}-outline.md`)
  const fm = frontmatter ? `---\noutline_version: 2\n${frontmatter}\n---\n\n` : ''
  writeFileSync(outlinePath, `${fm}${body || '### Opening\n\nWelcome\n'}`)
  const at = new Date(base + (edited || ++clock) * 60_000)
  utimesSync(outlinePath, at, at)
  return outlinePath
}

function run(slug, id, fields) {
  const dir = join(vault, '_PRESENTATIONS', slug)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${id}.json`)
  writeFileSync(path, JSON.stringify({ id, talkSlug: slug, kind: 'delivery', status: 'delivered', ...fields }, null, 2))
  return path
}

// ── fixture vault ──
const jerseyTitle = talk('ai-in-education/jersey-2026', 'from-intern-to-toolmaker-jersey', {
  frontmatter: 'title: From Intern To Toolmaker - Jersey', edited: 10
})
// Its file name says jersey too (as in the real vault): it ranks by file name, but line two
// still names the more telling `event`.
const teaching = talk('ai-in-education', 'teaching-during-the-cognitive-revolution-jersey-staff', {
  frontmatter: 'title: Teaching During The Cognitive Revolution\nevent: "Jersey College for Girls AI in Education conference"\ntags: [pedagogy, schools]',
  edited: 30
})
const pedagogy = talk('ai-in-education', 'vibecoding-as-pedagogy', {
  frontmatter: 'title: Vibecoding As Pedagogy\neventTitle: Jersey College for Girls AI in Education conference\nseries: Teaching with AI',
  edited: 20
})
const pedagogy2 = talk('ai-in-education/clinical', 'vibecoding-as-pedagogy-clinical', {
  frontmatter: 'title: Vibecoding As Pedagogy\nauthor: Dominik Lukeš\naudience:\n  - clinicians\n  - medical educators\ndescription: >\n  A folded block\n  about prompting',
  edited: 5
})
const agentsFiles = talk('agents-presentations', 'ai-2026-agents-files', {
  frontmatter: 'title: "AI 2026: Agents = Files in folders"',
  body: '### Opening\n\nHello\n\n## MondAI RoundUp\n\n- weekly news\n\n## Come by to MondAI\n\n- Mondays at noon\n',
  edited: 40
})
const currentState = talk('agents-presentations', 'current-state-of-ai-agents', {
  frontmatter: 'title: The current state of AI agents',
  body: '### Opening\n\nHi\n\n## Join us\n\nEvery week, MondAI brings the latest news\n',
  edited: 50
})
const yorkDeep = talk('external-workshops/York-July-2026/day-2', 'vibecoding-lab', {
  frontmatter: 'title: "Vibecoding Lab: Prototyping Research Tools"',
  body: '### Opening\n\nHello York\n\n## Kaleidoscope prototypes\n\n- build a small tool\n',
  edited: 15
})
const yorkDeep2 = talk('external-workshops/York-July-2026/day-2', 'vibecoding-for-researchers', {
  frontmatter: 'title: "Vibecoding for Researchers: App Building 101"',
  edited: 14
})
const givenOnly = talk('misc', 'quiet-talk', { frontmatter: 'title: A Quiet Talk', edited: 3 })
const noFrontmatter = talk('misc', 'plain-notes', { body: '## Plain slide\n\nNothing special here\n', edited: 2 })
// Never talks: system, hidden and beyond-backstop folders.
talk('_assets', 'hidden-system-talk', { frontmatter: 'title: Jersey system copy' })
talk('.hidden', 'dot-talk', { frontmatter: 'title: Jersey dot copy' })
talk('a/b/c/d/e/f/g/h/i', 'too-deep', { frontmatter: 'title: Jersey too deep' })

// Delivery records: the quiet talk is found only through one; a rehearsal never counts.
run('quiet-talk', 'run-quiet', {
  startedAt: '2026-07-10T09:30:00', eventTitle: 'Clinical Neuroscience away day', context: 'Oxford',
  transcript: { segments: Array.from({ length: 2000 }, (_, i) => ({ t: i, text: 'segment words' })) }
})
run('vibecoding-lab', 'run-york', { startedAt: '2026-07-21T10:00:00', eventTitle: 'Festival of AI Competency' })
run('plain-notes', 'run-rehearsal', { kind: 'rehearsal', startedAt: '2026-07-01T10:00:00', eventTitle: 'Jersey rehearsal' })
writeFileSync(join(vault, '_PRESENTATIONS', '.DS_Store'), 'x')

// ── scanner parity: the file list's walk and the slide-text walk see the same talks ──
const cacheDir = mkdtempSync(join(tmpdir(), 'tw-talk-search-cache-'))
const indexVault = { id: 'test-vault', root: vault }
const index = createVaultIndex({ dir: join(cacheDir, 'vault-index') })
const listed = await index.refresh(indexVault)
const walked = scanTalkFoldersSync(vault).map(({ dir, outlineName }) => join(dir, outlineName)).sort()
assert.deepEqual(listed.map((t) => t.outlinePath).sort(), walked, 'the vault index and the synchronous walk list the same talks')
assert(walked.includes(yorkDeep), 'a talk four folder levels deep is walked')
assert.equal(walked.length, 10, 'system, hidden and beyond-backstop folders hold no talks')
assert.equal(TALK_SCAN_MAX_DEPTH, 8)
const indexSource = readFileSync(join(repo, 'src/main/index.ts'), 'utf8')
const scanTalksBody = indexSource.slice(indexSource.indexOf('function scanTalks('), indexSource.indexOf("ipcMain.handle('vault:list-talks'"))
assert(scanTalksBody.includes('scanTalkFoldersSync(root)') && !/depth\s*>\s*\d/.test(scanTalksBody),
  'scanTalks (the slide-text warm pass list) walks with the shared scanner, no depth limit of its own')
console.log('PASS scanner parity: vault index and slide-text walk list the same 10 talks, York day-2 included')

// ── slide text, compiled as the app does ──
const { prepareSource } = await import(pathToFileURL(join(repo, 'compiler/scripts/lib/08-source-adapters.mjs')).href)
const { buildPerSlideProjections } = await import(pathToFileURL(join(repo, 'compiler/scripts/lib/10-projections.mjs')).href)
const compiled = new Map()
for (const t of listed) {
  const model = await prepareSource(t.outlinePath, readFileSync(t.outlinePath, 'utf8'), t.slug, statSync(t.outlinePath), undefined, { projectionsOnly: true })
  compiled.set(t.outlinePath, buildPerSlideProjections(model, t.slug))
}
const unread = new Set()
let missingCalls = 0
const search = createTalkSearch({
  vaultRoot: () => vault,
  talks: () => index.cached(indexVault),
  // As the app: a talk the compiler returns nothing for counts as read, with no slide text.
  slideRows: (p) => (unread.has(p) ? null : (compiled.get(p) ?? [])),
  onSlideTextMissing: () => { missingCalls += 1 }
}, { revalidateMs: 0 })

const titles = (r) => r.hits.map((h) => h.title)
const hitFor = (r, outlinePath) => r.hits.find((h) => h.outlinePath === outlinePath)

// 1. "jersey": the three Jersey talks; the two without Jersey in the title say `event`.
{
  const r = await search.searchTalks('jersey')
  assert.deepEqual(r.hits.map((h) => h.outlinePath), [jerseyTitle, teaching, pedagogy], 'title match first, then file name, then details')
  assert.deepEqual(r.hits.map((h) => h.tier), [0, 1, 3])
  assert.equal(hitFor(r, jerseyTitle).match, null, 'a title match needs no match line')
  assert.deepEqual(hitFor(r, jerseyTitle).titleHighlights, [[27, 33]], 'the title marks "Jersey"')
  for (const p of [teaching, pedagogy]) {
    const line = hitFor(r, p).match
    assert.equal(line.label, 'event')
    assert.equal(line.text, 'Jersey College for Girls AI in Education conference')
    assert.deepEqual(line.highlights, [[0, 6]])
  }
  assert.equal(r.everywhereCount, 3)
  assert.deepEqual(r.slideText, { read: 10, total: 10 })
  console.log('PASS "jersey": 3 talks, title match first, two `event` lines (event and eventTitle keys)')
}

// 2. "mondai": talks whose slides mention MondAI, with a `slides` line quoting the slide title.
{
  const r = await search.searchTalks('MondAI')
  assert.deepEqual(r.hits.map((h) => h.outlinePath), [currentState, agentsFiles], 'slide-text ties go to the most recently edited talk')
  const files = hitFor(r, agentsFiles).match
  assert.equal(files.label, 'slides')
  assert.equal(files.text, '“MondAI RoundUp” · “Come by to MondAI”')
  assert.deepEqual(files.highlights, [[1, 7], [31, 37]])
  const state = hitFor(r, currentState).match
  assert.equal(state.label, 'slides')
  assert.match(state.text, /^“Join us”: .*MondAI brings the latest news/, 'a body-only match quotes the slide title with the fragment')
  console.log('PASS "mondai": 2 talks with `slides` lines quoting slide titles')
}

// 3. A talk found only through a delivery record's event or date, with a `given` line.
{
  for (const q of ['clinical neuroscience', '2026-07-10', 'jul']) {
    const r = await search.searchTalks(q)
    const hit = hitFor(r, givenOnly)
    assert(hit, `"${q}" finds the talk through its delivery record`)
    assert.equal(hit.match.label, 'given')
    assert.equal(hit.match.text, '10 Jul 2026 · Clinical Neuroscience away day')
  }
  const byEvent = await search.searchTalks('neuroscience')
  assert.deepEqual(titles(byEvent), ['A Quiet Talk'])
  assert.deepEqual(hitFor(byEvent, givenOnly).match.highlights, [[23, 35]])
  assert.equal(hitFor(byEvent, givenOnly).lastGiven, '2026-07-10')
  const rehearsal = await search.searchTalks('rehearsal')
  assert.equal(rehearsal.hits.length, 0, 'a rehearsal Run is not a delivery record')
  console.log('PASS delivery records: event, ISO date and month find the talk with a `given` line; rehearsals ignored')
}

// 4. A talk four folder levels deep is found by a word only on its slides.
{
  const r = await search.searchTalks('kaleidoscope')
  assert.deepEqual(r.hits.map((h) => h.outlinePath), [yorkDeep])
  assert.equal(r.hits[0].match.label, 'slides')
  assert.equal(r.hits[0].match.text, '“Kaleidoscope prototypes”')
  assert.equal(r.hits[0].folder, 'external-workshops/York-July-2026/day-2')
  assert.equal(r.hits[0].lastGiven, '2026-07-21')
  console.log('PASS depth 4: York day-2 talk found by slide-only word')
}

// 5. Ranking: title above other fields; deterministic; all words must match.
{
  const r = await search.searchTalks('pedagogy')
  assert.deepEqual(r.hits.map((h) => h.outlinePath), [pedagogy, pedagogy2, teaching],
    'two title matches (newer first), then the tags match')
  assert.equal(hitFor(r, teaching).match.label, 'tags')
  assert.equal(hitFor(r, teaching).match.text, 'pedagogy, schools', 'a flow list reads as a list')
  const again = await search.searchTalks('pedagogy')
  assert.deepEqual(again.hits.map((h) => h.outlinePath), r.hits.map((h) => h.outlinePath), 'the same query gives the same order')
  const both = await search.searchTalks('vibecoding teaching')
  assert.deepEqual(both.hits.map((h) => h.outlinePath), [pedagogy], 'every word must match, each anywhere (title + series)')
  assert.equal(both.hits[0].match.label, 'series')
  assert.deepEqual(both.hits[0].titleHighlights, [[0, 10]])
  const accents = await search.searchTalks('lukes')
  assert.deepEqual(accents.hits.map((h) => h.outlinePath), [pedagogy2], 'accent-insensitive: "lukes" finds Lukeš')
  assert.deepEqual(accents.hits[0].match.highlights, [[8, 13]], 'the highlight covers the accented letters')
  const blockList = await search.searchTalks('educators')
  assert.equal(blockList.hits[0].match.text, 'clinicians, medical educators', 'a block list reads as a list')
  const folded = await search.searchTalks('prompting')
  assert.equal(folded.hits[0].match.text, 'A folded block about prompting', 'a folded scalar reads as one line')
  const folderWord = await search.searchTalks('york')
  assert.deepEqual(folderWord.hits.map((h) => h.outlinePath), [yorkDeep, yorkDeep2])
  assert.equal(folderWord.hits[0].match.label, 'folder')
  assert.equal(folderWord.hits[0].match.text, 'external-workshops / York-July-2026 / day-2')
  const fileWord = await search.searchTalks('plain-notes')
  assert.equal(fileWord.hits[0].outlinePath, noFrontmatter)
  assert.equal(fileWord.hits[0].title, 'Plain Notes', 'a talk without frontmatter keeps its slug title')
  assert.equal(fileWord.hits[0].match.label, 'file')
  const none = await search.searchTalks('zzzqqq')
  assert.equal(none.hits.length, 0)
  assert.equal((await search.searchTalks('   ')).hits.length, 0, 'an empty query returns no talks')
  console.log('PASS ranking: title > details, recency ties, all words, accents, folder and file lines')
}

// 6. Inside a drilled-in folder: results stay in it; everywhereCount is the unscoped N.
{
  const inside = await search.searchTalks('vibecoding', { within: 'external-workshops/York-July-2026' })
  assert.deepEqual(inside.hits.map((h) => h.outlinePath), [yorkDeep, yorkDeep2])
  assert.equal(inside.within, 'external-workshops/York-July-2026')
  assert.equal(inside.everywhereCount, 4, 'search everywhere (4)')
  const everywhere = await search.searchTalks('vibecoding')
  assert.equal(everywhere.hits.length, 4)
  assert.equal(everywhere.within, null)
  const prefixOnly = await search.searchTalks('vibecoding', { within: 'external' })
  assert.equal(prefixOnly.hits.length, 0, 'a folder limit matches whole folder names, not prefixes')
  console.log('PASS scope: 2 in York-July-2026, search everywhere (4)')
}

// 7. Slide text still being read: counts, the warm-pass hook, and results that appear later.
{
  unread.add(yorkDeep)
  unread.add(agentsFiles)
  const before = missingCalls
  const r = await search.searchTalks('kaleidoscope')
  assert.equal(r.hits.length, 0)
  assert.deepEqual(r.slideText, { read: 8, total: 10 })
  assert(missingCalls > before, 'talks without slide text start the warm pass')
  unread.clear()
  const later = await search.searchTalks('kaleidoscope')
  assert.equal(later.hits.length, 1, 'the result appears once its slide text is read')
  assert.deepEqual(later.slideText, { read: 10, total: 10 })
  console.log('PASS still reading: 8 of 10, then the result appears')
}

// 8. Delivery summaries stay light and fresh: unchanged Runs are not re-read; changed, new and
// deleted Runs are picked up on the next search.
{
  const parsed = search.deliveryParsedCount()
  await search.searchTalks('festival')
  await search.searchTalks('festival')
  assert.equal(search.deliveryParsedCount(), parsed, 'no Run file is re-read while unchanged')
  const york = run('vibecoding-lab', 'run-york', { startedAt: '2026-07-21T10:00:00', eventTitle: 'Festival of AI Competency — University of York' })
  const later = new Date(Date.now() + 5000)
  utimesSync(york, later, later)
  const changed = await search.searchTalks('university')
  assert.deepEqual(changed.hits.map((h) => h.outlinePath), [yorkDeep], 'an edited Run is re-read')
  assert.equal(search.deliveryParsedCount(), parsed + 1, 'only the changed Run file was read')
  const fresh = run('from-intern-to-toolmaker-jersey', 'run-new', { status: 'planned', plannedDate: '2026-11-02', eventTitle: 'Guernsey schools day' })
  const planned = await search.searchTalks('guernsey')
  assert.equal(planned.hits[0].match.label, 'planned')
  assert.equal(planned.hits[0].match.text, '2 Nov 2026 · Guernsey schools day')
  rmSync(fresh)
  assert.equal((await search.searchTalks('guernsey')).hits.length, 0, 'a deleted Run drops out')
  console.log('PASS delivery summaries: only changed Runs re-read; new and deleted Runs picked up')
}

// 9. Frontmatter details are read fresh after an edit, from the whole block (not a 2 KB head).
{
  const long = 'x'.repeat(3000)
  writeFileSync(givenOnly, `---\noutline_version: 2\ntitle: A Quiet Talk\ndescription: ${long}\nseries: Late Series Name\n---\n\n### Opening\n`)
  const t = new Date(Date.now() + 10_000)
  utimesSync(givenOnly, t, t)
  const r = await search.searchTalks('late series')
  assert.deepEqual(r.hits.map((h) => h.outlinePath), [givenOnly])
  assert.equal(r.hits[0].match.label, 'series')
  console.log('PASS details: edited frontmatter re-read; a key past the first 2 KB is found')
}

// 10. The IPC handler body: untyped renderer arguments are sanitised.
{
  const calls = []
  const fake = { searchTalks: async (q, o) => { calls.push([q, o]); return { q, o } } }
  await handleTalkSearchRequest(fake, 'jersey', { within: 'ai-in-education' })
  await handleTalkSearchRequest(fake, 42, { within: 7 })
  await handleTalkSearchRequest(fake, 'a'.repeat(900), null)
  assert.deepEqual(calls[0], ['jersey', { within: 'ai-in-education' }])
  assert.deepEqual(calls[1], ['', {}])
  assert.equal(calls[2][0].length, 500)
  const real = await handleTalkSearchRequest(search, 'jersey', {})
  assert.equal(real.hits.length, 3)
  console.log('PASS IPC handler: arguments sanitised, real search answers')
}

rmSync(vault, { recursive: true, force: true })
rmSync(cacheDir, { recursive: true, force: true })
console.log('PASS talk search: plain words, ranking, match lines, scope, reading state, parity')
