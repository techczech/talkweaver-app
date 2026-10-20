// A Run's extra slide's title (work-files ticket 25, slide.runExtra) is plain text as typed under every title
// look (0.41, ADR-0039): never read as inline markdown, always escaped.
//   1. each deck title look (full, kicker, label, tab, tab-strip, intro-then-none): the extra slide's h1 holds the
//      literal escaped title (`&lt;b&gt;`), no <b>, no javascript: link;
//   2. tab-strip: the extra slide's own pill and the pill naming it on a neighbour are the literal escaped text,
//      not the markup-dropped text (sectionStrip carries `plain` beside `titles`);
//   3. intro-then-none: where the head is nav-only (sr-only h1) the title is still literal and escaped;
//   4. a neighbour's own authored title still reads its inline markdown (the plain branch is per slide).
// Compiles real decks (prepareSource -> buildDeckHtmlFromModel) with a Run carrying one extra slide.
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-run-extra-title-escape.mjs
import { strict as assert } from 'node:assert'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildDeckHtmlFromModel } from '../compiler/scripts/lib/07-assembly.mjs'
import { sectionStrip } from '../compiler/scripts/lib/title-look.mjs'

const RAW = '<b>x</b> [l](javascript:x)'
const ESCAPED = '&lt;b&gt;x&lt;/b&gt; [l](javascript:x)'
const dir = mkdtempSync(join(tmpdir(), 'tw-run-extra-title-'))
let n = 0

async function compile(lookLine, top = true) {
  const source = [
    '---', 'title: Agents', 'auto_title_slide: false', 'auto_thanks_slide: false', ...(lookLine ? [lookLine] : []), ...(top ? ['defaults:', '  title: top'] : []), '---', '',
    '## Opening {id=open1}', '', '### Why *now* {id=why}', '', '- One', '- Two', '',
    '### Then {id=then}', '', '- Three', '- Four', '',
  ].join('\n')
  const path = join(dir, `${++n}.md`)
  writeFileSync(path, source, 'utf8')
  const run = { id: 'run-t', slideIds: null, extraSlides: [{ id: 'extra1', title: RAW, text: 'Plain words.', after: 'why' }] }
  const model = await prepareSource(path, source, 'agents', statSync(path), undefined, { allowedAssetRoots: [dir], run })
  const html = await buildDeckHtmlFromModel(model)
  const doc = new JSDOM(html).window.document
  return { model, html, doc }
}

const sectionHtml = (doc, id) => {
  const el = doc.querySelector(`section.slide[data-id="${id}"]`)
  assert(el, `slide ${id} is in the deck`)
  return el
}

function assertLiteral(markup, where) {
  assert(markup.includes(ESCAPED), `${where}: the literal escaped title (got ${markup.slice(0, 300)})`)
  assert(!/<b>x<\/b>/.test(markup), `${where}: no <b> from the title`)
  assert(!/href="javascript:/i.test(markup), `${where}: no javascript: link`)
}

const LOOKS = [
  ['full', 'title_look: full'],
  ['kicker', 'title_look: kicker'],
  ['label', 'title_look: label'],
  ['tab (default)', ''],
  ['tab-strip', 'title_look: tab-strip'],
  ['intro-then-none', 'title_look: intro-then-none'],
  ['tab-strip, left rail (no top default)', 'title_look: tab-strip', false],
]

for (const [name, line, top = true] of LOOKS) {
  const { model, html, doc } = await compile(line, top)
  const extraSlide = model.slides.find((s) => s.runExtra === true)
  assert(extraSlide, `${name}: the Run's extra slide is compiled`)
  const el = sectionHtml(doc, extraSlide.id)
  const h1 = el.querySelector('.slide-head h1')
  assert(h1, `${name}: the extra slide has a head h1`)
  assertLiteral(h1.innerHTML, `${name}: extra slide h1`)
  assert.equal(h1.textContent.replace(/\s+/g, ' ').trim(), RAW, `${name}: the h1 reads as typed`)
  // The raw deck HTML (JSDOM re-serialises attribute values without escaping `<`, so outerHTML would lie).
  assertLiteral(html, `${name}: deck markup`)
  // The neighbour's own title still reads its inline markdown.
  const why = sectionHtml(doc, 'why')
  if (name !== 'intro-then-none') assert(/<em>now<\/em>/.test(why.querySelector('.slide-head h1')?.innerHTML ?? ''), `${name}: an authored title keeps its markdown`)

  if (top && name !== 'intro-then-none') {
    const want = name.startsWith('tab (') ? 'tab' : name === 'full' ? null : name
    assert.equal(el.getAttribute('data-title-look'), want, `${name}: the extra slide paints the look`)
  }

  if (name === 'tab-strip') assert(el.querySelector('.title-strip'), 'tab-strip: the extra slide on the top regime has its own strip')
  if (name.startsWith('tab-strip')) {
    // The extra slide's own strip and the neighbours' strips name it literally.
    assert.equal(extraSlide.titleLook, 'tab-strip', 'the extra slide takes the deck look')
    // A strip is painted on the top regime only; the left-rail deck has none and checks the h1 path alone.
    const stripHosts = ['why', 'then', extraSlide.id].filter((id) => sectionHtml(doc, id).querySelector('.title-strip'))
    if (top) assert.equal(stripHosts.length, 3, 'tab-strip on the top regime: every slide of the section has a strip')
    for (const id of stripHosts) {
      const pills = [...sectionHtml(doc, id).querySelectorAll('.title-strip-pill')]
      const pill = pills.find((p) => p.textContent.includes('javascript:x'))
      assert(pill, `tab-strip: slide ${id} has a pill naming the extra slide`)
      assertLiteral(pill.innerHTML, `tab-strip: pill on ${id}`)
      assert.equal(pill.textContent, RAW, `tab-strip: pill on ${id} reads as typed`)
      const whyPill = pills.find((p) => p.textContent.includes('Why'))
      assert.equal(whyPill?.textContent, 'Why now', `tab-strip: an authored pill on ${id} still drops its markup`)
    }
  }
  if (name === 'intro-then-none') {
    assert.equal(extraSlide.titleLookHidden, true, 'intro-then-none: the extra slide follows the section card')
    assert(el.querySelector('.slide-head-quiet h1.sr-only'), 'intro-then-none: the extra slide head is nav-only')
  }
}

// sectionStrip carries a per-pill plain flag aligned with titles, cut window included.
{
  const slides = [
    { section: 'A', role: 'section-title', title: 'A' },
    ...Array.from({ length: 8 }, (_, i) => ({ section: 'A', title: `S${i}`, ...(i === 5 ? { runExtra: true } : {}) })),
  ]
  const strip = sectionStrip(slides, 6)
  assert.equal(strip.plain.length, strip.titles.length)
  strip.titles.forEach((t, i) => assert.equal(strip.plain[i], t === 'S5', `plain flag for ${t}`))
  assert(!('plain' in sectionStrip(slides, 1, 3)), 'a strip with no extra slide in its window has no plain field')
}

console.log('test-run-extra-title-escape: ok')
