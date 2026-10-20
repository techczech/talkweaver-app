import { describe, expect, test } from 'bun:test'
import {
  PREWORK_DAY_MS, PREWORK_IDLE_PURGE_MS, PREWORK_LIMITS, carriesRightAnswer, parsePreworkEntry, parsePreworkForm, parsePreworkFormPush,
  parsePreworkRoute, parsePreworkStatus, parsePreworkSubmission, parsePreworkWithdraw, preworkBodyLimit, preworkRouteIsPublic, preworkRouteMethod, preworkSourceKey,
  type PreworkForm, type PreworkSubmission, type WorkPhase,
} from './prework-protocol'
import {
  PreworkError, closePrework, createMemoryPreworkStore, createPrework, isWithdrawn, participantState, preworkPhase, preworkStatus, purgeDueAt,
  pushForm, resultsPage, shouldPurge, submitPrework, waitingCount, withdrawPrework, workPhase, type StoredPrework,
} from './prework-state'

const NOW = Date.UTC(2026, 8, 30, 9)
const P1 = 'a1b2c3d4e5f60718'
const P2 = '0f1e2d3c4b5a6978'

function form(extra: Partial<PreworkForm> = {}): PreworkForm {
  return {
    title: 'Before the session',
    intro: 'Four short steps.',
    steps: [
      { id: 'pwwelcome', n: 1, title: 'Welcome', kind: 'slide', questions: false },
      { id: 'pwquiz', n: 2, title: 'Quick check', kind: 'check', questions: true,
        poll: { type: 'single', question: 'Quick check', options: [{ optionId: 'poll-pwquiz-option-1', label: 'A' }, { optionId: 'poll-pwquiz-option-2', label: 'B' }] } },
      { id: 'pwtools', n: 3, title: 'Tools', kind: 'question', questions: true,
        poll: { type: 'multiple', question: 'Tools', options: [{ optionId: 't1', label: 'ChatGPT' }, { optionId: 't2', label: 'Copilot' }, { optionId: 't3', label: 'Claude' }], maxSelections: 2 } },
      { id: 'pwhope', n: 4, title: 'Hopes', kind: 'question', questions: true, poll: { type: 'open', question: 'Hopes', options: [] } },
      { id: 'pwtask1', n: 5, title: 'Task 1', kind: 'task', questions: true, done: true, minutes: 20 },
      { id: 'pwread', n: 6, title: 'Read only', kind: 'task', questions: true, done: false },
    ],
    ...extra,
  }
}

function openPrework(opensAt = NOW - PREWORK_DAY_MS, closesAt = NOW + 6 * PREWORK_DAY_MS, phase: WorkPhase = 'pre'): StoredPrework {
  const prework = createPrework('ab12cd34', NOW - 2 * PREWORK_DAY_MS)
  pushForm(prework, { phase, opensAt, closesAt, form: form() }, NOW - 2 * PREWORK_DAY_MS)
  return prework
}

let counter = 0
function sub(extra: Partial<PreworkSubmission> & Pick<PreworkSubmission, 'kind' | 'stepId'>): PreworkSubmission {
  counter += 1
  return { participantId: 'device-id-0123456789', submissionId: `s-${counter}`, ...extra }
}

function refusal(fn: () => unknown): { code: string; status: number } {
  try { fn() } catch (error) {
    if (error instanceof PreworkError) return { code: error.code, status: error.status }
    throw error
  }
  throw new Error('expected a refusal')
}

describe('the form: no right answer, closed schema', () => {
  test('a right answer anywhere refuses the whole form', () => {
    const withRight = form()
    ;(withRight.steps[1] as unknown as Record<string, unknown>).right = { index: 0, label: 'A' }
    expect(carriesRightAnswer(withRight)).toBe(true)
    expect(parsePreworkForm(withRight)).toEqual({ error: { code: 'right_answer_not_allowed', message: expect.any(String) } })
    const inOption = form()
    ;(inOption.steps[1].poll!.options[0] as unknown as Record<string, unknown>).right = true
    expect('error' in parsePreworkForm(inOption)).toBe(true)
    const upper = { ...form(), steps: [{ ...form().steps[1], Right: 1 }] }
    expect('error' in parsePreworkForm(upper)).toBe(true)
  })

  test('a clean form is rebuilt from its allowed fields; unknown fields are dropped', () => {
    const parsed = parsePreworkForm({ ...form(), extra: 'x', steps: form().steps.map((step) => ({ ...step, junk: 1 })) })
    expect('value' in parsed && parsed.value.steps.map((step) => step.id)).toEqual(['pwwelcome', 'pwquiz', 'pwtools', 'pwhope', 'pwtask1', 'pwread'])
    expect('value' in parsed && JSON.stringify(parsed.value).includes('junk')).toBe(false)
  })

  test('Local only: a boolean on a task, check or question; absent (an older form) means sent; never on a slide', () => {
    const steps = form().steps
    const local = parsePreworkForm({ ...form(), steps: steps.map((step) => (step.id === 'pwtask1' || step.id === 'pwhope' ? { ...step, local: true } : step)) })
    expect('value' in local && local.value.steps.filter((step) => step.local).map((step) => step.id)).toEqual(['pwhope', 'pwtask1'])
    // A form published before Local only existed carries no flag: every step is sent, as before.
    const older = parsePreworkForm(form())
    expect('value' in older && older.value.steps.some((step) => 'local' in step)).toBe(false)
    // false is the same as absent and is not kept.
    const off = parsePreworkForm({ ...form(), steps: steps.map((step) => ({ ...step, local: false })) })
    expect('value' in off && off.value.steps.some((step) => 'local' in step)).toBe(false)
    expect('error' in parsePreworkForm({ ...form(), steps: [{ ...steps[0], local: true }] })).toBe(true)
    expect('error' in parsePreworkForm({ ...form(), steps: [{ ...steps[4], local: 'yes' }] })).toBe(true)
  })

  test('malformed steps are refused', () => {
    expect('error' in parsePreworkForm({ ...form(), steps: [] })).toBe(true)
    expect('error' in parsePreworkForm({ ...form(), steps: [form().steps[0], form().steps[0]] })).toBe(true)
    const multiCheck = { ...form().steps[1], poll: { ...form().steps[1].poll!, type: 'multiple' } }
    expect('error' in parsePreworkForm({ ...form(), steps: [multiCheck] })).toBe(true)
    const board = { ...form().steps[2], poll: { type: 'board', question: 'B', options: [{ optionId: 'c', label: 'C' }] } }
    expect('error' in parsePreworkForm({ ...form(), steps: [board] })).toBe(true)
    const taskWithoutDone = { id: 'x', title: 'T', kind: 'task', questions: true }
    expect('error' in parsePreworkForm({ ...form(), steps: [taskWithoutDone] })).toBe(true)
    expect('error' in parsePreworkForm({ ...form(), steps: [{ ...form().steps[0], id: '../x' }] })).toBe(true)
    expect('error' in parsePreworkForm({ ...form(), title: 'x'.repeat(301) })).toBe(true)
  })

  test('the window opens before it closes and closes within 400 days', () => {
    expect('value' in parsePreworkFormPush({ opensAt: NOW, closesAt: NOW + 1, form: form() }, NOW)).toBe(true)
    expect('error' in parsePreworkFormPush({ opensAt: NOW, closesAt: NOW, form: form() }, NOW)).toBe(true)
    expect('error' in parsePreworkFormPush({ opensAt: NOW, closesAt: NOW + 401 * PREWORK_DAY_MS, form: form() }, NOW)).toBe(true)
    expect('error' in parsePreworkFormPush({ opensAt: '2026-10-01', closesAt: NOW + 1, form: form() }, NOW)).toBe(true)
  })
})

