#!/usr/bin/env node
// Feedback rail (ticket 05) at its seams: the feedback mirror (append, status update, replay,
// dedupe by itemId), the owner socket client and the feedback service against a fake worker that
// keeps the real contract (worker/README.md: owner socket with the bearer header, item.new,
// ?since= replay by share-wide seq, PATCH /shares/<id>/items/<itemId>), and the rail's view model.
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFeedbackMirror, feedbackFilePath } from '../src/main/feedback-mirror.ts'
import { createOwnerSocket, ownerSocketUrl } from '../src/main/shared-talk-owner-socket.ts'
import { createSharedTalkFeedback } from '../src/main/shared-talk-feedback.ts'
import {
  BASE_NOT_KEPT, CHANGED_SINCE, PAUSED_NOTE, changedLines, feedbackRailView, foldFeedback, parseWorkerItem, railWhen, slideBlockRange, stampWhen, twoLineDiff,
} from '../src/shared/feedback.ts'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const SHARE = 'k7m2abcd'
const TOKEN = 'owner-token-k7m2abcd-0123456789'
const root = mkdtempSync(join(tmpdir(), 'tw-feedback-'))
function talk(name) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  const outlinePath = join(dir, `${name}-outline.md`)
  writeFileSync(outlinePath, '---\ntitle: T\n---\n')
  return outlinePath
}
let seq = 0
const item = (over = {}) => {
  seq += 1
  return { itemId: `item-${seq}`, kind: 'note', slideId: 'rubric', text: `note ${seq}`, createdAt: 1_790_000_000_000 + seq * 60_000, seq, status: 'new', statusSeq: seq, ...over }
}

// ── 1. The mirror: append, dedupe by itemId, status lines override, torn lines, no resurrection ──
{
  const outlinePath = talk('mirror')
  const path = feedbackFilePath(outlinePath, SHARE)
  assert.equal(path, join(root, 'mirror', 'feedback', `${SHARE}.jsonl`))
  assert.throws(() => feedbackFilePath(outlinePath, '../../etc'), /Not a share id/)
  const mirror = createFeedbackMirror({ now: () => 1000 })
  assert.deepEqual(mirror.read(path), { items: [], cursor: 0, unsynced: [], replayFrom: 0 }, 'no file: empty')
  const a = item(); const b = item({ kind: 'replace', baseRevision: 1, text: 'new text' })
  // Concurrent writes run one at a time on one chain; a repeat is dropped.
  const [first, second] = await Promise.all([mirror.addItems(path, [a, b]), mirror.addItems(path, [b, a])])
  assert.deepEqual(first.map((i) => i.itemId), [a.itemId, b.itemId])
  assert.deepEqual(second, [], 'a replay of known items writes nothing')
  assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 2, 'one line per item')
  assert.equal(await mirror.setStatus(path, a.itemId, 'done'), true)
  assert.equal(await mirror.setStatus(path, 'missing', 'done'), false, 'a status for an unknown item is refused')
  let fold = mirror.read(path)
  assert.equal(fold.cursor, b.seq)
  assert.deepEqual(fold.items.map((i) => [i.itemId, i.status]), [[a.itemId, 'done'], [b.itemId, 'new']])
  assert.equal(fold.items[0].statusAt, 1000)
  assert.deepEqual(fold.unsynced, [{ itemId: a.itemId, status: 'done' }], 'his Done is owed to the Worker')
  await mirror.markSynced(path, a.itemId, 'done')
  assert.deepEqual(mirror.read(path).unsynced, [], 'the synced line settles it')
  await mirror.setStatus(path, a.itemId, 'dismissed')
  assert.equal(mirror.read(path).items[0].status, 'dismissed', 'a later status line overrides')
  // Append-only: every earlier line is still there, untouched.
  const lines = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l).type)
  assert.deepEqual(lines, ['item', 'item', 'status', 'synced', 'status'])
  // A torn last line (crash mid-append) is skipped, and the next append starts on a fresh line.
  appendFileSync(path, '{"v":1,"type":"item","item":{"itemId":"torn"')
  assert.equal(mirror.read(path).items.length, 2)
  const c = item()
  await mirror.addItems(path, [c])
  fold = mirror.read(path)
  assert.deepEqual(fold.items.map((i) => i.itemId), [a.itemId, b.itemId, c.itemId])
  // One fold per file: appends update the in-memory index; only a change made by someone else
  // makes the mirror read the file again.
  const loadsBefore = mirror.loads()
  for (let i = 0; i < 20; i += 1) { await mirror.addItems(path, [item()]); mirror.read(path) }
  assert.equal(mirror.loads(), loadsBefore, 'twenty appends and reads: no re-read of the file')
  const external = item()
  appendFileSync(path, JSON.stringify({ v: 1, type: 'item', item: external, receivedAt: 1 }) + '\n')
  assert.equal(mirror.read(path).items.at(-1).itemId, external.itemId, 'an external append is seen')
  assert.equal(mirror.loads(), loadsBefore + 1, 'by one re-read')
  // Items that fail the contract never reach the file.
  assert.equal(parseWorkerItem({ ...item(), kind: 'poll' }), null)
  assert.equal(parseWorkerItem({ ...item(), itemId: 'x'.repeat(201) }), null)
  assert.equal(parseWorkerItem({ ...item({ kind: 'insert' }), afterSlideId: undefined }), null, 'an insert names where it goes')
  // The talk folder is never created: a moved talk does not come back at its old path.
  const gone = join(root, 'gone', 'gone-outline.md')
  await assert.rejects(mirror.addItems(feedbackFilePath(gone, SHARE), [item()]), /talk folder is not there/)
  assert.equal(existsSync(join(root, 'gone')), false)
  console.log('PASS mirror: append-only, dedupe by itemId, status lines override, torn line skipped, no resurrection, one fold per file')
}

