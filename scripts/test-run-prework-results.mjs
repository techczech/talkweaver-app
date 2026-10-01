// Feedback-boards ticket 11: the Run page's reading of a Run's pre-work, the picks and marks the Run
// keeps, and the seed a board slide fed by a step opens with. Real modules, a temp vault, the real
// Run writer; no window and no network.
//   1. overview counts: started, finished, per step, tasks, per day, questions; the quick check's
//      spread with the right answer marked and the most common wrong answer;
//   2. answers: newest last, search, "Group similar", stars (first star switches to "only picked"),
//      pick order, moving a pick; text with markup is kept as text;
//   3. the Run keeps picks and marks through a pull (merge) and a rewrite; foreign ids are dropped;
//   4. the board slide a step feeds is found from the outline; a board with no `{results=}` is not fed;
//   5. the seed: picked answers in pick order, or every answer; none when nothing is picked; only for
//      a board whose slide is fed; never the quick check's right answer or anything but answer text;
//   6. the service's setPick / markQuestion go through the atomic writer and refuse a Run that is not in the vault.
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-run-prework-results.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preworkFromOutline } from '../compiler/scripts/lib/prework.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import {
  answerRows, applyPickChange, checkSummary, feedsForStep, movePick, pickedAnswers, pickMode, preworkOverview, preworkSeedTexts, questionCounts, questionGroups,
  seedPlan, stepFeedingSlide, togglePick,
} from '../src/shared/run-prework-results.ts'
import { mergeRunPrework, normaliseRunPrework } from '../src/shared/run-prework.ts'
import { normaliseRun, persistRunForTalk, readRunForTalk, applyRunPrework } from '../src/main/runs.ts'
import { createRunPrework } from '../src/main/run-prework.ts'
import { seedBoardFromPrework, seedPollForRun, withoutSeed } from '../src/main/run-prework-seed.ts'
import { answerPreworkTrayQuestion, isPreworkQuestionId, preworkTrayForSession, preworkTrayQuestions } from '../src/main/prework-tray.ts'
import { parsePollDefinition } from '../worker/protocol.ts'
import { DUP_TALK, OUTLINE, RUN_ID, SLUG, entries, entry, plannedRun } from './lib/prework-run-fixture.mjs'

const definition = preworkFromOutline(OUTLINE)
assert.ok(definition, 'the fixture outline has pre-work')
const step = (id) => definition.steps.find((candidate) => candidate.id === id)
const run = normaliseRun(plannedRun())
const scratch = mkdtempSync(join(tmpdir(), 'tw-prework-fixture-'))
/** The compiler's own model of an outline: the feeds and the slide ids are read from it, never derived. */
async function compile(name, text) {
  const path = join(scratch, `${name}.md`)
  writeFileSync(path, text)
  return prepareSource(path, text, name, statSync(path))
}
const model = await compile('talk', OUTLINE)
const feeds = model.prework.feeds
const results = []
const pass = (name) => { results.push(name); console.log(`PASS  ${name}`) }

// 1. Overview -------------------------------------------------------------------------------
{
  const overview = preworkOverview(definition, run.prework, 12)
  assert.equal(overview.started, 9)
  assert.equal(overview.expected, 12)
  assert.deepEqual(overview.steps.map((progress) => progress.count), [9, 8, 6, 4], 'read, answered, answered, marked done')
  assert.equal(overview.finished, 4, 'people 1 to 4 did every step; the others stopped earlier')
  assert.deepEqual(overview.tasks.map((task) => task.done), [4])
  assert.deepEqual(overview.questions, { total: 3, toAnswer: 3, steps: 2 })
  assert.equal(overview.steps[3].asked, 2)
  assert.deepEqual(overview.perDay.map((day) => day.count).reduce((a, b) => a + b, 0), 9, 'every person counts once, on the day of their first entry')
  assert.equal(overview.lastActivityAt, run.prework.lastActivityAt)
  // Someone who does everything counts as finished.
  const complete = { entries: [entry(1, 'read', 'pwwelcome'), entry(1, 'answer', 'pwquiz', { choice: 'poll-pwquiz-option-1' }), entry(1, 'answer', 'pwhope', { text: 'x' }), entry(1, 'done', 'pwtask1', { done: true })] }
  assert.equal(preworkOverview(definition, complete).finished, 1)
  assert.equal(preworkOverview(definition, { entries: [entry(1, 'done', 'pwtask1', { done: false })].concat(complete.entries.slice(0, 3)) }).finished, 0, 'a task unticked is not done')
  assert.equal(preworkOverview(definition, null).started, 0)
  const summary = checkSummary(step('pwquiz'), run.prework)
  assert.equal(summary.answered, 8)
  assert.deepEqual(summary.options.map((option) => option.count), [2, 5, 0, 1])
  assert.equal(summary.options[1].right, true)
  assert.equal(summary.rightCount, 5)
  assert.equal(summary.rightPercent, 63)
  assert.equal(summary.commonWrong.label, 'Answers questions in full sentences')
  assert.equal(checkSummary({ ...step('pwquiz'), right: null }, run.prework).hasRight, false)
  pass('overview: started, finished, per step, tasks, per day, questions; the quick check spread with the right answer and the common wrong one')
}

