// Visual + DOM harness for the ADR-0007 container-mode renderings (Task 6). Compiles a fixture
// deck with a grid-zoom section (incl. a SUBSECTION child), a five-child grid-linear section
// (card wrap + data-child-ids fallback), a contents (thin-rail) section and a {contents=strip}
// filmstrip section; loads the STANDALONE single-file HTML in headless chromium, drives it
// beat-by-beat and asserts the live DOM state classes (.ct-card done/next, .ct-item done/now,
// .ct-shot done/now) plus the landed BEAT INDEX for card-click / number-key jumps. Screenshots
// the key beats to e2e/shots/ for the coordinator.
//
// Unlike the Electron diagnose files this needs no `npm run build` — it drives the compiled deck
// HTML directly (the same DOM the presenter previews clone), so it exercises the shipped runtime.
import { chromium } from 'playwright'
import { fileURLToPath, pathToFileURL } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, writeFileSync, statSync } from 'fs'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')
const SHOTS = join(__dirname, 'shots')
mkdirSync(SHOTS, { recursive: true })

const { prepareSource } = await import(pathToFileURL(join(REPO, 'compiler', 'scripts', 'lib', '08-source-adapters.mjs')).href)

const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const CONTENT = [
  '---', 'title: Container Modes Fixture', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  // grid-zoom with a SUBSECTION child (breeds): its whole subtree runs before the grid-return.
  '## Types of Cats {grid-zoom id=cats}', '{kicker="Part I · Types of Cats"}', '',
  '### Tabby Cats {id=tabby}', '- warm coat', '',
  '### Hairless Cats {id=hairless}', '- no insulation', '',
  '### Fancy Breeds {id=breeds}', '',
  '#### Persian {id=persian}', '- long hair', '',
  '#### Siamese {id=siamese}', '- talkative', '',
  // five-child grid-linear: exercises the data-child-ids fallback (no grid-returns) + card wrap.
  '## Cat Gear {grid-linear id=gear}', '{kicker="Part II · Cat Gear"}', '',
  '### Bowls {id=bowls}', '- ceramic', '',
  '### Beds {id=beds}', '- warm', '',
  '### Toys {id=toys}', '- feathers', '',
  '### Scratchers {id=scratchers}', '- sisal', '',
  '### Carriers {id=carriers}', '- sturdy', '',
  '## Living With Cats {contents id=living}', '{kicker="Part III · Living With Cats"}', '',
  '### Warmth {id=warmth}', '- find the warm spot', '',
  '### Feeding {id=feeding}', '- twice a day', '',
  '### Grooming {id=grooming}', '- brush weekly', '',
  '## A Year of Cats {contents=strip id=year}', '{kicker="Part IV · A Year of Cats"}', '',
  '### Month One {id=m1}', '- settling in', '',
  '### Month Two {id=m2}', '- routines', '',
].join('\n')

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-ct-'))
const outlinePath = join(tempRoot, 'container-modes.md')
writeFileSync(outlinePath, CONTENT)
const model = await prepareSource(outlinePath, CONTENT, 'container-modes', statSync(outlinePath))
const beats = model.beats
const beatSummary = beats.map((b) => `${b.kind}:${b.slideId}`).join(' ')
console.log('beats:', beatSummary)
const firstBeatOf = (id) => beats.findIndex((b) => b.slideId === id)
const beatAt = (kind, slideId, nth = 0) => {
  let seen = 0
  for (let i = 0; i < beats.length; i++) {
    if (beats[i].kind === kind && beats[i].slideId === slideId) { if (seen === nth) return i; seen++ }
  }
  return -1
}

record('fixture beats include grid + grid-return + contents context',
  beats.some((b) => b.kind === 'grid') && beats.some((b) => b.kind === 'grid-return')
  && beats.some((b) => b.context && b.context.container === 'contents'),
  beatSummary)
record('contents=strip variant threaded onto child beats',
  beats.some((b) => b.context && b.context.variant === 'strip'))
