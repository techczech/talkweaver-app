import { strict as assert } from 'node:assert'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { join, resolve } from 'node:path'
import { CLEAN_SVG, HISTORICAL_SVG_BYPASSES } from './fixtures/svg-sanitiser-cases.mjs'

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)))
const scratch = mkdtempSync(join(repo, '.tw-svg-sanitiser-parity-'))
const dom = new JSDOM('')
const previousWindow = globalThis.window
const previousDomParser = globalThis.DOMParser
globalThis.window = dom.window
globalThis.DOMParser = dom.window.DOMParser

try {
  const sourceModule = await import(
    new URL(`../src/shared/objects/sanitise-svg.ts?parity=${Date.now()}`, import.meta.url)
  )
  const compilerModule = await import(
    new URL('../compiler/assets/vendor/svg-sanitiser.mjs', import.meta.url)
  )
  assert.equal(
    typeof compilerModule.sanitiseSvgForCompiler,
    'function',
    'compiler ships a self-contained SVG sanitiser entry point'
  )

  const cases = [
    { name: 'clean sample', source: CLEAN_SVG, expected: 'accept' },
    ...HISTORICAL_SVG_BYPASSES.map((item) => ({ ...item, expected: 'reject' }))
  ]
  for (const item of cases) {
    const sourceResult = sourceModule.sanitiseSvg(item.source)
    const compilerResult = compilerModule.sanitiseSvgForCompiler(item.source)
    const sourceVerdict = 'svg' in sourceResult ? 'accept' : 'reject'
    const compilerVerdict = 'svg' in compilerResult ? 'accept' : 'reject'
    assert.equal(sourceVerdict, item.expected, `source verdict for ${item.name}`)
    assert.equal(compilerVerdict, sourceVerdict, `compiler parity for ${item.name}`)
    if (sourceVerdict === 'accept') {
      assert.equal(compilerResult.svg, sourceResult.svg, `compiler output for ${item.name}`)
    }
  }

  const regenerated = join(scratch, 'svg-sanitiser.mjs')
  const rebuild = spawnSync(
    process.execPath,
    [join(repo, 'scripts/build-compiler-svg-sanitiser.mjs'), '--outfile', regenerated],
    { cwd: repo, encoding: 'utf8' }
  )
  assert.equal(
    rebuild.status,
    0,
    `SVG sanitiser regeneration failed:\n${rebuild.stdout}\n${rebuild.stderr}`
  )
  assert.deepEqual(
    readFileSync(regenerated),
    readFileSync(join(repo, 'compiler/assets/vendor/svg-sanitiser.mjs')),
    'compiler SVG sanitiser bundle is stale; run npm run generate:compiler-svg-sanitiser'
  )

  console.log(`compiler SVG sanitiser parity: ${cases.length}/${cases.length} identical verdicts, accepted outputs identical, committed bundle fresh`)
} finally {
  if (typeof previousWindow === 'undefined') delete globalThis.window
  else globalThis.window = previousWindow
  if (typeof previousDomParser === 'undefined') delete globalThis.DOMParser
  else globalThis.DOMParser = previousDomParser
  dom.window.close()
  rmSync(scratch, { recursive: true, force: true })
}
