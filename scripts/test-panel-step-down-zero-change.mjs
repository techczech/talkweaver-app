// =============================================================================
// test:panel-step-down-zero-change — the icon-row panel step-down changes nothing on a slide that fits today.
//
// Rule (slide-fit.js fitOceanPanelDetails): among the panel arrangements that fit, the one whose smallest text is
// largest. Steps past today's last step (2.4cqw, PANEL_DETAIL_STEPS_PAST) are taken only where nothing on today's
// ladder fits. This test walks every slide at every Next step, at 1600x900, twice: with this checkout's runtime and with
// the "base", main's own slide-fit.js before the step-down (origin/main at the step-down's merge base, d6f9c4895),
// pinned in scripts/fixtures/panel-step-down/slide-fit-main.js with its git blob hash checked here, so the base is never
// derived from the runtime under test. Each compiled deck is drawn twice, the only difference the inlined slide-fit.js.
// The pin is a gate for the step-down against the runtime it replaced: a later change to slide-fit.js that draws any
// state differently fails here until the pin is moved to that change's merge base (git show <base>:<path>, new hash).
// FIT_BASE_RUNTIME=<slide-fit.js> uses another file as the base by hand.
//
// Decks: the layout sampler, the Ocean look fixtures, the example talks, and a family of synthetic icon rows written
// here (two, three and four panels, short and long lines, one to ten lines, top and side titles, with and without
// reveal). The family's shapes are asserted on the base first: it holds two-panel rows that fit at the size for their
// count, two-panel rows that fit at a step of today's ladder, two-panel rows drawn at full size past their band
// (reported too long), zoomed rows (three and four panels), and rows that do not fit at today's last step.
//
// Asserted, per state:
//   - a state the branch draws without a step past today's ladder is drawn exactly as the base draws it: every element's
//     box and type size to half a px, the look, the whole-slide zoom and the fit stamps, and every element's attributes
//     (classes as a sorted set, inline style property by property, custom properties included) serialised the same, so
//     a class or inline property left behind fails even where it draws nothing;
//   - the comparison catches what it says: on a state that fits at its size, a one-pixel shift, an extra class and a
//     leftover inline custom property are each put on the branch's drawing and each must be reported;
//   - a state drawn with a step past today's ladder is one the base did not fit (it fell back to the safe drawing or
//     ran text past the stage), keeps the look, runs no text past the stage, and its smallest text is at or above the
//     type floor;
//   - every two-panel row in the family that fits on the base, or is drawn there at full size past its band, takes no
//     step past today's ladder (the round of PR 376 that was rejected shrank these).
// The measures here are written apart from slide-fit.js's predicates. Hard timeout; scratch removed in finally.
// =============================================================================
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { chromium } from 'playwright'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'tw-panel-zero-change-'))
const HARD_LIMIT_MS = 1_500_000
const hardStop = setTimeout(() => { console.error(`test:panel-step-down-zero-change: hard timeout after ${HARD_LIMIT_MS} ms`); rmSync(work, { recursive: true, force: true }); process.exit(124) }, HARD_LIMIT_MS)

