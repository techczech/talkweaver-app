// The authored [Video:] reference (data-video-ref, for a recording's clip marks) can be an absolute
// local path. It exists only in the deck the local presenter window loads (compile option
// presenterClipRefs); every other compile and every output built from one — the model the app keeps,
// the dist deck, share pages, handout, handout home, venue/audience page, lazy published page — is
// without it. Outputs checked: compiler/scripts/lib/08-source-adapters.mjs prepareSource (fullHtml,
// model.slides, whole model), 09-output-builders.mjs buildShareHtml (notes, no notes, venue,
// lazyAssets, home), venue-page.mjs, handout-home-page.mjs; main: handout-pages.ts, shared-talk-build.ts.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const lib = (name) => pathToFileURL(join(process.cwd(), 'compiler/scripts/lib', name)).href
const { prepareSource } = await import(lib('08-source-adapters.mjs'))
const { extractSlides, extractStyles } = await import(lib('04-html-extraction.mjs'))
const { buildShareHtml } = await import(lib('09-output-builders.mjs'))
const { buildVenuePageHtml } = await import(lib('venue-page.mjs'))
const { buildHandoutHomePageHtml } = await import(lib('handout-home-page.mjs'))

const base = await mkdtemp(join(tmpdir(), 'tw-video-ref-'))
const secretDir = join(base, 'someone', 'private')
await mkdir(secretDir, { recursive: true })
const clip = join(secretDir, 'demo.mp4')
await writeFile(clip, Buffer.from('\0\0\0\x18ftypmp42clip', 'latin1'))
const outlinePath = join(base, 'talk-outline.md')
const source = ['---', 'title: Private', '---', '', '### A slide', '', `[Video: ${clip}]`, ''].join('\n')
await writeFile(outlinePath, source)
const compile = (extra = {}) => prepareSource(outlinePath, source, 'talk', undefined, {}, { allowedAssetRoots: [base], ...extra })

let failures = 0
async function check(name, fn) { try { await fn(); console.log(`  ok  ${name}`) } catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message.split('\n')[0]}`) } }
// The attribute set with either quote (or none), or the name as a JSON/object key, is a leak; the bare
// name in the runtime's own JS (getAttribute("data-video-ref")) is not.
const refForm = /data-video-ref\s*=|["']data-video-ref["']\s*:|["']videoRef["']\s*:/
const leaks = (text) => text.includes(clip) || refForm.test(text) || text.includes('someone/private')

await check('the presenter deck carries the authored reference on the video', async () => {
  const model = await compile({ presenterClipRefs: true })
  assert.ok(model.fullHtml.includes(`data-video-ref="${clip}"`), 'fullHtml')
})

const model = await compile()
const slides = extractSlides(model.fullHtml)
const styles = extractStyles(model.fullHtml)
const { assets, ...modelWithoutAssets } = model

await check('a default compile (strip, share, backup, dist deck) has no reference: page, slides, whole model', () => {
  assert.ok(model.fullHtml.includes('<video'), 'the clip is on the slide')
  assert.equal(leaks(model.fullHtml), false, 'fullHtml')
  // The model keeps each slide's own source text (slides[].sourceMarkdown, the author's words, never
  // an output); what must not be in it is the compiler's reference attribute and field.
  const kept = JSON.stringify(modelWithoutAssets)
  assert.equal(refForm.test(kept), false, 'model')
  assert.equal(slides.some((s) => leaks(s.html)), false, 'slide html')
  assert.equal(slides.length > 0 && slides.some((s) => leaks(s.html)), false, 'extracted slides')
})

await check('every output built from the deck is without it', () => {
  const common = { title: 'Private', slides, styles, slug: 'private', workerBaseUrl: 'https://x.example', liveTalkSlug: 'private' }
  const outputs = {
    'share with notes': buildShareHtml({ ...common, includeNotes: true }),
    'share without notes / handout': buildShareHtml({ ...common, includeNotes: false }),
    'handout, lazy published page': buildShareHtml({ ...common, includeNotes: false, lazyAssets: true, homeHref: './' }),
    'shared talk': buildShareHtml({ ...common, includeNotes: false, sharedTalk: true }),
    'venue and audience page': buildVenuePageHtml({ ...common, qr: '', handoutUrl: 'https://x.example/p' }),
    'handout home page': buildHandoutHomePageHtml({ ...common, home: { url: 'https://x.example/h' } }),
  }
  for (const [name, html] of Object.entries(outputs)) { assert.ok(html.length > 1000, name); assert.equal(leaks(html), false, name) }
})

await check('only the presenter compile asks for the reference', async () => {
  const dir = 'src/main'
  const hits = []
  for (const file of await readdir(dir)) {
    if (!/\.(ts|mjs)$/.test(file)) continue
    const text = await readFile(join(dir, file), 'utf8')
    text.split('\n').forEach((line, i) => { if (/presenterClipRefs\s*:\s*true/.test(line)) hits.push(`${file}:${i + 1}`) })
  }
  assert.equal(hits.length, 1, hits.join(', '))
  assert.match(await readFile(join(dir, 'index.ts'), 'utf8').then((t) => t.slice(t.indexOf('async function compileTalkForPresent'), t.indexOf('async function compileTalkForPresent') + 900)), /presenterClipRefs: true/)
})

if (failures) { console.error(`\n${failures} video-ref check(s) failed`); process.exit(1) }
console.log('\nvideo-ref privacy: all checks passed')
