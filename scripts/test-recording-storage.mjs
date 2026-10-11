// Recording storage (src/main/recording-storage.ts, src/shared/recording-storage-status.ts; spec
// "Cloudflare set-up in the app", D10, the "Recording storage" row, "Upload recording" and
// "Migration"), with no network at all: the real secrets store over memory, made-up keys.
// 1. the row-state function: every state of the spec's row, in the spec's words;
// 2. the upload failure sorter: not set up / keys rejected / bucket not found / offline / anything
//    else / audio missing, and that every sentence but audio missing's says the recording is safe on
//    this computer;
// 3. the credential resolver has one source, Settings: keys are saved, replaced and cleared through
//    the secrets module; a refused save writes nothing and says a fixed sentence;
// 4. a former Bitwarden set-up yields "Recording storage: enter your access keys" once and its two
//    config keys are dropped; a set-up that typed its keys is unaffected and keeps them;
// 5. no key in any row, reply, error or printed line;
// 6. no other source of recording keys is left in the app, and one module holds the slot.
import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  KEYS_NOT_SAVED_ERROR, KEYS_SHAPE_ERROR, RETIRED_RECORDING_CONFIG_KEYS, createRecordingStorage, retireRecordingConfig,
} from '../src/main/recording-storage.ts'
import {
  RECORDING_KEYS_NOTICE, RECORDING_ROW_NAME, SET_UP_RECORDING_STORAGE, UPLOAD_FAILURES, recordingRowCanCheck, recordingRowDetail,
  recordingRowEdge, recordingStorageRow, sortUploadFailure, uploadFailureAction, uploadFailureMessage,
} from '../src/shared/recording-storage-status.ts'
import { TOKEN_PERMISSIONS } from '../src/shared/cloudflare-status.ts'
import { secretsFailureMessage } from '../src/main/secrets-store.ts'
import { memorySecrets } from './lib/memory-secrets.mjs'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
// Made up, and built so that no source file holds a whole value.
const fake = (name) => ['test', 'recording', name, '0123456789abcdef'].join('-')
const KEY_ID = fake('keyid')
const KEY_SECRET = fake('secret')
const OTHER_ID = fake('otherid')
const OTHER_SECRET = fake('othersecret')
const ALL_KEYS = [KEY_ID, KEY_SECRET, OTHER_ID, OTHER_SECRET]
const ENDPOINT = 'http://127.0.0.1:9' // never asked in this file
const observed = []
const printed = []
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  const real = console[level].bind(console)
  console[level] = (...parts) => { printed.push(parts.map((part) => (part instanceof Error ? `${part.stack}` : typeof part === 'string' ? part : JSON.stringify(part))).join(' ')); real(...parts) }
}

function app({ config = {}, secrets = memorySecrets() } = {}) {
  const stored = { recordingR2Endpoint: ENDPOINT, recordingR2Bucket: 'talks', ...config }
  const rows = []
  const storage = createRecordingStorage({
    secrets: secrets.store,
    settings: () => ({ endpoint: stored.recordingR2Endpoint ?? '', bucket: stored.recordingR2Bucket ?? '' }),
    retired: { read: () => ({ ...stored }), drop: (keys) => { for (const key of keys) delete stored[key] } },
    onChange: (row) => { rows.push(row); observed.push(row) },
  })
  return { storage, secrets, stored, rows }
}
const edge = (row) => recordingRowEdge(row).text

