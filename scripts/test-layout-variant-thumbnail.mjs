// ADR-0032 §6: the variant thumbnail path (ticket 02). The compile is the REAL compiler (prepareSource
// + projections); only the Electron offscreen capture is replaced by a stand-in that writes one file
// per (deck, slide) cache key, so the tests can see what would be rendered and how often.
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createVariantThumbnailHandler, createVariantThumbnailRenderer, mediaFingerprint
} from '../src/main/layout-variant-thumbnail.ts'
import { outlineRefusal } from '../src/main/vault-paths.ts'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildPerSlideProjections } from '../compiler/scripts/lib/10-projections.mjs'

const outline = `---
title: Variants
auto_title_slide: false
auto_thanks_slide: false
---

# Variants

## Codex

### Five things you can do with Codex
{icons}{id=vi9k8}

- Catalogue and organise data
- Manage projects and keep notes
- Create tools, websites, and dissemination outputs
- Run experiments and keep records and notes
- Set up and control your computer

### Another slide
{id=other}

- One
- Two
`
const vault = realpathSync(mkdtempSync(join(tmpdir(), 'tw-variant-thumb-')))
const talkDir = join(vault, 'variants')
mkdirSync(talkDir, { recursive: true })
const outlinePath = join(talkDir, 'variants-outline.md')
writeFileSync(outlinePath, outline)
const cacheDir = join(vault, '.cache')
const documentId = (html) => createHash('sha256').update(html).digest('hex').slice(0, 16)
const realPrepare = async (path, content) => {
  const model = await prepareSource(path, content, 'variants', statSync(path))
  return { slug: 'variants', model, rows: buildPerSlideProjections(model, 'variants') }
}

const counts = { prepare: 0, render: 0 }
const rendersOf = []
const htmlSeen = new Set()
const backgroundFlags = []
const renderer = createVariantThumbnailRenderer({
  prepareTalk: async (path, content) => { counts.prepare += 1; return realPrepare(path, content) },
  render: async ({ fullHtml, slides, cacheDir: dir, background }) => {
    counts.render += 1
    backgroundFlags.push(background)
    htmlSeen.add(documentId(fullHtml))
    mkdirSync(dir, { recursive: true })
    const out = {}
    for (const slide of slides) {
      const png = join(dir, `${slide.cacheKey}.png`)
      if (!existsSync(png)) writeFileSync(png, `${slide.key}:${fullHtml.length}`)
      out[slide.key] = png
      rendersOf.push(slide.key)
    }
    return out
  },
  cacheDirFor: (_path, slug) => join(cacheDir, slug),
  urlFor: (slug, name) => `twthumb://${slug}/${name}`,
  documentId
})
const ask = (layout, options) => renderer({ outlinePath, outline, slideId: 'vi9k8', layout, options })

// Different layouts give different pictures.
const cards = await ask('cards')
const numbered = await ask('numbered')
const timeline = await ask('timeline')
assert.deepEqual([cards.status, numbered.status, timeline.status], ['ok', 'ok', 'ok'], 'each layout renders')
assert.equal(cards.slideId, 'vi9k8')
assert(cards.url.startsWith('twthumb://variants/'))
assert.equal(new Set([cards.url, numbered.url, timeline.url]).size, 3, 'the thumbnail differs by layout')
assert.deepEqual([cards.cached, numbered.cached, timeline.cached], [false, false, false])
assert.equal(counts.render, 3)
assert(backgroundFlags.every((flag) => flag === true), 'variant renders wait behind the normal thumbnail lanes')

// An option changes the picture too.
const grid = await ask('cards', [{ group: 'font-body', token: 'font-body=xl' }])
assert(grid.status === 'ok' && grid.url !== cards.url, 'the thumbnail differs by option')

// The same try again is served from the cache: no compile, no render.
const before = { ...counts }
const again = await ask('cards')
assert.equal(again.cached, true)
assert.equal(again.url, cards.url)
assert.deepEqual(counts, before, 'a repeat costs neither a compile nor a render')

