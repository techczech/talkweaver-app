// The pre-work form on the published handout, the parts that need no page (ADR-0032 amendment point 2;
// feedback-boards ticket 10; drawings round-2 W1-W12, round-3 L3-L5). Every function here is one the page
// runtime embeds by `.toString()` (see preworkFormModelSource), so each is self-contained: no module-level
// constants of its own, and any function it calls is in that list.
//
// What a person's own entries say about each step, where "Carry on" goes, what is counted as done, what
// each refusal says, the saved answer a poll accepts (the Worker's own rule, validPreworkAnswer), and the
// icons. The page seam (screens, saving, "Ask about this") is prework-form.js.
//
// An entry is what POST /prework/<id>/mine returns and what a submission's answer carries:
//   { ref, stepId, kind: read | answer | done | question, choice?, text?, name?, done?, at }
// `ref` is `read:<step>`, `answer:<step>`, `done:<step>` or `q:<submissionId>`; a later entry with the
// same ref replaces the earlier one.

export function preworkIcons() {
  return {
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    'eye-off': '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
    eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
    'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    circle: '<circle cx="12" cy="12" r="10"/>',
    'circle-check': '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    'circle-dashed': '<path d="M10.1 2.182a10 10 0 0 1 3.8 0"/><path d="M13.9 21.818a10 10 0 0 1-3.8 0"/><path d="M17.609 3.721a10 10 0 0 1 2.69 2.7"/><path d="M2.182 13.9a10 10 0 0 1 0-3.8"/><path d="M20.279 17.609a10 10 0 0 1-2.7 2.69"/><path d="M21.818 10.1a10 10 0 0 1 0 3.8"/><path d="M3.721 6.391a10 10 0 0 1 2.7-2.69"/><path d="M6.391 20.279a10 10 0 0 1-2.69-2.7"/>',
    presentation: '<path d="M2 3h20"/><path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3"/><path d="m7 21 5-5 5 5"/>',
    'list-checks': '<path d="M13 5h8"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/>',
    'chart-bar': '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M7 16h8"/><path d="M7 11h12"/><path d="M7 6h3"/>',
    'square-check': '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/>',
    'message-circle-question-mark': '<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
    send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
    'chevron-left': '<path d="m15 18-6-6 6-6"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
    'maximize-2': '<path d="M15 3h6v6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/><path d="M9 21H3v-6"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    keyboard: '<path d="M10 8h.01"/><path d="M12 12h.01"/><path d="M14 8h.01"/><path d="M16 12h.01"/><path d="M18 8h.01"/><path d="M6 8h.01"/><path d="M7 16h10"/><path d="M8 12h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/>',
    'text-cursor-input': '<path d="M12 20h-1a2 2 0 0 1-2-2 2 2 0 0 1-2 2H6"/><path d="M13 8h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-7"/><path d="M5 16H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h1"/><path d="M6 4h1a2 2 0 0 1 2 2 2 2 0 0 1 2-2h1"/><path d="M9 6v12"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
  }
}

/**
 * A random id as lowercase hex, `bytes` long. `random(n)` returns n random bytes (crypto on the page, a
 * counter in a test). The Worker wants 16 to 100 letters, digits, - or _ for a device and any short id
 * for a submission.
 * @param {(n: number) => ArrayLike<number>} random @param {number} bytes
 */
export function preworkRandomId(random, bytes) {
  const data = random(bytes)
  let out = ''
  for (let i = 0; i < bytes; i += 1) out += ('0' + (Number(data[i]) & 255).toString(16)).slice(-2)
  return out
}

/**
 * The person's entries with `entry` in: a later entry with the same ref replaces the earlier one, the
 * rest keep their order. Returns a new array.
 * @param {any[]} entries @param {any} entry
 */
export function preworkMerge(entries, entry) {
  const at = entries.findIndex((held) => held.ref === entry.ref)
  if (at < 0) return [...entries, entry]
  const next = entries.slice()
  next[at] = entry
  return next
}

/**
 * Entries as the Worker sent them, kept only where they are well formed (a step id and a known kind).
 * @param {unknown} value
 */
