// Runs list: where each Run's recording is, for 1,000 older Runs (no segment list) beside a recordings folder
// of 1,000 files (0.45 fix round). Before: `runVoiceHere` per Run read the whole folder once per Run (1,000
// scans, a million names) on the main process, again on every periodic refresh of the Runs view. Now one
// `createRunVoiceProbe` per list request reads it once and stops at each Run's first file. Prints both
// numbers; asserts the answers are identical Run for Run and that the new path stays under a generous budget
// (it trips on a return to per-Run scans, not on machine noise).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunVoiceProbe, runVoiceHere } from '../src/main/recording-paths.ts'

const RUNS = 1000
const BUDGET_MS = 60
const userData = mkdtempSync(join(tmpdir(), 'tw-runs-list-perf-'))
try {
  const recordings = join(userData, 'recordings')
  mkdirSync(recordings)
  const runs = []
  for (let i = 0; i < RUNS; i++) {
    const id = `run-${i.toString(36).padStart(4, '0')}`
    // Older Runs: `audio` with no `segments`. Every other Run has its voice here, some in segments only.
    runs.push({ id, talkSlug: 'perf-talk', audio: { r2Key: `presentations/perf-talk/${id}/audio.webm`, uploaded: i % 3 === 0 } })
    if (i % 2 === 0) writeFileSync(join(recordings, i % 4 === 0 ? `${id}.webm` : `${id}.seg-2.webm`), 'x')
    else writeFileSync(join(recordings, `${id}.json`), '{}')
  }
  // A Run with a segment list, and one with none at all, ride along.
  writeFileSync(join(recordings, 'listed.seg-2.webm'), 'x')
  runs.push({ id: 'listed', talkSlug: 'perf-talk', audio: { segments: [{ file: 'listed.seg-2.webm', startMs: 0, endMs: 1 }] } })
  runs.push({ id: 'silent', talkSlug: 'perf-talk', audio: null })

  const time = (fn) => { const start = performance.now(); const out = fn(); return { out, ms: performance.now() - start } }
  // Warm both paths once (module and file-system caches), then measure.
  runs.slice(0, 5).forEach((run) => runVoiceHere(userData, run))
  createRunVoiceProbe(userData)(runs[0])
  const before = time(() => runs.map((run) => runVoiceHere(userData, run)))
  let best = Infinity, after
  for (let round = 0; round < 3; round++) {
    const measured = time(() => { const here = createRunVoiceProbe(userData); return runs.map((run) => here(run)) })
    if (measured.ms < best) { best = measured.ms; after = measured }
  }

  assert.deepEqual(after.out, before.out, 'the shared probe answers exactly as runVoiceHere does, Run for Run')
  assert.equal(after.out.filter(Boolean).length, RUNS / 2 + 1, 'every Run with a file here says so (and the listed Run)')
  assert.equal(after.out.at(-1), false, 'a Run with no recording has nothing here')
  console.log(`runs list: ${RUNS} older Runs, recordings folder of ${RUNS + 1} files — per Run ${before.ms.toFixed(1)} ms, one probe ${after.ms.toFixed(1)} ms (budget ${BUDGET_MS} ms)`)
  assert.ok(after.ms < BUDGET_MS, `one probe for ${RUNS} Runs took ${after.ms.toFixed(1)} ms (budget ${BUDGET_MS} ms)`)
  console.log('PASS: the Runs list reads the recordings folder once per request and answers as before')
} finally {
  rmSync(userData, { recursive: true, force: true })
}
