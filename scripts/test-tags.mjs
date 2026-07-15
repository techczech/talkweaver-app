// Slide tags (ADR-0037) — end-to-end unit coverage of the pure layers:
//   1. trigger-line PARSE: `tags=a,b` is ONE token (unquoted comma form), other commas still
//      concatenate; quoted form also accepted;
//   2. normalisation: messy case/whitespace → lowercase-kebab; engine ↔ shared/tags.ts parity;
//   3. applySlideTags WRITE: merge / remove / create-token / last-tag-removal, byte-preserving
//      everything else (incl. {id=…} in its own group);
//   4. projections: rows carry normalised `tags`; tagging never changes render_hash;
//   5. vocabulary aggregation (counts, ordering) + tagsOfBlock (renderer read).
//
// Runs the shared TypeScript via Node's native type stripping (Node ≥ 22.18), same as
// test-metadata-registry.mjs.

import { strict as assert } from 'node:assert'

const triggers = await import('../compiler/scripts/lib/02-triggers-layout.mjs')
const edit = await import('../compiler/scripts/lib/12-outline-edit.mjs')
const projections = await import('../compiler/scripts/lib/10-projections.mjs')
const shared = await import(new URL('../src/shared/tags.ts', import.meta.url))

let failures = 0
function check(name, fn) {
  try {
    fn()
    console.log('  ✓ ' + name)
  } catch (e) {
    failures += 1
    console.error('  ✗ ' + name)
    console.error('    ' + (e && e.message ? e.message.split('\n').join('\n    ') : e))
  }
}

// ── 1. parse ────────────────────────────────────────────────────────────────────
console.log('Trigger parse:')
check('tags=a,b parses as ONE token beside {id=…}', () => {
  const { attrs, warnings } = triggers.parseHeadingAttrs('Title {id=ab12c tags=intro,team}')
  assert.equal(attrs.id, 'ab12c')
  assert.equal(attrs.tags, 'intro,team')
  assert.deepEqual(warnings, [])
})
check('parseTriggerLine accepts the ADR storage form', () => {
  const parsed = triggers.parseTriggerLine('{id=ab12c} {tags=intro,ai-history}')
  assert.ok(parsed)
  assert.equal(parsed.attrs.tags, 'intro,ai-history')
  assert.deepEqual(parsed.warnings, [])
})
check('quoted tags value also parses', () => {
  const parsed = triggers.parseTriggerLine('{tags="intro, team"}')
  assert.equal(parsed.attrs.tags, 'intro, team')
})
check('comma concatenation of bare triggers is unchanged', () => {
  const { attrs } = triggers.parseHeadingAttrs('T {numbered,reveal}')
  // both bare words resolved through the dictionary — two separate keys, no tags leakage
  assert.ok(!('tags' in attrs))
  assert.ok(Object.keys(attrs).length >= 1)
})
check('absent tags → no tags attr', () => {
  const parsed = triggers.parseTriggerLine('{id=ab12c layout=quote}')
  assert.ok(!('tags' in parsed.attrs))
})

// ── 2. normalisation + parity ───────────────────────────────────────────────────
console.log('Normalisation:')
const MESSY = ['AI History', ' Quotes  about Expertise ', 'closing', 'Café/Bar', '--x--', 'ŽLUŤOUČKÝ']
check('lowercase-kebab normalisation', () => {
  assert.equal(edit.normalizeTag('AI History'), 'ai-history')
  assert.equal(edit.normalizeTag(' Quotes  about Expertise '), 'quotes-about-expertise')
  assert.equal(edit.normalizeTag('--x--'), 'x')
  assert.equal(edit.normalizeTag('***'), '')
})
check('engine ↔ shared normalizeTag parity', () => {
  for (const t of MESSY) assert.equal(edit.normalizeTag(t), shared.normalizeTag(t), `input: ${t}`)
})
check('parseTagsValue: messy case → kebab, deduped, order kept', () => {
  assert.deepEqual(edit.parseTagsValue('Intro, AI History,intro , ,Team'), ['intro', 'ai-history', 'team'])
  assert.deepEqual(edit.parseTagsValue(''), [])
  assert.deepEqual(shared.parseTagsValue('Intro, AI History,intro'), ['intro', 'ai-history'])
})

// ── 3. applySlideTags ───────────────────────────────────────────────────────────
console.log('applySlideTags:')
const OUTLINE = [
  '---',
  'title: Fixture',
  '---',
  '',
  '# Fixture',
  '',
  '## Section one',
  '',
  '### Plain slide',
  '',
  '- a bullet',
  '',
  '### Stamped slide',
  '{layout=quote} {id=ab12c}',
  '',
  '> quoted',
  '',
  '### Tagged slide',
  '{id=cd34e} {tags=intro,team}',
  '',
  '- body {id=zz99z} mentioned in prose stays',
  ''
].join('\n')

