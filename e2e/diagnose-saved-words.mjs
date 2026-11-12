import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync, existsSync } from 'node:fs'
import {join,resolve} from 'node:path'
const repo=resolve(import.meta.dirname,'..'),shots=join(repo,'docs/design/2026-11-10-record-and-edit-video/built/slice-1')
let count=0
async function snapshot(page, name) {
 await page.mouse.move(24,740)
 await page.waitForFunction(()=>Number(getComputedStyle(document.querySelector('.twrec-saved-note')).opacity)>=0.99)
 await page.screenshot({path:join(shots,name)})
}
for (const scenario of ['ready','video-failed','dismiss','unavailable','retry'].filter(s=>!process.env.TW_SAVED_WORDS_SCENARIO||s===process.env.TW_SAVED_WORDS_SCENARIO)) {
 const root=mkdtempSync(join(repo,'saved-words-')),vault=join(root,'vault'),data=join(root,'data'),talk=join(vault,'fixture'),helper=join(root,'speech'),fail=join(root,'fail')
 mkdirSync(talk,{recursive:true});mkdirSync(data,{recursive:true})
 const outline=join(talk,'fixture-outline.md'),content='---\ntitle: Saved words\n---\n\n## Talk\n\n### Opening {id=opening}\n\nVoice and slides.\n'
 writeFileSync(outline,content);writeFileSync(join(data,'config.json'),JSON.stringify({vaultRoot:vault,recordingDiscardMs:500}))
 if(scenario==='retry')writeFileSync(fail,'fail')
 writeFileSync(helper,`#!${process.execPath}\nif(process.argv.includes('--route'))console.log(JSON.stringify({engine:'apple-speech-transcriber',locale:'en-US'}));else{console.error('Preparing this Mac speech model');setTimeout(()=>{if(require('fs').existsSync(${JSON.stringify(fail)}))process.exit(1);console.log(JSON.stringify({engine:'apple-speech-transcriber',locale:'en-US',words:[{text:'Hello.',startMs:0,endMs:700}],segments:[{text:'Hello.',startMs:0,endMs:700}],sentenceEnds:[0],silence:[]}))},2500)}`);chmodSync(helper,0o755)
 let app
 try {
  app=await electron.launch({cwd:repo,args:['.','--user-data-dir='+data,'--use-fake-device-for-media-stream'],env:{...process.env,TW_E2E:'1',TW_REC_TEST:'1',TW_E2E_SPEECH_HELPER:scenario==='unavailable'?'unavailable':helper}})
  app.process().stderr.on('data',bytes=>{const note=String(bytes);if(/transcription|speech/i.test(note))console.error(note)})
  const main=await app.firstWindow();await main.waitForLoadState('domcontentloaded');const opened=app.waitForEvent('window');await main.evaluate(({outline,content})=>window.tw.talk.present(outline,content,'presenter'),{outline,content});const page=await opened;page.on('pageerror',error=>console.error('presenter error',error.message))
  await page.waitForSelector('#twrec-primary');await page.evaluate(()=>{window.fixtureWords=[];new MutationObserver(()=>{const text=document.querySelector('#twrec-words')?.textContent;if(text&&window.fixtureWords.at(-1)?.text!==text)window.fixtureWords.push({at:Date.now(),text})}).observe(document.querySelector('#twrec-words'),{childList:true,subtree:true})});await page.locator('#twrec-primary').click();await page.waitForSelector('.twrec-device-check');await page.waitForFunction(()=>!document.querySelector('[data-continue]').disabled);await page.locator('[data-continue]').click();await page.waitForFunction(()=>document.querySelector('#twrec-module').dataset.rec==='recording');await page.waitForTimeout(1800)
  if(scenario==='video-failed') {
   await app.evaluate(({ipcMain})=>{ipcMain.removeHandler('recording:layers-append');ipcMain.handle('recording:layers-append',()=>{throw Error('Injected video append failure')})})
   await page.waitForFunction(()=>document.querySelector('#twrec-label').textContent.includes('Video interrupted'))
  }
  await page.locator('#twrec-stop').click();await page.waitForFunction(()=>document.querySelector('#twrec-module').dataset.rec==='saved')
  assert.match(await page.locator('#twrec-saved-text').textContent(),/Voice saved.*slides/i)
  const folder=join(vault,'_PRESENTATIONS','fixture'),run=readdirSync(folder).filter(f=>f.endsWith('.json')&&!f.includes('transcript')).map(f=>JSON.parse(readFileSync(join(folder,f),'utf8'))).find(r=>r.audio)
  assert.ok(run)
  if(scenario==='video-failed')assert.notEqual(run.capture.layers.slides.outcome,'complete')
  if(scenario==='unavailable') {await page.waitForFunction(()=>document.querySelector('#twrec-words').textContent.includes('unavailable'));assert.equal(await page.locator('#twrec-words-manual').isVisible(),true);await snapshot(page,'words-unavailable.png');const settingsOpened=app.waitForEvent('window');await page.locator('#twrec-words-manual').click();const settings=await settingsOpened;await settings.waitForSelector('select[data-setting-key="recording.wordsEngine"]');assert.ok(await settings.locator('select[data-setting-key="recording.wordsLocale"] option').count()>0);await settings.close()}
  else {
   await page.waitForFunction(()=>/written|Preparing|Converting/.test(document.querySelector('#twrec-words').textContent));console.log('words trace',scenario,await page.evaluate(()=>window.fixtureWords));assert.equal(await page.locator('#twrec-words-progress').isVisible(),true);await snapshot(page,'words-'+scenario+'-progress.png')
   if(scenario==='dismiss')await page.locator('#twrec-saved-dismiss').click()
   if(scenario==='retry'){await page.waitForFunction(()=>!document.querySelector('#twrec-words-retry').hidden);await snapshot(page,'words-retry-failed.png');rmSync(fail);await page.locator('#twrec-words-retry').click();assert.equal(await page.locator('#twrec-words-progress').isVisible(),true)}
   if(scenario==='dismiss') {const target=join(folder,run.id+'.transcript.json');const deadline=Date.now()+20000;while(!existsSync(target)&&Date.now()<deadline)await page.waitForTimeout(50);assert.ok(existsSync(target),'dismissal does not cancel durable transcript publication');assert.equal(JSON.parse(readFileSync(target)).words[0].text,'Hello.')}
   else {await page.waitForFunction(()=>document.querySelector('#twrec-words').textContent==='Words are ready.',null,{timeout:20000});await snapshot(page,'words-'+scenario+'-ready.png')}
  }
  if(scenario!=='unavailable'){const words=JSON.parse(readFileSync(join(folder,run.id+'.transcript.json')));assert.equal(words.engine,'apple-speech-transcriber');assert.equal(words.words[0].text,'Hello.')}
  if(scenario!=='dismiss')assert.ok(await page.locator('.twrec-saved-note').evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight}),'saved offer fits the presenter viewport')
  assert.ok(JSON.parse(readFileSync(join(folder,run.id+'.json'))).audio)
  console.log(`PASS ${++count} saved words ${scenario}`)
 }catch(error){if(app){for(const page of app.windows()){console.error('fixture status',scenario,await page.locator('#twrec-words').textContent({timeout:1000}).catch(()=>''),await page.evaluate(()=>window.fixtureWords).catch(()=>[]));await page.screenshot({path:join(shots,'words-failure-'+scenario+'-'+app.windows().indexOf(page)+'.png')}).catch(()=>{})}const folder=join(vault,'_PRESENTATIONS','fixture');console.error('fixture saved files',readdirSync(folder))}throw error}finally{if(app)await app.close();rmSync(root,{recursive:true,force:true})}
}
console.log(`${count} saved words journeys passed`)