// ── 1. The row: every state from the one function ──────────────────────────────────────────────
{
  const set = { endpoint: ENDPOINT, bucket: 'talks', hasKeys: true }
  const states = {
    'not-set-up': recordingStorageRow({ endpoint: '', bucket: '', hasKeys: false }),
    'not-checked': recordingStorageRow(set),
    ready: recordingStorageRow({ ...set, finding: 'ready' }),
    'bucket-not-found': recordingStorageRow({ ...set, finding: 'bucket-not-found' }),
    'keys-rejected': recordingStorageRow({ ...set, finding: 'keys-rejected' }),
  }
  for (const [state, row] of Object.entries(states)) assert.equal(row.state, state)
  // The spec's words, in the spec's order.
  assert.deepEqual(Object.values(states).map(edge), ['Not set up', 'Keys saved, not checked', 'Ready', 'Bucket not found', 'Keys rejected'])
  assert.deepEqual(Object.values(states).map((row) => recordingRowEdge(row).tone), ['quiet', 'quiet', 'good', 'warn', 'warn'])
  assert.equal(RECORDING_ROW_NAME, 'Recording storage')

  // Not set up: any one of the three missing, and the detail names exactly what is.
  assert.deepEqual(recordingStorageRow({ endpoint: ENDPOINT, bucket: 'talks', hasKeys: false }).missing, ['keys'])
  assert.deepEqual(recordingStorageRow({ endpoint: ' ', bucket: 'talks', hasKeys: true }).missing, ['endpoint'])
  assert.deepEqual(recordingStorageRow({ endpoint: '', bucket: '', hasKeys: true }).missing, ['endpoint', 'bucket'])
  assert.equal(recordingRowDetail(recordingStorageRow({ endpoint: ENDPOINT, bucket: 'talks', hasKeys: false })), 'Enter your access keys to finish setting up')
  assert.equal(recordingRowDetail(recordingStorageRow({ endpoint: '', bucket: '', hasKeys: true })), 'Enter the endpoint and the bucket to finish setting up')
  assert.equal(recordingRowDetail(states['not-set-up']), 'Recordings stay on this computer until storage is set up')
  // A finding never outlives what it was about: with something missing the row is Not set up.
  for (const finding of ['ready', 'bucket-not-found', 'keys-rejected']) {
    assert.equal(recordingStorageRow({ endpoint: ENDPOINT, bucket: 'talks', hasKeys: false, finding }).state, 'not-set-up')
    assert.equal(recordingStorageRow({ endpoint: ENDPOINT, bucket: '', hasKeys: true, finding }).state, 'not-set-up')
  }
  // Ready says what it is: a list was answered; the first upload proves the rest.
  assert.equal(recordingRowDetail(states.ready), 'Bucket talks · found. That the keys may upload is proven by the first upload.')
  assert.equal(recordingRowDetail(states['not-checked']), 'Bucket talks')
  assert.equal(recordingRowDetail(states['bucket-not-found']), 'No bucket named talks at this endpoint')
  assert.equal(recordingRowDetail(states['keys-rejected']), 'The storage did not accept these access keys')
  // Check is offered once there is something to check, and not while one runs.
  assert.deepEqual(Object.values(states).map(recordingRowCanCheck), [false, true, true, true, true])
  const checking = recordingStorageRow({ ...set, finding: 'ready', checking: true })
  assert.equal(edge(checking), 'Checking…')
  assert.equal(recordingRowCanCheck(checking), false)
  // A check that got no usable answer: the state stands, the detail says so.
  const noAnswer = recordingStorageRow({ ...set, notice: 'Could not check (offline?)' })
  assert.equal(noAnswer.state, 'not-checked')
  assert.equal(recordingRowDetail(noAnswer), 'Could not check (offline?)')
  observed.push(...Object.values(states), checking, noAnswer)
  // "How to make a token" still says recordings take nothing from the token.
  assert.deepEqual(TOKEN_PERMISSIONS.find((entry) => entry.feature === 'Recording storage').permissions, [])
  console.log('PASS 1: Recording storage — Not set up · Keys saved, not checked · Ready · "Bucket not found" · "Keys rejected", each from the one row-state function')
}

