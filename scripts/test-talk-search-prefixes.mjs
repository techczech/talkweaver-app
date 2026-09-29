import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTalkSearch, parseTalkQuery } from '../src/main/talk-search.ts'
import { createVaultIndex } from '../src/main/vault-index.mjs'
import {
  datePartsMatch, folderFrom, formatPrefixed, hasSearchTerms, parseDateQuery, parseLooseDate, replaceToken, tokenizeTalkQuery
} from '../src/shared/talk-query.ts'

// Talk search, ticket 02 (ADR-0029 §2): field prefixes fo: fi: met: co: da:, combined with plain
// words — at the parser (parseTalkQuery / tokenizeTalkQuery / date forms) and at the module's
// seam (searchTalks, folders) over a fixture vault shaped like the York festival.

// ── the query language ──
{
  assert.deepEqual(parseTalkQuery('fo:york da:2026-07 agents').terms, [
    { text: 'york', field: 'folder' }, { text: '2026-07', field: 'date' }, { text: 'agents', field: null }
  ], 'prefixed and plain words combine')
  assert.deepEqual(parseTalkQuery('fi:Jersey met:Festival co:MondAI').terms, [
    { text: 'jersey', field: 'file' }, { text: 'festival', field: 'details' }, { text: 'mondai', field: 'slides' }
  ], 'each prefix names its field; values fold')
  assert.deepEqual(parseTalkQuery('FO:York Da:jul').terms, [{ text: 'york', field: 'folder' }, { text: 'jul', field: 'date' }], 'prefixes in any case')
  assert.deepEqual(parseTalkQuery('xx:foo t:agents https://x.org').terms, [
    { text: 'xx:foo', field: null }, { text: 't:agents', field: null }, { text: 'https://x.org', field: null }
  ], 'an unknown prefix (the slide picker’s t: too) is a plain word')
  assert.deepEqual(parseTalkQuery('fo: da:').terms, [], 'a prefix with nothing after it is no term yet')
  assert.deepEqual(parseTalkQuery('york fo:york york').terms, [{ text: 'york', field: null }, { text: 'york', field: 'folder' }], 'repeats count once per field')
  assert.deepEqual(parseTalkQuery('fo:"AI Agent Workshops" pm').terms, [{ text: 'ai agent workshops', field: 'folder' }, { text: 'pm', field: null }], 'a quoted value holds spaces')

  const tokens = tokenizeTalkQuery('fo:jersy  da:2025 plain')
  assert.deepEqual(tokens.map((t) => [t.start, t.end, t.prefix, t.value]), [[0, 8, 'fo', 'jersy'], [10, 17, 'da', '2025'], [18, 23, null, 'plain']])
  assert.deepEqual(tokenizeTalkQuery('fo:"AI Agent').map((t) => t.value), ['AI Agent'], 'an unclosed quote runs to the end while typing')
  assert.equal(replaceToken('fo:jersy  da:2025 plain', tokens[1], null), 'fo:jersy plain')
  assert.equal(replaceToken('fo:jersy da:2025', tokenizeTalkQuery('fo:jersy da:2025')[0], 'fo:jersey-2026'), 'fo:jersey-2026 da:2025')
  assert.equal(formatPrefixed('fo', 'AI Agent Workshops'), 'fo:"AI Agent Workshops"')
  assert.equal(formatPrefixed('fo', 'York-July-2026/day-1'), 'fo:York-July-2026/day-1')
  assert.equal(hasSearchTerms('fo:'), false)
  assert.equal(hasSearchTerms(' '), false)
  assert.equal(hasSearchTerms('fo:y'), true)
  console.log('PASS parser: each prefix, combinations, any case, unknown prefix = plain word, quoting, lone prefix')
}

