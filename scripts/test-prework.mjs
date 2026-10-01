// Ticket 08 (ADR-0032 amendment point 5): the talk's pre-work section.
//
//   1. The pre-work definition, read from the outline (prework.mjs): steps, kinds, settings, the
//      quick check's right answer, and what is wrong with the pre-work as written.
//   2. The compiler builds the same definition (model.prework) with every slide the section emits,
//      and keeps the right answer away from everything the audience gets.
//   3. Writing the right answer (the Inspector's Quick check section).
//   4. Presenting skips the pre-work steps (src/main/pathways.ts withoutPresenterSlides).
import { strict as assert } from 'node:assert'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyRightAnswerToOutline, preworkFindings, preworkFromOutline, resultsSteps, takeRightMarkers
} from '../compiler/scripts/lib/prework.mjs'
import { parseOutlineTree } from '../compiler/scripts/lib/14-outline-tree.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildPerSlideProjections } from '../compiler/scripts/lib/10-projections.mjs'
import { parseSlideScript } from '../compiler/scripts/lib/slide-script.mjs'
import { injectPathwayRuntime, injectPresenterNotice, presentStartOutsidePrework, withoutPresenterSlides } from '../src/main/pathways.ts'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { normalisePreworkStatus, preworkStatusUrl } from '../compiler/assets/runtime/prework-status.js'
import { publicPreworkForm } from '../src/shared/run-prework.ts'
import { JSDOM, VirtualConsole } from 'jsdom'

const talk = [
  '---',
  'title: Pre-work fixture',
  'auto_title_slide: false',
  'auto_thanks_slide: false',
  '---',
  '',
  '## Opening',
  '{id=open}',
  '',
  '### Why we are here',
  '{id=why}',
  '',
  'Text.',
  '',
  '## Before the session',
  '{id=pwform}{prework}',
  '',
  'Four short steps. About 20 minutes in all.',
  '',
  '### Welcome: three things before Monday',
  '{id=pwwelcome}{noask}',
  '',
  '- Read two short slides',
  '',
  '### Quick check: what makes something an agent?',
  '{poll=single}{id=pwquiz}{check}',
  '',
  '- It answers questions in full sentences',
  '- It uses tools to carry out steps for you {right}',
  '- Not sure yet',
  '',
  '### What AI tools do you already use?',
  '{poll=multiple}{id=pwtools}',
  '',
  '- ChatGPT',
  '- Copilot',
  '',
  '### Task 1: draft one real email with Copilot',
  '{id=pwtask1}{task}{minutes=20}',
  '',
  '- Pick an email you need to send this week',
  '',
  '## Your turn',
  '{id=turn}',
  '',
  '### What AI tools do you already use?',
  '{id=r1tools}{results=pwtools}',
  '',
  '- The room adds to the answers',
  ''
].join('\n')

// ── 1. The definition ──────────────────────────────────────────────────────────────────────
const definition = preworkFromOutline(talk)
assert.ok(definition, 'a {prework} section is the pre-work form')
assert.equal(definition.sectionId, 'pwform')
assert.equal(definition.title, 'Before the session')
assert.equal(definition.intro, 'Four short steps. About 20 minutes in all.', 'the section’s paragraph is the introduction')
assert.equal(definition.sourceLine, 15, 'source lines are outline lines (front matter counted)')
assert.deepEqual(definition.steps.map((step) => [step.n, step.id, step.kind]), [
  [1, 'pwwelcome', 'slide'], [2, 'pwquiz', 'check'], [3, 'pwtools', 'question'], [4, 'pwtask1', 'task']
], 'the section’s slides are the steps, in outline order, each of one kind')
const [welcome, quiz, tools, task] = definition.steps
assert.equal(welcome.questions, false, '{noask} turns questions about a step off')
assert.equal(quiz.questions, true, 'questions are on by default')
assert.deepEqual(quiz.options, ['It answers questions in full sentences', 'It uses tools to carry out steps for you', 'Not sure yet'])
assert.deepEqual(quiz.right, { index: 1, label: 'It uses tools to carry out steps for you' }, 'the {right} option is the right answer')
assert.equal(quiz.pollType, 'single')
assert.equal(tools.pollType, 'multiple')
assert.deepEqual([task.done, task.minutes], [true, 20], 'a bare {task} asks for Mark as done (drawing E3); {minutes=…} is the time it takes')
assert.deepEqual(resultsSteps(definition).map((step) => step.id), ['pwquiz', 'pwtools', 'pwtask1'], 'a talk slide can show a check, a question or a task, never a plain slide')

