// Slide Scratchpad: the pure panel logic in src/shared/scratchpad.ts. Typed prefixes and chips are one
// state (the query text), highlighting, lists and counts, and arrival-batch headings.
import assert from 'node:assert/strict'
import {
  batchSections, dayHeading, groupCounts, highlightSegments, inList, listCounts, matchesQuery, parseQuery,
  toggleTypeInQuery, titleFromFileName, typeCounts, visibleItems
} from '../src/shared/scratchpad.ts'
import { sourceOutlineCandidates } from '../src/renderer/src/lib/scratchpadSourceThumbs.ts'
import { clampBox, collapse, defaultLayout, dock, expand, float, parseLayout, toggle } from '../src/shared/scratchpad-layout.ts'

let checks = 0
const check = (name, fn) => { fn(); checks++ }

const slide = (id, title, talk, over = {}) => ({
  id, kind: 'slide', addedAt: '2026-10-27T21:10:00.000Z', batch: { source: 'slide-browser', at: '2026-10-27T21:10:00.000Z' },
  group: null, status: 'active', title, description: '', sources: [], missing: false,
  slide: { talkPath: `t/${talk}.md`, talkTitle: talk, slideId: id, title, markdown: `### ${title}\n\n- predicts the next word\n`, thumbKey: 'k' }, ...over
})
const file = (id, name, fileKind, over = {}) => ({
  id, kind: 'file', file: name, fileKind, addedAt: '2026-10-27T18:00:00.000Z', batch: { source: 'agent', at: '2026-10-27T22:40:00.000Z' },
  group: null, status: 'active', title: name.replace(/\.[a-z]+$/, ''), description: 'A loop of four steps', sources: [], missing: false, ...over
})
const items = [
  slide('a', 'What is a language model', 'Introduction to AI for researchers'),
  slide('b', 'A research loop', 'AI in the research workflow', { group: 'g1' }),
  file('c', 'research-loop.html', 'html'),
  file('d', 'diagram.svg', 'svg', { group: 'g1' }),
  file('e', 'photo.png', 'pic', { status: 'kept' }),
  file('f', 'old.svg', 'svg', { status: 'rejected' })
]

check('prefixes set types, from takes a word or a quoted phrase, plain words are terms', () => {
  assert.deepEqual(parseQuery('svg: html: loop'), { types: ['svg', 'html'], from: [], terms: ['loop'] })
  assert.deepEqual(parseQuery('Slides: pictures:cat'), { types: ['slide', 'pic'], from: [], terms: ['cat'] })
  assert.deepEqual(parseQuery('from:research loop'), { types: [], from: ['research'], terms: ['loop'] })
  assert.deepEqual(parseQuery('from: research loop'), { types: [], from: ['research'], terms: ['loop'] })
  assert.deepEqual(parseQuery('from:"ai in" x'), { types: [], from: ['ai in'], terms: ['x'] })
  assert.deepEqual(parseQuery('  '), { types: [], from: [], terms: [] })
})

check('chips edit the query text: add the prefix in front, take it off again, keep the rest', () => {
  assert.equal(toggleTypeInQuery('loop', 'svg'), 'svg: loop')
  assert.equal(toggleTypeInQuery('svg: loop', 'svg'), 'loop')
  assert.equal(toggleTypeInQuery('svg:diagram loop', 'svg'), 'diagram loop')
  assert.equal(toggleTypeInQuery('pictures: x', 'pic'), 'x')
  assert.equal(toggleTypeInQuery('slide: x', 'html'), 'html: slide: x')
  // typing a prefix lights the chip: the chip state is read from the same text
  assert.deepEqual(parseQuery(toggleTypeInQuery('', 'html')).types, ['html'])
})

check('matching: type, source talk, and every plain word over title, description, talk, slide text and file name', () => {
  const find = (q) => items.filter((i) => matchesQuery(i, parseQuery(q))).map((i) => i.id)
  assert.deepEqual(find('svg:'), ['d', 'f'])
  assert.deepEqual(find('slide:'), ['a', 'b'])
  assert.deepEqual(find('from:workflow'), ['b'])
  assert.deepEqual(find('loop'), ['b', 'c', 'd', 'e', 'f']) // title of b, description of the files
  assert.deepEqual(find('next word'), ['a', 'b'])
  assert.deepEqual(find('RESEARCH-LOOP'), ['c'])
  assert.deepEqual(find('four steps html:'), ['c'])
  assert.deepEqual(find('nothing-here'), [])
})

