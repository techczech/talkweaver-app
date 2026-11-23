import assert from 'node:assert/strict'
import {readFileSync,statSync} from 'node:fs'
import {prepareSource} from '../compiler/scripts/lib/08-source-adapters.mjs'
import {extractSlides,extractStyles} from '../compiler/scripts/lib/04-html-extraction.mjs'
const file=new URL('./fixtures/ocean-look/ten-kinds-outline.md',import.meta.url)
const source=readFileSync(file,'utf8')
for(const palette of ['', 'classic','bold','green']) for(const face of ['', 'inter','serif','geist','trebuchet','gill-sans','verdana']) {
 const text=source.replace('---\n',`---\npalette: ${palette}\n${face ? `typeface: ${face}\n`:''}`)
 const model=await prepareSource(file.pathname,text,'typefaces',statSync(file))
 assert.equal(model.deckFont||'',face)
 for(const slide of extractSlides(String(model.fullHtml))) {
  assert.equal(slide.html.match(/data-deck-font="([^"]+)"/)?.[1] || '', face, 'omitted typeface keeps the existing slide style')
 }
 const styles=extractStyles(String(model.fullHtml))
 assert.equal(styles.includes('data:font/woff2;base64,'), ['inter','serif','geist'].includes(face))
 assert.ok(!styles.includes('../../fonts/'))
}
console.log('28 palette/typeface combinations preserve face through extraction; fonts embedded')

for (const [metadata, expected, warnings] of [
 ['font: verdana\ntypeface: geist', 'verdana', []],
 ['font: serif', 'serif', []],
 ['typeface: papyrus', '', ['font-unknown:papyrus']],
 ['font:', '', ['font-unknown:(empty)']],
]) {
 const model = await prepareSource(file.pathname, source.replace('---\n', `---\n${metadata}\n`), 'typefaces', statSync(file))
 assert.equal(model.deckFont || '', expected)
 assert.deepEqual(model.warnings.filter(w => w.startsWith('font-unknown:')), warnings)
}
console.log('canonical key, alias precedence and unknown value warning verified')

const latin = await prepareSource(file.pathname, source.replace('---\n','---\nfont: inter\n').replaceAll('Dominik Lukeš','Example Presenter'), 'latin', statSync(file))
assert.ok(extractStyles(String(latin.fullHtml)).includes('unicode-range: U+0100'), 'Live Latin slides retain extended faces for late content')
const czech = await prepareSource(file.pathname, source.replace('---\n','---\nfont: inter\n').replaceAll('Dominik Lukeš','Example Presenter').replace('What an agent is','Příliš žluťoučký kůň'), 'czech', statSync(file))
assert.ok(extractStyles(String(czech.fullHtml)).includes('unicode-range: U+0100'), 'Czech slides retain extended font bytes')

for (const spelling of ['font: inter\ntypeface: geist','typeface: geist\nfont: inter']) {
 const m=await prepareSource(file.pathname,source.replace('---\n',`---\n${spelling}\n`),'aliases',statSync(file));
 assert.equal(m.deckFont,'inter');assert.ok(m.warnings.includes('font-both-keys'));
}

const reused=await prepareSource(file.pathname,source.replace('---\n','---\nfont: geist\n').replace(/^(### [^\n]+)$/m,'$1 {from=neutral-source#original}'),'extracted',statSync(file));
for(const slide of extractSlides(String(reused.fullHtml)))assert.ok(slide.html.includes('data-deck-font="geist"'));

const sameFace = await prepareSource(file.pathname,source.replace('---\n','---\nfont: inter\ntypeface: inter\n'),'same-alias',statSync(file));
assert.ok(!sameFace.warnings.includes('font-both-keys'),'matching aliases need no conflict warning');