const minimal = preworkFromOutline('## Before\n{prework}\n\n### A task\n{task}\n\n- Do it\n### Read only task\n{task}{readonly}\n### Read\n')
assert.deepEqual(minimal.steps.map((step) => [step.id, step.kind, step.done, step.minutes]),
  [['a-task', 'task', true, 10], ['read-only-task', 'task', false, 10], ['read', 'slide', undefined, undefined]],
  'defaults: a task is marked done and takes 10 minutes; {readonly} makes it read only; a heading without an id takes the compiler’s fallback id')

// The ticket-07 detection rules the app relied on hold for the definition too.
assert.equal(preworkFromOutline(''), null)
assert.equal(preworkFromOutline('## One\n{id=a}\n\n{prework}\n'), null, 'a token that is not on the trigger line does not count')
assert.equal(preworkFromOutline('## Before\n{results=prework-q1}\n'), null, 'a value that merely contains "prework" does not count')
assert.equal(preworkFromOutline('## Before\nWe use {prework} next week.\n'), null, 'prose is not a trigger line')
assert.equal(preworkFromOutline('### Deeper\n{prework}\n\n#### a\n'), null, 'only a ## section is the pre-work section')
assert.equal(preworkFromOutline('## Before {prework}\n\n### a\n').steps.length, 1, 'the token may ride the heading')
assert.equal(preworkFromOutline('## Before\n\n{prework}\n### a').steps.length, 1, 'blank lines before the trigger line are tolerated')
assert.equal(preworkFromOutline('## Before\r\n{prework}\r\n### a\r\n').steps.length, 1, 'CRLF outlines work')
assert.equal(preworkFromOutline('```\n## Fenced\n{prework}\n```\n## Real\n{id=r}\n'), null, 'fenced headings are code')
assert.equal(preworkFromOutline('## Before\n{prework}\n\n```\n### not a step\n```\n### a\n').steps.length, 1, 'a heading in a fence is not a step')
assert.equal(preworkFromOutline('## Before\n{prework}\n<!--\n### commented out\n-->\n### a\n').steps.length, 1, 'a commented-out heading is not a step')

// What is wrong with the pre-work as written.
const findingsOf = (text) => preworkFindings(parseOutlineTree(text).root).map((f) => [f.code, f.slideId, f.detail])
assert.deepEqual(findingsOf(talk), [], 'the fixture is clean')
assert.deepEqual(findingsOf([
  '## Talk', '{id=t}', '', '### Stray', '{id=stray}{task}{noask}', '',
  '## Before', '{id=pw}{prework}', '',
  '### Check', '{id=c1}{poll=multiple}{check}', '', '- A {right}', '- B {right}', '',
  '### Check two', '{id=c2}{poll=single}{check}', '', '- A', '- B', '',
  '### Read only alone', '{id=d1}{readonly}', '',
  '### Odd time', '{id=m1}{task}{minutes=15}', '',
  '### Misplaced', '{id=c3}{poll=single}{check}', '', '- {right} First', '- Second', '  - a hint {right}', '',
  '### Both', '{id=b1}{task}{poll=open}', '',
  '## Before again', '{id=pw2}{prework}', '',
  '## After', '{id=after}', '', '### Shows', '{id=s1}{results=nope}', '', '### Shows a step', '{id=s2}{results=c2}'
].join('\n')), [
  ['prework-section-duplicate', 'pw2', 'Before again'],
  ['prework-token-outside', 'stray', 'task'],
  ['prework-token-outside', 'stray', 'noask'],
  ['prework-check-not-single', 'c1', 'multiple'],
  ['prework-check-right-many', 'c1', '2'],
  ['prework-check-right-missing', 'c2', ''],
  ['prework-readonly-without-task', 'd1', 'readonly'],
  ['prework-minutes-invalid', 'm1', 'minutes=15'],
  ['prework-check-right-many', 'c3', '2'],
  ['prework-right-misplaced', 'c3', '2'],
  ['prework-kind-conflict', 'b1', 'poll'],
  ['prework-results-unknown', 's1', 'nope']
], 'every mistake is named on its slide')
assert.deepEqual(findingsOf('## Before\n{id=pw}{prework}\n\nJust an intro.\n'), [['prework-section-empty', 'pw', 'Before']])

