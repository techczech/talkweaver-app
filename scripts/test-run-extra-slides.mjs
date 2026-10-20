// Extra slides of a Run (work-files ticket 25; journeys S9): kept on the Run record (`extraSlides`), never in the
// talk's outline.
//   1. the Run record: `extraSlides` round-trips; the normaliser drops junk entries and the rest of the Run still
//      reads; limits; what the Run page sends is checked, refused in words; taking the last one away gives back
//      the Run file's bytes; a delivery attached to the planned Run keeps them;
//   2. the compiler: a compile for a Run makes each extra slide from its title and text directly; text holding
//      `###`, `<!--`, `{run=x}`, a fence and `---` is one slide with those words escaped, never structure; the
//      talk's own compile (and a Run compile with no extra slides) is the talk's, byte for byte;
//   3. placement: after its chosen slide; at the end when that slide is not in the talk, not in the Run's
//      pathway or is a pre-work step; a second Run never sees the first Run's slides;
//   4. the Run page's handlers (sessions:extra-slides / save-extra-slide / remove-extra-slide) over a temp vault:
//      the renderer names the Run only, ids are made in main, "Place after" must be one of the Run's slides, and
//      the talk's outline file is byte for byte the same after add, edit and remove;
//   5. the Run page's Extras for this run section (jsdom): the Slide button opens Slide title, Slide text and
//      Place after; Done sends the slide (never a path); a slide whose chosen slide is not in the Run says it
//      goes at the end; Remove slide removes it; a talk in the older outline format says so and adds none;
//   6. review round 2: title and text are plain text everywhere (no tag, no attribute from a link title, `<img>` or
//      a bare address, in the deck, the phone title and the phone text); the phone text has the slide's words;
//      "after the opening" / "after the closing slide" place against the generated slides; a continuation id is a
//      place, and the extra slide follows the whole group in full and pathway Runs alike; "at the end" comes after
//      every placed extra slide; an outline in the older format is never compiled another way for a Run, and the
//      Run page refuses extra slides for it in words.
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-run-extra-slides.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildPerSlideProjections } from '../compiler/scripts/lib/10-projections.mjs'
import { RUN_EXTRA_SLIDE_LIMITS, checkExtraSlideInput, mintExtraSlideId, normaliseRunExtraSlides } from '../src/shared/run-extras.ts'
import { attachDeliveryToPlanned, normaliseRun, persistRunForTalk, readRunForTalk, runPathForTalk, updateRunExtraSlides } from '../src/main/runs.ts'
import { buildRunHandoutHtml, runCompileOption, runForHandoutOf, runHandoutSourceFrom } from '../src/main/handout-pages.ts'
import { registerRunPageIpc } from '../src/main/run-page.ts'
import { CLOSING_SLIDE_ID, OPENING_SLIDE_ID, withRunExtraIds } from '../compiler/scripts/lib/run-extras.mjs'
import { buildSlideScriptPayload } from '../compiler/scripts/lib/slide-script.mjs'
import { renderScriptBlocks, renderSlideNavTitle } from '../compiler/scripts/lib/slide-script-render.mjs'
import { EXTRA_SLIDES_NEED_NEW_FORMAT, EXTRA_SLIDES_NOT_SHOWN, LEGACY_OUTLINE_ADAPTER } from '../src/shared/run-extra-slides.ts'

const TALK = [
  '---', 'title: Agents', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '## Opening {id=open1}', '', '### Why now {id=why}', '', 'Because.', '',
  '## Before the session {prework}', '', '### Read this {id=read}', '', '- One idea', '',
  '## Risks and checks {id=risks}', '', '### Checks {id=checks}', '', 'More.', '',
].join('\n')
const record = (id, extra = {}) => ({
  id, talkSlug: 'agents', talkTitle: 'Agents', kind: 'delivery', status: 'planned', slideSet: { kind: 'full' },
  plannedDate: '2026-11-04', eventTitle: 'Medical Sciences', startedAt: '2026-11-04T00:00:00.000Z', endedAt: '', ...extra,
})
const newVault = (prefix) => {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const talkDir = join(root, '_PRESENTATIONS', 'agents')
  mkdirSync(talkDir, { recursive: true })
  const outlinePath = join(talkDir, 'agents-outline.md')
  writeFileSync(outlinePath, TALK)
  return { root, talkDir, outlinePath }
}

