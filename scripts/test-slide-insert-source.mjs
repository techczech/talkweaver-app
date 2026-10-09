// Inserting slides from another talk (src/shared/slide-insert-source.ts), the one helper both insert
// routes use: "Slides from other talks…" (SearchPalette.tsx) and the Slide Browser (useInsert.ts).
// A quick check's stored source is stripped of `{right}` (participants never see the answer); the
// copy must still carry it, read from the source talk's outline. Every other slide kind inserts its
// stored source unchanged. Rows come from the REAL compiler, so the stripping is the shipped one.
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildPerSlideProjections } from '../compiler/scripts/lib/10-projections.mjs'
import { checkBlockFromOutline, insertItemsFor, isQuickCheckRow, rowMarkdown } from '../src/shared/slide-insert-source.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let checks = 0
const check = async (name, fn) => { await fn(); checks++; console.log(`  ✓ ${name}`) }

const talk = [
  '---', 'title: Source talk', '---', '',
  '## Before', '{id=pw}{prework}', '',
  '### Which one?', '{id=quiz}{poll=single}{check}', '', '- Alpha', '- Beta {right}', '- Gamma', '',
  '## Main', '{id=main}', '',
  '### Plain slide', '{id=plain}', '', '- one', '- two', '',
  'Some prose with {right} in it literally.', '',
].join('\n')

const scratch = mkdtempSync(join(tmpdir(), 'tw-insert-source-'))
const outlinePath = join(scratch, 'source-talk-outline.md')
writeFileSync(outlinePath, talk, 'utf8')
const model = await prepareSource(outlinePath, talk, 'source-talk', statSync(outlinePath), undefined, { projectionsOnly: true })
const rows = buildPerSlideProjections(model, 'source-talk').map((r) => ({ ...r, talkSlug: 'source-talk', outlinePath }))
const quiz = rows.find((r) => r.slide_id === 'quiz')
const plain = rows.find((r) => r.slide_id === 'plain')
assert.ok(quiz && plain, 'the fixture compiles to both slides')
const reads = []
const readOutline = async (p) => { reads.push(p); return p === outlinePath ? talk : null }

console.log('Quick checks keep their right answer:')
await check('the stored source has no {right} (the participant-facing invariant still holds)', () => {
  assert.equal(quiz.source_markdown.includes('{right}'), false)
  assert.equal(JSON.stringify(rows).includes('Beta {right}'), false)
  assert.equal(isQuickCheckRow(quiz), true)
  assert.equal(isQuickCheckRow(plain), false)
})
await check('a copied quick check carries its {right} marker, otherwise byte-identical to its block', async () => {
  const [item] = await insertItemsFor([quiz], readOutline)
  assert.equal(item.markdown, '### Which one?\n{id=quiz}{poll=single}{check}\n\n- Alpha\n- Beta {right}\n- Gamma')
  assert.equal(item.fromSlug, 'source-talk')
  assert.equal(item.sourceOutlinePath, outlinePath)
})
await check('found by id even when the indexed source line is stale', () => {
  const shifted = '\n\n\n' + talk
  assert.match(checkBlockFromOutline(shifted, { ...quiz, source_line: 1 }), /- Beta \{right\}/)
})
await check('an outline edited since indexing, or an unreadable talk, inserts the stored source', async () => {
  const edited = talk.replace('- Gamma', '- Gamma changed')
  assert.equal(checkBlockFromOutline(edited, quiz), null)
  const [item] = await insertItemsFor([{ ...quiz, outlinePath: '/nowhere.md' }], readOutline)
  assert.equal(item.markdown, quiz.source_markdown)
  const [failing] = await insertItemsFor([quiz], async () => { throw new Error('refused') })
  assert.equal(failing.markdown, quiz.source_markdown)
})

console.log('Other slide kinds are unchanged:')
await check('a plain slide inserts its stored source and reads no outline', async () => {
  reads.length = 0
  const [item] = await insertItemsFor([plain], readOutline)
  assert.equal(item.markdown, plain.source_markdown)
  assert.ok(item.markdown.includes('{right}'), 'a literal {right} on a non-check slide was never stripped and still is not')
  assert.deepEqual(reads, [])
})
await check('rowMarkdown keeps a stamped source and falls back to a heading', () => {
  assert.equal(rowMarkdown({ source_markdown: '### Hi\n{id=x}\n' }), '### Hi\n{id=x}\n')
  assert.equal(rowMarkdown({ source_markdown: '  \n', nav_title: 'Nav' }), '### Nav\n')
  assert.equal(rowMarkdown({}), '### Untitled\n')
})
await check('several rows keep their order and read each talk once', async () => {
  reads.length = 0
  const items = await insertItemsFor([plain, quiz, quiz], readOutline)
  assert.deepEqual(items.map((i) => i.markdown.includes('{right}')), [true, true, true])
  assert.equal(items[0].markdown, plain.source_markdown)
  assert.deepEqual(reads, [outlinePath])
})

console.log('Both insert routes use the one helper:')
await check('SearchPalette and the Slide Browser import insertItemsFor from shared/slide-insert-source; no local rowMarkdown', () => {
  for (const rel of ['src/renderer/src/components/SearchPalette.tsx', 'src/renderer/src/components/slide-browser/useInsert.ts']) {
    const src = readFileSync(join(root, rel), 'utf8')
    assert.match(src, /import \{[^}]*\binsertItemsFor\b[^}]*\} from '[./]*\/shared\/slide-insert-source(\.ts)?'/, rel)
  }
  for (const rel of ['src/renderer/src/components/SearchPalette.tsx', 'src/renderer/src/components/slide-browser/browserHelpers.ts']) {
    assert.doesNotMatch(readFileSync(join(root, rel), 'utf8'), /function rowMarkdown\b/, rel)
  }
})

console.log(`slide-insert-source: ${checks} checks passed`)