// The {right} marker leaves what participants see.
const taken = takeRightMarkers(['', '- A', '- B {right}', '  - a hint {right}', '', '```', '- C {right}', '```', 'After {right}.', '- D {Right }'])
assert.deepEqual(taken.lines, ['', '- A', '- B', '  - a hint', '', '```', '- C {right}', '```', 'After.', '- D'], 'every marker outside code goes, at any indent and in any line; code is left alone')
assert.deepEqual(taken.options.map((option) => [option.label, option.right]), [['A', false], ['B', true]], 'the options are the first list only')
assert.deepEqual([taken.rightCount, taken.misplaced], [4, 3], 'every marker counts; only the one at the end of an option is where the Inspector writes it')
// Fix round S1: the marker at the start, in the middle, on an indented or a numbered item never survives.
for (const [shape, expected] of [
  [['- {right} Marker first', '- Other'], { lines: ['- Marker first', '- Other'], right: 0, misplaced: 1 }],
  [['- Mid {right} line', '- Other'], { lines: ['- Mid line', '- Other'], right: 0, misplaced: 1 }],
  [['- One', '  - Indented {right}'], { lines: ['- One', '  - Indented'], right: -1, misplaced: 1 }],
  [['1. One', '2. Two {right}'], { lines: ['1. One', '2. Two'], right: 1, misplaced: 0 }],
  [['- One {right} {right}', '- Two'], { lines: ['- One', '- Two'], right: 0, misplaced: 2 }]
]) {
  const result = takeRightMarkers(shape)
  assert.deepEqual(result.lines, expected.lines, `${shape.join(' | ')}: stripped`)
  assert.equal(result.options.findIndex((option) => option.right), expected.right, `${shape.join(' | ')}: right option`)
  assert.equal(result.misplaced, expected.misplaced, `${shape.join(' | ')}: misplaced count`)
  assert.equal(JSON.stringify(result.options).includes('right}'), false, `${shape.join(' | ')}: no marker in the options`)
}

// ── 2. The compiler ────────────────────────────────────────────────────────────────────────
const scratch = mkdtempSync(join(tmpdir(), 'tw-prework-'))
const outlinePath = join(scratch, 'prework-fixture-outline.md')
writeFileSync(outlinePath, talk, 'utf8')
const model = await prepareSource(outlinePath, talk, 'prework-fixture', statSync(outlinePath))
assert.deepEqual(model.warnings.filter((warning) => /^(prework|unknown-trigger|unresolved-trigger|section-only)/.test(warning)), [],
  'every pre-work token is registered: no unknown or unresolved trigger')
// `feeds` (the board slides a step feeds, with the compiler's slide ids) is compiled-model only, like `slideIds`.
const { slideIds, feeds: compiledFeeds, ...compiledDefinition } = model.prework
assert.ok(Array.isArray(compiledFeeds), 'the compiled model lists the board slides steps feed')
assert.deepEqual(compiledDefinition, definition, 'the compiler’s definition is the one the app reads')
assert.deepEqual(slideIds, ['pwform', 'pwwelcome', 'pwquiz', 'pwtools', 'pwtask1'], 'the section’s own slide and its steps')
const quizSlide = model.slides.find((slide) => slide.id === 'pwquiz')
assert.deepEqual(quizSlide.poll.options.map((option) => option.label), quiz.options, 'the check’s poll offers the options without the marker')
assert.equal(JSON.stringify(quizSlide.poll).includes('right'), false, 'the poll definition carries no right answer')
assert.equal(model.fullHtml.includes('{right}'), false, 'the compiled deck never shows the marker')
assert.equal(JSON.stringify(parseSlideScript(quizSlide.scriptSourceMarkdown)).includes('{right}'), false, 'nor does the text the phone reads')
assert.equal(quizSlide.sourceMarkdown.includes('{right}'), false, 'fix round S2: the slide’s source in the model carries no marker either')
assert.equal(JSON.stringify(buildPerSlideProjections(model, 'prework-fixture')).includes('{right}'), false, 'nor does any projection row')