// ── 1. the Run record ──────────────────────────────────────────────────────────────────────────
{
  // The normaliser: junk dropped, the rest kept, limits held, nothing thrown.
  assert.equal(normaliseRunExtraSlides(undefined), null)
  assert.equal(normaliseRunExtraSlides('slides'), null)
  assert.equal(normaliseRunExtraSlides([]), null, 'none: no field')
  assert.equal(normaliseRunExtraSlides([null, 7, 'x', [], { id: 'a1' }, { id: '../x', title: 'T' }, { title: 'No id' }]), null)
  const read = normaliseRunExtraSlides([
    { id: 'a1', title: '  Your\n datasets ', text: 'Line one  \r\n\r\n\r\n\r\nLine two\u0007', after: 'why', extra: 'dropped' },
    { id: 'a1', title: 'A repeat of the same id' },
    { id: 'b2', title: 'No place', after: '../../etc', text: 12 },
    { id: 'c3', title: 'x'.repeat(500), text: 'y'.repeat(5000) },
  ])
  assert.deepEqual(read.slice(0, 2), [
    { id: 'a1', title: 'Your datasets', text: 'Line one\n\nLine two', after: 'why' },
    { id: 'b2', title: 'No place', text: '' },
  ], 'cleaned, whitelisted, a bad "after" left out, a repeated id dropped')
  assert.equal(Array.from(read[2].title).length, RUN_EXTRA_SLIDE_LIMITS.title)
  assert.equal(Array.from(read[2].text).length, RUN_EXTRA_SLIDE_LIMITS.text)
  const many = Array.from({ length: 15 }, (_, i) => ({ id: `s${i}`, title: `Slide ${i}` }))
  assert.equal(normaliseRunExtraSlides(many).length, RUN_EXTRA_SLIDE_LIMITS.slides)

  // A Run file with junk in the field still reads, the rest of it whole.
  const { root } = newVault('tw-run-extra-record-')
  persistRunForTalk(root, 'agents', 'med', record('med', { extras: { intro: 'Bring a laptop' } }))
  const path = runPathForTalk(root, 'agents', 'med')
  const original = readFileSync(path, 'utf8')
  writeFileSync(path, JSON.stringify({ ...JSON.parse(original), extraSlides: [{ id: 5 }, 'junk', { id: 'ok1', title: 'Kept', text: '<b>x</b>' }] }, null, 2))
  const junky = readRunForTalk(root, 'agents', 'med')
  assert.equal(junky.eventTitle, 'Medical Sciences')
  assert.deepEqual(junky.extras, { intro: 'Bring a laptop' })
  assert.deepEqual(junky.extraSlides, [{ id: 'ok1', title: 'Kept', text: '<b>x</b>' }])
  writeFileSync(path, JSON.stringify({ ...JSON.parse(original), extraSlides: { not: 'a list' } }, null, 2))
  assert.equal(readRunForTalk(root, 'agents', 'med').extraSlides, undefined, 'not a list: no field, the Run reads')
  assert.equal('extraSlides' in normaliseRun(JSON.parse(original)), false, 'a Run without them has no field')
  writeFileSync(path, original)

  // Written through runs.ts: kept, changed, and the last one taken away gives back the file's bytes.
  const added = updateRunExtraSlides(root, 'agents', 'med', (current) => [...current, { id: 'x1', title: 'One', text: 'Text', after: 'why' }])
  assert.deepEqual(added.extraSlides, [{ id: 'x1', title: 'One', text: 'Text', after: 'why' }])
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).extraSlides, added.extraSlides, 'on the Run file')
  assert.deepEqual(readRunForTalk(root, 'agents', 'med').extras, { intro: 'Bring a laptop' }, 'ticket 24 extras untouched')
  updateRunExtraSlides(root, 'agents', 'med', (current) => current.map((slide) => ({ ...slide, title: 'Changed' })))
  assert.equal(readRunForTalk(root, 'agents', 'med').extraSlides[0].title, 'Changed')
  assert.throws(() => updateRunExtraSlides(root, 'agents', 'med', () => { throw new Error('refused') }), /refused/)
  assert.equal(readRunForTalk(root, 'agents', 'med').extraSlides[0].title, 'Changed', 'a refusal writes nothing')
  updateRunExtraSlides(root, 'agents', 'med', () => [])
  assert.equal(readFileSync(path, 'utf8'), original, 'removing the last one restores the Run file byte for byte')
  assert.equal(updateRunExtraSlides(root, 'agents', 'nope', () => []), null, 'no such Run')

  // A delivery attached to the planned Run keeps them (as ticket 24's extras).
  const planned = normaliseRun(record('med', { extraSlides: [{ id: 'x1', title: 'One', text: '' }] }))
  const delivery = normaliseRun({ ...record('del'), status: 'delivered', id: 'del' })
  assert.deepEqual(attachDeliveryToPlanned(planned, delivery).extraSlides, [{ id: 'x1', title: 'One', text: '' }])

  // What the Run page sends, checked. The text may hold anything typed: it is never read as outline.
  assert.deepEqual(checkExtraSlideInput({ title: '  Your \n  datasets ', text: 'Line one  \r\n\r\n\r\n\r\nLine two', after: 'why' }),
    { ok: true, slide: { title: 'Your datasets', text: 'Line one\n\nLine two', after: 'why' } }, 'a title is one line')
  for (const text of ['### Not a heading', '<!-- x', '{run=x}', '```js', '---', ':::notes', '{layout=statement}']) {
    assert.equal(checkExtraSlideInput({ title: 'T', text }).ok, true, `accepted: ${text}`)
  }
  assert.equal(checkExtraSlideInput({ title: 'A {layout=x} title' }).ok, true, 'braces in a title are words')
  for (const [bad, words] of [
    [null, 'could not be read'], [{ title: '' }, 'Give the slide a title'], [{ title: 'x'.repeat(201) }, 'too long'],
    [{ title: 'T', text: 'y'.repeat(2001) }, 'too long'], [{ title: 'T', after: '../x' }, 'not in this talk'],
    [{ title: 7 }, 'could not be read'], [{ title: 'T', text: 3 }, 'could not be read'], [{ title: 'T', after: 3 }, 'could not be read'],
  ]) {
    const result = checkExtraSlideInput(bad)
    assert.equal(result.ok, false, JSON.stringify(bad))
    assert.ok(result.error.includes(words), `${JSON.stringify(bad)}: ${result.error}`)
  }
  let n = 0
  const rng = () => [0.123456789, 0.123456789, 0.987654321][n++ % 3]
  const first = mintExtraSlideId([], rng)
  assert.match(first, /^extra-[a-z0-9]{5}$/)
  assert.notEqual(mintExtraSlideId([first], rng), first, 'never an id the Run has')
}
console.log('ok  1 the Run record keeps extra slides: junk dropped, limits held, refusals in words, bytes back on removal')

// ── 2–3. the compiler ──────────────────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'tw-run-extra-compile-'))
const outline = join(dir, 'agents-outline.md')
writeFileSync(outline, TALK)
const compile = async (run) => prepareSource(outline, TALK, 'agents', statSync(outline), undefined, { allowedAssetRoots: [dir], ...(run ? { run } : {}) })
// As main builds the option (handout-pages.ts): from the Run record, against its pathway.
const pathways = [{ id: 'short', name: 'Short', slideIds: ['open1', 'checks'] }, { id: 'why', name: 'Why', slideIds: ['why', 'checks'] }]
const optionFor = (run) => runCompileOption(runForHandoutOf(normaliseRun(run), () => pathways))
{
  const plain = await compile()
  const rows = (model) => buildPerSlideProjections(model, 'agents')
  // A Run with no extra slides compiles as the talk (the same compile, no option at all).
  assert.equal(optionFor(record('none')), undefined)
  assert.equal(optionFor(record('none', { extraSlides: [] })), undefined)
  const noExtras = await compile({ id: 'run-a', slideIds: null, extraSlides: [] })
  assert.equal(noExtras.fullHtml, plain.fullHtml, 'a Run compile with no extra slides is the talk\'s deck')
  assert.equal(noExtras.runExtras, undefined)

  const runA = record('run-a', { extraSlides: [
    { id: 'extra-aaaaa', title: 'Your datasets', text: 'Which datasets in your group could safely go into an AI tool?', after: 'why' },
    { id: 'extra-bbbbb', title: 'Ethics approval', text: '', after: 'read' },
    { id: 'extra-ccccc', title: 'Wrap', text: '' },
    { id: 'extra-ddddd', title: 'After the section title', text: '', after: 'risks' },
    { id: 'extra-eeeee', title: 'Gone slide', text: '', after: 'nosuch' },
  ] })
  const runB = record('run-b', { extraSlides: [{ id: 'extra-kkkkk', title: 'Keble slide', text: '', after: 'open1' }] })

  // The talk compiles the same whatever Runs hold: nothing about them reaches a compile without the option.
  const talk = await compile()
  assert.deepEqual(talk.slides.map((s) => s.id), plain.slides.map((s) => s.id))
  assert.deepEqual(talk.beats, plain.beats)
  assert.deepEqual(rows(talk), rows(plain))
  assert.equal(talk.fullHtml, plain.fullHtml)

  const forA = await compile(optionFor(runA))
  assert.deepEqual(forA.slides.map((s) => s.id),
    ['open1', 'why', 'extra-aaaaa', 'before-the-session', 'read', 'risks', 'extra-ddddd', 'checks', 'extra-bbbbb', 'extra-ccccc', 'extra-eeeee'],
    'after its slide; after a section title it opens the section; after a pre-work step, with none, or a slide not in the talk: at the end')
  assert.deepEqual(forA.runExtras.slides.map((s) => s.placed), ['after', 'end', 'end', 'after', 'end'])
  assert.equal(forA.slides.find((s) => s.id === 'extra-aaaaa').section, 'open1', 'an extra slide belongs to the section it is placed in')
  assert.deepEqual(forA.prework.slideIds, plain.prework.slideIds, 'never a pre-work step')
  assert.ok(forA.fullHtml.includes('Which datasets in your group could safely go into'), 'its text on its slide')
  assert.equal(forA.fullHtml.includes('Keble slide'), false, 'no other Run\'s slide')
  assert.deepEqual(forA.warnings, plain.warnings, 'no findings from the Run\'s slides')
  assert.equal(rows(forA).length, rows(plain).length + 5)

  // A pathway: a chosen slide that is not in it puts the extra slide at the end of the pathway's slides.
  const onShort = await compile(optionFor({ ...runA, slideSet: { kind: 'pathway', pathwayId: 'short' } }))
  assert.deepEqual(onShort.runExtras.slides.map((s) => s.placed), ['end', 'end', 'end', 'end', 'end'])
  const onWhy = await compile(optionFor({ ...runA, slideSet: { kind: 'pathway', pathwayId: 'why' } }))
  assert.deepEqual(onWhy.runExtras.slides.map((s) => s.placed), ['after', 'end', 'end', 'end', 'end'])

  const forB = await compile(optionFor(runB))
  assert.deepEqual(forB.slides.map((s) => s.id).filter((id) => !plain.slides.some((s) => s.id === id)), ['extra-kkkkk'], 'run-b sees only its own slide')
  assert.equal(forB.fullHtml.includes('Your datasets'), false, 'a second Run never sees the first Run\'s slides')

  // An id the talk already uses is not taken twice.
  const clash = await compile({ id: 'run-c', slideIds: null, extraSlides: [{ id: 'why', title: 'Clash', text: '', after: 'checks' }] })
  assert.deepEqual(clash.slides.map((s) => s.id).filter((id) => id.startsWith('why')), ['why', 'why-2'])
  assert.equal(clash.runExtras.slides[0].id, 'why-2')
  // A Run id that is not well formed, or entries that are junk, compile the talk.
  assert.equal((await compile({ id: '../x', slideIds: null, extraSlides: runA.extraSlides })).fullHtml, plain.fullHtml)
  assert.equal((await compile({ id: 'run-j', slideIds: null, extraSlides: [{ id: 3 }, { id: 'ok', title: '' }, 'x'] })).fullHtml, plain.fullHtml)

  // Text that would be structure in an outline is the slide's words: one slide, escaped.
  const tricky = '### Not a heading\n<!-- not a comment\n{run=x}\n```js\n---\nAn <img src=x onerror=alert(1)> here'
  const odd = await compile({ id: 'run-t', slideIds: null, extraSlides: [{ id: 'extra-ttttt', title: 'Odd <i>title</i> {layout=quote}', text: tricky, after: 'why' }] })
  assert.deepEqual(odd.slides.map((s) => s.id), [...plain.slides.map((s) => s.id).slice(0, 2), 'extra-ttttt', ...plain.slides.map((s) => s.id).slice(2)], 'exactly one slide more')
  assert.deepEqual(odd.warnings, plain.warnings)
  assert.equal(odd.beats.length, plain.beats.length + 1)
  const html = odd.fullHtml
  const start = html.indexOf('<section class="slide" data-id="extra-ttttt"')
  const section = html.slice(start, html.indexOf('</section>', start))
  for (const words of ['###', '&lt;!--', '{run=x}', '```js', '---', '&lt;img src=x onerror=alert(1)&gt;', 'Odd &lt;i&gt;title&lt;/i&gt; {layout=quote}']) {
    assert.ok(section.includes(words), `escaped on the slide: ${words}`)
  }
  assert.equal(/<img|<i>|<!--/.test(section), false, 'nothing in the text is markup')
  assert.equal((section.match(/<p class="content-p">/g) || []).length, 6, 'each line its own paragraph')
  // Outside its slide, only its phone text (ruling 2) carries the words: as typed, in the slide-script payload.
  const withoutPhoneText = html.replace(section, '').replace(/<script type="application\/json" id="twSlideScript">[\s\S]*?<\/script>/, '')
  assert.equal(withoutPhoneText.includes('{run=x}'), false, 'nothing of it outside its slide and its phone text')
}
console.log('ok  2 the compiler makes each extra slide from its words; the talk compiles as before')
console.log('ok  3 a Run gets its own extra slides in place; at the end when the slide is not in its slides; a second Run sees none')

