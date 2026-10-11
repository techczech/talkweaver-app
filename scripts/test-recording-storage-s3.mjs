// Recording storage against an S3 stand-in over real HTTP (spec "Cloudflare set-up in the app",
// D10 and "Upload recording"). The real storage module with the real S3 client, the real secrets
// store over memory, and the stand-in on this computer's loopback address. Made-up keys and a
// throwaway folder; no request leaves the machine.
// 1. Check reaches Ready, and reports "Bucket not found" and "Keys rejected" apart; it is one
//    read each time: a list of at most one object, never a write;
// 2. Check with no answer, an answer that is not a bucket, and a change of keys or settings while
//    one is under way;
// 3. Upload through the app's own handler (recording:upload): it goes up; and each failure is its
//    own word, with the local recording byte-for-byte as it was every time;
// 4. the keys went nowhere but the request's signature: none in a row, a reply, a printed line, an
//    error, an address or a file.
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createRecordingStorage } from '../src/main/recording-storage.ts'
import { UPLOAD_FAILURES, recordingRowDetail, recordingRowEdge, uploadFailureMessage } from '../src/shared/recording-storage-status.ts'
import { memorySecrets } from './lib/memory-secrets.mjs'
import { S3_REPLY_TEXT_MARK, startS3Stub } from './lib/s3-stub.mjs'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const scratch = mkdtempSync(join(tmpdir(), 'tw-recording-storage-'))
// Made up, and built so that no source file holds a whole value.
const fake = (name) => ['test', 'recording', 's3', name, '0123456789abcdef'].join('-')
const GOOD = { accessKeyId: fake('goodid'), secretAccessKey: fake('goodsecret') }
const READ_ONLY = { accessKeyId: fake('readonlyid'), secretAccessKey: fake('readonlysecret') }
const UNKNOWN = { accessKeyId: fake('unknownid'), secretAccessKey: fake('unknownsecret') }
const ALL_KEYS = [GOOD, READ_ONLY, UNKNOWN].flatMap((keys) => [keys.accessKeyId, keys.secretAccessKey])
const SECRETS = [GOOD, READ_ONLY, UNKNOWN].map((keys) => keys.secretAccessKey)
const observed = []
const printed = []
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  const real = console[level].bind(console)
  console[level] = (...parts) => { printed.push(parts.map((part) => (part instanceof Error ? `${part.stack}` : typeof part === 'string' ? part : JSON.stringify(part))).join(' ')); real(...parts) }
}
// Bucket names that must never be sent: the first two are the S3 Express shapes the S3 client
// moves into the host even with path-style addressing; the rest are not ordinary bucket names.
const UNSENDABLE_BUCKETS = [
  'demo--use1-az4--x-s3', 'demo--use1-az4--xa-s3', 'demo--op-s3', 'demo--table-s3', 'my-ap-0123456789-s3alias', 'abcdefghijklm.mrap',
  'arn:aws:s3:us-east-1:123456789012:accesspoint/myap', 'UPPER', 'under_score', 'a/b', 'a b', 'x@host.test', '..', '.talks', 'talks-', 'ab', 'a'.repeat(64),
]
const soon = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// The limit's timer is cleared once the answer is in, so a passed test ends at once.
const within = (promise, ms, what) => {
  let timer
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new assert.AssertionError({ message: `${what} did not finish within ${ms} ms` })), ms) })
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer))
}
const edge = (row) => recordingRowEdge(row).text

// An address on this computer where nothing listens: a port that was free a moment ago.
const closedEndpoint = await new Promise((resolve) => {
  const probe = createServer()
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(`http://127.0.0.1:${port}`)) })
})
const s3 = await startS3Stub({ buckets: ['talks'], keys: [GOOD.accessKeyId, READ_ONLY.accessKeyId], readOnly: [READ_ONLY.accessKeyId] })
assert.match(s3.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/, 'the stand-in is on this computer\'s loopback address')

function app({ keys = GOOD, bucket = 'talks', endpoint = s3.endpoint, checkTimeoutMs = 5000 } = {}) {
  const secrets = memorySecrets()
  const settings = { endpoint, bucket }
  const rows = []
  const storage = createRecordingStorage({
    secrets: secrets.store, settings: () => ({ ...settings }), checkTimeoutMs,
    onChange: (row) => { rows.push(row); observed.push(row) },
  })
  if (keys) observed.push(storage.saveKeys(keys))
  return { storage, secrets, settings, rows }
}
const see = (value) => { observed.push(value); return value }

