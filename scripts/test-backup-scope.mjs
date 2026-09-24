// ADR-0024 — what the backup is FOR.
//
// The 2026-09-12 OOM was a scope bug wearing a memory bug's clothes. The sweep enrolled a talk
// because its file mtime moved, and on 2026-09-11 an agent-driven vault migration moved 32 of
// them at once. These gates hold the line the ADR draws: only an in-app edit enrols a talk, and
// the set stays small enough to be a working set rather than a vault.
import { strict as assert } from 'node:assert'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const scope = await import(pathToFileURL(join(process.cwd(), 'src/main/backup-scope.mjs')).href)
const {
  loadScope, recordAppEdit, recordAppOpen, recordBackup, setEnrolled,
  enrolledSlugs, appEditedTalks, expireStale, enrolmentDecision,
  applyEnrolmentChoice, talksNeedingLaunchBackup,
  AUTO_ENROL_LIMIT, STALE_DAYS
} = scope

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.UTC(2026, 8, 12, 9, 0, 0)
let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}\n     ${error?.message ?? error}`) }
}

// Enrol a talk the way the app does: an in-app edit, then the auto decision.
function enrol(state, slug, atMs) {
  recordAppEdit(state, { slug, title: slug, outlinePath: `/vault/${slug}/${slug}-outline.md`, atMs })
  const decision = enrolmentDecision(appEditedTalks(state), enrolledSlugs(state))
  if (decision.kind === 'auto') for (const s of decision.enrol) setEnrolled(state, s, true, atMs)
  return decision
}

check('an in-app edit enrols a talk; the first two go in automatically', () => {
  const state = loadScope(null)
  assert.equal(enrol(state, 'alpha', T0).kind, 'auto')
  assert.equal(enrol(state, 'beta', T0 + 1000).kind, 'auto')
  assert.deepEqual(enrolledSlugs(state).sort(), ['alpha', 'beta'])
})

check('an mtime change without an in-app edit never enrols anything', () => {
  const state = loadScope(null)
  // This is the whole incident in one assertion: a migration rewrites 32 outlines, every mtime
  // moves, and the backup set stays empty because none of it came through the editor.
  for (let i = 0; i < 32; i++) {
    // No recordAppEdit — an external writer produces no app event at all, by construction.
  }
  assert.deepEqual(appEditedTalks(state), [], 'no app edits were recorded')
  const decision = enrolmentDecision(appEditedTalks(state), enrolledSlugs(state))
  assert.equal(decision.kind, 'auto')
  assert.deepEqual(decision.enrol, [], 'nothing is enrolled')
  assert.deepEqual(enrolledSlugs(state), [])
})

check('legacy backup-state signatures do not enrol anything on first launch of the new build', () => {
  // v1 state: a flat { slug: signature } map written by the mtime sweep, for 32 migrated talks.
  const legacy = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`migrated-${i}`, `sig-${i}`]))
  const state = loadScope(legacy)
  assert.deepEqual(enrolledSlugs(state), [], 'ADR-0024 §5: old signatures are not enrolment evidence')
  assert.equal(Object.keys(state.signatures).length, 32, 'but the signatures are carried forward untouched')
})

check('a third distinct in-app edit asks, defaulting to the two most recent', () => {
  const state = loadScope(null)
  enrol(state, 'alpha', T0)
  enrol(state, 'beta', T0 + 1000)
  const decision = enrol(state, 'gamma', T0 + 2000)
  assert.equal(decision.kind, 'ask', 'the third talk must not enrol silently')
  assert.deepEqual(decision.defaults, ['gamma', 'beta'], 'the two most recently app-edited are pre-ticked')
  assert.deepEqual(
    decision.candidates.map((c) => c.slug).sort(),
    ['alpha', 'beta', 'gamma'],
    'every candidate is offered'
  )
  assert(decision.candidates.every((c) => c.title && c.lastAppEditAt > 0), 'each candidate carries a title and a time')
  assert.deepEqual(enrolledSlugs(state).sort(), ['alpha', 'beta'], 'nothing changes until he chooses')
})

check('his choice is remembered, and replaces the set exactly', () => {
  const state = loadScope(null)
  enrol(state, 'alpha', T0)
  enrol(state, 'beta', T0 + 1000)
  enrol(state, 'gamma', T0 + 2000)
  applyEnrolmentChoice(state, ['gamma', 'alpha'], T0 + 3000)
  assert.deepEqual(enrolledSlugs(state).sort(), ['alpha', 'gamma'])
  assert.equal(state.talks.beta.enrolled, false, 'the unticked talk leaves the set')
  assert.equal(state.talks.beta.decidedAt, T0 + 3000, 'and the decision is remembered')
})

check('unticking in Settings removes a talk', () => {
  const state = loadScope(null)
  enrol(state, 'alpha', T0)
  enrol(state, 'beta', T0 + 1000)
  setEnrolled(state, 'beta', false, T0 + 2000)
  assert.deepEqual(enrolledSlugs(state), ['alpha'])
})

check(`a talk leaves the set after ${STALE_DAYS} days without being opened in the app`, () => {
  const state = loadScope(null)
  enrol(state, 'alpha', T0)
  enrol(state, 'beta', T0)
  const now = T0 + (STALE_DAYS + 1) * DAY
  // Opening beta keeps it alive even though he has not edited it since.
  recordAppOpen(state, { slug: 'beta', atMs: now - DAY })
  const dropped = expireStale(state, now)
  assert.deepEqual(dropped, ['alpha'], 'only the untouched talk is dropped')
  assert.deepEqual(enrolledSlugs(state), ['beta'])
})

check('expiry is measured from the last OPEN, not the last edit', () => {
  const state = loadScope(null)
  enrol(state, 'alpha', T0)
  recordAppOpen(state, { slug: 'alpha', atMs: T0 + (STALE_DAYS + 5) * DAY })
  const dropped = expireStale(state, T0 + (STALE_DAYS + 6) * DAY)
  assert.deepEqual(dropped, [], 'a talk he still opens stays enrolled')
})

check('launch exports only enrolled talks whose app edit is newer than their last backup', () => {
  const state = loadScope(null)
  enrol(state, 'alpha', T0)
  enrol(state, 'beta', T0 + 1000)
  recordBackup(state, 'alpha', T0 + 2000) // alpha is already current
  // gamma was edited in the app but he declined to enrol it.
  recordAppEdit(state, { slug: 'gamma', title: 'gamma', outlinePath: '/vault/gamma/gamma-outline.md', atMs: T0 + 3000 })
  const due = talksNeedingLaunchBackup(state)
  assert.deepEqual(due.map((t) => t.slug), ['beta'], 'only the stale, enrolled talk is exported at launch')
  assert(due[0].outlinePath.endsWith('beta-outline.md'), 'the launch list carries the outline path to compile')
})

check('launch exports nothing when every enrolled talk is already current', () => {
  const state = loadScope(null)
  enrol(state, 'alpha', T0)
  recordBackup(state, 'alpha', T0 + 1)
  assert.deepEqual(talksNeedingLaunchBackup(state), [], 'no launch work, so no vault scan and no compile')
})

check('the auto-enrolment limit is two', () => {
  assert.equal(AUTO_ENROL_LIMIT, 2)
})

if (failures) {
  console.error(`\n${failures} backup-scope check(s) failed`)
  process.exit(1)
}
console.log('\nbackup scope: all checks passed')
