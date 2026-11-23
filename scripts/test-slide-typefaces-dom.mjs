import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,writeFileSync,rmSync,statSync,copyFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {chromium} from 'playwright'
import {prepareSource} from '../compiler/scripts/lib/08-source-adapters.mjs'
import {extractSlides,extractStyles} from '../compiler/scripts/lib/04-html-extraction.mjs'
import {createInstantSlideSurface,instantSlideStyles} from '../compiler/assets/runtime/instant-slide.js'
import {buildShareHtml} from '../compiler/scripts/lib/09-output-builders.mjs'
const czechLetters = 'ěščřžýáíéůúĚŠČŘŽÝÁÍÉŮÚ'

async function verifyRenderedCzech(page, surface, displayFamily, textFamily) {
  const isPresenter = surface === 'presenter'
  const scope = isPresenter ? page.frameLocator('#currentPreview > iframe').first() : page
  const heading = '.stage > .slide.active[data-id="typeface-czech"] .slide-head h1'
  const paragraph = '.stage > .slide.active[data-id="typeface-czech"] .slide-content > p'
  await scope.locator(heading).waitFor()
  await scope.locator(heading).evaluate(element => element.ownerDocument.fonts.ready)
  assert.equal(await scope.locator(paragraph).evaluate(element => getComputedStyle(element).fontWeight), '400')
  assert.deepEqual(await scope.locator('.slide.active[data-id="typeface-czech"] li strong').evaluate(element => {
    const style = getComputedStyle(element)
    return [style.fontWeight, style.textDecorationLine]
  }), ['700', 'none'], `${surface}: selected typeface retains bold emphasis without an underline`)
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('DOM.enable')
    await cdp.send('CSS.enable')
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 })
    let documentId = root.nodeId
    if (isPresenter) {
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: documentId, selector: '#currentPreview > iframe' })
      const { node } = await cdp.send('DOM.describeNode', { nodeId, pierce: true })
      assert.ok(node.contentDocument, 'presenter iframe has its own document')
      const { nodeIds } = await cdp.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [node.contentDocument.backendNodeId] })
      documentId = nodeIds[0]
    }
    for (const [selector, family] of [[heading, displayFamily], [paragraph, textFamily]]) {
      assert.equal(await scope.locator(selector).textContent(), czechLetters)
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: documentId, selector })
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId })
      const drawn = fonts.map(({ familyName, glyphCount, isCustomFont }) => ({ familyName, glyphCount, isCustomFont }))
      // Static font files may report their weight as part of the platform family name.
      assert.ok(drawn.every(font => font.isCustomFont && (font.familyName === family || font.familyName.startsWith(family + ' '))),
        `${surface} ${family}: fallback font rendered Czech text: ${JSON.stringify(drawn)}`)
      assert.equal(drawn.reduce((total, font) => total + font.glyphCount, 0), czechLetters.length,
        `${surface} ${family}: every Czech letter painted`)
    }
  } finally {
    await cdp.detach()
  }
}

