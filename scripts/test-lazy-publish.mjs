// Publishing the lazy handout pages (handout-lazy-assets.mjs publishLazyHandoutPages) with the REAL
// slimHandoutHtml from src/main/index.ts:
//  1. slim + externalise together: a large image and a 10 MB video reach slide-assets/ untouched (slim
//     never sees them); the Download page is slimmed whole; a video over the per-file cap stays in the
//     page, is slimmed to today's placeholder, and the result carries a warning.
//  2. a republish keeps the previous publish's assets for one generation, then prunes them.
//  3. a failure mid-publish leaves the previous pages and their assets loadable.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync, crc32 } from 'node:zlib'
import { randomBytes } from 'node:crypto'
import ts from 'typescript'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { publishLazyHandoutPages, SLIDE_ASSET_DIR } from '../compiler/scripts/lib/handout-lazy-assets.mjs'

// The real slimHandoutHtml, lifted out of src/main/index.ts with its fs/child_process dependencies.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(REPO, 'src/main/index.ts'), 'utf8')
const file = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const decl = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'slimHandoutHtml')
assert.ok(decl, 'slimHandoutHtml is in src/main/index.ts')
const js = ts.transpileModule(decl.getText(file), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const deps = { existsSync, mkdtempSync, join, tmpdir, writeFileSync, readFileSync, rmSync, execFileSync, Buffer }
const slimHandoutHtml = Function(...Object.keys(deps), `${js}\nreturn slimHandoutHtml`)(...Object.values(deps))

// A PNG stored without compression (deflate level 0), so slim would re-encode it to WebP.
function flatPng(w, h, shade) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.fill((x + y + shade) & 255, y * (w * 3 + 1) + 1 + x * 3, y * (w * 3 + 1) + 4 + x * 3)
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 0 })), chunk('IEND', Buffer.alloc(0))])
}
const video = (bytes) => `<figure class="slide-figure slide-video"><video controls src="data:video/mp4;base64,${randomBytes(bytes).toString('base64')}"></video></figure>`
const imgSlide = (id, png, extra = '') => ({ html: `<section class="slide" data-id="${id}"><div class="slide-content"><h1>${id}</h1><img src="data:image/png;base64,${png.toString('base64')}" alt="${id}">${extra}</div></section>`, notes: '' })
const page = (slides, lazyAssets = true) => buildShareHtml({ title: 'Publish', slides, styles: '', includeNotes: false, slug: 'pub', license: null, lazyAssets })
const assetFiles = (dir) => (existsSync(join(dir, SLIDE_ASSET_DIR)) ? readdirSync(join(dir, SLIDE_ASSET_DIR)).sort() : [])
const refs = (html) => [...html.matchAll(/data-lazy-(?:src|poster)="([^"]+)"/g)].map((m) => m[1])