// A repeat after a restart (fresh renderer, same disk) reuses the picture the renderer already wrote:
// the stand-in render sees the file and does not rewrite it, and the URL is the same.
const beforeRestart = rendersOf.length
const fresh = createVariantThumbnailRenderer({
  prepareTalk: realPrepare,
  render: async ({ slides, cacheDir: dir }) => Object.fromEntries(slides.map((s) => [s.key, join(dir, `${s.cacheKey}.png`)])),
  cacheDirFor: (_path, slug) => join(cacheDir, slug),
  urlFor: (slug, name) => `twthumb://${slug}/${name}`,
  documentId
})
const restarted = await fresh({ outlinePath, outline, slideId: 'vi9k8', layout: 'cards' })
assert.equal(restarted.url, cards.url, 'the picture is content-addressed: same try, same URL')
assert.equal(rendersOf.length, beforeRestart)

// Concurrent identical asks share one render.
const beforeConcurrent = counts.render
const [a, b] = await Promise.all([ask('steps'), ask('steps')])
assert.equal(a.url, b.url)
assert.equal(counts.render, beforeConcurrent + 1)

// 8. "Cannot take" is told apart from "render failed" and from a bad request.
const cannot = await ask('grid-zoom')
assert.equal(cannot.status, 'cannot-take')
assert.equal(cannot.reason, 'Needs a ## section heading')
assert.equal((await renderer({ outlinePath, outline, slideId: 'missing', layout: 'cards' })).status, 'invalid')
assert.equal((await ask('no-such-layout')).status, 'invalid')
assert.equal((await ask('cards', [{ group: 'reactions', token: 'reactions=a\n## Injected' }])).status, 'invalid', 'a token that would write a new line is refused')
assert.equal((await ask('timeline', [{ group: 'form', token: 'cards=grid' }])).status, 'invalid', 'an option of another layout is refused')
const broken = createVariantThumbnailRenderer({
  prepareTalk: async () => null,
  render: async () => ({}),
  cacheDirFor: () => cacheDir,
  urlFor: () => '',
  documentId
})
assert.deepEqual(await broken({ outlinePath, outline, slideId: 'vi9k8', layout: 'cards' }), { status: 'failed', slideId: 'vi9k8' })
const throwing = createVariantThumbnailRenderer({
  prepareTalk: async () => { throw new Error('compile blew up') },
  render: async () => ({}),
  cacheDirFor: () => cacheDir,
  urlFor: () => '',
  documentId
})
assert.equal((await throwing({ outlinePath, outline, slideId: 'vi9k8', layout: 'cards' })).status, 'failed')

// The outline on disk was never touched by any of this.
assert.equal(readFileSync(outlinePath, 'utf8'), outline)
console.log('ok: variants render, differ by layout and option, cache, and say why when they do not')

