// Width compensation guard: on a neutral dense fixture, each bundled face's lines must run within a narrow band of
// Trebuchet MS's widths (the face the Ocean look was fitted against in 0.44.0), overall, per role and for text at 40px and
// above. Without the per-face size-adjust in zz-x-ocean-05-type.css Inter text runs about 4% wide and serif text about
// 12% narrow, and this test fails. Measurement: scripts/measure-typeface-widths.mjs (one browser, hard timeout, closed in finally).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const fixture = 'scripts/fixtures/ocean-look/dense-widths-outline.md'
const dir = mkdtempSync(join(tmpdir(), 'tw-widths-test-'))
try {
  const json = join(dir, 'widths.json')
  const run = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'scripts/measure-typeface-widths.mjs', '--json', json, '--timeout-ms', '240000', fixture], { encoding: 'utf8', timeout: 270000 })
  assert.equal(run.status, 0, `measurement failed:\n${run.stdout}\n${run.stderr}`)
  const { result } = JSON.parse(readFileSync(json, 'utf8'))
  const band = { all: [0.985, 1.015], text: [0.98, 1.02], textLarge: [0.98, 1.02], display: [0.97, 1.03] }
  for (const face of ['inter', 'serif', 'geist']) {
    for (const [role, [lo, hi]] of Object.entries(band)) {
      const ratio = result[face]?.[role]?.ratio
      assert.ok(ratio >= lo && ratio <= hi, `${face} ${role} width ratio ${ratio} outside ${lo}–${hi} of Trebuchet`)
    }
  }
  console.log(`typeface widths: ${['inter', 'serif', 'geist'].map((f) => `${f} ${result[f].all.ratio} (text ${result[f].text.ratio}, display ${result[f].display.ratio})`).join('; ')} of Trebuchet on the dense fixture`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
