// What each of TalkWeaver's picture paths does to a set of real pictures, as plain facts (sizes,
// frames, transparency, kept metadata, refusals), with the image library passed in. The test
// (scripts/test-sharp-image-paths.mjs) runs it with the app's own sharp and pins the facts; the same
// function run with another sharp shows whether an upgrade changed what a person gets.
//
// The calls are the app's own, step for step:
//   optimise   src/main/index.ts `talk:optimize-images`: resize inside 2560, WebP q82
//   paste      src/main/pasted-image-asset.ts `decodeToWebp` (Add to talk) and the clipboard paste:
//              metadata, then WebP q82
//   slim       src/main/handout-slimming.ts `slimImage`: animated, failOn none, `linear` kernel past
//              the step's limit, near-lossless or lossy WebP, never bigger
//   instant    src/main/instant-image.ts `fitInstantImage`: limitInputPixels 100M, inside 1600…960
//   thumbnail  src/main/thumbnails.ts `encodePng`: raw BGRA, channels 0 and 2 swapped, PNG
// Not covered by a picture: sharp 0.35's new default limit of 5 channels per input. sharp cannot
// write a picture with more, and a hand-made one would be bytes no person has; such a picture takes
// each path's existing "cannot be read" branch.
// scripts/test-sharp-image-paths.mjs checks that these calls are still the ones in the source.

export const SLIM_STEPS = [
  { nearLossless: true, quality: 60, maxDimension: 2400 },
  { nearLossless: false, quality: 84, maxDimension: 2000 },
]