// ── 6. review round 2 ──────────────────────────────────────────────────────────────────────────
// The exact payload from the review: a link title holding an address, which renderInline would turn into an
// attribute. An extra slide is plain text: none of it becomes a tag or an attribute anywhere.
const INJECTION = '[click](https://safe "a https://x/onmouseover=alert(1)// z")'
const sliceSection = (html, id) => {
  const start = html.indexOf(`<section class="slide" data-id="${id}"`)
  assert.ok(start >= 0, `${id} is on the deck`)
  return html.slice(start, html.indexOf('</section>', start))
}
{
  const text = [INJECTION, 'An <img src=x onerror=alert(1)> here', 'see https://example.com/page now', '**not bold** and `not code`'].join('\n')
  const model = await compile({ id: 'run-x', slideIds: null, extraSlides: [{ id: 'extra-xxxxx', title: INJECTION, text, after: 'why' }] })
  const section = sliceSection(model.fullHtml, 'extra-xxxxx')
  // (The deck's no-lone-word pass joins the last two words with a no-break space; that is not markup.)
  const inner = section.slice(section.indexOf('>') + 1).replace(/&nbsp;/g, ' ')
  assert.equal(/<(a|img|strong|em|code)\b/i.test(inner), false, 'no tag made from the words: ' + inner)
  const tags = inner.match(/<[^>]+>/g) || []
  assert.equal(tags.some((tag) => /\s(title|href|onmouseover|onerror|src)=/i.test(tag)), false, 'no attribute made from the words: ' + tags.join(' '))
  const escapedInjection = '[click](https://safe &quot;a https://x/onmouseover=alert(1)// z&quot;)'
  assert.ok(inner.includes(`<h1>${escapedInjection}</h1>`) || inner.includes(escapedInjection), 'the title as typed, escaped')
  for (const words of [escapedInjection, 'An &lt;img src=x onerror=alert(1)&gt; here', 'see https://example.com/page now', '**not bold** and `not code`']) {
    assert.ok(inner.includes(`<p class="content-p">${words}</p>`), `a paragraph as typed: ${words}`)
  }
  assert.equal(model.fullHtml.includes('href="https://x/onmouseover'), false)
  assert.equal(model.fullHtml.includes('href="https://example.com/page"'), false, 'a bare address in the text is not made a link')
  // The phone title (data-nav-title, read by renderSlideNavTitle) is the title as text.
  assert.equal(renderSlideNavTitle(section), escapedInjection.replace(/&quot;/g, '&quot;'), 'the phone title is the title, escaped')
  assert.equal(/<a\b/.test(renderSlideNavTitle(section)), false)
  // The phone text: the slide's lines as typed, shown as text.
  const script = buildSlideScriptPayload(model.slides)['extra-xxxxx']
  assert.deepEqual(script, text.split('\n').map((line) => ({ type: 'p', text: line, plain: true })), 'the phone text payload is the slide\'s lines')
  const phone = renderScriptBlocks(script)
  assert.deepEqual(phone.map((block) => block.type), ['p', 'p', 'p', 'p'])
  assert.equal(phone.some((block) => /<(a|img|strong|code)\b/.test(block.html)), false, 'the phone text makes no tag either')
  assert.equal(phone[1].html, 'An &lt;img src=x onerror=alert(1)&gt; here')
  // The talk's own slides keep their phone text and inline rendering as before.
  const plain = await compile()
  const plainScript = buildSlideScriptPayload(plain.slides)
  const runScript = buildSlideScriptPayload(model.slides)
  for (const id of Object.keys(plainScript)) assert.deepEqual(runScript[id], plainScript[id], `${id}: phone text unchanged`)
}
console.log('ok  6a an extra slide is plain text in the deck, the phone title and the phone text; the phone text has its lines')