// ── da: forms ──
{
  assert.deepEqual(parseDateQuery('2026'), { year: 2026 })
  assert.deepEqual(parseDateQuery('2026-07'), { year: 2026, month: 7 })
  assert.deepEqual(parseDateQuery('2026-7'), { year: 2026, month: 7 })
  assert.deepEqual(parseDateQuery('2026-07-22'), { year: 2026, month: 7, day: 22 })
  assert.deepEqual(parseDateQuery('jul'), { month: 7 })
  assert.deepEqual(parseDateQuery('July'), { month: 7 })
  assert.deepEqual(parseDateQuery('sept'), { month: 9 })
  for (const bad of ['ju', '2026-13', '2026-07-32', 'foo', '26', '2026/07']) assert.equal(parseDateQuery(bad), null, `"${bad}" is no date`)
  assert.deepEqual(parseLooseDate('2026-07-22'), { year: 2026, month: 7, day: 22 })
  assert.deepEqual(parseLooseDate('"2026-07-22T10:00"'), { year: 2026, month: 7, day: 22 })
  assert.deepEqual(parseLooseDate('11 July 2026'), { year: 2026, month: 7, day: 11 })
  assert.deepEqual(parseLooseDate('July 11, 2026'), { year: 2026, month: 7, day: 11 })
  assert.deepEqual(parseLooseDate('July 2026'), { year: 2026, month: 7 })
  assert.deepEqual(parseLooseDate('2026'), { year: 2026 })
  assert.equal(parseLooseDate('{YYYY-MM-DD}'), null)
  assert.equal(datePartsMatch({ year: 2026, month: 7 }, { year: 2026, month: 7, day: 22 }), true)
  assert.equal(datePartsMatch({ month: 7 }, { year: 2025, month: 7, day: 15 }), true, 'a month name is that month in any year')
  assert.equal(datePartsMatch({ year: 2026, month: 7 }, { year: 2026 }), false, 'a year-only date is not in a given month')
  assert.equal(folderFrom('external-workshops/York-July-2026/day-3', 'york'), 'York-July-2026/day-3')
  assert.equal(folderFrom('external-workshops/York-July-2026/day-3', 'day-3'), 'day-3')
  assert.equal(folderFrom('misc', 'york'), null)
  console.log('PASS da: forms: 2026, 2026-07, 2026-7, 2026-07-22, jul/july/sept; frontmatter dates in four spellings')
}

// ── fixture vault ──
const vault = mkdtempSync(join(tmpdir(), 'tw-talk-prefixes-'))
const base = Date.parse('2026-09-01T10:00:00Z')
let clock = 0
const paths = {}
function talk(rel, slug, frontmatter) {
  const dir = join(vault, rel, slug)
  mkdirSync(dir, { recursive: true })
  const outlinePath = join(dir, `${slug}-outline.md`)
  writeFileSync(outlinePath, `---\noutline_version: 2\n${frontmatter}\n---\n\n### Opening\n\nWelcome\n`)
  const at = new Date(base + ++clock * 60_000)
  utimesSync(outlinePath, at, at)
  paths[slug] = outlinePath
}
function run(slug, id, fields) {
  const dir = join(vault, '_PRESENTATIONS', slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, talkSlug: slug, kind: 'delivery', status: 'delivered', ...fields }))
}
const york = 'external-workshops/York-July-2026'
// Day 1: given (Runs) only. Day 2: dated in frontmatter only. Day 3: both, and an event.
const days = {
  'day-1': [['frontier', 'Research & the Frontier of AI'], ['peer-reviewer', 'From Intern to Peer Reviewer'], ['how-llms', 'How LLMs Work']],
  'day-2': [['app-building', 'Vibecoding for Researchers: App Building 101'], ['vibecoding-lab', 'Vibecoding Lab'], ['chat-history', 'From Chat History to Durable Records']],
  'day-3': [['agents-research', 'AI Agents for Research: Beyond the Chatbot'], ['inspectable', 'Inspectable AI'], ['open-source', 'Open Source & Local AI']]
}
for (const [day, talks] of Object.entries(days)) {
  const date = { 'day-1': '2026-07-20', 'day-2': '2026-07-21', 'day-3': '2026-07-22' }[day]
  for (const [slug, title] of talks) {
    const fm = [`title: "${title}"`]
    if (day !== 'day-1') fm.push(`date: ${date}`)
    if (day === 'day-3') fm.push('event: Festival of AI Competency — University of York')
    talk(`${york}/${day}`, slug, fm.join('\n'))
    if (day !== 'day-2') run(slug, `run-${slug}`, { startedAt: `${date}T10:00:00`, eventTitle: 'Festival of AI Competency' })
  }
}
talk('ai-in-education/jersey-2026', 'from-intern-to-toolmaker-jersey', 'title: From Intern To Toolmaker - Jersey')
talk('ai-in-education/jersey-2026', 'teaching-cognitive-revolution-jersey', 'title: Teaching During The Cognitive Revolution')
talk('ai-in-education/jersey-2026', 'vibecoding-as-pedagogy', 'title: Vibecoding As Pedagogy')
talk('misc', 'june-talk', 'title: A June Talk\ndate: 2026-06-30')
run('june-talk', 'run-june', { startedAt: '2026-08-01T10:00:00', eventTitle: 'August day' })
talk('misc', 'old-july', 'title: Given Last July')
run('old-july', 'run-old', { startedAt: '2025-07-15T10:00:00', eventTitle: 'Summer school 2025' })
talk('misc', 'written-date', 'title: Written Date\ndate: 11 July 2026')
talk('misc', 'colon-title', 'title: Notes on ab:cd')
talk('agents', 'mondai-slides', 'title: Agents = Files in folders')
talk('agents', 'mondai-roundup', 'title: MondAI RoundUp\nseries: MondAI')
talk('AI Agent Workshops', 'agents-pm', 'title: Agents for Project Managers')
talk('cache', 'hidden-cache-talk', 'title: Cached York copy\ndate: 2026-07-22')

