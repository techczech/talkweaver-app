import { strict as assert } from 'node:assert'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import sharp from 'sharp'
import ts from 'typescript'
import { buildLayoutSampler, samplerArtefactsDir, samplerOutlinePath } from '../scripts/build-layout-sampler.mjs'

const repo = resolve(new URL('..', import.meta.url).pathname)
const sampleImage = join(repo, 'docs/assets/sample-image.png')
const registryPath = join(repo, 'src/shared/layout-registry/entries.ts')
const reportPath = join(repo, 'docs/layout-sampler-unverified-report.md')
const screenshotsDir = join(samplerArtefactsDir, 'screenshots')

const explicitHosts = {
  section: 'section-divider',
  '2col': 'columns'
}

function normalise(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function literalValue(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literalValue)
  return undefined
}

function registryEntries() {
  const sourceText = readFileSync(registryPath, 'utf8')
  const source = ts.createSourceFile(registryPath, sourceText, ts.ScriptTarget.Latest, true)
  let layouts
  source.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return
    for (const declaration of node.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === 'LAYOUTS' && ts.isArrayLiteralExpression(declaration.initializer)) {
        layouts = declaration.initializer
      }
    }
  })
  assert(layouts, 'LAYOUTS registry is present')
  return layouts.elements.map((entry) => {
    assert(ts.isObjectLiteralExpression(entry), 'registry entry is an object literal')
    const out = {}
    for (const property of entry.properties) {
      if (!ts.isPropertyAssignment(property)) continue
      const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null
      if (key) out[key] = literalValue(property.initializer)
    }
    return out
  })
}

function hostFor(entry, slides) {
  const explicit = explicitHosts[entry.name]
  if (explicit) return slides.find((slide) => slide.id === explicit)
  const key = normalise(entry.name)
  return slides.find((slide) => normalise(slide.id).includes(key))
    ?? slides.find((slide) => normalise(slide.title).includes(key))
    ?? slides.find((slide) => normalise(slide.layout) === key)
}

function safeFileName(value) {
  return String(value).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'slide'
}

assert(existsSync(sampleImage), 'layout sampler must ship its committed sample image asset')
const imageMetadata = await sharp(sampleImage).metadata()
assert(imageMetadata.format === 'png' && imageMetadata.width > 1 && imageMetadata.height > 1, 'sample image is a decodable PNG placeholder')
assert(existsSync(reportPath), 'unverified sampler report is present')

const { model, html, outPath } = await buildLayoutSampler()
assert(existsSync(outPath) && statSync(outPath).size > 1000, 'sampler bundle is written by the real compiler')
assert(html.includes('<section'), 'sampler bundle contains compiled slide sections')
const unknownWarnings = (model.warnings ?? []).filter((warning) => String(warning).startsWith('unknown-trigger:'))
assert.deepEqual(unknownWarnings, [], `sampler has no unknown trigger warnings: ${unknownWarnings.join(', ')}`)

const entries = registryEntries()
const missingEntries = entries.filter((entry) => !hostFor(entry, model.slides)).map((entry) => entry.name)
assert.deepEqual(missingEntries, [], `registry entries missing from sampler slide set: ${missingEntries.join(', ')}`)
for (const entry of entries) {
  const host = hostFor(entry, model.slides)
  assert(html.includes(`data-id="${host.id}"`), `${entry.name}: host slide appears in built bundle`)
}

const report = readFileSync(reportPath, 'utf8')
for (const entry of entries.filter((entry) => entry.status === 'unverified')) {
  assert(report.includes(`| ${entry.name} | Yes | Yes |`), `${entry.name}: report records compile and render result`)
}

console.log(`PASS compiler fixture: ${entries.length} registry entries, ${model.slides.length} compiled slides, zero unknown triggers`)

rmSync(screenshotsDir, { recursive: true, force: true })
mkdirSync(screenshotsDir, { recursive: true })
const tempRoot = join(tmpdir(), `tw-layout-sampler-${Date.now()}`)
const vault = join(tempRoot, 'vault')
const talkDir = join(vault, 'layout-sampler')
const userData = join(tempRoot, 'userData')
mkdirSync(join(talkDir, 'assets'), { recursive: true })
mkdirSync(userData, { recursive: true })
copyFileSync(samplerOutlinePath, join(talkDir, 'layout-sampler-outline.md'))
copyFileSync(sampleImage, join(talkDir, 'assets/sample-image.png'))
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))

const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: repo })
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1000)
  const outlinePath = join(talkDir, 'layout-sampler-outline.md')
  const content = readFileSync(outlinePath, 'utf8')
  const rows = await page.evaluate(([path, source]) => window.tw.talk.compile(path, source), [outlinePath, content])
  assert(Array.isArray(rows) && rows.length === model.slides.length, 'Electron compiler produces every sampler slide')
  const thumbnails = await page.evaluate(([path, source]) => window.tw.talk.thumbnails(path, source), [outlinePath, content])
  assert(thumbnails && typeof thumbnails === 'object', 'Electron thumbnail renderer returns a map')
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const key = row.render_hash || row.content_hash
    const url = thumbnails[key]
    assert(typeof url === 'string' && url.startsWith('twthumb://'), `slide ${row.slide_id}: thumbnail renders`)
    const loaded = await page.evaluate(async (thumbUrl) => {
      const image = document.createElement('img')
      image.id = 'layout-sampler-shot'
      image.src = thumbUrl
      image.style.cssText = 'position:fixed;left:0;top:0;width:1280px;height:720px;background:white;z-index:999999;'
      document.body.append(image)
      await new Promise((resolveImage) => { image.onload = resolveImage; image.onerror = resolveImage })
      return { complete: image.complete, width: image.naturalWidth, height: image.naturalHeight }
    }, url)
    assert(loaded.complete && loaded.width > 0 && loaded.height > 0, `slide ${row.slide_id}: thumbnail is non-empty`)
    await page.locator('#layout-sampler-shot').screenshot({ path: join(screenshotsDir, `${String(index + 1).padStart(3, '0')}-${safeFileName(row.slide_id)}.png`) })
    await page.locator('#layout-sampler-shot').evaluate((image) => image.remove())
  }
} finally {
  await app.close()
}

console.log(`layout sampler: ${entries.length} registry entries, ${model.slides.length} compiled slides, screenshots in ${screenshotsDir}`)
