// Real-Electron harness for ADR-0022 carousel sub-thumbnails, on outline-v2 grammar.
// Verifies: per-slide SUB-thumbnails (key__N) are captured ONLY for a LEAF {carousel} slide —
// one whose rendered content carries .card-gallery[data-exclusive] (top-level blocks become
// full-bleed sub-slides). A CONTAINER carousel ({carousel} over #### children) is beats now:
// the children are their own slides with their OWN base thumbnails and the parent gets no __N.
// A static multi-part layout gets exactly ONE thumbnail (no __N).
// Run after `npm run build`.
import { _electron as electron } from 'playwright'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { deflateSync } from 'zlib'

// A small striped RGB PNG written to disk — a carousel sub-slide's RELATIVE-path image. Its whole
// point: it must actually LOAD in the thumbnail's hidden window (which loads the compiled HTML from
// a tmpdir temp file), which only happens if the compiler base64-INLINES carousel sub-slide media
// (the regressed bug: inlineAndCollectAssets walked slide.blocks but not slide.carousel).
function writeStripedPng(path, w = 320, h = 180) {
  const crc32 = (buf) => { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)) } return ~c >>> 0 }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc(h * (1 + w * 3)); let o = 0
  for (let y = 0; y < h; y++) { raw[o++] = 0; for (let x = 0; x < w; x++) { const s = ((x + y) >> 4) & 1; raw[o++] = s ? 230 : 40; raw[o++] = s ? 80 : 120; raw[o++] = s ? 40 : 200 } }
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
  writeFileSync(path, png)
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-caro-' + String(Date.now()) + '-'))
const vault = join(tempRoot, 'vault')
const ud = join(tempRoot, 'userData')
const td = join(vault, 'caro')
const assetsDir = join(td, 'assets')
mkdirSync(assetsDir, { recursive: true })
mkdirSync(ud, { recursive: true })
const outlinePath = join(td, 'caro-outline.md')
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))
writeStripedPng(join(assetsDir, 'pic.png'))

// Slides (outline v2): a CONTAINER carousel ({carousel} over #### children → beats, children
// are their own slides), a LEAF {carousel} slide (3 top-level blocks → 3 subs), a static
// {contrast} slide (multi-part but ONE thumbnail), and an IMAGE leaf carousel whose FIRST
// sub-slide carries a RELATIVE-path image (the reported blank-carousel-thumbnail case: the
// image must inline for the base capture to succeed) beside pure-list neighbours.
const CONTENT = [
  '---', 'title: T', 'auto_title_slide: false', 'auto_thanks_slide: false', 'outline_version: 2', '---', '',
  '## S {id=s}', '',
  '### Container carousel {id=hashcaro}', '{carousel}', '',
  '#### One {id=hc-one}', '- a', '', '#### Two {id=hc-two}', '- b', '', '#### Three {id=hc-three}', '- c', '',
  '### Trigger carousel {carousel id=trigcaro}', 'First paragraph block.', '', '> A quote block.', '— Cite', '', '- A list block', '  - child stays', '',
  '### Static contrast {contrast id=static}', '- l', '- r', '',
  '### Image carousel {carousel id=imgcaro}', '![](assets/pic.png)', '', 'Trailing prose line.', '',
  '### Plain list {id=plain}', '- neighbour one', '- neighbour two', ''
].join('\n')
writeFileSync(outlinePath, CONTENT)

const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

