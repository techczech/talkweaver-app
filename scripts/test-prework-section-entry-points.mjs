// Work-files ticket 29 (ADR-0040 decision 6, superseding ADR-0032 decision 6): no section-based
// pre-work entry point remains. Replaces test-prework-hidden.mjs (the 0.37 hide-switch test).
//
//   1. Pre-work is on for everyone (ticket 32): the switch, its IPC and its test environment variable
//      are gone, and the Layout Doctor's "Move to a work file" note always shows.
//   2. Nothing in the app writes a talk's `{prework}` section: the Inspector has no "Before the
//      session" section or right-answer writer, and the compiler exports no writer for it.
//   3. History publishes and unpublishes no Run handout and has no pre-work column; Publish and
//      Unpublish are called from the Sessions Run page (and Unpublish from Published pages) only.
//   4. The plan sheet offers a talk's `{prework}` section to no new Run.
//   5. A leftover `{prework}` section: compiled, it is a Layout Doctor note ("Move to a work file"),
//      its slides are left out of every handout and no form is built for it; publishing a Run
//      attached to it publishes no pre-work page.
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyDraftFromRun, draftFromRun, planFromDraft } from '../src/shared/plan-run.ts'
import { createPlannedRun, listRuns, updatePlannedRun } from '../src/main/runs.ts'
import { LEGACY_SECTION_FILE_ID } from '../src/shared/run-work.ts'
import { withoutPreworkSlides } from '../src/shared/run-prework.ts'
import * as preworkLib from '../compiler/scripts/lib/prework.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const read = (path) => readFileSync(join(REPO, path), 'utf8')
function sourcesUnder(dir) {
  const out = []
  for (const name of readdirSync(join(REPO, dir))) {
    const path = join(dir, name)
    if (statSync(join(REPO, path)).isDirectory()) out.push(...sourcesUnder(path))
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(path)
  }
  return out
}
const appSources = ['src/main', 'src/preload', 'src/renderer/src', 'src/shared'].flatMap(sourcesUnder)
const callers = (pattern) => appSources.filter((path) => pattern.test(read(path))).map((path) => relative(REPO, join(REPO, path)).split('\\').join('/')).sort()

// ── 1. Pre-work is on for everyone (ticket 32): no switch remains ─────────────────────────
assert.equal(existsSync(join(REPO, 'src/shared', 'prework' + '-flag.ts')), false, 'the switch module is gone')
// The old names are spelled in pieces so this guard does not itself match a search for them.
const OLD_ENV = ['TW', 'PREWORK'].join('_')
const oldSwitch = new RegExp(['\\bprework' + 'Enabled\\b', 'PREWORK' + '_ENABLED', OLD_ENV, 'prework' + '-flag', 'tools:prework' + '-enabled'].join('|'))
assert.deepEqual(callers(oldSwitch), [], 'no app code asks whether pre-work is on')
assert.deepEqual(['package.json', ...readdirSync(join(REPO, '.github/workflows')).map((name) => `.github/workflows/${name}`)].filter((path) => read(path).includes(OLD_ENV)), [], 'no script or CI job sets the old switch')
// The Layout Doctor's note for a leftover section, with its Move to a work file action, always shows.
assert.equal(/RETIRED_PREWORK_CODE && !/.test(read('src/renderer/src/components/LayoutDoctorPanel.tsx')), false, 'the Layout Doctor never hides the Move to a work file note')

