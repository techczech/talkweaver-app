// The picture paths on the shipped image library (sharp 0.35, upgraded from 0.34.5 for GHSA-f88m,
// GHSA-rgj7 and GHSA-wq5f). Real pictures (a transparent slide graphic, a three-frame moving picture,
// a phone photo with EXIF orientation, camera and GPS data, a screenshot over 100 million pixels, a
// cut-off download, an Electron BGRA capture) go through every path, and what a person gets is pinned:
// 1. the app's calls in scripts/lib/sharp-image-path-facts.mjs are still the calls in the source;
// 2. the exported functions (slimImage, decodeToWebp + storePastedImage, fitInstantImage) give what
//    those calls give;
// 3. the facts: transparency kept, frames kept where the path keeps them, a photo never turned, its
//    camera and GPS data never carried into the new file, a picture never made bigger, the pixel
//    limit refused, a damaged file handled as before, thumbnail colours put back the right way.
// The same facts were compared on sharp 0.34.5 and 0.35.5 (research/runtime-advisories-2026-10-27/).
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { APP_CALLS, SLIM_STEPS, imagePathFacts, makePictures } from './lib/sharp-image-path-facts.mjs'
import { IMAGE_STEPS, SCALING_KERNEL, SCALED_QUALITY_DROP, slimImage } from '../src/main/handout-slimming.ts'
import { decodeToWebp, storePastedImage } from '../src/main/pasted-image-asset.ts'
import { fitInstantImage } from '../src/main/instant-image.ts'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
let checks = 0
const ok = (condition, message) => { assert.ok(condition, message); checks += 1 }
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks += 1 }

// ── 1. The calls are the source's ────────────────────────────────────────────────────────────────
const source = (file) => readFileSync(join(repo, file), 'utf8').replace(/\s+/g, ' ')
const index = source('src/main/index.ts')
ok(index.includes(".resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true }) .webp({ quality: 82 })"), 'talk:optimize-images still resizes inside 2560 and writes WebP q82')
ok(index.includes('sharp(buf).webp({ quality: 82 }).toBuffer()'), 'the clipboard paste still writes WebP q82')
ok(source('src/main/thumbnails.ts').includes('sharp(bitmap, { raw: { width, height, channels: 4 } }) .recomb([[0, 0, 1], [0, 1, 0], [1, 0, 0]]) .png()'), 'thumbnails still swap channels 0 and 2 of the raw bitmap and write PNG')
const instantSource = source('src/main/instant-image.ts')
ok(instantSource.includes('sharp(bytes, { limitInputPixels: 100_000_000 })') && instantSource.includes('[1600, 1400, 1200, 960]') && instantSource.includes('[78, 60, 42, 25, 10]'), 'the live image keeps its pixel limit and its size and quality ladder')
equal(SLIM_STEPS, IMAGE_STEPS.slice(0, 2), 'the slimming steps tried here are the app\'s first two')
equal([SCALING_KERNEL, SCALED_QUALITY_DROP], ['linear', 2], 'slimming scales with the linear kernel and drops two quality points when it scales')
equal(sharp.versions.sharp, '0.35.5', 'the library under test is the patched sharp')

// ── 2. The exported functions agree with the calls ───────────────────────────────────────────────
const pictures = await makePictures(sharp)
for (const [i, step] of SLIM_STEPS.entries()) {
  for (const key of ['transparentPng', 'animatedWebp', 'photo', 'truncatedJpeg']) {
    const app = await slimImage(pictures[key], step)
    const call = await APP_CALLS.slim(sharp, pictures[key], step)
    equal(app === null ? null : app.length, call === null ? null : call.length, `slimImage(${key}, step ${i}) is the call`)
  }
}
for (const key of ['transparentPng', 'photo']) {
  equal((await decodeToWebp(sharp, pictures[key])).length, (await APP_CALLS.paste(sharp, pictures[key])).length, `decodeToWebp(${key}) is the call`)
}
await assert.rejects(decodeToWebp(sharp, pictures.truncatedJpeg), 'Add to talk refuses a cut-off photo'); checks += 1
const vault = mkdtempSync(join(tmpdir(), 'tw-sharp-paths-'))
try {
  // Add to talk (requireDecode): a cut-off photo is refused and nothing is written.
  await assert.rejects(storePastedImage(vault, pictures.truncatedJpeg, 'jpg', (buf) => decodeToWebp(sharp, buf), { requireDecode: true }), /image-not-decodable/); checks += 1
  equal(readdirSync(vault).filter((name) => name !== '_assets').length, 0, 'a refused Add to talk writes nothing')
  // The clipboard paste never fails: the same photo is kept as it was.
  const warn = console.warn
  console.warn = () => {}
  try {
    const kept = await storePastedImage(vault, pictures.truncatedJpeg, 'jpg', (buf) => decodeToWebp(sharp, buf))
    equal(kept.ext, 'jpg', 'a paste the library cannot decode keeps the original file')
    equal(readFileSync(kept.path).length, pictures.truncatedJpeg.length, 'the kept file is the original bytes')
  } finally { console.warn = warn }
  const pasted = await storePastedImage(vault, pictures.transparentPng, 'png', (buf) => decodeToWebp(sharp, buf), { requireDecode: true })
  equal(pasted.ext, 'webp', 'a transparent slide graphic is stored as WebP')
  equal((await sharp(readFileSync(pasted.path)).metadata()).hasAlpha, true, 'and keeps its transparency')
} finally { rmSync(vault, { recursive: true, force: true }) }
for (const key of ['transparentPng', 'photo']) {
  const app = await fitInstantImage(pictures[key])
  const call = await APP_CALLS.instant(sharp, pictures[key])
  ok(app.success, `fitInstantImage(${key}) succeeds`)
  equal([app.width, app.height, app.dataUrl.length], [call.width, call.height, `data:image/webp;base64,${call.data.toString('base64')}`.length], `fitInstantImage(${key}) is the call`)
}
equal((await fitInstantImage(pictures.hugePng)).success, false, 'the live image refuses a picture over 100 million pixels')

