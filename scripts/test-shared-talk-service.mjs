#!/usr/bin/env node
// Share for comments (ticket 03): the main-process shared-talk module against a fake Worker that
// keeps the real contract (worker/README.md § Shared talk routes): POST /shares with the admin
// bearer, PUT /shares/<id>/talk with the owner token and revision = previous + 1 (else 409 with the
// current revision), POST /shares/<id>/close. Numbered sections match the review's fix list.
import { strict as assert } from 'node:assert'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSharedTalks, readRevisionSlides, readRevisionSnapshot, revisionSnapshotPath, SHARE_UNVERIFIED, workerTalkSlug } from '../src/main/shared-talk.ts'
import { isShareId } from '../src/shared/share-id.ts'
import { memoryOwnerTokens } from './lib/memory-secrets.mjs'
import { createSingleFlight } from '../src/main/single-flight.ts'
import { buildInGate } from '../src/main/shared-talk-build.ts'
import { isShareId as workerIsShareId } from '../worker/shared-talk-route.ts'
import {
  FOREIGN_SHARE_WARNING, STOPPED_LOCALLY_MESSAGE, initialShareSheet, isValidShareDomain, sharedStatusLabel, sharedTalkLink, shareSheetReducer, shareSheetView,
} from '../src/shared/shared-talk.ts'

const ADMIN = 'admin-secret-value'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const shareUrlIn = (text) => text.match(/^share_url: (.*)$/m)?.[1] ?? null
let idSeq = 0