record('subsection child subtree precedes its grid-return',
  beats.map((b) => `${b.kind}:${b.slideId}`).join(' ').includes('slide:breeds slide:persian slide:siamese grid-return:cats'),
  beatSummary)

const htmlPath = join(tempRoot, 'deck.html')
writeFileSync(htmlPath, model.fullHtml)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
let cursor = 0
const load = async (suffix = '') => {
  await page.goto(pathToFileURL(htmlPath).href + suffix)
  // attached, not visible: in presenter mode the stage is hidden (previews render instead).
  await page.waitForSelector('.slide.active', { state: 'attached', timeout: 5000 })
  await page.waitForTimeout(250)
  cursor = 0
}
await load()

// Read the live active-slide container state + the CURRENT BEAT INDEX (from the beat counter).
const readState = () => page.evaluate(() => {
  const s = document.querySelector('.slide.active')
  if (!s) return null
  const cls = (el, c) => el.classList.contains(c)
  const count = document.getElementById('slideCount')?.textContent || ''
  return {
    id: s.dataset.id,
    beatIndex: (parseInt(count, 10) || 0) - 1,
    host: [...s.classList].filter((c) => c.startsWith('ct-')),
    cards: [...s.querySelectorAll('.ct-card')].map((c) => ({ t: c.querySelector('.ct-t')?.textContent, done: cls(c, 'done'), next: cls(c, 'next') })),
    items: [...s.querySelectorAll('.ct-item')].map((c) => ({ lbl: c.querySelector('.ct-item-lbl')?.textContent, done: cls(c, 'done'), now: cls(c, 'now') })),
    shots: [...s.querySelectorAll('.ct-shot')].map((c) => ({ done: cls(c, 'done'), now: cls(c, 'now'), mini: !!c.querySelector('.ct-shot-mini .slide') })),
  }
})
const advanceTo = async (target) => {
  while (cursor < target) { await page.keyboard.press('ArrowRight'); cursor++; await page.waitForTimeout(110) }
}
const shot = (name) => page.screenshot({ path: join(SHOTS, `container-${name}.png`) })

// --- Grid beat 0: Card Table, three cards (breeds subsection is ONE card), first next ---
let st = await readState()
record('grid beat 0: card table host', st && st.host.includes('ct-grid-host'), JSON.stringify(st?.host))
record('grid beat 0: three cards (subsection = one card)', st && st.cards.length === 3, `cards=${st?.cards.length}`)
record('grid beat 0: first card next, none done',
  st && st.cards[0].next && st.cards.every((c) => !c.done), JSON.stringify(st?.cards))
await shot('grid-01-entry')

// --- First grid-return: tabby done, hairless next ---
await advanceTo(beatAt('grid-return', 'cats', 0))
st = await readState()
record('grid-return 1: tabby done, hairless next',
  st && st.cards[0].done && st.cards[1].next && !st.cards[2].done, JSON.stringify(st?.cards))
await shot('grid-02-first-return')

// --- Final grid-return (after the breeds SUBTREE): all done, none next ---
await advanceTo(beatAt('grid-return', 'cats', 2))
st = await readState()
record('final grid-return after subsection subtree: all cards done, none next',
  st && st.cards.length === 3 && st.cards.every((c) => c.done && !c.next), JSON.stringify(st?.cards))
record('final grid-return beat index as expected', st && st.beatIndex === beatAt('grid-return', 'cats', 2), `beat=${st?.beatIndex}`)
await shot('grid-03-all-done')

// --- grid-linear with FIVE children: card table from data-child-ids fallback, wraps ---
await advanceTo(beatAt('grid', 'gear'))
st = await readState()
record('grid-linear (5 children): card table via data-child-ids fallback',
  st && st.host.includes('ct-grid-host') && st.cards.length === 5, `cards=${st?.cards.length}`)
record('grid-linear: first child next, none done',
  st && st.cards[0].next && st.cards.every((c) => !c.done), JSON.stringify(st?.cards))
await shot('grid-04-five-children')