// 2. Answers and stars -----------------------------------------------------------------------
{
  const rows = answerRows(run.prework, 'pwhope')
  assert.equal(rows.length, 6)
  assert.deepEqual(rows.map((row) => row.at), [...rows.map((row) => row.at)].sort((a, b) => a - b), 'oldest first')
  assert.equal(rows[5].text, '<b>Bold hopes</b> & more', 'markup is kept as text, never interpreted')
  const grouped = answerRows(run.prework, 'pwhope', { group: true })
  assert.equal(grouped.length, 5)
  assert.equal(grouped[0].ids.length, 2, 'identical answers are one row with both ids')
  assert.equal(answerRows(run.prework, 'pwhope', { query: 'ADMIN' }).length, 1, 'search ignores case')
  assert.equal(pickMode(run.prework, 'pwhope'), 'all', 'every answer until something is starred')
  assert.deepEqual(preworkSeedTexts(run.prework, 'pwhope'), rows.map((row) => row.text))
  let pick = togglePick(run.prework, 'pwhope', rows[2].id)
  assert.deepEqual(pick, { mode: 'picked', ids: [rows[2].id] }, 'the first star switches to "only the answers I pick"')
  const withPick = { ...run.prework, picks: { pwhope: pick } }
  pick = togglePick(withPick, 'pwhope', rows[0].id)
  assert.deepEqual(pick.ids, [rows[2].id, rows[0].id], 'picks keep the order they were made in')
  assert.deepEqual(movePick(pick, rows[0].id, -1).ids, [rows[0].id, rows[2].id])
  assert.equal(movePick(pick, rows[2].id, -1), pick, 'the first pick cannot move earlier')
  const two = { ...run.prework, picks: { pwhope: pick } }
  assert.deepEqual(pickedAnswers(two, 'pwhope').map((answer) => answer.text), ['Whether it is allowed with student data', 'Use an agent on my own files safely'])
  assert.deepEqual(preworkSeedTexts(two, 'pwhope'), ['Whether it is allowed with student data', 'Use an agent on my own files safely'])
  assert.deepEqual(togglePick(two, 'pwhope', rows[2].id).ids, [rows[0].id], 'starring again removes it')
  assert.deepEqual(preworkSeedTexts({ ...run.prework, picks: { pwhope: { mode: 'picked', ids: [] } } }, 'pwhope'), [], 'only-picked with nothing picked seeds nothing')
  assert.deepEqual(preworkSeedTexts({ ...run.prework, picks: { pwhope: { mode: 'all', ids: [rows[0].id] } } }, 'pwhope').length, 6, 'every answer ignores the stars')
  assert.deepEqual(preworkSeedTexts(run.prework, 'pwquiz'), [], 'a quick check has no text answers to seed')
  pass('answers: oldest first, search, group similar, stars switch to picked, pick order, moving a pick, markup kept as text')
}

