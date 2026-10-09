import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildDeckHtmlFromModel } from '../compiler/scripts/lib/07-assembly.mjs'
import { writeDeckStyles } from './build-deck-styles.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
export const samplerOutlinePath = join(repo, 'docs/layout-sampler-outline.md')
export const samplerArtefactsDir = join(repo, 'artefacts/layout-sampler')

export async function buildLayoutSampler(outputDir = samplerArtefactsDir) {
  writeDeckStyles()
  const source = readFileSync(samplerOutlinePath, 'utf8')
  // The sampler's two videos are test fixtures in e2e/fixtures, outside docs/: name that folder as an
  // allowed root beside the sampler's own (ADR-0036; the compiler's default is the talk's folder alone).
  const model = await prepareSource(samplerOutlinePath, source, 'TalkWeaver Layout Sampler', statSync(samplerOutlinePath), undefined,
    { allowedAssetRoots: [dirname(samplerOutlinePath), join(repo, 'e2e/fixtures')] })
  const html = await buildDeckHtmlFromModel(model)
  mkdirSync(outputDir, { recursive: true })
  const outPath = join(outputDir, 'layout-sampler.html')
  writeFileSync(outPath, html, 'utf8')
  return { model, html, outPath }
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const { model, outPath } = await buildLayoutSampler()
  const unknown = (model.warnings ?? []).filter((warning) => String(warning).startsWith('unknown-trigger:'))
  if (unknown.length) throw new Error(`Sampler has unknown trigger warning(s): ${unknown.join(', ')}`)
  console.log(`layout sampler: ${model.slides.length} slides → ${outPath}`)
}