const slides = new Map([
  [paths['mondai-slides'], [{ nav_title: 'MondAI RoundUp', source_markdown: '## MondAI RoundUp\n\n- weekly news' }]],
  [paths['agents-research'], [{ nav_title: 'Agents', source_markdown: '## Agents\n\nTools that act' }]]
])
const cacheDir = mkdtempSync(join(tmpdir(), 'tw-talk-prefixes-cache-'))
const index = createVaultIndex({ cachePath: join(cacheDir, 'vault-index.json') })
await index.refresh(vault)
const search = createTalkSearch({ vaultRoot: () => vault, talks: () => index.cached(vault), slideRows: (p) => slides.get(p) ?? [] }, { revalidateMs: 0 })
const slugs = async (q, opts) => (await search.searchTalks(q, opts)).hits.map((h) => h.slug).sort()
const yorkAll = Object.values(days).flat().map(([slug]) => slug).sort()
const dayThree = days['day-3'].map(([slug]) => slug).sort()

// da: — the talk's own date or any delivery date.
{
  assert.deepEqual(await slugs('da:2026-07'), [...yorkAll, 'written-date'].sort(),
    'da:2026-07: all nine York talks (given, dated, or both) and the talk dated "11 July 2026"; nothing from June, August or 2025')
  assert.deepEqual(await slugs('da:2026-7'), await slugs('da:2026-07'))
  assert.deepEqual(await slugs('da:2026-07-22'), dayThree)
  assert.deepEqual(await slugs('da:2026-07-21'), days['day-2'].map(([s]) => s).sort(), 'a frontmatter date alone is enough')
  assert.deepEqual(await slugs('da:2026-07-20'), days['day-1'].map(([s]) => s).sort(), 'a delivery date alone is enough')
  assert.deepEqual(await slugs('da:jul'), [...yorkAll, 'written-date', 'old-july'].sort(), 'jul: July in any year')
  assert.deepEqual(await slugs('da:July'), await slugs('da:jul'))
  assert.deepEqual(await slugs('da:2025'), ['old-july'])
  assert.deepEqual(await slugs('da:2026-06'), ['june-talk'])
  assert.deepEqual(await slugs('da:aug'), ['june-talk'], 'given in August although dated in June')
  assert.deepEqual(await slugs('da:2026-13'), [], 'an unreadable date matches nothing')
  const r = await search.searchTalks('da:2026-07-20')
  const line = r.hits.find((h) => h.slug === 'frontier').match
  assert.equal(line.label, 'given')
  assert.equal(line.text, '20 Jul 2026 · Festival of AI Competency')
  assert.deepEqual(line.highlights, [[0, 11]], 'the date is marked')
  const dated = (await search.searchTalks('da:2026-07-21')).hits.find((h) => h.slug === 'vibecoding-lab').match
  assert.deepEqual([dated.label, dated.text, dated.highlights], ['date', '2026-07-21', [[0, 10]]], 'a frontmatter date says `date`')
  console.log('PASS da:: 2026-07 → 9 York + 1 dated July 2026; days, months in any year, years; `given` / `date` lines')
}