// ── 3. What a person gets ────────────────────────────────────────────────────────────────────────
const facts = await imagePathFacts(sharp, pictures)
const plain = (format, width, height, extra = {}) => ({ format, width, height, pages: 1, pageHeight: height, hasAlpha: false, orientation: null, exif: false, icc: false, ...extra })
equal(facts.inputs.photo, { format: 'jpeg', width: 3000, height: 2000, pages: 1, pageHeight: 2000, hasAlpha: false, orientation: 6, exif: true, icc: true }, 'the photo carries orientation 6, EXIF and a colour profile')
equal(facts.inputs.animatedWebp.pages, 3, 'the moving picture has three frames')
for (const path of ['optimise', 'paste']) {
  equal(facts[path].transparentPng, plain('webp', 1200, 800, { hasAlpha: true }), `${path}: transparency kept, size kept`)
  equal([facts[path].transparentAlphaRight, facts[path].transparentAlphaBand], [0, 128], `${path}: clear stays clear, half-clear stays half-clear`)
  equal(facts[path].truncatedJpeg, 'refused', `${path}: a cut-off photo is not converted`)
  equal(facts[path].animatedGif.pages, 1, `${path}: a GIF becomes one still frame, as before (the editor sends moving GIFs around this path)`)
}
equal(facts.optimise.photo, plain('webp', 2560, 1707), 'optimise: the photo is scaled inside 2560, not turned, and loses its EXIF, GPS and profile')
equal(facts.paste.photo, plain('webp', 3000, 2000), 'paste: the photo keeps its size, is not turned, and loses its EXIF, GPS and profile')
equal(facts.slim.step0.transparentPng, plain('webp', 1200, 800, { hasAlpha: true }), 'slim near-lossless: transparency kept')
equal(facts.slim.step0.animatedWebp, null, 'slim near-lossless: a moving picture that would not get smaller is left as it was')
equal(facts.slim.step1.animatedWebp, plain('webp', 2000, 693, { pages: 3, pageHeight: 231 }), 'slim lossy: all three frames kept, each scaled to the step\'s width')
equal(facts.slim.step1.animatedFrameReds.map((red) => red > 150), [true, false, false], 'slim lossy: the frames stay in their order (red first)')
equal(facts.slim.step0.photo, plain('webp', 2400, 1600), 'slim: the photo is scaled, never turned, and loses its EXIF and GPS')
equal([facts.slim.step0.truncatedJpeg, facts.slim.step1.truncatedJpeg], ['slimmed', 'slimmed'], 'slim: a cut-off photo is still read (failOn none), as before')
equal(facts.instant.hugePng, 'refused', 'instant: over 100 million pixels is refused')
equal(facts.instant.transparentPng, { width: 1200, height: 800, quality: 78, longest: 1600, hasAlpha: true }, 'instant: a slide graphic fits at the first step with its transparency')
equal(facts.thumbnail, { format: 'png', first: [0, 0, 255, 255], second: [255, 0, 0, 128] }, 'thumbnail: blue stays blue, red stays red, half-clear stays half-clear')

console.log(`sharp image paths (sharp ${sharp.versions.sharp}, libvips ${sharp.versions.vips}): optimise, paste, Add to talk, slimming, live image and thumbnails on real pictures — ${checks} checks passed`)