describe('submissions: shape', () => {
  test('each kind carries only its own fields', () => {
    expect('value' in parsePreworkSubmission(sub({ kind: 'read', stepId: 'pwwelcome' }))).toBe(true)
    expect('error' in parsePreworkSubmission({ ...sub({ kind: 'read', stepId: 'pwwelcome' }), text: 'x' })).toBe(true)
    expect('error' in parsePreworkSubmission(sub({ kind: 'done', stepId: 'pwtask1' }))).toBe(true)
    expect('error' in parsePreworkSubmission({ ...sub({ kind: 'answer', stepId: 'pwquiz' }), choice: 'a', text: 'b' })).toBe(true)
    expect('error' in parsePreworkSubmission({ ...sub({ kind: 'question', stepId: 'pwquiz', text: 'x'.repeat(501) }) })).toBe(true)
    expect('error' in parsePreworkSubmission({ ...sub({ kind: 'read', stepId: 'pwwelcome' }), participantId: 'short' })).toBe(true)
    expect('error' in parsePreworkSubmission({ ...sub({ kind: 'read', stepId: 'pwwelcome' }), kind: 'vote' })).toBe(true)
    expect('error' in parsePreworkSubmission([])).toBe(true)
  })
})

describe('one object per Run and phase', () => {
  test('the push carries the phase; none is pre; anything else is refused', () => {
    expect(parsePreworkFormPush({ phase: 'post', opensAt: NOW, closesAt: NOW + 1, form: form() }, NOW)).toMatchObject({ value: { phase: 'post' } })
    expect(parsePreworkFormPush({ opensAt: NOW, closesAt: NOW + 1, form: form() }, NOW)).toMatchObject({ value: { phase: 'pre' } })
    expect(parsePreworkFormPush({ phase: 'during', opensAt: NOW, closesAt: NOW + 1, form: form() }, NOW)).toEqual({ error: { code: 'invalid_phase', message: expect.any(String) } })
    expect('error' in parsePreworkFormPush({ phase: null, opensAt: NOW, closesAt: NOW + 1, form: form() }, NOW)).toBe(true)
  })

  test('the status and the results say which phase; the first push fixes it and the other phase is refused', () => {
    const post = openPrework(NOW - 10, NOW + 10, 'post')
    expect(preworkStatus(post, NOW)).toEqual({ state: 'open', phase: 'post', opensAt: NOW - 10, closesAt: NOW + 10 })
    const page = resultsPage(post, createMemoryPreworkStore(), 0, NOW)
    // One pair of names for the window and the round of work, as the public status names them.
    expect(page).toMatchObject({ state: 'open', phase: 'post', withdrawn: false })
    expect('workPhase' in page).toBe(false)
    const before = structuredClone(post)
    const refused = refusal(() => pushForm(post, { phase: 'pre', opensAt: NOW, closesAt: NOW + 20, form: form() }, NOW))
    expect(refused).toEqual({ code: 'phase_mismatch', status: 409 })
    expect(post).toEqual(before)
    pushForm(post, { phase: 'post', opensAt: NOW - 10, closesAt: NOW + 30, form: form() }, NOW)
    expect(post.closesAt).toBe(NOW + 30)
  })

  test('an object stored by 0.37 (no phase, no withdrawn) reads as pre-work and keeps working', () => {
    const old = openPrework() as unknown as Record<string, unknown>
    delete old.phase
    delete old.withdrawnAt
    const prework = JSON.parse(JSON.stringify(old)) as StoredPrework
    expect(workPhase(prework)).toBe('pre')
    expect(isWithdrawn(prework)).toBe(false)
    expect(preworkStatus(prework, NOW)).toMatchObject({ state: 'open', phase: 'pre' })
    expect(submitPrework(prework, createMemoryPreworkStore(), P1, sub({ kind: 'read', stepId: 'pwwelcome' }), NOW).changed).toBe(true)
    expect(refusal(() => pushForm(prework, { phase: 'post', opensAt: NOW, closesAt: NOW + 1, form: form() }, NOW)).code).toBe('phase_mismatch')
    pushForm(prework, { phase: 'pre', opensAt: NOW - 10, closesAt: NOW + 10, form: form() }, NOW)
    expect(prework.phase).toBe('pre')
  })
})

