// =============================================================================
// test:slot-composition — the media slot, generalised (ADR-0023 §3, pick B2)
//
// ONE composition for any slide that mixes copy with media: copy in one column, every media
// block stacked in the other, side from the media-placement option group, both columns centred,
// copy never below the ADR-0005 type floor.
//
// What this gate pins:
//   1. the wrapper grammar — div.slot[data-slot-side][data-slot-media-count]
//      > div.slot-copy + div.slot-media — is the ONLY beside-composition markup the compiler
//      emits (no .cv-body / .lv-body / .tv-body / .cards-media-split / .split survivors)
//   2. the side the media column takes, per {image=left|right} and by default
//   3. the media count, and that every media block is its own row (never an .img-row)
//   4. the copy column's type: no `cqw`-scaled copy anywhere in the assembled stylesheet's
//      .slot-copy rules (ADR-0005 type floor; `cqw` with no floor is what shrank copy-visual copy),
//      every copy font-size in the column taken from the single --copy-size token, and no
//      viewport-height cap in any .slot rule (the band bounds the media column, not a vh number)
//   5. copy-only slides render BYTE-IDENTICALLY to their pre-ticket output
//      (recorded in scripts/fixtures/slot-composition-baseline.json from the pre-change tree)
// =============================================================================

import { copyFileSync, mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { slotCompositionFor } from '../compiler/scripts/lib/slot-composition.mjs'
import { buildDeckStyles } from './build-deck-styles.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const baselinePath = join(repo, 'scripts/fixtures/slot-composition-baseline.json')
const dir = mkdtempSync(join(tmpdir(), 'tw-slot-'))
writeFileSync(join(dir, 'known-video.mp4'), Buffer.from('fixture video bytes'))
copyFileSync(join(repo, 'scripts/fixtures/layout/sample-image.png'), join(dir, 'known-video.png'))

let failures = 0
function assert(condition, label) {
  if (condition) console.log(`PASS: ${label}`)
  else { console.error(`FAIL: ${label}`); failures += 1 }
}

// -----------------------------------------------------------------------------
// Fixtures — every shape the five collapsed branches used to own, plus the shapes
// B2 newly has to answer for (2, 3 and 5 media blocks).
// -----------------------------------------------------------------------------

const FIXTURES = {
  'paragraph+1image': [
    '### Evidence',
    '',
    '![chart](chart.png)',
    '',
    'The measurement holds across every run we made this month.'
  ],
  'list+1image': [
    '### What is in the folder',
    '',
    '![repo root](folder.png "repo root")',
    '',
    '- AGENTS.md — house rules',
    '- ROADMAP.md — what is next'
  ],
  'paragraph+2media': [
    '### Two ways to see it',
    '',
    '[Video: clip.mp4]',
    '',
    '![still](still.png)',
    '',
    'The clip and the still show the same moment from two angles.'
  ],
  'list+3images': [
    '### Three screens',
    '',
    '![one](one.png)',
    '',
    '![two](two.png)',
    '',
    '![three](three.png)',
    '',
    '- first step',
    '- second step',
    '- third step'
  ],
  'table+1image': [
    '### Measured',
    '',
    '![sample](sample.png)',
    '',
    '| Measure | Result |',
    '| --- | --- |',
    '| Accuracy | 92% |'
  ],
  'paragraph+5images': [
    '### Five screens',
    '',
    '![one](one.png)',
    '',
    '![two](two.png)',
    '',
    '![three](three.png)',
    '',
    '![four](four.png)',
    '',
    '![five](five.png)',
    '',
    'All five screens belong to the same flow.'
  ],
  'cards+image': [
    '### Newsreel {cards=grid}',
    '',
    '[Video: newsreel.mp4]',
    '',
    '#### First card',
    '',
    'The first claim.',
    '',
    '#### Second card',
    '',
    'The second claim.'
  ],
  'timeline+comment': [
    '### How it went',
    '',
    '**Timeline:**',
    '',
    '- Research',
    '  - 1950: the question',
    '- Adoption',
    '  - 1997: the match',
    '',
    'Each of those dates looked like the end of the story at the time.'
  ],
  'image-left': [
    '### Beside on the left {image=left}',
    '',
    '![repo root](folder.png)',
    '',
    '- AGENTS.md — house rules',
    '- ROADMAP.md — what is next'
  ],
  'image-right': [
    '### Beside on the right {image=right}',
    '',
    '![repo root](folder.png)',
    '',
    '- AGENTS.md — house rules',
    '- ROADMAP.md — what is next'
  ],
  'media-only': [
    '### Just the picture',
    '',
    '![alone](alone.png)'
  ],
  'media-video+image': [
    '### Video and image',
    '',
    '[Video: https://example.com/demo.mp4]',
    '',
    `![landscape](${join(repo, 'scripts/fixtures/layout/slide_0010.webp')})`
  ],
  'media-poster-sized-video+image': [
    '### Poster sized video and image',
    '',
    '[Video: known-video.mp4]',
    '',
    `![landscape](${join(repo, 'scripts/fixtures/layout/slide_0010.webp')})`
  ],
  'media-image+video+image': [
    '### Image video image',
    '',
    `![landscape one](${join(repo, 'scripts/fixtures/layout/slide_0010.webp')})`,
    '',
    '[Video: https://example.com/demo.mp4]',
    '',
    `![landscape two](${join(repo, 'scripts/fixtures/layout/sample-image.png')})`
  ],
  'media-portrait+landscape': [
    '### Portrait and landscape',
    '',
    `![portrait](${join(repo, 'scripts/fixtures/layout/07-minister-portrait.png')})`,
    '',
    `![landscape](${join(repo, 'scripts/fixtures/layout/slide_0010.webp')})`
  ],
  'media-four-mixed': [
    '### Four mixed media',
    '',
    `![portrait](${join(repo, 'scripts/fixtures/layout/07-minister-portrait.png')})`,
    '',
    '[Video: https://example.com/demo.mp4]',
    '',
    '[Embed: https://example.com]',
    '',
    `![landscape](${join(repo, 'scripts/fixtures/layout/slide_0010.webp')})`
  ],
  'list+video+image': [
    '### List video and image',
    '',
    '- The media stays beside the copy.',
    '- Both media figures stack in one column.',
    '',
    '[Video: https://example.com/demo.mp4]',
    '',
    `![landscape](${join(repo, 'scripts/fixtures/layout/slide_0010.webp')})`
  ],
  'copy-only': [
    '### Just the words',
    '',
    '- first point',
    '- second point',
    '',
    'And a closing sentence that carries the thought.'
  ]
}

// Ticket 21: nested bullets beside a picture, and the image-claim pair.
FIXTURES['list-visual-nested'] = [
  '### Nested bullets beside a picture {list-visual}',
  '',
  '- Computer commands',
  '  - cd',
  '  - ls',
  '- CLI tools',
  '  - git',
  '',
  `![landscape](${join(repo, 'scripts/fixtures/layout/slide_0010.webp')})`
]
FIXTURES['image-claim'] = [
  '### Grep and Grok {image-claim}',
  '',
  `![landscape](${join(repo, 'scripts/fixtures/layout/slide_0010.webp')})`,
  '',
  '- Grep is retrieval — exact, literal, tireless',
  '- Grok is understanding — fuzzy, contextual, judgemental'
]

// Dominik's real slide (2026-09-11): a heading, two bullets, a video embed and a screenshot.
FIXTURES['real-quotes-slide'] = [
  '### Don\'t ask for quotes from training data',
  '',
  '- The model reconstructs the shape of a quotation, not the quotation.',
  '- Ask it to find the source instead, then read the source.',
  '',
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  '',
  '![screenshot of a fabricated citation](fabricated-citation.png)'
]

export function deckSourceFor(name) {
  return [
    '---',
    `title: Slot fixture ${name}`,
    '---',
    '',
    '# Slot fixture deck',
    '',
    '## Section',
    '',
    ...FIXTURES[name],
    ''
  ].join('\n')
}

async function compile(name) {
  const path = join(dir, `${name}.md`)
  const source = deckSourceFor(name)
  writeFileSync(path, source, 'utf8')
  const model = await prepareSource(path, source, `slot-${name}`, statSync(path))
  const slide = model.slides.find((entry) => entry.nodeLevel === 3) ?? model.slides.at(-1)
  return { model, slide, html: model.fullHtml }
}

// Every SLIDE <section> in the deck, as raw html (no DOM library needed for these shapes).
// `<section class="slide"` only: the document also carries the deck stylesheet and the runtime,
// which mention every wrapper class in prose, comments and selectors.
function sectionsOf(html) {
  return [...html.matchAll(/<section class="slide"[\s\S]*?<\/section>/g)].map((match) => match[0])
}

// The one slide whose markup carries this title.
function contentOf(html, title) {
  return sectionsOf(html).find((section) => section.includes(title)) ?? ''
}

const compiled = {}
for (const name of Object.keys(FIXTURES)) {
  compiled[name] = await compile(name)
  // Only the slide markup is under test — the deck stylesheet and runtime travel in the same file.
  compiled[name].body = sectionsOf(compiled[name].html).join('\n')
}

// -----------------------------------------------------------------------------
// 1. The wrapper grammar
// -----------------------------------------------------------------------------

const BESIDE = [
  'paragraph+1image', 'list+1image', 'paragraph+2media', 'list+3images', 'table+1image',
  'paragraph+5images', 'cards+image', 'timeline+comment', 'image-left', 'image-right',
  'real-quotes-slide'
]

for (const name of BESIDE) {
  const body = compiled[name].body
  assert(
    /<div class="slot" data-slot-side="(left|right)" data-slot-media-count="\d+"[^>]*><div class="slot-copy">[\s\S]*?<\/div><div class="slot-media">/.test(body),
    `${name}: one .slot wrapper, copy column first, media column second`
  )
}

// No old wrapper survives anywhere in the compiler's output.
const RETIRED = ['cv-body', 'lv-body', 'tv-body', 'cards-media-split', 'class="split ']
for (const name of Object.keys(FIXTURES)) {
  const survivors = RETIRED.filter((token) => compiled[name].body.includes(token))
  assert(survivors.length === 0, `${name}: no retired wrapper in the slide body (${survivors.join(', ') || 'none'})`)
}

// -----------------------------------------------------------------------------
// 2. Side
// -----------------------------------------------------------------------------

assert(compiled['image-left'].body.includes('data-slot-side="left"'), 'image=left → data-slot-side="left"')
assert(compiled['image-right'].body.includes('data-slot-side="right"'), 'image=right → data-slot-side="right"')
assert(
  /data-slot-side="left"/.test(compiled['list+1image'].body),
  'no authored side → the pre-ticket mediaSplit default (left)'
)

// -----------------------------------------------------------------------------
// 3. Media count, one row per media block
// -----------------------------------------------------------------------------

const EXPECTED_COUNT = {
  'paragraph+1image': 1,
  'list+1image': 1,
  'paragraph+2media': 2,
  'list+3images': 3,
  'table+1image': 1,
  'paragraph+5images': 5,
  'cards+image': 1,
  'timeline+comment': 1,
  'image-left': 1,
  'image-right': 1,
  'real-quotes-slide': 2
}
for (const [name, count] of Object.entries(EXPECTED_COUNT)) {
  assert(
    compiled[name].body.includes(`data-slot-media-count="${count}"`),
    `${name}: data-slot-media-count="${count}"`
  )
}

const fiveUp = contentOf(compiled['paragraph+5images'].body, 'Five screens')
assert(fiveUp.includes('data-slot-media-grid="2col"'), '5 media blocks: the media column switches to a 2-column grid')
assert(
  !contentOf(compiled['list+3images'].body, 'Three screens').includes('data-slot-media-grid'),
  '3 media blocks: stay stacked rows (no grid switch)'
)
const threeUp = contentOf(compiled['list+3images'].body, 'Three screens')
assert(!threeUp.includes('img-row') && !threeUp.includes('figure-row'), 'media blocks are never grouped into an image row inside the slot')

// Ticket 15: a MEDIA-ONLY run groups every media kind, while the B2 slot keeps the same blocks
// stacked. The row owns one aspect token per figure so CSS can give portrait and landscape media
// proportional widths without detaching captions from their figure.
const videoImage = contentOf(compiled['media-video+image'].body, 'Video and image')
assert(/class="figure-row count-2"/.test(videoImage), 'media-only video + image: one two-item .figure-row')
assert(!videoImage.includes('figure-row-gallery'), 'media-only video + image: two items stay in one row')
assert(
  /class="slide-figure slide-video"[^>]*data-media-aspect-source="assumed-16:9"[\s\S]*class="slide-figure fig"/.test(videoImage),
  'media-only video + image: authored order is preserved and unknown video aspect is flagged'
)

const imageVideoImage = contentOf(compiled['media-image+video+image'].body, 'Image video image')
assert(/class="figure-row count-3"/.test(imageVideoImage), 'media-only image + video + image: one three-item .figure-row')

const posterSizedVideo = contentOf(compiled['media-poster-sized-video+image'].body, 'Poster sized video and image')
assert(
  /class="slide-figure slide-video"[^>]*style="--media-aspect:1\.6000"[^>]*data-media-aspect-source="intrinsic"/.test(posterSizedVideo),
  'video with a sibling poster: poster dimensions provide the intrinsic row aspect'
)

const portraitLandscape = contentOf(compiled['media-portrait+landscape'].body, 'Portrait and landscape')
assert(/class="figure-row count-2"[^>]*style="--media-row-aspect:/.test(portraitLandscape), 'portrait + landscape: row carries the summed aspect')
assert(/style="--media-aspect:0\.64/.test(portraitLandscape), 'portrait + landscape: portrait keeps its intrinsic narrow aspect')
assert(/style="--media-aspect:1\.77/.test(portraitLandscape), 'portrait + landscape: landscape keeps its intrinsic wide aspect')

const fourMixed = contentOf(compiled['media-four-mixed'].body, 'Four mixed media')
assert(/class="figure-row figure-row-gallery count-4"/.test(fourMixed), 'four mixed media: one .figure-row-gallery')
assert((fourMixed.match(/<(?:figure)\b/g) || []).length === 4, 'four mixed media: all four figures stay in the gallery')

const listVideoImage = contentOf(compiled['list+video+image'].body, 'List video and image')
assert(listVideoImage.includes('data-slot-media-count="2"'), 'list + video + image: both media blocks feed the B2 media column')
assert(!listVideoImage.includes('figure-row'), 'list + video + image: B2 remains stacked, never a horizontal row')
assert(
  /<div class="slot-media"><figure class="slide-figure slide-video"[\s\S]*<figure class="slide-figure fig"/.test(listVideoImage),
  'list + video + image: video and image remain separate stacked figures in authored order'
)

// -----------------------------------------------------------------------------
// 4. No cqw-scaled copy (ADR-0005 type floor)
// -----------------------------------------------------------------------------

const stylesheet = buildDeckStyles()
const copyRules = [...stylesheet.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|\})\s*([^{}]+)\{([^{}]*)\}/gm)]
  .filter(([, selector]) => selector.includes('.slot-copy'))
assert(copyRules.length > 0, 'the assembled stylesheet carries .slot-copy rules')
const cqwOffenders = copyRules.filter(([, , body]) => /\bcqw\b/.test(body)).map(([, selector]) => selector.trim())
assert(cqwOffenders.length === 0, `no cqw-scaled copy in .slot-copy rules (${cqwOffenders.join(' | ') || 'none'})`)

// ONE size in the column (the 2026-09-12 fix round): a paragraph measured 43.2px beside 36.8px
// bullets in the same slot. Every copy size in the column now comes from the single --copy-size
// custom property (Ticket 4's .claim reads the same token), so a stray literal size or a second
// token cannot reintroduce the split.
assert(
  copyRules.some(([, , body]) => /--copy-size\s*:/.test(body)),
  '.slot-copy defines the --copy-size token'
)
const sizedCopyRules = copyRules.filter(([, , body]) => /(?:^|;)\s*font-size\s*:/.test(body))
assert(sizedCopyRules.length > 0, '.slot-copy rules do set a copy font-size')
const looseSizes = sizedCopyRules
  .filter(([, , body]) => !/font-size\s*:[^;]*var\(\s*--copy-size/.test(body))
  .map(([, selector]) => selector.trim())
assert(looseSizes.length === 0, `every font-size in a .slot-copy rule comes from --copy-size (${looseSizes.join(' | ') || 'none'})`)

// NO viewport-height cap anywhere in the slot: a fixed `max-height: 66vh` is unrelated to the
// content band, so it left dead space at some viewports and let the media stack run past the
// stage bottom at others (defect A). The band bounds the media column, and only the band.
const slotRules = [...stylesheet.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|\})\s*([^{}]+)\{([^{}]*)\}/gm)]
  .filter(([, selector]) => /\.slot\b|\.slot-copy\b|\.slot-media\b/.test(selector))
