// The per-slide notes wrapper (injectPerSlideNotes, compiler/scripts/lib/08-source-adapters.mjs):
// each slide's own Markdown goes into its notes inside a fence. A fixed four-backtick fence closed
// early when the slide's text already held a ```` fence (e.g. after a second run), and every later
// slide rendered as visible code. The fence is now one longer than the longest backtick run opening
// a line of the wrapped text (at least four). Checked through the compiler's own tree parse, the
// compile, and the outline migrator's fence reader.
import { strict as assert } from 'node:assert'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { injectPerSlideNotes, notesWrapperFence, prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { parseOutlineTree } from '../compiler/scripts/lib/14-outline-tree.mjs'
import { migrateOutline } from '../compiler/scripts/migrate-outline.mjs'

let checks = 0
const check = async (name, fn) => { await fn(); checks++; console.log(`  ✓ ${name}`) }

const slideFour = ['### Four ticks', '', '````md', '```js', 'x()', '```', '````']
const slideFive = ['### Five ticks', '', '`````md', '````md', 'nested', '````', '`````']
const slidePlain = ['### Plain', '', '- visible after the fences']
const slideCode = ['### Three ticks', '', '```js', 'y()', '```']
const talk = ['---', 'title: Fence guard', '---', '', '## Section', '', ...slideFour, '', ...slideFive, '', ...slidePlain, '', ...slideCode, ''].join('\n')
const injected = injectPerSlideNotes(talk)

const slidesOf = (text) => {
  const out = []
  const visit = (n) => { for (const c of n.children || []) { out.push(c); visit(c) } }
  visit(parseOutlineTree(text).root)
  return out
}
// The Markdown the wrapper holds, read back from a slide's notes: between the `<fence>md` line after
// the label and the first line that closes it (same marker, at least as long).
const wrapped = (notesLines) => {
  const at = notesLines.indexOf('**Markdown for this slide:**')
  assert.ok(at >= 0, 'the label is in the notes')
  const open = notesLines[at + 1].match(/^(`{4,})md$/)
  assert.ok(open, `a wrapper fence opens: ${notesLines[at + 1]}`)
  const fence = open[1]
  const end = notesLines.findIndex((l, i) => i > at + 1 && /^`+\s*$/.test(l.trim()) && l.trim().length >= fence.length)
  assert.ok(end > 0, 'the wrapper closes')
  return { fence, text: notesLines.slice(at + 2, end).join('\n') }
}

console.log('Fence length:')
await check('at least four, else one more than the longest backtick run opening a line', () => {
  assert.equal(notesWrapperFence('no fences'), '````')
  assert.equal(notesWrapperFence('```js\nx\n```'), '````')
  assert.equal(notesWrapperFence(slideFour.join('\n')), '`````')
  assert.equal(notesWrapperFence(slideFive.join('\n')), '``````')
  assert.equal(notesWrapperFence('  ````md\n  ````'), '`````')
  assert.equal(notesWrapperFence('text with ```````` mid-line'), '````', 'only runs at line start count')
})

console.log('Round trip through the tree parse:')
await check('every slide survives: none swallowed into an earlier wrapper', () => {
  assert.deepEqual(slidesOf(injected).map((n) => n.title), ['Section', 'Four ticks', 'Five ticks', 'Plain', 'Three ticks'])
})
await check('each slide\'s notes hold its own Markdown verbatim, ```` and ````` included', () => {
  const byTitle = new Map(slidesOf(injected).map((n) => [n.title, n]))
  for (const [title, lines, fence] of [['Four ticks', slideFour, '`````'], ['Five ticks', slideFive, '``````'], ['Plain', slidePlain, '````'], ['Three ticks', slideCode, '````']]) {
    const got = wrapped(byTitle.get(title).notesLines)
    assert.equal(got.fence, fence, title)
    assert.equal(got.text, lines.join('\n'), title)
  }
})
await check('the content of each slide is unchanged (notes stay notes)', () => {
  const plain = slidesOf(injected).find((n) => n.title === 'Plain')
  assert.ok(plain.contentLines.some((l) => l.includes('visible after the fences')))
  assert.equal(plain.contentLines.some((l) => l.includes('Markdown for this slide')), false)
})

console.log('Compile and migrator:')
await check('the compiled deck has every slide and no wrapper text shows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-notes-fence-'))
  const path = join(dir, 'fence-guard-outline.md')
  writeFileSync(path, injected, 'utf8')
  const model = await prepareSource(path, injected, 'fence-guard', statSync(path))
  const titles = model.slides.map((s) => s.title)
  for (const t of ['Four ticks', 'Five ticks', 'Plain', 'Three ticks']) assert.ok(titles.includes(t), `${t} in ${titles.join(' | ')}`)
  const shown = (s) => JSON.stringify(s.blocks ?? [])
  for (const s of model.slides) {
    assert.equal(shown(s).includes('Markdown for this slide'), false, `${s.title} shows no notes`)
    if (s.title !== 'Five ticks') assert.equal(shown(s).includes('nested'), false, `${s.title} shows no other slide's code`)
  }
  assert.ok(shown(model.slides.find((s) => s.title === 'Plain')).includes('visible after the fences'), 'the slide after the fences renders as a slide')
})
await check('the outline migrator reads the longer fence as opaque (no heading inside it is touched)', () => {
  const { text } = migrateOutline(injected)
  // The wrapped copies of the headings inside the notes keep their bytes; the real ones may gain ids.
  for (const heading of ['### Four ticks', '### Five ticks', '### Plain', '### Three ticks']) {
    assert.ok(text.split('\n').filter((l) => l === heading).length >= 1, `${heading}: its wrapped copy is untouched`)
  }
  assert.deepEqual(slidesOf(text).map((n) => n.title), ['Section', 'Four ticks', 'Five ticks', 'Plain', 'Three ticks'])
})
await check('running the wrapper twice still swallows nothing', () => {
  const twice = injectPerSlideNotes(injected)
  assert.deepEqual(slidesOf(twice).map((n) => n.title), ['Section', 'Four ticks', 'Five ticks', 'Plain', 'Three ticks'])
})

console.log(`notes-wrapper-fence: ${checks} checks passed`)