describe('reopened by a later closing time', () => {
  test('a form closed by its date takes answers again after a push that closes later', () => {
    const store = createMemoryPreworkStore()
    const prework = openPrework(NOW - 2_000, NOW - 1_000)
    expect(preworkPhase(prework, NOW)).toBe('closed')
    expect(refusal(() => submitPrework(prework, store, P1, sub({ kind: 'read', stepId: 'pwwelcome' }), NOW)).code).toBe('prework_closed')
    pushForm(prework, { phase: 'pre', opensAt: NOW - 2_000, closesAt: NOW + PREWORK_DAY_MS, form: form() }, NOW)
    expect(preworkStatus(prework, NOW)).toEqual({ state: 'open', phase: 'pre', opensAt: NOW - 2_000, closesAt: NOW + PREWORK_DAY_MS })
    expect(submitPrework(prework, store, P1, sub({ kind: 'read', stepId: 'pwwelcome' }), NOW).changed).toBe(true)
    // The reopened window moves the purge with it.
    expect(purgeDueAt(prework)).toBe(NOW + PREWORK_DAY_MS + PREWORK_IDLE_PURGE_MS)
  })

  test('post-work closed by its date reopens the same way', () => {
    const prework = openPrework(NOW - 2_000, NOW - 1_000, 'post')
    pushForm(prework, { phase: 'post', opensAt: NOW - 2_000, closesAt: NOW + 5_000, form: form() }, NOW)
    expect(submitPrework(prework, createMemoryPreworkStore(), P1, sub({ kind: 'answer', stepId: 'pwhope', text: 'Useful' }), NOW).changed).toBe(true)
  })
})

describe('a push without a form changes only the window', () => {
  test('the stored form is kept; before any form is stored it is refused and nothing changes', () => {
    expect(parsePreworkFormPush({ phase: 'post', opensAt: NOW, closesAt: NOW + 1 }, NOW)).toEqual({ value: { phase: 'post', opensAt: NOW, closesAt: NOW + 1, form: null } })
    expect('error' in parsePreworkFormPush({ phase: 'post', opensAt: NOW, closesAt: NOW + 1, form: null }, NOW)).toBe(true)
    const prework = openPrework(NOW - 2_000, NOW - 1_000)
    const stored = prework.form
    pushForm(prework, { phase: 'pre', opensAt: NOW - 2_000, closesAt: NOW + PREWORK_DAY_MS, form: null }, NOW)
    expect(prework.form).toEqual(stored)
    expect(preworkStatus(prework, NOW)).toEqual({ state: 'open', phase: 'pre', opensAt: NOW - 2_000, closesAt: NOW + PREWORK_DAY_MS })
    expect(refusal(() => pushForm(prework, { phase: 'post', opensAt: NOW, closesAt: NOW + 1, form: null }, NOW)).code).toBe('phase_mismatch')
    const empty = createPrework('ab12cd35', NOW)
    const before = structuredClone(empty)
    expect(refusal(() => pushForm(empty, { phase: 'pre', opensAt: NOW, closesAt: NOW + 1, form: null }, NOW))).toEqual({ code: 'form_missing', status: 409 })
    expect(empty).toEqual(before)
  })
})

describe('withdrawn', () => {
  test('nothing is taken, the answers stay for the owner, and putting it back serves it again', () => {
    const store = createMemoryPreworkStore()
    const prework = openPrework()
    submitPrework(prework, store, P1, sub({ kind: 'answer', stepId: 'pwhope', text: 'Kept' }), NOW)
    submitPrework(prework, store, P2, sub({ kind: 'question', stepId: 'pwquiz', text: 'Why?' }), NOW)
    expect(withdrawPrework(prework, true, NOW + 10)).toBe(NOW + 10)
    expect(withdrawPrework(prework, true, NOW + 20)).toBe(NOW + 10, 'idempotent: the first time is kept')
    expect(isWithdrawn(prework)).toBe(true)
    expect(refusal(() => submitPrework(prework, store, P1, sub({ kind: 'read', stepId: 'pwwelcome' }), NOW + 30))).toEqual({ code: 'not_available', status: 404 })
    const page = resultsPage(prework, store, 0, NOW + 30)
    expect(page).toMatchObject({ withdrawn: true, people: 2, seq: 2 })
    expect(page.entries.map((entry) => entry.text)).toEqual(['Kept', 'Why?'])
    // A push while withdrawn (a time changed on an unpublished Run) does not serve it again.
    pushForm(prework, { phase: 'pre', opensAt: NOW - 10, closesAt: NOW + 2 * PREWORK_DAY_MS, form: form() }, NOW + 40)
    expect(isWithdrawn(prework)).toBe(true)
    expect(withdrawPrework(prework, false, NOW + 50)).toBeNull()
    expect(submitPrework(prework, store, P1, sub({ kind: 'read', stepId: 'pwwelcome' }), NOW + 60).changed).toBe(true)
    expect(resultsPage(prework, store, 0, NOW + 60).entries).toHaveLength(3)
  })

  test('closed and withdrawn: it says not available, not closed', () => {
    const prework = openPrework(NOW - 2_000, NOW - 1_000)
    withdrawPrework(prework, true, NOW)
    expect(refusal(() => submitPrework(prework, createMemoryPreworkStore(), P1, sub({ kind: 'read', stepId: 'pwwelcome' }), NOW)).code).toBe('not_available')
  })

  test('the withdraw body: empty or {withdrawn}; nothing else', () => {
    expect(parsePreworkWithdraw(undefined)).toBe(true)
    expect(parsePreworkWithdraw({})).toBe(true)
    expect(parsePreworkWithdraw({ withdrawn: true })).toBe(true)
    expect(parsePreworkWithdraw({ withdrawn: false })).toBe(false)
    expect(parsePreworkWithdraw({ withdrawn: 'no' })).toBeNull()
    expect(parsePreworkWithdraw({ withdrawn: false, extra: 1 })).toBeNull()
    expect(parsePreworkWithdraw([false])).toBeNull()
  })
})