/** The pictures: each stands for something a person really pastes, optimises or publishes. */
export async function makePictures(sharp) {
  // A slide graphic with real transparency: opaque red left, see-through right, a half-clear blue band.
  const w = 1200, h = 800
  const rgba = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4
    if (x < w / 2) { rgba[i] = 220; rgba[i + 1] = 20; rgba[i + 2] = 20; rgba[i + 3] = 255 }
    else if (y > 350 && y < 450) { rgba[i] = 0; rgba[i + 1] = 40; rgba[i + 2] = 200; rgba[i + 3] = 128 }
    else { rgba[i + 3] = 0 }
    rgba[i] = (rgba[i] + (x * 7 + y * 3) % 23) & 255 // some texture, so the encoders have work to do
  }
  const transparentPng = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer()

  // A moving picture, three frames (red, green, blue) wider than every slimming limit.
  const fw = 2600, fh = 300
  const frames = Buffer.alloc(fw * fh * 3 * 4)
  const colours = [[230, 30, 30, 255], [30, 200, 60, 255], [30, 60, 230, 255]]
  for (let f = 0; f < 3; f++) for (let p = 0; p < fw * fh; p++) {
    const i = (f * fw * fh + p) * 4
    const [r, g, b, a] = colours[f]
    frames[i] = r; frames[i + 1] = g; frames[i + 2] = (b + (p % 17)) & 255; frames[i + 3] = a
  }
  const animatedWebp = await sharp(frames, { raw: { width: fw, height: fh * 3, channels: 4, pageHeight: fh } })
    .webp({ quality: 90, delay: [120, 120, 120], loop: 0 }).toBuffer()
  const animatedGif = await sharp(frames, { raw: { width: fw, height: fh * 3, channels: 4, pageHeight: fh } })
    .gif({ delay: [120, 120, 120], loop: 0 }).toBuffer()

  // A phone photo: stored landscape with EXIF "turn 90°" and a camera make and GPS position in it.
  const photo = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#7a8c5e' } })
    .composite([{ input: { create: { width: 600, height: 400, channels: 3, background: '#d0c060' } }, left: 100, top: 100 }])
    .jpeg({ quality: 85 })
    .withExif({ IFD0: { Make: 'TalkWeaverTestCam', Model: 'Fixture 1' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 45/1 0/1', GPSLongitudeRef: 'W', GPSLongitude: '1/1 15/1 0/1' } })
    .withMetadata({ orientation: 6 })
    .toBuffer()

  // A screenshot past the live-image pixel limit (100 million): 10,050 × 10,000.
  const hugePng = await sharp({ create: { width: 10050, height: 10000, channels: 3, background: '#ffffff' } }).png({ compressionLevel: 9 }).toBuffer()

  // A photo cut off part way through, as an interrupted download leaves it.
  const truncatedJpeg = photo.subarray(0, Math.floor(photo.length * 0.6))

  // A screen capture as Electron hands it over: BGRA, one pure blue opaque pixel, one half-clear red.
  const bgra = Buffer.from([255, 0, 0, 255, 0, 0, 255, 128])

  return { transparentPng, animatedWebp, animatedGif, photo, hugePng, truncatedJpeg, bgra }
}

const attempt = async (fn) => { try { return { ok: true, value: await fn() } } catch (error) { return { ok: false, error: String(error?.message ?? error).slice(0, 120) } } }

async function describe(sharp, bytes) {
  const m = await sharp(bytes, { animated: true }).metadata()
  return {
    format: m.format, width: m.width, height: m.height, pages: m.pages ?? 1, pageHeight: m.pageHeight ?? m.height,
    hasAlpha: Boolean(m.hasAlpha), orientation: m.orientation ?? null, exif: Boolean(m.exif), icc: Boolean(m.icc),
  }
}

async function pixel(sharp, bytes, x, y) {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const i = (y * info.width + x) * 4
  return [...data.subarray(i, i + 4)]
}

// The app's calls, one function each.
const optimise = (sharp, bytes) => sharp(bytes).resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer()
async function paste(sharp, bytes) {
  const meta = await sharp(bytes).metadata()
  if (!(Number(meta.width) > 0 && Number(meta.height) > 0)) throw new Error('image-not-decodable')
  return sharp(bytes).webp({ quality: 82 }).toBuffer()
}
async function slim(sharp, bytes, step) {
  try {
    const image = sharp(bytes, { animated: true, failOn: 'none' })
    const { width = 0, height = 0, pageHeight } = await image.metadata()
    const tall = pageHeight ?? height
    const scaled = Math.max(width, tall) > step.maxDimension
    const resized = scaled ? image.resize({ ...(width >= tall ? { width: step.maxDimension } : { height: step.maxDimension }), kernel: 'linear' }) : image
    const quality = scaled && !step.nearLossless ? step.quality - 2 : step.quality
    const out = await resized.webp(step.nearLossless ? { nearLossless: true, quality, effort: 4 } : { quality, effort: 4 }).toBuffer()
    return out.length < bytes.length ? out : null
  } catch { return null }
}
async function instant(sharp, bytes) {
  const source = sharp(bytes, { limitInputPixels: 100_000_000 })
  const metadata = await source.metadata()
  if (!metadata.width || !metadata.height) throw new Error('Missing image dimensions')
  for (const longest of [1600, 1400, 1200, 960]) for (const quality of [78, 60, 42, 25, 10]) {
    const { data, info } = await source.clone().resize({ width: longest, height: longest, fit: 'inside', withoutEnlargement: true })
      .webp({ quality, effort: 4 }).toBuffer({ resolveWithObject: true })
    if (`data:image/webp;base64,${data.toString('base64')}`.length <= 120_000) return { data, width: info.width, height: info.height, quality, longest }
  }
  throw new Error('too detailed')
}
const thumbnail = (sharp, bitmap, width, height) => sharp(bitmap, { raw: { width, height, channels: 4 } }).recomb([[0, 0, 1], [0, 1, 0], [1, 0, 0]]).png().toBuffer()

export const APP_CALLS = { optimise, paste, slim, instant, thumbnail }

/** The facts, as JSON-safe values. */
export async function imagePathFacts(sharp, pictures) {
  const p = pictures
  const facts = { library: { sharp: sharp.versions.sharp, vips: sharp.versions.vips } }
  facts.inputs = {
    transparentPng: await describe(sharp, p.transparentPng),
    animatedWebp: await describe(sharp, p.animatedWebp),
    animatedGif: await describe(sharp, p.animatedGif),
    photo: await describe(sharp, p.photo),
    hugePng: { width: 10050, height: 10000 },
  }

  for (const [name, fn] of [['optimise', optimise], ['paste', paste]]) {
    const out = facts[name] = {}
    for (const key of ['transparentPng', 'animatedGif', 'photo']) {
      const r = await attempt(() => fn(sharp, p[key]))
      out[key] = r.ok ? await describe(sharp, r.value) : { refused: true }
    }
    out.transparentAlphaRight = await pixel(sharp, await fn(sharp, p.transparentPng), 1100, 100).then((px) => px[3])
    out.transparentAlphaBand = await pixel(sharp, await fn(sharp, p.transparentPng), 1100, 400).then((px) => px[3])
    out.truncatedJpeg = (await attempt(() => fn(sharp, p.truncatedJpeg))).ok ? 'converted' : 'refused'
  }

  facts.slim = {}
  for (const [i, step] of SLIM_STEPS.entries()) {
    const row = facts.slim[`step${i}`] = {}
    for (const key of ['transparentPng', 'animatedWebp', 'photo']) {
      const out = await slim(sharp, p[key], step)
      row[key] = out ? await describe(sharp, out) : null
      if (out && key === 'animatedWebp') {
        const { data, info } = await sharp(out, { animated: true }).raw().toBuffer({ resolveWithObject: true })
        const frame = info.width * (info.height / 3) * info.channels
        row.animatedFrameReds = [0, 1, 2].map((f) => data[f * frame])
      }
    }
    row.truncatedJpeg = (await slim(sharp, p.truncatedJpeg, step)) ? 'slimmed' : 'left as it was'
  }

  facts.instant = {}
  for (const key of ['transparentPng', 'photo', 'hugePng']) {
    const r = await attempt(() => instant(sharp, p[key]))
    facts.instant[key] = r.ok ? { width: r.value.width, height: r.value.height, quality: r.value.quality, longest: r.value.longest, hasAlpha: (await describe(sharp, r.value.data)).hasAlpha } : 'refused'
  }

  const png = await thumbnail(sharp, p.bgra, 2, 1)
  facts.thumbnail = { format: (await describe(sharp, png)).format, first: await pixel(sharp, png, 0, 0), second: await pixel(sharp, png, 1, 0) }
  return facts
}
