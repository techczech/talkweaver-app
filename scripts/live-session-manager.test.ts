import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLiveSessionManager } from '../src/main/live-session-manager'
import { feedbackWallClock, flushLiveSessionHistory, LiveHistoryGoneError, recoverFinalLiveHistory } from '../src/main/live-session-history'
import { attachDeliveryToPlanned, normaliseRun, persistRun, reactionCountsBySlide, readRun } from '../src/main/runs'
import { createLiveSessionStore } from '../src/main/live-session-store'

const record = () => ({
  sessionId: 'session-test', baseUrl: 'https://live.example.test', presenterToken: 'test-token',
  shortId: 'abcd', shortUrl: 'https://example.test/join', qrSvg: '<svg/>', talkSlug: 'talk-test',
  vaultRoot: '/test-vault', expiresAt: Date.now() + 60_000, startedAtMs: Date.now(),
  status: 'connecting', pending: [], polls: [], voteRecords: [], cursor: 0, latest: null, endRequested: false,
})
function harness(initial: any[] = [], endRemote = async () => 'ended', extra: any = {}) {
  let saved = structuredClone(initial)
  const clients: any[] = [], windows: any[] = [], history: any[] = [], timers: Array<() => void> = []
  const manager = createLiveSessionManager({
    load: () => structuredClone(saved), save: (rows: any[]) => { saved = structuredClone(rows) },
    createClient: (options: any) => {
      const client = { options, disconnected: false,
        disconnect() { this.disconnected = true }, reconnect() {},
        publish() {}, sendPoll(action: any) {
          const operationId = 'operation-test'
          options.onPendingChange([{ operationId, action }])
          return operationId
        },
      }
      clients.push(client); return client
    },
    endRemote,
    probe: async () => null,
    notify: (id: number, channel: string, value: any) => windows.push({id,channel,value}),
    flushHistory: (row: any) => { history.push(structuredClone(row)); return true },
    schedule: (fn: () => void) => { timers.push(fn); return timers.length as any },
    cancelSchedule: () => {},
    ...extra,
  })
  return { manager, clients, windows, history, timers, saved: () => saved }
}
describe('durable live session ownership', () => {
  test('forwards reaction counts and questions to the presenter window and keeps them for its snapshot', () => {
    const h = harness()
    h.manager.create(record(), 10)
    const options = h.clients[0].options
    options.onReactionSnapshot({ 'slide-1': { puzzled: 1 } })
    expect(h.windows.at(-1)).toMatchObject({ id: 10, channel: 'live:audience', value: { kind: 'snapshot', reactionCounts: { 'slide-1': { puzzled: 1 } }, questions: [] } })
    options.onReactionCounts('slide-2', { helped: 4 })
    expect(h.windows.at(-1)).toMatchObject({ id: 10, channel: 'live:audience', value: { kind: 'reaction', slideId: 'slide-2', counts: { helped: 4 } } })
    options.onQuestions([{ questionId: 'q1', text: 'Why?', slideId: 'slide-1', tMs: 1, acceptedAt: 2, answered: false }])
    expect(h.windows.at(-1)).toMatchObject({ channel: 'live:audience', value: { kind: 'questions' } })
    expect(h.manager.snapshot(10)).toMatchObject({ reactionCounts: { 'slide-1': { puzzled: 1 }, 'slide-2': { helped: 4 } }, questions: [{ text: 'Why?' }] })
    expect(h.saved()[0]).not.toHaveProperty('reactionCounts')
  })
  test('Mark answered is a live control: queued through the client, and the question text is never written to the recovery record', () => {
    const h = harness()
    h.manager.create(record(), 10)
    h.clients[0].options.onQuestions([{ questionId: 'q1', text: 'Secret question text', slideId: 'slide-1', tMs: 1, acceptedAt: 2, answered: false }])
    expect(h.manager.poll(10, { type: 'question.answer', questionId: 'q1', answered: true })).toEqual({ success: true, operationId: 'operation-test', status: 'pending' })
    expect(h.saved()[0].pending).toEqual([{ operationId: 'operation-test', action: { type: 'question.answer', questionId: 'q1', answered: true } }])
    expect(JSON.stringify(h.saved())).not.toContain('Secret question text')
    expect(h.manager.poll(99, { type: 'question.answer', questionId: 'q1', answered: true })).toMatchObject({ success: false })
  })
  test('forwards venue count to the presenter window and its snapshot', () => {
    const h = harness()
    h.manager.create(record(), 10)
    h.clients[0].options.onPresence({ presenterConnected: true, venueScreens: 2 })
    expect(h.windows.at(-1)).toMatchObject({ id: 10, channel: 'live:presence', value: { presenterConnected: true, venueScreens: 2 } })
    expect(h.manager.snapshot(10)?.venueScreens).toBe(2)
  })
  test('closing the presentation while keeping live retains its session and attaches to a reopened window', () => {
    const h = harness()
    h.manager.create(record(), 10)
    h.manager.detach(10)
    expect(h.clients[0].disconnected).toBe(false)
    expect(h.manager.attach(20, 'talk-test', '/test-vault')?.sessionId).toBe('session-test')
    expect(h.saved()).toHaveLength(1)
    expect(h.manager.snapshot(20)?.shortUrl).toBe('https://example.test/join')
    expect(h.manager.snapshot(20)).not.toHaveProperty('presenterToken')
  })
  test('an already attached session cannot be stolen by a second presentation window', () => {
    const h = harness()
    h.manager.create(record(), 10)
    expect(h.manager.attach(20, 'talk-test', '/test-vault')).toBeNull()
    expect(h.manager.inUse('talk-test', '/test-vault', 20)).toBe(true)
    expect(h.manager.snapshot(10)).not.toBeNull()
    expect(h.manager.snapshot(20)).toBeNull()
    h.manager.detach(10)
    expect(h.manager.attach(20, 'talk-test', '/test-vault')).not.toBeNull()
    expect(h.manager.attach(10, 'talk-test', '/test-vault')).toBeNull()
  })
  test('End retries final answers after remote closure and commits them before reporting ended', async () => {
    const vote = {type:'poll.vote-record',sequence:1,submissionId:'submission-last',pollId:'poll-test',
      choice:'a',acceptedAt:Date.now(),slideId:'slide-a'}
    let attempts = 0
    const h = harness([], async () => 'ended', { recoverFinal: async () => {
      if (++attempts === 1) throw new Error('temporary outage')
      return { polls: [], voteRecords: [vote], cursor: 1 }
    } })
    h.manager.create(record(), 10)
    await h.manager.end(10)
    expect(h.saved()[0].status).toBe('ending')
    h.timers.shift()!()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(h.saved()[0]).toMatchObject({ status: 'ended', cursor: 1, voteRecords: [vote] })
  })
  test('expiry and externally received closure also drain final answers', async () => {
    for (const ending of ['expired', 'ended']) {
      let drained = 0
      const h = harness([], async () => 'ended', { recoverFinal: async () => {
        drained++; return { polls: [], voteRecords: [], cursor: 0 }
      } })
      const row = record()
      if (ending === 'expired') row.expiresAt = Date.now() - 1
      h.manager.create(row, 10)
      if (ending === 'ended') h.clients[0].options.onStatus('ended')
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
      expect(drained).toBe(1)
      expect(h.saved()[0].status).toBe(ending)
    }
  })
  test('restarting restores pending commands and the same authenticated session', () => {
    const h = harness()
    h.manager.create(record(), 10)
    h.manager.poll(10, { type: 'poll.close', pollId: 'poll-test' })
    h.manager.shutdown()
    const restored = harness(h.saved())
    restored.manager.restore()
    expect(restored.clients[0].options.sessionId).toBe('session-test')
    expect(restored.clients[0].options.pending[0].action.type).toBe('poll.close')
    expect(restored.clients[0].options.presenterToken).toBe('test-token')
  })
  test('an offline End is saved before retrying and never reconnects as a live presenter', async () => {
    let calls = 0
    const h = harness([], async () => { calls++; throw new Error('unavailable') })
    h.manager.create(record(), 10)
    await h.manager.end(10)
    expect(h.saved()[0]).toMatchObject({endRequested:true,status:'ending',pending:[]})
    expect(h.clients[0].disconnected).toBe(true)
    const restored = harness(h.saved(), async () => 'ended')
    restored.manager.restore()
    await Promise.resolve(); await Promise.resolve()
    expect(restored.clients).toHaveLength(0)
    expect(restored.saved()[0].status).toBe('ended')
    expect(calls).toBe(1)
  })
  test('an unavailable Run is retried after the remote session has safely ended', async () => {
    let available = false, writes = 0
    const h = harness([], async () => 'ended', { flushHistory: () => { writes++; return available } })
    h.manager.create(record(), 10)
    h.manager.bindRun(10, { talkSlug: 'talk-test', runId: 'run-original' })
    await h.manager.end(10)
    expect(h.saved()[0].status).toBe('ended')
    const before = writes
    available = true
    h.timers.shift()!()
    expect(writes).toBe(before + 1)
  })
  test('missing records are saved while detached and merge into the original Run once', () => {
    const h = harness()
    h.manager.create(record(), 10)
    h.manager.bindRun(10, {talkSlug:'talk-test',runId:'run-original'})
    h.manager.detach(10)
    const vote = {type:'poll.vote-record',sequence:1,submissionId:'submission-one',pollId:'poll-test',
      choice:'a',acceptedAt:Date.now(),slideId:'slide-a'}
    h.clients[0].options.onPollVoteRecord(vote)
    h.clients[0].options.onPollVoteRecord(vote)
    expect(h.saved()[0].voteRecords).toEqual([vote])
    expect(h.history.at(-1).runId).toBe('run-original')
    expect(h.history.at(-1).voteRecords).toEqual([vote])
  })
})
test('recovery tokens and records are written through the cipher and restored atomically', () => {
  const dir = mkdtempSync(join(tmpdir(),'tw-live-store-'))
  try {
    const path = join(dir,'recovery.bin')
    const cipher = {
      isEncryptionAvailable: () => true,
      encryptString: (text: string) => Buffer.from(text).map((v) => v ^ 0x55),
      decryptString: (bytes: Buffer) => Buffer.from(bytes.map((v) => v ^ 0x55)).toString(),
    }
    const store = createLiveSessionStore(path,cipher)
    store.save([record()])
    expect(readFileSync(path).toString()).not.toContain('test-token')
    expect(store.load()[0].presenterToken).toBe('test-token')
    expect(() => createLiveSessionStore(path,{...cipher,isEncryptionAvailable:()=>false}).save([])).toThrow()
  } finally { rmSync(dir,{recursive:true,force:true}) }
})