const scratch=mkdtempSync(join(resolve('.'),'.tw-typefaces-dom-'))
const browser=await chromium.launch({headless:true})
try {
 const page=await browser.newPage({viewport:{width:1600,height:900}})
 await page.context().setOffline(true)
 const errors=[];page.on('pageerror',e=>errors.push(e.message))
 for(const [face,family] of [['inter','Inter'],['serif','Alegreya Sans'],['geist','Geist']]) {
  const diagrams = [
   ['diagram', ''],
   ['configured-diagram', '---\ntitle: Authored diagram title\nconfig:\n  flowchart:\n    curve: step\n---\n']
  ]
  const diagramSlides = diagrams.map(([id, config]) =>
   ['### Řeč', `{id=${id}}`, '', '```mermaid', config + 'flowchart LR', '  A[Řeč] --> B[Učení]', '```', ''].join('\n')
  ).join('\n')
  const source=`---\ntitle: Offline typeface diagrams\ntypeface: ${face}\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n${diagramSlides}\n### Příklady\n{mindmap}{id=map}\n\n- Učení\n  - Řeč\n  - Příliš žluťoučký kůň\n`
  const path=join(scratch,`${face}-outline.md`);writeFileSync(path,source)
  const model=await prepareSource(path,source,face,statSync(path))
  const sample='Příliš žluťoučký kůň úpěl ďábelské ódy';
  const weights=face==='serif'?[['Fraunces',600],['Alegreya Sans',400],['Alegreya Sans',700]]:(face==='inter'?[300,400,600,700]:[400,600,700]).map(w=>[family,w]);
  async function verifyFonts(html) {
   await page.setContent('<style>'+extractStyles(html)+'</style>');
   for(const [name,weight] of weights) {
    const got=await page.evaluate(async ({name,weight,sample})=>{
     const spec=weight+' 64px "'+name+'"';const faces=await document.fonts.load(spec,sample);
     const c=document.createElement('canvas').getContext('2d');c.font=spec+',monospace';const actual=c.measureText(sample).width;c.font=weight+' 64px monospace';return {loaded:document.fonts.check(spec,sample),extended:faces.some(f=>/U\+0?100(?:-|,|$)/i.test(f.unicodeRange)&&f.status==='loaded'),weights:faces.every(f=>{const range=f.weight==='normal'?[400]:f.weight.split(/\s+/).map(Number);return range.length===1?range[0]===weight:weight>=range[0]&&weight<=range[1]}),actual,fallback:c.measureText(sample).width};
    },{name,weight,sample});
    assert.ok(got.loaded&&got.extended&&got.weights&&Math.abs(got.actual-got.fallback)>.01,name+' '+weight+' fell back');
   }
  }
  const probeFile=join(scratch,'font-probe.html');writeFileSync(probeFile,'<!doctype html><body>Font probe</body>');await page.goto(pathToFileURL(probeFile).href);
  await verifyFonts(String(model.fullHtml));
  const tempFont=join(scratch,'removed.woff2');
  const extFile={inter:'inter-latin-ext-300-normal.woff2',serif:'fraunces-latin-ext-600-normal.woff2',geist:'geist-latin-ext-wght-normal.woff2'}[face];
  copyFileSync(join('compiler/assets/fonts',extFile),tempFont);
  function withTempSubset(url) {
   let replaced=false;
   const html=String(model.fullHtml).replace(/@font-face\s*\{[^}]*\}/g,block=>{
    if(replaced||!block.includes("font-family: '"+weights[0][0]+"'")||!block.includes('unicode-range: U+0100'))return block;
    replaced=true;return block.replace(/src:\s*url\([^)]*\)[^;]*;/,'src: url("'+url+'");');
   });
   assert.ok(replaced,'mutation targets the first used extended face, leaving Latin and other weights available');
   return html;
  }
  // First prove the temp file works at this origin. A fresh URL prevents a cached font hiding deletion.
  await verifyFonts(withTempSubset(pathToFileURL(tempFont).href+'?present'));
  rmSync(tempFont);
  await assert.rejects(()=>verifyFonts(withTempSubset(pathToFileURL(tempFont).href+'?removed')),undefined,'removing one extended font source must fail the browser assertion');
  console.log('Fallback mutation fails as required:',face);
  const lateSource=`---\nfont: ${face}\nauthor: Example Presenter\nauto_title_slide: false\nauto_thanks_slide: false\n---\n### Plain title\nPlain English words.\n`;
  const late=await prepareSource(path,lateSource,'late',statSync(path));
  assert.ok(extractStyles(String(late.fullHtml)).includes('unicode-range: U+0100'));
  const lateFile=join(scratch,face+'-late.html');writeFileSync(lateFile,String(late.fullHtml));await page.goto(pathToFileURL(lateFile).href);
  await page.evaluate(text=>{const p=document.createElement('p');p.textContent=text;document.querySelector('.slide.active .slide-content').appendChild(p)},sample);
  await page.addStyleTag({content:instantSlideStyles});await page.addScriptTag({content:'window.makeTypefaceInstant='+createInstantSlideSurface.toString()});
  const instantFamily=await page.evaluate(sample=>{const surface=window.makeTypefaceInstant(document.body);surface.show({kind:'text',text:sample});const family=getComputedStyle(surface.element.querySelector('.instant-slide-text')).fontFamily;surface.destroy();return family},sample);
  assert.ok(instantFamily.includes(face==='serif'?'Fraunces':family),'instant Czech text must use selected display face');

  const lateProof=await page.evaluate(async ({sample,family})=>{await document.fonts.load('400 32px "'+family+'"',sample);const span=document.createElement('span');span.textContent=sample;span.style.cssText='font-size:32px;white-space:nowrap;display:inline-block;width:max-content;max-width:none';document.querySelector('.slide.active .slide-content').appendChild(span);const selected=getComputedStyle(span).fontFamily,actual=span.getBoundingClientRect().width;span.style.fontFamily='monospace';return {selected,actual,fallback:span.getBoundingClientRect().width,loaded:document.fonts.check('400 32px "'+family+'"',sample)}},{sample,family});
  assert.ok(lateProof.loaded&&lateProof.selected.includes(family)&&Math.abs(lateProof.actual-lateProof.fallback)>.01,'late Czech text must use selected bundled face: '+JSON.stringify(lateProof));

  const framedSource=lateSource+'\n### Poll {poll=single} {id=typeface-poll}\n\n- Řeč\n- Učení\n\n### Chat {chat} {id=typeface-chat}\n\n'+['```chat','user: Jak se učíme?','bot: Příliš žluťoučký kůň.','```'].join('\n');
  const framed=await prepareSource(path,framedSource,'framed',statSync(path));
  const framedFile=join(scratch,face+'-presenter.html');writeFileSync(framedFile,String(framed.fullHtml));
  for(const [id,selector] of [['typeface-poll','.poll-frame:not([hidden])'],['typeface-chat','.sim']]) {
   await page.goto(pathToFileURL(framedFile).href+'?presenter=1#'+id);await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(250);
   const iframe=page.locator('#currentPreview > iframe').first();await iframe.waitFor();
   const frame=await (await iframe.elementHandle()).contentFrame();
   const block=frame.locator('.slide.active '+selector);await block.waitFor();
   const framedFamily=await block.evaluate(e=>getComputedStyle(e).fontFamily);assert.ok(framedFamily.includes(family),framedFamily);
   const proof=await frame.evaluate(async ({family,sample})=>{await document.fonts.load('400 32px "'+family+'"',sample);const c=document.createElement('canvas').getContext('2d');c.font='400 32px "'+family+'",monospace';const actual=c.measureText(sample).width;c.font='400 32px monospace';return {loaded:document.fonts.check('400 32px "'+family+'"',sample),actual,fallback:c.measureText(sample).width}},{family,sample});
   assert.ok(proof.loaded&&Math.abs(proof.actual-proof.fallback)>.01,'late Czech text in actual presenter poll/chat iframe');
  }
  const surfaces={deck:String(model.fullHtml),handout:buildShareHtml({title:face,slides:extractSlides(model.fullHtml),styles:extractStyles(model.fullHtml),includeNotes:true,slug:face})}
  for(const [surface,html] of Object.entries(surfaces)) {
   console.log('Checking',face,surface)
   const file=join(scratch,`${face}-${surface}.html`);writeFileSync(file,html)
   for (const [id, config] of diagrams) {
    await page.goto(pathToFileURL(file).href + '#' + id)
    const host = page.locator(`.slide.active[data-id="${id}"] .mermaid-mm`)
    const context = `${face}/${surface}/${id}`
    await host.locator('svg, .mmd-error').first().waitFor({ timeout: 10000 })
    assert.deepEqual(await host.locator('.mmd-error').allTextContents(), [], `${context}: diagram renders`)
    const got = await host.locator('.nodeLabel').first().evaluate(e => getComputedStyle(e).fontFamily)
    assert.ok(got.includes(family), `${context} Mermaid family: ${got}`)
    if (config) assert.equal(await host.locator('.flowchartTitleText').textContent(), 'Authored diagram title', context)
    assert.equal(await page.evaluate(() => window.mermaid.mermaidAPI.getConfig().securityLevel), 'strict')
   }
   await page.evaluate(()=>{location.hash='map'})
   await page.waitForSelector('.mindmap-mm .markmap-node')
   const map=await page.locator('.mindmap-mm .markmap-node').first().evaluate(e=>({family:getComputedStyle(e).fontFamily,weight:getComputedStyle(e).fontWeight}))
   assert.ok(map.family.includes(family),`${face}/${surface} Markmap family: ${map.family}`)
   assert.equal(map.weight,'400')
   // fonts.check() is also true when no face of that family exists, so prove the bundled face is in this
   // document and draws Czech text differently from a forced fallback.
   const proof=await page.evaluate(async ({family,sample})=>{const spec='400 40px "'+family+'"';const loaded=(await document.fonts.load(spec,sample)).some(f=>f.status==='loaded');const c=document.createElement('canvas').getContext('2d');c.font=spec+',monospace';const actual=c.measureText(sample).width;c.font='400 40px monospace';return {loaded,actual,fallback:c.measureText(sample).width}},{family,sample})
   assert.ok(proof.loaded&&Math.abs(proof.actual-proof.fallback)>.01,`${face}/${surface}: bundled ${family} did not render Czech text `+JSON.stringify(proof))
  }
  const czechSource = `---\nfont: ${face}\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n### ${czechLetters}\n{id=typeface-czech}\n\n${czechLetters}\n\n- A short **supporting** point.\n`
  const czechModel = await prepareSource(path, czechSource, 'Czech typeface fixture', statSync(path))
  const czechDeck = String(czechModel.fullHtml)
  const czechHandout = buildShareHtml({
    title: 'Czech typeface fixture', slides: extractSlides(czechDeck), styles: extractStyles(czechDeck),
    includeNotes: false, slug: 'czech-typeface-fixture',
  })
  for (const surface of ['deck', 'presenter', 'handout']) {
    const czechFile = join(scratch, `${face}-czech-${surface}.html`)
    writeFileSync(czechFile, surface === 'handout' ? czechHandout : czechDeck)
    await page.goto(pathToFileURL(czechFile).href + (surface === 'presenter' ? '?presenter=1' : '') + '#typeface-czech')
    await verifyRenderedCzech(page, surface, face === 'serif' ? 'Fraunces' : family, family)
  }

  const fixture=resolve('docs/layout-sampler-outline.md'), text=readFileSync(fixture,'utf8').replace('---\n',`---\ntypeface: ${face}\n`)
  const sampler=await prepareSource(fixture,text,'sampler',statSync(fixture),undefined,{allowedAssetRoots:[resolve('docs'),resolve('e2e/fixtures')]})
  const file=join(scratch,face+'-sampler.html');writeFileSync(file,String(sampler.fullHtml))
  await page.goto(pathToFileURL(file).href+'#quote-form-book');await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(200)
  const weightsFound=await page.locator('.slide :is(h1,h2,h3)').evaluateAll(es=>es.map(e=>({id:e.closest('.slide').dataset.id,weight:getComputedStyle(e).fontWeight})));
  assert.deepEqual(weightsFound.filter(r=>r.weight!=='600'),[],face+' headings must use display weight token');
  const covers=await page.locator('.slide.active .qf-cover-title').evaluateAll(es=>es.map(e=>({height:e.clientHeight,ink:e.scrollHeight})))
  assert.ok(covers.length,'book-cover regression fixture exists')
  for(const c of covers)assert.ok(c.ink<=c.height+1.5,`${face}: book title ink ${c.ink} exceeds box ${c.height}`)
 }
 assert.deepEqual(errors,[])
 console.log('Slide typefaces DOM: 3 faces, all 22 Czech letters in display and body fonts on decks, presenter and handouts; offline diagrams and book-cover fit pass')
} finally {await browser.close();rmSync(scratch,{recursive:true,force:true})}