export function normalisePreworkEntries(value) {
  const out = []
  const list = value && typeof value === 'object' && Array.isArray(value.entries) ? value.entries : []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || typeof raw.ref !== 'string' || typeof raw.stepId !== 'string') continue
    if (raw.kind !== 'read' && raw.kind !== 'answer' && raw.kind !== 'done' && raw.kind !== 'question') continue
    const entry = { ref: raw.ref, stepId: raw.stepId, kind: raw.kind, at: Number.isFinite(raw.at) ? raw.at : 0 }
    if (typeof raw.text === 'string') entry.text = raw.text
    if (raw.choice !== undefined && raw.choice !== null) entry.choice = raw.choice
    if (typeof raw.name === 'string') entry.name = raw.name
    if (typeof raw.done === 'boolean') entry.done = raw.done
    out.push(entry)
  }
  return out
}

/**
 * Where one step stands for this person.
 *   state  'todo' (nothing yet) | 'started' (a task opened but not marked done) | 'done'
 *   label  the word on the step's row: Not started, Read, Answered, Done, Not done yet
 *   tone   'todo' | 'started' | 'done' (the row's colour)
 *   answer the saved answer entry, done the saved done mark (true only when marked), questions this
 *          person asked about the step (oldest first)
 * @param {any} step @param {any[]} entries
 */
export function preworkStepState(step, entries) {
  const mine = entries.filter((entry) => entry.stepId === step.id)
  const read = mine.some((entry) => entry.kind === 'read')
  const answer = mine.find((entry) => entry.kind === 'answer') || null
  const doneEntry = mine.find((entry) => entry.kind === 'done') || null
  const done = Boolean(doneEntry && doneEntry.done === true)
  const questions = mine.filter((entry) => entry.kind === 'question').sort((a, b) => a.at - b.at)
  let state = 'todo'
  let label = 'Not started'
  if (step.kind === 'check' || step.kind === 'question') {
    if (answer) { state = 'done'; label = 'Answered' }
  } else if (step.kind === 'task' && step.done) {
    if (done) { state = 'done'; label = 'Done' }
    else if (read || doneEntry) { state = 'started'; label = 'Not done yet' }
  } else if (read) { state = 'done'; label = 'Read' }
  return { state, label, tone: state, answer, done, questions, read }
}

/**
 * The whole form against this person's entries: each step's state, how many are done, the step "Carry
 * on" goes to (the first not done, else null), and whether they have started at all.
 * @param {{ steps: any[] }} form @param {any[]} entries
 */
export function preworkProgress(form, entries) {
  const steps = form.steps.map((step) => ({ step, ...preworkStepState(step, entries) }))
  const doneCount = steps.filter((row) => row.state === 'done').length
  const next = steps.findIndex((row) => row.state !== 'done')
  const started = steps.some((row) => row.state !== 'todo' || row.questions.length > 0)
  return { steps, doneCount, total: steps.length, next: next < 0 ? null : next, allDone: steps.length > 0 && doneCount === steps.length, started }
}

/**
 * "About 20 minutes": each pre-task's own minutes, one minute for every other step. Null for none.
 * @param {{ steps: any[] }} form
 */
export function preworkMinutesText(form) {
  let minutes = 0
  for (const step of form.steps) minutes += step.kind === 'task' ? (Number(step.minutes) > 0 ? Number(step.minutes) : 10) : 1
  return minutes > 0 ? 'About ' + minutes + ' minutes' : ''
}

/** The word for a step's kind (W1: "Slide", "Quick check", "Question", "Pre-task · about 10 min").
 * @param {any} step @param {boolean} [long] "minutes" in full (the step's own header) */
export function preworkKindLabel(step, long) {
  if (step.kind === 'check') return 'Quick check'
  if (step.kind === 'question') return 'Question'
  if (step.kind === 'task') {
    const minutes = Number(step.minutes) > 0 ? Number(step.minutes) : 10
    return 'Pre-task \u00b7 ' + (long ? 'about ' + minutes + ' minutes' : 'about ' + minutes + ' min')
  }
  return 'Slide'
}

/** The icon a step's kind carries.
 * @param {any} step */
export function preworkKindIcon(step) {
  if (step.kind === 'check') return 'list-checks'
  if (step.kind === 'task') return 'square-check'
  if (step.kind === 'question') return step.poll && step.poll.type === 'open' ? 'text-cursor-input' : 'chart-bar'
  return 'presentation'
}

/**
 * A time as people write it on the handout: "Tue 6 Oct 09:00" in the reader's own zone (or `timeZone`).
 * @param {number} ms @param {string} [timeZone]
 */