// 3. The Run keeps picks and marks -----------------------------------------------------------
{
  const rows = answerRows(run.prework, 'pwhope')
  const picked = normaliseRun({ ...run, prework: { ...run.prework, picks: { pwhope: { mode: 'picked', ids: [rows[1].id, rows[1].id, 42, ''] }, '': { mode: 'all', ids: [] }, pwquiz: { mode: 'bogus', ids: [] } } } })
  assert.deepEqual(picked.prework.picks, { pwhope: { mode: 'picked', ids: [rows[1].id] } }, 'duplicates, non-strings, empty step ids and unknown modes are dropped')
  const question = run.prework.entries.find((candidate) => candidate.kind === 'question')
  const marked = normaliseRun({ ...picked, prework: { ...picked.prework, entries: picked.prework.entries.map((candidate) => candidate.id === question.id ? { ...candidate, answered: true, inTalk: { slideId: 'hopesboard' } } : candidate) } })
  const kept = marked.prework.entries.find((candidate) => candidate.id === question.id)
  assert.equal(kept.answered, true)
  assert.deepEqual(kept.inTalk, { slideId: 'hopesboard' })
  // A pull replaces the answer's copy but never the Run page's own marks.
  const pulled = mergeRunPrework(marked.prework, [{ ...question, seq: 9, text: 'Edited wording of the question' }, { ...entry(9, 'answer', 'pwhope', { text: 'A late answer' }), seq: 10 }], { people: 10 })
  assert.equal(pulled.entries.find((candidate) => candidate.id === question.id).answered, true, 'answered survives a pull')
  assert.deepEqual(pulled.entries.find((candidate) => candidate.id === question.id).inTalk, { slideId: 'hopesboard' }, 'in the talk survives a pull')
  assert.deepEqual(pulled.picks, marked.prework.picks, 'picks survive a pull')
  assert.equal(pulled.entries.length, marked.prework.entries.length + 1)
  assert.equal(applyRunPrework(marked, [], {}), marked, 'a pull with nothing new writes nothing')
  assert.equal(normaliseRunPrework({ entries: [], picks: { pwhope: { mode: 'all', ids: [] } } }).picks.pwhope.mode, 'all', 'picks alone are worth keeping')
  assert.equal(normaliseRunPrework({ entries: [{ ...question, inTalk: 'x' }] }).entries[0].inTalk, undefined, 'a bad inTalk is dropped, not the entry')
  pass('the Run keeps picks and marks through a pull; malformed picks and marks are dropped field by field')
}

// 4. The slide a step feeds -------------------------------------------------------------------
{
  assert.deepEqual(feeds.map((feed) => feed.stepId), ['pwhope'])
  assert.equal(feeds[0].slideId, 'hopesboard')
  assert.equal(feeds[0].title, 'What do you hope for today?')
  assert.ok(feeds[0].number > 0 && model.slides[feeds[0].number - 1].id === 'hopesboard', 'the number is the slide\'s place in the compiled deck')
  assert.equal(feedsForStep(feeds, 'pwhope').length, 1)
  assert.equal(stepFeedingSlide(feeds, 'hopesboard'), 'pwhope')
  assert.equal(stepFeedingSlide(feeds, 'discuss'), null)
  assert.equal(stepFeedingSlide(null, 'hopesboard'), null)
  const notBoard = await compile('notboard', OUTLINE.replace('{poll=board}{results=pwhope}', '{results=pwhope}'))
  assert.deepEqual(notBoard.prework.feeds, [], 'only a board slide takes answers this way')
  // Two slides of one title: the compiler's id for the second is the one that counts.
  const dup = await compile('dup', DUP_TALK)
  assert.deepEqual(dup.prework.feeds.map((feed) => feed.slideId), ['hopes-for-today-2'], 'the fed board is the second of its title, with the compiler\'s deduped id')
  assert.ok(dup.slides.some((slide) => slide.id === 'hopes-for-today') && dup.slides.some((slide) => slide.id === 'hopes-for-today-2'))
  assert.equal(stepFeedingSlide(dup.prework.feeds, 'hopes-for-today'), null, 'the plain slide of the same title is not fed')
  pass('the board slide a step feeds comes from the compiler\'s model, with its deduped slide id and place in the deck')
}