// Fix round S1: every placement of the marker, compiled — none reaches the poll, the deck or the phone.
for (const [label, items] of [
  ['start', ['- {right} Marker first', '- Other']],
  ['middle', ['- Mid {right} line', '- Other']],
  ['indented', ['- One', '  - Indented {right}', '- Two']],
  ['numbered', ['1. One', '2. Two {right}']],
  ['spaced', ['- One', '- Two {  RIGHT }']]
]) {
  const outline = ['---', 'title: Shapes', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
    '## Before', '{id=pw}{prework}', '', '### Check', '{id=c}{poll=single}{check}', '', ...items, ''].join('\n')
  const shaped = await prepareSource(outlinePath, outline, 'shapes', statSync(outlinePath))
  const check = shaped.slides.find((slide) => slide.id === 'c')
  assert.equal(/\{\s*right\s*\}/i.test(JSON.stringify(check.poll)), false, `${label}: no marker in the poll options`)
  assert.equal(/\{\s*right\s*\}/i.test(shaped.fullHtml), false, `${label}: no marker in the deck HTML`)
  assert.equal(/\{\s*right\s*\}/i.test(JSON.stringify(parseSlideScript(check.scriptSourceMarkdown))), false, `${label}: no marker in the phone text`)
  assert.equal(/\{\s*right\s*\}/i.test(check.sourceMarkdown), false, `${label}: no marker in the model source`)
  const placed = label === 'numbered' || label === 'spaced'
  assert.equal(shaped.warnings.some((warning) => warning.startsWith('prework-right-misplaced:c')), !placed, `${label}: ${placed ? 'written where the Inspector writes it' : 'reported as misplaced'}`)
}
const rows = buildPerSlideProjections(model, 'prework-fixture')
assert.deepEqual(rows.find((row) => row.slide_id === 'r1tools').warnings, [], 'a {results=} slide naming a step is clean')

const badOutline = talk.replace('{results=pwtools}', '{results=pwgone}')
const badModel = await prepareSource(outlinePath, badOutline, 'prework-fixture', statSync(outlinePath), undefined, { projectionsOnly: true })
assert.deepEqual(badModel.warnings.filter((warning) => warning.startsWith('prework')), ['prework-results-unknown:r1tools:pwgone'])
const plain = await prepareSource(outlinePath, '## A\n{id=a}\n\n### B\n{id=b}\n\nText.\n', 'plain', statSync(outlinePath), undefined, { projectionsOnly: true })
assert.equal('prework' in plain, false, 'a talk without pre-work has no definition')

// ── 3. Writing the right answer ────────────────────────────────────────────────────────────
const quizLine = talk.split('\n').findIndex((line) => line.startsWith('### Quick check')) + 1
const moved = applyRightAnswerToOutline(talk, quizLine, 2)
assert.deepEqual(preworkFromOutline(moved).steps[1].right, { index: 2, label: 'Not sure yet' }, 'choosing an option moves the marker')
assert.equal(moved.split('\n').filter((line) => line.includes('{right}')).length, 1, 'one option carries it')
assert.equal(applyRightAnswerToOutline(moved, quizLine, 2), moved, 'choosing it again changes nothing')
assert.equal(applyRightAnswerToOutline(talk, quizLine, 1), talk, 'the marked option is already right')
assert.equal(preworkFromOutline(applyRightAnswerToOutline(talk, quizLine, -1)).steps[1].right, null, '-1 clears it')
assert.equal(applyRightAnswerToOutline(talk, 2, 0), talk, 'a line that is not a heading is refused')
// The writer shares the reader's walk: a misplaced marker is moved to where the Inspector writes it.
const odd = '### C\n{poll=single}{check}\n\n- {right} One\n  - hint {right}\n- Two\n'
assert.equal(applyRightAnswerToOutline(odd, 1, 0), '### C\n{poll=single}{check}\n\n- One {right}\n  - hint\n- Two\n', 'choosing an option tidies every other marker away')
assert.equal(applyRightAnswerToOutline(odd, 1, -1), '### C\n{poll=single}{check}\n\n- One\n  - hint\n- Two\n')
const crlf = talk.replace(/\n/g, '\r\n')
assert.equal(applyRightAnswerToOutline(crlf, quizLine, 0).split('\r\n').length, crlf.split('\r\n').length, 'CRLF line endings are kept')
const before = talk.split('\n')
const changed = moved.split('\n').flatMap((line, index) => line === before[index] ? [] : [line])
assert.deepEqual(changed, ['- It uses tools to carry out steps for you', '- Not sure yet {right}'], 'only the two option lines change')

