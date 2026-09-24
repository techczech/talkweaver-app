import assert from 'node:assert/strict'
import { statSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildPerSlideProjections } from '../compiler/scripts/lib/10-projections.mjs'
const source = '---\noutline_version: 2\ntitle: Large deck\n---\n\n' + Array.from({length: 160}, (_, i) => `### Slide ${i} {#slide-${i}}\n\nBody ${i}\n`).join('\n')
const compile = async text => {
  const start = performance.now()
  const model = await prepareSource('/tmp/large-outline.md', text, 'large', statSync('package.json'))
  console.log(`compile: ${Math.round(performance.now()-start)}ms, ${(model.fullHtml.length / 1048576).toFixed(2)}MB`)
  return buildPerSlideProjections(model, 'large')
}
const before = await compile(source)
const after = await compile(source.replace('Body 80\n', 'Edited body 80\n'))
assert.ok(before.every(r => /^[a-f0-9]{64}$/.test(r.thumbnail_hash)), 'each compiled slide has a picture fingerprint')
assert.equal(after.filter((r, i) => r.thumbnail_hash !== before[i].thumbnail_hash).length, 1, 'editing one of 160 slides invalidates only that picture')
const font = await compile(source.replace('title: Large deck', 'title: Large deck\nfont: verdana'))
assert.ok(font.every((r,i) => r.thumbnail_hash !== before[i].thumbnail_hash), 'deck font invalidates every picture')
const sections='---\noutline_version: 2\ntitle: Sections\n---\n\n## First\n\n### One {#one}\n\nText\n\n## Second\n\n### Two {#two}\n\nText\n'
const plain = await compile(sections)
const coloured = await compile(sections.replace('## Second', '## Second\n{accent=cobalt}'))
assert.notEqual(plain.find(r=>r.slide_id==='two').thumbnail_hash, coloured.find(r=>r.slide_id==='two').thumbnail_hash, 'section accent invalidates dependent slides')
console.log('PASS incremental thumbnails: 160 slides, local edit, font, section colour')

const mediaDir=mkdtempSync(join(tmpdir(),'tw-thumbnail-media-'))
const image=join(mediaDir,'image.svg'), outline=join(mediaDir,'media-outline.md')
const mediaSource='---\noutline_version: 2\ntitle: Media\n---\n\n### Picture {#picture}\n\n![](image.svg)\n\n### Plain {#plain}\n\nUnchanged\n'
const svg=colour=>`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="${colour}"/></svg>`
writeFileSync(outline,mediaSource);writeFileSync(image,svg('red'))
const pictureBefore=buildPerSlideProjections(await prepareSource(outline,mediaSource,'media',statSync(outline)),'media')
writeFileSync(image,svg('green'))
const pictureAfter=buildPerSlideProjections(await prepareSource(outline,mediaSource,'media',statSync(outline)),'media')
assert.notEqual(pictureBefore.find(r=>r.slide_id==='picture').thumbnail_hash,pictureAfter.find(r=>r.slide_id==='picture').thumbnail_hash,'changed inline media invalidates its picture')
assert.equal(pictureBefore.find(r=>r.slide_id==='plain').thumbnail_hash,pictureAfter.find(r=>r.slide_id==='plain').thumbnail_hash,'unrelated slide survives media change')
console.log('PASS incremental thumbnails: inlined image bytes affect only their slide')
