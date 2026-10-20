// Work-files ticket 27: a board slide fed by a work-file step (`{results=<file id>/<step id>}`).
//   1. the token in the compiler: parsed, a feed with its file id (with or without a pre-work section),
//      a malformed value is a finding, the old section form is untouched, the Doctor's pattern accepts it;
//   2. the pure seed (src/shared/results-seed.ts), one case per edge: starred answers open (pick order),
//      all answers when none starred, file not attached, not sent, step missing in the PINNED revision,
//      no answers, over the board's cap, the same file pre in one Run and post in another;
//   3. the glue against a temp vault with a real pin: the pinned copy is read, not the current file
//      (a step removed or added after the pin changes nothing); nothing throws; a window's seed is dropped;
//   4. authoring-time findings against the vault's current files;
//   5. (2026-10-19 prework-responses) going live pulls first: answers waiting on the live service seed the board
//      through the Run page's own pull and cursor; offline or slow, the board opens with what is on disk.
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-results-seed.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseResultsToken, preworkFeedsFromTree, preworkFindings, preworkOutlineTree } from '../compiler/scripts/lib/prework.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { WARNING_REGISTRY, formatWarning } from '../compiler/scripts/lib/warning-registry.mjs'
import { OPEN_PATTERN_TOKENS } from '../src/shared/layout-registry/entries.ts'
import { feedsForStep, stepFeedingSlide, workFeedFor } from '../src/shared/run-prework-results.ts'
import { resultsAuthoringFindings, resultsBoardSeed } from '../src/shared/results-seed.ts'
import { createPlannedRun, persistRunForTalk, readRunForTalk, setRunPreworkPick } from '../src/main/runs.ts'
import { pinRunWork } from '../src/main/run-work-pin.ts'
import { seedBoardFromWork, seedPollForRun } from '../src/main/run-prework-seed.ts'
import { createRunPrework } from '../src/main/run-prework.ts'
import { memoryOwnerTokens } from './lib/memory-secrets.mjs'
import { parsePollDefinition } from '../worker/protocol.ts'
import { BOARD_SEED_MAX } from '../worker/board-protocol.ts'

let passed = 0
const pass = (name) => { passed += 1; console.log(`ok - ${name}`) }
const scratch = mkdtempSync(join(tmpdir(), 'tw-results-seed-'))

// 1. The token in the compiler ------------------------------------------------------------------
const TALK = (token) => ['---', 'title: Intake talk', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '## Your turn', '{id=turn}', '',
  '### What do you want?', `{poll=board}{results=${token}}{id=wants}`, '', 'Add yours.', '', '- Hopes', '- Worries', ''].join('\n')
