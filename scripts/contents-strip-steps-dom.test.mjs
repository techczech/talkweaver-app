// =============================================================================
// test:contents-strip-steps-dom — a slide's steps are its own, whatever its contents strip shows
//
// A section with {contents=strip} draws a filmstrip over each of its children: a miniature of every child slide
// (decorateContainer → stripMiniHtml, a whole copy of that slide inside `.ct-overlay`). Nothing in a miniature is a step
// of the slide it is drawn over. PR 389's review found that it was: the search for a slide's carousel looked through
// every descendant, found a carousel MINIATURE, stepped "inside" it and, with the miniature's units excluded, left the
// slide with no steps at all (Next skipped the host's reveals, on the projector and in the presenter's Current pane).
//
// The rule (runtime/emphasis-steps.js, ownsStepElement): a slide owns only the elements whose nearest enclosing slide
// or container overlay is the slide itself. This test puts a host slide beside each kind of miniature and asserts the
// host's ABSOLUTE step counts on both screens, never only that the two agree (both returning zero must fail):
//   (a) a carousel   (b) a focus loop   (c) a slide with files that play as a step   (d) a reveal list
//   and, for the other searches the rule covers: (e) a terminal that types, (f) pictures beside a host that steps
//   through its images.
// Each host comes in two forms: plain reveal (block units only) and {emphasis-steps} (the flat path of slideSteps).
// Browser: Playwright's bundled Chromium (never the installed Chrome).
// =============================================================================

import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
function silentWav(seconds) {
  const rate = 8000
  const n = rate * seconds
  const buf = Buffer.alloc(44 + n, 0x80)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n, 4); buf.write('WAVE', 8); buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34); buf.write('data', 36); buf.writeUInt32LE(n, 40)
  return buf
}

const dir = await mkdtemp(join(tmpdir(), 'tw-strip-steps-'))
await mkdir(join(dir, 'assets'), { recursive: true })
for (const name of ['a', 'b', 'c']) await writeFile(join(dir, 'assets', `${name}.png`), PNG)
await writeFile(join(dir, 'assets', 'theme.wav'), silentWav(5))

// The miniatures (the second child of each section). The carousel is block-authored: a carousel whose cards are headings
// is drawn in no strip (its cards are beats of their own), so it could not stand beside the host. Each is what the review named, or what another search reads.
const OTHERS = {
  a: { name: 'a carousel', check: '.card-gallery[data-exclusive]', lines: ['#### Cards {carousel}{reveal}', '', '- One card', '- Two cards', ''] },
  b: { name: 'a focus loop', check: '.cycle-diagram .cycle-node', lines: ['#### The loop {cycle}{focus}', '', '- Plan', '- Walk', '- Write', '- Share', ''] },
  c: { name: 'a slide with files that play as a step', check: '[data-play-on-next]', lines: ['#### Files {reveal}', '', '- Before the sound', '', '![Theme](assets/theme.wav){play-on-next}', '', '- After the sound', ''] },
  d: { name: 'a reveal list', check: '.feature-list > li', lines: ['#### Another list {reveal}', '', '- Four', '- Five', '- Six', '- Seven', ''] },
  e: { name: 'a terminal that types', check: '.sim:not(.sim-static)', lines: ['#### Shell {terminal reveal=steps}', '', '```terminal', '$ ls', 'a  b  c', '$ pwd', '/home/walker', '```', ''] },
  f: { name: 'two pictures', check: 'figure.slide-figure img', lines: ['#### Pictures', '', '![First](assets/b.png)', '![Second](assets/c.png)', ''] },
}
// The hosts. `units`: block units with a reveal state on arrival. `emph`: emphasis spans with a state. `steps`: the
// presses of Next that stay on the slide (the next press leaves it). Worked out from the step grammar, not measured:
//   plain    three items, {reveal}: steps 1-3 bring each in, step 4 is the closing "all full" step         → 4
//   emphasis three items each with one bold word, {reveal}: 3 blocks + 3 spans, then the closing full step  → 7
//   pictures (f only) three items and one picture, {reveal}{image-steps}: the figure is a block unit too, so 4
//            reveal steps and the closing full step, then the picture zoomed and the slide as laid out again   → 7
const HOSTS = {
  plain: { lines: (id) => [`#### Host {reveal}{id=${id}}`, '', '- One', '- Two', '- Three', ''], units: 3, emph: 0, steps: 4 },
  emphasis: { lines: (id) => [`#### Host {reveal}{emphasis-steps}{id=${id}}`, '', '- One **bold**', '- Two **bold**', '- Three **bold**', ''], units: 3, emph: 3, steps: 7 },
  pictures: { lines: (id) => [`#### Host {reveal}{image-steps}{id=${id}}`, '', '- One', '- Two', '- Three', '', '![Only](assets/a.png)', ''], units: 4, emph: 0, steps: 7 },
}
const cases = []
const outline = ['---', 'title: Strip steps', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '# Deck']
for (const [key, other] of Object.entries(OTHERS)) {
  for (const form of key === 'f' ? ['pictures'] : ['plain', 'emphasis']) {
    const id = `host-${key}-${form}`
    cases.push({ id, key, form, other })
    outline.push(`## Part ${id}`, '', `### Section ${id} {contents=strip}`, '', ...HOSTS[form].lines(id), ...other.lines)
  }
}
outline.push('## End', '', '### End {id=end}', '', 'Words only.', '')
const outlinePath = join(dir, 'strip-steps.md')
const source = outline.join('\n')
await writeFile(outlinePath, source, 'utf8')
const deckHtml = (await prepareSource(outlinePath, source, null, await stat(outlinePath), {}, {})).fullHtml

