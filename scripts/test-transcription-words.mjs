// Transcription keeps word timings (video ticket 01; src/main/transcription.ts,
// resources/agent-setup/transcription/parakeet_to_srt.py). Plain Node, no Electron, no Python:
// 1. the parsers as pure functions: the SRT, the script's words file (seconds → milliseconds,
//    punctuation kept on its word, bad entries dropped, ordered), and the --help check;
// 2. real Parakeet output (10 s of the recorded-talk voice, words and SRT as the bundled script
//    wrote them): every word inside its segment, starts increasing;
// 3. test mode (TW_REC_TEST, the fixture): transcript and words both written, words inside their
//    segments, transcript:get says words exist;
// 4. the real job path with a stand-in engine (node scripts as "python" and "ffmpeg"; POSIX only):
//    a script that offers --words writes both files, and its --help is asked once; a script without
//    the option still transcribes on a first run, and preserves earlier words on a re-run; re-transcribing replaces the words file by rename with no temp left;
//    cancelling leaves the previous transcript and words intact; unsafe names and a canonical transcript
//    linked outside are refused before anything is written;
// 5. injected staging/publication failures preserve the complete inline pair (hasWords true);
//    extra sidecars never change a stored pair; this session's crash leftovers (<name>.<pid>.<time>.tmp) are swept at a run's start;
// 6. the --help probe: before the transcode, cancellable, a hung one killed (SIGTERM then SIGKILL)
//    and not remembered, and an edited script asked again.
import { strict as assert } from 'node:assert'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTranscription, parseSrt, parseWordsJson, scriptOffersWords } from '../src/main/transcription.ts'

const scratch = mkdtempSync(join(tmpdir(), 'tw-transcription-words-'))
let passed = 0
const ok = (label) => { passed += 1; console.log(`  ok ${passed}. ${label}`) }

/** Every word lies inside one segment, and starts never go backwards. */
function assertWordsOnSegments(words, segments, label) {
  assert.ok(words.length > 0, `${label}: there are words`)
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    assert.ok(w.end >= w.start, `${label}: "${w.text}" ends after it starts`)
    if (i > 0) assert.ok(w.start >= words[i - 1].start, `${label}: "${w.text}" starts after "${words[i - 1].text}"`)
    assert.ok(segments.some((s) => w.start >= s.start && w.end <= s.end), `${label}: "${w.text}" (${w.start}–${w.end}) lies inside a segment`)
  }
}

// Real output of the bundled script (Parakeet tdt-0.6b-v3) on the first 10 s of the recorded-talk voice.
const REAL_SRT = `1
00:00:00,400 --> 00:00:07,680
Okay, so what do you need to know about agents?

2
00:00:07,680 --> 00:00:08,720
So how does it work?

3
00:00:08,720 --> 00:00:09,840
On the one hand we have a chatbot.
`
const REAL_WORDS = JSON.stringify({ words: [
  { text: 'Okay,', start: 0.4, end: 1.92 }, { text: 'so', start: 1.92, end: 2.24 }, { text: 'what', start: 2.32, end: 2.56 },
  { text: 'do', start: 2.56, end: 2.72 }, { text: 'you', start: 2.72, end: 2.8 }, { text: 'need', start: 2.8, end: 2.96 },
  { text: 'to', start: 2.96, end: 3.12 }, { text: 'know', start: 3.12, end: 3.36 }, { text: 'about', start: 3.36, end: 3.68 },
  { text: 'agents?', start: 3.68, end: 7.68 }, { text: 'So', start: 7.68, end: 7.84 }, { text: 'how', start: 8.0, end: 8.16 },
  { text: 'does', start: 8.16, end: 8.4 }, { text: 'it', start: 8.4, end: 8.48 }, { text: 'work?', start: 8.48, end: 8.72 },
  { text: 'On', start: 8.72, end: 8.8 }, { text: 'the', start: 8.8, end: 8.88 }, { text: 'one', start: 8.88, end: 9.04 },
  { text: 'hand', start: 9.04, end: 9.12 }, { text: 'we', start: 9.2, end: 9.28 }, { text: 'have', start: 9.28, end: 9.36 },
  { text: 'a', start: 9.36, end: 9.44 }, { text: 'chatbot.', start: 9.44, end: 9.84 }
] })