// --- Contents section: own slide (no rail), then first child (rail) ---
await advanceTo(firstBeatOf('living'))
st = await readState()
record('contents section own slide: no rail', st && !st.host.includes('ct-rail-host'), JSON.stringify(st?.host))
await advanceTo(firstBeatOf('warmth'))
st = await readState()
record('contents child: thin rail host', st && st.host.includes('ct-rail-host'), JSON.stringify(st?.host))
record('contents child warmth: 3 items, warmth now, none done',
  st && st.items.length === 3 && st.items[0].now && st.items.every((i) => !i.done), JSON.stringify(st?.items))
await shot('contents-01-first')

// --- Grooming: warmth+feeding done, grooming now ---
await advanceTo(firstBeatOf('grooming'))
st = await readState()
record('contents child grooming: warmth+feeding done, grooming now',
  st && st.items[0].done && st.items[1].done && st.items[2].now, JSON.stringify(st?.items))
await shot('contents-02-last')

// --- Filmstrip section: own slide (no strip), then m1 (strip with REAL minis) ---
await advanceTo(firstBeatOf('year'))
st = await readState()
record('strip section own slide: no strip', st && !st.host.includes('ct-strip-host'), JSON.stringify(st?.host))
await advanceTo(firstBeatOf('m1'))
st = await readState()
record('strip child m1: filmstrip host', st && st.host.includes('ct-strip-host'), JSON.stringify(st?.host))
record('strip child m1: 2 shots, m1 now, none done',
  st && st.shots.length === 2 && st.shots[0].now && st.shots.every((s2) => !s2.done), JSON.stringify(st?.shots))
record('strip shots carry REAL slide miniatures (scaled clones, not placeholders)',
  st && st.shots.every((s2) => s2.mini), JSON.stringify(st?.shots))
await shot('strip-01-first')

// --- m2: m1 done, m2 now ---
await advanceTo(firstBeatOf('m2'))
st = await readState()
record('strip child m2: m1 done, m2 now', st && st.shots[0].done && st.shots[1].now, JSON.stringify(st?.shots))
await shot('strip-02-last')

// --- Number-key jump: reload, on grid beat press "3" → BEAT lands on breeds' FIRST beat ---
await load()
await page.keyboard.press('3')
await page.waitForTimeout(200)
st = await readState()
record('number key 3 on grid beat lands on subsection child breeds',
  st && st.id === 'breeds', `landed on ${st?.id}`)
record('number key jump lands on the child FIRST BEAT index',
  st && st.beatIndex === firstBeatOf('breeds'), `beat=${st?.beatIndex} expected=${firstBeatOf('breeds')}`)

// --- Card click: reload, click the Hairless card → beat = hairless first beat ---
await load()
await page.waitForSelector('.ct-card', { timeout: 5000 })
await page.locator('.ct-card', { hasText: 'Hairless Cats' }).click()
await page.waitForTimeout(200)
st = await readState()
record('clicking a card jumps to that child (hairless)', st && st.id === 'hairless', `landed on ${st?.id}`)
record('card click lands on the child FIRST BEAT index',
  st && st.beatIndex === firstBeatOf('hairless'), `beat=${st?.beatIndex} expected=${firstBeatOf('hairless')}`)

// --- Presenter previews (item 5): a grid beat renders in the panes AS the Card Table state ---
await load('?presenter=1')
await page.waitForSelector('#currentPreview iframe', { timeout: 5000 })
await page.waitForTimeout(500)
const previewCards = await page.evaluate(() => {
  const iframe = document.querySelector('#currentPreview iframe')
  const doc = iframe && iframe.contentDocument
  if (!doc) return null
  const cards = [...doc.querySelectorAll('.ct-card')]
  return { count: cards.length, next: cards.map((c) => c.classList.contains('next')) }
})
record('presenter Current preview renders the Card Table for a grid beat',
  previewCards && previewCards.count === 3 && previewCards.next[0] === true, JSON.stringify(previewCards))
await page.screenshot({ path: join(SHOTS, 'container-presenter-previews.png') })

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed; shots in e2e/shots/container-*.png`)
if (failed.length) { console.error(`${failed.length} FAILED`); process.exit(1) }
