import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { startImport } from '../src/main/importer/service.ts'
import { writeImportCleanupPack } from '../src/main/importer/pack.ts'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildPerSlideProjections } from '../compiler/scripts/lib/10-projections.mjs'

const [sourceArg, vaultArg] = process.argv.slice(2)
if (!sourceArg || !vaultArg) {
  throw new Error('Usage: node scripts/smoke-importer-real.mjs <source.pptx> <scratch-vault>')
}

const sourcePath = resolve(sourceArg)
const vaultRoot = resolve(vaultArg)
mkdirSync(vaultRoot, { recursive: true })
const title = basename(sourcePath).replace(/\.pptx$/i, '')
const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'smoke-import'

const detail = await startImport({
  vaultRoot,
  request: {
    sourcePath,
    options: {
      title,
      slug,
      slideRange: '',
      includeHidden: true,
      preserveNotes: true,
      extractMedia: true,
      fallbackPolicy: 'uncertain',
      renderer: 'automatic'
    }
  },
  onProgress: (progress) => process.stdout.write(`${progress.status}\t${progress.completed}/${progress.total}\t${progress.note}\n`)
})

const compiled = await prepareSource(
  detail.manifest.talk.outlinePath,
  detail.outlineContent,
  detail.manifest.talk.slug,
  statSync(detail.manifest.talk.outlinePath)
)
const projections = buildPerSlideProjections(compiled, detail.manifest.talk.slug) ?? []
assert.ok(compiled.fullHtml.length > 1_000, 'generated Outline must compile to presentation HTML')
assert.ok(projections.length >= detail.slides.length, 'compiled projections must retain every imported slide')

const runDir = resolve(detail.manifest.talk.path, 'import-runs', detail.manifest.id)
const packDir = writeImportCleanupPack({
  runDir,
  packId: 'smoke-pack',
  slideNumbers: detail.slides.slice(0, 2).map((slide) => slide.slideNumber),
  passes: ['structural-parity', 'layout-repair'],
  resourcesDir: resolve('resources/agent-import')
})
assert.equal(readFileSync(resolve(packDir, 'CLAUDE.md'), 'utf8'), '@./AGENTS.md')
assert.match(readFileSync(resolve(packDir, 'AGENTS.md'), 'utf8'), /source evidence/i)

process.stdout.write(`${JSON.stringify({
  runId: detail.manifest.id,
  status: detail.manifest.status,
  slides: detail.slides.length,
  renderer: detail.manifest.renderer.status,
  fallback: detail.slides.filter((slide) => slide.decision.representation === 'fallback').length,
  review: detail.slides.filter((slide) => slide.status === 'review').length,
  failed: detail.slides.filter((slide) => slide.status === 'failed').length,
  compiledSlides: projections.length,
  cleanupPack: packDir,
  outlinePath: detail.manifest.talk.outlinePath
}, null, 2)}\n`)
