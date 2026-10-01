#!/usr/bin/env node
// Share for comments (ticket 03): the main-process shared-talk module against a fake Worker that
// keeps the real contract (worker/README.md § Shared talk routes): POST /shares with the admin
// bearer, PUT /shares/<id>/talk with the owner token and revision = previous + 1 (else 409 with the
// current revision), POST /shares/<id>/close. Numbered sections match the review's fix list.
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSharedTalks, readRevisionSlides, readRevisionSnapshot, revisionSnapshotPath, workerTalkSlug } from '../src/main/shared-talk.ts'
import { isShareId } from '../src/shared/share-id.ts'
import { isShareId as workerIsShareId } from '../worker/shared-talk-route.ts'
import {
  FOREIGN_SHARE_WARNING, STOPPED_LOCALLY_MESSAGE, initialShareSheet, isValidShareDomain, sharedStatusLabel, sharedTalkLink, shareSheetReducer, shareSheetView,
} from '../src/shared/shared-talk.ts'

const ADMIN = 'admin-secret-value'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let idSeq = 0

function fakeWorker() {
  const shares = new Map()
  const calls = []
  const bySlug = new Map()
  const knobs = { failNext: 0, offline: false, putDelay: 0, loseNextReply: false, badId: null, refuseClose: false }
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  async function fetchImpl(url, init = {}) {
    const parsed = new URL(url)
    const auth = init.headers?.authorization ?? ''
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ method: init.method, origin: parsed.origin, pathname: parsed.pathname, auth, body })
    if (knobs.offline) throw new TypeError('fetch failed')
    if (knobs.failNext > 0) { knobs.failNext -= 1; return json(500, { error: { code: 'internal', message: 'boom' } }) }
    const { pathname } = parsed
    if (init.method === 'POST' && pathname === '/shares') {
      if (auth !== `Bearer ${ADMIN}`) return json(401, { error: { code: 'unauthorised' } })
      await wait(15)
      if (knobs.badId !== null) return json(201, { shareId: knobs.badId, ownerToken: 'owner-token-0123456789' })
      idSeq += 1
      const shareId = `sh${String(idSeq).padStart(6, '0')}`
      // The real Worker stops a slug's previous share when a new one is created.
      const previous = bySlug.get(body.talkSlug)
      if (previous) shares.get(previous).closed = true
      bySlug.set(body.talkSlug, shareId)
      shares.set(shareId, { token: `owner-token-${shareId}-xyz`, revision: 0, closed: false, pushes: [], talkSlug: body.talkSlug, title: body.title })
      return json(201, { shareId, ownerToken: `owner-token-${shareId}-xyz` })
    }
    const m = pathname.match(/^\/shares\/([^/]+)\/(talk|close)$/)
    const share = m && shares.get(m[1])
    if (!share) return json(404, { error: { code: 'not_found' } })
    if (share.closed) return json(410, { error: { code: 'share_closed' } })
    if (m[2] === 'talk' && init.method === 'PUT') {
      if (auth !== `Bearer ${share.token}`) return json(401, { error: { code: 'unauthorised' } })
      if (knobs.putDelay) await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, knobs.putDelay)
        init.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')) }, { once: true })
      })
      if (body.revision !== share.revision + 1) return json(409, { error: { code: 'revision_conflict' }, revision: share.revision })
      share.revision = body.revision
      share.pushes.push(body)
      if (knobs.loseNextReply) { knobs.loseNextReply = false; throw new TypeError('socket hang up') }
      return json(200, { revision: share.revision, seq: share.pushes.length })
    }
    if (m[2] === 'close' && init.method === 'POST') {
      if (knobs.refuseClose || auth !== `Bearer ${share.token}`) return json(401, { error: { code: 'unauthorised' } })
      share.closed = true
      return json(200, { closed: true })
    }
    return json(404, { error: { code: 'route_not_found' } })
  }
  return { fetch: fetchImpl, shares, calls, knobs }
}