const NEW_HELP = `usage: parakeet_to_srt.py [-h] [-o OUTPUT] [--model MODEL]
                          [--chunk-seconds CHUNK_SECONDS] [--words WORDS_JSON]
                          audio

options:
  -o OUTPUT, --output OUTPUT
                        Output .srt path
  --words WORDS_JSON    Also write word timings as JSON
`
const OLD_HELP = `usage: parakeet_to_srt.py [-h] [-o OUTPUT] [--model MODEL] [--chunk-seconds CHUNK_SECONDS] audio

Generate SRT subtitles from audio with Parakeet MLX. Writes no words.
  --chunk-seconds CHUNK_SECONDS
                        Chunk length (0 = whole file); --wordsmith is not an option
`

try {
  // ── 1. Parsers ──
  {
    const segments = parseSrt(REAL_SRT)
    assert.deepEqual(segments.map((s) => [s.start, s.end]), [[400, 7680], [7680, 8720], [8720, 9840]])
    assert.equal(segments[0].text, 'Okay, so what do you need to know about agents?')
    ok('parseSrt: segments in milliseconds, text joined')

    const words = parseWordsJson(REAL_WORDS)
    assert.equal(words.length, 23)
    assert.deepEqual(words[0], { text: 'Okay,', start: 400, end: 1920 })
    assert.deepEqual(words[9], { text: 'agents?', start: 3680, end: 7680 })
    assert.ok(words.every((w) => Number.isInteger(w.start) && Number.isInteger(w.end)), 'whole milliseconds')
    ok('parseWordsJson: seconds to whole milliseconds, punctuation stays on its word')

    const messy = parseWordsJson(JSON.stringify({ words: [
      { text: ' later ', start: 2.0, end: 2.5 },
      { text: 'earlier', start: 1.0, end: 0.9 }, // end before start: raised to the start
      { text: '', start: 0.1, end: 0.2 },
      { text: 'nan', start: 'x', end: 1 },
      { text: 'inf', start: 1, end: Infinity },
      null,
      { start: 3, end: 4 },
      { text: 'same-start-second', start: 2.0, end: 2.1 }
    ] }))
    assert.deepEqual(messy, [
      { text: 'earlier', start: 1000, end: 1000 },
      { text: 'later', start: 2000, end: 2500 },
      { text: 'same-start-second', start: 2000, end: 2100 }
    ])
    assert.deepEqual(parseWordsJson('[{"text":"bare","start":0.5,"end":0.75}]'), [{ text: 'bare', start: 500, end: 750 }])
    assert.deepEqual(parseWordsJson('not json'), [])
    assert.deepEqual(parseWordsJson('{"segments":[]}'), [])
    assert.deepEqual(parseWordsJson('null'), [])
    ok('parseWordsJson: bad entries dropped, ordered by start (stable), a bare list accepted, junk gives none')

    assert.equal(scriptOffersWords(NEW_HELP), true)
    assert.equal(scriptOffersWords('  --words=PATH  write words'), true)
    assert.equal(scriptOffersWords(OLD_HELP), false)
    assert.equal(scriptOffersWords(''), false)
    const bundled = readFileSync(new URL('../resources/agent-setup/transcription/parakeet_to_srt.py', import.meta.url), 'utf8')
    assert.match(bundled, /add_argument\(\s*"--words"/, 'the bundled script declares --words')
    ok('scriptOffersWords: the new help offers words, an older help (and a look-alike) does not')
  }

  // ── 2. Real Parakeet output: words inside their segments ──
  assertWordsOnSegments(parseWordsJson(REAL_WORDS), parseSrt(REAL_SRT), 'real Parakeet output')
  ok('real Parakeet output: every word inside its SRT segment, starts increasing')

  // ── 3. Test mode ──
  {
    const vault = join(scratch, 'fixture-vault')
    const talkDir = join(vault, '_PRESENTATIONS', 'fixture-talk')
    mkdirSync(talkDir, { recursive: true })
    const tx = createTranscription({
      userDataDir: () => join(scratch, 'fixture-user-data'),
      vaultRoot: () => vault,
      config: () => ({ python: '', script: '' }),
      readiness: () => { throw new Error('test mode must not ask for readiness') },
      testMode: () => true
    })
    const notes = []
    const result = await tx.run('fixture-talk', 'sess-fixture', (n) => notes.push(n))
    assert.equal(result.ok, true)
    assert.equal(result.hasWords, true)
    const transcript = JSON.parse(readFileSync(join(talkDir, 'sess-fixture.transcript.json'), 'utf8'))
    const stored = JSON.parse(readFileSync(join(talkDir, 'sess-fixture.transcript.json'), 'utf8'))
    assert.equal(stored.engine, 'parakeet')
    assert.ok(!Number.isNaN(Date.parse(stored.createdAt)))
    assert.deepEqual(Object.keys(stored).sort(), ['createdAt', 'engine', 'segments', 'words'])
    assertWordsOnSegments(stored.words, transcript.segments, 'fixture')
    assert.ok(stored.words.every((w) => Object.keys(w).sort().join() === 'end,start,text'))
    const read = await tx.get('fixture-talk', 'sess-fixture')
    assert.equal(read.hasWords, true)
    assert.deepEqual(read.segments, transcript.segments)
    assert.deepEqual(notes, ['Fixture transcript written.'])
    ok('test mode: transcript and words committed together; words inside segments; get says words exist')
  }

  // ── 4. The job path with a stand-in engine ──
  if (process.platform === 'win32') {
    console.log('  SKIP stand-in engine: POSIX shell launchers only')
  } else {
    const bin = join(scratch, 'bin')
    mkdirSync(bin)
    const log = join(scratch, 'engine.log')
    writeFileSync(log, '')
    // ffmpeg: writes whatever is asked as the last argument.
    const ffJs = join(bin, 'fake-ffmpeg.mjs')
    writeFileSync(ffJs, `import { appendFileSync, writeFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(log)}, 'ffmpeg\\n')\nwriteFileSync(process.argv.at(-1), 'RIFF')\n`)
    const ffmpeg = join(bin, 'ffmpeg')
    writeFileSync(ffmpeg, `#!/bin/sh\nexec "${process.execPath}" "${ffJs}" "$@"\n`)
    chmodSync(ffmpeg, 0o755)
    // The engine: `<node> <script> <wav> -o <srt> [--words <json>]`, one generated file per behaviour.
    // helpHang: 'sleep' waits for a kill; 'ignore-term' also ignores SIGTERM (only SIGKILL stops it).
    const engine = (name, { offersWords, wordsText = 'hello', sleep = false, helpHang = null }) => {
      const path = join(bin, `${name}.mjs`)
      writeFileSync(path, `
import { appendFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name)} + ' ' + args.join(' ') + '\\n')
if (args.includes('--help') && ${JSON.stringify(helpHang)}) {
  if (${JSON.stringify(helpHang)} === 'ignore-term') process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000); await new Promise(() => {})
}
if (args.includes('--help')) { console.log(${JSON.stringify(offersWords ? NEW_HELP : OLD_HELP)}); process.exit(0) }
const wi = args.indexOf('--words')
if (wi >= 0 && !${offersWords}) { console.error('error: unrecognized arguments: --words'); process.exit(2) }
console.log('Transcribing… 50%')
${sleep ? 'setTimeout(() => console.log("Still transcribing…"), 100); setInterval(() => {}, 1000); await new Promise(() => {})' : ''}
writeFileSync(args[args.indexOf('-o') + 1], '1\\n00:00:00,500 --> 00:00:02,000\\n${wordsText} there.\\n\\n2\\n00:00:02,000 --> 00:00:03,250\\nSecond line.\\n')
if (wi >= 0) writeFileSync(args[wi + 1], JSON.stringify({ words: [
  { text: '${wordsText}', start: 0.5, end: 0.9 }, { text: 'there.', start: 1.0, end: 2.0 },
  { text: 'Second', start: 2.0, end: 2.6 }, { text: 'line.', start: 2.64, end: 3.25 }
] }))
`)
      return path
    }
    const newScript = engine('new-engine', { offersWords: true })
    const newScript2 = engine('new-engine-again', { offersWords: true, wordsText: 'goodbye' })
    const oldScript = engine('old-engine', { offersWords: false })
    const slowScript = engine('slow-engine', { offersWords: true, sleep: true })

    const vault = join(scratch, 'vault')
    const userData = join(scratch, 'user-data')
    const talkDir = join(vault, '_PRESENTATIONS', 'my-talk')
    mkdirSync(talkDir, { recursive: true })
    mkdirSync(join(userData, 'recordings'), { recursive: true })
    const sid = 'sess-20261019-101500-a'
    writeFileSync(join(userData, 'recordings', `${sid}.webm`), 'webm')
    writeFileSync(join(talkDir, `${sid}.json`), JSON.stringify({ id: sid, talkSlug: 'my-talk', audio: { segments: [{ file: `${sid}.webm`, startMs: 0, endMs: 4000 }] } }))
    const transcriptFile = join(talkDir, `${sid}.transcript.json`)
    // Words are now part of the one canonical transcript; the legacy sidecar is inert.
    const wordsFile = transcriptFile
    const legacyWordsFile = join(talkDir, `${sid}.words.json`)
    const readWords = () => JSON.stringify(JSON.parse(readFileSync(transcriptFile, 'utf8')).words)

    let script = newScript
    // File operations with faults injected by name: fault(op, path) returns true to fail that call.
    let fault = () => false
    const fail = (op, path) => { if (fault(op, path)) throw new Error(`injected ${op} failure`) }
    const files = {
      writeFile: (path, text) => { fail('writeFile', path); writeFileSync(path, text, 'utf8') },
      rename: (from, to) => { fail('rename', to); renameSync(from, to) },
      remove: (path) => { fail('remove', path); rmSync(path, { force: true }) }
    }
    // The real probe timeout (30 s) for every case but the hung probe, which gets its own service.
    const service = (extra = {}) => createTranscription({
      files,
      userDataDir: () => userData,
      vaultRoot: () => vault,
      config: () => ({ python: process.execPath, script }),
      // Engine/locale selection cannot override the authoritative expanded program paths.
      selection: () => ({ locale: 'en-US', python: 'must-not-run', script: 'must-not-run' }),
      readiness: () => ({
        row: { state: 'ready', pythonVersion: '3.11', ffmpeg: null, ffmpegConfigured: false },
        ffmpeg: { found: true, path: ffmpeg, source: 'configured' }
      }),
      testMode: () => false,
      ...extra
    })
    const tx = service()
    const helpCalls = (name) => readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith(`${name} `) && l.endsWith('--help')).length
    const tempsIn = (dir) => readdirSync(dir).filter((f) => f.endsWith('.tmp'))

    // a. A script that offers words: both files.
    const notes = []
    const first = await tx.run('my-talk', sid, (n) => notes.push(n))
    assert.deepEqual(first.ok ? 'ok' : first.error, 'ok')
    assert.equal(first.hasWords, true)
    const transcript = JSON.parse(readFileSync(transcriptFile, 'utf8'))
    const stored = JSON.parse(readFileSync(transcriptFile, 'utf8'))
    assert.equal(stored.engine, 'parakeet')
    assert.equal(stored.createdAt, transcript.createdAt, 'words and transcript carry one creation time')
    assert.deepEqual(stored.words[0], { text: 'hello', start: 500, end: 900 })
    assertWordsOnSegments(stored.words, transcript.segments, 'stand-in engine')
    assert.ok(readFileSync(log, 'utf8').includes(' -o '), 'the engine got -o')
    assert.match(readFileSync(log, 'utf8'), /new-engine \S+ -o \S+\.srt --words \S+\.words\.json/)
    assert.ok(notes.some((n) => /4 word timings/.test(n)), 'the progress says words were written')
    const order = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l === 'ffmpeg' ? 'ffmpeg' : l.endsWith('--help') ? 'help' : 'engine')
    assert.deepEqual(order, ['help', 'ffmpeg', 'engine'], 'the --help probe runs before the transcode')
    assert.ok(notes.indexOf('Checking the transcription script.') >= 0 && notes.indexOf('Checking the transcription script.') < notes.findIndex((n) => /Converting/.test(n)), 'a note while the probe runs, before the transcode')
    assert.equal((await tx.get('my-talk', sid)).hasWords, true)
    ok('a script that offers --words: transcript and words both written, words inside segments')

    await tx.run('my-talk', sid, null)
    assert.equal(helpCalls('new-engine'), 1, 'the help is asked once for one configured script')
    ok('the --help answer is remembered per configured script')

    for (const [name, output] of [['missing', null], ['malformed', '{'], ['wrong-shape', '{}'], ['bad-item', '{"words":[{"text":"bad","start":"x","end":1}]}']]) {
      const invalidScript = join(bin, `invalid-${name}.mjs`)
      let body = readFileSync(newScript2, 'utf8').replaceAll('new-engine-again', `invalid-${name}`)
      body = body.slice(0, body.indexOf('if (wi >= 0) writeFileSync'))
      if (output !== null) body += `if (wi >= 0) writeFileSync(args[wi + 1], ${JSON.stringify(output)})`
      writeFileSync(invalidScript, body)
      script = invalidScript
      const previous = readFileSync(transcriptFile, 'utf8')
      const invalid = await tx.run('my-talk', sid, null)
      assert.equal(invalid.ok, false, name)
      assert.match(invalid.error, /word timings/i)
      assert.equal(readFileSync(transcriptFile, 'utf8'), previous, `${name}: preserve the previous atomic transcript and words`)
      assert.deepEqual(tempsIn(talkDir), [])
    }
    script = newScript
    ok('missing and invalid advertised words fail without replacing the previous transcript')

    // b. Re-transcribing replaces the words file whole (rename: a new file), no temp left behind.
    script = newScript2
    const before = statSync(wordsFile).ino
    const again = await tx.run('my-talk', sid, null)
    assert.equal(again.ok, true)
    assert.equal(JSON.parse(readFileSync(transcriptFile, 'utf8')).words[0].text, 'goodbye')
    assert.notEqual(statSync(wordsFile).ino, before, 'the complete transcript was renamed into place, not rewritten in place')
    assert.deepEqual(tempsIn(talkDir), [])
    assert.equal(helpCalls('new-engine-again'), 1, 'a newly configured script is asked once')
    ok('re-transcribing commits segments and words with one rename')

    // c. Cancelling leaves the previous transcript and words exactly as they were.
    script = slowScript
    const keptTranscript = readFileSync(transcriptFile, 'utf8')
    const keptWords = readWords()
    let cancelled
    const packageAbort = new AbortController()
    let heartbeat
    const stillRunning=new Promise(resolve=>{heartbeat=resolve})
    const started = new Promise((resolve) => {
      cancelled = tx.run('my-talk', sid, (n) => { if (n.startsWith('Transcribing')) resolve(); if(n.startsWith('Still transcribing'))heartbeat() }, packageAbort.signal)
    })
    await started
    assert.deepEqual(await tx.run('my-talk', sid, null), { ok: false, error: 'busy' })
    assert.deepEqual(await service().run('my-talk', sid, null), { ok: false, error: 'busy' }, 'a captured-vault package and normal IPC share one transcription writer')
    assert.deepEqual(service().cancel(),{ok:true},'a foreign transcription service cannot cancel this package job')
    let heartbeatTimeout
    try{await Promise.race([stillRunning,new Promise((_,reject)=>{heartbeatTimeout=setTimeout(()=>reject(new Error('foreign cancel stopped the owning engine')),2000)})])}finally{clearTimeout(heartbeatTimeout)}
    packageAbort.abort()
    assert.deepEqual(await cancelled, { ok: false, error: 'cancelled' })
    assert.equal(readFileSync(transcriptFile, 'utf8'), keptTranscript)
    assert.equal(readWords(), keptWords)
    assert.deepEqual(tempsIn(talkDir), [])
    ok('cancelling leaves the previous transcript and words intact')

    // d. Legacy engines with segments still save a manual re-run, as on main.
    script = oldScript
    const plain = await tx.run('my-talk', sid, null)
    assert.equal(plain.ok, true)
    assert.equal(plain.hasWords, false)
    assert.equal(plain.segments.length, 2)
    assert.deepEqual(JSON.parse(readFileSync(transcriptFile, 'utf8')).segments, plain.segments)
    assert.deepEqual(JSON.parse(readFileSync(transcriptFile, 'utf8')).words, [])
    ok('a legacy engine without words saves its segments over a previous transcript')
    const sid2 = 'sess-20261019-111500-b'
    writeFileSync(join(userData, 'recordings', `${sid2}.webm`), 'webm')
    writeFileSync(join(talkDir, `${sid2}.json`), JSON.stringify({ id: sid2, talkSlug: 'my-talk', audio: { segments: [{ file: `${sid2}.webm`, startMs: 0, endMs: 4000 }] } }))
    const firstPlain = await tx.run('my-talk', sid2, null)
    assert.equal(firstPlain.ok, true)
    assert.equal(firstPlain.hasWords, false)
    const firstFile=join(talkDir, `${sid2}.transcript.json`)
    assert.equal(JSON.parse(readFileSync(firstFile, 'utf8')).segments.length, 2)
    assert.deepEqual(JSON.parse(readFileSync(firstFile,'utf8')).words, [], 'wordless first transcription commits an explicit empty inline word list')
    assert.deepEqual(JSON.parse(readFileSync(firstFile,'utf8')).sentences, [], 'v2 keeps sentence storage explicit when a legacy script supplies no words')
    assert.ok(!readFileSync(log, 'utf8').split('\n').some((l) => l.startsWith('old-engine ') && l.includes('--words')), 'the old script was never given --words')
    const read = await tx.get('my-talk', sid2)
    assert.equal(read.hasWords, false)
    assert.equal(read.segments.length, 2)
    assert.ok(!existsSync(join(talkDir, `${sid2}.words.json`)))
    assert.equal(helpCalls('old-engine'), 1)
    ok('a script without --words still transcribes a first Run: no words file, no error, get says words are absent')

    // e. Unsafe names and a canonical transcript linked outside are refused before any write.
    script = newScript
    const outside = join(scratch, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.words.json'), 'secret')
    const sid3 = 'sess-20261019-121500-c'
    writeFileSync(join(userData, 'recordings', `${sid3}.webm`), 'webm')
    writeFileSync(join(talkDir, `${sid3}.json`), JSON.stringify({ id: sid3, talkSlug: 'my-talk', audio: { segments: [{ file: `${sid3}.webm`, startMs: 0, endMs: 4000 }] } }))
    symlinkSync(join(outside, 'secret.words.json'), join(talkDir, `${sid3}.words.json`))
    writeFileSync(join(outside, 'secret.transcript.json'), 'author transcript')
    symlinkSync(join(outside, 'secret.transcript.json'), join(talkDir, `${sid3}.transcript.json`))
    const listing = () => [...readdirSync(talkDir).sort(), '|', ...readdirSync(outside).sort(), '|', ...readdirSync(scratch).sort()]
    const beforeRefusals = listing()
    const logBefore = readFileSync(log, 'utf8')
    for (const [slug, id, error] of [
      ['../my-talk', sid, 'unsafe-talk-slug'],
      [' my-talk', sid, 'unsafe-talk-slug'],
      ['my-talk', '../../etc/passwd', 'unsafe-session-id'],
      ['my-talk', 'sess/../x', 'unsafe-session-id'],
      ['my-talk', sid3, 'unsafe-path']
    ]) {
      assert.deepEqual(await tx.run(slug, id, null), { ok: false, error }, `run(${JSON.stringify(slug)}, ${JSON.stringify(id)})`)
      assert.equal(await tx.get(slug, id), null)
    }
    assert.deepEqual(listing(), beforeRefusals, 'nothing was written or removed')
    assert.equal(readFileSync(join(outside, 'secret.words.json'), 'utf8'), 'secret')
    assert.equal(readFileSync(log, 'utf8'), logBefore, 'no engine was started')
    assert.equal(readFileSync(join(outside, 'secret.transcript.json'), 'utf8'), 'author transcript')
    ok('unsafe names and a canonical transcript linked outside are refused, nothing written')

    // f. A words file on disk always belongs to the transcript beside it, whatever fails.
    const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'))
    const fresh = async () => {
      fault = () => false
      script = newScript
      const r = await tx.run('my-talk', sid, null)
      assert.equal(r.hasWords, true)
      return { transcript: readFileSync(transcriptFile, 'utf8'), words: readWords() }
    }
    // f1. The single publication rename fails: the entire old pair remains untouched.
    let prev = await fresh()
    let failPublish = true
    fault = (op, path) => {
      if (op === 'rename' && path === transcriptFile && failPublish) { failPublish = false; return true }
      return false
    }
    script = newScript
    const blocked = await tx.run('my-talk', sid, null)
    assert.equal(blocked.ok, false)
    assert.match(blocked.error, /transcript and word timings could not be saved/)
    assert.equal(readFileSync(transcriptFile, 'utf8'), prev.transcript, 'the transcript was not replaced')
    assert.equal(readWords(), prev.words, 'the words still belong to it')
    assert.equal((await tx.get('my-talk', sid)).hasWords, true)
    // ...and the same when the replacement words differ.
    failPublish = true
    script = newScript2
    assert.equal((await tx.run('my-talk', sid, null)).ok, false)
    assert.equal(readFileSync(transcriptFile, 'utf8'), prev.transcript)
    ok('publication failure preserves the entire old pair')

    // f2. Either new-words write/rename fails: the entire old pair survives.
    for (const op of ['writeFile', 'rename']) {
      prev = await fresh()
      fault = (o, path) => o === op && path.startsWith(wordsFile)
      script = newScript2
      const wordNotes = []
      const r = await tx.run('my-talk', sid, (n) => wordNotes.push(n))
      assert.equal(r.ok, false, `${op}: saving the pair fails`)
      assert.equal(readFileSync(transcriptFile, 'utf8'), prev.transcript, `${op}: the old transcript survives`)
      assert.equal(readJson(transcriptFile).segments[0].text, 'hello there.')
      assert.equal(readWords(), prev.words, `${op}: the old words survive`)
      assert.deepEqual(tempsIn(talkDir), [], `${op}: no temp left`)
      assert.match(r.error, /injected.*failure/, 'the injected write or rename failure reaches the caller')
      assert.equal((await tx.get('my-talk', sid)).hasWords, true)
    }
    ok('new words that cannot be written: the entire old pair survives, without temps')

    // f3. The transcript replacement fails: the entire previous pair survives.
    prev = await fresh()
    fault = (op, path) => op === 'rename' && path === transcriptFile
    const noTranscript = await tx.run('my-talk', sid, null)
    assert.equal(noTranscript.ok, false)
    assert.equal(readFileSync(transcriptFile, 'utf8'), prev.transcript)
    assert.equal(readWords(), prev.words, 'a failed transcript rename preserves the previous words')
    assert.equal((await tx.get('my-talk', sid)).hasWords, true)
    assert.deepEqual(tempsIn(talkDir), [])
    ok('a transcript that cannot be written: run fails and the entire old pair survives')

    // f4. Stale or invalid extra sidecars cannot change the authoritative inline words.
    await fresh()
    const beforeExtra = readFileSync(transcriptFile,'utf8')
    writeFileSync(legacyWordsFile, JSON.stringify({engine:'parakeet',createdAt:'2020-01-01T00:00:00.000Z',words:[{text:'stale',start:0,end:1}]}))
    assert.equal((await tx.get('my-talk', sid)).hasWords, true)
    assert.equal(readFileSync(transcriptFile,'utf8'),beforeExtra)
    writeFileSync(legacyWordsFile, 'not json')
    assert.equal((await tx.get('my-talk', sid)).hasWords, true)
    assert.equal(readFileSync(transcriptFile,'utf8'),beforeExtra)
    assert.equal(readFileSync(legacyWordsFile,'utf8'),'not json', 'reading never deletes or repairs extra files')
    ok('get ignores stale and invalid sidecars; the newer inline pair stays unchanged')

    // g. Leftover temps of this session from a crash are removed at the start of a run; nothing else is.
    fault = () => false
    const stale = [`${sid}.transcript.json.123.abc.tmp`, `${sid}.words.json.9.z0.tmp`]
    const keep = [`${sid}.words.json.tmp`, `sess-other.words.json.1.a.tmp`, `${sid}x.words.json.1.a.tmp`, `${sid}.words.json.1.a.tmp.bak`, `${sid}.json.1.a.tmp`]
    for (const n of [...stale, ...keep]) writeFileSync(join(talkDir, n), 'x')
    assert.equal((await tx.run('my-talk', sid, null)).ok, true)
    for (const n of stale) assert.ok(!existsSync(join(talkDir, n)), `${n} removed`)
    for (const n of keep) assert.ok(existsSync(join(talkDir, n)), `${n} kept`)
    for (const n of keep) rmSync(join(talkDir, n))
    ok("this session's stale transcript/words temps are swept at the start of a run, nothing else")

    // h. The probe: cancelled during it (no WAV made); hung past its time (killed, not cached, not busy); re-asked after an edit.
    const hangScript = engine('hang-help', { offersWords: true, helpHang: 'sleep' })
    script = hangScript
    let probeRun
    const probing = new Promise((resolve) => { probeRun = tx.run('my-talk', sid, (n) => { if (n.startsWith('Checking')) setTimeout(resolve, 150) }) })
    await probing
    const ffmpegBefore = readFileSync(log, 'utf8').split('\n').filter((l) => l === 'ffmpeg').length
    tx.cancel()
    assert.deepEqual(await probeRun, { ok: false, error: 'cancelled' })
    assert.equal(readFileSync(log, 'utf8').split('\n').filter((l) => l === 'ffmpeg').length, ffmpegBefore, 'no transcode after a cancel during the probe')
    ok('cancelling during the --help probe stops before the transcode')

    const stubborn = engine('stubborn-help', { offersWords: true, helpHang: 'ignore-term' })
    script = stubborn
    const quick = service({ probeTimeoutMs: 500 })
    assert.equal((await quick.get('my-talk', sid)).hasWords, true, 'the timeout re-run starts with stored words')
    const t0 = Date.now()
    const afterHang = await quick.run('my-talk', sid, null)
    assert.equal(afterHang.ok, true)
    assert.equal(afterHang.hasWords, false)
    assert.equal(afterHang.segments.length, 2, 'a timed-out words probe still permits the returned segments')
    assert.deepEqual(JSON.parse(readFileSync(transcriptFile, 'utf8')).segments, afterHang.segments)
    assert.ok(Date.now() - t0 < 10_000, 'the hung probe was given up (SIGTERM, then SIGKILL after the grace)')
    // Not remembered: the second run probes again, so it too waits out the timeout and the kill grace
    // (2 s at least). Timed by the service's own clock, not by the stand-in's log, which a loaded
    // machine may never reach before the kill.
    const t1 = Date.now()
    const repeatedHang = await quick.run('my-talk', sid, null)
    assert.equal(repeatedHang.ok, true, 'not left busy: the second attempt saves its segments too')
    assert.equal(repeatedHang.hasWords, false)
    assert.deepEqual(JSON.parse(readFileSync(transcriptFile, 'utf8')).segments, repeatedHang.segments)
    assert.ok(Date.now() - t1 >= 2_000, 'a probe that timed out is not remembered: the next run asks again')
    ok('a --help that ignores SIGTERM is killed after the grace; not cached; the service is free again')

    script = newScript
    const askedBefore = helpCalls('new-engine')
    await tx.run('my-talk', sid, null)
    assert.equal(helpCalls('new-engine'), askedBefore, 'unchanged script: answer remembered')
    writeFileSync(newScript, readFileSync(newScript, 'utf8') + '\n// edited\n')
    await tx.run('my-talk', sid, null)
    assert.equal(helpCalls('new-engine'), askedBefore + 1, 'edited script: asked again')
    ok('the --help answer is keyed on the script file: an edited script is asked again')

    const beforeMissing = readFileSync(log, 'utf8')
    writeFileSync(join(talkDir, `${sid}.json`), JSON.stringify({ id: sid, talkSlug: 'my-talk', audio: { segments: [] } }))
    assert.deepEqual(await tx.run('my-talk', sid, null), { ok: false, error: 'The local audio file for this Run is missing.' })
    assert.equal(readFileSync(log, 'utf8'), beforeMissing, 'unlisted audio never reaches the engine')
    assert.equal(readFileSync(join(userData, 'recordings', `${sid}.webm`), 'utf8'), 'webm', 'original audio is untouched')
    ok('a Run with no recorded segments refuses orphan audio without changing the original')

  }

  console.log(`transcription words: ${passed} checks passed`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
