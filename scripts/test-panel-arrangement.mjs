// The icon-row panel choice (slide-fit.js choosePanelArrangement) on synthetic measurements: among the candidates
// that fit, the one whose smallest text is largest (the exact maximum); equal values keep the candidate order (the size
// for the row's count first, then today's ladder, then the steps past it); nothing fits: the fall-back signal.
// Candidates are { fits, smallest } with the smallest text in canvas px, in the order fitOceanPanelDetails lists them.
// The runtime reads them lazily with `ordered` (the first that fits is the choice, nothing after it is measured): that
// shortcut is valid only while the ladder is strictly decreasing, which is asserted here against the runtime's lists.
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(repo, 'compiler/assets/runtime/slide-fit.js'), 'utf8')
const { choosePanelArrangement, PANEL_FALL_BACK, PANEL_DETAIL_STEPS, PANEL_DETAIL_STEPS_PAST } = new Function(`${source}; return createSlideFit;`)()().panelChoice
const c = (fits, smallest) => ({ fits, smallest })
// On a 1280px canvas: 1cqw = 12.8px. Ladder sizes as the runtime sets them, the floor 1.9375cqw = 24.8px.
const px = (cqw) => Math.round(cqw * 12.8 * 100) / 100
const LADDER = [3.75, 3.45, 3, 2.5, 2.4, 2.2, 2, 1.9375]

// 1. The arrangement drawn today fits: it is chosen, whatever fits after it.
assert.equal(choosePanelArrangement([c(true, px(3.75)), ...LADDER.slice(1).map((s) => c(true, px(s)))]), 0, 'the size for the count fits: no step')
assert.equal(choosePanelArrangement([c(false, px(3.75)), c(false, px(3.45)), c(true, px(3)), c(true, px(2.5)), c(true, px(2.4)), c(true, px(2.2))]), 2,
  "today's ladder fits at 3cqw: that step, not a smaller one")
assert.equal(choosePanelArrangement([c(false, px(3.45)), c(false, px(3)), c(false, px(2.5)), c(true, px(2.4)), c(true, px(2.2)), c(true, px(2)), c(true, px(1.9375))]), 3,
  "today's last step (2.4cqw) fits: no step past it")

// 2. Nothing on today's ladder fits: the largest step past it that fits.
assert.equal(choosePanelArrangement([c(false, px(3)), c(false, px(2.5)), c(false, px(2.4)), c(true, px(2.2)), c(true, px(2)), c(true, px(1.9375))]), 3, 'first step past the ladder that fits')
assert.equal(choosePanelArrangement([c(false, px(3)), c(false, px(2.5)), c(false, px(2.4)), c(false, px(2.2)), c(false, px(2)), c(true, px(1.9375))]), 5, 'only the floor fits')

// 3. Nothing fits, even at the floor: the fall-back signal (the slide is decided as before).
assert.equal(PANEL_FALL_BACK, -1)
assert.equal(choosePanelArrangement(LADDER.map((s) => c(false, px(s)))), PANEL_FALL_BACK, 'nothing fits: fall back')
assert.equal(choosePanelArrangement([]), PANEL_FALL_BACK, 'no candidates: fall back')

// 4. Ties keep the order: the smallest text on the slide is another text (here a 24.8px line), so every step that fits
// scores the same; the earliest wins (today's arrangement before any step).
assert.equal(choosePanelArrangement([c(true, 24.8), c(true, 24.8), c(true, 24.8)]), 0, 'a tie keeps the first: today')
assert.equal(choosePanelArrangement([c(false, 24.8), c(true, 24.8), c(true, 24.8)]), 1, 'a tie keeps the earlier step')
assert.equal(choosePanelArrangement([c(false, 30), c(true, 28.16), c(true, 28.165)]), 2, 'the exact maximum: 0.005px larger wins')
assert.equal(choosePanelArrangement([c(false, 30), c(true, 28.16), c(true, 28.16)]), 1, 'only equal values keep the order')

// 5. The rule, not the order, decides when the measurements say so: a later candidate with larger smallest text wins
// (cannot happen down the detail ladder, where text only gets smaller, but without `ordered` the function does not
// assume it).
assert.equal(choosePanelArrangement([c(false, 40), c(true, 25.6), c(true, 28.16)]), 2, 'larger smallest text wins over order')
assert.equal(choosePanelArrangement([c(true, 25.6), c(false, 40), c(true, 25.6)]), 0, 'a non-fitting candidate never wins, however large its text')

// 6. The ladder the runtime walks is strictly decreasing (today's steps, then the steps past them, ending at the type
// floor of stage.css), so the smallest text never grows down the list and the first candidate that fits is the maximum.
const ladder = [...PANEL_DETAIL_STEPS, ...PANEL_DETAIL_STEPS_PAST]
assert.deepEqual(ladder, LADDER, 'the runtime ladder is the one this test describes')
ladder.slice(1).forEach((step, i) => assert.ok(step < ladder[i], `the ladder is strictly decreasing: ${ladder[i]}cqw then ${step}cqw`))
assert.equal(ladder[ladder.length - 1], 1.9375, 'the ladder ends at the type floor (stage.css --type-floor, 1.9375cqw)')

// 7. ordered: the same choice as the full rule on every ordered list, reading nothing after the first that fits and no
// smallest text at all (the runtime's measuring loop stops where this stops).
function counted(list) {
  const reads = { fits: 0, smallest: 0, drawn: 0 }
  function* lazy() {
    for (const { fits, smallest } of list) {
      reads.drawn += 1
      yield { get fits() { reads.fits += 1; return fits }, get smallest() { reads.smallest += 1; return smallest } }
    }
  }
  return { reads, lazy }
}
let seed = 7
const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
for (let run = 0; run < 2000; run += 1) {
  const n = Math.floor(random() * 9)
  let size = 48
  const list = Array.from({ length: n }, () => { size -= random() < 0.3 ? 0 : random() * 4; return c(random() < 0.4, Math.round(size * 100) / 100) })
  const { reads, lazy } = counted(list)
  const full = choosePanelArrangement(list)
  const fast = choosePanelArrangement(lazy(), { ordered: true })
  assert.equal(fast, full, `ordered and full agree on ${JSON.stringify(list)}`)
  assert.equal(reads.drawn, fast === PANEL_FALL_BACK ? n : fast + 1, 'ordered draws nothing after the first that fits')
  assert.equal(reads.fits, reads.drawn, 'each drawn candidate is measured once')
  assert.equal(reads.smallest, 0, 'ordered never reads the smallest text')
}
// unordered input still gets the full rule, read lazily too
assert.equal(choosePanelArrangement(counted([c(false, 40), c(true, 25.6), c(true, 28.16)]).lazy()), 2, 'a generator is read like a list')

console.log('test:panel-arrangement: today\'s arrangement where it fits, the largest smallest text past it, equal values in order, fall-back when nothing fits; the ladder strictly decreasing, so the first fit ends the walk')