// 5. The seed ---------------------------------------------------------------------------------
{
  const boardPoll = (extra = {}) => parsePollDefinition({ pollId: 'poll-hopesboard', slideId: 'hopesboard', type: 'board', question: 'What do you hope for today?', visibility: 'live',
    options: [{ optionId: 'poll-hopesboard-option-1', label: 'Hopes' }, { optionId: 'poll-hopesboard-option-2', label: 'Worries' }], ...extra })
  const poll = boardPoll()
  assert.ok(poll)
  const all = seedBoardFromPrework(poll, run.prework, feeds)
  assert.equal(all.seed.length, 6, 'every answer by default')
  assert.ok(all.seed.every((card) => card.column === 'poll-hopesboard-option-1'), 'into the first column')
  assert.equal(all.seed[5].text, '<b>Bold hopes</b> & more')
  const rows = answerRows(run.prework, 'pwhope')
  const picked = seedBoardFromPrework(poll, { ...run.prework, picks: { pwhope: { mode: 'picked', ids: [rows[3].id, rows[0].id] } } }, feeds)
  assert.deepEqual(picked.seed.map((card) => card.text), ['Save time on admin email', 'Use an agent on my own files safely'])
  assert.equal(seedBoardFromPrework(poll, { ...run.prework, picks: { pwhope: { mode: 'picked', ids: [] } } }, feeds), poll, 'nothing picked: the board opens empty')
  assert.equal(seedBoardFromPrework({ ...poll, slideId: 'discuss' }, run.prework, feeds).seed, undefined, 'a board no step feeds is not seeded')
  assert.equal(seedBoardFromPrework(poll, null, feeds), poll, 'no pre-work on the Run: not seeded')
  assert.equal(seedBoardFromPrework(poll, run.prework, null), poll, 'no feeds: not seeded')
  const open = { ...poll, type: 'open', options: [] }
  assert.equal(seedBoardFromPrework(open, run.prework, feeds), open, 'only a board is seeded')
  const text = JSON.stringify(all.seed)
  assert.ok(!/right|poll-pwquiz|Uses tools/i.test(text), 'nothing of the quick check reaches a card')
  // The worker keeps a seed on a board only and cuts it to the board's card length.
  const cut = parsePollDefinition({ ...poll, board: { cardChars: 20 }, seed: [{ column: poll.options[0].optionId, text: 'y'.repeat(50) }] })
  assert.equal(cut.seed[0].text.length, 20)
  // ...and the app cuts to the board's card length itself, before sending.
  const long = { ...run.prework, entries: [...run.prework.entries, entry(9, 'answer', 'pwhope', { text: 'z'.repeat(400) })] }
  const short = seedBoardFromPrework({ ...poll, board: { ...poll.board, cardChars: 60 } }, long, feeds)
  assert.ok(short.seed.every((card) => [...card.text].length <= 60) && short.seed.some((card) => card.text === 'z'.repeat(60)), 'text is cut to poll.board.cardChars in the app')
  // A seed a window sends is never passed on; only main builds one.
  const hostile = { ...poll, slideId: 'discuss', seed: [{ column: poll.options[0].optionId, text: 'Injected by a window' }] }
  assert.equal(withoutSeed(hostile).seed, undefined)
  assert.equal(seedBoardFromPrework(hostile, run.prework, feeds).seed, undefined, 'a board no step feeds keeps no seed a window handed it')
  assert.deepEqual(seedBoardFromPrework({ ...poll, seed: [{ column: poll.options[0].optionId, text: 'Injected by a window' }] }, run.prework, feeds).seed.map((card) => card.text).includes('Injected by a window'), false, 'the window\'s seed is replaced by the Run\'s')
  pass('the seed: picked answers in pick order or every answer; none when nothing is picked; only a fed board; no quick-check content')
}