// ── 4. Presenting skips the pre-work steps ─────────────────────────────────────────────────
function outerSlideIds(html) {
  const stageStart = html.indexOf('id="stage"')
  const beatsStart = html.indexOf('<script>window.__deckBeats=', stageStart)
  return [...html.slice(stageStart, beatsStart).matchAll(/<section class="[^"]*\bslide\b[^"]*"[^>]*data-id="([^"]+)"/g)].map((match) => match[1])
}
function outerBeatIds(html) {
  const marker = '<script>window.__deckBeats='
  const start = html.indexOf(marker) + marker.length
  return JSON.parse(html.slice(start, html.indexOf(';</script>', start))).map((beat) => beat.slideId)
}
assert.deepEqual(outerSlideIds(model.fullHtml), ['open', 'why', 'pwform', 'pwwelcome', 'pwquiz', 'pwtools', 'pwtask1', 'turn', 'r1tools'],
  'the compiled deck keeps every slide (the strip and the Inspector show the steps)')
const presented = withoutPresenterSlides(model.fullHtml, slideIds)
assert.deepEqual(outerSlideIds(presented), ['open', 'why', 'turn', 'r1tools'], 'the presenter deck has no pre-work slide')
assert.deepEqual([...new Set(outerBeatIds(presented))], ['open', 'why', 'turn', 'r1tools'], 'and no pre-work beat')
assert.equal(withoutPresenterSlides(model.fullHtml, []), model.fullHtml, 'no pre-work: the deck is untouched')
assert.equal(presented.slice(presented.indexOf(';</script>', presented.indexOf('window.__deckBeats='))), model.fullHtml.slice(model.fullHtml.indexOf(';</script>', model.fullHtml.indexOf('window.__deckBeats='))),
  'everything after the stage is byte-identical')
assert.match(presented, /<\/body>\s*<\/html>\s*$/, 'the document tail is kept')
assert.throws(() => withoutPresenterSlides(model.fullHtml, outerSlideIds(model.fullHtml)), /nothing to present/)
// A pathway that ticks a pre-work step still never presents it (index.ts filters the ids first).
const pathway = injectPathwayRuntime(model.fullHtml, ['why', 'r1tools'].filter((id) => !slideIds.includes(id)), 'short')
assert.deepEqual(outerSlideIds(pathway), ['why', 'r1tools'])

// Fix round S4: present-from-here on a pre-work step starts at the first talk slide after it, and says so.
const order = model.slides.map((slide) => ({ id: slide.id, title: slide.title }))
assert.deepEqual(presentStartOutsidePrework(order, slideIds, 'pwquiz'),
  { slideId: 'turn', notice: 'Pre-work is answered before the session and is not presented; starting at “Your turn”.' })
assert.deepEqual(presentStartOutsidePrework(order, slideIds, 'why'), { slideId: 'why' }, 'a talk slide starts where asked, with no notice')
assert.deepEqual(presentStartOutsidePrework(order, slideIds, undefined), { slideId: undefined })
assert.equal(presentStartOutsidePrework([{ id: 'a', title: 'A' }, { id: 'p', title: 'P' }], ['p'], 'p').slideId, 'a', 'pre-work at the end: the first talk slide')
const noticed = injectPresenterNotice(presented, 'Starting at “</script><b>x</b>”.')
assert.equal(noticed.includes('</script><b>'), false, 'the notice text is JSON in a script, never markup')
assert.match(noticed, /data-prework-notice/)
assert.match(noticed, /<\/body>\s*<\/html>\s*$/)

