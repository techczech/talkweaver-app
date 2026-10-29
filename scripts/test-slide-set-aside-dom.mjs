import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
const root = resolve(import.meta.dirname, '..'), temp = mkdtempSync(join(tmpdir(), 'tw-aside-dom-'))
let browser, checks = 0
const original = '# Talk\n\n## Section {id=sec01}\n\n### A {id=aaaaa}\n\nBody A\n\n### B {id=bbbbb}\n\nBody B\n\n## End {id=end01}\n\n### C {id=ccccc}\n\nBody C\n'
try {
 await build({ stdin: { sourcefile: 'set-aside-test.tsx', loader: 'tsx', resolveDir: root, contents: `
import React from 'react'; import {createRoot} from 'react-dom/client'
import {EditorView} from '@codemirror/view'; import {EditorState} from '@codemirror/state'
import {history,undo,isolateHistory} from '@codemirror/commands'
import GridView from './src/renderer/src/components/GridView.tsx'
import ScratchpadPanel from './src/renderer/src/components/scratchpad/ScratchpadPanel.tsx'
import {useScratchpadLayout} from './src/renderer/src/lib/useScratchpadLayout.ts'
import {runSetAside} from './src/renderer/src/lib/slideSetAside.ts'
import {runScratchInsert} from './src/renderer/src/lib/scratchpadInsert.ts'
import {scratchDropExtension} from './src/renderer/src/extensions/scratchDrop.ts'
import {placeRows} from './src/shared/slide-handling/place.ts'
import {publishOutline} from './src/renderer/src/lib/outlineCollapseStore.ts'
import './src/renderer/src/styles.css'
const path='/v/t/t-outline.md', original=${JSON.stringify(original)}
let update=()=>{}, snap={groups:[],items:[],notices:[]}
window.tw={talk:{},scratchpad:{}}
const view=new EditorView({parent:document.getElementById('editor'),state:EditorState.create({doc:original,extensions:[history(),scratchDropExtension((id,place)=>drop(id,place)),EditorView.updateListener.of(u=>{if(u.docChanged)update(u.state.doc.toString())})]})})
window.replaceDoc=text=>view.dispatch({changes:{from:0,to:view.state.doc.length,insert:text},annotations:isolateHistory.of('full')}); window.text=()=>view.state.doc.toString(); window.undo=()=>undo(view)
const apply=async(p,mutate,opts={})=>{const before=window.text();if(opts.base!==undefined&&opts.base!==before)return {ok:false,error:'changed',applied:false};const next=await mutate(before);view.dispatch({changes:{from:0,to:before.length,insert:next},annotations:isolateHistory.of('full')});return {ok:true}}
const source={talkPath:'t/t-outline.md',talkTitle:'Talk',thumbKey:''}
let refresh=()=>{}
const asideHost={outlinePath:path,settled:async()=>{},read:()=>({path,text:window.text()}),copy:async inputs=>{snap={groups:[{id:'aside',name:'Set aside · 2026-10-28'}],items:inputs.map((slide,i)=>({id:'sp'+i,kind:'slide',status:'active',group:'aside',addedAt:'2026-10-28T10:00:00Z',batch:{source:'slide-browser',at:'2026-10-28T10:00:00Z'},slide,title:slide.title,missing:false,description:'',sources:[]})),notices:[]};refresh();return {ok:true}},apply,notify:()=>{}}
const insertHost={talk:()=>path,editor:()=>({path,text:window.text(),caret:0}),apply,prepareSlide:async s=>s,api:{slideSource:async()=>({ok:true,outlinePath:path}),markInserted:async()=>({ok:true,snapshot:snap})},notify:()=>{}}
async function drop(id,place){window.lastDrop=place;await runScratchInsert(insertHost,{mode:'slide',item:snap.items.find(i=>i.id===id),place})}
function App(){const[text,setText]=React.useState(original),[active,setActive]=React.useState(1),[n,setN]=React.useState(0);update=setText;refresh=()=>setN(x=>x+1);const layoutApi=useScratchpadLayout();React.useEffect(()=>layoutApi.dock(),[])
 const rows=placeRows(text);publishOutline(path,text)
 const cards=rows.map((r,i)=>({slide_id:(text.split('\\n')[r.line-1].match(/id=([^}]+)/)||[])[1],title:r.title,nav_title:r.title,role:r.level===2?'section-title':'content',section:r.level===2?r.title:'Section',source_markdown:text.split('\\n')[r.line-1],render_hash:''+i,content_hash:''+i,layout:'default',warnings:[],line:r.line}))
 const ref=i=>({line:rows[i].line,headingText:text.split('\\n')[rows[i].line-1]})
 return <><div style={{width:750,height:650}}><GridView talk={{slug:'t',outlinePath:path,title:'Talk'}} compiledSlides={cards} triggerFindings={[]} thumbnails={null} activeIndex={active} onSelectSlide={setActive} slideRefOf={ref} lineOfSlide={i=>rows[i]?.line} onMoveSlides={()=>{}} onCutSlides={async()=>true} onCopySlides={()=>''} onSetAsideSlides={refs=>runSetAside(asideHost,refs,source)} onScratchDrop={drop} slideOps={{cut:()=>null,copy:()=>null,delete:()=>{},paste:()=>null,moveTo:()=>null}}/></div>
 <ScratchpadPanel data={{snapshot:snap,loading:false,activeCount:snap.items.length}} layoutApi={layoutApi} registerActions={()=>{}} onOpenSlideBrowser={()=>{}} outlineText={text}/></>}
createRoot(document.getElementById('root')).render(<App/>);
` }, bundle:true, platform:'browser', format:'iife', jsx:'automatic', outfile:join(temp,'test.js'), loader:{'.css':'css'}, logLevel:'error' })
 writeFileSync(join(temp,'test.html'),'<link rel="stylesheet" href="test.css"><div id="root" style="display:flex"></div><div id="editor"></div><script src="test.js"></script>')
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1400,height:1100}})
 const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(pathToFileURL(join(temp,'test.html')).href)
 await page.locator('.grid-cell').first().waitFor()
 await page.getByLabel('Select A',{exact:true}).check();await page.getByLabel('Select B',{exact:true}).check()
 await page.getByRole('button',{name:'Set aside in Scratchpad',exact:true}).click()
 await page.locator('.sp-card').first().waitFor();assert.equal(await page.locator('.sp-card').count(),2);assert(!await page.evaluate(()=>window.text().includes('Body A')));checks++
 await page.evaluate(()=>window.undo());await page.waitForFunction(()=>window.text().includes('Body A'))
 assert.equal(await page.evaluate(()=>window.text()),original);assert.equal(await page.getByText('In talk',{exact:true}).count(),2);checks++
 await page.locator('.sp-card').first().dblclick();assert.equal(await page.getByText('In talk',{exact:true}).count(),1);await page.getByRole('button',{name:'← Back to the list'}).click();checks++
 await page.locator('.sp-panel').getByLabel('Select A',{exact:true}).check();await page.locator('.sp-panel').getByLabel('Select B',{exact:true}).check()
 await page.getByRole('button',{name:'Compare side by side',exact:true}).click();assert.equal(await page.getByText('In talk',{exact:true}).count(),2)
 await page.getByRole('button',{name:'← Back to the list'}).click();await page.getByRole('button',{name:'Clear selection',exact:true}).click();checks++
 // Removing again through Undo's redo is unnecessary: a copy already in the talk gets a fresh id on drop.
 const from=await page.locator('.sp-card').first().elementHandle(), to=await page.locator('.grid-cell[data-slide-index="4"]').elementHandle()
 await page.evaluate(([s,d])=>{const dt=new DataTransfer();s.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dt}));d.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));},[from,to])
 await page.evaluate(()=>new Promise(requestAnimationFrame))
 assert.equal(await page.locator('[data-drop-target="true"]').count(),1);checks++
 await page.evaluate(([s,d])=>{const dt=new DataTransfer();s.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dt}));d.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));s.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:dt}));},[from,to])
 await page.waitForFunction(()=>window.lastDrop!=null);await page.waitForFunction(()=>window.text().split('Body A').length===3)
 assert.equal(await page.evaluate(()=>window.lastDrop.kind),'before');assert.equal((await page.evaluate(()=>window.text())).match(/id=aaaaa/g).length,1);checks++
 await page.evaluate(()=>window.undo());assert.equal(await page.evaluate(()=>window.text()),original);checks++
 // The actual CodeMirror drop handler uses the same SlidePlace insertion seam.
 await page.locator('.cm-content').scrollIntoViewIfNeeded();const line=page.locator('.cm-line').filter({hasText:'### C'});const box=await line.boundingBox()
 await page.evaluate(([s,x,y])=>{const dt=new DataTransfer();s.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dt}));const el=document.elementFromPoint(x,y);for(const type of ['dragover','drop'])el.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:dt,clientX:x,clientY:y}));},[from,box.x+20,box.y+5])
 await page.waitForFunction(()=>window.text().split('Body A').length===3);await page.evaluate(()=>window.undo());assert.equal(await page.evaluate(()=>window.text()),original);checks++
 // Header/end-zone markers also apply to external Scratchpad drags.
 const end=await page.locator('[data-grid-drop-end]').elementHandle()
 await page.evaluate(([s,d])=>{const dt=new DataTransfer();s.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));d.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));},[from,end])
 assert.equal(await page.locator('[data-grid-drop-end]').getAttribute('data-drop-active'),'true');checks++
 await page.evaluate(()=>window.replaceDoc('# Talk\n'))
 await page.waitForFunction(()=>document.querySelectorAll('.grid-cell').length===0)
 const empty=await page.locator('.grid-view').elementHandle()
 await page.evaluate(([s,d])=>{const dt=new DataTransfer();s.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));for(const type of ['dragover','drop'])d.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:dt}));},[from,empty])
 await page.waitForFunction(()=>window.text().includes('Body A'));assert.equal(await page.evaluate(()=>window.lastDrop.kind),'start');checks++
 await page.evaluate(text=>window.replaceDoc(text),original);await page.locator('.grid-cell[data-slide-index="2"]').waitFor()
 await page.locator('.grid-cell[data-slide-index="2"]').click({button:'right'})
 await page.locator('[data-slide-row-action="set-aside"]').click()
 await page.waitForFunction(()=>!window.text().includes('Body B'));assert(await page.evaluate(()=>window.text().includes('Body A')))
 await page.evaluate(()=>window.undo());assert.equal(await page.evaluate(()=>window.text()),original);checks++
 assert.deepEqual(errors,[]);console.log(checks+' set-aside DOM checks passed')
}finally{await browser?.close();rmSync(temp,{recursive:true,force:true})}
