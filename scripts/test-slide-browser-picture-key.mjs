import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildPerSlideProjections } from '../compiler/scripts/lib/10-projections.mjs'
import { thumbnailSlides } from '../src/shared/slide-preview.ts'
import { resolveThumbFile } from '../src/main/thumb-key-resolution.ts'
import { resolveImageRefs } from '../src/main/image-refs.ts'
import sharp from 'sharp'

const root = mkdtempSync(join(tmpdir(), 'tw-browser-picture-'))
try {
  const pool = join(root, '_assets')
  const talk = join(root, 'talk')
  mkdirSync(pool)
  mkdirSync(talk)
  const outline = join(talk, 'outline.md')
  const local = join(talk, 'local.svg')
  const pooled = join(pool, 'img-abcdef0.png')
  const svg = colour => `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="${colour}"/></svg>`
  writeFileSync(local, svg('red'))
  const png = colour => sharp({ create: { width: 2, height: 2, channels: 4, background: colour } }).png().toBuffer()
  writeFileSync(pooled, await png('blue'))
  const source = '---\noutline_version: 2\ntitle: Pictures\n---\n\n### Local {#local}\n\n![](local.svg)\n\n### Pooled {#pooled}\n\n![](img-abcdef0)\n\n### Plain {#plain}\n\nWords only.\n'
  writeFileSync(outline, source)
  const resolved = resolveImageRefs(source, root)
  assert.ok(resolved.includes(pooled), 'main resolves the pooled image before both compiler modes')
  const compile = async projectionsOnly => buildPerSlideProjections(
    await prepareSource(outline, resolved, 'pictures', statSync(outline), undefined, { projectionsOnly }),
    'pictures'
  )
  const indexed = await compile(true)
  const rendered = await compile(false)
  const cache = join(root, 'cache')
  mkdirSync(cache)
  for (const id of ['local', 'pooled', 'plain']) {
    const searchRow = indexed.find(row => row.slide_id === id)
    const renderRow = rendered.find(row => row.slide_id === id)
    assert.ok(searchRow && renderRow, `${id} exists in both modes`)
    assert.equal(searchRow.render_hash, renderRow.render_hash, `${id} search key matches render key`)
    const rendererSlide = thumbnailSlides([renderRow], '0123456789abcdef')[0]
    const searchKey = thumbnailSlides([searchRow], '0123456789abcdef')[0].key
    writeFileSync(join(cache, `${rendererSlide.cacheKey}.png`), 'png')
    assert.equal(resolveThumbFile(cache, searchKey), join(cache, `${rendererSlide.cacheKey}.png`), `${id} twthumb resolves renderer PNG`)
  }
  const before = indexed.find(row => row.slide_id === 'local').render_hash
  writeFileSync(local, svg('green'))
  const after = (await compile(true)).find(row => row.slide_id === 'local').render_hash
  assert.notEqual(after, before, 'changing local image bytes changes indexed key')
  const pooledBefore = indexed.find(row => row.slide_id === 'pooled').render_hash
  writeFileSync(pooled, await png('yellow'))
  const pooledAfter = (await compile(true)).find(row => row.slide_id === 'pooled').render_hash
  assert.notEqual(pooledAfter, pooledBefore, 'changing pooled image bytes changes indexed key')
  console.log('PASS slide browser picture keys: local, pooled, plain, media edits')
} finally {
  rmSync(root, { recursive: true, force: true })
}