async function compile(name, text) {
  const path = join(scratch, `${name}.md`)
  writeFileSync(path, text)
  return prepareSource(path, text, name, statSync(path))
}
{
  assert.deepEqual(parseResultsToken('intake/what-you-want'), { fileId: 'intake', stepId: 'what-you-want' })
  assert.deepEqual(parseResultsToken('pwhope'), { fileId: null, stepId: 'pwhope' }, 'no slash: the 0.37 section form')
  for (const bad of ['Intake/x', 'intake/', '/x', 'a/b/c', 'intake/what you', '']) assert.equal(parseResultsToken(bad), null, `"${bad}" is not a work-file step`)
  const model = await compile('ok', TALK('research-teams-intake/what-you-want'))
  assert.equal(model.prework, undefined, 'a talk with no pre-work section')
  assert.deepEqual(model.resultsFeeds.map(({ number, ...feed }) => feed), [{ stepId: 'what-you-want', fileId: 'research-teams-intake', slideId: 'wants', title: 'What do you want?' }])
  assert.ok(model.resultsFeeds[0].number > 0)
  assert.deepEqual((model.warnings || []).filter((w) => /results/.test(w)), [], 'no finding for a well-formed work-file step')
  const bad = await compile('bad', TALK('a/b/c'))
  assert.ok(bad.warnings.includes('prework-results-invalid:wants:a/b/c'), 'malformed value is a Doctor finding')
  assert.equal(bad.resultsFeeds, undefined, 'and feeds nothing')
  const legacy = await compile('legacy', TALK('nope'))
  assert.ok(legacy.warnings.includes('prework-results-unknown:wants:nope'), 'the section form keeps its own finding')
  assert.match(formatWarning('prework-results-invalid:wants:a/b/c'), /a\/b\/c/)
  const pattern = new RegExp(`^(?:${OPEN_PATTERN_TOKENS.find((t) => t.key === 'results').pattern})$`)
  assert.ok(pattern.test('intake/step-1') && pattern.test('pwhope') && !pattern.test('a/b/c'), 'the registry pattern admits both forms')
  const tree = preworkOutlineTree(TALK('intake/s'))
  assert.deepEqual(preworkFeedsFromTree(tree).map((f) => f.fileId), ['intake'])
  assert.deepEqual(preworkFindings(tree), [])
  for (const code of ['prework-results-invalid', 'results-file-not-attached', 'results-file-not-sent', 'results-step-missing', 'results-no-answers', 'results-over-cap', 'results-work-unknown', 'results-work-step-unknown', 'results-vault-unavailable', 'results-section-step-on-file-run']) {
    assert.ok(WARNING_REGISTRY.some((w) => w.id === code), `${code} is registered`)
  }
  // Feeds are file-aware: a work-file feed never reads as a section step, and the reverse.
  const feeds = [{ stepId: 's', fileId: 'f', slideId: 'a', title: 'A' }, { stepId: 's', slideId: 'b', title: 'B' }]
  assert.equal(stepFeedingSlide(feeds, 'a'), null)
  assert.equal(stepFeedingSlide(feeds, 'b'), 's')
  assert.deepEqual(feedsForStep(feeds, 's', 'f').map((f) => f.slideId), ['a'])
  assert.deepEqual(feedsForStep(feeds, 's', undefined).map((f) => f.slideId), ['b'])
  assert.deepEqual(feedsForStep(feeds, 's', 'legacy-section').map((f) => f.slideId), ['b'])
  assert.equal(workFeedFor(feeds, 'a').fileId, 'f')
  assert.equal(workFeedFor(feeds, 'b'), null)
  pass('the token: parsed, fed, malformed is a finding, section form untouched, registry accepts it')
}