assert(slotRules.length > 0, 'the assembled stylesheet carries .slot rules')
const vhOffenders = slotRules
  .filter(([, , body]) => /\b\d+(?:\.\d+)?vh\b/.test(body))
  .map(([, selector]) => selector.trim())
assert(vhOffenders.length === 0, `no vh cap (66vh and friends) in any .slot rule (${vhOffenders.join(' | ') || 'none'})`)

// Ticket 21 — the slot's columns and the copy beside media. Media takes 38% (the mockup's `.iq`
// portrait column; was 42%), a plain list in the copy column renders as the list layout's
// hairline rows (never bare lines), a table beside media reads at the one copy size, and the
// image-claim pair takes the same 38% media column with its claims a step above the body.
const slotColumnRules = slotRules.filter(([, selector]) => /^\s*\.slot(\[data-slot-side="left"\])?\s*$/.test(selector))
assert(slotColumnRules.length === 2, 'the slot declares its column template for both sides')
assert(
  slotColumnRules.every(([, , body]) => /grid-template-columns\s*:[^;]*\b38%/.test(body)) && slotColumnRules.every(([, , body]) => !/42%/.test(body)),
  'the media column is 38% of the slot on either side (Ticket 21; the old 42% is gone)'
)
assert(
  copyRules.some(([, selector, body]) => selector.includes('.slot-copy > .feature-list') && /border-top\s*:\s*1px solid var\(--hairline\)/.test(body) && /padding\s*:\s*calc\(\.55em \* var\(--list-gap/.test(body)),
  'a plain list beside media renders as hairline rows on the --list-gap seam (the list layout\'s row treatment)'
)
assert(
  copyRules.filter(([, selector]) => selector.includes('.slide-table')).every(([, , body]) => !/--fs-dense/.test(body)),
  'no table beside media steps down to the dense token'
)
const evidenceRules = [...stylesheet.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|\})\s*([^{}]+)\{([^{}]*)\}/gm)]
  .filter(([, selector]) => selector.includes('.layout-image-claim'))