export function preworkWhen(ms, timeZone) {
  if (!Number.isFinite(ms)) return ''
  let parts
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}),
    }).formatToParts(new Date(ms))
  } catch (_) { return '' }
  const get = (type) => { const part = parts.find((item) => item.type === type); return part ? part.value : '' }
  return get('weekday') + ' ' + get('day') + ' ' + get('month').replace(/^Sept$/, 'Sep') + ' ' + get('hour') + ':' + get('minute')
}

/** The day alone ("Tue 30 Sep"), for "marked Tue 30 Sep".
 * @param {number} ms @param {string} [timeZone] */
export function preworkDay(ms, timeZone) {
  if (!Number.isFinite(ms)) return ''
  return preworkWhen(ms, timeZone).replace(/ \d\d:\d\d$/, '')
}

/**
 * What the step says above its answer box and how many choices it takes, for each poll type.
 * @param {any} step
 */
export function preworkPollHint(step) {
  const poll = step.poll
  let text = ''
  if (!poll) return ''
  if (poll.type === 'single') text = 'Pick one.'
  else if (poll.type === 'multiple') text = poll.maxSelections ? 'Pick up to ' + poll.maxSelections + '.' : 'Pick any that fit.'
  else if (poll.type === 'open') text = 'A sentence is plenty.'
  else if (poll.type === 'ranking') text = 'Tap in order, best first' + (poll.rankCount ? ', ' + poll.rankCount + ' of them' : '') + '.'
  else text = poll.allowSkip ? 'Choose a label for any of these.' : 'Choose a label for each one.'
  if (step.kind === 'check') text += ' There is no mark: the room\u2019s answers are on a slide in the session.'
  return text
}

/**
 * The answer a poll accepts from what the person has chosen so far, or null while it is not complete.
 * The same rule as the Worker's validPreworkAnswer, so the page never sends what would be refused.
 *   single  an option id · multiple  option ids (at most maxSelections) · open  text (trimmed, not empty,
 *   at most 1000 characters) · ranking  option ids in order, exactly rankCount of them · rating and
 *   categorisation  { optionId: labelId } for every option (any of them with allowSkip)
 * @param {any} poll @param {any} draft
 * @returns {{ choice?: any, text?: string } | null}
 */
export function preworkAnswerReady(poll, draft) {
  if (!poll) return null
  const ids = new Set(poll.options.map((option) => option.optionId))
  if (poll.type === 'open') {
    const text = typeof draft === 'string' ? draft.trim() : ''
    return text && text.length <= 1000 ? { text } : null
  }
  if (poll.type === 'single') return typeof draft === 'string' && ids.has(draft) ? { choice: draft } : null
  if (poll.type === 'multiple') {
    if (!Array.isArray(draft)) return null
    const unique = Array.from(new Set(draft)).filter((id) => ids.has(id))
    return unique.length >= 1 && unique.length <= (poll.maxSelections || poll.options.length) ? { choice: unique } : null
  }
  if (poll.type === 'ranking') {
    const count = poll.rankCount || poll.options.length
    if (!Array.isArray(draft) || draft.length !== count || new Set(draft).size !== count || draft.some((id) => !ids.has(id))) return null
    return { choice: draft.slice() }
  }
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return null
  const labels = new Set((poll.labels || []).map((label) => label.optionId))
  const rows = Object.entries(draft)
  if (!rows.length || (!poll.allowSkip && rows.length !== poll.options.length)) return null
  if (rows.some(([row, label]) => !ids.has(row) || !labels.has(label))) return null
  return { choice: Object.fromEntries(rows) }
}

/**
 * The person's saved answer turned back into what the controls show (a draft `preworkAnswerReady` would
 * accept): the text, an option id, a list of ids or a map.
 * @param {any} entry
 */
export function preworkDraftFromEntry(entry) {
  if (!entry) return null
  if (typeof entry.text === 'string') return entry.text
  return entry.choice === undefined ? null : entry.choice
}

/**
 * The body of one submission (the Worker's own shape), with a submission id the caller keeps so the same
 * body can be sent again after a failure without doing anything twice.
 * @param {string} participantId @param {string} submissionId @param {string} stepId @param {'read'|'answer'|'done'|'question'} kind
 * @param {{ choice?: any, text?: string, name?: string, done?: boolean }} [extra]
 */
