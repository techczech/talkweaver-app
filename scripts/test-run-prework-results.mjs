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
//   6. the service's setPick / markQuestion go through the atomic writer and refuse a Run that is not in the vault;
//   7. (ticket 18) the Run page's answer sections, both phases: header numbers, per-step blocks by poll type
//      (count, spread with the quick check's right answer, text answers with stars), questions, folding;
//   8. (2026-10-19 prework-responses) route per step, a Local only step, new count and unread, the read
//      state through leaving / a dot / Mark all read, exports with no participant or entry id;
//   9. the timer counts what waits (one owner-token request, nothing pulled); a pull clears it; markSeen.
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-run-prework-results.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
import { answerSection, answeredText, answersCsv, answersMarkdown, answersText, applySeenChange, isNewEntry, newResponseCount, starredCount, startsFolded, stepsFromOutline, stepsFromWorkFile } from '../src/shared/run-answers.ts'
import { startRunPreworkTimer } from '../src/main/run-prework.ts'
import { memoryOwnerTokens } from './lib/memory-secrets.mjs'

// Owner tokens live in the secrets store (an in-memory one here), never in a registry file.
const testOwnerTokens = memoryOwnerTokens()
import { seedBoardFromPrework, seedPollForRun, withoutSeed } from '../src/main/run-prework-seed.ts'
import { answerPreworkTrayForLiveSession, answerPreworkTrayQuestion, isPreworkQuestionId, preworkTrayForLiveSession, preworkTrayForSession, preworkTrayQuestions } from '../src/main/prework-tray.ts'
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
  // Unstarring the last star returns the step to every answer; the board is never seeded with nothing.
  const lone = { ...run.prework, picks: { pwhope: togglePick(run.prework, 'pwhope', rows[2].id) } }
  const unstarred = togglePick(lone, 'pwhope', rows[2].id)
  assert.deepEqual(unstarred, { mode: 'all', ids: [] }, 'the last star removed returns the step to every answer')
  assert.deepEqual(preworkSeedTexts({ ...run.prework, picks: { pwhope: unstarred } }, 'pwhope'), rows.map((row) => row.text), 'and the board seed holds every answer')
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
    const service = createRunPrework({ ownerTokens: testOwnerTokens, registryPath: join(root, 'registry.json'), endpoint: async () => ({ baseUrl: 'https://live.example.test', adminSecret: 'unused' }), vaultRoot: () => root, fetch: async () => { throw new Error('no network') } })
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

