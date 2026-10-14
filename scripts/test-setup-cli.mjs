// The `setup` command (src/main/setup-cli.ts, setup-operations.ts, setup-stdin.ts;
// spec "Cloudflare set-up in the app", D14; ticket 07). Plain Node, no network, no Electron.
// The seams:
//   1. finding `setup` in the process's arguments (packaged and unpackaged, Electron's own switches);
//   2. the parser and printer: arguments and standard input in, lines and an exit code out, with
//      the operations injected: every command of the D14 table, its exit code (0 / 1 / 2), the
//      window's words for every row, and the --json document whose shape
//      resources/agent-setup/setup-command.md fixes;
//   3. secrets: every argument is checked as typed against its own strict format and anything else
//      is exit 2 before anything runs; no argument is repeated back, and a token on standard input
//      reaches the operation and no output (gate);
//   4. standard input: piped, and typed in a terminal with nothing shown; fails closed (too long,
//      unreadable, closed early, cancelled, a terminal that cannot hide what is typed);
//   5. the refusal while TalkWeaver is open on the same user-data folder (Owner, 10 Oct): exit 1,
//      the fixed sentence (and the --json form with state app-open), before anything else;
//   6. the operations over the real Cloudflare connection and the fake Cloudflare API: connect,
//      choose an account, create the site, disconnect, as the window does them.
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import {
  SECRET_ARGUMENT_ERROR, SETUP_JSON_FORMAT, UNKNOWN_COMMAND_ERROR, NO_TOKEN_INPUT_ERROR, ONE_TOKEN_ERROR, KEYS_INPUT_ERROR,
  ENDPOINT_ERROR, BUCKET_ERROR, PATH_ERROR, ACCOUNT_ID_ERROR, SITE_NAME_ERROR, SHARE_DOMAIN_ERROR, TOKEN_PIPE_HINT,
  APP_OPEN_ERROR, APP_OPEN_STATE, appOpenRefusal, commandReady, keysFromInput, parseSetupArguments, runSetup, setupArguments, setupStatusJson, setupStatusLines, tokenFromInput,
  validEndpointArgument, validPathArgument,
} from '../src/main/setup-cli.ts'
import { createSetupOperations } from '../src/main/setup-operations.ts'
import { CANNOT_HIDE_PREFIX, INPUT_CANCELLED_ERROR, INPUT_READ_ERROR, INPUT_TOO_LONG_ERROR, SecretInputError, readSecretInput } from '../src/main/setup-stdin.ts'
import { KEYS_SHAPE_ERROR } from '../src/main/recording-storage.ts'
import { CLOUDFLARE_API_BASE, createCloudflareConnection } from '../src/main/cloudflare-connection.ts'
import { DEFAULT_PAGES_PROJECT, unknownPublishing, unknownShareLink, UNKNOWN_LIVE_SERVICE } from '../src/shared/cloudflare-status.ts'
import { unknownGoingLive } from '../src/shared/live-service-status.ts'
import { recordingStorageRow } from '../src/shared/recording-storage-status.ts'
import { createFakeCloudflare, fakeCloudflareFetch } from './lib/cloudflare-api-stub.mjs'
import { memorySecrets } from './lib/memory-secrets.mjs'
import { createLiveService } from '../src/main/live-service.ts'
import { deployLiveService, lookUpLiveService, surveyLiveService } from '../src/main/live-service-deploy.ts'
import { keyKind } from '../src/main/live-service-key.ts'
import { changeShareAddress } from '../src/main/live-service-share-domain.ts'
import { instantClock, keyProfile, liveWorkerDouble } from './lib/live-worker-double.mjs'
import { workerDistFiles } from './lib/worker-dist.mjs'

let passed = 0
const ok = (label) => { passed += 1; console.log(`  ok ${passed}. ${label}`) }
const scratch = mkdtempSync(join(tmpdir(), 'tw-setup-cli-'))

// Made up, and built so that no source file holds a whole value.
const fake = (name) => ['test', 'token', 'setup', name, '0123456789abcdef'].join('-')
const TOKEN = fake('cloudflare')
const KEY_ID = fake('keyid')
const KEY_SECRET = fake('keysecret')
// Shaped as the real ones are: a Cloudflare token (40 of A-Z a-z 0-9 _ -), an R2 access key id (32
// lowercase hex) and secret (64 lowercase hex), a base64 key with '/' and '+'. All made up.
const CF_SHAPED = ['Qw3rTy', 'Uiop_As', 'dFgh-Jk', 'L9zXcVb', 'Nm1Qw2E', 'r3TyU4i'].join('').slice(0, 40)
const R2_ID_SHAPED = ['0f1e2d3c', '4b5a6978', '8796a5b4', 'c3d2e1f0'].join('')
const R2_SECRET_SHAPED = R2_ID_SHAPED + R2_ID_SHAPED.split('').reverse().join('')
const BASE64_SHAPED = ['QUJD', 'REVG', 'R0hJ', 'Sktm', 'bW5v', 'cHFy', 'c3R1', 'dnd4', 'eXo/', 'Kys='].join('')
const SECRETS = [TOKEN, KEY_ID, KEY_SECRET, CF_SHAPED, R2_SECRET_SHAPED, BASE64_SHAPED]
const ADA = { id: '0000000000000000000000000000ada1', name: 'Ada Lovelace' }
const GRACE = { id: '0000000000000000000000000000beef', name: 'Grace Hopper' }
const R2_ENDPOINT = `https://${'0123456789abcdef'.repeat(2)}.r2.cloudflarestorage.com` // gitleaks:allow (made-up test value)

// ── A snapshot in each state, and stand-in operations ───────────────────────────────────────────
function cloudflare(connection, rows = {}) {
  return {
    connection,
    publishing: rows.publishing ?? unknownPublishing(DEFAULT_PAGES_PROJECT),
    liveService: UNKNOWN_LIVE_SERVICE,
    shareLink: rows.shareLink ?? unknownShareLink(''),
    busy: false, checkedAt: Date.UTC(2026, 9, 10, 9, 14), notice: null, details: null,
  }
}
const READY_PUBLISHING = { state: 'ready', project: DEFAULT_PAGES_PROJECT, permission: null, customDomain: 'none', stale: false }
const LIVE_READY = { ...unknownGoingLive('b7'), state: 'ready', address: 'https://talkweaver-live-sessions.stand-in.workers.dev', build: 'b7' }
const TRANSCRIPTION_OFF = { state: 'not-set-up', pythonVersion: null, ffmpeg: null, ffmpegConfigured: false }
const TRANSCRIPTION_READY = { state: 'ready', pythonVersion: '3.11', ffmpeg: 'shipped', ffmpegConfigured: false }
function snapshotOf(parts = {}) {
  return {
    cloudflare: parts.cloudflare ?? cloudflare({ state: 'no-token' }),
    goingLive: parts.goingLive ?? unknownGoingLive('b7'),
    recording: parts.recording ?? recordingStorageRow({ endpoint: '', bucket: '', hasKeys: false }),
    transcription: parts.transcription === undefined ? TRANSCRIPTION_OFF : parts.transcription,
    importer: parts.importer === undefined ? { state: 'not-available', available: true, pointer: 'Pictures of the original slides come from the separate TalkWeaver PPT Extractor app.', url: 'https://talkweaver.app/tools/ppt-extractor' } : parts.importer,
  }
}
const READY_ALL = snapshotOf({ cloudflare: cloudflare({ state: 'connected', account: ADA }, { publishing: READY_PUBLISHING }), goingLive: LIVE_READY })

