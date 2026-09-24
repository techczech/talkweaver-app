import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLiveSessionManager } from '../src/main/live-session-manager'
import { flushLiveSessionHistory } from '../src/main/live-session-history'
import { normaliseRun, persistRun, readRun } from '../src/main/runs'
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