try {
  const rows = await page.evaluate(
    async ({ p, c }) => await window.tw.talk.compile(p, c),
    { p: outlinePath, c: CONTENT }
  )
  record('compile returns rows', Array.isArray(rows) && rows.length > 0, `rows=${rows ? rows.length : 0}`)

  const rowFor = (re) => (rows || []).find((r) => re.test(r.title || ''))
  const hash = (re) => {
    const r = rowFor(re)
    return r ? r.render_hash || r.content_hash || r.slide_id : null
  }
  const hashCaro = hash(/Container carousel/)
  const trigCaro = hash(/Trigger carousel/)
  const cols = hash(/Static contrast/)

  const caroRow = rowFor(/Container carousel/)
  record('container {carousel} parent compiles to the carousel layout', caroRow && caroRow.layout === 'carousel', `layout=${caroRow && caroRow.layout}`)
  const trigRow = rowFor(/Trigger carousel/)
  record('leaf {carousel} slide compiles to the carousel layout', trigRow && trigRow.layout === 'carousel', `layout=${trigRow && trigRow.layout}`)
  const childRows = [rowFor(/^One$/), rowFor(/^Two$/), rowFor(/^Three$/)]
  record('container carousel children are their own slides (beats, not fragments)', childRows.every(Boolean), `children found=${childRows.filter(Boolean).length}/3`)

  const thumbs = await page.evaluate(
    async ({ p, c }) => (await window.tw.talk.thumbnails(p, c)) || {},
    { p: outlinePath, c: CONTENT }
  )
  const keys = Object.keys(thumbs)
  record('thumbnails returned', keys.length > 0, `keys=${keys.length}`)

  const subCount = (h) => {
    if (!h) return 0
    let n = 0
    while (thumbs[`${h}__${n}`]) n += 1
    return n
  }
  const hashSubs = subCount(hashCaro)
  const trigSubs = subCount(trigCaro)
  const colSubs = subCount(cols)

  record('container carousel has NO sub-thumbnails (children are beat-slides)', hashSubs === 0, `__N count=${hashSubs}`)
  const childHashes = childRows.map((r) => (r ? r.render_hash || r.content_hash || r.slide_id : null))
  record('container carousel children each have their OWN base thumbnail', childHashes.every((h) => !!(h && thumbs[h])), `bases=${childHashes.filter((h) => !!(h && thumbs[h])).length}/3`)
  record('leaf {carousel} has 3 sub-thumbnails (one per top-level block)', trigSubs === 3, `__N count=${trigSubs}`)
  record('static {contrast} has NO sub-thumbnails (exactly one slide thumbnail)', colSubs === 0 && !!(cols && thumbs[cols]), `__N count=${colSubs}, base=${!!(cols && thumbs[cols])}`)
  record('each carousel slide still has its own base thumbnail', !!(hashCaro && thumbs[hashCaro]) && !!(trigCaro && thumbs[trigCaro]), `hash=${!!(hashCaro && thumbs[hashCaro])} trig=${!!(trigCaro && thumbs[trigCaro])}`)

  // ── REGRESSION: carousel sub-slide media must INLINE so the base thumbnail actually renders ──
  // Bug (2026-07-05): inlineAndCollectAssets walked slide.blocks but not slide.carousel, so a
  // carousel's relative-path image stayed a raw `assets/…` src. The thumbnail loads the compiled
  // HTML from a tmpdir temp file where that ref 404s → settle's "don't cache incomplete" guard
  // SKIPPED the MAIN capture → the Browser card requested a key that was never cached → 404 →
  // title-only schematic fallback (exactly the reported blank "About me" carousel).
  const imgCaro = hash(/Image carousel/)
  const plainList = hash(/Plain list/)
  // 1) The exact bug signal: the image carousel's base key must be PRESENT (not skipped/absent).
  record('image carousel base thumbnail IS cached (media inlined, capture not skipped)', !!(imgCaro && thumbs[imgCaro]), `base=${!!(imgCaro && thumbs[imgCaro])}`)
  record('image carousel has 2 sub-thumbnails (one per block sub-slide)', subCount(imgCaro) === 2, `__N count=${subCount(imgCaro)}`)

  // 2) The card requests `twthumb://<slug>/<render_hash>` — assert it resolves to a REAL image
  //    with content, not a 404 and not a blank/title-only frame. Load via <img>+canvas (twthumb is
  //    img-src-allowed, not fetch-allowed) and measure ink in the content area below the title.
  const inkOf = async (key) => {
    if (!key) return { ok: false, reason: 'no-key' }
    return await page.evaluate(async ({ url }) => {
      try {
        const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('img-error(404/decode)')); i.src = url })
        const cv = document.createElement('canvas'); cv.width = im.naturalWidth; cv.height = im.naturalHeight
        const ctx = cv.getContext('2d'); ctx.drawImage(im, 0, 0)
        const { data, width, height } = ctx.getImageData(0, 0, cv.width, cv.height)
        const br = data[0], bg = data[1], bb = data[2]
        const startY = Math.floor(height * 0.30); let ink = 0
        for (let y = startY; y < height; y++) for (let x = 0; x < width; x++) { const i = (y * width + x) * 4; if (Math.abs(data[i] - br) + Math.abs(data[i + 1] - bg) + Math.abs(data[i + 2] - bb) > 60) ink++ }
        return { ok: true, inkPct: +(100 * ink / (width * (height - startY))).toFixed(3) }
      } catch (e) { return { ok: false, reason: String(e && e.message ? e.message : e) } }
    }, { url: 'twthumb://caro/' + key })
  }
  const caroInk = await inkOf(imgCaro)
  const listInk = await inkOf(plainList)
  // A 404 → ok:false. A blank/title-only frame → ok:true but inkPct near 0. A real render of the
  // image sub-slide is well above the pure-list neighbour's ink. Threshold 1% is far above blank.
  record('image carousel base thumbnail loads as a real image (not 404)', caroInk.ok === true, JSON.stringify(caroInk))
  record('image carousel base thumbnail has real content (not blank/title-only)', caroInk.ok === true && caroInk.inkPct > 1.0, `inkPct=${caroInk.inkPct} (list neighbour=${listInk.inkPct})`)
} catch (e) {
  record('carousel-thumbnails harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== CAROUSEL-THUMBNAILS SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