describe('what the owner reads', () => {
  test('participants are random codes: no device id, and no name except one typed on a question', () => {
    const store = createMemoryPreworkStore()
    const prework = openPrework()
    const device = 'device-id-SECRET-0123456789'
    submitPrework(prework, store, P1, { participantId: device, submissionId: 'n-1', stepId: 'pwhope', kind: 'answer', text: 'Hi' }, NOW)
    submitPrework(prework, store, P1, { participantId: device, submissionId: 'n-2', stepId: 'pwquiz', kind: 'question', text: 'Why?' }, NOW)
    const page = resultsPage(prework, store, 0, NOW)
    expect(JSON.stringify(page).includes(device)).toBe(false)
    expect(page.entries.every((entry) => /^[0-9a-f]{16}$/.test(entry.participant))).toBe(true)
    expect(page.entries.some((entry) => 'name' in entry)).toBe(false)
  })
})

describe('open and closed by date', () => {
  test('nothing is accepted before it opens, after it closes, or before a form is pushed', () => {
    const store = createMemoryPreworkStore()
    const fresh = createPrework('ab12cd34', NOW)
    expect(preworkStatus(fresh, NOW)).toBeNull()
    expect(refusal(() => submitPrework(fresh, store, P1, sub({ kind: 'read', stepId: 'pwwelcome' }), NOW))).toEqual({ code: 'not_found', status: 404 })

    const later = openPrework(NOW + 1000, NOW + 2000)
    expect(preworkPhase(later, NOW)).toBe('not_yet')
    expect(refusal(() => submitPrework(later, store, P1, sub({ kind: 'read', stepId: 'pwwelcome' }), NOW))).toEqual({ code: 'prework_not_open', status: 409 })
    expect(preworkPhase(later, NOW + 1000)).toBe('open')
    expect(submitPrework(later, store, P1, sub({ kind: 'read', stepId: 'pwwelcome' }), NOW + 1000).changed).toBe(true)
    expect(preworkPhase(later, NOW + 2000)).toBe('closed')
    expect(refusal(() => submitPrework(later, store, P1, sub({ kind: 'read', stepId: 'pwquiz' }), NOW + 2000))).toEqual({ code: 'prework_closed', status: 410 })
    expect(preworkStatus(later, NOW + 2000)).toEqual({ state: 'closed', phase: 'pre', opensAt: NOW + 1000, closesAt: NOW + 2000, people: 1 })
    expect(preworkStatus(later, NOW + 1500)).toEqual({ state: 'open', phase: 'pre', opensAt: NOW + 1000, closesAt: NOW + 2000 })
  })

  test('closing early wins over the window; a push that keeps or shortens the closing time does not reopen it', () => {
    const store = createMemoryPreworkStore()
    const prework = openPrework()
    expect(closePrework(prework, NOW)).toBe(NOW)
    expect(closePrework(prework, NOW + 50)).toBe(NOW)
    expect(prework.closedBy).toBe('owner')
    expect(preworkPhase(prework, NOW)).toBe('closed')
    // The same closing time again (a republish for another reason) leaves the owner's close in place.
    pushForm(prework, { phase: 'pre', opensAt: NOW - 10, closesAt: NOW + 6 * PREWORK_DAY_MS, form: form() }, NOW + 60)
    expect(preworkStatus(prework, NOW + 60)).toEqual({ state: 'closed', phase: 'pre', opensAt: NOW - 10, closesAt: NOW, people: 0 })
    pushForm(prework, { phase: 'pre', opensAt: NOW - 10, closesAt: NOW + 5 * PREWORK_DAY_MS, form: form() }, NOW + 60)
    expect(preworkPhase(prework, NOW + 60)).toBe('closed')
    expect(refusal(() => submitPrework(prework, store, P1, sub({ kind: 'read', stepId: 'pwwelcome' }), NOW + 60)).code).toBe('prework_closed')
  })

  test('the owner closed early and then set a later closing time: it reopens (ADR-0040 decision 3)', () => {
    const store = createMemoryPreworkStore()
    const prework = openPrework()
    closePrework(prework, NOW, 'owner')
    pushForm(prework, { phase: 'pre', opensAt: NOW - 10, closesAt: NOW + 10 * PREWORK_DAY_MS, form: form() }, NOW + 60)
    expect(prework.closedAt).toBe(null)
    expect(prework.closedBy).toBe(undefined)
    expect(preworkStatus(prework, NOW + 60)).toEqual({ state: 'open', phase: 'pre', opensAt: NOW - 10, closesAt: NOW + 10 * PREWORK_DAY_MS })
    expect(submitPrework(prework, store, P1, sub({ kind: 'read', stepId: 'pwwelcome' }), NOW + 60).changed).toBe(true)
  })

  test('an admin close stays closed whatever the owner pushes; so does a close stored before who closed was kept', () => {
    const prework = openPrework()
    closePrework(prework, NOW, 'admin')
    expect(prework.closedBy).toBe('admin')
    pushForm(prework, { phase: 'pre', opensAt: NOW - 10, closesAt: NOW + 10 * PREWORK_DAY_MS, form: form() }, NOW + 60)
    expect(preworkPhase(prework, NOW + 60)).toBe('closed')
    // The owner closing too never turns the admin's close into the owner's.
    closePrework(prework, NOW + 70, 'owner')
    expect(prework.closedBy).toBe('admin')
    // Owner first, admin after: the admin's close holds.
    const both = openPrework()
    closePrework(both, NOW, 'owner')
    closePrework(both, NOW + 5, 'admin')
    expect(both.closedBy).toBe('admin')
    pushForm(both, { phase: 'pre', opensAt: NOW - 10, closesAt: NOW + 10 * PREWORK_DAY_MS, form: form() }, NOW + 60)
    expect(preworkPhase(both, NOW + 60)).toBe('closed')
    // Stored by ticket 12 (closedAt, no closedBy): never lifted.
    const old = openPrework()
    old.closedAt = NOW
    pushForm(old, { phase: 'pre', opensAt: NOW - 10, closesAt: NOW + 10 * PREWORK_DAY_MS, form: form() }, NOW + 60)
    expect(preworkPhase(old, NOW + 60)).toBe('closed')
  })
})