// ── 1b. The replay position is the file's: a torn item line mid-file pulls it back (bounded) ─────
{
  const outlinePath = talk('torn')
  const path = feedbackFilePath(outlinePath, SHARE)
  mkdirSync(join(root, 'torn', 'feedback'), { recursive: true })
  const line = (seqNo) => JSON.stringify({ v: 1, type: 'item', item: { ...item(), seq: seqNo }, receivedAt: 1 })
  writeFileSync(path, [line(3), line(7), '{"v":1,"type":"item","item":{"itemId":"lost","kind":"no', line(12), line(15), ''].join('\n'))
  let fold = createFeedbackMirror().read(path)
  assert.equal(fold.cursor, 15)
  assert.equal(fold.replayFrom, 7, 'a torn item line after seq 7: replay from 7, so the lost item comes again')
  writeFileSync(path, [line(3), line(7), ''].join('\n'))
  assert.equal(createFeedbackMirror().read(path).replayFrom, 7, 'no torn line: the highest seq written')
  // Bounded: a torn line more than 200 items back replays only the last 200.
  const many = [line(1), '{"v":1,"type":"item","item":{"itemId":"old-lost"']
  for (let n = 0; n < 250; n += 1) many.push(line(10 + n))
  writeFileSync(path, many.join('\n') + '\n')
  fold = createFeedbackMirror().read(path)
  assert.equal(fold.replayFrom, 10 + 250 - 201, 'at most the last 200 items are asked for again')
  console.log('PASS replay position: the file\'s highest seq; a torn item line pulls it back to the seq before, bounded to the last 200')
}

// ── A fake worker: owner sockets that honour ?since= and the bearer header, and PATCH ────────────
function fakeWorker() {
  const items = []
  const sockets = new Set()
  const patches = []
  const knobs = { refuse: false, offline: false, ended: false, tokenRefused: false }
  let wseq = 0
  function createSocket(url, headers) {
    const parsed = new URL(url)
    const socket = {
      url, headers, onopen: null, onclose: null, onerror: null, onmessage: null, closed: false,
      close() { if (this.closed) return; this.closed = true; sockets.delete(this) },
      drop() { this.closed = true; sockets.delete(this); this.onclose?.({ code: 1006 }) },
      send(message) { this.onmessage?.({ data: JSON.stringify(message) }) },
    }
    queueMicrotask(() => {
      if (knobs.refuse || knobs.ended || knobs.tokenRefused || headers.authorization !== `Bearer ${TOKEN}` || parsed.searchParams.has('token')) { socket.closed = true; socket.onerror?.(); return }
      sockets.add(socket)
      socket.onopen?.()
      const since = Number(parsed.searchParams.get('since') ?? 0)
      for (const it of items.filter((i) => i.seq > since)) socket.send({ type: 'item.new', item: it, seq: it.seq })
    })
    return socket
  }
  return {
    items, sockets, patches, knobs, createSocket,
    post(over = {}) {
      wseq += 1
      const it = { ...item(over), seq: wseq, statusSeq: wseq }
      items.push(it)
      for (const s of sockets) s.send({ type: 'item.new', item: it, seq: it.seq })
      return it
    },
    dropAll() { for (const s of [...sockets]) s.drop() },
    async fetch(url, init) {
      if (knobs.offline) throw new TypeError('fetch failed')
      const m = new URL(url).pathname.match(/^\/shares\/([^/]+)\/items\/([^/]+)$/)
      patches.push({ url, method: init.method, auth: init.headers.authorization, body: JSON.parse(init.body) })
      if (!m || init.method !== 'PATCH' || init.headers.authorization !== `Bearer ${TOKEN}` || knobs.tokenRefused) return new Response('{}', { status: 401 })
      if (knobs.ended) return new Response('{}', { status: 410 })
      const target = items.find((i) => i.itemId === decodeURIComponent(m[2]))
      if (!target) return new Response('{}', { status: 404 })
      wseq += 1
      target.status = JSON.parse(init.body).status
      target.statusSeq = wseq
      return new Response(JSON.stringify({ item: target }), { status: 200 })
    },
  }
}