// Route as a plain string: path only, no query or fragment.
const routeOf = (u) => { const p = new URL(u); return p.href.slice(p.origin.length).replace(/[?#].*$/, '') }

function fakeWorker() {
  const shares = new Map()
  const calls = []
  const bySlug = new Map()
  const knobs = { failNext: 0, offline: false, putDelay: 0, loseNextReply: false, badId: null, refuseClose: false, failNextClose: 0, loseCloseReply: false }
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  async function fetchImpl(url, init = {}) {
    const parsed = new URL(url)
    const route = routeOf(url)
    const auth = init.headers?.authorization ?? ''
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ method: init.method, origin: parsed.origin, route, auth, body })
    if (knobs.offline) throw new TypeError('fetch failed')
    if (knobs.failNext > 0) { knobs.failNext -= 1; return json(500, { error: { code: 'internal', message: 'boom' } }) }
    if (init.method === 'POST' && route === '/shares') {
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
    // Admin only: the slug's open share (worker/index.ts, GET /shares/by-talk/<slug>).
    const lookup = route.match(/^\/shares\/by-talk\/([^/]+)$/)
    if (lookup && init.method === 'GET') {
      if (auth !== `Bearer ${ADMIN}`) return json(401, { error: { code: 'admin_auth_required' } })
      const id = bySlug.get(decodeURIComponent(lookup[1]))
      return id && !shares.get(id).closed ? json(200, { active: true, shareId: id }) : json(200, { active: false })
    }
    const m = route.match(/^\/shares\/([^/]+)\/(talk|close|talk\.json)$/)
    const share = m && shares.get(m[1])
    if (!share) return json(404, { error: { code: 'not_found' } })
    if (share.closed) return json(410, { error: { code: 'share_closed' } })
    // Public: no credential (the real route refuses one).
    if (m[2] === 'talk.json' && (init.method ?? 'GET') === 'GET') {
      if (auth) return json(400, { error: { code: 'credentials_not_allowed' } })
      return json(200, { shareId: m[1], title: share.title, revision: share.revision, updatedAt: null, slides: [] })
    }
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
      // The owner token, or the admin bearer (the Worker's addition: the app lost its token).
      if (knobs.refuseClose || (auth !== `Bearer ${share.token}` && auth !== `Bearer ${ADMIN}`)) return json(401, { error: { code: 'unauthorised' } })
      if (knobs.failNextClose > 0) { knobs.failNextClose -= 1; return json(500, { error: { code: 'internal', message: 'close failed' } }) }
      share.closed = true
      if (knobs.loseCloseReply) { knobs.loseCloseReply = false; throw new TypeError('socket hang up') }
      return json(200, { closed: true })
    }
    return json(404, { error: { code: 'route_not_found' } })
  }
  return { fetch: fetchImpl, shares, calls, knobs }
}

function harness({ baseUrl = 'http://worker.test/', worker = fakeWorker(), root = mkdtempSync(join(tmpdir(), 'tw-shared-talk-')), identityOf = (path) => ({ key: `id:${path}`, realPath: path }) } = {}) {
  const disks = new Map()
  // The outline as the talk writer holds it: share_url is changed only through the module's decide.
  const outlines = new Map()
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
    outlines.set(path, text)
    return path
  }
  const registryPath = join(root, 'userData', 'shared-talk-registry.json')
  const ownerTokens = memoryOwnerTokens()
  const make = () => createSharedTalks({
    registryPath, ownerTokens,
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
    stampShareUrl: async (path, decide) => {
      const text = decide(outlines.get(path) ?? '---\ntitle: T\n---\n')
      outlines.set(path, text)
      stamps.push({ path, url: shareUrlIn(text) })
    },
    qrSvg: async (url) => `<svg data-url="${url}"></svg>`,
    fetch: worker.fetch,
    onChange: (key, state, previousKey) => changes.push(previousKey ? { key, state, previousKey } : { key, state }),
    saveDebounceMs: 20,
  })
  return {
    root, worker, stamps, builds, changes, registryPath, ownerTokens, config, make, talk, talks: make(),
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
  assert.equal(readFileSync(h.registryPath, 'utf8').includes('owner-token'), false, 'the registry file carries no owner token')
  assert.equal('ownerToken' in Object.values(JSON.parse(readFileSync(h.registryPath, 'utf8')).shares)[0], false)
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
  assert.equal((await h.talks.status(path)).lastError, 'the sharing service could not be reached.', 'a failure is recorded, never thrown into the save, in fixed words (never the transport\'s own error)')
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
  assert.equal(h.worker.calls.filter((c) => c.route === '/shares').length, 1, 'one create for three concurrent calls')
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
  const other = createSharedTalks({ ...{}, registryPath: h2.registryPath, ownerTokens: h2.ownerTokens,
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
  const closeAt = h.worker.calls.findIndex((c) => c.route.endsWith('/close'))
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
  assert.equal((await h.talks.status(path)).lastError, 'the sharing service could not be reached.') // fixed words, never the transport's own error
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
  assert.equal(h2.talks.owners()[0].ended, 'stopped')
  assert.equal(JSON.parse(readFileSync(h2.registryPath, 'utf8')).shares['id:inode-2'].ended, 'stopped', 'persisted')
  const pushesBefore = h2.pushesOf(s2.shareId).length
  h2.talks.noteSaved(p2, 'after the end')
  await wait(60); await h2.talks.idle()
  assert.equal(h2.pushesOf(s2.shareId).length, pushesBefore, 'an ended share pushes nothing')
  // Round 3: an ended share is gone — status offers no link; a broadcast of it offers no Copy.
  assert.equal(await h2.talks.status(p2), null, 'status offers no ended link')
  const endedState = { ...s2, ended: 'stopped' }
  assert.match(shareSheetView({ ...initialShareSheet(), phase: 'ready', share: endedState }).status, /Sharing has ended/)
  assert.equal(shareSheetView({ ...initialShareSheet(), phase: 'ready', share: endedState }).canCopy, false, 'no Copy for an ended link')
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

// ── 12.x Share and Stop pressed at the same moment (ticket 12; the design is the header of
// src/main/shared-talk.ts). A fake Worker with gates on endpoint(), the POST /shares reply, build,
// qrSvg and the share_url write (a decide-applying in-memory outline behind a one-at-a-time queue).
// After every case: open shares on the Worker == registered rows == kept tokens == the module's
// shares, and share_url is the open share's link or absent.
function gate() {
  let open
  let arrive
  const promise = new Promise((resolve) => { open = resolve })
  const reached = new Promise((resolve) => { arrive = resolve })
  return { promise, reached, open: () => open(), arrive: () => arrive() }
}
/** Rejects when `promise` has not settled within `ms` (a hang is a failure, not a stuck run). */
function within(promise, ms, what) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms) })])
    .finally(() => clearTimeout(timer))
}
function t12harness(options = {}) {
  const worker = fakeWorker()
  const holds = { endpoint: [], prepost: [], post: [], build: [], qr: [], stamp: [] }
  /** Catch the NEXT call at `name`: it waits at the gate until opened. */
  const hold = (name) => { const g = gate(); holds[name].push(g); return g }
  const at = async (name) => { const g = holds[name].shift(); if (g) { g.arrive(); await g.promise } }
  const root = mkdtempSync(join(tmpdir(), 'tw-shared-talk-12-'))
  const dir = join(root, 'vault', 'talk')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'talk-outline.md')
  let outline = '---\ntitle: T\n---\n\n### One\n- a\n'
  writeFileSync(path, outline)
  let inode = 1
  // The writer's queue: one write at a time; decide runs when the write runs.
  let tail = Promise.resolve()
  const stampShareUrl = (p, decide) => {
    const run = tail.then(async () => { await at('stamp'); outline = decide(outline) })
    tail = run.catch(() => {})
    return run
  }
  const fetchImpl = async (url, init = {}) => {
    // `prepost`: before the Worker sees the POST; `post`: the Worker made the share, its reply held.
    if (init.method === 'POST' && routeOf(url) === '/shares') await at('prepost')
    const response = await worker.fetch(url, init)
    if (init.method === 'POST' && routeOf(url) === '/shares') await at('post')
    return response
  }
  const base = memoryOwnerTokens()
  const kept = new Set()
  const ownerTokens = {
    get: (key) => base.get(key), readable: () => base.readable(), assertCanStore: () => base.assertCanStore(),
    store(entries) { const back = base.store(entries); for (const key of back) kept.add(key); return back },
    forget(keys) { base.forget(keys); for (const key of keys) kept.delete(key) },
  }
  const registryPath = join(root, 'userData', 'shared-talk-registry.json')
  const changes = []
  const payload = (content) => ({ title: 'T', html: `<html>${content}</html>`, slides: [{ slideId: 'one', title: 'One', text: content }] })
  const make = () => createSharedTalks({
    registryPath, ownerTokens,
    endpoint: async () => { await at('endpoint'); return { baseUrl: 'http://worker.test', adminSecret: ADMIN } },
    linkBase: () => '',
    identityOf: (p) => ({ key: `id:${p}#${inode}`, realPath: p }),
    slugOf: () => 'talk',
    readOutline: async () => outline,
    peekOutline: () => outline,
    build: options.build ? (input) => options.build(input, at, payload) : async ({ content }) => { await at('build'); return payload(content) },
    stampShareUrl,
    qrSvg: async (url) => { await at('qr'); return `<svg data-url="${url}"></svg>` },
    fetch: fetchImpl,
    onChange: (key, state, previousKey) => changes.push({ key, state, previousKey }),
    saveDebounceMs: 20,
  })
  const talks = make()
  const link = (shareId) => `http://worker.test/shares/${shareId}`
  const posts = () => worker.calls.filter((c) => c.method === 'POST' && c.route === '/shares').length
  const closes = () => worker.calls.filter((c) => c.route.endsWith('/close')).map((c) => c.route.split('/')[2])
  const made = () => [...worker.shares.keys()]
  /** `instances`: the module instances whose shares are compared (another instance, a restart). */
  async function check(label, { instances = [talks] } = {}) {
    for (const instance of instances) await within(instance.idle(), 3000, `${label}: idle()`)
    await tail
    const open = [...worker.shares].filter(([, share]) => !share.closed).map(([id]) => id).sort()
    const rows = existsSync(registryPath) ? Object.values(JSON.parse(readFileSync(registryPath, 'utf8')).shares ?? {}).map((row) => row.shareId).sort() : []
    const tokens = [...kept].map((key) => key.match(/^share:([^@]+)@/)[1]).sort()
    assert.deepEqual(rows, open, `${label}: no registered row for a closed share, no open share without a row`)
    assert.deepEqual(tokens, open, `${label}: a token is kept for every open share and for no other`)
    for (const id of open) assert.ok(base.get(`share:${id}@http://worker.test`), `${label}: the open share's token reads back`)
    assert.deepEqual(instances.flatMap((instance) => instance.list().map((s) => s.shareId)).sort(), open, `${label}: the module holds exactly the open shares`)
    assert.ok(open.length <= 1, `${label}: one open share per talk`)
    assert.equal(shareUrlIn(outline), open.length ? link(open[0]) : null, `${label}: share_url is the open share's link, or absent`)
  }
  return {
    worker, talks, make, path, hold, check, link, posts, closes, made, changes, userData: join(root, 'userData'),
    shareUrl: () => shareUrlIn(outline),
    replaceOutline: () => { inode += 1 },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}
