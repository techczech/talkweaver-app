// Isolated Electron probe: compare fake UI with the actual permission-handler path.
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
const repo = resolve(import.meta.dirname, '..'), root = mkdtempSync(join(repo, '.slice1-permission-'))
let app
try {
  writeFileSync(join(root, 'page.html'), '<!doctype html><title>Permission probe</title>')
  writeFileSync(join(root, 'main.cjs'), `const {app,BrowserWindow,session}=require('electron');app.whenReady().then(async()=>{global.questions=[];session.defaultSession.setPermissionRequestHandler((_wc,p,cb,d)=>{questions.push({kind:'request',permission:p,types:d.mediaTypes});cb(false)});session.defaultSession.setPermissionCheckHandler((_wc,p,_o,d)=>{questions.push({kind:'check',permission:p,type:d.mediaType});return false});const win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,sandbox:true}});await win.loadFile(${JSON.stringify(join(root, 'page.html'))})})`)
  for (const fakeUi of [true, false]) {
    app = await electron.launch({cwd:repo,args:[join(root,'main.cjs'),'--user-data-dir='+join(root, fakeUi?'fake-ui':'real-permission'),'--use-fake-device-for-media-stream', ...(fakeUi?['--use-fake-ui-for-media-stream']:[])]})
    const page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded')
    const result = await page.evaluate(async()=>{try{const stream=await navigator.mediaDevices.getUserMedia({video:true,audio:false});stream.getTracks().forEach(t=>t.stop());return 'granted'}catch(e){return e.name}})
    const questions=await app.evaluate(()=>global.questions)
    console.log(JSON.stringify({fakeUi,result,questions}))
    assert.equal(result,fakeUi?'granted':'NotAllowedError')
    assert.equal(questions.some(q=>q.kind==='request'),!fakeUi)
    await app.evaluate(({app})=>app.exit(0));await app.close().catch(()=>{});app=null
  }
} finally { if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{})}rmSync(root,{recursive:true,force:true}) }