// 2. The pure seed ---------------------------------------------------------------------------------
const pin = (fileId) => ({ fileId, title: 'T', revision: 1, sha256: 'a'.repeat(64), copy: 'x', pinnedAt: '2026-10-01T00:00:00.000Z' })
const attach = (phase, fileId = 'intake', pinned = true) => ({ [phase]: { fileId, opens: '2026-10-01T09:00', closes: '2026-10-05T09:00', timeZone: 'Europe/London', ...(pinned ? { pinned: pin(fileId) } : {}) } })
const who = (n) => n.toString(16).padStart(16, '0')
const answer = (n, text) => ({ id: `${who(n)}:answer:what`, participant: who(n), stepId: 'what', kind: 'answer', at: n, text })
const answers = (texts) => ({ entries: texts.map((t, i) => answer(i + 1, t)) })
const base = { fileId: 'intake', stepId: 'what', slideId: 'wants', work: attach('pre'), pinnedSteps: { pre: ['what', 'try'] }, answers: { pre: answers(['one', 'two', 'three']) } }
{
  const all = resultsBoardSeed(base)
  assert.deepEqual(all.texts, ['one', 'two', 'three'])
  assert.equal(all.phase, 'pre'); assert.equal(all.finding, null)
  const starred = resultsBoardSeed({ ...base, answers: { pre: { ...answers(['one', 'two', 'three']), picks: { what: { mode: 'picked', ids: [`${who(3)}:answer:what`, `${who(1)}:answer:what`] } } } } })
  assert.deepEqual(starred.texts, ['three', 'one'], 'starred answers open, in pick order')
  assert.equal(resultsBoardSeed({ ...base, cardChars: 3 }).texts[0], 'one')
  assert.deepEqual(resultsBoardSeed({ ...base, cardChars: 2, answers: { pre: answers(['abcdef']) } }).texts, ['ab'], 'cut to the card length')
  pass('starred answers open the board; every answer when none is starred')
}
{
  const none = resultsBoardSeed({ ...base, work: attach('pre', 'other') })
  assert.deepEqual([none.texts, none.finding.code], [[], 'results-file-not-attached'])
  assert.equal(resultsBoardSeed({ ...base, work: undefined }).finding.code, 'results-file-not-attached', 'a Run with no work at all')
  assert.equal(resultsBoardSeed({ ...base, work: attach('pre', 'intake', false) }).finding.code, 'results-file-not-sent', 'attached, never pinned')
  const missing = resultsBoardSeed({ ...base, pinnedSteps: { pre: ['try'] } })
  assert.deepEqual([missing.texts, missing.finding.code, missing.finding.slideId], [[], 'results-step-missing', 'wants'])
  assert.equal(resultsBoardSeed({ ...base, pinnedSteps: { pre: null } }).finding.code, 'results-step-missing', 'a pinned copy that cannot be read')
  assert.equal(resultsBoardSeed({ ...base, pinnedSteps: {} }).finding.code, 'results-step-missing')
  assert.equal(resultsBoardSeed({ ...base, answers: { pre: answers([]) } }).finding.code, 'results-no-answers')
  assert.equal(resultsBoardSeed({ ...base, answers: {} }).finding.code, 'results-no-answers', 'no answers section at all')
  assert.equal(resultsBoardSeed({ ...base, answers: { pre: answers(['  ', '']) } }).finding.code, 'results-no-answers', 'blank answers are no answers')
  const nonePicked = resultsBoardSeed({ ...base, answers: { pre: { ...answers(['one']), picks: { what: { mode: 'picked', ids: [] } } } } })
  assert.equal(nonePicked.finding.code, 'results-no-answers', '"only the ones I pick" with nothing picked: an empty board')
  assert.equal(resultsBoardSeed({ ...base, answers: { pre: { entries: [{ ...answer(1, 'x'), stepId: 'try' }] } } }).finding.code, 'results-no-answers', 'another step\'s answers are not this step\'s')
  pass('file not attached, not sent, step missing in the pinned revision, no answers: an empty board and a finding')
}
{
  const many = Array.from({ length: BOARD_SEED_MAX + 25 }, (_, i) => `Answer number ${i + 1}`)
  const capped = resultsBoardSeed({ ...base, answers: { pre: answers(many) } })
  assert.ok(capped.texts.length > 0 && capped.texts.length <= BOARD_SEED_MAX)
  assert.equal(capped.finding.code, 'results-over-cap')
  const [, total, fits] = capped.finding.detail.split(':')
  assert.deepEqual([Number(total), Number(fits)], [many.length, capped.texts.length])
  assert.deepEqual(capped.texts, many.slice(0, capped.texts.length), 'the first answers, in order')
  assert.match(formatWarning(`over:${capped.finding.slideId}:${capped.finding.detail}`.replace('over', 'results-over-cap')), /first \d+ are used/)
  assert.equal(resultsBoardSeed({ ...base, answers: { pre: answers(many.slice(0, 40)) } }).finding, null, 'under the cap: no finding')
  pass('more answers than the board holds: the first that fit, with a finding')
}
{
  // The same file is pre-work in one Run and post-work in another: each Run reads its own phase.
  const postRun = { ...base, work: attach('post'), pinnedSteps: { post: ['what'] }, answers: { pre: answers(['pre answer']), post: answers(['post answer']) } }
  assert.deepEqual(resultsBoardSeed(postRun).texts, ['post answer'])
  assert.equal(resultsBoardSeed(postRun).phase, 'post')
  assert.deepEqual(resultsBoardSeed({ ...base, answers: { pre: answers(['pre answer']), post: answers(['post answer']) } }).texts, ['pre answer'], 'the pre-work Run ignores post answers')
  // Both phases carry the file in one Run: the phase with answers; post when both have them.
  const both = { ...base, work: { ...attach('pre'), ...attach('post') }, pinnedSteps: { pre: ['what'], post: ['what'] } }
  assert.deepEqual(resultsBoardSeed({ ...both, answers: { pre: answers(['p']), post: answers(['q']) } }).texts, ['q'])
  assert.deepEqual(resultsBoardSeed({ ...both, answers: { pre: answers(['p']) } }).texts, ['p'])
  pass('the same file pre-work in one Run and post-work in another reads each Run\'s own phase')
}

