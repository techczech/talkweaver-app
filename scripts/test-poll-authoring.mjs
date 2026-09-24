import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const dir = mkdtempSync(join(tmpdir(), 'tw-poll-authoring-'))
let count = 0
async function compile(body, frontmatter = true) {
  const text = (frontmatter ? '---\ntitle: Polls\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n' : '# Polls\n\n') + body
  const path = join(dir, `poll-${++count}.md`)
  writeFileSync(path, text)
  return prepareSource(path, text, 'Polls', statSync(path))
}
const cases = []
function test(name, fn) { cases.push([name, fn]) }
const rows = '- Alpha\n- Bravo\n\nSome context\n\n- Charlie'
const getPoll = model => model.slides.find(slide => slide.poll)?.poll

for (const type of ['single', 'multiple']) {
  test(`legacy ${type} poll uses only top-level options in the first list block`, async () => {
    const model = await compile(`### Choose? {poll=${type}}\n- First\n  - Explanation\n- Second\n\nContext\n\n- Later list`)
    assert.deepEqual(getPoll(model)?.options.map(option => option.label), ['First', 'Second'])
  })
}
test('ranking defaults to all options across list blocks in authored order', async () => {
  const model = await compile(`### Priorities? {id=priorities poll=ranking}\n\n${rows}`)
  assert.deepEqual(getPoll(model), { pollId: 'poll-priorities', type: 'ranking', question: 'Priorities?', options: ['Alpha', 'Bravo', 'Charlie'].map((label, i) => ({ optionId: `poll-priorities-option-${i + 1}`, label })), visibility: 'live' })
  assert(!model.warnings.some(w => /unknown-trigger|unresolved-trigger/.test(w)))
})
test('ranking includes nested list rows in authored order', async () => {
  const model = await compile('### Priorities? {poll=ranking}\n- Parent\n  - Child\n- Last')
  assert.deepEqual(getPoll(model)?.options.map(option => option.label), ['Parent', 'Child', 'Last'])
})
test('ranking requires at least one option', async () => {
  const model = await compile('### Priorities? {poll=ranking}')
  assert.equal(getPoll(model), undefined)
  assert(model.warnings.some(w => /^poll-authoring-invalid:/.test(w)))
})
test('duplicate poll metadata is rejected even across heading and body', async () => {
  for (const body of [
    '### Priorities? {poll=ranking polltop=1 polltop=2}\n- A\n- B',
    '### Priorities? {poll=ranking polltop=1}\n{polltop=1}\n- A\n- B',
    '### Priorities? {poll=single poll=ranking}\n- A\n- B'
  ]) {
    const model = await compile(body)
    assert.equal(getPoll(model), undefined)
    assert(model.warnings.some(w => /^poll-authoring-invalid:/.test(w)))
  }
})
test('blank authored rows invalidate ranking and matrix polls without dropping the row', async () => {
  for (const syntax of ['{poll=ranking}', '[scale: Low, High]', '[categories: Work, Home]']) {
    const model = await compile(`### Question\n${syntax}\n- A\n- \n- B`)
    assert.equal(getPoll(model), undefined)
    assert(model.warnings.some(w => /^poll-authoring-invalid:/.test(w)))
    assert(model.slides[0].sourceMarkdown.includes('- \n'))
  }
})
test('ranking top N and held visibility', async () => {
  const model = await compile(`### Priorities? {poll=ranking polltop=2 pollresults=held}\n${rows}`)
  assert.equal(getPoll(model)?.rankCount, 2)
  assert.equal(getPoll(model)?.visibility, 'held')
})
for (const [directive, type, labels] of [['scale', 'rating', ['1', '2', '3', '4']], ['scale', 'rating', ['Low', 'Medium', 'High']], ['categories', 'categorisation', ['Work', 'Home', 'Both', 'Neither']]]) {
  test(`${directive} infers ${type}, strips directive and preserves source`, async () => {
    const line = `[${directive}: ${labels.join(', ')}]`
    const model = await compile(`### Your view? {id=view}\n\n${line}\n\n${rows}`)
    const poll = getPoll(model)
    assert.equal(poll?.type, type)
    assert.equal(poll.allowSkip, false)
    assert.deepEqual(poll.labels, labels.map((label, i) => ({ optionId: `poll-view-label-${i + 1}`, label })))
    const slide = model.slides.find(s => s.poll)
    assert(!JSON.stringify(slide.blocks).includes(line))
    assert(slide.sourceMarkdown.includes(line))
    assert(!model.warnings.some(w => /unknown-trigger|unresolved-trigger/.test(w)))
  })
}
test('standalone scale works without frontmatter or any brace trigger', async () => {
  const model = await compile('### Your view?\n\n[scale: Low, High]\n\n- One\n- Two', false)
  assert.equal(getPoll(model)?.type, 'rating')
})
test('matrix allows explicit skipping', async () => {
  const model = await compile(`### Your view? {poll=rating pollskip=true}\n[scale: Low, High]\n${rows}`)
  assert.equal(getPoll(model)?.allowSkip, true)
})
test('poll IDs and label IDs follow deduplicated slide IDs reproducibly', async () => {
  const body = '### First {id=same}\n[scale: Low, High]\n- A\n\n### Second {id=same}\n[categories: Work, Home]\n- B'
  const first = (await compile(body)).slides.filter(s => s.poll)
  const second = (await compile(body)).slides.filter(s => s.poll)
  assert.deepEqual(first.map(s => s.poll), second.map(s => s.poll))
  assert.equal(new Set(first.map(s => s.poll.pollId)).size, 2)
  for (const slide of first) {
    assert.equal(slide.poll.pollId, `poll-${slide.id}`)
    assert.equal(slide.poll.options[0].optionId, `poll-${slide.id}-option-1`)
    assert.equal(slide.poll.labels[0].optionId, `poll-${slide.id}-label-1`)
  }
})
test('directives and poll trigger examples inside code fences remain literal', async () => {
  const model = await compile('### Examples\n\n````markdown\n[scale: Low, High]\n```\n[categories: A, B]\n{poll=ranking polltop=1}\n````\n\n- A\n- B')
  assert.equal(getPoll(model), undefined)
  assert(model.fullHtml.includes('[scale: Low, High]'))
  assert(!model.warnings.some(w => /^poll/.test(w)))
})
for (const example of ['{poll=ranking}', '[scale: Low, High]', '[categories: Work, Home]']) {
  test(`tilde-fenced ${example} remains a literal example`, async () => {
    const model = await compile(`### Examples\n~~~markdown\n${example}\n~~~\n- A\n- B`)
    assert.equal(getPoll(model), undefined)
    const code = model.slides.flatMap(slide => slide.blocks).find(block => block.type === 'code')
    assert(code, 'the example remains a rendered code block')
    assert(JSON.stringify(code).includes(example))
    assert(!model.warnings.some(w => /^poll/.test(w)))
  })
}
test('tilde wrapper protects example headings and shorter or other fence markers', async () => {
  const model = await compile('### Examples\n~~~~markdown\n### Example question {poll=ranking}\n~~~\n```\n{polltop=1}\n[scale: Low, High]\n~~~~\n- A\n- B')
  assert.equal(model.slides.length, 1)
  assert.equal(getPoll(model), undefined)
  assert(model.slides[0].sourceMarkdown.includes('### Example question {poll=ranking}'))
  assert(!model.warnings.some(w => /^poll/.test(w)))
})
test('inline prose or inline code containing scale text does not infer a poll', async () => {
  const model = await compile('### Examples\nUse [scale: Low, High] here.\n\n`[categories: A, B]`\n\n- A')
  assert.equal(getPoll(model), undefined)
})
for (const [name, attrs, directive] of [
  ...['0', '-1', '4', '1.5', 'two', 'true', ''].map(value => [`invalid top ${value}`, `poll=ranking polltop=${value}`, '']),
  ['top on wrong type', 'poll=single polltop=1', ''],
  ['empty labels', '', '[scale: ]'], ['blank label', '', '[scale: Low, , High]'],
  ['duplicate labels', '', '[scale: Low, Low]'], ['malformed directive', '', '[scale: Low, High'],
  ['duplicate directives', '', '[scale: Low, High]\n[scale: Low, High]'],
  ['conflicting directives', '', '[scale: Low, High]\n[categories: Work, Home]'],
  ['conflicting explicit type', 'poll=ranking', '[scale: Low, High]'],
  ['missing matrix labels', 'poll=rating', ''],
  ['invalid skip', 'pollskip=perhaps', '[scale: Low, High]'],
  ['skip on wrong type', 'poll=ranking pollskip=true', '']
]) {
  test(`${name} warns and creates no poll`, async () => {
    const model = await compile(`### Question? {${attrs}}\n${directive}\n- A\n- B\n- C`)
    assert.equal(getPoll(model), undefined)
    assert(model.warnings.some(w => /^poll/.test(w)), JSON.stringify(model.warnings))
  })
}
let failures = 0
try {
  for (const [name, run] of cases) {
    try { await run(); console.log(`PASS ${name}`) }
    catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`) }
  }
} finally { rmSync(dir, { recursive: true, force: true }) }
console.log(`${cases.length - failures}/${cases.length} poll authoring tests passed`)
process.exitCode = failures ? 1 : 0