// ── 2. The upload failure sorter ───────────────────────────────────────────────────────────────
{
  const http = (status, name = 'UnknownError') => Object.assign(new Error(`made-up ${KEY_ID}`), { name, $metadata: { httpStatusCode: status } })
  const socket = (code) => Object.assign(new Error(`connect ${code} ${KEY_ID}`), { code })
  const cases = [
    ['not-set-up', 'not-set-up'],
    ['keys-rejected', http(403, 'InvalidAccessKeyId')], ['keys-rejected', http(403, 'SignatureDoesNotMatch')], ['keys-rejected', http(403, 'AccessDenied')],
    ['keys-rejected', http(401, 'Unauthorized')], ['keys-rejected', http(403)], ['keys-rejected', http(401)], ['keys-rejected', { Code: 'InvalidAccessKeyId' }],
    ['bucket-not-found', http(404, 'NoSuchBucket')], ['bucket-not-found', http(404)], ['bucket-not-found', { Code: 'NoSuchBucket' }],
    ['offline', socket('ENOTFOUND')], ['offline', socket('ECONNREFUSED')], ['offline', socket('ECONNRESET')], ['offline', socket('ETIMEDOUT')], ['offline', socket('EAI_AGAIN')],
    ['offline', Object.assign(new Error('timed out'), { name: 'TimeoutError' })], ['offline', Object.assign(new Error('aborted'), { name: 'AbortError' })],
    // The network library wraps the socket's own error: the cause is read too.
    ['offline', Object.assign(new TypeError('fetch failed'), { cause: socket('ECONNREFUSED') })],
    // Valid keys signed for another region get this answer, so new keys would not fix it: it is not
    // "keys rejected", whatever status comes with it.
    ['failed', http(400, 'AuthorizationHeaderMalformed')], ['failed', http(403, 'AuthorizationHeaderMalformed')], ['failed', { Code: 'AuthorizationHeaderMalformed' }],
    ['failed', Object.assign(new Error('wrapped'), { cause: http(403, 'AuthorizationHeaderMalformed') })],
    // The same answer anywhere in the chain wins over a wrapper's own 403 or "Forbidden".
    ['failed', Object.assign(http(403, 'Error'), { cause: http(403, 'AuthorizationHeaderMalformed') })],
    ['failed', Object.assign(http(403, 'Forbidden'), { cause: http(403, 'AuthorizationHeaderMalformed') })],
    ['failed', Object.assign(http(403, 'Forbidden'), { cause: Object.assign(http(401, 'AccessDenied'), { cause: { Code: 'AuthorizationHeaderMalformed' } }) })],
    ['failed', http(500, 'InternalError')], ['failed', new Error(`anything ${KEY_SECRET}`)], ['failed', null], ['failed', undefined], ['failed', 42],
    ['audio-missing', 'audio-missing'], ['failed', 'no-vault'], ['failed', `Error: ${KEY_SECRET}`], ['failed', ''],
  ]
  const produced = new Set()
  for (const [expected, reason] of cases) {
    assert.equal(sortUploadFailure(reason), expected, `sorted as ${expected}`)
    produced.add(expected)
    observed.push(sortUploadFailure(reason), uploadFailureMessage(reason), uploadFailureAction(reason))
  }
  assert.deepEqual([...produced].sort(), [...UPLOAD_FAILURES].sort(), 'every kind is produced')
  // Each of its own sentences, all different, each saying the recording is safe on this computer.
  const sentences = UPLOAD_FAILURES.map((kind) => uploadFailureMessage(kind))
  assert.deepEqual(sentences, [
    'Recording storage is not set up. The recording is safe on this computer.',
    'Not uploaded: the storage rejected the access keys. The recording is safe on this computer.',
    'Not uploaded: the bucket was not found. The recording is safe on this computer.',
    'Not uploaded: the storage could not be reached (offline?). The recording is safe on this computer.',
    'Not uploaded. The recording is safe on this computer.',
    "This recording's audio file is missing from this computer, so there is nothing to upload.",
  ])
  assert.equal(new Set(sentences).size, sentences.length)
  // Every class but audio missing says the recording is safe; audio missing makes no such claim.
  for (const [index, sentence] of sentences.entries()) {
    if (UPLOAD_FAILURES[index] === 'audio-missing') assert.ok(!sentence.includes('safe on this computer'))
    else assert.ok(sentence.includes('safe on this computer'), `${UPLOAD_FAILURES[index]} says the recording is safe`)
  }
  assert.equal(uploadFailureMessage('audio-missing'), "This recording's audio file is missing from this computer, so there is nothing to upload.")
  // What was thrown never becomes the sentence, whatever it was.
  for (const [, reason] of cases) assert.ok(sentences.includes(uploadFailureMessage(reason)))
  // Not set up offers the way to Settings; nothing else offers an action.
  assert.deepEqual(UPLOAD_FAILURES.map((kind) => uploadFailureAction(kind)), [SET_UP_RECORDING_STORAGE, null, null, null, null, null])
  assert.equal(SET_UP_RECORDING_STORAGE, 'Set up recording storage')
  console.log('PASS 2: upload failures sort to not set up / keys rejected / bucket not found / offline / a plain fallback / audio missing; every sentence but audio missing says the recording is safe on this computer')
}

