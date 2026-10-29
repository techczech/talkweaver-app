// Real built App/Workspace/Editor, hidden Electron, synthetic vault only.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
const repo=resolve('.')
for(const mode of (process.env.TW_TEST_EDITOR_MODE?[process.env.TW_TEST_EDITOR_MODE]:['markdown','plain'])){
mkdirSync(new URL('../research/', import.meta.url), { recursive: true })
const scratch=mkdtempSync(join(repo,'research/.tmp-editor-outline-follow-'))
const userData=join(scratch,'userData'),vault=join(scratch,'vault'),talkDir=join(vault,'outline-follow')
mkdirSync(userData,{recursive:true});mkdirSync(talkDir,{recursive:true})
const source='---\noutline_version: 2\ntitle: Editor follow fixture\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n### First slide\n{id=first}\n\nFirst slide body.\n\n### Second slide\n{id=second}\n\nSecond slide body.\n\n### Third slide\n{id=third}\n\nThird slide body.\n'
writeFileSync(join(talkDir,'outline-follow-outline.md'),source)
writeFileSync(join(userData,'config.json'),JSON.stringify({vaultRoot:vault,editorViewMode:mode}))
process.on('exit',()=>rmSync(scratch,{recursive:true,force:true}))
let app
const taskEnv={...process.env,TW_E2E:'1',TW_REC_TEST:'1'}
delete taskEnv.ELECTRON_RUN_AS_NODE
try{
 await ensureFreshBuild(repo)
 app=await electron.launch({args:['.',`--user-data-dir=${userData}`],cwd:repo,env:taskEnv})
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().every(w=>!w.isVisible()&&!w.webContents.getWebPreferences().backgroundThrottling)),true,'fixture windows stay hidden and unthrottled')
 const page=await app.firstWindow();page.setDefaultTimeout(15000)
 const errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.locator('[data-talk-slug="outline-follow"]').first().dblclick()
 await page.locator('.cm-content').waitFor()
 await page.locator('.cm-line').filter({hasText:'Second slide body.'}).click()
 await page.getByRole('tab',{name:'Slide outline',exact:true}).waitFor()
 const capture=async(label)=>{
  const current=await page.locator('.so-row--current').allTextContents()
  const selected=await page.locator('.so-row--sel').allTextContents()
  const tab=await page.locator('.sidebar-modebar [aria-selected="true"]').allTextContents()
  console.log(JSON.stringify({mode,label,current,selected,tab,errors}))
 }
 await capture('first editor click: expected second slide')
 await page.waitForFunction(()=>document.querySelector('.so-row--current')?.textContent.includes('Second slide'))
 await page.locator('.cm-line').filter({hasText:'Third slide body.'}).click()
 await page.waitForFunction(()=>document.querySelector('.so-row--current')?.textContent.includes('Third slide'))
 await capture('second editor click: expected third slide')
 // A manual outline selection must not leave the cursor marker stuck there.
 await page.locator('.so-slide').filter({hasText:'First slide'}).click()
 await page.locator('.cm-line').filter({hasText:'Second slide body.'}).click()
 await page.waitForFunction(()=>document.querySelector('.so-row--current')?.textContent.includes('Second slide'))
 await capture('outline selection then editor click: expected second slide')
 // A deliberate return to Talks is governed by the existing once-per-open rule.
 await page.getByRole('tab',{name:'Talks',exact:true}).click()
 await page.locator('.cm-line').filter({hasText:'Third slide body.'}).click()
 assert.equal(await page.getByRole('tab',{name:'Talks',exact:true}).getAttribute('aria-selected'),'true','a deliberate return to Talks is preserved until the talk is reopened')
 await capture('return to Talks then editor click: existing one-shot switch rule')
 // Reopening the talk from Talks re-arms the existing switch.
 await page.locator('[data-talk-slug="outline-follow"]').first().dblclick()
 await page.locator('.cm-line').filter({hasText:'Second slide body.'}).click()
 await page.waitForFunction(()=>document.querySelector('.so-row--current')?.textContent.includes('Second slide'))
 await capture('same talk reopened from Talks: expected second slide')
 assert.deepEqual(errors,[])
 if(process.env.SHOTS)await page.screenshot({path:join(resolve(process.env.SHOTS),`talkweaver-editor-outline-follow-${mode}.png`)})
 console.log('PASS real App editor clicks follow the active slide; one-shot sidebar-switch distinction recorded')
}finally{await app?.close();rmSync(scratch,{recursive:true,force:true})}

}
