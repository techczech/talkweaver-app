// =============================================================================
// test:step-count-parity-dom — the presenter's Current pane counts a slide's steps as the projector does
//
// The presenter steps a slide by an integer (state.mode.step) and two runtimes turn that number into a picture: the
// projector (audience window) paints its live slide, and the presenter's Current pane paints a detached clone of the
// slide (previewSlide). Both enumerate the slide's step units with one rule (modeElementsFor / slideSteps), but a
// unit can be hidden by the look's stylesheet (the 0.44 look's loop hides the cycle's arcs with display:none), and a
// detached clone has no computed style. When the two enumerations differ, step k means a different unit on each
// screen: the 0.44.5 loop showed the presenter stop 3 while the audience saw stop 5 (journey gate,
// present.audience-matches-presenter).
//
// This test walks every slide of the layout sampler that has step units (every registered layout, the carousel,
// the chats and terminals, emphasis steps, the mind map, the table) in the 0.44 look and in the classic look, plus a
// fixture of the journey's own focus loop with long labels, and at each state compares the projector's step states
// (each unit's data-mode-state, in order) with the Current pane's. A new kind of step unit, or a look that hides one,
// cannot drift silently: its slide fails here. Every requested slide must be reached on both screens and compared at
// least once (or show its running page in the pane); a slide that is never compared fails by name, and a slide counts
// under every kind of step unit it carries, not only the first.
// Browser: Playwright's bundled Chromium (never the installed Chrome).
// =============================================================================

