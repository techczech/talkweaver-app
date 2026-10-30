// Layout Doctor, plain view ticket 15: the open panel reads the outline for stranded title icons
// only once the typing has paused.
//
// That reading uses the compiler's facts (tens of milliseconds on a long talk). The panel is handed
// every text the editor produces while it is open, so it must not read each one: the reading runs
// from a timer once the text has been unchanged for the workspace's compile pause, and never during
// a render (src/renderer/src/lib/pausedScan.ts, used by LayoutDoctorPanel.tsx).
//
// 1. The schedule, with the clock passed in: 25 texts one after another cause no reading until the
//    pause has passed, then exactly one, of the last text. A text handed over again does not start
//    the pause again; going back to the text already read owes nothing; closing drops what waits.
// 2. The panel, by its source: the stranded-icon reading is made only through the schedule, the
//    trigger findings are still read at once, a row's button is off while a newer text waits, and
//    the workspace's compile uses the same pause.
//
//   node scripts/test-layout-doctor-paused-icon-scan.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { scanOutlineTriggers } from '../src/shared/layout-doctor.ts'
import { createPausedScan, OUTLINE_PAUSE_MS } from '../src/renderer/src/lib/pausedScan.ts'

/** A clock that moves only when told to. */
function clock() {
  let now = 0
  let next = 1
  const due = new Map()
  return {
    timers: {
      set: (run, ms) => { const id = next; next += 1; due.set(id, { at: now + ms, run }); return id },
      clear: (id) => { due.delete(id) }
    },
    advance(ms) {
      const until = now + ms
      for (;;) {
        const [id, timer] = [...due].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0] ?? []
        if (id === undefined) break
        due.delete(id)
        now = timer.at
        timer.run()
      }
      now = until
    },
    waiting: () => due.size
  }
}

const outline = (word) => ['# Talk', '', '## Part', '{id=part}', '', '### Title', '{icon=lucide:star} {id=t1}', `Text ${word}.`, ''].join('\n')
/** The panel's own reading (LayoutDoctorPanel.tsx strandedTitleIconFindings), counted. */
function reader() {
  const read = []
  const results = []
  const scan = (text) => {
    read.push(text)
    return scanOutlineTriggers(text, undefined, { strandedTitleIcons: true }).filter((finding) => finding.kind === 'stranded-title-icon')
  }
  return { read, results, scan, onResult: (text, result) => results.push({ text, result }) }
}

assert.equal(OUTLINE_PAUSE_MS, 900, 'the pause is the workspace\'s compile pause')

// ── 1. The schedule ─────────────────────────────────────────────────────────────────────────────
{
  const time = clock()
  const r = reader()
  const schedule = createPausedScan({ scan: r.scan, onResult: r.onResult, pauseMs: OUTLINE_PAUSE_MS, timers: time.timers })
  const UPDATES = 25
  let text = ''
  for (let n = 1; n <= UPDATES; n += 1) {
    text = outline(`v${n}`)
    schedule.update(text)
    time.advance(40) // a keystroke every 40 ms
    assert.equal(r.read.length, 0, `no reading after text ${n}`)
    assert.equal(time.waiting(), 1, 'one timer waits, never one for each text')
  }
  assert.equal(schedule.pending(), true)
  time.advance(OUTLINE_PAUSE_MS - 41)
  assert.equal(r.read.length, 0, 'no reading one millisecond before the pause has passed')
  time.advance(1)
  assert.deepEqual(r.read, [text], 'exactly one reading, of the last text')
  assert.deepEqual(r.results.map((entry) => [entry.text, entry.result.map((finding) => [finding.kind, finding.headingLine, finding.token])]), [[text, [['stranded-title-icon', 6, 'icon=lucide:star']]]], 'handed over with the text it was read from')
  assert.equal(schedule.pending(), false)
  time.advance(10 * OUTLINE_PAUSE_MS)
  assert.equal(r.read.length, 1, 'and no reading after it')

  // The same text handed over again (a render for another reason) does not start the pause again.
  const newer = outline('newer')
  schedule.update(newer)
  time.advance(OUTLINE_PAUSE_MS - 100)
  schedule.update(newer)
  time.advance(100)
  assert.deepEqual(r.read, [text, newer], 'the pause ran from the first time the text was handed over')

  // Back at the text already read before the pause has passed (typing undone): nothing is owed.
  schedule.update(outline('typed and undone'))
  time.advance(200)
  schedule.update(newer)
  assert.deepEqual([schedule.pending(), time.waiting()], [false, 0])
  time.advance(10 * OUTLINE_PAUSE_MS)
  assert.equal(r.read.length, 2, 'the text already read is not read again')

  // Closed while a text waits: it is never read; opened again, the text is read after the pause.
  schedule.update(outline('waiting'))
  schedule.cancel()
  time.advance(10 * OUTLINE_PAUSE_MS)
  assert.deepEqual([r.read.length, schedule.pending(), time.waiting()], [2, false, 0], 'closing drops the waiting text')
  schedule.update(newer)
  time.advance(OUTLINE_PAUSE_MS)
  assert.deepEqual(r.read, [text, newer, newer], 'after closing, the last reading is forgotten')
}

// ── 2. The panel and the workspace, by their source ─────────────────────────────────────────────
const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
{
  const panel = source('src/renderer/src/components/LayoutDoctorPanel.tsx')
  assert.equal(panel.split('strandedTitleIcons: true').length - 1, 1, 'the stranded-icon reading is asked for in one place')
  assert.match(panel, /function strandedTitleIconFindings\(text: string\): LayoutDoctorFinding\[\] \{\n {2}return scanOutlineTriggers\(text, undefined, \{ strandedTitleIcons: true \}\)/, 'in the function the schedule calls')
  assert.equal(panel.split('strandedTitleIconFindings').length - 1, 2, 'which is named once more only: where it is given to the schedule')
  assert.match(panel, /usePausedScan\(isOpen \? outlineText : null, strandedTitleIconFindings, talk\.outlinePath\)/, 'the schedule is given the open talk\'s text, and nothing while the panel is closed')
  assert.match(panel, /useMemo\(\n\s*\(\) => \(isOpen \? scanOutlineTriggers\(outlineText\) : \[\]\),/, 'the trigger findings are read at once, without the stranded-icon reading')
  assert.match(panel, /fixWaiting=\{stranded\.pending\}/, 'a row is told when a newer text is waiting')
  assert.match(panel, /disabled=\{fixing \|\| fixWaiting\}/, 'and its button is off meanwhile')
  assert.match(panel, /text: strandedText \}/, 'a fix is bound to the text the rows were read from, not to the newest text')

  const hook = source('src/renderer/src/lib/pausedScan.ts')
  assert.match(hook, /export function usePausedScan[\s\S]*useEffect\(\(\) => \{[\s\S]*createPausedScan/, 'the hook makes its readings through the schedule, from an effect')
  assert.doesNotMatch(hook, /useMemo|useLayoutEffect/, 'never during a render')

  const workspace = source('src/renderer/src/components/WorkspaceLayout.tsx')
  assert.match(workspace, /const pause = gridModeRef\.current \|\| compileImmediatelyRef\.current \|\| !compileAttemptedRef\.current \? 0 : OUTLINE_PAUSE_MS/, 'ordinary typing uses the same pause; opening and deliberate moves compile immediately')
  assert.match(workspace, /compileTimer\.current = setTimeout\(async \(\) => \{[\s\S]*?\n {4}\}, pause\)\n/, 'the workspace applies its selected pause')
}

console.log('PASS test-layout-doctor-paused-icon-scan (25 texts: no reading until the pause has passed, then one, of the last text)')