// 7. The Run page's answer sections (ticket 18) -----------------------------------------------
{
  // Pre-work, steps from the talk's own section: 9 of 12 started, as the locked "some in" shot counts them.
  const preSteps = stepsFromOutline(OUTLINE)
  assert.deepEqual(preSteps.map((candidate) => candidate.id), ['pwwelcome', 'pwquiz', 'pwhope', 'pwtask1'])
  let section = answerSection(preSteps, run.prework, 12)
  assert.equal(answeredText(section), '9/12 answered')
  assert.equal(section.percent, 75)
  assert.deepEqual(section.steps.map((block) => block.sum), ['read by 9 of 9', '8 completed', '6 answers', '4 marked done of 9'])
  const quiz = section.steps[1].body
  assert.equal(quiz.type, 'spread')
  assert.deepEqual(quiz.rows.map((row) => [row.count, row.right]), [[2, false], [5, true], [0, false], [1, false]], 'the spread marks the right answer')
  assert.equal(section.steps[2].body.type, 'answers')
  assert.equal(section.steps[2].body.rows.length, 6)
  assert.equal(section.steps[2].body.rows.some((row) => row.text === '<b>Bold hopes</b> & more'), true, 'markup stays text')
  assert.equal(section.starred, 0)
  assert.deepEqual(section.steps[3].questions.map((question) => question.name ?? null), [null, 'Sam'], 'a name only where one was typed')
  assert.equal(section.toAnswer, 3)
  // Stars: the Run's picks, in any mode, count.
  const hopes = answerRows(run.prework, 'pwhope')
  const starred = normaliseRunPrework({ ...run.prework, picks: { pwhope: { mode: 'picked', ids: [hopes[1].id, hopes[3].id] } } })
  section = answerSection(preSteps, starred, 12)
  assert.equal(section.starred, 2)
  assert.deepEqual(section.steps[2].body.rows.map((row) => row.starred), [false, true, false, true, false, false])
  // None in yet.
  assert.deepEqual([answerSection(preSteps, null, 18).answered, answerSection(preSteps, null, 18).percent, answerSection(preSteps, null, 18).starred], [0, 0, 0])
  assert.equal(answeredText(answerSection(preSteps, null, null)), '0 answered')

  // Post-work, steps from a work file, each poll type the file uses: a rating, two open questions and a video.
  const FILE = ['---', 'id: session-feedback', 'title: Session feedback', 'revision: 1', '---', '',
    '### How useful was the session?', '{id=useful}{poll=rating}', '', '[scale: 1 - not useful, 2, 3, 4, 5 - very useful]', '', '- Usefulness', '',
    '### One thing you will try', '{id=try}{poll=open}', '',
    '### Anything unclear?', '{id=unclear}{poll=open}', ''].join('\n')
  const postSteps = stepsFromWorkFile(FILE)
  assert.deepEqual(postSteps.map((candidate) => [candidate.id, candidate.kind, candidate.pollType]), [['useful', 'question', 'rating'], ['try', 'question', 'open'], ['unclear', 'question', 'open']])
  const person = (n) => n.toString(16).padStart(16, '0')
  const answer = (n, stepId, extra, at = Date.UTC(2026, 9, 21, 16, n)) => ({ id: `${person(n)}:answer:${stepId}`, participant: person(n), stepId, kind: 'answer', at, ...extra })
  const postwork = normaliseRunPrework({
    people: 5, entries: [
      answer(1, 'useful', { choice: { 'poll-useful-option-1': 'poll-useful-label-5' } }), answer(2, 'useful', { choice: { 'poll-useful-option-1': 'poll-useful-label-4' } }),
      answer(3, 'useful', { choice: { 'poll-useful-option-1': 'poll-useful-label-5' } }),
      answer(1, 'try', { text: 'A shared prompt file' }), answer(2, 'try', { text: 'Reviewer queries' }), answer(3, 'try', { text: 'Citation checks' }), answer(4, 'try', { text: 'Ask the library' }),
      answer(2, 'unclear', { text: 'Licence for unpublished data' }),
      { id: `${person(5)}:q:one`, participant: person(5), stepId: 'try', kind: 'question', text: 'Is there a template?', at: Date.UTC(2026, 9, 22, 9) }
    ], picks: { try: { mode: 'picked', ids: [`${person(2)}:answer:try`] } }
  })
  const after = answerSection(postSteps, postwork, 18)
  assert.equal(answeredText(after), '5/18 answered')
  assert.equal(after.percent, 28)
  assert.equal(after.starred, 1, 'post-work stars are counted per section')
  assert.deepEqual(after.steps.map((block) => block.label), ['Rating', 'Open question', 'Open question'])
  assert.equal(after.steps[0].body.type, 'spread', 'a rating shows its spread, not text rows')
  assert.deepEqual(after.steps[0].body.rows.map((row) => [row.key, row.count]), [['poll-useful-label-4', 1], ['poll-useful-label-5', 2]])
  assert.deepEqual(after.steps[0].body.rows.map((row) => row.label), ['Label 4', 'Label 5'])
  assert.equal(after.steps[1].sum, '4 answers')
  assert.equal(after.steps[1].questions.length, 1)
  assert.equal(after.steps[2].body.rows[0].text, 'Licence for unpublished data')
  // A step the file no longer has leaves its answers out; a file that cannot be read gives no steps.
  assert.deepEqual(stepsFromWorkFile('not a work file'), [])
  // A choice question in a work file lists its option labels on the Run page, as the quick check does (not "Option N").
  const CHOICE_FILE = ['---', 'id: pick', 'title: Pick', 'revision: 1', '---', '',
    '### Which tool?', '{id=tool}{poll=single}', '', '- Pencil', '- Pen', '- Brush', '',
    '### Which would you use?', '{id=uses}{poll=multiple}', '', '- Ruler', '- Compass', ''].join('\n')
  const choiceSteps = stepsFromWorkFile(CHOICE_FILE)
  assert.deepEqual(choiceSteps.map((candidate) => candidate.options), [['Pencil', 'Pen', 'Brush'], ['Ruler', 'Compass']], 'the file\'s option labels reach the step')
  const chosen = normaliseRunPrework({ people: 2, entries: [
    answer(1, 'tool', { choice: 'poll-tool-option-2' }), answer(2, 'tool', { choice: 'poll-tool-option-3' }),
    answer(1, 'uses', { choice: ['poll-uses-option-1', 'poll-uses-option-2'] })
  ] })
  const picked = answerSection(choiceSteps, chosen, 2)
  assert.deepEqual(picked.steps[0].body.rows.map((row) => row.label), ['Pen', 'Brush'], 'a single choice shows its labels')
  assert.deepEqual(picked.steps[1].body.rows.map((row) => row.label), ['Ruler', 'Compass'], 'a multiple choice shows its labels')
  // Folding: while post-work is open, the pre-work section starts folded; the post section never does.
  assert.deepEqual([startsFolded('pre', true, true), startsFolded('pre', true, false), startsFolded('pre', false, true), startsFolded('post', true, true)], [true, false, false, false])
  pass('answer sections: header numbers, count / spread / text blocks by poll type for pre and post work, stars and questions, folding')
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
    const deps = (text) => ({ vaultReadable: (vault) => vault === root, readOutline: () => text, feeds: async (outline) => (await compile('glue', outline)).prework?.feeds ?? null })
    const open = { ...dupBoard, slideId: 'hopes-for-today-2' }
    const seeded = await seedPollForRun(open, { talkSlug: SLUG, runId: RUN_ID, vaultRoot: root }, deps(DUP_TALK))
    assert.equal(seeded.seed.length, 6, 'the second slide of a repeated title is seeded (a bare re-derived id would miss it)')
    const other = await seedPollForRun({ ...open, slideId: 'hopes-for-today' }, { talkSlug: SLUG, runId: RUN_ID, vaultRoot: root }, deps(DUP_TALK))
    assert.equal(other.seed, undefined, 'the first slide of that title is not fed')
    assert.equal((await seedPollForRun(open, { talkSlug: SLUG }, deps(DUP_TALK))).seed, undefined, 'no Run bound: not seeded')
    assert.equal((await seedPollForRun(open, { talkSlug: SLUG, runId: 'run-missing', vaultRoot: root }, deps(DUP_TALK))).seed, undefined, 'a Run that is gone: not seeded')
    assert.equal((await seedPollForRun(open, { talkSlug: SLUG, runId: RUN_ID, vaultRoot: root }, { ...deps(DUP_TALK), feeds: async () => { throw new Error('compile failed') } })).seed, undefined, 'a talk that cannot be compiled: opens empty')
    assert.equal((await seedPollForRun({ ...open, seed: [{ column: open.options[0].optionId, text: 'From a window' }] }, { talkSlug: SLUG }, deps(DUP_TALK))).seed, undefined, 'a window\'s own seed never survives')
    assert.equal((await seedPollForRun({ ...open, type: 'open', options: [] }, { talkSlug: SLUG, runId: RUN_ID, vaultRoot: root }, deps(DUP_TALK))).seed, undefined)
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

// The tray reads the live session's own vault ------------------------------------------------------
// Two open vaults hold the same talk slug and Run id; the session recorded vault A. The tray, its updates
// and Mark answered use A only while A is open and there, and never fall back to B (review round 1, finding 1).
{
  const a = mkdtempSync(join(tmpdir(), 'tw-prework-tray-a-'))
  const b = mkdtempSync(join(tmpdir(), 'tw-prework-tray-b-'))
  try {
    const base = normaliseRun(plannedRun())
    const questions = base.prework.entries.filter((candidate) => candidate.kind === 'question')
    const markOnly = (index) => normaliseRun({ ...base, prework: { ...base.prework, entries: base.prework.entries.map((candidate) => candidate.id === questions[index].id ? { ...candidate, inTalk: { slideId: null } } : candidate) } })
    for (const root of [a, b]) mkdirSync(join(root, '_PRESENTATIONS', SLUG), { recursive: true })
    persistRunForTalk(a, SLUG, RUN_ID, markOnly(0))
    persistRunForTalk(b, SLUG, RUN_ID, markOnly(1))
    const session = { talkSlug: SLUG, runId: RUN_ID, vaultRoot: a }
    const open = new Set([a, b])
    const readable = (root) => open.has(root)
    const writable = (root) => root
    const fromA = preworkTrayForLiveSession(session, readable)
    assert.deepEqual(fromA.map((item) => item.questionId), [`pw:${questions[0].id}`], 'the session\'s own vault A, not B\'s same-slug Run')
    const done = answerPreworkTrayForLiveSession(session, readable, writable, fromA[0].questionId, true)
    assert.equal(done.success, true)
    assert.equal(readRunForTalk(a, SLUG, RUN_ID).prework.entries.find((candidate) => candidate.id === questions[0].id).answered, true, 'written to A')
    assert.equal(readRunForTalk(b, SLUG, RUN_ID).prework.entries.some((candidate) => candidate.answered), false, 'B untouched')
    open.delete(a)
    assert.deepEqual(preworkTrayForLiveSession(session, readable), [], 'A closed or gone: no questions, never B\'s')
    const refused = answerPreworkTrayForLiveSession(session, readable, writable, `pw:${questions[1].id}`, true)
    assert.equal(refused.success, false, 'A closed: Mark answered is refused')
    assert.equal(readRunForTalk(b, SLUG, RUN_ID).prework.entries.some((candidate) => candidate.answered), false, 'and nothing is written to B')
    assert.deepEqual(preworkTrayForLiveSession({ talkSlug: SLUG, runId: RUN_ID, vaultRoot: null }, readable), [], 'a session with no vault: nothing')
    open.add(a)
    assert.equal(answerPreworkTrayForLiveSession(session, readable, () => null, fromA[0].questionId, false).success, false, 'A not writable: refused')
    pass('the tray reads, updates and writes the live session\'s own vault only while it is open, never another vault with the same talk and Run')
  } finally { for (const root of [a, b]) rmSync(root, { recursive: true, force: true }) }
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

// Pre-work is set up with whichever key held for the live service it accepts (several Macs) ------
{
  const root = mkdtempSync(join(tmpdir(), 'tw-prework-held-'))
  try {
    const { heldKeysCases, heldKeysDouble } = await import('./lib/held-keys-cases.mjs')
    const made = []
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const inner = async (url, init = {}) => {
      if (new URL(url).pathname !== '/prework') return reply({ ok: true })
      made.push(init.body)
      return reply({ preworkId: `pw00000${made.length}`, ownerToken: `owner-token-0123456789-${made.length}` }, 201)
    }
    const double = heldKeysDouble({ baseUrl: 'https://live.example.test', route: '/prework', inner })
    const service = createRunPrework({ ownerTokens: testOwnerTokens, registryPath: join(root, 'registry.json'), endpoint: double.endpoint, vaultRoot: () => root, fetch: double.fetch })
    const window = { opensAt: Date.UTC(2026, 9, 1, 9), closesAt: Date.UTC(2026, 9, 6, 10) }
    const published = await heldKeysCases(double, (n) => service.publish(SLUG, `${RUN_ID}-held-${n}`, definition, window), 'pre-work')
    assert.deepEqual([published.preworkId, published.workerBaseUrl, made.length], ['pw000001', 'https://live.example.test', 1], 'set up with the 0.38.2 key; the refused and unanswered requests made nothing')
    await service.publish(SLUG, `${RUN_ID}-held-own`, definition, window)
    assert.deepEqual(double.sent(), ['own'], 'its own key accepted: one request')
    assert.equal(readFileSync(join(root, 'registry.json'), 'utf8').includes(double.ownKey), false, 'no key in the registry')
    pass('held keys: pre-work is set up with the 0.38.2 key when this computer\'s own is refused; "access was removed" only when both are; no answer or another status is never that')
  } finally { rmSync(root, { recursive: true, force: true }) }
}

// 8. Responses (2026-10-19 prework-responses): route per step, Local only, what is new, read state, exports
{
  const FILE = ['---', 'id: intake', 'title: Intake', 'revision: 1', '---', '',
    '### Read this', '{id=watch}', '', 'A paragraph to read.', '',
    '### What do you hope for?', '{id=hope}{poll=open}', '',
    '### Try a prompt', '{id=try}{task}{local}', ''].join('\n')
  const steps = stepsFromWorkFile(FILE)
  assert.deepEqual(steps.map((step) => [step.id, step.kind, step.local === true]), [['watch', 'slide', false], ['hope', 'question', false], ['try', 'task', true]])
  const person = (n) => n.toString(16).padStart(16, '0')
  const at = (minute) => Date.UTC(2026, 9, 20, 18, minute)
  const answer = (n, minute, text) => ({ id: `${person(n)}:answer:hope`, participant: person(n), stepId: 'hope', kind: 'answer', at: at(minute), text })
  const question = (n, minute, text, name) => ({ id: `${person(n)}:q:sub${n}`, participant: person(n), stepId: 'hope', kind: 'question', at: at(minute), text, ...(name ? { name } : {}) })
  const read = (n, minute) => ({ id: `${person(n)}:read:watch`, participant: person(n), stepId: 'watch', kind: 'read', at: at(minute) })
  let prework = normaliseRunPrework({ entries: [answer(1, 1, 'Faster reviews'), answer(2, 2, '=HYPERLINK("x")'), read(1, 3), question(3, 4, 'Is it safe?', 'Alex')] })

  // Nothing seen yet: every answer and question is new; a read mark is progress, never new.
  assert.equal(newResponseCount(prework), 3)
  assert.equal(isNewEntry(read(1, 3), prework), false)
  let section = answerSection(steps, prework, 10)
  assert.deepEqual(section.steps.map((block) => block.route), ['counts', 'sent', 'local'])
  assert.deepEqual([section.localSteps, section.answerSteps, section.fresh], [1, 2, 3])
  assert.deepEqual(section.steps[2].body, { type: 'local' }, 'a Local only step has nothing to show')
  assert.equal(section.steps[2].sum, 'not collected')
  assert.equal(section.steps[1].fresh, 3, 'the step counts its new answers and the new question about it')

  // Leaving the Run: seen through the latest response; then one later answer arrives and is the only new one.
  const left = applySeenChange(prework, { type: 'leave' }, Date.UTC(2026, 9, 20, 19, 0))
  assert.deepEqual(left.seen, { through: at(4), at: Date.UTC(2026, 9, 20, 19, 0) })
  assert.equal(newResponseCount(left), 0)
  assert.equal(applySeenChange(left, { type: 'leave' }, Date.UTC(2026, 9, 20, 20, 0)), null, 'leaving again with nothing new changes nothing')
  prework = mergeRunPrework(left, [{ ...answer(4, 30, 'Better abstracts'), seq: 9 }])
  assert.deepEqual(prework.seen, left.seen, 'a pull keeps the read state')
  assert.equal(newResponseCount(prework), 1)
  section = answerSection(steps, prework, 10)
  assert.deepEqual(section.steps[1].body.rows.map((row) => [row.text, row.isNew]), [['Faster reviews', false], ['=HYPERLINK("x")', false], ['Better abstracts', true]])

  // A dot keeps a response unread through leaving; Mark all read clears it.
  const oldId = `${person(1)}:answer:hope`
  let kept = applySeenChange(prework, { type: 'keep', id: oldId, unread: true }, at(40))
  assert.deepEqual(kept.unread, [oldId])
  kept = applySeenChange(kept, { type: 'leave' }, at(41))
  assert.equal(kept.seen.through, at(30))
  assert.deepEqual([newResponseCount(kept), kept.unread], [1, [oldId]], 'kept unread survives leaving')
  assert.equal(applySeenChange(kept, { type: 'keep', id: `${person(1)}:read:watch`, unread: true }, at(42)), null, 'a read mark cannot be kept unread')
  const all = applySeenChange(kept, { type: 'all' }, at(43))
  assert.deepEqual([newResponseCount(all), all.unread], [0, undefined])
  assert.deepEqual(normaliseRunPrework(JSON.parse(JSON.stringify(kept))).unread, [oldId], 'the read state is kept on the Run as written')
  assert.equal(normaliseRunPrework({ ...kept, unread: ['not-an-entry'] }).unread, undefined, 'an id that is not on the Run is dropped')

  // Copy and Export: no entry or participant id, no name but a question's own; a spreadsheet formula is made inert.
  section = answerSection(steps, normaliseRunPrework({ ...kept, picks: { hope: { mode: 'picked', ids: [oldId] } } }), 10)
  const csv = answersCsv(section)
  const md = answersMarkdown(section, 'Pre-work answers')
  const text = answersText(section)
  for (const out of [csv, md, text]) {
    for (let n = 1; n <= 4; n += 1) assert.equal(out.includes(person(n)), false, 'no participant id in an export')
    assert.equal(/:answer:|:q:/.test(out), false, 'no entry id in an export')
  }
  assert.equal(csv.split('\r\n')[0], 'step,kind,answer,time,starred,read,name')
  assert.match(csv, /"2 · Open question: What do you hope for\?","answer","Faster reviews","2026-10-20T18:01:00.000Z","yes","no",""/)
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/, 'a leading = is made inert')
  assert.match(csv, /"question","Is it safe\?","[^"]+","no","yes","Alex"/, 'a question keeps the name its person typed')
  assert.match(md, /## 3 · Task: Try a prompt\n\nLocal only: nothing is collected for this step\./)
  assert.match(md, /- ★ Faster reviews/)
  assert.equal(answersText(section, true), '2 · Open question: What do you hope for?\nFaster reviews')
  assert.equal(starredCount(section), 1)
  pass('responses: route per step and a Local only step; new is later than the seen-through mark or kept unread; leaving, a dot and Mark all read; exports carry no participant or entry id')
}

// 9. The timer counts what waits and pulls nothing; the Run page writes its read state (2026-10-19 prework-responses)
{
  const root = mkdtempSync(join(tmpdir(), 'tw-responses-'))
  try {
    persistRunForTalk(root, SLUG, RUN_ID, normaliseRun(plannedRun()))
    let clock = Date.UTC(2026, 9, 2, 12)
    const asked = []
    let waiting = 4
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const fetch = async (url, init = {}) => {
      const path = new URL(url).pathname
      asked.push(`${init.method ?? 'GET'} ${path}${new URL(url).search}`)
      if (path === '/prework') return reply({ preworkId: 'pw00009a', ownerToken: 'owner-token-0123456789-count' }, 201)
      if (path.endsWith('/waiting')) return reply({ seq: 12, waiting })
      if (path.endsWith('/results')) return reply({ entries: [], more: false, seq: 12 })
      return reply({ ok: true })
    }
    const service = createRunPrework({ ownerTokens: testOwnerTokens, registryPath: join(root, 'registry.json'), endpoint: async () => ({ baseUrl: 'https://live.example.test', adminSecret: 'unused' }), vaultRoot: () => root, fetch, now: () => clock })
    await service.publish(SLUG, RUN_ID, definition, { opensAt: Date.UTC(2026, 9, 1, 9), closesAt: Date.UTC(2026, 9, 6, 10) }, 'pre', root)
    asked.length = 0
    const before = JSON.stringify(readRunForTalk(root, SLUG, RUN_ID))
    assert.equal(await service.countDue(), 1)
    assert.deepEqual(asked, ['GET /prework/pw00009a/waiting?after=0'], 'one light request with the owner token, after the cursor; no results downloaded')
    assert.equal(service.status(SLUG, RUN_ID, 'pre').waiting, 4)
    assert.equal(JSON.stringify(readRunForTalk(root, SLUG, RUN_ID)), before, 'the Run is not written by a count')
    assert.equal(await service.countDue(), 0, 'the same count changes nothing')
    // The timer asks for the count and tells main only when it changed.
    let told = 0
    waiting = 6
    const stop = startRunPreworkTimer(service, () => { told += 1 }, 60_000)
    await new Promise((resolve) => setTimeout(resolve, 50))
    stop()
    assert.deepEqual([told, service.status(SLUG, RUN_ID, 'pre').waiting], [1, 6])
    assert.equal(asked.some((line) => line.includes('/results')), false, 'the timer pulls no answers')
    // Opening the Run pulls: the count clears and the pull time is kept.
    clock = Date.UTC(2026, 9, 2, 13)
    assert.equal((await service.pull(SLUG, RUN_ID, 'pre')).ok, true)
    assert.deepEqual([service.status(SLUG, RUN_ID, 'pre').waiting, service.status(SLUG, RUN_ID, 'pre').pulledAt], [undefined, clock])
    // A service from before the count (404) leaves the row as it was.
    const old = createRunPrework({ ownerTokens: testOwnerTokens, registryPath: join(root, 'registry.json'), endpoint: async () => ({ baseUrl: 'https://live.example.test', adminSecret: 'unused' }), vaultRoot: () => root, fetch: async () => reply({ error: { code: 'not_found' } }, 404), now: () => clock })
    assert.equal(await old.countDue(), 0)

    // The read state goes through the Run writer; bad changes are refused in words.
    persistRunForTalk(root, SLUG, RUN_ID, applyRunPrework(readRunForTalk(root, SLUG, RUN_ID), entries()))
    const latest = Math.max(...readRunForTalk(root, SLUG, RUN_ID).prework.entries.filter((candidate) => candidate.kind === 'answer' || candidate.kind === 'question').map((candidate) => candidate.at))
    const left = service.markSeen(SLUG, RUN_ID, { type: 'leave' }, 'pre')
    assert.equal(left.ok, true)
    assert.deepEqual(readRunForTalk(root, SLUG, RUN_ID).prework.seen, { through: latest, at: clock })
    assert.equal(newResponseCount(readRunForTalk(root, SLUG, RUN_ID).prework), 0)
    assert.equal(service.markSeen(SLUG, RUN_ID, { type: 'keep', id: 'x', unread: 'yes' }).ok, false)
    assert.equal(service.markSeen(SLUG, RUN_ID, { type: 'sideways' }).ok, false)
    assert.equal(service.markSeen('../escape', RUN_ID, { type: 'all' }).ok, false)
    assert.equal(service.markSeen(SLUG, 'run-missing', { type: 'all' }).ok, false)
    pass('the timer asks the live service how many responses wait (owner token, after the cursor) and downloads none; a pull clears the count and keeps its time; the read state is written through the Run writer')
  } finally { rmSync(root, { recursive: true, force: true }) }
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\n${results.length} groups passed`)