import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { readFile, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { buildLayoutSampler } from './build-layout-sampler.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { presenterSelectors } from './lib/mode-selectors.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = await mkdtemp(join(tmpdir(), 'tw-step-parity-'))

// The journey's loop (scripts/journeys/talk.mjs): five stops with long labels, so the 0.44 look draws the long-label
// ring (data-oc-long). Beside it a carousel whose cards step, and a chat that reveals by steps.
const fixtureOutline = [
  '---', 'title: Step parity', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '# Deck', '## Section', '',
  '### The walking year', '{cycle}{focus}{id=loop}', '',
  '- Choosing the route through the water meadows',
  '- Checking the footpaths after the winter floods',
  '- Inviting new walkers from the community centre',
  '- Walking together on the first Saturday',
  '- Writing up what everyone noticed along the way', '',
  '### A short loop', '{cycle}{reveal}{id=loop-short}', '', '- Plan', '- Walk', '- Write', '',
  '### Cards that step', '{carousel}{reveal}{id=cards}', '',
  '#### First card', '', '- One', '- Two', '',
  '#### Second card', '', '- Three', '- Four', '- Five', '',
  '### End', '{id=end}', '', 'Words only.', ''
].join('\n')
const fixturePath = join(scratch, 'step-parity.md')
await writeFile(fixturePath, fixtureOutline, 'utf8')
const fixtureHtml = (await prepareSource(fixturePath, fixtureOutline, null, await stat(fixturePath), {}, {})).fullHtml

const decks = {
  '/sampler-ocean/deck.html': (await buildLayoutSampler(join(scratch, 'ocean'))).html,
  '/sampler-classic/deck.html': (await buildLayoutSampler(join(scratch, 'classic'), { classic: true })).html,
  '/fixture/deck.html': fixtureHtml,
}
// The sampler's pictures are files beside its outline (docs/) and in e2e/fixtures; serve them so the layouts that
// lay out by a picture's size do so.
const roots = [join(repo, 'docs'), join(repo, 'e2e/fixtures'), repo]
const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.html': 'text/html; charset=utf-8' }
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0])
  if (decks[path]) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(decks[path]); return }
  const rel = path.replace(/^\/(sampler-ocean|sampler-classic|fixture)\//, '')
  for (const root of roots) {
    const file = resolve(root, rel)
    if (!file.startsWith(root)) continue
    try { const body = await readFile(file); res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' }); res.end(body); return } catch {}
  }
  res.writeHead(404); res.end()
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`

/** The step states on show: the slide id, its layout and each step unit's data-mode-state in order. */
function readSteps(inPreview) {
  const frames = inPreview ? [...document.querySelectorAll('#currentPreview > iframe:not(.preview-outgoing):not(.live-sim-frame)')] : []
  // A slide whose visual is an embedded page shows that page itself in the Current pane, running, in place of a
  // picture of the slide (previewSlide: renderLivePreviewEmbed and its kin): there is no step to draw there.
  if (inPreview && !frames.length && document.querySelector('#currentPreview > :is(iframe.live-sim-frame, .live-page-slot)')) return { live: true }
  const doc = inPreview ? frames.at(-1)?.contentDocument : document
  const slide = doc?.querySelector(inPreview ? '.slide' : '.slide.active')
  if (!slide) return null
  const letter = { hidden: 'h', current: 'c', soft: 's', full: 'f', fuzzy: 'z' }
  const modes = [...slide.querySelectorAll('[data-mode-state]')].map((el) => letter[el.dataset.modeState] || '?').join('')
  const card = slide.querySelector('.card-gallery[data-exclusive] > .card.active-card')
  const cards = card ? [...card.parentElement.children].indexOf(card) : -1
  return { slide: slide.dataset.id, layout: slide.dataset.layout || '', modes, card: cards }
}

const browser = await chromium.launch({ headless: true })
let failures = 0
const table = new Map() // kind → { slides, states, live, mismatches, examples }
const perSlide = new Map() // deck#id → { kinds, states, live }
try {
  for (const deck of Object.keys(decks)) {
    const context = await browser.newContext({ viewport: { width: 1500, height: 900 }, reducedMotion: 'reduce' })
    const session = `step-parity-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const presenter = await context.newPage()
    const projector = await context.newPage()
    for (const page of [presenter, projector]) page.on('pageerror', (error) => { failures += 1; console.error(`FAIL ${deck} page error: ${error.message}`) })
    await projector.goto(`${origin}${deck}?audience=1&session=${session}`, { waitUntil: 'load' })
    await presenter.goto(`${origin}${deck}?presenter=1&session=${session}`, { waitUntil: 'load' })
    await presenter.waitForSelector('#presenterRoot, .presenter-root')

    // Every slide that has anything to step: units of the mode selector, a carousel, emphasis or file steps. It counts
    // under EVERY kind it carries (each selector entry it matches, and carousel / emphasis / files), so a kind is
    // never reported as covered by a slide that was compared for another kind only. The slide's own elements only:
    // nothing in a container overlay (a contents strip's miniatures).
    const stepped = await projector.evaluate((selectorList) => {
      const entries = selectorList.split('\u0000')
      return [...document.querySelectorAll('.slide[data-id]')].map((slide) => {
        const id = slide.dataset.id
        const has = (sel) => [...slide.querySelectorAll(sel)].some((el) => el.parentElement.closest('.slide, .ct-overlay') === slide)
        const kinds = []
        if (has('.card-gallery[data-exclusive]')) kinds.push('carousel cards')
        if (slide.hasAttribute('data-emphasis-steps')) kinds.push('emphasis steps')
        if (slide.hasAttribute('data-media-steps')) kinds.push('files that play as a step')
        for (const sel of entries) if (has(sel)) kinds.push(sel)
        return kinds.length ? { id, kinds } : null
      }).filter(Boolean)
    }, presenterSelectors('MODE_SELECTOR').join('\u0000'))
    assert(stepped.length > 0, `${deck}: slides with steps found`)

    let sent = null
    const settle = async () => {
      sent = await presenter.evaluate(() => ({
        slide: document.querySelector('.slide.active')?.dataset.id ?? null,
        focus: document.documentElement.dataset.twLiveFocus || '',
        reveal: Number(document.documentElement.dataset.twLiveReveal) || 0
      }))
      await projector.waitForFunction((want) => document.querySelector('.slide.active')?.dataset.id === want.slide
        && (document.documentElement.dataset.twLiveFocus || '') === want.focus
        && (Number(document.documentElement.dataset.twLiveReveal) || 0) === want.reveal, sent, { timeout: 5000 })
      const shown = await projector.evaluate(readSteps, false)
      let pane = null
      for (const deadline = Date.now() + 3000; Date.now() < deadline;) {
        pane = await presenter.evaluate(readSteps, true)
        if (pane?.live || (pane && pane.slide === shown?.slide && pane.modes === shown?.modes)) break
        await presenter.waitForTimeout(25)
      }
      return { shown, pane }
    }
    for (const s of stepped) {
      const name = `${deck.split('/')[1]}#${s.id}`
      const rows = s.kinds.map((kind) => {
        const row = table.get(kind) || { slides: new Set(), states: 0, live: 0, mismatches: 0, examples: [] }
        table.set(kind, row)
        row.slides.add(name)
        return row
      })
      const mine = { kinds: s.kinds, states: 0, live: 0 }
      perSlide.set(name, mine)
      await presenter.evaluate((id) => { location.hash = id }, s.id)
      // Arrival at the requested slide, on the presenter and then (settle) on the projector: never assumed.
      try {
        await presenter.waitForFunction((id) => document.querySelector('.slide.active')?.dataset.id === id, s.id, { timeout: 5000 })
      } catch {
        failures += 1
        console.error(`FAIL ${name}: the presenter never arrived at the slide`)
        continue
      }
      // Compares the two screens at the presenter's step. False when the presenter has left the slide (a press that
      // moves on ends the walk): that is not a comparison, and it is never counted as one.
      const compare = async (label) => {
        const { shown, pane } = await settle()
        if (sent?.slide !== s.id) return false
        assert.equal(shown?.slide, s.id, `${name} ${label}: the projector shows the presenter's slide`)
        if (pane?.live) { mine.live += 1; for (const row of rows) row.live += 1; return true }
        mine.states += 1
        const differs = !pane || pane.slide !== shown.slide || pane.modes !== shown.modes
        for (const row of rows) {
          row.states += 1
          if (!differs) continue
          row.mismatches += 1
          if (row.examples.length < 3) row.examples.push(`${name} ${label}: projector ${shown.modes || '(none)'} (${shown.modes.length}), Current pane ${pane ? `${pane.modes || '(none)'} (${pane.modes.length})` : 'missing'}`)
        }
        return true
      }
      if (!(await compare('arrival'))) {
        failures += 1
        console.error(`FAIL ${name}: the slide was left before its arrival was compared`)
        continue
      }
      // Focus from its start, one step, its last step; then reveal the same way. A press that leaves the slide ends
      // that slide's walk (the next slide is reached by its own address).
      for (const key of ['f', 'ArrowRight', 'ArrowRight', 'r', 'ArrowRight', 'End-of-slide', 'r']) {
        if (key === 'End-of-slide') {
          for (let i = 0; i < 40; i += 1) {
            await presenter.keyboard.press('ArrowRight')
            if (!(await compare(`reveal step ${i + 2}`))) break
          }
          break
        }
        await presenter.keyboard.press(key)
        if (!(await compare(key))) break
      }
      // Leave the slide with no mode on, whatever the walk ended in.
      await presenter.evaluate(() => { location.hash = '' })
    }
    await context.close()
  }
} finally {
  await browser.close()
  server.close()
}