// ── 7. review round 3 ──────────────────────────────────────────────────────────────────────────
// Talk-wide `triggers:` defaults never reach an extra slide: whatever the talk sets, it is laid out the same way,
// and its title and text reach only the escaping sinks, in the deck, the Run's handout and the phone text.
const COMPILER_DIR = fileURLToPath(new URL('../compiler/scripts/', import.meta.url))
{
  const DEFAULTS = ['carousel', 'cards=stepped', 'cards=grid', 'cards=rows', 'cards', 'contrast', 'contrast=tint', 'plain', 'quote',
    'statement', 'statement=strong', '2col', 'cols=3', 'timeline=rail', 'barchart', 'curve=sigmoid', 'equation=x', 'blocks:2x2',
    'numbered', 'iconlist', 'iconlist=boxes', 'smartart', 'compare', 'title=sidebar', 'image=right', 'bigtitle', 'check', 'reveal', 'focus']
  const text = [INJECTION, 'An <img src=x onerror=alert(1)> here', '**not bold** and `not code` and *not em*'].join('\n')
  const extra = { id: 'extra-ddddd', title: INJECTION, text, after: 'why' }
  const noMarkup = (where, html) => {
    const inner = html.replace(/&nbsp;/g, ' ')
    assert.equal(/<(a|img|strong|em|code)\b/i.test(inner), false, `${where}: no tag made from the words`)
    assert.equal((inner.match(/<[^>]+>/g) || []).some((tag) => /\stitle=/i.test(tag)), false, `${where}: no title attribute`)
    assert.equal(inner.includes('href="https://x/onmouseover'), false, `${where}: no link from the link title`)
  }
  let layoutSeen = null
  for (const triggers of DEFAULTS) {
    const source = TALK.replace('title: Agents', `title: Agents\ntriggers: ${triggers}`)
    const path = join(dir, 'defaults-outline.md')
    writeFileSync(path, source)
    const model = await prepareSource(path, source, 'agents', statSync(path), undefined, { allowedAssetRoots: [dir], run: { id: 'run-d', slideIds: null, extraSlides: [extra] } })
    const section = sliceSection(model.fullHtml, 'extra-ddddd')
    const layout = (section.match(/^<section[^>]*\sdata-layout="([^"]*)"/) || [])[1]
    assert.ok(layout, `triggers: ${triggers}: the extra slide has a layout`)
    layoutSeen ??= layout
    assert.equal(layout, layoutSeen, `triggers: ${triggers}: the extra slide is laid out as with no defaults`)
    assert.equal(/carousel|data-exclusive|class="card\b/.test(section), false, `triggers: ${triggers}: no cards or carousel`)
    noMarkup(`deck (triggers: ${triggers})`, section.slice(section.indexOf('>') + 1))
    const escapedInjection = '[click](https://safe &quot;a https://x/onmouseover=alert(1)// z&quot;)'
    assert.ok(section.includes(escapedInjection), `triggers: ${triggers}: the words as typed, escaped`)
    // The Run's handout, from the same compile.
    const rows = buildPerSlideProjections(model, 'agents')
    const { source: handoutSource } = runHandoutSourceFrom(model, rows, { talkTitle: 'Agents', eventTitle: 'Med', plannedDate: '2026-11-04', startedAt: '2026-11-04T00:00:00.000Z', runId: 'run-d', extraSlides: [extra] }, 'agents', 'agents')
    const handout = await buildRunHandoutHtml(COMPILER_DIR, handoutSource, { slug: 'agents', workerBaseUrl: '' })
    const handoutSlide = handout.slides.find((slide) => slide.id === 'extra-ddddd')
    assert.ok(handoutSlide, `triggers: ${triggers}: the extra slide is in the handout`)
    noMarkup(`handout slide (triggers: ${triggers})`, handoutSlide.html.slice(handoutSlide.html.indexOf('>') + 1))
    assert.equal(handout.html.includes('href="https://x/onmouseover'), false, `triggers: ${triggers}: handout page`)
    // The phone text.
    const script = buildSlideScriptPayload(model.slides)['extra-ddddd']
    assert.deepEqual(script, text.split('\n').map((line) => ({ type: 'p', text: line, plain: true })), `triggers: ${triggers}: phone text as typed`)
    for (const block of renderScriptBlocks(script)) noMarkup(`phone text (triggers: ${triggers})`, block.html)
  }
  // With no defaults it is the same layout.
  const bare = await compile({ id: 'run-d', slideIds: null, extraSlides: [extra] })
  assert.equal((sliceSection(bare.fullHtml, 'extra-ddddd').match(/^<section[^>]*\sdata-layout="([^"]*)"/) || [])[1], layoutSeen)
}
console.log('ok  7a talk-wide trigger defaults never reach an extra slide: same layout, plain text in the deck, the handout and the phone text')

// The extra slides' places come from the deck's final order: an authored opening inside a section is put in front
// after the extra slides are placed, and a pathway Run's list agrees with the full Run.
{
  const OPENING = ['---', 'title: Opening inside', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
    '## Part one {id=part}', '', '### Hello {id=hello role=opening}', '', 'Welcome.', '', '### Mid {id=mid}', '', 'Middle words.', '',
    '## Part two {id=two}', '', '### Next {id=next}', '', 'More words.', ''].join('\n')
  const path = join(dir, 'opening-outline.md')
  writeFileSync(path, OPENING)
  const compileOpening = (run) => prepareSource(path, OPENING, 'opening', statSync(path), undefined, { allowedAssetRoots: [dir], ...(run ? { run } : {}) })
  const plain = await compileOpening()
  const plainIds = plain.slides.map((s) => s.id)
  assert.equal(plainIds[0], 'hello', 'the fixture: the authored opening is put in front of its section')
  assert.ok(plainIds.indexOf('part') > 0, 'the fixture: the section divider follows the opening')
  const run = { id: 'run-p', slideIds: null, extraSlides: [{ id: 'x-part', title: 'Extra part', text: '', after: 'part' }] }
  const full = await compileOpening(run)
  const fullIds = full.slides.map((s) => s.id)
  assert.deepEqual(full.runExtras.order, fullIds, 'the compile records its final slide order')
  assert.equal(fullIds.indexOf('x-part'), fullIds.indexOf('part') + 1, 'after the section\'s divider, after the opening is put in front')
  assert.deepEqual(fullIds.filter((id) => id !== 'x-part'), plainIds)
  assert.deepEqual(fullIds.slice(0, 4), ['hello', 'part', 'x-part', 'mid'], 'opening, divider, the extra slide, the section\'s next slide')
  const beatSlides = (model) => [...new Set(model.beats.map((beat) => beat.slideId))]
  assert.equal(full.beats.length, plain.beats.length + 1, 'one beat more, the extra slide\'s')
  assert.deepEqual(beatSlides(full), fullIds, 'the beats are in the deck\'s order')
  // A pathway Run of every slide in the deck's order: its list is the full Run's slides.
  const pathwayIds = plainIds
  const onPathway = await compileOpening({ ...run, slideIds: pathwayIds })
  assert.deepEqual(withRunExtraIds(pathwayIds, onPathway.runExtras), fullIds, 'the pathway list is the full Run\'s order')
  assert.deepEqual(withRunExtraIds(pathwayIds, onPathway.runExtras), onPathway.runExtras.order.filter((id) => pathwayIds.includes(id) || id === 'x-part'))
  // A pathway in its own running order keeps it; the extra slide follows its slide.
  const reordered = ['next', 'part', 'mid', 'hello']
  const onReordered = await compileOpening({ ...run, slideIds: reordered })
  assert.deepEqual(withRunExtraIds(reordered, onReordered.runExtras), ['next', 'part', 'x-part', 'mid', 'hello'])
  // Work-files ticket 25: an "at the end" extra stays last when the pathway is reordered, not after its slide 'hello'.
  const withEnd = { ...run, slideIds: reordered, extraSlides: [...run.extraSlides, { id: 'x-end', title: 'Last', text: '', after: '' }] }
  const onReorderedEnd = await compileOpening(withEnd)
  assert.equal(onReorderedEnd.runExtras.slides.find((extra) => extra.id === 'x-end')?.placed, 'end', 'the fixture: the extra has no place, so it is at the end')
  assert.deepEqual(withRunExtraIds(reordered, onReorderedEnd.runExtras), ['next', 'part', 'x-part', 'mid', 'hello', 'x-end'], 'the end extra follows the reordered pathway, not hello')
}
console.log('ok  7b extra slides take their places from the deck\'s final order: after a divider whose opening was put in front; the pathway list agrees')

// Bookends, continuation groups and the end, on a talk with its generated opening and closing slides and a
// quote long enough to be split over several slides (quote, quote--2, …).
const sentence = 'The quick brown fox considers the long arc of careful research and patient reading. '
const BOOKENDS = ['---', 'title: Bookends', '---', '', '## Part one {id=part}', '', '### First {id=first}', '', 'Words.', '',
  '### Quote {id=quote}', '', '> ' + sentence.repeat(12).trim(), '', '### Last {id=last}', '', 'End words.', ''].join('\n')
const bookendsPath = join(dir, 'bookends-outline.md')
writeFileSync(bookendsPath, BOOKENDS)
const compileBookends = (run) => prepareSource(bookendsPath, BOOKENDS, 'bookends', statSync(bookendsPath), undefined, { allowedAssetRoots: [dir], ...(run ? { run } : {}) })
const ex = (id, after = '') => ({ id, title: `Extra ${id}`, text: '', after })
{
  const plain = await compileBookends()
  const plainIds = plain.slides.map((s) => s.id)
  assert.equal(plainIds[0], OPENING_SLIDE_ID)
  assert.equal(plainIds.at(-1), CLOSING_SLIDE_ID)
  const quoteGroup = plainIds.filter((id) => id === 'quote' || id.startsWith('quote--'))
  assert.ok(quoteGroup.length >= 2 && quoteGroup[1] === 'quote--2', 'the fixture splits the quote')
  const beatIds = (model) => [...new Set(model.beats.map((beat) => beat.slideId))]

  // After the opening: right after the generated title slide; after the closing: the very end.
  const ends = await compileBookends({ id: 'run-b', slideIds: null, extraSlides: [ex('x-close', CLOSING_SLIDE_ID), ex('x-open', OPENING_SLIDE_ID), ex('x-open2', OPENING_SLIDE_ID)] })
  assert.deepEqual(ends.slides.map((s) => s.id), [OPENING_SLIDE_ID, 'x-open', 'x-open2', ...plainIds.slice(1), 'x-close'],
    'after the opening: right after the title slide, in entry order; after the closing slide: at the very end')
  assert.deepEqual(beatIds(ends), ends.slides.map((s) => s.id), 'the beats are in the same order')
  assert.deepEqual(ends.runExtras.slides.map((s) => s.placed), ['after', 'after', 'after'])
  assert.equal(ends.slides.find((s) => s.id === 'x-open').role, 'content', 'an extra slide is never the opening')
  assert.equal(ends.slides.find((s) => s.id === OPENING_SLIDE_ID).role, 'opening')
  assert.deepEqual(ends.warnings, plain.warnings)

  // A continuation id is a place; whichever part is chosen, the extra slide follows the whole group.
  const lastQuote = quoteGroup.at(-1)
  const cont = await compileBookends({ id: 'run-c', slideIds: null, extraSlides: [ex('x-q2', 'quote--2'), ex('x-q', 'quote'), ex('x-q-last', lastQuote)] })
  const contIds = cont.slides.map((s) => s.id)
  assert.deepEqual(contIds.slice(contIds.indexOf('quote'), contIds.indexOf('last')), [...quoteGroup, 'x-q2', 'x-q', 'x-q-last'],
    'after the whole quote group, in entry order, whichever part was chosen')
  assert.deepEqual(cont.runExtras.slides.map((s) => s.placed), ['after', 'after', 'after'], 'a continuation id is not "at the end"')
  assert.deepEqual(beatIds(cont), contIds)
  // The pathway list agrees with the tree: after the group's last part in the pathway.
  const pathwayIds = ['first', 'quote', 'quote--2', 'last']
  const contOnPathway = await compileBookends({ id: 'run-c', slideIds: pathwayIds, extraSlides: [ex('x-q2', 'quote--2'), ex('x-q', 'quote')] })
  assert.deepEqual(contOnPathway.runExtras.slides.map((s) => s.placed), ['after', 'after'])
  assert.deepEqual(withRunExtraIds(pathwayIds, contOnPathway.runExtras), ['first', 'quote', 'quote--2', 'x-q2', 'x-q', 'last'],
    'pathway: after the whole group too, never between its parts')
  assert.deepEqual(withRunExtraIds(['first', ...quoteGroup, 'last'], contOnPathway.runExtras), ['first', ...quoteGroup, 'x-q2', 'x-q', 'last'])

  // At the end comes after every placed extra slide, also one placed after the last slide; entry order kept.
  const order = await compileBookends({ id: 'run-e', slideIds: null, extraSlides: [ex('x-end1'), ex('x-last', 'last'), ex('x-end2'), ex('x-last2', 'last')] })
  assert.deepEqual(order.slides.map((s) => s.id).slice(plainIds.indexOf('last')), ['last', 'x-last', 'x-last2', 'x-end1', 'x-end2', CLOSING_SLIDE_ID],
    'full Run: after the last slide, then at the end, before the generated closing slide')
  const orderPathway = await compileBookends({ id: 'run-e', slideIds: ['first', 'last'], extraSlides: [ex('x-end1'), ex('x-last', 'last'), ex('x-end2'), ex('x-last2', 'last')] })
  assert.deepEqual(orderPathway.slides.map((s) => s.id).filter((id) => ['last', 'x-last', 'x-last2', 'x-end1', 'x-end2'].includes(id)), ['last', 'x-last', 'x-last2', 'x-end1', 'x-end2'])
  assert.deepEqual(withRunExtraIds(['first', 'last'], orderPathway.runExtras), ['first', 'last', 'x-last', 'x-last2', 'x-end1', 'x-end2'], 'pathway Run: the same order')
  // With an extra slide after the closing, the end ones come after that one.
  const tail = await compileBookends({ id: 'run-t', slideIds: null, extraSlides: [ex('x-end1'), ex('x-close', CLOSING_SLIDE_ID), ex('x-last', 'last')] })
  assert.deepEqual(tail.slides.map((s) => s.id).slice(plainIds.indexOf('last')), ['last', 'x-last', CLOSING_SLIDE_ID, 'x-close', 'x-end1'])
  assert.deepEqual(beatIds(tail), tail.slides.map((s) => s.id))
  const tailPathwayIds = ['first', 'last', CLOSING_SLIDE_ID]
  const tailPathway = await compileBookends({ id: 'run-t', slideIds: tailPathwayIds, extraSlides: [ex('x-end1'), ex('x-close', CLOSING_SLIDE_ID), ex('x-open', OPENING_SLIDE_ID), ex('x-last', 'last')] })
  assert.deepEqual(tailPathway.runExtras.slides.map((s) => s.placed), ['end', 'after', 'end', 'after'], 'a pathway without the title slide: "after the opening" goes at the end')
  assert.deepEqual(withRunExtraIds(tailPathwayIds, tailPathway.runExtras), ['first', 'last', 'x-last', CLOSING_SLIDE_ID, 'x-close', 'x-end1', 'x-open'])
  const tailOrder = tailPathway.slides.map((s) => s.id).filter((id) => withRunExtraIds(tailPathwayIds, tailPathway.runExtras).includes(id))
  assert.deepEqual(tailOrder, withRunExtraIds(tailPathwayIds, tailPathway.runExtras), 'the deck\'s order and the pathway list agree')
  // Without generated bookends (both off), "after the closing" is at the end and "after the opening" first.
  const OFF = BOOKENDS.replace('title: Bookends', 'title: Bookends\nauto_title_slide: false\nauto_thanks_slide: false')
  writeFileSync(bookendsPath, OFF)
  const off = await prepareSource(bookendsPath, OFF, 'bookends', statSync(bookendsPath), undefined, { allowedAssetRoots: [dir], run: { id: 'run-o', slideIds: null, extraSlides: [ex('x-close', CLOSING_SLIDE_ID), ex('x-open', OPENING_SLIDE_ID)] } })
  const offIds = off.slides.map((s) => s.id)
  assert.equal(offIds[0], 'x-open')
  assert.equal(offIds.at(-1), 'x-close')
  assert.deepEqual(off.runExtras.slides.map((s) => s.placed), ['end', 'after'])
  const offPlain = await prepareSource(bookendsPath, OFF, 'bookends', statSync(bookendsPath), undefined, { allowedAssetRoots: [dir] })
  assert.deepEqual(offPlain.slides.map((s) => [s.id, s.role]), off.slides.filter((s) => !s.id.startsWith('x-')).map((s) => [s.id, s.role]), 'the talk\'s slides keep their roles (its first slide stays the opening)')
  writeFileSync(bookendsPath, BOOKENDS)
}
console.log('ok  6b after the opening / closing slide, after any part of a split slide, and at the end, the same in full and pathway Runs')

// An outline in the older format: compiled on its own path for a Run too, without the Run's extra slides.
const LEGACY = ['# Agents', '', '## Opening', '', 'Section body text here.', '', '### Why now', '', 'Because.', ''].join('\n')
{
  const legacyPath = join(dir, 'legacy-outline.md')
  writeFileSync(legacyPath, LEGACY)
  const compileLegacy = (run) => prepareSource(legacyPath, LEGACY, 'legacy', statSync(legacyPath), undefined, { allowedAssetRoots: [dir], ...(run ? { run } : {}) })
  const plain = await compileLegacy()
  assert.equal(plain.adapter, LEGACY_OUTLINE_ADAPTER, 'the fixture is in the older format')
  const forRun = await compileLegacy({ id: 'run-l', slideIds: null, extraSlides: [ex('x-l', 'why-now')] })
  assert.equal(forRun.adapter, LEGACY_OUTLINE_ADAPTER, 'not compiled another way for a Run')
  assert.equal(forRun.fullHtml, plain.fullHtml, 'the talk\'s deck, byte for byte: no extra slide, no section body text, no bookends added')
  assert.equal(forRun.runExtras, undefined)
  assert.deepEqual(forRun.slides.map((s) => s.id), plain.slides.map((s) => s.id))
}
console.log('ok  6c an outline in the older format compiles as before for a Run, without its extra slides')

// ── 4. the Run page's handlers ─────────────────────────────────────────────────────────────────
{
  const { root, talkDir, outlinePath } = newVault('tw-run-extra-vault-')
  writeFileSync(join(talkDir, 'manifest.json'), JSON.stringify({ pathways: [{ id: 'short', name: 'Short', slideIds: ['why', 'checks'] }] }, null, 2) + '\n')
  persistRunForTalk(root, 'agents', 'med', record('med'))
  persistRunForTalk(root, 'agents', 'keble', record('keble', { eventTitle: 'Keble', slideSet: { kind: 'pathway', pathwayId: 'short' } }))
  const medPath = runPathForTalk(root, 'agents', 'med')
  const medOriginal = readFileSync(medPath, 'utf8')

  const handlers = new Map()
  registerRunPageIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    vaults: () => [{ id: 'v1', root }], openPath: async () => '', focusLive: () => false,
    readOutline: (vaultRoot, slug) => (vaultRoot === root && slug === 'agents' ? readFileSync(outlinePath, 'utf8') : null),
    talkSlides: async (vaultRoot, slug) => {
      if (vaultRoot !== root || slug !== 'agents') return null
      const text = readFileSync(outlinePath, 'utf8')
      const model = await prepareSource(outlinePath, text, 'agents', statSync(outlinePath), undefined, { allowedAssetRoots: [root] })
      return { slides: buildPerSlideProjections(model, 'agents').map((row) => ({ id: row.slide_id, title: row.title })), preworkIds: model.prework.slideIds }
    },
  })
  const call = (channel, payload) => handlers.get(channel)({}, payload)
  const med = { vaultId: 'v1', talkSlug: 'agents', runId: 'med' }
  const keble = { vaultId: 'v1', talkSlug: 'agents', runId: 'keble' }
  const outlineIs = (when) => assert.equal(readFileSync(outlinePath, 'utf8'), TALK, `the talk's outline file is unchanged ${when}`)

  const empty = await call('sessions:extra-slides', med)
  assert.equal(empty.ok, true, empty.error)
  assert.deepEqual(empty.extraSlides, [])
  assert.deepEqual(empty.slides.map((s) => s.id), ['open1', 'why', 'risks', 'checks'], 'the Run\'s slides, without pre-work steps')
  assert.deepEqual((await call('sessions:extra-slides', keble)).slides.map((s) => s.id), ['why', 'checks'], 'a pathway Run: its pathway\'s slides')

  // Added: the id is main's, not the renderer's; text that looks like outline is accepted as words.
  const added = await call('sessions:save-extra-slide', { ...med, slide: { title: 'Your datasets', text: '### Which datasets?\n{run=keble}', after: 'why' } })
  assert.equal(added.ok, true, added.error)
  assert.deepEqual(added.extraSlides.map(({ title, text, after, afterTitle, placed }) => ({ title, text, after, afterTitle, placed })),
    [{ title: 'Your datasets', text: '### Which datasets?\n{run=keble}', after: 'why', afterTitle: 'Why now', placed: 'after' }])
  const id = added.extraSlides[0].id
  assert.match(id, /^extra-[a-z0-9]{5}$/)
  assert.deepEqual(readRunForTalk(root, 'agents', 'med').extraSlides, [{ id, title: 'Your datasets', text: '### Which datasets?\n{run=keble}', after: 'why' }], 'kept on the Run record')
  outlineIs('after an add')

  // Refused: a slide that is not the Run's; an id the Run does not have (a new slide never takes one); a path.
  const refusals = [
    [{ ...keble, slide: { title: 'K', text: '', after: 'open1' } }, 'not in this run’s slides'],
    [{ ...med, slide: { id: 'extra-zzzzz', title: 'K', text: '', after: '' } }, 'no longer there'],
    [{ ...med, slide: { id: '../x', title: 'K', text: '', after: '' } }, 'no longer there'],
    [{ ...med, slide: { title: '', text: '', after: '' } }, 'Give the slide a title'],
    [{ ...med, talkSlug: '../agents', slide: { title: 'K', text: '', after: '' } }, 'Unknown Run'],
    [{ ...med, runId: 'other', slide: { title: 'K', text: '', after: '' } }, 'no longer there'],
    [{ ...med, vaultId: 'v9', slide: { title: 'K', text: '', after: '' } }, 'not open'],
  ]
  const medBefore = readFileSync(medPath, 'utf8')
  for (const [payload, words] of refusals) {
    const result = await call('sessions:save-extra-slide', payload)
    assert.equal(result.ok, false, JSON.stringify(payload))
    assert.ok(result.error.includes(words), result.error)
  }
  assert.equal(readFileSync(medPath, 'utf8'), medBefore, 'a refusal writes nothing')

  // The Keble Run (a pathway) never sees the Medical Run's slide.
  assert.deepEqual((await call('sessions:extra-slides', keble)).extraSlides, [])
  const kebleAdded = await call('sessions:save-extra-slide', { ...keble, slide: { title: 'Keble only', text: '', after: 'checks' } })
  assert.equal(kebleAdded.ok, true, kebleAdded.error)
  assert.equal((await call('sessions:extra-slides', med)).extraSlides.length, 1)
  assert.equal(readRunForTalk(root, 'agents', 'med').extraSlides.length, 1)

  // Changed: the same id; a renderer-sent id is used only to find it.
  const edited = await call('sessions:save-extra-slide', { ...med, slide: { id, title: 'Your own datasets', text: 'New text', after: 'risks' } })
  assert.equal(edited.ok, true, edited.error)
  assert.deepEqual(edited.extraSlides.map((s) => [s.id, s.title, s.text, s.after]), [[id, 'Your own datasets', 'New text', 'risks']])
  outlineIs('after an edit')
  // A slide placed after one that then left the Run's slides may stay there; it says it goes at the end.
  writeFileSync(join(talkDir, 'manifest.json'), JSON.stringify({ pathways: [{ id: 'short', name: 'Short', slideIds: ['why'] }] }, null, 2) + '\n')
  const kept = await call('sessions:save-extra-slide', { ...keble, slide: { id: kebleAdded.extraSlides[0].id, title: 'Keble only', text: 'x', after: 'checks' } })
  assert.equal(kept.ok, true, kept.error)
  assert.equal(kept.extraSlides[0].placed, 'end')

  // A limit on how many.
  for (let i = 1; i < RUN_EXTRA_SLIDE_LIMITS.slides; i += 1) assert.equal((await call('sessions:save-extra-slide', { ...med, slide: { title: `More ${i}`, text: '', after: '' } })).ok, true)
  const over = await call('sessions:save-extra-slide', { ...med, slide: { title: 'One too many', text: '', after: '' } })
  assert.equal(over.ok, false)
  assert.ok(over.error.includes('up to 10'), over.error)
  const ids = new Set(readRunForTalk(root, 'agents', 'med').extraSlides.map((slide) => slide.id))
  assert.equal(ids.size, RUN_EXTRA_SLIDE_LIMITS.slides, 'each new slide its own id')

  // Removed: all of them; the Run file is its bytes again and the outline never changed.
  for (const one of [...ids]) assert.equal((await call('sessions:remove-extra-slide', { ...med, id: one })).ok, true)
  assert.equal((await call('sessions:remove-extra-slide', { ...med, id })).ok, false, 'already gone')
  assert.equal((await call('sessions:remove-extra-slide', { ...med, id: 7 })).ok, false)
  assert.equal(readFileSync(medPath, 'utf8'), medOriginal, 'the Run file is byte for byte what it was')
  const last = await call('sessions:remove-extra-slide', { ...keble, id: kebleAdded.extraSlides[0].id })
  assert.equal(last.ok, true, last.error)
  assert.deepEqual(last.extraSlides, [])
  outlineIs('after removing')
}
// A talk whose outline is in the older format: the Run page refuses extra slides in words, says the ones the Run
// has are not shown, and still lets them be removed; the outline file is never written.
{
  const { root, outlinePath } = newVault('tw-run-extra-legacy-')
  writeFileSync(outlinePath, LEGACY)
  persistRunForTalk(root, 'agents', 'old', record('old', { extraSlides: [{ id: 'extra-old01', title: 'From before', text: '', after: 'why-now' }] }))
  persistRunForTalk(root, 'agents', 'none', record('none'))
  const handlers = new Map()
  registerRunPageIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    vaults: () => [{ id: 'v1', root }], openPath: async () => '', focusLive: () => false,
    readOutline: () => readFileSync(outlinePath, 'utf8'),
    // As main's talkSlides (index.ts): the compile's adapter says whether the outline is in the older format.
    talkSlides: async () => {
      const model = await prepareSource(outlinePath, readFileSync(outlinePath, 'utf8'), 'agents', statSync(outlinePath), undefined, { allowedAssetRoots: [root] })
      return { slides: buildPerSlideProjections(model, 'agents').map((row) => ({ id: row.slide_id, title: row.title })), preworkIds: [], ...(model.adapter === LEGACY_OUTLINE_ADAPTER ? { legacy: true } : {}) }
    },
  })
  const call = (channel, payload) => handlers.get(channel)({}, payload)
  const old = { vaultId: 'v1', talkSlug: 'agents', runId: 'old' }
  const none = { vaultId: 'v1', talkSlug: 'agents', runId: 'none' }
  const read = await call('sessions:extra-slides', old)
  assert.equal(read.ok, true, read.error)
  assert.equal(read.legacyOutline, true, 'the Run page is told the outline is in the older format')
  assert.equal(read.extraSlides.length, 1)
  const oldBefore = readFileSync(runPathForTalk(root, 'agents', 'old'), 'utf8')
  for (const payload of [{ ...none, slide: { title: 'New', text: '', after: '' } }, { ...old, slide: { id: 'extra-old01', title: 'Changed', text: '', after: '' } }]) {
    const refused = await call('sessions:save-extra-slide', payload)
    assert.deepEqual(refused, { ok: false, error: EXTRA_SLIDES_NEED_NEW_FORMAT }, 'refused in words')
  }
  assert.equal(readFileSync(runPathForTalk(root, 'agents', 'old'), 'utf8'), oldBefore, 'a refusal writes nothing')
  assert.equal(readRunForTalk(root, 'agents', 'none').extraSlides, undefined)
  const removed = await call('sessions:remove-extra-slide', { ...old, id: 'extra-old01' })
  assert.equal(removed.ok, true, removed.error)
  assert.deepEqual(removed.extraSlides, [])
  assert.equal(readFileSync(outlinePath, 'utf8'), LEGACY, 'the outline is never written (not upgraded either)')
}
console.log('ok  4 the Run page keeps extra slides on the Run; the talk\'s outline file never changes; an outline in the older format is refused in words')