check('create token: new Trigger line under an unstamped heading; all other bytes intact', () => {
  const { text, tags } = edit.applySlideTags(OUTLINE, { heading: '### Plain slide', occurrence: 1 }, { add: ['AI History'] })
  assert.deepEqual(tags, ['ai-history'])
  const lines = text.split('\n')
  assert.equal(lines[9], '{tags=ai-history}')
  assert.equal(text.replace('\n{tags=ai-history}', ''), OUTLINE) // exactly one inserted line
})
check('create token beside an existing {id=…}: own groups, id byte-preserved', () => {
  const { text } = edit.applySlideTags(OUTLINE, { heading: '### Stamped slide', occurrence: 1 }, { add: ['closing'] })
  assert.ok(text.includes('{layout=quote} {id=ab12c} {tags=closing}'))
  assert.equal(text.split('\n').length, OUTLINE.split('\n').length) // no line added/removed
})
check('merge: add joins, existing kept, dedupe, remove drops only its tag', () => {
  const { text, tags } = edit.applySlideTags(
    OUTLINE,
    { heading: '### Tagged slide', occurrence: 1 },
    { add: ['Intro', 'ai-history'], remove: ['team'] }
  )
  assert.deepEqual(tags, ['intro', 'ai-history'])
  assert.ok(text.includes('{id=cd34e} {tags=intro,ai-history}'))
  assert.ok(text.includes('- body {id=zz99z} mentioned in prose stays')) // deep body id untouched
})
check('last-tag removal: token goes; line survives while other tokens remain', () => {
  const step1 = edit.applySlideTags(OUTLINE, { heading: '### Tagged slide', occurrence: 1 }, { remove: ['intro', 'team'] })
  assert.deepEqual(step1.tags, [])
  assert.ok(step1.text.includes('{id=cd34e}'))
  assert.ok(!step1.text.includes('tags='))
  assert.equal(step1.text.split('\n').length, OUTLINE.split('\n').length)
})
check('last-tag removal on a tags-only Trigger line removes the whole line', () => {
  const base = OUTLINE.replace('{id=cd34e} {tags=intro,team}', '{tags=intro}')
  const { text } = edit.applySlideTags(base, { heading: '### Tagged slide', occurrence: 1 }, { remove: ['intro'] })
  assert.ok(!text.includes('{tags='))
  assert.equal(text.split('\n').length, base.split('\n').length - 1)
})
check('no-op write returns the SAME text reference', () => {
  const res = edit.applySlideTags(OUTLINE, { heading: '### Tagged slide', occurrence: 1 }, { add: ['intro'] })
  assert.equal(res.text, OUTLINE)
  assert.deepEqual(res.tags, ['intro', 'team'])
})
check('heading-carried tags are absorbed onto the Trigger line (heading scrubbed)', () => {
  const base = OUTLINE.replace('### Plain slide', '### Plain slide {tags=Legacy}')
  const { text, tags } = edit.applySlideTags(base, { heading: '### Plain slide {tags=Legacy}', occurrence: 1 }, { add: ['intro'] })
  assert.deepEqual(tags, ['legacy', 'intro'])
  assert.ok(text.includes('### Plain slide\n{tags=legacy,intro}'))
})
check('readSlideTags + blockRefsForId', () => {
  assert.deepEqual(edit.readSlideTags(OUTLINE, { heading: '### Tagged slide', occurrence: 1 }), ['intro', 'team'])
  assert.deepEqual(edit.blockRefsForId(OUTLINE, 'ab12c'), [{ heading: '### Stamped slide', occurrence: 1 }])
  assert.deepEqual(edit.blockRefsForId(OUTLINE, 'zz99z'), []) // prose mention is not a stamp
})

// ── 4. projections ──────────────────────────────────────────────────────────────
console.log('Projections:')
function fakeModel(attrs) {
  return {
    slides: [{
      id: 's1', title: 'A slide', blocks: [{ type: 'paragraph', text: 'hello' }],
      attrs, sourceMarkdown: '### A slide\n\nhello\n'
    }]
  }
}
check('rows carry normalised tags from the tags= trigger', () => {
  const rows = projections.buildPerSlideProjections(fakeModel({ tags: 'Intro, AI History' }), 'deck')
  assert.deepEqual(rows[0].tags, ['intro', 'ai-history'])
})
check('absent tags → []', () => {
  const rows = projections.buildPerSlideProjections(fakeModel({}), 'deck')
  assert.deepEqual(rows[0].tags, [])
})
check('tagging never changes render_hash (thumbnail cache stays warm)', () => {
  const a = projections.buildPerSlideProjections(fakeModel({}), 'deck')[0]
  const b = projections.buildPerSlideProjections(fakeModel({ tags: 'intro,team' }), 'deck')[0]
  assert.equal(a.render_hash, b.render_hash)
  assert.equal(a.content_hash, b.content_hash)
})

// ── 5. vocabulary + renderer read ───────────────────────────────────────────────
console.log('Vocabulary & renderer read:')
check('vocabularyFromTagLists: counts per occurrence, sorted count desc then name', () => {
  const vocab = shared.vocabularyFromTagLists([
    ['intro', 'team'], ['intro'], undefined, [], ['closing'], ['closing'], ['ai-history', 'intro']
  ])
  assert.deepEqual(vocab, [
    { name: 'intro', count: 3 },
    { name: 'closing', count: 2 },
    { name: 'ai-history', count: 1 },
    { name: 'team', count: 1 }
  ])
})
check('tagsOfBlock reads the Trigger line (blank-line tolerated), never body prose', () => {
  assert.deepEqual(shared.tagsOfBlock('### T {tags=intro}\n\n- body'), ['intro'])
  assert.deepEqual(shared.tagsOfBlock('### T\n{id=ab12c} {tags=intro,team}\n\n- body'), ['intro', 'team'])
  assert.deepEqual(shared.tagsOfBlock('### T\n\n{tags=intro}\n\n- body'), ['intro'])
  assert.deepEqual(shared.tagsOfBlock('### T\n\n- prose about {tags=fake}'), [])
  assert.deepEqual(shared.tagsOfBlock('### T\n{tags="intro, team"}'), ['intro', 'team'])
})

if (failures > 0) {
  console.error(`\ntest-tags: ${failures} failure(s).`)
  process.exit(1)
}
console.log('\ntest-tags: all checks passed.')