function harness({ baseUrl = 'http://worker.test/', worker = fakeWorker(), root = mkdtempSync(join(tmpdir(), 'tw-shared-talk-')), identityOf = (path) => ({ key: `id:${path}`, realPath: path }) } = {}) {
  const disks = new Map()
  const stamps = []
  const builds = []
  const changes = []
  let endpointCalls = 0
  const config = { linkBase: '' }
  const talk = (folder, name = 'ai-assessment', text = '---\ntitle: AI and assessment\n---\n\n### One\n- a\n') => {
    const dir = join(root, 'vault', folder, name)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${name}-outline.md`)
    writeFileSync(path, text)
    disks.set(path, text)
    return path
  }
  const registryPath = join(root, 'userData', 'shared-talk-registry.json')
  const make = () => createSharedTalks({
    registryPath,
    endpoint: async () => { endpointCalls += 1; return { baseUrl, adminSecret: ADMIN } },
    linkBase: () => config.linkBase,
    identityOf,
    slugOf: (path) => path.split('/').pop().replace('-outline.md', ''),
    readOutline: async (path) => disks.get(path),
    peekOutline: (path) => readFileSync(path, 'utf8'),
    build: async ({ content, proposals }) => {
      builds.push({ content, proposals })
      return { title: 'T', html: `<html>${content}|proposals=${proposals}</html>`, slides: [{ slideId: 'one', title: 'One', text: content }] }
    },
    stampShareUrl: async (path, url) => { stamps.push({ path, url }) },
    qrSvg: async (url) => `<svg data-url="${url}"></svg>`,
    fetch: worker.fetch,
    onChange: (key, state, previousKey) => changes.push(previousKey ? { key, state, previousKey } : { key, state }),
    saveDebounceMs: 20,
  })
  return {
    root, worker, stamps, builds, changes, registryPath, config, make, talk, talks: make(),
    setDisk: (path, text) => disks.set(path, text),
    endpointCalls: () => endpointCalls,
    pushesOf: (shareId) => worker.shares.get(shareId).pushes,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

// ── Share, save, coalescing, 409, failures, switch 1, link base (the build's behaviours) ─────────
{
  const h = harness()
  const path = h.talk('workshops')
  const state = await h.talks.share(path, 'AI and assessment')
  const shareId = state.shareId
  assert.ok(isShareId(shareId))
  assert.equal(state.url, `http://worker.test/shares/${shareId}`)
  assert.equal(state.revision, 1)
  assert.equal(state.liveUpdates && state.proposals, true, 'both switches on by default')
  assert.equal(state.localOnly, false)
  assert.match(state.qrSvg, /data-url=/)
  assert.deepEqual(h.stamps, [{ path, url: state.url }], 'share_url is written into the outline')
  assert.equal('ownerToken' in state, false, 'the owner token never reaches a window')
  for (const change of h.changes) assert.equal(JSON.stringify(change.state ?? {}).includes('owner-token'), false)
  assert.equal(statSync(h.registryPath).mode & 0o777, 0o600)
  assert.deepEqual(readRevisionSlides(path, shareId, 1)?.map((s) => s.slideId), ['one'])
  const pushes = h.pushesOf(shareId)
  h.talks.noteSaved(path, 'saved v2')
  await h.talks.idle()
  assert.deepEqual(pushes.map((p) => p.revision), [1, 2])
  for (let i = 0; i < 5; i += 1) h.talks.noteSaved(path, `burst ${i}`)
  await h.talks.idle()
  assert.equal(pushes.length, 3, 'a burst of saves is one push')
  h.talks.noteSaved(path, 'burst 4')
  await h.talks.idle()
  assert.equal(pushes.length, 3, 'an unchanged save pushes nothing')
  h.worker.shares.get(shareId).revision = 9
  h.talks.noteSaved(path, 'after conflict')
  await h.talks.idle()
  assert.equal(pushes.at(-1).revision, 10, '409 re-pushes at the Worker\'s revision + 1')
  h.worker.knobs.offline = true
  h.talks.noteSaved(path, 'offline')
  await h.talks.idle()
  h.worker.knobs.offline = false
  assert.match((await h.talks.status(path)).lastError, /fetch failed/, 'a failure is recorded, never thrown into the save')
  h.talks.noteSaved(path, 'recovered')
  await h.talks.idle()
  assert.equal((await h.talks.status(path)).lastError, null)
  await h.talks.setOptions(path, { liveUpdates: false })
  const before = pushes.length
  h.talks.noteSaved(path, 'quiet')
  await wait(60); await h.talks.idle()
  assert.equal(pushes.length, before, 'switch 1 off: no push on save')
  h.setDisk(path, 'explicit update')
  await h.talks.update(path)
  assert.match(pushes.at(-1).html, /explicit update/, 'Update shared copy pushes')
  h.config.linkBase = 'https://drafts.handouts.fyi/'
  assert.equal((await h.talks.status(path)).url, `https://drafts.handouts.fyi/${shareId}`)
  assert.equal(sharedTalkLink('http://w.test', 'k7m2abcd', ''), 'http://w.test/shares/k7m2abcd')

  // Share domain validation (security review, ticket 07): a bare RFC-1035 hostname only — no
  // scheme, port, path, space, wildcard, IP literal or localhost — case-insensitively.
  assert.equal(isValidShareDomain('drafts.handouts.fyi'), true)
  assert.equal(isValidShareDomain('Drafts.Handouts.FYI'), true)
  assert.equal(isValidShareDomain('a-b.example.co'), true)
  for (const bad of [
    'https://drafts.handouts.fyi', 'drafts.handouts.fyi:8080', 'drafts.handouts.fyi/path',
    'drafts handouts.fyi', '*.handouts.fyi', '127.0.0.1', '255.255.255.255', 'localhost',
    'sub.localhost', 'handouts', '-bad.example.com', 'bad-.example.com', '', '   ', null, 42,
  ]) assert.equal(isValidShareDomain(bad), false, JSON.stringify(bad))

  // sharedTalkLink applies the same rule to whatever is actually stored: a valid domain is used, an
  // invalid or unparsable one falls back to the Worker origin exactly as no domain does.
  assert.equal(sharedTalkLink('http://w.test', 'k7m2abcd', 'https://drafts.handouts.fyi'), 'https://drafts.handouts.fyi/k7m2abcd')
  assert.equal(sharedTalkLink('http://w.test', 'k7m2abcd', 'https://127.0.0.1'), 'http://w.test/shares/k7m2abcd')
  assert.equal(sharedTalkLink('http://w.test', 'k7m2abcd', 'https://localhost'), 'http://w.test/shares/k7m2abcd')
  assert.equal(sharedTalkLink('http://w.test', 'k7m2abcd', 'not a url at all'), 'http://w.test/shares/k7m2abcd')

  console.log('PASS base: share, save push, coalescing, 409, failures, switch 1, link base, domain validation')
  h.cleanup()
}

// ── 2. Share identity is the outline's identity, never its file name ─────────────────────────────
{
  const h = harness()
  const a = h.talk('workshops')
  const b = h.talk('talks') // same file name, different folder
  const sa = await h.talks.share(a, 'AI and assessment')
  const sb = await h.talks.share(b, 'AI and assessment')
  assert.notEqual(sa.shareId, sb.shareId, 'two talks named alike are two shares')
  assert.notEqual(sa.key, sb.key)
  assert.equal(h.talks.list().length, 2)
  assert.equal(h.worker.shares.get(sa.shareId).closed, false, 'the second share did not replace the first on the Worker')
  assert.notEqual(h.worker.shares.get(sa.shareId).talkSlug, h.worker.shares.get(sb.shareId).talkSlug)
  assert.match(h.worker.shares.get(sa.shareId).talkSlug, /^ai-assessment-[0-9a-f]{10}$/)
  assert.equal(workerTalkSlug('My_Talk', '/x'), workerTalkSlug('My_Talk', '/x'), 'stable for one path')
  assert.match(workerTalkSlug('My_Talk', '/x'), /^my-talk-[0-9a-f]{10}$/, 'Worker-safe')
  h.talks.noteSaved(b, 'only b changed')
  await h.talks.idle()
  assert.equal(h.pushesOf(sb.shareId).length, 2)
  assert.equal(h.pushesOf(sa.shareId).length, 1, 'a save of one talk never pushes the other')
  await h.talks.stop(b)
  assert.equal((await h.talks.status(a)).shareId, sa.shareId, 'stopping one leaves the other shared')
  const reg = JSON.parse(readFileSync(h.registryPath, 'utf8'))
  assert.deepEqual(Object.keys(reg.shares), [`id:${a}`], 'the registry keys by identity')
  // A pre-identity registry (keyed by file name) is re-keyed by identity on load.
  writeFileSync(h.registryPath, JSON.stringify({ version: 1, shares: { 'ai-assessment': { ...reg.shares[`id:${a}`], key: undefined, realPath: undefined } } }))
  const reloaded = h.make()
  assert.equal((await reloaded.status(a)).shareId, sa.shareId)
  assert.equal(await reloaded.status(b), null)
  console.log('PASS 2: identity-keyed shares; same-named talks never share or replace one share')
  h.cleanup()
}

// ── 3. share() is serialised per talk ───────────────────────────────────────────────────────────
{
  const h = harness()
  const path = h.talk('workshops')
  const [one, two, three] = await Promise.all([h.talks.share(path, 'T'), h.talks.share(path, 'T'), h.talks.share(path, 'T')])
  assert.equal(h.worker.calls.filter((c) => c.pathname === '/shares').length, 1, 'one create for three concurrent calls')
  assert.equal(one.shareId, two.shareId)
  assert.equal(two.shareId, three.shareId)
  assert.equal(h.worker.shares.get(one.shareId).closed, false, 'the link every caller got is the live one')
  console.log('PASS 3: concurrent share() calls await one create and return the same live share')
  h.cleanup()
}

// ── 4. Ids from the Worker pass the Worker's own rule before touching a path or URL ──────────────
{
  assert.equal(isShareId, workerIsShareId, 'the app and the Worker use one definition')
  for (const id of ['k7m2abcd', 'sh000001']) assert.equal(isShareId(id), true)
  // 'sessions' and 'internal' fit the shape but are reserved words (worker/share-id.ts) — real
  // top-level routes on the Worker; refusing them here is what keeps a forwarded request from ever
  // reaching one of those routes under a share id (security review, ticket 07).
  for (const bad of ['../../etc', 'ABCDEFGH', 'abc', 'abcdefghi', 'abcd/efg', '', null, 12345678, 'sessions', 'internal']) {
    assert.equal(isShareId(bad), false, `${JSON.stringify(bad)} refused`)
  }
  const h = harness()
  const path = h.talk('workshops')
  h.worker.knobs.badId = '../../../x'
  await assert.rejects(h.talks.share(path, 'T'), /id this app does not accept/)
  assert.deepEqual(h.talks.list(), [])
  assert.equal(existsSync(join(path, '..', 'feedback')), false, 'nothing written under the talk')
  assert.equal(h.stamps.length, 0, 'no link written into the outline')
  assert.throws(() => revisionSnapshotPath(path, '../x', 1), /Not a share id/)
  // A tampered registry row is ignored rather than used.
  h.worker.knobs.badId = null
  const good = await h.talks.share(path, 'T')
  const reg = JSON.parse(readFileSync(h.registryPath, 'utf8'))
  reg.shares[`id:${path}`].shareId = '../../evil'
  writeFileSync(h.registryPath, JSON.stringify(reg))
  assert.equal(await h.make().status(path), null, 'an invalid registry row is not a share')
  assert.ok(good)
  console.log('PASS 4: worker ids validated with the worker\'s rule; bad ids and bad registry rows refused')
  h.cleanup()
}

// ── 5. Stop uses only the owner token on the share's own origin; refused → stopped locally ───────
{
  const h = harness()
  const path = h.talk('workshops')
  const state = await h.talks.share(path, 'T')
  const endpointBefore = h.endpointCalls()
  h.worker.knobs.refuseClose = true
  const callsBefore = h.worker.calls.length
  const result = await h.talks.stop(path)
  const stopCalls = h.worker.calls.slice(callsBefore)
  assert.deepEqual(result, { serverClosed: false, message: STOPPED_LOCALLY_MESSAGE })
  assert.equal(STOPPED_LOCALLY_MESSAGE, 'Could not stop it on the server; the link retires on its own.')
  assert.equal(h.endpointCalls(), endpointBefore, 'no admin secret is fetched to stop a share')
  assert.equal(stopCalls.length, 1, 'one close call')
  assert.equal(stopCalls[0].origin, 'http://worker.test', 'to the origin the share was created on')
  assert.equal(stopCalls[0].auth.includes(ADMIN), false, 'never the admin secret')
  assert.equal(await h.talks.status(path), null, 'stopped locally')
  assert.equal(h.stamps.at(-1).url, null, 'share_url removed')
  assert.equal(h.worker.shares.get(state.shareId).closed, false, 'the Worker share retires on its own')
  // A share whose recorded origin differs from today's Worker is still closed at ITS origin.
  const h2 = harness({ baseUrl: 'http://old-worker.test' })
  const p2 = h2.talk('x')
  await h2.talks.share(p2, 'T')
  const other = createSharedTalks({ ...{}, registryPath: h2.registryPath,
    endpoint: async () => ({ baseUrl: 'http://new-worker.test', adminSecret: 'NEW-ADMIN' }),
    linkBase: () => '', identityOf: (p) => ({ key: `id:${p}`, realPath: p }), slugOf: () => 'x', readOutline: async () => '', peekOutline: () => '',
    build: async () => ({ title: '', html: '', slides: [] }), stampShareUrl: async () => {}, qrSvg: async () => '', fetch: h2.worker.fetch })
  const n = h2.worker.calls.length
  await other.stop(p2)
  assert.deepEqual(h2.worker.calls.slice(n).map((c) => c.origin), ['http://old-worker.test'])
  assert.equal(h2.worker.calls.slice(n).some((c) => c.auth.includes('ADMIN') || c.auth.includes(ADMIN)), false)
  console.log('PASS 5: stop sends only the owner token to the share\'s own origin; refusal stops locally with the message')
  h.cleanup(); h2.cleanup()
}

// ── 6. Revision files are written atomically; a corrupt file is an error, not "missing" ──────────
{
  const h = harness()
  const path = h.talk('workshops')
  const { shareId } = await h.talks.share(path, 'T')
  h.talks.noteSaved(path, 'v2')
  await h.talks.idle()
  const dir = join(path, '..', 'feedback', `${shareId}-revisions`)
  assert.deepEqual(readdirSync(dir).sort(), ['1.json', '2.json'], 'no temp files left behind')
  assert.equal(readRevisionSnapshot(path, shareId, 2).source, 'v2')
  assert.equal(readRevisionSlides(path, shareId, 7), null, 'a revision never kept is missing')
  writeFileSync(join(dir, '2.json'), '{"shareId": "trunc')
  assert.throws(() => readRevisionSlides(path, shareId, 2), /corrupt/, 'a corrupt file is reported as an error')
  writeFileSync(join(dir, '1.json'), JSON.stringify({ shareId: 'otherid1', revision: 1, slides: [] }))
  assert.throws(() => readRevisionSlides(path, shareId, 1), /corrupt/, 'a file for another share is not this revision')
  const regText = readFileSync(h.registryPath, 'utf8')
  assert.doesNotThrow(() => JSON.parse(regText))
  assert.equal(readdirSync(join(h.root, 'userData')).filter((f) => f.endsWith('.tmp')).length, 0, 'the registry is written atomically too')
  console.log('PASS 6: atomic revision files; corrupt or mismatched files throw; missing is null')
  h.cleanup()
}

// ── 7. Switch 1 off: a proposals change re-pushes the last CONFIRMED revision from disk ──────────
{
  const h = harness()
  const path = h.talk('workshops')
  h.setDisk(path, 'shared text r1')
  const { shareId } = await h.talks.share(path, 'T')
  await h.talks.setOptions(path, { liveUpdates: false })
  h.setDisk(path, 'NEWER OUTLINE NOT SHARED')
  h.talks.noteSaved(path, 'NEWER OUTLINE NOT SHARED')
  await h.talks.setOptions(path, { proposals: false })
  const pushes = h.pushesOf(shareId)
  assert.equal(pushes.length, 2)
  assert.equal(pushes[1].revision, 2)
  assert.deepEqual(pushes[1].slides, readRevisionSlides(path, shareId, 1), 'the slide text of the confirmed revision, from disk')
  assert.match(pushes[1].html, /shared text r1\|proposals=false/, 'their page rebuilt from the confirmed revision with proposals off')
  assert.equal(pushes[1].html.includes('NEWER'), false, 'never the current outline')
  // With the revision file gone the toggle refuses rather than falling back to the outline.
  rmSync(join(path, '..', 'feedback'), { recursive: true, force: true })
  await h.talks.setOptions(path, { proposals: true })
  assert.equal(pushes.length, 2, 'nothing pushed')
  assert.match((await h.talks.status(path)).lastError, /not kept on this Mac/)
  console.log('PASS 7: proposals toggle with switch 1 off pushes the confirmed revision from disk, never the outline')
  h.cleanup()
}

// ── 8. Stop cancels queued and running pushes; nothing is pushed after close ─────────────────────
{
  const h = harness()
  const path = h.talk('workshops')
  const { shareId } = await h.talks.share(path, 'T')
  h.worker.knobs.putDelay = 200
  h.talks.noteSaved(path, 'in flight')
  await wait(60) // the PUT is running
  h.talks.noteSaved(path, 'queued behind')
  await wait(40)
  h.talks.noteSaved(path, 'pending debounce')
  const result = await h.talks.stop(path)
  assert.equal(result.serverClosed, true)
  await wait(300)
  await h.talks.idle()
  const closeAt = h.worker.calls.findIndex((c) => c.pathname.endsWith('/close'))
  assert.ok(closeAt > 0)
  assert.equal(h.worker.calls.slice(closeAt + 1).some((c) => c.method === 'PUT'), false, 'no push after close')
  assert.equal(h.pushesOf(shareId).length, 1, 'the running push was aborted and the queued ones dropped')
  assert.equal(h.worker.shares.get(shareId).closed, true)
  console.log('PASS 8: stop aborts the running push, drops queued and pending ones; nothing after close')
  h.cleanup()
}

// ── 9. A local Worker: the link works only on this Mac ──────────────────────────────────────────
{
  const h = harness({ baseUrl: 'http://127.0.0.1:8787' })
  const path = h.talk('workshops')
  const state = await h.talks.share(path, 'T')
  assert.equal(state.localOnly, true)
  const view = shareSheetView(shareSheetReducer(initialShareSheet(), { type: 'created', share: state }))
  assert.match(view.localNote, /works only on this Mac/)
  assert.equal(view.showPasteHint, false, 'no "paste it into Teams" for a link nobody else can open')
  const remote = shareSheetView(shareSheetReducer(initialShareSheet(), { type: 'created', share: { ...state, localOnly: false } }))
  assert.equal(remote.showPasteHint, true)
  assert.equal(remote.localNote, '')
  console.log('PASS 9: local Worker → "works only on this Mac", paste hint hidden')
  h.cleanup()
}

// ── 10. An outline shared from another Mac: warn before sharing ─────────────────────────────────
{
  const h = harness()
  const path = h.talk('workshops', 'ai-assessment', '---\ntitle: T\nshare_url: https://drafts.handouts.fyi/zz99zz99\n---\n\n### One\n')
  const seen = await h.talks.inspect(path)
  assert.deepEqual(seen, { share: null, foreignShareUrl: 'https://drafts.handouts.fyi/zz99zz99' })
  assert.equal(h.worker.calls.length, 0, 'inspecting shares nothing')
  let m = shareSheetReducer(initialShareSheet(), { type: 'inspected', ...seen })
  assert.equal(m.phase, 'confirm-replace')
  assert.equal(shareSheetView(m).replaceWarning, FOREIGN_SHARE_WARNING)
  assert.equal(FOREIGN_SHARE_WARNING, 'Already shared from another Mac; sharing here replaces that link.')
  assert.equal(shareSheetView(m).canCopy, false)
  m = shareSheetReducer(m, { type: 'creating' })
  const state = await h.talks.share(path, 'T')
  m = shareSheetReducer(m, { type: 'created', share: state })
  assert.equal(shareSheetView(m).replaceWarning, '')
  assert.deepEqual(await h.talks.inspect(path), { share: await h.talks.status(path), foreignShareUrl: null }, 'this Mac\'s own share is not foreign')
  const plain = h.talk('other')
  assert.equal(shareSheetReducer(initialShareSheet(), { type: 'inspected', ...(await h.talks.inspect(plain)) }).phase, 'creating', 'no share_url: share at once')
  console.log('PASS 10: a share_url from another Mac is warned about before sharing')
  h.cleanup()
}

// ── 11. Lost reply: the 409 confirms the lost attempt; its slides are kept as that revision ──────
{
  const h = harness()
  const path = h.talk('workshops')
  const { shareId } = await h.talks.share(path, 'T')
  h.worker.knobs.loseNextReply = true
  h.talks.noteSaved(path, 'landed but reply lost')
  await h.talks.idle()
  assert.match((await h.talks.status(path)).lastError, /socket hang up/)
  assert.equal(h.worker.shares.get(shareId).revision, 2, 'the Worker has revision 2')
  assert.equal(readRevisionSlides(path, shareId, 2), null, 'not yet known here')
  h.talks.noteSaved(path, 'next save')
  await h.talks.idle()
  assert.equal(readRevisionSlides(path, shareId, 2)?.[0].text, 'landed but reply lost', 'the lost attempt is kept as revision 2')
  assert.equal(readRevisionSlides(path, shareId, 3)?.[0].text, 'next save')
  assert.deepEqual(h.pushesOf(shareId).map((p) => p.revision), [1, 2, 3])
  const s = await h.talks.status(path)
  assert.equal(s.revision, 3)
  assert.equal(s.lastError, null)
  // The same text re-sent after a lost reply is confirmed by the 409 without a second push.
  h.setDisk(path, 'same again')
  h.worker.knobs.loseNextReply = true
  await h.talks.update(path)
  assert.equal((await h.talks.status(path)).revision, 3, 'reply lost: not confirmed yet')
  const count = h.pushesOf(shareId).length
  await h.talks.update(path)
  assert.equal(h.pushesOf(shareId).length, count, 'the lost identical push is confirmed by the 409, not pushed twice')
  assert.equal((await h.talks.status(path)).revision, 4)
  assert.equal(readRevisionSlides(path, shareId, 4)?.[0].text, 'same again')
  console.log('PASS 11: a lost reply is confirmed by the 409 and its slides kept as that revision')
  h.cleanup()
}

// ── 12. A moved talk folder keeps pushing (ticket 03 review follow-up, fixed in ticket 05) ────────
{
  // Identity survives a move (dev:inode in the app); the path the talk is opened from changes.
  const h = harness({ identityOf: (path) => ({ key: 'id:the-talk', realPath: path }) })
  const oldPath = h.talk('workshops')
  const state = await h.talks.share(oldPath, 'AI and assessment')
  const { renameSync } = await import('node:fs')
  const oldDir = join(h.root, 'vault', 'workshops')
  const newDir = join(h.root, 'vault', 'moved-workshops')
  renameSync(oldDir, newDir)
  const newPath = join(newDir, 'ai-assessment', 'ai-assessment-outline.md')
  h.setDisk(newPath, 'after the move')
  h.changes.length = 0
  h.talks.noteSaved(newPath, 'after the move')
  await h.talks.idle()
  const after = await h.talks.status(newPath)
  assert.equal(after.lastError, null, 'the push after a move does not fail on the old path')
  assert.equal(after.revision, 2)
  assert.equal(after.outlinePath, newPath, 'the stored outline path follows the talk')
  assert.equal(JSON.parse(readFileSync(h.registryPath, 'utf8')).shares['id:the-talk'].outlinePath, newPath, 'and is persisted')
  assert.ok(existsSync(join(newDir, 'ai-assessment', 'feedback', `${state.shareId}-revisions`, '2.json')), 'revision text kept beside the talk where it is now')
  assert.equal(existsSync(oldDir), false, 'the old folder is not recreated')
  assert.ok(h.changes.some((c) => c.state?.outlinePath === newPath), 'windows (and the feedback service) hear of the new path')
  assert.equal(h.talks.owners()[0].outlinePath, newPath, 'owners() carries the new path for the owner socket')
  // Same file, new identity key (an atomic save replaces the inode): windows hear the old key go.
  const h2 = harness({ identityOf: (path) => ({ key: `id:${h2key}`, realPath: path }) })
  let h2key = 'inode-1'
  const p2 = h2.talk('workshops')
  const s2 = await h2.talks.share(p2, 'AI and assessment')
  h2key = 'inode-2'
  h2.changes.length = 0
  assert.equal((await h2.talks.status(p2)).shareId, s2.shareId)
  assert.deepEqual(h2.changes.map((c) => [c.key, c.state?.shareId ?? null, c.previousKey]), [['id:inode-2', s2.shareId, 'id:inode-1']], 'a re-key is ONE event carrying the old key: never "gone" then "back"')
  // The owner socket found the share ended: recorded, nothing pushed, the sheet says so.
  h2.talks.markEnded(s2.shareId, 'stopped')
  const endedState = await h2.talks.status(p2)
  assert.equal(endedState.ended, 'stopped')
  assert.equal(h2.talks.owners()[0].ended, 'stopped')
  assert.equal(JSON.parse(readFileSync(h2.registryPath, 'utf8')).shares['id:inode-2'].ended, 'stopped', 'persisted')
  const pushesBefore = h2.pushesOf(s2.shareId).length
  h2.talks.noteSaved(p2, 'after the end')
  await wait(60); await h2.talks.idle()
  assert.equal(h2.pushesOf(s2.shareId).length, pushesBefore, 'an ended share pushes nothing')
  assert.match(shareSheetView({ ...initialShareSheet(), phase: 'ready', share: endedState }).status, /Sharing has ended/)
  h2.cleanup()
  console.log('PASS 12: recordFor refreshes the stored outline path; a moved talk keeps pushing; a re-key is one event; an ended share is recorded and pushes nothing')
  h.cleanup()
}

// ── Sheet model basics ──────────────────────────────────────────────────────────────────────────
{
  const share = { key: 'k', slug: 's', outlinePath: '/p', realPath: '/p', shareId: 'k7m2abcd', url: 'https://drafts.handouts.fyi/k7m2abcd', localOnly: false, revision: 3, liveUpdates: true, proposals: true, createdAt: '', lastPushedAt: null, pushing: false, lastError: null, qrSvg: '' }
  let m = shareSheetReducer(initialShareSheet(), { type: 'inspected', share: null, foreignShareUrl: null })
  assert.equal(shareSheetView(m).status, 'Creating the link…')
  m = shareSheetReducer(m, { type: 'created', share })
  assert.equal(shareSheetView(m).canCopy, true)
  assert.equal(shareSheetView(m).showUpdate, false)
  m = shareSheetReducer(m, { type: 'changed', share: { ...share, liveUpdates: false } })
  assert.equal(shareSheetView(m).showUpdate, true)
  m = shareSheetReducer(m, { type: 'stopping' })
  assert.equal(shareSheetView(m).canStop, false)
  m = shareSheetReducer(m, { type: 'failed', error: 'Could not stop sharing: offline' })
  assert.equal(shareSheetView(m).statusTone, 'error')
  assert.equal(sharedStatusLabel(share), 'Shared for comments · drafts.handouts.fyi/k7m2abcd')
  console.log('PASS sheet model: creating → ready, Update only with switch 1 off, stop, errors')
}

// ── One frontmatter stamp for handout_url and share_url ─────────────────────────────────────────
{
  const { stampFrontmatterValue, stampHandoutUrl, stampShareUrl } = await import('../src/shared/handout-stamp.ts')
  const text = '---\ntitle: T\nhandout_url: https://a\n---\n\nbody\n'
  assert.equal(stampHandoutUrl(text, 'https://b'), '---\ntitle: T\nhandout_url: https://b\n---\n\nbody\n')
  assert.equal(stampShareUrl(text, 'https://s/k7m2abcd'), '---\ntitle: T\nhandout_url: https://a\nshare_url: https://s/k7m2abcd\n---\n\nbody\n')
  assert.equal(stampShareUrl(stampShareUrl(text, 'https://s/x'), null), text, 'null removes the key')
  assert.equal(stampShareUrl(text, null), text, 'removing an absent key changes nothing')
  assert.equal(stampFrontmatterValue('no frontmatter\n', 'share_url', 'x'), 'no frontmatter\n', 'a stamp never invents frontmatter')
  assert.equal(stampHandoutUrl(stampHandoutUrl(text, 'https://b'), 'https://b'), stampHandoutUrl(text, 'https://b'), 'idempotent')
  console.log('PASS stamp: one frontmatter-stamp helper for handout_url and share_url')
}