// 6. The service writes through the atomic Run writer ---------------------------------------
{
  const root = mkdtempSync(join(tmpdir(), 'tw-prework-results-'))
  try {
    mkdirSync(join(root, '_PRESENTATIONS', SLUG), { recursive: true })
    persistRunForTalk(root, SLUG, RUN_ID, normaliseRun(plannedRun()))
    const service = createRunPrework({ registryPath: join(root, 'registry.json'), endpoint: async () => ({ baseUrl: 'https://live.example.test', adminSecret: 'unused' }), vaultRoot: () => root, fetch: async () => { throw new Error('no network') } })
    const rows = answerRows(readRunForTalk(root, SLUG, RUN_ID).prework, 'pwhope')
    const first = service.changePick(SLUG, RUN_ID, 'pwhope', { type: 'toggle', id: rows[1].id })
    assert.equal(first.ok, true)
    assert.deepEqual(readRunForTalk(root, SLUG, RUN_ID).prework.picks, { pwhope: { mode: 'picked', ids: [rows[1].id] } })
    // Two quick clicks are two changes, each applied to the Run as it then is: neither is lost.
    assert.equal(service.changePick(SLUG, RUN_ID, 'pwhope', { type: 'toggle', id: rows[3].id }).ok, true)
    assert.equal(service.changePick(SLUG, RUN_ID, 'pwhope', { type: 'toggle', id: rows[0].id }).ok, true)
    assert.deepEqual(readRunForTalk(root, SLUG, RUN_ID).prework.picks.pwhope.ids, [rows[1].id, rows[3].id, rows[0].id], 'quick successive stars keep every one, in click order')
    assert.equal(service.changePick(SLUG, RUN_ID, 'pwhope', { type: 'move', id: rows[0].id, by: -1 }).ok, true)
    assert.deepEqual(readRunForTalk(root, SLUG, RUN_ID).prework.picks.pwhope.ids, [rows[1].id, rows[0].id, rows[3].id])
    assert.equal(service.changePick(SLUG, RUN_ID, 'pwhope', { type: 'mode', mode: 'all' }).ok, true)
    assert.deepEqual(readRunForTalk(root, SLUG, RUN_ID).prework.picks.pwhope, { mode: 'all', ids: [rows[1].id, rows[0].id, rows[3].id] }, 'the mode changes and the stars are remembered')
    assert.equal(service.changePick(SLUG, RUN_ID, 'pwhope', { type: 'toggle', id: entry(1, 'read', 'pwwelcome').id }).ok, true)
    assert.equal(readRunForTalk(root, SLUG, RUN_ID).prework.picks.pwhope.ids.length, 3, 'an id that is not an answer of the step is dropped')
    assert.equal(service.changePick(SLUG, RUN_ID, 'pwhope', { type: 'sideways' }).ok, false)
    assert.equal(service.changePick(SLUG, RUN_ID, 'pwhope', { type: 'move', id: rows[0].id, by: 5 }).ok, false)
    const question = readRunForTalk(root, SLUG, RUN_ID).prework.entries.find((candidate) => candidate.kind === 'question')
    assert.equal(service.markQuestion(SLUG, RUN_ID, question.id, { answered: true }).ok, true)
    assert.equal(service.markQuestion(SLUG, RUN_ID, question.id, { inTalk: { slideId: 'hopesboard' } }).ok, true)
    const stored = readRunForTalk(root, SLUG, RUN_ID).prework.entries.find((candidate) => candidate.id === question.id)
    assert.equal(stored.answered, true, 'the second mark keeps the first')
    assert.deepEqual(stored.inTalk, { slideId: 'hopesboard' })
    assert.equal(service.markQuestion(SLUG, RUN_ID, question.id, { answered: false, inTalk: null }).ok, true)
    const cleared = readRunForTalk(root, SLUG, RUN_ID).prework.entries.find((candidate) => candidate.id === question.id)
    assert.equal(cleared.answered, undefined)
    assert.equal(cleared.inTalk, undefined)
    assert.equal(service.markQuestion(SLUG, RUN_ID, entry(1, 'read', 'pwwelcome').id, { answered: true }).ok, false, 'only a question can be marked')
    assert.equal(service.markQuestion(SLUG, RUN_ID, question.id, { answered: 'yes' }).ok, false)
    assert.equal(service.changePick(SLUG, 'run-missing', 'pwhope', { type: 'mode', mode: 'all' }).ok, false, 'a Run that is not in the vault is refused')
    assert.equal(service.changePick('../escape', RUN_ID, 'pwhope', { type: 'mode', mode: 'all' }).ok, false, 'a talk slug that escapes the vault is refused')
    assert.equal(service.markQuestion(SLUG, RUN_ID, question.id, { inTalk: { slideId: 's'.repeat(201) } }).ok, false, 'an over-long slide id is refused, not reported ok')
    assert.equal(service.markQuestion(SLUG, RUN_ID, question.id, { inTalk: { slideId: 's'.repeat(200) } }).ok, true)
    pass('the service writes one pick change or mark at a time through the Run writer; quick clicks are all kept; foreign ids, bad values, long ids and unsafe names are refused')
  } finally { rmSync(root, { recursive: true, force: true }) }
}