// 6. A bounded, droppable queue: jobs run one at a time; a newer request from the same surface for
//    the same slide drops queued jobs made from older text, and keeps only the newest few.
{
  const gates = []
  let started = 0
  const slow = createVariantThumbnailRenderer({
    prepareTalk: async (path, content) => { started += 1; await new Promise((resolve) => gates.push(resolve)); return realPrepare(path, content) },
    render: async ({ slides, cacheDir: dir }) => Object.fromEntries(slides.map((s) => [s.key, join(dir, `q-${s.cacheKey}.png`)])),
    cacheDirFor: (_path, slug) => join(cacheDir, slug),
    urlFor: (slug, name) => `twthumb://${slug}/${name}`,
    documentId,
    fileExists: () => true
  }, { maxPending: 8, maxPendingPerKey: 4 })
  const layouts = ['cards', 'iconrow', 'numbered', 'grid', 'process', 'timeline', 'steps', 'list', '2col', 'table',
    'mindmap', 'orgchart', 'cycle', 'pyramid', 'funnel', 'stats', 'statement', 'quote', 'boxes', 'agenda']
  // Arrowing through 20 layouts: one job running, four queued, the rest refused.
  const arrowed = layouts.map((layout) => slow({ outlinePath, outline, slideId: 'vi9k8', layout, requestKey: 'picker' }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(started, 1, 'one variant job at a time')
  assert(slow.stats().pending <= 4, `at most four queued for one surface and slide (${slow.stats().pending})`)
  // Typing: a request from newer text supersedes every queued job from the older text.
  const edited = outline.replace('Set up and control your computer', 'Set up and control a computer')
  const newest = slow({ outlinePath, outline: edited, slideId: 'vi9k8', layout: 'cards', requestKey: 'picker' })
  assert.equal(slow.stats().pending, 1, 'only the request from the newest text is queued')
  // Another surface's requests are not dropped by the picker's.
  const inspector = slow({ outlinePath, outline, slideId: 'vi9k8', layout: 'cards', options: [{ group: 'font-body', token: 'font-body=xl' }], requestKey: 'inspector:font-body' })
  assert.equal(slow.stats().pending, 2)
  let draining = true
  const drainGates = async () => { while (draining) { if (gates.length) gates.shift()(); await new Promise((resolve) => setTimeout(resolve, 5)) } }
  const drain = drainGates()
  const results = await Promise.all(arrowed)
  const superseded = results.filter((result) => result.status === 'superseded').length
  assert.equal(results[0].status, 'ok', 'the running job finishes')
  assert(results.slice(1).every((result) => result.status !== 'ok'), 'no job from the old text rendered after the first')
  assert(superseded >= 10, `the arrowed-through requests the slide can take were dropped (${superseded})`)
  assert.equal((await newest).status, 'ok')
  assert.equal((await inspector).status, 'ok')
  assert.equal(started, 3, 'three compiles in all, not twenty-two')

  // The global cap refuses the NEWEST request across surfaces; the jobs already waiting keep their turn.
  const capped = createVariantThumbnailRenderer({
    prepareTalk: async (path, content) => { await new Promise((resolve) => gates.push(resolve)); return realPrepare(path, content) },
    render: async ({ slides, cacheDir: dir }) => Object.fromEntries(slides.map((s) => [s.key, join(dir, `c-${s.cacheKey}.png`)])),
    cacheDirFor: (_path, slug) => join(cacheDir, slug),
    urlFor: (slug, name) => `twthumb://${slug}/${name}`,
    documentId,
    fileExists: () => true
  }, { maxPending: 3, maxPendingPerKey: 6 })
  const many = ['cards', 'iconrow', 'numbered', 'grid', 'process', 'timeline'].map((layout, index) =>
    capped({ outlinePath, outline, slideId: 'vi9k8', layout, requestKey: `k${index}` }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(capped.stats().pending, 3)
  const cappedResults = await Promise.all(many)
  draining = false
  await drain
  assert.deepEqual(cappedResults.map((result) => result.status), ['ok', 'ok', 'ok', 'ok', 'superseded', 'superseded'],
    'over the cap the newest requests are refused, never the job about to run')
  console.log('ok: the variant queue is serial, bounded, and drops superseded work')
}

// Fix round 4 (E): the author moves to another slide. Its first request drops the queued jobs of the
// slide she left (any surface of that talk), so her new slide's first picture waits behind at most the
// one job already running, never behind the old slide's queue.
{
  const gates = []
  const moving = createVariantThumbnailRenderer({
    prepareTalk: async (path, content) => { await new Promise((resolve) => gates.push(resolve)); return realPrepare(path, content) },
    render: async ({ slides, cacheDir: dir }) => Object.fromEntries(slides.map((s) => [s.key, join(dir, `m-${s.cacheKey}.png`)])),
    cacheDirFor: (_path, slug) => join(cacheDir, slug),
    urlFor: (slug, name) => `twthumb://${slug}/${name}`,
    documentId,
    fileExists: () => true
  })
  const left = ['cards', 'numbered', 'process'].map((layout) => moving({ outlinePath, outline, slideId: 'vi9k8', layout, requestKey: 'picker' }))
  const leftOption = moving({ outlinePath, outline, slideId: 'vi9k8', layout: 'cards', options: [{ group: 'font-body', token: 'font-body=xl' }], requestKey: 'inspector:font-body' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(moving.stats().pending, 3, 'slide A: one job running, three queued')
  const arrived = moving({ outlinePath, outline, slideId: 'other', layout: 'cards', requestKey: 'picker' })
  assert.equal(moving.stats().pending, 1, 'the new slide\'s request is the only one queued')
  const drain = (async () => { for (let i = 0; i < 200 && gates.length + moving.stats().pending + moving.stats().running; i += 1) { if (gates.length) gates.shift()(); await new Promise((resolve) => setTimeout(resolve, 5)) } })()
  const [first, ...queuedLeft] = await Promise.all(left)
  assert.equal(first.status, 'ok', 'the job already running finishes')
  assert.deepEqual(queuedLeft.map((result) => result.status), ['superseded', 'superseded'], 'the left slide\'s queued jobs are dropped')
  assert.equal((await leftOption).status, 'superseded', 'the Inspector\'s queued job for the left slide goes too')
  assert.equal((await arrived).status, 'ok', 'the new slide\'s picture is drawn next')
  await drain
  console.log('ok: moving to another slide drops the left slide\'s queued variant jobs')
}

// 7. The cache follows the media the outline references: a replaced image is drawn again.
{
  writeFileSync(join(talkDir, 'photo.png'), 'first')
  const withImage = outline.replace('### Another slide\n{id=other}\n\n- One\n- Two\n', '### Another slide\n{id=other}\n\n![Photo](photo.png)\n')
  writeFileSync(outlinePath, withImage)
  let renders = 0
  const media = createVariantThumbnailRenderer({
    prepareTalk: realPrepare,
    render: async ({ slides, cacheDir: dir }) => { renders += 1; return Object.fromEntries(slides.map((s) => [s.key, join(dir, `m-${s.cacheKey}.png`)])) },
    cacheDirFor: (_path, slug) => join(cacheDir, slug),
    urlFor: (slug, name) => `twthumb://${slug}/${name}`,
    documentId,
    fileExists: () => true
  })
  const askMedia = () => media({ outlinePath, outline: withImage, slideId: 'other', layout: 'media' })
  const first = await askMedia()
  assert.equal(first.status, 'ok', JSON.stringify(first))
  assert.equal((await askMedia()).cached, true)
  const printBefore = mediaFingerprint(outlinePath, withImage)
  writeFileSync(join(talkDir, 'photo.png'), 'replaced, and longer')
  utimesSync(join(talkDir, 'photo.png'), new Date(), new Date(Date.now() + 5000))
  assert.notEqual(mediaFingerprint(outlinePath, withImage), printBefore, 'the fingerprint follows the file')
  const redrawn = await askMedia()
  assert.equal(redrawn.cached, false, 'a replaced image is not answered from memory')
  assert.equal(renders, 2)
  // URLs and anchors are not files; a missing file is part of the print (it may appear later).
  assert.equal(mediaFingerprint(outlinePath, '![a](https://x.test/a.png) [b](#top)'), mediaFingerprint(outlinePath, ''))
  assert.notEqual(mediaFingerprint(outlinePath, '![a](nope.png)'), mediaFingerprint(outlinePath, ''))
  writeFileSync(outlinePath, outline)
  console.log('ok: the in-memory cache follows referenced media')
}

// 11. The real `layout:variant-thumbnail` handler, with the real outline gate: the render stand-in
//     receives a different compiled deck per layout, and repeats are answered from the cache.
{
  const received = []
  let prepares = 0
  const variantRenderer = createVariantThumbnailRenderer({
    prepareTalk: async (path, content) => { prepares += 1; return realPrepare(path, content) },
    render: async ({ fullHtml, slides, cacheDir: dir }) => {
      received.push({ html: documentId(fullHtml), slide: fullHtml.match(new RegExp(`data-id="vi9k8"[^>]*`))?.[0] ?? '' })
      mkdirSync(dir, { recursive: true })
      return Object.fromEntries(slides.map((s) => { const png = join(dir, `h-${s.cacheKey}.png`); writeFileSync(png, fullHtml.slice(0, 64)); return [s.key, png] }))
    },
    cacheDirFor: (_path, slug) => join(cacheDir, 'ipc', slug),
    urlFor: (slug, name) => `twthumb://${slug}/${name}`,
    documentId
  })
  const handler = createVariantThumbnailHandler((path) => outlineRefusal(vault, path), variantRenderer, () => {})
  const event = { sender: { id: 1 } }
  const viaIpc = (layout, options, requestKey = 'picker') => handler(event, outlinePath, outline, 'vi9k8', layout, options, requestKey)
  const ipcCards = await viaIpc('cards')
  const ipcTimeline = await viaIpc('timeline')
  const ipcNumbered = await viaIpc('numbered')
  assert.deepEqual([ipcCards.status, ipcTimeline.status, ipcNumbered.status], ['ok', 'ok', 'ok'])
  assert.equal(received.length, 3)
  assert.equal(new Set(received.map((r) => r.html)).size, 3, 'the render received a different compiled deck per layout')
  assert.equal(new Set([ipcCards.url, ipcTimeline.url, ipcNumbered.url]).size, 3)
  const repeat = await viaIpc('cards')
  assert.equal(repeat.cached, true, 'a repeat over IPC is answered from the cache')
  assert.equal(repeat.url, ipcCards.url)
  assert.equal(received.length, 3, 'no render for the repeat')
  assert.equal(prepares, 3, 'no compile for the repeat')
  // The gate: an outline outside the vault, or not an outline, is refused before any compile.
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'tw-variant-outside-')))
  const outsidePath = join(outside, 'x-outline.md')
  writeFileSync(outsidePath, outline)
  const refused = await handler(event, outsidePath, outline, 'vi9k8', 'cards')
  assert.equal(refused.status, 'invalid')
  assert.equal((await handler(event, join(talkDir, 'notes.md'), outline, 'vi9k8', 'cards')).status, 'invalid')
  assert.equal((await handler(event, outlinePath, 42, 'vi9k8', 'cards')).status, 'invalid')
  assert.equal((await handler(event, outlinePath, outline, 'vi9k8', 'cards', [{ group: 'reactions', token: 'reactions=a\n## X' }])).status, 'invalid')
  assert.equal((await handler(event, outlinePath, outline, 'vi9k8', 'cards', 'not-a-list')).status, 'invalid')
  assert.equal((await handler(event, outlinePath, outline, 'vi9k8', 'grid-zoom')).status, 'cannot-take')
  assert.equal(prepares, 3, 'nothing refused reached the compiler')
  console.log('ok: the IPC handler gates, varies by layout and caches')
}

// 5. Where a variant compiles. The behaviour (uncached, on the preparation gate's background lane, the
//    live deck's compile first) is tested on the real cache and gate in test-prepared-talk-cache.mjs
//    ("preparation route"). index.ts is Electron-bound and cannot be imported here, so what is left is
//    that main asks for that route and registers the handler tested above: two call sites, nothing more.
{
  const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const wiring = main.slice(main.indexOf('const renderVariantThumbnail = createVariantThumbnailRenderer('), main.indexOf("ipcMain.handle('layout:variant-thumbnail'"))
  assert(wiring.includes("'variant')"), 'the variant renderer compiles on the variant route')
  assert(main.includes('return routePreparation(lane, key, group, load)'), 'prepareTalk goes through the tested route')
  assert(main.includes("ipcMain.handle('layout:variant-thumbnail', createVariantThumbnailHandler(outlineRefused, renderVariantThumbnail))"),
    'main registers the handler tested above')
  console.log('ok: variant compiles stay out of the live prepared-talk cache')
}

// 8. The probe (second review): the picker and two Inspector groups ask for 18 different pictures at
//    once, through the shared client policy, against the real variant queue with a simulated renderer.
//    18 jobs must cost about 18 requests and exactly 18 renders, not a storm of re-asks.
{
  const { createVariantPictureQueue, createVariantPictureSlots } = await import('../src/shared/variant-picture-queue.ts')
  const { canTakeLayout, previewLayout } = await import('../src/shared/layout-verbs.ts')
  const { LAYOUTS } = await import('../src/shared/layout-registry/entries.ts')
  // Eighteen different pictures: layouts the slide can take whose variant texts all differ (an alias
  // such as table-outline writes what table writes, and would share its job).
  const texts = new Set()
  const layouts = LAYOUTS.filter((entry) => entry.kind === 'layout' && canTakeLayout(outline, 'vi9k8', entry.name).ok)
    .map((entry) => entry.name)
    .filter((name) => { const text = previewLayout(outline, 'vi9k8', name); if (texts.has(text)) return false; texts.add(text); return true })
  assert(layouts.length >= 18, `enough layouts for the probe (${layouts.length})`)
  let renders = 0
  let requests = 0
  const probe = createVariantThumbnailRenderer({
    prepareTalk: async (path, content) => { await new Promise((resolve) => setTimeout(resolve, 2)); return realPrepare(path, content) },
    render: async ({ slides, cacheDir: dir }) => {
      renders += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return Object.fromEntries(slides.map((s) => [s.key, join(dir, `probe-${renders}-${s.cacheKey}.png`)]))
    },
    cacheDirFor: (_path, slug) => join(cacheDir, slug),
    urlFor: (slug, name) => `twthumb://${slug}/${name}`,
    documentId,
    fileExists: () => true
  })
  const slots = createVariantPictureSlots()
  const request = { outlinePath, outline, slideId: 'vi9k8' }
  const surfaces = ['picker', 'inspector:form', 'inspector:font-body'].map((requestKey, index) => {
    const settled = new Map()
    const queue = createVariantPictureQueue((layout, req) => { requests += 1; return probe({ ...req, layout, requestKey }) },
      (layout, mark) => settled.set(layout, mark), { slots })
    queue.reset('probe', request)
    return { queue, settled, wanted: layouts.slice(index * 6, index * 6 + 6) }
  })
  for (const surface of surfaces) surface.queue.want(surface.wanted)
  assert(slots.inUse() <= 3, 'the window never has more than its budget out')
  const deadline = Date.now() + 60_000
  while (surfaces.some((surface) => surface.settled.size < 6) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  const marks = surfaces.flatMap((surface) => [...surface.settled.values()])
  assert.equal(marks.length, 18)
  assert(marks.every((mark) => typeof mark === 'string'), 'every picture drawn')
  assert.equal(renders, 18, 'one render per picture')
  assert(requests <= 20, `about one request per picture (${requests}), not a storm of re-asks`)
  console.log(`ok: the probe: 18 pictures cost ${requests} requests and ${renders} renders`)
}

// A slide with no {id=} yet (every new slide until it is saved) is drawn by its heading line.
{
  const bare = outline.replace('{icons}{id=vi9k8}', '{icons}').replace('{id=other}', '')
  const bareLine = bare.split('\n').findIndex((line) => line.startsWith('### Five things')) + 1
  const bareAsk = (layout, line = bareLine) => renderer({ outlinePath, outline: bare, slideId: `line:${line}`, headingLine: line, layout })
  const drawn = await bareAsk('cards')
  assert.equal(drawn.status, 'ok', 'an unstamped slide is drawn by its heading line')
  const other = await bareAsk('numbered')
  assert.equal(other.status, 'ok')
  assert.notEqual(drawn.url, other.url, 'and each layout gives its own picture')
  assert.equal((await bareAsk('cards')).cached, true, 'a repeat answers from memory')
  assert.equal((await bareAsk('cards', 1)).status, 'invalid', 'a line that names no slide is refused')
  const handler = createVariantThumbnailHandler(() => null, renderer)
  const viaIpc = await handler({}, outlinePath, bare, { headingLine: bareLine }, 'cards')
  assert.equal(viaIpc.status, 'ok', 'the IPC handler takes { headingLine } as the slide')
  assert.equal((await handler({}, outlinePath, bare, { headingLine: 'x' }, 'cards')).status, 'invalid', 'a malformed slide is refused')
}

console.log('layout variant thumbnail: all checks passed')
