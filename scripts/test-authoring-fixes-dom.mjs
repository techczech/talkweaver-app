import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'

const root = resolve(import.meta.dirname, '..')
mkdirSync(new URL('../research/', import.meta.url), { recursive: true })
const scratch = mkdtempSync(join(root, 'research/.tmp-authoring-dom-'))
const shots = process.env.SHOTS ? resolve(process.env.SHOTS) : null
if (shots) mkdirSync(shots, { recursive: true })
let browser
try {
  await build({ stdin: { contents: `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import Editor from './src/renderer/src/components/Editor.tsx';
import SlideContextMenu from './src/renderer/src/components/SlideContextMenu.tsx';
import ExplainPanel from './src/renderer/src/components/ExplainPanel.tsx';
import {EditorView} from '@codemirror/view';
const initial='### Fixture\\n{id=fixture}\\n\\n';
window.tw={talk:{readOutline:async()=>initial,writeOutline:async(_p,text)=>({ok:true,content:text}),outlineRecovery:async()=>null,explainSlide:async()=>({navTitle:'Fixture',layout:window.explainLayout||'chat',titleLayout:'top',role:'content',mode:'',split:'',triggers:['{chat}'],wordCount:0,bulletCount:0,imageCount:0,warnings:[]})},vault:{onTalkMetaUpdated:()=>()=>{}},workFiles:{list:async()=>null}};
window.readEditor=()=>EditorView.findFromDOM(document.querySelector('.cm-editor'));
let insert;
function App(){const [menu,setMenu]=useState(null);const [explain,setExplain]=useState(false);return <><button id="outside">Outside</button><button id="explain" onClick={()=>setExplain(true)}>Open Explain</button><Editor talk={{outlinePath:'/fixture.md',path:'/',slug:'fixture',title:'Fixture'}} content={initial} viewMode="source" onContentChange={()=>{}} registerInsertObject={fn=>insert=fn} registerEditorCommands={cmd=>window.cmd=cmd} onInsertObjectMenu={(coords,consumeFence)=>setMenu({...coords,consumeFence})}/>{menu&&<SlideContextMenu x={menu.x} y={menu.y} startAtAction="insert-table" consumeFence={menu.consumeFence} onClose={()=>{setMenu(null);window.readEditor().focus()}} onSetLayout={()=>setMenu(null)} onAction={action=>{if(action==='insert-table'){insert('table')}setMenu(null)}}/>}<ExplainPanel isOpen={explain} onClose={()=>setExplain(false)} outlinePath="/fixture.md" content={initial} index={0} onInsertExample={layout=>{window.insertedLayout=layout;setExplain(false)}}/></>}
createRoot(document.getElementById('root')).render(<App/>);
`, resolveDir: root, sourcefile: 'authoring-dom.tsx', loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(scratch, 'harness.js'), logLevel: 'silent' })
  const css = readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8')
  writeFileSync(join(scratch, 'fixture.html'), `<!doctype html><meta charset="utf-8"><style>${css}body{margin:20px}.cm-editor{height:450px}.tl-menu{background:white;z-index:100}</style><div id="root"></div><script src="harness.js"></script>`)
  browser = await chromium.launch({ headless: true, ...(process.env.TW_HEADLESS_SHELL ? { executablePath: process.env.TW_HEADLESS_SHELL } : {}) })
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(pathToFileURL(join(scratch, 'fixture.html')).href)
  await page.waitForFunction(() => window.readEditor?.()?.state.doc.toString().includes('Fixture'))
  await page.evaluate(() => {const v=window.readEditor();v.dispatch({selection:{anchor:v.state.doc.length}});v.focus()})
  await page.keyboard.type('```')
  await page.getByRole('menu', {name:'Slide actions'}).waitFor()
  await page.keyboard.press('Escape')
  assert.equal(await page.evaluate(()=>window.readEditor().state.doc.toString().endsWith('```')), true, 'Escape preserves all three typed backticks')
  await page.keyboard.type('chat')
  assert.equal(await page.evaluate(()=>window.readEditor().state.doc.toString().endsWith('```chat')), true, 'typing continues at the fence language')
  // Outside-click cancellation uses the real menu dismiss hook too.
  await page.evaluate(()=>{const v=window.readEditor();v.dispatch({changes:{from:0,to:v.state.doc.length,insert:'### Fixture\n{id=fixture}\n\n'},selection:{anchor:26}});v.focus()})
  await page.keyboard.press('End')
  await page.keyboard.type('```')
  await page.getByRole('menu', {name:'Slide actions'}).waitFor()
  await page.locator('#outside').click()
  assert.equal(await page.evaluate(()=>window.readEditor().state.doc.toString().endsWith('```')), true, 'outside click preserves typed source')
  // Reopen from a fresh line and choose the normal object door.
  await page.evaluate(()=>{const v=window.readEditor();const text='### Fixture\n{id=fixture}\n\n';v.dispatch({changes:{from:0,to:v.state.doc.length,insert:text},selection:{anchor:text.length}});v.focus()})
  await page.keyboard.type('```')
  await page.getByRole('menu', {name:'Slide actions'}).waitFor()
  await page.locator('[data-slide-action="insert-table"]').click()
  await page.locator('.oe').waitFor()
  assert.equal(await page.locator('.oe').count(), 1, 'normal object insertion opens its editor')
  assert.equal(await page.evaluate(()=>window.readEditor().state.doc.toString().includes('|')), true, 'table source is inserted')
  await page.evaluate(()=>window.cmd.undo())
  assert.equal(await page.evaluate(()=>window.readEditor().state.doc.toString().endsWith('```')), true, 'undo restores the typed fence')

  // The real menu consumes its trigger for every chosen action, independent of Workspace handlers.
  for (const action of ['explain', 'layout-submenu']) {
    await page.evaluate(()=>{const v=window.readEditor();const text='### Fixture\n{id=fixture}\n\n';v.dispatch({changes:{from:0,to:v.state.doc.length,insert:text},selection:{anchor:text.length}});v.focus()})
    await page.keyboard.type('```')
    await page.getByRole('menu', {name:'Slide actions'}).waitFor()
    if (action === 'layout-submenu') {
      await page.locator('[data-slide-action="layout"]').click()
      await page.getByRole('menuitemradio', {name:/Contrast$/}).click()
    } else {
      await page.locator('[data-slide-action="explain"]').click()
    }
    assert.equal(await page.evaluate(()=>window.readEditor().state.doc.toString().includes('```')), false, `${action}: an accepted command consumes the unclosed fence`)
  }

  await page.locator('#explain').click()
  const help = page.getByRole('region', {name:'How to author this layout'})
  await help.waitFor()
  assert.match(await help.innerText(), /user:.*bot:/s)
  assert.match(await help.innerText(), /literal text/)
  assert.match(await help.locator('pre').innerText(), /```chat/)
  await help.locator('summary').click()
  for (const label of ['History sidebar','Text size','Reveal','Streaming','Disclosures']) assert.ok((await help.innerText()).includes(label), label)
  for (const token of ['{sidebar=off}','{size=large}','{reveal=steps}','{stream=on}','{open=all}']) assert.ok((await help.innerText()).includes(token), token)
  if(shots) await page.screenshot({path:join(shots,'talkweaver-chat-authoring-explain.png')})
  await help.getByRole('button',{name:'Insert example into empty slide'}).click()
  assert.equal(await page.evaluate(()=>window.insertedLayout), 'chat', 'Explain delegates example insertion to the existing editor flow')
  assert.deepEqual(errors, [], 'real Editor and Explain render without runtime exceptions')

  // Compile synthetic two-column source through presenter and share/export rendering.
  const source='---\ntitle: Authoring fixture\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n### Before and after\n{contrast}{id=contrast}\n\n- Before\n  - Manual work\n  - Separate tools\n- After\n  - Automated work\n  - One workspace\n'
  const sourcePath=join(scratch,'outline.md');writeFileSync(sourcePath,source)
  const model=await prepareSource(sourcePath,source,'fixture',statSync(sourcePath))
  const slides=extractSlides(model.fullHtml)
  assert.equal(slides.length,1,'two sides compile as one slide')
  const styles=extractStyles(model.fullHtml)
  const exported=buildShareHtml({title:'Fixture',slides,styles})
  for(const [name,html] of [['presenter',model.fullHtml],['export',exported]]){
    const file=join(scratch,`${name}.html`);writeFileSync(file,html)
    await page.goto(pathToFileURL(file).href)
    await page.evaluate(()=>document.fonts?.ready)
    for(const width of [1300,800]){
      await page.setViewportSize({width,height:900})
      const geometry=await page.evaluate(()=>{
        const grid=document.querySelector('.contrast-vs');
        const rect=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};
        const left=grid.querySelector('.vs-head.L');const right=grid.querySelector('.vs-head.R');
        return {left:rect(left),right:rect(right),rows:[...grid.querySelectorAll('.vs-text')].map(el=>({text:el.textContent,...rect(el)})),title:[...document.querySelectorAll('.slide h1,.slide h2,.slide h3')].map(el=>({text:el.textContent,...rect(el)}))}
      })
      assert.ok(geometry.left.w>0&&geometry.right.w>0,`${name}: both columns visible`)
      assert.ok(geometry.left.x+geometry.left.w<geometry.right.x,`${name}: columns stay side by side at ${width}`)
      assert.deepEqual(geometry.rows.map(r=>r.text),['Manual work','Automated work','Separate tools','One workspace'])
      assert.ok(geometry.rows.every(r=>r.w>0&&r.h>0),`${name}: every child has a rendered box`)
      if(shots&&width===1300)await page.screenshot({path:join(shots,`talkweaver-contrast-${name}.png`)})
    }
  }
  console.log('PASS real Editor fence Escape, outside click, language continuation, object insertion and undo; Explain chat markup and controls; presenter/export two-column contrast at two widths')
}finally{await browser?.close();rmSync(scratch,{recursive:true,force:true})}
