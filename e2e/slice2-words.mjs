import {_electron as electron} from 'playwright'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {join,resolve} from 'node:path'
import assert from 'node:assert/strict'
import {shutdownApp} from './lib/settings-window.mjs'
const scratch=mkdtempSync(join(process.cwd(),'.tw-slice2-ui-'))
const shots=resolve('docs/design/2026-11-10-record-and-edit-video/built/slice-2')
let app
try {
 const userData=join(scratch,'userData'),vault=join(scratch,'vault')
 mkdirSync(userData,{recursive:true});mkdirSync(join(vault,'probe'),{recursive:true})
 writeFileSync(join(vault,'probe','probe-outline.md'),'---\ntitle: Probe\noutline_version: 2\n---\n\n### One\n{id=one}\n')
 writeFileSync(join(userData,'config.json'),JSON.stringify({vaultRoot:vault}))
 const env={TW_E2E:'1'}
 for(const key of ['PATH','HOME','USER','LOGNAME','TMPDIR','LANG','SHELL'])if(process.env[key]!==undefined)env[key]=process.env[key]
 app=await electron.launch({args:['.','--use-mock-keychain',`--user-data-dir=${userData}`],cwd:process.cwd(),env})
 await app.evaluate(({app:ea,BrowserWindow})=>{const hide=w=>{w.setPosition(-20000,-20000);w.hide()};BrowserWindow.getAllWindows().forEach(hide);ea.on('browser-window-created',(_,w)=>hide(w))})
 const page=await app.firstWindow();await page.waitForLoadState('domcontentloaded')
 await page.waitForFunction(()=>Boolean(window.tw?.settingsWindow?.open))
 const nextSettings=app.waitForEvent('window',{timeout:30000,predicate:async candidate=>{try{await candidate.waitForURL(/settings\.html/,{timeout:30000});return true}catch{return false}}})
 await page.evaluate(()=>window.tw.settingsWindow.open('recording'))
 const settings=await nextSettings
 await settings.waitForLoadState('domcontentloaded')
 await settings.getByText('Words written out by',{exact:true}).waitFor()
 await settings.getByText('Language for words',{exact:true}).waitFor()
 await settings.locator('[data-key="recording.wordsLocale"]').getByText('Speech in another language may be missed.',{exact:true}).waitFor()
 await settings.screenshot({path:join(shots,'settings-recording.png')})
 const inventory=await settings.evaluate(()=>window.tw.settings.nativeSpeechInventory())
 assert.equal(inventory.available,true)
 await settings.locator('[data-key="recording.wordsEngine"]').click()
 await settings.getByText(/No Python; an Apple language model/).waitFor()
 await settings.screenshot({path:join(shots,'settings-engine.png')})
 const text=await settings.locator('body').innerText()
 assert.ok(text.includes('No Python')||text.includes('no Python'))
 await settings.locator('[data-key="recording.wordsLocale"]').click()
 await settings.locator('[data-key="recording.wordsLocale"]').getByText('Speech in another language may be missed.',{exact:true}).waitFor()
 await settings.screenshot({path:join(shots,'settings-language-warning.png')})
 writeFileSync(join(shots,'ui-results.json'),JSON.stringify({settingsRows:true,languageWarningInline:true,engineExplanation:true,nativeInventory:inventory.available,savedOffer:'NOT MET: slice 1 save-offer UI is on a parallel branch; hook wired to current durable save callback'},null,2))
 console.log('4 hidden Settings checks passed; save-offer walkthrough not met pending slice 1 integration')
}finally{if(app)await shutdownApp(app);rmSync(scratch,{recursive:true,force:true})}