const runtimePath = join(repo, 'compiler/assets/runtime/slide-fit.js')
const runtime = readFileSync(runtimePath, 'utf8')
const PAST_CQW = [2.2, 2, 1.9375]
// main's slide-fit.js at the step-down's merge base (d6f9c4895), as git stores it
const MAIN_PIN = { path: join(repo, 'scripts/fixtures/panel-step-down/slide-fit-main.js'), blob: '1ed148ac9bbb363071e90ca59666e6fe7f357e11', commit: 'd6f9c4895504e3c31965b1d9fc9e1a5e6d103be4' }
const gitBlob = (buffer) => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buffer.length}\0`), buffer])).digest('hex')
const pinned = readFileSync(MAIN_PIN.path)
assert.equal(gitBlob(pinned), MAIN_PIN.blob, `the pinned base is main's slide-fit.js at ${MAIN_PIN.commit.slice(0, 9)} (blob ${MAIN_PIN.blob.slice(0, 9)})`)
// where the history is there (not in a shallow checkout), the pin is also read back from git
try {
  const fromGit = execFileSync('git', ['-C', repo, 'rev-parse', `${MAIN_PIN.commit}:compiler/assets/runtime/slide-fit.js`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  assert.equal(fromGit, MAIN_PIN.blob, 'git agrees on the pinned blob')
} catch (error) { if (error instanceof assert.AssertionError) throw error }
const baseRuntime = process.env.FIT_BASE_RUNTIME ? readFileSync(process.env.FIT_BASE_RUNTIME, 'utf8') : pinned.toString('utf8')
assert.notEqual(baseRuntime, runtime, 'the base is not the runtime under test')
function baseDeck(html) {
  const parts = html.split(runtime)
  assert.ok(parts.length >= 2, 'the compiled deck inlines slide-fit.js verbatim')
  return parts.join(baseRuntime)
}

// ---- the synthetic panel family (neutral content) --------------------------------------------------------------
const WHO = ['Neighbours', 'Volunteers', 'Visitors', 'Growers']
const ICONS = ['sprout', 'shovel', 'map', 'leaf']
const SHORT = ['Sow the early peas', 'Prune the apple trees', 'Water the seedlings', 'Cut the long grass', 'Pot on the young plants', 'Clear the pond edges', 'Lay the thin hedge', 'Turn the compost heap', 'Dry the saved seed', 'Oil and hang the tools']
const LONG = ['Sow the early peas along the fence before the frost', 'Prune the apple trees before the buds open in spring', 'Water the seedlings every second morning in dry weeks', 'Cut the long grass after the meadow flowers have seeded', 'Pot on the young plants into larger pots by the door', 'Clear the weed from the edges of the water every month', 'Lay the hedge where it has grown thin along the lane', 'Turn the heap and add the green waste from the beds', 'Label and dry the saved seed in paper bags for winter', 'Oil the blades and hang the tools up after every use']
const FAMILY = []
for (const panels of [2, 3, 4]) {
  for (const words of ['short', 'long']) {
    for (let lines = 1; lines <= 10; lines += 1) {
      for (const side of [false, true]) {
        const id = `pf-${panels}x${lines}-${words}${side ? '-side' : ''}`
        FAMILY.push({ id, panels, lines, side, text: [
          `### Who looks after the garden ${panels} ${lines} ${words}${side ? ' beside' : ''}`,
          `{iconrow}${side ? '{sidebar}' : ''}${lines % 3 === 0 ? '{reveal}' : ''}{id=${id}}`, '',
          ...Array.from({ length: panels }, (_, p) => [`- ${WHO[p]} {icon=lucide:${ICONS[p]}}`, ...Array.from({ length: lines }, (_, l) => `  - ${(words === 'short' ? SHORT : LONG)[(l + p * 3) % 10]}`)]).flat(), ''] })
      }
    }
  }
}
// two panels under a title of two or three lines: less band, so some rows fit the stage but not the band
for (const words of ['short', 'long']) {
  for (let lines = 1; lines <= 10; lines += 1) {
    const id = `pf-2x${lines}-${words}-tall-title`
    FAMILY.push({ id, panels: 2, lines, side: false, text: [
      `### Who looks after the garden, the orchard, the greenhouse and the pond through the year ${lines} ${words}`,
      `{iconrow}{id=${id}}`, '',
      ...Array.from({ length: 2 }, (_, p) => [`- ${WHO[p]} {icon=lucide:${ICONS[p]}}`, ...Array.from({ length: lines }, (_, l) => `  - ${(words === 'short' ? SHORT : LONG)[(l + p * 3) % 10]}`)]).flat(), ''] })
  }
}
const familyOutline = ['---', 'title: Panel family', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '', '## Panels', '', ...FAMILY.flatMap((f) => f.text)].join('\n')

// ---- in-page measure (independent of slide-fit.js) -------------------------------------------------------------
function drawingProbe() {
  // a reveal's fade still running is drawn at its end state (both runtimes alike)
  for (const animation of document.getAnimations()) { try { animation.finish() } catch { /* an endless one stays */ } }
  const slide = document.querySelector('.stage > .slide.active')
  const content = slide.querySelector(':scope > .slide-content')
  // A reveal step smooth-scrolls its unit into view (scrollCurrentUnitIntoView), so on a slide that runs past the stage
  // the scroll offset when measured depends on timing: every box is measured unscrolled, and the offsets restored.
  const scrolled = [...slide.querySelectorAll('*'), slide, document.scrollingElement].filter((el) => el && (el.scrollTop || el.scrollLeft)).map((el) => [el, el.scrollTop, el.scrollLeft])
  scrolled.forEach(([el]) => { el.scrollTop = 0; el.scrollLeft = 0 })
  const box = slide.getBoundingClientRect()
  const k = box.width / slide.offsetWidth
  const zoom = parseFloat(content.style.zoom) || 1
  const half = (n) => Math.round(n * 2) / 2
  const parts = []
  let smallest = Infinity
  let outside = 0
  for (const e of slide.querySelectorAll('*')) {
    // inside a drawn picture (a chart, a mind map) its own script places and fades the parts over time: the picture's
    // own box is compared, not its parts
    if (e.closest('.notes, .sr-only') || e.parentElement?.closest('svg')) continue
    const cs = getComputedStyle(e)
    if (cs.display === 'none') continue
    const r = e.getBoundingClientRect()
    parts.push(`${e.tagName}.${e.className && e.className.baseVal === undefined ? e.className : ''}|${half((r.left - box.left) / k)}|${half((r.top - box.top) / k)}|${half(r.width / k)}|${half(r.height / k)}|${cs.fontSize}|${cs.visibility}|${Math.round(Number(cs.opacity) * 100) / 100}`)
    if (cs.visibility === 'hidden' || e.closest('[aria-hidden="true"], .kicker, .qr-caption, .footer, .gallery-nav')) continue
    if (![...e.childNodes].some((n) => n.nodeType === 3 && n.data.trim())) continue
    const size = parseFloat(cs.fontSize) * zoom
    if (size > 0 && size < smallest) smallest = size
    if (r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1) outside += 1
  }
  scrolled.forEach(([el, top, left]) => { el.scrollTop = top; el.scrollLeft = left })
  // Every element's attributes, canonical: the slide and all inside it (hidden ones too), except a drawn picture's
  // parts (placed by its own script over time, as above). Classes as a sorted set; the style attribute as its inline
  // properties, each with its value and priority, sorted (custom properties included); the rest name=value, sorted.
  const attrs = []
  const generatedNames = new Set()
  for (const part of slide.querySelectorAll('svg, svg *')) {
    for (const { value } of part.attributes) for (const m of value.matchAll(/\b(mmd?)-[a-z0-9]{6,}\b/g)) generatedNames.add(m[0])
  }
  for (const e of [slide, ...slide.querySelectorAll('*')]) {
    if (e.parentElement?.closest('svg')) continue
    const fields = []
    // markmap and mermaid (vendor) name their picture with a random token per page load: mm-<random>-<n>, mmd-<random>
    // Only names such a picture actually carries are treated as equal: a link or id written in a panel that merely
    // looks like one is compared as it stands.
    const unrandom = (value) => value.replace(/\b(mmd?)-[a-z0-9]{6,}\b/g, (name, kind) => (generatedNames.has(name) ? `${kind}-~` : name))
    for (const { name, value: raw } of e.attributes) {
      const value = unrandom(raw)
      if (name === 'class') fields.push(`class=${[...e.classList].map(unrandom).sort().join(' ')}`)
      else if (name === 'style') {
        const props = []
        for (let i = 0; i < e.style.length; i += 1) { const prop = e.style[i]; props.push(`${prop}:${e.style.getPropertyValue(prop).trim()}${e.style.getPropertyPriority(prop) ? '!important' : ''}`) }
        fields.push(`style=${props.sort().join(';')}`)
      } else fields.push(`${name}=${value}`)
    }
    attrs.push(`${e.tagName}[${fields.sort().join('|')}]`)
  }
  const row = content.querySelector(':scope > .icon-row')
  const items = row ? [...row.querySelectorAll(':scope > .ir-item')] : []
  const steps = [...new Set(items.map((item) => item.style.getPropertyValue('--oc-detail')).filter(Boolean))]
  return {
    drawing: parts.join('\n'), attrs: attrs.join('\n'), look: slide.dataset.look || '', textFit: content.dataset.textFit || '', zoom,
    stamps: ['listFit', 'statementFit', 'textTooTall'].map((key) => content.dataset[key] || '').join('|'),
    steps, smallest: Number.isFinite(smallest) ? smallest : 0, outside, floor: slide.clientWidth * 1.9375 / 100,
    detail: row?.querySelector('.ir-desc > li') ? parseFloat(getComputedStyle(row.querySelector('.ir-desc > li')).fontSize) : null,
  }
}

// Every slide, shown by its address, then every reveal step (Next until the slide changes): the same walk for both
// runtimes, so a state is compared with the same state.
async function walk(browser, html, name) {
  const path = join(work, `${name}.html`)
  writeFileSync(path, html, 'utf8')
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' })
  try {
    await page.route('**/*', (route) => (/^(file|data|blob):/.test(route.request().url()) ? route.fallback() : route.abort()))
    await page.goto(pathToFileURL(path).href, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts.ready)
    const ids = await page.evaluate(() => [...document.querySelectorAll('.stage > .slide')].map((s) => s.dataset.id).filter(Boolean))
    const states = new Map()
    for (const id of ids) {
      await page.evaluate((target) => { location.hash = target }, id)
      const shown = await page.waitForFunction((target) => document.querySelector('.stage > .slide.active')?.dataset.id === target, id, { timeout: 8000 }).then(() => true, () => false)
      if (!shown) continue
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(220)
      const steps = await page.evaluate(() => document.querySelector('.stage > .slide.active').querySelectorAll('.mode-el').length)
      states.set(`${id}#0`, await page.evaluate(drawingProbe))
      for (let step = 1; step <= steps; step += 1) {
        await page.evaluate(() => { document.activeElement?.blur?.(); window.focus() })
        await page.keyboard.press('ArrowRight')
        await page.waitForTimeout(160)
        if (await page.evaluate((target) => document.querySelector('.stage > .slide.active')?.dataset.id !== target, id)) break
        states.set(`${id}#${step}`, await page.evaluate(drawingProbe))
      }
    }
    assert.ok(states.size >= ids.length * 0.9, `${name}: only ${states.size} states for ${ids.length} slides`)
    return states
  } finally {
    await page.close()
  }
}
const isPast = (value) => PAST_CQW.some((cqw) => value.includes(`${cqw}cqw)`))
// What differs between two probes of the same state, each named with its first difference ([] when drawn the same).
function differences(b, a) {
  const out = []
  for (const key of ['look', 'zoom', 'textFit', 'stamps']) if (b[key] !== a[key]) out.push(`${key} ${b[key]}, base ${a[key]}`)
  for (const key of ['drawing', 'attrs']) {
    if (b[key] === a[key]) continue
    const x = b[key].split('\n'), y = a[key].split('\n')
    const i = x.findIndex((line, j) => line !== y[j])
    out.push(`${key} differs first at element ${i}: ${x[i]} | base ${y[i]}`)
  }
  return out
}
// One state of a deck, probed after `mutate` (a function run in the page, by name) changes the drawing on show.
const MUTATIONS = {
  // a one-pixel shift of one detail line, from a style sheet outside the slide (no attribute on the slide changes)
  pixel: () => {
    const style = document.createElement('style')
    style.textContent = '.stage > .slide.active .ir-desc > li:first-child { position: relative; top: 1px; }'
    document.head.appendChild(style)
  },
  // an extra class that draws nothing
  class: () => document.querySelector('.stage > .slide.active .ir-desc > li').classList.add('zero-change-extra'),
  // a leftover inline custom property, set to the value the item already resolves (draws nothing)
  property: () => {
    const item = document.querySelector('.stage > .slide.active .icon-row > .ir-item')
    item.style.setProperty('--oc-detail', getComputedStyle(item).getPropertyValue('--oc-detail').trim() || '1px')
  },
}
async function probeState(browser, html, name, id, mutation) {
  const path = join(work, `${name}-probe.html`)
  writeFileSync(path, html, 'utf8')
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' })
  try {
    await page.route('**/*', (route) => (/^(file|data|blob):/.test(route.request().url()) ? route.fallback() : route.abort()))
    await page.goto(pathToFileURL(path).href, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts.ready)
    await page.evaluate((target) => { location.hash = target }, id)
    await page.waitForFunction((target) => document.querySelector('.stage > .slide.active')?.dataset.id === target, id, { timeout: 8000 })
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(220)
    if (mutation) {
      await page.evaluate(MUTATIONS[mutation])
      await page.waitForTimeout(60)
    }
    return await page.evaluate(drawingProbe)
  } finally {
    await page.close()
  }
}

let browser
try {
  browser = await chromium.launch({ headless: true })
  const decks = []
  const compile = async (name, path, text, roots = []) => {
    const model = await prepareSource(path, text, name, statSync(path), undefined, { allowedAssetRoots: [dirname(path), ...roots] })
    decks.push({ name, html: String(model.fullHtml) })
  }
  const familyPath = join(work, 'panel-family-outline.md')
  writeFileSync(familyPath, familyOutline)
  await compile('panel-family', familyPath, familyOutline)
  await compile('sampler', join(repo, 'docs/layout-sampler-outline.md'), readFileSync(join(repo, 'docs/layout-sampler-outline.md'), 'utf8'), [join(repo, 'e2e/fixtures')])
  for (const name of ['ten-kinds', 'edge-cases', 'review-cases', 'talk-combinations', 'statement-combinations']) {
    const path = join(repo, 'scripts/fixtures/ocean-look', `${name}-outline.md`)
    await compile(name, path, readFileSync(path, 'utf8'), [join(repo, 'e2e/fixtures')])
  }
  const vault = join(repo, 'resources/example-vault')
  for (const slug of readdirSync(vault, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_')).map((e) => e.name).sort()) {
    const path = join(vault, slug, `${slug}-outline.md`)
    await compile(slug, path, readFileSync(path, 'utf8'))
  }

  const totals = { states: 0, same: 0, stepped: 0 }
  let gateState = null
  const family = {}
  // DECKS=<name,…> walks only those decks (for a quick look; the family assertions need panel-family)
  const only = process.env.DECKS ? process.env.DECKS.split(',') : null
  for (const { name, html } of decks.filter((d) => !only || only.includes(d.name))) {
    const [branch, base] = await Promise.all([walk(browser, html, `${name}-branch`), walk(browser, baseDeck(html), `${name}-base`)])
    assert.deepEqual([...branch.keys()], [...base.keys()], `${name}: the two runtimes reach different states`)
    for (const [at, b] of branch) {
      const a = base.get(at)
      totals.states += 1
      const stepped = b.steps.some(isPast)
      if (!stepped) {
        const found = differences(b, a)
        assert.deepEqual(found, [], `${name} ${at}: drawn differently from the base without a step past the ladder: ${found.join('; ')}`)
        totals.same += 1
      } else {
        totals.stepped += 1
        assert.ok(a.look === 'ocean-safe' || a.outside > 0, `${name} ${at}: stepped past the ladder, but the base fits (${JSON.stringify({ look: a.look, outside: a.outside, textFit: a.textFit })})`)
        assert.equal(b.look, 'ocean', `${name} ${at}: stepped, but not in the look`)
        assert.equal(b.outside, 0, `${name} ${at}: stepped, with text past the stage`)
        assert.ok(b.smallest >= b.floor - 0.5, `${name} ${at}: stepped to ${b.smallest}px, under the floor ${b.floor}px`)
        assert.equal(new Set(b.steps).size, 1, `${name} ${at}: more than one detail size in the row`)
      }
      if (name === 'panel-family') {
        const id = at.split('#')[0]
        const f = FAMILY.find((x) => x.id === id)
        if (!f) continue
        const kind = a.look === 'ocean-safe' ? 'base falls back'
          : a.outside > 0 ? 'base past the stage'
            : a.zoom < 1 ? 'base zoomed'
              : a.textFit === 'too-long' ? 'base too long at full size'
                : a.steps.length ? 'base fits at a ladder step' : 'base fits at its size'
        if (kind === 'base fits at its size' && at.endsWith('#0') && f.panels === 2 && !gateState) gateState = { html, id, base: a }
        family[kind] ??= { two: 0, all: 0, stepped: 0 }
        family[kind].all += 1
        if (f.panels === 2) family[kind].two += 1
        if (stepped) family[kind].stepped += 1
        if (f.panels === 2 && !['base falls back', 'base past the stage'].includes(kind)) assert.ok(!stepped, `${at}: a two-panel row the base draws (${kind}) took a step past the ladder`)
      }
    }
  }
  // The family keeps testing what it says: each shape is there on the base.
  for (const kind of ['base fits at its size', 'base fits at a ladder step', 'base too long at full size']) {
    assert.ok(family[kind]?.two > 0, `the family has no two-panel row that is "${kind}" (${JSON.stringify(family)})`)
  }
  // no two-panel row is zoomed on the base (one that fits the stage but not its band at the size for its count is
  // rare enough that none of these shapes is one); rows of three and four panels are
  assert.ok(family['base zoomed']?.all > 0, `the family has no zoomed row (${JSON.stringify(family)})`)
  assert.ok(family['base falls back']?.stepped > 0, `no row in the family falls back on the base and fits past the ladder (${JSON.stringify(family)})`)
  // The comparison catches what it says: each change, on a two-panel row that fits at its size, is reported.
  assert.ok(gateState, 'no two-panel row that fits at its size to check the comparison on')
  assert.deepEqual(differences(await probeState(browser, gateState.html, 'gate', gateState.id), gateState.base), [], `${gateState.id}: probed alone, drawn as in the walk`)
  const caught = {}
  for (const mutation of Object.keys(MUTATIONS)) {
    const found = differences(await probeState(browser, gateState.html, `gate-${mutation}`, gateState.id, mutation), gateState.base)
    assert.ok(found.length > 0, `${gateState.id}: the comparison missed a ${mutation} change`)
    caught[mutation] = found.map((line) => line.split(' ')[0])
  }
  console.log(JSON.stringify({ base: process.env.FIT_BASE_RUNTIME ? 'FIT_BASE_RUNTIME' : `pinned main ${MAIN_PIN.commit.slice(0, 9)}`, gate: { state: gateState.id, caught } }))
  console.log(JSON.stringify({ totals, family }))
  console.log(`test:panel-step-down-zero-change: ${totals.states} states in ${decks.length} decks; ${totals.same} drawn exactly as main (geometry, type, classes, attributes, inline styles), ${totals.stepped} stepped past today's ladder (each one the base did not fit, at or above the floor)`)
} finally {
  clearTimeout(hardStop)
  await browser?.close()
  rmSync(work, { recursive: true, force: true })
}
