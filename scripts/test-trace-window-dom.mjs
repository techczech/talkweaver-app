// =============================================================================
// test:trace-window-dom — 0.41 ticket 11 (ADR-0039: "trace (TalkWeaver's trace design at the scene's larger text;
// scrolls by whole turns, never truncates)"; drawings after/18-trace.html and 18-trace-scroll.html)
//
// Driven in Playwright's headless shell (never the installed Chrome):
//   1. Compiler: each trace turn names its kind (prompt, call with its marked name, result, answer, reasoning, speaker).
//   2. Look: the text is 36/1920 of the stage, mono; the panel is dark with rounded corners; a call's name is bold.
//   3. The deck runtime (the presenter template): a trace much longer than its window, stepped one turn at a time under
//      reveal, then back. At EVERY step: every shown turn is either wholly inside the window or wholly above it (no turn
//      is clipped mid-way), the newest turn is wholly inside, the text is never shrunk and the window keeps its height.
//      The window does move (the trace is longer than the window) and only by whole turns.
//   4. With no mode the last turn is complete and the window starts at a turn's top.
//   5. Paired presenter + audience windows: the presenter's Current pane shows the same window as the audience.
//   6. The handout runtime (buildShareHtml) steps to the same window positions as the deck; with no stepping mode it
//      shows a trace from its top, as it always has.
//   7. Never truncates: a turn taller than the window can be scrolled by hand until every one of its lines has been in
//      the window; so can the start of a long trace shown with no mode.
//   8. Print keeps the trace as it was: the scene look is screen-only.
// =============================================================================

import { strict as assert } from 'node:assert'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { extractStyles, extractSlides } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { traceWindowStart, traceNewestTurn } from '../compiler/assets/runtime/trace-window.js'

// Pure decisions first.
assert.equal(traceWindowStart([0, 100, 200, 300], [80, 180, 280, 380], 250, 1), 0, 'two turns that fit: no move')
assert.equal(traceWindowStart([0, 100, 200, 300], [80, 180, 280, 380], 250, 3), 2, 'the least whole-turn move that shows the newest')
assert.equal(traceWindowStart([0, 100, 200, 300], [80, 180, 280, 380], 250, -1), 0, 'nothing shown: the top')
assert.equal(traceWindowStart([0, 100], [80, 600], 250, 1), 1, 'a turn taller than the window starts at its own top')
assert.equal(traceNewestTurn(['', '', '']), 2, 'no mode: every turn shown, the last is the newest')
assert.equal(traceNewestTurn(['soft', 'current', 'hidden']), 1)
assert.equal(traceNewestTurn(['full', 'full', 'full']), 2)
assert.equal(traceNewestTurn(['hidden', 'hidden']), -1)
assert.equal(traceNewestTurn(['fuzzy', 'fuzzy']), -1)