// ── 2. Nothing writes a talk's {prework} section ────────────────────────────────────────────
assert.equal('applyRightAnswerToOutline' in preworkLib, false, 'the compiler exports no right-answer writer')
assert.deepEqual(callers(/applyRightAnswerToOutline|onRightAnswer/), [], 'no app code writes a quick check’s right answer into a talk')
assert.deepEqual(callers(/\bpreworkFromOutline\b/), ['src/shared/run-answers.ts'], 'the section is read only to label an old Run’s answers on its Run page')
const inspectorModelSource = read('src/renderer/src/components/inspectorPreworkModel.ts')
assert.equal(/resultsSteps|preworkFromOutline|preworkRunLine|mode: 'step'|mode: 'section'/.test(inspectorModelSource), false, 'the Inspector model has no section or step mode')
assert.equal(/prework-right-answer|prework-nudge|prework-form"|prework-this-slide|Pre-work needs a planned Run|onRightAnswer|onInspectStep/.test(read('src/renderer/src/components/InspectorPrework.tsx')), false, 'the Inspector draws no Before the session section')
assert.equal(existsSync(join(REPO, 'src/renderer/src/components/usePlannedRuns.ts')), false, 'the Inspector no longer reads planned Runs for a form')

// ── 3. History hands Runs to Sessions ───────────────────────────────────────────────────────
const history = read('src/renderer/src/components/History.tsx')
assert.equal(/window\.tw\.history\.(publishRunHandout|unpublishRunHandout|buildRunHandout)/.test(history), false, 'History calls no Run handout publish, unpublish or build')
assert.equal(/Publish handout for this Run|Unpublish Run handout|PublishNotReadySheet/.test(history), false, 'History shows no Publish or Unpublish for a Run')
assert.equal(/data-plan-prework|data-review-prework|preworkWindow|twh-plan-prework/.test(history), false, 'History has no pre-work column')
assert.match(history, /const openInSessions[\s\S]*?window\.tw\.tools\.openRun\(run\.talkSlug, run\.id\)/, 'History opens a Run in Sessions through the one Tools route')
assert.match(history, /data-planned-run=\{run\.id\} \{\.\.\.opens\}/, 'a planned Run row carries the open-in-Sessions action')
assert.deepEqual(callers(/window\.tw\.history\.publishRunHandout\(/), ['src/renderer/src/components/SessionsView.tsx'], 'Publish for a Run is called from the Sessions Run page only')
assert.deepEqual(callers(/window\.tw\.history\.unpublishRunHandout\(/), ['src/renderer/src/components/PublishedPagesView.tsx', 'src/renderer/src/components/SessionsView.tsx'], 'Unpublish for a Run is called from Sessions and Published pages only')

// ── 4. The plan sheet offers the section to no new Run ──────────────────────────────────────
const sheet = read('src/renderer/src/components/PlanRunSheet.tsx')
assert.equal(/preworkFromOutline|sectionSteps/.test(sheet), false, 'the plan sheet does not read the talk’s section')
assert.match(sheet, /if \(phase === 'pre' && current === LEGACY_SECTION_FILE_ID && run && run\.work\?\.pre\?\.fileId === LEGACY_SECTION_FILE_ID\) \{/, 'the section shows only on a Run being edited that was planned with it, never on a copy or a new Run')
// The planned-Run handlers (history.ts registers them; planned-runs-ipc.ts holds them, the Run written in its talk's vault).
assert.match(read('src/main/history.ts'), /'history:create-planned-run', [^\n]*createPlannedRunIn\(/, 'the create handler is the planned-runs one')
assert.match(read('src/main/history.ts'), /'history:update-planned-run', [^\n]*updatePlannedRunIn\(/, 'the update handler is the planned-runs one')
assert.match(read('src/main/planned-runs-ipc.ts'), /createPlannedRun\(vault\.root, input[^\n]*\{ refuseNewSectionPrework: true \}\)/, 'the create handler refuses the section')
assert.match(read('src/main/planned-runs-ipc.ts'), /updatePlannedRun\(vault\.root, [^\n]*patch as PlannedRunPatch, \{ refuseNewSectionPrework: true \}\)/, 'the update handler refuses it on a Run without it')

// Copy → save: "Plan the next run like this" on a Run planned with the section saves a Run without it.
{
  const vault = mkdtempSync(join(tmpdir(), 'tw-prework-section-copy-'))
  const app = { refuseNewSectionPrework: true }
  const base = { talkSlug: 'leftover', talkTitle: 'Leftover', audience: 'Staff', slideSet: { kind: 'full' }, startTime: '10:00', timeZone: 'Europe/London' }
  createPlannedRun(vault, { ...base, plannedDate: '2026-10-21', eventTitle: 'Old plan', preworkOpens: '2026-10-14T09:00',
    work: { post: { fileId: 'feedback', opens: 'session-end', closes: '2026-11-04T17:00' } } }, () => 'old')
  const old = listRuns(vault, 'leftover').find((run) => run.id === 'old')
  assert.equal(old.work.pre.fileId, LEGACY_SECTION_FILE_ID, 'the old Run reads back with the section as its pre-work')
  const copy = copyDraftFromRun(old, '2026-11-18')
  assert.equal(copy.pre.fileId, '', 'the copy has no pre-work')
  const plan = planFromDraft(copy, { phases: true, editing: false })
  assert(plan.ok)
  const saved = createPlannedRun(vault, { ...base, ...plan.fields, timeZone: 'Europe/London' }, () => 'next', app)
  assert.equal('preworkOpens' in saved || 'preworkCloses' in saved, false, 'the new Run carries no old window fields')
  assert.equal(saved.work?.pre, undefined, 'the new Run has no pre-work attachment')
  assert.equal(saved.work.post.fileId, 'feedback', 'post-work is copied')
  assert.equal(listRuns(vault, 'leftover').find((run) => run.id === 'next').work.pre, undefined, 'read back, still no section')
  // A renderer that sends the old fields anyway is refused.
  assert.throws(() => createPlannedRun(vault, { ...base, ...plan.fields, preworkOpens: '2026-11-11T09:00' }, () => 'forced', app), /^Error: prework-section-retired$/)
  assert.throws(() => updatePlannedRun(vault, 'leftover', 'next', { preworkOpens: '2026-11-11T09:00' }, app), /^Error: prework-section-retired$/)
  // Editing the old Run keeps it, and its times can still change.
  const edit = planFromDraft({ ...draftFromRun(old, new Date()), pre: { ...draftFromRun(old, new Date()).pre, opens: '2026-10-15T09:00' } }, { phases: true, editing: true })
  assert(edit.ok)
  const retimed = updatePlannedRun(vault, 'leftover', 'old', edit.fields, app)
  assert.equal(retimed.preworkOpens, '2026-10-15T09:00', 'an old Run’s section times stay editable')
}

// ── 5. A leftover {prework} section ─────────────────────────────────────────────────────────
const outline = [
  '---', 'title: Leftover', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '## Before the session', '{id=pwform}{prework}', '', 'Two steps.', '',
  '### Quick check', '{poll=single}{id=pwquiz}{check}', '', '- One', '- Two {right}', '',
  '### A task', '{id=pwtask}{task}', '', '- Do it', '',
  '## The talk', '{id=talk}', '',
  '### A slide', '{id=s1}', '', '- Text', ''
].join('\n')
const model = await prepareSource('/tmp/prework-section-leftover.md', outline, 'leftover')
assert.ok(model.warnings.includes('prework-section-retired:pwform'), 'Layout Doctor names the section (with its Move to a work file action)')
assert.deepEqual([...(model.prework?.slideIds ?? [])].sort(), ['pwform', 'pwquiz', 'pwtask'], 'the section and its steps are known to the compiler')
const slides = withoutPreworkSlides(extractSlides(model.fullHtml), model.prework)
assert.deepEqual(slides.map((slide) => slide.id).filter((id) => ['pwform', 'pwquiz', 'pwtask'].includes(id)), [], 'no section slide reaches a handout')
const html = buildShareHtml({ title: 'Leftover', slides, styles: extractStyles(model.fullHtml), includeNotes: false, slug: 'leftover', workerBaseUrl: 'https://live.example.test' })
assert.equal(/PREWORK_CONFIG = \{|preworkSteps|createPreworkForm|\{right\}/.test(html), false, 'the handout carries no form and no right answer')
assert.equal(existsSync(join(REPO, 'compiler/assets/runtime/prework-status.js')), false, 'the handout’s pre-work status runtime is gone')
assert.match(read('src/main/run-work-publish.ts'), /if \(work\.fileId === LEGACY_SECTION_FILE_ID\) \{ warning = WORK_LEGACY_NOT_PUBLISHED; continue \}/, 'a Run attached to the section publishes no pre-work page')

console.log('PASS pre-work section entry points: no pre-work switch remains; nothing writes or offers a {prework} section; History hands Runs to Sessions; a leftover section is a Layout Doctor note and never published')
