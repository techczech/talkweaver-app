// Slide Scratchpad ticket 2, inserting. Seams: the placement text operation (src/shared/scratchpad-insert.ts:
// "after slide N", "at the start", the caret inside a slide's text), the visuals of a picked slide's snapshot, the
// insert flow over a fake workspace (src/renderer/src/lib/scratchpadInsert.ts: one outline change per insert, a failed
// step changes nothing and says why, the picked slide goes through the Slide Browser's media step), and main's side
// (scratchpad-visual-import.ts and the scratchpad:* insert handlers over a real store in a temp talk: the right file
// is copied, an agent file is never written, a slide can only name its own visuals, nothing here writes an outline).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  caretInSlideBody, headingTitle, insertSlideAt, insertionPoint, placeForLine, placeRows, resolvePlace, restampTakenIds, scratchVisuals, settlePlace, visualNeedsCopy, visualSlide, PLACE_GONE
} from '../src/shared/scratchpad-insert.ts'
import { atCaretBlock, runScratchInsert, INSERT_TEXT } from '../src/renderer/src/lib/scratchpadInsert.ts'
import { createScratchVisualImporter, slideSourceOutline, slideVisualFile } from '../src/main/scratchpad-visual-import.ts'
import { registerScratchpadIpc } from '../src/main/scratchpad-ipc.ts'

let checks = 0
const test = async (name, fn) => { try { await fn(); checks++ } catch (error) { console.error(`FAIL ${name}`); throw error } }
const root = realpathSync(mkdtempSync(join(tmpdir(), 'tw-scratch-insert-')))