const TURNS = [
  'user: user', 'Make a chart of monthly visitors from data.csv',
  'model: model → harness', 'read_file({"path": "data.csv"})',
  'harness: harness → model', 'month,visitors', '2026-01,1240', '2026-02,1387', '2026-03,1522', '2026-04,1498',
  'reasoning: model · reasoning', 'The April dip is small; a line chart with a zero baseline shows the trend fairly.',
  'model: model → harness', 'run_python({"file": "plot.py"})',
  'harness: harness → model', 'saved figures/visitors.png',
  'model: model → user', 'Saved figures/visitors.png. It shows steady growth, with a dip in April.',
  'user: user', 'Now add a second line for returning visitors and label both lines at their right end.',
  'model: model → harness', 'read_file({"path": "returning.csv"})',
  'harness: harness → model', 'month,returning', '2026-01,410', '2026-02,455', '2026-03,502', '2026-04,488',
  'model: model → harness', 'run_python({"file": "plot.py", "args": ["--second", "returning.csv"]})',
  'harness: harness → model', 'saved figures/visitors.png',
  'model: model → user', 'Done. Two lines, each labelled at its right end. Returning visitors follow the same April dip.'
]
const TURN_COUNT = 13
const source = [
  '---', 'title: Trace window', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '# Deck', '## Section', '',
  '### Visualise data', '{trace mode=reveal} {id=long}', '', '```trace', ...TURNS, '```', '',
  '### Visualise data again', '{trace} {id=still}', '', '```trace', ...TURNS, '```', '',
  '### Oversized', '{trace mode=reveal} {id=oversized}', '', '```trace', 'model', ...Array(40).fill('x'), '```', '',
  '### Answers', '{trace} {id=answers}', '', '```trace', 'model: model → user', 'Paris (France) is the capital.', 'model: model → harness', 'Paris (France) is the capital.', 'model: model → harness', 'read_file({"path": "a.txt"})', 'model: MODEL → HARNESS', '<tool_call name="list_dir" args={"path": "~/Downloads"}/>', 'model', 'read_file({"path": "b.txt"})', 'model', 'Note(s): read the file.', '```', '',
  '### Dialogue', '{trace} {id=dialogue}', '', '```trace', 'Student: Can I just use the chatbot to write the essay?', 'Tutor: You can. It will cost you exactly the learning the essay was for.', '```', '',
  '### After', '{id=after}', '', 'Plain slide.', ''
].join('\n')
const dir = mkdtempSync(join(tmpdir(), 'tw-trace-window-'))
const outline = join(dir, 'trace.md')
writeFileSync(outline, source, 'utf8')
const model = await prepareSource(outline, source, 'Trace window', statSync(outline))
const deckPath = join(dir, 'deck.html')
const handoutPath = join(dir, 'handout.html')
writeFileSync(deckPath, model.fullHtml, 'utf8')
writeFileSync(handoutPath, buildShareHtml({ title: 'Trace window', slides: extractSlides(model.fullHtml), styles: extractStyles(model.fullHtml), includeNotes: false, slug: 'trace-window' }), 'utf8')

let checks = 0
const ok = (name) => { checks += 1; console.log(`PASS ${name}`) }