// ── 5. The handout before the day (ticket 09) ───────────────────────────────────────────────
// A planned Run's handout carries the public form and the step slides in an inert template, never
// as ordinary slides, and asks the Worker whether pre-work is open. The right answer is nowhere in it.
{
  const form = publicPreworkForm(model.prework, model.slides)
  assert.ok(form && form.steps.length === 4, 'the form has the four steps')
  assert.equal(/"right"|\{right\}/i.test(JSON.stringify(form)), false, 'the public form carries no right answer')
  const all = extractSlides(model.fullHtml)
  const ids = new Set(slideIds)
  const html = buildShareHtml({
    title: 'Pre-work fixture', slides: all.filter((slide) => !ids.has(slide.id)), styles: extractStyles(model.fullHtml), includeNotes: false,
    slug: 'prework-fixture', workerBaseUrl: 'https://live.example.test', liveTalkSlug: 'prework-fixture',
    prework: { preworkId: 'pw123456', workerBaseUrl: 'https://live.example.test/', form, steps: all.filter((slide) => ids.has(slide.id)).map((slide) => ({ id: slide.id, html: slide.html })) },
  })
  assert.equal(/\{right\}/i.test(html), false, 'no right-answer marker anywhere in the handout')
  assert.equal(/"right"\s*:/.test(html), false, 'no right answer in any JSON the handout carries')
  const fetched = []
  const virtualConsole = new VirtualConsole()
  const errors = []
  virtualConsole.on('jsdomError', (error) => errors.push(error.message))
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://handouts.example.test/prework-fixture/', virtualConsole,
    beforeParse(window) {
      window.fetch = async (url, init) => {
        fetched.push({ url: String(url), init })
        if (String(url).includes('/prework/')) return { ok: true, json: async () => ({ state: 'open', opensAt: 1, closesAt: 2 }) }
        return { ok: true, json: async () => ({ live: false }) }
      }
      window.WebSocket = class { close() {} }
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
      window.ResizeObserver = class { observe() {} disconnect() {} }
    },
  })
  const { document } = dom.window
  const events = []
  document.addEventListener('tw:prework-status', (event) => events.push(event.detail))
  await new Promise((resolve) => setTimeout(resolve, 100))
  const listed = [...document.querySelectorAll('.slide')].map((slide) => slide.dataset.id)
  assert.equal(listed.some((id) => ids.has(id)), false, 'no pre-work step is an ordinary slide of the handout')
  assert.ok(listed.includes('turn') && listed.includes('r1tools'), 'the talk\'s own slides are')
  const template = document.getElementById('preworkSteps')
  assert.deepEqual([...template.content.querySelectorAll('.slide')].map((slide) => slide.dataset.id), ['pwform', 'pwwelcome', 'pwquiz', 'pwtools', 'pwtask1'],
    'the steps travel in an inert template for the form')
  const statusCall = fetched.find((call) => call.url.includes('/prework/'))
  assert.equal(statusCall.url, 'https://live.example.test/prework/pw123456', 'the handout asks its own pre-work object')
  assert.equal(statusCall.init.credentials, 'omit', 'and sends no credential')
  assert.equal(document.body.dataset.prework, 'open', 'the page is marked while pre-work is open')
  assert.equal(errors.length, 0, errors.join('\n'))
  dom.window.close()

  // Without pre-work the handout carries none of it.
  const plain = buildShareHtml({ title: 'T', slides: all, styles: '', includeNotes: false, slug: 't', workerBaseUrl: 'https://live.example.test' })
  assert.equal(plain.includes('preworkSteps') || plain.includes('createPreworkStatus'), false)
  assert.equal(preworkStatusUrl({ workerBaseUrl: 'https://w.test//', preworkId: 'ab12cd34' }), 'https://w.test/prework/ab12cd34')
  assert.equal(normalisePreworkStatus({ state: 'closed', opensAt: 1, closesAt: 2, people: 31 }).people, 31)
  assert.equal(normalisePreworkStatus({ state: 'open', opensAt: '1', closesAt: 2 }), null)
  assert.equal(normalisePreworkStatus(null), null)
}

console.log('prework: definition, findings, compiler model, right-answer writes, presenting skip and the handout before the day checks passed')
