import { build } from 'esbuild'
import fs from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { sessionIdTaken } from '../src/main/recording-paths.ts'
import { createLayerStore, hasCapturedVideo } from '../src/main/recording-layers.ts'
import { needsDeviceCheck, mayCheckDevices } from '../src/shared/recording-devices.ts'
import { decidePermission } from '../src/main/recording-permissions.ts'
import { buildSlideTimeIndex } from '../compiler/scripts/lib/16-presentation-ledger.mjs'
const root = mkdtempSync(fileURLToPath(new URL('../.slice1-test-', import.meta.url)))
let tests = 0
const pass = name => console.log(`PASS ${++tests} ${name}`)
try {
  const store = createLayerStore(join(root, 'recordings')), id = 'sess-layer-test'
  store.open(1, id, true)
  assert.equal(hasCapturedVideo(store.read(id)),false)
  store.append(1, id, 'slides', 0, new Uint8Array([1,2,3]))
  store.append(1, id, 'camera', 0, new Uint8Array([4,5]))
  assert.throws(() => store.append(2, id, 'slides', 1, new Uint8Array([9])))
  assert.throws(() => store.open(2, id, false))
  assert.throws(() => store.append(1, id, 'slides', 0, new Uint8Array([9])))
  store.append(1,id,'slides',0,new Uint8Array([1,2,3]))
  assert.equal(store.read(id).layers.slides.bytes,3)
  pass('one writer per Run; a second window, duplicate chunk and duplicate open are refused')
  store.checkpoint(1, id, 1200, 'camera')
  store.append(1, id, 'slides', 1, new Uint8Array([6]))
  assert.equal(store.read(id).layers.camera.lostAtMs,1200)
  assert.equal(store.read(id).layers.slides.bytes,4)
  pass('camera loss records a gap while slides continue incrementally')
  store.closeOwner(1)
  const recovered = createLayerStore(join(root,'recordings')).read(id)
  assert.equal(hasCapturedVideo(recovered),true,'a video-bearing Run remains recoverable with no microphone file')
  assert.equal(recovered.state,'interrupted'); assert.equal(recovered.layers.slides.bytes,4)
  assert.deepEqual([...readFileSync(join(root,'recordings',id,'slides.webm'))],[1,2,3,6])
  pass('window loss preserves all acknowledged chunks and an interrupted manifest')
  const crashId='sess-crash-test';store.open(1,crashId,false);store.append(1,crashId,'slides',0,new Uint8Array([7]))
  const crash = createLayerStore(join(root,'recordings')).read(crashId)
  assert.equal(crash.state,'recording');assert.equal(crash.layers.slides.bytes,1)
  store.checkpoint(1,crashId,800);assert.equal(store.finish(1,crashId).state,'saved')
  assert.throws(()=>store.append(1,crashId,'slides',1,new Uint8Array([8])))
  pass('a new process can read a live manifest; atomic finalisation closes further writes')
  assert.throws(()=>store.open(1,'../escape',false))
  const outside=join(root,'outside');mkdirSync(outside);symlinkSync(outside,join(root,'linked'))
  assert.throws(()=>createLayerStore(join(root,'linked')).open(1,'sess-link',false))
  assert.equal(store.read('../escape'),null)
  pass('unsafe Run names and a linked recordings root are refused')
  const discardId = 'sess-discard-live'
  store.open(7, discardId, true)
  store.append(7, discardId, 'slides', 0, new Uint8Array([8]))
  assert.throws(() => store.discard(8, discardId))
  const discardedFolder = store.discard(7, discardId)
  assert.equal(discardedFolder, join(root, 'recordings', discardId))
  assert.equal(store.read(crashId).state, 'saved')
  assert.throws(() => store.discard(7, crashId)) // belongs to owner 1
  assert.equal(store.discard(7, 'sess-never-opened'), null)
  assert.equal(store.discard(1, crashId), join(root, 'recordings', crashId))
  store.complete(crashId); assert.equal(store.discard(1, crashId), null)
  pass('discard returns only the active owned folder; saved Runs cannot be discarded')
  const refreshId = 'sess-refresh'
  store.open(4, refreshId, true)
  store.append(4, refreshId, 'slides', 0, new Uint8Array([1,2]))
  store.handover(4, refreshId, 1000)
  assert.equal(createLayerStore(join(root,'recordings')).read(refreshId).refreshes[0].startMs, 1000)
  assert.throws(() => store.resume(5, refreshId, 1200))
  store.resume(4, refreshId, 1200)
  store.started(4, refreshId, 'slides', 1210)
  store.append(4, refreshId, 'slides', 0, new Uint8Array([3,4]))
  const refreshed = store.finish(4, refreshId)
  assert.equal(refreshed.layers.slides.segments.length, 2)
  assert.deepEqual([...readFileSync(join(root,'recordings',refreshId,'slides.webm'))], [1,2])
  assert.deepEqual([...readFileSync(join(root,'recordings',refreshId,'slides.seg-1.webm'))], [3,4])
  assert.deepEqual(refreshed.refreshes, [{startMs:1000,endMs:1210}])
  pass('refresh segments retain separate originals and clock gap, including crash before resume; owner checked')
  const lossId='sess-loss-return'
  store.open(1,lossId,true);store.started(1,lossId,'camera',0)
  store.checkpoint(1,lossId,500,'camera');store.handover(1,lossId,700)
  store.resume(1,lossId,800,false);store.started(1,lossId,'slides',830)
  assert.equal(existsSync(join(root,'recordings',lossId,'camera.seg-1.webm')),false)
  store.handover(1,lossId,1000);store.resume(1,lossId,1200,true)
  store.started(1,lossId,'slides',1230);store.started(1,lossId,'camera',1240)
  store.append(1,lossId,'camera',0,new Uint8Array([1]))
  const returned=store.read(lossId)
  assert.equal(returned.layers.camera.lostAtMs,undefined)
  assert.equal(returned.layers.camera.segments[0].lostAtMs,500)
  assert.equal(returned.layers.camera.segments[1].lostAtMs,undefined)
  assert.equal(returned.refreshes.at(-1).endMs,returned.layers.slides.segments.at(-1).startMs)
  store.closeOwner(1)
  const stale=join(root,'recordings',lossId,'.capture-abcd.json');writeFileSync(stale,'unfinished')
  assert.ok(createLayerStore(join(root,'recordings')).read(lossId));assert.equal(existsSync(stale),false)
  pass('loss belongs to its segment; failed camera restore creates no empty file; camera can return; read sweeps staging')
  const failedEncoder='sess-camera-encoder-failure'
  store.open(9,failedEncoder,true);store.handover(9,failedEncoder,100)
  store.resume(9,failedEncoder,200,true);store.started(9,failedEncoder,'slides',210)
  // Camera acquisition succeeded, but its MediaRecorder produced no chunk.
  assert.equal(existsSync(join(root,'recordings',failedEncoder,'camera.seg-1.webm')),false)
  store.checkpoint(9,failedEncoder,300,'camera');store.finish(9,failedEncoder)
  assert.equal(store.read(failedEncoder).layers.camera.segments.length,1)
  assert.equal(existsSync(join(root,'recordings',failedEncoder,'camera.seg-1.webm')),false)
  pass('a restored camera encoder that never yields a chunk reserves no empty media file')
  const cancelledId='sess-stop-during-refresh';store.open(5,cancelledId,false)
  store.append(5,cancelledId,'slides',0,new Uint8Array([1]));store.handover(5,cancelledId,100)
  store.checkpoint(5,cancelledId,300);store.finish(5,cancelledId)
  const cancelled=store.read(cancelledId)
  assert.equal(cancelled.refreshes[0].endMs,300);assert.equal(cancelled.layers.slides.outcome,'interrupted')
  assert.equal(cancelled.layers.slides.segments[0].lostAtMs,100)
  store.open(5,'sess-owner-close-pending',false);store.handover(5,'sess-owner-close-pending',100);store.closeOwner(5)
  assert.equal(store.read('sess-owner-close-pending').refreshes[0].endMs,undefined,'recovery must close the gap using the voice clock, not an older video-only checkpoint')
  pass('Stop closes pending Refresh; owner loss leaves its end for recovery on the voice clock')
  const fractional='sess-paused-fractional';store.open(6,fractional,false)
  store.handover(6,fractional,1000.7);store.resume(6,fractional,1000.7);store.started(6,fractional,'slides',1000.7)
  const fractionalCapture=store.finish(6,fractional)
  assert.deepEqual(fractionalCapture.refreshes,[{startMs:1001,endMs:1001}])
  assert.equal(fractionalCapture.layers.slides.segments[1].startMs,1001)
  pass('fractional paused clocks round consistently so a Refresh cannot create a negative gap')
  const delayedLoss='sess-delayed-loss';store.open(6,delayedLoss,false);store.started(6,delayedLoss,'slides',200)
  store.checkpoint(6,delayedLoss,2000);store.checkpoint(6,delayedLoss,700,'slides')
  assert.equal(store.read(delayedLoss).layers.slides.lostAtMs,700)
  assert.equal(store.read(delayedLoss).durationMs,2000)
  store.closeOwner(6)
  pass('a delayed failure checkpoint keeps its actual loss time without reducing the known recording duration')
  const permission={microphone:'granted',camera:'granted'}, devices=[{kind:'audioinput',label:'Built-in'},{kind:'videoinput',label:'FaceTime'}]
  const saved={version:1,microphone:'Built-in',camera:'FaceTime',checkedAt:'today',micPermission:'granted',cameraPermission:'granted'}
  assert.equal(needsDeviceCheck(null,'voice',devices,permission,'Built-in'),true)
  for(let i=0;i<10;i++)assert.equal(needsDeviceCheck(saved,'camera',devices,permission,'Built-in'),false)
  assert.equal(needsDeviceCheck(saved,'camera',devices.slice(0,1),permission,'Built-in'),true)
  assert.equal(needsDeviceCheck(saved,'voice',devices,{...permission,microphone:'denied'},'Built-in'),true)
  assert.equal(needsDeviceCheck(saved,'voice',devices,permission,'USB'),true)
  assert.equal(needsDeviceCheck(saved,'voice',[{kind:'audioinput',label:'Built-in',deviceId:'default'}],permission,'Built-in'),true)
  const twins=[...devices.filter(d=>d.kind!=='videoinput'),{kind:'videoinput',label:'FaceTime',deviceId:'a'},{kind:'videoinput',label:'FaceTime',deviceId:'b'}]
  assert.equal(needsDeviceCheck({...saved,cameraDeviceId:'b'},'camera',twins,permission,'Built-in'),false)
  assert.equal(needsDeviceCheck({...saved,cameraDeviceId:'gone'},'camera',twins,permission,'Built-in'),true)
  pass('first check, ten unchanged starts, removed camera, permission change and changed microphone')
  const marks=buildSlideTimeIndex([{event:'enter',slideId:'a',tMs:0},{event:'pause',tMs:100},{event:'flag',slideId:'a',tMs:150},{event:'resume',tMs:200},{event:'flag',slideId:'a',tMs:300}])
  assert.deepEqual(marks.filter(m=>m.event==='flag').map(m=>m.tMs),[100,200])
  pass('flag events survive ledger conversion on the pause-aware clock')
  const question = { permission:'media', contentsId:1, isMainFrame:true, mediaTypes:['video'], presenterIds:new Set([1]), appWindowIds:new Set() }
  assert.equal(decidePermission(question),false)
  assert.equal(decidePermission({...question,cameraIds:new Set([1])}),true)
  assert.equal(decidePermission({...question,cameraIds:new Set([1]),isMainFrame:false}),false)
  assert.equal(decidePermission({...question,contentsId:2,cameraIds:new Set([1])}),false)
  assert.equal(mayCheckDevices(true,true,false),true)
  assert.equal(mayCheckDevices(true,false,true),true)
  assert.equal(mayCheckDevices(true,false,false),false)
  assert.equal(mayCheckDevices(false,true,true),false)
  pass('camera grant is explicit, window-scoped and unavailable to embedded frames')
  let calls = 0, full = true
  const disk = createLayerStore(join(root,'disk'), { write: (fd, bytes, offset, length) => {
    calls++
    if (full && calls === 1) return writeSync(fd,bytes,offset,2)
    if (full) throw Error('ENOSPC')
    return writeSync(fd,bytes,offset,length)
  } })
  disk.open(1,'sess-full',false)
  assert.throws(()=>disk.append(1,'sess-full','slides',0,new Uint8Array([1,2,3,4])),/ENOSPC/)
  assert.equal(disk.read('sess-full').layers.slides.bytes,2)
  full=false
  assert.throws(()=>disk.append(1,'sess-full','slides',0,new Uint8Array([9,9,9,9])),/changed/)
  disk.append(1,'sess-full','slides',0,new Uint8Array([1,2,3,4]));disk.finish(1,'sess-full')
  assert.deepEqual([...readFileSync(join(root,'disk','sess-full','slides.webm'))],[1,2,3,4])
  pass('disk full after a short write keeps progress; retry appends each byte once and refuses changed bytes')
  store.open(1,'sess-retired',false);store.open(1,'sess-current',false)
  assert.throws(()=>store.interrupt(2,'sess-current'))
  store.interrupt(1,'sess-retired');store.interrupt(1,'sess-retired')
  store.append(1,'sess-current','slides',0,new Uint8Array([8]));store.finish(1,'sess-current')
  assert.equal(store.read('sess-current').layers.slides.bytes,1)
  pass('retiring a failed older capture cannot close a newer capture owned by the same presenter')
  const persistId='sess-persist-failure';store.open(1,persistId,false)
  const originalRename=fs.renameSync
  try {
    fs.renameSync=()=>{throw Error('ENOSPC manifest rename')};syncBuiltinESMExports()
    assert.throws(()=>store.checkpoint(1,persistId,500),/ENOSPC/)
  } finally {fs.renameSync=originalRename;syncBuiltinESMExports()}
  assert.equal(fs.readdirSync(join(root,'recordings',persistId)).filter(name=>name.startsWith('.capture-')).length,0)
  store.closeOwner(1)
  pass('failed manifest rename removes staging and preserves the last atomic manifest')
  const movedId='sess-temporarily-unavailable';store.open(2,movedId,false)
  store.append(2,movedId,'slides',0,new Uint8Array([1,2]));store.checkpoint(2,movedId,900)
  const moved=join(root,'recordings',movedId+'.held');fs.renameSync(join(root,'recordings',movedId),moved)
  store.interrupt(2,movedId)
  assert.equal(store.read(movedId),null)
  const known=store.snapshot(2,movedId)
  assert.equal(known.layers.slides.bytes,2);assert.equal(known.layers.slides.outcome,'interrupted');assert.equal(known.layers.slides.lostAtMs,900)
  assert.throws(()=>store.snapshot(3,movedId),/another window/)
  assert.deepEqual([...readFileSync(join(moved,'slides.webm'))],[1,2])
  pass('an unavailable video folder preserves the owned acknowledged capture outcome without blocking voice save')
  const videoOnlyHome=join(root,'video-only-home'), videoOnlyId='sess-video-only-reserved'
  const videoOnly=createLayerStore(join(videoOnlyHome,'recordings'));videoOnly.open(1,videoOnlyId,false);videoOnly.finish(1,videoOnlyId)
  assert.equal(sessionIdTaken(null,videoOnlyHome,'fixture',videoOnlyId),true)
  assert.equal(sessionIdTaken(null,videoOnlyHome,'fixture',videoOnlyId+'-new'),false)
  pass('an existing capture folder reserves its global Run id even when it has no audio file')
  const handlers=new Map()
  globalThis.__refreshHandlers=handlers
  const bundled=await build({entryPoints:['src/main/presenter-refresh.ts'],bundle:true,write:false,platform:'node',format:'cjs',plugins:[{name:'electron',setup(b){b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export const ipcMain={handle:(name,fn)=>globalThis.__refreshHandlers.set(name,fn)}'}))}}]})
  const module={exports:{}};new Function('module','exports',bundled.outputFiles[0].text)(module,module.exports)
  const refresh=module.exports;refresh.registerPresenterRefresh()
  const contents=Object.assign(new EventEmitter(),{id:71,send:()=>{}})
  const event={sender:contents}
  for(let i=0;i<2;i++){const ready=refresh.prepareRecordingRefresh(contents);handlers.get('recording:refresh-ready')(event,null);await ready}
  pass('idle null Refresh handovers do not reserve a restore or block the next Refresh')
  const ready=refresh.prepareRecordingRefresh(contents)
  handlers.get('recording:refresh-ready')(event,{voice:'owned'});await ready
  await assert.rejects(refresh.prepareRecordingRefresh(contents),/progress/)
  refresh.cancelRecordingRefresh(contents)
  const again=refresh.prepareRecordingRefresh(contents);handlers.get('recording:refresh-ready')(event,null);await again
  delete globalThis.__refreshHandlers
  pass('failed navigation clears only its window snapshot and allows another Refresh')
  const {JSDOM}=await import('jsdom')
  const dom=new JSDOM('<html><head></head><body></body></html>')
  const oldDocument=globalThis.document;globalThis.document=dom.window.document;globalThis.__previewCalls=[]
  try {
    const selfView=await build({entryPoints:['src/preload/presenter-self-view.ts'],bundle:true,write:false,platform:'node',format:'cjs',plugins:[{name:'electron',setup(b){b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export const ipcRenderer={invoke:async(...args)=>{globalThis.__previewCalls.push(args)}}'}))}}]})
    const module={exports:{}};new Function('module','exports',selfView.outputFiles[0].text)(module,module.exports)
    const update=module.exports.mountSelfView({captureChoice:()=> 'camera',getState:()=> 'recording',cameraStream:()=>null},true,()=>false)
    update();await Promise.resolve()
    assert.equal(globalThis.__previewCalls.length,0,'an idle self-view must not revoke the recording controller camera grant during acquisition')
    pass('a hidden self-view cannot revoke the camera grant of a recording being restored')
  } finally {if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;delete globalThis.__previewCalls;dom.window.close()}
  class CaptureWindow extends EventEmitter {
    static deferNext=false
    static nextId=100
    dead=false
    constructor(){super();CaptureWindow.last=this;this.invalidations=0;this.webContents=Object.assign(new EventEmitter(),{id:CaptureWindow.nextId++,setWindowOpenHandler(){},setFrameRate(){},startPainting(){},invalidate:()=>{this.invalidations++}})}
    isDestroyed(){return this.dead}
    loadURL(){if(!CaptureWindow.deferNext)return Promise.resolve();CaptureWindow.deferNext=false;return new Promise((resolve,reject)=>{this.rejectLoad=reject})}
    destroy(){this.dead=true;this.emit('closed');this.rejectLoad?.(Error('Capture intentionally stopped'))}
  }
  const ipc=Object.assign(new EventEmitter(),{handle:(name,fn)=>handlers.set(name,fn)})
  globalThis.__layerIpcElectron={BrowserWindow:CaptureWindow,ipcMain:ipc,systemPreferences:{},shell:{}}
  const layerIpc=await build({entryPoints:['src/main/presenter-layers-ipc.ts'],bundle:true,write:false,platform:'node',format:'cjs',plugins:[{name:'electron',setup(b){b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'module.exports=globalThis.__layerIpcElectron'}))}}]})
  const ipcModule={exports:{}};new Function('require','module','exports',layerIpc.outputFiles[0].text)(createRequire(import.meta.url),ipcModule,ipcModule.exports)
  const ipcStore=ipcModule.exports.registerPresenterLayers({userData:()=>join(root,'ipc-userData'),streams:{tailProgress:()=>({done:0,offset:0})},allowed:()=>true,settingsAllowed:()=>false,grantDevices(){},getSettings(){},setSettings(){}})
  const sender=Object.assign(new EventEmitter(),{id:8,mainFrame:{},getURL:()=> 'file:///fixture.html',isDestroyed:()=>false,send(){}})
  const captureEvent={sender,senderFrame:sender.mainFrame}
  try {
    await handlers.get('recording:layers-open')(captureEvent,'sess-last-paint',false)
    const source=CaptureWindow.last, wc=source.webContents, frame={toBitmap:()=>new Uint8Array([0]),getSize:()=>({width:1,height:1})}
    wc.emit('paint',{}, {},frame)
    wc.emit('paint',{}, {},frame)
    ipc.emit(`recording:frame-ready-${wc.id}-sess-last-paint`,captureEvent)
    await new Promise(r=>setTimeout(r,130))
    assert.equal(source.invalidations,2,'dropped outstanding paint is invalidated after acknowledgement and throttle')
    wc.emit('paint',{}, {},frame)
    ipc.emit(`recording:frame-ready-${wc.id}-sess-last-paint`,captureEvent)
    wc.emit('paint',{}, {},frame)
    await new Promise(r=>setTimeout(r,130))
    assert.equal(source.invalidations,3,'a dropped last paint with no outstanding frame is invalidated after throttle')
    ipcStore.interrupt(8,'sess-last-paint')
    assert.equal(source.isDestroyed(),true,'voice-save interruption independently closes its source even when renderer cleanup failed')
    pass('last dropped paints redraw after both backpressure and throttle')
    for(const overlap of [false,true]){
      const id='sess-cancelled-load-'+overlap
      await handlers.get('recording:layers-open')(captureEvent,id,false)
      handlers.get('recording:layers-started')(captureEvent,id,'slides',0)
      handlers.get('recording:layers-stop-source')(captureEvent,id)
      handlers.get('recording:layers-handover')(captureEvent,id,100)
      CaptureWindow.deferNext=true
      const loading=handlers.get('recording:layers-open')(captureEvent,id,false,true,120)
      const rejected=assert.rejects(loading,/intentionally stopped|replaced/)
      handlers.get('recording:layers-stop-source')(captureEvent,id)
      if(!overlap)await rejected
      assert.doesNotThrow(()=>handlers.get('recording:layers-handover')(captureEvent,id,200))
      await handlers.get('recording:layers-open')(captureEvent,id,false,true,300)
      await rejected
      handlers.get('recording:layers-started')(captureEvent,id,'slides',310)
      handlers.get('recording:layers-append')(captureEvent,id,'slides',0,new Uint8Array([1,2]))
      handlers.get('recording:layers-checkpoint')(captureEvent,id,400)
      const capture=handlers.get('recording:layers-finish')(captureEvent,id)
      assert.equal(capture.layers.slides.segments.length,2,'a cancelled load must not commit an empty segment')
      assert.deepEqual(capture.refreshes,[{startMs:100,endMs:310}])
      pass(`cancelled audience load retains the owned handover and never interrupts its successor (overlap=${overlap})`)
    }
  } finally {ipcStore.closeOwner(8);delete globalThis.__layerIpcElectron}
  console.log(`${tests} tests passed`)
} finally { rmSync(root,{recursive:true,force:true}) }
