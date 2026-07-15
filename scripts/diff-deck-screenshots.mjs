import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'

const [beforeArg, afterArg, outputArg] = process.argv.slice(2)
if (!beforeArg || !afterArg) throw new Error('Usage: node scripts/diff-deck-screenshots.mjs BEFORE_DIR AFTER_DIR [RESULT.json]')

const beforeDir = resolve(beforeArg)
const afterDir = resolve(afterArg)
const before = JSON.parse(readFileSync(join(beforeDir, 'manifest.json'), 'utf8'))
const after = JSON.parse(readFileSync(join(afterDir, 'manifest.json'), 'utf8'))
const afterFiles = new Set(after.decks.flatMap((deck) => deck.captures.map((capture) => capture.file)))
const files = before.decks.flatMap((deck) => deck.captures.map((capture) => capture.file))
if (files.some((file) => !afterFiles.has(file))) throw new Error('Before/after manifests do not contain the same captures')

const results = []
for (const file of files) {
  const beforePath = join(beforeDir, file)
  const afterPath = join(afterDir, file)
  if (!existsSync(beforePath) || !existsSync(afterPath)) throw new Error(`Missing capture for host-run diff: ${file}`)
  const a = await sharp(beforePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const b = await sharp(afterPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  if (a.info.width !== b.info.width || a.info.height !== b.info.height || a.data.length !== b.data.length) throw new Error(`Dimension mismatch: ${file}`)
  let maxPixelDelta = 0
  let changedPixels = 0
  for (let offset = 0; offset < a.data.length; offset += 4) {
    const delta = Math.max(...[0, 1, 2, 3].map((channel) => Math.abs(a.data[offset + channel] - b.data[offset + channel])))
    if (delta > 0) changedPixels += 1
    if (delta > maxPixelDelta) maxPixelDelta = delta
  }
  results.push({ file, maxPixelDelta, changedPixels })
}

const report = { slideCount: results.length, maxPixelDelta: Math.max(0, ...results.map((item) => item.maxPixelDelta)), results }
const output = resolve(outputArg || join(afterDir, 'pixel-diff.json'))
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
console.log(`diffed ${report.slideCount} slides; maximum pixel delta ${report.maxPixelDelta} → ${output}`)
