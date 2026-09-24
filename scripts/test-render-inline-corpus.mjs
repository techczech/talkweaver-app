import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import {
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Standing corpus-fidelity gate for compiler renderInline.
 *
 * Regeneration procedure:
 *   1. Run `node scripts/test-render-inline-corpus.mjs --regenerate-neutral`.
 *   2. Review the invented Markdown lines and their renderer outputs together.
 *   3. Run the standing test. Historical whole-repository comparisons can be run separately
 *      with `--compare-ref=<known-good-commit>` when reviewing a renderer change.
 *
 * The committed npm test does not depend on git history. `--compare-ref` is the review-time gate
 * that extracts a historical module to a cleaned `.tw-` file beside the compiler module so its
 * relative imports resolve exactly as they did in production.
 */

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)))
const fixturePath = join(repo, 'scripts/fixtures/inline-corpus.md')
const snapshotPath = join(repo, 'scripts/fixtures/inline-corpus.snapshot.json')
const currentModuleUrl = pathToFileURL(join(repo, 'compiler/scripts/lib/02-triggers-layout.mjs'))
const { renderInline } = await import(`${currentModuleUrl.href}?inline-corpus=${Date.now()}`)

const MARK_CASES = [
  'the ==feedback is the lesson== here',
  '==**bold inside**==',
  'a == b == c',
  '====',
  '==x <script>==',
  '`x==y` coerces but `x===y`',
  '2==2 and 3==3',
  'let a==b, c==d;',
  'a==b==c',
  '===x===',
  '`==x==`',
  '==a== and ==b==',
  '==a=b==',
  'prose ==real mark== then `**opt** /==eq==/` end',
  '`**flag**` and ==this matters==',
  '`**start**` then ==mark==',
  'before `**middle**` then ==mark==',
  '==mark== then `**end**`',
  '[EEF report](https://eef.example "The ==key== finding")',
  '[read ==x== now](https://ex.com/report)'
]