// fo: fi: met: co: — each narrows to its field; combinations; the L6 line.
{
  assert.deepEqual(await slugs('fo:jersey'), ['from-intern-to-toolmaker-jersey', 'teaching-cognitive-revolution-jersey', 'vibecoding-as-pedagogy'], 'fo:jersey: the folder named with jersey')
  assert.deepEqual(await slugs('jersey'), ['from-intern-to-toolmaker-jersey', 'teaching-cognitive-revolution-jersey', 'vibecoding-as-pedagogy'])
  assert.deepEqual(await slugs('fi:jersey'), ['from-intern-to-toolmaker-jersey', 'teaching-cognitive-revolution-jersey'], 'fi: the file name only')
  const listed = (await index.cached(vault)).filter((t) => !t.outlinePath.includes('/cache/')).map((t) => t.slug).sort()
  assert.equal(listed.length, 19)
  assert.deepEqual(await slugs('fi:outline'), listed, 'every file name says outline')
  assert.deepEqual(await slugs('met:festival'), dayThree, 'met: frontmatter details only (Runs also say Festival)')
  assert.deepEqual(await slugs('festival'), [...days['day-1'], ...days['day-3']].map(([s]) => s).sort(), 'the plain word also finds the Runs')
  assert.deepEqual(await slugs('met:agents'), [], 'met: is not the title')
  assert.deepEqual(await slugs('mondai'), ['mondai-roundup', 'mondai-slides'])
  assert.deepEqual(await slugs('co:mondai'), ['mondai-slides'], 'co:mondai: only slide text')
  const co = (await search.searchTalks('co:mondai')).hits[0].match
  assert.deepEqual([co.label, co.text], ['slides', '“MondAI RoundUp”'])
  assert.deepEqual(await slugs('FO:York'), yorkAll)
  assert.deepEqual(await slugs('fo:"AI Agent Workshops"'), ['agents-pm'], 'a quoted folder with spaces')
  assert.deepEqual(await slugs('ab:cd'), ['colon-title'], 'an unknown prefix is a plain word')
  assert.deepEqual(await slugs('fo:york da:2026-07 agents'), ['agents-research'], 'prefixed and plain words: all must match')
  assert.deepEqual(await slugs('fo:york co:tools'), ['agents-research'])
  assert.deepEqual(await slugs('fo:jersey da:2026-07'), [])
  assert.deepEqual(await slugs('fo:york-july-2026 da:2026-07-22', { within: york }), dayThree, 'prefixes work inside a drilled-in folder')

  // L6: exactly the three day-3 talks; line two says when and in which folder.
  const l6 = await search.searchTalks('fo:york-july-2026 da:2026-07-22')
  assert.deepEqual(l6.hits.map((h) => h.slug).sort(), dayThree)
  assert.deepEqual(l6.terms, [{ text: 'york-july-2026', field: 'folder' }, { text: '2026-07-22', field: 'date' }])
  for (const h of l6.hits) {
    assert.equal(h.match.label, 'given')
    assert.equal(h.match.text, '22 Jul 2026 · York-July-2026 / day-3')
    assert.deepEqual(h.match.highlights, [[0, 11], [14, 28]], 'the date and the folder term are marked')
  }
  // The lone prefix is no search, and the ignored cache folder stays hidden.
  assert.deepEqual((await search.searchTalks('fo:')).hits, [])
  assert.equal((await slugs('da:2026-07-22')).includes('hidden-cache-talk'), false)
  console.log('PASS fo: fi: met: co:: each field alone; combinations; quoted folder; L6 → 3 day-3 talks, `given 22 Jul 2026 · York-July-2026 / day-3`')
}

// The completion source: folders at every depth with the talks directly in them.
{
  const folders = await search.folders()
  assert.deepEqual(folders, [
    { path: 'AI Agent Workshops', talks: 1 },
    { path: 'agents', talks: 2 },
    { path: 'ai-in-education', talks: 0 },
    { path: 'ai-in-education/jersey-2026', talks: 3 },
    { path: 'external-workshops', talks: 0 },
    { path: 'external-workshops/York-July-2026', talks: 0 },
    { path: 'external-workshops/York-July-2026/day-1', talks: 3 },
    { path: 'external-workshops/York-July-2026/day-2', talks: 3 },
    { path: 'external-workshops/York-July-2026/day-3', talks: 3 },
    { path: 'misc', talks: 4 }
  ], 'every depth, ancestors with 0 of their own, ignored folders left out')
  console.log('PASS completion source: 10 folders at every depth, counts from the search’s own talk scan')
}

rmSync(vault, { recursive: true, force: true })
rmSync(cacheDir, { recursive: true, force: true })
console.log('PASS talk search prefixes: fo: fi: met: co: da:, combinations, date forms, completion source')