const TYPES = { '.png': 'image/png', '.wav': 'audio/wav' }
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0])
  if (path === '/deck.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(deckHtml); return }
  try { const body = await readFile(join(dir, path)); res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' }); res.end(body) } catch { res.writeHead(404); res.end() }
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`

/** The host's own step states on show (nothing inside the strip), and whether the strip shows the miniature. */
function readHost({ inPreview, check }) {
  const frames = inPreview ? [...document.querySelectorAll('#currentPreview > iframe:not(.preview-outgoing):not(.live-sim-frame)')] : []
  const doc = inPreview ? frames.at(-1)?.contentDocument : document
  const slide = doc?.querySelector(inPreview ? '.slide' : '.slide.active')
  if (!slide) return null
  const own = (el) => el.parentElement.closest('.slide, .ct-overlay') === slide
  return {
    slide: slide.dataset.id,
    units: [...slide.querySelectorAll('[data-mode-state]')].filter(own).map((el) => el.dataset.modeState).join(','),
    emph: [...slide.querySelectorAll('[data-emph-state]')].filter(own).length,
    miniature: Boolean(slide.querySelector(`.ct-overlay.ct-strip .ct-shot-mini ${check}`)),
  }
}

const browser = await chromium.launch({ headless: true })
const failures = []
const results = []
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 }, reducedMotion: 'reduce' })
  const session = `strip-steps-${Date.now()}`
  const presenter = await context.newPage()
  const projector = await context.newPage()
  for (const page of [presenter, projector]) page.on('pageerror', (error) => failures.push(`page error: ${error.message}`))
  await projector.goto(`${origin}/deck.html?audience=1&session=${session}`, { waitUntil: 'load' })
  await presenter.goto(`${origin}/deck.html?presenter=1&session=${session}`, { waitUntil: 'load' })
  await presenter.waitForSelector('#presenterRoot, .presenter-root')

  // What the presenter has published, once the projector shows the same.
  const settle = async () => {
    const sent = await presenter.evaluate(() => ({
      slide: document.querySelector('.slide.active')?.dataset.id ?? null,
      focus: document.documentElement.dataset.twLiveFocus || '',
      reveal: Number(document.documentElement.dataset.twLiveReveal) || 0
    }))
    await projector.waitForFunction((want) => document.querySelector('.slide.active')?.dataset.id === want.slide
      && (document.documentElement.dataset.twLiveFocus || '') === want.focus
      && (Number(document.documentElement.dataset.twLiveReveal) || 0) === want.reveal, sent, { timeout: 5000 })
    return sent
  }
  // The projector's host states, and the Current pane's once it has painted the same step.
  const read = async (check) => {
    const shown = await projector.evaluate(readHost, { inPreview: false, check })
    let pane = null
    for (const deadline = Date.now() + 3000; Date.now() < deadline;) {
      pane = await presenter.evaluate(readHost, { inPreview: true, check })
      if (pane && pane.slide === shown?.slide && pane.units === shown.units) break
      await presenter.waitForTimeout(25)
    }
    return { shown, pane }
  }

  for (const c of cases) {
    const want = HOSTS[c.form]
    const label = `${c.id} (${c.form} host beside ${c.other.name})`
    await presenter.evaluate((id) => { location.hash = id }, c.id)
    await presenter.waitForFunction((id) => document.querySelector('.slide.active')?.dataset.id === id, c.id, { timeout: 5000 })
    await settle()
    const arrival = await read(c.other.check)
    const problems = []
    if (!arrival.shown?.miniature) problems.push('the projector\'s strip does not show the miniature (the case tests nothing)')
    const arrivalUnits = (s) => (s?.units ? s.units.split(',').length : 0)
    if (arrivalUnits(arrival.shown) !== want.units) problems.push(`projector: ${arrivalUnits(arrival.shown)} block units on arrival, want ${want.units}`)
    if (arrivalUnits(arrival.pane) !== want.units) problems.push(`Current pane: ${arrivalUnits(arrival.pane)} block units on arrival, want ${want.units}`)
    if (arrival.shown?.emph !== want.emph) problems.push(`projector: ${arrival.shown?.emph} emphasis spans with a state, want ${want.emph}`)
    if (arrival.pane?.emph !== want.emph) problems.push(`Current pane: ${arrival.pane?.emph} emphasis spans with a state, want ${want.emph}`)
    // Next until the slide is left; every press that stays must change what is on show.
    let steps = 0
    let last = `${arrival.shown?.units}|${(await settle()).focus}`
    for (let press = 0; press < 20; press += 1) {
      await presenter.keyboard.press('ArrowRight')
      const sent = await settle()
      if (sent.slide !== c.id) break
      steps += 1
      const now = await read(c.other.check)
      const key = `${now.shown?.units}|${sent.focus}|${await presenter.evaluate(() => JSON.stringify(document.documentElement.dataset.twLiveLightbox || ''))}`
      if (now.pane?.units !== now.shown?.units) problems.push(`step ${steps}: projector ${now.shown?.units || '(none)'}, Current pane ${now.pane?.units || '(none)'}`)
      if (key === last) problems.push(`step ${steps}: Next changed nothing on show (a press spent elsewhere)`)
      last = key
    }
    if (steps !== want.steps) problems.push(`${steps} presses of Next stayed on the slide, want ${want.steps}`)
    results.push({ label, steps, units: arrivalUnits(arrival.shown), ok: problems.length === 0 })
    for (const p of problems) failures.push(`${label}: ${p}`)
    await presenter.evaluate(() => { location.hash = 'end' })
    await presenter.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'end', null, { timeout: 5000 })
    await settle()
  }
  await context.close()
} finally {
  await browser.close()
  server.close()
}

console.log('| host | units on arrival | presses that stay | |')
console.log('| --- | --- | --- | --- |')
for (const r of results) console.log(`| ${r.label} | ${r.units} | ${r.steps} | ${r.ok ? 'ok' : 'FAIL'} |`)
assert.equal(results.length, cases.length, 'every host was walked')
if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`)
  console.error(`\ncontents-strip steps: ${failures.length} failure(s) — a miniature in the strip changed the steps of the slide under it.`)
  process.exit(1)
}
console.log(`\ncontents-strip steps: ${results.length} hosts keep their own steps beside every kind of miniature`)
