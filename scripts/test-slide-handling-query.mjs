// Slide handling, the one search rule (src/shared/slide-handling/query.ts): parse, matches, highlight, snippet.
import assert from 'node:assert/strict'
import {
  fieldHits, highlightSegments, highlightTerms, isEmptyQuery, matchHay, matchSlide, parseQuery, prepareFields, snippet
} from '../src/shared/slide-handling/query.ts'

let checks = 0
const check = (name, fn) => { try { fn() } catch (e) { e.message = `${name}: ${e.message}`; throw e } checks++ }
const P = (raw, opts) => parseQuery(raw, opts)
const slide = (title, body = '', image = '') => ({ title, body, image })
const hit = (f, raw, talk = '') => matchSlide(prepareFields(f), P(raw), talk)

// parse: operators (Browser)
for (const [raw, want] of [
  ['about me', { scope: 'all', exact: false, text: 'about me', terms: ['about', 'me'] }],
  ['', { scope: 'all', exact: false, text: '', terms: [] }],
  ['t:about me', { scope: 'title', exact: false, text: 'about me', terms: ['about', 'me'] }],
  ['s:pricing', { scope: 'body', exact: false, text: 'pricing', terms: ['pricing'] }],
  ['I:Diagram', { scope: 'image', exact: false, text: 'Diagram', terms: ['diagram'] }],
  ['e:"exact phrase"', { scope: 'all', exact: true, text: 'exact phrase', terms: ['exact', 'phrase'] }],
  ["t:'about me'", { scope: 'title', exact: false, text: 'about me', terms: ['about', 'me'] }],
  ['t:', { scope: 'title', exact: false, text: '', terms: [] }],
  ['http://example.com', { scope: 'all', exact: false, text: 'http://example.com', terms: ['http://example.com'] }],
  ['foo:bar', { scope: 'all', exact: false, text: 'foo:bar', terms: ['foo:bar'] }]
]) check(`parse ${raw}`, () => { const q = P(raw); assert.deepEqual({ scope: q.scope, exact: q.exact, text: q.text, terms: q.terms }, want); assert.deepEqual([q.types, q.from], [[], []]) })

// parse: the Browser path (operators only) tokenises as it did before: quotes kept, split on whitespace
for (const [raw, want] of [
  ['"foo bar"', { text: '"foo bar"', terms: ['"foo', 'bar"'] }],
  ['12" display', { text: '12" display', terms: ['12"', 'display'] }]
]) check(`browser parse ${raw}`, () => { const q = P(raw, { operators: true, prefixes: false }); assert.deepEqual({ text: q.text, terms: q.terms }, want) })

// parse: Scratchpad prefixes
check('prefixes', () => assert.deepEqual(P('svg: html: loop'), { scope: 'all', exact: false, text: 'loop', terms: ['loop'], types: ['svg', 'html'], from: [] }))
check('from quoted', () => { const q = P('from:"ai in" x'); assert.deepEqual([q.from, q.terms], [['ai in'], ['x']]) })
check('from space', () => assert.deepEqual(P('from: research loop').from, ['research']))
check('pictures alias, case', () => assert.deepEqual(P('Slides: pictures:cat').types, ['slide', 'pic']))
check('quoted word stays one', () => assert.deepEqual(P('"next word" model').terms, ['next word', 'model']))
check('operator beats prefix', () => assert.equal(P('t:slide: x').scope, 'title'))
check('opts: Scratchpad has no operators', () => assert.deepEqual(P('t:cat', { operators: false }).terms, ['t:cat']))
check('opts: Browser has no prefixes', () => { const q = P('svg: loop', { prefixes: false }); assert.deepEqual([q.types, q.terms], [[], ['svg:', 'loop']]) })
check('isEmpty', () => { assert.ok(isEmptyQuery(P(''))); assert.ok(isEmptyQuery(P('  '))); assert.ok(!isEmptyQuery(P('slide:'))); assert.ok(!isEmptyQuery(P('a'))) })

