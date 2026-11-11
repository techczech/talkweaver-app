// Hidden built-app journey using the production-built presenter preload, native MediaRecorder,
// synthetic named input streams, real streaming IPC and real WebM files. No installed app touched.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { audibleSegmentPaths, readRecordingSource } from '../src/main/recording-paths.ts'
import { createRequire } from 'node:module'
const root=mkdtempSync(resolve('.test-mic-built-'))
const evidence=resolve('docs/design/microphone-choice/built/review-fixes')
mkdirSync(evidence,{recursive:true})
let app
const preload=resolve('out/preload/presentRecorder.js')
const original=readFileSync(preload)
try {
  const fakePrefix=`{
const {ipcRenderer}=require('electron')
const devices=[
 {kind:'audioinput',deviceId:'usb',groupId:'usb',label:'Room USB Microphone'},
 {kind:'audioinput',deviceId:'builtin',groupId:'builtin',label:'MacBook Pro Microphone (Built-in)'}
]
let tracks=[]
Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{
 enumerateDevices:async()=>devices.slice(),
 addEventListener(){},removeEventListener(){},
 getUserMedia:async constraints=>{
   const id=constraints.audio?.deviceId?.exact
   const dev=devices.find(d=>d.deviceId===id)
   if(!dev)throw new Error('input-gone')
   const ac=new AudioContext();const osc=ac.createOscillator();const dst=ac.createMediaStreamDestination()
   osc.connect(dst);osc.start();void ac.resume()
   const track=dst.stream.getAudioTracks()[0]
   track.getSettings=()=>({deviceId:dev.deviceId,groupId:dev.groupId})
   tracks.push(track)
   return dst.stream
 }
}})
ipcRenderer.on('test:lose',()=>{
 devices.splice(devices.findIndex(d=>d.deviceId==='usb'),1)
 const track=tracks.find(t=>t.getSettings().deviceId==='usb')
 track.stop();track.dispatchEvent(new Event('ended'))
})
}
`
  writeFileSync(preload,Buffer.concat([Buffer.from(fakePrefix),original]))
  const vault=join(root,'vault')
  const userData=join(root,'userdata')
  const folder=join(vault,'mic-fixture')
  mkdirSync(folder,{recursive:true});mkdirSync(userData,{recursive:true})
  const outline=join(folder,'mic-fixture-outline.md')
  const text='---\ntitle: Microphone recovery\n---\n\n## Talk\n\n### First slide\n{id=first}\n\nHidden built-app microphone journey.\n'
  writeFileSync(outline,text)
  writeFileSync(join(userData,'config.json'),JSON.stringify({vaultRoot:vault,recordingMicrophone:'Room USB Microphone',recordingDiscardMs:0}))
  const env={}
  for(const key of ['PATH','HOME','USER','LOGNAME','TMPDIR','LANG'])if(process.env[key])env[key]=process.env[key]
  env.TW_E2E='1'
  app=await electron.launch({args:['.', '--user-data-dir='+userData],cwd:process.cwd(),env})
  const main=await app.firstWindow()
  await main.waitForLoadState('domcontentloaded')
  await main.waitForFunction(()=>!!window.tw?.talk?.present)
  await app.evaluate(({BrowserWindow,app})=>{
    const hide=w=>{w.hide();w.setBounds({x:-20000,y:-20000,width:1280,height:800})}
    BrowserWindow.getAllWindows().forEach(hide)
    app.on('browser-window-created',(_e,w)=>{hide(w);w.once('ready-to-show',()=>hide(w))})
  })
  const opened=app.waitForEvent('window')
  const presenting=main.evaluate(({outline,text})=>window.tw.talk.present(outline,text,'presenter'),{outline,text})
  const page=await opened
  await presenting
  await page.waitForLoadState('domcontentloaded')
  page.setDefaultTimeout(15000)
  await page.locator('#twrec-primary').click()
  await page.waitForTimeout(1600)
  assert.equal(await page.locator('#twrec-mic').isVisible(),true)
  await page.mouse.move(10,600)
  await page.screenshot({path:join(evidence,'01-recording-usb.png')})
  const {readdirSync}=await import('node:fs')
  const recordings=join(userData,'recordings')
  const first=join(recordings,readdirSync(recordings).find(f=>f.endsWith('.webm')))
  const sid=first.split('/').at(-1).replace(/\.webm$/,'')
  const before=readFileSync(first)
  assert.ok(before.length>0)
  await app.evaluate(({BrowserWindow},url)=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()===url).webContents.send('test:lose'),page.url())
  await page.waitForFunction(()=>document.querySelector('#twrec-lost-switch')?.textContent==='Use MacBook Pro Microphone (Built-in)')
  assert.match(await page.locator('#twrec-lost-text').textContent(),/Nothing is being recorded/)
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.twrec-lost-note')).opacity==='1')
  await page.screenshot({path:join(evidence,'02-lost-offers-builtin.png')})
  await page.locator('#twrec-lost-switch').click()
  await page.waitForFunction(()=>document.querySelector('#twrec-module')?.dataset.tone==='recording')
  await page.waitForTimeout(1600)
  await page.screenshot({path:join(evidence,'03-recording-builtin.png')})
  await page.locator('#twrec-stop').click()
  await page.waitForFunction(()=>['saved','confirm','error'].includes(document.querySelector('#twrec-module')?.dataset.rec))
  if(await page.locator('#twrec-module').getAttribute('data-rec')==='confirm') await page.locator('#twrec-keep').click()
  await page.waitForFunction(()=>document.querySelector('#twrec-module')?.dataset.rec==='saved')
  await page.screenshot({path:join(evidence,'04-saved.png')})
  assert.ok(readFileSync(first).subarray(0,before.length).equals(before),'earlier bytes intact')
  const source=readRecordingSource(vault,userData,'mic-fixture',sid)
  const segments=await audibleSegmentPaths(userData,sid,source,createRequire(import.meta.url)('ffmpeg-static'))
  assert.equal(segments.length,2)
  assert.ok(segments.every(s=>s.endMs>s.startMs))
  console.log('ok 1. built app: lost USB notice → named built-in choice → native WebM recording → Stop; both actual audio files audible and earlier bytes intact')
  console.log('Proof scope: full built app hidden, fake named input streams injected before the unmodified production preload, native MediaRecorder and real IPC/disk files. Physical microphones not tested.')
} finally {
  try { if(app) { await app.evaluate(({app})=>app.exit(0)).catch(()=>{}); await app.close().catch(()=>{}) } } finally {
    writeFileSync(preload,original)
    assert.ok(readFileSync(preload).equals(original))
    rmSync(root,{recursive:true,force:true})
  }
}
