// Actual React Editor and save command; only IPC is replaced with a copied fixture file.
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { normalizePositions } from '../src/shared/outline-normalize.ts'

const root = resolve(import.meta.dirname, '..')
const scratch = mkdtempSync(join(tmpdir(), 'tw-rich-roundtrip-'))
let browser
try {
  await build({ stdin: { contents: `
import React, {useRef} from 'react'
import {createRoot} from 'react-dom/client'
import {flushSync} from 'react-dom'
import Editor from './src/renderer/src/components/Editor.tsx'
import {EditorView} from '@codemirror/view'
import {StateEffect} from '@codemirror/state'
import {useOutlineDiskChange} from './src/renderer/src/components/useOutlineDiskChange.ts'
import {outlineDiskChanges} from './src/renderer/src/lib/outlineDiskChange.ts'
let source='', mode='plain', serial=0, release
const root=createRoot(document.getElementById('root'))
window.tw={talk:{readOutline:()=>window.delayed?new Promise(r=>release=()=>r(source)):Promise.resolve(source),writeOutline:async(p,text)=>{window.attempts++;if(window.attempts>(window.refuseAfter??Infinity))return false;if(window.failSave)return false;if(window.holdSave)await new Promise(r=>window.resumeSave=r);if(window.refuseHeldSave)return false;const saved=window.stampSave?text.replace("### Pending capture","### Pending capture {id=permanent}"):text;await window.persist(saved);return {ok:true,content:saved}},outlineDiskVersion:async()=>({text:window.diskText,hash:"changed"}),acceptOutlineDiskVersion:async()=>({ok:true}),discardOutlineRecovery:async()=>true,outlineRecovery:async()=>null},vault:{onTalkMetaUpdated:()=>()=>{}},workFiles:{list:async()=>null},icons:{svg:async()=>null}}
function Fixture(){
 const read=useRef(null),replace=useRef(null)
 window.diskGuard=useOutlineDiskChange({activeOutlinePath:'/fixture.md',readDoc:()=>read.current?.()??null,replaceDoc:(text,opts)=>replace.current?.(text,opts)??null,saveBuffer:async()=>false,flush:async()=>window.cmd.flushSave(),onDiscardTalk:()=>{}})
 return <Editor talk={{outlinePath:'/fixture.md',path:'/',slug:'fixture',title:'Fixture'}} content={source} viewMode={mode} onContentChange={()=>{}} registerReadDoc={fn=>read.current=fn} registerReplaceDoc={fn=>replace.current=fn} registerEditorCommands={c=>window.cmd=c}/>
}
const render=()=>flushSync(()=>root.render(<Fixture key={serial}/>))
window.attempts=0
window.reload=text=>{window.diskText=text;outlineDiskChanges.report({outlinePath:'/fixture.md',kind:'changed',hash:'changed',changedAt:Date.now()});window.diskGuard.choose('reload')}
window.caught=[]
window.mount=(text,nextMode,delayed=false)=>{source=text;mode=nextMode;serial++;window.delayed=delayed;render();window.view().dispatch({effects:StateEffect.appendConfig.of(EditorView.exceptionSink.of(e=>window.caught.push(String(e))))})}
window.mode=m=>{mode=m;render()}
window.view=()=>EditorView.findFromDOM(document.querySelector('.cm-editor'))
window.release=()=>release()
window.leave=()=>flushSync(()=>root.render(null))
`, resolveDir: root, sourcefile: 'roundtrip.tsx', loader: 'tsx' }, bundle: true, define: { __TW_SECURITY_TEST__: 'false' }, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(scratch, 'harness.js'), logLevel: 'silent' })
  writeFileSync(join(scratch, 'fixture.html'), '<meta charset="utf-8"><style>.cm-editor{height:500px}</style><div id="root"></div><script src="harness.js"></script>')
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  let writes = 0
  const disk = join(scratch, 'outline.md')
  await page.exposeFunction('persist', text => { writes++; writeFileSync(disk, text) })
  await page.goto(pathToFileURL(join(scratch, 'fixture.html')).href)
  let reviewCases = 0
  for (const scenario of ['retry','reload']) for (const mode of ['plain','markdown']) {
    if (process.env.TW_RICH_REVIEW_CASE && process.env.TW_RICH_REVIEW_CASE !== scenario) continue
    const source='### Review control\n\n{pyramid}{id=control}\n\n- One\n- Two\n'
    writeFileSync(disk,source);writes=0
    await page.evaluate(({source,mode})=>{window.failSave=false;window.attempts=0;window.mount(source,mode)}, {source,mode})
    await page.waitForFunction(()=>window.view()?.state.doc.toString().includes('Review control'))
    if(scenario==='retry') {
      await page.evaluate(()=>{window.failSave=true;const v=window.view();v.dispatch({changes:{from:v.state.doc.length,insert:'Keep this edit\n'}})})
      await page.waitForFunction(()=>window.attempts===1)
      assert.equal(writes,0,`${mode}: failed autosave wrote nothing`)
      assert.equal(readFileSync(disk,'utf8'),source)
      await page.evaluate(async()=>{window.failSave=false;await window.cmd.flushSave()})
      assert.equal(writes,1,`${mode}: flush retries failed autosave without another edit`)
      assert.equal(readFileSync(disk,'utf8'),normalizePositions(source+'Keep this edit\n'))
      // Once acknowledged, another flush must leave the saved file alone.
      await page.evaluate(()=>window.cmd.flushSave())
      assert.equal(writes,1,`${mode}: successful retry is clean`)
      // An acknowledgement for older text must not clear newer unsaved text.
      await page.evaluate(()=>{window.holdSave=true;window.resumeSave=null;const v=window.view();v.dispatch({changes:{from:v.state.doc.length,insert:'Older write\n'}})})
      await page.waitForFunction(()=>typeof window.resumeSave==='function')
      await page.evaluate(async()=>{const v=window.view();v.dispatch({changes:{from:v.state.doc.length,insert:'Newer edit\n'}});window.holdSave=false;window.resumeSave();await window.cmd.flushSave()})
      assert.equal(writes,3,`${mode}: flush also saves text newer than an in-flight acknowledgement`)
      assert.equal(readFileSync(disk,'utf8'),normalizePositions(source+'Keep this edit\n')+'Older write\nNewer edit\n')
    } else {
      const changed=source.replace('Review control','Reloaded control')
      writeFileSync(disk,changed)
      const before=readFileSync(disk),mtime=statSync(disk,{bigint:true}).mtimeNs
      await page.evaluate(text=>window.reload(text),changed)
      await page.waitForFunction(()=>window.view()?.state.doc.toString().includes('Reloaded control'))
      await page.evaluate(()=>window.cmd.flushSave())
      await page.waitForTimeout(1700)
      assert.equal(writes,0,`${mode}: Reload adopts disk without scheduling a save`)
      assert.deepEqual(readFileSync(disk),before)
      assert.equal(statSync(disk,{bigint:true}).mtimeNs,mtime)
      // A real edit after Reload must still save, while undo can restore the old text.
      await page.evaluate(async()=>{const v=window.view();v.dispatch({changes:{from:v.state.doc.length,insert:'Edited after reload\n'}});await window.cmd.flushSave()})
      assert.equal(readFileSync(disk,'utf8'),normalizePositions(changed+'Edited after reload\n'))
      assert.equal(writes,1)
    }
    reviewCases++
  }
  // Capture must wait after the autosave timer has fired, through IPC and stamped-text adoption.
  if (!process.env.TW_RICH_REVIEW_CASE || process.env.TW_RICH_REVIEW_CASE === 'settle') {
    for (const mode of ['plain', 'markdown']) for (const refused of [false, true]) {
      const source = '### Pending capture\n\n[Embed: https://example.com]\n'
      writeFileSync(disk, source); writes = 0
      await page.evaluate(({source, mode, refused}) => {
        window.failSave = false; window.refuseHeldSave = refused; window.stampSave = true
        window.holdSave = true; window.resumeSave = null; window.attempts = 0; window.captureResult = null
        window.mount(source, mode)
      }, {source, mode, refused})
      await page.waitForFunction(() => window.view()?.state.doc.toString().includes('Pending capture'))
      await page.evaluate(() => { const v=window.view(); v.dispatch({changes:{from:v.state.doc.length, insert:'Edited before capture\n'}}) })
      await page.waitForFunction(() => typeof window.resumeSave === 'function')
      await page.evaluate(() => {
        window.capturePromise = (async () => {
          try {
            // Fallback exercises the old capture boundary on the historical failing revision.
            await (window.cmd.settleSave ?? window.cmd.flushSave)()
            window.captureResult = {text: window.view().state.doc.toString()}
          } catch { window.captureResult = {refused:true} }
        })()
      })
      await page.waitForTimeout(100)
      assert.equal(await page.evaluate(() => window.captureResult), null, `${mode}: capture waits for pending autosave IPC`)
      await page.evaluate(async () => { window.holdSave=false; window.resumeSave(); await window.capturePromise })
      const result = await page.evaluate(() => window.captureResult)
      if (refused) {
        assert.deepEqual(result, {refused:true}, `${mode}: refused autosave stops capture`)
        assert.equal(writes, 0, `${mode}: refused autosave left disk alone`)
        assert.doesNotMatch(await page.evaluate(() => window.view().state.doc.toString()), /id=permanent/)
      } else {
        assert.match(result.text, /### Pending capture \{id=permanent\}/, `${mode}: capture reads adopted permanent ID`)
        assert.equal(result.text, readFileSync(disk, 'utf8'), `${mode}: capture identity matches acknowledged disk`)
        assert.equal(writes, 1, `${mode}: settlement reuses pending save, no duplicate write`)
      }
      assert.equal(await page.evaluate(() => window.attempts), 1)
      await page.evaluate(() => { window.refuseHeldSave=false; window.stampSave=false; window.leave() })
      reviewCases++
    }
  }
  for (const scenario of ['settle-newer', 'flush-inflight']) for (const mode of ['plain', 'markdown']) {
    if (process.env.TW_RICH_REVIEW_CASE && process.env.TW_RICH_REVIEW_CASE !== scenario) continue
    const source = '### In-flight write {id=inflight}\n\nBody\n'
    writeFileSync(disk, source); writes = 0
    await page.evaluate(({source,mode}) => {
      window.failSave=false;window.refuseHeldSave=false;window.stampSave=false
      window.holdSave=true;window.resumeSave=null;window.attempts=0;window.refuseAfter=Infinity
      window.mount(source,mode)
    }, {source,mode})
    await page.waitForFunction(() => window.view()?.state.doc.toString().includes('In-flight write'))
    await page.evaluate(() => { const v=window.view();v.dispatch({changes:{from:v.state.doc.length,insert:'First edit\n'}}) })
    await page.waitForFunction(() => typeof window.resumeSave==='function')
    if (scenario==='settle-newer') {
      await page.evaluate(() => {
        window.refuseAfter=2;window.saveResult=null
        window.savePromise=window.cmd.settleSave().then(()=>window.saveResult='saved',()=>window.saveResult='refused')
        const v=window.view();v.dispatch({changes:{from:v.state.doc.length,insert:'Newer edit\n'}})
        const first=window.resumeSave;window.resumeSave=null;first()
      })
      await page.waitForFunction(() => window.attempts===2 && typeof window.resumeSave==='function')
      // The second acknowledgement stays pending beyond the newer edit's debounce deadline.
      await page.waitForTimeout(1700)
      await page.evaluate(async () => { window.holdSave=false;window.resumeSave();await window.savePromise })
      assert.equal(await page.evaluate(() => window.attempts),2,`${mode}: newer typing and slow acknowledgement write once per distinct buffer`)
      assert.equal(await page.evaluate(() => window.saveResult),'saved',`${mode}: a redundant refused write cannot abort capture`)
      assert.equal(writes,2)
      assert.equal(readFileSync(disk,'utf8'),normalizePositions(source+'First edit\nNewer edit\n'))
    } else {
      await page.evaluate(() => { window.savePromise=window.cmd.flushSave() })
      await page.evaluate(async () => { window.holdSave=false;window.resumeSave();await window.savePromise })
      assert.equal(await page.evaluate(() => window.attempts),1,`${mode}: flush during identical in-flight autosave reuses its promise`)
      assert.equal(writes,1)
      assert.equal(readFileSync(disk,'utf8'),normalizePositions(source+'First edit\n'))
    }
    await page.evaluate(() => { window.refuseAfter=Infinity;window.leave() })
    reviewCases++
  }
  // Ported from 00b776e2: a flush shares and awaits an identical in-flight autosave.
  for (const mode of ['plain','markdown']) {
    if (process.env.TW_RICH_REVIEW_CASE && process.env.TW_RICH_REVIEW_CASE !== 'flush-inflight') continue
    const source='### In-flight write {id=inflight}\n\nBody\n'
    writeFileSync(disk,source);writes=0
    await page.evaluate(({source,mode})=>{window.failSave=false;window.holdSave=true;window.resumeSave=null;window.attempts=0;window.mount(source,mode)}, {source,mode})
    await page.waitForFunction(()=>window.view()?.state.doc.toString().includes('In-flight write'))
    await page.evaluate(()=>{const v=window.view();v.dispatch({changes:{from:v.state.doc.length,insert:'First edit\n'}})})
    await page.waitForFunction(()=>typeof window.resumeSave==='function')
    await page.evaluate(()=>{window.flushFinished=false;window.savePromise=window.cmd.flushSave().then(()=>{window.flushFinished=true})})
    await page.waitForTimeout(50)
    assert.equal(await page.evaluate(()=>window.flushFinished),false,`${mode}: flush cannot return before persistence finishes`)
    assert.equal(readFileSync(disk,'utf8'),source,`${mode}: held IPC has not written yet`)
    await page.evaluate(async()=>{window.holdSave=false;window.resumeSave();await window.savePromise})
    assert.equal(await page.evaluate(()=>window.attempts),1,`${mode}: flush during identical in-flight autosave reuses its promise`)
    assert.equal(writes,1)
    assert.equal(readFileSync(disk,'utf8'),normalizePositions(source+'First edit\n'))
    await page.evaluate(()=>window.leave())
    reviewCases++
  }
  const fixtures = []
  function collect(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name)
      if (e.isDirectory()) collect(path)
      else if (e.name.endsWith('-outline.md')) fixtures.push([e.name, readFileSync(path, 'utf8')])
    }
  }
  collect(join(root, 'resources/example-vault'))
  assert.ok(fixtures.length >= 5, 'demo vault outlines were discovered')
  const rich = '---\ntitle: "A field guide"\nauthor: Example speaker\ncustom: [one, two]\n---\n\n# A field guide\n\n## Section\n\n### Evidence {icon=lucide:book}\n\n{list}{id=evidence}\n\n- **Bold** and *italic* with ==highlight==\n- [Link](https://example.org/a?x=1)  \n\n> A quotation\n> — Example\n\n```chart\nbar\n- First: 3\n- Second: 5\n```\n\n```table\n| Name | Value |\n| --- | --- |\n| One | Two |\n```\n\nEmbed: assets/example.html\n\n::: notes\nNotes with {literal} tokens.\n:::\n\n<!-- Preserve this comment -->\n'
  fixtures.push(['rich-source', rich], ['crlf', rich.replaceAll('\n','\r\n')], ['bom', '\ufeff'+rich], ['no-final-newline', rich.trimEnd()], ['unknown-fence', '# Talk\n\n### Slide\n\n```future-object\n## Literal heading\n{layout-token}\n```\n'], ['empty', ''])
  let passed = 0
  for (const [name, source] of (process.env.TW_RICH_REVIEW_CASE ? [] : fixtures)) for (const mode of ['plain', 'markdown']) {
    writeFileSync(disk, source)
    const before = readFileSync(disk)
    const mtime = statSync(disk, {bigint:true}).mtimeNs
    writes = 0
    await page.evaluate(({source,mode}) => window.mount(source,mode), {source,mode})
    await page.waitForFunction(source => window.view()?.state.doc.toString() === source.replace(/\r\n?/g,'\n'), source)
    await page.evaluate(async mode => {
      const v=window.view()
      v.dispatch({selection:{anchor:v.state.doc.length}})
      window.mode(mode==='plain'?'markdown':'plain')
      window.mode(mode)
      await window.cmd.flushSave()
    }, mode)
    // Includes the 1.5s debounce window: mounting and changing views must not schedule autosave.
    await page.waitForTimeout(1600)
    assert.deepEqual(readFileSync(disk), before, `${name}/${mode}: byte-identical after open, tab switches and save`)
    assert.equal(writes, 0, `${name}/${mode}: no write IPC without an edit`)
    assert.equal(statSync(disk,{bigint:true}).mtimeNs, mtime, `${name}/${mode}: mtime unchanged after save and tabs`)
    // Close/quit callers flush, then tear down the Editor; exercise both registered save and cleanup.
    await page.evaluate(async()=>{await window.cmd.flushSave();window.leave()})
    assert.equal(writes,0,`${name}/${mode}: close/quit cleanup sends no write`)
    assert.deepEqual(readFileSync(disk),before,`${name}/${mode}: close/quit retains bytes`)
    assert.equal(statSync(disk,{bigint:true}).mtimeNs,mtime,`${name}/${mode}: close/quit retains mtime`)
    passed++
  }
  // Positive control: a real edit must still reach disk, so the harness cannot pass by disconnecting saves.
  for (const mode of (process.env.TW_RICH_REVIEW_CASE ? [] : ['plain','markdown'])) {
    const source = '### Save control\n\n{pyramid}{id=control}\n\n- One\n- Two\n'
    assert.notEqual(normalizePositions(source),source,'positive control requires ADR-0020 normalisation')
    writeFileSync(disk,source); writes=0
    await page.evaluate(({source,mode})=>window.mount(source,mode),{source,mode})
    await page.waitForFunction(()=>window.view()?.state.doc.toString().includes('Save control'))
    await page.evaluate(async()=>{const v=window.view();v.dispatch({changes:{from:v.state.doc.length,insert:'Changed\n'}});await window.cmd.flushSave()})
    assert.equal(writes,1,`${mode}: edited flush writes once`)
    assert.equal(readFileSync(disk,'utf8'),normalizePositions(source+'Changed\n'),`${mode}: edited flush retains ADR-0020 normalisation`)
    writeFileSync(disk,source); writes=0
    await page.evaluate(({source,mode})=>window.mount(source,mode),{source,mode})
    await page.waitForFunction(()=>window.view()?.state.doc.toString().includes('Save control'))
    await page.evaluate(()=>{const v=window.view();v.dispatch({changes:{from:v.state.doc.length,insert:'Autosaved\n'}})})
    await page.waitForTimeout(1700)
    assert.equal(writes,1,`${mode}: actual edit autosaves`)
    assert.equal(readFileSync(disk,'utf8'),normalizePositions(source+'Autosaved\n'))
    writes=0
    await page.evaluate(()=>window.mount('### Deferred\n\nBody\n', 'plain', true))
    await page.evaluate(()=>window.cmd.flushSave())
    assert.equal(writes,0,'loading transient cannot save')
    await page.evaluate(()=>window.release())
    await page.waitForFunction(()=>window.view()?.state.doc.toString().includes('Deferred'))
    await page.evaluate(()=>window.cmd.flushSave())
    assert.equal(writes,0,'load is not an edit')
  }
  assert.deepEqual(await page.evaluate(()=>window.caught),[], 'CodeMirror caught no extension exceptions')
  assert.deepEqual(errors,[], 'actual editor has no runtime exceptions')
  console.log(process.env.TW_RICH_REVIEW_CASE ? `PASS ${reviewCases} ${process.env.TW_RICH_REVIEW_CASE} review regressions` : `PASS ${passed} byte-identical round trips; 4 edited-save controls (flush and autosave); 2 deferred-load controls; ${reviewCases} review regressions`)
} finally {
  await browser?.close()
  rmSync(scratch,{recursive:true,force:true})
}