describe('the reducer', () => {
  test('answers fit their step; the latest answer per person and step wins', () => {
    const store = createMemoryPreworkStore()
    const prework = openPrework()
    const first = submitPrework(prework, store, P1, sub({ kind: 'answer', stepId: 'pwquiz', choice: 'poll-pwquiz-option-1' }), NOW)
    expect(first.entry).toMatchObject({ id: `${P1}:answer:pwquiz`, seq: 1, choice: 'poll-pwquiz-option-1' })
    const changed = submitPrework(prework, store, P1, sub({ kind: 'answer', stepId: 'pwquiz', choice: 'poll-pwquiz-option-2' }), NOW + 5)
    expect(changed.entry).toMatchObject({ id: `${P1}:answer:pwquiz`, seq: 2, choice: 'poll-pwquiz-option-2', at: NOW + 5 })
    expect(store.entries.size).toBe(1)
    const same = submitPrework(prework, store, P1, sub({ kind: 'answer', stepId: 'pwquiz', choice: 'poll-pwquiz-option-2' }), NOW + 6)
    expect(same.changed).toBe(false)
    expect(prework.seq).toBe(2)

    expect(submitPrework(prework, store, P1, sub({ kind: 'answer', stepId: 'pwtools', choice: ['t1', 't3', 't1'] }), NOW).entry.choice).toEqual(['t1', 't3'])
    expect(refusal(() => submitPrework(prework, store, P1, sub({ kind: 'answer', stepId: 'pwtools', choice: ['t1', 't2', 't3'] }), NOW)).code).toBe('invalid_answer')
    expect(refusal(() => submitPrework(prework, store, P1, sub({ kind: 'answer', stepId: 'pwquiz', choice: 'nope' }), NOW)).code).toBe('invalid_answer')
    expect(submitPrework(prework, store, P1, sub({ kind: 'answer', stepId: 'pwhope', text: 'Save time' }), NOW).entry.text).toBe('Save time')
    expect(refusal(() => submitPrework(prework, store, P1, sub({ kind: 'answer', stepId: 'pwhope', choice: 't1' }), NOW)).code).toBe('invalid_answer')
    expect(refusal(() => submitPrework(prework, store, P1, sub({ kind: 'answer', stepId: 'pwwelcome', choice: 't1' }), NOW)).code).toBe('not_a_question')
    expect(refusal(() => submitPrework(prework, store, P1, sub({ kind: 'answer', stepId: 'nosuch', choice: 't1' }), NOW)).code).toBe('unknown_step')
  })

  test('done marks: only a pre-task that asks for them; tap to untick replaces the mark', () => {
    const store = createMemoryPreworkStore()
    const prework = openPrework()
    expect(submitPrework(prework, store, P1, sub({ kind: 'done', stepId: 'pwtask1', done: true }), NOW).entry.done).toBe(true)
    expect(submitPrework(prework, store, P1, sub({ kind: 'done', stepId: 'pwtask1', done: false }), NOW + 1).entry.done).toBe(false)
    expect(store.entries.size).toBe(1)
    expect(refusal(() => submitPrework(prework, store, P1, sub({ kind: 'done', stepId: 'pwread', done: true }), NOW)).code).toBe('not_a_task')
    expect(refusal(() => submitPrework(prework, store, P1, sub({ kind: 'done', stepId: 'pwquiz', done: true }), NOW)).code).toBe('not_a_task')
  })

  test('questions: one entry each, only where the step takes them, with an optional name', () => {
    const store = createMemoryPreworkStore()
    const prework = openPrework()
    const a = submitPrework(prework, store, P1, sub({ kind: 'question', stepId: 'pwtask1', text: 'Which email?' }), NOW)
    const b = submitPrework(prework, store, P1, sub({ kind: 'question', stepId: 'pwtask1', text: 'Which email?', name: 'Sam' }), NOW)
    expect(a.entry.id).not.toBe(b.entry.id)
    expect(b.entry.name).toBe('Sam')
    expect(refusal(() => submitPrework(prework, store, P1, sub({ kind: 'question', stepId: 'pwwelcome', text: 'x' }), NOW)).code).toBe('questions_off')
  })

  test('idempotent by submission id: a replay is free, a different body under the same id is a conflict', () => {
    const store = createMemoryPreworkStore()
    const prework = openPrework()
    const once = sub({ kind: 'question', stepId: 'pwquiz', text: 'Why?' })
    const first = submitPrework(prework, store, P1, once, NOW)
    const again = submitPrework(prework, store, P1, once, NOW + 10)
    expect(again).toEqual({ entry: first.entry, changed: false })
    expect(prework.seq).toBe(1)
    expect(refusal(() => submitPrework(prework, store, P1, { ...once, text: 'Other' }, NOW)).code).toBe('submission_conflict')
    expect(refusal(() => submitPrework(prework, store, P2, once, NOW)).code).toBe('submission_conflict')
    // A read twice (new ids) changes nothing the second time.
    submitPrework(prework, store, P1, sub({ kind: 'read', stepId: 'pwwelcome' }), NOW)
    expect(submitPrework(prework, store, P1, sub({ kind: 'read', stepId: 'pwwelcome' }), NOW).changed).toBe(false)
  })

  test('caps: questions and submissions per person, people per form', () => {
    const store = createMemoryPreworkStore()
    const prework = openPrework()
    for (let i = 0; i < PREWORK_LIMITS.participantQuestions; i += 1) submitPrework(prework, store, P1, sub({ kind: 'question', stepId: 'pwquiz', text: `q${i}` }), NOW + i * 2_000)
    expect(refusal(() => submitPrework(prework, store, P1, sub({ kind: 'question', stepId: 'pwquiz', text: 'one more' }), NOW + 100_000)))
      .toEqual({ code: 'question_limit', status: 429 })
    expect(submitPrework(prework, store, P2, sub({ kind: 'question', stepId: 'pwquiz', text: 'still room for others' }), NOW + 100_000).changed).toBe(true)

    const full = openPrework()
    full.participants = PREWORK_LIMITS.participants
    expect(refusal(() => submitPrework(full, createMemoryPreworkStore(), P1, sub({ kind: 'read', stepId: 'pwwelcome' }), NOW))).toEqual({ code: 'prework_full', status: 429 })

    const busy = openPrework()
    const busyStore = createMemoryPreworkStore()
    busyStore.putParticipant({ key: P1, firstAt: NOW, submissions: PREWORK_LIMITS.participantSubmissions, questions: 0, bucket: { tokens: 60, at: NOW } })
    busy.participants = 1
    expect(refusal(() => submitPrework(busy, busyStore, P1, sub({ kind: 'read', stepId: 'pwwelcome' }), NOW)).code).toBe('participant_limit')
  })

  test('rate: one device is limited at its burst, others still get in', () => {
    const store = createMemoryPreworkStore()
    const prework = openPrework()
    let refused: { code: string; status: number } | null = null
    for (let i = 0; i <= PREWORK_LIMITS.participantBurst; i += 1) {
      try { submitPrework(prework, store, P1, sub({ kind: 'answer', stepId: 'pwhope', text: `answer ${i}` }), NOW) } catch (error) {
        refused = { code: (error as PreworkError).code, status: (error as PreworkError).status }
      }
    }
    expect(refused).toEqual({ code: 'rate_limited', status: 429 })
    expect(submitPrework(prework, store, P2, sub({ kind: 'read', stepId: 'pwwelcome' }), NOW).changed).toBe(true)
    // A minute later the device has tokens again.
    expect(submitPrework(prework, store, P1, sub({ kind: 'answer', stepId: 'pwhope', text: 'later' }), NOW + 60_000).changed).toBe(true)
  })

  test('the owner pulls entries after a sequence number; a device reads only its own', () => {
    const store = createMemoryPreworkStore()
    const prework = openPrework()
    submitPrework(prework, store, P1, sub({ kind: 'read', stepId: 'pwwelcome' }), NOW)
    submitPrework(prework, store, P2, sub({ kind: 'answer', stepId: 'pwhope', text: 'Hi' }), NOW)
    submitPrework(prework, store, P1, sub({ kind: 'done', stepId: 'pwtask1', done: true }), NOW)
    const page = resultsPage(prework, store, 1, NOW)
    expect(page.entries.map((entry) => entry.seq)).toEqual([2, 3])
    expect(page).toMatchObject({ seq: 3, state: 'open', phase: 'pre', people: 2, more: false })
    expect(participantState(store, P1).map((entry) => entry.ref)).toEqual(['read:pwwelcome', 'done:pwtask1'])
    expect(JSON.stringify(participantState(store, P1)).includes(P1)).toBe(false)
    for (const entry of page.entries) expect(parsePreworkEntry(entry)).toEqual(entry)
  })

  test('purged 60 idle days after the later of its last activity and its close; activity moves the purge', () => {
    const store = createMemoryPreworkStore()
    const prework = openPrework(NOW - PREWORK_DAY_MS, NOW + 3 * PREWORK_DAY_MS)
    expect(purgeDueAt(prework)).toBe(NOW + 3 * PREWORK_DAY_MS + PREWORK_IDLE_PURGE_MS)
    submitPrework(prework, store, P1, sub({ kind: 'read', stepId: 'pwwelcome' }), NOW + 2 * PREWORK_DAY_MS)
    expect(purgeDueAt(prework)).toBe(NOW + 3 * PREWORK_DAY_MS + PREWORK_IDLE_PURGE_MS, 'the close is later than the last activity')
    const due = NOW + 3 * PREWORK_DAY_MS + PREWORK_IDLE_PURGE_MS
    expect(shouldPurge(prework, due - 1)).toBe(false)
    expect(shouldPurge(prework, due)).toBe(true)
    // A no-op (the same read again) is not activity.
    submitPrework(prework, store, P1, sub({ kind: 'read', stepId: 'pwwelcome' }), NOW + 2.5 * PREWORK_DAY_MS)
    expect(purgeDueAt(prework)).toBe(due)
    // Closing early brings the purge forward to 60 days after the later of the close and the last activity.
    closePrework(prework, NOW + 2.6 * PREWORK_DAY_MS)
    expect(purgeDueAt(prework)).toBe(NOW + 2.6 * PREWORK_DAY_MS + PREWORK_IDLE_PURGE_MS)
  })

  test('a form published 90 days before it opens is not purged before anyone can answer it', () => {
    const published = NOW
    const prework = createPrework('ab12cd34', published)
    pushForm(prework, { phase: 'pre', opensAt: published + 90 * PREWORK_DAY_MS, closesAt: published + 97 * PREWORK_DAY_MS, form: form() }, published)
    expect(shouldPurge(prework, published + 61 * PREWORK_DAY_MS)).toBe(false)
    expect(shouldPurge(prework, published + 96 * PREWORK_DAY_MS)).toBe(false)
    const store = createMemoryPreworkStore()
    expect(submitPrework(prework, store, P1, sub({ kind: 'read', stepId: 'pwwelcome' }), published + 91 * PREWORK_DAY_MS).changed).toBe(true)
    expect(shouldPurge(prework, published + 97 * PREWORK_DAY_MS + PREWORK_IDLE_PURGE_MS)).toBe(true)
  })

  test('one network source brings at most its hourly share of new people; another source still gets in', () => {
    const store = createMemoryPreworkStore()
    const prework = openPrework()
    const hex = (i: number) => i.toString(16).padStart(16, '0')
    for (let i = 0; i < PREWORK_LIMITS.sourceNewParticipantsPerHour; i += 1) {
      submitPrework(prework, store, hex(i), sub({ kind: 'read', stepId: 'pwwelcome' }), NOW + i * 1_000, 'source-a')
    }
    expect(refusal(() => submitPrework(prework, store, hex(9999), sub({ kind: 'read', stepId: 'pwwelcome' }), NOW + 200_000, 'source-a')))
      .toEqual({ code: 'source_limit', status: 429 })
    expect(submitPrework(prework, store, hex(0), sub({ kind: 'read', stepId: 'pwquiz' }), NOW + 200_000, 'source-a').changed).toBe(true)
    expect(submitPrework(prework, store, hex(9999), sub({ kind: 'read', stepId: 'pwwelcome' }), NOW + 200_000, 'source-b').changed).toBe(true)
    // An hour later its hourly count resets and it is admitted again: the lifetime cap is the form's own.
    expect(PREWORK_LIMITS.sourceParticipantsTotal).toBe(PREWORK_LIMITS.participants)
    expect(submitPrework(prework, store, hex(8888), sub({ kind: 'read', stepId: 'pwwelcome' }), NOW + 9 * 3_600_000, 'source-a').changed).toBe(true)
    // Over the form's life a source brings at most its total share.
    store.putSource({ ...store.source('source-a')!, participantsTotal: PREWORK_LIMITS.sourceParticipantsTotal })
    expect(refusal(() => submitPrework(prework, store, hex(7777), sub({ kind: 'read', stepId: 'pwwelcome' }), NOW + 9 * 3_600_000, 'source-a')).code).toBe('source_limit')
    // A refused id costs nothing: the form's count moved only for accepted people.
    const people = prework.participants
    expect(refusal(() => submitPrework(prework, store, hex(6666), sub({ kind: 'read', stepId: 'pwwelcome' }), NOW + 8 * 3_600_000, 'source-a')).code).toBe('source_limit')
    expect(prework.participants).toBe(people)
    expect(submitPrework(prework, store, hex(5555), sub({ kind: 'read', stepId: 'pwwelcome' }), NOW + 8 * 3_600_000, 'source-c').changed).toBe(true)
  })
})

