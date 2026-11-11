// Actual preview/thumbnail capture, opaque/nested srcdoc and workers, plus proxy-only positive control.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { build } from 'esbuild'
import { createServer as httpServer } from 'node:http'
import { createServer as tcpServer } from 'node:net'
import { createSocket } from 'node:dgram'
import { mkdtempSync, rmSync, writeFileSync, statSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { captureAttack } from './lib/capture-network-attack.mjs'
const scratch=mkdtempSync(join(tmpdir(),'tw-capture-network-'))
const udp=createSocket('udp4');let udpHits=0,tcpHits=0
udp.on('message',()=>udpHits++)
const tcp=tcpServer(s=>{tcpHits++;s.destroy()})
const controlUdp=createSocket('udp4');let controlUdpHits=0,controlTcpHits=0
controlUdp.on('message',()=>controlUdpHits++)
const controlTcp=tcpServer(s=>{controlTcpHits++;s.destroy()})
let app,http
try {
 await new Promise(r=>udp.bind(0,'127.0.0.1',r));await new Promise(r=>tcp.listen(0,'127.0.0.1',r))
 await new Promise(r=>controlUdp.bind(0,'127.0.0.1',r));await new Promise(r=>controlTcp.listen(0,'127.0.0.1',r))
 const attack=captureAttack(udp.address().port,tcp.address().port)
 const positiveAttack=captureAttack(controlUdp.address().port,controlTcp.address().port,true)
 http=httpServer((q,r)=>{r.setHeader('Content-Type','text/html');r.end(q.url==='/control'?positiveAttack:attack)})
 await new Promise(r=>http.listen(0,'127.0.0.1',r))
 const port=http.address().port,url=`http://127.0.0.1:${port}/`,entry=join(scratch,'probe.cjs')
 await build({stdin:{resolveDir:process.cwd(),contents:`
 import {app,BrowserWindow,session,webContents} from 'electron';
 import {capturePreviewPage} from ${JSON.stringify(resolve('src/main/embed-preview-artwork.ts'))};
 import {renderThumbnails} from ${JSON.stringify(resolve('src/main/thumbnails.ts'))};
 import {containCaptureSession} from ${JSON.stringify(resolve('src/main/capture-network.ts'))};
 app.on('window-all-closed',()=>{});app.whenReady().then(()=>{globalThis.probe=async(kind,arg)=>{
 if(kind==='control'||kind==='proxy-only'){
  const isolated=session.fromPartition('probe:'+Math.random());let close;
  if(kind==='proxy-only')close=await containCaptureSession(isolated,{testAllowance:new Set([new URL(arg).host])});
  const w=new BrowserWindow({show:false,webPreferences:{session:isolated,sandbox:true,nodeIntegration:false,contextIsolation:true}});
  try{w.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');await w.loadURL(arg);await new Promise(r=>setTimeout(r,1500));return {peers:await w.webContents.executeJavaScript('(__peers||[]).length'),proxy:await isolated.resolveProxy(arg)}}finally{w.destroy();close?.()}
 }
 if(kind==='preview'){
  let read;const listener=(_e,wc)=>wc.on('did-finish-load',()=>{if(wc.getURL()===arg)read=wc.executeJavaScript('new Promise(r=>setTimeout(()=>r({locked:globalThis.__twCaptureNetworkLocked,peer:typeof RTCPeerConnection,reports:globalThis.__reports}),500))')});
  app.on('web-contents-created',listener);try{const image=await capturePreviewPage(arg,new AbortController().signal);return{image:!!image,read:await read}}finally{app.removeListener('web-contents-created',listener)}
 }
 const pictures=await renderThumbnails(arg);const w=webContents.getAllWebContents().find(w=>w.getURL().startsWith('file:'));
 const texts=[];if(w)for(const f of w.mainFrame.frames){try{texts.push(await f.executeJavaScript('document.querySelector("#content")?.textContent'))}catch{}}
 return {pictures,texts,policy:w?.getWebRTCIPHandlingPolicy()}
 }});
 `},outfile:entry,bundle:true,platform:'node',format:'cjs',external:['electron','sharp'],logLevel:'silent'})
 const env={...process.env,TW_E2E:'1',TW_E2E_LIVE_PAGE_ALLOW:`127.0.0.1:${port}`};delete env.ELECTRON_RUN_AS_NODE
 app=await electron.launch({args:[entry,`--user-data-dir=${join(scratch,'profile')}`],env})
 const diagnostics=[];app.process().stderr.on('data',b=>{diagnostics.push(b.toString());if(diagnostics.length>30)diagnostics.shift()})
 const run=async(kind,arg)=>{
  try{return await app.evaluate(async(_e,{kind,arg})=>{while(!globalThis.probe)await new Promise(r=>setTimeout(r,10));return globalThis.probe(kind,arg)},{kind,arg})}
  catch(error){console.log(diagnostics.join(''));throw error}
 }
 const control=await run('control',url+'control')
 assert.ok(control.peers>0);assert.ok(controlTcpHits>0,'positive control: the TURN/TURNS attack really reaches our TCP listener without the proxy')
 assert.ok(controlUdpHits>0,'positive control also exercises WebTransport UDP')
 assert.equal(udpHits,0);assert.equal(tcpHits,0,'control uses separate listeners')
 const proxy=await run('proxy-only',url)
 assert.ok(proxy.peers>0,'transport proof keeps native peer creation available')
 assert.match(proxy.proxy,/^PROXY 127\.0\.0\.1:/)
 assert.equal(udpHits,0);assert.equal(tcpHits,0,'filtering proxy alone contains TCP even when JS capabilities remain')
 const actual=await run('preview',url)
 assert.equal(actual.image,true,JSON.stringify(actual));assert.equal(actual.read.locked,true);assert.equal(actual.read.peer,'undefined')
 assert.ok(actual.read.reports.some(r=>r.depth===1),'opaque child executes')
 assert.ok(actual.read.reports.some(r=>r.depth===2),'nested opaque child executes')
 // Some srcdoc realms remain inside the parent target and retain native peer constructors.
 // They really execute the attack; the transport proxy must contain them regardless.
 assert.ok(actual.read.reports.every(r=>r.captureProbe===true))
 assert.equal(udpHits,0);assert.equal(tcpHits,0)
 const source=join(scratch,'outline.md'),widget=join(scratch,'widget.html')
 const outline='---\ntitle: Widget\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n### Widget\n{id=widget}\n\n[Embed: widget.html]\n'
 writeFileSync(source,outline)
 const capture=async(label,key)=>{
  writeFileSync(widget,attack.replace('Capture fixture',label))
  const model=await prepareSource(source,outline,null,statSync(source))
  const result=await run('thumbnail',{fullHtml:model.fullHtml,deckKey:'unchanged-conservative-key',slides:[{key:'widget',cacheKey:key}],cacheDir:join(scratch,'profile','thumb-cache-v10-test','pictures')})
  assert.ok(result.pictures.widget,JSON.stringify(result));assert.ok(result.texts.includes(label),JSON.stringify(result.texts));assert.equal(result.policy,'disable_non_proxied_udp')
  return createHash('sha256').update(readFileSync(result.pictures.widget)).digest('hex')
 }
 const first=await capture('Widget ONE','widget-v1'),second=await capture('Widget TWO','widget-v2')
 assert.notEqual(first,second,'same outline/known key, changed widget: cached renderer reloads actual document')
 assert.equal(udpHits,0);assert.equal(tcpHits,0,'local thumbnail has deny-all proxy transport containment')

 const model=await prepareSource(source,outline,null,statSync(source))
 const artworkCapture=async color=>{
  const uri='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="100%" height="100%" fill="'+color+'"/></svg>')
  const image='<img data-tw-embed-artwork src="'+uri+'" style="position:fixed;inset:0;width:100vw;height:100vh;z-index:999999">'
  return run('thumbnail',{fullHtml:model.fullHtml.replace('</body>',image+'</body>'),deckKey:'same-artwork-model',slides:[{key:'artwork',cacheKey:'0000000000000000-artwork'}],cacheDir:join(scratch,'profile','thumb-cache-v10-test','pictures')})
 }
 const red=await artworkCapture('red'),blue=await artworkCapture('blue')
 assert.ok(red.pictures.artwork&&blue.pictures.artwork)
 assert.notEqual(red.pictures.artwork,blue.pictures.artwork,'remote pixels change the persistent PNG identity without model changes')
 assert.equal(existsSync(red.pictures.artwork),false,'a verified new picture retires the stale artwork variant')
 assert.equal(udpHits,0);assert.equal(tcpHits,0)
 console.log('PASS: positive TURN/TURNS control; proxy-only native peers UDP0/TCP0; exact preview opaque+nested+worker attempts; thumbnail containment, widget freshness and persistent remote artwork invalidation UDP0/TCP0')
}finally{
 await app?.close().catch(()=>{});udp.close();if(http)await new Promise(r=>http.close(r));await new Promise(r=>tcp.close(r));controlUdp.close();await new Promise(r=>controlTcp.close(r));rmSync(scratch,{recursive:true,force:true})
}