const TALK = [
  '---', 'title: AI for research', '---', '# AI for research', '',
  '## Reading', '', '### Where AI helps {id=helps}', '', '- Finding the literature', '', ':::notes', 'Say it slowly', ':::', '',
  '### Where it does not help', '', '- Judging', '', '```md', '### not a heading', '```', '',
  '## Writing', '', '### Drafts', '', 'Text', ''
].join('\n')
const lineOf = (text, heading) => text.split('\n').findIndex((l) => l.startsWith(heading)) + 1
/** The heading lines (the fenced example line in TALK is not one). */
const headings = (text) => text.split('\n').filter((l) => /^#{1,6}\s/.test(l) && l !== '### not a heading')

await test('a chosen place follows its slide; when an Undo takes the added slide back, the earlier place returns', () => {
  const helps = { kind: 'after', line: lineOf(TALK, '### Where AI helps'), title: 'Where AI helps' }
  const same = settlePlace(TALK, helps, [])
  assert.equal(same.place, helps, 'unchanged: the same object, so no re-render loop')
  const added = insertSlideAt(TALK, helps, '### What is an agent?\n\nA loop.')
  assert.ok(added.ok)
  const moved = { kind: 'after', line: added.line, title: 'What is an agent?' }
  // Still there after an edit above it: the same slide, at its new line.
  const shifted = settlePlace('extra\n' + added.text, moved, [helps])
  assert.deepEqual(shifted.place, { kind: 'after', line: added.line + 1, title: 'What is an agent?' })
  assert.deepEqual(shifted.earlier, [helps])
  // Undone: the slide is gone, the earlier place comes back.
  const undone = settlePlace(TALK, moved, [helps])
  assert.deepEqual(undone.place, helps)
  assert.deepEqual(undone.earlier, [])
  // Nothing left to fall back to: follow the cursor again (null), never a place naming a slide that is gone.
  assert.deepEqual(settlePlace(TALK, moved, []), { place: null, earlier: [] })
  assert.deepEqual(settlePlace(TALK, { kind: 'start' }, []).place, { kind: 'start' })
})

try {
  // ── Placement ──────────────────────────────────────────────────────────────────────────────────
  await test('rows: every slide heading with its line and title; a heading inside a code fence is not one', () => {
    assert.deepEqual(placeRows(TALK).map((r) => [r.level, r.title]), [[2, 'Reading'], [3, 'Where AI helps'], [3, 'Where it does not help'], [2, 'Writing'], [3, 'Drafts']])
    assert.equal(headingTitle('### Where AI helps {id=helps} {layout=cards}'), 'Where AI helps')
  })

  await test('after slide N: the new slide follows it, its notes and text, as its sibling; nothing else moves', () => {
    const place = { kind: 'after', line: lineOf(TALK, '### Where AI helps'), title: 'Where AI helps' }
    const r = insertSlideAt(TALK, place, '## A picked slide {id=picked1}\n\n![](img-abcdef1)\n')
    assert.ok(r.ok, r.error)
    assert.deepEqual(headings(r.text), ['# AI for research', '## Reading', '### Where AI helps {id=helps}', '### A picked slide {id=picked1}', '### Where it does not help', '## Writing', '### Drafts'])
    assert.ok(r.text.includes(':::notes\nSay it slowly\n:::\n\n### A picked slide {id=picked1}\n\n![](img-abcdef1)\n\n### Where it does not help'), 'after the notes, blank line each side')
    assert.equal(r.text.split('\n')[r.line - 1], '### A picked slide {id=picked1}')
    assert.equal(r.text.slice(r.from, r.to), '### A picked slide {id=picked1}\n\n![](img-abcdef1)')
    assert.equal(r.text.replace('### A picked slide {id=picked1}\n\n![](img-abcdef1)\n\n', ''), TALK, 'the rest of the talk is byte for byte the same')
    const p = insertionPoint(TALK, place)
    assert.ok(p.ok); assert.equal(TALK.slice(0, p.offset).trimEnd().split('\n').at(-1), ':::', 'the offset is just after the slide\'s notes')
    assert.equal(TALK.slice(p.offset).trimStart().split('\n')[0], '### Where it does not help'); assert.equal(p.level, 3)
  })

  await test('after a section heading: the new slide is the section\'s first slide, at its slides\' level', () => {
    const r = insertSlideAt(TALK, { kind: 'after', line: lineOf(TALK, '## Writing'), title: 'Writing' }, '### New')
    assert.ok(r.ok)
    assert.deepEqual(headings(r.text).slice(-3), ['## Writing', '### New', '### Drafts'])
  })

  await test('after the last slide of a section: before the next section, never under the slide', () => {
    const r = insertSlideAt(TALK, { kind: 'after', line: lineOf(TALK, '### Where it does not help'), title: 'Where it does not help' }, '#### Deep one\n\n##### Its child')
    assert.ok(r.ok)
    assert.deepEqual(headings(r.text).slice(3, 7), ['### Where it does not help', '### Deep one', '#### Its child', '## Writing'], 'its own headings move by the same number of levels')
    assert.ok(r.text.indexOf('```md\n### not a heading\n```') < r.text.indexOf('### Deep one'), 'after the fence that belongs to the slide')
  })

  await test('after slide A: straight after A\'s own text, never past the next part\'s `# ` heading and its intro', () => {
    const parts = '# T\n\n## A\n\nbody\n\n# Part two\n\nintro\n\n## B\n'
    const r = insertSlideAt(parts, { kind: 'after', line: 3, title: 'A' }, '### New')
    assert.ok(r.ok, r.error)
    assert.equal(r.text, '# T\n\n## A\n\nbody\n\n## New\n\n# Part two\n\nintro\n\n## B\n')
    assert.equal(r.line, 7)
  })

  await test('at the start: before the first slide, after the title and frontmatter', () => {
    const r = insertSlideAt(TALK, { kind: 'start' }, '### Opening')
    assert.ok(r.ok)
    assert.ok(r.text.startsWith('---\ntitle: AI for research\n---\n# AI for research\n\n## Opening\n\n## Reading'), JSON.stringify(r.text.slice(0, 90)))
    const empty = insertSlideAt('# Only a title\n', { kind: 'start' }, '### First')
    assert.equal(empty.text, '# Only a title\n\n### First\n')
  })

  await test('a place chosen earlier is found again after the text moved; a place that is gone refuses and changes nothing', () => {
    const place = { kind: 'after', line: lineOf(TALK, '### Drafts'), title: 'Drafts' }
    const edited = TALK.replace('### Where AI helps {id=helps}', 'A new paragraph\n\nanother\n\n### Where AI helps {id=helps}')
    assert.deepEqual(resolvePlace(edited, place), { kind: 'after', index: lineOf(edited, '### Drafts') - 1 })
    const r = insertSlideAt(edited, place, '### Last')
    assert.ok(r.ok); assert.deepEqual(headings(r.text).slice(-2), ['### Drafts', '### Last'])
    const gone = insertSlideAt(TALK.replace('### Drafts', '### Renamed'), place, '### Last')
    assert.deepEqual(gone, { ok: false, error: PLACE_GONE })
  })

  await test('refusals: a block that is no slide, a block that opens a fence, a talk with an open fence', () => {
    const place = { kind: 'after', line: lineOf(TALK, '### Drafts'), title: 'Drafts' }
    assert.equal(insertSlideAt(TALK, place, 'no heading').ok, false)
    assert.equal(insertSlideAt(TALK, place, '### X\n\n```js\nnever closed').ok, false)
    assert.equal(insertSlideAt(`${TALK}\n\`\`\`\nopen`, place, '### X').ok, false)
  })

  await test('the default place follows a line: after the slide holding it, at the start above the first slide', () => {
    assert.deepEqual(placeForLine(TALK, lineOf(TALK, '- Judging')), { kind: 'after', line: lineOf(TALK, '### Where it does not help'), title: 'Where it does not help' })
    assert.deepEqual(placeForLine(TALK, 2), { kind: 'start' })
    assert.deepEqual(placeForLine(TALK, null), { kind: 'start' })
  })

  await test('caret inside a slide body: text lines yes; heading, title, frontmatter, fence, notes no', () => {
    const at = (needle, plus = 0) => TALK.indexOf(needle) + plus
    assert.equal(caretInSlideBody(TALK, at('- Finding')), true)
    assert.equal(caretInSlideBody(TALK, at('- Finding', 5)), true, 'mid-line')
    assert.equal(caretInSlideBody(TALK, at('### Where AI helps', 4)), false, 'on the heading')
    assert.equal(caretInSlideBody(TALK, at('# AI for research')), false, 'the title line')
    assert.equal(caretInSlideBody(TALK, at('title: AI')), false, 'frontmatter')
    assert.equal(caretInSlideBody(TALK, at('Say it slowly')), false, 'speaker notes')
    assert.equal(caretInSlideBody(TALK, at('### not a heading')), false, 'inside a code fence')
    assert.equal(caretInSlideBody(TALK, at('Text')), true)
    // A caret on a line that opens a code fence or a comment (at its end, or anywhere on it) is not in the slide's
    // text: the visual would land inside the block. The same slide without the opener takes it.
    const fenced = '# T\n\n### S\n\nIntro\n```js\nlet a = 1\n```\n'
    assert.equal(caretInSlideBody(fenced, fenced.indexOf('```js') + 5), false, 'at the end of ```js')
    assert.equal(caretInSlideBody(fenced, fenced.indexOf('```js')), false, 'at the start of ```js')
    assert.equal(caretInSlideBody(fenced, fenced.indexOf('let a')), false, 'inside the fence')
    const commented = '# T\n\n### S\n\nIntro\n<!--\nhidden\n-->\n'
    assert.equal(caretInSlideBody(commented, commented.indexOf('<!--') + 4), false, 'at the end of <!--')
    assert.equal(caretInSlideBody(commented, commented.indexOf('hidden')), false, 'inside the comment')
    const inline = '# T\n\n### S\n\nSee <!-- a note --> here\n'
    assert.equal(caretInSlideBody(inline, inline.indexOf('a note')), false, 'inside a comment on its line')
    assert.equal(caretInSlideBody(inline, inline.indexOf('here')), true, 'after a closed comment on its line')
    assert.equal(caretInSlideBody(fenced, fenced.indexOf('Intro') + 5), true, 'the line above the fence')
  })


  await test('a visual at the caret is its own paragraph', () => {
    const text = 'para\nnext'
    assert.equal(atCaretBlock(text, 2, '![](x)'), '\n\n![](x)\n\n', 'mid-line')
    assert.equal(atCaretBlock('a\n\n\n\nb', 2, '![](x)'), '\n![](x)', 'on an empty line just under text')
    assert.equal(atCaretBlock('a\n\n\n\nb', 3, '![](x)'), '![](x)', 'on an empty line between blank lines')
    assert.equal(atCaretBlock('a\n\nb', 4, '![](x)'), '\n\n![](x)', 'at the end of the talk\'s last line')
    assert.equal(visualSlide('Chart {id=x}', '![](img-1234567)\n'), '### Chart id=x\n\n![](img-1234567)')
  })

  // ── Visuals in a snapshot ──────────────────────────────────────────────────────────────────────
  await test('a snapshot\'s visuals: pictures, SVG files, ```svg drawings and pages; not videos, not fenced examples', () => {
    const md = ['### Slide {id=s}', '', '![Benchmarks](assets/bench.png)', '![](img-abcdef1) ![](img-abcdef1)', '![](assets/flow.svg)', '[Embed: assets/loop.html]',
      '[Embed: https://example.org/page]', '![](vid-abcdef1)', '![](clip.mp4)', '```svg', '<svg xmlns="http://www.w3.org/2000/svg"/>', '```', '```md', '![](assets/example.png)', '```', '![web](https://example.org/p.jpg)'].join('\n')
    const v = scratchVisuals(md)
    assert.deepEqual(v.map((x) => [x.kind, x.ref, x.label, x.local]), [
      ['pic', 'assets/bench.png', 'Benchmarks', true], ['pic', 'img-abcdef1', 'img-abcdef1', false], ['svg', 'assets/flow.svg', 'flow.svg', true],
      ['page', 'assets/loop.html', 'loop.html', true], ['page', 'https://example.org/page', 'page', false], ['svg', '', 'SVG drawing', false], ['pic', 'https://example.org/p.jpg', 'web', false]
    ])
    assert.equal(v[5].markdown, '```svg\n<svg xmlns="http://www.w3.org/2000/svg"/>\n```')
    assert.deepEqual(v.map(visualNeedsCopy), [false, false, true, true, false, false, false], 'main copies SVG files and pages; pictures take the slide media path')
    assert.deepEqual(scratchVisuals('### Only text\n\n- a\n'), [])
  })

  // ── The insert flow over a fake workspace ──────────────────────────────────────────────────────
  const fakeHost = (over = {}) => {
    const log = []
    let text = over.text ?? TALK
    const host = {
      log,
      get text() { return text },
      talk: () => (over.talk ? over.talk() : '/v/talk/talk-outline.md'),
      editor: () => ({ path: '/v/talk/talk-outline.md', text, caret: over.caret ?? text.indexOf('- Judging') }),
      apply: async (path, mutate) => {
        log.push(['apply', path])
        try { const next = mutate(text); text = next; return { ok: true, changed: true, base: '', text: next, saved: { ok: true } } } catch (error) { return { ok: false, reason: 'refused', error: error.message, applied: false } }
      },
      insertAtCaret: async (block) => { log.push(['caret', block]); const c = host.editor().caret; text = text.slice(0, c) + block + text.slice(c); return true },
      prepareSlide: async (markdown, source) => { log.push(['prepare', source, markdown]); return over.prepare ? over.prepare(markdown) : markdown.replace('assets/bench.png', 'img-1111111') },
      api: {
        importVisual: async (id) => { log.push(['importVisual', id]); return over.importVisual ?? { ok: true, line: '![](img-2222222)' } },
        importSlideVisual: async (id, ref) => { log.push(['importSlideVisual', id, ref]); return { ok: true, line: '![](assets/flow.svg)' } },
        slideSource: async (id) => { log.push(['slideSource', id]); return over.source ?? { ok: true, outlinePath: '/other-vault/talk/source-outline.md' } },
        markInserted: async (id, title) => { log.push(['mark', id, title]); return { ok: true, snapshot: { groups: [], items: [], notices: [] } } }
      },
      notify: (message, kind) => log.push(['notify', kind, message])
    }
    return host
  }
  const slideItem = { id: 'sp-1', kind: 'slide', title: 'Benchmarks', slide: { talkPath: '/other-vault/talk/source-outline.md', talkTitle: 'Other', slideId: 'b1', title: 'Benchmarks', markdown: '### Benchmarks {id=b1}\n\n![](assets/bench.png)\n\n![](assets/flow.svg)\n', thumbKey: 'k' } }
  const fileItem = { id: 'sp-2', kind: 'file', title: 'Research loop', file: 'loop.png', fileKind: 'pic', missing: false }
  const helps = { kind: 'after', line: lineOf(TALK, '### Where AI helps'), title: 'Where AI helps' }
  const kinds = (host) => host.log.map((e) => e[0])

  await test('Insert visual only with the caret at the end of a fence opener: the visual goes in as a new slide, the fence is untouched', async () => {
    const fenced = '# T\n\n### S\n\nIntro\n```js\nlet a = 1\n```\n'
    const host = fakeHost({ text: fenced, caret: fenced.indexOf('```js') + 5 })
    const out = await runScratchInsert(host, { mode: 'visual', item: fileItem, visual: null, place: { kind: 'after', line: 3, title: 'S' }, atCaret: true })
    assert.equal(out.ok, true)
    assert.ok(!host.log.some((e) => e[0] === 'caret'), 'no caret insert')
    assert.ok(host.text.includes('```js\nlet a = 1\n```'), 'the fence is as it was')
    assert.ok(host.text.indexOf('### Research loop') > host.text.indexOf('let a = 1\n```'), 'a new slide after the fence')
  })

  await test('Insert whole slide: the Slide Browser\'s media step on the snapshot, then ONE seam change after slide N, then the item is marked', async () => {
    const host = fakeHost()
    const out = await runScratchInsert(host, { mode: 'slide', item: slideItem, place: helps })
    assert.equal(out.ok, true)
    assert.deepEqual(kinds(host), ['slideSource', 'prepare', 'apply', 'notify', 'mark'])
    assert.deepEqual(host.log[1], ['prepare', '/other-vault/talk/source-outline.md', slideItem.slide.markdown], 'the source talk in the other vault goes to the cross-vault step')
    assert.ok(host.text.includes('### Where AI helps {id=helps}') && host.text.includes('### Benchmarks {id=b1}\n\n![](img-1111111)'), 'what the media step returned is what went in')
    assert.deepEqual(host.log.at(-1), ['mark', 'sp-1', 'Benchmarks'])
    assert.deepEqual(out.newSlide, { kind: 'after', line: lineOf(host.text, '### Benchmarks'), title: 'Benchmarks' })
    // Inserting twice is allowed and lands twice.
    await runScratchInsert(host, { mode: 'slide', item: slideItem, place: helps })
    assert.equal(host.text.split('### Benchmarks').length - 1, 2)
  })

  await test('the same picked slide from this vault inserted twice: the second copy gets a fresh id, the first keeps its own', async () => {
    // Same vault: the media step keeps the markdown (and so its {id=…}) as it is.
    const host = fakeHost({ prepare: (markdown) => markdown })
    const same = { ...slideItem, slide: { ...slideItem.slide, markdown: '### Benchmarks\n{id=b1xyz}\n\nText\n' } }
    await runScratchInsert(host, { mode: 'slide', item: same, place: helps })
    assert.equal((host.text.match(/\{id=b1xyz\}/g) ?? []).length, 1, 'the first insert keeps the id')
    await runScratchInsert(host, { mode: 'slide', item: same, place: helps })
    const ids = [...host.text.matchAll(/\{id=([A-Za-z0-9_-]+)\}/g)].map((m) => m[1])
    assert.equal(ids.filter((id) => id === 'b1xyz').length, 1, 'the id is not there twice')
    assert.equal(new Set(ids).size, ids.length, 'every id in the talk is its own')
    const fresh = ids.find((id) => !['helps', 'b1xyz'].includes(id))
    assert.match(fresh, /^[0-9a-z]{5}$/, 'a fresh id in the ledger\'s form')
    // The pure step: ids the talk does not use are kept, a repeated one maps to one fresh id.
    assert.equal(restampTakenIds('### A {id=new01}', '### X {id=old01}'), '### A {id=new01}')
    let n = 0; const rng = () => [0.5, 0.123456789][n++ % 2]
    assert.equal(restampTakenIds('### A {id=old01}\n\n#### B {id=old01}', '### X {id=old01}', rng), `### A {id=${(0.123456789).toString(36).slice(2, 7)}}\n\n#### B {id=${(0.123456789).toString(36).slice(2, 7)}}`)
  })

  await test('Insert visual only: at the caret (one caret insert, no seam change) only when the place was not chosen and the caret is in a slide\'s text', async () => {
    const host = fakeHost()
    const place = placeForLine(TALK, lineOf(TALK, '- Judging'))
    assert.equal((await runScratchInsert(host, { mode: 'visual', item: fileItem, visual: null, place, atCaret: true })).ok, true)
    assert.deepEqual(kinds(host), ['importVisual', 'caret', 'notify', 'mark'])
    assert.deepEqual(host.log.at(-1), ['mark', 'sp-2', 'Where it does not help'])
    assert.ok(host.text.includes('- Judging'))
    const chosen = fakeHost()
    await runScratchInsert(chosen, { mode: 'visual', item: fileItem, visual: null, place: helps, atCaret: false })
    assert.deepEqual(kinds(chosen), ['importVisual', 'apply', 'notify', 'mark'], 'a chosen place: a new slide holding just the visual')
    assert.ok(chosen.text.includes('### Research loop\n\n![](img-2222222)\n\n### Where it does not help'))
    const onHeading = fakeHost({ caret: TALK.indexOf('### Drafts') })
    await runScratchInsert(onHeading, { mode: 'visual', item: fileItem, visual: null, place: helps, atCaret: true })
    assert.deepEqual(kinds(onHeading), ['importVisual', 'apply', 'notify', 'mark'], 'caret on a heading: a new slide instead')
  })

  await test('a picked slide\'s visual: an SVG file is copied by main; a picture goes through the slide media step', async () => {
    const [bench, flow] = scratchVisuals(slideItem.slide.markdown)
    const svgHost = fakeHost()
    await runScratchInsert(svgHost, { mode: 'visual', item: slideItem, visual: flow, place: helps, atCaret: false })
    assert.deepEqual(svgHost.log[0], ['importSlideVisual', 'sp-1', 'assets/flow.svg'])
    assert.ok(svgHost.text.includes('### Benchmarks\n\n![](assets/flow.svg)'))
    const picHost = fakeHost()
    await runScratchInsert(picHost, { mode: 'visual', item: slideItem, visual: bench, place: helps, atCaret: false })
    assert.deepEqual(picHost.log.slice(0, 2).map((e) => e.slice(0, 3)), [['slideSource', 'sp-1'], ['prepare', '/other-vault/talk/source-outline.md', '![](assets/bench.png)']])
    assert.ok(picHost.text.includes('### Benchmarks\n\n![](img-1111111)'))
  })

  await test('a failed step leaves the outline untouched, says why, and marks nothing', async () => {
    const cases = [
      ['import refused', fakeHost({ importVisual: { ok: false, error: 'The picture could not be copied into the vault’s pictures, so nothing was inserted.' } }), { mode: 'visual', item: fileItem, visual: null, place: helps, atCaret: false }, /could not be copied/],
      ['source unknown', fakeHost({ source: { ok: false, error: 'The talk “Other” this slide came from cannot be found, so nothing was inserted.' } }), { mode: 'slide', item: slideItem, place: helps }, /cannot be found/],
      ['media step refused', fakeHost({ prepare: () => null }), { mode: 'slide', item: slideItem, place: helps }, null],
      ['place gone', fakeHost(), { mode: 'slide', item: slideItem, place: { kind: 'after', line: 3, title: 'Not here' } }, /not in the talk any more/],
      ['no talk', fakeHost({ talk: () => null }), { mode: 'slide', item: slideItem, place: helps }, /Open a talk first/]
    ]
    for (const [name, host, request, said] of cases) {
      const out = await runScratchInsert(host, request)
      assert.equal(out.ok, false, name)
      assert.equal(host.text, TALK, `${name}: outline untouched`)
      assert.ok(!kinds(host).includes('mark'), `${name}: nothing marked`)
      assert.ok(!kinds(host).includes('caret'), `${name}: no caret insert`)
      if (said) assert.ok(host.log.some((e) => e[0] === 'notify' && said.test(e[2])), `${name}: says why ${JSON.stringify(host.log)}`)
    }
    // Another talk opened while the file was being copied: nothing goes into either talk.
    let calls = 0
    const switched = fakeHost({ talk: () => (++calls === 1 ? '/v/talk/talk-outline.md' : '/v/other/other-outline.md') })
    assert.equal((await runScratchInsert(switched, { mode: 'visual', item: fileItem, visual: null, place: helps, atCaret: false })).ok, false)
    assert.equal(switched.text, TALK)
    assert.ok(switched.log.some((e) => e[2] === INSERT_TEXT.talkChanged))
  })

  // ── Main's side ────────────────────────────────────────────────────────────────────────────────
  await test('the visual importer: picture → pool id, SVG → assets copy as a picture, page → assets copy as an Embed line', async () => {
    const seen = []
    const importer = createScratchVisualImporter({
      importPicture: async (path, outline, provenance) => { seen.push(['pic', path, outline, provenance.source]); return { id: 'img-abc1234' } },
      copyIntoAssets: async (path, outline, kind) => { seen.push([kind, path]); return { ok: true, embedPath: `assets/x.${kind}`, how: 'copied', localReferences: kind === 'html' ? ['style.css'] : [] } }
    })
    assert.deepEqual(await importer({ kind: 'pic', path: '/t/scratchpad/a.png', outlinePath: '/t/t-outline.md', from: 't/scratchpad/a.png' }), { ok: true, line: '![](img-abc1234)' })
    assert.deepEqual(await importer({ kind: 'svg', path: '/t/scratchpad/a.svg', outlinePath: '/t/t-outline.md', from: '' }), { ok: true, line: '![](assets/x.svg)' })
    assert.deepEqual(await importer({ kind: 'html', path: '/t/scratchpad/a.html', outlinePath: '/t/t-outline.md', from: '' }), { ok: true, line: '[Embed: assets/x.html]', page: { embedPath: 'assets/x.html', how: 'copied', localReferences: ['style.css'] } })
    assert.deepEqual(seen.map((s) => s[0]), ['pic', 'svg', 'html'])
    const refusing = createScratchVisualImporter({ importPicture: async () => null, copyIntoAssets: async () => ({ ok: false, reason: 'outside-vault', message: 'The talk’s assets folder leads outside its vault, so nothing was written.' }) })
    assert.match((await refusing({ kind: 'pic', path: '/a.png', outlinePath: '/o.md', from: '' })).error, /could not be copied into the vault’s pictures/)
    assert.match((await refusing({ kind: 'svg', path: '/a.svg', outlinePath: '/o.md', from: '' })).error, /SVG could not be copied.*leads outside its vault/)
  })

  await test('a picked slide\'s source talk and its files: found below a vault root, never outside it', () => {
    const v1 = join(root, 'vault-one'); const v2 = join(root, 'vault-two')
    mkdirSync(join(v2, 'talks', 'old'), { recursive: true }); mkdirSync(v1, { recursive: true })
    writeFileSync(join(v2, 'talks', 'old', 'old-outline.md'), '# Old\n')
    assert.equal(slideSourceOutline({ talkPath: 'talks/old/old-outline.md' }, [v1, v2]), join(v2, 'talks', 'old', 'old-outline.md'), 'the root that holds it wins')
    assert.equal(slideSourceOutline({ talkPath: 'talks/gone/gone-outline.md' }, [v1, v2]), join(v1, 'talks', 'gone', 'gone-outline.md'), 'a deleted talk still names a place (the snapshot inserts)')
    assert.equal(slideSourceOutline({ talkPath: '../../etc/passwd' }, [v1]), null)
    assert.equal(slideSourceOutline({ talkPath: '/abs/talk-outline.md' }, [v1]), '/abs/talk-outline.md')
    const outline = join(v2, 'talks', 'old', 'old-outline.md')
    assert.equal(slideVisualFile(outline, 'assets/flow%20chart.svg', v2), join(v2, 'talks', 'old', 'assets', 'flow chart.svg'))
    assert.equal(slideVisualFile(outline, '../../../../secret.svg', v2), null)
    assert.equal(slideVisualFile(outline, 'https://example.org/a.svg', v2), null)
    assert.equal(slideVisualFile(outline, 'file:///etc/hosts', v2), null)
  })

  await test('IPC: Insert visual only copies the store\'s own file, never writes it; a slide may only name its own visuals; no handler writes an outline', async () => {
    const vault = join(root, 'vault-ipc')
    const talkDir = join(vault, 'talk'); const scratch = join(talkDir, 'scratchpad')
    mkdirSync(scratch, { recursive: true })
    const outline = join(talkDir, 'talk-outline.md')
    writeFileSync(outline, TALK)
    writeFileSync(join(scratch, 'chart.png'), 'PNG')
    const srcTalk = join(vault, 'src'); mkdirSync(join(srcTalk, 'assets'), { recursive: true })
    writeFileSync(join(srcTalk, 'src-outline.md'), '# Src\n'); writeFileSync(join(srcTalk, 'assets', 'flow.svg'), '<svg/>')
    const handlers = new Map()
    const asked = []
    registerScratchpadIpc({
      ipc: { handle: (channel, fn) => handlers.set(channel, fn) },
      outlinePathFor: () => outline,
      htmlPreview: async () => ({ error: 'none' }),
      revealFolder: () => {},
      importVisual: async (req) => { asked.push(req); return { ok: true, line: req.kind === 'pic' ? '![](img-0000001)' : '![](assets/flow.svg)' } },
      slideSource: (slide) => ({ outlinePath: slideSourceOutline(slide, [vault]), root: vault })
    })
    const sender = { id: 1, isDestroyed: () => false, send: () => {}, once: () => {} }
    const call = (channel, ...args) => handlers.get(channel)({ sender }, ...args)
    const snap = (await call('scratchpad:load')).snapshot
    const file = snap.items.find((i) => i.file === 'chart.png')
    const before = statSync(join(scratch, 'chart.png'))
    assert.deepEqual(await call('scratchpad:import-visual', file.id), { ok: true, line: '![](img-0000001)' })
    assert.equal(asked[0].path, join(scratch, 'chart.png')); assert.equal(asked[0].kind, 'pic'); assert.equal(asked[0].outlinePath, outline)
    assert.equal(statSync(join(scratch, 'chart.png')).mtimeMs, before.mtimeMs); assert.equal(readFileSync(join(scratch, 'chart.png'), 'utf8'), 'PNG')
    await call('scratchpad:add-slides', [{ talkPath: 'src/src-outline.md', talkTitle: 'Src', slideId: 's1', title: 'Flow', markdown: '### Flow\n\n![](assets/flow.svg)\n', thumbKey: 'k' }])
    const slide = (await call('scratchpad:load')).snapshot.items.find((i) => i.kind === 'slide')
    assert.deepEqual(await call('scratchpad:slide-source', slide.id), { ok: true, outlinePath: join(srcTalk, 'src-outline.md') })
    assert.equal((await call('scratchpad:import-slide-visual', slide.id, 'assets/flow.svg')).ok, true)
    assert.equal(asked[1].path, join(srcTalk, 'assets', 'flow.svg')); assert.equal(asked[1].kind, 'svg')
    const refused = await call('scratchpad:import-slide-visual', slide.id, '../talk/scratchpad/chart.png')
    assert.equal(refused.ok, false, 'a file the snapshot does not name is refused'); assert.equal(asked.length, 2)
    assert.equal((await call('scratchpad:import-visual', 'sp-unknown')).ok, false)
    const marked = await call('scratchpad:mark-inserted', file.id, 'Where AI helps')
    assert.equal(marked.snapshot.items.find((i) => i.id === file.id).insertedInto, 'Where AI helps')
    assert.equal(readFileSync(outline, 'utf8'), TALK, 'no scratchpad handler wrote the outline')
    assert.deepEqual(readdirSync(scratch).sort(), ['chart.png', 'scratchpad-state.json'], 'nothing but the state file written in the scratch folder')
  })

  await test('a window that subscribes again and again gets one destroyed listener, and its end still unsubscribes', async () => {
    const talkDir = join(root, 'vault-sub', 'talk'); mkdirSync(talkDir, { recursive: true })
    const handlers = new Map()
    const ipc = registerScratchpadIpc({
      ipc: { handle: (channel, fn) => handlers.set(channel, fn) },
      outlinePathFor: () => join(talkDir, 'talk-outline.md'),
      htmlPreview: async () => ({ error: 'none' }), revealFolder: () => {}, debounceMs: 20
    })
    const listeners = []
    const sender = { id: 7, isDestroyed: () => false, send: () => {}, once: (name, fn) => { if (name === 'destroyed') listeners.push(fn) } }
    try {
      for (let i = 0; i < 5; i++) assert.equal((await handlers.get('scratchpad:subscribe')({ sender })).ok, true)
      assert.equal(listeners.length, 1, 'one listener, not one per subscribe')
      listeners[0]()
      assert.equal((await handlers.get('scratchpad:subscribe')({ sender })).ok, true)
      assert.equal(listeners.length, 2, 'a window id seen again after its end is hooked again')
    } finally { ipc.closeAll() }
  })

  await test('only the Insert path can write the outline: the scratchpad modules name no outline writer', () => {
    const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
    for (const p of ['src/main/scratchpad-store.ts', 'src/main/scratchpad-ipc.ts', 'src/main/scratchpad-visual-import.ts', 'src/main/scratchpad-watch.ts']) {
      assert.doesNotMatch(read(p), /writeTalkOutline|writeOutline|talk-writer|outline:write|applyFromMain/, p)
    }
    // In the renderer the panel only asks (the `insert` API); the writers are the workspace's, reached from runScratchInsert.
    for (const p of ['ScratchpadPanel.tsx', 'ScratchpadCard.tsx', 'ScratchpadCompare.tsx', 'ScratchpadInsert.tsx', 'ScratchpadPreview.tsx', 'ScratchpadGroupMenu.tsx']) {
      assert.doesNotMatch(read(`src/renderer/src/components/scratchpad/${p}`), /applyOutlineMutation|insertAtCaret|writeOutline|outlineMutator|editorReplace/, p)
    }
    const panel = read('src/renderer/src/components/scratchpad/ScratchpadInsert.tsx')
    assert.equal((panel.match(/api\.insert\(/g) ?? []).length, 3, 'Insert whole slide, Insert visual only, and a visual picked in the chooser')
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log(`${checks} checks passed`)