describe('Local only steps and the waiting count', () => {
  test('nothing but a question is accepted for a Local only step, and nothing is stored for the refusals', () => {
    const store = createMemoryPreworkStore()
    const prework = createPrework('ab12cd34', NOW - 2 * PREWORK_DAY_MS)
    const local = form({ steps: form().steps.map((step) => (step.id === 'pwtask1' || step.id === 'pwhope' ? { ...step, local: true as const } : step)) })
    pushForm(prework, { phase: 'pre', opensAt: NOW - PREWORK_DAY_MS, closesAt: NOW + PREWORK_DAY_MS, form: local }, NOW - PREWORK_DAY_MS)
    expect(refusal(() => submitPrework(prework, store, P1, sub({ kind: 'done', stepId: 'pwtask1', done: true }), NOW))).toEqual({ code: 'step_local', status: 400 })
    expect(refusal(() => submitPrework(prework, store, P1, sub({ kind: 'read', stepId: 'pwtask1' }), NOW))).toEqual({ code: 'step_local', status: 400 })
    expect(refusal(() => submitPrework(prework, store, P1, sub({ kind: 'answer', stepId: 'pwhope', text: 'Mine' }), NOW))).toEqual({ code: 'step_local', status: 400 })
    expect(store.entries.size).toBe(0)
    expect(prework.participants).toBe(0)
    expect(submitPrework(prework, store, P1, sub({ kind: 'question', stepId: 'pwtask1', text: 'Which paper?' }), NOW).changed).toBe(true)
    // A step without the flag is sent as before.
    expect(submitPrework(prework, store, P1, sub({ kind: 'answer', stepId: 'pwquiz', choice: 'poll-pwquiz-option-1' }), NOW).changed).toBe(true)
  })

  test('waitingCount: answers and questions after the cursor; reads and done marks are not responses', () => {
    const store = createMemoryPreworkStore()
    const prework = openPrework()
    submitPrework(prework, store, P1, sub({ kind: 'read', stepId: 'pwwelcome' }), NOW)
    submitPrework(prework, store, P1, sub({ kind: 'done', stepId: 'pwtask1', done: true }), NOW)
    submitPrework(prework, store, P1, sub({ kind: 'answer', stepId: 'pwhope', text: 'Save time' }), NOW)
    submitPrework(prework, store, P2, sub({ kind: 'question', stepId: 'pwhope', text: 'How long?' }), NOW)
    expect(waitingCount(prework, store, 0)).toEqual({ seq: 4, waiting: 2 })
    expect(waitingCount(prework, store, 3)).toEqual({ seq: 4, waiting: 1 })
    expect(waitingCount(prework, store, 4)).toEqual({ seq: 4, waiting: 0 })
    // A changed answer moves past the cursor again: it is new to the owner.
    submitPrework(prework, store, P1, sub({ kind: 'answer', stepId: 'pwhope', text: 'Save more time' }), NOW + 1)
    expect(waitingCount(prework, store, 4)).toEqual({ seq: 5, waiting: 1 })
  })
})