// ── 2. The owner socket client: header auth, since, backoff, paused, share.closed ───────────────
{
  assert.equal(ownerSocketUrl('https://w.test', SHARE, 0), `wss://w.test/shares/${SHARE}/owner`)
  assert.equal(ownerSocketUrl('http://127.0.0.1:8787', SHARE, 12), `ws://127.0.0.1:8787/shares/${SHARE}/owner?since=12`)
  const worker = fakeWorker()
  worker.post(); worker.post()
  const got = []
  const states = []
  let onDisk = 1 // the file's replay position, as the service would report it
  const client = createOwnerSocket({
    baseUrl: 'http://w.test', shareId: SHARE, ownerToken: TOKEN, since: () => onDisk,
    createSocket: worker.createSocket, reconnectDelayMs: 5, maxDelayMs: 20, random: () => 0.5,
    onItem: (it, s) => { got.push(s); onDisk = Math.max(onDisk, s) }, onConnection: (c) => states.push(c),
  })
  await wait(10)
  assert.deepEqual(got, [2], 'replay starts after since')
  const [socket] = worker.sockets
  assert.equal(socket.headers.authorization, `Bearer ${TOKEN}`, 'the owner token travels as a bearer header')
  assert.equal(socket.url.includes('token='), false, 'never in the URL')
  worker.post()
  assert.deepEqual(got, [2, 3])
  worker.knobs.refuse = true
  worker.dropAll()
  assert.equal(client.connection(), 'paused', 'a drop is paused at once')
  await wait(40)
  assert.equal(client.connection(), 'paused', 'refused reconnects stay paused')
  worker.post() // arrives while down; buffered on the worker
  worker.knobs.refuse = false
  await wait(60)
  assert.equal(client.connection(), 'connected')
  assert.match([...worker.sockets][0].url, /since=3$/, 'reconnect asks since() — the file — not a copy of its own')
  assert.deepEqual(got, [2, 3, 4], 'the missed item replays, nothing twice')
  assert.deepEqual(states.filter((s, i) => s !== states[i - 1]).slice(0, 3), ['connected', 'paused', 'connected'])
  // restart(): a write failed; the next connect asks since() again, from the file.
  onDisk = 2
  client.restart()
  await wait(40)
  assert.match([...worker.sockets][0].url, /since=2$/)
  assert.deepEqual(got.slice(-2), [3, 4], 'items after the file\'s position come again')
  const ended = []
  ;[...worker.sockets][0].send({ type: 'share.closed', reason: 'stopped' })
  assert.equal(client.connection(), 'ended')
  await wait(30)
  assert.equal(worker.sockets.size, 0, 'no reconnect after share.closed')
  client.stop()

  // A socket that fails and whose probe says the share is gone (410) or the token refused (401)
  // ends: no more retries.
  for (const [knob, reason] of [['ended', 'stopped'], ['tokenRefused', 'refused']]) {
    const w = fakeWorker()
    w.knobs[knob] = true
    let attempts = 0
    const c = createOwnerSocket({
      baseUrl: 'http://w.test', shareId: SHARE, ownerToken: TOKEN, since: () => 0,
      createSocket: (u, h) => { attempts += 1; return w.createSocket(u, h) }, reconnectDelayMs: 5, maxDelayMs: 10, random: () => 0.5,
      probe: async () => { const r = await w.fetch(`http://w.test/shares/${SHARE}/items/tw-owner-probe`, { method: 'PATCH', headers: { authorization: `Bearer ${TOKEN}` }, body: '{"status":"new"}' }); return r.status === 410 ? 'stopped' : r.status === 401 ? 'refused' : null },
      onItem: () => {}, onConnection: () => {}, onEnded: (r) => ended.push(r),
    })
    await wait(60)
    assert.equal(c.connection(), 'ended', `${knob}: ended, not reconnecting`)
    const settled = attempts
    await wait(40)
    assert.equal(attempts, settled, `${knob}: no retries after the end`)
    c.stop()
  }
  assert.deepEqual(ended, ['stopped', 'refused'], '410 and 401 on the probe each end it once')
  console.log('PASS socket: bearer header, since() from the file at every connect, paused on drop, restart, share.closed / 410 / 401 end it')
}

