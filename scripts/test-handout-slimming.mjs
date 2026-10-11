// Handout slimming (src/main/handout-slimming.ts; spec "Cloudflare set-up in the app", D11):
// `sharp` on every platform, with no program taken from the machine.
// 1. the sizes the EARLIER path produced on macOS (cwebp 1.6.0 for the encode, sips for the size and
//    for reading WebP), measured once on the four committed pictures before that path was removed,
//    and that this path gives the same size or smaller;
// 2. what comes out is a WebP picture of the right size, and a picture is never made bigger;
// 3. a whole page: which pictures and videos change, and the steps taken until it fits;
// 4. a picture that cannot be read is left as it was;
// 5. no call to cwebp or sips is left in the app.
// Plain Node: this runs as it is on Windows, where the earlier path did nothing at all.
import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import {
  IMAGE_STEPS, SLIM_MIN_IMAGE_BYTES, VIDEO_PLACEHOLDER, compressImages, slimHandoutHtml, slimImage, stripVideos,
} from '../src/main/handout-slimming.ts'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const fixtures = join(repo, 'scripts', 'fixtures', 'handout-slimming')
let checks = 0
const ok = (condition, message) => { assert.ok(condition, message); checks += 1 }
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1 }

// ── 1. The earlier path's sizes, pinned ─────────────────────────────────────────────────────────
// Bytes after each of the four quality steps, in order. Where the earlier path could not make the
// picture smaller it kept the original, so that entry is the original's size. `scaled`: the steps
// at which the picture is wider than the step's limit and is scaled down.
const BEFORE = {
  'screenshot.png': { type: 'png', original: 556648, old: [208914, 106824, 71302, 50340], scaled: [true, true, true, true] },
  'chart.png': { type: 'png', original: 411064, old: [157868, 6970, 6818, 5102], scaled: [false, false, false, true] },
  'photo.jpg': { type: 'jpeg', original: 284055, old: [284055, 115060, 75546, 51610], scaled: [false, false, true, true] },
  'diagram.webp': { type: 'webp', original: 179336, old: [179336, 76886, 63104, 43832], scaled: [false, false, false, true] },
}
/** A scaled picture goes through a different scaler than before: it may differ by this little, never by more. */
const SCALED_ALLOWANCE_BYTES = 128

const pictures = {}
const now = {}
for (const [name, before] of Object.entries(BEFORE)) {
  const bytes = readFileSync(join(fixtures, name))
  equal(bytes.length, before.original, `${name} is the file the sizes were measured on`)
  pictures[name] = bytes
  now[name] = []
  for (const step of IMAGE_STEPS) now[name].push(await slimImage(bytes, step))
}

for (const [name, before] of Object.entries(BEFORE)) {
  IMAGE_STEPS.forEach((step, index) => {
    const size = (now[name][index] ?? pictures[name]).length
    const label = `${name}, step ${index + 1} (${step.nearLossless ? 'near-lossless' : `quality ${step.quality}`}, at most ${step.maxDimension} px): ${size} bytes now, ${before.old[index]} before`
    if (before.scaled[index]) ok(size <= before.old[index] + SCALED_ALLOWANCE_BYTES, `a scaled picture is no bigger than before, give or take ${SCALED_ALLOWANCE_BYTES} bytes — ${label}`)
    // Not scaled: the same encoder with the same settings, so the very same number of bytes.
    else equal(size, before.old[index], `a picture that is not scaled comes out the size it did before — ${label}`)
  })
}
IMAGE_STEPS.forEach((_step, index) => {
  const total = Object.keys(BEFORE).reduce((sum, name) => sum + (now[name][index] ?? pictures[name]).length, 0)
  const before = Object.values(BEFORE).reduce((sum, entry) => sum + entry.old[index], 0)
  ok(total <= before, `step ${index + 1}: the four pictures together are the same size or smaller than before (${total} now, ${before} before)`)
})
// The one case above the earlier size, stated so that it cannot grow unnoticed.
const over = Object.entries(BEFORE).flatMap(([name, before]) => IMAGE_STEPS.map((_step, index) => ({ name, index, by: (now[name][index] ?? pictures[name]).length - before.old[index] })).filter((entry) => entry.by > 0))
assert.deepEqual(over.map((entry) => `${entry.name} step ${entry.index + 1}`), ['chart.png step 4'], 'only the flat chart at the lowest step is above its earlier size')
ok(over[0].by <= SCALED_ALLOWANCE_BYTES, `and by ${over[0].by} bytes of about 5,000`)

// ── 2. What comes out ───────────────────────────────────────────────────────────────────────────
for (const [name, before] of Object.entries(BEFORE)) {
  const source = await sharp(pictures[name]).metadata()
  for (const [index, step] of IMAGE_STEPS.entries()) {
    const out = now[name][index]
    if (out === null) { equal(before.old[index], before.original, `${name} step ${index + 1}: left alone only where the earlier path left it alone too`); continue }
    ok(out.length < pictures[name].length, `${name} step ${index + 1} is smaller than the picture it replaces`)
    const meta = await sharp(out).metadata()
    equal(meta.format, 'webp', `${name} step ${index + 1} is a WebP picture`)
    const longest = Math.max(source.width, source.height)
    equal(Math.max(meta.width, meta.height), Math.min(longest, step.maxDimension), `${name} step ${index + 1}: the longer side is ${Math.min(longest, step.maxDimension)} px`)
    ok(Math.abs(meta.width / meta.height - source.width / source.height) < 0.01, `${name} step ${index + 1} keeps its proportions`)
  }
}

