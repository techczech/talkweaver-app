// Ticket 2b parity: the presenter outline and the exported pages search with the generated runtime
// (compiler/assets/runtime/slide-search.js); the app searches with src/shared/slide-handling/query.ts. They are the
// same code (query.ts with its types removed), so one table of queries and slides must give the same parse, match,
// field hits, highlight and snippet from both. Also: the generated file is current, and overview.js's rankSlides (the
// pages' hit list) names the same slides the app's search does.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as app from '../src/shared/slide-handling/query.ts'
import { renderSlideSearchRuntime, runtimePath } from './build-slide-search-runtime.mjs'

const here = dirname(fileURLToPath(import.meta.url))
let checks = 0
const check = (name, fn) => { try { fn() } catch (e) { e.message = `${name}: ${e.message}`; throw e } checks++ }

check('generated runtime is current (npm run generate:slide-search-runtime)', () => {
  assert.equal(readFileSync(runtimePath, 'utf8'), renderSlideSearchRuntime())
})

const runtimeSource = readFileSync(runtimePath, 'utf8')
const overviewSource = readFileSync(join(here, '..', 'compiler', 'assets', 'runtime', 'overview.js'), 'utf8')
const loaded = new Function(`${runtimeSource}\n${overviewSource}\nreturn { SlideSearch, rankSlides }`)()
const runtime = loaded.SlideSearch

check('the runtime exports every function the app module exports', () => {
  const appFunctions = Object.keys(app).filter((name) => typeof app[name] === 'function').sort()
  assert.deepEqual(Object.keys(runtime).sort(), appFunctions)
})

const slides = [
  { title: 'Intro to Methods', body: 'Welcome everyone\nWe use the survey method', image: '', notes: '' },
  { title: 'Results', body: 'Clear output\n- Item one\n- Item two', image: 'Bar chart of sample sizes', notes: 'mention the sample' },
  { title: 'Method notes', body: 'we used a survey method', image: '', notes: 'remember the demo' },
  { title: 'Closing', body: 'Thank you', image: 'Thank you slide logo', notes: '' },
  { title: 'Ünïcode & (regex) [chars]', body: 'price is $5.00 (net) \\ done', image: '', notes: '' },
  { title: 'Long line', body: `${'word '.repeat(40)}needle ${'tail '.repeat(30)}`, image: '', notes: '' },
]
const queries = [
  '', '   ', 'method', 'methods survey', 'METHOD', 'sample', 'chart', 'thank you', 'demo', 'zzz',
  't:method', 's:method', 'i:chart', 'i:thank', 'e:"survey method"', 'e:the sample', 't:', 'e:',
  '"survey method"', 'from:talk', 'pic:chart', 'slide:method', 'svg:x', 'html:', 'needle', 'a', '$5.00', '(regex)',
  'ünï', '\\', 'item two', 'one\nclear', 'e:"one\ntwo"',
]
const same = (name, got, want) => check(name, () => assert.deepEqual(got, want))

for (const raw of queries) {
  for (const opts of [undefined, { operators: false }, { prefixes: false }]) {
    same(`parse ${JSON.stringify(raw)} ${JSON.stringify(opts)}`, runtime.parseQuery(raw, opts), app.parseQuery(raw, opts))
  }
  const qa = app.parseQuery(raw)
  const qr = runtime.parseQuery(raw)
  same(`isEmpty ${raw}`, runtime.isEmptyQuery(qr), app.isEmptyQuery(qa))
  same(`terms ${raw}`, runtime.highlightTerms(qr), app.highlightTerms(qa))
  for (const [i, slide] of slides.entries()) {
    const label = `${JSON.stringify(raw)} on slide ${i}`
    same(`prepare ${label}`, runtime.prepareFields(slide), app.prepareFields(slide))
    const pa = app.prepareFields(slide)
    same(`matchSlide ${label}`, runtime.matchSlide(pa, qr, 'My talk'), app.matchSlide(pa, qa, 'My talk'))
    same(`matchFields ${label}`, runtime.matchFields(pa, qr), app.matchFields(pa, qa))
    same(`fieldHits ${label}`, runtime.fieldHits(pa, qr), app.fieldHits(pa, qa))
    same(`snippet ${label}`, runtime.snippet(slide, qr), app.snippet(slide, qa))
    same(`highlight ${label}`, runtime.highlightSegments(slide.title, runtime.highlightTerms(qr)), app.highlightSegments(slide.title, app.highlightTerms(qa)))
  }
}

// What the presenter and the exported pages list as hits is what the app's search says is a hit.
for (const raw of queries) {
  const qa = app.parseQuery(raw)
  const data = slides.map((slide, index) => ({ index, ...slide, section: '', subsection: '' }))
  const fromApp = app.isEmptyQuery(qa) ? data.map((s) => s.index) : data.filter((s) => app.matchSlide(app.prepareFields(s), qa)).map((s) => s.index)
  same(`rankSlides ${JSON.stringify(raw)}`, loaded.rankSlides(raw, data), fromApp)
}

// The new reading: presenter notes are searched with the whole slide, quoted as "in notes", and the app's own surfaces
// (which carry no notes) behave as before.
check('notes: a notes-only word hits and is quoted', () => {
  const q = app.parseQuery('demo')
  assert.equal(app.matchSlide(app.prepareFields(slides[2]), q), true)
  assert.equal(app.snippet(slides[2], q).label, 'in notes')
})
check('notes: s: and t: do not read notes', () => {
  assert.equal(app.matchSlide(app.prepareFields(slides[2]), app.parseQuery('s:demo')), false)
  assert.equal(app.matchSlide(app.prepareFields(slides[2]), app.parseQuery('t:demo')), false)
})
check('no notes: the same slide without notes is not a hit', () => {
  assert.equal(app.matchSlide(app.prepareFields({ ...slides[2], notes: undefined }), app.parseQuery('demo')), false)
})

console.log(`test-overview-parity: ${checks} checks passed`)