const isStopped = (result) => result?.stopped === true

const t12cases = [
  ['12.1: Share pending, then Stop — never created when Stop comes before the POST; closed when it comes during the reply', async () => {
    const h = t12harness()
    const endpoint = h.hold('endpoint')
    const sharing = h.talks.share(h.path, 'T')
    await endpoint.reached
    const stopping = h.talks.stop(h.path)
    endpoint.open()
    assert.deepEqual(await within(sharing, 3000, 'share'), { stopped: true, shareId: null }, 'stopped before the POST: stopped, nothing made')
    assert.deepEqual(await within(stopping, 3000, 'stop'), { serverClosed: true, message: null })
    assert.equal(h.posts(), 0, 'no POST was sent')
    await h.check('12.1 before the POST')

    const post = h.hold('post')
    const sharing2 = h.talks.share(h.path, 'T')
    await post.reached
    const stopping2 = h.talks.stop(h.path)
    post.open()
    const [shared, stopped] = await within(Promise.all([sharing2, stopping2]), 3000, 'share and stop')
    const [madeId] = h.made()
    assert.deepEqual(shared, { stopped: true, shareId: madeId }, 'stopped during the reply: stopped, naming the share it made')
    assert.deepEqual(stopped, { serverClosed: true, message: null })
    assert.deepEqual(h.closes(), [madeId], 'the share is closed on the service once it exists')
    await h.check('12.1 during the reply')
    h.cleanup()
  }],
  ['12.2: Share, Stop, Share within one round trip — the last Share gets a new link, the first is stopped', async () => {
    const h = t12harness()
    const post = h.hold('post')
    const first = h.talks.share(h.path, 'T')
    await post.reached
    const stopping = h.talks.stop(h.path)
    const second = h.talks.share(h.path, 'T')
    post.open()
    const [a, stop, b] = await within(Promise.all([first, stopping, second]), 3000, 'share, stop, share')
    const [idA, idB] = h.made()
    assert.ok(idA && idB && idA !== idB, 'two shares were made')
    assert.deepEqual(a, { stopped: true, shareId: idA })
    assert.equal(stop.serverClosed, true)
    assert.equal(isStopped(b), false, 'the last Share is not stopped')
    assert.equal(b.shareId, idB, 'the last Share returns the new share')
    assert.equal(b.url, h.link(idB))
    assert.equal(h.worker.shares.get(idA).closed, true)
    assert.equal(h.worker.shares.get(idB).closed, false)
    await h.check('12.2')
    h.cleanup()
  }],
  ['12.3: Stop while the first build never finishes — Stop sends the close and returns; the next Share works', async () => {
    const h = t12harness()
    const build = h.hold('build') // never opened while the case runs
    const sharing = h.talks.share(h.path, 'T')
    await build.reached
    const result = await within(h.talks.stop(h.path), 3000, 'stop while the build hangs')
    assert.equal(result.serverClosed, true)
    const [idA] = h.made()
    assert.deepEqual(h.closes(), [idA], 'the close was sent')
    assert.deepEqual(await within(sharing, 3000, 'the stopped share'), { stopped: true, shareId: idA })
    const again = await within(h.talks.share(h.path, 'T'), 3000, 'a further share')
    assert.equal(isStopped(again), false)
    assert.notEqual(again.shareId, idA)
    assert.equal(again.revision, 1, 'its first push ran: nothing is wedged')
    build.open()
    await h.check('12.3')
    h.cleanup()
  }],
  ['12.4: the outline is replaced on disk while a Share is pending — Stop still reaches it', async () => {
    const h = t12harness()
    const post = h.hold('post')
    const sharing = h.talks.share(h.path, 'T')
    await post.reached
    h.replaceOutline() // a new inode: the identity key changes, the real path does not
    const stopping = h.talks.stop(h.path)
    post.open()
    const [shared, stopped] = await within(Promise.all([sharing, stopping]), 3000, 'share and stop')
    const [idA] = h.made()
    assert.deepEqual(shared, { stopped: true, shareId: idA })
    assert.equal(stopped.serverClosed, true)
    assert.equal(h.worker.shares.get(idA).closed, true, 'the pending share was closed')
    assert.equal(await h.talks.status(h.path), null, 'no row')
    await h.check('12.4')
    h.cleanup()
  }],
  ['12.5: a stopped Share\'s tidy-up never removes the newer share\'s share_url line', async () => {
    const h = t12harness()
    const qrA = h.hold('qr')
    const first = h.talks.share(h.path, 'T')
    await qrA.reached
    await within(h.talks.stop(h.path), 3000, 'stop A')
    const qrB = h.hold('qr')
    const second = h.talks.share(h.path, 'T')
    await qrB.reached
    qrB.open()
    qrA.open()
    const [a, b] = await within(Promise.all([first, second]), 3000, 'both shares')
    const [idA, idB] = h.made()
    assert.deepEqual(a, { stopped: true, shareId: idA })
    assert.equal(b.shareId, idB)
    await h.check('12.5 B live') // share_url is B's
    await within(h.talks.stop(h.path), 3000, 'stop B')
    await h.check('12.5 B stopped') // share_url absent
    h.cleanup()
  }],
  ['12.6: a replacement share stopped while its QR code is made is reported stopped, never as a link', async () => {
    const h = t12harness()
    const qrA = h.hold('qr')
    const first = h.talks.share(h.path, 'T')
    await qrA.reached
    await within(h.talks.stop(h.path), 3000, 'stop A')
    const qrB = h.hold('qr')
    const second = h.talks.share(h.path, 'T')
    await qrB.reached
    qrA.open()
    const a = await within(first, 3000, 'share A')
    await within(h.talks.stop(h.path), 3000, 'stop B')
    qrB.open()
    const b = await within(second, 3000, 'share B')
    const [idA, idB] = h.made()
    assert.deepEqual(a, { stopped: true, shareId: idA }, 'A: stopped, not B\'s state')
    assert.deepEqual(b, { stopped: true, shareId: idB }, 'B: stopped, no closed link')
    assert.equal(h.worker.shares.get(idA).closed && h.worker.shares.get(idB).closed, true, 'both closed')
    await h.check('12.6')
    h.cleanup()
  }],
  ['12.7: the share sheet follows the talk — every cell of the reducer table; never left creating or stopping', async () => {
    const S1 = { key: 'k', slug: 's', outlinePath: '/p', realPath: '/p', shareId: 'k7m2abcd', url: 'https://w.test/shares/k7m2abcd', localOnly: false, revision: 1, liveUpdates: true, proposals: true, createdAt: '', lastPushedAt: null, pushing: false, lastError: null, qrSvg: '' }
    const S2 = { ...S1, revision: 4 }
    const base = initialShareSheet()
    const states = {
      loading: base,
      'confirm-replace': shareSheetReducer(base, { type: 'inspected', share: null, foreignShareUrl: 'https://other/zz99zz99' }),
      creating: { ...base, phase: 'creating' },
      ready: { ...base, phase: 'ready', share: S1 },
      stopping: { ...base, phase: 'stopping', share: S1 },
      error: { ...base, phase: 'error', error: 'Could not share this talk.' },
      stopped: { ...base, phase: 'stopped' },
    }
    const events = {
      'changed(share)': { type: 'changed', share: S2 },
      'changed(null)': { type: 'changed', share: null },
      'share-stopped': { type: 'share-stopped', shareId: S1.shareId },
      created: { type: 'created', share: S1 },
      failed: { type: 'failed', error: 'boom' },
      creating: { type: 'creating' },
      stopping: { type: 'stopping' },
    }
    const U = 'unchanged'
    // Rows: events; columns: loading, confirm-replace, creating, ready, stopping, error, stopped.
    const table = {
      'changed(share)': [U, U, 'ready', 'ready', 'stopping', 'ready', 'ready'],
      'changed(null)': [U, U, 'stopped', 'stopped', 'stopped', U, U],
      'share-stopped': [U, U, 'stopped', 'stopped', U, 'stopped', U],
      created: ['ready', 'ready', 'ready', 'ready', U, 'ready', 'ready'],
      failed: ['error', 'error', 'error', 'ready', 'ready', 'error', 'stopped'],
      creating: Array(7).fill('creating'),
      stopping: Array(7).fill('stopping'),
    }
    const columns = Object.keys(states)
    for (const [eventName, row] of Object.entries(table)) {
      row.forEach((expected, index) => {
        const from = states[columns[index]]
        const next = shareSheetReducer(from, events[eventName])
        const cell = `${eventName} in ${columns[index]}`
        if (expected === U) assert.deepEqual(next, from, `${cell}: unchanged`)
        else assert.equal(next.phase, expected, cell)
        const view = shareSheetView(next)
        if (next.phase === 'stopped') {
          assert.equal(view.link, '', `${cell}: no closed link`)
          assert.equal(view.canCopy || view.canStop || view.switchesEnabled, false, `${cell}: only Done active`)
        }
      })
    }
    // The cells with more than a phase.
    assert.equal(shareSheetReducer(states.stopping, events['changed(share)']).share, S2, 'stopping: the share updated')
    assert.equal(shareSheetReducer(states.ready, events.failed).error, 'boom', 'ready + error line')
    const stopFailed = shareSheetReducer(states.stopping, events.failed)
    assert.equal(stopFailed.error, 'boom', 'a failed Stop shows its error')
    assert.equal(shareSheetView(stopFailed).canStop && shareSheetView(stopFailed).switchesEnabled, true, 'and re-enables the controls')
    assert.equal(shareSheetReducer(states.stopped, events.failed).error, 'boom', 'stopped + error line')
    assert.deepEqual(shareSheetReducer(states.ready, { type: 'share-stopped', shareId: 'zz99zz99' }), states.ready, 'a stopped reply for another share is ignored: the sheet follows the newer share')
    const stoppedView = shareSheetView(shareSheetReducer(states.creating, events['changed(null)']))
    assert.equal(stoppedView.status, 'This talk is no longer shared.')
    assert.equal(stoppedView.statusTone, 'quiet', 'no error line for a Stop the person asked for')
    // At rest after the reply to the request in flight, the phase is never creating or stopping.
    for (const reply of [events.created, events.failed, events['share-stopped'], { type: 'share-stopped', shareId: null }]) {
      assert.ok(!['creating', 'stopping'].includes(shareSheetReducer(states.creating, reply).phase), `creating + ${reply.type}`)
    }
    assert.ok(!['creating', 'stopping'].includes(shareSheetReducer(states.stopping, events.failed).phase), 'stopping + a failed Stop')
    // The sheet's Share pending, another window's Stop: the broadcast, then the stopped reply.
    let m = shareSheetReducer(states.creating, { type: 'changed', share: S1 })
    assert.equal(m.phase, 'ready', 'the broadcast of the registered share makes Stop available while the first push runs')
    m = shareSheetReducer(m, events['changed(null)'])
    m = shareSheetReducer(m, events['share-stopped'])
    assert.equal(m.phase, 'stopped')
    assert.equal(m.error, null)
  }],
  // ── Round 2 (the review of 0a3840d5): one case per finding, each the review's reproduced sequence.
  ['12.8 (finding 1): an Update reply after another window\'s Stop is stopped, and the sheet never revives the closed share', async () => {
    const h = t12harness()
    const a = await within(h.talks.share(h.path, 'T'), 3000, 'share A')
    await h.talks.setOptions(h.path, { liveUpdates: false })
    const build = h.hold('build')
    const updating = h.talks.update(h.path)
    await build.reached
    await within(h.talks.stop(h.path), 3000, 'stop from another window')
    const reply = await within(updating, 3000, 'the Update reply')
    assert.deepEqual(reply, { stopped: true, shareId: a.shareId }, 'the Update reply is stopped, never the closed share\'s state')
    // The sheet: the null broadcast, then the reply as ShareSheet dispatches it.
    let m = { ...initialShareSheet(), phase: 'ready', share: a }
    m = shareSheetReducer(m, { type: 'changed', share: null })
    m = shareSheetReducer(m, isStopped(reply) ? { type: 'share-stopped', shareId: reply.shareId } : { type: 'changed', share: reply })
    assert.equal(m.phase, 'stopped')
    assert.equal(shareSheetView(m).canCopy, false, 'Copy stays off')
    // The reducer on its own: a message carrying the share already reported gone never revives it.
    const late = shareSheetReducer(m, { type: 'changed', share: a })
    assert.equal(late.phase, 'stopped', 'a late changed(share) for the gone share is ignored')
    assert.equal(shareSheetView(late).canCopy, false)
    const newer = shareSheetReducer(late, { type: 'changed', share: { ...a, shareId: 'zz88zz88', url: h.link('zz88zz88') } })
    assert.equal(newer.phase, 'ready', 'a newer share is still followed')
    build.open()
    await h.check('12.8')
    h.cleanup()
  }],
  ['12.9 (finding 2): an inspect reply held behind its QR code, overtaken by a Stop, is stopped', async () => {
    const h = t12harness()
    const a = await within(h.talks.share(h.path, 'T'), 3000, 'share A')
    const app = h.make() // a restarted app: no QR code cached yet
    const qr = h.hold('qr')
    const looking = app.inspect(h.path)
    await qr.reached
    await within(app.stop(h.path), 3000, 'stop elsewhere')
    qr.open()
    const seen = await within(looking, 3000, 'inspect')
    assert.equal(seen.share, null, 'no closed share in the inspect reply')
    assert.deepEqual(seen.stopped, { shareId: a.shareId })
    const m = shareSheetReducer(initialShareSheet(), { type: 'inspected', ...seen })
    assert.equal(m.phase, 'stopped', 'the sheet says the talk is no longer shared (and does not share it again)')
    assert.equal(shareSheetView(m).canCopy, false)
    await h.check('12.9', { instances: [app] })
    h.cleanup()
  }],
  ['12.10 (finding 3, round 3): a held compile in the real one-at-a-time gate — Stop returns at once; the gate stays held until the compile settles, then the next Share completes; no two gated tasks overlap', async () => {
    const flight = createSingleFlight()
    let active = 0
    let most = 0
    const inGate = async (work) => { active += 1; most = Math.max(most, active); try { return await work() } finally { active -= 1 } }
    const h = t12harness({ build: (input, at, payload) => buildInGate(flight, input.signal, () => inGate(async () => { await at('build'); return payload(input.content) })) })
    const build = h.hold('build')
    const sharing = h.talks.share(h.path, 'T')
    await build.reached
    await within(h.talks.stop(h.path), 3000, 'stop while the compile is held')
    const [idA] = h.made()
    assert.deepEqual(await within(sharing, 3000, 'the stopped share'), { stopped: true, shareId: idA }, 'Stop never waits for the build')
    // Behind the held compile: the next Share's first build and any other compiler work wait.
    const sharingB = h.talks.share(h.path, 'T')
    const other = flight(() => inGate(async () => 'other'))
    const early = await Promise.race([sharingB.then(() => 'settled'), other.then(() => 'settled'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 150))])
    assert.equal(early, 'waiting', 'the gate is still held by the aborted compile: nothing else compiles meanwhile')
    assert.equal(active, 1, 'only the held compile is in the gate')
    build.open()
    const b = await within(sharingB, 3000, 'Share B after the compile settles')
    assert.equal(isStopped(b), false)
    assert.equal(b.revision, 1, 'B\'s first build ran through the gate once it was free')
    assert.equal(await within(other, 3000, 'other compiler work'), 'other')
    assert.equal(most, 1, 'no two gated tasks ever ran at once')
    await h.check('12.10')
    h.cleanup()
  }],
  ['12.11 (finding 4): a failed Stop during the first QR code, then Share — the live share has its share_url', async () => {
    const h = t12harness()
    const qr = h.hold('qr')
    const first = h.talks.share(h.path, 'T')
    await qr.reached
    h.worker.knobs.failNextClose = 1
    await assert.rejects(within(h.talks.stop(h.path), 3000, 'the failing stop'), /Could not stop sharing/)
    qr.open()
    const a = await within(first, 3000, 'share A')
    assert.equal(isStopped(a), false, 'the Stop failed: the link is open')
    const again = await within(h.talks.share(h.path, 'T'), 3000, 'share again')
    assert.equal(again.shareId, a.shareId)
    assert.equal(again.revision, 1)
    assert.equal(h.shareUrl(), h.link(a.shareId), 'share_url written')
    await h.check('12.11')
    h.cleanup()
  }],
  ['12.12 (finding 5): the registry changes under a create — nothing registered elsewhere is closed before the POST; after it, only this create\'s own share is closed; an ended row is never offered', async () => {
    const h = t12harness()
    const other = h.make()
    const endpoint = h.hold('endpoint')
    const sharingA = h.talks.share(h.path, 'T')
    await endpoint.reached
    const b = await within(other.share(h.path, 'T'), 3000, 'share B from the other instance')
    endpoint.open()
    const refusedA = await within(sharingA.then(() => null, (error) => error), 3000, 'share A')
    assert.equal(h.worker.shares.get(b.shareId).closed, false, 'B, registered by the other instance, stays open')
    assert.equal(h.posts(), 1, 'A sent no POST: the expectation is checked before it')
    assert.match(refusedA?.message ?? '', /shared from elsewhere on this computer/)
    await h.check('12.12 before the POST', { instances: [h.talks, other] })

    // The refusal after the POST (a row written for the talk while C's POST was on its way): C's
    // own share is closed again and C fails; nothing else is touched (round 3: no rival clean-up —
    // two TalkWeavers on one user-data folder are ruled out by the instance lock in index.ts).
    const h2 = t12harness()
    const other2 = h2.make()
    const prepost = h2.hold('prepost')
    const sharingC = h2.talks.share(h2.path, 'T')
    await prepost.reached
    const d = await within(other2.share(h2.path, 'T'), 3000, 'share D from the other writer')
    prepost.open()
    await assert.rejects(within(sharingC, 3000, 'share C'), /could not be saved on this computer, so it was closed again/)
    const [, idC] = h2.made()
    assert.equal(h2.worker.shares.get(idC).closed, true, 'C\'s own share was closed again')
    assert.equal(h2.worker.shares.get(d.shareId).closed, true, 'C\'s create closed D on the service (the Worker replaces a slug\'s share)')
    const fileRows = () => Object.values(JSON.parse(readFileSync(join(h2.userData, 'shared-talk-registry.json'), 'utf8')).shares ?? {}).map((row) => row.shareId)
    assert.deepEqual(fileRows(), [d.shareId], 'D\'s row is untouched by C')
    // The owner socket then reports D stopped: from that moment D is gone — never offered again.
    other2.markEnded(d.shareId, 'stopped')
    assert.equal(await within(other2.status(h2.path), 3000, 'status of the ended share'), null, 'status offers no ended link')
    const seenD = await within(other2.inspect(h2.path), 3000, 'inspect of the ended share')
    assert.equal(seenD.share, null, 'inspect offers no ended link')
    assert.deepEqual(seenD.stopped, { shareId: d.shareId })
    assert.equal(shareSheetView(shareSheetReducer(initialShareSheet(), { type: 'inspected', ...seenD })).canCopy, false, 'Copy stays off')
    await h2.check('12.12 after the POST', { instances: [h2.talks, other2] })
    h.cleanup(); h2.cleanup()
  }],
  ['12.13 (finding 6): a Stop whose reply was lost — the next Share and the next inspect never return the closed link', async () => {
    const h = t12harness()
    const a = await within(h.talks.share(h.path, 'T'), 3000, 'share A')
    h.worker.knobs.loseCloseReply = true
    await assert.rejects(within(h.talks.stop(h.path), 3000, 'stop A'), /Could not stop sharing/)
    assert.equal(h.worker.shares.get(a.shareId).closed, true, 'the Worker closed A')
    const b = await within(h.talks.share(h.path, 'T'), 3000, 'share again')
    assert.equal(isStopped(b), false)
    assert.notEqual(b.shareId, a.shareId, 'a new share, never A\'s closed link')
    await h.check('12.13 share')
    h.worker.knobs.loseCloseReply = true
    await assert.rejects(within(h.talks.stop(h.path), 3000, 'stop B'), /Could not stop sharing/)
    // Round 3: the service cannot be reached to check — inspect, status and Share fail, never the link.
    h.worker.knobs.offline = true
    await assert.rejects(within(h.talks.inspect(h.path), 3000, 'inspect offline'), (error) => error.message === SHARE_UNVERIFIED, 'inspect: SHARE_UNVERIFIED')
    await assert.rejects(within(h.talks.status(h.path), 3000, 'status offline'), (error) => error.message === SHARE_UNVERIFIED, 'status: SHARE_UNVERIFIED')
    await assert.rejects(within(h.talks.share(h.path, 'T'), 3000, 'share offline'), (error) => error.message === SHARE_UNVERIFIED, 'Share: SHARE_UNVERIFIED')
    h.worker.knobs.offline = false
    const seen = await within(h.talks.inspect(h.path), 3000, 'inspect')
    assert.equal(seen.share, null, 'inspect does not offer B\'s closed link')
    assert.deepEqual(seen.stopped, { shareId: b.shareId })
    await h.check('12.13 inspect')
    h.cleanup()
  }],
  ['12.14 (finding 7): the registry cannot be written after a close — Stop says so, and a restart never loads the closed share', async () => {
    const h = t12harness()
    const a = await within(h.talks.share(h.path, 'T'), 3000, 'share A')
    chmodSync(h.userData, 0o500)
    let failure = null
    try { await within(h.talks.stop(h.path), 3000, 'stop A') } catch (error) { failure = error } finally { chmodSync(h.userData, 0o700) }
    assert.equal(h.worker.shares.get(a.shareId).closed, true)
    const restarted = h.make()
    assert.equal(await restarted.status(h.path), null, 'a restart does not load the closed share as live')
    assert.ok(failure, 'Stop reports the failure')
    assert.match(failure.message, /Sharing has stopped: the share is closed on the sharing service and the link no longer opens, but this computer could not remove its record/)
    assert.equal(await h.talks.status(h.path), null, 'this run offers no link for it either')
    assert.equal(h.shareUrl(), null, 'the closed link left the outline')
    await within(h.talks.stop(h.path), 3000, 'stop again')
    await h.check('12.14', { instances: [h.talks, restarted] })
    h.cleanup()
  }],
  ['12.15 (finding 8): the app quits while the create reply is awaited — no admin call; the leftover is reported, and the next Share replaces it', async () => {
    const h = t12harness()
    const post = h.hold('post') // the Worker made the share; its reply never reaches this run
    void h.talks.share(h.path, 'T').catch(() => {})
    await post.reached
    const pendingAtQuit = h.talks.createsPending()
    const started = Date.now()
    await within(Promise.resolve(h.talks.drainCreates(200)), 1000, 'the bounded wait at quit')
    assert.ok(Date.now() - started < 1000, 'quit waits a bounded time')
    assert.equal(pendingAtQuit, true, 'quit saw the create under way')
    const [orphan] = h.made()
    const noted = () => readdirSync(h.userData).includes('shared-talk-pending-creates.json')
    assert.ok(noted(), 'the create was noted before the POST')

    const restarted = h.make()
    const reported = restarted.interruptedCreates()
    assert.equal(reported.length, 1, 'the leftover is reported at start')
    assert.equal(reported[0].outlinePath, h.path)
    assert.equal(reported[0].message, 'A share for “T” may still be open on the sharing service; it will be replaced the next time you share this talk.')
    const seen = await within(restarted.inspect(h.path), 3000, 'inspect after restart')
    assert.equal(seen.share, null)
    assert.equal(seen.interruptedShare, reported[0].message, 'the sheet\'s look reports it')
    const sheet = shareSheetReducer(initialShareSheet(), { type: 'inspected', ...seen })
    assert.equal(sheet.phase, 'confirm-replace', 'the sheet asks before sharing')
    assert.equal(shareSheetView(sheet).replaceWarning, reported[0].message)
    await assert.rejects(within(restarted.stop(h.path), 3000, 'stop after restart'), /may still be open on the sharing service/, 'Stop never says stopped while it may stand')
    assert.equal(h.worker.shares.get(orphan).closed, false, 'nothing closed it from the app')
    assert.ok(noted(), 'the note stays until the talk is next shared')

    const b = await within(restarted.share(h.path, 'T'), 3000, 'the next Share')
    assert.equal(isStopped(b), false)
    assert.notEqual(b.shareId, orphan)
    assert.equal(h.worker.shares.get(orphan).closed, true, 'the old share ends closed: the Worker\'s create replaced it')
    assert.equal(noted(), false, 'the next Share cleared the note')
    assert.deepEqual(restarted.interruptedCreates(), [])
    assert.equal((await within(restarted.inspect(h.path), 3000, 'inspect after the Share')).interruptedShare, undefined)
    const admin = h.worker.calls.filter((c) => c.auth === `Bearer ${ADMIN}` && !(c.method === 'POST' && c.route === '/shares'))
    assert.deepEqual(admin, [], 'no admin call but the creates')
    assert.equal(h.worker.calls.filter((c) => c.route.startsWith('/shares/by-talk/')).length, 0, 'no lookup by slug')
    await h.check('12.15', { instances: [restarted] })
    h.cleanup()
  }],
  ['12.16 (round 3): a share the owner socket reports ended is gone — no reply offers its link, and the next Share makes a new one', async () => {
    const h = t12harness()
    const a = await within(h.talks.share(h.path, 'T'), 3000, 'share A')
    h.worker.shares.get(a.shareId).closed = true // stopped from elsewhere
    h.talks.markEnded(a.shareId, 'stopped')
    assert.equal(await within(h.talks.status(h.path), 3000, 'status'), null, 'status: no ended link')
    assert.deepEqual(await within(h.talks.update(h.path), 3000, 'update'), { stopped: true, shareId: a.shareId }, 'update: stopped')
    assert.deepEqual(await within(h.talks.setOptions(h.path, { proposals: false }), 3000, 'setOptions'), { stopped: true, shareId: a.shareId }, 'setOptions: stopped')
    const seen = await within(h.talks.inspect(h.path), 3000, 'inspect')
    assert.equal(seen.share, null, 'inspect: no ended link')
    assert.deepEqual(seen.stopped, { shareId: a.shareId })
    await h.check('12.16 ended') // the ended row was removed, its token forgotten, share_url gone
    const b = await within(h.talks.share(h.path, 'T'), 3000, 'share again')
    assert.equal(isStopped(b), false)
    assert.notEqual(b.shareId, a.shareId, 'a new share, never the ended link')
    await h.check('12.16 shared again')
    // An ended row the next Share meets first (no look in between) is replaced the same way.
    h.worker.shares.get(b.shareId).closed = true
    h.talks.markEnded(b.shareId, 'retired')
    const c = await within(h.talks.share(h.path, 'T'), 3000, 'share after an ended row')
    assert.equal(isStopped(c), false)
    assert.ok(c.shareId !== b.shareId && c.shareId !== a.shareId, 'Share replaced the ended row with a new share')
    await h.check('12.16 replaced')
    // [R*]: a Share whose new share is reported ended while its QR code is made returns stopped.
    h.worker.shares.get(c.shareId).closed = true
    h.talks.markEnded(c.shareId, 'stopped')
    const qr = h.hold('qr')
    const sharingE = h.talks.share(h.path, 'T')
    await qr.reached
    const idE = h.made().at(-1)
    h.worker.shares.get(idE).closed = true
    h.talks.markEnded(idE, 'stopped')
    qr.open()
    assert.deepEqual(await within(sharingE, 3000, 'share E'), { stopped: true, shareId: idE }, 'Share: stopped, never the ended link')
    assert.equal((await within(h.talks.inspect(h.path), 3000, 'inspect E')).share, null)
    await h.check('12.16 ended during the Share')
    h.cleanup()
  }],
  ['12.17 (round 4): a close whose reply was lost and the service unreachable — no reply path offers the closed link', async () => {
    const h = t12harness()
    const a = await within(h.talks.share(h.path, 'T'), 3000, 'share A')
    h.worker.knobs.loseCloseReply = true
    await assert.rejects(within(h.talks.stop(h.path), 3000, 'stop A'), /Could not stop sharing/)
    h.worker.knobs.offline = true
    const unverified = (error) => error.message === SHARE_UNVERIFIED
    await assert.rejects(within(h.talks.update(h.path), 3000, 'update offline'), unverified, 'update: SHARE_UNVERIFIED, never A\'s closed link')
    await assert.rejects(within(h.talks.setOptions(h.path, { proposals: false }), 3000, 'setOptions offline'), unverified, 'setOptions: SHARE_UNVERIFIED')
    h.worker.knobs.offline = false
    h.cleanup()
    // The same Stop while a Share, an inspect and a status are held at QR generation.
    const g = t12harness()
    const q1 = g.hold('qr'); const q2 = g.hold('qr'); const q3 = g.hold('qr')
    const sharing = g.talks.share(g.path, 'T')
    await q1.reached
    const inspecting = g.talks.inspect(g.path)
    const statusing = g.talks.status(g.path)
    await Promise.all([q2.reached, q3.reached])
    g.worker.knobs.loseCloseReply = true
    await assert.rejects(within(g.talks.stop(g.path), 3000, 'stop'), /Could not stop sharing/)
    g.worker.knobs.offline = true
    q1.open(); q2.open(); q3.open()
    const results = await within(Promise.allSettled([sharing, inspecting, statusing]), 3000, 'the held replies')
    for (const [i, name] of ['Share', 'inspect', 'status'].entries()) {
      assert.equal(results[i].status, 'rejected', `${name}: no closed link`)
      assert.equal(results[i].reason.message, SHARE_UNVERIFIED, `${name}: SHARE_UNVERIFIED`)
    }
    g.worker.knobs.offline = false
    g.cleanup()
  }],
]
const only = process.env.SHARED_TALK_CASE
for (const [name, run] of t12cases) {
  if (only && !name.startsWith(only)) continue
  await run()
  console.log(`PASS ${name}`)
}