assert(
  evidenceRules.some(([, , body]) => /grid-template-columns\s*:\s*38% minmax\(0, 1fr\)/.test(body)),
  'image-claim gives the picture the slot\'s 38% media column'
)
assert(
  evidenceRules.some(([, , body]) => /font-size\s*:[^;]*calc\(var\(--fs-body\) \* 1\.15\)/.test(body)),
  'image-claim claims read at 1.15x the body token'
)

// -----------------------------------------------------------------------------
// 5. Copy-only and media-only are byte-identical to the pre-ticket output
// -----------------------------------------------------------------------------

const UNCHANGED = ['copy-only']
if (process.env.TW_SLOT_RECORD === '1') {
  const record = {}
  for (const name of UNCHANGED) {
    record[name] = contentOf(compiled[name].body, name === 'media-only' ? 'Just the picture' : 'Just the words')
  }
  writeFileSync(baselinePath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  console.log(`recorded pre-change baseline → ${baselinePath}`)
} else {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
  for (const name of UNCHANGED) {
    const current = contentOf(compiled[name].body, name === 'media-only' ? 'Just the picture' : 'Just the words')
    assert(current === baseline[name], `${name}: slide markup byte-identical to the pre-ticket compiler`)
  }
}

// -----------------------------------------------------------------------------
// 6. The decision function itself
// -----------------------------------------------------------------------------

const image = { type: 'image', src: 'a.png' }
const para = { type: 'paragraph', text: 'words' }
assert(
  slotCompositionFor({}, [image, para], 'copy-visual').kind === 'beside',
  'slotCompositionFor: copy-visual with media + copy → beside'
)
assert(
  slotCompositionFor({}, [image], 'media').kind === 'none',
  'slotCompositionFor: media-only → none'
)
assert(
  slotCompositionFor({}, [para], 'list').kind === 'none',
  'slotCompositionFor: copy-only → none'
)
assert(
  slotCompositionFor({}, [image, para], 'list').kind === 'none',
  'slotCompositionFor: a layout outside the alias set is untouched'
)
assert(
  slotCompositionFor({ frameImageExplicit: true }, [image, para], 'list').kind === 'beside',
  'slotCompositionFor: an authored {image=…} puts any layout in the slot'
)
assert(
  slotCompositionFor({}, [image, { type: 'qr', url: 'https://x' }], 'media').kind === 'none',
  'slotCompositionFor: a QR alone is chrome, not copy'
)
assert(
  slotCompositionFor({ html: '<p>x</p>' }, [image, para], 'copy-visual').kind === 'none',
  'slotCompositionFor: an HTML body is never recomposed'
)
assert(
  slotCompositionFor({ colsCount: 2 }, [image, para], 'media').kind === 'none',
  'slotCompositionFor: an authored {2col} keeps the columns grid'
)
assert(
  slotCompositionFor({ colsCount: 2, frameImageExplicit: true }, [image, para], 'media').kind === 'beside',
  'slotCompositionFor: an authored {image=…} still wins over {2col} (the pre-ticket precedence)'
)
const tlComp = slotCompositionFor({}, [{ type: 'timeline', entries: [] }, para], 'timeline-visual')
assert(
  tlComp.kind === 'beside' && tlComp.media.length === 1,
  'slotCompositionFor: on timeline-visual the timeline occupies the media slot'
)

// -----------------------------------------------------------------------------
// 7. Rendered geometry at both required presentation sizes
// -----------------------------------------------------------------------------

const geometryPath = join(dir, 'media-row-geometry.html')
const landscapeGeometryPath = join(dir, 'media-row-landscape-geometry.html')
writeFileSync(geometryPath, compiled['media-portrait+landscape'].html, 'utf8')
writeFileSync(landscapeGeometryPath, compiled['media-video+image'].html, 'utf8')
const browser = await chromium.launch({ headless: true })
try {
  for (const viewport of [{ width: 1600, height: 900 }, { width: 1280, height: 720 }]) {
    const page = await browser.newPage({ viewport })
    await page.goto(`file://${geometryPath}`, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    const geometry = await page.evaluate(() => {
      const slides = [...document.querySelectorAll('.stage > .slide')]
      const slide = slides.find((node) => node.dataset.navTitle === 'Portrait and landscape')
      slides.forEach((node) => node.classList.toggle('active', node === slide))
      const row = slide?.querySelector('.figure-row')
      const content = slide?.querySelector('.slide-content')
      const head = slide?.querySelector('.slide-head')
      if (!row || !content || !head) return null
      const rowRect = row.getBoundingClientRect()
      const contentRect = content.getBoundingClientRect()
      const headRect = head.getBoundingClientRect()
      const figures = [...row.querySelectorAll(':scope > figure')].map((figure) => {
        const rect = figure.getBoundingClientRect()
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
      })
      const style = getComputedStyle(row)
      const gap = Number.parseFloat(style.columnGap) || 0
      const bandArea = contentRect.width * Math.max(0, contentRect.bottom - headRect.bottom)
      const figureArea = figures.reduce((sum, rect) => sum + rect.width * rect.height, 0)
      return {
        row: { left: rowRect.left, top: rowRect.top, right: rowRect.right, bottom: rowRect.bottom, width: rowRect.width, height: rowRect.height },
        figures,
        gap,
        titleFontPx: Number.parseFloat(getComputedStyle(head.querySelector('h1')).fontSize),
        coverage: bandArea ? figureArea / bandArea : 0
      }
    })
    assert(geometry !== null, `${viewport.width}x${viewport.height}: portrait + landscape row is present`)
    if (geometry) {
      const occupiedWidth = geometry.figures.reduce((sum, figure) => sum + figure.width, 0)
        + geometry.gap * Math.max(0, geometry.figures.length - 1)
      assert(Math.abs(occupiedWidth - geometry.row.width) <= 2, `${viewport.width}x${viewport.height}: figure widths plus gaps fill the row`)
      assert(geometry.figures[0].width < geometry.figures[1].width, `${viewport.width}x${viewport.height}: portrait column is narrower than landscape column`)
      assert(Math.abs(Math.max(...geometry.figures.map((figure) => figure.height)) - geometry.row.height) <= 2, `${viewport.width}x${viewport.height}: the tallest figure fills the row height`)
      assert(
        geometry.figures.every((figure) => figure.left >= geometry.row.left - 1 && figure.right <= geometry.row.right + 1 && figure.top >= geometry.row.top - 1 && figure.bottom <= geometry.row.bottom + 1),
        `${viewport.width}x${viewport.height}: no figure is clipped by the row`
      )
      if (viewport.width === 1600) assert(geometry.coverage >= 0.65, '1600x900: media covers at least 65% of the content band')
      console.log(`GEOMETRY ${viewport.width}x${viewport.height}: title=${geometry.titleFontPx.toFixed(2)}px row=${geometry.row.width.toFixed(2)}x${geometry.row.height.toFixed(2)}px coverage=${(geometry.coverage * 100).toFixed(2)}% widths=${geometry.figures.map((figure) => figure.width.toFixed(2)).join('+')}`)
    }
    await page.close()

    const landscapePage = await browser.newPage({ viewport })
    await landscapePage.goto(`file://${landscapeGeometryPath}`, { waitUntil: 'load' })
    await landscapePage.evaluate(() => document.fonts?.ready)
    const landscapeGeometry = await landscapePage.evaluate(() => {
      document.body.classList.add('chrome-pinned')
      const slides = [...document.querySelectorAll('.stage > .slide')]
      const slide = slides.find((node) => node.dataset.navTitle === 'Video and image')
      slides.forEach((node) => node.classList.toggle('active', node === slide))
      const row = slide?.querySelector('.figure-row')
      const content = slide?.querySelector('.slide-content')
      const head = slide?.querySelector('.slide-head')
      const footer = document.querySelector('.footer')
      if (!row || !content || !head || !footer) return null
      const contentRect = content.getBoundingClientRect()
      const headRect = head.getBoundingClientRect()
      const rowRect = row.getBoundingClientRect()
      const footerRect = footer.getBoundingClientRect()
      const figureArea = [...row.querySelectorAll(':scope > figure')]
        .map((figure) => figure.getBoundingClientRect())
        .reduce((sum, rect) => sum + rect.width * rect.height, 0)
      const bandArea = contentRect.width * Math.max(0, contentRect.bottom - headRect.bottom)
      return {
        coverage: bandArea ? figureArea / bandArea : 0,
        rowHeight: rowRect.height,
        topAir: rowRect.top - headRect.bottom,
        bottomAir: footerRect.top - rowRect.bottom,
        rowBottom: rowRect.bottom,
        navTop: footerRect.top
      }
    })
    assert(landscapeGeometry !== null, `${viewport.width}x${viewport.height}: landscape video + image row is present`)
    if (landscapeGeometry) {
      assert(Math.abs(landscapeGeometry.topAir - landscapeGeometry.bottomAir) <= 4,
        `${viewport.width}x${viewport.height}: width-limited row balances top and bottom air`)
      assert(landscapeGeometry.rowBottom <= landscapeGeometry.navTop,
        `${viewport.width}x${viewport.height}: width-limited row clears the fixed navigation`)
      console.log(`LANDSCAPE ${viewport.width}x${viewport.height}: rowHeight=${landscapeGeometry.rowHeight.toFixed(2)}px coverage=${(landscapeGeometry.coverage * 100).toFixed(2)}% air=${landscapeGeometry.topAir.toFixed(2)}/${landscapeGeometry.bottomAir.toFixed(2)}px`)
    }
    await landscapePage.close()
  }
} finally {
  await browser.close()
}

// -----------------------------------------------------------------------------
// 8. Ticket 21 rendered geometry: nested bullets beside a picture, and claims beside a picture.
// -----------------------------------------------------------------------------
const nestedPath = join(dir, 'list-visual-nested.html')
const claimPath = join(dir, 'image-claim.html')
writeFileSync(nestedPath, compiled['list-visual-nested'].html, 'utf8')
writeFileSync(claimPath, compiled['image-claim'].html, 'utf8')
const t21Browser = await chromium.launch({ headless: true })
try {
  for (const viewport of [{ width: 1600, height: 900 }, { width: 1280, height: 720 }]) {
    const page = await t21Browser.newPage({ viewport })
    await page.goto(`file://${nestedPath}#${compiled['list-visual-nested'].slide.id}`, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))))
    const nested = await page.evaluate(() => {
      const slide = document.querySelector('.slide.active')
      const slot = slide?.querySelector('.slot')
      const footer = document.querySelector('.footer')
      if (!slot || !footer) return null
      const px = (el, prop) => parseFloat(getComputedStyle(el)[prop])
      const stageWidth = slide.parentElement.clientWidth
      return {
        stageWidth,
        mediaWidth: slot.querySelector('.slot-media').getBoundingClientRect().width,
        slotWidth: slot.getBoundingClientRect().width,
        items: [...slot.querySelectorAll('.slot-copy > .feature-list > li')].map((li) => ({ borderTop: px(li, 'borderTopWidth'), padTop: px(li, 'paddingTop'), font: px(li, 'fontSize') })),
        nested: [...slot.querySelectorAll('.fl-sublist > li')].map((li) => ({ marker: getComputedStyle(li, '::before').content, gap: px(li, 'columnGap'), font: px(li, 'fontSize') })),
        lastRowBottom: [...slot.querySelectorAll('.slot-copy > .feature-list > li')].at(-1).getBoundingClientRect().bottom,
        footerTop: footer.getBoundingClientRect().top
      }
    })
    assert(nested !== null, `${viewport.width}x${viewport.height}: nested bullets beside a picture render in the slot`)
    if (nested) {
      const floor = nested.stageWidth * 31 / 1600
      assert(Math.abs(nested.mediaWidth / nested.slotWidth - 0.38) < 0.02, `${viewport.width}x${viewport.height}: the media column is 38% of the slot (${(nested.mediaWidth / nested.slotWidth * 100).toFixed(1)}%)`)
      assert(nested.items.length === 2 && nested.items.every((item) => item.borderTop >= 1 && item.padTop >= item.font * 0.35), `${viewport.width}x${viewport.height}: slot list items are hairline rows with row padding, not bare lines`)
      assert(nested.nested.length === 3 && nested.nested.every((item) => item.marker !== 'none' && item.marker !== '""'), `${viewport.width}x${viewport.height}: nested slot items carry a marker (${nested.nested.map((item) => item.marker).join(' ')})`)
      assert(nested.nested.every((item) => item.gap >= item.font * 0.4), `${viewport.width}x${viewport.height}: nested marker gap is at least 0.4em`)
      assert([...nested.items, ...nested.nested].every((item) => item.font >= floor - 0.01), `${viewport.width}x${viewport.height}: slot copy never falls below the floor`)
      assert(nested.lastRowBottom <= nested.footerTop + 1, `${viewport.width}x${viewport.height}: the last hairline row clears the footer (${nested.lastRowBottom.toFixed(1)} <= ${nested.footerTop.toFixed(1)})`)
    }
    await page.goto(`file://${claimPath}#${compiled['image-claim'].slide.id}`, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))))
    const claims = await page.evaluate(() => {
      const slide = document.querySelector('.slide.active')
      const content = slide?.querySelector('.slide-content')
      const evidence = content?.querySelector('.evidence-layout')
      if (!evidence) return null
      const probe = document.createElement('span')
      probe.style.cssText = 'position:absolute;visibility:hidden;font-size:var(--fs-body)'
      content.append(probe)
      const body = parseFloat(getComputedStyle(probe).fontSize)
      probe.remove()
      return {
        body,
        figureWidth: evidence.querySelector('figure').getBoundingClientRect().width,
        evidenceWidth: evidence.getBoundingClientRect().width,
        claimFonts: [...evidence.querySelectorAll('.callouts li')].map((li) => parseFloat(getComputedStyle(li).fontSize))
      }
    })
    assert(claims !== null, `${viewport.width}x${viewport.height}: image-claim renders its picture and claims`)
    if (claims) {
      assert(claims.claimFonts.length === 2 && claims.claimFonts.every((px) => px >= claims.body * 1.15 - 0.1), `${viewport.width}x${viewport.height}: claims read at >= 1.15x body (${claims.claimFonts.map((px) => px.toFixed(1)).join('/')} vs body ${claims.body.toFixed(1)})`)
      assert(Math.abs(claims.figureWidth / claims.evidenceWidth - 0.38) < 0.02, `${viewport.width}x${viewport.height}: the image-claim picture takes the 38% media column`)
    }
    await page.close()
  }
} finally {
  await t21Browser.close()
}

console.log(failures ? `slot composition: ${failures} failure(s)` : 'slot composition: all checks passed')
process.exit(failures ? 1 : 0)
