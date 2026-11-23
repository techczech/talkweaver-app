// Shared harness for editor DOM tests: the real React Editor (both views) in Playwright's bundled
// Chromium, with IPC replaced by an in-memory outline that records every write. `|` marks the caret.
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')

export async function openEditorHarness() {
  const scratch = mkdtempSync(join(tmpdir(), 'tw-editor-dom-'))
  await build({
    stdin: {
      contents: `
import React from 'react'
import {createRoot} from 'react-dom/client'
import {flushSync} from 'react-dom'
import Editor from './src/renderer/src/components/Editor.tsx'
import {EditorView} from '@codemirror/view'
import {EditorSelection} from '@codemirror/state'
import {undo, redo, undoDepth} from '@codemirror/commands'
import {SearchQuery, setSearchQuery, replaceAll} from '@codemirror/search'
import {pasteTextAtSelection, pasteBlockAtSelection} from './src/renderer/src/extensions/headingEndInsert.ts'
import {detectObjectBlocks} from './src/renderer/src/extensions/objectBlocks/detect.ts'
import {runActionBarEditing} from './src/renderer/src/components/actionBar/editing-command.ts'
import {insertSpeakerNotes} from './src/renderer/src/extensions/objectBlocks/commands.ts'
let source='', mode='plain', serial=0
const root=createRoot(document.getElementById('root'))
window.writes=[]
window.tw={talk:{readOutline:()=>Promise.resolve(source),writeOutline:async(p,text)=>{window.writes.push(text);return {ok:true,content:text}},outlineDiskVersion:async()=>null,acceptOutlineDiskVersion:async()=>({ok:true}),discardOutlineRecovery:async()=>true,outlineRecovery:async()=>null},vault:{onTalkMetaUpdated:()=>()=>{}},workFiles:{list:async()=>null},icons:{svg:async()=>null}}
function Fixture(){
 return <Editor talk={{outlinePath:'/fixture.md',path:'/',slug:'fixture',title:'Fixture'}} content={source} viewMode={mode} onContentChange={()=>{}} onSectionChild={line=>window.sectionChild=line} registerEditorCommands={c=>window.cmd=c} registerInsert={f=>window.insertAtCaret=f} registerInsertObject={f=>window.insertObject=f}/>
}
window.view=()=>EditorView.findFromDOM(document.querySelector('.cm-editor'))
window.mount=(text,nextMode)=>{source=text;mode=nextMode;serial++;window.writes=[];window.sectionChild=null;flushSync(()=>root.render(<Fixture key={serial}/>))}
window.setCaret=(anchor,head)=>{const v=window.view();v.focus();v.dispatch({selection:EditorSelection.single(anchor,head??anchor)})}
window.shown=()=>{const v=window.view();const r=v.state.selection.main;const t=v.state.doc.toString();if(r.empty)return t.slice(0,r.head)+'|'+t.slice(r.head);return t.slice(0,r.from)+'['+t.slice(r.from,r.to)+']'+t.slice(r.to)}
window.undoAll=()=>{const v=window.view();while(undoDepth(v.state)>0)undo(v)}
window.undoOnce=()=>undo(window.view())
window.depth=()=>undoDepth(window.view().state)
// Ways in that tests drive directly (the app reaches them from menus, the clipboard and the Scratchpad).
window.entry={
 pasteText:(t)=>pasteTextAtSelection(window.view(),t),
 pasteBlock:(t)=>pasteBlockAtSelection(window.view(),t),
 replaceSelection:(t)=>{const v=window.view();v.dispatch(v.state.replaceSelection(t))},
 insertAt:(pos,t,userEvent)=>{const v=window.view();v.dispatch({changes:{from:pos,insert:t},selection:{anchor:pos+t.length},...(userEvent?{userEvent}:{})})},
 replaceAll:(search,replace,regexp)=>{const v=window.view();v.dispatch({effects:setSearchQuery.of(new SearchQuery({search,replace,regexp}))});return replaceAll(v)},
 objects:(t)=>detectObjectBlocks(t).map(b=>({kind:b.kind,from:b.from,to:b.to,source:b.source})),
 actionBar:(a)=>runActionBarEditing(window.view(),a),
 insertNotes:()=>insertSpeakerNotes(window.view())
}
`,
      resolveDir: root, sourcefile: 'editor-harness.tsx', loader: 'tsx'
    },
    bundle: true, define: { __TW_SECURITY_TEST__: 'false' }, platform: 'browser', format: 'iife', jsx: 'automatic',
    outfile: join(scratch, 'harness.js'), logLevel: 'silent'
  })
  // The app's own stylesheet, so object headers, buttons and the gap look as they do in the app.
  copyFileSync(join(root, 'src/renderer/src/styles.css'), join(scratch, 'styles.css'))
  writeFileSync(join(scratch, 'fixture.html'), '<meta charset="utf-8"><link rel="stylesheet" href="styles.css"><style>body{margin:0}.cm-editor{height:700px;width:1000px}</style><div id="root"></div><script src="harness.js"></script>')
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(pathToFileURL(join(scratch, 'fixture.html')).href)

  /** Mount `marked` (caret at the first `|`, or, with no `|`, a selection `[...]`) in a view mode. */
  async function mount(marked, mode) {
    let anchor, head
    let text = marked
    if (marked.includes('[') && !marked.includes('|')) {
      anchor = marked.indexOf('['); head = marked.indexOf(']') - 1
      text = marked.replace('[', '').replace(']', '')
    } else {
      anchor = head = marked.indexOf('|'); text = marked.replace('|', '')
    }
    await page.evaluate(({ text, mode }) => window.mount(text, mode), { text, mode })
    await page.waitForFunction((t) => window.view()?.state.doc.toString() === t, text)
    await page.evaluate(({ anchor, head }) => window.setCaret(anchor, head), { anchor, head })
    await page.waitForTimeout(50)
  }
  const shown = () => page.evaluate(() => window.shown())
  // History groups changes closer than 500 ms; a pause keeps each key press its own step.
  const press = async (key) => { await page.waitForTimeout(30); await page.keyboard.press(key); await page.waitForTimeout(30) }
  async function close() {
    await browser.close()
    rmSync(scratch, { recursive: true, force: true })
  }
  return { page, mount, shown, press, errors, close }
}