check('highlight splits on hits, ignores one-letter terms and regex characters', () => {
  assert.deepEqual(highlightSegments('A research loop', ['loop']), [{ text: 'A research ', hit: false }, { text: 'loop', hit: true }])
  assert.deepEqual(highlightSegments('abc', ['a']), [{ text: 'abc', hit: false }])
  assert.deepEqual(highlightSegments('a.b a+b', ['a+b']), [{ text: 'a.b ', hit: false }, { text: 'a+b', hit: true }])
  assert.deepEqual(highlightSegments('Loop LOOP', ['loop']).filter((s) => s.hit).length, 2)
})

check('lists: All, Picked slides and Agent visuals are active only; Kept and Rejected are their status', () => {
  const ids = (list) => items.filter((i) => inList(i, list)).map((i) => i.id)
  assert.deepEqual(ids('all'), ['a', 'b', 'c', 'd'])
  assert.deepEqual(ids('slides'), ['a', 'b'])
  assert.deepEqual(ids('visuals'), ['c', 'd'])
  assert.deepEqual(ids('kept'), ['e'])
  assert.deepEqual(ids('rejected'), ['f'])
  assert.deepEqual(listCounts(items), { all: 4, slides: 2, visuals: 2, kept: 1, rejected: 1, active: 4 })
  assert.deepEqual(typeCounts(items), { slide: 2, svg: 1, html: 1, pic: 0 })
})

check('group filter and query combine; Kept and Rejected ignore the group filter', () => {
  const ids = (view) => visibleItems(items, { list: 'all', group: 'all', query: '', ...view }).map((i) => i.id)
  assert.deepEqual(ids({ group: 'g1' }).sort(), ['b', 'd'])
  assert.deepEqual(ids({ group: 'ungrouped' }).sort(), ['a', 'c'])
  assert.deepEqual(ids({ group: 'g1', query: 'svg:' }), ['d'])
  assert.deepEqual(ids({ list: 'kept', group: 'g1' }), ['e'])
  assert.deepEqual(groupCounts(items, [{ id: 'g1', name: 'Opening' }, { id: 'g2', name: 'Maybe' }]), { all: 4, ungrouped: 2, byId: { g1: 2, g2: 0 } })
})

check('equal-time picked slides retain their source order rather than random item ID order', () => {
  const first = slide('z', 'First', 'Talk'); const second = slide('a', 'Second', 'Talk')
  second.addedAt = first.addedAt; second.batch = first.batch
  assert.deepEqual(batchSections([first, second]).flatMap(section => section.items.map(item => item.id)), ['z', 'a'])
})

check('newest first by batch time', () => {
  assert.deepEqual(visibleItems(items, { list: 'all', group: 'all', query: '' }).map((i) => i.id), ['c', 'd', 'a', 'b'])
})

check('batch headings: one section per arrival batch, day heading and a source label with the time', () => {
  const now = new Date(2026, 9, 27, 23, 30)
  const local = (y, m, d, h, mi) => new Date(y, m, d, h, mi).toISOString()
  const list = [
    file('1', 'a.svg', 'svg', { batch: { source: 'agent', at: local(2026, 9, 27, 22, 40) } }),
    file('2', 'b.svg', 'svg', { batch: { source: 'agent', at: local(2026, 9, 27, 22, 40) } }),
    slide('3', 'S', 't', { batch: { source: 'slide-browser', at: local(2026, 9, 27, 23, 5) } }),
    slide('4', 'T', 't', { batch: { source: 'slide-browser', at: local(2026, 9, 15, 14, 0) } })
  ]
  const sections = batchSections(list, now)
  assert.deepEqual(sections.map((s) => [s.day, s.label, s.items.length]), [
    ['Added today', 'Picked from Slide Browser 23:05', 1],
    ['Added today', 'Made by agent 22:40', 2],
    ['Added Thursday 15 October', 'Picked from Slide Browser 14:00', 1]
  ])
  assert.equal(dayHeading(new Date(2026, 9, 26, 9, 0), now), 'Added yesterday')
  assert.equal(dayHeading(new Date(2026, 9, 24, 9, 0), now), 'Added Saturday')
})

