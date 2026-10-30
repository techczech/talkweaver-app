import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
import { chromium } from 'playwright'
const root = resolve(import.meta.dirname, '..'), scratch = mkdtempSync(join(tmpdir(), 'tw-research-dom-'))
const shotAt=process.argv.indexOf('--screenshots'), shots=shotAt>=0?resolve(process.argv[shotAt+1]):null
let browser
try {
  await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import ResearchPanel from './src/renderer/src/components/ResearchPanel.tsx';
import {EditorView} from '@codemirror/view'; import {EditorState} from '@codemirror/state';
import {researchDropHandlers,researchInsertionMarker} from './src/renderer/src/extensions/researchDrop.ts';
import {insertResearchItem as realInsert} from './src/renderer/src/lib/research-insert.ts';
import {history,undo,isolateHistory} from '@codemirror/commands';
import {insertSlideAfterCaret} from './src/shared/old-slide.ts';
import {insertAtCaretLine} from './src/renderer/src/extensions/headingEndInsert.ts';
import {createOutlineMutator} from './src/renderer/src/lib/outlineMutation.ts';
let editor;const path='/vault/talk/talk-outline.md';
const writer=createOutlineMutator({bufferFor:()=>editor?{read:()=>editor.state.doc.toString(),apply:(_path,text)=>{editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:text}});return text},adopt:()=>{},insertAtCaret:(_path,text)=>{insertAtCaretLine(editor,text);return true}}:null,settled:async()=>{},write:async(_path,text)=>{window.saved=text;return {ok:true,content:text}}});
const talk={path:'/vault/alias-talk',outlinePath:path}; let currentTalk=talk;
const host={activeTalk:()=>currentTalk,readItem:async input=>{window.reads=(window.reads||0)+1;if(window.switchDuringRead)currentTalk={path:'/vault/other',outlinePath:'/vault/other/other-outline.md'};if(window.editDuringRead){editor.dispatch({changes:{from:editor.state.doc.length,insert:'Unsaved edit\\n'},annotations:isolateHistory.of('full')});window.editDuringRead=false};return window.tw.research.list(input)},editor:()=>({path:window.wrongEditor?'/vault/other':path,text:editor.state.doc.toString(),caret:editor.state.selection.main.head}),mutator:writer};
async function insert(entry,slide){window.calls.push(slide?'slide':'insert');return realInsert(entry.file,slide,host)}
window.testInsert=async(file,slide)=>{currentTalk=window.noTalk?null:talk;return realInsert(file,slide,host)};
window.undo=()=>{undo(editor);return editor.state.doc.toString()};window.doc=()=>editor.state.doc.toString();

