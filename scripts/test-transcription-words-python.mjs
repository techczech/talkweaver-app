// Integration (video ticket 01): the bundled transcription script writes word timings on a short
// spoken WAV, and they line up with its SRT the way src/main/transcription.ts reads both.
//
//   npm run test:transcription-words:python
//   TW_PARAKEET_PYTHON=/path/to/venv/bin/python npm run test:transcription-words:python
//
// Needs a Python with parakeet_mlx (TW_PARAKEET_PYTHON, else the environment SETUP.md makes in
// TalkWeaver's user-data folder, else python3), the speech model already in the Hugging Face cache
// (nothing is downloaded), macOS `say` to speak the fixture, and an ffmpeg. Missing any of these, it
// is skipped with a message. Not in `npm test`: it loads a 2.5 GB model.
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { childEnvWithFfmpegDir, resolveFfmpeg, systemFfmpegCandidates } from '../src/main/ffmpeg-path.ts'
import { parseSrt, parseWordsJson } from '../src/main/transcription.ts'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const script = join(repo, 'resources', 'agent-setup', 'transcription', 'parakeet_to_srt.py')
const skip = (why) => { console.log(`SKIP transcription words (Python): ${why}`); process.exit(0) }

if (process.platform !== 'darwin') skip('the fixture is spoken with macOS `say` and Parakeet MLX runs only on macOS')
const candidates = [
  process.env.TW_PARAKEET_PYTHON,
  join(homedir(), 'Library', 'Application Support', 'TalkWeaver', 'transcription', 'venv', 'bin', 'python'),
  join(homedir(), 'Library', 'Application Support', 'talk-weaver', 'transcription', 'venv', 'bin', 'python'),
  'python3'
].filter(Boolean)
const python = candidates.find((p) => spawnSync(p, ['-c', 'import parakeet_mlx'], { timeout: 60_000 }).status === 0)
if (!python) skip('no Python with parakeet_mlx (set TW_PARAKEET_PYTHON to one)')
const modelDir = join(process.env.HF_HOME ?? join(homedir(), '.cache', 'huggingface'), 'hub', 'models--mlx-community--parakeet-tdt-0.6b-v3')
if (!existsSync(modelDir)) skip('the Parakeet model is not in the Hugging Face cache (SETUP.md step 5); nothing is downloaded here')
const ffmpeg = resolveFfmpeg({ configured: '', shipped: [join(repo, 'node_modules', 'ffmpeg-static', 'ffmpeg')], system: systemFfmpegCandidates(process.platform), exists: existsSync })
if (!ffmpeg.found) skip('no ffmpeg (node_modules/ffmpeg-static or a system one)')

const scratch = mkdtempSync(join(tmpdir(), 'tw-transcription-words-python-'))
try {
  const wav = join(scratch, 'speech.wav')
  const sentence = 'Agents can plan their work. Then they check the result, and try again.'
  const said = spawnSync('say', ['-o', wav, '--data-format=LEI16@16000', sentence], { encoding: 'utf8', timeout: 60_000 })
  if (said.status !== 0 || !existsSync(wav)) skip(`macOS say could not write the fixture WAV (${said.stderr?.trim() || said.error})`)

  const srt = join(scratch, 'speech.srt')
  const wordsFile = join(scratch, 'speech.words.json')
  const env = childEnvWithFfmpegDir(ffmpeg.path)
  const help = spawnSync(python, [script, '--help'], { encoding: 'utf8', env, timeout: 60_000 })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /--words WORDS_JSON/)
  console.log('  ok 1. the script offers --words in its help')

  const run = spawnSync(python, [script, wav, '-o', srt, '--words', wordsFile], { encoding: 'utf8', env, timeout: 600_000 })
  assert.equal(run.status, 0, `the script failed:\n${run.stdout}\n${run.stderr}`)
  const segments = parseSrt(readFileSync(srt, 'utf8'))
  const raw = JSON.parse(readFileSync(wordsFile, 'utf8'))
  assert.ok(Array.isArray(raw.words), 'the words file is {"words": [...]}')
  for (const w of raw.words) assert.deepEqual(Object.keys(w).sort(), ['end', 'start', 'text'])
  const words = parseWordsJson(readFileSync(wordsFile, 'utf8'))
  assert.equal(words.length, raw.words.length, 'every word the script wrote is a valid word')
  console.log(`  ok 2. SRT (${segments.length} segments) and words (${words.length}) written: ${words.map((w) => w.text).join(' ')}`)

  assert.ok(words.length >= 8, 'most of the sentence came back as words')
  assert.ok(words.some((w) => /^agents$/i.test(w.text)), 'the first word is heard')
  assert.ok(!words.some((w) => /^[\p{P}]+$/u.test(w.text)), 'no word is punctuation alone: punctuation is attached to its word')
  assert.ok(words.some((w) => /[.,]$/.test(w.text)), 'some word carries its punctuation')
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (i > 0) assert.ok(w.start >= words[i - 1].start, `"${w.text}" starts after the word before`)
    assert.ok(segments.some((s) => w.start >= s.start && w.end <= s.end), `"${w.text}" (${w.start}–${w.end}) lies inside an SRT segment`)
  }
  console.log('  ok 3. words increase, lie inside their segments, punctuation stays on its word')
  console.log('transcription words (Python): 3 checks passed')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
