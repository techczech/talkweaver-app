// Hidden real workspace, synthetic 160-slide deck. Assert DOM continuity, not compile time.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
const repo = resolve('.')
const evidenceDir=process.env.TW_GRID_CONTINUITY_EVIDENCE_DIR ? resolve(process.env.TW_GRID_CONTINUITY_EVIDENCE_DIR) : null
if(evidenceDir) {assert.ok(evidenceDir.startsWith(join(repo,'research')+'/'));mkdirSync(evidenceDir,{recursive:true})}
mkdirSync(new URL('../research/', import.meta.url), { recursive: true })
const scratch = mkdtempSync(join(repo, 'research/.test-grid-continuity-'))
const vault = join(scratch,'vault'), ud=join(scratch,'userData'), deck=join(vault,'continuity')
mkdirSync(deck,{recursive:true}); mkdirSync(ud)
const source = '---\noutline_version: 2\ntitle: Grid continuity fixture\n---\n\n' + Array.from({length:4},(_,s)=>
  `## Section ${s}\n{id=section${s}}\n\n` + Array.from({length:40},(_,i)=>`### Slide ${s*40+i}\n{id=s${s*40+i}}\n\n- Body ${i}\n`).join('\n')).join('\n')
const path=join(deck,'continuity-outline.md')
writeFileSync(path,source)
writeFileSync(join(ud,'config.json'),JSON.stringify({vaultRoot:vault,editorViewMode:'plain'}))
const env={...process.env,TW_E2E:'1',TW_REC_TEST:'1'}; delete env.ELECTRON_RUN_AS_NODE
let app
try {
  await ensureFreshBuild(repo)
  app=await electron.launch({args:['.',`--user-data-dir=${ud}`,'--use-mock-keychain'],cwd:repo,env})
  if(evidenceDir)for(const stream of [app.process().stdout,app.process().stderr])stream?.on('data',chunk=>appendFileSync(join(evidenceDir,'checks-grid-continuity-runtime.log'),chunk))
  const page=await app.firstWindow(); page.setDefaultTimeout(30000)
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ipcMain})=>{
    const compile=ipcMain._invokeHandlers.get('talk:compile')
    const thumbnails=ipcMain._invokeHandlers.get('talk:thumbnails')
    globalThis.__thumbnailWork=new Set()
    if(thumbnails) ipcMain._invokeHandlers.set('talk:thumbnails',(...args)=>{
      const pending=Promise.resolve(thumbnails(...args)).then(map=>{(globalThis.__thumbOutcomes??=[]).push({request:args[3]?.requestId,count:Object.keys(map??{}).length});return map})
      globalThis.__thumbnailWork.add(pending)
      pending.finally(()=>globalThis.__thumbnailWork.delete(pending))
      return pending
    })
    ipcMain._invokeHandlers.set('talk:compile',async (...args)=>{
      if(globalThis.__delayCompile) await new Promise(r=>setTimeout(r,globalThis.__delayCompile))
      const rows=await compile(...args);globalThis.__probeRows=rows;globalThis.__probeSource=args[2];(globalThis.__rowHistory??=[]).push(rows?.map(({slide_id,source_line,source_markdown,section,role,render_hash,thumbnail_hash})=>({slide_id,source_line,source_markdown,section,role,render_hash,thumbnail_hash})));return rows
    })
  })
  await page.evaluate(()=>{
    const decode=HTMLImageElement.prototype.decode;window.decodeFailures=[]
    HTMLImageElement.prototype.decode=function(){const image=this;return decode.call(image).catch(error=>{window.decodeFailures.push({src:image.src,complete:image.complete,width:image.naturalWidth,message:error.message});throw error})}
  })
  if(process.env.TW_GRID_SERIAL_DECODE) await page.evaluate(()=>{
    const decode=HTMLImageElement.prototype.decode;let queue=Promise.resolve()
    HTMLImageElement.prototype.decode=function(){const image=this;const work=queue.then(()=>decode.call(image));queue=work.catch(()=>{});return work}
  })
  await page.getByText('Grid continuity fixture',{exact:true}).first().dblclick()
  await page.locator('.cm-content').waitFor()
  await page.locator('.pane-btn[title="Grid"]').click()
  await page.waitForFunction(()=>document.querySelectorAll('.grid-cell img').length===166)
  const titleOf=n=>typeof n==='number'?`Slide ${n}`:n
  const card=n=>page.locator('.grid-cell').filter({has:page.locator('span',{hasText:new RegExp(`^${titleOf(n)}$`)})}).first()
  await card(67).click()
  await page.evaluate(async()=>{
    const v=document.querySelector('.grid-view')
    for(const img of v.querySelectorAll('img')) img.loading='eager'
    const target=[...v.querySelectorAll('.grid-cell')].find(c=>c.querySelector('img')?.alt==='Slide 72')
    v.scrollTop+=target.getBoundingClientRect().top-v.getBoundingClientRect().top-v.clientHeight/2
  })
  await page.waitForFunction(()=>[...document.querySelectorAll('.grid-cell img')].every(i=>i.complete&&i.naturalWidth))
  // waitForFunction polls DOM predicates; disk IO needs an awaited file condition of its own.
  const waitForDisk=async(predicate)=>{
    const deadline=Date.now()+30000
    while(Date.now()<deadline){const text=readFileSync(path,'utf8');if(predicate(text))return text;await page.waitForTimeout(20)}
    assert.fail('synthetic outline did not reach the expected disk revision within 30000ms')
  }
  const evidence=[], undoEvidence=[]
  const probe=async (from,to,delay=0,landAfter=to,settleMs=1600,offset=1)=>{
    from=titleOf(from);to=titleOf(to);landAfter=titleOf(landAfter)
    await card(to).evaluate(c=>{const v=c.closest('.grid-view');v.scrollTop+=c.getBoundingClientRect().top-v.getBoundingClientRect().top-v.clientHeight/2})
    await page.waitForTimeout(50)
    await app.evaluate((_,ms)=>{globalThis.__delayCompile=ms},delay)
    await page.evaluate(()=>{
      const v=document.querySelector('.grid-view')
      window.__before=[...v.querySelectorAll('.grid-cell')].map(c=>({title:c.querySelector('img')?.alt,node:c,img:c.querySelector('img'),src:c.querySelector('img')?.src}))
      window.__probe={start:performance.now(),scroll:v.scrollTop,frames:[],swaps:0,removed:0}
      window.__observer=new MutationObserver(ms=>{for(const m of ms){if(m.type==='attributes'&&m.attributeName==='src')window.__probe.swaps++;for(const n of m.removedNodes)if(n.nodeType===1)window.__probe.removed+=n.matches?.('.grid-cell')?1:n.querySelectorAll?.('.grid-cell').length??0}})
      window.__observer.observe(v,{subtree:true,childList:true,attributes:true,attributeFilter:['src']})
      window.__sampling=true
      const sample=()=>{if(!window.__sampling)return;const cells=[...v.querySelectorAll('.grid-cell')],images=cells.map(c=>c.querySelector('img'));window.__probe.frames.push({ms:performance.now()-window.__probe.start,scroll:v.scrollTop,blank:images.filter(i=>!i||!i.complete||!i.naturalWidth).length,order:images.map(i=>i?.alt).join('|')});requestAnimationFrame(sample)}
      requestAnimationFrame(sample)
    })
    await card(from).evaluate((s,to)=>{
      const d=[...document.querySelectorAll('.grid-cell')].find(c=>c.querySelector('img')?.alt===to),dt=new DataTransfer()
      for(const [el,type] of [[s,'dragstart'],[d,'dragover'],[d,'drop'],[s,'dragend']])el.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:dt}))
    },to)
    await page.waitForFunction(({from,to,offset})=>{const t=[...document.querySelectorAll('.grid-cell img')].map(i=>i.alt);return t.indexOf(from)===t.indexOf(to)+offset},{from,to:landAfter,offset})
    await page.waitForTimeout(settleMs)
    if(settleMs>=1600) {
      await app.evaluate(async()=>{await Promise.all([...globalThis.__thumbnailWork])})
      await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))
    }
    const result=await page.evaluate(({from,to,offset})=>{
      window.__sampling=false;window.__observer.disconnect()
      const p=window.__probe,b=window.__before,v=document.querySelector('.grid-view'),after=[...v.querySelectorAll('.grid-cell')]
      const retained=b.filter(x=>x.node.isConnected).length, imgs=b.filter(x=>x.img?.isConnected).length
      const order=p.frames.find(f=>f.order.split('|').indexOf(from) === f.order.split('|').indexOf(to)+offset)
      return {...p,frames:p.frames.map(({order,...f})=>f),retained,imgs,total:b.length,lostTitles:b.filter(x=>!x.node.isConnected).map(x=>x.title),changedImages:b.filter(x=>x.img?.isConnected&&x.img.src!==x.src).map(x=>x.title),firstRelocationMs:order?.ms??null,scrollAfter:v.scrollTop,active:after.find(c=>c.dataset.active==='true')?.querySelector('img')?.alt}
    },{from,to:landAfter,offset})
    assert.ok(result.frames.every(frame=>Math.abs(frame.scroll-result.scroll)<2),'drop preserves the viewport through thumbnail completion')
    assert.equal(result.active,from,'the moved item is active at its current destination')
    evidence.push({from,to,delay,...result})
    const {frames,...summary}=result
    console.log('CONTINUITY',JSON.stringify({...summary,blankFrames:frames.filter(f=>f.blank>0).length,frameCount:frames.length}))
    return result
  }
  const baseline=readFileSync(path,'utf8')
  const result=await probe(65,72,1200)

  assert.equal(result.retained,result.total,'within-section move must retain every existing card DOM node')
  assert.equal(result.imgs,result.total,'within-section move must retain every existing image DOM node')
  assert.equal(result.swaps,0,'unchanged artwork must not change image src')
  assert.equal(result.frames.filter(f=>f.blank>0).length,0,'loaded cards never become blank during a move')
  assert.equal(result.active,'Slide 65','the moved card stays active at its destination')
  assert.ok(Math.abs(result.scrollAfter-result.scroll)<2,'a visible local move preserves the viewport')
  assert.ok(result.firstRelocationMs<100,'accepted drop relocates existing cards within 100ms')
  await page.locator('.grid-view').focus(); await page.keyboard.press('Meta+z')
  await waitForDisk(text=>text===baseline)
  await page.waitForTimeout(1400)
  const cross=await probe(65,85,1200)

  assert.equal(cross.retained,cross.total-1,'cross-section move retains every unaffected card')
  assert.equal(cross.imgs,cross.total-1,'cross-section move retains every unaffected image')
  assert.equal(cross.frames.filter(f=>f.blank>0).length,0,'cross-section move never blanks loaded pictures')
  assert.ok(cross.firstRelocationMs<100,'cross-section move is visible before compile completion')
  assert.equal(cross.active,'Slide 65')
  assert.deepEqual(cross.lostTitles,['Slide 65'],'only the cross-parent moved card remounts')
  assert.deepEqual(cross.changedImages,[],'unaffected image elements keep their own exact src')
  const restore=async(expectedLost=[])=>{
    // A section expanded since the previous probe adds offscreen lazy images. Establish the
    // assertion's loaded-picture precondition before sampling Undo, as probe() does for moves.
    await page.evaluate(()=>{for(const image of document.querySelectorAll('.grid-cell img'))image.loading='eager'})
    await page.waitForFunction(()=>[...document.querySelectorAll('.grid-cell')].every(c=>{const i=c.querySelector('img');return i&&i.complete&&i.naturalWidth}))
    await page.evaluate(()=>{
      const v=document.querySelector('.grid-view');window.__undoNodes=[...v.querySelectorAll('.grid-cell')].map(c=>({title:c.querySelector('img')?.alt,node:c,img:c.querySelector('img')}))
      window.__undoFrames=[];window.__undoSampling=true
      const sample=()=>{if(!window.__undoSampling)return;window.__undoFrames.push({scroll:v.scrollTop,blank:[...v.querySelectorAll('.grid-cell')].filter(c=>{const i=c.querySelector('img');return !i||!i.complete||!i.naturalWidth}).length});requestAnimationFrame(sample)}
      requestAnimationFrame(sample)
    })
    await page.locator('.grid-view').focus();await page.keyboard.press('Meta+z')
    await waitForDisk(text=>text===baseline)
    // Undo persists through the normal 1500ms autosave; assert the actual disk bytes afterwards.
    await page.waitForTimeout(1800)
    assert.equal(readFileSync(path,'utf8'),baseline,'one Undo restores exact source bytes')
    await app.evaluate(async()=>{await Promise.all([...globalThis.__thumbnailWork])})
    if(process.env.TW_GRID_DECODE_PROBE){await page.waitForTimeout(100);const missing=await page.locator('.grid-cell').count()-await page.locator('.grid-cell img').count();if(missing)throw new Error('completed request missing '+missing+' displayed images')}
    // Collapsing/remounting deliberately restores native lazy images; load this hidden fixture's offscreen cards before the next probe.
    await page.evaluate(()=>{for(const image of document.querySelectorAll('.grid-cell img'))image.loading='eager'})
    await page.waitForFunction(()=>[...document.querySelectorAll('.grid-cell')].every(c=>{const i=c.querySelector('img');return i&&i.complete&&i.naturalWidth}))
    const result=await page.evaluate(()=>{window.__undoSampling=false;return {frames:window.__undoFrames,lostTitles:window.__undoNodes.filter(x=>!x.node.isConnected).map(x=>x.title),lostImages:window.__undoNodes.filter(x=>!x.img?.isConnected).map(x=>x.title),active:document.querySelector('.grid-cell[data-active="true"] img')?.alt}})
    undoEvidence.push(result)
    assert.deepEqual(result.lostTitles,expectedLost,'Undo retains every unaffected card')
    assert.deepEqual(result.lostImages,expectedLost,'Undo retains every unaffected image')
    assert.equal(result.frames.filter(f=>f.blank>0).length,0,'Undo never blanks loaded pictures')
  }
  await restore(['Slide 65'])
  for(const n of [65,66,67])await card(n).locator('[data-grid-tick]').click()
  const batch=await probe(65,72,1200)
  assert.equal(batch.retained,batch.total,'a local batch move retains all card nodes')
  assert.equal(batch.imgs,batch.total,'a local batch move retains all image nodes')
  assert.equal(batch.frames.filter(f=>f.blank>0).length,0)
  assert.equal(await page.locator('[data-batch-count]').textContent(),'3 selected')
  await restore()
  await page.locator('[data-batch-action="clear"]').click()
  const section=await probe('Section 1','Section 2',1200,'Slide 119')
  assert.equal(section.retained,section.total,'a whole-section move retains every card in its subtree')
  assert.equal(section.imgs,section.total,'a whole-section move retains every image in its subtree')
  assert.equal(section.frames.filter(f=>f.blank>0).length,0)
  assert.equal(section.active,'Section 1')
  await restore()
  // Three more moves before ANY of their delayed compiles can return, then shared Undo/Redo.
  for(const target of [72,73,74]) {
    const rapid=await probe(65,target,1200,target,40)
    assert.equal(rapid.retained,rapid.total)
    assert.equal(rapid.frames.filter(f=>f.blank>0).length,0)
    assert.ok(rapid.firstRelocationMs<100)
  }
  await page.locator('.grid-view').focus()
  for(let i=0;i<3;i++)await page.keyboard.press('Meta+z')
  await waitForDisk(text=>text===baseline)
  for(let i=0;i<3;i++)await page.keyboard.press('Meta+Shift+z')
  await page.waitForFunction(()=>{const t=[...document.querySelectorAll('.grid-cell img')].map(i=>i.alt);return t.indexOf('Slide 65')===t.indexOf('Slide 74')+1})
  for(let i=0;i<3;i++)await page.keyboard.press('Meta+z')
  await page.waitForTimeout(1800)
  assert.equal(readFileSync(path,'utf8'),baseline,'rapid moves and late compiles reconcile with shared Undo/Redo')
  const last=await probe(0,159,1200)
  assert.deepEqual(last.lostTitles,['Slide 0'])
  assert.equal(last.frames.filter(f=>f.blank>0).length,0)
  await restore(['Slide 0'])
  const first=await probe(159,0,1200,0,1600,-1)
  assert.deepEqual(first.lostTitles,['Slide 159'])
  assert.equal(first.frames.filter(f=>f.blank>0).length,0)
  await restore(['Slide 159'])
  await page.locator('[data-grid-search]').fill('Slide 6')
  await page.locator('[data-section-header]').filter({hasText:'Section 0'}).click()
  const searched=await probe(65,72,1200)
  assert.equal(searched.retained,searched.total,'search and a collapsed neighbouring section preserve unaffected cards')
  assert.equal(searched.frames.filter(f=>f.blank>0).length,0)
  await restore()
  await page.locator('[data-grid-search]').fill('')
  await page.locator('[data-section-header]').filter({hasText:'Section 0'}).click()
  // A drag captures refs, then a keyboard move changes those source lines before drop.
  await card(65).click();await page.locator('.grid-view').focus()
  await card(65).evaluate(s=>{window.staleSource=s;window.staleTransfer=new DataTransfer();s.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:window.staleTransfer}))})
  await page.keyboard.press('Meta+ArrowDown')
  await page.waitForFunction(()=>{const t=[...document.querySelectorAll('.grid-cell img')].map(i=>i.alt);return t.indexOf('Slide 65')===t.indexOf('Slide 66')+1})
  const afterStep=await waitForDisk(text=>{const a=text.indexOf('### Slide 66'),b=text.indexOf('### Slide 65');return a>=0&&b>=0&&a<b})
  await card(72).evaluate(d=>{for(const type of ['dragover','drop'])d.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:window.staleTransfer}));window.staleSource.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:window.staleTransfer}))})
  await page.getByText('The talk changed while you were moving the slide, and it is no longer where it was. Nothing was moved; try again.',{exact:true}).waitFor()
  assert.equal(await page.evaluate(path=>window.tw.talk.readOutline(path),path),afterStep,'a stale drop cannot mutate the current source')
  await restore()
  if(evidenceDir)writeFileSync(join(evidenceDir,'checks-grid-continuity-undo-evidence.json'),JSON.stringify(undoEvidence,null,2))
  if(evidenceDir)writeFileSync(join(evidenceDir,'checks-grid-continuity-decode-failures.json'),JSON.stringify(await page.evaluate(()=>window.decodeFailures),null,2))
  if(evidenceDir)writeFileSync(join(evidenceDir,'checks-grid-continuity-row-history.json'),JSON.stringify(await app.evaluate(()=>globalThis.__rowHistory),null,2))
  if(evidenceDir)writeFileSync(join(evidenceDir,'checks-grid-continuity-evidence.json'),JSON.stringify(evidence,null,2)+'\n')
  assert.ok(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().every(w=>!w.isVisible())))
  console.log('PASS grid movement DOM continuity')
} catch(error) {
 if(app){
 if(evidenceDir)writeFileSync(join(evidenceDir,'checks-grid-continuity-row-history-failure.json'),JSON.stringify(await app.evaluate(()=>globalThis.__rowHistory),null,2))
 const page=await app.firstWindow()
 const missing=await page.evaluate(()=>[...document.querySelectorAll('.grid-cell')].filter(c=>!c.querySelector('img')).map(c=>{
  const key=Object.keys(c).find(k=>k.startsWith('__reactFiber')),root=c[key]
  const find=f=>{for(let n=f;n;n=n.sibling){if(n.memoizedProps?.thumbnailUrl!==undefined)return n;const found=find(n.child);if(found)return found}return null}
  const f=find(root?.child);return {index:c.dataset.slideIndex,props:f?{id:f.memoizedProps.row?.slide_id,candidate:f.memoizedProps.thumbnailUrl,pending:f.memoizedProps.previewsPending}:null,state:f?.memoizedState?.memoizedState}
 }))
 const files=readdirSync(ud,{recursive:true})
 const diskProbe=missing.slice(0,3).map(m=>m.props?.candidate).filter(Boolean).map(url=>{
  const key=new URL(url).pathname.split('/').at(-1)+'.png',matches=files.filter(f=>f.endsWith('/'+key))
  return {url,matches:matches.map(f=>({file:f,bytes:statSync(join(ud,f)).size,magic:readFileSync(join(ud,f)).subarray(0,8).toString('hex')}))}
 })
 const control=await page.locator('.grid-cell img').first().getAttribute('src')
 const loadProbe=await page.evaluate(async urls=>{
   const results=[]
   for(const url of urls){const image=document.createElement('img');image.src=url;let decode;try{await image.decode();decode='ok'}catch(error){decode=error.message}results.push({url,decode,width:image.naturalWidth,complete:image.complete})}
   return results
 },[control,...missing.slice(0,3).map(m=>m.props?.candidate).filter(Boolean)])
 if(evidenceDir)writeFileSync(join(evidenceDir,'checks-grid-continuity-missing-images.json'),JSON.stringify({missing,diskProbe,loadProbe,outcomes:await app.evaluate(()=>globalThis.__thumbOutcomes)},null,2))
 }
 throw error
} finally { try {await app?.close()} finally {rmSync(scratch,{recursive:true,force:true})} }