// ── 3. A whole page ─────────────────────────────────────────────────────────────────────────────
const inline = (name) => `data:image/${BEFORE[name].type};base64,${pictures[name].toString('base64')}`
const small = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#002147' } }).png().toBuffer()
ok(small.length < SLIM_MIN_IMAGE_BYTES, 'the small picture is under the size that is slimmed')
const smallInline = `data:image/png;base64,${small.toString('base64')}`
const video = (megabytes) => `<figure class="slide-figure slide-video"><video controls src="data:video/mp4;base64,${'A'.repeat(Math.ceil(megabytes * 1024 * 1024 / 0.75))}"></video></figure>`
const lazyVideo = '<figure class="slide-figure slide-video"><video controls data-lazy-src="slide-assets/clip-0123456789ab.mp4"></video></figure>'
const page = [
  '<!doctype html><html><body>',
  ...Object.keys(BEFORE).map((name) => `<img alt="${name}" src="${inline(name)}">`),
  `<img alt="twice" src="${inline('screenshot.png')}">`,
  `<img alt="small" src="${smallInline}">`,
  lazyVideo,
  '</body></html>',
].join('\n')

const first = await slimHandoutHtml(page)
ok(Buffer.byteLength(first) < Buffer.byteLength(page), 'a page with heavy pictures comes out smaller')
ok(first.includes(smallInline), 'a small picture is left exactly as it was')
ok(first.includes(inline('photo.jpg')), 'a picture that near-lossless would make bigger is left exactly as it was')
ok(!first.includes(inline('screenshot.png')) && !first.includes(inline('chart.png')), 'the heavy pictures are replaced')
equal((first.match(/data:image\/webp;base64,/g) ?? []).length, 4, 'both copies of the screenshot, the chart and the diagram are WebP (the diagram already was, and was left: near-lossless would make it bigger)')
ok(first.includes(inline('diagram.webp')), 'the diagram is the original')
ok(first.includes(lazyVideo), 'a video published beside the page is not touched')
equal(first, await compressImages(page, IMAGE_STEPS[0]), 'a page that fits stops at the first step')
equal(await slimHandoutHtml(first), first, 'slimming a slimmed page that fits changes nothing more than re-encoding can: here, nothing')

// The steps: each smaller target is met by the next step, from the original pictures every time.
const sizes = []
for (const step of IMAGE_STEPS) sizes.push(Buffer.byteLength(await compressImages(page, step)))
ok(sizes.every((size, index) => index === 0 || size < sizes[index - 1]), `each step is smaller than the one before (${sizes.join(' > ')})`)
for (const [index, size] of sizes.entries()) {
  if (index === 0) continue
  const out = await slimHandoutHtml(page, size)
  equal(Buffer.byteLength(out), size, `a target the first ${index} step(s) miss is met by step ${index + 1}`)
}
const neverFits = await slimHandoutHtml(page, 1024)
equal(Buffer.byteLength(neverFits), sizes[sizes.length - 1], 'a page that can never fit comes back at the lowest step, not unchanged and not broken')

// Videos: over 8 MB always goes; smaller ones go only when the lowest picture step still does not fit.
const nine = video(9)
const three = video(3)
const withVideos = `${page}${nine}${three}`
const roomy = await slimHandoutHtml(withVideos)
ok(!roomy.includes(nine) && roomy.includes(VIDEO_PLACEHOLDER), 'a video over 8 MB becomes the note')
ok(roomy.includes(three), 'a 3 MB video stays while the page fits')
const tight = await slimHandoutHtml(withVideos, 3 * 1024 * 1024)
ok(!tight.includes(three), 'a 3 MB video goes when the page still does not fit at the lowest picture step')
equal((tight.match(/video-placeholder-note/g) ?? []).length, 2, 'both videos are the note')
equal(stripVideos(lazyVideo + VIDEO_PLACEHOLDER, 0), lazyVideo + VIDEO_PLACEHOLDER, 'a note and a lazy video are never replaced again')

// ── 4. A picture that cannot be read ────────────────────────────────────────────────────────────
const broken = Buffer.alloc(SLIM_MIN_IMAGE_BYTES + 10, 7)
equal(await slimImage(broken, IMAGE_STEPS[0]), null, 'bytes that are not a picture are not re-encoded')
const brokenPage = `<img src="data:image/png;base64,${broken.toString('base64')}"><img src="${inline('chart.png')}">`
const brokenOut = await slimHandoutHtml(brokenPage)
ok(brokenOut.includes(broken.toString('base64')), 'an unreadable picture is left exactly as it was')
ok(!brokenOut.includes(inline('chart.png')), 'and the readable one beside it is still slimmed')

// ── 5. Nothing taken from the machine ───────────────────────────────────────────────────────────
function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.(ts|tsx|mts)$/.test(entry.name) ? [path] : []
  })
}
const callers = sources(join(repo, 'src')).filter((path) => /['"](?:[^'"\n]*\/)?(?:cwebp|sips)['"]/.test(readFileSync(path, 'utf8')))
assert.deepEqual(callers.map((path) => path.slice(repo.length + 1)), [], 'no source file names cwebp or sips as a program to run')
const slimming = readFileSync(join(repo, 'src', 'main', 'handout-slimming.ts'), 'utf8')
ok(!/child_process|execFile|spawn/.test(slimming), 'the slimming module starts no program')
checks += 1

console.log(`handout slimming: ${checks} checks passed`)