check('layout: collapse remembers the open mode, toggle goes back to it, dock and float set it', () => {
  const vp = { w: 1400, h: 900 }
  const start = defaultLayout(vp)
  assert.equal(start.mode, 'collapsed')
  const open = float(expand(start))
  assert.equal(open.mode, 'float')
  const docked = dock(open)
  assert.deepEqual([docked.mode, docked.restore], ['docked', 'docked'])
  const pill = collapse(docked)
  assert.deepEqual([pill.mode, pill.restore], ['collapsed', 'docked'])
  assert.equal(toggle(pill).mode, 'docked'); assert.equal(toggle(toggle(pill)).mode, 'collapsed')
  assert.equal(collapse(pill), pill)
})

check('layout: a stored box is clamped to the window it opens in; odd storage falls back to the default', () => {
  const vp = { w: 1000, h: 700 }
  const box = clampBox({ x: 900, y: -50, w: 5000, h: 10 }, vp)
  assert.deepEqual(box, { x: 0, y: 28, w: 1000, h: 320 })
  assert.deepEqual(clampBox({ x: 5000, y: 5000, w: 500, h: 400 }, vp), { x: 500, y: 640, w: 500, h: 400 })
  const stored = JSON.stringify({ mode: 'docked', restore: 'float', box: { x: 10, y: 40, w: 600, h: 500 } })
  assert.deepEqual(parseLayout(stored, vp), { mode: 'docked', restore: 'float', box: { x: 10, y: 40, w: 600, h: 500 } })
  for (const bad of [null, '', '{nope', '42', JSON.stringify({ mode: 'huge', box: { x: 'a' } })]) assert.deepEqual(parseLayout(bad, vp), defaultLayout(vp))
})

check('titles from file names: no extension, no leading "slide-", spaces, sentence case', () => {
  assert.equal(titleFromFileName('slide-deep-research-history.svg'), 'Deep research history')
  assert.equal(titleFromFileName('error-evidence.html'), 'Error evidence')
  assert.equal(titleFromFileName('timeline_ai_research.png'), 'Timeline AI research')
  assert.equal(titleFromFileName('Slide_Tool-finder.html'), 'Tool finder')
  assert.equal(titleFromFileName('slide.svg'), 'Slide', 'a name that is only "slide" keeps its word')
  assert.equal(titleFromFileName('slidedeck-notes.html'), 'Slidedeck notes', 'only "slide-" as a word is dropped')
  assert.equal(titleFromFileName('v1.2-chart.svg'), 'V1.2 chart')
  assert.equal(titleFromFileName('noext'), 'Noext')
  assert.equal(titleFromFileName('slide-ai-error-checking-history.svg'), 'AI error checking history')
  assert.equal(titleFromFileName('gpqa-and-mmlu-uk-us-llm-html-svg.html'), 'GPQA and MMLU UK US LLM HTML SVG')
  assert.equal(titleFromFileName('said-it.svg'), 'Said it', 'acronyms only match whole words')
})
check('the file name stays searchable', () => {
  const it = file('x', 'slide-deep-research-history.svg', 'svg', { title: 'Deep research history' })
  assert.equal(matchesQuery(it, parseQuery('slide-deep')), true)
})

check('a picked slide finds its source talk: absolute path as is, else the named vault first, then every vault', () => {
  const vaults = [{ id: 'v1', root: '/a/one/' }, { id: 'v2', root: '/b/two' }]
  assert.deepEqual(sourceOutlineCandidates({ talkPath: '/x/t/t-outline.md' }, vaults), ['/x/t/t-outline.md'])
  assert.deepEqual(sourceOutlineCandidates({ talkPath: 'agents/t-outline.md', vaultId: 'v2' }, vaults), ['/b/two/agents/t-outline.md', '/a/one/agents/t-outline.md'])
  assert.deepEqual(sourceOutlineCandidates({ talkPath: 'agents/t-outline.md' }, vaults), ['/a/one/agents/t-outline.md', '/b/two/agents/t-outline.md'])
})

console.log(`${checks} checks passed`)