const INLINE_SHAPES = [
  ['star-bold', /\*\*[^*\n]+\*\*/],
  ['star-italic', /(^|[^*])\*[^*\n]+\*/],
  ['underscore-bold', /__[^_\n]+__/],
  ['underscore-italic', /(^|[^\w`])_[^_\n]+_(?!\w)/],
  ['single-backtick-code', /(^|[^`])`[^`\n]+`(?!`)/],
  ['multi-backtick-code', /``+[^`\n]+``+/],
  ['markdown-link', /\[[^\]\n]+\]\([^)]+\)/],
  ['markdown-link-title', /\]\(\s*[^)\s]+\s+"[^"\n]*"\s*\)/],
  ['relative-markdown-link', /\]\(\s*[#./]/],
  ['mailto-markdown-link', /\]\(\s*mailto:/i],
  ['bare-http-url', /(^|[\s(])https?:\/\//i],
  ['url-with-trailing-punctuation', /https?:\/\/[^\s<]+[.,;:)\]](?:\s|$)/i],
  ['emphasis-and-code', /(?:\*\*|__)[^`\n]*`|`[^*\n]*(?:\*\*|__)/],
  ['emphasis-and-link', /(?:\*\*|__)[^[\n]*\[|\][^*\n]*(?:\*\*|__)/],
  ['html-escaping-characters', /[<>&"]/]
]

function optionValue(prefix) {
  const argument = process.argv.find((value) => value.startsWith(`${prefix}=`))
  return argument?.slice(prefix.length + 1)
}

function markdownFiles() {
  const listed = execFileSync('rg', ['--files', '-g', '*.md'], {
    cwd: repo,
    encoding: 'utf8'
  })
    .split('\n')
    .filter(Boolean)
    .filter((path) => path !== relative(repo, fixturePath))
  const sampler = 'docs/layout-sampler-outline.md'
  if (!listed.includes(sampler)) listed.push(sampler)
  return [...new Set(listed)].sort()
}

function repositoryLines() {
  const lines = []
  for (const path of markdownFiles()) {
    const content = readFileSync(join(repo, path), 'utf8')
    content.split(/\r?\n/).forEach((source, lineIndex) => {
      if (!source || source.length > 800 || source.includes('==')) return
      const shapes = INLINE_SHAPES
        .filter(([, pattern]) => pattern.test(source))
        .map(([name]) => name)
      if (shapes.length === 0) return
      lines.push({ path, line: lineIndex + 1, source, shapes })
    })
  }
  return lines
}

function curatedCorpus() {
  const examples = [
    '**bold** and *italic* words',
    '__strong__ beside _emphasis_',
    '`inline code` and ``long code``',
    '[chapter](./chapter.md) and [section](#section)',
    '[manual](https://example.com/manual "A useful title")',
    '[contact](mailto:author@example.com)',
    'See https://example.com/guide, then continue.',
    '**bold with `code` inside**',
    '**bold [link](https://example.com/page) inside**',
    '<tag> & "quoted text"',
    '*italic with **strong** inside*',
    '[**strong label**](../notes.md)',
    'An escaped \*asterisk\* and _quiet emphasis_',
    'Use `a == b` beside **a result**',
    'Visit https://example.com/path.) after the note.'
  ]
  const lines = Array.from({ length: 480 }, (_, index) =>
    `Example ${String(index + 1).padStart(3, '0')}: ${examples[index % examples.length]}.`
  )
  for (const [shape, pattern] of INLINE_SHAPES) {
    assert(lines.some((line) => pattern.test(line)), `neutral corpus lacks ${shape}`)
  }
  return [...lines, ...MARK_CASES]
}

async function historicalRenderer(reference) {
  const source = execFileSync(
    'git',
    ['show', `${reference}:compiler/scripts/lib/02-triggers-layout.mjs`],
    { cwd: repo, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
  )
  const tempPath = join(
    dirname(fileURLToPath(currentModuleUrl)),
    `.tw-render-inline-${process.pid}-${Date.now()}.mjs`
  )
  writeFileSync(tempPath, source)
  try {
    const oldModule = await import(`${pathToFileURL(tempPath).href}?reference=${Date.now()}`)
    assert.equal(typeof oldModule.renderInline, 'function', `${reference} exports renderInline`)
    return oldModule.renderInline
  } finally {
    rmSync(tempPath, { force: true })
  }
}

function fixtureLines() {
  return readFileSync(fixturePath, 'utf8').replace(/\n$/, '').split('\n')
}

async function regenerate() {
  const lines = curatedCorpus()
  const outputs = lines.map(renderInline)
  writeFileSync(fixturePath, `${lines.join('\n')}\n`)
  writeFileSync(snapshotPath, `${JSON.stringify({
    version: 1,
    reference: 'neutral invented corpus',
    lineCount: lines.length,
    markCaseCount: MARK_CASES.length,
    outputs
  }, null, 2)}\n`)
  console.log(`regenerated neutral inline corpus: ${lines.length} lines`)
}

function standingFixtureTest() {
  const lines = fixtureLines()
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'))
  assert.equal(lines.length, snapshot.lineCount, 'fixture line count matches its frozen snapshot')
  assert.equal(snapshot.outputs.length, lines.length, 'snapshot has one output per fixture line')
  const mismatches = []
  lines.forEach((line, index) => {
    const actual = renderInline(line)
    const expected = snapshot.outputs[index]
    if (actual !== expected) mismatches.push({ line: index + 1, source: line, expected, actual })
  })
  assert.equal(
    mismatches.length,
    0,
    `renderInline changed ${mismatches.length}/${lines.length} curated lines:\n${JSON.stringify(mismatches.slice(0, 12), null, 2)}`
  )
  console.log(`standing inline corpus: ${lines.length}/${lines.length} byte-identical`)
}

async function compareWholeRepository(reference) {
  const renderReferenceInline = await historicalRenderer(reference)
  let totalLines = 0
  let permittedMarkLines = 0
  const mismatches = []
  for (const path of markdownFiles()) {
    const lines = readFileSync(join(repo, path), 'utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      totalLines += 1
      if (line.includes('==')) {
        permittedMarkLines += 1
        return
      }
      const expected = renderReferenceInline(line)
      const actual = renderInline(line)
      if (actual !== expected) {
        mismatches.push({ path, line: index + 1, source: line, expected, actual })
      }
    })
  }
  assert.equal(
    mismatches.length,
    0,
    `renderInline changed ${mismatches.length} ==-free lines against ${reference}:\n${JSON.stringify(mismatches.slice(0, 12), null, 2)}`
  )
  console.log(
    `whole-repository inline corpus: ${totalLines - permittedMarkLines}/${totalLines - permittedMarkLines} ==-free lines byte-identical; ${permittedMarkLines} == lines permitted to diverge`
  )
}

const reference = optionValue('--reference') ?? optionValue('--compare-ref')
if (process.argv.includes('--regenerate-neutral')) {
  await regenerate()
} else {
  if (reference) await compareWholeRepository(reference)
  standingFixtureTest()
  console.log('test:render-inline-corpus OK')
}