describe('entries as the Run keeps them', () => {
  test('hostile entries are dropped', () => {
    const good = { id: `${P1}:answer:pwhope`, seq: 3, participant: P1, stepId: 'pwhope', kind: 'answer', text: 'Hi', at: NOW }
    expect(parsePreworkEntry(good)).toEqual(good as never)
    expect(parsePreworkEntry({ ...good, id: `${P2}:answer:pwhope` })).toBeNull()
    expect(parsePreworkEntry({ ...good, id: `${P1}:answer:other` })).toBeNull()
    expect(parsePreworkEntry({ ...good, participant: 'Sam' })).toBeNull()
    expect(parsePreworkEntry({ ...good, text: 'x'.repeat(1001) })).toBeNull()
    expect(parsePreworkEntry({ ...good, kind: 'vote' })).toBeNull()
    expect(parsePreworkEntry({ ...good, choice: 'a' })).toBeNull()
    expect(parsePreworkEntry({ ...good, at: -1 })).toBeNull()
    expect(parsePreworkEntry({ ...good, id: `${P1}:done:pwtask1`, kind: 'done', stepId: 'pwtask1', done: 'yes' })).toBeNull()
    expect(parsePreworkEntry({ id: `${P1}:q:s-1`, seq: 1, participant: P1, stepId: 'pwquiz', kind: 'question', text: 'Why?', name: 'Sam', at: NOW }))
      .toMatchObject({ name: 'Sam' })
  })

  test('status', () => {
    expect(parsePreworkStatus({ state: 'open', phase: 'post', opensAt: 1, closesAt: 2 })).toEqual({ state: 'open', phase: 'post', opensAt: 1, closesAt: 2 })
    expect(parsePreworkStatus({ state: 'open', opensAt: 1, closesAt: 2 })).toEqual({ state: 'open', phase: 'pre', opensAt: 1, closesAt: 2 }, 'a Worker from before phases')
    expect(parsePreworkStatus({ state: 'open', phase: 'during', opensAt: 1, closesAt: 2 })).toBeNull()
    expect(parsePreworkStatus({ state: 'gone', opensAt: 1, closesAt: 2 })).toBeNull()
  })
})