export function preworkSubmission(participantId, submissionId, stepId, kind, extra) {
  const body = { participantId, submissionId, stepId, kind }
  const more = extra || {}
  if (kind === 'answer') { if (more.text !== undefined) body.text = more.text; else body.choice = more.choice }
  if (kind === 'done') body.done = more.done === true
  if (kind === 'question') {
    body.text = String(more.text || '').trim()
    const name = String(more.name || '').trim()
    if (name) body.name = name
  }
  return body
}

/**
 * The entry a submission becomes on the device once the Worker took it, so the screen follows what was
 * saved without asking again. `at` is the Worker's when it sent one, else `now`.
 * @param {any} body @param {number} at
 */
export function preworkEntryFromSubmission(body, at) {
  const entry = { ref: body.kind === 'question' ? 'q:' + body.submissionId : body.kind + ':' + body.stepId, stepId: body.stepId, kind: body.kind, at }
  if (body.text !== undefined) entry.text = body.text
  if (body.choice !== undefined) entry.choice = body.choice
  if (body.name !== undefined) entry.name = body.name
  if (body.done !== undefined) entry.done = body.done
  return entry
}

/**
 * What a refused or failed submission says. `closed` means pre-work is over (the page shows the closed
 * state); `retry` means the same body may be sent again.
 * @param {number} status @param {string} [code] @param {number} [retryAfterMs]
 * @returns {{ text: string, retry: boolean, closed: boolean, waitMs: number }}
 */
export function preworkRefusal(status, code, retryAfterMs) {
  const wait = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.min(retryAfterMs, 3600000) : 0
  if (code === 'prework_closed' || status === 410) return { text: 'Pre-work has closed, so this could not be saved.', retry: false, closed: true, waitMs: 0 }
  if (code === 'prework_not_open') return { text: 'Pre-work has not opened yet.', retry: true, closed: false, waitMs: 30000 }
  if (code === 'question_limit') return { text: 'You have asked as many questions as this page allows.', retry: false, closed: false, waitMs: 0 }
  if (code === 'participant_limit') return { text: 'You have sent as many changes as this page allows.', retry: false, closed: false, waitMs: 0 }
  if (code === 'prework_full') return { text: 'This pre-work has no room for more answers.', retry: false, closed: false, waitMs: 0 }
  if (code === 'questions_off') return { text: 'The speaker has switched questions off for this step.', retry: false, closed: false, waitMs: 0 }
  if (status === 429 || code === 'rate_limited' || code === 'source_limit') return { text: 'Too many answers at once. Trying again shortly.', retry: true, closed: false, waitMs: wait || 8000 }
  if (status >= 500 || status === 0) return { text: 'Not saved yet: no connection to the speaker\u2019s page. Trying again.', retry: true, closed: false, waitMs: wait || 8000 }
  return { text: 'That could not be saved.', retry: false, closed: false, waitMs: 0 }
}

/**
 * The text of a slide as a phone reads it under the picture: its list items and paragraphs, in order.
 * `slide` is a DOM element (a clone the page owns); the result is plain strings, for textContent only.
 * @param {any} slide
 */
export function preworkSlideLines(slide) {
  const lines = []
  if (!slide || !slide.querySelectorAll) return lines
  const scope = slide.querySelector('.slide-content') || slide
  const nodes = scope.querySelectorAll('li, p')
  for (const node of Array.from(nodes)) {
    if (node.closest && node.closest('.notes, aside, script, style, template')) continue
    if (node.tagName === 'P' && node.closest && node.closest('li')) continue
    const copy = node.cloneNode(true)
    for (const nested of Array.from(copy.querySelectorAll('ul, ol'))) nested.remove()
    const text = String(copy.textContent || '').replace(/\s+/g, ' ').trim()
    if (text) lines.push({ text, item: node.tagName === 'LI' })
    if (lines.length >= 40) break
  }
  return lines
}

export function preworkFormModelSource() {
  return [preworkIcons, preworkRandomId, preworkMerge, normalisePreworkEntries, preworkStepState, preworkProgress, preworkMinutesText, preworkKindLabel,
    preworkKindIcon, preworkWhen, preworkDay, preworkPollHint, preworkAnswerReady, preworkDraftFromEntry, preworkSubmission, preworkEntryFromSubmission,
    preworkRefusal, preworkSlideLines].map((fn) => fn.toString()).join('\n')
}
