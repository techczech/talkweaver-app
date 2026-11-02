import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
mkdirSync(new URL('../research/', import.meta.url), { recursive: true })
const root=resolve(import.meta.dirname,'..'),dir=mkdtempSync(join(root,'research/.test-card-identity-'))
let browser
try {
  const plugins=process.env.TW_GRID_DECODE_LIFECYCLE_BASELINE ? [{name:'known-decode-lifecycle-defect',setup(b){b.onLoad({filter:/components[\\/]GridView\.tsx$/},args=>({contents:readFileSync(args.path,'utf8').replace('[identity, thumbnailUrl]) // eslint','[identity, thumbnailUrl, previewsPending]) // eslint'),loader:'tsx'}))}}] : []
  await build({plugins,stdin:{resolveDir:root,sourcefile:'grid-card-identity.tsx',loader:'tsx',contents:`
    import React from 'react'
    import {createRoot} from 'react-dom/client'
    import {flushSync} from 'react-dom'
    import GridView from './src/renderer/src/components/GridView.tsx'
    const rows=[{slide_id:'section0',role:'title',title:'Twin',section:'',render_hash:'opening',source_markdown:''}]
    for(let s=0;s<2;s++) {
      rows.push({slide_id:'section'+s,role:'section-title',title:'Section '+s,section:'section'+s,render_hash:'section'+s,source_markdown:'## Section '+s})
      for(let n=0;n<60;n++) {const id='s'+(s*60+n),t=[10,12].includes(n+s*60)?'Twin':id;rows.push({slide_id:id,role:'content',title:t,section:'section'+s,render_hash:t==='Twin'?'same-art':id,content_hash:'identical',source_markdown:'### '+t+'\\n{id='+id+'}'})}
    }
    rows.push({slide_id:'closing',role:'closing',title:'Twin',section:'',render_hash:'closing',source_markdown:''})
    const pictures=Object.fromEntries(rows.map(r=>[r.render_hash,'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="36"><rect width="64" height="36" fill="navy"/></svg>')]))
    window.pending=false;window.pictures=pictures
    window.tw={talk:{slidePictureText:async(_,r)=>r.map(()=>''),slidePictureGeneration:async()=>0}}
    const root=createRoot(document.getElementById('root'));let active='s10'
    window.paint=(order=rows)=>{window.rows=order;flushSync(()=>root.render(React.createElement(GridView,{talk:{outlinePath:'/synthetic/identity-outline.md',title:'Identity'},compiledSlides:order,triggerFindings:[],thumbnails:window.pictures,previewsPending:window.pending,activeIndex:order.findIndex(r=>r.slide_id===active),columns:4,onSelectSlide:i=>{active=order[i].slide_id;window.paint(order)},slideRefOf:i=>({line:i+1,headingText:order[i].source_markdown.split('\\n')[0]}),onMoveSlides:()=>{}})))}
    window.paint()
  `},bundle:true,format:'iife',platform:'browser',jsx:'automatic',outfile:join(dir,'bundle.js'),define:{'process.env.NODE_ENV':'"production"'},logLevel:'error'})
  browser=await chromium.launch({headless:true})
  const page=await browser.newPage({viewport:{width:1100,height:800}})
  const errors=[];page.on('pageerror',e=>errors.push(e.message))
  await page.setContent('<div id="root" style="height:650px;width:950px"></div>')
  await page.addStyleTag({content:readFileSync(join(root,'src/renderer/src/styles.css'),'utf8')})
  await page.addScriptTag({content:readFileSync(join(dir,'bundle.js'),'utf8')})
  await page.evaluate(()=>{for(const img of document.querySelectorAll('img'))img.loading='eager'})
  await page.waitForFunction(()=>[...document.querySelectorAll('.grid-cell img')].every(i=>i.complete&&i.naturalWidth))
  const capture=()=>page.evaluate(()=>{window.before=new Map([...document.querySelectorAll('.grid-cell')].map(c=>[window.rows[Number(c.dataset.slideIndex)].slide_id,{node:c,img:c.querySelector('img'),src:c.querySelector('img').src}]))})
  const verify=async (lost=[])=>{
    const result=await page.evaluate(()=>{const current=new Map([...document.querySelectorAll('.grid-cell')].map(c=>[window.rows[Number(c.dataset.slideIndex)].slide_id,c]));return [...window.before].map(([id,b])=>({id,same:current.get(id)===b.node,img:current.get(id)?.querySelector('img')===b.img,src:current.get(id)?.querySelector('img')?.src===b.src}))})
    assert.deepEqual(result.filter(r=>!r.same).map(r=>r.id),lost)
    for(const r of result.filter(r=>!lost.includes(r.id))){assert.ok(r.img,r.id+' keeps its image node');assert.ok(r.src,r.id+' keeps its own image')}
  }
  // A completed request must not cancel/restart decoding of the same replacement image.
  await capture()
  await page.evaluate(()=>{
    window.originalDecode=HTMLImageElement.prototype.decode
    window.releaseDecodes=[];window.decodeCalls=0
    const replacement='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="36"><rect width="64" height="36" fill="green"/></svg>')
    window.replacement=replacement
    HTMLImageElement.prototype.decode=function(){
      if(this.src!==replacement)return window.originalDecode.call(this)
      window.decodeCalls++
      return new Promise((resolve,reject)=>window.releaseDecodes.push(()=>window.originalDecode.call(this).then(resolve,reject)))
    }
    window.pending=true;window.pictures={...window.pictures,'same-art':replacement};window.paint(window.rows)
  })
  await page.waitForFunction(()=>window.decodeCalls===2)
  await page.evaluate(()=>{window.pending=false;window.paint(window.rows)})
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))
  assert.equal(await page.evaluate(()=>window.decodeCalls),2,'request completion cannot restart unchanged image decoding')
  await verify()
  await page.evaluate(()=>{for(const release of window.releaseDecodes)release()})
  await page.waitForFunction(()=>[...document.querySelectorAll('.grid-cell img')].filter(i=>i.src===window.replacement).length===2)
  await page.evaluate(()=>{HTMLImageElement.prototype.decode=window.originalDecode})
  await page.evaluate(()=>{
    const loadedFailure='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="36"><rect width="64" height="36" fill="red"/></svg>')
    window.loadedFailure=loadedFailure
    HTMLImageElement.prototype.decode=function(){return window.originalDecode.call(this).then(()=>{if(this.src===loadedFailure)throw new Error('synthetic decode queue rejection after load')})}
    window.pictures={...window.pictures,s13:loadedFailure};window.paint(window.rows)
  })
  await page.waitForFunction(()=>[...document.querySelectorAll('.grid-cell img')].some(i=>i.src===window.loadedFailure))
  await page.evaluate(()=>{HTMLImageElement.prototype.decode=window.originalDecode})
  await capture()
  await page.evaluate(()=>{const a=[...window.rows],i=a.findIndex(r=>r.slide_id==='s10'),[r]=a.splice(i,1);a.splice(a.findIndex(r=>r.slide_id==='s20')+1,0,r);window.paint(a.map(r=>({...r})))})
  await verify()
  // The two Twin cards have identical text/content/pictures but different source ids.
  await page.locator('[data-grid-search]').fill('Twin')
  await capture()
  await page.evaluate(()=>{const a=[...window.rows],i=a.findIndex(r=>r.slide_id==='s12'),[r]=a.splice(i,1);a.splice(a.findIndex(r=>r.slide_id==='s10')+1,0,r);window.paint(a)})
  await verify()
  await page.locator('[data-grid-search]').fill('')
  await capture()
  await page.evaluate(()=>{const a=[...window.rows],i=a.findIndex(r=>r.slide_id==='s12'),[r]=a.splice(i,1);r.section='section1';a.splice(a.findIndex(r=>r.slide_id==='s80')+1,0,r);window.paint(a)})
  await verify(['s12'])
  await page.locator('[data-section-header]').filter({hasText:'Section 0'}).click()
  await capture()
  await page.evaluate(()=>{const a=window.rows,first=a.filter(r=>r.section==='section0'),second=a.filter(r=>r.section==='section1');window.paint([a[0],...second,...first,a.at(-1)])})
  await verify()
  assert.equal(await page.locator('.grid-cell').count(),64,'collapsed section stays collapsed after section reorder')
  assert.deepEqual(errors,[])
  console.log('PASS 124-card DOM identity: duplicate titles/content/artwork, generated endpoints, search, cross-parent move and collapsed section reorder')
} finally {try{await browser?.close()}finally{rmSync(dir,{recursive:true,force:true})}}