// 3. The glue against a temp vault with a real pin ------------------------------------------------------
const FILE = (steps) => ['---', 'id: intake', 'title: Intake', 'revision: 1', '---', 'Before we meet.', '', ...steps].join('\n')
const STEP_WHAT = ['### What do you want?', '{id=what}{poll=open}', '']
const STEP_TRY = ['### Try one prompt', '{id=try}{task}', '']
const root = mkdtempSync(join(tmpdir(), 'tw-results-seed-vault-'))
try {
  mkdirSync(join(root, 'Work files'), { recursive: true })
  const filePath = join(root, 'Work files', 'intake.md')
  writeFileSync(filePath, FILE([...STEP_WHAT, ...STEP_TRY]))
  createPlannedRun(root, { talkSlug: 'intake-talk', talkTitle: 'Intake talk', timeZone: 'Europe/London', plannedDate: '2026-10-06', startTime: '10:00', eventTitle: 'Briefing', audience: '', slideSet: { kind: 'full' },
    work: { pre: { fileId: 'intake', opens: '2026-09-22T09:00' } } }, () => 'r1')
  createPlannedRun(root, { talkSlug: 'intake-talk', talkTitle: 'Intake talk', timeZone: 'Europe/London', plannedDate: '2026-10-06', startTime: '10:00', eventTitle: 'Other', audience: '', slideSet: { kind: 'full' } }, () => 'r2')
  createPlannedRun(root, { talkSlug: 'intake-talk', talkTitle: 'Intake talk', timeZone: 'Europe/London', plannedDate: '2026-10-06', startTime: '10:00', eventTitle: 'Third', audience: '', slideSet: { kind: 'full' },
    work: { pre: { fileId: 'another-file', opens: '2026-09-22T09:00' } } }, () => 'r3')
  const outline = TALK('intake/what')
  const deps = (extra = {}) => ({ vaultReadable: (vault) => vault === root, readOutline: () => outline, feeds: async (text) => (await compile('glue', text)).resultsFeeds ?? null, ...extra })
  const board = parsePollDefinition({ pollId: 'poll-wants', slideId: 'wants', type: 'board', question: 'What do you want?', visibility: 'live',
    options: [{ optionId: 'poll-wants-option-1', label: 'Hopes' }, { optionId: 'poll-wants-option-2', label: 'Worries' }] })
  const bound = { talkSlug: 'intake-talk', runId: 'r1', vaultRoot: root }
  const findings = []
  const seedWith = (poll = board, run = bound, extra = {}) => seedPollForRun(poll, run, deps({ onFinding: (f) => findings.push(f.code), ...extra }))

  assert.equal((await seedWith()).seed, undefined, 'attached but not yet pinned: empty, with a finding')
  assert.deepEqual(findings, ['results-file-not-sent'])
  pinRunWork(root, 'intake-talk', 'r1', 'pre')
  // Answers arrive on the Run, as the app mirrors them from the Worker.
  let run = readRunForTalk(root, 'intake-talk', 'r1')
  run = { ...run, prework: { entries: [answer(1, 'More time'), answer(2, 'Clear examples'), answer(3, 'A reading list')] } }
  persistRunForTalk(root, 'intake-talk', 'r1', run)
  findings.length = 0
  const seeded = await seedWith()
  assert.deepEqual(seeded.seed.map((c) => c.text), ['More time', 'Clear examples', 'A reading list'])
  assert.ok(seeded.seed.every((c) => c.column === 'poll-wants-option-1'), 'into the first column')
  run = setRunPreworkPick(readRunForTalk(root, 'intake-talk', 'r1'), 'what', { mode: 'picked', ids: [`${who(2)}:answer:what`] })
  persistRunForTalk(root, 'intake-talk', 'r1', run)
  assert.deepEqual((await seedWith()).seed.map((c) => c.text), ['Clear examples'], 'the starred answer opens alone')

  // The file is edited after the pin: the step goes, another arrives. The Run still reads its pinned revision.
  writeFileSync(filePath, FILE([...STEP_TRY, '### Brand new', '{id=brand-new}{poll=open}', '']))
  findings.length = 0
  assert.deepEqual((await seedWith()).seed.map((c) => c.text), ['Clear examples'], 'the step is looked up in the pinned revision, not the current file')
  assert.deepEqual(findings, [])
  const newer = await seedPollForRun(board, bound, deps({ readOutline: () => TALK('intake/brand-new'), onFinding: (f) => findings.push(f.code) }))
  assert.equal(newer.seed, undefined, 'a step only the current file has is missing from the pinned revision')
  assert.deepEqual(findings, ['results-step-missing'])

  // Edge cases through the glue: never a crash, an empty board.
  findings.length = 0
  assert.equal((await seedWith(board, { ...bound, runId: 'r2' })).seed, undefined, 'a Run with no work: empty (nothing is compiled for it)')
  assert.equal((await seedWith(board, { ...bound, runId: 'r3' })).seed, undefined, 'a Run that carries another file')
  assert.equal((await seedWith(board, { talkSlug: 'intake-talk' })).seed, undefined, 'no Run bound')
  assert.equal((await seedWith(board, { ...bound, runId: 'gone' })).seed, undefined, 'a Run that is gone')
  assert.deepEqual(findings, ['results-file-not-attached'], 'a Run without the file says so')
  assert.equal((await seedWith(board, bound, { feeds: async () => { throw new Error('boom') } })).seed, undefined, 'a talk that cannot be compiled')
  assert.equal((await seedWith(board, bound, { onFinding: () => { throw new Error('boom') }, readOutline: () => TALK('intake/brand-new') })).seed, undefined, 'a failing reporter never blocks a board')
  assert.equal((await seedWith(board, bound, { pinnedSteps: () => { throw new Error('boom') } })).seed, undefined, 'a pinned copy that cannot be read')
  const windowSeed = { ...board, seed: [{ column: 'poll-wants-option-1', text: 'From a window' }] }
  assert.equal((await seedWith(windowSeed, { talkSlug: 'intake-talk' })).seed, undefined, 'a window\'s own seed never survives')
  const unfed = await seedWith({ ...board, slideId: 'other' })
  assert.equal(unfed.seed, undefined, 'a board no step feeds')
  const direct = seedBoardFromWork(windowSeed, readRunForTalk(root, 'intake-talk', 'r1'), [], () => null)
  assert.equal(direct.poll.seed, undefined, 'seedBoardFromWork drops a handed seed too')
  pass('the glue: the pinned copy is read, never the current file; every edge opens an empty board; a window\'s seed is dropped')

  // Vault identity: the session's own vault, never another with the same talk slug and Run id.
  const other = mkdtempSync(join(tmpdir(), 'tw-results-seed-vault-b-'))
  try {
    mkdirSync(join(other, 'Work files'), { recursive: true })
    writeFileSync(join(other, 'Work files', 'intake.md'), FILE([...STEP_WHAT, ...STEP_TRY]))
    createPlannedRun(other, { talkSlug: 'intake-talk', talkTitle: 'Intake talk', timeZone: 'Europe/London', plannedDate: '2026-10-06', startTime: '10:00', eventTitle: 'Briefing', audience: '', slideSet: { kind: 'full' },
      work: { pre: { fileId: 'intake', opens: '2026-09-22T09:00' } } }, () => 'r1')
    pinRunWork(other, 'intake-talk', 'r1', 'pre')
    persistRunForTalk(other, 'intake-talk', 'r1', { ...readRunForTalk(other, 'intake-talk', 'r1'), prework: { entries: [answer(9, 'PRIVATE ANSWER FROM B')] } })
    const onlyB = { vaultReadable: (vault) => vault === other }
    // B alone is readable: on its own terms it would seed.
    assert.deepEqual((await seedWith(board, { ...bound, vaultRoot: other }, onlyB)).seed.map((c) => c.text), ['PRIVATE ANSWER FROM B'], 'a session bound to B reads B')
    findings.length = 0
    assert.equal((await seedWith(board, bound, onlyB)).seed, undefined, 'bound to A, A closed, B open with the same talk and Run id: nothing from B')
    assert.deepEqual(findings, ['results-vault-unavailable'])
    findings.length = 0
    assert.equal((await seedWith(board, { ...bound, vaultRoot: null }, { vaultReadable: () => true })).seed, undefined, 'a session that recorded no vault: empty')
    assert.deepEqual(findings, ['results-vault-unavailable'])
    findings.length = 0
    assert.equal((await seedWith({ ...board, slideId: 'other' }, bound, onlyB)).seed, undefined)
    assert.deepEqual(findings, [], 'a board no step feeds says nothing when the vault is closed')
    const both = { vaultReadable: (vault) => vault === root || vault === other }
    assert.deepEqual((await seedWith(board, bound, both)).seed.map((c) => c.text), ['Clear examples'], 'both open: the session\'s own vault, not the first one')
  } finally { rmSync(other, { recursive: true, force: true }) }
  pass('vault identity: a session bound to a closed vault seeds nothing from another vault with the same talk and Run id')

  // The 0.37 section form seeds only a section-backed Run, never a Run whose pre-work is a work file.
  const SECTION_TALK = (token) => ['---', 'title: Intake talk', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
    '## Before the session', '{id=pwform}{prework}', '', 'One step.', '',
    '### What do you hope to get out of the session?', '{poll=open}{id=pwhope}', '',
    '## Your turn', '{id=turn}', '',
    '### What do you want?', `{poll=board}{results=${token}}{id=wants}`, '', 'Add yours.', '', '- Hopes', '- Worries', ''].join('\n')
  const hope = (n, text) => ({ id: `${who(n)}:answer:pwhope`, participant: who(n), stepId: 'pwhope', kind: 'answer', at: n, text })
  createPlannedRun(root, { talkSlug: 'intake-talk', talkTitle: 'Intake talk', timeZone: 'Europe/London', plannedDate: '2026-10-06', startTime: '10:00', eventTitle: 'File run', audience: '', slideSet: { kind: 'full' },
    work: { pre: { fileId: 'intake', opens: '2026-09-22T09:00' } } }, () => 'r4')
  persistRunForTalk(root, 'intake-talk', 'r4', { ...readRunForTalk(root, 'intake-talk', 'r4'), prework: { entries: [hope(1, 'File answer under pwhope')] } })
  createPlannedRun(root, { talkSlug: 'intake-talk', talkTitle: 'Intake talk', timeZone: 'Europe/London', plannedDate: '2026-10-06', startTime: '10:00', eventTitle: 'Section run', audience: '', slideSet: { kind: 'full' } }, () => 'r5')
  persistRunForTalk(root, 'intake-talk', 'r5', { ...readRunForTalk(root, 'intake-talk', 'r5'), prework: { entries: [hope(2, 'Section answer')] } })
  const sectionDeps = (token) => ({ readOutline: () => SECTION_TALK(token), onFinding: (f) => findings.push(f.code) })
  findings.length = 0
  assert.equal((await seedPollForRun(board, { ...bound, runId: 'r4' }, deps(sectionDeps('intake/pwhope')))).seed, undefined, 'file step, no readable pin: empty')
  assert.deepEqual(findings, ['results-file-not-sent'])
  findings.length = 0
  assert.equal((await seedPollForRun(board, { ...bound, runId: 'r4' }, deps(sectionDeps('pwhope')))).seed, undefined, 'section form on a work-file Run: the file answers are not published')
  assert.deepEqual(findings, ['results-section-step-on-file-run'])
  assert.deepEqual((await seedPollForRun(board, { ...bound, runId: 'r5' }, deps(sectionDeps('pwhope')))).seed.map((c) => c.text), ['Section answer'], 'a 0.37 Run with no attachment still seeds')
  persistRunForTalk(root, 'intake-talk', 'r5', { ...readRunForTalk(root, 'intake-talk', 'r5'), preworkOpens: '2026-09-22T09:00', preworkCloses: '2026-10-06T10:00' })
  assert.equal(readRunForTalk(root, 'intake-talk', 'r5').work?.pre?.fileId, 'legacy-section', 'the 0.39 window reads as the legacy-section attachment')
  assert.deepEqual((await seedPollForRun(board, { ...bound, runId: 'r5' }, deps(sectionDeps('pwhope')))).seed.map((c) => c.text), ['Section answer'], 'a legacy-section Run still seeds')
  pass('legacy fallback: {results=<step>} seeds only a section-backed Run; a Run carrying a work file opens empty under either form')

  // 5. Going live pulls first (2026-10-19 prework-responses): the timer only counts, so the Run on disk may lag.
  {
    writeFileSync(filePath, FILE([...STEP_WHAT, ...STEP_TRY]))
    createPlannedRun(root, { talkSlug: 'intake-talk', talkTitle: 'Intake talk', timeZone: 'Europe/London', plannedDate: '2026-10-06', startTime: '10:00', eventTitle: 'Waiting', audience: '', slideSet: { kind: 'full' },
      work: { pre: { fileId: 'intake', opens: '2026-09-22T09:00' } } }, () => 'r6')
    pinRunWork(root, 'intake-talk', 'r6', 'pre')
    persistRunForTalk(root, 'intake-talk', 'r6', { ...readRunForTalk(root, 'intake-talk', 'r6'), prework: { entries: [answer(1, 'Already on disk')] } })
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    let mode = 'online'
    const asked = []
    const waiting = [{ ...answer(2, 'Sent this morning'), seq: 2 }, { ...answer(3, 'Sent an hour ago'), seq: 3 }]
    const fetch = async (url) => {
      const where = new URL(url)
      asked.push(`${where.pathname}${where.search}`)
      if (where.pathname === '/prework') return reply({ preworkId: 'pw0000r6', ownerToken: 'owner-token-0123456789-r6' }, 201)
      if (where.pathname.endsWith('/results')) {
        if (mode === 'offline') throw new TypeError('fetch failed')
        if (mode === 'slow') return new Promise((resolve) => setTimeout(() => resolve(reply({ entries: [], more: false, seq: 0, phase: 'pre' })), 300))
        const after = Number(where.searchParams.get('after'))
        return reply({ entries: waiting.filter((entry) => entry.seq > after), more: false, seq: 3, phase: 'pre' })
      }
      return reply({ ok: true })
    }
    const now = Date.UTC(2026, 9, 1, 12)
    const service = createRunPrework({ ownerTokens: memoryOwnerTokens(), registryPath: join(root, 'registry-r6.json'), endpoint: async () => ({ baseUrl: 'https://live.example.test', adminSecret: 'unused' }), vaultRoot: () => root, fetch, now: () => now })
    await service.publish('intake-talk', 'r6', { steps: [] }, { opensAt: Date.UTC(2026, 8, 22, 8), closesAt: Date.UTC(2026, 9, 6, 9) }, 'pre', root)
    const live = { talkSlug: 'intake-talk', runId: 'r6', vaultRoot: root }
    const goLive = (extra = {}) => seedPollForRun(board, live, deps({ pull: (talkSlug, runId, phase, vaultRoot) => service.pull(talkSlug, runId, phase, vaultRoot), ...extra }))

    // Offline: the board opens with what is on disk, and nothing is lost.
    mode = 'offline'
    assert.deepEqual((await goLive()).seed.map((c) => c.text), ['Already on disk'], 'offline: what is on disk')
    // Slow: the board does not wait for ever.
    mode = 'slow'
    const started = Date.now()
    assert.deepEqual((await goLive({ pullWaitMs: 50 })).seed.map((c) => c.text), ['Already on disk'], 'a slow service: what is on disk, after a short wait')
    assert.ok(Date.now() - started < 2_000)
    // Online: the answers waiting on the live service are pulled through the Run page's cursor and seed the board.
    mode = 'online'
    const fresh = await goLive()
    assert.deepEqual(fresh.seed.map((c) => c.text), ['Already on disk', 'Sent this morning', 'Sent an hour ago'], 'every answer sent so far opens the board')
    assert.ok(asked.includes('/prework/pw0000r6/results?after=0'), 'the pull starts from the Run\'s cursor')
    assert.equal(readRunForTalk(root, 'intake-talk', 'r6').prework.entries.length, 3, 'the pulled answers are kept on the Run')
    asked.length = 0
    await goLive()
    assert.ok(asked.includes('/prework/pw0000r6/results?after=3'), 'the next pull goes on from where the last one stopped')
    // A board no step feeds pulls nothing.
    asked.length = 0
    await goLive({ readOutline: () => outline.replace('{results=intake/what}', '') })
    assert.equal(asked.length, 0, 'an ordinary board opens without asking the live service')
    pass('going live pulls first: answers waiting on the live service seed the board through the Run page\'s pull and cursor; offline or slow it opens with what is on disk')
  }
} finally { rmSync(root, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true }) }

// 4. Authoring time -----------------------------------------------------------------------------------------
{
  const feeds = [{ stepId: 'what', fileId: 'intake', slideId: 'a' }, { stepId: 'gone', fileId: 'intake', slideId: 'b' }, { stepId: 'x', fileId: 'nofile', slideId: 'c' }, { stepId: 'pwhope', slideId: 'd' }]
  assert.deepEqual(resultsAuthoringFindings(feeds, { intake: ['what', 'try'] }), [
    { code: 'results-work-step-unknown', slideId: 'b', detail: 'intake:gone' },
    { code: 'results-work-unknown', slideId: 'c', detail: 'nofile' }
  ])
  assert.deepEqual(resultsAuthoringFindings(null, {}), [])
  assert.deepEqual(resultsAuthoringFindings(feeds, { constructor: [] }).map((f) => f.code).slice(0, 1), ['results-work-unknown'], 'a file id like an Object property is just unknown')
  assert.match(formatWarning('results-work-step-unknown:b:intake:gone'), /gone/)
  pass('authoring time: an unknown file or step is a finding; the talk\'s own pre-work steps are left alone')
}
console.log(`${passed} passed`)