// ── 3. The service: live items into the file, reconnect without duplicates, Done / Dismiss ───────
{
  const outlinePath = talk('service')
  const worker = fakeWorker()
  const shares = [{ key: 'id:svc', outlinePath, shareId: SHARE, ownerToken: TOKEN, workerBaseUrl: 'http://w.test', url: 'https://drafts.handouts.fyi/k7m2abcd' }]
  const changes = []
  const mirror = createFeedbackMirror()
  const make = () => createSharedTalkFeedback({
    shares: () => shares, mirror, fetch: (u, i) => worker.fetch(u, i), createSocket: worker.createSocket,
    revisionSlides: (_p, _id, rev) => rev === 1 ? [{ slideId: 'rubric', title: 'The rubric problem', text: '### The rubric problem\n- old line\n- kept' }]
      : rev === 2 ? { slides: [{ slideId: 'rubric', title: 'The rubric problem', text: 'v2' }], pushedAt: '2026-09-27T21:51:00.000Z' } : null,
    onChange: (key, summary) => changes.push({ shareId: key, summary }), reconnectDelayMs: 5, maxDelayMs: 20,
  })
  const early = worker.post({ name: 'Anna' }) // before the app starts: replayed on connect
  let service = make()
  service.sync()
  await wait(15); await service.idle()
  const note = worker.post()
  const edit = worker.post({ kind: 'replace', baseRevision: 1, text: '### The rubric problem\n- new line\n- kept' })
  await wait(5); await service.idle()
  let list = service.list(SHARE)
  assert.deepEqual(list.items.map((i) => i.itemId), [early.itemId, note.itemId, edit.itemId], 'live and replayed items are in the file')
  assert.equal(list.link, 'drafts.handouts.fyi/k7m2abcd')
  assert.equal(list.items[2].baseText, '### The rubric problem\n- old line\n- kept', 'the slide text at the base revision rides along')
  const file = feedbackFilePath(outlinePath, SHARE)
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 3)
  assert.deepEqual(service.summaries(), [{ key: 'id:svc', shareId: SHARE, unread: 3, total: 3, connection: 'connected' }])
  assert.equal(JSON.stringify(changes).includes(TOKEN), false, 'summaries carry no owner token')
  assert.equal(JSON.stringify(list).includes(TOKEN), false, 'lists carry no owner token')

  // Drop + items while down + reconnect: arrive once each.
  worker.knobs.refuse = true
  worker.dropAll()
  await wait(1)
  assert.equal(changes.at(-1).summary.connection, 'paused')
  const late = worker.post({ kind: 'delete', baseRevision: 1, reason: 'Says the same as slide 5' })
  worker.knobs.refuse = false
  await wait(60); await service.idle()
  assert.equal(changes.at(-1).summary.connection, 'connected')
  list = service.list(SHARE)
  assert.deepEqual(list.items.map((i) => i.itemId), [early.itemId, note.itemId, edit.itemId, late.itemId], 'no duplicates after reconnect')

  // Done: the file first, then the Worker; the synced line follows.
  list = await service.setStatus(SHARE, note.itemId, 'done')
  assert.equal(list.items.find((i) => i.itemId === note.itemId).status, 'done')
  assert.deepEqual(worker.patches.at(-1), { url: `http://w.test/shares/${SHARE}/items/${note.itemId}`, method: 'PATCH', auth: `Bearer ${TOKEN}`, body: { status: 'done' } })
  assert.equal(worker.items.find((i) => i.itemId === note.itemId).status, 'done', 'the worker has it')
  assert.deepEqual(mirror.read(file).unsynced, [])
  assert.equal(service.summaries()[0].unread, 3, 'counts update')

  // Offline Dismiss: greys at once, reaches the Worker on the next open.
  worker.knobs.offline = true
  list = await service.setStatus(SHARE, edit.itemId, 'dismissed')
  assert.equal(list.items.find((i) => i.itemId === edit.itemId).status, 'dismissed', 'dismissed locally while offline')
  assert.deepEqual(mirror.read(file).unsynced, [{ itemId: edit.itemId, status: 'dismissed' }])
  assert.equal(worker.items.find((i) => i.itemId === edit.itemId).status, 'new')
  worker.knobs.offline = false
  service.stopAll()

  // App restart: a fresh service replays from the file's cursor (nothing twice) and re-sends the
  // owed Dismiss when the socket opens.
  const beforeRestart = worker.patches.length
  service = make()
  service.sync()
  await wait(20); await service.idle()
  assert.match([...worker.sockets][0].url, new RegExp(`since=${late.seq}$`), 'a restart asks only for what the file lacks')
  assert.equal(service.list(SHARE).items.length, 4)
  assert.equal(worker.items.find((i) => i.itemId === edit.itemId).status, 'dismissed', 'the owed status reached the Worker')
  assert.ok(worker.patches.length > beforeRestart)
  assert.deepEqual(mirror.read(file).unsynced, [])
  assert.equal(service.summaries()[0].unread, 2)
  await assert.rejects(service.setStatus(SHARE, 'nope', 'done'), /not in this talk/)
  // Accept (ticket 06): the file keeps the splice for Undo; the Worker hears "accepted", then "new".
  const acceptEdit = { from: 3, removed: 'old', inserted: 'new', line: 2, before: 'ab\n', after: '\n' }
  list = await service.setStatus(SHARE, late.itemId, 'accepted', acceptEdit)
  assert.deepEqual(list.items.find((i) => i.itemId === late.itemId).acceptedEdit, acceptEdit)
  assert.deepEqual(worker.patches.at(-1).body, { status: 'accepted' }, 'the Worker gets the status, never the outline')
  assert.equal(worker.items.find((i) => i.itemId === late.itemId).status, 'accepted')
  list = await service.setStatus(SHARE, late.itemId, 'new')
  assert.equal(list.items.find((i) => i.itemId === late.itemId).acceptedEdit, null)
  assert.equal(worker.items.find((i) => i.itemId === late.itemId).status, 'new', 'Undo reverts it on the Worker')
  // The base revision's push time rides along ("written against your 22:51 save").
  assert.equal(service.list(SHARE).items.find((i) => i.itemId === edit.itemId).baseAt, null, 'a bare slide list has no time')
  const v2 = worker.post({ kind: 'replace', baseRevision: 2, text: 'hers' })
  await wait(20); await service.idle()
  const listedV2 = service.list(SHARE).items.find((i) => i.itemId === v2.itemId)
  assert.deepEqual([listedV2.baseText, listedV2.baseAt], ['v2', '2026-09-27T21:51:00.000Z'], 'a kept revision brings its text and push time')

  // An atomic save re-keys the talk's identity: same share, same socket, no reconnect.
  const socketBefore = [...worker.sockets][0]
  shares[0] = { ...shares[0], key: 'id:svc-after-save' }
  service.sync()
  await wait(10)
  assert.equal([...worker.sockets][0], socketBefore, 'a re-key keeps the socket')
  assert.equal(service.summaries()[0].key, 'id:svc-after-save')

  // A moved talk: the registry's new path restarts the socket there; stopping the share removes it.
  const movedDir = join(root, 'service-moved')
  renameSync(join(root, 'service'), movedDir)
  shares[0] = { ...shares[0], outlinePath: join(movedDir, 'service-outline.md') }
  service.sync()
  await wait(15); await service.idle()
  assert.equal(service.list(SHARE).items.length, 5, 'the rail reads the moved file')
  worker.post()
  await wait(5); await service.idle()
  assert.equal(foldFeedback(readFileSync(join(movedDir, 'feedback', `${SHARE}.jsonl`), 'utf8')).items.length, 6)
  assert.equal(existsSync(join(root, 'service')), false, 'the old talk folder is not recreated')
  shares.length = 0
  service.sync()
  assert.deepEqual(changes.at(-1), { shareId: SHARE, summary: null })
  assert.equal(service.list(SHARE), null)
  assert.equal(worker.sockets.size, 0)
  console.log('PASS service: live and replayed items mirrored once, paused and back, Done/Dismiss to file then worker, owed status re-sent after restart, moved talk followed')
}

