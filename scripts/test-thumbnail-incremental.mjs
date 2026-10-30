import assert from 'node:assert/strict'
import { statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildDeckHtmlFromModel } from '../compiler/scripts/lib/07-assembly.mjs'
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
// Reordering independent slides must preserve each unchanged picture. Keep absolute capture indices.
const blocks = source.slice(source.indexOf('### Slide 0')).trimEnd().split('\n\n### ').map((b, i) => i ? '### ' + b : b)
const reordered = await compile(source.slice(0, source.indexOf('### Slide 0')) + [blocks[1], blocks[0], ...blocks.slice(2)].join('\n\n') + '\n')
const byId = new Map(before.map(r => [r.slide_id, r]))
const invalidated = reordered.filter(r => r.thumbnail_hash !== byId.get(r.slide_id)?.thumbnail_hash).length
console.log(`reorder invalidated: ${invalidated}/${before.length}`)
assert.equal(invalidated, 0, 'a flat-deck reorder preserves picture fingerprints by slide identity')
assert.ok(reordered.filter(r => r.render_hash !== byId.get(r.slide_id)?.render_hash).length <= 2, 'source-line movement does not invalidate all model keys (opening heuristic may change)')
// The same size deck with ordinary bullet lists exercises icon-suggestion work on every compile.
const listStarted = performance.now()
const listRows = await compile(source.replace(/Body (\d+)/g, '- Body $1\n- Second point'))
const listMs = performance.now() - listStarted
assert.equal(listRows.length, before.length)
assert.ok(listMs < 1000, `160 ordinary bullet slides compile within 1000ms, took ${Math.round(listMs)}ms`)
const font = await compile(source.replace('title: Large deck', 'title: Large deck\nfont: verdana'))
assert.ok(font.every((r,i) => r.thumbnail_hash !== before[i].thumbnail_hash), 'deck font invalidates every picture')
const sections='---\noutline_version: 2\ntitle: Sections\n---\n\n## First\n\n### One {#one}\n\nText\n\n## Second\n\n### Two {#two}\n\nText\n'
const plain = await compile(sections)
const coloured = await compile(sections.replace('## Second', '## Second\n{accent=cobalt}'))
assert.notEqual(plain.find(r=>r.slide_id==='two').thumbnail_hash, coloured.find(r=>r.slide_id==='two').thumbnail_hash, 'section accent invalidates dependent slides')
// Contextual navigation keeps its whole-sequence dependency, even when the slide markup is unchanged.
const context = await prepareSource('/tmp/context-outline.md', sections.replace('## First', '## First\n{grid-zoom}'), 'context', statSync('package.json'))
assert.ok(context.beats.some(b => b.kind !== 'slide'), 'the conservative probe has contextual beats')
const contextBefore = [...context.thumbnailHashes]
context.beats = [...context.beats].reverse()
await buildDeckHtmlFromModel(context)
assert.ok(context.thumbnailHashes.every((h,i) => h !== contextBefore[i]), 'contextual beat order still invalidates every potentially dependent picture')
console.log('PASS incremental thumbnails: 160 slides, local edit, reorder, bullet-list budget, font, section colour, contextual navigation')

const mediaDir=mkdtempSync(join(tmpdir(),'tw-thumbnail-media-'))
try {
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

} finally { rmSync(mediaDir, {recursive:true, force:true}) }
