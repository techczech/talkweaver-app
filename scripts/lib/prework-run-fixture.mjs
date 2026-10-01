// A talk with pre-work and a Run that holds answers to it, for the Run page's tests (ticket 11).
// Participants are 16-hex hashes, as the Worker keeps them; nothing here is random-looking.
export const SLUG = 'agents-prework'
export const RUN_ID = 'run-prework-review'

export const OUTLINE = ['---', 'title: The current state of AI agents', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '## Opening', '{id=open}', '', '### Why we are here', '{id=why}', '', 'Kestrelwing talk text.', '',
  '## Before the session', '{id=pwform}{prework}', '', 'Four short steps.', '',
  '### Welcome: Zebrafinch pre-reading', '{id=pwwelcome}', '', '- Read this first', '',
  '### Quick check: what makes an agent?', '{poll=single}{id=pwquiz}{check}', '', '- Answers questions in full sentences', '- Uses tools to carry out steps {right}', '- Runs on a bigger model', '- Not sure yet', '',
  '### What do you hope to get out of the session?', '{poll=open}{id=pwhope}', '',
  '### Task 1: draft one email', '{id=pwtask1}{task}', '', '- Use any agent', '',
  '## Your turn', '{id=turn}', '',
  '### What do you hope for today?', '{poll=board}{results=pwhope}{id=hopesboard}', '', 'Add what you hope for.', '', '- Hopes', '- Worries', '',
  '### Discuss', '{id=discuss}', '', 'Talk slide.', ''].join('\n')

/** The same talk with two slides of one title and no ids of their own: the compiler calls the second `hopes-for-today-2`. */
export const DUP_TALK = ['---', 'title: Same title twice', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '## Before the session', '{id=pwform}{prework}', '', 'One step.', '',
  '### What do you hope to get out of the session?', '{poll=open}{id=pwhope}', '',
  '## Your turn', '{id=turn}', '',
  '### Hopes for today', '', 'A plain slide first.', '',
  '### Hopes for today', '{poll=board}{results=pwhope}', '', 'Add what you hope for.', '', '- Hopes', '- Worries', ''].join('\n')

export const person = (n) => n.toString(16).padStart(16, '0')
const DAY = 86_400_000
export const BASE = Date.UTC(2026, 8, 22, 9, 0, 0)

/** One participant's entries: reads, an answer per question, a done mark, questions. */
export function entry(n, kind, stepId, extra = {}, at = BASE + n * DAY / 4) {
  const participant = person(n)
  const id = kind === 'question' ? `${participant}:q:${extra.submissionId ?? 'one'}` : `${participant}:${kind}:${stepId}`
  const { submissionId: _s, ...rest } = extra
  return { id, participant, stepId, kind, at, ...rest }
}

export function entries() {
  const list = []
  // Nine people: all read the welcome; 8 answer the check (5 right, 2 on the first option, 1 not sure); 6 answer the hopes.
  for (let n = 1; n <= 9; n += 1) list.push(entry(n, 'read', 'pwwelcome'))
  const checks = ['-option-2', '-option-2', '-option-2', '-option-2', '-option-2', '-option-1', '-option-1', '-option-4']
  checks.forEach((suffix, index) => list.push(entry(index + 1, 'answer', 'pwquiz', { choice: `poll-pwquiz${suffix}` })))
  const hopes = ['Use an agent on my own files safely', 'Which tool the university supports', 'Whether it is allowed with student data',
    'Save time on admin email', 'Use an agent on my own files safely', '<b>Bold hopes</b> & more']
  hopes.forEach((text, index) => list.push(entry(index + 1, 'answer', 'pwhope', { text }, BASE + (index + 1) * 3_600_000)))
  for (let n = 1; n <= 4; n += 1) list.push(entry(n, 'done', 'pwtask1', { done: true }))
  list.push(entry(2, 'question', 'pwtask1', { text: 'Copilot will not open my Outlook drafts. Is that a licence thing?', submissionId: 'a' }, BASE + 5 * DAY))
  list.push(entry(3, 'question', 'pwtask1', { text: 'Can I use it for an email that mentions a student by name?', name: 'Sam', submissionId: 'b' }, BASE + 5 * DAY + 60_000))
  list.push(entry(4, 'question', 'pwwelcome', { text: 'Is Copilot Chat an agent?', submissionId: 'c' }, BASE + 4 * DAY))
  return list
}

export function plannedRun(overrides = {}) {
  return {
    id: RUN_ID, talkSlug: SLUG, talkTitle: 'The current state of AI agents', kind: 'delivery', status: 'planned',
    plannedDate: '2026-10-06', startTime: '10:00', eventTitle: 'ITSS Briefing, October', audience: 'IT Services staff', expectedPeople: 12,
    preworkOpens: '2026-09-22T09:00', preworkCloses: '2026-10-06T10:00', timeZone: 'Europe/London', slideSet: { kind: 'full' },
    startedAt: '2026-09-22T09:00:00.000Z', endedAt: '2026-09-22T09:00:00.000Z', recordingMs: 0, wallClockMs: 0, timerTargetMin: 0,
    context: null, pathwayId: null, audio: null, transcript: null, slideTimeIndex: [], polls: [], pollResponses: [],
    prework: { entries: entries(), people: 9, lastActivityAt: BASE + 5 * DAY },
    ...overrides,
  }
}