console.log('\nstep units by kind: states compared, presenter Current pane against projector')
console.log('| kind of step unit (a slide counts under every kind it carries) | slides | states compared | pane shows the running page | differences |')
console.log('| --- | --- | --- | --- | --- |')
for (const [kind, row] of table) {
  console.log(`| \`${kind}\` | ${row.slides.size} | ${row.states} | ${row.live} | ${row.mismatches} |`)
  if (row.mismatches) { failures += 1; for (const e of row.examples) console.error(`FAIL ${e}`) }
  if (row.states === 0) { failures += 1; console.error(`FAIL ${kind}: no state compared on ${[...row.slides].join(', ')}`) }
}
// Every requested slide, by name: compared at least once, or its pane shows the running page (named here, so a slide
// that is only ever "live" is visible in the output rather than counted as covered).
const liveOnly = []
for (const [name, mine] of perSlide) {
  if (mine.states > 0) continue
  if (mine.live > 0) { liveOnly.push(name); continue }
  failures += 1
  console.error(`FAIL ${name} (${mine.kinds.join(', ')}): never compared`)
}
const compared = [...perSlide.values()].filter((mine) => mine.states > 0).length
console.log(`\n${compared} of ${perSlide.size} requested slides compared${liveOnly.length ? `; the pane shows the running page on ${liveOnly.join(', ')}` : ''}`)
if (failures) {
  console.error(`\nstep-count parity: ${failures} failure(s) — the presenter's Current pane would show a different step from the projector.`)
  process.exit(1)
}
console.log('\nstep-count parity: the Current pane and the projector agree on every kind of step unit')
