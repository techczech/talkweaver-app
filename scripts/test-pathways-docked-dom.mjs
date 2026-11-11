import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
import { chromium } from 'playwright'
const dir = mkdtempSync(join(tmpdir(), 'tw-pathways-dom-'))
let browser
let checks = 0
try {
  await build({ stdin: { contents: `
import React from 'react'
import {createRoot} from 'react-dom/client'
import PathwaysView from './src/renderer/src/components/PathwaysView.tsx'
import GridView from './src/renderer/src/components/GridView.tsx'
import PlanRunSheet from './src/renderer/src/components/PlanRunSheet.tsx'
window.mountReviewProbe=(initial={})=>{
  const probeSlides=['live','later'].map(slide_id=>({slide_id,title:slide_id}));
  let state={docked:false,content:'# Initial',slides:probeSlides,...initial};
  const snapshot=()=>({slides:probeSlides,pathways:[{id:'picked',name:'Picked',slideIds:['live','later','gone'],present:probeSlides,missing:['gone']}]});
  window.reviewReads=[];window.reviewWrites=[];window.reviewPresents=[];
  window.tw.pathways.read=async(path,content)=>{window.reviewReads.push(content);return snapshot()};
  window.tw.pathways.onChanged=handler=>{window.reviewChanged=handler;return ()=>{window.reviewChanged=null}};
  window.tw.pathways.setSlideIds=async(path,content,id,ids)=>{window.reviewWrites.push(ids);return {...snapshot(),pathways:[{...snapshot().pathways[0],slideIds:ids,missing:[]}]}};
  window.tw.pathways.present=async(...args)=>{window.reviewPresents.push(args);return {success:true}};
  const probeRoot=createRoot(document.getElementById('root'));
  const render=()=>probeRoot.render(<PathwaysView talk={{outlinePath:'/review.md',title:'Review'}} {...state} thumbnails={{}}>{props=>{window.reviewGridHasAdd=typeof props.onAddToPathway==='function';return null}}</PathwaysView>);
  window.updateReviewProbe=patch=>{state={...state,...patch};render()};
  window.unmountReviewProbe=()=>probeRoot.unmount();render();
};
const talk={title:'Probe',slug:'probe',outlinePath:'/probe/outline.md'}
const slides=['a','b','c','d','e'].map((id,i)=>({slide_id:id,title:id,section:'Opening',role:'content',source_markdown:'### '+id,render_hash:id,content_hash:id,warnings:[],line:i+1}))
window.mountPlanner=()=>{
const a={title:'A',slug:'a',outlinePath:'/a.md'},b={title:'B',slug:'b',outlinePath:'/b.md'};
window.planWrites=[];window.tw.workFiles={list:async()=>null};window.tw.talk.readOutline=async path=>{if(path==='/b.md'){window.readBStarted=true;await new Promise(resolve=>window.releaseB=resolve)}return '# '+path};
window.tw.pathways.read=async path=>({slides:[{slide_id:path==='/a.md'?'a1':'b1',title:path==='/a.md'?'A slide':'B slide'}],pathways:[]});
window.tw.pathways.create=async(path,content,name)=>{window.planWrites.push({path,name});if(window.delayCreate)await new Promise(resolve=>window.releaseCreate=resolve);return {slides:[],pathways:[{id:'created',name,slideIds:[],present:[],missing:[]}]}};
window.tw.pathways.setSlideIds=async(path,content,id,ids)=>{window.planWrites.push({path,ids});return {slides:[],pathways:[]}};
window.tw.pathways.onChanged=()=>()=>{};
const root=createRoot(document.getElementById('root'));root.render(<PlanRunSheet talk={a} talks={[a,b]} onClose={()=>{}} onSaved={()=>{}}/>);return ()=>root.unmount();
};
let pathways=[{id:'short',name:'Short',slideIds:['c','a']}]
window.writes=[];window.outlineSteps=0
const snap=()=>({slides,pathways:pathways.map(p=>({...p,present:p.slideIds.filter(id=>slides.some(s=>s.slide_id===id)).map(id=>slides.find(s=>s.slide_id===id)),missing:p.slideIds.filter(id=>!slides.some(s=>s.slide_id===id))}))})
window.tw={pathways:{read:async()=>{if(window.deferRead){window.readStarted=true;await new Promise(resolve=>window.releaseRead=resolve)}return snap()},onChanged:()=>()=>{},present:async(...args)=>{window.presented=args;return {success:true}},setSlideIds:async(path,content,id,ids)=>{window.writes.push([...ids]);pathways=pathways.map(p=>p.id===id?{...p,slideIds:ids}:p);return snap()},create:async(path,content,name)=>{pathways.push({id:'new',name,slideIds:[]});return snap()},rename:async()=>snap(),delete:async()=>snap()},talk:{present:async(...args)=>{window.presented=args;return {success:true}},slidePictureText:async()=>[]},commands:{ran:()=>{}}}
const root=createRoot(document.getElementById('root'));window.unmount=()=>root.unmount();root.render(<PathwaysView talk={talk} content={'# Probe'} slides={slides} thumbnails={{}} docked={true}>{props=><GridView talk={talk} compiledSlides={slides} triggerFindings={[]} activeIndex={0} columns={2} onSelectSlide={()=>{}} slideRefOf={i=>({line:i+1,headingText:'### '+slides[i].title})} onMoveSlides={()=>{}} onStepSlide={()=>{window.outlineSteps++}} onCutSlides={async()=>true} onCopySlides={()=>''} {...props}/>}</PathwaysView>)
`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, jsx:'automatic', format:'iife', outfile:join(dir,'bundle.js'), logLevel:'silent' })
  browser = await chromium.launch({headless:true})
  const page = await browser.newPage({viewport:{width:1200,height:850}})
  page.on('pageerror', e => console.error('PAGE ERROR', e.message))
  page.setDefaultTimeout(10000)
  await page.setContent('<div id="root" style="height:800px"></div>')
  await page.addStyleTag({content:readFileSync('src/renderer/src/styles.css','utf8')})
  await page.addStyleTag({path:join(dir,'bundle.css')})
  await page.addScriptTag({path:join(dir,'bundle.js')})
  const check = async (label, fn) => { await fn(); checks++; console.log('PASS '+label) }
  await page.locator('[data-pathway-row="c"]').waitFor()
  const order=()=>page.locator('[data-pathway-row]').evaluateAll(es=>es.map(e=>e.dataset.pathwayRow))
  await check('locked layout places the numbered dock to the right of the talk grid',async()=>{const grid=await page.locator('.pathways-grid').boundingBox(),dock=await page.locator('[data-pathway-dock]').boundingBox();assert(dock.x>=grid.x+grid.width-1);assert(dock.width>=280)})
  await check('docked list follows manifest order', async()=>assert.deepEqual(await order(),['c','a']))
  await check('badges show pathway numbers only on members', async()=>{
    assert.deepEqual(await page.locator('[data-pathway-badge]').allTextContents(),['2','1'])
    assert.equal(await page.locator('.grid-cell[data-search-dim="true"]').count(),0)
  })
  await page.locator('[data-grid-tick]').nth(3).check()
  await page.locator('[data-grid-tick]').nth(1).check()
  await page.locator('[data-batch-action="add-to-pathway"]').click()
  await page.getByRole('button',{name:'Short (2 slides)',exact:true}).click()
  await page.waitForFunction(()=>window.writes.length===1)
  await check('batch adds selected in talk order in one write',async()=>assert.deepEqual(await order(),['c','a','b','d']))
  // The same DataTransfer crosses the real GridView and dock handlers.
  const drag=async(from,to)=>{
    const a=await from.elementHandle(), b=await to.elementHandle()
    await page.evaluate(([a,b])=>{window.dragTransfer=new DataTransfer();for(const [el,type] of [[a,'dragstart'],[b,'dragover']])el.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:window.dragTransfer}))},[a,b])
    await page.locator('[data-pathway-insertion-marker]').waitFor()
    await page.evaluate(([a,b])=>{for(const [el,type] of [[b,'drop'],[a,'dragend']])el.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:window.dragTransfer}))},[a,b])
  }
  await page.locator('[data-batch-action="clear"]').click()
  await drag(page.locator('.grid-cell').nth(4),page.locator('[data-pathway-row="a"]'))
  await page.locator('[data-pathway-row="e"]').waitFor()
  await check('grid drop inserts at the numbered list position',async()=>assert.deepEqual(await order(),['c','e','a','b','d']))
  await page.locator('[data-pathway-row="d"]').focus()
  await page.keyboard.press('Meta+ArrowUp')
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('[data-pathway-row]')).map(e=>e.dataset.pathwayRow).join(',')==='c,e,a,d,b')
  await check('command-up moves focused row immediately',async()=>assert.deepEqual(await order(),['c','e','a','d','b']))
  await drag(page.locator('[data-pathway-row="b"]'),page.locator('[data-pathway-row="c"]'))
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('[data-pathway-row]')).map(e=>e.dataset.pathwayRow).join(',')==='b,c,e,a,d')
  await check('list drag reorders with no Reorder mode',async()=>assert.deepEqual(await order(),['b','c','e','a','d']))
  await page.evaluate(()=>{const dt=new DataTransfer();dt.setData('application/x-tw-slides',JSON.stringify({outlinePath:'/another-talk.md',slideIds:['a']}));document.querySelector('[data-pathway-row="c"]').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}))})
  await check('cross-talk grid payload is refused without a write',async()=>assert.equal(await page.evaluate(()=>window.writes.length),4))
  await page.getByRole('button',{name:'Remove e from pathway'}).click()
  await page.locator('[data-pathway-row="e"]').waitFor({state:'detached'})
  await check('remove edits only the pathway',async()=>assert.deepEqual(await order(),['b','c','a','d']))
  await page.getByRole('button',{name:'Matrix',exact:true}).click()
  await check('matrix retains all pathway columns',async()=>assert.equal(await page.locator('[data-pathway-matrix] th').count(),2))
  await page.getByRole('button',{name:'Present this pathway',exact:true}).click()
  await check('present passes selected pathway id',async()=>assert.equal(await page.evaluate(()=>window.presented[2]),'short'))
  await check('pathway keyboard never calls the grid outline writer',async()=>assert.equal(await page.evaluate(()=>window.outlineSteps),0))
  await page.getByRole('button',{name:'List',exact:true}).click()
  await page.evaluate(()=>{window.deferRead=true;window.dispatchEvent(new Event('focus'))})
  await page.waitForFunction(()=>window.readStarted)
  await page.getByRole('button',{name:'Remove b from pathway'}).click()
  await page.getByRole('button',{name:'Remove d from pathway'}).click()
  await page.evaluate(()=>{window.unmount();window.releaseRead()})
  await page.waitForFunction(()=>window.writes.length===7)
  await check('queued edits finish in order after leaving the view',async()=>assert.deepEqual(await page.evaluate(()=>window.writes.at(-1)),['c','a']))
  await page.evaluate(()=>{window.plannerUnmount=window.mountPlanner()})
  await page.waitForFunction(()=>document.querySelector('[data-field="slide-set"] option[value="full"]')?.textContent.includes('1 slide'))
  await page.locator('[data-field="slide-set"]').selectOption('__new-pathway')
  const group=page.getByRole('group',{name:'New pathway',exact:true})
  await group.getByLabel('A slide',{exact:true}).check()
  await group.getByLabel('Name',{exact:true}).fill('A path')
  await page.locator('[data-field="talk"]').selectOption('b')
  await page.waitForFunction(()=>window.readBStarted)
  await check('talk switch closes the old creation form',async()=>assert.equal(await group.count(),0))
  await page.locator('[data-field="slide-set"]').selectOption('__new-pathway')
  await group.getByLabel('Name',{exact:true}).fill('B path')
  await check('cannot create from stale checklist while B loads',async()=>assert.equal(await group.getByRole('button',{name:'Create pathway',exact:true}).isDisabled(),true))
  await page.evaluate(()=>window.releaseB())
  await group.getByLabel('B slide',{exact:true}).waitFor()
  await check('new talk replaces checklist and clears prior selection',async()=>{
    assert.equal(await group.getByLabel('A slide',{exact:true}).count(),0)
    assert.equal(await group.locator('input[type=checkbox]:checked').count(),0)
    assert.equal(await page.evaluate(()=>window.planWrites.length),0)
  })
  await page.evaluate(()=>window.plannerUnmount())
  await page.evaluate(()=>{window.readBStarted=false;window.plannerUnmount=window.mountPlanner();window.delayCreate=true})
  await page.waitForFunction(()=>document.querySelector('[data-field="slide-set"] option[value="full"]')?.textContent.includes('1 slide'))
  await page.locator('[data-field="slide-set"]').selectOption('__new-pathway')
  await group.getByLabel('A slide',{exact:true}).check()
  await group.getByLabel('Name',{exact:true}).fill('Old A path')
  await group.getByRole('button',{name:'Create pathway',exact:true}).click()
  await page.waitForFunction(()=>window.releaseCreate)
  await group.getByRole('button',{name:'Create pathway',exact:true}).evaluate(button=>button.click())
  await page.waitForTimeout(30)
  await check('a second pending Create click does not submit another pathway',async()=>{
    assert.equal(await page.evaluate(()=>window.planWrites.filter(write=>write.name==='Old A path').length),1)
    assert.equal(await group.getByRole('button',{name:'Create pathway',exact:true}).isDisabled(),true)
    assert.equal(await group.getByLabel('Name',{exact:true}).isDisabled(),true)
    assert.equal(await group.getByLabel('A slide',{exact:true}).isDisabled(),true)
  })

  await page.locator('[data-field="talk"]').selectOption('b')
  await page.waitForFunction(()=>window.readBStarted)
  await page.evaluate(()=>window.releaseB())
  await page.waitForFunction(()=>document.querySelector('[data-field="slide-set"] option[value="full"]')?.textContent.includes('1 slide'))
  await page.evaluate(()=>window.releaseCreate())
  await page.waitForFunction(()=>window.planWrites.length===2)
  await check('accepted A creation completes on A after switching to B',async()=>assert.deepEqual(await page.evaluate(()=>window.planWrites[1]),{path:'/a.md',ids:['a1']}))
  await check('A completion never selects an A pathway in B draft',async()=>{
    assert.equal(await page.locator('[data-field="talk"]').inputValue(),'b')
    assert.equal(await page.locator('[data-field="slide-set"]').inputValue(),'full')
    assert.equal(await page.locator('[data-field="slide-set"]').getByText('Old A path').count(),0)
  })
  await page.evaluate(()=>window.plannerUnmount())
  const reviewFailures=[]
  const reviewCheck=async(label,fn)=>{try{await check(label,fn)}catch(error){reviewFailures.push(label+': '+error.message);console.error('FAIL '+label+': '+error.message)}}
  const mountReview=async(initial={})=>{
    await page.evaluate(initial=>window.mountReviewProbe(initial),initial)
    await page.waitForFunction(()=>window.reviewReads.length>0)
    await page.waitForTimeout(400)
  }
  await mountReview()
  await reviewCheck('plain Grid receives no pathway-only selection callback',async()=>assert.equal(await page.evaluate(()=>window.reviewGridHasAdd),false))
  await reviewCheck('plain Grid ignores the hidden dock present event',async()=>{
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tw-pathway-command',{detail:'present'})))
    await page.waitForTimeout(100)
    assert.equal(await page.evaluate(()=>window.reviewPresents.length),0)
  })
  await reviewCheck('plain Grid reads once and ignores typing and focus refreshes',async()=>{
    assert.equal(await page.evaluate(()=>window.reviewReads.length),1)
    for(const content of ['# Typed one','# Typed two','# Typed three']){
      await page.evaluate(content=>window.updateReviewProbe({content}),content)
      await page.waitForTimeout(30)
    }
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')))
    await page.waitForTimeout(500)
    assert.deepEqual(await page.evaluate(()=>window.reviewReads),['# Initial'])
  })
  await page.evaluate(()=>window.unmountReviewProbe())
  await mountReview({docked:true,slides:[{slide_id:'live',title:'live'}]})
  await reviewCheck('docked Pathways retains its add callback',async()=>assert.equal(await page.evaluate(()=>window.reviewGridHasAdd),true))
  await reviewCheck('stale renderer rows do not mark backend-resolved live members missing',async()=>{
    assert.match(await page.locator('[data-pathway-warning]').textContent(),/^1 slides no longer/)
  })
  await reviewCheck('Matrix uses snapshot membership when renderer previews lag behind',async()=>{
    await page.getByRole('button',{name:'Matrix',exact:true}).click()
    const later = page.locator('[data-pathway-matrix] tr').filter({hasText:'later'})
    assert.equal(await later.count(),1)
    assert.doesNotMatch(await later.textContent(),/missing/)
    assert.match(await page.locator('[data-pathway-matrix] tr').filter({hasText:'gone'}).textContent(),/missing/)
    await page.getByRole('button',{name:'List',exact:true}).click()
  })
  await reviewCheck('Drop missing preserves live members absent from stale renderer rows',async()=>{
    await page.getByRole('button',{name:'Drop missing',exact:true}).click()
    await page.waitForFunction(()=>window.reviewWrites.length===1)
    assert.deepEqual(await page.evaluate(()=>window.reviewWrites[0]),['live','later'])
  })
  await page.evaluate(()=>window.unmountReviewProbe())
  await mountReview()
  await reviewCheck('opening Pathways refreshes the latest buffer and typing is debounced',async()=>{
    await page.evaluate(()=>window.updateReviewProbe({docked:true,content:'# Open latest'}))
    await page.waitForFunction(()=>window.reviewReads.includes('# Open latest'))
    await page.waitForTimeout(400)
    const before=await page.evaluate(()=>window.reviewReads.length)
    for(const content of ['# Active one','# Active two','# Active final']){
      await page.evaluate(content=>window.updateReviewProbe({content}),content)
      await page.waitForTimeout(30)
    }
    assert.equal(await page.evaluate(()=>window.reviewReads.length),before)
    await page.waitForFunction(()=>window.reviewReads.at(-1)==='# Active final')
    await page.waitForTimeout(400)
    assert.equal(await page.evaluate(()=>window.reviewReads.length),before+1)
  })
  await page.evaluate(()=>window.unmountReviewProbe())
  assert.deepEqual(reviewFailures,[])
  console.log(checks+' docked pathway DOM checks passed')
} finally { await browser?.close(); rmSync(dir,{recursive:true,force:true}) }