describe('the source an address counts as', () => {
  test('IPv4 as is; IPv6 by its /64; IPv4-mapped as IPv4', () => {
    expect(preworkSourceKey('203.0.113.7')).toBe('203.0.113.7')
    expect(preworkSourceKey('2001:db8:abcd:12::1')).toBe(preworkSourceKey('2001:0db8:abcd:0012:ffff:1:2:3'))
    expect(preworkSourceKey('2001:DB8:abcd:12::99')).toBe('2001:db8:abcd:12::/64')
    expect(preworkSourceKey('2001:db8:abcd:13::1')).not.toBe(preworkSourceKey('2001:db8:abcd:12::1'))
    expect(preworkSourceKey('::ffff:198.51.100.2')).toBe('198.51.100.2')
  })
})

describe('routes', () => {
  test('the grammar, methods, credentials and body caps', () => {
    expect(parsePreworkRoute('/prework/ab12cd34')).toEqual({ preworkId: 'ab12cd34', action: 'status' })
    expect(parsePreworkRoute('/prework/ab12cd34/submit')).toEqual({ preworkId: 'ab12cd34', action: 'submit' })
    expect(parsePreworkRoute('/prework/internal/close')).toBeNull()
    expect(parsePreworkRoute('/prework/ab12cd34/other')).toBeNull()
    expect(parsePreworkRoute('/prework/AB12cd34')).toBeNull()
    const route = (action: string) => parsePreworkRoute(`/prework/ab12cd34${action ? `/${action}` : ''}`)!
    const actions = ['', 'submit', 'mine', 'form', 'results', 'waiting', 'close', 'withdraw']
    expect(actions.map((action) => preworkRouteMethod(route(action)))).toEqual(['GET', 'POST', 'POST', 'PUT', 'GET', 'GET', 'POST', 'POST'])
    expect(actions.map((action) => preworkRouteIsPublic(route(action)))).toEqual([true, true, true, false, false, false, false, false])
    expect(preworkBodyLimit(route('waiting'))).toBeNull()
    expect(preworkBodyLimit(route('submit'))).toBe(PREWORK_LIMITS.submitBytes)
    expect(preworkBodyLimit(route('withdraw'))).toBe(PREWORK_LIMITS.withdrawBytes)
    expect(preworkBodyLimit(route(''))).toBeNull()
  })
})
