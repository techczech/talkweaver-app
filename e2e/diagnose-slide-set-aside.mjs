// Hidden Electron, isolated copy of a checked-in synthetic talk; real disk + renderer history + IPC stores.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { cutBlocks } from '../src/shared/slide-handling/blocks.ts'
import { insertSlideAt } from '../src/shared/scratchpad-insert.ts'
const repo=resolve('.'), temp=realpathSync(mkdtempSync(join(tmpdir(),'tw-aside-e2e-')))
const vault=join(temp,'vault'), userData=join(temp,'userData'), talkDir=join(vault,'target'), outline=join(talkDir,'target-outline.md')
let app, checks=0
const pass=message=>{checks++;console.log('PASS '+message)}
try {
 mkdirSync(userData,{recursive:true});cpSync(join(repo,'e2e/fixtures/slide-set-aside'),talkDir,{recursive:true})
 writeFileSync(join(userData,'config.json'),JSON.stringify({vaultRoot:vault,editorViewMode:'markdown'}))
 await ensureFreshBuild(repo)
 const env={...process.env,TW_E2E:'1',TW_REC_TEST:'1'};delete env.ELECTRON_RUN_AS_NODE
 app=await electron.launch({args:['.',`--user-data-dir=${userData}`,'--use-mock-keychain'],cwd:repo,env})
 assert(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().every(w=>!w.isVisible())));pass('all Electron windows hidden')
 const page=await app.firstWindow();page.setDefaultTimeout(20000)
 const errors=[];page.on('pageerror',e=>errors.push(e.message))
 const saved=()=>readFileSync(outline,'utf8')
 const waitSaved=async(want)=>{for(let i=0;i<150&&saved()!==want;i++)await page.waitForTimeout(100);assert.equal(saved(),want)}
 await page.locator('[data-talk-slug="target"]').first().dblclick();await page.locator('.cm-content').waitFor();await page.waitForTimeout(2000)
 const original=saved();const ref=heading=>({line:original.split('\n').indexOf(heading)+1,headingText:heading})
 const refs=['## First section','### Alpha','### Beta'].map(ref)
 const cut=cutBlocks(original,refs);assert(!('refused'in cut))
 await page.locator('.pane-btn[title="Grid"]').click();await page.locator('.grid-cell[draggable="true"]').first().waitFor()
 for(const title of ['First section','Alpha','Beta'])await page.getByLabel(`Select ${title}`,{exact:true}).check()
 // Drives the actual workspace capture handler and rebindable command, with three cards selected.
 await page.locator('.grid-view').focus();await page.keyboard.press('Meta+Alt+s');await waitSaved(cut.text)
 const statePath=join(talkDir,'scratchpad/scratchpad-state.json'), state=()=>JSON.parse(readFileSync(statePath,'utf8'))
 assert.equal(state().groups[0].name,`Set aside · ${new Date().toISOString().slice(0,10)}`)
 assert.equal(state().items.length,1,'section snapshot carries its two selected children without duplicating them')
 const item=state().items[0];assert.equal(item.slide.slideId,'sect1');for(const id of ['sect1','alpha','betaa'])assert.equal(item.slide.markdown.split(`{id=${id}}`).length,2)
 assert.equal(item.slide.markdown,original.slice(original.indexOf('## First section'),original.indexOf('## Last section')))
 pass('set aside three cards including a section removes exactly their block and persists the full snapshot with every id')
 await page.locator('.grid-view').focus();await page.keyboard.press('Meta+z');await waitSaved(original)
 await page.getByText('In talk',{exact:true}).waitFor();assert.equal(state().items.length,1);pass('one Undo restores the byte-identical outline; the kept snapshot shows In talk')
 await page.locator('.grid-view').focus();await page.keyboard.press('Meta+Shift+z');await waitSaved(cut.text)
 // Dock so every click remains inside the hidden viewport.
 const dock=page.getByRole('button',{name:'Dock to the right',exact:true});if(await dock.count())await dock.click()
 await page.locator('.sp-card').first().click();await page.getByRole('button',{name:'Change place',exact:true}).click()
 await page.getByRole('button',{name:'At the start of the talk',exact:true}).click()
 await page.getByRole('button',{name:'Insert whole slide',exact:true}).click();await waitSaved(original)
 assert.equal(state().items[0].slide.slideId,'sect1');pass('Insert puts the section and both slides back byte-identically, retaining all ids')
 await page.locator('.grid-view').focus();await page.keyboard.press('Meta+z');await waitSaved(cut.text)
 // Drop before the remaining root section; marker and expected insertion use the same SlidePlace.
 const targetRef={line:cut.text.split('\n').indexOf('## Last section')+1,title:'Last section',kind:'before'}
 const expected=insertSlideAt(cut.text,targetRef,item.slide.markdown);assert(expected.ok)
 const source=await page.locator('.sp-card').first().elementHandle()
 const target=await page.locator('.grid-cell').filter({has:page.getByText('Last section',{exact:true})}).first().elementHandle()
 await page.evaluate(([s,d])=>{const dt=new DataTransfer();s.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dt}));window.asideDrag=dt;d.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));},[source,target])
 assert.equal(await page.locator('[data-drop-target="true"]').count(),1);pass('Scratchpad drag shows the grid insertion marker')
 await page.evaluate(([s,d])=>{d.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:window.asideDrag}));s.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:window.asideDrag}));delete window.asideDrag},[source,target])
 await waitSaved(expected.text);assert.equal(saved(),original);pass('drop lands exactly at the marker with ids retained')
 await page.locator('.grid-view').focus();await page.keyboard.press('Meta+z');await waitSaved(cut.text);pass('one Undo removes only the dropped snapshot')
 assert.deepEqual(errors,[]);console.log(`${checks} set-aside Electron checks passed`)
}finally{await app?.close();rmSync(temp,{recursive:true,force:true})}