function stubOps(snapshot = READY_ALL, results = {}) {
  const calls = []
  const op = (name) => async (...args) => { calls.push([name, ...args]); if (name === 'setUpLive' || name === 'createSite' || name === 'setShareDomain') args.at(-1)('Setting up… Uploading the live service'); return results[name] ?? { ok: true } }
  return {
    calls,
    ops: {
      checkAll: async () => { calls.push(['checkAll']) },
      snapshot: async () => (typeof snapshot === 'function' ? snapshot() : snapshot),
      connect: op('connect'), chooseAccount: op('chooseAccount'), createSite: op('createSite'), setUpLive: op('setUpLive'),
      setShareDomain: op('setShareDomain'), setRecording: op('setRecording'), setTranscription: op('setTranscription'), disconnect: op('disconnect'),
    },
  }
}
function io(stdin = null) {
  const out = []
  const err = []
  const asked = []
  // `stdin` may be an Error: the read failed with it.
  return { out, err, asked, io: { out: (line) => out.push(line), err: (line) => err.push(line), readSecret: async (prompts, hint) => { asked.push(prompts); if (!hint) throw new Error('no pipe hint'); if (stdin instanceof Error) throw stdin; return stdin } } }
}
async function run(args, { stdin = null, snapshot, results } = {}) {
  const stub = stubOps(snapshot, results)
  const streams = io(stdin)
  const code = await runSetup(args, streams.io, stub.ops)
  return { code, ...streams, calls: stub.calls, text: [...streams.out, ...streams.err].join('\n') }
}
const noSecretIn = (text, where) => { for (const value of SECRETS) assert.ok(!text.includes(value), `no secret in ${where}`) }