// matches
const s1 = slide('Hallucinated citations', 'a citation that looks real\n- but does not exist', 'Screenshot: chatbot reply')
check('all fields, each word anywhere', () => assert.ok(hit(s1, 'citations screenshot exist')))
check('missing word', () => assert.ok(!hit(s1, 'citations unicorn')))
check('case-insensitive', () => assert.ok(hit(s1, 'HALLUCINATED')))
check('title scope', () => { assert.ok(hit(s1, 't:hallucinated')); assert.ok(!hit(s1, 't:exist')) })
check('body scope', () => { assert.ok(hit(s1, 's:real')); assert.ok(!hit(s1, 's:screenshot')) })
check('picture scope', () => { assert.ok(hit(s1, 'i:chatbot')); assert.ok(!hit(s1, 'i:real')) })
check('exact phrase contiguous', () => { assert.ok(hit(s1, 'e:"looks real"')); assert.ok(!hit(s1, 'e:"real looks"')) })
check('empty matches all', () => { assert.ok(hit(s1, '')); assert.ok(hit(s1, 't:')) })
check('type prefix other than slide excludes slides', () => { assert.ok(!hit(s1, 'svg: citation')); assert.ok(hit(s1, 'slide: citation')) })
check('from: talk title', () => { assert.ok(hit(s1, 'from:research citation', 'AI in research')); assert.ok(!hit(s1, 'from:teaching citation', 'AI in research')) })
check('matchHay', () => { assert.ok(matchHay('abc def', P('def abc'))); assert.ok(!matchHay('abc def', P('e:"def abc"'))) })

// where it hits
check('fieldHits', () => {
  const f = prepareFields(s1)
  assert.deepEqual(fieldHits(f, P('citation')), { title: true, text: true, picture: false })
  assert.deepEqual(fieldHits(f, P('chatbot')), { title: false, text: false, picture: true })
  assert.deepEqual(fieldHits(f, P('t:real')), { title: false, text: false, picture: false })
  assert.deepEqual(fieldHits(f, P('')), { title: false, text: false, picture: false })
})

// highlight
check('highlight', () => assert.deepEqual(highlightSegments('A Citation, a citation.', ['citation']), [
  { text: 'A ', hit: false }, { text: 'Citation', hit: true }, { text: ', a ', hit: false }, { text: 'citation', hit: true }, { text: '.', hit: false }]))
check('highlight ignores one-letter terms and empty', () => { assert.deepEqual(highlightSegments('a b', ['a']), [{ text: 'a b', hit: false }]); assert.deepEqual(highlightSegments('', ['ab']), [{ text: '', hit: false }]) })
check('highlight escapes regex characters', () => assert.deepEqual(highlightSegments('a.b axb', ['a.b']).filter((s) => s.hit).map((s) => s.text), ['a.b']))
check('highlightTerms', () => { assert.deepEqual(highlightTerms(P('e:"looks real"')), ['looks real']); assert.deepEqual(highlightTerms(P('a bc')), ['a', 'bc']) })

// snippet
check('words the title already shows need no quote, the others do', () => {
  const sn = snippet(slide('Slide 4.4', '- point 4.4'), P('point 4.4'))
  assert.equal(sn.label, 'in text')
  assert.equal(snippet(slide('Slide 4.4', '- point 4.4'), P('slide 4.4')), null)
})
check('title hit: no snippet', () => assert.equal(snippet(s1, P('hallucinated')), null))
check('in text', () => {
  const sn = snippet(s1, P('exist'))
  assert.equal(sn.label, 'in text')
  assert.deepEqual(sn.segments.filter((s) => s.hit).map((s) => s.text), ['exist'])
  assert.equal(sn.segments.map((s) => s.text).join(''), '- but does not exist')
})
check('heading line is not quoted', () => assert.equal(snippet(slide('Intro', '### Zebra\nstripes'), P('zebra')), null))
check('in picture', () => { const sn = snippet(s1, P('chatbot')); assert.equal(sn.label, 'in picture'); assert.equal(sn.segments.map((s) => s.text).join(''), 'Screenshot: chatbot reply') })
check('text before picture', () => assert.equal(snippet(slide('x', 'cat here', 'cat there'), P('cat')).label, 'in text'))
check('long line clipped around the hit', () => {
  const sn = snippet(slide('x', `${'word '.repeat(40)}needle ${'tail '.repeat(40)}`), P('needle'))
  const text = sn.segments.map((s) => s.text).join('')
  assert.ok(text.length <= 95 && text.includes('needle') && text.startsWith('…') && text.endsWith('…'))
})
check('scoped: s: ignores picture', () => assert.equal(snippet(s1, P('s:chatbot')), null))
check('no terms, no snippet', () => assert.equal(snippet(s1, P('')), null))

console.log(`slide-handling query: ${checks} checks passed`)
