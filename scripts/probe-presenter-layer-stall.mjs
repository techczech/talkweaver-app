// Isolated hidden Electron, synthetic devices, real audio encoder and synchronous chunk writes.
import { _electron as electron } from 'playwright'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
const repo=resolve(import.meta.dirname,'..'), root=mkdtempSync(join(repo,'.layer-stall-'))
const seconds=Number(process.env.PROBE_SECONDS || 120)
console.log(`Capture stall comparison: ${seconds}s per transport; real voice and slides encoders`)
try {
  writeFileSync(join(root,'page.html'),`<canvas width="1920" height="1080"></canvas><script>
  const c=document.querySelector('canvas'),x=c.getContext('2d');let n=0;function paint(){n++;for(let i=0;i<60;i++){x.fillStyle='hsl('+((n+i)*11%360)+' 80% 50%)';x.fillRect((n*9+i*31)%1920,i*18,200,18)}requestAnimationFrame(paint)}paint();
  </script>`)
  writeFileSync(join(root,'preload.cjs'),`
    const {ipcRenderer}=require('electron'); let canvasTrack;
    ipcRenderer.on('frame',async(e,mode,bytes)=>{
      try {
        const c=document.querySelector('canvas'),x=c.getContext('2d');
        if(mode==='png') { const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));x.drawImage(bitmap,0,0);bitmap.close() }
        else { const rgba=new Uint8ClampedArray(bytes);for(let i=0;i<rgba.length;i+=4){const b=rgba[i];rgba[i]=rgba[i+2];rgba[i+2]=b}const bitmap=await createImageBitmap(new ImageData(rgba,1920,1080));x.drawImage(bitmap,0,0);bitmap.close() }
        canvasTrack?.requestFrame();
      } finally {ipcRenderer.send('frame-ready')}
    });
    window.addEventListener('DOMContentLoaded',async()=>{
      const audio=await navigator.mediaDevices.getUserMedia({audio:true});
      const video=document.querySelector('canvas').captureStream(0);canvasTrack=video.getVideoTracks()[0];
      const frameTimer=setInterval(()=>{const c=document.querySelector('canvas');c.getContext('2d').drawImage(c,0,0);canvasTrack.requestFrame()},1000/30);
      const captures=[[audio,'voice'],[video,'video']].map(([stream,channel])=>{
        let chain=Promise.resolve();const rec=new MediaRecorder(stream);
        rec.ondataavailable=e=>{chain=chain.then(async()=>{const bytes=new Uint8Array(await e.data.arrayBuffer());await ipcRenderer.invoke(channel,Date.now(),bytes)})};
        rec.start(250);
        return ()=>new Promise(resolve=>{rec.onstop=()=>{stream.getTracks().forEach(t=>t.stop());chain.then(resolve)};rec.stop()});
      });
      ipcRenderer.on('stop',async()=>{clearInterval(frameTimer);await Promise.all(captures.map(stop=>stop()));ipcRenderer.send('ended')});
    });
  `)
  writeFileSync(join(root,'main.cjs'),`const {app,BrowserWindow,ipcMain,session}=require('electron');const fs=require('fs');app.setPath('userData',${JSON.stringify(join(root,'profile'))});app.commandLine.appendSwitch('use-fake-device-for-media-stream');app.on('window-all-closed',()=>{});app.whenReady().then(async()=>{session.defaultSession.setPermissionRequestHandler((w,p,cb)=>cb(p==='media'));global.results=[];for(const mode of ['png','bitmap']){const stalls=[],delays=[];let last=Date.now();const timer=setInterval(()=>{const now=Date.now();stalls.push(Math.max(0,now-last-10));last=now},10);const videoFd=fs.openSync(${JSON.stringify(join(root,'video-'))}+mode+'.webm','w');ipcMain.handle('video',(e,sent,bytes)=>{fs.writeSync(videoFd,bytes);fs.fsyncSync(videoFd)});const fd=fs.openSync(${JSON.stringify(join(root,'voice-'))}+mode+'.webm','w');ipcMain.handle('voice',(e,sent,bytes)=>{delays.push(Date.now()-sent);fs.writeSync(fd,bytes);fs.fsyncSync(fd)});const voice=new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(join(root,'preload.cjs'))},backgroundThrottling:false}});await voice.loadFile(${JSON.stringify(join(root,'page.html'))});const source=new BrowserWindow({show:false,width:1920,height:1080,useContentSize:true,webPreferences:{offscreen:{useSharedTexture:false,deviceScaleFactor:1},backgroundThrottling:false}});let previous=0,pending=false;const ack=()=>{pending=false};ipcMain.on('frame-ready',ack);source.webContents.on('paint',(e,r,frame)=>{if(pending||(mode==='bitmap'&&Date.now()-previous<100))return;pending=true;previous=Date.now();const bytes=mode==='png'?frame.toPNG():frame.toBitmap();voice.webContents.send('frame',mode,bytes)});await source.loadFile(${JSON.stringify(join(root,'page.html'))});source.webContents.setFrameRate(30);await new Promise(r=>setTimeout(r,${seconds*1000}));await new Promise((r,reject)=>{const timeout=setTimeout(()=>reject(Error('Encoder did not stop')),15000);ipcMain.once('ended',()=>{clearTimeout(timeout);r()});voice.webContents.send('stop')});clearInterval(timer);ipcMain.removeHandler('voice');ipcMain.removeHandler('video');fs.closeSync(videoFd);ipcMain.removeListener('frame-ready',ack);fs.closeSync(fd);source.destroy();voice.destroy();const stats=a=>{a.sort((a,b)=>a-b);return {maxMs:a.at(-1),p95Ms:a[Math.floor(a.length*.95)],samples:a.length}};results.push({mode,seconds:${seconds},mainThreadStall:stats(stalls),voiceChunkIpcDelay:stats(delays)});console.log(JSON.stringify(results.at(-1)))}global.done=true}).catch(error=>{global.failure=String(error);global.done=true})`)
  const app=await electron.launch({cwd:repo,args:[join(root,'main.cjs')],env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}})
  try { let done=false;while(!done){ await new Promise(r=>setTimeout(r,1000));done=await app.evaluate(()=>global.done===true) } const failure=await app.evaluate(()=>global.failure);if(failure)throw Error(failure);console.log(JSON.stringify(await app.evaluate(()=>global.results),null,2));for(const mode of ['png','bitmap'])for(const layer of ['voice','video']){const decoded=spawnSync(createRequire(import.meta.url)('ffmpeg-static'),['-v','error','-i',join(root,layer+'-'+mode+'.webm'),'-f','null','-'],{timeout:15000});if(decoded.status!==0)throw Error(decoded.stderr?.toString());console.log(mode+': '+layer+' decodes')} } finally {await app.close()}
} finally {rmSync(root,{recursive:true,force:true})}