try {
  // ── 1. Check: Ready, Bucket not found, Keys rejected ─────────────────────────────────────────
  {
    const t = app()
    assert.equal(edge(t.storage.status()), 'Keys saved, not checked')
    assert.equal(s3.requests.length, 0, 'saving keys asks nothing of the storage')
    const pending = t.storage.check()
    assert.equal(edge(t.storage.status()), 'Checking…', 'the row says a check is under way')
    const ready = see(await pending)
    assert.equal(edge(ready), 'Ready')
    assert.equal(recordingRowDetail(ready), 'Bucket talks · found. That the keys may upload is proven by the first upload.')
    assert.equal(t.rows.at(-1).state, 'ready', 'and the window is told')
    assert.equal(t.rows.at(-1).checking, false)
    // One request: a list of the bucket, for at most one object.
    assert.equal(s3.requests.length, 1)
    assert.equal(s3.requests[0].method, 'GET')
    assert.match(s3.requests[0].route, /^\/talks\/?$/)
    assert.match(s3.requests[0].search, /list-type=2/)
    assert.match(s3.requests[0].search, /max-keys=1(?:&|$)/)
    assert.equal(s3.requests[0].accessKeyId, GOOD.accessKeyId, 'signed with the keys from Settings')

    // Keys that may list but not write: Ready all the same. The check does not write to find out.
    const reader = app({ keys: READ_ONLY })
    assert.equal(edge(see(await reader.storage.check())), 'Ready')

    // A bucket the storage does not have.
    const before = s3.requests.length
    const missing = app({ bucket: 'no-such-bucket' })
    const notFound = see(await missing.storage.check())
    assert.equal(edge(notFound), 'Bucket not found')
    assert.equal(recordingRowDetail(notFound), 'No bucket named no-such-bucket at this endpoint')
    assert.equal(s3.requests.length, before + 1, 'one request, not tried again')

    // Keys the storage does not know.
    const stranger = app({ keys: UNKNOWN })
    const rejected = see(await stranger.storage.check())
    assert.equal(edge(rejected), 'Keys rejected')
    assert.notEqual(edge(rejected), edge(notFound), 'the two are told apart')
    // Unknown keys and a missing bucket together: the keys are what is said.
    assert.equal(edge(see(await app({ keys: UNKNOWN, bucket: 'no-such-bucket' }).storage.check())), 'Keys rejected')

    // Fixing what was wrong and pressing Check again reaches Ready.
    missing.settings.bucket = 'talks'
    missing.storage.settingsChanged()
    assert.equal(edge(missing.storage.status()), 'Keys saved, not checked', 'what was found was about the old bucket')
    assert.equal(edge(see(await missing.storage.check())), 'Ready')
    see(stranger.storage.saveKeys(GOOD))
    assert.equal(edge(stranger.storage.status()), 'Keys saved, not checked', 'what was found was about the old keys')
    assert.equal(edge(see(await stranger.storage.check())), 'Ready')
    // A bucket renamed in Settings without telling the module still does not keep the old finding.
    t.settings.bucket = 'elsewhere'
    assert.equal(edge(t.storage.status()), 'Keys saved, not checked')
    t.settings.bucket = 'talks'

    // A bucket name the S3 client would not send to the endpoint as typed (it puts an S3 Express
    // name, an access point or an ARN into the host, whatever it was told) or that is no ordinary
    // bucket name: refused here, before any request, as a bucket that is not at this endpoint.
    for (const name of UNSENDABLE_BUCKETS) {
      const asked = s3.requests.length
      const odd = app({ bucket: name })
      assert.equal(edge(odd.storage.status()), 'Keys saved, not checked')
      const refused = see(await within(odd.storage.check(), 8000, `a check of the bucket name ${name}`))
      assert.equal(edge(refused), 'Bucket not found', `Check refuses the bucket name ${name}`)
      assert.equal(recordingRowDetail(refused), `No bucket named ${name} at this endpoint`)
      assert.deepEqual(see(await within(odd.storage.upload('k', Buffer.from('x'), 'audio/webm'), 8000, `an upload to the bucket name ${name}`)), { ok: false, failure: 'bucket-not-found' }, `Upload refuses the bucket name ${name}`)
      assert.equal(s3.requests.length, asked, `nothing was sent for the bucket name ${name}`)
    }
    // Ordinary names, dots and hyphens included, go to the endpoint as typed.
    for (const name of ['abc', 'talks.2026-archive', `a${'b'.repeat(62)}`]) {
      const asked = s3.requests.length
      assert.equal(edge(see(await app({ bucket: name }).storage.check())), 'Bucket not found')
      assert.equal(s3.requests.length, asked + 1, `the bucket name ${name} was asked for`)
      assert.equal(s3.requests.at(-1).bucket, name)
    }

    // Every request of all these checks was a read, and nothing was stored.
    assert.ok(s3.requests.length >= 7)
    assert.deepEqual([...new Set(s3.requests.map((request) => request.method))], ['GET'], 'a check only ever lists')
    assert.equal(s3.requests.reduce((sum, request) => sum + request.bytes, 0), 0, 'and sends no body')
    assert.equal(s3.model.objects.size, 0)
    console.log('PASS 1: Check reaches Ready against the S3 stand-in and reports "Bucket not found" and "Keys rejected" apart; each check is one list request and writes nothing')
  }

  // ── 2. No answer, a wrong answer, and changes under way ──────────────────────────────────────
  {
    // Nothing listening at the address: the state stands, the row says it could not check.
    const closed = app({ endpoint: closedEndpoint })
    const refused = see(await within(closed.storage.check(), 8000, 'a check of a closed port'))
    assert.equal(refused.state, 'not-checked')
    assert.equal(recordingRowDetail(refused), 'Could not check (offline?)')

    // The storage never answers: the check gives up at its time limit.
    s3.model.hang = true
    const slow = app({ checkTimeoutMs: 300 })
    const started = Date.now()
    const gaveUp = see(await within(slow.storage.check(), 8000, 'a check the storage never answers'))
    assert.equal(recordingRowDetail(gaveUp), 'Could not check (offline?)')
    assert.equal(gaveUp.checking, false)
    assert.ok(Date.now() - started < 6000, 'it gives up at its time limit')
    s3.model.hang = false

    // A check that got no answer keeps what was known, and says it could not check.
    const known = app({ checkTimeoutMs: 300 })
    assert.equal(edge(see(await known.storage.check())), 'Ready')
    s3.model.hang = true
    const stale = see(await within(known.storage.check(), 8000, 'a second check the storage never answers'))
    s3.model.hang = false
    assert.equal(stale.state, 'ready')
    assert.equal(recordingRowDetail(stale), 'Could not check (offline?)')
    // The next check that is answered clears the sentence.
    assert.equal(recordingRowDetail(see(await known.storage.check())), 'Bucket talks · found. That the keys may upload is proven by the first upload.')

    // An address that answers 200 with a web page is not a bucket: never Ready.
    s3.model.answer = () => ({ status: 200, body: `<html><body>${S3_REPLY_TEXT_MARK}</body></html>`, type: 'text/html' })
    const page = see(await app().storage.check())
    assert.notEqual(page.state, 'ready')
    assert.equal(recordingRowDetail(page), 'The check could not be completed.')
    // A storage in trouble: not Ready, and not blamed on the keys or the bucket.
    s3.model.answer = () => ({ status: 500, body: `<Error><Code>InternalError</Code><Message>${S3_REPLY_TEXT_MARK}</Message></Error>` })
    const trouble = see(await app().storage.check())
    assert.equal(trouble.state, 'not-checked')
    assert.equal(recordingRowDetail(trouble), 'The check could not be completed.')
    // Valid keys signed for another region ("auto" is what this client signs for): the storage says
    // the header is malformed. New keys would not fix that, so the row does not say "Keys rejected".
    for (const status of [400, 403]) {
      s3.model.answer = () => ({ status, body: `<Error><Code>AuthorizationHeaderMalformed</Code><Message>${S3_REPLY_TEXT_MARK}</Message><Region>us-east-1</Region></Error>` })
      const region = see(await app().storage.check())
      assert.notEqual(edge(region), 'Keys rejected', `a wrong-region answer (${status}) is not "Keys rejected"`)
      assert.equal(region.state, 'not-checked')
      assert.equal(recordingRowDetail(region), 'The check could not be completed.')
    }
    s3.model.answer = null
    // An endpoint that is no address at all: no throw, not Ready.
    const nonsense = see(await app({ endpoint: 'not an address' }).storage.check())
    assert.equal(nonsense.state, 'not-checked')

    // Two presses of Check while one is under way are one request.
    const twice = app()
    const count = s3.requests.length
    const [first, second] = await Promise.all([twice.storage.check(), twice.storage.check()])
    assert.equal(s3.requests.length, count + 1)
    assert.deepEqual(see(first), see(second))

    // The keys are replaced while a check of the old ones is under way: its answer is dropped.
    s3.model.hang = true
    const swapped = app({ keys: UNKNOWN, checkTimeoutMs: 400 })
    const old = swapped.storage.check()
    await soon(80)
    see(swapped.storage.saveKeys(GOOD))
    assert.equal(swapped.storage.status().checking, false, 'the row no longer waits for the old question')
    see(await old)
    s3.model.hang = false
    assert.equal(edge(swapped.storage.status()), 'Keys saved, not checked', 'nothing is said about the new keys from an answer about the old ones')
    assert.equal(recordingRowDetail(swapped.storage.status()), 'Bucket talks')
    assert.equal(edge(see(await swapped.storage.check())), 'Ready')

    // Not set up: Check asks nothing.
    const asked = s3.requests.length
    assert.equal(edge(see(await app({ keys: null }).storage.check())), 'Not set up')
    assert.equal(edge(see(await app({ bucket: '' }).storage.check())), 'Not set up')
    assert.equal(edge(see(await app({ endpoint: '' }).storage.check())), 'Not set up')
    assert.equal(s3.requests.length, asked)
    assert.deepEqual([...new Set(s3.requests.map((request) => request.method))], ['GET'], 'still nothing but lists')
    console.log('PASS 2: a check with no answer ends at its time limit and says so; a page that is not a bucket is never Ready; an answer about replaced keys is dropped')
  }

  // ── 3. Upload, through the app's own handler ─────────────────────────────────────────────────
  {
    // The recording module as the main process loads it, with Electron stood in for (as in test-run-audio).
    const bundled = await build({
      entryPoints: [join(repo, 'src/main/recording.ts')], bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', logLevel: 'silent',
      plugins: [{ name: 'electron-test-boundary', setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'test' }))
        b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'module.exports = globalThis.__recordingStorageElectron', loader: 'js' }))
      } }],
    })
    const handlers = new Map()
    const trashed = []
    globalThis.__recordingStorageElectron = {
      ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
      BrowserWindow: { fromWebContents: () => null },
      shell: { trashItem: async (path) => { trashed.push(path) } },
      dialog: {},
    }
    const module = { exports: {} }
    new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)

    const vault = join(scratch, 'vault')
    const userData = join(scratch, 'userData')
    const talk = 'storage-probe'
    mkdirSync(join(vault, '_PRESENTATIONS', talk), { recursive: true })
    mkdirSync(join(userData, 'recordings'), { recursive: true })
    let current = app()
    module.exports.registerRecordingIpc({
      compilerDir: () => null, userDataDir: () => userData, vaultRoot: () => vault, discardThresholdMs: () => 20000,
      storage: () => current.storage, testMode: () => false,
    })
    const upload = async (sessionId) => see(await handlers.get('recording:upload')({ sender: { id: 1 } }, { talkSlug: talk, sessionId }))

    // One recording per case: its audio in the user-data folder, its Run in the vault.
    const audioBytes = (id) => Buffer.from(`made-up audio of ${id} `.repeat(200))
    const audioPath = (id) => join(userData, 'recordings', `${id}.webm`)
    const runPath = (id) => join(vault, '_PRESENTATIONS', talk, `${id}.json`)
    function record(id) {
      writeFileSync(audioPath(id), audioBytes(id))
      writeFileSync(runPath(id), JSON.stringify({ id, talkSlug: talk, kind: 'delivery', audio: { r2Key: `presentations/${talk}/${id}/audio.webm`, bytes: audioBytes(id).length, uploaded: false } }, null, 2))
      return { audio: readFileSync(audioPath(id)), run: readFileSync(runPath(id), 'utf8'), modified: statSync(audioPath(id)).mtimeMs }
    }
    const listing = () => [readdirSync(join(userData, 'recordings')).sort(), readdirSync(join(vault, '_PRESENTATIONS', talk)).sort()]
    /** The recording is where it was and what it was: same bytes, same Run, not marked uploaded, same files. */
    function untouched(id, before, files) {
      assert.ok(readFileSync(audioPath(id)).equals(before.audio), `${id}: the audio is byte-for-byte as it was`)
      assert.equal(statSync(audioPath(id)).mtimeMs, before.modified, `${id}: and was not written`)
      assert.equal(readFileSync(runPath(id), 'utf8'), before.run, `${id}: the Run is as it was`)
      assert.equal(JSON.parse(readFileSync(runPath(id), 'utf8')).audio.uploaded, false, `${id}: and is not marked uploaded`)
      assert.deepEqual(listing(), files, `${id}: no file was added, moved or removed`)
    }

    // It goes up: one put, the object is the audio, the Run is marked, the audio stays.
    const good = record('2026-10-01T120000-aaaa')
    const puts = () => s3.requests.filter((request) => request.method === 'PUT')
    assert.deepEqual(await upload('2026-10-01T120000-aaaa'), { ok: true, uploaded: true })
    assert.equal(puts().length, 1)
    assert.equal(puts()[0].route, `/talks/presentations/${talk}/2026-10-01T120000-aaaa/audio.webm`)
    assert.ok(s3.model.objects.get(`talks/presentations/${talk}/2026-10-01T120000-aaaa/audio.webm`).equals(good.audio), 'what went up is the recording')
    assert.equal(JSON.parse(readFileSync(runPath('2026-10-01T120000-aaaa'), 'utf8')).audio.uploaded, true)
    assert.ok(readFileSync(audioPath('2026-10-01T120000-aaaa')).equals(good.audio), 'the recording stays on this computer after it is uploaded')
    assert.equal(edge(current.storage.status()), 'Ready', 'an upload that was accepted says the storage is ready')
    // Asked again: already uploaded, nothing sent.
    assert.deepEqual(await upload('2026-10-01T120000-aaaa'), { ok: true, uploaded: true })
    assert.equal(puts().length, 1)

    // Each way it does not go through: its own word, its own sentence, and the recording untouched.
    const cases = [
      ['not-set-up', '2026-10-01T120100-bbbb', () => app({ keys: null })],
      ['not-set-up', '2026-10-01T120200-cccc', () => app({ bucket: '' })],
      ['not-set-up', '2026-10-01T120300-dddd', () => app({ endpoint: '' })],
      ['keys-rejected', '2026-10-01T120400-eeee', () => app({ keys: UNKNOWN })],
      // Keys that pass a check and may not write: found out by the upload, as the row says.
      ['keys-rejected', '2026-10-01T120500-ffff', () => app({ keys: READ_ONLY })],
      ['bucket-not-found', '2026-10-01T120600-gggg', () => app({ bucket: 'no-such-bucket' })],
      // A name the S3 client would send to another host: refused as a bucket that is not here.
      ['bucket-not-found', '2026-10-01T120650-llll', () => app({ bucket: UNSENDABLE_BUCKETS[0] })],
      ['offline', '2026-10-01T120700-hhhh', () => app({ endpoint: closedEndpoint })],
      ['failed', '2026-10-01T120800-iiii', () => { s3.model.answer = (request) => (request.method === 'PUT' ? { status: 400, body: `<Error><Code>MalformedXML</Code><Message>${S3_REPLY_TEXT_MARK}</Message></Error>` } : null); return app() }],
      // A wrong-region answer: the plain fallback, not the keys.
      ['failed', '2026-10-01T120850-kkkk', () => { s3.model.answer = () => ({ status: 403, body: `<Error><Code>AuthorizationHeaderMalformed</Code><Message>${S3_REPLY_TEXT_MARK}</Message></Error>` }); return app() }],
    ]
    const produced = new Set()
    for (const [failure, id, make] of cases) {
      const before = record(id)
      const files = listing()
      current = make()
      const stored = s3.model.objects.size
      const reply = await within(upload(id), 20_000, `the upload sorted as ${failure}`)
      s3.model.answer = null
      assert.deepEqual(reply, { ok: false, error: failure })
      assert.ok(uploadFailureMessage(reply.error).endsWith('The recording is safe on this computer.'))
      untouched(id, before, files)
      assert.equal(s3.model.objects.size, stored, `${failure}: nothing was stored`)
      produced.add(failure)
    }
    // audio-missing is a local reason (the audio file is not on disk), never an S3 answer: the
    // handler reaches the five storage kinds only.
    const fromStorage = UPLOAD_FAILURES.filter((kind) => kind !== 'audio-missing')
    assert.deepEqual([...produced].sort(), fromStorage.sort(), 'every storage kind was reached through the handler')
    assert.equal(new Set([...produced].map((failure) => uploadFailureMessage(failure))).size, fromStorage.length, 'each with its own sentence')
    // A refused upload turns the row, as a refused check would.
    current = app({ keys: READ_ONLY })
    assert.equal(edge(see(await current.storage.check())), 'Ready')
    const before = record('2026-10-01T120900-jjjj')
    const files = listing()
    assert.deepEqual(await upload('2026-10-01T120900-jjjj'), { ok: false, error: 'keys-rejected' })
    assert.equal(edge(current.storage.status()), 'Keys rejected')
    untouched('2026-10-01T120900-jjjj', before, files)
    // The same recording goes up once the keys are right: nothing about the failure was kept.
    current = app()
    assert.deepEqual(await upload('2026-10-01T120900-jjjj'), { ok: true, uploaded: true })
    assert.ok(readFileSync(audioPath('2026-10-01T120900-jjjj')).equals(before.audio))

    // A name that is not a recording's: refused before anything is read or sent.
    const sent = s3.requests.length
    const unsafe = await upload('../../outside')
    assert.equal(unsafe.ok, false)
    assert.equal(s3.requests.length, sent)
    assert.deepEqual(trashed, [], 'no upload, accepted or refused, put anything in the Trash')
    console.log(`PASS 3: an upload goes up through recording:upload; ${cases.length} refused or failed uploads are sorted to ${produced.size} words and leave the recording byte-for-byte as it was`)
  }

  // ── 4. Where the keys went ───────────────────────────────────────────────────────────────────
  {
    const everything = JSON.stringify(observed)
    for (const key of ALL_KEYS) {
      assert.ok(!everything.includes(key), 'no key in any row or reply')
      assert.ok(!printed.some((line) => line.includes(key)), 'no key in any printed line')
    }
    assert.ok(!everything.includes(S3_REPLY_TEXT_MARK), 'and no text of a reply from the storage')
    assert.ok(!printed.some((line) => line.includes(S3_REPLY_TEXT_MARK)))
    assert.ok(observed.length > 60)
    for (const request of s3.requests) {
      assert.ok(!ALL_KEYS.some((key) => `${request.route}${request.search}`.includes(key)), 'a key is never part of an address')
      // The secret access key signs; it is never sent, in any header.
      assert.ok(!SECRETS.some((secret) => JSON.stringify(request.headers).includes(secret)), 'the secret access key is never sent')
    }
    // Every request this file caused went to the host typed as the endpoint, whatever the bucket was.
    const endpointHost = new URL(s3.endpoint).host
    for (const request of s3.requests) assert.equal(request.headers.host, endpointHost, 'a signed request goes only to the host entered as the endpoint')
    assert.ok(s3.requests.filter((request) => request.accessKeyId === GOOD.accessKeyId).length > 5, 'the access key id travelled in the Authorization header')
    assert.deepEqual(s3.unknown, [], 'and nothing was asked that the stand-in does not model: only lists and puts')
    // Nothing in the throwaway folder (the Runs, the recordings) holds a key.
    const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]))
    for (const file of files(scratch)) {
      const bytes = readFileSync(file)
      assert.ok(!ALL_KEYS.some((key) => bytes.includes(Buffer.from(key))), 'no key in any file')
    }
    // The stand-in is strict: a call it does not model is refused and recorded, never a quiet success.
    const stray = await fetch(`${s3.endpoint}/talks?uploads`, { method: 'POST' })
    assert.equal(stray.status, 400)
    assert.deepEqual(s3.unknown, ['POST /talks?uploads'])
    console.log(`PASS 4: ${observed.length} rows and replies and ${printed.length} printed lines hold no key and no reply text; ${s3.requests.length} requests carried only the access key id, in the header`)
  }
} finally {
  await s3.close()
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
}
console.log('recording storage against the S3 stand-in: Check to Ready, bucket not found, keys rejected, uploads sorted, the recording never touched — passed')