// 1. Compiler
{
  const html = model.fullHtml
  const longSlide = html.slice(html.indexOf('data-id="long"'), html.indexOf('data-id="still"'))
  const kinds = [...longSlide.matchAll(/<div class="turn ([a-z-]+)"/g)].map((m) => m[1])
  assert.equal(kinds.length, TURN_COUNT, `the long trace has ${TURN_COUNT} turns (${kinds.length})`)
  assert.deepEqual(kinds.slice(0, 7), ['trace-prompt', 'trace-call', 'trace-result', 'trace-thinking', 'trace-call', 'trace-result', 'trace-answer'])
  assert.match(longSlide, /<span class="trace-fn">read_file<\/span>\(\{&quot;path&quot;/, 'a call marks its name')
  assert.match(html, /<div class="turn trace-speaker"><div class="role speaker-\d">Student<\/div>/, 'any other speaker keeps its bucket class')
  // A turn routed to the user is an answer whatever it starts with; a call is `name(` with no space.
  const answers = html.slice(html.indexOf('data-id="answers"'), html.indexOf('data-id="dialogue"'))
  const answerKinds = [...answers.matchAll(/<div class="turn ([a-z-]+)"/g)].map((m) => m[1])
  // model → user + "Paris (France)…": answer; model → harness + plain text: call (no name to mark); model → harness +
  // read_file(: call; the fixture's <tool_call name="list_dir" …/> (compiler/reference/fixtures.mjs): call; bare model +
  // one call expression: call; bare model + "Note(s): read the file.": prose, an answer.
  assert.deepEqual(answerKinds, ['trace-answer', 'trace-call', 'trace-call', 'trace-call', 'trace-call', 'trace-answer'], `turn kinds on the answers slide (${answerKinds.join(',')})`)
  const answerFns = [...answers.matchAll(/<span class="trace-fn">([^<]*)<\/span>/g)].map((m) => m[1])
  assert.deepEqual(answerFns, ['read_file', 'list_dir', 'read_file'], `marked call names (${answerFns.join(',')})`)
  assert.match(answers, /&lt;tool_call name=&quot;<span class="trace-fn">list_dir<\/span>&quot; args=/, 'a tool_call tag marks its name attribute, escaped')
  ok('compiler: every turn names its kind; a call marks its name; routed to the harness is a call, to the user never')
}

const browser = await chromium.launch({ headless: true })
const errors = []

// Measure the active slide's trace window, in the page or in the presenter's Current pane.
const measure = (page, inFrame = false) => page.evaluate((inFrame) => {
  const doc = inFrame ? document.querySelector('#currentPreview iframe')?.contentDocument : document
  const slide = doc?.querySelector('.slide.active') || doc?.querySelector('.slide')
  const trace = slide?.querySelector('.trace')
  if (!trace) return null
  const stage = slide.parentElement
  const view = doc.defaultView
  const box = trace.getBoundingClientRect()
  const k = box.height / trace.offsetHeight
  // The window: the trace's box inside its top and bottom border (the border is the panel's vertical padding).
  const top = box.top + trace.clientTop * k
  const bottom = top + trace.clientHeight * k
  const turns = [...trace.children].filter((el) => el.classList.contains('turn')).map((el) => {
    const r = el.getBoundingClientRect()
    return { top: r.top, bottom: r.bottom, state: el.getAttribute('data-mode-state') || '' }
  })
  return {
    top, bottom, turns, k,
    start: Number(trace.getAttribute('data-trace-start') || 0),
    scrollTop: trace.scrollTop,
    expected: trace.children[Number(trace.getAttribute('data-trace-start') || 0)].offsetTop - trace.children[0].offsetTop,
    height: trace.offsetHeight,
    tail: trace.style.paddingBottom,
    band: slide.querySelector('.slide-content').clientHeight,
    bodyPx: parseFloat(view.getComputedStyle(trace.querySelector('.body')).fontSize),
    stageW: stage.offsetWidth
  }
}, inFrame)

// No shown turn clipped mid-way; the newest wholly inside the window.
const assertWindow = (m, label) => {
  assert(m, `${label}: a trace is on screen`)
  const eps = 1.5
  const shown = m.turns.map((t, i) => ({ ...t, i })).filter((t) => t.state !== 'hidden')
  for (const t of shown) {
    const inside = t.top >= m.top - eps && t.bottom <= m.bottom + eps
    const above = t.bottom <= m.top + eps
    const below = t.top >= m.bottom - eps
    assert(inside || above || below, `${label}: turn ${t.i + 1} is clipped mid-way (turn ${t.top.toFixed(1)}–${t.bottom.toFixed(1)}, window ${m.top.toFixed(1)}–${m.bottom.toFixed(1)})`)
    if (inside && t.i >= m.start) continue
    if (!inside && t.i >= m.start) assert(below, `${label}: turn ${t.i + 1} after the window start is off the window bottom`)
  }
  const newest = m.turns.findIndex((t) => t.state === 'current')
  const last = newest >= 0 ? newest : m.turns.every((t) => !t.state || t.state === 'full') ? m.turns.length - 1 : -1
  if (last >= 0) {
    const t = m.turns[last]
    assert(t.top >= m.top - eps && t.bottom <= m.bottom + eps, `${label}: the newest turn (${last + 1}) is wholly in the window`)
  }
  // The window starts at a turn's top: the first turn in view sits at the window's top edge.
  const first = m.turns[m.start]
  assert(Math.abs(first.top - m.top) <= eps, `${label}: the window starts at turn ${m.start + 1}'s top (${first.top.toFixed(1)} vs ${m.top.toFixed(1)})`)
  assert(Math.abs(m.scrollTop - m.expected) <= 1, `${label}: the window rests at its whole-turn position (${m.scrollTop} vs ${m.expected})`)
}
const settled = (page, inFrame = false) => page.waitForFunction((inFrame) => {
  const doc = inFrame ? document.querySelector('#currentPreview iframe')?.contentDocument : document
  const trace = (doc?.querySelector('.slide.active') || doc?.querySelector('.slide'))?.querySelector('.trace')
  if (!trace) return false
  const k = Number(trace.getAttribute('data-trace-start') || 0)
  // At rest: no move under way (the runtime clears its tween when the 0.8 s ease ends) and at the whole-turn position.
  return !trace.__twTraceTween && Math.abs(trace.scrollTop - (trace.children[k].offsetTop - trace.children[0].offsetTop)) <= 1
}, inFrame, { timeout: 8000 })

try {
  // 2–3. The deck runtime, with motion (the move eases over 0.8 s; each step waits for it to rest).
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`${pathToFileURL(deckPath).href}#long`)
  await page.waitForTimeout(500)
  await page.evaluate(() => document.fonts?.ready)
  const look = await page.evaluate(() => {
    const t = document.querySelector('.slide.active .trace')
    const cs = getComputedStyle(t)
    return { bg: cs.backgroundColor, radius: parseFloat(cs.borderTopLeftRadius), family: cs.fontFamily, fn: getComputedStyle(t.querySelector('.trace-fn')).fontWeight, label: getComputedStyle(t.querySelector('.role')).textTransform }
  })
  assert.equal(look.bg, 'rgb(11, 14, 19)', 'the panel is the terminal ground')
  assert(look.radius > 5, 'the panel has rounded corners')
  assert.match(look.family, /mono|Menlo|SF Mono|Consolas/i, 'the transcript is mono')
  assert(parseInt(look.fn, 10) >= 700, "a call's name is bold")
  assert.equal(look.label, 'uppercase', 'route labels are capitals')
  const arrival = await measure(page)
  assert(Math.abs(arrival.bodyPx - arrival.stageW * 36 / 1920) < 0.6, `text at 36/1920 of the stage (${arrival.bodyPx.toFixed(1)}px on ${arrival.stageW})`)
  assert(arrival.turns.every((t) => t.state === 'hidden'), 'authored reveal: arrival shows no turn')
  assert.equal(arrival.start, 0, 'arrival: the window at the top')
  ok('look: 36/1920 mono text on the dark rounded panel; bold call names; capital route labels')

  const deckStarts = []
  let moved = 0
  for (let step = 1; step <= TURN_COUNT; step++) {
    await page.keyboard.press('ArrowRight')
    await settled(page)
    await page.waitForTimeout(60)
    const m = await measure(page)
    assert.equal(m.turns.filter((t) => t.state !== 'hidden').length, step, `step ${step}: ${step} turns shown`)
    assertWindow(m, `deck step ${step}`)
    assert(Math.abs(m.bodyPx - arrival.bodyPx) < 0.01, `step ${step}: the text is never shrunk`)
    assert(Math.abs(m.height - arrival.height) < 0.5, `step ${step}: the window keeps its height`)
    if (deckStarts.length && m.start !== deckStarts.at(-1)) moved += 1
    deckStarts.push(m.start)
  }
  assert(deckStarts.at(-1) > 0, `the trace is longer than its window (final start ${deckStarts.at(-1)})`)
  assert(moved >= 2, `the window moved up by whole turns more than once (${deckStarts.join(',')})`)
  assert(deckStarts.every((s, i) => i === 0 || s >= deckStarts[i - 1]), `stepping on never moves the window down (${deckStarts.join(',')})`)
  ok(`deck: ${TURN_COUNT} steps, no turn clipped mid-way, the newest always whole (window starts ${deckStarts.join(',')})`)

  // The closing "all full" step, then back down every step.
  await page.keyboard.press('ArrowRight'); await settled(page)
  assertWindow(await measure(page), 'deck full step')
  await page.keyboard.press('ArrowLeft'); await settled(page)
  for (let step = TURN_COUNT; step >= 1; step--) {
    const m = await measure(page)
    assertWindow(m, `deck back at step ${step}`)
    assert.equal(m.start, deckStarts[step - 1], `back at step ${step}: the window sits where it did on the way on`)
    await page.keyboard.press('ArrowLeft'); await settled(page)
  }
  assert.equal((await measure(page)).start, 0, 'back at step 0: the window at the top')
  ok('deck: stepping back puts the window where each step had it')

  // 4. No mode: the end of the trace, whole turns.
  await page.evaluate(() => { location.hash = 'still' })
  await page.waitForTimeout(500)
  await settled(page)
  const still = await measure(page)
  assert(still.turns.every((t) => !t.state), 'no mode: no turn carries a state')
  assertWindow(still, 'no mode')
  assert(still.start > 0, 'no mode: the window shows the end of a long trace')
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.slide.active .trace')).overflowY), 'auto', 'no mode: the turns above the window can be scrolled to by hand')
  await page.evaluate(() => { location.hash = 'dialogue' })
  await page.waitForTimeout(400)
  const dialogue = await measure(page)
  assertWindow(dialogue, 'short dialogue')
  assert.equal(dialogue.start, 0, 'a trace that fits does not move')
  assert.equal(dialogue.tail, '', 'a trace that fits gets no room under its last turn')
  assert(dialogue.height < dialogue.band * 0.8, `a short trace is sized to its turns, not the band (${dialogue.height} of ${dialogue.band})`)
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.slide.active .trace')).overflowY), 'hidden', 'a trace that fits does not scroll by hand')
  ok('deck: with no mode the last turn is whole and the window starts on a turn; a short trace stays put')

  // 7. A turn taller than the window: every line of it is in the window at some point (review fix: never truncates).
  await page.evaluate(() => { location.hash = 'oversized' })
  await page.waitForTimeout(500)
  await page.keyboard.press('ArrowRight')
  await settled(page)
  const linesInWindow = () => page.evaluate(() => {
    const trace = document.querySelector('.slide.active .trace')
    const box = trace.getBoundingClientRect()
    const k = box.height / trace.offsetHeight
    const top = box.top + trace.clientTop * k
    const bottom = top + trace.clientHeight * k
    const text = trace.querySelector('.turn .body').firstChild
    const seen = []
    for (let i = 0; i * 2 < text.length; i++) {
      const r = document.createRange()
      r.setStart(text, i * 2); r.setEnd(text, i * 2 + 1)
      const rect = r.getBoundingClientRect()
      if (rect.top >= top - 1.5 && rect.bottom <= bottom + 1.5) seen.push(i)
    }
    const turn = trace.querySelector('.turn').getBoundingClientRect()
    return { seen, lines: Math.ceil(text.length / 2), taller: turn.height > bottom - top, cx: box.left + box.width / 2, cy: box.top + box.height / 2, scrollTop: trace.scrollTop }
  })
  let probe = await linesInWindow()
  assert.equal(probe.lines, 40, 'the oversized turn has 40 lines')
  assert(probe.taller, 'the oversized turn is taller than the window')
  const seenLines = new Set(probe.seen)
  await page.mouse.move(probe.cx, probe.cy)
  for (let i = 0; i < 60 && seenLines.size < probe.lines; i++) {
    const before = probe.scrollTop
    await page.mouse.wheel(0, 120)
    await page.waitForTimeout(80)
    probe = await linesInWindow()
    probe.seen.forEach((n) => seenLines.add(n))
    if (probe.scrollTop === before && i > 2) break
  }
  const missing = [...Array(probe.lines).keys()].filter((n) => !seenLines.has(n))
  assert.deepEqual(missing, [], `every line of a turn taller than the window can be brought into the window (never seen: ${missing.join(',')})`)
  // The next step puts the window back at its whole-turn position.
  assert(probe.scrollTop > 0, `the window was scrolled down by hand (${probe.scrollTop})`)
  const atRest = () => page.waitForFunction(() => !document.querySelector('.slide.active .trace').__twTraceTween, null, { timeout: 8000 })
  const windowState = () => page.evaluate(() => {
    const t = document.querySelector('.slide.active .trace')
    return { scrollTop: t.scrollTop, start: t.getAttribute('data-trace-start'), state: t.querySelector('.turn').getAttribute('data-mode-state') }
  })
  await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(100); await atRest()
  const back = await windowState()
  assert.equal(back.state, 'hidden', 'step back: the oversized turn is hidden')
  assert.equal(back.start, '0', 'step back: the window starts at the first turn')
  assert(back.scrollTop <= 1, `step back: the window is back at the top (${back.scrollTop})`)
  await page.mouse.wheel(0, 400); await page.waitForTimeout(150)
  assert((await windowState()).scrollTop > 1, 'at step 0 the window can be scrolled down by hand again')
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(100); await atRest()
  const on = await windowState()
  assert.notEqual(on.state, 'hidden', `step on: the oversized turn is shown (${on.state}; a lone unit is "full")`)
  assert.equal(on.start, '0', 'step on: the window starts at the oversized turn')
  assert(on.scrollTop <= 1, `step on: the window is at the oversized turn's top, not where it was scrolled (${on.scrollTop})`)
  ok('deck: every line of a turn taller than the window can be scrolled into it by hand')
  await page.close()

  // 5. Paired presenter + audience: the Current pane shows the audience's window.
  {
    const ORIGIN = 'https://trace-window.example.test/'
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' })
    await context.route(`${ORIGIN}**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: model.fullHtml }))
    const openPaired = async (query, id) => {
      const p = await context.newPage()
      p.on('pageerror', (e) => errors.push(`${query}: ${e}`))
      await p.goto(`${ORIGIN}deck.html?${query}#${id}`)
      await p.waitForTimeout(500)
      return p
    }
    const presenter = await openPaired('presenter=1&session=trace-pair', 'long')
    const audience = await openPaired('audience=1&session=trace-pair', 'long')
    for (let step = 1; step <= TURN_COUNT; step++) {
      await presenter.keyboard.press('ArrowRight')
      await audience.waitForFunction((n) => [...document.querySelectorAll('.slide.active .trace .turn')].filter((t) => t.getAttribute('data-mode-state') !== 'hidden').length === n, step, { timeout: 8000 })
      await settled(audience)
      await presenter.waitForFunction((n) => {
        const doc = document.querySelector('#currentPreview iframe')?.contentDocument
        const turns = [...(doc?.querySelectorAll('.slide .trace .turn') || [])]
        return turns.length > 0 && turns.filter((t) => t.getAttribute('data-mode-state') !== 'hidden').length === n
      }, step, { timeout: 8000 })
      await settled(presenter, true)
      const a = await measure(audience)
      const p = await measure(presenter, true)
      assertWindow(a, `audience step ${step}`)
      assertWindow(p, `presenter pane step ${step}`)
      assert.equal(a.start, deckStarts[step - 1], `audience step ${step}: the window the deck had`)
      assert.equal(p.start, a.start, `presenter pane step ${step}: the window the audience has`)
    }
    ok("paired windows: the presenter's Current pane shows the audience's window at every step")
    await context.close()
  }

  // 6. The handout runtime: Reveal, then the same steps.
  {
    const h = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' })
    h.on('pageerror', (e) => errors.push(`handout: ${e}`))
    // With no stepping mode the handout shows a long trace from its top, as it did before the trace window.
    await h.goto(`${pathToFileURL(handoutPath).href}#still`)
    await h.waitForTimeout(600)
    const plain = await h.evaluate(() => {
      const t = document.querySelector('.slide.active .trace')
      return { scrollTop: t.scrollTop, start: t.getAttribute('data-trace-start'), pad: t.style.paddingBottom, active: t.closest('.slide').classList.contains('mode-active'), scrollable: t.scrollHeight > t.clientHeight + 1 }
    })
    assert(!plain.active, 'handout #still: no stepping mode on')
    assert(plain.scrollable, 'handout #still: the trace is longer than its window')
    assert.equal(plain.scrollTop, 0, 'handout with no stepping mode: the trace starts at its top')
    assert.equal(plain.start, null, 'handout with no stepping mode: no window is placed')
    assert.equal(plain.pad, '', 'handout with no stepping mode: no room added under the last turn')
    ok('handout: with no stepping mode a long trace starts at its top')
    await h.goto(`${pathToFileURL(handoutPath).href}#long`)
    await h.waitForTimeout(500)
    const scrollable = await h.evaluate(() => getComputedStyle(document.querySelector('.slide.active .trace')).overflowY)
    assert.equal(scrollable, 'auto', 'the handout keeps the trace a scroll box a reader can scroll by hand')
    const enterReveal = await h.evaluate(() => document.querySelector('.slide.active .trace .turn')?.getAttribute('data-mode-state') === 'hidden')
    if (!enterReveal) { await h.click('#revealBtn'); await h.waitForTimeout(200) }
    const starts = []
    for (let step = 1; step <= TURN_COUNT; step++) {
      await h.keyboard.press('ArrowRight')
      await h.waitForFunction((n) => [...document.querySelectorAll('.slide.active .trace .turn')].filter((t) => t.getAttribute('data-mode-state') !== 'hidden').length === n, step, { timeout: 8000 })
      await settled(h)
      const m = await measure(h)
      assertWindow(m, `handout step ${step}`)
      starts.push(m.start)
    }
    assert.deepEqual(starts, deckStarts, 'the handout steps the window to the same turns as the deck')
    ok('handout: the same whole-turn window at every step as the deck')
    await h.close()
  }

  // 8. Print: the scene look is screen-only, so a printed trace has none of it (no prompt box, no ">" marker, the
  // old panel geometry and scroll box from base.css).
  {
    const pp = await browser.newPage({ viewport: { width: 1600, height: 900 } })
    pp.on('pageerror', (e) => errors.push(`print: ${e}`))
    await pp.goto(`${pathToFileURL(handoutPath).href}#long`)
    await pp.waitForTimeout(400)
    const screenLook = await pp.evaluate(() => getComputedStyle(document.querySelector('.trace .trace-prompt .body'), '::before').content)
    await pp.emulateMedia({ media: 'print' })
    const printLook = await pp.evaluate(() => {
      const t = document.querySelector('.trace')
      const cs = getComputedStyle(t)
      return {
        before: getComputedStyle(t.querySelector('.trace-prompt .body'), '::before').content,
        promptBorder: getComputedStyle(t.querySelector('.trace-prompt .body')).borderTopStyle,
        bg: cs.backgroundColor
      }
    })
    assert.equal(screenLook, '">"', 'on screen the prompt is led by ">"')
    assert.equal(printLook.before, 'none', 'in print the prompt has no generated ">"')
    assert.equal(printLook.promptBorder, 'none', 'in print the prompt has no box')
    assert.notEqual(printLook.bg, 'rgb(11, 14, 19)', 'in print the panel is not the scene terminal ground')
    ok('print: the trace keeps its earlier look (the scene look is screen-only)')
    await pp.close()
  }

  assert.deepEqual(errors, [], `no page errors: ${errors.join(' | ')}`)
} finally {
  await browser.close()
}
console.log(`test:trace-window-dom: ${checks} checks passed`)