const root = mkdtempSync(join(tmpdir(), 'tw-lazy-publish-'))
try {
  // 1. Slim + externalise together.
  {
    const dir = join(root, 'one'); mkdirSync(dir)
    const big = flatPng(700, 500, 0) // ~1 MB stored PNG
    const slides = [imgSlide('a', big, video(10 * 1024 * 1024)), imgSlide('b', flatPng(64, 64, 9), video(25 * 1024 * 1024))]
    const result = publishLazyHandoutPages(dir, [
      { fileName: 'pub-download.html', html: page(slides, false), lazy: false },
      { fileName: 'index.html', html: page(slides) },
    ], { slim: slimHandoutHtml })
    const index = readFileSync(join(dir, 'index.html'), 'utf8')
    const lazy = refs(index)
    assert.equal(lazy.length, 3, 'two images and the 10 MB video are lazy')
    const pngRef = lazy.find((r) => r.endsWith('.png') && readFileSync(join(dir, r)).length === big.length)
    assert.ok(pngRef, 'the large image is published as itself')
    assert.deepEqual(readFileSync(join(dir, pngRef)), big, 'byte for byte: slim never re-encoded it')
    const mp4 = lazy.find((r) => r.endsWith('.mp4'))
    assert.equal(readFileSync(join(dir, mp4)).length, 10 * 1024 * 1024, 'the 10 MB video is published whole, not a placeholder')
    assert.ok(index.includes('Video plays in the live presentation'), 'the video over the per-file cap falls back to today\'s placeholder')
    assert.ok(!/data:video\//.test(index), 'no video left inline in the lazy page')
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0], /index\.html: a video\/mp4 of 25\.0 MB is over the per-file limit/)
    const indexInfo = result.pages.find((p) => p.fileName === 'index.html')
    assert.ok(indexInfo.bytes < 24 * 1024 * 1024 && indexInfo.assets === 3, `index.html is ${indexInfo.bytes} bytes, under the cap`)
    const download = readFileSync(join(dir, 'pub-download.html'), 'utf8')
    assert.ok(!/data-lazy-|slide-assets\//.test(download), 'the Download handout stays self-contained')
    if (existsSync('/opt/homebrew/bin/cwebp') || (() => { try { execFileSync('which', ['cwebp'], { stdio: 'ignore' }); return true } catch { return false } })()) {
      assert.match(download, /data:image\/webp;base64,/, 'the Download handout is slimmed whole (its image re-encoded)')
    }
    for (const p of result.pages) assert.ok(p.bytes <= 25 * 1024 * 1024, `${p.fileName} fits the Pages per-file limit`)
  }

  // 2. Republish: the previous publish's assets survive one generation.
  const dir = join(root, 'two'); mkdirSync(dir)
  const gen = (shade) => [imgSlide('x', flatPng(120, 80, shade))]
  publishLazyHandoutPages(dir, [{ fileName: 'index.html', html: page(gen(1)) }])
  const [g1] = refs(readFileSync(join(dir, 'index.html'), 'utf8'))
  publishLazyHandoutPages(dir, [{ fileName: 'index.html', html: page(gen(2)) }])
  const [g2] = refs(readFileSync(join(dir, 'index.html'), 'utf8'))
  assert.notEqual(g1, g2)
  assert.deepEqual(assetFiles(dir), [g1, g2].map((r) => r.split('/')[1]).sort(), 'a phone still on the old page keeps its image')
  publishLazyHandoutPages(dir, [{ fileName: 'index.html', html: page(gen(3)) }])
  const [g3] = refs(readFileSync(join(dir, 'index.html'), 'utf8'))
  assert.deepEqual(assetFiles(dir), [g2, g3].map((r) => r.split('/')[1]).sort(), 'two publishes back is pruned')

  // 3. A failure mid-publish (writing the second page) leaves the previous pages and assets as they were.
  {
    writeFileSync(join(dir, 'pub.html'), readFileSync(join(dir, 'index.html')))
    const before = { index: readFileSync(join(dir, 'index.html'), 'utf8'), pub: readFileSync(join(dir, 'pub.html'), 'utf8'), assets: assetFiles(dir) }
    let pageWrites = 0
    const io = {
      writeFile: (path, data) => {
        if (!path.includes(SLIDE_ASSET_DIR) && ++pageWrites === 2) throw new Error('disk full')
        writeFileSync(path, data)
      },
      rename: (from, to) => renameSync(from, to),
    }
    assert.throws(() => publishLazyHandoutPages(dir, [
      { fileName: 'pub.html', html: page(gen(4)) },
      { fileName: 'index.html', html: page(gen(4)) },
    ], { io }), /disk full/)
    assert.equal(readFileSync(join(dir, 'index.html'), 'utf8'), before.index, 'index.html is the previous page')
    assert.equal(readFileSync(join(dir, 'pub.html'), 'utf8'), before.pub, 'pub.html is the previous page')
    for (const r of refs(before.index)) assert.ok(existsSync(join(dir, r)), `the previous page's ${r} is still there`)
    assert.ok(before.assets.every((name) => assetFiles(dir).includes(name)), 'no previous asset was pruned')
    assert.deepEqual(readdirSync(dir).filter((n) => n.includes('.tmp-')), [], 'no temp page left behind')
  }
  // Temp names are unique per call (pid + nonce), so overlapping publishes of one talk never share one.
  {
    const temps = [[], []]
    for (const k of [0, 1]) {
      publishLazyHandoutPages(dir, [{ fileName: 'index.html', html: page(gen(10 + k)) }], {
        io: { writeFile: (path, data) => { temps[k].push(path); writeFileSync(path, data) }, rename: (from, to) => renameSync(from, to) },
      })
    }
    const suffix = (path) => path.slice(path.lastIndexOf('.tmp-'))
    assert.ok(temps[0].length && temps[1].length)
    assert.match(suffix(temps[0][0]), new RegExp(`^\\.tmp-${process.pid}-[0-9a-f]{12}$`))
    assert.notEqual(suffix(temps[0][0]), suffix(temps[1][0]), 'two calls, two temp suffixes')
  }
  // A throw while building (before anything is written) changes nothing either.
  {
    const before = readFileSync(join(dir, 'index.html'), 'utf8')
    assert.throws(() => publishLazyHandoutPages(dir, [{ fileName: 'index.html', html: page(gen(5)), lazy: false }], { slim: () => { throw new Error('slim failed') } }), /slim failed/)
    assert.equal(readFileSync(join(dir, 'index.html'), 'utf8'), before)
  }
  console.log('lazy publish: slim after externalise, per-file cap, one-generation prune, failure leaves the old pages ok')
} finally {
  rmSync(root, { recursive: true, force: true })
}
