import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scratch = await mkdtemp(join(tmpdir(), 'tw-compare-library-'))
const baseline = join(scratch, 'baseline')
const vault = join(scratch, 'fixture-private-vault')
const talk = join(vault, 'fixture-private-talk')
const outlinePath = join(talk, 'fixture-private-talk-outline.md')
const outline = `---
auto_title_slide: false
auto_thanks_slide: false
---
# Fixture private deck label

## Fixture private slide title {table}{id=fixture-private-id}{fixture-private-key=fixture-private-value}
{kicker="Fixture private kicker, with spaces"}{table-bands=on}

| Column | Fixture private column |
| --- | --- |
| A | Fixture private cell |

~~~text
{mode=focus}
~~~

<!--
{media-title=overlay}
-->

## Fixture unchanged slide {id=fixture-unchanged-id}

An unchanged paragraph.
`

async function baselineFile(path, contents) {
  const file = join(baseline, path)
  await mkdir(dirname(file), { recursive: true })
  if (contents) await writeFile(file, contents)
  else await copyFile(new URL(`../${path}`, import.meta.url), file)
}

function compare(...flags) {
  return spawnSync(process.execPath, [
    '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
    fileURLToPath(new URL('./release/compare-library.mjs', import.meta.url)),
    baseline, ...flags,
  ], { env: { ...process.env, TW_LIBRARY_ROOT: vault }, encoding: 'utf8' })
}

try {
  await mkdir(talk, { recursive: true })
  await writeFile(outlinePath, outline)
  for (const path of ['src/main/talk-scan.mjs', 'src/main/image-refs.ts', 'compiler/scripts/lib/04-html-extraction.mjs']) {
    await baselineFile(path, `export * from ${JSON.stringify(new URL(`../${path}`, import.meta.url).href)}\n`)
  }
  for (const name of ['table.css', 'zz-scene-stats-chart-table.css']) {
    await baselineFile(`compiler/assets/styles/skin/${name}`)
  }
  // Use the real compiler in both checkouts and simulate one baseline render difference.
  await baselineFile('compiler/scripts/lib/08-source-adapters.mjs', `
    export * from ${JSON.stringify(new URL('../compiler/scripts/lib/08-source-adapters.mjs', import.meta.url).href)}
    import { prepareSource as compile } from ${JSON.stringify(new URL('../compiler/scripts/lib/08-source-adapters.mjs', import.meta.url).href)}
    export async function prepareSource(...args) {
      const model = await compile(...args)
      model.fullHtml = model.fullHtml.replace('<table class="slide-table', () =>
        '<i class="fixture-private-class fixture-private-second-class" title="Fixture private attribute">Fixture private markup</i><table class="slide-table')
      return model
    }
  `)

  const countsOnly = compare()
  assert.equal(countsOnly.stderr, '')
  assert.equal(countsOnly.status, 1)
  const counts = JSON.parse(countsOnly.stdout)
  assert.deepEqual(counts, {
    baselineTalks: 1,
    candidateTalks: 1,
    baselineSections: 2,
    candidateSections: 2,
    changedSections: 1,
    changedTableSections: 1,
    changedMindmapSections: 0,
    changedOtherSections: 0,
    changedPictureKeys: 0,
    unmatchedTalks: 0,
    unmatchedSections: 0,
    errors: 0,
  })

  const detailed = compare('--signatures', '--allow-table-and-mindmap')
  assert.equal(detailed.status, 0, detailed.stderr)
  assert.equal(detailed.stderr, '')
  const [signature, summary, ...extra] = detailed.stdout.trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(extra, [])
  assert.deepEqual(summary, counts)
  assert.equal(signature.talk, 1)
  assert.equal(signature.section, 1)
  const { before, after } = signature
  assert.deepEqual(after.tokens, ['{id=…}', '{kicker=…}', '{layout=table}', '{table-bands=on}'])
  assert.equal(after.layout, 'table')
  assert.deepEqual(before, { ...after, elements: after.elements + 1, classes: after.classes + 2 })
  assert.ok(after.elements > 1 && after.classes > 0)
  assert.doesNotMatch(detailed.stdout, /fixture[ -]private/i)
  assert.deepEqual(await readdir(vault), ['fixture-private-talk'])
  assert.deepEqual(await readdir(talk), ['fixture-private-talk-outline.md'])
  assert.equal(await readFile(outlinePath, 'utf8'), outline)
  console.log('PASS  comparator keeps counts by default and emits only structural signatures on request')
} finally {
  await rm(scratch, { recursive: true, force: true })
}