// The glue: poll.open -> Run -> compiled feeds -> seed ------------------------------------------
{
  const root = mkdtempSync(join(tmpdir(), 'tw-prework-glue-'))
  try {
    mkdirSync(join(root, '_PRESENTATIONS', SLUG), { recursive: true })
    persistRunForTalk(root, SLUG, RUN_ID, normaliseRun(plannedRun()))
    // The duplicate-title talk: the board fed by the step is the SECOND slide of its title.
    const dupModel = await compile('dupglue', DUP_TALK)
    const dupBoard = dupModel.slides.find((slide) => slide.id === 'hopes-for-today-2').poll
    const dupPlain = dupModel.slides.find((slide) => slide.id === 'hopes-for-today')
    assert.equal(dupBoard.type, 'board')
    assert.equal(dupPlain.poll, undefined)
    const deps = (text) => ({ vaultRoot: () => root, readOutline: () => text, feeds: async (outline) => (await compile('glue', outline)).prework?.feeds ?? null })
    const open = { ...dupBoard, slideId: 'hopes-for-today-2' }
    const seeded = await seedPollForRun(open, { talkSlug: SLUG, runId: RUN_ID }, deps(DUP_TALK))
    assert.equal(seeded.seed.length, 6, 'the second slide of a repeated title is seeded (a bare re-derived id would miss it)')
    const other = await seedPollForRun({ ...open, slideId: 'hopes-for-today' }, { talkSlug: SLUG, runId: RUN_ID }, deps(DUP_TALK))
    assert.equal(other.seed, undefined, 'the first slide of that title is not fed')
    assert.equal((await seedPollForRun(open, { talkSlug: SLUG }, deps(DUP_TALK))).seed, undefined, 'no Run bound: not seeded')
    assert.equal((await seedPollForRun(open, { talkSlug: SLUG, runId: 'run-missing' }, deps(DUP_TALK))).seed, undefined, 'a Run that is gone: not seeded')
    assert.equal((await seedPollForRun(open, { talkSlug: SLUG, runId: RUN_ID }, { ...deps(DUP_TALK), feeds: async () => { throw new Error('compile failed') } })).seed, undefined, 'a talk that cannot be compiled: opens empty')
    assert.equal((await seedPollForRun({ ...open, seed: [{ column: open.options[0].optionId, text: 'From a window' }] }, { talkSlug: SLUG }, deps(DUP_TALK))).seed, undefined, 'a window\'s own seed never survives')
    assert.equal((await seedPollForRun({ ...open, type: 'open', options: [] }, { talkSlug: SLUG, runId: RUN_ID }, deps(DUP_TALK))).seed, undefined)
    // The app\'s handler calls the glue and drops a window\'s seed before it (source check on the real handler).
    const indexSource = (await import('node:fs')).readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
    assert.match(indexSource, /seedPollForRun\(poll, liveSessions\?\.record\(wcId\)/, 'index.ts seeds through seedPollForRun')
    assert.match(indexSource, /seedFromRunPrework\(event\.sender\.id, withoutSeed\(message\.poll\)\)/, 'index.ts drops a window\'s seed, then seeds')
    pass('the glue: a repeated title seeds its second slide by the compiler\'s id; no Run, a missing Run, a compile failure and a window\'s seed all leave the board empty')
  } finally { rmSync(root, { recursive: true, force: true }) }
}

// Capacity ---------------------------------------------------------------------------------------
{
  const many = { ...run.prework, entries: Array.from({ length: 700 }, (_, index) => entry(index + 1, 'answer', 'pwhope', { text: `Answer number ${index + 1}` })) }
  const plan = seedPlan(many, 'pwhope')
  assert.equal(plan.texts.length, 700)
  assert.equal(plan.fits, 500, 'the board takes 500 cards at most (BOARD_SEED_MAX, the one constant)')
  assert.equal(seedPlan(run.prework, 'pwhope').fits, 6)
  assert.equal(seedBoardFromPrework(parsePollDefinition({ pollId: 'p', slideId: 'hopesboard', type: 'board', question: 'q', visibility: 'live', options: [{ optionId: 'a', label: 'A' }] }), many, feeds).seed.length, 500)
  pass('capacity: a step with more answers than a board can hold says how many fit (500 at most)')
}

// The tray ------------------------------------------------------------------------------------
{
  const root = mkdtempSync(join(tmpdir(), 'tw-prework-tray-'))
  try {
    mkdirSync(join(root, '_PRESENTATIONS', SLUG), { recursive: true })
    const base = normaliseRun(plannedRun())
    const questions = base.prework.entries.filter((candidate) => candidate.kind === 'question')
    const marked = normaliseRun({ ...base, prework: { ...base.prework, entries: base.prework.entries.map((candidate) => candidate.id === questions[1].id ? { ...candidate, inTalk: { slideId: 'hopesboard' } }
      : candidate.id === questions[0].id ? { ...candidate, inTalk: { slideId: null } } : candidate) } })
    persistRunForTalk(root, SLUG, RUN_ID, marked)
    const list = preworkTrayForSession(root, { talkSlug: SLUG, runId: RUN_ID })
    assert.equal(list.length, 2, 'only the questions put in the talk\'s questions reach the tray')
    assert.ok(list.every((item) => item.fromPrework === true && isPreworkQuestionId(item.questionId) && item.tMs === 0))
    const named = list.find((item) => item.text.includes('Can I use it'))
    assert.equal(named.name, 'Sam', 'a name only where it was typed')
    assert.equal(named.slideId, 'hopesboard', 'on the slide the step feeds')
    assert.equal(list.find((item) => item.name === undefined).slideId, '', 'no slide: whichever slide the presenter is on')
    assert.equal(preworkTrayQuestions(base).length, 0, 'nothing marked, nothing in the tray')
    assert.deepEqual(preworkTrayForSession(root, { talkSlug: SLUG }), [], 'no Run bound: nothing')
    assert.deepEqual(preworkTrayForSession(null, { talkSlug: SLUG, runId: RUN_ID }), [])
    // Mark answered writes to the Run.
    const done = answerPreworkTrayQuestion(root, { talkSlug: SLUG, runId: RUN_ID }, named.questionId, true)
    assert.equal(done.success, true)
    assert.equal(done.questions.find((item) => item.questionId === named.questionId).answered, true)
    assert.equal(readRunForTalk(root, SLUG, RUN_ID).prework.entries.find((candidate) => `pw:${candidate.id}` === named.questionId).answered, true, 'Mark answered updated the Run')
    assert.equal(answerPreworkTrayQuestion(root, { talkSlug: SLUG, runId: RUN_ID }, named.questionId, false).success, true)
    assert.equal(readRunForTalk(root, SLUG, RUN_ID).prework.entries.find((candidate) => `pw:${candidate.id}` === named.questionId).answered, undefined, 'and Not answered takes it off')
    const notIn = questions[2]
    assert.equal(answerPreworkTrayQuestion(root, { talkSlug: SLUG, runId: RUN_ID }, `pw:${notIn.id}`, true).success, false, 'a question not put in the talk\'s questions cannot be marked from the tray')
    assert.equal(answerPreworkTrayQuestion(root, { talkSlug: SLUG, runId: RUN_ID }, 'q-from-the-worker', true).success, false, 'a phone\'s question id is not a pre-work one')
    assert.equal(answerPreworkTrayQuestion(root, null, named.questionId, true).success, false)
    pass('the tray: pre-work questions put in the talk\'s questions, on their slide, with a typed name only; Mark answered is written to the Run')
  } finally { rmSync(root, { recursive: true, force: true }) }
}

// Questions ------------------------------------------------------------------------------------
{
  const groups = questionGroups(definition, run.prework)
  assert.deepEqual(groups.map((group) => group.stepId), ['pwwelcome', 'pwtask1'], 'in the order of the form steps')
  assert.deepEqual(groups[1].questions.map((question) => question.name ?? null), [null, 'Sam'], 'newest last; a name only where typed')
  const marked = { ...run.prework, entries: run.prework.entries.map((candidate, index) => index === run.prework.entries.findIndex((item) => item.kind === 'question') ? { ...candidate, answered: true } : candidate) }
  assert.deepEqual(questionCounts(definition, marked), { all: 3, 'to-answer': 2, answered: 1, 'in-talk': 0 })
  pass('questions: grouped by step in form order, newest last, filters count')
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\n${results.length} groups passed`)