test('recovered answers merge into the original stored Run without duplication', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-live-history-'))
  try {
    persistRun(dir, normaliseRun({ id: 'run-original', talkSlug: 'talk-test', startedAt: new Date(1000).toISOString() }))
    const row: any = { ...record(), vaultRoot: dir, runId: 'run-original', polls: [
      { type: 'poll.state', pollId: 'poll-test', pollType: 'single', question: 'Choose',
        options: [{optionId:'a',label:'A'}],visibility:'held',open:false,revealed:false }],
      voteRecords: [{type:'poll.vote-record',sequence:1,submissionId:'submission-last',pollId:'poll-test',
        choice:'a',acceptedAt:2500,slideId:'slide-a'}] }
    expect(flushLiveSessionHistory(row)).toBe(true)
    expect(flushLiveSessionHistory(row)).toBe(true)
    const run = readRun(dir, 'talk-test', 'run-original')!
    expect(run.pollResponses).toHaveLength(1)
    expect(run.pollResponses[0]).toMatchObject({tMs:1500,slideId:'slide-a',choice:'a',responseId:'session-test:1'})
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('recovered mixed polls preserve limits, definitions and every ballot shape in the original Run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-extended-history-'))
  try {
    persistRun(dir, normaliseRun({ id: 'run-original', talkSlug: 'talk-test', startedAt: new Date(1000).toISOString() }))
    const options = [{ optionId: 'a', label: 'A' }, { optionId: 'b', label: 'B' }]
    const labels = [{ optionId: 'often', label: 'Often' }, { optionId: 'never', label: 'Never' }]
    const polls = ['ranking', 'rating', 'categorisation'].map(pollType => ({
      type: 'poll.state', pollId: pollType, pollType, question: 'Choose', options,
      visibility: 'held', open: false, revealed: false,
      ...(pollType === 'ranking' ? { rankCount: 1 } : { labels, allowSkip: true }),
    }))
    polls.push(
      { type: 'poll.state', pollId: 'multiple', pollType: 'multiple', question: 'Select', options, visibility: 'held', open: false, revealed: false, maxSelections: 1 } as any,
      { type: 'poll.state', pollId: 'open', pollType: 'open', question: 'Ideas', options: [], visibility: 'held', open: false, revealed: false, maxSubmissions: null } as any,
    )
    const choices = [['b'], { a: 'often' }, { b: 'never' }, ['a'], 'A new idea']
    const row: any = { ...record(), vaultRoot: dir, runId: 'run-original', polls,
      voteRecords: polls.map((poll, i) => ({ type: 'poll.vote-record', sequence: i + 1,
        submissionId: 'submission-' + i, pollId: poll.pollId, choice: choices[i], acceptedAt: 2500, slideId: 'slide-a' })) }
    expect(flushLiveSessionHistory(row)).toBe(true)
    expect(flushLiveSessionHistory(row)).toBe(true)
    const run = readRun(dir, 'talk-test', 'run-original')!
    expect(run.polls).toHaveLength(5)
    expect(run.polls[0]).toMatchObject({ type: 'ranking', rankCount: 1 })
    expect(run.polls[1]).toMatchObject({ type: 'rating', labels, allowSkip: true })
    expect(run.polls[2]).toMatchObject({ type: 'categorisation', labels, allowSkip: true })
    expect(run.polls[3]).toMatchObject({ type: 'multiple', maxSelections: 1 })
    expect(run.polls[4]).toMatchObject({ type: 'open', maxSubmissions: null })
    expect(run.pollResponses.map(r => r.choice ?? r.text)).toEqual(choices)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// Live-presenting ticket 07: every instant slide shown is kept with the slide it followed and lands
// on the Run once, however many times the presenter client reports it.
test('instant slides shown are recorded with their anchor slide and flushed onto the Run once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-instant-history-'))
  try {
    persistRun(dir, normaliseRun({ id: 'run-original', talkSlug: 'talk-test', startedAt: new Date(1000).toISOString() }))
    const h = harness()
    h.manager.create({ ...record(), vaultRoot: dir } as any, 10)
    h.manager.bindRun(10, { talkSlug: 'talk-test', runId: 'run-original' })
    h.manager.publish(10, { slideId: 'slide-5', reveal: 0, focus: null })
    const link = { kind: 'link', url: 'https://example.org/a', qrSvg: '<svg/>', shownAt: 2000 }
    const show = { type: 'instant.show', slide: link }
    h.clients[0].options.onOperation({ operationId: 'op-1', status: 'pending', message: show })
    expect(h.saved()[0].instantHistory ?? []).toEqual([])
    h.clients[0].options.onOperation({ operationId: 'op-1', status: 'confirmed', message: show })
    h.manager.publish(10, { slideId: 'slide-6', reveal: 0, focus: null })
    h.clients[0].options.onInstantSlide(link) // server echo of the same show: not a second entry
    h.clients[0].options.onInstantSlide({ kind: 'countdown', startedAt: 3000, durationMs: 60000, shownAt: 3000 })
    h.clients[0].options.onOperation({ operationId: 'op-2', status: 'confirmed', message: { type: 'instant.clear' } })
    expect(h.saved()[0].instantHistory).toEqual([
      { id: 'link-2000', kind: 'link', shownAt: 2000, afterSlideId: 'slide-5', url: 'https://example.org/a' },
      { id: 'countdown-3000', kind: 'countdown', shownAt: 3000, afterSlideId: 'slide-6', durationMs: 60000 },
    ])
    const row = h.history.at(-1)
    expect(flushLiveSessionHistory(row)).toBe(true)
    expect(flushLiveSessionHistory(row)).toBe(true)
    const run = readRun(dir, 'talk-test', 'run-original')!
    expect(run.instantSlides?.map((e) => [e.id, e.afterSlideId])).toEqual([['link-2000', 'slide-5'], ['countdown-3000', 'slide-6']])
    expect(JSON.parse(readFileSync(join(dir, '_PRESENTATIONS', 'talk-test', 'run-original.json'), 'utf8')).instantSlides).toHaveLength(2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// Review fix (ticket 07): the slide an instant slide followed is the presenter's slide when it was
// SHOWN, not the slide reached by the time the server confirms it (or echoes it back).
test('an instant slide is anchored to the slide on screen when it was shown, even if the presenter moves before confirmation', () => {
  const h = harness()
  h.manager.create(record() as any, 10)
  h.manager.publish(10, { slideId: 'slide-5', reveal: 0, focus: null })
  const text = { kind: 'text', text: 'Try it now', shownAt: 7000 }
  expect(h.manager.poll(10, { type: 'instant.show', slide: text } as any)).toMatchObject({ success: true })
  h.manager.publish(10, { slideId: 'slide-6', reveal: 0, focus: null }) // presenter advances first
  h.manager.publish(10, { slideId: 'slide-7', reveal: 0, focus: null })
  h.clients[0].options.onInstantSlide(text) // the server's echo arrives before the confirmation
  h.clients[0].options.onOperation({ operationId: 'operation-test', status: 'confirmed', message: { type: 'instant.show', slide: text } })
  expect(h.saved()[0].instantHistory).toEqual([{ id: 'text-7000', kind: 'text', shownAt: 7000, afterSlideId: 'slide-5', text: 'Try it now' }])
  // The anchor is kept durably with the session, so a restart before confirmation keeps it too.
  expect(h.saved()[0].instantAnchors).toEqual({ 'text-7000': 'slide-5' })
})

// Reactions ticket 06: the session's reaction records and questions reach the Run through the history
// flush. They are held in memory (never in the recovery record) and the flush merges them by id.
describe('reactions and questions on the Run', () => {
  const START = Date.parse('2026-09-29T14:00:00.000Z')
  const reactionRecord = (sequence: number, reaction: string, slideId: string, tMs: number, withdrawn = false) =>
    ({ reaction, slideId, tMs, ...(withdrawn ? { withdrawn: true } : {}), sequence, acceptedAt: tMs + 50 })
  const question = (n: number, text: string, slideId: string, tMs: number, answered = false, name?: string) =>
    ({ questionId: `question-${n}`, text, ...(name ? { name } : {}), slideId, tMs, acceptedAt: tMs + 50, answered })
  // Timers the test runs by hand; cancelled ones never fire.
  function fakeTimers() {
    let next = 0
    const live = new Map<number, { fn: () => void; ms: number }>()
    return {
      deps: {
        schedule: (fn: () => void, ms: number) => { live.set(++next, { fn, ms }); return next as any },
        cancelSchedule: (id: any) => { live.delete(id) },
      },
      pending: () => [...live.values()].map((t) => t.ms),
      run(ms: number) { for (const [id, t] of [...live]) if (t.ms === ms) { live.delete(id); t.fn() } },
    }
  }

  test('the flush writes reactions, a withdrawal and questions as run-relative times, and nets the counts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-feedback-history-'))
    try {
      persistRun(dir, normaliseRun({ id: 'run-original', talkSlug: 'talk-test', startedAt: new Date(START).toISOString() }))
      const row: any = { ...record(), vaultRoot: dir, runId: 'run-original', startedAtMs: START }
      const feedback: any = {
        reactionRecords: [
          reactionRecord(1, 'puzzled', 'slide-3', START + 41_000),
          reactionRecord(2, 'puzzled', 'slide-3', START + 45_000, true),
          reactionRecord(3, 'helped', 'slide-3', START + 45_000),
          reactionRecord(4, 'bookmark', 'slide-3', START + 46_000),
          reactionRecord(5, 'puzzled', 'slide-4', START - 5_000), // a phone clock behind the Run's start
        ],
        questions: [question(1, 'Why?', 'slide-3', START + 46_000, false, 'Priya'), question(2, 'How?', 'slide-4', START + 60_000)],
      }
      expect(flushLiveSessionHistory(row, feedback)).toBe(true)
      expect(flushLiveSessionHistory(row, feedback)).toBe(true)
      let run = readRun(dir, 'talk-test', 'run-original')!
      expect(run.reactions).toEqual([
        { id: 'session-test:r1', reaction: 'puzzled', slideId: 'slide-3', tMs: 41_000 },
        { id: 'session-test:r2', reaction: 'puzzled', slideId: 'slide-3', tMs: 45_000, withdrawn: true },
        { id: 'session-test:r3', reaction: 'helped', slideId: 'slide-3', tMs: 45_000 },
        { id: 'session-test:r4', reaction: 'bookmark', slideId: 'slide-3', tMs: 46_000 },
        { id: 'session-test:r5', reaction: 'puzzled', slideId: 'slide-4', tMs: 0 },
      ])
      expect(reactionCountsBySlide(run.reactions!)).toEqual([
        { slideId: 'slide-3', counts: { helped: 1, bookmark: 1 } },
        { slideId: 'slide-4', counts: { puzzled: 1 } },
      ])
      expect(run.questions).toEqual([
        { id: 'session-test:question-1', text: 'Why?', name: 'Priya', slideId: 'slide-3', tMs: 46_000, answered: false },
        { id: 'session-test:question-2', text: 'How?', slideId: 'slide-4', tMs: 60_000, answered: false },
      ])
      // Marked answered later; the next flush (with records the worker replays from 0 after a restart) updates in place.
      expect(flushLiveSessionHistory(row, { ...feedback, questions: [{ ...feedback.questions[0], answered: true }] })).toBe(true)
      run = readRun(dir, 'talk-test', 'run-original')!
      expect(run.reactions).toHaveLength(5)
      expect(run.questions!.map((q) => [q.text, q.answered])).toEqual([['Why?', true], ['How?', false]])
      // A flush with no feedback (an old caller, or a restart before the replay) leaves both alone.
      expect(flushLiveSessionHistory(row)).toBe(true)
      expect(readRun(dir, 'talk-test', 'run-original')).toEqual(run)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('the manager keeps records in sequence once each, writes reactions and questions at most every 1.5 s, and never saves them', () => {
    const feedbacks: any[] = []
    const clock = fakeTimers()
    const h = harness([], async () => 'ended', { ...clock.deps, flushHistory: (_row: any, feedback: any) => { feedbacks.push(structuredClone(feedback)); return true } })
    h.manager.create(record(), 10)
    h.manager.bindRun(10, { talkSlug: 'talk-test', runId: 'run-original' })
    expect(feedbacks).toHaveLength(1) // bindRun writes at once
    const options = h.clients[0].options
    expect(options.afterReactionSequence).toBe(0)
    options.onReactionRecords([reactionRecord(1, 'puzzled', 'slide-1', START)])
    options.onReactionRecords([reactionRecord(1, 'puzzled', 'slide-1', START), reactionRecord(2, 'helped', 'slide-1', START)])
    options.onQuestions([question(1, 'Secret question text', 'slide-1', START)])
    options.onQuestions([question(1, 'Secret question text', 'slide-1', START)])
    expect(feedbacks).toHaveLength(1) // nothing written yet: one trailing write is due
    expect(clock.pending()).toEqual([1500])
    clock.run(1500)
    expect(feedbacks).toHaveLength(2)
    expect(feedbacks.at(-1).reactionRecords.map((r: any) => r.sequence)).toEqual([1, 2])
    expect(feedbacks.at(-1).questions).toHaveLength(1)
    // A reaction then a detach: the detach writes at once and the trailing write is cancelled.
    options.onReactionRecords([reactionRecord(3, 'bookmark', 'slide-1', START)])
    h.manager.detach(10)
    expect(feedbacks).toHaveLength(3)
    expect(feedbacks.at(-1).reactionRecords).toHaveLength(3)
    expect(clock.pending()).toEqual([])
    expect(JSON.stringify(h.saved())).not.toContain('Secret question text')
    expect(JSON.stringify(h.saved())).not.toContain('"reactionRecords"')
  })

  test('ending recovers the final reactions after the last one held and the final questions', async () => {
    const feedbacks: any[] = []
    let asked = -1
    const h = harness([], async () => 'ended', {
      flushHistory: (_row: any, feedback: any) => { feedbacks.push(structuredClone(feedback)); return true },
      recoverFinal: async (row: any, afterReactionSequence: number) => {
        asked = afterReactionSequence
        return { polls: row.polls, voteRecords: row.voteRecords, cursor: row.cursor,
          reactionRecords: [reactionRecord(2, 'bookmark', 'slide-2', START)], questions: [question(1, 'Final?', 'slide-2', START, true)] }
      },
    })
    h.manager.create(record(), 10)
    h.manager.bindRun(10, { talkSlug: 'talk-test', runId: 'run-original' })
    h.clients[0].options.onReactionRecords([reactionRecord(1, 'puzzled', 'slide-1', START)])
    await h.manager.end(10)
    expect(asked).toBe(1)
    expect(feedbacks.at(-1).reactionRecords.map((r: any) => r.sequence)).toEqual([1, 2])
    expect(feedbacks.at(-1).questions).toEqual([question(1, 'Final?', 'slide-2', START, true)])
    expect(h.saved()[0].status).toBe('ended')
  })
})

test('final recovery pages reaction records after the last one held, with the questions, and refuses a gap', async () => {
  const rec = (sequence: number) => ({ reaction: 'helped', slideId: 'slide-1', tMs: 10, sequence, acceptedAt: 20 })
  const pages = [
    { polls: [], voteRecords: [], moreRecords: false, questions: [], reactionRecords: [rec(3), rec(4)], moreReactionRecords: true },
    { polls: [], voteRecords: [], moreRecords: false, reactionRecords: [rec(5)], moreReactionRecords: false,
      questions: [{ questionId: 'question-1', text: 'Why?', slideId: 'slide-1', tMs: 1, acceptedAt: 2, answered: true }] },
  ]
  const urls: string[] = []
  const fetchPages = (list: any[]) => (async (url: string) => { urls.push(url); return { ok: true, json: async () => list.shift() } }) as any
  const final = await recoverFinalLiveHistory(record() as any, 2, fetchPages([...pages]))
  expect(urls.map((u) => new URL(u).searchParams.get('afterReactionSequence'))).toEqual(['2', '4'])
  expect(final.reactionRecords.map((r) => r.sequence)).toEqual([3, 4, 5])
  expect(final.questions?.map((q) => q.answered)).toEqual([true])
  await expect(recoverFinalLiveHistory(record() as any, 0, fetchPages([{ ...pages[1] }]))).rejects.toThrow('Incomplete final reaction history.')
  // A worker from before reactions: neither field; nothing is invented.
  const older = await recoverFinalLiveHistory(record() as any, 0, fetchPages([{ polls: [], voteRecords: [], moreRecords: false }]))
  expect(older.reactionRecords).toEqual([])
  expect('questions' in older).toBe(false)
})

// Ticket 06 fix round (S1): an ended session whose reactions and questions could not be written
// (the Run file is only created when the recording is saved) must not lose them on quit.
describe('ended-session history survives a failed write and a restart', () => {
  const START = Date.parse('2026-09-29T14:00:00.000Z')
  const reactions = [
    { reaction: 'puzzled', slideId: 'slide-1', tMs: START + 10_000, sequence: 1, acceptedAt: START + 10_100 },
    { reaction: 'puzzled', slideId: 'slide-1', tMs: START + 12_000, withdrawn: true, sequence: 2, acceptedAt: START + 12_100 },
    { reaction: 'helped', slideId: 'slide-1', tMs: START + 12_000, sequence: 3, acceptedAt: START + 12_100 },
  ]
  const questions = [{ questionId: 'question-1', text: 'Why?', name: 'Priya', slideId: 'slide-1', tMs: START + 15_000, acceptedAt: START + 15_100, answered: true }]
  // A worker that still serves the ended session's history (after expiry too).
  const worker = async (_row: any, after: number) => ({ polls: [], voteRecords: [], cursor: 0,
    reactionRecords: reactions.filter((r) => r.sequence > after), questions })

  test('end, the Run is not there yet, quit; after a restart the records are fetched again and land on the Run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-feedback-restart-'))
    try {
      const h = harness([], async () => 'ended', { recoverFinal: worker, flushHistory: flushLiveSessionHistory })
      h.manager.create({ ...record(), vaultRoot: dir, startedAtMs: START } as any, 10)
      h.manager.bindRun(10, { talkSlug: 'talk-test', runId: 'run-later' })
      h.clients[0].options.onReactionRecords(reactions.slice(0, 1))
      await h.manager.end(10)
      expect(h.saved()[0]).toMatchObject({ status: 'ended', historyPending: true })
      expect(JSON.stringify(h.saved())).not.toContain('Why?')
      h.manager.shutdown() // quit before the 30 s retry
      // The recording is saved (by another process lifetime, or after the quit): the Run now exists.
      persistRun(dir, normaliseRun({ id: 'run-later', talkSlug: 'talk-test', startedAt: new Date(START).toISOString() }))
      const again = harness(h.saved(), async () => 'ended', { recoverFinal: worker, flushHistory: flushLiveSessionHistory })
      again.manager.restore()
      await new Promise((resolve) => setTimeout(resolve, 0))
      const run = readRun(dir, 'talk-test', 'run-later')!
      expect(run.reactions?.map((r) => [r.reaction, r.tMs, r.withdrawn === true])).toEqual([['puzzled', 10_000, false], ['puzzled', 12_000, true], ['helped', 12_000, false]])
      expect(run.questions).toEqual([{ id: 'session-test:question-1', text: 'Why?', name: 'Priya', slideId: 'slide-1', tMs: 15_000, answered: true }])
      expect(again.saved()[0].historyPending).toBe(false)
      expect(again.clients).toHaveLength(0) // an ended session is not reconnected
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('a restart whose final recovery fails keeps the flag and retries; a partial write never clears it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-feedback-retry-'))
    try {
      persistRun(dir, normaliseRun({ id: 'run-later', talkSlug: 'talk-test', startedAt: new Date(START).toISOString() }))
      const saved = [{ ...record(), vaultRoot: dir, startedAtMs: START, runId: 'run-later', status: 'ended', endRequested: true, historyPending: true }]
      let fail = true
      const h = harness(saved, async () => 'ended', { flushHistory: flushLiveSessionHistory,
        recoverFinal: async (row: any, after: number) => { if (fail) throw new Error('offline'); return worker(row, after) } })
      h.manager.restore()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(h.saved()[0].historyPending).toBe(true)
      expect(readRun(dir, 'talk-test', 'run-later')!.reactions).toBeUndefined()
      fail = false
      h.timers.shift()!() // the 30 s retry
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(readRun(dir, 'talk-test', 'run-later')!.reactions).toHaveLength(3)
      expect(h.saved()[0].historyPending).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('the recording save writes a bound session\'s history at once, without waiting for the retry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-feedback-saved-'))
    try {
      const h = harness([], async () => 'ended', { recoverFinal: worker, flushHistory: flushLiveSessionHistory })
      h.manager.create({ ...record(), vaultRoot: dir, startedAtMs: START } as any, 10)
      h.manager.bindRun(10, { talkSlug: 'talk-test', runId: 'run-later' })
      await h.manager.end(10)
      expect(h.saved()[0].historyPending).toBe(true)
      persistRun(dir, normaliseRun({ id: 'run-later', talkSlug: 'talk-test', startedAt: new Date(START).toISOString() }))
      h.manager.runSaved('talk-test', 'other-run')
      expect(readRun(dir, 'talk-test', 'run-later')!.reactions).toBeUndefined()
      h.manager.runSaved('talk-test', 'run-later')
      expect(readRun(dir, 'talk-test', 'run-later')!.reactions).toHaveLength(3)
      expect(readRun(dir, 'talk-test', 'run-later')!.questions).toHaveLength(1)
      expect(h.saved()[0].historyPending).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

// Ticket 06 fix round (S2, 6a): the phone's clock is bounded by the worker's acceptance time, and a
// malformed entry or list is skipped without losing the rest of the flush.
describe('flush input', () => {
  const START = Date.parse('2026-09-29T14:00:00.000Z')
  test('device time is kept when plausible (a long offline queue included); a clock hours out falls back to acceptance', () => {
    const at = (min: number) => START + min * 60_000
    expect(feedbackWallClock(at(2), at(22), START)).toBe(at(2)) // queued offline for 20 minutes: kept
    expect(feedbackWallClock(at(-1), at(3), START)).toBe(at(-1)) // a minute before the start: kept
    expect(feedbackWallClock(at(-2), at(3), START)).toBe(at(3)) // earlier than that: not believed
    expect(feedbackWallClock(at(22) + 1, at(22), START)).toBe(at(22)) // never later than acceptance
    expect(feedbackWallClock(at(3 * 60), at(22), START)).toBe(at(22)) // clock three hours ahead
    expect(feedbackWallClock(at(-3 * 60), at(22), START)).toBe(at(22)) // clock three hours behind
    const dir = mkdtempSync(join(tmpdir(), 'tw-feedback-clock-'))
    try {
      persistRun(dir, normaliseRun({ id: 'run-original', talkSlug: 'talk-test', startedAt: new Date(START).toISOString() }))
      const row: any = { ...record(), vaultRoot: dir, runId: 'run-original', startedAtMs: START }
      flushLiveSessionHistory(row, { questions: [
        { questionId: 'question-1', text: 'Asked offline', slideId: 's', tMs: at(2), acceptedAt: at(22), answered: false },
        { questionId: 'question-2', text: 'Fast clock', slideId: 's', tMs: at(200), acceptedAt: at(23), answered: false },
      ], reactionRecords: [
        { reaction: 'helped', slideId: 's', tMs: at(3), sequence: 1, acceptedAt: at(22) },
        { reaction: 'helped', slideId: 's', tMs: at(-180), sequence: 2, acceptedAt: at(24) },
      ] } as any)
      const run = readRun(dir, 'talk-test', 'run-original')!
      expect(run.questions!.map((q) => [q.text, q.tMs])).toEqual([['Asked offline', 2 * 60_000], ['Fast clock', 23 * 60_000]])
      expect(run.reactions!.map((r) => r.tMs)).toEqual([3 * 60_000, 24 * 60_000])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('a vote flushed into a planned Run is re-timed from the true start once the delivery is saved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-vote-retime-'))
    try {
      const midnight = Date.parse('2026-09-29T00:00:00.000Z')
      persistRun(dir, normaliseRun({ id: 'run-planned', talkSlug: 'talk-test', status: 'planned', plannedDate: '2026-09-29',
        eventTitle: 'Seminar', slideSet: { kind: 'full' }, startedAt: new Date(midnight).toISOString() }))
      const row: any = { ...record(), vaultRoot: dir, runId: 'run-planned', startedAtMs: START,
        polls: [{ type: 'poll.state', pollId: 'p1', pollType: 'single', question: 'Choose', options: [{ optionId: 'a', label: 'A' }], visibility: 'live', open: true, revealed: false }],
        voteRecords: [{ type: 'poll.vote-record', sequence: 1, submissionId: 'v1', pollId: 'p1', choice: 'a', acceptedAt: START + 30_000, slideId: 's1' }] }
      flushLiveSessionHistory(row)
      expect(readRun(dir, 'talk-test', 'run-planned')!.pollResponses[0].tMs).toBe(START + 30_000 - midnight) // 50,430,000
      // The recording save attaches the delivery (true start) to the planned Run.
      const planned = readRun(dir, 'talk-test', 'run-planned')!
      persistRun(dir, attachDeliveryToPlanned(planned, normaliseRun({ id: 'sess-x', talkSlug: 'talk-test', startedAt: new Date(START).toISOString() })))
      flushLiveSessionHistory(row)
      const run = readRun(dir, 'talk-test', 'run-planned')!
      expect(run.pollResponses).toHaveLength(1)
      expect(run.pollResponses[0]).toMatchObject({ responseId: 'session-test:1', tMs: 30_000, choice: 'a', slideId: 's1' })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('non-object entries and non-array lists are skipped one by one; withdrawn other than true drops the entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-feedback-junk-'))
    try {
      persistRun(dir, normaliseRun({ id: 'run-original', talkSlug: 'talk-test', startedAt: new Date(START).toISOString() }))
      const good = { reaction: 'helped', slideId: 's', tMs: START + 1000, sequence: 1, acceptedAt: START + 1000 }
      const row: any = { ...record(), vaultRoot: dir, runId: 'run-original', startedAtMs: START,
        polls: [null, 'poll', { type: 'poll.state', pollId: 'bad' }], voteRecords: { sequence: 1 }, instantHistory: [null, 7] }
      expect(() => flushLiveSessionHistory(row, { reactionRecords: [null, 'x', [1], good,
        { ...good, sequence: 2, withdrawn: 'yes' }, { ...good, sequence: 3, withdrawn: false }, { ...good, sequence: 4, withdrawn: true }],
        questions: 'Why?' } as any)).not.toThrow()
      const run = readRun(dir, 'talk-test', 'run-original')!
      expect(run.reactions!.map((r) => [r.id, r.withdrawn === true])).toEqual([['session-test:r1', false], ['session-test:r4', true]])
      expect(run.questions).toBeUndefined()
      expect(run.polls).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

// Ticket 06 second fix round: a worker that answers 401 or 404 will never serve the history; the
// pending flag is cleared and nothing retries it, on this launch or the next.
test('final recovery treats 401 and 404 as final: the flag is cleared and no retry is scheduled', async () => {
  for (const status of [401, 404]) {
    const gone = await recoverFinalLiveHistory(record() as any, 0, (async () => ({ ok: false, status, json: async () => ({}) })) as any).catch((e) => e)
    expect(gone).toBeInstanceOf(LiveHistoryGoneError)
    expect(gone.final).toBe(true)
  }
  const other = await recoverFinalLiveHistory(record() as any, 0, (async () => ({ ok: false, status: 503, json: async () => ({}) })) as any).catch((e) => e)
  expect(other.final).toBeUndefined()
  const saved = [{ ...record(), runId: 'run-x', status: 'ended', endRequested: true, historyPending: true }]
  const events: any[] = []
  let calls = 0
  const h = harness(saved, async () => 'ended', { flushHistory: () => false, diagnostic: (e: any) => events.push(e),
    recoverFinal: async () => { calls++; throw new LiveHistoryGoneError(401) } })
  h.manager.restore()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(calls).toBe(1)
  expect(h.saved()[0].historyPending).toBe(false)
  expect(events).toContainEqual(expect.objectContaining({ event: 'history-recovery-gone', code: 401 }))
  expect(events.some((e) => e.event === 'history-recovery-pending')).toBe(false)
  // The next launch does not ask again.
  const next = harness(h.saved(), async () => 'ended', { flushHistory: () => false, recoverFinal: async () => { calls++; return {} as any } })
  next.manager.restore()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(calls).toBe(1)
})

// Feedback-boards ticket 06: the board flushed to the Run like the reactions record; a board left open
// after End live takes late cards, History refreshes them into the Run, and Close it now closes it.
describe('boards on the Run', () => {
  const START = Date.parse('2026-09-28T13:00:00.000Z')
  const END = START + 62 * 60_000
  const card = (n: number, column: string, text: string, acceptedAt: number, extra: any = {}) =>
    ({ cardId: `card-${n}`, column, text, acceptedAt, ...extra })
  const boardPoll = (cards: any[], open = true, groups: any[] = []) => ({
    type: 'poll.state', pollId: 'poll-board', slideId: 'slide-44', pollType: 'board', question: 'What should we keep, change, try?',
    options: [{ optionId: 'keep', label: 'Keep' }, { optionId: 'try', label: 'Try' }], visibility: 'live', open, revealed: true,
    board: { limit: 24, cardChars: 140, cardsPerPhone: 5, names: false, closesAfterDays: 7 },
    boardState: { frozen: false, limit: 24, release: { extra: 0, all: false, groupsOnly: false, columns: {} }, cards, groups,
      columns: [], entries: cards.length, shown: cards.length, waiting: 0, cardCount: cards.filter((c) => !c.hidden).length },
  })
  const liveCards = [
    card(1, 'keep', 'More time for hands-on', START + 60_000, { group: 1 }),
    card(2, 'keep', 'Hands-on please', START + 61_000, { group: 1 }),
    card(3, 'try', 'Pair work', START + 62_000),
    card(4, 'try', 'This is a waste of a morning', START + 63_000, { hidden: true }),
  ]
  const groups = [{ n: 1, column: 'keep', cardIds: ['card-1', 'card-2'], count: 2 }]

  test('the flush writes every card, hidden ones marked, the groups and the board settings; again changes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-board-flush-'))
    try {
      persistRun(dir, normaliseRun({ id: 'run-board', talkSlug: 'talk-test', startedAt: new Date(START).toISOString() }))
      const row: any = { ...record(), vaultRoot: dir, runId: 'run-board', startedAtMs: START, polls: [boardPoll(liveCards, true, groups)] }
      expect(flushLiveSessionHistory(row)).toBe(true)
      const first = readFileSync(join(dir, '_PRESENTATIONS', 'talk-test', 'run-board.json'), 'utf8')
      expect(flushLiveSessionHistory(row)).toBe(true)
      expect(readFileSync(join(dir, '_PRESENTATIONS', 'talk-test', 'run-board.json'), 'utf8')).toBe(first)
      const run = readRun(dir, 'talk-test', 'run-board')!
      expect(run.boards).toHaveLength(1)
      expect(run.boards![0]).toMatchObject({ id: 'poll-board', slideId: 'slide-44', sessionId: 'session-test',
        groups: [{ n: 1, column: 'keep', cardIds: ['card-1', 'card-2'] }] })
      expect(run.boards![0].cards.map((c) => [c.id, c.hidden === true, c.group ?? null])).toEqual([
        ['card-1', false, 1], ['card-2', false, 1], ['card-3', false, null], ['card-4', true, null]])
      expect('liveEndedAt' in run.boards![0]).toBe(false)
      expect(run.polls[0]).toMatchObject({ id: 'poll-board', type: 'board', slideId: 'slide-44', board: { closesAfterDays: 7 } })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('End live keeping the board open, a late card, Refresh, then Close it now: every step lands on the Run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-board-late-'))
    try {
      persistRun(dir, normaliseRun({ id: 'run-board', talkSlug: 'talk-test', startedAt: new Date(START).toISOString() }))
      const closesAt = END + 7 * 86_400_000
      // A worker that holds the board: open for late cards after the end until it is closed.
      const worker = { cards: [...liveCards], late: {} as Record<string, number>, closed: 0, kept: undefined as boolean | undefined }
      let clock = END
      const recoverFinal = async (row: any) => ({ polls: [boardPoll(worker.cards, Object.keys(worker.late).length > 0, groups)], voteRecords: row.voteRecords,
        cursor: row.cursor, reactionRecords: [], questions: [], lateBoards: { ...worker.late }, endedAt: END })
      const h = harness([], async (row: any) => { worker.kept = row.keepBoardsOpen; if (row.keepBoardsOpen) worker.late = { 'poll-board': closesAt }; return 'ended' }, {
        recoverFinal, flushHistory: flushLiveSessionHistory, now: () => clock,
        closeBoards: async () => { worker.closed += 1; worker.late = {} },
      })
      h.manager.create({ ...record(), vaultRoot: dir, startedAtMs: START, expiresAt: END + 3_600_000 } as any, 10)
      h.manager.bindRun(10, { talkSlug: 'talk-test', runId: 'run-board' })
      h.clients[0].options.onPollState(boardPoll(liveCards, true, groups))
      expect(h.manager.openBoards(10)).toEqual([{ pollId: 'poll-board', question: 'What should we keep, change, try?', cards: 3 }])

      await h.manager.end(10, { keepBoardsOpen: true })
      expect(worker.kept).toBe(true)
      expect(h.saved()[0]).toMatchObject({ keepBoardsOpen: true, boardsLeftOpen: { 'poll-board': closesAt }, endedAtMs: END })
      let board = readRun(dir, 'talk-test', 'run-board')!.boards![0]
      expect(board).toMatchObject({ liveEndedAt: END, openUntil: closesAt })
      expect('closedAt' in board).toBe(false)

      // The next morning a phone adds a late card; History refreshes it in.
      clock = END + 18 * 3_600_000
      worker.cards = [...worker.cards, card(5, 'keep', 'Recording of the demo, please', END + 17 * 3_600_000)]
      expect(await h.manager.refreshBoards('talk-test', 'run-board')).toEqual({ refreshed: 1 })
      board = readRun(dir, 'talk-test', 'run-board')!.boards![0]
      expect(board.cards.map((c) => c.id)).toEqual(['card-1', 'card-2', 'card-3', 'card-4', 'card-5'])
      expect(board.cards.filter((c) => c.acceptedAt > board.liveEndedAt!).map((c) => c.id)).toEqual(['card-5'])
      expect(board.refreshedAt).toBe(clock)
      expect('closedAt' in board).toBe(false)

      // Close it now: the worker closes the board, the last pull records when.
      clock += 60_000
      expect(await h.manager.closeBoards('talk-test', 'run-board')).toEqual({ refreshed: 1 })
      expect(worker.closed).toBe(1)
      board = readRun(dir, 'talk-test', 'run-board')!.boards![0]
      expect(board.closedAt).toBe(clock)
      expect(board.openUntil).toBe(closesAt)
      // The encrypted recovery record never holds more than it did: no question text, and the token stays there only.
      expect(JSON.stringify(readRun(dir, 'talk-test', 'run-board'))).not.toContain('test-token')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('closing the board at End live leaves nothing open; a refresh is refused plainly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-board-close-'))
    try {
      persistRun(dir, normaliseRun({ id: 'run-board', talkSlug: 'talk-test', startedAt: new Date(START).toISOString() }))
      const h = harness([], async () => 'ended', {
        recoverFinal: async (row: any) => ({ polls: [boardPoll(liveCards, false, groups)], voteRecords: [], cursor: 0, reactionRecords: [], questions: [], lateBoards: {} }),
        flushHistory: flushLiveSessionHistory, now: () => END,
      })
      h.manager.create({ ...record(), vaultRoot: dir, startedAtMs: START } as any, 10)
      h.manager.bindRun(10, { talkSlug: 'talk-test', runId: 'run-board' })
      await h.manager.end(10, { keepBoardsOpen: false })
      expect('keepBoardsOpen' in h.saved()[0]).toBe(false)
      const board = readRun(dir, 'talk-test', 'run-board')!.boards![0]
      expect(board.liveEndedAt).toBe(END)
      expect('openUntil' in board).toBe(false)
      expect(await h.manager.refreshBoards('talk-test', 'run-board')).toMatchObject({ refreshed: 0, error: expect.stringContaining('not left open') })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('a board that closed by itself is recorded closed at the next refresh; a worker that forgot the session closes it too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-board-selfclose-'))
    try {
      persistRun(dir, normaliseRun({ id: 'run-board', talkSlug: 'talk-test', startedAt: new Date(START).toISOString() }))
      let late: Record<string, number> = { 'poll-board': END + 86_400_000 }
      let gone = false
      let clock = END
      const h = harness([], async () => 'ended', {
        recoverFinal: async () => {
          if (gone) throw new LiveHistoryGoneError(404)
          return { polls: [boardPoll(liveCards, Object.keys(late).length > 0, groups)], voteRecords: [], cursor: 0, reactionRecords: [], questions: [], lateBoards: late, endedAt: END }
        },
        flushHistory: flushLiveSessionHistory, now: () => clock,
      })
      h.manager.create({ ...record(), vaultRoot: dir, startedAtMs: START } as any, 10)
      h.manager.bindRun(10, { talkSlug: 'talk-test', runId: 'run-board' })
      await h.manager.end(10, { keepBoardsOpen: true })
      clock = END + 2 * 86_400_000
      late = {}
      await h.manager.refreshBoards('talk-test', 'run-board')
      expect(readRun(dir, 'talk-test', 'run-board')!.boards![0].closedAt).toBe(clock)
      // Another Run's board whose worker forgot the session (404) is closed as well, not retried forever.
      const second = mkdtempSync(join(tmpdir(), 'tw-board-gone-'))
      try {
        persistRun(second, normaliseRun({ id: 'run-board', talkSlug: 'talk-test', startedAt: new Date(START).toISOString() }))
        late = { 'poll-board': END + 86_400_000 }
        gone = false
        const g = harness([], async () => 'ended', { recoverFinal: async () => {
          if (gone) throw new LiveHistoryGoneError(404)
          return { polls: [boardPoll(liveCards, true, groups)], voteRecords: [], cursor: 0, reactionRecords: [], questions: [], lateBoards: late, endedAt: END }
        }, flushHistory: flushLiveSessionHistory, now: () => clock })
        g.manager.create({ ...record(), sessionId: 'session-2', vaultRoot: second, startedAtMs: START } as any, 11)
        g.manager.bindRun(11, { talkSlug: 'talk-test', runId: 'run-board' })
        await g.manager.end(11, { keepBoardsOpen: true })
        gone = true
        expect(await g.manager.refreshBoards('talk-test', 'run-board')).toEqual({ refreshed: 1 })
        expect(readRun(second, 'talk-test', 'run-board')!.boards![0].closedAt).toBe(clock)
      } finally { rmSync(second, { recursive: true, force: true }) }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('two live sessions of one Run show the same board: both are kept, and each refresh replaces only its own', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-board-two-sessions-'))
    try {
      persistRun(dir, normaliseRun({ id: 'run-board', talkSlug: 'talk-test', startedAt: new Date(START).toISOString() }))
      const cardsBy: Record<string, any[]> = { 'session-1': [...liveCards], 'session-2': [] }
      const late: Record<string, Record<string, number>> = { 'session-1': {}, 'session-2': {} }
      let clock = END
      const recoverFinal = async (row: any) => ({ polls: [boardPoll(cardsBy[row.sessionId], Object.keys(late[row.sessionId]).length > 0, row.sessionId === 'session-1' ? groups : [])],
        voteRecords: [], cursor: 0, reactionRecords: [], questions: [], lateBoards: { ...late[row.sessionId] }, endedAt: clock })
      const h = harness([], async (row: any) => { if (row.keepBoardsOpen) late[row.sessionId] = { 'poll-board': clock + 7 * 86_400_000 }; return 'ended' },
        { recoverFinal, flushHistory: flushLiveSessionHistory, now: () => clock })
      h.manager.create({ ...record(), sessionId: 'session-1', vaultRoot: dir, startedAtMs: START } as any, 10)
      h.manager.bindRun(10, { talkSlug: 'talk-test', runId: 'run-board' })
      h.clients[0].options.onPollState(boardPoll(liveCards, true, groups))
      await h.manager.end(10, { keepBoardsOpen: true })
      // Go live again in the same recording: the same authored board opens empty.
      clock += 600_000
      h.manager.create({ ...record(), sessionId: 'session-2', vaultRoot: dir, startedAtMs: clock } as any, 11)
      h.manager.bindRun(11, { talkSlug: 'talk-test', runId: 'run-board' })
      h.clients.at(-1).options.onPollState(boardPoll([], true))
      let boards = readRun(dir, 'talk-test', 'run-board')!.boards!
      expect(boards.map((b) => [b.sessionId, b.cards.length])).toEqual([['session-1', 4], ['session-2', 0]])
      expect(boards[1].liveStartedAt).toBe(clock)
      cardsBy['session-2'] = [card(1, 'keep', 'Second session card', clock + 1000)]
      await h.manager.end(11, { keepBoardsOpen: true })
      cardsBy['session-1'] = [...liveCards, card(5, 'try', 'A late card', clock + 2000)]
      expect((await h.manager.refreshBoards('talk-test', 'run-board')).refreshed).toBe(2)
      boards = readRun(dir, 'talk-test', 'run-board')!.boards!
      expect(boards.map((b) => [b.sessionId, b.cards.map((c) => c.text)])).toEqual([
        ['session-1', ['More time for hands-on', 'Hands-on please', 'Pair work', 'This is a waste of a morning', 'A late card']],
        ['session-2', ['Second session card']]])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('a new live session that took the join link closed the earlier board left open: the Run says why, at once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-board-superseded-'))
    try {
      persistRun(dir, normaliseRun({ id: 'run-board', talkSlug: 'talk-test', startedAt: new Date(START).toISOString() }))
      let late: Record<string, number> = {}
      let closedBoards: any
      const clock = END + 3_600_000
      const recoverFinal = async (row: any) => row.sessionId === 'session-1'
        ? { polls: [boardPoll(liveCards, Object.keys(late).length > 0, groups)], voteRecords: [], cursor: 0, reactionRecords: [], questions: [], lateBoards: { ...late }, endedAt: END,
          ...(closedBoards ? { closedBoards } : {}) }
        : { polls: [], voteRecords: [], cursor: 0, reactionRecords: [], questions: [] }
      const h = harness([], async (row: any) => { if (row.keepBoardsOpen) late = { 'poll-board': END + 86_400_000 }; return 'ended' },
        { recoverFinal, flushHistory: flushLiveSessionHistory, now: () => clock })
      h.manager.create({ ...record(), sessionId: 'session-1', vaultRoot: dir, startedAtMs: START } as any, 10)
      h.manager.bindRun(10, { talkSlug: 'talk-test', runId: 'run-board' })
      await h.manager.end(10, { keepBoardsOpen: true })
      // The worker closed it when the new session registered for the talk.
      late = {}
      closedBoards = { 'poll-board': { at: END + 3_000_000, reason: 'superseded' } }
      h.manager.create({ ...record(), sessionId: 'session-2', vaultRoot: dir, startedAtMs: clock } as any, 11)
      await new Promise((resolve) => setTimeout(resolve, 0))
      const board = readRun(dir, 'talk-test', 'run-board')!.boards!.find((b) => b.sessionId === 'session-1')!
      expect(board).toMatchObject({ closedAt: END + 3_000_000, closedBy: 'superseded' })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('final recovery passes on the boards left open and the end time; malformed entries are dropped', async () => {
    const fetchPage = (page: any) => (async () => ({ ok: true, json: async () => page })) as any
    const final = await recoverFinalLiveHistory(record() as any, 0, fetchPage({ polls: [], voteRecords: [], moreRecords: false,
      lateBoards: { 'poll-board': 123, bad: 'x' }, endedAt: 99 }))
    expect(final.lateBoards).toEqual({ 'poll-board': 123 })
    expect(final.endedAt).toBe(99)
    const older = await recoverFinalLiveHistory(record() as any, 0, fetchPage({ polls: [], voteRecords: [], moreRecords: false }))
    expect('lateBoards' in older).toBe(false)
  })
})