// ── 3. One source of keys: Settings, through the secrets module ────────────────────────────────
{
  const t = app()
  assert.equal(t.storage.status().state, 'not-set-up')
  assert.deepEqual(t.storage.status().missing, ['keys'])
  assert.equal(t.storage.hasKeys(), false)
  // With no keys an upload is not attempted: it is "not set up", and nothing is asked of any network.
  assert.deepEqual(await t.storage.upload('k', Buffer.from('x'), 'audio/webm'), { ok: false, failure: 'not-set-up' })
  assert.equal((await t.storage.check()).state, 'not-set-up', 'nor is a check')

  // Keys of the wrong shape are refused with a fixed sentence, and nothing is written.
  for (const bad of [null, {}, { accessKeyId: KEY_ID }, { accessKeyId: '', secretAccessKey: KEY_SECRET }, { accessKeyId: `${KEY_ID}\r\nx: y`, secretAccessKey: KEY_SECRET },
    { accessKeyId: KEY_ID, secretAccessKey: `${KEY_SECRET} two` }, { accessKeyId: 7, secretAccessKey: KEY_SECRET }, { accessKeyId: KEY_ID, secretAccessKey: 'x'.repeat(600) }]) {
    const reply = t.storage.saveKeys(bad)
    observed.push(reply)
    assert.deepEqual(reply, { success: false, error: KEYS_SHAPE_ERROR })
  }
  assert.equal(t.secrets.files.blobs.size, 0)

  // Saved: the row moves to "Keys saved, not checked"; the slot holds them, encrypted, and nothing else does.
  const saved = t.storage.saveKeys({ accessKeyId: ` ${KEY_ID} `, secretAccessKey: KEY_SECRET })
  observed.push(saved)
  assert.deepEqual(saved, { success: true })
  assert.equal(edge(t.storage.status()), 'Keys saved, not checked')
  assert.equal(t.storage.hasKeys(), true)
  assert.deepEqual([...t.secrets.files.blobs.keys()].map((path) => path.split(/[\\/]/).pop()), ['recording-r2-creds.bin'])
  for (const blob of t.secrets.files.blobs.values()) for (const key of ALL_KEYS) assert.ok(!blob.includes(Buffer.from(key)), 'the file on disk is not readable')
  assert.deepEqual(JSON.parse(t.secrets.store.read('recording-keys')), { accessKeyId: KEY_ID, secretAccessKey: KEY_SECRET }, 'trimmed, in the shape earlier versions wrote')
  assert.ok(t.rows.length >= 1 && t.rows.at(-1).state === 'not-checked', 'the window is told')

  // Keys an earlier version saved (the same slot, the same shape) are used with nothing to do.
  const earlier = memorySecrets()
  earlier.store.write('recording-keys', JSON.stringify({ accessKeyId: OTHER_ID, secretAccessKey: OTHER_SECRET }))
  assert.equal(edge(app({ secrets: earlier }).storage.status()), 'Keys saved, not checked')

  // Secure storage unavailable: the save is refused in the secrets module's own sentence; the old keys stay.
  t.secrets.cipher.state.available = false
  const refused = t.storage.saveKeys({ accessKeyId: OTHER_ID, secretAccessKey: OTHER_SECRET })
  observed.push(refused)
  assert.deepEqual(refused, { success: false, error: secretsFailureMessage('unavailable', 'recording-keys') })
  t.secrets.cipher.state.available = true
  assert.equal(JSON.parse(t.secrets.store.read('recording-keys')).accessKeyId, KEY_ID)
  // A disk that will not take the file: a fixed sentence again.
  t.secrets.files.knobs.failWrites = true
  const notSaved = t.storage.saveKeys({ accessKeyId: OTHER_ID, secretAccessKey: OTHER_SECRET })
  observed.push(notSaved)
  assert.equal(notSaved.success, false)
  assert.ok([KEYS_NOT_SAVED_ERROR, secretsFailureMessage('not-saved', 'recording-keys')].includes(notSaved.error))
  t.secrets.files.knobs.failWrites = false

  // Saved keys that cannot be read on this computer just now: an upload is "not set up" (never a
  // guess at another source), and a check says to enter them again.
  t.secrets.cipher.state.locked = true
  assert.deepEqual(await t.storage.upload('k', Buffer.from('x'), 'audio/webm'), { ok: false, failure: 'not-set-up' })
  const unreadable = await t.storage.check()
  observed.push(unreadable)
  assert.equal(unreadable.state, 'not-checked')
  assert.equal(recordingRowDetail(unreadable), 'The saved access keys could not be read on this computer. Enter them again.')
  t.secrets.cipher.state.locked = false
  // So is a slot that holds something that is not a pair of keys.
  const odd = memorySecrets()
  odd.store.write('recording-keys', '{"accessKeyId":"only-one"}')
  assert.deepEqual(await app({ secrets: odd }).storage.upload('k', Buffer.from('x'), 'audio/webm'), { ok: false, failure: 'not-set-up' })

  // Cleared: back to Not set up, the slot empty.
  assert.deepEqual(t.storage.clearKeys(), { success: true })
  assert.equal(edge(t.storage.status()), 'Not set up')
  assert.equal(t.secrets.files.blobs.size, 0)
  t.secrets.files.knobs.failRemoves = true
  assert.deepEqual(t.storage.clearKeys(), { success: false })
  console.log('PASS 3: recording keys have one source, Settings: saved, replaced and cleared through the secrets module; a refused save writes nothing')
}