// ── 3b. A failed write is asked for again; refused statuses are not re-sent; an ended share stops ─
{
  const outlinePath = talk('failing')
  const worker = fakeWorker()
  const ended = []
  const changes = []
  const real = createFeedbackMirror()
  let failItemId = null
  // The mirror as the service sees it, with one write that fails (a read-only file, a full disk).
  const mirror = {
    ...real,
    addItems: (path, items) => items.some((i) => i.itemId === failItemId)
      ? (failItemId = null, Promise.reject(new Error('EROFS: read-only file system')))
      : real.addItems(path, items),
  }
  const shares = [{ key: 'id:failing', outlinePath, shareId: SHARE, ownerToken: TOKEN, workerBaseUrl: 'http://w.test', url: 'http://w.test/shares/k7m2abcd' }]
  const service = createSharedTalkFeedback({
    shares: () => shares, mirror, fetch: (u, i) => worker.fetch(u, i), createSocket: worker.createSocket, revisionSlides: () => null,
    onChange: (id, summary) => changes.push(summary?.connection ?? null), onEnded: (id, reason) => ended.push([id, reason]),
    reconnectDelayMs: 5, maxDelayMs: 20,
  })
  service.sync()
  await wait(10)
  const a = worker.post()
  failItemId = 'item-next'
  const b = worker.post({ itemId: 'item-next' })
  const c = worker.post()
  await wait(80); await service.idle()
  const file = feedbackFilePath(outlinePath, SHARE)
  const ids = real.read(file).items.map((i) => i.itemId)
  assert.deepEqual(ids.slice().sort(), [a.itemId, b.itemId, c.itemId].sort(), 'the item whose write failed arrives after the reconnect')
  assert.equal(ids.length, 3, 'each once: the dedupe absorbs the replayed ones')
  assert.equal(real.read(file).replayFrom, c.seq)
  const reconnect = [...worker.sockets][0].url
  assert.match(reconnect, new RegExp(`since=${a.seq}$`), 'the reconnect asked from before the failed item')

  // 404 on a status: refused for good — a failed line, never re-sent on reconnect.
  worker.items.splice(worker.items.findIndex((i) => i.itemId === a.itemId), 1) // gone on the Worker
  await service.setStatus(SHARE, a.itemId, 'done')
  assert.deepEqual(real.read(file).unsynced, [], 'not owed any more')
  assert.equal(real.read(file).items.find((i) => i.itemId === a.itemId).syncFailed, 'done')
  assert.match(readFileSync(file, 'utf8'), /"type":"failed","itemId":"[^"]+","status":"done","code":404/)
  const statusPatches = () => worker.patches.filter((p) => !p.url.endsWith('tw-owner-probe')).length
  const sentBefore = statusPatches()
  worker.dropAll()
  await wait(40); await service.idle()
  assert.equal(worker.sockets.size, 1, 'reconnected')
  assert.equal(statusPatches(), sentBefore, 'nothing re-sent on reconnect')

  // The share is stopped elsewhere: the socket fails, the probe finds 410, feedback ends.
  worker.knobs.ended = true
  worker.dropAll()
  await wait(60); await service.idle()
  assert.deepEqual(ended, [[SHARE, 'stopped']], 'reported once, so the registry records it')
  assert.equal(service.summaries()[0].connection, 'ended')
  assert.equal(changes.at(-1), 'ended')
  const settled = worker.patches.length
  await service.setStatus(SHARE, c.itemId, 'dismissed')
  assert.equal(worker.patches.length, settled, 'an ended share sends no status; the file still records it')
  assert.equal(real.read(file).items.find((i) => i.itemId === c.itemId).status, 'dismissed')
  // The registry catching up (ended recorded) does not restart anything.
  shares[0] = { ...shares[0], ended: 'stopped' }
  service.sync()
  assert.equal(service.summaries()[0].connection, 'ended')
  service.stopAll()
  console.log('PASS service: a failed write is fetched again from the file\'s position; 404/410 statuses not re-sent; 410 on the probe ends the share')
}

