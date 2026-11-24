// A fixed-seed sample of the write-path review's generated talks. Any failure names its seed and round.
import assert from 'node:assert/strict'
import { createSection, groupSection, reorderStructure } from '../src/shared/talk-structure.ts'
import { readSlides } from '../src/shared/insert-section.ts'

const seed = 1
let randomState = seed
function random() {
  randomState = (Math.imul(randomState, 1103515245) + 12345) >>> 0
  return randomState / 2 ** 32
}
const number = max => Math.floor(random() * max)
const pick = array => array[number(array.length)]
let uid = 0
function slide(level, triggers = []) {
  const id = 's' + ++uid
  const body = Array.from({ length: number(3) }, () => pick(['- point ' + ++uid, 'Para ' + ++uid, '![](a.png)']))
  if (random() < .15) body.push(':::notes', 'Note ' + ++uid, ':::')
  if (random() < .08) body.push('~~~', '## Fenced ' + ++uid, '~~~')
  if (random() < .08) body.push('<!--', '### Hidden ' + ++uid, '-->')
  return ['#'.repeat(level) + ' T' + id + ' {id=' + id + '}', ...triggers, ...body, ...(random() < .85 ? [''] : [])]
}

function talk() {
  const lines = random() < .7 ? ['---', 'title: Example', '---', ''] : []
  function children(level, count) {
    for (let i = 0; i < count; i++) {
      const carousel = level < 5 && random() < .12
      lines.push(...slide(level, carousel ? ['{carousel}'] : undefined))
      if (carousel) children(level + 1, 1 + number(3))
    }
  }
  if (random() < .5) children(3, 1 + number(3))
  const sections = number(4)
  for (let i = 0; i < sections; i++) {
    lines.push(...slide(2, random() < .5 ? [] : ['{role=section-title}']))
    children(3, number(3))
    const subsections = number(3)
    for (let k = 0; k < subsections; k++) {
      lines.push(...slide(3, ['{sub}{role=subsection-title}']))
      children(4, number(3))
    }
  }
  if (sections === 0) children(3, 1)
  let text = lines.join('\n')
  if (random() < .3) text = text.replace(/\n$/, '')
  if (random() < .3) text += '\n\n'
  return random() < .3 ? text.replace(/\n/g, '\r\n') : text
}

const lineOf = slide => slide.line + 1
const ids = slides => slides.map(slide => slide.id)
const crCount = text => (text.match(/\r/g) ?? []).length
function plainLines(text, slides, inserted) {
  const headings = new Set(slides.map(slide => slide.line))
  const insertedLine = slides.find(slide => slide.id === inserted)?.line ?? -2
  return text.split(/\r?\n/).flatMap((line, i) => {
    if (i === insertedLine || i === insertedLine + 1 || !line.trim()) return []
    return [headings.has(i) ? line.replace(/^#{2,6}(?= )/, '#') : line]
  })
}

const successes = { section: 0, subsection: 0, grouped: 0, moved: 0 }
for (let round = 0; round < 1800; round++) {
  const text = talk()
  const before = readSlides(text).slides
  const original = plainLines(text, before)
  const context = `seed ${seed}, round ${round}`
  assert.ok(before.length > 0, context)
  for (const kind of ['section', 'subsection']) {
    const after = random() < .1 ? null : lineOf(pick(before))
    const edit = createSection(text, { kind, after, id: 'inserted' })
    if (!edit.ok) continue
    successes[kind]++
    const slides = readSlides(edit.text).slides
    assert.deepEqual(ids(slides).filter(id => id !== 'inserted'), ids(before), context)
    assert.deepEqual(plainLines(edit.text, slides, 'inserted'), original, context)
    if (text.includes('\r\n')) assert.equal(/(^|[^\r])\n/.test(edit.text), false, context)
  }

  const start = number(before.length)
  const chosen = before.slice(start, start + 2 + number(3))
  const group = groupSection(text, chosen.map(lineOf), 'grouped')
  if (group.ok) {
    successes.grouped++
    const slides = readSlides(group.text).slides
    const owner = slides.findIndex(slide => slide.id === 'grouped')
    const roots = chosen.map(slide => before.indexOf(slide))
    const expected = before.filter((slide, i) => roots.includes(i) || slide.ancestors.some(parent => roots.includes(parent)))
    assert.deepEqual(ids(slides.filter(slide => slide.ancestors.includes(owner))), ids(expected), context)
    assert.deepEqual(ids(slides).filter(id => id !== 'grouped'), ids(before), context)
    assert.deepEqual(plainLines(group.text, slides, 'grouped'), original, context)
  }

  const picked = [...new Set(Array.from({ length: 1 + number(2) }, () => number(before.length)))]
  const target = pick(before)
  const side = pick(['before', 'after', 'inside'])
  const move = reorderStructure(text, picked.map(i => lineOf(before[i])), lineOf(target), side)
  if (!move.text) continue
  successes.moved++
  const slides = readSlides(move.text).slides
  assert.deepEqual(move.headingOrder.map(index => before[index].id), ids(slides), context)
  assert.deepEqual(plainLines(move.text, slides).sort(), original.slice().sort(), context)
  assert.equal(crCount(move.text), crCount(text), context)
  const moves = new Set(ids(before.filter((slide, i) => picked.includes(i) || slide.ancestors.some(parent => picked.includes(parent)))))
  const stayed = id => !moves.has(id)
  assert.deepEqual(ids(slides).filter(stayed), ids(before).filter(stayed), context)
  assert.deepEqual(ids(slides).filter(id => moves.has(id)), ids(before).filter(id => moves.has(id)), context)
  const first = slides.findIndex(slide => moves.has(slide.id))
  assert.ok(slides.slice(first, first + moves.size).every(slide => moves.has(slide.id)), context)
  if (side === 'before') assert.equal(first + moves.size, slides.findIndex(slide => slide.id === target.id), context)
}
for (const [kind, count] of Object.entries(successes)) assert.ok(count > 20, `exercise ${kind}`)
console.log(`Structure seed ${seed}: ${JSON.stringify(successes)} successful edits checked`)