// ── 4. A former Bitwarden set-up: the notice once, the two config keys dropped ─────────────────
{
  assert.deepEqual([...RETIRED_RECORDING_CONFIG_KEYS], ['recordingR2CredsSource', 'recordingR2BwsSecretId'])
  assert.equal(RECORDING_KEYS_NOTICE, 'Recording storage: enter your access keys')

  // Bitwarden was the source: the notice, once; both keys gone; everything else in config kept.
  const former = app({ config: { recordingR2CredsSource: 'bws', recordingR2BwsSecretId: 'made-up-secret-id', vaultRoot: '/somewhere', recordingDiscardMs: 9000 } })
  assert.equal(former.storage.takeNotice(), RECORDING_KEYS_NOTICE)
  assert.deepEqual(former.stored, { recordingR2Endpoint: ENDPOINT, recordingR2Bucket: 'talks', vaultRoot: '/somewhere', recordingDiscardMs: 9000 })
  assert.equal(former.storage.takeNotice(), null, 'once')
  assert.equal(former.storage.takeNotice(), null)
  // A new start of the app reads the same config: still nothing.
  assert.equal(app({ config: former.stored }).storage.takeNotice(), null)
  // The id of the Bitwarden secret is never used for anything: no keys, no upload, the row says so.
  assert.equal(edge(former.storage.status()), 'Not set up')
  assert.deepEqual(former.storage.status().missing, ['keys'])
  assert.deepEqual(await former.storage.upload('k', Buffer.from('x'), 'audio/webm'), { ok: false, failure: 'not-set-up' })

  // Typed keys were the source: no notice, the two keys dropped, the saved keys untouched and in use.
  const typedSecrets = memorySecrets()
  typedSecrets.store.write('recording-keys', JSON.stringify({ accessKeyId: KEY_ID, secretAccessKey: KEY_SECRET }))
  const before = Buffer.from([...typedSecrets.files.blobs.values()][0])
  const typed = app({ secrets: typedSecrets, config: { recordingR2CredsSource: 'settings', recordingR2BwsSecretId: 'left-over' } })
  assert.equal(typed.storage.takeNotice(), null)
  assert.deepEqual(typed.stored, { recordingR2Endpoint: ENDPOINT, recordingR2Bucket: 'talks' })
  assert.ok(before.equals([...typedSecrets.files.blobs.values()][0]), 'the saved keys are the same bytes')
  assert.equal(typedSecrets.files.knobs.writes, 1, 'and were not written again')
  assert.equal(edge(typed.storage.status()), 'Keys saved, not checked', 'no re-entry')

  // Neither key (a fresh install, or one already migrated): nothing is read into a notice, nothing is written.
  let drops = 0
  assert.equal(retireRecordingConfig({ read: () => ({ vaultRoot: '/x' }), drop: () => { drops += 1 } }), null)
  assert.equal(drops, 0)
  // Only the id left behind, no source: the source defaulted to typed keys.
  assert.equal(retireRecordingConfig({ read: () => ({ recordingR2BwsSecretId: 'x' }), drop: () => { drops += 1 } }), null)
  assert.equal(drops, 1)
  // A config that cannot be read, or cannot be written: no throw; the notice is not lost.
  assert.equal(retireRecordingConfig({ read: () => { throw new Error('unreadable') }, drop: () => {} }), null)
  assert.equal(retireRecordingConfig({ read: () => ({ recordingR2CredsSource: 'bws' }), drop: () => { throw new Error('read-only disk') } }), RECORDING_KEYS_NOTICE)
  // The same through the app's one storage: with a config that cannot be written the two keys are
  // still there at every call, and the notice is still given once in this run of the app.
  const stuck = { recordingR2CredsSource: 'bws', recordingR2BwsSecretId: 'made-up-secret-id' }
  let attempts = 0
  const stuckConfig = { read: () => ({ ...stuck }), drop: () => { attempts += 1; throw new Error('read-only disk') } }
  const readOnly = createRecordingStorage({ secrets: memorySecrets().store, settings: () => ({ endpoint: ENDPOINT, bucket: 'talks' }), retired: stuckConfig })
  assert.equal(readOnly.takeNotice(), RECORDING_KEYS_NOTICE)
  assert.equal(readOnly.takeNotice(), null, 'once in a run of the app, though the config keys could not be dropped')
  assert.equal(readOnly.takeNotice(), null)
  assert.ok(attempts >= 1, 'the removal was tried')
  assert.deepEqual(Object.keys(stuck), ['recordingR2CredsSource', 'recordingR2BwsSecretId'], 'and the keys are still in the config')
  // The next start of the app (a new storage over the same config) may say it again: accepted.
  assert.equal(createRecordingStorage({ secrets: memorySecrets().store, settings: () => ({ endpoint: ENDPOINT, bucket: 'talks' }), retired: stuckConfig }).takeNotice(), RECORDING_KEYS_NOTICE)
  // No retired config handed in at all (a caller with no config file): null.
  assert.equal(createRecordingStorage({ secrets: memorySecrets().store, settings: () => ({ endpoint: '', bucket: '' }) }).takeNotice(), null)
  console.log('PASS 4: a former Bitwarden set-up is told "Recording storage: enter your access keys" once and its two config keys are dropped; typed keys keep working')
}

