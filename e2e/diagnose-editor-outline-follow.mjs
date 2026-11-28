// Real built App/Workspace/Editor, hidden Electron, synthetic vault only.
import assert from 'node:assert/strict'
import { openTalkByTitle, showTalksBeforeOpening } from './lib/talklist.mjs'
import { _electron as electron } from 'playwright'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
const repo=resolve('.')
for(const mode of (process.env.TW_TEST_EDITOR_MODE?[process.env.TW_TEST_EDITOR_MODE]:['markdown','plain','slide'])){
const scratch = mkdtempSync(join(tmpdir(), 'tw-editor-outline-follow-'))
const userData=join(scratch,'userData'),vault=join(scratch,'vault'),talkDir=join(vault,'outline-follow')
mkdirSync(userData,{recursive:true});mkdirSync(talkDir,{recursive:true})
const source='---\noutline_version: 2\ntitle: Editor follow fixture\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n### First slide\n{id=first}\n\nFirst slide body.\n\n:::notes\nFirst private reminder\n:::\n\n### Second slide\n{id=second}\n\nSecond slide body.\n\n### Third slide\n{id=third}\n\nThird slide body.\n'
writeFileSync(join(talkDir,'outline-follow-outline.md'),source)
const incomingDir = join(vault, 'incoming')
const incomingFile = join(incomingDir, 'incoming-outline.md')
mkdirSync(incomingDir)
writeFileSync(incomingFile, source.replace('Editor follow fixture', 'Incoming fixture').replace('First slide body.', 'Incoming slide body.'))
writeFileSync(join(userData,'config.json'),JSON.stringify({vaultRoot:vault,openInView:mode === 'plain' ? 'outline' : mode,slidesPanelView:'outline'}))
process.on('exit',()=>rmSync(scratch,{recursive:true,force:true}))
// A run stopped by its time limit or by hand removes its scratch folder too.
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{rmSync(scratch,{recursive:true,force:true});process.exit(130)})
let app
const taskEnv={...process.env,TW_E2E:'1',TW_REC_TEST:'1'}
delete taskEnv.ELECTRON_RUN_AS_NODE
try{
 await ensureFreshBuild(repo)
 app=await electron.launch({args:['.',`--user-data-dir=${userData}`],cwd:repo,env:taskEnv})
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().every(w=>!w.isVisible()&&!w.webContents.getWebPreferences().backgroundThrottling)),true,'fixture windows stay hidden and unthrottled')
 const page=await app.firstWindow();page.setDefaultTimeout(15000)
 const errors=[];page.on('pageerror',e=>errors.push(e.message))
 // The one-shot switch is armed by a Talks panel row, after that route accepts the open.
 await showTalksBeforeOpening(page)
 await openTalkByTitle(page, 'Editor follow fixture')
 await page.locator('[data-guide-close]').click()
 const slideTab = page.getByRole('tab', { name: 'Slide', exact: true })
 if (!(await slideTab.isVisible())) await page.getByTestId('sidebar-toggle').click()
 await slideTab.click()
 const talks = page.getByRole('tab', { name: 'Talks', exact: true })
 const talksTree = page.getByRole('tree', { name: 'Talks', exact: true })
 const firstBody = page.locator('.cm-line').filter({ hasText: 'First slide body.' })
 const clickBody = text => page.locator('.cm-line').filter({ hasText: text }).click({ position: { x: 30, y: 8 } })
 const dockedOutline = page.locator('[data-slides-mode="outline"]')
 await firstBody.waitFor()
 // Opening places the caret at the first compiled slide. For the current-slide assertions,
 // first wait for that open to finish. The delayed-claim case below covers pre-adoption clicks.
 await page.locator('.tw-right-who').getByText('Slide 1 of 3', { exact: false }).waitFor()
 if (mode === 'slide') {
   const notes = page.getByRole('textbox', { name: 'Speaker notes', exact: true })
   await notes.click()
   await dockedOutline.waitFor()
   await talks.click()
   await notes.click()
   assert.equal(await talks.getAttribute('aria-selected'), 'true')
   console.log('PASS Slide notes engage the sidebar once. An explicit return to Talks is respected.')
 } else {
 await clickBody('Second slide body.')
 await page.locator('[data-slides-mode="outline"]').waitFor()
 const capture=async(label)=>{
  const current=await page.locator('.so-row--current').allTextContents()
  const selected=await page.locator('.so-row--sel').allTextContents()
  const tab=await page.locator('.sidebar-modebar [aria-selected="true"]').allTextContents()
  const editorCaret = await page.evaluate(() => window.getSelection()?.focusNode?.parentElement?.closest('.cm-line')?.textContent)
  console.log(JSON.stringify({mode,label,current,selected,tab,editorCaret,errors}))
 }
 await capture('first editor click: expected second slide')
 await page.waitForFunction(()=>document.querySelector('.so-row--current')?.textContent.includes('Second slide'))
 await clickBody('Third slide body.')
 await page.waitForFunction(()=>document.querySelector('.so-row--current')?.textContent.includes('Third slide'))
 await capture('second editor click: expected third slide')
 // A manual outline selection must not leave the cursor marker stuck there.
 await page.locator('.so-slide').filter({hasText:'First slide'}).click()
 await clickBody('Second slide body.')
 await page.waitForFunction(()=>document.querySelector('.so-row--current')?.textContent.includes('Second slide'))
 await capture('outline selection then editor click: expected second slide')
 // A deliberate return to Talks is governed by the existing once-per-open rule.
 await page.getByRole('tab',{name:'Talks',exact:true}).click()
 await clickBody('Third slide body.')
 assert.equal(await page.getByRole('tab',{name:'Talks',exact:true}).getAttribute('aria-selected'),'true','a deliberate return to Talks is preserved until the talk is reopened')
 await capture('return to Talks then editor click: existing one-shot switch rule')
 // Reopening the talk from Talks re-arms the existing switch.
 await talksTree.locator('[data-talk-slug="outline-follow"]').click()
 await clickBody('Second slide body.')
 await page.waitForFunction(()=>document.querySelector('.so-row--current')?.textContent.includes('Second slide'))
 await capture('same talk reopened from Talks: expected second slide')
 await talks.click()

 // Hold the real claim response after the incoming request reaches main, while the
 // outgoing editor is still painted. A click in that editor must not consume the next arm.
 await app.evaluate(({ ipcMain }, path) => {
   const channel = 'window:claim-talk'
   const original = ipcMain._invokeHandlers.get(channel)
   let arrived
   globalThis.outlineFollowClaimArrived = new Promise(resolve => { arrived = resolve })
   ipcMain.removeHandler(channel)
   ipcMain.handle(channel, async (event, target) => {
     const result = await original(event, target)
     if (target === path) {
       await new Promise(resolve => {
         globalThis.releaseOutlineFollowClaim = resolve
         arrived()
       })
     }
     return result
   })
 }, incomingFile)
 await talksTree.locator('[data-talk-slug="incoming"]').click()
 await app.evaluate(() => Promise.race([
   globalThis.outlineFollowClaimArrived,
   new Promise((_, reject) => {
     const deadline = setTimeout(() => reject(new Error('The incoming claim did not reach main')), 10_000)
     deadline.unref()
   })
 ]))
 await clickBody('First slide body.')
 assert.equal(await talks.getAttribute('aria-selected'), 'true', 'outgoing editor click must stay on Talks')
 await app.evaluate(() => globalThis.releaseOutlineFollowClaim())
 await clickBody('Incoming slide body.')
 await dockedOutline.waitFor()
 await page.waitForFunction(() => document.querySelector('.so-row--current')?.textContent.includes('First slide'))
 console.log('PASS a click in the outgoing editor during a delayed talk open leaves the incoming editor armed.')

 }
 assert.deepEqual(errors,[])
 if(process.env.SHOTS)await page.screenshot({path:join(resolve(process.env.SHOTS),`talkweaver-editor-outline-follow-${mode}.png`)})
 console.log('PASS real App editor clicks follow the active slide; one-shot sidebar-switch distinction recorded')
}finally{try{await app?.close()}finally{rmSync(scratch,{recursive:true,force:true})}}

}
