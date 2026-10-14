// Layout Doctor, plain view ticket 15: who pays for the stranded-title-icon scan.
//
// Finding a title's icon on its layout line reads the whole outline with the compiler's facts
// (title-icon-restore.ts strandedTitleIcons → plain-view-compiler-facts.ts compilerFactsOf): tens of
// milliseconds on a long talk. The editor scans the outline for inline conflict marks on every
// document change (extensions/idProtect.ts inlineConflictFindings → scanOutlineTriggers), so that
// scan must never reach it. The Doctor's own callers ask for it by option and still report it.
//
// The real renderer modules are bundled with the two functions counted: every import of
// title-icon-restore.ts and plain-view-compiler-facts.ts from another module goes through a wrapper
// that counts calls of strandedTitleIcons and compilerFactsOf and passes them on.
//
//   node scripts/test-layout-doctor-stranded-icon-scan-callers.mjs
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const COUNTED = {
  'title-icon-restore': 'strandedTitleIcons',
  'plain-view-compiler-facts': 'compilerFactsOf'
}
const counting = {
  name: 'count-stranded-icon-scan',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /(?:title-icon-restore|plain-view-compiler-facts)(?:\.ts)?$/ }, async (args) => {
      if (args.namespace === 'counted' || args.pluginData?.real) return undefined
      const real = await pluginBuild.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: { real: true } })
      if (real.errors.length) return { errors: real.errors }
      return { path: real.path, namespace: 'counted' }
    })
    pluginBuild.onLoad({ filter: /.*/, namespace: 'counted' }, (args) => {
      const name = COUNTED[Object.keys(COUNTED).find((key) => args.path.includes(key))]
      const from = JSON.stringify(args.path)
      return {
        resolveDir: dirname(args.path),
        loader: 'js',
        // A module's own export wins over the same name from `export *`.
        contents: [
          `export * from ${from}`,
          `import { ${name} as real } from ${from}`,
          `export function ${name}(...args) {`,
          `  const calls = (globalThis.__strandedScanCalls ??= {})`,
          `  calls.${name} = (calls.${name} ?? 0) + 1`,
          '  return real(...args)',
          '}'
        ].join('\n')
      }
    })
  }
}

const bundleDir = mkdtempSync(join(tmpdir(), 'talk-weaver-stranded-scan-callers-'))
const bundleUrl = pathToFileURL(join(bundleDir, 'bundle.mjs'))
let runtime
try {
  await build({
    stdin: {
      contents: [
        "export { inlineConflictFindings } from './src/renderer/src/extensions/idProtect.ts'",
        "export { scanOutlineTriggers, unresolvedTriggerFindings } from './src/shared/layout-doctor.ts'"
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'test-layout-doctor-stranded-icon-scan-callers-entry.ts'
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    plugins: [counting],
    logLevel: 'silent',
    outfile: fileURLToPath(bundleUrl)
  })
  runtime = await import(`${bundleUrl.href}?t=${Date.now()}`)
} finally {
  rmSync(bundleDir, { recursive: true, force: true })
}
const { inlineConflictFindings, scanOutlineTriggers, unresolvedTriggerFindings } = runtime

const calls = () => ({ strandedTitleIcons: 0, compilerFactsOf: 0, ...globalThis.__strandedScanCalls })
const reset = () => { globalThis.__strandedScanCalls = {} }

// A long talk in the state the earlier preview builds left it: every title's icon on its layout
// line, and one conflict the editor marks inline.
const SLIDES = 300
const lines = ['# Talk', '', '## Part', '']
for (let n = 1; n <= SLIDES; n += 1) lines.push(`### Slide ${n}`, '{icon=lucide:star} {reveal}', `Text ${n}.`, '')
lines.push('### Conflict', '{cards}{cards}', '- A', '- B', '', '### Value', '{accent=banana}', 'Text.', '')
const text = lines.join('\n')

// The Doctor's callers ask, and get the finding: this also proves the counters are wired in.
reset()
const doctor = scanOutlineTriggers(text, undefined, { strandedTitleIcons: true })
assert.equal(doctor.filter((finding) => finding.kind === 'stranded-title-icon').length, SLIDES, 'the Doctor reports every title whose icon is on its layout line')
assert.deepEqual(
  doctor.find((finding) => finding.kind === 'stranded-title-icon'),
  { kind: 'stranded-title-icon', token: 'icon=lucide:star', line: 6, headingLine: 5, slideTitle: 'Slide 1', detail: 'This slide\'s icon is on the layout line, so it is not drawn on the title.' }
)
assert.deepEqual(calls(), { strandedTitleIcons: 1, compilerFactsOf: 1 }, 'the Doctor\'s scan reads the outline with the compiler\'s facts, once')

// The editor's scan, as it runs on every document change: the same marks as ever, and the outline is
// never read for stranded icons.
reset()
const KEYSTROKES = 25
let typed = text
let inline = []
for (let n = 0; n < KEYSTROKES; n += 1) {
  typed += 'x'
  inline = inlineConflictFindings(typed)
}
assert.deepEqual(calls(), { strandedTitleIcons: 0, compilerFactsOf: 0 }, `${KEYSTROKES} document changes in the editor never read the outline for stranded icons`)
assert.ok(inline.length > 0 && inline.every((finding) => finding.kind !== 'stranded-title-icon'), 'the editor still marks its own conflicts, and only those')
assert.deepEqual(inline, doctor.filter((finding) => finding.kind === 'trigger-conflict' || finding.kind === 'duplicate-layout' || finding.kind === 'unregistered-value'), 'the same inline marks the Doctor lists')

// Off unless asked for: the plain scan and the publishing check do not pay either.
reset()
assert.ok(scanOutlineTriggers(text).every((finding) => finding.kind !== 'stranded-title-icon'), 'the scan does not report it unless asked')
assert.deepEqual(unresolvedTriggerFindings(text).map((finding) => finding.kind), ['unregistered-value'], 'the publishing check reads what it always did')
assert.deepEqual(calls(), { strandedTitleIcons: 0, compilerFactsOf: 0 }, 'neither the plain scan nor the publishing check reads the outline for stranded icons')

// The callers, by their source: the editor's scan passes no options; the Doctor's three callers ask.
const source = (path) => readFileSync(join(root, path), 'utf8')
assert.match(source('src/renderer/src/extensions/idProtect.ts'), /return scanOutlineTriggers\(text\)\n/, 'idProtect.ts scans without options')
assert.doesNotMatch(source('src/renderer/src/extensions/idProtect.ts'), /strandedTitleIcons|title-icon-restore|compilerFactsOf/)
for (const path of ['src/renderer/src/components/LayoutDoctorPanel.tsx', 'src/renderer/src/components/WorkspaceLayout.tsx', 'src/main/index.ts']) {
  assert.match(source(path), /scanOutlineTriggers\([^\n]*\{ strandedTitleIcons: true \}\)/, `${path} asks for the stranded-icon scan`)
}

console.log(`PASS test-layout-doctor-stranded-icon-scan-callers (${SLIDES} slides: the Doctor's scan reads the compiler's facts once; ${KEYSTROKES} editor changes never do)`)