// ── 5. No key in anything shown or printed ─────────────────────────────────────────────────────
{
  const everything = JSON.stringify(observed)
  for (const key of ALL_KEYS) {
    assert.ok(!everything.includes(key), 'no key in any row, reply or sentence')
    assert.ok(!printed.some((line) => line.includes(key)), 'no key in any printed line')
  }
  assert.ok(observed.length > 80)
  console.log(`PASS 5: ${observed.length} rows, replies and sentences and ${printed.length} printed lines hold no key`)
}

// ── 6. One source in the code, one module holding the slot ─────────────────────────────────────
{
  const sources = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? sources(path) : /\.(?:mjs|cjs|js|ts|tsx)$/.test(entry.name) ? [path] : []
  })
  const name = (file) => relative(repo, file).split('\\').join('/')
  const files = sources(join(repo, 'src')).map((file) => [name(file), readFileSync(file, 'utf8')])
  const otherSources = (text) => [
    [/bws/, 'Bitwarden'], [/BWS_ACCESS_TOKEN/, 'Bitwarden'], [/[Bb]itwarden\s+Secrets\s+CLI/, 'Bitwarden'],
    [/find-generic-password/, 'the Keychain command'], [/['"`](?:\/usr\/bin\/)?security['"`]/, 'the Keychain command'],
    [/process\.env(?:\.|\[['"`])(?:AWS|R2|S3)_[A-Z_]*(?:KEY|SECRET|TOKEN)/, 'the environment'],
  ].filter(([pattern]) => pattern.test(text)).map(([, what]) => what)
  for (const [sample, what] of [
    ["execFileSync('bws', ['secret', 'get', id])", 'Bitwarden'], ['env.BWS_ACCESS_TOKEN', 'Bitwarden'], ["credsSource === 'bws'", 'Bitwarden'],
    ["execFile('security', ['find-generic-password'])", 'the Keychain command'], ['process.env.AWS_SECRET_ACCESS_KEY', 'the environment'], ["process.env['R2_ACCESS_KEY_ID']", 'the environment'],
  ]) assert.ok(otherSources(sample).includes(what), `caught: ${sample}`)
  assert.deepEqual(files.flatMap(([file, text]) => otherSources(text).map((what) => `${file}: ${what}`)), [], 'under src nothing reads recording keys from Bitwarden, the Keychain command or the environment')
  // The slot is named, as a value, in two files: the secrets module that defines it and the one
  // module that uses it (a comment may mention it in backticks; no code elsewhere does).
  assert.deepEqual(files.filter(([, text]) => /['"]recording-keys['"]/.test(text)).map(([file]) => file).sort(), ['src/main/recording-storage.ts', 'src/main/secrets-store.ts'])
  // The S3 client is made in that one module; the recording module starts no other program.
  assert.deepEqual(files.filter(([, text]) => /new S3Client\(/.test(text)).map(([file]) => file), ['src/main/recording-storage.ts'])
  const recording = files.find(([file]) => file === 'src/main/recording.ts')[1]
  assert.ok(!/child_process/.test(recording) && !/@aws-sdk/.test(recording))
  // The retired config keys are named only where they are read once and dropped.
  assert.deepEqual(files.filter(([, text]) => /recordingR2CredsSource|recordingR2BwsSecretId/.test(text)).map(([file]) => file), ['src/main/recording-storage.ts'])
  // Neither module prints: there is no line a key could be printed on.
  for (const file of ['src/main/recording-storage.ts', 'src/shared/recording-storage-status.ts']) {
    assert.ok(!/console\.|process\.std(?:out|err)/.test(files.find(([path]) => path === file)[1]), `${file} prints nothing`)
  }
  // The help text no longer promises a queue.
  const settingsPanel = files.find(([file]) => file === 'src/renderer/src/components/SettingsPanel.tsx')[1]
  assert.ok(!/queue and retry/.test(settingsPanel))
  console.log('PASS 6: no Bitwarden, Keychain-command or environment source of recording keys under src; one module holds the slot and makes the S3 client')
}

console.log('recording storage: the row states, the upload failure sorter, one source of keys, the one-time notice, nothing secret shown — passed')