try {
  // ── 1. Finding the command: only at the command position ─────────────────────────────────────
  const EXE = '/Applications/TalkWeaver.app/Contents/MacOS/TalkWeaver'
  assert.deepEqual(setupArguments([EXE, 'setup', 'status', '--json'], false), ['status', '--json'])
  assert.deepEqual(setupArguments([EXE, '-psn_0_1234', 'setup', 'status'], false), ['status'], 'macOS\'s -psn_ argument is the one thing passed over')
  assert.deepEqual(setupArguments(['C:\\TW\\TalkWeaver.exe', 'setup', 'cloudflare', 'live', '--user-data-dir=C:\\x'], false), ['cloudflare', 'live'], 'a switch after the command is Electron\'s, passed over')
  assert.deepEqual(setupArguments(['electron', '.', 'setup', 'status', '--user-data-dir=/tmp/u', '--use-mock-keychain'], true), ['status'])
  assert.deepEqual(setupArguments(['electron', '/path/to/app', 'setup'], true), [])
  // The review's argv: a switch with its operand before `setup` is an ordinary launch, packaged or not.
  assert.equal(setupArguments([EXE, '--user-data-dir', '/tmp/u', 'setup', 'status'], false), null, 'packaged: a switch at the command position is an ordinary launch')
  assert.equal(setupArguments(['electron', '.', '--user-data-dir', '/tmp/u', 'setup', 'status'], true), null, 'unpackaged: likewise')
  assert.equal(setupArguments([EXE, '--user-data-dir=/tmp/u', 'setup', 'status'], false), null, 'switches go after `setup …`')
  assert.equal(setupArguments(['electron', '--inspect', '.', 'setup'], true), null, 'unpackaged: the app path comes first')
  // An operand literally named setup is not the command.
  assert.equal(setupArguments([EXE, '/Users/ann/talk-outline.md', 'setup'], false), null, 'a file to open, then "setup"')
  assert.equal(setupArguments([EXE, '--open', 'setup'], false), null, 'an operand of a switch named setup')
  assert.equal(setupArguments([EXE, '-psn_0_1', '--x', 'setup'], false), null)
  assert.equal(setupArguments(['electron', 'setup'], true), null, 'unpackaged: an app folder named setup is the app, not the command')
  assert.equal(setupArguments(['electron', 'setup', 'status'], true), null, 'unpackaged: the app folder named setup, then "status"')
  assert.equal(setupArguments([EXE], false), null, 'a plain launch is not setup')
  assert.equal(setupArguments([EXE, '-psn_0_1234'], false), null, 'a Finder launch is not setup')
  assert.equal(setupArguments([EXE, '-psn_x', 'setup'], false), null, 'only the known -psn_ form is passed over')
  assert.equal(setupArguments(['electron', '.'], true), null, 'the unpackaged app folder is not the command')
  ok('`setup` is found only at the command position (packaged: first argument after a known -psn_; unpackaged: first after the app path); nothing scans through switches')

  // ── 2. Parser: every command of the D14 table, and usage errors ───────────────────────────────
  const parsed = (args) => { const result = parseSetupArguments(args); assert.ok(result.ok, `parses: ${args.join(' ')}`); return result.command }
  assert.deepEqual(parsed(['status', '--json']), { kind: 'status', json: true })
  assert.deepEqual(parsed(['cloudflare', 'connect']), { kind: 'connect', json: false })
  assert.deepEqual(parsed(['cloudflare', 'account', ADA.id]), { kind: 'account', id: ADA.id, json: false })
  assert.deepEqual(parsed(['cloudflare', 'account', GRACE.id]).id, GRACE.id, 'an account id is 32 hex')
  assert.deepEqual(parsed(['cloudflare', 'create-site']), { kind: 'create-site', name: null, json: false })
  assert.deepEqual(parsed(['cloudflare', 'create-site', 'my-handouts', '--json']), { kind: 'create-site', name: 'my-handouts', json: true })
  assert.deepEqual(parsed(['cloudflare', 'live']), { kind: 'live', json: false })
  assert.deepEqual(parsed(['cloudflare', 'share-domain', 'Drafts.Example.com']), { kind: 'share-domain', host: 'drafts.example.com', json: false })
  assert.deepEqual(parsed(['cloudflare', 'share-domain', '--clear']), { kind: 'share-domain', host: null, json: false })
  assert.deepEqual(parsed(['cloudflare', 'disconnect']), { kind: 'disconnect', json: false })
  assert.deepEqual(parsed(['recording', '--endpoint', R2_ENDPOINT, '--bucket=talks']), { kind: 'recording', endpoint: R2_ENDPOINT, bucket: 'talks', json: false })
  assert.deepEqual(parsed(['transcription', '--python', '/Users/ann/venv/bin/python', '--script', '/opt/s.py']),
    { kind: 'transcription', python: '/Users/ann/venv/bin/python', script: '/opt/s.py', ffmpeg: undefined, json: false })
  assert.equal(parsed(['transcription', '--python', '/py', '--script', '/s.py', '--ffmpeg', '']).ffmpeg, '', '--ffmpeg "" clears it')
  assert.equal(parsed(['transcription', '--python', 'C:\\Tools\\python.exe', '--script', 'C:/s.py']).python, 'C:\\Tools\\python.exe', 'a Windows full path')
  assert.deepEqual(parsed(['help']), { kind: 'help' })
  for (const [args, why] of [
    [[], 'nothing'], [['cloudflare'], 'no verb'], [['cloudflare', 'conect'], 'a misspelt verb'], [['status', 'extra'], 'an extra argument'],
    [['cloudflare', 'account'], 'no id'], [['cloudflare', 'account', 'a b'], 'an id with a space'], [['cloudflare', 'create-site', '-bad'], 'an option for a name'],
    [['cloudflare', 'create-site', 'bad.name'], 'a site name with a dot'], [['cloudflare', 'share-domain', 'https://x.example'], 'a share address that is not a hostname'],
    [['cloudflare', 'share-domain', 'localhost'], 'localhost'], [['cloudflare', 'share-domain', 'a.example', '--clear'], 'both a host and --clear'],
    [['recording', '--endpoint', R2_ENDPOINT], 'no bucket'], [['recording', '--bucket'], 'a flag with no value'], [['transcription', '--python', 'p'], 'no script'],
    [['status', '--verbose'], 'an unknown option'], [['cloudflare', 'live', '--endpoint', 'x'], 'an option of another command'],
  ]) {
    const result = parseSetupArguments(args)
    assert.equal(result.ok, false, `refused: ${why}`)
  }
  ok('every command of the D14 table parses; a missing, extra, misspelt or misplaced argument is a usage error')

  // ── 3. Every argument in its own format; secrets on the command line refused, nothing repeated ──
  const endpointFor = (host) => `https://${host}`
  const HEX32 = '0123456789abcdef'.repeat(2) // gitleaks:allow (made-up test value)
  for (const good of [R2_ENDPOINT, endpointFor(`${HEX32}.eu.r2.cloudflarestorage.com`), endpointFor(`${HEX32}.fedramp.r2.cloudflarestorage.com`)]) assert.ok(validEndpointArgument(good), 'an R2 endpoint')
  for (const bad of [
    `${R2_ENDPOINT}/`, `${R2_ENDPOINT}/talks`, `${R2_ENDPOINT}?x=1`, `${R2_ENDPOINT}:443`, ` ${R2_ENDPOINT}`, `${R2_ENDPOINT} `,
    endpointFor(`user:${CF_SHAPED}@${HEX32}.r2.cloudflarestorage.com`), endpointFor(`${HEX32}.r2.cloudflarestorage.com/${CF_SHAPED}`),
    endpointFor(`${HEX32.toUpperCase()}.r2.cloudflarestorage.com`), endpointFor(`${HEX32}.r2.cloudflarestorage.com.evil.example`),
    endpointFor(`${HEX32}.xx.r2.cloudflarestorage.com`), `http://${HEX32}.r2.cloudflarestorage.com`, endpointFor('acc.r2.cloudflarestorage.com'), 'https://e.example',
  ]) assert.ok(!validEndpointArgument(bad), `not an R2 endpoint: ${bad.slice(0, 20)}…`)
  assert.ok(validEndpointArgument('http://127.0.0.1:9', 'http://127.0.0.1:9') && !validEndpointArgument('http://127.0.0.1:9', 'http://127.0.0.1:8') && !validEndpointArgument('', ''), 'a test stand-in only when named exactly')
  for (const bad of ['venv/bin/python', '~/py', '~', 'file:///usr/bin/python', 'https://x.example/p', '\\\\server\\share\\p.exe', '//server/share/p', '/p\nq', ' /p', 'C:p', '']) assert.ok(!validPathArgument(bad), `not a full path: ${JSON.stringify(bad)}`)
  for (const good of ['/usr/bin/python3', '/Users/ann/My Talks/s.py', 'C:\\Tools\\python.exe', 'D:/x/y']) assert.ok(validPathArgument(good), `a full path: ${good}`)
  const refusals = [
    // The review's scenarios: a token padded so that trimming would have made it a bucket, a token in an endpoint, a base64 key as a bucket.
    [['recording', '--endpoint', R2_ENDPOINT, `--bucket= ${CF_SHAPED} `], BUCKET_ERROR],
    [['recording', '--endpoint', R2_ENDPOINT, '--bucket', ` ${R2_ID_SHAPED} `], BUCKET_ERROR],
    [['recording', '--endpoint', endpointFor(`${HEX32}.r2.cloudflarestorage.com/${CF_SHAPED}`), '--bucket', 'talks'], ENDPOINT_ERROR],
    [['recording', '--endpoint', endpointFor(`${CF_SHAPED}@${HEX32}.r2.cloudflarestorage.com`), '--bucket', 'talks'], ENDPOINT_ERROR],
    [['recording', '--endpoint', R2_ENDPOINT, '--bucket', BASE64_SHAPED], BUCKET_ERROR],
    [['recording', '--endpoint', R2_ENDPOINT, '--bucket', R2_SECRET_SHAPED], BUCKET_ERROR],
    [['recording', '--endpoint', R2_ENDPOINT, '--bucket', CF_SHAPED], BUCKET_ERROR],
    [['recording', '--endpoint', R2_ENDPOINT, '--bucket', 'talks', '--secret-access-key', KEY_SECRET], SECRET_ARGUMENT_ERROR],
    [['cloudflare', 'connect', `--token=${TOKEN}`], SECRET_ARGUMENT_ERROR], [['cloudflare', 'connect', '--token', 'x'], SECRET_ARGUMENT_ERROR],
    [['cloudflare', 'connect', TOKEN], null], [[TOKEN], UNKNOWN_COMMAND_ERROR], [['status', '--json', TOKEN], UNKNOWN_COMMAND_ERROR],
    [['cloudflare', 'create-site', CF_SHAPED], SITE_NAME_ERROR], [['cloudflare', 'create-site', ` ${TOKEN}`], SITE_NAME_ERROR], [['cloudflare', 'create-site', BASE64_SHAPED], SITE_NAME_ERROR],
    [['cloudflare', 'create-site', 'a'.repeat(59)], SITE_NAME_ERROR], [['cloudflare', 'create-site', 'Talks'], SITE_NAME_ERROR],
    [['cloudflare', 'account', CF_SHAPED], ACCOUNT_ID_ERROR], [['cloudflare', 'account', ` ${GRACE.id}`], ACCOUNT_ID_ERROR], [['cloudflare', 'account', 'acc-ada-0001'], ACCOUNT_ID_ERROR],
    [['cloudflare', 'account', GRACE.id, GRACE.id], null],
    [['cloudflare', 'share-domain', ' handouts.example.org'], SHARE_DOMAIN_ERROR], [['cloudflare', 'share-domain', `${CF_SHAPED}@drafts.example.com`], SHARE_DOMAIN_ERROR],
    [['cloudflare', 'share-domain', 'drafts.example.com:8443'], SHARE_DOMAIN_ERROR], [['cloudflare', 'share-domain', 'drafts.example.com/x'], SHARE_DOMAIN_ERROR],
    [['transcription', '--python', `https://x.example/${CF_SHAPED}`, '--script', '/s.py'], PATH_ERROR], [['transcription', '--python', 'venv/python', '--script', '/s.py'], PATH_ERROR],
    [['transcription', '--python', '/p', '--script', ' /s.py'], PATH_ERROR], [['transcription', '--python', '/p', '--script', '/s.py', '--ffmpeg', 'file:///ffmpeg'], PATH_ERROR],
  ]
  for (const [args, sentence] of refusals) {
    for (const json of [false, true]) {
      const outcome = await run(json ? [...args, '--json'] : args, { stdin: TOKEN })
      assert.equal(outcome.code, 2, `exit 2 for: ${args[0]} ${args[1] ?? ''}`)
      assert.equal(outcome.calls.length, 0, 'nothing was done (no operation, no notice)')
      assert.equal(outcome.asked.length, 0, 'standard input was not even read')
      if (sentence) assert.ok(json || args.includes('--json') ? JSON.parse(outcome.out.join('')).error === sentence : outcome.err.includes(sentence), `the sentence says why: ${sentence.slice(0, 30)}`)
      noSecretIn(outcome.text, 'the refusal')
      for (const arg of args) if (arg.length > 6 && !/^(--|cloudflare|recording|transcription|connect|account|create-site|share-domain)/.test(arg)) assert.ok(!outcome.text.includes(arg.trim()), 'the value is not repeated back')
    }
  }
  const unknown = await run(['frobnicate', 'my-secret-word'])
  assert.equal(unknown.code, 2)
  assert.ok(unknown.err.includes(UNKNOWN_COMMAND_ERROR) && !unknown.text.includes('my-secret-word') && !unknown.text.includes('frobnicate'), 'an unknown command is not repeated back')
  const unknownJson = await run(['frobnicate', '--json'])
  assert.deepEqual(JSON.parse(unknownJson.out.join('')), { format: SETUP_JSON_FORMAT, command: null, ready: false, error: UNKNOWN_COMMAND_ERROR, usage: true })
  ok('every argument is checked as typed against its own format (endpoint, bucket, hostname, site, account id, full path); anything else is exit 2 before anything runs, and nothing is repeated back')

  // ── 4. Standard input: the token and the keys ────────────────────────────────────────────────
  assert.deepEqual(tokenFromInput(`  ${TOKEN}\n`), { token: TOKEN })
  assert.deepEqual(tokenFromInput(`\r\n${TOKEN}\r\n\r\n`), { token: TOKEN })
  assert.deepEqual(tokenFromInput(''), { error: NO_TOKEN_INPUT_ERROR })
  assert.deepEqual(tokenFromInput(null), { error: NO_TOKEN_INPUT_ERROR })
  assert.deepEqual(tokenFromInput(`${TOKEN}\n${TOKEN}`), { error: ONE_TOKEN_ERROR })
  assert.deepEqual(keysFromInput(`${KEY_ID}\n${KEY_SECRET}\n`), { keys: { accessKeyId: KEY_ID, secretAccessKey: KEY_SECRET } })
  assert.deepEqual(keysFromInput(JSON.stringify({ accessKeyId: KEY_ID, secretAccessKey: KEY_SECRET })), { keys: { accessKeyId: KEY_ID, secretAccessKey: KEY_SECRET } })
  assert.deepEqual(keysFromInput(null), { keys: null }, 'input that ended with nothing: the saved ones are kept')
  assert.deepEqual(keysFromInput(''), { error: KEYS_INPUT_ERROR }, 'only null keeps the keys')
  assert.deepEqual(keysFromInput('\n\n'), { error: KEYS_INPUT_ERROR }, 'blank lines (an empty variable piped in) are an error, not "keep"')
  assert.deepEqual(keysFromInput(KEY_ID), { error: KEYS_INPUT_ERROR })
  assert.deepEqual(keysFromInput('{"accessKeyId": 1}'), { error: KEYS_INPUT_ERROR })
  for (const [args, stdin] of [[['cloudflare', 'connect'], ''], [['cloudflare', 'connect'], `${TOKEN}\n${TOKEN}`], [['recording', '--endpoint', R2_ENDPOINT, '--bucket', 'talks'], KEY_ID], [['recording', '--endpoint', R2_ENDPOINT, '--bucket', 'talks'], '\n']]) {
    const outcome = await run(args, { stdin })
    assert.equal(outcome.code, 2, 'bad input on standard input is a usage error')
    assert.equal(outcome.calls.length, 0, 'and nothing is done')
    noSecretIn(outcome.text, 'a refused input')
  }
  for (const [reason, message] of [['too-long', INPUT_TOO_LONG_ERROR], ['read-failed', INPUT_READ_ERROR], ['cancelled', INPUT_CANCELLED_ERROR], ['cannot-hide', `${CANNOT_HIDE_PREFIX}${TOKEN_PIPE_HINT}`]]) {
    for (const args of [['cloudflare', 'connect'], ['recording', '--endpoint', R2_ENDPOINT, '--bucket', 'talks']]) {
      for (const json of [false, true]) {
        // The review's scenario: more than 64 KiB piped into recording set-up while working keys are saved.
        const outcome = await run(json ? [...args, '--json'] : args, { stdin: new SecretInputError(reason, message), snapshot: snapshotOf({ recording: recordingStorageRow({ endpoint: 'e', bucket: 'talks', hasKeys: true, finding: 'ready' }) }) })
        assert.equal(outcome.code, 2, `a failed read (${reason}) is exit 2, never "keep the saved keys"`)
        assert.equal(outcome.calls.length, 0, 'nothing is done, nothing checked')
        assert.equal(json ? JSON.parse(outcome.out.join('')).error : outcome.err.join('\n'), message, 'the fixed sentence')
      }
    }
  }
  const odd = await run(['cloudflare', 'connect'], { stdin: new Error(`boom ${TOKEN}`) })
  assert.ok(odd.code === 2 && !odd.text.includes(TOKEN), 'any other failure of the read: exit 2 with a fixed sentence')
  ok('the token is one line on standard input and the keys two lines or JSON; a failed, oversized or cancelled read and anything else are exit 2, do nothing and repeat nothing')

  // ── 5. Each command: the operation it calls, the exit code, and no secret in what it prints ──
  const connected = snapshotOf({ cloudflare: cloudflare({ state: 'connected', account: ADA }, { publishing: { ...READY_PUBLISHING, state: 'no-site' } }) })
  const cases = [
    { args: ['status'], expect: ['checkAll'], ready: READY_ALL, notReady: connected },
    { args: ['cloudflare', 'connect'], stdin: `${TOKEN}\n`, expect: ['connect', TOKEN], ready: connected, notReady: snapshotOf({ cloudflare: cloudflare({ state: 'rejected' }) }) },
    { args: ['cloudflare', 'account', GRACE.id], expect: ['chooseAccount', GRACE.id], ready: connected, notReady: snapshotOf({ cloudflare: cloudflare({ state: 'choose-account', accounts: [ADA, GRACE] }) }) },
    { args: ['cloudflare', 'create-site', 'talks'], expect: ['createSite', 'talks'], ready: READY_ALL, notReady: connected },
    { args: ['cloudflare', 'live'], expect: ['setUpLive'], ready: READY_ALL, notReady: connected },
    { args: ['cloudflare', 'share-domain', 'drafts.handouts.example'], expect: ['setShareDomain', 'drafts.handouts.example'],
      ready: snapshotOf({ cloudflare: cloudflare({ state: 'connected', account: ADA }, { shareLink: { state: 'attached', host: 'drafts.handouts.example', permission: null, stale: false } }) }),
      notReady: snapshotOf({ cloudflare: cloudflare({ state: 'connected', account: ADA }, { shareLink: { state: 'not-attached', host: 'drafts.handouts.example', permission: null, stale: false } }) }) },
    { args: ['cloudflare', 'share-domain', '--clear'], expect: ['setShareDomain', null],
      ready: snapshotOf({ cloudflare: cloudflare({ state: 'connected', account: ADA }, { shareLink: { state: 'none', host: '', permission: null, stale: false } }) }), notReady: READY_ALL },
    { args: ['cloudflare', 'disconnect'], expect: ['disconnect'], ready: snapshotOf(), notReady: connected },
    { args: ['recording', '--endpoint', R2_ENDPOINT, '--bucket', 'talks'], stdin: `${KEY_ID}\n${KEY_SECRET}\n`,
      expect: ['setRecording', { endpoint: R2_ENDPOINT, bucket: 'talks' }, { accessKeyId: KEY_ID, secretAccessKey: KEY_SECRET }],
      ready: snapshotOf({ recording: recordingStorageRow({ endpoint: 'e', bucket: 'talks', hasKeys: true, finding: 'ready' }) }),
      notReady: snapshotOf({ recording: recordingStorageRow({ endpoint: 'e', bucket: 'talks', hasKeys: true, finding: 'bucket-not-found' }) }) },
    { args: ['transcription', '--python', '/p', '--script', '/s'], expect: ['setTranscription', { python: '/p', script: '/s' }],
      ready: snapshotOf({ transcription: TRANSCRIPTION_READY }), notReady: snapshotOf({ transcription: { ...TRANSCRIPTION_OFF, state: 'script-not-found' } }) },
  ]
  for (const item of cases) {
    for (const json of [false, true]) {
      const args = json ? [...item.args, '--json'] : item.args
      const good = await run(args, { stdin: item.stdin ?? null, snapshot: item.ready })
      assert.equal(good.code, 0, `exit 0 when ready: ${item.args.join(' ')}`)
      const call = good.calls.find(([name]) => name === item.expect[0])
      assert.ok(call, `calls ${item.expect[0]}`)
      assert.deepEqual(call.slice(0, item.expect.length), item.expect)
      const bad = await run(args, { stdin: item.stdin ?? null, snapshot: item.notReady })
      assert.equal(bad.code, 1, `exit 1 when not ready: ${item.args.join(' ')}`)
      const failing = await run(args, { stdin: item.stdin ?? null, snapshot: item.ready, results: { [item.expect[0]]: { ok: false, error: 'The check could not be completed.' } } })
      if (item.expect[0] !== 'checkAll') assert.equal(failing.code, 1, 'a step that failed is not ready, whatever the rows say')
      for (const outcome of [good, bad, failing]) {
        noSecretIn(outcome.text, `the output of ${item.args.join(' ')}`)
        if (json) {
          const document = JSON.parse(outcome.out.join('\n'))
          assert.equal(document.format, SETUP_JSON_FORMAT)
          assert.equal(document.command, item.expect[0] === 'checkAll' ? 'status' : parseSetupArguments(item.args).command.kind)
          assert.equal(document.ready, outcome.code === 0)
        }
      }
      if (json && good.calls.some(([name]) => name === 'setUpLive')) {
        assert.ok(good.err.some((line) => line.startsWith('Setting up…')) && !good.out.some((line) => line.startsWith('Setting up…')), 'under --json progress goes to standard error')
      }
    }
  }
  const failed = await run(['cloudflare', 'live'], { snapshot: connected, results: { setUpLive: { ok: false, error: 'Set-up failed: the upload was refused.' } } })
  assert.ok(failed.err.includes('Set-up failed: the upload was refused.'), 'the sentence of a failed step is printed')
  const usage = await run(['cloudflare', 'connect', '--json'], { stdin: TOKEN, results: { connect: { ok: false, error: 'This is not a Cloudflare API token.', usage: true } } })
  assert.equal(usage.code, 2, 'an operation can call its input a usage error (a token of the wrong shape)')
  const brokenOps = stubOps()
  brokenOps.ops.connect = async () => { throw new Error(`boom ${TOKEN}`) }
  const broken = io(TOKEN)
  assert.equal(await runSetup(['cloudflare', 'connect'], broken.io, brokenOps.ops), 1, 'an operation that throws is not ready')
  noSecretIn([...broken.out, ...broken.err].join('\n'), 'the output after a throw')
  ok('each command calls its operation once; exit 0 ready, 1 not ready or failed, 2 usage; no secret printed')

  // ── 6. The window's words, and the --json document ───────────────────────────────────────────
  const lines = setupStatusLines(READY_ALL)
  assert.deepEqual(lines.slice(0, 3), [
    'Cloudflare: Connected · Ada Lovelace',
    'Publishing handouts: Ready · Site talkweaver-handouts · Custom domain: none',
    // The Settings row's plain words since 0.38.2; the service's address is under Details there.
    'Going live and sharing: Ready · Live sessions run on your Cloudflare account',
  ])
  const noSite = setupStatusLines(connected)
  assert.ok(noSite.includes('Publishing handouts: No site yet — Create talkweaver-handouts · No site yet'), 'the row offers the window\'s one action, in its words')
  assert.ok(setupStatusLines(snapshotOf()).includes('Going live and sharing: — · Polls, questions, reactions, the venue screen, Share for comments'))
  assert.ok(setupStatusLines(snapshotOf({ goingLive: { ...unknownGoingLive('b7'), state: 'not-set-up' } })).some((line) => line.startsWith('Going live and sharing: Not set up — Set up going live')))
  // A second computer on the account, and one whose access was removed: the states, in the row's words, and a count of other computers (never a key or an id).
  const elsewhere = setupStatusJson('status', snapshotOf({ goingLive: { ...unknownGoingLive('b7'), state: 'set-up-elsewhere', updatesFirst: true } }), { ready: false, error: null }).rows.goingLive
  assert.deepEqual([elsewhere.state, elsewhere.label, elsewhere.ready, elsewhere.updatesFirst], ['set-up-elsewhere', 'Set up on another computer — Set up going live on this computer', false, true])
  const removed = setupStatusJson('status', snapshotOf({ goingLive: { ...unknownGoingLive('b7'), state: 'access-removed' } }), { ready: false, error: null }).rows.goingLive
  assert.deepEqual([removed.state, removed.label, removed.ready], ['access-removed', 'This computer\'s access was removed — Set up going live on this computer', false])
  const several = setupStatusJson('status', snapshotOf({ goingLive: { ...unknownGoingLive('b7'), state: 'ready', build: 'b7', others: 2 } }), { ready: true, error: null }).rows.goingLive
  assert.deepEqual([several.label, several.otherComputers, Object.keys(several).filter((key) => /secret|key|token|computerId/i.test(key))], ['Ready · this computer and 2 others', 2, []])
  const choose = setupStatusLines(snapshotOf({ cloudflare: cloudflare({ state: 'choose-account', accounts: [ADA, GRACE] }) }))
  assert.deepEqual(choose.slice(0, 3), ['Cloudflare: Choose an account', `  account ${ADA.id} · ${ADA.name}`, `  account ${GRACE.id} · ${GRACE.name}`])
  assert.ok(setupStatusLines(READY_ALL).includes('Transcription: Not set up — optional · Transcribes recorded Runs on this computer. Nothing else needs it. Use Set-up steps, or ask your agent to set it up.'))
  assert.ok(setupStatusLines(READY_ALL).some((line) => line.startsWith('Importer slide pictures: Not available · Pictures of the original slides come from the separate TalkWeaver PPT Extractor app.')))
  assert.ok(setupStatusLines(snapshotOf({ transcription: null, importer: null })).includes('Transcription: — · Could not be told.'), 'a row that could not be told says so')

  const document = setupStatusJson('status', READY_ALL, { ready: true, error: null })
  const shape = (value) => (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, shape(inner)])) : typeof value)
  assert.deepEqual(shape(document), {
    format: 'string', command: 'string', ready: 'boolean', error: 'null',
    cloudflare: { connection: { state: 'string', label: 'string', account: { id: 'string', name: 'string' }, accounts: 'array', lastCheckedAt: 'string', ready: 'boolean' }, notice: 'null', details: 'null' },
    rows: {
      publishing: { state: 'string', label: 'string', detail: 'string', ready: 'boolean', project: 'string', permission: 'null', customDomain: 'string', stale: 'boolean' },
      goingLive: { state: 'string', label: 'string', detail: 'string', ready: 'boolean', address: 'string', build: 'string', appBuild: 'string', updateDue: 'boolean', otherComputers: 'null', updatesFirst: 'boolean', permission: 'null', reason: 'null', details: 'null' },
      shareLink: { state: 'string', label: 'null', detail: 'string', ready: 'boolean', host: 'string', permission: 'null', stale: 'boolean' },
      recording: { state: 'string', label: 'string', detail: 'string', ready: 'boolean', bucket: 'string', missing: 'array', notice: 'null' },
      transcription: { state: 'string', label: 'string', detail: 'string', ready: 'boolean', pythonVersion: 'null', ffmpeg: 'null' },
      importer: { state: 'string', label: 'string', detail: 'string', ready: 'boolean', available: 'boolean', url: 'string' },
    },
  }, 'the --json document has the shape resources/agent-setup/setup-command.md documents')
  const unknownRows = setupStatusJson('status', snapshotOf({ transcription: null, importer: null }), { ready: false, error: null }).rows
  assert.equal(unknownRows.transcription.state, 'unknown')
  assert.equal(unknownRows.importer.state, 'unknown')
  const reference = readFileSync(new URL('../resources/agent-setup/setup-command.md', import.meta.url), 'utf8')
  for (const key of ['format', 'command', 'ready', 'error', 'connection', 'publishing', 'goingLive', 'shareLink', 'recording', 'transcription', 'importer', 'updateDue', 'stale', 'usage', SETUP_JSON_FORMAT]) {
    assert.ok(reference.includes(`"${key}"`) || reference.includes(`\`${key}\``), `the reference names ${key}`)
  }
  for (const state of ['no-token', 'checking', 'connected', 'choose-account', 'rejected', 'unreachable', 'storage-unavailable', 'no-site', 'set-up-elsewhere', 'access-removed', 'not-attached', 'bucket-not-found', 'ffmpeg-not-found', 'not-available']) {
    assert.ok(reference.includes(`\`${state}\``), `the reference lists the state ${state}`)
  }
  assert.ok(commandReady({ kind: 'status' }, READY_ALL) && !commandReady({ kind: 'status' }, connected), 'status is ready with the connection, publishing and going live; the rest are optional')
  ok('the lines are the window\'s words for every row; the --json document has a stable shape, documented in resources/agent-setup/')

  // ── 7. Standard input: piped, and typed with nothing shown; fails closed ─────────────────────
  class FakeInput extends EventEmitter {
    constructor(tty, raw = 'works') { super(); this.isTTY = tty; this.isRaw = false; this.raw = []; this.paused = false; this.rawBehaviour = raw; if (raw === 'missing') this.setRawMode = undefined }
    setRawMode(mode) {
      this.raw.push(mode)
      if (this.rawBehaviour === 'throws') throw new Error('EINVAL')
      // Node's tty.ReadStream: a refused raw mode is an 'error' event, and isRaw stays as it was.
      if (this.rawBehaviour === 'emits') { this.emit('error', new Error('setRawMode EIO')); return this }
      if (this.rawBehaviour === 'silent') return this
      this.isRaw = mode
      return this
    }
    resume() { this.paused = false } pause() { this.paused = true }
  }
  const HINT = 'printf … | TalkWeaver setup cloudflare connect'
  const noInterrupts = () => () => {}
  const read = (input, output, prompts = ['Token:'], interrupts = noInterrupts) => readSecretInput(input, output, prompts, HINT, interrupts)
  const rejection = async (promise) => { try { await promise; return null } catch (error) { return error } }
  const piped = new FakeInput(false)
  const pipedRead = read(piped, { write() {} })
  piped.emit('data', Buffer.from(`${TOKEN.slice(0, 10)}`)); piped.emit('data', `${TOKEN.slice(10)}\n`); piped.emit('end'); piped.emit('close')
  assert.equal(await pipedRead, `${TOKEN}\n`)
  const empty = new FakeInput(false)
  const emptyRead = read(empty, { write() {} })
  empty.emit('end')
  assert.equal(await emptyRead, null, 'input that ended with nothing in it: nothing given (the one "keep")')
  const huge = new FakeInput(false)
  const hugeRead = read(huge, { write() {} })
  huge.emit('data', Buffer.alloc(70 * 1024, 65)); huge.emit('end')
  const tooLong = await rejection(hugeRead)
  assert.ok(tooLong instanceof SecretInputError && tooLong.reason === 'too-long' && tooLong.message === INPUT_TOO_LONG_ERROR, 'too much input: refused, not "nothing given"')
  for (const event of ['error', 'close']) {
    const broken = new FakeInput(false)
    const brokenRead = read(broken, { write() {} })
    broken.emit('data', 'part')
    broken.emit(event, event === 'error' ? new Error(`EIO ${TOKEN}`) : undefined)
    const failure = await rejection(brokenRead)
    assert.ok(failure instanceof SecretInputError && failure.reason === 'read-failed' && !failure.message.includes(TOKEN), `a piped ${event} before the end: refused`)
  }
  const tty = new FakeInput(true)
  const shown = []
  const typedRead = read(tty, { write: (text) => shown.push(text) }, ['Key id:', 'Secret:'])
  tty.emit('data', `${KEY_ID}x\u007f\r`)
  await new Promise((done) => setImmediate(done))
  tty.emit('data', `${KEY_SECRET}\n`)
  assert.equal(await typedRead, `${KEY_ID}\n${KEY_SECRET}`)
  assert.deepEqual(shown, ['Key id: ', '\n', 'Secret: ', '\n'], 'in a terminal only the prompts are written: nothing typed is shown')
  assert.deepEqual(tty.raw, [true, false, true, false], 'raw mode (no echo) for each answer, then back')
  const returnAlone = new FakeInput(true)
  const returnRead = read(returnAlone, { write() {} }, ['Key id:', 'Secret:'])
  returnAlone.emit('data', '\r')
  assert.equal(await returnRead, null, 'Return alone at the first prompt: nothing given')
  const cancelled = new FakeInput(true)
  const cancelRead = read(cancelled, { write() {} })
  cancelled.emit('data', 'abc\u0003')
  const cancel = await rejection(cancelRead)
  assert.ok(cancel instanceof SecretInputError && cancel.reason === 'cancelled', 'Ctrl-C: refused, not "nothing given"')
  assert.deepEqual(cancelled.raw, [true, false])
  // A terminal that cannot hide what is typed: refused before any prompt, nothing read.
  for (const behaviour of ['missing', 'throws', 'emits', 'silent']) {
    const plain = new FakeInput(true, behaviour)
    const written = []
    const plainRead = read(plain, { write: (text) => written.push(text) })
    plain.emit('data', `${TOKEN}\r`)
    const refusal = await rejection(plainRead)
    assert.ok(refusal instanceof SecretInputError && refusal.reason === 'cannot-hide', `no raw mode (${behaviour}): refused`)
    assert.equal(refusal.message, `This terminal cannot hide what you type. Pipe the token in instead: ${HINT}`)
    assert.deepEqual(written, [], 'no prompt invites typing')
    assert.equal(plain.listenerCount('data'), 0, 'nothing is read')
  }
  // close and error while a hidden answer is awaited: raw mode restored, refused.
  for (const event of ['close', 'error', 'end']) {
    const closing = new FakeInput(true)
    const closingRead = read(closing, { write() {} })
    closing.emit('data', 'abc')
    closing.emit(event, event === 'error' ? new Error('EIO') : undefined)
    const failure = await rejection(closingRead)
    assert.ok(failure instanceof SecretInputError && failure.reason === 'read-failed', `${event} mid-answer: refused`)
    assert.deepEqual(closing.raw, [true, false], `${event} mid-answer: the terminal is put back`)
    assert.equal(closing.listenerCount('data'), 0)
  }
  // An interrupt (SIGINT from outside) while an answer is awaited.
  let interrupt = null
  let stopped = 0
  const interruptible = new FakeInput(true)
  const interruptRead = read(interruptible, { write() {} }, ['Token:'], (handler) => { interrupt = handler; return () => { stopped += 1 } })
  interruptible.emit('data', 'abc')
  interrupt()
  const interrupted = await rejection(interruptRead)
  assert.ok(interrupted instanceof SecretInputError && interrupted.reason === 'cancelled', 'SIGINT: refused')
  assert.deepEqual(interruptible.raw, [true, false], 'SIGINT: the terminal is put back')
  assert.equal(stopped, 1, 'and the interrupt handler is removed')
  ok('standard input: piped text to its end, or each answer typed with nothing shown; too long, unreadable, closed early, cancelled or a terminal that cannot hide input: refused with a fixed sentence and the terminal put back')

  // ── 8. TalkWeaver open on the same folder: refused (Owner, 10 Oct) ───────────────────────────
  assert.equal(APP_OPEN_ERROR, 'TalkWeaver is open. Quit it and run this again, or use Settings → Cloudflare.')
  assert.equal(appOpenRefusal(['cloudflare', 'connect']), APP_OPEN_ERROR, 'plain: the sentence alone')
  assert.deepEqual(JSON.parse(appOpenRefusal(['cloudflare', 'connect', '--json'])), { format: SETUP_JSON_FORMAT, command: null, ready: false, state: APP_OPEN_STATE, error: APP_OPEN_ERROR })
  assert.equal(APP_OPEN_STATE, 'app-open')
  assert.equal(appOpenRefusal(['cloudflare', 'connect', TOKEN]), APP_OPEN_ERROR, 'nothing typed is repeated back')
  // The wiring (the e2e proves the behaviour): setup asks for the app's lock, and refuses before any of its work.
  const indexSource = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const top = indexSource.slice(0, indexSource.indexOf('// Renderer heap headroom'))
  assert.match(top, /const holdsInstanceLock = app\.requestSingleInstanceLock\(SETUP_ARGS \? SETUP_LOCK_DATA : undefined\)/, 'setup takes the same lock as the app')
  const setupBranch = top.slice(top.indexOf('if (SETUP_ARGS) {'), top.indexOf('} else if (!holdsInstanceLock)'))
  assert.match(setupBranch, /if \(!holdsInstanceLock\) \{[\s\S]*?appOpenRefusal\(SETUP_ARGS\)[\s\S]*?app\.exit\(1\)\n  \}/, 'no lock: the refusal, exit 1')
  assert.ok(!setupBranch.includes("on('second-instance'"), 'the setup process listens for no second launch')
  assert.match(top, /talkweaverSetup === true\) return/, 'an open app brings nothing forward for a refused setup')
  assert.match(indexSource, /app\.on\('activate', \(\) => \{\s*\/\/[^\n]*\n\s*if \(SETUP_ARGS \|\| !holdsInstanceLock\) return/, 'activate opens no window in the setup process')
  for (const gone of ['setup-changes', 'setup:changed', 'onSetupChanged', 'deferredVerifyMs', '.settled()']) assert.ok(!indexSource.includes(gone), `no ${gone} left in the main process`)
  ok('TalkWeaver open on the same folder: setup takes its lock or refuses at once with exit 1 and the fixed sentence (--json: state app-open)')

  // ── 9. The operations over the real connection and the fake Cloudflare API ───────────────────
  const api = createFakeCloudflare({ sites: [], accounts: [ADA, GRACE], zones: [{ id: 'zone-grace-0001', name: 'handouts.example', account: GRACE.id }], tokens: { [TOKEN]: { accounts: [ADA.id, GRACE.id] } } })
  const secrets = memorySecrets()
  const config = {}
  const apiFetch = fakeCloudflareFetch(api)
  let settingsChangedCalls = 0
  const connection = createCloudflareConnection({
    secrets: secrets.store,
    settings: {
      read: () => ({ accountId: config.cfAccountId ?? '', project: config.cfPagesProject ?? '', baseUrl: '', shareDomain: config.shareDomain ?? '', productionBranch: 'main' }),
      write: (patch) => { if (patch.accountId) config.cfAccountId = patch.accountId; if (patch.project) config.cfPagesProject = patch.project },
    },
    fetch: apiFetch, apiBase: () => CLOUDFLARE_API_BASE, timeoutMs: 500,
  })
  const liveCalls = []
  // The REAL live service over the real key store (live-service.ts, live-service-key.ts), wired as the
  // main process wires it, with the set-up sequence against the fake API and a stand-in for the
  // deployed Worker. So `setup cloudflare live` makes a real key, and the output can be searched for it.
  const LIVE_NAME = 'talkweaver-live-sessions'
  const LIVE_BUILD = /export const LIVE_WORKER_BUILD\s*=\s*'([^']+)'/.exec(readFileSync(new URL('../worker/recovery-protocol.ts', import.meta.url), 'utf8'))[1]
  const shippedWorker = workerDistFiles({ repo: fileURLToPath(new URL('..', import.meta.url)), bundle: Buffer.from('// made-up bundle\nexport default { fetch() { return new Response("ok") } }\n') })
  const shippedFiles = () => ({ manifest: shippedWorker.manifestText, bundle: shippedWorker.bundle, config: shippedWorker.configBytes })
  const computer = keyProfile({ config })
  const liveDouble = liveWorkerDouble(api, { account: GRACE.id, name: LIVE_NAME, address: null, build: LIVE_BUILD })
  const accountInUse = () => { const at = connection.status().connection; return at.state === 'connected' ? at.account?.id ?? null : null }
  const liveSequence = { shipped: shippedFiles, expectedBuild: LIVE_BUILD, authorise: () => connection.authoriseLiveDeploy(), fetch: apiFetch, apiBase: () => CLOUDFLARE_API_BASE, timeoutMs: { upload: 2000, request: 2000 } }
  const realLive = createLiveService({
    facts: () => {
      const status = connection.status()
      const at = status.connection
      const held = computer.store.keysFor({ accountId: config.liveWorkerAccountId ?? accountInUse(), workerName: LIVE_NAME, baseUrl: config.liveWorkerBaseUrl ?? null })[0] ?? null
      return {
        connection: at.state === 'connected' && at.account ? 'connected' : at.state === 'checking' || at.state === 'unreachable' ? 'not-checked' : 'not-connected',
        permission: status.liveService.state === 'no-permission' ? 'no-permission' : status.liveService.state === 'not-refused' ? 'not-refused' : 'unknown',
        accountId: accountInUse(),
        key: held ? keyKind(held) : 'none',
        deployed: { baseUrl: config.liveWorkerBaseUrl ?? null, version: config.liveWorkerVersion ?? null, accountId: config.liveWorkerAccountId ?? null },
        appBuild: LIVE_BUILD,
      }
    },
    adminSecret: () => computer.store.keysFor({ accountId: config.liveWorkerAccountId ?? null, workerName: LIVE_NAME, baseUrl: config.liveWorkerBaseUrl ?? null })[0]?.key ?? null,
    deploy: (progress) => deployLiveService({
      ...liveSequence, keys: computer.store, computerName: () => 'Test computer', liveFetch: liveDouble.fetch, live: instantClock().live, progress,
      save: ({ baseUrl, accountId }) => Object.assign(config, { liveWorkerBaseUrl: baseUrl, liveWorkerVersion: LIVE_BUILD, liveWorkerAccountId: accountId }),
    }),
    lookUp: (accountId) => lookUpLiveService({ ...liveSequence, accountId }),
    survey: () => surveyLiveService({ ...liveSequence, liveFetch: liveDouble.fetch, keys: computer.store, live: instantClock().live }),
    forget: () => { delete config.liveWorkerBaseUrl; delete config.liveWorkerVersion; delete config.liveWorkerAccountId },
  })
  /** The keys this computer has made: none of them may ever be printed. */
  const madeKeys = () => computer.entries().map((entry) => entry.key)
  // The stand-in for the main process's `applyShareAddress`: the share-address action with the
  // address set in Settings and the list of hostnames this computer's config holds (`liveWorkerShareDomains`).
  const shareCalls = []
  const listedShareDomains = () => (config.liveWorkerShareDomains ?? []).map((entry) => entry.hostname)
  const applyShareAddress = async () => {
    const now = { wanted: config.shareDomain || null }
    shareCalls.push(now)
    if (!accountInUse() || !config.liveWorkerBaseUrl || config.liveWorkerAccountId !== accountInUse()) return null
    return changeShareAddress({
      authorise: () => connection.authoriseLiveDeploy(), fetch: apiFetch, apiBase: () => CLOUDFLARE_API_BASE, workerName: LIVE_NAME, timeoutMs: 2000,
      records: { read: () => ({ liveWorkerShareDomains: config.liveWorkerShareDomains }), write: (entries) => { config.liveWorkerShareDomains = entries } },
    }, now)
  }
  const recordingWrites = []
  const operations = createSetupOperations({
    connection,
    liveService: { row: () => realLive.row(), look: async (why) => { liveCalls.push('look'); return realLive.look(why) }, refresh: () => { liveCalls.push('refresh'); return realLive.refresh() }, setUp: () => realLive.setUp() },
    recording: { status: () => recordingStorageRow({ endpoint: '', bucket: '', hasKeys: false }), check: async () => {}, saveKeys: (keys) => { recordingWrites.push(['keys', keys]); return { success: true } } },
    transcription: { status: async () => TRANSCRIPTION_OFF, setPaths: async () => TRANSCRIPTION_OFF },
    importer: async () => ({ state: 'unknown', available: true, pointer: null, url: null }),
    publishSettings: {
      read: () => ({ accountId: config.cfAccountId ?? '', project: config.cfPagesProject ?? '', baseUrl: '', workerBaseUrl: '', useShortIds: false, shareDomain: config.shareDomain ?? '' }),
      apply: (next) => { config.cfAccountId = next.accountId || undefined; config.cfPagesProject = next.project || undefined; config.shareDomain = next.shareDomain || ''; settingsChangedCalls += 1; return { success: true, checked: connection.settingsChanged() } },
    },
    recordingSettings: { read: () => ({ endpoint: '', bucket: '', discardSeconds: 20 }), apply: (next) => { recordingWrites.push(['settings', next]) } },
    watchLiveRow: () => () => {},
    applyShareAddress,
  })
  const drive = async (args, stdin = null) => {
    const streams = io(stdin)
    const code = await runSetup(args, streams.io, operations)
    noSecretIn([...streams.out, ...streams.err].join('\n'), `the output of ${args.join(' ')}`)
    for (const key of madeKeys()) assert.ok(![...streams.out, ...streams.err].join('\n').includes(key), `no key of this computer in the output of ${args.join(' ')}`)
    return { code, document: JSON.parse(streams.out.join('\n')) }
  }
  const first = await drive(['cloudflare', 'connect', '--json'], `${TOKEN}\n`)
  assert.equal(first.code, 1, 'two accounts: not ready yet')
  assert.equal(first.document.cloudflare.connection.label, 'Choose an account')
  assert.deepEqual(first.document.cloudflare.connection.accounts, [ADA, GRACE])
  assert.equal(secrets.store.read('cloudflare-token'), TOKEN, 'the token is in the secrets store')
  assert.ok(liveCalls.includes('look'), 'the live service is looked up, as opening Settings does')
  const chosen = await drive(['cloudflare', 'account', GRACE.id, '--json'])
  assert.equal(chosen.code, 0)
  assert.equal(chosen.document.cloudflare.connection.label, 'Connected · Grace Hopper')
  assert.equal(chosen.document.rows.publishing.label, 'No site yet — Create talkweaver-handouts')
  assert.equal(config.cfAccountId, GRACE.id, 'the choice is kept in Settings')
  const notListed = await drive(['cloudflare', 'account', '0000000000000000000000000000dead', '--json'])
  assert.equal(notListed.code, 1)
  assert.equal(notListed.document.error, 'That account is not one this token can see.')
  const site = await drive(['cloudflare', 'create-site', 'my-handouts', '--json'])
  assert.equal(site.code, 0)
  assert.equal(site.document.rows.publishing.label, 'Ready')
  assert.equal(site.document.rows.publishing.project, 'my-handouts')
  assert.equal(settingsChangedCalls, 1, 'the site name went through the window\'s Save')
  assert.ok(api.requests.some((request) => request.method === 'POST' && request.path === `/accounts/${GRACE.id}/pages/projects`), 'the site was created in the chosen account')
  const again = await drive(['cloudflare', 'create-site', 'my-handouts', '--json'])
  assert.equal(again.code, 0, 'asked twice: one site')
  assert.equal(api.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/pages/projects')).length, 1)

  // `setup cloudflare share-domain`: the address goes through the window's Save, and is attached or
  // removed by the share-address action and nothing else. Before going live is set up from this
  // computer there is nothing to attach to: said so, and nothing is asked of the action.
  const SHARE_HOST = 'share.handouts.example'
  const liveScript = `/accounts/${GRACE.id}/workers/scripts/${LIVE_NAME}`
  const domainWrites = (from = 0) => api.requests.slice(from).filter((request) => request.method !== 'GET' && /\/domains/.test(request.path)).map((request) => `${request.method} ${request.path}`)
  const early = await drive(['cloudflare', 'share-domain', SHARE_HOST, '--json'])
  assert.deepEqual([early.code, early.document.error, shareCalls, domainWrites(), config.shareDomain], [1, 'The address is attached when going live is set up: run "setup cloudflare live".', [], [], SHARE_HOST])
  // Going live set up for real: this computer makes its key, and the one secrets request names it alone.
  const liveAt = api.requests.length
  const live = await drive(['cloudflare', 'live', '--json'])
  assert.deepEqual([live.code, live.document.rows.goingLive.ready, madeKeys().length, config.liveWorkerAccountId], [0, true, 1, GRACE.id], `going live is set up\n${JSON.stringify(live.document)}`)
  assert.deepEqual(api.requests.slice(liveAt).filter((request) => request.method === 'PATCH').map((request) => Object.keys(JSON.parse(request.body.toString()).secrets)), [[`ADMIN_SECRET_${computer.entries()[0].computerId}`]])
  assert.deepEqual([domainWrites(liveAt), api.namingSigningSecret()], [[], []], 'set-up attached no domain and named no signing secret')
  // `setup status --json`: the generated key is nowhere in it, nor in the lines without --json.
  const statusJson = await drive(['status', '--json'])
  assert.equal(statusJson.document.rows.goingLive.ready, true)
  const statusText = JSON.stringify(statusJson.document)
  for (const key of madeKeys()) assert.ok(key.length >= 40 && !statusText.includes(key), 'setup status --json holds no key of this computer')
  assert.ok(!statusText.includes(computer.entries()[0].computerId) && !/ADMIN_SECRET|SIGNING/.test(statusText), 'nor its key\'s id, nor a secret\'s name')
  {
    const streams = io()
    assert.equal(await runSetup(['status'], streams.io, operations), statusJson.code)
    for (const key of madeKeys()) assert.ok(![...streams.out, ...streams.err].join('\n').includes(key), 'setup status prints no key')
  }
  // Now there is a live service to attach to: one lookup of that hostname, one attach, no override.
  const attachAt = api.requests.length
  const attached = await drive(['cloudflare', 'share-domain', SHARE_HOST, '--json'])
  assert.deepEqual([attached.code, shareCalls, config.liveWorkerShareDomains], [0, [{ wanted: SHARE_HOST }], [{ hostname: SHARE_HOST, wanted: true }]], `attached\n${JSON.stringify(attached.document)}`)
  assert.deepEqual(domainWrites(attachAt), [`PUT ${liveScript}/domains/records`])
  assert.deepEqual(JSON.parse(api.requests.slice(attachAt).find((request) => request.method === 'PUT').body.toString()), { override_scope: false, override_existing_origin: false, override_existing_dns_record: false, origins: [{ hostname: SHARE_HOST }] })
  assert.equal(attached.document.rows.shareLink.ready, true)
  // --clear: the recorded hostname is removed, and only that.
  const clearAt = api.requests.length
  const cleared = await drive(['cloudflare', 'share-domain', '--clear', '--json'])
  assert.deepEqual([cleared.code, shareCalls.at(-1), config.shareDomain, listedShareDomains(), domainWrites(clearAt).length, api.model.workerDomains.get(GRACE.id)], [0, { wanted: null }, '', [], 1, []])
  assert.match(domainWrites(clearAt)[0], new RegExp(`^DELETE /accounts/${GRACE.id}/workers/domains/[0-9a-f]{32}$`))
  ok('share-domain goes through the share-address action: refused before going live is set up, then one hostname attached with no override and removed by --clear; setup status --json holds no key')

  const gone = await drive(['cloudflare', 'disconnect', '--json'])
  assert.equal(gone.code, 0)
  assert.equal(gone.document.cloudflare.connection.label, 'Not connected')
  assert.equal(secrets.store.has('cloudflare-token'), false, 'the token is gone')
  assert.ok(api.requests.every((request) => !request.path.includes(TOKEN)), 'the token never travels in an address')
  ok('connect, choose an account, create the site and disconnect run on the real connection against the fake API, in the window\'s words')

  // ── 10. Recording: every part checked before anything is saved ──────────────────────────────
  for (const stdin of [`${KEY_ID} x\n${KEY_SECRET}\n`, `{"accessKeyId": "a b", "secretAccessKey": "c"}`]) {
    // The review's scenario: a new endpoint, and keys with a space in them.
    const streams = io(stdin)
    const code = await runSetup(['recording', '--endpoint', R2_ENDPOINT, '--bucket', 'new-bucket', '--json'], streams.io, operations)
    assert.equal(code, 2, 'keys of the wrong shape: a usage error')
    assert.equal(JSON.parse(streams.out.join('')).error, KEYS_SHAPE_ERROR)
  }
  const direct = await operations.setRecording({ endpoint: R2_ENDPOINT, bucket: 'new-bucket' }, { accessKeyId: 'a b', secretAccessKey: KEY_SECRET })
  assert.deepEqual(direct, { ok: false, error: KEYS_SHAPE_ERROR, usage: true }, 'the operation itself checks the keys first')
  assert.deepEqual(recordingWrites, [], 'nothing was saved: not the endpoint, not the bucket, not the keys')
  const good = await runSetup(['recording', '--endpoint', R2_ENDPOINT, '--bucket', 'new-bucket'], io(`${KEY_ID}\n${KEY_SECRET}\n`).io, operations)
  assert.equal(good, 1, 'a good run goes on to the row (the stand-in row is not set up: exit 1)')
  assert.deepEqual(recordingWrites.map(([what]) => what), ['keys', 'settings'], 'then the keys, then the endpoint and bucket')
  ok('recording set-up checks the endpoint, the bucket and the keys before it saves anything; a usage error changes nothing')

  console.log(`\nsetup-cli: ${passed} checks passed`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