// ── 5. the section on the Run page (jsdom) ─────────────────────────────────────────────────────
{
  const repo = fileURLToPath(new URL('..', import.meta.url))
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { pretendToBeVisual: true })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'KeyboardEvent', 'Node', 'Element']) {
    Object.defineProperty(globalThis, name, { value: name === 'window' ? dom.window : dom.window[name], configurable: true, writable: true })
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const bundle = await build({
    stdin: { contents: "export { RunExtrasSection } from './src/renderer/src/components/RunExtras.tsx'; export { createElement, act } from 'react'; export { createRoot } from 'react-dom/client'", resolveDir: repo, loader: 'tsx' },
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', logLevel: 'silent', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"development"' },
  })
  const uiDir = mkdtempSync(join(tmpdir(), 'tw-run-extra-ui-'))
  writeFileSync(join(uiDir, 'ui.cjs'), bundle.outputFiles[0].text)
  const R = createRequire(join(uiDir, 'x.cjs'))('./ui.cjs')
  const doc = dom.window.document
  const slides = [{ id: 'open1', title: 'Opening' }, { id: 'risks', title: 'Risks and checks' }]
  let state = { slides, extraSlides: [{ id: 'gone1', title: 'Kept from before', text: 'Old', after: 'why', afterTitle: 'Why now', placed: 'end' }] }
  const calls = []
  dom.window.tw = { sessions: {
    extraSlides: async (ref) => { calls.push(['read', ref]); return { ok: true, ...state } },
    saveExtraSlide: async (ref, slide) => {
      calls.push(['save', ref, slide])
      if (slide.title === 'Refuse me') return { ok: false, error: 'That slide is not in this run’s slides.' }
      state = { slides, extraSlides: [...state.extraSlides, { id: 'new01', title: slide.title, text: slide.text, after: slide.after, afterTitle: 'Risks and checks', placed: 'after' }] }
      return { ok: true, ...state }
    },
    removeExtraSlide: async (ref, id) => { calls.push(['remove', ref, id]); state = { slides, extraSlides: state.extraSlides.filter((one) => one.id !== id) }; return { ok: true, ...state } },
    setExtras: async () => ({ ok: true, extras: null }),
  } }
  const source = { vaultId: 'v1', talkSlug: 'agents', runId: 'med', talkTitle: 'Agents', status: 'planned', extras: { intro: 'Bring a laptop' } }
  const root = R.createRoot(doc.getElementById('host'))
  const settle = async () => { for (let i = 0; i < 3; i += 1) await R.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
  const click = async (selector) => { await R.act(async () => { doc.querySelector(selector).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) }); await settle() }
  const type = async (selector, value) => {
    const element = doc.querySelector(selector)
    const proto = element.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : element.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype
    await R.act(async () => {
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value)
      element.dispatchEvent(new dom.window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
    })
  }
  await R.act(async () => root.render(R.createElement(R.RunExtrasSection, { source, onSaved() {} })))
  await settle()
  assert.deepEqual(calls[0], ['read', { vaultId: 'v1', talkSlug: 'agents', runId: 'med' }], 'the Run is named, never a path')
  assert.equal(doc.querySelector('[data-run-extras-summary]').textContent, 'intro note · 1 extra slide')
  const row = doc.querySelector('[data-run-extra-slide="gone1"]')
  assert.equal(row.querySelector('b').textContent, 'Kept from before')
  assert.equal(row.querySelector('small').textContent, 'Extra slide · at the end: “Why now” is not in this run’s slides', 'a slide that cannot go where it was put says so')

  // Add: Slide → title, text, Place after (the Run's slides, and the end).
  await click('[data-run-extra-add="slide"]')
  assert.deepEqual([...doc.querySelectorAll('[data-run-extra-edit] label')].map((label) => label.textContent), ['Slide title', 'Slide text', 'Place after'])
  assert.deepEqual([...doc.querySelectorAll('[data-run-extra-after] option')].map((option) => option.textContent), ['Opening', 'Risks and checks', 'At the end'])
  assert.equal(doc.querySelector('[data-run-extra-remove]'), null, 'a new slide has no Remove')
  await type('#tw-extra-slide-title', 'Refuse me')
  await click('[data-run-extra-done]')
  assert.equal(doc.querySelector('[data-run-extra-error]').textContent, 'That slide is not in this run’s slides.', 'a refusal is shown in the edit box')
  await type('#tw-extra-slide-title', 'Your datasets')
  await type('#tw-extra-slide-text', 'Which <b>datasets</b>?')
  await type('[data-run-extra-after]', 'risks')
  await click('[data-run-extra-done]')
  assert.deepEqual(calls.at(-1), ['save', { vaultId: 'v1', talkSlug: 'agents', runId: 'med' }, { title: 'Your datasets', text: 'Which <b>datasets</b>?', after: 'risks' }], 'a new slide is sent without an id')
  assert.equal(doc.querySelector('[data-run-extra-edit]'), null, 'saved: the box closes')
  assert.equal(doc.querySelector('[data-run-extra-slide="new01"] small').textContent, 'Extra slide · after “Risks and checks”')
  assert.equal(doc.querySelector('[data-run-extras-summary]').textContent, 'intro note · 2 extra slides')

  // Edit the old one: its stray choice stays offered until changed; Remove slide removes it.
  await click('[data-run-extra-edit-slide="gone1"]')
  assert.equal(doc.querySelector('[data-run-extra-after]').value, 'why')
  assert.ok([...doc.querySelectorAll('[data-run-extra-after] option')].some((option) => option.textContent === 'Why now (not in this run’s slides)'))
  await click('[data-run-extra-remove]')
  assert.deepEqual(calls.at(-1), ['remove', { vaultId: 'v1', talkSlug: 'agents', runId: 'med' }, 'gone1'])
  assert.equal(doc.querySelector('[data-run-extra-slide="gone1"]'), null)
  assert.equal(doc.body.innerHTML.includes('<b>datasets</b>'), false, 'text is shown as text')
  await R.act(async () => root.unmount())

  // A talk in the older outline format: the Slide button is off and the page says why, in words.
  state = { slides, extraSlides: [], legacyOutline: true }
  const legacyRoot = R.createRoot(doc.getElementById('host'))
  await R.act(async () => legacyRoot.render(R.createElement(R.RunExtrasSection, { source: { ...source, runId: 'old' }, onSaved() {} })))
  await settle()
  assert.equal(doc.querySelector('[data-run-extra-add="slide"]').disabled, true, 'no extra slide can be added')
  assert.equal(doc.querySelector('[data-run-extra-slides-legacy]').textContent, EXTRA_SLIDES_NEED_NEW_FORMAT)
  await R.act(async () => legacyRoot.unmount())
  state = { slides, extraSlides: [{ id: 'old01', title: 'From before', text: '', after: 'open1', afterTitle: 'Opening', placed: 'after' }], legacyOutline: true }
  const legacyWithSlides = R.createRoot(doc.getElementById('host'))
  await R.act(async () => legacyWithSlides.render(R.createElement(R.RunExtrasSection, { source: { ...source, runId: 'old2' }, onSaved() {} })))
  await settle()
  assert.equal(doc.querySelector('[data-run-extra-slides-legacy]').textContent, EXTRA_SLIDES_NOT_SHOWN, 'the Run page says its extra slides are not shown')
  assert.ok(doc.querySelector('[data-run-extra-slide="old01"]'), 'they are still listed, so they can be removed')
  await R.act(async () => legacyWithSlides.unmount())
  dom.window.close()
}
console.log('ok  5 the Run page adds, edits and removes extra slides, and says where each one goes; a talk in the older format says so')
console.log('run extra slides: kept on the Run record (junk dropped, bytes back on removal); made into slides from their words; the talk compiles and its outline stays as before; a Run compiles with its own extra slides in place, passed')
// React's scheduler keeps MessagePorts open under jsdom: every check has run, so end here.
process.exit(0)