function Outline(){const ref=React.useRef(null);React.useEffect(()=>{editor=new EditorView({parent:ref.current,state:EditorState.create({doc:'# Talk\\n\\n## First\\n\\nWriting here\\n\\n## Last\\n\\nKeep this text\\n',extensions:[history(),researchInsertionMarker,EditorView.domEventHandlers(researchDropHandlers(file=>{window.calls.push('drop:'+file);void insert(item,false)}))]})});editor.dispatch({selection:{anchor:editor.state.doc.toString().indexOf('Writing')}});return()=>editor.destroy()},[]);return <div className='outline-fixture' ref={ref}/>;}
const item={inCurrentTalk:true,file:'/vault/talk/research/counts.md',project:'/vault/talk',projectTitle:'Current talk',title:'Teachers’ weekly AI use',kind:'table',created:'2026-10-20',by:'agent',prompt:'How often?',sources:['url:https://example.org/report','scout:highlights:readings/hebb.md:12','file:/private/report.pdf'],body:'| Phase | Weekly |\\n| --- | --- |\\n| Primary | 28% |\\n\\n<script>window.hacked=true</script>',preview:'Weekly use',artefacts:[{file:'/vault/talk/research/widget.html',name:'widget.html',type:'html',data:'<script>parent.hacked=true</script><p>Preview</p>'}]};
Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copied=text}},configurable:true});
const second={...item,file:'/vault/talk/research/voice.md',title:'Student voice',kind:'evidence',body:'> Students use it to check their work.',artefacts:[]};
window.calls=[];window.usageCalls=[];window.inflight=new Map();window.maxUsage=0;window.cancelled=0; window.empty=false; window.tw={research:{destinations:async()=>[{path:'/vault/other',title:'Other talk'}],write:async(op,input)=>{window.calls.push(input.preview?'preview:'+op:'write:'+op);return {ok:true,file:'/vault/talk/research/copied.md',confirmation:'confirmed',uncheckedOutlines:['/vault/other/linked-outline.md'],uses:[{file:'/vault/talk/talk-outline.md',slideLine:3,slideNumber:1,slideTitle:'First'},{file:'/vault/other/other-outline.md',slideLine:8,slideNumber:2,slideTitle:'Second'}]}},cancelUsage:id=>{if(id.startsWith('search-'))window.searchCancelled=(window.searchCancelled||0)+1;const done=window.inflight.get(id);if(done){window.cancelled++;done()}},revealSource:async file=>{window.calls.push(file);return {ok:true}},list:async input=>input.file==='/vault/other/research/item.md'?{ok:true,items:[{...item,file:input.file,project:'/vault/other',projectTitle:'Other talk',title:'Other project',inCurrentTalk:true}],skipped:0,limited:false}:input.file&&!input.file.startsWith('/vault/talk/research/')?{ok:false,error:{message:'Outside active talk'}}:({ok:true,items:window.empty?[]:input.file?[input.file===second.file?second:{...item,body:window.freshBody||item.body}]:window.many?Array.from({length:50},(_,i)=>({...item,file:'/vault/talk/research/row-'+i+'.md',title:'Item '+i})):[item,second],skipped:0,limited:false}),search:async input=>{window.calls.push(input.scope);return {ok:true,items:window.empty?[]:input.scope==='talk'?[item,second]:[{...item,inCurrentTalk:false,file:'/vault/other/research/item.md',project:'/vault/other',projectTitle:'Other talk',title:'Other project'}],skipped:0,limited:false}},whereUsed:async input=>new Promise(resolve=>{window.usageCalls.push(input.file);const done=()=>{clearTimeout(timer);window.inflight.delete(input.requestId);resolve({ok:true,uses:window.noUses?[]:[{file:'/vault/talk/talk-outline.md',line:5,slideLine:3,slideNumber:7,slideTitle:'Who is using it',text:'reference'}],skipped:0})};const timer=setTimeout(done,window.slowUsage?2000:40);window.inflight.set(input.requestId,done);window.maxUsage=Math.max(window.maxUsage,window.inflight.size)})},shell:{openExternal:async url=>window.calls.push(url),showInFolder:async path=>window.calls.push(path)}};
function App(){const [picker,P]=React.useState(false),[panel,S]=React.useState(true),[refresh,R]=React.useState(0);const actions=React.useRef({});window.refresh=()=>R(x=>x+1);return <><Outline/><button onClick={()=>P(true)}>Picker</button><ResearchPanel talkDir='/vault/talk' panelOpen={panel} pickerOpen={picker} refresh={refresh} registerActions={a=>actions.current=a} onCommand={id=>actions.current[id]?.()} onClosePanel={()=>S(false)} onClosePicker={()=>P(false)} onOpenPanel={()=>{S(true);P(false)}} onCapture={()=>window.calls.push('capture')} onRevealFolder={()=>window.calls.push('folder')} onInsert={insert} onJump={use=>window.calls.push(use.slideTitle)}/></>};createRoot(document.getElementById('root')).render(<App/>);`, sourcefile: 'research-dom.tsx', loader: 'tsx', resolveDir: root }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(scratch, 'test.js'), logLevel: 'silent' })
  writeFileSync(join(scratch, 'test.html'), '<!doctype html><meta charset="utf-8"><style>:root{--panel:#fffdf8;--paper:#f7f3ea;--line:#d9d0c1;--ink:#17202a;--muted:#5d6875;--faint:#8a9099;--oxford:#0b3a6b;--green:#166534;--amber:#92600a;--hover:#ede8dc;--font-ui:system-ui;--font-serif:Georgia;--font-mono:monospace}body{margin:0;background:var(--paper)}#root{height:100vh;display:flex;align-items:stretch}.outline-fixture{flex:1;padding:25px}.research-panel{height:100vh}</style><link rel="stylesheet" href="test.css"><div id="root"></div><script src="test.js"></script>')
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1200, height: 850 } })
  page.setDefaultTimeout(8000)
  page.on('pageerror', error => console.error('Research fixture:', error.message))
  await page.goto(pathToFileURL(join(scratch, 'test.html')).href)
  await page.getByRole('option', { name: /Teachers’ weekly AI use/ }).click()
  assert.equal(await page.locator('.research-detail table').count(), 1)
  assert.doesNotMatch(await page.locator('.research-sources').innerText(), /scout:/)
  assert.match(await page.locator('.research-sources').innerText(), /hebb.md.*line 12/)
  assert.equal(await page.evaluate(() => window.hacked), undefined)
  assert.equal(await page.locator('.research-detail iframe').getAttribute('sandbox'), '')
  await page.waitForFunction(()=>window.usageCalls.length===2 && window.inflight.size===0)
  const firstUsageCount = await page.evaluate(()=>window.usageCalls.length)
  await page.locator('.research-panel input').fill('use')
  await page.waitForTimeout(400)
  assert.equal(await page.evaluate(()=>window.usageCalls.length), firstUsageCount, 'query/list changes reuse the per-file session cache')
  await page.locator('.research-panel input').fill('')
  if(shots)await page.screenshot({path:join(shots,'research-panel.png')})
  await page.getByRole('button', { name: 'Insert', exact: true }).click()
  await page.getByRole('button', { name: 'Make slide', exact: true }).click()
  await page.getByRole('button', { name: 'Slide 7 “Who is using it”', exact: true }).click()
  await page.getByRole('button', { name: 'https://example.org/report', exact: true }).click()
  assert.deepEqual((await page.evaluate(()=>window.calls)).slice(-4), ['insert','slide','Who is using it','https://example.org/report'])
  await page.getByRole('button', { name: 'Copy reference', exact: true }).click()
  assert.match(await page.evaluate(()=>window.copied), /\[Research: Teachers’ weekly AI use\]\(research\/counts.md\)/)
  const saved = await page.evaluate(() => window.saved)
  assert.match(saved, /Source: https:\/\/example.org\/report/)
  assert.match(saved, /\[Research: Teachers’ weekly AI use\]\(research\/counts.md\)/)
  assert.match(saved, /\[Embed: research\/widget.html\]/)
  assert.match(saved, /Keep this text/)
  await page.getByRole('option', { name: /Teachers’ weekly AI use/ }).dragTo(page.locator('.cm-content'))
  await page.waitForFunction(() => window.calls.includes('drop:/vault/talk/research/counts.md'))
  await page.getByRole('button', { name: 'All research', exact: true }).click()
  await page.getByText('Other talk', { exact: true }).first().waitFor()
  assert.equal(await page.getByRole('button', { name: 'Insert here', exact: true }).isDisabled(), false)
  await page.getByRole('button', { name: 'Insert here', exact: true }).click()
  await page.waitForFunction(()=>window.calls.includes('write:insertHere'))
  await page.getByRole('button', { name: 'Reveal talk', exact: true }).click()
  await page.waitForFunction(() => window.calls.includes('/vault/other'))
  await page.getByText('1 results in other talks', {exact:true}).waitFor()
  await page.getByRole('button', { name: 'Open', exact: true }).click()
  await page.getByText('Open research · Read-only preview', {exact:true}).waitFor()
  assert.equal(await page.locator('.research-list').isVisible(), false)
  await page.getByRole('button', {name:'Back to results'}).click()
  assert.equal(await page.locator('.research-list').isVisible(), true)
  await page.getByRole('button', { name: 'Everything', exact: true }).click()
  await page.waitForFunction(() => window.calls.includes('everything'))
  await page.getByText('Everything: not in the scope now', {exact:true}).waitFor()
  await page.getByRole('button', { name: 'Picker', exact: true }).click()
  await page.locator('.research-picker input').fill('use')
  await page.keyboard.press('Alt+Tab')
  await page.getByRole('option', { name: /Teachers’ weekly AI use/ }).last().waitFor()
  await page.getByText('1 of 2 items', {exact:true}).waitFor()
  await page.keyboard.press('ArrowDown')
  await page.locator('.research-detail h3').filter({hasText:'Student voice'}).waitFor()
  await page.keyboard.press('ArrowUp')
  await page.locator('.research-detail h3').filter({hasText:'Teachers’ weekly AI use'}).waitFor()
  await page.keyboard.press('Enter')
  assert.equal((await page.evaluate(()=>window.calls)).at(-1), 'insert')
  await page.getByRole('button', { name: 'Picker', exact: true }).click()
  if(shots)await page.screenshot({path:join(shots,'research-picker.png')})
  await page.keyboard.press('Alt+Enter')
  assert.equal((await page.evaluate(()=>window.calls)).at(-1), 'slide')
  await page.getByRole('button', { name: 'Picker', exact: true }).click()
  await page.keyboard.press('Meta+Enter')
  assert.equal(await page.locator('.research-picker').count(), 0)
  await page.getByRole('button', { name: 'Picker', exact: true }).click()
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.research-picker').count(), 0)
  await page.getByRole('button', {name:'Back to results'}).click()
  // Docked list owns arrows/Return; the editor and panel search field retain their keys.
  await page.getByRole('button', {name:'This talk',exact:true}).click()
  await page.getByRole('option', {name:/Teachers’ weekly AI use/}).click()
  await page.keyboard.press('ArrowDown')
  await page.locator('.research-detail h3').filter({hasText:'Student voice'}).waitFor()
  await page.keyboard.press('Enter')
  assert.equal((await page.evaluate(()=>window.calls)).at(-1), 'insert')
  await page.locator('.research-panel input').fill('')
  await page.locator('.research-panel input').press('Enter')
  assert.equal((await page.evaluate(()=>window.calls)).at(-1), 'insert')
  await page.getByRole('option').first().focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Tab')
  assert.equal(await page.locator('.research-detail button').first().evaluate(el=>el===document.activeElement), true, await page.evaluate(()=>document.activeElement.outerHTML))
  for (const [label,op] of [['Rename…','rename'],['Change kind…','kind'],['Move to another talk…','move'],['Copy to another talk…','copy'],['Delete…','delete']]) {
    await page.getByRole('button',{name:'Tidy research',exact:true}).click()
    await page.getByRole('button',{name:label,exact:true}).click()
    const dialog=page.getByRole('dialog')
    assert.equal(await dialog.getByRole('button',{name:'Cancel',exact:true}).evaluate(el=>el===document.activeElement),true,'Cancel is the default')
    if(op==='rename'){await dialog.getByLabel('Title',{exact:true}).fill('New title');await dialog.getByLabel('Rename the file slug too').check()}
    if(op==='kind')await dialog.getByLabel('Kind',{exact:true}).selectOption('snippet')
    if(op==='move'||op==='copy')await dialog.getByLabel('Destination talk').selectOption('/vault/other')
    await dialog.getByRole('button',{name:'Review changes'}).click()
    await dialog.getByText('Used in 2 slides:',{exact:true}).waitFor()
    await dialog.getByText('Slide 1 “First”',{exact:true}).waitFor()
    await dialog.getByText(/^Slide 2 “Second” in (?:Other talk|other)$/).waitFor()
    if(op==='move'||op==='rename') {
      await dialog.getByText('These slides in other talks will have broken links.',{exact:true}).waitFor()
      assert.doesNotMatch(await dialog.innerText(),/pointing at the original/)
    }
    await dialog.getByText('Could not check these outlines. Their slides may have broken links:',{exact:true}).waitFor()
    await dialog.getByText('/vault/other/linked-outline.md',{exact:true}).waitFor()
    assert.equal(await dialog.getByRole('button',{name:'Cancel',exact:true}).evaluate(el=>el===document.activeElement),true,'review keeps Cancel as default')
    if(op==='delete'){
      const count=await page.evaluate(()=>window.calls.filter(x=>x==='write:delete').length)
      await page.keyboard.press('Enter')
      assert.equal(await page.evaluate(()=>window.calls.filter(x=>x==='write:delete').length),count,'Return defaults to Cancel')
      continue
    }
    await dialog.getByRole('button',{name:'Confirm',exact:true}).click()
    await page.waitForFunction(op=>window.calls.includes('write:'+op),op)
    await page.getByRole('dialog').waitFor({state:'detached'})
  }
  assert.ok(await page.evaluate(()=>window.searchCancelled>0),'superseded search sends cancellation')
  // The extracted WorkspaceLayout path re-reads content, checks the project and keeps unsaved text and undo.
  assert.equal(await page.evaluate(()=>{window.noTalk=true;return window.testInsert('/vault/talk/research/counts.md',false)}), false)
  await page.evaluate(()=>{window.noTalk=false})
  assert.equal(await page.evaluate(()=>window.testInsert('/vault/other/research/counts.md',false).catch(()=>false)), false)
  assert.equal(await page.evaluate(()=>{window.switchDuringRead=true;return window.testInsert('/vault/talk/research/counts.md',false)}), false)
  await page.evaluate(()=>{window.switchDuringRead=false;window.wrongEditor=true})
  assert.equal(await page.evaluate(()=>window.testInsert('/vault/talk/research/counts.md',false)), false)
  await page.evaluate(()=>{window.wrongEditor=false;window.editDuringRead=true;window.freshBody='Fresh from disk'})
  assert.equal(await page.evaluate(()=>window.testInsert('/vault/talk/research/counts.md',false)), true)
  assert.match(await page.evaluate(()=>window.doc()), /Fresh from disk/)
  const undone=await page.evaluate(()=>window.undo())
  assert.match(undone,/Unsaved edit/);assert.doesNotMatch(undone,/Fresh from disk/)
  await page.evaluate(()=>{window.editDuringRead=true;window.freshBody='# Research heading'})
  assert.equal(await page.evaluate(()=>window.testInsert('/vault/talk/research/counts.md',true)), true)
  assert.match(await page.evaluate(()=>window.doc()), /Unsaved edit/)
  // Large lists only check selected/visible rows, with a session cache and superseded calls cancelled.
  await page.evaluate(()=>{window.many=true;window.slowUsage=true;window.refresh()})
  await page.getByRole('option',{name:/Item 0/}).waitFor()
  await page.waitForFunction(()=>window.inflight.size>0)
  await page.locator('.research-panel input').fill('different')
  await page.waitForFunction(()=>window.cancelled>0)
  assert.ok(await page.evaluate(()=>window.maxUsage<=2), 'at most two usage calls')
  assert.ok(await page.evaluate(()=>window.usageCalls.filter(f=>f.includes('row-')).length<50), 'offscreen rows never spawn Scout')
  await page.evaluate(()=>{window.many=false;window.slowUsage=false;window.noUses=true;window.refresh()})
  await page.locator('.research-panel input').fill('')

  await page.locator('.research-uses b').filter({hasText:'Not used yet'}).waitFor()
  await page.evaluate(()=>{window.empty=true;window.refresh()})
  await page.getByText('Nothing collected for this talk yet').waitFor()
  await page.getByRole('button',{name:'All research',exact:true}).click()
  await page.getByText('No results in All research',{exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'Capture to research',exact:true}).count(),0)
  await page.getByRole('button',{name:'Everything',exact:true}).click()
  await page.getByText('No results in Everything',{exact:true}).waitFor()
  await page.getByRole('button',{name:'This talk',exact:true}).click()
  await page.locator('.research-panel input').fill('absent')
  await page.getByText('No results in This talk',{exact:true}).waitFor()
  await page.locator('.research-panel input').fill('')
  await page.getByText('Nothing collected for this talk yet').waitFor()
  await page.getByRole('button', { name: 'Capture to research', exact: true }).click()
  assert.equal((await page.evaluate(()=>window.calls)).at(-1), 'capture')
  console.log('Research panel headless: table, inert widget, provenance, use links, insert, slide, scopes, cross-project read-only, picker keys and empty state pass')
} finally { await browser?.close(); rmSync(scratch, { recursive: true, force: true }) }