// ── 4. The rail's view model (frames 1 and 3) ────────────────────────────────────────────────────
{
  const now = new Date(2026, 8, 28, 8, 20).getTime() // Mon 28 Sep 08:20
  const sun = (h, m) => new Date(2026, 8, 27, h, m).getTime()
  const outline = [
    '---', 'title: AI and assessment workshop', '---', '', // 1-4
    '## Why assessment breaks', '', // 5-6
    '### Why assessment breaks first', '- Assessment was built on text being scarce', '', // 7-9
    '### Three failure modes', '- Substitution', '- Scaffolding drift: help quietly becomes authorship', '', // 10-13
    '### The rubric problem', '- Rubrics reward the features a model produces most fluently', '- Critical engagement', '- Markers read structure first', '- Every criterion', '', // 14-19
    '### What we tried in Trinity term', '- Oral follow-ups', '- Drafts with prompt history', '- Marking time rose', '', // 20-24
    '### Redesign, not detection', '- Detectors guess', '', // 25-27
  ].join('\n')
  const slides = [
    { slideId: 'why', title: 'Why assessment breaks first', line: 7 },
    { slideId: 'modes', title: 'Three failure modes', line: 10 },
    { slideId: 'rubric', title: 'The rubric problem', line: 14 },
    { slideId: 'tried', title: 'What we tried in Trinity term', line: 20 },
    { slideId: 'redesign', title: 'Redesign, not detection', line: 25 },
  ]
  const base = { statusAt: null, syncedStatus: 'new', baseText: null, baseTitle: null, status: 'new' }
  const rubricBase = '### The rubric problem\n- Rubrics reward the features a model produces most fluently\n- Critical engagement\n- Markers read structure first\n- Every criterion'
  const items = [
    { ...base, itemId: 'n1', kind: 'note', slideId: 'rubric', text: 'Too dense for a room of markers.', createdAt: sun(23, 28), seq: 1 },
    { ...base, itemId: 'n2', kind: 'note', slideId: 'redesign', text: 'Say who does the redesigning.', createdAt: sun(23, 35), seq: 2 },
    { ...base, itemId: 'e1', kind: 'replace', slideId: 'rubric', baseRevision: 3, baseText: rubricBase, createdAt: sun(23, 41), seq: 3,
      text: '### The rubric problem\n- Rubrics reward what a model writes most fluently\n- Markers read structure first, and structure is cheapest\n- Tightening criteria made the pattern easier to match' },
    { ...base, itemId: 'd1', kind: 'delete', slideId: 'tried', baseRevision: 3, reason: 'Slide 5 says the same with the outcome attached.', createdAt: sun(23, 44), seq: 4 },
    { ...base, itemId: 'i1', kind: 'insert', afterSlideId: 'rubric', section: 'What students told us', baseRevision: 3, name: 'Anna', createdAt: sun(23, 47), seq: 5,
      text: '### Students asked for the rules in writing\n- Most used a chatbot to start a draft\n- A one-page course policy settled **most questions**' },
    { ...base, itemId: 'h1', kind: 'replace', slideId: 'modes', baseRevision: 2, status: 'accepted', statusAt: new Date(2026, 8, 28, 8, 14).getTime(), createdAt: sun(22, 57), seq: 0,
      baseText: '- Scaffolding drift: help becomes authorship', text: '- Scaffolding drift: help quietly becomes authorship' },
  ]
  const list = { key: 'k', shareId: SHARE, link: 'drafts.handouts.fyi/k7m2', connection: 'connected', items }
  let view = feedbackRailView({ list, slides, outline, filter: 'all', activeSlideId: 'rubric', now })
  assert.equal(view.countLabel, '5 new')
  assert.equal(view.sub, 'Newest first · from drafts.handouts.fyi/k7m2')
  assert.deepEqual(view.scope.map((s) => [s.label, s.on]), [['All slides', true], ['Slide 3', false], ['New only', false]])
  assert.deepEqual(view.rows.map((r) => r.itemId), ['i1', 'd1', 'e1', 'n2', 'n1', 'h1'], 'newest first')
  assert.deepEqual(view.rows.map((r) => r.kindLabel), ['Proposed new slide', 'Proposed deletion', 'Proposed edit', 'Note', 'Note', 'Proposed edit'])
  const [ins, del, edit, note2] = view.rows
  assert.equal(ins.who, 'Anna'); assert.equal(note2.who, 'Colleague')
  assert.equal(ins.when, 'Sun 23:47')
  assert.deepEqual(ins.insertRef, { after: '3', section: 'What students told us' })
  assert.deepEqual(ins.preview, { kicker: '04 · What students told us', title: 'Students asked for the rules in writing', bullets: ['Most used a chatbot to start a draft', 'A one-page course policy settled most questions'], paras: [] })
  assert.equal(ins.hint, 'Accept adds the section and this slide after line 18, as slide 4; the slides after it renumber.')
  assert.deepEqual(del.slideRef, { number: '4', title: 'What we tried in Trinity term' })
  assert.equal(del.reason, 'Slide 5 says the same with the outcome attached.')
  assert.equal(del.hint, 'Accept deletes this slide\'s block, lines 20–23 of the outline.')
  assert.deepEqual(edit.slideRef, { number: '3', title: 'The rubric problem' })
  assert.deepEqual(edit.diff.lines, [
    { op: 'del', text: 'Rubrics reward the features a model produces most fluently' },
    { op: 'add', text: 'Rubrics reward what a model writes most fluently' },
  ], 'a two-line diff: first removed, first added, the bullet marker left to − and +')
  assert.equal(edit.diff.more, 5, "four lines out, three in: two shown, five more")
  assert.equal(note2.text, 'Say who does the redesigning.')
  assert.deepEqual(note2.actions.map((a) => [a.label, a.disabled]), [['Done', false], ['Dismiss', false]])
  for (const row of [ins, edit]) {
    assert.deepEqual(row.actions.map((a) => [a.label, a.disabled, a.title]), [['Accept', false, undefined], ['Dismiss', false, undefined]], 'Accept live')
    assert.equal(row.flag, null)
  }
  // No base text kept for the deletion: a change since cannot be ruled out, so it leads with Compare.
  assert.equal(del.flag, BASE_NOT_KEPT)
  assert.deepEqual(del.actions.map((a) => a.label), ['Compare', 'Accept', 'Dismiss'])
  assert.equal(del.compare.base, null)
  const handled = view.rows[5]
  assert.equal(handled.handled, true); assert.equal(handled.isNew, false)
  assert.deepEqual(handled.stamp, { text: 'Accepted 08:14 today', tone: 'accepted' })
  assert.deepEqual(handled.actions, [])

  // Done / Dismiss grey with a time; counts drop.
  const doneAt = new Date(2026, 8, 28, 8, 19).getTime()
  const after = { ...list, items: items.map((i) => i.itemId === 'n1' ? { ...i, status: 'done', statusAt: doneAt } : i.itemId === 'd1' ? { ...i, status: 'dismissed', statusAt: doneAt } : i) }
  view = feedbackRailView({ list: after, slides, outline, filter: 'all', activeSlideId: 'rubric', now })
  assert.equal(view.countLabel, '3 new')
  const byId = Object.fromEntries(view.rows.map((r) => [r.itemId, r]))
  assert.deepEqual(byId.n1.stamp, { text: 'Done 08:19 today', tone: 'done' })
  assert.deepEqual(byId.d1.stamp, { text: 'Dismissed 08:19 today', tone: 'dismissed' })
  assert.equal(byId.d1.hint, null, 'a handled item offers no Accept hint')

  // Filters: this slide (inserts are not "on" a slide), new only.
  view = feedbackRailView({ list: after, slides, outline, filter: 'slide', activeSlideId: 'rubric', now })
  assert.deepEqual(view.rows.map((r) => r.itemId), ['e1', 'n1'])
  view = feedbackRailView({ list: after, slides, outline, filter: 'new', activeSlideId: 'rubric', now })
  assert.deepEqual(view.rows.map((r) => r.itemId), ['i1', 'e1', 'n2'])
  view = feedbackRailView({ list: after, slides, outline, filter: 'slide', activeSlideId: null, now })
  assert.equal(view.scope[0].on, true, 'no current slide: falls back to all'); assert.equal(view.scope[1].disabled, true)
  view = feedbackRailView({ list: { ...list, items: [] }, slides, outline, filter: 'all', activeSlideId: null, now })
  assert.match(view.empty, /Nothing yet/)

  // Frame 3: paused.
  view = feedbackRailView({ list: { ...list, connection: 'paused' }, slides, outline, filter: 'all', activeSlideId: null, now })
  assert.equal(view.paused, true); assert.equal(view.sub, ''); assert.equal(view.pausedNote, PAUSED_NOTE)
  view = feedbackRailView({ list: { ...list, connection: 'ended' }, slides, outline, filter: 'all', activeSlideId: null, now })
  assert.equal(view.ended, true); assert.equal(view.paused, false); assert.match(view.endedNote, /no longer takes comments/)

  // A slide gone from the talk keeps its title from the base revision.
  view = feedbackRailView({ list: { ...list, items: [{ ...items[0], slideId: 'gone', baseTitle: 'Old title' }] }, slides, outline, filter: 'all', activeSlideId: null, now })
  assert.deepEqual(view.rows[0].slideRef, { number: '—', title: 'Old title' })
  // Pieces.
  assert.equal(railWhen(new Date(2026, 8, 28, 7, 5).getTime(), now), '07:05')
  assert.equal(railWhen(new Date(2026, 8, 12, 7, 5).getTime(), now), '12 Sep 07:05')
  assert.equal(stampWhen(sun(23, 1), now), 'Sun 23:01')
  assert.deepEqual(slideBlockRange('### A\n- a\n\n```\n# not a heading\n```\n\n### B', 1), { start: 1, end: 6 })
  assert.deepEqual(changedLines('a\nb\n', 'a\nb'), [], 'trailing whitespace and newlines are not changes')
  assert.deepEqual(twoLineDiff('', '- only added\n- two\n- three'), { lines: [{ op: 'add', text: 'only added' }, { op: 'add', text: 'two' }], more: 1 })
  console.log('PASS view model: four kinds as drawn, newest first, counts, filters, Done/Dismiss stamps, Accept live, paused header')
}

rmSync(root, { recursive: true, force: true })
